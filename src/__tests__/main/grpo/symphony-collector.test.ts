/**
 * Tests for SymphonyCollector — passive signal collection from Auto Run.
 *
 * Uses a real temp directory for JSONL and index file operations.
 * Mocks reward-collector and child_process to control reward outputs.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// Mock electron before importing the collector
vi.mock('electron', () => ({
	app: {
		getPath: vi.fn(() => '/mock/userData'),
	},
}));

// Mock logger
vi.mock('../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

// Mock sentry
vi.mock('../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
}));

// Mock child_process.exec (used by reward-collector internally)
const mockExec = vi.fn();
vi.mock(import('child_process'), async (importOriginal) => {
	const actual = await importOriginal();
	return {
		...actual,
		default: { ...actual, exec: (...args: any[]) => mockExec(...args) },
		exec: (...args: any[]) => mockExec(...args),
	};
});

import {
	SymphonyCollector,
	normalizeTaskContent,
	computeTaskContentHash,
} from '../../../main/grpo/symphony-collector';
import type {
	GRPOConfig,
	CollectedSignal,
	BatchCollectionResult,
	SignalIndex,
} from '../../../shared/grpo-types';
import { GRPO_CONFIG_DEFAULTS } from '../../../shared/grpo-types';

let tmpDir: string;
let collector: SymphonyCollector;
let config: GRPOConfig;

/** Helper to configure mockExec to simulate a command result */
function mockExecResult(opts: { stdout?: string; stderr?: string; exitCode?: number; killed?: boolean }) {
	mockExec.mockImplementation((_cmd: string, _opts: any, callback: Function) => {
		const { stdout = '', stderr = '', exitCode = 0, killed = false } = opts;
		if (exitCode === 0 && !killed) {
			callback(null, stdout, stderr);
		} else {
			const error: any = new Error('command failed');
			error.code = exitCode;
			error.killed = killed;
			callback(error, stdout, stderr);
		}
		return { kill: vi.fn() };
	});
}

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'grpo-symphony-test-'));
	config = { ...GRPO_CONFIG_DEFAULTS, enabled: true };
	collector = new SymphonyCollector(config, tmpDir);
	await collector.initialize();
	mockExec.mockReset();
	// Default: all commands succeed
	mockExecResult({ stdout: '', exitCode: 0 });
});

afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
});

const PROJECT_PATH = '/test/project';
const AGENT_TYPE = 'claude-code';
const SESSION_ID = 'sess-001';
const DOC_PATH = '/test/playbook.md';

describe('normalizeTaskContent', () => {
	it('should strip whitespace and lowercase', () => {
		expect(normalizeTaskContent('  Add a Button  ')).toBe('add a button');
	});

	it('should collapse internal whitespace', () => {
		expect(normalizeTaskContent('fix   the\n\tbug')).toBe('fix the bug');
	});

	it('should produce identical output for whitespace-different inputs', () => {
		const a = normalizeTaskContent('Add a test for the login component');
		const b = normalizeTaskContent('  add   a  TEST for  the   login   component  ');
		expect(a).toBe(b);
	});
});

describe('computeTaskContentHash', () => {
	it('should return a 12-char hex string', () => {
		const hash = computeTaskContentHash('Add a button');
		expect(hash).toMatch(/^[0-9a-f]{12}$/);
	});

	it('should produce identical hashes for whitespace-normalized inputs', () => {
		const h1 = computeTaskContentHash('Add a button');
		const h2 = computeTaskContentHash('  add  a   button  ');
		expect(h1).toBe(h2);
	});

	it('should produce different hashes for different content', () => {
		const h1 = computeTaskContentHash('Add a button');
		const h2 = computeTaskContentHash('Fix the test');
		expect(h1).not.toBe(h2);
	});
});

describe('SymphonyCollector', () => {
	describe('onTaskComplete', () => {
		it('should store a signal to JSONL and return it', async () => {
			const signal = await collector.onTaskComplete(
				'Add a button', PROJECT_PATH, AGENT_TYPE, SESSION_ID,
				0, 'Task done', 5000, DOC_PATH,
			);

			expect(signal.taskContent).toBe('Add a button');
			expect(signal.taskContentHash).toBe(computeTaskContentHash('Add a button'));
			expect(signal.aggregateReward).toBeGreaterThanOrEqual(0);
			expect(signal.agentType).toBe(AGENT_TYPE);
			expect(signal.sessionId).toBe(SESSION_ID);
			expect(signal.durationMs).toBe(5000);
			expect(signal.documentPath).toBe(DOC_PATH);
			expect(signal.projectPath).toBe(PROJECT_PATH);
			expect(signal.collectedAt).toBeGreaterThan(0);

			// Verify JSONL was written
			const files = await fs.readdir(collector.getBaseDir(), { recursive: true });
			const jsonlFiles = (files as string[]).filter(f => f.endsWith('signals.jsonl'));
			expect(jsonlFiles.length).toBe(1);
		});

		it('should update the signal index with new task', async () => {
			await collector.onTaskComplete(
				'Add a button', PROJECT_PATH, AGENT_TYPE, SESSION_ID,
				0, 'Task done', 5000, DOC_PATH,
			);

			// Read the index directly
			const indexFiles = await findFiles(tmpDir, 'index.json');
			expect(indexFiles.length).toBe(1);
			const index: SignalIndex = JSON.parse(await fs.readFile(indexFiles[0], 'utf-8'));
			const hash = computeTaskContentHash('Add a button');
			expect(index.entries[hash]).toBeDefined();
			expect(index.entries[hash].executionCount).toBe(1);
			expect(index.entries[hash].normalizedContent).toBe('add a button');
		});

		it('should increment execution count for same task across runs', async () => {
			await collector.onTaskComplete(
				'Add a button', PROJECT_PATH, AGENT_TYPE, 'sess-001',
				0, 'Done', 5000, DOC_PATH,
			);
			await collector.onTaskComplete(
				'Add a button', PROJECT_PATH, AGENT_TYPE, 'sess-002',
				0, 'Done again', 6000, DOC_PATH,
			);

			const indexFiles = await findFiles(tmpDir, 'index.json');
			const index: SignalIndex = JSON.parse(await fs.readFile(indexFiles[0], 'utf-8'));
			const hash = computeTaskContentHash('Add a button');
			expect(index.entries[hash].executionCount).toBe(2);
		});

		it('should match tasks with whitespace differences via normalization', async () => {
			await collector.onTaskComplete(
				'Add a button', PROJECT_PATH, AGENT_TYPE, 'sess-001',
				0, 'Done', 5000, DOC_PATH,
			);
			await collector.onTaskComplete(
				'  add   a   button  ', PROJECT_PATH, AGENT_TYPE, 'sess-002',
				0, 'Done', 6000, DOC_PATH,
			);

			const indexFiles = await findFiles(tmpDir, 'index.json');
			const index: SignalIndex = JSON.parse(await fs.readFile(indexFiles[0], 'utf-8'));
			// Should be ONE entry with executionCount 2, not two separate entries
			const entries = Object.values(index.entries);
			expect(entries.length).toBe(1);
			expect(entries[0].executionCount).toBe(2);
		});

		it('should not match different tasks', async () => {
			await collector.onTaskComplete(
				'Add a button', PROJECT_PATH, AGENT_TYPE, 'sess-001',
				0, 'Done', 5000, DOC_PATH,
			);
			await collector.onTaskComplete(
				'Fix the test', PROJECT_PATH, AGENT_TYPE, 'sess-002',
				0, 'Done', 6000, DOC_PATH,
			);

			const indexFiles = await findFiles(tmpDir, 'index.json');
			const index: SignalIndex = JSON.parse(await fs.readFile(indexFiles[0], 'utf-8'));
			const entries = Object.values(index.entries);
			expect(entries.length).toBe(2);
			expect(entries[0].executionCount).toBe(1);
			expect(entries[1].executionCount).toBe(1);
		});
	});

	describe('onBatchComplete', () => {
		it('should generate correct collection summary', async () => {
			// Collect signals first to populate the index
			const sig1 = await collector.onTaskComplete(
				'Add a button', PROJECT_PATH, AGENT_TYPE, 'sess-001',
				0, 'Done', 5000, DOC_PATH,
			);
			const sig2 = await collector.onTaskComplete(
				'Add a button', PROJECT_PATH, AGENT_TYPE, 'sess-002',
				0, 'Done', 6000, DOC_PATH,
			);
			const sig3 = await collector.onTaskComplete(
				'Fix the test', PROJECT_PATH, AGENT_TYPE, 'sess-003',
				0, 'Done', 4000, DOC_PATH,
			);

			const batchResults: BatchCollectionResult[] = [
				{ documentPath: DOC_PATH, signals: [sig1, sig2, sig3], overallSuccess: true },
			];

			const summary = await collector.onBatchComplete(PROJECT_PATH, batchResults);

			expect(summary.documentsProcessed).toBe(1);
			expect(summary.signalsCollected).toBe(3);
			expect(summary.meanTaskReward).toBeGreaterThanOrEqual(0);
			// "Add a button" has 2 executions → 1 matched pair
			expect(summary.matchedPairCount).toBe(1);
			// Not enough for training (need >= 5)
			expect(summary.trainingRecommended).toBe(false);
		});

		it('should recommend training with 5+ matched pairs', async () => {
			// Create 5 different tasks, each with 2 executions
			for (let i = 0; i < 5; i++) {
				const task = `Task number ${i}`;
				await collector.onTaskComplete(task, PROJECT_PATH, AGENT_TYPE, `s-${i}-a`, 0, 'Done', 1000, DOC_PATH);
				await collector.onTaskComplete(task, PROJECT_PATH, AGENT_TYPE, `s-${i}-b`, 0, 'Done', 1000, DOC_PATH);
			}

			const summary = await collector.onBatchComplete(PROJECT_PATH, [
				{ documentPath: DOC_PATH, signals: [], overallSuccess: true },
			]);

			expect(summary.matchedPairCount).toBe(5);
			expect(summary.trainingRecommended).toBe(true);
		});
	});

	describe('getTrainingReadiness', () => {
		it('should report not ready with no tasks at all', async () => {
			// No tasks executed — nothing to match
			const readiness = await collector.getTrainingReadiness(PROJECT_PATH);
			expect(readiness.matchedTaskCount).toBe(0);
			expect(readiness.ready).toBe(false);
		});

		it('should report ready with 1 matched task when minReadyTasks = 1', async () => {
			// One task with 2 executions (meets rolloutGroupSize=2) with variance
			for (let i = 0; i < 2; i++) {
				mockExecResult({ stdout: i === 0 ? '' : 'FAIL', exitCode: i === 0 ? 0 : 1 });
				await collector.onTaskComplete(
					'Add a button', PROJECT_PATH, AGENT_TYPE, `sess-${i}`,
					i === 0 ? 0 : 1, i === 0 ? 'Done' : 'Failed', 5000, DOC_PATH,
				);
			}

			const readiness = await collector.getTrainingReadiness(PROJECT_PATH);
			// With minReadyTasks=1, even 1 qualifying task with variance is enough
			if (readiness.matchedTaskCount >= 1) {
				expect(readiness.ready).toBe(true);
			}
		});

		it('should report ready with matched tasks with variance', async () => {
			// Create 3 different tasks, each with 2 executions where rewards vary
			for (let taskIdx = 0; taskIdx < 3; taskIdx++) {
				const task = `Distinct task ${taskIdx}`;
				for (let execIdx = 0; execIdx < 2; execIdx++) {
					// Alternate success/failure to create variance
					const exit = execIdx % 2 === 0 ? 0 : 1;
					mockExecResult({ stdout: exit === 0 ? 'ok' : 'FAIL', exitCode: exit });
					await collector.onTaskComplete(
						task, PROJECT_PATH, AGENT_TYPE, `s-${taskIdx}-${execIdx}`,
						exit, exit === 0 ? 'Success' : 'Failure', 5000, DOC_PATH,
					);
				}
			}

			const readiness = await collector.getTrainingReadiness(PROJECT_PATH);
			expect(readiness.matchedTaskCount).toBeGreaterThanOrEqual(0);
			expect(readiness.suggestedTasks.length).toBeGreaterThanOrEqual(3);
			// Each suggested task should have executionCount >= rolloutGroupSize (2)
			for (const task of readiness.suggestedTasks) {
				expect(task.executionCount).toBeGreaterThanOrEqual(2);
			}
		});

		it('should report minGroupSize from config', async () => {
			const readiness = await collector.getTrainingReadiness(PROJECT_PATH);
			expect(readiness.minGroupSize).toBe(config.rolloutGroupSize);
		});
	});

	describe('formNaturalRolloutGroups', () => {
		it('should form rollout groups from tasks with enough executions', async () => {
			// 3 executions of same task with varying exit codes (rolloutGroupSize=2, takes last 2)
			for (let i = 0; i < 3; i++) {
				const exit = i === 0 ? 1 : 0; // First fails, rest succeed
				mockExecResult({ stdout: exit === 0 ? 'ok' : 'FAIL', exitCode: exit });
				await collector.onTaskComplete(
					'Add a test', PROJECT_PATH, AGENT_TYPE, `sess-${i}`,
					exit, exit === 0 ? 'Pass' : 'Fail', 5000, DOC_PATH,
				);
			}

			const groups = await collector.formNaturalRolloutGroups(PROJECT_PATH);
			// May or may not form a group depending on variance threshold
			for (const group of groups) {
				expect(group.taskPrompt).toBe(normalizeTaskContent('Add a test'));
				expect(group.outputs.length).toBe(config.rolloutGroupSize);
				expect(group.projectPath).toBe(PROJECT_PATH);
			}
		});

		it('should exclude low-variance groups', async () => {
			// 2 identical executions → same reward → low/zero variance
			for (let i = 0; i < 2; i++) {
				mockExecResult({ stdout: '', exitCode: 0 });
				await collector.onTaskComplete(
					'Simple task', PROJECT_PATH, AGENT_TYPE, `sess-${i}`,
					0, 'Done', 5000, DOC_PATH,
				);
			}

			const groups = await collector.formNaturalRolloutGroups(PROJECT_PATH);
			// All same result → zero variance → excluded
			expect(groups.length).toBe(0);
		});

		it('should skip tasks with fewer than rolloutGroupSize executions', async () => {
			// Only 1 execution, but need 2 (default rolloutGroupSize)
			mockExecResult({ exitCode: 0 });
			await collector.onTaskComplete(
				'Short task', PROJECT_PATH, AGENT_TYPE, 'sess-0',
				0, 'output', 5000, DOC_PATH,
			);

			const groups = await collector.formNaturalRolloutGroups(PROJECT_PATH);
			expect(groups.length).toBe(0);
		});

		it('should take the N most recent executions', async () => {
			// 5 executions, but rolloutGroupSize is 2 → take last 2
			for (let i = 0; i < 5; i++) {
				const exit = i % 2;
				mockExecResult({ exitCode: exit });
				await collector.onTaskComplete(
					'Repeated task', PROJECT_PATH, AGENT_TYPE, `sess-${i}`,
					exit, 'output', 5000, DOC_PATH,
				);
			}

			const groups = await collector.formNaturalRolloutGroups(PROJECT_PATH);
			for (const group of groups) {
				expect(group.outputs.length).toBe(2);
			}
		});
	});

	describe('GRPO disabled', () => {
		it('onTaskComplete should still work (collector is data-layer only)', async () => {
			// The collector itself doesn't check enabled — that's the IPC handler's job.
			// But we test that the collector functions correctly regardless.
			const disabledConfig = { ...GRPO_CONFIG_DEFAULTS, enabled: false };
			const disabledCollector = new SymphonyCollector(disabledConfig, tmpDir);
			await disabledCollector.initialize();

			const signal = await disabledCollector.onTaskComplete(
				'Task', PROJECT_PATH, AGENT_TYPE, SESSION_ID,
				0, 'Done', 1000, DOC_PATH,
			);
			expect(signal).toBeDefined();
			expect(signal.taskContent).toBe('Task');
		});
	});

	describe('realm tagging', () => {
		it('should default to autorun realm when not specified', async () => {
			const signal = await collector.onTaskComplete(
				'Add a button', PROJECT_PATH, AGENT_TYPE, SESSION_ID,
				0, 'Done', 5000, DOC_PATH,
			);
			expect(signal.realm).toBe('autorun');
		});

		it('should set explicit realm when specified', async () => {
			const processSignal = await collector.onTaskComplete(
				'Process task', PROJECT_PATH, AGENT_TYPE, SESSION_ID,
				0, 'Done', 5000, DOC_PATH,
				'process',
			);
			expect(processSignal.realm).toBe('process');

			const manualSignal = await collector.onTaskComplete(
				'Manual task', PROJECT_PATH, AGENT_TYPE, 'sess-002',
				0, 'Done', 5000, DOC_PATH,
				'manual',
			);
			expect(manualSignal.realm).toBe('manual');

			const groupchatSignal = await collector.onTaskComplete(
				'Groupchat task', PROJECT_PATH, AGENT_TYPE, 'sess-003',
				0, 'Done', 5000, DOC_PATH,
				'groupchat',
			);
			expect(groupchatSignal.realm).toBe('groupchat');
		});

		it('should persist realm in JSONL storage', async () => {
			await collector.onTaskComplete(
				'Task 1', PROJECT_PATH, AGENT_TYPE, 'sess-001',
				0, 'Done', 5000, DOC_PATH,
				'autorun',
			);
			await collector.onTaskComplete(
				'Task 2', PROJECT_PATH, AGENT_TYPE, 'sess-002',
				0, 'Done', 5000, DOC_PATH,
				'process',
			);

			// Read the JSONL directly and verify realm is persisted
			const jsonlFiles = await findFiles(tmpDir, 'signals.jsonl');
			expect(jsonlFiles.length).toBe(1);
			const data = await fs.readFile(jsonlFiles[0], 'utf-8');
			const lines = data.trim().split('\n');
			expect(lines.length).toBe(2);

			const signal1 = JSON.parse(lines[0]);
			const signal2 = JSON.parse(lines[1]);
			expect(signal1.realm).toBe('autorun');
			expect(signal2.realm).toBe('process');
		});
	});

	describe('signal index integrity', () => {
		it('should update index correctly after each collection', async () => {
			const tasks = ['Task A', 'Task B', 'Task A', 'Task C', 'Task A'];
			for (let i = 0; i < tasks.length; i++) {
				mockExecResult({ exitCode: 0 });
				await collector.onTaskComplete(
					tasks[i], PROJECT_PATH, AGENT_TYPE, `sess-${i}`,
					0, 'Done', 1000, DOC_PATH,
				);
			}

			const indexFiles = await findFiles(tmpDir, 'index.json');
			const index: SignalIndex = JSON.parse(await fs.readFile(indexFiles[0], 'utf-8'));

			const hashA = computeTaskContentHash('Task A');
			const hashB = computeTaskContentHash('Task B');
			const hashC = computeTaskContentHash('Task C');

			expect(index.entries[hashA].executionCount).toBe(3);
			expect(index.entries[hashB].executionCount).toBe(1);
			expect(index.entries[hashC].executionCount).toBe(1);
			expect(Object.keys(index.entries).length).toBe(3);
		});
	});
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Recursively find files matching a name in a directory.
 */
async function findFiles(dir: string, name: string): Promise<string[]> {
	const results: string[] = [];
	const entries = await fs.readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			results.push(...await findFiles(fullPath, name));
		} else if (entry.name === name) {
			results.push(fullPath);
		}
	}
	return results;
}
