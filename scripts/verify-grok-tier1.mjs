// Grok tier-1 acceptance validator (GT1-12-03). Validates Plans/grok-tier1/parity.json
// and its evidence against the scope phase 01 pinned (the GT1-01-07 coverage receipt and
// the parity matrix at its commit), then derives Plans/grok-tier1/readiness.json.
//
//   node scripts/verify-grok-tier1.mjs [--write] [--json] [--require-ready]
//
// tier1Ready is computed from the qualification rows and the global gates only; the
// delivery rows (P47 promotion, P48 handoff) and the GT1-12 tasks never feed it, so the
// promotion decision cannot depend on itself. Exit 1 = the inputs are malformed (the
// readiness is still derived, false); exit 3 = --require-ready and not ready.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const words = (text) => text.trim().split(/\s+/);
export const PLAN_DIR = 'Plans/grok-tier1';
export const LANES = ['static', 'deterministic', 'live'];
export const EVIDENCE_STATUSES = ['pass', 'fail', 'not-run', 'unsupported'];
export const IMPLEMENTATION_STATUSES = ['pending', 'implemented'];
export const DELIVERY_ROWS = ['P47', 'P48'];
/** The contract's own floor: P01-P48 exist whatever any input says. */
export const REFERENCE_IDS = Array.from({ length: 48 }, (_, i) => `P${i < 9 ? 0 : ''}${i + 1}`);
/** The six advertised platform candidates (GT1-01-05/07), win32-arm64 included. */
export const PLATFORM_CANDIDATES =
	'darwin-arm64 darwin-x64 linux-arm64 linux-x64 win32-x64 win32-arm64'.split(' ');
/** Historical route aliases and the explicit target each must keep. */
export const ROUTE_TARGETS = {
	'native-headless': { transport: 'native-headless', target: 'local' },
	'acp-candidate': { transport: 'acp-stdio', target: 'local' },
	'ssh-native-headless': { transport: 'native-headless', target: 'ssh' },
	'ssh-acp-candidate': { transport: 'acp-stdio', target: 'ssh' },
	'offline-audit': { transport: null, target: 'source-portable' },
};
/** Repository checks GT1-12-05 records in evidence/12-checks.json; a baseline failure waives none. */
export const REQUIRED_CHECKS = words(`lint lint-eslint docs-verify unit
	build-main build-renderer build-web-desktop build-cli build-maestro-lib`);
/** Baseline check ids and the final check that covers them. */
const BASELINE_CHECK_COVER = { 'grok-suites': 'unit' };
for (const id of words('tsc-lint tsc-main tsc-cli')) BASELINE_CHECK_COVER[id] = 'lint';
/** The three independent phase-11 checks (static, deterministic integration, audit of native qualification). */
export const AUDIT_SECTIONS = ['phase11StaticVerify', 'phase11IntegrationVerify', 'phase11Audit'];
const SETTLED_FINDINGS = new Set(
	words(`resolved resolved-in-audit reconciled-in-audit
	corrected-in-audit repaired rejected`)
);
/** Paths whose content is product behavior; evidence older than a change here is stale. */
export const BEHAVIORAL_PATHS = words(`src package.json package-lock.json
	scripts/grok-qualification scripts/grok-qualification.mjs`);
const BEHAVIORAL_EXCLUDE = /^src\/__tests__\//;
const SELF_TASK = /^GT1-12-/;
const OWNER_SCOPE_CODE = 'owner-task-scope-pending';

const uniq = (xs) => [...new Set(xs)].sort();

/** The required row set: the contract floor, the coverage receipt and the baseline, never shrunk by the current matrix. */
export function requiredScope({ parity, baselineParity, taskCoverage }) {
	const ids = new Set(REFERENCE_IDS);
	for (const inv of [baselineParity?.scopeInventory, parity?.scopeInventory]) {
		if (!inv) continue;
		for (const id of inv.referenceIds ?? []) ids.add(id);
		for (const f of inv.capabilityFields ?? []) ids.add(`C-${f}`);
		for (const id of [...(inv.registryRows ?? []), ...(inv.applicationSurfaceRows ?? [])])
			ids.add(id);
	}
	for (const row of baselineParity?.rows ?? []) if (row.required) ids.add(row.id);
	for (const row of parity?.rows ?? []) if (row.required) ids.add(row.id);
	for (const task of Object.values(taskCoverage?.taskCatalog ?? {}))
		for (const id of task.requiredRows ?? []) ids.add(id);
	for (const task of taskCoverage?.addedTasks ?? []) for (const id of task.rows ?? []) ids.add(id);
	return ids;
}

/** Evidence catalog entry behind a passing claim, or the reason it cannot carry one. */
function passEvidenceProblem(entry, { lane, row, ctx }) {
	if (!entry) return 'evidence-missing';
	if (entry.acceptanceRun !== true) return 'not-an-acceptance-run';
	for (const f of ['sourceCommit', 'command', 'environment', 'assertion'])
		if (!entry[f]) return `evidence-${f}-missing`;
	if (entry.exitCode !== 0) return 'evidence-exit-nonzero';
	if (!entry.fixtureSha256 && !entry.binarySha256) return 'evidence-hash-missing';
	if (/unknown/i.test(String(entry.provenance ?? 'unknown'))) return 'evidence-provenance-unknown';
	if (!ctx.isCurrent(entry.sourceCommit)) return 'evidence-stale-source';
	if (row.id.startsWith('C-') && entry.registry !== 'production')
		return 'candidate-only-capability-evidence';
	if (lane === 'live') {
		if (entry.provenance !== 'native') return 'live-evidence-not-native';
		if (!entry.binarySha256 || entry.binarySha256 !== ctx.versionBinarySha256)
			return 'live-binary-unqualified';
	}
	return null;
}

/** Per-row verdict: the reason codes that keep it from counting as complete. */
export function evaluateRow(row, ctx) {
	const reasons = [];
	const evidence = row.currentEvidence ?? {};
	const catalog = ctx.parity.evidenceCatalog ?? {};
	if (row.implementation !== 'implemented') reasons.push(`implementation:${row.implementation}`);
	else {
		// An implementation claim names the current source it was reviewed at, not an acceptance run.
		const entry = catalog[evidence.implementationEvidenceRef];
		if (!entry) reasons.push('implementation:evidence-missing');
		else if (!ctx.isCurrent(entry.sourceCommit))
			reasons.push('implementation:evidence-stale-source');
	}
	for (const lane of LANES) {
		const applicability = row.evidenceApplicability?.[lane];
		if (!applicability || typeof applicability.applicable !== 'boolean' || !applicability.reason) {
			reasons.push(`${lane}:applicability-undeclared`);
			continue;
		}
		if (!applicability.applicable) {
			if (row[lane] === 'pass') reasons.push(`${lane}:pass-on-non-applicable-lane`);
			continue;
		}
		if (row[lane] !== 'pass') {
			reasons.push(`${lane}:${row[lane]}`);
			continue;
		}
		const p = passEvidenceProblem(catalog[evidence[`${lane}EvidenceRef`]], { lane, row, ctx });
		if (p) reasons.push(`${lane}:${p}`);
	}
	// A live row needs every declared platform and route tuple qualified, not one of them.
	if (row.evidenceApplicability?.live?.applicable) {
		const { platformProfiles: pp = {}, canonicalRouteBindings: rb = {} } = ctx.parity;
		for (const p of row.platforms ?? [])
			if (p !== 'source-portable' && pp[p]?.qualification !== 'pass')
				reasons.push(`platform:${p}:unqualified`);
		for (const r of row.routes ?? [])
			if (r !== 'offline-audit' && rb[r]?.qualification !== 'pass')
				reasons.push(`route:${r}:unqualified`);
	}
	for (const blocker of row.blockers ?? []) {
		if (blocker.status === 'resolved') {
			const e = catalog[blocker.resolvedByEvidenceRef];
			if (!e || e.acceptanceRun !== true || !ctx.isCurrent(e.sourceCommit))
				reasons.push(`blocker:${blocker.id}:resolution-unproven`);
		} else reasons.push(`blocker:${blocker.id}`);
	}
	// Owner tasks must be checked; finalAcceptance and GT1-12 tasks never gate their own decision.
	const { finalAcceptance: _final, ...owners } = row.ownerTasks ?? {};
	for (const task of uniq(Object.values(owners).flat())) {
		if (SELF_TASK.test(task) || !ctx.taskStates) continue;
		const state = ctx.taskStates.get(task);
		if (state === undefined) reasons.push(`task:${task}:missing`);
		else if (!state) reasons.push(`task:${task}:unchecked`);
	}
	return uniq(reasons);
}

/** Structural validation of the matrix against the pinned scope; every finding is an error. */
export function validateStructure(inputs, scope) {
	const { parity, baselineParity, taskCoverage } = inputs;
	const errors = [];
	const rows = Array.isArray(parity?.rows) ? parity.rows : [];
	if (rows.length === 0) errors.push('matrix:empty');
	const byId = new Map();
	for (const row of rows) {
		if (!row?.id) {
			errors.push('row:id-missing');
			continue;
		}
		if (byId.has(row.id)) errors.push(`row:${row.id}:duplicate`);
		byId.set(row.id, row);
		if (!IMPLEMENTATION_STATUSES.includes(row.implementation))
			errors.push(`row:${row.id}:implementation-status-unknown:${row.implementation}`);
		for (const lane of LANES)
			if (!EVIDENCE_STATUSES.includes(row[lane]))
				errors.push(`row:${row.id}:${lane}-status-unknown:${row[lane]}`);
		if (!['qualification', 'delivery'].includes(row.kind))
			errors.push(`row:${row.id}:kind-unknown:${row.kind}`);
	}
	const minimum = taskCoverage?.counts?.requiredRows ?? 0;
	if (scope.size < minimum) errors.push(`scope:smaller-than-receipt:${scope.size}<${minimum}`);
	for (const id of [...scope].sort()) {
		const row = byId.get(id);
		if (!row) {
			errors.push(`scope:missing-row:${id}`);
			continue;
		}
		if (row.required !== true) errors.push(`scope:required-altered:${id}`);
		const kind = DELIVERY_ROWS.includes(id) ? 'delivery' : 'qualification';
		if (row.kind !== kind) errors.push(`scope:kind-altered:${id}:${row.kind}`);
	}
	for (const row of rows)
		if (row.kind === 'delivery' && !DELIVERY_ROWS.includes(row.id))
			errors.push(`scope:product-row-as-delivery:${row.id}`);
	// Nothing the baseline carried may be erased: surfaces, routes, platforms, live applicability, blockers.
	for (const base of baselineParity?.rows ?? []) {
		const row = byId.get(base.id);
		if (!row) continue;
		for (const field of ['surfaces', 'routes', 'platforms']) {
			for (const v of base[field] ?? [])
				if (!(row[field] ?? []).includes(v)) errors.push(`scope:${field}-dropped:${base.id}:${v}`);
		}
		// Narrowing applicability needs a recorded independent review; live is never waived by mocks.
		for (const lane of LANES) {
			const now = row.evidenceApplicability?.[lane];
			const reviewed = now?.review?.independent === true && Boolean(now.review.task);
			if (
				base.evidenceApplicability?.[lane]?.applicable === true &&
				now?.applicable !== true &&
				!reviewed
			)
				errors.push(`scope:applicability-narrowed:${base.id}:${lane}`);
		}
		// A GT1-01-07 owner resolution clears only the scope blocker it names; never a product blocker.
		const ownerResolved = (b) =>
			b.code === OWNER_SCOPE_CODE && (taskCoverage?.resolvedOwnerScopes ?? []).includes(base.id);
		for (const b of base.blockers ?? [])
			if (!(row.blockers ?? []).some((c) => c.id === b.id) && !ownerResolved(b))
				errors.push(`scope:blocker-dropped:${base.id}:${b.id}`);
	}
	// Coverage receipt: every task keeps the rows it owns.
	const ownersOf = (id) => Object.values(byId.get(id)?.ownerTasks ?? {}).flat();
	for (const [task, entry] of Object.entries(taskCoverage?.taskCatalog ?? {}))
		for (const id of entry.requiredRows ?? [])
			if (byId.has(id) && !ownersOf(id).includes(task))
				errors.push(`coverage:owner-dropped:${id}:${task}`);
	// Platforms: all six candidates, every row either portable-only or expanded to all six.
	for (const p of PLATFORM_CANDIDATES)
		if (parity?.platformProfiles?.[p]?.requiredCandidate !== true)
			errors.push(`platform:${p}:candidate-missing`);
	for (const row of rows) {
		const platforms = row.platforms ?? [];
		const portableOnly = platforms.length === 1 && platforms[0] === 'source-portable';
		if (!portableOnly)
			for (const p of PLATFORM_CANDIDATES)
				if (!platforms.includes(p)) errors.push(`platform:${row.id}:${p}-missing`);
		if (portableOnly && row.evidenceApplicability?.live?.applicable)
			errors.push(`platform:${row.id}:live-row-without-platforms`);
	}
	// Routes: explicit local/SSH targets kept, every row route bound.
	for (const [alias, want] of Object.entries(ROUTE_TARGETS)) {
		const got = parity?.canonicalRouteBindings?.[alias];
		if (!got || got.transport !== want.transport || got.target !== want.target)
			errors.push(`route:${alias}:binding-altered`);
	}
	for (const row of rows)
		for (const r of row.routes ?? [])
			if (!parity?.canonicalRouteBindings?.[r]) errors.push(`route:${row.id}:${r}-unbound`);
	// Links.
	const catalog = parity?.evidenceCatalog ?? {};
	const sources = parity?.sourceCatalog ?? {};
	const exists = inputs.fileExists ?? (() => true);
	for (const [key, entry] of Object.entries(catalog))
		if (!entry?.path || !exists(entry.path.split('#')[0])) errors.push(`link:evidence:${key}`);
	for (const row of rows) {
		for (const c of Object.values(row.comparators ?? {}))
			for (const ref of c.evidenceRefs ?? [])
				if (!sources[ref]) errors.push(`link:source:${row.id}:${ref}`);
		for (const [k, v] of Object.entries(row.currentEvidence ?? {})) {
			if (k === 'sourceRevisionRef') continue;
			if (/Ref$/.test(k) && !catalog[v]) errors.push(`link:row:${row.id}:${k}`);
			if (/Path$/.test(k) && !exists(String(v).split('#')[0]))
				errors.push(`link:row:${row.id}:${k}`);
		}
		for (const b of row.blockers ?? []) {
			if (b.evidenceRef && !catalog[b.evidenceRef] && !exists(b.evidenceRef.split('#')[0]))
				errors.push(`link:blocker:${row.id}:${b.id}`);
			for (const a of b.affectedRows ?? [])
				if (!byId.has(a)) errors.push(`link:blocker-row:${row.id}:${b.id}:${a}`);
		}
		for (const s of row.supportingRows ?? [])
			if (!byId.has(s)) errors.push(`link:supporting-row:${row.id}:${s}`);
	}
	return uniq(errors);
}

/** Global gates outside the rows: version, live boundary, audits, regression checks. */
export function globalBlockers(inputs, ctx) {
	const { parity, baselineChecks, finalChecks } = inputs;
	const out = [];
	const profile = parity?.versionProfiles?.['official-grok-candidate'];
	if (!profile) out.push('version:profile-missing');
	else {
		if (!profile.supportedRange) out.push('version:supported-range-unknown');
		if (!profile.binarySha256) out.push('version:binary-unqualified');
		if (!profile.binarySourceRelationship || profile.binarySourceRelationship === 'unknown')
			out.push('version:binary-source-unknown');
		const q = profile.qualification;
		if (!q || q.status !== 'pass') out.push('version:qualification-absent');
		else if (!q.expiresAt || Date.parse(q.expiresAt) <= ctx.now)
			out.push('version:qualification-expired');
		else if (!ctx.isCurrent(q.sourceCommit)) out.push('version:qualification-stale-source');
	}
	if (parity?.liveBoundary?.enabled !== true) out.push('live:authorization-absent');
	for (const section of AUDIT_SECTIONS) {
		const audit = parity?.[section];
		if (!audit) {
			out.push(`audit:${section}:missing`);
			continue;
		}
		if (!ctx.isCurrent(audit.sourceCommit)) out.push(`audit:${section}:stale-source`);
		if (audit.readiness === false) out.push(`audit:${section}:not-ready`);
		for (const f of audit.findings ?? [])
			if (!SETTLED_FINDINGS.has(f.status))
				out.push(`audit:${section}:finding:${f.id ?? 'unnamed'}`);
	}
	for (const id of parity?.phase11Audit?.externalBlockersUnchanged ?? [])
		out.push(`external:${id}`);
	if (!finalChecks) out.push('regression:checks-missing');
	else {
		if (!ctx.isCurrent(finalChecks.sourceCommit)) out.push('regression:checks-stale-source');
		const byId = new Map((finalChecks.checks ?? []).map((c) => [c.id, c]));
		for (const id of REQUIRED_CHECKS) {
			const c = byId.get(id);
			if (!c) out.push(`regression:${id}:missing`);
			else if (c.status !== 'pass' || c.exitCode !== 0)
				out.push(`regression:${id}:${c.status ?? 'unknown'}`);
		}
	}
	for (const c of baselineChecks?.checks ?? []) {
		if (c.status === 'pass') continue;
		const covering =
			finalChecks?.checks?.find((f) => f.id === c.id) ??
			finalChecks?.checks?.find((f) => f.id === BASELINE_CHECK_COVER[c.id]);
		if (!covering || covering.status !== 'pass' || covering.exitCode !== 0)
			out.push(`regression:baseline-failure-unwaived:${c.id}`);
	}
	return uniq(out);
}

/** The whole derivation; pure over its inputs so a fixture ledger can drive it. */
export function deriveReadiness(inputs) {
	const scope = requiredScope(inputs);
	const errors = validateStructure(inputs, scope);
	const fp = inputs.fingerprints ?? { current: null, byCommit: {} };
	const ctx = {
		parity: inputs.parity ?? {},
		now: inputs.now ?? Date.now(),
		taskStates: inputs.taskStates ?? null,
		versionBinarySha256:
			inputs.parity?.versionProfiles?.['official-grok-candidate']?.binarySha256 ?? null,
		isCurrent: (commit) => Boolean(commit && fp.current && fp.byCommit?.[commit] === fp.current),
	};
	if (!ctx.taskStates) errors.push('playbook:task-states-unreadable');
	const rows = Array.isArray(inputs.parity?.rows) ? inputs.parity.rows : [];
	const rowReasons = {};
	for (const row of rows)
		if (row?.id && (row.required || scope.has(row.id))) rowReasons[row.id] = evaluateRow(row, ctx);
	const required = rows.filter((r) => r?.id && scope.has(r.id));
	const qualification = required.filter((r) => !DELIVERY_ROWS.includes(r.id));
	const delivery = required.filter((r) => DELIVERY_ROWS.includes(r.id));
	const incomplete = (set) => set.filter((r) => rowReasons[r.id].length > 0).map((r) => r.id);
	const laneOk = (r, l) => !rowReasons[r.id].some((x) => x.startsWith(`${l}:`));
	const laneDone = (set, lanes) =>
		set.length > 0 && set.every((r) => lanes.every((l) => laneOk(r, l)));
	const globals = globalBlockers(inputs, ctx);
	const tier1Ready =
		errors.length === 0 &&
		globals.length === 0 &&
		qualification.length > 0 &&
		incomplete(qualification).length === 0;
	const rowBlockerIds = required.flatMap((r) =>
		(r.blockers ?? []).filter((b) => b.status !== 'resolved').map((b) => b.id)
	);
	const incompleteEntries = Object.entries(rowReasons).filter(([, r]) => r.length > 0);
	incompleteEntries.sort(([a], [b]) => a.localeCompare(b));
	return {
		schemaVersion: 1,
		generator: 'scripts/verify-grok-tier1.mjs',
		sourceCommit: inputs.sourceCommit ?? null,
		behavioralFingerprint: fp.current ?? null,
		inputsSha256: inputs.inputsSha256 ?? {},
		tier1Ready,
		deliveryComplete:
			tier1Ready && delivery.length === DELIVERY_ROWS.length && incomplete(delivery).length === 0,
		implementationComplete: laneDone(required, ['implementation']),
		testComplete: laneDone(qualification, ['static', 'deterministic']),
		liveComplete: laneDone(qualification, ['live']),
		outcome: tier1Ready ? 'tier1-qualified' : 'pending-qualification',
		counts: {
			rows: rows.length,
			requiredScope: scope.size,
			qualificationRows: qualification.length,
			deliveryRows: delivery.length,
			incompleteQualificationRows: incomplete(qualification).length,
			incompleteDeliveryRows: incomplete(delivery).length,
		},
		errors,
		globalBlockers: globals,
		blockerIds: uniq([...globals, ...errors, ...rowBlockerIds]),
		incompleteRows: Object.fromEntries(incompleteEntries),
		commands: {
			validate: 'node scripts/verify-grok-tier1.mjs --json',
			write: 'node scripts/verify-grok-tier1.mjs --write',
			liveHarness: 'node scripts/grok-qualification.mjs --json --no-write',
		},
		policy:
			'tier1Ready excludes the delivery rows P47/P48 and GT1-12 tasks; deliveryComplete requires tier1Ready. not-run, unsupported, stale, mock-only or candidate-only evidence never passes a required row.',
	};
}

// ---------- disk and git ----------

function git(root, args) {
	const opts = { encoding: 'utf8', maxBuffer: 1 << 28 };
	const r = spawnSync('/usr/bin/git', ['-C', root, ...args], opts);
	return r.status === 0 ? r.stdout : null;
}

/** sha256 over the behavioral tree listing at a commit (tests excluded); null when unreadable. */
export function behavioralFingerprint(root, commit) {
	const listing = git(root, ['ls-tree', '-r', commit, '--', ...BEHAVIORAL_PATHS]);
	if (listing === null) return null;
	const keep = (l) => l && !BEHAVIORAL_EXCLUDE.test(l.split('\t')[1] ?? '');
	return sha256(listing.split('\n').filter(keep).join('\n'));
}

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
/** Every input of the derivation; GT1-12-05 writes evidence/12-checks.json. */
const INPUT_FILES = {
	parity: 'parity.json',
	runState: 'run-state.json',
	taskCoverage: 'evidence/01-task-coverage.json',
	baselineChecks: 'evidence/01-baseline-checks.json',
	finalChecks: 'evidence/12-checks.json',
};

function readJson(file) {
	return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}

const TASK_LINE = /^- \[( |x|X)\] (GT1-[0-9A-Za-z-]+)/gm;
function readTaskStates(folder) {
	if (!folder || !existsSync(folder)) return null;
	const states = new Map();
	for (const f of readdirSync(folder).filter((n) => /^GROK-TIER1-\d+\.md$/.test(n))) {
		const text = readFileSync(path.join(folder, f), 'utf8');
		for (const m of text.matchAll(TASK_LINE)) states.set(m[2], m[1] !== ' ');
	}
	return states;
}

/** Collects every input from the checkout; nothing is read from a previous readiness.json. */
export function loadInputs(root = REPO_ROOT) {
	const plan = path.join(root, PLAN_DIR);
	const inputs = { inputsSha256: {} };
	for (const [k, f] of Object.entries(INPUT_FILES)) {
		const full = path.join(plan, f);
		inputs[k] = readJson(full);
		if (inputs[k]) inputs.inputsSha256[`${PLAN_DIR}/${f}`] = sha256(readFileSync(full));
	}
	const baseCommit = inputs.taskCoverage?.sourceCommit;
	const baseText = baseCommit ? git(root, ['show', `${baseCommit}:${PLAN_DIR}/parity.json`]) : null;
	inputs.baselineParity = baseText ? JSON.parse(baseText) : null;
	inputs.sourceCommit = (git(root, ['rev-parse', 'HEAD']) ?? '').trim() || null;
	const status = ['status', '--porcelain', '--untracked-files=no', '--'];
	const dirty = git(root, [...status, ...BEHAVIORAL_PATHS]);
	const dirtyBehavior =
		dirty === null || dirty.split('\n').some((l) => l && !BEHAVIORAL_EXCLUDE.test(l.slice(3)));
	const current =
		inputs.sourceCommit && !dirtyBehavior ? behavioralFingerprint(root, inputs.sourceCommit) : null;
	const commits = new Set();
	const p = inputs.parity ?? {};
	for (const e of Object.values(p.evidenceCatalog ?? {}))
		if (e?.sourceCommit) commits.add(e.sourceCommit);
	for (const s of AUDIT_SECTIONS) if (p[s]?.sourceCommit) commits.add(p[s].sourceCommit);
	const q = p.versionProfiles?.['official-grok-candidate']?.qualification;
	if (q?.sourceCommit) commits.add(q.sourceCommit);
	if (inputs.finalChecks?.sourceCommit) commits.add(inputs.finalChecks.sourceCommit);
	const byCommit = {};
	for (const c of commits) byCommit[c] = behavioralFingerprint(root, c);
	inputs.fingerprints = { current, byCommit };
	inputs.taskStates = readTaskStates(inputs.runState?.canonicalPlaybookFolder);
	inputs.fileExists = (rel) => existsSync(path.join(root, rel));
	return inputs;
}

export async function main(argv = process.argv.slice(2), root = REPO_ROOT) {
	const readiness = deriveReadiness(loadInputs(root));
	const target = path.join(root, PLAN_DIR, 'readiness.json');
	let text = `${JSON.stringify(readiness, null, '\t')}\n`;
	// Written in the checkout's own Prettier style, so a rerun on unchanged inputs is byte-identical.
	const prettier = await import('prettier').catch(() => null);
	const config = prettier ? await prettier.resolveConfig(target) : null;
	if (prettier) text = await prettier.format(text, { ...config, filepath: target });
	if (argv.includes('--write')) writeFileSync(target, text);
	if (argv.includes('--json')) process.stdout.write(text);
	else {
		const { tier1Ready, deliveryComplete, outcome, counts, errors, globalBlockers: g } = readiness;
		const lines = [`grok tier-1: tier1Ready=${tier1Ready} deliveryComplete=${deliveryComplete}`];
		lines.push(`outcome ${outcome}, counts ${JSON.stringify(counts)}`);
		lines.push(`errors ${errors.length}, global blockers ${g.length}`);
		console.log([...lines, ...errors.slice(0, 20).map((e) => `  error ${e}`)].join('\n'));
	}
	if (readiness.errors.length > 0) return 1;
	if (argv.includes('--require-ready') && !readiness.tier1Ready) return 3;
	return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	process.exitCode = await main();
}
