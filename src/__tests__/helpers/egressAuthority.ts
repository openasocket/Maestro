/**
 * An egress authority for tests of a caller behind the fetch chokepoint
 * (MRC2-05-03): refuses every request by a named code, as a managed host whose
 * policy omits the class does, and keeps the requests it was asked about so a
 * suite can assert the class and origin a caller named. Install it with
 * `setEgressAuthority()` from `src/main/utils/fetchWithTimeout.ts` and remove
 * it (null) after the test.
 */

import type { IdentityRead } from '../../main/enterprise/identity-store';
import {
	createEgressPolicySource,
	type EgressAuthority,
	type EgressDenial,
	type EgressRequest,
} from '../../main/enterprise/egress-policy';

export interface DenyingEgressAuthority {
	authority: EgressAuthority;
	/** Every request the authority was asked about, in order. */
	requests: EgressRequest[];
}

/** An enrolled, registered host under one applied policy revision. */
function enrolledRead(policyRevision: number): IdentityRead {
	return {
		status: 'ok',
		epoch: 1,
		record: {
			registration: { actorId: 'actor', registeredAt: 1 },
			policy: { appliedRevision: policyRevision, appliedAt: 1 },
		},
	} as never;
}

/**
 * The REAL egress source over an enrolled host with the given ceiling classes
 * installed (MRC2-05-05), wrapped to keep the requests it was asked about: for
 * a suite that must prove the verdict a sink meets (an approved account
 * leaves, a personal one is refused `account-denied`) rather than a canned
 * refusal. A document the parser refuses throws, so a bad fixture is loud.
 */
export function managedEgressAuthority(
	classes: readonly unknown[],
	policyRevision = 3
): DenyingEgressAuthority {
	const source = createEgressPolicySource({
		identity: { read: () => enrolledRead(policyRevision) },
		policy: () => ({ appliedRevision: policyRevision }),
	});
	const outcome = source.install({ policyRevision, classes: [...classes] });
	if (!outcome.installed) throw new Error(outcome.problems.join('; '));
	const requests: EgressRequest[] = [];
	return {
		requests,
		authority: {
			evaluateEgress(request) {
				requests.push(request);
				return source.evaluateEgress(request);
			},
		},
	};
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
