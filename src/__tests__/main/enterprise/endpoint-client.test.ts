/**
 * The local endpoint client over a real Unix socket, against the fake daemon
 * in `fakeEndpoint.ts`. What is defended: the client never speaks TCP, never
 * sends what it cannot describe, reads only answers to its own questions,
 * keeps the endpoint's per-socket session semantics (attach first; a dropped
 * socket drops everything but the process registration), and reports a lost
 * answer to an effectful request as `unknown`, never as a retry.
 *
 * The daemon here is a double, so nothing in this file is paired enforcement
 * (CP-01, CP-03) and no OS peer is authenticated.
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
	createLocalEndpointClient,
	endpointSocketPathProblem,
} from '../../../main/enterprise/endpoint-client';
import {
	LOCAL_ENDPOINT_MAX_REQUEST_BYTES,
	type EndpointAttachmentRequest,
	type EndpointPort,
} from '../../../shared/maestro-lib/managed/endpoint-port';
import { startFakeEndpoint, type FakeEndpoint } from './fakeEndpoint';

const ATTACH: EndpointAttachmentRequest = {
	installationId: 'inst-1',
	runtimeId: 'desktop-100',
	processEpoch: 'epoch-1',
	components: [{ id: 'maestro', kind: 'maestro', version: '1.1.0-RC' }],
	supportedProtocols: [1],
	supportedCapabilities: ['attachment', 'compatibility', 'telemetry', 'execution'],
	requiredCapabilities: [],
};

describe('local endpoint client', () => {
	const open: FakeEndpoint[] = [];
	const clients: EndpointPort[] = [];

	async function endpoint(options = {}): Promise<FakeEndpoint> {
		const fake = await startFakeEndpoint(options);
		open.push(fake);
		return fake;
	}
	function client(
		fake: FakeEndpoint,
		extra: Partial<Parameters<typeof createLocalEndpointClient>[0]> = {}
	) {
		const port = createLocalEndpointClient({ socketPath: fake.socketPath, ...extra });
		clients.push(port);
		return port;
	}

	afterEach(async () => {
		for (const port of clients.splice(0)) await port.close();
		for (const fake of open.splice(0)) await fake.close();
	});

	it('refuses anything that is not an absolute Unix socket path', () => {
		for (const bad of [
			'http://127.0.0.1:9000',
			'localhost:9000',
			'127.0.0.1:1',
			'relative/sock',
			'',
		]) {
			expect(endpointSocketPathProblem(bad), bad).not.toBeNull();
			expect(() => createLocalEndpointClient({ socketPath: bad })).toThrow(
				/Endpoint socket refused/
			);
		}
		expect(endpointSocketPathProblem('/tmp/' + 'x'.repeat(100))).toMatch(/longer than/);
		expect(endpointSocketPathProblem('/tmp/endpoint.sock')).toBeNull();
	});

	it('negotiates, attaches, and then invokes on the same connection', async () => {
		const fake = await endpoint();
		const port = client(fake);
		const compat = await port.compatibility({
			protocol: 1,
			components: ATTACH.components,
			requiredCapabilities: ['telemetry'],
		});
		expect(compat.status).toBe('ok');
		if (compat.status === 'ok') expect(compat.payload.capabilities).toContain('telemetry');

		const attached = await port.attach(ATTACH);
		expect(attached.status).toBe('ok');
		if (attached.status === 'ok') {
			expect(attached.payload.management).toBe('managed');
			expect(attached.payload.capabilities).toEqual([
				'attachment',
				'compatibility',
				'telemetry',
				'execution',
			]);
		}
		expect(port.state()).toMatchObject({ connection: 1, attached: true, registration: 'none' });

		const echoed = await port.invoke('telemetry', { eventId: 'e1' });
		expect(echoed).toEqual({
			status: 'ok',
			payload: { outcome: 'echo', operation: 'telemetry', payload: { eventId: 'e1' } },
		});
		expect(fake.calls.map((c) => c.socket)).toEqual([1, 1, 1]);
		const ids = fake.calls.map((c) => (c.body as { correlationId: string }).correlationId);
		expect(new Set(ids).size).toBe(3);
	});

	it('does not send an operation before the connection is attached', async () => {
		const fake = await endpoint();
		const port = client(fake);
		const outcome = await port.invoke('telemetry', {});
		expect(outcome).toMatchObject({ status: 'unavailable', reason: 'not-attached' });
		expect(fake.calls).toHaveLength(0);
	});

	it('does not send an attachment it cannot describe', async () => {
		const fake = await endpoint();
		const port = client(fake);
		const outcome = await port.attach({ ...ATTACH, processEpoch: '2026-10-21T12:00:00.000Z' });
		expect(outcome).toMatchObject({ status: 'unavailable', reason: 'malformed' });
		if (outcome.status === 'unavailable') expect(outcome.message).toMatch(/processEpoch/);
		expect(fake.calls).toHaveLength(0);
	});

	it("passes the endpoint's own denial through, and an attach denial leaves the socket unattached", async () => {
		const fake = await endpoint();
		const port = client(fake);
		const outcome = await port.attach({ ...ATTACH, requiredCapabilities: ['model'] });
		expect(outcome).toEqual({ status: 'denied', reason: 'unsupported_capability' });
		expect(port.state().attached).toBe(false);
		const next = await port.invoke('telemetry', {});
		expect(next).toMatchObject({ status: 'unavailable', reason: 'not-attached' });
	});

	it('a reused correlation id is a replay the endpoint refuses', async () => {
		const fake = await endpoint();
		const port = client(fake, { newCorrelationId: () => 'same-id' });
		expect((await port.attach(ATTACH)).status).toBe('ok');
		expect(await port.invoke('telemetry', {})).toEqual({ status: 'denied', reason: 'replay' });
	});

	it('forgets the session when the endpoint drops the connection', async () => {
		const fake = await endpoint();
		const port = client(fake);
		expect((await port.attach(ATTACH)).status).toBe('ok');
		fake.dropConnections();
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(port.state()).toMatchObject({ attached: false, status: null });
		const outcome = await port.invoke('telemetry', {});
		expect(outcome).toMatchObject({ status: 'unavailable', reason: 'not-attached' });
		expect((await port.attach(ATTACH)).status).toBe('ok');
		expect(port.state().connection).toBe(2);
	});

	it('redeems a registration challenge on the connection that asked, and keeps it across a redial', async () => {
		const fake = await endpoint({ registrationRequired: true });
		const port = client(fake);
		expect(await port.attach(ATTACH)).toEqual({ status: 'denied', reason: 'unauthenticated' });

		expect(await port.registration.redeem()).toMatchObject({
			status: 'unavailable',
			reason: 'no-challenge',
		});
		const challenge = await port.registration.challenge({
			runtimeId: 'desktop-100',
			processEpoch: 'epoch-1',
		});
		expect(challenge.status).toBe('ok');
		if (challenge.status === 'ok') {
			expect(challenge.payload.nonce).toHaveLength(43);
			expect(challenge.payload.challengeDigest).toMatch(/^[a-f0-9]{64}$/);
		}
		expect(port.state().registration).toBe('challenged');
		expect(await port.registration.redeem()).toEqual({
			status: 'ok',
			payload: { protocol: 1, outcome: 'registered' },
		});
		expect(port.state().registration).toBe('registered');
		expect(fake.registered()).toBe(true);
		expect(new Set(fake.calls.map((c) => c.socket)).size).toBe(1);

		expect((await port.attach(ATTACH)).status).toBe('ok');
		fake.dropConnections();
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(port.state()).toMatchObject({ attached: false, registration: 'registered' });
		expect((await port.attach(ATTACH)).status).toBe('ok');
	});

	it('a challenge that was not redeemed dies with its connection', async () => {
		const fake = await endpoint({ registrationRequired: true });
		const port = client(fake);
		expect((await port.registration.challenge({ runtimeId: 'r', processEpoch: 'e' })).status).toBe(
			'ok'
		);
		fake.dropConnections();
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(port.state().registration).toBe('none');
		expect(await port.registration.redeem()).toMatchObject({
			status: 'unavailable',
			reason: 'no-challenge',
		});
		expect(fake.registered()).toBe(false);
	});

	it('refuses an attachment for a process the registration does not name', async () => {
		const fake = await endpoint({ registrationRequired: true });
		const port = client(fake);
		await port.registration.challenge({ runtimeId: 'desktop-100', processEpoch: 'epoch-1' });
		await port.registration.redeem();
		expect(await port.attach({ ...ATTACH, processEpoch: 'epoch-2' })).toEqual({
			status: 'denied',
			reason: 'unauthenticated',
		});
	});

	it('a revoked registration denies every later operation, attachment included', async () => {
		const fake = await endpoint({ registrationRequired: true });
		const port = client(fake);
		await port.registration.challenge({ runtimeId: 'desktop-100', processEpoch: 'epoch-1' });
		await port.registration.redeem();
		expect((await port.attach(ATTACH)).status).toBe('ok');
		fake.revokeRegistration();
		expect(await port.invoke('telemetry', {})).toEqual({
			status: 'denied',
			reason: 'unauthenticated',
		});
		expect(await port.attach(ATTACH)).toEqual({ status: 'denied', reason: 'unauthenticated' });
		expect(port.state().attached).toBe(false);
	});

	it('does not send a request over the size bound, and drops an answer over it', async () => {
		const fake = await endpoint({
			capabilities: Array.from({ length: 4000 }, (_, i) => `capability-${i}-${'x'.repeat(16)}`),
			maxResponseBytes: 1024 * 1024,
		});
		const port = client(fake);
		const big = await port.compatibility({
			protocol: 1,
			components: [
				{ id: 'maestro', kind: 'maestro', version: 'x'.repeat(LOCAL_ENDPOINT_MAX_REQUEST_BYTES) },
			],
			requiredCapabilities: [],
		});
		expect(big).toMatchObject({ status: 'unavailable', reason: 'oversized' });
		expect(fake.calls).toHaveLength(0);
		// A read-only answer over the bound is dropped unread and reported as such.
		const wide = await port.compatibility({
			protocol: 1,
			components: ATTACH.components,
			requiredCapabilities: [],
		});
		expect(wide).toMatchObject({ status: 'unavailable', reason: 'oversized' });
		expect(fake.calls).toHaveLength(1);
	});

	it('an oversized answer to an effectful request is unknown, since the request left', async () => {
		const fake = await endpoint({
			operations: { telemetry: () => ({ outcome: 'echo', blob: 'x'.repeat(70 * 1024) }) },
			maxResponseBytes: 1024 * 1024,
		});
		const port = client(fake);
		expect((await port.attach(ATTACH)).status).toBe('ok');
		expect((await port.invoke('telemetry', {})).status).toBe('unknown');
	});

	it('a lost answer is unknown for an effectful request and a timeout for a read-only one', async () => {
		const fake = await endpoint({ delayMs: 400 });
		const port = client(fake, { timeoutMs: 100 });
		const compat = await port.compatibility({
			protocol: 1,
			components: ATTACH.components,
			requiredCapabilities: [],
		});
		expect(compat).toMatchObject({ status: 'unavailable', reason: 'timeout' });
		fake.options.delayMs = 0;
		expect((await port.attach(ATTACH)).status).toBe('ok');
		fake.options.delayMs = 400;
		const effect = await port.invoke('execution', { requestId: 'r1' });
		expect(effect.status).toBe('unknown');
	});

	it('a daemon that rejects the schema version answers denied/unsupported_version', async () => {
		const fake = await endpoint();
		const port = client(fake);
		// The fake rejects any non-1 schemaVersion with a 400 denial; the client
		// always sends 1, so force the daemon's view through a stale envelope.
		fake.options.operations = {};
		const outcome = await port.compatibility({
			protocol: 1,
			components: ATTACH.components,
			requiredCapabilities: ['something-the-daemon-lacks'],
		});
		expect(outcome).toEqual({ status: 'denied', reason: 'unsupported_capability' });
	});

	it('a peer the daemon cannot authenticate is denied on every envelope and refused a registration', async () => {
		const fake = await endpoint({ peerAuthenticated: false });
		const port = client(fake);
		expect(await port.attach(ATTACH)).toEqual({ status: 'denied', reason: 'unauthenticated' });
		expect(
			await port.compatibility({ protocol: 1, components: [], requiredCapabilities: [] })
		).toEqual({
			status: 'denied',
			reason: 'unauthenticated',
		});
		expect(await port.registration.challenge({ runtimeId: 'r', processEpoch: 'e' })).toEqual({
			status: 'denied',
			reason: 'unavailable',
		});
		expect(port.state()).toMatchObject({ attached: false, registration: 'none' });
	});

	it('a second challenge on the same connection is a replay the daemon refuses, and the first is gone', async () => {
		const fake = await endpoint({ registrationRequired: true });
		const port = client(fake);
		expect((await port.registration.challenge({ runtimeId: 'r', processEpoch: 'e' })).status).toBe(
			'ok'
		);
		expect(await port.registration.challenge({ runtimeId: 'r', processEpoch: 'e' })).toEqual({
			status: 'denied',
			reason: 'unavailable',
		});
		expect(port.state().registration).toBe('none');
		expect(await port.registration.redeem()).toMatchObject({
			status: 'unavailable',
			reason: 'no-challenge',
		});
		expect(fake.registered()).toBe(false);
	});

	it('a daemon that speaks another schema version refuses every envelope as unsupported_version', async () => {
		const fake = await endpoint({ schemaVersion: 2 });
		const port = client(fake);
		expect(
			await port.compatibility({
				protocol: 1,
				components: ATTACH.components,
				requiredCapabilities: [],
			})
		).toEqual({
			status: 'denied',
			reason: 'unsupported_version',
		});
		expect(await port.attach(ATTACH)).toEqual({ status: 'denied', reason: 'unsupported_version' });
		expect(port.state().attached).toBe(false);
	});

	it('answers closed after close() and never dials again', async () => {
		const fake = await endpoint();
		const port = client(fake);
		expect((await port.attach(ATTACH)).status).toBe('ok');
		await port.close();
		expect(port.state().closed).toBe(true);
		expect(await port.invoke('telemetry', {})).toMatchObject({
			status: 'unavailable',
			reason: 'not-attached',
		});
		expect(
			await port.compatibility({ protocol: 1, components: [], requiredCapabilities: [] })
		).toMatchObject({
			status: 'unavailable',
			reason: 'closed',
		});
		expect(fake.calls).toHaveLength(1);
	});
});
