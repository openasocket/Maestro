// VIBES File I/O — Reads and writes .ai-audit/ directory files directly from Maestro.
// This is the "fast path" for annotation writing that bypasses the vibecheck binary,
// allowing Maestro to write annotations in real-time during agent sessions.
//
// Features:
// - Async write buffer batches annotation writes (flush every 2s or 20 annotations)
// - Non-blocking appendAnnotation/appendAnnotations (add to buffer, return immediately)
// - Debounced manifest writes (read-modify-write with coalescing)
// - Per-project file locking to prevent concurrent write corruption
// - Graceful error handling (log + never crash the agent session)

import {
	mkdir,
	readFile,
	writeFile,
	appendFile,
	access,
	constants,
	open,
	rename,
	readdir,
} from 'fs/promises';
import * as path from 'path';

import { computeVibesHash } from './vibes-hash';

import type {
	VibesAssuranceLevel,
	VibesConfig,
	VibesManifest,
	VibesManifestEntry,
	VibesAnnotation,
	VibesEnvironmentEntry,
	VibesLineAnnotation,
} from '../../shared/vibes-types';

// ============================================================================
// Constants
// ============================================================================

/** Name of the audit directory at the project root. */
const AUDIT_DIR = '.ai-audit';

/** Name of the blobs subdirectory for external data. */
const BLOBS_DIR = 'blobs';

/** Config file name. */
const CONFIG_FILE = 'config.json';

/** Manifest file name. */
const MANIFEST_FILE = 'manifest.json';

/** Annotations JSONL file name. */
const ANNOTATIONS_FILE = 'annotations.jsonl';

/** Maximum annotations in the write buffer before auto-flush. */
const BUFFER_FLUSH_SIZE = 20;

/** Interval in ms between automatic buffer flushes. */
const BUFFER_FLUSH_INTERVAL_MS = 2000;

/** Debounce delay in ms for manifest writes. */
const MANIFEST_DEBOUNCE_MS = 500;

// ============================================================================
// Logging
// ============================================================================

/** Logger stub — warn level so instrumentation failures are non-critical. */
function logWarn(message: string, error?: unknown): void {
	const errMsg = error instanceof Error ? error.message : String(error ?? '');
	console.warn(`[vibes-io] ${message}${errMsg ? `: ${errMsg}` : ''}`);
}

// ============================================================================
// Atomic File Writes
// ============================================================================

/**
 * Write a file atomically: write to a temp file, fsync, then rename.
 * On POSIX systems, rename() is atomic, so readers will either see the
 * old content or the new content — never a partial write.
 */
async function atomicWriteFile(filePath: string, data: string): Promise<void> {
	const tmpPath = `${filePath}.tmp`;
	const fh = await open(tmpPath, 'w');
	try {
		await fh.writeFile(data, 'utf8');
		await fh.sync();
	} finally {
		await fh.close();
	}
	await rename(tmpPath, filePath);
}

// ============================================================================
// Per-Project Mutex (In-Process Serialization)
// ============================================================================

/** In-memory promise chain per project path for serializing writes within this process. */
const projectMutexes: Map<string, Promise<void>> = new Map();

/**
 * Serialize async operations per project path.
 * Ensures only one write operation runs at a time for each project,
 * preventing corruption from concurrent read-modify-write cycles.
 * Uses promise chaining (no setTimeout) so it works with fake timers in tests.
 */
function withProjectLock(projectPath: string, fn: () => Promise<void>): Promise<void> {
	const prev = projectMutexes.get(projectPath) ?? Promise.resolve();
	const next = prev.then(fn, fn); // Run fn regardless of prev outcome
	projectMutexes.set(projectPath, next);
	// Clean up reference when done to prevent unbounded map growth
	next.then(() => {
		if (projectMutexes.get(projectPath) === next) {
			projectMutexes.delete(projectPath);
		}
	});
	return next;
}

// ============================================================================
// Write Buffer
// ============================================================================

/** Per-project annotation write buffer. */
interface ProjectBuffer {
	annotations: VibesAnnotation[];
	timer: ReturnType<typeof setTimeout> | null;
}

/** Global map of project path → annotation write buffer. */
const annotationBuffers: Map<string, ProjectBuffer> = new Map();

/** Per-project manifest debounce state. */
interface ManifestDebounce {
	pendingEntries: Map<string, VibesManifestEntry>;
	timer: ReturnType<typeof setTimeout> | null;
	/** Hashes that should overwrite existing entries on next flush (in-place updates). */
	overwriteHashes?: Set<string>;
}

/** Global map of project path → manifest debounce state. */
const manifestDebounces: Map<string, ManifestDebounce> = new Map();

/**
 * Get or create the annotation buffer for a project.
 */
function getBuffer(projectPath: string): ProjectBuffer {
	let buf = annotationBuffers.get(projectPath);
	if (!buf) {
		buf = { annotations: [], timer: null };
		annotationBuffers.set(projectPath, buf);
	}
	return buf;
}

/**
 * Schedule an auto-flush timer for the given project buffer.
 * If a timer is already running, this is a no-op.
 */
function scheduleFlush(projectPath: string, buf: ProjectBuffer): void {
	if (buf.timer !== null) {
		return;
	}
	buf.timer = setTimeout(() => {
		buf.timer = null;
		flushAnnotationBuffer(projectPath).catch((err) => {
			logWarn('Auto-flush failed', err);
		});
	}, BUFFER_FLUSH_INTERVAL_MS);
}

/**
 * Flush the annotation write buffer for a specific project.
 * Writes all buffered annotations to disk in a single append call.
 * Serialized per project via in-memory mutex to prevent concurrent writes.
 */
async function flushAnnotationBuffer(projectPath: string): Promise<void> {
	const buf = annotationBuffers.get(projectPath);
	if (!buf || buf.annotations.length === 0) {
		return;
	}

	return withProjectLock(projectPath, async () => {
		// Re-check after acquiring lock (buffer may have been flushed by another call)
		if (buf.annotations.length === 0) {
			return;
		}

		// Drain the buffer
		const toWrite = buf.annotations.splice(0);
		if (buf.timer !== null) {
			clearTimeout(buf.timer);
			buf.timer = null;
		}

		try {
			await ensureAuditDir(projectPath);
			const annotationsPath = path.join(projectPath, AUDIT_DIR, ANNOTATIONS_FILE);
			const lines = toWrite.map((a) => JSON.stringify(a)).join('\n') + '\n';
			// appendFile is safe for concurrent appends within the same file
			await appendFile(annotationsPath, lines, 'utf8');
		} catch (err) {
			logWarn('Failed to flush annotation buffer', err);
		}
	});
}

/**
 * Flush pending manifest entries for a specific project.
 * Serialized per project via in-memory mutex to prevent concurrent writes.
 */
async function flushManifestDebounce(projectPath: string): Promise<void> {
	const state = manifestDebounces.get(projectPath);
	if (!state || state.pendingEntries.size === 0) {
		return;
	}

	return withProjectLock(projectPath, async () => {
		// Re-check after acquiring lock
		if (!state || state.pendingEntries.size === 0) {
			return;
		}

		// Drain pending entries and overwrite set
		const entries = new Map(state.pendingEntries);
		const overwriteHashes = state.overwriteHashes
			? new Set(state.overwriteHashes)
			: new Set<string>();
		state.pendingEntries.clear();
		if (state.overwriteHashes) {
			state.overwriteHashes.clear();
		}
		if (state.timer !== null) {
			clearTimeout(state.timer);
			state.timer = null;
		}

		try {
			await ensureAuditDir(projectPath);
			const manifest = await readVibesManifest(projectPath);

			// Version compatibility check — warn but still write (fail open).
			// readVibesManifest() already validates, but we log an extra note
			// when we're about to modify a manifest with an unexpected version.
			if (manifest.version !== '1.0') {
				logWarn(
					`Adding entries to manifest with version '${manifest.version}' — proceeding (forward-compat)`
				);
			}

			let changed = false;
			for (const [hash, entry] of entries) {
				if (overwriteHashes.has(hash)) {
					// In-place update: replace existing entry data (same hash key)
					manifest.entries[hash] = entry;
					changed = true;
				} else if (!(hash in manifest.entries)) {
					manifest.entries[hash] = entry;
					changed = true;
				}
			}
			if (changed) {
				await writeVibesManifest(projectPath, manifest);
			}
		} catch (err) {
			logWarn('Failed to flush manifest debounce', err);
		}
	});
}

// ============================================================================
// Directory Management
// ============================================================================

/**
 * Ensure the .ai-audit/ and .ai-audit/blobs/ directories exist.
 * Creates them recursively if they don't exist.
 */
export async function ensureAuditDir(projectPath: string): Promise<void> {
	const auditDir = path.join(projectPath, AUDIT_DIR);
	const blobsDir = path.join(auditDir, BLOBS_DIR);

	await mkdir(auditDir, { recursive: true });
	await mkdir(blobsDir, { recursive: true });
}

// ============================================================================
// External Blob Storage
// ============================================================================

/**
 * Write reasoning data to an external blob file at `.ai-audit/blobs/{hash}.blob`.
 * Used for very large reasoning traces that exceed the external blob threshold.
 * Ensures the blobs directory exists before writing.
 *
 * Returns the relative blob path (e.g. `blobs/{hash}.blob`).
 */
export async function writeReasoningBlob(
	projectPath: string,
	hash: string,
	data: Buffer | string
): Promise<string> {
	await ensureAuditDir(projectPath);
	const blobFileName = `${hash}.blob`;
	const blobPath = path.join(projectPath, AUDIT_DIR, BLOBS_DIR, blobFileName);
	if (typeof data === 'string') {
		await writeFile(blobPath, data, 'utf8');
	} else {
		await writeFile(blobPath, data);
	}
	return `${BLOBS_DIR}/${blobFileName}`;
}

// ============================================================================
// Config
// ============================================================================

/**
 * Read and parse the .ai-audit/config.json file.
 * Returns null if the file does not exist or cannot be parsed.
 * Validates that `standard === 'VIBES'` and `standard_version === '1.0'`.
 * Logs a warning if the version is unsupported but still returns the config (fail open).
 */
export async function readVibesConfig(projectPath: string): Promise<VibesConfig | null> {
	const configPath = path.join(projectPath, AUDIT_DIR, CONFIG_FILE);
	try {
		await access(configPath, constants.F_OK);
		const raw = await readFile(configPath, 'utf8');
		const config = JSON.parse(raw) as VibesConfig;

		// Validate standard and version — warn but don't block (fail open)
		if (config.standard !== 'VIBES') {
			logWarn(`Config has unexpected standard: '${config.standard}' (expected 'VIBES')`);
		}
		if (config.standard_version !== '1.0') {
			logWarn(
				`Config has unsupported standard_version: '${config.standard_version}' (expected '1.0')`
			);
		}

		return config;
	} catch {
		return null;
	}
}

/**
 * Write the config.json file with pretty formatting (2-tab indentation).
 * Creates the .ai-audit/ directory if it doesn't exist.
 */
export async function writeVibesConfig(projectPath: string, config: VibesConfig): Promise<void> {
	await ensureAuditDir(projectPath);
	const configPath = path.join(projectPath, AUDIT_DIR, CONFIG_FILE);
	await atomicWriteFile(configPath, JSON.stringify(config, null, '\t') + '\n');
}

// ============================================================================
// Manifest
// ============================================================================

/**
 * Read and parse the .ai-audit/manifest.json file.
 * Returns an empty manifest if the file does not exist.
 * Validates that `standard === 'VIBES'` and `version === '1.0'`.
 * Logs a warning if the version is unsupported but still returns the manifest (fail open).
 */
export async function readVibesManifest(projectPath: string): Promise<VibesManifest> {
	const manifestPath = path.join(projectPath, AUDIT_DIR, MANIFEST_FILE);
	try {
		await access(manifestPath, constants.F_OK);
		const raw = await readFile(manifestPath, 'utf8');
		const manifest = JSON.parse(raw) as VibesManifest;

		// Validate standard and version — warn but don't block (fail open)
		if (manifest.standard !== 'VIBES') {
			logWarn(`Manifest has unexpected standard: '${manifest.standard}' (expected 'VIBES')`);
		}
		if (manifest.version !== '1.0') {
			logWarn(`Manifest has unsupported version: '${manifest.version}' (expected '1.0')`);
		}

		return manifest;
	} catch {
		return { standard: 'VIBES', version: '1.0', entries: {} };
	}
}

/**
 * Write the manifest.json file with pretty formatting.
 * Creates the .ai-audit/ directory if it doesn't exist.
 */
export async function writeVibesManifest(
	projectPath: string,
	manifest: VibesManifest
): Promise<void> {
	await ensureAuditDir(projectPath);
	const manifestPath = path.join(projectPath, AUDIT_DIR, MANIFEST_FILE);
	await atomicWriteFile(manifestPath, JSON.stringify(manifest, null, '\t') + '\n');
}

// ============================================================================
// Annotations (Immediate — for critical records)
// ============================================================================

/**
 * Append a single annotation directly to disk, bypassing the write buffer.
 * Uses the per-project lock for serialization but does NOT buffer — the
 * annotation is guaranteed on disk when the returned promise resolves.
 *
 * Use this for critical audit records (session start/end) where data loss
 * on hard crash is unacceptable. For high-frequency annotations where
 * occasional loss is tolerable, use {@link appendAnnotation} instead.
 */
export async function appendAnnotationImmediate(
	projectPath: string,
	annotation: VibesAnnotation
): Promise<void> {
	return withProjectLock(projectPath, async () => {
		try {
			await ensureAuditDir(projectPath);
			const annotationsPath = path.join(projectPath, AUDIT_DIR, ANNOTATIONS_FILE);
			const line = JSON.stringify(annotation) + '\n';
			await appendFile(annotationsPath, line, 'utf8');
		} catch (err) {
			logWarn('Failed to write annotation immediately', err);
		}
	});
}

// ============================================================================
// Annotations (Buffered)
// ============================================================================

/**
 * Append a single annotation to the write buffer.
 * Non-blocking — adds to in-memory buffer and returns immediately.
 * The buffer auto-flushes every 2s or when 20 annotations are buffered.
 */
export async function appendAnnotation(
	projectPath: string,
	annotation: VibesAnnotation
): Promise<void> {
	try {
		const buf = getBuffer(projectPath);
		buf.annotations.push(annotation);

		if (buf.annotations.length >= BUFFER_FLUSH_SIZE) {
			// Trigger immediate flush but don't await — keep non-blocking
			flushAnnotationBuffer(projectPath).catch((err) => {
				logWarn('Flush on size threshold failed', err);
			});
		} else {
			scheduleFlush(projectPath, buf);
		}
	} catch (err) {
		logWarn('Failed to buffer annotation', err);
	}
}

/**
 * Append multiple annotations to the write buffer.
 * Non-blocking — adds to in-memory buffer and returns immediately.
 */
export async function appendAnnotations(
	projectPath: string,
	annotations: VibesAnnotation[]
): Promise<void> {
	if (annotations.length === 0) {
		return;
	}
	try {
		const buf = getBuffer(projectPath);
		buf.annotations.push(...annotations);

		if (buf.annotations.length >= BUFFER_FLUSH_SIZE) {
			flushAnnotationBuffer(projectPath).catch((err) => {
				logWarn('Flush on size threshold failed', err);
			});
		} else {
			scheduleFlush(projectPath, buf);
		}
	} catch (err) {
		logWarn('Failed to buffer annotations', err);
	}
}

/**
 * Read and parse all annotations from the .ai-audit/annotations.jsonl file.
 * Returns an empty array if the file does not exist.
 * Skips blank lines gracefully.
 */
export async function readAnnotations(projectPath: string): Promise<VibesAnnotation[]> {
	// Flush any pending annotations first so reads are consistent
	await flushAnnotationBuffer(projectPath);

	const annotationsPath = path.join(projectPath, AUDIT_DIR, ANNOTATIONS_FILE);
	try {
		await access(annotationsPath, constants.F_OK);
		const raw = await readFile(annotationsPath, 'utf8');
		return raw
			.split('\n')
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line) as VibesAnnotation);
	} catch {
		return [];
	}
}

// ============================================================================
// Manifest Entry Management (Debounced)
// ============================================================================

/**
 * Add an entry to the manifest if the hash is not already present.
 * Uses debounced writes — manifest changes are coalesced within a 500ms window,
 * then flushed as a single read-modify-write operation with file locking.
 */
export async function addManifestEntry(
	projectPath: string,
	hash: string,
	entry: VibesManifestEntry
): Promise<void> {
	try {
		let state = manifestDebounces.get(projectPath);
		if (!state) {
			state = { pendingEntries: new Map(), timer: null };
			manifestDebounces.set(projectPath, state);
		}

		state.pendingEntries.set(hash, entry);

		// Reset debounce timer
		if (state.timer !== null) {
			clearTimeout(state.timer);
		}
		state.timer = setTimeout(() => {
			state!.timer = null;
			flushManifestDebounce(projectPath).catch((err) => {
				logWarn('Manifest debounce flush failed', err);
			});
		}, MANIFEST_DEBOUNCE_MS);
	} catch (err) {
		logWarn('Failed to schedule manifest entry', err);
	}
}

// ============================================================================
// Manifest Entry Management (Immediate — for critical entries)
// ============================================================================

/**
 * Write a manifest entry immediately (bypasses debounce).
 * Use for critical entries like environment that must exist before
 * any annotations reference them.
 */
export async function addManifestEntryImmediate(
	projectPath: string,
	hash: string,
	entry: VibesManifestEntry
): Promise<void> {
	try {
		await ensureAuditDir(projectPath);
		const manifest = await readVibesManifest(projectPath);
		if (!(hash in manifest.entries)) {
			manifest.entries[hash] = entry;
			await writeVibesManifest(projectPath, manifest);
		}
	} catch (err) {
		logWarn('Failed to write immediate manifest entry', err);
	}
}

/**
 * Update an existing manifest entry in-place (same hash key, new data).
 * Used to replace placeholder data (e.g. model_name: 'unknown') with real
 * values once they become available, without changing the hash that
 * annotations already reference.
 *
 * Uses the debounced write path so updates are batched and flushed
 * together with other pending manifest entries.
 */
export async function updateManifestEntry(
	projectPath: string,
	hash: string,
	entry: VibesManifestEntry
): Promise<void> {
	try {
		let state = manifestDebounces.get(projectPath);
		if (!state) {
			state = { pendingEntries: new Map(), timer: null };
			manifestDebounces.set(projectPath, state);
		}

		// Mark this entry for update (replaces any existing pending entry)
		state.pendingEntries.set(hash, entry);
		// Also mark it for overwrite (not just insert) on next flush
		if (!state.overwriteHashes) {
			state.overwriteHashes = new Set();
		}
		state.overwriteHashes.add(hash);

		// Reset debounce timer
		if (state.timer !== null) {
			clearTimeout(state.timer);
		}
		state.timer = setTimeout(() => {
			state!.timer = null;
			flushManifestDebounce(projectPath).catch((err) => {
				logWarn('Manifest debounce flush failed (update)', err);
			});
		}, MANIFEST_DEBOUNCE_MS);
	} catch (err) {
		logWarn('Failed to schedule manifest entry update', err);
	}
}

// ============================================================================
// Flush All (Session End / Shutdown)
// ============================================================================

/**
 * Force-flush all pending writes across all projects.
 * Called on session end and app shutdown to ensure no data is lost.
 */
export async function flushAll(): Promise<void> {
	// Flush manifests FIRST — ensures all referenced hashes exist on disk
	// before the annotations that reference them are written.
	const manifestPromises: Promise<void>[] = [];
	for (const projectPath of manifestDebounces.keys()) {
		manifestPromises.push(
			flushManifestDebounce(projectPath).catch((err) => {
				logWarn(`flushAll: manifest flush failed for ${projectPath}`, err);
			})
		);
	}
	await Promise.all(manifestPromises);

	// Then flush annotation buffers
	const annotationPromises: Promise<void>[] = [];
	for (const projectPath of annotationBuffers.keys()) {
		annotationPromises.push(
			flushAnnotationBuffer(projectPath).catch((err) => {
				logWarn(`flushAll: annotation flush failed for ${projectPath}`, err);
			})
		);
	}
	await Promise.all(annotationPromises);
}

// ============================================================================
// Manifest Re-Hash Migration
// ============================================================================

/**
 * Re-hash all manifest entries and update annotation references.
 * Required after fixing computeVibesHash to strip the `type` field.
 * Idempotent — entries already matching the new hash are skipped.
 */
export async function rehashManifest(
	projectPath: string
): Promise<{ rehashedEntries: number; updatedAnnotations: number }> {
	const manifest = await readVibesManifest(projectPath);
	const hashMap = new Map<string, string>(); // oldHash → newHash
	const newEntries: Record<string, VibesManifestEntry> = {};
	let rehashedEntries = 0;

	for (const [oldHash, entry] of Object.entries(manifest.entries)) {
		const newHash = computeVibesHash(entry as unknown as Record<string, unknown>);
		if (oldHash !== newHash) {
			hashMap.set(oldHash, newHash);
			rehashedEntries++;
		}
		newEntries[newHash] = entry;
	}

	// Write updated manifest
	manifest.entries = newEntries;
	await writeVibesManifest(projectPath, manifest);

	// Update annotation hash references
	let updatedAnnotations = 0;
	if (hashMap.size > 0) {
		const annotations = await readAnnotations(projectPath);
		const updated = annotations.map((a) => {
			let changed = false;
			const record = { ...a } as Record<string, unknown>;
			for (const field of ['environment_hash', 'command_hash', 'prompt_hash', 'reasoning_hash']) {
				const oldVal = record[field] as string | undefined;
				if (oldVal && hashMap.has(oldVal)) {
					record[field] = hashMap.get(oldVal);
					changed = true;
				}
			}
			if (changed) updatedAnnotations++;
			return record;
		});

		// Rewrite annotations.jsonl
		const auditDir = path.join(projectPath, '.ai-audit');
		const annotationsPath = path.join(auditDir, 'annotations.jsonl');
		const content = updated.map((a) => JSON.stringify(a)).join('\n') + '\n';
		await writeFile(annotationsPath, content, 'utf-8');
	}

	return { rehashedEntries, updatedAnnotations };
}

// ============================================================================
// Direct Initialization (Fallback when vibecheck binary is unavailable)
// ============================================================================

/**
 * Initialize the VIBES directory structure directly without the vibecheck binary.
 * Creates `.ai-audit/`, `.ai-audit/blobs/`, `config.json`, `manifest.json`,
 * and an empty `annotations.jsonl`. Used as a fallback when the vibecheck
 * CLI is not installed.
 *
 * Returns `{ success: true }` on success, `{ success: false, error }` on failure.
 */
export async function initVibesDirectly(
	projectPath: string,
	config: {
		projectName: string;
		assuranceLevel: VibesAssuranceLevel;
		trackedExtensions?: string[];
		excludePatterns?: string[];
	}
): Promise<{ success: boolean; error?: string }> {
	try {
		await ensureAuditDir(projectPath);

		const vibesConfig: VibesConfig = {
			standard: 'VIBES',
			standard_version: '1.0',
			assurance_level: config.assuranceLevel,
			project_name: config.projectName,
			tracked_extensions: config.trackedExtensions ?? [
				'.ts',
				'.tsx',
				'.js',
				'.jsx',
				'.py',
				'.rs',
				'.go',
				'.java',
				'.c',
				'.cpp',
				'.rb',
				'.swift',
				'.kt',
			],
			exclude_patterns: config.excludePatterns ?? [
				'**/node_modules/**',
				'**/vendor/**',
				'**/.venv/**',
				'**/dist/**',
				'**/target/**',
				'**/.git/**',
				'**/build/**',
			],
			compress_reasoning_threshold_bytes: 10240,
			external_blob_threshold_bytes: 102400,
		};

		await writeVibesConfig(projectPath, vibesConfig);

		// Create empty manifest if it doesn't exist
		const manifestPath = path.join(projectPath, AUDIT_DIR, MANIFEST_FILE);
		try {
			await access(manifestPath, constants.F_OK);
		} catch {
			await writeVibesManifest(projectPath, {
				standard: 'VIBES',
				version: '1.0',
				entries: {},
			});
		}

		// Create empty annotations file if it doesn't exist
		const annotationsPath = path.join(projectPath, AUDIT_DIR, ANNOTATIONS_FILE);
		try {
			await access(annotationsPath, constants.F_OK);
		} catch {
			await writeFile(annotationsPath, '', 'utf8');
		}

		return { success: true };
	} catch (err) {
		const errMsg = err instanceof Error ? err.message : String(err);
		logWarn('Direct VIBES initialization failed', err);
		return { success: false, error: errMsg };
	}
}

// ============================================================================
// Commit Hash Backfill
// ============================================================================

/**
 * Backfill `commit_hash` on annotations that are missing it.
 * Reads all annotations, updates matching records, and rewrites the file
 * atomically. Uses the per-project lock for serialization.
 *
 * @param projectPath  Absolute path to the project root.
 * @param commitHash   The git commit hash to set on matching annotations.
 * @param sessionId    Optional session ID filter — when provided, only
 *                     annotations whose `session_id` matches are updated.
 * @returns The number of annotations that were updated.
 */
export async function backfillCommitHash(
	projectPath: string,
	commitHash: string,
	sessionId?: string
): Promise<number> {
	// Flush any pending buffered annotations first so we operate on
	// the complete set of annotations on disk.
	await flushAnnotationBuffer(projectPath);

	let updatedCount = 0;

	await withProjectLock(projectPath, async () => {
		const annotationsPath = path.join(projectPath, AUDIT_DIR, ANNOTATIONS_FILE);

		let raw: string;
		try {
			await access(annotationsPath, constants.F_OK);
			raw = await readFile(annotationsPath, 'utf8');
		} catch {
			// No annotations file — nothing to backfill
			return;
		}

		const lines = raw.split('\n');
		const updatedLines: string[] = [];
		let changed = false;

		for (const line of lines) {
			if (line.trim().length === 0) {
				updatedLines.push(line);
				continue;
			}

			try {
				const annotation = JSON.parse(line) as VibesAnnotation;

				// Only backfill line and function annotations (they have commit_hash)
				if (annotation.type === 'line' || annotation.type === 'function') {
					const hasCommitHash = 'commit_hash' in annotation && annotation.commit_hash;
					const matchesSession =
						!sessionId || ('session_id' in annotation && annotation.session_id === sessionId);

					if (!hasCommitHash && matchesSession) {
						(annotation as any).commit_hash = commitHash;
						updatedLines.push(JSON.stringify(annotation));
						updatedCount++;
						changed = true;
						continue;
					}
				}

				updatedLines.push(line);
			} catch {
				// Preserve malformed lines as-is
				updatedLines.push(line);
			}
		}

		if (changed) {
			await atomicWriteFile(annotationsPath, updatedLines.join('\n'));
		}
	});

	return updatedCount;
}

// ============================================================================
// Direct Data Reading (Fallback when vibecheck binary is unavailable)
// ============================================================================

/**
 * Compute project stats directly from annotations and manifest on disk.
 * Used as fallback when the vibecheck CLI binary is not installed.
 */
export async function computeStatsFromAnnotations(projectPath: string): Promise<{
	total_annotations: number;
	files_covered: number;
	total_tracked_files: number;
	coverage_percent: number;
	active_sessions: number;
	contributing_models: number;
	assurance_level: string;
}> {
	const annotations = await readAnnotations(projectPath);
	const config = await readVibesConfig(projectPath);
	const manifest = await readVibesManifest(projectPath);

	// Count line/function annotations
	const lineAnnotations = annotations.filter((a) => a.type === 'line' || a.type === 'function');

	// Unique file paths from line annotations
	const coveredFiles = new Set<string>();
	for (const a of lineAnnotations) {
		if ('file_path' in a) {
			coveredFiles.add(a.file_path);
		}
	}

	// Active sessions: sessions with 'start' event but no corresponding 'end'
	const sessionStarts = new Set<string>();
	const sessionEnds = new Set<string>();
	for (const a of annotations) {
		if (a.type === 'session') {
			if (a.event === 'start') sessionStarts.add(a.session_id);
			if (a.event === 'end') sessionEnds.add(a.session_id);
		}
	}
	const activeSessions = [...sessionStarts].filter((id) => !sessionEnds.has(id)).length;

	// Contributing models from manifest environment entries
	const modelNames = new Set<string>();
	for (const entry of Object.values(manifest.entries)) {
		if (entry.type === 'environment') {
			modelNames.add((entry as VibesEnvironmentEntry).model_name);
		}
	}

	const filesCovered = coveredFiles.size;

	// Scan tracked files for accurate total count when config is available
	let totalTrackedFiles = filesCovered || 1;
	if (config?.tracked_extensions && config.tracked_extensions.length > 0) {
		try {
			const trackedFiles = await scanTrackedFiles(
				projectPath,
				config.tracked_extensions,
				config.exclude_patterns ?? []
			);
			if (trackedFiles.length > 0) {
				totalTrackedFiles = trackedFiles.length;
			}
		} catch {
			// Scan failed — keep approximate count
		}
	}

	return {
		total_annotations: lineAnnotations.length,
		files_covered: filesCovered,
		total_tracked_files: totalTrackedFiles,
		coverage_percent:
			totalTrackedFiles > 0 ? Math.round((filesCovered / totalTrackedFiles) * 100) : 0,
		active_sessions: activeSessions,
		contributing_models: modelNames.size,
		assurance_level: config?.assurance_level ?? 'low',
	};
}

/**
 * Extract session records from annotations.
 * Used as fallback when the vibecheck CLI binary is not installed.
 */
export async function extractSessionsFromAnnotations(projectPath: string): Promise<
	Array<{
		session_id: string;
		event: string;
		timestamp: string;
		agent_type?: string;
		annotation_count: number;
	}>
> {
	const annotations = await readAnnotations(projectPath);

	// Count annotations per session
	const sessionCounts = new Map<string, number>();
	for (const a of annotations) {
		if (a.type === 'line' || a.type === 'function') {
			const sid = 'session_id' in a ? a.session_id : undefined;
			if (sid) {
				sessionCounts.set(sid, (sessionCounts.get(sid) ?? 0) + 1);
			}
		}
	}

	// Build session records from session annotations
	const sessions: Array<{
		session_id: string;
		event: string;
		timestamp: string;
		agent_type?: string;
		annotation_count: number;
	}> = [];

	for (const a of annotations) {
		if (a.type === 'session') {
			sessions.push({
				session_id: a.session_id,
				event: a.event,
				timestamp: a.timestamp,
				agent_type: a.description ?? undefined,
				annotation_count: sessionCounts.get(a.session_id) ?? 0,
			});
		}
	}

	return sessions;
}

/**
 * Extract model information from the manifest.
 * Used as fallback when the vibecheck CLI binary is not installed.
 */
export async function extractModelsFromManifest(projectPath: string): Promise<
	Array<{
		model_name: string;
		model_version: string;
		tool_name: string;
		annotation_count: number;
		percentage: number;
	}>
> {
	const manifest = await readVibesManifest(projectPath);
	const annotations = await readAnnotations(projectPath);

	// Count annotations per environment hash
	const hashCounts = new Map<string, number>();
	for (const a of annotations) {
		if ((a.type === 'line' || a.type === 'function') && 'environment_hash' in a) {
			const hash = a.environment_hash;
			hashCounts.set(hash, (hashCounts.get(hash) ?? 0) + 1);
		}
	}

	// Group by model name (multiple env hashes can map to same model)
	const modelMap = new Map<
		string,
		{
			model_name: string;
			model_version: string;
			tool_name: string;
			count: number;
		}
	>();

	for (const [hash, entry] of Object.entries(manifest.entries)) {
		if (entry.type === 'environment') {
			const env = entry as VibesEnvironmentEntry;
			const existing = modelMap.get(env.model_name);
			const count = hashCounts.get(hash) ?? 0;
			if (existing) {
				existing.count += count;
			} else {
				modelMap.set(env.model_name, {
					model_name: env.model_name,
					model_version: env.model_version,
					tool_name: env.tool_name,
					count,
				});
			}
		}
	}

	const totalAnnotations = [...modelMap.values()].reduce((sum, m) => sum + m.count, 0);

	return [...modelMap.values()].map((m) => ({
		model_name: m.model_name,
		model_version: m.model_version,
		tool_name: m.tool_name,
		annotation_count: m.count,
		percentage: totalAnnotations > 0 ? Math.round((m.count / totalAnnotations) * 100) : 0,
	}));
}

/**
 * Compute blame data for a specific file from annotations.
 * Used as fallback when the vibecheck CLI binary is not installed.
 */
export async function computeBlameFromAnnotations(
	projectPath: string,
	filePath: string
): Promise<
	Array<{
		line_start: number;
		line_end: number;
		action: string;
		model_name: string;
		model_version: string;
		tool_name: string;
		timestamp: string;
		session_id: string | null;
	}>
> {
	const annotations = await readAnnotations(projectPath);
	const manifest = await readVibesManifest(projectPath);

	// Filter for line annotations matching the file
	const fileAnnotations = annotations.filter(
		(a): a is VibesLineAnnotation => a.type === 'line' && a.file_path === filePath
	);

	// Resolve environment info and build blame entries
	const blame = fileAnnotations.map((a) => {
		const envEntry = manifest.entries[a.environment_hash];
		const env = envEntry?.type === 'environment' ? (envEntry as VibesEnvironmentEntry) : undefined;

		return {
			line_start: a.line_start,
			line_end: a.line_end,
			action: a.action,
			model_name: env?.model_name ?? 'unknown',
			model_version: env?.model_version ?? 'unknown',
			tool_name: env?.tool_name ?? 'unknown',
			timestamp: a.timestamp,
			session_id: a.session_id,
		};
	});

	// Sort by line_start ascending
	blame.sort((a, b) => a.line_start - b.line_start);

	return blame;
}

/**
 * Compute file coverage from annotations.
 * Used as fallback when the vibecheck CLI binary is not installed.
 */
export async function computeCoverageFromAnnotations(projectPath: string): Promise<
	Array<{
		file_path: string;
		coverage_status: 'full' | 'partial' | 'uncovered';
		annotation_count: number;
	}>
> {
	const annotations = await readAnnotations(projectPath);
	const config = await readVibesConfig(projectPath);

	// Group line annotations by file path
	const fileCounts = new Map<string, number>();
	for (const a of annotations) {
		if (a.type === 'line' && 'file_path' in a) {
			fileCounts.set(a.file_path, (fileCounts.get(a.file_path) ?? 0) + 1);
		}
	}

	const results: Array<{
		file_path: string;
		coverage_status: 'full' | 'partial' | 'uncovered';
		annotation_count: number;
	}> = [];

	// Annotated files
	for (const [fp, count] of fileCounts) {
		results.push({
			file_path: fp,
			coverage_status: count > 5 ? 'full' : 'partial',
			annotation_count: count,
		});
	}

	// Try to find uncovered files from tracked extensions
	if (config?.tracked_extensions && config.tracked_extensions.length > 0) {
		const trackedFiles = await scanTrackedFiles(
			projectPath,
			config.tracked_extensions,
			config.exclude_patterns ?? []
		);
		for (const fp of trackedFiles) {
			if (!fileCounts.has(fp)) {
				results.push({ file_path: fp, coverage_status: 'uncovered', annotation_count: 0 });
			}
		}
	}

	// Sort: full first, then partial, then uncovered, then by path
	const statusOrder = { full: 0, partial: 1, uncovered: 2 };
	results.sort(
		(a, b) =>
			statusOrder[a.coverage_status] - statusOrder[b.coverage_status] ||
			a.file_path.localeCompare(b.file_path)
	);

	return results;
}

/**
 * Compute Lines of Code (LOC) coverage from annotations.
 * Counts unique annotated lines vs total lines across all tracked files.
 */
export async function computeLocCoverageFromAnnotations(projectPath: string): Promise<{
	totalLines: number;
	annotatedLines: number;
	coveragePercent: number;
	files: Array<{
		file_path: string;
		total_lines: number;
		annotated_lines: number;
		coverage_percent: number;
	}>;
}> {
	const annotations = await readAnnotations(projectPath);
	const config = await readVibesConfig(projectPath);

	// Collect annotated line ranges per file
	const fileAnnotatedLines = new Map<string, Set<number>>();
	for (const a of annotations) {
		if (a.type === 'line' && 'file_path' in a && 'line_start' in a && 'line_end' in a) {
			let lineSet = fileAnnotatedLines.get(a.file_path);
			if (!lineSet) {
				lineSet = new Set<number>();
				fileAnnotatedLines.set(a.file_path, lineSet);
			}
			for (let i = a.line_start; i <= a.line_end; i++) {
				lineSet.add(i);
			}
		}
	}

	// Determine tracked files
	let trackedFiles: string[] = [];
	if (config?.tracked_extensions && config.tracked_extensions.length > 0) {
		trackedFiles = await scanTrackedFiles(
			projectPath,
			config.tracked_extensions,
			config.exclude_patterns ?? []
		);
	}

	// Include any annotated files not already in tracked list
	for (const fp of fileAnnotatedLines.keys()) {
		if (!trackedFiles.includes(fp)) {
			trackedFiles.push(fp);
		}
	}

	let totalLines = 0;
	let annotatedLines = 0;
	const files: Array<{
		file_path: string;
		total_lines: number;
		annotated_lines: number;
		coverage_percent: number;
	}> = [];

	for (const filePath of trackedFiles) {
		let fileTotal = 0;
		try {
			const content = await readFile(path.join(projectPath, filePath), 'utf-8');
			fileTotal = content.split('\n').length;
		} catch {
			// Skip files that can't be read (deleted, binary, permissions)
			logWarn(`computeLocCoverage: could not read file ${filePath}, skipping`);
			continue;
		}

		const fileAnnotated = fileAnnotatedLines.get(filePath)?.size ?? 0;
		totalLines += fileTotal;
		annotatedLines += fileAnnotated;

		files.push({
			file_path: filePath,
			total_lines: fileTotal,
			annotated_lines: fileAnnotated,
			coverage_percent: fileTotal > 0 ? Math.round((fileAnnotated / fileTotal) * 100) : 0,
		});
	}

	// Sort by coverage percent descending, then by path
	files.sort(
		(a, b) => b.coverage_percent - a.coverage_percent || a.file_path.localeCompare(b.file_path)
	);

	return {
		totalLines,
		annotatedLines,
		coveragePercent: totalLines > 0 ? Math.round((annotatedLines / totalLines) * 100) : 0,
		files,
	};
}

/**
 * Scan the project for files matching tracked extensions.
 * Returns relative file paths. Respects exclude patterns.
 */
async function scanTrackedFiles(
	projectPath: string,
	trackedExtensions: string[],
	excludePatterns: string[]
): Promise<string[]> {
	const results: string[] = [];
	const extSet = new Set(trackedExtensions);

	// Simple exclude check: match directory components against glob-like patterns
	const excludeDirs = excludePatterns
		.map((p) => p.replace(/\*\*/g, '').replace(/\*/g, '').replace(/\//g, ''))
		.filter((d) => d.length > 0);

	async function walk(dir: string, relPrefix: string): Promise<void> {
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}

		for (const entry of entries) {
			const name = entry.name;

			// Skip hidden directories and common excludes
			if (name.startsWith('.') || excludeDirs.includes(name)) {
				continue;
			}

			const fullPath = path.join(dir, name);
			const relPath = relPrefix ? `${relPrefix}/${name}` : name;

			if (entry.isDirectory()) {
				await walk(fullPath, relPath);
			} else if (entry.isFile()) {
				const ext = path.extname(name);
				if (extSet.has(ext)) {
					results.push(relPath);
				}
			}
		}
	}

	await walk(projectPath, '');
	return results;
}

// ============================================================================
// Buffer Inspection (Testing)
// ============================================================================

/**
 * Get the number of buffered (unflushed) annotations for a project.
 * Primarily used for testing.
 */
export function getBufferedAnnotationCount(projectPath: string): number {
	const buf = annotationBuffers.get(projectPath);
	return buf ? buf.annotations.length : 0;
}

/**
 * Get the number of pending (unflushed) manifest entries for a project.
 * Primarily used for testing.
 */
export function getPendingManifestEntryCount(projectPath: string): number {
	const state = manifestDebounces.get(projectPath);
	return state ? state.pendingEntries.size : 0;
}

/**
 * Clear all buffers and timers. Used in tests for cleanup.
 */
export function resetAllBuffers(): void {
	for (const buf of annotationBuffers.values()) {
		if (buf.timer !== null) {
			clearTimeout(buf.timer);
		}
	}
	annotationBuffers.clear();

	for (const state of manifestDebounces.values()) {
		if (state.timer !== null) {
			clearTimeout(state.timer);
		}
	}
	manifestDebounces.clear();

	projectMutexes.clear();
}
