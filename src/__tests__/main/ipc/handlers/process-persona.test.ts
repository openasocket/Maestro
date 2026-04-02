/**
 * Tests for the persona matching fast-path in process:write.
 *
 * Validates that when embedding service is not ready, the persona
 * matching block skips gracefully without throwing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ipcMain } from 'electron';
import {
	registerProcessHandlers,
	ProcessHandlerDependencies,
} from '../../../../main/ipc/handlers/process';

// Mock electron
vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn(),
		removeHandler: vi.fn(),
	},
}));

// Mock logger
vi.mock('../../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

// Mock agent-args
vi.mock('../../../../main/utils/agent-args', () => ({
	buildAgentArgs: vi.fn((_agent: unknown, opts: { baseArgs?: string[] }) => opts.baseArgs || []),
	applyAgentConfigOverrides: vi.fn(() => ({
		args: [],
		modelSource: 'none' as const,
		customArgsSource: 'none' as const,
		customEnvSource: 'none' as const,
		effectiveCustomEnvVars: undefined,
	})),
	getContextWindowValue: vi.fn(() => 0),
}));

// Mock node-pty
vi.mock('node-pty', () => ({
	spawn: vi.fn(),
}));

// Mock streamJsonBuilder
vi.mock('../../../../main/process-manager/utils/streamJsonBuilder', () => ({
	buildStreamJsonMessage: vi.fn(),
}));

// Mock ssh-command-builder
vi.mock('../../../../main/utils/ssh-command-builder', () => ({
	buildSshCommandWithStdin: vi.fn(),
	buildSshCommand: vi.fn(),
	buildRemoteCommand: vi.fn(),
}));

// ─── Embedding service mock ──────────────────────────────────────────────────
const mockIsReady = vi.fn();

vi.mock('../../../../main/grpo/embedding-service', () => ({
	isReady: (...args: unknown[]) => mockIsReady(...args),
}));

// ─── Live context queue mock (avoid side effects) ────────────────────────────
vi.mock('../../../../main/memory/live-context-queue', () => ({
	getLiveContextQueue: () => ({
		hasContent: () => false,
		notifyWrite: () => {},
		drain: () => null,
	}),
}));

describe('process:write persona embedding fast-path', () => {
	let handlers: Map<string, Function>;
	let mockProcessManager: Record<string, ReturnType<typeof vi.fn>>;

	beforeEach(() => {
		vi.clearAllMocks();

		mockProcessManager = {
			spawn: vi.fn(),
			write: vi.fn().mockReturnValue(true),
			interrupt: vi.fn(),
			kill: vi.fn(),
			resize: vi.fn(),
			getAll: vi.fn(),
			runCommand: vi.fn(),
			get: vi.fn(),
		};

		const deps: ProcessHandlerDependencies = {
			getProcessManager: () => mockProcessManager as any,
			getAgentDetector: () => ({ getAgent: vi.fn() }) as any,
			agentConfigsStore: { get: vi.fn().mockReturnValue({}), set: vi.fn() } as any,
			settingsStore: {
				get: vi.fn().mockImplementation((_key: string, defaultValue: unknown) => defaultValue),
				set: vi.fn(),
			} as any,
			getMainWindow: () =>
				({
					isDestroyed: vi.fn().mockReturnValue(false),
					webContents: { send: vi.fn(), isDestroyed: vi.fn().mockReturnValue(false) },
				}) as any,
		};

		handlers = new Map();
		vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
			handlers.set(channel, handler);
		});

		registerProcessHandlers(deps);
	});

	it('skips persona evaluation without throwing when embedding is not ready', async () => {
		// Simulate a running process with project path (triggers persona matching path)
		mockProcessManager.get.mockReturnValue({
			toolType: 'claude-code',
			projectPath: '/test/project',
			sshRemoteId: undefined,
		});

		// Embedding is NOT ready
		mockIsReady.mockReturnValue(false);

		const handler = handlers.get('process:write');

		// Write a prompt longer than 20 chars to trigger persona evaluation path
		const result = await handler!(
			{} as any,
			'session-1',
			'This is a long enough prompt for persona matching'
		);

		// Should succeed without throwing
		expect(result).toBe(true);
		expect(mockProcessManager.write).toHaveBeenCalledWith(
			'session-1',
			'This is a long enough prompt for persona matching'
		);
	});

	it('passes through short prompts without persona evaluation', async () => {
		mockProcessManager.get.mockReturnValue({
			toolType: 'claude-code',
			projectPath: '/test/project',
			sshRemoteId: undefined,
		});

		const handler = handlers.get('process:write');

		// Short prompt (<=20 chars) should skip persona block entirely
		const result = await handler!({} as any, 'session-1', 'short');

		expect(result).toBe(true);
		// isReady should not even be called for short prompts
		expect(mockIsReady).not.toHaveBeenCalled();
	});
});
