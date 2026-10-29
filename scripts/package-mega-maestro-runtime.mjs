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
 * names the implementation commit (the last one that touched an input),
 * whether the implementation tree is dirty, the managed port the bundle must
 * reach (`MANAGED_PORT`: names checked as functions on the loaded bundle,
 * declaration files checked in the payload) and, under `bootstrap`, the routes
 * the bundle itself reports unavailable. A bootstrap advertises what is NOT
 * there as plainly as what is: it needs no Mega adapter, and it claims no
 * paired, provider or native qualification.
 *
 * Only implementation inputs reach the archive. HEAD, the branch, the tree's
 * dirtiness, the RC base and the acceptance rows beside their evidence marks
 * are observations of the packaging run: they live in `artifact.json` under
 * `observed` and in `acceptance.json` beside it, never under `package/`, and
 * the tar time is the implementation commit's. So a checklist, receipt, pin or
 * documentation commit leaves an existing archive current, while an
 * implementation change always yields a new digest.
 *
 * `--runtime <dir>` verifies one packaged artifact as the pinned input of a
 * pair instead of packaging (`verifyRuntimeInput()`): the archive bound to its
 * sidecar, manifest and directory name by sha256 and sha512, the manifest in
 * the archive equal to the one beside it, the archived implementation map
 * equal to the tree now (`drift` names every file that moved), the archived
 * library inputs unchanged, and the archive named by the committed runtime
 * pin (`Plans/integration-completion/runtime-conformance.json`, `runtime`
 * section, written from a verified artifact by `--write-pin`). The pin is an
 * identity, never a qualification: a counterpart adapter's `qualifiedAgainst`
 * receipt names `archive.sha256` in the adapter's own pin, and a runtime pin
 * that carries one is refused, so qualifying an archive cannot change it.
 *
 * What never goes in: provider profiles, credentials, ledgers, anything read
 * from the sibling Mega-Maestro checkout, or the imported contracts package
 * (the pin names it by digest). Payload text is scanned for secret canaries
 * and for this machine's private paths before anything is written.
 *
 * Exit 0: packaged and certifiable (or the runtime verified ready). 3: packaged
 * under an `--allow-*` flag. 2: refused by a named condition (or the runtime
 * not ready). 1: the script itself failed.
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
	RUNTIME_ARTIFACT_FORMAT_VERSION,
	inspectLibrary,
	inspectPin,
	inspectRuntimeArtifact,
	movedInputs,
} from './mega-maestro-pair.mjs';
import { SOURCE_TREE_RULES, digestOf, sourceTreeDigest } from './write-mega-maestro-handoff.mjs';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ARTIFACT_FORMAT_VERSION = RUNTIME_ARTIFACT_FORMAT_VERSION;
export const ARTIFACT_KIND = 'maestro-runtime';
export const ARCHIVE_NAME = 'runtime.tgz';
/** The acceptance rows and their evidence marks, beside the artifact and outside the archive. */
export const ACCEPTANCE_NAME = 'acceptance.json';
export const DEFAULT_OUT_DIR = 'dist/mega-maestro-runtime';
export const DEFAULT_PLAN_FILE = 'Plans/mega-maestro-rc/execution-plan.json';
/** The committed runtime pin: the `runtime` section names the archive a pair loads. */
export const RUNTIME_PIN_FILE = 'Plans/integration-completion/runtime-conformance.json';
export const RUNTIME_PIN_FORMAT_VERSION = 1;
export const RUNTIME_PIN_ARTIFACT_ID = 'MAESTRO-M0-RUNTIME';
/** Keys that make a pin a qualification receipt rather than an identity; a runtime pin may carry none. */
const RECEIPT_KEYS = ['qualifiedAgainst', 'adapter', 'qualification', 'passed'];
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
const sha512 = (bytes) => createHash('sha512').update(bytes).digest('hex');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const posix = (file) => file.split(path.sep).join('/');
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
 * (not HEAD, which a checklist or evidence commit moves) with its time, and
 * whether the implementation tree holds a change git does not (a tracked edit
 * or an untracked file under the included paths). `files` is the map behind
 * the digest; the manifest carries everything else. HEAD is not here: it is
 * an observation, recorded beside the archive and never in it.
 */
export function implementationSnapshot() {
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
	const [lastCommit, committedAt] = (
		git(['log', '-1', '--format=%H %cI', '--', ...pathspecs]) ?? ' '
	).split(' ');
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
		commit: dirty ? null : lastCommit || null,
		committedAt: committedAt || null,
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
			library.movedInputs
				? `the library's inputs moved since it was built: ${library.movedInputs.join(', ')} (rebuild it, or pass --allow-stale)`
				: `the library was built at ${library.sourceRevision}, not HEAD ${head} (pass --allow-stale)`
		);
	}
	const { files: implementationFiles, ...implementation } = implementationSnapshot();
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

	// The tar time is the implementation commit's: a commit that touches no input leaves it alone.
	const mtime = implementation.committedAt
		? Math.floor(Date.parse(implementation.committedAt) / 1000)
		: 0;
	const archive = gzipSync(buildTar(entries, mtime), { level: 9 });
	const digest = sha256(archive);
	const finalDir = path.join(outDir, provenance.version, digest);
	// What the packaging run observed, beside the archive and never in it.
	const artifact = {
		...manifest,
		observed: {
			head,
			branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
			headCommittedAt: git(['log', '-1', '--format=%cI', 'HEAD']),
			treeDirty:
				(git(['status', '--porcelain']) ?? '').split('\n').filter((l) => l && !l.startsWith('?? '))
					.length > 0,
			rcBaseRef: plan.baseRef ?? null,
			rcBase,
			rcBaseIsAncestor:
				rcBase && head ? git(['merge-base', '--is-ancestor', rcBase, head]) !== null : null,
			acceptance: ACCEPTANCE_NAME,
		},
		packagedAt: new Date().toISOString(),
		archive: { file: ARCHIVE_NAME, sha256: digest, sha512: sha512(archive), bytes: archive.length },
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
		for (const [name, value] of [
			['artifact.json', artifact],
			[ACCEPTANCE_NAME, acceptance],
		]) {
			fs.writeFileSync(path.join(staging, name), `${JSON.stringify(value, null, '\t')}\n`, {
				mode: 0o444,
			});
		}
		fs.mkdirSync(path.dirname(finalDir), { recursive: true });
		fs.renameSync(staging, finalDir);
		fs.chmodSync(finalDir, 0o555);
	}
	return { ...artifact, dir: finalDir, existing, library };
}

// ---------------------------------------------------------------------------
// The pinned runtime input
// ---------------------------------------------------------------------------

/** One entry of the archive through the host tar (the importer's reader bounds files below the source map). */
const readArchiveEntry = (archive, name) =>
	execFileSync('tar', ['-xzOf', archive, `package/${name}`], { maxBuffer: 1 << 28 });

/** Every implementation file that moved between an archived map and a tree map, named and bounded. */
export function implementationDrift(archived, current) {
	const moved = [];
	for (const [file, digest] of Object.entries(archived)) {
		if (!(file in current)) moved.push(`removed ${file}`);
		else if (current[file] !== digest) moved.push(`changed ${file}`);
	}
	for (const file of Object.keys(current)) if (!(file in archived)) moved.push(`added ${file}`);
	moved.sort();
	return { count: moved.length, files: moved.slice(0, 20) };
}

/** The committed runtime pin's `runtime` section, and whether git holds the file unchanged. */
export function readRuntimePin(file) {
	const rel = posix(path.relative(REPO_ROOT, file));
	if (!fs.existsSync(file)) return { status: 'absent', file: rel, committed: false, record: null };
	let record;
	try {
		record = readJson(file).runtime ?? null;
	} catch (error) {
		return {
			status: 'malformed',
			file: rel,
			committed: false,
			record: null,
			reason: String(error),
		};
	}
	const committed =
		git(['ls-files', '--error-unmatch', '--', rel]) !== null &&
		git(['diff', '--quiet', 'HEAD', '--', rel]) !== null;
	return { status: record ? 'pinned' : 'absent', file: rel, committed, record };
}

/** The pin an artifact directory is named by: its identity alone, never a qualification of it. */
export function runtimePinOf(artifactDir) {
	const artifact = readJson(path.join(artifactDir, 'artifact.json'));
	const archiveFile = path.join(artifactDir, ARCHIVE_NAME);
	const archive = fs.readFileSync(archiveFile);
	const { implementation, library } = artifact.source;
	const digest = sha256(archive);
	return {
		artifactId: RUNTIME_PIN_ARTIFACT_ID,
		standing:
			'identity only: this names the archive a pair loads; MAESTRO-M0-RUNTIME-BUILD and MAESTRO-M0-RUNTIME are receipts under Plans/integration-completion/evidence/, never this file',
		kind: artifact.kind,
		archiveFormatVersion: artifact.formatVersion,
		archive: { file: ARCHIVE_NAME, sha256: digest, sha512: sha512(archive), bytes: archive.length },
		manifestSha256: sha256(readArchiveEntry(archiveFile, 'manifest.json')),
		payloadDigest: digestOf(artifact.payloadSha256),
		payloadFiles: Object.keys(artifact.payloadSha256).length,
		versions: {
			app: artifact.versions.app,
			library: artifact.versions.library,
			managedContract: artifact.versions.managedContract,
			endpointProtocol: artifact.versions.endpointProtocol,
		},
		implementation: {
			rules: implementation.rules.id,
			digest: implementation.digest,
			commit: implementation.commit,
			fileCount: implementation.fileCount,
		},
		library: {
			sourceRevision: library.sourceRevision,
			inputSha256: library.inputSha256,
			inputFiles: library.inputFiles,
			entrySha256: artifact.managedPort.entry.sha256,
		},
		location: {
			directory: `${DEFAULT_OUT_DIR}/${artifact.versions.library}/${digest}`,
			rule: 'obtain the archive by archive.sha256 and verify the sidecar and sha512; the directory is where the packager lands it',
		},
		receipts: {
			rule: 'a counterpart adapter records qualifiedAgainst.maestroRuntimeSha256 = archive.sha256 in its own pin, read by scripts/mega-maestro-pair.mjs; nothing an adapter records is written here, so qualification cannot change the archive it names',
		},
	};
}

/**
 * One packaged artifact as the pinned runtime input of a pair: bound by
 * digest, its archive the manifest's, its implementation map the tree's now,
 * its library inputs unchanged, and named by the committed pin. `ready` is
 * the only status a run loads; `drift` lists what moved; `coordinationOnly`
 * says HEAD moved while no implementation input did.
 */
export function verifyRuntimeInput(options) {
	const dir = path.resolve(REPO_ROOT, options.runtime);
	const head = git(['rev-parse', 'HEAD']);
	const bound = inspectRuntimeArtifact(dir, head);
	const pin = readRuntimePin(path.resolve(REPO_ROOT, options.pin ?? RUNTIME_PIN_FILE));
	const problems = [];
	const record = {
		...bound,
		pin: { status: pin.status, file: pin.file, committed: pin.committed },
		implementation: null,
		drift: null,
		libraryInputs: null,
		coordinationOnly: false,
		problems,
	};
	if (bound.status !== 'bound') {
		problems.push(`the artifact directory is ${bound.status}`);
		return record;
	}
	const archiveFile = path.join(dir, ARCHIVE_NAME);
	const manifest = JSON.parse(readArchiveEntry(archiveFile, 'manifest.json').toString('utf8'));
	const {
		packagedAt: _at,
		archive: _archive,
		observed: _observed,
		...beside
	} = readJson(path.join(dir, 'artifact.json'));
	if (digestOf(beside) !== digestOf(manifest)) {
		problems.push('artifact.json is not the manifest inside the archive');
		return { ...record, status: 'archive-manifest-mismatch' };
	}
	const map = JSON.parse(
		readArchiveEntry(archiveFile, manifest.source.implementation.map).toString('utf8')
	);
	if (digestOf({ rules: map.rules, files: map.files }) !== manifest.source.implementation.digest) {
		problems.push('the archived implementation map does not reproduce its digest');
		return { ...record, status: 'implementation-digest' };
	}
	const tree = options.sourceTree ?? sourceTreeDigest(REPO_ROOT);
	record.implementation = {
		archived: manifest.source.implementation.digest,
		current: tree.digest,
		commit: manifest.source.implementation.commit,
		dirty: manifest.source.implementation.dirty,
	};
	record.drift = implementationDrift(map.files, tree.files);
	const inputsEntry = manifest.source.library.inputs;
	record.libraryInputs = inputsEntry
		? movedInputs(JSON.parse(readArchiveEntry(archiveFile, inputsEntry).toString('utf8')).inputs)
		: null;
	record.coordinationOnly = bound.headMoved && record.drift.count === 0;
	if (record.drift.count > 0) {
		problems.push(
			`${record.drift.count} implementation file(s) moved since the archive: ${record.drift.files.join(', ')}`
		);
	}
	if (record.libraryInputs?.length) {
		problems.push(`library inputs moved since the archive: ${record.libraryInputs.join(', ')}`);
	}
	if (problems.length > 0) return { ...record, status: 'drift' };
	if (pin.status !== 'pinned') {
		problems.push(`no runtime pin names this archive (${pin.file} is ${pin.status})`);
		return { ...record, status: pin.status === 'malformed' ? 'pin-malformed' : 'unpinned' };
	}
	const text = JSON.stringify(pin.record);
	if (RECEIPT_KEYS.some((key) => text.includes(`"${key}"`))) {
		problems.push(`the runtime pin carries a qualification receipt (${RECEIPT_KEYS.join(', ')})`);
		return { ...record, status: 'pin-not-runtime' };
	}
	const mismatch = [
		['archive.sha256', pin.record.archive?.sha256, bound.archiveSha256],
		['archive.sha512', pin.record.archive?.sha512, bound.archiveSha512],
		['implementation.digest', pin.record.implementation?.digest, tree.digest],
		['payloadDigest', pin.record.payloadDigest, digestOf(manifest.payloadSha256)],
	].filter(([, pinned, actual]) => pinned !== actual);
	if (mismatch.length > 0) {
		problems.push(`the pin names another runtime: ${mismatch.map(([k]) => k).join(', ')} differ`);
		return { ...record, status: 'pin-mismatch' };
	}
	return { ...record, status: 'ready' };
}

/** Write the `runtime` section of the pin from a verified artifact, keeping every other section of the file. */
export function writeRuntimePin(options) {
	const verified = verifyRuntimeInput(options);
	if (!['ready', 'unpinned', 'pin-mismatch'].includes(verified.status)) {
		refuse(
			verified.status,
			`the artifact cannot be pinned: ${verified.problems.join('; ') || verified.status}`
		);
	}
	const file = path.resolve(REPO_ROOT, options.pin ?? RUNTIME_PIN_FILE);
	const current = fs.existsSync(file) ? readJson(file) : {};
	const pinned = {
		formatVersion: RUNTIME_PIN_FORMAT_VERSION,
		owner: 'maestro',
		...current,
		runtime: runtimePinOf(path.resolve(REPO_ROOT, options.runtime)),
	};
	const text = `${JSON.stringify(pinned, null, '\t')}\n`;
	const found = findCanaries(text);
	if (found.length > 0) refuse('canary', `the pin would carry ${found.join(', ')}`);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
	return { ...verifyRuntimeInput(options), written: posix(path.relative(REPO_ROOT, file)) };
}

export function main(argv = process.argv.slice(2)) {
	const { values } = parseArgs({
		args: argv,
		options: {
			library: { type: 'string' },
			out: { type: 'string' },
			pin: { type: 'string' },
			plan: { type: 'string' },
			runtime: { type: 'string' },
			'runtime-pin': { type: 'string' },
			'write-pin': { type: 'boolean' },
			'allow-dirty': { type: 'boolean' },
			'allow-stale': { type: 'boolean' },
			json: { type: 'boolean' },
			help: { type: 'boolean' },
		},
	});
	if (values.help) {
		process.stdout.write(
			'usage: package-mega-maestro-runtime.mjs [--library DIR] [--out DIR] [--pin FILE] [--plan FILE] [--allow-dirty] [--allow-stale] [--json]\n' +
				'       package-mega-maestro-runtime.mjs --runtime DIR [--runtime-pin FILE] [--write-pin] [--json]\n'
		);
		return 0;
	}
	try {
		if (values.runtime) {
			const input = { runtime: values.runtime, pin: values['runtime-pin'] };
			const verified = values['write-pin'] ? writeRuntimePin(input) : verifyRuntimeInput(input);
			process.stdout.write(
				values.json
					? `${JSON.stringify(verified, null, 2)}\n`
					: `runtime ${verified.archiveSha256 ?? path.basename(values.runtime)} is ${verified.status}${verified.written ? ` (pin written to ${verified.written}; commit it)` : ''}${verified.problems.length ? `: ${verified.problems.join('; ')}` : ''}\n`
			);
			return verified.status === 'ready' ? 0 : 2;
		}
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
