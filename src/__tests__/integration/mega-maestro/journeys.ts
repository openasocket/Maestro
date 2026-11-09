/**
 * The paired journeys: what the real pair must show on each Maestro launch
 * surface, as one catalog the container driver (`scripts/mega-maestro-pair.mjs
 * run`) and the integration tests run through the same code. Every journey
 * speaks to an endpoint through the real socket client, builds the real
 * adapter, verifier and sink ports (the headless authority, the desktop
 * process-manager port) and runs the declared harmless provider program
 * below under the Node permission model. Nothing here fakes an endpoint,
 * mints a lease, approves a registration or dispatches to a peer agent, and
 * every wait is bounded. A journey whose producer is missing still runs and
 * records what the endpoint answered; `assessJourney` turns an outcome into
 * passed, failed or blocked by the named producer, and a missing producer
 * never counts as passed.
 *
 * The same file holds the 19 mandatory acceptance rows (`ACCEPTANCE_ROWS`),
 * the cases each needs from the pair, CLI and Electron runners with their
 * declared inputs, the independent effect and receipt observers, and
 * `assessAcceptance`, which keeps a row pending until every case ran against
 * the exact paired artifacts and never counts a fixture endpoint or a
 * browser render as the desktop.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as Lib from '../../../shared/maestro-lib/index';
import type { DispatchReceiptRecord } from '../../../main/enterprise/dispatch';
import type { createProcessSpawnAuthority } from '../../../main/enterprise/spawn-authority';
import type { AdmissionOutcome } from '../../../shared/maestro-lib/managed/authority';
import type {
	EndpointPort,
	EndpointStatus,
	ManagedIdentityRecord,
	ManagedIdentityView,
} from '../../../shared/maestro-lib/managed/endpoint-port';
import type { HarnessRouteRequest } from '../../../shared/maestro-lib/managed/provider-route';
import type {
	ManagedInstallationIdentity,
	ManagedOrigin,
	ManagedPrincipalRef,
	ManagedRunIdentity,
} from '../../../shared/maestro-lib/managed/types';

export const SYNTHETIC_EFFECTS_FILE = 'synthetic-provider-effects.json';

/**
 * The provider double, as an inline program for the harness route. Declared
 * harmless: it reads its input from stdin, tries one loopback connection,
 * one child, one declared read and one undeclared read, writes one JSON
 * file into its cwd, prints one JSON line and exits 0. Every attempt is
 * recorded as it went, refusal included.
 */
export const SYNTHETIC_PROVIDER_SOURCE = String.raw`
'use strict';
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const effects = { wroteFile: '', stdinBytes: 0, connected: false, spawnedChild: false, readDeclared: false, readUndeclared: false, cwd: process.cwd(), pid: process.pid };
const code = (error) => (error && error.code) || String(error);
const tryRead = (file) => { if (!file) return false; try { fs.readFileSync(file); return true; } catch (error) { return code(error); } };
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
	const raw = Buffer.concat(chunks);
	effects.stdinBytes = raw.length;
	let input = {};
	try { input = JSON.parse(raw.toString('utf8')); } catch {}
	try {
		const { spawnSync } = require('node:child_process');
		// Only the descendant writes this marker; the parent never reports it as evidence.
		const childScript = input.childMarker
			? 'require("node:fs").writeFileSync(process.argv[1], String(process.pid))' : '0';
		const child = spawnSync(process.execPath, ['-e', childScript, ...(input.childMarker ? [input.childMarker] : [])], { timeout: 1000 });
		effects.spawnedChild = child.error ? code(child.error) : true;
	} catch (error) { effects.spawnedChild = code(error); }
	effects.readDeclared = tryRead(input.declaredFile);
	effects.readUndeclared = tryRead(input.undeclaredFile);
	const finish = () => {
		const file = path.join(process.cwd(), '${SYNTHETIC_EFFECTS_FILE}');
		effects.wroteFile = file;
		try { fs.writeFileSync(file, JSON.stringify(effects)); }
		catch (error) { effects.wroteFile = 'refused:' + code(error); }
		process.stdout.write(JSON.stringify({ type: 'synthetic-provider', effects }) + '\n');
		if (input.holdOpen) setInterval(() => {}, 1000);
		else process.exit(0);
	};
	const port = Number(input.probePort || 0);
	if (!port) return finish();
	try {
		const socket = net.connect({ host: '127.0.0.1', port });
		socket.once('connect', () => { effects.connected = true; socket.end(); finish(); });
		socket.once('error', (error) => { effects.connected = code(error); finish(); });
	} catch (error) { effects.connected = code(error); finish(); }
});
`;

// ---------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------

export type PairSurface = 'library' | 'headless' | 'desktop';
export const PAIR_SURFACES: readonly PairSurface[] = ['library', 'headless', 'desktop'];

/** The producers a journey needs before its outcome can count: the coordination prerequisites and the registration approval. */
export type PairProducerId = 'CP-01' | 'CP-02' | 'CP-03' | 'registration-approval';

export interface PairJourney {
	id: string;
	surface: PairSurface;
	title: string;
	requires: readonly PairProducerId[];
}

export const PAIR_JOURNEYS: readonly PairJourney[] = [
	{
		id: 'library.handshake',
		surface: 'library',
		title: 'compatibility, attachment and actor registration over the real socket',
		requires: ['registration-approval'],
	},
	{
		id: 'library.admit',
		surface: 'library',
		title:
			'the adapter authority admits a launch through the real broker and the raw execution answers',
		requires: ['CP-01', 'registration-approval'],
	},
	{
		id: 'headless.turn',
		surface: 'headless',
		title:
			'the headless authority admits the harness program and startTurn runs it under the lease',
		requires: ['CP-01', 'CP-02', 'registration-approval'],
	},
	{
		id: 'desktop.admit',
		surface: 'desktop',
		title: 'the desktop process-manager port verifies an in-process chat turn and admits it',
		requires: ['CP-01', 'registration-approval'],
	},
	{
		id: 'desktop.workflow',
		surface: 'desktop',
		title:
			'the desktop port claims an Auto Run owner fence through the workflow producer and admits the fenced attempt',
		requires: ['CP-01', 'CP-03', 'registration-approval'],
	},
];

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

/** The library surface the journeys use: the same names from the built bundle and from the source index. */
export type JourneyLib = Pick<
	typeof Lib,
	| 'MAESTRO_LIB_VERSION'
	| 'MANAGED_CONTRACT_VERSION'
	| 'SYNTHETIC_HARNESS_MODEL'
	| 'createManagedHostAdapter'
	| 'createContextVerifier'
	| 'inProcessContext'
	| 'buildDispatchSnapshot'
	| 'createHeadlessSpawnAuthority'
	| 'startTurn'
	| 'leaseAdmission'
	| 'harnessRouteProblems'
	| 'buildHarnessLaunchSpec'
	| 'bindingEnrollment'
	| 'bindingDigest'
	| 'createWorkflowOwnership'
	| 'workflowFenceOf'
>;

export interface JourneyDeps {
	lib: JourneyLib;
	port: EndpointPort;
	installation: ManagedInstallationIdentity;
	/**
	 * The identity record this process holds for the endpoint, from what the
	 * attachment answered. Custody is the caller's: the driver builds a labeled
	 * development record, a test its fixture's.
	 */
	identity(status: EndpointStatus | null): ManagedIdentityRecord;
	/** The provider label the endpoint's broker knows the harness program by. */
	provider: string;
	surfaces?: readonly PairSurface[];
	/** A private directory the harness program may write under. */
	workDir: string;
	/** The desktop sink's port factory, bundled into the driver; absent, the desktop journeys are not run. */
	desktop?: { createProcessSpawnAuthority: typeof createProcessSpawnAuthority };
	/** Hand the challenge to the approval producer and wait, bounded; absent, there is no producer. */
	approval?(challenge: unknown): Promise<boolean>;
	timeoutMs?: number;
	now?: () => number;
}

export interface JourneyStep {
	name: string;
	ms: number;
	outcome: unknown;
}

export interface JourneyResult {
	id: string;
	surface: PairSurface;
	status: 'passed' | 'failed' | 'not-run';
	reason: string | null;
	steps: JourneyStep[];
	/** What the independent observers read, beside the journey's own outcome. */
	observations?: Partial<Record<AcceptanceObserver, AcceptanceObservation>>;
}

export interface JourneyRun {
	installation: ManagedInstallationIdentity;
	endpoint: EndpointStatus | null;
	approval: 'approved' | 'no-producer' | 'not-offered';
	journeys: JourneyResult[];
	/** Leases the adapter authority still holds live when the run ends. */
	leases: number;
}

/** An admission outcome without its lease object: what the evidence keeps. */
export function summarizeAdmission(outcome: AdmissionOutcome): Record<string, unknown> {
	if (outcome.state === 'admitted') {
		return {
			state: outcome.state,
			leaseId: outcome.lease.leaseId,
			policyRevision: outcome.policyRevision,
			receipt: outcome.receipt,
		};
	}
	return { ...outcome };
}

export async function runPairJourneys(deps: JourneyDeps): Promise<JourneyRun> {
	const { lib, port, installation } = deps;
	const now = deps.now ?? (() => Date.now());
	const timeoutMs = deps.timeoutMs ?? 10_000;
	const surfaces = deps.surfaces ?? PAIR_SURFACES;
	const run: JourneyRun = {
		installation,
		endpoint: null,
		approval: 'not-offered',
		journeys: [],
		leases: 0,
	};
	let counter = 0;
	const ids = (): ManagedRunIdentity => {
		counter += 1;
		return {
			requestId: `pair-req-${counter}`,
			idempotencyKey: `pair-key-${counter}`,
			attemptId: `pair-att-${counter}`,
			runId: `pair-run-${counter}`,
			rootRunId: `pair-run-${counter}`,
			parentRunId: null,
		};
	};
	const actor: ManagedPrincipalRef = { kind: 'service', id: 'pair-journeys' };
	const workDir = (name: string): string => {
		const dir = path.join(deps.workDir, name);
		fs.mkdirSync(dir, { recursive: true });
		return fs.realpathSync(dir);
	};

	async function journey(
		spec: PairJourney,
		body: (
			step: <T>(name: string, fn: () => Promise<T> | T) => Promise<T>,
			observe: (kind: AcceptanceObserver, observation: AcceptanceObservation) => void
		) => Promise<boolean>
	): Promise<boolean> {
		const result: JourneyResult = {
			id: spec.id,
			surface: spec.surface,
			status: 'not-run',
			reason: null,
			steps: [],
		};
		run.journeys.push(result);
		if (!surfaces.includes(spec.surface)) {
			result.reason = 'surface not selected';
			return false;
		}
		const step = async <T>(name: string, fn: () => Promise<T> | T): Promise<T> => {
			const started = now();
			const outcome = await fn();
			result.steps.push({ name, ms: now() - started, outcome });
			return outcome;
		};
		const observe = (kind: AcceptanceObserver, observation: AcceptanceObservation) => {
			result.observations = { ...result.observations, [kind]: observation };
		};
		try {
			const passed = await body(step, observe);
			result.status = passed ? 'passed' : 'failed';
		} catch (error) {
			result.status = 'failed';
			result.reason = String((error as Error)?.stack ?? error);
		}
		return result.status === 'passed';
	}
	const find = (id: string): PairJourney => PAIR_JOURNEYS.find((j) => j.id === id)!;

	// library.handshake: always runs, every other journey stands on its attachment.
	const components = [{ id: 'maestro-lib', kind: 'runtime', version: lib.MAESTRO_LIB_VERSION }];
	const attach = () =>
		port.attach({
			...installation,
			components,
			supportedProtocols: [1],
			supportedCapabilities: ['attachment', 'compatibility', 'execution', 'telemetry'],
			requiredCapabilities: [],
		});
	await journey({ ...find('library.handshake'), surface: 'library' }, async (step) => {
		await step('compatibility', () =>
			port.compatibility({ protocol: 1, components, requiredCapabilities: [] })
		);
		let status = await step('attach', attach);
		const challenge = await step('registration.challenge', () =>
			port.registration.challenge({
				runtimeId: installation.runtimeId,
				processEpoch: installation.processEpoch,
			})
		);
		if (challenge.status === 'ok') {
			const approved = deps.approval ? await deps.approval(challenge.payload) : false;
			run.approval = approved ? 'approved' : 'no-producer';
			if (approved) {
				await step('registration.redeem', () => port.registration.redeem());
				status = await step('attach.registered', attach);
			}
		}
		if (status.status === 'ok') run.endpoint = status.payload;
		return port.state().registration === 'registered' && port.state().attached;
	});

	const record = deps.identity(run.endpoint);
	const view: ManagedIdentityView = { status: 'ok', reason: null, message: null, record };
	const standing = () => {
		const connection = port.state();
		const ok =
			connection.attached &&
			connection.registration === 'registered' &&
			connection.status?.management === 'managed';
		return {
			identity: view,
			connection,
			endpoint: connection.status,
			authority: ok ? ('registered' as const) : ('none' as const),
			reason: ok ? null : 'not registered-attached-managed in this process',
			pendingApproval: null,
			lastDenial: null,
		};
	};
	const adapter = lib.createManagedHostAdapter({
		installation,
		identity: { read: () => view },
		endpoint: port,
		status: standing,
		now,
	});
	const verifier = lib.createContextVerifier({
		verifierId: 'pair-journeys',
		peer: 'in-process',
		now,
		accept: () => [],
	});
	const policyRevision = run.endpoint?.appliedPolicyRevision ?? null;
	const context = (origin: Extract<ManagedOrigin, 'headless' | 'cli'>) => {
		const verified = verifier.verify(
			lib.inProcessContext({
				installation,
				origin,
				actor,
				delegation: { chain: [], grantRef: null },
				identity: ids(),
				policyRevision,
				workflow: null,
				traceId: `pair-trace-${counter}`,
				requestedCapabilities: ['runs.submit'],
			})
		);
		if (!verified.ok) throw new Error(`context refused: ${verified.problems.join('; ')}`);
		return verified.context;
	};
	const attribution = {
		provider: deps.provider,
		model: lib.SYNTHETIC_HARNESS_MODEL,
		resourceIds: [],
	};
	const launchOnly = (cwd: string) =>
		lib.buildDispatchSnapshot(
			{ command: process.execPath, args: ['-e', 'process.exit(0)'], cwd, env: {} },
			attribution
		);
	const request = (dir: string): HarnessRouteRequest => ({
		script: SYNTHETIC_PROVIDER_SOURCE,
		inputs: [],
		workDir: dir,
		timeoutMs,
		stdin: JSON.stringify({ prompt: 'pair journey' }),
	});

	await journey(find('library.admit'), async (step) => {
		const admitted = await step('execution.admit', async () =>
			summarizeAdmission(
				await adapter.authority.admit({
					context: context('headless'),
					snapshot: launchOnly(workDir('library')),
					policy: adapter.policy(),
				})
			)
		);
		const raw = await step('execution.raw', () =>
			port.invoke('execution', {
				requestId: 'pair-raw-1',
				attemptId: 'pair-raw-1',
				runId: 'pair-raw-run',
				source: 'headless',
				operation: 'start',
				arguments: [],
				resources: [],
				provider: deps.provider,
				model: lib.SYNTHETIC_HARNESS_MODEL,
				policyRevision: policyRevision ?? 0,
			})
		);
		return admitted.state === 'admitted' && raw.status === 'ok';
	});

	await journey(find('headless.turn'), async (step, observe) => {
		const enrollment = lib.bindingEnrollment(record);
		const unsigned = {
			contractVersion: lib.MANAGED_CONTRACT_VERSION,
			...enrollment,
			enrolledAt: new Date(now()).toISOString(),
		};
		const headless = lib.createHeadlessSpawnAuthority({
			installation,
			binding: {
				state: 'enrolled',
				record: { ...unsigned, digest: lib.bindingDigest(unsigned) },
				file: path.join(deps.workDir, 'managed-binding.json'),
			},
			host: adapter,
			origin: 'headless',
			actor,
			now,
		});
		await step('headless.standing', () => ({
			standing: headless.standing(),
			unavailableReason: headless.unavailableReason,
		}));
		const verified = headless.context({
			identity: ids(),
			traceId: `pair-trace-${counter}`,
			policyRevision,
		});
		if (!verified.ok) throw new Error(`headless context refused: ${verified.problems.join('; ')}`);
		const dir = workDir('headless');
		const harness = request(dir);
		const problems = lib.harnessRouteProblems(harness);
		if (problems.length > 0) throw new Error(`harness route refused: ${problems.join('; ')}`);
		const spec = lib.buildHarnessLaunchSpec(harness);
		const admitted = await headless.authority.admit({
			context: verified.context,
			snapshot: lib.buildDispatchSnapshot(spec, attribution),
			policy: headless.policy(),
		});
		await step('headless.admit', () => summarizeAdmission(admitted));
		if (admitted.state !== 'admitted') return false;
		const exit = await step(
			'headless.turn',
			() =>
				lib.startTurn(
					spec,
					{},
					{
						admission: {
							gate: lib.leaseAdmission(headless.authority, admitted.lease),
							attribution,
						},
						stopGraceMs: 1_000,
						stdoutTailLimit: 4_096,
						stderrTailLimit: 4_096,
					}
				).done
		);
		// Read off disk by the observer, never from what the program printed.
		const effects = await step('headless.effects', () => observeHarnessEffects(dir));
		observe('effect', effects);
		await step('headless.lease', () => admitted.lease.ended());
		return exit.exitCode === 0 && effects.observed && admitted.lease.state() === 'released';
	});

	const desktopPort = deps.desktop
		? deps.desktop.createProcessSpawnAuthority({
				installation,
				identity: { read: () => ({ status: 'ok', record, epoch: 1 }) },
				host: adapter,
				dispatch: { authority: adapter.authority },
				now,
			})
		: null;

	await journey(find('desktop.admit'), async (step) => {
		if (!desktopPort) throw new Error('no desktop port factory was supplied');
		await step('desktop.standing', () => desktopPort.standing());
		const verified = desktopPort.verify({
			actor: { peer: 'in-process' },
			identity: ids(),
			traceId: `pair-trace-${counter}`,
			policyRevision,
			workflow: null,
		});
		if (!verified.ok) throw new Error(`desktop context refused: ${verified.problems.join('; ')}`);
		const admitted = await step('desktop.admit', async () =>
			summarizeAdmission(
				await desktopPort.authority.admit({
					context: verified.context,
					snapshot: launchOnly(workDir('desktop')),
					policy: desktopPort.policy(),
				})
			)
		);
		return admitted.state === 'admitted';
	});

	await journey(find('desktop.workflow'), async (step) => {
		if (!desktopPort) throw new Error('no desktop port factory was supplied');
		const ownership = lib.createWorkflowOwnership({
			file: path.join(deps.workDir, 'maestro-managed-workflows.json'),
			port: () => adapter.workflows,
			owner: () => ({
				ownerId: actor.id,
				authorityId: adapter.authority.authorityId,
				policyRevision,
			}),
			now,
		});
		const identity = ids();
		const claim = await step('workflow.claim', () =>
			ownership.claim({
				workflow: { workflowId: 'pair-autorun', version: '1', triggerEventId: 'pair-trigger-1' },
				runId: identity.runId!,
				attemptId: identity.attemptId,
			})
		);
		const fence = lib.workflowFenceOf(claim);
		if (!fence || fence.fence === null) return false;
		const verified = desktopPort.verify({
			actor: { peer: 'in-process' },
			identity,
			traceId: `pair-trace-${counter}`,
			policyRevision,
			workflow: {
				workflowId: 'pair-autorun',
				version: '1',
				triggerEventId: 'pair-trigger-1',
				ownerEpoch: fence.ownerEpoch,
				fencingToken: fence.fencingToken,
			},
		});
		if (!verified.ok) throw new Error(`fenced context refused: ${verified.problems.join('; ')}`);
		const admitted = await step('desktop.workflow.admit', async () =>
			summarizeAdmission(
				await desktopPort.authority.admit({
					context: verified.context,
					snapshot: launchOnly(workDir('desktop-workflow')),
					policy: desktopPort.policy(),
				})
			)
		);
		return admitted.state === 'admitted';
	});

	run.leases = adapter.authority.live().length;
	return run;
}

// ---------------------------------------------------------------------------
// Assessment: an outcome against the producers it needed
// ---------------------------------------------------------------------------

export interface ProducerStanding {
	/** The producer is present and built from the endpoint source being driven. */
	fresh: boolean;
	detail: string;
}

export interface JourneyAssessment {
	id: string;
	surface: PairSurface;
	observed: JourneyResult['status'];
	verdict: 'passed' | 'failed' | 'blocked' | 'not-run';
	/** The producers that keep the outcome from counting, by coordination id. */
	blockedBy: PairProducerId[];
}

export function assessJourney(
	result: JourneyResult,
	producers: Partial<Record<PairProducerId, ProducerStanding>>
): JourneyAssessment {
	const spec = PAIR_JOURNEYS.find((j) => j.id === result.id);
	const blockedBy = (spec?.requires ?? []).filter((id) => !producers[id]?.fresh);
	const verdict =
		result.status === 'not-run' ? 'not-run' : blockedBy.length > 0 ? 'blocked' : result.status;
	return { id: result.id, surface: result.surface, observed: result.status, verdict, blockedBy };
}

// ---------------------------------------------------------------------------
// The mandatory acceptance rows (MCOMP-33-02)
// ---------------------------------------------------------------------------

/**
 * The 19 mandatory rows of `Plans/integration-completion/program.json`
 * `acceptanceMatrix`, each bound to the cases that must pass for it. A case is
 * run by one runner: `pair` (these journeys in the container), `cli`
 * (maestro-cli against the endpoint) or `electron` (the packaged desktop app,
 * `e2e/managed-full-journey.spec.ts`), and declares the service, native and
 * provider inputs it needs. MCOMP-34-01 executes the real cases; until each
 * ran against the exact paired artifacts, its row stays pending.
 */
export type AcceptanceObserver = 'effect' | 'receipt';
export type AcceptanceRunner = 'pair' | 'cli' | 'electron';
/** Where a case ran, as its runner observed it. A browser render is never the desktop. */
export type AcceptanceHost = 'node' | 'electron' | 'browser';

export interface AcceptanceInput {
	kind: 'producer' | 'service' | 'native' | 'provider';
	id: string;
}

export interface AcceptanceCase {
	id: string;
	runner: AcceptanceRunner;
	title: string;
	requires: readonly AcceptanceInput[];
	/** The independent observations a pass must carry. */
	observes: readonly AcceptanceObserver[];
}

const producer = (id: PairProducerId): AcceptanceInput => ({ kind: 'producer', id });
const service = (id: string): AcceptanceInput => ({ kind: 'service', id });
const [CP01, CP03, REG] = [producer('CP-01'), producer('CP-03'), producer('registration-approval')];
const POLICY = service('MEGA-DESKTOP-POLICY-BUILD');
const PREPARED = service('MEGA-PREPARED-EXECUTION-BUILD');
const ADAPTER = service('MEGA-RUNTIME-ADAPTER-BUILD');
const WORKFLOW = service('MEGA-WORKFLOW-BUILD');
const PROVIDER: AcceptanceInput = { kind: 'provider', id: 'MEGA-QUALIFIED-PROVIDERS-BUILD' };
/** The packaged desktop apps of the pair: an Electron case counts only on one of them. */
const NATIVE: readonly AcceptanceInput[] = ['MACOS', 'WINDOWS'].map((p) => ({
	kind: 'native',
	id: `MAESTRO-APP-${p}-BUILD`,
}));
const [E, R, ER]: AcceptanceObserver[][] = [['effect'], ['receipt'], ['effect', 'receipt']];

const RUN = [CP01, REG, POLICY, PREPARED, PROVIDER];
const FLOW = [CP01, CP03, WORKFLOW, POLICY];
const COLLECT = [POLICY, service('MEGA-COLLECTION-BUILD')];
const COMMANDS = [POLICY, service('MEGA-COMMANDS-BUILD')];

/** Electron cases: id, what it shows, inputs (the native app is added), observations. */
const DESKTOP_CASES: [string, string, AcceptanceInput[], AcceptanceObserver[]][] = [
	['enrollment-revoke', 'enroll, install the signed policy, revoke', [REG, POLICY], R],
	['approved-and-denied-run', 'approved turn runs; stale or denied writes nothing', RUN, ER],
	['autorun-lineage', 'Auto Run lineage; a changed policy denies later', FLOW, ER],
	['cue-prompt-shell-cli', 'Cue prompt, shell and nested CLI under the owner', FLOW, ER],
	['delegated-consult', 'group chat, consult lineage, fence over restart', FLOW, R],
	['credential-route', 'approved route; env or account override refused', [...RUN, ADAPTER], E],
	['secondary-effects', 'plugin, browser, repository effects in scope only', [POLICY], E],
	['fleet-evidence', 'events, usage, vault, VIBES, TRACE match the source', COLLECT, R],
	['commands-notices', 'pause, resume, cancel; notices; replay denied', COMMANDS, ER],
	['standalone', 'unenrolled create, edit, run with no managed state', [], E],
	['agent-create', 'create from approved choices; forged request refused', [POLICY], E],
	['agent-edit-clone-import', 'edit, clone, wizard, import share validation', [POLICY], E],
	['interactive-run-controls', 'chat, tabs, run controls with effects, receipts', RUN, ER],
	['live-policy-revoke', 'live update or revocation; drafts kept, reasons shown', [POLICY], E],
	['offline-restart', 'offline and restart keep enrollment, constraints', [POLICY], E],
	['isolation-accessibility', 'user, org, credential, content isolation; keyboard', [POLICY], E],
];

export const ACCEPTANCE_CASES: readonly AcceptanceCase[] = [
	...PAIR_JOURNEYS.map(
		(j): AcceptanceCase => ({
			id: j.id,
			runner: 'pair',
			title: j.title,
			requires: [
				...j.requires.map(producer),
				...(j.id === 'headless.turn' ? [ADAPTER] : []),
				...(j.surface === 'desktop' ? [POLICY] : []),
				...(j.id === 'desktop.workflow' ? [WORKFLOW] : []),
			],
			observes: j.id === 'headless.turn' ? E : [],
		})
	),
	{
		id: 'cli.dispatch-retry-revoke',
		runner: 'cli',
		title: 'maestro-cli dispatch and retry under a lease; revoked authority, zero effects',
		requires: [CP01, REG, PREPARED],
		observes: ER,
	},
	{
		id: 'cli.standalone',
		runner: 'cli',
		title: 'unmanaged CLI and built library, no endpoint, no Electron',
		requires: [],
		observes: E,
	},
	...DESKTOP_CASES.map(
		([id, title, requires, observes]): AcceptanceCase => ({
			id: `electron.${id}`,
			runner: 'electron',
			title,
			requires: [...requires, ...NATIVE],
			observes,
		})
	),
];

export const ACCEPTANCE_ROWS: readonly { id: string; cases: readonly string[] }[] = [
	{ id: 'enrollment-policy', cases: ['library.handshake', 'electron.enrollment-revoke'] },
	{ id: 'protected-effects', cases: ['headless.turn', 'electron.approved-and-denied-run'] },
	{ id: 'headless-library', cases: ['library.admit', 'headless.turn'] },
	{ id: 'desktop-dispatch', cases: ['desktop.admit', 'electron.approved-and-denied-run'] },
	{ id: 'cli-dispatch', cases: ['cli.dispatch-retry-revoke'] },
	{ id: 'autorun', cases: ['desktop.workflow', 'electron.autorun-lineage'] },
	{ id: 'cue', cases: ['electron.cue-prompt-shell-cli'] },
	{ id: 'delegated-work', cases: ['electron.delegated-consult'] },
	{ id: 'credential-routing', cases: ['electron.credential-route'] },
	{ id: 'secondary-effects', cases: ['electron.secondary-effects'] },
	{ id: 'fleet-evidence', cases: ['electron.fleet-evidence'] },
	{ id: 'commands-notices', cases: ['electron.commands-notices'] },
	{ id: 'standalone', cases: ['cli.standalone', 'electron.standalone'] },
	{ id: 'GUI-01', cases: ['electron.agent-create'] },
	{ id: 'GUI-02', cases: ['electron.agent-edit-clone-import'] },
	{ id: 'GUI-03', cases: ['electron.interactive-run-controls'] },
	{ id: 'GUI-04', cases: ['electron.live-policy-revoke'] },
	{ id: 'GUI-05', cases: ['electron.offline-restart'] },
	{ id: 'GUI-06', cases: ['electron.isolation-accessibility'] },
];

// ---------------------------------------------------------------------------
// Independent observers: what happened, read from where it happened
// ---------------------------------------------------------------------------

export interface AcceptanceObservation {
	observed: boolean;
	/** Which observer read it: the filesystem, the dispatch ledger. */
	by: string;
	detail: unknown;
	problems: string[];
}

const observation = (by: string, detail: unknown, problems: string[]) => ({
	observed: problems.length === 0,
	by,
	detail,
	problems,
});
const realpathOrNull = (file: string): string | null => {
	try {
		return fs.realpathSync(file);
	} catch {
		return null;
	}
};

/**
 * The harness program's effects, read off disk: the file it wrote must exist
 * in `dir`, parse, and say it ran there. `childMarker`, when given, is the
 * file only the program's descendant writes.
 */
export function observeHarnessEffects(dir: string, childMarker?: string): AcceptanceObservation {
	const problems: string[] = [];
	const file = path.join(dir, SYNTHETIC_EFFECTS_FILE);
	let effects: Record<string, unknown> | null = null;
	try {
		effects = JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch {
		problems.push(`no readable ${SYNTHETIC_EFFECTS_FILE} in the work directory`);
	}
	if (effects) {
		const ranIn = typeof effects.cwd === 'string' ? realpathOrNull(effects.cwd) : null;
		if (ranIn === null || ranIn !== realpathOrNull(dir))
			problems.push('the program did not run in the work directory');
		if (effects.wroteFile !== file) problems.push('the program names another effects file');
	}
	const child = childMarker === undefined ? null : fs.existsSync(childMarker);
	return observation('filesystem', { file, effects, childMarker: child }, problems);
}

/**
 * One lease's receipt, read from the dispatch ledger file the desktop writes
 * (`maestro-managed-dispatch-receipts.json`): exactly one record, carrying the
 * broker's central decision and an ended effect. An in-process decision has
 * no central receipt.
 */
export function observeLedgerReceipt(ledgerFile: string, leaseId: string): AcceptanceObservation {
	const problems: string[] = [];
	let record: DispatchReceiptRecord | null = null;
	try {
		const doc = JSON.parse(fs.readFileSync(ledgerFile, 'utf8')) as {
			receipts?: DispatchReceiptRecord[];
		};
		const found = (doc.receipts ?? []).filter((r) => r.leaseId === leaseId);
		if (found.length === 1) record = found[0];
		else problems.push(`${found.length} ledger records for lease ${leaseId}`);
	} catch {
		problems.push('no readable dispatch ledger');
	}
	if (record && !record.decision) problems.push('decided in process: no central receipt');
	if (record && !['released', 'revoked', 'expired'].includes(record.effect?.state))
		problems.push(`the effect has not ended (${record.effect?.state})`);
	const { decision, policyRevision, effect } = record ?? {};
	return observation('dispatch-ledger', { leaseId, decision, policyRevision, effect }, problems);
}

// ---------------------------------------------------------------------------
// Assessment: a row counts only from actual cases over exact paired artifacts
// ---------------------------------------------------------------------------

/** What a runner records of one case. */
export interface AcceptanceCaseEvidence {
	caseId: string;
	status: 'passed' | 'failed' | 'not-run';
	host: AcceptanceHost;
	/** `fixture` is the labeled contract-fixture endpoint: it never counts. */
	endpoint: 'actual' | 'fixture';
	/** The exact paired artifacts the run used; null where the runner could not name one. */
	artifacts: {
		runtimeSha256: string | null;
		endpointRevision: string | null;
		appSha256?: string | null;
	};
	observations: Partial<Record<AcceptanceObserver, AcceptanceObservation>>;
}

export type AcceptanceVerdict = 'passed' | 'failed' | 'pending' | 'not-counted';

export interface AcceptanceCaseAssessment {
	caseId: string;
	verdict: AcceptanceVerdict;
	missingInputs: string[];
	reasons: string[];
}

export function assessAcceptanceCase(
	spec: AcceptanceCase,
	evidence: readonly AcceptanceCaseEvidence[],
	inputs: Readonly<Record<string, boolean>>
): AcceptanceCaseAssessment {
	// Either platform's app satisfies the native input; every other input stands alone.
	const natives = spec.requires.filter((i) => i.kind === 'native');
	const missingInputs = spec.requires
		.filter((i) => i.kind !== 'native' && inputs[i.id] !== true)
		.map((i) => i.id);
	if (natives.length && !natives.some((i) => inputs[i.id] === true))
		missingInputs.push(natives.map((i) => i.id).join(' | '));
	const runs = evidence.filter((e) => e.caseId === spec.id);
	const reasons = runs.length > 1 ? [`${runs.length} records for one case`] : [];
	const done = (verdict: AcceptanceVerdict) => ({
		caseId: spec.id,
		verdict,
		missingInputs,
		reasons,
	});
	const run = runs.length === 1 ? runs[0] : null;
	if (run?.status === 'failed') return done('failed');
	if (!run || run.status === 'not-run') {
		reasons.push('not executed against the paired artifacts');
		return done('pending');
	}
	if (missingInputs.length) return done('pending');
	const host = spec.runner === 'electron' ? 'electron' : 'node';
	if (run.endpoint !== 'actual') reasons.push('ran against the contract-fixture endpoint');
	if (run.host !== host) reasons.push(`ran on ${run.host}, not ${host}`);
	if (!run.artifacts.runtimeSha256 || !run.artifacts.endpointRevision)
		reasons.push('the paired runtime or endpoint is not named');
	if (spec.runner === 'electron' && !run.artifacts.appSha256)
		reasons.push('the packaged desktop app is not named');
	for (const kind of spec.observes)
		if (!run.observations[kind]?.observed) reasons.push(`no independent ${kind} observation`);
	return done(reasons.length ? 'not-counted' : 'passed');
}

/**
 * Every mandatory row against the case evidence and the inputs present. The
 * worst case decides: one failed case fails the row; a case not executed or
 * missing an input keeps it pending; a fixture endpoint, a browser host, an
 * unnamed artifact or a missing observation keeps it from counting.
 */
export function assessAcceptance(
	evidence: readonly AcceptanceCaseEvidence[],
	inputs: Readonly<Record<string, boolean>>
): { id: string; verdict: AcceptanceVerdict; cases: AcceptanceCaseAssessment[] }[] {
	const order: AcceptanceVerdict[] = ['failed', 'pending', 'not-counted', 'passed'];
	return ACCEPTANCE_ROWS.map((row) => {
		const cases = row.cases.map((id) => {
			const spec = ACCEPTANCE_CASES.find((c) => c.id === id);
			if (!spec) throw new Error(`acceptance row ${row.id} names unknown case ${id}`);
			return assessAcceptanceCase(spec, evidence, inputs);
		});
		return { id: row.id, verdict: order.find((v) => cases.some((c) => c.verdict === v))!, cases };
	});
}

/** The inputs present: declared receipts, then the producers' own freshness, which no declaration overrides. */
export function presentAcceptanceInputs(
	producers: Partial<Record<PairProducerId, ProducerStanding>>,
	declared: Readonly<Record<string, boolean>> = {}
): Record<string, boolean> {
	const present: Record<string, boolean> = {};
	for (const [id, ok] of Object.entries(declared)) present[id] = ok === true;
	for (const [id, standing] of Object.entries(producers)) present[id] = standing?.fresh === true;
	return present;
}

/** A pair journey as case evidence: the container ran it on Node against the real endpoint. */
export function pairCaseEvidence(
	result: JourneyResult,
	artifacts: AcceptanceCaseEvidence['artifacts']
): AcceptanceCaseEvidence {
	const { id: caseId, status, observations = {} } = result;
	return { caseId, status, host: 'node', endpoint: 'actual', artifacts, observations };
}
