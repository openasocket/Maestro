/**
 * Tests for src/main/vibes/instrumenters/maestro-instrumenter.ts
 * Validates the Maestro orchestration instrumenter: agent spawn/complete handling,
 * batch run start/complete handling, prompt capture gating by assurance level,
 * and inactive/unknown session guards.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

import { MaestroInstrumenter } from '../../../main/vibes/instrumenters/maestro-instrumenter';
import { VibesSessionManager } from '../../../main/vibes/vibes-session';
import {
	readVibesManifest,
	readAnnotations,
	ensureAuditDir,
	flushAll,
	resetAllBuffers,
} from '../../../main/vibes/vibes-io';
import type {
	VibesCommandEntry,
	VibesPromptEntry,
	VibesDelegationRecord,
	VibesEdgeRecord,
} from '../../../shared/vibes-types';

// ============================================================================
// Test Suite
// ============================================================================

describe('maestro-instrumenter', () => {
	const FIXED_ISO = '2026-02-10T12:00:00.000Z';
	let tmpDir: string;
	let manager: VibesSessionManager;

	beforeEach(async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(FIXED_ISO));
		tmpDir = await mkdtemp(path.join(os.tmpdir(), 'vibes-maestro-test-'));
		await ensureAuditDir(tmpDir);
		manager = new VibesSessionManager();
	});

	afterEach(async () => {
		resetAllBuffers();
		vi.useRealTimers();
		await rm(tmpDir, { recursive: true, force: true });
	});

	/**
	 * Helper: start a Maestro session and set up the environment hash.
	 */
	async function setupSession(
		sessionId: string,
		assuranceLevel: 'low' | 'medium' | 'high' = 'medium'
	) {
		const state = await manager.startSession(sessionId, tmpDir, 'maestro', assuranceLevel);
		state.environmentHash = 'e'.repeat(64);
		return state;
	}

	// ========================================================================
	// handleAgentSpawn
	// ========================================================================
	describe('handleAgentSpawn', () => {
		it('should create a command manifest entry for agent dispatch', async () => {
			await setupSession('maestro-1');
			const instrumenter = new MaestroInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			await instrumenter.handleAgentSpawn({
				maestroSessionId: 'maestro-1',
				agentSessionId: 'agent-abc',
				agentType: 'claude-code',
				projectPath: '/home/user/project',
			});

			await flushAll();
			const manifest = await readVibesManifest(tmpDir);
			const entries = Object.values(manifest.entries);
			const cmdEntries = entries.filter((e) => e.type === 'command') as VibesCommandEntry[];
			expect(cmdEntries).toHaveLength(1);
			expect(cmdEntries[0].command_type).toBe('tool_use');
			expect(cmdEntries[0].command_text).toContain('dispatch claude-code agent');
			expect(cmdEntries[0].command_text).toContain('agent-abc');
			expect(cmdEntries[0].working_directory).toBe('/home/user/project');
		});

		it('should create a prompt entry for task description at Medium assurance', async () => {
			await setupSession('maestro-1', 'medium');
			const instrumenter = new MaestroInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			await instrumenter.handleAgentSpawn({
				maestroSessionId: 'maestro-1',
				agentSessionId: 'agent-abc',
				agentType: 'claude-code',
				taskDescription: 'Fix the login page bug',
				projectPath: '/home/user/project',
			});

			await flushAll();
			const manifest = await readVibesManifest(tmpDir);
			const entries = Object.values(manifest.entries);
			const promptEntries = entries.filter((e) => e.type === 'prompt') as VibesPromptEntry[];
			expect(promptEntries).toHaveLength(1);
			expect(promptEntries[0].prompt_text).toBe('Fix the login page bug');
			expect(promptEntries[0].prompt_type).toBe('user_instruction');
		});

		it('should create a prompt entry for task description at High assurance', async () => {
			await setupSession('maestro-1', 'high');
			const instrumenter = new MaestroInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'high',
			});

			await instrumenter.handleAgentSpawn({
				maestroSessionId: 'maestro-1',
				agentSessionId: 'agent-abc',
				agentType: 'codex',
				taskDescription: 'Implement caching layer',
				projectPath: '/home/user/project',
			});

			await flushAll();
			const manifest = await readVibesManifest(tmpDir);
			const entries = Object.values(manifest.entries);
			const promptEntries = entries.filter((e) => e.type === 'prompt');
			expect(promptEntries).toHaveLength(1);
		});

		it('should NOT create a prompt entry at Low assurance', async () => {
			await setupSession('maestro-1', 'low');
			const instrumenter = new MaestroInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'low',
			});

			await instrumenter.handleAgentSpawn({
				maestroSessionId: 'maestro-1',
				agentSessionId: 'agent-abc',
				agentType: 'claude-code',
				taskDescription: 'This prompt should be skipped',
				projectPath: '/home/user/project',
			});

			await flushAll();
			const manifest = await readVibesManifest(tmpDir);
			const entries = Object.values(manifest.entries);
			const promptEntries = entries.filter((e) => e.type === 'prompt');
			expect(promptEntries).toHaveLength(0);
			// But command entry should still be created
			const cmdEntries = entries.filter((e) => e.type === 'command');
			expect(cmdEntries).toHaveLength(1);
		});

		it('should NOT create a prompt entry when taskDescription is undefined', async () => {
			await setupSession('maestro-1', 'medium');
			const instrumenter = new MaestroInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			await instrumenter.handleAgentSpawn({
				maestroSessionId: 'maestro-1',
				agentSessionId: 'agent-abc',
				agentType: 'claude-code',
				projectPath: '/home/user/project',
			});

			await flushAll();
			const manifest = await readVibesManifest(tmpDir);
			const entries = Object.values(manifest.entries);
			const promptEntries = entries.filter((e) => e.type === 'prompt');
			expect(promptEntries).toHaveLength(0);
		});

		it('should be a no-op for unknown session IDs', async () => {
			const instrumenter = new MaestroInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			await instrumenter.handleAgentSpawn({
				maestroSessionId: 'nonexistent',
				agentSessionId: 'agent-abc',
				agentType: 'claude-code',
				projectPath: '/home/user/project',
			});

			await flushAll();
			const manifest = await readVibesManifest(tmpDir);
			expect(Object.keys(manifest.entries)).toHaveLength(0);
		});

		it('should be a no-op for inactive sessions', async () => {
			await setupSession('maestro-1');
			await manager.endSession('maestro-1');

			const instrumenter = new MaestroInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			await instrumenter.handleAgentSpawn({
				maestroSessionId: 'maestro-1',
				agentSessionId: 'agent-abc',
				agentType: 'claude-code',
				projectPath: '/home/user/project',
			});

			await flushAll();
			const manifest = await readVibesManifest(tmpDir);
			expect(Object.keys(manifest.entries)).toHaveLength(0);
		});
	});

	// ========================================================================
	// handleAgentSpawn — Delegation Records (EVOLVE Section 3)
	// ========================================================================
	describe('handleAgentSpawn delegation records', () => {
		it('should emit a delegation record with correct parent/child session IDs', async () => {
			const parentState = await setupSession('maestro-1');
			const instrumenter = new MaestroInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			await instrumenter.handleAgentSpawn({
				maestroSessionId: 'maestro-1',
				agentSessionId: 'agent-abc',
				agentType: 'claude-code',
				taskDescription: 'Fix the auth module',
				projectPath: tmpDir,
				childVibesSessionId: 'child-vibes-uuid-123',
			});

			await flushAll();
			const annotations = await readAnnotations(tmpDir);
			const delegations = annotations.filter(
				(a) => a.type === 'delegation'
			) as VibesDelegationRecord[];

			expect(delegations).toHaveLength(1);
			expect(delegations[0].parent_session_id).toBe(parentState.vibesSessionId);
			expect(delegations[0].child_session_id).toBe('child-vibes-uuid-123');
			expect(delegations[0].task_description).toBe('Fix the auth module');
			expect(delegations[0].delegation_type).toBe('task');
		});

		it('should emit a delegated_to edge record alongside the delegation record', async () => {
			const parentState = await setupSession('maestro-1');
			const instrumenter = new MaestroInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			await instrumenter.handleAgentSpawn({
				maestroSessionId: 'maestro-1',
				agentSessionId: 'agent-abc',
				agentType: 'claude-code',
				projectPath: tmpDir,
				childVibesSessionId: 'child-vibes-uuid-456',
			});

			await flushAll();
			const annotations = await readAnnotations(tmpDir);
			const edges = annotations.filter((a) => a.type === 'edge') as VibesEdgeRecord[];

			expect(edges).toHaveLength(1);
			expect(edges[0].edge_type).toBe('delegated_to');
			expect(edges[0].source_ref).toBe(parentState.vibesSessionId);
			expect(edges[0].source_type).toBe('session');
			expect(edges[0].target_ref).toBe('child-vibes-uuid-456');
			expect(edges[0].target_type).toBe('session');
			expect(edges[0].session_id).toBe(parentState.vibesSessionId);
		});

		it('should include delegated_files and delegation_type when provided', async () => {
			await setupSession('maestro-1');
			const instrumenter = new MaestroInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			await instrumenter.handleAgentSpawn({
				maestroSessionId: 'maestro-1',
				agentSessionId: 'agent-abc',
				agentType: 'claude-code',
				taskDescription: 'Review the PR',
				projectPath: tmpDir,
				childVibesSessionId: 'child-vibes-uuid-789',
				delegatedFiles: ['src/auth.ts', 'src/login.ts'],
				delegationType: 'review',
			});

			await flushAll();
			const annotations = await readAnnotations(tmpDir);
			const delegations = annotations.filter(
				(a) => a.type === 'delegation'
			) as VibesDelegationRecord[];

			expect(delegations).toHaveLength(1);
			expect(delegations[0].delegated_files).toEqual(['src/auth.ts', 'src/login.ts']);
			expect(delegations[0].delegation_type).toBe('review');
		});

		it('should include parent_environment_hash from the session state', async () => {
			await setupSession('maestro-1');
			const instrumenter = new MaestroInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			await instrumenter.handleAgentSpawn({
				maestroSessionId: 'maestro-1',
				agentSessionId: 'agent-abc',
				agentType: 'claude-code',
				projectPath: tmpDir,
				childVibesSessionId: 'child-vibes-uuid',
				childEnvironmentHash: 'c'.repeat(64),
			});

			await flushAll();
			const annotations = await readAnnotations(tmpDir);
			const delegations = annotations.filter(
				(a) => a.type === 'delegation'
			) as VibesDelegationRecord[];

			expect(delegations).toHaveLength(1);
			expect(delegations[0].parent_environment_hash).toBe('e'.repeat(64));
			expect(delegations[0].child_environment_hash).toBe('c'.repeat(64));
		});

		it('should look up child VIBES session ID from session manager when not provided', async () => {
			const parentState = await setupSession('maestro-1');
			// Create a child session in the session manager
			const childState = await manager.startSession('agent-abc', tmpDir, 'claude-code', 'medium');

			const instrumenter = new MaestroInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			await instrumenter.handleAgentSpawn({
				maestroSessionId: 'maestro-1',
				agentSessionId: 'agent-abc',
				agentType: 'claude-code',
				projectPath: tmpDir,
				// No childVibesSessionId — should be looked up
			});

			await flushAll();
			const annotations = await readAnnotations(tmpDir);
			const delegations = annotations.filter(
				(a) => a.type === 'delegation'
			) as VibesDelegationRecord[];

			expect(delegations).toHaveLength(1);
			expect(delegations[0].parent_session_id).toBe(parentState.vibesSessionId);
			expect(delegations[0].child_session_id).toBe(childState.vibesSessionId);
		});

		it('should fall back to agentSessionId when child VIBES session is not available', async () => {
			await setupSession('maestro-1');
			const instrumenter = new MaestroInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			await instrumenter.handleAgentSpawn({
				maestroSessionId: 'maestro-1',
				agentSessionId: 'raw-agent-id',
				agentType: 'claude-code',
				projectPath: tmpDir,
				// No childVibesSessionId and no child session in manager
			});

			await flushAll();
			const annotations = await readAnnotations(tmpDir);
			const delegations = annotations.filter(
				(a) => a.type === 'delegation'
			) as VibesDelegationRecord[];

			expect(delegations).toHaveLength(1);
			expect(delegations[0].child_session_id).toBe('raw-agent-id');
		});

		it('should default delegation_type to task when not specified', async () => {
			await setupSession('maestro-1');
			const instrumenter = new MaestroInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			await instrumenter.handleAgentSpawn({
				maestroSessionId: 'maestro-1',
				agentSessionId: 'agent-abc',
				agentType: 'claude-code',
				projectPath: tmpDir,
				childVibesSessionId: 'child-uuid',
			});

			await flushAll();
			const annotations = await readAnnotations(tmpDir);
			const delegations = annotations.filter(
				(a) => a.type === 'delegation'
			) as VibesDelegationRecord[];

			expect(delegations).toHaveLength(1);
			expect(delegations[0].delegation_type).toBe('task');
		});

		it('should emit delegation records even at Low assurance (prompts are skipped, not delegations)', async () => {
			await setupSession('maestro-1', 'low');
			const instrumenter = new MaestroInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'low',
			});

			await instrumenter.handleAgentSpawn({
				maestroSessionId: 'maestro-1',
				agentSessionId: 'agent-abc',
				agentType: 'claude-code',
				taskDescription: 'Should appear in delegation but not as prompt',
				projectPath: tmpDir,
				childVibesSessionId: 'child-uuid',
			});

			await flushAll();
			const annotations = await readAnnotations(tmpDir);
			const delegations = annotations.filter((a) => a.type === 'delegation');
			const edges = annotations.filter((a) => a.type === 'edge');

			// Delegation and edge records are always emitted regardless of assurance level
			expect(delegations).toHaveLength(1);
			expect(edges).toHaveLength(1);

			// But prompts are gated by assurance level
			const manifest = await readVibesManifest(tmpDir);
			const promptEntries = Object.values(manifest.entries).filter((e) => e.type === 'prompt');
			expect(promptEntries).toHaveLength(0);
		});
	});

	// ========================================================================
	// handleAgentComplete
	// ========================================================================
	describe('handleAgentComplete', () => {
		it('should create a command entry for successful agent completion', async () => {
			await setupSession('maestro-1');
			const instrumenter = new MaestroInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			await instrumenter.handleAgentComplete({
				maestroSessionId: 'maestro-1',
				agentSessionId: 'agent-abc',
				agentType: 'claude-code',
				success: true,
				duration: 45000,
			});

			await flushAll();
			const manifest = await readVibesManifest(tmpDir);
			const entries = Object.values(manifest.entries);
			const cmdEntries = entries.filter((e) => e.type === 'command') as VibesCommandEntry[];
			expect(cmdEntries).toHaveLength(1);
			expect(cmdEntries[0].command_type).toBe('tool_use');
			expect(cmdEntries[0].command_text).toContain('claude-code agent complete');
			expect(cmdEntries[0].command_text).toContain('agent-abc');
			expect(cmdEntries[0].command_exit_code).toBe(0);
			expect(cmdEntries[0].command_output_summary).toContain('completed successfully');
			expect(cmdEntries[0].command_output_summary).toContain('45.0s');
		});

		it('should record exit code 1 for failed agent completion', async () => {
			await setupSession('maestro-1');
			const instrumenter = new MaestroInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			await instrumenter.handleAgentComplete({
				maestroSessionId: 'maestro-1',
				agentSessionId: 'agent-xyz',
				agentType: 'codex',
				success: false,
				duration: 12500,
			});

			await flushAll();
			const manifest = await readVibesManifest(tmpDir);
			const entries = Object.values(manifest.entries);
			const cmdEntries = entries.filter((e) => e.type === 'command') as VibesCommandEntry[];
			expect(cmdEntries).toHaveLength(1);
			expect(cmdEntries[0].command_exit_code).toBe(1);
			expect(cmdEntries[0].command_output_summary).toContain('failed');
			expect(cmdEntries[0].command_output_summary).toContain('12.5s');
		});

		it('should be a no-op for unknown session IDs', async () => {
			const instrumenter = new MaestroInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			await instrumenter.handleAgentComplete({
				maestroSessionId: 'nonexistent',
				agentSessionId: 'agent-abc',
				agentType: 'claude-code',
				success: true,
				duration: 1000,
			});

			await flushAll();
			const manifest = await readVibesManifest(tmpDir);
			expect(Object.keys(manifest.entries)).toHaveLength(0);
		});

		it('should be a no-op for inactive sessions', async () => {
			await setupSession('maestro-1');
			await manager.endSession('maestro-1');

			const instrumenter = new MaestroInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			await instrumenter.handleAgentComplete({
				maestroSessionId: 'maestro-1',
				agentSessionId: 'agent-abc',
				agentType: 'claude-code',
				success: true,
				duration: 1000,
			});

			await flushAll();
			const manifest = await readVibesManifest(tmpDir);
			expect(Object.keys(manifest.entries)).toHaveLength(0);
		});
	});

	// ========================================================================
	// handleBatchRunStart
	// ========================================================================
	describe('handleBatchRunStart', () => {
		it('should create a command entry for batch run start', async () => {
			await setupSession('maestro-1');
			const instrumenter = new MaestroInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			await instrumenter.handleBatchRunStart({
				maestroSessionId: 'maestro-1',
				projectPath: '/home/user/project',
				documents: ['task-01.md', 'task-02.md', 'task-03.md'],
				agentType: 'claude-code',
			});

			await flushAll();
			const manifest = await readVibesManifest(tmpDir);
			const entries = Object.values(manifest.entries);
			const cmdEntries = entries.filter((e) => e.type === 'command') as VibesCommandEntry[];
			expect(cmdEntries).toHaveLength(1);
			expect(cmdEntries[0].command_type).toBe('tool_use');
			expect(cmdEntries[0].command_text).toContain('batch run start');
			expect(cmdEntries[0].command_text).toContain('3 document(s)');
			expect(cmdEntries[0].command_text).toContain('claude-code');
			expect(cmdEntries[0].working_directory).toBe('/home/user/project');
			expect(cmdEntries[0].command_output_summary).toContain('task-01.md');
			expect(cmdEntries[0].command_output_summary).toContain('task-02.md');
			expect(cmdEntries[0].command_output_summary).toContain('task-03.md');
		});

		it('should handle a single document', async () => {
			await setupSession('maestro-1');
			const instrumenter = new MaestroInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			await instrumenter.handleBatchRunStart({
				maestroSessionId: 'maestro-1',
				projectPath: '/home/user/project',
				documents: ['only-one.md'],
				agentType: 'codex',
			});

			await flushAll();
			const manifest = await readVibesManifest(tmpDir);
			const entries = Object.values(manifest.entries);
			const cmdEntries = entries.filter((e) => e.type === 'command') as VibesCommandEntry[];
			expect(cmdEntries).toHaveLength(1);
			expect(cmdEntries[0].command_text).toContain('1 document(s)');
			expect(cmdEntries[0].command_text).toContain('codex');
		});

		it('should be a no-op for unknown session IDs', async () => {
			const instrumenter = new MaestroInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			await instrumenter.handleBatchRunStart({
				maestroSessionId: 'nonexistent',
				projectPath: '/home/user/project',
				documents: ['task.md'],
				agentType: 'claude-code',
			});

			await flushAll();
			const manifest = await readVibesManifest(tmpDir);
			expect(Object.keys(manifest.entries)).toHaveLength(0);
		});

		it('should be a no-op for inactive sessions', async () => {
			await setupSession('maestro-1');
			await manager.endSession('maestro-1');

			const instrumenter = new MaestroInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			await instrumenter.handleBatchRunStart({
				maestroSessionId: 'maestro-1',
				projectPath: '/home/user/project',
				documents: ['task.md'],
				agentType: 'claude-code',
			});

			await flushAll();
			const manifest = await readVibesManifest(tmpDir);
			expect(Object.keys(manifest.entries)).toHaveLength(0);
		});

		it('should truncate long document lists in output summary', async () => {
			await setupSession('maestro-1');
			const instrumenter = new MaestroInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			const longDocs = Array.from({ length: 50 }, (_, i) => `very-long-document-name-${i}.md`);
			await instrumenter.handleBatchRunStart({
				maestroSessionId: 'maestro-1',
				projectPath: '/home/user/project',
				documents: longDocs,
				agentType: 'claude-code',
			});

			await flushAll();
			const manifest = await readVibesManifest(tmpDir);
			const entries = Object.values(manifest.entries);
			const cmdEntries = entries.filter((e) => e.type === 'command') as VibesCommandEntry[];
			expect(cmdEntries).toHaveLength(1);
			if (cmdEntries[0].command_output_summary) {
				expect(cmdEntries[0].command_output_summary.length).toBeLessThanOrEqual(200);
			}
		});
	});

	// ========================================================================
	// handleBatchRunComplete
	// ========================================================================
	describe('handleBatchRunComplete', () => {
		it('should create a command entry for batch run completion', async () => {
			await setupSession('maestro-1');
			const instrumenter = new MaestroInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			await instrumenter.handleBatchRunComplete({
				maestroSessionId: 'maestro-1',
				documentsCompleted: 5,
				totalTasks: 12,
			});

			await flushAll();
			const manifest = await readVibesManifest(tmpDir);
			const entries = Object.values(manifest.entries);
			const cmdEntries = entries.filter((e) => e.type === 'command') as VibesCommandEntry[];
			expect(cmdEntries).toHaveLength(1);
			expect(cmdEntries[0].command_type).toBe('tool_use');
			expect(cmdEntries[0].command_text).toContain('batch run complete');
			expect(cmdEntries[0].command_text).toContain('5 document(s)');
			expect(cmdEntries[0].command_exit_code).toBe(0);
			expect(cmdEntries[0].command_output_summary).toContain('5 document(s)');
			expect(cmdEntries[0].command_output_summary).toContain('12 total task(s)');
		});

		it('should handle zero documents completed', async () => {
			await setupSession('maestro-1');
			const instrumenter = new MaestroInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			await instrumenter.handleBatchRunComplete({
				maestroSessionId: 'maestro-1',
				documentsCompleted: 0,
				totalTasks: 0,
			});

			await flushAll();
			const manifest = await readVibesManifest(tmpDir);
			const entries = Object.values(manifest.entries);
			const cmdEntries = entries.filter((e) => e.type === 'command') as VibesCommandEntry[];
			expect(cmdEntries).toHaveLength(1);
			expect(cmdEntries[0].command_text).toContain('0 document(s)');
		});

		it('should be a no-op for unknown session IDs', async () => {
			const instrumenter = new MaestroInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			await instrumenter.handleBatchRunComplete({
				maestroSessionId: 'nonexistent',
				documentsCompleted: 5,
				totalTasks: 10,
			});

			await flushAll();
			const manifest = await readVibesManifest(tmpDir);
			expect(Object.keys(manifest.entries)).toHaveLength(0);
		});

		it('should be a no-op for inactive sessions', async () => {
			await setupSession('maestro-1');
			await manager.endSession('maestro-1');

			const instrumenter = new MaestroInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			await instrumenter.handleBatchRunComplete({
				maestroSessionId: 'maestro-1',
				documentsCompleted: 5,
				totalTasks: 10,
			});

			await flushAll();
			const manifest = await readVibesManifest(tmpDir);
			expect(Object.keys(manifest.entries)).toHaveLength(0);
		});
	});

	// ========================================================================
	// Integration: Full Orchestration Cycle
	// ========================================================================
	describe('integration', () => {
		it('should handle a full orchestration cycle: batch start → spawn → complete → batch complete', async () => {
			await setupSession('maestro-1', 'medium');
			const instrumenter = new MaestroInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			// 1. Batch run starts
			await instrumenter.handleBatchRunStart({
				maestroSessionId: 'maestro-1',
				projectPath: '/home/user/project',
				documents: ['task-01.md', 'task-02.md'],
				agentType: 'claude-code',
			});

			// 2. Agent spawned for first task
			await instrumenter.handleAgentSpawn({
				maestroSessionId: 'maestro-1',
				agentSessionId: 'agent-001',
				agentType: 'claude-code',
				taskDescription: 'Implement feature A',
				projectPath: '/home/user/project',
			});

			// 3. Agent completes first task
			await instrumenter.handleAgentComplete({
				maestroSessionId: 'maestro-1',
				agentSessionId: 'agent-001',
				agentType: 'claude-code',
				success: true,
				duration: 30000,
			});

			// 4. Agent spawned for second task
			await instrumenter.handleAgentSpawn({
				maestroSessionId: 'maestro-1',
				agentSessionId: 'agent-002',
				agentType: 'claude-code',
				taskDescription: 'Fix bug B',
				projectPath: '/home/user/project',
			});

			// 5. Agent completes second task
			await instrumenter.handleAgentComplete({
				maestroSessionId: 'maestro-1',
				agentSessionId: 'agent-002',
				agentType: 'claude-code',
				success: true,
				duration: 15000,
			});

			// 6. Batch run completes
			await instrumenter.handleBatchRunComplete({
				maestroSessionId: 'maestro-1',
				documentsCompleted: 2,
				totalTasks: 4,
			});

			// Verify: should have batch start + 2 spawns + 2 completes + batch complete = 6 command entries
			// Plus 2 prompt entries (Medium assurance, with task descriptions)
			await flushAll();
			const manifest = await readVibesManifest(tmpDir);
			const entries = Object.values(manifest.entries);
			const cmdEntries = entries.filter((e) => e.type === 'command');
			const promptEntries = entries.filter((e) => e.type === 'prompt');

			expect(cmdEntries).toHaveLength(6);
			expect(promptEntries).toHaveLength(2);
		});

		it('should not record prompts in a full cycle at Low assurance', async () => {
			await setupSession('maestro-1', 'low');
			const instrumenter = new MaestroInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'low',
			});

			await instrumenter.handleBatchRunStart({
				maestroSessionId: 'maestro-1',
				projectPath: '/home/user/project',
				documents: ['task.md'],
				agentType: 'claude-code',
			});

			await instrumenter.handleAgentSpawn({
				maestroSessionId: 'maestro-1',
				agentSessionId: 'agent-001',
				agentType: 'claude-code',
				taskDescription: 'This should not be recorded',
				projectPath: '/home/user/project',
			});

			await instrumenter.handleAgentComplete({
				maestroSessionId: 'maestro-1',
				agentSessionId: 'agent-001',
				agentType: 'claude-code',
				success: true,
				duration: 5000,
			});

			await instrumenter.handleBatchRunComplete({
				maestroSessionId: 'maestro-1',
				documentsCompleted: 1,
				totalTasks: 1,
			});

			await flushAll();
			const manifest = await readVibesManifest(tmpDir);
			const entries = Object.values(manifest.entries);
			const cmdEntries = entries.filter((e) => e.type === 'command');
			const promptEntries = entries.filter((e) => e.type === 'prompt');

			// 4 command entries: batch start, spawn, complete, batch complete
			expect(cmdEntries).toHaveLength(4);
			// No prompts at low assurance
			expect(promptEntries).toHaveLength(0);
		});

		it('should handle multiple sequential agent spawns', async () => {
			await setupSession('maestro-1', 'medium');
			const instrumenter = new MaestroInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			// Spawn two agents sequentially (manifest file I/O is not concurrency-safe)
			await instrumenter.handleAgentSpawn({
				maestroSessionId: 'maestro-1',
				agentSessionId: 'agent-001',
				agentType: 'claude-code',
				taskDescription: 'Task A',
				projectPath: '/home/user/project',
			});
			await instrumenter.handleAgentSpawn({
				maestroSessionId: 'maestro-1',
				agentSessionId: 'agent-002',
				agentType: 'codex',
				taskDescription: 'Task B',
				projectPath: '/home/user/project',
			});

			await flushAll();
			const manifest = await readVibesManifest(tmpDir);
			const entries = Object.values(manifest.entries);
			const cmdEntries = entries.filter((e) => e.type === 'command');
			const promptEntries = entries.filter((e) => e.type === 'prompt');

			// 2 spawn commands + 2 prompt entries
			expect(cmdEntries).toHaveLength(2);
			expect(promptEntries).toHaveLength(2);
		});
	});

	// ========================================================================
	// Error Handling
	// ========================================================================
	describe('error handling', () => {
		it('should not throw when handleAgentSpawn encounters an error', async () => {
			const instrumenter = new MaestroInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			// No session created — should be a graceful no-op
			await expect(
				instrumenter.handleAgentSpawn({
					maestroSessionId: 'nonexistent',
					agentSessionId: 'agent-abc',
					agentType: 'claude-code',
					projectPath: '/tmp/test',
				})
			).resolves.not.toThrow();
		});

		it('should not throw when handleAgentComplete encounters an error', async () => {
			const instrumenter = new MaestroInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			await expect(
				instrumenter.handleAgentComplete({
					maestroSessionId: 'nonexistent',
					agentSessionId: 'agent-abc',
					agentType: 'claude-code',
					success: true,
					duration: 1000,
				})
			).resolves.not.toThrow();
		});

		it('should not throw when handleBatchRunStart encounters an error', async () => {
			const instrumenter = new MaestroInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			await expect(
				instrumenter.handleBatchRunStart({
					maestroSessionId: 'nonexistent',
					projectPath: '/tmp/test',
					documents: ['doc.md'],
					agentType: 'claude-code',
				})
			).resolves.not.toThrow();
		});

		it('should not throw when handleBatchRunComplete encounters an error', async () => {
			const instrumenter = new MaestroInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			await expect(
				instrumenter.handleBatchRunComplete({
					maestroSessionId: 'nonexistent',
					documentsCompleted: 0,
					totalTasks: 0,
				})
			).resolves.not.toThrow();
		});
	});

	// ========================================================================
	// Maestro Version Handling
	// ========================================================================
	describe('maestro version', () => {
		it('should default to unknown when no version is provided', () => {
			const instrumenter = new MaestroInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			expect(instrumenter.getMaestroVersion()).toBe('unknown');
		});

		it('should accept version in constructor', () => {
			const instrumenter = new MaestroInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
				maestroVersion: '2.1.0',
			});

			expect(instrumenter.getMaestroVersion()).toBe('2.1.0');
		});

		it('should allow updating version via setMaestroVersion', () => {
			const instrumenter = new MaestroInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			instrumenter.setMaestroVersion('3.0.0');
			expect(instrumenter.getMaestroVersion()).toBe('3.0.0');
		});

		it('should fall back to unknown when empty string is set', () => {
			const instrumenter = new MaestroInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			instrumenter.setMaestroVersion('');
			expect(instrumenter.getMaestroVersion()).toBe('unknown');
		});
	});
});
