/**
 * LiveContextQueue — per-session queue of pending memory updates
 * that get prepended to the user's next message.
 *
 * The queue is drained atomically: all pending items for a session
 * are consumed in a single drain() call, formatted as an XML block,
 * and prepended to the user's message by the process:write hook.
 *
 * Design constraints:
 * - hasContent() must be O(1) — called on EVERY process:write
 * - drain() is called rarely (only when pending content exists)
 * - Never blocks user writes — all failures degrade silently
 * - Token budget enforced at drain time, not enqueue time
 */

import type { PendingContextSource, MemoryConfig } from '../../shared/memory-types';
import { MEMORY_CONFIG_DEFAULTS } from '../../shared/memory-types';

// ─── Internal Types ────────────────────────────────────────────────────────

interface PendingContext {
	/** The formatted memory content (already as text lines) */
	content: string;
	/** Where this context came from */
	source: PendingContextSource;
	/** When it was queued */
	queuedAt: number;
	/** Estimated token count (chars / 4 approximation) */
	tokenEstimate: number;
	/** Memory IDs included in this content (for dedup tracking) */
	memoryIds?: string[];
}

interface SessionQueueState {
	/** Pending context items not yet delivered */
	pending: PendingContext[];
	/** Total tokens queued */
	totalTokens: number;
	/** IDs of memories already delivered mid-session (dedup) */
	deliveredMemoryIds: Set<string>;
	/** IDs of memories injected at spawn time (dedup — from recordSessionInjection) */
	spawnInjectedIds: Set<string>;
	/** Number of user writes to this session (used by EXP-LIVE-02 monitor) */
	writeCount: number;
	/** Number of mid-session injections delivered */
	injectionCount: number;
	/** Total tokens injected mid-session */
	injectedTokens: number;
}

/** Source priority — lower number = higher priority (drained first when budget is tight) */
const SOURCE_PRIORITY: Record<PendingContextSource, number> = {
	'cross-agent': 1,
	'new-experience': 2,
	'skill-update': 3,
	monitoring: 4,
};

// ─── Config Cache ──────────────────────────────────────────────────────────

let _cachedConfig: MemoryConfig | null = null;
let _configCacheTime = 0;
const CONFIG_CACHE_TTL_MS = 30_000;

async function getCachedConfig(): Promise<MemoryConfig> {
	const now = Date.now();
	if (_cachedConfig && now - _configCacheTime < CONFIG_CACHE_TTL_MS) {
		return _cachedConfig;
	}
	try {
		const { getMemoryStore } = await import('./memory-store');
		_cachedConfig = await getMemoryStore().getConfig();
		_configCacheTime = now;
		return _cachedConfig;
	} catch {
		return { ...MEMORY_CONFIG_DEFAULTS };
	}
}

/** Synchronous config access — returns cached or defaults (never blocks) */
function getCachedConfigSync(): MemoryConfig {
	return _cachedConfig ?? { ...MEMORY_CONFIG_DEFAULTS };
}

// ─── Queue Implementation ──────────────────────────────────────────────────

export class LiveContextQueue {
	private sessions = new Map<string, SessionQueueState>();

	/** Enqueue a context update for a session. */
	enqueue(
		sessionId: string,
		content: string,
		source: PendingContextSource,
		tokenEstimate: number,
		memoryIds?: string[]
	): void {
		const config = getCachedConfigSync();
		if (!config.enableLiveInjection) return;

		const state = this.getOrCreateState(sessionId);

		// Dedup: skip if ALL memoryIds are already delivered or spawn-injected
		if (memoryIds && memoryIds.length > 0) {
			const allKnown = memoryIds.every(
				(id) => state.deliveredMemoryIds.has(id) || state.spawnInjectedIds.has(id)
			);
			if (allKnown) return;
		}

		const item: PendingContext = {
			content,
			source,
			queuedAt: Date.now(),
			tokenEstimate,
			memoryIds,
		};

		state.pending.push(item);
		state.totalTokens += tokenEstimate;

		// Pre-warm config cache asynchronously
		getCachedConfig().catch(() => {});
	}

	/** Check if a session has pending content. O(1) Map lookup — called on every process:write. */
	hasContent(sessionId: string): boolean {
		const state = this.sessions.get(sessionId);
		return state !== undefined && state.pending.length > 0;
	}

	/** Atomically drain pending content up to token budget. Returns formatted XML string or null. */
	drain(sessionId: string, maxTokens?: number): string | null {
		const state = this.sessions.get(sessionId);
		if (!state || state.pending.length === 0) return null;

		const config = getCachedConfigSync();

		// Check injection count cap
		if (state.injectionCount >= config.liveInjectionMaxCount) return null;

		// Check session token cap
		if (state.injectedTokens >= config.liveInjectionSessionCap) return null;

		// Effective budget
		const remainingSessionBudget = config.liveInjectionSessionCap - state.injectedTokens;
		const effectiveBudget = Math.min(
			maxTokens ?? config.liveInjectionTokenBudget,
			remainingSessionBudget
		);

		// Sort pending by source priority (ascending = higher priority first)
		state.pending.sort((a, b) => SOURCE_PRIORITY[a.source] - SOURCE_PRIORITY[b.source]);

		// Greedily select items until budget exhausted
		const selected: PendingContext[] = [];
		const remaining: PendingContext[] = [];
		let usedTokens = 0;

		for (const item of state.pending) {
			if (usedTokens + item.tokenEstimate <= effectiveBudget) {
				selected.push(item);
				usedTokens += item.tokenEstimate;
			} else {
				remaining.push(item);
			}
		}

		if (selected.length === 0) return null;

		// Update state
		state.pending = remaining;
		state.totalTokens = remaining.reduce((sum, item) => sum + item.tokenEstimate, 0);

		// Track delivered memory IDs
		for (const item of selected) {
			if (item.memoryIds) {
				for (const id of item.memoryIds) {
					state.deliveredMemoryIds.add(id);
				}
			}
		}

		state.injectionCount++;
		state.injectedTokens += usedTokens;

		// Format as XML block
		const contentLines = selected.map((item) => item.content).join('\n');
		return `<agent-context-update reason="new experiences available">\n${contentLines}\n</agent-context-update>`;
	}

	/** Mark memory IDs as already delivered (called from spawn-time injection for dedup). */
	markDelivered(sessionId: string, memoryIds: string[]): void {
		const state = this.getOrCreateState(sessionId);
		for (const id of memoryIds) {
			state.deliveredMemoryIds.add(id);
			state.spawnInjectedIds.add(id);
		}
	}

	/** Increment write count for a session (used by EXP-LIVE-02 periodic trigger). */
	notifyWrite(sessionId: string): void {
		const state = this.getOrCreateState(sessionId);
		state.writeCount++;
	}

	/** Get write count for monitoring (EXP-LIVE-02). */
	getWriteCount(sessionId: string): number {
		return this.sessions.get(sessionId)?.writeCount ?? 0;
	}

	/** Clean up session state. Called from exit-listener. */
	clearSession(sessionId: string): void {
		this.sessions.delete(sessionId);
	}

	/** Get queue stats for a session (for UI/debugging). */
	getStats(sessionId: string): {
		pendingCount: number;
		pendingTokens: number;
		injectionCount: number;
		injectedTokens: number;
	} | null {
		const state = this.sessions.get(sessionId);
		if (!state) return null;
		return {
			pendingCount: state.pending.length,
			pendingTokens: state.totalTokens,
			injectionCount: state.injectionCount,
			injectedTokens: state.injectedTokens,
		};
	}

	// ─── Internal Helpers ──────────────────────────────────────────────────

	private getOrCreateState(sessionId: string): SessionQueueState {
		let state = this.sessions.get(sessionId);
		if (!state) {
			state = {
				pending: [],
				totalTokens: 0,
				deliveredMemoryIds: new Set(),
				spawnInjectedIds: new Set(),
				writeCount: 0,
				injectionCount: 0,
				injectedTokens: 0,
			};
			this.sessions.set(sessionId, state);
		}
		return state;
	}
}

// ─── Singleton ─────────────────────────────────────────────────────────────

let _queue: LiveContextQueue | null = null;

export function getLiveContextQueue(): LiveContextQueue {
	if (!_queue) {
		_queue = new LiveContextQueue();
	}
	return _queue;
}

/** Reset singleton for testing */
export function _resetLiveContextQueue(): void {
	_queue = null;
	_cachedConfig = null;
	_configCacheTime = 0;
}

/** Warm the config cache (async). Call before enqueue in tests to ensure config is loaded. */
export async function _warmConfigCache(): Promise<void> {
	await getCachedConfig();
}
