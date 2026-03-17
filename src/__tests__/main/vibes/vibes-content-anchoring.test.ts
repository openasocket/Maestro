/**
 * Tests for VIBES content anchoring (spec section 7.3), PRISM risk fields,
 * and .gitignore creation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { createHash } from 'crypto';

import {
	createLineAnnotationWithAnchors,
	createLineAnnotation,
} from '../../../main/vibes/vibes-annotations';
import { ensureAuditDir, resetAllBuffers } from '../../../main/vibes/vibes-io';
import { computeRiskScore } from '../../../main/vibes/vibes-risk';
import type { VibesLineAnnotation, VibeFunctionAnnotation } from '../../../shared/vibes-types';

describe('vibes-content-anchoring', () => {
	const FIXED_ISO = '2026-02-10T12:00:00.000Z';
	let tmpDir: string;

	beforeEach(async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(FIXED_ISO));
		tmpDir = await mkdtemp(path.join(os.tmpdir(), 'vibes-anchoring-test-'));
	});

	afterEach(async () => {
		resetAllBuffers();
		vi.useRealTimers();
		await rm(tmpDir, { recursive: true, force: true });
	});

	// ========================================================================
	// createLineAnnotationWithAnchors
	// ========================================================================

	describe('createLineAnnotationWithAnchors', () => {
		it('should set file_content_hash to SHA-256 of entire file', async () => {
			const fileContent = 'line1\nline2\nline3\nline4\nline5\n';
			const filePath = path.join(tmpDir, 'test.ts');
			await writeFile(filePath, fileContent, 'utf8');

			const expectedHash = createHash('sha256').update(fileContent, 'utf8').digest('hex');

			const annotation = await createLineAnnotationWithAnchors({
				filePath: 'test.ts',
				lineStart: 1,
				lineEnd: 3,
				environmentHash: 'e'.repeat(64),
				action: 'modify',
				assuranceLevel: 'medium',
				projectPath: tmpDir,
			});

			expect(annotation.file_content_hash).toBe(expectedHash);
		});

		it('should set anchor_context to first 3 lines of annotated range, truncated to 256 bytes', async () => {
			const lines = ['first line', 'second line', 'third line', 'fourth line', 'fifth line'];
			const fileContent = lines.join('\n') + '\n';
			const filePath = path.join(tmpDir, 'test.ts');
			await writeFile(filePath, fileContent, 'utf8');

			const annotation = await createLineAnnotationWithAnchors({
				filePath: 'test.ts',
				lineStart: 2,
				lineEnd: 5,
				environmentHash: 'e'.repeat(64),
				action: 'modify',
				assuranceLevel: 'medium',
				projectPath: tmpDir,
			});

			// lineStart=2 means lines[1], lines[2], lines[3] (3 lines starting from line 2)
			const expected = ['second line', 'third line', 'fourth line'].join('\n');
			expect(annotation.anchor_context).toBe(expected);
		});

		it('should truncate anchor_context to 256 bytes', async () => {
			// Create lines that are long enough to exceed 256 bytes when joined
			const longLine = 'x'.repeat(100);
			const lines = [longLine, longLine, longLine, 'short'];
			const fileContent = lines.join('\n') + '\n';
			const filePath = path.join(tmpDir, 'test.ts');
			await writeFile(filePath, fileContent, 'utf8');

			const annotation = await createLineAnnotationWithAnchors({
				filePath: 'test.ts',
				lineStart: 1,
				lineEnd: 4,
				environmentHash: 'e'.repeat(64),
				action: 'modify',
				assuranceLevel: 'medium',
				projectPath: tmpDir,
			});

			expect(annotation.anchor_context).toBeDefined();
			expect(annotation.anchor_context!.length).toBeLessThanOrEqual(256);
		});

		it('should set anchor_hash to SHA-256 of the exact line range content', async () => {
			const lines = ['line1', 'line2', 'line3', 'line4', 'line5'];
			const fileContent = lines.join('\n') + '\n';
			const filePath = path.join(tmpDir, 'test.ts');
			await writeFile(filePath, fileContent, 'utf8');

			const rangeContent = ['line2', 'line3', 'line4'].join('\n');
			const expectedHash = createHash('sha256').update(rangeContent, 'utf8').digest('hex');

			const annotation = await createLineAnnotationWithAnchors({
				filePath: 'test.ts',
				lineStart: 2,
				lineEnd: 4,
				environmentHash: 'e'.repeat(64),
				action: 'modify',
				assuranceLevel: 'medium',
				projectPath: tmpDir,
			});

			expect(annotation.anchor_hash).toBe(expectedHash);
		});

		it('should degrade gracefully when file is unreadable', async () => {
			const annotation = await createLineAnnotationWithAnchors({
				filePath: 'nonexistent-file.ts',
				lineStart: 1,
				lineEnd: 5,
				environmentHash: 'e'.repeat(64),
				action: 'modify',
				assuranceLevel: 'medium',
				projectPath: tmpDir,
			});

			// Should still return a valid annotation, just without anchoring fields
			expect(annotation.type).toBe('line');
			expect(annotation.annotation_id).toBeTruthy();
			expect(annotation.anchor_context).toBeUndefined();
			expect(annotation.anchor_hash).toBeUndefined();
			expect(annotation.file_content_hash).toBeUndefined();
		});

		it('should update file content hash cache on successful read', async () => {
			const fileContent = 'hello world\n';
			const filePath = path.join(tmpDir, 'cached.ts');
			await writeFile(filePath, fileContent, 'utf8');

			const cache = new Map<string, { hash: string; mtime: number }>();

			await createLineAnnotationWithAnchors({
				filePath: 'cached.ts',
				lineStart: 1,
				lineEnd: 1,
				environmentHash: 'e'.repeat(64),
				action: 'modify',
				assuranceLevel: 'medium',
				projectPath: tmpDir,
				fileContentHashCache: cache,
			});

			const fullPath = path.join(tmpDir, 'cached.ts');
			expect(cache.has(fullPath)).toBe(true);
			const cached = cache.get(fullPath)!;
			const expectedHash = createHash('sha256').update(fileContent, 'utf8').digest('hex');
			expect(cached.hash).toBe(expectedHash);
			expect(cached.mtime).toBeGreaterThan(0);
		});

		it('should still return a valid annotation without anchors when file is missing', async () => {
			const annotation = await createLineAnnotationWithAnchors({
				filePath: 'missing.ts',
				lineStart: 1,
				lineEnd: 1,
				environmentHash: 'e'.repeat(64),
				action: 'create',
				assuranceLevel: 'low',
				projectPath: tmpDir,
			});

			expect(annotation.type).toBe('line');
			expect(annotation.file_path).toBe('missing.ts');
			expect(annotation.line_start).toBe(1);
			expect(annotation.line_end).toBe(1);
		});
	});

	// ========================================================================
	// .gitignore creation
	// ========================================================================

	describe('.gitignore creation', () => {
		it('should create .gitignore with audit.db entry during ensureAuditDir', async () => {
			await ensureAuditDir(tmpDir);

			const gitignorePath = path.join(tmpDir, '.ai-audit', '.gitignore');
			const content = await readFile(gitignorePath, 'utf8');

			expect(content).toContain('audit.db');
			expect(content).toContain('audit.db-shm');
			expect(content).toContain('audit.db-wal');
		});

		it('should not overwrite existing .gitignore', async () => {
			const auditDir = path.join(tmpDir, '.ai-audit');
			await mkdir(auditDir, { recursive: true });
			const gitignorePath = path.join(auditDir, '.gitignore');
			await writeFile(gitignorePath, 'custom content\n', 'utf8');

			await ensureAuditDir(tmpDir);

			const content = await readFile(gitignorePath, 'utf8');
			expect(content).toBe('custom content\n');
		});
	});

	// ========================================================================
	// PRISM risk score fields
	// ========================================================================

	describe('PRISM risk score fields', () => {
		it('should have risk_score and risk_factors as optional fields on VibesLineAnnotation', () => {
			const annotation: VibesLineAnnotation = {
				type: 'line',
				annotation_id: 'test',
				file_path: 'test.ts',
				line_start: 1,
				line_end: 10,
				environment_hash: 'e'.repeat(64),
				command_hash: null,
				prompt_hash: null,
				reasoning_hash: null,
				action: 'modify',
				timestamp: FIXED_ISO,
				commit_hash: null,
				session_id: null,
				assurance_level: 'medium',
			};

			// Fields should be undefined when not set (optional)
			expect(annotation.risk_score).toBeUndefined();
			expect(annotation.risk_factors).toBeUndefined();
		});

		it('should accept risk_score and risk_factors values when set', () => {
			const annotation: VibesLineAnnotation = {
				type: 'line',
				annotation_id: 'test',
				file_path: 'test.ts',
				line_start: 1,
				line_end: 10,
				environment_hash: 'e'.repeat(64),
				command_hash: null,
				prompt_hash: null,
				reasoning_hash: null,
				action: 'modify',
				timestamp: FIXED_ISO,
				commit_hash: null,
				session_id: null,
				assurance_level: 'medium',
				risk_score: 0.75,
				risk_factors: [
					{ signal: 'action_type', value: 0.8, weight: 0.5, reason: 'High-impact modification' },
				],
			};

			expect(annotation.risk_score).toBe(0.75);
			expect(annotation.risk_factors).toHaveLength(1);
			expect(annotation.risk_factors![0].signal).toBe('action_type');
		});

		it('computeRiskScore stub should return null', () => {
			const annotation: VibesLineAnnotation = {
				type: 'line',
				annotation_id: 'test',
				file_path: 'test.ts',
				line_start: 1,
				line_end: 10,
				environment_hash: 'e'.repeat(64),
				command_hash: null,
				prompt_hash: null,
				reasoning_hash: null,
				action: 'modify',
				timestamp: FIXED_ISO,
				commit_hash: null,
				session_id: null,
				assurance_level: 'medium',
			};

			expect(computeRiskScore(annotation)).toBeNull();
		});

		it('should have risk_score and risk_factors as optional fields on VibeFunctionAnnotation', () => {
			const annotation: VibeFunctionAnnotation = {
				type: 'function',
				annotation_id: 'test',
				file_path: 'test.ts',
				function_name: 'doStuff',
				environment_hash: 'e'.repeat(64),
				action: 'modify',
				timestamp: FIXED_ISO,
				assurance_level: 'medium',
			};

			expect(annotation.risk_score).toBeUndefined();
			expect(annotation.risk_factors).toBeUndefined();
		});
	});
});
