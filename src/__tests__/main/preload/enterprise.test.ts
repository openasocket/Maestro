/**
 * Enterprise preload API.
 *
 * A status pane can only be as correct as this mapping: a verb pointed at
 * the wrong channel, or one that drops its argument, resolves to nothing and
 * the pane shows a standing the desktop never had.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockInvoke = vi.fn();

vi.mock('electron', () => ({
	ipcRenderer: {
		invoke: (...args: unknown[]) => mockInvoke(...args),
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
			'completeRegistration',
			'connect',
			'custody',
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
		await api.connect();
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
			socketPath: '/run/endpoint/runtime.sock',
			tenantId: 't',
			orgId: 'o',
			mode: 'attended' as const,
			invitation: 'i',
			collectionProfile: 'metadata' as const,
			trustRootDigest: 'a'.repeat(64),
			keyPossessionProof: 'p',
		};
		await api.requestEnrollment(enroll);
		await api.acknowledgeRevocation({ installationId: 'inst-1' });
		await api.retire({ installationId: 'inst-1' });
		await api.clearIdentity({ installationId: 'inst-1', acknowledgeUntrusted: true });
		expect(mockInvoke.mock.calls).toEqual([
			['enterprise:requestEnrollment', enroll],
			['enterprise:acknowledgeRevocation', { installationId: 'inst-1' }],
			['enterprise:retire', { installationId: 'inst-1' }],
			['enterprise:clearIdentity', { installationId: 'inst-1', acknowledgeUntrusted: true }],
		]);
	});

	it('resolves with what the channel answered', async () => {
		mockInvoke.mockResolvedValue({ authority: 'registered' });
		expect(await api.status()).toEqual({ authority: 'registered' });
	});
});
