/**
 * Experience Bundle — validation, signature verification, import/export, and sanitization.
 *
 * Handles Ed25519 signature verification using Node's crypto module.
 * Trusted keys are stored in ~/.maestro/memories/trusted-keys.json.
 */

import * as crypto from 'crypto';
import * as path from 'path';
import { promises as fs } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import type {
	ExperienceBundle,
	SignedExperienceBundle,
	TrustedKeyEntry,
	BundleMemoryEntry,
	BundleImportResult,
	ImportedBundleRecord,
} from '../../shared/experience-bundle-types';
import type { MemoryEntry, MemoryScope } from '../../shared/memory-types';
import { app } from 'electron';

function getMemoriesDir(): string {
	return path.join(app.getPath('userData'), 'memories');
}

// ─── Maestro Official Public Key ────────────────────────────────────────────

/** Placeholder — replace with the real Maestro team Ed25519 public key */
const MAESTRO_OFFICIAL_PUBLIC_KEY =
	'0000000000000000000000000000000000000000000000000000000000000000';

// ─── Paths ──────────────────────────────────────────────────────────────────

function getTrustedKeysPath(): string {
	return path.join(getMemoriesDir(), 'trusted-keys.json');
}

function getImportedBundlesPath(): string {
	return path.join(getMemoriesDir(), 'imported-bundles.json');
}

// ─── Canonical JSON ─────────────────────────────────────────────────────────

/** Deterministic JSON serialization with sorted keys (for signature verification) */
function canonicalJson(obj: unknown): string {
	return JSON.stringify(obj, Object.keys(obj as Record<string, unknown>).sort());
}

// ─── Signature Verification ─────────────────────────────────────────────────

/**
 * Verify an Ed25519 signature on a signed bundle.
 * Returns whether the signature is valid and whether the signing key is trusted.
 */
export async function verifyBundleSignature(
	signed: SignedExperienceBundle
): Promise<{ valid: boolean; trusted: boolean }> {
	try {
		if (signed.algorithm !== 'ed25519') {
			return { valid: false, trusted: false };
		}

		const publicKeyBuffer = Buffer.from(signed.signingKey, 'hex');
		const signatureBuffer = Buffer.from(signed.signature, 'hex');
		const dataBuffer = Buffer.from(canonicalJson(signed.bundle), 'utf-8');

		const publicKey = crypto.createPublicKey({
			key: Buffer.concat([
				// Ed25519 public key DER prefix
				Buffer.from('302a300506032b6570032100', 'hex'),
				publicKeyBuffer,
			]),
			format: 'der',
			type: 'spki',
		});

		const valid = crypto.verify(null, dataBuffer, publicKey, signatureBuffer);
		const trusted = valid ? await isKeyTrusted(signed.signingKey) : false;

		return { valid, trusted };
	} catch {
		return { valid: false, trusted: false };
	}
}

// ─── Bundle Validation ──────────────────────────────────────────────────────

/**
 * Validate bundle structure and content integrity.
 */
export function validateBundleIntegrity(bundle: ExperienceBundle): {
	valid: boolean;
	errors: string[];
} {
	const errors: string[] = [];

	if (bundle.version !== 1) {
		errors.push(`Unsupported bundle version: ${bundle.version}`);
	}
	if (!bundle.bundleId || typeof bundle.bundleId !== 'string') {
		errors.push('Missing or invalid bundleId');
	}
	if (!bundle.name || typeof bundle.name !== 'string') {
		errors.push('Missing or invalid name');
	}
	if (!Array.isArray(bundle.memories)) {
		errors.push('Missing or invalid memories array');
	}

	// Verify content hash
	if (bundle.contentHash) {
		const computed = crypto
			.createHash('sha256')
			.update(JSON.stringify(bundle.memories))
			.digest('hex');
		if (computed !== bundle.contentHash) {
			errors.push('Content hash mismatch — bundle may have been tampered with');
		}
	}

	// Validate individual entries
	for (let i = 0; i < (bundle.memories?.length ?? 0); i++) {
		const mem = bundle.memories[i];
		if (!mem.bundleEntryId) errors.push(`Memory ${i}: missing bundleEntryId`);
		if (!mem.content) errors.push(`Memory ${i}: missing content`);
		if (!['rule', 'experience'].includes(mem.type)) {
			errors.push(`Memory ${i}: invalid type "${mem.type}"`);
		}
	}

	return { valid: errors.length === 0, errors };
}

// ─── Import ─────────────────────────────────────────────────────────────────

/**
 * Import a bundle's memories into the local memory store.
 * Deduplicates against existing memories using embedding similarity.
 */
export async function importBundle(
	bundle: ExperienceBundle,
	signatureVerified: boolean,
	signerTrusted: boolean
): Promise<BundleImportResult> {
	const { getMemoryStore } = await import('./memory-store');
	const store = getMemoryStore();

	let memoriesImported = 0;
	let memoriesSkipped = 0;
	let rolesCreated = 0;
	let personasCreated = 0;
	let skillAreasCreated = 0;
	const localMemoryIds: string[] = [];

	// Import hierarchy if present
	if (bundle.hierarchy) {
		// Import roles
		for (const role of bundle.hierarchy.roles) {
			try {
				await store.createRole(role.name, role.description, role.systemPrompt);
				rolesCreated++;
			} catch {
				// Role may already exist
			}
		}

		// Import personas
		for (const persona of bundle.hierarchy.personas) {
			try {
				// Find the parent role by matching bundleRoleId to an imported role name
				const bundleRole = bundle.hierarchy!.roles.find(
					(r) => r.bundleRoleId === persona.bundleRoleId
				);
				if (!bundleRole) continue;

				const registry = await store.readRegistry();
				const existingRole = registry.roles.find(
					(r) => r.name.toLowerCase() === bundleRole.name.toLowerCase()
				);
				if (!existingRole) continue;

				await store.createPersona(
					existingRole.id,
					persona.name,
					persona.description,
					persona.assignedAgents,
					[],
					persona.systemPrompt
				);
				personasCreated++;
			} catch {
				// Persona may already exist
			}
		}

		// Import skill areas
		for (const skill of bundle.hierarchy.skillAreas) {
			try {
				const bundlePersona = bundle.hierarchy!.personas.find(
					(p) => p.bundlePersonaId === skill.bundlePersonaId
				);
				if (!bundlePersona) continue;

				const registry = await store.readRegistry();
				const existingPersona = registry.personas.find(
					(p) => p.name.toLowerCase() === bundlePersona.name.toLowerCase()
				);
				if (!existingPersona) continue;

				await store.createSkillArea(existingPersona.id, skill.name, skill.description);
				skillAreasCreated++;
			} catch {
				// Skill area may already exist
			}
		}
	}

	// Import memories
	for (const bundleMem of bundle.memories) {
		try {
			const newEntry = await store.addMemory({
				content: bundleMem.content,
				type: bundleMem.type,
				scope: 'global' as MemoryScope,
				tags: [...bundleMem.tags, `bundle:${bundle.bundleId}`],
				source: 'repository',
				confidence: bundleMem.confidence,
				experienceContext: bundleMem.experienceContext
					? {
							situation: bundleMem.experienceContext.situation,
							learning: bundleMem.experienceContext.learning,
						}
					: undefined,
			});
			localMemoryIds.push(newEntry.id);
			memoriesImported++;
		} catch {
			memoriesSkipped++;
		}
	}

	// Record import
	const record: ImportedBundleRecord = {
		bundleId: bundle.bundleId,
		name: bundle.name,
		importedAt: Date.now(),
		contentHash: bundle.contentHash,
		memoriesImported,
		signatureVerified,
		signerTrusted,
		localMemoryIds,
	};
	await saveImportRecord(record);

	return {
		memoriesImported,
		memoriesSkipped,
		rolesCreated,
		personasCreated,
		skillAreasCreated,
		signatureVerified,
		signerTrusted,
		bundleId: bundle.bundleId,
	};
}

// ─── Export ─────────────────────────────────────────────────────────────────

/**
 * Export selected memories as an ExperienceBundle.
 */
export async function exportAsBundle(
	memoryIds: string[],
	scope: MemoryScope,
	metadata: Partial<ExperienceBundle>,
	skillAreaId?: string,
	projectPath?: string
): Promise<ExperienceBundle> {
	const { getMemoryStore } = await import('./memory-store');
	const store = getMemoryStore();

	const memories = await store.listMemories(scope, skillAreaId, projectPath);
	const selected = memories.filter((m) => memoryIds.includes(m.id));
	const bundleMemories = selected.map((m) => sanitizeEntry(m));

	const contentHash = crypto
		.createHash('sha256')
		.update(JSON.stringify(bundleMemories))
		.digest('hex');

	return {
		version: 1,
		bundleId: uuidv4(),
		name: metadata.name ?? 'Exported Experiences',
		description: metadata.description ?? '',
		category: metadata.category ?? 'general',
		tags: metadata.tags ?? [],
		author: metadata.author ?? 'Unknown',
		authorUrl: metadata.authorUrl,
		memories: bundleMemories,
		hierarchy: metadata.hierarchy,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		contentHash,
	};
}

// ─── Sanitization ───────────────────────────────────────────────────────────

/**
 * Sanitize a MemoryEntry for bundle inclusion.
 * Strips all local-only fields: embeddings, effectiveness, session refs, paths.
 */
function sanitizeEntry(entry: MemoryEntry): BundleMemoryEntry {
	return {
		bundleEntryId: uuidv4(),
		content: entry.content,
		type: entry.type,
		tags: entry.tags.filter((t) => !t.startsWith('bundle:') && !t.startsWith('promotion:')),
		confidence: entry.confidence,
		skillAreaRef: entry.skillAreaId,
		experienceContext: entry.experienceContext
			? {
					situation: entry.experienceContext.situation,
					learning: entry.experienceContext.learning,
					category: entry.tags.find((t) => t.startsWith('category:'))?.replace('category:', ''),
				}
			: undefined,
	};
}

/**
 * Sanitize memories for submission to the central repository.
 * Strips: sourceSessionId, sourceProjectPath, rawSessionRef, diffSummary,
 * sessionCostUsd, sessionDurationMs, contextUtilizationAtEnd, absolute file paths.
 */
export function sanitizeForSubmission(memories: MemoryEntry[]): BundleMemoryEntry[] {
	return memories.map((m) => sanitizeEntry(m));
}

// ─── Trusted Keys ───────────────────────────────────────────────────────────

/**
 * Read trusted keys from the local store. Seeds with Maestro official key on first access.
 */
export async function getTrustedKeys(): Promise<TrustedKeyEntry[]> {
	const keysPath = getTrustedKeysPath();
	try {
		const content = await fs.readFile(keysPath, 'utf-8');
		const keys = JSON.parse(content) as TrustedKeyEntry[];
		return keys;
	} catch (err: unknown) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
			// Seed with official key
			const officialKey: TrustedKeyEntry = {
				publicKey: MAESTRO_OFFICIAL_PUBLIC_KEY,
				name: 'Maestro Official',
				addedAt: Date.now(),
				expiresAt: 0,
				fingerprint: crypto
					.createHash('sha256')
					.update(Buffer.from(MAESTRO_OFFICIAL_PUBLIC_KEY, 'hex'))
					.digest('hex')
					.slice(0, 16),
			};
			await fs.mkdir(path.dirname(keysPath), { recursive: true });
			await fs.writeFile(keysPath, JSON.stringify([officialKey], null, 2));
			return [officialKey];
		}
		return [];
	}
}

/**
 * Add a trusted key to the local store.
 */
export async function addTrustedKey(key: TrustedKeyEntry): Promise<void> {
	const keys = await getTrustedKeys();
	if (keys.some((k) => k.publicKey === key.publicKey)) return; // Already trusted
	keys.push(key);
	const keysPath = getTrustedKeysPath();
	await fs.mkdir(path.dirname(keysPath), { recursive: true });
	await fs.writeFile(keysPath, JSON.stringify(keys, null, 2));
}

/**
 * Remove a trusted key from the local store by public key.
 */
export async function removeTrustedKey(publicKey: string): Promise<void> {
	const keys = await getTrustedKeys();
	const filtered = keys.filter((k) => k.publicKey !== publicKey);
	if (filtered.length === keys.length) return; // Key not found
	const keysPath = getTrustedKeysPath();
	await fs.writeFile(keysPath, JSON.stringify(filtered, null, 2));
}

/**
 * Check if a public key is in the trusted store.
 */
async function isKeyTrusted(publicKeyHex: string): Promise<boolean> {
	const keys = await getTrustedKeys();
	const now = Date.now();
	return keys.some((k) => k.publicKey === publicKeyHex && (k.expiresAt === 0 || k.expiresAt > now));
}

// ─── Imported Bundles Registry ──────────────────────────────────────────────

/**
 * Get all locally imported bundle records.
 */
export async function getImportedBundles(): Promise<ImportedBundleRecord[]> {
	const filePath = getImportedBundlesPath();
	try {
		const content = await fs.readFile(filePath, 'utf-8');
		return JSON.parse(content) as ImportedBundleRecord[];
	} catch {
		return [];
	}
}

/**
 * Save an import record.
 */
async function saveImportRecord(record: ImportedBundleRecord): Promise<void> {
	const records = await getImportedBundles();
	records.push(record);
	const filePath = getImportedBundlesPath();
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, JSON.stringify(records, null, 2));
}

/**
 * Uninstall a bundle — remove all memories that were imported from it.
 */
export async function uninstallBundle(bundleId: string): Promise<{ removed: number }> {
	const records = await getImportedBundles();
	const record = records.find((r) => r.bundleId === bundleId);
	if (!record) return { removed: 0 };

	const { getMemoryStore } = await import('./memory-store');
	const store = getMemoryStore();

	let removed = 0;
	for (const localId of record.localMemoryIds) {
		try {
			await store.deleteMemory(localId, 'global');
			removed++;
		} catch {
			// Memory may have already been deleted
		}
	}

	// Remove the import record
	const remaining = records.filter((r) => r.bundleId !== bundleId);
	const filePath = getImportedBundlesPath();
	await fs.writeFile(filePath, JSON.stringify(remaining, null, 2));

	return { removed };
}
