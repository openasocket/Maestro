/**
 * Compatibility and support negotiation for managed operation.
 *
 * Before a management peer drives a Maestro host, both sides agree on what
 * they actually share: the library version, the managed contract version,
 * the endpoint wire protocol, the transport the peer is authenticated over,
 * the providers it needs, and the capabilities it cannot work without.
 * `negotiateCompatibility` answers with ONE activation or a denial that lists
 * every mismatch. There is no partial activation and no downgrade: a peer
 * that needs `runs.submit` from a host that cannot do it is refused, not
 * handed a host that silently answers less.
 *
 * Support is reported in five distinct states so a matrix never says more
 * than a build can prove:
 *
 *   unsupported                No code path. Stays denied until one exists.
 *   unsupported-by-counterpart The Maestro consumer exists and refuses; the
 *                              producer it needs is one the management peer
 *                              owes (a counterpart dependency, CP-nn) and has
 *                              not published. A caller gets no further than
 *                              `unsupported`; the difference is who owes the
 *                              work, and the row names them.
 *   unverified                 A code path or metadata claims it, nothing has
 *                              exercised it. Advertised as a claim, never as a
 *                              fact.
 *   implemented                The code path exists in this build and its own
 *                              tests pass; no real external producer has been
 *                              paired with it.
 *   locally-verified           Exercised in this checkout against the real
 *                              local sink (the actual process, file or socket
 *                              it protects), by the evidence named. Paired
 *                              qualification with a real peer is recorded by
 *                              the release evidence, not here.
 */

import semver from 'semver';
import {
	MANAGED_CAPABILITIES,
	MANAGED_CONTRACT_VERSION,
	type ManagedCapability,
	type ManagedContractVersion,
	type ManagedPeerAuthentication,
} from './types';
import { MAESTRO_LIB_VERSION } from '../version';

export type SupportStatus =
	| 'unsupported'
	| 'unsupported-by-counterpart'
	| 'unverified'
	| 'implemented'
	| 'locally-verified';

/**
 * Order for "at least this much support". `unsupported-by-counterpart` ranks
 * with `unsupported`: a caller may proceed no further on either, and the
 * minimum a peer may ask for never admits a row the counterpart cannot serve.
 */
export const SUPPORT_RANK: Readonly<Record<SupportStatus, number>> = Object.freeze({
	unsupported: 0,
	'unsupported-by-counterpart': 0,
	unverified: 1,
	implemented: 2,
	'locally-verified': 3,
});

export const SUPPORT_STATUSES: readonly SupportStatus[] = Object.freeze(
	Object.keys(SUPPORT_RANK) as SupportStatus[]
);

export const isSupportStatus = (value: unknown): value is SupportStatus =>
	typeof value === 'string' && SUPPORT_STATUSES.includes(value as SupportStatus);

export function supportAtLeast(status: SupportStatus, minimum: SupportStatus): boolean {
	return SUPPORT_RANK[status] >= SUPPORT_RANK[minimum];
}

/** Who owes the next step on a row. Absent means Maestro. */
export type SupportOwner = 'maestro' | 'mega-maestro';

/** One row of a support matrix: what, how far, and what proves it. */
export interface SupportEntry<K extends string = string> {
	key: K;
	status: SupportStatus;
	/**
	 * The test or evidence file that establishes `status`; null below
	 * `implemented`, except that an `unsupported-by-counterpart` row cites the
	 * counterpart source line that shows the producer absent.
	 */
	evidence: string | null;
	/** Why it is no further along, for a reader of the matrix. */
	note?: string;
	/** Who owes the producer; set on every `unsupported-by-counterpart` row. */
	owner?: SupportOwner;
	/** The counterpart dependency id (`CP-04`, `CP-05`, `CP-06`) the row waits on. */
	dependency?: CounterpartDependencyId;
}

// ---------------------------------------------------------------------------
// Counterpart dependencies
// ---------------------------------------------------------------------------

/**
 * The producers the counterpart owes, as recorded in
 * `Plans/mega-maestro-rc/counterpart-requests.md`. CP-01 to CP-03 are
 * artifact and authority producers that gate verification, not support rows;
 * CP-04 to CP-06 are the ones a matrix reads by name.
 */
export type CounterpartDependencyId = 'CP-01' | 'CP-02' | 'CP-03' | 'CP-04' | 'CP-05' | 'CP-06';

/** The counterpart revision the rows below were read from (counterpart-requests.md). */
export const COUNTERPART_SUPPORT_REVISION = 'd5143a63931dc87a5f90b3fdb7b58fa3726913b1';
const ENDPOINT_SERVER = 'mega-maestro apps/endpoint/src/ipc/server.ts:65-67';
const SERVED_OPERATIONS =
	'the endpoint server serves attachment, compatibility, telemetry, inbox, noticeList, execution and model only';

const counterpartRow = (
	key: string,
	dependency: CounterpartDependencyId,
	evidence: string,
	note: string
): SupportEntry<string> => ({
	key,
	status: 'unsupported-by-counterpart',
	owner: 'mega-maestro',
	dependency,
	evidence,
	note,
});

/**
 * What Maestro built a consumer for and the counterpart does not serve, at
 * counterpart revision `COUNTERPART_SUPPORT_REVISION`. Keys are the endpoint
 * operation (`endpoint.*`), the command action (`command.*`) or the transport
 * and platform (`transport.*`) a Maestro seam needs. Every row refuses today;
 * none is a route a caller may take. `Plans/mega-maestro-rc/support-matrix.json`
 * mirrors these rows under `counterpart`.
 */
export const COUNTERPART_SUPPORT: readonly SupportEntry<string>[] = [
	counterpartRow(
		'endpoint.command',
		'CP-04',
		ENDPOINT_SERVER,
		`${SERVED_OPERATIONS}; command falls through to unsupported_capability. Consumer: src/main/enterprise/commands.ts`
	),
	counterpartRow(
		'endpoint.workflow',
		'CP-04',
		ENDPOINT_SERVER,
		`${SERVED_OPERATIONS}; workflow falls through to unsupported_capability. Consumer: src/shared/maestro-lib/managed/workflows.ts (owner fences, with CP-03)`
	),
	counterpartRow(
		'endpoint.offline',
		'CP-04',
		ENDPOINT_SERVER,
		`${SERVED_OPERATIONS}; offline falls through to unsupported_capability. Consumer: none built yet; the operation is in the shared endpoint-port vocabulary only`
	),
	counterpartRow(
		'endpoint.enrollment',
		'CP-04',
		ENDPOINT_SERVER,
		`${SERVED_OPERATIONS}; enrollment falls through to unsupported_capability. Consumer: src/main/enterprise/enrollment.ts (enroll, rotate, revoke, retire)`
	),
	counterpartRow(
		'endpoint.budget',
		'CP-04',
		ENDPOINT_SERVER,
		`${SERVED_OPERATIONS}; budget falls through to unsupported_capability. Consumer: none built yet (usage leaves through telemetry); the operation is in the shared endpoint-port vocabulary only`
	),
	counterpartRow(
		'command.pause_run',
		'CP-05',
		'mega-maestro packages/contracts/src/local-endpoint.ts:76-84',
		'the published action union is cancel_run, refresh_policy and report_status; Maestro answers pause_run unsupported by name (DESKTOP_UNCOMPOSED_COMMANDS in src/main/enterprise/commands.ts)'
	),
	counterpartRow(
		'command.resume_run',
		'CP-05',
		'mega-maestro packages/contracts/src/local-endpoint.ts:76-84',
		'the published action union is cancel_run, refresh_policy and report_status; Maestro answers resume_run unsupported by name (DESKTOP_UNCOMPOSED_COMMANDS in src/main/enterprise/commands.ts)'
	),
	counterpartRow(
		'transport.os-peer.darwin',
		'CP-06',
		'mega-maestro apps/endpoint/src/ipc/native.ts:24',
		'OS peer authentication is Linux only: inspectNativePeer throws IPC_PLATFORM_UNSUPPORTED on macOS and every application artifact records nativeEndpoint: unsupported; a macOS Maestro cannot be managed through this endpoint'
	),
	counterpartRow(
		'transport.os-peer.win32',
		'CP-06',
		'mega-maestro apps/endpoint/src/ipc/native.ts:24',
		'OS peer authentication is Linux only: inspectNativePeer throws IPC_PLATFORM_UNSUPPORTED on Windows and every application artifact records nativeEndpoint: unsupported; a Windows Maestro cannot be managed through this endpoint'
	),
];

/**
 * A denial the endpoint (the counterpart's server) gave a required set, as
 * the caller saw it. Only `unsupported_capability` is a statement about
 * support; any other reason says nothing about what the endpoint can serve.
 */
export interface CounterpartCapabilityDenial<K extends string = string> {
	/** The endpoint's own word, `EndpointDenied.reason`. */
	reason: string;
	/** The capabilities the caller named as required when it was denied. */
	required: readonly K[];
	/** What the endpoint advertised the last time it answered `compatible`; null when it never has. */
	served: readonly string[] | null;
	/** Where the denial was observed (an evidence file, or `operation` at a named endpoint); never a secret. */
	evidence: string;
}

/**
 * Fold a server `unsupported_capability` denial into support rows: every
 * required capability the endpoint does not serve (not in `served`, or all of
 * them when the endpoint never said what it serves) reads
 * `unsupported-by-counterpart`, owner mega-maestro. Rows the denial does not
 * reach are returned as they were; a required key with no row gains one, so
 * the state is visible by name. The required set itself is never touched:
 * dropping a member so activation succeeds is the downgrade this module
 * forbids, and the caller passes the same `required` to negotiation.
 */
export function applyCounterpartDenial<K extends string>(
	rows: readonly SupportEntry<K>[],
	denial: CounterpartCapabilityDenial<K>
): readonly SupportEntry<K>[] {
	if (denial.reason !== 'unsupported_capability') return rows;
	const served = denial.served;
	const denied = new Set(denial.required.filter((key) => served === null || !served.includes(key)));
	if (denied.size === 0) return rows;
	const note =
		served === null
			? 'the endpoint denied the required set with unsupported_capability and has not said what it serves'
			: `the endpoint denied the required set with unsupported_capability; it serves [${served.join(', ')}]`;
	const mark = (key: K, row?: SupportEntry<K>): SupportEntry<K> => ({
		...row,
		key,
		status: 'unsupported-by-counterpart',
		owner: 'mega-maestro',
		evidence: denial.evidence,
		note,
	});
	const marked = rows.map((row) => (denied.has(row.key) ? mark(row.key, row) : row));
	const present = new Set(rows.map((row) => row.key));
	for (const key of denied) if (!present.has(key)) marked.push(mark(key));
	return marked;
}

/** The endpoint wire protocols this build accepts. Mirrors the importer's ACCEPTED_ENDPOINT_PROTOCOLS. */
export const MANAGED_ENDPOINT_PROTOCOLS: readonly number[] = [1];

/**
 * This build's own managed capability support. Negotiation was the only
 * capability with a code path at phase 1. Phase 2 implements the run
 * operations over the host's own journal, registry and turn service, with
 * admission at the real spawn; they are `implemented`, not `locally-verified`,
 * until the phase's evidence names the test that exercised the real sink, and
 * no real authority producer (CP-03) has been paired with them. Phase 3 projects
 * policy status from the endpoint attachment and the sealed record. Fleet
 * events still wait on their producer.
 */
export const MANAGED_CAPABILITY_SUPPORT: readonly SupportEntry<ManagedCapability>[] = [
	{
		key: 'capabilities.negotiate',
		status: 'locally-verified',
		evidence: 'src/__tests__/shared/maestro-lib/managed/contracts.test.ts',
	},
	{
		key: 'agents.list',
		status: 'implemented',
		evidence: 'src/shared/maestro-lib/runtime/__tests__/turns.test.ts',
		note: 'scoped inventory over the repository; no real peer paired',
	},
	{
		key: 'runs.list',
		status: 'implemented',
		evidence: 'src/shared/maestro-lib/runtime/__tests__/turns.test.ts',
		note: 'run journal pages; no real peer paired',
	},
	{
		key: 'runs.submit',
		status: 'implemented',
		evidence: 'src/shared/maestro-lib/runtime/__tests__/turns.test.ts',
		note: 'admission at the spawn with a local authority; no real authority producer paired (CP-03)',
	},
	{
		key: 'runs.inspect',
		status: 'implemented',
		evidence: 'src/shared/maestro-lib/runtime/__tests__/turns.test.ts',
		note: 'run journal record; no real peer paired',
	},
	{
		key: 'runs.cancel',
		status: 'implemented',
		evidence: 'src/shared/maestro-lib/runtime/__tests__/turns.test.ts',
		note: 'journal ownership, then the registry or queue; no real peer paired',
	},
	{
		key: 'runs.interrupt',
		status: 'implemented',
		evidence: 'src/shared/maestro-lib/runtime/__tests__/turns.test.ts',
		note: 'journal ownership, then the registry; no real peer paired',
	},
	{
		key: 'events.resume',
		status: 'unsupported',
		evidence: null,
		note: 'the bare build; a host that attached a durable event journal reports implemented (MRC-10-02A)',
	},
	{
		key: 'policy.status',
		status: 'implemented',
		evidence: 'src/__tests__/shared/maestro-lib/managed/host-adapter.test.ts',
		note: 'projected from the endpoint attachment status and the sealed record; no real endpoint paired (CP-04)',
	},
];

/** What a host offers. The default is this build's own; tests and adapters inject theirs. */
export interface CompatibilityProfile {
	library: string;
	contractVersions: readonly string[];
	endpointProtocols: readonly number[];
	/** Transports over which this host can authenticate a peer. */
	transports: readonly ManagedPeerAuthentication[];
	providers: readonly string[];
	capabilities: readonly SupportEntry<ManagedCapability>[];
	/**
	 * What this host's own endpoint last said when asked for a required set.
	 * Folded over `capabilities` by `applyCounterpartDenial()` before any row
	 * is read, so a capability the counterpart refused is reported
	 * `unsupported-by-counterpart` by name rather than activated.
	 */
	counterpartDenial?: CounterpartCapabilityDenial<ManagedCapability>;
}

/** What a peer needs. Every field is a requirement; absence of a field is "no requirement". */
export interface CompatibilityRequest {
	/** A semver range the peer accepts for the library surface. */
	library?: string;
	/** Contract versions the peer speaks, best first. */
	contractVersions: readonly string[];
	/** Endpoint protocols the peer speaks. */
	endpointProtocols: readonly number[];
	transport: ManagedPeerAuthentication;
	/** Provider ids the peer will dispatch to. */
	providers?: readonly string[];
	required: readonly ManagedCapability[];
	optional?: readonly ManagedCapability[];
	/** The least support a required capability must have. Default `locally-verified`. */
	minimumStatus?: SupportStatus;
}

export type CompatibilityDenialReason =
	| 'library-version'
	| 'contract-version'
	| 'endpoint-protocol'
	| 'transport'
	| 'provider'
	| 'missing-required-capability'
	| 'unsupported-by-counterpart'
	| 'unknown-capability';

export interface CompatibilityDenial {
	reason: CompatibilityDenialReason;
	/** Safe to show. Names the mismatch, never a secret. */
	detail: string;
}

export type CompatibilityOutcome =
	| {
			outcome: 'activated';
			library: string;
			contractVersion: ManagedContractVersion;
			endpointProtocol: number;
			transport: ManagedPeerAuthentication;
			/** Required plus the optional ones that meet the minimum. Nothing else. */
			capabilities: readonly ManagedCapability[];
			/** The support rows behind `capabilities`, for the peer's own matrix. */
			support: readonly SupportEntry<ManagedCapability>[];
	  }
	| { outcome: 'denied'; reasons: readonly CompatibilityDenial[] };

const isKnownCapability = (value: unknown): value is ManagedCapability =>
	MANAGED_CAPABILITIES.includes(value as ManagedCapability);

/**
 * Agree on what both sides share, or say everything that does not match.
 * Pure: no clock, no I/O. Deterministic for a given profile and request.
 */
export function negotiateCompatibility(
	profile: CompatibilityProfile,
	request: CompatibilityRequest
): CompatibilityOutcome {
	const reasons: CompatibilityDenial[] = [];
	const minimum = request.minimumStatus ?? 'locally-verified';

	if (request.library !== undefined) {
		const range = semver.validRange(request.library);
		if (range === null || !semver.satisfies(profile.library, range)) {
			reasons.push({
				reason: 'library-version',
				detail: `host library ${profile.library} is outside ${request.library}`,
			});
		}
	}

	const contractVersion = request.contractVersions.find((v) =>
		profile.contractVersions.includes(v)
	);
	if (contractVersion === undefined) {
		reasons.push({
			reason: 'contract-version',
			detail: `host speaks [${profile.contractVersions.join(', ')}], peer [${request.contractVersions.join(', ')}]`,
		});
	}

	const endpointProtocol = [...request.endpointProtocols]
		.filter((p) => profile.endpointProtocols.includes(p))
		.sort((a, b) => b - a)[0];
	if (endpointProtocol === undefined) {
		reasons.push({
			reason: 'endpoint-protocol',
			detail: `host accepts [${profile.endpointProtocols.join(', ')}], peer [${request.endpointProtocols.join(', ')}]`,
		});
	}

	if (!profile.transports.includes(request.transport)) {
		reasons.push({
			reason: 'transport',
			detail: `host cannot authenticate a peer over ${request.transport}`,
		});
	}

	for (const provider of request.providers ?? []) {
		if (!profile.providers.includes(provider)) {
			reasons.push({ reason: 'provider', detail: `host has no provider ${provider}` });
		}
	}

	const rows = profile.counterpartDenial
		? applyCounterpartDenial(profile.capabilities, profile.counterpartDenial)
		: profile.capabilities;
	const support = new Map(rows.map((entry) => [entry.key, entry]));
	const granted: SupportEntry<ManagedCapability>[] = [];
	for (const capability of [...request.required, ...(request.optional ?? [])]) {
		if (!isKnownCapability(capability)) {
			reasons.push({
				reason: 'unknown-capability',
				detail: `"${String(capability)}" is not a managed capability`,
			});
		}
	}
	for (const capability of request.required) {
		if (!isKnownCapability(capability)) continue;
		const entry = support.get(capability);
		const status = entry?.status ?? 'unsupported';
		if (entry?.status === 'unsupported-by-counterpart') {
			// Named, never folded into "missing": the host has the consumer, the
			// counterpart owes the producer, and the required set stays as asked.
			const owed = entry.dependency
				? ` (${entry.dependency}, owner ${entry.owner ?? 'mega-maestro'})`
				: ` (owner ${entry.owner ?? 'mega-maestro'})`;
			reasons.push({
				reason: 'unsupported-by-counterpart',
				detail: `${capability} is unsupported-by-counterpart${owed}${entry.note ? `: ${entry.note}` : ''}`,
			});
		} else if (!entry || !supportAtLeast(status, minimum)) {
			reasons.push({
				reason: 'missing-required-capability',
				detail: `${capability} is ${status}${entry?.note ? ` (${entry.note})` : ''}; ${minimum} required`,
			});
		} else {
			granted.push(entry);
		}
	}
	for (const capability of request.optional ?? []) {
		if (!isKnownCapability(capability) || request.required.includes(capability)) continue;
		const entry = support.get(capability);
		if (entry && supportAtLeast(entry.status, minimum)) granted.push(entry);
	}

	if (reasons.length > 0 || contractVersion === undefined || endpointProtocol === undefined) {
		return { outcome: 'denied', reasons };
	}
	return {
		outcome: 'activated',
		library: profile.library,
		contractVersion: contractVersion as ManagedContractVersion,
		endpointProtocol,
		transport: request.transport,
		capabilities: granted.map((entry) => entry.key),
		support: granted,
	};
}

/**
 * This build's profile. `providers` is what the host actually has; a host
 * passes the ids it can plan a turn for. Only the in-process transport is
 * offered: a caller in the same process is authenticated by construction,
 * every other transport waits on its verifier (phase 2 and 3).
 */
export function hostCompatibilityProfile(options: {
	providers: readonly string[];
	transports?: readonly ManagedPeerAuthentication[];
	capabilities?: readonly SupportEntry<ManagedCapability>[];
	counterpartDenial?: CounterpartCapabilityDenial<ManagedCapability>;
}): CompatibilityProfile {
	return {
		library: MAESTRO_LIB_VERSION,
		contractVersions: [MANAGED_CONTRACT_VERSION],
		endpointProtocols: MANAGED_ENDPOINT_PROTOCOLS,
		transports: options.transports ?? ['in-process'],
		providers: options.providers,
		capabilities: options.capabilities ?? MANAGED_CAPABILITY_SUPPORT,
		...(options.counterpartDenial ? { counterpartDenial: options.counterpartDenial } : {}),
	};
}
