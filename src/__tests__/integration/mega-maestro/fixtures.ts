/**
 * Fixtures for the Mega-Maestro early-pair tests. Two kinds, each labeled
 * for what it is:
 *
 *   - Discovery of the REAL pair inputs (the built library, the CP-01 pin,
 *     the packaged endpoint artifacts or the sibling checkout, the Linux
 *     host) through the harness script's `check` mode, so a test runs the
 *     real pair when it can and names the missing producer when it cannot.
 *     Nothing here stands in for the endpoint, the adapter or a lease.
 *
 *   - The declared harmless provider double: a Node program that plays the
 *     agent and leaves effects a test can observe INDEPENDENTLY of what the
 *     program says about itself: a file written into its working directory,
 *     a connection attempt against a loopback listener the test owns, a
 *     descendant spawn attempt, a read of a declared and of an undeclared
 *     file. It reaches nothing outside the machine and nothing outside its
 *     working directory; under the Node permission model the connection,
 *     the spawn and the undeclared read are refused and the program reports
 *     the refusal rather than hiding it.
 *
 *   - The composition the deterministic tests run against: the fake daemon
 *     (`src/__tests__/main/enterprise/fakeEndpoint.ts`, a declared double),
 *     the real socket client registered and attached on it, the real host
 *     adapter and the real dispatch bridge. What those tests prove is local
 *     behavior; the real pair is the harness script's job.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';

import { createBrokerDispatch, type BrokerDispatch } from '../../../main/enterprise/dispatch';
import { createLocalEndpointClient } from '../../../main/enterprise/endpoint-client';
import {
	createContextVerifier,
	type ContextVerifier,
} from '../../../shared/maestro-lib/managed/authority';
import type {
	EndpointPort,
	ManagedEnrollmentStatus,
	ManagedIdentityRecord,
	ManagedIdentityView,
} from '../../../shared/maestro-lib/managed/endpoint-port';
import {
	createManagedHostAdapter,
	type ManagedHostAdapter,
} from '../../../shared/maestro-lib/managed/host-adapter';
import {
	inProcessContext,
	type ManagedSendResult,
} from '../../../shared/maestro-lib/managed/operations';
import type { JournalTerminalOutcome } from '../../../shared/maestro-lib/managed/run-journal';
import { SYNTHETIC_EFFECTS_FILE, SYNTHETIC_PROVIDER_SOURCE } from './journeys';
import type {
	ManagedAuthenticatedContext,
	ManagedCapability,
	ManagedCapabilityOffer,
	ManagedInstallationIdentity,
	ManagedOperationContext,
	ManagedPeerAuthentication,
	ManagedPrincipalRef,
	ManagedRunIdentity,
} from '../../../shared/maestro-lib/managed/types';
import {
	startFakeEndpoint,
	type FakeEndpoint,
	type FakeEndpointOptions,
} from '../../main/enterprise/fakeEndpoint';

export const PAIR_HARNESS_SCRIPT = path.resolve(process.cwd(), 'scripts/mega-maestro-pair.mjs');

/** The id the synthetic provider double runs under. The route is `managed/provider-route.ts`. */
export const SYNTHETIC_PROVIDER_ID = 'synthetic-harness';

export interface PairDependency {
	id: string;
	owner: 'maestro' | 'mega-maestro';
	status: 'open';
	detail: string;
}

/** The harness `check` record, typed for what the tests read of it. */
export interface PairCheckReport {
	reportVersion: number;
	checkedAt: string;
	host: { platform: string; node: string; maestroHead: string | null; maestroDirty: boolean };
	library: { status: string; sourceRevision?: string; sourceDirty?: boolean; stale?: boolean };
	pin: { status: 'pinned' | 'absent' | 'malformed' };
	endpointSources: Array<{
		kind: 'packaged' | 'development-checkout';
		status: string;
		certifiable: boolean;
	}>;
	linuxHost: { docker: boolean; linux?: boolean; image: { ref: string; present: boolean } };
	approvalProducer: boolean;
	assessment: { ready: boolean; dependencies: PairDependency[] };
}

export interface RunPairCheckOptions {
	sibling?: string;
	library?: string;
	artifact?: string;
	timeoutMs?: number;
}

/** Run the harness in `check` mode and parse its record. Throws when the script itself fails. */
export function runPairCheck(options: RunPairCheckOptions = {}): PairCheckReport {
	const args = [PAIR_HARNESS_SCRIPT, 'check', '--json'];
	if (options.sibling) args.push('--sibling', options.sibling);
	if (options.library) args.push('--library', options.library);
	if (options.artifact) args.push('--artifact', options.artifact);
	const result = spawnSync(process.execPath, args, {
		encoding: 'utf8',
		timeout: options.timeoutMs ?? 60_000,
	});
	if (result.error) throw result.error;
	if (result.status !== 0 && result.status !== 2) {
		throw new Error(`mega-maestro-pair check exited ${result.status}: ${result.stderr}`);
	}
	return JSON.parse(result.stdout) as PairCheckReport;
}

/** One line naming why the real pair cannot run, for a skip message that says who owns it. */
export function describePairSkip(report: PairCheckReport): string {
	return report.assessment.dependencies
		.map((dependency) => `${dependency.id} (${dependency.owner}): ${dependency.detail}`)
		.join('; ');
}

// ---------------------------------------------------------------------------
// The synthetic provider double and its observers
// ---------------------------------------------------------------------------

/** What the double is told on stdin (JSON): the prompt, and what to probe. */
export interface SyntheticProviderInput {
	prompt: string;
	/** A loopback port to connect to; the test's observer listens there. */
	probePort?: number;
	/** A file the route declared: reading it must succeed. */
	declaredFile?: string;
	/** A file the route did not declare: reading it must be refused. */
	undeclaredFile?: string;
}

export interface SyntheticProviderEffects {
	/** The file the double wrote into its working directory, or `refused:<code>`. */
	wroteFile: string;
	stdinBytes: number;
	/** `true` when a loopback connection was accepted; the error code when it was refused. */
	connected: boolean | string;
	/** `true` when a child process started; the error code when the runtime refused it. */
	spawnedChild: boolean | string;
	/** `true` when the declared file was read; the error code otherwise. */
	readDeclared: boolean | string;
	/** `true` when the undeclared file was read; the error code when the runtime refused it. */
	readUndeclared: boolean | string;
	cwd: string;
	pid: number;
}

// The provider program and its effects file live in journeys.ts so the container
// driver bundle carries no fake endpoint; re-exported here for the tests.
export { SYNTHETIC_EFFECTS_FILE, SYNTHETIC_PROVIDER_SOURCE };

/** Write the double into `dir` as a file (for a launch that takes a path) and return it. */
export function writeSyntheticProvider(dir: string): string {
	const script = path.join(dir, 'synthetic-provider.cjs');
	fs.writeFileSync(script, SYNTHETIC_PROVIDER_SOURCE);
	return script;
}

/** The effects file the double left in `cwd`, or null when nothing ran there. */
export function readSyntheticEffects(cwd: string): SyntheticProviderEffects | null {
	const file = path.join(cwd, SYNTHETIC_EFFECTS_FILE);
	if (!fs.existsSync(file)) return null;
	return JSON.parse(fs.readFileSync(file, 'utf8')) as SyntheticProviderEffects;
}

export interface EgressObserver {
	port: number;
	/** Connections the listener accepted, counted by the test, not reported by the child. */
	connections(): number;
	close(): Promise<void>;
}

/** A loopback listener that counts what reaches it: the independent witness of egress. */
export function startEgressObserver(): Promise<EgressObserver> {
	return new Promise((resolve, reject) => {
		let accepted = 0;
		const server = net.createServer((socket) => {
			accepted += 1;
			socket.end();
		});
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			if (!address || typeof address === 'string') {
				reject(new Error('the observer did not bind a TCP port'));
				return;
			}
			resolve({
				port: address.port,
				connections: () => accepted,
				close: () =>
					new Promise<void>((done) => {
						server.close(() => done());
					}),
			});
		});
	});
}

// ---------------------------------------------------------------------------
// The composition the deterministic tests run against
// ---------------------------------------------------------------------------

export const PAIR_T0 = Date.parse('2026-10-21T12:00:00Z');
export const PAIR_INSTALLATION: ManagedInstallationIdentity = {
	installationId: 'inst-pair',
	runtimeId: 'desktop-pair',
	processEpoch: 'epoch-pair',
};
export const PAIR_POLICY_REVISION = 3;

/** A `broker_dispatched` receipt for the request, the way the daemon answers one. */
export function brokerReceipt(payload: Record<string, unknown>, decisionId: string) {
	return {
		outcome: 'broker_dispatched',
		requestId: payload.requestId,
		attemptId: payload.attemptId,
		runId: payload.runId,
		decisionId,
		requestDigest: 'd'.repeat(64),
		brokerId: 'broker-pair',
		policyRevision: payload.policyRevision,
	};
}

export function pairIdentityRecord(socketPath: string, now: number): ManagedIdentityRecord {
	return {
		version: 1,
		installationId: PAIR_INSTALLATION.installationId,
		tenantId: 'tenant-pair',
		orgId: 'org-pair',
		enrollmentId: 'enr-pair',
		endpoint: { socketPath, bindingDigest: 'a'.repeat(64), trustRootDigest: null },
		management: 'enrolled',
		registration: {
			challengeId: 'challenge-pair',
			actorId: null,
			runtimeId: PAIR_INSTALLATION.runtimeId,
			processEpoch: PAIR_INSTALLATION.processEpoch,
			bindingDigest: 'a'.repeat(64),
			processBirthDigest: null,
			challengeDigest: 'c'.repeat(64),
			expiresAt: new Date(now + 3_600_000).toISOString(),
			registeredAt: new Date(now - 60_000).toISOString(),
		},
		policy: {
			desiredRevision: PAIR_POLICY_REVISION,
			appliedRevision: PAIR_POLICY_REVISION,
			observedAt: new Date(now).toISOString(),
		},
		enrolledAt: new Date(now).toISOString(),
		updatedAt: new Date(now).toISOString(),
	};
}

/** The standing the lifecycle would report for this port and custody view. */
export function pairStanding(
	port: EndpointPort,
	identity: ManagedIdentityView
): ManagedEnrollmentStatus {
	const connection = port.state();
	const registered =
		identity.status === 'ok' &&
		identity.record?.management === 'enrolled' &&
		connection.registration === 'registered' &&
		connection.attached &&
		connection.status?.management === 'managed';
	return {
		identity,
		connection,
		endpoint: connection.status,
		authority: registered ? 'registered' : 'none',
		reason: registered ? null : 'not registered-attached-managed in this process',
		pendingApproval: null,
		lastDenial: null,
	};
}

export interface PairComposition {
	fake: FakeEndpoint;
	port: EndpointPort;
	view: ManagedIdentityView;
	host: ManagedHostAdapter;
	bridge: BrokerDispatch;
	verifier: ContextVerifier;
	ledgerFile: string;
	/** Register and attach the port on the fake again (after a drop, or for a redial). */
	attach(installation?: ManagedInstallationIdentity): Promise<'ok' | string>;
	close(): Promise<void>;
}

export interface PairCompositionOptions {
	dir: string;
	now?: () => number;
	fake?: FakeEndpointOptions;
}

/**
 * The fake daemon, the real client registered and attached on it, the real
 * adapter over an in-memory custody view, the real bridge with a ledger file
 * under `dir`, and a verifier that accepts only this installation's contexts.
 */
export async function composePair(options: PairCompositionOptions): Promise<PairComposition> {
	const now = options.now ?? (() => PAIR_T0);
	let decisions = 0;
	const fake = await startFakeEndpoint({
		registrationRequired: true,
		capabilities: ['execution'],
		now,
		operations: {
			execution: (payload) =>
				brokerReceipt(payload as Record<string, unknown>, `decision-${++decisions}`),
		},
		...options.fake,
	});
	const port = createLocalEndpointClient({ socketPath: fake.socketPath, timeoutMs: 1_000 });
	const view: ManagedIdentityView = {
		status: 'ok',
		reason: null,
		message: null,
		record: pairIdentityRecord(fake.socketPath, now()),
	};
	const host = createManagedHostAdapter({
		installation: PAIR_INSTALLATION,
		identity: { read: () => view },
		endpoint: port,
		status: () => pairStanding(port, view),
		now,
	});
	const ledgerFile = path.join(options.dir, 'maestro-managed-dispatch-receipts.json');
	const bridge = createBrokerDispatch({ host, file: ledgerFile, now });
	await bridge.load();
	const verifier = createContextVerifier({
		verifierId: 'pair-test',
		peer: 'in-process',
		now,
		accept: (context) =>
			context.installation.installationId === PAIR_INSTALLATION.installationId &&
			context.installation.runtimeId === PAIR_INSTALLATION.runtimeId
				? []
				: ['the context names another installation or runtime'],
	});
	async function attach(installation = PAIR_INSTALLATION): Promise<'ok' | string> {
		if (port.state().registration !== 'registered') {
			const challenged = await port.registration.challenge({
				runtimeId: installation.runtimeId,
				processEpoch: installation.processEpoch,
			});
			if (challenged.status !== 'ok') return `challenge ${challenged.status}`;
			const redeemed = await port.registration.redeem();
			if (redeemed.status !== 'ok') return `redeem ${redeemed.status}`;
		}
		const attached = await port.attach({
			...installation,
			components: [{ id: 'maestro', kind: 'maestro', version: '1.1.0-RC' }],
			supportedProtocols: [1],
			supportedCapabilities: ['attachment', 'compatibility', 'execution'],
			requiredCapabilities: ['execution'],
		});
		return attached.status === 'ok'
			? 'ok'
			: `attach ${attached.status}${attached.status === 'denied' ? ` ${attached.reason}` : ''}`;
	}
	return {
		fake,
		port,
		view,
		host,
		bridge,
		verifier,
		ledgerFile,
		attach,
		close: async () => {
			await port.close();
			await fake.close();
		},
	};
}

let contextCounter = 0;

/** A verified context for this installation, with fresh request and attempt ids unless given. */
export function verifiedContext(
	verifier: ContextVerifier,
	overrides: Partial<ManagedOperationContext> & {
		identity?: Partial<ManagedOperationContext['identity']>;
	} = {}
): ManagedAuthenticatedContext {
	contextCounter += 1;
	const { identity, ...rest } = overrides;
	const verified = verifier.verify(
		inProcessContext({
			installation: PAIR_INSTALLATION,
			origin: 'headless',
			actor: { kind: 'service', id: 'pair-test' },
			delegation: { chain: [], grantRef: null },
			identity: {
				requestId: `req-${contextCounter}`,
				idempotencyKey: `key-${contextCounter}`,
				attemptId: `att-${contextCounter}`,
				runId: `run-${contextCounter}`,
				rootRunId: `run-${contextCounter}`,
				parentRunId: null,
				...identity,
			},
			policyRevision: PAIR_POLICY_REVISION,
			workflow: null,
			traceId: `trace-${contextCounter}`,
			requestedCapabilities: ['runs.submit'],
			...rest,
		})
	);
	if (!verified.ok) throw new Error(`context refused: ${verified.problems.join('; ')}`);
	return verified.context;
}

// ---------------------------------------------------------------------------
// The public adapter conformance fixture (MCOMP-03-03)
// ---------------------------------------------------------------------------

/**
 * The pin file's `conformance` section: a secret-free description of what the
 * managed facade answers a consumer, published beside the runtime pin so a
 * counterpart adapter reads the behavior it maps without this repository's
 * private tests. This file holds the shape and the reader; deriving each
 * step's envelope, composing a host from the public exports and running the
 * fixture against it is the continuation's job (MCOMP-03-03A).
 */
export const RUNTIME_CONFORMANCE_FILE = path.resolve(
	process.cwd(),
	'Plans/integration-completion/runtime-conformance.json'
);

type ManagedSendRefusal = Extract<ManagedSendResult, { status: 'refused' }>['reason'];

/** What the declared turn-port double answers on one step; absent on a step, the sink must not be reached. */
export interface ConformanceSinkScript {
	send?: 'queued' | 'started' | { refused: ManagedSendRefusal; message?: string };
	then?: Array<'markDispatched' | `markTerminal:${JournalTerminalOutcome}` | 'markUnknown'>;
	cancel?: 'stopped' | 'dequeued' | 'none';
}

export type ConformanceOperation = 'submit' | 'inspect' | 'cancel' | 'interrupt';

export interface ConformanceStep {
	id: string;
	op: ConformanceOperation;
	identity?: Partial<ManagedRunIdentity>;
	caps?: ManagedCapability[];
	installation?: Partial<ManagedInstallationIdentity>;
	peer?: ManagedPeerAuthentication;
	input?: Record<string, unknown>;
	sink?: ConformanceSinkScript;
	expect: Record<string, unknown>;
}

export interface ConformanceNegotiationCase {
	id: string;
	offer: ManagedCapabilityOffer;
	expect: Record<string, unknown>;
	missingNames?: string[];
}

export interface AdapterConformanceFixture {
	artifactId: string;
	formatVersion: number;
	standing: string;
	contract: {
		managedContract: string;
		endpointProtocol: number;
		transport: ManagedPeerAuthentication;
	};
	invocation: {
		entry: string;
		host: { compose: string[]; rule: string };
		consumer: Record<string, unknown>;
	};
	correlation: string[];
	semantics: Record<string, string>;
	host: {
		installation: ManagedInstallationIdentity;
		actor: ManagedPrincipalRef;
		policyRevision: number;
		agents: Array<{
			agentId: string;
			name: string;
			providerId: string;
			tabIds: string[];
			activeTabId: string;
		}>;
		approvedResourceIds: string[];
		content: Record<string, { text: string; sha256: string }>;
		defaultSubmit: Record<string, unknown>;
	};
	negotiation: { minimumStatus: string; note: string; cases: ConformanceNegotiationCase[] };
	operations: { sink: string; defaults: string; steps: ConformanceStep[] };
}

/** The `conformance` section of the pin file. Throws when the file holds none. */
export function readAdapterConformance(file = RUNTIME_CONFORMANCE_FILE): AdapterConformanceFixture {
	const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { conformance?: unknown };
	if (!parsed.conformance || typeof parsed.conformance !== 'object') {
		throw new Error(`${file} holds no conformance section`);
	}
	return parsed.conformance as AdapterConformanceFixture;
}

/** The capability each operation needs the context to have requested. */
export const CONFORMANCE_OPERATION_CAPABILITY: Record<ConformanceOperation, ManagedCapability> = {
	submit: 'runs.submit',
	inspect: 'runs.inspect',
	cancel: 'runs.cancel',
	interrupt: 'runs.interrupt',
};
