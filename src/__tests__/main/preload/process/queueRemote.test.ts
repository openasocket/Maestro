/**
 * Tests for process/queueRemote preload API.
 *
 * Like browserTabRemote.test.ts, these drive the registered IPC handler with
 * exactly what the main process sends (`remote:enqueueCommand` from
 * queueCallbacks.ts) and check what the renderer callback receives, because a
 * bridge that drops a trailing argument still type-checks clean. The three
 * dispatch slots after `held` (mentionRouting, delegation, dispatchTicket)
 * are the MCOMP-01-03J wire.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ManagedDelegationContext } from '../../../../shared/maestro-lib/managed/delegation';

const mockOn = vi.fn();
const mockRemoveListener = vi.fn();
const mockSend = vi.fn();

vi.mock('electron', () => ({
	ipcRenderer: {
		on: (...args: unknown[]) => mockOn(...args),
		removeListener: (...args: unknown[]) => mockRemoveListener(...args),
		send: (...args: unknown[]) => mockSend(...args),
	},
}));

import { createQueueRemoteApi } from '../../../../main/preload/process/queueRemote';

/** Pull the handler the API registered for a channel, so we can drive it. */
function registeredHandler(channel: string): (...args: unknown[]) => void {
	const entry = mockOn.mock.calls.find((call) => call[0] === channel);
	if (!entry) throw new Error(`no handler registered for ${channel}`);
	return entry[1] as (...args: unknown[]) => void;
}

const delegation = {
	identity: { requestId: 'req-1' },
	traceId: 'trace-1',
} as unknown as ManagedDelegationContext;

describe('Process QueueRemote Preload API', () => {
	let api: ReturnType<typeof createQueueRemoteApi>;

	beforeEach(() => {
		vi.clearAllMocks();
		api = createQueueRemoteApi();
	});

	describe('onRemoteEnqueueCommand - the dispatch slots after held', () => {
		it('forwards mentionRouting, delegation and the dispatch ticket in order', () => {
			const callback = vi.fn();
			api.onRemoteEnqueueCommand(callback);
			const images = ['data:image/png;base64,def'];

			registeredHandler('remote:enqueueCommand')(
				null,
				'session-1',
				'cmd',
				'resp-2',
				'ai',
				'tab-3',
				images,
				false,
				true,
				'parallel',
				delegation,
				'tkt-3'
			);

			expect(callback).toHaveBeenCalledTimes(1);
			expect(callback).toHaveBeenCalledWith(
				'session-1',
				'cmd',
				'resp-2',
				'ai',
				'tab-3',
				images,
				false,
				true,
				'parallel',
				delegation,
				'tkt-3'
			);
		});

		it('leaves the three slots undefined for a plain queued command', () => {
			const callback = vi.fn();
			api.onRemoteEnqueueCommand(callback);

			registeredHandler('remote:enqueueCommand')(
				null,
				'session-1',
				'cmd',
				'resp-2',
				'terminal',
				undefined,
				undefined,
				true,
				false
			);

			expect(callback).toHaveBeenCalledWith(
				'session-1',
				'cmd',
				'resp-2',
				'terminal',
				undefined,
				undefined,
				true,
				false,
				undefined,
				undefined,
				undefined
			);
		});

		it('acks { success: false } on the response channel before rethrowing a callback error', () => {
			api.onRemoteEnqueueCommand(() => {
				throw new Error('boom');
			});

			expect(() =>
				registeredHandler('remote:enqueueCommand')(null, 'session-1', 'cmd', 'resp-3', 'ai')
			).toThrow('boom');
			expect(mockSend).toHaveBeenCalledWith('resp-3', { success: false });
		});

		it('unsubscribes the listener it registered', () => {
			const off = api.onRemoteEnqueueCommand(vi.fn());
			const handler = registeredHandler('remote:enqueueCommand');
			off();
			expect(mockRemoveListener).toHaveBeenCalledWith('remote:enqueueCommand', handler);
		});
	});

	it('sends the enqueue outcome on the response channel as given', () => {
		const result = { success: true, queued: true, queuePosition: 2, queueLength: 3, itemId: 'q-1' };
		api.sendRemoteEnqueueCommandResponse('resp-4', result);
		expect(mockSend).toHaveBeenCalledWith('resp-4', result);
	});
});
