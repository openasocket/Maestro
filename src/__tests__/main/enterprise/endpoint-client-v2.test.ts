/**
 * The protocol 2 side of the local endpoint client (`port.v2`), over a real
 * Unix socket against the fake daemon in `fakeEndpoint.ts`. What is defended:
 * a v2 attachment negotiates protocol 2 on `/v2/invoke` only, a v2 answer is
 * read only when it echoes the request's correlationId and operation, a v2
 * refusal is returned as the refusal and never retried on `/v1/invoke`, and
 * `execution` is never negotiated when the endpoint does not offer it.
 *
 * The daemon here is a double, so nothing in this file is paired enforcement
 * and no OS peer is authenticated.
 */

import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { createLocalEndpointClient } from '../../../main/enterprise/endpoint-client';
import {
	LOCAL_ENDPOINT_INVOKE_PATH,
	LOCAL_ENDPOINT_INVOKE_V2_PATH,
	type EndpointAttachmentRequestV2,
	type EndpointPort,
	type EndpointPortV2,
} from '../../../shared/maestro-lib/managed/endpoint-port';
import { startFakeEndpoint, type FakeEndpoint, type FakeEndpointOptions } from './fakeEndpoint';

const ATTACH_V2: EndpointAttachmentRequestV2 = {
	installationId: 'inst-1',
	runtimeId: 'desktop-100',
	processEpoch: 'epoch-1',
	components: [{ id: 'maestro', kind: 'maestro', version: '1.1.0-RC' }],
	supportedProtocols: [2],
	supportedCapabilities: ['attachment', 'compatibility', 'telemetry', 'execution'],
	requiredCapabilities: [],
};

const COMPATIBILITY_V2 = {
	protocol: 2,
	components: ATTACH_V2.components,
	supportedProtocols: [2],
	supportedCapabilities: ATTACH_V2.supportedCapabilities,
	requiredCapabilities: [],
};

describe('local endpoint client, protocol 2', () => {
	const open: Array<{ close(): Promise<void> }> = [];
	const clients: EndpointPort[] = [];

	async function endpoint(options: FakeEndpointOptions = {}): Promise<FakeEndpoint> {
		const fake = await startFakeEndpoint(options);
		open.push(fake);
		return fake;
	}
	function client(
		socketPath: string,
		extra: Partial<Parameters<typeof createLocalEndpointClient>[0]> = {}
	): { port: EndpointPort; v2: EndpointPortV2 } {
		const port = createLocalEndpointClient({ socketPath, ...extra });
		clients.push(port);
		expect(port.v2).toBeDefined();
		return { port, v2: port.v2! };
	}

	afterEach(async () => {
		for (const port of clients.splice(0)) await port.close();
		for (const server of open.splice(0)) await server.close();
	});

	it('a v2 attach negotiates protocol 2 on /v2/invoke and records it on the connection', async () => {
		const fake = await endpoint({ v2Capabilities: ['telemetry'] });
		const { port, v2 } = client(fake.socketPath);

		const attached = await v2.attach(ATTACH_V2);
		expect(attached.status).toBe('ok');
		if (attached.status === 'ok') {
			expect(attached.payload.outcome).toBe('attached');
			expect(attached.payload.protocol).toBe(2);
			expect(attached.payload.capabilities).toEqual(['attachment', 'compatibility', 'telemetry']);
		}
		const state = port.state();
		expect(state.negotiated?.protocol).toBe(2);
		expect(state.negotiated?.capabilities).toEqual(['attachment', 'compatibility', 'telemetry']);
		expect(v2.negotiated('telemetry')).toBe(true);
		expect(v2.negotiated('inbox')).toBe(false);

		expect(fake.callsTo(LOCAL_ENDPOINT_INVOKE_V2_PATH)).toHaveLength(1);
		expect(fake.callsTo(LOCAL_ENDPOINT_INVOKE_PATH)).toHaveLength(0);
		const sent = fake.calls[0].body as {
			schemaVersion: number;
			operation: string;
			payload: { supportedProtocols: number[] };
		};
		expect(sent.schemaVersion).toBe(2);
		expect(sent.operation).toBe('attachment');
		expect(sent.payload.supportedProtocols).toEqual([2]);
	});

	it('a v2 invoke round trip echoes the correlationId and operation of the request', async () => {
		const fake = await endpoint({
			v2Capabilities: ['telemetry'],
			operations: { telemetry: (payload) => ({ outcome: 'accepted', payload }) },
		});
		let next = 0;
		const { v2 } = client(fake.socketPath, { newCorrelationId: () => `corr-${++next}` });
		expect((await v2.attach(ATTACH_V2)).status).toBe('ok');

		const outcome = await v2.invoke('telemetry', { eventId: 'e1' });
		expect(outcome).toEqual({
			status: 'ok',
			payload: { outcome: 'accepted', payload: { eventId: 'e1' } },
		});
		const calls = fake.callsTo(LOCAL_ENDPOINT_INVOKE_V2_PATH);
		expect(calls).toHaveLength(2);
		expect(calls[1].body).toEqual({
			schemaVersion: 2,
			correlationId: 'corr-2',
			operation: 'telemetry',
			payload: { eventId: 'e1' },
		});
		expect(fake.callsTo(LOCAL_ENDPOINT_INVOKE_PATH)).toHaveLength(0);
	});

	it('an answer whose correlationId does not match the request is refused as malformed', async () => {
		// A daemon double that answers every v2 envelope with someone else's correlationId.
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-mismatch-'));
		const socketPath = path.join(dir, 'runtime.sock');
		const paths: string[] = [];
		const server = http.createServer((req, res) => {
			paths.push(req.url ?? '');
			const chunks: Buffer[] = [];
			req.on('data', (chunk: Buffer) => chunks.push(chunk));
			req.on('end', () => {
				const env = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
					operation: string;
				};
				res.setHeader('content-type', 'application/json');
				res.writeHead(200);
				res.end(
					JSON.stringify({
						schemaVersion: 2,
						correlationId: 'not-the-request',
						operation: env.operation,
						payload: { outcome: 'negotiated', protocol: 2, capabilities: ['attachment'] },
					})
				);
			});
		});
		await new Promise<void>((resolve) => server.listen(socketPath, resolve));
		open.push({
			close: async () => {
				server.closeAllConnections();
				await new Promise<void>((resolve) => server.close(() => resolve()));
				fs.rmSync(dir, { recursive: true, force: true });
			},
		});

		const { port, v2 } = client(socketPath);
		const outcome = await v2.invoke('compatibility', COMPATIBILITY_V2);
		expect(outcome).toMatchObject({ status: 'unavailable', reason: 'malformed' });
		if (outcome.status === 'unavailable') expect(outcome.message).toMatch(/correlationId/);

		const attached = await v2.attach(ATTACH_V2);
		expect(attached).toMatchObject({ status: 'unavailable', reason: 'malformed' });
		expect(port.state().negotiated).toBeUndefined();
		expect(v2.negotiated('attachment')).toBe(false);
		expect(paths).toEqual([LOCAL_ENDPOINT_INVOKE_V2_PATH, LOCAL_ENDPOINT_INVOKE_V2_PATH]);
	});

	it('a v2 refusal is returned as the refusal and /v1/invoke is called zero times', async () => {
		const fake = await endpoint();
		const { port, v2 } = client(fake.socketPath);

		const capability = await v2.attach({ ...ATTACH_V2, requiredCapabilities: ['telemetry'] });
		expect(capability).toEqual({ status: 'denied', reason: 'unsupported_capability' });
		expect(port.state().negotiated).toBeUndefined();

		const unattached = await v2.invoke('telemetry', {});
		expect(unattached).toEqual({ status: 'denied', reason: 'unauthenticated' });

		// A daemon that predates protocol 2: the refusal stays a v2 refusal.
		fake.options.v2 = false;
		const old = await v2.attach(ATTACH_V2);
		expect(old).toEqual({ status: 'denied', reason: 'invalid_request' });
		expect(port.state().negotiated).toBeUndefined();

		expect(fake.callsTo(LOCAL_ENDPOINT_INVOKE_PATH)).toHaveLength(0);
		expect(fake.calls.every((call) => call.path === LOCAL_ENDPOINT_INVOKE_V2_PATH)).toBe(true);
	});

	it('never negotiates execution when the endpoint does not offer it', async () => {
		const fake = await endpoint({ v2Capabilities: ['telemetry', 'inbox'] });
		const { port, v2 } = client(fake.socketPath);

		const attached = await v2.attach(ATTACH_V2);
		expect(attached.status).toBe('ok');
		if (attached.status === 'ok') expect(attached.payload.capabilities).not.toContain('execution');
		expect(port.state().negotiated?.capabilities).not.toContain('execution');
		expect(v2.negotiated('execution')).toBe(false);

		const compat = await v2.invoke('compatibility', COMPATIBILITY_V2);
		expect(compat.status).toBe('ok');
		if (compat.status === 'ok') {
			expect((compat.payload as { capabilities: string[] }).capabilities).not.toContain(
				'execution'
			);
		}

		const required = await v2.attach({ ...ATTACH_V2, requiredCapabilities: ['execution'] });
		expect(required).toEqual({ status: 'denied', reason: 'unsupported_capability' });
		expect(v2.negotiated('execution')).toBe(false);
		expect(fake.callsTo(LOCAL_ENDPOINT_INVOKE_PATH)).toHaveLength(0);
	});
});
