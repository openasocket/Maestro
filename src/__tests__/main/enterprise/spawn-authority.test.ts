/**
 * The desktop's spawn authority (`createProcessSpawnAuthority`): the context
 * it binds a spawn into carries exactly what the sink handed it. The
 * workflow reference of an Auto Run attempt (MRC-07-01B) reaches the verified
 * context with its owner fence, a chat turn's null stays null, and the
 * principal is the enrollment's registered actor or the installation operator.
 */

import { describe, expect, it } from 'vitest';
import {
	createCueSpawnAuthority,
	createProcessSpawnAuthority,
} from '../../../main/enterprise/spawn-authority';
import type { IdentityRead } from '../../../main/enterprise/identity-store';
import type { ManagedWorkflowRef } from '../../../shared/maestro-lib/managed/types';
import { fakeSpawnPort } from '../../helpers/managedSpawnPort';

const INSTALLATION = { installationId: 'inst-1', runtimeId: 'desktop-1', processEpoch: 'e1' };

function authority(read: IdentityRead = { status: 'none' }) {
	return createProcessSpawnAuthority({
		installation: INSTALLATION,
		identity: { read: () => read },
		host: { policy: () => ({ sources: [], policyRevision: 3 }) },
		dispatch: { authority: fakeSpawnPort().authority },
		now: () => 1_000_000,
	});
}

const IDENTITY = {
	requestId: 'req-1',
	idempotencyKey: 'req-1',
	attemptId: 'att-1',
	runId: 'turn-1',
	rootRunId: 'run-root',
	parentRunId: 'run-root',
};

describe('createProcessSpawnAuthority verify', () => {
	it('passes an Auto Run workflow reference through to the verified context', () => {
		const workflow: ManagedWorkflowRef = {
			workflowId: 'playbook:/work/.maestro/playbooks/release',
			version: 'docs-2-0badf00d',
			triggerEventId: 'operator:1700000000000',
			ownerEpoch: 'epoch-1',
			fencingToken: 'fence-1',
		};
		const verified = authority().verify({
			actor: { peer: 'in-process' },
			identity: IDENTITY,
			traceId: 'autorun:run-root:req-1:1',
			policyRevision: 3,
			workflow,
		});
		expect(verified.ok).toBe(true);
		if (!verified.ok) return;
		expect(verified.context.workflow).toEqual(workflow);
		expect(verified.context.identity).toEqual(IDENTITY);
		expect(verified.context.traceId).toBe('autorun:run-root:req-1:1');
		expect(verified.context.origin).toBe('desktop');
		expect(verified.context.actor.id).toBe('operator:inst-1');
		expect(verified.context.installation).toEqual(INSTALLATION);
	});

	it('keeps a chat turn workflow-less and the browser account on the delegation chain', () => {
		const verified = authority().verify({
			actor: { peer: 'web-login', username: 'ada' },
			identity: { ...IDENTITY, runId: null, rootRunId: null, parentRunId: null },
			traceId: 'agent-1-ai-tab-1',
			policyRevision: 3,
			workflow: null,
		});
		expect(verified.ok).toBe(true);
		if (!verified.ok) return;
		expect(verified.context.workflow).toBeNull();
		expect(verified.context.delegation.chain).toEqual([{ kind: 'human', id: 'web-login:ada' }]);
		expect(verified.context.verification.peer).toBe('web-login');
	});

	it('refuses a workflow reference with a blank fence field rather than repairing it', () => {
		const verified = authority().verify({
			actor: { peer: 'in-process' },
			identity: IDENTITY,
			traceId: 'autorun:run-root:req-1:1',
			policyRevision: 3,
			workflow: {
				workflowId: 'playbook:release',
				version: 'docs-2-0badf00d',
				triggerEventId: 'operator:1',
				ownerEpoch: '',
				fencingToken: 'fence-1',
			},
		});
		expect(verified.ok).toBe(false);
		if (verified.ok) return;
		expect(verified.problems.join('; ')).toContain('workflow.ownerEpoch');
	});
});

/**
 * The desktop's Cue port (`createCueSpawnAuthority`, MRC-07-02A): the same
 * enrollment, authority and policy as the process manager's port, under the
 * shape the Cue run router admits a prompt run with, with origin `cue` and the
 * lineage the router bound carried through untouched.
 */
describe('createCueSpawnAuthority', () => {
	const port = fakeSpawnPort();
	const CUE_WORKFLOW: ManagedWorkflowRef = {
		workflowId: 'cue-pipeline:Nightly QA',
		version: 'a'.repeat(64),
		triggerEventId: 'time.scheduled:evt-1',
		ownerEpoch: 'epoch-3',
		fencingToken: 'fence-3',
	};
	const DELEGATION = {
		chain: [
			{ kind: 'service' as const, id: 'cue-subscription:nightly' },
			{ kind: 'agent' as const, id: 'agent-1' },
		],
		grantRef: null,
	};

	function cueAuthority(read: IdentityRead = { status: 'none' }) {
		return createCueSpawnAuthority({
			installation: INSTALLATION,
			identity: { read: () => read },
			host: { policy: () => ({ sources: [], policyRevision: 3 }) },
			dispatch: { authority: port.authority },
			now: () => 1_000_000,
		});
	}

	it('binds a Cue run with origin cue, the operator principal, and the lineage the router handed it', () => {
		const authority = cueAuthority();
		const verified = authority.context({
			identity: { ...IDENTITY, runId: 'run-9', rootRunId: 'root-1', parentRunId: 'run-8' },
			traceId: 'cue:root-1:run-9:att-1',
			policyRevision: 3,
			workflow: CUE_WORKFLOW,
			delegation: DELEGATION,
		});
		expect(verified.ok).toBe(true);
		if (!verified.ok) return;
		expect(verified.context.origin).toBe('cue');
		expect(verified.context.actor).toEqual({ kind: 'human', id: 'operator:inst-1' });
		expect(verified.context.workflow).toEqual(CUE_WORKFLOW);
		expect(verified.context.delegation).toEqual(DELEGATION);
		expect(verified.context.traceId).toBe('cue:root-1:run-9:att-1');
		expect(verified.context.installation).toEqual(INSTALLATION);
		expect(verified.context.verification).toMatchObject({
			verifierId: 'desktop-cue:desktop-1',
			peer: 'in-process',
		});
		expect(verified.context.requestedCapabilities).toEqual(['runs.submit']);
	});

	it('shares the enrollment standing, the dispatch authority and the policy of the process port', () => {
		const standalone = cueAuthority();
		expect(standalone.standing()).toBe('standalone');
		const enrolled = cueAuthority({
			status: 'ok',
			record: { registration: { actorId: 'actor-registered' } } as never,
		});
		expect(enrolled.standing()).toBe('managed');
		expect(enrolled.authority).toBe(port.authority);
		expect(enrolled.policy()).toEqual({ sources: [], policyRevision: 3 });
		const verified = enrolled.context({
			identity: IDENTITY,
			traceId: 'cue:root-1:run-9:att-1',
			policyRevision: 3,
		});
		expect(verified.ok).toBe(true);
		if (!verified.ok) return;
		// The registered actor is the principal once one exists; a direct action has no chain.
		expect(verified.context.actor).toEqual({ kind: 'human', id: 'actor-registered' });
		expect(verified.context.delegation).toEqual({ chain: [], grantRef: null });
		expect(verified.context.workflow).toBeNull();
	});

	it('refuses a workflow with a blank fence field rather than repairing or dropping it', () => {
		const verified = cueAuthority().context({
			identity: IDENTITY,
			traceId: 'cue:root-1:run-9:att-1',
			policyRevision: 3,
			workflow: { ...CUE_WORKFLOW, fencingToken: '' },
		});
		expect(verified.ok).toBe(false);
		if (verified.ok) return;
		expect(verified.problems.join('; ')).toContain('workflow.fencingToken');
	});
});
