/**
 * Tests for process/browserTabRemote preload API.
 *
 * These exercise the registered IPC handler itself rather than the callback
 * signature, because the signature is exactly what cannot be trusted here:
 * TypeScript accepts a 3-parameter function where a 4-parameter callback type
 * is declared, so a bridge that quietly drops its last argument type-checks
 * clean and ships a dead flag. `--background` on `open-terminal` was inert for
 * that reason - the main process sent the option, the preload handler never
 * declared it, and the renderer read `undefined`. Every tab focused.
 *
 * So the assertion has to be end-to-end across the bridge: emit what the main
 * process actually sends, and check what the renderer actually receives.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import { createBrowserTabRemoteApi } from '../../../../main/preload/process/browserTabRemote';
import type { ManagedDelegationContext } from '../../../../shared/maestro-lib/managed/delegation';

/** Pull the handler the API registered for a channel, so we can drive it. */
function registeredHandler(channel: string): (...args: unknown[]) => void {
	const entry = mockOn.mock.calls.find((call) => call[0] === channel);
	if (!entry) throw new Error(`no handler registered for ${channel}`);
	return entry[1] as (...args: unknown[]) => void;
}

describe('Process BrowserTabRemote Preload API', () => {
	let api: ReturnType<typeof createBrowserTabRemoteApi>;

	beforeEach(() => {
		vi.clearAllMocks();
		api = createBrowserTabRemoteApi();
	});

	describe('onRemoteOpenTerminalTab - background must survive the bridge', () => {
		const config = { name: 'Dev server' };

		it('forwards background:true to the renderer callback', () => {
			const callback = vi.fn();
			api.onRemoteOpenTerminalTab(callback);

			// Exactly what browserTabCallbacks.ts sends over the wire.
			registeredHandler('remote:openTerminalTab')(null, 'session-1', config, 'chan-1', {
				background: true,
			});

			expect(callback).toHaveBeenCalledWith(
				'session-1',
				config,
				'chan-1',
				{ background: true },
				undefined
			);
		});

		it('forwards background:false when the verb should focus', () => {
			const callback = vi.fn();
			api.onRemoteOpenTerminalTab(callback);

			registeredHandler('remote:openTerminalTab')(null, 'session-1', config, 'chan-1', {
				background: false,
			});

			expect(callback).toHaveBeenCalledWith(
				'session-1',
				config,
				'chan-1',
				{ background: false },
				undefined
			);
		});

		it('treats a missing options argument as foreground, not undefined', () => {
			const callback = vi.fn();
			api.onRemoteOpenTerminalTab(callback);

			// An older main process that predates the flag sends only three args.
			registeredHandler('remote:openTerminalTab')(null, 'session-1', config, 'chan-1');

			expect(callback).toHaveBeenCalledWith(
				'session-1',
				config,
				'chan-1',
				{ background: false },
				undefined
			);
		});

		it('only a literal true opts in', () => {
			const callback = vi.fn();
			api.onRemoteOpenTerminalTab(callback);

			registeredHandler('remote:openTerminalTab')(null, 'session-1', config, 'chan-1', {
				background: 'yes' as unknown as boolean,
			});

			expect(callback).toHaveBeenCalledWith(
				'session-1',
				config,
				'chan-1',
				{ background: false },
				undefined
			);
		});

		it('forwards the dispatch ticket after the options, unread (MRC-08-02A)', () => {
			const callback = vi.fn();
			api.onRemoteOpenTerminalTab(callback);

			registeredHandler('remote:openTerminalTab')(
				null,
				'session-1',
				config,
				'chan-1',
				{ background: true },
				'tkt-open-1'
			);

			expect(callback).toHaveBeenCalledWith(
				'session-1',
				config,
				'chan-1',
				{ background: true },
				'tkt-open-1'
			);
		});

		it('drops a dispatch ticket that is not a string (MRC-08-02A)', () => {
			const callback = vi.fn();
			api.onRemoteOpenTerminalTab(callback);

			registeredHandler('remote:openTerminalTab')(
				null,
				'session-1',
				config,
				'chan-1',
				{ background: false },
				{ forged: true }
			);

			expect(callback).toHaveBeenCalledWith(
				'session-1',
				config,
				'chan-1',
				{ background: false },
				undefined
			);
		});

		it('acks false on the response channel when the callback throws', () => {
			const callback = vi.fn(() => {
				throw new Error('renderer blew up');
			});
			api.onRemoteOpenTerminalTab(callback);

			expect(() =>
				registeredHandler('remote:openTerminalTab')(null, 'session-1', config, 'chan-1', {
					background: true,
				})
			).toThrow('renderer blew up');
			expect(mockSend).toHaveBeenCalledWith('chan-1', false);
		});
	});

	describe('onRemoteNewAITabWithPrompt - the dispatch slots after hidden (MCOMP-01-03J wire)', () => {
		const delegation = {
			identity: { requestId: 'req-1' },
			traceId: 'trace-1',
		} as unknown as ManagedDelegationContext;

		it('forwards mentionRouting, delegation and the dispatch ticket in order', () => {
			const callback = vi.fn();
			api.onRemoteNewAITabWithPrompt(callback);

			// Exactly what browserTabCallbacks.ts sends over the wire: upstream's
			// Pianola new-tab control keeps the slot after the routing, and the
			// delegation and the ticket follow it.
			registeredHandler('remote:newAITabWithPrompt')(
				null,
				'session-1',
				'prompt',
				'resp-1',
				true,
				false,
				'consult-first',
				undefined,
				delegation,
				'tkt-2'
			);

			expect(callback).toHaveBeenCalledTimes(1);
			expect(callback).toHaveBeenCalledWith(
				'session-1',
				'prompt',
				'resp-1',
				true,
				false,
				'consult-first',
				undefined,
				delegation,
				'tkt-2'
			);
		});

		it('leaves the three slots undefined for a plain new tab', () => {
			const callback = vi.fn();
			api.onRemoteNewAITabWithPrompt(callback);

			registeredHandler('remote:newAITabWithPrompt')(null, 'session-1', 'prompt', 'resp-1', false);

			// hidden, mentionRouting and control stay as undefined slots; the
			// delegation and the ticket are not handed over when unset.
			expect(callback).toHaveBeenCalledWith(
				'session-1',
				'prompt',
				'resp-1',
				false,
				undefined,
				undefined,
				undefined
			);
		});

		it('acks false on the response channel before rethrowing a callback error', () => {
			api.onRemoteNewAITabWithPrompt(() => {
				throw new Error('boom');
			});

			expect(() =>
				registeredHandler('remote:newAITabWithPrompt')(
					null,
					'session-1',
					'prompt',
					'resp-1',
					false,
					false
				)
			).toThrow('boom');
			expect(mockSend).toHaveBeenCalledWith('resp-1', false);
		});

		it('unsubscribes the listener it registered', () => {
			const off = api.onRemoteNewAITabWithPrompt(vi.fn());
			const handler = registeredHandler('remote:newAITabWithPrompt');
			off();
			expect(mockRemoveListener).toHaveBeenCalledWith('remote:newAITabWithPrompt', handler);
		});
	});

	describe('onRemoteOpenBrowserTab - the sibling that was already correct', () => {
		it('forwards its options object through the bridge', () => {
			const callback = vi.fn();
			api.onRemoteOpenBrowserTab(callback);

			registeredHandler('remote:openBrowserTab')(
				null,
				'session-1',
				'https://example.com',
				'chan-2',
				{
					background: true,
				}
			);

			expect(callback).toHaveBeenCalledWith('session-1', 'https://example.com', 'chan-2', {
				background: true,
			});
		});
	});
	describe('new-tab admission phases', () => {
		it('forwards the host-bound phase and exact tab through the preload bridge', () => {
			const api = createBrowserTabRemoteApi();
			const callback = vi.fn();
			api.onRemoteNewAITabWithPrompt(callback);
			const handler = mockOn.mock.calls.find(
				([channel]) => channel === 'remote:newAITabWithPrompt'
			)![1];
			const control = { phase: 'prepare', dispatchId: 'dispatch', tabId: 'exact-tab' };
			handler(null, 'worker', '', 'reply', true, false, undefined, control);
			expect(callback).toHaveBeenCalledWith('worker', '', 'reply', true, false, undefined, control);
		});
	});
});
