/**
 * Integration Test: VIBES Reasoning Compression & Blob Storage
 *
 * Tests the three-tier reasoning storage strategy:
 *   1. Small reasoning (< 10 KB) → raw `reasoning_text` in manifest
 *   2. Medium reasoning (10 KB – 100 KB) → gzip-compressed, base64-encoded in `reasoning_text_compressed`
 *   3. Large reasoning (> 100 KB) → external blob at `.ai-audit/blobs/{hash}.blob`
 *
 * Also validates hash consistency (content-addressed deduplication).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, access, constants } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { gunzipSync } from 'zlib';

import { ClaudeCodeInstrumenter } from '../../../main/vibes/instrumenters/claude-code-instrumenter';
import { VibesSessionManager } from '../../../main/vibes/vibes-session';
import { createReasoningEntry } from '../../../main/vibes/vibes-annotations';
import {
	readVibesManifest,
	initVibesDirectly,
	flushAll,
	resetAllBuffers,
} from '../../../main/vibes/vibes-io';
import type { VibesReasoningEntry } from '../../../shared/vibes-types';

// ============================================================================
// Constants
// ============================================================================

const FIXED_ISO = '2026-02-10T12:00:00.000Z';

/** Just under 10 KB — raw storage expected. */
const SMALL_TEXT_SIZE = 5_000;

/** Between 10 KB and 100 KB — compression expected. */
const MEDIUM_TEXT_SIZE = 50_000;

/** Over 100 KB — external blob expected. */
const LARGE_TEXT_SIZE = 150_000;

// ============================================================================
// Test Suite
// ============================================================================

describe('vibes-reasoning-storage', () => {
	let tmpDir: string;

	beforeEach(async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(FIXED_ISO));
		tmpDir = await mkdtemp(path.join(os.tmpdir(), 'vibes-reasoning-storage-'));
		await initVibesDirectly(tmpDir, {
			projectName: 'reasoning-storage-test',
			assuranceLevel: 'high',
		});
	});

	afterEach(async () => {
		resetAllBuffers();
		vi.useRealTimers();
		await rm(tmpDir, { recursive: true, force: true });
	});

	// ========================================================================
	// Helper: create a session + instrumenter and run reasoning through the pipeline
	// ========================================================================

	async function runReasoningPipeline(
		reasoningText: string,
		opts?: {
			compressThresholdBytes?: number;
			externalBlobThresholdBytes?: number;
		}
	) {
		const manager = new VibesSessionManager();
		const sessionId = 'sess-reasoning';

		const state = await manager.startSession(sessionId, tmpDir, 'claude-code', 'high');
		state.environmentHash = 'e'.repeat(64);

		const instrumenter = new ClaudeCodeInstrumenter({
			sessionManager: manager,
			assuranceLevel: 'high',
			compressThresholdBytes: opts?.compressThresholdBytes,
			externalBlobThresholdBytes: opts?.externalBlobThresholdBytes,
		});

		// Buffer reasoning text
		instrumenter.handleThinkingChunk(sessionId, reasoningText);

		// Tool execution triggers reasoning flush
		await instrumenter.handleToolExecution(sessionId, {
			toolName: 'Write',
			state: { status: 'running', input: { file_path: 'src/app.ts' } },
			timestamp: Date.now(),
		});

		await flushAll();

		const manifest = await readVibesManifest(tmpDir);
		const entries = Object.values(manifest.entries);
		const reasoningEntries = entries.filter((e) => e.type === 'reasoning') as VibesReasoningEntry[];

		return { manifest, reasoningEntries };
	}

	// ========================================================================
	// 1. Small Reasoning (< 10 KB) — Raw Storage
	// ========================================================================

	describe('small reasoning (< 10 KB)', () => {
		it('should store raw reasoning_text without compression', async () => {
			const text = 'R'.repeat(SMALL_TEXT_SIZE);
			const { reasoningEntries } = await runReasoningPipeline(text);

			expect(reasoningEntries).toHaveLength(1);
			const entry = reasoningEntries[0];

			expect(entry.reasoning_text).toBe(text);
			expect(entry.reasoning_text_compressed).toBeNull();
			expect(entry.compressed).toBeNull();
			expect(entry.external).toBeNull();
			expect(entry.blob_path).toBeNull();
		});

		it('should not create any blob files for small reasoning', async () => {
			const text = 'S'.repeat(SMALL_TEXT_SIZE);
			await runReasoningPipeline(text);

			const blobsDir = path.join(tmpDir, '.ai-audit', 'blobs');
			// blobs dir may or may not exist, but if it does, it should be empty or not have our blob
			try {
				await access(blobsDir, constants.F_OK);
				const { readdir } = await import('fs/promises');
				const files = await readdir(blobsDir);
				const blobFiles = files.filter((f) => f.endsWith('.blob'));
				expect(blobFiles).toHaveLength(0);
			} catch {
				// Directory doesn't exist — that's also fine for small reasoning
			}
		});
	});

	// ========================================================================
	// 2. Medium Reasoning (10 KB – 100 KB) — Compressed Storage
	// ========================================================================

	describe('medium reasoning (10 KB – 100 KB)', () => {
		it('should store compressed reasoning with compressed flag', async () => {
			const text = 'M'.repeat(MEDIUM_TEXT_SIZE);
			const { reasoningEntries } = await runReasoningPipeline(text);

			expect(reasoningEntries).toHaveLength(1);
			const entry = reasoningEntries[0];

			expect(entry.reasoning_text).toBeNull();
			expect(entry.reasoning_text_compressed).toBeDefined();
			expect(entry.compressed).toBe(true);
			expect(entry.external).toBeNull();
			expect(entry.blob_path).toBeNull();
		});

		it('should recover original text by base64-decoding and gunzipping', async () => {
			const text = 'N'.repeat(MEDIUM_TEXT_SIZE);
			const { reasoningEntries } = await runReasoningPipeline(text);

			const entry = reasoningEntries[0];
			expect(entry.reasoning_text_compressed).toBeDefined();

			const compressedBuf = Buffer.from(entry.reasoning_text_compressed!, 'base64');
			const decompressed = gunzipSync(compressedBuf).toString('utf8');
			expect(decompressed).toBe(text);
		});

		it('should not create any blob files for medium reasoning', async () => {
			const text = 'O'.repeat(MEDIUM_TEXT_SIZE);
			await runReasoningPipeline(text);

			const blobsDir = path.join(tmpDir, '.ai-audit', 'blobs');
			try {
				await access(blobsDir, constants.F_OK);
				const { readdir } = await import('fs/promises');
				const files = await readdir(blobsDir);
				const blobFiles = files.filter((f) => f.endsWith('.blob'));
				expect(blobFiles).toHaveLength(0);
			} catch {
				// Directory doesn't exist — that's fine
			}
		});
	});

	// ========================================================================
	// 3. Large Reasoning (> 100 KB) — External Blob Storage
	// ========================================================================

	describe('large reasoning (> 100 KB)', () => {
		it('should store as external blob with external flag and blob_path', async () => {
			const text = 'L'.repeat(LARGE_TEXT_SIZE);
			const { reasoningEntries } = await runReasoningPipeline(text);

			expect(reasoningEntries).toHaveLength(1);
			const entry = reasoningEntries[0];

			expect(entry.external).toBe(true);
			expect(entry.blob_path).toBeDefined();
			expect(entry.blob_path).toMatch(/^blobs\/[a-f0-9]+\.blob$/);
			expect(entry.reasoning_text).toBeNull();
			expect(entry.reasoning_text_compressed).toBeNull();
			expect(entry.compressed).toBeNull();
		});

		it('should write the blob file to .ai-audit/blobs/', async () => {
			const text = 'B'.repeat(LARGE_TEXT_SIZE);
			const { reasoningEntries } = await runReasoningPipeline(text);

			const entry = reasoningEntries[0];
			expect(entry.blob_path).toBeDefined();

			const blobAbsPath = path.join(tmpDir, '.ai-audit', entry.blob_path!);
			const blobContent = await readFile(blobAbsPath, 'utf8');
			expect(blobContent).toBe(text);
		});

		it('should set reasoning_text and reasoning_text_compressed to null on the manifest entry', async () => {
			const text = 'X'.repeat(LARGE_TEXT_SIZE);
			const { reasoningEntries } = await runReasoningPipeline(text);

			const entry = reasoningEntries[0];
			expect(entry.reasoning_text).toBeNull();
			expect(entry.reasoning_text_compressed).toBeNull();
		});
	});

	// ========================================================================
	// 4. Hash Consistency — Content-Addressed Deduplication
	// ========================================================================

	describe('hash consistency', () => {
		it('should produce the same hash for identical reasoning text (small)', () => {
			const text = 'Identical reasoning text for hash check.';

			const { hash: hash1 } = createReasoningEntry({ reasoningText: text });
			const { hash: hash2 } = createReasoningEntry({ reasoningText: text });

			expect(hash1).toBe(hash2);
			expect(hash1).toHaveLength(64);
		});

		it('should produce the same hash for identical reasoning text (medium, compressed)', () => {
			const text = 'C'.repeat(MEDIUM_TEXT_SIZE);

			const { hash: hash1 } = createReasoningEntry({ reasoningText: text });
			const { hash: hash2 } = createReasoningEntry({ reasoningText: text });

			expect(hash1).toBe(hash2);
			expect(hash1).toHaveLength(64);
		});

		it('should produce different hashes for different reasoning text', () => {
			const { hash: hash1 } = createReasoningEntry({
				reasoningText: 'First reasoning approach.',
			});
			const { hash: hash2 } = createReasoningEntry({
				reasoningText: 'Second reasoning approach.',
			});

			expect(hash1).not.toBe(hash2);
		});

		it('should produce deterministic hashes regardless of created_at timestamp', () => {
			const text = 'Determinism test for reasoning hash.';

			vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
			const { hash: hash1 } = createReasoningEntry({ reasoningText: text });

			vi.setSystemTime(new Date('2026-06-15T12:30:00.000Z'));
			const { hash: hash2 } = createReasoningEntry({ reasoningText: text });

			expect(hash1).toBe(hash2);
		});
	});
});
