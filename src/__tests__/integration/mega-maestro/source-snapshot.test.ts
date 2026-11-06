/**
 * The source snapshot a runtime archive is bound to (MCOMP-01-04, BASE-01 and
 * BASE-02). A pinned archive must go stale when an implementation input moves
 * and must stay current when only coordination moves: a checklist tick, a pin,
 * an evidence receipt or a doc. And the build source must never be the
 * original RC or anything imported from the private sibling checkout.
 *
 * The drift cases run the real snapshot code (`implementationSnapshot()` in
 * scripts/package-mega-maestro-runtime.mjs over `sourceTreeDigest()` in
 * scripts/write-mega-maestro-handoff.mjs) inside a scratch git repository that
 * carries copies of those scripts, so every reading comes from real commits,
 * real working-tree bytes and the scripts' own git calls. The guard cases read
 * this checkout's tracked tree and its committed records; nothing here needs
 * history beyond HEAD, so a shallow CI checkout runs it unchanged.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
	RUNTIME_PIN_FILE,
	findCanaries,
	implementationDrift,
} from '../../../../scripts/package-mega-maestro-runtime.mjs';
import { DEFAULT_SIBLING_DIR } from '../../../../scripts/mega-maestro-pair.mjs';
import {
	SOURCE_TREE_RULES,
	includedInSourceTree,
	sourceTreeDigest,
} from '../../../../scripts/write-mega-maestro-handoff.mjs';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const BASELINE_FILE = 'Plans/integration-completion/source-baseline.json';
const readJson = (file: string) => JSON.parse(fs.readFileSync(path.join(REPO_ROOT, file), 'utf8'));

/** The snapshot scripts and the shared modules they load; copied so the scratch repo is their root. */
const SNAPSHOT_SOURCES = [
	'scripts/package-mega-maestro-runtime.mjs',
	'scripts/write-mega-maestro-handoff.mjs',
	'scripts/mega-maestro-pair.mjs',
	'scripts/import-mega-maestro.mjs',
	'src/shared/canonicalJson.ts',
	'src/shared/redactSecrets.ts',
	'src/shared/litePairingCredential.ts',
];

interface Snapshot {
	digest: string;
	fileCount: number;
	deleted: number;
	dirty: boolean;
	dirtyEntries: number;
	commit: string | null;
	files: Record<string, string>;
}

let scratch: string;
let gitEnv: NodeJS.ProcessEnv;

function git(...args: string[]): string {
	return execFileSync(
		'git',
		[
			'-C',
			scratch,
			'-c',
			'user.name=snapshot',
			'-c',
			'user.email=snapshot@example.invalid',
			...args,
		],
		{ encoding: 'utf8', env: gitEnv, stdio: ['ignore', 'pipe', 'pipe'] }
	).trim();
}

function write(rel: string, text: string) {
	const file = path.join(scratch, ...rel.split('/'));
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
}

function commit(message: string): string {
	git('add', '-A');
	git('commit', '-q', '--no-verify', '-m', message);
	return git('rev-parse', 'HEAD');
}

/** `implementationSnapshot()` as the copied packager reads the scratch repo, in its own process. */
function snapshot(): Snapshot {
	const out = execFileSync(
		process.execPath,
		[
			'--input-type=module',
			'-e',
			"const m = await import('./scripts/package-mega-maestro-runtime.mjs'); process.stdout.write(JSON.stringify(m.implementationSnapshot()));",
		],
		{ cwd: scratch, encoding: 'utf8', env: gitEnv }
	);
	return JSON.parse(out) as Snapshot;
}

beforeAll(() => {
	scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-source-snapshot-'));
	// No user or system git configuration: no signing, hooks, autocrlf or default branch of the host.
	const emptyConfig = path.join(os.tmpdir(), `maestro-source-snapshot-gitconfig-${process.pid}`);
	fs.writeFileSync(emptyConfig, '');
	gitEnv = {
		...process.env,
		GIT_CONFIG_NOSYSTEM: '1',
		GIT_CONFIG_GLOBAL: emptyConfig,
		GIT_TERMINAL_PROMPT: '0',
	};
	for (const rel of SNAPSHOT_SOURCES) {
		write(rel, fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'));
	}
	// The importer loads semver; the scratch repo borrows this checkout's modules, untracked.
	fs.symlinkSync(
		path.join(REPO_ROOT, 'node_modules'),
		path.join(scratch, 'node_modules'),
		'junction'
	);
	write('.gitignore', 'node_modules\n');
	write('src/app.ts', 'export const app = 1;\n');
	write('package.json', '{ "name": "scratch", "version": "1.1.0-RC" }\n');
	write('package-lock.json', '{ "lockfileVersion": 3 }\n');
	write('tsconfig.json', '{}\n');
	write('tsconfig.main.json', '{}\n');
	write('vendor/mega-maestro/contracts.pin.json', '{ "pin": 1 }\n');
	write('vendor/mega-maestro/README.md', 'vendored contracts\n');
	write('Plans/integration-completion/runtime-conformance.json', '{ "runtime": null }\n');
	write('Plans/integration-completion/evidence/source-build.json', '{}\n');
	write('.maestro/playbooks/MCOMP-01.md', '- [ ] MCOMP-01-04\n');
	write('docs/notes.md', 'notes\n');
	write('README.md', 'scratch\n');
	git('init', '-q');
	git('checkout', '-q', '-b', 'integration');
	commit('the original RC');
	git('tag', 'v1.1.0-RC');
}, 60_000);

afterAll(() => {
	const link = path.join(scratch, 'node_modules');
	try {
		fs.unlinkSync(link);
	} catch {
		fs.rmdirSync(link);
	}
	fs.rmSync(scratch, { recursive: true, force: true });
	fs.rmSync(path.join(os.tmpdir(), `maestro-source-snapshot-gitconfig-${process.pid}`), {
		force: true,
	});
});

describe('source snapshot and drift', () => {
	it('binds to the last commit that touched an input; coordination-only commits move HEAD and nothing else', () => {
		const rc = snapshot();
		const rcCommit = git('rev-parse', 'v1.1.0-RC');
		expect(rc).toMatchObject({ dirty: false, dirtyEntries: 0, commit: rcCommit, deleted: 0 });
		// Exactly the included tracked files: no Plans, playbook, docs, README, ignore list or non-pin vendor file.
		expect(Object.keys(rc.files)).toEqual(
			[
				'package-lock.json',
				'package.json',
				...SNAPSHOT_SOURCES.filter((f) => f.startsWith('scripts/')).sort(),
				'src/app.ts',
				...SNAPSHOT_SOURCES.filter((f) => f.startsWith('src/')).sort(),
				'tsconfig.json',
				'tsconfig.main.json',
				'vendor/mega-maestro/contracts.pin.json',
			].sort()
		);

		write('src/app.ts', 'export const app = 2;\n');
		const implementationCommit = commit('integration work');
		const built = snapshot();
		expect(built.commit).toBe(implementationCommit);
		expect(built.digest).not.toBe(rc.digest);
		expect(implementationDrift(rc.files, built.files)).toEqual({
			count: 1,
			files: ['changed src/app.ts'],
		});

		// A re-pin, a BUILD receipt, a checkbox, a doc and a README edit: coordination only.
		write(
			'Plans/integration-completion/runtime-conformance.json',
			'{ "runtime": { "pinned": 2 } }\n'
		);
		write('Plans/integration-completion/evidence/source-build.json', '{ "receipt": true }\n');
		write('.maestro/playbooks/MCOMP-01.md', '- [x] MCOMP-01-04\n');
		write('docs/notes.md', 'more notes\n');
		write('README.md', 'scratch, edited\n');
		write('vendor/mega-maestro/README.md', 'vendored contracts, edited\n');
		const coordinationCommit = commit('re-pin and record');
		const after = snapshot();
		const headMoved = coordinationCommit !== implementationCommit;
		const drift = implementationDrift(built.files, after.files);
		expect(after.digest).toBe(built.digest);
		expect(after.commit).toBe(implementationCommit);
		expect(after.dirty).toBe(false);
		expect(drift).toEqual({ count: 0, files: [] });
		// verifyRuntimeInput's rule: HEAD moved while no implementation input did.
		expect(headMoved && drift.count === 0).toBe(true);

		// An uncommitted coordination edit is not dirt either.
		write('.maestro/playbooks/MCOMP-01.md', '- [x] MCOMP-01-04\n- [ ] MCOMP-01-05\n');
		write('Plans/scratch-note.md', 'untracked coordination\n');
		expect(snapshot()).toMatchObject({
			digest: built.digest,
			dirty: false,
			commit: implementationCommit,
		});
		git('checkout', '-q', '--', '.maestro');
		fs.rmSync(path.join(scratch, 'Plans/scratch-note.md'));
	}, 60_000);

	it('invalidates on every kind of implementation input, committed or not, and names what moved', () => {
		let previous = snapshot();
		for (const [file, text] of [
			['package-lock.json', '{ "lockfileVersion": 3, "packages": {} }\n'],
			['package.json', '{ "name": "scratch", "version": "1.1.1-RC" }\n'],
			['tsconfig.main.json', '{ "compilerOptions": {} }\n'],
			['vendor/mega-maestro/contracts.pin.json', '{ "pin": 2 }\n'],
			[
				'scripts/mega-maestro-pair.mjs',
				`${fs.readFileSync(path.join(scratch, 'scripts/mega-maestro-pair.mjs'), 'utf8')}// moved\n`,
			],
		] as const) {
			write(file, text);
			const head = commit(`move ${file}`);
			const next = snapshot();
			expect(next.commit, file).toBe(head);
			expect(next.digest, file).not.toBe(previous.digest);
			expect(implementationDrift(previous.files, next.files), file).toEqual({
				count: 1,
				files: [`changed ${file}`],
			});
			previous = next;
		}

		// A new tracked tsconfig matches the glob and is added; a new tracked file outside the rules is not.
		write('tsconfig.cli.json', '{}\n');
		write('tools/helper.mjs', 'export {};\n');
		commit('add a config and a tool');
		const added = snapshot();
		expect(implementationDrift(previous.files, added.files)).toEqual({
			count: 1,
			files: ['added tsconfig.cli.json'],
		});
		previous = added;

		// An uncommitted source edit moves the digest and leaves no commit to build from.
		write('src/app.ts', 'export const app = 3;\n');
		const edited = snapshot();
		expect(edited).toMatchObject({ dirty: true, dirtyEntries: 1, commit: null });
		expect(implementationDrift(previous.files, edited.files).files).toEqual(['changed src/app.ts']);
		git('checkout', '-q', '--', 'src/app.ts');

		// A tracked input missing from the tree is "deleted" in the map, never silently dropped.
		fs.rmSync(path.join(scratch, 'tsconfig.json'));
		const missing = snapshot();
		expect(missing).toMatchObject({ dirty: true, deleted: 1, commit: null });
		expect(missing.files['tsconfig.json']).toBe('deleted');
		expect(missing.digest).not.toBe(previous.digest);
		git('checkout', '-q', '--', 'tsconfig.json');

		// An untracked source file is outside the map, so dirt is what refuses it.
		write('src/untracked.ts', 'export const loose = true;\n');
		const loose = snapshot();
		expect(loose.digest).toBe(previous.digest);
		expect(loose).toMatchObject({ dirty: true, commit: null });
		fs.rmSync(path.join(scratch, 'src/untracked.ts'));
		expect(snapshot()).toMatchObject({ digest: previous.digest, dirty: false });
	}, 60_000);

	it('reads the original RC as drift against the integration tree, so it cannot pass for the build source', () => {
		const head = snapshot();
		const branchHead = git('rev-parse', 'HEAD');
		git('checkout', '-q', 'v1.1.0-RC');
		try {
			const atRc = snapshot();
			expect(atRc.commit).toBe(git('rev-parse', 'v1.1.0-RC'));
			expect(atRc.digest).not.toBe(head.digest);
			const drift = implementationDrift(head.files, atRc.files);
			expect(drift.count).toBeGreaterThan(0);
			expect(drift.files).toEqual(
				expect.arrayContaining([
					'changed src/app.ts',
					'changed package.json',
					'removed tsconfig.cli.json',
				])
			);
		} finally {
			git('checkout', '-q', 'integration');
		}
		expect(git('rev-parse', 'HEAD')).toBe(branchHead);
		expect(snapshot().digest).toBe(head.digest);
	}, 60_000);
});

describe('this checkout', () => {
	it('keeps every coordination record outside the implementation tree', () => {
		for (const file of [
			RUNTIME_PIN_FILE,
			BASELINE_FILE,
			'Plans/integration-completion/program.json',
			'Plans/integration-completion/upstream-merge.json',
			'Plans/integration-completion/evidence/source-build.json',
			'.maestro/playbooks/2026-10-29-Maestro-Integration-Completion/MCOMP-01.md',
			'docs/maestro-lib.md',
		]) {
			expect(includedInSourceTree(file), file).toBe(false);
		}
		for (const file of [
			'src/shared/maestro-lib/version.ts',
			'scripts/package-mega-maestro-runtime.mjs',
			'package.json',
			'package-lock.json',
			'tsconfig.json',
			'tsconfig.main.json',
			'vendor/mega-maestro/contracts.pin.json',
		]) {
			expect(includedInSourceTree(file), file).toBe(true);
		}
		const tracked = Object.keys(sourceTreeDigest().files);
		expect(tracked.length).toBeGreaterThan(1000);
		expect(
			tracked.filter((f) => SOURCE_TREE_RULES.exclude.some((p: string) => f.startsWith(p)))
		).toEqual([]);
	});

	it('pins a runtime built from the integration branch, never the original RC', () => {
		const baseline = readJson(BASELINE_FILE);
		const rc = baseline.checkpoint.rcComparison;
		expect(rc).toMatchObject({ ref: 'v1.1.0-RC', role: 'comparison point', headBehind: 0 });
		expect(rc.rule).toMatch(/never a reset, checkout or build target/);
		expect(baseline.implementation.commit).not.toBe(rc.commit);

		const pin = readJson(RUNTIME_PIN_FILE).runtime;
		expect(pin.implementation.rules).toBe(SOURCE_TREE_RULES.id);
		expect(pin.implementation.commit).not.toBe(rc.commit);
		expect(pin.library.sourceRevision).not.toBe(rc.commit);
		expect(pin.versions.app).not.toBe(rc.ref.replace(/^v/, ''));
		expect(readJson('package.json').version).not.toBe(rc.ref.replace(/^v/, ''));
	});

	it('imports nothing from the private sibling checkout or from outside the repository', () => {
		const tree = sourceTreeDigest();
		const sources = Object.entries(tree.files)
			.filter(([file, digest]) => digest !== 'deleted' && /\.[cm]?[jt]sx?$/.test(file))
			.map(([file]) => file);
		expect(sources.length).toBeGreaterThan(1000);
		const found = sources.flatMap((file) =>
			privateImports(file, fs.readFileSync(path.join(REPO_ROOT, file), 'utf8'))
		);
		expect(found).toEqual([]);

		// The scanner sees each way out (positive controls).
		const sibling = DEFAULT_SIBLING_DIR.split(path.sep).join('/');
		expect(
			privateImports(
				'src/main/x.ts',
				[
					"import { a } from '../../../mega-maestro/src/contracts';",
					`export * from '${sibling}/src/index';`,
					"const b = await import('../../../../outside.mjs');",
					"const c = require('file:///etc/contracts.js');",
					"vi.mock('../../../escape', () => ({}));",
					"import { d } from './inside';",
				].join('\n')
			)
		).toEqual([
			'src/main/x.ts: ../../../mega-maestro/src/contracts',
			`src/main/x.ts: ${sibling}/src/index`,
			'src/main/x.ts: ../../../../outside.mjs',
			'src/main/x.ts: file:///etc/contracts.js',
			'src/main/x.ts: ../../../escape',
		]);

		// No dependency is linked from a local folder.
		const manifest = readJson('package.json');
		for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
			for (const [name, spec] of Object.entries<string>(manifest[section] ?? {})) {
				expect(spec, `${section}.${name}`).not.toMatch(/^(file|link|portal):|\.\.\//);
			}
		}
		const lock = readJson('package-lock.json');
		for (const [key, entry] of Object.entries<{ link?: boolean; resolved?: string }>(
			lock.packages
		)) {
			expect(entry.link === true || /^file:/.test(entry.resolved ?? ''), key).toBe(false);
		}

		// The committed records carry neither the home directory nor the sibling path.
		for (const file of [RUNTIME_PIN_FILE, BASELINE_FILE]) {
			expect(findCanaries(fs.readFileSync(path.join(REPO_ROOT, file), 'utf8')), file).toEqual([]);
		}
		expect(findCanaries(`{"from":"${DEFAULT_SIBLING_DIR}"}`)).not.toEqual([]);
	});
});

/** Static module specifiers of one source file that leave the repository or name the sibling. */
function privateImports(file: string, text: string): string[] {
	const SPECIFIER =
		/(?:^\s*(?:import|export)\b[^'"`;]*?\bfrom\s*|^\s*import\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bvi\.mock\(\s*)(['"`])([^'"`\n]+)\1/gm;
	const sibling = DEFAULT_SIBLING_DIR.split(path.sep).join('/');
	const found: string[] = [];
	for (const match of text.matchAll(SPECIFIER)) {
		const spec = match[2];
		let outside = false;
		if (spec.startsWith('.')) {
			const rel = path.relative(REPO_ROOT, path.resolve(REPO_ROOT, path.dirname(file), spec));
			outside = rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
		} else {
			outside =
				spec.startsWith('file:') ||
				spec.split(path.sep).join('/').startsWith(sibling) ||
				spec.startsWith(os.homedir());
		}
		if (outside) found.push(`${file}: ${spec}`);
	}
	return found;
}
