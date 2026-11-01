/**
 * Grok qualification harness (`grok-acceptance-environment/v1`, GT1-11-08).
 *
 * Composition only: it reads an explicit run configuration, expands the
 * E01-E12 case families recorded in `Plans/grok-tier1/run-state.json`
 * (`testEnvironment.cases`) over route and target, decides admission for each
 * case and writes one structured receipt per run. It never reads a credential,
 * never contacts an endpoint and never spawns a provider. A case is only ever
 * handed to an executor after every admission input is present AND every
 * harness capability it needs is implemented; the atomic spend admission
 * (GT1-11-08C) and the case executor are not yet, so every case that would
 * touch a paid model records `not-run` with machine-readable reasons. Default
 * execution, with no configuration, therefore makes zero paid requests and
 * zero network contacts.
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
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
	DEFAULT_MODEL_PRICING,
	MODEL_PRICING,
	normalizeModelId,
	resolveModelPricing,
} from '../../src/shared/modelPricing';
import { redactSecrets } from '../../src/shared/redactSecrets';
import { containsCredentialToken } from '../../src/shared/agent-run/redact';
import { isValidSecretName } from '../../src/shared/serverSecrets';
import { isPathAtOrUnderRoot } from '../../src/shared/worktreePaths';
import { stopProcess } from '../../src/shared/maestro-lib/control/termination';
import { getAgentCapabilities } from '../../src/shared/maestro-lib/providers/capabilities';
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
	atomicSpendAdmission: false,
	/** A case executor bound to the admitted tuple (later VERIFY owners). */
	caseExecutor: false,
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
		| { kind: 'provider-cap'; reference: string; capUsd: number }
		| null;
	limits: QualificationLimits;
	cases: string[];
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
		| 'isolation-preflight';
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
	budget: { reservedUsd: number; settledUsd: number; uncertainUsd: number; calls: number };
	cleanup: { ownedProcesses: number; stopped: number };
	/** Harness-only candidate capabilities for this case; never production availability. */
	candidateSnapshot: CandidateCapabilitySnapshot | null;
	/** Pre-spawn isolation and discovery preflight; null when the case needs no binary. */
	preflight: PreflightResult | null;
}

export interface BudgetLedger {
	/** One ledger per run, shared by every case and every authorized provider. */
	readonly key: string;
	readonly limitUsd: number;
	readonly limitCalls: number;
	reservedUsd: number;
	settledUsd: number;
	/** Charges that may have happened; never refunded, never read as zero. */
	uncertainUsd: number;
	calls: number;
	byProvider: Record<string, { reservedUsd: number; settledUsd: number; uncertainUsd: number }>;
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

export function createBudgetLedger(config: QualificationConfig, runId: string): BudgetLedger {
	const byProvider: BudgetLedger['byProvider'] = {};
	for (const p of config.providers)
		byProvider[p] = { reservedUsd: 0, settledUsd: 0, uncertainUsd: 0 };
	return {
		key: `ledger:${runId}`,
		limitUsd: positiveFinite(config.limits.budgetUsd) ? config.limits.budgetUsd : 0,
		limitCalls: positiveFinite(config.limits.maxCalls) ? config.limits.maxCalls : 0,
		reservedUsd: 0,
		settledUsd: 0,
		uncertainUsd: 0,
		calls: 0,
		byProvider,
	};
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
		if (!capabilities.atomicSpendAdmission)
			add({
				id: 'spend-admission-unimplemented',
				kind: 'harness-capability',
				detail: 'atomic shared reservation or provider-cap admission',
				owner: 'GT1-11-08C',
			});
	}
	if (!capabilities.caseExecutor)
		add({
			id: 'case-executor-unimplemented',
			kind: 'harness-capability',
			detail: 'no executor is bound to an admitted tuple yet',
			owner: 'GT1-11-10',
		});
	return reasons;
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
	const ledger = createBudgetLedger(config, runId);
	const productionDigestBefore = productionCapabilityDigest();
	const operatorHome = options.operatorHome ?? os.homedir();

	const receipts: CaseReceipt[] = [];
	for (const c of cases) {
		const reasons = admitCase(c, config, problems, capabilities, now());
		const needsBinary = c.classes.some((k) => k !== 'deterministic');
		// Pre-spawn: every binary case is held to the isolation preflight first.
		const preflight =
			needsBinary && capabilities.isolationPreflight
				? preflightCase(c, config, { workspace: options.workspace, operatorHome })
				: null;
		if (preflight) reasons.push(...preflight.reasons);
		const lifetime = createCaseLifetime(config.limits.cleanupSeconds);
		// No executor exists yet: an admitted case would be handed to one here.
		// A case with any reason is recorded and never started.
		const cleanup = await lifetime.cleanup();
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
		receipts.push({
			...c,
			status: reasons.length ? 'not-run' : 'admitted',
			reasons,
			spawned: 0,
			paidRequests: 0,
			networkContacts: 0,
			pricing: c.classes.includes('paid') ? config.allowedModels.map(pricingProvenance) : [],
			budget: { reservedUsd: 0, settledUsd: 0, uncertainUsd: 0, calls: 0 },
			cleanup,
			candidateSnapshot: buildCandidateSnapshot(c, config),
			preflight,
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
			spawned: 0,
			paidRequests: 0,
			networkContacts: 0,
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
