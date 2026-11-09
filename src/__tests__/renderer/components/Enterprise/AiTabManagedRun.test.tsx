/**
 * The managed run state mounted on the AI tab (MCOMP-25-02A): drawn from the
 * tab's `managedRun` / `managedRefusal` and the host standing, nothing at all
 * on a standalone host, and each wired action reaching the real path: Stop
 * through `interruptTurn()`, Send again as an ordinary queued resend of the
 * tab's last user message (admitted again), Refresh policy through the
 * enterprise verb. `noteTurnManagedRun()` records a sink refusal on the tab.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../../../../renderer/services/turnInterrupt', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../../renderer/services/turnInterrupt')>()),
	interruptTurn: vi.fn().mockResolvedValue({ success: true }),
}));
vi.mock('../../../../renderer/services/queuedPrompt', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../../renderer/services/queuedPrompt')>()),
	sendQueuedItemNow: vi.fn().mockReturnValue(true),
}));

import {
	AiTabManagedRun,
	lastUserTurnOf,
} from '../../../../renderer/components/Enterprise/AiTabManagedRun';
import { RUN_STATE_COPY } from '../../../../renderer/components/Enterprise/ManagedRunState';
import { interruptTurn } from '../../../../renderer/services/turnInterrupt';
import { sendQueuedItemNow } from '../../../../renderer/services/queuedPrompt';
import { noteTurnManagedRefusal, noteTurnManagedRun } from '../../../../renderer/services/process';
import { managedSpawnRefusalMessage } from '../../../../shared/processErrors';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import { clearCachedResources } from '../../../../renderer/hooks/utils/useCachedResource';
import type { ManagedRunView } from '../../../../main/enterprise/dispatch';
import type { ManagedStateView } from '../../../../main/enterprise/managed-state';
import type { AITab, LogEntry } from '../../../../renderer/types';
import { createMockAITab } from '../../../helpers/mockTab';
import { createMockSession } from '../../../helpers/mockSession';
import { mockTheme } from '../../../helpers/mockTheme';

function runOf(over: Partial<ManagedRunView> = {}): ManagedRunView {
	return {
		leaseId: 'lease-1',
		authorityId: 'auth-1',
		requestId: 'req-1',
		attemptId: 'att-1',
		runId: null,
		requestDigest: 'sha256:abc',
		provider: 'claude-code',
		operation: 'start',
		actor: { kind: 'user', id: 'u-1' } as ManagedRunView['actor'],
		policyRevision: 4,
		decision: null,
		effect: { state: 'bound', release: null, reason: null },
		...over,
	};
}

const managedStanding = {
	standing: 'managed',
	reason: null,
	policy: { appliedRevision: 4 },
} as unknown as ManagedStateView;

function userLog(text: string, over: Partial<LogEntry> = {}): LogEntry {
	return { id: `log-${text}`, timestamp: 1, source: 'user', text, ...over };
}

const SESSION_ID = 'session-1';

function seed(tab: AITab) {
	useSessionStore.getState().setSessions([
		createMockSession({
			id: SESSION_ID,
			aiTabs: [tab],
			activeTabId: tab.id,
			executionQueue: [],
		}),
	]);
}

function storedTab(): AITab {
	return useSessionStore.getState().sessions[0].aiTabs[0];
}

const enterprise = {
	managedState: vi.fn(),
	managedRun: vi.fn(),
	refreshPolicy: vi.fn(),
};
const maestro = window.maestro as unknown as Record<string, unknown>;
const originalEnterprise = maestro.enterprise;
const originalUpdates = maestro.updates;

beforeEach(() => {
	clearCachedResources();
	vi.mocked(interruptTurn).mockClear();
	vi.mocked(sendQueuedItemNow).mockClear();
	enterprise.managedState.mockReset().mockResolvedValue(managedStanding);
	enterprise.managedRun.mockReset().mockResolvedValue(null);
	enterprise.refreshPolicy.mockReset().mockResolvedValue({ status: 'ok', value: {} });
	maestro.enterprise = enterprise;
	maestro.updates = undefined;
});

afterEach(() => {
	maestro.enterprise = originalEnterprise;
	maestro.updates = originalUpdates;
	useSessionStore.getState().setSessions([]);
});

describe('<AiTabManagedRun>', () => {
	it('draws nothing and reads nothing on a standalone host (no run, no refusal on the tab)', () => {
		const tab = createMockAITab({ id: 'tab-1', state: 'busy' });
		const { container } = render(
			<AiTabManagedRun theme={mockTheme} sessionId={SESSION_ID} tab={tab} />
		);
		expect(container.firstChild).toBeNull();
		expect(enterprise.managedState).not.toHaveBeenCalled();
	});

	it('mounts the live run with the host standing, and Stop interrupts exactly this tab', async () => {
		const tab = createMockAITab({ id: 'tab-1', state: 'busy', managedRun: runOf() });
		seed(tab);
		render(<AiTabManagedRun theme={mockTheme} sessionId={SESSION_ID} tab={tab} />);
		await waitFor(() =>
			expect(screen.getByTestId('managed-run-state')).toHaveAttribute('data-run-word', 'running')
		);
		fireEvent.click(screen.getByRole('button', { name: RUN_STATE_COPY.actionHints.stop }));
		await waitFor(() => expect(interruptTurn).toHaveBeenCalledTimes(1));
		expect(vi.mocked(interruptTurn).mock.calls[0][0]).toBe(SESSION_ID);
		expect(vi.mocked(interruptTurn).mock.calls[0][1]).toMatchObject({ tabId: 'tab-1' });
	});

	it('a refused send shows denied; Send again queues the last user message once and starts it', async () => {
		const tab = createMockAITab({
			id: 'tab-1',
			state: 'idle',
			logs: [userLog('first'), userLog('fix the build', { images: ['data:image/png;base64,AA'] })],
			managedRefusal: { state: 'denied', code: 'policy-denied', message: 'Denied by policy 4.' },
		});
		seed(tab);
		render(<AiTabManagedRun theme={mockTheme} sessionId={SESSION_ID} tab={tab} />);
		await waitFor(() =>
			expect(screen.getByTestId('managed-run-state')).toHaveAttribute('data-run-word', 'denied')
		);
		fireEvent.click(screen.getByRole('button', { name: RUN_STATE_COPY.actionHints.retry }));
		await waitFor(() => expect(sendQueuedItemNow).toHaveBeenCalledTimes(1));
		const queue = useSessionStore.getState().sessions[0].executionQueue;
		expect(queue).toHaveLength(1);
		expect(queue[0]).toMatchObject({
			type: 'message',
			text: 'fix the build',
			images: ['data:image/png;base64,AA'],
			tabId: 'tab-1',
		});
		expect(vi.mocked(sendQueuedItemNow).mock.calls[0]).toEqual([SESSION_ID, queue[0].id]);
	});

	it('offers no Send again when the tab has no user message to send', async () => {
		const tab = createMockAITab({
			id: 'tab-1',
			state: 'idle',
			logs: [],
			managedRefusal: { state: 'denied', code: 'policy-denied', message: 'Denied.' },
		});
		seed(tab);
		render(<AiTabManagedRun theme={mockTheme} sessionId={SESSION_ID} tab={tab} />);
		await waitFor(() => screen.getByTestId('managed-run-state'));
		expect(
			screen.queryByRole('button', { name: RUN_STATE_COPY.actionHints.retry })
		).not.toBeInTheDocument();
		expect(
			screen.getByRole('button', { name: RUN_STATE_COPY.actionHints.refreshPolicy })
		).toBeInTheDocument();
	});

	it('Refresh policy asks the endpoint through the enterprise verb and re-reads the standing', async () => {
		const tab = createMockAITab({
			id: 'tab-1',
			state: 'idle',
			logs: [userLog('hello')],
			managedRefusal: { state: 'denied', code: 'policy-denied', message: 'Denied.' },
		});
		seed(tab);
		render(<AiTabManagedRun theme={mockTheme} sessionId={SESSION_ID} tab={tab} />);
		await waitFor(() => screen.getByTestId('managed-run-state'));
		const reads = enterprise.managedState.mock.calls.length;
		fireEvent.click(screen.getByRole('button', { name: RUN_STATE_COPY.actionHints.refreshPolicy }));
		await waitFor(() => expect(enterprise.refreshPolicy).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(enterprise.managedState.mock.calls.length).toBeGreaterThan(reads));
		expect(interruptTurn).not.toHaveBeenCalled();
		expect(sendQueuedItemNow).not.toHaveBeenCalled();
	});
});

describe('lastUserTurnOf', () => {
	it('takes the newest user entry, skipping agent output and blank entries', () => {
		const logs: LogEntry[] = [
			userLog('older'),
			userLog('newest'),
			{ id: 'a', timestamp: 2, source: 'ai', text: 'reply' } as LogEntry,
			userLog('   '),
		];
		expect(lastUserTurnOf({ logs })).toEqual({ text: 'newest' });
	});

	it('resends a slash command as the command, not its expanded prompt', () => {
		const logs = [
			userLog('expanded prompt', { aiCommand: { command: '/commit', description: 'Commit' } }),
		];
		expect(lastUserTurnOf({ logs })).toEqual({ text: '/commit', slashCommand: true });
	});

	it('is null when nothing was sent', () => {
		expect(lastUserTurnOf({ logs: [] })).toBeNull();
	});
});

describe('noteTurnManagedRun records the host refusal', () => {
	it('keeps a sink refusal beside the run and clears both when the next send starts', () => {
		seed(createMockAITab({ id: 'tab-1', managedRun: runOf({ leaseId: 'lease-old' }) }));
		act(() =>
			noteTurnManagedRun(SESSION_ID, 'tab-1', {
				error: 'Refused: policy revision 5 denies claude-code.',
				managed: { state: 'denied', code: 'policy-denied' },
			})
		);
		expect(storedTab().managedRun).toBeUndefined();
		expect(storedTab().managedRefusal).toEqual({
			state: 'denied',
			code: 'policy-denied',
			message: 'Refused: policy revision 5 denies claude-code.',
		});

		act(() => noteTurnManagedRun(SESSION_ID, 'tab-1'));
		expect(storedTab().managedRefusal).toBeUndefined();
		expect(storedTab().managedRun).toBeUndefined();
	});

	it('an admitted spawn records its run and no refusal; a standalone spawn writes nothing', () => {
		const tab = createMockAITab({ id: 'tab-1' });
		seed(tab);
		act(() => noteTurnManagedRun(SESSION_ID, 'tab-1', { managedRun: runOf() }));
		expect(storedTab().managedRun?.leaseId).toBe('lease-1');
		expect(storedTab().managedRefusal).toBeUndefined();

		seed(tab);
		const before = storedTab();
		act(() => noteTurnManagedRun(SESSION_ID, 'tab-1', { pid: 1, success: true } as never));
		expect(storedTab()).toBe(before);
	});
});

describe('noteTurnManagedRefusal reads the refusal off a rejected spawn (MCOMP-25-04A)', () => {
	it('records the host refusal from the IPC rejection and nothing for another failure', () => {
		seed(createMockAITab({ id: 'tab-1' }));
		const before = storedTab();
		let noted = true;
		act(() => {
			noted = noteTurnManagedRefusal(SESSION_ID, 'tab-1', new Error('spawn ENOENT'));
		});
		expect(noted).toBe(false);
		expect(storedTab()).toBe(before);

		const message = managedSpawnRefusalMessage({
			state: 'unavailable',
			code: 'runtime-unavailable',
			message: 'No endpoint is attached.',
		});
		act(() => {
			noted = noteTurnManagedRefusal(
				SESSION_ID,
				'tab-1',
				new Error(`Error invoking remote method 'process:spawn': Error: ${message}`)
			);
		});
		expect(noted).toBe(true);
		expect(storedTab().managedRefusal).toEqual({
			state: 'unavailable',
			code: 'runtime-unavailable',
			message: 'No endpoint is attached.',
		});
		expect(storedTab().managedRun).toBeUndefined();
	});
});
