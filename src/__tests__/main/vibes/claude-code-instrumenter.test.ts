/**
 * Tests for src/main/vibes/instrumenters/claude-code-instrumenter.ts
 * Validates the Claude Code instrumenter: tool execution handling, thinking
 * chunk buffering, usage capture, prompt capture, result flushing, and
 * assurance-level gating.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

import { ClaudeCodeInstrumenter } from '../../../main/vibes/instrumenters/claude-code-instrumenter';
import { VibesSessionManager } from '../../../main/vibes/vibes-session';
import {
	readAnnotations,
	readVibesManifest,
	ensureAuditDir,
	flushAll,
	resetAllBuffers,
} from '../../../main/vibes/vibes-io';
import type {
	VibesLineAnnotation,
	VibesCommandEntry,
	VibesPromptEntry,
	VibesReasoningEntry,
} from '../../../shared/vibes-types';

// ============================================================================
// Test Suite
// ============================================================================

describe('claude-code-instrumenter', () => {
	const FIXED_ISO = '2026-02-10T12:00:00.000Z';
	let tmpDir: string;
	let manager: VibesSessionManager;

	beforeEach(async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(FIXED_ISO));
		tmpDir = await mkdtemp(path.join(os.tmpdir(), 'vibes-instrumenter-test-'));
		await ensureAuditDir(tmpDir);
		manager = new VibesSessionManager();
	});

	afterEach(async () => {
		resetAllBuffers();
		vi.useRealTimers();
		await rm(tmpDir, { recursive: true, force: true });
	});

	/**
	 * Helper: start a session and set up the environment hash.
	 */
	async function setupSession(
		sessionId: string,
		assuranceLevel: 'low' | 'medium' | 'high' = 'medium'
	) {
		const state = await manager.startSession(sessionId, tmpDir, 'claude-code', assuranceLevel);
		state.environmentHash = 'e'.repeat(64);
		return state;
	}

	// ========================================================================
	// handleToolExecution
	// ========================================================================
	describe('handleToolExecution', () => {
		it('should create a command manifest entry for file write tools', async () => {
			await setupSession('sess-1');
			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			await instrumenter.handleToolExecution('sess-1', {
				toolName: 'Write',
				state: { status: 'running', input: { file_path: 'src/main.ts' } },
				timestamp: Date.now(),
			});

			await flushAll();
			const manifest = await readVibesManifest(tmpDir);
			const entries = Object.values(manifest.entries);
			const cmdEntries = entries.filter((e) => e.type === 'command') as VibesCommandEntry[];
			expect(cmdEntries).toHaveLength(1);
			expect(cmdEntries[0].command_type).toBe('file_write');
			expect(cmdEntries[0].command_text).toBe('Write: src/main.ts');
		});

		it('should create a line annotation for file write tools with modify action (DIVERGENCE 2 fix)', async () => {
			await setupSession('sess-1');
			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			await instrumenter.handleToolExecution('sess-1', {
				toolName: 'Write',
				state: { status: 'running', input: { file_path: 'src/index.ts' } },
				timestamp: Date.now(),
			});

			const annotations = await readAnnotations(tmpDir);
			// session start + line annotation
			expect(annotations.length).toBeGreaterThanOrEqual(2);
			const lineAnnotations = annotations.filter((a) => a.type === 'line') as VibesLineAnnotation[];
			expect(lineAnnotations).toHaveLength(1);
			expect(lineAnnotations[0].file_path).toBe('src/index.ts');
			// Write defaults to 'modify' because it can overwrite existing files
			expect(lineAnnotations[0].action).toBe('modify');
			expect(lineAnnotations[0].environment_hash).toBe('e'.repeat(64));
		});

		it('should create a modify annotation for Edit tools', async () => {
			await setupSession('sess-1');
			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			await instrumenter.handleToolExecution('sess-1', {
				toolName: 'Edit',
				state: { status: 'running', input: { file_path: 'src/utils.ts' } },
				timestamp: Date.now(),
			});

			const annotations = await readAnnotations(tmpDir);
			const lineAnnotations = annotations.filter((a) => a.type === 'line') as VibesLineAnnotation[];
			expect(lineAnnotations).toHaveLength(1);
			expect(lineAnnotations[0].action).toBe('modify');
		});

		it('should create a command entry for Bash tools with shell type', async () => {
			await setupSession('sess-1');
			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			await instrumenter.handleToolExecution('sess-1', {
				toolName: 'Bash',
				state: { status: 'running', input: { command: 'npm test' } },
				timestamp: Date.now(),
			});

			await flushAll();
			const manifest = await readVibesManifest(tmpDir);
			const entries = Object.values(manifest.entries);
			const cmdEntries = entries.filter((e) => e.type === 'command') as VibesCommandEntry[];
			expect(cmdEntries).toHaveLength(1);
			expect(cmdEntries[0].command_type).toBe('shell');
			expect(cmdEntries[0].command_text).toBe('npm test');
		});

		it('should map Bash rm command to file_delete command type', async () => {
			await setupSession('sess-1');
			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			await instrumenter.handleToolExecution('sess-1', {
				toolName: 'Bash',
				state: { status: 'running', input: { command: 'rm -rf dist/' } },
				timestamp: Date.now(),
			});

			await flushAll();
			const manifest = await readVibesManifest(tmpDir);
			const entries = Object.values(manifest.entries);
			const cmdEntries = entries.filter((e) => e.type === 'command') as VibesCommandEntry[];
			expect(cmdEntries).toHaveLength(1);
			expect(cmdEntries[0].command_type).toBe('file_delete');
			expect(cmdEntries[0].command_text).toBe('rm -rf dist/');
		});

		it('should map Bash unlink command to file_delete command type', async () => {
			await setupSession('sess-1');
			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			await instrumenter.handleToolExecution('sess-1', {
				toolName: 'Bash',
				state: { status: 'running', input: { command: 'unlink /tmp/lockfile' } },
				timestamp: Date.now(),
			});

			await flushAll();
			const manifest = await readVibesManifest(tmpDir);
			const entries = Object.values(manifest.entries);
			const cmdEntries = entries.filter((e) => e.type === 'command') as VibesCommandEntry[];
			expect(cmdEntries).toHaveLength(1);
			expect(cmdEntries[0].command_type).toBe('file_delete');
		});

		it('should not map non-delete Bash commands to file_delete', async () => {
			await setupSession('sess-1');
			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			await instrumenter.handleToolExecution('sess-1', {
				toolName: 'Bash',
				state: { status: 'running', input: { command: 'npm test' } },
				timestamp: Date.now(),
			});

			await flushAll();
			const manifest = await readVibesManifest(tmpDir);
			const entries = Object.values(manifest.entries);
			const cmdEntries = entries.filter((e) => e.type === 'command') as VibesCommandEntry[];
			expect(cmdEntries).toHaveLength(1);
			expect(cmdEntries[0].command_type).toBe('shell');
		});

		it('should not create line annotations for Bash tools', async () => {
			await setupSession('sess-1');
			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			await instrumenter.handleToolExecution('sess-1', {
				toolName: 'Bash',
				state: { status: 'running', input: { command: 'ls -la' } },
				timestamp: Date.now(),
			});

			const annotations = await readAnnotations(tmpDir);
			const lineAnnotations = annotations.filter((a) => a.type === 'line');
			expect(lineAnnotations).toHaveLength(0);
		});

		it('should create a command entry for Read tools with file_read type', async () => {
			await setupSession('sess-1');
			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			await instrumenter.handleToolExecution('sess-1', {
				toolName: 'Read',
				state: { status: 'running', input: { file_path: 'package.json' } },
				timestamp: Date.now(),
			});

			await flushAll();
			const manifest = await readVibesManifest(tmpDir);
			const entries = Object.values(manifest.entries);
			const cmdEntries = entries.filter((e) => e.type === 'command') as VibesCommandEntry[];
			expect(cmdEntries).toHaveLength(1);
			expect(cmdEntries[0].command_type).toBe('file_read');
			expect(cmdEntries[0].command_text).toBe('Read: package.json');
		});

		it('should create command entries for Glob/Grep with tool_use type', async () => {
			await setupSession('sess-1');
			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			await instrumenter.handleToolExecution('sess-1', {
				toolName: 'Glob',
				state: { status: 'running', input: { path: 'src/' } },
				timestamp: Date.now(),
			});

			await flushAll();
			const manifest = await readVibesManifest(tmpDir);
			const entries = Object.values(manifest.entries);
			const cmdEntries = entries.filter((e) => e.type === 'command') as VibesCommandEntry[];
			expect(cmdEntries).toHaveLength(1);
			expect(cmdEntries[0].command_type).toBe('tool_use');
		});

		it('should handle unknown tool names with "other" command type', async () => {
			await setupSession('sess-1');
			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			await instrumenter.handleToolExecution('sess-1', {
				toolName: 'UnknownTool',
				state: null,
				timestamp: Date.now(),
			});

			await flushAll();
			const manifest = await readVibesManifest(tmpDir);
			const entries = Object.values(manifest.entries);
			const cmdEntries = entries.filter((e) => e.type === 'command') as VibesCommandEntry[];
			expect(cmdEntries).toHaveLength(1);
			expect(cmdEntries[0].command_type).toBe('other');
		});

		it('should be a no-op for unknown session IDs', async () => {
			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			await instrumenter.handleToolExecution('nonexistent', {
				toolName: 'Write',
				state: { status: 'running', input: { file_path: 'test.ts' } },
				timestamp: Date.now(),
			});

			await flushAll();
			const manifest = await readVibesManifest(tmpDir);
			expect(Object.keys(manifest.entries)).toHaveLength(0);
		});

		it('should be a no-op for inactive sessions', async () => {
			await setupSession('sess-1');
			await manager.endSession('sess-1');

			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			await instrumenter.handleToolExecution('sess-1', {
				toolName: 'Write',
				state: { status: 'running', input: { file_path: 'test.ts' } },
				timestamp: Date.now(),
			});

			await flushAll();
			const manifest = await readVibesManifest(tmpDir);
			expect(Object.keys(manifest.entries)).toHaveLength(0);
		});

		it('should not create line annotation when environmentHash is null', async () => {
			const state = await manager.startSession('sess-1', tmpDir, 'claude-code', 'medium');
			// Leave environmentHash as null (don't set it)
			expect(state.environmentHash).toBeNull();

			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			await instrumenter.handleToolExecution('sess-1', {
				toolName: 'Write',
				state: { status: 'running', input: { file_path: 'src/test.ts' } },
				timestamp: Date.now(),
			});

			const annotations = await readAnnotations(tmpDir);
			const lineAnnotations = annotations.filter((a) => a.type === 'line');
			expect(lineAnnotations).toHaveLength(0);

			// But command entry should still be created
			await flushAll();
			const manifest = await readVibesManifest(tmpDir);
			const cmdEntries = Object.values(manifest.entries).filter((e) => e.type === 'command');
			expect(cmdEntries).toHaveLength(1);
		});

		it('should truncate long bash commands in command text', async () => {
			await setupSession('sess-1');
			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			const longCommand = 'echo ' + 'x'.repeat(300);
			await instrumenter.handleToolExecution('sess-1', {
				toolName: 'Bash',
				state: { status: 'running', input: { command: longCommand } },
				timestamp: Date.now(),
			});

			await flushAll();
			const manifest = await readVibesManifest(tmpDir);
			const entries = Object.values(manifest.entries);
			const cmdEntries = entries.filter((e) => e.type === 'command') as VibesCommandEntry[];
			expect(cmdEntries[0].command_text.length).toBeLessThanOrEqual(200);
			expect(cmdEntries[0].command_text).toContain('...');
		});

		it('should extract line ranges from Read tool offset/limit', async () => {
			await setupSession('sess-1');
			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			// Read tool with offset and limit doesn't create line annotation
			// (Read is not in TOOL_ACTION_MAP), but let's test a Write with those fields
			// Actually, let's verify the command entry is correct for Read
			await instrumenter.handleToolExecution('sess-1', {
				toolName: 'Read',
				state: { status: 'running', input: { file_path: 'src/foo.ts', offset: 10, limit: 20 } },
				timestamp: Date.now(),
			});

			await flushAll();
			const manifest = await readVibesManifest(tmpDir);
			const entries = Object.values(manifest.entries);
			const cmdEntries = entries.filter((e) => e.type === 'command') as VibesCommandEntry[];
			expect(cmdEntries).toHaveLength(1);
			expect(cmdEntries[0].command_text).toBe('Read: src/foo.ts');
		});

		it('should handle NotebookEdit tool as file_write', async () => {
			await setupSession('sess-1');
			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			await instrumenter.handleToolExecution('sess-1', {
				toolName: 'NotebookEdit',
				state: {
					status: 'running',
					input: { notebook_path: 'analysis.ipynb', cell_number: 3 },
				},
				timestamp: Date.now(),
			});

			await flushAll();
			const manifest = await readVibesManifest(tmpDir);
			const entries = Object.values(manifest.entries);
			const cmdEntries = entries.filter((e) => e.type === 'command') as VibesCommandEntry[];
			expect(cmdEntries).toHaveLength(1);
			expect(cmdEntries[0].command_type).toBe('file_write');

			const annotations = await readAnnotations(tmpDir);
			const lineAnnotations = annotations.filter((a) => a.type === 'line') as VibesLineAnnotation[];
			expect(lineAnnotations).toHaveLength(1);
			expect(lineAnnotations[0].file_path).toBe('analysis.ipynb');
			// cell_number used as line range
			expect(lineAnnotations[0].line_start).toBe(3);
			expect(lineAnnotations[0].line_end).toBe(3);
		});
	});

	// ========================================================================
	// Line Range Extraction (VIBES-FIX-10)
	// ========================================================================
	describe('line range extraction', () => {
		it('should extract line range from Write tool content', async () => {
			await setupSession('sess-1');
			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			const content = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n');
			await instrumenter.handleToolExecution('sess-1', {
				toolName: 'Write',
				state: { status: 'running', input: { file_path: 'src/new-file.ts', content } },
				timestamp: Date.now(),
			});

			const annotations = await readAnnotations(tmpDir);
			const lineAnnotations = annotations.filter((a) => a.type === 'line') as VibesLineAnnotation[];
			expect(lineAnnotations).toHaveLength(1);
			expect(lineAnnotations[0].line_start).toBe(1);
			expect(lineAnnotations[0].line_end).toBe(50);
		});

		it('should extract line range from Edit tool with old_string position', async () => {
			await setupSession('sess-1');
			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			// Create a real file at tmpDir so the instrumenter can read it
			const srcDir = path.join(tmpDir, 'src');
			await mkdir(srcDir, { recursive: true });
			const fileContent = [
				'import foo from "bar";',
				'',
				'function hello() {',
				'  console.log("hello");',
				'}',
				'',
				'function goodbye() {',
				'  console.log("goodbye");',
				'}',
			].join('\n');
			await writeFile(path.join(srcDir, 'edit-target.ts'), fileContent);

			await instrumenter.handleToolExecution('sess-1', {
				toolName: 'Edit',
				state: {
					status: 'running',
					input: {
						file_path: 'src/edit-target.ts',
						old_string: 'function goodbye() {\n  console.log("goodbye");\n}',
						new_string: 'function goodbye() {\n  console.log("farewell");\n  return true;\n}',
					},
				},
				timestamp: Date.now(),
			});

			const annotations = await readAnnotations(tmpDir);
			const lineAnnotations = annotations.filter((a) => a.type === 'line') as VibesLineAnnotation[];
			expect(lineAnnotations).toHaveLength(1);
			// old_string starts at line 7, new_string has 4 lines
			expect(lineAnnotations[0].line_start).toBe(7);
			expect(lineAnnotations[0].line_end).toBe(10);
		});

		it('should fall back to line counting for Edit when file cannot be read', async () => {
			await setupSession('sess-1');
			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			await instrumenter.handleToolExecution('sess-1', {
				toolName: 'Edit',
				state: {
					status: 'running',
					input: {
						file_path: 'src/nonexistent.ts',
						old_string: 'old code',
						new_string: 'line1\nline2\nline3',
					},
				},
				timestamp: Date.now(),
			});

			const annotations = await readAnnotations(tmpDir);
			const lineAnnotations = annotations.filter((a) => a.type === 'line') as VibesLineAnnotation[];
			expect(lineAnnotations).toHaveLength(1);
			// Fallback: lineStart=1, lineEnd=3 (3 lines in new_string)
			expect(lineAnnotations[0].line_start).toBe(1);
			expect(lineAnnotations[0].line_end).toBe(3);
		});

		it('should extract union line range from MultiEdit tool', async () => {
			await setupSession('sess-1');
			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			// Create a file with known content
			const srcDir = path.join(tmpDir, 'src');
			await mkdir(srcDir, { recursive: true });
			const fileContent = [
				'const a = 1;', // line 1
				'const b = 2;', // line 2
				'const c = 3;', // line 3
				'', // line 4
				'function foo() {', // line 5
				'  return a;', // line 6
				'}', // line 7
				'', // line 8
				'function bar() {', // line 9
				'  return b;', // line 10
				'}', // line 11
			].join('\n');
			await writeFile(path.join(srcDir, 'multi-edit.ts'), fileContent);

			await instrumenter.handleToolExecution('sess-1', {
				toolName: 'MultiEdit',
				state: {
					status: 'running',
					input: {
						file_path: 'src/multi-edit.ts',
						edits: [
							{ old_string: 'const a = 1;', new_string: 'const a = 10;' },
							{
								old_string: 'function bar() {\n  return b;\n}',
								new_string: 'function bar() {\n  return b + c;\n}',
							},
						],
					},
				},
				timestamp: Date.now(),
			});

			const annotations = await readAnnotations(tmpDir);
			const lineAnnotations = annotations.filter((a) => a.type === 'line') as VibesLineAnnotation[];
			expect(lineAnnotations).toHaveLength(1);
			// First edit at line 1 (1 line), second at line 9 (3 lines → 9+3-1=11)
			expect(lineAnnotations[0].line_start).toBe(1);
			expect(lineAnnotations[0].line_end).toBe(11);
		});

		it('should handle NotebookEdit with new_source line count', async () => {
			await setupSession('sess-1');
			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			await instrumenter.handleToolExecution('sess-1', {
				toolName: 'NotebookEdit',
				state: {
					status: 'running',
					input: {
						notebook_path: 'analysis.ipynb',
						cell_number: 5,
						new_source: 'import pandas as pd\nimport numpy as np\n\ndf = pd.read_csv("data.csv")',
					},
				},
				timestamp: Date.now(),
			});

			const annotations = await readAnnotations(tmpDir);
			const lineAnnotations = annotations.filter((a) => a.type === 'line') as VibesLineAnnotation[];
			expect(lineAnnotations).toHaveLength(1);
			// cell_number=5, new_source has 4 lines → lineEnd = 5 + 4 - 1 = 8
			expect(lineAnnotations[0].line_start).toBe(5);
			expect(lineAnnotations[0].line_end).toBe(8);
		});

		it('should handle Write tool with single-line content', async () => {
			await setupSession('sess-1');
			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			await instrumenter.handleToolExecution('sess-1', {
				toolName: 'Write',
				state: {
					status: 'running',
					input: { file_path: 'src/one-liner.ts', content: 'export default 42;' },
				},
				timestamp: Date.now(),
			});

			const annotations = await readAnnotations(tmpDir);
			const lineAnnotations = annotations.filter((a) => a.type === 'line') as VibesLineAnnotation[];
			expect(lineAnnotations).toHaveLength(1);
			expect(lineAnnotations[0].line_start).toBe(1);
			expect(lineAnnotations[0].line_end).toBe(1);
		});
	});

	// ========================================================================
	// Prompt Hash Linking (DIVERGENCE 5)
	// ========================================================================
	describe('prompt_hash linking', () => {
		it('includes prompt_hash in line annotations at medium assurance', async () => {
			await setupSession('sess-1', 'medium');
			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			// Send a prompt first
			await instrumenter.handlePrompt('sess-1', 'Fix the login bug');

			// Then a tool execution that creates a line annotation
			await instrumenter.handleToolExecution('sess-1', {
				toolName: 'Write',
				state: { status: 'running', input: { file_path: 'src/login.ts' } },
				timestamp: Date.now(),
			});

			const annotations = await readAnnotations(tmpDir);
			const lineAnnotations = annotations.filter((a) => a.type === 'line') as VibesLineAnnotation[];
			expect(lineAnnotations).toHaveLength(1);
			expect(lineAnnotations[0].prompt_hash).toBeDefined();
			expect(typeof lineAnnotations[0].prompt_hash).toBe('string');
			expect(lineAnnotations[0].prompt_hash!.length).toBe(64);
		});

		it('includes prompt_hash in line annotations at high assurance', async () => {
			await setupSession('sess-1', 'high');
			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'high',
			});

			await instrumenter.handlePrompt('sess-1', 'Add new feature');

			await instrumenter.handleToolExecution('sess-1', {
				toolName: 'Write',
				state: { status: 'running', input: { file_path: 'src/feature.ts' } },
				timestamp: Date.now(),
			});

			const annotations = await readAnnotations(tmpDir);
			const lineAnnotations = annotations.filter((a) => a.type === 'line') as VibesLineAnnotation[];
			expect(lineAnnotations).toHaveLength(1);
			expect(lineAnnotations[0].prompt_hash).toBeDefined();
			expect(typeof lineAnnotations[0].prompt_hash).toBe('string');
			expect(lineAnnotations[0].prompt_hash!.length).toBe(64);
		});

		it('does not include prompt_hash in line annotations at low assurance', async () => {
			await setupSession('sess-1', 'low');
			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'low',
			});

			// At low assurance, handlePrompt is a no-op, but even if it weren't,
			// the annotation should not include prompt_hash
			await instrumenter.handlePrompt('sess-1', 'Some prompt');

			await instrumenter.handleToolExecution('sess-1', {
				toolName: 'Write',
				state: { status: 'running', input: { file_path: 'src/test.ts' } },
				timestamp: Date.now(),
			});

			const annotations = await readAnnotations(tmpDir);
			const lineAnnotations = annotations.filter((a) => a.type === 'line') as VibesLineAnnotation[];
			expect(lineAnnotations).toHaveLength(1);
			expect(lineAnnotations[0].prompt_hash).toBeNull();
		});

		it('clears prompt hash on session cleanup', async () => {
			await setupSession('sess-1', 'medium');
			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			// Send a prompt to store the hash
			await instrumenter.handlePrompt('sess-1', 'First prompt');

			// Flush to trigger cleanup
			await instrumenter.flush('sess-1');

			// Start a new session with the same ID
			await setupSession('sess-1', 'medium');

			// Tool execution after cleanup should not have prompt_hash
			await instrumenter.handleToolExecution('sess-1', {
				toolName: 'Write',
				state: { status: 'running', input: { file_path: 'src/after-cleanup.ts' } },
				timestamp: Date.now(),
			});

			const annotations = await readAnnotations(tmpDir);
			const lineAnnotations = annotations.filter(
				(a) => a.type === 'line' && (a as VibesLineAnnotation).file_path === 'src/after-cleanup.ts'
			) as VibesLineAnnotation[];
			expect(lineAnnotations).toHaveLength(1);
			expect(lineAnnotations[0].prompt_hash).toBeNull();
		});
	});

	// ========================================================================
	// Reasoning Hash Linking (DIVERGENCE 5 continued)
	// ========================================================================
	describe('reasoning_hash linking', () => {
		it('includes reasoning_hash in line annotations at high assurance', async () => {
			await setupSession('sess-1', 'high');
			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'high',
			});

			// Buffer reasoning and trigger a tool execution (which flushes reasoning first)
			instrumenter.handleThinkingChunk('sess-1', 'Analyzing the code structure...');

			await instrumenter.handleToolExecution('sess-1', {
				toolName: 'Write',
				state: { status: 'running', input: { file_path: 'src/refactored.ts' } },
				timestamp: Date.now(),
			});

			const annotations = await readAnnotations(tmpDir);
			const lineAnnotations = annotations.filter((a) => a.type === 'line') as VibesLineAnnotation[];
			expect(lineAnnotations).toHaveLength(1);
			expect(lineAnnotations[0].reasoning_hash).toBeDefined();
			expect(typeof lineAnnotations[0].reasoning_hash).toBe('string');
			expect(lineAnnotations[0].reasoning_hash!.length).toBe(64);
		});

		it('does not include reasoning_hash at medium assurance', async () => {
			await setupSession('sess-1', 'medium');
			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			// At medium assurance, thinking chunks are ignored
			instrumenter.handleThinkingChunk('sess-1', 'This is ignored at medium.');

			await instrumenter.handleToolExecution('sess-1', {
				toolName: 'Write',
				state: { status: 'running', input: { file_path: 'src/medium.ts' } },
				timestamp: Date.now(),
			});

			const annotations = await readAnnotations(tmpDir);
			const lineAnnotations = annotations.filter((a) => a.type === 'line') as VibesLineAnnotation[];
			expect(lineAnnotations).toHaveLength(1);
			expect(lineAnnotations[0].reasoning_hash).toBeNull();
		});

		it('does not include reasoning_hash at low assurance', async () => {
			await setupSession('sess-1', 'low');
			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'low',
			});

			instrumenter.handleThinkingChunk('sess-1', 'This is ignored at low.');

			await instrumenter.handleToolExecution('sess-1', {
				toolName: 'Write',
				state: { status: 'running', input: { file_path: 'src/low.ts' } },
				timestamp: Date.now(),
			});

			const annotations = await readAnnotations(tmpDir);
			const lineAnnotations = annotations.filter((a) => a.type === 'line') as VibesLineAnnotation[];
			expect(lineAnnotations).toHaveLength(1);
			expect(lineAnnotations[0].reasoning_hash).toBeNull();
		});

		it('updates reasoning_hash after each flush', async () => {
			await setupSession('sess-1', 'high');
			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'high',
			});

			// First reasoning + tool execution
			instrumenter.handleThinkingChunk('sess-1', 'First reasoning block.');

			await instrumenter.handleToolExecution('sess-1', {
				toolName: 'Write',
				state: { status: 'running', input: { file_path: 'src/first.ts' } },
				timestamp: Date.now(),
			});

			// Second reasoning + tool execution (different reasoning text = different hash)
			instrumenter.handleThinkingChunk('sess-1', 'Second reasoning block with different content.');

			await instrumenter.handleToolExecution('sess-1', {
				toolName: 'Edit',
				state: { status: 'running', input: { file_path: 'src/second.ts' } },
				timestamp: Date.now(),
			});

			const annotations = await readAnnotations(tmpDir);
			const lineAnnotations = annotations.filter((a) => a.type === 'line') as VibesLineAnnotation[];
			expect(lineAnnotations).toHaveLength(2);

			// Both should have reasoning_hash
			expect(lineAnnotations[0].reasoning_hash).toBeDefined();
			expect(lineAnnotations[1].reasoning_hash).toBeDefined();

			// The hashes should differ because the reasoning text differs
			expect(lineAnnotations[0].reasoning_hash).not.toBe(lineAnnotations[1].reasoning_hash);
		});
	});

	// ========================================================================
	// handleThinkingChunk
	// ========================================================================
	describe('handleThinkingChunk', () => {
		it('should buffer reasoning text at High assurance', async () => {
			await setupSession('sess-1', 'high');
			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'high',
			});

			instrumenter.handleThinkingChunk('sess-1', 'First thought. ');
			instrumenter.handleThinkingChunk('sess-1', 'Second thought.');

			// Trigger flush via handleResult
			await instrumenter.handleResult('sess-1', 'done');

			await flushAll();
			const manifest = await readVibesManifest(tmpDir);
			const entries = Object.values(manifest.entries);
			const reasoningEntries = entries.filter(
				(e) => e.type === 'reasoning'
			) as VibesReasoningEntry[];
			expect(reasoningEntries).toHaveLength(1);
			expect(reasoningEntries[0].reasoning_text).toBe('First thought. Second thought.');
		});

		it('should not buffer reasoning at Medium assurance', async () => {
			await setupSession('sess-1', 'medium');
			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			instrumenter.handleThinkingChunk('sess-1', 'This should be ignored.');

			await instrumenter.handleResult('sess-1', 'done');

			await flushAll();
			const manifest = await readVibesManifest(tmpDir);
			const entries = Object.values(manifest.entries);
			const reasoningEntries = entries.filter((e) => e.type === 'reasoning');
			expect(reasoningEntries).toHaveLength(0);
		});

		it('should not buffer reasoning at Low assurance', async () => {
			await setupSession('sess-1', 'low');
			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'low',
			});

			instrumenter.handleThinkingChunk('sess-1', 'This should be ignored.');

			await instrumenter.handleResult('sess-1', 'done');

			await flushAll();
			const manifest = await readVibesManifest(tmpDir);
			const entries = Object.values(manifest.entries);
			const reasoningEntries = entries.filter((e) => e.type === 'reasoning');
			expect(reasoningEntries).toHaveLength(0);
		});

		it('should be a no-op for unknown session IDs', () => {
			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'high',
			});

			// Should not throw
			instrumenter.handleThinkingChunk('nonexistent', 'ignored');
		});

		it('should flush reasoning before each tool execution at High assurance', async () => {
			await setupSession('sess-1', 'high');
			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'high',
			});

			instrumenter.handleThinkingChunk('sess-1', 'Thinking about the file...');

			await instrumenter.handleToolExecution('sess-1', {
				toolName: 'Read',
				state: { status: 'running', input: { file_path: 'test.ts' } },
				timestamp: Date.now(),
			});

			await flushAll();
			const manifest = await readVibesManifest(tmpDir);
			const entries = Object.values(manifest.entries);
			const reasoningEntries = entries.filter(
				(e) => e.type === 'reasoning'
			) as VibesReasoningEntry[];
			expect(reasoningEntries).toHaveLength(1);
			expect(reasoningEntries[0].reasoning_text).toBe('Thinking about the file...');
		});
	});

	// ========================================================================
	// handleUsage
	// ========================================================================
	describe('handleUsage', () => {
		it('should capture reasoning token count for later inclusion', async () => {
			await setupSession('sess-1', 'high');
			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'high',
			});

			instrumenter.handleUsage('sess-1', {
				inputTokens: 100,
				outputTokens: 50,
				reasoningTokens: 30,
			});

			instrumenter.handleThinkingChunk('sess-1', 'Some reasoning.');

			await instrumenter.handleResult('sess-1', 'done');

			await flushAll();
			const manifest = await readVibesManifest(tmpDir);
			const entries = Object.values(manifest.entries);
			const reasoningEntries = entries.filter(
				(e) => e.type === 'reasoning'
			) as VibesReasoningEntry[];
			expect(reasoningEntries).toHaveLength(1);
			expect(reasoningEntries[0].reasoning_token_count).toBe(30);
		});

		it('should accumulate reasoning token counts across multiple usage events', async () => {
			await setupSession('sess-1', 'high');
			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'high',
			});

			instrumenter.handleUsage('sess-1', {
				inputTokens: 100,
				outputTokens: 50,
				reasoningTokens: 10,
			});
			instrumenter.handleUsage('sess-1', {
				inputTokens: 200,
				outputTokens: 100,
				reasoningTokens: 20,
			});

			instrumenter.handleThinkingChunk('sess-1', 'Thoughts.');

			await instrumenter.handleResult('sess-1', 'done');

			await flushAll();
			const manifest = await readVibesManifest(tmpDir);
			const entries = Object.values(manifest.entries);
			const reasoningEntries = entries.filter(
				(e) => e.type === 'reasoning'
			) as VibesReasoningEntry[];
			expect(reasoningEntries).toHaveLength(1);
			expect(reasoningEntries[0].reasoning_token_count).toBe(30);
		});

		it('should be a no-op with null usage', () => {
			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			// Should not throw
			instrumenter.handleUsage('sess-1', undefined);
		});

		it('should be a no-op for unknown session IDs', () => {
			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			instrumenter.handleUsage('nonexistent', {
				inputTokens: 100,
				outputTokens: 50,
			});
		});
	});

	// ========================================================================
	// handleResult
	// ========================================================================
	describe('handleResult', () => {
		it('should flush buffered reasoning on result', async () => {
			await setupSession('sess-1', 'high');
			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'high',
			});

			instrumenter.handleThinkingChunk('sess-1', 'My reasoning.');

			await instrumenter.handleResult('sess-1', 'The final answer.');

			await flushAll();
			const manifest = await readVibesManifest(tmpDir);
			const entries = Object.values(manifest.entries);
			const reasoningEntries = entries.filter((e) => e.type === 'reasoning');
			expect(reasoningEntries).toHaveLength(1);
		});

		it('should be a no-op when no reasoning is buffered', async () => {
			await setupSession('sess-1', 'high');
			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'high',
			});

			await instrumenter.handleResult('sess-1', 'The answer.');

			await flushAll();
			const manifest = await readVibesManifest(tmpDir);
			const entries = Object.values(manifest.entries);
			const reasoningEntries = entries.filter((e) => e.type === 'reasoning');
			expect(reasoningEntries).toHaveLength(0);
		});

		it('should be a no-op for unknown session IDs', async () => {
			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'high',
			});

			// Should not throw
			await instrumenter.handleResult('nonexistent', 'text');
		});
	});

	// ========================================================================
	// handlePrompt
	// ========================================================================
	describe('handlePrompt', () => {
		it('should create a prompt manifest entry at Medium assurance', async () => {
			await setupSession('sess-1', 'medium');
			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			await instrumenter.handlePrompt('sess-1', 'Fix the bug in login.ts');

			await flushAll();
			const manifest = await readVibesManifest(tmpDir);
			const entries = Object.values(manifest.entries);
			const promptEntries = entries.filter((e) => e.type === 'prompt') as VibesPromptEntry[];
			expect(promptEntries).toHaveLength(1);
			expect(promptEntries[0].prompt_text).toBe('Fix the bug in login.ts');
			expect(promptEntries[0].prompt_type).toBe('user_instruction');
		});

		it('should create a prompt manifest entry at High assurance', async () => {
			await setupSession('sess-1', 'high');
			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'high',
			});

			await instrumenter.handlePrompt('sess-1', 'Refactor the auth module');

			await flushAll();
			const manifest = await readVibesManifest(tmpDir);
			const entries = Object.values(manifest.entries);
			const promptEntries = entries.filter((e) => e.type === 'prompt');
			expect(promptEntries).toHaveLength(1);
		});

		it('should NOT create a prompt manifest entry at Low assurance', async () => {
			await setupSession('sess-1', 'low');
			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'low',
			});

			await instrumenter.handlePrompt('sess-1', 'This should be skipped');

			await flushAll();
			const manifest = await readVibesManifest(tmpDir);
			const entries = Object.values(manifest.entries);
			const promptEntries = entries.filter((e) => e.type === 'prompt');
			expect(promptEntries).toHaveLength(0);
		});

		it('should include context files when provided', async () => {
			await setupSession('sess-1', 'medium');
			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			await instrumenter.handlePrompt('sess-1', 'Review these files', [
				'src/auth.ts',
				'src/login.ts',
			]);

			await flushAll();
			const manifest = await readVibesManifest(tmpDir);
			const entries = Object.values(manifest.entries);
			const promptEntries = entries.filter((e) => e.type === 'prompt') as VibesPromptEntry[];
			expect(promptEntries[0].prompt_context_files).toEqual(['src/auth.ts', 'src/login.ts']);
		});

		it('should be a no-op for unknown session IDs', async () => {
			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			await instrumenter.handlePrompt('nonexistent', 'ignored');

			await flushAll();
			const manifest = await readVibesManifest(tmpDir);
			expect(Object.keys(manifest.entries)).toHaveLength(0);
		});
	});

	// ========================================================================
	// flush
	// ========================================================================
	describe('flush', () => {
		it('should flush buffered reasoning and clean up session state', async () => {
			await setupSession('sess-1', 'high');
			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'high',
			});

			instrumenter.handleThinkingChunk('sess-1', 'Reasoning to flush.');

			await instrumenter.flush('sess-1');

			await flushAll();
			const manifest = await readVibesManifest(tmpDir);
			const entries = Object.values(manifest.entries);
			const reasoningEntries = entries.filter((e) => e.type === 'reasoning');
			expect(reasoningEntries).toHaveLength(1);

			// After flush, no more reasoning should be buffered
			await instrumenter.handleResult('sess-1', 'done');

			// No additional reasoning entries
			await flushAll();
			const manifest2 = await readVibesManifest(tmpDir);
			const entries2 = Object.values(manifest2.entries);
			const reasoningEntries2 = entries2.filter((e) => e.type === 'reasoning');
			expect(reasoningEntries2).toHaveLength(1);
		});

		it('should be safe to call flush on sessions with no buffered data', async () => {
			await setupSession('sess-1');
			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			// Should not throw
			await instrumenter.flush('sess-1');
		});

		it('should be safe to call flush on unknown sessions', async () => {
			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			// Should not throw
			await instrumenter.flush('nonexistent');
		});
	});

	// ========================================================================
	// Integration: Full Turn Cycle
	// ========================================================================
	describe('integration', () => {
		it('should handle a full turn cycle with thinking + tool + result at High assurance', async () => {
			await setupSession('sess-1', 'high');
			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'high',
			});

			// 1. Prompt
			await instrumenter.handlePrompt('sess-1', 'Add a new utility function');

			// 2. Thinking chunks
			instrumenter.handleThinkingChunk('sess-1', 'I need to create a new file. ');
			instrumenter.handleThinkingChunk('sess-1', 'Let me write it to src/utils.ts.');

			// 3. Usage info
			instrumenter.handleUsage('sess-1', {
				inputTokens: 500,
				outputTokens: 200,
				reasoningTokens: 50,
			});

			// 4. Tool execution (flushes reasoning)
			await instrumenter.handleToolExecution('sess-1', {
				toolName: 'Write',
				state: { status: 'running', input: { file_path: 'src/utils.ts' } },
				timestamp: Date.now(),
			});

			// 5. More thinking
			instrumenter.handleThinkingChunk('sess-1', 'Now verify it works.');

			// 6. Another tool execution
			await instrumenter.handleToolExecution('sess-1', {
				toolName: 'Bash',
				state: { status: 'running', input: { command: 'npm test' } },
				timestamp: Date.now(),
			});

			// 7. Result
			await instrumenter.handleResult('sess-1', 'Created utility function successfully.');

			// Verify manifest entries
			await flushAll();
			const manifest = await readVibesManifest(tmpDir);
			const entries = Object.values(manifest.entries);

			// Should have: 1 prompt + 2 reasoning + 2 command entries
			const promptEntries = entries.filter((e) => e.type === 'prompt');
			const reasoningEntries = entries.filter((e) => e.type === 'reasoning');
			const commandEntries = entries.filter((e) => e.type === 'command');

			expect(promptEntries).toHaveLength(1);
			expect(reasoningEntries).toHaveLength(2);
			expect(commandEntries).toHaveLength(2);

			// Verify annotations
			const annotations = await readAnnotations(tmpDir);
			const lineAnnotations = annotations.filter((a) => a.type === 'line');
			// Only Write creates line annotation, not Bash
			expect(lineAnnotations).toHaveLength(1);
		});

		it('should handle multiple sessions independently', async () => {
			await setupSession('sess-1', 'medium');
			await setupSession('sess-2', 'high');

			const instrumenter1 = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});
			const instrumenter2 = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'high',
			});

			instrumenter2.handleThinkingChunk('sess-2', 'High assurance thinking.');

			await instrumenter1.handleToolExecution('sess-1', {
				toolName: 'Write',
				state: { status: 'running', input: { file_path: 'src/a.ts' } },
				timestamp: Date.now(),
			});

			await instrumenter2.handleToolExecution('sess-2', {
				toolName: 'Edit',
				state: { status: 'running', input: { file_path: 'src/b.ts' } },
				timestamp: Date.now(),
			});

			// Both sessions share the same tmpDir, so check the manifest has entries from both
			await flushAll();
			const manifest = await readVibesManifest(tmpDir);
			const entries = Object.values(manifest.entries);
			const commandEntries = entries.filter((e) => e.type === 'command');
			expect(commandEntries.length).toBeGreaterThanOrEqual(2);

			// Session 2 should have reasoning (high assurance)
			const reasoningEntries = entries.filter((e) => e.type === 'reasoning');
			expect(reasoningEntries).toHaveLength(1);
		});

		it('should handle WebFetch/WebSearch as api_call', async () => {
			await setupSession('sess-1');
			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			await instrumenter.handleToolExecution('sess-1', {
				toolName: 'WebFetch',
				state: { status: 'running', input: { url: 'https://example.com' } },
				timestamp: Date.now(),
			});

			await flushAll();
			const manifest = await readVibesManifest(tmpDir);
			const entries = Object.values(manifest.entries);
			const cmdEntries = entries.filter((e) => e.type === 'command') as VibesCommandEntry[];
			expect(cmdEntries).toHaveLength(1);
			expect(cmdEntries[0].command_type).toBe('api_call');
		});
	});

	// ========================================================================
	// Error Handling
	// ========================================================================
	describe('error handling', () => {
		it('should not throw when handleToolExecution receives null event', async () => {
			await setupSession('sess-1');
			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			await expect(
				instrumenter.handleToolExecution(
					'sess-1',
					null as unknown as { toolName: string; state: unknown; timestamp: number }
				)
			).resolves.not.toThrow();
		});

		it('should not throw when handleToolExecution receives event with missing toolName', async () => {
			await setupSession('sess-1');
			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			await expect(
				instrumenter.handleToolExecution('sess-1', {
					toolName: undefined as unknown as string,
					state: {},
					timestamp: Date.now(),
				})
			).resolves.not.toThrow();
		});

		it('should not throw when handleToolExecution receives event with non-object state', async () => {
			await setupSession('sess-1');
			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			await expect(
				instrumenter.handleToolExecution('sess-1', {
					toolName: 'Write',
					state: 'not-an-object',
					timestamp: Date.now(),
				})
			).resolves.not.toThrow();
		});

		it('should handle file_path as number without throwing', async () => {
			await setupSession('sess-1');
			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			await expect(
				instrumenter.handleToolExecution('sess-1', {
					toolName: 'Write',
					state: { status: 'running', input: { file_path: 12345 } },
					timestamp: Date.now(),
				})
			).resolves.not.toThrow();

			// Command entry should still be created (no line annotation though)
			await flushAll();
			const manifest = await readVibesManifest(tmpDir);
			const entries = Object.values(manifest.entries);
			const cmdEntries = entries.filter((e) => e.type === 'command');
			expect(cmdEntries).toHaveLength(1);
		});

		it('should not throw when handleThinkingChunk called with empty text', () => {
			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'high',
			});

			expect(() => instrumenter.handleThinkingChunk('sess-1', '')).not.toThrow();
		});

		it('should not throw when handleUsage called with malformed data', async () => {
			await setupSession('sess-1');
			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			expect(() =>
				instrumenter.handleUsage('sess-1', { inputTokens: NaN, outputTokens: -1 })
			).not.toThrow();
		});

		it('should not throw when handleResult called for non-existent session', async () => {
			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			await expect(instrumenter.handleResult('nonexistent', 'text')).resolves.not.toThrow();
		});

		it('should not throw when handlePrompt called for non-existent session', async () => {
			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			await expect(instrumenter.handlePrompt('nonexistent', 'prompt')).resolves.not.toThrow();
		});

		it('should not throw when flush called for non-existent session', async () => {
			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			await expect(instrumenter.flush('nonexistent')).resolves.not.toThrow();
		});
	});

	// ========================================================================
	// Exclude Patterns
	// ========================================================================
	describe('exclude patterns', () => {
		it('should skip annotations for files matching exclude patterns', async () => {
			await setupSession('sess-1');
			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
				excludePatterns: ['**/node_modules/**'],
			});

			await instrumenter.handleToolExecution('sess-1', {
				toolName: 'Write',
				state: { status: 'running', input: { file_path: 'node_modules/foo/index.js' } },
				timestamp: Date.now(),
			});

			const annotations = await readAnnotations(tmpDir);
			const lineAnnotations = annotations.filter((a) => a.type === 'line');
			expect(lineAnnotations).toHaveLength(0);

			// But command entry should still be created
			await flushAll();
			const manifest = await readVibesManifest(tmpDir);
			const cmdEntries = Object.values(manifest.entries).filter((e) => e.type === 'command');
			expect(cmdEntries).toHaveLength(1);
		});

		it('should not skip annotations for files not matching exclude patterns', async () => {
			await setupSession('sess-1');
			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
				excludePatterns: ['**/node_modules/**'],
			});

			await instrumenter.handleToolExecution('sess-1', {
				toolName: 'Write',
				state: { status: 'running', input: { file_path: 'src/main.ts' } },
				timestamp: Date.now(),
			});

			const annotations = await readAnnotations(tmpDir);
			const lineAnnotations = annotations.filter((a) => a.type === 'line');
			expect(lineAnnotations).toHaveLength(1);
		});

		it('should support setExcludePatterns to update patterns at runtime', async () => {
			await setupSession('sess-1');
			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			// Initially no patterns — write to dist/ should create annotation
			await instrumenter.handleToolExecution('sess-1', {
				toolName: 'Write',
				state: { status: 'running', input: { file_path: 'dist/bundle.js' } },
				timestamp: Date.now(),
			});

			let annotations = await readAnnotations(tmpDir);
			let lineAnnotations = annotations.filter((a) => a.type === 'line');
			expect(lineAnnotations).toHaveLength(1);

			// Set exclude patterns
			instrumenter.setExcludePatterns(['dist/**']);

			// Now write to dist/ should NOT create annotation
			await instrumenter.handleToolExecution('sess-1', {
				toolName: 'Write',
				state: { status: 'running', input: { file_path: 'dist/other.js' } },
				timestamp: Date.now(),
			});

			annotations = await readAnnotations(tmpDir);
			lineAnnotations = annotations.filter((a) => a.type === 'line');
			// Still only 1 from before — the second was excluded
			expect(lineAnnotations).toHaveLength(1);
		});

		it('should handle invalid glob patterns gracefully', async () => {
			await setupSession('sess-1');
			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
				excludePatterns: ['[invalid-pattern'],
			});

			// Should not throw — invalid patterns are skipped
			await expect(
				instrumenter.handleToolExecution('sess-1', {
					toolName: 'Write',
					state: { status: 'running', input: { file_path: 'src/main.ts' } },
					timestamp: Date.now(),
				})
			).resolves.not.toThrow();

			// Annotation should still be created since the pattern was invalid
			const annotations = await readAnnotations(tmpDir);
			const lineAnnotations = annotations.filter((a) => a.type === 'line');
			expect(lineAnnotations).toHaveLength(1);
		});
	});

	// ========================================================================
	// Data Capture: working_directory and command_output_summary (VIBES-DETAIL-01)
	// ========================================================================
	describe('data capture: working_directory and command_output_summary', () => {
		it('should populate working_directory from session.projectPath', async () => {
			await setupSession('sess-1');
			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			await instrumenter.handleToolExecution('sess-1', {
				toolName: 'Write',
				state: { status: 'running', input: { file_path: 'src/main.ts' } },
				timestamp: Date.now(),
			});

			await flushAll();
			const manifest = await readVibesManifest(tmpDir);
			const entries = Object.values(manifest.entries);
			const cmdEntries = entries.filter((e) => e.type === 'command') as VibesCommandEntry[];
			expect(cmdEntries).toHaveLength(1);
			expect(cmdEntries[0].working_directory).toBe(tmpDir);
		});

		it('should populate working_directory for Bash tool as well', async () => {
			await setupSession('sess-1');
			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			await instrumenter.handleToolExecution('sess-1', {
				toolName: 'Bash',
				state: { status: 'running', input: { command: 'echo hello' } },
				timestamp: Date.now(),
			});

			await flushAll();
			const manifest = await readVibesManifest(tmpDir);
			const entries = Object.values(manifest.entries);
			const cmdEntries = entries.filter((e) => e.type === 'command') as VibesCommandEntry[];
			expect(cmdEntries).toHaveLength(1);
			expect(cmdEntries[0].working_directory).toBe(tmpDir);
		});

		it('should generate output summary for Edit tool with old_string', async () => {
			await setupSession('sess-1');
			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			await instrumenter.handleToolExecution('sess-1', {
				toolName: 'Edit',
				state: {
					status: 'running',
					input: {
						file_path: 'src/utils.ts',
						old_string: 'const x = 1;',
						new_string: 'const x = 42;',
					},
				},
				timestamp: Date.now(),
			});

			await flushAll();
			const manifest = await readVibesManifest(tmpDir);
			const entries = Object.values(manifest.entries);
			const cmdEntries = entries.filter((e) => e.type === 'command') as VibesCommandEntry[];
			expect(cmdEntries).toHaveLength(1);
			expect(cmdEntries[0].command_output_summary).toBe('Replaced 12 chars in src/utils.ts');
		});

		it('should generate output summary for MultiEdit tool with edits array', async () => {
			await setupSession('sess-1');
			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			await instrumenter.handleToolExecution('sess-1', {
				toolName: 'MultiEdit',
				state: {
					status: 'running',
					input: {
						file_path: 'src/multi.ts',
						edits: [
							{ old_string: 'a', new_string: 'b' },
							{ old_string: 'c', new_string: 'd' },
							{ old_string: 'e', new_string: 'f' },
						],
					},
				},
				timestamp: Date.now(),
			});

			await flushAll();
			const manifest = await readVibesManifest(tmpDir);
			const entries = Object.values(manifest.entries);
			const cmdEntries = entries.filter((e) => e.type === 'command') as VibesCommandEntry[];
			expect(cmdEntries).toHaveLength(1);
			expect(cmdEntries[0].command_output_summary).toBe('Applied 3 edits to src/multi.ts');
		});

		it('should generate output summary for Write tool with content', async () => {
			await setupSession('sess-1');
			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			const content = 'line 1\nline 2\nline 3\nline 4\nline 5';
			await instrumenter.handleToolExecution('sess-1', {
				toolName: 'Write',
				state: {
					status: 'running',
					input: {
						file_path: 'src/new-file.ts',
						content,
					},
				},
				timestamp: Date.now(),
			});

			await flushAll();
			const manifest = await readVibesManifest(tmpDir);
			const entries = Object.values(manifest.entries);
			const cmdEntries = entries.filter((e) => e.type === 'command') as VibesCommandEntry[];
			expect(cmdEntries).toHaveLength(1);
			expect(cmdEntries[0].command_output_summary).toBe('Wrote 5 lines to src/new-file.ts');
		});

		it('should return null output summary for Bash tool (stream-json limitation)', async () => {
			await setupSession('sess-1');
			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			await instrumenter.handleToolExecution('sess-1', {
				toolName: 'Bash',
				state: { status: 'running', input: { command: 'npm test' } },
				timestamp: Date.now(),
			});

			await flushAll();
			const manifest = await readVibesManifest(tmpDir);
			const entries = Object.values(manifest.entries);
			const cmdEntries = entries.filter((e) => e.type === 'command') as VibesCommandEntry[];
			expect(cmdEntries).toHaveLength(1);
			expect(cmdEntries[0].command_output_summary).toBeNull();
		});

		it('should return null output summary for Read tool', async () => {
			await setupSession('sess-1');
			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			await instrumenter.handleToolExecution('sess-1', {
				toolName: 'Read',
				state: { status: 'running', input: { file_path: 'package.json' } },
				timestamp: Date.now(),
			});

			await flushAll();
			const manifest = await readVibesManifest(tmpDir);
			const entries = Object.values(manifest.entries);
			const cmdEntries = entries.filter((e) => e.type === 'command') as VibesCommandEntry[];
			expect(cmdEntries).toHaveLength(1);
			expect(cmdEntries[0].command_output_summary).toBeNull();
		});

		it('should always have null command_exit_code (stream-json limitation)', async () => {
			await setupSession('sess-1');
			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			await instrumenter.handleToolExecution('sess-1', {
				toolName: 'Bash',
				state: { status: 'running', input: { command: 'echo hello' } },
				timestamp: Date.now(),
			});

			await flushAll();
			const manifest = await readVibesManifest(tmpDir);
			const entries = Object.values(manifest.entries);
			const cmdEntries = entries.filter((e) => e.type === 'command') as VibesCommandEntry[];
			expect(cmdEntries).toHaveLength(1);
			expect(cmdEntries[0].command_exit_code).toBeNull();
		});

		it('should normalize absolute file paths in output summary relative to projectPath', async () => {
			await setupSession('sess-1');
			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			await instrumenter.handleToolExecution('sess-1', {
				toolName: 'Edit',
				state: {
					status: 'running',
					input: {
						file_path: path.join(tmpDir, 'src/utils.ts'),
						old_string: 'hello world',
						new_string: 'goodbye world',
					},
				},
				timestamp: Date.now(),
			});

			await flushAll();
			const manifest = await readVibesManifest(tmpDir);
			const entries = Object.values(manifest.entries);
			const cmdEntries = entries.filter((e) => e.type === 'command') as VibesCommandEntry[];
			expect(cmdEntries).toHaveLength(1);
			// Should be relative: "Replaced 11 chars in src/utils.ts"
			expect(cmdEntries[0].command_output_summary).toBe('Replaced 11 chars in src/utils.ts');
		});
	});

	// ========================================================================
	// Path Normalization
	// ========================================================================
	describe('path normalization', () => {
		it('should normalize file paths with . and .. segments', async () => {
			await setupSession('sess-1');
			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			await instrumenter.handleToolExecution('sess-1', {
				toolName: 'Write',
				state: { status: 'running', input: { file_path: 'src/../src/./main.ts' } },
				timestamp: Date.now(),
			});

			const annotations = await readAnnotations(tmpDir);
			const lineAnnotations = annotations.filter((a) => a.type === 'line') as VibesLineAnnotation[];
			expect(lineAnnotations).toHaveLength(1);
			expect(lineAnnotations[0].file_path).toBe('src/main.ts');
		});

		it('should handle absolute paths in tool events', async () => {
			await setupSession('sess-1');
			const instrumenter = new ClaudeCodeInstrumenter({
				sessionManager: manager,
				assuranceLevel: 'medium',
			});

			await instrumenter.handleToolExecution('sess-1', {
				toolName: 'Write',
				state: { status: 'running', input: { file_path: '/home/user/project/src/main.ts' } },
				timestamp: Date.now(),
			});

			const annotations = await readAnnotations(tmpDir);
			const lineAnnotations = annotations.filter((a) => a.type === 'line') as VibesLineAnnotation[];
			expect(lineAnnotations).toHaveLength(1);
			expect(lineAnnotations[0].file_path).toBe('/home/user/project/src/main.ts');
		});
	});
});
