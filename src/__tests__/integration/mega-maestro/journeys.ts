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
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as Lib from '../../../shared/maestro-lib/index';
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
import { SYNTHETIC_EFFECTS_FILE, SYNTHETIC_PROVIDER_SOURCE } from './fixtures';

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
		body: (step: <T>(name: string, fn: () => Promise<T> | T) => Promise<T>) => Promise<boolean>
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
		try {
			const passed = await body(step);
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

	await journey(find('headless.turn'), async (step) => {
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
		const effectsFile = path.join(dir, SYNTHETIC_EFFECTS_FILE);
		const effects = await step('headless.effects', () =>
			fs.existsSync(effectsFile) ? JSON.parse(fs.readFileSync(effectsFile, 'utf8')) : null
		);
		await step('headless.lease', () => admitted.lease.ended());
		return exit.exitCode === 0 && effects !== null && admitted.lease.state() === 'released';
	});

	// The desktop journeys need the process-manager port bundled into the driver
	// (MRC-12-02A); until then they are recorded as not run, never as passed.
	for (const id of ['desktop.admit', 'desktop.workflow']) {
		run.journeys.push({
			id,
			surface: 'desktop',
			status: 'not-run',
			reason: deps.desktop
				? 'the desktop journeys are not wired in this build'
				: 'no desktop port factory was supplied',
			steps: [],
		});
	}

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
