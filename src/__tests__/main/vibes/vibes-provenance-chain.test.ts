/**
 * Integration Test: VIBES End-to-End Provenance Chain
 *
 * Tests the full VIBES pipeline: session start (with environment_hash) →
 * prompt capture (with prompt_hash on annotations) → tool execution (with
 * command_hash) → reasoning capture (with reasoning_hash, compression, blobs)
 * → session end → manifest integrity.
 *
 * Validates all three assurance levels (high, medium, low) to ensure proper
 * gating of prompt_hash and reasoning_hash on line annotations.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

import { ClaudeCodeInstrumenter } from '../../../main/vibes/instrumenters/claude-code-instrumenter';
import { VibesSessionManager } from '../../../main/vibes/vibes-session';
import { createEnvironmentEntry } from '../../../main/vibes/vibes-annotations';
import {
	readAnnotations,
	readVibesManifest,
	initVibesDirectly,
	flushAll,
	resetAllBuffers,
	addManifestEntry,
} from '../../../main/vibes/vibes-io';
import type {
	VibesAssuranceLevel,
	VibesLineAnnotation,
	VibesCommandEntry,
	VibesPromptEntry,
	VibesReasoningEntry,
	VibesSessionRecord,
} from '../../../shared/vibes-types';

// ============================================================================
// Test Suite
// ============================================================================

describe('vibes-provenance-chain', () => {
	const FIXED_ISO = '2026-02-10T12:00:00.000Z';
	let tmpDir: string;

	beforeEach(async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(FIXED_ISO));
		tmpDir = await mkdtemp(path.join(os.tmpdir(), 'vibes-provenance-chain-'));
		await initVibesDirectly(tmpDir, {
			projectName: 'provenance-chain-test',
			assuranceLevel: 'high',
		});
	});

	afterEach(async () => {
		resetAllBuffers();
		vi.useRealTimers();
		await rm(tmpDir, { recursive: true, force: true });
	});

	// ========================================================================
	// Helper: Run the full pipeline for a given assurance level
	// ========================================================================

	async function runFullPipeline(assuranceLevel: VibesAssuranceLevel) {
		const manager = new VibesSessionManager();
		const sessionId = `sess-${assuranceLevel}`;

		// Create environment entry and get its hash
		const { entry: envEntry, hash: envHash } = createEnvironmentEntry({
			toolName: 'Claude Code',
			toolVersion: '1.0.0',
			modelName: 'claude-4-opus',
			modelVersion: 'opus',
		});
		await addManifestEntry(tmpDir, envHash, envEntry);

		// Start session with environment hash
		const state = await manager.startSession(
			sessionId,
			tmpDir,
			'claude-code',
			assuranceLevel,
			envHash
		);

		const instrumenter = new ClaudeCodeInstrumenter({
			sessionManager: manager,
			assuranceLevel,
		});

		// Capture prompt
		await instrumenter.handlePrompt(sessionId, 'Refactor the main function');

		// Buffer reasoning chunks
		instrumenter.handleThinkingChunk(sessionId, 'Analyzing the code structure. ');
		instrumenter.handleThinkingChunk(sessionId, 'The main function should be split.');

		// Execute Write tool (triggers reasoning flush + line annotation)
		await instrumenter.handleToolExecution(sessionId, {
			toolName: 'Write',
			state: { status: 'running', input: { file_path: 'src/main.ts' } },
			timestamp: Date.now(),
		});

		// End session
		await manager.endSession(sessionId);
		await flushAll();

		return { manager, state, envHash };
	}

	// ========================================================================
	// 1. Session Start
	// ========================================================================

	describe('session start', () => {
		it('should create a session start annotation with environment_hash', async () => {
			const manager = new VibesSessionManager();
			const { hash: envHash } = createEnvironmentEntry({
				toolName: 'Claude Code',
				toolVersion: '1.0.0',
				modelName: 'claude-4-opus',
				modelVersion: 'opus',
			});

			await manager.startSession('sess-1', tmpDir, 'claude-code', 'high', envHash);
			await flushAll();

			const annotations = await readAnnotations(tmpDir);
			const sessionAnnotations = annotations.filter(
				(a) => a.type === 'session'
			) as VibesSessionRecord[];
			const startRecord = sessionAnnotations.find((a) => a.event === 'start');

			expect(startRecord).toBeDefined();
			expect(startRecord!.environment_hash).toBe(envHash);
			expect(startRecord!.assurance_level).toBe('high');
		});
	});

	// ========================================================================
	// 2. Prompt Capture
	// ========================================================================

	describe('prompt capture', () => {
		it('should create a prompt manifest entry at high assurance', async () => {
			const manager = new VibesSessionManager();
			const state = await manager.startSession('sess-1', tmpDir, 'claude-code', 'high');
			state.environmentHash = 'e'.repeat(64);

			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'high',
			});

			await instrumenter.handlePrompt('sess-1', 'Fix the auth bug', ['src/auth.ts']);
			await flushAll();

			const manifest = await readVibesManifest(tmpDir);
			const entries = Object.values(manifest.entries);
			const promptEntries = entries.filter((e) => e.type === 'prompt') as VibesPromptEntry[];

			expect(promptEntries).toHaveLength(1);
			expect(promptEntries[0].prompt_text).toBe('Fix the auth bug');
			expect(promptEntries[0].prompt_type).toBe('user_instruction');
			expect(promptEntries[0].prompt_context_files).toEqual(['src/auth.ts']);
		});

		it('should create a prompt manifest entry at medium assurance', async () => {
			const manager = new VibesSessionManager();
			const state = await manager.startSession('sess-1', tmpDir, 'claude-code', 'medium');
			state.environmentHash = 'e'.repeat(64);

			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			await instrumenter.handlePrompt('sess-1', 'Refactor this code');
			await flushAll();

			const manifest = await readVibesManifest(tmpDir);
			const entries = Object.values(manifest.entries);
			const promptEntries = entries.filter((e) => e.type === 'prompt') as VibesPromptEntry[];

			expect(promptEntries).toHaveLength(1);
			expect(promptEntries[0].prompt_text).toBe('Refactor this code');
		});

		it('should NOT capture prompt at low assurance', async () => {
			const manager = new VibesSessionManager();
			const state = await manager.startSession('sess-1', tmpDir, 'claude-code', 'low');
			state.environmentHash = 'e'.repeat(64);

			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'low',
			});

			await instrumenter.handlePrompt('sess-1', 'Should not appear');
			await flushAll();

			const manifest = await readVibesManifest(tmpDir);
			const entries = Object.values(manifest.entries);
			const promptEntries = entries.filter((e) => e.type === 'prompt');

			expect(promptEntries).toHaveLength(0);
		});
	});

	// ========================================================================
	// 3. Reasoning Capture
	// ========================================================================

	describe('reasoning capture', () => {
		it('should buffer thinking chunks and flush on tool execution at high assurance', async () => {
			const manager = new VibesSessionManager();
			const state = await manager.startSession('sess-1', tmpDir, 'claude-code', 'high');
			state.environmentHash = 'e'.repeat(64);

			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'high',
			});

			instrumenter.handleThinkingChunk('sess-1', 'First chunk. ');
			instrumenter.handleThinkingChunk('sess-1', 'Second chunk.');

			await instrumenter.handleToolExecution('sess-1', {
				toolName: 'Write',
				state: { status: 'running', input: { file_path: 'src/app.ts' } },
				timestamp: Date.now(),
			});

			await flushAll();

			const manifest = await readVibesManifest(tmpDir);
			const entries = Object.values(manifest.entries);
			const reasoningEntries = entries.filter(
				(e) => e.type === 'reasoning'
			) as VibesReasoningEntry[];

			expect(reasoningEntries).toHaveLength(1);
			expect(reasoningEntries[0].reasoning_text).toBe('First chunk. Second chunk.');
		});

		it('should NOT capture reasoning at medium assurance', async () => {
			const manager = new VibesSessionManager();
			const state = await manager.startSession('sess-1', tmpDir, 'claude-code', 'medium');
			state.environmentHash = 'e'.repeat(64);

			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			instrumenter.handleThinkingChunk('sess-1', 'Should not be captured');

			await instrumenter.handleToolExecution('sess-1', {
				toolName: 'Write',
				state: { status: 'running', input: { file_path: 'src/app.ts' } },
				timestamp: Date.now(),
			});

			await flushAll();

			const manifest = await readVibesManifest(tmpDir);
			const entries = Object.values(manifest.entries);
			const reasoningEntries = entries.filter((e) => e.type === 'reasoning');

			expect(reasoningEntries).toHaveLength(0);
		});
	});

	// ========================================================================
	// 4. Tool Execution
	// ========================================================================

	describe('tool execution', () => {
		it('should create command entry and line annotation with all hashes at high assurance', async () => {
			const manager = new VibesSessionManager();
			const { hash: envHash, entry: envEntry } = createEnvironmentEntry({
				toolName: 'Claude Code',
				toolVersion: '1.0.0',
				modelName: 'claude-4-opus',
				modelVersion: 'opus',
			});
			await addManifestEntry(tmpDir, envHash, envEntry);

			const state = await manager.startSession('sess-1', tmpDir, 'claude-code', 'high', envHash);

			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'high',
			});

			// Prompt → sets lastPromptHash
			await instrumenter.handlePrompt('sess-1', 'Add error handling');

			// Reasoning → sets lastReasoningHash (flushed during tool execution)
			instrumenter.handleThinkingChunk('sess-1', 'I should add try/catch blocks.');

			// Tool execution → creates command entry + line annotation
			await instrumenter.handleToolExecution('sess-1', {
				toolName: 'Edit',
				state: { status: 'running', input: { file_path: 'src/handler.ts' } },
				timestamp: Date.now(),
			});

			await flushAll();

			// Verify command entry in manifest
			const manifest = await readVibesManifest(tmpDir);
			const entries = Object.values(manifest.entries);
			const cmdEntries = entries.filter((e) => e.type === 'command') as VibesCommandEntry[];
			expect(cmdEntries.length).toBeGreaterThanOrEqual(1);

			// Verify line annotation with all hash references
			const annotations = await readAnnotations(tmpDir);
			const lineAnnotations = annotations.filter((a) => a.type === 'line') as VibesLineAnnotation[];
			expect(lineAnnotations).toHaveLength(1);

			const line = lineAnnotations[0];
			expect(line.environment_hash).toBe(envHash);
			expect(line.command_hash).toBeDefined();
			expect(line.prompt_hash).toBeDefined();
			expect(line.reasoning_hash).toBeDefined();
			expect(line.action).toBe('modify');
			expect(line.assurance_level).toBe('high');
		});

		it('should have prompt_hash but NO reasoning_hash at medium assurance', async () => {
			const manager = new VibesSessionManager();
			const state = await manager.startSession('sess-1', tmpDir, 'claude-code', 'medium');
			state.environmentHash = 'e'.repeat(64);

			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			await instrumenter.handlePrompt('sess-1', 'Fix the bug');
			instrumenter.handleThinkingChunk('sess-1', 'Thinking about it...');

			await instrumenter.handleToolExecution('sess-1', {
				toolName: 'Write',
				state: { status: 'running', input: { file_path: 'src/fix.ts' } },
				timestamp: Date.now(),
			});

			await flushAll();

			const annotations = await readAnnotations(tmpDir);
			const lineAnnotations = annotations.filter((a) => a.type === 'line') as VibesLineAnnotation[];
			expect(lineAnnotations).toHaveLength(1);

			const line = lineAnnotations[0];
			expect(line.environment_hash).toBe('e'.repeat(64));
			expect(line.command_hash).toBeDefined();
			expect(line.prompt_hash).toBeDefined();
			expect(line.reasoning_hash).toBeNull();
			expect(line.assurance_level).toBe('medium');
		});

		it('should have NO prompt_hash and NO reasoning_hash at low assurance', async () => {
			const manager = new VibesSessionManager();
			const state = await manager.startSession('sess-1', tmpDir, 'claude-code', 'low');
			state.environmentHash = 'e'.repeat(64);

			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'low',
			});

			await instrumenter.handlePrompt('sess-1', 'Should not be tracked');
			instrumenter.handleThinkingChunk('sess-1', 'Should not be captured');

			await instrumenter.handleToolExecution('sess-1', {
				toolName: 'Write',
				state: { status: 'running', input: { file_path: 'src/low.ts' } },
				timestamp: Date.now(),
			});

			await flushAll();

			const annotations = await readAnnotations(tmpDir);
			const lineAnnotations = annotations.filter((a) => a.type === 'line') as VibesLineAnnotation[];
			expect(lineAnnotations).toHaveLength(1);

			const line = lineAnnotations[0];
			expect(line.environment_hash).toBe('e'.repeat(64));
			expect(line.command_hash).toBeDefined();
			expect(line.prompt_hash).toBeNull();
			expect(line.reasoning_hash).toBeNull();
			expect(line.assurance_level).toBe('low');
		});
	});

	// ========================================================================
	// 5. Session End
	// ========================================================================

	describe('session end', () => {
		it('should create a session end annotation with environment_hash', async () => {
			const manager = new VibesSessionManager();
			const { hash: envHash } = createEnvironmentEntry({
				toolName: 'Claude Code',
				toolVersion: '1.0.0',
				modelName: 'claude-4-opus',
				modelVersion: 'opus',
			});

			const state = await manager.startSession('sess-1', tmpDir, 'claude-code', 'high', envHash);
			await manager.endSession('sess-1');

			const annotations = await readAnnotations(tmpDir);
			const sessionAnnotations = annotations.filter(
				(a) => a.type === 'session'
			) as VibesSessionRecord[];
			const endRecord = sessionAnnotations.find((a) => a.event === 'end');

			expect(endRecord).toBeDefined();
			expect(endRecord!.environment_hash).toBe(envHash);
			expect(endRecord!.assurance_level).toBe('high');
		});
	});

	// ========================================================================
	// 6. Full Pipeline at All Assurance Levels
	// ========================================================================

	describe('full pipeline', () => {
		it('should produce complete provenance chain at high assurance', async () => {
			const { envHash } = await runFullPipeline('high');

			const manifest = await readVibesManifest(tmpDir);
			const annotations = await readAnnotations(tmpDir);

			// Manifest should have: environment, command, prompt, reasoning entries
			const entries = Object.values(manifest.entries);
			expect(entries.some((e) => e.type === 'environment')).toBe(true);
			expect(entries.some((e) => e.type === 'command')).toBe(true);
			expect(entries.some((e) => e.type === 'prompt')).toBe(true);
			expect(entries.some((e) => e.type === 'reasoning')).toBe(true);

			// Annotations should have: session start, line annotation, session end
			const sessionRecords = annotations.filter(
				(a) => a.type === 'session'
			) as VibesSessionRecord[];
			expect(sessionRecords.filter((a) => a.event === 'start')).toHaveLength(1);
			expect(sessionRecords.filter((a) => a.event === 'end')).toHaveLength(1);

			const lineAnnotations = annotations.filter((a) => a.type === 'line') as VibesLineAnnotation[];
			expect(lineAnnotations).toHaveLength(1);

			// Line annotation should have all hashes at high assurance
			const line = lineAnnotations[0];
			expect(line.environment_hash).toBe(envHash);
			expect(line.command_hash).toBeDefined();
			expect(line.prompt_hash).toBeDefined();
			expect(line.reasoning_hash).toBeDefined();
		});

		it('should produce provenance chain without reasoning at medium assurance', async () => {
			await runFullPipeline('medium');

			const manifest = await readVibesManifest(tmpDir);
			const annotations = await readAnnotations(tmpDir);

			const entries = Object.values(manifest.entries);
			// Should have environment, command, prompt — but NO reasoning
			expect(entries.some((e) => e.type === 'environment')).toBe(true);
			expect(entries.some((e) => e.type === 'command')).toBe(true);
			expect(entries.some((e) => e.type === 'prompt')).toBe(true);
			expect(entries.some((e) => e.type === 'reasoning')).toBe(false);

			const lineAnnotations = annotations.filter((a) => a.type === 'line') as VibesLineAnnotation[];
			expect(lineAnnotations).toHaveLength(1);
			expect(lineAnnotations[0].prompt_hash).toBeDefined();
			expect(lineAnnotations[0].reasoning_hash).toBeNull();
		});

		it('should produce minimal provenance chain at low assurance', async () => {
			await runFullPipeline('low');

			const manifest = await readVibesManifest(tmpDir);
			const annotations = await readAnnotations(tmpDir);

			const entries = Object.values(manifest.entries);
			// Should have environment and command — but NO prompt or reasoning
			expect(entries.some((e) => e.type === 'environment')).toBe(true);
			expect(entries.some((e) => e.type === 'command')).toBe(true);
			expect(entries.some((e) => e.type === 'prompt')).toBe(false);
			expect(entries.some((e) => e.type === 'reasoning')).toBe(false);

			const lineAnnotations = annotations.filter((a) => a.type === 'line') as VibesLineAnnotation[];
			expect(lineAnnotations).toHaveLength(1);
			expect(lineAnnotations[0].prompt_hash).toBeNull();
			expect(lineAnnotations[0].reasoning_hash).toBeNull();
		});
	});

	// ========================================================================
	// 7. Manifest Integrity
	// ========================================================================

	describe('manifest integrity', () => {
		it('should have all hashes referenced by annotations present in manifest entries', async () => {
			await runFullPipeline('high');

			const manifest = await readVibesManifest(tmpDir);
			const annotations = await readAnnotations(tmpDir);

			// Collect all hash references from annotations
			const referencedHashes = new Set<string>();

			for (const annotation of annotations) {
				if ('environment_hash' in annotation && annotation.environment_hash) {
					referencedHashes.add(annotation.environment_hash);
				}
				if (annotation.type === 'line' || annotation.type === 'function') {
					if (annotation.command_hash) {
						referencedHashes.add(annotation.command_hash);
					}
					if (annotation.prompt_hash) {
						referencedHashes.add(annotation.prompt_hash);
					}
					if (annotation.reasoning_hash) {
						referencedHashes.add(annotation.reasoning_hash);
					}
				}
			}

			// All referenced hashes must exist as keys in manifest.entries
			for (const hash of referencedHashes) {
				expect(manifest.entries[hash]).toBeDefined();
			}

			// Should have at least 4 distinct hashes at high assurance
			// (environment, command, prompt, reasoning)
			expect(referencedHashes.size).toBeGreaterThanOrEqual(4);
		});
	});

	// ========================================================================
	// 8. Hash Determinism
	// ========================================================================

	describe('hash determinism', () => {
		it('should produce the same hash for identical environment entries', () => {
			const params = {
				toolName: 'Claude Code',
				toolVersion: '1.0.0',
				modelName: 'claude-4-opus',
				modelVersion: 'opus',
			};

			const { hash: hash1 } = createEnvironmentEntry(params);
			const { hash: hash2 } = createEnvironmentEntry(params);

			expect(hash1).toBe(hash2);
			expect(hash1).toHaveLength(64);
		});

		it('should produce different hashes for different environment entries', () => {
			const { hash: hash1 } = createEnvironmentEntry({
				toolName: 'Claude Code',
				toolVersion: '1.0.0',
				modelName: 'claude-4-opus',
				modelVersion: 'opus',
			});

			const { hash: hash2 } = createEnvironmentEntry({
				toolName: 'Claude Code',
				toolVersion: '1.0.0',
				modelName: 'claude-4-sonnet',
				modelVersion: 'sonnet',
			});

			expect(hash1).not.toBe(hash2);
		});

		it('should produce deterministic hashes regardless of created_at timestamp', () => {
			// First entry at one time
			vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
			const { hash: hash1 } = createEnvironmentEntry({
				toolName: 'Claude Code',
				toolVersion: '1.0.0',
				modelName: 'claude-4-opus',
				modelVersion: 'opus',
			});

			// Same entry at a different time
			vi.setSystemTime(new Date('2026-06-15T12:30:00.000Z'));
			const { hash: hash2 } = createEnvironmentEntry({
				toolName: 'Claude Code',
				toolVersion: '1.0.0',
				modelName: 'claude-4-opus',
				modelVersion: 'opus',
			});

			expect(hash1).toBe(hash2);
		});
	});
});
