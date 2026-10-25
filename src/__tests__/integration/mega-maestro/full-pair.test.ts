/**
 * The full pair: the paired journeys catalog (`journeys.ts`), the code the
 * container driver runs against the real endpoint, run on this host with every
 * effect observed independently of what a receipt says. The deterministic part
 * runs it against the fake daemon (a declared double of the socket protocol)
 * through the real client, adapter, headless authority, desktop process-manager
 * port and `startTurn` sink: handshake, launch-only admission with no command
 * line on the wire, the harness program under its lease, the workflow claim
 * refused by name (CP-03), a policy refusal running nothing, every origin under
 * its wire source, a delegation never stripped, a revoked registration, and a
 * missing producer never counting an observation as passed. The real part runs
 * the harness `run --runtime` when `check` says every producer is present and
 * otherwise skips, naming the dependency and its owner. Unit doubles close
 * nothing about the real pair; the harness does, and MRC-12-06 judges its rows.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createProcessSpawnAuthority } from '../../../main/enterprise/spawn-authority';
import * as Lib from '../../../shared/maestro-lib/index';
import type { ManagedOrigin } from '../../../shared/maestro-lib/managed/types';
import {
	composePair,
	describePairSkip,
	PAIR_HARNESS_SCRIPT,
	PAIR_INSTALLATION,
	PAIR_POLICY_REVISION,
	pairIdentityRecord,
	readSyntheticEffects,
	runPairCheck,
	SYNTHETIC_EFFECTS_FILE,
	SYNTHETIC_PROVIDER_ID,
	verifiedContext,
	type PairCheckReport,
	type PairComposition,
} from './fixtures';
import {
	assessJourney,
	PAIR_JOURNEYS,
	runPairJourneys,
	type JourneyDeps,
	type JourneyRun,
	type PairProducerId,
	type ProducerStanding,
} from './journeys';

const RUN_TIMEOUT_MS = 30_000;
const PRODUCERS: readonly PairProducerId[] = ['CP-01', 'CP-02', 'CP-03', 'registration-approval'];
const KNOWN_DEPENDENCIES = [
	'maestro-lib',
	'maestro-runtime',
	'linux-host',
	'linux-image',
	...PRODUCERS,
];
/** The sibling bridge's source vocabulary for each managed origin, as the adapter puts it on the wire. */
const WIRE_SOURCE: Record<ManagedOrigin, string> = {
	desktop: 'ux',
	cli: 'cli',
	cue: 'cue',
	headless: 'headless',
	enterprise: 'headless',
	embedded: 'headless',
};

const standing = (fresh: readonly PairProducerId[]) =>
	Object.fromEntries(
		PRODUCERS.map((id) => [id, { fresh: fresh.includes(id), detail: `test: ${id}` }])
	) as Partial<Record<PairProducerId, ProducerStanding>>;
const statusOf = (run: JourneyRun) => Object.fromEntries(run.journeys.map((j) => [j.id, j.status]));
const stepsOf = (run: JourneyRun, id: string) =>
	run.journeys.find((j) => j.id === id)!.steps.map((s) => s.name);
const outcomeOf = (run: JourneyRun, id: string, step: string) =>
	run.journeys.find((j) => j.id === id)!.steps.find((s) => s.name === step)?.outcome;

describe('full pair: the journeys catalog against the labeled endpoint double', () => {
	let root: string;
	let pair: PairComposition;
	let runs = 0;

	beforeEach(async () => {
		root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'full-pair-')));
		pair = await composePair({ dir: root });
	});
	afterEach(async () => {
		await pair.close();
		fs.rmSync(root, { recursive: true, force: true });
	});

	const executionCalls = () =>
		pair.fake.calls
			.filter((c) => (c.body as { operation?: string }).operation === 'execution')
			.map((c) => (c.body as { payload: Record<string, unknown> }).payload);

	/**
	 * The catalog over the fixture's port. The identity record is the fixture's on
	 * the real clock (the runner's default, so its registration is live); the
	 * approval is the test's own and labeled: the double has no approval producer.
	 */
	async function journeys(overrides: Partial<JourneyDeps> = {}) {
		const workDir = path.join(root, `journeys-${++runs}`);
		fs.mkdirSync(workDir);
		const run = await runPairJourneys({
			lib: Lib,
			port: pair.port,
			installation: PAIR_INSTALLATION,
			identity: (status) => ({
				...pairIdentityRecord(pair.fake.socketPath, Date.now()),
				policy: {
					desiredRevision: status?.desiredPolicyRevision ?? null,
					appliedRevision: status?.appliedPolicyRevision ?? null,
					observedAt: new Date().toISOString(),
				},
			}),
			provider: SYNTHETIC_PROVIDER_ID,
			workDir,
			desktop: { createProcessSpawnAuthority },
			approval: async () => true,
			timeoutMs: 10_000,
			...overrides,
		});
		return { run, workDir };
	}

	it(
		'allow: every journey the double can serve passes with its effects observed; the workflow claim fails by name (CP-03)',
		async () => {
			const { run, workDir } = await journeys();
			expect(run.approval).toBe('approved');
			expect(run.endpoint).toMatchObject({
				management: 'managed',
				appliedPolicyRevision: PAIR_POLICY_REVISION,
			});
			expect(statusOf(run)).toEqual({
				'library.handshake': 'passed',
				'library.admit': 'passed',
				'headless.turn': 'passed',
				'desktop.admit': 'passed',
				'desktop.workflow': 'failed',
			});

			// The handshake on a registration-first daemon: refused, challenged, redeemed, attached.
			expect(stepsOf(run, 'library.handshake')).toEqual([
				'compatibility',
				'attach',
				'registration.challenge',
				'registration.redeem',
				'attach.registered',
			]);
			expect(outcomeOf(run, 'library.handshake', 'attach')).toMatchObject({
				status: 'denied',
				reason: 'unauthenticated',
			});
			expect(outcomeOf(run, 'library.handshake', 'attach.registered')).toMatchObject({
				status: 'ok',
				payload: { outcome: 'attached', management: 'managed' },
			});

			// The adapter authority admits on the broker's decision; the raw operation answers the same vocabulary.
			expect(outcomeOf(run, 'library.admit', 'execution.admit')).toMatchObject({
				state: 'admitted',
				policyRevision: PAIR_POLICY_REVISION,
				receipt: { decisionId: 'decision-1', brokerId: 'broker-pair' },
			});
			expect(outcomeOf(run, 'library.admit', 'execution.raw')).toMatchObject({
				status: 'ok',
				payload: { outcome: 'broker_dispatched', requestId: 'pair-raw-1' },
			});

			// The headless turn: observed in the work directory, not reported by the program.
			const headlessDir = path.join(workDir, 'headless');
			const effects = readSyntheticEffects(headlessDir);
			expect(effects).not.toBeNull();
			expect(effects).toMatchObject({
				cwd: fs.realpathSync(headlessDir),
				wroteFile: path.join(fs.realpathSync(headlessDir), SYNTHETIC_EFFECTS_FILE),
				spawnedChild: 'ERR_ACCESS_DENIED',
			});
			expect(fs.readdirSync(headlessDir)).toEqual([SYNTHETIC_EFFECTS_FILE]);
			expect(outcomeOf(run, 'headless.turn', 'headless.turn')).toMatchObject({ exitCode: 0 });
			expect(outcomeOf(run, 'headless.turn', 'headless.lease')).toMatchObject({
				state: 'released',
				release: { outcome: 'exited', exitCode: 0 },
			});

			// The desktop port: managed standing, an in-process chat turn admitted on a broker decision.
			expect(outcomeOf(run, 'desktop.admit', 'desktop.standing')).toBe('managed');
			expect(outcomeOf(run, 'desktop.admit', 'desktop.admit')).toMatchObject({
				state: 'admitted',
				receipt: { decisionId: 'decision-4' },
			});

			// The workflow claim: the endpoint serves no owner operation, so no fence, no admission, no directory.
			expect(stepsOf(run, 'desktop.workflow')).toEqual(['workflow.claim']);
			expect(outcomeOf(run, 'desktop.workflow', 'workflow.claim')).toMatchObject({
				state: 'unavailable',
				code: 'capability-unsupported',
				message: expect.stringContaining('CP-03'),
			});
			expect(fs.existsSync(path.join(workDir, 'desktop-workflow'))).toBe(false);

			// The wire: four execution requests in the broker's vocabulary, each origin under its source, no command line.
			const sent = executionCalls();
			expect(sent.map((p) => p.source)).toEqual(['headless', 'headless', 'headless', 'ux']);
			expect(sent.every((p) => Array.isArray(p.arguments) && p.arguments.length === 0)).toBe(true);
			const wire = JSON.stringify(pair.fake.calls);
			expect(wire).not.toContain(process.execPath);
			expect(wire).not.toContain('process.stdin');

			// Two launch-only admissions were never bound to a spawn; the turn's lease was released.
			expect(run.leases).toBe(2);
		},
		RUN_TIMEOUT_MS
	);

	it(
		'assessment: a missing producer never lets an observed pass count; a fresh set lets a failure stand; an unselected surface is not-run',
		async () => {
			const { run } = await journeys({ surfaces: ['library', 'headless'] });
			expect(statusOf(run)).toEqual({
				'library.handshake': 'passed',
				'library.admit': 'passed',
				'headless.turn': 'passed',
				'desktop.admit': 'not-run',
				'desktop.workflow': 'not-run',
			});

			// No producer: every observed outcome is blocked by exactly what the catalog says it needs.
			for (const result of run.journeys) {
				const spec = PAIR_JOURNEYS.find((j) => j.id === result.id)!;
				const assessed = assessJourney(result, standing([]));
				expect(assessed.verdict).toBe(result.status === 'not-run' ? 'not-run' : 'blocked');
				expect(assessed.blockedBy).toEqual(spec.requires);
			}
			// The approval alone: the handshake counts, everything that needs a CP producer stays blocked by it.
			const approvalOnly = run.journeys.map((r) =>
				assessJourney(r, standing(['registration-approval']))
			);
			expect(approvalOnly.map((a) => [a.id, a.verdict, a.blockedBy])).toEqual([
				['library.handshake', 'passed', []],
				['library.admit', 'blocked', ['CP-01']],
				['headless.turn', 'blocked', ['CP-01', 'CP-02']],
				['desktop.admit', 'not-run', ['CP-01']],
				['desktop.workflow', 'not-run', ['CP-01', 'CP-03']],
			]);
			// Every producer fresh: the observation stands as it was, and only then.
			const fresh = run.journeys.map((r) => assessJourney(r, standing(PRODUCERS)));
			expect(fresh.map((a) => a.verdict)).toEqual([
				'passed',
				'passed',
				'passed',
				'not-run',
				'not-run',
			]);
			expect(fresh.every((a) => a.blockedBy.length === 0)).toBe(true);
		},
		RUN_TIMEOUT_MS
	);

	it(
		'deny before effect: a policy refusal at the broker and an undecided answer each leave the work directory empty and the journey failed, never passed',
		async () => {
			const cases: Array<[string, string, string]> = [
				['policy_denied', 'denied', 'policy-denied'],
				['unsupported_capability', 'unavailable', 'runtime-unavailable'],
			];
			for (const [reason, state, code] of cases) {
				pair.fake.options.operations = {
					execution: () => ({ outcome: 'denied', reason }),
				};
				const { run, workDir } = await journeys({ surfaces: ['library', 'headless'] });
				expect(statusOf(run)).toMatchObject({
					'library.handshake': 'passed',
					'library.admit': 'failed',
					'headless.turn': 'failed',
				});
				expect(outcomeOf(run, 'library.admit', 'execution.admit')).toMatchObject({ state, code });
				// The headless journey stops at the admission: no turn, no effects, no lease.
				expect(stepsOf(run, 'headless.turn')).toEqual(['headless.standing', 'headless.admit']);
				expect(outcomeOf(run, 'headless.turn', 'headless.admit')).toMatchObject({ state, code });
				const headlessDir = path.join(workDir, 'headless');
				expect(readSyntheticEffects(headlessDir)).toBeNull();
				expect(fs.readdirSync(headlessDir)).toEqual([]);
				expect(run.leases).toBe(0);
				// A denial under every producer is a failure, not a pass; under none it is blocked.
				const admit = run.journeys.find((j) => j.id === 'headless.turn')!;
				expect(assessJourney(admit, standing(PRODUCERS)).verdict).toBe('failed');
				expect(assessJourney(admit, standing([])).verdict).toBe('blocked');
				// A fresh connection for the next case, so its handshake starts clean.
				pair.fake.dropConnections();
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
		},
		RUN_TIMEOUT_MS
	);

	it('origins and delegation: every managed origin is admitted under its wire source; a chain or grant reference is never stripped (CP-03) and no request leaves', async () => {
		expect(await pair.attach()).toBe('ok');
		const snapshot = Lib.buildDispatchSnapshot(
			{ command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root, env: {} },
			{ provider: SYNTHETIC_PROVIDER_ID, model: Lib.SYNTHETIC_HARNESS_MODEL, resourceIds: [] }
		);
		const admit = (overrides: Parameters<typeof verifiedContext>[1]) =>
			pair.host.authority.admit({
				context: verifiedContext(pair.verifier, overrides),
				snapshot,
				policy: pair.host.policy(),
			});

		for (const origin of Lib.MANAGED_ORIGINS) {
			const admitted = await admit({ origin });
			expect(admitted.state, origin).toBe('admitted');
			expect(executionCalls().at(-1)).toMatchObject({
				source: WIRE_SOURCE[origin],
				provider: SYNTHETIC_PROVIDER_ID,
				policyRevision: PAIR_POLICY_REVISION,
			});
		}
		expect(executionCalls()).toHaveLength(Lib.MANAGED_ORIGINS.length);
		// A parented run carries its parent on the wire: the lineage is bound, not dropped.
		const child = await admit({
			origin: 'cue',
			identity: { parentRunId: 'run-parent', rootRunId: 'run-parent' },
		});
		expect(child.state).toBe('admitted');
		expect(executionCalls().at(-1)).toMatchObject({ source: 'cue', parentRunId: 'run-parent' });

		// A delegation chain or a grant reference: the endpoint binds neither, so no decision and no request.
		const before = executionCalls().length;
		const chained = await admit({
			delegation: { chain: [{ kind: 'agent', id: 'agent-initiator' }], grantRef: null },
		});
		expect(chained).toMatchObject({
			state: 'unavailable',
			code: 'runtime-unavailable',
			message: expect.stringContaining('a delegation chain of 1'),
		});
		const granted = await admit({ delegation: { chain: [], grantRef: 'grant-1' } });
		expect(granted).toMatchObject({
			state: 'unavailable',
			message: expect.stringMatching(/a grant reference.*CP-03/),
		});
		expect(executionCalls()).toHaveLength(before);
		pair.host.authority.revokeAll('test over');
		expect(pair.host.authority.live()).toEqual([]);
	});

	it(
		'revoke and restart: a revoked registration denies every launch until the handshake re-registers over a new connection; without an approval producer nothing is admitted and nothing counts',
		async () => {
			const first = await journeys({ surfaces: ['library'] });
			expect(statusOf(first.run)['library.admit']).toBe('passed');
			const requests = executionCalls().length;

			// The daemon revokes this process's registration: the handshake is refused and no producer answers the challenge.
			pair.fake.revokeRegistration();
			const revoked = await journeys({ surfaces: ['library', 'headless'], approval: undefined });
			expect(revoked.run.approval).toBe('no-producer');
			expect(revoked.run.endpoint).toBeNull();
			expect(statusOf(revoked.run)).toMatchObject({
				'library.handshake': 'failed',
				'library.admit': 'failed',
				'headless.turn': 'failed',
			});
			expect(stepsOf(revoked.run, 'library.handshake')).toEqual([
				'compatibility',
				'attach',
				'registration.challenge',
			]);
			expect(outcomeOf(revoked.run, 'library.handshake', 'attach')).toMatchObject({
				status: 'denied',
				reason: 'unauthenticated',
			});
			expect(outcomeOf(revoked.run, 'library.admit', 'execution.admit')).toMatchObject({
				state: 'unavailable',
				code: 'runtime-unavailable',
			});
			expect(readSyntheticEffects(path.join(revoked.workDir, 'headless'))).toBeNull();
			expect(executionCalls()).toHaveLength(requests);
			expect(revoked.run.leases).toBe(0);
			for (const result of revoked.run.journeys) {
				const assessed = assessJourney(result, standing(['CP-01', 'CP-02', 'CP-03']));
				expect(assessed.verdict).toBe(result.status === 'not-run' ? 'not-run' : 'blocked');
				expect(assessed.blockedBy).toEqual(['registration-approval']);
			}

			// The daemon restarts (every connection dropped): the handshake re-registers and the launch is admitted again.
			pair.fake.dropConnections();
			await new Promise((resolve) => setTimeout(resolve, 20));
			const again = await journeys({ surfaces: ['library'] });
			expect(again.run.approval).toBe('approved');
			expect(stepsOf(again.run, 'library.handshake')).toContain('registration.redeem');
			expect(statusOf(again.run)).toMatchObject({
				'library.handshake': 'passed',
				'library.admit': 'passed',
			});
			expect(executionCalls()).toHaveLength(requests + 2);
		},
		RUN_TIMEOUT_MS
	);
});

describe('full pair: the real endpoint through the harness script', () => {
	const report = runPairCheck() as PairCheckReport & {
		producers?: Record<string, ProducerStanding>;
	};
	const blocked = report.assessment.ready ? '' : ` (blocked: ${describePairSkip(report)})`;

	it('names every producer the full pair waits on with its owner, and every journey needs only producers check reports', () => {
		expect(report.reportVersion).toBe(1);
		expect(report.producers).toBeDefined();
		for (const id of PRODUCERS) {
			expect(report.producers![id], id).toMatchObject({ fresh: expect.any(Boolean) });
			expect(report.producers![id].detail.length).toBeGreaterThan(0);
		}
		for (const journey of PAIR_JOURNEYS) {
			for (const id of journey.requires) expect(PRODUCERS).toContain(id);
		}
		for (const dependency of report.assessment.dependencies) {
			expect(KNOWN_DEPENDENCIES).toContain(dependency.id);
			expect(['maestro', 'mega-maestro']).toContain(dependency.owner);
			expect(dependency.detail.length).toBeGreaterThan(0);
		}
		// A skip below is never silent: what is not ready is named, with an owner, here.
		if (!report.assessment.ready) expect(report.assessment.dependencies.length).toBeGreaterThan(0);
		for (const id of PRODUCERS) {
			if (!report.producers![id].fresh) {
				expect(report.assessment.dependencies.map((d) => d.id)).toContain(id);
			}
		}
		expect(fs.existsSync(PAIR_HARNESS_SCRIPT)).toBe(true);
	});

	it.skipIf(!report.assessment.ready)(
		`runs the full pair against the packaged runtime: every journey passed, both source digests recorded${blocked}`,
		() => {
			// The packaged runtime of this HEAD: `npm run package:mega-maestro-runtime` lands it under dist/.
			const runtimeRoot = path.resolve(process.cwd(), 'dist/mega-maestro-runtime');
			const runtimeDir = fs.existsSync(runtimeRoot)
				? fs
						.readdirSync(runtimeRoot)
						.flatMap((version) =>
							fs
								.readdirSync(path.join(runtimeRoot, version))
								.map((digest) => path.join(runtimeRoot, version, digest))
						)
						.find((dir) => {
							const artifact = path.join(dir, 'artifact.json');
							if (!fs.existsSync(artifact)) return false;
							const manifest = JSON.parse(fs.readFileSync(artifact, 'utf8')) as {
								source?: { head?: string };
							};
							return manifest.source?.head === report.host.maestroHead;
						})
				: undefined;
			expect(
				runtimeDir,
				'no packaged runtime of this HEAD: npm run package:mega-maestro-runtime'
			).toBeDefined();
			const out = path.join(os.tmpdir(), `full-pair-${process.pid}.json`);
			const result = spawnSync(
				process.execPath,
				[PAIR_HARNESS_SCRIPT, 'run', '--runtime', runtimeDir!, '--out', out],
				{ encoding: 'utf8', timeout: 300_000 }
			);
			expect(result.status, result.stderr).toBe(0);
			const record = JSON.parse(fs.readFileSync(out, 'utf8')) as {
				run: {
					certifiable: boolean;
					verdicts: Record<string, number>;
					journeys: Array<{ id: string; verdict: string; blockedBy: string[] }>;
					runtime: { archiveSha256: string | null; sourceHead?: string };
					source: { digest: string | null };
				};
			};
			expect(record.run.certifiable).toBe(true);
			expect(record.run.verdicts).toEqual({
				passed: PAIR_JOURNEYS.length,
				failed: 0,
				blocked: 0,
				'not-run': 0,
			});
			expect(record.run.journeys.map((j) => j.id).sort()).toEqual(
				PAIR_JOURNEYS.map((j) => j.id).sort()
			);
			expect(record.run.runtime.archiveSha256).toBe(path.basename(runtimeDir!));
			expect(record.run.runtime.sourceHead).toBe(report.host.maestroHead);
			expect(record.run.source.digest).toMatch(/^[a-f0-9]{64}$/);
		},
		400_000
	);
});
