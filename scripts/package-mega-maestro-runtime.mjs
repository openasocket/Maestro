#!/usr/bin/env node
/**
 * Package the built public Maestro runtime as one immutable, content-addressed
 * archive a Mega-Maestro operator can pin: the library another tool builds on
 * (`dist/maestro-lib`, with its own provenance), the CP-01 contracts pin when
 * one is committed, the acceptance expectations the integration run was held
 * to, and the capability matrix the packaged library itself reports.
 *
 *   node scripts/package-mega-maestro-runtime.mjs [--library dist/maestro-lib]
 *        [--out dist/mega-maestro-runtime] [--pin <contracts.pin.json>]
 *        [--plan <execution-plan.json>] [--allow-dirty] [--allow-stale] [--json]
 *
 * The payload is exactly the files the library build hashed: a file the
 * provenance does not list, or one whose digest moved, refuses the package.
 * The capability matrix is read by loading the BUILT bundle in this plain Node
 * process, so it describes the artifact, not the TypeScript beside it; the
 * "tested" column is copied from the structured evidence files and is never
 * raised here. The archive is a deterministic ustar stream (sorted entries, the
 * source commit's time, fixed ownership) under `package/`, gzipped with a zero
 * header time, so the same inputs give the same digest; it lands in
 * `<out>/<library version>/<archive sha256>/` beside `artifact.json` and a
 * `.sha256` sidecar, every file read-only. A dirty or stale library needs the
 * matching `--allow-*` flag and is recorded with `certifiable: false`.
 *
 * The archive is also the source-bound bootstrap a counterpart builds its
 * adapter against before any pair exists. `source/implementation.json` is the
 * explicit implementation-tree map (the handoff's `SOURCE_TREE_RULES`: every
 * tracked implementation file to its working-tree digest, the same digest
 * `write-mega-maestro-handoff.mjs` reports) and `source/library-inputs.json`
 * the exhaustive esbuild input map the library build recorded; the manifest
 * names the implementation commit (the last one that touched an input), the
 * observed HEAD, whether the implementation tree is dirty, the managed port the
 * bundle must reach (`MANAGED_PORT`: names checked as functions on the loaded
 * bundle, declaration files checked in the payload) and, under `bootstrap`,
 * the routes the bundle itself reports unavailable. A bootstrap advertises
 * what is NOT there as plainly as what is: it needs no Mega adapter, and it
 * claims no paired, provider or native qualification.
 *
 * What never goes in: provider profiles, credentials, ledgers, anything read
 * from the sibling Mega-Maestro checkout, or the imported contracts package
 * (the pin names it by digest). Payload text is scanned for secret canaries
 * and for this machine's private paths before anything is written.
 *
 * Exit 0: packaged and certifiable. 3: packaged under an `--allow-*` flag.
 * 2: refused by a named condition. 1: the script itself failed.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

import {
	ACCEPTED_ENDPOINT_PROTOCOLS,
	ACCEPTED_PACKAGE_VERSIONS,
	EXPECTED_PACKAGE_NAME,
} from './import-mega-maestro.mjs';
import {
	DEFAULT_LIBRARY_DIR,
	DEFAULT_PIN_FILE,
	DEFAULT_SIBLING_DIR,
	inspectLibrary,
	inspectPin,
} from './mega-maestro-pair.mjs';
import { SOURCE_TREE_RULES, digestOf, sourceTreeDigest } from './write-mega-maestro-handoff.mjs';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ARTIFACT_FORMAT_VERSION = 1;
export const ARTIFACT_KIND = 'maestro-runtime';
export const ARCHIVE_NAME = 'runtime.tgz';
export const DEFAULT_OUT_DIR = 'dist/mega-maestro-runtime';
export const DEFAULT_PLAN_FILE = 'Plans/mega-maestro-rc/execution-plan.json';
const EVIDENCE_DIR = 'Plans/mega-maestro-rc/evidence';
const HOST_API_FILE = 'src/shared/plugins/host-api.ts';
const PLUGIN_SDK_PACKAGE = 'packages/plugin-sdk/package.json';

/**
 * The managed port a counterpart adapter is written against: the entry names
 * the packaged bundle must export as functions (checked on the LOADED bundle,
 * not the TypeScript beside it) and the declaration files its payload must
 * carry. A bundle that reaches less than this is refused, not advertised.
 */
export const MANAGED_PORT = Object.freeze({
	exports: Object.freeze([
		'installationIdentity',
		'createManagedHostAdapter',
		'createHeadlessSpawnAuthority',
		'createLocalHostAuthority',
		'createContextVerifier',
		'buildDispatchSnapshot',
		'negotiateCompatibility',
		'managedContextProblems',
		'createManagedBinding',
		'createRunJournal',
		'createManagedOperations',
		'mintManagedDispatch',
		'frameLocalEndpointRequest',
		'parseLocalEndpointResponse',
		'admitProbeTurn',
		'admitSupervisorChild',
		'createWorkflowOwnership',
		'createEventJournal',
		'createLifecycleProjector',
		'createCommandExecutor',
		'providerRouteSupport',
		'syntheticHarnessRouteSupport',
	]),
	declarations: Object.freeze(
		['types', 'compatibility', 'authority', 'endpoint-port', 'host-adapter', 'provider-route'].map(
			(name) => `types/shared/maestro-lib/managed/${name}.d.ts`
		)
	),
});
/**
 * The implementation inputs as git pathspecs (the same set `SOURCE_TREE_RULES`
 * includes). A function, not a constant: the handoff script imports this one
 * too, so the rules binding is read at call time, never while the two modules
 * are still loading each other.
 */
const implementationPathspecs = () =>
	SOURCE_TREE_RULES.include.map((rule) =>
		rule === 'tsconfig*.json' ? ':(glob)tsconfig*.json' : rule
	);

/** Names that are a profile, a credential or a ledger, whatever they hold. */
export const EXCLUDED_NAME =
	/(^|\/)(\.env(\..*)?|[^/]*\.(pem|key|p12|pfx)|id_(rsa|ed25519|ecdsa)[^/]*|[^/]*(secret|credential|token|profile)[^/]*\.(json|ya?ml|toml|txt)|maestro-managed-[^/]*\.json|maestro-sessions\.json|maestro-agent-configs\.json)$/i;
/(^|\/)(\.env(\..*)?|.*\.(pem|key|p12|pfx)|id_(rsa|ed25519|ecdsa).*|.*(secret|credential|token).*|maestro-managed-.*\.json|maestro-sessions\.json|maestro-agent-configs\.json)$/i;
/** Secret shapes a payload text must not carry; the match is named by file, never quoted. */
const CANARIES = [
	['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
	['anthropic-key', /sk-ant-[A-Za-z0-9_-]{20,}/],
	['openai-key', /sk-proj-[A-Za-z0-9_-]{20,}/],
	['github-token', /gh[pousr]_[A-Za-z0-9]{30,}/],
	['aws-access-key', /AKIA[0-9A-Z]{16}/],
];

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const git = (args) => {
	try {
		return execFileSync('git', ['-C', REPO_ROOT, ...args], {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore'],
		}).trim();
	} catch {
		return null;
	}
};

export class PackageRefusal extends Error {
	constructor(code, message) {
		super(message);
		this.name = 'PackageRefusal';
		this.code = code;
	}
}
const refuse = (code, message) => {
	throw new PackageRefusal(code, message);
};

/** Every canary a text matches, plus this machine's private paths. */
export function findCanaries(text, privatePaths = [os.homedir(), DEFAULT_SIBLING_DIR]) {
	const found = CANARIES.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
	for (const privatePath of privatePaths) {
		if (privatePath && privatePath !== '/' && text.includes(privatePath))
			found.push('private-path');
	}
	return found;
}

// ---------------------------------------------------------------------------
// The payload
// ---------------------------------------------------------------------------

/** The library files, exactly as the build hashed them: nothing unlisted, nothing moved. */
function collectLibrary(libraryDir, library) {
	const provenance = readJson(path.join(libraryDir, 'provenance.json'));
	const listed = new Set([...Object.keys(provenance.payloadSha256 ?? {}), 'provenance.json']);
	const walk = (dir) =>
		fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
			const full = path.join(dir, entry.name);
			return entry.isDirectory()
				? walk(full)
				: [path.relative(libraryDir, full).split(path.sep).join('/')];
		});
	const unlisted = walk(libraryDir).filter((file) => !listed.has(file));
	if (unlisted.length > 0) {
		refuse(
			'unlisted-file',
			`the library holds files its provenance does not: ${unlisted.join(', ')}`
		);
	}
	return [...listed].sort().map((file) => ({
		path: `library/${file}`,
		data: fs.readFileSync(path.join(libraryDir, file)),
	}));
}

/**
 * The matrix the packaged bundle reports, loaded in this plain Node process:
 * the providers the app offers (a hidden definition, such as the internal
 * terminal or a provider kept only for back-compat, is not a route to report).
 */
export function capabilityMatrix(libraryDir) {
	const lib = createRequire(import.meta.url)(path.join(libraryDir, 'index.js'));
	const routes = lib
		.getVisibleAgentDefinitions()
		.map((definition) => definition.id)
		.flatMap((id) => lib.providerRouteSupport(id));
	return {
		readFrom: 'the packaged bundle, loaded by this Node process',
		host: { platform: process.platform, arch: process.arch, node: process.version },
		routes,
		harness: lib.syntheticHarnessRouteSupport(),
		versions: {
			library: lib.MAESTRO_LIB_VERSION,
			managedContract: lib.MANAGED_CONTRACT_VERSION,
			endpointProtocol: lib.LOCAL_ENDPOINT_PROTOCOL,
			node: lib.MAESTRO_LIB_VERSION_INFO.node,
		},
	};
}

/**
 * The managed port as the packaged bundle actually reaches it: every name in
 * `MANAGED_PORT.exports` a function on the loaded bundle, every declaration
 * file in the hashed payload. Anything short refuses the package by name.
 */
export function managedPort(libraryDir, provenance) {
	const lib = createRequire(import.meta.url)(path.join(libraryDir, 'index.js'));
	const missing = MANAGED_PORT.exports.filter((name) => typeof lib[name] !== 'function');
	if (missing.length > 0) {
		refuse('managed-port', `the bundle exports no ${missing.join(', ')}`);
	}
	const payload = provenance.payloadSha256 ?? {};
	const undeclared = MANAGED_PORT.declarations.filter((file) => !(file in payload));
	if (undeclared.length > 0) {
		refuse('declarations', `the library payload carries no ${undeclared.join(', ')}`);
	}
	return {
		readFrom: 'the packaged bundle, loaded by this Node process, and the hashed payload',
		exports: [...MANAGED_PORT.exports],
		declarations: MANAGED_PORT.declarations.map((file) => `library/${file}`),
		entry: { path: 'library/index.js', sha256: payload['index.js'] ?? null },
	};
}

/**
 * The implementation snapshot the archive is bound to: the explicit
 * implementation-tree digest under the handoff's rules (tracked files,
 * working-tree bytes), the last commit that touched an implementation input
 * (not HEAD, which a checklist or evidence commit moves), the observed HEAD,
 * and whether the implementation tree holds a change git does not (a tracked
 * edit or an untracked file under the included paths). `files` is the map
 * behind the digest; the manifest carries everything else.
 */
export function implementationSnapshot(head) {
	let tree;
	try {
		tree = sourceTreeDigest(REPO_ROOT);
	} catch (error) {
		refuse('no-git', `the implementation tree cannot be read: ${error.message}`);
	}
	const { files } = tree;
	if (digestOf({ rules: SOURCE_TREE_RULES.id, files }) !== tree.digest) {
		refuse('implementation-digest', 'the implementation map does not reproduce the tree digest');
	}
	const pathspecs = implementationPathspecs();
	const dirtyEntries = (git(['status', '--porcelain', '--', ...pathspecs]) ?? '')
		.split('\n')
		.filter(Boolean);
	const dirty = dirtyEntries.length > 0;
	return {
		rules: {
			id: SOURCE_TREE_RULES.id,
			include: [...SOURCE_TREE_RULES.include],
			exclude: [...SOURCE_TREE_RULES.exclude],
			method: SOURCE_TREE_RULES.method,
		},
		digest: tree.digest,
		fileCount: tree.fileCount,
		deleted: tree.deleted,
		map: 'source/implementation.json',
		dirty,
		dirtyEntries: dirtyEntries.length,
		commit: dirty ? null : (git(['log', '-1', '--format=%H', '--', ...pathspecs]) ?? null),
		observedHead: head,
		files,
	};
}

/** What the bootstrap advertises as missing, read from the bundle's own matrix and the pins: never less. */
export function bootstrapDisclosure(matrix, pin) {
	const unavailable = matrix.routes
		.filter((row) => row.managed !== 'implemented')
		.map(({ agentId, route, standalone, managed }) => ({ agentId, route, standalone, managed }));
	return {
		statement:
			'compiled inputs for the counterpart adapter: this archive grants no lease or policy authority, enables no provider support and proves no paired, native or provider qualification',
		routes: {
			total: matrix.routes.length,
			managedImplemented: matrix.routes.length - unavailable.length,
			unavailable,
			rule: 'a route is unavailable until its enforcement producer exists and is exercised; a consumer that reads unsupported must refuse, not fall back',
		},
		harness: {
			routeId: matrix.harness.routeId,
			standalone: matrix.harness.standalone,
			managed: matrix.harness.managed,
			qualifies: matrix.harness.qualifies,
			doesNotQualify: matrix.harness.doesNotQualify,
		},
		counterpart: {
			'CP-01': { contracts: pin.status, owner: 'mega-maestro' },
			'CP-02': {
				runtimeAdapter: 'absent',
				owner: 'mega-maestro',
				note: 'not required by this bootstrap; an adapter qualifies against this archive by its sha256, never the entry file',
			},
			'CP-03': { workflowAuthority: 'absent', owner: 'mega-maestro' },
		},
		qualification: { paired: false, provider: false, native: false },
	};
}

/** The acceptance rows the run was held to, beside what the structured evidence recorded of each. */
export function acceptanceExpectations(plan) {
	const tested = {};
	const evidenceDir = path.join(REPO_ROOT, EVIDENCE_DIR);
	const files = fs.existsSync(evidenceDir)
		? fs
				.readdirSync(evidenceDir)
				.filter((f) => f.endsWith('.json'))
				.sort()
		: [];
	for (const file of files) {
		const matrix = readJson(path.join(evidenceDir, file)).positiveAcceptanceMatrix;
		for (const [id, row] of Object.entries(matrix ?? {})) {
			if (typeof row?.passed === 'boolean') tested[id] = { passed: row.passed, evidence: file };
		}
	}
	const rows = (plan.positiveAcceptanceMatrix ?? []).map((row) => ({
		...row,
		tested: tested[row.id] ?? null,
	}));
	return {
		readFrom: `${DEFAULT_PLAN_FILE} and ${EVIDENCE_DIR}/*.json`,
		rule: 'a row is passed only where its evidence file says so; a null is a row no structured evidence records',
		rows,
		requirements: plan.requirements ?? [],
		counterpartPrerequisites: (plan.counterpartPrerequisites ?? []).map(
			({ id, owner, producer }) => ({ id, owner, producer })
		),
		completionClaims: plan.completionClaims ?? {},
	};
}

// ---------------------------------------------------------------------------
// A deterministic ustar stream
// ---------------------------------------------------------------------------

const BLOCK = 512;
const octal = (value, width) => `${value.toString(8).padStart(width - 1, '0')}\0`;

function tarHeader(name, size, mode, type, mtime) {
	if (Buffer.byteLength(name) > 100) throw new Error(`tar entry name over 100 bytes: ${name}`);
	const header = Buffer.alloc(BLOCK);
	header.write(name, 0, 'utf8');
	header.write(octal(mode, 8), 100);
	header.write(octal(0, 8), 108);
	header.write(octal(0, 8), 116);
	header.write(octal(size, 12), 124);
	header.write(octal(mtime, 12), 136);
	header.write('        ', 148);
	header.write(type, 156);
	header.write('ustar\0', 257);
	header.write('00', 263);
	header.write('maestro', 265);
	header.write('maestro', 297);
	let sum = 0;
	for (const byte of header) sum += byte;
	header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
	return header;
}

/** `entries` as `{ path, data }`, written sorted under `package/` with their directories. */
export function buildTar(entries, mtime) {
	const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	const dirs = new Set(['package']);
	for (const entry of sorted) {
		const parts = `package/${entry.path}`.split('/');
		for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
	}
	const chunks = [...dirs].sort().map((dir) => tarHeader(`${dir}/`, 0, 0o755, '5', mtime));
	for (const entry of sorted) {
		chunks.push(tarHeader(`package/${entry.path}`, entry.data.length, 0o644, '0', mtime));
		chunks.push(entry.data);
		const pad = (BLOCK - (entry.data.length % BLOCK)) % BLOCK;
		if (pad) chunks.push(Buffer.alloc(pad));
	}
	chunks.push(Buffer.alloc(2 * BLOCK));
	return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// The package
// ---------------------------------------------------------------------------

export function packageRuntime(options = {}) {
	const libraryDir = path.resolve(REPO_ROOT, options.library ?? DEFAULT_LIBRARY_DIR);
	const outDir = path.resolve(REPO_ROOT, options.out ?? DEFAULT_OUT_DIR);
	const pinFile = path.resolve(REPO_ROOT, options.pin ?? DEFAULT_PIN_FILE);
	const planFile = path.resolve(REPO_ROOT, options.plan ?? DEFAULT_PLAN_FILE);

	const head = git(['rev-parse', 'HEAD']);
	const library = inspectLibrary(libraryDir, head);
	if (library.status === 'missing') refuse('library-missing', library.reason);
	if (library.status === 'mismatch') {
		refuse('mismatch', `library files moved since the build: ${library.mismatched.join(', ')}`);
	}
	if (library.status === 'dirty' && !options.allowDirty) {
		refuse(
			'library-dirty',
			'the library was built from a dirty tree (pass --allow-dirty to record it as such)'
		);
	}
	if (library.status === 'stale' && !options.allowStale) {
		refuse(
			'library-stale',
			`the library was built at ${library.sourceRevision}, not HEAD ${head} (pass --allow-stale)`
		);
	}
	const { files: implementationFiles, ...implementation } = implementationSnapshot(head);
	if (implementation.dirty && !options.allowDirty) {
		refuse(
			'implementation-dirty',
			`the implementation tree holds ${implementation.dirtyEntries} uncommitted change(s) under ${SOURCE_TREE_RULES.include.join(', ')} (pass --allow-dirty to record it as such)`
		);
	}
	const certifiable = library.status === 'ready' && !implementation.dirty;
	const reasons = [
		...(library.status === 'ready' ? [] : [`library ${library.status}`]),
		...(implementation.dirty ? ['implementation dirty'] : []),
	];

	const plan = fs.existsSync(planFile) ? readJson(planFile) : {};
	const pin = inspectPin(pinFile);
	const provenance = readJson(path.join(libraryDir, 'provenance.json'));
	const appPackage = readJson(path.join(REPO_ROOT, 'package.json'));
	const hostApi = fs
		.readFileSync(path.join(REPO_ROOT, HOST_API_FILE), 'utf8')
		.match(/HOST_API_VERSION = '([^']+)'/);
	const sdk = readJson(path.join(REPO_ROOT, PLUGIN_SDK_PACKAGE));
	const matrix = capabilityMatrix(libraryDir);
	const port = managedPort(libraryDir, provenance);
	const acceptance = acceptanceExpectations(plan);
	const committedAt = git(['log', '-1', '--format=%cI', 'HEAD']);
	const rcBase = plan.baseRevision ?? null;

	const entries = collectLibrary(libraryDir, library);
	if (pin.status === 'pinned') {
		entries.push({ path: 'contracts/contracts.pin.json', data: fs.readFileSync(pinFile) });
	}
	entries.push({
		path: 'conformance/capabilities.json',
		data: Buffer.from(`${JSON.stringify(matrix, null, '\t')}\n`),
	});
	entries.push({
		path: 'conformance/acceptance.json',
		data: Buffer.from(`${JSON.stringify(acceptance, null, '\t')}\n`),
	});
	entries.push({
		path: implementation.map,
		data: Buffer.from(
			`${JSON.stringify({ rules: SOURCE_TREE_RULES.id, files: implementationFiles }, null, '\t')}\n`
		),
	});
	const libraryInputs = provenance.inputs ? 'source/library-inputs.json' : null;
	if (libraryInputs) {
		entries.push({
			path: libraryInputs,
			data: Buffer.from(
				`${JSON.stringify({ inputSha256: provenance.inputSha256, inputs: provenance.inputs }, null, '\t')}\n`
			),
		});
	}

	const manifest = {
		formatVersion: ARTIFACT_FORMAT_VERSION,
		kind: ARTIFACT_KIND,
		name: `${ARTIFACT_KIND}-${provenance.version}`,
		platform: 'any',
		arch: 'any',
		versions: {
			app: appPackage.version,
			library: provenance.version,
			managedContract: provenance.maestroManagedContract,
			endpointProtocol: matrix.versions.endpointProtocol,
			pluginHostApi: hostApi ? hostApi[1] : null,
			pluginSdk: sdk.version,
			nodeRange: matrix.versions.node,
			builtWithNode: provenance.tooling?.node ?? null,
			acceptedContracts: {
				package: EXPECTED_PACKAGE_NAME,
				versions: ACCEPTED_PACKAGE_VERSIONS,
				endpointProtocols: ACCEPTED_ENDPOINT_PROTOCOLS,
			},
		},
		source: {
			rcBaseRef: plan.baseRef ?? null,
			rcBase,
			rcBaseIsAncestor:
				rcBase && head ? git(['merge-base', '--is-ancestor', rcBase, head]) !== null : null,
			branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
			head,
			headCommittedAt: committedAt,
			treeDirty:
				(git(['status', '--porcelain']) ?? '').split('\n').filter((l) => l && !l.startsWith('?? '))
					.length > 0,
			library: {
				sourceRevision: provenance.sourceRevision ?? null,
				sourceDirty: provenance.sourceDirty ?? null,
				inputSha256: provenance.inputSha256 ?? null,
				inputFiles: provenance.inputFiles ?? null,
				inputs: libraryInputs,
			},
			implementation,
		},
		managedPort: port,
		bootstrap: bootstrapDisclosure(matrix, pin),
		contracts:
			pin.status === 'pinned'
				? {
						status: pin.status,
						sha256: pin.digest,
						sourceRevision: pin.sourceRevision,
						sourceDirty: pin.sourceDirty,
					}
				: {
						status: pin.status,
						reason:
							'no clean Mega-Maestro contracts artifact is pinned in this checkout (CP-01, owner mega-maestro)',
					},
		components: Object.fromEntries(
			['library', 'contracts', 'conformance', 'source'].map((c) => [
				c,
				entries.filter((e) => e.path.startsWith(`${c}/`)).length,
			])
		),
		excluded: [
			'provider profiles',
			'credentials and ledgers',
			'the sibling Mega-Maestro checkout',
			'the imported contracts package (pinned by digest only)',
		],
		payloadSha256: Object.fromEntries(entries.map((e) => [e.path, sha256(e.data)])),
		certifiable,
		reasons,
	};
	entries.push({
		path: 'manifest.json',
		data: Buffer.from(`${JSON.stringify(manifest, null, '\t')}\n`),
	});

	// Nothing leaves until every entry, the manifest included, is clean by name and by content.
	for (const entry of entries) {
		if (EXCLUDED_NAME.test(entry.path))
			refuse('excluded-name', `${entry.path} is a profile, credential or ledger by name`);
		const found = entry.path.endsWith('.map') ? [] : findCanaries(entry.data.toString('utf8'));
		if (found.length > 0) refuse('canary', `${entry.path} carries ${found.join(', ')}`);
	}

	const mtime = committedAt ? Math.floor(Date.parse(committedAt) / 1000) : 0;
	const archive = gzipSync(buildTar(entries, mtime), { level: 9 });
	const digest = sha256(archive);
	const finalDir = path.join(outDir, provenance.version, digest);
	const artifact = {
		...manifest,
		packagedAt: new Date().toISOString(),
		archive: { file: ARCHIVE_NAME, sha256: digest, bytes: archive.length },
	};
	let existing = false;
	if (fs.existsSync(finalDir)) {
		const previous = fs.readFileSync(path.join(finalDir, ARCHIVE_NAME));
		if (sha256(previous) !== digest) refuse('immutable', `${finalDir} holds a different archive`);
		existing = true;
	} else {
		const staging = path.join(outDir, `.staging-${process.pid}`);
		fs.rmSync(staging, { recursive: true, force: true });
		fs.mkdirSync(staging, { recursive: true });
		fs.writeFileSync(path.join(staging, ARCHIVE_NAME), archive, { mode: 0o444 });
		fs.writeFileSync(path.join(staging, `${ARCHIVE_NAME}.sha256`), `${digest}  ${ARCHIVE_NAME}\n`, {
			mode: 0o444,
		});
		fs.writeFileSync(
			path.join(staging, 'artifact.json'),
			`${JSON.stringify(artifact, null, '\t')}\n`,
			{ mode: 0o444 }
		);
		fs.mkdirSync(path.dirname(finalDir), { recursive: true });
		fs.renameSync(staging, finalDir);
		fs.chmodSync(finalDir, 0o555);
	}
	return { ...artifact, dir: finalDir, existing, library };
}

export function main(argv = process.argv.slice(2)) {
	const { values } = parseArgs({
		args: argv,
		options: {
			library: { type: 'string' },
			out: { type: 'string' },
			pin: { type: 'string' },
			plan: { type: 'string' },
			'allow-dirty': { type: 'boolean' },
			'allow-stale': { type: 'boolean' },
			json: { type: 'boolean' },
			help: { type: 'boolean' },
		},
	});
	if (values.help) {
		process.stdout.write(
			'usage: package-mega-maestro-runtime.mjs [--library DIR] [--out DIR] [--pin FILE] [--plan FILE] [--allow-dirty] [--allow-stale] [--json]\n'
		);
		return 0;
	}
	try {
		const report = packageRuntime({
			library: values.library,
			out: values.out,
			pin: values.pin,
			plan: values.plan,
			allowDirty: values['allow-dirty'] === true,
			allowStale: values['allow-stale'] === true,
		});
		process.stdout.write(
			values.json
				? `${JSON.stringify(report, null, 2)}\n`
				: `${report.existing ? 'already packaged' : 'packaged'} ${report.name} at ${report.dir} (${report.archive.sha256}${report.certifiable ? '' : `; not certifiable: ${report.reasons.join(', ')}`})\n`
		);
		return report.certifiable ? 0 : 3;
	} catch (error) {
		if (!(error instanceof PackageRefusal)) throw error;
		process.stderr.write(
			`package-mega-maestro-runtime refused (${error.code}): ${error.message}\n`
		);
		return 2;
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	process.exitCode = main();
}
