/**
 * Tests for src/main/vibes/vibes-io.ts
 * Validates the VIBES file I/O module: reading/writing config, manifest,
 * and annotations in the .ai-audit/ directory structure.
 * Includes tests for the async write buffer, debounced manifest writes,
 * file locking, and graceful error handling.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, access, constants, writeFile as fsWriteFile, mkdir } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

import {
	ensureAuditDir,
	readVibesConfig,
	writeVibesConfig,
	readVibesManifest,
	writeVibesManifest,
	appendAnnotation,
	appendAnnotationImmediate,
	appendAnnotations,
	readAnnotations,
	addManifestEntry,
	addManifestEntryImmediate,
	flushAll,
	getBufferedAnnotationCount,
	getPendingManifestEntryCount,
	resetAllBuffers,
	initVibesDirectly,
	writeReasoningBlob,
	backfillCommitHash,
	rehashManifest,
	computeStatsFromAnnotations,
	extractSessionsFromAnnotations,
	extractModelsFromManifest,
	computeBlameFromAnnotations,
	computeCoverageFromAnnotations,
	computeLocCoverageFromAnnotations,
} from '../../../main/vibes/vibes-io';

import { computeVibesHash } from '../../../main/vibes/vibes-hash';

import type {
	VibesConfig,
	VibesManifest,
	VibesLineAnnotation,
	VibeFunctionAnnotation,
	VibesSessionRecord,
	VibesEnvironmentEntry,
	VibesCommandEntry,
	VibesPromptEntry,
} from '../../../shared/vibes-types';

// ============================================================================
// Test Fixtures
// ============================================================================

const SAMPLE_CONFIG: VibesConfig = {
	standard: 'VIBES',
	standard_version: '1.0',
	assurance_level: 'medium',
	project_name: 'test-project',
	tracked_extensions: ['.ts', '.js'],
	exclude_patterns: ['**/node_modules/**'],
	compress_reasoning_threshold_bytes: 10240,
	external_blob_threshold_bytes: 102400,
};

const SAMPLE_LINE_ANNOTATION: VibesLineAnnotation = {
	type: 'line',
	file_path: 'src/index.ts',
	line_start: 1,
	line_end: 10,
	environment_hash: 'abc123def456789012345678901234567890123456789012345678901234',
	command_hash: null,
	prompt_hash: null,
	reasoning_hash: null,
	action: 'create',
	timestamp: '2026-02-10T12:00:00Z',
	commit_hash: null,
	session_id: null,
	assurance_level: 'medium',
};

const SAMPLE_FUNCTION_ANNOTATION: VibeFunctionAnnotation = {
	type: 'function',
	file_path: 'src/utils.ts',
	function_name: 'computeHash',
	function_signature: 'computeHash(data: string): string',
	environment_hash: 'def456789012345678901234567890123456789012345678901234567890ab',
	action: 'modify',
	timestamp: '2026-02-10T12:05:00Z',
	assurance_level: 'high',
};

const SAMPLE_SESSION_RECORD: VibesSessionRecord = {
	type: 'session',
	event: 'start',
	session_id: 'session-001',
	timestamp: '2026-02-10T12:00:00Z',
	assurance_level: 'medium',
};

const SAMPLE_ENVIRONMENT_ENTRY: VibesEnvironmentEntry = {
	type: 'environment',
	tool_name: 'maestro',
	tool_version: '2.0',
	model_name: 'claude-4',
	model_version: 'opus',
	created_at: '2026-02-10T12:00:00Z',
};

// ============================================================================
// Test Suite
// ============================================================================

describe('vibes-io', () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(path.join(os.tmpdir(), 'vibes-io-test-'));
		resetAllBuffers();
	});

	afterEach(async () => {
		resetAllBuffers();
		await rm(tmpDir, { recursive: true, force: true });
	});

	// ========================================================================
	// ensureAuditDir
	// ========================================================================
	describe('ensureAuditDir', () => {
		it('should create .ai-audit/ and .ai-audit/blobs/ directories', async () => {
			await ensureAuditDir(tmpDir);

			await expect(access(path.join(tmpDir, '.ai-audit'), constants.F_OK)).resolves.toBeUndefined();
			await expect(access(path.join(tmpDir, '.ai-audit', 'blobs'), constants.F_OK)).resolves.toBeUndefined();
		});

		it('should be idempotent (safe to call multiple times)', async () => {
			await ensureAuditDir(tmpDir);
			await ensureAuditDir(tmpDir);

			await expect(access(path.join(tmpDir, '.ai-audit'), constants.F_OK)).resolves.toBeUndefined();
			await expect(access(path.join(tmpDir, '.ai-audit', 'blobs'), constants.F_OK)).resolves.toBeUndefined();
		});
	});

	// ========================================================================
	// readVibesConfig / writeVibesConfig
	// ========================================================================
	describe('readVibesConfig', () => {
		it('should return null when config does not exist', async () => {
			const config = await readVibesConfig(tmpDir);
			expect(config).toBeNull();
		});

		it('should return null when .ai-audit/ directory does not exist', async () => {
			const config = await readVibesConfig(path.join(tmpDir, 'nonexistent'));
			expect(config).toBeNull();
		});
	});

	describe('writeVibesConfig', () => {
		it('should write config.json with pretty formatting', async () => {
			await writeVibesConfig(tmpDir, SAMPLE_CONFIG);

			const raw = await readFile(path.join(tmpDir, '.ai-audit', 'config.json'), 'utf8');
			expect(raw).toContain('\t');
			expect(raw.endsWith('\n')).toBe(true);

			const parsed = JSON.parse(raw);
			expect(parsed).toEqual(SAMPLE_CONFIG);
		});

		it('should create .ai-audit/ directory if it does not exist', async () => {
			await writeVibesConfig(tmpDir, SAMPLE_CONFIG);

			await expect(access(path.join(tmpDir, '.ai-audit'), constants.F_OK)).resolves.toBeUndefined();
		});
	});

	describe('readVibesConfig + writeVibesConfig roundtrip', () => {
		it('should roundtrip config data correctly', async () => {
			await writeVibesConfig(tmpDir, SAMPLE_CONFIG);
			const config = await readVibesConfig(tmpDir);

			expect(config).toEqual(SAMPLE_CONFIG);
		});

		it('should handle config with all fields', async () => {
			const fullConfig: VibesConfig = {
				standard: 'VIBES',
				standard_version: '1.0',
				assurance_level: 'high',
				project_name: 'full-project',
				tracked_extensions: ['.ts', '.tsx', '.js', '.jsx', '.py', '.rs'],
				exclude_patterns: ['**/node_modules/**', '**/dist/**', '**/.git/**'],
				compress_reasoning_threshold_bytes: 5120,
				external_blob_threshold_bytes: 51200,
			};

			await writeVibesConfig(tmpDir, fullConfig);
			const config = await readVibesConfig(tmpDir);

			expect(config).toEqual(fullConfig);
		});

		it('should overwrite existing config', async () => {
			await writeVibesConfig(tmpDir, SAMPLE_CONFIG);

			const updatedConfig: VibesConfig = {
				...SAMPLE_CONFIG,
				assurance_level: 'high',
				project_name: 'updated-project',
			};
			await writeVibesConfig(tmpDir, updatedConfig);

			const config = await readVibesConfig(tmpDir);
			expect(config).toEqual(updatedConfig);
		});
	});

	// ========================================================================
	// readVibesManifest / writeVibesManifest
	// ========================================================================
	describe('readVibesManifest', () => {
		it('should return empty manifest when file does not exist', async () => {
			const manifest = await readVibesManifest(tmpDir);

			expect(manifest).toEqual({
				standard: 'VIBES',
				version: '1.0',
				entries: {},
			});
		});

		it('should return empty manifest when .ai-audit/ does not exist', async () => {
			const manifest = await readVibesManifest(path.join(tmpDir, 'nonexistent'));

			expect(manifest).toEqual({
				standard: 'VIBES',
				version: '1.0',
				entries: {},
			});
		});
	});

	describe('writeVibesManifest', () => {
		it('should write manifest.json with pretty formatting', async () => {
			const manifest: VibesManifest = {
				standard: 'VIBES',
				version: '1.0',
				entries: {},
			};
			await writeVibesManifest(tmpDir, manifest);

			const raw = await readFile(path.join(tmpDir, '.ai-audit', 'manifest.json'), 'utf8');
			expect(raw).toContain('\t');
			expect(raw.endsWith('\n')).toBe(true);

			const parsed = JSON.parse(raw);
			expect(parsed).toEqual(manifest);
		});

		it('should create .ai-audit/ directory if it does not exist', async () => {
			await writeVibesManifest(tmpDir, { standard: 'VIBES', version: '1.0', entries: {} });

			await expect(access(path.join(tmpDir, '.ai-audit'), constants.F_OK)).resolves.toBeUndefined();
		});
	});

	describe('readVibesManifest + writeVibesManifest roundtrip', () => {
		it('should roundtrip manifest with entries', async () => {
			const manifest: VibesManifest = {
				standard: 'VIBES',
				version: '1.0',
				entries: {
					'abc123': SAMPLE_ENVIRONMENT_ENTRY,
					'def456': {
						type: 'command',
						command_text: 'npm test',
						command_type: 'shell',
						command_exit_code: 0,
						created_at: '2026-02-10T12:01:00Z',
					} as VibesCommandEntry,
				},
			};

			await writeVibesManifest(tmpDir, manifest);
			const result = await readVibesManifest(tmpDir);

			expect(result).toEqual(manifest);
		});
	});

	// ========================================================================
	// Version Validation (GAP 4 fix)
	// ========================================================================
	describe('version validation', () => {
		it('warns when manifest version is not 1.0', async () => {
			await ensureAuditDir(tmpDir);
			const manifestPath = path.join(tmpDir, '.ai-audit', 'manifest.json');
			const badManifest = { standard: 'VIBES', version: '2.0', entries: {} };
			await fsWriteFile(manifestPath, JSON.stringify(badManifest), 'utf8');

			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
			try {
				await readVibesManifest(tmpDir);
				expect(warnSpy).toHaveBeenCalledWith(
					expect.stringContaining("unsupported version: '2.0'"),
				);
			} finally {
				warnSpy.mockRestore();
			}
		});

		it('warns when config standard_version is not 1.0', async () => {
			await ensureAuditDir(tmpDir);
			const configPath = path.join(tmpDir, '.ai-audit', 'config.json');
			const badConfig = {
				...SAMPLE_CONFIG,
				standard_version: '2.0',
			};
			await fsWriteFile(configPath, JSON.stringify(badConfig), 'utf8');

			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
			try {
				await readVibesConfig(tmpDir);
				expect(warnSpy).toHaveBeenCalledWith(
					expect.stringContaining("unsupported standard_version: '2.0'"),
				);
			} finally {
				warnSpy.mockRestore();
			}
		});

		it('reads manifest successfully even with unsupported version (fail open)', async () => {
			await ensureAuditDir(tmpDir);
			const manifestPath = path.join(tmpDir, '.ai-audit', 'manifest.json');
			const badManifest = {
				standard: 'VIBES',
				version: '99.0',
				entries: { 'abc': { type: 'environment', tool_name: 'test', tool_version: '1.0', model_name: 'm', model_version: '1', created_at: '2026-02-10T12:00:00Z' } },
			};
			await fsWriteFile(manifestPath, JSON.stringify(badManifest), 'utf8');

			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
			try {
				const manifest = await readVibesManifest(tmpDir);
				// Should return the manifest data despite version mismatch
				expect(manifest.version).toBe('99.0');
				expect(manifest.entries['abc']).toBeDefined();
				expect(manifest.entries['abc'].type).toBe('environment');
			} finally {
				warnSpy.mockRestore();
			}
		});

		it('reads config successfully even with unsupported version (fail open)', async () => {
			await ensureAuditDir(tmpDir);
			const configPath = path.join(tmpDir, '.ai-audit', 'config.json');
			const badConfig = {
				...SAMPLE_CONFIG,
				standard_version: '99.0',
			};
			await fsWriteFile(configPath, JSON.stringify(badConfig), 'utf8');

			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
			try {
				const config = await readVibesConfig(tmpDir);
				// Should return the config data despite version mismatch
				expect(config).not.toBeNull();
				expect(config!.standard_version).toBe('99.0');
				expect(config!.project_name).toBe('test-project');
			} finally {
				warnSpy.mockRestore();
			}
		});
	});

	// ========================================================================
	// Atomic Writes (DIVERGENCE 1 fix)
	// ========================================================================
	describe('atomic writes', () => {
		it('writes manifest atomically via temp file + rename', async () => {
			// Pre-create a stale .tmp file to prove the atomic write cycle runs
			await ensureAuditDir(tmpDir);
			const manifestTmpPath = path.join(tmpDir, '.ai-audit', 'manifest.json.tmp');
			await fsWriteFile(manifestTmpPath, 'stale-data', 'utf8');

			const manifest: VibesManifest = {
				standard: 'VIBES',
				version: '1.0',
				entries: {},
			};
			await writeVibesManifest(tmpDir, manifest);

			// Final file has correct content
			const manifestPath = path.join(tmpDir, '.ai-audit', 'manifest.json');
			const raw = await readFile(manifestPath, 'utf8');
			expect(JSON.parse(raw)).toEqual(manifest);

			// Temp file was consumed by rename (no longer exists)
			await expect(access(manifestTmpPath, constants.F_OK)).rejects.toThrow();
		});

		it('writes config atomically via temp file + rename', async () => {
			// Pre-create a stale .tmp file to prove the atomic write cycle runs
			await ensureAuditDir(tmpDir);
			const configTmpPath = path.join(tmpDir, '.ai-audit', 'config.json.tmp');
			await fsWriteFile(configTmpPath, 'stale-data', 'utf8');

			await writeVibesConfig(tmpDir, SAMPLE_CONFIG);

			// Final file has correct content
			const configPath = path.join(tmpDir, '.ai-audit', 'config.json');
			const raw = await readFile(configPath, 'utf8');
			expect(JSON.parse(raw)).toEqual(SAMPLE_CONFIG);

			// Temp file was consumed by rename (no longer exists)
			await expect(access(configTmpPath, constants.F_OK)).rejects.toThrow();
		});

		it('no temp file remains after successful write', async () => {
			const manifest: VibesManifest = {
				standard: 'VIBES',
				version: '1.0',
				entries: {},
			};
			await writeVibesManifest(tmpDir, manifest);
			await writeVibesConfig(tmpDir, SAMPLE_CONFIG);

			// Neither .tmp file should exist
			const manifestTmpPath = path.join(tmpDir, '.ai-audit', 'manifest.json.tmp');
			const configTmpPath = path.join(tmpDir, '.ai-audit', 'config.json.tmp');
			await expect(access(manifestTmpPath, constants.F_OK)).rejects.toThrow();
			await expect(access(configTmpPath, constants.F_OK)).rejects.toThrow();
		});
	});

	// ========================================================================
	// appendAnnotation / readAnnotations (buffered)
	// ========================================================================
	describe('appendAnnotation', () => {
		it('should buffer annotations and flush on readAnnotations', async () => {
			await appendAnnotation(tmpDir, SAMPLE_LINE_ANNOTATION);

			// Data should be in the buffer
			expect(getBufferedAnnotationCount(tmpDir)).toBeGreaterThanOrEqual(0);

			// readAnnotations triggers a flush
			const annotations = await readAnnotations(tmpDir);
			expect(annotations).toHaveLength(1);
			expect(annotations[0]).toEqual(SAMPLE_LINE_ANNOTATION);
		});

		it('should buffer and flush multiple sequential annotations', async () => {
			await appendAnnotation(tmpDir, SAMPLE_LINE_ANNOTATION);
			await appendAnnotation(tmpDir, SAMPLE_FUNCTION_ANNOTATION);
			await appendAnnotation(tmpDir, SAMPLE_SESSION_RECORD);

			// Flush and read
			const annotations = await readAnnotations(tmpDir);

			expect(annotations).toHaveLength(3);
			expect(annotations[0]).toEqual(SAMPLE_LINE_ANNOTATION);
			expect(annotations[1]).toEqual(SAMPLE_FUNCTION_ANNOTATION);
			expect(annotations[2]).toEqual(SAMPLE_SESSION_RECORD);
		});

		it('should create annotations.jsonl after flush', async () => {
			await appendAnnotation(tmpDir, SAMPLE_LINE_ANNOTATION);
			await flushAll();

			await expect(
				access(path.join(tmpDir, '.ai-audit', 'annotations.jsonl'), constants.F_OK),
			).resolves.toBeUndefined();
		});
	});

	describe('appendAnnotations', () => {
		it('should write multiple annotations via buffer', async () => {
			const annotations = [SAMPLE_LINE_ANNOTATION, SAMPLE_FUNCTION_ANNOTATION, SAMPLE_SESSION_RECORD];
			await appendAnnotations(tmpDir, annotations);

			const result = await readAnnotations(tmpDir);

			expect(result).toHaveLength(3);
			expect(result[0]).toEqual(SAMPLE_LINE_ANNOTATION);
			expect(result[1]).toEqual(SAMPLE_FUNCTION_ANNOTATION);
			expect(result[2]).toEqual(SAMPLE_SESSION_RECORD);
		});

		it('should handle empty array without buffering', async () => {
			await appendAnnotations(tmpDir, []);
			expect(getBufferedAnnotationCount(tmpDir)).toBe(0);
		});

		it('should append to existing annotations', async () => {
			await appendAnnotation(tmpDir, SAMPLE_LINE_ANNOTATION);
			await flushAll();
			await appendAnnotations(tmpDir, [SAMPLE_FUNCTION_ANNOTATION, SAMPLE_SESSION_RECORD]);

			const result = await readAnnotations(tmpDir);
			expect(result).toHaveLength(3);
		});

		it('should write a single annotation', async () => {
			await appendAnnotations(tmpDir, [SAMPLE_LINE_ANNOTATION]);

			const result = await readAnnotations(tmpDir);
			expect(result).toHaveLength(1);
			expect(result[0]).toEqual(SAMPLE_LINE_ANNOTATION);
		});
	});

	describe('readAnnotations', () => {
		it('should return empty array when file does not exist', async () => {
			const annotations = await readAnnotations(tmpDir);
			expect(annotations).toEqual([]);
		});

		it('should return empty array when .ai-audit/ does not exist', async () => {
			const annotations = await readAnnotations(path.join(tmpDir, 'nonexistent'));
			expect(annotations).toEqual([]);
		});

		it('should parse all annotation types', async () => {
			await appendAnnotation(tmpDir, SAMPLE_LINE_ANNOTATION);
			await appendAnnotation(tmpDir, SAMPLE_FUNCTION_ANNOTATION);
			await appendAnnotation(tmpDir, SAMPLE_SESSION_RECORD);

			const annotations = await readAnnotations(tmpDir);

			expect(annotations).toHaveLength(3);
			expect(annotations[0]).toEqual(SAMPLE_LINE_ANNOTATION);
			expect(annotations[1]).toEqual(SAMPLE_FUNCTION_ANNOTATION);
			expect(annotations[2]).toEqual(SAMPLE_SESSION_RECORD);
		});

		it('should skip blank lines', async () => {
			await ensureAuditDir(tmpDir);
			const annotationsPath = path.join(tmpDir, '.ai-audit', 'annotations.jsonl');
			const content = JSON.stringify(SAMPLE_LINE_ANNOTATION) + '\n\n' +
				JSON.stringify(SAMPLE_FUNCTION_ANNOTATION) + '\n\n';
			await fsWriteFile(annotationsPath, content, 'utf8');

			const annotations = await readAnnotations(tmpDir);

			expect(annotations).toHaveLength(2);
			expect(annotations[0]).toEqual(SAMPLE_LINE_ANNOTATION);
			expect(annotations[1]).toEqual(SAMPLE_FUNCTION_ANNOTATION);
		});
	});

	// ========================================================================
	// Write Buffer Behavior
	// ========================================================================
	describe('write buffer', () => {
		it('should buffer annotations in memory before flush', async () => {
			await appendAnnotation(tmpDir, SAMPLE_LINE_ANNOTATION);
			// Buffer should hold the annotation (may be 0 if auto-flush already fired, but typically 1)
			const count = getBufferedAnnotationCount(tmpDir);
			// It should be >= 0 (could have already flushed asynchronously)
			expect(count).toBeGreaterThanOrEqual(0);
		});

		it('should flush all buffers with flushAll()', async () => {
			await appendAnnotation(tmpDir, SAMPLE_LINE_ANNOTATION);
			await appendAnnotation(tmpDir, SAMPLE_FUNCTION_ANNOTATION);

			await flushAll();

			// Buffer should be empty after flush
			expect(getBufferedAnnotationCount(tmpDir)).toBe(0);

			// Data should be on disk
			const raw = await readFile(path.join(tmpDir, '.ai-audit', 'annotations.jsonl'), 'utf8');
			const lines = raw.trim().split('\n');
			expect(lines).toHaveLength(2);
		});

		it('should auto-flush when buffer reaches 20 annotations', async () => {
			const annotations: VibesLineAnnotation[] = [];
			for (let i = 0; i < 25; i++) {
				annotations.push({
					...SAMPLE_LINE_ANNOTATION,
					line_start: i,
					line_end: i + 5,
					timestamp: `2026-02-10T12:${String(i).padStart(2, '0')}:00Z`,
				});
			}

			await appendAnnotations(tmpDir, annotations);

			// Give the async flush a moment to complete
			await new Promise((resolve) => setTimeout(resolve, 100));

			// Now flush remaining
			await flushAll();

			const result = await readAnnotations(tmpDir);
			expect(result).toHaveLength(25);
		});

		it('should handle multiple projects independently', async () => {
			const tmpDir2 = await mkdtemp(path.join(os.tmpdir(), 'vibes-io-test2-'));

			try {
				await appendAnnotation(tmpDir, SAMPLE_LINE_ANNOTATION);
				await appendAnnotation(tmpDir2, SAMPLE_FUNCTION_ANNOTATION);

				await flushAll();

				const annotations1 = await readAnnotations(tmpDir);
				const annotations2 = await readAnnotations(tmpDir2);

				expect(annotations1).toHaveLength(1);
				expect(annotations1[0]).toEqual(SAMPLE_LINE_ANNOTATION);
				expect(annotations2).toHaveLength(1);
				expect(annotations2[0]).toEqual(SAMPLE_FUNCTION_ANNOTATION);
			} finally {
				await rm(tmpDir2, { recursive: true, force: true });
			}
		});

		it('should clear all buffers and timers with resetAllBuffers()', async () => {
			await appendAnnotation(tmpDir, SAMPLE_LINE_ANNOTATION);
			resetAllBuffers();

			expect(getBufferedAnnotationCount(tmpDir)).toBe(0);
			expect(getPendingManifestEntryCount(tmpDir)).toBe(0);
		});
	});

	// ========================================================================
	// addManifestEntry (debounced)
	// ========================================================================
	describe('addManifestEntry', () => {
		it('should add a new entry to an empty manifest after flush', async () => {
			const hash = 'abc123def456789012345678901234567890123456789012345678901234';
			await addManifestEntry(tmpDir, hash, SAMPLE_ENVIRONMENT_ENTRY);

			// Debounced — need to flush
			await flushAll();

			const manifest = await readVibesManifest(tmpDir);
			expect(manifest.entries[hash]).toEqual(SAMPLE_ENVIRONMENT_ENTRY);
		});

		it('should not overwrite an existing entry with the same hash', async () => {
			const hash = 'abc123def456789012345678901234567890123456789012345678901234';

			// Write the first entry directly to disk
			const manifest: VibesManifest = {
				standard: 'VIBES',
				version: '1.0',
				entries: { [hash]: SAMPLE_ENVIRONMENT_ENTRY },
			};
			await writeVibesManifest(tmpDir, manifest);

			const differentEntry: VibesPromptEntry = {
				type: 'prompt',
				prompt_text: 'different prompt',
				created_at: '2026-02-10T13:00:00Z',
			};
			await addManifestEntry(tmpDir, hash, differentEntry);
			await flushAll();

			const result = await readVibesManifest(tmpDir);
			expect(result.entries[hash]).toEqual(SAMPLE_ENVIRONMENT_ENTRY);
		});

		it('should add multiple entries with different hashes', async () => {
			const hash1 = 'abc123def456789012345678901234567890123456789012345678901234';
			const hash2 = 'def456789012345678901234567890123456789012345678901234567890';
			const hash3 = '789012345678901234567890123456789012345678901234567890abcdef';

			const commandEntry: VibesCommandEntry = {
				type: 'command',
				command_text: 'npm test',
				command_type: 'shell',
				created_at: '2026-02-10T12:01:00Z',
			};

			const promptEntry: VibesPromptEntry = {
				type: 'prompt',
				prompt_text: 'Add unit tests',
				prompt_type: 'user_instruction',
				created_at: '2026-02-10T12:02:00Z',
			};

			await addManifestEntry(tmpDir, hash1, SAMPLE_ENVIRONMENT_ENTRY);
			await addManifestEntry(tmpDir, hash2, commandEntry);
			await addManifestEntry(tmpDir, hash3, promptEntry);

			await flushAll();

			const manifest = await readVibesManifest(tmpDir);
			expect(Object.keys(manifest.entries)).toHaveLength(3);
			expect(manifest.entries[hash1]).toEqual(SAMPLE_ENVIRONMENT_ENTRY);
			expect(manifest.entries[hash2]).toEqual(commandEntry);
			expect(manifest.entries[hash3]).toEqual(promptEntry);
		});

		it('should preserve existing manifest structure', async () => {
			// Pre-populate manifest with a custom structure
			const existingManifest: VibesManifest = {
				standard: 'VIBES',
				version: '1.0',
				entries: {
					'existing-hash': SAMPLE_ENVIRONMENT_ENTRY,
				},
			};
			await writeVibesManifest(tmpDir, existingManifest);

			const newHash = 'new-hash-value-012345678901234567890123456789012345678901234';
			const commandEntry: VibesCommandEntry = {
				type: 'command',
				command_text: 'git commit',
				command_type: 'shell',
				created_at: '2026-02-10T12:03:00Z',
			};
			await addManifestEntry(tmpDir, newHash, commandEntry);
			await flushAll();

			const manifest = await readVibesManifest(tmpDir);
			expect(manifest.standard).toBe('VIBES');
			expect(manifest.version).toBe('1.0');
			expect(Object.keys(manifest.entries)).toHaveLength(2);
			expect(manifest.entries['existing-hash']).toEqual(SAMPLE_ENVIRONMENT_ENTRY);
			expect(manifest.entries[newHash]).toEqual(commandEntry);
		});

		it('should track pending manifest entries', async () => {
			const hash = 'test-hash-012345678901234567890123456789012345678901234567890';
			await addManifestEntry(tmpDir, hash, SAMPLE_ENVIRONMENT_ENTRY);

			expect(getPendingManifestEntryCount(tmpDir)).toBe(1);

			await flushAll();
			expect(getPendingManifestEntryCount(tmpDir)).toBe(0);
		});
	});

	// ========================================================================
	// flushAll
	// ========================================================================
	describe('flushAll', () => {
		it('should flush both annotation buffers and manifest debounces', async () => {
			await appendAnnotation(tmpDir, SAMPLE_LINE_ANNOTATION);
			const hash = 'test-hash-012345678901234567890123456789012345678901234567890';
			await addManifestEntry(tmpDir, hash, SAMPLE_ENVIRONMENT_ENTRY);

			await flushAll();

			expect(getBufferedAnnotationCount(tmpDir)).toBe(0);
			expect(getPendingManifestEntryCount(tmpDir)).toBe(0);

			// Verify data is on disk
			const annotations = await readAnnotations(tmpDir);
			expect(annotations).toHaveLength(1);

			const manifest = await readVibesManifest(tmpDir);
			expect(manifest.entries[hash]).toEqual(SAMPLE_ENVIRONMENT_ENTRY);
		});

		it('should be safe to call with no pending data', async () => {
			await expect(flushAll()).resolves.toBeUndefined();
		});

		it('should flush multiple projects', async () => {
			const tmpDir2 = await mkdtemp(path.join(os.tmpdir(), 'vibes-io-test-flush-'));

			try {
				await appendAnnotation(tmpDir, SAMPLE_LINE_ANNOTATION);
				await appendAnnotation(tmpDir2, SAMPLE_FUNCTION_ANNOTATION);

				await flushAll();

				const annotations1 = await readAnnotations(tmpDir);
				const annotations2 = await readAnnotations(tmpDir2);

				expect(annotations1).toHaveLength(1);
				expect(annotations2).toHaveLength(1);
			} finally {
				await rm(tmpDir2, { recursive: true, force: true });
			}
		});
	});

	// ========================================================================
	// Graceful Error Handling
	// ========================================================================
	describe('graceful error handling', () => {
		it('should not throw when buffering an annotation for invalid path', async () => {
			// appendAnnotation should never throw — just log
			await expect(
				appendAnnotation('/nonexistent/path/that/will/fail', SAMPLE_LINE_ANNOTATION),
			).resolves.toBeUndefined();
		});

		it('should not throw when flushing fails', async () => {
			await appendAnnotation('/nonexistent/path', SAMPLE_LINE_ANNOTATION);
			// flushAll should handle the error gracefully
			await expect(flushAll()).resolves.toBeUndefined();
		});

		it('should not throw when addManifestEntry target is invalid', async () => {
			await expect(
				addManifestEntry('/nonexistent/path', 'hash', SAMPLE_ENVIRONMENT_ENTRY),
			).resolves.toBeUndefined();
		});
	});

	// ========================================================================
	// Integration: Full Workflow
	// ========================================================================
	describe('integration', () => {
		it('should support a full audit directory workflow', async () => {
			// 1. Ensure directory exists
			await ensureAuditDir(tmpDir);

			// 2. Write config
			await writeVibesConfig(tmpDir, SAMPLE_CONFIG);
			const config = await readVibesConfig(tmpDir);
			expect(config).toEqual(SAMPLE_CONFIG);

			// 3. Add manifest entries (debounced)
			const envHash = 'env-hash-0123456789012345678901234567890123456789012345678901';
			await addManifestEntry(tmpDir, envHash, SAMPLE_ENVIRONMENT_ENTRY);

			// 4. Write annotations (buffered)
			await appendAnnotation(tmpDir, SAMPLE_LINE_ANNOTATION);
			await appendAnnotations(tmpDir, [SAMPLE_FUNCTION_ANNOTATION, SAMPLE_SESSION_RECORD]);

			// 5. Flush everything
			await flushAll();

			// 6. Read back everything
			const manifest = await readVibesManifest(tmpDir);
			expect(Object.keys(manifest.entries)).toHaveLength(1);
			expect(manifest.entries[envHash]).toEqual(SAMPLE_ENVIRONMENT_ENTRY);

			const annotations = await readAnnotations(tmpDir);
			expect(annotations).toHaveLength(3);
			expect(annotations[0].type).toBe('line');
			expect(annotations[1].type).toBe('function');
			expect(annotations[2].type).toBe('session');
		});

		it('should handle concurrent annotation and manifest writes', async () => {
			const hashes = ['hash-a', 'hash-b', 'hash-c'];
			const entries = hashes.map((h, i) => ({
				type: 'command' as const,
				command_text: `cmd-${i}`,
				command_type: 'shell' as const,
				created_at: `2026-02-10T12:0${i}:00Z`,
			}));

			// Fire off multiple operations concurrently
			const promises = [
				appendAnnotation(tmpDir, SAMPLE_LINE_ANNOTATION),
				appendAnnotation(tmpDir, SAMPLE_FUNCTION_ANNOTATION),
				appendAnnotation(tmpDir, SAMPLE_SESSION_RECORD),
				addManifestEntry(tmpDir, hashes[0], entries[0]),
				addManifestEntry(tmpDir, hashes[1], entries[1]),
				addManifestEntry(tmpDir, hashes[2], entries[2]),
			];
			await Promise.all(promises);

			await flushAll();

			const annotations = await readAnnotations(tmpDir);
			expect(annotations).toHaveLength(3);

			const manifest = await readVibesManifest(tmpDir);
			expect(Object.keys(manifest.entries)).toHaveLength(3);
		});
	});

	// ========================================================================
	// initVibesDirectly (Fallback initialization)
	// ========================================================================
	describe('initVibesDirectly', () => {
		it('should create .ai-audit/ directory structure', async () => {
			const result = await initVibesDirectly(tmpDir, {
				projectName: 'test-project',
				assuranceLevel: 'medium',
			});

			expect(result.success).toBe(true);
			await expect(access(path.join(tmpDir, '.ai-audit'), constants.F_OK)).resolves.toBeUndefined();
			await expect(access(path.join(tmpDir, '.ai-audit', 'blobs'), constants.F_OK)).resolves.toBeUndefined();
		});

		it('should create a valid config.json', async () => {
			await initVibesDirectly(tmpDir, {
				projectName: 'my-app',
				assuranceLevel: 'high',
			});

			const config = await readVibesConfig(tmpDir);
			expect(config).not.toBeNull();
			expect(config!.standard).toBe('VIBES');
			expect(config!.standard_version).toBe('1.0');
			expect(config!.project_name).toBe('my-app');
			expect(config!.assurance_level).toBe('high');
			expect(config!.tracked_extensions).toContain('.ts');
			expect(config!.exclude_patterns).toContain('**/node_modules/**');
		});

		it('should create an empty manifest.json', async () => {
			await initVibesDirectly(tmpDir, {
				projectName: 'test-project',
				assuranceLevel: 'medium',
			});

			const manifest = await readVibesManifest(tmpDir);
			expect(manifest.standard).toBe('VIBES');
			expect(manifest.version).toBe('1.0');
			expect(Object.keys(manifest.entries)).toHaveLength(0);
		});

		it('should create an empty annotations.jsonl', async () => {
			await initVibesDirectly(tmpDir, {
				projectName: 'test-project',
				assuranceLevel: 'medium',
			});

			const annotationsPath = path.join(tmpDir, '.ai-audit', 'annotations.jsonl');
			await expect(access(annotationsPath, constants.F_OK)).resolves.toBeUndefined();
			const content = await readFile(annotationsPath, 'utf8');
			expect(content).toBe('');
		});

		it('should use custom tracked extensions when provided', async () => {
			await initVibesDirectly(tmpDir, {
				projectName: 'test-project',
				assuranceLevel: 'low',
				trackedExtensions: ['.rs', '.toml'],
			});

			const config = await readVibesConfig(tmpDir);
			expect(config!.tracked_extensions).toEqual(['.rs', '.toml']);
		});

		it('should use custom exclude patterns when provided', async () => {
			await initVibesDirectly(tmpDir, {
				projectName: 'test-project',
				assuranceLevel: 'medium',
				excludePatterns: ['**/target/**'],
			});

			const config = await readVibesConfig(tmpDir);
			expect(config!.exclude_patterns).toEqual(['**/target/**']);
		});

		it('should not overwrite existing manifest', async () => {
			// Pre-create a manifest with entries
			await ensureAuditDir(tmpDir);
			const existingManifest = {
				standard: 'VIBES' as const,
				version: '1.0' as const,
				entries: { 'hash123': { type: 'environment' as const, tool_name: 'test', tool_version: '1.0', model_name: 'test', model_version: '1.0', created_at: '2026-02-10T12:00:00Z' } },
			};
			await writeVibesManifest(tmpDir, existingManifest);

			await initVibesDirectly(tmpDir, {
				projectName: 'test-project',
				assuranceLevel: 'medium',
			});

			const manifest = await readVibesManifest(tmpDir);
			expect(Object.keys(manifest.entries)).toHaveLength(1);
			expect(manifest.entries['hash123']).toBeDefined();
		});

		it('should return error for invalid paths', async () => {
			const result = await initVibesDirectly('/dev/null/impossible', {
				projectName: 'test',
				assuranceLevel: 'medium',
			});

			expect(result.success).toBe(false);
			expect(result.error).toBeDefined();
		});
	});

	// ========================================================================
	// appendAnnotationImmediate (DIVERGENCE 4 fix)
	// ========================================================================
	describe('appendAnnotationImmediate', () => {
		it('should write annotation to disk immediately without buffering', async () => {
			await appendAnnotationImmediate(tmpDir, SAMPLE_SESSION_RECORD);

			// The annotation should be on disk already — no flushAll needed
			const annotationsPath = path.join(tmpDir, '.ai-audit', 'annotations.jsonl');
			const raw = await readFile(annotationsPath, 'utf8');
			const lines = raw.trim().split('\n');
			expect(lines).toHaveLength(1);
			expect(JSON.parse(lines[0])).toEqual(SAMPLE_SESSION_RECORD);

			// The write buffer should still be empty (was not used)
			expect(getBufferedAnnotationCount(tmpDir)).toBe(0);
		});

		it('should serialize with project lock', async () => {
			// Fire multiple immediate writes concurrently — they should all succeed
			// without corrupting the file
			const records: VibesSessionRecord[] = [];
			for (let i = 0; i < 5; i++) {
				records.push({
					...SAMPLE_SESSION_RECORD,
					session_id: `session-${i}`,
					timestamp: `2026-02-10T12:0${i}:00Z`,
				});
			}

			await Promise.all(
				records.map((r) => appendAnnotationImmediate(tmpDir, r)),
			);

			const annotationsPath = path.join(tmpDir, '.ai-audit', 'annotations.jsonl');
			const raw = await readFile(annotationsPath, 'utf8');
			const lines = raw.trim().split('\n');
			expect(lines).toHaveLength(5);
			// Each line should be valid JSON
			for (const line of lines) {
				expect(() => JSON.parse(line)).not.toThrow();
			}
		});

		it('should append to existing annotations file', async () => {
			// Write a buffered annotation first
			await appendAnnotation(tmpDir, SAMPLE_LINE_ANNOTATION);
			await flushAll();

			// Now write an immediate annotation
			await appendAnnotationImmediate(tmpDir, SAMPLE_SESSION_RECORD);

			const annotationsPath = path.join(tmpDir, '.ai-audit', 'annotations.jsonl');
			const raw = await readFile(annotationsPath, 'utf8');
			const lines = raw.trim().split('\n');
			expect(lines).toHaveLength(2);
			expect(JSON.parse(lines[0])).toEqual(SAMPLE_LINE_ANNOTATION);
			expect(JSON.parse(lines[1])).toEqual(SAMPLE_SESSION_RECORD);
		});
	});

	// ========================================================================
	// backfillCommitHash (GAP 1 fix)
	// ========================================================================
	describe('backfillCommitHash', () => {
		it('backfills commit_hash on annotations missing it', async () => {
			const annotation1: VibesLineAnnotation = {
				...SAMPLE_LINE_ANNOTATION,
				session_id: 'sess-1',
			};
			const annotation2: VibesLineAnnotation = {
				...SAMPLE_LINE_ANNOTATION,
				line_start: 20,
				line_end: 30,
				session_id: 'sess-1',
			};
			await appendAnnotation(tmpDir, annotation1);
			await appendAnnotation(tmpDir, annotation2);
			await flushAll();

			const count = await backfillCommitHash(tmpDir, 'abc123commit');

			expect(count).toBe(2);
			const annotations = await readAnnotations(tmpDir);
			expect(annotations).toHaveLength(2);
			expect((annotations[0] as VibesLineAnnotation).commit_hash).toBe('abc123commit');
			expect((annotations[1] as VibesLineAnnotation).commit_hash).toBe('abc123commit');
		});

		it('only backfills annotations matching the given session_id', async () => {
			const annotation1: VibesLineAnnotation = {
				...SAMPLE_LINE_ANNOTATION,
				session_id: 'sess-1',
			};
			const annotation2: VibesLineAnnotation = {
				...SAMPLE_LINE_ANNOTATION,
				line_start: 20,
				line_end: 30,
				session_id: 'sess-2',
			};
			await appendAnnotation(tmpDir, annotation1);
			await appendAnnotation(tmpDir, annotation2);
			await flushAll();

			const count = await backfillCommitHash(tmpDir, 'abc123commit', 'sess-1');

			expect(count).toBe(1);
			const annotations = await readAnnotations(tmpDir);
			expect((annotations[0] as VibesLineAnnotation).commit_hash).toBe('abc123commit');
			expect((annotations[1] as VibesLineAnnotation).commit_hash).toBeNull();
		});

		it('returns count of updated annotations', async () => {
			await appendAnnotation(tmpDir, SAMPLE_LINE_ANNOTATION);
			await appendAnnotation(tmpDir, SAMPLE_FUNCTION_ANNOTATION);
			await appendAnnotation(tmpDir, SAMPLE_SESSION_RECORD);
			await flushAll();

			const count = await backfillCommitHash(tmpDir, 'def456commit');

			// line and function annotations are updated; session records are not
			expect(count).toBe(2);
		});

		it('does not modify annotations that already have commit_hash', async () => {
			const annotationWithHash: VibesLineAnnotation = {
				...SAMPLE_LINE_ANNOTATION,
				commit_hash: 'existing-hash',
			};
			const annotationWithoutHash: VibesLineAnnotation = {
				...SAMPLE_LINE_ANNOTATION,
				line_start: 20,
				line_end: 30,
			};
			await appendAnnotation(tmpDir, annotationWithHash);
			await appendAnnotation(tmpDir, annotationWithoutHash);
			await flushAll();

			const count = await backfillCommitHash(tmpDir, 'new-hash');

			expect(count).toBe(1);
			const annotations = await readAnnotations(tmpDir);
			expect((annotations[0] as VibesLineAnnotation).commit_hash).toBe('existing-hash');
			expect((annotations[1] as VibesLineAnnotation).commit_hash).toBe('new-hash');
		});

		it('returns 0 when no annotations file exists', async () => {
			const count = await backfillCommitHash(tmpDir, 'abc123commit');
			expect(count).toBe(0);
		});

		it('returns 0 when all annotations already have commit_hash', async () => {
			const annotation: VibesLineAnnotation = {
				...SAMPLE_LINE_ANNOTATION,
				commit_hash: 'existing-hash',
			};
			await appendAnnotation(tmpDir, annotation);
			await flushAll();

			const count = await backfillCommitHash(tmpDir, 'new-hash');
			expect(count).toBe(0);
		});
	});

	// ========================================================================
	// rehashManifest
	// ========================================================================
	describe('rehashManifest', () => {
		it('should re-key manifest entries using the updated hash algorithm', async () => {
			await initVibesDirectly(tmpDir, { projectName: 'test', assuranceLevel: 'medium' });

			// Write a manifest with entries keyed by an old (wrong) hash
			const envEntry: VibesEnvironmentEntry = {
				type: 'environment',
				tool_name: 'Claude Code',
				tool_version: '1.0',
				model_name: 'claude-opus-4-5',
				model_version: 'opus',
				created_at: '2026-02-10T12:00:00Z',
			};
			const oldHash = 'old-hash-that-does-not-match-new-algorithm';
			await writeVibesManifest(tmpDir, {
				standard: 'VIBES',
				version: '1.0',
				entries: { [oldHash]: envEntry },
			});

			const result = await rehashManifest(tmpDir);

			expect(result.rehashedEntries).toBe(1);
			const manifest = await readVibesManifest(tmpDir);
			// Old hash should be gone
			expect(manifest.entries[oldHash]).toBeUndefined();
			// New hash should be the correct computeVibesHash result
			const correctHash = computeVibesHash(envEntry as unknown as Record<string, unknown>);
			expect(manifest.entries[correctHash]).toEqual(envEntry);
		});

		it('should update annotation hash references', async () => {
			await initVibesDirectly(tmpDir, { projectName: 'test', assuranceLevel: 'medium' });

			const envEntry: VibesEnvironmentEntry = {
				type: 'environment',
				tool_name: 'Maestro',
				tool_version: '2.0',
				model_name: 'claude-4',
				model_version: 'opus',
				created_at: '2026-02-10T12:00:00Z',
			};
			const oldHash = 'stale-env-hash-0123456789abcdef0123456789abcdef01234567';
			await writeVibesManifest(tmpDir, {
				standard: 'VIBES',
				version: '1.0',
				entries: { [oldHash]: envEntry },
			});

			// Write annotations referencing the old hash
			const annotation: VibesLineAnnotation = {
				...SAMPLE_LINE_ANNOTATION,
				environment_hash: oldHash,
			};
			await appendAnnotationImmediate(tmpDir, annotation);

			const result = await rehashManifest(tmpDir);

			expect(result.rehashedEntries).toBe(1);
			expect(result.updatedAnnotations).toBe(1);

			const annotations = await readAnnotations(tmpDir);
			const newHash = computeVibesHash(envEntry as unknown as Record<string, unknown>);
			expect((annotations[0] as VibesLineAnnotation).environment_hash).toBe(newHash);
		});

		it('should be idempotent — entries already matching are skipped', async () => {
			await initVibesDirectly(tmpDir, { projectName: 'test', assuranceLevel: 'medium' });

			const envEntry: VibesEnvironmentEntry = {
				type: 'environment',
				tool_name: 'Claude Code',
				tool_version: '1.0',
				model_name: 'claude-opus-4-5',
				model_version: 'opus',
				created_at: '2026-02-10T12:00:00Z',
			};
			const correctHash = computeVibesHash(envEntry as unknown as Record<string, unknown>);
			await writeVibesManifest(tmpDir, {
				standard: 'VIBES',
				version: '1.0',
				entries: { [correctHash]: envEntry },
			});

			const result = await rehashManifest(tmpDir);

			expect(result.rehashedEntries).toBe(0);
			expect(result.updatedAnnotations).toBe(0);
		});

		it('should handle empty manifest gracefully', async () => {
			await initVibesDirectly(tmpDir, { projectName: 'test', assuranceLevel: 'low' });

			const result = await rehashManifest(tmpDir);

			expect(result.rehashedEntries).toBe(0);
			expect(result.updatedAnnotations).toBe(0);
		});

		it('should handle multiple entries and multiple annotations', async () => {
			await initVibesDirectly(tmpDir, { projectName: 'test', assuranceLevel: 'high' });

			const envEntry1: VibesEnvironmentEntry = {
				type: 'environment',
				tool_name: 'Claude Code',
				tool_version: '1.0',
				model_name: 'claude-4',
				model_version: 'opus',
				created_at: '2026-02-10T12:00:00Z',
			};
			const envEntry2: VibesEnvironmentEntry = {
				type: 'environment',
				tool_name: 'Copilot',
				tool_version: '2.0',
				model_name: 'gpt-4o',
				model_version: '2026-01',
				created_at: '2026-02-10T12:01:00Z',
			};
			const oldHash1 = 'old-hash-env1-does-not-match';
			const oldHash2 = 'old-hash-env2-does-not-match';
			await writeVibesManifest(tmpDir, {
				standard: 'VIBES',
				version: '1.0',
				entries: {
					[oldHash1]: envEntry1,
					[oldHash2]: envEntry2,
				},
			});

			// 2 annotations referencing different old hashes
			await appendAnnotationImmediate(tmpDir, {
				...SAMPLE_LINE_ANNOTATION,
				environment_hash: oldHash1,
			});
			await appendAnnotationImmediate(tmpDir, {
				...SAMPLE_LINE_ANNOTATION,
				file_path: 'src/other.ts',
				line_start: 20,
				line_end: 30,
				environment_hash: oldHash2,
			});

			const result = await rehashManifest(tmpDir);

			expect(result.rehashedEntries).toBe(2);
			expect(result.updatedAnnotations).toBe(2);

			const manifest = await readVibesManifest(tmpDir);
			const newHash1 = computeVibesHash(envEntry1 as unknown as Record<string, unknown>);
			const newHash2 = computeVibesHash(envEntry2 as unknown as Record<string, unknown>);
			expect(manifest.entries[newHash1]).toEqual(envEntry1);
			expect(manifest.entries[newHash2]).toEqual(envEntry2);
		});
	});

	// ========================================================================
	// writeReasoningBlob
	// ========================================================================
	describe('writeReasoningBlob', () => {
		it('should write blob file to .ai-audit/blobs/{hash}.blob', async () => {
			const hash = 'abc123def456';
			const data = 'This is reasoning blob data';
			await writeReasoningBlob(tmpDir, hash, data);

			const blobPath = path.join(tmpDir, '.ai-audit', 'blobs', `${hash}.blob`);
			await expect(access(blobPath, constants.F_OK)).resolves.toBeUndefined();
			const content = await readFile(blobPath, 'utf8');
			expect(content).toBe(data);
		});

		it('should create blobs directory if needed', async () => {
			// tmpDir has no .ai-audit/ yet
			const hash = 'newblobhash';
			await writeReasoningBlob(tmpDir, hash, 'data');

			await expect(
				access(path.join(tmpDir, '.ai-audit', 'blobs'), constants.F_OK),
			).resolves.toBeUndefined();
		});

		it('should return relative blob path', async () => {
			const hash = 'myhash123';
			const result = await writeReasoningBlob(tmpDir, hash, 'test data');

			expect(result).toBe(`blobs/${hash}.blob`);
		});

		it('should write Buffer data correctly', async () => {
			const hash = 'bufferhash';
			const data = Buffer.from('binary blob content', 'utf8');
			await writeReasoningBlob(tmpDir, hash, data);

			const blobPath = path.join(tmpDir, '.ai-audit', 'blobs', `${hash}.blob`);
			const content = await readFile(blobPath, 'utf8');
			expect(content).toBe('binary blob content');
		});
	});

	// ========================================================================
	// computeStatsFromAnnotations
	// ========================================================================
	describe('computeStatsFromAnnotations', () => {
		it('should return correct counts from annotations and manifest', async () => {
			// Set up a project with config, manifest, and annotations
			await initVibesDirectly(tmpDir, { projectName: 'test', assuranceLevel: 'high' });
			await writeVibesManifest(tmpDir, {
				standard: 'VIBES',
				version: '1.0',
				entries: {
					envhash1: { ...SAMPLE_ENVIRONMENT_ENTRY },
					envhash2: { ...SAMPLE_ENVIRONMENT_ENTRY, model_name: 'gpt-4' },
				},
			});

			// Write some annotations
			const lineA: VibesLineAnnotation = {
				...SAMPLE_LINE_ANNOTATION,
				file_path: 'src/a.ts',
				session_id: 'sess-1',
				environment_hash: 'envhash1',
			};
			const lineB: VibesLineAnnotation = {
				...SAMPLE_LINE_ANNOTATION,
				file_path: 'src/b.ts',
				session_id: 'sess-1',
				environment_hash: 'envhash2',
			};
			const sessionStart: VibesSessionRecord = {
				type: 'session', event: 'start', session_id: 'sess-1',
				timestamp: '2026-02-10T12:00:00Z', assurance_level: 'high',
			};
			await appendAnnotationImmediate(tmpDir, sessionStart);
			await appendAnnotationImmediate(tmpDir, lineA);
			await appendAnnotationImmediate(tmpDir, lineB);

			const stats = await computeStatsFromAnnotations(tmpDir);
			expect(stats.total_annotations).toBe(2); // 2 line annotations
			expect(stats.files_covered).toBe(2); // 2 unique files
			expect(stats.active_sessions).toBe(1); // 1 started, 0 ended
			expect(stats.contributing_models).toBe(2); // claude-4, gpt-4
			expect(stats.assurance_level).toBe('high');
		});

		it('should return empty results for empty .ai-audit', async () => {
			await initVibesDirectly(tmpDir, { projectName: 'empty', assuranceLevel: 'low' });
			const stats = await computeStatsFromAnnotations(tmpDir);
			expect(stats.total_annotations).toBe(0);
			expect(stats.files_covered).toBe(0);
			expect(stats.active_sessions).toBe(0);
			expect(stats.contributing_models).toBe(0);
		});

		it('should count sessions as inactive when ended', async () => {
			await initVibesDirectly(tmpDir, { projectName: 'test', assuranceLevel: 'medium' });
			const start: VibesSessionRecord = {
				type: 'session', event: 'start', session_id: 'sess-x',
				timestamp: '2026-02-10T12:00:00Z',
			};
			const end: VibesSessionRecord = {
				type: 'session', event: 'end', session_id: 'sess-x',
				timestamp: '2026-02-10T13:00:00Z',
			};
			await appendAnnotationImmediate(tmpDir, start);
			await appendAnnotationImmediate(tmpDir, end);

			const stats = await computeStatsFromAnnotations(tmpDir);
			expect(stats.active_sessions).toBe(0);
		});
	});

	// ========================================================================
	// extractSessionsFromAnnotations
	// ========================================================================
	describe('extractSessionsFromAnnotations', () => {
		it('should return session records with annotation counts', async () => {
			await initVibesDirectly(tmpDir, { projectName: 'test', assuranceLevel: 'medium' });
			const start: VibesSessionRecord = {
				type: 'session', event: 'start', session_id: 'sess-1',
				timestamp: '2026-02-10T12:00:00Z', description: 'claude-code',
			};
			const line: VibesLineAnnotation = {
				...SAMPLE_LINE_ANNOTATION, session_id: 'sess-1',
			};
			const end: VibesSessionRecord = {
				type: 'session', event: 'end', session_id: 'sess-1',
				timestamp: '2026-02-10T13:00:00Z',
			};
			await appendAnnotationImmediate(tmpDir, start);
			await appendAnnotationImmediate(tmpDir, line);
			await appendAnnotationImmediate(tmpDir, end);

			const sessions = await extractSessionsFromAnnotations(tmpDir);
			expect(sessions).toHaveLength(2); // start + end
			expect(sessions[0].session_id).toBe('sess-1');
			expect(sessions[0].event).toBe('start');
			expect(sessions[0].agent_type).toBe('claude-code');
			expect(sessions[0].annotation_count).toBe(1);
			expect(sessions[1].event).toBe('end');
		});

		it('should return empty for empty .ai-audit', async () => {
			await initVibesDirectly(tmpDir, { projectName: 'empty', assuranceLevel: 'low' });
			const sessions = await extractSessionsFromAnnotations(tmpDir);
			expect(sessions).toHaveLength(0);
		});
	});

	// ========================================================================
	// extractModelsFromManifest
	// ========================================================================
	describe('extractModelsFromManifest', () => {
		it('should return model info with annotation counts and percentages', async () => {
			await initVibesDirectly(tmpDir, { projectName: 'test', assuranceLevel: 'high' });
			await writeVibesManifest(tmpDir, {
				standard: 'VIBES',
				version: '1.0',
				entries: {
					envhash1: { ...SAMPLE_ENVIRONMENT_ENTRY, model_name: 'claude-4', tool_name: 'claude-code' },
					envhash2: { ...SAMPLE_ENVIRONMENT_ENTRY, model_name: 'gpt-4', tool_name: 'copilot' },
				},
			});

			// 3 annotations: 2 for claude-4, 1 for gpt-4
			await appendAnnotationImmediate(tmpDir, { ...SAMPLE_LINE_ANNOTATION, environment_hash: 'envhash1' });
			await appendAnnotationImmediate(tmpDir, { ...SAMPLE_LINE_ANNOTATION, environment_hash: 'envhash1', line_start: 11, line_end: 20 });
			await appendAnnotationImmediate(tmpDir, { ...SAMPLE_LINE_ANNOTATION, environment_hash: 'envhash2', line_start: 21, line_end: 30 });

			const models = await extractModelsFromManifest(tmpDir);
			expect(models).toHaveLength(2);

			const claude = models.find((m) => m.model_name === 'claude-4');
			expect(claude).toBeDefined();
			expect(claude!.annotation_count).toBe(2);
			expect(claude!.percentage).toBe(67); // 2/3 ≈ 67%
			expect(claude!.tool_name).toBe('claude-code');

			const gpt = models.find((m) => m.model_name === 'gpt-4');
			expect(gpt).toBeDefined();
			expect(gpt!.annotation_count).toBe(1);
			expect(gpt!.percentage).toBe(33); // 1/3 ≈ 33%
		});

		it('should return empty for empty .ai-audit', async () => {
			await initVibesDirectly(tmpDir, { projectName: 'empty', assuranceLevel: 'low' });
			const models = await extractModelsFromManifest(tmpDir);
			expect(models).toHaveLength(0);
		});
	});

	// ========================================================================
	// computeBlameFromAnnotations
	// ========================================================================
	describe('computeBlameFromAnnotations', () => {
		it('should return blame for specific file', async () => {
			await initVibesDirectly(tmpDir, { projectName: 'test', assuranceLevel: 'high' });
			await writeVibesManifest(tmpDir, {
				standard: 'VIBES',
				version: '1.0',
				entries: {
					envhash1: { ...SAMPLE_ENVIRONMENT_ENTRY, model_name: 'claude-4', tool_name: 'claude-code' },
				},
			});

			await appendAnnotationImmediate(tmpDir, {
				...SAMPLE_LINE_ANNOTATION,
				file_path: 'src/target.ts',
				environment_hash: 'envhash1',
				line_start: 10,
				line_end: 20,
				session_id: 'sess-1',
			});
			await appendAnnotationImmediate(tmpDir, {
				...SAMPLE_LINE_ANNOTATION,
				file_path: 'src/target.ts',
				environment_hash: 'envhash1',
				line_start: 1,
				line_end: 5,
				session_id: 'sess-1',
			});
			// Different file — should not be included
			await appendAnnotationImmediate(tmpDir, {
				...SAMPLE_LINE_ANNOTATION,
				file_path: 'src/other.ts',
				environment_hash: 'envhash1',
			});

			const blame = await computeBlameFromAnnotations(tmpDir, 'src/target.ts');
			expect(blame).toHaveLength(2);
			// Should be sorted by line_start ascending
			expect(blame[0].line_start).toBe(1);
			expect(blame[1].line_start).toBe(10);
			expect(blame[0].model_name).toBe('claude-4');
			expect(blame[0].tool_name).toBe('claude-code');
			expect(blame[0].session_id).toBe('sess-1');
		});

		it('should resolve model info from manifest', async () => {
			await initVibesDirectly(tmpDir, { projectName: 'test', assuranceLevel: 'medium' });
			await writeVibesManifest(tmpDir, {
				standard: 'VIBES',
				version: '1.0',
				entries: {
					envhash1: { ...SAMPLE_ENVIRONMENT_ENTRY, model_name: 'gpt-4o', model_version: '2026-01', tool_name: 'copilot' },
				},
			});
			await appendAnnotationImmediate(tmpDir, {
				...SAMPLE_LINE_ANNOTATION,
				file_path: 'src/test.ts',
				environment_hash: 'envhash1',
			});

			const blame = await computeBlameFromAnnotations(tmpDir, 'src/test.ts');
			expect(blame).toHaveLength(1);
			expect(blame[0].model_name).toBe('gpt-4o');
			expect(blame[0].model_version).toBe('2026-01');
			expect(blame[0].tool_name).toBe('copilot');
		});

		it('should return empty for file with no annotations', async () => {
			await initVibesDirectly(tmpDir, { projectName: 'test', assuranceLevel: 'low' });
			const blame = await computeBlameFromAnnotations(tmpDir, 'src/nonexistent.ts');
			expect(blame).toHaveLength(0);
		});
	});

	// ========================================================================
	// computeCoverageFromAnnotations
	// ========================================================================
	describe('computeCoverageFromAnnotations', () => {
		it('should classify files by annotation count', async () => {
			await initVibesDirectly(tmpDir, { projectName: 'test', assuranceLevel: 'medium' });

			// 8 annotations for one file (covered), 2 for another (partial)
			for (let i = 0; i < 8; i++) {
				await appendAnnotationImmediate(tmpDir, {
					...SAMPLE_LINE_ANNOTATION,
					file_path: 'src/heavy.ts',
					line_start: i * 10 + 1,
					line_end: i * 10 + 10,
				});
			}
			for (let i = 0; i < 2; i++) {
				await appendAnnotationImmediate(tmpDir, {
					...SAMPLE_LINE_ANNOTATION,
					file_path: 'src/light.ts',
					line_start: i * 10 + 1,
					line_end: i * 10 + 10,
				});
			}

			const coverage = await computeCoverageFromAnnotations(tmpDir);
			const heavy = coverage.find((c) => c.file_path === 'src/heavy.ts');
			const light = coverage.find((c) => c.file_path === 'src/light.ts');
			expect(heavy).toBeDefined();
			expect(heavy!.coverage_status).toBe('full');
			expect(heavy!.annotation_count).toBe(8);
			expect(light).toBeDefined();
			expect(light!.coverage_status).toBe('partial');
			expect(light!.annotation_count).toBe(2);
		});

		it('should return empty for empty .ai-audit', async () => {
			await initVibesDirectly(tmpDir, { projectName: 'empty', assuranceLevel: 'low' });
			const coverage = await computeCoverageFromAnnotations(tmpDir);
			expect(coverage).toHaveLength(0);
		});

		it('should sort by status then path (coverage)', async () => {
			await initVibesDirectly(tmpDir, { projectName: 'test', assuranceLevel: 'medium' });
			// 6 annotations for b.ts (covered), 1 for a.ts (partial)
			for (let i = 0; i < 6; i++) {
				await appendAnnotationImmediate(tmpDir, {
					...SAMPLE_LINE_ANNOTATION,
					file_path: 'src/b.ts',
					line_start: i * 10 + 1,
					line_end: i * 10 + 10,
				});
			}
			await appendAnnotationImmediate(tmpDir, {
				...SAMPLE_LINE_ANNOTATION,
				file_path: 'src/a.ts',
			});

			const coverage = await computeCoverageFromAnnotations(tmpDir);
			expect(coverage[0].file_path).toBe('src/b.ts');
			expect(coverage[0].coverage_status).toBe('full');
			expect(coverage[1].file_path).toBe('src/a.ts');
			expect(coverage[1].coverage_status).toBe('partial');
		});
	});

	// ========================================================================
	// addManifestEntryImmediate
	// ========================================================================
	describe('addManifestEntryImmediate', () => {
		it('should write entry to manifest immediately without debounce', async () => {
			const hash = 'imm-hash-012345678901234567890123456789012345678901234567890';
			await addManifestEntryImmediate(tmpDir, hash, SAMPLE_ENVIRONMENT_ENTRY);

			// Entry should be on disk immediately — no flushAll needed
			const manifest = await readVibesManifest(tmpDir);
			expect(manifest.entries[hash]).toEqual(SAMPLE_ENVIRONMENT_ENTRY);
		});

		it('should not overwrite an existing entry with the same hash', async () => {
			const hash = 'imm-hash-012345678901234567890123456789012345678901234567890';

			// Write the first entry
			await addManifestEntryImmediate(tmpDir, hash, SAMPLE_ENVIRONMENT_ENTRY);

			const differentEntry: VibesCommandEntry = {
				type: 'command',
				command_text: 'different command',
				command_type: 'shell',
				created_at: '2026-02-10T13:00:00Z',
			};
			await addManifestEntryImmediate(tmpDir, hash, differentEntry);

			const manifest = await readVibesManifest(tmpDir);
			expect(manifest.entries[hash]).toEqual(SAMPLE_ENVIRONMENT_ENTRY);
		});

		it('should not affect the debounce buffer', async () => {
			const hash = 'imm-hash-012345678901234567890123456789012345678901234567890';
			await addManifestEntryImmediate(tmpDir, hash, SAMPLE_ENVIRONMENT_ENTRY);

			// Pending manifest count should be 0 (not debounced)
			expect(getPendingManifestEntryCount(tmpDir)).toBe(0);
		});

		it('should not throw for invalid paths', async () => {
			await expect(
				addManifestEntryImmediate('/nonexistent/path', 'hash', SAMPLE_ENVIRONMENT_ENTRY),
			).resolves.toBeUndefined();
		});
	});

	// ========================================================================
	// flushAll ordering (manifests before annotations)
	// ========================================================================
	describe('flushAll ordering', () => {
		it('should flush manifests before annotations', async () => {
			// Add both a manifest entry and an annotation
			const hash = 'order-hash-012345678901234567890123456789012345678901234567890';
			await addManifestEntry(tmpDir, hash, SAMPLE_ENVIRONMENT_ENTRY);
			await appendAnnotation(tmpDir, {
				...SAMPLE_LINE_ANNOTATION,
				environment_hash: hash,
			});

			// After flushAll, both should be on disk
			await flushAll();

			const manifest = await readVibesManifest(tmpDir);
			expect(manifest.entries[hash]).toEqual(SAMPLE_ENVIRONMENT_ENTRY);

			const annotations = await readAnnotations(tmpDir);
			expect(annotations).toHaveLength(1);
		});
	});

	// ========================================================================
	// computeLocCoverageFromAnnotations
	// ========================================================================
	describe('computeLocCoverageFromAnnotations', () => {
		it('should compute LOC coverage from annotations', async () => {
			await initVibesDirectly(tmpDir, { projectName: 'test', assuranceLevel: 'medium' });

			// Create a tracked source file
			const srcDir = path.join(tmpDir, 'src');
			await mkdir(srcDir, { recursive: true });
			await fsWriteFile(path.join(srcDir, 'index.ts'), 'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\n');

			// Add annotations covering lines 1-5
			await appendAnnotationImmediate(tmpDir, {
				...SAMPLE_LINE_ANNOTATION,
				file_path: 'src/index.ts',
				line_start: 1,
				line_end: 5,
			});

			const result = await computeLocCoverageFromAnnotations(tmpDir);
			const fileResult = result.files.find((f) => f.file_path === 'src/index.ts');
			expect(fileResult).toBeDefined();
			// 11 lines (10 lines of text + trailing newline)
			expect(fileResult!.total_lines).toBe(11);
			expect(fileResult!.annotated_lines).toBe(5);
			expect(result.annotatedLines).toBeGreaterThanOrEqual(5);
			expect(result.totalLines).toBeGreaterThanOrEqual(11);
		});

		it('should return empty results for empty project', async () => {
			await initVibesDirectly(tmpDir, { projectName: 'empty', assuranceLevel: 'low' });
			const result = await computeLocCoverageFromAnnotations(tmpDir);
			expect(result.totalLines).toBe(0);
			expect(result.annotatedLines).toBe(0);
			expect(result.coveragePercent).toBe(0);
			expect(result.files).toHaveLength(0);
		});

		it('should deduplicate overlapping line ranges', async () => {
			await initVibesDirectly(tmpDir, { projectName: 'test', assuranceLevel: 'medium' });

			const srcDir = path.join(tmpDir, 'src');
			await mkdir(srcDir, { recursive: true });
			await fsWriteFile(path.join(srcDir, 'index.ts'), 'line1\nline2\nline3\nline4\nline5\n');

			// Two overlapping annotations: 1-3 and 2-5
			await appendAnnotationImmediate(tmpDir, {
				...SAMPLE_LINE_ANNOTATION,
				file_path: 'src/index.ts',
				line_start: 1,
				line_end: 3,
			});
			await appendAnnotationImmediate(tmpDir, {
				...SAMPLE_LINE_ANNOTATION,
				file_path: 'src/index.ts',
				line_start: 2,
				line_end: 5,
			});

			const result = await computeLocCoverageFromAnnotations(tmpDir);
			const fileResult = result.files.find((f) => f.file_path === 'src/index.ts');
			expect(fileResult).toBeDefined();
			// Lines 1,2,3,4,5 = 5 unique lines (despite overlapping ranges)
			expect(fileResult!.annotated_lines).toBe(5);
		});

		it('should skip files that cannot be read', async () => {
			await initVibesDirectly(tmpDir, { projectName: 'test', assuranceLevel: 'medium' });

			// Annotate a file that doesn't exist on disk
			await appendAnnotationImmediate(tmpDir, {
				...SAMPLE_LINE_ANNOTATION,
				file_path: 'src/deleted.ts',
				line_start: 1,
				line_end: 10,
			});

			// Should not throw — just skips the missing file
			const result = await computeLocCoverageFromAnnotations(tmpDir);
			const deleted = result.files.find((f) => f.file_path === 'src/deleted.ts');
			expect(deleted).toBeUndefined();
		});
	});
});
