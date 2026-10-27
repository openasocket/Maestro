/**
 * An egress authority for tests of a caller behind the fetch chokepoint
 * (MRC2-05-03): refuses every request by a named code, as a managed host whose
 * policy omits the class does, and keeps the requests it was asked about so a
 * suite can assert the class and origin a caller named. Install it with
 * `setEgressAuthority()` from `src/main/utils/fetchWithTimeout.ts` and remove
 * it (null) after the test.
 */

import type {
	EgressAuthority,
	EgressDenial,
	EgressRequest,
} from '../../main/enterprise/egress-policy';

export interface DenyingEgressAuthority {
	authority: EgressAuthority;
	/** Every request the authority was asked about, in order. */
	requests: EgressRequest[];
}

export function denyingEgressAuthority(
	code: Extract<EgressDenial, 'class-denied' | 'unavailable'> = 'class-denied'
): DenyingEgressAuthority {
	const requests: EgressRequest[] = [];
	return {
		requests,
		authority: {
			evaluateEgress(request) {
				requests.push(request);
				return {
					allowed: false,
					code,
					message: `the egress ceiling admits no ${request.class} request for the operator`,
					managed: {
						policyRevision: 3,
						class: request.class,
						actor: 'the operator',
						origin: new URL(request.url).origin,
						outcome: code,
					},
				};
			},
		},
	};
}
