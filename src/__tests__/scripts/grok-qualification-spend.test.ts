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
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
	CONFIG_SCHEMA,
	HARNESS_CEILINGS,
	RUNS_ROOT,
	admitCase,
	createBudgetLedger,
	expandCases,
	markUncertainEffect,
	planCaseReservation,
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
});
