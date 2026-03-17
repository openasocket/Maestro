/**
 * EVOLVE v1.0 Integration Tests — End-to-end validation of delegation records,
 * session extensions, orchestrator/worker roles, edge records, decision detection,
 * and delegation chain integrity.
 *
 * These tests exercise the full stack: vibes-annotations builders, vibes-session
 * (VibesSessionManager), maestro-instrumenter (MaestroInstrumenter),
 * vibes-coordinator (VibesCoordinator delegation/orchestrator APIs),
 * vibes-decision-detector, and vibes-io (validateDelegationChain).
 *
 * Per EVOLVE spec sections 3 (governance), 4 (decision records), 5 (governance
 * scenarios), and 7 (agent behavior).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

import { VibesSessionManager } from '../../../main/vibes/vibes-session';
import { MaestroInstrumenter } from '../../../main/vibes/instrumenters/maestro-instrumenter';
import {
	initVibesDirectly,
	appendAnnotationImmediate,
	resetAllBuffers,
	validateDelegationChain,
	flushAll,
} from '../../../main/vibes/vibes-io';
import { detectDecision } from '../../../main/vibes/vibes-decision-detector';

import type {
	VibesSessionRecord,
	VibesDelegationRecord,
	VibesEdgeRecord,
	VibesAnnotation,
} from '../../../shared/vibes-types';

// ============================================================================
// Constants
// ============================================================================

const FIXED_ISO = '2026-03-17T12:00:00.000Z';

// ============================================================================
// Helpers
// ============================================================================

function makeSessionStart(
	overrides: Partial<VibesSessionRecord> & { session_id: string }
): VibesSessionRecord {
	return {
		type: 'session',
		annotation_id: `ann-${overrides.session_id}`,
		event: 'start',
		session_id: overrides.session_id,
		timestamp: overrides.timestamp ?? FIXED_ISO,
		environment_hash: overrides.environment_hash ?? 'env-hash-001',
		assurance_level: overrides.assurance_level ?? 'medium',
		description: overrides.description ?? null,
		parent_session_id: overrides.parent_session_id,
		agent_name: overrides.agent_name,
		agent_type: overrides.agent_type,
	};
}

function makeDelegation(
	parentSessionId: string,
	childSessionId: string,
	overrides?: Partial<VibesDelegationRecord>
): VibesDelegationRecord {
	return {
		type: 'delegation',
		parent_session_id: parentSessionId,
		child_session_id: childSessionId,
		timestamp: overrides?.timestamp ?? FIXED_ISO,
		task_description: overrides?.task_description ?? 'Auto Run task',
		delegation_type: overrides?.delegation_type ?? 'task',
		delegated_files: overrides?.delegated_files,
		parent_environment_hash: overrides?.parent_environment_hash,
		child_environment_hash: overrides?.child_environment_hash,
	};
}

/**
 * Read the annotations.jsonl file from a project and parse each line.
 */
async function readAnnotationsFromDisk(projectPath: string): Promise<VibesAnnotation[]> {
	const filePath = path.join(projectPath, '.ai-audit', 'annotations.jsonl');
	const content = await readFile(filePath, 'utf-8');
	return content
		.split('\n')
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as VibesAnnotation);
}

// ============================================================================
// 1. Delegation record created when Auto Run spawns an agent
// ============================================================================

describe('EVOLVE Integration Tests', () => {
	let tmpDir: string;

	beforeEach(async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(FIXED_ISO));
		tmpDir = await mkdtemp(path.join(os.tmpdir(), 'vibes-evolve-test-'));
		await initVibesDirectly(tmpDir, {
			projectName: 'evolve-test',
			assuranceLevel: 'high',
		});
	});

	afterEach(async () => {
		resetAllBuffers();
		vi.useRealTimers();
		await rm(tmpDir, { recursive: true, force: true });
	});

	// ====================================================================
	// Test 1: Delegation record created when Auto Run spawns an agent
	// ====================================================================

	it('should create a delegation record when Auto Run spawns an agent', async () => {
		const sessionManager = new VibesSessionManager();

		// Start Maestro orchestrator session
		const maestroState = await sessionManager.startSession(
			'maestro-session',
			tmpDir,
			'maestro',
			'high',
			'env-hash-maestro',
			{ agentType: 'orchestrator', agentName: 'maestro' }
		);

		const instrumenter = new MaestroInstrumenter({
			sessionManager,
			assuranceLevel: 'high',
		});

		// Start a worker session (simulates the child agent)
		await sessionManager.startSession(
			'worker-session',
			tmpDir,
			'claude-code',
			'high',
			'env-hash-worker'
		);

		// Simulate Auto Run dispatching a task
		await instrumenter.handleAgentSpawn({
			maestroSessionId: 'maestro-session',
			agentSessionId: 'worker-session',
			agentType: 'claude-code',
			taskDescription: 'Implement feature X',
			projectPath: tmpDir,
			delegationType: 'task',
		});

		// Flush buffered writes before reading from disk
		await flushAll();

		// Read annotations and find delegation record
		const annotations = await readAnnotationsFromDisk(tmpDir);
		const delegations = annotations.filter(
			(a): a is VibesDelegationRecord => a.type === 'delegation'
		);

		expect(delegations.length).toBeGreaterThanOrEqual(1);
		expect(delegations[0].delegation_type).toBe('task');
		expect(delegations[0].task_description).toBe('Implement feature X');
	});

	// ====================================================================
	// Test 2: Delegation record has correct parent/child session IDs
	// ====================================================================

	it('should have correct parent/child session IDs in delegation records', async () => {
		const sessionManager = new VibesSessionManager();

		const maestroState = await sessionManager.startSession(
			'maestro-session',
			tmpDir,
			'maestro',
			'high',
			'env-hash-maestro'
		);

		await sessionManager.startSession(
			'worker-session',
			tmpDir,
			'claude-code',
			'high',
			'env-hash-worker'
		);

		const instrumenter = new MaestroInstrumenter({
			sessionManager,
			assuranceLevel: 'high',
		});

		await instrumenter.handleAgentSpawn({
			maestroSessionId: 'maestro-session',
			agentSessionId: 'worker-session',
			agentType: 'claude-code',
			taskDescription: 'Task',
			projectPath: tmpDir,
		});

		await flushAll();

		const annotations = await readAnnotationsFromDisk(tmpDir);
		const delegation = annotations.find((a): a is VibesDelegationRecord => a.type === 'delegation');

		expect(delegation).toBeDefined();
		// Parent should be Maestro's VIBES session UUID
		expect(delegation!.parent_session_id).toBe(maestroState.vibesSessionId);
		// Child should be the worker's VIBES session UUID
		const workerState = sessionManager.getSession('worker-session');
		expect(delegation!.child_session_id).toBe(workerState!.vibesSessionId);
	});

	// ====================================================================
	// Test 3: Session start record includes parent_session_id for sub-agents
	// ====================================================================

	it('should include parent_session_id on session start records for sub-agents', async () => {
		const sessionManager = new VibesSessionManager();

		// Start orchestrator
		const orchestratorState = await sessionManager.startSession(
			'orch-session',
			tmpDir,
			'maestro',
			'medium',
			'env-hash-orch',
			{ agentType: 'orchestrator', agentName: 'maestro' }
		);

		// Start worker with parent reference
		await sessionManager.startSession(
			'worker-session',
			tmpDir,
			'claude-code',
			'medium',
			'env-hash-worker',
			{
				parentSessionId: orchestratorState.vibesSessionId,
				agentType: 'worker',
				agentName: 'claude-code',
			}
		);

		const annotations = await readAnnotationsFromDisk(tmpDir);
		const workerStart = annotations.find(
			(a): a is VibesSessionRecord =>
				a.type === 'session' && a.event === 'start' && a.agent_name === 'claude-code'
		);

		expect(workerStart).toBeDefined();
		expect(workerStart!.parent_session_id).toBe(orchestratorState.vibesSessionId);
	});

	// ====================================================================
	// Test 4: Session start record includes agent_name and agent_type
	// ====================================================================

	it('should include agent_name and agent_type on session start records', async () => {
		const sessionManager = new VibesSessionManager();

		await sessionManager.startSession(
			'my-session',
			tmpDir,
			'claude-code',
			'medium',
			'env-hash-001',
			{
				agentName: 'claude-code',
				agentType: 'worker',
			}
		);

		const annotations = await readAnnotationsFromDisk(tmpDir);
		const sessionStart = annotations.find(
			(a): a is VibesSessionRecord =>
				a.type === 'session' && a.event === 'start' && a.agent_name === 'claude-code'
		);

		expect(sessionStart).toBeDefined();
		expect(sessionStart!.agent_name).toBe('claude-code');
		expect(sessionStart!.agent_type).toBe('worker');
	});

	// ====================================================================
	// Test 5: Orchestrator sessions have agent_type: 'orchestrator'
	// ====================================================================

	it('should mark orchestrator sessions with agent_type orchestrator', async () => {
		const sessionManager = new VibesSessionManager();

		await sessionManager.startSession('orch-session', tmpDir, 'maestro', 'high', 'env-hash-orch', {
			agentType: 'orchestrator',
			agentName: 'maestro',
		});

		const annotations = await readAnnotationsFromDisk(tmpDir);
		const orchStart = annotations.find(
			(a): a is VibesSessionRecord =>
				a.type === 'session' && a.event === 'start' && a.agent_name === 'maestro'
		);

		expect(orchStart).toBeDefined();
		expect(orchStart!.agent_type).toBe('orchestrator');
	});

	// ====================================================================
	// Test 6: Worker sessions have agent_type: 'worker'
	// ====================================================================

	it('should mark worker sessions with agent_type worker', async () => {
		const sessionManager = new VibesSessionManager();

		await sessionManager.startSession(
			'worker-session',
			tmpDir,
			'codex',
			'medium',
			'env-hash-worker',
			{
				agentType: 'worker',
				agentName: 'codex',
			}
		);

		const annotations = await readAnnotationsFromDisk(tmpDir);
		const workerStart = annotations.find(
			(a): a is VibesSessionRecord =>
				a.type === 'session' && a.event === 'start' && a.agent_name === 'codex'
		);

		expect(workerStart).toBeDefined();
		expect(workerStart!.agent_type).toBe('worker');
	});

	// ====================================================================
	// Test 7: delegated_to edge emitted alongside delegation record
	// ====================================================================

	it('should emit a delegated_to edge alongside the delegation record', async () => {
		const sessionManager = new VibesSessionManager();

		const maestroState = await sessionManager.startSession(
			'maestro-session',
			tmpDir,
			'maestro',
			'high',
			'env-hash-maestro'
		);

		const workerState = await sessionManager.startSession(
			'worker-session',
			tmpDir,
			'claude-code',
			'high',
			'env-hash-worker'
		);

		const instrumenter = new MaestroInstrumenter({
			sessionManager,
			assuranceLevel: 'high',
		});

		await instrumenter.handleAgentSpawn({
			maestroSessionId: 'maestro-session',
			agentSessionId: 'worker-session',
			agentType: 'claude-code',
			taskDescription: 'Build the thing',
			projectPath: tmpDir,
		});

		await flushAll();

		const annotations = await readAnnotationsFromDisk(tmpDir);
		const edges = annotations.filter(
			(a): a is VibesEdgeRecord => a.type === 'edge' && a.edge_type === 'delegated_to'
		);

		expect(edges.length).toBeGreaterThanOrEqual(1);
		const edge = edges[0];
		expect(edge.source_ref).toBe(maestroState.vibesSessionId);
		expect(edge.source_type).toBe('session');
		expect(edge.target_ref).toBe(workerState.vibesSessionId);
		expect(edge.target_type).toBe('session');
		expect(edge.session_id).toBe(maestroState.vibesSessionId);
	});

	// ====================================================================
	// Test 8: Decision detection returns null for non-decision text
	// ====================================================================

	it('should return null from detectDecision for non-decision text', () => {
		const nonDecisionTexts = [
			'',
			'Short text.',
			'I need to read the file first to understand its structure. The file has several imports and a main function that processes data.',
			'Let me check the dependencies and see what packages are installed. The package.json shows several test utilities.',
		];

		for (const text of nonDecisionTexts) {
			expect(detectDecision(text)).toBeNull();
		}
	});

	// ====================================================================
	// Test 9: Decision detection extracts structured entry from Option A/B
	// ====================================================================

	it('should extract a structured decision entry from Option A/B text', () => {
		const text = `
			I need to decide how to implement the caching layer.
			Option A: Use a simple LRU cache with fixed size
			Option B: Use a time-based TTL cache with lazy eviction
			I'll go with a time-based TTL cache because it handles stale data automatically.
		`;

		const result = detectDecision(text);
		expect(result).not.toBeNull();
		expect(result!.options).toHaveLength(2);
		expect(result!.options[0].id).toBe('a');
		expect(result!.options[1].id).toBe('b');
		expect(result!.selected).toBeTruthy();
		expect(result!.rationale).toBeTruthy();
		expect(result!.confidence).toBeDefined();
		// Should NOT have type or created_at (those are added by createDecisionEntry)
		expect(result).not.toHaveProperty('type');
		expect(result).not.toHaveProperty('created_at');
	});

	// ====================================================================
	// Test 10: Delegation chain validation passes for well-formed chains
	// ====================================================================

	it('should pass delegation chain validation for well-formed chains', async () => {
		// Orchestrator
		await appendAnnotationImmediate(
			tmpDir,
			makeSessionStart({
				session_id: 'orch-1',
				agent_type: 'orchestrator',
				agent_name: 'maestro',
			})
		);

		// Worker with proper parent reference
		await appendAnnotationImmediate(
			tmpDir,
			makeSessionStart({
				session_id: 'worker-1',
				agent_type: 'worker',
				agent_name: 'claude-code',
				parent_session_id: 'orch-1',
			})
		);

		// Delegation record connecting them
		await appendAnnotationImmediate(tmpDir, makeDelegation('orch-1', 'worker-1'));

		// Second worker
		await appendAnnotationImmediate(
			tmpDir,
			makeSessionStart({
				session_id: 'worker-2',
				agent_type: 'worker',
				agent_name: 'codex',
				parent_session_id: 'orch-1',
			})
		);
		await appendAnnotationImmediate(tmpDir, makeDelegation('orch-1', 'worker-2'));

		const result = await validateDelegationChain(tmpDir);
		expect(result.valid).toBe(true);
		expect(result.totalSessions).toBe(3);
		expect(result.orphanedSessions).toEqual([]);
		expect(result.brokenChains).toEqual([]);
	});

	// ====================================================================
	// Test 11: Delegation chain validation detects orphaned sessions
	// ====================================================================

	it('should detect orphaned sessions in delegation chain validation', async () => {
		// Orchestrator
		await appendAnnotationImmediate(
			tmpDir,
			makeSessionStart({
				session_id: 'orch-1',
				agent_type: 'orchestrator',
				agent_name: 'maestro',
			})
		);

		// Worker claims orchestrator as parent but NO delegation record exists
		await appendAnnotationImmediate(
			tmpDir,
			makeSessionStart({
				session_id: 'orphan-worker',
				agent_type: 'worker',
				agent_name: 'claude-code',
				parent_session_id: 'orch-1',
			})
		);

		const result = await validateDelegationChain(tmpDir);
		expect(result.valid).toBe(false);
		expect(result.orphanedSessions).toContain('orphan-worker');
	});

	// ====================================================================
	// Test 12: Group Chat participants emit correct parent_session_id
	// ====================================================================

	it('should emit correct parent_session_id for Group Chat participants', async () => {
		const sessionManager = new VibesSessionManager();

		// Group Chat moderator as orchestrator
		const moderatorState = await sessionManager.startSession(
			'moderator-session',
			tmpDir,
			'maestro',
			'medium',
			'env-hash-mod',
			{
				agentType: 'orchestrator',
				agentName: 'moderator',
			}
		);

		// Participant 1 with moderator as parent
		await sessionManager.startSession(
			'participant-1',
			tmpDir,
			'claude-code',
			'medium',
			'env-hash-p1',
			{
				parentSessionId: moderatorState.vibesSessionId,
				agentType: 'worker',
				agentName: 'claude-code',
			}
		);

		// Participant 2 with moderator as parent
		await sessionManager.startSession('participant-2', tmpDir, 'codex', 'medium', 'env-hash-p2', {
			parentSessionId: moderatorState.vibesSessionId,
			agentType: 'worker',
			agentName: 'codex',
		});

		const annotations = await readAnnotationsFromDisk(tmpDir);
		const sessionStarts = annotations.filter(
			(a): a is VibesSessionRecord => a.type === 'session' && a.event === 'start'
		);

		// Moderator should be orchestrator
		const modStart = sessionStarts.find((s) => s.agent_name === 'moderator');
		expect(modStart).toBeDefined();
		expect(modStart!.agent_type).toBe('orchestrator');

		// Both participants should reference moderator's VIBES session ID as parent
		const p1Start = sessionStarts.find((s) => s.agent_name === 'claude-code');
		expect(p1Start).toBeDefined();
		expect(p1Start!.parent_session_id).toBe(moderatorState.vibesSessionId);
		expect(p1Start!.agent_type).toBe('worker');

		const p2Start = sessionStarts.find((s) => s.agent_name === 'codex');
		expect(p2Start).toBeDefined();
		expect(p2Start!.parent_session_id).toBe(moderatorState.vibesSessionId);
		expect(p2Start!.agent_type).toBe('worker');
	});
});
