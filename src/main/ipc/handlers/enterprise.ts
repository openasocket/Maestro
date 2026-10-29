/**
 * Enterprise enrollment IPC: the narrow set of lifecycle and status requests
 * the renderer may make of the main-process enrollment service.
 *
 * Over the web bridge (`src/main/web-server/handlers/bridgeDenyList.ts`) a
 * signed-in browser reaches the managed state, the inventory and the inbox
 * (state, refresh, act) alone (MRC2-07-03); enrollment, registration, the
 * lifecycle writes, custody and clearing are desktop-only by construction.
 * What crosses the bridge is the public projection only
 * (`ManagedEnrollmentStatus`, `ManagedPolicyStatus`, the lifecycle's outcome
 * records): no sealed bytes, no install secret, no anchor, nothing the
 * endpoint holds. The one secret-shaped value is the
 * registration approval (`beginRegistration`), a one-time pairing code the
 * actor must read off the screen and type into the console; it is returned
 * once and never persisted or logged anywhere in main.
 *
 * Every verb is validated here before it reaches the lifecycle, and the
 * lifecycle serializes them, so two renderer windows cannot interleave an
 * enroll and a revoke. `withIpcErrorLogging` re-throws, so a genuine fault
 * still reaches Sentry and the renderer's inline error text is the service's
 * own sentence; a refusal is a normal outcome, not a throw.
 */

import { ipcMain } from 'electron';
import * as path from 'path';

import { isEndpointDigest } from '../../../shared/maestro-lib/managed/endpoint-port';
import type { EndpointInboxAction } from '../../../shared/maestro-lib/managed/host-adapter';
import type { CommandService, CommandServiceStatus } from '../../enterprise/commands';
import type {
	EnrollmentLifecycle,
	EnrollmentRequestInput,
	LifecycleOutcome,
} from '../../enterprise/enrollment';
import type {
	EnterpriseIdentityStore,
	IdentityClearOutcome,
	IdentityCustodyState,
} from '../../enterprise/identity-store';
import {
	inboxActionProblem,
	inboxView,
	type InboxActionOutcome,
	type InboxClient,
	type ManagedInboxView,
} from '../../enterprise/inbox';
import { NO_INBOX_OUTCOME, type ManagedInboxActInput } from '../../enterprise/service';
import {
	localReleaseOf,
	type LocalRelease,
	type ManagedStateView,
} from '../../enterprise/managed-state';
import type { PolicyStatusService } from '../../enterprise/policy-status';
import type { ManagedOperations } from '../../enterprise/service';
import { withIpcErrorLogging } from '../../utils/ipcHandler';

const LOG_CONTEXT = '[Enterprise]';
const MAX_TEXT = 8192;
const MODES = ['attended', 'managed'] as const;
const PROFILES = ['metadata', 'redacted', 'full', 'full_vibes'] as const;

export interface EnterpriseHandlerDependencies {
	getLifecycle: () => EnrollmentLifecycle | null;
	getPolicyStatus: () => PolicyStatusService | null;
	getIdentity: () => EnterpriseIdentityStore | null;
	/**
	 * The managed status surface (`service.ts`, MRC2-07-01): the one implementation
	 * of status, enrollment request, policy refresh and inventory that the bridge
	 * and `maestro-cli managed` call too; null when no service runs.
	 */
	getManaged: () => ManagedOperations | null;
	/** The notice and inbox client (MRC-11-04); null when no service runs. */
	getInbox: () => InboxClient | null;
	/** The typed runtime command service (MRC-11-05); null when no service runs. Read only: nothing here delivers a command. */
	getCommands: () => CommandService | null;
}

function handlerOpts(operation: string) {
	return { context: LOG_CONTEXT, operation };
}

function text(value: unknown, name: string, max = MAX_TEXT): string {
	if (typeof value !== 'string' || value.length === 0 || value.length > max) {
		throw new Error(`${name} must be a string of 1 to ${max} characters.`);
	}
	return value;
}

function oneOf<T extends string>(value: unknown, name: string, allowed: readonly T[]): T {
	if (typeof value !== 'string' || !allowed.includes(value as T)) {
		throw new Error(`${name} must be one of ${allowed.join(', ')}.`);
	}
	return value as T;
}

/** The enrollment request as the renderer may send it; anything else is refused before the lifecycle. */
export function validateEnrollmentRequest(raw: unknown): EnrollmentRequestInput {
	if (typeof raw !== 'object' || raw === null)
		throw new Error('The enrollment request must be an object.');
	const input = raw as Record<string, unknown>;
	const socketPath = text(input.socketPath, 'socketPath', 103);
	if (!path.isAbsolute(socketPath))
		throw new Error('socketPath must be an absolute Unix socket path.');
	const trustRootDigest = text(input.trustRootDigest, 'trustRootDigest', 64);
	if (!isEndpointDigest(trustRootDigest))
		throw new Error('trustRootDigest must be a lowercase sha256 hex digest.');
	return {
		socketPath,
		tenantId: text(input.tenantId, 'tenantId', 128),
		orgId: text(input.orgId, 'orgId', 128),
		mode: oneOf(input.mode, 'mode', MODES),
		invitation: text(input.invitation, 'invitation'),
		collectionProfile: oneOf(input.collectionProfile, 'collectionProfile', PROFILES),
		trustRootDigest,
		keyPossessionProof: text(input.keyPossessionProof, 'keyPossessionProof'),
	};
}

function installationInput(raw: unknown): { installationId: string } {
	if (typeof raw !== 'object' || raw === null)
		throw new Error('The request must name an installation.');
	return {
		installationId: text((raw as Record<string, unknown>).installationId, 'installationId', 256),
	};
}

const NO_SERVICE_MESSAGE = 'The enterprise enrollment service is not running in this desktop.';
const NO_SERVICE: LifecycleOutcome<never> = { status: 'unavailable', message: NO_SERVICE_MESSAGE };
const MAX_ID = 256;

/**
 * One inbox act as the renderer may send it; refused here, by name, before the
 * facade sees it. The campaign is optional: the facade resolves it from the
 * held notices (MRC2-07-02), and refuses an id held under two by name.
 */
export function validateInboxAct(raw: unknown): ManagedInboxActInput {
	if (typeof raw !== 'object' || raw === null) throw new Error('An inbox act must be an object.');
	const input = raw as Record<string, unknown>;
	const problem = inboxActionProblem(input.action);
	if (problem) throw new Error(`action: ${problem}.`);
	return {
		...(input.campaignId === undefined
			? {}
			: { campaignId: text(input.campaignId, 'campaignId', MAX_ID) }),
		messageId: text(input.messageId, 'messageId', MAX_ID),
		action: input.action as EndpointInboxAction,
	};
}

/**
 * The narrow standing a settings pane reads (MRC-11-03), or null without a
 * service. The projection itself lives in `service.ts` (`managed.status()`,
 * MRC2-07-01) so the bridge and the CLI answer with the same sentence.
 */
export function readManagedState(deps: EnterpriseHandlerDependencies): ManagedStateView | null {
	return deps.getManaged()?.status() ?? null;
}

export function registerEnterpriseHandlers(deps: EnterpriseHandlerDependencies): void {
	const lifecycle = () => deps.getLifecycle();
	// Required management is not a local setting: a record the endpoint still
	// manages cannot be retired, revoked or forgotten from this desktop until the
	// endpoint releases it. Read fresh at each verb, never cached.
	const localRelease = (): LocalRelease => {
		const current = lifecycle();
		return current ? localReleaseOf(current.status()) : { allowed: true, reason: 'no-record' };
	};

	ipcMain.handle(
		'enterprise:status',
		withIpcErrorLogging(handlerOpts('status'), async () => lifecycle()?.status() ?? null)
	);

	ipcMain.handle(
		'enterprise:managedState',
		withIpcErrorLogging(handlerOpts('managedState'), async () => readManagedState(deps))
	);

	ipcMain.handle(
		'enterprise:custody',
		withIpcErrorLogging(
			handlerOpts('custody'),
			async (): Promise<IdentityCustodyState | null> => deps.getIdentity()?.custody() ?? null
		)
	);

	ipcMain.handle(
		'enterprise:policyStatus',
		withIpcErrorLogging(
			handlerOpts('policyStatus'),
			async () => deps.getPolicyStatus()?.status() ?? null
		)
	);

	// The local read of what this installation is and can do: versions, standing,
	// routes with detection apart from enforcement, collection health, named gaps.
	// No path, socket or secret is in it (`src/main/enterprise/inventory.ts`).
	ipcMain.handle(
		'enterprise:inventory',
		withIpcErrorLogging(
			handlerOpts('inventory'),
			async () => deps.getManaged()?.inventory() ?? null
		)
	);

	// The notice inbox (MRC-11-04): the held notices with their bodies for the
	// person's surface alone, a listing on request, one receipt per act. The
	// client refuses an act on a notice this host never listed; the endpoint
	// authorizes every effect itself. Null or unavailable until MRC-11-05 composes it.
	ipcMain.handle(
		'enterprise:inboxState',
		withIpcErrorLogging(handlerOpts('inboxState'), async (): Promise<ManagedInboxView | null> => {
			const inbox = deps.getInbox();
			return inbox ? inboxView(inbox) : null;
		})
	);

	ipcMain.handle(
		'enterprise:inboxRefresh',
		withIpcErrorLogging(handlerOpts('inboxRefresh'), async () => deps.getInbox()?.refresh() ?? null)
	);

	// Through the one facade (MRC2-07-03): the standing first, the campaign from
	// the held set, the caller's transport gated (a paired device with no
	// registered actor is refused), then the client. The bridge and the CLI
	// answer from the same function.
	ipcMain.handle(
		'enterprise:inboxAct',
		withIpcErrorLogging(
			handlerOpts('inboxAct'),
			async (raw: unknown): Promise<InboxActionOutcome> => {
				const input = validateInboxAct(raw);
				return deps.getManaged()?.inboxAct(input) ?? NO_INBOX_OUTCOME;
			}
		)
	);

	// The command service's read (MRC-11-05): what this desktop executes and refuses
	// by name, the ledger's counts and whether a command could be decided right now.
	// A read only: no channel delivers a command, and no renderer verb ever will.
	ipcMain.handle(
		'enterprise:commandStatus',
		withIpcErrorLogging(
			handlerOpts('commandStatus'),
			async (): Promise<CommandServiceStatus | null> => deps.getCommands()?.status() ?? null
		)
	);

	ipcMain.handle(
		'enterprise:requestEnrollment',
		withIpcErrorLogging(handlerOpts('requestEnrollment'), async (raw: unknown) => {
			const input = validateEnrollmentRequest(raw);
			return deps.getManaged()?.requestEnrollment(input) ?? NO_SERVICE;
		})
	);

	ipcMain.handle(
		'enterprise:connect',
		withIpcErrorLogging(handlerOpts('connect'), async () => lifecycle()?.connect() ?? NO_SERVICE)
	);

	ipcMain.handle(
		'enterprise:beginRegistration',
		withIpcErrorLogging(
			handlerOpts('beginRegistration'),
			async () => lifecycle()?.beginRegistration() ?? NO_SERVICE
		)
	);

	ipcMain.handle(
		'enterprise:completeRegistration',
		withIpcErrorLogging(
			handlerOpts('completeRegistration'),
			async () => lifecycle()?.completeRegistration() ?? NO_SERVICE
		)
	);

	ipcMain.handle(
		'enterprise:refreshPolicy',
		withIpcErrorLogging(
			handlerOpts('refreshPolicy'),
			async () => deps.getManaged()?.refreshPolicy() ?? NO_SERVICE
		)
	);

	ipcMain.handle(
		'enterprise:recoverPolicy',
		withIpcErrorLogging(
			handlerOpts('recoverPolicy'),
			async () => deps.getPolicyStatus()?.recover() ?? NO_SERVICE
		)
	);

	for (const request of ['requestRotation', 'requestRevocation', 'requestRetirement'] as const) {
		ipcMain.handle(
			`enterprise:${request}`,
			withIpcErrorLogging(handlerOpts(request), async () => lifecycle()?.[request]() ?? NO_SERVICE)
		);
	}

	for (const transition of ['acknowledgeRevocation', 'retire'] as const) {
		ipcMain.handle(
			`enterprise:${transition}`,
			withIpcErrorLogging(handlerOpts(transition), async (raw: unknown) => {
				const input = installationInput(raw);
				const release = localRelease();
				if (!release.allowed) {
					return { status: 'refused', reason: 'management-required', message: release.message };
				}
				return lifecycle()?.[transition](input) ?? NO_SERVICE;
			})
		);
	}

	ipcMain.handle(
		'enterprise:clearIdentity',
		withIpcErrorLogging(
			handlerOpts('clearIdentity'),
			async (raw: unknown): Promise<IdentityClearOutcome> => {
				const identity = deps.getIdentity();
				if (!identity) return { ok: false, reason: 'unprotected', message: NO_SERVICE_MESSAGE };
				const { installationId } = installationInput(raw);
				const acknowledgeUntrusted = (raw as Record<string, unknown>).acknowledgeUntrusted === true;
				const release = localRelease();
				if (!release.allowed) {
					return { ok: false, reason: 'management-required', message: release.message };
				}
				// The lifecycle holds the socket for this record; drop it before the record goes.
				await lifecycle()?.close();
				return identity.clear({ installationId, acknowledgeUntrusted });
			}
		)
	);
}
