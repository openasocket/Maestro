/**
 * The local control selectors on protocol 2 (decision D2): `cancel_run`,
 * `report_status` and `refresh_policy`, all carried by the one `localControl`
 * operation (`src/main/enterprise/endpoint-ops.ts`). The contract has no
 * separate method per selector, so the client has no separate method either.
 *
 * What is defended: nothing is sent unless the attachment negotiated
 * `localControl`; `refresh_policy` is sent only by a fleet_management
 * registration, and a runtime_use registration is refused without sending;
 * a valid receipt is returned as parsed; a reply that is not a receipt for the
 * request is rejected as malformed.
 *
 * The port is an in-memory double, so nothing here is paired enforcement.
 */

import { describe, expect, it, vi } from 'vitest';

import {
	createEndpointOperationsClient,
	type EndpointOperationsOptions,
} from '../../../main/enterprise/endpoint-ops';
import {
	LOCAL_ENDPOINT_PROTOCOL,
	operationNegotiated,
	type EndpointConnectionState,
	type EndpointOperationClient,
	type EndpointPort,
	type EndpointStatus,
} from '../../../shared/maestro-lib/managed/endpoint-port';

const BASE = {
	commandId: 'command-1',
	targetId: 'desktop-100',
	expiresAt: '2099-01-01T00:00:00.000Z',
	policyRevision: 3,
	precondition: { processEpoch: 'epoch-1', expectedRunId: null },
};

const REPORT_STATUS = { ...BASE, action: { kind: 'report_status' } };
const CANCEL_RUN = {
	...BASE,
	precondition: { processEpoch: 'epoch-1', expectedRunId: 'run-1' },
	action: { kind: 'cancel_run', runId: 'run-1' },
};
const REFRESH_POLICY = { ...BASE, action: { kind: 'refresh_policy', desiredRevision: 4 } };

/** A receipt for `commandId`, the only shape `localControl` accepts as an answer. */
const receipt = { outcome: 'completed', commandId: BASE.commandId };

/** An in-memory port whose attachment negotiated `negotiated`, answering `answer`. */
function fakePort(negotiated: readonly string[] | null, answer: unknown = receipt) {
	const invoke = vi.fn(async () => ({ status: 'ok' as const, payload: answer }));
	const state = (): EndpointConnectionState => ({
		connection: 1,
		attached: negotiated !== null,
		status: null,
		registration: 'registered',
		closed: false,
		...(negotiated
			? {
					negotiated: {
						protocol: LOCAL_ENDPOINT_PROTOCOL,
						capabilities: [...negotiated],
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

const runtime: EndpointOperationsOptions = { registrationPurpose: () => 'runtime_use' };
const fleet: EndpointOperationsOptions = { registrationPurpose: () => 'fleet_management' };

describe('local control on protocol 2', () => {
	it.each([
		['report_status', REPORT_STATUS],
		['cancel_run', CANCEL_RUN],
	])('%s sends nothing when localControl was not negotiated', async (_name, request) => {
		const { port, invoke } = fakePort(['attachment', 'compatibility']);
		const outcome = await createEndpointOperationsClient(port, runtime).localControl(
			request as never
		);
		expect(outcome).toMatchObject({ status: 'unavailable', reason: 'not-negotiated' });
		expect(invoke).not.toHaveBeenCalled();
	});

	it('refresh_policy without fleet_management sends nothing and returns a refusal', async () => {
		const { port, invoke } = fakePort(['localControl']);
		const outcome = await createEndpointOperationsClient(port, runtime).localControl(
			REFRESH_POLICY as never
		);
		expect(outcome).toMatchObject({ status: 'unavailable', reason: 'not-authorized' });
		expect(invoke).not.toHaveBeenCalled();
	});

	it('refresh_policy with fleet_management is sent, and its receipt is returned', async () => {
		const { port, invoke } = fakePort(['localControl']);
		const outcome = await createEndpointOperationsClient(port, fleet).localControl(
			REFRESH_POLICY as never
		);
		expect(invoke).toHaveBeenCalledTimes(1);
		expect(outcome).toEqual({ status: 'ok', payload: receipt });
	});

	it('a valid receipt for the request is parsed and returned', async () => {
		const { port, invoke } = fakePort(['localControl']);
		const outcome = await createEndpointOperationsClient(port, runtime).localControl(
			REPORT_STATUS as never
		);
		expect(invoke).toHaveBeenCalledWith('localControl', REPORT_STATUS);
		expect(outcome).toEqual({ status: 'ok', payload: receipt });
	});

	it.each([
		['another command', { outcome: 'completed', commandId: 'command-2' }],
		['an extra field', { outcome: 'completed', commandId: BASE.commandId, runId: 'run-1' }],
		['an unknown outcome', { outcome: 'rebooted', commandId: BASE.commandId }],
		['no object at all', 'completed'],
	])('a reply with %s is rejected as malformed', async (_name, answer) => {
		const { port, invoke } = fakePort(['localControl'], answer);
		const outcome = await createEndpointOperationsClient(port, runtime).localControl(
			REPORT_STATUS as never
		);
		expect(invoke).toHaveBeenCalledTimes(1);
		expect(outcome).toMatchObject({ status: 'unavailable', reason: 'malformed' });
	});

	it('a denial from the endpoint passes through unchanged', async () => {
		const denial = { outcome: 'denied', reason: 'stale_precondition' };
		const { port } = fakePort(['localControl'], denial);
		const outcome = await createEndpointOperationsClient(port, runtime).localControl(
			REPORT_STATUS as never
		);
		expect(outcome).toEqual({ status: 'ok', payload: denial });
	});

	it('the operation name the gate checks is the one localControl sends', () => {
		const { port } = fakePort(['localControl']);
		const name: EndpointOperationClient = 'localControl';
		expect(port.negotiated(name)).toBe(true);
	});
});
