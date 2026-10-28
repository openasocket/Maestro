/**
 * Listener authorities for tests of a sink behind the listener gate
 * (MRC2-05-06): one that refuses every listener by a named code, as a managed
 * host whose policy omits the kind does, and one that is the REAL source over
 * an installed ceiling, for a suite that must prove the verdict a sink meets
 * (a loopback web server binds, a LAN one is refused `reach-denied`). Both
 * keep the requests they were asked about so a suite can assert the kind,
 * bind and port a sink named. Install with `setListenerAuthority()` from
 * `src/main/enterprise/listener-gate.ts` and remove it (null) after the test.
 */

import type { IdentityRead } from '../../main/enterprise/identity-store';
import {
	createListenerPolicySource,
	listenerReach,
	type ListenerAuthority,
	type ListenerDenial,
	type ListenerRequest,
} from '../../main/enterprise/listener-policy';

export interface RecordingListenerAuthority {
	authority: ListenerAuthority;
	/** Every request the authority was asked about, in order. */
	requests: ListenerRequest[];
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

/** The real source over an enrolled host with the given entries installed; a document the parser refuses throws. */
export function managedListenerAuthority(
	listeners: readonly unknown[],
	policyRevision = 3
): RecordingListenerAuthority {
	const source = createListenerPolicySource({
		identity: { read: () => enrolledRead(policyRevision) },
		policy: () => ({ appliedRevision: policyRevision }),
	});
	const outcome = source.install({ policyRevision, listeners: [...listeners] });
	if (!outcome.installed) throw new Error(outcome.problems.join('; '));
	const requests: ListenerRequest[] = [];
	return {
		requests,
		authority: {
			evaluateListener(request) {
				requests.push(request);
				return source.evaluateListener(request);
			},
		},
	};
}

export function denyingListenerAuthority(
	code: Extract<ListenerDenial, 'kind-denied' | 'unavailable'> = 'kind-denied'
): RecordingListenerAuthority {
	const requests: ListenerRequest[] = [];
	return {
		requests,
		authority: {
			evaluateListener(request) {
				requests.push(request);
				return {
					allowed: false,
					code,
					message: `the listener ceiling admits no ${request.kind} listener`,
					managed: {
						policyRevision: 3,
						kind: request.kind,
						bind: request.bind,
						port: request.port,
						reach: listenerReach(request.kind, request.bind),
						outcome: code,
					},
				};
			},
		},
	};
}
