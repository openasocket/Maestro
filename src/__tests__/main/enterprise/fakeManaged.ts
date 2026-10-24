/**
 * Shared fixtures for the managed-desktop (Mega-Maestro) tests: an enrolled
 * identity record, the registered standing the lifecycle reports, typed runtime
 * commands in the endpoint's shape, and an admission a real local authority
 * admits. Deterministic (one clock, fixed ids) and inert: nothing here is
 * authority, a key or a socket. `fakeCustody.ts` holds the seal and anchor
 * doubles and `fakeEndpoint.ts` the daemon; this file holds the VALUES.
 */

import {
	buildDispatchSnapshot,
	createContextVerifier,
	type AdmissionRequest,
} from '../../../shared/maestro-lib/managed/authority';
import type { ManagedRuntimeCommand } from '../../../shared/maestro-lib/managed/commands';
import type {
	ManagedEnrollmentStatus,
	ManagedIdentityRecord,
} from '../../../shared/maestro-lib/managed/endpoint-port';
import { inProcessContext } from '../../../shared/maestro-lib/managed/operations';

/** The one clock every fixture is stamped by. */
export const NOW = Date.parse('2026-10-23T12:00:00.000Z');
export const INSTALLATION = {
	installationId: 'inst-1',
	runtimeId: 'desktop-100',
	processEpoch: 'epoch-1',
};
export const DIGEST_A = 'a'.repeat(64);

/** An enrolled record whose live registration names `actorId` (null is Maestro's record today, CP-01/CP-04). */
export function managedRecord(
	actorId: string | null,
	over: Partial<ManagedIdentityRecord> = {}
): ManagedIdentityRecord {
	return {
		version: 1,
		installationId: 'inst-1',
		tenantId: 'tenant-1',
		orgId: 'org-1',
		enrollmentId: 'enr-1',
		endpoint: { socketPath: '/nowhere.sock', bindingDigest: DIGEST_A, trustRootDigest: null },
		management: 'enrolled',
		registration: {
			challengeId: 'ch-1',
			actorId,
			runtimeId: 'desktop-100',
			processEpoch: 'epoch-1',
			bindingDigest: DIGEST_A,
			processBirthDigest: null,
			challengeDigest: 'c'.repeat(64),
			expiresAt: new Date(NOW + 3_600_000).toISOString(),
			registeredAt: new Date(NOW - 60_000).toISOString(),
		},
		policy: { desiredRevision: 3, appliedRevision: 3, observedAt: new Date(NOW).toISOString() },
		enrolledAt: new Date(NOW).toISOString(),
		updatedAt: new Date(NOW).toISOString(),
		...over,
	};
}

/** The knobs of a registered standing a test turns between checks. */
export interface ManagedStandingInput {
	actorId: string | null;
	/** The revision the endpoint applies (the record and the status agree); 3 is desired. */
	applied: number;
	authority: ManagedEnrollmentStatus['authority'];
	reason: string | null;
	capabilities: string[];
}

export const REGISTERED_STANDING: ManagedStandingInput = {
	actorId: 'actor-1',
	applied: 3,
	authority: 'registered',
	reason: null,
	capabilities: ['execution', 'command', 'inbox', 'noticeList'],
};

/** The enrollment status of an attached, registered, managed desktop. */
export function registeredStatus(
	input: Partial<ManagedStandingInput> = {}
): ManagedEnrollmentStatus {
	const s = { ...REGISTERED_STANDING, ...input };
	const record = managedRecord(s.actorId);
	record.policy.appliedRevision = s.applied;
	return {
		identity: { status: 'ok', reason: null, message: null, record },
		connection: {
			connection: 1,
			attached: true,
			registration: 'registered',
			closed: false,
			status: null,
		},
		endpoint: {
			outcome: 'attached',
			protocol: 1,
			capabilities: s.capabilities,
			management: 'managed',
			desiredPolicyRevision: 3,
			appliedPolicyRevision: s.applied,
			connectivity: 'online',
			collectionProfile: 'metadata',
		},
		authority: s.authority,
		reason: s.reason,
		pendingApproval: null,
		lastDenial: null,
	};
}

/** A cancel of run-1 as the endpoint signs it for this installation, process and actor. */
export function runtimeCommand(over: Partial<ManagedRuntimeCommand> = {}): ManagedRuntimeCommand {
	return {
		commandId: 'cmd-1',
		tenantId: 'tenant-1',
		issuerId: 'issuer-1',
		recipient: {
			actorId: 'actor-1',
			enrollmentId: 'enr-1',
			installationId: 'inst-1',
			runtimeId: 'desktop-100',
			processEpoch: 'epoch-1',
			runId: 'run-1',
		},
		action: { kind: 'cancel-run' },
		preconditions: {
			policyRevision: 3,
			requiredCapability: 'command-cancel_run',
			policyDigest: null,
			bindingDigest: null,
		},
		approval: { kind: 'policy-not-required', policyRevision: 3 },
		issuedAt: new Date(NOW - 1_000).toISOString(),
		expiresAt: new Date(NOW + 60_000).toISOString(),
		nonce: 'n'.repeat(64),
		idempotencyKey: 'idem-1',
		payloadDigest: DIGEST_A,
		releaseId: null,
		...over,
	};
}
export const COMMAND_RECIPIENT = runtimeCommand().recipient;
export const COMMAND_PRECONDITIONS = runtimeCommand().preconditions;

/** Another command: its own id, nonce and idempotency key. */
export function anotherCommand(
	id: string,
	over: Partial<ManagedRuntimeCommand> = {}
): ManagedRuntimeCommand {
	return runtimeCommand({
		commandId: id,
		nonce: id.repeat(64).slice(0, 64),
		idempotencyKey: `idem-${id}`,
		...over,
	});
}

/** A command on the runtime itself (no run), requiring its own `command-<action>` capability. */
export function runtimeOnlyCommand(
	id: string,
	action: ManagedRuntimeCommand['action']
): ManagedRuntimeCommand {
	return anotherCommand(id, {
		action,
		recipient: { ...COMMAND_RECIPIENT, runId: null },
		preconditions: {
			...COMMAND_PRECONDITIONS,
			requiredCapability: `command-${action.kind.replace('-', '_')}`,
		},
	});
}

/** An operator prompt for run-1 under its own approval bound to the payload. */
export function operatorPromptCommand(): ManagedRuntimeCommand {
	return anotherCommand('cmd-p', {
		action: { kind: 'operator-prompt', text: 'say hi', agentInput: true },
		preconditions: { ...COMMAND_PRECONDITIONS, requiredCapability: 'command-operator_prompt' },
		approval: {
			kind: 'approved',
			approvalId: 'apr-1',
			approverId: 'approver-1',
			payloadDigest: DIGEST_A,
			expiresAt: new Date(NOW + 60_000).toISOString(),
		},
	});
}

/** An in-process admission of `runId` a local authority allows; the snapshot names a path and a model on purpose, so a test can assert neither leaks. */
export function runAdmission(runId: string, requestId: string): AdmissionRequest {
	const verifier = createContextVerifier({
		verifierId: 'test',
		peer: 'in-process',
		now: () => NOW,
		accept: () => [],
	});
	const verified = verifier.verify(
		inProcessContext({
			installation: INSTALLATION,
			actor: { kind: 'human', id: 'ada' },
			delegation: { chain: [], grantRef: null },
			identity: {
				requestId,
				idempotencyKey: `key-${requestId}`,
				attemptId: `att-${requestId}`,
				runId,
				rootRunId: runId,
				parentRunId: null,
			},
			policyRevision: 3,
			workflow: null,
			traceId: 'trace-1',
			requestedCapabilities: ['runs.submit'],
		})
	);
	if (!verified.ok) throw new Error(verified.problems.join('; '));
	return {
		context: verified.context,
		snapshot: buildDispatchSnapshot(
			{ command: '/bin/claude', args: ['--print'], cwd: '/work', env: {} },
			{ provider: 'claude-code', model: 'sonnet', resourceIds: [] }
		),
		policy: { sources: [], policyRevision: 3 },
	};
}
