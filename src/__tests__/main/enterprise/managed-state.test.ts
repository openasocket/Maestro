/**
 * The managed-state projection (MRC-11-03): one word for the standing, the
 * facts a pane reads beside it, and the local-release rule that keeps a record
 * the endpoint still manages from being left locally.
 */

import { describe, expect, it } from 'vitest';

import type {
	EndpointStatus,
	ManagedEnrollmentStatus,
	ManagedIdentityRecord,
} from '../../../shared/maestro-lib/managed/endpoint-port';
import {
	POLICY_FRESHNESS_MS,
	projectPolicyStatus,
} from '../../../shared/maestro-lib/managed/host-adapter';
import {
	localReleaseOf,
	managedStandingOf,
	projectManagedState,
} from '../../../main/enterprise/managed-state';

const NOW = Date.parse('2026-10-23T12:00:00Z');
const OBSERVED = new Date(NOW - 60_000).toISOString();
const SUPPORTED = ['attachment', 'compatibility', 'execution', 'telemetry'];

function record(over: Partial<ManagedIdentityRecord> = {}): ManagedIdentityRecord {
	return {
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
		policy: { desiredRevision: 3, appliedRevision: 3, observedAt: OBSERVED },
		enrolledAt: '2026-10-20T10:00:00.000Z',
		updatedAt: OBSERVED,
		...over,
	};
}

function endpoint(over: Partial<EndpointStatus> = {}): EndpointStatus {
	return {
		outcome: 'attached',
		protocol: 1,
		capabilities: ['attachment', 'execution'],
		management: 'managed',
		desiredPolicyRevision: 3,
		appliedPolicyRevision: 3,
		connectivity: 'online',
		collectionProfile: 'metadata',
		...over,
	};
}

function status(
	over: Partial<ManagedEnrollmentStatus> & { record?: ManagedIdentityRecord | null } = {}
): ManagedEnrollmentStatus {
	const { record: rec = record(), ...rest } = over;
	return {
		identity: rec
			? { status: 'ok', reason: null, message: null, record: rec }
			: { status: 'none', reason: null, message: null, record: null },
		connection: null,
		endpoint: null,
		authority: 'none',
		reason: 'No endpoint connection is open.',
		pendingApproval: null,
		lastDenial: null,
		...rest,
	};
}

const attached = (over: Partial<EndpointStatus> = {}) => ({
	connection: {
		connection: 1,
		attached: true,
		status: endpoint(over),
		registration: 'none' as const,
		closed: false,
	},
	endpoint: endpoint(over),
});

const registered = (over: Partial<ManagedEnrollmentStatus> = {}) =>
	status({
		...attached(),
		connection: { ...attached().connection, registration: 'registered' },
		authority: 'registered',
		reason: null,
		...over,
	});

function policyOf(s: ManagedEnrollmentStatus, now = NOW) {
	return projectPolicyStatus({ standing: s, now });
}

describe('managedStandingOf', () => {
	it('names every standing from the record, the connection and the policy freshness', () => {
		const fresh = registered();
		expect(managedStandingOf(fresh, policyOf(fresh))).toBe('managed');
		expect(managedStandingOf(fresh, policyOf(fresh, NOW + POLICY_FRESHNESS_MS + 1))).toBe('stale');

		expect(managedStandingOf(status({ record: null }), { freshness: 'unknown' })).toBe(
			'unenrolled'
		);
		expect(
			managedStandingOf(
				{
					...status(),
					identity: { status: 'untrusted', reason: 'rollback', message: 'x', record: null },
				},
				{ freshness: 'unknown' }
			)
		).toBe('custody-refused');
		for (const management of ['enrolling', 'suspended', 'revoked', 'retired'] as const) {
			expect(
				managedStandingOf(status({ record: record({ management }) }), { freshness: 'fresh' })
			).toBe(management);
		}
		expect(managedStandingOf(status(), { freshness: 'fresh' })).toBe('offline');
		expect(managedStandingOf(status(attached()), { freshness: 'fresh' })).toBe('unregistered');
		expect(
			managedStandingOf(status(attached({ management: 'suspended' })), { freshness: 'fresh' })
		).toBe('suspended');
	});

	it('reads a denial as the standing only when it is newer than the last accepted attachment', () => {
		const after = {
			at: new Date(NOW - 1_000).toISOString(),
			operation: 'attachment',
			reason: 'unauthenticated' as const,
		};
		expect(managedStandingOf(status({ lastDenial: after }), { freshness: 'fresh' })).toBe('denied');
		const before = { ...after, at: new Date(NOW - 120_000).toISOString() };
		expect(managedStandingOf(status({ lastDenial: before }), { freshness: 'fresh' })).toBe(
			'offline'
		);
		// A registered standing outranks any denial on record.
		expect(managedStandingOf(registered({ lastDenial: after }), { freshness: 'fresh' })).toBe(
			'managed'
		);
	});
});

describe('localReleaseOf', () => {
	it('refuses to leave a record the endpoint still manages, offline or attached', () => {
		for (const management of ['enrolling', 'enrolled', 'suspended'] as const) {
			const release = localReleaseOf(status({ record: record({ management }) }));
			expect(release).toMatchObject({ allowed: false, reason: 'required' });
			if (!release.allowed) expect(release.message).toContain('org-1 (tenant-1)');
		}
		expect(localReleaseOf(registered())).toMatchObject({ allowed: false });
		expect(localReleaseOf(status(attached({ management: 'suspended' })))).toMatchObject({
			allowed: false,
		});
	});

	it('opens when the endpoint reports the installation unenrolled, or the record is final', () => {
		expect(localReleaseOf(status(attached({ management: 'unenrolled' })))).toEqual({
			allowed: true,
			reason: 'released',
		});
		// The same answer on a closed or detached connection is not a release.
		const closed = attached({ management: 'unenrolled' });
		expect(
			localReleaseOf(status({ ...closed, connection: { ...closed.connection, attached: false } }))
		).toMatchObject({ allowed: false });
		expect(localReleaseOf(status({ record: record({ management: 'revoked' }) }))).toEqual({
			allowed: true,
			reason: 'final',
		});
		expect(localReleaseOf(status({ record: null }))).toEqual({
			allowed: true,
			reason: 'no-record',
		});
	});
});

describe('projectManagedState', () => {
	it('carries the facts a pane shows and nothing the sealed record keeps private', () => {
		const s = registered();
		const view = projectManagedState({
			status: s,
			policy: policyOf(s),
			custody: { state: 'protected' },
			supported: SUPPORTED,
			now: NOW,
		});
		expect(view).toMatchObject({
			at: new Date(NOW).toISOString(),
			standing: 'managed',
			reason: null,
			custody: { state: 'protected', record: 'ok', message: null },
			enrollment: {
				installationId: 'inst-1',
				tenantId: 'tenant-1',
				orgId: 'org-1',
				enrollmentId: 'enr-1',
			},
			endpoint: {
				attached: true,
				management: 'managed',
				connectivity: 'online',
				collectionProfile: 'metadata',
			},
			actor: { phase: 'registered', actorId: null, registration: { state: 'none' } },
			policy: {
				appliedRevision: 3,
				desiredRevision: 3,
				source: 'endpoint',
				freshness: 'fresh',
				converged: true,
			},
			capabilities: {
				supported: SUPPORTED,
				negotiated: ['attachment', 'execution'],
				missing: ['compatibility', 'telemetry'],
			},
			egress: { held: [] },
			localRelease: { allowed: false },
		});
		const text = JSON.stringify(view);
		expect(text).not.toContain('/run/endpoint.sock');
		expect(text).not.toContain('b'.repeat(64));
		expect(text).not.toContain('socketPath');
	});

	// MRC2-05-03: the chokepoint's ledger rides along as copies, so a pane can
	// say what the egress ceiling held without a toast on every start.
	it('carries the egress holds it is handed, as copies', () => {
		const s = registered();
		const hold = {
			class: 'vendor-telemetry',
			code: 'class-denied',
			origin: 'https://runmaestro.ai',
			firstAt: OBSERVED,
			lastAt: OBSERVED,
			count: 3,
		} as const;
		const view = projectManagedState({
			status: s,
			policy: policyOf(s),
			custody: { state: 'protected' },
			supported: SUPPORTED,
			egress: [hold],
		});
		expect(view.egress).toEqual({ held: [hold] });
		expect(view.egress.held[0]).not.toBe(hold);
	});

	it('names a custody refusal with its message and no enrollment', () => {
		const s: ManagedEnrollmentStatus = {
			...status({ record: null }),
			identity: {
				status: 'unprotected',
				reason: 'encryption-unavailable',
				message: 'No keychain.',
				record: null,
			},
		};
		const view = projectManagedState({
			status: s,
			policy: policyOf(s),
			custody: { state: 'unprotected', reason: 'encryption-unavailable', message: 'No keychain.' },
			supported: SUPPORTED,
		});
		expect(view).toMatchObject({
			standing: 'custody-refused',
			custody: { state: 'unprotected', record: 'unprotected', message: 'No keychain.' },
			enrollment: null,
			endpoint: { attached: false, connectivity: 'detached' },
			capabilities: { negotiated: [], missing: SUPPORTED },
			localRelease: { allowed: true, reason: 'no-record' },
		});
	});
});
