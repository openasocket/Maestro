#!/usr/bin/env node
/**
 * The early real-pair harness: drive the actual Mega-Maestro endpoint with the
 * actual built Maestro library inside an isolated Linux container, and say
 * exactly which producer is missing when the pair cannot be closed.
 *
 *   node scripts/mega-maestro-pair.mjs check [--sibling <dir>] [--artifact <dir>]
 *        [--library dist/maestro-lib] [--image <ref>] [--json]
 *   node scripts/mega-maestro-pair.mjs run   [the same] [--allow-dirty] [--allow-stale]
 *        [--approve-command <cmd>] [--timeout-ms <n>] [--out <evidence.json>] [--keep]
 *
 * `check` inspects every input of the pair and reports them as one JSON
 * record: the built library (`provenance.json`, its payload digests, whether
 * it was built from this HEAD and from a clean tree), the CP-01 contracts
 * pin, the packaged application artifacts or, failing those, the sibling
 * development checkout (revision, dirtiness, whether the endpoint is built
 * and whether its native peer module exists), the sibling runtime adapter's
 * declared status (CP-02), and the Linux host (Docker, seccomp, the pinned
 * image). It exits 0 when a certifiable pair can run and 2 when a named
 * dependency blocks it; the record is printed either way.
 *
 * `run` stages the endpoint into a scratch folder under the Auto Run working
 * directory, bundles Maestro's own socket client with esbuild, and starts one
 * container (no network, private tmpfs workspace) that builds the endpoint's
 * native peer module, starts the endpoint daemon in development mode, runs a
 * driver that speaks to it through the built library (`installationIdentity`,
 * `createManagedHostAdapter`, the verifier, the dispatch snapshot) and the
 * real `createLocalEndpointClient`, then stops the daemon. What came back is
 * written as evidence with the pins of everything that took part.
 *
 * What the harness never does: fake a runtime, mint a lease, approve its own
 * registration, read a secret, or call a dirty-source or stale build a pair.
 * A run over a dirty endpoint source or a stale library needs the matching
 * `--allow-*` flag and is recorded with `certifiable: false` and the reason.
 * The registration approval belongs to the Mega-Maestro API: when
 * `--approve-command` is given it is run on the host with the challenge on
 * stdin while the driver waits; without it the handshake stops at the
 * challenge and the dependency is named.
 */

import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PAIR_REPORT_VERSION = 1;
export const DEFAULT_LIBRARY_DIR = 'dist/maestro-lib';
export const DEFAULT_PIN_FILE = 'vendor/mega-maestro/contracts.pin.json';
export const DEFAULT_SIBLING_DIR = path.resolve(REPO_ROOT, '..', 'mega-maestro');
export const WORKING_DIR = '.maestro/playbooks/Working';
/** The endpoint's own Linux harness image (`apps/endpoint/src/broker/linux.ts`), by digest. */
export const DEFAULT_IMAGE =
	'node@sha256:71bcbb3b215b3fa84b5b167585675072f4c270855e37a599803f1a58141a0716';
/** The provider the endpoint registers as harness-only (`apps/endpoint/src/providers/registry.ts`). */
export const SYNTHETIC_ENDPOINT_PROVIDER = 'synthetic-node';
export const DEFAULT_RUN_TIMEOUT_MS = 180_000;

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const exists = (file) => fs.existsSync(file);
const git = (dir, args) => {
	try {
		return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
	} catch {
		return null;
	}
};
const docker = (args, options = {}) =>
	spawnSync('docker', args, { encoding: 'utf8', timeout: options.timeout ?? 20_000 });

// ---------------------------------------------------------------------------
// check: every input of the pair, inspected and named
// ---------------------------------------------------------------------------

export function inspectLibrary(dir, headRevision) {
	const file = path.join(dir, 'provenance.json');
	if (!exists(file))
		return { status: 'missing', dir, reason: 'no provenance.json; run npm run build:maestro-lib' };
	const provenance = readJson(file);
	const mismatched = [];
	for (const [name, digest] of Object.entries(provenance.payloadSha256 ?? {})) {
		const target = path.join(dir, name);
		if (!exists(target) || sha256(fs.readFileSync(target)) !== digest) mismatched.push(name);
	}
	const stale = headRevision !== null && provenance.sourceRevision !== headRevision;
	const status = mismatched.length
		? 'mismatch'
		: provenance.sourceDirty
			? 'dirty'
			: stale
				? 'stale'
				: 'ready';
	return {
		status,
		dir,
		version: provenance.version,
		managedContract: provenance.maestroManagedContract,
		sourceRevision: provenance.sourceRevision,
		sourceDirty: provenance.sourceDirty === true,
		headRevision,
		stale,
		payloadFiles: Object.keys(provenance.payloadSha256 ?? {}).length,
		mismatched,
		entrySha256: exists(path.join(dir, 'index.js'))
			? sha256(fs.readFileSync(path.join(dir, 'index.js')))
			: null,
	};
}

export function inspectPin(file) {
	if (!exists(file)) return { status: 'absent', file };
	try {
		const pin = readJson(file);
		return {
			status: 'pinned',
			file,
			digest: pin.digest ?? null,
			sourceRevision: pin.sourceRevision ?? null,
			sourceDirty: pin.sourceDirty ?? null,
		};
	} catch (error) {
		return { status: 'malformed', file, reason: String(error) };
	}
}

/** One packaged application artifact directory (`artifact.json` beside `application.tgz`). */
export function inspectArtifactDir(dir) {
	const manifestFile = path.join(dir, 'artifact.json');
	if (!exists(manifestFile)) return { kind: 'packaged', dir, status: 'no-manifest' };
	const manifest = readJson(manifestFile);
	const archive = path.join(dir, 'application.tgz');
	const sidecar = `${archive}.sha256`;
	const archiveDigest = exists(archive) ? sha256(fs.readFileSync(archive)) : null;
	const sidecarDigest = exists(sidecar)
		? fs.readFileSync(sidecar, 'utf8').trim().split(/\s+/)[0]
		: null;
	const sourceDirty = manifest.sourceDirty === true;
	const linux = manifest.platform === 'linux';
	return {
		kind: 'packaged',
		dir,
		status:
			archiveDigest === null
				? 'no-archive'
				: sidecarDigest !== archiveDigest
					? 'digest-mismatch'
					: sourceDirty
						? 'dirty'
						: linux
							? 'certifiable'
							: 'wrong-platform',
		digest: path.basename(dir),
		archiveSha256: archiveDigest,
		sourceRevision: manifest.sourceRevision ?? manifest.source ?? null,
		sourceDirty,
		platform: manifest.platform ?? null,
		arch: manifest.arch ?? null,
		components: Object.keys(manifest.components ?? {}),
		certifiable: archiveDigest !== null && sidecarDigest === archiveDigest && !sourceDirty && linux,
	};
}

/** The sibling development checkout: never certifiable, but what a development run can stage. */
export function inspectSibling(dir) {
	if (!exists(dir)) return { kind: 'development-checkout', dir, status: 'absent' };
	const revision = git(dir, ['rev-parse', 'HEAD']);
	const dirtyEntries = (git(dir, ['status', '--porcelain']) ?? '')
		.split('\n')
		.filter(Boolean).length;
	const endpoint = path.join(dir, 'apps', 'endpoint');
	const cli = path.join(endpoint, 'dist', 'cli.js');
	const adapterFile = path.join(dir, 'packages', 'runtime-adapter', 'dist', 'maestro.js');
	const adapterText = exists(adapterFile) ? fs.readFileSync(adapterFile, 'utf8') : '';
	const artifactsRoot = path.join(dir, 'artifacts', 'application');
	const artifacts = [];
	if (exists(artifactsRoot)) {
		for (const version of fs.readdirSync(artifactsRoot)) {
			const versionDir = path.join(artifactsRoot, version);
			if (!fs.statSync(versionDir).isDirectory()) continue;
			for (const entry of fs.readdirSync(versionDir)) {
				const candidate = path.join(versionDir, entry);
				if (fs.statSync(candidate).isDirectory()) artifacts.push(inspectArtifactDir(candidate));
			}
		}
	}
	return {
		kind: 'development-checkout',
		dir,
		status: exists(cli) ? 'built' : 'unbuilt',
		revision,
		dirtyEntries,
		dirty: dirtyEntries > 0,
		endpoint: {
			cli,
			builtAt: exists(cli) ? fs.statSync(cli).mtime.toISOString() : null,
			peerNode: exists(path.join(endpoint, 'native', 'peer.node')),
			peerSource: exists(path.join(endpoint, 'native', 'peer.c')),
		},
		adapter: {
			file: adapterFile,
			/** CP-02: the sibling's own declaration, read from its built text, never guessed. */
			status: !adapterText
				? 'absent'
				: /status:\s*["']unsupported["']/.test(adapterText)
					? 'unsupported'
					: 'unknown',
		},
		artifacts,
		certifiable: false,
	};
}

export function inspectLinuxHost(image) {
	const info = docker(['info', '--format', '{{json .}}']);
	if (info.status !== 0)
		return {
			docker: false,
			reason: (info.stderr || info.error?.message || 'docker not available').trim(),
			image: { ref: image, present: false },
		};
	let parsed;
	try {
		parsed = JSON.parse(info.stdout);
	} catch {
		return {
			docker: false,
			reason: 'docker info is not JSON',
			image: { ref: image, present: false },
		};
	}
	const inspect = docker([
		'image',
		'inspect',
		image,
		'--format',
		'{{.Id}} {{.Os}} {{.Architecture}} {{.Created}}',
	]);
	const [id, os, arch, created] = inspect.status === 0 ? inspect.stdout.trim().split(' ') : [];
	const seccompBuiltin = (parsed.SecurityOptions ?? []).some(
		(s) => typeof s === 'string' && s.startsWith('name=seccomp,') && s.includes('profile=builtin')
	);
	return {
		docker: true,
		osType: parsed.OSType,
		serverVersion: parsed.ServerVersion,
		seccompBuiltin,
		linux: parsed.OSType === 'linux' && seccompBuiltin,
		image: {
			ref: image,
			present: inspect.status === 0,
			id: id ?? null,
			os: os ?? null,
			arch: arch ?? null,
			created: created ?? null,
		},
	};
}

/** Which producer blocks a certifiable pair, by its coordination id and owner. */
export function assessPair(report) {
	const dependencies = [];
	const open = (id, owner, detail) => dependencies.push({ id, owner, status: 'open', detail });
	if (report.library.status !== 'ready')
		open('maestro-lib', 'maestro', `built library is ${report.library.status}`);
	if (report.pin.status !== 'pinned')
		open(
			'CP-01',
			'mega-maestro',
			'no clean contracts artifact is pinned (vendor/mega-maestro/contracts.pin.json)'
		);
	const certifiable = report.endpointSources.find((s) => s.certifiable);
	if (!certifiable) {
		const dirty = report.endpointSources.filter(
			(s) => s.kind === 'packaged' && s.sourceDirty
		).length;
		open(
			'CP-01',
			'mega-maestro',
			`no clean Linux application artifact (${dirty} dirty-source packaged artifact(s); development checkout is never certifiable)`
		);
	}
	const checkout = report.endpointSources.find((s) => s.kind === 'development-checkout');
	if (checkout?.adapter?.status !== 'unknown')
		open(
			'CP-02',
			'mega-maestro',
			`runtime adapter createMaestroAdapter is ${checkout?.adapter?.status ?? 'absent'}`
		);
	if (!report.linuxHost.linux)
		open('linux-host', 'maestro', 'no Linux Docker engine with built-in seccomp');
	else if (!report.linuxHost.image.present)
		open(
			'linux-image',
			'maestro',
			`image ${report.linuxHost.image.ref} is not present (pull it explicitly)`
		);
	if (!report.approvalProducer)
		open(
			'registration-approval',
			'mega-maestro',
			'no API/console producer to approve the actor registration (--approve-command)'
		);
	return { ready: dependencies.length === 0, dependencies };
}

export function buildCheckReport(options) {
	const headRevision = git(REPO_ROOT, ['rev-parse', 'HEAD']);
	const endpointSources = [];
	if (options.artifact) endpointSources.push(inspectArtifactDir(path.resolve(options.artifact)));
	const sibling = inspectSibling(path.resolve(options.sibling ?? DEFAULT_SIBLING_DIR));
	if (sibling.status !== 'absent') {
		endpointSources.push(...sibling.artifacts);
		endpointSources.push({ ...sibling, artifacts: undefined });
	}
	const report = {
		reportVersion: PAIR_REPORT_VERSION,
		checkedAt: new Date().toISOString(),
		host: {
			platform: process.platform,
			node: process.version,
			maestroHead: headRevision,
			maestroDirty:
				(git(REPO_ROOT, ['status', '--porcelain']) ?? '')
					.split('\n')
					.filter((l) => l && !/^\?\? /.test(l)).length > 0,
		},
		library: inspectLibrary(path.resolve(options.library ?? DEFAULT_LIBRARY_DIR), headRevision),
		pin: inspectPin(path.resolve(options.pin ?? DEFAULT_PIN_FILE)),
		endpointSources,
		linuxHost: inspectLinuxHost(options.image ?? DEFAULT_IMAGE),
		approvalProducer: Boolean(options.approveCommand),
	};
	report.assessment = assessPair(report);
	return report;
}

// ---------------------------------------------------------------------------
// run: the container exercise
// ---------------------------------------------------------------------------

/** The driver that runs inside the container: the built library plus the real socket client. */
const DRIVER_SOURCE = String.raw`
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const lib = require('/library/index.js');
const { createLocalEndpointClient } = require('/driver/endpoint-client.cjs');
const OUT = process.env.PAIR_OUT;
const out = { driver: 'mega-maestro-pair', platform: process.platform, node: process.version, uid: process.getuid(),
	library: { version: lib.MAESTRO_LIB_VERSION, contract: lib.MANAGED_CONTRACT_VERSION, protocol: lib.LOCAL_ENDPOINT_PROTOCOL }, steps: [] };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function main() {
	const port = createLocalEndpointClient({ socketPath: process.env.PAIR_SOCKET });
	const installation = lib.installationIdentity({ hostname: os.hostname(), productionDataDir: '/work/maestro-data', mode: 'pair', pid: process.pid, startedAt: new Date().toISOString() });
	out.installation = installation;
	const step = async (name, fn) => { const t = Date.now(); let outcome; try { outcome = await fn(); } catch (e) { outcome = { status: 'threw', message: String(e) }; } out.steps.push({ name, ms: Date.now() - t, outcome, connection: port.state() }); return outcome; };
	const components = [{ id: 'maestro-lib', kind: 'runtime', version: lib.MAESTRO_LIB_VERSION }];
	const attach = () => port.attach({ installationId: installation.installationId, runtimeId: installation.runtimeId, processEpoch: installation.processEpoch, components, supportedProtocols: [1], supportedCapabilities: ['attachment', 'compatibility', 'execution', 'telemetry'], requiredCapabilities: [] });
	await step('compatibility', () => port.compatibility({ protocol: 1, components, requiredCapabilities: [] }));
	let status = await step('attach', attach);
	const challenge = await step('registration.challenge', () => port.registration.challenge({ runtimeId: installation.runtimeId, processEpoch: installation.processEpoch }));
	if (challenge.status === 'ok') {
		// The approval code goes to the approval producer once, through a private file, and is never in the evidence.
		const { nonce, ...shown } = challenge.payload;
		fs.writeFileSync(OUT + '/challenge.json', JSON.stringify({ ...shown, nonce }), { mode: 0o600 });
		const deadline = Date.now() + Number(process.env.PAIR_APPROVAL_TIMEOUT_MS || 0);
		while (Date.now() < deadline && !fs.existsSync(OUT + '/approval.json')) await wait(250);
		fs.rmSync(OUT + '/challenge.json', { force: true });
		const approved = fs.existsSync(OUT + '/approval.json');
		out.approval = approved ? 'approved' : 'no-producer';
		if (approved) { await step('registration.redeem', () => port.registration.redeem()); status = await step('attach.registered', attach); }
	}
	const endpointStatus = status.status === 'ok' ? status.payload : null;
	const view = { status: 'ok', reason: null, message: null, record: { version: 1, installationId: installation.installationId, tenantId: 'pair-development', orgId: 'pair-development', enrollmentId: null,
		endpoint: { socketPath: process.env.PAIR_SOCKET, bindingDigest: 'a'.repeat(64), trustRootDigest: null }, management: 'enrolled', registration: null,
		policy: { desiredRevision: endpointStatus?.desiredPolicyRevision ?? null, appliedRevision: endpointStatus?.appliedPolicyRevision ?? null, observedAt: new Date().toISOString() }, enrolledAt: new Date().toISOString(), updatedAt: new Date().toISOString() } };
	const standing = () => { const c = port.state(); const ok = c.attached && c.registration === 'registered' && c.status?.management === 'managed'; return { identity: view, connection: c, endpoint: c.status, authority: ok ? 'registered' : 'none', reason: ok ? null : 'not registered-attached-managed in this process', pendingApproval: null, lastDenial: null }; };
	const adapter = lib.createManagedHostAdapter({ installation, identity: { read: () => view }, endpoint: port, status: standing });
	out.policyStatus = adapter.policyStatus();
	const verifier = lib.createContextVerifier({ verifierId: 'pair-driver', peer: 'in-process', now: Date.now, accept: () => [] });
	const verified = verifier.verify(lib.inProcessContext({ installation, origin: 'headless', actor: { kind: 'service', id: 'pair-harness' }, delegation: { chain: [], grantRef: null },
		identity: { requestId: 'pair-req-1', idempotencyKey: 'pair-key-1', attemptId: 'pair-att-1', runId: 'pair-run-1', rootRunId: 'pair-run-1', parentRunId: null },
		policyRevision: endpointStatus?.appliedPolicyRevision ?? null, workflow: null, traceId: 'pair-trace-1', requestedCapabilities: ['runs.submit'] }));
	if (!verified.ok) throw new Error('context refused: ' + verified.problems.join('; '));
	const snapshot = lib.buildDispatchSnapshot({ command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: '/work', env: {} }, { provider: '${SYNTHETIC_ENDPOINT_PROVIDER}', model: 'synthetic', resourceIds: [] });
	await step('execution.admit', () => adapter.authority.admit({ context: verified.context, snapshot, policy: adapter.policy() }));
	await step('execution.raw', () => port.invoke('execution', { requestId: 'pair-raw-1', attemptId: 'pair-raw-1', runId: 'pair-raw-run', source: 'headless', operation: 'start', arguments: [], resources: [], provider: '${SYNTHETIC_ENDPOINT_PROVIDER}', model: 'synthetic', policyRevision: endpointStatus?.appliedPolicyRevision ?? 0 }));
	out.leases = adapter.authority.live().length;
	out.state = port.state();
	await port.close();
}
main().catch((error) => { out.driverError = String(error && error.stack || error); process.exitCode = 1; }).finally(() => fs.writeFileSync(OUT + '/driver.json', JSON.stringify(out, null, 2)));
`;

const CONTAINER_SCRIPT = String.raw`
set -u
cp -R /endpoint /work/endpoint
cd /work/endpoint && node native/build.mjs > /out/native-build.log 2>&1; echo $? > /out/native-build.exit
ls /work/endpoint/native > /out/native-dir.txt 2>&1
mkdir -p /work/ws /work/maestro-data
# The daemon stays in the foreground: background it and wait for its runtime socket.
node /work/endpoint/dist/cli.js --development --workspace /work/ws start > /out/start.json 2>&1 &
DAEMON=$!
for i in $(seq 1 40); do [ -S /work/ws/.local/endpoint/runtime.sock ] && break; sleep 0.5; done
[ -S /work/ws/.local/endpoint/runtime.sock ]; echo $? > /out/socket.exit
PAIR_SOCKET=/work/ws/.local/endpoint/runtime.sock PAIR_OUT=/out node /driver/driver.cjs > /out/driver.log 2>&1; echo $? > /out/driver.exit
node /work/endpoint/dist/cli.js --development --workspace /work/ws status > /out/status.json 2>&1; echo $? > /out/status.exit
node /work/endpoint/dist/cli.js --development --workspace /work/ws stop > /out/stop.json 2>&1; echo $? > /out/stop.exit
wait $DAEMON; echo $? > /out/start.exit
`;

/** Stage the endpoint and its resolved dependencies from the development checkout (symlinks resolved, sources left behind). */
function stageEndpointFromCheckout(sibling, into) {
	const from = path.join(sibling, 'apps', 'endpoint');
	const skip = /(^|\/)(src|test|\.local|\.git)(\/|$)/;
	fs.cpSync(from, into, {
		recursive: true,
		dereference: true,
		filter: (src) => !skip.test(path.relative(from, src)),
	});
}

function stageEndpointFromArtifact(artifactDir, into) {
	const extracted = path.join(into, '..', 'artifact');
	fs.mkdirSync(extracted, { recursive: true });
	execFileSync('tar', ['-xzf', path.join(artifactDir, 'application.tgz'), '-C', extracted]);
	const found = fs
		.readdirSync(extracted, { recursive: true })
		.map(String)
		.find((p) => p.endsWith(path.join('endpoint', 'dist', 'cli.js')));
	if (!found) throw new Error('the application artifact has no endpoint/dist/cli.js');
	fs.cpSync(path.join(extracted, found, '..', '..'), into, { recursive: true, dereference: true });
}

async function bundleClient(into) {
	const esbuild = await import('esbuild');
	fs.mkdirSync(into, { recursive: true });
	await esbuild.build({
		entryPoints: [path.join(REPO_ROOT, 'src', 'main', 'enterprise', 'endpoint-client.ts')],
		bundle: true,
		platform: 'node',
		target: 'node20',
		format: 'cjs',
		logLevel: 'silent',
		outfile: path.join(into, 'endpoint-client.cjs'),
	});
	fs.writeFileSync(path.join(into, 'driver.cjs'), DRIVER_SOURCE);
	return {
		clientSha256: sha256(fs.readFileSync(path.join(into, 'endpoint-client.cjs'))),
		driverSha256: sha256(DRIVER_SOURCE),
	};
}

/** Run the approval producer on the host once the driver has handed the challenge over. */
function watchForChallenge(outDir, command, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	const timer = setInterval(() => {
		const file = path.join(outDir, 'challenge.json');
		if (Date.now() > deadline) clearInterval(timer);
		if (!exists(file)) return;
		clearInterval(timer);
		const result = spawnSync(command, {
			shell: true,
			input: fs.readFileSync(file),
			encoding: 'utf8',
			timeout: timeoutMs,
		});
		if (result.status === 0)
			fs.writeFileSync(
				path.join(outDir, 'approval.json'),
				JSON.stringify({ approvedAt: new Date().toISOString() })
			);
	}, 250);
	return () => clearInterval(timer);
}

const readOut = (dir, name) => {
	const file = path.join(dir, name);
	if (!exists(file)) return null;
	const text = fs.readFileSync(file, 'utf8').trim();
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
};

export async function runPair(options) {
	const report = buildCheckReport(options);
	const source = options.artifact
		? report.endpointSources[0]
		: (report.endpointSources.find((s) => s.certifiable) ??
			report.endpointSources.find(
				(s) => s.kind === 'development-checkout' && s.status === 'built'
			));
	const refusals = [];
	if (!source)
		refusals.push('no endpoint source: no clean artifact and no built development checkout');
	if (source && !source.certifiable && !options.allowDirty)
		refusals.push(
			`endpoint source is not certifiable (${source.status}); pass --allow-dirty for a labeled development run`
		);
	if (report.library.status === 'stale' && !options.allowStale)
		refusals.push('the built library is not from this HEAD; rebuild it or pass --allow-stale');
	if (report.library.status !== 'ready' && report.library.status !== 'stale')
		refusals.push(`the built library is ${report.library.status}`);
	if (!report.linuxHost.linux || !report.linuxHost.image.present)
		refusals.push('no Linux engine or the pinned image is absent');
	if (refusals.length) return { ...report, run: { status: 'refused', refusals } };

	const stamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15);
	const workspace = path.resolve(REPO_ROOT, WORKING_DIR, `pair-${stamp}`);
	const endpointDir = path.join(workspace, 'endpoint');
	const driverDir = path.join(workspace, 'driver');
	const outDir = path.join(workspace, 'out');
	for (const dir of [workspace, outDir]) fs.mkdirSync(dir, { recursive: true });
	if (source.kind === 'packaged') stageEndpointFromArtifact(source.dir, endpointDir);
	else stageEndpointFromCheckout(source.dir, endpointDir);
	const bundle = await bundleClient(driverDir);
	const timeoutMs = options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
	const stopWatching = options.approveCommand
		? watchForChallenge(outDir, options.approveCommand, timeoutMs)
		: () => undefined;
	const args = [
		'run',
		'--rm',
		'--network=none',
		'--pids-limit=256',
		'--memory=1g',
		'--tmpfs',
		'/work:rw,exec,size=512m',
		'-v',
		`${path.resolve(options.library ?? DEFAULT_LIBRARY_DIR)}:/library:ro`,
		'-v',
		`${endpointDir}:/endpoint:ro`,
		'-v',
		`${driverDir}:/driver:ro`,
		'-v',
		`${outDir}:/out:rw`,
		'-e',
		'NODE_ENV=development',
		'-e',
		`PAIR_APPROVAL_TIMEOUT_MS=${options.approveCommand ? timeoutMs : 0}`,
		'-w',
		'/work',
		options.image ?? DEFAULT_IMAGE,
		'sh',
		'-c',
		CONTAINER_SCRIPT,
	];
	const startedAt = new Date().toISOString();
	const container = docker(args, { timeout: timeoutMs + 30_000 });
	stopWatching();
	const run = {
		status:
			container.status === 0
				? 'completed'
				: container.error
					? 'container-failed'
					: 'container-nonzero',
		certifiable: source.certifiable && report.library.status === 'ready',
		notCertifiableBecause: [
			...(source.certifiable ? [] : [`endpoint source ${source.kind} is ${source.status} (CP-01)`]),
			...(report.library.status === 'ready' ? [] : [`library is ${report.library.status}`]),
		],
		startedAt,
		endedAt: new Date().toISOString(),
		workspace,
		image: report.linuxHost.image,
		source: {
			kind: source.kind,
			dir: source.dir,
			revision: source.sourceRevision ?? source.revision ?? null,
			dirty: source.sourceDirty ?? source.dirty ?? null,
			digest: source.digest ?? null,
		},
		bundle,
		containerExit: container.status,
		containerError: container.error?.message ?? null,
		containerStderr: (container.stderr ?? '').slice(-4000),
		observed: {
			nativeBuild: {
				exit: readOut(outDir, 'native-build.exit'),
				log: readOut(outDir, 'native-build.log'),
				dir: readOut(outDir, 'native-dir.txt'),
			},
			start: {
				exit: readOut(outDir, 'start.exit'),
				answer: readOut(outDir, 'start.json'),
				socket: readOut(outDir, 'socket.exit'),
			},
			driver: {
				exit: readOut(outDir, 'driver.exit'),
				log: readOut(outDir, 'driver.log'),
				result: readOut(outDir, 'driver.json'),
				approval: options.approveCommand
					? exists(path.join(outDir, 'approval.json'))
					: 'no-producer',
			},
			status: { exit: readOut(outDir, 'status.exit'), answer: readOut(outDir, 'status.json') },
			stop: { exit: readOut(outDir, 'stop.exit'), answer: readOut(outDir, 'stop.json') },
		},
	};
	fs.rmSync(path.join(outDir, 'challenge.json'), { force: true });
	if (!options.keep) {
		fs.rmSync(endpointDir, { recursive: true, force: true });
		fs.rmSync(path.join(workspace, 'artifact'), { recursive: true, force: true });
	}
	return { ...report, run };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export async function main(argv) {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			sibling: { type: 'string' },
			artifact: { type: 'string' },
			library: { type: 'string' },
			pin: { type: 'string' },
			image: { type: 'string' },
			'approve-command': { type: 'string' },
			'timeout-ms': { type: 'string' },
			out: { type: 'string' },
			'allow-dirty': { type: 'boolean' },
			'allow-stale': { type: 'boolean' },
			keep: { type: 'boolean' },
			json: { type: 'boolean' },
			help: { type: 'boolean' },
		},
	});
	const command = positionals[0];
	if (values.help || !['check', 'run'].includes(command)) {
		process.stdout.write(
			'usage: mega-maestro-pair.mjs check|run [--sibling DIR] [--artifact DIR] [--library DIR] [--image REF] [--approve-command CMD] [--allow-dirty] [--allow-stale] [--timeout-ms N] [--out FILE] [--keep] [--json]\n'
		);
		return values.help ? 0 : 2;
	}
	const options = {
		sibling: values.sibling,
		artifact: values.artifact,
		library: values.library,
		pin: values.pin,
		image: values.image,
		approveCommand: values['approve-command'],
		timeoutMs: values['timeout-ms'] ? Number(values['timeout-ms']) : undefined,
		allowDirty: values['allow-dirty'] === true,
		allowStale: values['allow-stale'] === true,
		keep: values.keep === true,
	};
	const report = command === 'check' ? buildCheckReport(options) : await runPair(options);
	const text = JSON.stringify(report, null, 2);
	if (values.out) fs.writeFileSync(values.out, text + '\n');
	process.stdout.write(text + '\n');
	if (command === 'check') return report.assessment.ready ? 0 : 2;
	return report.run.status === 'completed' ? (report.run.certifiable ? 0 : 3) : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main(process.argv.slice(2)).then(
		(code) => {
			process.exitCode = code;
		},
		(error) => {
			process.stderr.write(`${error?.stack ?? error}\n`);
			process.exitCode = 1;
		}
	);
}
