/**
 * LiveContextBroadcaster — when new memories are created, find running
 * sessions where they'd be relevant and enqueue them for mid-session injection.
 *
 * Design constraints:
 * - No LLM calls, no embedding — relevance is purely structural (project path, agent type, scope)
 * - Batched: memories queue up and broadcast every 30 seconds (not on every single creation)
 * - Deduplicating: each memory broadcasts at most once
 * - Source-excluding: never inject a memory back into the session that produced it
 * - Queue-aware: skip sessions with 3+ pending items (already saturated)
 */

import type { MemoryEntry, MemoryConfig, Persona } from '../../shared/memory-types';
import { MEMORY_CONFIG_DEFAULTS } from '../../shared/memory-types';
import type { ManagedProcess } from '../process-manager/types';

// ─── Internal Types ────────────────────────────────────────────────────────

interface PendingBroadcast {
	entry: MemoryEntry;
	sourceProjectPath?: string;
	sourceSessionId?: string;
	queuedAt: number;
}

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

function getCachedConfigSync(): MemoryConfig {
	return _cachedConfig ?? { ...MEMORY_CONFIG_DEFAULTS };
}

// ─── Batch/Synopsis Session Regex ──────────────────────────────────────────

const BATCH_SYNOPSIS_REGEX = /^(batch-|synopsis-)/;

// ─── Broadcaster Implementation ───────────────────────────────────────────

export class LiveContextBroadcaster {
	private pendingBroadcasts: PendingBroadcast[] = [];
	private broadcastedIds = new Set<string>();
	private broadcastTimer: ReturnType<typeof setInterval> | null = null;

	/** Process manager accessor — set via setProcessManagerGetter */
	private getProcessManager: (() => { getAll(): ManagedProcess[] }) | null = null;

	/**
	 * Set the process manager accessor. Must be called before broadcasting can work.
	 * Accepts a getter function to avoid circular import issues.
	 */
	setProcessManagerGetter(getter: () => { getAll(): ManagedProcess[] }): void {
		this.getProcessManager = getter;
	}

	/**
	 * Called after a memory is stored (from experience-analyzer, memory-collector,
	 * or user-created via IPC). Queues the memory for broadcasting.
	 */
	onMemoryCreated(entry: MemoryEntry, sourceProjectPath?: string, sourceSessionId?: string): void {
		const config = getCachedConfigSync();
		if (!config.enableCrossAgentBroadcast) return;

		// Dedup: if already broadcasted, skip
		if (this.broadcastedIds.has(entry.id)) return;

		this.pendingBroadcasts.push({
			entry,
			sourceProjectPath,
			sourceSessionId,
			queuedAt: Date.now(),
		});

		// Start timer if not running
		if (!this.broadcastTimer) {
			this.broadcastTimer = setInterval(() => {
				this.processPendingBroadcasts().catch(() => {});
			}, 30_000);
			// Don't keep process alive just for broadcasts
			if (
				this.broadcastTimer &&
				typeof this.broadcastTimer === 'object' &&
				'unref' in this.broadcastTimer
			) {
				this.broadcastTimer.unref();
			}
		}

		// Pre-warm config cache
		getCachedConfig().catch(() => {});
	}

	/**
	 * Process all pending broadcasts. Called every 30 seconds by timer.
	 * For each pending memory, find relevant running sessions and enqueue.
	 */
	async processPendingBroadcasts(): Promise<void> {
		// Atomic swap — take snapshot and clear
		const pending = this.pendingBroadcasts;
		this.pendingBroadcasts = [];

		if (pending.length === 0) return;

		// Load registry once for the entire broadcast cycle (for persona lookups)
		let personas: Persona[] = [];
		try {
			const { getMemoryStore } = await import('./memory-store');
			const registry = await getMemoryStore().readRegistry();
			personas = registry.personas;
		} catch {
			// Registry unavailable — skill-scope matching will be skipped
		}

		const { getLiveContextQueue } = await import('./live-context-queue');
		const queue = getLiveContextQueue();

		for (const broadcast of pending) {
			const { entry, sourceProjectPath, sourceSessionId } = broadcast;

			// Find relevant sessions
			const sessions = this.findRelevantSessions(
				entry,
				sourceSessionId,
				sourceProjectPath,
				personas,
				queue
			);

			// Enqueue for each relevant session
			for (const session of sessions) {
				const content = this.formatMemoryContent(entry);
				const tokenEstimate = Math.ceil(content.length / 4);
				queue.enqueue(session.sessionId, content, 'cross-agent', tokenEstimate, [entry.id]);
			}

			// Mark as broadcasted
			this.broadcastedIds.add(entry.id);
		}

		// Prune broadcastedIds if exceeding 1000 entries
		if (this.broadcastedIds.size > 1000) {
			const entries = Array.from(this.broadcastedIds);
			const toRemove = entries.slice(0, Math.floor(entries.length / 2));
			for (const id of toRemove) {
				this.broadcastedIds.delete(id);
			}
		}
	}

	/**
	 * Find running sessions where this memory would be relevant.
	 * Lightweight: no LLM, no embedding — purely structural matching.
	 */
	private findRelevantSessions(
		entry: MemoryEntry,
		sourceSessionId: string | undefined,
		sourceProjectPath: string | undefined,
		personas: Persona[],
		queue: { getStats(sessionId: string): { pendingCount: number } | null }
	): ManagedProcess[] {
		if (!this.getProcessManager) return [];

		let processes: ManagedProcess[];
		try {
			processes = this.getProcessManager().getAll();
		} catch {
			return [];
		}

		if (processes.length === 0) return [];

		return processes.filter((proc) => {
			// Exclude terminal processes
			if (proc.toolType === 'terminal') return false;

			// Exclude source session
			if (sourceSessionId && proc.sessionId === sourceSessionId) return false;

			// Exclude group chat sessions
			if (proc.sessionId.startsWith('group-chat-')) return false;

			// Exclude batch/synopsis sessions
			if (BATCH_SYNOPSIS_REGEX.test(proc.sessionId)) return false;

			// Exclude SSH sessions (can't receive mid-session injection)
			if (proc.sshRemoteId) return false;

			// Skip saturated sessions (3+ pending items)
			const stats = queue.getStats(proc.sessionId);
			if (stats && stats.pendingCount >= 3) return false;

			// Check relevance based on memory scope
			if (entry.scope === 'project') {
				// Project-scoped: only sessions with matching project path
				return sourceProjectPath != null && proc.projectPath === sourceProjectPath;
			}

			if (entry.scope === 'skill') {
				// Skill-scoped: check if the memory's persona has assignedAgents matching this session
				if (entry.personaId) {
					const persona = personas.find((p) => p.id === entry.personaId);
					if (persona) {
						// Empty assignedAgents = matches all agents
						if (persona.assignedAgents.length === 0) return true;
						return persona.assignedAgents.includes(proc.toolType);
					}
				}
				// No persona info — skip (can't determine relevance)
				return false;
			}

			if (entry.scope === 'global') {
				// Global: relevant to all remaining sessions
				return true;
			}

			return false;
		});
	}

	/**
	 * Format a memory entry for injection into a session.
	 */
	private formatMemoryContent(entry: MemoryEntry): string {
		const parts: string[] = [];
		parts.push(`[Cross-agent memory | ${entry.type} | ${entry.scope} scope]`);
		parts.push(entry.content);
		if (entry.experienceContext) {
			if (entry.experienceContext.situation) {
				parts.push(`Context: ${entry.experienceContext.situation}`);
			}
			if (entry.experienceContext.learning) {
				parts.push(`Learning: ${entry.experienceContext.learning}`);
			}
		}
		return parts.join('\n');
	}

	/** Stop the broadcast timer (app shutdown). */
	shutdown(): void {
		if (this.broadcastTimer) {
			clearInterval(this.broadcastTimer);
			this.broadcastTimer = null;
		}
	}
}

// ─── Singleton ─────────────────────────────────────────────────────────────

let _broadcaster: LiveContextBroadcaster | null = null;

export function getLiveBroadcaster(): LiveContextBroadcaster {
	if (!_broadcaster) {
		_broadcaster = new LiveContextBroadcaster();
	}
	return _broadcaster;
}

export function shutdownLiveBroadcaster(): void {
	_broadcaster?.shutdown();
	_broadcaster = null;
}

/** Reset singleton for testing */
export function _resetBroadcaster(): void {
	_broadcaster?.shutdown();
	_broadcaster = null;
	_cachedConfig = null;
	_configCacheTime = 0;
}

/** Warm the config cache (async). Call in tests to ensure config is loaded before sync access. */
export async function _warmConfigCache(): Promise<void> {
	await getCachedConfig();
}
