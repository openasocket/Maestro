// Managed inbox and command verbs (MRC2-07-02): the maestro-cli path of the
// Managed inbox in Settings > Environment (list, mark read, acknowledge, reply
// privately) and of the typed runtime commands this desktop executes. Every
// verb sends one typed message over the WebSocket bridge, answered from
// `EnterpriseService.managed` (`inboxList`, `inboxAct`, `command`,
// `commandStatus` in `src/main/enterprise/service.ts`), the same facade the
// pane and the `enterprise:*` IPC handlers read.
//
// Wire contract (the bridge handlers of MRC2-07-03 answer these; each
// `<type>_result` carries `success` and the named field):
//   managed_inbox_list (listing), managed_inbox_act (outcome),
//   managed_command (execution), managed_command_status (status)
//
// Every write verb prints the durable receipt (the receipt ledger's record for
// an inbox act, the command ledger's id and evidence digest for a command) or
// the word `unknown` when this host recorded the act but never saw the
// endpoint's answer. An unmanaged host refuses each with its standing.
//
// A notice body is for the person at the terminal and nothing else
// (`agentInput: false` is the contract's word): `list` prints ids and states
// and shows a body only under `--bodies`. Pause and resume of a run are not
// offered: the command contract has no such action (CP-05).

import type { CommandServiceStatus, LocalCommandAction } from '../../main/enterprise/commands';
import type { InboxActionOutcome, NoticeView } from '../../main/enterprise/inbox';
import type { ManagedInboxListing } from '../../main/enterprise/service';
import type { CommandExecution } from '../../shared/maestro-lib/managed/commands';
import type { EndpointInboxAction } from '../../shared/maestro-lib/managed/host-adapter';
import { ExitCode, exitWith } from '../exit-codes';
import { formatSuccess } from '../output/formatter';
import { isQuiet } from '../output/verbosity';
import { failCommand } from '../services/session-command';
import { askDesktop, type ManagedOptions } from './managed';

export interface ManagedInboxListOptions extends ManagedOptions {
	/** Read what this host already holds without asking the endpoint again. */
	held?: boolean;
	/** Print the notice bodies (for the person at the terminal; never agent input). */
	bodies?: boolean;
}

export interface ManagedInboxActOptions extends ManagedOptions {
	/** The campaign, when the same message id is held under more than one. */
	campaign?: string;
	/** The reply's text (`reply` only). */
	message?: string;
}

export type ManagedInboxActKind = Exclude<EndpointInboxAction['kind'], 'delivered'>;

export interface ManagedCommandOptions extends ManagedOptions {
	/** `refresh-policy`: the revision the endpoint is expected to apply; default the one the host knows is desired. */
	revision?: string;
}

const UNKNOWN_RECEIPT = 'unknown';

// ---------------------------------------------------------------------------
// Renderers. Every value is the pane's projection: ids, states and digests.
// ---------------------------------------------------------------------------

function formatNotice(notice: NoticeView, bodies: boolean): string {
	const receipts = Object.entries(notice.receipts)
		.map(([kind, state]) => `${kind} ${state}`)
		.join(', ');
	const lines = [
		`  ${notice.messageId}  campaign ${notice.campaignId}  expires ${notice.expiresAt}  recorded ${notice.recorded ?? 'none'}${receipts ? `  (${receipts})` : ''}`,
	];
	if (bodies) lines.push(...notice.body.split('\n').map((line) => `      ${line}`));
	return lines.join('\n');
}

export function formatInboxListing(listing: ManagedInboxListing, bodies: boolean): string {
	const { status, notices } = listing.view;
	const standing = status.standing.ok ? 'ok' : status.standing.reason;
	const caps = status.capabilities;
	const lines = [
		`Inbox standing: ${standing}; noticeList ${caps.noticeList ? 'yes' : 'no'}, inbox ${caps.inbox ? 'yes' : 'no'}`,
	];
	const r = listing.refresh;
	if (r) {
		lines.push(
			r.outcome === 'listed'
				? `Listed: ${r.listed} notice(s) over ${r.pages} page(s), ${r.newlyHeld} new, ${r.expired} expired; delivered recorded ${r.delivered.recorded}`
				: `Not listed (${r.outcome}): ${r.reason ?? 'no reason given'}`
		);
	}
	lines.push(
		`Held: ${status.notices.held} (unread ${status.notices.unread}, unacknowledged ${status.notices.unacknowledged}); receipts ${status.receipts.total}`
	);
	for (const notice of notices) lines.push(formatNotice(notice, bodies));
	if (!bodies && notices.length > 0) lines.push('(bodies withheld; pass --bodies to read them)');
	return lines.join('\n');
}

/** The line a write verb ends on: the durable receipt, or `unknown`. */
export function formatInboxReceipt(outcome: InboxActionOutcome): string {
	switch (outcome.status) {
		case 'recorded': {
			const r = outcome.record;
			return `Receipt ${r.receipt?.receiptId ?? UNKNOWN_RECEIPT}: ${r.action} ${r.state} (${r.receipt?.state ?? 'none'}) on ${r.messageId}, key ${r.idempotencyKey}${outcome.duplicate ? '; already recorded, nothing sent again' : ''}`;
		}
		case 'uncertain':
			return `Receipt ${UNKNOWN_RECEIPT}: ${outcome.record.action} on ${outcome.record.messageId} recorded here as ${outcome.record.state} (${outcome.detail}); run it again to resend under key ${outcome.record.idempotencyKey}`;
		case 'denied':
			return `Refused (${outcome.reason}): ${outcome.detail}`;
		case 'unavailable':
			return outcome.detail;
	}
}

export function formatCommandReceipt(execution: CommandExecution): string {
	switch (execution.status) {
		case 'denied':
			return `Refused (${execution.reason}): ${execution.detail}`;
		case 'unavailable':
			return execution.detail;
		case 'unknown':
			return `Receipt ${UNKNOWN_RECEIPT}: command ${execution.commandId} ${execution.detail ?? 'was not settled'}`;
		default:
			return `Command ${execution.commandId} ${execution.status}${execution.duplicate ? ' (already recorded)' : ''}; evidence ${execution.evidenceDigest ?? 'none'}${execution.detail ? `: ${execution.detail}` : ''}`;
	}
}

export function formatCommandStatus(status: CommandServiceStatus): string {
	const lines = [
		`Command standing: ${status.standing.ok ? 'ok' : status.standing.reason}`,
		`Executes: ${status.capabilities.length ? status.capabilities.join(', ') : 'nothing'}`,
	];
	for (const u of status.unsupported) lines.push(`  not offered ${u.capability}: ${u.reason}`);
	const by = Object.entries(status.commands.byState)
		.map(([state, count]) => `${state} ${count}`)
		.join(', ');
	lines.push(`Ledger: ${status.commands.total} command(s), ${status.commands.open} open (${by})`);
	return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Verbs
// ---------------------------------------------------------------------------

/** `managed inbox list`: list the endpoint's notices (the pane's List) or, with `--held`, the held set alone. */
export async function managedInboxList(options: ManagedInboxListOptions): Promise<void> {
	const listing = await askDesktop<ManagedInboxListing>(
		{ type: 'managed_inbox_list', refresh: !options.held },
		'managed_inbox_list_result',
		'listing',
		options.json
	);
	if (options.json) {
		const notices = options.bodies
			? listing.view.notices
			: listing.view.notices.map(({ body: _body, ...rest }) => rest);
		console.log(
			JSON.stringify({ success: true, listing: { ...listing, view: { ...listing.view, notices } } })
		);
	} else console.log(formatInboxListing(listing, options.bodies === true));
}

/** `managed inbox read|ack|reply <messageId>`: one receipt on one held notice, printed durably or as `unknown`. */
export async function managedInboxAct(
	kind: ManagedInboxActKind,
	messageId: string,
	options: ManagedInboxActOptions
): Promise<void> {
	let action: EndpointInboxAction;
	if (kind === 'reply') {
		if (!options.message) return failCommand('A reply needs --message <text>.', options.json);
		action = { kind, text: options.message };
	} else action = { kind };
	const outcome = await askDesktop<InboxActionOutcome>(
		{
			type: 'managed_inbox_act',
			messageId,
			...(options.campaign ? { campaignId: options.campaign } : {}),
			action,
		},
		'managed_inbox_act_result',
		'outcome',
		options.json
	);
	const ok = outcome.status === 'recorded';
	if (options.json) {
		console.log(JSON.stringify({ success: ok, outcome }));
		if (!ok) exitWith(ExitCode.GeneralError);
		return;
	}
	if (ok) {
		if (!isQuiet()) console.log(formatSuccess(formatInboxReceipt(outcome)));
		return;
	}
	failCommand(formatInboxReceipt(outcome), options.json);
}

/** `managed command cancel-run|report-status|refresh-policy`: a local operator's typed command through the real executor and ledger. */
export async function managedCommand(
	action: LocalCommandAction,
	options: ManagedCommandOptions
): Promise<void> {
	if (action.kind === 'refresh-policy' && options.revision !== undefined) {
		const desiredRevision = Number(options.revision);
		if (!Number.isInteger(desiredRevision) || desiredRevision < 0) {
			return failCommand('--revision must be a whole policy revision number.', options.json);
		}
		action = { kind: 'refresh-policy', desiredRevision };
	}
	const execution = await askDesktop<CommandExecution>(
		{ type: 'managed_command', action },
		'managed_command_result',
		'execution',
		options.json
	);
	const ok =
		execution.status === 'completed' ||
		execution.status === 'no-effect' ||
		execution.status === 'accepted';
	if (options.json) {
		console.log(JSON.stringify({ success: ok, execution }));
		if (!ok) exitWith(ExitCode.GeneralError);
		return;
	}
	if (ok) {
		if (!isQuiet()) console.log(formatSuccess(formatCommandReceipt(execution)));
		return;
	}
	failCommand(formatCommandReceipt(execution), options.json);
}

/** `managed command status`: what this desktop executes and refuses by name, and the ledger's counts (the read for every write above). */
export async function managedCommandStatus(options: ManagedOptions): Promise<void> {
	const status = await askDesktop<CommandServiceStatus>(
		{ type: 'managed_command_status' },
		'managed_command_status_result',
		'status',
		options.json
	);
	if (options.json) console.log(JSON.stringify({ success: true, status }));
	else console.log(formatCommandStatus(status));
}
