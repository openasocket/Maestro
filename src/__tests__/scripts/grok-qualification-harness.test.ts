/**
 * GT1-11-09: the Grok qualification harness end to end, with no provider,
 * credential or network: honest not-run receipts, candidate capability
 * snapshots confined to the harness, owned-process cleanup through the shared
 * termination ladder (on a fake sleeping process), and redaction.
 *
 * Spend admission has its own suite (`grok-qualification-spend.test.ts`).
 *
 * GT1-11-09A adds the pre-spawn isolation preflight rejections: every
 * GT1-11-08B isolation or control guard broken in turn on a synthetic owned
 * fixture, with child_process and fetch spied to prove nothing starts.
 *
 * GT1-11-10B adds the offline-inspection leg (GT1-11-10A): a synthetic shell
 * stand-in, never a real Grok, run only with `--version` / `--help` under the
 * credential-free planned env, and every admission and executor guard.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	CANDIDATE_CAPABILITIES,
	CONFIG_SCHEMA,
	GROK_CONTROL_ENV,
	HARNESS_CAPABILITIES,
	HARNESS_CEILINGS,
	OFFLINE_OUTPUT_CAP_BYTES,
	OFFLINE_PROBES,
	POLICY_BEARING_FLAGS,
	RUNS_ROOT,
	admitCase,
	buildCandidateSnapshot,
	createCaseLifetime,
	defaultConfigFromRunState,
	executeOfflineLeg,
	expandCases,
	main,
	offlineLegCase,
	parseProbeVersion,
	planIsolatedLaunch,
	runOfflineLeg,
	preflightCase,
	productionCapabilityDigest,
	redactDeep,
	runQualification,
	validateConfig,
	validateLaunchEnvironment,
	type CandidateCapability,
	type HarnessCapabilities,
	type IsolationDeclaration,
	type QualificationCase,
	type QualificationConfig,
} from '../../../scripts/grok-qualification/harness';
import { getAgentCapabilities } from '../../../src/shared/maestro-lib/providers/capabilities';
import { buildAgentEnvironment } from '../../../src/shared/maestro-lib/launch/env';

/** Pass-through spies on every child_process entry point (vitest folds both specifiers into one module), so a test can prove none ran. */
const childProcess = vi.hoisted(() => {
	const spies: Array<ReturnType<typeof vi.fn>> = [];
	const factory = async (importOriginal: () => Promise<typeof import('node:child_process')>) => {
		const actual = await importOriginal();
		const wrapped: Record<string, unknown> = { ...actual };
		for (const name of [
			'spawn',
			'spawnSync',
			'exec',
			'execSync',
			'execFile',
			'execFileSync',
			'fork',
		]) {
			const spy = vi.fn((actual as unknown as Record<string, (...a: unknown[]) => unknown>)[name]);
			spies.push(spy);
			wrapped[name] = spy;
		}
		return { ...wrapped, default: wrapped };
	};
	return { spies, factory };
});
vi.mock('node:child_process', (importOriginal) => childProcess.factory(importOriginal as never));
vi.mock('child_process', (importOriginal) => childProcess.factory(importOriginal as never));
const spawnSpies = childProcess.spies;
const fetchSpy = vi.spyOn(globalThis, 'fetch');

const WORKSPACE = path.resolve(__dirname, '../../..');
const RUN_STATE = JSON.parse(
	fs.readFileSync(path.join(WORKSPACE, 'Plans/grok-tier1/run-state.json'), 'utf8')
);
const FAMILIES = RUN_STATE.testEnvironment.cases;
const NOW = new Date('2026-11-01T12:00:00.000Z');
const clock = () => NOW;
const ALL_CAPS: HarnessCapabilities = {
	isolationPreflight: true,
	atomicSpendAdmission: true,
	// Off: these suites decide admission only; the offline executor has its own block (GT1-11-10B).
	offlineExecutor: false,
	caseExecutor: true,
};
/** A secret-shaped value the shared redactor recognizes; synthetic, never a credential. */
const FAKE_TOKEN = `ghp_${'A1b2C3d4E5'.repeat(4).slice(0, 36)}`;
let runSeq = 0;
const runId = () => `gt1-11-09-${process.pid}-${++runSeq}`;

/** Every admission input present except an audited isolation boundary. */
function liveConfig(patch: Partial<QualificationConfig> = {}): QualificationConfig {
	return {
		...defaultConfigFromRunState({}),
		authorizationReference: 'auth:gt1-11-09-synthetic',
		expiresAt: new Date(NOW.getTime() + 3600_000).toISOString(),
		credentialReferences: [
			{ provider: 'grok', account: 'A', kind: 'secret-name', name: 'GROK_QUAL_ACCOUNT_A' },
			{ provider: 'grok', account: 'B', kind: 'secret-name', name: 'GROK_QUAL_ACCOUNT_B' },
		],
		allowedRoots: [`${RUNS_ROOT}/gt1-11-09`],
		allowedEndpoints: ['https://api.x.ai'],
		allowedSshTargets: ['qual-host'],
		allowedModels: ['claude-haiku-4-5'],
		binary: { path: 'bin/grok-absent', sha256: 'a'.repeat(64), version: '0.0.0-synthetic' },
		autoUpdateDisabled: true,
		isolationReceipt: 'isolation:synthetic',
		discovery: { authorizationReference: 'discovery:synthetic', operations: ['acp-initialize'] },
		spendGuarantee: { kind: 'worst-case-reservation', reference: 'reservation:synthetic' },
		spendBounds: {
			perCall: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheCreationTokens: 0 },
			perTurnCalls: { modelRounds: 2, children: 1, retries: 1, sideModels: 0, compaction: 0 },
			sideModels: [],
		},
		limits: {
			budgetUsd: 10,
			maxCalls: 40,
			maxTurns: 8,
			maxWallClockSeconds: 600,
			perCase: { budgetUsd: 2, maxCalls: 20, maxTurns: 2, maxWallClockSeconds: 120 },
			cleanupSeconds: 5,
		},
		...patch,
	};
}

describe('GT1-11-09 qualification harness', () => {
	describe('honest not-run output', () => {
		it('the default run-state run admits nothing and contacts nothing', async () => {
			const { receipt, receiptPath } = await runQualification({
				workspace: WORKSPACE,
				runState: RUN_STATE,
				now: clock,
				runId: runId(),
			});
			expect(receiptPath).toBeNull();
			expect(receipt.configSource).toBe('default-run-state');
			expect(receipt.totals.cases).toBe(FAMILIES.length * 4);
			expect(receipt.totals).toMatchObject({
				admitted: 0,
				spawned: 0,
				paidRequests: 0,
				networkContacts: 0,
			});
			expect(receipt.totals.notRun).toBe(receipt.totals.cases);
			expect(receipt.ledger.authorizedCaseIds).toEqual([]);
			expect(receipt.ledger.reservations).toEqual([]);
			for (const c of receipt.cases) {
				expect(c.status).toBe('not-run');
				expect(c.reasons.length).toBeGreaterThan(0);
				for (const r of c.reasons) {
					expect(r.id).toMatch(/^[a-z0-9:-]+$/);
					expect(r.kind).toBeTruthy();
				}
				// The paid executor (GT1-11-11P1) covers local Grok-only paid legs; the rest stay unimplemented.
				const uncovered =
					c.classes.includes('discovery') || c.target === 'ssh' || c.family === 'E11';
				if (uncovered) expect(c.reasons.map((r) => r.id)).toContain('case-executor-unimplemented');
				else expect(c.reasons.map((r) => r.id)).not.toContain('case-executor-unimplemented');
				expect([c.spawned, c.paidRequests, c.networkContacts]).toEqual([0, 0, 0]);
				expect(c.budget.reservations).toEqual([]);
			}
		});

		it('every admission input but one leaves the case not-run and unable to reserve', async () => {
			// Executor and every capability forced on: only the inputs decide.
			const { receipt } = await runQualification({
				workspace: WORKSPACE,
				runState: RUN_STATE,
				config: liveConfig(),
				selectedCases: ['E03:acp-stdio:local'],
				capabilities: ALL_CAPS,
				now: clock,
				runId: runId(),
				operatorHome: path.join(WORKSPACE, 'tmp', 'gt1-11-09-operator-home'),
			});
			const [c] = receipt.cases;
			expect(c.status).toBe('not-run');
			// The audited isolation boundary is the missing input; the preflight says so.
			expect(c.preflight?.status).toBe('not-run');
			expect(c.reasons.some((r) => r.kind === 'isolation-preflight')).toBe(true);
			expect(receipt.ledger.authorizedCaseIds).toEqual([]);
			expect(c.budget.plan?.reasons).toEqual([]);
			expect(receipt.totals).toMatchObject({ admitted: 0, spawned: 0, paidRequests: 0 });
		});

		it('the CLI entry prints the not-run totals and writes no receipt with --no-write', async () => {
			const out: string[] = [];
			const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
				out.push(String(chunk));
				return true;
			});
			try {
				expect(await main(WORKSPACE, ['--no-write', '--cases', 'E01'])).toBe(0);
			} finally {
				spy.mockRestore();
			}
			const text = out.join('');
			expect(text).toMatch(
				/4 cases, 0 admitted, 4 not-run, 0 spawned, 0 paid requests, 0 network contacts/
			);
			expect(text).not.toContain('receipt:');
		});
	});

	describe('candidate capability snapshots', () => {
		const e08 = expandCases(FAMILIES, ['E08:native-headless:local'])[0];

		it('are frozen harness-only copies that never become production availability', async () => {
			const before = productionCapabilityDigest();
			const production = getAgentCapabilities('grok');
			expect(production.supportsSlashCommands).toBe(false);
			const snapshot = buildCandidateSnapshot(
				e08,
				liveConfig({ binary: { path: null, sha256: null, version: null } })
			);
			expect(snapshot).toMatchObject({
				scope: 'qualification-harness-only',
				productionAvailability: false,
				policyWaiver: false,
				caseId: e08.caseId,
				versionBasis: { state: 'unbound', supportedRange: null },
			});
			expect(snapshot!.capabilities.supportsSlashCommands).toBe(true);
			expect(Object.isFrozen(snapshot!.capabilities)).toBe(true);
			expect(() => {
				(snapshot!.capabilities as { supportsSlashCommands: boolean }).supportsSlashCommands =
					false;
			}).toThrow(TypeError);
			// Policy-bearing flags are copied from production, never overridden.
			for (const flag of POLICY_BEARING_FLAGS)
				expect(snapshot!.capabilities[flag]).toBe(production[flag]);
			expect(getAgentCapabilities('grok').supportsSlashCommands).toBe(false);
			expect(productionCapabilityDigest()).toBe(before);

			// A run records the snapshot but admits nothing because of it.
			const { receipt } = await runQualification({
				workspace: WORKSPACE,
				runState: RUN_STATE,
				selectedCases: ['E08'],
				now: clock,
				runId: runId(),
			});
			expect(receipt.candidateCapabilities.snapshots).toBe(4);
			expect(receipt.candidateCapabilities.productionDigestAfter).toBe(before);
			for (const c of receipt.cases) {
				expect(c.candidateSnapshot?.productionAvailability).toBe(false);
				expect(c.status).toBe('not-run');
			}
		});

		it('do not change admission', () => {
			const config = liveConfig();
			const withCandidate = admitCase(e08, config, [], ALL_CAPS, NOW);
			const e03 = expandCases(FAMILIES, ['E03:native-headless:local'])[0];
			expect(buildCandidateSnapshot(e03, config)).toBeNull();
			// E08 and E03 are both paid Grok cases: the same inputs, the same reasons.
			expect(withCandidate.map((r) => r.id)).toEqual(
				admitCase(e03, config, [], ALL_CAPS, NOW).map((r) => r.id)
			);
		});

		it('cannot waive policy or force a non-candidate flag', () => {
			const config = liveConfig();
			for (const flag of POLICY_BEARING_FLAGS) {
				const waiver = { ...CANDIDATE_CAPABILITIES[0], flag } as CandidateCapability;
				expect(() => buildCandidateSnapshot(e08, config, [waiver])).toThrow(/policy-bearing/);
			}
			const forced = {
				...CANDIDATE_CAPABILITIES[0],
				flag: 'supportsProjectMemory',
			} as CandidateCapability;
			expect(() => buildCandidateSnapshot(e08, config, [forced])).toThrow(/not an implemented/);
		});
	});

	describe('owned-resource cleanup', () => {
		const children: ChildProcess[] = [];
		afterEach(() => {
			for (const c of children.splice(0)) if (c.exitCode === null) c.kill('SIGKILL');
		});
		const sleeper = () => {
			const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
				stdio: 'ignore',
			});
			children.push(child);
			return child;
		};
		const exited = (child: ChildProcess) =>
			new Promise<NodeJS.Signals | number | null>((resolve) => {
				if (child.exitCode !== null || child.signalCode !== null)
					return resolve(child.signalCode ?? child.exitCode);
				child.once('exit', (code, signal) => resolve(signal ?? code));
			});

		it('stops only what it owns that is still running', async () => {
			const running = sleeper();
			const done = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
			children.push(done);
			await exited(done);
			const stranger = sleeper();
			expect(running.pid).toBeGreaterThan(0);

			const lifetime = createCaseLifetime(1);
			lifetime.own(running);
			lifetime.own(done);
			expect(await lifetime.cleanup()).toEqual({ ownedProcesses: 2, stopped: 1 });
			expect(await exited(running)).toBe('SIGTERM');
			expect(stranger.exitCode).toBeNull();
			expect(stranger.signalCode).toBeNull();
		});
	});

	describe('redaction', () => {
		it('a secret-shaped config value is a config problem that blocks every case and never reaches the receipt', async () => {
			const config = liveConfig({ authorizationReference: FAKE_TOKEN });
			expect(validateConfig(config, WORKSPACE)).toContainEqual({
				field: 'authorizationReference',
				code: 'secret-value-in-config',
			});
			const { receipt } = await runQualification({
				workspace: WORKSPACE,
				runState: RUN_STATE,
				config,
				selectedCases: ['E03'],
				capabilities: ALL_CAPS,
				now: clock,
				runId: runId(),
			});
			for (const c of receipt.cases)
				expect(c.reasons.map((r) => r.id)).toContain('config:secret-value-in-config');
			expect(JSON.stringify(receipt)).not.toContain(FAKE_TOKEN);
			expect(receipt.totals.admitted).toBe(0);
		});

		it('redactDeep scrubs nested strings without touching other values', () => {
			const out = redactDeep({ a: [`token ${FAKE_TOKEN}`], n: 3, ok: true, schema: CONFIG_SCHEMA });
			expect(JSON.stringify(out)).not.toContain(FAKE_TOKEN);
			expect(out).toMatchObject({ n: 3, ok: true, schema: CONFIG_SCHEMA });
		});
	});

	/**
	 * GT1-11-09A: pre-spawn isolation preflight rejection. A synthetic owned
	 * fixture (a text file standing in for the pinned binary, never executed;
	 * empty auth files; no credential) passes every family, then each isolation
	 * or control guard is broken in turn and must surface its own reason, with
	 * no child process and no network contact before admission.
	 */
	describe('isolation preflight rejection (GT1-11-09A)', () => {
		const REL = `${RUNS_ROOT}/gt1-11-09a-${process.pid}`;
		const ROOT = path.join(WORKSPACE, REL);
		const BIN = path.join(ROOT, 'bin', 'grok');
		/** The harness operator's home: outside every owned root, never created. */
		const OPERATOR_HOME = path.join(os.tmpdir(), `gt1-11-09a-operator-${process.pid}`);
		let binSha = '';

		beforeAll(() => {
			for (const d of ['home', 'grok-a', 'grok-b', 'auth', 'bin', path.join('cache', 'tmp')])
				fs.mkdirSync(path.join(ROOT, d), { recursive: true });
			fs.writeFileSync(BIN, '#!/bin/sh\nexit 0\n');
			fs.chmodSync(BIN, 0o555);
			binSha = createHash('sha256').update(fs.readFileSync(BIN)).digest('hex');
			fs.writeFileSync(path.join(ROOT, 'auth', 'a.json'), '{}');
			fs.writeFileSync(path.join(ROOT, 'auth', 'b.json'), '{}');
		});
		afterAll(() => {
			if (fs.existsSync(BIN)) fs.chmodSync(BIN, 0o755);
			fs.rmSync(ROOT, { recursive: true, force: true });
		});
		beforeEach(() => {
			spawnSpies.forEach((s) => s.mockClear());
		});

		const isolation = (): IsolationDeclaration => ({
			boundary: {
				kind: 'disposable-os-account',
				reference: 'boundary:synthetic',
				actualHome: `${REL}/home`,
				productionHomeMounted: false,
				operatorCredentialsReadable: false,
			},
			accountRoots: { A: `${REL}/grok-a`, B: `${REL}/grok-b` },
			remoteRoots: { 'qual-host': { root: '/srv/grok-qual', binarySha256: binSha } },
			policy: {
				systemPolicyInspected: true,
				managedPolicy: 'absent',
				requiredPolicyCompatible: true,
			},
			resources: { hooks: 'empty', mcp: 'empty', plugins: 'synthetic-owned', envrc: 'disabled' },
			egress: {
				kind: 'operation-aware',
				reference: 'egress:synthetic',
				suppression: { update: 'flags-only', telemetry: 'flags-only', backgroundUpload: 'unknown' },
			},
			path: ['/usr/bin', '/bin', path.join(ROOT, 'bin')],
		});
		/** A complete synthetic declaration: every preflight input present and owned. */
		const full = (): QualificationConfig & { isolation: IsolationDeclaration } => ({
			...liveConfig({
				credentialReferences: [
					{ provider: 'grok', account: 'A', kind: 'file', path: `${REL}/auth/a.json` },
					{ provider: 'grok', account: 'B', kind: 'file', path: `${REL}/auth/b.json` },
				],
				allowedRoots: [REL],
				binary: { path: `${REL}/bin/grok`, sha256: binSha, version: '0.0.0-synthetic' },
				discovery: {
					authorizationReference: 'discovery:synthetic',
					operations: ['acp-initialize', 'acp-model-catalog', 'native-model-catalog'],
				},
			}),
			isolation: isolation(),
		});
		const caseOf = (id: string) => expandCases(FAMILIES, [id])[0];
		const ids = (r: { reasons: Array<{ id: string }> }) => r.reasons.map((x) => x.id);
		const pf = (
			c: string | QualificationCase,
			cfg: QualificationConfig = full(),
			home = OPERATOR_HOME
		) =>
			preflightCase(typeof c === 'string' ? caseOf(c) : c, cfg, {
				workspace: WORKSPACE,
				operatorHome: home,
			});
		const offlineOnly = () => ({
			...caseOf('E02:acp-stdio:local'),
			classes: ['offline-inspection'] as QualificationCase['classes'],
		});
		const discoveryOnly = () => ({
			...caseOf('E02:acp-stdio:local'),
			classes: ['discovery'] as QualificationCase['classes'],
		});
		const credentialedPlan = (caseId = 'E03:acp-stdio:local', cfg = full()) =>
			planIsolatedLaunch(caseOf(caseId), cfg, 'A', 'credentialed', WORKSPACE, OPERATOR_HOME)!;
		const offlinePlan = () =>
			planIsolatedLaunch(
				caseOf('E02:acp-stdio:local'),
				full(),
				'A',
				'offline',
				WORKSPACE,
				OPERATOR_HOME
			)!;
		const envIds = (
			plan: ReturnType<typeof credentialedPlan>,
			patch: Record<string, string | undefined>
		) => ids(validateLaunchEnvironment({ ...plan.env, ...patch }, plan.expectation));
		const expectNoEffects = () => {
			// The spies are live (the cleanup suite's own spawn goes through one).
			expect(spawnSpies).toHaveLength(7);
			expect(vi.isMockFunction(spawn)).toBe(true);
			for (const s of spawnSpies) expect(s).not.toHaveBeenCalled();
			expect(fetchSpy).not.toHaveBeenCalled();
		};

		it('a complete synthetic declaration passes, with offline, discovery and paid admission kept apart', () => {
			for (const fam of FAMILIES.map((f: { id: string }) => f.id))
				for (const route of ['native-headless', 'acp-stdio'])
					for (const target of ['local', 'ssh']) {
						const r = pf(`${fam}:${route}:${target}`);
						if (fam === 'E11') {
							expect(ids(r)).toEqual([
								'cross-provider-preflight-unimplemented',
								'cross-provider-preflight-unimplemented',
							]);
							expect(r.status).toBe('not-run');
						} else {
							expect(ids(r), `${fam}:${route}:${target}`).toEqual([]);
							expect(r.status).toBe('pass');
						}
					}

			// Offline inspection: the two credential-free probes under a deny-all boundary, nothing else.
			const deny = full();
			deny.isolation.egress.kind = 'deny-all';
			const off = pf(offlineOnly(), deny);
			expect(ids(off)).toEqual([]);
			expect(off.operations).toEqual({
				offlineProbes: ['version', 'help'],
				discovery: [],
				paidPrompts: false,
			});
			expect(off.launches.map((l) => [l.mode, l.credentialMode])).toEqual([['offline', 'none']]);
			expect(off.launches[0].keys).not.toContain('GROK_AUTH_PATH');
			expect(off.launches[0].keys).not.toContain('XAI_API_KEY');

			// Discovery: only the operations authorized for this route, the selected account file, no prompt.
			const disc = pf(discoveryOnly());
			expect(ids(disc)).toEqual([]);
			expect(disc.operations).toEqual({
				offlineProbes: [],
				discovery: ['acp-initialize', 'acp-model-catalog'],
				paidPrompts: false,
			});
			expect(pf('E02:native-headless:local').operations.discovery).toEqual([
				'native-model-catalog',
			]);
			expect(disc.launches.map((l) => [l.mode, l.credentialMode])).toEqual([
				['credentialed', 'file'],
			]);

			// Paid: prompts allowed, no discovery operation implied, both accounts planned for E01.
			const paid = pf('E03:acp-stdio:local');
			expect(paid.operations).toEqual({ offlineProbes: [], discovery: [], paidPrompts: true });
			expect(pf('E01:acp-stdio:local').launches.map((l) => l.account)).toEqual(['A', 'B']);
			expect(paid.binary).toMatchObject({ state: 'local', sha256Before: binSha, readOnly: true });
			expectNoEffects();
		});

		it('each admission class is decided with zero child spawns and zero network contacts', async () => {
			// Prerequisites present: the preflight passes and still nothing is started.
			const { receipt } = await runQualification({
				workspace: WORKSPACE,
				runState: RUN_STATE,
				config: full(),
				selectedCases: ['E02:acp-stdio:local', 'E03:acp-stdio:local', 'E07:native-headless:ssh'],
				// Admission only: the paid executor (GT1-11-11P1) is off so an admitted case is not run.
				capabilities: { ...ALL_CAPS, caseExecutor: false },
				now: clock,
				runId: runId(),
				operatorHome: OPERATOR_HOME,
			});
			for (const c of receipt.cases) {
				expect(c.preflight?.status, c.caseId).toBe('pass');
				expect([c.spawned, c.paidRequests, c.networkContacts]).toEqual([0, 0, 0]);
			}
			expect(receipt.cases[0].preflight?.binary.sha256After).toBe(binSha);
			expect(receipt.totals).toMatchObject({ spawned: 0, paidRequests: 0, networkContacts: 0 });
			expectNoEffects();

			// Prerequisites missing: every class is an immediate not-run with a reason, never a wait.
			const missing = full() as QualificationConfig;
			delete missing.isolation;
			const offRun = await runQualification({
				workspace: WORKSPACE,
				runState: RUN_STATE,
				config: { ...missing, discovery: { authorizationReference: null, operations: [] } },
				selectedCases: ['E02', 'E03:native-headless:local'],
				capabilities: ALL_CAPS,
				now: clock,
				runId: runId(),
				operatorHome: OPERATOR_HOME,
			});
			for (const c of offRun.receipt.cases) {
				expect(c.status).toBe('not-run');
				expect(ids(c)).toContain('isolation-undeclared');
				if (c.family === 'E02') expect(ids(c)).toContain('discovery-authorization-absent');
				expect(c.preflight?.launches).toEqual([]);
			}
			expect(offRun.receipt.totals).toMatchObject({ admitted: 0, spawned: 0, networkContacts: 0 });
			expectNoEffects();
		});

		it('refuses inherited inline and per-model auth', () => {
			const plan = credentialedPlan();
			expect(envIds(plan, { GROK_AUTH: 'SENTINEL-INLINE' })).toEqual(['env-denied:inline-auth']);
			expect(envIds(plan, { XAI_API_KEY: 'SENTINEL-XAI' })).toEqual([
				'env-denied:route-credential',
			]);
			expect(envIds(plan, { ANTHROPIC_API_KEY: 'x' })).toEqual(['env-denied:route-credential']);
			expect(envIds(plan, { GROK_AUTH_PATH: path.join(ROOT, 'auth', 'b.json') })).toEqual([
				'env-auth-path-mismatch',
			]);
			expect(envIds(plan, { GROK_AUTH_PATH: undefined })).toEqual(['env-credential-absent']);
			const off = offlinePlan();
			expect(envIds(off, { GROK_AUTH_PATH: path.join(ROOT, 'auth', 'a.json') })).toEqual([
				'env-denied:route-credential',
			]);
			const secret = full();
			secret.credentialReferences = [
				{ provider: 'grok', account: 'A', kind: 'secret-name', name: 'GROK_QUAL_ACCOUNT_A' },
			];
			const sp = credentialedPlan('E03:acp-stdio:local', secret);
			expect(sp.env.XAI_API_KEY).toBe('secret-ref:GROK_QUAL_ACCOUNT_A');
			expect(envIds(sp, {})).toEqual([]);
			expect(envIds(sp, { XAI_API_KEY: undefined })).toEqual(['env-credential-absent']);
			expect(envIds(sp, { GROK_AUTH_PATH: path.join(ROOT, 'auth', 'a.json') })).toEqual([
				'env-denied:route-credential',
			]);
			const report = validateLaunchEnvironment(
				{ ...plan.env, GROK_AUTH: 'SENTINEL-INLINE' },
				plan.expectation
			);
			expect(JSON.stringify(report)).not.toContain('SENTINEL');

			// An owned config naming a per-model key or key variable is refused before spawn.
			const cfg = path.join(ROOT, 'grok-a', 'config.toml');
			try {
				for (const line of ['api_key = "x"', '  env_key = "OTHER_KEY"']) {
					fs.writeFileSync(cfg, `[models.synthetic]\n${line}\n`);
					expect(ids(pf('E03:acp-stdio:local'))).toEqual(['config-per-model-credential']);
				}
				fs.writeFileSync(cfg, '[models.synthetic]\nname = "synthetic"\n');
				expect(ids(pf('E03:acp-stdio:local'))).toEqual([]);
			} finally {
				fs.unlinkSync(cfg);
			}
		});

		it('refuses real-home and compatibility-scanner reads', () => {
			const plan = credentialedPlan();
			// Every scanner and telemetry control, missing or flipped, is its own reason.
			for (const [key, value] of Object.entries(GROK_CONTROL_ENV)) {
				expect(envIds(plan, { [key]: undefined }), key).toEqual(['env-control-missing']);
				expect(envIds(plan, { [key]: value === '1' ? '0' : '1' }), key).toEqual([
					'env-control-wrong',
				]);
			}
			expect(Object.keys(GROK_CONTROL_ENV)).toHaveLength(23);
			expect(envIds(plan, { HOME: OPERATOR_HOME }).sort()).toEqual([
				'env-home-is-operator-home',
				'env-home-mismatch',
			]);
			expect(envIds(plan, { HOME: path.dirname(OPERATOR_HOME) })).toContain(
				'env-home-is-operator-home'
			);
			expect(envIds(plan, { USERPROFILE: OPERATOR_HOME })).toEqual(['env-home-mismatch']);
			expect(envIds(plan, { GROK_HOME: path.join(ROOT, 'grok-b') })).toEqual([
				'env-grok-home-mismatch',
			]);
			expect(
				envIds(plan, { GROK_CONFIG_PATH: path.join(OPERATOR_HOME, '.grok', 'config.toml') })
			).toEqual(['env-path-outside-roots']);
			for (const key of [
				'TMPDIR',
				'TMP',
				'TEMP',
				'XDG_CONFIG_HOME',
				'XDG_DATA_HOME',
				'XDG_CACHE_HOME',
				'XDG_STATE_HOME',
			])
				expect(envIds(plan, { [key]: path.join(OPERATOR_HOME, '.config') }), key).toEqual([
					'env-path-outside-roots',
				]);
			expect(
				envIds(plan, {
					PATH: [path.join(OPERATOR_HOME, '.local', 'bin'), '/usr/bin'].join(path.delimiter),
				})
			).toEqual(['env-path-under-operator-home']);

			// The declared boundary must exclude the production home and the operator's credentials.
			const flips: Array<[string, (c: ReturnType<typeof full>) => void, string]> = [
				[
					'home mounted',
					(c) => (c.isolation.boundary!.productionHomeMounted = true),
					'production-home-mounted',
				],
				[
					'home unknown',
					(c) => (c.isolation.boundary!.productionHomeMounted = null),
					'production-home-unknown',
				],
				[
					'creds readable',
					(c) => (c.isolation.boundary!.operatorCredentialsReadable = true),
					'operator-credentials-readable',
				],
				[
					'creds unknown',
					(c) => (c.isolation.boundary!.operatorCredentialsReadable = null),
					'operator-credentials-unknown',
				],
				[
					'no reference',
					(c) => (c.isolation.boundary!.reference = '  '),
					'boundary-reference-absent',
				],
				['no boundary', (c) => (c.isolation.boundary = null), 'boundary-undeclared'],
				[
					'home is operator',
					(c) => (c.isolation.boundary!.actualHome = OPERATOR_HOME),
					'owned-root-outside-allowed',
				],
			];
			for (const [label, flip, want] of flips) {
				const cfg = full();
				flip(cfg);
				const r = pf('E03:acp-stdio:local', cfg);
				expect(ids(r), label).toContain(want);
				expect(r.status).toBe('not-run');
			}
			// An owned root that contains the operator's home is refused even inside the allowed roots,
			// and the planned child HOME is refused for containing it too.
			expect(
				ids(pf('E03:acp-stdio:local', full(), path.join(ROOT, 'home', 'operator'))).sort()
			).toEqual(['env-home-is-operator-home', 'owned-root-contains-operator-home']);
			// The planned child PATH is validated by the preflight itself, not only by a caller.
			const pathCfg = full();
			pathCfg.isolation.path = [path.join(OPERATOR_HOME, '.local', 'bin'), '/usr/bin'];
			const pathRun = pf('E02:acp-stdio:local', pathCfg);
			expect(ids(pathRun)).toEqual([
				'env-path-under-operator-home',
				'env-path-under-operator-home',
			]);
			expect(pathRun.launches.map((l) => l.mode)).toEqual(['offline', 'credentialed']);
		});

		it('validates the post-resolution environment, not just the plan', () => {
			const plan = credentialedPlan();
			const saved = process.env.ANTHROPIC_API_KEY;
			process.env.ANTHROPIC_API_KEY = 'SENTINEL-AMBIENT';
			try {
				// A later custom layer and the inherited process env are applied after planning.
				const built = buildAgentEnvironment({
					surface: 'desktop',
					defaultEnvVars: plan.env,
					sessionCustomEnvVars: {
						GROK_HOME: path.join(ROOT, 'grok-b'),
						GROK_TELEMETRY_ENABLED: '1',
						GROK_CODEX_HOOKS_ENABLED: '',
						GROK_CONFIG_PATH: path.join(OPERATOR_HOME, 'config.toml'),
					},
				});
				const report = validateLaunchEnvironment(built, plan.expectation);
				expect(report.denied).toContain('ANTHROPIC_API_KEY');
				expect(report.missingControls).toEqual(
					expect.arrayContaining(['GROK_TELEMETRY_ENABLED', 'GROK_CODEX_HOOKS_ENABLED'])
				);
				expect(ids(report)).toEqual(
					expect.arrayContaining([
						'env-grok-home-mismatch',
						'env-control-wrong',
						'env-control-missing',
						'env-path-outside-roots',
					])
				);
				expect(JSON.stringify(report)).not.toContain('SENTINEL');
			} finally {
				if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
				else process.env.ANTHROPIC_API_KEY = saved;
			}
		});

		it('refuses symlink and SSH-root escapes', () => {
			const rootFlips: Array<[string, (c: ReturnType<typeof full>) => void, string, string?]> = [
				[
					'account root outside',
					(c) => (c.isolation.accountRoots.A = 'tmp/elsewhere/grok-a'),
					'owned-root-outside-allowed',
				],
				[
					'account root traversal',
					(c) => (c.isolation.accountRoots.A = `${REL}/../../escape`),
					'owned-root-outside-allowed',
				],
				[
					'account root B absent',
					(c) => delete c.isolation.accountRoots.B,
					'owned-root-absent',
					'E01:acp-stdio:local',
				],
				[
					'account roots overlap',
					(c) => (c.isolation.accountRoots.B = `${REL}/grok-a/nested`),
					'account-roots-overlap',
					'E01:acp-stdio:local',
				],
				[
					'remote tilde (absolute, still unexpanded)',
					(c) => (c.isolation.remoteRoots['qual-host'].root = '/srv/~operator/grok'),
					'remote-root-invalid',
					'E03:acp-stdio:ssh',
				],
				[
					'remote slash',
					(c) => (c.isolation.remoteRoots['qual-host'].root = '/'),
					'remote-root-invalid',
					'E03:acp-stdio:ssh',
				],
				[
					'remote relative',
					(c) => (c.isolation.remoteRoots['qual-host'].root = 'srv/grok'),
					'remote-root-invalid',
					'E03:acp-stdio:ssh',
				],
				[
					'remote root absent',
					(c) => (c.isolation.remoteRoots = {}),
					'remote-root-absent',
					'E03:acp-stdio:ssh',
				],
				[
					'no ssh target',
					(c) => (c.allowedSshTargets = []),
					'remote-root-absent',
					'E03:acp-stdio:ssh',
				],
				[
					'remote binary undeclared',
					(c) => (c.isolation.remoteRoots['qual-host'].binarySha256 = null),
					'remote-binary-undeclared',
					'E03:acp-stdio:ssh',
				],
				[
					'remote binary differs',
					(c) => (c.isolation.remoteRoots['qual-host'].binarySha256 = 'c'.repeat(64)),
					'remote-binary-hash-mismatch',
					'E03:acp-stdio:ssh',
				],
			];
			for (const [label, flip, want, id = 'E03:acp-stdio:local'] of rootFlips) {
				const cfg = full();
				flip(cfg);
				const r = pf(id, cfg);
				expect(ids(r), label).toContain(want);
				expect(r.status).toBe('not-run');
			}
			// No remote root means no plannable launch at all.
			const noRemote = full();
			noRemote.isolation.remoteRoots = {};
			expect(ids(pf('E03:acp-stdio:ssh', noRemote))).toContain('launch-unplannable');

			// Remote paths are judged as remote POSIX paths: a normalized escape is outside the root.
			const ssh = credentialedPlan('E03:acp-stdio:ssh');
			expect(ssh.env.GROK_HOME).toBe('/srv/grok-qual/grok-a');
			expect(envIds(ssh, {})).toEqual([]);
			expect(
				envIds(ssh, { GROK_CONFIG_PATH: '/srv/grok-qual/grok-a/../../../etc/grok.toml' })
			).toEqual(['env-path-outside-roots']);
			expect(envIds(ssh, { TMPDIR: '/tmp' })).toEqual(['env-path-outside-roots']);
		});

		it.skipIf(process.platform === 'win32')(
			'refuses an owned root that is a symlink out of the allowed roots',
			() => {
				const link = path.join(ROOT, 'grok-link');
				const home = path.join(ROOT, 'home-link');
				fs.symlinkSync(os.tmpdir(), link);
				fs.symlinkSync(os.tmpdir(), home);
				try {
					const a = full();
					a.isolation.accountRoots.A = `${REL}/grok-link`;
					expect(ids(pf('E03:acp-stdio:local', a))).toEqual(['owned-root-symlink-escape']);
					const h = full();
					h.isolation.boundary!.actualHome = `${REL}/home-link`;
					expect(ids(pf('E03:acp-stdio:local', h))).toEqual(['owned-root-symlink-escape']);
				} finally {
					fs.unlinkSync(link);
					fs.unlinkSync(home);
				}
			}
		);

		it('refuses mandatory hooks, policy and resources it cannot vouch for', () => {
			const flips: Array<[string, (c: ReturnType<typeof full>) => void, string]> = [
				[
					'hook policy incompatible',
					(c) => (c.isolation.policy.requiredPolicyCompatible = false),
					'required-policy-incompatible',
				],
				[
					'hook policy unknown',
					(c) => (c.isolation.policy.requiredPolicyCompatible = null),
					'required-policy-unknown',
				],
				[
					'system policy uninspected',
					(c) => (c.isolation.policy.systemPolicyInspected = false),
					'system-policy-uninspected',
				],
				[
					'managed policy unknown',
					(c) => (c.isolation.policy.managedPolicy = 'unknown'),
					'managed-policy-unknown',
				],
				[
					'hooks unknown',
					(c) => (c.isolation.resources.hooks = 'unknown'),
					'resource-unknown:hooks',
				],
				['mcp unknown', (c) => (c.isolation.resources.mcp = 'unknown'), 'resource-unknown:mcp'],
				[
					'plugins unknown',
					(c) => (c.isolation.resources.plugins = 'unknown'),
					'resource-unknown:plugins',
				],
				['envrc', (c) => (c.isolation.resources.envrc = 'unknown'), 'envrc-not-disabled'],
				[
					'isolation undeclared',
					(c) => delete (c as QualificationConfig).isolation,
					'isolation-undeclared',
				],
			];
			for (const [label, flip, want] of flips) {
				const cfg = full();
				flip(cfg);
				expect(ids(pf('E03:acp-stdio:local', cfg)), label).toEqual([want]);
			}
			const plan = credentialedPlan();
			expect(envIds(plan, { GROK_FOLDER_TRUST: '1' })).toEqual([
				'env-denied:folder-trust-ungates-hooks',
			]);
			expect(envIds(plan, { GROK_CLAUDE_HOOKS_ENABLED: '1' })).toEqual(['env-control-wrong']);
		});

		it('refuses an updater that could mutate the pinned binary', async () => {
			const cfg = full();
			cfg.autoUpdateDisabled = false;
			expect(ids(pf('E03:acp-stdio:local', cfg))).toEqual(['update-not-immutable']);
			const ssh = full();
			ssh.autoUpdateDisabled = false;
			expect(ids(pf('E03:acp-stdio:ssh', ssh))).toEqual(['update-not-immutable']);
			const wrongHash = full();
			wrongHash.binary.sha256 = 'a'.repeat(64);
			expect(ids(pf('E03:acp-stdio:local', wrongHash))).toEqual(['binary-hash-mismatch']);
			const absent = full();
			absent.binary.path = `${REL}/bin/absent`;
			expect(ids(pf('E03:acp-stdio:local', absent))).toEqual([
				'binary-unreadable',
				'update-not-immutable',
			]);
			expect(envIds(credentialedPlan(), { GROK_DISABLE_AUTOUPDATER: '0' })).toEqual([
				'env-control-wrong',
			]);

			fs.chmodSync(BIN, 0o755);
			try {
				expect(ids(pf('E03:acp-stdio:local')).sort()).toEqual([
					'binary-mutable',
					'update-not-immutable',
				]);
			} finally {
				fs.chmodSync(BIN, 0o555);
			}

			// Bytes that differ after the case than before it are refused, through the receipt.
			const real = fs.realpathSync(BIN);
			const read = fs.readFileSync;
			let reads = 0;
			const spy = vi.spyOn(fs, 'readFileSync').mockImplementation(((
				file: fs.PathOrFileDescriptor,
				...rest: unknown[]
			) => {
				if (file === real && ++reads > 1) return Buffer.from('#!/bin/sh\necho updated\n');
				return (read as (...a: unknown[]) => unknown)(file, ...rest);
			}) as typeof fs.readFileSync);
			try {
				const { receipt } = await runQualification({
					workspace: WORKSPACE,
					runState: RUN_STATE,
					config: full(),
					selectedCases: ['E03:native-headless:local'],
					capabilities: ALL_CAPS,
					now: clock,
					runId: runId(),
					operatorHome: OPERATOR_HOME,
				});
				const [c] = receipt.cases;
				expect(c.preflight?.binary.sha256Before).toBe(binSha);
				expect(c.preflight?.binary.sha256After).not.toBe(binSha);
				expect(c.preflight?.status).toBe('not-run');
				expect(ids(c)).toContain('binary-changed-during-case');
				expect(c.status).toBe('not-run');
			} finally {
				spy.mockRestore();
			}
			expectNoEffects();
		});

		it('refuses unverified telemetry and same-origin upload suppression', () => {
			const allow = full();
			allow.isolation.egress.kind = 'origin-allowlist';
			expect(ids(pf('E03:acp-stdio:local', allow)).sort()).toEqual([
				'same-origin-upload-unguarded',
				'suppression-unverified:backgroundUpload',
				'suppression-unverified:telemetry',
				'suppression-unverified:update',
			]);
			const upload = full();
			upload.isolation.egress = {
				kind: 'origin-allowlist',
				reference: 'egress:synthetic',
				suppression: { update: 'verified', telemetry: 'verified', backgroundUpload: 'flags-only' },
			};
			expect(ids(pf('E03:acp-stdio:local', upload)).sort()).toEqual([
				'same-origin-upload-unguarded',
				'suppression-unverified:backgroundUpload',
			]);
			const telemetry = full();
			telemetry.isolation.egress = {
				kind: 'deny-all',
				reference: 'egress:synthetic',
				suppression: { update: 'verified', telemetry: 'flags-only', backgroundUpload: 'verified' },
			};
			expect(ids(pf(discoveryOnly(), telemetry))).toEqual(['suppression-unverified:telemetry']);
			const verified = full();
			verified.isolation.egress = {
				kind: 'origin-allowlist',
				reference: 'egress:synthetic',
				suppression: { update: 'verified', telemetry: 'verified', backgroundUpload: 'verified' },
			};
			expect(ids(pf('E03:acp-stdio:local', verified))).toEqual([]);
			for (const egress of [
				{ kind: 'none' as const, reference: 'egress:synthetic' },
				{ kind: 'operation-aware' as const, reference: null },
			]) {
				const cfg = full();
				Object.assign(cfg.isolation.egress, egress);
				expect(ids(pf('E03:acp-stdio:local', cfg))).toContain('egress-boundary-undeclared');
			}
			// Offline probes need every byte denied, not merely an operation-aware boundary.
			expect(ids(pf(offlineOnly()))).toEqual(['offline-egress-not-denied']);

			const plan = credentialedPlan();
			const env: Array<[string, string, string]> = [
				['OTEL_EXPORTER_OTLP_ENDPOINT', 'http://collector', 'env-denied:otel'],
				['HTTPS_PROXY', 'http://proxy', 'env-denied:proxy'],
				['all_proxy', 'http://proxy', 'env-denied:proxy'],
				['SSH_AUTH_SOCK', '/tmp/agent.sock', 'env-denied:ssh-agent'],
				['AWS_SECRET_ACCESS_KEY', 'x', 'env-denied:cloud-credential'],
				['GOOGLE_APPLICATION_CREDENTIALS', '/x.json', 'env-denied:cloud-credential'],
				['NODE_OPTIONS', '--require x', 'env-denied:runtime-injection'],
				['DYLD_INSERT_LIBRARIES', 'x', 'env-denied:runtime-injection'],
				['GROK_OIDC_TOKEN_FILE', '/x', 'env-denied:auth-helper'],
				['XAI_ORG_ID', 'x', 'env-denied:xai-ambient'],
				['SYNTHETIC_SERVICE_TOKEN', 'x', 'env-denied:secret-shaped'],
				['GROK_MODELS_BASE_URL', 'https://upload.example', 'env-denied:gateway-unapproved'],
				['GROK_XAI_API_BASE_URL', 'not a url', 'env-denied:gateway-unapproved'],
			];
			for (const [key, value, want] of env)
				expect(envIds(plan, { [key]: value }), key).toEqual([want]);
			expect(envIds(plan, { GROK_CLI_CHAT_PROXY_BASE_URL: 'https://api.x.ai/v1' })).toEqual([]);
			// Offline carries no credential, so no gateway is approved even to an approved origin.
			expect(envIds(offlinePlan(), { GROK_MODELS_BASE_URL: 'https://api.x.ai' })).toEqual([
				'env-denied:gateway-unapproved',
			]);
			for (const key of [
				'GROK_TELEMETRY_TRACE_UPLOAD',
				'GROK_TELEMETRY_MIXPANEL_ENABLED',
				'GROK_EXTERNAL_OTEL',
			])
				expect(envIds(plan, { [key]: '1' }), key).toEqual(['env-control-wrong']);
		});

		it('refuses unauthorized ACP and catalog discovery', () => {
			const unknown = full();
			unknown.discovery.operations.push('upload-workspace');
			expect(ids(pf('E03:acp-stdio:local', unknown))).toEqual(['discovery-operation-unknown']);
			const nativeOnly = full();
			nativeOnly.discovery.operations = ['native-model-catalog'];
			expect(ids(pf(discoveryOnly(), nativeOnly))).toEqual(['discovery-operation-unauthorized']);
			const acpOnly = full();
			acpOnly.discovery.operations = ['acp-initialize'];
			expect(ids(pf('E02:native-headless:local', acpOnly))).toEqual([
				'discovery-operation-unauthorized',
			]);
			const none = full();
			none.discovery.operations = [];
			expect(ids(pf('E07:acp-stdio:local', none))).toEqual(['discovery-operation-unauthorized']);
			// A paid case without discovery is not widened by an authorized catalog operation.
			expect(pf('E03:acp-stdio:local', acpOnly).operations.discovery).toEqual([]);
		});
	});

	/**
	 * GT1-11-10B: the offline-inspection leg and its bounded executor
	 * (GT1-11-10A). The pinned binary is a synthetic POSIX shell stand-in written
	 * into an owned temp dir under the runs root, never a real Grok; each mode
	 * records the argv, environment and pid it actually saw into an owned log
	 * directory. The spawn spy stays pass-through, so it proves exactly which
	 * file, argv and env the harness handed the OS.
	 */
	describe.skipIf(process.platform === 'win32')('offline-inspection leg (GT1-11-10B)', () => {
		const REL = `${RUNS_ROOT}/gt1-11-10b-${process.pid}`;
		const ROOT = path.join(WORKSPACE, REL);
		const BIN = path.join(ROOT, 'bin', 'grok');
		const LOG = path.join(ROOT, 'log');
		const OPERATOR_HOME = path.join(os.tmpdir(), `gt1-11-10b-operator-${process.pid}`);
		const OFFLINE_CAPS: HarnessCapabilities = { ...HARNESS_CAPABILITIES };
		type Mode = 'ok' | 'sleep' | 'big' | 'fail' | 'mutate' | 'noversion';
		const BODY: Record<Mode, string> = {
			ok: '[ "$p" = version ] && echo "grok-cli v1.2.3 (synthetic stand-in)"\n[ "$p" = help ] && echo "usage: grok [options]"\nexit 0',
			sleep: 'exec sleep 30',
			// Past the cap it keeps running, so only the cap itself can stop it in time.
			big: 'head -c 1200000 /dev/zero\nexec sleep 30',
			noversion: 'echo "grok (development build)"\nexit 0',
			fail: 'echo "grok 1.2.3"\nexit 3',
			mutate:
				'if [ "$p" = version ]; then chmod u+w "$0"; printf "\\n# changed\\n" >> "$0"; fi\necho "grok 1.2.3"\nexit 0',
		};
		/** Write the stand-in for one mode (read-only, like a pinned install) and return its sha256. */
		const standIn = (mode: Mode): string => {
			if (fs.existsSync(BIN)) fs.chmodSync(BIN, 0o755);
			fs.rmSync(LOG, { recursive: true, force: true });
			fs.mkdirSync(LOG, { recursive: true });
			fs.writeFileSync(
				BIN,
				[
					'#!/bin/sh',
					`LOG='${LOG}'`,
					'case "$1" in --version) p=version;; --help) p=help;; *) p=other;; esac',
					'printf "%s\\n" "$#" "$@" > "$LOG/$p.argv"',
					'env > "$LOG/$p.env"',
					'echo $$ > "$LOG/$p.pid"',
					BODY[mode],
					'',
				].join('\n')
			);
			fs.chmodSync(BIN, 0o555);
			return createHash('sha256').update(fs.readFileSync(BIN)).digest('hex');
		};
		const logged = (p: string, kind: 'argv' | 'env' | 'pid') => {
			const file = path.join(LOG, `${p}.${kind}`);
			return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
		};
		/** Only the offline inputs: no credential, endpoint, discovery, model or spend input at all. */
		const offlineConfig = (
			sha: string,
			version = '1.2.3'
		): QualificationConfig & { isolation: IsolationDeclaration } => ({
			...defaultConfigFromRunState({}),
			allowedRoots: [REL],
			binary: { path: `${REL}/bin/grok`, sha256: sha, version },
			autoUpdateDisabled: true,
			isolationReceipt: 'isolation:synthetic',
			isolation: {
				boundary: {
					kind: 'disposable-os-account' as const,
					reference: 'boundary:synthetic',
					actualHome: `${REL}/home`,
					productionHomeMounted: false,
					operatorCredentialsReadable: false,
				},
				accountRoots: { A: `${REL}/grok-a` },
				remoteRoots: {},
				policy: {
					systemPolicyInspected: true,
					managedPolicy: 'absent' as const,
					requiredPolicyCompatible: true,
				},
				resources: {
					hooks: 'empty' as const,
					mcp: 'empty' as const,
					plugins: 'empty' as const,
					envrc: 'disabled' as const,
				},
				egress: {
					kind: 'deny-all' as const,
					reference: 'egress:synthetic',
					suppression: {
						update: 'flags-only' as const,
						telemetry: 'verified' as const,
						backgroundUpload: 'verified' as const,
					},
				},
				path: ['/usr/bin', '/bin'],
			} satisfies IsolationDeclaration,
		});
		const caseOf = (id: string) => expandCases(FAMILIES, [id])[0];
		const ids = (r: { reasons: Array<{ id: string }> }) => r.reasons.map((x) => x.id);
		const leg = (cfg: QualificationConfig, caps = OFFLINE_CAPS, id = 'E02:acp-stdio:local') =>
			runOfflineLeg(caseOf(id), cfg, validateConfig(cfg, WORKSPACE), caps, {
				workspace: WORKSPACE,
				operatorHome: OPERATOR_HOME,
				timeoutMs: 5000,
			});
		const exec = (cfg: QualificationConfig, id = 'E02:acp-stdio:local') =>
			executeOfflineLeg(offlineLegCase(caseOf(id)), cfg, {
				workspace: WORKSPACE,
				operatorHome: OPERATOR_HOME,
				timeoutMs: 5000,
				lifetime: createCaseLifetime(1),
			});
		const spawnCalls = () => spawnSpies[0].mock.calls as unknown as Array<[string, string[], any]>;
		const expectNoSpawn = () => {
			for (const s of spawnSpies) expect(s).not.toHaveBeenCalled();
			expect(fetchSpy).not.toHaveBeenCalled();
		};

		beforeAll(() => {
			for (const d of ['home', 'grok-a', 'bin', 'log'])
				fs.mkdirSync(path.join(ROOT, d), { recursive: true });
		});
		afterAll(() => {
			if (fs.existsSync(BIN)) fs.chmodSync(BIN, 0o755);
			fs.rmSync(ROOT, { recursive: true, force: true });
		});
		beforeEach(() => {
			spawnSpies.forEach((s) => s.mockClear());
			fetchSpy.mockClear();
		});

		it('the default no-config run spawns nothing and records every E02 offline leg as refused', async () => {
			expect(HARNESS_CAPABILITIES).toMatchObject({ offlineExecutor: true, caseExecutor: true });
			const { receipt } = await runQualification({
				workspace: WORKSPACE,
				runState: RUN_STATE,
				now: clock,
				runId: runId(),
			});
			expect(receipt.totals).toMatchObject({ spawned: 0, paidRequests: 0, networkContacts: 0 });
			const owners: Record<string, string> = {
				'E02:local': 'GT1-11-11A',
				'E02:ssh': 'GT1-11-11A',
				'E07:local': 'GT1-11-11A',
				'E07:ssh': 'GT1-11-11A/unassigned-ssh-paid-executor',
				'E03:ssh': 'unassigned-ssh-paid-executor',
				'E11:local': 'GT1-11-13',
			};
			for (const c of receipt.cases) {
				const executor = c.reasons.find((r) => r.id === 'case-executor-unimplemented');
				const key = `${c.family}:${c.target}`;
				if (owners[key]) expect(executor?.owner, c.caseId).toBe(owners[key]);
				if (key === 'E03:local') expect(executor, c.caseId).toBeUndefined();
				expect(executor?.owner).not.toBe('GT1-11-10');
				if (c.family !== 'E02') {
					expect(c.offlineLeg).toBeNull();
					continue;
				}
				expect(c.offlineLeg).toMatchObject({
					leg: 'offline-inspection',
					status: 'not-run',
					spawned: 0,
					probes: [],
					networkContacts: 0,
				});
				expect(ids(c.offlineLeg!)).toEqual(
					expect.arrayContaining(['binary-unpinned', 'auto-update-not-disabled'])
				);
			}
			expectNoSpawn();
		});

		it('admits the offline leg with no discovery input and runs only --version and --help, credential-free', async () => {
			const sha = standIn('ok');
			const cfg = offlineConfig(sha);
			expect(cfg.credentialReferences).toEqual([]);
			expect(cfg.allowedEndpoints).toEqual([]);
			expect(cfg.discovery).toEqual({ authorizationReference: null, operations: [] });
			const saved = { xai: process.env.XAI_API_KEY, auth: process.env.GROK_AUTH_PATH };
			process.env.XAI_API_KEY = 'SENTINEL-AMBIENT-XAI';
			process.env.GROK_AUTH_PATH = '/SENTINEL/auth.json';
			let receipt: Awaited<ReturnType<typeof runQualification>>['receipt'];
			try {
				({ receipt } = await runQualification({
					workspace: WORKSPACE,
					runState: RUN_STATE,
					config: cfg,
					selectedCases: ['E02:acp-stdio:local'],
					capabilities: OFFLINE_CAPS,
					now: clock,
					runId: runId(),
					operatorHome: OPERATOR_HOME,
				}));
			} finally {
				for (const [k, v] of [
					['XAI_API_KEY', saved.xai],
					['GROK_AUTH_PATH', saved.auth],
				] as const)
					if (v === undefined) delete process.env[k];
					else process.env[k] = v;
			}
			const [c] = receipt.cases;
			// Two separate entries: the offline leg ran, the discovery leg did not.
			expect(c.offlineLeg).toMatchObject({
				status: 'passed',
				reasons: [],
				spawned: 2,
				networkContacts: 0,
				binary: {
					sha256Pinned: sha,
					sha256AtSpawn: sha,
					sha256After: sha,
					versionPinned: '1.2.3',
					versionObserved: '1.2.3',
				},
				cleanup: { ownedProcesses: 2, stopped: 0 },
			});
			expect(c.offlineLeg!.probes.map((p) => [p.probe, p.argv, p.exitCode, p.timedOut])).toEqual([
				['version', ['--version'], 0, false],
				['help', ['--help'], 0, false],
			]);
			// Output is kept as digests only, never as text.
			const versionOut = 'grok-cli v1.2.3 (synthetic stand-in)\n';
			expect(c.offlineLeg!.probes[0].stdout).toEqual({
				sha256: createHash('sha256').update(versionOut).digest('hex'),
				bytes: Buffer.byteLength(versionOut),
				truncated: false,
			});
			expect(JSON.stringify(receipt)).not.toContain('synthetic stand-in');
			expect(c.status).toBe('not-run');
			expect(c.spawned).toBe(0);
			expect(ids(c)).toEqual(
				expect.arrayContaining(['discovery-authorization-absent', 'case-executor-unimplemented'])
			);
			expect(c.reasons.find((r) => r.id === 'case-executor-unimplemented')?.owner).toBe(
				'GT1-11-11A'
			);
			expect(receipt.totals).toMatchObject({ spawned: 2, paidRequests: 0, networkContacts: 0 });

			// What the harness handed the OS: the resolved pinned file, two argv, no shell, the planned env only.
			const plan = planIsolatedLaunch(
				offlineLegCase(caseOf('E02:acp-stdio:local')),
				cfg,
				'A',
				'offline',
				WORKSPACE,
				OPERATOR_HOME
			)!;
			const calls = spawnCalls();
			expect(calls.map(([file, argv]) => [file, argv])).toEqual([
				[fs.realpathSync(BIN), [...OFFLINE_PROBES.version]],
				[fs.realpathSync(BIN), [...OFFLINE_PROBES.help]],
			]);
			for (const [, , opts] of calls) {
				expect(opts.shell).toBe(false);
				expect(opts.env).toEqual(plan.env);
				expect(opts.cwd).toBe(path.join(ROOT, 'home'));
			}
			for (const s of spawnSpies.slice(1)) expect(s).not.toHaveBeenCalled();
			expect(fetchSpy).not.toHaveBeenCalled();

			// What the stand-in actually saw: its argv, every control var, no credential, no ambient secret.
			expect(logged('version', 'argv')).toBe('1\n--version\n');
			expect(logged('help', 'argv')).toBe('1\n--help\n');
			expect(logged('other', 'argv')).toBeNull();
			const seen = Object.fromEntries(
				logged('version', 'env')!
					.trim()
					.split('\n')
					.map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])
			);
			for (const [k, v] of Object.entries(GROK_CONTROL_ENV)) expect(seen[k], k).toBe(v);
			expect(seen.GROK_AUTH_PATH).toBeUndefined();
			expect(seen.XAI_API_KEY).toBeUndefined();
			expect(seen.HOME).toBe(path.join(ROOT, 'home'));
			const shellOwn = new Set(['PWD', 'OLDPWD', 'SHLVL', '_']);
			for (const k of Object.keys(seen))
				if (!shellOwn.has(k)) expect(Object.keys(plan.env), k).toContain(k);
			expect(logged('version', 'env')).not.toContain('SENTINEL');
		});

		it('is still refused without pin, isolation, disabled update or a local deny-all boundary, with zero spawns', async () => {
			const sha = standIn('ok');
			const flips: Array<
				[
					string,
					(c: ReturnType<typeof offlineConfig>) => void,
					string,
					string?,
					HarnessCapabilities?,
				]
			> = [
				['no path', (c) => (c.binary.path = null), 'binary-unpinned'],
				['no sha', (c) => (c.binary.sha256 = null), 'binary-unpinned'],
				['no version', (c) => (c.binary.version = null), 'binary-unpinned'],
				['update on', (c) => (c.autoUpdateDisabled = false), 'auto-update-not-disabled'],
				['no roots', (c) => (c.allowedRoots = []), 'allowed-roots-absent'],
				['no receipt', (c) => (c.isolationReceipt = null), 'host-isolation-unqualified'],
				[
					'no isolation',
					(c) => ((c as QualificationConfig).isolation = null),
					'isolation-undeclared',
				],
				[
					'egress open',
					(c) => (c.isolation.egress.kind = 'operation-aware' as never),
					'offline-egress-not-denied',
				],
				['not grok', (c) => (c.providers = ['codex' as never]), 'provider-not-authorized'],
				['wrong pin', (c) => (c.binary.sha256 = 'b'.repeat(64)), 'binary-hash-mismatch'],
				['ssh', () => undefined, 'offline-executor-local-only', 'E02:acp-stdio:ssh'],
				['not E02', () => undefined, 'offline-leg-absent', 'E03:acp-stdio:local'],
				[
					'executor off',
					() => undefined,
					'offline-executor-unimplemented',
					undefined,
					{ ...OFFLINE_CAPS, offlineExecutor: false },
				],
				[
					'preflight off',
					() => undefined,
					'isolation-preflight-unimplemented',
					undefined,
					{ ...OFFLINE_CAPS, isolationPreflight: false },
				],
			];
			// The fixture itself is admitted, so every refusal below is the flip's own.
			expect(ids(await leg(offlineConfig(sha)))).toEqual([]);
			// A fresh log and spy record (same bytes, same pin): the flips below must leave both empty.
			expect(standIn('ok')).toBe(sha);
			spawnSpies.forEach((s) => s.mockClear());
			for (const [label, flip, want, id, caps] of flips) {
				const cfg = offlineConfig(sha);
				flip(cfg);
				const r = await leg(cfg, caps, id);
				expect(ids(r), label).toContain(want);
				expect(r.status, label).toBe('not-run');
				expect(r.spawned, label).toBe(0);
				expect(r.probes, label).toEqual([]);
			}
			expectNoSpawn();
			expect(logged('version', 'argv')).toBeNull();
		});

		it('the executor re-checks before spawn: a hash mismatch, unpinned, updated, remote or mutable binary never starts', async () => {
			const sha = standIn('ok');
			const checks: Array<
				[string, (c: ReturnType<typeof offlineConfig>) => void, string, string?]
			> = [
				['hash', (c) => (c.binary.sha256 = 'c'.repeat(64)), 'binary-hash-mismatch-at-spawn'],
				['unpinned', (c) => (c.binary.version = null), 'binary-unpinned'],
				['update', (c) => (c.autoUpdateDisabled = false), 'auto-update-not-disabled'],
				['ssh', () => undefined, 'offline-executor-local-only', 'E02:acp-stdio:ssh'],
				['absent', (c) => (c.binary.path = `${REL}/bin/absent`), 'binary-unreadable'],
				[
					'no isolation',
					(c) => ((c as QualificationConfig).isolation = null),
					'offline-launch-unplannable',
				],
				[
					'path under operator home',
					(c) => (c.isolation.path = [path.join(OPERATOR_HOME, 'bin'), '/usr/bin', '/bin']),
					'env-path-under-operator-home',
				],
				[
					'home absent',
					(c) => (c.isolation.boundary!.actualHome = `${REL}/no-home`),
					'offline-home-absent',
				],
			];
			for (const [label, flip, want, id] of checks) {
				const cfg = offlineConfig(sha);
				flip(cfg);
				const r = await exec(cfg, id);
				expect(ids(r), label).toEqual([want]);
				expect([r.spawned, r.probes.length], label).toEqual([0, 0]);
			}
			fs.chmodSync(BIN, 0o755);
			try {
				expect(ids(await exec(offlineConfig(sha)))).toEqual(['binary-mutable']);
			} finally {
				fs.chmodSync(BIN, 0o555);
			}
			expectNoSpawn();
			expect(logged('version', 'argv')).toBeNull();
		});

		it('a credential reference in the config never reaches the offline child', async () => {
			const sha = standIn('ok');
			fs.mkdirSync(path.join(ROOT, 'auth'), { recursive: true });
			fs.writeFileSync(path.join(ROOT, 'auth', 'a.json'), '{}');
			const refs: QualificationConfig['credentialReferences'] = [
				{ provider: 'grok', account: 'A', kind: 'file', path: `${REL}/auth/a.json` },
				{ provider: 'grok', account: 'A', kind: 'secret-name', name: 'GROK_QUAL_ACCOUNT_A' },
			];
			for (const ref of refs) {
				spawnSpies.forEach((s) => s.mockClear());
				const cfg = offlineConfig(sha);
				cfg.credentialReferences = [ref];
				const r = await leg(cfg);
				expect(r.status, ref.kind).toBe('passed');
				expect(spawnCalls(), ref.kind).toHaveLength(2);
				for (const [, , opts] of spawnCalls()) {
					expect(opts.env.GROK_AUTH_PATH, ref.kind).toBeUndefined();
					expect(opts.env.XAI_API_KEY, ref.kind).toBeUndefined();
				}
				expect(logged('version', 'env'), ref.kind).not.toMatch(
					/GROK_AUTH_PATH|XAI_API_KEY|a\.json/
				);
			}
		});

		it('a probe that outlives its bound is stopped as an owned child and fails the leg', async () => {
			const sha = standIn('sleep');
			const cfg = offlineConfig(sha);
			const started = Date.now();
			const { receipt } = await runQualification({
				workspace: WORKSPACE,
				runState: RUN_STATE,
				config: cfg,
				selectedCases: ['E02:acp-stdio:local'],
				capabilities: OFFLINE_CAPS,
				now: clock,
				runId: runId(),
				operatorHome: OPERATOR_HOME,
				offlineProbeTimeoutMs: 300,
			});
			expect(Date.now() - started).toBeLessThan(HARNESS_CEILINGS.offlineProbeSeconds * 1000);
			const off = receipt.cases[0].offlineLeg!;
			expect(off.status).toBe('failed');
			expect(ids(off)).toEqual(['probe-timeout']);
			// The help probe never starts after a failed version probe.
			expect(off.probes).toHaveLength(1);
			expect(off.probes[0]).toMatchObject({ probe: 'version', timedOut: true, signal: 'SIGTERM' });
			expect(off.probes[0].durationMs).toBeGreaterThanOrEqual(250);
			expect(off.cleanup).toEqual({ ownedProcesses: 1, stopped: 0 });
			const pid = Number(logged('version', 'pid'));
			expect(pid).toBeGreaterThan(0);
			expect(() => process.kill(pid, 0)).toThrow();
			expect(spawnCalls()).toHaveLength(1);
		});

		it('a version that differs from the pin, a failing, unbounded or self-changing probe fails the leg', async () => {
			const cases: Array<[Mode, string, string[], number, string | null]> = [
				['ok', '9.9.9', ['binary-version-mismatch'], 2, '1.2.3'],
				['fail', '1.2.3', ['probe-exit-nonzero'], 1, '1.2.3'],
				['big', '1.2.3', ['probe-output-unbounded'], 1, null],
				['mutate', '1.2.3', ['binary-changed-during-probe'], 1, '1.2.3'],
				['noversion', '1.2.3', ['binary-version-unparsed'], 2, null],
			];
			for (const [mode, version, want, spawned, observed] of cases) {
				const sha = standIn(mode);
				const r = await leg(offlineConfig(sha, version));
				expect(ids(r), mode).toEqual(want);
				expect(r.status, mode).toBe('failed');
				expect(r.spawned, mode).toBe(spawned);
				expect(r.binary.versionObserved, mode).toBe(observed);
				expect(r.binary.versionPinned, mode).toBe(version);
			}
			const big = standIn('big');
			const r = await leg(offlineConfig(big));
			expect(r.probes[0].stdout.truncated).toBe(true);
			expect(r.probes[0].stdout.bytes).toBeGreaterThan(OFFLINE_OUTPUT_CAP_BYTES);
			// A leading v in the pin is the same version; an unparsable output is not a match.
			expect((await leg(offlineConfig(standIn('ok'), 'v1.2.3'))).status).toBe('passed');
			expect(parseProbeVersion('grok-cli v1.2.3-rc.1+abc (build)')).toBe('1.2.3-rc.1+abc');
			expect(parseProbeVersion('grok 2.0.10')).toBe('2.0.10');
			expect(parseProbeVersion('grok build x1.2.3 or 20261101')).toBeNull();
		});
	});
});
