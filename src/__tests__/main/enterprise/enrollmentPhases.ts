/**
 * Relayed enrollment fixtures (decision D1, contracts 0.3.0): the three phase
 * inputs a caller hands `requestEnrollment`, and a fake-endpoint `enrollment`
 * handler that answers each phase as the endpoint does, echoing the
 * management it was named.
 */

import type { FakeEndpointOptions } from './fakeEndpoint';

/** The ids the contract types as UUIDs. */
export const TENANT_ID = '1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b';
export const ENROLLMENT_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
export const REQUEST_ID = '16fd2706-8baf-433b-82eb-8c7fada847da';
export const CHALLENGE_ID = 'a8098c1a-f86e-4ada-8c5d-1f5c0d9a3e11';

export const MANAGEMENT = Object.freeze({
	origin: 'https://mega.example',
	tenantId: TENANT_ID,
	issuerSha256: 'a'.repeat(64),
});

export const PUBLIC_KEY_PEM = '-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n';

export function requestPhase(socketPath: string) {
	return {
		phase: 'request' as const,
		socketPath,
		management: { ...MANAGEMENT },
		orgId: 'org-1',
		serverCaPem: '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n',
	};
}

export function provePhase(socketPath: string) {
	return {
		phase: 'prove' as const,
		socketPath,
		management: { ...MANAGEMENT },
		challenge: {
			id: CHALLENGE_ID,
			enrollmentId: ENROLLMENT_ID,
			nonce: 'p'.repeat(43),
			expiresAt: '2099-01-01T00:00:00.000Z',
		},
	};
}

export function activatePhase(socketPath: string) {
	return {
		phase: 'activate' as const,
		socketPath,
		management: { ...MANAGEMENT },
		activation: {
			enrollmentId: ENROLLMENT_ID,
			certificatePem: '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n',
			trust: {
				tenantId: MANAGEMENT.tenantId,
				certificatePem: '-----BEGIN CERTIFICATE-----\nBBBB\n-----END CERTIFICATE-----\n',
				issuerSha256: MANAGEMENT.issuerSha256,
				keyStorage: 'software' as const,
			},
		},
	};
}

/** The endpoint's answer to one relayed phase. */
export function answerEnrollmentPhase(payload: unknown): unknown {
	const request = payload as Record<string, any>;
	if (request.phase === 'request') {
		return {
			outcome: 'enrollment_requested',
			management: request.management,
			requestId: REQUEST_ID,
			identity: { ...request.identity, publicKeyPem: PUBLIC_KEY_PEM, keyStorage: 'software' },
		};
	}
	if (request.phase === 'prove') {
		return {
			outcome: 'possession_signed',
			management: request.management,
			enrollmentId: request.challenge.enrollmentId,
			challengeId: request.challenge.id,
			signature: 's'.repeat(86),
		};
	}
	return {
		outcome: 'enrolled',
		management: request.management,
		enrollmentId: request.activation.enrollmentId,
		keyStorage: 'software',
	};
}

/** A fake endpoint that relays enrollment on protocol 2. */
export const SERVES_RELAYED_ENROLLMENT: FakeEndpointOptions = {
	capabilities: ['enrollment'],
	operations: { enrollment: answerEnrollmentPhase },
};
