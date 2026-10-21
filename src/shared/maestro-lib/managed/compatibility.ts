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
 * Support is reported in four distinct states so a matrix never says more
 * than a build can prove:
 *
 *   unsupported       No code path. Stays denied until one exists.
 *   unverified        A code path or metadata claims it, nothing has exercised
 *                     it. Advertised as a claim, never as a fact.
 *   implemented       The code path exists in this build and its own tests
 *                     pass; no real external producer has been paired with it.
 *   locally-verified  Exercised in this checkout against the real local sink
 *                     (the actual process, file or socket it protects), by the
 *                     evidence named. Paired qualification with a real peer is
 *                     recorded by the release evidence, not here.
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

export type SupportStatus = 'unsupported' | 'unverified' | 'implemented' | 'locally-verified';

/** Order for "at least this much support". */
export const SUPPORT_RANK: Readonly<Record<SupportStatus, number>> = Object.freeze({
	unsupported: 0,
	unverified: 1,
	implemented: 2,
	'locally-verified': 3,
});

export function supportAtLeast(status: SupportStatus, minimum: SupportStatus): boolean {
	return SUPPORT_RANK[status] >= SUPPORT_RANK[minimum];
}

/** One row of a support matrix: what, how far, and what proves it. */
export interface SupportEntry<K extends string = string> {
	key: K;
	status: SupportStatus;
	/** The test or evidence file that establishes `status`; null below `implemented`. */
	evidence: string | null;
	/** Why it is no further along, for a reader of the matrix. */
	note?: string;
}

/** The endpoint wire protocols this build accepts. Mirrors the importer's ACCEPTED_ENDPOINT_PROTOCOLS. */
export const MANAGED_ENDPOINT_PROTOCOLS: readonly number[] = [1];

/**
 * This build's own managed capability support. Negotiation was the only
 * capability with a code path at phase 1. Phase 2 implements the run
 * operations over the host's own journal, registry and turn service, with
 * admission at the real spawn; they are `implemented`, not `locally-verified`,
 * until the phase's evidence names the test that exercised the real sink, and
 * no real authority producer (CP-03) has been paired with them. Fleet events
 * and policy status still wait on their producers.
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
	{ key: 'events.resume', status: 'unsupported', evidence: null, note: 'fleet events: phase 10' },
	{ key: 'policy.status', status: 'unsupported', evidence: null, note: 'policy status: phase 3' },
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

	const support = new Map(profile.capabilities.map((entry) => [entry.key, entry]));
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
		if (!entry || !supportAtLeast(status, minimum)) {
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
}): CompatibilityProfile {
	return {
		library: MAESTRO_LIB_VERSION,
		contractVersions: [MANAGED_CONTRACT_VERSION],
		endpointProtocols: MANAGED_ENDPOINT_PROTOCOLS,
		transports: options.transports ?? ['in-process'],
		providers: options.providers,
		capabilities: options.capabilities ?? MANAGED_CAPABILITY_SUPPORT,
	};
}
