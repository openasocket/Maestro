#!/usr/bin/env node
/**
 * Package one Maestro consumer contract BUILD (MAESTRO-DESKTOP-CONTRACT-BUILD
 * or MAESTRO-PROVIDER-CONTRACT-BUILD) as one immutable, content-addressed
 * archive, built against a named public contracts archive.
 *
 *   node scripts/package-mega-maestro-contract-build.mjs --artifact desktop|provider
 *        --contracts <contracts.tgz> [--out <dir>] [--allow-dirty]
 *
 * `--contracts` names the public contracts archive (for example
 * `../mega-maestro/artifacts/enterprise/0.4.0/<sha256>/contracts.tgz`); nothing
 * is selected implicitly. It is verified exactly as the actor bridge packager
 * verifies it (`verifyPinnedContracts()`): the importer's `verifyArtifact()`,
 * equality with the committed pin, endpoint protocol 2 only (decision D4), and
 * the installed `vendor/mega-maestro/contracts` payload and zod closure.
 *
 * The artifact's module (`src/shared/maestro-lib/managed/desktop-contract.ts`
 * or `provider-contract.ts`) is bundled by esbuild into one ESM file, and the
 * bundle is imported by this Node process to prove every tested export is
 * present before anything is written. The archive holds that bundle, the pin
 * at `contracts/contracts.pin.json`, the exhaustive esbuild input map
 * (`source/inputs.json`), the implementation-tree map
 * (`source/implementation.json`) and `manifest.json`, as a deterministic ustar
 * stream (the runtime packager's `buildTar()`, the implementation commit's
 * time) gzipped at level 9 and written read-only to
 * `<out>/1/<sha256>/<name>.tgz` beside `artifact.json` and the sidecar. A dirty
 * implementation tree is refused unless `--allow-dirty` is passed, and such an
 * archive is recorded with `certifiable: false`.
 *
 * The archive carries no authority, lease or policy grant and claims no
 * paired, provider or native qualification. The modules take the contracts'
 * schemas through an injected port, so the contracts payload is not bundled.
 */
import assert from 'node:assert/strict';
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

export const ARTIFACT_FORMAT_VERSION = 1;

/** Each contract BUILD this packager produces, by its `--artifact` name. */
export const CONTRACT_BUILDS = Object.freeze({
	desktop: Object.freeze({
		artifactId: 'MAESTRO-DESKTOP-CONTRACT-BUILD',
		kind: 'maestro-desktop-contract-consumer',
		entry: 'src/shared/maestro-lib/managed/desktop-contract.ts',
		bundle: 'library/desktop-contract.mjs',
		archiveName: 'desktop-contract.tgz',
		outDir: 'dist/mega-maestro-desktop-contract',
		testedExports: Object.freeze(['mapDesktopPolicy']),
		scope:
			'The public desktop policy projection (desktopPolicy schema 1) mapped onto existing settings and host types. The schema is injected through DesktopPolicySchemaPort; no policy authority is held.',
	}),
	provider: Object.freeze({
		artifactId: 'MAESTRO-PROVIDER-CONTRACT-BUILD',
		kind: 'maestro-provider-contract-consumer',
		entry: 'src/shared/maestro-lib/managed/provider-contract.ts',
		bundle: 'library/provider-contract.mjs',
		archiveName: 'provider-contract.tgz',
		outDir: 'dist/mega-maestro-provider-contract',
		testedExports: Object.freeze([
			'PROVIDER_HOST_CONTRACT_VERSION',
			'PROVIDER_CONFORMANCE_LIMITS',
			'providerTransportForRoute',
			'providerCallProblems',
			'providerResourceProblems',
		]),
		scope:
			'Bounded provider effect, transport, peer, process and resource ports. No provider implementation or availability is inferred.',
	}),
});

export class ContractBuildPackageRefusal extends Error {
	constructor(code, message) {
		super(message);
		this.name = 'ContractBuildPackageRefusal';
		this.code = code;
	}
}
const refuse = (code, message) => {
	throw new ContractBuildPackageRefusal(code, message);
};
const hash = (bytes, algorithm = 'sha256') => createHash(algorithm).update(bytes).digest('hex');
const rel = (file) => path.relative(REPO_ROOT, file).split(path.sep).join('/');

export async function packageContractBuild(options) {
	const build = CONTRACT_BUILDS[options?.artifact];
	if (!build)
		refuse('usage', `--artifact must be one of ${Object.keys(CONTRACT_BUILDS).join(', ')}`);
	if (!options.contracts)
		refuse('usage', '--contracts is required (no archive is selected implicitly)');
	const contractsArchive = path.resolve(options.contracts);
	const outDir = path.resolve(REPO_ROOT, options.out ?? build.outDir);
	const snapshot = implementationSnapshot();
	if (snapshot.dirty && !options.allowDirty)
		refuse('dirty', `${snapshot.dirtyEntries} implementation file(s) differ from HEAD`);
	if (snapshot.deleted)
		refuse('deleted', `${snapshot.deleted} tracked implementation file(s) are absent`);
	const { pin, pinBytes } = verifyPinnedContracts(contractsArchive);

	const esbuild = await import('esbuild');
	// A fixed build folder: its name enters the esbuild metafile, which the archive carries.
	const scratch = path.join(outDir, '.build');
	fs.rmSync(scratch, { recursive: true, force: true });
	try {
		const bundleFile = path.join(scratch, build.bundle);
		const result = await esbuild.build({
			absWorkingDir: REPO_ROOT,
			entryPoints: [build.entry],
			outfile: bundleFile,
			bundle: true,
			platform: 'node',
			format: 'esm',
			target: 'node22',
			metafile: true,
			logLevel: 'silent',
		});
		const loaded = await import(pathToFileURL(bundleFile).href);
		const missing = build.testedExports.filter((name) => loaded[name] === undefined);
		if (missing.length) refuse('exports', `the bundle does not export ${missing.join(', ')}`);
		const exportKinds = Object.fromEntries(
			build.testedExports.map((name) => [name, typeof loaded[name]])
		);
		const inputSha256 = Object.fromEntries(
			Object.keys(result.metafile.inputs)
				.sort()
				.map((file) => [file, hash(fs.readFileSync(path.join(REPO_ROOT, file)))])
		);
		const entries = [
			{ path: build.bundle, data: fs.readFileSync(bundleFile) },
			{ path: 'contracts/contracts.pin.json', data: pinBytes },
			{
				path: 'source/inputs.json',
				data: Buffer.from(JSON.stringify({ inputSha256, metafile: result.metafile }, null, 2)),
			},
			{ path: 'source/implementation.json', data: Buffer.from(JSON.stringify(snapshot, null, 2)) },
		];
		const manifest = {
			schemaVersion: ARTIFACT_FORMAT_VERSION,
			kind: build.kind,
			artifactId: build.artifactId,
			proofClass: 'implementation-input',
			implementationRevision: snapshot.commit,
			implementationDigest: snapshot.digest,
			certifiable: !snapshot.dirty,
			inputDigest: digestOf(inputSha256),
			source: build.entry,
			entry: build.bundle,
			qualifiedExports: [],
			testedExports: [...build.testedExports],
			exportKinds,
			grants: { authority: 'none', lease: 'none', policy: 'none' },
			qualification: { paired: false, provider: false, native: false },
			dependencies: {
				contracts: pin,
				node: process.version,
				optionalTooling: { esbuild: esbuild.version },
				scope: build.scope,
			},
			payloadSha256: Object.fromEntries(entries.map((entry) => [entry.path, hash(entry.data)])),
		};
		const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2));
		entries.push({ path: 'manifest.json', data: manifestBytes });
		for (const entry of entries) {
			if (findCanaries(entry.data.toString()).length)
				refuse('canary', `${entry.path} names a private path`);
		}
		const mtime = Math.floor(Date.parse(snapshot.committedAt) / 1000);
		const archive = gzipSync(buildTar(entries, mtime), { level: 9 });
		const sha256 = hash(archive);
		const directory = path.join(outDir, String(ARTIFACT_FORMAT_VERSION), sha256);
		const archiveFile = path.join(directory, build.archiveName);
		if (fs.existsSync(archiveFile)) {
			assert.equal(hash(fs.readFileSync(archiveFile)), sha256, 'existing archive differs');
		} else {
			fs.mkdirSync(directory, { recursive: true });
			fs.writeFileSync(archiveFile, archive, { mode: 0o444 });
			fs.writeFileSync(`${archiveFile}.sha256`, `${sha256}  ${build.archiveName}\n`, {
				mode: 0o444,
			});
			fs.writeFileSync(path.join(directory, 'artifact.json'), manifestBytes, { mode: 0o444 });
		}
		return {
			artifactId: build.artifactId,
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
			inputDigest: manifest.inputDigest,
			testedExports: [...build.testedExports],
			exportKinds,
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
			artifact: { type: 'string' },
			contracts: { type: 'string' },
			out: { type: 'string' },
			'allow-dirty': { type: 'boolean', default: false },
		},
	});
	return packageContractBuild({
		artifact: values.artifact,
		contracts: values.contracts,
		out: values.out,
		allowDirty: values['allow-dirty'],
	});
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	try {
		console.log(JSON.stringify(await main(), null, 2));
	} catch (error) {
		if (!(error instanceof ContractBuildPackageRefusal) && error?.name !== 'ImportError')
			throw error;
		console.error(`package-mega-maestro-contract-build refused (${error.code}): ${error.message}`);
		process.exit(2);
	}
}
