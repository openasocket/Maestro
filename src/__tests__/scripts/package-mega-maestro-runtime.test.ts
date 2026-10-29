/**
 * scripts/package-mega-maestro-runtime.mjs turns the built library into the
 * immutable archive an operator pins. These checks build the library into a
 * scratch folder (as built-entry.test.ts does), package it, and read the
 * result back the way the importer reads a Mega-Maestro artifact: the payload
 * is exactly what the build hashed, the manifest names every version and the
 * RC base, the capability matrix is the bundle's own, the tested column comes
 * only from the evidence files, the digest is reproducible, and a moved,
 * unlisted or missing file refuses the package by name.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { MAESTRO_LIB_VERSION } from '../../shared/maestro-lib/version';
import { MANAGED_CONTRACT_VERSION } from '../../shared/maestro-lib/managed/types';
import { providerRouteSupport } from '../../shared/maestro-lib/providers/capabilities';
import { HOST_API_VERSION } from '../../shared/plugins/host-api';
import { readTarGz } from '../../../scripts/import-mega-maestro.mjs';
import {
	ACCEPTANCE_NAME,
	EXCLUDED_NAME,
	MANAGED_PORT,
	buildTar,
	findCanaries,
	implementationDrift,
	managedPort,
	runtimePinOf,
	verifyRuntimeInput,
} from '../../../scripts/package-mega-maestro-runtime.mjs';
import {
	SOURCE_TREE_RULES,
	digestOf,
	sourceTreeDigest,
} from '../../../scripts/write-mega-maestro-handoff.mjs';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const BUILD = path.join(REPO_ROOT, 'scripts/build-maestro-lib.mjs');
const PACKAGE = path.join(REPO_ROOT, 'scripts/package-mega-maestro-runtime.mjs');
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));

let sandbox: string;
let libDir: string;

function run(args: string[]) {
	const result = spawnSync(process.execPath, [PACKAGE, ...args, '--json'], {
		cwd: REPO_ROOT,
		encoding: 'utf8',
		timeout: 120_000,
	});
	if (result.error) throw result.error;
	return {
		status: result.status,
		stderr: result.stderr,
		report: result.stdout ? readJson(path.join(sandbox, writeStdout(result.stdout))) : null,
	};
}

let stdoutN = 0;
function writeStdout(text: string): string {
	const name = `stdout-${stdoutN++}.json`;
	fs.writeFileSync(path.join(sandbox, name), text);
	return name;
}

beforeAll(() => {
	sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-runtime-package-'));
	libDir = path.join(sandbox, 'lib');
	const built = spawnSync(process.execPath, [BUILD, '--out-dir', libDir], {
		cwd: REPO_ROOT,
		encoding: 'utf8',
		timeout: 240_000,
	});
	if (built.status !== 0) throw new Error(`build:maestro-lib failed: ${built.stderr}`);
}, 300_000);

/** The packager leaves its directories read-only; open them again so the sandbox can go. */
function unlock(dir: string) {
	fs.chmodSync(dir, 0o755);
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) unlock(path.join(dir, entry.name));
	}
}

/** Every regular file of the archive, extracted by the host tar, keyed by entry path. */
function extract(archive: string): Map<string, Buffer> {
	const dir = fs.mkdtempSync(path.join(sandbox, 'extract-'));
	const result = spawnSync('tar', ['-xzf', archive, '-C', dir], { encoding: 'utf8' });
	if (result.status !== 0) throw new Error(`tar failed: ${result.stderr}`);
	const files = new Map<string, Buffer>();
	const walk = (at: string) => {
		for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
			const full = path.join(at, entry.name);
			if (entry.isDirectory()) walk(full);
			else files.set(path.relative(dir, full).split(path.sep).join('/'), fs.readFileSync(full));
		}
	};
	walk(dir);
	return files;
}

afterAll(() => {
	unlock(sandbox);
	fs.rmSync(sandbox, { recursive: true, force: true });
});

describe('package-mega-maestro-runtime', () => {
	const flags = ['--allow-dirty', '--allow-stale'];

	it('packages the built library as a content-addressed, read-only archive with a manifest', () => {
		const out = path.join(sandbox, 'out-a');
		const { status, report } = run(['--library', libDir, '--out', out, ...flags]);
		expect(status).toBe(report.certifiable ? 0 : 3);
		expect(report.certifiable).toBe(
			report.library.status === 'ready' && report.source.implementation.dirty === false
		);

		const digest = report.archive.sha256;
		expect(report.dir).toBe(path.join(out, MAESTRO_LIB_VERSION, digest));
		const archive = fs.readFileSync(path.join(report.dir, 'runtime.tgz'));
		expect(sha256(archive)).toBe(digest);
		expect(fs.readFileSync(path.join(report.dir, 'runtime.tgz.sha256'), 'utf8')).toBe(
			`${digest}  runtime.tgz\n`
		);
		const artifact = readJson(path.join(report.dir, 'artifact.json'));
		expect(artifact.archive).toEqual({
			file: 'runtime.tgz',
			sha256: digest,
			sha512: createHash('sha512').update(archive).digest('hex'),
			bytes: archive.length,
		});
		if (process.platform !== 'win32') {
			for (const file of ['runtime.tgz', 'runtime.tgz.sha256', 'artifact.json', ACCEPTANCE_NAME]) {
				expect(fs.statSync(path.join(report.dir, file)).mode & 0o222, file).toBe(0);
			}
		}

		const plan = readJson(path.join(REPO_ROOT, 'Plans/mega-maestro-rc/execution-plan.json'));
		expect(artifact.versions).toMatchObject({
			app: readJson(path.join(REPO_ROOT, 'package.json')).version,
			library: MAESTRO_LIB_VERSION,
			managedContract: MANAGED_CONTRACT_VERSION,
			endpointProtocol: 1,
			pluginHostApi: HOST_API_VERSION,
			pluginSdk: readJson(path.join(REPO_ROOT, 'packages/plugin-sdk/package.json')).version,
			acceptedContracts: { package: '@mega-maestro/contracts' },
		});
		expect(artifact.source).toMatchObject({
			library: { inputSha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
		});
		// HEAD, the branch, tree dirtiness and the RC base are observations beside the archive, not in it.
		expect(artifact.observed).toMatchObject({
			head: expect.stringMatching(/^[a-f0-9]{40}$/),
			rcBase: plan.baseRevision,
			rcBaseIsAncestor: true,
			acceptance: ACCEPTANCE_NAME,
		});
		expect(artifact.contracts.status).toMatch(/^(pinned|absent)$/);
		expect(JSON.stringify(artifact)).not.toContain(os.homedir());
	});

	it('carries exactly the files the build hashed, with the matrix of the bundle and evidence-only pass marks', () => {
		const out = path.join(sandbox, 'out-b');
		const { report } = run(['--library', libDir, '--out', out, ...flags]);
		const files = extract(path.join(report.dir, 'runtime.tgz'));
		const provenance = readJson(path.join(libDir, 'provenance.json'));
		for (const [file, digest] of Object.entries(provenance.payloadSha256)) {
			expect(sha256(files.get(`package/library/${file}`)!), file).toBe(digest);
		}
		const extra = [...files.keys()].filter((f) => !f.startsWith('package/library/'));
		expect(extra.sort()).toEqual(
			[
				'package/conformance/capabilities.json',
				'package/manifest.json',
				'package/source/implementation.json',
				'package/source/library-inputs.json',
				...(report.contracts.status === 'pinned' ? ['package/contracts/contracts.pin.json'] : []),
			].sort()
		);
		const {
			packagedAt: _at,
			archive: _archive,
			observed: _observed,
			...inArtifact
		} = readJson(path.join(report.dir, 'artifact.json'));
		const manifestText = files.get('package/manifest.json')!.toString('utf8');
		expect(JSON.parse(manifestText)).toEqual(inArtifact);
		// Nothing a coordination commit moves is in the archive: no HEAD unless it is the
		// implementation commit, no branch, no tree dirtiness, no evidence marks.
		const implementation = inArtifact.source.implementation;
		expect(Object.keys(inArtifact.source).sort()).toEqual(['implementation', 'library']);
		expect(implementation).not.toHaveProperty('observedHead');
		expect(manifestText).not.toMatch(/"(branch|head|headCommittedAt|treeDirty|rcBase)"/);
		// (The library's own provenance names the revision it was built at; that is the build's, not the packaging's.)
		const revisionsInside = [implementation.commit, inArtifact.source.library.sourceRevision];
		if (!revisionsInside.includes(report.observed.head)) {
			expect(manifestText).not.toContain(report.observed.head);
		}
		// The tar time is the implementation commit's (ustar header: name at 0, size at 124, mtime at 136).
		const tar = gunzipSync(fs.readFileSync(path.join(report.dir, 'runtime.tgz')));
		let entryTime = -1;
		for (let at = 0; at + 512 <= tar.length; ) {
			const name = tar.toString('utf8', at, at + 100).replace(/\0[\s\S]*$/, '');
			if (!name) break;
			if (name === 'package/manifest.json') {
				entryTime = Number.parseInt(tar.toString('utf8', at + 136, at + 148), 8);
				break;
			}
			const size = Number.parseInt(tar.toString('utf8', at + 124, at + 136), 8);
			at += 512 + Math.ceil(size / 512) * 512;
		}
		expect(entryTime).toBe(Math.floor(Date.parse(implementation.committedAt) / 1000));

		const matrix = JSON.parse(files.get('package/conformance/capabilities.json')!.toString('utf8'));
		expect(matrix.routes.filter((r: { agentId: string }) => r.agentId === 'claude-code')).toEqual(
			providerRouteSupport('claude-code')
		);
		expect(matrix.routes.some((r: { agentId: string }) => r.agentId === 'terminal')).toBe(false);
		expect(matrix.harness.routeId).toBe('synthetic-harness/node-permission-v1');

		// The acceptance rows and their evidence marks are beside the archive, never in it.
		expect(files.has('package/conformance/acceptance.json')).toBe(false);
		const acceptance = readJson(path.join(report.dir, ACCEPTANCE_NAME));
		const plan = readJson(path.join(REPO_ROOT, 'Plans/mega-maestro-rc/execution-plan.json'));
		expect(acceptance.rows.map((r: { id: string }) => r.id)).toEqual(
			plan.positiveAcceptanceMatrix.map((r: { id: string }) => r.id)
		);
		for (const row of acceptance.rows) {
			if (row.tested === null) continue;
			const evidence = readJson(
				path.join(REPO_ROOT, 'Plans/mega-maestro-rc/evidence', row.tested.evidence)
			);
			expect(row.tested.passed).toBe(evidence.positiveAcceptanceMatrix[row.id].passed);
		}
	});

	it('binds the archive to the implementation tree, the library inputs and the managed port, and discloses what is unavailable', () => {
		const out = path.join(sandbox, 'out-f');
		const { report } = run(['--library', libDir, '--out', out, ...flags]);
		const files = extract(path.join(report.dir, 'runtime.tgz'));
		const manifest = JSON.parse(files.get('package/manifest.json')!.toString('utf8'));

		// The explicit source-tree digest: the handoff's rules, reproducible from the archived map alone.
		const implementation = manifest.source.implementation;
		const map = JSON.parse(files.get('package/source/implementation.json')!.toString('utf8'));
		expect(implementation).toMatchObject({
			rules: { id: SOURCE_TREE_RULES.id, include: [...SOURCE_TREE_RULES.include] },
			digest: sourceTreeDigest().digest,
			fileCount: Object.keys(map.files).length,
			map: 'source/implementation.json',
			committedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
		});
		expect(digestOf({ rules: map.rules, files: map.files })).toBe(implementation.digest);
		expect(
			Object.keys(map.files).every((f) => !path.isAbsolute(f) && !f.startsWith('Plans/'))
		).toBe(true);
		if (implementation.dirty) expect(implementation.commit).toBeNull();
		else expect(implementation.commit).toMatch(/^[a-f0-9]{40}$/);

		// The library's exhaustive input map, as the build recorded it.
		const provenance = readJson(path.join(libDir, 'provenance.json'));
		const inputs = JSON.parse(files.get('package/source/library-inputs.json')!.toString('utf8'));
		expect(inputs).toEqual({ inputSha256: provenance.inputSha256, inputs: provenance.inputs });
		expect(Object.keys(inputs.inputs)).toHaveLength(provenance.inputFiles);
		expect(manifest.source.library.inputs).toBe('source/library-inputs.json');

		// The managed port, checked on the bundle the archive carries.
		const lib = require(path.join(libDir, 'index.js')) as Record<string, unknown>;
		expect(manifest.managedPort.exports).toEqual([...MANAGED_PORT.exports]);
		for (const name of manifest.managedPort.exports)
			expect(typeof lib[name], name).toBe('function');
		for (const file of manifest.managedPort.declarations) {
			expect(files.has(`package/${file}`), file).toBe(true);
		}
		expect(manifest.managedPort.entry.sha256).toBe(provenance.payloadSha256['index.js']);

		// What the bootstrap says is missing is exactly what the bundle's matrix says, and no claim beyond it.
		const matrix = JSON.parse(files.get('package/conformance/capabilities.json')!.toString('utf8'));
		const unavailable = matrix.routes.filter(
			(r: { managed: string }) => r.managed !== 'implemented'
		);
		expect(manifest.bootstrap.routes).toMatchObject({
			total: matrix.routes.length,
			managedImplemented: matrix.routes.length - unavailable.length,
		});
		expect(manifest.bootstrap.routes.unavailable.map((r: object) => JSON.stringify(r))).toEqual(
			unavailable.map(({ agentId, route, standalone, managed }: Record<string, string>) =>
				JSON.stringify({ agentId, route, standalone, managed })
			)
		);
		expect(manifest.bootstrap.qualification).toEqual({
			paired: false,
			provider: false,
			native: false,
		});
		expect(manifest.bootstrap.counterpart['CP-02'].runtimeAdapter).toBe('absent');
		expect(manifest.bootstrap.counterpart['CP-01'].contracts).toBe(manifest.contracts.status);

		// A bundle that reaches less than the port is refused by name, in-process, before any write.
		const hollow = path.join(sandbox, 'hollow');
		fs.mkdirSync(hollow, { recursive: true });
		fs.writeFileSync(
			path.join(hollow, 'index.js'),
			'module.exports = { installationIdentity() {} };'
		);
		expect(() => managedPort(hollow, { payloadSha256: {} })).toThrow(/managed-port|exports no/);
		expect(() => managedPort(libDir, { payloadSha256: {} })).toThrow(/carries no types\//);
	}, 30_000);

	it('verifies a --runtime input against the tree and the committed pin, and refuses drift, a foreign pin and a receipt in the pin', () => {
		const out = path.join(sandbox, 'out-g');
		const { report } = run(['--library', libDir, '--out', out, ...flags]);
		const dir = report.dir as string;
		const tree = sourceTreeDigest();
		const pinFile = path.join(sandbox, 'runtime-conformance.json');
		const expectReady = report.certifiable ? 'ready' : 'not-certifiable';

		// No pin: bound and current, but arbitrary; nothing loads it.
		const unpinned = verifyRuntimeInput({ runtime: dir, pin: pinFile });
		expect(unpinned.status).toBe(report.certifiable ? 'unpinned' : 'not-certifiable');
		if (report.certifiable) {
			expect(unpinned.drift).toEqual({ count: 0, files: [] });
			expect(unpinned.libraryInputs).toEqual([]);
			expect(unpinned.implementation).toMatchObject({
				archived: tree.digest,
				current: tree.digest,
			});
		}

		// The pin is identity only, with both archive digests, the tree digest and the payload digest.
		const pin = runtimePinOf(dir);
		expect(pin).toMatchObject({
			artifactId: 'MAESTRO-M0-RUNTIME',
			archive: { sha256: report.archive.sha256, sha512: report.archive.sha512 },
			implementation: { digest: report.source.implementation.digest },
			library: { inputSha256: report.source.library.inputSha256 },
			location: { directory: expect.stringContaining(report.archive.sha256) },
		});
		expect(JSON.stringify(pin)).not.toMatch(/"(qualifiedAgainst|adapter|qualification|passed)"/);
		expect(JSON.stringify(pin)).not.toContain(os.homedir());
		fs.writeFileSync(pinFile, JSON.stringify({ formatVersion: 1, runtime: pin }));
		const pinned = verifyRuntimeInput({ runtime: dir, pin: pinFile });
		expect(pinned.status).toBe(expectReady);
		expect(pinned.pin).toMatchObject({ status: 'pinned', committed: false });

		// Drift: an implementation file that moved since the archive is named, and no pin cures it.
		const [first] = Object.keys(tree.files);
		const moved = { ...tree.files, [first]: 'f'.repeat(64), 'src/new.ts': 'a'.repeat(64) };
		const drifted = verifyRuntimeInput({
			runtime: dir,
			pin: pinFile,
			sourceTree: { digest: 'moved', files: moved },
		});
		if (report.certifiable) {
			expect(drifted.status).toBe('drift');
			expect(drifted.drift).toEqual({ count: 2, files: [`added src/new.ts`, `changed ${first}`] });
			expect(drifted.problems.join()).toContain(first);
		}
		expect(implementationDrift({ a: '1', b: '2' }, { b: '3', c: '4' })).toEqual({
			count: 3,
			files: ['added c', 'changed b', 'removed a'],
		});

		// A pin that names another archive, and a pin that carries a qualification receipt.
		fs.writeFileSync(
			pinFile,
			JSON.stringify({ runtime: { ...pin, archive: { ...pin.archive, sha256: '0'.repeat(64) } } })
		);
		const foreign = verifyRuntimeInput({ runtime: dir, pin: pinFile });
		if (report.certifiable) expect(foreign.status).toBe('pin-mismatch');
		fs.writeFileSync(
			pinFile,
			JSON.stringify({ runtime: { ...pin, qualifiedAgainst: { maestroRuntimeSha256: 'x' } } })
		);
		const receipt = verifyRuntimeInput({ runtime: dir, pin: pinFile });
		if (report.certifiable) expect(receipt.status).toBe('pin-not-runtime');

		// A sidecar that does not match the archive is refused before anything is compared.
		const copy = path.join(sandbox, 'copy', report.archive.sha256);
		fs.mkdirSync(path.dirname(copy), { recursive: true });
		fs.cpSync(dir, copy, { recursive: true });
		unlock(path.dirname(copy));
		fs.chmodSync(path.join(copy, 'runtime.tgz.sha256'), 0o644);
		fs.writeFileSync(path.join(copy, 'runtime.tgz.sha256'), `${'0'.repeat(64)}  runtime.tgz\n`);
		expect(verifyRuntimeInput({ runtime: copy, pin: pinFile }).status).toBe('digest-mismatch');
	}, 60_000);

	it('is reproducible, immutable, and refuses a moved, unlisted or missing library by name', () => {
		const first = run(['--library', libDir, '--out', path.join(sandbox, 'out-c'), ...flags]).report;
		const again = run(['--library', libDir, '--out', path.join(sandbox, 'out-c'), ...flags]).report;
		const elsewhere = run([
			'--library',
			libDir,
			'--out',
			path.join(sandbox, 'out-d'),
			...flags,
		]).report;
		expect(again).toMatchObject({ existing: true, archive: first.archive });
		expect(elsewhere.archive.sha256).toBe(first.archive.sha256);

		const missing = run([
			'--library',
			path.join(sandbox, 'nowhere'),
			'--out',
			path.join(sandbox, 'out-e'),
		]);
		expect(missing.status).toBe(2);
		expect(missing.stderr).toContain('library-missing');

		const copy = path.join(sandbox, 'lib-copy');
		fs.cpSync(libDir, copy, { recursive: true });
		fs.writeFileSync(path.join(copy, 'notes.txt'), 'planted');
		const unlisted = run(['--library', copy, '--out', path.join(sandbox, 'out-e'), ...flags]);
		expect(unlisted.status).toBe(2);
		expect(unlisted.stderr).toContain('unlisted-file');
		expect(unlisted.stderr).toContain('notes.txt');
		fs.rmSync(path.join(copy, 'notes.txt'));
		fs.appendFileSync(path.join(copy, 'README.md'), '\nmoved\n');
		const moved = run(['--library', copy, '--out', path.join(sandbox, 'out-e'), ...flags]);
		expect(moved.status).toBe(2);
		expect(moved.stderr).toContain('mismatch');
		expect(moved.stderr).toContain('README.md');
	}, 60_000);

	it('names secret canaries and private paths, excludes credential-like names, and writes a deterministic tar', () => {
		expect(findCanaries('-----BEGIN PRIVATE KEY-----\nabc', [])).toEqual(['private-key']);
		expect(findCanaries('token AKIAABCDEFGHIJKLMNOP here', [])).toEqual(['aws-access-key']);
		expect(findCanaries('see /Users/someone/.maestro', ['/Users/someone'])).toEqual([
			'private-path',
		]);
		expect(findCanaries('nothing here', ['/Users/someone', '/'])).toEqual([]);
		for (const name of [
			'library/.env',
			'x/credentials.json',
			'maestro-managed-commands.json',
			'a.pem',
		]) {
			expect(EXCLUDED_NAME.test(name), name).toBe(true);
		}
		for (const name of ['library/types/shared/claudeTokenMode.d.ts', 'library/index.js']) {
			expect(EXCLUDED_NAME.test(name), name).toBe(false);
		}
		const entries = [
			{ path: 'b/two.txt', data: Buffer.from('two') },
			{ path: 'a.txt', data: Buffer.from('one') },
		];
		const tar = buildTar(entries, 1_700_000_000);
		expect(buildTar([...entries].reverse(), 1_700_000_000).equals(tar)).toBe(true);
		const { gzipSync } = require('node:zlib') as typeof import('node:zlib');
		expect(readTarGz(gzipSync(tar)).map((e: { path: string }) => e.path)).toEqual([
			'package',
			'package/b',
			'package/a.txt',
			'package/b/two.txt',
		]);
	});
});
