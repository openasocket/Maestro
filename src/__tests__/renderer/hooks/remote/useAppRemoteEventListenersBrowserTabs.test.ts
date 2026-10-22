/**
 * Covers the CLI/web browser-tab bridge in useAppRemoteEventListeners.
 *
 * The invariant under test: a `--background` open must not move the user. It
 * creates the tab but leaves the active agent and the visible tab alone, so an
 * agent doing research can't yank the window out from under someone typing.
 */
import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { useAppRemoteEventListeners } from '../../../../renderer/hooks/remote/useAppRemoteEventListeners';
import { createMockSession } from '../../../helpers/mockSession';
import type { Session } from '../../../../renderer/types';
import { selectSessionById } from '../../../../renderer/stores/sessionStore';
import { spawnPtyForTab } from '../../../../renderer/services/terminalSpawn';
import { notifyToast } from '../../../../renderer/stores/notificationStore';

vi.mock('../../../../renderer/stores/sessionStore', () => ({
	useSessionStore: Object.assign(vi.fn(), { getState: vi.fn(() => ({})) }),
	selectSessionById: vi.fn(),
}));
vi.mock('../../../../renderer/stores/settingsStore', () => ({
	useSettingsStore: Object.assign(vi.fn(), { getState: vi.fn(() => ({})) }),
}));
vi.mock('../../../../renderer/hooks/batch/batchUtils', () => ({ DEFAULT_BATCH_PROMPT: '' }));
vi.mock('../../../../renderer/services/git', () => ({ gitService: {} }));
vi.mock('../../../../renderer/utils/worktreeSpawn', () => ({
	spawnWorktreeAgentAndDispatch: vi.fn(),
}));
vi.mock('../../../../renderer/stores/notificationStore', () => ({ notifyToast: vi.fn() }));
vi.mock('../../../../renderer/services/terminalSpawn', () => ({ spawnPtyForTab: vi.fn() }));
vi.mock('../../../../renderer/components/TerminalView', () => ({
	createTabPidChangeHandler: () => vi.fn(),
	createTabStateChangeHandler: () => vi.fn(),
}));
vi.mock('../../../../renderer/utils/browserTabPersistence', () => ({
	getBrowserTabPartition: () => 'persist:test',
}));
vi.mock('../../../../renderer/utils/ids', () => ({ generateId: () => 'new-tab-id' }));

const openAck = vi.fn();
const closeAck = vi.fn();
const terminalAck = vi.fn();
const writeAck = vi.fn();
const processWrite = vi.fn();

function setup(sessions: Session[]) {
	const sessionsRef = { current: sessions };
	const setActiveSessionId = vi.fn();
	const setSessions = vi.fn();

	renderHook(() =>
		useAppRemoteEventListeners({
			sessionsRef,
			setActiveSessionId,
			setSessions,
			setGroups: vi.fn(),
			handleOpenFileTab: vi.fn(),
			refreshFileTree: vi.fn(),
			handleAutoRunRefresh: vi.fn(),
			startBatchRun: vi.fn(),
			stopBatchRun: vi.fn(),
			resumeAfterError: vi.fn(),
			skipCurrentDocument: vi.fn(),
			abortBatchOnError: vi.fn(),
		} as any)
	);

	return { setActiveSessionId, setSessions };
}

/** Run the reducer that setSessions was called with against the given state. */
function applyUpdate(setSessions: Mock, sessions: Session[]): Session[] {
	const updater = setSessions.mock.calls[0][0] as (prev: Session[]) => Session[];
	return updater(sessions);
}

function dispatchOpen(detail: Record<string, unknown>) {
	window.dispatchEvent(new CustomEvent('maestro:openBrowserTab', { detail }));
}

function dispatchClose(detail: Record<string, unknown>) {
	window.dispatchEvent(new CustomEvent('maestro:closeBrowserTab', { detail }));
}

beforeEach(() => {
	vi.clearAllMocks();
	(window as any).maestro = {
		process: {
			sendRemoteOpenBrowserTabResponse: openAck,
			sendRemoteCloseBrowserTabResponse: closeAck,
			sendRemoteOpenTerminalTabResponse: terminalAck,
			sendRemoteWriteTerminalTabResponse: writeAck,
			write: processWrite,
		},
	};
});

/**
 * MRC-08-02A: the dispatch ticket a remote open_terminal_tab or
 * write_terminal_tab carries is the renderer's to pass along, never to read.
 */
describe('maestro:openTerminalTab dispatch ticket', () => {
	it('puts the ticket on the new tab record so its first spawn carries it', () => {
		const sessions = [createMockSession({ id: 'session-1' })];
		vi.mocked(selectSessionById).mockReturnValue(() => sessions[0]);
		const { setSessions } = setup(sessions);
		window.dispatchEvent(
			new CustomEvent('maestro:openTerminalTab', {
				detail: {
					sessionId: 'session-1',
					config: { name: 'Build' },
					background: true,
					responseChannel: 'ch',
					dispatchTicket: 'tkt-open-1',
				},
			})
		);
		const [updated] = applyUpdate(setSessions, sessions);
		expect(updated.terminalTabs?.[0]).toMatchObject({
			id: 'new-tab-id',
			dispatchTicket: 'tkt-open-1',
		});
		expect(vi.mocked(spawnPtyForTab).mock.calls[0][0].tab).toMatchObject({
			dispatchTicket: 'tkt-open-1',
		});
		expect(terminalAck).toHaveBeenCalledWith('ch', true, 'new-tab-id');
	});

	it('creates a tab without a ticket when none was sent', () => {
		const sessions = [createMockSession({ id: 'session-1' })];
		vi.mocked(selectSessionById).mockReturnValue(() => sessions[0]);
		const { setSessions } = setup(sessions);
		window.dispatchEvent(
			new CustomEvent('maestro:openTerminalTab', {
				detail: { sessionId: 'session-1', config: {}, background: true },
			})
		);
		const [updated] = applyUpdate(setSessions, sessions);
		expect('dispatchTicket' in (updated.terminalTabs?.[0] ?? {})).toBe(false);
	});
});

describe('maestro:writeTerminalTab dispatch ticket', () => {
	const liveTab = () =>
		({ id: 'term-1', name: 'Dev server', pid: 77, ptyInitialized: true, state: 'idle' }) as any;

	it('passes the ticket to process:write and acks the write', async () => {
		processWrite.mockResolvedValue(true);
		const sessions = [
			createMockSession({
				id: 'session-1',
				terminalTabs: [liveTab()],
				activeTerminalTabId: 'term-1',
			}),
		];
		setup(sessions);
		window.dispatchEvent(
			new CustomEvent('maestro:writeTerminalTab', {
				detail: {
					sessionId: 'session-1',
					data: 'ls\n',
					responseChannel: 'wch',
					dispatchTicket: 'tkt-w-1',
				},
			})
		);
		await vi.waitFor(() => expect(writeAck).toHaveBeenCalled());
		expect(processWrite).toHaveBeenCalledWith('session-1-terminal-term-1', 'ls\n', 'tkt-w-1');
		expect(writeAck).toHaveBeenCalledWith('wch', true, {
			error: undefined,
			tabId: 'term-1',
			tabName: 'Dev server',
		});
	});

	it('acks a managed refusal from the sink as a failure with the reason and the managed fields', async () => {
		processWrite.mockResolvedValue({
			success: false,
			error:
				'This terminal was admitted for maestro-cli on a managed host; input by lite-device:dev-7 is unavailable.',
			managed: { state: 'denied', code: 'context-mismatch' },
		});
		const sessions = [
			createMockSession({
				id: 'session-1',
				terminalTabs: [liveTab()],
				activeTerminalTabId: 'term-1',
			}),
		];
		setup(sessions);
		window.dispatchEvent(
			new CustomEvent('maestro:writeTerminalTab', {
				detail: {
					sessionId: 'session-1',
					data: 'ls\n',
					responseChannel: 'wch',
					dispatchTicket: 'tkt-w-2',
				},
			})
		);
		await vi.waitFor(() => expect(writeAck).toHaveBeenCalled());
		expect(writeAck).toHaveBeenCalledWith('wch', false, {
			error: expect.stringContaining('admitted for maestro-cli'),
			tabId: 'term-1',
			tabName: 'Dev server',
			managed: { state: 'denied', code: 'context-mismatch' },
		});
	});
});

describe('maestro:openTerminalTab human input', () => {
	it('notifies only after the terminal shell starts, without moving the view', () => {
		const sessions = [createMockSession({ id: 'session-1', name: 'Maestro Codex' })];
		vi.mocked(selectSessionById).mockReturnValue(() => sessions[0]);
		const { setActiveSessionId } = setup(sessions);
		window.dispatchEvent(
			new CustomEvent('maestro:openTerminalTab', {
				detail: {
					sessionId: 'session-1',
					config: { name: 'Sudo', inputRequired: true },
					background: true,
					responseChannel: 'ch',
				},
			})
		);
		expect(setActiveSessionId).not.toHaveBeenCalled();
		expect(terminalAck).toHaveBeenCalledWith('ch', true, 'new-tab-id');
		expect(notifyToast).not.toHaveBeenCalled();
		const spawnOptions = vi.mocked(spawnPtyForTab).mock.calls[0][0];
		sessions[0].terminalTabs = [spawnOptions.tab];
		spawnOptions.onPid('new-tab-id', 123);
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({
				project: 'Maestro Codex',
				tabName: 'Sudo',
				clickAction: { kind: 'open-terminal', sessionId: 'session-1', tabRef: 'new-tab-id' },
			})
		);
	});
});

describe('terminal notification names', () => {
	it('uses the current tab position and agent name after shell startup', () => {
		const sessions = [
			createMockSession({
				id: 'session-1',
				name: 'Before',
				terminalTabs: [{ id: 'old-tab' } as any],
			}),
		];
		vi.mocked(selectSessionById).mockReturnValue(() => sessions[0]);
		setup(sessions);
		window.dispatchEvent(
			new CustomEvent('maestro:openTerminalTab', {
				detail: {
					sessionId: 'session-1',
					config: { inputRequired: true },
					background: true,
				},
			})
		);
		const options = vi.mocked(spawnPtyForTab).mock.calls[0][0];
		// The first tab closed while the new shell was starting.
		sessions[0].terminalTabs = [options.tab];
		sessions[0].name = 'After';
		options.onPid('new-tab-id', 123);
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({ project: 'After', tabName: 'Terminal 1' })
		);
	});
});

describe('maestro:openBrowserTab', () => {
	it('focuses the agent and the new tab for a foreground open', () => {
		const sessions = [createMockSession({ id: 'session-1', activeBrowserTabId: 'existing' })];
		const { setActiveSessionId, setSessions } = setup(sessions);

		dispatchOpen({ sessionId: 'session-1', url: 'https://example.com/', responseChannel: 'ch' });

		expect(setActiveSessionId).toHaveBeenCalledWith('session-1');
		const [updated] = applyUpdate(setSessions, sessions);
		expect(updated.browserTabs).toHaveLength(1);
		expect(updated.activeBrowserTabId).toBe('new-tab-id');
	});

	it('does not switch agents or change the visible tab for a background open', () => {
		const sessions = [createMockSession({ id: 'session-1', activeBrowserTabId: 'existing' })];
		const { setActiveSessionId, setSessions } = setup(sessions);

		dispatchOpen({
			sessionId: 'session-1',
			url: 'https://example.com/',
			responseChannel: 'ch',
			background: true,
		});

		expect(setActiveSessionId).not.toHaveBeenCalled();
		const [updated] = applyUpdate(setSessions, sessions);
		// Tab exists, but the user is left exactly where they were.
		expect(updated.browserTabs).toHaveLength(1);
		expect(updated.activeBrowserTabId).toBe('existing');
	});

	it('acks with the created tab id so the caller can close it again', () => {
		const sessions = [createMockSession({ id: 'session-1' })];
		setup(sessions);

		dispatchOpen({
			sessionId: 'session-1',
			url: 'https://example.com/',
			responseChannel: 'ch',
			background: true,
		});

		expect(openAck).toHaveBeenCalledWith('ch', true, 'new-tab-id');
	});

	it('acks false when the session does not exist', () => {
		setup([createMockSession({ id: 'session-1' })]);

		dispatchOpen({ sessionId: 'ghost', url: 'https://example.com/', responseChannel: 'ch' });

		expect(openAck).toHaveBeenCalledWith('ch', false, undefined);
	});
});

describe('maestro:closeBrowserTab', () => {
	const withTabs = () =>
		createMockSession({
			id: 'session-1',
			browserTabs: [
				{ id: 'tab-a', url: 'https://a.test/' },
				{ id: 'tab-b', url: 'https://b.test/' },
			] as any,
			activeBrowserTabId: 'tab-a',
			unifiedTabOrder: [
				{ type: 'browser', id: 'tab-a' },
				{ type: 'browser', id: 'tab-b' },
			] as any,
		});

	it('removes the tab from the owning session without needing an agent id', () => {
		const sessions = [withTabs()];
		const { setSessions } = setup(sessions);

		dispatchClose({ tabId: 'tab-b', responseChannel: 'ch' });

		const [updated] = applyUpdate(setSessions, sessions);
		expect(updated.browserTabs?.map((t) => t.id)).toEqual(['tab-a']);
		expect(updated.unifiedTabOrder).toEqual([{ type: 'browser', id: 'tab-a' }]);
		expect(closeAck).toHaveBeenCalledWith('ch', true);
	});

	it('leaves the visible tab alone when a background tab closes', () => {
		const sessions = [withTabs()];
		const { setSessions } = setup(sessions);

		dispatchClose({ tabId: 'tab-b', responseChannel: 'ch' });

		const [updated] = applyUpdate(setSessions, sessions);
		expect(updated.activeBrowserTabId).toBe('tab-a');
	});

	it('clears the active pointer when the closed tab was the visible one', () => {
		const sessions = [withTabs()];
		const { setSessions } = setup(sessions);

		dispatchClose({ tabId: 'tab-a', responseChannel: 'ch' });

		const [updated] = applyUpdate(setSessions, sessions);
		expect(updated.activeBrowserTabId).toBeNull();
	});

	it('acks false for an unknown tab so a cleanup no-op is distinguishable', () => {
		setup([withTabs()]);

		dispatchClose({ tabId: 'ghost-tab', responseChannel: 'ch' });

		expect(closeAck).toHaveBeenCalledWith('ch', false);
	});
});
