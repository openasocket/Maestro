/**
 * Delegated dispatch (MRC-07-04): the causal context an initiator hands to a
 * child, how the child's context is derived from it, how it travels in an
 * environment, and how a host intersects the initiator's scope with its own.
 * Pure rules; no host, no process.
 */

import { describe, it, expect } from 'vitest';
import {
	MANAGED_DELEGATION_ENV_VAR,
	MAX_DELEGATION_DEPTH,
	MAX_DELEGATION_ENV_LENGTH,
	childDelegationContext,
	delegatedWritable,
	delegationContextEnv,
	delegationContextOf,
	delegationContextProblems,
	encodeDelegationContext,
	intersectDelegationScope,
	isManagedDelegationContext,
	readDelegationContextEnv,
	type ManagedDelegationContext,
} from '../../../../shared/maestro-lib/managed/delegation';
import { MANAGED_CONTRACT_VERSION } from '../../../../shared/maestro-lib/managed/types';

const WORKFLOW = {
	workflowId: 'cue-pipeline:Nightly QA',
	version: 'v1',
	triggerEventId: 'time.scheduled:evt-1',
	ownerEpoch: 'epoch-3',
	fencingToken: 'fence-3',
};

function initiator(overrides: Partial<ManagedDelegationContext> = {}): ManagedDelegationContext {
	return {
		contractVersion: MANAGED_CONTRACT_VERSION,
		identity: {
			requestId: 'run-9',
			idempotencyKey: 'run-9',
			attemptId: 'attempt-1',
			runId: 'run-9',
			rootRunId: 'root-1',
			parentRunId: 'run-8',
		},
		traceId: 'cue:root-1:run-9:attempt-1',
		workflow: WORKFLOW,
		delegation: {
			chain: [
				{ kind: 'service', id: 'cue-subscription:nightly' },
				{ kind: 'agent', id: 'agent-1' },
			],
			grantRef: 'grant-7',
		},
		policyRevision: 7,
		...overrides,
	};
}

describe('delegationContextOf', () => {
	it('is the attribution half of a context, copied, under the contract version', () => {
		const source = initiator();
		const context = delegationContextOf(source);
		expect(context).toEqual(source);
		expect(context.identity).not.toBe(source.identity);
		expect(context.delegation.chain).not.toBe(source.delegation.chain);
		expect(context.workflow).not.toBe(source.workflow);
	});

	it('a standalone lineage carries no workflow and no policy generation', () => {
		const context = delegationContextOf({
			identity: initiator().identity,
			traceId: 't',
			workflow: null,
			delegation: { chain: [], grantRef: null },
			policyRevision: null,
		});
		expect(context.workflow).toBeNull();
		expect(context.policyRevision).toBeNull();
		expect(isManagedDelegationContext(context)).toBe(true);
	});
});

describe('delegationContextProblems', () => {
	it('accepts a context and refuses what is not one', () => {
		expect(delegationContextProblems(initiator())).toEqual([]);
		expect(delegationContextProblems(null)).toEqual(['delegation context is not an object']);
		expect(delegationContextProblems('x')).toEqual(['delegation context is not an object']);
	});

	it('refuses a field this version does not carry instead of dropping it', () => {
		const problems = delegationContextProblems({ ...initiator(), tenantGrant: 'wide-open' });
		expect(problems).toEqual(['unknown field "tenantGrant"']);
	});

	it('refuses a missing workflow or policy generation: null is a value, absent is not', () => {
		const { workflow: _w, ...noWorkflow } = initiator();
		expect(delegationContextProblems(noWorkflow)).toContain('workflow is missing');
		const { policyRevision: _p, ...noRevision } = initiator();
		expect(delegationContextProblems(noRevision)).toContain('policyRevision is missing');
	});

	it('applies the context rules to the carried half: version, ids, chain, workflow fence', () => {
		expect(delegationContextProblems({ ...initiator(), contractVersion: 'other/9' })).toContain(
			`contractVersion is not ${MANAGED_CONTRACT_VERSION}`
		);
		expect(
			delegationContextProblems(initiator({ identity: { ...initiator().identity, requestId: '' } }))
		).toContain('identity.requestId is not an id');
		expect(
			delegationContextProblems(initiator({ workflow: { ...WORKFLOW, fencingToken: '' } }))
		).toContain('workflow.fencingToken is not an id');
		expect(
			delegationContextProblems(
				initiator({ delegation: { chain: [{ kind: 'robot', id: 'x' } as never], grantRef: null } })
			)
		).toContain('delegation.chain[0].kind is not a principal kind');
	});

	it('bounds the chain depth', () => {
		const chain = Array.from({ length: MAX_DELEGATION_DEPTH + 1 }, (_, i) => ({
			kind: 'agent' as const,
			id: `agent-${i}`,
		}));
		expect(delegationContextProblems(initiator({ delegation: { chain, grantRef: null } }))).toEqual(
			[`delegation.chain exceeds ${MAX_DELEGATION_DEPTH} links`]
		);
	});
});

describe('childDelegationContext', () => {
	const input = {
		link: { kind: 'agent' as const, id: 'agent-2' },
		requestId: 'req-c',
		attemptId: 'att-c',
	};

	it('is one link deeper, parented under the initiator run, under the same root, workflow carried', () => {
		const child = childDelegationContext(initiator(), input);
		expect(child).toEqual({
			contractVersion: MANAGED_CONTRACT_VERSION,
			identity: {
				requestId: 'req-c',
				idempotencyKey: 'req-c',
				attemptId: 'att-c',
				runId: 'req-c',
				rootRunId: 'root-1',
				parentRunId: 'run-9',
			},
			traceId: 'delegated:root-1:req-c:att-c',
			workflow: WORKFLOW,
			delegation: {
				chain: [
					{ kind: 'service', id: 'cue-subscription:nightly' },
					{ kind: 'agent', id: 'agent-1' },
					{ kind: 'agent', id: 'agent-2' },
				],
				grantRef: 'grant-7',
			},
			policyRevision: 7,
		});
		expect(isManagedDelegationContext(child)).toBe(true);
	});

	it('an initiator that names no run or root is the root of its children', () => {
		const parent = initiator({
			identity: {
				requestId: 'req-p',
				idempotencyKey: 'req-p',
				attemptId: 'att-p',
				runId: null,
				rootRunId: null,
				parentRunId: null,
			},
		});
		const child = childDelegationContext(parent, input);
		expect(child.identity.rootRunId).toBe('req-p');
		expect(child.identity.parentRunId).toBe('req-p');
	});

	it('takes an explicit idempotency key and never aliases the parent record', () => {
		const parent = initiator();
		const child = childDelegationContext(parent, { ...input, idempotencyKey: 'submit-1' });
		expect(child.identity.idempotencyKey).toBe('submit-1');
		child.delegation.chain.pop();
		expect(parent.delegation.chain).toHaveLength(2);
	});

	it('a grandchild stays bounded in trace length at any depth', () => {
		let context = initiator();
		for (let i = 0; i < 12; i += 1) {
			context = childDelegationContext(context, {
				link: { kind: 'agent', id: `agent-${i}` },
				requestId: `11111111-2222-3333-4444-55555555555${i % 10}`,
				attemptId: `aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeee${i % 10}`,
			});
		}
		expect(context.traceId.length).toBeLessThan(256);
		expect(context.delegation.chain).toHaveLength(14);
		expect(delegationContextProblems(context)).toEqual([]);
	});
});

describe('intersectDelegationScope', () => {
	it('a managed initiator cannot hand a child to a host with no enrollment', () => {
		const scope = intersectDelegationScope(initiator(), {
			standing: 'standalone',
			policyRevision: null,
		});
		expect(scope).toMatchObject({ ok: false, state: 'unavailable', code: 'runtime-unavailable' });
		expect(scope.ok ? '' : scope.message).toContain('run-9');
		expect(scope.ok ? '' : scope.message).toContain('revision 7');
	});

	it('an unmanaged initiator on a standalone host is the ordinary case', () => {
		expect(
			intersectDelegationScope(initiator({ policyRevision: null }), {
				standing: 'standalone',
				policyRevision: null,
			})
		).toEqual({ ok: true, policyRevision: null, reauthorized: false });
	});

	it('a managed host admits the child under its own generation, reauthorized when it moved on', () => {
		expect(
			intersectDelegationScope(initiator(), { standing: 'managed', policyRevision: 7 })
		).toEqual({
			ok: true,
			policyRevision: 7,
			reauthorized: false,
		});
		expect(
			intersectDelegationScope(initiator(), { standing: 'managed', policyRevision: 8 })
		).toEqual({
			ok: true,
			policyRevision: 8,
			reauthorized: true,
		});
		expect(
			intersectDelegationScope(initiator({ policyRevision: null }), {
				standing: 'managed',
				policyRevision: 8,
			})
		).toEqual({ ok: true, policyRevision: 8, reauthorized: true });
	});
});

describe('delegatedWritable', () => {
	it('never widens: a read-only initiator keeps its child read-only', () => {
		expect(delegatedWritable(false, true)).toBe(false);
		expect(delegatedWritable(true, true)).toBe(true);
		expect(delegatedWritable(null, true)).toBe(true);
		expect(delegatedWritable(true, false)).toBe(false);
	});
});

describe('the environment carriage', () => {
	it('round-trips a context through the one env entry as canonical JSON', () => {
		const context = initiator();
		const env = delegationContextEnv(context);
		expect(Object.keys(env)).toEqual([MANAGED_DELEGATION_ENV_VAR]);
		expect(env[MANAGED_DELEGATION_ENV_VAR]).toBe(encodeDelegationContext(context));
		expect(readDelegationContextEnv({ PATH: '/bin', ...env })).toEqual({ status: 'ok', context });
		// Canonical: key order does not change the encoding.
		const reordered = { policyRevision: 7, ...context };
		expect(encodeDelegationContext(reordered as ManagedDelegationContext)).toBe(
			encodeDelegationContext(context)
		);
	});

	it('a blank or missing entry is absent', () => {
		expect(readDelegationContextEnv({})).toEqual({ status: 'absent' });
		expect(readDelegationContextEnv({ [MANAGED_DELEGATION_ENV_VAR]: '  ' })).toEqual({
			status: 'absent',
		});
	});

	it('anything else offered is refused with the problems named, never run anonymous', () => {
		expect(readDelegationContextEnv({ [MANAGED_DELEGATION_ENV_VAR]: '{nope' })).toMatchObject({
			status: 'invalid',
			problems: [expect.stringContaining('is not JSON')],
		});
		expect(
			readDelegationContextEnv({
				[MANAGED_DELEGATION_ENV_VAR]: JSON.stringify({ ...initiator(), extra: 1 }),
			})
		).toEqual({ status: 'invalid', problems: ['unknown field "extra"'] });
		expect(
			readDelegationContextEnv({
				[MANAGED_DELEGATION_ENV_VAR]: `{"a":"${'x'.repeat(MAX_DELEGATION_ENV_LENGTH)}"}`,
			})
		).toEqual({
			status: 'invalid',
			problems: [`the encoded context exceeds ${MAX_DELEGATION_ENV_LENGTH} characters`],
		});
	});
});
