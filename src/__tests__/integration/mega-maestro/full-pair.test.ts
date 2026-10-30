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
 *
 * The third describe is the fleet side over the REAL desktop composition
 * (`createEnterpriseService`: projector, durable journal, telemetry client,
 * content capture, inventory, dispatch bridge, command service and inbox, every
 * file in a temp data directory) against the same double, whose telemetry
 * operation applies the runtime gate transcribed from the sibling daemon
 * (`apps/endpoint/src/spool/runtime.ts` 523-534 and 544), whose inbox and
 * notice listing answer the way the daemon's durable inbox does, and, when the
 * sibling contracts package is built beside this checkout, its real schemas.
 * Commands run over the same real command service with the actor supplied by
 * the harness and said so: the service's own registration names no actor.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCommandService, type CommandService } from '../../../main/enterprise/commands';
import { contentDeliveryStanding } from '../../../main/enterprise/content';
import { createLocalEndpointClient } from '../../../main/enterprise/endpoint-client';
import { INVENTORY_DELIVERY } from '../../../main/enterprise/inventory';
import { createEnterpriseService, type EnterpriseService } from '../../../main/enterprise/service';
import { createProcessSpawnAuthority } from '../../../main/enterprise/spawn-authority';
import { telemetryReportOf } from '../../../main/enterprise/telemetry';
import { createUsageCapture } from '../../../main/enterprise/usage';
import { vibesEvidenceOf } from '../../../main/enterprise/vibes';
import { canonicalJson } from '../../../shared/canonicalJson';
import * as Lib from '../../../shared/maestro-lib/index';
import {
	ENDPOINT_COMMAND_ACTIONS,
	type ManagedRuntimeCommand,
} from '../../../shared/maestro-lib/managed/commands';
import type { ManagedEnrollmentStatus } from '../../../shared/maestro-lib/managed/endpoint-port';
import {
	lifecycleAdmissionOfLease,
	lifecycleLineageOf,
	type LifecycleFact,
	type LifecycleLineage,
	type ManagedInventoryEvent,
	type ManagedLifecycleEvent,
} from '../../../shared/maestro-lib/managed/events';
import type { ManagedOrigin } from '../../../shared/maestro-lib/managed/types';
import { readRuntimePin } from '../../../../scripts/package-mega-maestro-runtime.mjs';
import { fakeAnchor, fakeSeal } from '../../main/enterprise/fakeCustody';
import { startFakeEndpoint, type FakeEndpoint } from '../../main/enterprise/fakeEndpoint';
import {
	brokerReceipt,
	composePair,
	describePairSkip,
	PAIR_HARNESS_SCRIPT,
	PAIR_INSTALLATION,
	PAIR_POLICY_REVISION,
	pairIdentityRecord,
	readSyntheticEffects,
	runPairCheck,
	RUNTIME_CONFORMANCE_FILE,
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
			// The pinned runtime of this tree: the committed `runtime` section names the archive a
			// pair loads (`verifyRuntimeInput()` holds it to the tree; `run` refuses any other).
			const pin = readRuntimePin(RUNTIME_CONFORMANCE_FILE) as {
				status: string;
				record: { archive: { sha256: string }; location: { directory: string } } | null;
			};
			expect(pin.status, 'no committed runtime pin names an archive').toBe('pinned');
			const runtimeDir = path.resolve(process.cwd(), pin.record!.location.directory);
			expect(
				fs.existsSync(runtimeDir),
				'the pinned runtime is not packaged here: npm run package:mega-maestro-runtime'
			).toBe(true);
			const out = path.join(os.tmpdir(), `full-pair-${process.pid}.json`);
			const result = spawnSync(
				process.execPath,
				[PAIR_HARNESS_SCRIPT, 'run', '--runtime', runtimeDir, '--out', out],
				{ encoding: 'utf8', timeout: 300_000 }
			);
			expect(result.status, result.stderr).toBe(0);
			const record = JSON.parse(fs.readFileSync(out, 'utf8')) as {
				run: {
					certifiable: boolean;
					verdicts: Record<string, number>;
					journeys: Array<{ id: string; verdict: string; blockedBy: string[] }>;
					runtime: {
						archiveSha256: string | null;
						sourceHead?: string;
						coordinationOnly?: boolean;
					};
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
			expect(record.run.runtime.archiveSha256).toBe(pin.record!.archive.sha256);
			expect(path.basename(runtimeDir)).toBe(pin.record!.archive.sha256);
			// The archive observed the HEAD it was packaged at; a later coordination-only commit
			// (a pin, a receipt, a checklist) leaves it current and says so.
			if (!record.run.runtime.coordinationOnly) {
				expect(record.run.runtime.sourceHead).toBe(report.host.maestroHead);
			}
			expect(record.run.source.digest).toMatch(/^[a-f0-9]{64}$/);
		},
		400_000
	);
});

// ---------------------------------------------------------------------------
// The fleet side over the real desktop composition (condensed from the 10-09
// and 11-07 VERIFY fixtures)
// ---------------------------------------------------------------------------

const SIBLING_CONTRACTS = path.resolve(process.cwd(), '../mega-maestro/packages/contracts/dist');
interface Schema {
	safeParse(value: unknown): { success: boolean; error?: { issues: unknown[] } };
}
type SiblingContracts = Record<
	| 'incomingMetadataEvent'
	| 'durableReceipt'
	| 'contentReference'
	| 'fleetInventory'
	| 'noticeListRequest'
	| 'inboxRequest'
	| 'inboxReceipt',
	Schema
>;
/** The sibling's zod schemas from its built package (read-only), or null when it is not beside this checkout. */
async function loadSibling(): Promise<SiblingContracts | null> {
	if (!fs.existsSync(path.join(SIBLING_CONTRACTS, 'events.js'))) return null;
	const load = (file: string) => import(pathToFileURL(path.join(SIBLING_CONTRACTS, file)).href);
	const [events, local, fleet] = await Promise.all(
		['events', 'local-endpoint', 'fleet'].map((f) => load(`${f}.js`))
	);
	return {
		incomingMetadataEvent: events.incomingMetadataEvent,
		contentReference: events.contentReference,
		durableReceipt: local.durableReceipt,
		noticeListRequest: local.noticeListRequest,
		inboxRequest: local.inboxRequest,
		inboxReceipt: local.inboxReceipt,
		fleetInventory: fleet.fleetInventory,
	};
}

/** runtime.ts 530: the families a runtime source may report. */
const RUNTIME_FAMILIES = ['presence', 'agent.lifecycle', 'usage', 'error'];
const FLEET_T0 = Date.parse('2026-10-25T12:00:00Z');
const DIGEST_A = 'a'.repeat(64);
const CANARIES = {
	prompt: 'CANARY-PROMPT refactor the billing module',
	token: 'sk-ant-api03-CANARYTOKEN0123456789',
	path: '/Users/canary/project/.env',
	account: 'c'.repeat(64),
};
/** A notice body and the person's reply: the reply crosses the wire by design, so neither is a wire canary. */
const NOTICE_BODY = 'CANARY-NOTICE planned maintenance of the billing cluster on Friday';
const NOTICE_REPLY = 'CANARY-REPLY the Friday window collides with our release; Monday works';
const notice = (messageId: string, body: string, expiresAt: number) => ({
	campaignId: '7d2c3f0e-5a4b-4c6d-9e8f-0a1b2c3d4e5f',
	messageId,
	body,
	expiresAt: new Date(expiresAt).toISOString(),
	kind: 'notice',
	agentInput: false,
});
const DAY = 86_400_000;
const N1 = notice('0f1e2d3c-4b5a-4968-8776-655443322110', NOTICE_BODY, FLEET_T0 + DAY);
const N2 = notice(
	'1f1e2d3c-4b5a-4968-8776-655443322111',
	'The policy revision moves.',
	FLEET_T0 + DAY
);
const N_EXPIRED = notice(
	'2f1e2d3c-4b5a-4968-8776-655443322112',
	'Expired: never held.',
	FLEET_T0 - 1
);
const N3 = notice(
	'3f1e2d3c-4b5a-4968-8776-655443322113',
	'Third, on the second page.',
	FLEET_T0 + DAY
);
/** The daemon's inbox state for a recorded action (its receipt vocabulary). */
const STATE_OF: Record<string, string> = {
	delivered: 'delivered',
	read: 'read',
	acknowledged: 'acknowledged',
	reply: 'replied',
};
/** The harness-installed collection ceiling: no endpoint operation of this build carries one (CP-01). */
const GRANTED = { capture: true, upload: true, storage: true };
const CEILING = {
	policyRevision: PAIR_POLICY_REVISION,
	profile: 'full_vibes',
	roles: ['user.prompt', 'vibes.annotations'],
	permissions: { ...GRANTED, index: false, display: false, export: false },
	sensitivity: 'restricted',
	maxPayloadBytes: 1024 * 1024,
	redactionRuleIds: [],
};
const CHILD_ARGS = ['-e', 'setInterval(() => {}, 1000)'];
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
/** Every file under the data directory, read as text: where a body, a reply or a prompt must never be. */
const filesUnder = (dir: string): string[] =>
	fs
		.readdirSync(dir, { withFileTypes: true })
		.flatMap((entry) =>
			entry.isDirectory()
				? filesUnder(path.join(dir, entry.name))
				: [fs.readFileSync(path.join(dir, entry.name), 'utf8')]
		);

describe('full pair: fleet evidence, usage, VIBES, TRACE, governance, commands and notices over the real desktop composition', () => {
	let clock = FLEET_T0;
	const now = () => clock;
	let dir: string;
	let fake: FakeEndpoint;
	let service: EnterpriseService;
	let sibling: SiblingContracts | null;
	/** The double's durable side: the telemetry spool by event id and the inbox by idempotency key, deduplicated the way the daemon's are. */
	const spool = new Map<string, Record<string, unknown>>();
	const inbox = new Map<string, Record<string, unknown>>();
	const denials: { operation: string; reason: string; issues?: unknown }[] = [];
	const noticeListRequests: Record<string, unknown>[] = [];
	const inboxRequests: { action: { kind: string; text?: string }; idempotencyKey: string }[] = [];
	const repliesSeen: string[] = [];
	let decisions = 0;
	let live: Awaited<ReturnType<typeof admitChild>>;
	let second: Awaited<ReturnType<typeof admitChild>>;
	let lineage: LifecycleLineage;
	let admission: ReturnType<typeof lifecycleAdmissionOfLease>;
	let evidenceSha = '';
	let harness: CommandService;

	const fits = (schema: Schema | undefined, operation: string, value: unknown): boolean => {
		if (!schema) return true;
		const parsed = schema.safeParse(value);
		if (!parsed.success)
			denials.push({ operation, reason: 'invalid_request', issues: parsed.error });
		return parsed.success;
	};
	const delivery = () => service.eventJournal.status().delivery;
	const wireOperations = () =>
		new Set(fake.calls.map((c) => (c.body as { operation?: string }).operation ?? c.path));
	const operations = (name: string) =>
		fake.calls.filter((c) => (c.body as { operation?: string }).operation === name);

	beforeAll(async () => {
		sibling = await loadSibling();
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'full-pair-fleet-'));
		fake = await startFakeEndpoint({
			registrationRequired: true,
			capabilities: ['execution', 'telemetry', 'inbox', 'noticeList'],
			status: { collectionProfile: 'full_vibes' },
			now,
			operations: {
				execution: (payload) =>
					brokerReceipt(payload as Record<string, unknown>, `decision-${++decisions}`),
				telemetry: (payload) => {
					const env = payload as Record<string, unknown>;
					if (!fits(sibling?.incomingMetadataEvent, 'telemetry', env))
						return { outcome: 'denied', reason: 'invalid_request' };
					// runtime.ts 523-527: bound to the enrollment, the installation and the boot.
					if (
						env.deviceId !== 'enr-pair' ||
						env.instanceId !== service.installation.installationId ||
						env.bootId !== service.installation.processEpoch
					) {
						denials.push({ operation: 'telemetry', reason: 'unauthenticated' });
						return { outcome: 'denied', reason: 'unauthenticated' };
					}
					// runtime.ts 530-534 and 544: the runtime gate and the revision.
					if (
						env.source !== 'runtime' ||
						!RUNTIME_FAMILIES.includes(env.family as string) ||
						env.collectionProfile !== 'metadata' ||
						(env.contentReferences as unknown[]).length > 0 ||
						!['estimated', 'unavailable'].includes(env.usageProvenance as string) ||
						['agentId', 'sessionId', 'runId', 'parentRunId', 'traceId', 'spanId'].some(
							(k) => env[k]
						) ||
						env.policyRevision !== PAIR_POLICY_REVISION
					) {
						denials.push({ operation: 'telemetry', reason: 'policy_denied' });
						return { outcome: 'denied', reason: 'policy_denied' };
					}
					const id = env.eventId as string;
					const duplicate = spool.has(id);
					if (!duplicate) spool.set(id, env);
					const receivedAt = new Date(now()).toISOString();
					const receipt = { outcome: 'durably_accepted', eventId: id, receivedAt, duplicate };
					fits(sibling?.durableReceipt, 'durableReceipt', receipt);
					return receipt;
				},
				noticeList: (payload) => {
					noticeListRequests.push(payload as Record<string, unknown>);
					if (!fits(sibling?.noticeListRequest, 'noticeList', payload))
						return { outcome: 'denied', reason: 'invalid_request' };
					return (payload as { offset: number }).offset === 0
						? { outcome: 'notices', items: [N1, N2, N_EXPIRED], nextOffset: 1 }
						: { outcome: 'notices', items: [N3], nextOffset: null };
				},
				inbox: (payload) => {
					const request = payload as (typeof inboxRequests)[number] & { messageId: string };
					inboxRequests.push(request);
					if (!fits(sibling?.inboxRequest, 'inbox', payload))
						return { outcome: 'denied', reason: 'invalid_request' };
					// A durable inbox answers the same receipt under the same key and records nothing twice.
					const held = inbox.get(request.idempotencyKey);
					if (held) return held;
					if (request.action.kind === 'reply' && request.action.text)
						repliesSeen.push(request.action.text);
					const receipt = {
						outcome: 'recorded',
						messageId: request.messageId,
						receiptId: `rcpt-${inbox.size + 1}`,
						state: STATE_OF[request.action.kind],
					};
					fits(sibling?.inboxReceipt, 'inboxReceipt', receipt);
					inbox.set(request.idempotencyKey, receipt);
					return receipt;
				},
			},
		});
		const seal = fakeSeal();
		service = createEnterpriseService({
			userDataDir: dir,
			productionDataDir: dir,
			hostname: 'full-pair-host',
			pid: 4242,
			startedAt: new Date(FLEET_T0 - 60_000).toISOString(),
			appVersion: '1.1.0-RC',
			safeStorage: {
				isEncryptionAvailable: () => true,
				encryptString: (text) => seal.seal(text),
				decryptString: (blob) => seal.unseal(blob),
				getSelectedStorageBackend: () => 'keychain',
			},
			anchor: fakeAnchor({ value: null }),
			platform: 'darwin',
			now,
			openPort: (socketPath) => createLocalEndpointClient({ socketPath, timeoutMs: 1_000 }),
		});
		await service.identity.write({
			installationId: service.installation.installationId,
			tenantId: 'tenant-pair',
			orgId: 'org-pair',
			enrollmentId: 'enr-pair',
			endpoint: { socketPath: fake.socketPath, bindingDigest: DIGEST_A, trustRootDigest: null },
			management: 'enrolled',
			registration: null,
			policy: { desiredRevision: null, appliedRevision: null, observedAt: null },
			enrolledAt: new Date(FLEET_T0).toISOString(),
		});
		await service.start();
		// The passes below are driven by hand so each outcome is observed; the idle poll is the service's own.
		service.telemetry.stop();
		// The actor's approval, played by the test and labeled: the double has no approval producer.
		expect((await service.policy.recover()).status).toBe('approval-required');
		expect((await service.lifecycle.completeRegistration()).status).toBe('ok');
		// The accepted attachment lists the notices and records `delivered` for each held one on its own.
		await vi.waitFor(() => expect(inboxRequests).toHaveLength(3), { timeout: 5_000 });
	}, 30_000);

	afterAll(async () => {
		for (const run of [live, second])
			if (run?.child.pid && alive(run.child.pid)) run.child.kill('SIGKILL');
		await service?.close();
		await fake?.close();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	const fact = (over: Partial<LifecycleFact>): LifecycleFact => ({
		surface: 'agent',
		state: 'running',
		at: now(),
		sessionId: 'agent-pair-ai-tab-1',
		agentId: 'agent-pair',
		tabId: 'tab-1',
		provider: 'codex',
		model: 'gpt-5-codex',
		providerSessionId: 'thread-pair',
		runId: 'run-a',
		record: 'journal',
		ledgerStatus: 'running',
		exitCode: null,
		durationMs: null,
		detail: null,
		...over,
	});
	/** A context the real process-manager port verified: the lineage every event of the run carries. */
	const verify = (runId: string, parentRunId: string | null) => {
		const verified = service.spawnAuthority.verify({
			actor: { peer: 'in-process' },
			identity: {
				requestId: `req-${runId}`,
				idempotencyKey: `key-${runId}`,
				attemptId: `att-${runId}`,
				runId,
				rootRunId: parentRunId ?? runId,
				parentRunId,
			},
			traceId: `trace-${runId}`,
			policyRevision: service.host.policy().policyRevision,
			workflow: null,
		});
		if (!verified.ok) throw new Error(verified.problems.join('; '));
		return verified.context;
	};
	/** Admit through the real bridge (the double answers the broker decision) and start a REAL child under the lease; the test plays the sink. */
	async function admitChild(context: ReturnType<typeof verify>) {
		const admitted = await service.spawnAuthority.authority.admit({
			context,
			snapshot: Lib.buildDispatchSnapshot(
				{ command: process.execPath, args: CHILD_ARGS, cwd: dir, env: {} },
				{ provider: SYNTHETIC_PROVIDER_ID, model: 'synthetic', resourceIds: [] }
			),
			policy: service.spawnAuthority.policy(),
		});
		if (admitted.state !== 'admitted') throw new Error(`${admitted.state}: ${admitted.message}`);
		const child = spawn(process.execPath, CHILD_ARGS, { cwd: dir, stdio: 'ignore' });
		await once(child, 'spawn');
		const exited = once(child, 'exit').then(([code, signal]) => ({ code, signal }));
		const revocations: string[] = [];
		admitted.lease.bind(child.pid);
		admitted.lease.onRevoked((reason) => {
			revocations.push(reason);
			child.kill('SIGTERM');
		});
		return { child, lease: admitted.lease, exited, revocations };
	}
	const act = (messageId: string, action: { kind: string; text?: string }) =>
		service.inbox.act({ campaignId: N1.campaignId, messageId, action: action as never });

	it('notices: the accepted attachment lists two pages, drops the expired one and records delivered once each; read, acknowledged and a private reply are recorded under their keys, a duplicate is answered from history, an unknown message and an untyped action are refused before any request, and the reply text is in no file under the data directory', async () => {
		expect(noticeListRequests.slice(0, 2)).toEqual([
			{ offset: 0, limit: 8 },
			{ offset: 1, limit: 8 },
		]);
		const held = service.inbox.notices();
		expect(held.map((n) => n.messageId)).toEqual([N1.messageId, N2.messageId, N3.messageId]);
		expect(held.every((n) => n.agentInput === false && n.recorded === 'delivered')).toBe(true);
		expect(held[0]?.body).toBe(NOTICE_BODY);
		expect(inboxRequests.map((r) => r.action.kind)).toEqual([
			'delivered',
			'delivered',
			'delivered',
		]);
		expect(new Set(inboxRequests.map((r) => r.idempotencyKey)).size).toBe(3);
		// A second listing records nothing again: the delivered receipts are durable on this host.
		expect(await service.inbox.refresh()).toMatchObject({
			outcome: 'listed',
			pages: 2,
			expired: 1,
			newlyHeld: 0,
			delivered: { recorded: 0 },
		});
		expect(inboxRequests).toHaveLength(3);

		expect(await act(N1.messageId, { kind: 'read' })).toMatchObject({
			status: 'recorded',
			duplicate: false,
		});
		expect(await act(N1.messageId, { kind: 'read' })).toMatchObject({
			status: 'recorded',
			duplicate: true,
		});
		expect(inboxRequests).toHaveLength(4);
		expect(await act(N1.messageId, { kind: 'acknowledged' })).toMatchObject({ status: 'recorded' });
		expect(await act(N1.messageId, { kind: 'reply', text: NOTICE_REPLY })).toMatchObject({
			status: 'recorded',
			duplicate: false,
		});
		expect(repliesSeen).toEqual([NOTICE_REPLY]);
		expect(inbox.size).toBe(6);
		expect(service.inbox.notices().find((n) => n.messageId === N1.messageId)).toMatchObject({
			recorded: 'replied',
			receipts: {
				delivered: 'recorded',
				read: 'recorded',
				acknowledged: 'recorded',
				reply: 'recorded',
			},
		});
		// Refused by name before any request leaves: a message the listing never held, an action the contract has no kind for.
		expect(await act('ffffffff-4b5a-4968-8776-655443322110', { kind: 'read' })).toMatchObject({
			status: 'denied',
			reason: 'unknown-message',
		});
		expect(await act(N2.messageId, { kind: 'forward' })).toMatchObject({
			status: 'denied',
			reason: 'invalid-action',
		});
		expect(inboxRequests).toHaveLength(6);
		expect(denials).toEqual([]);
		// The ledger holds ids and states; the body and the reply reached the double and the person's surface only.
		const ledger = fs.readFileSync(path.join(dir, 'maestro-managed-inbox-receipts.json'), 'utf8');
		expect(ledger).toContain(N1.messageId);
		for (const text of filesUnder(dir)) {
			expect(text).not.toContain(NOTICE_REPLY);
			expect(text).not.toContain(NOTICE_BODY);
		}
	});

	it('TRACE and governance: a real child admitted through the real process-manager port carries its lineage on every event and a nested run its parent; the ceiling is the harness installed (CP-01) and the VIBES evidence digest recomputes, held pending_upload with no delivery', async () => {
		// No endpoint operation installs a ceiling: the standing says so, then the harness installs one and says so.
		const before = service.content.standing();
		expect(before).toMatchObject({ mode: 'managed', ok: false, profile: 'full_vibes' });
		expect(before.mode === 'managed' && !before.ok ? before.reason : '').toContain('CP-01');
		expect(service.content.install(CEILING).ok).toBe(true);
		expect(service.content.standing()).toMatchObject({ mode: 'managed', ok: true });

		const context = verify('run-a', null);
		lineage = lifecycleLineageOf(context);
		live = await admitChild(context);
		expect(live.lease.decision).toMatchObject({ decisionId: 'decision-1' });
		expect(service.dispatch.receipt(live.lease.leaseId)?.effect.state).toBe('bound');
		admission = lifecycleAdmissionOfLease(live.lease);

		const started = service.events.record(fact({ lineage, admission }));
		expect(started.map((e) => e.kind)).toEqual(['decision', 'run-state']);
		for (const event of started) {
			expect(event.context).toMatchObject({ traceId: 'trace-run-a', identity: lineage.identity });
			expect(event.run).toMatchObject({ runId: 'run-a', rootRunId: 'run-a', parentRunId: null });
		}
		expect(started[0]?.decision).toMatchObject(admission);
		clock += 100;
		const nestedLineage = lifecycleLineageOf(verify('run-b', 'run-a'));
		const [nested] = service.events.record(
			fact({ lineage: nestedLineage, runId: 'run-b', sessionId: 'ai-tab-2' })
		);
		expect(nested).toMatchObject({
			kind: 'run-state',
			context: { traceId: 'trace-run-b', identity: { parentRunId: 'run-a' } },
			run: { runId: 'run-b', rootRunId: 'run-a', parentRunId: 'run-a' },
		});

		// VIBES: the graph of what the projector holds, its evidence digest recomputed from the annotations on this side.
		const graph = service.vibes();
		expect(graph.sessions.length).toBeGreaterThan(0);
		const evidence = vibesEvidenceOf(graph);
		expect(sha(graph.annotations.map((a) => canonicalJson(a)).join('\n') + '\n')).toBe(
			evidence.sha256
		);
		evidenceSha = evidence.sha256;
		const capture = service.contentCapture;
		const captureOf = (role: string, text: string, runId: string | null) =>
			capture.capture({
				role: role as never,
				text,
				sessionId: runId ? 'agent-pair-ai-tab-1' : 'host',
				agentId: runId ? 'agent-pair' : service.installation.installationId,
				tabId: runId ? 'tab-1' : null,
				provider: runId ? 'codex' : 'maestro',
				runId,
			});
		const vibes = captureOf(evidence.role, evidence.text, null);
		if (vibes.outcome !== 'recorded') throw new Error(vibes.reason);
		const { sha256, byteLength } = evidence;
		expect(vibes.fact.original).toMatchObject({ sha256, byteLength });
		expect(sha(capture.take(vibes.fact.original.referenceId)!.bytes)).toBe(evidence.sha256);
		const prompt = captureOf('user.prompt', CANARIES.prompt, 'run-a');
		if (prompt.outcome !== 'recorded') throw new Error(prompt.reason);
		expect(prompt.fact.original.sha256).toBe(sha(Buffer.from(CANARIES.prompt, 'utf8')));
		if (sibling) {
			expect(sibling.contentReference.safeParse(vibes.fact.original).success).toBe(true);
			expect(sibling.contentReference.safeParse(prompt.fact.original).success).toBe(true);
		}
		expect(capture.status()).toMatchObject({ records: 2, delivery: { available: false } });
		expect(capture.facts().every((f) => f.completeness === 'pending_upload')).toBe(true);
		expect(JSON.stringify(capture.facts())).not.toContain('CANARY');
		expect(contentDeliveryStanding().available).toBe(false);
		// Nothing on the wire installed, carried or delivered content: the handshake, attachments, notices, inbox and one execution so far.
		const handshake = [
			'/v1/registration/challenge',
			'/v1/registration/redeem',
			'attachment',
			'noticeList',
			'inbox',
			'execution',
		];
		expect(wireOperations()).toEqual(new Set(handshake));
	});

	it('fleet evidence: the run ends under a host revocation and settles its usage as estimated; the pump hands every runtime-family event to the double once under the contract and withholds the inventory by family; canaries stay off the wire and the prompt out of the journal; a resend is a duplicate and another boot is refused', async () => {
		// The host withdraws the lease (labeled: no command producer delivers a cancel here; the commands case below cancels a second run): the sink stops the process.
		expect(service.dispatch.authority.revokeAll('the operator stopped the run')).toBe(1);
		expect((await live.exited).signal).toBe('SIGTERM');
		expect(alive(live.child.pid!)).toBe(false);
		expect(live.revocations).toEqual(['the operator stopped the run']);
		expect(service.dispatch.receipt(live.lease.leaseId)?.effect.state).toBe('revoked');
		clock += 4_000;
		const detail = `stopped after ${CANARIES.token} at ${CANARIES.path}`;
		const ended = fact({
			lineage,
			admission,
			state: 'cancelled',
			ledgerStatus: 'cancelled',
			detail,
		});
		expect(service.events.record(ended)[0]).toMatchObject({
			kind: 'run-state',
			run: { state: 'cancelled' },
		});

		const usage = createUsageCapture({
			events: service.events,
			identity: () => service.lifecycle.status().identity,
			// The real resolver reads the agent's layers; here the account is a labeled digest.
			accountRef: () => CANARIES.account,
			now,
		});
		const report = { model: 'gpt-5-codex', inputTokens: 1_600, outputTokens: 80 };
		usage.observe('agent-pair-ai-tab-1', 'codex', { ...report, prompt: CANARIES.prompt } as never);
		const [settled] = usage.settle({
			...fact({ state: 'cancelled' }),
			lineage,
			admission,
			total: {
				inputTokens: 1_600,
				outputTokens: 80,
				cacheReadInputTokens: 1_300,
				cacheCreationInputTokens: 0,
				totalCostUsd: 0,
				contextWindow: 272_000,
			},
		});
		expect(settled).toMatchObject({ kind: 'usage', context: { traceId: 'trace-run-a' } });
		expect(settled.usage).toMatchObject({ provenance: 'estimated', accountRef: CANARIES.account });
		expect(settled.usage.attribution).toEqual({ tenantId: 'tenant-pair', orgId: 'org-pair' });
		const events: readonly ManagedLifecycleEvent[] = service.events.recent();
		expect(events.map((e) => e.kind).join()).toBe(
			'inventory,decision,run-state,run-state,run-state,usage'
		);
		expect(delivery()).toEqual({ pending: 6, uncertain: 0, received: 0 });

		const pass = await service.telemetry.pump();
		expect(pass).toMatchObject({ outcome: 'sent', received: 5, withheld: { family: 1 } });
		expect(await service.telemetry.pump()).toMatchObject({ outcome: 'idle', taken: 0 });
		expect(denials).toEqual([]);
		const sent = events.filter((e) => e.kind !== 'inventory');
		const inventory = events.find((e) => e.kind === 'inventory') as ManagedInventoryEvent;
		// Known-source comparison: the spool against the projector's events, in order, once each.
		expect([...spool.keys()]).toEqual(sent.map((e) => e.eventId));
		for (const event of sent) {
			expect(spool.get(event.eventId)).toMatchObject({
				sequence: event.sequence,
				occurredAt: event.occurredAt,
				bootId: service.installation.processEpoch,
				instanceId: service.installation.installationId,
				deviceId: 'enr-pair',
				family: event.kind === 'usage' ? 'usage' : 'agent.lifecycle',
				policyRevision: PAIR_POLICY_REVISION,
				usageProvenance: event.kind === 'usage' ? 'estimated' : 'unavailable',
			});
		}
		expect(delivery()).toEqual({ pending: 1, uncertain: 0, received: 5 });
		await service.eventJournal.flush();
		const journalFile = path.join(dir, 'maestro-managed-events.json');
		const written = JSON.parse(fs.readFileSync(journalFile, 'utf8')) as {
			entries: { eventId: string; delivery: string; attempts: number; event: { kind: string } }[];
		};
		const received = written.entries.filter((e) => e.delivery === 'received').map((e) => e.eventId);
		expect(received).toEqual([...spool.keys()]);
		const kept = written.entries.find((e) => e.event.kind === 'inventory');
		expect(kept).toMatchObject({ eventId: inventory.eventId, delivery: 'pending', attempts: 0 });
		// The inventory is withheld by name; its fact fits the sibling's fleet shape, which no runtime source may carry.
		const standing = service.host.telemetryStanding();
		if (!standing.ok) throw new Error(standing.reason);
		const withheld = telemetryReportOf(inventory, standing.binding);
		expect(withheld).toMatchObject({ ok: false, reason: 'family' });
		expect(INVENTORY_DELIVERY.available).toBe(false);
		const { device, runtimes, completeness } = inventory.inventory;
		expect(device).toMatchObject({ deviceId: 'enr-pair' });
		const fleetShape = { device, runtimes, completeness };
		if (sibling) expect(sibling.fleetInventory.safeParse(fleetShape).success).toBe(true);
		// Canaries: nothing of the work crossed the socket; the journal keeps the detail and the account digest, never the prompt.
		const wire = JSON.stringify(fake.calls);
		const offWire = [evidenceSha, 'agent-pair', 'thread-pair', 'tab-1', '1600', 'trace-', 'lease-'];
		for (const canary of [...Object.values(CANARIES), ...offWire])
			expect(wire).not.toContain(canary);
		const journal = fs.readFileSync(journalFile, 'utf8');
		expect(journal).toContain(CANARIES.token);
		expect(journal).toContain(CANARIES.account);
		expect(journal).toContain('trace-run-b');
		expect(journal).not.toContain(CANARIES.prompt);
		// The same id again through the real port: the double answers duplicate and spools nothing new; another boot is refused.
		const projected = telemetryReportOf(sent[0]!, standing.binding);
		if (!projected.ok) throw new Error(projected.detail);
		const again = await service.host.telemetry!.report(projected.report);
		expect(again).toMatchObject({ status: 'ok', payload: { duplicate: true } });
		expect(spool.size).toBe(5);
		const foreign = await service.host.telemetry!.report({
			...projected.report,
			bootId: 'epoch-other',
		});
		expect(foreign).toMatchObject({ status: 'denied', reason: 'unauthenticated' });
		expect(denials).toEqual([{ operation: 'telemetry', reason: 'unauthenticated' }]);
	}, 20_000);

	// --- Commands: the real service refuses every one (its registration names no actor: CP-01/CP-04); the harness
	// service is the same real composition with the actor id supplied, and says so. ---
	type CommandOver = Omit<Partial<ManagedRuntimeCommand>, 'recipient'> & {
		recipient?: Partial<ManagedRuntimeCommand['recipient']>;
	};
	const command = ({ recipient, ...rest }: CommandOver = {}): ManagedRuntimeCommand => {
		const kind = rest.action?.kind ?? 'cancel-run';
		return {
			commandId: `cmd-${kind}`,
			tenantId: 'tenant-pair',
			issuerId: 'issuer-pair',
			recipient: {
				actorId: 'actor-pair',
				enrollmentId: 'enr-pair',
				installationId: service.installation.installationId,
				runtimeId: service.installation.runtimeId,
				processEpoch: service.installation.processEpoch,
				runId: 'run-c',
				...recipient,
			},
			action: { kind: 'cancel-run' },
			preconditions: {
				policyRevision: PAIR_POLICY_REVISION,
				requiredCapability: `command-${ENDPOINT_COMMAND_ACTIONS[kind]}`,
				policyDigest: null,
				bindingDigest: null,
			},
			approval: { kind: 'policy-not-required', policyRevision: PAIR_POLICY_REVISION },
			issuedAt: new Date(now() - 1_000).toISOString(),
			expiresAt: new Date(now() + 60_000).toISOString(),
			nonce: sha(`nonce-${kind}`),
			idempotencyKey: `idem-${kind}`,
			payloadDigest: DIGEST_A,
			releaseId: null,
			...rest,
		};
	};
	/** The real standing with the actor id the registration never carried: what a registration producer would supply (CP-01/CP-04). */
	const withActor = (): ManagedEnrollmentStatus => {
		const status = service.lifecycle.status();
		const record = status.identity.record;
		if (!record?.registration) return status;
		return {
			...status,
			identity: {
				...status.identity,
				record: { ...record, registration: { ...record.registration, actorId: 'actor-pair' } },
			},
		};
	};

	it('commands: the real service refuses every command by name (no actor); with the actor supplied, cancel_run revokes a second real child (exit observed), report_status leaks no path, program text, canary or run id, refresh_policy re-attaches, pause and resume are refused by name, and stale or replayed control is denied with no record', async () => {
		expect(service.lifecycle.status().identity.record?.registration?.actorId).toBeNull();
		expect(await service.commands.receive(command({ commandId: 'cmd-real' }))).toMatchObject({
			status: 'denied',
			reason: 'unauthenticated',
			detail: expect.stringContaining('names no actor'),
		});
		expect(service.commands.status().commands.total).toBe(0);
		harness = createCommandService({
			installation: service.installation,
			lifecycle: { status: withActor },
			host: service.host,
			policy: service.policy,
			dispatch: service.dispatch,
			inventory: service.inventory,
			file: path.join(dir, 'harness-commands.json'),
			now,
		});
		expect((await harness.load()).ok).toBe(true);
		expect(harness.unsupported().map((u) => u.kind)).toEqual([
			'pause-run',
			'resume-run',
			'operator-prompt',
		]);

		// cancel_run: a second real child under its own run, admitted through the real bridge; the lease is revoked and the process ends.
		second = await admitChild(verify('run-c', null));
		expect(second.lease.decision).toMatchObject({ decisionId: 'decision-2' });
		expect(alive(second.child.pid!)).toBe(true);
		expect(service.dispatch.receipt(second.lease.leaseId)?.effect.state).toBe('bound');
		const cancelled = await harness.receive(command({ commandId: 'cmd-cancel-1' }));
		expect(cancelled).toMatchObject({
			status: 'completed',
			commandId: 'cmd-cancel-1',
			duplicate: false,
		});
		expect((await second.exited).signal).toBe('SIGTERM');
		expect(alive(second.child.pid!)).toBe(false);
		expect(second.lease.state()).toBe('revoked');
		expect(second.revocations).toEqual([expect.stringContaining('cmd-cancel-1')]);
		expect(service.dispatch.receipt(second.lease.leaseId)?.effect.state).toBe('revoked');
		expect(service.dispatch.authority.live()).toEqual([]);
		// The same command again: answered from the ledger, nothing revoked twice.
		expect(await harness.receive(command({ commandId: 'cmd-cancel-1' }))).toMatchObject({
			status: 'completed',
			duplicate: true,
		});
		expect(second.revocations).toHaveLength(1);

		// report_status: the installation and the standing, never the work.
		const report = await harness.receive(
			command({ action: { kind: 'report-status' }, recipient: { runId: null } })
		);
		expect(report).toMatchObject({ status: 'completed', commandId: 'cmd-report-status' });
		const facts = JSON.stringify(report.status === 'completed' ? report.facts : null);
		expect(facts).toContain(service.installation.installationId);
		const secrets = [process.execPath, dir, 'setInterval', 'synthetic', 'CANARY', 'run-a', 'run-c'];
		for (const secret of secrets) expect(facts).not.toContain(secret);

		// refresh_policy: one more attachment on the wire, the registration kept.
		const attachments = operations('attachment').length;
		const refresh = command({
			action: { kind: 'refresh-policy', desiredRevision: PAIR_POLICY_REVISION },
			recipient: { runId: null },
		});
		expect(await harness.receive(refresh)).toMatchObject({
			status: 'completed',
			commandId: 'cmd-refresh-policy',
		});
		expect(operations('attachment')).toHaveLength(attachments + 1);
		expect(service.lifecycle.status().authority).toBe('registered');
		for (const kind of ['pause-run', 'resume-run'] as const) {
			expect(await harness.receive(command({ action: { kind } }))).toMatchObject({
				status: 'denied',
				reason: 'unsupported-capability',
				detail: `this host does not execute command-${ENDPOINT_COMMAND_ACTIONS[kind]}`,
			});
		}

		// Stale or replayed control: denied with no record on the ledger.
		const total = harness.status().commands.total;
		const fresh = (id: string, over: CommandOver = {}) =>
			command({
				commandId: id,
				nonce: sha(id),
				idempotencyKey: `idem-${id}`,
				recipient: { runId: null },
				action: { kind: 'report-status' },
				...over,
			});
		const denied = async (raw: ManagedRuntimeCommand, reason: string, detail?: RegExp) => {
			const out = await harness.receive(raw);
			expect(out).toMatchObject({ status: 'denied', reason });
			if (detail && out.status === 'denied') expect(out.detail).toMatch(detail);
		};
		await denied(
			fresh('stale-epoch', { recipient: { runId: null, processEpoch: 'epoch-other' } }),
			'stale-run',
			/process epoch/
		);
		await denied(fresh('lapsed', { expiresAt: new Date(now() - 1).toISOString() }), 'expired');
		await denied(
			fresh('other-tenant', { tenantId: 'tenant-other' }),
			'stale-run',
			/another tenant/
		);
		await denied(fresh('nonce-reuse', { nonce: sha('nonce-cancel-run') }), 'replay');
		await denied(fresh('key-reuse', { idempotencyKey: 'idem-cancel-run' }), 'replay');
		expect(harness.status().commands.total).toBe(total);
		const ledger = fs.readFileSync(path.join(dir, 'harness-commands.json'), 'utf8');
		expect(ledger).toContain('cmd-cancel-1');
		for (const id of ['stale-epoch', 'lapsed', 'other-tenant', 'nonce-reuse', 'key-reuse'])
			expect(ledger).not.toContain(id);
	}, 20_000);
});
