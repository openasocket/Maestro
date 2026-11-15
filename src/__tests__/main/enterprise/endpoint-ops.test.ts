/**
 * The operation clients behind their negotiation gate
 * (`src/main/enterprise/endpoint-ops.ts`) and the shared gate the other callers
 * send through (`invokeNegotiated`, `endpointInboxPort`, `endpointTelemetryPort`).
 *
 * What is defended: no operation client sends a byte unless the attachment on
 * the current connection negotiated that operation; with it negotiated, the
 * request goes out on `/v2/invoke` under the operation's wire name, the inbox
 * request with its `idempotencyKey` unchanged; `localControl` and `command`
 * validate what they send and the receipt they hear, and a `localControl`
 * selector this registration's purpose cannot carry is never sent.
 *
 * The port here is an in-memory double, so nothing here is paired enforcement.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLocalEndpointClient } from '../../../main/enterprise/endpoint-client';
import {
	createEndpointOperationsClient,
	type EndpointOperationsClient,
} from '../../../main/enterprise/endpoint-ops';
import {
	ENDPOINT_OPERATIONS_OFFERED,
	LOCAL_ENDPOINT_INVOKE_PATH,
	LOCAL_ENDPOINT_OPERATION_CLIENTS,
	LOCAL_ENDPOINT_PROTOCOL,
	operationNegotiated,
	type EndpointAttachmentRequest,
	type EndpointConnectionState,
	type EndpointOperationClient,
	type EndpointPort,
	type EndpointStatus,
} from '../../../shared/maestro-lib/managed/endpoint-port';
import {
	endpointInboxPort,
	endpointTelemetryPort,
	type EndpointInboxRequest,
	type EndpointNoticeListRequest,
	type EndpointTelemetryEvent,
} from '../../../shared/maestro-lib/managed/host-adapter';
import { startFakeEndpoint, type FakeEndpoint } from './fakeEndpoint';

const REQUESTS: Record<EndpointOperationClient, unknown> = {
	noticeList: { offset: 0, limit: 8 },
	inbox: {
		campaignId: 'campaign-1',
		messageId: 'message-1',
		idempotencyKey: 'idem-from-ledger',
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
const ATTACH: EndpointAttachmentRequest = {
	installationId: 'inst-1',
	runtimeId: 'desktop-100',
	processEpoch: 'epoch-1',
	components: COMPONENTS,
	supportedProtocols: [LOCAL_ENDPOINT_PROTOCOL],
	supportedCapabilities: ['attachment', 'compatibility', 'telemetry', 'inbox', 'noticeList'],
	requiredCapabilities: [],
};

/** An in-memory port: `capabilities` is what the attachment negotiated, or null for no attachment. */
function fakePort(capabilities: readonly string[] | null) {
	const invoke = vi.fn(async (operation: string, payload: unknown) => ({
		status: 'ok' as const,
		payload: reply(operation, payload),
	}));
	const state = (): EndpointConnectionState => ({
		connection: 1,
		attached: capabilities !== null,
		status: null,
		registration: 'registered',
		closed: false,
		...(capabilities
			? {
					negotiated: {
						protocol: LOCAL_ENDPOINT_PROTOCOL,
						capabilities: [...capabilities],
						status: {} as EndpointStatus,
					},
				}
			: {}),
	});
	const port = {
		state,
		invoke,
		negotiated: (operation: string) => operationNegotiated(state(), operation),
	} as unknown as EndpointPort;
	return { port, invoke };
}

/** The client as this process composes it: a runtime_use registration. */
const runtimeClient = (port: EndpointPort): EndpointOperationsClient =>
	createEndpointOperationsClient(port, { registrationPurpose: () => 'runtime_use' });

function callOp(client: EndpointOperationsClient, operation: EndpointOperationClient) {
	return (client[operation] as (request: unknown) => Promise<unknown>)(REQUESTS[operation]);
}

describe('ENDPOINT_OPERATIONS_OFFERED', () => {
	it('holds every operation client, which are the passing parity rows, and execution', () => {
		// execution has its own client (execution.ts) and is offered like the rest.
		expect([...ENDPOINT_OPERATIONS_OFFERED].sort()).toEqual(
			[...LOCAL_ENDPOINT_OPERATION_CLIENTS, 'execution'].sort()
		);
	});
});

describe('operationNegotiated', () => {
	it('is true only for an operation the attachment listed', () => {
		const { port } = fakePort(['inbox']);
		expect(operationNegotiated(port.state(), 'inbox')).toBe(true);
		expect(operationNegotiated(port.state(), 'telemetry')).toBe(false);
	});

	it('is false with no attachment on the connection', () => {
		const { port } = fakePort(null);
		expect(operationNegotiated(port.state(), 'inbox')).toBe(false);
	});
});

describe('createEndpointOperationsClient', () => {
	it.each(LOCAL_ENDPOINT_OPERATION_CLIENTS)(
		'%s answers not-negotiated and sends nothing when the capability is absent',
		async (operation) => {
			const others = LOCAL_ENDPOINT_OPERATION_CLIENTS.filter((op) => op !== operation);
			const { port, invoke } = fakePort(['attachment', ...others]);
			const outcome = await callOp(runtimeClient(port), operation);
			expect(outcome).toMatchObject({ status: 'unavailable', reason: 'not-negotiated' });
			expect(invoke).not.toHaveBeenCalled();
		}
	);

	it.each(LOCAL_ENDPOINT_OPERATION_CLIENTS)(
		'%s answers not-negotiated and sends nothing before any attachment',
		async (operation) => {
			const { port, invoke } = fakePort(null);
			const outcome = await callOp(runtimeClient(port), operation);
			expect(outcome).toMatchObject({ status: 'unavailable', reason: 'not-negotiated' });
			expect(invoke).not.toHaveBeenCalled();
		}
	);

	it.each(LOCAL_ENDPOINT_OPERATION_CLIENTS)(
		'%s goes out under its wire name when negotiated',
		async (operation) => {
			const { port, invoke } = fakePort([operation]);
			const outcome = await callOp(runtimeClient(port), operation);
			expect(invoke).toHaveBeenCalledTimes(1);
			expect(invoke).toHaveBeenCalledWith(operation, REQUESTS[operation]);
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
		const none = await createEndpointOperationsClient(port).localControl(
			REQUESTS.localControl as never
		);
		expect(none).toMatchObject({ status: 'unavailable', reason: 'not-authorized' });
		expect(invoke).not.toHaveBeenCalled();
		const fleet = await createEndpointOperationsClient(port, {
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
		expect(invoke.mock.calls[0][1]).toMatchObject({ idempotencyKey: 'idem-from-ledger' });
	});

	it('passes a refusal through unchanged', async () => {
		const { port, invoke } = fakePort(['budget']);
		invoke.mockResolvedValueOnce({ status: 'denied', reason: 'policy_denied' } as never);
		const outcome = await callOp(runtimeClient(port), 'budget');
		expect(outcome).toEqual({ status: 'denied', reason: 'policy_denied' });
	});
});

describe('the callers over the real client and a fake daemon', () => {
	const open: FakeEndpoint[] = [];
	const clients: EndpointPort[] = [];

	afterEach(async () => {
		for (const port of clients.splice(0)) await port.close();
		for (const fake of open.splice(0)) await fake.close();
	});

	async function setUp(capabilities: readonly string[]) {
		const fake = await startFakeEndpoint({
			capabilities,
			operations: {
				noticeList: () => ({ outcome: 'notices' }),
				inbox: () => ({ outcome: 'recorded' }),
				telemetry: () => ({ outcome: 'accepted' }),
			},
		});
		open.push(fake);
		const port = createLocalEndpointClient({ socketPath: fake.socketPath });
		clients.push(port);
		return { fake, port };
	}

	const LIST = REQUESTS.noticeList as EndpointNoticeListRequest;
	const INBOX = REQUESTS.inbox as EndpointInboxRequest;
	const EVENT = REQUESTS.telemetry as EndpointTelemetryEvent;

	it('an attachment that negotiated none of the callers: nothing is sent, and each caller answers not-negotiated', async () => {
		const { fake, port } = await setUp([]);
		expect((await port.attach(ATTACH)).status).toBe('ok');
		const before = fake.calls.length;
		expect(await endpointInboxPort(port).list(LIST)).toMatchObject({
			status: 'unavailable',
			reason: 'not-negotiated',
		});
		expect(await endpointInboxPort(port).act(INBOX)).toMatchObject({
			status: 'unavailable',
			reason: 'not-negotiated',
		});
		expect(await endpointTelemetryPort(port).report(EVENT)).toMatchObject({
			status: 'unavailable',
			reason: 'not-negotiated',
		});
		expect(fake.calls).toHaveLength(before);
	});

	it('an attachment that negotiated the callers: each sends on /v2/invoke under its wire name, the inbox key unchanged', async () => {
		const { fake, port } = await setUp(['noticeList', 'inbox', 'telemetry']);
		expect(
			(
				await port.attach({
					...ATTACH,
					supportedCapabilities: [
						'attachment',
						'compatibility',
						'noticeList',
						'inbox',
						'telemetry',
					],
				})
			).status
		).toBe('ok');
		expect(await endpointInboxPort(port).list(LIST)).toEqual({
			status: 'ok',
			payload: { outcome: 'notices' },
		});
		await endpointInboxPort(port).act(INBOX);
		await endpointTelemetryPort(port).report(EVENT);

		expect(
			fake
				.callsTo(LOCAL_ENDPOINT_INVOKE_PATH)
				.slice(1)
				.map((c) => c.body)
		).toEqual([
			{
				schemaVersion: 2,
				correlationId: expect.any(String),
				operation: 'noticeList',
				payload: LIST,
			},
			{ schemaVersion: 2, correlationId: expect.any(String), operation: 'inbox', payload: INBOX },
			{
				schemaVersion: 2,
				correlationId: expect.any(String),
				operation: 'telemetry',
				payload: EVENT,
			},
		]);
		expect(INBOX).toMatchObject({ idempotencyKey: 'idem-from-ledger' });
	});
});
