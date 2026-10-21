/**
 * Phase 02 unit coverage: the context verifier, dispatch snapshots, the local
 * host authority and its leases, the managed binding, and the run journal.
 *
 * Everything here is an injected double for the PEER (a policy table, a
 * clock, a temp data directory); the Maestro code under test is real. Paired
 * enforcement at the process is covered by `start-turn.test.ts` and
 * `runtime/__tests__/turns.test.ts`, not by anything in this file.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
	buildDispatchSnapshot,
	createContextVerifier,
	createLocalHostAuthority,
	dispatchSnapshotDigest,
	isVerifiedContext,
	unavailableAuthority,
	type AdmissionRequest,
	type DispatchLease,
	type PolicyDecision,
} from '../../../../shared/maestro-lib/managed/authority';
import {
	bindingDigest,
	createManagedBinding,
	managedBindingFiles,
	readManagedBindingFile,
} from '../../../../shared/maestro-lib/managed/binding';
import { createRunJournal } from '../../../../shared/maestro-lib/managed/run-journal';
import {
	MANAGED_CONTRACT_VERSION,
	type ManagedOperationContext,
} from '../../../../shared/maestro-lib/managed/types';

const CONTEXT: ManagedOperationContext = {
	contractVersion: MANAGED_CONTRACT_VERSION,
	installation: { installationId: 'inst', runtimeId: 'rt', processEpoch: 'epoch' },
	origin: 'cli',
	actor: { kind: 'human', id: 'alice' },
	delegation: { chain: [], grantRef: null },
	identity: {
		requestId: 'req-1',
		idempotencyKey: 'key-1',
		attemptId: 'att-1',
		runId: null,
		rootRunId: null,
		parentRunId: null,
	},
	policyRevision: 3,
	workflow: null,
	traceId: 'trace-1',
	requestedCapabilities: ['runs.submit'],
};

const SPEC = {
	command: '/bin/agent',
	args: ['--print', 'hi'],
	cwd: '/work',
	env: { B: '2', A: '1' },
};

function verifier(now = () => 0, accept: () => string[] = () => []) {
	return createContextVerifier({ verifierId: 'v', peer: 'in-process', now, accept });
}

function verified(context: ManagedOperationContext = CONTEXT) {
	const result = verifier().verify(context);
	if (!result.ok) throw new Error(result.problems.join('; '));
	return result.context;
}

function authority(
	decide: (request: AdmissionRequest) => PolicyDecision | Promise<PolicyDecision>
) {
	let now = 0;
	let ids = 0;
	const auth = createLocalHostAuthority({
		authorityId: 'auth',
		decide,
		now: () => now,
		newId: () => `lease-${++ids}`,
		leaseTtlMs: 100,
	});
	return { auth, tick: (ms: number) => (now += ms) };
}

const ALLOW: PolicyDecision = { decision: 'allow', policyRevision: 3 };

async function admitted(auth: ReturnType<typeof authority>['auth'], request?: AdmissionRequest) {
	const outcome = await auth.admit(
		request ?? {
			context: verified(),
			snapshot: buildDispatchSnapshot(SPEC, { provider: 'claude-code' }),
			policy: { sources: [], policyRevision: 3 },
		}
	);
	if (outcome.state !== 'admitted') throw new Error(`expected admitted, got ${outcome.state}`);
	return outcome.lease;
}

describe('context verifier', () => {
	it('binds a structurally valid, accepted context and nothing else', () => {
		const result = verifier(() => 1_000).verify(CONTEXT);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(isVerifiedContext(result.context)).toBe(true);
		expect(result.context.verification).toEqual({
			peer: 'in-process',
			verifierId: 'v',
			verifiedAt: '1970-01-01T00:00:01.000Z',
		});
		// A copy, a cast, or the original object are not what the verifier produced.
		expect(isVerifiedContext({ ...result.context })).toBe(false);
		expect(isVerifiedContext(CONTEXT)).toBe(false);
		expect(isVerifiedContext(null)).toBe(false);
		expect(Object.isFrozen(result.context)).toBe(true);
	});

	it('refuses a malformed context as invalid-input and a rejected one as unauthenticated', () => {
		expect(verifier().verify({ ...CONTEXT, traceId: '' })).toMatchObject({
			ok: false,
			code: 'invalid-input',
			problems: ['traceId is not an id'],
		});
		expect(
			verifier(
				() => 0,
				() => ['not this installation']
			).verify(CONTEXT)
		).toEqual({
			ok: false,
			code: 'unauthenticated',
			problems: ['not this installation'],
		});
	});
});

describe('dispatch snapshot', () => {
	it('names the final executable, arguments and environment keys, never the values', () => {
		const snapshot = buildDispatchSnapshot(
			{ ...SPEC, stdin: 'prompt', shell: true },
			{ provider: 'p', model: 'm', account: 'acct', target: { kind: 'ssh', remoteId: 'r1' } }
		);
		expect(snapshot).toMatchObject({
			executable: '/bin/agent',
			args: ['--print', 'hi'],
			cwd: '/work',
			shell: true,
			envKeys: ['A', 'B'],
			provider: 'p',
			model: 'm',
			account: 'acct',
			target: { kind: 'ssh', remoteId: 'r1' },
			effects: ['launch'],
		});
		expect(JSON.stringify(snapshot)).not.toContain('"1"');
		expect(snapshot.stdinDigest).toHaveLength(64);
	});

	it('digests the same spec the same way and any change differently', () => {
		const a = dispatchSnapshotDigest(buildDispatchSnapshot(SPEC, { provider: 'p' }));
		const same = dispatchSnapshotDigest(
			buildDispatchSnapshot({ ...SPEC, env: { A: '1', B: '2' } }, { provider: 'p' })
		);
		expect(same).toBe(a);
		for (const changed of [
			{ ...SPEC, args: ['--print', 'bye'] },
			{ ...SPEC, env: { ...SPEC.env, A: 'x' } },
			{ ...SPEC, cwd: '/elsewhere' },
			{ ...SPEC, command: '/bin/other' },
		]) {
			expect(dispatchSnapshotDigest(buildDispatchSnapshot(changed, { provider: 'p' }))).not.toBe(a);
		}
		expect(dispatchSnapshotDigest(buildDispatchSnapshot(SPEC, { provider: 'q' }))).not.toBe(a);
	});
});

describe('local host authority', () => {
	it('admits on allow and mints a lease bound to the snapshot digest', async () => {
		const { auth } = authority(() => ALLOW);
		const snapshot = buildDispatchSnapshot(SPEC, { provider: 'claude-code' });
		const outcome = await auth.admit({
			context: verified(),
			snapshot,
			policy: { sources: [], policyRevision: 3 },
		});
		expect(outcome.state).toBe('admitted');
		if (outcome.state !== 'admitted') return;
		expect(outcome.lease).toMatchObject({
			leaseId: 'lease-1',
			authorityId: 'auth',
			snapshotDigest: dispatchSnapshotDigest(snapshot),
			actor: { kind: 'human', id: 'alice' },
			policyRevision: 3,
			attemptId: 'att-1',
			effects: ['launch'],
		});
		expect(outcome.lease.state()).toBe('issued');
		expect(auth.check(outcome.lease, dispatchSnapshotDigest(snapshot))).toEqual({ ok: true });
		expect(auth.live()).toHaveLength(1);
	});

	it('keeps denied, unavailable and unknown apart, and a throwing reader is unavailable', async () => {
		const table: Record<string, PolicyDecision> = {
			deny: { decision: 'deny', reason: 'not on the allowlist', policyRevision: 4 },
			gone: { decision: 'unavailable', reason: 'endpoint unreachable' },
			lost: { decision: 'unknown', reason: 'answer lost after dispatch' },
		};
		const { auth } = authority((request) => {
			if (request.snapshot.args[1] === 'throw') throw new Error('reader crashed');
			return table[request.snapshot.args[1]];
		});
		const ask = (word: string) =>
			auth.admit({
				context: verified(),
				snapshot: buildDispatchSnapshot({ ...SPEC, args: ['--print', word] }, { provider: 'p' }),
				policy: { sources: [], policyRevision: 3 },
			});
		expect(await ask('deny')).toEqual({
			state: 'denied',
			code: 'policy-denied',
			message: 'not on the allowlist',
			policyRevision: 4,
		});
		expect(await ask('gone')).toMatchObject({ state: 'unavailable', code: 'runtime-unavailable' });
		expect(await ask('lost')).toMatchObject({ state: 'unknown', code: 'outcome-unknown' });
		expect(await ask('throw')).toMatchObject({
			state: 'unavailable',
			message: expect.stringContaining('reader crashed'),
		});
		expect(auth.live()).toEqual([]);
	});

	it('refuses an unverified context before asking the policy at all', async () => {
		let asked = 0;
		const { auth } = authority(() => {
			asked += 1;
			return ALLOW;
		});
		const outcome = await auth.admit({
			context: { ...verified() },
			snapshot: buildDispatchSnapshot(SPEC, { provider: 'p' }),
			policy: { sources: [], policyRevision: null },
		});
		expect(outcome).toMatchObject({ state: 'denied', code: 'unauthenticated' });
		expect(asked).toBe(0);
	});

	it('fails the sink check for a forged, expired, mismatched, bound, released or revoked lease', async () => {
		const { auth, tick } = authority(() => ALLOW);
		const digest = dispatchSnapshotDigest(buildDispatchSnapshot(SPEC, { provider: 'claude-code' }));

		const forged = { ...(await admitted(auth)) } as DispatchLease;
		expect(auth.check(forged, digest)).toEqual({ ok: false, reason: 'forged' });

		const other = await admitted(auth);
		expect(auth.check(other, 'another digest')).toEqual({ ok: false, reason: 'snapshot-mismatch' });

		const stale = await admitted(auth);
		tick(101);
		expect(stale.state()).toBe('expired');
		expect(auth.check(stale, digest)).toEqual({ ok: false, reason: 'expired' });
		expect(auth.live().map((lease) => lease.leaseId)).not.toContain(stale.leaseId);

		const bound = await admitted(auth);
		bound.bind(42);
		expect(bound.pid()).toBe(42);
		expect(auth.check(bound, digest)).toEqual({ ok: false, reason: 'already-bound' });
		expect(() => bound.bind(43)).toThrow(/cannot be bound/);

		bound.release({ outcome: 'exited', exitCode: 0, signal: null });
		expect(auth.check(bound, digest)).toEqual({ ok: false, reason: 'released' });
		expect(bound.ended()).toEqual({
			state: 'released',
			reason: null,
			release: { outcome: 'exited', exitCode: 0, signal: null },
		});

		const revoked = await admitted(auth);
		const heard: string[] = [];
		revoked.onRevoked((reason) => heard.push(reason));
		expect(auth.revoke(revoked.leaseId, 'policy changed')).toBe(true);
		expect(auth.revoke(revoked.leaseId, 'again')).toBe(false);
		expect(heard).toEqual(['policy changed']);
		expect(auth.check(revoked, digest)).toEqual({ ok: false, reason: 'revoked' });
		// A revoked lease stays revoked: a late release does not rewrite it.
		revoked.release({ outcome: 'stopped', by: 'authority' });
		expect(revoked.ended()).toMatchObject({ state: 'revoked', reason: 'policy changed' });
	});

	it('revokes every live lease at once and reports how many', async () => {
		const { auth } = authority(() => ALLOW);
		await admitted(auth);
		const bound = await admitted(auth);
		bound.bind(1);
		expect(auth.revokeAll('host fenced')).toBe(2);
		expect(auth.live()).toEqual([]);
		expect(auth.revokeAll('again')).toBe(0);
	});

	it('answers unavailable for everything when no authority is reachable', async () => {
		const none = unavailableAuthority('no endpoint');
		expect(
			await none.admit({
				context: verified(),
				snapshot: buildDispatchSnapshot(SPEC, { provider: 'p' }),
				policy: { sources: [], policyRevision: null },
			})
		).toEqual({ state: 'unavailable', code: 'runtime-unavailable', message: 'no endpoint' });
		const { auth } = authority(() => ALLOW);
		expect(none.check(await admitted(auth), 'x')).toEqual({ ok: false, reason: 'forged' });
		expect(none.revoke('lease-1', 'x')).toBe(false);
	});
});

describe('managed binding', () => {
	function dirs() {
		const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-binding-'));
		const productionDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-binding-prod-'));
		return { userDataDir, productionDataDir };
	}
	const okFence = () => ({ ok: true as const });
	const enrollment = {
		installationId: 'inst',
		authorityId: 'auth',
		endpointRef: 'endpoint-1',
		policySources: [{ id: 'ep', kind: 'endpoint' as const, revision: 3 }],
		policyRevision: 3,
	};

	it('starts standalone, enrolls under the lock, and persists across a new binding object', async () => {
		const paths = dirs();
		const { auth } = authority(() => ALLOW);
		const binding = createManagedBinding({ paths, fence: okFence, authority: auth, now: () => 0 });
		expect(binding.state()).toEqual({ state: 'standalone', files: managedBindingFiles(paths) });
		expect(binding.authority()).toBe(auth);

		const enrolled = await binding.enroll(enrollment);
		expect(enrolled.ok).toBe(true);
		expect(binding.state()).toMatchObject({ state: 'enrolled', record: { authorityId: 'auth' } });
		expect(binding.authority()).toBe(auth);
		expect(await binding.enroll(enrollment)).toMatchObject({
			ok: false,
			reason: 'already-enrolled',
		});

		const file = path.join(paths.userDataDir, 'maestro-managed-binding.json');
		const read = readManagedBindingFile(file);
		expect(read.status).toBe('ok');
		if (read.status !== 'ok') return;
		expect(read.record.digest).toBe(bindingDigest({ ...read.record }));
		// Closing everything and coming back finds the same enrollment.
		const again = createManagedBinding({ paths, fence: okFence, authority: auth, now: () => 0 });
		expect(again.state().state).toBe('enrolled');
	});

	it('runs enrolled-unavailable with no authority or another one, never standalone', async () => {
		const paths = dirs();
		const { auth } = authority(() => ALLOW);
		await createManagedBinding({ paths, fence: okFence, authority: auth, now: () => 0 }).enroll(
			enrollment
		);
		const none = createManagedBinding({ paths, fence: okFence, now: () => 0 });
		expect(none.state()).toMatchObject({ state: 'enrolled-unavailable' });
		expect(none.authority().authorityId).toBe('unavailable');
		const other = createLocalHostAuthority({
			authorityId: 'someone-else',
			decide: () => ALLOW,
			now: () => 0,
			newId: () => 'x',
		});
		const mismatched = createManagedBinding({
			paths,
			fence: okFence,
			authority: other,
			now: () => 0,
		});
		expect(mismatched.state()).toMatchObject({
			state: 'enrolled-unavailable',
			reason: expect.stringContaining('someone-else'),
		});
		expect(mismatched.authority().authorityId).toBe('unavailable');
	});

	it('keeps an alternate data directory under an enrolled production directory enrolled', async () => {
		const paths = dirs();
		const { auth } = authority(() => ALLOW);
		await createManagedBinding({ paths, fence: okFence, authority: auth, now: () => 0 }).enroll(
			enrollment
		);
		const alternate = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-binding-alt-'));
		const viaProduction = createManagedBinding({
			paths: { userDataDir: alternate, productionDataDir: paths.userDataDir },
			fence: okFence,
			now: () => 0,
		});
		expect(viaProduction.state()).toMatchObject({
			state: 'enrolled-unavailable',
			file: path.join(paths.userDataDir, 'maestro-managed-binding.json'),
		});
		// Unenrolling from the alternate directory is refused: the record is not its own.
		expect(await viaProduction.unenroll({ installationId: 'inst' })).toMatchObject({
			ok: false,
			reason: 'installation-mismatch',
		});
	});

	it('fails closed on a lost lock and an unreadable record', async () => {
		const paths = dirs();
		const { auth } = authority(() => ALLOW);
		let lost = false;
		const fence = () =>
			lost ? { ok: false as const, reason: 'taken over' } : { ok: true as const };
		const binding = createManagedBinding({ paths, fence, authority: auth, now: () => 0 });
		lost = true;
		expect(await binding.enroll(enrollment)).toMatchObject({ ok: false, reason: 'lock-lost' });
		expect(binding.authority().authorityId).toBe('unavailable');
		lost = false;
		expect((await binding.enroll(enrollment)).ok).toBe(true);
		lost = true;
		expect(await binding.unenroll({ installationId: 'inst' })).toMatchObject({
			ok: false,
			reason: 'lock-lost',
		});
		lost = false;

		fs.writeFileSync(path.join(paths.userDataDir, 'maestro-managed-binding.json'), '{"nope":');
		expect(binding.reload()).toMatchObject({ state: 'unreadable' });
		expect(binding.authority().authorityId).toBe('unavailable');
		expect(await binding.enroll(enrollment)).toMatchObject({ ok: false, reason: 'unreadable' });

		const record = JSON.parse(
			JSON.stringify({
				...enrollment,
				contractVersion: MANAGED_CONTRACT_VERSION,
				enrolledAt: 'now',
			})
		);
		record.digest = 'tampered';
		fs.writeFileSync(
			path.join(paths.userDataDir, 'maestro-managed-binding.json'),
			JSON.stringify(record)
		);
		expect(binding.reload()).toMatchObject({
			state: 'unreadable',
			reason: expect.stringContaining('digest does not match'),
		});
	});

	it('unenrolls only by the exact installation id, and only explicitly', async () => {
		const paths = dirs();
		const { auth } = authority(() => ALLOW);
		const binding = createManagedBinding({ paths, fence: okFence, authority: auth, now: () => 0 });
		expect(await binding.unenroll({ installationId: 'inst' })).toMatchObject({
			ok: false,
			reason: 'not-enrolled',
		});
		await binding.enroll(enrollment);
		expect(await binding.unenroll({ installationId: 'other' })).toMatchObject({
			ok: false,
			reason: 'installation-mismatch',
		});
		expect(binding.state().state).toBe('enrolled');
		expect((await binding.unenroll({ installationId: 'inst' })).ok).toBe(true);
		expect(binding.state().state).toBe('standalone');
	});
});

describe('run journal', () => {
	function journal(dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-journal-'))) {
		let ids = 0;
		let now = 1_000;
		const file = path.join(dir, 'maestro-managed-runs.json');
		const make = () =>
			createRunJournal({ file, now: () => now, newId: () => `run-${++ids}`, maxRuns: 3 });
		return { file, make, tick: (ms: number) => (now += ms) };
	}
	const submission = {
		idempotencyKey: 'k1',
		requestId: 'q1',
		attemptId: 'a1',
		runId: null,
		rootRunId: null,
		parentRunId: null,
		agentId: 'agent',
		tabId: 'tab',
		providerId: 'claude-code',
		contentSha256: 'digest-1',
		resourceIds: ['res-1'],
		actor: { kind: 'service' as const, id: 'fleet' },
		traceId: 'trace',
	};

	it('refuses to act before it is loaded', async () => {
		const { make } = journal();
		await expect(make().submit(submission)).rejects.toThrow(/not loaded/);
	});

	it('accepts once, replays the same key and content, and refuses different content', async () => {
		const { make, file } = journal();
		const j = make();
		expect(await j.load()).toEqual({ ok: true, runs: 0, recovered: { unknown: 0, failed: 0 } });
		const first = await j.submit(submission);
		expect(first).toMatchObject({
			disposition: 'accepted',
			run: { runId: 'run-1', rootRunId: 'run-1', state: 'queued', resourceIds: ['res-1'] },
			attempt: { attemptId: 'a1', phase: 'queued', queuedAt: '1970-01-01T00:00:01.000Z' },
		});
		expect(await j.submit({ ...submission, requestId: 'q2', attemptId: 'a2' })).toMatchObject({
			disposition: 'replayed',
			run: { runId: 'run-1', attempts: [{ attemptId: 'a1' }] },
		});
		expect(await j.submit({ ...submission, contentSha256: 'digest-2' })).toMatchObject({
			disposition: 'conflict',
		});
		expect(
			await j.submit({ ...submission, idempotencyKey: 'k2', runId: 'run-1', contentSha256: 'x' })
		).toMatchObject({ disposition: 'conflict' });
		expect(JSON.parse(fs.readFileSync(file, 'utf-8')).runs).toHaveLength(1);
	});

	it('moves an attempt through dispatched and terminal, and keeps the first cancel owner', async () => {
		const { make } = journal();
		const j = make();
		await j.load();
		await j.submit(submission);
		expect(await j.markDispatched('run-1', 'a1', { pid: 77, leaseId: 'lease-1' })).toMatchObject({
			state: 'running',
			attempts: [{ phase: 'dispatched', pid: 77, leaseId: 'lease-1' }],
		});
		expect(await j.markDispatched('nope', 'a1', { pid: 1, leaseId: null })).toBeNull();

		const owner = { kind: 'human' as const, id: 'alice' };
		expect(await j.requestCancel('run-1', { owner, kind: 'cancel' })).toMatchObject({
			outcome: 'requested',
			run: { cancellation: { owner, kind: 'cancel', alsoRequestedBy: [] } },
		});
		const later = await j.requestCancel('run-1', {
			owner: { kind: 'service', id: 'bob' },
			kind: 'interrupt',
		});
		expect(later.run?.cancellation).toMatchObject({
			owner,
			kind: 'cancel',
			alsoRequestedBy: [{ kind: 'service', id: 'bob' }],
		});

		expect(
			await j.markTerminal('run-1', 'a1', {
				outcome: 'cancelled',
				detail: 'stopped',
				providerSessionId: 'sess-9',
			})
		).toMatchObject({ state: 'cancelled', providerSessionId: 'sess-9' });
		expect(await j.requestCancel('run-1', { owner, kind: 'cancel' })).toMatchObject({
			outcome: 'already-terminal',
		});
		expect(await j.requestCancel('missing', { owner, kind: 'cancel' })).toEqual({
			outcome: 'unknown',
			run: null,
		});
		// Terminal is final: a late unknown does not rewrite it.
		expect((await j.markUnknown('run-1', 'a1', 'late'))?.state).toBe('cancelled');
		expect(j.open()).toEqual([]);
	});

	it('recovers a restart: dispatched becomes unknown, queued becomes failed, and unknown is never resent', async () => {
		const { make } = journal();
		const first = make();
		await first.load();
		await first.submit(submission);
		await first.markDispatched('run-1', 'a1', { pid: 5, leaseId: 'lease' });
		await first.submit({
			...submission,
			idempotencyKey: 'k2',
			attemptId: 'a2',
			contentSha256: 'd2',
		});
		await first.submit({
			...submission,
			idempotencyKey: 'k3',
			attemptId: 'a3',
			contentSha256: 'd3',
		});
		await first.markDispatched('run-3', 'a3', { pid: 6, leaseId: 'lease-3' });

		// run-3's process is still known to the registry; run-1's is not.
		const second = make();
		expect(await second.load({ liveRunIds: ['run-3'] })).toEqual({
			ok: true,
			runs: 3,
			recovered: { unknown: 1, failed: 1 },
		});
		expect(second.get('run-1')).toMatchObject({
			state: 'unknown',
			attempts: [{ phase: 'unknown' }],
		});
		expect(second.get('run-2')).toMatchObject({
			state: 'failed',
			attempts: [{ outcome: 'failed' }],
		});
		expect(second.get('run-3')).toMatchObject({ state: 'running' });
		expect(await second.submit(submission)).toMatchObject({ disposition: 'unknown' });
		expect(
			await second.requestCancel('run-1', { owner: { kind: 'human', id: 'a' }, kind: 'cancel' })
		).toMatchObject({ outcome: 'unknown' });
		// The recovery was written down, so a third load sees it without redoing it.
		const third = make();
		expect(await third.load({ liveRunIds: ['run-3'] })).toMatchObject({
			recovered: { unknown: 0, failed: 0 },
		});
	});

	it('pages newest first by cursor, scoped to an agent, and keeps open runs when trimming', async () => {
		const { make } = journal();
		const j = make();
		await j.load();
		for (const n of [1, 2, 3, 4]) {
			await j.submit({
				...submission,
				idempotencyKey: `k${n}`,
				attemptId: `a${n}`,
				contentSha256: `d${n}`,
				agentId: n % 2 ? 'odd' : 'even',
			});
			if (n < 4) await j.markTerminal(`run-${n}`, `a${n}`, { outcome: 'completed' });
		}
		// maxRuns is 3: the oldest terminal run went; the open one stayed.
		expect(j.list({ cursor: null, limit: 10 }).items.map((run) => run.runId)).toEqual([
			'run-4',
			'run-3',
			'run-2',
		]);
		const page = j.list({ cursor: null, limit: 2 });
		expect(page.items.map((run) => run.runId)).toEqual(['run-4', 'run-3']);
		expect(page.nextCursor).toBe('run-3');
		expect(j.list({ cursor: 'run-3', limit: 2 })).toMatchObject({
			items: [{ runId: 'run-2' }],
			nextCursor: null,
		});
		expect(j.list({ agentId: 'even', cursor: null, limit: 10 }).items.map((r) => r.runId)).toEqual([
			'run-4',
			'run-2',
		]);
		expect(j.open().map((run) => run.runId)).toEqual(['run-4']);
	});

	it('reports a corrupt file instead of starting empty over it', async () => {
		const { make, file } = journal();
		fs.writeFileSync(file, '{"runs": [');
		expect(await make().load()).toMatchObject({ ok: false, reason: 'corrupt', file });
		expect(fs.readFileSync(file, 'utf-8')).toBe('{"runs": [');
	});
});
