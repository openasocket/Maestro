import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	BrowserRelay,
	relayEffectOf,
	validateInput,
	type BrowserRelayEffect,
} from '../../../main/browser/browser-relay';
import type {
	BrowserRelayAction,
	BrowserRelayHostResult,
	BrowserRelayRequest,
} from '../../../shared/browserRelay';
import type { BrowserEffectDecision } from '../../../main/enterprise/browser-policy';

const { tabSession } = vi.hoisted(() => ({ tabSession: {} }));
vi.mock('electron', () => ({
	BrowserWindow: {},
	ipcMain: {},
	webContents: {},
	session: { fromPartition: () => tabSession },
}));

const target = { sessionId: 'host-session', tabId: 'host-tab' };
const viewport = { width: 800, height: 600 };

afterEach(() => vi.useRealTimers());

describe('host browser relay leases', () => {
	it('refuses another client’s lease and another controller for the same canonical tab', async () => {
		const relay = new BrowserRelay(async () => ({ ok: true }));
		const id = await relay.open('client-a', target, viewport);
		await expect(relay.run('client-b', id, 'resolve')).rejects.toThrow('another client');
		await expect(relay.open('client-b', target, viewport)).rejects.toThrow('already controlled');
		relay.close('client-b', id);
		await expect(relay.open('client-b', target, viewport)).rejects.toThrow('already controlled');
		relay.close('client-a', id);
		await expect(relay.open('client-b', target, viewport)).resolves.toEqual(expect.any(String));
	});

	it('rejects missing host tabs and invalid dimensions without reserving their target', async () => {
		const hostTabs = new Set([target.tabId]);
		const relay = new BrowserRelay(async (request) => ({
			ok: hostTabs.has(request.tabId),
			error: 'Host tab not found',
		}));
		await expect(
			relay.open('client', { ...target, tabId: 'unregistered' }, viewport)
		).rejects.toThrow('Host tab not found');
		await expect(relay.open('client', target, { width: 3000, height: 600 })).rejects.toThrow(
			'viewport'
		);
		await expect(relay.open('client', target, viewport)).resolves.toEqual(expect.any(String));
	});

	it('permits only one capture in flight and caps capture start rate at eight frames per second', async () => {
		vi.useFakeTimers();
		const capture = Promise.withResolvers<BrowserRelayHostResult>();
		let frames = 0;
		const relay = new BrowserRelay(async (request) => {
			if (request.kind === 'frame') {
				frames++;
				if (frames === 1) return capture.promise;
			}
			return { ok: true };
		});
		const id = await relay.open('client', target, viewport);
		const first = relay.run('client', id, 'frame');
		await expect(relay.run('client', id, 'frame')).rejects.toThrow('in flight');
		capture.resolve({ ok: true });
		await first;
		const second = relay.run('client', id, 'frame');
		await vi.advanceTimersByTimeAsync(124);
		expect(frames).toBe(1);
		await vi.advanceTimersByTimeAsync(1);
		await second;
		expect(frames).toBe(2);
	});

	it('disconnect releases the view, rejects a late capture, and never destroys the host tab', async () => {
		const capture = Promise.withResolvers<BrowserRelayHostResult>();
		const hostTabs = new Set([target.tabId]);
		const released: string[] = [];
		const relay = new BrowserRelay(async (request) => {
			if (request.kind === 'frame') return capture.promise;
			if (request.kind === 'release') released.push(request.tabId);
			return { ok: hostTabs.has(request.tabId) };
		});
		const id = await relay.open('client', target, viewport);
		const frame = relay.run('client', id, 'frame');
		relay.closeClient('client');
		capture.resolve({ ok: true });
		await expect(frame).rejects.toThrow('expired');
		// Release immediately and again after the pending capture settles, since
		// a frame request may recreate a page after its original guest disappears.
		expect(released).toEqual([target.tabId, target.tabId]);
		expect(hostTabs.has(target.tabId)).toBe(true);
		await expect(relay.open('new-client', target, viewport)).resolves.toEqual(expect.any(String));
	});

	it('idle views expire and a closing host tab fails subsequent operations', async () => {
		let now = 0;
		let live = true;
		const relay = new BrowserRelay(
			async (request: Omit<BrowserRelayRequest, 'requestId'>) => ({
				ok: request.kind === 'release' || live,
				error: 'Host tab closed',
			}),
			() => now
		);
		const id = await relay.open('client', target, viewport);
		live = false;
		await expect(relay.run('client', id, 'resolve')).rejects.toThrow('Host tab closed');
		now = 15_001;
		relay.expire();
		await expect(relay.run('client', id, 'resolve')).rejects.toThrow('expired');
	});

	it.each([
		{ kind: 'resolve' as const, hasSuccessor: false },
		{ kind: 'resolve' as const, hasSuccessor: true },
		{ kind: 'frame' as const, hasSuccessor: false },
		{ kind: 'frame' as const, hasSuccessor: true },
	])(
		'cleans up a disconnected pending $kind without suspending a successor (successor: $hasSuccessor)',
		async ({ kind, hasSuccessor }) => {
			const creation = Promise.withResolvers<void>();
			let requests = 0;
			let remoteActive = false;
			const relay = new BrowserRelay(async (request) => {
				if (request.kind === 'release') {
					remoteActive = false;
				} else {
					if (++requests === 2) await creation.promise;
					// A destroyed guest can be recreated by an in-flight resolve or frame.
					remoteActive = true;
				}
				return { ok: true };
			});
			const id = await relay.open('disconnected-client', target, viewport);
			const pending = relay.run('disconnected-client', id, kind);
			relay.closeClient('disconnected-client');
			expect(remoteActive).toBe(false);
			const successor = hasSuccessor
				? await relay.open('successor-client', target, viewport)
				: undefined;
			creation.resolve();
			await expect(pending).rejects.toThrow('expired');
			expect(remoteActive).toBe(hasSuccessor);
			if (successor) {
				relay.assertActive('successor-client', successor);
				relay.close('successor-client', successor);
				expect(remoteActive).toBe(false);
			}
		}
	);

	it.each([false, true])(
		'cleans up a disconnected pending open without suspending a successor (successor: %s)',
		async (hasSuccessor) => {
			const firstResolve = Promise.withResolvers<void>();
			let opens = 0;
			let remoteActive = false;
			const relay = new BrowserRelay(async (request) => {
				if (request.kind === 'resolve') {
					if (++opens === 1) await firstResolve.promise;
					// Page creation can finish after the disconnect's early release.
					remoteActive = true;
				} else if (request.kind === 'release') {
					remoteActive = false;
				}
				return { ok: true };
			});
			const opening = relay.open('disconnected-client', target, viewport);
			relay.closeClient('disconnected-client');
			expect(remoteActive).toBe(false);
			const successor = hasSuccessor
				? await relay.open('successor-client', target, viewport)
				: undefined;
			firstResolve.resolve();
			await expect(opening).rejects.toThrow('disconnected while opening');
			expect(remoteActive).toBe(hasSuccessor);
			if (successor) {
				relay.assertActive('successor-client', successor);
				relay.close('successor-client', successor);
				expect(remoteActive).toBe(false);
			}
		}
	);
});

describe('browser target and input authorization', () => {
	it('refuses nonfinite coordinates, unbounded paste/scroll, unsupported events and injected modifiers', () => {
		for (const input of [
			{ type: 'mouseDown', x: NaN, y: 1 },
			{ type: 'mouseDown', x: 1, y: -1 },
			{ type: 'mouseWheel', x: 1, y: 1, deltaX: 0, deltaY: Infinity },
			{ type: 'text', text: 'x'.repeat(16_385) },
			{ type: 'keyDown', keyCode: 'A', modifiers: ['capsLock'] },
			{ type: 'touchStart', x: 1, y: 1 },
		])
			expect(() => validateInput(input as never)).toThrow('Invalid browser');
	});
});

describe('browser relay effects under a ceiling (MRC-09-04)', () => {
	const page = (url: string) => ({
		url,
		title: 't',
		canGoBack: false,
		canGoForward: false,
		isLoading: false,
		width: 800,
		height: 600,
	});
	const receipt = {
		policyRevision: 3,
		surface: 'relay' as const,
		actor: 'the operator',
		destination: null,
	};

	/** A relay over a host that names `https://host.test/page` and frames `https://host.test/next`, held by `deny`. */
	function guarded(
		deny: (effect: BrowserRelayEffect) => BrowserEffectDecision['allowed'] | string
	) {
		const held: BrowserRelayEffect[] = [];
		const requests: Array<Omit<BrowserRelayRequest, 'requestId'>> = [];
		const relay = new BrowserRelay(
			async (request) => {
				requests.push(request);
				if (request.kind === 'frame')
					return { ok: true, frame: { ...page('https://host.test/next'), dataUrl: 'data:,' } };
				if (request.kind === 'resolve') return { ok: true, state: page('https://host.test/page') };
				return { ok: true, value: 'done' };
			},
			Date.now,
			(effect) => {
				held.push(effect);
				const verdict = deny(effect);
				if (verdict === true) return { allowed: true };
				return {
					allowed: false,
					code: 'outside-ceiling',
					message: typeof verdict === 'string' ? verdict : `no ${effect.kind}`,
					managed: { ...receipt, effect: effect.kind, outcome: 'outside-ceiling' },
				};
			}
		);
		return { relay, held, requests };
	}

	it('holds nothing on a host with no ceiling source', async () => {
		const relay = new BrowserRelay(async () => ({ ok: true, value: 1 }));
		const id = await relay.open('client', target, viewport);
		await expect(
			relay.run('client', id, 'action', undefined, { kind: 'eval', code: '1' })
		).resolves.toMatchObject({ value: 1 });
		expect(() => relay.assertEffect('client', id, 'execute')).not.toThrow();
	});

	it('open holds a view against the page the host named and a refusal releases the view', async () => {
		const { relay, held, requests } = guarded((effect) => effect.kind !== 'view');
		await expect(relay.open('client', target, viewport)).rejects.toThrow(
			'Browser relay refused: [managed-outside-ceiling] no view'
		);
		expect(held).toEqual([{ kind: 'view', target, destination: 'https://host.test/page' }]);
		expect(requests.map((r) => r.kind)).toEqual(['resolve', 'release']);
		expect(requests.filter((r) => r.kind === 'frame')).toHaveLength(0);
		await expect(relay.open('other', target, viewport)).rejects.toThrow('managed-outside-ceiling');
	});

	it('a lease is not a permit: each frame, action and input is held by itself', async () => {
		const { relay, held, requests } = guarded((effect) =>
			['view', 'read'].includes(effect.kind) ? true : `the ceiling admits no ${effect.kind}`
		);
		const id = await relay.open('client', target, viewport);
		await expect(relay.run('client', id, 'frame')).resolves.toMatchObject({
			frame: { url: 'https://host.test/next' },
		});
		await expect(
			relay.run('client', id, 'action', undefined, { kind: 'extract', format: 'text' })
		).resolves.toMatchObject({ value: 'done' });
		await expect(
			relay.run('client', id, 'action', undefined, { kind: 'eval', code: '1' })
		).rejects.toThrow('[managed-outside-ceiling] the ceiling admits no execute');
		expect(() => relay.assertEffect('client', id, 'input')).toThrow(
			'[managed-outside-ceiling] the ceiling admits no input'
		);
		await expect(
			relay.run('client', id, 'action', undefined, { kind: 'clearData' })
		).rejects.toThrow('the ceiling admits no clear');
		// Held with the page as last observed: the resolve named it, the frame moved it.
		expect(held.map((effect) => [effect.kind, effect.destination])).toEqual([
			['view', 'https://host.test/page'],
			['view', 'https://host.test/page'],
			['read', 'https://host.test/next'],
			['execute', 'https://host.test/next'],
			['input', 'https://host.test/next'],
			['clear', 'https://host.test/next'],
		]);
		// Nothing refused reached the host, and the lease is still live.
		expect(requests.map((r) => r.kind)).toEqual(['resolve', 'frame', 'action']);
		expect(() => relay.assertActive('client', id)).not.toThrow();
	});

	it('a navigation is held against the URL it requests; the page is unknown until the host reports it', async () => {
		const { relay, held } = guarded(() => true);
		const id = await relay.open('client', target, viewport);
		await relay.run('client', id, 'action', undefined, {
			kind: 'navigate',
			url: 'https://elsewhere.test/login',
		});
		relay.assertEffect('client', id, 'input');
		await relay.run('client', id, 'action', undefined, { kind: 'reload' });
		await relay.run('client', id, 'resolve');
		relay.assertEffect('client', id, 'input');
		expect(held.map((effect) => [effect.kind, effect.destination])).toEqual([
			['view', 'https://host.test/page'],
			['navigate', 'https://elsewhere.test/login'],
			['input', null],
			['navigate', null],
			['view', null],
			['input', 'https://host.test/page'],
		]);
	});

	it('refuses an input on a lease another client holds or that expired, before the ceiling is asked', () => {
		const { relay, held } = guarded(() => true);
		expect(() => relay.assertEffect('client', 'missing', 'input')).toThrow('expired');
		expect(held).toEqual([]);
	});

	it.each<[Parameters<typeof relayEffectOf>[0], BrowserRelayAction | undefined, string]>([
		['frame', undefined, 'view'],
		['resolve', undefined, 'view'],
		['action', { kind: 'navigate', url: 'https://x.test' }, 'navigate'],
		['action', { kind: 'back' }, 'navigate'],
		['action', { kind: 'forward' }, 'navigate'],
		['action', { kind: 'reload' }, 'navigate'],
		['action', { kind: 'stop' }, 'navigate'],
		['action', { kind: 'clearData' }, 'clear'],
		['action', { kind: 'deleteSelection' }, 'input'],
		['action', { kind: 'eval', code: '1' }, 'execute'],
		['action', { kind: 'selection' }, 'read'],
		['action', { kind: 'extract', format: 'html' }, 'read'],
		['action', { kind: 'find', text: 'x' }, 'read'],
	])('%s %o is a %s effect', (kind, action, effect) => {
		expect(relayEffectOf(kind, action)).toBe(effect);
	});
});
