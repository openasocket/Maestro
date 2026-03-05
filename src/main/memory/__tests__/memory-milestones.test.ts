/**
 * Tests for memory milestone detection and notification (MEM-EVOLVE-08).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock electron BrowserWindow before importing the module
vi.mock('electron', () => ({
	BrowserWindow: {
		getAllWindows: vi.fn(() => []),
	},
}));

import { checkMemoryMilestones } from '../memory-milestones';
import type { MemoryConfig, MemoryStats } from '../../../shared/memory-types';
import { MEMORY_CONFIG_DEFAULTS } from '../../../shared/memory-types';
import { BrowserWindow } from 'electron';

function makeConfig(overrides?: Partial<MemoryConfig>): MemoryConfig {
	return { ...MEMORY_CONFIG_DEFAULTS, ...overrides };
}

function makeStats(overrides?: Partial<MemoryStats>): MemoryStats {
	return {
		totalRoles: 1,
		totalPersonas: 1,
		totalSkillAreas: 2,
		totalMemories: 5,
		byScope: { global: 0, role: 0, persona: 0, skill: 3, project: 2 },
		bySource: {
			manual: 0,
			'auto-generated': 0,
			consolidation: 0,
			'session-analysis': 5,
			migration: 0,
		},
		byType: { rule: 0, preference: 0, experience: 5, context: 0 },
		totalInjections: 0,
		averageEffectiveness: 0,
		pendingEmbeddings: 0,
		effectivenessDistribution: { high: 0, medium: 0, low: 0, unscored: 5 },
		recentInjections: 0,
		promotionCandidates: 0,
		archivedCount: 0,
		byCategory: {},
		...overrides,
	} as MemoryStats;
}

function createMockStore(config: MemoryConfig, stats: MemoryStats) {
	const savedConfigs: Partial<MemoryConfig>[] = [];
	return {
		store: {
			getConfig: vi.fn(async () => config),
			setConfig: vi.fn(async (updates: Partial<MemoryConfig>) => {
				Object.assign(config, updates);
				savedConfigs.push(updates);
				return config;
			}),
			getAnalytics: vi.fn(async () => stats),
		},
		savedConfigs,
	};
}

function createMockWindow() {
	const sent: { channel: string; data: unknown }[] = [];
	return {
		window: {
			isDestroyed: () => false,
			webContents: {
				isDestroyed: () => false,
				send: (channel: string, data: unknown) => sent.push({ channel, data }),
			},
		} as unknown as Electron.BrowserWindow,
		sent,
	};
}

describe('checkMemoryMilestones', () => {
	beforeEach(() => {
		vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([]);
	});

	it('does nothing when no milestones are pending', async () => {
		const config = makeConfig({ memoryMilestonesShown: [10, 50, 100, 200] });
		const stats = makeStats({
			totalMemories: 100,
			byType: { rule: 10, preference: 0, experience: 90, context: 0 },
		});
		const { store } = createMockStore(config, stats);

		await checkMemoryMilestones(store, 'experience-count');

		expect(store.getAnalytics).not.toHaveBeenCalled();
		expect(store.setConfig).not.toHaveBeenCalled();
	});

	it('triggers 10-experience milestone when threshold reached', async () => {
		const { window, sent } = createMockWindow();
		vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([window]);

		const config = makeConfig({ memoryMilestonesShown: [] });
		const stats = makeStats({
			totalMemories: 12,
			byType: { rule: 0, preference: 0, experience: 12, context: 0 },
		});
		const { store } = createMockStore(config, stats);

		await checkMemoryMilestones(store, 'experience-count');

		expect(store.setConfig).toHaveBeenCalledWith({
			memoryMilestonesShown: [10],
		});
		expect(sent).toHaveLength(1);
		expect(sent[0].channel).toBe('memory:milestone');
		expect(sent[0].data).toMatchObject({
			id: 10,
			title: 'Learning Milestone',
			type: 'success',
		});
	});

	it('triggers 50-memory milestone when threshold reached', async () => {
		const { window, sent } = createMockWindow();
		vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([window]);

		const config = makeConfig({ memoryMilestonesShown: [10] });
		const stats = makeStats({
			totalMemories: 55,
			byType: { rule: 5, preference: 0, experience: 50, context: 0 },
		});
		const { store } = createMockStore(config, stats);

		await checkMemoryMilestones(store, 'experience-count');

		expect(store.setConfig).toHaveBeenCalledWith({
			memoryMilestonesShown: [10, 50],
		});
		expect(sent).toHaveLength(1);
		expect(sent[0].data).toMatchObject({ id: 50 });
	});

	it('triggers promotion milestone on promotion trigger', async () => {
		const { window, sent } = createMockWindow();
		vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([window]);

		const config = makeConfig({ memoryMilestonesShown: [10] });
		const stats = makeStats({ totalMemories: 15 });
		const { store } = createMockStore(config, stats);

		await checkMemoryMilestones(store, 'promotion');

		expect(sent).toHaveLength(1);
		expect(sent[0].data).toMatchObject({ id: 100, title: 'First Rule Created' });
	});

	it('triggers cross-project milestone on evidence trigger', async () => {
		const { window, sent } = createMockWindow();
		vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([window]);

		const config = makeConfig({ memoryMilestonesShown: [] });
		const stats = makeStats({
			totalMemories: 5,
			byType: { rule: 0, preference: 0, experience: 5, context: 0 },
		});
		const { store } = createMockStore(config, stats);

		await checkMemoryMilestones(store, 'cross-project-evidence');

		// Should trigger cross-project (200) but not experience (5 < 10) or memories (5 < 50)
		expect(store.setConfig).toHaveBeenCalledWith({
			memoryMilestonesShown: [200],
		});
		expect(sent).toHaveLength(1);
		expect(sent[0].data).toMatchObject({ id: 200 });
	});

	it('triggers multiple milestones simultaneously', async () => {
		const { window, sent } = createMockWindow();
		vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([window]);

		const config = makeConfig({ memoryMilestonesShown: [] });
		const stats = makeStats({
			totalMemories: 60,
			byType: { rule: 0, preference: 0, experience: 60, context: 0 },
		});
		const { store } = createMockStore(config, stats);

		await checkMemoryMilestones(store, 'experience-count');

		// Should trigger both 10-experience and 50-memory milestones
		expect(store.setConfig).toHaveBeenCalledWith({
			memoryMilestonesShown: [10, 50],
		});
		expect(sent).toHaveLength(2);
	});

	it('does not re-trigger already shown milestones', async () => {
		const { window, sent } = createMockWindow();
		vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([window]);

		const config = makeConfig({ memoryMilestonesShown: [10] });
		const stats = makeStats({
			totalMemories: 12,
			byType: { rule: 0, preference: 0, experience: 12, context: 0 },
		});
		const { store } = createMockStore(config, stats);

		await checkMemoryMilestones(store, 'experience-count');

		// 10-experience already shown, 50-memory not reached
		expect(store.setConfig).not.toHaveBeenCalled();
		expect(sent).toHaveLength(0);
	});

	it('sends to multiple windows', async () => {
		const mock1 = createMockWindow();
		const mock2 = createMockWindow();
		vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([mock1.window, mock2.window]);

		const config = makeConfig({ memoryMilestonesShown: [] });
		const stats = makeStats({
			totalMemories: 15,
			byType: { rule: 0, preference: 0, experience: 15, context: 0 },
		});
		const { store } = createMockStore(config, stats);

		await checkMemoryMilestones(store, 'experience-count');

		expect(mock1.sent).toHaveLength(1);
		expect(mock2.sent).toHaveLength(1);
	});
});
