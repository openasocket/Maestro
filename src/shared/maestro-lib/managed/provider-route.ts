/**
 * The one qualified synthetic harness route: a declared, harmless Node
 * program run through the protected dispatch with its files and its egress
 * constrained by the Node permission model, so that an admission, a lease,
 * a spawn, a denial before any effect and an independently observed effect
 * can be exercised end to end on this host without a real provider.
 *
 * What this route IS: `node --permission` over an inline script, allowed to
 * read exactly the declared input files, allowed to write exactly its own
 * private working directory, and nothing else. Under the permission model
 * the runtime itself refuses the network (`ERR_ACCESS_DENIED`, no
 * `--allow-net`), a child process, a worker, an addon and any file outside
 * the grants; the refusal comes from the runtime, not from the script
 * agreeing to behave. The bounds mirror the endpoint's own container
 * harness (`apps/endpoint/src/broker/linux.ts`): a script of at most 32 KiB
 * with no NUL, at most 32 canonical regular input files, a timeout of 1 ms
 * to 60 s.
 *
 * What this route is NOT: a qualification of Claude, Codex, OpenCode or any
 * other provider, of any descendant they start, or of the Node permission
 * model as an OS boundary. `syntheticHarnessRouteSupport()` says exactly
 * that: one provider id (`synthetic-harness`), one route id, enforcement
 * named per effect, and `qualifies` naming the harness capability alone. A
 * caller that reads `unsupported` (a Node without the permission flags, a
 * Windows host) refuses; it never falls back to an unconstrained spawn.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ProviderRouteSupport } from '../providers/capabilities';
import type { TurnProcessSpec } from '../run/start-turn';

export const SYNTHETIC_HARNESS_PROVIDER = 'synthetic-harness';
export const SYNTHETIC_HARNESS_MODEL = 'synthetic';
export const SYNTHETIC_HARNESS_ROUTE_ID = 'synthetic-harness/node-permission-v1';

/** The same bounds the endpoint's container harness applies to its own synthetic programs. */
export const HARNESS_LIMITS = Object.freeze({
	scriptBytes: 32_768,
	inputs: 32,
	timeoutMinMs: 1,
	timeoutMaxMs: 60_000,
	stdinBytes: 65_536,
});

/** The Node flags the route needs this runtime to honor. Absent one, the route is unsupported. */
export const HARNESS_REQUIRED_NODE_FLAGS: readonly string[] = [
	'--permission',
	'--allow-fs-read',
	'--allow-fs-write',
	'--allow-net',
	'--allow-child-process',
];

export interface HarnessRouteRequest {
	/** The program, run inline (`-e`); it is never written to disk by the route. */
	script: string;
	/** Absolute, canonical paths of regular files the program may read. */
	inputs: readonly string[];
	/** The program's private working directory: the only place it may write. Absolute, canonical, existing. */
	workDir: string;
	timeoutMs: number;
	/** Written to the program's stdin and closed; the "prompt" of the harness turn. */
	stdin?: string;
	/** The Node binary to run. Default: this process's. */
	nodeExecutable?: string;
}

export interface HarnessRouteDeps {
	lstat?(file: string): fs.Stats;
	realpath?(file: string): string;
}

/** Why the request is not one the route runs, or empty. Pure except for the two file probes. */
export function harnessRouteProblems(
	request: HarnessRouteRequest,
	deps: HarnessRouteDeps = {}
): string[] {
	const lstat = deps.lstat ?? ((file: string) => fs.lstatSync(file));
	const realpath = deps.realpath ?? ((file: string) => fs.realpathSync(file));
	const problems: string[] = [];
	if (typeof request.script !== 'string' || request.script.length === 0) {
		problems.push('script is empty');
	} else {
		if (Buffer.byteLength(request.script) > HARNESS_LIMITS.scriptBytes) {
			problems.push(`script exceeds ${HARNESS_LIMITS.scriptBytes} bytes`);
		}
		if (request.script.includes('\0')) problems.push('script contains NUL');
	}
	if (
		!Number.isSafeInteger(request.timeoutMs) ||
		request.timeoutMs < HARNESS_LIMITS.timeoutMinMs ||
		request.timeoutMs > HARNESS_LIMITS.timeoutMaxMs
	) {
		problems.push(
			`timeoutMs is not within ${HARNESS_LIMITS.timeoutMinMs} and ${HARNESS_LIMITS.timeoutMaxMs}`
		);
	}
	if (request.stdin !== undefined && Buffer.byteLength(request.stdin) > HARNESS_LIMITS.stdinBytes) {
		problems.push(`stdin exceeds ${HARNESS_LIMITS.stdinBytes} bytes`);
	}
	if (!Array.isArray(request.inputs)) problems.push('inputs is not an array');
	else {
		if (request.inputs.length > HARNESS_LIMITS.inputs) {
			problems.push(`${request.inputs.length} inputs exceed the bound of ${HARNESS_LIMITS.inputs}`);
		}
		request.inputs.forEach((input, index) => {
			const at = `inputs[${index}]`;
			if (typeof input !== 'string' || !path.isAbsolute(input) || /[,\n\r\0]/.test(input)) {
				problems.push(`${at} is not an absolute path without separators`);
				return;
			}
			try {
				if (realpath(input) !== input) problems.push(`${at} is not canonical`);
				else if (!lstat(input).isFile()) problems.push(`${at} is not a regular file`);
			} catch {
				problems.push(`${at} does not exist`);
			}
		});
	}
	const { workDir } = request;
	if (typeof workDir !== 'string' || !path.isAbsolute(workDir) || /[,\n\r\0]/.test(workDir)) {
		problems.push('workDir is not an absolute path without separators');
	} else {
		try {
			if (realpath(workDir) !== workDir) problems.push('workDir is not canonical');
			else if (!lstat(workDir).isDirectory()) problems.push('workDir is not a directory');
		} catch {
			problems.push('workDir does not exist');
		}
	}
	if (request.nodeExecutable !== undefined && !path.isAbsolute(request.nodeExecutable)) {
		problems.push('nodeExecutable is not an absolute path');
	}
	return problems;
}

/**
 * The process spec of the harness launch: the Node permission model with
 * the declared grants and nothing inherited. The environment is complete,
 * not merged: no `NODE_OPTIONS`, no proxy, no credential can reach the
 * program from the host's environment.
 */
export function buildHarnessLaunchSpec(request: HarnessRouteRequest): TurnProcessSpec {
	const args = ['--permission', '--disallow-code-generation-from-strings'];
	for (const input of request.inputs) args.push(`--allow-fs-read=${input}`);
	args.push(`--allow-fs-write=${request.workDir}`, '-e', request.script);
	return {
		command: request.nodeExecutable ?? process.execPath,
		args,
		cwd: request.workDir,
		env: { PATH: '/usr/bin:/bin', HOME: request.workDir },
		shell: false,
		...(request.stdin !== undefined ? { stdin: request.stdin } : {}),
	};
}

export interface HarnessRouteSupport extends ProviderRouteSupport {
	routeId: string;
	/** What is enforced, by whom, per effect family. */
	enforcement: {
		files: string;
		network: string;
		descendants: string;
		environment: string;
		enforcedBy: 'node-permission-model';
	};
	/** Exactly what a pass on this route proves. */
	qualifies: string;
	/** What it does not prove, so nobody reads more into it. */
	doesNotQualify: string;
}

export interface HarnessRouteHost {
	platform?: NodeJS.Platform;
	/** The flags the Node binary honors. Default: this process's. */
	nodeFlags?: ReadonlySet<string>;
}

/** The route's support, precisely: one provider, one route, enforcement per effect, scope named. */
export function syntheticHarnessRouteSupport(host: HarnessRouteHost = {}): HarnessRouteSupport {
	const platform = host.platform ?? process.platform;
	const flags = host.nodeFlags ?? process.allowedNodeEnvironmentFlags;
	const missing = HARNESS_REQUIRED_NODE_FLAGS.filter((flag) => !flags.has(flag));
	const supported = platform !== 'win32' && missing.length === 0;
	return {
		agentId: SYNTHETIC_HARNESS_PROVIDER,
		route: 'child-process',
		routeId: SYNTHETIC_HARNESS_ROUTE_ID,
		standalone: supported ? 'implemented' : 'unsupported',
		managed: supported ? 'implemented' : 'unsupported',
		note: supported
			? 'inline Node program under --permission, admitted at the real spawn with declared read-only inputs and a private work directory'
			: platform === 'win32'
				? 'not offered on Windows: the route fixes a POSIX PATH and work directory'
				: `this Node does not honor ${missing.join(', ')}`,
		enforcement: {
			files:
				'read: the declared inputs only; write: the work directory only; anything else ERR_ACCESS_DENIED',
			network: 'denied: no --allow-net, so connect and listen fail with ERR_ACCESS_DENIED',
			descendants: 'denied: no --allow-child-process or --allow-worker, so none can start',
			environment: 'complete, not inherited: PATH and HOME only',
			enforcedBy: 'node-permission-model',
		},
		qualifies:
			'exactly this: a synthetic Node program launched through the protected dispatch on this host',
		doesNotQualify:
			'any real provider (Claude, Codex, OpenCode or another), anything a provider starts, or the Node permission model as an OS boundary',
	};
}
