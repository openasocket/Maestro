/**
 * Tests for LiveContextBroadcaster — cross-agent memory distribution service.
 *
 * Tests cover:
 * - Basic broadcast flow
 * - Project scope matching
 * - Skill scope matching (persona assignedAgents)
 * - Global scope (all sessions)
 * - Source session exclusion
 * - Terminal/group-chat/SSH/batch exclusion
 * - Queue saturation skip
 * - Dedup (same memory not broadcast twice)
 * - Batching (multiple memories in single cycle)
 * - Config disabled → no-op
 * - Zero running sessions → no crash
 * - broadcastedIds pruning at 1000+
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('electron', () => ({
	app: {
		getPath: vi.fn(() => '/mock/userData'),
	},
}));

vi.mock('electron-store', () => {
	return {
		default: class MockStore {
			private data: Record<string, unknown> = {};
			constructor(_opts?: unknown) {}
			get(key: string) {
				return this.data[key];
			}
			set(key: string, value: unknown) {
				this.data[key] = value;
			}
		},
	};
});

const mockConfig = {
	enabled: true,
	enableLiveInjection: true,
	liveInjectionTokenBudget: 750,
	liveInjectionSessionCap: 2000,
	liveInjectionMaxCount: 3,
	enableCrossAgentBroadcast: true,
	liveSearchCooldownSeconds: 60,
	maxTokenBudget: 1500,
	similarityThreshold: 0.65,
	personaMatchThreshold: 0.4,
	skillMatchThreshold: 0.5,
	maxMemoriesPerSkillArea: 50,
	consolidationThreshold: 0.85,
	decayHalfLifeDays: 30,
	enableAutoConsolidation: true,
	enableEffectivenessTracking: true,
	enableExperienceExtraction: false,
	minHistoryEntriesForAnalysis: 3,
	minNoveltyScore: 0.4,
	analysisCooldownMs: 300000,
	injectionStrategy: 'balanced' as const,
	enableHybridSearch: true,
};

const mockRegistry = {
	version: 1,
	roles: [],
	personas: [
		{
			id: 'persona-rust',
			roleId: 'role-dev',
			name: 'Rust Dev',
			description: 'Rust development',
			embedding: null,
			skillAreaIds: ['skill-1'],
			assignedAgents: ['claude-code'],
			assignedProjects: [],
			active: true,
			createdAt: 1000,
			updatedAt: 1000,
		},
		{
			id: 'persona-all',
			roleId: 'role-dev',
			name: 'General Dev',
			description: 'General development',
			embedding: null,
			skillAreaIds: [],
			assignedAgents: [],
			assignedProjects: [],
			active: true,
			createdAt: 1000,
			updatedAt: 1000,
		},
	],
	skillAreas: [],
};

vi.mock('../../../main/memory/memory-store', () => ({
	getMemoryStore: () => ({
		getConfig: () => Promise.resolve(mockConfig),
		readRegistry: () => Promise.resolve(mockRegistry),
	}),
}));

// Track enqueue calls
const enqueueCalls: {
	sessionId: string;
	content: string;
	source: string;
	tokens: number;
	memoryIds?: string[];
}[] = [];
const queueStats = new Map<
	string,
	{ pendingCount: number; pendingTokens: number; injectionCount: number; injectedTokens: number }
>();

vi.mock('../../../main/memory/live-context-queue', () => ({
	getLiveContextQueue: () => ({
		enqueue: (
			sessionId: string,
			content: string,
			source: string,
			tokens: number,
			memoryIds?: string[]
		) => {
			enqueueCalls.push({ sessionId, content, source, tokens, memoryIds });
		},
		getStats: (sessionId: string) => queueStats.get(sessionId) ?? null,
	}),
}));

// ─── Helpers ────────────────────────────────────────────────────────────────

import type { MemoryEntry } from '../../../shared/memory-types';
import type { ManagedProcess } from '../../../main/process-manager/types';

function makeMemoryEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
	return {
		id: `mem-${Math.random().toString(36).slice(2, 8)}`,
		content: 'Test memory content',
		type: 'experience',
		scope: 'project',
		tags: [],
		source: 'session-analysis',
		confidence: 0.5,
		pinned: false,
		active: true,
		archived: false,
		embedding: null,
		effectivenessScore: 0,
		useCount: 0,
		tokenEstimate: 50,
		lastUsedAt: Date.now(),
		createdAt: Date.now(),
		updatedAt: Date.now(),
		...overrides,
	};
}

function makeProcess(overrides: Partial<ManagedProcess> = {}): ManagedProcess {
	return {
		sessionId: `session-${Math.random().toString(36).slice(2, 8)}`,
		toolType: 'claude-code',
		cwd: '/test',
		pid: 12345,
		isTerminal: false,
		startTime: Date.now(),
		projectPath: '/test/project',
		...overrides,
	} as ManagedProcess;
}

// ─── Test Suite ─────────────────────────────────────────────────────────────

describe('LiveContextBroadcaster', () => {
	let LiveContextBroadcaster: typeof import('../../../main/memory/live-context-broadcaster').LiveContextBroadcaster;
	let _resetBroadcaster: typeof import('../../../main/memory/live-context-broadcaster')._resetBroadcaster;
	let _warmConfigCache: typeof import('../../../main/memory/live-context-broadcaster')._warmConfigCache;

	beforeEach(async () => {
		enqueueCalls.length = 0;
		queueStats.clear();

		// Restore default config
		mockConfig.enableCrossAgentBroadcast = true;

		// Fresh import to reset module state
		const mod = await import('../../../main/memory/live-context-broadcaster');
		LiveContextBroadcaster = mod.LiveContextBroadcaster;
		_resetBroadcaster = mod._resetBroadcaster;
		_warmConfigCache = mod._warmConfigCache;
		_resetBroadcaster();

		// Warm config cache so getCachedConfigSync() returns the mock config
		await _warmConfigCache();
	});

	function createBroadcaster(processes: ManagedProcess[] = []) {
		const broadcaster = new LiveContextBroadcaster();
		broadcaster.setProcessManagerGetter(() => ({ getAll: () => processes }));
		return broadcaster;
	}

	// ─── 1. Basic broadcast ──────────────────────────────────────────────

	it('should enqueue memory in relevant sessions after processPendingBroadcasts', async () => {
		const proc = makeProcess({ sessionId: 's1', projectPath: '/proj' });
		const broadcaster = createBroadcaster([proc]);

		const entry = makeMemoryEntry({ id: 'mem-1', scope: 'project' });
		broadcaster.onMemoryCreated(entry, '/proj', 'other-session');

		await broadcaster.processPendingBroadcasts();

		expect(enqueueCalls).toHaveLength(1);
		expect(enqueueCalls[0].sessionId).toBe('s1');
		expect(enqueueCalls[0].source).toBe('cross-agent');
		expect(enqueueCalls[0].memoryIds).toEqual(['mem-1']);
	});

	// ─── 2. Project scope matching ──────────────────────────────────────

	it('should only broadcast project-scoped memory to sessions with matching projectPath', async () => {
		const match = makeProcess({ sessionId: 's-match', projectPath: '/proj-a' });
		const noMatch = makeProcess({ sessionId: 's-nomatch', projectPath: '/proj-b' });
		const broadcaster = createBroadcaster([match, noMatch]);

		const entry = makeMemoryEntry({ id: 'mem-proj', scope: 'project' });
		broadcaster.onMemoryCreated(entry, '/proj-a');

		await broadcaster.processPendingBroadcasts();

		expect(enqueueCalls).toHaveLength(1);
		expect(enqueueCalls[0].sessionId).toBe('s-match');
	});

	// ─── 3. Skill scope matching ────────────────────────────────────────

	it('should broadcast skill-scoped memory only to sessions matching persona assignedAgents', async () => {
		const claudeProc = makeProcess({ sessionId: 's-claude', toolType: 'claude-code' });
		const codexProc = makeProcess({ sessionId: 's-codex', toolType: 'codex' });
		const broadcaster = createBroadcaster([claudeProc, codexProc]);

		const entry = makeMemoryEntry({
			id: 'mem-skill',
			scope: 'skill',
			personaId: 'persona-rust', // assignedAgents: ['claude-code']
		});
		broadcaster.onMemoryCreated(entry);

		await broadcaster.processPendingBroadcasts();

		expect(enqueueCalls).toHaveLength(1);
		expect(enqueueCalls[0].sessionId).toBe('s-claude');
	});

	it('should broadcast skill-scoped memory to all agents when persona has empty assignedAgents', async () => {
		const claudeProc = makeProcess({ sessionId: 's-claude', toolType: 'claude-code' });
		const codexProc = makeProcess({ sessionId: 's-codex', toolType: 'codex' });
		const broadcaster = createBroadcaster([claudeProc, codexProc]);

		const entry = makeMemoryEntry({
			id: 'mem-skill-all',
			scope: 'skill',
			personaId: 'persona-all', // assignedAgents: []
		});
		broadcaster.onMemoryCreated(entry);

		await broadcaster.processPendingBroadcasts();

		expect(enqueueCalls).toHaveLength(2);
	});

	// ─── 4. Global scope ────────────────────────────────────────────────

	it('should broadcast global memory to all non-excluded sessions', async () => {
		const s1 = makeProcess({ sessionId: 's1', projectPath: '/a' });
		const s2 = makeProcess({ sessionId: 's2', projectPath: '/b' });
		const broadcaster = createBroadcaster([s1, s2]);

		const entry = makeMemoryEntry({ id: 'mem-global', scope: 'global' });
		broadcaster.onMemoryCreated(entry);

		await broadcaster.processPendingBroadcasts();

		expect(enqueueCalls).toHaveLength(2);
		const sessionIds = enqueueCalls.map((c) => c.sessionId).sort();
		expect(sessionIds).toEqual(['s1', 's2']);
	});

	// ─── 5. Source session exclusion ────────────────────────────────────

	it('should not broadcast memory back to the source session', async () => {
		const source = makeProcess({ sessionId: 'source-session', projectPath: '/proj' });
		const other = makeProcess({ sessionId: 'other-session', projectPath: '/proj' });
		const broadcaster = createBroadcaster([source, other]);

		const entry = makeMemoryEntry({ id: 'mem-src', scope: 'project' });
		broadcaster.onMemoryCreated(entry, '/proj', 'source-session');

		await broadcaster.processPendingBroadcasts();

		expect(enqueueCalls).toHaveLength(1);
		expect(enqueueCalls[0].sessionId).toBe('other-session');
	});

	// ─── 6. Terminal exclusion ──────────────────────────────────────────

	it('should never broadcast to terminal sessions', async () => {
		const terminal = makeProcess({ sessionId: 's-term', toolType: 'terminal' });
		const agent = makeProcess({ sessionId: 's-agent', projectPath: '/proj' });
		const broadcaster = createBroadcaster([terminal, agent]);

		const entry = makeMemoryEntry({ id: 'mem-term', scope: 'global' });
		broadcaster.onMemoryCreated(entry);

		await broadcaster.processPendingBroadcasts();

		expect(enqueueCalls).toHaveLength(1);
		expect(enqueueCalls[0].sessionId).toBe('s-agent');
	});

	// ─── 7. Group chat exclusion ────────────────────────────────────────

	it('should never broadcast to group chat sessions', async () => {
		const groupChat = makeProcess({ sessionId: 'group-chat-abc123' });
		const normal = makeProcess({ sessionId: 's-normal', projectPath: '/proj' });
		const broadcaster = createBroadcaster([groupChat, normal]);

		const entry = makeMemoryEntry({ id: 'mem-gc', scope: 'global' });
		broadcaster.onMemoryCreated(entry);

		await broadcaster.processPendingBroadcasts();

		expect(enqueueCalls).toHaveLength(1);
		expect(enqueueCalls[0].sessionId).toBe('s-normal');
	});

	// ─── 8. SSH exclusion ───────────────────────────────────────────────

	it('should never broadcast to SSH sessions', async () => {
		const sshProc = makeProcess({
			sessionId: 's-ssh',
			sshRemoteId: 'remote-1',
			projectPath: '/proj',
		});
		const localProc = makeProcess({ sessionId: 's-local', projectPath: '/proj' });
		const broadcaster = createBroadcaster([sshProc, localProc]);

		const entry = makeMemoryEntry({ id: 'mem-ssh', scope: 'global' });
		broadcaster.onMemoryCreated(entry);

		await broadcaster.processPendingBroadcasts();

		expect(enqueueCalls).toHaveLength(1);
		expect(enqueueCalls[0].sessionId).toBe('s-local');
	});

	// ─── 9. Queue saturation ────────────────────────────────────────────

	it('should skip sessions with 3+ pending items', async () => {
		const saturated = makeProcess({ sessionId: 's-saturated', projectPath: '/proj' });
		const available = makeProcess({ sessionId: 's-available', projectPath: '/proj' });
		const broadcaster = createBroadcaster([saturated, available]);

		queueStats.set('s-saturated', {
			pendingCount: 3,
			pendingTokens: 300,
			injectionCount: 0,
			injectedTokens: 0,
		});

		const entry = makeMemoryEntry({ id: 'mem-sat', scope: 'project' });
		broadcaster.onMemoryCreated(entry, '/proj');

		await broadcaster.processPendingBroadcasts();

		expect(enqueueCalls).toHaveLength(1);
		expect(enqueueCalls[0].sessionId).toBe('s-available');
	});

	// ─── 10. Dedup ──────────────────────────────────────────────────────

	it('should not broadcast the same memory twice', async () => {
		const proc = makeProcess({ sessionId: 's1', projectPath: '/proj' });
		const broadcaster = createBroadcaster([proc]);

		const entry = makeMemoryEntry({ id: 'mem-dedup', scope: 'project' });

		// First broadcast
		broadcaster.onMemoryCreated(entry, '/proj');
		await broadcaster.processPendingBroadcasts();
		expect(enqueueCalls).toHaveLength(1);

		// Second broadcast — same ID
		broadcaster.onMemoryCreated(entry, '/proj');
		await broadcaster.processPendingBroadcasts();
		// Should still be 1 — second was skipped at onMemoryCreated
		expect(enqueueCalls).toHaveLength(1);
	});

	// ─── 11. Batching ───────────────────────────────────────────────────

	it('should process all queued memories in a single processPendingBroadcasts call', async () => {
		const proc = makeProcess({ sessionId: 's1', projectPath: '/proj' });
		const broadcaster = createBroadcaster([proc]);

		for (let i = 0; i < 5; i++) {
			const entry = makeMemoryEntry({ id: `mem-batch-${i}`, scope: 'project' });
			broadcaster.onMemoryCreated(entry, '/proj');
		}

		await broadcaster.processPendingBroadcasts();

		expect(enqueueCalls).toHaveLength(5);
	});

	// ─── 12. Config disabled ────────────────────────────────────────────

	it('should be a no-op when enableCrossAgentBroadcast is false', async () => {
		mockConfig.enableCrossAgentBroadcast = false;
		_resetBroadcaster();
		await _warmConfigCache();

		const proc = makeProcess({ sessionId: 's1', projectPath: '/proj' });
		const broadcaster = createBroadcaster([proc]);

		const entry = makeMemoryEntry({ id: 'mem-disabled', scope: 'project' });
		broadcaster.onMemoryCreated(entry, '/proj');

		await broadcaster.processPendingBroadcasts();

		expect(enqueueCalls).toHaveLength(0);
	});

	// ─── 13. Zero running sessions ──────────────────────────────────────

	it('should not crash when there are no running sessions', async () => {
		const broadcaster = createBroadcaster([]);

		const entry = makeMemoryEntry({ id: 'mem-empty', scope: 'global' });
		broadcaster.onMemoryCreated(entry);

		await broadcaster.processPendingBroadcasts();

		expect(enqueueCalls).toHaveLength(0);
	});

	// ─── 14. broadcastedIds pruning ─────────────────────────────────────

	it('should prune oldest half of broadcastedIds when exceeding 1000', async () => {
		const proc = makeProcess({ sessionId: 's1', projectPath: '/proj' });
		const broadcaster = createBroadcaster([proc]);

		// Queue 1001 memories
		for (let i = 0; i < 1001; i++) {
			const entry = makeMemoryEntry({ id: `mem-prune-${i}`, scope: 'project' });
			broadcaster.onMemoryCreated(entry, '/proj');
		}

		await broadcaster.processPendingBroadcasts();

		// All 1001 should have been enqueued
		expect(enqueueCalls).toHaveLength(1001);

		// After pruning, new memories with pruned IDs should be accepted
		// Re-queue one of the pruned IDs (from the first half)
		const reEntry = makeMemoryEntry({ id: 'mem-prune-0', scope: 'project' });
		broadcaster.onMemoryCreated(reEntry, '/proj');
		await broadcaster.processPendingBroadcasts();

		// Should be 1002 now — the re-queued entry was accepted
		expect(enqueueCalls).toHaveLength(1002);
	});

	// ─── Batch/synopsis exclusion ───────────────────────────────────────

	it('should never broadcast to batch or synopsis sessions', async () => {
		const batchProc = makeProcess({ sessionId: 'batch-123' });
		const synopsisProc = makeProcess({ sessionId: 'synopsis-456' });
		const normal = makeProcess({ sessionId: 's-normal', projectPath: '/proj' });
		const broadcaster = createBroadcaster([batchProc, synopsisProc, normal]);

		const entry = makeMemoryEntry({ id: 'mem-batch-excl', scope: 'global' });
		broadcaster.onMemoryCreated(entry);

		await broadcaster.processPendingBroadcasts();

		expect(enqueueCalls).toHaveLength(1);
		expect(enqueueCalls[0].sessionId).toBe('s-normal');
	});

	// ─── Shutdown ───────────────────────────────────────────────────────

	it('should stop the broadcast timer on shutdown', () => {
		const broadcaster = createBroadcaster([]);
		const entry = makeMemoryEntry({ id: 'mem-shutdown' });

		// Trigger timer start
		broadcaster.onMemoryCreated(entry, '/proj');

		// Should not throw
		broadcaster.shutdown();
	});
});
