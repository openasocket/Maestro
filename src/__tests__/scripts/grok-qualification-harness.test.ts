/**
 * GT1-11-09: the Grok qualification harness end to end, with no provider,
 * credential or network: honest not-run receipts, candidate capability
 * snapshots confined to the harness, owned-process cleanup through the shared
 * termination ladder (on a fake sleeping process), and redaction.
 *
 * Spend admission has its own suite (`grok-qualification-spend.test.ts`).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	CANDIDATE_CAPABILITIES,
	CONFIG_SCHEMA,
	POLICY_BEARING_FLAGS,
	RUNS_ROOT,
	admitCase,
	buildCandidateSnapshot,
	createCaseLifetime,
	defaultConfigFromRunState,
	expandCases,
	main,
	productionCapabilityDigest,
	redactDeep,
	runQualification,
	validateConfig,
	type CandidateCapability,
	type HarnessCapabilities,
	type QualificationConfig,
} from '../../../scripts/grok-qualification/harness';
import { getAgentCapabilities } from '../../../src/shared/maestro-lib/providers/capabilities';

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
				expect(c.reasons.map((r) => r.id)).toContain('case-executor-unimplemented');
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
});
