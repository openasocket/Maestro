import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { FastifyInstance } from 'fastify';
const fixture = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('node:http', () => ({ createServer: fixture.create }));
vi.mock('node:os', async (importOriginal) => ({
	...(await importOriginal<typeof import('node:os')>()),
	networkInterfaces: () => ({
		Ethernet: [
			{ address: '192.168.20.10', netmask: '255.255.255.0', family: 'IPv4', internal: false },
		],
	}),
}));
import { listenLan, listenTailnet } from '../../../main/lite/tailnet-listener';
import {
	heldListeners,
	isListenerDeniedError,
	setListenerAuthority,
} from '../../../main/enterprise/listener-gate';
import {
	denyingListenerAuthority,
	managedListenerAuthority,
} from '../../helpers/listenerAuthority';
beforeEach(() => vi.clearAllMocks());
afterEach(() => setListenerAuthority(null));
function bindableListener() {
	const listener = new EventEmitter() as EventEmitter & {
		listen: ReturnType<typeof vi.fn>;
		close: ReturnType<typeof vi.fn>;
	};
	listener.listen = vi.fn((_port: number, _address: string, done: () => void) => done());
	listener.close = vi.fn((done: () => void) => done());
	fixture.create.mockReturnValue(listener);
	return listener;
}
const loopbackBackend = () =>
	({
		server: { address: () => ({ address: '127.0.0.1', port: 56036 }), emit: vi.fn() },
		routing: vi.fn(),
	}) as unknown as FastifyInstance;
describe('selected LAN listener', () => {
	it.each(['0.0.0.0', '::', '192.168.20.10'])(
		'reuses an existing %s listener on the direct port without stopping it',
		async (address) => {
			const close = vi.fn();
			const backend = { server: { address: () => ({ address, port: 56036 }), close } };
			const stop = await listenLan(backend as unknown as FastifyInstance, '192.168.20.10');
			expect(fixture.create).not.toHaveBeenCalled();
			await stop();
			expect(close).not.toHaveBeenCalled();
		}
	);
	it('binds only the selected interface, exposes only Lite routes, and closes accepted sockets', async () => {
		const listener = new EventEmitter() as EventEmitter & {
			listen: ReturnType<typeof vi.fn>;
			close: ReturnType<typeof vi.fn>;
		};
		listener.listen = vi.fn((_port: number, _address: string, done: () => void) => done());
		listener.close = vi.fn((done: () => void) => done());
		fixture.create.mockReturnValue(listener);
		const backend = {
			server: { address: () => ({ address: '127.0.0.1', port: 56036 }), emit: vi.fn() },
			routing: vi.fn(),
		};
		const stop = await listenLan(backend as unknown as FastifyInstance, '192.168.20.10');
		expect(listener.listen).toHaveBeenCalledWith(56036, '192.168.20.10', expect.any(Function));
		const request = fixture.create.mock.calls[0][0];
		const response = { writeHead: vi.fn().mockReturnThis(), end: vi.fn() };
		request({ url: '/normal-desktop' }, response);
		expect(response.writeHead).toHaveBeenCalledWith(404);
		expect(backend.routing).not.toHaveBeenCalled();
		const liteRequest = { url: '/.well-known/maestro/discovery' };
		request(liteRequest, response);
		expect(backend.routing).toHaveBeenCalledWith(liteRequest, response);
		const socket = Object.assign(new EventEmitter(), { destroy: vi.fn() });
		listener.emit('connection', socket);
		listener.emit('upgrade', { url: '/ws' }, socket, Buffer.alloc(0));
		expect(socket.destroy).toHaveBeenCalledOnce();
		const upgrade = { url: '/.well-known/maestro/control/bridge' };
		const head = Buffer.from('head');
		listener.emit('upgrade', upgrade, socket, head);
		expect(backend.server.emit).toHaveBeenCalledWith('upgrade', upgrade, socket, head);
		await stop();
		await stop();
		expect(socket.destroy).toHaveBeenCalledTimes(2);
		expect(listener.close).toHaveBeenCalledOnce();
	});
	it.each(['0.0.0.0', '127.0.0.1', '100.64.0.10', '192.168.20.99'])(
		'refuses to bind ineligible address %s',
		async (address) => {
			await expect(listenLan({} as FastifyInstance, address)).rejects.toThrow(
				'eligible private LAN interface'
			);
			expect(fixture.create).not.toHaveBeenCalled();
		}
	);
});
describe('direct listeners under the listener ceiling (MRC2-05-06A)', () => {
	it('refuses the LAN listener before any socket exists, naming the tailnet kind at the interface', async () => {
		const denying = denyingListenerAuthority('kind-denied');
		setListenerAuthority(denying.authority);
		const attempt = listenLan(loopbackBackend(), '192.168.20.10');
		await expect(attempt).rejects.toSatisfy((error: unknown) => isListenerDeniedError(error));
		await expect(attempt).rejects.toThrow(/\[managed-kind-denied\]/);
		expect(denying.requests).toEqual([{ kind: 'tailnet', bind: '192.168.20.10', port: 56036 }]);
		expect(fixture.create).not.toHaveBeenCalled();
		expect(heldListeners()).toMatchObject([
			{ kind: 'tailnet', bind: '192.168.20.10', port: 56036, reach: 'lan', count: 1 },
		]);
	});
	it('refuses to offer Lite over an already bound LAN-port server as well', async () => {
		const denying = denyingListenerAuthority('unavailable');
		setListenerAuthority(denying.authority);
		const close = vi.fn();
		const backend = { server: { address: () => ({ address: '0.0.0.0', port: 56036 }), close } };
		await expect(listenLan(backend as unknown as FastifyInstance, '192.168.20.10')).rejects.toThrow(
			/\[managed-unavailable\]/
		);
		expect(denying.requests).toHaveLength(1);
		expect(close).not.toHaveBeenCalled();
	});
	it('keeps the standalone interface check first, so an ineligible address never reaches the ceiling', async () => {
		const denying = denyingListenerAuthority('kind-denied');
		setListenerAuthority(denying.authority);
		await expect(listenLan({} as FastifyInstance, '100.64.0.10')).rejects.toThrow(
			'eligible private LAN interface'
		);
		await expect(listenTailnet({} as FastifyInstance, '192.168.20.10')).rejects.toThrow(
			'Tailscale interface'
		);
		expect(denying.requests).toEqual([]);
	});
	it('under the real ceiling, a tailnet entry admits the Tailscale listener and refuses the LAN one by reach', async () => {
		const managed = managedListenerAuthority([{ kind: 'tailnet', reach: 'tailnet' }]);
		setListenerAuthority(managed.authority);
		await expect(listenLan(loopbackBackend(), '192.168.20.10')).rejects.toThrow(
			/\[managed-reach-denied\]/
		);
		expect(fixture.create).not.toHaveBeenCalled();
		const listener = bindableListener();
		const stop = await listenTailnet(loopbackBackend(), '100.64.0.1');
		expect(listener.listen).toHaveBeenCalledWith(56036, '100.64.0.1', expect.any(Function));
		await stop();
		expect(managed.requests).toEqual([
			{ kind: 'tailnet', bind: '192.168.20.10', port: 56036 },
			{ kind: 'tailnet', bind: '100.64.0.1', port: 56036 },
		]);
		expect(heldListeners()).toMatchObject([{ kind: 'tailnet', code: 'reach-denied' }]);
	});
	it('under the real ceiling, a lan entry admits both', async () => {
		const managed = managedListenerAuthority([{ kind: 'tailnet', reach: 'lan' }]);
		setListenerAuthority(managed.authority);
		const listener = bindableListener();
		await (
			await listenLan(loopbackBackend(), '192.168.20.10')
		)();
		await (
			await listenTailnet(loopbackBackend(), '100.64.0.1')
		)();
		expect(listener.listen).toHaveBeenCalledTimes(2);
		expect(heldListeners()).toEqual([]);
	});
});
