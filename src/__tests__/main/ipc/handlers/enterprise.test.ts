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
const commands = { status: vi.fn(), receive: vi.fn() };

/** The lifecycle's status for a desktop with no record: every local verb is open. */
const UNENROLLED = {
	identity: { status: 'none', reason: null, message: null, record: null },
	connection: null,
	endpoint: null,
	authority: 'none',
	reason: 'This installation holds no enrollment.',
	pendingApproval: null,
	lastDenial: null,
};
/** An enrolled record with no connection: the endpoint still manages it, and it is offline. */
const ENROLLED_OFFLINE = {
	...UNENROLLED,
	identity: {
		status: 'ok',
		reason: null,
		message: null,
		record: {
			version: 1,
			installationId: 'inst-1',
			tenantId: 'tenant-1',
			orgId: 'org-1',
			enrollmentId: 'enr-1',
			endpoint: {
				socketPath: '/run/endpoint.sock',
				bindingDigest: 'b'.repeat(64),
				trustRootDigest: null,
			},
			management: 'enrolled',
			registration: null,
			policy: { desiredRevision: 3, appliedRevision: 3, observedAt: '2026-10-22T10:00:00.000Z' },
			enrolledAt: '2026-10-20T10:00:00.000Z',
			updatedAt: '2026-10-22T10:00:00.000Z',
		},
	},
	reason: 'No endpoint connection is open.',
};
const POLICY = {
	desiredRevision: 3,
	appliedRevision: 3,
	installedRevision: 3,
	source: 'cached',
	freshness: 'stale',
	observedAt: '2026-10-22T10:00:00.000Z',
	connectivity: 'detached',
	management: null,
	capabilities: [],
	converged: true,
	offline: { installedPolicyAvailable: true, mode: 'installed-policy-only' },
	approval: { state: 'none', expiresAt: null },
	registration: { state: 'none', expiresAt: null },
	admission: { possible: false, reasons: ['No endpoint connection is open.'] },
};

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
		lifecycle.status.mockReturnValue(UNENROLLED);
		policyStatus.status.mockReturnValue(POLICY);
		identity.custody.mockReturnValue({ state: 'protected' });
		registerEnterpriseHandlers({
			getLifecycle: () => lifecycle as any,
			getPolicyStatus: () => policyStatus as any,
			getIdentity: () => identity as any,
			getInventory: () => inventory as any,
			getInbox: () => null,
			getCommands: () => commands as any,
		});
	});

	it('registers exactly the enterprise channels', () => {
		expect([...registeredHandlers.keys()].sort()).toEqual([
			'enterprise:acknowledgeRevocation',
			'enterprise:beginRegistration',
			'enterprise:clearIdentity',
			'enterprise:commandStatus',
			'enterprise:completeRegistration',
			'enterprise:connect',
			'enterprise:custody',
			'enterprise:inboxAct',
			'enterprise:inboxRefresh',
			'enterprise:inboxState',
			'enterprise:inventory',
			'enterprise:managedState',
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
		inventory.snapshot.mockReturnValue({ completeness: 'partial' });
		expect(await invoke('enterprise:status')).toEqual(UNENROLLED);
		expect(await invoke('enterprise:policyStatus')).toEqual(POLICY);
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

	it('reads the command service status through unchanged and never hands it a command (MRC-11-05)', async () => {
		const status = {
			file: null,
			loaded: true,
			load: { ok: true, commands: 0, recoveredUnknown: 0 },
			capabilities: ['command-cancel_run'],
			unsupported: [],
			commands: { total: 0, open: 0, byState: {} },
			standing: { ok: false, reason: 'This process holds no registered standing.' },
		};
		commands.status.mockReturnValue(status);
		expect(await invoke('enterprise:commandStatus')).toEqual(status);
		expect(registeredHandlers.has('enterprise:commandReceive')).toBe(false);
		expect(commands.receive).not.toHaveBeenCalled();
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

	// MRC-11-03: the narrow standing a settings pane reads, projected from the
	// three live reads; no path, digest or secret of the record is in it.
	it('projects the managed state from the live status, policy and custody', async () => {
		lifecycle.status.mockReturnValue(ENROLLED_OFFLINE);
		const view = await invoke('enterprise:managedState');
		expect(view).toMatchObject({
			standing: 'offline',
			enrollment: { tenantId: 'tenant-1', orgId: 'org-1', management: 'enrolled' },
			endpoint: { attached: false, connectivity: 'detached' },
			policy: { appliedRevision: 3, freshness: 'stale' },
			capabilities: { negotiated: [] },
			egress: { held: [] },
			update: { held: null },
			listeners: { held: [] },
			localRelease: { allowed: false, reason: 'required' },
		});
		expect(view.capabilities.supported).toContain('execution');
		expect(view.capabilities.missing).toEqual(view.capabilities.supported);
		const text = JSON.stringify(view);
		expect(text).not.toContain('/run/endpoint.sock');
		expect(text).not.toContain('b'.repeat(64));
		expect(await invoke('enterprise:managedState')).toMatchObject({ standing: 'offline' });
	});

	// Required management is not a local setting: while the endpoint still
	// manages the record, the local transitions and the clear are refused by
	// name before the lifecycle or the store see them; a final record passes.
	it('refuses to retire, revoke or forget a record the endpoint still manages', async () => {
		lifecycle.status.mockReturnValue(ENROLLED_OFFLINE);
		for (const verb of ['enterprise:retire', 'enterprise:acknowledgeRevocation'] as const) {
			expect(await invoke(verb, { installationId: 'inst-1' })).toMatchObject({
				status: 'refused',
				reason: 'management-required',
				message: expect.stringContaining('org-1 (tenant-1)'),
			});
		}
		expect(await invoke('enterprise:clearIdentity', { installationId: 'inst-1' })).toMatchObject({
			ok: false,
			reason: 'management-required',
		});
		expect(lifecycle.retire).not.toHaveBeenCalled();
		expect(lifecycle.acknowledgeRevocation).not.toHaveBeenCalled();
		expect(lifecycle.close).not.toHaveBeenCalled();
		expect(identity.clear).not.toHaveBeenCalled();
		// The argument is still validated first.
		await expect(invoke('enterprise:retire', {})).rejects.toThrow(/installationId/);

		const record = ENROLLED_OFFLINE.identity.record;
		lifecycle.status.mockReturnValue({
			...ENROLLED_OFFLINE,
			identity: { ...ENROLLED_OFFLINE.identity, record: { ...record, management: 'revoked' } },
		});
		lifecycle.retire.mockResolvedValue({ status: 'ok', value: 'retired' });
		expect(await invoke('enterprise:retire', { installationId: 'inst-1' })).toEqual({
			status: 'ok',
			value: 'retired',
		});
		identity.clear.mockResolvedValue({ ok: true, removed: true });
		expect(await invoke('enterprise:clearIdentity', { installationId: 'inst-1' })).toEqual({
			ok: true,
			removed: true,
		});
	});

	it('answers unavailable, not a throw, when no service runs in this desktop', async () => {
		registeredHandlers.clear();
		registerEnterpriseHandlers({
			getLifecycle: () => null,
			getPolicyStatus: () => null,
			getIdentity: () => null,
			getInventory: () => null,
			getInbox: () => null,
			getCommands: () => null,
		});
		expect(await invoke('enterprise:status')).toBeNull();
		expect(await invoke('enterprise:custody')).toBeNull();
		expect(await invoke('enterprise:inventory')).toBeNull();
		expect(await invoke('enterprise:managedState')).toBeNull();
		expect(await invoke('enterprise:commandStatus')).toBeNull();
		expect(await invoke('enterprise:inboxState')).toBeNull();
		expect(await invoke('enterprise:inboxRefresh')).toBeNull();
		expect(
			await invoke('enterprise:inboxAct', {
				campaignId: 'c',
				messageId: 'm',
				action: { kind: 'read' },
			})
		).toMatchObject({ status: 'unavailable' });
		expect(await invoke('enterprise:retire', { installationId: 'inst-1' })).toMatchObject({
			status: 'unavailable',
		});
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
