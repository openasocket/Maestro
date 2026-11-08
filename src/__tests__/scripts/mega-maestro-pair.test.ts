import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
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
