import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
	assessPair,
	chooseEndpointSource,
	endpointMatchesPair,
	inspectArtifactDir,
	inspectLinuxHost,
	pairRunStatus,
	probeLinuxRuntime,
} from '../../../scripts/mega-maestro-pair.mjs';
import {
	ACCEPTANCE_CASES,
	ACCEPTANCE_ROWS,
	SYNTHETIC_PROVIDER_SOURCE,
	assessAcceptance,
	observeHarnessEffects,
	observeLedgerReceipt,
	pairCaseEvidence,
	presentAcceptanceInputs,
	type AcceptanceCaseEvidence,
} from '../integration/mega-maestro/journeys';

describe('pair runner inputs (declared Docker and artifact fixtures)', () => {
	let root: string;
	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-runner-'));
	});
	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});
	const contracts = 'c'.repeat(64);
	function artifact(name: string, changes = {}) {
		const dir = path.join(root, name);
		fs.mkdirSync(dir);
		const bytes = Buffer.from('declared fixture archive; never loaded');
		const digest = createHash('sha256').update(bytes).digest('hex');
		fs.writeFileSync(path.join(dir, 'application.tgz'), bytes);
		fs.writeFileSync(path.join(dir, 'application.tgz.sha256'), digest);
		fs.writeFileSync(
			path.join(dir, 'artifact.json'),
			JSON.stringify({
				formatVersion: 1,
				sourceDirty: false,
				sourceRevision: 'a'.repeat(40),
				platform: 'linux',
				arch: 'arm64',
				contracts: { sha256: contracts },
				sha256: digest,
				...changes,
			})
		);
		return inspectArtifactDir(dir);
	}
	function report(endpointSources: ReturnType<typeof artifact>[]) {
		return {
			library: { status: 'ready' },
			pin: { status: 'pinned', digest: contracts },
			endpointSources,
			linuxHost: {
				linux: true,
				image: { present: true, arch: 'arm64' },
				runtime: { status: 'supported' },
			},
			producers: Object.fromEntries(
				['CP-01', 'CP-02', 'CP-03', 'registration-approval'].map((id) => [
					id,
					{ fresh: true, detail: id },
				])
			),
			approvalProducer: true,
		};
	}
	it('chooses a matching contract cohort and image architecture deterministically', () => {
		const stale = artifact('0-stale', { contracts: { sha256: 'd'.repeat(64) } });
		const wrongArch = artifact('1-x64', { arch: 'x64' });
		const later = artifact('3-match');
		const selected = artifact('2-match');
		const input = report([stale, wrongArch, later, selected]);
		expect(chooseEndpointSource(input, {})).toEqual(selected);
		expect(
			chooseEndpointSource({ ...input, endpointSources: [...input.endpointSources].reverse() }, {})
		).toEqual(selected);
		expect(assessPair(input).ready).toBe(true);
	});
	it('honors an explicit invalid selection and refuses readiness instead of substituting', () => {
		const wrong = artifact('wrong', { contracts: { sha256: 'd'.repeat(64) } });
		const input = { ...report([wrong, artifact('good')]), requestedArtifact: wrong.dir };
		expect(chooseEndpointSource(input, { artifact: wrong.dir })).toEqual(wrong);
		expect(endpointMatchesPair(wrong, input)).toBe(false);
		expect(assessPair(input).ready).toBe(false);
	});
	it.each([
		['missing clean provenance', { sourceDirty: undefined }, 'malformed'],
		['manifest digest mismatch', { sha256: '0'.repeat(64) }, 'digest-mismatch'],
		['dirty source', { sourceDirty: true }, 'dirty'],
		['non Linux', { platform: 'darwin' }, 'wrong-platform'],
	] as const)('does not certify %s', (_name, changes, status) => {
		expect(artifact('case', changes)).toMatchObject({ status, certifiable: false });
	});
	it('reports malformed manifests and archive tampering without aborting discovery', () => {
		const item = artifact('broken');
		fs.writeFileSync(path.join(item.dir, 'application.tgz'), 'tampered');
		expect(inspectArtifactDir(item.dir)).toMatchObject({
			status: 'digest-mismatch',
			certifiable: false,
		});
		fs.writeFileSync(path.join(item.dir, 'artifact.json'), '{');
		expect(inspectArtifactDir(item.dir)).toMatchObject({ status: 'malformed', certifiable: false });
	});
	it('treats missing runtime features and stale producers as named dependencies', () => {
		const input = report([artifact('good')]);
		input.linuxHost.runtime.status = 'unsupported';
		input.producers['CP-01'].fresh = false;
		expect(assessPair(input).dependencies.map((d: { id: string }) => d.id)).toEqual([
			'CP-01',
			'linux-runtime',
		]);
	});
	it('probes the immutable selected image with permission flags and no network or pull', async () => {
		const run = vi
			.fn()
			.mockReturnValueOnce({
				status: 0,
				stdout: JSON.stringify({
					OSType: 'linux',
					SecurityOptions: ['name=seccomp,profile=builtin'],
				}),
			})
			.mockReturnValueOnce({ status: 0, stdout: 'sha256:fixture linux arm64 now' })
			.mockReturnValueOnce({
				status: 0,
				stdout: JSON.stringify({
					platform: 'linux',
					permission: true,
					node: 'fixture',
					support: { managed: 'implemented' },
				}),
			});
		const result = await inspectLinuxHost('fixture:tag', run);
		expect(result.runtime).toMatchObject({ status: 'supported', image: 'sha256:fixture' });
		expect(run.mock.calls[2][0]).toEqual(
			expect.arrayContaining([
				'--pull=never',
				'--network=none',
				'sha256:fixture',
				'--permission',
				'--disallow-code-generation-from-strings',
			])
		);
	});
	it.each([
		{ status: 1, stdout: '' },
		{ status: null, stdout: '', error: new Error('timeout') },
		{ status: 0, stdout: '{' },
		{
			status: 0,
			stdout: JSON.stringify({
				platform: 'linux',
				permission: false,
				support: { managed: 'implemented' },
			}),
		},
		{
			status: 0,
			stdout: JSON.stringify({
				platform: 'linux',
				permission: true,
				support: { managed: 'unsupported' },
			}),
		},
		{
			status: 1,
			stdout: JSON.stringify({
				platform: 'linux',
				permission: true,
				support: { managed: 'implemented' },
			}),
		},
	])('fails closed on incomplete or failed runtime observations: %j', async (response) => {
		expect((await probeLinuxRuntime('fixture-image', () => response)).status).not.toBe('supported');
	});
	it('does not launch a probe when the daemon or image is absent', async () => {
		const offline = vi.fn().mockReturnValue({ status: 1, stderr: 'unavailable' });
		expect((await inspectLinuxHost('missing', offline)).docker).toBe(false);
		expect(offline).toHaveBeenCalledTimes(1);
		const missing = vi
			.fn()
			.mockReturnValueOnce({
				status: 0,
				stdout: JSON.stringify({
					OSType: 'linux',
					SecurityOptions: ['name=seccomp,profile=builtin'],
				}),
			})
			.mockReturnValueOnce({ status: 1, stdout: '' });
		expect((await inspectLinuxHost('missing', missing)).runtime.status).toBe('unavailable');
		expect(missing).toHaveBeenCalledTimes(2);
	});
});

describe('pair runner completion evidence', () => {
	const complete = () => ({
		containerExit: 0,
		surfaces: 'all',
		expectedJourneys: ['library.handshake'],
		journeys: [{ id: 'library.handshake', surface: 'library', verdict: 'passed' }],
		observed: {
			nativeBuild: { exit: 0 },
			start: { exit: 0, socket: 0 },
			driver: { exit: 0, result: {} },
			status: { exit: 0 },
			stop: { exit: 0 },
		},
	});
	it('requires successful inner commands and observed journeys', () => {
		expect(pairRunStatus(complete())).toBe('completed');
		for (const key of ['nativeBuild', 'start', 'driver', 'status', 'stop'] as const) {
			const run = complete();
			run.observed[key].exit = 1;
			expect(pairRunStatus(run)).toBe('failed');
		}
		expect(pairRunStatus({ ...complete(), journeys: [] })).toBe('blocked');
		expect(pairRunStatus({ ...complete(), expectedJourneys: ['missing'] })).toBe('blocked');
		expect(
			pairRunStatus({ ...complete(), journeys: [...complete().journeys, ...complete().journeys] })
		).toBe('blocked');
		expect(pairRunStatus({ ...complete(), containerExit: null })).toBe('container-failed');
	});
	it.each(['failed', 'blocked', 'not-run'])(
		'never reports completion for a %s journey',
		(verdict) => {
			expect(
				pairRunStatus({
					...complete(),
					journeys: [{ id: 'library.handshake', surface: 'library', verdict }],
				})
			).toBe(verdict === 'failed' ? 'failed' : 'blocked');
		}
	);
});

describe('mandatory acceptance rows (MCOMP-33-02)', () => {
	type Evidence = AcceptanceCaseEvidence;
	const inputs = () =>
		Object.fromEntries(ACCEPTANCE_CASES.flatMap((c) => c.requires.map((i) => [i.id, true])));
	const seen = { observed: true, by: 'test', detail: null, problems: [] };
	const passing = (): Evidence[] =>
		ACCEPTANCE_CASES.map((c) => ({
			caseId: c.id,
			status: 'passed',
			host: c.runner === 'electron' ? 'electron' : 'node',
			endpoint: 'actual',
			artifacts: { runtimeSha256: 'a', endpointRevision: 'b', appSha256: 'c' },
			observations: { effect: seen, receipt: seen },
		}));
	const row = (id: string, evidence: Evidence[], present: Record<string, boolean> = inputs()) =>
		assessAcceptance(evidence, present).find((r) => r.id === id)!;
	const patched = (id: string, patch: Partial<Evidence>) =>
		passing().map((e) => (e.caseId === id ? { ...e, ...patch } : e));

	it('binds exactly the 19 rows of the program manifest to declared, used cases', () => {
		const file = path.resolve(__dirname, '../../../Plans/integration-completion/program.json');
		const matrix = JSON.parse(fs.readFileSync(file, 'utf8')).acceptanceMatrix as { id: string }[];
		expect(ACCEPTANCE_ROWS.map((r) => r.id).sort()).toEqual(matrix.map((r) => r.id).sort());
		expect(matrix).toHaveLength(19);
		const ids = ACCEPTANCE_CASES.map((c) => c.id);
		expect([...new Set(ACCEPTANCE_ROWS.flatMap((r) => r.cases))].sort()).toEqual([...ids].sort());
		for (const c of ACCEPTANCE_CASES.filter((c) => c.runner === 'electron'))
			expect(c.requires.some((i) => i.kind === 'native')).toBe(true);
	});

	it('holds every row pending without evidence or inputs, and passes only a full actual set', () => {
		expect(assessAcceptance([], {}).every((r) => r.verdict === 'pending')).toBe(true);
		expect(row('GUI-03', [], {}).cases[0].missingInputs).toContain(
			'MAESTRO-APP-MACOS-BUILD | MAESTRO-APP-WINDOWS-BUILD'
		);
		expect(assessAcceptance(passing(), inputs()).every((r) => r.verdict === 'passed')).toBe(true);
		const oneApp = { ...inputs(), 'MAESTRO-APP-WINDOWS-BUILD': false };
		expect(row('GUI-01', passing(), oneApp).verdict).toBe('passed');
		expect(row('GUI-01', passing(), { ...oneApp, 'MAESTRO-APP-MACOS-BUILD': false }).verdict).toBe(
			'pending'
		);
		expect(row('cue', patched('electron.cue-prompt-shell-cli', { status: 'failed' })).verdict).toBe(
			'failed'
		);
		const twice = [...passing(), passing().find((e) => e.caseId === 'cli.standalone')!];
		expect(row('standalone', twice).verdict).toBe('pending');
	});

	it.each<[string, Partial<Evidence>, string]>([
		['a fixture endpoint', { endpoint: 'fixture' }, 'contract-fixture'],
		['a browser render', { host: 'browser' }, 'ran on browser, not electron'],
		['no app digest', { artifacts: { runtimeSha256: 'a', endpointRevision: 'b' } }, 'desktop app'],
		['no receipt observation', { observations: { effect: seen } }, 'receipt observation'],
	])('never counts %s as desktop acceptance', (_label, patch, reason) => {
		const gui = row('GUI-03', patched('electron.interactive-run-controls', patch));
		expect(gui.verdict).toBe('not-counted');
		expect(gui.cases[0].reasons.join('; ')).toContain(reason);
	});

	it('takes producer freshness over any declaration, and maps a pair journey as Node evidence', () => {
		const stale = { 'CP-01': { fresh: false, detail: 'stale' } };
		expect(presentAcceptanceInputs(stale, { 'CP-01': true, X: true })).toEqual({
			'CP-01': false,
			X: true,
		});
		const journey = { id: 'library.admit', surface: 'library' as const, status: 'passed' as const };
		expect(
			pairCaseEvidence(
				{ ...journey, reason: null, steps: [] },
				{ runtimeSha256: null, endpointRevision: null }
			)
		).toMatchObject({
			caseId: 'library.admit',
			host: 'node',
			endpoint: 'actual',
			observations: {},
		});
	});

	it('observes the harness program effects off disk and a central receipt in the ledger', () => {
		const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pair-observe-')));
		try {
			expect(observeHarnessEffects(dir).observed).toBe(false);
			const marker = path.join(dir, 'child.marker');
			const ran = spawnSync(process.execPath, ['-e', SYNTHETIC_PROVIDER_SOURCE], {
				cwd: dir,
				input: JSON.stringify({ childMarker: marker }),
				timeout: 10_000,
			});
			expect(ran.status).toBe(0);
			expect(observeHarnessEffects(dir, marker)).toMatchObject({
				observed: true,
				detail: { childMarker: true },
			});
			const ledger = path.join(dir, 'receipts.json');
			const decision = { decisionId: 'd', requestDigest: 'r', brokerId: 'b', policyRevision: 3 };
			const receipt = (leaseId: string, d: unknown, state: string) => ({
				leaseId,
				decision: d,
				effect: { state },
			});
			const receipts = [
				receipt('l1', decision, 'released'),
				receipt('l2', null, 'released'),
				receipt('l3', decision, 'bound'),
			];
			fs.writeFileSync(ledger, JSON.stringify({ receipts }));
			expect(observeLedgerReceipt(ledger, 'l1').observed).toBe(true);
			expect(observeLedgerReceipt(ledger, 'l2').problems).toEqual([
				'decided in process: no central receipt',
			]);
			expect(observeLedgerReceipt(ledger, 'l3').problems).toEqual([
				'the effect has not ended (bound)',
			]);
			expect(observeLedgerReceipt(ledger, 'l9').problems).toEqual([
				'0 ledger records for lease l9',
			]);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
