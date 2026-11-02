/**
 * scripts/verify-grok-tier1.mjs derives Plans/grok-tier1/readiness.json. These tests
 * drive its pure derivation over a SYNTHETIC ledger: a unit fixture that reads
 * complete so each mutation can be shown to take tier1Ready away. It is never
 * release evidence and says nothing about the real Grok integration.
 */
import { describe, expect, it } from 'vitest';
import {
	DELIVERY_ROWS,
	PLATFORM_CANDIDATES,
	REFERENCE_IDS,
	REQUIRED_CHECKS,
	ROUTE_TARGETS,
	deriveReadiness,
	requiredScope,
} from '../../../scripts/verify-grok-tier1.mjs';

const COMMIT = 'c'.repeat(40);
const IDS = [...REFERENCE_IDS, 'C-supportsResume', 'S01'];
const NOW = Date.parse('2026-11-02T00:00:00Z');

function evidence(extra: Record<string, unknown> = {}) {
	return {
		path: 'Plans/grok-tier1/evidence/fixture.md',
		sourceCommit: COMMIT,
		provenance: 'native',
		acceptanceRun: true,
		command: 'node fixture',
		exitCode: 0,
		environment: 'fixture',
		assertion: 'fixture',
		binarySha256: 'b'.repeat(64),
		registry: 'production',
		...extra,
	};
}

function row(id: string, deliveryDone: boolean) {
	const product = !DELIVERY_ROWS.includes(id);
	const done = product || deliveryDone;
	return {
		id,
		required: true,
		kind: product ? 'qualification' : 'delivery',
		surfaces: ['fixture-surface'],
		routes: product ? ['native-headless', 'ssh-acp-candidate'] : ['offline-audit'],
		platforms: product ? [...PLATFORM_CANDIDATES] : ['source-portable'],
		ownerTasks: { implementation: ['GT1-02-01'], finalAcceptance: ['GT1-12-06'] },
		implementation: done ? 'implemented' : 'pending',
		static: done ? 'pass' : 'not-run',
		deterministic: done ? 'pass' : 'not-run',
		live: product ? 'pass' : 'not-run',
		currentEvidence: {
			implementationEvidenceRef: 'E',
			staticEvidenceRef: 'E',
			deterministicEvidenceRef: 'E',
			liveEvidenceRef: 'E',
		},
		evidenceApplicability: {
			static: { applicable: true, reason: 'fixture' },
			deterministic: { applicable: true, reason: 'fixture' },
			live: { applicable: product, reason: 'fixture' },
		},
		blockers: [] as Array<Record<string, unknown>>,
	};
}

/** A synthetic ledger that reads complete; `deliveryDone: false` leaves P47/P48 pending. */
function ledger({ deliveryDone = true } = {}) {
	const parity = {
		scopeInventory: {
			referenceIds: REFERENCE_IDS,
			capabilityFields: ['supportsResume'],
			registryRows: [],
			applicationSurfaceRows: ['S01'],
		},
		rows: IDS.map((id) => row(id, deliveryDone)),
		evidenceCatalog: { E: evidence() } as Record<string, ReturnType<typeof evidence>>,
		sourceCatalog: {},
		platformProfiles: Object.fromEntries(
			PLATFORM_CANDIDATES.map((p: string) => [
				p,
				{ requiredCandidate: true, qualification: 'pass' },
			])
		) as Record<string, { requiredCandidate: boolean; qualification: string }>,
		canonicalRouteBindings: Object.fromEntries(
			Object.entries(ROUTE_TARGETS).map(([k, v]) => [
				k,
				{ ...(v as object), qualification: 'pass' },
			])
		) as Record<string, { transport: string | null; target: string; qualification: string }>,
		versionProfiles: {
			'official-grok-candidate': {
				supportedRange: '1.0.70',
				binarySha256: 'b'.repeat(64),
				binarySourceRelationship: 'built-from',
				qualification: { status: 'pass', expiresAt: '2999-01-01', sourceCommit: COMMIT },
			},
		},
		liveBoundary: { enabled: true },
		phase11StaticVerify: { sourceCommit: COMMIT, findings: [] as unknown[] },
		phase11IntegrationVerify: { sourceCommit: COMMIT, findings: [] as unknown[] },
		phase11Audit: { sourceCommit: COMMIT, findings: [] as unknown[], readiness: true },
	};
	return {
		parity,
		baselineParity: structuredClone(parity) as typeof parity | null,
		taskCoverage: {
			counts: { requiredRows: IDS.length },
			taskCatalog: { 'GT1-02-01': { requiredRows: ['P01'] } },
			resolvedOwnerScopes: [] as string[],
		},
		baselineChecks: { checks: [{ id: 'tsc-lint', status: 'fail' }] },
		finalChecks: {
			sourceCommit: COMMIT,
			checks: REQUIRED_CHECKS.map((id: string) => ({ id, status: 'pass', exitCode: 0 })),
		},
		taskStates: new Map([['GT1-02-01', true]]) as Map<string, boolean> | null,
		fingerprints: { current: 'F', byCommit: { [COMMIT]: 'F' } },
		fileExists: (_rel: string) => true,
		now: NOW,
	};
}

type Ledger = ReturnType<typeof ledger>;
const rowOf = (l: Ledger, id: string) => l.parity.rows.find((r) => r.id === id)!;

/** Every reason the derivation gives, flattened, so a test can name the one it expects. */
function reasons(r: ReturnType<typeof deriveReadiness>): string[] {
	const perRow = Object.entries(r.incompleteRows as Record<string, string[]>).flatMap(([id, xs]) =>
		xs.map((x) => `${id}|${x}`)
	);
	return [...r.errors, ...r.globalBlockers, ...perRow];
}

describe('verify-grok-tier1 derivation (synthetic unit fixture, not release evidence)', () => {
	it('reads a complete synthetic ledger as tier-1 ready and delivered', () => {
		const r = deriveReadiness(ledger());
		expect(reasons(r)).toEqual([]);
		expect(r.tier1Ready).toBe(true);
		expect(r.deliveryComplete).toBe(true);
		expect(r.outcome).toBe('tier1-qualified');
		expect(r.counts.requiredScope).toBe(IDS.length);
	});

	it('lets pending P47/P48 qualify while leaving delivery incomplete', () => {
		const r = deriveReadiness(ledger({ deliveryDone: false }));
		expect(r.tier1Ready).toBe(true);
		expect(r.deliveryComplete).toBe(false);
		expect(Object.keys(r.incompleteRows)).toEqual(['P47', 'P48']);
	});

	it('does not extend the P47/P48 exception to a product gap', () => {
		const l = ledger({ deliveryDone: false });
		const p05 = rowOf(l, 'P05');
		p05.implementation = 'pending';
		p05.static = 'not-run';
		const r = deriveReadiness(l);
		expect(r.tier1Ready).toBe(false);
		expect(r.deliveryComplete).toBe(false);
		expect(r.outcome).toBe('pending-qualification');
		expect(reasons(r)).toContain('P05|implementation:pending');
	});

	// Each mutation names one incomplete or altered input; tier1Ready must be false and
	// the expected reason present, so a pass by an unrelated reason cannot hide a gap.
	const mutations: Array<[string, (l: Ledger) => void, string]> = [
		[
			'empty inputs',
			(l) => {
				l.parity.rows = [];
				l.baselineParity = null;
				(l.parity as { scopeInventory: unknown }).scopeInventory = null;
			},
			'matrix:empty',
		],
		['missing product row', (l) => l.parity.rows.splice(3, 1), 'scope:missing-row:P04'],
		[
			'missing surface row',
			(l) => (l.parity.rows = l.parity.rows.filter((r) => r.id !== 'S01')),
			'scope:missing-row:S01',
		],
		[
			'row without an id',
			(l) => ((l.parity.rows[0] as { id: string | undefined }).id = undefined),
			'row:id-missing',
		],
		[
			'duplicate id',
			(l) => l.parity.rows.push(structuredClone(l.parity.rows[0])),
			'row:P01:duplicate',
		],
		[
			'unknown lane status',
			(l) => (l.parity.rows[0].live = 'passed'),
			'row:P01:live-status-unknown:passed',
		],
		[
			'unknown implementation status',
			(l) => (l.parity.rows[0].implementation = 'done'),
			'row:P01:implementation-status-unknown:done',
		],
		['required altered', (l) => (rowOf(l, 'P06').required = false), 'scope:required-altered:P06'],
		['kind altered', (l) => (rowOf(l, 'P06').kind = 'delivery'), 'scope:kind-altered:P06:delivery'],
		['broken evidence link', (l) => (l.fileExists = () => false), 'link:evidence:E'],
		[
			'dangling evidence ref',
			(l) => (l.parity.rows[0].currentEvidence.liveEvidenceRef = 'NOPE'),
			'link:row:P01:liveEvidenceRef',
		],
		['live not run', (l) => (l.parity.rows[0].live = 'not-run'), 'P01|live:not-run'],
		[
			'mock-only live evidence',
			(l) => (l.parity.evidenceCatalog.E.provenance = 'mock'),
			'P01|live:live-evidence-not-native',
		],
		[
			'live evidence from an unqualified binary',
			(l) => (l.parity.evidenceCatalog.E.binarySha256 = 'd'.repeat(64)),
			'P01|live:live-binary-unqualified',
		],
		[
			'unverified native data (not an acceptance run)',
			(l) => (l.parity.evidenceCatalog.E.acceptanceRun = false),
			'P01|static:not-an-acceptance-run',
		],
		[
			'candidate-only capability evidence',
			(l) => {
				l.parity.evidenceCatalog.K = evidence({ registry: 'candidate' });
				rowOf(l, 'C-supportsResume').currentEvidence.staticEvidenceRef = 'K';
			},
			'C-supportsResume|static:candidate-only-capability-evidence',
		],
		[
			'stale behavioral source',
			(l) => (l.fingerprints.current = 'G'),
			'P01|static:evidence-stale-source',
		],
		[
			'expired version qualification',
			(l) =>
				(l.parity.versionProfiles['official-grok-candidate'].qualification.expiresAt =
					'2026-01-01'),
			'version:qualification-expired',
		],
		[
			'baseline failure still failing',
			(l) => (l.finalChecks.checks[0].status = 'fail'),
			'regression:baseline-failure-unwaived:tsc-lint',
		],
		[
			'required check missing',
			(l) => (l.finalChecks.checks = l.finalChecks.checks.filter((c) => c.id !== 'build-cli')),
			'regression:build-cli:missing',
		],
		[
			'unsettled audit finding',
			(l) => l.parity.phase11Audit.findings.push({ id: 'A11-F99', status: 'open' }),
			'audit:phase11Audit:finding:A11-F99',
		],
		[
			'live authorization absent',
			(l) => (l.parity.liveBoundary.enabled = false),
			'live:authorization-absent',
		],
		[
			'unchecked owner task',
			(l) => l.taskStates!.set('GT1-02-01', false),
			'P01|task:GT1-02-01:unchecked',
		],
		['task states unreadable', (l) => (l.taskStates = null), 'playbook:task-states-unreadable'],
		// GT1-01-07 scope reconciliation.
		[
			'win32-arm64 tuple missing from a row',
			(l) => l.parity.rows[0].platforms.pop(),
			'platform:P01:win32-arm64-missing',
		],
		[
			'win32-arm64 candidate profile missing',
			(l) => delete l.parity.platformProfiles['win32-arm64'],
			'platform:win32-arm64:candidate-missing',
		],
		[
			'win32-arm64 unqualified',
			(l) => (l.parity.platformProfiles['win32-arm64'].qualification = 'not-run'),
			'P01|platform:win32-arm64:unqualified',
		],
		[
			'SSH target lost',
			(l) => (l.parity.canonicalRouteBindings['ssh-acp-candidate'].target = 'local'),
			'route:ssh-acp-candidate:binding-altered',
		],
		[
			'required task coverage removed',
			(l) => (l.parity.rows[0].ownerTasks.implementation = []),
			'coverage:owner-dropped:P01:GT1-02-01',
		],
		[
			'owner-scope resolution clearing a product blocker',
			(l) => {
				l.baselineParity!.rows[1].blockers = [
					{ id: 'gap:P02', code: 'implementation-or-evidence-pending' },
				];
				l.taskCoverage.resolvedOwnerScopes = ['P02'];
			},
			'scope:blocker-dropped:P02:gap:P02',
		],
		[
			'live applicability narrowed without review',
			(l) => (l.parity.rows[0].evidenceApplicability.live.applicable = false),
			'scope:applicability-narrowed:P01:live',
		],
		[
			'surface dropped since baseline',
			(l) => {
				l.baselineParity!.rows[0].surfaces.push('baseline-only-surface');
			},
			'scope:surfaces-dropped:P01:baseline-only-surface',
		],
	];

	it.each(mutations)('%s keeps tier1Ready false', (_name, mutate, expected) => {
		const l = ledger();
		mutate(l);
		const r = deriveReadiness(l);
		expect(r.tier1Ready).toBe(false);
		expect(r.deliveryComplete).toBe(false);
		expect(r.outcome).toBe('pending-qualification');
		expect(reasons(r)).toContain(expected);
	});

	it('clears only the owner-scope blocker an owner resolution names', () => {
		const l = ledger();
		l.baselineParity!.rows[1].blockers = [{ id: 'scope:P02', code: 'owner-task-scope-pending' }];
		l.taskCoverage.resolvedOwnerScopes = ['P02'];
		expect(deriveReadiness(l).tier1Ready).toBe(true);
	});

	it('never shrinks the required scope below the contract floor and the receipt', () => {
		const l = ledger();
		l.parity.rows = l.parity.rows.filter((r) => r.id === 'P01');
		l.baselineParity = null;
		(l.parity as { scopeInventory: unknown }).scopeInventory = null;
		const scope = requiredScope(l);
		for (const id of REFERENCE_IDS) expect(scope.has(id)).toBe(true);
		const r = deriveReadiness(l);
		expect(r.tier1Ready).toBe(false);
		expect(r.errors).toContain('scope:missing-row:P48');
	});
});
