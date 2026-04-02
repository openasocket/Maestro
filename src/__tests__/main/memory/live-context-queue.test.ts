/**
 * Tests for LiveContextQueue — per-session pending context queue.
 *
 * Tests cover:
 * - Enqueue and drain: basic flow
 * - Token budget enforcement
 * - Priority ordering (source-based)
 * - Dedup — spawn-time IDs
 * - Dedup — mid-session IDs
 * - Injection count cap
 * - Session token cap
 * - clearSession
 * - notifyWrite / getWriteCount
 * - hasContent O(1) semantics
 * - Config check: enableLiveInjection=false → no-op
 * - XML format of drained output
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
	enableCrossAgentBroadcast: false,
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

vi.mock('../../../main/memory/memory-store', () => ({
	getMemoryStore: () => ({
		getConfig: () => Promise.resolve(mockConfig),
	}),
}));

// ─── Test Suite ─────────────────────────────────────────────────────────────

describe('LiveContextQueue', () => {
	let LiveContextQueue: typeof import('../../../main/memory/live-context-queue').LiveContextQueue;
	let _resetLiveContextQueue: typeof import('../../../main/memory/live-context-queue')._resetLiveContextQueue;
	let _warmConfigCache: typeof import('../../../main/memory/live-context-queue')._warmConfigCache;
	let getLiveContextQueue: typeof import('../../../main/memory/live-context-queue').getLiveContextQueue;

	beforeEach(async () => {
		vi.clearAllMocks();
		const mod = await import('../../../main/memory/live-context-queue');
		LiveContextQueue = mod.LiveContextQueue;
		_resetLiveContextQueue = mod._resetLiveContextQueue;
		_warmConfigCache = mod._warmConfigCache;
		getLiveContextQueue = mod.getLiveContextQueue;
		_resetLiveContextQueue();
		// Reset config to defaults
		mockConfig.enableLiveInjection = true;
		mockConfig.liveInjectionTokenBudget = 750;
		mockConfig.liveInjectionSessionCap = 2000;
		mockConfig.liveInjectionMaxCount = 3;
		// Warm the async config cache so sync reads work
		await _warmConfigCache();
	});

	// ── 1. Enqueue and drain ──

	it('should enqueue 3 items and drain returns formatted XML with all 3', () => {
		const queue = new LiveContextQueue();

		queue.enqueue('s1', 'Line one', 'new-experience', 50, ['m1']);
		queue.enqueue('s1', 'Line two', 'monitoring', 60, ['m2']);
		queue.enqueue('s1', 'Line three', 'skill-update', 40, ['m3']);

		const result = queue.drain('s1');
		expect(result).not.toBeNull();
		expect(result).toContain('Line one');
		expect(result).toContain('Line two');
		expect(result).toContain('Line three');
		expect(result).toContain('<agent-context-update reason="new experiences available">');
		expect(result).toContain('</agent-context-update>');
	});

	// ── 2. Token budget enforcement ──

	it('should enforce token budget during drain', () => {
		const queue = new LiveContextQueue();

		// Enqueue items totaling 1500 tokens
		queue.enqueue('s1', 'Big content A', 'new-experience', 500, ['m1']);
		queue.enqueue('s1', 'Big content B', 'new-experience', 500, ['m2']);
		queue.enqueue('s1', 'Big content C', 'new-experience', 500, ['m3']);

		// Drain with 750 budget → A (500) fits, B (500+500=1000>750) doesn't
		const result = queue.drain('s1', 750);
		expect(result).not.toBeNull();
		expect(result).toContain('Big content A');
		expect(result).not.toContain('Big content C');

		// Still has pending content
		expect(queue.hasContent('s1')).toBe(true);
	});

	// ── 3. Priority ordering ──

	it('should drain higher-priority sources first', () => {
		const queue = new LiveContextQueue();

		// Enqueue in reverse priority order
		queue.enqueue('s1', 'Monitoring item', 'monitoring', 100, ['m1']);
		queue.enqueue('s1', 'Cross-agent item', 'cross-agent', 100, ['m2']);

		const result = queue.drain('s1');
		expect(result).not.toBeNull();
		// cross-agent (priority 1) should appear before monitoring (priority 4)
		const crossIdx = result!.indexOf('Cross-agent item');
		const monIdx = result!.indexOf('Monitoring item');
		expect(crossIdx).toBeLessThan(monIdx);
	});

	// ── 4. Dedup — spawn-time IDs ──

	it('should skip enqueue when all memoryIds were already delivered at spawn time', () => {
		const queue = new LiveContextQueue();

		queue.markDelivered('s1', ['m1', 'm2']);
		queue.enqueue('s1', 'Already known', 'new-experience', 100, ['m1', 'm2']);

		expect(queue.hasContent('s1')).toBe(false);
	});

	// ── 5. Dedup — mid-session IDs ──

	it('should skip enqueue when all memoryIds were already drained mid-session', () => {
		const queue = new LiveContextQueue();

		queue.enqueue('s1', 'First delivery', 'new-experience', 100, ['m1']);
		queue.drain('s1');

		// Now try to enqueue the same IDs again
		queue.enqueue('s1', 'Duplicate delivery', 'new-experience', 100, ['m1']);
		expect(queue.hasContent('s1')).toBe(false);
	});

	// ── 6. Injection count cap ──

	it('should return null from drain when injection count cap reached', () => {
		mockConfig.liveInjectionMaxCount = 2;
		const queue = new LiveContextQueue();

		queue.enqueue('s1', 'First', 'new-experience', 50, ['m1']);
		expect(queue.drain('s1')).not.toBeNull();

		queue.enqueue('s1', 'Second', 'new-experience', 50, ['m2']);
		expect(queue.drain('s1')).not.toBeNull();

		queue.enqueue('s1', 'Third', 'new-experience', 50, ['m3']);
		expect(queue.drain('s1')).toBeNull();
	});

	// ── 7. Session token cap ──

	it('should stop draining when session token cap reached', () => {
		mockConfig.liveInjectionSessionCap = 1000;
		mockConfig.liveInjectionTokenBudget = 1000;
		const queue = new LiveContextQueue();

		queue.enqueue('s1', 'Big item', 'new-experience', 900, ['m1']);
		expect(queue.drain('s1')).not.toBeNull();

		// At 900 tokens, only 100 remaining budget
		queue.enqueue('s1', 'Too big', 'new-experience', 200, ['m2']);
		expect(queue.drain('s1')).toBeNull(); // 200 > 100 remaining
	});

	// ── 8. clearSession ──

	it('should clear all state for a session', () => {
		const queue = new LiveContextQueue();

		queue.enqueue('s1', 'Some content', 'monitoring', 100, ['m1']);
		expect(queue.hasContent('s1')).toBe(true);

		queue.clearSession('s1');
		expect(queue.hasContent('s1')).toBe(false);
		expect(queue.getWriteCount('s1')).toBe(0);
		expect(queue.getStats('s1')).toBeNull();
	});

	// ── 9. notifyWrite / getWriteCount ──

	it('should increment writeCount via notifyWrite', () => {
		const queue = new LiveContextQueue();
		expect(queue.getWriteCount('s1')).toBe(0);

		queue.notifyWrite('s1');
		queue.notifyWrite('s1');
		queue.notifyWrite('s1');

		expect(queue.getWriteCount('s1')).toBe(3);
	});

	// ── 10. hasContent O(1) semantics ──

	it('should return false for unknown session and true after enqueue', () => {
		const queue = new LiveContextQueue();

		expect(queue.hasContent('unknown-session')).toBe(false);

		queue.enqueue('s1', 'Content', 'monitoring', 50);
		expect(queue.hasContent('s1')).toBe(true);
	});

	// ── 11. Config check: enableLiveInjection=false ──

	it('should no-op enqueue when enableLiveInjection is false', async () => {
		mockConfig.enableLiveInjection = false;
		// Re-warm cache with disabled config
		_resetLiveContextQueue();
		await _warmConfigCache();
		const queue = new LiveContextQueue();

		queue.enqueue('s1', 'Should be ignored', 'monitoring', 100, ['m1']);
		expect(queue.hasContent('s1')).toBe(false);
	});

	// ── 12. XML format ──

	it('should wrap drained content in agent-context-update XML tags', () => {
		const queue = new LiveContextQueue();

		queue.enqueue('s1', 'Memory content here', 'new-experience', 50, ['m1']);

		const result = queue.drain('s1');
		expect(result).toBe(
			'<agent-context-update reason="new experiences available">\nMemory content here\n</agent-context-update>'
		);
	});

	// ── Singleton ──

	it('getLiveContextQueue returns singleton instance', () => {
		_resetLiveContextQueue();
		const a = getLiveContextQueue();
		const b = getLiveContextQueue();
		expect(a).toBe(b);
	});

	// ── getStats ──

	it('returns queue stats for a session', () => {
		const queue = new LiveContextQueue();

		queue.enqueue('s1', 'Item 1', 'monitoring', 100, ['m1']);
		queue.enqueue('s1', 'Item 2', 'new-experience', 200, ['m2']);

		const stats = queue.getStats('s1');
		expect(stats).toEqual({
			pendingCount: 2,
			pendingTokens: 300,
			injectionCount: 0,
			injectedTokens: 0,
		});

		queue.drain('s1');
		const statsAfter = queue.getStats('s1');
		expect(statsAfter).toEqual({
			pendingCount: 0,
			pendingTokens: 0,
			injectionCount: 1,
			injectedTokens: 300,
		});
	});
});
