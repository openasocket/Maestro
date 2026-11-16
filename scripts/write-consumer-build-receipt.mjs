#!/usr/bin/env node
/**
 * Write a Maestro consumer BUILD receipt (`maestro-build-receipt/1`) for a pinned
 * `@mega-maestro/contracts` archive, by RE-RUNNING the checks MCOMP-00-03 recorded
 * in `Plans/integration-completion/evidence/contract-inputs-build.json`:
 *
 *   snapshot           the committed implementation tree, clean (taken first and last)
 *   importer           scripts/import-mega-maestro.mjs --verify-only on the given archive
 *   integrity          the archive, the pin and the extracted package agree byte for byte
 *   schemas            every runtime export of the extracted package loads; the declared
 *                      local protocols are the ones the protocol module parses
 *   public-types       tsc --strict over every public module of the extracted package
 *   public-vectors     scripts/check-mega-contract-vectors.mjs against the pin's payload digest
 *   exact-dependency-vectors  the endpoint vectors again, under --permission, with the
 *                      package's own installed dependency
 *   focused-tests      vitest over the contract, vector, conformance and client suites
 *   typecheck          npm run lint
 *
 *   node scripts/write-consumer-build-receipt.mjs --name <name> --manifest <artifact.json>
 *     --archive <contracts.tgz> --sha256 <hex> [--producer-receipt <file>]
 *     [--live-observation <observation.json>]
 *     [--artifact-id ID] [--task ID] [--test <file>]... [--out-dir DIR | --out FILE.json]
 *     [--work-dir DIR]
 *
 * It writes `<out-dir>/<name>-build.json` (default out-dir
 * `Plans/integration-completion/evidence`), or exactly `--out`, only when every check ran and exited 0,
 * and every field in it comes from a check that ran or a file it hashed. A field the
 * build cannot observe (the runtime's accepted endpoint protocols on live traffic,
 * grant and chain digests, workflow owner identity, negotiated workflow execution)
 * is left out and named under `notYetObserved`, unless `--live-observation` names
 * a passing observation printed by `scripts/live-execution-check.mjs` on a live
 * endpoint from the pinned runtime archive (`liveObservationOf` checks it); then
 * those fields are recorded from it and `liveNegotiationPerformed` is true. It never overwrites a receipt: an
 * existing output file is a refusal. Logs and the input map go to `--work-dir`
 * (default `.maestro/playbooks/Working/receipts/<name>`), named by sha256.
 *
 * Exit: 0 written, 1 a check failed or the output exists (nothing written), 2 usage.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import {
	ACCEPTED_ENDPOINT_PROTOCOLS,
	ACCEPTED_PACKAGE_VERSIONS,
	DEFAULT_OUT_DIR as CONTRACTS_DIR,
	DEFAULT_PIN_FILE,
	pinFromRecord,
	readPin,
	verifyArtifact,
} from './import-mega-maestro.mjs';
import {
	PROBE_SOURCE,
	diffFacts,
	readFixture,
	DEFAULT_FIXTURE,
} from './check-mega-contract-vectors.mjs';
import { implementationSnapshot } from './package-mega-maestro-runtime.mjs';
import { digestOf } from './write-mega-maestro-handoff.mjs';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const RECEIPT_SCHEMA = 'maestro-build-receipt/1';
export const DEFAULT_EVIDENCE_DIR = 'Plans/integration-completion/evidence';
export const SELF = 'scripts/write-consumer-build-receipt.mjs';
/** The MCOMP-00-03 focused suites. Suites that read a receipt cannot be among them. */
export const DEFAULT_FOCUSED_TESTS = Object.freeze([
	'src/__tests__/integration/mega-maestro/conformance.test.ts',
	'src/__tests__/shared/maestro-lib/managed/contracts.test.ts',
	'src/__tests__/shared/maestro-lib/managed/contract-vectors.test.ts',
	'src/__tests__/shared/maestro-lib/managed/endpoint-client.test.ts',
]);
/** The suite that observes what the production composition sends (handoff items 1-3, 9). */
export const RUNTIME_WIRE_TEST = 'src/__tests__/integration/mega-maestro/runtime-wire.test.ts';
/** The observation a live run of scripts/live-execution-check.mjs prints. */
export const LIVE_OBSERVATION_SCHEMA = 'maestro-live-execution-observation/1';
/** The notYetObserved fields a passing live observation answers. */
export const LIVE_FIELDS = Object.freeze([
	'liveEndpointProtocols',
	'grantDigest',
	'chainDigest',
	'workflowOwner',
	'negotiatedWorkflowExecution',
]);
/** The packaged runtime the receipt names; its library version must be this tree's. */
export const RUNTIME_PIN_FILE = 'Plans/integration-completion/runtime-conformance.json';
/** Sources whose bytes the receipt names because the checks read them. */
export const TESTED_SOURCES = Object.freeze([
	'scripts/import-mega-maestro.mjs',
	'scripts/check-mega-contract-vectors.mjs',
	'scripts/write-mega-maestro-handoff.mjs',
	'scripts/package-mega-maestro-runtime.mjs',
	SELF,
	'src/__tests__/integration/mega-maestro/conformance-host.ts',
	'src/__tests__/integration/mega-maestro/fixtures.ts',
	'src/__tests__/main/enterprise/fakeEndpoint.ts',
	DEFAULT_FIXTURE,
	'src/shared/maestro-lib/managed/endpoint-client.ts',
	'src/shared/maestro-lib/managed/endpoint-port.ts',
	'src/shared/maestro-lib/managed/host-adapter.ts',
	'package.json',
	'package-lock.json',
	'vitest.config.mts',
	DEFAULT_PIN_FILE,
	RUNTIME_WIRE_TEST,
	RUNTIME_PIN_FILE,
	'src/__tests__/main/enterprise/workflowProducer.ts',
	'src/main/enterprise/service.ts',
	'src/main/enterprise/enrollment.ts',
	'src/shared/maestro-lib/managed/workflow-lifecycle.ts',
	'src/shared/maestro-lib/version.ts',
	'src/shared/maestro-lib/managed/execution.ts',
	'src/shared/maestro-lib/managed/live-execution-check.ts',
	'scripts/live-execution-check.mjs',
]);
/** What Mega's final consumer receipt needs that no build check can see yet. */
export const NOT_YET_OBSERVED = Object.freeze([
	{
		field: 'liveEndpointProtocols',
		reason:
			'runtimeWire records the protocols this runtime sends to the test double; traffic with a live endpoint is not observed by a build',
	},
	{
		field: 'grantDigest',
		reason:
			'no execution grant is issued: the v2 workflow claim carries grants [] and execution waits for FINISH-10 (GCOMP-15-07)',
	},
	{
		field: 'chainDigest',
		reason: 'no delegation chain exists: the v2 workflow claim carries delegation null',
	},
	{
		field: 'workflowOwner',
		reason:
			'runtimeWire names the owner the test double issued for the claim; no live endpoint issued an owner',
	},
	{
		field: 'negotiatedWorkflowExecution',
		reason:
			'execution is not in the v2 operation set until FINISH-10 (GCOMP-15-07); an execution is not offered on the v2 connection',
	},
]);

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fileSha = (file) => sha256(fs.readFileSync(path.resolve(REPO_ROOT, file)));
const readJson = (file) => JSON.parse(fs.readFileSync(path.resolve(REPO_ROOT, file), 'utf8'));
const rel = (file) => path.relative(REPO_ROOT, path.resolve(file)).split(path.sep).join('/');

// ---------------------------------------------------------------------------
// In-process checks, each run in its own child (`--check <name>`), JSON on stdout
// ---------------------------------------------------------------------------

/** The package's runtime modules, as the extracted package.json exports them. */
function runtimeExports(dir) {
	const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
	return Object.entries(pkg.exports)
		.map(([name, target]) => [name, typeof target === 'string' ? null : target.import])
		.filter(([, target]) => typeof target === 'string');
}

export const IN_PROCESS_CHECKS = {
	snapshot() {
		const snapshot = implementationSnapshot();
		assert.equal(
			snapshot.dirty,
			false,
			`the implementation tree has ${snapshot.dirtyEntries} changes`
		);
		assert.equal(snapshot.deleted, 0, 'tracked implementation files are deleted');
		const head = execFileSync('git', ['-C', REPO_ROOT, 'rev-parse', 'HEAD'], {
			encoding: 'utf8',
		}).trim();
		return {
			commit: snapshot.commit,
			head,
			digest: snapshot.digest,
			fileCount: snapshot.fileCount,
			rules: snapshot.rules.id,
			files: snapshot.files,
		};
	},
	integrity({ manifest, archive, sha256: expected }) {
		const record = verifyArtifact({
			manifestPath: manifest,
			archivePath: archive,
			expectedSha256: expected,
		});
		const pin = readPin(path.resolve(REPO_ROOT, DEFAULT_PIN_FILE));
		assert.deepEqual(pin, pinFromRecord(record), 'the pin is not this archive');
		const dir = path.resolve(REPO_ROOT, CONTRACTS_DIR);
		const files = record.entries.filter((entry) => entry.type === 'file');
		for (const entry of files) {
			assert.deepEqual(
				fs.readFileSync(path.join(dir, entry.path.slice('package/'.length))),
				entry.data,
				entry.path
			);
		}
		// The installed closure is exactly the archive's dependencies, each at its exact
		// version and with no dependencies of its own. A lock file is read when the
		// install left one (it is gitignored, so a fresh import may not have one).
		const lockFile = path.join(dir, 'package-lock.json');
		const lock = fs.existsSync(lockFile) ? JSON.parse(fs.readFileSync(lockFile, 'utf8')) : null;
		if (lock) {
			assert.deepEqual(lock.packages[''].dependencies ?? {}, record.dependencies, 'lock root');
		}
		const modulesDir = path.join(dir, 'node_modules');
		const present = fs.existsSync(modulesDir)
			? fs.readdirSync(modulesDir).filter((entry) => !entry.startsWith('.'))
			: [];
		assert.deepEqual(present.sort(), Object.keys(record.dependencies).sort(), 'installed packages');
		const installed = {};
		for (const [name, version] of Object.entries(record.dependencies)) {
			const pkg = JSON.parse(fs.readFileSync(path.join(modulesDir, name, 'package.json'), 'utf8'));
			assert.equal(pkg.version, version, `installed ${name}`);
			assert.deepEqual(Object.keys(pkg.dependencies ?? {}), [], `${name} has dependencies`);
			if (lock)
				assert.equal(lock.packages[`node_modules/${name}`]?.version, version, `locked ${name}`);
			installed[name] = {
				version,
				packageJsonSha256: fileSha(path.join(CONTRACTS_DIR, 'node_modules', name, 'package.json')),
				...(lock ? { integrity: lock.packages[`node_modules/${name}`].integrity ?? null } : {}),
			};
		}
		return {
			name: record.name,
			version: record.version,
			sha256: record.sha256,
			integrity: record.integrity,
			sourceRevision: record.sourceRevision,
			sourceDirty: record.sourceDirty,
			implementationRevision: record.implementationRevision,
			inputDigest: record.inputDigest,
			payloadFiles: record.payloadFiles,
			payloadDigest: record.payloadDigest,
			contractSchemas: record.contractSchemas,
			endpointProtocols: record.endpointProtocols,
			acceptedEndpointProtocols: record.acceptedEndpointProtocols,
			extractedFiles: files.length,
			dependencies: record.dependencies,
			installed,
			...(lock
				? {
						lockSha256: fileSha(path.join(CONTRACTS_DIR, 'package-lock.json')),
						lockPackages: Object.keys(lock.packages).sort(),
					}
				: {}),
		};
	},
	async schemas() {
		const dir = path.resolve(REPO_ROOT, CONTRACTS_DIR);
		const modules = {};
		for (const [name, target] of runtimeExports(dir)) {
			modules[name] = Object.keys(await import(pathToFileURL(path.join(dir, target)).href)).sort();
			assert.ok(modules[name].length > 0, `${name} exports nothing`);
		}
		const protocol = await import(pathToFileURL(path.join(dir, 'dist/protocol.js')).href);
		// 0.4.0 is v2 only, so the version schema is one literal (2) rather than a union of them.
		const version = protocol.localProtocolVersion;
		const parsed = (version.options ?? [version]).flatMap((schema) => [...schema.values]);
		const declared = readPin(path.resolve(REPO_ROOT, DEFAULT_PIN_FILE)).contractSchemas
			.localProtocols;
		assert.deepEqual(parsed, declared, 'declared local protocols are not the parsed ones');
		const v2Operations = Object.keys(protocol.localEndpointContractsV2 ?? {}).sort();
		return {
			modulesLoaded: Object.keys(modules).length,
			localProtocols: parsed,
			v2Operations,
			modules,
		};
	},
	runtimePin() {
		const pin = readJson(RUNTIME_PIN_FILE);
		const version = /MAESTRO_LIB_VERSION = '([^']+)'/.exec(
			fs.readFileSync(path.resolve(REPO_ROOT, 'src/shared/maestro-lib/version.ts'), 'utf8')
		)?.[1];
		assert.equal(
			pin.runtime.versions.library,
			version,
			'the pinned runtime is not built from this library version'
		);
		const dir = path.resolve(REPO_ROOT, pin.runtime.location.directory);
		const archive = path.join(dir, pin.runtime.archive.file);
		assert.ok(fs.existsSync(archive), `the pinned runtime archive ${rel(archive)} is absent`);
		assert.equal(sha256(fs.readFileSync(archive)), pin.runtime.archive.sha256, 'runtime archive');
		return {
			artifactId: pin.runtime.artifactId,
			archive: { path: rel(archive), ...pin.runtime.archive },
			manifestSha256: pin.runtime.manifestSha256,
			payloadDigest: pin.runtime.payloadDigest,
			versions: pin.runtime.versions,
			implementation: pin.runtime.implementation,
			pin: { path: RUNTIME_PIN_FILE, sha256: fileSha(RUNTIME_PIN_FILE) },
		};
	},
	exactDependencyVectors() {
		const cwd = path.resolve(REPO_ROOT, CONTRACTS_DIR);
		const { NODE_OPTIONS: _ignored, ...env } = process.env;
		const child = spawnSync(
			process.execPath,
			[
				'--permission',
				'--disallow-code-generation-from-strings',
				`--allow-fs-read=${cwd}`,
				'--input-type=module',
				'--eval',
				PROBE_SOURCE,
			],
			{ cwd, env, encoding: 'utf8' }
		);
		assert.equal(child.status, 0, child.stderr);
		const observed = JSON.parse(child.stdout);
		const drift = diffFacts(readFixture(DEFAULT_FIXTURE).localEndpoint, observed);
		assert.deepEqual(drift, [], 'the installed dependency changes a recorded vector');
		return { exitCode: child.status, drift, observed };
	},
};

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/** A public-types source that imports every runtime module of the extracted package. */
function publicTypesSource(workDir) {
	const dir = path.resolve(REPO_ROOT, CONTRACTS_DIR);
	return runtimeExports(dir)
		.map(([, target], i) => {
			const spec = path.relative(workDir, path.join(dir, target)).split(path.sep).join('/');
			return `import * as m${i} from ${JSON.stringify(spec.startsWith('.') ? spec : `./${spec}`)}; void m${i};`;
		})
		.join('\n');
}

/** Run one check as a child process; its log is kept under the work dir and named by digest. */
function runCheck(workDir, name, command, args, options = {}) {
	const started = Date.now();
	const child = spawnSync(command, args, {
		cwd: REPO_ROOT,
		encoding: 'utf8',
		maxBuffer: 64 * 1024 * 1024,
		env: {
			...process.env,
			PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`,
		},
		...options,
	});
	const log = path.join(workDir, `${name}.log`);
	fs.writeFileSync(
		log,
		`${child.stdout ?? ''}${child.stderr ?? ''}${child.error ? String(child.error) : ''}`
	);
	const exitCode = child.status ?? 1;
	const display = [command === process.execPath ? 'node' : command, ...args].join(' ');
	process.stderr.write(
		`${exitCode === 0 ? 'ok  ' : 'FAIL'} ${name} (${Date.now() - started} ms)\n`
	);
	return {
		name,
		command: display,
		exitCode,
		evidence: { path: rel(log), sha256: fileSha(log) },
		stdout: child.stdout ?? '',
	};
}

const selfCheck = (workDir, name, check, args) =>
	runCheck(workDir, name, process.execPath, [SELF, '--check', check, ...args]);

const json = (result) => JSON.parse(result.stdout);

/** Every check, in order; the first failure stops the run and nothing is written. */
export function runChecks({ manifest, archive, sha256: expected, tests, workDir }) {
	const ran = [];
	const step = (result) => {
		ran.push(result);
		if (result.exitCode !== 0)
			throw Object.assign(
				new Error(
					`check ${result.name} failed (exit ${result.exitCode}); see ${result.evidence.path}`
				),
				{ ran }
			);
		return result;
	};
	const artifact = ['--manifest', manifest, '--archive', archive, '--sha256', expected];
	const before = json(step(selfCheck(workDir, 'snapshot-before', 'snapshot', [])));
	step(
		runCheck(workDir, 'importer', process.execPath, [
			'scripts/import-mega-maestro.mjs',
			...artifact,
			'--verify-only',
		])
	);
	const integrity = json(step(selfCheck(workDir, 'integrity', 'integrity', artifact)));
	const schemas = json(step(selfCheck(workDir, 'schemas', 'schemas', [])));
	const typesFile = path.join(workDir, 'public-types.mts');
	fs.writeFileSync(typesFile, `${publicTypesSource(workDir)}\n`);
	step(
		runCheck(workDir, 'public-types', process.execPath, [
			'node_modules/typescript/bin/tsc',
			'--ignoreConfig',
			'--noEmit',
			'--strict',
			'--module',
			'NodeNext',
			'--moduleResolution',
			'NodeNext',
			'--target',
			'ES2022',
			rel(typesFile),
		])
	);
	step(
		runCheck(workDir, 'public-vectors', process.execPath, [
			'scripts/check-mega-contract-vectors.mjs',
			'--contracts-dir',
			CONTRACTS_DIR,
			'--expect-sha256',
			integrity.payloadDigest,
		])
	);
	const vectors = json(
		step(selfCheck(workDir, 'exact-dependency-vectors', 'exactDependencyVectors', []))
	);
	const resultsFile = path.join(workDir, 'focused-results.json');
	const focused = step(
		runCheck(workDir, 'focused-tests', process.execPath, [
			'node_modules/vitest/vitest.mjs',
			'run',
			...tests,
			'--reporter=default',
			'--reporter=json',
			`--outputFile=${rel(resultsFile)}`,
		])
	);
	const results = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
	if (
		results.numFailedTests !== 0 ||
		results.numPassedTests === 0 ||
		results.numTotalTestSuites === 0
	) {
		step({ ...focused, name: 'focused-tests-counted', exitCode: 1 });
	}
	const wireFile = path.join(workDir, 'runtime-wire.json');
	fs.rmSync(wireFile, { force: true });
	step(
		runCheck(
			workDir,
			'runtime-wire',
			process.execPath,
			['node_modules/vitest/vitest.mjs', 'run', RUNTIME_WIRE_TEST],
			{
				env: {
					...process.env,
					PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`,
					MAESTRO_WIRE_OBSERVATION: wireFile,
				},
			}
		)
	);
	if (!fs.existsSync(wireFile)) step({ ...ran.at(-1), name: 'runtime-wire-observed', exitCode: 1 });
	const wire = JSON.parse(fs.readFileSync(wireFile, 'utf8'));
	const runtime = json(step(selfCheck(workDir, 'runtime-pin', 'runtimePin', [])));
	step(runCheck(workDir, 'typecheck', 'npm', ['run', 'lint']));
	const after = json(step(selfCheck(workDir, 'snapshot-after', 'snapshot', [])));
	if (after.digest !== before.digest || after.head !== before.head) {
		step({ ...ran.at(-1), name: 'snapshot-unchanged', exitCode: 1 });
	}
	return {
		ran,
		snapshot: after,
		integrity,
		schemas,
		vectors,
		results,
		resultsFile,
		typesFile,
		wire,
		wireFile,
		runtime,
	};
}

function testCounts(results, resultsFile) {
	const suites = {};
	for (const file of results.testResults) {
		const key = rel(file.name);
		suites[key] = file.assertionResults.filter((a) => a.status === 'passed').length;
	}
	return {
		files: results.testResults.length,
		passed: results.numPassedTests,
		failed: results.numFailedTests,
		skipped: results.numPendingTests + (results.numTodoTests ?? 0),
		suites,
		result: { path: rel(resultsFile), sha256: fileSha(resultsFile) },
	};
}

function producerReceiptOf(file, expected) {
	if (!file) return undefined;
	const text = fs.readFileSync(file, 'utf8');
	const receipt = JSON.parse(text);
	if (!text.includes(`"${expected}"`))
		throw new Error(`the producer receipt ${file} does not name ${expected}`);
	return {
		path: path.resolve(file),
		sha256: sha256(Buffer.from(text)),
		artifactId: receipt.artifactId ?? null,
		status: receipt.status ?? null,
		implementationRevision: receipt.implementationRevision ?? null,
		inputDigest: receipt.inputDigest ?? null,
	};
}

/**
 * A live observation, checked against what this run pinned: it passed, it
 * negotiated with a live endpoint on Linux, it ran from the pinned runtime
 * archive built from this library version against the pinned contracts, and
 * it carries every live field. Anything else refuses the receipt.
 */
export function liveObservationOf(file, { runtime, integrity }) {
	if (!file) return undefined;
	const text = fs.readFileSync(file, 'utf8');
	const o = JSON.parse(text);
	const problems = [];
	const need = (ok, problem) => {
		if (!ok) problems.push(problem);
	};
	need(o.schema === LIVE_OBSERVATION_SCHEMA, `schema is not ${LIVE_OBSERVATION_SCHEMA}`);
	need(
		o.outcome === 'passed',
		`outcome is ${o.outcome}${o.failure ? ` at ${o.failure.step}` : ''}`
	);
	need(o.liveNegotiationPerformed === true, 'no live negotiation was performed');
	need(o.host?.platform === 'linux', 'the check did not run on Linux');
	need(
		o.runtime?.archive?.sha256 === runtime.archive.sha256,
		'it did not run the pinned runtime archive'
	);
	need(
		o.runtime?.library === runtime.versions.library,
		'its library is not the pinned runtime library'
	);
	need(o.runtime?.endpointProtocol === 2, 'its runtime endpoint protocol is not 2');
	need(
		o.runtime?.contracts?.sha256 === integrity.sha256,
		'its runtime was not built against these contracts'
	);
	need(
		JSON.stringify(o.liveEndpointProtocols) === '[2]',
		'the live endpoint protocols are not [2]'
	);
	need(o.negotiatedWorkflowExecution === true, 'workflow execution was not negotiated');
	need(/^[a-f0-9]{64}$/.test(o.grantDigest ?? ''), 'no grant digest was observed');
	need(Array.isArray(o.chain) && o.chain.length > 0, 'no delegation chain was observed');
	need(/^[a-f0-9]{64}$/.test(o.chainDigest?.value ?? ''), 'no chain digest was observed');
	need(typeof o.workflowOwner?.ownerId === 'string', 'no workflow owner was observed');
	need(o.execution?.receipt?.outcome === 'broker_dispatched', 'no dispatch receipt was observed');
	need(o.settlement?.outcome === 'recorded', 'the settlement was not recorded');
	if (problems.length > 0)
		throw new Error(`the live observation ${file} is refused: ${problems.join('; ')}`);
	return {
		observation: { path: path.resolve(file), sha256: sha256(Buffer.from(text)) },
		driver: o.driver,
		host: o.host,
		endpoint: o.endpoint,
		runtime: o.runtime,
		startedAt: o.startedAt,
		finishedAt: o.finishedAt,
		liveEndpointProtocols: o.liveEndpointProtocols,
		compatibility: o.compatibility,
		attachment: o.attachment,
		negotiated: o.negotiated,
		negotiatedWorkflowExecution: o.negotiatedWorkflowExecution,
		registration: o.registration,
		workflowOwner: o.workflowOwner,
		lease: o.lease,
		grant: o.grant,
		grantDigest: o.grantDigest,
		chain: o.chain,
		chainDigest: o.chainDigest,
		execution: o.execution,
		settlement: o.settlement,
		release: o.release,
		steps: o.steps,
	};
}

/** The receipt, from what the checks observed. Pure over its inputs. */
export function buildReceipt({ args, run, recordedAt }) {
	const { snapshot, integrity, schemas, results, resultsFile, typesFile, wire, wireFile, runtime } =
		run;
	const { files: implementationFiles, ...tree } = snapshot;
	const toolchain = {
		node: process.version,
		platform: process.platform,
		arch: process.arch,
		nodeExecutable: process.execPath,
		nodeSha256: sha256(fs.readFileSync(process.execPath)),
		packages: Object.fromEntries(
			['typescript', 'vitest', 'vite', 'prettier', 'zod'].map((p) => [
				p,
				readJson(`node_modules/${p}/package.json`).version,
			])
		),
	};
	const testedSourceSha256 = Object.fromEntries(
		[...TESTED_SOURCES, ...args.tests].map((file) => [file, fileSha(file)])
	);
	const inputs = {
		implementation: implementationFiles,
		testedSourceSha256,
		importedPin: fileSha(DEFAULT_PIN_FILE),
		archiveSha256: integrity.sha256,
		toolchain,
	};
	const inputMap = path.join(args.workDir, 'input-map.json');
	fs.writeFileSync(inputMap, `${JSON.stringify({ schemaVersion: 1, inputs }, null, '\t')}\n`);
	const sidecar = `${args.archive}.sha256`;
	const producerReceipt = producerReceiptOf(args.producerReceipt, integrity.sha256);
	const live = liveObservationOf(args.liveObservation, { runtime, integrity });
	return {
		schemaVersion: 1,
		schema: RECEIPT_SCHEMA,
		artifactId: args.artifactId,
		owner: 'maestro',
		proofClass: 'implementation-input',
		status: 'published',
		...(args.task ? { task: args.task } : {}),
		recordedAt,
		writer: { path: SELF, sha256: fileSha(SELF) },
		standing: live
			? 'Verified, compiled public contract inputs and locally tested Maestro consumers, re-checked by the receipt writer, with the wire traffic of the production composition observed against a test double, and one live delegated claim, execution and settlement run from the pinned runtime archive against a live endpoint (live). It qualifies no external adapter.'
			: 'Verified, compiled public contract inputs and locally tested Maestro consumers, re-checked by the receipt writer, with the wire traffic of the production composition observed against a test double and the packaged runtime of this library version named. This receipt performs no live negotiation and qualifies no external adapter.',
		grants: { authority: 'none', lease: 'none', policy: 'none' },
		qualification: { paired: false, provider: false, native: false },
		implementationRevision: tree.commit,
		observedRevision: tree.head,
		sourceClean: true,
		inputDigest: digestOf(inputs),
		snapshot: {
			sourceRules: tree.rules,
			implementationDigest: tree.digest,
			implementationFiles: tree.fileCount,
			implementationDirty: false,
			inputMap: { path: rel(inputMap), sha256: fileSha(inputMap) },
			inputDigestEncoding: 'sha256(canonicalJson(inputs))',
		},
		testedSourceSha256,
		archive: {
			name: integrity.name,
			version: integrity.version,
			path: path.resolve(args.archive),
			sha256: integrity.sha256,
			integrity: integrity.integrity,
			manifest: {
				path: path.resolve(args.manifest),
				sha256: sha256(fs.readFileSync(args.manifest)),
			},
			...(fs.existsSync(sidecar)
				? { sidecar: { path: path.resolve(sidecar), sha256: sha256(fs.readFileSync(sidecar)) } }
				: {}),
			sourceRevision: integrity.sourceRevision,
			sourceDirty: integrity.sourceDirty,
			implementationRevision: integrity.implementationRevision,
			inputDigest: integrity.inputDigest,
			payloadFiles: integrity.payloadFiles,
			importerPayloadDigest: integrity.payloadDigest,
			pin: { path: DEFAULT_PIN_FILE, sha256: fileSha(DEFAULT_PIN_FILE) },
			extractedPackage: CONTRACTS_DIR,
			extractedFiles: integrity.extractedFiles,
		},
		...(producerReceipt ? { producerReceipt } : {}),
		acceptedEndpointProtocols: wire.acceptedEndpointProtocols,
		...(live
			? {
					liveEndpointProtocols: live.liveEndpointProtocols,
					grantDigest: live.grantDigest,
					chainDigest: live.chainDigest,
					workflowOwner: live.workflowOwner,
					negotiatedWorkflowExecution: live.negotiatedWorkflowExecution,
					live,
				}
			: {}),
		runtime,
		runtimeWire: {
			...wire,
			observation: { path: rel(wireFile), sha256: fileSha(wireFile) },
			standing:
				'What this runtime sends, parsed by the pinned contract. The endpoint, owner and epoch are the test double, not a live endpoint or paired enforcement.',
		},
		dependencyClosure: {
			direct: integrity.dependencies,
			installed: integrity.installed,
			...(integrity.lockSha256
				? {
						installedLock: {
							path: `${CONTRACTS_DIR}/package-lock.json`,
							sha256: integrity.lockSha256,
							packages: integrity.lockPackages,
						},
					}
				: {}),
		},
		versions: {
			acceptedPackageRange: ACCEPTED_PACKAGE_VERSIONS,
			acceptedConsumerEndpointProtocols: integrity.acceptedEndpointProtocols,
			importerAcceptedEndpointProtocols: [...ACCEPTED_ENDPOINT_PROTOCOLS],
			declaredEndpointProtocols: integrity.endpointProtocols,
			published: integrity.contractSchemas,
			parsedLocalProtocols: schemas.localProtocols,
			v2Operations: schemas.v2Operations,
			runtimeModulesLoaded: schemas.modulesLoaded,
			liveNegotiationPerformed: Boolean(live),
		},
		tests: {
			...testCounts(results, resultsFile),
			publicTypes: { path: rel(typesFile), sha256: fileSha(typesFile) },
		},
		toolchain,
		checks: run.ran.map(({ stdout: _stdout, ...check }) => check),
		notYetObserved: live
			? NOT_YET_OBSERVED.filter((entry) => !LIVE_FIELDS.includes(entry.field))
			: NOT_YET_OBSERVED,
		publicationScope: live
			? 'Local source-development input. acceptedEndpointProtocols and runtimeWire are what the runtime sends to a test double; the live fields come from the observation under live, one run against a live endpoint.'
			: 'Local source-development input only. acceptedEndpointProtocols and runtimeWire are what the runtime sends to a test double; fields that need a live endpoint or an execution grant are named under notYetObserved and are not recorded.',
	};
}

export function parse(argv) {
	const { values } = parseArgs({
		args: argv,
		options: {
			name: { type: 'string' },
			manifest: { type: 'string' },
			archive: { type: 'string' },
			sha256: { type: 'string' },
			'producer-receipt': { type: 'string' },
			'live-observation': { type: 'string' },
			'artifact-id': { type: 'string', default: 'MAESTRO-CONTRACT-INPUTS-BUILD' },
			task: { type: 'string' },
			test: { type: 'string', multiple: true },
			'out-dir': { type: 'string', default: DEFAULT_EVIDENCE_DIR },
			out: { type: 'string' },
			'work-dir': { type: 'string' },
		},
		strict: true,
	});
	for (const key of ['name', 'manifest', 'archive', 'sha256'])
		if (!values[key]) throw new Error(`--${key} is required`);
	if (!/^[a-z0-9][a-z0-9.-]{0,79}$/.test(values.name))
		throw new Error('--name is lowercase letters, digits, dots and dashes');
	if (values.out && !values.out.endsWith('.json')) throw new Error('--out names a .json file');
	if (!/^[a-f0-9]{64}$/.test(values.sha256))
		throw new Error('--sha256 is 64 lowercase hex characters');
	return {
		name: values.name,
		manifest: path.resolve(values.manifest),
		archive: path.resolve(values.archive),
		sha256: values.sha256,
		producerReceipt: values['producer-receipt']
			? path.resolve(values['producer-receipt'])
			: undefined,
		liveObservation: values['live-observation']
			? path.resolve(values['live-observation'])
			: undefined,
		artifactId: values['artifact-id'],
		task: values.task,
		tests: values.test?.length ? values.test : [...DEFAULT_FOCUSED_TESTS],
		output: values.out
			? path.resolve(REPO_ROOT, values.out)
			: path.resolve(REPO_ROOT, values['out-dir'], `${values.name}-build.json`),
		workDir: path.resolve(
			REPO_ROOT,
			values['work-dir'] ?? `.maestro/playbooks/Working/receipts/${values.name}`
		),
	};
}

export async function main(argv = process.argv.slice(2)) {
	const checkAt = argv.indexOf('--check');
	if (checkAt === 0) {
		const name = argv[1];
		const rest = parseArgs({
			args: argv.slice(2),
			options: {
				manifest: { type: 'string' },
				archive: { type: 'string' },
				sha256: { type: 'string' },
			},
		}).values;
		const check = IN_PROCESS_CHECKS[name];
		if (!check) throw new Error(`no check named ${name}`);
		process.stdout.write(`${JSON.stringify(await check(rest), null, '\t')}\n`);
		return 0;
	}
	let args;
	try {
		args = parse(argv);
	} catch (error) {
		process.stderr.write(`${error.message}\n`);
		return 2;
	}
	if (fs.existsSync(args.output)) {
		process.stderr.write(`refused: ${rel(args.output)} exists; a receipt is never rewritten\n`);
		return 1;
	}
	fs.mkdirSync(args.workDir, { recursive: true });
	let run;
	try {
		run = runChecks(args);
	} catch (error) {
		process.stderr.write(`refused: ${error.message}; nothing was written\n`);
		return 1;
	}
	const receipt = buildReceipt({ args, run, recordedAt: new Date().toISOString() });
	fs.writeFileSync(args.output, `${JSON.stringify(receipt, null, '\t')}\n`, { flag: 'wx' });
	process.stderr.write(`wrote ${rel(args.output)} (${fileSha(args.output)})\n`);
	return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	process.exitCode = await main();
}
