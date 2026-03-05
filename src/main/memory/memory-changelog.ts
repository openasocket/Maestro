/**
 * MemoryChangeLog — unified, typed event stream for memory mutations.
 *
 * Extends the existing per-directory `history.jsonl` audit trail with a
 * centralized ring buffer of structured `MemoryChangeEvent`s. Events are
 * persisted to a single JSON file in the memories directory and exposed
 * via IPC for the renderer (timeline UI, "what changed" digest, etc.).
 *
 * Design: fire-and-forget writes — callers emit events without awaiting
 * persistence so that memory CRUD operations stay fast.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type { MemoryChangeEvent } from '../../shared/memory-types';

// Re-export for downstream consumers
export type { MemoryChangeEvent, MemoryChangeEventType } from '../../shared/memory-types';

// ─── Constants ───────────────────────────────────────────────────────────────

const CHANGELOG_FILENAME = 'changelog.json';
const MAX_EVENTS = 500;

// ─── MemoryChangeLog ─────────────────────────────────────────────────────────

export class MemoryChangeLog {
	private events: MemoryChangeEvent[] = [];
	private loaded = false;
	private dirty = false;
	private flushTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly filePath: string;

	/** Debounce interval for flushing to disk (ms) */
	private static readonly FLUSH_DEBOUNCE_MS = 2000;

	constructor(memoriesDir: string) {
		this.filePath = path.join(memoriesDir, CHANGELOG_FILENAME);
	}

	// ─── Public API ──────────────────────────────────────────────────────

	/**
	 * Emit a new change event. Fire-and-forget — does not block the caller.
	 */
	emit(event: MemoryChangeEvent): void {
		if (!this.loaded) {
			// Load hasn't completed yet — queue the event anyway, it will be
			// merged when load finishes.
		}
		this.events.push(event);

		// Trim to ring buffer size
		if (this.events.length > MAX_EVENTS) {
			this.events = this.events.slice(this.events.length - MAX_EVENTS);
		}

		this.dirty = true;
		this.scheduleDebouncedFlush();
	}

	/**
	 * Get change log events, optionally filtered by time and limited in count.
	 * Returns events in reverse chronological order (newest first).
	 */
	getChangeLog(since?: number, limit?: number): MemoryChangeEvent[] {
		let result = this.events;

		if (since !== undefined) {
			result = result.filter((e) => e.timestamp >= since);
		}

		// Return newest first
		result = [...result].reverse();

		if (limit !== undefined && limit > 0) {
			result = result.slice(0, limit);
		}

		return result;
	}

	/**
	 * Load persisted events from disk. Call once during initialization.
	 */
	async load(): Promise<void> {
		try {
			const raw = await fs.readFile(this.filePath, 'utf-8');
			const parsed = JSON.parse(raw);
			if (Array.isArray(parsed)) {
				// Merge any events that were emitted before load completed
				const preLoadEvents = this.events;
				this.events = parsed.slice(-MAX_EVENTS);
				for (const evt of preLoadEvents) {
					this.events.push(evt);
				}
				if (this.events.length > MAX_EVENTS) {
					this.events = this.events.slice(this.events.length - MAX_EVENTS);
				}
			}
		} catch {
			// File doesn't exist or is corrupt — start fresh
		}
		this.loaded = true;
	}

	/**
	 * Flush pending events to disk immediately. Call on app shutdown.
	 */
	async flush(): Promise<void> {
		if (!this.dirty) return;
		if (this.flushTimer) {
			clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}
		try {
			const dir = path.dirname(this.filePath);
			await fs.mkdir(dir, { recursive: true });
			await fs.writeFile(this.filePath, JSON.stringify(this.events), 'utf-8');
			this.dirty = false;
		} catch {
			// Best-effort — don't let changelog persistence block anything
		}
	}

	/**
	 * Return the total number of events currently stored.
	 */
	get size(): number {
		return this.events.length;
	}

	// ─── Internal ────────────────────────────────────────────────────────

	private scheduleDebouncedFlush(): void {
		if (this.flushTimer) return; // Already scheduled
		this.flushTimer = setTimeout(() => {
			this.flushTimer = null;
			this.flush().catch(() => {});
		}, MemoryChangeLog.FLUSH_DEBOUNCE_MS);
	}
}
