/**
 * Tests for validateDelegationChain() in src/main/vibes/vibes-io.ts
 *
 * Validates EVOLVE spec section 3 delegation chain integrity:
 * - Well-formed chains pass validation
 * - Orphaned worker sessions are detected
 * - Broken parent references are detected
 * - Orchestrator-only projects are valid
 * - Mixed orchestrator/worker chains
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

import {
	initVibesDirectly,
	appendAnnotationImmediate,
	resetAllBuffers,
	validateDelegationChain,
} from '../../../main/vibes/vibes-io';

import type { VibesSessionRecord, VibesDelegationRecord } from '../../../shared/vibes-types';

// ============================================================================
// Helpers
// ============================================================================

const FIXED_ISO = '2026-03-17T10:00:00Z';

function makeSessionStart(
	overrides: Partial<VibesSessionRecord> & { session_id: string }
): VibesSessionRecord {
	return {
		type: 'session',
		annotation_id: `ann-${overrides.session_id}`,
		event: 'start',
		session_id: overrides.session_id,
		timestamp: overrides.timestamp ?? FIXED_ISO,
		environment_hash: overrides.environment_hash ?? null,
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
		task_description: overrides?.task_description ?? 'Test task',
		delegation_type: overrides?.delegation_type ?? 'task',
	};
}

// ============================================================================
// Tests
// ============================================================================

describe('validateDelegationChain', () => {
	let tmpDir: string;

	beforeEach(async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(FIXED_ISO));
		tmpDir = await mkdtemp(path.join(os.tmpdir(), 'vibes-chain-test-'));
		await initVibesDirectly(tmpDir, {
			projectName: 'chain-test',
			assuranceLevel: 'medium',
		});
	});

	afterEach(async () => {
		resetAllBuffers();
		vi.useRealTimers();
		await rm(tmpDir, { recursive: true, force: true });
	});

	it('should return valid for an empty project with no sessions', async () => {
		const result = await validateDelegationChain(tmpDir);
		expect(result.valid).toBe(true);
		expect(result.totalSessions).toBe(0);
		expect(result.orphanedSessions).toEqual([]);
		expect(result.brokenChains).toEqual([]);
	});

	it('should return valid for a single orchestrator session with no children', async () => {
		await appendAnnotationImmediate(
			tmpDir,
			makeSessionStart({
				session_id: 'orch-1',
				agent_type: 'orchestrator',
				agent_name: 'maestro',
			})
		);

		const result = await validateDelegationChain(tmpDir);
		expect(result.valid).toBe(true);
		expect(result.totalSessions).toBe(1);
		expect(result.orphanedSessions).toEqual([]);
		expect(result.brokenChains).toEqual([]);
	});

	it('should return valid for a well-formed delegation chain', async () => {
		// Orchestrator session
		await appendAnnotationImmediate(
			tmpDir,
			makeSessionStart({
				session_id: 'orch-1',
				agent_type: 'orchestrator',
				agent_name: 'maestro',
			})
		);

		// Worker session with parent reference
		await appendAnnotationImmediate(
			tmpDir,
			makeSessionStart({
				session_id: 'worker-1',
				agent_type: 'worker',
				agent_name: 'claude-code',
				parent_session_id: 'orch-1',
			})
		);

		// Delegation record linking them
		await appendAnnotationImmediate(tmpDir, makeDelegation('orch-1', 'worker-1'));

		const result = await validateDelegationChain(tmpDir);
		expect(result.valid).toBe(true);
		expect(result.totalSessions).toBe(2);
		expect(result.orphanedSessions).toEqual([]);
		expect(result.brokenChains).toEqual([]);
	});

	it('should detect orphaned worker sessions (parent declared, no delegation record)', async () => {
		// Orchestrator
		await appendAnnotationImmediate(
			tmpDir,
			makeSessionStart({
				session_id: 'orch-1',
				agent_type: 'orchestrator',
			})
		);

		// Worker claims parent but no delegation record exists
		await appendAnnotationImmediate(
			tmpDir,
			makeSessionStart({
				session_id: 'worker-orphan',
				agent_type: 'worker',
				parent_session_id: 'orch-1',
			})
		);

		const result = await validateDelegationChain(tmpDir);
		expect(result.valid).toBe(false);
		expect(result.orphanedSessions).toContain('worker-orphan');
		expect(result.brokenChains).toContain('worker-orphan');
	});

	it('should detect broken chains (parent_session_id references wrong parent)', async () => {
		// Two orchestrators
		await appendAnnotationImmediate(
			tmpDir,
			makeSessionStart({
				session_id: 'orch-1',
				agent_type: 'orchestrator',
			})
		);
		await appendAnnotationImmediate(
			tmpDir,
			makeSessionStart({
				session_id: 'orch-2',
				agent_type: 'orchestrator',
			})
		);

		// Worker claims orch-2 as parent
		await appendAnnotationImmediate(
			tmpDir,
			makeSessionStart({
				session_id: 'worker-1',
				agent_type: 'worker',
				parent_session_id: 'orch-2',
			})
		);

		// But delegation record links orch-1 → worker-1 (mismatch)
		await appendAnnotationImmediate(tmpDir, makeDelegation('orch-1', 'worker-1'));

		const result = await validateDelegationChain(tmpDir);
		expect(result.valid).toBe(false);
		// Not orphaned (delegation exists for child), but chain is broken (wrong parent)
		expect(result.brokenChains).toContain('worker-1');
	});

	it('should pass validation for multiple workers under one orchestrator', async () => {
		await appendAnnotationImmediate(
			tmpDir,
			makeSessionStart({
				session_id: 'orch-1',
				agent_type: 'orchestrator',
			})
		);

		// Three workers, all properly delegated
		for (const id of ['worker-1', 'worker-2', 'worker-3']) {
			await appendAnnotationImmediate(
				tmpDir,
				makeSessionStart({
					session_id: id,
					agent_type: 'worker',
					parent_session_id: 'orch-1',
				})
			);
			await appendAnnotationImmediate(tmpDir, makeDelegation('orch-1', id));
		}

		const result = await validateDelegationChain(tmpDir);
		expect(result.valid).toBe(true);
		expect(result.totalSessions).toBe(4);
	});

	it('should allow user-spawned worker sessions without parent (no delegation needed)', async () => {
		// Worker session spawned directly by user — no parent, no delegation needed
		await appendAnnotationImmediate(
			tmpDir,
			makeSessionStart({
				session_id: 'user-worker-1',
				agent_type: 'worker',
				// No parent_session_id
			})
		);

		const result = await validateDelegationChain(tmpDir);
		expect(result.valid).toBe(true);
		expect(result.totalSessions).toBe(1);
	});

	it('should handle Group Chat scenario (moderator orchestrates participants)', async () => {
		// Group Chat moderator as orchestrator
		await appendAnnotationImmediate(
			tmpDir,
			makeSessionStart({
				session_id: 'moderator-1',
				agent_type: 'orchestrator',
				agent_name: 'moderator',
			})
		);

		// Two participants as workers
		await appendAnnotationImmediate(
			tmpDir,
			makeSessionStart({
				session_id: 'participant-1',
				agent_type: 'worker',
				agent_name: 'claude-code',
				parent_session_id: 'moderator-1',
			})
		);
		await appendAnnotationImmediate(tmpDir, makeDelegation('moderator-1', 'participant-1'));

		await appendAnnotationImmediate(
			tmpDir,
			makeSessionStart({
				session_id: 'participant-2',
				agent_type: 'worker',
				agent_name: 'codex',
				parent_session_id: 'moderator-1',
			})
		);
		await appendAnnotationImmediate(tmpDir, makeDelegation('moderator-1', 'participant-2'));

		const result = await validateDelegationChain(tmpDir);
		expect(result.valid).toBe(true);
		expect(result.totalSessions).toBe(3);
	});

	it('should detect mixed valid and invalid chains', async () => {
		// Orchestrator
		await appendAnnotationImmediate(
			tmpDir,
			makeSessionStart({
				session_id: 'orch-1',
				agent_type: 'orchestrator',
			})
		);

		// Valid worker
		await appendAnnotationImmediate(
			tmpDir,
			makeSessionStart({
				session_id: 'worker-ok',
				agent_type: 'worker',
				parent_session_id: 'orch-1',
			})
		);
		await appendAnnotationImmediate(tmpDir, makeDelegation('orch-1', 'worker-ok'));

		// Orphaned worker (claims parent, no delegation)
		await appendAnnotationImmediate(
			tmpDir,
			makeSessionStart({
				session_id: 'worker-bad',
				agent_type: 'worker',
				parent_session_id: 'orch-1',
			})
		);

		const result = await validateDelegationChain(tmpDir);
		expect(result.valid).toBe(false);
		expect(result.totalSessions).toBe(3);
		expect(result.orphanedSessions).toContain('worker-bad');
		expect(result.orphanedSessions).not.toContain('worker-ok');
	});

	it('should not flag non-worker sessions without delegation', async () => {
		// Orchestrator with no children is fine
		await appendAnnotationImmediate(
			tmpDir,
			makeSessionStart({
				session_id: 'orch-1',
				agent_type: 'orchestrator',
			})
		);

		// Session with no agent_type (legacy) and no parent is fine
		await appendAnnotationImmediate(
			tmpDir,
			makeSessionStart({
				session_id: 'legacy-1',
			})
		);

		const result = await validateDelegationChain(tmpDir);
		expect(result.valid).toBe(true);
		expect(result.totalSessions).toBe(2);
	});

	it('should return correct structure shape', async () => {
		const result = await validateDelegationChain(tmpDir);
		expect(result).toHaveProperty('valid');
		expect(result).toHaveProperty('totalSessions');
		expect(result).toHaveProperty('orphanedSessions');
		expect(result).toHaveProperty('brokenChains');
		expect(typeof result.valid).toBe('boolean');
		expect(typeof result.totalSessions).toBe('number');
		expect(Array.isArray(result.orphanedSessions)).toBe(true);
		expect(Array.isArray(result.brokenChains)).toBe(true);
	});
});
