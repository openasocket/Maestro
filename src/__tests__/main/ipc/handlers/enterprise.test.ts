/**
 * Enterprise enrollment IPC.
 *
 * The channels are thin pass-throughs to the lifecycle, the policy status
 * service and the identity store, so what these tests defend is the wiring
 * and the gate in front of it: every channel is registered, a request is
 * validated before the lifecycle sees it, a desktop with no service answers
 * `unavailable` rather than throwing, a service refusal reaches the renderer
 * as an outcome, and a store rejection reaches it as an error.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcMain } from 'electron';

const registeredHandlers = new Map<string, (...args: any[]) => any>();

vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn((channel: string, handler: (...args: any[]) => any) => {
			registeredHandlers.set(channel, handler);
		}),
	},
}));

vi.mock('../../../../main/utils/logger', () => ({
	logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
	registerEnterpriseHandlers,
	validateEnrollmentRequest,
} from '../../../../main/ipc/handlers/enterprise';

const lifecycle = {
	status: vi.fn(),
	requestEnrollment: vi.fn(),
	connect: vi.fn(),
	beginRegistration: vi.fn(),
	completeRegistration: vi.fn(),
	requestRotation: vi.fn(),
	requestRevocation: vi.fn(),
	requestRetirement: vi.fn(),
	acknowledgeRevocation: vi.fn(),
	retire: vi.fn(),
	close: vi.fn(),
};
const policyStatus = { status: vi.fn(), refresh: vi.fn(), recover: vi.fn() };
const identity = { custody: vi.fn(), clear: vi.fn() };
const inventory = { snapshot: vi.fn(), fact: vi.fn(), record: vi.fn() };

const ENROLL = {
	socketPath: '/run/endpoint/runtime.sock',
	tenantId: 'tenant-1',
	orgId: 'org-1',
	mode: 'attended',
	invitation: 'invite',
	collectionProfile: 'metadata',
	trustRootDigest: 'a'.repeat(64),
	keyPossessionProof: 'proof',
};

function invoke(channel: string, ...args: unknown[]): Promise<any> {
	const handler = registeredHandlers.get(channel);
	if (!handler) throw new Error(`channel not registered: ${channel}`);
	return handler({}, ...args);
}

describe('enterprise handlers', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		registeredHandlers.clear();
		registerEnterpriseHandlers({
			getLifecycle: () => lifecycle as any,
			getPolicyStatus: () => policyStatus as any,
			getIdentity: () => identity as any,
			getInventory: () => inventory as any,
		});
	});

	it('registers exactly the enterprise channels', () => {
		expect([...registeredHandlers.keys()].sort()).toEqual([
			'enterprise:acknowledgeRevocation',
			'enterprise:beginRegistration',
			'enterprise:clearIdentity',
			'enterprise:completeRegistration',
			'enterprise:connect',
			'enterprise:custody',
			'enterprise:inventory',
			'enterprise:policyStatus',
			'enterprise:recoverPolicy',
			'enterprise:refreshPolicy',
			'enterprise:requestEnrollment',
			'enterprise:requestRetirement',
			'enterprise:requestRevocation',
			'enterprise:requestRotation',
			'enterprise:retire',
			'enterprise:status',
		]);
	});

	it('hands reads and lifecycle verbs through unchanged', async () => {
		lifecycle.status.mockReturnValue({ authority: 'none' });
		policyStatus.status.mockReturnValue({ freshness: 'unknown' });
		identity.custody.mockReturnValue({ state: 'protected' });
		inventory.snapshot.mockReturnValue({ completeness: 'partial' });
		expect(await invoke('enterprise:status')).toEqual({ authority: 'none' });
		expect(await invoke('enterprise:policyStatus')).toEqual({ freshness: 'unknown' });
		expect(await invoke('enterprise:custody')).toEqual({ state: 'protected' });
		// The inventory read is the snapshot and nothing more: no record, no projection from a read.
		expect(await invoke('enterprise:inventory')).toEqual({ completeness: 'partial' });
		expect(inventory.record).not.toHaveBeenCalled();

		lifecycle.connect.mockResolvedValue({ status: 'ok', value: { management: 'managed' } });
		expect(await invoke('enterprise:connect')).toEqual({
			status: 'ok',
			value: { management: 'managed' },
		});
		lifecycle.beginRegistration.mockResolvedValue({ status: 'ok', value: { nonce: 'n' } });
		expect(await invoke('enterprise:beginRegistration')).toEqual({
			status: 'ok',
			value: { nonce: 'n' },
		});
		lifecycle.requestRotation.mockResolvedValue({ status: 'unsupported', owner: 'mega-maestro' });
		expect(await invoke('enterprise:requestRotation')).toMatchObject({ status: 'unsupported' });
		policyStatus.recover.mockResolvedValue({ status: 'not-needed' });
		expect(await invoke('enterprise:recoverPolicy')).toEqual({ status: 'not-needed' });

		lifecycle.retire.mockResolvedValue({ status: 'ok', value: 'retired' });
		expect(await invoke('enterprise:retire', { installationId: 'inst-1' })).toEqual({
			status: 'ok',
			value: 'retired',
		});
		expect(lifecycle.retire).toHaveBeenCalledWith({ installationId: 'inst-1' });
	});

	it('validates the enrollment request before the lifecycle sees it', async () => {
		lifecycle.requestEnrollment.mockResolvedValue({ status: 'ok', value: { enrollmentId: 'e' } });
		expect(await invoke('enterprise:requestEnrollment', ENROLL)).toMatchObject({ status: 'ok' });
		expect(lifecycle.requestEnrollment).toHaveBeenCalledWith(ENROLL);

		for (const bad of [
			{ ...ENROLL, socketPath: 'http://127.0.0.1:9000' },
			{ ...ENROLL, socketPath: 'relative.sock' },
			{ ...ENROLL, mode: 'forced' },
			{ ...ENROLL, collectionProfile: 'everything' },
			{ ...ENROLL, trustRootDigest: 'A'.repeat(64) },
			{ ...ENROLL, invitation: '' },
			{ ...ENROLL, keyPossessionProof: 'x'.repeat(9000) },
			{ ...ENROLL, tenantId: undefined },
			null,
		]) {
			await expect(invoke('enterprise:requestEnrollment', bad)).rejects.toThrow();
		}
		expect(lifecycle.requestEnrollment).toHaveBeenCalledTimes(1);
		expect(() => validateEnrollmentRequest({ ...ENROLL, extra: 'ignored' })).not.toThrow();
	});

	it('answers unavailable, not a throw, when no service runs in this desktop', async () => {
		registeredHandlers.clear();
		registerEnterpriseHandlers({
			getLifecycle: () => null,
			getPolicyStatus: () => null,
			getIdentity: () => null,
			getInventory: () => null,
		});
		expect(await invoke('enterprise:status')).toBeNull();
		expect(await invoke('enterprise:custody')).toBeNull();
		expect(await invoke('enterprise:inventory')).toBeNull();
		expect(await invoke('enterprise:connect')).toMatchObject({ status: 'unavailable' });
		expect(await invoke('enterprise:requestEnrollment', ENROLL)).toMatchObject({
			status: 'unavailable',
		});
		expect(await invoke('enterprise:clearIdentity', { installationId: 'inst-1' })).toMatchObject({
			ok: false,
		});
	});

	it('closes the socket before an explicit identity clear, and lets a store rejection reach the renderer', async () => {
		identity.clear.mockResolvedValue({ ok: true, removed: true });
		expect(
			await invoke('enterprise:clearIdentity', {
				installationId: 'inst-1',
				acknowledgeUntrusted: true,
			})
		).toEqual({
			ok: true,
			removed: true,
		});
		expect(lifecycle.close).toHaveBeenCalledTimes(1);
		expect(identity.clear).toHaveBeenCalledWith({
			installationId: 'inst-1',
			acknowledgeUntrusted: true,
		});
		expect(lifecycle.close.mock.invocationCallOrder[0]).toBeLessThan(
			identity.clear.mock.invocationCallOrder[0]
		);

		await expect(invoke('enterprise:clearIdentity', {})).rejects.toThrow(/installationId/);
		identity.clear.mockRejectedValue(new Error('disk is read-only'));
		await expect(invoke('enterprise:clearIdentity', { installationId: 'inst-1' })).rejects.toThrow(
			'disk is read-only'
		);
	});
});
