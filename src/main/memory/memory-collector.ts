/**
 * MemoryCollector — tracks recent Auto Run task completions in a ring buffer
 * and detects repeated patterns for automatic memory extraction (Strategy 1).
 *
 * Each task completion is hashed (SHA-256, first 12 chars) and stored.
 * Pattern detection (Task 2) groups by hash to find repeated successful tasks.
 */

import * as crypto from 'crypto';

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

// ─── MemoryCollector ────────────────────────────────────────────────────────

export class MemoryCollector {
	private readonly buffer: TaskCompletion[] = [];
	private writeIndex = 0;
	private count = 0;

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
	 * Get the number of entries in the buffer.
	 */
	get size(): number {
		return this.count;
	}
}

// ─── Singleton ──────────────────────────────────────────────────────────────

let _instance: MemoryCollector | null = null;

export function getMemoryCollector(): MemoryCollector {
	if (!_instance) {
		_instance = new MemoryCollector();
	}
	return _instance;
}
