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

/*
 * Provider route evidence (MCOMP-31-01). The pinned public `./execution`
 * contract (signedProviderRouteQualification, schema version 1) defines a
 * producer-owned, signed, immutable receipt that binds ONE provider
 * binary/version/transport/OS/backend/input snapshot to independently
 * observed enforcement cases. This consumer validates that evidence against
 * the exact route the host is about to launch and approves a production
 * route only when all of these hold:
 *
 * - a trusted verifier, injected by the host from authenticated custody,
 *   reports the signature and payload digest as verified (parsing alone
 *   never verifies; with no verifier the route is unavailable);
 * - the receipt names exactly this provider, adapter, transport, binary,
 *   OS, backend and input digest;
 * - its tier is a real provider tier (a Node harness qualifies only the
 *   synthetic provider) and its model transport matches that tier;
 * - every mandatory allow case was observed allowed and every mandatory
 *   deny case observed denied, each once, by an outside observer;
 * - it is fresh, and nothing changed or was cancelled across the await.
 *
 * Anything else is `unavailable` with reasons. There is no fallback to an
 * unqualified route, personal OAuth or another transport, and the approval
 * grants no lease: admission still runs through the existing HostAuthority
 * at the sink. Real provider confinement is proved in MCOMP-32.
 */

/** The published contract version this consumer reads. */
export const PROVIDER_ROUTE_EVIDENCE_VERSION = 1 as const;

/** Mirrors the published providerRouteAllowCases (pinned in tests). */
export const PROVIDER_ROUTE_ALLOW_CASES = Object.freeze([
	'approved_tool_roundtrip',
	'approved_file_roundtrip',
] as const);

/** Mirrors the published providerRouteDenyCases (pinned in tests). */
export const PROVIDER_ROUTE_DENY_CASES = Object.freeze([
	'forbidden_file_read',
	'forbidden_file_write',
	'symlink_replacement',
	'shell_subprocess_escape',
	'direct_http',
	'direct_dns',
	'localhost_metadata',
	'secret_read',
	'alternate_credential',
	'personal_configuration',
	'alternate_base_url',
	'custom_executable',
	'unsupported_resume',
	'daemon_reuse',
	'revoke_before_await',
	'revoke_after_await',
	'descendant_escape',
] as const);

export type ProviderRouteCase =
	| (typeof PROVIDER_ROUTE_ALLOW_CASES)[number]
	| (typeof PROVIDER_ROUTE_DENY_CASES)[number];
export type ProviderQualificationTier = 'node-harness' | 'real-cli-fixture-model' | 'live-model';
export type ProviderModelTransport = 'none' | 'deterministic-fixture' | 'live-provider';
export type ProviderEvidenceTransport = 'cli-process' | 'persistent-sdk' | 'pty' | 'ssh';

const TIER_MODEL_TRANSPORT: Readonly<Record<ProviderQualificationTier, ProviderModelTransport>> =
	Object.freeze({
		'node-harness': 'none',
		'real-cli-fixture-model': 'deterministic-fixture',
		'live-model': 'live-provider',
	});
/** The published contract's synthetic provider id for the node-harness tier. */
export const PROVIDER_EVIDENCE_SYNTHETIC_PROVIDER = 'synthetic-node';
const OBSERVERS = new Set(['filesystem', 'network', 'process', 'receipt']);
const DIGEST = /^[a-f0-9]{64}$/;

export interface ProviderRouteObservation {
	case: ProviderRouteCase;
	expected: 'allowed' | 'denied';
	observed: 'allowed' | 'denied' | 'unobserved' | 'error';
	observer: 'filesystem' | 'network' | 'process' | 'receipt';
	evidenceDigest: string;
}

export interface ProviderRouteQualificationPayload {
	version: 1;
	receiptId: string;
	producer: { owner: 'mega-maestro'; implementationRevision: string; observedRevision: string };
	tier: ProviderQualificationTier;
	modelTransport: ProviderModelTransport;
	route: { provider: string; adapterId: string; transport: ProviderEvidenceTransport };
	binary: { digest: string; version: string; identity: string };
	os: { platform: 'darwin' | 'win32' | 'linux'; release: string; arch: 'arm64' | 'x64' };
	backend: { id: string; evidenceDigest: string };
	inputSnapshot: { inputDigest: string; inputs: Array<[string, string]> };
	observations: ProviderRouteObservation[];
	observedAt: string;
}

export interface SignedProviderRouteQualification {
	payload: ProviderRouteQualificationPayload;
	payloadDigest: string;
	keyId: string;
	algorithm: 'Ed25519';
	signature: string;
}

/** The exact route the host is about to launch, resolved by the host. */
export interface ProviderRouteCandidate {
	provider: string;
	adapterId: string;
	transport: ProviderEvidenceTransport;
	binary: { digest: string; version: string; identity: string };
	os: { platform: string; release: string; arch: string };
	backend: { id: string; evidenceDigest: string };
	inputDigest: string;
}

/**
 * Trusted signature check, supplied by the host from authenticated custody
 * (the producer's route-qualification key under the current trust root).
 * `unavailable` covers a missing or stale trust root; it never approves.
 */
export interface ProviderRouteEvidenceVerifier {
	readonly version: typeof PROVIDER_ROUTE_EVIDENCE_VERSION;
	verify(
		evidence: SignedProviderRouteQualification,
		signal: AbortSignal
	): Promise<'verified' | 'invalid' | 'unavailable'>;
}

export interface ProviderRouteEvidenceOptions {
	/** Oldest acceptable observation, in ms. */
	maxAgeMs: number;
	now?: () => number;
}

/** Bounded freshness: one minute to ninety days. */
export const PROVIDER_ROUTE_EVIDENCE_AGE_MS = Object.freeze({
	min: 60_000,
	max: 90 * 24 * 60 * 60 * 1000,
});

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Structural and binding problems of route evidence against a candidate.
 * Messages name fields only; no path, digest value or evidence leaks out.
 * An empty list does not approve anything: the signature is unchecked.
 */
export function providerRouteEvidenceProblems(
	evidence: unknown,
	candidate: ProviderRouteCandidate,
	options: ProviderRouteEvidenceOptions
): string[] {
	if (!isRecord(evidence) || !isRecord(evidence.payload))
		return ['evidence is not a signed receipt'];
	const problems: string[] = [];
	const payload = evidence.payload as unknown as ProviderRouteQualificationPayload;
	if (evidence.algorithm !== 'Ed25519') problems.push('algorithm is not Ed25519');
	if (typeof evidence.payloadDigest !== 'string' || !DIGEST.test(evidence.payloadDigest)) {
		problems.push('payloadDigest is not a digest');
	}
	if (payload.version !== PROVIDER_ROUTE_EVIDENCE_VERSION) problems.push('version is unsupported');
	if (!isRecord(payload.producer) || payload.producer.owner !== 'mega-maestro') {
		problems.push('producer is not mega-maestro');
	}
	const tier = payload.tier;
	if (!(tier in TIER_MODEL_TRANSPORT)) problems.push('tier is unknown');
	else if (TIER_MODEL_TRANSPORT[tier] !== payload.modelTransport) {
		problems.push('modelTransport does not match tier');
	}
	const route = isRecord(payload.route) ? payload.route : ({} as Record<string, unknown>);
	if ((tier === 'node-harness') !== (route.provider === PROVIDER_EVIDENCE_SYNTHETIC_PROVIDER)) {
		problems.push('tier does not match provider');
	}
	if (route.provider !== candidate.provider) problems.push('route.provider differs');
	if (route.adapterId !== candidate.adapterId) problems.push('route.adapterId differs');
	if (route.transport !== candidate.transport) problems.push('route.transport differs');
	const pairs: Array<[string, unknown, Record<string, unknown>]> = [
		['binary', payload.binary, candidate.binary as unknown as Record<string, unknown>],
		['os', payload.os, candidate.os as unknown as Record<string, unknown>],
		['backend', payload.backend, candidate.backend as unknown as Record<string, unknown>],
	];
	for (const [name, got, want] of pairs) {
		if (!isRecord(got)) {
			problems.push(`${name} is missing`);
			continue;
		}
		for (const key of Object.keys(want)) {
			if (got[key] !== want[key]) problems.push(`${name}.${key} differs`);
		}
	}
	const snapshot = isRecord(payload.inputSnapshot) ? payload.inputSnapshot : undefined;
	if (!snapshot || snapshot.inputDigest !== candidate.inputDigest) {
		problems.push('inputSnapshot.inputDigest differs');
	} else if (
		!Array.isArray(snapshot.inputs) ||
		snapshot.inputs.length < 1 ||
		snapshot.inputs.some(
			(entry, index, all) =>
				!Array.isArray(entry) || (index > 0 && String(all[index - 1][0]) >= String(entry[0]))
		)
	) {
		problems.push('inputSnapshot.inputs is not a sorted input map');
	}
	problems.push(...observationProblems(payload.observations));
	const at = typeof payload.observedAt === 'string' ? Date.parse(payload.observedAt) : NaN;
	const now = (options.now ?? Date.now)();
	if (
		!Number.isSafeInteger(options.maxAgeMs) ||
		options.maxAgeMs < PROVIDER_ROUTE_EVIDENCE_AGE_MS.min ||
		options.maxAgeMs > PROVIDER_ROUTE_EVIDENCE_AGE_MS.max
	) {
		problems.push('maxAgeMs is outside its bounds');
	} else if (!Number.isFinite(at)) problems.push('observedAt is not a time');
	else if (at > now) problems.push('observedAt is in the future');
	else if (now - at > options.maxAgeMs) problems.push('evidence is stale');
	return problems;
}

function observationProblems(observations: unknown): string[] {
	if (!Array.isArray(observations)) return ['observations is not a list'];
	const problems: string[] = [];
	const seen = new Map<string, ProviderRouteObservation>();
	for (const entry of observations) {
		if (!isRecord(entry) || typeof entry.case !== 'string') {
			problems.push('observation is malformed');
			continue;
		}
		if (seen.has(entry.case)) problems.push(`case ${entry.case} is duplicated`);
		seen.set(entry.case, entry as unknown as ProviderRouteObservation);
	}
	const mandatory: Array<[string, 'allowed' | 'denied']> = [
		...PROVIDER_ROUTE_ALLOW_CASES.map((name): [string, 'allowed'] => [name, 'allowed']),
		...PROVIDER_ROUTE_DENY_CASES.map((name): [string, 'denied'] => [name, 'denied']),
	];
	const known = new Set(mandatory.map(([name]) => name));
	for (const name of seen.keys()) if (!known.has(name)) problems.push(`case ${name} is unknown`);
	for (const [name, want] of mandatory) {
		const entry = seen.get(name);
		if (!entry) problems.push(`case ${name} was not observed`);
		else if (entry.expected !== want) problems.push(`case ${name} has the wrong expectation`);
		else if (entry.observed !== want) problems.push(`case ${name} was ${entry.observed}`);
		else if (!OBSERVERS.has(entry.observer) || !DIGEST.test(String(entry.evidenceDigest))) {
			problems.push(`case ${name} lacks outside evidence`);
		}
	}
	return problems;
}

export type ProviderRouteApproval =
	| {
			state: 'qualified';
			receiptId: string;
			tier: Exclude<ProviderQualificationTier, 'node-harness'>;
			payloadDigest: string;
	  }
	| { state: 'unavailable'; reasons: string[] };

/**
 * Whether a production provider route may be offered. Fail-closed: no
 * verifier, a refused or lost verification, a binding problem, a harness
 * tier, cancellation or a candidate that changed across the await all yield
 * `unavailable`. The approval grants no lease or effect.
 */
export async function approveProviderRoute(
	evidence: unknown,
	candidate: ProviderRouteCandidate,
	verifier: ProviderRouteEvidenceVerifier | undefined,
	options: ProviderRouteEvidenceOptions & { signal: AbortSignal }
): Promise<ProviderRouteApproval> {
	const unavailable = (reasons: string[]): ProviderRouteApproval => ({
		state: 'unavailable',
		reasons,
	});
	const before = JSON.stringify(candidate);
	const problems = providerRouteEvidenceProblems(evidence, candidate, options);
	if (problems.length > 0) return unavailable(problems);
	const signed = evidence as SignedProviderRouteQualification;
	if (signed.payload.tier === 'node-harness') {
		return unavailable(['a node-harness receipt qualifies no production provider']);
	}
	if (!verifier || verifier.version !== PROVIDER_ROUTE_EVIDENCE_VERSION) {
		return unavailable(['no trusted route evidence verifier']);
	}
	if (options.signal.aborted) return unavailable(['cancelled']);
	const frozen = structuredClone(signed);
	let verdict: 'verified' | 'invalid' | 'unavailable';
	try {
		verdict = await verifier.verify(frozen, options.signal);
	} catch {
		verdict = 'unavailable';
	}
	if (options.signal.aborted) return unavailable(['cancelled']);
	if (verdict !== 'verified') return unavailable([`signature ${verdict}`]);
	// Recheck everything after the await: the candidate, the evidence and the clock.
	if (JSON.stringify(candidate) !== before)
		return unavailable(['candidate changed during verification']);
	if (JSON.stringify(frozen) !== JSON.stringify(signed)) {
		return unavailable(['evidence changed during verification']);
	}
	const after = providerRouteEvidenceProblems(frozen, candidate, options);
	if (after.length > 0) return unavailable(after);
	return {
		state: 'qualified',
		receiptId: frozen.payload.receiptId,
		tier: frozen.payload.tier as Exclude<ProviderQualificationTier, 'node-harness'>,
		payloadDigest: frozen.payloadDigest,
	};
}
