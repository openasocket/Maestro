/**
 * `maestro-cli managed` over the real bridge (MRC2-07-08): every verb's
 * message is dispatched by the real `WebSocketMessageHandler` to the real
 * managed facade (`createManagedOperations`, the one function the Settings >
 * Environment pane reads) composed over doubled lifecycle, policy and identity
 * services, a REAL inbox client on an in-memory receipt ledger and a doubled
 * command service. Covers: each verb printing what the facade answers, the
 * unmanaged refusal on every write (exit 1, the outcome kept in the JSON), a
 * receipt recorded through the real client under a registered standing with
 * bodies printed only on request, no secret in any output (the enrollment
 * file's invitation and proof are relayed and never printed; a missing field
 * is named, its value never), the exit codes of an absent or older desktop and
 * of one with no service, `open managed-status` and its aliases resolving the
 * registered surface, and exactly the ten managed message types on the wire.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('electron', () => ({
	app: { getVersion: () => '0.0.0', getAppPath: () => '/repo' },
	ipcMain: { handle: vi.fn(), on: vi.fn(), emit: vi.fn(), listenerCount: () => 0 },
}));
vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../main/plugins/plugin-manager-singleton', () => ({
	getActivePluginManager: vi.fn(),
	isPluginsFeatureEnabled: vi.fn(),
	getHeadlessAgentRunner: vi.fn(() => null),
}));
// The bridge client is the one double: its `sendCommand` drives the real dispatcher below.
vi.mock('../../../cli/services/maestro-client', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../cli/services/maestro-client')>()),
	withMaestroClient: vi.fn(),
}));
vi.mock('../../../cli/services/storage', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../cli/services/storage')>()),
	readSettingValue: vi.fn(() => undefined),
}));

import { WebSocketMessageHandler } from '../../../main/web-server/handlers/messageHandlers';
import type { WebClient } from '../../../main/web-server/handlers/messageHandlers';
import {
	MANAGED_MESSAGE_TYPES,
	NO_MANAGED_SERVICE_MESSAGE,
} from '../../../main/web-server/handlers/messageHandlers/managed';
import { createManagedOperations, type ManagedOperations } from '../../../main/enterprise/service';
import { createInboxClient, createInboxReceiptLedger } from '../../../main/enterprise/inbox';
import type {
	EndpointInboxRequest,
	InboxPort,
	InboxStanding,
} from '../../../shared/maestro-lib/managed/host-adapter';
import { UnsupportedCommandError, withMaestroClient } from '../../../cli/services/maestro-client';
import { MaestroNotRunningError } from '../../../cli/services/maestro-not-running';
import {
	ENROLLMENT_REQUEST_FIELDS,
	managedEnrollRequest,
	managedInventory,
	managedLocks,
	managedPolicyRefresh,
	managedStatus,
	managedSupportMatrix,
} from '../../../cli/commands/managed';
import {
	managedCommand,
	managedCommandStatus,
	managedInboxAct,
	managedInboxList,
} from '../../../cli/commands/managed-inbox';
import { openModal } from '../../../cli/commands/open-modal';
import { resolveUiSurface } from '../../../shared/uiSurfaces';
import { NO_MANAGED_SETTING_LOCKS } from '../../../shared/managedSettingsLock';

// ---------------------------------------------------------------------------
// The desktop: doubled services under the real facade, the real inbox client.
// ---------------------------------------------------------------------------

const NOW = Date.parse('2026-10-28T12:00:00.000Z');
const INSTALLATION = {
	installationId: 'inst-1',
	runtimeId: 'desktop-100',
	processEpoch: 'epoch-1',
};
const NO_ENROLLMENT = 'This installation holds no enrollment.';

/** The lifecycle's status for a desktop with no record. */
const UNENROLLED = {
	identity: { status: 'none', reason: null, message: null, record: null },
	connection: null,
	endpoint: null,
	authority: 'none',
	reason: NO_ENROLLMENT,
	pendingApproval: null,
	lastDenial: null,
};
const POLICY = {
	desiredRevision: null,
	appliedRevision: null,
	installedRevision: null,
	source: 'none',
	freshness: 'unknown',
	observedAt: null,
	connectivity: 'detached',
	management: null,
	capabilities: [],
	converged: null,
	offline: { installedPolicyAvailable: false, mode: 'none' },
	approval: { state: 'none', expiresAt: null },
	registration: { state: 'none', expiresAt: null },
	admission: { possible: false, reasons: [NO_ENROLLMENT] },
};
const INVENTORY = { completeness: 'partial', installation: INSTALLATION };
const COMMAND_STATUS = {
	file: null,
	loaded: true,
	load: null,
	capabilities: ['command.cancel_run'],
	unsupported: [],
	commands: { total: 0, open: 0, byState: {} },
	standing: { ok: false, reason: NO_ENROLLMENT },
};

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
const UNREGISTERED: InboxStanding = { standingKey: 'k0', ok: false, reason: NO_ENROLLMENT };

const ENROLL = {
	socketPath: '/run/endpoint/runtime.sock',
	tenantId: 'tenant-1',
	orgId: 'org-1',
	mode: 'attended',
	collectionProfile: 'metadata',
	trustRootDigest: 'a'.repeat(64),
	invitation: 'invite-secret-value',
	keyPossessionProof: 'proof-secret-value',
};
const SECRETS = [ENROLL.invitation, ENROLL.keyPossessionProof];

/** A doubled endpoint inbox port under a mutable standing; every act it receives is kept. */
function inboxDouble() {
	const d = { standing: UNREGISTERED, held: [] as unknown[], acts: [] as EndpointInboxRequest[] };
	const port: InboxPort = {
		list: async () => ({
			status: 'ok',
			payload: { outcome: 'notices', items: d.held, nextOffset: null },
		}),
		act: async (request) => {
			d.acts.push(request);
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
		host: { inboxStanding: () => d.standing, inbox: port },
		ledger: createInboxReceiptLedger({ now: () => NOW }),
		now: () => NOW,
	});
	return { d, client };
}

const lifecycle = { status: vi.fn(() => UNENROLLED), requestEnrollment: vi.fn() };
const policy = { status: vi.fn(() => POLICY), refresh: vi.fn() };
const identity = { custody: () => ({ state: 'protected' }), read: () => ({ status: 'none' }) };
const commands = {
	status: vi.fn(() => COMMAND_STATUS),
	issueLocal: vi.fn(async () => ({
		status: 'unavailable',
		commandId: null,
		detail: `No command runs on this host: ${NO_ENROLLMENT}`,
	})),
};

// ---------------------------------------------------------------------------
// The harness: the CLI's bridge client drives the real dispatcher.
// ---------------------------------------------------------------------------

describe('maestro-cli managed over the real bridge and facade (MRC2-07-08)', () => {
	let handler: WebSocketMessageHandler;
	let managed: ManagedOperations | null;
	let inbox: ReturnType<typeof inboxDouble>;
	const sent: Array<Record<string, unknown>> = [];
	/** Every message type the suite put on the wire; never cleared. */
	const spoken = new Set<string>();
	const logs: string[] = [];
	const errors: string[] = [];
	let tmp: string;

	const sendCommand = vi.fn(async (payload: Record<string, unknown>, responseType: string) => {
		sent.push(payload);
		spoken.add(payload.type as string);
		const client = {
			id: 'cli-1',
			connectedAt: 0,
			cli: true,
			socket: { send: vi.fn() },
		} as unknown as WebClient;
		handler.handleMessage(client, { requestId: 'req-1', ...payload } as never);
		const send = client.socket.send as ReturnType<typeof vi.fn>;
		await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
		const frame = JSON.parse(send.mock.calls[0][0] as string) as Record<string, unknown>;
		expect(frame.type).toBe(responseType);
		return frame;
	});

	/** Run one verb; the exit code it ended on (null for none) and what it printed. */
	async function run(verb: () => Promise<void>) {
		logs.length = 0;
		errors.length = 0;
		let code: number | null = null;
		try {
			await verb();
		} catch (error) {
			const match = /^__exit__(\d+)$/.exec(error instanceof Error ? error.message : '');
			if (!match) throw error;
			code = Number(match[1]);
		}
		return { code, out: logs.join('\n'), err: errors.join('\n') };
	}
	const json = (out: string) => JSON.parse(out) as Record<string, unknown>;

	beforeEach(() => {
		vi.clearAllMocks();
		sent.length = 0;
		lifecycle.status.mockReturnValue(UNENROLLED);
		policy.status.mockReturnValue(POLICY);
		inbox = inboxDouble();
		managed = createManagedOperations({
			lifecycle: lifecycle as never,
			policy: policy as never,
			identity: identity as never,
			inventory: { snapshot: () => INVENTORY } as never,
			holds: { egress: () => [], update: () => null, listeners: () => [] },
			inbox: inbox.client,
			commands: commands as never,
		});
		handler = new WebSocketMessageHandler();
		handler.setCallbacks({ getManaged: () => managed });
		vi.mocked(withMaestroClient).mockImplementation(async (action) =>
			action({ sendCommand } as never)
		);
		vi.spyOn(console, 'log').mockImplementation((line: unknown) => void logs.push(String(line)));
		vi.spyOn(console, 'error').mockImplementation(
			(line: unknown) => void errors.push(String(line))
		);
		vi.spyOn(process, 'exit').mockImplementation((code) => {
			throw new Error(`__exit__${code ?? 0}`);
		});
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-managed-cli-'));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	it("prints what the facade answers: the reads are the pane's own projections, in JSON and for a person", async () => {
		const facade = managed!;
		const status = await run(() => managedStatus({ json: true }));
		expect(status.code).toBeNull();
		// `at` is the projection's own clock reading; everything else is the pane's state.
		expect(json(status.out)).toEqual({
			success: true,
			state: { ...facade.status(), at: expect.any(String) },
		});
		expect(json(status.out).state).toMatchObject({ standing: 'unenrolled' });
		const human = await run(() => managedStatus({}));
		expect(human.out).toContain('Managed standing: unenrolled');
		expect(human.out).toContain('Enrollment: none');
		expect(human.out).toContain(`Admission: not possible (${NO_ENROLLMENT})`);

		expect(json((await run(() => managedInventory({ json: true }))).out)).toEqual({
			success: true,
			inventory: INVENTORY,
		});
		const matrix = json((await run(() => managedSupportMatrix({ json: true }))).out);
		expect(matrix).toEqual({ success: true, matrix: facade.supportMatrix() });
		expect((matrix.matrix as { routes: unknown[] }).routes.length).toBeGreaterThan(0);
		const locks = await run(() => managedLocks({ json: true }));
		expect(json(locks.out)).toEqual({ success: true, locks: NO_MANAGED_SETTING_LOCKS });
		expect((await run(() => managedLocks({}))).out).toBe(
			'No settings are held by a managed policy.'
		);
		expect(json((await run(() => managedCommandStatus({ json: true }))).out)).toEqual({
			success: true,
			status: COMMAND_STATUS,
		});
		const commandHuman = await run(() => managedCommandStatus({}));
		expect(commandHuman.out).toContain(`Command standing: ${NO_ENROLLMENT}`);
		expect(commandHuman.out).toContain('Executes: command.cancel_run');
		// `--held` reads the held set alone: the endpoint is never asked.
		const held = json((await run(() => managedInboxList({ held: true, json: true }))).out);
		expect(held).toMatchObject({ success: true, listing: { refresh: null } });
		expect(inbox.d.acts).toEqual([]);
		expect(sent.map((m) => m.type)).toEqual([
			'managed_status',
			'managed_status',
			'managed_inventory',
			'managed_support_matrix',
			'managed_locks',
			'managed_locks',
			'managed_command_status',
			'managed_command_status',
			'managed_inbox_list',
		]);
	});

	it('refuses every write on an unmanaged host with its standing: exit 1, the outcome kept in the JSON, nothing sent to the endpoint', async () => {
		policy.refresh.mockResolvedValue({ status: 'unavailable', message: NO_ENROLLMENT });
		const ack = await run(() => managedInboxAct('acknowledged', MESSAGE, {}));
		expect(ack.code).toBe(1);
		expect(ack.err).toContain(NO_ENROLLMENT);
		const reply = await run(() =>
			managedInboxAct('reply', MESSAGE, { message: 'noted', json: true })
		);
		expect(reply.code).toBe(1);
		expect(json(reply.out)).toEqual({
			success: false,
			outcome: { status: 'unavailable', detail: NO_ENROLLMENT },
		});
		const command = await run(() => managedCommand({ kind: 'report-status' }, {}));
		expect(command.code).toBe(1);
		expect(command.err).toContain(`No command runs on this host: ${NO_ENROLLMENT}`);
		expect(commands.issueLocal).toHaveBeenCalledWith({ kind: 'report-status' });
		const refresh = await run(() => managedPolicyRefresh({ json: true }));
		expect(refresh.code).toBe(1);
		expect(json(refresh.out)).toEqual({
			success: false,
			outcome: { status: 'unavailable', message: NO_ENROLLMENT },
		});
		expect((await run(() => managedPolicyRefresh({}))).err).toContain(
			`unavailable: ${NO_ENROLLMENT}`
		);
		// The listing names the standing instead of an empty inbox.
		const list = await run(() => managedInboxList({}));
		expect(list.code).toBeNull();
		expect(list.out).toContain(`Inbox standing: ${NO_ENROLLMENT}`);
		expect(list.out).toContain('Not listed (no-standing)');
		expect(inbox.d.acts).toEqual([]);
		// A reply with no text is refused before anything is sent.
		const bare = await run(() => managedInboxAct('reply', MESSAGE, {}));
		expect(bare.code).toBe(1);
		expect(bare.err).toContain('A reply needs --message <text>.');
		expect(sent.filter((m) => m.type === 'managed_inbox_act')).toHaveLength(2);
	});

	it('records a receipt through the real inbox client under a registered standing and prints it durably; a body is shown only on request', async () => {
		inbox.d.standing = REGISTERED;
		inbox.d.held = [NOTICE];
		const listed = json((await run(() => managedInboxList({ json: true }))).out);
		expect(listed).toMatchObject({
			success: true,
			listing: {
				refresh: { outcome: 'listed', listed: 1, newlyHeld: 1, delivered: { recorded: 1 } },
				view: { notices: [{ messageId: MESSAGE, receipts: { delivered: 'recorded' } }] },
			},
		});
		expect(JSON.stringify(listed)).not.toContain(BODY);
		const withBodies = json((await run(() => managedInboxList({ json: true, bodies: true }))).out);
		expect(
			(withBodies.listing as { view: { notices: Array<{ body: string }> } }).view.notices[0].body
		).toBe(BODY);
		const human = await run(() => managedInboxList({ held: true }));
		expect(human.out).toContain('(bodies withheld; pass --bodies to read them)');
		expect(human.out).not.toContain(BODY);
		expect((await run(() => managedInboxList({ held: true, bodies: true }))).out).toContain(BODY);

		const read = await run(() => managedInboxAct('read', MESSAGE, {}));
		expect(read.code).toBeNull();
		expect(read.out).toContain(`Receipt rcpt-read: read recorded (read) on ${MESSAGE}, key `);
		const reply = await run(() =>
			managedInboxAct('reply', MESSAGE, { message: 'Thanks, noted.', json: true })
		);
		expect(reply.code).toBeNull();
		expect(json(reply.out)).toMatchObject({
			success: true,
			outcome: {
				status: 'recorded',
				duplicate: false,
				record: {
					action: 'reply',
					state: 'recorded',
					reply: { length: 14 },
					receipt: { receiptId: 'rcpt-reply', state: 'replied' },
				},
			},
		});
		// The text reached the endpoint and never the receipt the CLI prints.
		expect(inbox.d.acts.map((a) => a.action)).toEqual([
			{ kind: 'delivered' },
			{ kind: 'read' },
			{ kind: 'reply', text: 'Thanks, noted.' },
		]);
		expect(reply.out).not.toContain('Thanks, noted.');
		// A repeat is answered from the ledger: nothing sent again.
		const again = json((await run(() => managedInboxAct('read', MESSAGE, { json: true }))).out);
		expect(again).toMatchObject({
			success: true,
			outcome: { status: 'recorded', duplicate: true },
		});
		expect(inbox.d.acts).toHaveLength(3);
		const unknown = await run(() => managedInboxAct('acknowledged', 'nope', { json: true }));
		expect(unknown.code).toBe(1);
		expect(json(unknown.out)).toMatchObject({
			success: false,
			outcome: { status: 'denied', reason: 'unknown-message' },
		});
	});

	it('never prints a secret: the enrollment request is relayed from its file and refused by field name, not by value', async () => {
		lifecycle.requestEnrollment.mockResolvedValue({
			status: 'refused',
			reason: 'already-enrolled',
			message: 'This installation is enrolled already.',
		});
		const file = path.join(tmp, 'request.json');
		fs.writeFileSync(file, JSON.stringify(ENROLL));
		const relayed = await run(() =>
			managedEnrollRequest({ file, json: true, tenant: 'tenant-2', profile: 'full' })
		);
		expect(relayed.code).toBe(1);
		expect(json(relayed.out)).toEqual({
			success: false,
			outcome: {
				status: 'refused',
				reason: 'already-enrolled',
				message: 'This installation is enrolled already.',
			},
		});
		// The request reached the lifecycle whole, the flags over the file's non-secret fields.
		expect(lifecycle.requestEnrollment).toHaveBeenCalledWith({
			...ENROLL,
			tenantId: 'tenant-2',
			collectionProfile: 'full',
		});
		expect(sent.at(-1)).toEqual({
			type: 'managed_enroll_request',
			request: { ...ENROLL, tenantId: 'tenant-2', collectionProfile: 'full' },
		});
		const human = await run(() => managedEnrollRequest({ file }));
		expect(human.code).toBe(1);
		expect(human.err).toContain('refused (already-enrolled)');
		for (const secret of SECRETS) {
			expect(relayed.out + relayed.err).not.toContain(secret);
			expect(human.out + human.err).not.toContain(secret);
		}

		const short = path.join(tmp, 'short.json');
		const { invitation: _i, keyPossessionProof: _p, ...rest } = ENROLL;
		fs.writeFileSync(short, JSON.stringify(rest));
		const missing = await run(() => managedEnrollRequest({ file: short, json: true }));
		expect(missing.code).toBe(1);
		expect(json(missing.out)).toEqual({
			success: false,
			error: 'The enrollment request is missing: invitation, keyPossessionProof.',
		});
		const broken = path.join(tmp, 'broken.json');
		fs.writeFileSync(broken, `{ "invitation": "${ENROLL.invitation}", `);
		const notJson = await run(() => managedEnrollRequest({ file: broken }));
		expect(notJson.code).toBe(1);
		expect(notJson.err).toContain(
			'Could not read the enrollment request file: it is not valid JSON.'
		);
		expect(notJson.err).not.toContain(ENROLL.invitation);
		const absent = await run(() =>
			managedEnrollRequest({ file: path.join(tmp, 'none.json'), json: true })
		);
		expect(json(absent.out)).toEqual({
			success: false,
			error: 'Could not read the enrollment request file: ENOENT.',
		});
		expect(lifecycle.requestEnrollment).toHaveBeenCalledTimes(2);
		expect(ENROLLMENT_REQUEST_FIELDS).toEqual(Object.keys(ENROLL));
	});

	it('maps an absent desktop to exit 3, an older one to exit 4 and one with no service to exit 1', async () => {
		sendCommand.mockRejectedValueOnce(new MaestroNotRunningError('not-running' as never));
		const absent = await run(() => managedStatus({ json: true }));
		expect(absent.code).toBe(3);
		expect(json(absent.out)).toMatchObject({ success: false, code: 'MAESTRO_NOT_RUNNING' });
		sendCommand.mockRejectedValueOnce(new UnsupportedCommandError('managed_status' as never));
		const older = await run(() => managedStatus({}));
		expect(older.code).toBe(4);
		expect(older.err).toContain('managed_status');
		managed = null;
		const none = await run(() => managedLocks({ json: true }));
		expect(none.code).toBe(1);
		expect(json(none.out)).toEqual({ success: false, error: NO_MANAGED_SERVICE_MESSAGE });
		expect((await run(() => managedInboxList({}))).err).toContain(NO_MANAGED_SERVICE_MESSAGE);
	});

	it('opens the managed pane as a registered surface, by id and by every alias, with no tab to name', async () => {
		const opened: Array<Record<string, unknown>> = [];
		vi.mocked(withMaestroClient).mockImplementation(async (action) =>
			action({
				sendCommand: vi.fn(async (payload: Record<string, unknown>) => {
					opened.push(payload);
					return { type: 'open_modal_result', success: true };
				}),
			} as never)
		);
		for (const name of ['managed-status', 'mega-maestro', 'enterprise', 'managed-inbox']) {
			expect(resolveUiSurface(name)?.id, name).toBe('managed-status');
			const result = await run(() => openModal(name, { json: true }));
			expect(result.code).toBeNull();
			expect(json(result.out)).toMatchObject({
				success: true,
				surface: 'managed-status',
				label: 'Mega-Maestro Management',
				command_palette: 'Mega-Maestro Management',
				hint: expect.stringContaining('Mega-Maestro Management'),
			});
		}
		expect(opened).toEqual(
			Array(4).fill({ type: 'open_modal', surface: 'managed-status', tab: undefined })
		);
		const tab = await run(() => openModal('managed-status', { tab: 'environment', json: true }));
		expect(tab.code).toBe(1);
		expect(json(tab.out).error).toContain('has no tabs');
		const listed = await run(() => openModal(undefined, { list: true, json: true }));
		const entry = (json(listed.out) as unknown as Array<Record<string, unknown>>).find(
			(s) => s.id === 'managed-status'
		);
		expect(entry).toMatchObject({
			aliases: ['mega-maestro', 'enterprise', 'managed-inbox'],
			tabs: [],
			encore: '',
		});
	});

	it('spoke every one of the ten managed message types and nothing else', () => {
		expect([...spoken].sort()).toEqual([...MANAGED_MESSAGE_TYPES].sort());
	});
});
