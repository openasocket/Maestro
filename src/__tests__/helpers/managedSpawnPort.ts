/**
 * Test doubles for the managed spawn authority a `ProcessManager` admits with
 * (`ProcessSpawnAuthorityPort`) and for the per-effect authority a managed
 * turn asks (`ManagedEffectAuthority`). The lease authority is the REAL
 * `createLocalHostAuthority` with an injected policy table, and the context
 * verifier is the real `createContextVerifier`, so what these prove is the
 * sink's behavior against the real lease lifetime; only the policy answer is
 * a table. Declared doubles, labeled as such.
 */

import {
	createContextVerifier,
	createLocalHostAuthority,
	type AdmissionRequest,
	type HostAuthority,
	type PolicyDecision,
} from '../../shared/maestro-lib/managed/authority';
import type {
	ManagedEffect,
	ManagedEffectAuthority,
	ManagedEffectBinding,
	ManagedEffectDecision,
} from '../../shared/maestro-lib/managed/effects';
import {
	MANAGED_CONTRACT_VERSION,
	type ManagedOperationContext,
} from '../../shared/maestro-lib/managed/types';
import type {
	ProcessSpawnAdmission,
	ProcessSpawnAuthorityPort,
} from '../../main/process-manager/types';

export interface FakeSpawnPortOptions {
	standing?: 'standalone' | 'managed';
	/** The policy table. Default: allow at revision 1. */
	decide?: (request: AdmissionRequest) => PolicyDecision | Promise<PolicyDecision>;
	/** The effect authority the port exposes; `null` leaves it absent. */
	effects?: ManagedEffectAuthority | null;
	/** Problems the verifier raises against a context; default none. */
	accept?: (context: ManagedOperationContext) => string[];
	now?: () => number;
	leaseTtlMs?: number;
}

export interface FakeSpawnPort extends ProcessSpawnAuthorityPort {
	readonly authority: HostAuthority;
	/** Every admission the policy table was asked for, in order. */
	readonly asked: AdmissionRequest[];
	/** Flip the standing between tests (an enrollment appearing or going away). */
	setStanding(standing: 'standalone' | 'managed'): void;
}

export function fakeSpawnPort(options: FakeSpawnPortOptions = {}): FakeSpawnPort {
	const now = options.now ?? (() => 1_000_000);
	let standing = options.standing ?? 'managed';
	let leases = 0;
	const asked: AdmissionRequest[] = [];
	const verifier = createContextVerifier({
		verifierId: 'test-port',
		peer: 'in-process',
		now,
		accept: options.accept ?? (() => []),
	});
	const authority = createLocalHostAuthority({
		authorityId: 'test-authority',
		decide: (request) => {
			asked.push(request);
			return options.decide ? options.decide(request) : { decision: 'allow', policyRevision: 1 };
		},
		now,
		newId: () => `lease-${++leases}`,
		...(options.leaseTtlMs !== undefined ? { leaseTtlMs: options.leaseTtlMs } : {}),
	});
	return {
		standing: () => standing,
		setStanding: (next) => {
			standing = next;
		},
		authority,
		asked,
		policy: () => ({ sources: [], policyRevision: 1 }),
		...(options.effects ? { effects: options.effects } : {}),
		verify: (input) =>
			verifier.verify({
				contractVersion: MANAGED_CONTRACT_VERSION,
				installation: { installationId: 'inst-test', runtimeId: 'desktop-1', processEpoch: 'e1' },
				origin: 'desktop',
				actor: { kind: 'human', id: 'ada' },
				delegation: input.delegation ?? {
					chain:
						input.actor.peer === 'web-login'
							? [{ kind: 'human', id: `web-login:${input.actor.username}` }]
							: [],
					grantRef: null,
				},
				identity: input.identity,
				policyRevision: input.policyRevision,
				workflow: input.workflow,
				traceId: input.traceId,
				requestedCapabilities: ['runs.submit'],
			}),
	};
}

export interface TableEffects extends ManagedEffectAuthority {
	/** Every effect the authority was asked about, with its binding. */
	readonly asked: Array<{ effect: ManagedEffect; binding: ManagedEffectBinding }>;
}

/** An effect authority answering from a table (or a promise, for a pending decision). */
export function tableEffects(
	table: (
		effect: ManagedEffect,
		binding: ManagedEffectBinding,
		signal: AbortSignal
	) => ManagedEffectDecision | Promise<ManagedEffectDecision>
): TableEffects {
	const asked: TableEffects['asked'] = [];
	return {
		authorityId: 'test-effects',
		asked,
		decide(effect, binding, signal) {
			asked.push({ effect, binding });
			return table(effect, binding, signal);
		},
	};
}

/**
 * A plain admission object for a spawner-level test. The spawners read its
 * fields only; the process manager is what binds a real lease behind one, so
 * at the manager's sink this object is a look-alike and is refused as forged.
 */
export function fakeAdmission(
	overrides: Partial<ProcessSpawnAdmission> = {}
): ProcessSpawnAdmission {
	return Object.freeze<ProcessSpawnAdmission>({
		leaseId: 'lease-test',
		authorityId: 'test-authority',
		requestDigest: 'a'.repeat(64),
		actor: { kind: 'human', id: 'ada' },
		provider: 'codex',
		operation: 'start',
		target: { kind: 'local' },
		policyRevision: 1,
		requestId: 'req-test',
		attemptId: 'att-test',
		...overrides,
	});
}
