/**
 * The production attachment tries protocol 2 first, on a connection of its
 * own, and keeps the v1 session the host's callers use exactly as it was.
 *
 * Why two connections: the endpoint holds ONE negotiated protocol per socket
 * session (`apps/endpoint/src/ipc/server.ts` in the sibling checkout: a v2
 * attachment deletes the socket's v1 session, and a v1 operation on a v2
 * session is `unauthenticated`). Every operation this host sends today is v1
 * (`V2_OPERATIONS_SELECTED` is empty), so a v2 attachment on the v1 socket
 * would strand enrollment, telemetry, inbox and the v1 workflow owner port.
 *
 * What is defended: the v2 attachment offers `registration_use` and the four
 * workflow custody verbs with nothing required, is sent before the v1
 * attachment, and lets `useRegistration` reach `registration_use`; an endpoint
 * without protocol 2 (no `/v2/invoke`, or an offer without protocol 2) leaves
 * the v1 traffic byte-for-byte what a host with no v2 side sends; a subset
 * offer still attaches; no operation is ever sent on both paths, and a refused
 * v2 attachment is never resent on `/v1/invoke`.
 *
 * The daemon is a double (`fakeEndpoint.ts`); no OS peer is authenticated and
 * nothing here is paired enforcement.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createLocalEndpointClient } from '../../../main/enterprise/endpoint-client';
import {
	createEnrollmentLifecycle,
	type EnrollmentLifecycle,
} from '../../../main/enterprise/enrollment';
import {
	createEnterpriseIdentityStore,
	type EnterpriseIdentityStore,
} from '../../../main/enterprise/identity-store';
import { ENTERPRISE_SUPPORTED_CAPABILITIES_V2 } from '../../../main/enterprise/service';
import {
	LOCAL_ENDPOINT_INVOKE_PATH,
	LOCAL_ENDPOINT_INVOKE_V2_PATH,
	V2_OPERATIONS_SELECTED,
	type EndpointPort,
} from '../../../shared/maestro-lib/managed/endpoint-port';
import type { Anchor } from '../../../main/utils/keyring-anchor';
import { fakeAnchor, fakeSeal } from './fakeCustody';
import {
	startFakeEndpoint,
	type FakeEndpoint,
	type FakeEndpointCall,
	type FakeEndpointOptions,
} from './fakeEndpoint';

const NOW = Date.parse('2026-11-13T12:00:00.000Z');
const INSTALLATION = {
	installationId: 'inst-1',
	runtimeId: 'desktop-100',
	processEpoch: 'epoch-1',
};
const V1_SUPPORTED = ['attachment', 'compatibility', 'enrollment', 'telemetry'];
const SERVES_ENROLLMENT: FakeEndpointOptions = {
	capabilities: ['enrollment', 'telemetry'],
	operations: { enrollment: () => ({ outcome: 'enrollment_pending', enrollmentId: 'enr-1' }) },
	now: () => NOW,
};
const WORKFLOW_VERBS = ['workflow_claim', 'workflow_renew', 'workflow_settle', 'workflow_release'];
const ENROLL_INPUT = {
	tenantId: 'tenant-1',
	orgId: 'org-1',
	mode: 'attended' as const,
	invitation: 'invite-token',
	collectionProfile: 'metadata' as const,
	trustRootDigest: 'a'.repeat(64),
	keyPossessionProof: 'proof-from-endpoint-tooling',
};
const PROJECTED = {
	outcome: 'projected',
	reference: {
		version: 2,
		purpose: 'runtime_use',
		tenantId: 'tenant-1',
		orgId: 'org-1',
		enrollmentId: '7f1c2a4e-5b6d-4e8f-9a0b-1c2d3e4f5a6b',
		installationId: INSTALLATION.installationId,
		runtimeId: INSTALLATION.runtimeId,
		processEpoch: INSTALLATION.processEpoch,
		bindingDigest: 'a'.repeat(64),
		processBirthDigest: 'b'.repeat(64),
		challengeId: 'chal-1',
		challengeDigest: 'c'.repeat(64),
	},
	expiresAt: '2026-11-13T12:05:00.000Z',
};

type Envelope = { operation: string; payload: Record<string, unknown> };
const envelope = (call: FakeEndpointCall) => call.body as Envelope;
/** What the host sent on one path, without the per-request correlation id. */
const sent = (fake: FakeEndpoint, target: string) =>
	fake.callsTo(target).map((call) => ({
		operation: envelope(call).operation,
		payload: envelope(call).payload,
	}));
const operationsOn = (fake: FakeEndpoint, target: string) =>
	fake.callsTo(target).map((call) => envelope(call).operation);

describe('production attachment: v2 first, on its own connection', () => {
	let dir: string;
	let identity: EnterpriseIdentityStore;
	const open: FakeEndpoint[] = [];
	const lifecycles: EnrollmentLifecycle[] = [];
	let ports: EndpointPort[];
	let v2Ports: EndpointPort[];

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-attach-'));
		ports = [];
		v2Ports = [];
	});
	afterEach(async () => {
		for (const lifecycle of lifecycles.splice(0)) await lifecycle.close();
		for (const fake of open.splice(0)) await fake.close();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	async function endpoint(options: FakeEndpointOptions): Promise<FakeEndpoint> {
		const fake = await startFakeEndpoint({ ...SERVES_ENROLLMENT, ...options });
		open.push(fake);
		return fake;
	}

	function lifecycle(withV2: boolean, file: string): EnrollmentLifecycle {
		identity = createEnterpriseIdentityStore({
			file: path.join(dir, file),
			seal: fakeSeal(),
			anchor: fakeAnchor({ value: null as Anchor | null }),
			platform: 'darwin',
			now: () => NOW,
		});
		const created = createEnrollmentLifecycle({
			identity,
			openPort: (socketPath) => {
				const port = createLocalEndpointClient({ socketPath, timeoutMs: 1_000 });
				ports.push(port);
				return port;
			},
			installation: INSTALLATION,
			components: [{ id: 'maestro', kind: 'maestro', version: '1.1.0-RC' }],
			capabilities: { supported: V1_SUPPORTED, required: [] },
			now: () => NOW,
			...(withV2
				? {
						v2: {
							openPort: (socketPath: string) => {
								const port = createLocalEndpointClient({ socketPath, timeoutMs: 1_000 });
								v2Ports.push(port);
								return port;
							},
							supported: ENTERPRISE_SUPPORTED_CAPABILITIES_V2,
						},
					}
				: {}),
		});
		lifecycles.push(created);
		return created;
	}

	/** Enroll, register, reconnect, then send one v1 operation over the host's port. */
	async function run(fake: FakeEndpoint, withV2: boolean, file: string) {
		const life = lifecycle(withV2, file);
		expect(
			(await life.requestEnrollment({ ...ENROLL_INPUT, socketPath: fake.socketPath })).status
		).toBe('ok');
		expect((await life.beginRegistration()).status).toBe('ok');
		expect((await life.completeRegistration()).status).toBe('ok');
		expect((await life.connect()).status).toBe('ok');
		expect(ports).toHaveLength(1);
		const telemetry = await ports[0].invoke('telemetry', { probe: 1 });
		return { life, port: ports[0], telemetry };
	}

	it('offers registration_use and the workflow verbs, nothing required, and selects no caller onto v2', () => {
		expect(ENTERPRISE_SUPPORTED_CAPABILITIES_V2).toEqual([
			'attachment',
			'compatibility',
			'registration_use',
			...WORKFLOW_VERBS,
		]);
		expect(V2_OPERATIONS_SELECTED).toEqual([]);
	});

	it('negotiates v2 before the v1 attachment, and useRegistration then reaches registration_use', async () => {
		const fake = await endpoint({
			v2Capabilities: ['registration_use', ...WORKFLOW_VERBS],
			operations: {
				...SERVES_ENROLLMENT.operations,
				registration_use: () => PROJECTED,
			},
		});
		const { life, port, telemetry } = await run(fake, true, 'a.bin');

		// The v2 attachment request: protocol [2], the v2 offer, nothing required.
		const v2Attach = fake.callsTo(LOCAL_ENDPOINT_INVOKE_V2_PATH).map(envelope)[0];
		expect(v2Attach.operation).toBe('attachment');
		expect(v2Attach.payload).toMatchObject({
			installationId: INSTALLATION.installationId,
			runtimeId: INSTALLATION.runtimeId,
			processEpoch: INSTALLATION.processEpoch,
			supportedProtocols: [2],
			supportedCapabilities: ENTERPRISE_SUPPORTED_CAPABILITIES_V2,
			requiredCapabilities: [],
		});

		// Tried first: every v1 attachment follows a v2 attachment, on another socket.
		const order = fake.calls
			.filter((call) => envelope(call)?.operation === 'attachment')
			.map((call) => call.path);
		expect(order).toEqual([
			LOCAL_ENDPOINT_INVOKE_V2_PATH,
			LOCAL_ENDPOINT_INVOKE_PATH,
			LOCAL_ENDPOINT_INVOKE_V2_PATH,
			LOCAL_ENDPOINT_INVOKE_PATH,
			LOCAL_ENDPOINT_INVOKE_V2_PATH,
			LOCAL_ENDPOINT_INVOKE_PATH,
		]);
		const v1Sockets = new Set(fake.callsTo(LOCAL_ENDPOINT_INVOKE_PATH).map((c) => c.socket));
		const v2Sockets = new Set(fake.callsTo(LOCAL_ENDPOINT_INVOKE_V2_PATH).map((c) => c.socket));
		expect([...v2Sockets].some((socket) => v1Sockets.has(socket))).toBe(false);

		// The v2 connection holds the negotiation; the v1 port holds none and still works.
		expect(v2Ports).toHaveLength(1);
		for (const operation of ['registration_use', ...WORKFLOW_VERBS]) {
			expect(v2Ports[0].v2!.negotiated(operation)).toBe(true);
		}
		expect(port.state().negotiated).toBeUndefined();
		expect(port.state()).toMatchObject({ attached: true, registration: 'registered' });
		expect(telemetry).toEqual({
			status: 'ok',
			payload: { outcome: 'echo', operation: 'telemetry', payload: { probe: 1 } },
		});

		const used = await life.useRegistration();
		expect(used).toMatchObject({ status: 'ok', value: { outcome: 'projected' } });
		expect(operationsOn(fake, LOCAL_ENDPOINT_INVOKE_V2_PATH)).toEqual([
			'attachment',
			'attachment',
			'attachment',
			'registration_use',
		]);
		// No operation on both paths: only the attachment, each on its own connection.
		const v1Ops = new Set(operationsOn(fake, LOCAL_ENDPOINT_INVOKE_PATH));
		const v2Ops = new Set(operationsOn(fake, LOCAL_ENDPOINT_INVOKE_V2_PATH));
		expect([...v2Ops].filter((op) => v1Ops.has(op))).toEqual(['attachment']);

		await life.close();
		expect(v2Ports[0].state().closed).toBe(true);
	});

	it.each([
		['serves no /v2/invoke path', { v2: false }],
		['offers no protocol 2 (unsupported_version)', { v2Offered: false }],
	])(
		'an endpoint that %s leaves the host on v1, with the v1 traffic unchanged',
		async (_label, options: FakeEndpointOptions) => {
			const baseline = await endpoint({});
			const without = await run(baseline, false, 'baseline.bin');
			ports = [];
			const fake = await endpoint(options);
			const withV2 = await run(fake, true, 'v2.bin');

			// The v1 traffic is what a host with no v2 side sends, request for request.
			expect(sent(fake, LOCAL_ENDPOINT_INVOKE_PATH)).toEqual(
				sent(baseline, LOCAL_ENDPOINT_INVOKE_PATH)
			);
			expect(withV2.telemetry).toEqual(without.telemetry);
			expect(withV2.life.status().authority).toBe(without.life.status().authority);
			expect(withV2.life.status().endpoint).toEqual(without.life.status().endpoint);

			// The refused v2 attachment was never resent on v1, and the v2 connection is gone.
			for (const request of sent(fake, LOCAL_ENDPOINT_INVOKE_PATH)) {
				if (request.operation === 'attachment')
					expect(request.payload.supportedProtocols).toEqual([1]);
			}
			expect(v2Ports.length).toBeGreaterThan(0);
			for (const port of v2Ports) expect(port.state().closed).toBe(true);
			const used = await withV2.life.useRegistration();
			expect(used).toMatchObject({ status: 'unavailable', reason: 'not-negotiated' });
			expect(new Set(operationsOn(fake, LOCAL_ENDPOINT_INVOKE_V2_PATH))).toEqual(
				options.v2 === false ? new Set() : new Set(['attachment'])
			);
		}
	);

	it('a subset offer still attaches; an operation it did not select is never sent', async () => {
		const fake = await endpoint({ v2Capabilities: ['workflow_claim'] });
		const { life, telemetry } = await run(fake, true, 'subset.bin');

		expect(telemetry.status).toBe('ok');
		expect(v2Ports).toHaveLength(1);
		expect(v2Ports[0].state().closed).toBe(false);
		expect(v2Ports[0].v2!.negotiated('workflow_claim')).toBe(true);
		expect(v2Ports[0].v2!.negotiated('registration_use')).toBe(false);
		expect(v2Ports[0].v2!.negotiated('workflow_renew')).toBe(false);

		const used = await life.useRegistration();
		expect(used).toMatchObject({ status: 'unavailable', reason: 'not-negotiated' });
		expect(new Set(operationsOn(fake, LOCAL_ENDPOINT_INVOKE_V2_PATH))).toEqual(
			new Set(['attachment'])
		);
	});
});
