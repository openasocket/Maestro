/**
 * Managed operation WebSocket message handlers (MRC2-07-03).
 *
 * Handles: managed_status, managed_inventory, managed_support_matrix,
 * managed_locks, managed_policy_refresh, managed_enroll_request,
 * managed_inbox_list, managed_inbox_act, managed_command,
 * managed_command_status. Every one is answered from the one facade the
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

import { inboxActionProblem } from '../../../enterprise/inbox';
import type { LocalCommandAction } from '../../../enterprise/commands';
import type { ManagedOperations } from '../../../enterprise/service';
import { validateEnrollmentRequest } from '../../../ipc/handlers/enterprise';
import { logger } from '../../../utils/logger';
import { getActingUser } from '../../auth/acting-user';
import {
	describeSpawnActor,
	getActingTransport,
	transportSpawnActor,
} from '../../auth/transport-actor';
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
const NO_INBOX_MESSAGE = 'No notice inbox is composed in this desktop.';
const NO_COMMANDS_MESSAGE = 'No command service is composed in this desktop.';
const MAX_ID = 256;

export function isManagedMessageType(type: string): type is ManagedMessageType {
	return (MANAGED_MESSAGE_TYPES as readonly string[]).includes(type);
}

function id(value: unknown, name: string): string {
	if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ID) {
		throw new Error(`${name} must be a string of 1 to ${MAX_ID} characters.`);
	}
	return value;
}

/** A local command as the CLI sends it; anything else is refused by name before the service sees it. */
export function validateLocalCommand(raw: unknown): LocalCommandAction {
	if (typeof raw !== 'object' || raw === null) throw new Error('action must be an object.');
	const input = raw as Record<string, unknown>;
	switch (input.kind) {
		case 'cancel-run':
			return { kind: 'cancel-run', runId: id(input.runId, 'action.runId') };
		case 'report-status':
			return { kind: 'report-status' };
		case 'refresh-policy': {
			const revision = input.desiredRevision;
			if (revision === undefined) return { kind: 'refresh-policy' };
			if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0) {
				throw new Error('action.desiredRevision must be a whole policy revision number.');
			}
			return { kind: 'refresh-policy', desiredRevision: revision };
		}
		default:
			throw new Error('action.kind must be one of cancel-run, report-status, refresh-policy.');
	}
}

async function answer(
	managed: ManagedOperations,
	message: WebClientMessage
): Promise<Record<string, unknown>> {
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
		case 'managed_inbox_list': {
			const listing = await managed.inboxList({ refresh: message.refresh !== false });
			if (!listing) throw new Error(NO_INBOX_MESSAGE);
			return { listing };
		}
		case 'managed_inbox_act': {
			const problem = inboxActionProblem(message.action);
			if (problem) throw new Error(`action: ${problem}.`);
			const messageId = id(message.messageId, 'messageId');
			const campaignId =
				message.campaignId === undefined ? undefined : id(message.campaignId, 'campaignId');
			// The caller of record (MRC-08-01): the facade reads the same context to gate the act.
			const actor = describeSpawnActor(transportSpawnActor(getActingTransport()));
			const user = getActingUser()?.username ?? null;
			logger.info(
				`[Web] managed_inbox_act ${String((message.action as { kind: string }).kind)} on ${messageId} by ${actor}${user ? ` (${user})` : ''}`,
				LOG_CONTEXT
			);
			const outcome = await managed.inboxAct({
				messageId,
				campaignId,
				action: message.action as Parameters<ManagedOperations['inboxAct']>[0]['action'],
			});
			return { outcome, actor, user };
		}
		case 'managed_command':
			return { execution: await managed.command(validateLocalCommand(message.action)) };
		case 'managed_command_status': {
			const status = managed.commandStatus();
			if (!status) throw new Error(NO_COMMANDS_MESSAGE);
			return { status };
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
