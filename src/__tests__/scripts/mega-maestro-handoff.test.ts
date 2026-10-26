/**
 * MRC2-01-06: the handoff manifest writer and the joint record importer.
 * The library is built into a scratch folder under the repository's ignored
 * `tmp/` (a path outside it would read as a private-path canary), then the
 * writer is driven in process and as a child: two builds and two writes agree
 * byte for byte, `--check` reproduces the file, the manifest validates against
 * its own schema, an absolute or private path or a secret shape refuses by
 * name, and a fake `sk-` token in the child's environment reaches neither the
 * file nor the output. The importer refuses a digest mismatch naming the field
 * and writes nothing, copies a matching record byte for byte (or names the
 * library status alone when this checkout's build is not `ready`), and
 * refuses an unusable record before comparing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
	HandoffRefusal,
	INTEGRATION_ID,
	assertPublishable,
	buildHandoff,
	digestOf,
	findAbsolutePaths,
	includedInSourceTree,
	redactSecrets,
	serializeHandoff,
	sourceTreeDigest,
	validateHandoff,
} from '../../../scripts/write-mega-maestro-handoff.mjs';
import {
	MAESTRO_FACT_PATHS,
	MAX_RECORD_BYTES,
	compareWithLocal,
	importJointIntegration,
	maestroFactsOf,
	readJointRecord,
} from '../../../scripts/import-joint-integration.mjs';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const BUILD = path.join(REPO_ROOT, 'scripts/build-maestro-lib.mjs');
const WRITE = path.join(REPO_ROOT, 'scripts/write-mega-maestro-handoff.mjs');
const IMPORT = path.join(REPO_ROOT, 'scripts/import-joint-integration.mjs');
/** Shaped like a provider key (`redactSecrets` names it) and found nowhere else. */
const CANARY = 'sk-canaryMEGA0handoff0123456789abcdef';
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const code = (fn: () => unknown) => {
	try {
		fn();
	} catch (error) {
		if (error instanceof HandoffRefusal) return error.code;
		throw error;
	}
	return 'accepted';
};

let scratch: string;
let lib: string;
let n = 0;
const file = (name: string) => path.join(scratch, `${n++}-${name}`);
function run(script: string, args: string[], env: NodeJS.ProcessEnv = {}) {
	const result = spawnSync(process.execPath, [script, ...args], {
		cwd: REPO_ROOT,
		encoding: 'utf8',
		env: { ...process.env, ...env },
		timeout: 120_000,
	});
	if (result.error) throw result.error;
	return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

beforeAll(() => {
	scratch = fs.mkdtempSync(path.join(REPO_ROOT, 'tmp', 'mega-handoff-'));
	lib = path.join(scratch, 'lib');
	const built = spawnSync(process.execPath, [BUILD, '--out-dir', lib], {
		cwd: REPO_ROOT,
		encoding: 'utf8',
		timeout: 240_000,
	});
	if (built.status !== 0) throw new Error(`build:maestro-lib failed: ${built.stderr}`);
}, 300_000);

afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

describe('write-mega-maestro-handoff', () => {
	it('is deterministic in process and as a command, validates against its own schema, and keeps only a digest of a named document', () => {
		const first = buildHandoff({ library: lib });
		const again = buildHandoff({ library: lib });
		expect(serializeHandoff(again)).toBe(serializeHandoff(first));
		expect(validateHandoff(first)).toEqual([]);
		expect(assertPublishable(first)).toBe(first);
		const provenance = JSON.parse(fs.readFileSync(path.join(lib, 'provenance.json'), 'utf8'));
		expect(first).toMatchObject({
			integrationId: INTEGRATION_ID,
			repositoryRevision: provenance.sourceRevision,
			sourceTreeDigest: sourceTreeDigest().digest,
			agreementDigest: null,
			artifacts: [
				{
					kind: 'maestro-lib',
					path: path.relative(REPO_ROOT, lib).split(path.sep).join('/'),
					status: expect.stringMatching(/^(ready|dirty)$/),
					entry: { sha256: sha256(fs.readFileSync(path.join(lib, 'index.js'))) },
					payloadDigest: digestOf(provenance.payloadSha256),
				},
			],
		});
		for (const included of [
			'src/a.ts',
			'scripts/a.mjs',
			'package-lock.json',
			'tsconfig.main.json',
		]) {
			expect(includedInSourceTree(included), included).toBe(true);
		}
		for (const excluded of [
			'Plans/a.json',
			'docs/a.md',
			'.maestro/a',
			'README.md',
			'tsconfig.bak',
		]) {
			expect(includedInSourceTree(excluded), excluded).toBe(false);
		}

		const out = file('handoff.json');
		const doc = file('agreement.md');
		fs.writeFileSync(doc, '# agreement\n');
		const args = ['--library', lib, '--out', out, '--agreement', doc];
		expect(run(WRITE, args)).toMatchObject({ status: 0, stdout: expect.stringMatching(/^wrote /) });
		const written = fs.readFileSync(out, 'utf8');
		expect(run(WRITE, args).status).toBe(0);
		expect(fs.readFileSync(out, 'utf8')).toBe(written);
		expect(run(WRITE, [...args, '--check'])).toMatchObject({
			status: 0,
			stdout: expect.stringMatching(/is current/),
		});
		expect(run(WRITE, [...args, '--check', '--json']).stdout).toBe(written);
		const manifest = JSON.parse(written);
		expect(manifest.agreementDigest).toBe(sha256(fs.readFileSync(doc)));
		expect(written).not.toContain(doc);
		expect(written).not.toContain(scratch);
		fs.appendFileSync(out, ' ');
		expect(run(WRITE, [...args, '--check']).status).toBe(1);
	}, 120_000);

	it('refuses an absolute or private path, a secret shape and a schema fault by name, and a bad flag or library as a command', () => {
		const manifest = buildHandoff({ library: lib });
		const absolute = {
			...manifest,
			pathMapping: { ...manifest.pathMapping, agreed: '/Users/x/Plans' },
		};
		expect(() => assertPublishable(absolute)).toThrow(/absolute paths at \$\.pathMapping\.agreed/);
		expect(code(() => assertPublishable(absolute))).toBe('absolute-path');
		expect(
			findAbsolutePaths({
				a: 'C:\\x',
				b: ['\\\\srv\\share', 'file:///x'],
				c: { d: '~/x', e: 'Plans/x' },
			})
		).toEqual(['$.a', '$.b[0]', '$.b[1]', '$.c.d']);
		const providers = { ...manifest.matrix.providers, codex: `key ${CANARY}` };
		const leaking = { ...manifest, matrix: { ...manifest.matrix, providers } };
		expect(code(() => assertPublishable(leaking))).toBe('secret');
		const home = { ...manifest, matrix: { ...manifest.matrix, legend: `see ${os.homedir()}/x` } };
		expect(() => assertPublishable(home)).toThrow(/private-path/);
		expect(code(() => assertPublishable({ ...manifest, stage: 'bogus' }))).toBe('schema');
		expect(validateHandoff({ ...manifest, stage: 'bogus' })).toEqual([
			'$.stage: not one of early, full',
		]);
		const { commands: _commands, ...missing } = manifest;
		expect(validateHandoff(missing)).toEqual(['$: missing commands']);

		const out = file('refused.json');
		const refusal = (args: string[]) => {
			const result = run(WRITE, [...args, '--out', out]);
			expect(result.status).toBe(2);
			expect(fs.existsSync(out)).toBe(false);
			return result.stderr;
		};
		expect(refusal(['--library', lib, '--stage', 'bogus'])).toMatch(/refused \(usage\)/);
		expect(refusal(['--library', lib, '--bogus'])).toMatch(/refused \(usage\)/);
		expect(refusal(['--library', path.join(scratch, 'nowhere')])).toMatch(
			/refused \(library-missing\)/
		);
	}, 120_000);

	it('never carries an env value: a fake sk- token in the environment appears in neither the manifest nor the output', () => {
		expect(redactSecrets(`token ${CANARY} here`).redacted).toBe(true);
		const out = file('env.json');
		const env = { MAESTRO_CANARY: CANARY, ANTHROPIC_API_KEY: CANARY, OPENAI_API_KEY: CANARY };
		const result = run(WRITE, ['--library', lib, '--out', out, '--json'], env);
		expect(result.status).toBe(0);
		expect(result.stderr).toBe('');
		const written = fs.readFileSync(out, 'utf8');
		expect(result.stdout).toBe(written);
		for (const text of [written, result.stdout]) {
			expect(text).not.toContain(CANARY);
			expect(text).not.toContain(os.homedir());
			expect(redactSecrets(text).redacted).toBe(false);
		}
	}, 120_000);
});

describe('import-joint-integration', () => {
	const facts = () => {
		const local = buildHandoff({ library: lib });
		const artifacts = local.artifacts.map(({ kind, entry, payloadDigest }) => ({
			kind,
			entry: { sha256: entry.sha256 },
			payloadDigest,
		}));
		const { repositoryRevision, sourceTreeDigest } = local;
		return { local, maestro: { repositoryRevision, sourceTreeDigest, artifacts } };
	};
	const record = (maestro: unknown) => {
		const target = file('joint.json');
		const bytes = Buffer.from(
			`${JSON.stringify({ integrationId: INTEGRATION_ID, producer: 'mega-maestro', maestro }, null, 2)}\n`
		);
		fs.writeFileSync(target, bytes);
		return { file: target, bytes };
	};

	it('compares field by field against a ready local artifact, naming every difference', () => {
		const { local, maestro } = facts();
		const ready = { ...local, artifacts: local.artifacts.map((a) => ({ ...a, status: 'ready' })) };
		expect(compareWithLocal(maestro, ready)).toEqual([]);
		const field = 'maestro.artifacts[kind=maestro-lib]';
		const edited = structuredClone(maestro);
		edited.sourceTreeDigest = 'f'.repeat(64);
		Object.assign(edited.artifacts[0], { payloadDigest: 'e'.repeat(64), version: '0.0.1' });
		expect(compareWithLocal(edited, ready)).toEqual([
			{
				field: 'maestro.sourceTreeDigest',
				recorded: 'f'.repeat(64),
				local: local.sourceTreeDigest,
			},
			{
				field: `${field}.payloadDigest`,
				recorded: 'e'.repeat(64),
				local: local.artifacts[0].payloadDigest,
			},
			{ field: `${field}.version`, recorded: '0.0.1', local: local.artifacts[0].version },
		]);
		const stale = { ...local, artifacts: local.artifacts.map((a) => ({ ...a, status: 'stale' })) };
		expect(compareWithLocal(maestro, stale)).toEqual([
			{ field: `${field}.status`, recorded: 'ready', local: 'stale' },
		]);
		expect(compareWithLocal({ ...maestro, artifacts: [] }, ready, 'participants.maestro')).toEqual([
			{
				field: `participants.${field}`,
				recorded: 'absent',
				local: local.artifacts[0].entry.sha256,
			},
		]);
	}, 120_000);

	it('refuses a digest mismatch end to end, naming the field and writing nothing; copies a matching record byte for byte', () => {
		const { local, maestro } = facts();
		const out = file('imported.json');
		const wrong = record({ ...maestro, sourceTreeDigest: 'f'.repeat(64) });
		const report = importJointIntegration(wrong.file, { out, library: lib });
		expect(report).toMatchObject({
			factsAt: 'maestro',
			recordSha256: sha256(wrong.bytes),
			differences: [
				{
					field: 'maestro.sourceTreeDigest',
					recorded: 'f'.repeat(64),
					local: local.sourceTreeDigest,
				},
			],
			imported: false,
		});
		expect(fs.existsSync(out)).toBe(false);
		const child = run(IMPORT, [wrong.file, '--out', out, '--library', lib, '--json']);
		expect(child.status).toBe(1);
		expect(JSON.parse(child.stdout).differences.map((d: { field: string }) => d.field)).toEqual([
			'maestro.sourceTreeDigest',
		]);
		expect(fs.existsSync(out)).toBe(false);

		const right = record(maestro);
		const status = local.artifacts[0].status;
		const dry = importJointIntegration(right.file, { out, library: lib, dryRun: true });
		expect(fs.existsSync(out)).toBe(false);
		const imported = importJointIntegration(right.file, { out, library: lib });
		if (status === 'ready') {
			expect(dry).toMatchObject({ differences: [], imported: false });
			expect(imported).toMatchObject({ differences: [], imported: true });
			expect(fs.readFileSync(out).equals(right.bytes)).toBe(true);
			expect(run(IMPORT, [right.file, '--out', out, '--library', lib])).toMatchObject({
				status: 0,
				stdout: expect.stringMatching(/^imported /),
			});
		} else {
			// This checkout's library inputs are dirty, so the build is not `ready`: the status alone is named, nothing copied.
			const named = [
				{ field: 'maestro.artifacts[kind=maestro-lib].status', recorded: 'ready', local: status },
			];
			expect(dry.differences).toEqual(named);
			expect(imported).toMatchObject({ differences: named, imported: false });
			expect(fs.existsSync(out)).toBe(false);
		}
	}, 120_000);

	it('refuses an unusable record by name before comparing, and writes nothing', () => {
		const written = (text: string) => {
			const target = file('bad.json');
			fs.writeFileSync(target, text);
			return target;
		};
		expect(code(() => readJointRecord(written('{"maestro":{},"socket":"/run/x.sock"}')))).toBe(
			'absolute-path'
		);
		expect(code(() => readJointRecord(written(`{"maestro":{},"token":"${CANARY}"}`)))).toBe(
			'secret'
		);
		expect(code(() => readJointRecord(written('{not json')))).toBe('malformed');
		expect(code(() => readJointRecord(written('[]')))).toBe('malformed');
		expect(code(() => readJointRecord(written('{"integrationId":"other"}')))).toBe('integration');
		expect(code(() => readJointRecord(path.join(scratch, 'absent.json')))).toBe('usage');
		const huge = written('{}');
		fs.truncateSync(huge, MAX_RECORD_BYTES + 1);
		expect(code(() => readJointRecord(huge))).toBe('too-large');

		expect(MAESTRO_FACT_PATHS).toEqual(['maestro', 'participants.maestro', 'handoffs.maestro']);
		expect(code(() => maestroFactsOf({}))).toBe('no-maestro-facts');
		expect(() => maestroFactsOf({ participants: { maestro: { artifacts: [{}] } } })).toThrow(
			/participants\.maestro\.repositoryRevision, participants\.maestro\.sourceTreeDigest, participants\.maestro\.artifacts\[0\]\.kind/
		);
		const { maestro } = facts();
		expect(maestroFactsOf({ handoffs: { maestro }, participants: { maestro: 'x' } }).at).toBe(
			'handoffs.maestro'
		);

		const out = file('never.json');
		expect(code(() => importJointIntegration(out, { out }))).toBe('usage');
		expect(run(IMPORT, []).stderr).toMatch(/refused \(usage\)/);
		const secret = run(IMPORT, [
			written(`{"maestro":{},"k":"${CANARY}"}`),
			'--out',
			out,
			'--library',
			lib,
		]);
		expect(secret).toMatchObject({
			status: 2,
			stderr: expect.stringMatching(/refused \(secret\)/),
		});
		expect(secret.stderr).not.toContain(CANARY);
		expect(fs.existsSync(out)).toBe(false);
	}, 120_000);
});
