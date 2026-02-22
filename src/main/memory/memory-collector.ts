/**
 * MemoryCollector — tracks recent Auto Run task completions in a ring buffer
 * and detects repeated patterns for automatic memory extraction (Strategy 1).
 *
 * Each task completion is hashed (SHA-256, first 12 chars) and stored.
 * Pattern detection groups by hash to find repeated successful tasks and
 * proposes memories via the MemoryStore with cascading skill area placement.
 */

import * as crypto from 'crypto';
import type { MemorySearchResult } from '../../shared/memory-types';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface TaskCompletion {
	/** SHA-256 content hash (first 12 chars) of the task content */
	contentHash: string;
	/** Original task content */
	taskContent: string;
	/** Project path where the task ran */
	projectPath: string;
	/** Agent type that executed the task */
	agentType: string;
	/** Process exit code */
	exitCode: number;
	/** Task output (truncated) */
	output: string;
	/** How long the task took (ms) */
	durationMs: number;
	/** When the task completed */
	completedAt: number;
}

// ─── Ring Buffer ────────────────────────────────────────────────────────────

const RING_BUFFER_SIZE = 100;

// ─── Constants ─────────────────────────────────────────────────────────────

/** Minimum number of successful completions of the same task before proposing a memory */
const PATTERN_THRESHOLD = 3;

/** Cosine similarity above which an existing memory is considered a duplicate */
const DEDUP_SIMILARITY = 0.8;

// ─── MemoryCollector ────────────────────────────────────────────────────────

export class MemoryCollector {
	private readonly buffer: TaskCompletion[] = [];
	private writeIndex = 0;
	private count = 0;

	/** Content hashes that have already been proposed as memories — prevents duplicates across calls */
	private readonly proposedHashes = new Set<string>();

	/**
	 * Compute a content hash for task deduplication.
	 * Uses SHA-256, truncated to first 12 hex characters.
	 */
	static contentHash(taskContent: string): string {
		return crypto.createHash('sha256').update(taskContent).digest('hex').slice(0, 12);
	}

	/**
	 * Record a completed Auto Run task in the ring buffer.
	 */
	onAutoRunTaskComplete(
		taskContent: string,
		projectPath: string,
		agentType: string,
		exitCode: number,
		output: string,
		durationMs: number
	): void {
		const entry: TaskCompletion = {
			contentHash: MemoryCollector.contentHash(taskContent),
			taskContent,
			projectPath,
			agentType,
			exitCode,
			output: output.slice(0, 2000),
			durationMs,
			completedAt: Date.now(),
		};

		if (this.count < RING_BUFFER_SIZE) {
			this.buffer.push(entry);
			this.count++;
		} else {
			this.buffer[this.writeIndex] = entry;
		}
		this.writeIndex = (this.writeIndex + 1) % RING_BUFFER_SIZE;
	}

	/**
	 * Get all entries currently in the ring buffer (newest last).
	 */
	getEntries(): TaskCompletion[] {
		if (this.count < RING_BUFFER_SIZE) {
			return [...this.buffer];
		}
		// Ring wrapped — read from writeIndex to end, then start to writeIndex
		return [...this.buffer.slice(this.writeIndex), ...this.buffer.slice(0, this.writeIndex)];
	}

	/**
	 * Get entries grouped by content hash.
	 */
	getEntriesByHash(): Map<string, TaskCompletion[]> {
		const groups = new Map<string, TaskCompletion[]>();
		for (const entry of this.getEntries()) {
			const group = groups.get(entry.contentHash) ?? [];
			group.push(entry);
			groups.set(entry.contentHash, group);
		}
		return groups;
	}

	/**
	 * Detect repeated successful task patterns and propose memories.
	 *
	 * Groups buffer entries by content hash. For each hash with 3+ successful
	 * completions (exit code 0):
	 *   1. Skip if this hash was already proposed in this session.
	 *   2. Use cascading search to check for duplicates (similarity > 0.80 → skip).
	 *   3. Use the top cascading search result to find the best skill area.
	 *   4. Create a memory with scope: 'skill' (if matched) or 'project'.
	 *   5. All auto-collected entries: type 'rule', source 'auto-run', confidence 0.5.
	 *
	 * Degrades gracefully when the embedding service is unavailable — skips dedup
	 * and falls back to project scope.
	 *
	 * @returns Number of memories proposed in this call.
	 */
	async detectPatterns(projectPath: string, agentType: string): Promise<number> {
		const groups = this.getEntriesByHash();
		let proposed = 0;

		for (const [hash, entries] of groups) {
			// Skip already-proposed patterns
			if (this.proposedHashes.has(hash)) continue;

			// Need 3+ entries with exit code 0
			const successful = entries.filter((e) => e.exitCode === 0);
			if (successful.length < PATTERN_THRESHOLD) continue;

			// Use task content from the most recent successful entry
			const latest = successful[successful.length - 1];
			const content = latest.taskContent;

			// Lazy-import to avoid circular dependencies at module load time
			const { getMemoryStore } = await import('./memory-store');
			const store = getMemoryStore();
			const config = await store.getConfig();

			// Attempt cascading search for both dedup and skill area matching.
			// A single call handles both — avoids double-encoding the query.
			let searchResults: MemorySearchResult[] = [];
			try {
				searchResults = await store.cascadingSearch(content, config, agentType, projectPath, 10);
			} catch {
				// Embedding service unavailable — proceed without dedup or skill matching
			}

			// Dedup: skip if any existing memory is too similar
			if (searchResults.some((r) => r.similarity > DEDUP_SIMILARITY)) {
				this.proposedHashes.add(hash);
				continue;
			}

			// Skill area placement: use the top result's skill area if available
			let scope: 'skill' | 'project' = 'project';
			let skillAreaId: string | undefined;

			if (searchResults.length > 0 && searchResults[0].entry.skillAreaId) {
				scope = 'skill';
				skillAreaId = searchResults[0].entry.skillAreaId;
			}

			// Create the memory entry
			try {
				await store.addMemory(
					{
						content,
						type: 'rule',
						scope,
						skillAreaId,
						source: 'auto-run',
						confidence: 0.5,
						pinned: false,
						tags: ['auto-detected', 'pattern'],
					},
					scope === 'project' ? projectPath : undefined
				);
				proposed++;
			} catch {
				// Memory creation failed — log nothing, degrade silently
			}

			this.proposedHashes.add(hash);
		}

		return proposed;
	}

	/**
	 * Check whether a content hash has already been proposed as a memory.
	 */
	isHashProposed(contentHash: string): boolean {
		return this.proposedHashes.has(contentHash);
	}

	/**
	 * Get the number of entries in the buffer.
	 */
	get size(): number {
		return this.count;
	}
}

// ─── Singleton ──────────────────────────────────────────────────────────────

let _instance: MemoryCollector | null = null;

/**
 * Get the singleton MemoryCollector instance.
 * Creates on first use (lazy initialization). Non-blocking.
 */
export function getMemoryCollector(): MemoryCollector {
	if (!_instance) {
		_instance = new MemoryCollector();
	}
	return _instance;
}

/**
 * Initialize the singleton MemoryCollector.
 * Tolerates initialization failures — logs and returns null.
 */
export async function initializeMemoryCollector(): Promise<MemoryCollector | null> {
	try {
		return getMemoryCollector();
	} catch {
		// Construction failed — degrade silently
		return null;
	}
}

/**
 * Reset the singleton (for testing).
 */
export function resetMemoryCollector(): void {
	_instance = null;
}
