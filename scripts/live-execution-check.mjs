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
 *     [--work-dir <dir>] [--approval-timeout-ms 600000] \
 *     [--effect uncertain|completed|no_effect --evidence-file <file>]
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
 * Registration approval is a file handshake in the work dir: on a challenge
 * the check writes `challenge.json` (mode 0600, the challenge the operator
 * approves) and waits for `approval.json` naming the same `challengeId`.
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
			'approval-timeout-ms': { type: 'string', default: '600000' },
			effect: { type: 'string', default: 'uncertain' },
			'evidence-file': { type: 'string' },
		},
		strict: true,
	});
	for (const key of ['runtime', 'sha256', 'request'])
		if (!values[key]) throw new Error(`--${key} is required`);
	if (!/^[a-f0-9]{64}$/.test(values.sha256))
		throw new Error('--sha256 is 64 lowercase hex characters');
	if (!['uncertain', 'completed', 'no_effect'].includes(values.effect))
		throw new Error('--effect is uncertain, completed or no_effect');
	if (values.effect !== 'uncertain' && !values['evidence-file'])
		throw new Error(`--effect ${values.effect} needs --evidence-file (the digest it settles with)`);
	const approvalMs = Number(values['approval-timeout-ms']);
	if (!Number.isSafeInteger(approvalMs) || approvalMs < 0)
		throw new Error('--approval-timeout-ms is a whole number of milliseconds');
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
		socket: values.socket,
		out,
		workDir,
		approvalMs,
		effect: values.effect,
		evidenceFile: values['evidence-file'] ? path.resolve(values['evidence-file']) : null,
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

/** The approval handshake: challenge.json out (0600), approval.json in, bounded. */
function fileApproval(workDir, timeoutMs) {
	return async (challenge) => {
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
	try {
		args = parse(argv);
		request = JSON.parse(fs.readFileSync(args.request, 'utf8'));
		if (!request?.authority?.delegation || !Array.isArray(request?.authority?.grants))
			throw new Error('--request has no authority.delegation and authority.grants');
		if (!request.execution) throw new Error('--request has no execution');
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
	const installation = lib.installationIdentity({
		hostname: os.hostname(),
		productionDataDir: workDir,
		mode: 'live-check',
		pid: process.pid,
		startedAt,
	});
	const workflow = request.workflow ?? {};
	const runId = workflow.runId ?? `run-${randomUUID()}`;
	const effect =
		args.effect === 'uncertain'
			? { state: 'uncertain', reason: 'recovery_required' }
			: {
					state: 'settled',
					outcome: args.effect,
					evidenceDigest: sha256(fs.readFileSync(args.evidenceFile)),
				};
	const port = lib.createLocalEndpointClient({ socketPath: args.socket });
	let observation;
	try {
		observation = await lib.runLiveExecutionCheck({
			port,
			attachment: {
				...installation,
				components: [{ id: 'maestro-runtime', kind: 'runtime', version: lib.MAESTRO_LIB_VERSION }],
				supportedProtocols: [lib.LOCAL_ENDPOINT_PROTOCOL],
				supportedCapabilities: ['attachment', 'compatibility', ...lib.LIVE_EXECUTION_CAPABILITIES],
				requiredCapabilities: [],
			},
			authority: request.authority,
			approve: args.approvalMs > 0 ? fileApproval(workDir, args.approvalMs) : undefined,
			workflow: {
				workflowId: workflow.workflowId ?? 'maestro-live-execution-check',
				workflowVersion: workflow.workflowVersion ?? 'v1',
				triggerId: workflow.triggerId ?? `trigger-${randomUUID()}`,
				runId,
				attemptId: workflow.attemptId ?? `attempt-${randomUUID()}`,
				rootRunId: workflow.rootRunId ?? runId,
				parentRunId: workflow.parentRunId ?? null,
				...(workflow.policyRevision === undefined
					? {}
					: { policyRevision: workflow.policyRevision }),
				requestedLeaseMs: workflow.requestedLeaseMs ?? 120_000,
			},
			execution: {
				requestId: randomUUID(),
				source: 'headless',
				resourceIds: [],
				idempotencyKey: `exec-${randomUUID()}`,
				...request.execution,
			},
			effect,
			newId: () => `live-${randomUUID()}`,
		});
	} finally {
		await port.close();
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
		installation,
		request: { path: args.request, sha256: sha256(fs.readFileSync(args.request)) },
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
