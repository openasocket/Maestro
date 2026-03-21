/**
 * Tests for Team Orchestration event CRUD operations, aggregation, and history.
 *
 * Uses mocked database operations following the same pattern as query-events.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';

// Store mock references so they can be accessed in tests
const mockStatement = {
	run: vi.fn(() => ({ changes: 1 })),
	get: vi.fn(() => ({ count: 0, total_duration: 0 })),
	all: vi.fn(() => []),
};

const mockDb = {
	pragma: vi.fn(() => [{ user_version: 0 }]),
	prepare: vi.fn(() => mockStatement),
	close: vi.fn(),
	transaction: vi.fn((fn: () => void) => {
		return () => fn();
	}),
};

vi.mock('better-sqlite3', () => {
	return {
		default: class MockDatabase {
			constructor(_dbPath: string) {}
			pragma = mockDb.pragma;
			prepare = mockDb.prepare;
			close = mockDb.close;
			transaction = mockDb.transaction;
		},
	};
});

const mockUserDataPath = path.join(os.tmpdir(), 'maestro-test-team-orch');
vi.mock('electron', () => ({
	app: {
		getPath: vi.fn((name: string) => {
			if (name === 'userData') return mockUserDataPath;
			return os.tmpdir();
		}),
	},
}));

vi.mock('fs', () => ({
	existsSync: vi.fn(() => true),
	mkdirSync: vi.fn(),
	copyFileSync: vi.fn(),
	unlinkSync: vi.fn(),
	renameSync: vi.fn(),
	statSync: vi.fn(() => ({ size: 1024 })),
	readFileSync: vi.fn(() => '0'),
	writeFileSync: vi.fn(),
	readdirSync: vi.fn(() => []),
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

import type { TeamOrchEvent, TeamOrchHistoryQuery } from '../../../shared/team-orch-stats-types';

function makeTestEvent(overrides?: Partial<TeamOrchEvent>): TeamOrchEvent {
	return {
		id: 'test-event-1',
		groupChatId: 'gc-1',
		groupChatName: 'Test Group Chat',
		templateId: 'tmpl-1',
		templateName: 'Design Review',
		topologyPattern: 'hub-spoke',
		terminationMode: 'iteration-limit',
		status: 'completed',
		iterationCount: 3,
		maxIterations: 5,
		startTime: Date.now() - 60000,
		endTime: Date.now(),
		duration: 60000,
		participantCount: 3,
		participantBreakdown: [
			{
				name: 'Agent A',
				agentId: 'agent-a',
				tokenCount: 1000,
				messageCount: 5,
				processingTimeMs: 20000,
				cost: 0.05,
			},
			{
				name: 'Agent B',
				agentId: 'agent-b',
				tokenCount: 800,
				messageCount: 4,
				processingTimeMs: 15000,
				cost: 0.04,
			},
			{
				name: 'Agent C',
				agentId: 'agent-c',
				tokenCount: 600,
				messageCount: 3,
				processingTimeMs: 10000,
				cost: 0.03,
			},
		],
		totalTokens: 2400,
		totalCost: 0.12,
		moderatorAgentId: 'agent-a',
		projectPath: '/test/project',
		...overrides,
	};
}

describe('Team Orchestration Events - Insert', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockDb.pragma.mockReturnValue([{ user_version: 0 }]);
		mockDb.prepare.mockReturnValue(mockStatement);
		mockStatement.run.mockReturnValue({ changes: 1 });
		mockStatement.all.mockReturnValue([]);
	});

	afterEach(() => {
		vi.resetModules();
	});

	it('should insert a team orch event with all fields', async () => {
		const { StatsDB } = await import('../../../main/stats');
		const db = new StatsDB();
		db.initialize();

		const event = makeTestEvent();
		db.insertTeamOrchEvent(event);

		// Verify INSERT was called
		const runCalls = mockStatement.run.mock.calls;
		const lastCall = runCalls[runCalls.length - 1];

		expect(lastCall[0]).toBe('test-event-1'); // id
		expect(lastCall[1]).toBe('gc-1'); // group_chat_id
		expect(lastCall[2]).toBe('Test Group Chat'); // group_chat_name
		expect(lastCall[3]).toBe('tmpl-1'); // template_id
		expect(lastCall[4]).toBe('Design Review'); // template_name
		expect(lastCall[5]).toBe('hub-spoke'); // topology_pattern
		expect(lastCall[6]).toBe('iteration-limit'); // termination_mode
		expect(lastCall[7]).toBe('completed'); // status
		expect(lastCall[8]).toBe(3); // iteration_count
		expect(lastCall[9]).toBe(5); // max_iterations
		expect(lastCall[14]).toBe(JSON.stringify(event.participantBreakdown)); // participant_breakdown
		expect(lastCall[15]).toBe(2400); // total_tokens
		expect(lastCall[16]).toBe(0.12); // total_cost
		expect(lastCall[17]).toBe('agent-a'); // moderator_agent_id
		expect(lastCall[18]).toBe('/test/project'); // project_path
	});

	it('should insert event with optional fields as null', async () => {
		const { StatsDB } = await import('../../../main/stats');
		const db = new StatsDB();
		db.initialize();

		const event = makeTestEvent({
			templateId: undefined,
			templateName: undefined,
			projectPath: undefined,
		});
		db.insertTeamOrchEvent(event);

		const runCalls = mockStatement.run.mock.calls;
		const lastCall = runCalls[runCalls.length - 1];

		expect(lastCall[3]).toBeNull(); // template_id
		expect(lastCall[4]).toBeNull(); // template_name
		expect(lastCall[18]).toBeNull(); // project_path
	});

	it('should serialize participantBreakdown as JSON', async () => {
		const { StatsDB } = await import('../../../main/stats');
		const db = new StatsDB();
		db.initialize();

		const event = makeTestEvent();
		db.insertTeamOrchEvent(event);

		const runCalls = mockStatement.run.mock.calls;
		const lastCall = runCalls[runCalls.length - 1];
		const stored = lastCall[14];

		expect(typeof stored).toBe('string');
		const parsed = JSON.parse(stored);
		expect(parsed).toHaveLength(3);
		expect(parsed[0].agentId).toBe('agent-a');
		expect(parsed[1].tokenCount).toBe(800);
	});
});

describe('Team Orchestration Events - History', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockDb.pragma.mockReturnValue([{ user_version: 0 }]);
		mockDb.prepare.mockReturnValue(mockStatement);
		mockStatement.run.mockReturnValue({ changes: 1 });
	});

	afterEach(() => {
		vi.resetModules();
	});

	it('should retrieve paginated history', async () => {
		const now = Date.now();
		// First call is COUNT, second is SELECT
		mockStatement.get.mockReturnValue({ total: 2 });
		mockStatement.all.mockReturnValue([
			{
				id: 'evt-1',
				group_chat_id: 'gc-1',
				group_chat_name: 'Chat A',
				template_id: null,
				template_name: null,
				topology_pattern: 'hub-spoke',
				termination_mode: 'iteration-limit',
				status: 'completed',
				iteration_count: 3,
				max_iterations: 5,
				start_time: now - 10000,
				end_time: now,
				duration: 10000,
				participant_count: 2,
				participant_breakdown: '[]',
				total_tokens: 500,
				total_cost: 0.05,
				moderator_agent_id: 'agent-x',
				project_path: null,
			},
		]);

		const { StatsDB } = await import('../../../main/stats');
		const db = new StatsDB();
		db.initialize();

		const result = db.getTeamOrchHistory({ offset: 0, limit: 10 });

		expect(result.total).toBe(2);
		expect(result.events).toHaveLength(1);
		expect(result.events[0].id).toBe('evt-1');
		expect(result.events[0].groupChatId).toBe('gc-1');
		expect(result.events[0].topologyPattern).toBe('hub-spoke');
		expect(result.events[0].templateId).toBeUndefined();
		expect(result.events[0].projectPath).toBeUndefined();
	});

	it('should apply topology filter', async () => {
		mockStatement.get.mockReturnValue({ total: 0 });
		mockStatement.all.mockReturnValue([]);

		const { StatsDB } = await import('../../../main/stats');
		const db = new StatsDB();
		db.initialize();

		db.getTeamOrchHistory({ offset: 0, limit: 10, topologyPattern: 'round-robin' });

		// Verify SQL includes topology filter
		const prepareCalls = mockDb.prepare.mock.calls;
		const countSQL = prepareCalls.find(
			(call) =>
				(call[0] as string).includes('COUNT') && (call[0] as string).includes('topology_pattern')
		);
		expect(countSQL).toBeDefined();
	});

	it('should apply search filter with LIKE', async () => {
		mockStatement.get.mockReturnValue({ total: 0 });
		mockStatement.all.mockReturnValue([]);

		const { StatsDB } = await import('../../../main/stats');
		const db = new StatsDB();
		db.initialize();

		db.getTeamOrchHistory({ offset: 0, limit: 10, search: 'design' });

		const prepareCalls = mockDb.prepare.mock.calls;
		const searchSQL = prepareCalls.find((call) => (call[0] as string).includes('LIKE'));
		expect(searchSQL).toBeDefined();
	});
});

describe('Team Orchestration Events - Event Detail', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockDb.pragma.mockReturnValue([{ user_version: 0 }]);
		mockDb.prepare.mockReturnValue(mockStatement);
		mockStatement.run.mockReturnValue({ changes: 1 });
		mockStatement.all.mockReturnValue([]);
	});

	afterEach(() => {
		vi.resetModules();
	});

	it('should return event detail by ID', async () => {
		const now = Date.now();
		const breakdown = JSON.stringify([
			{
				name: 'A',
				agentId: 'a',
				tokenCount: 100,
				messageCount: 2,
				processingTimeMs: 5000,
				cost: 0.01,
			},
		]);
		mockStatement.get.mockReturnValue({
			id: 'evt-detail',
			group_chat_id: 'gc-2',
			group_chat_name: 'Detail Chat',
			template_id: 'tmpl-2',
			template_name: 'Template X',
			topology_pattern: 'pipeline',
			termination_mode: 'quality-gate',
			status: 'failed',
			iteration_count: 1,
			max_iterations: 3,
			start_time: now - 5000,
			end_time: now,
			duration: 5000,
			participant_count: 1,
			participant_breakdown: breakdown,
			total_tokens: 100,
			total_cost: 0.01,
			moderator_agent_id: 'a',
			project_path: '/project',
		});

		const { StatsDB } = await import('../../../main/stats');
		const db = new StatsDB();
		db.initialize();

		const event = db.getTeamOrchEventDetail('evt-detail');

		expect(event).not.toBeNull();
		expect(event!.id).toBe('evt-detail');
		expect(event!.status).toBe('failed');
		expect(event!.topologyPattern).toBe('pipeline');
		expect(event!.participantBreakdown).toHaveLength(1);
		expect(event!.participantBreakdown[0].agentId).toBe('a');
		expect(event!.templateId).toBe('tmpl-2');
	});

	it('should return null for non-existent event', async () => {
		mockStatement.get.mockReturnValue(undefined);

		const { StatsDB } = await import('../../../main/stats');
		const db = new StatsDB();
		db.initialize();

		const event = db.getTeamOrchEventDetail('nonexistent');
		expect(event).toBeNull();
	});
});

describe('Team Orchestration Events - Aggregation', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockDb.pragma.mockReturnValue([{ user_version: 0 }]);
		mockDb.prepare.mockReturnValue(mockStatement);
		mockStatement.run.mockReturnValue({ changes: 1 });
	});

	afterEach(() => {
		vi.resetModules();
	});

	it('should compute aggregated stats with correct totals', async () => {
		// Sequence of .get and .all calls made by getTeamOrchAggregation sub-queries:
		// 1. queryTotals -> .get
		// 2. queryByTopology -> .all
		// 3. queryByAgent -> .all
		// 4. queryByDay -> .all
		// 5. queryByAgentByDay -> .all
		// 6. queryIterationDistribution -> .all
		// 7. queryByTemplate -> .all

		mockStatement.get.mockReturnValue({
			total_runs: 10,
			completed_runs: 7,
			failed_runs: 2,
			terminated_runs: 1,
			sum_iterations: 30,
			sum_duration: 600000,
			total_tokens: 25000,
			total_cost: 1.5,
		});

		let allCallCount = 0;
		mockStatement.all.mockImplementation(() => {
			allCallCount++;
			switch (allCallCount) {
				case 1: // byTopology
					return [
						{
							topology_pattern: 'hub-spoke',
							count: 7,
							completed: 5,
							avg_iterations: 3,
							avg_duration: 60000,
						},
						{
							topology_pattern: 'pipeline',
							count: 3,
							completed: 2,
							avg_iterations: 2,
							avg_duration: 50000,
						},
					];
				case 2: // byAgent (participant_breakdown rows)
					return [
						{
							participant_breakdown: JSON.stringify([
								{
									name: 'A',
									agentId: 'a',
									tokenCount: 1000,
									messageCount: 5,
									processingTimeMs: 20000,
									cost: 0.1,
								},
								{
									name: 'B',
									agentId: 'b',
									tokenCount: 500,
									messageCount: 3,
									processingTimeMs: 10000,
									cost: 0.05,
								},
							]),
						},
					];
				case 3: // byDay
					return [{ date: '2026-03-20', count: 5, tokens: 12000, duration: 300000, cost: 0.75 }];
				case 4: // byAgentByDay
					return [
						{
							date: '2026-03-20',
							participant_breakdown: JSON.stringify([
								{
									name: 'A',
									agentId: 'a',
									tokenCount: 500,
									messageCount: 2,
									processingTimeMs: 10000,
									cost: 0.05,
								},
							]),
						},
					];
				case 5: // iterationDistribution
					return [
						{ iterations: 2, count: 3 },
						{ iterations: 3, count: 5 },
						{ iterations: 5, count: 2 },
					];
				case 6: // byTemplate
					return [
						{ template_key: 'tmpl-1', count: 6, completed: 4, avg_iterations: 3 },
						{ template_key: '_none_', count: 4, completed: 3, avg_iterations: 2.5 },
					];
				default:
					return [];
			}
		});

		const { StatsDB } = await import('../../../main/stats');
		const db = new StatsDB();
		db.initialize();

		const stats = db.getTeamOrchAggregation('week');

		expect(stats.totalRuns).toBe(10);
		expect(stats.completedRuns).toBe(7);
		expect(stats.failedRuns).toBe(2);
		expect(stats.terminatedRuns).toBe(1);
		expect(stats.successRate).toBe(70);
		expect(stats.avgIterations).toBe(3);
		expect(stats.avgDuration).toBe(60000);
		expect(stats.totalTokens).toBe(25000);
		expect(stats.totalCost).toBe(1.5);

		// byTopology
		expect(stats.byTopology['hub-spoke'].count).toBe(7);
		expect(stats.byTopology['hub-spoke'].successRate).toBe(71); // round(5/7 * 100)
		expect(stats.byTopology['pipeline'].count).toBe(3);

		// byAgent
		expect(stats.byAgent['a'].tokenCount).toBe(1000);
		expect(stats.byAgent['b'].messageCount).toBe(3);

		// iterationDistribution
		expect(stats.iterationDistribution).toHaveLength(3);
		expect(stats.iterationDistribution[0].iterations).toBe(2);
		expect(stats.iterationDistribution[0].count).toBe(3);

		// byTemplate
		expect(stats.byTemplate['tmpl-1'].count).toBe(6);
		expect(stats.byTemplate['_none_'].count).toBe(4);
	});

	it('should handle empty data gracefully', async () => {
		mockStatement.get.mockReturnValue({
			total_runs: 0,
			completed_runs: 0,
			failed_runs: 0,
			terminated_runs: 0,
			sum_iterations: 0,
			sum_duration: 0,
			total_tokens: 0,
			total_cost: 0,
		});
		mockStatement.all.mockReturnValue([]);

		const { StatsDB } = await import('../../../main/stats');
		const db = new StatsDB();
		db.initialize();

		const stats = db.getTeamOrchAggregation('day');

		expect(stats.totalRuns).toBe(0);
		expect(stats.successRate).toBe(0);
		expect(stats.avgIterations).toBe(0);
		expect(stats.avgDuration).toBe(0);
		expect(stats.byTopology).toEqual({});
		expect(stats.byAgent).toEqual({});
		expect(stats.byDay).toEqual([]);
		expect(stats.iterationDistribution).toEqual([]);
		expect(stats.byTemplate).toEqual({});
	});
});

describe('Team Orchestration Events - Export', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockDb.pragma.mockReturnValue([{ user_version: 0 }]);
		mockDb.prepare.mockReturnValue(mockStatement);
		mockStatement.run.mockReturnValue({ changes: 1 });
	});

	afterEach(() => {
		vi.resetModules();
	});

	it('should export events as mapped TeamOrchEvent objects', async () => {
		const now = Date.now();
		mockStatement.all.mockReturnValue([
			{
				id: 'exp-1',
				group_chat_id: 'gc-1',
				group_chat_name: 'Export Chat',
				template_id: null,
				template_name: null,
				topology_pattern: 'hub-spoke',
				termination_mode: 'iteration-limit',
				status: 'completed',
				iteration_count: 2,
				max_iterations: 5,
				start_time: now - 30000,
				end_time: now,
				duration: 30000,
				participant_count: 1,
				participant_breakdown: JSON.stringify([
					{
						name: 'Agent',
						agentId: 'ag',
						tokenCount: 200,
						messageCount: 1,
						processingTimeMs: 5000,
						cost: 0.02,
					},
				]),
				total_tokens: 200,
				total_cost: 0.02,
				moderator_agent_id: 'ag',
				project_path: '/export/proj',
			},
		]);

		const { StatsDB } = await import('../../../main/stats');
		const db = new StatsDB();
		db.initialize();

		const events = db.exportTeamOrchEvents('all');

		expect(events).toHaveLength(1);
		expect(events[0].id).toBe('exp-1');
		expect(events[0].groupChatName).toBe('Export Chat');
		expect(events[0].participantBreakdown).toHaveLength(1);
		expect(events[0].participantBreakdown[0].agentId).toBe('ag');
		expect(events[0].templateId).toBeUndefined();
	});

	it('should handle invalid JSON in participant_breakdown gracefully', async () => {
		const now = Date.now();
		mockStatement.all.mockReturnValue([
			{
				id: 'bad-json',
				group_chat_id: 'gc-1',
				group_chat_name: 'Bad JSON Chat',
				template_id: null,
				template_name: null,
				topology_pattern: 'hub-spoke',
				termination_mode: 'iteration-limit',
				status: 'completed',
				iteration_count: 1,
				max_iterations: 3,
				start_time: now - 5000,
				end_time: now,
				duration: 5000,
				participant_count: 0,
				participant_breakdown: 'not valid json',
				total_tokens: 0,
				total_cost: 0,
				moderator_agent_id: 'x',
				project_path: null,
			},
		]);

		const { StatsDB } = await import('../../../main/stats');
		const db = new StatsDB();
		db.initialize();

		const events = db.exportTeamOrchEvents('all');

		// Should not throw, should return empty array for participantBreakdown
		expect(events).toHaveLength(1);
		expect(events[0].participantBreakdown).toEqual([]);
	});

	it('should handle null participant_breakdown', async () => {
		const now = Date.now();
		mockStatement.all.mockReturnValue([
			{
				id: 'null-breakdown',
				group_chat_id: 'gc-1',
				group_chat_name: 'Null Breakdown',
				template_id: null,
				template_name: null,
				topology_pattern: 'hub-spoke',
				termination_mode: 'iteration-limit',
				status: 'terminated',
				iteration_count: 0,
				max_iterations: 3,
				start_time: now - 1000,
				end_time: now,
				duration: 1000,
				participant_count: 0,
				participant_breakdown: null,
				total_tokens: 0,
				total_cost: 0,
				moderator_agent_id: 'x',
				project_path: null,
			},
		]);

		const { StatsDB } = await import('../../../main/stats');
		const db = new StatsDB();
		db.initialize();

		const events = db.exportTeamOrchEvents('all');

		expect(events).toHaveLength(1);
		expect(events[0].participantBreakdown).toEqual([]);
	});
});
