#!/usr/bin/env node
/**
 * Prettier check over the files git tracks, not the whole working tree.
 * Untracked scratch folders (test output, local notes) must not fail a push.
 * Symlinks are skipped: Prettier refuses them. Ignored files follow .prettierignore.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import prettier from 'prettier';

const listing = execFileSync('git', ['ls-files', '-s', '-z'], { encoding: 'utf8' });
const files = listing
	.split('\0')
	.filter(Boolean)
	.map((entry) => entry.split('\t'))
	.filter(([meta]) => meta.startsWith('100'))
	.map(([, path]) => path);

const failures = [];
for (const file of files) {
	const info = await prettier.getFileInfo(file, { ignorePath: '.prettierignore' });
	if (info.ignored || !info.inferredParser) continue;
	const config = await prettier.resolveConfig(file);
	if (!(await prettier.check(readFileSync(file, 'utf8'), { ...config, filepath: file }))) {
		failures.push(file);
	}
}

if (failures.length > 0) {
	console.error(`[prettier] Code style issues in ${failures.length} tracked file(s):`);
	for (const file of failures) console.error(`  ${file}`);
	console.error('Run prettier --write on them.');
	process.exit(1);
}
console.log(`[prettier] All ${files.length} tracked files use Prettier code style.`);
