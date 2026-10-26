#!/usr/bin/env node
/**
 * Detect drift between a built Mega-Maestro contracts package and the facts
 * Maestro recorded about it in the contract-vectors fixture.
 *
 *   node scripts/check-mega-contract-vectors.mjs --contracts-dir <dir> --expect-sha256 <hex>
 *     [--fixture src/__tests__/fixtures/mega-maestro/contract-vectors.json] [--allow-dirty-source]
 *
 * `--contracts-dir` names ONE CP-01 artifact explicitly, in either form: the
 * published artifact folder (`artifact.json` beside `contracts.tgz`, verified by
 * the importer and read in memory; the digest is the archive sha256 the pin
 * records) or the extracted package (`provenance.json` and `dist/`; every payload
 * file is hashed again; the digest is the pin's `payloadDigest`). A digest
 * mismatch, a missing, extra or altered payload file, or a dirty-source build
 * without `--allow-dirty-source` is a refusal (exit 2) and nothing is loaded.
 * Nothing scans a sibling checkout or picks the newest archive.
 *
 * `dist/local-endpoint.js` is then loaded in a child Node under the permission
 * model (no network, no child process, reads limited to a scratch copy and this
 * checkout's `zod`), which reports the enumerations its schemas carry. Drift
 * exits 1 with every differing fact named. The runtime port is not in the
 * contracts package; the unit test checks that section against Maestro's types.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { ImportError, LIMITS, verifyArtifact } from './import-mega-maestro.mjs';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_FIXTURE = 'src/__tests__/fixtures/mega-maestro/contract-vectors.json';
export const FIXTURE_FORMAT_VERSION = 1;
export const ENDPOINT_MODULE = 'dist/local-endpoint.js';
export const PROBE_TIMEOUT_MS = 20_000;
/** The facts the module carries, in report order. The numeric ones are protocol and the byte limits. */
export const CHECKED_FACTS = Object.freeze([
	'protocol',
	'operations',
	'denialReasons',
	'commandActions',
	'componentKinds',
	'executionSources',
	'maxRequestBytes',
	'maxResponseBytes',
]);

export class CheckError extends Error {
	constructor(code, message) {
		super(message);
		this.name = 'CheckError';
		this.code = code;
	}
}
const fail = (code, message) => {
	throw new CheckError(code, message);
};
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const isHex = (v, n) => typeof v === 'string' && v.length === n && /^[a-f0-9]+$/.test(v);
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNumeric = (fact) => fact === 'protocol' || fact.endsWith('Bytes');

function readJson(file, what, maxBytes = LIMITS.manifestBytes) {
	const stat = fs.lstatSync(file, { throwIfNoEntry: false });
	if (!stat?.isFile()) fail('missing-input', `${what} is not a regular file: ${file}`);
	if (stat.size > maxBytes) fail('too-large', `${what} is over ${maxBytes} bytes`);
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch (error) {
		return fail('format', `${what} is not JSON: ${error.message}`);
	}
}

/** The fixture, checked for the shape this script and the unit test rely on. */
export function readFixture(file) {
	const fixture = readJson(file, 'fixture');
	if (fixture?.formatVersion !== FIXTURE_FORMAT_VERSION) fail('fixture-format', 'formatVersion');
	if (!isHex(fixture.counterpart?.sourceRevision, 40)) fail('fixture-format', 'sourceRevision');
	for (const fact of CHECKED_FACTS) {
		const v = fixture.localEndpoint?.[fact];
		const ok = isNumeric(fact)
			? Number.isInteger(v) && v > 0
			: Array.isArray(v) && v.length > 0 && v.every((s) => s && typeof s === 'string');
		if (!ok) fail('fixture-format', `localEndpoint.${fact} is missing or malformed`);
	}
	return fixture;
}

/** The payload digest the importer records in the pin, from a payloadSha256 map. */
export const payloadDigestOf = (map) => sha256(JSON.stringify(Object.entries(map).sort()));

/** Read either form of the contracts directory, verify it against the digest, return the payload bytes. */
export function inspectContractsDir({ contractsDir, expectedSha256, allowDirtySource = false }) {
	if (!isHex(expectedSha256, 64)) fail('usage', '--expect-sha256 must be 64 hex characters');
	const dir = path.resolve(contractsDir);
	if (!fs.lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
		fail('missing-input', `--contracts-dir is not a directory: ${dir}`);
	}
	const archivePath = path.join(dir, 'contracts.tgz');
	if (fs.existsSync(archivePath)) {
		const manifestPath = path.join(dir, 'artifact.json');
		const r = verifyArtifact({ manifestPath, archivePath, expectedSha256, allowDirtySource });
		const payload = r.entries.filter((e) => e.type === 'file');
		const files = new Map(payload.map((e) => [e.path.slice(8), e.data]));
		const { sha256: digest, sourceRevision, sourceDirty } = r;
		return { mode: 'archive', digest, sourceRevision, sourceDirty, files };
	}
	const provenance = readJson(path.join(dir, 'provenance.json'), 'provenance.json');
	const { sourceRevision, sourceDirty, payloadSha256: map } = provenance ?? {};
	if (!isHex(sourceRevision, 40)) fail('format', 'provenance.json sourceRevision');
	if (typeof sourceDirty !== 'boolean') fail('format', 'provenance.json sourceDirty');
	if (!isObject(map) || Object.keys(map).length === 0) fail('format', 'payloadSha256 is empty');
	for (const [file, digest] of Object.entries(map)) {
		const parts = file.split('/');
		const unsafe = parts[0] !== 'dist' || /\\/.test(file) || parts.some((p) => !p || p[0] === '.');
		if (!isHex(digest, 64) || unsafe) fail('format', `payloadSha256 entry "${file}" is unsafe`);
	}
	const digest = payloadDigestOf(map);
	if (digest !== expectedSha256) fail('digest-mismatch', `payload digest is ${digest}`);
	const files = new Map();
	for (const [file, expected] of Object.entries(map)) {
		const stat = fs.lstatSync(path.join(dir, file), { throwIfNoEntry: false });
		if (!stat?.isFile()) fail('payload-missing', `"${file}" is not a regular file`);
		if (stat.size > LIMITS.fileBytes) fail('too-large', `"${file}" is over ${LIMITS.fileBytes}`);
		const data = fs.readFileSync(path.join(dir, file));
		if (sha256(data) !== expected) fail('payload-digest', `"${file}" differs from provenance.json`);
		files.set(file, data);
	}
	const distDir = path.join(dir, 'dist');
	if (!fs.existsSync(distDir)) fail('missing-input', 'no dist/ in the contracts directory');
	for (const entry of fs.readdirSync(distDir, { recursive: true, withFileTypes: true })) {
		const file = path.relative(dir, path.join(entry.parentPath, entry.name)).replaceAll('\\', '/');
		if (!entry.isDirectory() && (!entry.isFile() || !files.has(file))) {
			fail('payload-extra', `"${file}" is not a payload file named by provenance.json`);
		}
	}
	if (!files.has(ENDPOINT_MODULE)) fail('payload-missing', `payload has no ${ENDPOINT_MODULE}`);
	if (sourceDirty && !allowDirtySource) {
		fail('dirty-source', `built from dirty source at ${sourceRevision}; pass --allow-dirty-source`);
	}
	return { mode: 'extracted', digest, sourceRevision, sourceDirty, files };
}

/** What runs in the child: read the schemas' enumerations, never a request. */
export const PROBE_SOURCE = `import * as m from './${ENDPOINT_MODULE}';
const options = (schema) => [...schema.options];
const literal = (schema) => ([...schema.values].length === 1 ? [...schema.values][0] : [...schema.values]);
process.stdout.write(JSON.stringify({
	protocol: literal(m.attachmentRequest.shape.supportedProtocols.element),
	operations: options(m.localRequestEnvelope.shape.operation),
	denialReasons: options(m.denied.shape.reason),
	commandActions: m.commandRequest.shape.action.options.map((o) => literal(o.shape.kind)),
	componentKinds: options(m.attachmentRequest.shape.components.element.shape.kind),
	executionSources: options(m.executionRequest.shape.source),
	maxRequestBytes: m.localMaximumRequestBytes,
	maxResponseBytes: m.localMaximumResponseBytes,
}));
`;

/** Stage `dist/*.js` and the probe under this checkout so `import "zod"` resolves to its copy only. */
export function stageProbe(files) {
	const scratch = fs.mkdtempSync(path.join(REPO_ROOT, '.mega-contract-check-'));
	fs.writeFileSync(path.join(scratch, 'package.json'), '{"type":"module"}\n', { flag: 'wx' });
	for (const [file, data] of files) {
		if (!file.startsWith('dist/') || !file.endsWith('.js')) continue;
		fs.mkdirSync(path.dirname(path.join(scratch, file)), { recursive: true });
		fs.writeFileSync(path.join(scratch, file), data, { flag: 'wx', mode: 0o644 });
	}
	fs.writeFileSync(path.join(scratch, 'probe.mjs'), PROBE_SOURCE, { flag: 'wx' });
	return scratch;
}

/** Run the probe under the permission model and return what it reported. */
export function runProbe(scratch) {
	const zodDir = path.join(REPO_ROOT, 'node_modules', 'zod');
	if (!fs.existsSync(path.join(zodDir, 'package.json')))
		fail('zod-missing', `${zodDir} is missing`);
	const { NODE_OPTIONS: _dropped, ...env } = process.env;
	const flags = ['--permission', '--disallow-code-generation-from-strings'];
	const reads = [`--allow-fs-read=${scratch}`, `--allow-fs-read=${zodDir}`];
	const result = spawnSync(
		process.execPath,
		[...flags, ...reads, path.join(scratch, 'probe.mjs')],
		{
			cwd: scratch,
			env,
			encoding: 'utf8',
			timeout: PROBE_TIMEOUT_MS,
			maxBuffer: 1024 * 1024,
		}
	);
	if (result.error) fail('probe-failed', `probe did not run: ${result.error.message}`);
	if (result.status !== 0) fail('probe-failed', `probe exited ${result.status}: ${result.stderr}`);
	try {
		const observed = JSON.parse(result.stdout);
		return isObject(observed) ? observed : fail('probe-failed', 'probe output is not an object');
	} catch (error) {
		return fail('probe-failed', `probe output is not JSON: ${error.message}`);
	}
}

/** Every fact whose recorded and observed values differ, with what is missing and extra. */
export function diffFacts(recorded, observed) {
	const drift = [];
	for (const fact of CHECKED_FACTS) {
		const expected = recorded[fact];
		const actual = observed[fact];
		if (!Array.isArray(expected)) {
			if (expected !== actual) drift.push({ fact, expected, observed: actual });
			continue;
		}
		const have = Array.isArray(actual) ? actual : [];
		const missing = expected.filter((v) => !have.includes(v));
		const extra = have.filter((v) => !expected.includes(v));
		if (missing.length || extra.length || !Array.isArray(actual)) {
			drift.push({ fact, expected, observed: actual, missing, extra });
		}
	}
	return drift;
}

/** The whole check: verify, stage, probe, diff. Removes its scratch folder. */
export function checkContractVectors(options) {
	const fixturePath = path.resolve(REPO_ROOT, options.fixturePath ?? DEFAULT_FIXTURE);
	const fixture = readFixture(fixturePath);
	const { files, ...archive } = inspectContractsDir(options);
	const scratch = stageProbe(files);
	let observed;
	try {
		observed = runProbe(scratch);
	} finally {
		fs.rmSync(scratch, { recursive: true, force: true });
	}
	const drift = diffFacts(fixture.localEndpoint, observed);
	const counterpartRevision = fixture.counterpart.sourceRevision;
	return {
		ok: drift.length === 0,
		fixture: { file: path.relative(REPO_ROOT, fixturePath), counterpartRevision },
		archive: { ...archive, revisionMatchesFixture: archive.sourceRevision === counterpartRevision },
		runtimePort: 'not-in-archive',
		probe: { node: process.version, module: ENDPOINT_MODULE },
		observed,
		drift,
	};
}

export function main(argv = process.argv.slice(2)) {
	const options = {
		'contracts-dir': { type: 'string' },
		'expect-sha256': { type: 'string' },
		fixture: { type: 'string', default: DEFAULT_FIXTURE },
		'allow-dirty-source': { type: 'boolean', default: false },
	};
	let args;
	try {
		args = parseArgs({ args: argv, strict: true, options }).values;
	} catch (error) {
		fail('usage', error.message);
	}
	for (const name of ['contracts-dir', 'expect-sha256']) {
		if (!args[name]) fail('usage', `--${name} is required (no artifact is selected implicitly)`);
	}
	return checkContractVectors({
		contractsDir: args['contracts-dir'],
		expectedSha256: args['expect-sha256'].toLowerCase(),
		fixturePath: args.fixture,
		allowDirtySource: args['allow-dirty-source'],
	});
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	try {
		const report = main();
		console.log(JSON.stringify(report, null, 2));
		process.exit(report.ok ? 0 : 1);
	} catch (error) {
		if (!(error instanceof CheckError) && !(error instanceof ImportError)) throw error;
		console.error(`check-mega-contract-vectors refused (${error.code}): ${error.message}`);
		process.exit(2);
	}
}
