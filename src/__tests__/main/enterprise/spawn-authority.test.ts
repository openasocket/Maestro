/**
 * The desktop's spawn authority (`createProcessSpawnAuthority`): the context
 * it binds a spawn into carries exactly what the sink handed it. The
 * workflow reference of an Auto Run attempt (MRC-07-01B) reaches the verified
 * context with its owner fence, a chat turn's null stays null, and the
 * principal is the enrollment's registered actor or the installation operator.
 */

import { describe, expect, it } from 'vitest';
import { createProcessSpawnAuthority } from '../../../main/enterprise/spawn-authority';
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
