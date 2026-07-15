/**
 * Windows path-shape tests for the Codex instrumenter's normalizePath()
 * and matchesExcludePattern().
 *
 * Node's `path` module binds to the host platform at import time and does NOT
 * consult process.platform at call time, so mocking process.platform alone
 * cannot reproduce Windows path semantics. Instead the whole 'path' module is
 * mocked with `path.win32` so backslash separators, drive letters, and
 * `path.sep === '\\'` behave exactly as they would on a real Windows machine.
 *
 * The normalized file_path is a VIBES spec identifier written into
 * annotations.jsonl (a hashed attestation subject), so it must come out
 * forward-slash and byte-identical on every OS.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('path', async () => {
	const actual = await vi.importActual<typeof import('path')>('path');
	return {
		...actual.win32,
		default: actual.win32,
		win32: actual.win32,
		posix: actual.posix,
	};
});

import {
	normalizePath,
	matchesExcludePattern,
} from '../../../main/vibes/instrumenters/codex-instrumenter';

describe('codex-instrumenter normalizePath (win32)', () => {
	it('converts a Windows absolute path to a forward-slash project-relative path', () => {
		expect(
			normalizePath('C:\\Users\\dev\\proj\\src\\components\\Foo.tsx', 'C:\\Users\\dev\\proj')
		).toBe('src/components/Foo.tsx');
	});

	it('normalizes mixed-separator input to forward slashes', () => {
		expect(normalizePath('C:/Users/dev/proj/src\\components/Foo.tsx', 'C:\\Users\\dev\\proj')).toBe(
			'src/components/Foo.tsx'
		);
	});

	it('converts relative backslash paths to forward slashes', () => {
		expect(normalizePath('src\\components\\Foo.tsx')).toBe('src/components/Foo.tsx');
	});

	it('keeps absolute paths outside the project root absolute but forward-slash', () => {
		expect(normalizePath('D:\\elsewhere\\file.ts', 'C:\\Users\\dev\\proj')).toBe(
			'D:/elsewhere/file.ts'
		);
	});

	describe('exclude patterns (win32 regression)', () => {
		it('matches **/node_modules/** against a normalized Windows path', () => {
			const normalized = normalizePath(
				'C:\\Users\\dev\\proj\\node_modules\\lodash\\index.js',
				'C:\\Users\\dev\\proj'
			);
			expect(normalized).toBe('node_modules/lodash/index.js');
			expect(matchesExcludePattern(normalized, ['**/node_modules/**'])).toBe(true);
		});

		it('matches a nested node_modules dir under a Windows project path', () => {
			const normalized = normalizePath(
				'C:\\Users\\dev\\proj\\packages\\app\\node_modules\\left-pad\\index.js',
				'C:\\Users\\dev\\proj'
			);
			expect(normalized).toBe('packages/app/node_modules/left-pad/index.js');
			expect(matchesExcludePattern(normalized, ['**/node_modules/**'])).toBe(true);
		});

		it('does not exclude non-matching normalized paths', () => {
			const normalized = normalizePath(
				'C:\\Users\\dev\\proj\\src\\index.ts',
				'C:\\Users\\dev\\proj'
			);
			expect(normalized).toBe('src/index.ts');
			expect(matchesExcludePattern(normalized, ['**/node_modules/**'])).toBe(false);
		});

		it('matches when a raw backslash path is passed directly to the matcher', () => {
			expect(matchesExcludePattern('src\\generated\\api.ts', ['src/generated/**'])).toBe(true);
		});
	});
});
