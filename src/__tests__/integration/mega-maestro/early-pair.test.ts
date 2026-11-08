/**
 * The early pair, end to end on this host: a declared harmless program run
 * through the protected dispatch against an endpoint, with every effect
 * observed independently of what any receipt says.
 *
 * Two parts. The deterministic part uses a declared local PREPARED/1
 * producer and fake registration daemon with the real client, adapter,
 * bridge and spawn sink. The producer is test-only. This proves
 * local behavior: an allowed run leaves exactly its effects (a file in its
 * work directory, nothing on the wire, no descendant, no undeclared read); a
 * denial, a replay, a changed snapshot, a lost endpoint, a wrong runtime and
 * a lost answer each leave none. The local ledger contains the prepared
 * lease; a dropped session is unavailable until it is
 * re-registered. The real part runs the harness script against the real
 * endpoint when `check` says every producer is present and otherwise skips,
 * naming the dependency and its owner in the test title. Unit doubles close
 * nothing about the real pair; the harness does.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { dispatchHarness, type HarnessDispatchOutcome } from '../../../main/enterprise/dispatch';
import {
	buildDispatchSnapshot,
	createLocalHostAuthority,
} from '../../../shared/maestro-lib/managed/authority';
import { managedAuthorityId } from '../../../shared/maestro-lib/managed/host-adapter';
import {
	buildHarnessLaunchSpec,
	SYNTHETIC_HARNESS_PROVIDER,
	type HarnessRouteRequest,
} from '../../../shared/maestro-lib/managed/provider-route';
import {
	DispatchRefusedError,
	leaseAdmission,
	startTurn,
} from '../../../shared/maestro-lib/run/start-turn';
import {
	composePair,
	describePairSkip,
	PAIR_HARNESS_SCRIPT,
	PAIR_INSTALLATION,
	PAIR_POLICY_REVISION,
	PAIR_T0,
	readSyntheticEffects,
	runPairCheck,
	startEgressObserver,
	SYNTHETIC_EFFECTS_FILE,
	SYNTHETIC_PROVIDER_SOURCE,
	verifiedContext,
	type EgressObserver,
	type PairComposition,
} from './fixtures';

const RUN_TIMEOUT_MS = 20_000;

describe('early pair: the synthetic harness route through the protected dispatch', () => {
	let root: string;
	let pair: PairComposition;
	let observer: EgressObserver;
	let declared: string;
	let undeclared: string;
	let workDirs = 0;
	let clock: number;
	let decision: 'allow' | 'deny' | 'unavailable';
	let loseResponse: boolean;
	let producerCalls: number;

	beforeEach(async () => {
		root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'early-pair-')));
		declared = path.join(root, 'declared.txt');
		undeclared = path.join(root, 'undeclared.txt');
		fs.writeFileSync(declared, 'declared input');
		fs.writeFileSync(undeclared, 'not for the program');
		clock = PAIR_T0;
		decision = 'allow';
		loseResponse = false;
		producerCalls = 0;
		pair = await composePair({
			dir: root,
			now: () => clock,
			prepared: {
				actorId: 'user-pair',
				create: (identity) => {
					const authority = createLocalHostAuthority({
						authorityId: managedAuthorityId(identity),
						now: () => clock,
						newId: () => `fixture-lease-${producerCalls}`,
						leaseTtlMs: 1000,
						decide: () => ({
							decision,
							reason: 'fixture policy',
							policyRevision: PAIR_POLICY_REVISION,
						}),
					});
					return {
						...authority,
						version: 1,
						admit: async (request) => {
							producerCalls++;
							if (loseResponse) throw new Error('fixture lost preparation response');
							return authority.admit(request);
						},
					};
				},
			},
		});
		expect(await pair.attach()).toBe('ok');
		observer = await startEgressObserver();
	});
	afterEach(async () => {
		try {
			expect(observer.connections()).toBe(0);
			for (const dir of fs.readdirSync(root).filter((name) => name.startsWith('work-')))
				expect(fs.existsSync(path.join(root, dir, 'child.marker'))).toBe(false);
			expect(executionCalls()).toHaveLength(0);
		} finally {
			await observer?.close();
			await pair?.close();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	/** A fresh private work directory per run, so an absent effects file means nothing ran there. */
	function workDir(): string {
		const dir = path.join(root, `work-${++workDirs}`);
		fs.mkdirSync(dir);
		return dir;
	}

	function request(dir: string, overrides: Partial<HarnessRouteRequest> = {}): HarnessRouteRequest {
		return {
			script: SYNTHETIC_PROVIDER_SOURCE,
			inputs: [declared],
			workDir: dir,
			timeoutMs: 10_000,
			stdin: JSON.stringify({
				prompt: 'say hello',
				probePort: observer.port,
				declaredFile: declared,
				undeclaredFile: undeclared,
				childMarker: path.join(dir, 'child.marker'),
			}),
			...overrides,
		};
	}

	const executionCalls = () =>
		pair.fake.calls.filter((c) => (c.body as { operation?: string }).operation === 'execution');

	it(
		'allow: an admitted run leaves its effects in its work directory and nowhere else',
		async () => {
			const dir = workDir();
			const context = verifiedContext(pair.verifier, { actor: { kind: 'human', id: 'user-pair' } });
			const outcome = await dispatchHarness(pair.bridge, request(dir), { context });
			expect(outcome.status).toBe('ran');
			if (outcome.status !== 'ran') return;
			expect(outcome.exit.exitCode).toBe(0);
			expect(outcome.exit.spawnError).toBeUndefined();

			// Observed, not reported: the file is there, the listener heard nothing.
			const effects = readSyntheticEffects(dir);
			expect(effects).not.toBeNull();
			expect(effects).toMatchObject({
				cwd: dir,
				wroteFile: path.join(dir, SYNTHETIC_EFFECTS_FILE),
				connected: 'ERR_ACCESS_DENIED',
				spawnedChild: 'ERR_ACCESS_DENIED',
				readDeclared: true,
				readUndeclared: 'ERR_ACCESS_DENIED',
			});
			expect(effects!.stdinBytes).toBeGreaterThan(0);
			expect(observer.connections()).toBe(0);
			expect(fs.readdirSync(dir)).toEqual([SYNTHETIC_EFFECTS_FILE]);

			// The prepared producer authorizes locally; broker dispatch is never a launch permit.
			expect(producerCalls).toBe(1);
			expect(outcome.decision).toBeNull();
			expect(outcome.receipt?.effect).toMatchObject({
				state: 'released',
				release: { outcome: 'exited', exitCode: 0 },
			});
			expect(outcome.receipt?.effect.pid).toBe(effects!.pid);
		},
		RUN_TIMEOUT_MS
	);

	it(
		'prepared receipt: the owned lease joins the durable ledger without a broker decision',
		async () => {
			const dir = workDir();
			const outcome = await dispatchHarness(pair.bridge, request(dir), {
				context: verifiedContext(pair.verifier, { actor: { kind: 'human', id: 'user-pair' } }),
			});
			expect(outcome.status).toBe('ran');
			if (outcome.status !== 'ran') return;
			expect(outcome.decision).toBeNull();
			const joined = pair.bridge.receipt(outcome.leaseId);
			expect(joined?.leaseId).toBe(outcome.leaseId);
			expect(joined?.registration).toMatchObject({
				challengeId: 'challenge-pair',
				runtimeId: PAIR_INSTALLATION.runtimeId,
			});
			await pair.bridge.flush();
			const ledger = JSON.parse(fs.readFileSync(pair.ledgerFile, 'utf8')) as {
				receipts: Array<{ leaseId: string; decision: null; effect: { state: string } }>;
			};
			expect(ledger.receipts).toEqual([joined]);
			expect(joined?.effect.state).toBe('released');
		},
		RUN_TIMEOUT_MS
	);

	it(
		'deny before effect: a policy refusal, a replay and unavailable authority each run nothing',
		async () => {
			const expectNothingRan = (dir: string, outcome: HarnessDispatchOutcome) => {
				expect(readSyntheticEffects(dir)).toBeNull();
				expect(fs.readdirSync(dir)).toEqual([]);
				expect(outcome.status).not.toBe('ran');
			};

			decision = 'deny';
			const denied = workDir();
			const deniedOutcome = await dispatchHarness(pair.bridge, request(denied), {
				context: verifiedContext(pair.verifier, { actor: { kind: 'human', id: 'user-pair' } }),
			});
			expect(deniedOutcome).toMatchObject({ status: 'denied', code: 'policy-denied' });
			expectNothingRan(denied, deniedOutcome);

			// A consumed attempt cannot run again, even with a different work directory.
			decision = 'allow';
			const first = workDir();
			const identity = { requestId: 'req-replay', attemptId: 'att-replay', runId: 'run-replay' };
			const ran = await dispatchHarness(pair.bridge, request(first), {
				context: verifiedContext(pair.verifier, {
					actor: { kind: 'human', id: 'user-pair' },
					identity,
				}),
			});
			expect(ran.status).toBe('ran');
			expect(readSyntheticEffects(first)).not.toBeNull();
			const second = workDir();
			const replayed = await dispatchHarness(pair.bridge, request(second), {
				context: verifiedContext(pair.verifier, {
					actor: { kind: 'human', id: 'user-pair' },
					identity,
				}),
			});
			expect(replayed).toMatchObject({ status: 'denied', code: 'idempotency-conflict' });
			expectNothingRan(second, replayed);

			decision = 'unavailable';
			const unsupported = workDir();
			const noDecision = await dispatchHarness(pair.bridge, request(unsupported), {
				context: verifiedContext(pair.verifier, { actor: { kind: 'human', id: 'user-pair' } }),
			});
			expect(noDecision).toMatchObject({ status: 'unavailable', code: 'runtime-unavailable' });
			expectNothingRan(unsupported, noDecision);
			expect(observer.connections()).toBe(0);
		},
		RUN_TIMEOUT_MS
	);

	it.each(['input', 'policy', 'actor', 'expired', 'revoked', 'disconnect'] as const)(
		'holds changed %s at the spawn, before any effect',
		async (change) => {
			const dir = workDir();
			const admittedRequest = request(dir);
			const spec = buildHarnessLaunchSpec(admittedRequest);
			const attribution = {
				provider: SYNTHETIC_HARNESS_PROVIDER,
				model: 'synthetic',
				operation: 'start' as const,
				resourceIds: [declared],
			};
			const context = verifiedContext(pair.verifier, { actor: { kind: 'human', id: 'user-pair' } });
			const admitted = await pair.bridge.authority.admit({
				context,
				snapshot: buildDispatchSnapshot(spec, attribution),
				policy: pair.host.policy(),
			});
			expect(admitted.state).toBe('admitted');
			if (admitted.state !== 'admitted') return;
			const { lease } = admitted;

			const replaced = change === 'input' ? { ...spec, stdin: `${spec.stdin} ` } : spec;
			if (change === 'policy') pair.view.record!.policy.appliedRevision++;
			if (change === 'actor') context.actor.id = 'other-actor';
			if (change === 'expired') clock += 1001;
			if (change === 'revoked') pair.bridge.authority.revoke(lease.leaseId, 'fixture cancellation');
			if (change === 'disconnect') pair.port.redial();
			const refused = () =>
				startTurn(
					replaced,
					{},
					{
						admission: {
							gate: leaseAdmission(pair.bridge.authority, lease),
							attribution,
						},
						stopGraceMs: 100,
					}
				);
			expect(refused).toThrow(DispatchRefusedError);
			expect(lease.state()).toBe(
				change === 'input' ? 'issued' : change === 'expired' ? 'expired' : 'revoked'
			);
			expect(readSyntheticEffects(dir)).toBeNull();
			expect(fs.readdirSync(dir)).toEqual([]);
			expect(pair.bridge.receipt(lease.leaseId)?.effect.pid).toBeNull();
		}
	);

	it('wrong runtime: a context for another installation is refused by the verifier, and another runtime cannot attach', async () => {
		expect(() =>
			verifiedContext(pair.verifier, {
				installation: { ...PAIR_INSTALLATION, runtimeId: 'desktop-other' },
			})
		).toThrow(/another installation or runtime/);

		// The endpoint registered this process; a different runtime id on the same socket is unauthenticated.
		pair.port.redial();
		expect(await pair.attach({ ...PAIR_INSTALLATION, runtimeId: 'desktop-other' })).toBe(
			'attach denied unauthenticated'
		);
		const dir = workDir();
		const outcome = await dispatchHarness(pair.bridge, request(dir), {
			context: verifiedContext(pair.verifier, { actor: { kind: 'human', id: 'user-pair' } }),
		});
		expect(outcome).toMatchObject({ status: 'unavailable' });
		expect(readSyntheticEffects(dir)).toBeNull();
	});

	it(
		'offline and restart: a dropped endpoint session is unavailable until re-attached; the ledger survives a host restart',
		async () => {
			pair.fake.dropConnections();
			await vi.waitFor(() => expect(pair.port.state().attached).toBe(false));
			const dropped = workDir();
			const offline = await dispatchHarness(pair.bridge, request(dropped), {
				context: verifiedContext(pair.verifier, { actor: { kind: 'human', id: 'user-pair' } }),
			});
			expect(offline).toMatchObject({ status: 'unavailable' });
			expect(readSyntheticEffects(dropped)).toBeNull();
			expect(executionCalls()).toHaveLength(0);

			// The registration is the process's: a re-attach on a new connection restores the standing.
			expect(await pair.attach()).toBe('ok');
			const back = workDir();
			const again = await dispatchHarness(pair.bridge, request(back), {
				context: verifiedContext(pair.verifier, { actor: { kind: 'human', id: 'user-pair' } }),
			});
			expect(again.status).toBe('ran');
			expect(readSyntheticEffects(back)).not.toBeNull();

			// A second host over the same ledger reads the released receipt and recovers nothing as unknown.
			const restarted = await composePair({ dir: root, fake: { capabilities: ['execution'] } });
			try {
				expect(restarted.bridge.receipts()).toHaveLength(1);
				expect(restarted.bridge.receipts()[0]).toMatchObject({
					decision: null,
					effect: { state: 'released' },
				});
			} finally {
				await restarted.close();
			}
		},
		RUN_TIMEOUT_MS
	);

	it(
		'endpoint loss: an answer lost after the request left is unknown, a closed endpoint is unavailable; neither runs anything',
		async () => {
			loseResponse = true;
			const lost = workDir();
			const unknown = await dispatchHarness(pair.bridge, request(lost), {
				context: verifiedContext(pair.verifier, { actor: { kind: 'human', id: 'user-pair' } }),
			});
			expect(unknown).toMatchObject({ status: 'unknown', code: 'outcome-unknown' });
			expect(readSyntheticEffects(lost)).toBeNull();
			loseResponse = false;

			await pair.fake.close();
			await vi.waitFor(() => expect(pair.port.state().attached).toBe(false));
			const gone = workDir();
			const unavailable = await dispatchHarness(pair.bridge, request(gone), {
				context: verifiedContext(pair.verifier, { actor: { kind: 'human', id: 'user-pair' } }),
			});
			expect(unavailable).toMatchObject({ status: 'unavailable' });
			expect(readSyntheticEffects(gone)).toBeNull();
			expect(observer.connections()).toBe(0);
		},
		RUN_TIMEOUT_MS
	);

	it.each(['disconnect', 'unknown-settlement'] as const)(
		'%s after an observed effect stops the owned process and prevents replay',
		async (ending) => {
			const dir = workDir();
			const context = verifiedContext(pair.verifier, { actor: { kind: 'human', id: 'user-pair' } });
			const input = request(dir);
			input.stdin = JSON.stringify({ ...JSON.parse(input.stdin!), holdOpen: true });
			const controller = new AbortController();
			let observedPid: number | undefined;
			const outcome = await dispatchHarness(
				pair.bridge,
				input,
				{ context },
				{
					signal: controller.signal,
					stopGraceMs: 50,
					onStdout: () => {
						if (observedPid) return;
						const observed = readSyntheticEffects(dir);
						if (!observed) return;
						const lease = pair.bridge.authority.live()[0];
						observedPid = lease.pid();
						pair.port.redial();
						if (ending === 'disconnect') {
							// Reaching the next sink rechecks standing and revokes the running lease.
							pair.bridge.authority.check(lease, lease.snapshotDigest);
						} else {
							// Declared lost settlement; cleanup must not replace it with a successful exit.
							lease.release({ outcome: 'unknown', message: 'fixture settlement response lost' });
							controller.abort();
						}
					},
				}
			);
			expect(outcome.status).toBe('ran');
			if (outcome.status !== 'ran') throw new Error('Expected an owned process');
			expect(observedPid).toBeGreaterThan(0);
			expect(readSyntheticEffects(dir)?.pid).toBe(observedPid);
			expect(() => process.kill(observedPid!, 0)).toThrow();
			expect(pair.bridge.authority.live()).toHaveLength(0);
			expect(outcome.receipt?.effect).toMatchObject(
				ending === 'disconnect'
					? { state: 'revoked' }
					: { state: 'released', release: { outcome: 'unknown' } }
			);
			const ledger = JSON.parse(fs.readFileSync(pair.ledgerFile, 'utf8'));
			expect(ledger.receipts[0].effect).toEqual(outcome.receipt?.effect);
			expect(await pair.attach()).toBe('ok');
			const retryDir = workDir();
			expect(await dispatchHarness(pair.bridge, request(retryDir), { context })).toMatchObject({
				status: 'denied',
				code: 'idempotency-conflict',
			});
			expect(fs.readdirSync(retryDir)).toEqual([]);
			expect(producerCalls).toBe(1);
		},
		RUN_TIMEOUT_MS
	);
});

describe('early pair: the real endpoint through the harness script', () => {
	const report = runPairCheck();
	const blocked = report.assessment.ready ? '' : ` (blocked: ${describePairSkip(report)})`;

	it('reports every input of the pair with a named owner for whatever is missing', () => {
		expect(report.reportVersion).toBe(1);
		expect(report.library.status).toBeDefined();
		expect(report.linuxHost.image.ref).toMatch(/^node@sha256:[a-f0-9]{64}$/);
		for (const dependency of report.assessment.dependencies) {
			expect(['maestro', 'mega-maestro']).toContain(dependency.owner);
			expect(dependency.detail.length).toBeGreaterThan(0);
		}
		expect(fs.existsSync(PAIR_HARNESS_SCRIPT)).toBe(true);
	});

	it.skipIf(!report.assessment.ready)(
		`runs the certifiable pair: registered, attached, execution admitted through the real broker${blocked}`,
		async () => {
			const { spawnSync } = await import('node:child_process');
			const out = path.join(os.tmpdir(), `early-pair-${process.pid}.json`);
			const result = spawnSync(process.execPath, [PAIR_HARNESS_SCRIPT, 'run', '--out', out], {
				encoding: 'utf8',
				timeout: 300_000,
			});
			expect(result.status).toBe(0);
			const record = JSON.parse(fs.readFileSync(out, 'utf8')) as {
				run: {
					certifiable: boolean;
					observed: { driver: { result: { steps: Array<{ name: string; outcome: unknown }> } } };
				};
			};
			expect(record.run.certifiable).toBe(true);
			const step = (name: string) =>
				record.run.observed.driver.result.steps.find((s) => s.name === name)?.outcome;
			expect(step('attach.registered')).toMatchObject({ status: 'ok' });
			expect(step('execution.admit')).toMatchObject({ state: 'admitted' });
		},
		400_000
	);
});
