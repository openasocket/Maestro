/**
 * Grok qualification harness (`grok-acceptance-environment/v1`, GT1-11-08).
 *
 * Composition only: it reads an explicit run configuration, expands the
 * E01-E12 case families recorded in `Plans/grok-tier1/run-state.json`
 * (`testEnvironment.cases`) over route and target, decides admission for each
 * case and writes one structured receipt per run. It never reads a credential
 * and never contacts an endpoint. A case is only ever handed to an executor
 * after every admission input is present AND every harness capability it needs
 * is implemented; an SSH leg (GT1-11-11A3 for discovery) and a cross-provider
 * paid leg have no executor yet, so those record `not-run` with
 * machine-readable reasons. Default execution, with no configuration,
 * therefore makes zero spawns, zero paid requests and zero network contacts.
 *
 * Paid execution (GT1-11-11P1): an admitted local Grok-only paid case is
 * handed to `executePaidCase`, which re-checks admission and preflight,
 * re-hashes the pinned binary before every spawn, reserves on the shared
 * ledger before any dispatch, launches only the planned isolated environment
 * with the selected credential reference resolved at spawn, counts every user
 * turn and billable call before it is sent, and settles with the observed
 * usage or keeps the charge uncertain (an uncertain effect is never retried).
 * Each child is owned by the case lifetime under the reservation deadline;
 * each leg records the synthetic fixture's sha256 (`paid-fixtures.ts`) and the
 * assertions it evaluated with their outcomes.
 *
 * Discovery (GT1-11-11A1): an admitted local E02/E07 case first runs its
 * discovery leg through `executeDiscoveryCase`, which re-checks admission and
 * preflight, re-hashes the pinned binary before every spawn and launches only
 * the planned isolated environment with the selected account's credential
 * reference. It runs only the authorized `DISCOVERY_OPERATIONS` of the case
 * route (ACP initialize, session/new without a prompt, the model/effort menus
 * session/new reported; the native model listing) and never a prompt, counts
 * every network contact, bounds the leg by `HARNESS_CEILINGS.discoverySeconds`
 * and records what the peer advertised verbatim, beside an auth outcome
 * classified by the canonical Grok error patterns (never a login, a retry or
 * another account). An E07 paid leg runs only after its discovery leg passed.
 *
 * Identity assertions (GT1-11-11A2): an E01 case evaluates
 * `colliding-native-ids` after both account legs by inspecting only the two
 * owned homes (each lists only the session ids its own leg created, carries no
 * record of the other leg, and each leg ran on its own credential reference and
 * home). The offline-inspection case also runs a binary-resolution leg (files
 * only, no spawn) that resolves the pin through the production custom-path rule
 * from the pinned path, an owned custom path and the boundary PATH, and fails
 * any resolution that is not the pin itself (no fallback to another install).
 * An E07 paid leg selects `selection.effort` (refused unsent when absent),
 * evaluates `effort-and-gateway` (acknowledged effort equals the selection,
 * every gateway the child received names an approved origin) and stops before
 * any prompt on a rejected or unacknowledged choice, never downgrading.
 *
 * Offline inspection (GT1-11-10A): the offline-inspection leg of a case (E02)
 * is admitted and recorded as its own receipt entry, independently of
 * discovery. It needs the pinned binary, disabled auto-update, owned roots, the
 * isolation receipt and a declaration with deny-all egress, never a credential
 * reference, endpoint or discovery authorization. Its executor re-hashes the
 * binary and refuses before spawn on a mismatch, then runs only the
 * `OFFLINE_PROBES` argv under the planned credential-free environment, each
 * child owned by the case lifetime with a wall-clock bound, and records exit,
 * duration, stdout/stderr digests and the parsed version beside the pin.
 *
 * Spend admission (GT1-11-08C): a paid case needs a worst-case plan from
 * declared per-call token bounds and per-turn billable calls (model rounds,
 * children, retries, side models, compaction), priced through the canonical
 * `calculateModelCost`; an unknown price or bound is admitted only under a
 * provider-enforced cap covering every provider of the case and no larger
 * than the run budget, and the cost then stays unknown. One ledger per run
 * (never reset; a translation leg or repeated roundtrip shares it) takes each
 * reservation in one synchronous check-and-hold, bound to the exact provider,
 * account, endpoint, models, target, case and authorization expiry, under the
 * run and per-case spend/call/turn/time limits and the concurrency ceiling.
 * Every billable call draws from the allowance before dispatch; an uncertain
 * effect is never retried; an unknown or partial charge stays `uncertain` and
 * is never refunded or read as zero.
 *
 * Isolation preflight (GT1-11-08B): before anything could spawn, every case
 * that needs the binary is held to the declared disposable boundary (actual OS
 * home, owned local/SSH roots, no production home or readable operator
 * credentials), the immutable pinned binary (read-only, sha256 before and
 * after), inspected system/managed policy, empty or synthetic hooks/MCP/plugins
 * with envrc off, and verified update/telemetry/background-upload suppression
 * or an operation-aware egress boundary (an origin allowlist alone never
 * covers a same-origin upload). The final child environment is planned through
 * the shared env layering and validated by name: credential-free for offline
 * probes, only the selected account's source for discovery and paid prompts,
 * every Grok control pinned and every ambient credential, proxy, OTEL, agent
 * socket, runtime injection and unapproved gateway refused. Offline probes,
 * discovery operations and paid prompts are separate operation sets. Unknown
 * isolation or controls are structured `not-run` reasons; no check reads a
 * previous qualification result.
 *
 * Candidate capabilities (GT1-11-08A): features implemented behind a false
 * production flag are recorded per case as a frozen harness-only snapshot
 * (route, version basis, implementing tasks, consumer seam). A snapshot never
 * changes admission, never touches a policy-bearing flag, and is a copy: the
 * run fails if the production Grok registry entry changes underneath it.
 *
 * Reuse: `canonicalJson` for the config digest, `redactSecrets` /
 * `containsCredentialToken` so nothing secret-shaped is accepted or written,
 * `isValidSecretName` for credential references, `resolveModelPricing` for
 * pricing provenance (a model the table does not know is priced `unknown`, not
 * at the default tier), `stopProcess` for owned cleanup, and
 * `isPathAtOrUnderRoot` for every root check.
 */

import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { canonicalJson } from '../../src/shared/canonicalJson';
import {
	isBlankEnvValue,
	isSecretEnvKey,
	stripBlankEnvVars,
} from '../../src/shared/agentEnvironment';
import {
	ALL_ROUTE_ENV_NAMES,
	PROVIDER_ROUTE_ENV_NAMES,
	resolveAgentEnvVars,
} from '../../src/shared/maestro-lib/launch/env';
import {
	calculateModelCost,
	DEFAULT_MODEL_PRICING,
	MODEL_PRICING,
	normalizeModelId,
	resolveModelPricing,
} from '../../src/shared/modelPricing';
import { redactSecrets } from '../../src/shared/redactSecrets';
import { containsCredentialToken } from '../../src/shared/agent-run/redact';
import { isValidSecretName, lookupSecret } from '../../src/shared/serverSecrets';
import { getAgentDefinition } from '../../src/shared/maestro-lib/providers/definitions';
import { GrokOutputParser } from '../../src/shared/maestro-lib/parsers/grok-output-parser';
import { GrokAcpClient } from '../../src/shared/maestro-lib/grok/acp-client';
import {
	GrokAcpRequestError,
	GrokAcpTransportError,
} from '../../src/shared/maestro-lib/grok/acp-protocol';
import { GROK_ACP_ARGS } from '../../src/shared/maestro-lib/grok/route';
import { checkCustomPath } from '../../src/shared/maestro-lib/launch/path-prober';
import { fixtureTurnsFor, PAID_FIXTURES, type PaidFixture } from './paid-fixtures';
import { isPathAtOrUnderRoot } from '../../src/shared/worktreePaths';
import { stopProcess } from '../../src/shared/maestro-lib/control/termination';
import { getAgentCapabilities } from '../../src/shared/maestro-lib/providers/capabilities';
import { getErrorPatterns, matchErrorPattern } from '../../src/shared/agentErrorPatterns';
import {
	classifyCredentialKind,
	credentialKindBlocksLogin,
	type CredentialKind,
} from '../../src/shared/providerAuthIdentity';
import { formatAgentLoginCommand, getAgentLoginCommand } from '../../src/shared/agentMetadata';
import type { AgentCapabilities } from '../../src/shared/types';

export const CONFIG_SCHEMA = 'grok-qualification-config/v1';
export const RECEIPT_SCHEMA = 'grok-qualification-receipt/v1';
export const ENVIRONMENT_CONTRACT = 'grok-acceptance-environment/v1';
/** Every owned run lives under this checkout-relative root (DESIGN.md GT1-01-05). */
export const RUNS_ROOT = 'tmp/grok-tier1-environment/runs';

/**
 * What this harness can do today. A later packet flips its own flag when it
 * lands; until then the matching cases stay `not-run` whatever the config says.
 */
export const HARNESS_CAPABILITIES = {
	/** Pre-spawn isolation and discovery preflight (GT1-11-08B). */
	isolationPreflight: true,
	/** Atomic shared reservation / provider-cap admission (GT1-11-08C). */
	atomicSpendAdmission: true,
	/** The bounded offline-inspection executor: version/help of the pinned binary (GT1-11-10A). */
	offlineExecutor: true,
	/**
	 * The paid executor bound to an admitted tuple (GT1-11-11P1). It covers the
	 * native-headless and ACP legs of a local Grok-only paid case; SSH and
	 * cross-provider legs stay `case-executor-unimplemented`.
	 */
	caseExecutor: true,
	/**
	 * The local discovery executor (GT1-11-11A1): only the authorized
	 * `DISCOVERY_OPERATIONS` of the case route, never a prompt. An SSH discovery
	 * leg stays `case-executor-unimplemented` (GT1-11-11A3).
	 */
	discoveryExecutor: true,
} as const;
export type HarnessCapabilities = { [K in keyof typeof HARNESS_CAPABILITIES]: boolean };

export type ExecutionClass = 'deterministic' | 'offline-inspection' | 'discovery' | 'paid';
export type Route = 'native-headless' | 'acp-stdio';
export type Target = 'local' | 'ssh';
export type ProviderId = 'grok' | 'claude-code' | 'codex';

export type CredentialReference =
	| { provider: ProviderId; account: 'A' | 'B'; kind: 'secret-name'; name: string }
	| { provider: ProviderId; account: 'A' | 'B'; kind: 'file'; path: string };

export interface QualificationLimits {
	budgetUsd: number;
	maxCalls: number;
	maxTurns: number;
	maxWallClockSeconds: number;
	perCase: {
		budgetUsd: number;
		maxCalls: number;
		maxTurns: number;
		maxWallClockSeconds: number;
	};
	cleanupSeconds: number;
}

export interface QualificationConfig {
	schema: typeof CONFIG_SCHEMA;
	authorizationReference: string | null;
	expiresAt: string | null;
	providers: ProviderId[];
	credentialReferences: CredentialReference[];
	allowedRoots: string[];
	allowedEndpoints: string[];
	allowedSshTargets: string[];
	allowedModels: string[];
	binary: { path: string | null; sha256: string | null; version: string | null };
	autoUpdateDisabled: boolean;
	isolationReceipt: string | null;
	/** The audited disposable boundary the preflight holds every binary case to; null is not-run. */
	isolation?: IsolationDeclaration | null;
	discovery: { authorizationReference: string | null; operations: string[] };
	spendGuarantee:
		| { kind: 'worst-case-reservation'; reference: string }
		| {
				kind: 'provider-cap';
				reference: string;
				capUsd: number;
				/** Providers whose account the enforced cap covers; omitted means Grok only. */
				providers?: ProviderId[];
		  }
		| null;
	/** Worst-case work bounds behind a reservation (GT1-11-08C); null leaves the cost unknown. */
	spendBounds?: SpendBounds | null;
	limits: QualificationLimits;
	cases: string[];
	/**
	 * What an E07 paid leg selects (GT1-11-11A2): the reasoning effort it asks
	 * for and the gateway variables its credentialed child receives. Each
	 * gateway must name an approved origin; absent, an E07 leg refuses unsent.
	 */
	selection?: { effort: string | null; gateways?: Record<string, string> } | null;
	/**
	 * The binary-resolution leg's custom path (GT1-11-11A2): an owned path,
	 * under the runs root, that must resolve to the pinned binary itself.
	 */
	binaryResolution?: { customPath: string | null } | null;
}

export interface SpendBounds {
	/** The most one billable model call may charge, in tokens. */
	perCall: {
		inputTokens: number;
		outputTokens: number;
		cacheReadTokens: number;
		cacheCreationTokens: number;
	};
	/** Billable calls per user turn: internal rounds, descendants, retries, side models, compaction. */
	perTurnCalls: {
		modelRounds: number;
		children: number;
		retries: number;
		sideModels: number;
		compaction: number;
	};
	/** Models a child, side call or compaction may use beyond allowedModels; each must be priced or capped. */
	sideModels: string[];
}

export interface ConfigProblem {
	field: string;
	code: string;
}

export interface CaseFamily {
	id: string;
	requirementIds: string[];
	ownerTasks: string[];
	expectedInvariant: string;
	blockerIds: string[];
}

export interface QualificationCase {
	caseId: string;
	family: string;
	route: Route;
	target: Target;
	classes: ExecutionClass[];
	providers: ProviderId[];
	requirementIds: string[];
	ownerTasks: string[];
}

export interface AdmissionReason {
	id: string;
	kind:
		| 'admission-input'
		| 'harness-capability'
		| 'config-problem'
		| 'pricing'
		| 'isolation-preflight'
		| 'spend-admission'
		| 'offline-execution'
		| 'discovery-execution'
		| 'paid-execution';
	detail: string;
	owner?: string;
}

export interface PricingProvenance {
	model: string;
	source: 'exact' | 'family' | 'unknown';
	/** Present only when the table knows the model; never a default-tier guess. */
	inputPerMillion?: number;
	outputPerMillion?: number;
}

export interface CaseReceipt {
	caseId: string;
	family: string;
	route: Route;
	target: Target;
	classes: ExecutionClass[];
	providers: ProviderId[];
	requirementIds: string[];
	ownerTasks: string[];
	status: 'not-run' | 'admitted';
	reasons: AdmissionReason[];
	spawned: number;
	paidRequests: number;
	networkContacts: number;
	pricing: PricingProvenance[];
	budget: {
		reservedUsd: number;
		settledUsd: number;
		uncertainUsd: number;
		calls: number;
		/** Worst-case plan and guarantee provenance for a paid case; null otherwise. */
		plan: ReservationPlan | null;
		/** Every reservation this case held (one per leg), with its effect provenance. */
		reservations: SpendReservation[];
	};
	cleanup: { ownedProcesses: number; stopped: number };
	/** Harness-only candidate capabilities for this case; never production availability. */
	candidateSnapshot: CandidateCapabilitySnapshot | null;
	/** Pre-spawn isolation and discovery preflight; null when the case needs no binary. */
	preflight: PreflightResult | null;
	/**
	 * The offline-inspection leg, a separate entry from the discovery/paid leg
	 * the fields above describe: its own admission, preflight, probes and
	 * spawns. Null when the case has no offline-inspection class.
	 */
	offlineLeg: OfflineLegReceipt | null;
	/** The binary-resolution leg (no spawn, no network, no credential); null when the case has no offline-inspection class. */
	resolutionLeg: BinaryResolutionLegReceipt | null;
	/** Discovery legs the executor ran or refused (one per account); empty when the case was not admitted. */
	discoveryLegs: DiscoveryLegReceipt[];
	/** Paid legs the executor ran or refused (one per account); empty when the case was not admitted. */
	paidLegs: PaidLegReceipt[];
}

/**
 * How the selected credential fared in a discovery leg. Classified only by the
 * canonical Grok error patterns over what the leg observed; the guidance is an
 * instruction for a person and is never acted on (no login, retry or account switch).
 */
export type DiscoveryAuthStatus =
	| 'ok'
	| 'missing'
	| 'expired'
	| 'restricted'
	| 'unclassified-failure'
	| 'not-observed';

export interface DiscoveryAuthOutcome {
	status: DiscoveryAuthStatus;
	/** The canonical Grok error type the evidence matched; null when nothing matched. */
	errorType: string | null;
	message: string | null;
	/** The credential the leg presented, classified from its planned env by name (never a value). */
	credentialKind: CredentialKind;
	credentialEnvVar: string | null;
	/** An actionable re-auth instruction for missing/expired/restricted, else null. */
	guidance: string | null;
}

/** One authorized discovery operation and what the peer reported for it. */
export interface DiscoveryOperationResult {
	operation: string;
	outcome: 'passed' | 'failed' | 'not-run';
	detail: string;
	durationMs: number;
}

/**
 * An advertised catalog exactly as reported. Protocol-defined fields are
 * copied verbatim and stay null when absent; nothing is inferred (a context
 * window is whatever per-model field the peer itself reported inside `models`).
 */
export interface DiscoveryCatalog {
	operation: string;
	models: unknown;
	currentModel: unknown;
	modelMenu: unknown;
	effortMenu: unknown;
	/** The whole reported payload when bounded (JSON, or the text lines of a native listing), else null. */
	raw: unknown;
	format: 'json' | 'text';
	sha256: string;
	bytes: number;
	truncated: boolean;
}

export interface DiscoveryLegReceipt {
	leg: 'discovery';
	account: 'A' | 'B';
	route: Route;
	target: Target;
	/** The executing host: `local`, or the approved SSH target. */
	host: string;
	/** The selected account's credential reference (a secret name or a file path, never a value). */
	credential: { kind: CredentialReference['kind']; reference: string } | null;
	/** not-run: refused before spawn; failed: an operation, auth or identity check failed; passed: otherwise. */
	status: 'not-run' | 'passed' | 'failed';
	reasons: AdmissionReason[];
	/** The authorized operations this leg ran, in order. */
	operations: DiscoveryOperationResult[];
	catalogs: DiscoveryCatalog[];
	/** The ACP initialize result as negotiated; null on the native route or when it never answered. */
	initialization: unknown;
	auth: DiscoveryAuthOutcome | null;
	binary: { sha256Pinned: string | null; sha256AtSpawn: string | null; sha256After: string | null };
	/** Names only (never values) of the validated child environment. */
	launch: { credentialMode: CredentialMode; keys: string[] } | null;
	/** Each owned child: argv, exit and stream digests. */
	spawns: OfflineProbeResult[];
	spawned: number;
	/** Requests handed to a running child; each may reach the endpoint. */
	networkContacts: number;
	/** Always 0: discovery never sends a prompt. */
	paidRequests: 0;
}

/** One credential-free offline probe of the pinned binary; output is kept as digests only. */
export interface OfflineProbeResult {
	probe: string;
	argv: string[];
	exitCode: number | null;
	signal: string | null;
	durationMs: number;
	timedOut: boolean;
	spawnError: string | null;
	stdout: { sha256: string; bytes: number; truncated: boolean };
	stderr: { sha256: string; bytes: number; truncated: boolean };
}

export interface OfflineLegReceipt {
	leg: 'offline-inspection';
	/** not-run: refused before spawn; failed: a probe or identity check failed; passed: both probes agree with the pin. */
	status: 'not-run' | 'passed' | 'failed';
	/** Admission refusals when not-run, execution failures when failed; empty when passed. */
	reasons: AdmissionReason[];
	preflight: PreflightResult | null;
	binary: {
		sha256Pinned: string | null;
		sha256AtSpawn: string | null;
		sha256After: string | null;
		versionPinned: string | null;
		versionObserved: string | null;
	};
	probes: OfflineProbeResult[];
	spawned: number;
	/** Always 0: the leg runs under deny-all egress with no endpoint and no credential. */
	networkContacts: 0;
	cleanup: { ownedProcesses: number; stopped: number };
}

export interface BudgetLedger {
	/** One ledger per run, shared by every case and every authorized provider. */
	readonly key: string;
	readonly limitUsd: number;
	readonly limitCalls: number;
	readonly limitTurns: number;
	/** The overall run deadline; no leg or roundtrip extends it. */
	readonly deadlineAt: string;
	reservedUsd: number;
	settledUsd: number;
	/** Charges that may have happened; never refunded, never read as zero. */
	uncertainUsd: number;
	calls: number;
	turns: number;
	byProvider: Record<string, { reservedUsd: number; settledUsd: number; uncertainUsd: number }>;
	/** Cases whose admission passed; only these may reserve. */
	authorizedCaseIds: string[];
	reservations: SpendReservation[];
}

export interface QualificationReceipt {
	schema: typeof RECEIPT_SCHEMA;
	contract: typeof ENVIRONMENT_CONTRACT;
	runId: string;
	startedAt: string;
	finishedAt: string;
	configSource: 'default-run-state' | 'file';
	configDigest: string;
	configProblems: ConfigProblem[];
	capabilities: HarnessCapabilities;
	ledger: BudgetLedger;
	candidateCapabilities: {
		schema: typeof CANDIDATE_SNAPSHOT_SCHEMA;
		productionDigestBefore: string;
		productionDigestAfter: string;
		candidates: CandidateCapability[];
		nonCandidates: typeof NON_CANDIDATE_CAPABILITIES;
		snapshots: number;
	};
	isolationContract: {
		schema: typeof PREFLIGHT_SCHEMA;
		requiredControls: string[];
		offlineProbes: string[];
		discoveryOperations: string[];
	};
	totals: {
		cases: number;
		admitted: number;
		notRun: number;
		spawned: number;
		paidRequests: number;
		networkContacts: number;
	};
	cases: CaseReceipt[];
}

const ROUTES: Route[] = ['native-headless', 'acp-stdio'];
const TARGETS: Target[] = ['local', 'ssh'];

/** Which execution classes a family needs. E02 is discovery plus offline inspection; E11 is cross-provider. */
function familyClasses(id: string): ExecutionClass[] {
	if (id === 'E02') return ['offline-inspection', 'discovery'];
	if (id === 'E07') return ['discovery', 'paid'];
	return ['paid'];
}

function familyProviders(id: string): ProviderId[] {
	return id === 'E11' ? ['grok', 'claude-code', 'codex'] : ['grok'];
}

/** Expand every recorded family over route x target with a stable case ID. */
export function expandCases(families: CaseFamily[], selected: string[] = []): QualificationCase[] {
	const out: QualificationCase[] = [];
	for (const family of families) {
		for (const route of ROUTES) {
			for (const target of TARGETS) {
				const caseId = `${family.id}:${route}:${target}`;
				if (selected.length && !selected.includes(family.id) && !selected.includes(caseId))
					continue;
				out.push({
					caseId,
					family: family.id,
					route,
					target,
					classes: familyClasses(family.id),
					providers: familyProviders(family.id),
					requirementIds: [...family.requirementIds],
					ownerTasks: [...family.ownerTasks],
				});
			}
		}
	}
	return out;
}

/** The run-state configuration: today every reference is null and every limit zero. */
export function defaultConfigFromRunState(runState: {
	live?: Record<string, unknown>;
	testEnvironment?: { authorization?: Record<string, unknown> };
}): QualificationConfig {
	const live = runState.live ?? {};
	const auth = runState.testEnvironment?.authorization ?? {};
	const num = (v: unknown) => (typeof v === 'number' ? v : 0);
	const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
	const list = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
	return {
		schema: CONFIG_SCHEMA,
		authorizationReference: str(live.authorizationReference) ?? str(auth.configurationReference),
		expiresAt: str(auth.expiresAt),
		providers: ['grok'],
		credentialReferences: [],
		allowedRoots: list(auth.allowedRoots),
		allowedEndpoints: list(live.allowedEndpoints),
		allowedSshTargets: list(live.allowedSshTargets),
		allowedModels: [],
		binary: { path: null, sha256: null, version: null },
		autoUpdateDisabled: false,
		isolationReceipt: str(auth.isolationReceipt),
		isolation: null,
		discovery: {
			authorizationReference: str(auth.discoveryAuthorizationReference),
			operations: list(auth.allowedDiscoveryOperations),
		},
		spendGuarantee: null,
		spendBounds: null,
		limits: {
			budgetUsd: num(live.budgetUsd),
			maxCalls: num(live.maxCalls),
			maxTurns: num(live.maxTurns),
			maxWallClockSeconds: num(live.maxWallClockSeconds),
			perCase: { budgetUsd: 0, maxCalls: 0, maxTurns: 0, maxWallClockSeconds: 0 },
			cleanupSeconds: 5,
		},
		cases: [],
	};
}

const positiveFinite = (n: unknown): n is number =>
	typeof n === 'number' && Number.isFinite(n) && n > 0;

/** Every string leaf of a value, with its dotted path. */
function stringLeaves(value: unknown, at = ''): Array<[string, string]> {
	if (typeof value === 'string') return [[at, value]];
	if (Array.isArray(value)) return value.flatMap((v, i) => stringLeaves(v, `${at}[${i}]`));
	if (value && typeof value === 'object')
		return Object.entries(value).flatMap(([k, v]) => stringLeaves(v, at ? `${at}.${k}` : k));
	return [];
}

/** An approved endpoint is a bare `https://host[:port]` origin: no path, wildcard or userinfo. */
export function endpointOriginProblem(endpoint: string): string | null {
	let url: URL;
	try {
		url = new URL(endpoint);
	} catch {
		return 'endpoint-not-a-url';
	}
	if (url.protocol !== 'https:') return 'endpoint-not-https';
	if (url.username || url.password) return 'endpoint-has-userinfo';
	if (endpoint.includes('*')) return 'endpoint-wildcard';
	if ((url.pathname && url.pathname !== '/') || url.search || url.hash)
		return 'endpoint-not-an-origin';
	return null;
}

export class EndpointNotApprovedError extends Error {
	constructor(readonly origin: string) {
		super(`Endpoint origin is not approved for this qualification run: ${origin}`);
		this.name = 'EndpointNotApprovedError';
	}
}

/**
 * The only door a future case uses before any network operation. Exact origin
 * match against the validated allowlist; an empty list denies everything.
 */
export function assertEndpointApproved(url: string, config: QualificationConfig): void {
	let origin: string;
	try {
		origin = new URL(url).origin;
	} catch {
		throw new EndpointNotApprovedError(String(url));
	}
	const approved = config.allowedEndpoints
		.filter((e) => endpointOriginProblem(e) === null)
		.map((e) => new URL(e).origin);
	if (!approved.includes(origin)) throw new EndpointNotApprovedError(origin);
}

/** Validate a configuration. Problems never throw; they become `config-problem` reasons. */
export function validateConfig(config: QualificationConfig, workspace: string): ConfigProblem[] {
	const problems: ConfigProblem[] = [];
	const add = (field: string, code: string) => problems.push({ field, code });
	if (config.schema !== CONFIG_SCHEMA) add('schema', 'unknown-schema');
	for (const [field, value] of stringLeaves(config)) {
		if (containsCredentialToken(value) || redactSecrets(value).redacted)
			add(field, 'secret-value-in-config');
	}
	const runsRoot = path.join(workspace, RUNS_ROOT).replace(/\\/g, '/');
	config.allowedRoots.forEach((root, i) => {
		const resolved = path.resolve(workspace, root).replace(/\\/g, '/');
		if (!isPathAtOrUnderRoot(resolved, runsRoot)) add(`allowedRoots[${i}]`, 'root-outside-runs');
	});
	config.allowedEndpoints.forEach((e, i) => {
		const problem = endpointOriginProblem(e);
		if (problem) add(`allowedEndpoints[${i}]`, problem);
	});
	config.credentialReferences.forEach((ref, i) => {
		if (ref.kind === 'secret-name') {
			if (!isValidSecretName(ref.name)) add(`credentialReferences[${i}]`, 'invalid-secret-name');
		} else if (ref.kind === 'file') {
			const resolved = path.resolve(workspace, ref.path).replace(/\\/g, '/');
			if (!isPathAtOrUnderRoot(resolved, runsRoot))
				add(`credentialReferences[${i}]`, 'credential-file-outside-runs');
		} else add(`credentialReferences[${i}]`, 'unknown-credential-kind');
	});
	if (config.binary.sha256 && !/^[0-9a-f]{64}$/.test(config.binary.sha256))
		add('binary.sha256', 'not-a-sha256');
	if (config.expiresAt && Number.isNaN(Date.parse(config.expiresAt)))
		add('expiresAt', 'not-a-timestamp');
	if (
		config.spendGuarantee?.kind === 'provider-cap' &&
		!positiveFinite(config.spendGuarantee.capUsd)
	)
		add('spendGuarantee.capUsd', 'cap-not-positive-finite');
	if (config.spendGuarantee?.kind === 'provider-cap')
		(config.spendGuarantee.providers ?? []).forEach((p, i) => {
			if (!['grok', 'claude-code', 'codex'].includes(p))
				add(`spendGuarantee.providers[${i}]`, 'unknown-provider');
		});
	for (const key of Object.keys(config.selection?.gateways ?? {}))
		if (!GROK_GATEWAY_ENV.includes(key))
			add(`selection.gateways.${key}`, 'gateway-variable-unknown');
	const customPath = config.binaryResolution?.customPath;
	if (
		customPath &&
		!isPathAtOrUnderRoot(path.resolve(workspace, customPath).replace(/\\/g, '/'), runsRoot)
	)
		add('binaryResolution.customPath', 'custom-path-outside-runs');
	return problems;
}

/**
 * Where a price came from. `resolveModelPricing` falls back to the default tier
 * for a model it does not know; for a reservation that fallback is an unknown
 * price, so it is reported as `unknown` with no rates.
 */
export function pricingProvenance(model: string): PricingProvenance {
	const normalized = normalizeModelId(model);
	if (MODEL_PRICING[normalized]) {
		const p = MODEL_PRICING[normalized];
		return {
			model,
			source: 'exact',
			inputPerMillion: p.INPUT_PER_MILLION,
			outputPerMillion: p.OUTPUT_PER_MILLION,
		};
	}
	const resolved = resolveModelPricing(model);
	const family = /gpt-5|codex|fable|mythos|haiku|opus|sonnet/.test(normalized);
	if (family || resolved !== DEFAULT_MODEL_PRICING)
		return {
			model,
			source: 'family',
			inputPerMillion: resolved.INPUT_PER_MILLION,
			outputPerMillion: resolved.OUTPUT_PER_MILLION,
		};
	return { model, source: 'unknown' };
}

// ---------------------------------------------------------------------------
// Candidate capability snapshots (GT1-11-08A)
// ---------------------------------------------------------------------------

export const CANDIDATE_SNAPSHOT_SCHEMA = 'grok-candidate-capability-snapshot/v1';
/** The version profile every candidate is judged against; no range is qualified yet. */
export const CANDIDATE_VERSION_PROFILE = 'official-grok-candidate';

type CapabilityFlag = {
	[K in keyof AgentCapabilities]-?: NonNullable<AgentCapabilities[K]> extends boolean ? K : never;
}[keyof AgentCapabilities];

/**
 * How a candidate reaches a consumer. `capabilities-parameter`: the consumer
 * reads an `AgentCapabilities` / agent config object handed to it, so an
 * executor can pass the snapshot. `global-registry`: the consumer reads
 * `hasCapability()` off the production registry, which this harness never
 * mutates, so that consumer cannot see the candidate and its evaluation stays
 * not-run until it takes a capabilities parameter.
 */
export type CandidateSeam = 'capabilities-parameter' | 'global-registry';

export interface CandidateCapability {
	flag: CapabilityFlag;
	candidateValue: true;
	/** Routes whose implementation exists; another route never receives the override. */
	routes: Route[];
	/** Case families that evaluate it. */
	families: string[];
	parityRows: string[];
	implementedBy: string[];
	consumers: Array<{ path: string; seam: CandidateSeam }>;
	basis: string;
}

/**
 * Implemented behind a false production flag. Each entry names the work that
 * implemented it and the consumers that would read it. Being listed is not
 * availability: production keeps `false` until GT1-11-14A finalizes the
 * registry from observed evidence.
 */
export const CANDIDATE_CAPABILITIES: readonly CandidateCapability[] = Object.freeze([
	{
		flag: 'supportsSlashCommands',
		candidateValue: true,
		routes: ['acp-stdio', 'native-headless'],
		families: ['E08'],
		parityRows: ['P18', 'C-supportsSlashCommands'],
		implementedBy: ['GT1-05-03', 'GT1-05-03A', 'GT1-05-03B'],
		consumers: [
			{ path: 'src/renderer/App.tsx', seam: 'capabilities-parameter' },
			{
				path: 'src/renderer/components/QuickActionsModal/commands/featureCommands.ts',
				seam: 'capabilities-parameter',
			},
		],
		basis:
			'Session-scoped ACP available_commands catalog and bounded detached native capture; execution semantics unobserved on a pinned binary',
	},
	{
		flag: 'supportsGroupChatModeration',
		candidateValue: true,
		routes: ['acp-stdio', 'native-headless'],
		families: ['E09'],
		parityRows: ['C-supportsGroupChatModeration'],
		implementedBy: ['GT1-08-12'],
		consumers: [{ path: 'src/shared/maestro-lib/groupchat/storage.ts', seam: 'global-registry' }],
		basis:
			'Host orchestration with qualified participant/synthesis turns passes deterministically; moderator creation is refused by the production flag',
	},
]);

/** Production-false flags that are NOT candidates, and why forcing them would misstate the product. */
export const NON_CANDIDATE_CAPABILITIES: ReadonlyArray<{
	flag: CapabilityFlag;
	reason: string;
	parityRow: string;
}> = Object.freeze([
	{
		flag: 'supportsAppendSystemPrompt',
		reason: 'native append/rules unimplemented; canonical first-turn embedding is the delivery',
		parityRow: 'C-supportsAppendSystemPrompt',
	},
	{
		flag: 'supportsProjectMemory',
		reason: 'native memory binding unimplemented; the truthful refusal is the delivery',
		parityRow: 'C-supportsProjectMemory',
	},
	{
		flag: 'supportsAdditionalDirectories',
		reason: 'no qualified native root-grant builder; policy-bearing, never forced',
		parityRow: 'C-supportsAdditionalDirectories',
	},
	{
		flag: 'supportsPromptViaStdin',
		reason: 'no raw-stdin producer; false is the truthful transport declaration',
		parityRow: 'C-supportsPromptViaStdin',
	},
	{
		flag: 'supportsStreamJsonInput',
		reason: 'no Claude-style stdin producer; ACP RPC is its own transport',
		parityRow: 'C-supportsStreamJsonInput',
	},
	{
		flag: 'usesCombinedContextWindow',
		reason:
			'a usage-semantics declaration, not a withheld feature; forcing it would misreport occupancy',
		parityRow: 'C-usesCombinedContextWindow',
	},
]);

/** Flags that carry an effect control. A candidate may never touch them. */
export const POLICY_BEARING_FLAGS: readonly CapabilityFlag[] = Object.freeze([
	'supportsReadOnlyMode',
	'supportsStandardPermissionMode',
	'supportsAdditionalDirectories',
]);

export interface CandidateOverride {
	flag: CapabilityFlag;
	production: boolean;
	candidate: boolean;
	implementedBy: string[];
	parityRows: string[];
	consumers: Array<{ path: string; seam: CandidateSeam }>;
}

export interface CandidateCapabilitySnapshot {
	schema: typeof CANDIDATE_SNAPSHOT_SCHEMA;
	/** Confined to this harness process and the case it was built for. */
	scope: 'qualification-harness-only';
	productionAvailability: false;
	policyWaiver: false;
	caseId: string;
	route: Route;
	target: Target;
	versionBasis: {
		profile: typeof CANDIDATE_VERSION_PROFILE;
		supportedRange: null;
		pinnedVersion: string | null;
		pinnedSha256: string | null;
		/** `unbound` until a pinned binary exists; an executor must refuse an unbound snapshot. */
		state: 'bound-to-pinned-binary' | 'unbound';
	};
	/** sha256 of the production Grok registry entry the snapshot was derived from. */
	productionDigest: string;
	overrides: CandidateOverride[];
	/** A fresh frozen object; the production registry is never written. */
	capabilities: Readonly<AgentCapabilities>;
}

/** Digest of the production Grok capability entry, to prove the registry was not written. */
export function productionCapabilityDigest(): string {
	return createHash('sha256')
		.update(canonicalJson(getAgentCapabilities('grok')))
		.digest('hex');
}

/**
 * Build the candidate snapshot for one case: the production entry copied, with
 * only the listed candidates for this route/family applied, and only where
 * production says `false`. Returns null when no candidate applies. Admission
 * is untouched; the snapshot is what a future executor hands to consumers.
 */
export function buildCandidateSnapshot(
	c: QualificationCase,
	config: QualificationConfig,
	candidates: readonly CandidateCapability[] = CANDIDATE_CAPABILITIES
): CandidateCapabilitySnapshot | null {
	const production = getAgentCapabilities('grok');
	const overrides: CandidateOverride[] = [];
	for (const candidate of candidates) {
		if (POLICY_BEARING_FLAGS.includes(candidate.flag))
			throw new Error(`Candidate may not override policy-bearing flag ${candidate.flag}`);
		if (NON_CANDIDATE_CAPABILITIES.some((n) => n.flag === candidate.flag))
			throw new Error(`Flag ${candidate.flag} is not an implemented candidate`);
		if (!candidate.routes.includes(c.route) || !candidate.families.includes(c.family)) continue;
		// Production already advertising it needs no override and records none.
		if (Boolean(production[candidate.flag]) === candidate.candidateValue) continue;
		overrides.push({
			flag: candidate.flag,
			production: Boolean(production[candidate.flag]),
			candidate: candidate.candidateValue,
			implementedBy: [...candidate.implementedBy],
			parityRows: [...candidate.parityRows],
			consumers: candidate.consumers.map((x) => ({ ...x })),
		});
	}
	if (!overrides.length) return null;
	const capabilities: AgentCapabilities = { ...production };
	for (const o of overrides) capabilities[o.flag] = o.candidate;
	const b = config.binary;
	const bound = Boolean(b.path && b.sha256 && b.version);
	return {
		schema: CANDIDATE_SNAPSHOT_SCHEMA,
		scope: 'qualification-harness-only',
		productionAvailability: false,
		policyWaiver: false,
		caseId: c.caseId,
		route: c.route,
		target: c.target,
		versionBasis: {
			profile: CANDIDATE_VERSION_PROFILE,
			supportedRange: null,
			pinnedVersion: b.version,
			pinnedSha256: b.sha256,
			state: bound ? 'bound-to-pinned-binary' : 'unbound',
		},
		productionDigest: productionCapabilityDigest(),
		overrides,
		capabilities: Object.freeze(capabilities),
	};
}

// ---------------------------------------------------------------------------
// Pre-spawn isolation and discovery preflight (GT1-11-08B)
// ---------------------------------------------------------------------------

export const PREFLIGHT_SCHEMA = 'grok-isolation-preflight/v1';

/** How a suppression control is known to hold: only `verified` counts without an operation-aware boundary. */
export type SuppressionState = 'verified' | 'flags-only' | 'unknown';
export type ResourceState = 'empty' | 'synthetic-owned' | 'unknown';

/**
 * What the operator's audit says of the disposable boundary. Every field is a
 * declaration with a reference; the preflight checks what it can observe
 * (paths, the binary, the planned environment) and refuses every unknown.
 */
export interface IsolationDeclaration {
	boundary: {
		kind: 'disposable-os-account' | 'vm' | 'container' | 'audited-namespace';
		reference: string;
		/** The child's actual OS home inside the boundary; an owned path, never the operator's. */
		actualHome: string;
		productionHomeMounted: boolean | null;
		operatorCredentialsReadable: boolean | null;
	} | null;
	/** Owned Grok account homes (`GROK_HOME`), under the allowed roots. */
	accountRoots: { A?: string; B?: string };
	/** Per approved SSH target: the owned remote root and the remote binary's sha256. */
	remoteRoots: Record<string, { root: string; binarySha256: string | null }>;
	policy: {
		systemPolicyInspected: boolean;
		managedPolicy: 'absent' | 'synthetic' | 'unknown';
		requiredPolicyCompatible: boolean | null;
	};
	resources: {
		hooks: ResourceState;
		mcp: ResourceState;
		plugins: ResourceState;
		envrc: 'disabled' | 'unknown';
	};
	egress: {
		kind: 'deny-all' | 'operation-aware' | 'origin-allowlist' | 'none';
		reference: string | null;
		suppression: {
			update: SuppressionState;
			telemetry: SuppressionState;
			backgroundUpload: SuppressionState;
		};
	};
	/** PATH entries for the child, inside the boundary. */
	path: string[];
}

const COMPAT_VENDORS = ['CLAUDE', 'CURSOR', 'CODEX'] as const;
const COMPAT_SURFACES = ['SKILLS', 'RULES', 'AGENTS', 'MCPS', 'HOOKS', 'SESSIONS'] as const;

/**
 * The Grok controls every planned child carries (run-state
 * `testEnvironment.controlAudit.envOverrides` plus the 18 compatibility
 * scanners). Source-supported values; exact-binary efficacy is what the egress
 * and suppression declarations must vouch for, not these flags alone.
 */
export const GROK_CONTROL_ENV: Readonly<Record<string, string>> = Object.freeze({
	GROK_DISABLE_AUTOUPDATER: '1',
	GROK_TELEMETRY_ENABLED: '0',
	GROK_TELEMETRY_TRACE_UPLOAD: '0',
	GROK_TELEMETRY_MIXPANEL_ENABLED: '0',
	GROK_EXTERNAL_OTEL: '0',
	...Object.fromEntries(
		COMPAT_VENDORS.flatMap((v) => COMPAT_SURFACES.map((s) => [`GROK_${v}_${s}_ENABLED`, '0']))
	),
});

/** Credential-free offline probes: the only invocations an offline-inspection case may make. */
export const OFFLINE_PROBES: Readonly<Record<string, readonly string[]>> = Object.freeze({
	version: ['--version'],
	help: ['--help'],
});

/**
 * Discovery operations a run may authorize by id, per route. Anything else in
 * `discovery.operations` is unknown and refused; discovery never implies a
 * prompt, and a catalog operation needs no preselected model.
 */
export const DISCOVERY_OPERATIONS: Readonly<Record<string, { route: Route; detail: string }>> =
	Object.freeze({
		'acp-initialize': { route: 'acp-stdio', detail: 'ACP initialize and capability negotiation' },
		'acp-session-new': { route: 'acp-stdio', detail: 'ACP session/new without a prompt' },
		'acp-model-catalog': { route: 'acp-stdio', detail: 'ACP config/model menu read' },
		'native-model-catalog': {
			route: 'native-headless',
			detail: 'native model listing without a prompt',
		},
	});

/** Gateway names Grok splits its endpoint across; allowed only to an approved origin. */
const GROK_GATEWAY_ENV = [
	'GROK_MODELS_BASE_URL',
	'GROK_CLI_CHAT_PROXY_BASE_URL',
	'GROK_XAI_API_BASE_URL',
];

const DENIED_ENV_PATTERNS: ReadonlyArray<[RegExp, string]> = [
	[/^(https?|all|no|ftp)_proxy$/i, 'proxy'],
	[/^OTEL_/i, 'otel'],
	[/^SSH_(AUTH_SOCK|AGENT_PID)$/, 'ssh-agent'],
	[/^(AWS_|AZURE_|GCLOUD_|CLOUDSDK_|GOOGLE_APPLICATION_CREDENTIALS$)/, 'cloud-credential'],
	[/^(NODE_OPTIONS|LD_PRELOAD|LD_LIBRARY_PATH|BASH_ENV|DYLD_.*)$/, 'runtime-injection'],
	[/^GROK_.*(OIDC|AUTH_PROVIDER|AUTH_HELPER|EXTERNAL_AUTH|LOGIN)/, 'auth-helper'],
	[/^GROK_FOLDER_TRUST$/, 'folder-trust-ungates-hooks'],
	[/^XAI_/, 'xai-ambient'],
];

export type CredentialMode = 'none' | 'file' | 'secret-name';

export interface LaunchEnvironmentExpectation {
	/** `local` paths are checked with the host's resolver, `ssh` paths as remote POSIX paths. */
	target: Target;
	home: string;
	accountRoot: string;
	roots: string[];
	credentialMode: CredentialMode;
	/** The selected auth file the child must read (file mode only). */
	authPath: string | null;
	operatorHome: string;
	approvedEndpoints: string[];
}

export interface LaunchEnvironmentReport {
	keys: string[];
	denied: string[];
	missingControls: string[];
	reasons: AdmissionReason[];
}

const preflightReason = (id: string, detail: string): AdmissionReason => ({
	id,
	kind: 'isolation-preflight',
	detail,
	owner: 'GT1-11-08B',
});

function normalizeFor(target: Target, p: string): string {
	return target === 'ssh' ? path.posix.normalize(p) : path.resolve(p).replace(/\\/g, '/');
}

function underAny(target: Target, p: string, roots: string[]): boolean {
	const n = normalizeFor(target, p);
	return roots.some((r) => isPathAtOrUnderRoot(n, normalizeFor(target, r)));
}

/** True when two paths are equal or one contains the other. */
function overlaps(target: Target, a: string, b: string): boolean {
	const x = normalizeFor(target, a);
	const y = normalizeFor(target, b);
	return isPathAtOrUnderRoot(x, y) || isPathAtOrUnderRoot(y, x);
}

/**
 * Validate a final child environment by NAME (values are never reported). An
 * executor hands its fully resolved launch (after every custom layer and
 * managed pin, e.g. `buildAgentEnvironment` output) through this same check;
 * an inherited ambient credential there is refused exactly as here.
 */
export function validateLaunchEnvironment(
	env: Record<string, string | undefined>,
	expect: LaunchEnvironmentExpectation
): LaunchEnvironmentReport {
	const reasons: AdmissionReason[] = [];
	const denied: string[] = [];
	const missingControls: string[] = [];
	const set = Object.fromEntries(
		Object.entries(env).filter(
			(e): e is [string, string] => typeof e[1] === 'string' && !isBlankEnvValue(e[1])
		)
	);
	const grok = PROVIDER_ROUTE_ENV_NAMES.grok;
	const allowed = new Set<string>([grok.accountDir ?? 'GROK_HOME']);
	if (expect.credentialMode === 'file') allowed.add('GROK_AUTH_PATH');
	if (expect.credentialMode === 'secret-name') allowed.add('XAI_API_KEY');
	const deny = (key: string, why: string) => {
		denied.push(key);
		reasons.push(preflightReason(`env-denied:${why}`, key));
	};

	for (const key of Object.keys(set).sort()) {
		if (key in GROK_CONTROL_ENV || key === 'HOME' || key === 'PATH') continue;
		if (key === 'GROK_AUTH') {
			deny(key, 'inline-auth');
			continue;
		}
		if (GROK_GATEWAY_ENV.includes(key)) {
			let origin: string | null = null;
			try {
				origin = new URL(set[key]).origin;
			} catch {
				origin = null;
			}
			const approved = expect.approvedEndpoints
				.filter((e) => endpointOriginProblem(e) === null)
				.map((e) => new URL(e).origin);
			if (expect.credentialMode === 'none' || !origin || !approved.includes(origin))
				deny(key, 'gateway-unapproved');
			continue;
		}
		if (allowed.has(key)) continue;
		if (ALL_ROUTE_ENV_NAMES.includes(key)) {
			deny(key, 'route-credential');
			continue;
		}
		const pattern = DENIED_ENV_PATTERNS.find(([re]) => re.test(key));
		if (pattern) {
			deny(key, pattern[1]);
			continue;
		}
		if (isSecretEnvKey(key)) deny(key, 'secret-shaped');
	}
	if (expect.credentialMode === 'file' && !set.GROK_AUTH_PATH)
		reasons.push(preflightReason('env-credential-absent', 'GROK_AUTH_PATH'));
	if (expect.credentialMode === 'secret-name' && !set.XAI_API_KEY)
		reasons.push(preflightReason('env-credential-absent', 'XAI_API_KEY'));

	for (const [key, value] of Object.entries(GROK_CONTROL_ENV)) {
		if (!(key in set)) {
			missingControls.push(key);
			reasons.push(preflightReason('env-control-missing', key));
		} else if (set[key].trim() !== value) {
			missingControls.push(key);
			reasons.push(preflightReason('env-control-wrong', key));
		}
	}

	const t = expect.target;
	const same = (a: string | undefined, b: string | null) =>
		Boolean(a && b && normalizeFor(t, a) === normalizeFor(t, b));
	if (!same(set.HOME, expect.home)) reasons.push(preflightReason('env-home-mismatch', 'HOME'));
	if (set.USERPROFILE && !same(set.USERPROFILE, expect.home))
		reasons.push(preflightReason('env-home-mismatch', 'USERPROFILE'));
	if (
		t === 'local' &&
		set.HOME &&
		isPathAtOrUnderRoot(normalizeFor(t, expect.operatorHome), normalizeFor(t, set.HOME))
	)
		reasons.push(preflightReason('env-home-is-operator-home', 'HOME'));
	if (!same(set.GROK_HOME, expect.accountRoot))
		reasons.push(preflightReason('env-grok-home-mismatch', 'GROK_HOME'));
	if (
		expect.credentialMode === 'file' &&
		set.GROK_AUTH_PATH &&
		!same(set.GROK_AUTH_PATH, expect.authPath)
	)
		reasons.push(preflightReason('env-auth-path-mismatch', 'GROK_AUTH_PATH'));
	if (set.GROK_CONFIG_PATH && !underAny(t, set.GROK_CONFIG_PATH, [expect.accountRoot]))
		reasons.push(preflightReason('env-path-outside-roots', 'GROK_CONFIG_PATH'));
	for (const key of [
		'TMPDIR',
		'TMP',
		'TEMP',
		'XDG_CONFIG_HOME',
		'XDG_DATA_HOME',
		'XDG_CACHE_HOME',
		'XDG_STATE_HOME',
	])
		if (set[key] && !underAny(t, set[key], expect.roots))
			reasons.push(preflightReason('env-path-outside-roots', key));
	if (t === 'local')
		for (const entry of (set.PATH ?? '').split(path.delimiter).filter(Boolean))
			if (
				isPathAtOrUnderRoot(normalizeFor(t, entry), normalizeFor(t, expect.operatorHome)) &&
				!underAny(t, entry, expect.roots)
			) {
				reasons.push(preflightReason('env-path-under-operator-home', 'PATH'));
				break;
			}
	return { keys: Object.keys(set).sort(), denied, missingControls, reasons };
}

export interface PlannedLaunch {
	target: Target;
	account: 'A' | 'B';
	credentialMode: CredentialMode;
	env: Record<string, string>;
	expectation: LaunchEnvironmentExpectation;
}

/**
 * Plan the child environment for one account and mode: a minimal base (PATH,
 * the boundary's HOME and owned temp roots, never `process.env`) under the
 * shared layering (`resolveAgentEnvVars`: Grok controls as the provider
 * defaults, the owned account home and selected credential source as the
 * session layer), blanks stripped by the shared spawn rule. `offline` carries
 * no credential source at all.
 */
export function planIsolatedLaunch(
	c: QualificationCase,
	config: QualificationConfig,
	account: 'A' | 'B',
	mode: 'offline' | 'credentialed',
	workspace: string,
	operatorHome: string
): PlannedLaunch | null {
	const iso = config.isolation;
	if (!iso?.boundary) return null;
	const ref = config.credentialReferences.find(
		(r) => r.provider === 'grok' && r.account === account
	);
	const credentialMode: CredentialMode =
		mode === 'offline' || !ref ? 'none' : ref.kind === 'file' ? 'file' : 'secret-name';
	let home: string;
	let accountRoot: string | undefined;
	let tmp: string;
	let authPath: string | null = null;
	let roots: string[];
	if (c.target === 'ssh') {
		const target = config.allowedSshTargets[0];
		const remote = target ? iso.remoteRoots[target] : undefined;
		if (!remote) return null;
		const root = path.posix.normalize(remote.root);
		roots = [root];
		home = path.posix.join(root, 'home');
		accountRoot = path.posix.join(root, `grok-${account.toLowerCase()}`);
		tmp = path.posix.join(root, 'cache', 'tmp');
		if (credentialMode === 'file' && ref?.kind === 'file')
			authPath = path.posix.join(root, 'auth', path.basename(ref.path));
	} else {
		roots = config.allowedRoots.map((r) => path.resolve(workspace, r));
		if (!roots.length) return null;
		home = path.resolve(workspace, iso.boundary.actualHome);
		accountRoot = iso.accountRoots[account] && path.resolve(workspace, iso.accountRoots[account]);
		tmp = path.join(roots[0], 'cache', 'tmp');
		if (credentialMode === 'file' && ref?.kind === 'file')
			authPath = path.resolve(workspace, ref.path);
	}
	if (!accountRoot) return null;
	const session: Record<string, string> = {
		GROK_HOME: accountRoot,
		GROK_CONFIG_PATH:
			c.target === 'ssh'
				? path.posix.join(accountRoot, 'config.toml')
				: path.join(accountRoot, 'config.toml'),
	};
	if (credentialMode === 'file' && authPath) session.GROK_AUTH_PATH = authPath;
	// A secret is resolved by name at spawn; the plan carries only the reference.
	if (credentialMode === 'secret-name' && ref?.kind === 'secret-name')
		session.XAI_API_KEY = `secret-ref:${ref.name}`;
	// Selected gateways ride only a credentialed launch; the validation below holds each to an approved origin.
	if (mode === 'credentialed')
		for (const [key, value] of Object.entries(config.selection?.gateways ?? {}))
			if (GROK_GATEWAY_ENV.includes(key)) session[key] = value;
	const env = {
		PATH: iso.path.join(c.target === 'ssh' ? ':' : path.delimiter),
		HOME: home,
		TMPDIR: tmp,
		TMP: tmp,
		TEMP: tmp,
		...stripBlankEnvVars(
			resolveAgentEnvVars({
				defaultEnvVars: { ...GROK_CONTROL_ENV },
				sessionCustomEnvVars: session,
			})
		),
	};
	return {
		target: c.target,
		account,
		credentialMode,
		env,
		expectation: {
			target: c.target,
			home,
			accountRoot,
			roots,
			credentialMode,
			authPath,
			operatorHome,
			approvedEndpoints: config.allowedEndpoints,
		},
	};
}

/** sha256 and mutability of a local executable, following a symlink to the real file. */
export function inspectExecutable(file: string): {
	sha256: string | null;
	regular: boolean;
	readOnly: boolean;
} {
	try {
		const real = fs.realpathSync(file);
		const st = fs.statSync(real);
		if (!st.isFile()) return { sha256: null, regular: false, readOnly: false };
		return {
			sha256: createHash('sha256').update(fs.readFileSync(real)).digest('hex'),
			regular: true,
			readOnly: (st.mode & 0o222) === 0,
		};
	} catch {
		return { sha256: null, regular: false, readOnly: false };
	}
}

export interface PreflightResult {
	schema: typeof PREFLIGHT_SCHEMA;
	caseId: string;
	status: 'pass' | 'not-run';
	operations: { offlineProbes: string[]; discovery: string[]; paidPrompts: boolean };
	binary: {
		state: 'local' | 'remote-declared' | 'unpinned';
		sha256Before: string | null;
		sha256After: string | null;
		readOnly: boolean | null;
	};
	launches: Array<{
		account: 'A' | 'B';
		mode: 'offline' | 'credentialed';
		credentialMode: CredentialMode;
		keys: string[];
		denied: string[];
		missingControls: string[];
	}>;
	reasons: AdmissionReason[];
}

export interface PreflightContext {
	workspace: string;
	/** The harness operator's own home; the child's home may neither be nor contain it. */
	operatorHome: string;
}

/**
 * The pre-spawn isolation and discovery preflight for one case. Pure apart
 * from reading the pinned binary and owned paths; it never spawns, never reads
 * a credential value and never consults an earlier qualification result.
 */
export function preflightCase(
	c: QualificationCase,
	config: QualificationConfig,
	ctx: PreflightContext
): PreflightResult {
	const reasons: AdmissionReason[] = [];
	const add = (id: string, detail: string) => reasons.push(preflightReason(id, detail));
	const offline = c.classes.includes('offline-inspection');
	const discovery = c.classes.includes('discovery');
	const paid = c.classes.includes('paid');
	const credentialed = discovery || paid;
	const result: PreflightResult = {
		schema: PREFLIGHT_SCHEMA,
		caseId: c.caseId,
		status: 'not-run',
		operations: {
			offlineProbes: offline ? Object.keys(OFFLINE_PROBES) : [],
			discovery: [],
			paidPrompts: paid,
		},
		binary: { state: 'unpinned', sha256Before: null, sha256After: null, readOnly: null },
		launches: [],
		reasons,
	};

	// Discovery operations are their own authorized set, separate from probes and prompts.
	for (const op of config.discovery.operations)
		if (!(op in DISCOVERY_OPERATIONS)) add('discovery-operation-unknown', op);
	if (discovery) {
		result.operations.discovery = config.discovery.operations.filter(
			(op) => DISCOVERY_OPERATIONS[op]?.route === c.route
		);
		if (!result.operations.discovery.length) add('discovery-operation-unauthorized', c.route);
	}

	// Only the Grok child is planned here; another provider's leg has no preflight of its own yet.
	for (const p of c.providers)
		if (p !== 'grok')
			reasons.push({
				id: 'cross-provider-preflight-unimplemented',
				kind: 'isolation-preflight',
				detail: p,
				owner: 'GT1-11-13',
			});

	const iso = config.isolation;
	if (!iso) {
		add('isolation-undeclared', 'isolation');
		return result;
	}
	const b = iso.boundary;
	if (!b) add('boundary-undeclared', 'isolation.boundary');
	else {
		if (!b.reference.trim()) add('boundary-reference-absent', 'isolation.boundary.reference');
		if (b.productionHomeMounted !== false)
			add(
				b.productionHomeMounted ? 'production-home-mounted' : 'production-home-unknown',
				'isolation.boundary.productionHomeMounted'
			);
		if (b.operatorCredentialsReadable !== false)
			add(
				b.operatorCredentialsReadable
					? 'operator-credentials-readable'
					: 'operator-credentials-unknown',
				'isolation.boundary.operatorCredentialsReadable'
			);
	}

	// Owned roots: local paths under the allowed roots (symlinks resolved), SSH under its remote root.
	const accounts: Array<'A' | 'B'> = c.family === 'E01' ? ['A', 'B'] : ['A'];
	if (c.target === 'local') {
		const roots = config.allowedRoots.map((r) => path.resolve(ctx.workspace, r));
		const owned = (label: string, p: string | undefined) => {
			if (!p) return add('owned-root-absent', label);
			const resolved = path.resolve(ctx.workspace, p);
			if (!underAny('local', resolved, roots)) return add('owned-root-outside-allowed', label);
			if (fs.existsSync(resolved)) {
				const real = fs.realpathSync(resolved);
				const realRoots = roots.filter((r) => fs.existsSync(r)).map((r) => fs.realpathSync(r));
				if (!underAny('local', real, realRoots)) add('owned-root-symlink-escape', label);
			}
			if (
				isPathAtOrUnderRoot(
					normalizeFor('local', ctx.operatorHome),
					normalizeFor('local', resolved)
				)
			)
				add('owned-root-contains-operator-home', label);
		};
		if (b) owned('isolation.boundary.actualHome', b.actualHome);
		for (const a of accounts) owned(`isolation.accountRoots.${a}`, iso.accountRoots[a]);
		const ra = iso.accountRoots.A;
		const rb = iso.accountRoots.B;
		if (
			accounts.length === 2 &&
			ra &&
			rb &&
			overlaps('local', path.resolve(ctx.workspace, ra), path.resolve(ctx.workspace, rb))
		)
			add('account-roots-overlap', 'isolation.accountRoots');
	} else {
		const targets = config.allowedSshTargets;
		if (!targets.length) add('remote-root-absent', 'allowedSshTargets');
		for (const target of targets) {
			const remote = iso.remoteRoots[target];
			if (!remote) {
				add('remote-root-absent', target);
				continue;
			}
			const root = path.posix.normalize(remote.root);
			if (!path.posix.isAbsolute(root) || root === '/' || remote.root.includes('~'))
				add('remote-root-invalid', target);
			if (!remote.binarySha256) add('remote-binary-undeclared', target);
			else if (remote.binarySha256 !== config.binary.sha256)
				add('remote-binary-hash-mismatch', target);
		}
	}

	// The immutable pinned binary.
	if (c.target === 'local' && config.binary.path) {
		const seen = inspectExecutable(path.resolve(ctx.workspace, config.binary.path));
		result.binary = {
			state: 'local',
			sha256Before: seen.sha256,
			sha256After: null,
			readOnly: seen.readOnly,
		};
		if (!seen.regular) add('binary-unreadable', 'binary.path');
		else {
			if (!seen.readOnly) add('binary-mutable', 'binary.path');
			if (seen.sha256 !== config.binary.sha256) add('binary-hash-mismatch', 'binary.sha256');
		}
	} else if (c.target === 'ssh' && config.binary.sha256) {
		result.binary = {
			state: 'remote-declared',
			sha256Before: config.binary.sha256,
			sha256After: null,
			readOnly: null,
		};
	}

	// Required policy, compatibility resources and hooks.
	if (!iso.policy.systemPolicyInspected) add('system-policy-uninspected', 'isolation.policy');
	if (iso.policy.managedPolicy === 'unknown') add('managed-policy-unknown', 'isolation.policy');
	if (iso.policy.requiredPolicyCompatible !== true)
		add(
			iso.policy.requiredPolicyCompatible === false
				? 'required-policy-incompatible'
				: 'required-policy-unknown',
			'isolation.policy'
		);
	for (const k of ['hooks', 'mcp', 'plugins'] as const)
		if (iso.resources[k] === 'unknown') add(`resource-unknown:${k}`, `isolation.resources.${k}`);
	if (iso.resources.envrc !== 'disabled') add('envrc-not-disabled', 'isolation.resources.envrc');

	// Egress: offline denies all; discovery/paid need verified suppression or an operation-aware boundary.
	const egress = iso.egress;
	if (egress.kind === 'none' || !egress.reference)
		add('egress-boundary-undeclared', 'isolation.egress');
	if (offline && !credentialed && egress.kind !== 'deny-all')
		add('offline-egress-not-denied', 'isolation.egress.kind');
	if (credentialed && egress.kind !== 'operation-aware') {
		for (const k of ['update', 'telemetry', 'backgroundUpload'] as const)
			if (egress.suppression[k] !== 'verified')
				add(`suppression-unverified:${k}`, `isolation.egress.suppression.${k}`);
		if (egress.kind === 'origin-allowlist' && egress.suppression.backgroundUpload !== 'verified')
			add('same-origin-upload-unguarded', 'isolation.egress');
	}
	if (
		!config.autoUpdateDisabled ||
		(c.target === 'local' && result.binary.readOnly !== true && config.binary.path)
	)
		add('update-not-immutable', 'autoUpdateDisabled/binary');

	// The final child environments: credential-free for probes, the selected account source for the rest.
	const modes: Array<'offline' | 'credentialed'> = [
		...(offline ? (['offline'] as const) : []),
		...(credentialed ? (['credentialed'] as const) : []),
	];
	for (const a of accounts)
		for (const mode of modes) {
			const plan = planIsolatedLaunch(c, config, a, mode, ctx.workspace, ctx.operatorHome);
			if (!plan) {
				add('launch-unplannable', `${a}/${mode}`);
				continue;
			}
			const report = validateLaunchEnvironment(plan.env, plan.expectation);
			reasons.push(...report.reasons);
			result.launches.push({
				account: a,
				mode,
				credentialMode: plan.credentialMode,
				keys: report.keys,
				denied: report.denied,
				missingControls: report.missingControls,
			});
			const cfgPath = plan.env.GROK_CONFIG_PATH;
			if (c.target === 'local' && cfgPath && fs.existsSync(cfgPath)) {
				const text = fs.readFileSync(cfgPath, 'utf8');
				if (/^\s*(api_key|env_key)\s*=/m.test(text))
					add('config-per-model-credential', `${a}/GROK_CONFIG_PATH`);
			}
		}

	result.status = reasons.length ? 'not-run' : 'pass';
	return result;
}

// ---------------------------------------------------------------------------
// Atomic shared spend admission (GT1-11-08C)
// ---------------------------------------------------------------------------

/**
 * DESIGN.md design ceilings. They are never authorized values: every effective
 * limit is the smaller of the ceiling and the explicit authorization.
 */
export const HARNESS_CEILINGS = {
	concurrentCases: 1,
	turnsPerCase: 2,
	caseSeconds: 120,
	discoverySeconds: 30,
	/** Wall-clock bound of one offline probe (GT1-11-10A). */
	offlineProbeSeconds: 15,
	idleSeconds: 30,
	cleanupSeconds: 5,
} as const;

export const RESERVATION_SCHEMA = 'grok-spend-reservation/v1';

/** Every kind of model call that can bill. A user turn is not the unit; a call is. */
export type BillableCallKind = 'model-round' | 'child' | 'retry' | 'side-model' | 'compaction';

const CALL_KINDS: Record<BillableCallKind, keyof SpendBounds['perTurnCalls']> = {
	'model-round': 'modelRounds',
	child: 'children',
	retry: 'retries',
	'side-model': 'sideModels',
	compaction: 'compaction',
};

export interface ReservationPlan {
	caseId: string;
	guarantee: 'worst-case-reservation' | 'provider-cap' | null;
	guaranteeReference: string | null;
	/** Effective per-case turns: min(authorization, design ceiling). */
	turns: number;
	/** Billable calls per user turn (rounds, children, retries, side models, compaction); null when undeclared. */
	callsPerTurn: number | null;
	/** Billable calls the case may make; null when the bounds are undeclared (only a covering cap admits that). */
	calls: number | null;
	models: Array<PricingProvenance & { perCallUsd: number | null }>;
	/** Conservative maximum charge; null means unknown, never zero. */
	worstCaseUsd: number | null;
	/** What the shared ledger holds for the case while it runs. */
	holdUsd: number;
	/** True only when every price and bound is known; a cap never makes a missing cost known. */
	costKnown: boolean;
	providerCap: { capUsd: number; providers: ProviderId[]; covers: boolean } | null;
	effectiveLimits: {
		budgetUsd: number;
		maxCalls: number;
		maxTurns: number;
		maxWallClockSeconds: number;
	};
	reasons: AdmissionReason[];
}

export interface SpendReservation {
	schema: typeof RESERVATION_SCHEMA;
	id: string;
	caseId: string;
	/** E11 translation leg; legs share the case and run ledgers and never reset them. */
	leg: string | null;
	provider: ProviderId;
	account: 'A' | 'B';
	endpoint: string;
	models: string[];
	target: Target;
	sshTarget: string | null;
	authorizationReference: string;
	authorizationExpiresAt: string;
	createdAt: string;
	/** min(authorization expiry, case deadline, run deadline). */
	deadlineAt: string;
	guarantee: 'worst-case-reservation' | 'provider-cap';
	guaranteeReference: string;
	costKnown: boolean;
	holdUsd: number;
	callAllowance: number;
	turnAllowance: number;
	state: 'held' | 'settled' | 'uncertain' | 'released';
	callsUsed: number;
	callsByKind: Record<BillableCallKind, number>;
	turnsUsed: number;
	settledUsd: number;
	/** Charges that may have happened; never refunded, never read as zero. */
	uncertainUsd: number;
	/** Settled above the hold (a reservation bound was wrong); kept, never hidden. */
	overrunUsd: number;
	/** Set once an effect's completion is uncertain; such an effect is never retried automatically. */
	uncertainEffect: boolean;
	pricing: PricingProvenance[];
	settlement: { reason: string; at: string } | null;
}

export interface ReservationRequest {
	caseId: string;
	leg?: string | null;
	provider: ProviderId;
	account: 'A' | 'B';
	endpoint: string;
	models: string[];
	target: Target;
	sshTarget?: string | null;
	plan: ReservationPlan;
}

export type ReservationResult =
	| { ok: true; reservation: SpendReservation }
	| { ok: false; reasons: AdmissionReason[] };

const ledgerKeys = new Set<string>();

const roundUsd = (n: number) => Math.ceil(n * 1e6) / 1e6;
const spendReason = (id: string, detail: string, owner?: string): AdmissionReason => ({
	id,
	kind: 'spend-admission',
	detail,
	...(owner ? { owner } : {}),
});

function effectiveLimits(config: QualificationConfig) {
	const pc = config.limits.perCase;
	const pick = (n: number, ceiling = Infinity) => (positiveFinite(n) ? Math.min(n, ceiling) : 0);
	return {
		budgetUsd: pick(pc.budgetUsd),
		maxCalls: pick(pc.maxCalls),
		maxTurns: Math.floor(pick(pc.maxTurns, HARNESS_CEILINGS.turnsPerCase)),
		maxWallClockSeconds: pick(pc.maxWallClockSeconds, HARNESS_CEILINGS.caseSeconds),
	};
}

function capProviders(config: QualificationConfig): ProviderId[] {
	const g = config.spendGuarantee;
	return g?.kind === 'provider-cap' ? (g.providers?.length ? [...g.providers] : ['grok']) : [];
}

/**
 * The worst-case charge of one case, from the declared bounds and the
 * canonical price table. Unknown prices or bounds leave the cost unknown; only
 * a provider-enforced cap covering every provider of the case, no larger than
 * the run budget, admits that, and the hold is then the whole case budget.
 */
export function planCaseReservation(
	c: QualificationCase,
	config: QualificationConfig
): ReservationPlan {
	const reasons: AdmissionReason[] = [];
	const limits = effectiveLimits(config);
	const g = config.spendGuarantee;
	const bounds = config.spendBounds ?? null;
	let callsPerTurn: number | null = null;
	// Missing bounds leave the cost unknown: only a covering provider cap admits
	// that, and the ledger then holds the per-case call limit as the allowance.
	if (!bounds) {
		if (g?.kind !== 'provider-cap')
			reasons.push(spendReason('spend-bounds-undeclared', 'spendBounds'));
	} else {
		const counts = Object.values(bounds.perTurnCalls);
		const tokens = Object.values(bounds.perCall);
		const bad =
			counts.some((n) => !Number.isInteger(n) || n < 0) ||
			bounds.perTurnCalls.modelRounds < 1 ||
			tokens.some((n) => typeof n !== 'number' || !Number.isFinite(n) || n < 0) ||
			!positiveFinite(bounds.perCall.inputTokens) ||
			!positiveFinite(bounds.perCall.outputTokens);
		if (bad) reasons.push(spendReason('spend-bounds-invalid', 'spendBounds'));
		else callsPerTurn = counts.reduce((a, b) => a + b, 0);
	}
	const turns = limits.maxTurns;
	const calls = callsPerTurn === null ? null : callsPerTurn * turns;
	if (calls !== null) {
		if (calls > limits.maxCalls)
			reasons.push(spendReason('call-allowance-exceeds-case-limit', `${calls} > perCase.maxCalls`));
		if (calls > (positiveFinite(config.limits.maxCalls) ? config.limits.maxCalls : 0))
			reasons.push(spendReason('call-allowance-exceeds-run-limit', `${calls} > maxCalls`));
	}
	const modelIds = [...new Set([...config.allowedModels, ...(bounds?.sideModels ?? [])])];
	const models = modelIds.map((model) => {
		const p = pricingProvenance(model);
		const perCallUsd =
			p.source !== 'unknown' && bounds && callsPerTurn !== null
				? calculateModelCost(bounds.perCall, model)
				: null;
		return { ...p, perCallUsd };
	});
	const known = models.length > 0 && models.every((m) => m.perCallUsd !== null) && calls !== null;
	const worstCaseUsd = known
		? roundUsd(calls! * Math.max(...models.map((m) => m.perCallUsd as number)))
		: null;

	let providerCap: ReservationPlan['providerCap'] = null;
	let holdUsd = 0;
	if (g?.kind === 'worst-case-reservation') {
		for (const m of models)
			if (m.source === 'unknown' && !config.allowedModels.includes(m.model))
				reasons.push({ id: 'price-unknown', kind: 'pricing', detail: m.model });
		if (worstCaseUsd === null)
			reasons.push(spendReason('worst-case-unknown', 'prices or bounds unknown; no provider cap'));
		else {
			if (worstCaseUsd > limits.budgetUsd)
				reasons.push(spendReason('worst-case-exceeds-case-budget', `${worstCaseUsd}`));
			if (worstCaseUsd > config.limits.budgetUsd)
				reasons.push(spendReason('worst-case-exceeds-run-budget', `${worstCaseUsd}`));
			holdUsd = worstCaseUsd;
		}
	} else if (g?.kind === 'provider-cap') {
		const providers = capProviders(config);
		const uncovered = c.providers.filter((p) => !providers.includes(p));
		for (const p of uncovered) reasons.push(spendReason('provider-cap-does-not-cover', p));
		if (positiveFinite(g.capUsd) && g.capUsd > config.limits.budgetUsd)
			reasons.push(spendReason('provider-cap-exceeds-run-budget', `${g.capUsd}`));
		providerCap = {
			capUsd: g.capUsd,
			providers,
			covers: uncovered.length === 0 && g.capUsd <= config.limits.budgetUsd,
		};
		holdUsd = worstCaseUsd !== null ? Math.min(worstCaseUsd, limits.budgetUsd) : limits.budgetUsd;
	}
	return {
		caseId: c.caseId,
		guarantee: g?.kind ?? null,
		guaranteeReference: g?.reference ?? null,
		turns,
		callsPerTurn,
		calls,
		models,
		worstCaseUsd,
		holdUsd,
		costKnown: worstCaseUsd !== null,
		providerCap,
		effectiveLimits: limits,
		reasons,
	};
}

/**
 * One ledger per run, shared by every case, leg and provider. There is no reset:
 * a second ledger for the same run id throws, so a translation leg or a
 * repeated roundtrip can never start from a fresh budget.
 */
export function createBudgetLedger(
	config: QualificationConfig,
	runId: string,
	startedAt: Date = new Date()
): BudgetLedger {
	const key = `ledger:${runId}`;
	if (ledgerKeys.has(key)) throw new Error(`A budget ledger already exists for run ${runId}`);
	ledgerKeys.add(key);
	const byProvider: BudgetLedger['byProvider'] = {};
	for (const p of config.providers)
		byProvider[p] = { reservedUsd: 0, settledUsd: 0, uncertainUsd: 0 };
	const runSeconds = positiveFinite(config.limits.maxWallClockSeconds)
		? config.limits.maxWallClockSeconds
		: 0;
	return {
		key,
		limitUsd: positiveFinite(config.limits.budgetUsd) ? config.limits.budgetUsd : 0,
		limitCalls: positiveFinite(config.limits.maxCalls) ? config.limits.maxCalls : 0,
		limitTurns: positiveFinite(config.limits.maxTurns) ? config.limits.maxTurns : 0,
		deadlineAt: new Date(startedAt.getTime() + runSeconds * 1000).toISOString(),
		reservedUsd: 0,
		settledUsd: 0,
		uncertainUsd: 0,
		calls: 0,
		turns: 0,
		byProvider,
		authorizedCaseIds: [],
		reservations: [],
	};
}

const committedUsd = (r: SpendReservation) =>
	(r.state === 'held' ? r.holdUsd : 0) + r.settledUsd + r.uncertainUsd;
const committedCalls = (r: SpendReservation) =>
	r.state === 'held' ? Math.max(r.callAllowance, r.callsUsed) : r.callsUsed;
const committedTurns = (r: SpendReservation) =>
	r.state === 'held' ? Math.max(r.turnAllowance, r.turnsUsed) : r.turnsUsed;

/**
 * Check and hold in one synchronous step, so concurrent cases (and every leg
 * of a cross-provider case) see each other's holds. The reservation is bound
 * to the exact provider, account, endpoint, models, target, case and
 * authorization; anything outside the authorization is refused, never widened.
 */
export function reserveSpend(
	ledger: BudgetLedger,
	config: QualificationConfig,
	request: ReservationRequest,
	now: Date
): ReservationResult {
	const reasons: AdmissionReason[] = [];
	const add = (id: string, detail: string) => reasons.push(spendReason(id, detail));
	const { plan } = request;
	const t = now.getTime();
	if (plan.caseId !== request.caseId) add('plan-case-mismatch', request.caseId);
	if (plan.reasons.length) add('plan-not-admissible', plan.reasons.map((r) => r.id).join(','));
	if (!ledger.authorizedCaseIds.includes(request.caseId)) add('case-not-admitted', request.caseId);
	if (!plan.guarantee || !plan.guaranteeReference) add('spend-guarantee-absent', 'spendGuarantee');
	const auth = config.authorizationReference;
	const expiry = config.expiresAt ? Date.parse(config.expiresAt) : NaN;
	if (!auth) add('live-authorization-absent', 'authorizationReference');
	else if (!Number.isFinite(expiry) || expiry <= t) add('live-authorization-expired', 'expiresAt');
	if (!config.providers.includes(request.provider))
		add('provider-not-authorized', request.provider);
	if (
		!config.credentialReferences.some(
			(r) => r.provider === request.provider && r.account === request.account
		)
	)
		add('credential-reference-absent', `${request.provider}/${request.account}`);
	try {
		assertEndpointApproved(request.endpoint, config);
	} catch {
		add('endpoint-not-approved', request.endpoint);
	}
	const priced = new Set(plan.models.map((m) => m.model));
	if (!request.models.length) add('models-unselected', 'models');
	for (const m of request.models)
		if (!config.allowedModels.includes(m) && !(config.spendBounds?.sideModels ?? []).includes(m))
			add('model-not-authorized', m);
		else if (!priced.has(m)) add('model-not-in-plan', m);
	if (request.target === 'ssh') {
		if (!request.sshTarget || !config.allowedSshTargets.includes(request.sshTarget))
			add('ssh-target-unapproved', request.sshTarget ?? 'none');
	}
	if (plan.guarantee === 'provider-cap' && !plan.providerCap?.providers.includes(request.provider))
		add('provider-cap-does-not-cover', request.provider);
	const runDeadline = Date.parse(ledger.deadlineAt);
	if (!(runDeadline > t)) add('run-deadline-passed', ledger.deadlineAt);

	// Concurrency: a case with a live hold occupies a slot; legs of one case share it.
	const activeCases = new Set(
		ledger.reservations
			.filter((r) => r.state === 'held' && r.caseId !== request.caseId)
			.map((r) => r.caseId)
	);
	if (activeCases.size >= HARNESS_CEILINGS.concurrentCases)
		add('concurrency-limit', `${activeCases.size} active`);

	const holdUsd = plan.holdUsd;
	const callAllowance = plan.calls ?? plan.effectiveLimits.maxCalls;
	const turnAllowance = plan.turns;
	if (!positiveFinite(holdUsd)) add('reservation-hold-not-positive', `${holdUsd}`);
	const runUsd = ledger.reservations.reduce((s, r) => s + committedUsd(r), 0);
	const runCalls = ledger.reservations.reduce((s, r) => s + committedCalls(r), 0);
	const runTurns = ledger.reservations.reduce((s, r) => s + committedTurns(r), 0);
	if (runUsd + holdUsd > ledger.limitUsd) add('run-budget-exhausted', `${runUsd} + ${holdUsd}`);
	if (runCalls + callAllowance > ledger.limitCalls) add('run-calls-exhausted', `${runCalls}`);
	if (runTurns + turnAllowance > ledger.limitTurns) add('run-turns-exhausted', `${runTurns}`);
	const mine = ledger.reservations.filter((r) => r.caseId === request.caseId);
	const caseUsd = mine.reduce((s, r) => s + committedUsd(r), 0);
	const caseCalls = mine.reduce((s, r) => s + committedCalls(r), 0);
	// DESIGN.md E11: each translation leg is its own subcase under the turn ceiling;
	// spend, calls and the deadline stay shared by every leg of the case.
	const caseTurns = mine
		.filter((r) => r.leg === (request.leg ?? null))
		.reduce((s, r) => s + committedTurns(r), 0);
	const lim = plan.effectiveLimits;
	if (caseUsd + holdUsd > lim.budgetUsd) add('case-budget-exhausted', `${caseUsd} + ${holdUsd}`);
	if (caseCalls + callAllowance > lim.maxCalls) add('case-calls-exhausted', `${caseCalls}`);
	if (caseTurns + turnAllowance > lim.maxTurns) add('case-turns-exhausted', `${caseTurns}`);
	if (reasons.length) return { ok: false, reasons };

	// The case deadline starts at its first hold; later legs inherit it.
	const caseStart = mine.length ? Math.min(...mine.map((r) => Date.parse(r.createdAt))) : t;
	const deadline = Math.min(expiry, runDeadline, caseStart + lim.maxWallClockSeconds * 1000);
	if (!(deadline > t)) return { ok: false, reasons: [spendReason('case-deadline-passed', '')] };
	const reservation: SpendReservation = {
		schema: RESERVATION_SCHEMA,
		id: `res:${randomUUID()}`,
		caseId: request.caseId,
		leg: request.leg ?? null,
		provider: request.provider,
		account: request.account,
		endpoint: new URL(request.endpoint).origin,
		models: [...request.models],
		target: request.target,
		sshTarget: request.sshTarget ?? null,
		authorizationReference: auth!,
		authorizationExpiresAt: new Date(expiry).toISOString(),
		createdAt: now.toISOString(),
		deadlineAt: new Date(deadline).toISOString(),
		guarantee: plan.guarantee!,
		guaranteeReference: plan.guaranteeReference!,
		costKnown: plan.costKnown,
		holdUsd,
		callAllowance,
		turnAllowance,
		state: 'held',
		callsUsed: 0,
		callsByKind: { 'model-round': 0, child: 0, retry: 0, 'side-model': 0, compaction: 0 },
		turnsUsed: 0,
		settledUsd: 0,
		uncertainUsd: 0,
		overrunUsd: 0,
		uncertainEffect: false,
		pricing: plan.models
			.filter((m) => request.models.includes(m.model))
			.map(({ perCallUsd: _perCall, ...p }) => p),
		settlement: null,
	};
	ledger.reservations.push(reservation);
	ledger.reservedUsd = roundUsd(ledger.reservedUsd + holdUsd);
	const bp = (ledger.byProvider[request.provider] ??= {
		reservedUsd: 0,
		settledUsd: 0,
		uncertainUsd: 0,
	});
	bp.reservedUsd = roundUsd(bp.reservedUsd + holdUsd);
	return { ok: true, reservation };
}

function heldReservation(ledger: BudgetLedger, id: string, now: Date): SpendReservation {
	const r = ledger.reservations.find((x) => x.id === id);
	if (!r) throw new Error(`Unknown reservation ${id}`);
	if (r.state !== 'held') throw new Error(`Reservation ${id} is ${r.state}`);
	if (Date.parse(r.deadlineAt) <= now.getTime())
		throw new Error(`Reservation ${id} passed its deadline`);
	return r;
}

/**
 * Count one billable call before it is dispatched. Every model round, child,
 * retry, side model and compaction draws from the same allowance; a retry
 * after an uncertain effect is refused, never automatic.
 */
export function recordBillableCall(
	ledger: BudgetLedger,
	reservationId: string,
	call: { kind: BillableCallKind; model: string },
	now: Date
): void {
	if (!Object.prototype.hasOwnProperty.call(CALL_KINDS, call.kind))
		throw new Error(`Unknown call kind ${call.kind}`);
	const r = heldReservation(ledger, reservationId, now);
	if (call.kind === 'retry' && r.uncertainEffect)
		throw new Error('An uncertain effect is never retried automatically');
	if (!r.models.includes(call.model))
		throw new Error(`Model ${call.model} is not bound to this reservation`);
	if (r.callsUsed >= r.callAllowance) throw new Error('Call allowance exhausted');
	if (ledger.calls >= ledger.limitCalls) throw new Error('Run call limit exhausted');
	r.callsUsed++;
	r.callsByKind[call.kind]++;
	ledger.calls++;
}

/** Count one user turn before it is sent. */
export function recordUserTurn(ledger: BudgetLedger, reservationId: string, now: Date): void {
	const r = heldReservation(ledger, reservationId, now);
	if (r.turnsUsed >= r.turnAllowance) throw new Error('Turn allowance exhausted');
	if (ledger.turns >= ledger.limitTurns) throw new Error('Run turn limit exhausted');
	r.turnsUsed++;
	ledger.turns++;
}

/** Mark that an effect was dispatched and its completion is now uncertain (disconnect, timeout). */
export function markUncertainEffect(ledger: BudgetLedger, reservationId: string): void {
	const r = ledger.reservations.find((x) => x.id === reservationId);
	if (!r) throw new Error(`Unknown reservation ${reservationId}`);
	r.uncertainEffect = true;
}

export type SettlementOutcome =
	| { kind: 'settled'; actualUsd: number | null; reason: string }
	| { kind: 'uncertain'; partialUsd?: number; reason: string };

/**
 * Close a reservation. A known actual replaces the hold; an unknown actual
 * (a provider cap with no price, a timeout, a disconnect) keeps the whole
 * hold as uncertain, minus any part that is known. Nothing uncertain is ever
 * refunded or read as zero; a charge above the hold is kept as an overrun.
 */
export function settleReservation(
	ledger: BudgetLedger,
	reservationId: string,
	outcome: SettlementOutcome,
	now: Date
): SpendReservation {
	const r = ledger.reservations.find((x) => x.id === reservationId);
	if (!r) throw new Error(`Unknown reservation ${reservationId}`);
	if (r.state !== 'held') throw new Error(`Reservation ${reservationId} is ${r.state}`);
	const known =
		outcome.kind === 'settled'
			? outcome.actualUsd
			: typeof outcome.partialUsd === 'number'
				? outcome.partialUsd
				: null;
	if (known !== null && (!Number.isFinite(known) || known < 0))
		throw new Error('A settled charge must be a finite non-negative number');
	const exact = outcome.kind === 'settled' && known !== null && !r.uncertainEffect;
	const settled = known ?? 0;
	const uncertain = exact ? 0 : Math.max(0, r.holdUsd - settled);
	r.settledUsd = roundUsd(settled);
	r.uncertainUsd = roundUsd(uncertain);
	r.overrunUsd = roundUsd(Math.max(0, settled - r.holdUsd));
	r.state = exact ? 'settled' : 'uncertain';
	if (!exact)
		r.uncertainEffect = r.uncertainEffect || outcome.kind === 'uncertain' || r.callsUsed > 0;
	r.settlement = { reason: outcome.reason, at: now.toISOString() };
	const bp = ledger.byProvider[r.provider];
	ledger.reservedUsd = roundUsd(ledger.reservedUsd - r.holdUsd);
	ledger.settledUsd = roundUsd(ledger.settledUsd + r.settledUsd);
	ledger.uncertainUsd = roundUsd(ledger.uncertainUsd + r.uncertainUsd);
	bp.reservedUsd = roundUsd(bp.reservedUsd - r.holdUsd);
	bp.settledUsd = roundUsd(bp.settledUsd + r.settledUsd);
	bp.uncertainUsd = roundUsd(bp.uncertainUsd + r.uncertainUsd);
	return r;
}

/** Return a hold that never dispatched anything. Once a call was counted it must be settled. */
export function releaseReservation(
	ledger: BudgetLedger,
	reservationId: string,
	now: Date
): SpendReservation {
	const r = ledger.reservations.find((x) => x.id === reservationId);
	if (!r) throw new Error(`Unknown reservation ${reservationId}`);
	if (r.state !== 'held') throw new Error(`Reservation ${reservationId} is ${r.state}`);
	if (r.callsUsed > 0 || r.turnsUsed > 0 || r.uncertainEffect)
		throw new Error('A reservation that dispatched work must be settled, not released');
	r.state = 'released';
	r.settlement = { reason: 'released-before-dispatch', at: now.toISOString() };
	ledger.reservedUsd = roundUsd(ledger.reservedUsd - r.holdUsd);
	ledger.byProvider[r.provider].reservedUsd = roundUsd(
		ledger.byProvider[r.provider].reservedUsd - r.holdUsd
	);
	return r;
}

/** No playbook task owns an SSH paid executor yet; a later IMPLEMENT takes this owner over. */
export const SSH_PAID_EXECUTOR_OWNER = 'unassigned-ssh-paid-executor';

/**
 * The legs of a case no bound executor covers, each with its owner. The paid
 * executor covers local Grok-only paid legs over either route; nothing else.
 */
export function paidExecutorGaps(
	c: QualificationCase,
	capabilities: HarnessCapabilities
): Array<{ detail: string; owner: string }> {
	const gaps: Array<{ detail: string; owner: string }> = [];
	if (c.classes.includes('discovery')) {
		if (!capabilities.discoveryExecutor)
			gaps.push({
				detail: 'no discovery executor is bound to an admitted tuple',
				owner: 'GT1-11-11A1',
			});
		else if (c.target !== 'local')
			gaps.push({
				detail: 'the discovery executor launches local legs only',
				owner: 'GT1-11-11A3',
			});
	}
	if (c.classes.includes('paid')) {
		if (!capabilities.caseExecutor)
			gaps.push({ detail: 'no paid executor is bound to an admitted tuple', owner: 'GT1-11-11P1' });
		else {
			if (c.target !== 'local')
				gaps.push({
					detail: 'the paid executor launches local legs only',
					owner: SSH_PAID_EXECUTOR_OWNER,
				});
			if (c.providers.some((p) => p !== 'grok'))
				gaps.push({ detail: 'the paid executor runs Grok legs only', owner: 'GT1-11-13' });
		}
	}
	return gaps;
}

/** Decide one case. Every applicable missing input is listed; nothing short-circuits. */
export function admitCase(
	c: QualificationCase,
	config: QualificationConfig,
	problems: ConfigProblem[],
	capabilities: HarnessCapabilities,
	now: Date
): AdmissionReason[] {
	const reasons: AdmissionReason[] = [];
	const add = (r: AdmissionReason) => reasons.push(r);
	const needsBinary = c.classes.some((k) => k !== 'deterministic');
	const needsNetwork = c.classes.includes('discovery') || c.classes.includes('paid');
	const paid = c.classes.includes('paid');

	for (const p of problems)
		add({ id: `config:${p.code}`, kind: 'config-problem', detail: p.field });

	if (!config.authorizationReference)
		add({
			id: 'live-authorization-absent',
			kind: 'admission-input',
			detail: 'authorizationReference',
		});
	else if (!config.expiresAt || Date.parse(config.expiresAt) <= now.getTime())
		add({ id: 'live-authorization-expired', kind: 'admission-input', detail: 'expiresAt' });

	for (const provider of c.providers) {
		if (!config.providers.includes(provider))
			add({
				id: provider === 'grok' ? 'provider-not-authorized' : 'cross-provider-authorization-absent',
				kind: 'admission-input',
				detail: provider,
			});
		const accounts: Array<'A' | 'B'> =
			c.family === 'E01' && provider === 'grok' ? ['A', 'B'] : ['A'];
		for (const account of accounts) {
			if (
				!config.credentialReferences.some((r) => r.provider === provider && r.account === account)
			)
				add({
					id: 'credential-reference-absent',
					kind: 'admission-input',
					detail: `${provider}/${account}`,
				});
		}
	}

	if (needsBinary) {
		const b = config.binary;
		if (!b.path || !b.sha256 || !b.version)
			add({ id: 'binary-unpinned', kind: 'admission-input', detail: 'binary.path/sha256/version' });
		if (!config.autoUpdateDisabled)
			add({
				id: 'auto-update-not-disabled',
				kind: 'admission-input',
				detail: 'autoUpdateDisabled',
			});
		if (!config.allowedRoots.length)
			add({ id: 'allowed-roots-absent', kind: 'admission-input', detail: 'allowedRoots' });
		if (!config.isolationReceipt)
			add({
				id: 'host-isolation-unqualified',
				kind: 'admission-input',
				detail: 'isolationReceipt',
			});
		if (!capabilities.isolationPreflight)
			add({
				id: 'isolation-preflight-unimplemented',
				kind: 'harness-capability',
				detail: 'pre-spawn isolation and discovery preflight',
				owner: 'GT1-11-08B',
			});
	}
	if (needsNetwork && !config.allowedEndpoints.length)
		add({ id: 'endpoints-unapproved', kind: 'admission-input', detail: 'allowedEndpoints' });
	if (c.target === 'ssh' && !config.allowedSshTargets.length)
		add({ id: 'ssh-target-unapproved', kind: 'admission-input', detail: 'allowedSshTargets' });
	if (c.classes.includes('discovery')) {
		if (!config.discovery.authorizationReference || !config.discovery.operations.length)
			add({
				id: 'discovery-authorization-absent',
				kind: 'admission-input',
				detail: 'discovery.authorizationReference/operations',
			});
	}
	if (paid) {
		if (!config.allowedModels.length)
			add({ id: 'models-unselected', kind: 'admission-input', detail: 'allowedModels' });
		const l = config.limits;
		const limits: Array<[string, number]> = [
			['budgetUsd', l.budgetUsd],
			['maxCalls', l.maxCalls],
			['maxTurns', l.maxTurns],
			['maxWallClockSeconds', l.maxWallClockSeconds],
			['perCase.budgetUsd', l.perCase.budgetUsd],
			['perCase.maxCalls', l.perCase.maxCalls],
			['perCase.maxTurns', l.perCase.maxTurns],
			['perCase.maxWallClockSeconds', l.perCase.maxWallClockSeconds],
		];
		for (const [field, value] of limits)
			if (!positiveFinite(value))
				add({ id: 'live-limits-unset', kind: 'admission-input', detail: `limits.${field}` });
		if (!config.spendGuarantee)
			add({ id: 'spend-guarantee-absent', kind: 'admission-input', detail: 'spendGuarantee' });
		if (config.spendGuarantee?.kind !== 'provider-cap') {
			for (const model of config.allowedModels)
				if (pricingProvenance(model).source === 'unknown')
					add({ id: 'price-unknown', kind: 'pricing', detail: model });
		}
		if (capabilities.atomicSpendAdmission) reasons.push(...planCaseReservation(c, config).reasons);
		else
			add({
				id: 'spend-admission-unimplemented',
				kind: 'harness-capability',
				detail: 'atomic shared reservation or provider-cap admission',
				owner: 'GT1-11-08C',
			});
	}
	// The offline-inspection leg has its own executor (runOfflineLeg). The discovery
	// (GT1-11-11A1) and paid (GT1-11-11P1) executors cover local Grok-only legs; an
	// SSH leg has no executor yet, and a cross-provider leg is GT1-11-13's.
	const gaps = paidExecutorGaps(c, capabilities);
	if (gaps.length)
		add({
			id: 'case-executor-unimplemented',
			kind: 'harness-capability',
			detail: gaps.map((g) => g.detail).join('; '),
			owner: gaps.map((g) => g.owner).join('/'),
		});
	return reasons;
}

// ---------------------------------------------------------------------------
// Offline-inspection leg (GT1-11-10A)
// ---------------------------------------------------------------------------

/** Bytes of each probe stream the executor accepts; more is an unbounded probe and fails. */
export const OFFLINE_OUTPUT_CAP_BYTES = 1024 * 1024;
/** Leading bytes of stdout kept in memory to parse the version; never written anywhere. */
const OFFLINE_PARSE_BYTES = 64 * 1024;

const offlineReason = (id: string, detail: string): AdmissionReason => ({
	id,
	kind: 'offline-execution',
	detail,
	owner: 'GT1-11-10A',
});

/** The offline-inspection leg of a case as a case of its own: same identity, offline class only. */
export function offlineLegCase(c: QualificationCase): QualificationCase {
	return { ...c, classes: ['offline-inspection'] };
}

/**
 * Admission of the offline leg alone. It needs the pinned binary, disabled
 * auto-update, owned roots and the isolation receipt (the preflight then holds
 * the declaration, deny-all egress and a credential-free launch), but no
 * credential reference, endpoint, discovery authorization, model or spend
 * input: it makes no network contact and reads no credential.
 */
export function admitOfflineLeg(
	c: QualificationCase,
	config: QualificationConfig,
	problems: ConfigProblem[],
	capabilities: HarnessCapabilities
): AdmissionReason[] {
	const reasons: AdmissionReason[] = [];
	const add = (r: AdmissionReason) => reasons.push(r);
	if (!c.classes.includes('offline-inspection'))
		add({ id: 'offline-leg-absent', kind: 'admission-input', detail: c.caseId });
	for (const p of problems)
		add({ id: `config:${p.code}`, kind: 'config-problem', detail: p.field });
	if (!config.providers.includes('grok'))
		add({ id: 'provider-not-authorized', kind: 'admission-input', detail: 'grok' });
	const b = config.binary;
	if (!b.path || !b.sha256 || !b.version)
		add({ id: 'binary-unpinned', kind: 'admission-input', detail: 'binary.path/sha256/version' });
	if (!config.autoUpdateDisabled)
		add({ id: 'auto-update-not-disabled', kind: 'admission-input', detail: 'autoUpdateDisabled' });
	if (!config.allowedRoots.length)
		add({ id: 'allowed-roots-absent', kind: 'admission-input', detail: 'allowedRoots' });
	if (!config.isolationReceipt)
		add({ id: 'host-isolation-unqualified', kind: 'admission-input', detail: 'isolationReceipt' });
	if (c.target !== 'local')
		add({
			id: 'offline-executor-local-only',
			kind: 'harness-capability',
			detail: 'the offline executor launches local binaries only',
			owner: 'GT1-11-11A',
		});
	if (!capabilities.isolationPreflight)
		add({
			id: 'isolation-preflight-unimplemented',
			kind: 'harness-capability',
			detail: 'pre-spawn isolation and discovery preflight',
			owner: 'GT1-11-08B',
		});
	if (!capabilities.offlineExecutor)
		add({
			id: 'offline-executor-unimplemented',
			kind: 'harness-capability',
			detail: 'no offline-inspection executor',
			owner: 'GT1-11-10A',
		});
	return reasons;
}

/** The first semver-shaped token of a `--version` output, without a leading `v`. */
export function parseProbeVersion(text: string): string | null {
	const m = /(?:^|[^0-9A-Za-z.])v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)/.exec(
		text
	);
	return m ? m[1] : null;
}

const normalizeVersion = (v: string) => v.trim().replace(/^v/, '');

/** Hash every byte of a stream, keep a bounded head, and report when the cap is crossed. */
function streamDigest() {
	const hash = createHash('sha256');
	const head: Buffer[] = [];
	let headBytes = 0;
	let bytes = 0;
	return {
		push(chunk: Buffer): boolean {
			bytes += chunk.length;
			hash.update(chunk);
			if (headBytes < OFFLINE_PARSE_BYTES) {
				const take = chunk.subarray(0, OFFLINE_PARSE_BYTES - headBytes);
				head.push(take);
				headBytes += take.length;
			}
			return bytes > OFFLINE_OUTPUT_CAP_BYTES;
		},
		head: () => Buffer.concat(head).toString('utf8'),
		result: () => ({
			sha256: hash.digest('hex'),
			bytes,
			truncated: bytes > OFFLINE_OUTPUT_CAP_BYTES,
		}),
	};
}

type CaseLifetime = ReturnType<typeof createCaseLifetime>;

/** Run one offline probe as an owned child with a wall-clock bound; never throws. */
function runOfflineProbe(
	probe: string,
	file: string,
	argv: readonly string[],
	env: Record<string, string>,
	cwd: string,
	timeoutMs: number,
	graceMs: number,
	lifetime: CaseLifetime,
	/** Every stdout chunk, in order, for a caller that parses the stream (the paid native turn). */
	onStdout?: (chunk: Buffer) => void
): Promise<{ result: OfflineProbeResult; stdoutHead: string; stderrHead: string }> {
	return new Promise((resolve) => {
		const started = Date.now();
		const out = streamDigest();
		const err = streamDigest();
		let timedOut = false;
		let spawnError: string | null = null;
		let settled = false;
		let timer: NodeJS.Timeout | undefined;
		const finish = (exitCode: number | null, signal: string | null) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			resolve({
				result: {
					probe,
					argv: [...argv],
					exitCode,
					signal,
					durationMs: Date.now() - started,
					timedOut,
					spawnError,
					stdout: out.result(),
					stderr: err.result(),
				},
				stdoutHead: out.head(),
				stderrHead: err.head(),
			});
		};
		let child: ChildProcess;
		try {
			// Absolute pinned file, no shell, only the planned environment (never process.env).
			child = spawn(file, [...argv], {
				cwd,
				env,
				shell: false,
				stdio: ['ignore', 'pipe', 'pipe'],
				windowsHide: true,
			});
		} catch (e) {
			spawnError = (e as NodeJS.ErrnoException).code ?? 'spawn-threw';
			finish(null, null);
			return;
		}
		lifetime.own(child);
		const stop = () => stopProcess({ child }, { from: 'terminate', graceMs });
		timer = setTimeout(() => {
			timedOut = true;
			stop();
		}, timeoutMs);
		child.stdout?.on('data', (d: Buffer) => {
			onStdout?.(d);
			if (out.push(d)) stop();
		});
		child.stderr?.on('data', (d: Buffer) => {
			if (err.push(d)) stop();
		});
		child.on('error', (e: NodeJS.ErrnoException) => {
			spawnError = e.code ?? 'spawn-error';
			if (child.pid === undefined) finish(null, null);
		});
		child.on('close', (code, signal) => finish(code, signal));
	});
}

export interface OfflineExecutionContext {
	workspace: string;
	operatorHome: string;
	/** Per-probe wall-clock bound, already clamped to the ceiling. */
	timeoutMs: number;
	lifetime: CaseLifetime;
}

/**
 * The bounded offline executor. Re-checks what it relies on (pin, local
 * target, disabled update, a credential-free validated launch), re-hashes the
 * binary and refuses before any spawn on a mismatch, then runs only the
 * `OFFLINE_PROBES` argv, one owned child at a time. Callers hand it only an
 * admitted leg; a refusal here still never spawns.
 */
export async function executeOfflineLeg(
	c: QualificationCase,
	config: QualificationConfig,
	ctx: OfflineExecutionContext
): Promise<{
	reasons: AdmissionReason[];
	probes: OfflineProbeResult[];
	binary: OfflineLegReceipt['binary'];
	spawned: number;
}> {
	const reasons: AdmissionReason[] = [];
	const probes: OfflineProbeResult[] = [];
	const binary: OfflineLegReceipt['binary'] = {
		sha256Pinned: config.binary.sha256,
		sha256AtSpawn: null,
		sha256After: null,
		versionPinned: config.binary.version,
		versionObserved: null,
	};
	const refuse = (id: string, detail: string) => {
		reasons.push(offlineReason(id, detail));
		return { reasons, probes, binary, spawned: 0 };
	};
	if (!config.binary.path || !config.binary.sha256 || !config.binary.version)
		return refuse('binary-unpinned', 'binary.path/sha256/version');
	if (c.target !== 'local') return refuse('offline-executor-local-only', c.target);
	if (!config.autoUpdateDisabled) return refuse('auto-update-not-disabled', 'autoUpdateDisabled');

	const file = path.resolve(ctx.workspace, config.binary.path);
	const atSpawn = inspectExecutable(file);
	binary.sha256AtSpawn = atSpawn.sha256;
	if (!atSpawn.regular) return refuse('binary-unreadable', 'binary.path');
	if (atSpawn.sha256 !== config.binary.sha256)
		return refuse('binary-hash-mismatch-at-spawn', 'binary.sha256');
	if (!atSpawn.readOnly) return refuse('binary-mutable', 'binary.path');

	const plan = planIsolatedLaunch(
		offlineLegCase(c),
		config,
		'A',
		'offline',
		ctx.workspace,
		ctx.operatorHome
	);
	if (!plan || plan.credentialMode !== 'none') return refuse('offline-launch-unplannable', 'A');
	const report = validateLaunchEnvironment(plan.env, plan.expectation);
	if (report.reasons.length) {
		reasons.push(...report.reasons);
		return { reasons, probes, binary, spawned: 0 };
	}
	const cwd = plan.expectation.home;
	if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory())
		return refuse('offline-home-absent', 'isolation.boundary.actualHome');
	fs.mkdirSync(plan.env.TMPDIR, { recursive: true, mode: 0o700 });

	const real = fs.realpathSync(file);
	const graceMs = Math.max(1, Math.min(config.limits.cleanupSeconds, 5)) * 1000;
	let spawned = 0;
	let versionHead: string | null = null;
	for (const [name, argv] of Object.entries(OFFLINE_PROBES)) {
		const { result, stdoutHead } = await runOfflineProbe(
			name,
			real,
			argv,
			plan.env,
			cwd,
			ctx.timeoutMs,
			graceMs,
			ctx.lifetime
		);
		spawned++;
		probes.push(result);
		if (name === 'version') versionHead = stdoutHead;
		if (result.spawnError) reasons.push(offlineReason('probe-spawn-failed', name));
		else if (result.timedOut) reasons.push(offlineReason('probe-timeout', name));
		else if (result.stdout.truncated || result.stderr.truncated)
			reasons.push(offlineReason('probe-output-unbounded', name));
		else if (result.exitCode !== 0) reasons.push(offlineReason('probe-exit-nonzero', name));
		// The binary must stay byte-identical across every probe.
		binary.sha256After = inspectExecutable(file).sha256;
		if (binary.sha256After !== config.binary.sha256) {
			reasons.push(offlineReason('binary-changed-during-probe', name));
			break;
		}
		if (reasons.length) break;
	}
	if (versionHead !== null) {
		binary.versionObserved = parseProbeVersion(versionHead);
		if (!reasons.length) {
			if (!binary.versionObserved)
				reasons.push(offlineReason('binary-version-unparsed', 'version'));
			else if (binary.versionObserved !== normalizeVersion(config.binary.version))
				reasons.push(offlineReason('binary-version-mismatch', 'binary.version'));
		}
	}
	return { reasons, probes, binary, spawned };
}

/** Admit, preflight and (only when nothing refuses) execute the offline leg of one case. */
export async function runOfflineLeg(
	c: QualificationCase,
	config: QualificationConfig,
	problems: ConfigProblem[],
	capabilities: HarnessCapabilities,
	ctx: { workspace: string; operatorHome: string; timeoutMs: number }
): Promise<OfflineLegReceipt> {
	const leg = offlineLegCase(c);
	const reasons = admitOfflineLeg(c, config, problems, capabilities);
	const preflight = capabilities.isolationPreflight
		? preflightCase(leg, config, { workspace: ctx.workspace, operatorHome: ctx.operatorHome })
		: null;
	if (preflight) reasons.push(...preflight.reasons);
	const receipt: OfflineLegReceipt = {
		leg: 'offline-inspection',
		status: 'not-run',
		reasons,
		preflight,
		binary: {
			sha256Pinned: config.binary.sha256,
			sha256AtSpawn: null,
			sha256After: null,
			versionPinned: config.binary.version,
			versionObserved: null,
		},
		probes: [],
		spawned: 0,
		networkContacts: 0,
		cleanup: { ownedProcesses: 0, stopped: 0 },
	};
	if (reasons.length) return receipt;
	const lifetime = createCaseLifetime(config.limits.cleanupSeconds);
	try {
		const run = await executeOfflineLeg(leg, config, { ...ctx, lifetime });
		receipt.reasons = run.reasons;
		receipt.probes = run.probes;
		receipt.binary = run.binary;
		receipt.spawned = run.spawned;
		receipt.status = run.spawned === 0 ? 'not-run' : run.reasons.length ? 'failed' : 'passed';
	} finally {
		receipt.cleanup = await lifetime.cleanup();
	}
	if (preflight) preflight.binary.sha256After = receipt.binary.sha256After;
	return receipt;
}

// ---------------------------------------------------------------------------
// Binary-resolution leg (GT1-11-11A2)
// ---------------------------------------------------------------------------

export type BinaryResolutionSource = 'pinned-path' | 'custom-path' | 'owned-path';

export interface BinaryResolution {
	source: BinaryResolutionSource;
	/** What was asked for: the configured path, or the owned PATH entries walked in order. */
	requested: string | string[];
	/** What the production custom-path rule (`checkCustomPath`) returned; null when nothing resolved. */
	resolved: string | null;
	realPath: string | null;
	sha256: string | null;
	outcome: 'passed' | 'failed';
	/** `matches-pin`, or why it does not (never a fallback to another install). */
	detail: string;
}

export interface BinaryResolutionLegReceipt {
	leg: 'binary-resolution';
	/** not-run: refused before resolving; failed: a source did not resolve to the pin; passed: all three did. */
	status: 'not-run' | 'passed' | 'failed';
	reasons: AdmissionReason[];
	pinned: { path: string | null; realPath: string | null; sha256: string | null };
	resolutions: BinaryResolution[];
	/** Always 0: the leg reads files only and never runs any binary. */
	spawned: 0;
	networkContacts: 0;
}

const resolutionReason = (id: string, detail: string): AdmissionReason => ({
	id,
	kind: 'offline-execution',
	detail,
	owner: 'GT1-11-11A2',
});

/** The executable name the production definition launches (`grok`). */
function grokBinaryName(): string {
	return getAgentDefinition('grok')?.binaryName ?? 'grok';
}

/**
 * Resolve the pinned binary three ways through the production custom-path
 * rule (`checkCustomPath`, what the detector applies to a configured path):
 * the pinned path, the configured owned custom path, and a walk of the
 * boundary's PATH in order (the first entry holding the binary wins, as a
 * PATH lookup would). Each must resolve to the pin's own file (same real path,
 * same sha256) inside the owned roots. A source that resolves nothing fails;
 * there is no fallback to a known install location, `which`, or a login shell,
 * and nothing is ever run.
 */
export async function runBinaryResolutionLeg(
	c: QualificationCase,
	config: QualificationConfig,
	problems: ConfigProblem[],
	capabilities: HarnessCapabilities,
	ctx: { workspace: string; operatorHome: string }
): Promise<BinaryResolutionLegReceipt> {
	const leg = offlineLegCase(c);
	const reasons = admitOfflineLeg(c, config, problems, capabilities);
	if (capabilities.isolationPreflight)
		reasons.push(
			...preflightCase(leg, config, { workspace: ctx.workspace, operatorHome: ctx.operatorHome })
				.reasons
		);
	const customPath = config.binaryResolution?.customPath ?? null;
	if (!customPath)
		reasons.push(resolutionReason('binary-resolution-undeclared', 'binaryResolution.customPath'));
	const roots = config.allowedRoots.map((r) => path.resolve(ctx.workspace, r));
	const pathEntries = (config.isolation?.path ?? []).map((p) => path.resolve(ctx.workspace, p));
	if (!pathEntries.some((p) => underAny('local', p, roots)))
		reasons.push(resolutionReason('owned-path-absent', 'isolation.path'));
	const pinnedFile = config.binary.path ? path.resolve(ctx.workspace, config.binary.path) : null;
	const pin = pinnedFile ? inspectExecutable(pinnedFile) : null;
	let pinnedReal: string | null = null;
	try {
		pinnedReal = pinnedFile ? fs.realpathSync(pinnedFile) : null;
	} catch {
		pinnedReal = null;
	}
	const receipt: BinaryResolutionLegReceipt = {
		leg: 'binary-resolution',
		status: 'not-run',
		reasons,
		pinned: { path: pinnedFile, realPath: pinnedReal, sha256: pin?.sha256 ?? null },
		resolutions: [],
		spawned: 0,
		networkContacts: 0,
	};
	if (reasons.length) return receipt;
	if (!pinnedReal || pin?.sha256 !== config.binary.sha256) {
		receipt.reasons.push(resolutionReason('binary-hash-mismatch', 'binary.sha256'));
		receipt.status = 'failed';
		return receipt;
	}
	const realRoots = roots.filter((r) => fs.existsSync(r)).map((r) => fs.realpathSync(r));
	const judge = (
		source: BinaryResolutionSource,
		requested: string | string[],
		resolved: string | null
	): BinaryResolution => {
		const out: BinaryResolution = {
			source,
			requested,
			resolved,
			realPath: null,
			sha256: null,
			outcome: 'failed',
			detail: 'binary-unresolved',
		};
		if (!resolved) return out;
		try {
			out.realPath = fs.realpathSync(resolved);
		} catch {
			return out;
		}
		out.sha256 = inspectExecutable(resolved).sha256;
		if (!underAny('local', out.realPath, realRoots)) out.detail = 'binary-resolution-fallback';
		else if (normalizeFor('local', out.realPath) !== normalizeFor('local', pinnedReal))
			out.detail = 'binary-resolution-other-file';
		else if (out.sha256 !== config.binary.sha256) out.detail = 'binary-resolution-hash-mismatch';
		else {
			out.outcome = 'passed';
			out.detail = 'matches-pin';
		}
		return out;
	};
	const viaRule = async (p: string) => {
		const found = await checkCustomPath(p);
		return found.exists ? (found.path ?? p) : null;
	};
	receipt.resolutions.push(judge('pinned-path', pinnedFile!, await viaRule(pinnedFile!)));
	const custom = path.resolve(ctx.workspace, customPath!);
	receipt.resolutions.push(judge('custom-path', custom, await viaRule(custom)));
	let fromPath: string | null = null;
	for (const entry of pathEntries) {
		fromPath = await viaRule(path.join(entry, grokBinaryName()));
		if (fromPath) break;
	}
	receipt.resolutions.push(judge('owned-path', pathEntries, fromPath));
	for (const r of receipt.resolutions)
		if (r.outcome === 'failed') receipt.reasons.push(resolutionReason(r.detail, r.source));
	receipt.status = receipt.reasons.length ? 'failed' : 'passed';
	return receipt;
}

// ---------------------------------------------------------------------------
// Discovery executor (GT1-11-11A1)
// ---------------------------------------------------------------------------

/**
 * The native model listing: the only argv the native discovery leg may run.
 * The pinned source names it (`grok models`, the Grok invalid-model error and
 * the capability note); there is no prompt and no model preselection.
 */
export const NATIVE_MODEL_CATALOG_ARGV: readonly string[] = Object.freeze(['models']);

/**
 * What each discovery operation needs to have run first on the same child. A
 * run that authorizes an operation without its prerequisite is refused before
 * spawn; the executor never widens the authorized set.
 */
export const DISCOVERY_OPERATION_REQUIRES: Readonly<Record<string, string | null>> = Object.freeze({
	'acp-initialize': null,
	'acp-session-new': 'acp-initialize',
	'acp-model-catalog': 'acp-session-new',
	'native-model-catalog': null,
});

/** The ACP spec's reserved `auth_required` error code; its meaning is protocol-defined, not inferred. */
const ACP_AUTH_REQUIRED_CODE = -32000;
/**
 * Within the canonical `auth_expired` type, the evidence that says no usable
 * credential was presented at all (as opposed to one that was rejected). It
 * only splits a line the canonical patterns already classified as auth.
 */
const MISSING_CREDENTIAL_EVIDENCE =
	/\bmissing\b|not authenticated|not logged in|authentication required|auth(?:entication)? required|set XAI_API_KEY|grok\s+login/i;
/** Reported catalog bytes kept verbatim in the receipt; beyond this only the digest is kept. */
const DISCOVERY_RAW_BYTES = 64 * 1024;

const discoveryReason = (id: string, detail: string, owner = 'GT1-11-11A1'): AdmissionReason => ({
	id,
	kind: 'discovery-execution',
	detail,
	owner,
});

export interface DiscoveryExecutionContext extends Omit<
	PaidExecutionContext,
	'turnTimeoutMs' | 'precondition'
> {
	/** Whole-leg bound; clamped to `HARNESS_CEILINGS.discoverySeconds`. */
	timeoutMs?: number;
}

/** A catalog record from a reported payload, keeping protocol fields verbatim and nothing inferred. */
function discoveryCatalog(
	operation: string,
	payload: unknown,
	format: 'json' | 'text',
	fields: Pick<DiscoveryCatalog, 'models' | 'currentModel' | 'modelMenu' | 'effortMenu'>
): DiscoveryCatalog {
	const text = format === 'json' ? canonicalJson(payload) : String(payload);
	const bytes = Buffer.byteLength(text, 'utf8');
	const truncated = bytes > DISCOVERY_RAW_BYTES;
	return {
		operation,
		...fields,
		raw: truncated
			? null
			: format === 'json'
				? payload
				: text.split(/\r?\n/).filter((l) => l.trim()),
		format,
		sha256: createHash('sha256').update(text).digest('hex'),
		bytes,
		truncated,
	};
}

/**
 * Classify a discovery leg's credential outcome through the canonical Grok
 * error patterns (`matchErrorPattern`, which drops structured JSON lines) and
 * `classifyCredentialKind` over the PLANNED env (secret references, never a
 * value). An auth or policy hit wins over any other match; a leg that ran a
 * credentialed operation cleanly is `ok`; one that never exercised the
 * credential is `not-observed`.
 */
export function classifyDiscoveryAuth(args: {
	evidence: string[];
	plannedEnv: Record<string, string>;
	account: 'A' | 'B';
	target: Target;
	failed: boolean;
	credentialExercised: boolean;
}): DiscoveryAuthOutcome {
	const credential = classifyCredentialKind('grok', args.plannedEnv);
	const patterns = getErrorPatterns('grok');
	let hit: ReturnType<typeof matchErrorPattern> = null;
	let hitLine = '';
	for (const line of args.evidence.flatMap((e) => e.split(/\r?\n/))) {
		const m = matchErrorPattern(patterns, line);
		if (!m) continue;
		if (m.type === 'auth_expired' || m.type === 'permission_denied') {
			hit = m;
			hitLine = line;
			break;
		}
		if (!hit) {
			hit = m;
			hitLine = line;
		}
	}
	const status: DiscoveryAuthStatus =
		hit?.type === 'auth_expired'
			? MISSING_CREDENTIAL_EVIDENCE.test(hitLine)
				? 'missing'
				: 'expired'
			: hit?.type === 'permission_denied'
				? 'restricted'
				: args.failed
					? 'unclassified-failure'
					: args.credentialExercised
						? 'ok'
						: 'not-observed';
	let guidance: string | null = null;
	if (status === 'missing' || status === 'expired' || status === 'restricted') {
		const blocked = credentialKindBlocksLogin(credential, 'Grok CLI');
		const login = getAgentLoginCommand('grok', undefined, { remote: args.target === 'ssh' });
		guidance =
			blocked ??
			`Re-authenticate Grok account ${args.account} out of band${
				login ? ` with \`${formatAgentLoginCommand(login)}\`` : ''
			} under that account's own GROK_HOME, then start a new run; the harness never logs in, retries or switches accounts.`;
		if (status === 'restricted')
			guidance = `${hit?.message ?? 'Grok denied the request.'} Ask the account or model policy owner to grant account ${args.account} the discovery operations, or select another approved account in a new run.`;
	}
	return {
		status,
		errorType: hit?.type ?? null,
		message: hit?.message ?? null,
		credentialKind: credential.kind,
		credentialEnvVar: credential.envVarName ?? null,
		guidance,
	};
}

/**
 * The authorized operations of one case route, in dependency order, or the
 * refusals that stop the leg before spawn.
 */
export function plannedDiscoveryOperations(
	c: QualificationCase,
	config: QualificationConfig
): { operations: string[]; reasons: AdmissionReason[] } {
	const reasons: AdmissionReason[] = [];
	const authorized = new Set(config.discovery.operations);
	const operations = Object.keys(DISCOVERY_OPERATIONS).filter(
		(op) => authorized.has(op) && DISCOVERY_OPERATIONS[op].route === c.route
	);
	for (const op of config.discovery.operations)
		if (!(op in DISCOVERY_OPERATIONS))
			reasons.push(discoveryReason('discovery-operation-unknown', op));
	if (!operations.length)
		reasons.push(discoveryReason('discovery-operation-unauthorized', c.route));
	for (const op of operations) {
		const needs = DISCOVERY_OPERATION_REQUIRES[op];
		if (needs && !authorized.has(needs))
			reasons.push(
				discoveryReason('discovery-operation-prerequisite-unauthorized', `${op} needs ${needs}`)
			);
	}
	return { operations, reasons };
}

/** A not-run discovery leg naming the account, target and credential reference it would use. */
function discoveryLegShell(
	c: QualificationCase,
	config: QualificationConfig,
	account: 'A' | 'B'
): DiscoveryLegReceipt {
	const ref = config.credentialReferences.find(
		(r) => r.provider === 'grok' && r.account === account
	);
	return {
		leg: 'discovery',
		account,
		route: c.route,
		target: c.target,
		host: c.target === 'local' ? 'local' : (config.allowedSshTargets[0] ?? ''),
		credential: ref
			? { kind: ref.kind, reference: ref.kind === 'secret-name' ? ref.name : ref.path }
			: null,
		status: 'not-run',
		reasons: [],
		operations: [],
		catalogs: [],
		initialization: null,
		auth: null,
		binary: { sha256Pinned: config.binary.sha256, sha256AtSpawn: null, sha256After: null },
		launch: null,
		spawns: [],
		spawned: 0,
		networkContacts: 0,
		paidRequests: 0,
	};
}

/**
 * One discovery leg (one account) of an admitted case. Nothing spawns until
 * the binary re-hashes to the pin and the credentialed launch validates; the
 * leg makes no prompt, no retry and no login, and contacts nothing but the
 * child it owns.
 */
async function executeDiscoveryLeg(
	c: QualificationCase,
	config: QualificationConfig,
	ctx: DiscoveryExecutionContext,
	account: 'A' | 'B',
	operations: string[]
): Promise<DiscoveryLegReceipt> {
	const receipt = discoveryLegShell(c, config, account);
	const refuse = (id: string, detail: string) => {
		receipt.reasons.push(discoveryReason(id, detail));
		return receipt;
	};
	if (c.target !== 'local') return refuse('discovery-executor-local-only', c.target);

	// The planned isolated launch with the selected account's credential reference only.
	const launch = planIsolatedLaunch(
		c,
		config,
		account,
		'credentialed',
		ctx.workspace,
		ctx.operatorHome
	);
	if (!launch || launch.credentialMode === 'none')
		return refuse('discovery-launch-unplannable', account);
	const credential = resolveLaunchCredential(launch, config, account, ctx.resolveSecret);
	if ('refused' in credential) return refuse(credential.refused, credential.detail);
	const env = credential.env;
	const report = validateLaunchEnvironment(env, launch.expectation);
	if (report.reasons.length) {
		receipt.reasons.push(...report.reasons);
		return receipt;
	}
	receipt.launch = { credentialMode: launch.credentialMode, keys: report.keys };
	const cwd = launch.expectation.home;
	if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory())
		return refuse('discovery-home-absent', 'isolation.boundary.actualHome');

	// The immutable pinned binary, re-hashed immediately before the spawn.
	const file = path.resolve(ctx.workspace, config.binary.path ?? '');
	const atSpawn = inspectExecutable(file);
	receipt.binary.sha256AtSpawn = atSpawn.sha256;
	if (!config.binary.path || !atSpawn.regular) return refuse('binary-unreadable', 'binary.path');
	if (atSpawn.sha256 !== config.binary.sha256)
		return refuse('binary-hash-mismatch-at-spawn', 'binary.sha256');
	if (!atSpawn.readOnly) return refuse('binary-mutable', 'binary.path');
	fs.mkdirSync(env.TMPDIR, { recursive: true, mode: 0o700 });

	const real = fs.realpathSync(file);
	const graceMs = Math.max(1, Math.min(config.limits.cleanupSeconds, 5)) * 1000;
	const ceilingMs = HARNESS_CEILINGS.discoverySeconds * 1000;
	const legMs = positiveFinite(ctx.timeoutMs) ? Math.min(ctx.timeoutMs, ceilingMs) : ceilingMs;
	const evidence: string[] = [];
	let credentialExercised = false;

	if (c.route === 'native-headless') {
		const started = Date.now();
		const { result, stdoutHead, stderrHead } = await runOfflineProbe(
			'native-model-catalog',
			real,
			NATIVE_MODEL_CATALOG_ARGV,
			env,
			cwd,
			legMs,
			graceMs,
			ctx.lifetime
		);
		receipt.spawned++;
		receipt.spawns.push(result);
		const ran = !(result.spawnError !== null && NEVER_RAN_SPAWN_ERRORS.has(result.spawnError));
		// A child that ran may have reached the endpoint for the listing.
		if (ran) receipt.networkContacts++;
		evidence.push(stderrHead, stdoutHead);
		let failure: string | null = null;
		if (!ran) failure = 'discovery-spawn-failed';
		else if (result.timedOut) failure = 'discovery-timeout';
		else if (result.spawnError) failure = 'discovery-spawn-error-after-start';
		else if (result.stdout.truncated || result.stderr.truncated)
			failure = 'discovery-output-unbounded';
		else if (result.exitCode !== 0) failure = 'discovery-exit-nonzero';
		if (failure) receipt.reasons.push(discoveryReason(failure, 'native-model-catalog'));
		else {
			credentialExercised = true;
			let parsed: unknown = undefined;
			try {
				parsed = JSON.parse(stdoutHead);
			} catch {
				parsed = undefined;
			}
			receipt.catalogs.push(
				parsed === undefined
					? discoveryCatalog('native-model-catalog', stdoutHead, 'text', {
							models: null,
							currentModel: null,
							modelMenu: null,
							effortMenu: null,
						})
					: discoveryCatalog('native-model-catalog', parsed, 'json', {
							models: null,
							currentModel: null,
							modelMenu: null,
							effortMenu: null,
						})
			);
		}
		receipt.operations.push({
			operation: 'native-model-catalog',
			outcome: failure ? 'failed' : 'passed',
			detail: failure ?? `exit ${result.exitCode}`,
			durationMs: Date.now() - started,
		});
	} else {
		const run = await runAcpDiscovery({
			file: real,
			env,
			cwd,
			operations,
			graceMs,
			legMs,
			lifetime: ctx.lifetime,
		});
		receipt.spawned += run.spawned;
		receipt.networkContacts += run.networkContacts;
		receipt.spawns.push(...run.spawns);
		receipt.operations.push(...run.operations);
		receipt.catalogs.push(...run.catalogs);
		receipt.initialization = run.initialization;
		receipt.reasons.push(...run.reasons);
		evidence.push(...run.evidence);
		credentialExercised = run.credentialExercised;
	}

	receipt.binary.sha256After = inspectExecutable(file).sha256;
	if (receipt.binary.sha256After !== config.binary.sha256)
		receipt.reasons.push(discoveryReason('binary-changed-during-leg', 'binary.path'));
	receipt.auth = classifyDiscoveryAuth({
		evidence,
		plannedEnv: launch.env,
		account,
		target: c.target,
		failed: receipt.reasons.length > 0,
		credentialExercised,
	});
	const a = receipt.auth;
	if (a.status === 'missing' || a.status === 'expired' || a.status === 'restricted')
		receipt.reasons.push(discoveryReason(`discovery-auth-${a.status}`, a.guidance ?? ''));
	receipt.status = receipt.spawned === 0 ? 'not-run' : receipt.reasons.length ? 'failed' : 'passed';
	return receipt;
}

/**
 * The ACP route of a discovery leg: one owned `agent stdio` child, then only
 * the authorized operations in dependency order: initialize, session/new with
 * no prompt and no model preselection, and the model/effort menus session/new
 * reported. Every request is counted as a network contact before it is
 * written; `session/prompt` is never sent. The leg deadline stops the child.
 */
async function runAcpDiscovery(args: {
	file: string;
	env: Record<string, string>;
	cwd: string;
	operations: string[];
	graceMs: number;
	legMs: number;
	lifetime: CaseLifetime;
}): Promise<{
	spawns: OfflineProbeResult[];
	operations: DiscoveryOperationResult[];
	catalogs: DiscoveryCatalog[];
	initialization: unknown;
	reasons: AdmissionReason[];
	evidence: string[];
	spawned: number;
	networkContacts: number;
	credentialExercised: boolean;
}> {
	const operations: DiscoveryOperationResult[] = [];
	const catalogs: DiscoveryCatalog[] = [];
	const reasons: AdmissionReason[] = [];
	const evidence: string[] = [];
	let networkContacts = 0;
	let credentialExercised = false;
	let initialization: unknown = null;
	const started = Date.now();
	const out = streamDigest();
	const err = streamDigest();
	let child: ChildProcess;
	try {
		child = spawn(args.file, [...GROK_ACP_ARGS], {
			cwd: args.cwd,
			env: args.env,
			shell: false,
			stdio: ['pipe', 'pipe', 'pipe'],
			windowsHide: true,
		});
	} catch (e) {
		reasons.push(
			discoveryReason('discovery-spawn-failed', (e as NodeJS.ErrnoException).code ?? 'spawn-threw')
		);
		return {
			spawns: [],
			operations,
			catalogs,
			initialization,
			reasons,
			evidence,
			spawned: 0,
			networkContacts,
			credentialExercised,
		};
	}
	args.lifetime.own(child);
	let spawnError: string | null = null;
	let unbounded = false;
	let timedOut = false;
	let exit: { code: number | null; signal: string | null } = { code: null, signal: null };
	const exited = new Promise<void>((resolve) =>
		child.on('close', (code, signal) => {
			exit = { code, signal };
			resolve();
		})
	);
	const stop = () => stopProcess({ child }, { from: 'terminate', graceMs: args.graceMs });
	const remaining = () => Math.max(1, args.legMs - (Date.now() - started));
	const client = new GrokAcpClient({
		write: (frame) => {
			child.stdin?.write(frame);
		},
		requestTimeoutMs: remaining(),
	});
	const deadline = setTimeout(() => {
		timedOut = true;
		client.close('timeout');
		stop();
	}, args.legMs);
	deadline.unref();
	child.stdout?.on('data', (d: Buffer) => {
		if (out.push(d)) {
			unbounded = true;
			client.close('frame-too-large');
			stop();
		}
		client.feedStdout(d);
	});
	child.stderr?.on('data', (d: Buffer) => {
		if (err.push(d)) {
			unbounded = true;
			stop();
		}
		client.feedStderr(d);
	});
	child.stdin?.on('error', () => client.close('write'));
	child.on('error', (e: NodeJS.ErrnoException) => {
		spawnError = e.code ?? 'spawn-error';
		client.close('closed');
	});
	child.on('close', () => client.close('closed'));

	const failureOf = (e: unknown): string => {
		if (e instanceof GrokAcpRequestError) {
			// The ACP spec reserves -32000 for auth_required: protocol meaning, not inference.
			if (e.code === ACP_AUTH_REQUIRED_CODE) evidence.push('Grok authentication required');
			return `request-error:${e.code}`;
		}
		if (e instanceof GrokAcpTransportError) return `transport:${e.reason}`;
		return spawnError ?? 'request-error';
	};
	let opened: Record<string, unknown> | null = null;
	for (const op of args.operations) {
		const t0 = Date.now();
		let failure: string | null = null;
		try {
			if (op === 'acp-initialize') {
				networkContacts++;
				initialization = await client.initialize();
			} else if (op === 'acp-session-new') {
				networkContacts++;
				const answer = (await client.request(
					'session/new',
					{ cwd: args.cwd, mcpServers: [] },
					{ timeoutMs: remaining() }
				)) as Record<string, unknown> | null;
				opened = answer && typeof answer === 'object' ? answer : null;
				const id = opened?.sessionId;
				if (typeof id !== 'string' || !id.trim()) failure = 'session-id-missing';
				else credentialExercised = true;
			} else if (op === 'acp-model-catalog') {
				// The menus session/new reported: no further request, so no further contact.
				if (!opened) failure = 'session-absent';
				else {
					const options = Array.isArray(opened.configOptions) ? opened.configOptions : null;
					const menu = (id: string) =>
						options?.find(
							(o) => o && typeof o === 'object' && (o as Record<string, unknown>).id === id
						) ?? null;
					const models = (opened.models ?? null) as Record<string, unknown> | null;
					catalogs.push(
						discoveryCatalog(
							op,
							{ models: opened.models ?? null, configOptions: opened.configOptions ?? null },
							'json',
							{
								models: models?.availableModels ?? null,
								currentModel: models?.currentModelId ?? null,
								modelMenu: menu('model'),
								effortMenu: menu('reasoning_effort'),
							}
						)
					);
					if (models?.availableModels === undefined && !menu('model'))
						failure = 'model-catalog-unreported';
				}
			}
		} catch (e) {
			failure = failureOf(e);
		}
		operations.push({
			operation: op,
			outcome: failure ? 'failed' : 'passed',
			detail: failure ?? 'ok',
			durationMs: Date.now() - t0,
		});
		if (failure) {
			reasons.push(
				discoveryReason(
					timedOut || failure === 'transport:timeout'
						? 'discovery-timeout'
						: unbounded
							? 'discovery-output-unbounded'
							: 'discovery-operation-failed',
					`${op}: ${failure}`
				)
			);
			break;
		}
	}
	for (const op of args.operations.slice(operations.length))
		operations.push({
			operation: op,
			outcome: 'not-run',
			detail: 'an earlier operation failed',
			durationMs: 0,
		});
	clearTimeout(deadline);
	client.close('closed');
	stop();
	await Promise.race([exited, delay(args.graceMs + 1000)]);
	evidence.push(err.head());
	return {
		spawns: [
			{
				probe: 'acp-discovery',
				argv: [...GROK_ACP_ARGS],
				exitCode: exit.code,
				signal: exit.signal,
				durationMs: Date.now() - started,
				timedOut,
				spawnError,
				stdout: out.result(),
				stderr: err.result(),
			},
		],
		operations,
		catalogs,
		initialization,
		reasons,
		evidence,
		spawned: 1,
		networkContacts,
		credentialExercised,
	};
}

/**
 * Execute the discovery legs of one admitted case (one per account).
 * Admission and preflight are re-checked here, so a caller that skipped them
 * still cannot spawn; a refusal returns not-run legs with zero spawns.
 */
export async function executeDiscoveryCase(
	c: QualificationCase,
	config: QualificationConfig,
	ctx: DiscoveryExecutionContext
): Promise<DiscoveryLegReceipt[]> {
	const accounts: Array<'A' | 'B'> = c.family === 'E01' ? ['A', 'B'] : ['A'];
	const reasons = admitCase(c, config, ctx.problems, ctx.capabilities, ctx.now());
	reasons.push(
		...preflightCase(c, config, { workspace: ctx.workspace, operatorHome: ctx.operatorHome })
			.reasons
	);
	if (!c.classes.includes('discovery'))
		reasons.push(discoveryReason('discovery-leg-absent', c.caseId));
	if (!ctx.capabilities.discoveryExecutor)
		reasons.push(discoveryReason('discovery-executor-unimplemented', c.caseId));
	if (!ctx.ledger.authorizedCaseIds.includes(c.caseId))
		reasons.push(discoveryReason('case-not-admitted', c.caseId));
	const planned = plannedDiscoveryOperations(c, config);
	reasons.push(...planned.reasons);
	const legs: DiscoveryLegReceipt[] = [];
	for (const account of accounts) {
		if (reasons.length) {
			const refused = discoveryLegShell(c, config, account);
			refused.reasons.push(...reasons);
			legs.push(refused);
			continue;
		}
		legs.push(await executeDiscoveryLeg(c, config, ctx, account, planned.operations));
	}
	return legs;
}

// ---------------------------------------------------------------------------
// Paid-case executor (GT1-11-11P1)
// ---------------------------------------------------------------------------

/** Reply bytes of one turn kept in memory for the token check; never written anywhere. */
const PAID_REPLY_BYTES = 64 * 1024;
/** Spawn failures that prove the child never ran, so nothing reached the provider. */
const NEVER_RAN_SPAWN_ERRORS = new Set(['ENOENT', 'EACCES', 'ENOEXEC', 'EPERM', 'spawn-threw']);

const paidReason = (id: string, detail: string, owner = 'GT1-11-11P1'): AdmissionReason => ({
	id,
	kind: 'paid-execution',
	detail,
	owner,
});

/** How a turn's charge was observed: only `exact` settles; everything else stays uncertain. */
export type PaidCostStatus = 'exact' | 'partial' | 'unknown' | 'absent';

export interface PaidTurnResult {
	turn: number;
	/** argv with the prompt replaced by its fixture reference; the prompt is covered by the fixture digest. */
	argv: string[];
	exitCode: number | null;
	signal: string | null;
	durationMs: number;
	timedOut: boolean;
	/** A spawn or transport failure (`transport:<reason>` on ACP); null when the turn ran to its end. */
	spawnError: string | null;
	stdout: { sha256: string; bytes: number; truncated: boolean };
	stderr: { sha256: string; bytes: number; truncated: boolean };
	sessionId: string | null;
	terminal: 'success' | 'failure' | 'none';
	/** The reply is kept as a digest; only whether the expected token appeared is recorded. */
	reply: { sha256: string; bytes: number; tokenSeen: boolean };
	/** The model the turn reported (native usage) or the session acknowledged (ACP). */
	model: string | null;
	/**
	 * The reasoning effort the peer acknowledged: the ACP `reasoning_effort`
	 * option after the selection, or a `reasoning_effort` / `reasoningEffort`
	 * string the native terminal record itself carried. Null when unreported;
	 * never the selected value copied over.
	 */
	effort: string | null;
	usage: { costUsd: number | null; status: PaidCostStatus };
	/** Billable calls drawn from the reservation before the turn was sent. */
	callsRecorded: Record<BillableCallKind, number>;
}

export interface PaidAssertionOutcome {
	id: string;
	outcome: 'passed' | 'failed' | 'not-evaluated';
	detail: string;
	owner?: string;
}

export interface PaidLegReceipt {
	/** `account-A` / `account-B` for a two-account case, else `main`. */
	leg: string;
	account: 'A' | 'B';
	route: Route;
	/** not-run: refused before spawn; failed: a turn, assertion or check failed; passed: every evaluated assertion passed. */
	status: 'not-run' | 'passed' | 'failed';
	reasons: AdmissionReason[];
	reservationId: string | null;
	fixture: { schema: string; family: string; sha256: string } | null;
	binary: { sha256Pinned: string | null; sha256AtSpawn: string | null; sha256After: string | null };
	/** Names only (never values) of the validated child environment. */
	launch: { credentialMode: CredentialMode; keys: string[] } | null;
	/** The owned account home (`GROK_HOME`) the child received; null when refused before planning. */
	accountRoot: string | null;
	/** The credential reference the child was launched with (a name or path, never a value). */
	credential: { kind: CredentialReference['kind']; reference: string } | null;
	/** Gateway variables the child received, by name, as origins only. */
	gateways: Record<string, string>;
	turns: PaidTurnResult[];
	assertions: PaidAssertionOutcome[];
	settlement: {
		state: SpendReservation['state'];
		settledUsd: number;
		uncertainUsd: number;
		reason: string;
	} | null;
	spawned: number;
	/** Turns handed to a running child; each is at least one provider request. */
	paidRequests: number;
}

export interface PaidExecutionContext {
	workspace: string;
	operatorHome: string;
	ledger: BudgetLedger;
	lifetime: CaseLifetime;
	problems: ConfigProblem[];
	capabilities: HarnessCapabilities;
	now: () => Date;
	/** Per-turn bound; clamped to the case ceiling and the reservation deadline. */
	turnTimeoutMs?: number;
	/** Resolve a secret-name credential reference at spawn; defaults to `lookupSecret`. */
	resolveSecret?: (name: string) => string | null;
	/** Refusals an earlier leg of the same case raised (an E07 discovery leg that did not pass). */
	precondition?: AdmissionReason[];
}

/** sha256 of the canonical fixture entry a leg runs. */
export function paidFixtureDigest(fixture: PaidFixture): string {
	return createHash('sha256').update(canonicalJson(fixture)).digest('hex');
}

const emptyCalls = (): Record<BillableCallKind, number> => ({
	'model-round': 0,
	child: 0,
	retry: 0,
	'side-model': 0,
	compaction: 0,
});

/**
 * The billable calls one user turn may make, by kind: the declared per-turn
 * bounds, or (a covering cap with no bounds) an even share of the call
 * allowance as model rounds. All of them are drawn before the turn is sent,
 * so a child can never make a call the ledger did not count.
 */
export function paidCallsPerTurn(
	config: QualificationConfig,
	reservation: Pick<SpendReservation, 'callAllowance' | 'turnAllowance'>
): Record<BillableCallKind, number> {
	const calls = emptyCalls();
	const bounds = config.spendBounds?.perTurnCalls;
	if (bounds)
		for (const kind of Object.keys(CALL_KINDS) as BillableCallKind[])
			calls[kind] = bounds[CALL_KINDS[kind]];
	else
		calls['model-round'] = Math.max(
			1,
			Math.floor(reservation.callAllowance / Math.max(1, reservation.turnAllowance))
		);
	return calls;
}

/** Bounded reply text plus a digest of all of it; the text never leaves memory. */
function replyCollector(expect: string) {
	const hash = createHash('sha256');
	let bytes = 0;
	let kept = '';
	return {
		push(text: string) {
			const b = Buffer.from(text, 'utf8');
			hash.update(b);
			bytes += b.length;
			if (kept.length < PAID_REPLY_BYTES) kept += text.slice(0, PAID_REPLY_BYTES - kept.length);
		},
		result: () => ({ sha256: hash.digest('hex'), bytes, tokenSeen: kept.includes(expect) }),
	};
}

/** Usage facts of a native terminal event, read loosely: the parser owns validation. */
function nativeUsageOf(usage: unknown): {
	costUsd: number | null;
	status: PaidCostStatus;
	model: string | null;
} {
	const u = (usage ?? {}) as {
		costUsd?: unknown;
		model?: unknown;
		accounting?: { cost?: { status?: unknown } };
	};
	const raw = u.accounting?.cost?.status;
	const status: PaidCostStatus = raw === 'exact' || raw === 'partial' ? raw : 'unknown';
	const costUsd = typeof u.costUsd === 'number' && Number.isFinite(u.costUsd) ? u.costUsd : null;
	return {
		costUsd,
		status: status === 'exact' && costUsd === null ? 'partial' : status,
		model: typeof u.model === 'string' ? u.model : null,
	};
}

/**
 * The effort a native terminal record itself reports, read from the raw line
 * (`reasoning_effort` or `reasoningEffort`, top level or under `usage`). Null
 * when the record names none: an unreported effort is never acknowledged.
 */
function reportedEffortOf(line: string): string | null {
	let raw: unknown;
	try {
		raw = JSON.parse(line);
	} catch {
		return null;
	}
	const pick = (o: unknown): string | null => {
		if (!o || typeof o !== 'object') return null;
		const r = o as Record<string, unknown>;
		const v = r.reasoning_effort ?? r.reasoningEffort;
		return typeof v === 'string' && v.trim() ? v.trim() : null;
	};
	return pick(raw) ?? pick((raw as Record<string, unknown> | null)?.usage);
}

/** Evaluate a fixture's assertions against what the leg observed. */
export function evaluatePaidAssertions(
	fixture: PaidFixture,
	observed: {
		route: Route;
		turns: PaidTurnResult[];
		model: string;
		sha256Pinned: string | null;
		sha256After: string | null;
		/** The account whose turns ran (per-account fixtures); defaults to A. */
		account?: 'A' | 'B';
		/** The effort the leg selected; null when none was. */
		effort?: string | null;
		/** Gateway variables the child received (name to origin) and the ones the selection named. */
		gateways?: Record<string, string>;
		selectedGateways?: string[];
		approvedEndpoints?: string[];
	}
): PaidAssertionOutcome[] {
	const { turns } = observed;
	const complete = turns.length === fixtureTurnsFor(fixture, observed.account ?? 'A').length;
	const all = (pred: (t: PaidTurnResult) => boolean) => complete && turns.every(pred);
	const out: PaidAssertionOutcome[] = [];
	const verdict = (id: string, ok: boolean, detail: string) =>
		out.push({ id, outcome: ok ? 'passed' : 'failed', detail });
	const ran = `${turns.length}/${fixtureTurnsFor(fixture, observed.account ?? 'A').length} turns`;
	for (const id of fixture.assertions) {
		switch (id) {
			case 'exit-clean':
				verdict(
					id,
					all(
						(t) =>
							!t.timedOut &&
							!t.spawnError &&
							!t.stdout.truncated &&
							!t.stderr.truncated &&
							(observed.route === 'acp-stdio' || t.exitCode === 0)
					),
					ran
				);
				break;
			case 'terminal-success':
				verdict(
					id,
					all((t) => t.terminal === 'success'),
					ran
				);
				break;
			case 'session-id':
				verdict(
					id,
					all((t) => Boolean(t.sessionId)),
					ran
				);
				break;
			case 'session-continuity':
				verdict(
					id,
					all((t) => Boolean(t.sessionId) && t.sessionId === turns[0].sessionId) &&
						turns.length > 1,
					ran
				);
				break;
			case 'reply-token':
				verdict(
					id,
					all((t) => t.reply.tokenSeen),
					ran
				);
				break;
			case 'model-acknowledged':
				verdict(
					id,
					all((t) => t.model === observed.model),
					observed.model
				);
				break;
			case 'usage-reported':
				if (observed.route === 'acp-stdio')
					out.push({
						id,
						outcome: 'not-evaluated',
						detail: 'the paid executor reads no ACP usage; the charge stays uncertain',
						owner: 'GT1-11-11F',
					});
				else
					verdict(
						id,
						all((t) => t.usage.status !== 'absent'),
						ran
					);
				break;
			case 'binary-unchanged':
				verdict(
					id,
					Boolean(observed.sha256Pinned) && observed.sha256After === observed.sha256Pinned,
					'sha256 after the leg'
				);
				break;
			case 'colliding-native-ids':
				// A cross-leg verdict: executePaidCase replaces this once both legs ran.
				out.push({
					id,
					outcome: 'not-evaluated',
					detail: 'evaluated across both account legs',
					owner: 'GT1-11-11A2',
				});
				break;
			case 'effort-and-gateway': {
				const failures: string[] = [];
				const selected = observed.effort ?? null;
				if (!selected) failures.push('effort-unselected');
				else if (!all((t) => t.effort === selected))
					failures.push(
						`effort-unacknowledged:${turns.map((t) => t.effort ?? 'unreported').join(',') || 'no-turn'}`
					);
				const approved = (observed.approvedEndpoints ?? [])
					.filter((e) => endpointOriginProblem(e) === null)
					.map((e) => new URL(e).origin);
				const received = observed.gateways ?? {};
				for (const [key, origin] of Object.entries(received))
					if (!approved.includes(origin)) failures.push(`gateway-unapproved:${key}`);
				for (const key of observed.selectedGateways ?? [])
					if (!(key in received)) failures.push(`gateway-not-applied:${key}`);
				verdict(
					id,
					failures.length === 0,
					failures.length ? failures.join('; ') : `effort ${selected}; ${ran}`
				);
				break;
			}
		}
	}
	for (const u of fixture.unevaluated)
		out.push({ id: u.id, outcome: 'not-evaluated', detail: u.detail, owner: u.owner });
	return out;
}

/** A bounded wait that never keeps the process alive on its own. */
const delay = (ms: number) =>
	new Promise<void>((resolve) => {
		setTimeout(resolve, ms).unref();
	});

/**
 * The child environment of a credentialed launch: the planned env with a
 * secret-name reference resolved at spawn (the value never leaves this env),
 * or a file reference checked for existence only (never read).
 */
function resolveLaunchCredential(
	launch: PlannedLaunch,
	config: QualificationConfig,
	account: 'A' | 'B',
	resolveSecret: ((name: string) => string | null) | undefined
): { env: Record<string, string> } | { refused: string; detail: string } {
	const env: Record<string, string> = { ...launch.env };
	const ref = config.credentialReferences.find(
		(r) => r.provider === 'grok' && r.account === account
	);
	if (launch.credentialMode === 'secret-name' && ref?.kind === 'secret-name') {
		const resolve =
			resolveSecret ??
			((name: string) => {
				const found = lookupSecret(name);
				return found.status === 'found' ? found.value : null;
			});
		const value = resolve(ref.name);
		if (!value) return { refused: 'credential-unresolvable', detail: ref.name };
		env.XAI_API_KEY = value;
	} else if (launch.credentialMode === 'file') {
		const authPath = launch.expectation.authPath;
		// Existence only: the harness never reads a credential file.
		if (!authPath || !fs.existsSync(authPath) || !fs.statSync(authPath).isFile())
			return { refused: 'credential-file-absent', detail: 'GROK_AUTH_PATH' };
	}
	return { env };
}

/**
 * One paid leg (one account) of an admitted case. Nothing spawns until the
 * binary re-hashes to the pin, the credentialed launch validates and the
 * reservation is held; every turn is counted before it is sent and the leg
 * always settles or releases what it reserved.
 */
async function executePaidLeg(
	c: QualificationCase,
	config: QualificationConfig,
	ctx: PaidExecutionContext,
	account: 'A' | 'B',
	legName: string | null,
	fixture: PaidFixture,
	plan: ReservationPlan
): Promise<PaidLegReceipt> {
	const { ledger } = ctx;
	const receipt: PaidLegReceipt = {
		leg: legName ?? 'main',
		account,
		route: c.route,
		status: 'not-run',
		reasons: [],
		reservationId: null,
		fixture: { schema: fixture.schema, family: fixture.family, sha256: paidFixtureDigest(fixture) },
		binary: { sha256Pinned: config.binary.sha256, sha256AtSpawn: null, sha256After: null },
		launch: null,
		accountRoot: null,
		credential: null,
		gateways: {},
		turns: [],
		assertions: [],
		settlement: null,
		spawned: 0,
		paidRequests: 0,
	};
	const refuse = (id: string, detail: string, owner?: string) => {
		receipt.reasons.push(paidReason(id, detail, owner));
		return receipt;
	};
	const legTurns = fixtureTurnsFor(fixture, account);
	const effortCase = fixture.assertions.includes('effort-and-gateway');
	const effort = effortCase ? (config.selection?.effort?.trim() ?? '') || null : null;

	// Never a retry: a leg whose earlier reservation left an effect uncertain, or already ran, refuses.
	const prior = ledger.reservations.filter(
		(r) => r.caseId === c.caseId && r.leg === legName && r.state !== 'released'
	);
	if (prior.some((r) => r.state === 'uncertain' || r.uncertainEffect))
		return refuse('uncertain-prior-effect', receipt.leg);
	if (prior.length) return refuse('leg-already-run', receipt.leg);
	// An effort case with nothing selected could only pass on the model default: refuse it unsent.
	if (effortCase && !effort) return refuse('effort-unselected', 'selection.effort', 'GT1-11-11A2');

	// The immutable pinned binary, re-hashed before anything is reserved or spawned.
	const file = path.resolve(ctx.workspace, config.binary.path ?? '');
	const atSpawn = inspectExecutable(file);
	receipt.binary.sha256AtSpawn = atSpawn.sha256;
	if (!config.binary.path || !atSpawn.regular) return refuse('binary-unreadable', 'binary.path');
	if (atSpawn.sha256 !== config.binary.sha256)
		return refuse('binary-hash-mismatch-at-spawn', 'binary.sha256');
	if (!atSpawn.readOnly) return refuse('binary-mutable', 'binary.path');

	// The planned isolated launch with the selected account's credential reference only.
	const launch = planIsolatedLaunch(
		c,
		config,
		account,
		'credentialed',
		ctx.workspace,
		ctx.operatorHome
	);
	if (!launch || launch.credentialMode === 'none')
		return refuse('paid-launch-unplannable', account);
	receipt.accountRoot = launch.expectation.accountRoot;
	const ref = config.credentialReferences.find(
		(r) => r.provider === 'grok' && r.account === account
	);
	if (ref)
		receipt.credential = {
			kind: ref.kind,
			reference: ref.kind === 'file' ? ref.path : ref.name,
		};
	const credential = resolveLaunchCredential(launch, config, account, ctx.resolveSecret);
	if ('refused' in credential) return refuse(credential.refused, credential.detail);
	const env = credential.env;
	for (const key of GROK_GATEWAY_ENV)
		if (env[key]) {
			let origin: string;
			try {
				origin = new URL(env[key]).origin;
			} catch {
				origin = 'invalid-url';
			}
			receipt.gateways[key] = origin;
		}
	const report = validateLaunchEnvironment(env, launch.expectation);
	if (report.reasons.length) {
		receipt.reasons.push(...report.reasons);
		return receipt;
	}
	receipt.launch = { credentialMode: launch.credentialMode, keys: report.keys };
	const cwd = launch.expectation.home;
	if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory())
		return refuse('paid-home-absent', 'isolation.boundary.actualHome');
	fs.mkdirSync(env.TMPDIR, { recursive: true, mode: 0o700 });

	// Reserve before any dispatch.
	const primary = config.allowedModels[0];
	const side = config.spendBounds?.sideModels?.[0] ?? primary;
	const models = [...new Set([primary, ...(config.spendBounds?.sideModels ?? [])])];
	const reserved = reserveSpend(
		ledger,
		config,
		{
			caseId: c.caseId,
			leg: legName,
			provider: 'grok',
			account,
			endpoint: config.allowedEndpoints[0] ?? '',
			models,
			target: c.target,
			plan,
		},
		ctx.now()
	);
	if (!reserved.ok) {
		receipt.reasons.push(...reserved.reasons);
		return receipt;
	}
	const reservation = reserved.reservation;
	receipt.reservationId = reservation.id;

	const real = fs.realpathSync(file);
	const graceMs = Math.max(1, Math.min(config.limits.cleanupSeconds, 5)) * 1000;
	const ceilingMs = HARNESS_CEILINGS.caseSeconds * 1000;
	const turnMs = () =>
		Math.min(
			positiveFinite(ctx.turnTimeoutMs) ? ctx.turnTimeoutMs : ceilingMs,
			ceilingMs,
			Date.parse(reservation.deadlineAt) - ctx.now().getTime()
		);
	let uncertainWhy: string | null = null;
	let callsDrawn = emptyCalls();

	/** Count the turn and every call it may make before it is sent; false refuses it unsent. */
	const admitTurn = (n: number): boolean => {
		if (turnMs() <= 0) {
			receipt.reasons.push(paidReason('reservation-deadline-passed', `turn ${n}`));
			return false;
		}
		if (inspectExecutable(file).sha256 !== config.binary.sha256) {
			receipt.reasons.push(paidReason('binary-hash-mismatch-at-spawn', `turn ${n}`));
			return false;
		}
		const perTurn = paidCallsPerTurn(config, reservation);
		const needed = Object.values(perTurn).reduce((a, b) => a + b, 0);
		if (
			reservation.turnsUsed >= reservation.turnAllowance ||
			ledger.turns >= ledger.limitTurns ||
			reservation.callsUsed + needed > reservation.callAllowance ||
			ledger.calls + needed > ledger.limitCalls
		) {
			receipt.reasons.push(paidReason('turn-allowance-exhausted', `turn ${n}`));
			return false;
		}
		try {
			recordUserTurn(ledger, reservation.id, ctx.now());
			for (const kind of Object.keys(perTurn) as BillableCallKind[])
				for (let i = 0; i < perTurn[kind]; i++)
					recordBillableCall(
						ledger,
						reservation.id,
						{ kind, model: kind === 'model-round' || kind === 'retry' ? primary : side },
						ctx.now()
					);
		} catch (e) {
			receipt.reasons.push(paidReason('turn-allowance-refused', (e as Error).message));
			return false;
		}
		callsDrawn = perTurn;
		return true;
	};

	if (c.route === 'native-headless') {
		const def = getAgentDefinition('grok');
		// The definition's own effort builder (`--reasoning-effort <level>`), never a hand-rolled flag.
		const effortOption = def?.configOptions?.find((o) => o.key === 'reasoningEffort');
		const effortArgs =
			effort && effortOption?.type === 'text' ? (effortOption.argBuilder?.(effort) ?? []) : [];
		for (let i = 0; i < legTurns.length; i++) {
			const n = i + 1;
			const t = legTurns[i];
			const resumeId = i > 0 ? receipt.turns[0]?.sessionId : null;
			if (i > 0 && !resumeId) {
				receipt.reasons.push(paidReason('session-id-missing', `turn ${n}`));
				break;
			}
			const argvFor = (prompt: string) => [
				...(def?.jsonOutputArgs ?? []),
				...(def?.readOnlyArgs ?? []),
				...(def?.modelArgs?.(primary) ?? []),
				...effortArgs,
				...(def?.workingDirArgs?.(cwd) ?? []),
				...(resumeId ? (def?.resumeArgs?.(resumeId) ?? []) : []),
				...(def?.promptArgs?.(prompt) ?? []),
			];
			if (!admitTurn(n)) break;
			const parser = new GrokOutputParser();
			const reply = replyCollector(t.expect);
			const decoder = new StringDecoder('utf8');
			let pending = '';
			// One object, so the closure's writes are not narrowed away at the reads below.
			const seen: Pick<PaidTurnResult, 'sessionId' | 'terminal' | 'usage' | 'model' | 'effort'> = {
				sessionId: null,
				terminal: 'none',
				usage: { costUsd: null, status: 'absent' },
				model: null,
				effort: null,
			};
			const onLine = (line: string) => {
				const ev = parser.parseJsonLine(line);
				if (!ev) return;
				if ((ev.type === 'result' || ev.type === 'error') && ev.terminal)
					seen.effort = reportedEffortOf(line);
				if (ev.sessionId && !seen.sessionId) seen.sessionId = ev.sessionId;
				if (ev.type === 'text' && !ev.isReasoning && ev.text) reply.push(ev.text);
				if ((ev.type === 'result' || ev.type === 'error') && ev.terminal) {
					seen.terminal = ev.type === 'result' ? 'success' : 'failure';
					if (ev.usage) {
						const u = nativeUsageOf(ev.usage);
						seen.usage = { costUsd: u.costUsd, status: u.status };
						seen.model = u.model;
					}
				}
			};
			const { result } = await runOfflineProbe(
				`turn-${n}`,
				real,
				argvFor(t.prompt),
				env,
				cwd,
				turnMs(),
				graceMs,
				ctx.lifetime,
				(d) => {
					pending += decoder.write(d);
					let k: number;
					while ((k = pending.indexOf('\n')) >= 0) {
						onLine(pending.slice(0, k));
						pending = pending.slice(k + 1);
					}
				}
			);
			pending += decoder.end();
			if (pending.trim()) onLine(pending);
			receipt.spawned++;
			const neverRan = result.spawnError !== null && NEVER_RAN_SPAWN_ERRORS.has(result.spawnError);
			if (!neverRan) receipt.paidRequests++;
			receipt.turns.push({
				turn: n,
				argv: argvFor(`<fixture:${fixture.family}:turn-${n}>`),
				exitCode: result.exitCode,
				signal: result.signal,
				durationMs: result.durationMs,
				timedOut: result.timedOut,
				spawnError: result.spawnError,
				stdout: result.stdout,
				stderr: result.stderr,
				...seen,
				reply: reply.result(),
				callsRecorded: callsDrawn,
			});
			if (neverRan) {
				receipt.reasons.push(paidReason('paid-spawn-failed', result.spawnError ?? ''));
				break;
			}
			if (result.timedOut) uncertainWhy = 'turn-timeout';
			else if (result.spawnError) uncertainWhy = 'turn-spawn-error-after-start';
			else if (result.stdout.truncated || result.stderr.truncated)
				uncertainWhy = 'turn-output-unbounded';
			if (uncertainWhy) {
				receipt.reasons.push(paidReason(uncertainWhy, `turn ${n}`));
				break;
			}
			if (result.exitCode !== 0 || seen.terminal !== 'success') {
				receipt.reasons.push(paidReason('turn-failed', `turn ${n}`));
				break;
			}
		}
	} else {
		const run = await runAcpPaidTurns({
			file: real,
			env,
			cwd,
			model: primary,
			effort,
			fixture,
			turns: legTurns,
			graceMs,
			lifetime: ctx.lifetime,
			turnMs,
			admitTurn,
			calls: () => callsDrawn,
		});
		receipt.turns = run.turns;
		receipt.spawned = run.spawned;
		receipt.paidRequests = run.sent;
		receipt.reasons.push(...run.reasons);
		uncertainWhy = run.uncertainWhy;
	}

	// Settle or release exactly once: an unknown or partial charge stays uncertain, never zero.
	const sentTurns = receipt.paidRequests;
	let settled: SpendReservation;
	if (reservation.turnsUsed === 0 && reservation.callsUsed === 0 && !reservation.uncertainEffect)
		settled = releaseReservation(ledger, reservation.id, ctx.now());
	else if (sentTurns === 0)
		settled = settleReservation(
			ledger,
			reservation.id,
			{ kind: 'settled', actualUsd: 0, reason: 'counted-but-never-sent' },
			ctx.now()
		);
	else {
		const known = receipt.turns.map((t) => t.usage.costUsd).filter((n): n is number => n !== null);
		const partialUsd = known.length ? known.reduce((a, b) => a + b, 0) : undefined;
		const exact =
			!uncertainWhy &&
			receipt.turns.length === sentTurns &&
			receipt.turns.every((t) => t.usage.status === 'exact' && t.usage.costUsd !== null);
		if (exact)
			settled = settleReservation(
				ledger,
				reservation.id,
				{ kind: 'settled', actualUsd: partialUsd ?? 0, reason: 'observed-exact-usage' },
				ctx.now()
			);
		else {
			markUncertainEffect(ledger, reservation.id);
			settled = settleReservation(
				ledger,
				reservation.id,
				{
					kind: 'uncertain',
					...(partialUsd !== undefined ? { partialUsd } : {}),
					reason: uncertainWhy ?? 'charge-unknown',
				},
				ctx.now()
			);
		}
	}
	receipt.settlement = {
		state: settled.state,
		settledUsd: settled.settledUsd,
		uncertainUsd: settled.uncertainUsd,
		reason: settled.settlement?.reason ?? '',
	};

	receipt.binary.sha256After = inspectExecutable(file).sha256;
	if (receipt.binary.sha256After !== config.binary.sha256)
		receipt.reasons.push(paidReason('binary-changed-during-leg', 'binary.path'));
	receipt.assertions = evaluatePaidAssertions(fixture, {
		route: c.route,
		turns: receipt.turns,
		model: primary,
		sha256Pinned: config.binary.sha256,
		sha256After: receipt.binary.sha256After,
		account,
		effort,
		gateways: receipt.gateways,
		selectedGateways: Object.keys(config.selection?.gateways ?? {}),
		approvedEndpoints: config.allowedEndpoints,
	});
	receipt.status =
		receipt.spawned === 0
			? 'not-run'
			: receipt.reasons.length || receipt.assertions.some((a) => a.outcome === 'failed')
				? 'failed'
				: 'passed';
	return receipt;
}

/**
 * The ACP route of a paid leg: one owned `agent stdio` child for every turn of
 * the leg, initialize and session/new with the selected model (an
 * unacknowledged model stops the leg before any prompt), then one
 * session/prompt per fixture turn, each counted before it is written. ACP
 * reports no settled charge here, so a sent turn's cost stays unknown.
 */
async function runAcpPaidTurns(args: {
	file: string;
	env: Record<string, string>;
	cwd: string;
	model: string;
	/** The selected effort; set through session/set_config_option and acknowledged before any prompt. */
	effort: string | null;
	fixture: PaidFixture;
	/** The turns this account runs (its own on a per-account fixture). */
	turns: PaidFixture['turns'];
	graceMs: number;
	lifetime: CaseLifetime;
	turnMs: () => number;
	admitTurn: (n: number) => boolean;
	calls: () => Record<BillableCallKind, number>;
}): Promise<{
	turns: PaidTurnResult[];
	reasons: AdmissionReason[];
	spawned: number;
	sent: number;
	uncertainWhy: string | null;
}> {
	const turns: PaidTurnResult[] = [];
	const reasons: AdmissionReason[] = [];
	let sent = 0;
	let uncertainWhy: string | null = null;
	let child: ChildProcess;
	try {
		child = spawn(args.file, [...GROK_ACP_ARGS], {
			cwd: args.cwd,
			env: args.env,
			shell: false,
			stdio: ['pipe', 'pipe', 'pipe'],
			windowsHide: true,
		});
	} catch (e) {
		reasons.push(
			paidReason('paid-spawn-failed', (e as NodeJS.ErrnoException).code ?? 'spawn-threw')
		);
		return { turns, reasons, spawned: 0, sent, uncertainWhy };
	}
	args.lifetime.own(child);
	let spawnError: string | null = null;
	let window = { out: streamDigest(), err: streamDigest(), started: Date.now() };
	let reply: ReturnType<typeof replyCollector> | null = null;
	let sessionId: string | null = null;
	let unbounded = false;
	const exited = new Promise<void>((resolve) => child.on('close', () => resolve()));
	const stop = () => stopProcess({ child }, { from: 'terminate', graceMs: args.graceMs });
	const client = new GrokAcpClient({
		write: (frame) => {
			child.stdin?.write(frame);
		},
		requestTimeoutMs: Math.max(
			1,
			Math.min(HARNESS_CEILINGS.discoverySeconds * 1000, Math.floor(args.turnMs()))
		),
		onNotification: (message) => {
			const params = (message.params ?? {}) as Record<string, unknown>;
			if (message.method !== 'session/update' || !sessionId || params.sessionId !== sessionId)
				return;
			const update = (params.update ?? {}) as Record<string, unknown>;
			const content = (update.content ?? {}) as Record<string, unknown>;
			if (
				update.sessionUpdate === 'agent_message_chunk' &&
				content.type === 'text' &&
				typeof content.text === 'string'
			)
				reply?.push(content.text);
		},
	});
	child.stdout?.on('data', (d: Buffer) => {
		if (window.out.push(d)) {
			unbounded = true;
			stop();
		}
		client.feedStdout(d);
	});
	child.stderr?.on('data', (d: Buffer) => {
		if (window.err.push(d)) {
			unbounded = true;
			stop();
		}
		client.feedStderr(d);
	});
	child.stdin?.on('error', () => client.close('write'));
	child.on('error', (e: NodeJS.ErrnoException) => {
		spawnError = e.code ?? 'spawn-error';
		client.close('closed');
	});
	child.on('close', () => client.close('closed'));

	let acknowledged: string | null = null;
	let openedOptions: unknown[] = [];
	try {
		await client.initialize();
		const opened = (await client.request('session/new', {
			cwd: args.cwd,
			mcpServers: [],
			_meta: { modelId: args.model },
		})) as Record<string, unknown> | null;
		const id = opened?.sessionId;
		if (typeof id === 'string' && id.trim()) sessionId = id;
		const models = (opened?.models ?? {}) as Record<string, unknown>;
		const options = Array.isArray(opened?.configOptions) ? opened.configOptions : [];
		openedOptions = options;
		const modelOption = options.find(
			(o) => o && typeof o === 'object' && (o as Record<string, unknown>).id === 'model'
		) as Record<string, unknown> | undefined;
		const current = models.currentModelId ?? modelOption?.currentValue;
		acknowledged = typeof current === 'string' ? current : null;
	} catch (e) {
		reasons.push(
			paidReason(
				'acp-setup-failed',
				e instanceof GrokAcpTransportError ? e.reason : (spawnError ?? 'request-error')
			)
		);
	}
	if (!reasons.length && !sessionId) reasons.push(paidReason('session-id-missing', 'session/new'));
	if (!reasons.length && acknowledged !== args.model)
		reasons.push(paidReason('model-unacknowledged', args.model));
	// The selected effort, acknowledged before any prompt. A choice the menu does not offer, a
	// refused write or an unacknowledged answer stops the leg unsent: never a lower effort or model.
	let effortAck: string | null = null;
	if (!reasons.length && args.effort) {
		const optionOf = (list: unknown, id: string) =>
			(Array.isArray(list) ? list : []).find(
				(o) => o && typeof o === 'object' && (o as Record<string, unknown>).id === id
			) as Record<string, unknown> | undefined;
		const menu = optionOf(openedOptions, 'reasoning_effort');
		const offered =
			Array.isArray(menu?.options) &&
			menu.options.some(
				(o) => o && typeof o === 'object' && (o as Record<string, unknown>).value === args.effort
			);
		if (!offered) reasons.push(paidReason('effort-unsupported', args.effort, 'GT1-11-11A2'));
		else if (menu?.currentValue === args.effort) effortAck = args.effort;
		else
			try {
				const answer = (await client.request('session/set_config_option', {
					sessionId,
					configId: 'reasoning_effort',
					value: args.effort,
				})) as Record<string, unknown> | null;
				const after = optionOf(answer?.configOptions, 'reasoning_effort')?.currentValue;
				const modelAfter = optionOf(answer?.configOptions, 'model')?.currentValue;
				effortAck = typeof after === 'string' ? after : null;
				if (effortAck !== args.effort)
					reasons.push(paidReason('effort-unacknowledged', args.effort, 'GT1-11-11A2'));
				else if (modelAfter !== undefined && modelAfter !== args.model)
					reasons.push(paidReason('model-downgraded', String(modelAfter), 'GT1-11-11A2'));
			} catch (e) {
				reasons.push(
					paidReason(
						'effort-rejected',
						e instanceof GrokAcpTransportError ? e.reason : 'request-error',
						'GT1-11-11A2'
					)
				);
			}
	}

	for (let i = 0; !reasons.length && i < args.turns.length; i++) {
		const n = i + 1;
		const t = args.turns[i];
		if (!args.admitTurn(n)) break;
		if (i > 0) window = { out: streamDigest(), err: streamDigest(), started: Date.now() };
		reply = replyCollector(t.expect);
		let stopReason: unknown = null;
		let failure: string | null = null;
		let timedOut = false;
		sent++;
		try {
			const answer = (await client.request(
				'session/prompt',
				{ sessionId, prompt: [{ type: 'text', text: t.prompt }] },
				{ timeoutMs: Math.max(1, Math.floor(args.turnMs())) }
			)) as Record<string, unknown> | null;
			stopReason = answer?.stopReason ?? null;
		} catch (e) {
			failure = e instanceof GrokAcpTransportError ? `transport:${e.reason}` : 'request-error';
			timedOut = e instanceof GrokAcpTransportError && e.reason === 'timeout';
		}
		turns.push({
			turn: n,
			argv: [...GROK_ACP_ARGS, `<fixture:${args.fixture.family}:turn-${n}>`],
			exitCode: null,
			signal: null,
			durationMs: Date.now() - window.started,
			timedOut,
			spawnError: failure,
			stdout: window.out.result(),
			stderr: window.err.result(),
			sessionId,
			terminal: stopReason === 'end_turn' ? 'success' : stopReason ? 'failure' : 'none',
			reply: reply.result(),
			model: acknowledged,
			effort: effortAck,
			// ACP returns no settled charge on this route; the cost stays unknown.
			usage: { costUsd: null, status: 'absent' },
			callsRecorded: args.calls(),
		});
		if (failure || unbounded) {
			uncertainWhy = timedOut
				? 'turn-timeout'
				: unbounded
					? 'turn-output-unbounded'
					: 'turn-transport-lost';
			reasons.push(paidReason(uncertainWhy, `turn ${n}`));
			break;
		}
		if (stopReason !== 'end_turn') {
			reasons.push(paidReason('turn-failed', `turn ${n}`));
			break;
		}
	}
	client.close('closed');
	stop();
	await Promise.race([exited, delay(args.graceMs + 1000)]);
	return { turns, reasons, spawned: 1, sent, uncertainWhy };
}

/** Bounds of one owned-home inspection; past either, the home cannot be vouched for and the verdict fails. */
export const HOME_SCAN_LIMITS = Object.freeze({ entries: 4096, bytes: 16 * 1024 * 1024 });

/**
 * The session ids a Grok home lists natively: the
 * `sessions/<encoded-cwd>/<session-id>/` directories (the layout
 * `grok-session-storage.ts` reads). A symlink anywhere on that path is a
 * problem (a shared pool is exactly what isolation must rule out); nothing is
 * followed and no transcript is read.
 */
export function listNativeSessionIds(home: string | null): {
	ids: string[];
	problem: string | null;
} {
	if (!home) return { ids: [], problem: 'home-undeclared' };
	const sessions = path.join(home, 'sessions');
	const lst = (p: string) => {
		try {
			return fs.lstatSync(p);
		} catch {
			return null;
		}
	};
	const top = lst(sessions);
	if (!top) return { ids: [], problem: null };
	if (top.isSymbolicLink() || !top.isDirectory()) return { ids: [], problem: 'sessions-not-owned' };
	const ids = new Set<string>();
	for (const folder of fs.readdirSync(sessions)) {
		const fp = path.join(sessions, folder);
		const st = lst(fp);
		if (!st) continue;
		if (st.isSymbolicLink()) return { ids: [], problem: 'sessions-entry-symlink' };
		if (!st.isDirectory()) continue;
		for (const id of fs.readdirSync(fp)) {
			const s = lst(path.join(fp, id));
			if (s?.isSymbolicLink()) return { ids: [], problem: 'sessions-entry-symlink' };
			if (s?.isDirectory()) ids.add(id);
		}
	}
	return { ids: [...ids].sort(), problem: null };
}

/**
 * Which needles any entry name or regular file under an owned home carries.
 * Bounded by `HOME_SCAN_LIMITS`, never through a symlink; the content is
 * searched in memory and never kept or written.
 */
function homeCarries(home: string, needles: string[]): { found: string[]; problem: string | null } {
	const found = new Set<string>();
	if (!needles.length || !fs.existsSync(home)) return { found: [], problem: null };
	const stack = [home];
	let entries = 0;
	let bytes = 0;
	while (stack.length) {
		const dir = stack.pop()!;
		for (const name of fs.readdirSync(dir)) {
			if (++entries > HOME_SCAN_LIMITS.entries)
				return { found: [...found], problem: 'home-scan-unbounded' };
			for (const n of needles) if (name.includes(n)) found.add(n);
			const p = path.join(dir, name);
			const st = fs.lstatSync(p);
			if (st.isSymbolicLink()) return { found: [...found], problem: 'home-entry-symlink' };
			if (st.isDirectory()) stack.push(p);
			else if (st.isFile()) {
				bytes += st.size;
				if (bytes > HOME_SCAN_LIMITS.bytes)
					return { found: [...found], problem: 'home-scan-unbounded' };
				const text = fs.readFileSync(p, 'latin1');
				for (const n of needles) if (text.includes(n)) found.add(n);
			}
		}
	}
	return { found: [...found], problem: null };
}

/**
 * The `colliding-native-ids` verdict of a two-account case, from the two owned
 * homes after both legs: each leg ran on its own account's credential
 * reference and home; each home lists every session id its own leg reported
 * and gained no other; and no entry of either home carries the other leg's
 * fixture token, or the other leg's session id when the two ids differ (when
 * they collide, the token is what tells the records apart).
 */
export function evaluateCollidingNativeIds(
	legs: PaidLegReceipt[],
	fixture: PaidFixture,
	config: QualificationConfig,
	ctx: {
		homes: Record<'A' | 'B', string | null>;
		/** Session ids each home listed before the legs ran. */
		before: Record<'A' | 'B', string[]>;
	}
): PaidAssertionOutcome {
	const id = 'colliding-native-ids';
	const legOf = (a: 'A' | 'B') => legs.find((l) => l.account === a);
	const a = legOf('A');
	const b = legOf('B');
	if (!a || !b || !a.spawned || !b.spawned)
		return {
			id,
			outcome: 'not-evaluated',
			detail: 'both account legs must run',
			owner: 'GT1-11-11A2',
		};
	const failures: string[] = [];
	const { homes } = ctx;
	if (!homes.A || !homes.B) failures.push('account-home-undeclared');
	else if (overlaps('local', homes.A, homes.B)) failures.push('account-home-shared');
	const own = (leg: PaidLegReceipt) => [
		...new Set(leg.turns.map((t) => t.sessionId).filter((s): s is string => Boolean(s))),
	];
	const refOf = (acct: 'A' | 'B') => {
		const r = config.credentialReferences.find((x) => x.provider === 'grok' && x.account === acct);
		return r ? `${r.kind}:${r.kind === 'file' ? r.path : r.name}` : null;
	};
	if (refOf('A') && refOf('A') === refOf('B')) failures.push('credential-source-shared');
	for (const [x, y] of [
		['A', 'B'],
		['B', 'A'],
	] as const) {
		const lx = x === 'A' ? a : b;
		const ly = y === 'A' ? a : b;
		const home = homes[x];
		if (
			!home ||
			!lx.accountRoot ||
			normalizeFor('local', lx.accountRoot) !== normalizeFor('local', home)
		)
			failures.push(`leg-home-not-own:${x}`);
		const used = lx.credential ? `${lx.credential.kind}:${lx.credential.reference}` : null;
		if (!used || used !== refOf(x)) failures.push(`credential-source-not-own:${x}`);
		const mine = own(lx);
		if (!mine.length) failures.push(`own-session-unnamed:${x}`);
		if (!home) continue;
		const after = listNativeSessionIds(home);
		if (after.problem) failures.push(`${after.problem}:${x}`);
		for (const s of mine) if (!after.ids.includes(s)) failures.push(`own-session-unlisted:${x}`);
		const added = after.ids.filter((s) => !ctx.before[x].includes(s));
		if (added.some((s) => !mine.includes(s))) failures.push(`foreign-session-listed:${x}`);
		const myTokens = fixtureTurnsFor(fixture, x).map((t) => t.expect);
		const needles = [
			...fixtureTurnsFor(fixture, y)
				.map((t) => t.expect)
				.filter((t) => !myTokens.includes(t)),
			...own(ly).filter((s) => !mine.includes(s)),
		];
		const scan = homeCarries(home, needles);
		if (scan.problem) failures.push(`${scan.problem}:${x}`);
		if (scan.found.length) failures.push(`other-leg-record:${x}`);
	}
	const collide = own(a).some((s) => own(b).includes(s));
	return {
		id,
		outcome: failures.length ? 'failed' : 'passed',
		detail: failures.length
			? [...new Set(failures)].join('; ')
			: `each home holds only its own leg; session ids ${collide ? 'collide' : 'differ'}`,
	};
}

/**
 * Execute the paid legs of one admitted case (one per account). Admission and
 * preflight are re-checked here, so a caller that skipped them still cannot
 * spawn; a refusal returns not-run legs with zero spawns and no reservation.
 */
export async function executePaidCase(
	c: QualificationCase,
	config: QualificationConfig,
	ctx: PaidExecutionContext
): Promise<PaidLegReceipt[]> {
	const accounts: Array<'A' | 'B'> = c.family === 'E01' ? ['A', 'B'] : ['A'];
	const fixture = PAID_FIXTURES[c.family];
	const reasons = admitCase(c, config, ctx.problems, ctx.capabilities, ctx.now());
	reasons.push(
		...preflightCase(c, config, { workspace: ctx.workspace, operatorHome: ctx.operatorHome })
			.reasons
	);
	if (!c.classes.includes('paid')) reasons.push(paidReason('paid-leg-absent', c.caseId));
	reasons.push(...(ctx.precondition ?? []));
	if (!ctx.ledger.authorizedCaseIds.includes(c.caseId))
		reasons.push(paidReason('case-not-admitted', c.caseId));
	if (!fixture) reasons.push(paidReason('fixture-absent', c.family));
	const plan = planCaseReservation(c, config);
	const mostTurns = fixture
		? Math.max(...accounts.map((a) => fixtureTurnsFor(fixture, a).length))
		: 0;
	if (mostTurns > plan.turns)
		reasons.push(paidReason('fixture-exceeds-turn-allowance', `${mostTurns} > ${plan.turns}`));
	const refused = (account: 'A' | 'B'): PaidLegReceipt => ({
		leg: accounts.length > 1 ? `account-${account}` : 'main',
		account,
		route: c.route,
		status: 'not-run',
		reasons: [...reasons],
		reservationId: null,
		fixture: fixture
			? { schema: fixture.schema, family: fixture.family, sha256: paidFixtureDigest(fixture) }
			: null,
		binary: { sha256Pinned: config.binary.sha256, sha256AtSpawn: null, sha256After: null },
		launch: null,
		accountRoot: null,
		credential: null,
		gateways: {},
		turns: [],
		assertions: [],
		settlement: null,
		spawned: 0,
		paidRequests: 0,
	});
	if (reasons.length || !fixture) return accounts.map(refused);
	// What each owned home listed before the legs: the colliding-ID verdict judges only what they added.
	const crossLeg = fixture.assertions.includes('colliding-native-ids') && accounts.length === 2;
	const homeOf = (a: 'A' | 'B') =>
		config.isolation?.accountRoots[a]
			? path.resolve(ctx.workspace, config.isolation.accountRoots[a]!)
			: null;
	const before = crossLeg
		? { A: listNativeSessionIds(homeOf('A')).ids, B: listNativeSessionIds(homeOf('B')).ids }
		: null;
	const legs: PaidLegReceipt[] = [];
	for (const account of accounts)
		legs.push(
			await executePaidLeg(
				c,
				config,
				ctx,
				account,
				accounts.length > 1 ? `account-${account}` : null,
				fixture,
				plan
			)
		);
	if (before) {
		const verdict = evaluateCollidingNativeIds(legs, fixture, config, {
			homes: { A: homeOf('A'), B: homeOf('B') },
			before,
		});
		for (const leg of legs) {
			leg.assertions = leg.assertions.map((a) =>
				a.id === 'colliding-native-ids' ? { ...verdict } : a
			);
			if (verdict.outcome === 'failed' && leg.status === 'passed') leg.status = 'failed';
		}
	}
	return legs;
}

/**
 * Owned processes of one case, stopped through the shared termination ladder.
 * Nothing registers here until an executor exists; cleanup is still the only
 * path that may stop a process, and it only stops what was registered.
 */
export function createCaseLifetime(cleanupSeconds: number) {
	const owned = new Set<ChildProcess>();
	return {
		own(child: ChildProcess) {
			owned.add(child);
		},
		async cleanup(): Promise<{ ownedProcesses: number; stopped: number }> {
			const graceMs = Math.max(1, Math.min(cleanupSeconds, 5)) * 1000;
			let stopped = 0;
			for (const child of owned) {
				if (child.exitCode !== null || child.signalCode !== null) continue;
				stopProcess({ child }, { from: 'terminate', graceMs });
				stopped++;
			}
			return { ownedProcesses: owned.size, stopped };
		},
	};
}

/** Make the owned run directory: a fresh child of the runs root, never through a symlink. */
export function createOwnedRunDir(workspace: string, runId: string): string {
	const root = path.join(workspace, RUNS_ROOT);
	fs.mkdirSync(root, { recursive: true, mode: 0o700 });
	const real = fs.realpathSync(root).replace(/\\/g, '/');
	const expected = path.join(fs.realpathSync(workspace), RUNS_ROOT).replace(/\\/g, '/');
	if (real !== expected) throw new Error('Runs root resolves through a symlink; refusing');
	if (!/^[A-Za-z0-9-]+$/.test(runId)) throw new Error('Run id must be a plain slug');
	const dir = path.join(root, runId);
	fs.mkdirSync(dir, { mode: 0o700 });
	return dir;
}

/** Redact every string in a value before it is written anywhere. */
export function redactDeep<T>(value: T): T {
	if (typeof value === 'string') return redactSecrets(value).text as T;
	if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as T;
	if (value && typeof value === 'object')
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v)])) as T;
	return value;
}

export interface RunOptions {
	workspace: string;
	runState: Parameters<typeof defaultConfigFromRunState>[0] & {
		testEnvironment?: { cases?: CaseFamily[] };
	};
	config?: QualificationConfig;
	selectedCases?: string[];
	capabilities?: HarnessCapabilities;
	now?: () => Date;
	runId?: string;
	/** The operator's own home the preflight keeps the child out of (defaults to `os.homedir()`). */
	operatorHome?: string;
	/** Write the receipt into the owned run directory (the CLI does; tests may not). */
	write?: boolean;
	/** Per-probe wall-clock bound of the offline leg; clamped to `HARNESS_CEILINGS.offlineProbeSeconds`. */
	offlineProbeTimeoutMs?: number;
	/** Whole-leg bound of a discovery leg; clamped to `HARNESS_CEILINGS.discoverySeconds`. */
	discoveryTimeoutMs?: number;
	/** Per-turn bound of a paid leg; clamped to `HARNESS_CEILINGS.caseSeconds` and the reservation deadline. */
	paidTurnTimeoutMs?: number;
	/** Resolve a secret-name credential reference at spawn (defaults to `lookupSecret`); the value is never recorded. */
	resolveSecret?: (name: string) => string | null;
}

/**
 * Plan, admit and record one qualification run. Returns the receipt; with
 * `write`, also writes `receipt.json` into a fresh owned run directory.
 */
export async function runQualification(options: RunOptions): Promise<{
	receipt: QualificationReceipt;
	receiptPath: string | null;
}> {
	const now = options.now ?? (() => new Date());
	const capabilities = options.capabilities ?? { ...HARNESS_CAPABILITIES };
	const runId =
		options.runId ?? `${now().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
	const startedAt = now().toISOString();
	const config = options.config ?? defaultConfigFromRunState(options.runState);
	const problems = validateConfig(config, options.workspace);
	const families = options.runState.testEnvironment?.cases ?? [];
	const selected = options.selectedCases?.length ? options.selectedCases : config.cases;
	const cases = expandCases(families, selected);
	const ledger = createBudgetLedger(config, runId, new Date(startedAt));
	const productionDigestBefore = productionCapabilityDigest();
	const operatorHome = options.operatorHome ?? os.homedir();
	const ceilingMs = HARNESS_CEILINGS.offlineProbeSeconds * 1000;
	const offlineTimeoutMs = positiveFinite(options.offlineProbeTimeoutMs)
		? Math.min(options.offlineProbeTimeoutMs, ceilingMs)
		: ceilingMs;

	const receipts: CaseReceipt[] = [];
	for (const c of cases) {
		// The offline-inspection leg first, as its own entry: it never waits on discovery inputs.
		const offlineLeg = c.classes.includes('offline-inspection')
			? await runOfflineLeg(c, config, problems, capabilities, {
					workspace: options.workspace,
					operatorHome,
					timeoutMs: offlineTimeoutMs,
				})
			: null;
		// The binary-resolution leg beside it: files only, no spawn, no credential, no network.
		const resolutionLeg = c.classes.includes('offline-inspection')
			? await runBinaryResolutionLeg(c, config, problems, capabilities, {
					workspace: options.workspace,
					operatorHome,
				})
			: null;
		const reasons = admitCase(c, config, problems, capabilities, now());
		const needsBinary = c.classes.some((k) => k !== 'deterministic');
		// Pre-spawn: every binary case is held to the isolation preflight first.
		const preflight =
			needsBinary && capabilities.isolationPreflight
				? preflightCase(c, config, { workspace: options.workspace, operatorHome })
				: null;
		if (preflight) reasons.push(...preflight.reasons);
		const lifetime = createCaseLifetime(config.limits.cleanupSeconds);
		// Only an admitted case may reserve, and only the paid executor reserves for it.
		// A case with any reason is recorded and never started.
		if (!reasons.length) ledger.authorizedCaseIds.push(c.caseId);
		let discoveryLegs: DiscoveryLegReceipt[] = [];
		let paidLegs: PaidLegReceipt[] = [];
		let cleanup = { ownedProcesses: 0, stopped: 0 };
		try {
			// Discovery first: an E07 paid leg runs only after its discovery leg passed.
			if (!reasons.length && c.classes.includes('discovery'))
				discoveryLegs = await executeDiscoveryCase(c, config, {
					workspace: options.workspace,
					operatorHome,
					ledger,
					lifetime,
					problems,
					capabilities,
					now,
					timeoutMs: options.discoveryTimeoutMs,
					resolveSecret: options.resolveSecret,
				});
			const discoveryBlocked = discoveryLegs
				.filter((l) => l.status !== 'passed')
				.map((l) =>
					paidReason('discovery-leg-not-passed', `${l.account}: ${l.status}`, 'GT1-11-11A1')
				);
			if (!reasons.length && c.classes.includes('paid'))
				paidLegs = await executePaidCase(c, config, {
					workspace: options.workspace,
					operatorHome,
					ledger,
					lifetime,
					problems,
					capabilities,
					now,
					turnTimeoutMs: options.paidTurnTimeoutMs,
					resolveSecret: options.resolveSecret,
					precondition: discoveryBlocked,
				});
		} finally {
			cleanup = await lifetime.cleanup();
		}
		// The pinned binary must be byte-identical after the case as before it.
		if (
			preflight?.binary.state === 'local' &&
			preflight.binary.sha256Before &&
			config.binary.path
		) {
			preflight.binary.sha256After = inspectExecutable(
				path.resolve(options.workspace, config.binary.path)
			).sha256;
			if (preflight.binary.sha256After !== preflight.binary.sha256Before) {
				const changed = preflightReason('binary-changed-during-case', 'binary.path');
				preflight.reasons.push(changed);
				preflight.status = 'not-run';
				reasons.push(changed);
			}
		}
		const paid = c.classes.includes('paid');
		const plan = paid && capabilities.atomicSpendAdmission ? planCaseReservation(c, config) : null;
		const held = ledger.reservations.filter((r) => r.caseId === c.caseId);
		receipts.push({
			...c,
			status: reasons.length ? 'not-run' : 'admitted',
			reasons,
			spawned:
				discoveryLegs.reduce((n, l) => n + l.spawned, 0) +
				paidLegs.reduce((n, l) => n + l.spawned, 0),
			paidRequests: paidLegs.reduce((n, l) => n + l.paidRequests, 0),
			// A lower bound: each request a running child was handed may reach the provider.
			networkContacts:
				discoveryLegs.reduce((n, l) => n + l.networkContacts, 0) +
				paidLegs.reduce((n, l) => n + l.paidRequests, 0),
			pricing: c.classes.includes('paid') ? config.allowedModels.map(pricingProvenance) : [],
			budget: {
				reservedUsd: held.reduce((s, r) => s + (r.state === 'held' ? r.holdUsd : 0), 0),
				settledUsd: held.reduce((s, r) => s + r.settledUsd, 0),
				uncertainUsd: held.reduce((s, r) => s + r.uncertainUsd, 0),
				calls: held.reduce((s, r) => s + r.callsUsed, 0),
				plan,
				reservations: held.map((r) => ({ ...r })),
			},
			cleanup,
			candidateSnapshot: buildCandidateSnapshot(c, config),
			preflight,
			offlineLeg,
			resolutionLeg,
			discoveryLegs,
			paidLegs,
		});
	}
	const productionDigestAfter = productionCapabilityDigest();
	// A candidate is a copy; a changed production entry means something wrote the registry.
	if (productionDigestAfter !== productionDigestBefore)
		throw new Error('Production Grok capability registry changed during a qualification run');

	const receipt: QualificationReceipt = redactDeep({
		schema: RECEIPT_SCHEMA,
		contract: ENVIRONMENT_CONTRACT,
		runId,
		startedAt,
		finishedAt: now().toISOString(),
		configSource: options.config ? 'file' : 'default-run-state',
		configDigest: createHash('sha256').update(canonicalJson(config)).digest('hex'),
		configProblems: problems,
		capabilities,
		ledger,
		candidateCapabilities: {
			schema: CANDIDATE_SNAPSHOT_SCHEMA,
			productionDigestBefore,
			productionDigestAfter,
			candidates: CANDIDATE_CAPABILITIES.map((x) => ({ ...x })),
			nonCandidates: NON_CANDIDATE_CAPABILITIES,
			snapshots: receipts.filter((r) => r.candidateSnapshot).length,
		},
		isolationContract: {
			schema: PREFLIGHT_SCHEMA,
			requiredControls: Object.keys(GROK_CONTROL_ENV),
			offlineProbes: Object.keys(OFFLINE_PROBES),
			discoveryOperations: Object.keys(DISCOVERY_OPERATIONS),
		},
		totals: {
			cases: receipts.length,
			admitted: receipts.filter((r) => r.status === 'admitted').length,
			notRun: receipts.filter((r) => r.status === 'not-run').length,
			spawned: receipts.reduce((n, r) => n + r.spawned + (r.offlineLeg?.spawned ?? 0), 0),
			paidRequests: receipts.reduce((n, r) => n + r.paidRequests, 0),
			networkContacts: receipts.reduce((n, r) => n + r.networkContacts, 0),
		},
		cases: receipts,
	});

	let receiptPath: string | null = null;
	if (options.write) {
		const dir = createOwnedRunDir(options.workspace, runId);
		receiptPath = path.join(dir, 'receipt.json');
		fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, '\t')}\n`, {
			mode: 0o600,
			flag: 'wx',
		});
	}
	return { receipt, receiptPath };
}

/** Read a configuration file from inside the checkout's runs root. */
export function readConfigFile(workspace: string, file: string): QualificationConfig {
	const resolved = fs.realpathSync(path.resolve(workspace, file)).replace(/\\/g, '/');
	const root = path.join(fs.realpathSync(workspace), RUNS_ROOT).replace(/\\/g, '/');
	if (!isPathAtOrUnderRoot(resolved, root))
		throw new Error(`Qualification config must live under ${RUNS_ROOT}`);
	return JSON.parse(fs.readFileSync(resolved, 'utf8')) as QualificationConfig;
}

/** CLI entry: `--config <file>`, `--cases E01,E03:acp-stdio:local`, `--json`, `--no-write`. */
export async function main(workspace: string, argv: string[]): Promise<number> {
	const value = (flag: string) => {
		const i = argv.indexOf(flag);
		return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
	};
	const runState = JSON.parse(
		fs.readFileSync(path.join(workspace, 'Plans/grok-tier1/run-state.json'), 'utf8')
	);
	const configFile = value('--config');
	const config = configFile ? readConfigFile(workspace, configFile) : undefined;
	const selectedCases = (value('--cases') ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
	const { receipt, receiptPath } = await runQualification({
		workspace,
		runState,
		config,
		selectedCases,
		write: !argv.includes('--no-write'),
	});
	if (argv.includes('--json')) process.stdout.write(`${JSON.stringify(receipt, null, '\t')}\n`);
	else {
		const t = receipt.totals;
		process.stdout.write(
			`grok qualification ${receipt.runId}: ${t.cases} cases, ${t.admitted} admitted, ${t.notRun} not-run, ` +
				`${t.spawned} spawned, ${t.paidRequests} paid requests, ${t.networkContacts} network contacts\n` +
				(receiptPath ? `receipt: ${path.relative(workspace, receiptPath)}\n` : '')
		);
	}
	return 0;
}
