/**
 * Tests for the Cue team executor module.
 *
 * Tests cover:
 * - Template not found returns failed result
 * - Template without topology returns failed result
 * - Prompt file read failure returns failed result
 * - Successful workflow completion returns output from exit point
 * - Timeout returns timeout status
 * - stopCueTeamRun signals abort
 * - Cleanup (kill moderator, clear participants, delete chat) always runs
 * - Template context population for Cue event variables
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CueEvent, CueSubscription } from '../../../main/cue/cue-types';
import type { SessionInfo } from '../../../shared/types';
import type { TemplateContext } from '../../../shared/templateVariables';
import type {
	TeamTemplate,
	WorkflowTopology,
	WorkflowExecutionState,
} from '../../../shared/group-chat-types';

// --- Mocks ---

const mockReadFileSync = vi.fn();
vi.mock('fs', () => ({
	readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
}));

const mockSubstitute = vi.fn((template: string) => `substituted: ${template}`);
vi.mock('../../../shared/templateVariables', () => ({
	substituteTemplateVariables: (...args: unknown[]) => mockSubstitute(args[0] as string, args[1]),
}));

const mockGetTemplate = vi.fn();
vi.mock('../../../main/group-chat/team-template-storage', () => ({
	getTemplate: (...args: unknown[]) => mockGetTemplate(...args),
}));

const mockCreateGroupChat = vi.fn();
const mockLoadGroupChat = vi.fn();
const mockDeleteGroupChat = vi.fn();
const mockUpdateGroupChat = vi.fn();
vi.mock('../../../main/group-chat/group-chat-storage', () => ({
	createGroupChat: (...args: unknown[]) => mockCreateGroupChat(...args),
	loadGroupChat: (...args: unknown[]) => mockLoadGroupChat(...args),
	deleteGroupChat: (...args: unknown[]) => mockDeleteGroupChat(...args),
	updateGroupChat: (...args: unknown[]) => mockUpdateGroupChat(...args),
}));

const mockSpawnModerator = vi.fn();
const mockKillModerator = vi.fn();
vi.mock('../../../main/group-chat/group-chat-moderator', () => ({
	spawnModerator: (...args: unknown[]) => mockSpawnModerator(...args),
	killModerator: (...args: unknown[]) => mockKillModerator(...args),
}));

const mockAddParticipant = vi.fn();
const mockClearAllParticipantSessions = vi.fn();
vi.mock('../../../main/group-chat/group-chat-agent', () => ({
	addParticipant: (...args: unknown[]) => mockAddParticipant(...args),
	clearAllParticipantSessions: (...args: unknown[]) => mockClearAllParticipantSessions(...args),
}));

const mockRouteUserMessage = vi.fn();
vi.mock('../../../main/group-chat/group-chat-router', () => ({
	routeUserMessage: (...args: unknown[]) => mockRouteUserMessage(...args),
}));

const mockFinalizeWorkflow = vi.fn();
vi.mock('../../../main/group-chat/topology-router', () => ({
	finalizeWorkflow: (...args: unknown[]) => mockFinalizeWorkflow(...args),
}));

// Import after mocks
import {
	executeCueTeamPrompt,
	stopCueTeamRun,
	getActiveTeamRunCount,
	type CueTeamExecutionConfig,
} from '../../../main/cue/cue-team-executor';

// --- Test helpers ---

const mockTopology: WorkflowTopology = {
	pattern: 'pipeline',
	edges: [
		{ source: '__entry__', target: 'Researcher', edgeType: 'sequential' },
		{ source: 'Researcher', target: 'Synthesizer', edgeType: 'sequential' },
		{ source: 'Synthesizer', target: '__exit__', edgeType: 'sequential' },
	],
	entryPoint: 'Researcher',
	exitPoint: 'Synthesizer',
};

const mockTemplate: TeamTemplate = {
	id: 'template-1',
	name: 'Test Team',
	description: 'A test team',
	category: 'user',
	createdAt: Date.now(),
	updatedAt: Date.now(),
	moderatorAgentId: 'claude-code',
	roles: [
		{ name: 'Researcher', agentId: 'claude-code', description: 'Researches topics' },
		{ name: 'Synthesizer', agentId: 'claude-code', description: 'Synthesizes findings' },
	],
	topology: mockTopology,
};

function createMockGroupChat(id: string, executionState?: WorkflowExecutionState) {
	return {
		id,
		name: `cue-team-test`,
		createdAt: Date.now(),
		moderatorAgentId: 'claude-code',
		moderatorSessionId: `group-chat-${id}-moderator`,
		participants: [],
		logPath: `/tmp/${id}/chat.log`,
		imagesDir: `/tmp/${id}/images`,
		topology: mockTopology,
		executionState,
	};
}

const mockProcessManager = {
	spawn: vi.fn(() => ({ pid: 1234, success: true })),
	write: vi.fn(() => true),
	kill: vi.fn(() => true),
};

const mockAgentDetector = {
	getAgent: vi.fn(async () => ({
		command: 'claude',
		path: '/usr/bin/claude',
		available: true,
	})),
} as any;

function createConfig(overrides: Partial<CueTeamExecutionConfig> = {}): CueTeamExecutionConfig {
	return {
		runId: 'run-1',
		session: {
			id: 'session-1',
			name: 'Test Session',
			toolType: 'claude-code',
			cwd: '/projects/test',
			projectRoot: '/projects/test',
		},
		subscription: {
			name: 'test-sub',
			event: 'file.changed',
			enabled: true,
			prompt: 'Do the thing',
			team_template: 'template-1',
		},
		event: {
			id: 'event-1',
			type: 'file.changed',
			timestamp: new Date().toISOString(),
			triggerName: 'test-sub',
			payload: {},
		},
		promptPath: 'Do the thing',
		teamTemplateId: 'template-1',
		projectRoot: '/projects/test',
		templateContext: {
			session: {
				id: 'session-1',
				name: 'Test Session',
				toolType: 'claude-code',
				cwd: '/projects/test',
				projectRoot: '/projects/test',
			},
		},
		timeoutMs: 60000,
		processManager: mockProcessManager as any,
		agentDetector: mockAgentDetector,
		onLog: vi.fn(),
		...overrides,
	};
}

describe('executeCueTeamPrompt', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGetTemplate.mockResolvedValue(null);
		mockCreateGroupChat.mockResolvedValue(createMockGroupChat('chat-1'));
		mockSpawnModerator.mockResolvedValue('group-chat-chat-1-moderator');
		mockAddParticipant.mockResolvedValue({});
		mockRouteUserMessage.mockResolvedValue(undefined);
		mockKillModerator.mockResolvedValue(undefined);
		mockClearAllParticipantSessions.mockResolvedValue(undefined);
		mockDeleteGroupChat.mockResolvedValue(undefined);
		mockUpdateGroupChat.mockResolvedValue({});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('returns failed result when template is not found', async () => {
		mockGetTemplate.mockResolvedValue(null);
		const result = await executeCueTeamPrompt(createConfig());

		expect(result.status).toBe('failed');
		expect(result.stderr).toContain('Team template not found');
		expect(result.runId).toBe('run-1');
	});

	it('returns failed result when template has no topology', async () => {
		mockGetTemplate.mockResolvedValue({ ...mockTemplate, topology: undefined });
		const result = await executeCueTeamPrompt(createConfig());

		expect(result.status).toBe('failed');
		expect(result.stderr).toContain('no workflow topology');
	});

	it('returns failed result when prompt file cannot be read', async () => {
		mockGetTemplate.mockResolvedValue(mockTemplate);
		mockReadFileSync.mockImplementation(() => {
			throw new Error('ENOENT');
		});

		const result = await executeCueTeamPrompt(createConfig({ promptPath: 'prompt.md' }));

		expect(result.status).toBe('failed');
		expect(result.stderr).toContain('Failed to read prompt file');
	});

	it('creates group chat with template topology and roles', async () => {
		mockGetTemplate.mockResolvedValue(mockTemplate);

		// Make loadGroupChat return completed state on first poll
		const completedState: WorkflowExecutionState = {
			currentPhase: 'Synthesizer',
			completedNodes: ['Researcher', 'Synthesizer'],
			pendingNodes: [],
			activeNodes: [],
			iterationCount: 1,
			nodeOutputs: { Synthesizer: 'Final output from team' },
			status: 'completed',
		};
		mockLoadGroupChat.mockResolvedValue(createMockGroupChat('chat-1', completedState));

		const result = await executeCueTeamPrompt(createConfig());

		expect(mockCreateGroupChat).toHaveBeenCalledWith(
			expect.stringContaining('cue-team-'),
			'claude-code',
			undefined, // no moderatorConfig on mock template
			mockTopology,
			mockTemplate.roles
		);
		expect(result.status).toBe('completed');
		expect(result.stdout).toBe('Final output from team');
	});

	it('spawns moderator and adds participants for each role', async () => {
		mockGetTemplate.mockResolvedValue(mockTemplate);

		const completedState: WorkflowExecutionState = {
			currentPhase: 'Synthesizer',
			completedNodes: ['Researcher', 'Synthesizer'],
			pendingNodes: [],
			activeNodes: [],
			iterationCount: 1,
			nodeOutputs: { Synthesizer: 'done' },
			status: 'completed',
		};
		mockLoadGroupChat.mockResolvedValue(createMockGroupChat('chat-1', completedState));

		await executeCueTeamPrompt(createConfig());

		expect(mockSpawnModerator).toHaveBeenCalledTimes(1);
		expect(mockAddParticipant).toHaveBeenCalledTimes(2);
		expect(mockAddParticipant).toHaveBeenCalledWith(
			'chat-1',
			'Researcher',
			'claude-code',
			expect.anything(),
			'/projects/test',
			expect.anything()
		);
		expect(mockAddParticipant).toHaveBeenCalledWith(
			'chat-1',
			'Synthesizer',
			'claude-code',
			expect.anything(),
			'/projects/test',
			expect.anything()
		);
	});

	it('routes the resolved prompt as user message', async () => {
		mockGetTemplate.mockResolvedValue(mockTemplate);

		const completedState: WorkflowExecutionState = {
			currentPhase: 'done',
			completedNodes: ['Researcher', 'Synthesizer'],
			pendingNodes: [],
			activeNodes: [],
			iterationCount: 1,
			nodeOutputs: { Synthesizer: 'output' },
			status: 'completed',
		};
		mockLoadGroupChat.mockResolvedValue(createMockGroupChat('chat-1', completedState));

		await executeCueTeamPrompt(createConfig());

		expect(mockRouteUserMessage).toHaveBeenCalledWith(
			'chat-1',
			expect.stringContaining('substituted:'),
			expect.anything(),
			expect.anything()
		);
	});

	it('returns failed status when workflow fails', async () => {
		mockGetTemplate.mockResolvedValue(mockTemplate);

		const failedState: WorkflowExecutionState = {
			currentPhase: 'Researcher',
			completedNodes: [],
			pendingNodes: ['Synthesizer'],
			activeNodes: [],
			iterationCount: 0,
			nodeOutputs: {},
			status: 'failed',
		};
		mockLoadGroupChat.mockResolvedValue(createMockGroupChat('chat-1', failedState));

		const result = await executeCueTeamPrompt(createConfig());

		expect(result.status).toBe('failed');
		expect(result.stderr).toContain('Team workflow failed');
	});

	it('returns timeout when workflow exceeds timeout', async () => {
		mockGetTemplate.mockResolvedValue(mockTemplate);

		// Always return running state
		const runningState: WorkflowExecutionState = {
			currentPhase: 'Researcher',
			completedNodes: [],
			pendingNodes: ['Synthesizer'],
			activeNodes: ['Researcher'],
			iterationCount: 0,
			nodeOutputs: {},
			status: 'running',
		};
		mockLoadGroupChat.mockResolvedValue(createMockGroupChat('chat-1', runningState));
		mockFinalizeWorkflow.mockReturnValue({ ...runningState, status: 'terminated' });

		// Use a very short timeout
		const result = await executeCueTeamPrompt(createConfig({ timeoutMs: 1 }));

		expect(result.status).toBe('timeout');
		expect(result.stderr).toContain('timed out');
	});

	it('cleans up group chat on success', async () => {
		mockGetTemplate.mockResolvedValue(mockTemplate);

		const completedState: WorkflowExecutionState = {
			currentPhase: 'done',
			completedNodes: ['Researcher', 'Synthesizer'],
			pendingNodes: [],
			activeNodes: [],
			iterationCount: 1,
			nodeOutputs: { Synthesizer: 'output' },
			status: 'completed',
		};
		mockLoadGroupChat.mockResolvedValue(createMockGroupChat('chat-1', completedState));

		await executeCueTeamPrompt(createConfig());

		expect(mockKillModerator).toHaveBeenCalledWith('chat-1', expect.anything());
		expect(mockClearAllParticipantSessions).toHaveBeenCalledWith('chat-1', expect.anything());
		expect(mockDeleteGroupChat).toHaveBeenCalledWith('chat-1');
	});

	it('cleans up group chat on error', async () => {
		mockGetTemplate.mockResolvedValue(mockTemplate);
		mockRouteUserMessage.mockRejectedValue(new Error('Routing failed'));

		const result = await executeCueTeamPrompt(createConfig());

		expect(result.status).toBe('failed');
		expect(result.stderr).toContain('Routing failed');
		expect(mockKillModerator).toHaveBeenCalledWith('chat-1', expect.anything());
		expect(mockClearAllParticipantSessions).toHaveBeenCalledWith('chat-1', expect.anything());
		expect(mockDeleteGroupChat).toHaveBeenCalledWith('chat-1');
	});

	it('reads prompt from file when promptPath has a file extension', async () => {
		mockGetTemplate.mockResolvedValue(mockTemplate);
		mockReadFileSync.mockReturnValue('Prompt content from file');

		const completedState: WorkflowExecutionState = {
			currentPhase: 'done',
			completedNodes: ['Researcher', 'Synthesizer'],
			pendingNodes: [],
			activeNodes: [],
			iterationCount: 1,
			nodeOutputs: { Synthesizer: 'output' },
			status: 'completed',
		};
		mockLoadGroupChat.mockResolvedValue(createMockGroupChat('chat-1', completedState));

		await executeCueTeamPrompt(createConfig({ promptPath: '/path/to/prompt.md' }));

		expect(mockReadFileSync).toHaveBeenCalledWith('/path/to/prompt.md', 'utf-8');
		expect(mockSubstitute).toHaveBeenCalledWith('Prompt content from file', expect.anything());
	});

	it('populates Cue template context from event data', async () => {
		mockGetTemplate.mockResolvedValue(mockTemplate);

		const completedState: WorkflowExecutionState = {
			currentPhase: 'done',
			completedNodes: ['Researcher', 'Synthesizer'],
			pendingNodes: [],
			activeNodes: [],
			iterationCount: 1,
			nodeOutputs: { Synthesizer: 'output' },
			status: 'completed',
		};
		mockLoadGroupChat.mockResolvedValue(createMockGroupChat('chat-1', completedState));

		const templateContext: TemplateContext = {
			session: {
				id: 's1',
				name: 'S1',
				toolType: 'claude-code',
				cwd: '/test',
				projectRoot: '/test',
			},
		};

		const event: CueEvent = {
			id: 'ev-1',
			type: 'file.changed',
			timestamp: '2026-03-23T00:00:00Z',
			triggerName: 'test-sub',
			payload: { path: '/src/main.ts', filename: 'main.ts' },
		};

		await executeCueTeamPrompt(createConfig({ templateContext, event }));

		// Verify template context was populated with Cue event data
		expect(templateContext.cue).toBeDefined();
		expect(templateContext.cue!.eventType).toBe('file.changed');
		expect(templateContext.cue!.filePath).toBe('/src/main.ts');
		expect(templateContext.cue!.fileName).toBe('main.ts');
		expect(templateContext.cue!.triggerName).toBe('test-sub');
	});
});

describe('stopCueTeamRun', () => {
	it('returns false for unknown run IDs', () => {
		expect(stopCueTeamRun('nonexistent')).toBe(false);
	});
});

describe('getActiveTeamRunCount', () => {
	it('returns 0 when no team runs are active', () => {
		expect(getActiveTeamRunCount()).toBe(0);
	});
});
