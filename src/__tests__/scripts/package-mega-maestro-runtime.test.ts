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
import { MAESTRO_LIB_VERSION } from '../../shared/maestro-lib/version';
import { MANAGED_CONTRACT_VERSION } from '../../shared/maestro-lib/managed/types';
import { providerRouteSupport } from '../../shared/maestro-lib/providers/capabilities';
import { HOST_API_VERSION } from '../../shared/plugins/host-api';
import { readTarGz } from '../../../scripts/import-mega-maestro.mjs';
import {
	EXCLUDED_NAME,
	buildTar,
	findCanaries,
} from '../../../scripts/package-mega-maestro-runtime.mjs';

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
		expect(status).toBe(report.library.status === 'ready' ? 0 : 3);
		expect(report.certifiable).toBe(report.library.status === 'ready');

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
			bytes: archive.length,
		});
		if (process.platform !== 'win32') {
			for (const file of ['runtime.tgz', 'runtime.tgz.sha256', 'artifact.json']) {
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
			rcBase: plan.baseRevision,
			rcBaseIsAncestor: true,
			library: { inputSha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
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
				'package/conformance/acceptance.json',
				'package/conformance/capabilities.json',
				'package/manifest.json',
				...(report.contracts.status === 'pinned' ? ['package/contracts/contracts.pin.json'] : []),
			].sort()
		);
		const {
			packagedAt: _at,
			archive: _archive,
			...inArtifact
		} = readJson(path.join(report.dir, 'artifact.json'));
		expect(JSON.parse(files.get('package/manifest.json')!.toString('utf8'))).toEqual(inArtifact);

		const matrix = JSON.parse(files.get('package/conformance/capabilities.json')!.toString('utf8'));
		expect(matrix.routes.filter((r: { agentId: string }) => r.agentId === 'claude-code')).toEqual(
			providerRouteSupport('claude-code')
		);
		expect(matrix.routes.some((r: { agentId: string }) => r.agentId === 'terminal')).toBe(false);
		expect(matrix.harness.routeId).toBe('synthetic-harness/node-permission-v1');

		const acceptance = JSON.parse(
			files.get('package/conformance/acceptance.json')!.toString('utf8')
		);
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
	});

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
