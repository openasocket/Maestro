/**
 * Shared fixtures for the managed-desktop (Mega-Maestro) tests: an enrolled
 * identity record, the registered standing the lifecycle reports, typed runtime
 * commands in the endpoint's shape, and an admission a real local authority
 * admits. Deterministic (one clock, fixed ids) and inert: nothing here is
 * authority, a key or a socket. `fakeCustody.ts` holds the seal and anchor
 * doubles and `fakeEndpoint.ts` the daemon; this file holds the VALUES.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach } from 'vitest';

import { createLocalEndpointClient } from '../../../main/enterprise/endpoint-client';
import { createEnrollmentLifecycle } from '../../../main/enterprise/enrollment';
import { createEnterpriseIdentityStore } from '../../../main/enterprise/identity-store';
import { createPolicyStatusService } from '../../../main/enterprise/policy-status';
import type { Anchor } from '../../../main/utils/keyring-anchor';
import {
	buildDispatchSnapshot,
	createContextVerifier,
	type AdmissionRequest,
} from '../../../shared/maestro-lib/managed/authority';
import type { ManagedRuntimeCommand } from '../../../shared/maestro-lib/managed/commands';
import type {
	EndpointPort,
	ManagedEnrollmentStatus,
	ManagedIdentityRecord,
} from '../../../shared/maestro-lib/managed/endpoint-port';
import { createManagedHostAdapter } from '../../../shared/maestro-lib/managed/host-adapter';
import { inProcessContext } from '../../../shared/maestro-lib/managed/operations';
import { fakeAnchor, fakeSeal } from './fakeCustody';

/**
 * Temp directories for one test file: call at module level, use the returned
 * factory inside tests; every directory made is removed after each test.
 */
export function tempDirs(prefix: string): () => string {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
	});
	return () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
		dirs.push(dir);
		return dir;
	};
}

/**
 * The real lifecycle, identity store, policy status service and local client
 * over a fake daemon, registered: the record is written with the daemon's
 * socket and no registration, `recover()` hands the approval back and
 * `completeRegistration()` redeems it. Maestro's record then names no actor
 * (CP-01/CP-04). `host` is the managed host adapter over the live port.
 */
export async function startRegisteredLifecycle(input: {
	dir: string;
	socketPath: string;
	supported: readonly string[];
}) {
	const identity = createEnterpriseIdentityStore({
		file: path.join(input.dir, 'enterprise-identity.bin'),
		seal: fakeSeal(),
		anchor: fakeAnchor({ value: null } as { value: Anchor | null }),
		platform: 'darwin',
		now: () => NOW,
	});
	let port: EndpointPort | null = null;
	const lifecycle = createEnrollmentLifecycle({
		identity,
		openPort: (socketPath) => {
			port = createLocalEndpointClient({ socketPath, timeoutMs: 1_000 });
			return port;
		},
		installation: INSTALLATION,
		components: [{ id: 'maestro', kind: 'maestro', version: '1.1.0-RC' }],
		capabilities: { supported: ['attachment', 'compatibility', ...input.supported], required: [] },
		now: () => NOW,
	});
	const base = managedRecord(null);
	await identity.write({
		...base,
		endpoint: { ...base.endpoint, socketPath: input.socketPath },
		registration: null,
	});
	const policy = createPolicyStatusService({ lifecycle, now: () => NOW });
	const recovered = await policy.recover();
	if (recovered.status !== 'approval-required') throw new Error(recovered.status);
	const completed = await lifecycle.completeRegistration();
	if (completed.status !== 'ok') throw new Error(completed.status);
	const host = createManagedHostAdapter({
		installation: INSTALLATION,
		identity: { read: () => lifecycle.status().identity },
		get endpoint() {
			return port;
		},
		status: () => lifecycle.status(),
		now: () => NOW,
	});
	return { identity, lifecycle, policy, host };
}

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
