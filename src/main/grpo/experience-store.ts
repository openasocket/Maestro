/**
 * ExperienceStore — file-backed per-project experience library.
 *
 * Storage layout:
 *   <configDir>/grpo/experiences/<projectHash>/library.json
 *   <configDir>/grpo/experiences/<projectHash>/history.jsonl
 *   <configDir>/grpo/experiences/<projectHash>/meta.json
 *   <configDir>/grpo/experiences/global/library.json
 *   <configDir>/grpo/experiences/global/history.jsonl
 *
 * configDir defaults to ~/.config/Maestro/ (Linux) or ~/Library/Application Support/Maestro/ (macOS)
 *
 * Concurrency: All write operations are serialized through an in-process write queue
 * to prevent data corruption. Reads are lock-free (atomic rename ensures consistent reads).
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { app } from 'electron';
import { logger } from '../utils/logger';
import { captureException } from '../utils/sentry';
import type {
	ExperienceEntry,
	ExperienceId,
	ExperienceScope,
	ExperienceUpdateOperation,
	RolloutGroupId,
} from '../../shared/grpo-types';
import { encode, encodeBatch, type EmbeddingModelId } from './embedding-service';

const LOG_CONTEXT = '[ExperienceStore]';

/** JSONL history entry for audit trail */
export interface ExperienceHistoryEntry {
	timestamp: number;
	operation: 'add' | 'modify' | 'delete';
	experienceId: ExperienceId;
	content?: string;
	oldContent?: string;
	newContent?: string;
	reason?: string;
	rolloutGroupId?: RolloutGroupId;
	epoch?: number;
}

/** Metadata stored alongside each project library */
interface ProjectMeta {
	projectPath: string;
	createdAt: number;
}

/** Library file format */
interface LibraryFile {
	version: number;
	entries: ExperienceEntry[];
}

const LIBRARY_VERSION = 1;
const GLOBAL_KEY = 'global';

/**
 * ExperienceStore manages per-project experience libraries backed by JSON files.
 * All write operations are serialized per-project to prevent data corruption.
 */
export class ExperienceStore {
	private baseDir: string;
	private writeQueues = new Map<string, Promise<void>>();

	constructor(baseDirOverride?: string) {
		this.baseDir = baseDirOverride ?? path.join(app.getPath('userData'), 'grpo', 'experiences');
	}

	/**
	 * Initialize the store — create the base directory if needed.
	 */
	async initialize(): Promise<void> {
		await fs.mkdir(this.baseDir, { recursive: true });
		// Ensure global directory exists
		await fs.mkdir(this.getProjectDir(GLOBAL_KEY), { recursive: true });
		logger.debug('Experience store initialized', LOG_CONTEXT);
	}

	/**
	 * Produce a stable, filesystem-safe hash of a project path.
	 * Returns the first 12 chars of the SHA-256 hex digest.
	 */
	projectPathToHash(projectPath: string): string {
		if (projectPath === GLOBAL_KEY) return GLOBAL_KEY;
		return createHash('sha256').update(projectPath).digest('hex').slice(0, 12);
	}

	/**
	 * Get the directory for a project's experience data.
	 */
	private getProjectDir(hashOrGlobal: string): string {
		return path.join(this.baseDir, hashOrGlobal);
	}

	/**
	 * Get the library.json path for a project hash.
	 */
	private getLibraryPath(hash: string): string {
		return path.join(this.getProjectDir(hash), 'library.json');
	}

	/**
	 * Get the history.jsonl path for a project hash.
	 */
	private getHistoryPath(hash: string): string {
		return path.join(this.getProjectDir(hash), 'history.jsonl');
	}

	/**
	 * Get the meta.json path for a project hash.
	 */
	private getMetaPath(hash: string): string {
		return path.join(this.getProjectDir(hash), 'meta.json');
	}

	/**
	 * Serialize write operations per-project to prevent interleaved writes.
	 */
	private async serializedWrite<T>(projectPath: string, fn: () => Promise<T>): Promise<T> {
		const key = this.projectPathToHash(projectPath);
		const prev = this.writeQueues.get(key) ?? Promise.resolve();
		let result: T;
		const next = prev.then(async () => { result = await fn(); });
		this.writeQueues.set(key, next.catch(() => {}));
		await next;
		return result!;
	}

	/**
	 * Ensure the project directory exists and write meta.json if needed.
	 */
	private async ensureProjectDir(projectPath: string): Promise<string> {
		const hash = this.projectPathToHash(projectPath);
		const dir = this.getProjectDir(hash);
		await fs.mkdir(dir, { recursive: true });

		// Write meta.json if it doesn't exist (makes the hash mapping human-recoverable)
		if (hash !== GLOBAL_KEY) {
			const metaPath = this.getMetaPath(hash);
			try {
				await fs.access(metaPath);
			} catch {
				const meta: ProjectMeta = { projectPath, createdAt: Date.now() };
				await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
			}
		}

		return hash;
	}

	/**
	 * Read the library file for a project hash. Returns empty array if not found.
	 */
	private async readLibrary(hash: string): Promise<ExperienceEntry[]> {
		const libPath = this.getLibraryPath(hash);
		try {
			const data = await fs.readFile(libPath, 'utf-8');
			const parsed: LibraryFile = JSON.parse(data);
			return parsed.entries ?? [];
		} catch (err: unknown) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
				return [];
			}
			logger.warn(`Failed to read library for ${hash}: ${err}`, LOG_CONTEXT);
			captureException(err, { operation: 'experience:readLibrary', hash });
			return [];
		}
	}

	/**
	 * Write the library atomically: write to .tmp then rename.
	 */
	private async writeLibrary(hash: string, entries: ExperienceEntry[]): Promise<void> {
		const libPath = this.getLibraryPath(hash);
		const tmpPath = libPath + '.tmp';
		const data: LibraryFile = { version: LIBRARY_VERSION, entries };
		await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
		await fs.rename(tmpPath, libPath);
	}

	/**
	 * Append a history entry to the JSONL audit log.
	 */
	private async appendHistory(hash: string, entry: ExperienceHistoryEntry): Promise<void> {
		const histPath = this.getHistoryPath(hash);
		try {
			await fs.appendFile(histPath, JSON.stringify(entry) + '\n', 'utf-8');
		} catch (err) {
			logger.warn(`Failed to append history for ${hash}: ${err}`, LOG_CONTEXT);
			captureException(err, { operation: 'experience:appendHistory', hash });
		}
	}

	/**
	 * Estimate token count for a content string (rough heuristic: ~4 chars per token).
	 */
	private estimateTokens(content: string): number {
		return Math.ceil(content.length / 4);
	}

	// ─── Embedding Helpers ──────────────────────────────────────────────

	/**
	 * Compute and attach embedding to a single entry.
	 * Errors are caught and logged — embedding failure should not block entry creation.
	 */
	private async computeEntryEmbedding(entry: ExperienceEntry, modelId: EmbeddingModelId): Promise<void> {
		try {
			const embedding = await encode(entry.content, modelId);
			entry.embedding = Array.from(embedding);
			entry.embeddingModel = modelId;
		} catch (err) {
			logger.warn(`Failed to compute embedding for ${entry.id}: ${err}`, LOG_CONTEXT);
		}
	}

	/**
	 * Ensure all entries have embeddings computed by the specified model.
	 * Recomputes embeddings for entries that are missing them or were computed
	 * by a different model (model-switch scenario).
	 *
	 * Returns true if any entries were updated (caller should persist).
	 */
	async ensureEmbeddings(entries: ExperienceEntry[], modelId: EmbeddingModelId): Promise<boolean> {
		const stale = entries.filter(e => !e.embedding || e.embeddingModel !== modelId);
		if (stale.length === 0) return false;

		try {
			const texts = stale.map(e => e.content);
			const vectors = await encodeBatch(texts, modelId);
			stale.forEach((entry, i) => {
				entry.embedding = Array.from(vectors[i]);
				entry.embeddingModel = modelId;
			});
			logger.debug(`Computed embeddings for ${stale.length} entries (model: ${modelId})`, LOG_CONTEXT);
		} catch (err) {
			logger.warn(`Failed to batch-compute embeddings: ${err}`, LOG_CONTEXT);
			return false;
		}
		return true;
	}

	// ─── Public API ────────────────────────────────────────────────────

	/**
	 * Returns all active experiences for a project.
	 * If scope is 'global', returns only global entries.
	 * If the project library is empty and useGlobalFallback is enabled,
	 * falls back to the global library.
	 */
	async getLibrary(
		projectPath: string,
		scope?: ExperienceScope,
		useGlobalFallback = true
	): Promise<ExperienceEntry[]> {
		if (scope === 'global') {
			return this.readLibrary(GLOBAL_KEY);
		}

		const hash = this.projectPathToHash(projectPath);
		const entries = await this.readLibrary(hash);

		if (entries.length === 0 && useGlobalFallback) {
			return this.readLibrary(GLOBAL_KEY);
		}

		return entries;
	}

	/**
	 * Creates a new experience entry with generated ID, timestamps, and token estimate.
	 * If embeddingModel is provided, computes and caches the embedding vector.
	 */
	async addExperience(
		projectPath: string,
		entry: Omit<ExperienceEntry, 'id' | 'createdAt' | 'updatedAt' | 'useCount' | 'tokenEstimate'>,
		embeddingModel?: EmbeddingModelId
	): Promise<ExperienceEntry> {
		return this.serializedWrite(projectPath, async () => {
			const hash = await this.ensureProjectDir(projectPath);
			const entries = await this.readLibrary(hash);

			const now = Date.now();
			const newEntry: ExperienceEntry = {
				...entry,
				id: randomUUID(),
				createdAt: now,
				updatedAt: now,
				useCount: 0,
				tokenEstimate: this.estimateTokens(entry.content),
			};

			if (embeddingModel) {
				await this.computeEntryEmbedding(newEntry, embeddingModel);
			}

			entries.push(newEntry);
			await this.writeLibrary(hash, entries);
			await this.appendHistory(hash, {
				timestamp: now,
				operation: 'add',
				experienceId: newEntry.id,
				content: newEntry.content,
			});

			logger.debug(`Added experience ${newEntry.id} to ${hash}`, LOG_CONTEXT);
			return newEntry;
		});
	}

	/**
	 * Updates an existing entry, bumps updatedAt, recalculates tokenEstimate.
	 * If embeddingModel is provided and content changed, recomputes the embedding.
	 */
	async modifyExperience(
		projectPath: string,
		id: ExperienceId,
		updates: Partial<Pick<ExperienceEntry, 'content' | 'category'>>,
		embeddingModel?: EmbeddingModelId
	): Promise<ExperienceEntry> {
		return this.serializedWrite(projectPath, async () => {
			const hash = await this.ensureProjectDir(projectPath);
			const entries = await this.readLibrary(hash);
			const idx = entries.findIndex(e => e.id === id);

			if (idx === -1) {
				throw new Error(`Experience ${id} not found in project ${projectPath}`);
			}

			const oldContent = entries[idx].content;
			const now = Date.now();

			if (updates.content !== undefined) {
				entries[idx].content = updates.content;
				entries[idx].tokenEstimate = this.estimateTokens(updates.content);
			}
			if (updates.category !== undefined) {
				entries[idx].category = updates.category;
			}
			entries[idx].updatedAt = now;

			// Recompute embedding if content changed and model is specified
			if (embeddingModel && updates.content !== undefined) {
				await this.computeEntryEmbedding(entries[idx], embeddingModel);
			}

			await this.writeLibrary(hash, entries);
			await this.appendHistory(hash, {
				timestamp: now,
				operation: 'modify',
				experienceId: id,
				oldContent,
				newContent: entries[idx].content,
			});

			logger.debug(`Modified experience ${id} in ${hash}`, LOG_CONTEXT);
			return entries[idx];
		});
	}

	/**
	 * Removes an entry from the library.
	 */
	async deleteExperience(projectPath: string, id: ExperienceId): Promise<void> {
		return this.serializedWrite(projectPath, async () => {
			const hash = await this.ensureProjectDir(projectPath);
			const entries = await this.readLibrary(hash);
			const idx = entries.findIndex(e => e.id === id);

			if (idx === -1) {
				throw new Error(`Experience ${id} not found in project ${projectPath}`);
			}

			const removed = entries.splice(idx, 1)[0];
			await this.writeLibrary(hash, entries);
			await this.appendHistory(hash, {
				timestamp: Date.now(),
				operation: 'delete',
				experienceId: id,
				content: removed.content,
			});

			logger.debug(`Deleted experience ${id} from ${hash}`, LOG_CONTEXT);
		});
	}

	/**
	 * Batch-applies add/modify/delete operations from a semantic advantage.
	 * Each operation is logged to history with the rollout group ID.
	 * If embeddingModel is provided, computes embeddings for new/modified entries.
	 */
	async applyOperations(
		projectPath: string,
		operations: ExperienceUpdateOperation[],
		rolloutGroupId: RolloutGroupId,
		epoch?: number,
		embeddingModel?: EmbeddingModelId
	): Promise<void> {
		return this.serializedWrite(projectPath, async () => {
			const hash = await this.ensureProjectDir(projectPath);
			const entries = await this.readLibrary(hash);
			const now = Date.now();

			for (const op of operations) {
				switch (op.operation) {
					case 'add': {
						if (!op.content) break;
						const newEntry: ExperienceEntry = {
							id: randomUUID(),
							content: op.content,
							category: op.category ?? 'general',
							scope: 'project',
							agentType: 'all',
							createdAt: now,
							updatedAt: now,
							evidenceCount: 1,
							useCount: 0,
							lastRolloutGroupId: rolloutGroupId,
							tokenEstimate: this.estimateTokens(op.content),
						};
						if (embeddingModel) {
							await this.computeEntryEmbedding(newEntry, embeddingModel);
						}
						entries.push(newEntry);
						await this.appendHistory(hash, {
							timestamp: now,
							operation: 'add',
							experienceId: newEntry.id,
							content: newEntry.content,
							rolloutGroupId,
							epoch,
						});
						break;
					}
					case 'modify': {
						if (!op.targetId) break;
						const idx = entries.findIndex(e => e.id === op.targetId);
						if (idx === -1) {
							logger.warn(`applyOperations: experience ${op.targetId} not found, skipping modify`, LOG_CONTEXT);
							break;
						}
						const oldContent = entries[idx].content;
						if (op.content !== undefined) {
							entries[idx].content = op.content;
							entries[idx].tokenEstimate = this.estimateTokens(op.content);
						}
						if (op.category !== undefined) {
							entries[idx].category = op.category;
						}
						entries[idx].updatedAt = now;
						entries[idx].evidenceCount += 1;
						entries[idx].lastRolloutGroupId = rolloutGroupId;
						if (embeddingModel && op.content !== undefined) {
							await this.computeEntryEmbedding(entries[idx], embeddingModel);
						}
						await this.appendHistory(hash, {
							timestamp: now,
							operation: 'modify',
							experienceId: op.targetId,
							oldContent,
							newContent: entries[idx].content,
							rolloutGroupId,
							epoch,
						});
						break;
					}
					case 'delete': {
						if (!op.targetId) break;
						const delIdx = entries.findIndex(e => e.id === op.targetId);
						if (delIdx === -1) {
							logger.warn(`applyOperations: experience ${op.targetId} not found, skipping delete`, LOG_CONTEXT);
							break;
						}
						const removed = entries.splice(delIdx, 1)[0];
						await this.appendHistory(hash, {
							timestamp: now,
							operation: 'delete',
							experienceId: op.targetId,
							content: removed.content,
							rolloutGroupId,
							epoch,
						});
						break;
					}
				}
			}

			await this.writeLibrary(hash, entries);
			logger.debug(`Applied ${operations.length} operations to ${hash}`, LOG_CONTEXT);
		});
	}

	/**
	 * Called by the prompt injector each time experiences are injected.
	 * Increments useCount for the given experience IDs.
	 */
	async incrementUseCount(projectPath: string, ids: ExperienceId[]): Promise<void> {
		return this.serializedWrite(projectPath, async () => {
			const hash = await this.ensureProjectDir(projectPath);
			const entries = await this.readLibrary(hash);

			const idSet = new Set(ids);
			for (const entry of entries) {
				if (idSet.has(entry.id)) {
					entry.useCount += 1;
				}
			}

			await this.writeLibrary(hash, entries);
		});
	}

	/**
	 * Removes entries not used in `pruneAfterEpochs` epochs.
	 * Returns the IDs of pruned entries.
	 */
	async pruneStaleExperiences(
		projectPath: string,
		currentEpoch: number,
		pruneAfterEpochs: number
	): Promise<ExperienceId[]> {
		return this.serializedWrite(projectPath, async () => {
			const hash = await this.ensureProjectDir(projectPath);
			const entries = await this.readLibrary(hash);

			// Read history to find last epoch each experience was involved in
			const lastEpochMap = new Map<ExperienceId, number>();
			const historyEntries = await this.readHistoryRaw(hash);
			for (const h of historyEntries) {
				if (h.epoch !== undefined) {
					const current = lastEpochMap.get(h.experienceId) ?? 0;
					if (h.epoch > current) {
						lastEpochMap.set(h.experienceId, h.epoch);
					}
				}
			}

			const pruned: ExperienceId[] = [];
			const remaining: ExperienceEntry[] = [];

			for (const entry of entries) {
				const lastEpoch = lastEpochMap.get(entry.id) ?? 0;
				if (currentEpoch - lastEpoch > pruneAfterEpochs && entry.useCount === 0) {
					pruned.push(entry.id);
					await this.appendHistory(hash, {
						timestamp: Date.now(),
						operation: 'delete',
						experienceId: entry.id,
						content: entry.content,
						reason: 'stale-prune',
						epoch: currentEpoch,
					});
				} else {
					remaining.push(entry);
				}
			}

			if (pruned.length > 0) {
				await this.writeLibrary(hash, remaining);
				logger.info(`Pruned ${pruned.length} stale experiences from ${hash}`, LOG_CONTEXT);
			}

			return pruned;
		});
	}

	/**
	 * Returns recent history entries from the JSONL log.
	 */
	async getHistory(projectPath: string, limit?: number): Promise<ExperienceHistoryEntry[]> {
		const hash = this.projectPathToHash(projectPath);
		const entries = await this.readHistoryRaw(hash);
		// Return most recent first
		entries.reverse();
		return limit ? entries.slice(0, limit) : entries;
	}

	/**
	 * Read all history entries from JSONL file (oldest first).
	 */
	private async readHistoryRaw(hash: string): Promise<ExperienceHistoryEntry[]> {
		const histPath = this.getHistoryPath(hash);
		try {
			const data = await fs.readFile(histPath, 'utf-8');
			const lines = data.trim().split('\n').filter(line => line.length > 0);
			return lines.map(line => JSON.parse(line) as ExperienceHistoryEntry);
		} catch (err: unknown) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
				return [];
			}
			logger.warn(`Failed to read history for ${hash}: ${err}`, LOG_CONTEXT);
			return [];
		}
	}

	/**
	 * Get the base directory (for testing/debugging).
	 */
	getBaseDir(): string {
		return this.baseDir;
	}
}

// ─── Singleton ─────────────────────────────────────────────────────

let experienceStoreInstance: ExperienceStore | null = null;

/**
 * Get the singleton ExperienceStore instance.
 */
export function getExperienceStore(): ExperienceStore {
	if (!experienceStoreInstance) {
		experienceStoreInstance = new ExperienceStore();
	}
	return experienceStoreInstance;
}

/**
 * Initialize the singleton ExperienceStore.
 */
export async function initializeExperienceStore(): Promise<void> {
	const store = getExperienceStore();
	await store.initialize();
}

/**
 * Reset the singleton (for testing).
 */
export function resetExperienceStore(): void {
	experienceStoreInstance = null;
}
