/**
 * The platform endpoint transport (MCOMP-31-04, NATIVE-ENDPOINT/1): the
 * address rule per platform, the native port a macOS or Windows client needs,
 * and the connection gate that names the serving process before a byte is
 * written. The native port here is a declared fixture over the fake daemon's
 * real Unix socket: nothing in this file is an OS peer read, a code-signature
 * check or a named pipe. Actual platform peer identity is MCOMP-32.
 */

import * as net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { createPlatformEndpointClient } from '../../../main/enterprise/endpoint-client';
import {
	ENDPOINT_NATIVE_PORT_VERSION,
	endpointAddressProblem,
	endpointNativePortProblem,
	endpointServerVerificationProblems,
	endpointTransportOf,
	type EndpointNativePort,
	type EndpointPort,
	type EndpointServerIdentity,
	type EndpointServerVerification,
} from '../../../shared/maestro-lib/managed/endpoint-port';
import { startFakeEndpoint, type FakeEndpoint } from './fakeEndpoint';

const SERVER: EndpointServerIdentity = {
	pid: 4242,
	processBirthDigest: 'a'.repeat(64),
	executableDigest: 'b'.repeat(64),
	principal: '_megamaestro',
};
const COMPAT = {
	protocol: 1 as const,
	components: [{ id: 'maestro', kind: 'maestro', version: '1.1.0-RC' }],
	requiredCapabilities: [],
};
const PIPE = '\\\\.\\pipe\\mega-maestro-endpoint-a1';

interface FixturePort extends EndpointNativePort {
	seen: Array<{ address: string; connected: boolean; callsBefore: number }>;
}

function nativePort(
	fake: FakeEndpoint | null,
	answer: () => EndpointServerVerification | Promise<EndpointServerVerification>,
	overrides: Partial<EndpointNativePort> = {}
): FixturePort {
	const seen: FixturePort['seen'] = [];
	return {
		version: ENDPOINT_NATIVE_PORT_VERSION,
		platform: 'darwin',
		transport: 'unix-socket',
		seen,
		verifyServer: async ({ address, handle }) => {
			seen.push({
				address,
				connected: handle instanceof net.Socket && !handle.connecting && !handle.destroyed,
				callsBefore: fake?.calls.length ?? 0,
			});
			return answer();
		},
		...overrides,
	};
}

describe('endpoint transport rules', () => {
	it('maps each platform to its transport and accepts only its own local address', () => {
		const transports = ['linux', 'darwin', 'win32', 'freebsd'].map(endpointTransportOf);
		expect(transports).toEqual(['unix-socket', 'unix-socket', 'named-pipe', null]);
		expect(endpointAddressProblem('linux', '/var/lib/mme/run/ipc.sock')).toBeNull();
		expect(endpointAddressProblem('darwin', '/Library/Application Support/M/ipc.sock')).toBeNull();
		expect(endpointAddressProblem('win32', PIPE)).toBeNull();
		const bad = [
			['win32', '\\\\fileserver\\pipe\\mega-maestro-endpoint-a1'],
			['win32', 'C:\\ProgramData\\MegaMaestro\\ipc.sock'],
			['win32', '\\\\.\\pipe\\a/b'],
			['darwin', PIPE],
			['darwin', 'relative/ipc.sock'],
			['linux', `/${'x'.repeat(120)}`],
			['linux', 'http://127.0.0.1:7000'],
			['freebsd', '/tmp/ipc.sock'],
		] as const;
		for (const [platform, address] of bad) {
			expect(endpointAddressProblem(platform, address), address).not.toBeNull();
		}
	});

	it('requires a matching native port on macOS and Windows and none on Linux', () => {
		const mac = nativePort(null, () => ({ status: 'verified', server: SERVER }));
		const win = { ...mac, platform: 'win32', transport: 'named-pipe' as const };
		expect(endpointNativePortProblem('linux', undefined)).toBeNull();
		expect(endpointNativePortProblem('darwin', mac)).toBeNull();
		expect(endpointNativePortProblem('win32', win)).toBeNull();
		expect(endpointNativePortProblem('darwin', undefined)).toMatch(/No native endpoint port/);
		expect(endpointNativePortProblem('win32', undefined)).toMatch(/unavailable/);
		expect(endpointNativePortProblem('win32', mac)).toMatch(/reads darwin/);
		expect(endpointNativePortProblem('win32', { ...win, transport: 'unix-socket' })).toMatch(
			/verifies a unix-socket/
		);
		expect(endpointNativePortProblem('darwin', { ...mac, version: 2 as 1 })).toMatch(/version 2/);
	});

	it('accepts only a verification that names a whole server identity', () => {
		const ok = (server: object) =>
			endpointServerVerificationProblems({ status: 'verified', server });
		expect(ok(SERVER)).toEqual([]);
		expect(ok({ ...SERVER, principal: 'NT SERVICE\\mega-maestro-endpoint' })).toEqual([]);
		const refusals = [null, { status: 'refused', reason: 'x' }, { status: 'unavailable' }, {}];
		for (const bad of refusals) expect(endpointServerVerificationProblems(bad)).not.toEqual([]);
		for (const field of [{ pid: 0 }, { processBirthDigest: 'ab' }, { executableDigest: null }]) {
			expect(ok({ ...SERVER, ...field })).not.toEqual([]);
		}
		for (const principal of ['', 'a\nb']) expect(ok({ ...SERVER, principal })).not.toEqual([]);
	});
});

describe('platform endpoint client', () => {
	const open: FakeEndpoint[] = [];
	const clients: EndpointPort[] = [];

	async function endpoint(): Promise<FakeEndpoint> {
		const fake = await startFakeEndpoint();
		open.push(fake);
		return fake;
	}
	function client(fake: FakeEndpoint, native: EndpointNativePort, timeoutMs?: number) {
		const port = createPlatformEndpointClient({
			socketPath: fake.socketPath,
			platform: 'darwin',
			native,
			timeoutMs,
		});
		clients.push(port);
		return port;
	}

	afterEach(async () => {
		for (const port of clients.splice(0)) await port.close();
		for (const fake of open.splice(0)) await fake.close();
	});

	it('is not built on macOS or Windows without a native port, and Linux keeps its socket rule', () => {
		expect(() =>
			createPlatformEndpointClient({ socketPath: '/tmp/ipc.sock', platform: 'darwin' })
		).toThrow(/No native endpoint port is installed for darwin/);
		expect(() => createPlatformEndpointClient({ socketPath: PIPE, platform: 'win32' })).toThrow(
			/No native endpoint port is installed for win32/
		);
		expect(() =>
			createPlatformEndpointClient({ socketPath: '/tmp/ipc.sock', platform: 'win32' })
		).toThrow(/local named pipe/);
		const linux = createPlatformEndpointClient({ socketPath: '/tmp/ipc.sock', platform: 'linux' });
		clients.push(linux);
		expect(linux.state()).toEqual({
			connection: 0,
			attached: false,
			status: null,
			registration: 'none',
			closed: false,
		});
	});

	it('names the server of each connection before the first byte and binds it to the connection', async () => {
		const fake = await endpoint();
		const native = nativePort(fake, () => ({ status: 'verified', server: SERVER }));
		const port = client(fake, native);
		expect(port.state().server).toBeNull();

		expect((await port.compatibility(COMPAT)).status).toBe('ok');
		expect(native.seen).toEqual([{ address: fake.socketPath, connected: true, callsBefore: 0 }]);
		expect(port.state()).toMatchObject({ connection: 1, server: SERVER });
		// Reused keep-alive connection: not verified again.
		expect((await port.compatibility(COMPAT)).status).toBe('ok');
		expect(native.seen).toHaveLength(1);

		port.redial();
		expect(port.state().server).toBeNull();
		expect((await port.compatibility(COMPAT)).status).toBe('ok');
		expect(native.seen).toHaveLength(2);
		expect(native.seen[1].callsBefore).toBe(2);
		expect(port.state()).toMatchObject({ connection: 2, server: SERVER });
	});

	it('writes nothing to a server the native port refuses, cannot name, or misdescribes', async () => {
		const answers: Array<() => EndpointServerVerification | Promise<EndpointServerVerification>> = [
			() => ({
				status: 'refused',
				reason: 'code signature does not match the endpoint requirement',
			}),
			() => ({ status: 'unavailable', reason: 'no audit token for this socket' }),
			() => Promise.reject(new Error('native module not loaded')),
			() => {
				throw new Error('synchronous native failure');
			},
			() => ({ status: 'verified', server: { ...SERVER, pid: -1 } }),
		];
		for (const answer of answers) {
			const fake = await endpoint();
			const port = client(fake, nativePort(fake, answer));
			const compat = await port.compatibility(COMPAT);
			expect(compat).toMatchObject({ status: 'unavailable', reason: 'peer-unverified' });
			const challenge = await port.registration.challenge({
				runtimeId: 'desktop-100',
				processEpoch: 'epoch-1',
			});
			expect(challenge).toMatchObject({ status: 'unavailable', reason: 'peer-unverified' });
			expect(fake.calls).toEqual([]);
			expect(port.state()).toMatchObject({ connection: 0, server: null, attached: false });
		}
	});

	it('refuses a later connection served by another principal than the first', async () => {
		const fake = await endpoint();
		let principal = SERVER.principal;
		const port = client(
			fake,
			nativePort(fake, () => ({ status: 'verified', server: { ...SERVER, principal } }))
		);
		expect((await port.compatibility(COMPAT)).status).toBe('ok');
		principal = 'someone-else';
		port.redial();
		const after = await port.compatibility(COMPAT);
		expect(after).toMatchObject({ status: 'unavailable', reason: 'peer-unverified' });
		if (after.status === 'unavailable') expect(after.message).toMatch(/not _megamaestro/);
		expect(fake.calls).toHaveLength(1);
		expect(port.state().server).toBeNull();
	});

	it('gives up on a verification that does not answer and aborts it', async () => {
		const fake = await endpoint();
		let aborted = false;
		const native = nativePort(fake, () => new Promise<never>(() => undefined), {
			verifyServer: ({ signal }) =>
				new Promise<never>(() => {
					signal.addEventListener('abort', () => {
						aborted = true;
					});
				}),
		});
		const port = client(fake, native, 150);
		const outcome = await port.compatibility(COMPAT);
		expect(outcome).toMatchObject({ status: 'unavailable', reason: 'timeout' });
		expect(aborted).toBe(true);
		expect(fake.calls).toEqual([]);
	});
});
