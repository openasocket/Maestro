/**
 * The v2 `command` delivery builder shared by the command tests: a typed command
 * in the endpoint's shape (`typedCommand`), the `commandRequestV2` envelope it
 * travels in with its correlation (`wireOf`), and the negotiation a v2 attachment
 * reports (`NEGOTIATED_V2`). Ids are stable UUIDs derived from labels, because
 * the pinned `@mega-maestro/contracts` schemas require UUIDs for every id the
 * wire carries. Every default can be overridden per test, so a file whose
 * standing uses its own ids passes them in. Test-only; nothing here is authority.
 */

import { createHash } from 'node:crypto';

import { COMMAND_CORRELATION_FEATURE } from '../../../main/enterprise/commands';
import {
	ENDPOINT_COMMAND_ACTIONS,
	type ManagedRuntimeCommand,
} from '../../../shared/maestro-lib/managed/commands';
import { DIGEST_A, INSTALLATION, NOW, runtimeCommand } from './fakeManaged';

/** A stable UUID for a label. */
export function uuidOf(label: string): string {
	const h = createHash('sha256').update(label).digest('hex');
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** A 64-hex nonce for a label. */
export const nonceOf = (label: string) =>
	createHash('sha256').update(`nonce:${label}`).digest('hex');

/** The ids a standing with a registration carries by default (the standing a test builds must match). */
export const CONTRACT_IDS = {
	tenantId: uuidOf('tenant'),
	enrollmentId: uuidOf('enrollment'),
	actorId: uuidOf('actor'),
	challengeId: uuidOf('challenge'),
	orgId: uuidOf('org'),
	issuerId: uuidOf('issuer'),
	runId: uuidOf('run-1'),
} as const;

export const ENVELOPE_DIGEST = 'f'.repeat(64);

/** What a v2 attachment reports for commands: protocol 2 with the correlation feature. */
export const NEGOTIATED_V2 = () => ({ protocol: 2, features: [COMMAND_CORRELATION_FEATURE] });

export const DEFAULT_RECIPIENT: ManagedRuntimeCommand['recipient'] = {
	actorId: CONTRACT_IDS.actorId,
	enrollmentId: CONTRACT_IDS.enrollmentId,
	installationId: INSTALLATION.installationId,
	runtimeId: INSTALLATION.runtimeId,
	processEpoch: INSTALLATION.processEpoch,
	runId: CONTRACT_IDS.runId,
};

export interface TypedOver extends Partial<
	Omit<ManagedRuntimeCommand, 'recipient' | 'preconditions'>
> {
	recipient?: Partial<ManagedRuntimeCommand['recipient']>;
	preconditions?: Partial<ManagedRuntimeCommand['preconditions']>;
}

/**
 * A typed command in the endpoint's shape on run `CONTRACT_IDS.runId`, a cancel by default. Its
 * capability is `command-<action>` for the action it names, and its id, nonce and key come from
 * `label`, so a second command under another label never collides.
 */
export function typedCommand(label: string, over: TypedOver = {}): ManagedRuntimeCommand {
	const { recipient, preconditions, ...rest } = over;
	const action = rest.action ?? { kind: 'cancel-run' };
	return runtimeCommand({
		commandId: uuidOf(label),
		tenantId: CONTRACT_IDS.tenantId,
		issuerId: CONTRACT_IDS.issuerId,
		nonce: nonceOf(label),
		idempotencyKey: `idem-${label}`,
		...rest,
		action,
		recipient: { ...DEFAULT_RECIPIENT, ...recipient },
		preconditions: {
			policyRevision: 3,
			requiredCapability: `command-${ENDPOINT_COMMAND_ACTIONS[action.kind]}`,
			policyDigest: null,
			bindingDigest: null,
			...preconditions,
		},
	});
}

/** A typed command of `kind` on the default run, with that kind's capability. */
export const runCommand = (label: string, kind: 'pause-run' | 'resume-run' | 'cancel-run') =>
	typedCommand(label, { action: { kind } });

/** An operator prompt on the default run, approved under its own approval bound to the payload. */
export const operatorPromptOf = (label = 'cmd-p') =>
	typedCommand(label, {
		action: { kind: 'operator-prompt', text: 'say hi', agentInput: true },
		approval: {
			kind: 'approved',
			approvalId: uuidOf('apr-1'),
			approverId: uuidOf('approver-1'),
			payloadDigest: DIGEST_A,
			expiresAt: new Date(NOW + 60_000).toISOString(),
		},
	});

/** The per-delivery knobs of `wireOf`. */
export interface WireOver {
	/** The registration challenge the delivery addresses (the standing's own, by default). */
	challengeId?: string;
	envelope?: string;
	/** Replaces the wire action outright (an untyped action, for a refusal test). */
	action?: unknown;
}

/** The v2 `commandRequestV2` a typed command travels as: the endpoint's envelope plus its correlation. */
export function wireOf(typed: ManagedRuntimeCommand, over: WireOver = {}) {
	const r = typed.recipient;
	const a = typed.approval;
	const action =
		over.action ??
		(typed.action.kind === 'operator-prompt'
			? { kind: 'operator_prompt', text: typed.action.text, agentInput: true }
			: { kind: ENDPOINT_COMMAND_ACTIONS[typed.action.kind] });
	const approval =
		a.kind === 'approved'
			? {
					kind: 'approved',
					approvalId: a.approvalId,
					approverId: a.approverId,
					payloadDigest: a.payloadDigest,
					expiresAt: a.expiresAt,
				}
			: { kind: 'policy_not_required', policyRevision: a.policyRevision };
	return {
		command: {
			payload: {
				schemaVersion: 1,
				commandId: typed.commandId,
				tenantId: typed.tenantId,
				issuerId: typed.issuerId,
				recipient: {
					actorId: r.actorId,
					enrollmentId: r.enrollmentId,
					installationId: r.installationId,
					runtimeId: r.runtimeId,
					processEpoch: r.processEpoch,
					runId: r.runId,
					scope: { kind: 'tenant' },
				},
				action,
				preconditions: {
					policyRevision: typed.preconditions.policyRevision,
					policyDigest: DIGEST_A,
					bindingDigest: DIGEST_A,
					requiredCapability: typed.preconditions.requiredCapability,
				},
				issuedAt: typed.issuedAt,
				expiresAt: typed.expiresAt,
				nonce: typed.nonce,
				idempotencyKey: typed.idempotencyKey,
			},
			payloadDigest: typed.payloadDigest,
			approval,
			keyId: 'key-1',
			algorithm: 'Ed25519',
			signature: 'A'.repeat(86) + '==',
		},
		correlation: {
			registration: {
				version: 2,
				purpose: 'runtime_use',
				tenantId: typed.tenantId,
				orgId: CONTRACT_IDS.orgId,
				enrollmentId: r.enrollmentId,
				installationId: r.installationId,
				runtimeId: r.runtimeId,
				processEpoch: r.processEpoch,
				bindingDigest: DIGEST_A,
				processBirthDigest: DIGEST_A,
				challengeId: over.challengeId ?? CONTRACT_IDS.challengeId,
				challengeDigest: 'c'.repeat(64),
			},
			delegation: null,
			grants: [],
			requestId: `req-${typed.commandId}`,
			attemptId: `att-${typed.commandId}`,
			envelopeDigest: over.envelope ?? ENVELOPE_DIGEST,
		},
	};
}
export type WireRequest = ReturnType<typeof wireOf>;
