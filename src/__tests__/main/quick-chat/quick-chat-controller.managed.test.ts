/**
 * Quick Chat under management (MRC2-02-03A, MRC2-02-03B, MRC2-02-07).
 *
 * The controller only relays a command to the renderer engine, so no
 * transport context survives the hop to the two spawns a `send` causes: the
 * tab turn comes back as `process:spawn`, the routing turn as
 * `context:groomContext`. These tests drive the REAL controller through the
 * real WebSocket message handler (the client context it establishes), the
 * real ticket registry, the real `process:spawn` handler and `ProcessManager`,
 * and the real lease authority behind `fakeSpawnPort` or the desktop's own
 * `createProcessSpawnAuthority` (only the policy answer is a table). Each
 * guard here has a test that fails when the guard is removed:
 *
 * - a send over a transport carries one host-minted ticket per spawn, bound
 *   to the engine agent; the tab turn claims its own at the spawn sink and is
 *   admitted with the transport's origin (`cli`), the routing turn claims its
 *   own at the `context:groomContext` handler; the window's send carries none;
 * - a web actor the managed host cannot resolve (a paired Lite device before
 *   the enrollment registers an actor) is refused `unauthenticated` by the
 *   desktop's spawn authority: nothing spawned, no lease left, the reason in
 *   the tab; a registered enrollment binds the device as attribution;
 * - a forged, spent or mismatched ticket binds the caller as itself, never
 *   what it claimed, and a send the engine refused withdraws both tickets;
 * - a standalone host is unchanged: no admission, still classified.
 */
import * as os from 'os';
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('electron', () => ({
	ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn() },
	app: { getPath: (): string => os.tmpdir() },
	safeStorage: { isEncryptionAvailable: (): boolean => false },
	BrowserWindow: class {},
}));
vi.mock('node-pty', () => ({ spawn: vi.fn() }));
const logger = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('../../../main/utils/logger', () => ({ logger }));
vi.mock('../../../main/utils/sentry', () => ({
	captureException: vi.fn(async () => undefined),
	captureMessage: vi.fn(async () => undefined),
	addBreadcrumb: vi.fn(async () => undefined),
}));
vi.mock('../../../main/coworking/coworking-socket-path', () => ({
	getBridgeSocketPath: () => '/tmp/maestro-test-coworking.sock',
}));
vi.mock('../../../main/plugins/plugin-manager-singleton', () => ({
	getPluginManager: () => null,
	getActivePluginManager: () => null,
	isPluginsFeatureEnabled: () => false,
}));
vi.mock('../../../main/global-hotkey-manager', () => ({
	setNamedGlobalHotkey: vi.fn(() => true),
	summonAppWindow: vi.fn(),
}));
vi.mock('../../../main/quick-chat/quick-chat-window', () => ({
	closeQuickChatWindow: vi.fn(),
	getQuickChatWindow: () => null,
	getQuickChatFontScale: () => 1,
	getQuickChatWindowBounds: () => null,
	hideQuickChatWindow: vi.fn(),
	isQuickChatWindowPinned: () => false,
	isQuickChatWindowVisible: () => false,
	setQuickChatFontScale: vi.fn(),
	setQuickChatCompactHeight: vi.fn(),
	setQuickChatFullView: vi.fn(),
	setQuickChatLayout: vi.fn(),
	setQuickChatWindowPinned: vi.fn(),
	setQuickChatWindowBounds: vi.fn(),
	showQuickChatWindow: vi.fn(),
	toggleQuickChatWindow: vi.fn(),
}));
vi.mock('../../../main/quick-chat/quick-chat-recents', () => ({
	createQuickChatRecents: () => ({ list: () => [], get: () => null, save: () => true }),
	createQuickChatRecentsDiskStore: () => ({}),
}));
const requestFromRenderer = vi.fn();
vi.mock('../../../main/web-server/callbacks/remoteRequest', () => ({
	requestFromRenderer: (...args: unknown[]) => requestFromRenderer(...args),
}));
// The routing turn's own subject is the groomer (context-groomer.managed.test.ts
// proves a host-secret actor is admitted `origin: cli` at the sink); here it is
// a double that records the actor the handler claimed into.
const groomContext = vi.fn();
vi.mock('../../../main/utils/context-groomer', () => ({
	groomContext: (...args: unknown[]) => groomContext(...args),
	cancelAllGroomingSessions: vi.fn(),
}));
vi.mock('../../../main/stores', () => ({ getSettingsStore: vi.fn() }));

import { ipcMain } from 'electron';
import { getAgentCapabilities } from '../../../main/agents';
import type { AgentDetector } from '../../../main/agents';
import { getAgentDefinition } from '../../../main/agents/definitions';
import { createProcessSpawnAuthority } from '../../../main/enterprise/spawn-authority';
import type { IdentityRead } from '../../../main/enterprise/identity-store';
import { registerContextHandlers } from '../../../main/ipc/handlers/context';
import { handleProcessSpawn } from '../../../main/ipc/handlers/process/handle-spawn';
import type { SpawnHandlerDependencies } from '../../../main/ipc/handlers/process/handle-spawn';
import type { SpawnProcessConfig } from '../../../main/ipc/handlers/process/spawn-types';
import { ProcessManager } from '../../../main/process-manager';
import { spawnOriginOf, type ProcessConfig } from '../../../main/process-manager/types';
import { createQuickChatController } from '../../../main/quick-chat/quick-chat-controller';
import {
	claimDispatchTicket,
	runAsTransport,
	type TransportAdmission,
} from '../../../main/web-server/auth/transport-actor';
import { WebSocketMessageHandler } from '../../../main/web-server/handlers/messageHandlers';
import type { WebClient } from '../../../main/web-server/handlers/messageHandlers';
import {
	EMPTY_QUICK_CHAT_SNAPSHOT,
	QUICK_CHAT_SETTINGS_KEY,
	type QuickChatCommand,
} from '../../../shared/quickChat';
import { fakeSpawnPort, type FakeSpawnPort } from '../../helpers/managedSpawnPort';

const AGENT = '11111111-2222-4333-8444-555555555555';
const TAB = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const PROCESS = `${AGENT}-ai-${TAB}`;
const INSTALLATION = { installationId: 'inst-1', runtimeId: 'desktop-1', processEpoch: 'e1' };
const CLI: TransportAdmission = { kind: 'cli' };

type SendCommand = Extract<QuickChatCommand, { type: 'send' }>;
type GroomHandler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

/** The command the engine was handed on the n-th relay. */
const relayed = (n: number): QuickChatCommand => requestFromRenderer.mock.calls[n][2].args[0];
const sent = (n: number): SendCommand => relayed(n) as SendCommand;
const okWith = (agentId: string | null) => ({
	ok: true,
	snapshot: { ...EMPTY_QUICK_CHAT_SNAPSHOT, agentId },
});

const window = {
	isDestroyed: (): boolean => false,
	webContents: { isDestroyed: (): boolean => false, send: vi.fn() },
};

function makeController(settingsAgentId = AGENT) {
	const store = new Map<string, unknown>([
		['encoreFeatures', { quickChat: true }],
		[QUICK_CHAT_SETTINGS_KEY, { agentId: settingsAgentId }],
	]);
	return createQuickChatController({
		settingsStore: { get: (k) => store.get(k), onDidChange: vi.fn() },
		windowDeps: {} as never,
		getMainWindow: () => window as never,
		getWindowForSession: () => window as never,
	});
}

/** A socket as the upgrade admitted it: the CLI secret, a Web Login account, or a paired device. */
function client(extra: Partial<WebClient> = {}): WebClient {
	return {
		socket: { send: vi.fn() } as unknown as WebClient['socket'],
		id: 'client-1',
		connectedAt: 0,
		...extra,
	};
}
const DEVICE = client({
	admission: 'device-pairing',
	user: { id: 'paired-device:dev-7', username: 'paired-device', displayName: 'Pixel 9' } as never,
});
const LOGIN = client({ user: { id: 'u1', username: 'ada', displayName: 'Ada' } as never });

/**
 * A `quick_chat send` over the WebSocket handler, which runs the controller
 * inside the client context the upgrade established, and the engine's answer.
 */
async function sendOver(socket: WebClient, text = 'hi'): Promise<Record<string, unknown>> {
	const handler = new WebSocketMessageHandler();
	handler.handleMessage(socket, { type: 'quick_chat', action: 'send', text, requestId: 'r1' });
	const send = socket.socket.send as Mock;
	await vi.waitFor(() => expect(send).toHaveBeenCalled());
	return JSON.parse(send.mock.calls[send.mock.calls.length - 1][0] as string);
}

function fakeStore(data: Record<string, unknown>) {
	return {
		get: (key: string, fallback?: unknown) => (key in data ? data[key] : fallback),
		set: (key: string, value: unknown) => {
			data[key] = value;
		},
	};
}

function payload(overrides: Partial<SpawnProcessConfig> = {}): SpawnProcessConfig {
	const definition = getAgentDefinition('codex');
	if (!definition) throw new Error('no codex definition');
	return {
		sessionId: PROCESS,
		toolType: 'codex',
		cwd: os.tmpdir(),
		command: definition.command,
		args: [...definition.args],
		prompt: 'List the files.',
		readOnlyMode: false,
		permissionMode: 'full',
		querySource: 'user',
		tabId: TAB,
		...overrides,
	};
}

/** The real spawn handler over the real manager and the port given, `spawn` replaced last. */
function spawnHarness(port: FakeSpawnPort | ReturnType<typeof createProcessSpawnAuthority>) {
	const definition = getAgentDefinition('codex');
	if (!definition) throw new Error('no codex definition');
	const agent = {
		...definition,
		available: true,
		path: '/usr/local/bin/codex',
		capabilities: getAgentCapabilities('codex'),
	};
	const processManager = new ProcessManager(() => true, { spawnAuthority: () => port });
	const errors: string[] = [];
	processManager.on('agent-error', (_sessionId: string, error: { message: string }) => {
		errors.push(error.message);
	});
	const spawn = vi.spyOn(processManager, 'spawn').mockImplementation((() => ({
		pid: 4242,
		success: true,
	})) as never);
	const deps: SpawnHandlerDependencies = {
		getProcessManager: () => processManager,
		getAgentDetector: () =>
			({
				getAgent: async (id: string) => (id === 'codex' ? agent : null),
			}) as never as AgentDetector,
		agentConfigsStore: fakeStore({ configs: {} }) as never,
		settingsStore: fakeStore({ shellEnvVars: {} }) as never,
		sessionsStore: fakeStore({
			sessions: [
				{ id: AGENT, name: 'Backend', toolType: 'codex', cwd: os.tmpdir(), aiTabs: [{ id: TAB }] },
			],
		}) as never,
		getMainWindow: () => window as never,
		safeSend: vi.fn(),
	};
	const admitted = (): ProcessConfig => {
		expect(spawn).toHaveBeenCalledOnce();
		return spawn.mock.calls[0][0] as ProcessConfig;
	};
	return { deps, spawn, errors, admitted };
}

/** The desktop's own spawn authority over an enrollment read, its decisions in `table`. */
function realAuthority(read: IdentityRead) {
	const table = fakeSpawnPort();
	const port = createProcessSpawnAuthority({
		installation: INSTALLATION,
		identity: { read: () => read },
		host: { policy: () => ({ sources: [], policyRevision: 1 }) },
		dispatch: { authority: table.authority },
		now: () => 1_000_000,
	});
	return { port, table };
}
const UNREGISTERED: IdentityRead = { status: 'ok', record: {} as never, epoch: 1 };
const REGISTERED: IdentityRead = {
	status: 'ok',
	record: { registration: { actorId: 'actor-registered' } } as never,
	epoch: 1,
};

/** The `context:groomContext` handler the context module registered. */
function groomHandler(): GroomHandler {
	registerContextHandlers({
		getMainWindow: () => null,
		getProcessManager: () => ({}) as never,
		getAgentDetector: () => ({}) as never,
		agentConfigsStore: { get: () => ({}) } as never,
		settingsStore: { get: (_k: string, fallback: unknown) => fallback } as never,
	});
	const call = (ipcMain.handle as Mock).mock.calls.find(([c]) => c === 'context:groomContext');
	return call![1] as GroomHandler;
}

beforeEach(() => {
	vi.clearAllMocks();
	requestFromRenderer.mockReset();
	groomContext.mockReset().mockResolvedValue({ response: 'pick', durationMs: 1 });
});

describe('Quick Chat under management: the two spawns of a send are admitted for the transport', () => {
	it('a window send (outside any transport context) relays the command bare, and its tab turn is admitted at the desktop', async () => {
		const controller = makeController();
		requestFromRenderer.mockResolvedValue(okWith(AGENT));
		const result = await controller.runCommand({ type: 'send', text: 'hi' });
		expect(result.ok).toBe(true);
		expect(relayed(0)).toEqual({ type: 'send', text: 'hi' });
		const port = fakeSpawnPort();
		const h = spawnHarness(port);
		await handleProcessSpawn(payload(), h.deps);
		expect(port.asked[0].snapshot).toMatchObject({ purpose: 'conversation', origin: 'desktop' });
		expect(h.admitted().admission?.leaseId).toBe(port.authority.live()[0].leaseId);
	});

	it('a maestro-cli send over the WebSocket handler carries two distinct single-use tickets bound to the engine agent', async () => {
		makeController();
		requestFromRenderer.mockResolvedValue(okWith(AGENT));
		expect(await sendOver(client({ cli: true }))).toMatchObject({ success: true, requestId: 'r1' });
		expect(requestFromRenderer).toHaveBeenCalledTimes(1);
		const cmd = sent(0);
		expect(cmd.text).toBe('hi');
		expect(typeof cmd.dispatchTicket).toBe('string');
		expect(typeof cmd.routingTicket).toBe('string');
		expect(cmd.dispatchTicket).not.toBe(cmd.routingTicket);
		// The tab turn claims for the agent and whichever tab the engine picked; once.
		expect(claimDispatchTicket(cmd.dispatchTicket!, { agentId: AGENT, tabId: TAB })).toEqual(CLI);
		expect(
			claimDispatchTicket(cmd.dispatchTicket!, { agentId: AGENT, tabId: TAB })
		).toBeUndefined();
		// The routing turn claims for the agent alone; once.
		expect(claimDispatchTicket(cmd.routingTicket!, { agentId: AGENT })).toEqual(CLI);
		expect(claimDispatchTicket(cmd.routingTicket!, { agentId: AGENT })).toBeUndefined();
	});

	it('the tab turn claims its ticket at the spawn sink: admitted origin cli with the live lease on the config, the ticket stripped', async () => {
		makeController();
		requestFromRenderer.mockResolvedValue(okWith(AGENT));
		await sendOver(client({ cli: true }));
		const port = fakeSpawnPort();
		const h = spawnHarness(port);
		const result = await handleProcessSpawn(
			payload({ dispatchTicket: sent(0).dispatchTicket }),
			h.deps
		);
		expect(result.success).toBe(true);
		expect(port.asked).toHaveLength(1);
		expect(port.asked[0].snapshot).toMatchObject({ purpose: 'conversation', origin: 'cli' });
		expect(port.asked[0].context.delegation.chain).toEqual([]);
		const admitted = h.admitted();
		expect(admitted.origin).toBe('cli');
		expect('dispatchTicket' in admitted).toBe(false);
		const live = port.authority.live();
		expect(live).toHaveLength(1);
		expect(admitted.admission?.leaseId).toBe(live[0].leaseId);
	});

	it('the routing turn claims its ticket at the groomContext handler into the actor the groomer is handed (origin cli)', async () => {
		makeController();
		requestFromRenderer.mockResolvedValue(okWith(AGENT));
		await sendOver(client({ cli: true }));
		const handler = groomHandler();
		await handler({}, '/p', 'claude-code', 'pick', {
			lineage: { sessionId: AGENT },
			dispatchTicket: sent(0).routingTicket,
			cheapTurn: true,
			readOnly: true,
			disableTools: true,
		});
		const options = groomContext.mock.calls[0][0];
		expect(options.actor).toEqual({ peer: 'host-secret' });
		expect(spawnOriginOf(options.actor)).toBe('cli');
		expect(options.lineage).toEqual({ sessionId: AGENT });
		expect(options.readOnlyMode).toBe(true);
		expect(claimDispatchTicket(sent(0).routingTicket!, { agentId: AGENT })).toBeUndefined();
	});

	it('a Web Login send is admitted with the account on the delegation chain, by the desktop spawn authority', async () => {
		makeController();
		requestFromRenderer.mockResolvedValue(okWith(AGENT));
		await sendOver(LOGIN);
		const { port, table } = realAuthority(UNREGISTERED);
		const h = spawnHarness(port);
		const result = await handleProcessSpawn(
			payload({ dispatchTicket: sent(0).dispatchTicket }),
			h.deps
		);
		expect(result.success).toBe(true);
		expect(table.asked).toHaveLength(1);
		expect(table.asked[0].context.delegation.chain).toEqual([
			{ kind: 'human', id: 'web-login:ada' },
		]);
		expect(table.asked[0].context.verification.peer).toBe('web-login');
		expect(table.asked[0].snapshot.origin).toBe('desktop');
		expect(h.admitted().admission?.leaseId).toBe(table.authority.live()[0].leaseId);
	});
});

describe('Quick Chat under management: a web actor the host cannot resolve is refused', () => {
	it('a paired device send before the enrollment registers an actor is refused unauthenticated: nothing spawned, no lease, the reason in the tab', async () => {
		makeController();
		requestFromRenderer.mockResolvedValue(okWith(AGENT));
		await sendOver(DEVICE);
		const cmd = sent(0);
		expect(typeof cmd.dispatchTicket).toBe('string');
		const { port, table } = realAuthority(UNREGISTERED);
		const h = spawnHarness(port);
		await expect(
			handleProcessSpawn(payload({ dispatchTicket: cmd.dispatchTicket }), h.deps)
		).rejects.toThrow(/paired Lite device \(dev-7\) admits its transport only/);
		expect(h.spawn).not.toHaveBeenCalled();
		// Refused at the verifier: the policy was never asked and no lease exists.
		expect(table.asked).toHaveLength(0);
		expect(table.authority.live()).toHaveLength(0);
		expect(h.errors).toEqual([expect.stringMatching(/none is registered/)]);
	});

	it('the same device send is admitted once an actor is registered, the device as attribution and never the principal', async () => {
		makeController();
		requestFromRenderer.mockResolvedValue(okWith(AGENT));
		await sendOver(DEVICE);
		const { port, table } = realAuthority(REGISTERED);
		const h = spawnHarness(port);
		const result = await handleProcessSpawn(
			payload({ dispatchTicket: sent(0).dispatchTicket }),
			h.deps
		);
		expect(result.success).toBe(true);
		expect(table.asked[0].context.delegation.chain).toEqual([
			{ kind: 'service', id: 'lite-device:dev-7' },
		]);
		expect(table.asked[0].context.actor).toEqual({ kind: 'human', id: 'actor-registered' });
		expect(table.asked[0].context.verification.peer).toBe('device-pairing');
		expect(h.admitted().origin).toBe('desktop');
	});
});

describe('Quick Chat under management: a ticket is worth only what the registry says', () => {
	it('a ticket claimed for another agent is burned, and the spawn then binds the caller as itself (desktop), never cli', async () => {
		makeController();
		requestFromRenderer.mockResolvedValue(okWith(AGENT));
		await sendOver(client({ cli: true }));
		const cmd = sent(0);
		expect(claimDispatchTicket(cmd.dispatchTicket!, { agentId: 'another-agent' })).toBeUndefined();
		const port = fakeSpawnPort();
		const h = spawnHarness(port);
		await handleProcessSpawn(payload({ dispatchTicket: cmd.dispatchTicket }), h.deps);
		expect(port.asked[0].snapshot.origin).toBe('desktop');
		expect(h.admitted().origin).toBe('desktop');
		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining('Dispatch ticket not honored'),
			expect.anything(),
			expect.objectContaining({ agentId: AGENT })
		);
	});

	it('a send the engine refused withdraws both tickets, so neither can be spent later', async () => {
		makeController();
		requestFromRenderer.mockResolvedValue({
			ok: false,
			error: 'Wait',
			snapshot: { ...EMPTY_QUICK_CHAT_SNAPSHOT, agentId: AGENT },
		});
		expect(await sendOver(client({ cli: true }))).toMatchObject({ success: false, error: 'Wait' });
		const cmd = sent(0);
		expect(claimDispatchTicket(cmd.dispatchTicket!, { agentId: AGENT })).toBeUndefined();
		expect(claimDispatchTicket(cmd.routingTicket!, { agentId: AGENT })).toBeUndefined();
	});

	it('a forged ticket on the routing turn binds the caller as itself and the turn still runs', async () => {
		const handler = groomHandler();
		await handler({}, '/p', 'claude-code', 'pick', {
			lineage: { sessionId: AGENT },
			dispatchTicket: 'forged',
		});
		expect(groomContext.mock.calls[0][0].actor).toEqual({ peer: 'in-process' });
	});
});

describe('Quick Chat tickets: which commands and which agent', () => {
	it('the agent the engine last reported wins over the configured one', async () => {
		const controller = makeController('agent-cfg');
		requestFromRenderer.mockResolvedValue(okWith('agent-live'));
		await runAsTransport(CLI, () => controller.runCommand({ type: 'send', text: 'one' }));
		expect(claimDispatchTicket(sent(0).dispatchTicket!, { agentId: 'agent-cfg' })).toEqual(CLI);
		await runAsTransport(CLI, () => controller.runCommand({ type: 'send', text: 'two' }));
		expect(claimDispatchTicket(sent(1).dispatchTicket!, { agentId: 'agent-live' })).toEqual(CLI);
	});

	it('with no agent known it syncs first and binds the agent the engine reports; none even then relays bare', async () => {
		const controller = makeController('');
		requestFromRenderer.mockResolvedValue(okWith('agent-found'));
		await runAsTransport(CLI, () => controller.runCommand({ type: 'send', text: 'hi' }));
		expect(requestFromRenderer).toHaveBeenCalledTimes(2);
		expect(relayed(0)).toEqual({ type: 'sync' });
		expect(claimDispatchTicket(sent(1).dispatchTicket!, { agentId: 'agent-found' })).toEqual(CLI);
		expect(claimDispatchTicket(sent(1).routingTicket!, { agentId: 'agent-found' })).toEqual(CLI);

		const bare = makeController('');
		requestFromRenderer.mockReset().mockResolvedValue(okWith(null));
		await runAsTransport(CLI, () => bare.runCommand({ type: 'send', text: 'hi' }));
		expect(requestFromRenderer).toHaveBeenCalledTimes(2);
		expect(relayed(1)).toEqual({ type: 'send', text: 'hi' });
	});

	it('a window send never syncs, even with no agent known', async () => {
		const controller = makeController('');
		requestFromRenderer.mockResolvedValue(okWith(null));
		await controller.runCommand({ type: 'send', text: 'hi' });
		expect(requestFromRenderer).toHaveBeenCalledTimes(1);
		expect(relayed(0)).toEqual({ type: 'send', text: 'hi' });
	});

	it.each<QuickChatCommand>([
		{ type: 'recall', chatId: 'c1' },
		{ type: 'new' },
		{ type: 'moveToNewTab' },
		{ type: 'setAgent', agentId: AGENT },
		{ type: 'sync' },
	])('a CLI %o spawns nothing and issues no ticket', async (command) => {
		const controller = makeController();
		requestFromRenderer.mockResolvedValue(okWith(AGENT));
		await runAsTransport(CLI, () => controller.runCommand(command));
		expect(requestFromRenderer).toHaveBeenCalledTimes(1);
		expect(relayed(0)).toEqual(command);
	});

	it('a recall of an unknown chat is refused before the engine and issues no ticket', async () => {
		const controller = makeController();
		const result = await runAsTransport(CLI, () => controller.recall('nope'));
		expect(result.ok).toBe(false);
		expect(requestFromRenderer).not.toHaveBeenCalled();
	});
});

describe('Quick Chat on a standalone host: unchanged', () => {
	it('a ticketed CLI send spawns with no admission, asks nobody, and is still classified by its origin', async () => {
		makeController();
		requestFromRenderer.mockResolvedValue(okWith(AGENT));
		await sendOver(client({ cli: true }));
		const port = fakeSpawnPort({ standing: 'standalone' });
		const h = spawnHarness(port);
		const result = await handleProcessSpawn(
			payload({ dispatchTicket: sent(0).dispatchTicket }),
			h.deps
		);
		expect(result.success).toBe(true);
		expect(port.asked).toHaveLength(0);
		const admitted = h.admitted();
		expect(admitted.admission).toBeUndefined();
		expect(admitted).toMatchObject({ purpose: 'conversation', origin: 'cli' });
		expect('dispatchTicket' in admitted).toBe(false);
	});
});
