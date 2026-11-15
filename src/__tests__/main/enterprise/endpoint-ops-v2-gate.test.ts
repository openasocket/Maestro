/**
 * The v2 operation clients behind their negotiation gate
 * (`src/main/enterprise/endpoint-ops-v2.ts`).
 *
 * What is defended: no v2 operation client sends a byte unless the current
 * connection's v2 attachment negotiated that operation; with it negotiated,
 * the request goes out on the v2 path under the operation's wire name, the
 * inbox request with its v1 `idempotencyKey` unchanged; `localControl` and
 * `command` validate what they send and the receipt they hear, and a
 * `localControl` selector this registration's purpose cannot carry is never
 * sent; and the selection holds exactly the passing parity rows, so a caller
 * moves onto v2 only where the attachment negotiated the operation.
 *
 * The port here is an in-memory double, so nothing here is paired enforcement.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLocalEndpointClient } from '../../../main/enterprise/endpoint-client';
import {
	V2_OPERATIONS_SELECTED,
	createEndpointOperationsV2Client,
	selectEndpointOperationPath,
	v2OperationNegotiated,
	type EndpointOperationsV2Client,
} from '../../../main/enterprise/endpoint-ops-v2';
import {
	LOCAL_ENDPOINT_INVOKE_PATH,
	LOCAL_ENDPOINT_INVOKE_V2_PATH,
	LOCAL_ENDPOINT_OPERATION_V2_CLIENTS,
	LOCAL_ENDPOINT_PROTOCOL_V2,
	type EndpointAttachmentRequest,
	type EndpointAttachmentRequestV2,
	type EndpointConnectionState,
	type EndpointOperationV2Client,
	type EndpointPort,
	type EndpointPortV2,
	type EndpointStatusV2,
} from '../../../shared/maestro-lib/managed/endpoint-port';
import {
	endpointInboxPort,
	endpointTelemetryPort,
	type EndpointInboxRequest,
	type EndpointNoticeListRequest,
	type EndpointTelemetryEvent,
} from '../../../shared/maestro-lib/managed/host-adapter';
import { startFakeEndpoint, type FakeEndpoint } from './fakeEndpoint';

const REQUESTS: Record<EndpointOperationV2Client, unknown> = {
	noticeList: { offset: 0, limit: 8 },
	inbox: {
		campaignId: 'campaign-1',
		messageId: 'message-1',
		idempotencyKey: 'idem-from-v1-ledger',
		action: 'delivered',
	},
	telemetry: { eventId: 'event-1' },
	budget: { reservationId: 'reservation-1' },
	offline: { allowanceId: 'allowance-1' },
	desktopPolicy: { operation: 'read' },
	model: { requestId: 'request-1' },
	localControl: {
		commandId: 'command-1',
		targetId: 'desktop-100',
		expiresAt: '2099-01-01T00:00:00.000Z',
		policyRevision: 3,
		precondition: { processEpoch: 'epoch-1', expectedRunId: null },
		action: { kind: 'report_status' },
	},
	command: {
		command: { signature: 'sig', payload: { commandId: 'command-2', kind: 'cancel_run' } },
		correlation: {
			registration: { challengeId: 'chal-1' },
			requestId: 'request-2',
			attemptId: 'attempt-1',
			envelopeDigest: 'd'.repeat(64),
		},
	},
};

/** What the double answers: an echo, or the receipt the two receipt-checked operations need. */
function reply(operation: string, payload: unknown): unknown {
	if (operation === 'localControl') return { outcome: 'completed', commandId: 'command-1' };
	if (operation === 'command') {
		return {
			outcome: 'accepted',
			commandId: 'command-2',
			runId: 'run-1',
			processEpoch: 'epoch-1',
			correlation: (payload as { correlation: unknown }).correlation,
		};
	}
	return { echoed: payload };
}

const COMPONENTS = [{ id: 'maestro', kind: 'maestro' as const, version: '1.1.0-RC' }];
const ATTACH_V1: EndpointAttachmentRequest = {
	installationId: 'inst-1',
	runtimeId: 'desktop-100',
	processEpoch: 'epoch-1',
	components: COMPONENTS,
	supportedProtocols: [1],
	supportedCapabilities: ['attachment', 'compatibility', 'telemetry', 'inbox', 'noticeList'],
	requiredCapabilities: [],
};
const ATTACH_V2: EndpointAttachmentRequestV2 = {
	...ATTACH_V1,
	supportedProtocols: [2],
};

function fakePort(capabilities: readonly string[] | null, withV2 = true) {
	const invoke = vi.fn(async (operation: string, payload: unknown) => ({
		status: 'ok' as const,
		payload: reply(operation, payload),
	}));
	const v1Invoke = vi.fn();
	const state = (): EndpointConnectionState => ({
		connection: 1,
		attached: true,
		status: null,
		registration: 'registered',
		closed: false,
		...(capabilities
			? {
					negotiated: {
						protocol: LOCAL_ENDPOINT_PROTOCOL_V2,
						capabilities,
						status: {} as EndpointStatusV2,
					},
				}
			: {}),
	});
	const v2 = {
		negotiated: (operation: string) => capabilities?.includes(operation) ?? false,
		invoke,
	} as unknown as EndpointPortV2;
	const port = { state, invoke: v1Invoke, ...(withV2 ? { v2 } : {}) } as unknown as EndpointPort;
	return { port, invoke, v1Invoke };
}

/** The client as this process composes it: a runtime_use registration. */
const runtimeClient = (port: EndpointPort) =>
	createEndpointOperationsV2Client(port, { registrationPurpose: () => 'runtime_use' });

function callOp(client: EndpointOperationsV2Client, operation: EndpointOperationV2Client) {
	return (client[operation] as (request: unknown) => Promise<unknown>)(REQUESTS[operation]);
}

describe('V2_OPERATIONS_SELECTED', () => {
	it('holds every v2 operation client, which are the passing parity rows, and execution', () => {
		// execution has its own client (execution-v2.ts) and no v1 caller to move.
		expect([...V2_OPERATIONS_SELECTED].sort()).toEqual(
			[...LOCAL_ENDPOINT_OPERATION_V2_CLIENTS, 'execution'].sort()
		);
	});
});

describe('v2OperationNegotiated', () => {
	it('is true only for an operation the v2 attachment listed', () => {
		const { port } = fakePort(['inbox']);
		expect(v2OperationNegotiated(port.state(), 'inbox')).toBe(true);
		expect(v2OperationNegotiated(port.state(), 'telemetry')).toBe(false);
	});

	it('is false with no v2 attachment on the connection', () => {
		const { port } = fakePort(null);
		expect(v2OperationNegotiated(port.state(), 'inbox')).toBe(false);
	});
});

describe('createEndpointOperationsV2Client', () => {
	it.each(LOCAL_ENDPOINT_OPERATION_V2_CLIENTS)(
		'%s answers not-negotiated and sends nothing when the capability is absent',
		async (operation) => {
			const others = LOCAL_ENDPOINT_OPERATION_V2_CLIENTS.filter((op) => op !== operation);
			const { port, invoke, v1Invoke } = fakePort(['attachment', ...others]);
			const outcome = await callOp(runtimeClient(port), operation);
			expect(outcome).toMatchObject({ status: 'unavailable', reason: 'not-negotiated' });
			expect(invoke).not.toHaveBeenCalled();
			expect(v1Invoke).not.toHaveBeenCalled();
		}
	);

	it.each(LOCAL_ENDPOINT_OPERATION_V2_CLIENTS)(
		'%s answers not-negotiated on a port with no v2 side',
		async (operation) => {
			const { port, invoke, v1Invoke } = fakePort([...LOCAL_ENDPOINT_OPERATION_V2_CLIENTS], false);
			const outcome = await callOp(runtimeClient(port), operation);
			expect(outcome).toMatchObject({ status: 'unavailable', reason: 'not-negotiated' });
			expect(invoke).not.toHaveBeenCalled();
			expect(v1Invoke).not.toHaveBeenCalled();
		}
	);

	it.each(LOCAL_ENDPOINT_OPERATION_V2_CLIENTS)(
		'%s goes out on v2 under its wire name when negotiated',
		async (operation) => {
			const { port, invoke, v1Invoke } = fakePort([operation]);
			const outcome = await callOp(runtimeClient(port), operation);
			expect(invoke).toHaveBeenCalledTimes(1);
			expect(invoke).toHaveBeenCalledWith(operation, REQUESTS[operation]);
			expect(v1Invoke).not.toHaveBeenCalled();
			expect(outcome).toEqual({ status: 'ok', payload: reply(operation, REQUESTS[operation]) });
		}
	);

	it('localControl refresh_policy needs fleet_management: a runtime_use registration sends nothing', async () => {
		const { port, invoke } = fakePort(['localControl']);
		const request = {
			...(REQUESTS.localControl as object),
			action: { kind: 'refresh_policy', desiredRevision: 4 },
		};
		const outcome = await runtimeClient(port).localControl(request as never);
		expect(outcome).toMatchObject({ status: 'unavailable', reason: 'not-authorized' });
		const none = await createEndpointOperationsV2Client(port).localControl(
			REQUESTS.localControl as never
		);
		expect(none).toMatchObject({ status: 'unavailable', reason: 'not-authorized' });
		expect(invoke).not.toHaveBeenCalled();
		const fleet = await createEndpointOperationsV2Client(port, {
			registrationPurpose: () => 'fleet_management',
		}).localControl(request as never);
		expect(fleet.status).toBe('ok');
		expect(invoke).toHaveBeenCalledTimes(1);
	});

	it('localControl refuses a malformed request before sending, and a cancel that expects another run', async () => {
		const { port, invoke } = fakePort(['localControl']);
		const base = REQUESTS.localControl as Record<string, unknown>;
		for (const request of [
			{ ...base, commandId: '' },
			{ ...base, expiresAt: 'soon' },
			{ ...base, policyRevision: -1 },
			{ ...base, action: { kind: 'reboot' } },
			{ ...base, action: { kind: 'cancel_run', runId: 'run-1' } },
		]) {
			expect(await runtimeClient(port).localControl(request as never)).toMatchObject({
				status: 'unavailable',
				reason: 'malformed',
			});
		}
		expect(invoke).not.toHaveBeenCalled();
	});

	it('rejects a receipt that is not for the request sent, and passes a denial through', async () => {
		const { port, invoke } = fakePort(['localControl', 'command']);
		invoke.mockResolvedValueOnce({
			status: 'ok',
			payload: { outcome: 'completed', commandId: 'someone-else' },
		} as never);
		expect(await runtimeClient(port).localControl(REQUESTS.localControl as never)).toMatchObject({
			status: 'unavailable',
			reason: 'malformed',
		});
		invoke.mockResolvedValueOnce({
			status: 'ok',
			payload: {
				...(reply('command', REQUESTS.command) as object),
				correlation: { requestId: 'other' },
			},
		} as never);
		expect(await runtimeClient(port).command(REQUESTS.command as never)).toMatchObject({
			status: 'unavailable',
			reason: 'malformed',
		});
		invoke.mockResolvedValueOnce({
			status: 'ok',
			payload: { outcome: 'denied', reason: 'policy_denied' },
		} as never);
		expect(await runtimeClient(port).command(REQUESTS.command as never)).toEqual({
			status: 'ok',
			payload: { outcome: 'denied', reason: 'policy_denied' },
		});
	});

	it('carries the inbox idempotencyKey unchanged', async () => {
		const { port, invoke } = fakePort(['inbox']);
		await callOp(runtimeClient(port), 'inbox');
		expect(invoke.mock.calls[0][1]).toMatchObject({ idempotencyKey: 'idem-from-v1-ledger' });
	});

	it('passes a refusal through unchanged', async () => {
		const { port, invoke } = fakePort(['budget']);
		invoke.mockResolvedValueOnce({ status: 'denied', reason: 'policy_denied' } as never);
		const outcome = await callOp(runtimeClient(port), 'budget');
		expect(outcome).toEqual({ status: 'denied', reason: 'policy_denied' });
	});
});

describe('selectEndpointOperationPath', () => {
	it('with the shipped selection, answers v2 for every operation the attachment negotiated and v1 otherwise', () => {
		const { port } = fakePort([...LOCAL_ENDPOINT_OPERATION_V2_CLIENTS]);
		for (const operation of LOCAL_ENDPOINT_OPERATION_V2_CLIENTS) {
			expect(selectEndpointOperationPath(port, operation)).toBe('v2');
		}
		const { port: v1 } = fakePort(null);
		for (const operation of LOCAL_ENDPOINT_OPERATION_V2_CLIENTS) {
			expect(selectEndpointOperationPath(v1, operation)).toBe('v1');
		}
		expect(selectEndpointOperationPath(port, 'telemetry', [])).toBe('v1');
	});

	it('answers v2 only when selected AND negotiated', () => {
		const { port } = fakePort(['telemetry']);
		expect(selectEndpointOperationPath(port, 'telemetry', ['telemetry'])).toBe('v2');
		expect(selectEndpointOperationPath(port, 'inbox', ['inbox'])).toBe('v1');
		expect(selectEndpointOperationPath(port, 'telemetry', ['inbox'])).toBe('v1');
	});

	it('answers v1 on a port with no v2 side, whatever the selection', () => {
		const { port } = fakePort([...LOCAL_ENDPOINT_OPERATION_V2_CLIENTS], false);
		expect(selectEndpointOperationPath(port, 'telemetry', ['telemetry'])).toBe('v1');
	});
});

describe('the existing v1 callers go through the selection', () => {
	const INBOX = REQUESTS.inbox as EndpointInboxRequest;
	const LIST = REQUESTS.noticeList as EndpointNoticeListRequest;
	const EVENT = REQUESTS.telemetry as EndpointTelemetryEvent;

	async function callAll(port: EndpointPort, selected?: readonly string[]) {
		const inbox = endpointInboxPort(port, selected);
		await inbox.list(LIST);
		await inbox.act(INBOX);
		await endpointTelemetryPort(port, selected).report(EVENT);
	}

	it('with the shipped selection, every caller sends on v2 when negotiated, and on v1 when not', async () => {
		const { port, invoke, v1Invoke } = fakePort([...LOCAL_ENDPOINT_OPERATION_V2_CLIENTS]);
		await callAll(port);
		expect(v1Invoke).not.toHaveBeenCalled();
		expect(invoke.mock.calls).toEqual([
			['noticeList', LIST],
			['inbox', INBOX],
			['telemetry', EVENT],
		]);
		const legacy = fakePort(null);
		await callAll(legacy.port);
		expect(legacy.invoke).not.toHaveBeenCalled();
		expect(legacy.v1Invoke.mock.calls).toEqual([
			['noticeList', LIST],
			['inbox', INBOX],
			['telemetry', EVENT],
		]);
	});

	it('with a test-only selection and the capability negotiated, every caller sends on v2 under its wire name', async () => {
		const { port, invoke, v1Invoke } = fakePort(['noticeList', 'inbox', 'telemetry']);
		await callAll(port, ['noticeList', 'inbox', 'telemetry']);
		expect(v1Invoke).not.toHaveBeenCalled();
		expect(invoke.mock.calls).toEqual([
			['noticeList', LIST],
			['inbox', INBOX],
			['telemetry', EVENT],
		]);
		expect(invoke.mock.calls[1][1]).toMatchObject({ idempotencyKey: 'idem-from-v1-ledger' });
	});

	it('with a test-only selection but the capability absent, the caller stays on v1', async () => {
		const { port, invoke, v1Invoke } = fakePort(['attachment']);
		await callAll(port, ['noticeList', 'inbox', 'telemetry']);
		expect(invoke).not.toHaveBeenCalled();
		expect(v1Invoke).toHaveBeenCalledTimes(3);
	});
});

describe('the selection over the real client and a fake daemon', () => {
	const open: FakeEndpoint[] = [];
	const clients: EndpointPort[] = [];

	afterEach(async () => {
		for (const port of clients.splice(0)) await port.close();
		for (const fake of open.splice(0)) await fake.close();
	});

	async function setUp() {
		const fake = await startFakeEndpoint({
			v2Capabilities: ['noticeList', 'inbox', 'telemetry'],
			operations: {
				noticeList: () => ({ outcome: 'notices' }),
				inbox: () => ({ outcome: 'recorded' }),
				telemetry: () => ({ outcome: 'accepted' }),
			},
		});
		open.push(fake);
		let next = 0;
		const port = createLocalEndpointClient({
			socketPath: fake.socketPath,
			newCorrelationId: () => `corr-${++next}`,
		});
		clients.push(port);
		return { fake, port };
	}

	it('a v1 attachment: the callers reach /v1/invoke only, never /v2/invoke', async () => {
		const { fake, port } = await setUp();
		expect((await port.attach(ATTACH_V1)).status).toBe('ok');
		const inbox = endpointInboxPort(port);
		await inbox.list(REQUESTS.noticeList as EndpointNoticeListRequest);
		await inbox.act(REQUESTS.inbox as EndpointInboxRequest);
		await endpointTelemetryPort(port).report(REQUESTS.telemetry as EndpointTelemetryEvent);

		expect(fake.callsTo(LOCAL_ENDPOINT_INVOKE_V2_PATH)).toHaveLength(0);
		const v1 = fake.callsTo(LOCAL_ENDPOINT_INVOKE_PATH).slice(1);
		expect(v1.map((c) => (c.body as { operation: string }).operation)).toEqual([
			'noticeList',
			'inbox',
			'telemetry',
		]);
	});

	it('test-only selection with the capability negotiated: the callers send the v2 envelope', async () => {
		const { fake, port } = await setUp();
		expect((await port.v2!.attach(ATTACH_V2)).status).toBe('ok');
		const selected = ['noticeList', 'inbox', 'telemetry'];
		const inbox = endpointInboxPort(port, selected);
		expect(await inbox.list(REQUESTS.noticeList as EndpointNoticeListRequest)).toEqual({
			status: 'ok',
			payload: { outcome: 'notices' },
		});
		await inbox.act(REQUESTS.inbox as EndpointInboxRequest);
		await endpointTelemetryPort(port, selected).report(
			REQUESTS.telemetry as EndpointTelemetryEvent
		);

		expect(fake.callsTo(LOCAL_ENDPOINT_INVOKE_PATH)).toHaveLength(0);
		const sent = fake.callsTo(LOCAL_ENDPOINT_INVOKE_V2_PATH).slice(1);
		expect(sent.map((c) => c.body)).toEqual([
			{
				schemaVersion: 2,
				correlationId: 'corr-2',
				operation: 'noticeList',
				payload: REQUESTS.noticeList,
			},
			{ schemaVersion: 2, correlationId: 'corr-3', operation: 'inbox', payload: REQUESTS.inbox },
			{
				schemaVersion: 2,
				correlationId: 'corr-4',
				operation: 'telemetry',
				payload: REQUESTS.telemetry,
			},
		]);
	});
});
