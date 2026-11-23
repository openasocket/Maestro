/**
 * Enterprise preload API.
 *
 * A status pane can only be as correct as this mapping: a verb pointed at
 * the wrong channel, or one that drops its argument, resolves to nothing and
 * the pane shows a standing the desktop never had.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockInvoke = vi.fn();
const mockOn = vi.fn();
const mockRemoveListener = vi.fn();

vi.mock('electron', () => ({
	ipcRenderer: {
		invoke: (...args: unknown[]) => mockInvoke(...args),
		on: (...args: unknown[]) => mockOn(...args),
		removeListener: (...args: unknown[]) => mockRemoveListener(...args),
	},
}));

import { createEnterpriseApi } from '../../../main/preload/enterprise';

describe('Enterprise Preload API', () => {
	let api: ReturnType<typeof createEnterpriseApi>;

	beforeEach(() => {
		vi.clearAllMocks();
		mockInvoke.mockResolvedValue(undefined);
		api = createEnterpriseApi();
	});

	it('exposes exactly the enrollment verbs', () => {
		expect(Object.keys(api).sort()).toEqual([
			'acknowledgeRevocation',
			'beginRegistration',
			'clearIdentity',
			'commandStatus',
			'completeRegistration',
			'connect',
			'connectEndpoint',
			'custody',
			'inboxAct',
			'inboxRefresh',
			'inboxState',
			'inventory',
			'managedRun',
			'managedState',
			'megaServerGet',
			'megaServerLookup',
			'megaServerSave',
			'policyStatus',
			'recoverPolicy',
			'refreshPolicy',
			'requestEnrollment',
			'requestRetirement',
			'requestRevocation',
			'requestRotation',
			'retire',
			'status',
		]);
	});

	it('maps every verb to its channel with its argument', async () => {
		await api.status();
		await api.custody();
		await api.policyStatus();
		await api.inventory();
		await api.managedState();
		await api.inboxState();
		await api.inboxRefresh();
		await api.commandStatus();
		await api.managedRun('lease-1');
		await api.connectEndpoint();
		await api.beginRegistration();
		await api.completeRegistration();
		await api.refreshPolicy();
		await api.recoverPolicy();
		await api.requestRotation();
		await api.requestRevocation();
		await api.requestRetirement();
		expect(mockInvoke.mock.calls.map((c) => c[0])).toEqual([
			'enterprise:status',
			'enterprise:custody',
			'enterprise:policyStatus',
			'enterprise:inventory',
			'enterprise:managedState',
			'enterprise:inboxState',
			'enterprise:inboxRefresh',
			'enterprise:commandStatus',
			'enterprise:managedRun',
			'enterprise:connect',
			'enterprise:beginRegistration',
			'enterprise:completeRegistration',
			'enterprise:refreshPolicy',
			'enterprise:recoverPolicy',
			'enterprise:requestRotation',
			'enterprise:requestRevocation',
			'enterprise:requestRetirement',
		]);
		mockInvoke.mockClear();

		const enroll = {
			phase: 'request' as const,
			socketPath: '/run/endpoint/runtime.sock',
			management: { origin: 'https://mega.example', tenantId: 't', issuerSha256: 'a'.repeat(64) },
			orgId: 'o',
			serverCaPem: 'pem',
		};
		await api.requestEnrollment(enroll);
		await api.acknowledgeRevocation({ installationId: 'inst-1' });
		await api.retire({ installationId: 'inst-1' });
		await api.clearIdentity({ installationId: 'inst-1', acknowledgeUntrusted: true });
		await api.inboxAct({ campaignId: 'c', messageId: 'm', action: { kind: 'read' } });
		expect(mockInvoke.mock.calls).toEqual([
			['enterprise:requestEnrollment', enroll],
			['enterprise:acknowledgeRevocation', { installationId: 'inst-1' }],
			['enterprise:retire', { installationId: 'inst-1' }],
			['enterprise:clearIdentity', { installationId: 'inst-1', acknowledgeUntrusted: true }],
			['enterprise:inboxAct', { campaignId: 'c', messageId: 'm', action: { kind: 'read' } }],
		]);
	});

	it('exposes connect to your organization as start, status, disconnect, diagnostics, onStatus and onPrefill', async () => {
		expect(Object.keys(api.connect).sort()).toEqual([
			'diagnostics',
			'disconnect',
			'onPrefill',
			'onStatus',
			'start',
			'status',
		]);
		await api.connect.start({ kind: 'email', email: 'alice@acme.com' });
		await api.connect.status();
		await api.connect.disconnect();
		await api.connect.diagnostics();
		expect(mockInvoke.mock.calls).toEqual([
			['enterprise:connectStart', { kind: 'email', email: 'alice@acme.com' }],
			['enterprise:connectStatus'],
			['enterprise:connectDisconnect'],
			['enterprise:connectDiagnostics'],
		]);

		const heard = vi.fn();
		const unsubscribe = api.connect.onStatus(heard);
		expect(mockOn).toHaveBeenCalledWith('enterprise:connectStatus', expect.any(Function));
		const handler = mockOn.mock.calls[0][1] as (event: unknown, view: unknown) => void;
		handler({}, { status: { kind: 'waiting' } });
		expect(heard).toHaveBeenCalledWith({ status: { kind: 'waiting' } });
		unsubscribe();
		expect(mockRemoveListener).toHaveBeenCalledWith('enterprise:connectStatus', handler);
	});

	it('hears a connect deep link prefill on megaConnect:prefill and unsubscribes', () => {
		const heard = vi.fn();
		const unsubscribe = api.connect.onPrefill(heard);
		expect(mockOn).toHaveBeenCalledWith('megaConnect:prefill', expect.any(Function));
		const handler = mockOn.mock.calls[0][1] as (event: unknown, prefill: unknown) => void;
		const prefill = { kind: 'connect', server: 'mega.acme.com', teamCode: 'ACME-WEB-7K3M' };
		handler({}, prefill);
		expect(heard).toHaveBeenCalledWith(prefill);
		unsubscribe();
		expect(mockRemoveListener).toHaveBeenCalledWith('megaConnect:prefill', handler);
	});

	it('resolves with what the channel answered', async () => {
		mockInvoke.mockResolvedValue({ authority: 'registered' });
		expect(await api.status()).toEqual({ authority: 'registered' });
	});
});
