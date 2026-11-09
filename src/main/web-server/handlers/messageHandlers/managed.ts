/**
 * Managed operation WebSocket message handlers (MRC2-07-03).
 *
 * Handles: managed_status, managed_inventory, managed_support_matrix,
 * managed_locks, managed_policy_refresh, managed_enroll_request,
 * managed_inbox_list, managed_inbox_act, managed_command,
 * managed_command_status, managed_run. Every one is answered from the one facade the
 * Settings > Environment pane and the `enterprise:*` IPC handlers read as
 * well, `EnterpriseService.managed` (`createManagedOperations()` in
 * `src/main/enterprise/service.ts`), so `maestro-cli managed` says the same
 * sentence the pane shows. The reply is `<type>_result` with `success` and
 * one named field; a desktop with no service, a refused input or a service
 * fault is `success: false` with the sentence and never a value.
 *
 * Who may send what: a signed-in browser (web-desktop, Lite) reads the
 * standing, the inventory, the locks and the inbox, and records a receipt on a
 * held notice. An enrollment request, a policy refresh and a typed runtime
 * command are the CLI's alone (`client.cli`, the host secret on this machine):
 * a browser never enrolls, and enrollment, identity custody and credential
 * operations stay absent from the remote surface by design.
 *
 * An inbox act is attributed to the caller the dispatch runs as (MRC-08-01):
 * the dispatcher establishes the acting user and the transport before this
 * handler runs, the facade resolves the actor from that context and refuses
 * a paired device that no registered enterprise actor stands behind, and the
 * reply names the actor so the caller sees whose receipt it was.
 */

import {
	answerManagedCommunication,
	managedMessageId,
	type ManagedOperations,
} from '../../../enterprise/service';
import { isManagedCommunicationType } from '../../../../shared/maestro-lib/runtime/server-requests';
import { validateEnrollmentRequest } from '../../../ipc/handlers/enterprise';
import { logger } from '../../../utils/logger';
import { LOG_CONTEXT } from './shared';
import type { WebClient, WebClientMessage, MessageHandlerContext } from './types';

/** The message types this module answers; the dispatcher routes exactly these here. */
export const MANAGED_MESSAGE_TYPES = [
	'managed_status',
	'managed_inventory',
	'managed_support_matrix',
	'managed_locks',
	'managed_policy_refresh',
	'managed_enroll_request',
	'managed_inbox_list',
	'managed_inbox_act',
	'managed_command',
	'managed_command_status',
	'managed_run',
] as const;
export type ManagedMessageType = (typeof MANAGED_MESSAGE_TYPES)[number];

/** The writes a browser never sends: enrollment, the lifecycle's policy refresh and a runtime command. */
export const MANAGED_CLI_ONLY_TYPES: readonly ManagedMessageType[] = [
	'managed_enroll_request',
	'managed_policy_refresh',
	'managed_command',
];

export const NO_MANAGED_SERVICE_MESSAGE =
	'The enterprise enrollment service is not running in this desktop.';
export const MANAGED_CLI_ONLY_MESSAGE =
	'This managed operation is taken from maestro-cli only; a browser cannot send it.';

export function isManagedMessageType(type: string): type is ManagedMessageType {
	return (MANAGED_MESSAGE_TYPES as readonly string[]).includes(type);
}

/**
 * The typed command a `managed_command` names. Lives beside the shared communications answer in
 * `src/main/enterprise/service.ts` (Electron-free, so a detached host serves it too); re-exported
 * here for the callers that import it from the bridge.
 */
export { validateLocalCommand } from '../../../enterprise/service';

async function answer(
	managed: ManagedOperations,
	message: WebClientMessage
): Promise<Record<string, unknown>> {
	// The inbox and command verbs answer from the one implementation a detached host serves too
	// (MCOMP-29-03A), so `maestro-cli managed inbox|command` reads the same reply from either.
	if (isManagedCommunicationType(message.type)) {
		return answerManagedCommunication(managed, message.type, message, {
			log: (line) => logger.info(`[Web] ${line}`, LOG_CONTEXT),
		});
	}
	switch (message.type as ManagedMessageType) {
		case 'managed_status':
			return { state: managed.status() };
		case 'managed_inventory':
			return { inventory: managed.inventory() };
		case 'managed_support_matrix':
			return { matrix: managed.supportMatrix() };
		case 'managed_locks':
			return { locks: managed.locks() };
		case 'managed_policy_refresh':
			return { outcome: await managed.refreshPolicy() };
		case 'managed_enroll_request':
			// The one secret-carrying input: validated by name, relayed once, never echoed.
			return {
				outcome: await managed.requestEnrollment(validateEnrollmentRequest(message.request)),
			};
		case 'managed_run': {
			const leaseId = managedMessageId(message.leaseId, 'leaseId');
			const run = managed.run(leaseId);
			if (!run) throw new Error(`Lease ${leaseId} is not in this host's dispatch ledger.`);
			return { run };
		}
	}
	throw new Error(`Unknown managed message ${message.type}.`);
}

/**
 * Answer one managed message with `<type>_result`. A refused input names the
 * field and never its value; a thrown service fault is reported the same way,
 * as the CLI's `askDesktop()` expects (`success: false` with the sentence).
 */
export async function handleManagedMessage(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	const type = `${message.type}_result`;
	const reply = (payload: Record<string, unknown>) =>
		ctx.send(client, { type, requestId: message.requestId, ...payload });
	if (MANAGED_CLI_ONLY_TYPES.includes(message.type as ManagedMessageType) && client.cli !== true) {
		reply({ success: false, error: MANAGED_CLI_ONLY_MESSAGE });
		return;
	}
	const managed = ctx.callbacks.getManaged?.() ?? null;
	if (!managed) {
		reply({ success: false, error: NO_MANAGED_SERVICE_MESSAGE });
		return;
	}
	try {
		reply({ success: true, ...(await answer(managed, message)) });
	} catch (error) {
		reply({ success: false, error: error instanceof Error ? error.message : String(error) });
	}
}
