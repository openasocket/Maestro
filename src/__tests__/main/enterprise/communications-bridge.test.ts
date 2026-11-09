/**
 * The inbox and command verbs over a detached host's bridge (MCOMP-29-03): the shared request
 * handler (`createRequestHandler`) answers `managed_inbox_list`, `managed_inbox_act`,
 * `managed_command` and `managed_command_status` from a composed communications port, spelled and
 * shaped the way the desktop bridge answers them, and refuses each by name with no port (no
 * direct-store fallback). The port here is the real extracted facade
 * (`createManagedCommunications`, the same code the desktop's `createManagedOperations` spreads)
 * over a REAL inbox client on an in-memory receipt ledger and a doubled command service.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
	app: { getVersion: () => '0.0.0', getAppPath: () => '/repo' },
	ipcMain: { handle: vi.fn(), on: vi.fn(), emit: vi.fn(), listenerCount: () => 0 },
}));
vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { createInboxClient, createInboxReceiptLedger } from '../../../main/enterprise/inbox';
import type { CommandService, LocalCommandAction } from '../../../main/enterprise/commands';
import {
	NO_INBOX_OUTCOME,
	createManagedCommunications,
	type ManagedCommunications,
} from '../../../main/enterprise/service';
import type { MaestroClient } from '../../../shared/maestro-lib/client/types';
import type {
	EndpointInboxAction,
	EndpointInboxRequest,
	InboxPort,
	InboxStanding,
} from '../../../shared/maestro-lib/managed/host-adapter';
import {
	MANAGED_COMMUNICATION_TYPES,
	NO_MANAGED_COMMUNICATIONS_MESSAGE,
	createRequestHandler,
	isManagedCommunicationType,
	type ManagedCommunicationsPort,
} from '../../../shared/maestro-lib/runtime/server-requests';

const NOW = Date.parse('2026-11-09T12:00:00.000Z');
const INSTALLATION = { installationId: 'inst-1', runtimeId: 'host-1', processEpoch: 'epoch-1' };
const CAMPAIGN = '11111111-1111-4111-8111-111111111111';
const MESSAGE = '22222222-2222-4222-8222-222222222222';
const BODY = 'Planned maintenance on Friday.';
const NOTICE = {
	campaignId: CAMPAIGN,
	messageId: MESSAGE,
	body: BODY,
	expiresAt: new Date(NOW + 86_400_000).toISOString(),
	kind: 'notice',
	agentInput: false,
};
const REGISTERED: InboxStanding = {
	standingKey: 'k1',
	ok: true,
	binding: {
		tenantId: 'tenant-1',
		enrollmentId: 'enr-1',
		registrationId: 'ch-1',
		actorId: 'actor-1',
		installation: INSTALLATION,
		policyRevision: 3,
		capabilities: { noticeList: true, inbox: true },
	},
};

function inboxDouble() {
	const acts: EndpointInboxRequest[] = [];
	const port: InboxPort = {
		list: async () => ({
			status: 'ok',
			payload: { outcome: 'notices', items: [NOTICE], nextOffset: null },
		}),
		act: async (request) => {
			acts.push(request);
			return {
				status: 'ok',
				payload: {
					outcome: 'recorded',
					messageId: request.messageId,
					receiptId: `rcpt-${request.action.kind}`,
					state: request.action.kind === 'reply' ? 'replied' : request.action.kind,
				},
			};
		},
	};
	const client = createInboxClient({
		host: { inboxStanding: () => REGISTERED, inbox: port },
		ledger: createInboxReceiptLedger({ now: () => NOW }),
		now: () => NOW,
	});
	return { client, acts };
}

function commandsDouble() {
	const issued: LocalCommandAction[] = [];
	const service = {
		issueLocal: vi.fn(async (action: LocalCommandAction) => {
			issued.push(action);
			return {
				status: 'completed',
				commandId: 'local-1',
				duplicate: false,
				evidenceDigest: 'e'.repeat(64),
			};
		}),
		status: vi.fn(() => ({
			file: null,
			loaded: true,
			load: null,
			capabilities: ['command.cancel_run', 'command.pause_run', 'command.resume_run'],
			unsupported: [],
			commands: { total: 1, open: 0, byState: { completed: 1 } },
			standing: { ok: true },
		})),
	};
	return { service: service as unknown as CommandService, issued };
}

/**
 * A port over the facade, the shape a host composes: each verb returns its named field and a
 * missing composition is a thrown sentence, as on the desktop bridge.
 */
function portOver(facade: ManagedCommunications): ManagedCommunicationsPort {
	return {
		async answer(type, message) {
			switch (type) {
				case 'managed_inbox_list': {
					const listing = await facade.inboxList({ refresh: message.refresh !== false });
					if (!listing) throw new Error('No notice inbox is composed on this host.');
					return { listing };
				}
				case 'managed_inbox_act':
					return {
						outcome: await facade.inboxAct({
							messageId: message.messageId as string,
							action: message.action as EndpointInboxAction,
							actor: { kind: 'cli' } as never,
						}),
					};
				case 'managed_command':
					return { execution: await facade.command(message.action as LocalCommandAction) };
				case 'managed_command_status': {
					const status = facade.commandStatus();
					if (!status) throw new Error('No command service is composed on this host.');
					return { status };
				}
			}
		},
	};
}

const noClient = {} as MaestroClient;

describe('endpoint communications over the host bridge (MCOMP-29-03)', () => {
	it('names exactly the four verbs the desktop bridge spells, and nothing else', () => {
		expect([...MANAGED_COMMUNICATION_TYPES]).toEqual([
			'managed_inbox_list',
			'managed_inbox_act',
			'managed_command',
			'managed_command_status',
		]);
		expect(isManagedCommunicationType('managed_inbox_act')).toBe(true);
		expect(isManagedCommunicationType('managed_run')).toBe(false);
		expect(isManagedCommunicationType('managed_enroll_request')).toBe(false);
	});

	it('refuses every verb by name when the host composed no port, recording nothing', async () => {
		const handle = createRequestHandler(noClient);
		for (const type of MANAGED_COMMUNICATION_TYPES) {
			expect(await handle({ type, action: { kind: 'report-status' } })).toEqual({
				type: `${type}_result`,
				success: false,
				error: NO_MANAGED_COMMUNICATIONS_MESSAGE,
			});
		}
		// A verb the host never serves stays unknown (the transport answers it as unsupported).
		expect(await handle({ type: 'managed_run', leaseId: 'lease-1' })).toBeUndefined();
	});

	it('lists, records a receipt, executes and reports through the real facade, with the desktop reply shapes', async () => {
		const inbox = inboxDouble();
		const commands = commandsDouble();
		const facade = createManagedCommunications({
			identity: { read: () => ({ status: 'none' }) } as never,
			inbox: () => inbox.client,
			commands: () => commands.service,
			place: 'on this host',
		});
		const handle = createRequestHandler(noClient, { communications: portOver(facade) });

		const listed = (await handle({ type: 'managed_inbox_list', refresh: true }))!;
		expect(listed).toMatchObject({ type: 'managed_inbox_list_result', success: true });
		const listing = listed.listing as {
			refresh: { outcome: string; listed: number };
			view: { notices: Array<{ messageId: string; body: string }> };
		};
		expect(listing.refresh).toMatchObject({ outcome: 'listed', listed: 1 });
		expect(listing.view.notices.map((n) => n.messageId)).toEqual([MESSAGE]);

		const acked = (await handle({
			type: 'managed_inbox_act',
			messageId: MESSAGE,
			action: { kind: 'acknowledged' },
		}))!;
		expect(acked).toMatchObject({
			type: 'managed_inbox_act_result',
			success: true,
			outcome: { status: 'recorded', record: { action: 'acknowledged', messageId: MESSAGE } },
		});
		expect(inbox.acts.map((a) => a.action.kind)).toEqual(['delivered', 'acknowledged']);
		// The notice text went to the person's listing only: no act carries it.
		expect(JSON.stringify(inbox.acts)).not.toContain(BODY);

		const executed = (await handle({
			type: 'managed_command',
			action: { kind: 'cancel-run', runId: 'run-1' },
		}))!;
		expect(executed).toEqual({
			type: 'managed_command_result',
			success: true,
			execution: expect.objectContaining({ status: 'completed', commandId: 'local-1' }),
		});
		expect(commands.issued).toEqual([{ kind: 'cancel-run', runId: 'run-1' }]);

		const status = (await handle({ type: 'managed_command_status' }))!;
		expect(status).toMatchObject({
			type: 'managed_command_status_result',
			success: true,
			status: { capabilities: expect.arrayContaining(['command.pause_run']) },
		});
	});

	it('a port refusal is the reply sentence, and a port never overrides the reply type or success', async () => {
		const handle = createRequestHandler(noClient, {
			communications: {
				answer: async (type) => {
					if (type === 'managed_command') throw new Error('action.kind must be one of x.');
					return { type: 'forged', success: false, error: 'forged', status: { ok: true } };
				},
			},
		});
		expect(await handle({ type: 'managed_command', action: { kind: 'nope' } })).toEqual({
			type: 'managed_command_result',
			success: false,
			error: 'action.kind must be one of x.',
		});
		expect(await handle({ type: 'managed_command_status' })).toEqual({
			type: 'managed_command_status_result',
			success: true,
			status: { ok: true },
		});
	});

	it('reads the composition per call and names the place: nothing composed yet is refused, then served', async () => {
		let inbox: ReturnType<typeof inboxDouble>['client'] | null = null;
		let commands: CommandService | null = null;
		const host = createManagedCommunications({
			identity: { read: () => ({ status: 'none' }) } as never,
			inbox: () => inbox,
			commands: () => commands,
			place: 'on this host',
		});
		expect(await host.inboxList()).toBeNull();
		expect(host.commandStatus()).toBeNull();
		expect(await host.inboxAct({ messageId: MESSAGE, action: { kind: 'read' } })).toEqual({
			status: 'unavailable',
			detail: 'No notice inbox is composed on this host.',
		});
		expect(await host.command({ kind: 'report-status' })).toEqual({
			status: 'unavailable',
			commandId: null,
			detail: 'No command service is composed on this host.',
		});

		inbox = inboxDouble().client;
		commands = commandsDouble().service;
		expect((await host.inboxList({ refresh: false }))?.refresh).toBeNull();
		expect(host.commandStatus()).not.toBeNull();

		// The desktop's own wording is unchanged when no place is named.
		const desktop = createManagedCommunications({
			identity: { read: () => ({ status: 'none' }) } as never,
			inbox: () => undefined,
			commands: () => undefined,
		});
		expect(await desktop.inboxAct({ messageId: MESSAGE, action: { kind: 'read' } })).toBe(
			NO_INBOX_OUTCOME
		);
	});
});
