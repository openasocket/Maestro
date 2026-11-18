#!/usr/bin/env node
/**
 * Package the actor approval bridge (MAESTRO-ACTOR-BRIDGE) as one immutable,
 * content-addressed archive the Mega-Maestro actor-policy pair can load.
 *
 *   node scripts/package-mega-maestro-actor-bridge.mjs --contracts <contracts.tgz>
 *        [--out dist/mega-maestro-actor-bridge] [--allow-dirty] [--json]
 *
 * `--contracts` names the public contracts archive the bridge is built against
 * (for example `../mega-maestro/artifacts/enterprise/0.4.0/<sha256>/contracts.tgz`).
 * Nothing is selected implicitly. The archive, its `artifact.json` and its
 * `.sha256` sidecar are verified with the importer's own `verifyArtifact()`,
 * and the verified record must equal the committed pin
 * (`vendor/mega-maestro/contracts.pin.json`) field for field, including
 * `acceptedEndpointProtocols`, which must be exactly `[2]` (decision D4). The
 * installed `vendor/mega-maestro/contracts` tree must be that same payload.
 *
 * `scripts/mega-maestro-pair.mjs` and its literal dynamic imports are bundled
 * by esbuild as an ESM graph. The archive holds the compiled scripts, the pin
 * at `contracts/contracts.pin.json`, the exhaustive esbuild input map
 * (`source/actor-inputs.json`), the implementation-tree map
 * (`source/implementation.json`) and `manifest.json`. It is a deterministic
 * ustar stream (the runtime packager's `buildTar()`, the implementation
 * commit's time) gzipped at level 9, written read-only to
 * `<out>/1/<sha256>/actor-bridge.tgz` beside `artifact.json` and the sidecar.
 * A dirty implementation tree is refused unless `--allow-dirty` is passed, and
 * such an archive is recorded with `certifiable: false`.
 *
 * The archive carries no authority, lease or policy grant and claims no
 * paired, provider or native qualification. The contracts payload itself is
 * not inside it: a consumer places the verified contracts archive and its
 * exact dependency closure at `vendor/mega-maestro/contracts` beneath the
 * extraction root, and the enclosed pin at `vendor/mega-maestro/contracts.pin.json`.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import {
	REPO_ROOT,
	buildTar,
	findCanaries,
	implementationSnapshot,
} from './package-mega-maestro-runtime.mjs';
import { digestOf } from './write-mega-maestro-handoff.mjs';
import {
	ACCEPTED_ENDPOINT_PROTOCOLS,
	DEFAULT_PIN_FILE,
	pinFromRecord,
	readPin,
	verifyArtifact,
} from './import-mega-maestro.mjs';
import { inspectContractsDir } from './check-mega-contract-vectors.mjs';

export const ARTIFACT_FORMAT_VERSION = 1;
export const ARTIFACT_KIND = 'maestro-actor-bridge-consumer';
export const ARCHIVE_NAME = 'actor-bridge.tgz';
export const DEFAULT_OUT_DIR = 'dist/mega-maestro-actor-bridge';
export const ENTRY = 'scripts/mega-maestro-pair.mjs';
export const TESTED_EXPORTS = Object.freeze([
	'createActorApprovalBridge',
	'watchForChallenge',
	'inspectProducers',
]);
const CONTRACTS_DIR = 'vendor/mega-maestro/contracts';

export class ActorBridgePackageRefusal extends Error {
	constructor(code, message) {
		super(message);
		this.name = 'ActorBridgePackageRefusal';
		this.code = code;
	}
}
const refuse = (code, message) => {
	throw new ActorBridgePackageRefusal(code, message);
};
const hash = (bytes, algorithm = 'sha256') => createHash(algorithm).update(bytes).digest('hex');

/** The contracts archive at `archivePath`, verified and proven to be the committed pin. */
export function verifyPinnedContracts(
	archivePath,
	pinFile = path.join(REPO_ROOT, DEFAULT_PIN_FILE)
) {
	const pin = readPin(pinFile);
	if (!pin) refuse('pin-missing', `${DEFAULT_PIN_FILE} is absent`);
	if (
		!isDeepStrictEqual(ACCEPTED_ENDPOINT_PROTOCOLS, [2]) ||
		!isDeepStrictEqual(pin.endpointProtocols, [2]) ||
		!isDeepStrictEqual(pin.acceptedEndpointProtocols, [2])
	)
		refuse('pin-protocol', 'the pin and the importer must accept endpoint protocol 2 only');
	if (pin.sourceDirty !== false)
		refuse('pin-dirty', 'the pinned contracts were built from a dirty tree');
	const record = verifyArtifact({
		manifestPath: path.join(path.dirname(archivePath), 'artifact.json'),
		archivePath,
		expectedSha256: hash(fs.readFileSync(archivePath)),
	});
	if (!isDeepStrictEqual(pinFromRecord(record), pin))
		refuse('pin-mismatch', `${archivePath} is not the contracts archive ${DEFAULT_PIN_FILE} names`);
	const installed = inspectContractsDir({
		contractsDir: path.join(REPO_ROOT, CONTRACTS_DIR),
		expectedSha256: pin.payloadDigest,
	});
	if (installed.sourceRevision !== pin.sourceRevision)
		refuse('installed-contracts', `${CONTRACTS_DIR} is not the pinned payload`);
	const zod = JSON.parse(
		fs.readFileSync(path.join(REPO_ROOT, CONTRACTS_DIR, 'node_modules/zod/package.json'), 'utf8')
	);
	if (
		!isDeepStrictEqual(Object.keys(pin.dependencies ?? {}), ['zod']) ||
		zod.version !== pin.dependencies.zod
	)
		refuse('installed-contracts', `${CONTRACTS_DIR}/node_modules/zod is not the pinned closure`);
	return { pin, pinBytes: fs.readFileSync(pinFile) };
}

export async function packageActorBridge(options) {
	if (!options?.contracts)
		refuse('usage', '--contracts is required (no archive is selected implicitly)');
	const contractsArchive = path.resolve(options.contracts);
	const outDir = path.resolve(REPO_ROOT, options.out ?? DEFAULT_OUT_DIR);
	const snapshot = implementationSnapshot();
	if (snapshot.dirty && !options.allowDirty)
		refuse('dirty', `${snapshot.dirtyEntries} implementation file(s) differ from HEAD`);
	if (snapshot.deleted)
		refuse('deleted', `${snapshot.deleted} tracked implementation file(s) are absent`);
	const { pin, pinBytes } = verifyPinnedContracts(contractsArchive);

	const esbuild = await import('esbuild');
	const scratch = fs.mkdtempSync(path.join(outDir, '.build-'));
	try {
		const result = await esbuild.build({
			absWorkingDir: REPO_ROOT,
			entryPoints: [ENTRY],
			outdir: path.join(scratch, 'scripts'),
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
		const inputSha256 = Object.fromEntries(
			Object.keys(result.metafile.inputs)
				.sort()
				.map((file) => [file, hash(fs.readFileSync(path.join(REPO_ROOT, file)))])
		);
		const entries = Object.keys(result.metafile.outputs)
			.sort()
			.map((file) => ({
				path: path.relative(scratch, path.join(REPO_ROOT, file)).split(path.sep).join('/'),
				data: fs.readFileSync(path.join(REPO_ROOT, file)),
			}));
		entries.push({ path: 'contracts/contracts.pin.json', data: pinBytes });
		entries.push({
			path: 'source/actor-inputs.json',
			data: Buffer.from(JSON.stringify({ inputSha256, metafile: result.metafile }, null, 2)),
		});
		entries.push({
			path: 'source/implementation.json',
			data: Buffer.from(JSON.stringify(snapshot, null, 2)),
		});
		const manifest = {
			schemaVersion: ARTIFACT_FORMAT_VERSION,
			kind: ARTIFACT_KIND,
			proofClass: 'implementation-input',
			implementationRevision: snapshot.commit,
			implementationDigest: snapshot.digest,
			certifiable: !snapshot.dirty,
			inputDigest: digestOf(inputSha256),
			entry: ENTRY,
			qualifiedExports: [],
			testedExports: [...TESTED_EXPORTS],
			grants: { authority: 'none', lease: 'none', policy: 'none' },
			qualification: { paired: false, provider: false, native: false },
			dependencies: {
				contracts: pin,
				placement:
					'Install the verified public contracts and their exact dependency closure at vendor/mega-maestro/contracts and the enclosed pin at vendor/mega-maestro/contracts.pin.json beneath the extraction root.',
				node: process.version,
				optionalTooling: { esbuild: esbuild.version },
				scope:
					'Only browser approval consumer and challenge handoff exports are verified. Full pair commands require their separately qualified runtime, endpoint, browser, container and tooling inputs.',
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
		const directory = path.join(outDir, String(ARTIFACT_FORMAT_VERSION), sha256);
		const archiveFile = path.join(directory, ARCHIVE_NAME);
		if (fs.existsSync(archiveFile)) {
			assert.equal(hash(fs.readFileSync(archiveFile)), sha256, 'existing archive differs');
		} else {
			fs.mkdirSync(directory, { recursive: true });
			fs.writeFileSync(archiveFile, archive, { mode: 0o444 });
			fs.writeFileSync(`${archiveFile}.sha256`, `${sha256}  ${ARCHIVE_NAME}\n`, { mode: 0o444 });
			fs.writeFileSync(path.join(directory, 'artifact.json'), manifestBytes, { mode: 0o444 });
		}
		const rel = (file) => path.relative(REPO_ROOT, file).split(path.sep).join('/');
		return {
			directory: rel(directory),
			archive: rel(archiveFile),
			sha256,
			sha512: hash(archive, 'sha512'),
			bytes: archive.length,
			sidecarSha256: hash(fs.readFileSync(`${archiveFile}.sha256`)),
			manifestSha256: hash(fs.readFileSync(path.join(directory, 'artifact.json'))),
			payloadFiles: entries.length - 1,
			payloadDigest: digestOf(manifest.payloadSha256),
			inputFiles: Object.keys(inputSha256).length,
			implementationRevision: snapshot.commit,
			implementationDigest: snapshot.digest,
			implementationFiles: snapshot.fileCount,
			certifiable: !snapshot.dirty,
			contracts: {
				path: rel(contractsArchive),
				sha256: pin.sha256,
				integrity: pin.integrity,
				version: pin.version,
				acceptedEndpointProtocols: pin.acceptedEndpointProtocols,
				pinSha256: hash(pinBytes),
			},
		};
	} finally {
		fs.rmSync(scratch, { recursive: true, force: true });
	}
}

export async function main(argv = process.argv.slice(2)) {
	const { values } = parseArgs({
		args: argv,
		strict: true,
		options: {
			contracts: { type: 'string' },
			out: { type: 'string', default: DEFAULT_OUT_DIR },
			'allow-dirty': { type: 'boolean', default: false },
			json: { type: 'boolean', default: false },
		},
	});
	fs.mkdirSync(path.resolve(REPO_ROOT, values.out), { recursive: true });
	return packageActorBridge({
		contracts: values.contracts,
		out: values.out,
		allowDirty: values['allow-dirty'],
	});
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	try {
		console.log(JSON.stringify(await main(), null, 2));
	} catch (error) {
		if (!(error instanceof ActorBridgePackageRefusal) && error?.name !== 'ImportError') throw error;
		console.error(`package-mega-maestro-actor-bridge refused (${error.code}): ${error.message}`);
		process.exit(2);
	}
}
