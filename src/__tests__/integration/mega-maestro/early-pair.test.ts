/**
 * The early pair, end to end on this host: a declared harmless program run
 * through the protected dispatch against an endpoint, with every effect
 * observed independently of what any receipt says.
 *
 * Two parts. The deterministic part runs against the fake daemon (a
 * declared double of the endpoint's socket protocol) with the real client,
 * the real adapter, the real bridge and the real spawn sink, and proves
 * local behavior: an allowed run leaves exactly its effects (a file in its
 * work directory, nothing on the wire, no descendant, no undeclared read); a
 * denial, a replay, a changed snapshot, a lost endpoint, a wrong runtime and
 * a lost answer each leave none; the broker's decision receipt joins the
 * local ledger; an attached session that drops is unavailable until it is
 * re-registered. The real part runs the harness script against the real
 * endpoint when `check` says every producer is present and otherwise skips,
 * naming the dependency and its owner in the test title. Unit doubles close
 * nothing about the real pair; the harness does.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { dispatchHarness, type HarnessDispatchOutcome } from '../../../main/enterprise/dispatch';
import {
	buildDispatchSnapshot,
	dispatchSnapshotDigest,
} from '../../../shared/maestro-lib/managed/authority';
import {
	buildHarnessLaunchSpec,
	SYNTHETIC_HARNESS_PROVIDER,
	type HarnessRouteRequest,
} from '../../../shared/maestro-lib/managed/provider-route';
import { DispatchRefusedError, startTurn } from '../../../shared/maestro-lib/run/start-turn';
import {
	brokerReceipt,
	composePair,
	describePairSkip,
	PAIR_HARNESS_SCRIPT,
	PAIR_INSTALLATION,
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

	beforeEach(async () => {
		root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'early-pair-')));
		declared = path.join(root, 'declared.txt');
		undeclared = path.join(root, 'undeclared.txt');
		fs.writeFileSync(declared, 'declared input');
		fs.writeFileSync(undeclared, 'not for the program');
		pair = await composePair({ dir: root });
		expect(await pair.attach()).toBe('ok');
		observer = await startEgressObserver();
	});
	afterEach(async () => {
		await observer.close();
		await pair.close();
		fs.rmSync(root, { recursive: true, force: true });
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
			const context = verifiedContext(pair.verifier);
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

			// What went to the endpoint is the broker's vocabulary, with no command line on the wire.
			const sent = executionCalls();
			expect(sent).toHaveLength(1);
			expect((sent[0].body as { payload: unknown }).payload).toEqual({
				requestId: context.identity.requestId,
				attemptId: context.identity.attemptId,
				runId: context.identity.runId,
				source: 'headless',
				operation: 'start',
				arguments: [],
				resources: [declared],
				provider: SYNTHETIC_HARNESS_PROVIDER,
				model: 'synthetic',
				policyRevision: 3,
			});
			expect(outcome.receipt?.effect).toMatchObject({
				state: 'released',
				release: { outcome: 'exited', exitCode: 0 },
			});
			expect(outcome.receipt?.effect.pid).toBe(effects!.pid);
		},
		RUN_TIMEOUT_MS
	);

	it(
		'policy receipt: the broker decision travels on the lease and joins the durable ledger',
		async () => {
			const dir = workDir();
			const outcome = await dispatchHarness(pair.bridge, request(dir), {
				context: verifiedContext(pair.verifier),
			});
			expect(outcome.status).toBe('ran');
			if (outcome.status !== 'ran') return;
			expect(outcome.decision).toEqual({
				decisionId: 'decision-1',
				requestDigest: 'd'.repeat(64),
				brokerId: 'broker-pair',
				policyRevision: 3,
			});
			const joined = pair.bridge.byDecision('decision-1');
			expect(joined?.leaseId).toBe(outcome.leaseId);
			expect(joined?.registration).toMatchObject({
				challengeId: 'challenge-pair',
				runtimeId: PAIR_INSTALLATION.runtimeId,
			});
			await new Promise((resolve) => setTimeout(resolve, 30));
			const ledger = JSON.parse(fs.readFileSync(pair.ledgerFile, 'utf8')) as {
				receipts: Array<{ decision: { decisionId: string }; effect: { state: string } }>;
			};
			expect(ledger.receipts.map((r) => [r.decision.decisionId, r.effect.state])).toEqual([
				['decision-1', 'released'],
			]);
		},
		RUN_TIMEOUT_MS
	);

	it(
		'deny before effect: a policy refusal, a replay and an unsupported broker each run nothing',
		async () => {
			const expectNothingRan = (dir: string, outcome: HarnessDispatchOutcome) => {
				expect(readSyntheticEffects(dir)).toBeNull();
				expect(fs.readdirSync(dir)).toEqual([]);
				expect(outcome.status).not.toBe('ran');
			};

			pair.fake.options.operations = {
				execution: () => ({ outcome: 'denied', reason: 'policy_denied' }),
			};
			const denied = workDir();
			const deniedOutcome = await dispatchHarness(pair.bridge, request(denied), {
				context: verifiedContext(pair.verifier),
			});
			expect(deniedOutcome).toMatchObject({ status: 'denied', code: 'policy-denied' });
			expectNothingRan(denied, deniedOutcome);

			// A replay of a consumed request: the broker refuses, and the second attempt leaves nothing.
			const seen = new Set<string>();
			pair.fake.options.operations = {
				execution: (payload) => {
					const p = payload as Record<string, unknown>;
					const key = `${p.requestId}/${p.attemptId}`;
					if (seen.has(key)) return { outcome: 'denied', reason: 'replay' };
					seen.add(key);
					return brokerReceipt(p, 'decision-r');
				},
			};
			const first = workDir();
			const identity = { requestId: 'req-replay', attemptId: 'att-replay', runId: 'run-replay' };
			const ran = await dispatchHarness(pair.bridge, request(first), {
				context: verifiedContext(pair.verifier, { identity }),
			});
			expect(ran.status).toBe('ran');
			expect(readSyntheticEffects(first)).not.toBeNull();
			const second = workDir();
			const replayed = await dispatchHarness(pair.bridge, request(second), {
				context: verifiedContext(pair.verifier, { identity }),
			});
			expect(replayed).toMatchObject({ status: 'denied', code: 'idempotency-conflict' });
			expectNothingRan(second, replayed);

			// An endpoint that advertises no execution gives no decision: unavailable, nothing runs.
			pair.fake.options.operations = {
				execution: () => ({ outcome: 'denied', reason: 'unsupported_capability' }),
			};
			const unsupported = workDir();
			const noDecision = await dispatchHarness(pair.bridge, request(unsupported), {
				context: verifiedContext(pair.verifier),
			});
			expect(noDecision).toMatchObject({ status: 'unavailable', code: 'runtime-unavailable' });
			expectNothingRan(unsupported, noDecision);
			expect(observer.connections()).toBe(0);
		},
		RUN_TIMEOUT_MS
	);

	it('changed inputs: a lease admitted for one snapshot refuses another at the spawn, before any effect', async () => {
		const dir = workDir();
		const admittedRequest = request(dir);
		const spec = buildHarnessLaunchSpec(admittedRequest);
		const attribution = {
			provider: SYNTHETIC_HARNESS_PROVIDER,
			model: 'synthetic',
			operation: 'start' as const,
			resourceIds: [declared],
		};
		const context = verifiedContext(pair.verifier);
		const admitted = await pair.bridge.authority.admit({
			context,
			snapshot: buildDispatchSnapshot(spec, attribution),
			policy: pair.host.policy(),
		});
		expect(admitted.state).toBe('admitted');
		if (admitted.state !== 'admitted') return;
		const { lease } = admitted;

		// The program that reaches the spawn is not the one admitted: one more argument.
		const replaced = { ...spec, args: [...spec.args, '--allow-net'] };
		const refused = () =>
			startTurn(
				replaced,
				{},
				{
					admission: {
						gate: {
							admit: (final) => {
								const verdict = pair.bridge.authority.check(lease, dispatchSnapshotDigest(final));
								return verdict.ok
									? { ok: true }
									: { ok: false, state: 'denied', code: 'lease-invalid', message: verdict.reason };
							},
						},
						attribution,
					},
					stopGraceMs: 100,
				}
			);
		expect(refused).toThrow(DispatchRefusedError);
		expect(refused).toThrow('snapshot-mismatch');
		expect(readSyntheticEffects(dir)).toBeNull();
		expect(fs.readdirSync(dir)).toEqual([]);
		expect(lease.state()).toBe('issued');
		expect(pair.bridge.receipt(lease.leaseId)?.effect.state).toBe('admitted');
	});

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
			context: verifiedContext(pair.verifier),
		});
		expect(outcome).toMatchObject({ status: 'unavailable' });
		expect(readSyntheticEffects(dir)).toBeNull();
	});

	it(
		'offline and restart: a dropped endpoint session is unavailable until re-attached; the ledger survives a host restart',
		async () => {
			pair.fake.dropConnections();
			await new Promise((resolve) => setTimeout(resolve, 20));
			const dropped = workDir();
			const offline = await dispatchHarness(pair.bridge, request(dropped), {
				context: verifiedContext(pair.verifier),
			});
			expect(offline).toMatchObject({ status: 'unavailable' });
			expect(readSyntheticEffects(dropped)).toBeNull();
			expect(executionCalls()).toHaveLength(0);

			// The registration is the process's: a re-attach on a new connection restores the standing.
			expect(await pair.attach()).toBe('ok');
			const back = workDir();
			const again = await dispatchHarness(pair.bridge, request(back), {
				context: verifiedContext(pair.verifier),
			});
			expect(again.status).toBe('ran');
			expect(readSyntheticEffects(back)).not.toBeNull();

			// A second host over the same ledger reads the released receipt and recovers nothing as unknown.
			const restarted = await composePair({ dir: root, fake: { capabilities: ['execution'] } });
			try {
				expect(restarted.bridge.receipts()).toHaveLength(1);
				expect(restarted.bridge.receipts()[0]).toMatchObject({
					decision: { decisionId: 'decision-1' },
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
			pair.fake.options.delayMs = 1_500;
			const lost = workDir();
			const unknown = await dispatchHarness(pair.bridge, request(lost), {
				context: verifiedContext(pair.verifier),
			});
			expect(unknown).toMatchObject({ status: 'unknown', code: 'outcome-unknown' });
			expect(readSyntheticEffects(lost)).toBeNull();
			pair.fake.options.delayMs = 0;

			await pair.fake.close();
			const gone = workDir();
			const unavailable = await dispatchHarness(pair.bridge, request(gone), {
				context: verifiedContext(pair.verifier),
			});
			expect(unavailable).toMatchObject({ status: 'unavailable' });
			expect(readSyntheticEffects(gone)).toBeNull();
			expect(observer.connections()).toBe(0);
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
