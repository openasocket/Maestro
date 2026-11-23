/**
 * The app bundle takes `dist/**`, and `dist/` also holds build products the app
 * never loads: compiled tests, the standalone maestro-lib package, the
 * Mega-Maestro packaging outputs and earlier local app builds. Packed in, they
 * grew app.asar from about 1.4 GB to 5.7 GB on 2026-11-23. These exclusions
 * keep them out.
 */
import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const pkg = JSON.parse(readFileSync(path.join(__dirname, '../../../package.json'), 'utf8'));

describe('packaged files', () => {
	it.each([
		'!dist/__tests__/**/*',
		'!dist/maestro-lib/**/*',
		'!dist/mega-maestro-*/**/*',
		'!dist/macos-*/**/*',
	])('excludes %s from the app bundle', (pattern) => {
		expect(pkg.build.files).toContain(pattern);
	});

	it('writes packaged apps outside dist/, so a build never packs an earlier one', () => {
		expect(pkg.build.directories.output.startsWith('dist')).toBe(false);
	});
});
