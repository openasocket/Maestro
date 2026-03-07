/**
 * Tests for the persona shift and persona activation IPC handlers
 * in memory-handlers.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ipcMain } from 'electron';

// ─── Mock electron ───────────────────────────────────────────────────────────
vi.mock('electron', () => ({
	app: { getPath: vi.fn(() => '/tmp/test-app') },
	ipcMain: {
		handle: vi.fn(),
		removeHandler: vi.fn(),
	},
}));

// ─── Mock logger ─────────────────────────────────────────────────────────────
vi.mock('../../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

// ─── Mock embedding registry ─────────────────────────────────────────────────
vi.mock('../../../../main/grpo/embedding-registry', () => ({
	embeddingRegistry: {
		isReady: vi.fn(() => false),
		getStatus: vi.fn(() => ({ ready: false })),
	},
}));

// ─── Mock memory-injector with controllable persona data ─────────────────────
const mockGetRecentPersonaShifts = vi.fn();
const mockGetRecentPersonaActivations = vi.fn();

vi.mock('../../../../main/memory/memory-injector', () => ({
	setMemorySettingsStore: vi.fn(),
	loadPersistedInjectionRecords: vi.fn().mockResolvedValue(undefined),
	getSessionLastPersona: vi.fn(),
	getRecentPersonaShifts: (...args: unknown[]) => mockGetRecentPersonaShifts(...args),
	getRecentPersonaActivations: (...args: unknown[]) => mockGetRecentPersonaActivations(...args),
}));

// ─── Mock memory-store ───────────────────────────────────────────────────────
const mockMemoryStore = {
	getConfig: vi.fn().mockResolvedValue({ enabled: false }),
	setConfig: vi.fn().mockResolvedValue(undefined),
	cascadingSearch: vi.fn().mockResolvedValue([]),
	hybridSearch: vi.fn().mockResolvedValue([]),
	searchFlatScope: vi.fn().mockResolvedValue([]),
	recordInjection: vi.fn().mockResolvedValue(undefined),
	generateProjectDigest: vi.fn().mockResolvedValue(null),
	selectMatchingPersonas: vi.fn().mockResolvedValue([]),
	getMemoriesDir: vi.fn(() => '/tmp/test-memories'),
	getCachedRegistry: vi.fn().mockResolvedValue({}),
	listRoles: vi.fn().mockResolvedValue([]),
	listPersonas: vi.fn().mockResolvedValue([]),
	listSkillAreas: vi.fn().mockResolvedValue([]),
	listMemories: vi.fn().mockResolvedValue([]),
	getStats: vi.fn().mockResolvedValue({}),
	getRole: vi.fn().mockResolvedValue(null),
	getPersona: vi.fn().mockResolvedValue(null),
	getSkillArea: vi.fn().mockResolvedValue(null),
	getMemory: vi.fn().mockResolvedValue(null),
	createRole: vi.fn().mockResolvedValue({}),
	createPersona: vi.fn().mockResolvedValue({}),
	createSkillArea: vi.fn().mockResolvedValue({}),
	createMemory: vi.fn().mockResolvedValue({}),
	updateRole: vi.fn().mockResolvedValue({}),
	updatePersona: vi.fn().mockResolvedValue({}),
	updateSkillArea: vi.fn().mockResolvedValue({}),
	updateMemory: vi.fn().mockResolvedValue({}),
	deleteRole: vi.fn().mockResolvedValue(undefined),
	deletePersona: vi.fn().mockResolvedValue(undefined),
	deleteSkillArea: vi.fn().mockResolvedValue(undefined),
	deleteMemory: vi.fn().mockResolvedValue(undefined),
	exportAll: vi.fn().mockResolvedValue({}),
	importAll: vi.fn().mockResolvedValue(undefined),
	reembed: vi.fn().mockResolvedValue(undefined),
};

// ─── Import and register ─────────────────────────────────────────────────────
import { registerMemoryHandlers } from '../../../../main/ipc/handlers/memory-handlers';

describe('persona IPC handlers', () => {
	let handlers: Map<string, Function>;

	beforeEach(() => {
		vi.clearAllMocks();

		handlers = new Map();
		vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
			handlers.set(channel, handler);
		});

		const mockSettingsStore = {
			get: vi.fn().mockImplementation((_key: string, defaultValue: unknown) => defaultValue),
			set: vi.fn(),
		};

		registerMemoryHandlers({
			memoryStore: mockMemoryStore as any,
			settingsStore: mockSettingsStore as any,
		});
	});

	describe('memory:getPersonaShifts', () => {
		it('returns persona shift events from the ring buffer', async () => {
			const mockShifts = [
				{
					timestamp: 2000,
					sessionId: 'sess-2',
					fromPersona: { id: 'p1', name: 'Frontend', score: 0.7 },
					toPersona: { id: 'p2', name: 'Backend', score: 0.85 },
					triggerContext: 'discussing API endpoints',
				},
				{
					timestamp: 1000,
					sessionId: 'sess-1',
					fromPersona: { id: 'p2', name: 'Backend', score: 0.8 },
					toPersona: { id: 'p1', name: 'Frontend', score: 0.9 },
					triggerContext: 'component rendering',
				},
			];
			mockGetRecentPersonaShifts.mockReturnValue(mockShifts);

			const handler = handlers.get('memory:getPersonaShifts');
			expect(handler).toBeDefined();

			const result = await handler!({} as any, 10);

			expect(result).toEqual({ success: true, data: mockShifts });
			expect(mockGetRecentPersonaShifts).toHaveBeenCalledWith(10);
		});

		it('returns empty array when no shifts exist', async () => {
			mockGetRecentPersonaShifts.mockReturnValue([]);

			const handler = handlers.get('memory:getPersonaShifts');
			const result = await handler!({} as any);

			expect(result).toEqual({ success: true, data: [] });
		});
	});

	describe('memory:getPersonaActivations', () => {
		it('returns persona activation events from the ring buffer', async () => {
			const mockActivations = [
				{
					timestamp: 3000,
					sessionId: 'sess-3',
					persona: { id: 'p1', name: 'React Frontend', score: 0.9 },
					triggerContext: 'jsx component work',
					type: 'activation' as const,
				},
			];
			mockGetRecentPersonaActivations.mockReturnValue(mockActivations);

			const handler = handlers.get('memory:getPersonaActivations');
			expect(handler).toBeDefined();

			const result = await handler!({} as any, 5);

			expect(result).toEqual({ success: true, data: mockActivations });
			expect(mockGetRecentPersonaActivations).toHaveBeenCalledWith(5);
		});

		it('returns empty array when no activations exist', async () => {
			mockGetRecentPersonaActivations.mockReturnValue([]);

			const handler = handlers.get('memory:getPersonaActivations');
			const result = await handler!({} as any);

			expect(result).toEqual({ success: true, data: [] });
		});
	});
});
