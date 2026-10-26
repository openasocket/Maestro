#!/usr/bin/env node
/**
 * Write Maestro's handoff manifest for the Mega-Maestro integration at the agreed
 * path, `Plans/mega-maestro/evidence/handoff.json` (MEGA-MAESTRO-INTEGRATION, "Handoff
 * and joint acceptance"); `scripts/import-joint-integration.mjs` checks the
 * counterpart's record against its `repositoryRevision`, `sourceTreeDigest` and
 * artifact digests. Phase 1 wrote its own evidence under `Plans/mega-maestro-rc/`.
 *
 *   node scripts/write-mega-maestro-handoff.mjs [--out Plans/mega-maestro/evidence/handoff.json]
 *     [--library dist/maestro-lib] [--pin vendor/mega-maestro/contracts.pin.json]
 *     [--joint Plans/mega-maestro-rc/joint-integration.json] [--stage early|full]
 *     [--agreement <MEGA-MAESTRO-INTEGRATION.md>] [--enforceability <MEGA-MAESTRO-ENFORCEABILITY.md>]
 *     [--check] [--json]
 *
 * Deterministic: no wall clock, no pid, nothing from the sibling checkout unless a
 * document is named explicitly (then only its digest is kept); `--check` compares
 * with the file on disk and writes nothing (exit 0 equal, 1 not). Every digest is
 * sha256 over `canonicalJson()` (RFC 8785). Refusals (exit 2, nothing written): a
 * missing or moved library payload, an absolute or private path or a secret shape
 * (`redactSecrets()`) anywhere in the manifest, or a manifest `HANDOFF_SCHEMA` rejects.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { registerHooks } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { DEFAULT_LIBRARY_DIR, DEFAULT_PIN_FILE, inspectLibrary } from './mega-maestro-pair.mjs';
import { capabilityMatrix, findCanaries } from './package-mega-maestro-runtime.mjs';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const HANDOFF_FORMAT_VERSION = 1;
export const INTEGRATION_ID = 'mega-maestro-v1';
export const DEFAULT_OUT_FILE = 'Plans/mega-maestro/evidence/handoff.json';
export const DEFAULT_JOINT_FILE = 'Plans/mega-maestro-rc/joint-integration.json';
export const PLAN_FILE = 'Plans/mega-maestro-rc/execution-plan.json';
export const SUPPORT_MATRIX_FILE = 'Plans/mega-maestro-rc/support-matrix.json';
export const CONTRACT_VECTORS_FILE = 'src/__tests__/fixtures/mega-maestro/contract-vectors.json';
export const STAGES = Object.freeze(['early', 'full']);

/**
 * The implementation-only inclusion rules behind `sourceTreeDigest`: git-tracked
 * files only, working-tree bytes, so an uncommitted source edit moves the digest
 * and a report, a playbook checkbox or a doc edit does not.
 */
export const SOURCE_TREE_RULES = Object.freeze({
	id: 'maestro-implementation-tree/1',
	include: Object.freeze([
		'src/',
		'scripts/',
		'package.json',
		'package-lock.json',
		'tsconfig*.json',
		'vendor/mega-maestro/contracts.pin.json',
	]),
	exclude: Object.freeze(['Plans/', '.maestro/', 'docs/']),
	method:
		'sha256 of canonicalJson({ rules, files }): files maps each included git-tracked path (POSIX separators, sorted) to the sha256 of its working-tree bytes, or "deleted" when the tracked file is absent',
});

// The shared utilities are TypeScript. Node strips types itself; these hooks only
// resolve extensionless relative imports under src/shared and name the format.
const SHARED_URL = pathToFileURL(path.join(REPO_ROOT, 'src/shared/')).href;
registerHooks({
	resolve(specifier, context, next) {
		const bare = specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier);
		if (bare && context.parentURL?.startsWith(SHARED_URL)) return next(`${specifier}.ts`, context);
		return next(specifier, context);
	},
	load(url, context, next) {
		if (!url.startsWith(SHARED_URL) || !url.endsWith('.ts')) return next(url, context);
		const source = fs.readFileSync(fileURLToPath(url));
		return { format: 'module-typescript', source, shortCircuit: true };
	},
});
const { canonicalJson } = await import('../src/shared/canonicalJson.ts');
const { redactSecrets } = await import('../src/shared/redactSecrets.ts');

export class HandoffRefusal extends Error {
	constructor(code, message) {
		super(message);
		this.name = 'HandoffRefusal';
		this.code = code;
	}
}
const refuse = (code, message) => {
	throw new HandoffRefusal(code, message);
};
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
/** sha256 over the canonical JSON text of `value`: the one digest rule of this manifest. */
export const digestOf = (value) => sha256(Buffer.from(canonicalJson(value), 'utf8'));
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const readJsonIf = (file) => (fs.existsSync(file) ? readJson(file) : null);
const posix = (file) => file.split(path.sep).join('/');
const git = (args) => {
	try {
		const opts = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 26 };
		return execFileSync('git', ['-C', REPO_ROOT, ...args], opts).trim();
	} catch {
		return null;
	}
};

// ---------------------------------------------------------------------------
// The source tree
// ---------------------------------------------------------------------------

/** Whether a repo-relative POSIX path falls under the inclusion rules. */
export function includedInSourceTree(file) {
	if (SOURCE_TREE_RULES.exclude.some((prefix) => file.startsWith(prefix))) return false;
	return SOURCE_TREE_RULES.include.some((rule) =>
		rule.endsWith('/')
			? file.startsWith(rule)
			: rule === 'tsconfig*.json'
				? /^tsconfig(\.[^/]+)?\.json$/.test(file)
				: file === rule
	);
}

/** The digest over every included tracked file's working-tree bytes, with counts. */
export function sourceTreeDigest(root = REPO_ROOT) {
	const listed = git(['ls-files', '-z']) ?? refuse('no-git', 'git ls-files failed');
	const files = {};
	let deleted = 0;
	for (const file of listed.split('\0').filter(includedInSourceTree).sort()) {
		const stat = fs.lstatSync(path.join(root, ...file.split('/')), { throwIfNoEntry: false });
		if (!stat?.isFile()) deleted += 1;
		files[file] = stat?.isFile() ? sha256(fs.readFileSync(path.join(root, file))) : 'deleted';
	}
	const digest = digestOf({ rules: SOURCE_TREE_RULES.id, files });
	return { digest, fileCount: Object.keys(files).length, deleted };
}

// ---------------------------------------------------------------------------
// The manifest
// ---------------------------------------------------------------------------

const fileDigest = (file) => (file ? sha256(fs.readFileSync(path.resolve(REPO_ROOT, file))) : null);

/** The library artifact as the build hashed it; `ready`, `stale` and `dirty` are recorded, not hidden. */
function libraryArtifact(libraryDir, head) {
	const library = inspectLibrary(libraryDir, head);
	if (library.status === 'missing') refuse('library-missing', library.reason);
	if (library.status === 'mismatch') {
		refuse('library-mismatch', `library files moved since the build: ${library.mismatched}`);
	}
	const p = readJson(path.join(libraryDir, 'provenance.json'));
	const dir = posix(path.relative(REPO_ROOT, libraryDir));
	return {
		kind: 'maestro-lib',
		path: dir,
		buildCommand: 'npm run build:maestro-lib',
		version: p.version,
		managedContract: p.maestroManagedContract,
		appVersion: p.maestroAppVersion,
		status: library.status,
		sourceRevision: p.sourceRevision ?? null,
		sourceDirty: p.sourceDirty === true,
		inputSha256: p.inputSha256 ?? null,
		entry: { path: `${dir}/index.js`, sha256: p.payloadSha256['index.js'] },
		payloadFiles: Object.keys(p.payloadSha256).length,
		payloadDigest: digestOf(p.payloadSha256),
		builtWithNode: p.tooling?.node ?? null,
	};
}

/** CP-01 through CP-06 and the approval producer, each with owner and status; none is inferred present. */
function pendingPrerequisites(plan, joint, supportMatrix) {
	const producers = joint?.producers ?? {};
	const rows = (plan?.counterpartPrerequisites ?? []).map((p) => ({
		id: p.id,
		owner: p.owner,
		producer: p.producer,
		status: producers[p.id]?.status ?? 'open',
		observed: producers[p.id]?.observed ?? p.statusAtReview ?? null,
	}));
	const has = (id) => rows.some((r) => r.id === id);
	for (const [id, p] of Object.entries(producers)) {
		if (has(id) || typeof p?.status !== 'string') continue;
		rows.push({ id, owner: p.owner, producer: p.producer, status: p.status, observed: p.observed });
	}
	for (const row of supportMatrix?.counterpart?.rows ?? []) {
		if (!row.dependency) continue;
		const entry = rows.find((r) => r.id === row.dependency);
		if (entry?.keys) entry.keys.push(row.key);
		else if (!entry) {
			const base = { id: row.dependency, owner: row.owner, producer: '', status: 'open' };
			rows.push({ ...base, observed: row.evidence, keys: [row.key] });
		}
	}
	return rows
		.map(({ keys, ...row }) => (keys ? { ...row, producer: `rows ${keys.join(', ')}` } : row))
		.sort((a, b) => a.id.localeCompare(b.id, 'en'));
}

export function buildHandoff(options = {}) {
	const libraryDir = path.resolve(REPO_ROOT, options.library ?? DEFAULT_LIBRARY_DIR);
	const jointFile = path.resolve(REPO_ROOT, options.joint ?? DEFAULT_JOINT_FILE);
	const stage = options.stage ?? 'full';
	if (!STAGES.includes(stage)) refuse('usage', `--stage must be one of ${STAGES.join(', ')}`);
	const head = git(['rev-parse', 'HEAD']) ?? refuse('no-git', 'the checkout has no git HEAD');
	const plan = readJsonIf(path.resolve(REPO_ROOT, PLAN_FILE));
	const joint = readJsonIf(jointFile);
	const supportMatrix = readJsonIf(path.resolve(REPO_ROOT, SUPPORT_MATRIX_FILE));
	const pin = readJsonIf(path.resolve(REPO_ROOT, options.pin ?? DEFAULT_PIN_FILE));
	const vectors = readJsonIf(path.join(REPO_ROOT, CONTRACT_VECTORS_FILE));
	const tree = sourceTreeDigest();
	const artifact = libraryArtifact(libraryDir, head);
	const matrix = capabilityMatrix(libraryDir);
	const dirtyIncluded = (git(['status', '--porcelain', '-z']) ?? '')
		.split('\0')
		.filter((line) => line.length > 3 && !line.startsWith('??'))
		.filter((line) => includedInSourceTree(line.slice(3))).length;

	const platforms = {
		linux: 'route-available: the pair runs in the pinned Linux container; no row passed',
	};
	for (const row of supportMatrix?.counterpart?.rows ?? []) {
		const platform = row.key.match(/^transport\.os-peer\.(\w+)$/)?.[1];
		if (platform) platforms[platform] = `${row.status} (${row.dependency}; ${row.evidence})`;
	}
	const providers = {};
	for (const r of matrix.routes) {
		(providers[r.agentId] ??= []).push(`${r.route}=${r.standalone}/${r.managed}`);
	}
	for (const id of Object.keys(providers)) providers[id] = providers[id].join(' ');
	const pick = ({ step, command, exit, result }) => ({ step, command, exit, result });
	const met = (claim) => joint?.claims?.[claim]?.status === 'met';
	return {
		formatVersion: HANDOFF_FORMAT_VERSION,
		integrationId: INTEGRATION_ID,
		producer: 'maestro',
		stage,
		agreementDigest: fileDigest(options.agreement),
		enforceabilityDigest: fileDigest(options.enforceability),
		documentDigestRule:
			'sha256 of the raw bytes of each named Mega-Maestro design document; null if none',
		repositoryRevision: head,
		repository: {
			branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
			baseRevision: plan?.baseRevision ?? null,
			headCommittedAt: git(['log', '-1', '--format=%cI', 'HEAD']),
			includedTreeDirty: dirtyIncluded > 0 || tree.deleted > 0,
			dirtyIncludedFiles: dirtyIncluded,
		},
		sourceTreeDigest: tree.digest,
		sourceTree: { rules: SOURCE_TREE_RULES, files: tree.fileCount, deleted: tree.deleted },
		artifacts: [artifact],
		contracts: pin
			? { status: 'pinned', sha256: pin.sha256, sourceRevision: pin.sourceRevision ?? null }
			: { status: 'absent', dependency: 'CP-01', owner: 'mega-maestro' },
		capabilities: {
			managedContract: matrix.versions.managedContract,
			endpointProtocol: matrix.versions.endpointProtocol,
			nodeRange: matrix.versions.node,
			contractVectors: { file: CONTRACT_VECTORS_FILE, sha256: fileDigest(CONTRACT_VECTORS_FILE) },
			counterpartRevision: vectors?.counterpart?.sourceRevision ?? null,
		},
		matrix: {
			readOn: matrix.host,
			legend: 'route=standalone/managed, in the words of Plans/mega-maestro-rc/support-matrix.json',
			platforms,
			providers,
			harness: `${matrix.harness.routeId}=${matrix.harness.standalone}/${matrix.harness.managed}`,
		},
		commands: [
			{
				step: 'build the library',
				command: artifact.buildCommand,
				exit: 0,
				result: `maestro-lib ${artifact.version} from ${artifact.sourceRevision} (${artifact.status} against HEAD)`,
			},
			...(joint?.commands ?? []).map(pick),
			{
				step: 'write this manifest',
				command:
					'node scripts/write-mega-maestro-handoff.mjs --agreement <doc> --enforceability <doc>',
				exit: 0,
				result: 'this file; --check reproduces it byte for byte or exits 1',
			},
		],
		localStatus: met('localCode') ? 'complete' : joint ? 'partial' : 'unknown',
		jointStatus: joint ? (met('pairedIntegration') ? 'verified' : 'not-verified') : 'not-run',
		acceptance: joint && {
			source: posix(path.relative(REPO_ROOT, jointFile)),
			headRevision: joint.frontMatter?.head_revision ?? null,
			totals: joint.positiveAcceptanceMatrix?.totals ?? null,
		},
		pendingPrerequisites: pendingPrerequisites(plan, joint, supportMatrix),
		pathMapping: {
			agreed: 'Plans/mega-maestro/evidence/',
			phase1: 'Plans/mega-maestro-rc/ (rules, plan, support matrix, evidence, the pair record)',
			jointIntegration: 'written only by scripts/import-joint-integration.mjs after a digest check',
		},
	};
}

// ---------------------------------------------------------------------------
// The schema and the refusals
// ---------------------------------------------------------------------------

const str = { type: 'string' };
const nstr = { type: ['string', 'null'] };
const hex = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const nhex = { type: ['string', 'null'], pattern: '^[a-f0-9]{64}$' };
const int = (minimum) => ({ type: 'integer', minimum });
const of = (names, schema) => Object.fromEntries(names.map((n) => [n, schema]));
const obj = (properties, required = Object.keys(properties)) => ({
	type: 'object',
	properties,
	required,
	additionalProperties: false,
});
const list = (items, minItems = 0) => ({ type: 'array', items, minItems });

/** What a handoff.json must look like; `validateHandoff()` is its reader here. */
export const HANDOFF_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	$id: 'https://maestro.sh/schemas/mega-maestro-handoff-1.json',
	...obj({
		formatVersion: { const: HANDOFF_FORMAT_VERSION },
		integrationId: { const: INTEGRATION_ID },
		producer: { const: 'maestro' },
		stage: { enum: [...STAGES] },
		...of(['agreementDigest', 'enforceabilityDigest'], nhex),
		documentDigestRule: str,
		repositoryRevision: { type: 'string', pattern: '^[a-f0-9]{40}$' },
		repository: obj({
			...of(['branch', 'baseRevision', 'headCommittedAt'], nstr),
			includedTreeDirty: { type: 'boolean' },
			dirtyIncludedFiles: int(0),
		}),
		sourceTreeDigest: hex,
		sourceTree: obj({
			rules: obj({ id: str, include: list(str, 1), exclude: list(str), method: str }),
			files: int(1),
			deleted: int(0),
		}),
		artifacts: list(
			obj({
				...of(['kind', 'path', 'buildCommand', 'version', 'managedContract', 'appVersion'], str),
				status: { enum: ['ready', 'stale', 'dirty'] },
				...of(['sourceRevision', 'builtWithNode'], nstr),
				sourceDirty: { type: 'boolean' },
				inputSha256: nhex,
				entry: obj({ path: str, sha256: hex }),
				payloadFiles: int(1),
				payloadDigest: hex,
			}),
			1
		),
		contracts: {
			type: 'object',
			properties: { status: { enum: ['pinned', 'absent'] } },
			required: ['status'],
		},
		capabilities: obj({
			...of(['managedContract', 'nodeRange'], str),
			endpointProtocol: int(1),
			contractVectors: obj({ file: str, sha256: nhex }),
			counterpartRevision: nstr,
		}),
		matrix: obj({
			...of(['readOn', 'platforms', 'providers'], { type: 'object' }),
			legend: str,
			harness: str,
		}),
		commands: list(
			obj({ ...of(['step', 'command', 'result'], str), exit: { type: ['integer', 'null'] } }),
			1
		),
		localStatus: { enum: ['complete', 'partial', 'unknown'] },
		jointStatus: { enum: ['verified', 'not-verified', 'not-run'] },
		acceptance: { type: ['object', 'null'] },
		pendingPrerequisites: list(
			obj({ ...of(['id', 'owner', 'producer', 'status'], str), observed: nstr })
		),
		pathMapping: obj(of(['agreed', 'phase1', 'jointIntegration'], str)),
	}),
};

const typeOf = (v) =>
	v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v;
const typeOk = (allowed, v) =>
	[allowed].flat().some((t) => t === typeOf(v) || (t === 'number' && typeOf(v) === 'integer'));

/** Every way `value` fails `schema` (the JSON Schema subset the handoff uses), as `path: problem`. */
export function validateHandoff(value, schema = HANDOFF_SCHEMA, at = '$', problems = []) {
	const note = (message) => problems.push(`${at}: ${message}`);
	if ('const' in schema && value !== schema.const) note(`expected ${JSON.stringify(schema.const)}`);
	if (schema.enum && !schema.enum.includes(value)) note(`not one of ${schema.enum.join(', ')}`);
	if (schema.type && !typeOk(schema.type, value)) {
		note(`expected ${[schema.type].flat().join(' or ')}`);
		return problems;
	}
	if (typeof value === 'string') {
		if (schema.pattern && !new RegExp(schema.pattern).test(value))
			note(`does not match ${schema.pattern}`);
	} else if (typeof value === 'number') {
		if (schema.minimum !== undefined && value < schema.minimum) note(`below ${schema.minimum}`);
	} else if (Array.isArray(value)) {
		if (schema.minItems && value.length < schema.minItems)
			note(`fewer than ${schema.minItems} items`);
		if (schema.items)
			value.forEach((item, i) => validateHandoff(item, schema.items, `${at}[${i}]`, problems));
	} else if (value && typeof value === 'object') {
		for (const key of schema.required ?? []) if (!(key in value)) note(`missing ${key}`);
		for (const [key, member] of Object.entries(value)) {
			const sub = schema.properties?.[key];
			if (sub) validateHandoff(member, sub, `${at}.${key}`, problems);
			else if (schema.additionalProperties === false) note(`unexpected ${key}`);
		}
	}
	return problems;
}

const ABSOLUTE = /^(\/|[A-Za-z]:[\\/]|\\\\|file:\/\/|~[\\/])/;
/** The JSON path of every string in `value` that is an absolute path. */
export function findAbsolutePaths(value, at = '$', found = []) {
	if (typeof value === 'string') {
		if (ABSOLUTE.test(value)) found.push(at);
	} else if (Array.isArray(value)) {
		value.forEach((v, i) => findAbsolutePaths(v, `${at}[${i}]`, found));
	} else if (value && typeof value === 'object') {
		for (const [k, v] of Object.entries(value)) findAbsolutePaths(v, `${at}.${k}`, found);
	}
	return found;
}

/** Refuse a manifest by name before it is written: schema, absolute or private paths, secrets. */
export function assertPublishable(manifest) {
	const problems = validateHandoff(manifest);
	if (problems.length) refuse('schema', problems.join('; '));
	const absolute = findAbsolutePaths(manifest);
	if (absolute.length) refuse('absolute-path', `absolute paths at ${absolute.join(', ')}`);
	const text = JSON.stringify(manifest);
	const canaries = findCanaries(text, [os.homedir(), os.tmpdir(), path.resolve(REPO_ROOT, '..')]);
	if (canaries.length) refuse('secret', `the manifest carries ${canaries.join(', ')}`);
	if (redactSecrets(text).redacted) refuse('secret', 'the manifest carries a secret-shaped value');
	return manifest;
}

export const serializeHandoff = (manifest) => `${JSON.stringify(manifest, null, '\t')}\n`;

export function main(argv = process.argv.slice(2)) {
	let values;
	try {
		const options = {
			...of(['library', 'pin', 'joint', 'agreement', 'enforceability'], str),
			...of(['check', 'json'], { type: 'boolean', default: false }),
			out: { ...str, default: DEFAULT_OUT_FILE },
			stage: { ...str, default: 'full' },
		};
		values = parseArgs({ args: argv, strict: true, options }).values;
	} catch (error) {
		refuse('usage', error.message);
	}
	const manifest = assertPublishable(buildHandoff(values));
	const text = serializeHandoff(manifest);
	const outFile = path.resolve(REPO_ROOT, values.out);
	const relative = posix(path.relative(REPO_ROOT, outFile));
	if (values.json) process.stdout.write(text);
	if (values.check) {
		const same = fs.existsSync(outFile) && fs.readFileSync(outFile, 'utf8') === text;
		if (!values.json)
			process.stdout.write(`${relative} ${same ? 'is current' : 'differs or is missing'}\n`);
		return same ? 0 : 1;
	}
	fs.mkdirSync(path.dirname(outFile), { recursive: true });
	fs.writeFileSync(outFile, text);
	const { repositoryRevision: rev, sourceTreeDigest: tree, artifacts } = manifest;
	if (!values.json) {
		process.stdout.write(
			`wrote ${relative} (revision ${rev.slice(0, 9)}, sourceTreeDigest ${tree.slice(0, 12)}, library ${artifacts[0].status})\n`
		);
	}
	return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	try {
		process.exitCode = main();
	} catch (error) {
		if (!(error instanceof HandoffRefusal)) throw error;
		process.stderr.write(`write-mega-maestro-handoff refused (${error.code}): ${error.message}\n`);
		process.exitCode = 2;
	}
}
