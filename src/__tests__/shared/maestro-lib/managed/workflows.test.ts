/**
 * Durable workflow ownership (MRC-07-06): the CP-03 owner/epoch/fence contract
 * consumed from the Maestro side. The producer is a declared double (a table of
 * answers in the endpoint's own shapes); the store is the real one on disk.
 * What is defended: nothing here mints a fence, what the registry answers is
 * what is held, a retry and a restart re-claim with it, a fenced or unknown
 * holder answers no fence, an offline-enabled holder keeps the fence it was
 * issued, and a missing producer is refused by name.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	MANAGED_WORKFLOWS_FILE_NAME,
	UNISSUED_OWNER_EPOCH,
	createWorkflowOwnership,
	workflowEndpointId,
	type WorkflowOwnerLifecyclePort,
	type WorkflowOwnerPort,
	type WorkflowOwnerStanding,
} from '../../../../shared/maestro-lib/managed/workflows';

const WORKFLOW = {
	workflowId: 'cue-pipeline:Nightly QA',
	version: 'v1',
	triggerEventId: 'time.scheduled:evt-1',
};
const OTHER = {
	workflowId: 'playbook:/work/docs',
	version: 'docs-2-abc',
	triggerEventId: 'operator:1',
};
const RUN = { runId: '6f1c2c1e-0000-4000-8000-000000000001', attemptId: 'attempt-1' };
const RETRY = { runId: RUN.runId, attemptId: 'attempt-2' };
const STANDING: WorkflowOwnerStanding = {
	ownerId: 'inst-1',
	authorityId: 'endpoint-a',
	policyRevision: 7,
};

describe('workflow ownership', () => {
	let dir: string;
	let file: string;
	let now = Date.parse('2026-10-21T12:00:00Z');
	let standing: WorkflowOwnerStanding | null = STANDING;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-workflows-'));
		file = path.join(dir, MANAGED_WORKFLOWS_FILE_NAME);
		now = Date.parse('2026-10-21T12:00:00Z');
		standing = STANDING;
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	function ownership(port: WorkflowOwnerPort | null, newId = () => 'proposed-nonce') {
		return createWorkflowOwnership({
			file,
			port: () => port,
			owner: () => standing,
			now: () => now,
			newId,
		});
	}

	describe('negotiated lifecycle custody', () => {
		const signals: AbortController[] = [];
		afterEach(() => {
			signals.splice(0).forEach((s) => s.abort());
			vi.useRealTimers();
		});
		function producer() {
			const signal = new AbortController();
			signals.push(signal);
			const invoke = vi.fn<WorkflowOwnerLifecyclePort['invoke']>(
				async (action, input, prior, owner) => {
					expect(JSON.parse(fs.readFileSync(file, 'utf8')).workflows[0]).toMatchObject({
						state: 'unknown',
						pending: action,
					});
					return {
						status: 'ok',
						payload: {
							outcome: { claim: 'owned', renew: 'renewed', release: 'released' }[action],
							workflowId: workflowEndpointId(input.workflow.workflowId),
							ownerId: owner.ownerId,
							ownerEpoch: typeof prior?.ownerEpoch === 'string' ? prior.ownerEpoch : 'opaque-epoch',
							fencingToken: 'server-fence',
							expiresAt: new Date(now + 10_000).toISOString(),
						},
					};
				}
			);
			const port: WorkflowOwnerPort = {
				lifecycle: { signal: signal.signal, current: () => true, invoke },
			};
			return { port, invoke, signal, store: ownership(port) };
		}
		async function claim(store: ReturnType<typeof ownership>, run = RUN) {
			const result = await store.claim({ workflow: WORKFLOW, ...run, offlineEnabled: true });
			if (result.state !== 'owned' || !result.fence.lifetime)
				throw new Error(JSON.stringify(result));
			return result.fence.lifetime;
		}
		it('persists opaque custody, reclaims on restart and releases only on producer acknowledgment', async () => {
			const { port, invoke, store } = producer();
			await claim(store);
			const restarted = ownership(port);
			await restarted.load();
			expect(restarted.fence(WORKFLOW)).toBeNull();
			const lifetime = await claim(restarted, RETRY);
			expect(invoke.mock.calls[1][2]).toMatchObject({
				ownerEpoch: 'opaque-epoch',
				fencingToken: 'server-fence',
			});
			await lifetime.finish('applied');
			expect(restarted.held()[0].state).toBe('released');
			expect(lifetime.signal.aborted).toBe(true);
		});
		it('renews the same live signal, then stops it when the producer fences the owner', async () => {
			vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
			const { invoke, store } = producer();
			const lifetime = await claim(store);
			now += 5000;
			await vi.advanceTimersByTimeAsync(5000);
			await vi.waitFor(() => expect(store.held()[0].confirmedAt).toBe(new Date(now).toISOString()));
			expect(invoke.mock.calls[1][0]).toBe('renew');
			expect(lifetime.signal.aborted).toBe(false);
			invoke.mockResolvedValue({ status: 'denied', reason: 'owner_unfenced' });
			now += 5000;
			await vi.advanceTimersByTimeAsync(5000);
			await vi.waitFor(() => expect(lifetime.signal.aborted).toBe(true));
			expect(store.fence(WORKFLOW)).toBeNull();
		});
		it.each(['unknown', 'unavailable', 'throw'] as const)(
			'retains lost release custody for restart: %s',
			async (status) => {
				const { invoke, port, store } = producer();
				const lifetime = await claim(store);
				invoke.mockImplementation(async () => {
					if (status === 'throw') throw new Error('lost');
					return status === 'unknown'
						? { status, message: 'lost' }
						: { status, reason: 'transport', message: 'offline' };
				});
				await lifetime.finish('uncertain');
				expect(store.held()[0]).toMatchObject({
					state: 'unknown',
					pending: 'release',
					ownerEpoch: 'opaque-epoch',
				});
				const restarted = ownership(port);
				await restarted.load();
				expect(restarted.fence(WORKFLOW)).toBeNull();
				expect((await restarted.claim({ workflow: WORKFLOW, ...RETRY })).state).toBe('unknown');
				expect(invoke.mock.calls.at(-1)?.[2]).toMatchObject({ pending: 'release' });
			}
		);
		it('keeps a lost first claim intent and claims nothing without a lifecycle port', async () => {
			const { invoke, port, store } = producer();
			invoke.mockResolvedValue({ status: 'unknown', message: 'lost' });
			expect((await store.claim({ workflow: WORKFLOW, ...RUN })).state).toBe('unknown');
			expect(store.held()[0]).toMatchObject({ pending: 'claim', lastAttemptId: RUN.attemptId });
			port.lifecycle = null;
			expect((await ownership(port).claim({ workflow: WORKFLOW, ...RETRY })).state).toBe(
				'unavailable'
			);
		});
		it('revokes active custody on authenticated connection loss and rejects stale release handles', async () => {
			const { invoke, signal, store } = producer();
			const old = await claim(store);
			const latest = await claim(store, RETRY);
			await old.finish('no_effect');
			expect(invoke).toHaveBeenCalledTimes(2);
			expect(latest.current()).toBe(true);
			signal.abort();
			expect(old.signal.aborted).toBe(true);
			expect(store.fence(WORKFLOW)).toBeNull();
		});
		it('expires an active fence while renewal is unanswered', async () => {
			vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
			const { invoke, store } = producer();
			const lifetime = await claim(store);
			invoke.mockImplementation(() => new Promise(() => {}));
			now += 10_000;
			await vi.advanceTimersByTimeAsync(10_000);
			expect(lifetime.signal.aborted).toBe(true);
			expect(store.fence(WORKFLOW)).toBeNull();
			expect(store.held()[0].state).not.toBe('released');
			await lifetime.finish('uncertain');
		});
		it('rejects owner changes across an awaited claim', async () => {
			const { invoke, store } = producer();
			const original = invoke.getMockImplementation()!;
			invoke.mockImplementation(async (...args) => {
				const result = await original(...args);
				standing = { ...STANDING, ownerId: 'another' };
				return result;
			});
			expect((await store.claim({ workflow: WORKFLOW, ...RUN })).state).toBe('unknown');
			expect(store.fence(WORKFLOW)).toBeNull();
		});

		describe('workflow and delegation recovery (MCOMP-17-04)', () => {
			it('a scoped delegated claim hands the producer the whole input and holds only what it answered', async () => {
				const { invoke, store } = producer();
				const lifetime = await claim(store);
				expect(invoke).toHaveBeenCalledTimes(1);
				const [action, input, prior, owner] = invoke.mock.calls[0];
				expect(action).toBe('claim');
				expect(input).toEqual({ workflow: WORKFLOW, ...RUN, offlineEnabled: true });
				expect(prior).toBeNull();
				expect(owner).toEqual(STANDING);
				expect(store.held()).toHaveLength(1);
				expect(store.held()[0]).toMatchObject({
					endpointWorkflowId: workflowEndpointId(WORKFLOW.workflowId),
					ownerId: STANDING.ownerId,
					authorityId: STANDING.authorityId,
					ownerEpoch: 'opaque-epoch',
					fencingToken: 'server-fence',
					lastRunId: RUN.runId,
					lastAttemptId: RUN.attemptId,
					offlineEnabled: false,
					state: 'held',
				});
				expect(store.held()[0].pending).toBeUndefined();
				expect(store.fence(WORKFLOW)).toEqual({
					ownerId: 'inst-1',
					ownerEpoch: 'opaque-epoch',
					fencingToken: 'server-fence',
				});
				expect(store.fence(OTHER)).toBeNull();
				expect(lifetime.current()).toBe(true);
			});

			it('a replayed attempt confirms the issued fence on the same live signal and keeps one record', async () => {
				const { invoke, store } = producer();
				const first = await claim(store);
				const replay = await store.claim({ workflow: WORKFLOW, ...RUN, offlineEnabled: true });
				expect(replay).toMatchObject({ state: 'owned', disposition: 'confirmed' });
				if (replay.state !== 'owned') throw new Error('replay not owned');
				expect(replay.fence.lifetime?.signal).toBe(first.signal);
				expect(invoke.mock.calls[1][2]).toMatchObject({
					ownerEpoch: 'opaque-epoch',
					fencingToken: 'server-fence',
				});
				expect(first.signal.aborted).toBe(false);
				expect(store.held()).toHaveLength(1);
			});

			it('a stale grant on renewal (a rotated fence) stops the live signal and keeps the held values for reconciliation', async () => {
				vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
				const { invoke, store } = producer();
				const lifetime = await claim(store);
				invoke.mockImplementation(async (_action, input, _prior, owner) => ({
					status: 'ok',
					payload: {
						outcome: 'renewed',
						workflowId: workflowEndpointId(input.workflow.workflowId),
						ownerId: owner.ownerId,
						ownerEpoch: 'opaque-epoch',
						fencingToken: 'rotated-fence',
						expiresAt: new Date(now + 10_000).toISOString(),
					},
				}));
				now += 5000;
				await vi.advanceTimersByTimeAsync(5000);
				await vi.waitFor(() => expect(lifetime.signal.aborted).toBe(true));
				expect(invoke.mock.calls[1][0]).toBe('renew');
				expect(store.fence(WORKFLOW)).toBeNull();
				expect(store.held()[0]).toMatchObject({
					state: 'unknown',
					pending: 'renew',
					fencingToken: 'server-fence',
				});
			});

			it.each([
				['already expired', -1],
				['beyond the renewal window', 300_001],
			] as const)('a receipt %s issues no fence', async (_label, offset) => {
				const { invoke, store } = producer();
				invoke.mockImplementation(async (_action, input, _prior, owner) => ({
					status: 'ok',
					payload: {
						outcome: 'owned',
						workflowId: workflowEndpointId(input.workflow.workflowId),
						ownerId: owner.ownerId,
						ownerEpoch: 'opaque-epoch',
						fencingToken: 'server-fence',
						expiresAt: new Date(now + offset).toISOString(),
					},
				}));
				const result = await store.claim({ workflow: WORKFLOW, ...RUN, offlineEnabled: true });
				expect(result).toMatchObject({ state: 'unknown', code: 'outcome-unknown' });
				expect(store.fence(WORKFLOW)).toBeNull();
				expect(store.held()[0]).toMatchObject({ state: 'unknown', pending: 'claim' });
			});

			it('two installations contend: the producer fences the second, which holds nothing until the first releases', async () => {
				let holder: string | null = null;
				let epoch = 0;
				const registry = vi.fn<WorkflowOwnerLifecyclePort['invoke']>(
					async (action, input, prior, owner) => {
						if (action === 'release') {
							if (holder === owner.ownerId) holder = null;
						} else if (holder && holder !== owner.ownerId) {
							return { status: 'denied', reason: 'owner_unfenced' };
						} else if (!holder) {
							holder = owner.ownerId;
							epoch += 1;
						}
						return {
							status: 'ok',
							payload: {
								outcome: { claim: 'owned', renew: 'renewed', release: 'released' }[action],
								workflowId: workflowEndpointId(input.workflow.workflowId),
								ownerId: owner.ownerId,
								ownerEpoch: action === 'release' ? prior?.ownerEpoch : `epoch-${epoch}`,
								fencingToken: action === 'release' ? prior?.fencingToken : `fence-${epoch}`,
								expiresAt: new Date(now + 10_000).toISOString(),
							},
						};
					}
				);
				const installation = (ownerId: string, at: string) => {
					const signal = new AbortController();
					signals.push(signal);
					const port: WorkflowOwnerPort = {
						lifecycle: { signal: signal.signal, current: () => true, invoke: registry },
					};
					return createWorkflowOwnership({
						file: path.join(dir, at),
						port: () => port,
						owner: () => ({ ...STANDING, ownerId }),
						now: () => now,
						newId: () => `${ownerId}-nonce`,
					});
				};
				const first = installation('inst-1', 'first.json');
				const second = installation('inst-2', 'second.json');
				const held = await claim(first);
				const contended = await second.claim({ workflow: WORKFLOW, ...RUN, offlineEnabled: true });
				expect(contended).toMatchObject({ state: 'denied', fenced: true });
				expect(second.fence(WORKFLOW)).toBeNull();
				expect(second.held()[0].state).toBe('fenced');
				expect(held.current()).toBe(true);
				expect(first.fence(WORKFLOW)).toEqual({
					ownerId: 'inst-1',
					ownerEpoch: 'epoch-1',
					fencingToken: 'fence-1',
				});

				await held.finish('applied');
				expect(first.fence(WORKFLOW)).toBeNull();
				expect(first.held()[0].state).toBe('released');
				const taken = await second.claim({ workflow: WORKFLOW, ...RETRY, offlineEnabled: true });
				expect(taken).toMatchObject({ state: 'owned', disposition: 'claimed' });
				expect(second.fence(WORKFLOW)).toEqual({
					ownerId: 'inst-2',
					ownerEpoch: 'epoch-2',
					fencingToken: 'fence-2',
				});
				expect(holder).toBe('inst-2');
			});

			it('an offline-enabled holder keeps nothing once the lifecycle authority is gone, and asks the producer nothing', async () => {
				const { invoke, port, store } = producer();
				const lifetime = await claim(store);
				expect(store.held()[0].offlineEnabled).toBe(false);
				port.lifecycle!.current = () => false;
				expect(lifetime.current()).toBe(false);
				expect(store.fence(WORKFLOW)).toBeNull();
				const result = await store.claim({ workflow: WORKFLOW, ...RETRY, offlineEnabled: true });
				expect(result).toMatchObject({ state: 'unavailable', code: 'runtime-unavailable' });
				expect(lifetime.signal.aborted).toBe(true);
				await lifetime.finish('uncertain');
				expect(invoke).toHaveBeenCalledTimes(1);
				expect(store.held()[0]).toMatchObject({ state: 'held', ownerEpoch: 'opaque-epoch' });
			});

			it('a lost renewal acknowledgment stops the signal; a restarted host reclaims the same fence', async () => {
				vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
				const { invoke, port, store } = producer();
				const original = invoke.getMockImplementation()!;
				const lifetime = await claim(store);
				invoke.mockResolvedValue({ status: 'unknown', message: 'lost' });
				now += 5000;
				await vi.advanceTimersByTimeAsync(5000);
				await vi.waitFor(() => expect(lifetime.signal.aborted).toBe(true));
				expect(store.fence(WORKFLOW)).toBeNull();
				expect(store.held()[0]).toMatchObject({ state: 'unknown', pending: 'renew' });

				invoke.mockImplementation(original);
				const restarted = ownership(port);
				await restarted.load();
				expect(restarted.fence(WORKFLOW)).toBeNull();
				const reclaimed = await restarted.claim({
					workflow: WORKFLOW,
					...RETRY,
					offlineEnabled: true,
				});
				expect(reclaimed).toMatchObject({ state: 'owned', disposition: 'confirmed' });
				expect(invoke.mock.calls.at(-1)?.[0]).toBe('claim');
				expect(invoke.mock.calls.at(-1)?.[2]).toMatchObject({
					pending: 'renew',
					ownerEpoch: 'opaque-epoch',
					fencingToken: 'server-fence',
				});
				expect(restarted.fence(WORKFLOW)).toEqual({
					ownerId: 'inst-1',
					ownerEpoch: 'opaque-epoch',
					fencingToken: 'server-fence',
				});
			});

			it.each(['withdrawn standing', 'another actor'] as const)(
				'a revoked actor (%s) stops the live fence and the producer is never asked for a child',
				async (revocation) => {
					const { invoke, store } = producer();
					const lifetime = await claim(store);
					standing =
						revocation === 'withdrawn standing' ? null : { ...STANDING, ownerId: 'inst-x' };
					expect(lifetime.current()).toBe(false);
					const child = await store.claim({ workflow: WORKFLOW, ...RETRY, offlineEnabled: true });
					expect(child).toMatchObject({ state: 'unavailable', code: 'runtime-unavailable' });
					expect(lifetime.signal.aborted).toBe(true);
					expect(store.fence(WORKFLOW)).toBeNull();
					expect(invoke).toHaveBeenCalledTimes(1);
				}
			);
		});
	});

	describe('the producer a host composes', () => {
		function lifecyclePort(
			answer: 'owned' | 'denied-policy' | 'denied-fenced' | 'foreign-owner' = 'owned'
		) {
			const signal = new AbortController();
			const invoke = vi.fn<WorkflowOwnerLifecyclePort['invoke']>(
				async (action, input, prior, owner) => {
					if (answer === 'denied-policy') return { status: 'denied', reason: 'policy_denied' };
					if (answer === 'denied-fenced') return { status: 'denied', reason: 'owner_unfenced' };
					return {
						status: 'ok',
						payload: {
							outcome: { claim: 'owned', renew: 'renewed', release: 'released' }[action],
							workflowId: workflowEndpointId(input.workflow.workflowId),
							ownerId: answer === 'foreign-owner' ? 'inst-2' : owner.ownerId,
							ownerEpoch:
								prior && prior.ownerEpoch !== UNISSUED_OWNER_EPOCH
									? prior.ownerEpoch
									: 'opaque-epoch',
							fencingToken: 'server-fence',
							expiresAt: new Date(now + 10_000).toISOString(),
						},
					};
				}
			);
			const port: WorkflowOwnerPort = {
				lifecycle: { signal: signal.signal, current: () => true, invoke },
			};
			return { port, invoke, store: ownership(port) };
		}

		it('with no standing or no policy generation, the claim is refused before the producer is asked', async () => {
			const { invoke, store } = lifecyclePort();
			standing = null;
			expect((await store.claim({ workflow: WORKFLOW, ...RUN })).state).toBe('unavailable');
			standing = { ...STANDING, policyRevision: null };
			expect((await store.claim({ workflow: WORKFLOW, ...RUN })).state).toBe('unavailable');
			expect(invoke).not.toHaveBeenCalled();
			expect(store.held()).toHaveLength(0);
		});

		it('an endpoint that serves no owner operation is capability-unsupported, and nothing is held', async () => {
			const store = ownership({ lifecycle: null, unserved: true });
			expect(await store.claim({ workflow: WORKFLOW, ...RUN })).toMatchObject({
				state: 'unavailable',
				code: 'capability-unsupported',
			});
			expect(store.held()).toHaveLength(0);
			expect(store.fence(WORKFLOW)).toBeNull();
		});

		it('with no producer attached, a claim names CP-03 and holds nothing', async () => {
			const store = ownership(null);
			expect(await store.claim({ workflow: WORKFLOW, ...RUN })).toMatchObject({
				state: 'unavailable',
				code: 'runtime-unavailable',
				message: expect.stringContaining('CP-03'),
			});
			expect(store.held()).toHaveLength(0);
		});

		it('a store that cannot be read refuses every claim rather than starting over', async () => {
			const { invoke, store, port } = lifecyclePort();
			fs.writeFileSync(file, '{ this is not json');
			expect(await store.claim({ workflow: WORKFLOW, ...RUN })).toMatchObject({
				state: 'unavailable',
				message: expect.stringMatching(/cannot be read/),
			});
			expect(invoke).not.toHaveBeenCalled();
			expect(port.lifecycle).not.toBeNull();
		});

		it('a record held under another authority is not a fence here, and a claim under this one is refused until it is released', async () => {
			const { store } = lifecyclePort();
			expect((await store.claim({ workflow: WORKFLOW, ...RUN })).state).toBe('owned');
			standing = { ...STANDING, authorityId: 'endpoint-b' };
			expect(store.fence(WORKFLOW)).toBeNull();
			expect(await store.claim({ workflow: WORKFLOW, ...RETRY })).toMatchObject({
				state: 'unavailable',
			});
		});

		it('a plain policy denial decides the claim and holds nothing', async () => {
			const { store } = lifecyclePort('denied-policy');
			expect(await store.claim({ workflow: WORKFLOW, ...RUN })).toMatchObject({
				state: 'denied',
				code: 'policy-denied',
				fenced: false,
				reason: 'policy_denied',
			});
			expect(store.held()).toHaveLength(0);
			expect(store.fence(WORKFLOW)).toBeNull();
		});

		it('an owner the producer fences is fenced: no fence until the producer says otherwise', async () => {
			const { store } = lifecyclePort('denied-fenced');
			expect(await store.claim({ workflow: WORKFLOW, ...RUN })).toMatchObject({
				state: 'denied',
				fenced: true,
			});
			expect(store.held()[0]).toMatchObject({ state: 'fenced' });
			expect(store.fence(WORKFLOW)).toBeNull();
		});

		it('a receipt that names another owner is unknown, never this installation fence', async () => {
			const { store } = lifecyclePort('foreign-owner');
			expect((await store.claim({ workflow: WORKFLOW, ...RUN })).state).not.toBe('owned');
			expect(store.fence(WORKFLOW)).toBeNull();
		});
	});
});
