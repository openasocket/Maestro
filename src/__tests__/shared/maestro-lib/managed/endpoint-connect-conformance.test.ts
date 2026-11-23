/**
 * The Connect parsers in endpoint-port.ts are transcribed (product code never
 * loads the vendored contracts). Contracts 0.5.1 is the first archive that
 * publishes the operation schemas (`endpointConnectAnswer`,
 * `endpointDisconnectAnswer`, `endpointConnectInput`) beside `connectionStatus`,
 * so this suite holds every transcription equal to the pinned schema: an answer
 * Maestro accepts is exactly one the contract accepts.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
	endpointConnectReplyProblems,
	endpointConnectRequestProblems,
} from '../../../../shared/maestro-lib/managed/endpoint-port';

let connect: typeof import('../../../../../vendor/mega-maestro/contracts/dist/connect.js');
let protocol: typeof import('../../../../../vendor/mega-maestro/contracts/dist/protocol.js');
beforeAll(async () => {
	connect = await import('../../../../../vendor/mega-maestro/contracts/dist/connect.js');
	protocol = await import('../../../../../vendor/mega-maestro/contracts/dist/protocol.js');
});

const waiting = {
	outcome: 'waiting',
	requestNumber: 'REQ-1042',
	approvalUrl: 'https://mega.acme.com/consent/REQ-1042',
	number: '47',
	server: 'mega.acme.com',
	tenantDisplayName: 'Acme',
};
const status = {
	state: 'connected',
	stateSeq: 3,
	stateChangedAt: '2026-11-22T10:00:00.000Z',
	names: {
		tenant: { handle: 'acme', displayName: 'Acme Corp' },
		teamPath: 'platform/web',
		policy: { name: 'platform-default', revision: 12 },
		device: 'alices-mbp',
	},
};

const ANSWERS: Array<[string, unknown]> = [
	['waiting', waiting],
	[
		'waiting on a port',
		{ ...waiting, server: 'mega.acme.com:8443', approvalUrl: 'https://mega.acme.com:8443/c' },
	],
	['refused', { outcome: 'refused', code: 'endpoint_connect_unavailable' }],
	['refused with an uppercase code', { outcome: 'refused', code: 'Bad' }],
	['refused with detail', { outcome: 'refused', code: 'denied', detail: 'x' }],
	['consent page off the server', { ...waiting, approvalUrl: 'https://evil.example/c' }],
	['consent page over http', { ...waiting, approvalUrl: 'http://mega.acme.com/c' }],
	['request number zero', { ...waiting, requestNumber: 'REQ-0' }],
	['three digit number', { ...waiting, number: '470' }],
	['padded tenant name', { ...waiting, tenantDisplayName: ' Acme' }],
	['tenant name with a control', { ...waiting, tenantDisplayName: 'Ac\u0007me' }],
	['tenant name too long', { ...waiting, tenantDisplayName: 'a'.repeat(129) }],
	['extra field', { ...waiting, grantId: 'g' }],
	['unknown outcome', { outcome: 'connected' }],
	['not an object', 'waiting'],
];

const STATUSES: Array<[string, unknown]> = [
	['connected with names', status],
	[
		'not connected, no names',
		{ state: 'not_connected', stateSeq: 0, stateChangedAt: status.stateChangedAt, names: {} },
	],
	['waiting with a request', { ...status, state: 'waiting', request: { number: 'REQ-7' } }],
	[
		'denied with a reason',
		{
			...status,
			state: 'denied',
			request: {
				number: 'REQ-7',
				decidedAt: status.stateChangedAt,
				decisionReason: 'Not this team',
			},
		},
	],
	[
		'grant expired with a refusal',
		{ ...status, state: 'grant_expired', lastRefusalCode: 'grant_expired' },
	],
	['unknown state', { ...status, state: 'suspended' }],
	['negative sequence', { ...status, stateSeq: -1 }],
	['stateChangedAt 2026-11-22T10:00:00Z', { ...status, stateChangedAt: '2026-11-22T10:00:00Z' }],
	['stateChangedAt 2026-11-22T10:00Z', { ...status, stateChangedAt: '2026-11-22T10:00Z' }],
	[
		'stateChangedAt 2026-11-22T10:00:00.123456789Z',
		{ ...status, stateChangedAt: '2026-11-22T10:00:00.123456789Z' },
	],
	[
		'stateChangedAt 2026-11-22T10:00:00+05:30',
		{ ...status, stateChangedAt: '2026-11-22T10:00:00+05:30' },
	],
	[
		'stateChangedAt 2026-11-22T10:00:00+0530',
		{ ...status, stateChangedAt: '2026-11-22T10:00:00+0530' },
	],
	['stateChangedAt 2026-02-30T00:00:00Z', { ...status, stateChangedAt: '2026-02-30T00:00:00Z' }],
	['stateChangedAt 2024-02-29T00:00:00Z', { ...status, stateChangedAt: '2024-02-29T00:00:00Z' }],
	['stateChangedAt 2025-02-29T00:00:00Z', { ...status, stateChangedAt: '2025-02-29T00:00:00Z' }],
	['stateChangedAt 2026-13-01T00:00:00Z', { ...status, stateChangedAt: '2026-13-01T00:00:00Z' }],
	['stateChangedAt 2026-11-22T24:00:00Z', { ...status, stateChangedAt: '2026-11-22T24:00:00Z' }],
	['stateChangedAt 2026-11-22t10:00:00z', { ...status, stateChangedAt: '2026-11-22t10:00:00z' }],
	['stateChangedAt 2026-11-22T10:00:00', { ...status, stateChangedAt: '2026-11-22T10:00:00' }],
	[
		'decidedAt with an offset',
		{ ...status, request: { number: 'REQ-7', decidedAt: '2026-11-22T10:00:00-08:00' } },
	],
	[
		'ID-shaped tenant name',
		{
			...status,
			names: { tenant: { handle: 'acme', displayName: '0123456789abcdef0123456789abcdef' } },
		},
	],
	['policy revision zero', { ...status, names: { policy: { name: 'p', revision: 0 } } }],
	['extra name', { ...status, names: { ...status.names, tenantId: 't' } }],
	['extra field', { ...status, grantId: 'g' }],
	['no names', { state: 'connected', stateSeq: 1, stateChangedAt: status.stateChangedAt }],
];

const DISCONNECTS: Array<[string, unknown]> = [
	['disconnected', { outcome: 'disconnected' }],
	['extra field', { outcome: 'disconnected', at: 'now' }],
	['wrong outcome', { outcome: 'retired' }],
];

describe('Connect answers agree with contracts 0.5.1', () => {
	it.each(ANSWERS)('connect: %s', (_, value) => {
		expect(endpointConnectReplyProblems('connect', value).length === 0).toBe(
			connect.endpointConnectAnswer.safeParse(value).success
		);
	});

	it.each(STATUSES)('connection_status: %s', (_, value) => {
		expect(endpointConnectReplyProblems('connection_status', value).length === 0).toBe(
			connect.connectionStatus.safeParse(value).success
		);
	});

	it.each(DISCONNECTS)('disconnect: %s', (_, value) => {
		expect(endpointConnectReplyProblems('disconnect', value).length === 0).toBe(
			connect.endpointDisconnectAnswer.safeParse(value).success
		);
	});

	it('the protocol map serves the three operations with these answer schemas', () => {
		const ops = protocol.localEndpointContractsV2;
		for (const op of ['connect', 'connection_status', 'disconnect']) expect(ops).toHaveProperty(op);
	});
});

describe('Connect requests the contract accepts are ones Maestro sends', () => {
	const REQUESTS: unknown[] = [
		{ email: 'alice@acme.com' },
		{ joinLink: `https://mega.acme.com/join/0123456789ABCDEFGHJKMNPQRS#pin=${'ab'.repeat(32)}` },
		{ teamCode: 'ACME-WEB-7K3M0', server: 'mega.acme.com' },
		{ managed: true },
	];
	it.each(REQUESTS)('%j', (value) => {
		expect(connect.endpointConnectInput.safeParse(value).success).toBe(true);
		expect(endpointConnectRequestProblems('connect', value)).toEqual([]);
	});

	it('never sends what the contract refuses by shape', () => {
		for (const value of [
			{},
			{ email: 'a@b', managed: true },
			{ managed: false },
			{ teamCode: 'X' },
		]) {
			expect(connect.endpointConnectInput.safeParse(value).success).toBe(false);
			expect(endpointConnectRequestProblems('connect', value)).not.toEqual([]);
		}
	});
});
