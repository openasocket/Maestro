#!/usr/bin/env node
/**
 * Import one verified Mega-Maestro contracts artifact into this checkout.
 *
 *   node scripts/import-mega-maestro.mjs \
 *     --manifest <artifact.json> --archive <contracts.tgz> --sha256 <hex> \
 *     [--out vendor/mega-maestro/contracts] [--pin-file <json>] \
 *     [--write-pin] [--verify-only] [--allow-dirty-source]
 *
 * Every input is named explicitly: nothing scans a sibling checkout or picks
 * the newest artifact. The archive must hash to `--sha256`, to the manifest's
 * digest, integrity and `.sha256` sidecar; only regular files and directories
 * under `package/` are accepted, within LIMITS; the payload, `provenance.json`
 * and `package.json` must agree with the manifest; package and endpoint
 * protocol versions must be ones Maestro was written against. Nothing in the
 * archive is executed. A digest other than the committed pin is refused unless
 * `--write-pin` replaces the pin on purpose; with no pin, nothing is imported.
 * A dirty-source build is refused unless `--allow-dirty-source`, and stays
 * marked `sourceDirty` in the import record. Extraction lands in a scratch
 * folder and is renamed into place only after every check passed.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import semver from 'semver';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** What this Maestro was written against. Bump deliberately, with the consumer. */
export const EXPECTED_PACKAGE_NAME = '@mega-maestro/contracts';
export const ACCEPTED_PACKAGE_VERSIONS = '>=0.1.0 <0.2.0';
export const ACCEPTED_ENDPOINT_PROTOCOLS = [1];
export const MANIFEST_FORMAT_VERSION = 1;
export const PIN_FORMAT_VERSION = 1;
export const DEFAULT_OUT_DIR = 'vendor/mega-maestro/contracts';
export const DEFAULT_PIN_FILE = 'vendor/mega-maestro/contracts.pin.json';

/** Extraction bounds. A contracts package is a few hundred KB of JS and d.ts. */
export const LIMITS = Object.freeze({
	manifestBytes: 1024 * 1024,
	archiveBytes: 16 * 1024 * 1024,
	unpackedBytes: 48 * 1024 * 1024,
	entries: 256,
	fileBytes: 4 * 1024 * 1024,
	pathLength: 512,
});

export class ImportError extends Error {
	constructor(code, message) {
		super(message);
		this.name = 'ImportError';
		this.code = code;
	}
}
const fail = (code, message) => {
	throw new ImportError(code, message);
};

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const integrityOf = (bytes) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
const isHex = (v, n) => typeof v === 'string' && v.length === n && /^[a-f0-9]+$/.test(v);
const isExactVersion = (v) => /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(String(v));
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const parseJson = (bytes, what) => {
	try {
		return JSON.parse(bytes.toString('utf8'));
	} catch (error) {
		return fail('manifest-format', `${what} is not JSON: ${error.message}`);
	}
};

/** Read a file the caller named, refusing symlinks and anything over `maxBytes`. */
function readBounded(file, maxBytes, what) {
	const stat = fs.lstatSync(file, { throwIfNoEntry: false });
	if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
		fail('missing-input', `${what} is not a regular file: ${file}`);
	}
	if (stat.size > maxBytes) fail('too-large', `${what} is ${stat.size} bytes, over ${maxBytes}`);
	return fs.readFileSync(file);
}

// Tar: a minimal ustar/pax reader. Links, devices and fifos are refusals.

const BLOCK = 512;
const field = (block, offset, length) => {
	const end = block.indexOf(0, offset);
	return block.toString(
		'utf8',
		offset,
		end === -1 || end > offset + length ? offset + length : end
	);
};
const octal = (block, offset, length) => {
	const text = field(block, offset, length).trim();
	if (text !== '' && !/^[0-7]+$/.test(text)) fail('tar-format', `bad numeric field "${text}"`);
	return text === '' ? 0 : parseInt(text, 8);
};

function parsePax(body) {
	const fields = {};
	for (let at = 0; at < body.length; ) {
		const space = body.indexOf(32, at);
		const length = space === -1 ? NaN : Number(body.toString('utf8', at, space));
		if (!Number.isInteger(length) || length <= 0 || at + length > body.length) {
			fail('tar-format', 'malformed pax record');
		}
		const record = body.toString('utf8', space + 1, at + length - 1);
		const eq = record.indexOf('=');
		if (eq === -1) fail('tar-format', 'malformed pax record');
		fields[record.slice(0, eq)] = record.slice(eq + 1);
		at += length;
	}
	return fields;
}

/** A path inside the archive, checked for traversal, absolute roots and odd bytes. */
function checkEntryPath(name) {
	if (typeof name !== 'string' || name.length === 0 || name.length > LIMITS.pathLength) {
		fail('tar-path', 'empty or over-long entry name');
	}
	if (/[\u0000-\u001f\\]/.test(name))
		fail('tar-path', `control character or backslash in "${name}"`);
	if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) fail('tar-path', `absolute entry "${name}"`);
	const parts = name.replace(/\/+$/, '').split('/');
	if (parts.some((p) => p === '' || p === '.' || p === '..'))
		fail('tar-path', `traversal in "${name}"`);
	if (parts[0] !== 'package') fail('tar-path', `entry outside package/: "${name}"`);
	return parts.join('/');
}

/** Read a gzipped ustar/pax archive into memory, within LIMITS, as `{ path, type, data }` entries. */
export function readTarGz(archiveBytes) {
	if (archiveBytes.length > LIMITS.archiveBytes) fail('tar-bounds', 'archive over the size bound');
	let tar;
	try {
		tar = gunzipSync(archiveBytes, { maxOutputLength: LIMITS.unpackedBytes });
	} catch (error) {
		fail(
			error?.code === 'ERR_BUFFER_TOO_LARGE' ? 'tar-bounds' : 'tar-format',
			`not gzip: ${error.message}`
		);
	}
	if (tar.length % BLOCK !== 0) fail('tar-format', 'tar is not block aligned');
	const entries = [];
	const seen = new Set();
	let total = 0;
	let pending = {};
	for (let at = 0; at + BLOCK <= tar.length; ) {
		const block = tar.subarray(at, at + BLOCK);
		at += BLOCK;
		if (block.every((byte) => byte === 0)) break;
		let sum = 0;
		for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : block[i];
		if (sum !== octal(block, 148, 8)) fail('tar-format', 'header checksum mismatch');
		if (!/^ustar ?$/.test(field(block, 257, 6))) fail('tar-format', 'unsupported tar magic');
		const size = pending.size !== undefined ? Number(pending.size) : octal(block, 124, 12);
		if (!Number.isSafeInteger(size) || size < 0) fail('tar-format', 'bad entry size');
		const padded = Math.ceil(size / BLOCK) * BLOCK;
		if (at + padded > tar.length) fail('tar-format', 'truncated entry');
		const body = tar.subarray(at, at + size);
		at += padded;
		const type = String.fromCharCode(block[156] || 48);
		if (type === 'x' || type === 'L') {
			if (size > LIMITS.fileBytes) fail('tar-bounds', 'extended header too large');
			const extra =
				type === 'x' ? parsePax(body) : { path: body.toString('utf8').replace(/\0+$/, '') };
			pending = { ...pending, ...extra };
			continue;
		}
		if (type === 'g') continue;
		const prefix = field(block, 345, 155);
		const name = pending.path ?? (prefix ? `${prefix}/` : '') + field(block, 0, 100);
		pending = {};
		const entryPath = checkEntryPath(name);
		if (type === '5') {
			entries.push({ path: entryPath, type: 'dir', data: Buffer.alloc(0) });
			continue;
		}
		if (type !== '0' && type !== '\0')
			fail('tar-entry-type', `"${entryPath}" has tar type "${type}"`);
		if (size > LIMITS.fileBytes) fail('tar-bounds', `"${entryPath}" over the file size bound`);
		total += size;
		if (total > LIMITS.unpackedBytes) fail('tar-bounds', 'archive over the unpacked bound');
		if (seen.has(entryPath)) fail('tar-path', `duplicate entry "${entryPath}"`);
		seen.add(entryPath);
		entries.push({ path: entryPath, type: 'file', data: Buffer.from(body) });
		if (entries.length > LIMITS.entries) fail('tar-bounds', 'too many entries');
	}
	return entries;
}

const PROVENANCE_KEYS =
	'formatVersion name version sourceRevision sourceDirty inputSha256 payloadSha256 tooling'.split(
		' '
	);

function checkDigestMap(map, what) {
	if (!isObject(map) || Object.keys(map).length === 0) fail('manifest-format', `${what} is empty`);
	for (const [file, digest] of Object.entries(map)) {
		if (!isHex(digest, 64)) fail('manifest-format', `${what}["${file}"] is not sha256`);
		if (file.startsWith('/') || file.split('/').some((p) => p === '..' || p === '')) {
			fail('manifest-format', `${what} names an unsafe path "${file}"`);
		}
	}
}

/** Validate the manifest's shape and the versions Maestro accepts. */
export function checkManifest(m) {
	if (!isObject(m)) fail('manifest-format', 'manifest is not an object');
	if (m.formatVersion !== MANIFEST_FORMAT_VERSION)
		fail('manifest-format', 'unsupported formatVersion');
	if (m.name !== EXPECTED_PACKAGE_NAME)
		fail('manifest-name', `expected ${EXPECTED_PACKAGE_NAME}, got "${m.name}"`);
	if (!isExactVersion(m.version) || !semver.satisfies(m.version, ACCEPTED_PACKAGE_VERSIONS)) {
		fail('manifest-version', `version "${m.version}" is outside ${ACCEPTED_PACKAGE_VERSIONS}`);
	}
	if (!isHex(m.sourceRevision, 40))
		fail('manifest-revision', 'sourceRevision is not a git revision');
	if (typeof m.sourceDirty !== 'boolean') fail('manifest-format', 'sourceDirty must be a boolean');
	checkDigestMap(m.inputSha256, 'inputSha256');
	checkDigestMap(m.payloadSha256, 'payloadSha256');
	if (!isObject(m.tooling) || !isExactVersion(m.tooling.node))
		fail('manifest-format', 'tooling.node');
	if (m.archive !== 'contracts.tgz') fail('manifest-format', `archive must be contracts.tgz`);
	if (!isHex(m.sha256, 64)) fail('manifest-format', 'sha256 is not sha256');
	if (typeof m.integrity !== 'string' || !m.integrity.startsWith('sha512-')) {
		fail('manifest-format', 'integrity must be sha512');
	}
}

function checkPackageJson(pkg, manifest, payloadFiles) {
	if (!isObject(pkg) || pkg.name !== manifest.name || pkg.version !== manifest.version) {
		fail('package-mismatch', 'package.json name/version differ from the manifest');
	}
	if (pkg.type !== 'module' || pkg.private !== true)
		fail('package-mismatch', 'not a private ESM package');
	if (!isObject(pkg.exports) || Object.keys(pkg.exports).length === 0)
		fail('export-shape', 'no exports');
	for (const [subpath, entry] of Object.entries(pkg.exports)) {
		if (subpath === './provenance' && entry === './provenance.json') continue;
		const keys = isObject(entry) ? Object.keys(entry) : [];
		if (
			!subpath.startsWith('./') ||
			keys.length !== 2 ||
			!keys.includes('types') ||
			!keys.includes('import')
		) {
			fail('export-shape', `unexpected export shape at "${subpath}"`);
		}
		for (const [condition, target] of Object.entries(entry)) {
			const ok =
				typeof target === 'string' &&
				target.startsWith('./dist/') &&
				!target.includes('..') &&
				!target.includes('\\') &&
				target.endsWith(condition === 'types' ? '.d.ts' : '.js') &&
				payloadFiles.has(target.slice(2));
			if (!ok) fail('export-shape', `export "${subpath}" ${condition} is not a payload file`);
		}
	}
	for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
		if (!isExactVersion(version))
			fail('dependency-version', `dependency ${name}@${version} is not exact`);
	}
}

/** The endpoint protocols the contracts declare, read from `local-endpoint.d.ts` text, never by loading it. */
export function declaredEndpointProtocols(declarationText) {
	const found = new Set();
	const re = /supportedProtocols:\s*z\.ZodArray<\s*((?:z\.ZodLiteral<\d+>\s*\|?\s*)+)>/g;
	for (const match of declarationText.matchAll(re)) {
		for (const literal of match[1].matchAll(/z\.ZodLiteral<(\d+)>/g)) found.add(Number(literal[1]));
	}
	return [...found].sort((a, b) => a - b);
}

/** Verify a manifest + archive pair against the explicit digest. Reads only; returns the import record. */
export function verifyArtifact({
	manifestPath,
	archivePath,
	expectedSha256,
	allowDirtySource = false,
}) {
	if (!isHex(expectedSha256, 64))
		fail('usage', '--sha256 must be the archive digest as 64 hex characters');
	const manifest = parseJson(
		readBounded(manifestPath, LIMITS.manifestBytes, 'manifest'),
		'manifest'
	);
	checkManifest(manifest);
	if (manifest.sha256 !== expectedSha256)
		fail('archive-digest', 'manifest sha256 differs from --sha256');

	const archiveBytes = readBounded(archivePath, LIMITS.archiveBytes, 'archive');
	const archiveSha256 = sha256(archiveBytes);
	if (archiveSha256 !== expectedSha256)
		fail('archive-digest', `archive hashes to ${archiveSha256}`);
	if (integrityOf(archiveBytes) !== manifest.integrity) fail('archive-integrity', 'sha512 differs');
	const sidecar = `${archivePath}.sha256`;
	if (
		fs.existsSync(sidecar) &&
		fs.readFileSync(sidecar, 'utf8').trim().split(/\s+/)[0] !== expectedSha256
	) {
		fail('sidecar-digest', '.sha256 sidecar differs from the archive digest');
	}

	const entries = readTarGz(archiveBytes);
	const files = new Map(
		entries.filter((e) => e.type === 'file').map((e) => [e.path.slice(8), e.data])
	);
	const payload = new Set(Object.keys(manifest.payloadSha256));
	for (const file of payload) {
		const data = files.get(file);
		if (!data) fail('payload-missing', `payload "${file}" is not in the archive`);
		if (sha256(data) !== manifest.payloadSha256[file]) fail('payload-digest', `"${file}" differs`);
	}
	for (const file of files.keys()) {
		if (file !== 'package.json' && file !== 'provenance.json' && !payload.has(file)) {
			fail('payload-extra', `"${file}" is not in payloadSha256`);
		}
	}
	if (!files.has('package.json') || !files.has('provenance.json')) {
		fail('payload-missing', 'archive lacks package.json or provenance.json');
	}
	const provenance = parseJson(files.get('provenance.json'), 'provenance.json');
	for (const key of PROVENANCE_KEYS) {
		if (JSON.stringify(provenance[key]) !== JSON.stringify(manifest[key])) {
			fail('provenance-mismatch', `provenance.json ${key} differs from the manifest`);
		}
	}
	if (Object.keys(provenance).some((key) => !PROVENANCE_KEYS.includes(key))) {
		fail('provenance-mismatch', 'provenance.json has fields the manifest does not');
	}
	const pkg = parseJson(files.get('package.json'), 'package.json');
	checkPackageJson(pkg, manifest, payload);

	const endpointTypes = files.get('dist/local-endpoint.d.ts');
	if (!endpointTypes) fail('protocol', 'archive has no dist/local-endpoint.d.ts');
	const protocols = declaredEndpointProtocols(endpointTypes.toString('utf8'));
	const accepted = protocols.filter((p) => ACCEPTED_ENDPOINT_PROTOCOLS.includes(p));
	if (accepted.length === 0) {
		fail(
			'protocol',
			`declared endpoint protocols [${protocols}]; Maestro accepts [${ACCEPTED_ENDPOINT_PROTOCOLS}]`
		);
	}
	if (manifest.sourceDirty && !allowDirtySource) {
		fail(
			'dirty-source',
			`built from dirty source at ${manifest.sourceRevision}; --allow-dirty-source imports it as development-only evidence`
		);
	}
	return {
		formatVersion: PIN_FORMAT_VERSION,
		name: manifest.name,
		version: manifest.version,
		sha256: archiveSha256,
		integrity: manifest.integrity,
		sourceRevision: manifest.sourceRevision,
		sourceDirty: manifest.sourceDirty,
		endpointProtocols: protocols,
		acceptedEndpointProtocols: accepted,
		dependencies: pkg.dependencies ?? {},
		tooling: manifest.tooling,
		payloadFiles: payload.size,
		payloadDigest: sha256(JSON.stringify(Object.entries(manifest.payloadSha256).sort())),
		exports: Object.keys(pkg.exports).sort(),
		entries,
	};
}

export function readPin(pinFile) {
	if (!fs.existsSync(pinFile)) return null;
	const pin = parseJson(readBounded(pinFile, LIMITS.manifestBytes, 'pin'), 'pin');
	if (!isObject(pin) || pin.formatVersion !== PIN_FORMAT_VERSION || !isHex(pin.sha256, 64)) {
		fail('pin-format', `${pinFile} is not a format ${PIN_FORMAT_VERSION} pin`);
	}
	return pin;
}

export function pinFromRecord({ entries: _entries, ...pin }) {
	return pin;
}

/** Refuse a digest the pin does not name. `writePin` is the explicit override. */
export function enforcePin(pin, record, writePin) {
	if (writePin) return;
	if (!pin) fail('pin-missing', 'no pin exists; pass --write-pin to pin this digest in a commit');
	if (pin.sha256 !== record.sha256)
		fail('pin-mismatch', `pinned ${pin.sha256}, offered ${record.sha256}`);
}

/** A destination inside this checkout, with no symlink on its path. */
function localDestination(dir) {
	const resolved = path.resolve(REPO_ROOT, dir);
	const rel = path.relative(REPO_ROOT, resolved);
	if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel))
		fail('usage', `${dir} is outside the repository`);
	let current = REPO_ROOT;
	for (const part of rel.split(path.sep)) {
		current = path.join(current, part);
		if (fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink())
			fail('usage', `${current} is a symlink`);
	}
	return resolved;
}

/** Write the verified entries under `outDir`, replacing a previous import atomically. */
export function extractRecord(record, outDir) {
	const destination = localDestination(outDir);
	fs.mkdirSync(path.dirname(destination), { recursive: true });
	const scratch = fs.mkdtempSync(path.join(path.dirname(destination), '.import-'));
	try {
		for (const entry of record.entries) {
			const target = path.join(scratch, entry.path.slice(8));
			fs.mkdirSync(entry.type === 'dir' ? target : path.dirname(target), { recursive: true });
			if (entry.type === 'file') fs.writeFileSync(target, entry.data, { flag: 'wx', mode: 0o644 });
		}
		const record_ = `${JSON.stringify(pinFromRecord(record), null, '\t')}\n`;
		fs.writeFileSync(path.join(scratch, 'IMPORT.json'), record_, { flag: 'wx' });
		const previous = `${destination}.previous-${process.pid}`;
		if (fs.existsSync(destination)) fs.renameSync(destination, previous);
		fs.renameSync(scratch, destination);
		fs.rmSync(previous, { recursive: true, force: true });
	} catch (error) {
		fs.rmSync(scratch, { recursive: true, force: true });
		throw error;
	}
	return destination;
}

export function main(argv = process.argv.slice(2)) {
	let args;
	try {
		args = parseArgs({
			args: argv,
			strict: true,
			options: {
				manifest: { type: 'string' },
				archive: { type: 'string' },
				sha256: { type: 'string' },
				out: { type: 'string', default: DEFAULT_OUT_DIR },
				'pin-file': { type: 'string', default: DEFAULT_PIN_FILE },
				'write-pin': { type: 'boolean', default: false },
				'verify-only': { type: 'boolean', default: false },
				'allow-dirty-source': { type: 'boolean', default: false },
			},
		}).values;
	} catch (error) {
		fail('usage', error.message);
	}
	for (const name of ['manifest', 'archive', 'sha256']) {
		if (!args[name]) fail('usage', `--${name} is required (no artifact is selected implicitly)`);
	}
	const record = verifyArtifact({
		manifestPath: path.resolve(args.manifest),
		archivePath: path.resolve(args.archive),
		expectedSha256: args.sha256.toLowerCase(),
		allowDirtySource: args['allow-dirty-source'],
	});
	const pinFile = path.resolve(REPO_ROOT, args['pin-file']);
	const pin = readPin(pinFile);
	const summary = { ...pinFromRecord(record), pinned: pin?.sha256 ?? null, imported: null };
	if (args['verify-only'])
		return { ...summary, pinMatches: pin ? pin.sha256 === record.sha256 : null };
	enforcePin(pin, record, args['write-pin']);
	summary.imported = extractRecord(record, args.out);
	if (args['write-pin']) {
		localDestination(args['pin-file']);
		fs.mkdirSync(path.dirname(pinFile), { recursive: true });
		fs.writeFileSync(pinFile, `${JSON.stringify(pinFromRecord(record), null, '\t')}\n`);
		summary.pinned = record.sha256;
	}
	return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	try {
		console.log(JSON.stringify(main(), null, 2));
	} catch (error) {
		if (!(error instanceof ImportError)) throw error;
		console.error(`import-mega-maestro refused (${error.code}): ${error.message}`);
		process.exit(2);
	}
}
