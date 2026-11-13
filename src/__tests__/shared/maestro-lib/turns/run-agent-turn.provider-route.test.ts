/**
 * MCOMP-31-01A: a managed real-provider launch runs only on a route qualified for exactly it.
 * Evidence and verifier are test doubles; the provider is the fake agent replaying a real
 * OpenCode recording. Nothing here qualifies a provider (that is MCOMP-32).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import {
	createContextVerifier,
	createLocalHostAuthority,
} from '../../../../shared/maestro-lib/managed/authority';
import { bindApprovedCredentials } from '../../../../shared/maestro-lib/managed/credentials';
import {
	PROVIDER_ROUTE_ALLOW_CASES,
	PROVIDER_ROUTE_DENY_CASES,
	type ProviderRouteCandidate,
	type ProviderRouteCase,
	type SignedProviderRouteQualification,
} from '../../../../shared/maestro-lib/managed/provider-route';
import { MANAGED_CONTRACT_VERSION } from '../../../../shared/maestro-lib/managed/types';
import type { ManagedRouteCeiling } from '../../../../shared/maestro-lib/launch/env';
import type { ManagedLaunchInput } from '../../../../shared/maestro-lib/launch/launch-plan';
import { assembleTurn, type AssembledTurn } from '../../../../shared/maestro-lib/turns/assemble';
import {
	providerRouteLaunchProblems,
	runAgentTurn,
	type ManagedProviderRouteInput,
	type ManagedTurnAuthority,
} from '../../../../shared/maestro-lib/turns/run-agent-turn';
import { CAPTURED_RECORDINGS } from '../../../main/process-manager/recordings/captured';
import {
	createScratchDir,
	FAKE_AGENT_PATH,
	fakeTurnFromRecording,
	writeFakeTurn,
} from '../run/fakeAgent';
import { makeAgent, makeContext, makeTab } from './fixtures';

const d = (c: string) => c.repeat(64);
const NOW = Date.parse('2026-11-09T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const posixIt = it.skipIf(process.platform === 'win32');

let scratch: { dir: string; cleanup: () => void };
beforeAll(() => {
	scratch = createScratchDir('maestro-run-agent-turn-route');
});
afterAll(() => scratch.cleanup());

function turn(): AssembledTurn {
	const file = writeFakeTurn(
		scratch.dir,
		fakeTurnFromRecording(CAPTURED_RECORDINGS['captured-opencode-normal'])
	);
	const assembled = assembleTurn(
		makeAgent({
			toolType: 'opencode',
			cwd: scratch.dir,
			customEnvVars: { FAKE_AGENT_RECORDING: file },
		}),
		makeTab(),
		{ text: 'hello' },
		makeContext('opencode')
	);
	if (!assembled.ok) throw new Error(assembled.message);
	const t = assembled.turn;
	return {
		...t,
		launch: {
			...t.launch,
			command: process.execPath,
			args: [FAKE_AGENT_PATH, ...t.launch.args],
			// The approved credential's value, looked up the way a server secret is.
			secretLookup: { env: { TEAM_OPENAI_KEY: 'sk-team-sentinel' }, runSecretsDir: '/nonexistent' },
		},
	};
}

const route = (overrides: Partial<ManagedRouteCeiling> = {}): ManagedRouteCeiling => ({
	providerId: 'opencode',
	model: null,
	baseUrl: null,
	accountDir: null,
	login: 'approved-credential',
	permissionMode: null,
	...overrides,
});

function launch(overrides: Partial<ManagedRouteCeiling> = {}): ManagedLaunchInput {
	const pinned = route(overrides);
	const credentials = bindApprovedCredentials(
		[
			{
				contractVersion: MANAGED_CONTRACT_VERSION,
				refId: 'cred-team',
				tenantId: 't',
				actorId: 'a',
				agentId: 'agent-1',
				audience: { providerId: 'opencode', destination: pinned.baseUrl },
				accountRef: null,
				policyRevision: 1,
				issuedAt: '2026-11-09T00:00:00Z',
				expiresAt: '2026-11-10T00:00:00Z',
				status: 'active',
				source: { kind: 'server-secret', secretName: 'TEAM_OPENAI_KEY', envVar: 'OPENAI_API_KEY' },
			},
		],
		{
			tenantId: 't',
			actorId: 'a',
			agentId: 'agent-1',
			providerId: 'opencode',
			destination: pinned.baseUrl,
			accountRef: null,
			policyRevision: 1,
			now: NOW,
		}
	);
	return {
		route: pinned,
		credentials,
		credentialConsumer: { tenantId: 't', actorId: 'a', agentId: 'agent-1', policyRevision: 1 },
		now: NOW,
	};
}

const candidate = (overrides: Partial<ProviderRouteCandidate> = {}): ProviderRouteCandidate => ({
	provider: 'opencode',
	adapterId: 'opencode-cli-v1',
	transport: 'cli-process',
	binary: { digest: d('a'), version: '1.0.0', identity: 'inode:7' },
	os: { platform: 'linux', release: '6.8.0', arch: 'x64' },
	backend: { id: 'bwrap-v1', evidenceDigest: d('b') },
	inputDigest: d('c'),
	...overrides,
});

const observed = (name: ProviderRouteCase, outcome: 'allowed' | 'denied') => ({
	case: name,
	expected: outcome,
	observed: outcome,
	observer: 'process' as const,
	evidenceDigest: d('3'),
});

function evidence(c: ProviderRouteCandidate = candidate()): SignedProviderRouteQualification {
	return {
		payload: {
			version: 1,
			receiptId: 'route-receipt-1',
			producer: {
				owner: 'mega-maestro',
				implementationRevision: 'e'.repeat(40),
				observedRevision: 'e'.repeat(40),
			},
			tier: 'real-cli-fixture-model',
			modelTransport: 'deterministic-fixture',
			route: { provider: c.provider, adapterId: c.adapterId, transport: c.transport },
			binary: { ...c.binary },
			os: { platform: 'linux', release: c.os.release, arch: 'x64' },
			backend: { ...c.backend },
			inputSnapshot: { inputDigest: c.inputDigest, inputs: [['a/bin', d('1')]] },
			observations: [
				...PROVIDER_ROUTE_ALLOW_CASES.map((name) => observed(name, 'allowed')),
				...PROVIDER_ROUTE_DENY_CASES.map((name) => observed(name, 'denied')),
			],
			observedAt: new Date(NOW - DAY).toISOString(),
		},
		payloadDigest: d('5'),
		keyId: 'route-key-1',
		algorithm: 'Ed25519',
		signature: `${'A'.repeat(86)}==`,
	};
}

/** A test double for the host-injected signature check; counts its calls. */
function verifier(verdict: 'verified' | 'invalid' | 'unavailable' = 'verified') {
	const v = { version: 1 as const, calls: 0, verify: async () => ((v.calls += 1), verdict) };
	return v;
}

function routeInput(
	managedLaunch: ManagedLaunchInput,
	overrides: Partial<ManagedProviderRouteInput> = {}
): ManagedProviderRouteInput {
	return {
		evidence: evidence(),
		candidate: candidate(),
		verifier: verifier(),
		gateway: managedLaunch.route.baseUrl,
		credentialBindingDigest: managedLaunch.credentials?.digest ?? '',
		maxAgeMs: 30 * DAY,
		now: () => NOW,
		...overrides,
	};
}

function managed(
	managedLaunch: ManagedLaunchInput | undefined,
	providerRoute: ManagedProviderRouteInput | undefined
) {
	const admits: number[] = [];
	const authority = createLocalHostAuthority({
		authorityId: 'test-authority',
		decide: () => {
			admits.push(1);
			return { decision: 'allow', policyRevision: 1 };
		},
		now: () => 0,
		newId: () => `lease-${admits.length}`,
		leaseTtlMs: 60_000,
	});
	const verified = createContextVerifier({
		verifierId: 'test',
		peer: 'in-process',
		now: () => 0,
		accept: () => [],
	}).verify({
		contractVersion: MANAGED_CONTRACT_VERSION,
		installation: { installationId: 'i', runtimeId: 'r', processEpoch: 'e' },
		origin: 'cli',
		actor: { kind: 'service', id: 'fleet' },
		delegation: { principals: [], delegation: null, grants: [] },
		identity: {
			requestId: 'q',
			idempotencyKey: 'k',
			attemptId: 'a',
			runId: 'run',
			rootRunId: 'run',
			parentRunId: null,
		},
		policyRevision: 1,
		workflow: null,
		traceId: 't',
		requestedCapabilities: ['runs.submit'],
	});
	if (!verified.ok) throw new Error(verified.problems.join());
	const value: ManagedTurnAuthority = {
		authority,
		context: verified.context,
		policy: { sources: [], policyRevision: 1 },
		...(managedLaunch ? { launch: managedLaunch } : {}),
		...(providerRoute ? { providerRoute } : {}),
	};
	return { value, admits };
}

const run = (managedAuthority: ManagedTurnAuthority) =>
	runAgentTurn(turn(), {
		sessionId: 'agent-1-ai-tab-1',
		stopGraceMs: 200,
		managed: managedAuthority,
	});

describe('runAgentTurn: a managed real-provider launch needs a qualified route', () => {
	posixIt('runs on a qualified route and reports the binding it ran on', async () => {
		const l = launch();
		const v = verifier();
		const m = managed(l, routeInput(l, { verifier: v }));
		const started = await run(m.value);
		if (!started.ok) throw new Error(started.message);
		const completed = await started.run.result;
		expect(completed.outcome).toBe('completed');
		expect(v.calls).toBe(1);
		expect(m.admits).toHaveLength(1);
		expect(started.run.providerRoute).toEqual({
			receiptId: 'route-receipt-1',
			payloadDigest: d('5'),
			tier: 'real-cli-fixture-model',
			transport: 'cli-process',
			sandboxBackendId: 'bwrap-v1',
			gateway: null,
			credentialBindingDigest: l.credentials?.digest,
		});
	});

	it('refuses a managed launch with no route evidence, before admission', async () => {
		const m = managed(launch(), undefined);
		const started = await run(m.value);
		expect(started).toMatchObject({ ok: false, reason: 'managed-unavailable' });
		expect(m.admits).toHaveLength(0);
	});

	it('refuses when no trusted verifier is installed, and when verification fails', async () => {
		for (const verify of [undefined, verifier('invalid'), verifier('unavailable')]) {
			const l = launch();
			const m = managed(l, routeInput(l, { verifier: verify }));
			const started = await run(m.value);
			expect(started).toMatchObject({ ok: false, reason: 'managed-unavailable' });
			expect(m.admits).toHaveLength(0);
		}
	});

	it('refuses stale evidence and evidence for another binary, never trying another route', async () => {
		const l = launch();
		const stale = evidence();
		stale.payload.observedAt = new Date(NOW - 60 * DAY).toISOString();
		const other = evidence(candidate({ binary: { digest: d('f'), version: '9', identity: 'x' } }));
		for (const e of [stale, other]) {
			const v = verifier();
			const m = managed(l, routeInput(l, { evidence: e, verifier: v }));
			const started = await run(m.value);
			expect(started).toMatchObject({ ok: false, reason: 'managed-unavailable' });
			if (!started.ok) expect(started.message).toMatch(/not qualified/);
			expect(m.admits).toHaveLength(0);
		}
	});

	it('denies a candidate for another transport or credential binding without asking the verifier', async () => {
		const l = launch();
		const cases: Array<Partial<ManagedProviderRouteInput>> = [
			{ candidate: candidate({ transport: 'persistent-sdk' }) },
			{ credentialBindingDigest: d('9') },
			{ gateway: 'https://gateway.example' },
		];
		for (const overrides of cases) {
			const v = verifier();
			const m = managed(l, routeInput(l, { ...overrides, verifier: v }));
			const started = await run(m.value);
			expect(started).toMatchObject({ ok: false, reason: 'managed-denied' });
			expect(v.calls).toBe(0);
			expect(m.admits).toHaveLength(0);
		}
	});
});

describe('providerRouteLaunchProblems', () => {
	const expected = { providerId: 'opencode', transport: 'cli-process' as const };

	it('accepts a candidate that names this launch', () => {
		const l = launch();
		expect(providerRouteLaunchProblems(routeInput(l), l, expected)).toEqual([]);
	});

	it('refuses a personal provider login and a launch with no approved credential', () => {
		const l = launch({ login: 'provider-login' });
		expect(providerRouteLaunchProblems(routeInput(l), l, expected).join()).toMatch(
			/provider login/
		);
		const bare: ManagedLaunchInput = { ...launch(), credentials: undefined };
		expect(providerRouteLaunchProblems(routeInput(bare), bare, expected).join()).toMatch(
			/no approved credential/
		);
	});

	it('refuses another provider and a candidate with no sandbox backend', () => {
		const l = launch();
		const other = { ...expected, providerId: 'codex' };
		expect(providerRouteLaunchProblems(routeInput(l), l, other).join()).toMatch(/another provider/);
		const noBackend = routeInput(l, {
			candidate: candidate({ backend: { id: '', evidenceDigest: d('b') } }),
		});
		expect(providerRouteLaunchProblems(noBackend, l, expected).join()).toMatch(/sandbox backend/);
	});
});
