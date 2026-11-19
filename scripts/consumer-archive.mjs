/**
 * Shared packaging for a Maestro consumer BUILD: one focused module set, bundled
 * by esbuild, verified against the committed contracts pin, packaged as one
 * immutable content-addressed archive, and recorded in a BUILD receipt. The
 * three consumer packagers (workflow, collection, commands) are thin wrappers
 * over `runConsumerCli()`, so they cannot drift apart.
 *
 * Steps, in order, and every one refuses rather than guessing:
 *   1. The implementation tree is clean (no tracked edit, no deletion) unless
 *      --allow-dirty, which records `certifiable: false`.
 *   2. `--contracts` is the public contracts archive. It is verified exactly as
 *      the actor bridge packager verifies it: the importer's own check, equal to
 *      the committed pin, endpoint protocol 2 only, and the installed payload.
 *   3. `--tests` is a vitest JSON report of the consumer's unit suites. It must
 *      cover exactly the suites the descriptor names, with zero failures.
 *   4. The entry modules are bundled with esbuild. The bundle is imported in this
 *      process and every tested export must exist.
 *   5. The archive (bundle, pin, input map, implementation map, manifest) is
 *      written read-only under <out>/1/<sha256>/ beside artifact.json and the
 *      .sha256 sidecar.
 *   6. `--receipt` is a NEW file. It is never overwritten.
 *
 * The consumer modules are Maestro's own transcriptions of the endpoint contract
 * shapes. They do not import @mega-maestro/contracts at runtime, so the 0.4.0
 * link is the verified pin, the bundle's tested exports and the suites above,
 * not a runtime schema import. The receipt says so.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import {
	REPO_ROOT,
	buildTar,
	findCanaries,
	implementationSnapshot,
} from './package-mega-maestro-runtime.mjs';
import { digestOf } from './write-mega-maestro-handoff.mjs';
import { verifyPinnedContracts } from './package-mega-maestro-actor-bridge.mjs';

export const CONSUMER_ARCHIVE_FORMAT_VERSION = 1;
export const RECEIPT_SCHEMA = 'maestro-consumer-build/1';

export class ConsumerPackageRefusal extends Error {
	constructor(code, message) {
		super(message);
		this.name = 'ConsumerPackageRefusal';
		this.code = code;
	}
}
const refuse = (code, message) => {
	throw new ConsumerPackageRefusal(code, message);
};
const hash = (bytes, algorithm = 'sha256') => createHash(algorithm).update(bytes).digest('hex');
const rel = (file) => path.relative(REPO_ROOT, file).split(path.sep).join('/');

/**
 * Read a vitest JSON report and prove it covers exactly the descriptor's suites
 * with no failure. Returns the counts that go into the receipt.
 */
export function summarizeSuites(reportFile, suites) {
	let report;
	try {
		report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
	} catch (error) {
		refuse('tests', `the test report ${reportFile} is not readable JSON: ${error.message}`);
	}
	const byFile = new Map();
	for (const file of report.testResults ?? []) {
		const name = rel(file.name);
		const counts = { passed: 0, failed: 0, skipped: 0 };
		for (const test of file.assertionResults ?? []) {
			if (test.status === 'passed') counts.passed += 1;
			else if (test.status === 'failed') counts.failed += 1;
			else counts.skipped += 1;
		}
		byFile.set(name, counts);
	}
	const missing = suites.filter((suite) => !byFile.has(suite));
	const extra = [...byFile.keys()].filter((name) => !suites.includes(name));
	if (missing.length) refuse('tests', `the report has no result for ${missing.join(', ')}`);
	if (extra.length)
		refuse('tests', `the report covers suites the descriptor does not name: ${extra.join(', ')}`);
	const perSuite = suites.map((suite) => ({ file: suite, ...byFile.get(suite) }));
	const totals = perSuite.reduce(
		(sum, s) => ({
			passed: sum.passed + s.passed,
			failed: sum.failed + s.failed,
			skipped: sum.skipped + s.skipped,
		}),
		{ passed: 0, failed: 0, skipped: 0 }
	);
	if (report.success !== true || totals.failed !== 0)
		refuse('tests', `${totals.failed} test(s) failed in the report`);
	if (totals.passed === 0) refuse('tests', 'the report holds no passing test');
	return { suites: perSuite, totals, reportSha256: hash(fs.readFileSync(reportFile)) };
}

/**
 * Package one consumer. `descriptor` is one of the three consumer modules'
 * exported CONSUMER objects. Returns the archive record and the receipt object.
 */
export async function packageConsumer(descriptor, options) {
	if (!options?.contracts)
		refuse('usage', '--contracts is required (no archive is selected implicitly)');
	if (!options?.tests) refuse('usage', '--tests is required: the vitest JSON report of the suites');
	if (!options?.receipt) refuse('usage', '--receipt is required: a new receipt path');
	const receiptFile = path.resolve(REPO_ROOT, options.receipt);
	if (fs.existsSync(receiptFile))
		refuse('receipt-exists', `${rel(receiptFile)} exists; a receipt is never overwritten`);
	const contractsArchive = path.resolve(options.contracts);
	const outDir = path.resolve(REPO_ROOT, options.out ?? descriptor.outDir);

	const snapshot = implementationSnapshot();
	if (snapshot.dirty && !options.allowDirty)
		refuse('dirty', `${snapshot.dirtyEntries} implementation file(s) differ from HEAD`);
	if (snapshot.deleted)
		refuse('deleted', `${snapshot.deleted} tracked implementation file(s) are absent`);

	const { pin, pinBytes } = verifyPinnedContracts(contractsArchive);
	const tests = summarizeSuites(path.resolve(REPO_ROOT, options.tests), descriptor.suites);

	const esbuild = await import('esbuild');
	// A fixed build folder: its name enters the esbuild metafile, which the archive carries.
	const scratch = path.join(outDir, '.build');
	fs.rmSync(scratch, { recursive: true, force: true });
	try {
		const bundleDir = path.join(scratch, 'bundle');
		const result = await esbuild.build({
			absWorkingDir: REPO_ROOT,
			entryPoints: descriptor.entries,
			outdir: bundleDir,
			bundle: true,
			splitting: true,
			platform: 'node',
			format: 'esm',
			target: 'node22',
			outExtension: { '.js': '.mjs' },
			external: ['esbuild'],
			metafile: true,
			logLevel: 'silent',
		});

		// Every tested export must be present on one of the bundled entry modules.
		const loaded = {};
		for (const output of Object.keys(result.metafile.outputs)) {
			const file = path.join(REPO_ROOT, output);
			if (!file.startsWith(bundleDir) || !file.endsWith('.mjs')) continue;
			const name = path.basename(file);
			if (name.startsWith('chunk-')) continue;
			loaded[name] = await import(pathToFileURL(file).href);
		}
		const exportKinds = {};
		const missing = [];
		for (const name of descriptor.testedExports) {
			const holder = Object.values(loaded).find((mod) => mod[name] !== undefined);
			if (!holder) missing.push(name);
			else exportKinds[name] = typeof holder[name];
		}
		if (missing.length) refuse('exports', `the bundle does not export ${missing.join(', ')}`);

		const inputSha256 = Object.fromEntries(
			Object.keys(result.metafile.inputs)
				.sort()
				.map((file) => [file, hash(fs.readFileSync(path.join(REPO_ROOT, file)))])
		);
		const bundleEntries = Object.keys(result.metafile.outputs)
			.sort()
			.map((file) => ({
				path: path.relative(scratch, path.join(REPO_ROOT, file)).split(path.sep).join('/'),
				data: fs.readFileSync(path.join(REPO_ROOT, file)),
			}));
		const entries = [
			...bundleEntries,
			{ path: 'contracts/contracts.pin.json', data: pinBytes },
			{
				path: 'source/inputs.json',
				data: Buffer.from(JSON.stringify({ inputSha256, metafile: result.metafile }, null, 2)),
			},
			{ path: 'source/implementation.json', data: Buffer.from(JSON.stringify(snapshot, null, 2)) },
		];
		const manifest = {
			schemaVersion: CONSUMER_ARCHIVE_FORMAT_VERSION,
			kind: descriptor.kind,
			artifactId: descriptor.artifactId,
			proofClass: 'implementation-input',
			implementationRevision: snapshot.commit,
			implementationDigest: snapshot.digest,
			certifiable: !snapshot.dirty,
			inputDigest: digestOf(inputSha256),
			entries: descriptor.entries,
			qualifiedExports: [],
			testedExports: [...descriptor.testedExports],
			exportKinds,
			grants: { authority: 'none', lease: 'none', policy: 'none' },
			qualification: { paired: false, provider: false, native: false },
			dependencies: {
				contracts: pin,
				node: process.version,
				optionalTooling: { esbuild: esbuild.version },
				scope: descriptor.scope,
			},
			payloadSha256: Object.fromEntries(entries.map((entry) => [entry.path, hash(entry.data)])),
		};
		const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2));
		entries.push({ path: 'manifest.json', data: manifestBytes });
		for (const entry of entries) {
			const canaries = findCanaries(entry.data.toString());
			if (canaries.length) refuse('canary', `${entry.path} names a private path`);
		}

		const mtime = Math.floor(Date.parse(snapshot.committedAt) / 1000);
		const archive = gzipSync(buildTar(entries, mtime), { level: 9 });
		const sha256 = hash(archive);
		const directory = path.join(outDir, String(CONSUMER_ARCHIVE_FORMAT_VERSION), sha256);
		const archiveFile = path.join(directory, descriptor.archiveName);
		if (fs.existsSync(archiveFile)) {
			if (hash(fs.readFileSync(archiveFile)) !== sha256)
				refuse('archive', 'the existing archive differs');
		} else {
			fs.mkdirSync(directory, { recursive: true });
			fs.writeFileSync(archiveFile, archive, { mode: 0o444 });
			fs.writeFileSync(`${archiveFile}.sha256`, `${sha256}  ${descriptor.archiveName}\n`, {
				mode: 0o444,
			});
			fs.writeFileSync(path.join(directory, 'artifact.json'), manifestBytes, { mode: 0o444 });
		}
		const sidecarFile = `${archiveFile}.sha256`;
		const manifestFile = path.join(directory, 'artifact.json');

		const receipt = {
			schemaVersion: 1,
			schema: RECEIPT_SCHEMA,
			artifactId: descriptor.artifactId,
			owner: 'maestro',
			proofClass: 'implementation-input',
			status: snapshot.dirty ? 'local-dirty-consumer-build' : 'complete-local-consumer-build',
			recordedAt: new Date().toISOString(),
			standing: descriptor.standing,
			grants: { authority: 'none', lease: 'none', policy: 'none' },
			qualification: { paired: false, provider: false, native: false },
			implementationRevision: snapshot.commit,
			implementationDigest: snapshot.digest,
			sourceClean: !snapshot.dirty,
			contracts: {
				version: pin.version,
				path: `artifacts/enterprise/${pin.version}/${pin.sha256}/contracts.tgz`,
				sha256: pin.sha256,
				integrity: pin.integrity,
				pinSha256: hash(pinBytes),
				acceptedEndpointProtocols: pin.acceptedEndpointProtocols,
			},
			archives: {
				publicContracts: {
					path: `artifacts/enterprise/${pin.version}/${pin.sha256}/contracts.tgz`,
					sha256: pin.sha256,
				},
				consumer: {
					path: rel(archiveFile),
					sha256,
					sha512: hash(archive, 'sha512'),
					bytes: archive.length,
					sidecarSha256: hash(fs.readFileSync(sidecarFile)),
					manifestSha256: hash(fs.readFileSync(manifestFile)),
					payloadFiles: entries.length - 1,
					payloadDigest: digestOf(manifest.payloadSha256),
					inputFiles: Object.keys(inputSha256).length,
				},
			},
			entries: descriptor.entries,
			exports: { tested: [...descriptor.testedExports], kinds: exportKinds },
			tests: {
				suites: tests.suites.map((s) => ({
					file: s.file,
					passed: s.passed,
					failed: s.failed,
					skipped: s.skipped,
				})),
				passed: tests.totals.passed,
				failed: tests.totals.failed,
				skipped: tests.totals.skipped,
				results: { path: options.tests, sha256: tests.reportSha256 },
			},
			scope: descriptor.scope,
			limitations: [
				'Local typed-port and fixture tests only. No paired, provider, native or live endpoint qualification.',
				'The consumer modules mirror the endpoint contract shapes in Maestro; they do not import @mega-maestro/contracts at runtime.',
				...descriptor.limitations,
			],
		};
		fs.mkdirSync(path.dirname(receiptFile), { recursive: true });
		fs.writeFileSync(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
		return {
			directory: rel(directory),
			archive: rel(archiveFile),
			sha256,
			receipt: rel(receiptFile),
			receiptSha256: hash(fs.readFileSync(receiptFile)),
			implementationRevision: snapshot.commit,
			passed: tests.totals.passed,
			failed: tests.totals.failed,
			suites: tests.suites.length,
		};
	} finally {
		fs.rmSync(scratch, { recursive: true, force: true });
	}
}

/** The CLI for one consumer. Exit 2 on a refusal, with its reason. */
export async function runConsumerCli(descriptor, argv = process.argv.slice(2)) {
	const { values } = parseArgs({
		args: argv,
		strict: true,
		options: {
			contracts: { type: 'string' },
			tests: { type: 'string' },
			receipt: { type: 'string' },
			out: { type: 'string' },
			'allow-dirty': { type: 'boolean', default: false },
		},
	});
	try {
		console.log(
			JSON.stringify(
				await packageConsumer(descriptor, {
					contracts: values.contracts,
					tests: values.tests,
					receipt: values.receipt,
					out: values.out,
					allowDirty: values['allow-dirty'],
				}),
				null,
				2
			)
		);
	} catch (error) {
		if (!(error instanceof ConsumerPackageRefusal) && error?.name !== 'ActorBridgePackageRefusal')
			throw error;
		console.error(`${descriptor.artifactId} packager refused (${error.code}): ${error.message}`);
		process.exit(2);
	}
}
