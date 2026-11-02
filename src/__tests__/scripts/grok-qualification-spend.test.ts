/**
 * GT1-11-09: the Grok qualification harness's spend admission, driven with a
 * fake budget provider (`liveConfig`), a fixed clock and no provider process.
 *
 * Every test removes or bypasses one precondition or accounting guard and
 * asserts the case is refused or the charge stays visible. A paid case may
 * only ever reach an executor after a worst-case reservation (or a covering
 * provider cap) is held on the one shared run ledger; request and token
 * bounds alone never pass the dollar gate, an unknown cost stays unknown and
 * an uncertain charge is never refunded, read as zero, or retried.
 *
 * GT1-11-11P2 drives the paid executor (GT1-11-11P1) against the same shared
 * ledger: an earlier uncertain effect or an already-run leg is never re-sent,
 * and a run budget or turn limit exhausted by an earlier case refuses the
 * reservation, each with the child_process entry points spied and a pinned
 * stand-in that would leave a marker if it were ever started.
 */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	CONFIG_SCHEMA,
	HARNESS_CEILINGS,
	RUNS_ROOT,
	admitCase,
	createBudgetLedger,
	createCaseLifetime,
	executePaidCase,
	expandCases,
	markUncertainEffect,
	paidCallsPerTurn,
	planCaseReservation,
	preflightCase,
	recordBillableCall,
	recordUserTurn,
	releaseReservation,
	reserveSpend,
	settleReservation,
	type BudgetLedger,
	type CaseFamily,
	type HarnessCapabilities,
	type QualificationCase,
	type QualificationConfig,
	type ReservationRequest,
} from '../../../scripts/grok-qualification/harness';

/** Pass-through spies on every child_process entry point, so a test can prove none ran. */
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
const WORKSPACE = path.resolve(__dirname, '../../..');

/** A priced stand-in model (the price table knows no Grok model). */
const PRICED = 'claude-haiku-4-5';
/** A model the canonical price table does not know: its cost is unknown, never the default tier. */
const UNPRICED = 'grok-4-fast';
const ENDPOINT = 'https://api.x.ai';
const NOW = new Date('2026-11-01T12:00:00.000Z');
const at = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);

const FAMILIES: CaseFamily[] = ['E03', 'E05', 'E11'].map((id) => ({
	id,
	requirementIds: [`R-${id}`],
	ownerTasks: ['GT1-11-09'],
	expectedInvariant: 'synthetic',
	blockerIds: [],
}));
const ALL = expandCases(FAMILIES);
const caseOf = (id: string): QualificationCase => {
	const c = ALL.find((x) => x.caseId === id);
	if (!c) throw new Error(`no case ${id}`);
	return c;
};
const E03 = caseOf('E03:acp-stdio:local');
const E05 = caseOf('E05:native-headless:local');
const E11 = caseOf('E11:acp-stdio:local');

/** Every harness capability on, so only the guard under test can refuse. */
const ALL_CAPS: HarnessCapabilities = {
	isolationPreflight: true,
	atomicSpendAdmission: true,
	// Off: these suites decide admission only; the offline executor has its own block (GT1-11-10B).
	offlineExecutor: false,
	caseExecutor: true,
};

/** The fake budget provider: a fully authorized worst-case-reservation config. */
function liveConfig(patch: Partial<QualificationConfig> = {}): QualificationConfig {
	return {
		schema: CONFIG_SCHEMA,
		authorizationReference: 'auth:gt1-11-09-synthetic',
		expiresAt: at(3600).toISOString(),
		providers: ['grok'],
		credentialReferences: [
			{ provider: 'grok', account: 'A', kind: 'secret-name', name: 'GROK_QUAL_ACCOUNT_A' },
			{ provider: 'grok', account: 'B', kind: 'secret-name', name: 'GROK_QUAL_ACCOUNT_B' },
		],
		allowedRoots: [`${RUNS_ROOT}/gt1-11-09`],
		allowedEndpoints: [ENDPOINT],
		allowedSshTargets: ['qual-host'],
		allowedModels: [PRICED],
		binary: { path: 'bin/grok', sha256: 'a'.repeat(64), version: '0.0.0-synthetic' },
		autoUpdateDisabled: true,
		isolationReceipt: 'isolation:synthetic',
		isolation: null,
		discovery: { authorizationReference: null, operations: [] },
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
		cases: [],
		...patch,
	};
}

function ledgerFor(config: QualificationConfig, ...authorized: QualificationCase[]): BudgetLedger {
	const ledger = createBudgetLedger(config, `gt1-11-09-${randomUUID()}`, NOW);
	ledger.authorizedCaseIds.push(...authorized.map((c) => c.caseId));
	return ledger;
}

function request(
	c: QualificationCase,
	config: QualificationConfig,
	patch: Partial<ReservationRequest> = {}
): ReservationRequest {
	return {
		caseId: c.caseId,
		provider: 'grok',
		account: 'A',
		endpoint: ENDPOINT,
		models: [...config.allowedModels],
		target: c.target,
		plan: planCaseReservation(c, config),
		...patch,
	};
}

const ids = (reasons: Array<{ id: string }>) => reasons.map((r) => r.id);

function refusal(result: ReturnType<typeof reserveSpend>): string[] {
	if (result.ok) throw new Error('reservation was admitted');
	return ids(result.reasons);
}

function held(result: ReturnType<typeof reserveSpend>) {
	if (!result.ok) throw new Error(`reservation refused: ${ids(result.reasons).join(',')}`);
	return result.reservation;
}

describe('GT1-11-09 qualification spend admission', () => {
	describe('the control: a fully authorized priced case', () => {
		it('plans a known worst case from every billable call kind and holds it', () => {
			const config = liveConfig();
			expect(admitCase(E03, config, [], ALL_CAPS, NOW)).toEqual([]);
			const plan = planCaseReservation(E03, config);
			expect(plan.reasons).toEqual([]);
			// 2 rounds + 1 child + 1 retry per turn, 2 turns (the design ceiling).
			expect(plan.callsPerTurn).toBe(4);
			expect(plan.calls).toBe(8);
			expect(plan.costKnown).toBe(true);
			expect(plan.worstCaseUsd).toBeGreaterThan(0);
			expect(plan.holdUsd).toBe(plan.worstCaseUsd);
			const ledger = ledgerFor(config, E03);
			const r = held(reserveSpend(ledger, config, request(E03, config), NOW));
			expect(r.holdUsd).toBe(plan.worstCaseUsd);
			expect(r.callAllowance).toBe(8);
			expect(ledger.reservedUsd).toBe(plan.worstCaseUsd);
		});
	});

	describe('no paid case without its preconditions', () => {
		it('a zero dollar budget refuses admission and the reservation', () => {
			const base = liveConfig().limits;
			const broke = liveConfig({
				limits: { ...base, budgetUsd: 0, perCase: { ...base.perCase, budgetUsd: 0 } },
			});
			const reasons = ids(admitCase(E03, broke, [], ALL_CAPS, NOW));
			expect(reasons).toEqual(
				expect.arrayContaining([
					'live-limits-unset',
					'worst-case-exceeds-case-budget',
					'worst-case-exceeds-run-budget',
				])
			);
			// Even forced onto the authorized list, the ledger holds nothing.
			const ledger = ledgerFor(broke, E03);
			expect(refusal(reserveSpend(ledger, broke, request(E03, broke), NOW))).toEqual(
				expect.arrayContaining([
					'plan-not-admissible',
					'run-budget-exhausted',
					'case-budget-exhausted',
				])
			);
			expect(ledger.reservations).toEqual([]);
		});

		it('all-zero limits plan a zero hold, which is refused rather than read as free', () => {
			const zero = liveConfig({
				limits: {
					budgetUsd: 0,
					maxCalls: 0,
					maxTurns: 0,
					maxWallClockSeconds: 0,
					perCase: { budgetUsd: 0, maxCalls: 0, maxTurns: 0, maxWallClockSeconds: 0 },
					cleanupSeconds: 5,
				},
			});
			expect(ids(admitCase(E03, zero, [], ALL_CAPS, NOW))).toContain('live-limits-unset');
			expect(planCaseReservation(E03, zero).holdUsd).toBe(0);
			const refused = refusal(reserveSpend(ledgerFor(zero, E03), zero, request(E03, zero), NOW));
			expect(refused).toEqual(
				expect.arrayContaining(['reservation-hold-not-positive', 'run-deadline-passed'])
			);
		});

		it('missing or expired authorization and a missing credential refuse', () => {
			const noAuth = liveConfig({ authorizationReference: null });
			expect(ids(admitCase(E03, noAuth, [], ALL_CAPS, NOW))).toContain('live-authorization-absent');
			expect(
				refusal(reserveSpend(ledgerFor(noAuth, E03), noAuth, request(E03, noAuth), NOW))
			).toContain('live-authorization-absent');

			const expired = liveConfig({ expiresAt: at(-1).toISOString() });
			expect(ids(admitCase(E03, expired, [], ALL_CAPS, NOW))).toContain(
				'live-authorization-expired'
			);
			expect(
				refusal(reserveSpend(ledgerFor(expired, E03), expired, request(E03, expired), NOW))
			).toContain('live-authorization-expired');

			const noCredential = liveConfig({ credentialReferences: [] });
			expect(ids(admitCase(E03, noCredential, [], ALL_CAPS, NOW))).toContain(
				'credential-reference-absent'
			);
			expect(
				refusal(
					reserveSpend(ledgerFor(noCredential, E03), noCredential, request(E03, noCredential), NOW)
				)
			).toContain('credential-reference-absent');
		});

		it('a case the run did not admit cannot reserve', () => {
			const config = liveConfig();
			const ledger = ledgerFor(config);
			expect(refusal(reserveSpend(ledger, config, request(E03, config), NOW))).toContain(
				'case-not-admitted'
			);
			expect(ledger.reservations).toEqual([]);
		});

		it('a plan for another case, an unapproved endpoint, model or SSH host is refused, never widened', () => {
			const config = liveConfig();
			const ledger = ledgerFor(config, E03);
			const wrongPlan = { ...request(E03, config), plan: planCaseReservation(E05, config) };
			expect(refusal(reserveSpend(ledger, config, wrongPlan, NOW))).toContain('plan-case-mismatch');
			expect(
				refusal(
					reserveSpend(
						ledger,
						config,
						request(E03, config, { endpoint: 'https://evil.example' }),
						NOW
					)
				)
			).toContain('endpoint-not-approved');
			expect(
				refusal(reserveSpend(ledger, config, request(E03, config, { models: [UNPRICED] }), NOW))
			).toContain('model-not-authorized');
			const ssh = caseOf('E03:acp-stdio:ssh');
			ledger.authorizedCaseIds.push(ssh.caseId);
			expect(
				refusal(
					reserveSpend(ledger, config, request(ssh, config, { sshTarget: 'other-host' }), NOW)
				)
			).toContain('ssh-target-unapproved');
			expect(ledger.reservations).toEqual([]);
		});
	});

	describe('the dollar gate', () => {
		it('request and token bounds alone, with no spend guarantee, never pass', () => {
			const config = liveConfig({ spendGuarantee: null });
			const plan = planCaseReservation(E03, config);
			// The bounds price out, but nothing guarantees them.
			expect(plan.calls).toBe(8);
			expect(plan.worstCaseUsd).toBeGreaterThan(0);
			expect(plan.guarantee).toBeNull();
			expect(plan.holdUsd).toBe(0);
			expect(ids(admitCase(E03, config, [], ALL_CAPS, NOW))).toContain('spend-guarantee-absent');
			expect(
				refusal(reserveSpend(ledgerFor(config, E03), config, request(E03, config), NOW))
			).toEqual(
				expect.arrayContaining(['spend-guarantee-absent', 'reservation-hold-not-positive'])
			);
		});

		it('a reservation guarantee with no bounds, or bounds with no output bound, leaves the cost unknown and refuses', () => {
			const undeclared = liveConfig({ spendBounds: null });
			const plan = planCaseReservation(E03, undeclared);
			expect(ids(plan.reasons)).toEqual(
				expect.arrayContaining(['spend-bounds-undeclared', 'worst-case-unknown'])
			);
			expect(plan.worstCaseUsd).toBeNull();
			expect(plan.costKnown).toBe(false);

			const base = liveConfig().spendBounds!;
			const noOutput = liveConfig({
				spendBounds: { ...base, perCall: { ...base.perCall, outputTokens: 0 } },
			});
			expect(ids(planCaseReservation(E03, noOutput).reasons)).toEqual(
				expect.arrayContaining(['spend-bounds-invalid', 'worst-case-unknown'])
			);
		});

		it('an unknown price is refused under a reservation and is never the default tier', () => {
			const config = liveConfig({ allowedModels: [UNPRICED] });
			const plan = planCaseReservation(E03, config);
			expect(plan.models[0]).toMatchObject({
				model: UNPRICED,
				source: 'unknown',
				perCallUsd: null,
			});
			expect(plan.worstCaseUsd).toBeNull();
			const reasons = ids(admitCase(E03, config, [], ALL_CAPS, NOW));
			expect(reasons).toEqual(expect.arrayContaining(['price-unknown', 'worst-case-unknown']));
		});

		it('an unpriced child or side model is refused under a reservation', () => {
			const base = liveConfig().spendBounds!;
			const config = liveConfig({
				spendBounds: {
					...base,
					perTurnCalls: { ...base.perTurnCalls, sideModels: 1 },
					sideModels: [UNPRICED],
				},
			});
			const plan = planCaseReservation(E03, config);
			expect(ids(plan.reasons)).toEqual(
				expect.arrayContaining(['price-unknown', 'worst-case-unknown'])
			);
			expect(plan.callsPerTurn).toBe(5);
		});

		it('an external provider cap admits an unknown price but the cost stays unknown, even settled', () => {
			const config = liveConfig({
				allowedModels: [UNPRICED],
				spendGuarantee: { kind: 'provider-cap', reference: 'cap:synthetic', capUsd: 5 },
			});
			const plan = planCaseReservation(E03, config);
			expect(plan.reasons).toEqual([]);
			expect(plan.costKnown).toBe(false);
			expect(plan.worstCaseUsd).toBeNull();
			// The ledger holds the whole case budget: the cap is never read as the cost.
			expect(plan.holdUsd).toBe(2);
			const ledger = ledgerFor(config, E03);
			const r = held(reserveSpend(ledger, config, request(E03, config), NOW));
			expect(r.costKnown).toBe(false);
			recordUserTurn(ledger, r.id, NOW);
			recordBillableCall(ledger, r.id, { kind: 'model-round', model: UNPRICED }, NOW);
			// No actual cost is available: nothing is refunded and nothing reads zero.
			const settled = settleReservation(
				ledger,
				r.id,
				{ kind: 'settled', actualUsd: null, reason: 'actual cost unavailable' },
				at(1)
			);
			expect(settled.state).toBe('uncertain');
			expect(settled.uncertainUsd).toBe(2);
			expect(settled.settledUsd).toBe(0);
			expect(ledger.uncertainUsd).toBe(2);
			expect(ledger.reservedUsd).toBe(0);
		});

		it('a provider cap larger than the run budget, or not covering every provider, refuses', () => {
			const tooLarge = liveConfig({
				spendGuarantee: { kind: 'provider-cap', reference: 'cap:synthetic', capUsd: 50 },
			});
			expect(ids(planCaseReservation(E03, tooLarge).reasons)).toContain(
				'provider-cap-exceeds-run-budget'
			);
			const grokOnly = liveConfig({
				providers: ['grok', 'claude-code', 'codex'],
				spendGuarantee: { kind: 'provider-cap', reference: 'cap:synthetic', capUsd: 5 },
			});
			const reasons = planCaseReservation(E11, grokOnly).reasons;
			expect(
				reasons.filter((r) => r.id === 'provider-cap-does-not-cover').map((r) => r.detail)
			).toEqual(['claude-code', 'codex']);
		});
	});

	describe('the shared ledger', () => {
		it('concurrent cases see each other: the second waits for the first to settle', () => {
			const config = liveConfig();
			const ledger = ledgerFor(config, E03, E05);
			const first = held(reserveSpend(ledger, config, request(E03, config), NOW));
			expect(HARNESS_CEILINGS.concurrentCases).toBe(1);
			expect(refusal(reserveSpend(ledger, config, request(E05, config), NOW))).toContain(
				'concurrency-limit'
			);
			releaseReservation(ledger, first.id, NOW);
			held(reserveSpend(ledger, config, request(E05, config), NOW));
		});

		it('uncertain charges stay on the run budget and refuse later reservations', () => {
			const config = liveConfig({
				limits: { ...liveConfig().limits, budgetUsd: 0.05 },
			});
			const ledger = ledgerFor(config, E03, E05);
			const first = held(reserveSpend(ledger, config, request(E03, config), NOW));
			settleReservation(ledger, first.id, { kind: 'uncertain', reason: 'disconnect' }, at(1));
			expect(ledger.uncertainUsd).toBe(first.holdUsd);
			expect(refusal(reserveSpend(ledger, config, request(E05, config), at(2)))).toContain(
				'run-budget-exhausted'
			);
		});

		it('there is no reset: a second ledger for the same run throws', () => {
			const config = liveConfig();
			const runId = `gt1-11-09-${randomUUID()}`;
			createBudgetLedger(config, runId, NOW);
			expect(() => createBudgetLedger(config, runId, NOW)).toThrow(/already exists/);
		});

		it('cross-provider legs share the case budget and calls; turns are per leg', () => {
			const config = liveConfig({
				providers: ['grok', 'claude-code', 'codex'],
				credentialReferences: [
					{ provider: 'grok', account: 'A', kind: 'secret-name', name: 'GROK_A' },
					{ provider: 'claude-code', account: 'A', kind: 'secret-name', name: 'CLAUDE_A' },
					{ provider: 'codex', account: 'A', kind: 'secret-name', name: 'CODEX_A' },
				],
				limits: {
					...liveConfig().limits,
					perCase: { budgetUsd: 2, maxCalls: 20, maxTurns: 2, maxWallClockSeconds: 120 },
				},
			});
			const ledger = ledgerFor(config, E11);
			const grok = held(reserveSpend(ledger, config, request(E11, config, { leg: 'grok' }), NOW));
			const claude = held(
				reserveSpend(
					ledger,
					config,
					request(E11, config, { leg: 'claude', provider: 'claude-code' }),
					NOW
				)
			);
			// 8 + 8 calls held; a third leg of 8 overruns the shared per-case 20.
			expect(
				refusal(
					reserveSpend(
						ledger,
						config,
						request(E11, config, { leg: 'codex', provider: 'codex' }),
						NOW
					)
				)
			).toContain('case-calls-exhausted');
			// The same leg again overruns its own turn ceiling.
			expect(
				refusal(reserveSpend(ledger, config, request(E11, config, { leg: 'grok' }), NOW))
			).toContain('case-turns-exhausted');
			expect(ledger.byProvider.grok.reservedUsd).toBe(grok.holdUsd);
			expect(ledger.byProvider['claude-code'].reservedUsd).toBe(claude.holdUsd);
			// Later legs inherit the case deadline from the first hold.
			expect(claude.deadlineAt).toBe(grok.deadlineAt);
		});
	});

	describe('per-call accounting', () => {
		it('children, retries and rounds draw one allowance, before dispatch', () => {
			const config = liveConfig();
			const ledger = ledgerFor(config, E03);
			const r = held(reserveSpend(ledger, config, request(E03, config), NOW));
			recordBillableCall(ledger, r.id, { kind: 'child', model: PRICED }, NOW);
			for (let i = 0; i < 7; i++)
				recordBillableCall(ledger, r.id, { kind: 'model-round', model: PRICED }, NOW);
			expect(r.callsByKind).toMatchObject({ child: 1, 'model-round': 7 });
			expect(() =>
				recordBillableCall(ledger, r.id, { kind: 'model-round', model: PRICED }, NOW)
			).toThrow(/allowance exhausted/);
			expect(() =>
				recordBillableCall(ledger, r.id, { kind: 'side-model', model: UNPRICED }, NOW)
			).toThrow(/not bound/);
			expect(ledger.calls).toBe(8);
		});

		it('an uncertain effect is never retried automatically', () => {
			const config = liveConfig();
			const ledger = ledgerFor(config, E03);
			const r = held(reserveSpend(ledger, config, request(E03, config), NOW));
			recordBillableCall(ledger, r.id, { kind: 'model-round', model: PRICED }, NOW);
			markUncertainEffect(ledger, r.id);
			expect(() => recordBillableCall(ledger, r.id, { kind: 'retry', model: PRICED }, NOW)).toThrow(
				/never retried/
			);
			expect(r.callsByKind.retry).toBe(0);
			// Work that dispatched is settled, never quietly released.
			expect(() => releaseReservation(ledger, r.id, NOW)).toThrow(/must be settled/);
		});

		it('a known actual after an uncertain effect still stays uncertain; partials and overruns are kept', () => {
			const config = liveConfig();
			const ledger = ledgerFor(config, E03, E05);
			const a = held(reserveSpend(ledger, config, request(E03, config), NOW));
			recordBillableCall(ledger, a.id, { kind: 'model-round', model: PRICED }, NOW);
			markUncertainEffect(ledger, a.id);
			const s = settleReservation(
				ledger,
				a.id,
				{ kind: 'settled', actualUsd: 0.001, reason: 'reported after timeout' },
				at(1)
			);
			expect(s.state).toBe('uncertain');
			expect(s.uncertainUsd).toBeCloseTo(a.holdUsd - 0.001, 6);

			const b = held(reserveSpend(ledger, config, request(E05, config), at(2)));
			recordBillableCall(ledger, b.id, { kind: 'model-round', model: PRICED }, at(2));
			const over = settleReservation(
				ledger,
				b.id,
				{ kind: 'settled', actualUsd: b.holdUsd + 1, reason: 'bound was wrong' },
				at(3)
			);
			expect(over.state).toBe('settled');
			expect(over.overrunUsd).toBeCloseTo(1, 6);
			expect(() =>
				settleReservation(ledger, b.id, { kind: 'settled', actualUsd: 0, reason: 'again' }, at(4))
			).toThrow(/is settled/);
		});
	});

	describe('timeouts', () => {
		it('the reservation deadline is the earliest of authorization, case and run deadlines', () => {
			const config = liveConfig();
			const ledger = ledgerFor(config, E03);
			const r = held(reserveSpend(ledger, config, request(E03, config), NOW));
			expect(r.deadlineAt).toBe(at(120).toISOString());
			expect(() =>
				recordBillableCall(ledger, r.id, { kind: 'model-round', model: PRICED }, at(120))
			).toThrow(/deadline/);
			expect(() => recordUserTurn(ledger, r.id, at(121))).toThrow(/deadline/);

			const shortAuth = liveConfig({ expiresAt: at(30).toISOString() });
			const l2 = ledgerFor(shortAuth, E03);
			expect(held(reserveSpend(l2, shortAuth, request(E03, shortAuth), NOW)).deadlineAt).toBe(
				at(30).toISOString()
			);
		});

		it('no reservation once the run deadline has passed', () => {
			const config = liveConfig();
			const ledger = ledgerFor(config, E03);
			expect(refusal(reserveSpend(ledger, config, request(E03, config), at(600)))).toContain(
				'run-deadline-passed'
			);
		});
	});

	describe.skipIf(process.platform === 'win32')(
		'the paid executor on the shared ledger (GT1-11-11P2)',
		() => {
			const REL = `${RUNS_ROOT}/gt1-11-11p2-spend-${process.pid}`;
			const ROOT = path.join(WORKSPACE, REL);
			const BIN = path.join(ROOT, 'bin', 'grok');
			const OPERATOR_HOME = path.join(os.tmpdir(), `gt1-11-11p2-spend-operator-${process.pid}`);
			/** A pinned stand-in that writes a marker if it is ever started; every case below must refuse first. */
			const MARKER = path.join(ROOT, 'started');
			let sha = '';
			const paidConfig = (patch: Partial<QualificationConfig> = {}): QualificationConfig =>
				liveConfig({
					credentialReferences: [
						{ provider: 'grok', account: 'A', kind: 'file', path: `${REL}/auth/a.json` },
						{ provider: 'grok', account: 'B', kind: 'file', path: `${REL}/auth/b.json` },
					],
					allowedRoots: [REL],
					binary: { path: `${REL}/bin/grok`, sha256: sha, version: '0.0.0-synthetic' },
					isolation: {
						boundary: {
							kind: 'disposable-os-account',
							reference: 'boundary:synthetic',
							actualHome: `${REL}/home`,
							productionHomeMounted: false,
							operatorCredentialsReadable: false,
						},
						accountRoots: { A: `${REL}/grok-a`, B: `${REL}/grok-b` },
						remoteRoots: {},
						policy: {
							systemPolicyInspected: true,
							managedPolicy: 'absent',
							requiredPolicyCompatible: true,
						},
						resources: { hooks: 'empty', mcp: 'empty', plugins: 'empty', envrc: 'disabled' },
						egress: {
							kind: 'operation-aware',
							reference: 'egress:synthetic',
							suppression: {
								update: 'flags-only',
								telemetry: 'flags-only',
								backgroundUpload: 'unknown',
							},
						},
						path: ['/usr/bin', '/bin'],
					},
					...patch,
				});
			const execute = (c: QualificationCase, config: QualificationConfig, ledger: BudgetLedger) =>
				executePaidCase(c, config, {
					workspace: WORKSPACE,
					operatorHome: OPERATOR_HOME,
					ledger,
					lifetime: createCaseLifetime(1),
					problems: [],
					capabilities: ALL_CAPS,
					now: () => NOW,
				});
			/** A closed earlier reservation of `c` on the ledger, in the state the case needs. */
			const prior = (
				ledger: BudgetLedger,
				config: QualificationConfig,
				c: QualificationCase,
				close: 'uncertain' | 'settled' | 'turns-settled'
			) => {
				const r = held(reserveSpend(ledger, config, request(c, config), NOW));
				if (close === 'uncertain') {
					recordUserTurn(ledger, r.id, NOW);
					markUncertainEffect(ledger, r.id);
					settleReservation(ledger, r.id, { kind: 'uncertain', reason: 'synthetic-timeout' }, NOW);
				} else {
					if (close === 'turns-settled') {
						recordUserTurn(ledger, r.id, NOW);
						recordUserTurn(ledger, r.id, NOW);
					}
					settleReservation(
						ledger,
						r.id,
						{
							kind: 'settled',
							actualUsd: close === 'settled' ? r.holdUsd : 0,
							reason: 'synthetic',
						},
						NOW
					);
				}
				return r;
			};
			const snapshot = (l: BudgetLedger) =>
				JSON.stringify([
					l.reservations,
					l.turns,
					l.calls,
					l.reservedUsd,
					l.settledUsd,
					l.uncertainUsd,
				]);
			const expectNothingStarted = () => {
				for (const s of spawnSpies) expect(s).not.toHaveBeenCalled();
				expect(fs.existsSync(MARKER)).toBe(false);
			};

			beforeAll(() => {
				for (const d of ['home', 'grok-a', 'grok-b', 'auth', 'bin', path.join('cache', 'tmp')])
					fs.mkdirSync(path.join(ROOT, d), { recursive: true });
				fs.writeFileSync(path.join(ROOT, 'auth', 'a.json'), '{}');
				fs.writeFileSync(path.join(ROOT, 'auth', 'b.json'), '{}');
				fs.writeFileSync(BIN, `#!/bin/sh\ntouch '${MARKER}'\nexit 0\n`);
				fs.chmodSync(BIN, 0o555);
				sha = createHash('sha256').update(fs.readFileSync(BIN)).digest('hex');
			});
			afterAll(() => {
				if (fs.existsSync(BIN)) fs.chmodSync(BIN, 0o755);
				fs.rmSync(ROOT, { recursive: true, force: true });
			});
			beforeEach(() => {
				spawnSpies.forEach((s) => s.mockClear());
				fs.rmSync(MARKER, { force: true });
			});

			it('the control: the fixture is admitted, preflights clean and draws every per-turn call kind', () => {
				const config = paidConfig();
				expect(admitCase(E03, config, [], ALL_CAPS, NOW)).toEqual([]);
				expect(admitCase(E05, config, [], ALL_CAPS, NOW)).toEqual([]);
				expect(
					preflightCase(E05, config, { workspace: WORKSPACE, operatorHome: OPERATOR_HOME }).reasons
				).toEqual([]);
				const r = held(reserveSpend(ledgerFor(config, E05), config, request(E05, config), NOW));
				expect(paidCallsPerTurn(config, r)).toEqual({
					'model-round': 2,
					child: 1,
					retry: 1,
					'side-model': 0,
					compaction: 0,
				});
				// No per-turn bounds (a covering cap): an even share of the allowance as model rounds.
				const capped = { ...config, spendBounds: undefined } as QualificationConfig;
				expect(paidCallsPerTurn(capped, { callAllowance: 9, turnAllowance: 2 })).toMatchObject({
					'model-round': 4,
					child: 0,
					retry: 0,
				});
				expect(
					paidCallsPerTurn(capped, { callAllowance: 0, turnAllowance: 0 })['model-round']
				).toBe(1);
			});

			it('a leg whose earlier effect is uncertain is never retried, and a leg that ran never runs twice', async () => {
				const config = paidConfig();
				for (const [close, want] of [
					['uncertain', 'uncertain-prior-effect'],
					['settled', 'leg-already-run'],
				] as const) {
					const ledger = ledgerFor(config, E05);
					prior(ledger, config, E05, close);
					const before = snapshot(ledger);
					const [leg] = await execute(E05, config, ledger);
					expect(ids(leg.reasons), close).toEqual([want]);
					expect(leg, close).toMatchObject({ status: 'not-run', spawned: 0, reservationId: null });
					expect(snapshot(ledger), close).toBe(before);
				}
				expectNothingStarted();
			});

			it('an exhausted shared run budget or turn limit refuses the reservation before any spawn', async () => {
				const base = paidConfig();
				const hold = planCaseReservation(E05, base).holdUsd;
				const cases: Array<
					[string, Partial<QualificationConfig>, 'settled' | 'turns-settled', string]
				> = [
					[
						'dollars',
						{
							limits: {
								...base.limits,
								budgetUsd: hold * 1.5,
								perCase: { ...base.limits.perCase, budgetUsd: hold * 1.5 },
							},
						},
						'settled',
						'run-budget-exhausted',
					],
					[
						'turns',
						{ limits: { ...base.limits, maxTurns: 3 } },
						'turns-settled',
						'run-turns-exhausted',
					],
				];
				for (const [label, patch, close, want] of cases) {
					const config = paidConfig(patch);
					// The case alone is admissible: only the earlier case on the same ledger exhausts the run.
					expect(admitCase(E05, config, [], ALL_CAPS, NOW), label).toEqual([]);
					const ledger = ledgerFor(config, E03, E05);
					prior(ledger, config, E03, close);
					const before = snapshot(ledger);
					const [leg] = await execute(E05, config, ledger);
					expect(ids(leg.reasons), label).toEqual([want]);
					expect(leg, label).toMatchObject({ status: 'not-run', spawned: 0, reservationId: null });
					expect(snapshot(ledger), label).toBe(before);
				}
				expectNothingStarted();
			});
		}
	);
});
