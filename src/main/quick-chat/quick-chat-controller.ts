/**
 * Quick Chat controller - the main-process hub between the Quick Chat window,
 * the app renderer that runs the conversation (the "engine", see
 * useQuickChatEngine), the system-wide hotkey, and `maestro-cli quick-chat`.
 *
 * The window and the CLI call the same functions here, so a CLI action takes
 * exactly the path a click in the window does.
 */

import { ipcMain, type BrowserWindow } from 'electron';
import { resolveEncoreFeatures } from '../../shared/encoreFeatureDefaults';
import {
	EMPTY_QUICK_CHAT_SNAPSHOT,
	QUICK_CHAT_SETTINGS_KEY,
	resolveQuickChatSettings,
	resolveQuickChatRecentRef,
	summarizeQuickChatRecent,
	type QuickChatBoundsRequest,
	type QuickChatFontScaleRequest,
	parseQuickChatFontScaleRequest,
	type QuickChatCommand,
	type QuickChatCommandResult,
	type QuickChatLayout,
	type QuickChatRecentSummary,
	type QuickChatSnapshot,
	type QuickChatStatus,
	type QuickChatWindowAction,
} from '../../shared/quickChat';
import { setNamedGlobalHotkey, summonAppWindow } from '../global-hotkey-manager';
import { logger } from '../utils/logger';
import { isWebContentsAvailable } from '../utils/safe-send';
import {
	describeTransportAdmission,
	getActingTransport,
	issueDispatchTicket,
	withdrawDispatchTicket,
} from '../web-server/auth/transport-actor';
import { requestFromRenderer } from '../web-server/callbacks/remoteRequest';
import {
	createQuickChatRecents,
	createQuickChatRecentsDiskStore,
	type QuickChatRecentsStore,
} from './quick-chat-recents';
import {
	closeQuickChatWindow,
	getQuickChatWindow,
	getQuickChatFontScale,
	getQuickChatWindowBounds,
	hideQuickChatWindow,
	isQuickChatWindowPinned,
	isQuickChatWindowVisible,
	setQuickChatFontScale,
	setQuickChatCompactHeight,
	setQuickChatFullView,
	setQuickChatLayout,
	setQuickChatWindowPinned,
	setQuickChatWindowBounds,
	showQuickChatWindow,
	toggleQuickChatWindow,
	type QuickChatWindowDeps,
} from './quick-chat-window';

const HOTKEY_ID = 'quickChat';
/** A send can wait on a tab being created and a spawn starting; give it room. */
const COMMAND_TIMEOUT_MS = 10_000;

/** The slice of the settings store the controller reads. */
export interface QuickChatSettingsStore {
	get(key: string): unknown;
	onDidChange(key: string, callback: (value: unknown) => void): unknown;
}

export interface QuickChatControllerDeps {
	settingsStore: QuickChatSettingsStore;
	windowDeps: QuickChatWindowDeps;
	getMainWindow: () => BrowserWindow | null;
	/** The app window that owns an agent, or the main window when none does. */
	getWindowForSession: (sessionId: string) => BrowserWindow | null;
	/** Where the recent chats persist. Defaults to their own store on disk. */
	recentsStore?: QuickChatRecentsStore;
}

export interface QuickChatController {
	/** Register IPC handlers and the hotkey, and follow settings changes. Call once. */
	init(): void;
	runCommand(command: QuickChatCommand): Promise<QuickChatCommandResult>;
	windowAction(action: QuickChatWindowAction): QuickChatStatus;
	/** Move or resize the window as a drag would (validated by the caller). */
	setBounds(request: QuickChatBoundsRequest): QuickChatStatus;
	/** Float the window above other windows, or let it fall behind them. */
	setPinned(pinned: boolean): QuickChatStatus;
	/** Change the conversation's text zoom. */
	setFontScale(request: QuickChatFontScaleRequest): QuickChatStatus;
	getStatus(): QuickChatStatus;
	/** The recent chats, newest first. */
	getRecents(): QuickChatRecentSummary[];
	/** Bring back a recent chat named by id, id prefix, or 1-based place in the list. */
	recall(ref: string): Promise<QuickChatCommandResult>;
}

/** The app's one controller, for callers outside the DI graph (the CLI bridge). */
let activeController: QuickChatController | null = null;

export function getQuickChatController(): QuickChatController | null {
	return activeController;
}

export function createQuickChatController(deps: QuickChatControllerDeps): QuickChatController {
	const { settingsStore, windowDeps } = deps;
	let snapshot: QuickChatSnapshot = { ...EMPTY_QUICK_CHAT_SNAPSHOT };
	let hotkeyRegistered = false;
	const recents = createQuickChatRecents(deps.recentsStore ?? createQuickChatRecentsDiskStore());

	const isEnabled = () => resolveEncoreFeatures(settingsStore.get('encoreFeatures')).quickChat;
	const readSettings = () => resolveQuickChatSettings(settingsStore.get(QUICK_CHAT_SETTINGS_KEY));

	const pushSnapshotToWindow = () => {
		const win = getQuickChatWindow();
		if (win && isWebContentsAvailable(win)) win.webContents.send('quickChat:snapshot', snapshot);
	};

	/** The app window whose renderer runs the conversation. */
	const resolveEngineWindow = (): BrowserWindow | null => {
		const agentId = readSettings().agentId || snapshot.agentId;
		return agentId ? deps.getWindowForSession(agentId) : deps.getMainWindow();
	};

	const getStatus = (): QuickChatStatus => ({
		enabled: isEnabled(),
		visible: isQuickChatWindowVisible(),
		hotkey: readSettings().hotkey,
		hotkeyRegistered,
		bounds: getQuickChatWindowBounds(),
		pinned: isQuickChatWindowPinned(windowDeps),
		fontScale: getQuickChatFontScale(windowDeps),
		snapshot,
	});

	/** Hand a command to the engine and keep the state it reports. */
	const relay = async (
		win: BrowserWindow,
		command: QuickChatCommand
	): Promise<QuickChatCommandResult> => {
		const result = await requestFromRenderer<QuickChatCommandResult>(win, 'quickChat:command', {
			args: [command],
			timeoutMs: COMMAND_TIMEOUT_MS,
			fallback: { ok: false, error: 'Maestro did not answer', snapshot },
		});
		snapshot = result.snapshot;
		pushSnapshotToWindow();
		return result;
	};

	/**
	 * The agent the engine sends to: the one it last reported (its own answer,
	 * so a chat in progress stays on its agent), else the configured one.
	 */
	const engineAgentId = (): string | null => snapshot.agentId || readSettings().agentId || null;

	/**
	 * Tickets for the spawns a command causes (MRC2-02-03A).
	 *
	 * The controller only relays a command to the renderer engine, and no
	 * transport context survives that hop: the engine's tab turn comes back as
	 * `process:spawn` and its routing turn as `context:groomContext`, both over
	 * Electron IPC, so the sinks read a `maestro-cli quick-chat send` or a
	 * paired device's message as the operator at the keyboard. A send that
	 * arrived over a transport (the WebSocket handler runs inside `runAsClient`,
	 * so the admission is in scope here, the way every host sink reads it)
	 * carries one host-minted ticket per spawn, bound to the engine agent and
	 * no tab, since which tab is what the engine decides: `dispatchTicket` for
	 * the tab turn, echoed on the queued item and claimed by the spawn handler,
	 * and `routingTicket` for the routing turn, claimed by the groomContext
	 * handler. The window's own IPC runs outside any context (`desktop`) and
	 * issues none, so a window send behaves as before. The ticket carries no
	 * actor: a forged, spent or mismatched one binds the caller as itself.
	 *
	 * Only a `send` spawns. A recall reopens a tab without a turn (a live chat
	 * it brings back keeps the tickets its queued messages already carry), and
	 * the other commands start nothing.
	 */
	const ticketCommand = async (
		command: QuickChatCommand,
		win: BrowserWindow
	): Promise<{ command: QuickChatCommand; withdraw: () => void }> => {
		const bare = { command, withdraw: () => {} };
		if (command.type !== 'send') return bare;
		const admission = getActingTransport();
		if (admission.kind === 'desktop') return bare;
		// Before its first command the engine has reported no agent; ask it.
		let agentId = engineAgentId();
		if (!agentId) {
			await relay(win, { type: 'sync' });
			agentId = engineAgentId();
		}
		const transport = describeTransportAdmission(admission);
		if (!agentId) {
			// The engine has no agent to chat with and refuses the send itself.
			logger.warn('Quick Chat send has no engine agent to bind a ticket to', 'QuickChat', {
				transport,
			});
			return bare;
		}
		const target = { agentId };
		const dispatchTicket = issueDispatchTicket(admission, target);
		const routingTicket = issueDispatchTicket(admission, target);
		logger.info('Quick Chat send ticketed for its transport', 'QuickChat', { transport, agentId });
		return {
			command: { ...command, dispatchTicket, routingTicket },
			withdraw: () => {
				withdrawDispatchTicket(dispatchTicket);
				withdrawDispatchTicket(routingTicket);
			},
		};
	};

	const runCommand = async (command: QuickChatCommand): Promise<QuickChatCommandResult> => {
		if (!isEnabled()) {
			return { ok: false, error: 'Quick Chat is turned off in Encore Features', snapshot };
		}
		const win = resolveEngineWindow();
		if (!win || !isWebContentsAvailable(win)) {
			return { ok: false, error: 'No Maestro window is available', snapshot };
		}
		const ticketed = await ticketCommand(command, win);
		const result = await relay(win, ticketed.command);
		// A send the engine refused (or never answered) spawns nothing.
		if (!result.ok) ticketed.withdraw();
		// "Open in Maestro" is a deliberate trip to the main window: put the
		// floating window away and bring the window showing the tab forward.
		if (command.type === 'reveal' && result.ok) summonAppWindow(win);
		return result;
	};

	const windowAction = (action: QuickChatWindowAction): QuickChatStatus => {
		if (action === 'hide') {
			hideQuickChatWindow();
			return getStatus();
		}
		// Cmd+` in the window: back to Maestro, the way it cycles between an
		// app's windows. Works with the feature off too, like hide.
		if (action === 'return') {
			const main = deps.getMainWindow();
			if (main) summonAppWindow(main);
			else hideQuickChatWindow();
			return getStatus();
		}
		if (!isEnabled()) return getStatus();
		const wasVisible = isQuickChatWindowVisible();
		if (action === 'toggle') toggleQuickChatWindow(windowDeps);
		else showQuickChatWindow(windowDeps);
		// Coming on screen (toggle from hidden always shows): refresh the agent
		// list and pick up an agent changed in Settings.
		if (!wasVisible) void runCommand({ type: 'sync' });
		return getStatus();
	};

	const setBounds = (request: QuickChatBoundsRequest): QuickChatStatus => {
		setQuickChatWindowBounds(request, windowDeps);
		return getStatus();
	};

	const setPinned = (pinned: boolean): QuickChatStatus => {
		setQuickChatWindowPinned(pinned, windowDeps);
		return getStatus();
	};

	const setFontScale = (request: QuickChatFontScaleRequest): QuickChatStatus => {
		setQuickChatFontScale(request, windowDeps);
		return getStatus();
	};

	const getRecents = (): QuickChatRecentSummary[] => recents.list().map(summarizeQuickChatRecent);

	const recall = async (ref: string): Promise<QuickChatCommandResult> => {
		const resolved = resolveQuickChatRecentRef(recents.list(), ref);
		if ('error' in resolved) return { ok: false, error: resolved.error, snapshot };
		return runCommand({ type: 'recall', chatId: resolved.id });
	};

	const syncHotkey = () => {
		const keys = isEnabled() ? readSettings().hotkey : [];
		hotkeyRegistered = setNamedGlobalHotkey(HOTKEY_ID, keys, () => windowAction('toggle'));
		if (!hotkeyRegistered) {
			const main = deps.getMainWindow();
			// intentionally not bridged: window-specific
			if (main && isWebContentsAvailable(main)) {
				main.webContents.send('quickChat:hotkeyFailed', keys);
			}
		}
	};

	const init = () => {
		// The window asks: run a command, report its layout, or hide itself.
		ipcMain.handle('quickChat:command', (_event, command: QuickChatCommand) => runCommand(command));
		ipcMain.handle('quickChat:window', (_event, action: QuickChatWindowAction) =>
			windowAction(action)
		);
		ipcMain.handle('quickChat:getSnapshot', () => snapshot);
		ipcMain.handle('quickChat:getPinned', () => isQuickChatWindowPinned(windowDeps));
		ipcMain.handle('quickChat:setPinned', (_event, pinned: boolean) => {
			setPinned(pinned === true);
			return isQuickChatWindowPinned(windowDeps);
		});
		ipcMain.handle('quickChat:getFontScale', () => getQuickChatFontScale(windowDeps));
		ipcMain.handle('quickChat:setFontScale', (_event, request: unknown) => {
			const parsed = parseQuickChatFontScaleRequest(request);
			if (!parsed) throw new Error('Invalid text zoom request');
			return setQuickChatFontScale(parsed, windowDeps);
		});
		ipcMain.on('quickChat:setLayout', (event, next: QuickChatLayout) => {
			if (event.sender !== getQuickChatWindow()?.webContents) return;
			setQuickChatLayout(next === 'expanded' ? 'expanded' : 'compact');
		});
		ipcMain.on('quickChat:setCompactHeight', (event, height: unknown) => {
			if (event.sender !== getQuickChatWindow()?.webContents) return;
			if (typeof height === 'number') setQuickChatCompactHeight(height);
		});
		ipcMain.on('quickChat:setFullView', (event, on: boolean) => {
			if (event.sender !== getQuickChatWindow()?.webContents) return;
			setQuickChatFullView(on === true);
		});
		ipcMain.handle('quickChat:getRecents', () => getRecents());
		ipcMain.handle('quickChat:getRecent', (_event, id: unknown) =>
			typeof id === 'string' ? recents.get(id) : null
		);
		// The engine reports each chat as it changes, for the recent chats list.
		ipcMain.on('quickChat:saveRecent', (_event, recent: unknown) => {
			if (!recents.save(recent)) logger.warn('Ignored a malformed recent chat', 'QuickChat');
		});
		// The engine reports state as the conversation streams.
		ipcMain.on('quickChat:snapshot', (_event, next: QuickChatSnapshot) => {
			snapshot = next;
			pushSnapshotToWindow();
		});

		syncHotkey();
		settingsStore.onDidChange(QUICK_CHAT_SETTINGS_KEY, syncHotkey);
		settingsStore.onDidChange('encoreFeatures', () => {
			if (!isEnabled()) closeQuickChatWindow();
			syncHotkey();
		});
		logger.info('Quick Chat controller ready', 'QuickChat', { enabled: isEnabled() });
	};

	const controller: QuickChatController = {
		init,
		runCommand,
		windowAction,
		setBounds,
		setPinned,
		setFontScale,
		getStatus,
		getRecents,
		recall,
	};
	activeController = controller;
	return controller;
}
