/**
 * The install ceiling a managed desktop holds downloaded binaries and
 * installers to (MRC2-04-07): the WakaTime manager (a zip fetched from GitHub,
 * extracted into ~/.wakatime/, a binary run per heartbeat) and the maestro-cli
 * installer (a shim for the bundled maestro-cli.js, PowerShell on Windows).
 * Standalone, both do what they always did. Under management nothing is
 * fetched, extracted, written to an install location or run unless the signed
 * ceiling PINS it: artifact, exact file, SHA-256 of the bytes and, for a
 * download, the one source URL. A fetch is held before any byte is written and
 * follows the pin's source, never "latest"; an execute is held against the
 * digest of the bytes on disk, taken only when a pin asks, so a standalone host
 * never reads the file; a name on PATH has no bytes and never runs. Refusals
 * are named by code. No endpoint operation carries this ceiling yet (CP-01),
 * so nothing calls install() and an enrolled desktop refuses unavailable.
 */

import type {
	HeadlessSpawnAuthority,
	ManagedPolicyStatus,
} from '../../shared/maestro-lib/managed/host-adapter';
import {
	MANAGED_ROUTES,
	providerRouteSupport,
	type ManagedRoute,
	type ProviderRouteSupport,
} from '../../shared/maestro-lib/providers/capabilities';
import {
	browserActorLabel,
	isPlainObject,
	unknownKeys,
	type BrowserEffectActor,
} from './browser-policy';
import type { EnterpriseIdentityStore } from './identity-store';
import { pairedDeviceActorProblems } from './spawn-authority';

/**
 * What is installed: the WakaTime CLI (fetched), the app's bundled maestro-cli
 * (verified, never fetched), the spec tool prompts (Spec Kit, OpenSpec, BMAD)
 * refreshed from GitHub into the user data directory (MRC2-04-08), the
 * playbooks the marketplace imports into an Auto Run folder, and the coworking
 * MCP server script an agent's configuration is pointed at (MRC2-04-08A).
 */
export const INSTALL_ARTIFACTS = [
	'wakatime-cli',
	'maestro-cli',
	'speckit-prompts',
	'openspec-prompts',
	'bmad-prompts',
	'marketplace-playbooks',
	'coworking-mcp-server',
] as const;
export type InstallArtifact = (typeof INSTALL_ARTIFACTS)[number];

/** `fetch`: bytes about to be written from a source; `execute`: bytes on disk about to be extracted or run. */
export type InstallStage = 'fetch' | 'execute';
export type InstallActor = BrowserEffectActor;

/** The desktop's own automation (a startup install, a heartbeat) acts as the operator who enabled it. */
export const INSTALL_OPERATOR: InstallActor = {
	kind: 'transport',
	actor: { peer: 'in-process' },
};

export interface InstallRequest {
	artifact: InstallArtifact;
	/** The bare file name the sink fetches, verifies or runs (a zip, a binary, the bundled script, a name on PATH). */
	file: string;
	stage: InstallStage;
	/** For `execute`: the hex SHA-256 of the bytes on disk, taken only when a pin asks; null when there are no bytes (a PATH name). */
	digest?: (() => string) | null;
	/** The URL the sink itself fixes (a pinned ref); the pin must name exactly it. Omitted: the pin's source is followed. */
	source?: string;
	actor: InstallActor;
}

export interface InstallPin {
	artifact: InstallArtifact;
	file: string;
	/** Lowercase hex SHA-256 of the bytes, and the one URL they may be fetched from (null: verified in place). */
	sha256: string;
	source: string | null;
}

/**
 * One MCP server an agent's configuration may name (MRC2-04-08A), on one managed
 * route: a user-level config feeds every route the agent launches over, so the
 * grant is honored only where the provider has managed enforcement.
 */
export interface McpServerGrant {
	agentId: string;
	server: string;
	route: ManagedRoute;
}

export interface InstallPolicyCeiling {
	policyRevision: number;
	/** An artifact or file with no pin here is neither fetched nor run. */
	pins: InstallPin[];
	/** An agent and server with no grant here has no MCP entry written. */
	mcpServers: McpServerGrant[];
}

export const INSTALL_CEILING_LIMITS = {
	pins: 64,
	mcpServers: 64,
	fileLength: 255,
	sourceLength: 2048,
} as const;

const CEILING_KEYS = ['policyRevision', 'pins', 'mcpServers'] as const;
const PIN_KEYS = ['artifact', 'file', 'sha256', 'source'] as const;
const GRANT_KEYS = ['agentId', 'server', 'route'] as const;
const SHA256_HEX = /^[a-f0-9]{64}$/;

export type InstallCeilingParse =
	| { ok: true; ceiling: InstallPolicyCeiling }
	| { ok: false; problems: readonly string[] };

/** One bare name: trimmed, no path separator, no control character. */
export function isInstallFileName(file: string): boolean {
	if (!file || file.length > INSTALL_CEILING_LIMITS.fileLength || file !== file.trim())
		return false;
	return file !== '.' && file !== '..' && !/[\u0000-\u001f\u007f/\\]/.test(file);
}

/** One absolute `https:` URL with no credentials and no fragment. */
export function isInstallSource(source: string): boolean {
	if (!source || source.length > INSTALL_CEILING_LIMITS.sourceLength) return false;
	if (source !== source.trim() || /[\u0000-\u001f\u007f\s]/.test(source)) return false;
	try {
		const url = new URL(source);
		return url.protocol === 'https:' && !url.username && !url.password && !url.hash;
	} catch {
		return false;
	}
}

function parsePin(raw: unknown, at: string, problems: string[]): InstallPin | null {
	if (!isPlainObject(raw)) {
		problems.push(`${at} is not an object`);
		return null;
	}
	problems.push(...unknownKeys(raw, PIN_KEYS, `${at}.`));
	const before = problems.length;
	const { artifact, file, sha256 } = raw;
	const source = raw.source === undefined ? null : raw.source;
	if (!(INSTALL_ARTIFACTS as readonly unknown[]).includes(artifact))
		problems.push(`${at}.artifact is not an install artifact`);
	if (typeof file !== 'string' || !isInstallFileName(file))
		problems.push(`${at}.file is not a bare file name`);
	if (typeof sha256 !== 'string' || !SHA256_HEX.test(sha256))
		problems.push(`${at}.sha256 is not a lowercase hex SHA-256`);
	if (source !== null && (typeof source !== 'string' || !isInstallSource(source)))
		problems.push(`${at}.source is not an https URL without credentials or a fragment`);
	if (problems.length !== before) return null;
	return { artifact, file, sha256, source } as InstallPin;
}

/** A pin is one artifact, one file, one source: the same file may be pinned from several sources (BMAD's many `workflow.md`). */
function samePinIdentity(a: InstallPin, b: InstallPin): boolean {
	return a.artifact === b.artifact && a.file === b.file && a.source === b.source;
}

function parseGrant(raw: unknown, at: string, problems: string[]): McpServerGrant | null {
	if (!isPlainObject(raw)) {
		problems.push(`${at} is not an object`);
		return null;
	}
	problems.push(...unknownKeys(raw, GRANT_KEYS, `${at}.`));
	const before = problems.length;
	const { agentId, server, route } = raw;
	if (typeof agentId !== 'string' || !isInstallFileName(agentId))
		problems.push(`${at}.agentId is not an agent id`);
	if (typeof server !== 'string' || !isInstallFileName(server))
		problems.push(`${at}.server is not a server name`);
	if (!(MANAGED_ROUTES as readonly unknown[]).includes(route))
		problems.push(`${at}.route is not a managed route`);
	if (problems.length !== before) return null;
	return { agentId, server, route } as McpServerGrant;
}

/** Validate a document into a fresh value; every problem is named by path and one refuses the whole. */
export function parseInstallPolicyCeiling(raw: unknown): InstallCeilingParse {
	if (!isPlainObject(raw)) return { ok: false, problems: ['the install ceiling is not an object'] };
	const problems = unknownKeys(raw, CEILING_KEYS, '');
	if (!Number.isSafeInteger(raw.policyRevision) || (raw.policyRevision as number) < 0)
		problems.push('policyRevision is not a policy revision');
	const pins: InstallPin[] = [];
	if (!Array.isArray(raw.pins)) problems.push('pins is not an array');
	else if (raw.pins.length > INSTALL_CEILING_LIMITS.pins)
		problems.push(`pins exceeds ${INSTALL_CEILING_LIMITS.pins} entries`);
	else
		raw.pins.forEach((entry, index) => {
			const pin = parsePin(entry, `pins[${index}]`, problems);
			if (pin && pins.some((seen) => samePinIdentity(seen, pin)))
				problems.push(`pins[${index}] names ${pin.artifact} ${pin.file} twice`);
			else if (pin) pins.push(pin);
		});
	// The grant clause is absent from a ceiling written before MRC2-04-08A: no MCP entry is written then.
	const mcpServers: McpServerGrant[] = [];
	const grants = raw.mcpServers === undefined ? [] : raw.mcpServers;
	if (!Array.isArray(grants)) problems.push('mcpServers is not an array');
	else if (grants.length > INSTALL_CEILING_LIMITS.mcpServers)
		problems.push(`mcpServers exceeds ${INSTALL_CEILING_LIMITS.mcpServers} entries`);
	else
		grants.forEach((entry, index) => {
			const grant = parseGrant(entry, `mcpServers[${index}]`, problems);
			if (!grant) return;
			const { agentId, server, route } = grant;
			if (mcpServers.some((g) => g.agentId === agentId && g.server === server && g.route === route))
				problems.push(`mcpServers[${index}] names ${server} for ${agentId} on ${route} twice`);
			else mcpServers.push(grant);
		});
	if (problems.length > 0) return { ok: false, problems };
	return {
		ok: true,
		ceiling: { policyRevision: raw.policyRevision as number, pins, mcpServers },
	};
}

export type ManagedInstallStanding =
	| { standing: 'standalone' }
	| { standing: 'managed'; ceiling: InstallPolicyCeiling; policyRevision: number }
	| { standing: 'managed'; ceiling: null; policyRevision: number | null; reason: string };

/** The standing the sinks hold against: the rule of `managedShellStanding`, for the install ceiling. */
export function managedInstallStanding(input: {
	enrolled: boolean;
	policy: Pick<ManagedPolicyStatus, 'appliedRevision'> | null;
	ceiling: InstallPolicyCeiling | null;
}): ManagedInstallStanding {
	if (!input.enrolled) return { standing: 'standalone' };
	const revision = input.policy?.appliedRevision ?? null;
	const reason =
		revision === null
			? 'no applied policy revision is known for this host'
			: !input.ceiling
				? `no install ceiling is installed for policy revision ${revision}`
				: input.ceiling.policyRevision !== revision
					? `the installed install ceiling is for policy revision ${input.ceiling.policyRevision}; this host is under revision ${revision}`
					: null;
	if (reason !== null || !input.ceiling || revision === null)
		return { standing: 'managed', ceiling: null, policyRevision: revision, reason: reason ?? '' };
	return { standing: 'managed', ceiling: input.ceiling, policyRevision: revision };
}

export type InstallDenial = 'unavailable' | 'unauthenticated' | 'unpinned' | 'digest-mismatch';

export interface InstallReceipt {
	policyRevision: number | null;
	artifact: InstallArtifact;
	file: string;
	stage: InstallStage;
	actor: string;
	/** The pinned source, the pinned digest and the digest taken; null when none applied. */
	source: string | null;
	expected: string | null;
	actual: string | null;
	outcome: 'within-ceiling' | InstallDenial;
}

/** Standalone: allowed with no pin and no receipt. Managed: the pin the sink follows, with a receipt. */
export type InstallDecision =
	| { allowed: true; pin?: InstallPin; managed?: InstallReceipt }
	| { allowed: false; code: InstallDenial; message: string; managed: InstallReceipt };

/** The refusal line a sink logs and answers with: the code first, so it never reads as a failed download. */
export function formatInstallRefusal(decision: { code: string; message: string }): string {
	return `[managed-${decision.code}] ${decision.message}`;
}

/**
 * Hold one install step. Pure apart from the digest thunk, which runs only when
 * a pin exists for the file. `unbindable`: what the caller knows about the actor.
 */
export function installVerdict(
	standing: ManagedInstallStanding,
	request: InstallRequest,
	unbindable: readonly string[] = []
): InstallDecision {
	if (standing.standing === 'standalone') return { allowed: true };
	const [, label] = browserActorLabel(request.actor);
	const what = `${request.artifact} ${request.file}`;
	const receipt = (
		outcome: InstallReceipt['outcome'],
		pin: InstallPin | null,
		actual: string | null
	): InstallReceipt => ({
		policyRevision: standing.policyRevision,
		artifact: request.artifact,
		file: request.file,
		stage: request.stage,
		actor: label,
		source: pin?.source ?? null,
		expected: pin?.sha256 ?? null,
		actual,
		outcome,
	});
	const deny = (
		code: InstallDenial,
		message: string,
		pin: InstallPin | null = null,
		actual: string | null = null
	): InstallDecision => ({ allowed: false, code, message, managed: receipt(code, pin, actual) });
	if (unbindable.length > 0) return deny('unauthenticated', unbindable.join('; '));
	if (!standing.ceiling)
		return deny('unavailable', `the managed install ceiling is unavailable (${standing.reason})`);
	const only = `for ${label} only a file the policy pins by digest is fetched or run`;
	const named = standing.ceiling.pins.filter(
		(p) => p.artifact === request.artifact && p.file === request.file
	);
	if (request.source !== undefined) {
		const pin = named.find((p) => p.source === request.source) ?? null;
		if (!pin)
			return deny(
				'unpinned',
				`the install ceiling pins no ${what} from ${request.source}; ${only}`
			);
		return pinnedVerdict(request, pin, what, label, only, receipt, deny);
	}
	if (named.length > 1)
		return deny(
			'unpinned',
			`the install ceiling pins ${what} from ${named.length} sources and the sink names none; ${only}`
		);
	const pin = named[0] ?? null;
	if (!pin) return deny('unpinned', `the install ceiling pins no ${what}; ${only}`);
	return pinnedVerdict(request, pin, what, label, only, receipt, deny);
}

function pinnedVerdict(
	request: InstallRequest,
	pin: InstallPin,
	what: string,
	label: string,
	only: string,
	receipt: (
		outcome: InstallReceipt['outcome'],
		pin: InstallPin | null,
		actual: string | null
	) => InstallReceipt,
	deny: (
		code: InstallDenial,
		message: string,
		pin?: InstallPin | null,
		actual?: string | null
	) => InstallDecision
): InstallDecision {
	if (request.stage === 'fetch') {
		if (pin.source === null)
			return deny(
				'unpinned',
				`${what} is pinned for verification only, with no source; ${only}`,
				pin
			);
		return { allowed: true, pin, managed: receipt('within-ceiling', pin, null) };
	}
	const actual = request.digest ? request.digest() : null;
	if (actual === null)
		return deny('digest-mismatch', `${what} has no bytes to digest (a name on PATH); ${only}`, pin);
	if (actual !== pin.sha256)
		return deny(
			'digest-mismatch',
			`the bytes of ${what} (sha256 ${actual}) are not the pinned ones (${pin.sha256}); nothing is extracted, installed or run for ${label}`,
			pin,
			actual
		);
	return { allowed: true, pin, managed: receipt('within-ceiling', pin, actual) };
}

/** An MCP entry about to be written into one agent's configuration (MRC2-04-08A). */
export interface McpServerRequest {
	agentId: string;
	server: string;
	actor: InstallActor;
}

export type McpServerDenial =
	| 'unavailable'
	| 'unauthenticated'
	| 'server-denied'
	| 'route-unsupported';

export interface McpServerReceipt {
	policyRevision: number | null;
	agentId: string;
	server: string;
	/** The granted route the write was admitted on; null when none applied. */
	route: ManagedRoute | null;
	actor: string;
	outcome: 'within-ceiling' | McpServerDenial;
}

export type McpServerDecision =
	| { allowed: true; grant?: McpServerGrant; managed?: McpServerReceipt }
	| { allowed: false; code: McpServerDenial; message: string; managed: McpServerReceipt };

/** Hold one MCP write; pure given `routes` (the capability table by default). A grant on an unenforced route cannot be bound and is refused. */
export function mcpServerVerdict(
	standing: ManagedInstallStanding,
	request: McpServerRequest,
	unbindable: readonly string[] = [],
	routes: (agentId: string) => ProviderRouteSupport[] = providerRouteSupport
): McpServerDecision {
	if (standing.standing === 'standalone') return { allowed: true };
	const [, label] = browserActorLabel(request.actor);
	const what = `the ${request.server} MCP server for ${request.agentId}`;
	const receipt = (outcome: McpServerReceipt['outcome'], route: ManagedRoute | null) => ({
		policyRevision: standing.policyRevision,
		agentId: request.agentId,
		server: request.server,
		route,
		actor: label,
		outcome,
	});
	const deny = (code: McpServerDenial, message: string): McpServerDecision => ({
		allowed: false,
		code,
		message,
		managed: receipt(code, null),
	});
	if (unbindable.length > 0) return deny('unauthenticated', unbindable.join('; '));
	if (!standing.ceiling)
		return deny('unavailable', `the managed install ceiling is unavailable (${standing.reason})`);
	const grants = standing.ceiling.mcpServers.filter(
		(g) => g.agentId === request.agentId && g.server === request.server
	);
	if (grants.length === 0)
		return deny(
			'server-denied',
			`the install ceiling grants ${what} on no route; for ${label} no MCP entry is written`
		);
	const support = routes(request.agentId);
	const enforced = grants.find((g) =>
		support.some((row) => row.route === g.route && row.managed === 'implemented')
	);
	if (!enforced)
		return deny(
			'route-unsupported',
			`${what} is granted on ${grants.map((g) => g.route).join(', ')}, where ${request.agentId} has no managed enforcement in this build; a grant that cannot be bound writes nothing`
		);
	return { allowed: true, grant: enforced, managed: receipt('within-ceiling', enforced.route) };
}

/** Thrown by a sink that cannot answer a refusal in a result (a refresh that either installs or fails). */
export class InstallRefusedError extends Error {
	readonly code: InstallDenial | McpServerDenial;
	readonly receipt: InstallReceipt | McpServerReceipt;
	constructor(decision: Extract<InstallDecision | McpServerDecision, { allowed: false }>) {
		super(formatInstallRefusal(decision));
		this.name = 'InstallRefusedError';
		this.code = decision.code;
		this.receipt = decision.managed;
	}
}

export type InstallCeilingInstallOutcome =
	| { installed: true; policyRevision: number }
	| { installed: false; problems: readonly string[] };

export interface InstallPolicySourceDeps {
	identity: Pick<EnterpriseIdentityStore, 'read'>;
	policy(): Pick<ManagedPolicyStatus, 'appliedRevision'> | null;
}

/** What a sink holds an install step with: the source, a headless authority, or a test double. */
export interface InstallAuthority {
	authorize(request: InstallRequest): InstallDecision;
}

/** What the MCP config writers hold an entry with (the source, or a test double). */
export interface McpServerAuthority {
	authorizeMcpServer(request: McpServerRequest): McpServerDecision;
}

export interface InstallPolicySource extends InstallAuthority, McpServerAuthority {
	standing(): ManagedInstallStanding;
	installed(): InstallPolicyCeiling | null;
	/** Install a ceiling an authenticated endpoint path handed over; a refused document keeps the previous one. */
	install(raw: unknown): InstallCeilingInstallOutcome;
	clear(): void;
}

export function createInstallPolicySource(deps: InstallPolicySourceDeps): InstallPolicySource {
	let installed: InstallPolicyCeiling | null = null;
	const standing = (read = deps.identity.read()) =>
		managedInstallStanding({
			enrolled: read.status !== 'none',
			policy: deps.policy(),
			ceiling: installed,
		});
	return {
		standing: () => standing(),
		installed: () => installed,
		install(raw) {
			const parsed = parseInstallPolicyCeiling(raw);
			if (!parsed.ok) return { installed: false, problems: parsed.problems };
			installed = parsed.ceiling;
			return { installed: true, policyRevision: parsed.ceiling.policyRevision };
		},
		clear() {
			installed = null;
		},
		authorize(request) {
			const read = deps.identity.read();
			return installVerdict(standing(read), request, unbindable(request.actor, read));
		},
		authorizeMcpServer(request) {
			const read = deps.identity.read();
			return mcpServerVerdict(standing(read), request, unbindable(request.actor, read));
		},
	};
	function unbindable(actor: InstallActor, read: ReturnType<typeof deps.identity.read>) {
		return actor.kind === 'transport' ? pairedDeviceActorProblems(actor.actor, read) : [];
	}
}

/** A process with no desktop (a bare maestro-cli): standalone holds nothing; enrolled refuses unavailable. */
export function headlessInstallAuthority(
	managed: Pick<HeadlessSpawnAuthority, 'standing' | 'unavailableReason'>
): InstallAuthority {
	return {
		authorize(request) {
			if (managed.standing() !== 'managed') return { allowed: true };
			const reason =
				managed.unavailableReason ??
				'this process holds no authority that could hold the install to a ceiling.';
			const standing = {
				standing: 'managed',
				ceiling: null,
				policyRevision: null,
				reason,
			} as const;
			return installVerdict(standing, request);
		},
	};
}
