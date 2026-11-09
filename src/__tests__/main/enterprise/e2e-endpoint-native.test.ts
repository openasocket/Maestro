/**
 * The e2e fixture native endpoint port (MCOMP-31-05A): installed only in an
 * unpackaged test build that asked for it, and a packaged build still refuses.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
	E2E_FIXTURE_ENDPOINT_SERVER,
	e2eFixtureEndpointNative,
} from '../../../main/enterprise/e2e-endpoint-native';
import { createPlatformEndpointClient } from '../../../main/enterprise/endpoint-client';
import {
	endpointNativePortProblem,
	endpointServerVerificationProblems,
	type EndpointPort,
} from '../../../shared/maestro-lib/managed/endpoint-port';
import { startFakeEndpoint, type FakeEndpoint } from './fakeEndpoint';

const ENV = { NODE_ENV: 'test', MAESTRO_E2E_ENDPOINT_NATIVE: 'fixture' };
const COMPAT = {
	protocol: 1 as const,
	components: [{ id: 'maestro', kind: 'maestro', version: '1.1.0-RC' }],
	requiredCapabilities: [],
};

describe('e2e fixture native endpoint port', () => {
	it('installs nothing unless unpackaged, NODE_ENV=test and the variable says fixture', () => {
		const cases: Array<[boolean, Record<string, string | undefined>]> = [
			[true, ENV],
			[false, { ...ENV, NODE_ENV: 'production' }],
			[false, { ...ENV, NODE_ENV: undefined }],
			[false, { NODE_ENV: 'test' }],
			[false, { ...ENV, MAESTRO_E2E_ENDPOINT_NATIVE: '' }],
			[false, { ...ENV, MAESTRO_E2E_ENDPOINT_NATIVE: '1' }],
		];
		for (const [isPackaged, env] of cases) {
			for (const platform of ['darwin', 'win32', 'linux'] as const) {
				expect(e2eFixtureEndpointNative({ isPackaged, env, platform })).toBeUndefined();
			}
		}
		expect(e2eFixtureEndpointNative({ isPackaged: false, env: ENV, platform: 'aix' })).toBe(
			undefined
		);
	});

	it('a packaged darwin or win32 build ignores the variable and still refuses the endpoint', () => {
		for (const [platform, socketPath] of [
			['darwin', '/tmp/ipc.sock'],
			['win32', '\\\\.\\pipe\\mega-maestro-endpoint-a1'],
		] as const) {
			const native = e2eFixtureEndpointNative({ isPackaged: true, env: ENV, platform });
			expect(() => createPlatformEndpointClient({ socketPath, platform, native })).toThrow(
				/No native endpoint port is installed/
			);
		}
	});

	it('is a well-formed port for the host platform and transport that names the labeled server', async () => {
		for (const platform of ['darwin', 'win32', 'linux'] as const) {
			const port = e2eFixtureEndpointNative({ isPackaged: false, env: ENV, platform });
			expect(endpointNativePortProblem(platform, port)).toBeNull();
			const answer = await port!.verifyServer({
				address: '/tmp/x.sock',
				handle: null,
				signal: new AbortController().signal,
			});
			expect(endpointServerVerificationProblems(answer)).toEqual([]);
			expect(answer).toEqual({ status: 'verified', server: E2E_FIXTURE_ENDPOINT_SERVER });
			expect(E2E_FIXTURE_ENDPOINT_SERVER.principal).toBe('maestro-e2e-fixture-endpoint');
		}
		expect(
			e2eFixtureEndpointNative({ isPackaged: false, env: ENV, platform: 'win32' })?.transport
		).toBe('named-pipe');
	});

	it('answers unavailable once the verification is cancelled', async () => {
		const port = e2eFixtureEndpointNative({ isPackaged: false, env: ENV, platform: 'darwin' })!;
		const abort = new AbortController();
		abort.abort();
		const answer = await port.verifyServer({
			address: '/tmp/x.sock',
			handle: null,
			signal: abort.signal,
		});
		expect(answer.status).toBe('unavailable');
	});

	describe('over the fixture daemon', () => {
		let fake: FakeEndpoint | null = null;
		let port: EndpointPort | null = null;
		afterEach(async () => {
			await port?.close();
			await fake?.close();
			port = null;
			fake = null;
		});

		it('lets an unpackaged darwin test build reach the fixture daemon, bound to the labeled server', async () => {
			fake = await startFakeEndpoint();
			const native = e2eFixtureEndpointNative({ isPackaged: false, env: ENV, platform: 'darwin' });
			port = createPlatformEndpointClient({
				socketPath: fake.socketPath,
				platform: 'darwin',
				native,
			});
			expect((await port.compatibility(COMPAT)).status).toBe('ok');
			expect(port.state().server).toEqual(E2E_FIXTURE_ENDPOINT_SERVER);
		});
	});
});
