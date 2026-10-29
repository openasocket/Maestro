/**
 * The managed operation bridge handlers (MRC2-07-03): every `managed_*`
 * message `maestro-cli managed` sends is answered from the one facade the
 * Settings > Environment pane reads, through the real dispatcher (so the
 * acting user and the transport are established the way they are for every
 * other message). Covers: each verb's named field, the exit paths the CLI's
 * `askDesktop()` reads (no service, a refused input by name, a thrown service
 * fault), the CLI-only writes a browser cannot send, the receipt attribution
 * of an inbox act (the actor named in the reply, a paired device with no
 * registered actor refused by the facade), no secret echoed from an
 * enrollment request, and the remote method inventory admitting exactly the
 * intended `enterprise:*` reads and the settings lock read.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
	app: { getVersion: () => '0.0.0', getAppPath: () => '/repo' },
	ipcMain: { handle: vi.fn(), on: vi.fn(), emit: vi.fn(), listenerCount: () => 0 },
}));
vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../../main/plugins/plugin-manager-singleton', () => ({
	getActivePluginManager: vi.fn(),
	isPluginsFeatureEnabled: vi.fn(),
	getHeadlessAgentRunner: vi.fn(() => null),
}));

import { WebSocketMessageHandler } from '../../../../main/web-server/handlers/messageHandlers';
import type { WebClient } from '../../../../main/web-server/handlers/messageHandlers';
import {
	MANAGED_CLI_ONLY_MESSAGE,
	MANAGED_CLI_ONLY_TYPES,
	MANAGED_MESSAGE_TYPES,
	NO_MANAGED_SERVICE_MESSAGE,
	validateLocalCommand,
} from '../../../../main/web-server/handlers/messageHandlers/managed';
import { isRemoteMethodAllowed } from '../../../../main/web-server/handlers/bridgeDenyList';
import {
	createManagedOperations,
	type ManagedOperations,
} from '../../../../main/enterprise/service';
import { PAIRED_DEVICE_USER_ID_PREFIX } from '../../../../main/web-server/auth/transport-actor';

const STATE = { standing: 'unenrolled', reason: null };
const LOCKS = { policyRevision: null, locks: {} };
const INVENTORY = { installation: { installationId: 'inst-1' } };
const ENROLL = {
	socketPath: '/run/endpoint/runtime.sock',
	tenantId: 'tenant-1',
	orgId: 'org-1',
	mode: 'attended',
	invitation: 'invite-secret-value',
	collectionProfile: 'metadata',
	trustRootDigest: 'a'.repeat(64),
	keyPossessionProof: 'proof-secret-value',
};

function createClient(extra: Partial<WebClient> = {}): WebClient {
	return {
		id: 'client-1',
		connectedAt: 0,
		socket: { send: vi.fn() } as unknown as WebClient['socket'],
		...extra,
	};
}

function sentFrames(client: WebClient): Array<Record<string, unknown>> {
	return (client.socket.send as ReturnType<typeof vi.fn>).mock.calls.map((call) =>
		JSON.parse(call[0] as string)
	);
}

/** Dispatch one message and wait for the one reply the handler sends. */
async function ask(
	handler: WebSocketMessageHandler,
	client: WebClient,
	message: Record<string, unknown>
): Promise<Record<string, unknown>> {
	handler.handleMessage(client, { requestId: 'req-1', ...message } as never);
	for (let i = 0; i < 20 && sentFrames(client).length === 0; i++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	const frames = sentFrames(client);
	expect(frames).toHaveLength(1);
	return frames[0];
}

function facadeDouble(overrides: Partial<ManagedOperations> = {}): ManagedOperations {
	return {
		status: vi.fn(() => STATE as never),
		requestEnrollment: vi.fn(
			async () => ({ status: 'ok', value: { outcome: 'pending' } }) as never
		),
		refreshPolicy: vi.fn(async () => ({ status: 'ok', value: { management: 'managed' } }) as never),
		inventory: vi.fn(() => INVENTORY as never),
		supportMatrix: vi.fn(() => ({ library: '1.0.0', routes: [] }) as never),
		locks: vi.fn(() => LOCKS as never),
		inboxList: vi.fn(async () => ({ refresh: null, view: { notices: [] } }) as never),
		inboxAct: vi.fn(async () => ({ status: 'recorded', duplicate: false, record: {} }) as never),
		command: vi.fn(async () => ({ status: 'completed', commandId: 'local-1' }) as never),
		commandStatus: vi.fn(() => ({ standing: { ok: true } }) as never),
		...overrides,
	};
}

describe('managed bridge handlers (MRC2-07-03)', () => {
	let handler: WebSocketMessageHandler;
	let managed: ManagedOperations;

	beforeEach(() => {
		handler = new WebSocketMessageHandler();
		managed = facadeDouble();
		handler.setCallbacks({ getManaged: () => managed });
	});

	it('answers every read from the facade with its named field, echoing the request id', async () => {
		const cli = createClient({ cli: true });
		const reads: Array<[string, string, unknown]> = [
			['managed_status', 'state', STATE],
			['managed_inventory', 'inventory', INVENTORY],
			['managed_support_matrix', 'matrix', { library: '1.0.0', routes: [] }],
			['managed_locks', 'locks', LOCKS],
			['managed_command_status', 'status', { standing: { ok: true } }],
		];
		for (const [type, field, value] of reads) {
			const client = createClient({ cli: true });
			expect(await ask(handler, client, { type })).toEqual({
				type: `${type}_result`,
				requestId: 'req-1',
				success: true,
				[field]: value,
				timestamp: expect.any(Number),
			});
		}
		expect(await ask(handler, cli, { type: 'managed_inbox_list', refresh: false })).toMatchObject({
			success: true,
			listing: { refresh: null },
		});
		expect(managed.inboxList).toHaveBeenCalledWith({ refresh: false });
		expect(await ask(handler, createClient(), { type: 'managed_inbox_list' })).toMatchObject({
			success: true,
		});
		expect(managed.inboxList).toHaveBeenLastCalledWith({ refresh: true });
	});

	it('runs the CLI-only writes for a CLI client and refuses them to a browser by name', async () => {
		expect(MANAGED_CLI_ONLY_TYPES).toEqual([
			'managed_enroll_request',
			'managed_policy_refresh',
			'managed_command',
		]);
		const refresh = await ask(handler, createClient({ cli: true }), {
			type: 'managed_policy_refresh',
		});
		expect(refresh).toMatchObject({ success: true, outcome: { status: 'ok' } });
		const command = await ask(handler, createClient({ cli: true }), {
			type: 'managed_command',
			action: { kind: 'cancel-run', runId: 'run-9' },
		});
		expect(command).toMatchObject({ success: true, execution: { status: 'completed' } });
		expect(managed.command).toHaveBeenCalledWith({ kind: 'cancel-run', runId: 'run-9' });
		const enroll = await ask(handler, createClient({ cli: true }), {
			type: 'managed_enroll_request',
			request: ENROLL,
		});
		expect(enroll).toMatchObject({ success: true, outcome: { status: 'ok' } });
		expect(managed.requestEnrollment).toHaveBeenCalledWith(ENROLL);

		for (const type of MANAGED_CLI_ONLY_TYPES) {
			const browser = createClient({
				user: { id: 'u1', username: 'ada', displayName: 'Ada' },
			});
			expect(
				await ask(handler, browser, { type, request: ENROLL, action: { kind: 'report-status' } })
			).toMatchObject({ type: `${type}_result`, success: false, error: MANAGED_CLI_ONLY_MESSAGE });
		}
		expect(managed.requestEnrollment).toHaveBeenCalledTimes(1);
		expect(managed.refreshPolicy).toHaveBeenCalledTimes(1);
		expect(managed.command).toHaveBeenCalledTimes(1);
	});

	it('names a refused input and never its value: a short enrollment request, a bad command, a bad act', async () => {
		const cli = () => createClient({ cli: true });
		const short = await ask(handler, cli(), {
			type: 'managed_enroll_request',
			request: { ...ENROLL, invitation: '' },
		});
		expect(short).toMatchObject({ success: false, error: expect.stringContaining('invitation') });
		expect(JSON.stringify(short)).not.toContain('proof-secret-value');
		expect(JSON.stringify(short)).not.toContain('invite-secret-value');
		expect(managed.requestEnrollment).not.toHaveBeenCalled();

		expect(
			await ask(handler, cli(), { type: 'managed_command', action: { kind: 'pause-run' } })
		).toMatchObject({ success: false, error: expect.stringContaining('action.kind') });
		expect(() => validateLocalCommand({ kind: 'refresh-policy', desiredRevision: -1 })).toThrow(
			/desiredRevision/
		);
		expect(validateLocalCommand({ kind: 'refresh-policy', desiredRevision: 4 })).toEqual({
			kind: 'refresh-policy',
			desiredRevision: 4,
		});
		expect(validateLocalCommand({ kind: 'refresh-policy' })).toEqual({ kind: 'refresh-policy' });
		expect(managed.command).not.toHaveBeenCalled();

		expect(
			await ask(handler, cli(), {
				type: 'managed_inbox_act',
				messageId: 'm1',
				action: { kind: 'x' },
			})
		).toMatchObject({ success: false, error: expect.stringMatching(/^action: /) });
		expect(
			await ask(handler, cli(), { type: 'managed_inbox_act', action: { kind: 'read' } })
		).toMatchObject({ success: false, error: expect.stringContaining('messageId') });
		expect(managed.inboxAct).not.toHaveBeenCalled();
	});

	it('answers success: false with the sentence when no service runs, no inbox or command service is composed, or the facade throws', async () => {
		handler.setCallbacks({ getManaged: () => null });
		expect(await ask(handler, createClient({ cli: true }), { type: 'managed_status' })).toEqual({
			type: 'managed_status_result',
			requestId: 'req-1',
			success: false,
			error: NO_MANAGED_SERVICE_MESSAGE,
			timestamp: expect.any(Number),
		});
		handler.setCallbacks({
			getManaged: () =>
				facadeDouble({
					inboxList: vi.fn(async () => null),
					commandStatus: vi.fn(() => null),
					status: vi.fn(() => {
						throw new Error('the lifecycle is closed');
					}),
				}),
		});
		expect(await ask(handler, createClient(), { type: 'managed_inbox_list' })).toMatchObject({
			success: false,
			error: 'No notice inbox is composed in this desktop.',
		});
		expect(await ask(handler, createClient(), { type: 'managed_command_status' })).toMatchObject({
			success: false,
			error: 'No command service is composed in this desktop.',
		});
		expect(await ask(handler, createClient(), { type: 'managed_status' })).toMatchObject({
			success: false,
			error: 'the lifecycle is closed',
		});
	});

	it('attributes an inbox act to the transport that sent it and names the actor in the reply (MRC-08-01)', async () => {
		const byCli = await ask(handler, createClient({ cli: true }), {
			type: 'managed_inbox_act',
			messageId: 'm1',
			campaignId: 'c1',
			action: { kind: 'reply', text: 'done' },
		});
		expect(byCli).toMatchObject({
			success: true,
			outcome: { status: 'recorded' },
			actor: 'maestro-cli',
			user: null,
		});
		expect(managed.inboxAct).toHaveBeenCalledWith({
			messageId: 'm1',
			campaignId: 'c1',
			action: { kind: 'reply', text: 'done' },
		});
		const byLogin = await ask(
			handler,
			createClient({ user: { id: 'u1', username: 'ada', displayName: 'Ada' } }),
			{ type: 'managed_inbox_act', messageId: 'm1', action: { kind: 'acknowledged' } }
		);
		expect(byLogin).toMatchObject({ success: true, actor: 'web-login:ada', user: 'ada' });
		const byOwner = await ask(handler, createClient(), {
			type: 'managed_inbox_act',
			messageId: 'm1',
			action: { kind: 'read' },
		});
		expect(byOwner).toMatchObject({ success: true, actor: 'the operator', user: null });
	});

	it('refuses a paired device with no registered actor through the real facade, and admits the operator, the CLI and a login', async () => {
		const act = vi.fn(async () => ({ status: 'recorded', duplicate: false, record: {} }));
		const inbox = {
			status: () => ({ standing: { ok: true } }),
			notices: () => [{ campaignId: 'c1', messageId: 'm1' }],
			act,
		};
		const identity = { read: () => ({ status: 'none' }), custody: () => ({ state: 'protected' }) };
		const real = createManagedOperations({
			lifecycle: { status: () => ({}) } as never,
			policy: { status: () => ({}) } as never,
			identity: identity as never,
			inventory: { snapshot: () => INVENTORY } as never,
			inbox: inbox as never,
			holds: { egress: () => [], update: () => null, listeners: () => [] },
		});
		handler.setCallbacks({ getManaged: () => real });
		const device = () =>
			createClient({
				admission: 'device-pairing',
				user: {
					id: `${PAIRED_DEVICE_USER_ID_PREFIX}dev-7`,
					username: 'paired-device',
					displayName: 'Phone',
				},
			});
		const refused = await ask(handler, device(), {
			type: 'managed_inbox_act',
			messageId: 'm1',
			action: { kind: 'read' },
		});
		expect(refused).toMatchObject({
			success: true,
			actor: 'lite-device:dev-7',
			outcome: {
				status: 'denied',
				reason: 'unauthenticated',
				detail: expect.stringContaining('dev-7'),
				record: null,
			},
		});
		expect(act).not.toHaveBeenCalled();
		for (const client of [
			createClient(),
			createClient({ cli: true }),
			createClient({ user: { id: 'u1', username: 'ada', displayName: 'Ada' } }),
		]) {
			expect(
				await ask(handler, client, {
					type: 'managed_inbox_act',
					messageId: 'm1',
					action: { kind: 'read' },
				})
			).toMatchObject({ success: true, outcome: { status: 'recorded' } });
		}
		expect(act).toHaveBeenCalledTimes(3);
		expect(act).toHaveBeenLastCalledWith({
			campaignId: 'c1',
			messageId: 'm1',
			action: { kind: 'read' },
		});
		// Once an actor is registered the device rides as attribution like every other transport.
		identity.read = () =>
			({ status: 'ok', record: { registration: { actorId: 'actor-1' } } }) as never;
		expect(
			await ask(handler, device(), {
				type: 'managed_inbox_act',
				messageId: 'm1',
				action: { kind: 'read' },
			})
		).toMatchObject({ success: true, outcome: { status: 'recorded' } });
	});

	it('routes exactly the ten managed message types and admits exactly the intended remote methods', () => {
		expect([...MANAGED_MESSAGE_TYPES].sort()).toEqual(
			[
				'managed_command',
				'managed_command_status',
				'managed_enroll_request',
				'managed_inbox_act',
				'managed_inbox_list',
				'managed_inventory',
				'managed_locks',
				'managed_policy_refresh',
				'managed_status',
				'managed_support_matrix',
			].sort()
		);
		for (const method of [
			'enterprise:managedState',
			'enterprise:inventory',
			'enterprise:inboxState',
			'enterprise:inboxRefresh',
			'enterprise:inboxAct',
			'settings:managedLocks',
		]) {
			expect(isRemoteMethodAllowed(method), method).toBe(true);
		}
		for (const method of [
			'enterprise:status',
			'enterprise:custody',
			'enterprise:policyStatus',
			'enterprise:commandStatus',
			'enterprise:requestEnrollment',
			'enterprise:connect',
			'enterprise:beginRegistration',
			'enterprise:completeRegistration',
			'enterprise:refreshPolicy',
			'enterprise:recoverPolicy',
			'enterprise:requestRotation',
			'enterprise:requestRevocation',
			'enterprise:requestRetirement',
			'enterprise:acknowledgeRevocation',
			'enterprise:retire',
			'enterprise:clearIdentity',
		]) {
			expect(isRemoteMethodAllowed(method), method).toBe(false);
		}
	});
});
