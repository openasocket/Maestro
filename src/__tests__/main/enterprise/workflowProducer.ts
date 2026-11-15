/**
 * A v2 workflow lifecycle producer double in the contract's shapes, for a
 * fake endpoint's `operations`: claim issues `ISSUED`, renew echoes the held
 * owner, settle and release echo the request. It mints leases from the
 * request, so nothing it answers is paired enforcement.
 */

import type { EndpointWorkflowOwner } from '../../../shared/maestro-lib/managed/endpoint-port';
import type { FakeEndpointOptions } from './fakeEndpoint';

export const ISSUED: EndpointWorkflowOwner = {
	ownerId: 'inst-1',
	ownerEpoch: 'opaque-epoch-1',
	fencingToken: 'server-fence-1',
};

type Payload = Record<string, unknown>;

/** The workflow context of a request, without the request-only fields, as a lease echoes it. */
export function contextOf(payload: Payload): Payload {
	const { requestedLeaseMs: _lease, owner: _owner, ...context } = payload;
	return context;
}

export function leaseOf(payload: Payload, owner: unknown, now: () => number = Date.now): Payload {
	const acquiredAt = now();
	return {
		...contextOf(payload),
		owner,
		acquiredAt: new Date(acquiredAt).toISOString(),
		expiresAt: new Date(acquiredAt + (payload.requestedLeaseMs as number)).toISOString(),
	};
}

/**
 * The lifecycle verbs. A claim issues `issued`, by default `ISSUED` owned by
 * the installation the request's registration names; leases and timestamps
 * read `now` (the host's clock in a composition test).
 */
export function workflowProducer(
	options: { issued?: EndpointWorkflowOwner; now?: () => number } = {}
): NonNullable<FakeEndpointOptions['operations']> {
	const { issued, now = Date.now } = options;
	return {
		workflow_claim: (payload) => {
			const registration = (payload as { registration?: { installationId?: string } }).registration;
			const owner = issued ?? {
				...ISSUED,
				ownerId: registration?.installationId ?? ISSUED.ownerId,
			};
			return { outcome: 'owned', lease: leaseOf(payload as Payload, owner, now) };
		},
		workflow_renew: (payload) => ({
			outcome: 'renewed',
			lease: leaseOf(payload as Payload, (payload as Payload).owner, now),
		}),
		workflow_settle: (payload) => ({
			...(payload as Payload),
			outcome: 'recorded',
			recordedAt: new Date(now()).toISOString(),
		}),
		workflow_release: (payload) => ({
			...(payload as Payload),
			outcome: 'released',
			releasedAt: new Date(now()).toISOString(),
		}),
	};
}

/** The `registration_use` answer for one installation's runtime_use registration. */
export function projectedRegistrationUse(installation: {
	installationId: string;
	runtimeId: string;
	processEpoch: string;
}) {
	return {
		outcome: 'projected',
		reference: {
			version: 2,
			purpose: 'runtime_use',
			tenantId: '1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b',
			orgId: '9a7b330a-a736-41e5-9c5f-ad2e6d2b8a0c',
			enrollmentId: '6f1c2c1e-0000-4000-8000-0000000000aa',
			installationId: installation.installationId,
			runtimeId: installation.runtimeId,
			processEpoch: installation.processEpoch,
			bindingDigest: 'a'.repeat(64),
			processBirthDigest: 'd'.repeat(64),
			challengeId: '6f1c2c1e-0000-4000-8000-0000000000bb',
			challengeDigest: 'c'.repeat(64),
		},
		expiresAt: '2099-01-01T00:00:00.000Z',
	};
}

/** Every v2 operation a workflow composition needs offered: the reference and the four verbs. */
export const WORKFLOW_OFFER = [
	'registration_use',
	'workflow_claim',
	'workflow_renew',
	'workflow_settle',
	'workflow_release',
] as const;
