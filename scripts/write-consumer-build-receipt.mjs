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
 *     [--artifact-id ID] [--task ID] [--test <file>]... [--out-dir DIR | --out FILE.json]
 *     [--work-dir DIR]
 *
 * It writes `<out-dir>/<name>-build.json` (default out-dir
 * `Plans/integration-completion/evidence`), or exactly `--out`, only when every check ran and exited 0,
 * and every field in it comes from a check that ran or a file it hashed. A field the
 * build cannot observe (the runtime's accepted endpoint protocols on live traffic,
 * grant and chain digests, workflow owner identity, negotiated workflow execution)
 * is left out and named under `notYetObserved`. It never overwrites a receipt: an
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
	'src/__tests__/main/enterprise/endpoint-client.test.ts',
]);
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
	'src/main/enterprise/endpoint-client.ts',
	'src/shared/maestro-lib/managed/endpoint-port.ts',
	'src/shared/maestro-lib/managed/host-adapter.ts',
	'package.json',
	'package-lock.json',
	'vitest.config.mts',
	DEFAULT_PIN_FILE,
]);
/** What Mega's final consumer receipt needs that no build check can see yet. */
export const NOT_YET_OBSERVED = Object.freeze([
	{
		field: 'acceptedEndpointProtocols',
		reason:
			'the protocols the runtime actually speaks are a property of live traffic; no endpoint is contacted by a build',
	},
	{ field: 'grantDigest', reason: 'no execution grant is issued to a build' },
	{ field: 'chainDigest', reason: 'no delegation chain exists without an execution' },
	{ field: 'workflowOwner', reason: 'no workflow is claimed by a build' },
	{
		field: 'negotiatedWorkflowExecution',
		reason: 'execution is not offered by the endpoint (GCOMP-15-07) and no negotiation runs here',
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
		const parsed = protocol.localProtocolVersion.options.map((schema) => [...schema.values][0]);
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
	step(runCheck(workDir, 'typecheck', 'npm', ['run', 'lint']));
	const after = json(step(selfCheck(workDir, 'snapshot-after', 'snapshot', [])));
	if (after.digest !== before.digest || after.head !== before.head) {
		step({ ...ran.at(-1), name: 'snapshot-unchanged', exitCode: 1 });
	}
	return { ran, snapshot: after, integrity, schemas, vectors, results, resultsFile, typesFile };
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

/** The receipt, from what the checks observed. Pure over its inputs. */
export function buildReceipt({ args, run, recordedAt }) {
	const { snapshot, integrity, schemas, results, resultsFile, typesFile } = run;
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
		standing:
			'Verified, compiled public contract inputs and locally tested Maestro consumers, re-checked by the receipt writer. This receipt supplies no service, runtime or native application archive, performs no live negotiation and qualifies no external adapter.',
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
			liveNegotiationPerformed: false,
		},
		tests: {
			...testCounts(results, resultsFile),
			publicTypes: { path: rel(typesFile), sha256: fileSha(typesFile) },
		},
		toolchain,
		checks: run.ran.map(({ stdout: _stdout, ...check }) => check),
		notYetObserved: NOT_YET_OBSERVED,
		publicationScope:
			'Local source-development input only. Fields that need live endpoint traffic, an execution grant or a workflow claim are named under notYetObserved and are not recorded.',
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
