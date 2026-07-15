/**
 * Tests for the Windows-resilient atomic write path in src/main/vibes/vibes-io.ts.
 *
 * On Windows, rename() over a target that another process holds open (the
 * external vibecheck binary, Explorer, antivirus, the Search Indexer) fails
 * transiently with EPERM/EACCES/EBUSY under mandatory file locking. The
 * atomic write must retry those with backoff, rethrow anything else
 * immediately, and use unique temp suffixes so concurrent writers never
 * collide on the same `${filePath}.tmp`.
 *
 * Real fs is used against a temp directory; only `rename` is interposed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import * as os from 'os';

const { mockRename } = vi.hoisted(() => ({ mockRename: vi.fn() }));

vi.mock('fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof import('fs/promises')>();
	return {
		...actual,
		rename: mockRename,
		default: { ...actual, rename: mockRename },
	};
});

import { mkdtemp, rm, readFile, writeFile as fsWriteFile, mkdir } from 'fs/promises';
import { writeVibesConfig, rehashManifest, resetAllBuffers } from '../../../main/vibes/vibes-io';
import { computeVibesHashV2 } from '../../../main/vibes/vibes-hash';
import type { VibesConfig } from '../../../shared/vibes-types';

const SAMPLE_CONFIG: VibesConfig = {
	standard: 'VIBES',
	standard_version: '1.0',
	assurance_level: 'medium',
	project_name: 'atomic-retry-test',
	tracked_extensions: ['.ts'],
	exclude_patterns: ['**/node_modules/**'],
	compress_reasoning_threshold_bytes: 10240,
	external_blob_threshold_bytes: 102400,
};

function fsError(code: string): Error {
	return Object.assign(new Error(`${code}: simulated failure`), { code });
}

describe('vibes-io atomic write retry (Windows file locking)', () => {
	let tmpDir: string;
	let actualRename: typeof import('fs/promises').rename;

	beforeEach(async () => {
		const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
		actualRename = actual.rename;
		mockRename.mockReset();
		mockRename.mockImplementation((...args: Parameters<typeof actualRename>) =>
			actualRename(...args)
		);
		resetAllBuffers();
		tmpDir = await mkdtemp(path.join(os.tmpdir(), 'vibes-atomic-'));
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	it('retries rename on EPERM and ultimately succeeds', async () => {
		let attempts = 0;
		mockRename.mockImplementation(async (src: any, dest: any) => {
			attempts++;
			if (attempts <= 2) {
				throw fsError('EPERM');
			}
			return actualRename(src, dest);
		});

		await writeVibesConfig(tmpDir, SAMPLE_CONFIG);

		expect(attempts).toBe(3);
		const written = JSON.parse(
			await readFile(path.join(tmpDir, '.ai-audit', 'config.json'), 'utf8')
		);
		expect(written).toEqual(SAMPLE_CONFIG);
	});

	it('retries rename on EBUSY and EACCES', async () => {
		let attempts = 0;
		const codes = ['EBUSY', 'EACCES'];
		mockRename.mockImplementation(async (src: any, dest: any) => {
			attempts++;
			if (attempts <= 2) {
				throw fsError(codes[attempts - 1]);
			}
			return actualRename(src, dest);
		});

		await writeVibesConfig(tmpDir, SAMPLE_CONFIG);
		expect(attempts).toBe(3);
	});

	it('rethrows a non-retryable error (ENOSPC) immediately without retrying', async () => {
		mockRename.mockImplementation(async () => {
			throw fsError('ENOSPC');
		});

		await expect(writeVibesConfig(tmpDir, SAMPLE_CONFIG)).rejects.toThrow(/ENOSPC/);
		expect(mockRename).toHaveBeenCalledTimes(1);
	});

	it('gives up after exhausting bounded retries on persistent EPERM', async () => {
		mockRename.mockImplementation(async () => {
			throw fsError('EPERM');
		});

		await expect(writeVibesConfig(tmpDir, SAMPLE_CONFIG)).rejects.toThrow(/EPERM/);
		// 1 initial attempt + 4 retries
		expect(mockRename).toHaveBeenCalledTimes(5);
	});

	it('uses a unique temp suffix per write so concurrent writers cannot collide', async () => {
		await writeVibesConfig(tmpDir, SAMPLE_CONFIG);
		await writeVibesConfig(tmpDir, { ...SAMPLE_CONFIG, project_name: 'second-write' });

		const tmpPaths = mockRename.mock.calls.map((c) => String(c[0]));
		expect(tmpPaths).toHaveLength(2);
		expect(tmpPaths[0]).not.toBe(tmpPaths[1]);
		for (const p of tmpPaths) {
			expect(p).toMatch(/config\.json\.\d+\.tmp$/);
		}
	});

	it('rehashManifest rewrites annotations.jsonl atomically (via temp file + rename)', async () => {
		const auditDir = path.join(tmpDir, '.ai-audit');
		await mkdir(auditDir, { recursive: true });

		const entry = {
			type: 'environment',
			agent: 'claude-code',
			model: 'claude-4',
		};
		const newHash = computeVibesHashV2(entry as unknown as Record<string, unknown>);
		const oldHash = 'a'.repeat(64);

		await fsWriteFile(
			path.join(auditDir, 'manifest.json'),
			JSON.stringify({ standard: 'VIBES', version: '1.0', entries: { [oldHash]: entry } }),
			'utf8'
		);
		const annotation = {
			type: 'line',
			annotation_id: '0'.repeat(64),
			file_path: 'src/index.ts',
			line_start: 1,
			line_end: 2,
			environment_hash: oldHash,
			command_hash: null,
			prompt_hash: null,
			reasoning_hash: null,
			action: 'create',
			timestamp: '2026-02-10T12:00:00Z',
			commit_hash: null,
			session_id: null,
			assurance_level: 'medium',
		};
		await fsWriteFile(
			path.join(auditDir, 'annotations.jsonl'),
			JSON.stringify(annotation) + '\n',
			'utf8'
		);

		mockRename.mockClear();
		const result = await rehashManifest(tmpDir);
		expect(result.rehashedEntries).toBe(1);
		expect(result.updatedAnnotations).toBe(1);

		// The annotations rewrite went through the atomic temp-file + rename path
		const annotationRenames = mockRename.mock.calls.filter((c) =>
			String(c[1]).endsWith('annotations.jsonl')
		);
		expect(annotationRenames).toHaveLength(1);
		expect(String(annotationRenames[0][0])).toMatch(/annotations\.jsonl\.\d+\.tmp$/);

		const rewritten = await readFile(path.join(auditDir, 'annotations.jsonl'), 'utf8');
		expect(rewritten).toContain(newHash);
		expect(rewritten).not.toContain(oldHash);
	});
});
