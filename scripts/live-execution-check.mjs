#!/usr/bin/env node
/**
 * Run the live execution check (`runLiveExecutionCheck` in
 * `src/shared/maestro-lib/managed/live-execution-check.ts`) from a PACKAGED
 * Maestro runtime archive against a live endpoint socket, and print the
 * observation as JSON. Built for the installed Linux protected service in
 * Mega's Linux pair container (decision D5), run as its unprivileged
 * `maestro` account with this checkout mounted read-only:
 *
 *   node /maestro/scripts/live-execution-check.mjs \
 *     --runtime /maestro/dist/mega-maestro-runtime/<version>/<sha256>/runtime.tgz \
 *     --sha256 <archive sha256> --request <request.json> \
 *     [--socket /var/lib/mega-maestro-endpoint/run/ipc.sock] [--out <file>] \
 *     [--identity <identity.json>] [--work-dir <dir>] \
 *     [--approval-timeout-ms 600000] [--authority-timeout-ms 60000]
 *
 * Node builtins only: no Electron, no native module, nothing from
 * node_modules. Every Maestro module it runs is the archive's
 * `package/library/index.js`, extracted into a fresh temporary directory
 * after the archive's sha256 is checked; this file only loads it and writes
 * the result. Nothing is written beside this script or anywhere under the
 * checkout: `--out` and `--work-dir` must lie outside it.
 *
 * `--request` holds what the check cannot and must not invent:
 *   {
 *     "authority": { "delegation": { "grant": {...}, "chain": [...] }, "grants": [...] },
 *     "execution": { "provider", "model", "agentId", "contentRef", "contentSha256", "resourceIds" },
 *     "workflow":  { "workflowId", "workflowVersion", "triggerId", ... }   (optional)
 *   }
 * The delegation and grants are the central API's, issued to this actor.
 *
 * `--identity` names the ENROLLED installation and runtime
 * ({ installationId, runtimeId, processEpoch }): the central registration
 * challenge accepts only the enrolled runtime, and an attachment must name the
 * enrolled installation. Without it the attachment is `installationIdentity()`
 * of this host, which only an unenrolled endpoint accepts.
 *
 * Registration approval is a file handshake in the work dir: on a challenge
 * the check writes `challenge.json` (mode 0600, the challenge the operator
 * approves) and waits for `approval.json` naming the same `challengeId`.
 *
 * The delegation a live claim accepts is issued to the REGISTRATION, so it
 * exists only after the redeem, while `runLiveExecutionCheck` reads its
 * authority when it starts. So the check runs up to two passes in this
 * process. The first registers and presents the request file's authority. If
 * it registered and then failed at `workflow_claim`, the check waits for
 * `authority.json` in the work dir ({ challengeId, authority: { delegation,
 * grants } }, naming the first pass's challenge) and runs a second pass on a
 * new connection with that authority and a fresh trigger, run and attempt. The
 * observation is the last pass's; `passes` lists each. The endpoint registers
 * an enrolled runtime once, so a run that fails after its redeem needs a new
 * operator session.
 *
 * Each pass uses ONE idempotency key for its claim, execution, settle and
 * release: the endpoint admits an execution only under its lease's key and
 * settles the effect recorded under it.
 *
 * The check never settles a dispatched effect: the endpoint settles it
 * centrally before it answers, and the check only releases. An `unknown`
 * receipt is settled `uncertain` and the owner stays held.
 *
 * Exit: 0 the check passed, 1 it ran and a step failed (the observation says
 * which), 2 usage or a refused input (nothing was sent).
 */

import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { gunzipSync } from 'node:zlib';

export const OBSERVATION_DRIVER = 'scripts/live-execution-check.mjs';
export const DEFAULT_SOCKET = '/var/lib/mega-maestro-endpoint/run/ipc.sock';
const SELF = fileURLToPath(import.meta.url);
const CHECKOUT = path.resolve(path.dirname(SELF), '..');

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const inside = (child, parent) => {
	const rel = path.relative(parent, child);
	return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/** The regular files and directories of a ustar stream, under `into`; anything else is refused. */
export function extractTar(tar, into) {
	for (let offset = 0; offset + 512 <= tar.length; ) {
		const header = tar.subarray(offset, offset + 512);
		if (header.every((byte) => byte === 0)) break;
		const text = (start, length) =>
			header
				.subarray(start, start + length)
				.toString('utf8')
				.replace(/\0.*$/s, '');
		const name = [text(345, 155), text(0, 100)].filter(Boolean).join('/');
		const size = Number.parseInt(text(124, 12).trim() || '0', 8);
		const type = text(156, 1) || '0';
		const target = path.resolve(into, name);
		if (!inside(target, into) || name.includes('\\')) throw new Error(`unsafe entry ${name}`);
		if (type === '5') fs.mkdirSync(target, { recursive: true });
		else if (type === '0') {
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.writeFileSync(target, tar.subarray(offset + 512, offset + 512 + size));
		} else throw new Error(`entry ${name} is not a file or directory (type ${type})`);
		offset += 512 + Math.ceil(size / 512) * 512;
	}
}

export function parse(argv) {
	const { values } = parseArgs({
		args: argv,
		options: {
			runtime: { type: 'string' },
			sha256: { type: 'string' },
			request: { type: 'string' },
			socket: { type: 'string', default: DEFAULT_SOCKET },
			out: { type: 'string' },
			'work-dir': { type: 'string' },
			identity: { type: 'string' },
			'approval-timeout-ms': { type: 'string', default: '600000' },
			'authority-timeout-ms': { type: 'string', default: '60000' },
		},
		strict: true,
	});
	for (const key of ['runtime', 'sha256', 'request'])
		if (!values[key]) throw new Error(`--${key} is required`);
	if (!/^[a-f0-9]{64}$/.test(values.sha256))
		throw new Error('--sha256 is 64 lowercase hex characters');
	const approvalMs = Number(values['approval-timeout-ms']);
	if (!Number.isSafeInteger(approvalMs) || approvalMs < 0)
		throw new Error('--approval-timeout-ms is a whole number of milliseconds');
	const authorityMs = Number(values['authority-timeout-ms']);
	if (!Number.isSafeInteger(authorityMs) || authorityMs < 0)
		throw new Error('--authority-timeout-ms is a whole number of milliseconds');
	const out = values.out ? path.resolve(values.out) : null;
	const workDir = values['work-dir'] ? path.resolve(values['work-dir']) : null;
	for (const [flag, file] of [
		['--out', out],
		['--work-dir', workDir],
	])
		if (file && inside(file, CHECKOUT))
			throw new Error(`${flag} must lie outside the checkout (${CHECKOUT} is read-only)`);
	return {
		runtime: path.resolve(values.runtime),
		sha256: values.sha256,
		request: path.resolve(values.request),
		identity: values.identity ? path.resolve(values.identity) : null,
		socket: values.socket,
		out,
		workDir,
		approvalMs,
		authorityMs,
	};
}

/** The archive, checked by sha256 (and its sidecar when present), extracted, and its library loaded. */
export function loadRuntime(archive, expected, workDir) {
	const bytes = fs.readFileSync(archive);
	const actual = sha256(bytes);
	if (actual !== expected) throw new Error(`the runtime archive is ${actual}, not ${expected}`);
	const sidecar = `${archive}.sha256`;
	if (fs.existsSync(sidecar) && !fs.readFileSync(sidecar, 'utf8').startsWith(expected))
		throw new Error('the runtime archive sidecar does not name the archive');
	const into = path.join(workDir, 'runtime');
	fs.mkdirSync(into, { recursive: true });
	extractTar(gunzipSync(bytes), into);
	const entry = path.join(into, 'package', 'library', 'index.js');
	const lib = createRequire(entry)(entry);
	const pinFile = path.join(into, 'package', 'contracts', 'contracts.pin.json');
	const pin = fs.existsSync(pinFile) ? JSON.parse(fs.readFileSync(pinFile, 'utf8')) : null;
	return {
		lib,
		identity: {
			archive: { path: archive, sha256: actual, bytes: bytes.length },
			library: lib.MAESTRO_LIB_VERSION,
			endpointProtocol: lib.LOCAL_ENDPOINT_PROTOCOL,
			contracts: pin ? { name: pin.name, version: pin.version, sha256: pin.sha256 } : null,
		},
	};
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The enrolled identity an attachment and challenge must name, from `--identity`. */
export function readIdentity(file) {
	const identity = JSON.parse(fs.readFileSync(file, 'utf8'));
	for (const key of ['installationId', 'runtimeId', 'processEpoch'])
		if (typeof identity?.[key] !== 'string' || identity[key] === '')
			throw new Error(`--identity has no ${key}`);
	return {
		installationId: identity.installationId,
		runtimeId: identity.runtimeId,
		processEpoch: identity.processEpoch,
	};
}

/** True when a failed pass registered on this process and then stopped at the claim. */
export function needsIssuedAuthority(observation) {
	return (
		observation.outcome === 'failed' &&
		observation.failure?.step === 'workflow_claim' &&
		observation.steps.some((s) => s.step === 'registration_redeem' && s.status === 'ok')
	);
}

/** The operator's delegation to this registration: authority.json naming the challenge, bounded. */
export async function issuedAuthority(workDir, challengeId, timeoutMs, pollMs = 200) {
	const file = path.join(workDir, 'authority.json');
	for (const deadline = Date.now() + timeoutMs; ; await wait(pollMs)) {
		if (fs.existsSync(file)) {
			const issued = JSON.parse(fs.readFileSync(file, 'utf8'));
			if (issued?.challengeId !== challengeId)
				throw new Error(
					`authority.json names challenge ${issued?.challengeId}, not ${challengeId}`
				);
			if (!issued.authority?.delegation || !Array.isArray(issued.authority.grants))
				throw new Error('authority.json has no authority.delegation and authority.grants');
			return issued;
		}
		if (Date.now() >= deadline) return null;
	}
}

/** The approval handshake: challenge.json out (0600), approval.json in, bounded. */
function fileApproval(workDir, timeoutMs, onChallenge) {
	return async (challenge) => {
		onChallenge?.(challenge);
		const challengeFile = path.join(workDir, 'challenge.json');
		const approvalFile = path.join(workDir, 'approval.json');
		fs.writeFileSync(challengeFile, JSON.stringify(challenge), { mode: 0o600 });
		process.stderr.write(
			`registration challenge ${challenge.challengeId} written to ${challengeFile}; waiting for ${approvalFile}\n`
		);
		const deadline = Date.now() + timeoutMs;
		try {
			while (Date.now() < deadline) {
				if (fs.existsSync(approvalFile)) {
					const approval = JSON.parse(fs.readFileSync(approvalFile, 'utf8'));
					return approval.challengeId === challenge.challengeId;
				}
				await wait(250);
			}
			return false;
		} finally {
			fs.rmSync(challengeFile, { force: true });
		}
	};
}

export async function main(argv = process.argv.slice(2)) {
	let args;
	let request;
	let enrolled = null;
	try {
		args = parse(argv);
		request = JSON.parse(fs.readFileSync(args.request, 'utf8'));
		if (!request?.authority?.delegation || !Array.isArray(request?.authority?.grants))
			throw new Error('--request has no authority.delegation and authority.grants');
		if (!request.execution) throw new Error('--request has no execution');
		if (args.identity) enrolled = readIdentity(args.identity);
	} catch (error) {
		process.stderr.write(`${error.message}\n`);
		return 2;
	}
	const workDir = args.workDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-live-check-'));
	fs.mkdirSync(workDir, { recursive: true, mode: 0o700 });
	let runtime;
	try {
		runtime = loadRuntime(args.runtime, args.sha256, workDir);
	} catch (error) {
		process.stderr.write(`refused: ${error.message}\n`);
		return 2;
	}
	const { lib } = runtime;
	const startedAt = new Date().toISOString();
	const installation =
		enrolled ??
		lib.installationIdentity({
			hostname: os.hostname(),
			productionDataDir: workDir,
			mode: 'live-check',
			pid: process.pid,
			startedAt,
		});
	const attachment = {
		installationId: installation.installationId,
		runtimeId: installation.runtimeId,
		processEpoch: installation.processEpoch,
		components: [{ id: 'maestro-runtime', kind: 'runtime', version: lib.MAESTRO_LIB_VERSION }],
		supportedProtocols: [lib.LOCAL_ENDPOINT_PROTOCOL],
		// workflow_renew is asked for here because the pinned library's LIVE_EXECUTION_CAPABILITIES omits it, so the endpoint never negotiates the renew step.
		supportedCapabilities: [
			'attachment',
			'compatibility',
			...lib.LIVE_EXECUTION_CAPABILITIES,
			'workflow_renew',
		],
		requiredCapabilities: [],
	};
	const workflow = request.workflow ?? {};
	let challengeId = null;
	const approve =
		args.approvalMs > 0
			? fileApproval(workDir, args.approvalMs, (challenge) => {
					challengeId = challenge.challengeId;
				})
			: undefined;
	/** One pass on a new connection; the first keeps the request file's run ids, a second gets fresh ones. */
	const pass = async (authority, first) => {
		const ids = first ? workflow : {};
		const runId = ids.runId ?? `run-${randomUUID()}`;
		// One key for the claim, execution, settle and release of this pass.
		const key = `live-${randomUUID()}`;
		const port = lib.createLocalEndpointClient({ socketPath: args.socket });
		try {
			return await lib.runLiveExecutionCheck({
				port,
				attachment,
				authority,
				approve,
				workflow: {
					workflowId: workflow.workflowId ?? 'maestro-live-execution-check',
					workflowVersion: workflow.workflowVersion ?? 'v1',
					triggerId: ids.triggerId ?? `trigger-${randomUUID()}`,
					runId,
					attemptId: ids.attemptId ?? `attempt-${randomUUID()}`,
					rootRunId: ids.rootRunId ?? runId,
					parentRunId: ids.parentRunId ?? null,
					...(workflow.policyRevision === undefined
						? {}
						: { policyRevision: workflow.policyRevision }),
					requestedLeaseMs: workflow.requestedLeaseMs ?? 120_000,
				},
				execution: {
					requestId: randomUUID(),
					source: 'headless',
					resourceIds: [],
					...request.execution,
					idempotencyKey: key,
				},
				newId: () => key,
			});
		} finally {
			await port.close();
		}
	};
	const summary = (n, source, o) => ({
		pass: n,
		authority: source,
		outcome: o.outcome,
		failure: o.failure ?? null,
		steps: o.steps,
	});
	let observation = await pass(request.authority, true);
	const passes = [summary(1, 'request', observation)];
	if (needsIssuedAuthority(observation) && challengeId && args.authorityMs > 0) {
		let issued = null;
		try {
			issued = await issuedAuthority(workDir, challengeId, args.authorityMs);
			if (!issued) passes.push({ pass: 2, refused: 'no authority.json from the operator in time' });
		} catch (error) {
			passes.push({ pass: 2, refused: error.message });
		}
		if (issued) {
			observation = await pass(issued.authority, false);
			passes.push(summary(2, 'authority.json', observation));
		}
	}
	const report = {
		...observation,
		driver: { path: OBSERVATION_DRIVER, sha256: sha256(fs.readFileSync(SELF)) },
		host: {
			platform: process.platform,
			arch: process.arch,
			node: process.version,
			uid: typeof process.getuid === 'function' ? process.getuid() : null,
			user: os.userInfo().username,
		},
		runtime: runtime.identity,
		installation: { ...installation, source: enrolled ? 'identity' : 'installationIdentity' },
		passes,
		request: { path: args.request, sha256: sha256(fs.readFileSync(args.request)) },
		...(args.identity
			? { identity: { path: args.identity, sha256: sha256(fs.readFileSync(args.identity)) } }
			: {}),
		startedAt,
		finishedAt: new Date().toISOString(),
	};
	const text = `${JSON.stringify(report, null, '\t')}\n`;
	if (args.out) fs.writeFileSync(args.out, text, { flag: 'wx', mode: 0o644 });
	process.stdout.write(text);
	return observation.outcome === 'passed' ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
	process.exitCode = await main();
}
