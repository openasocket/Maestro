/**
 * The agent-run producers under management (MRC2-04-04A). Every producer only
 * reads, and the default runners keep it that way: the git runner goes through
 * the shared executor, whose gate classifies `diff` as a read and never holds
 * it (so a denying ceiling changes nothing for the producers) and refuses a
 * write-class command line by name with no process; the gh runner spawns
 * `gh pr view` and nothing else, in every mode. Standalone, both spawn exactly
 * what they spawned before, with the same timeouts.
 *
 * The real executor (`remote-git.ts`) and the real gate (`repository-policy.ts`)
 * run here over a mocked process layer and a ceiling double that refuses every
 * effect, so a refusal is proven by the absence of a spawn and a read by the
 * absence of a hold.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as execFile from '../../../main/utils/execFile';
import { GIT_REFUSED_EXIT_CODE, setGitExecutionGate } from '../../../main/utils/remote-git';
import {
	createGitExecutionGate,
	type RepositoryEffectDecision,
	type RepositoryEffectRequest,
} from '../../../main/enterprise/repository-policy';
import {
	GH_READ_ONLY_EXIT_CODE,
	buildEnrichHook,
	defaultGhRunner,
	defaultGitRunner,
	isGhReadCommand,
	pullRequestForBranch,
	touchedFilesFromGit,
} from '../../../main/agent-run/producers';
import type { AgentRun } from '../../../shared/agent-run';

vi.mock('../../../main/utils/execFile', () => ({
	execFileNoThrow: vi.fn(),
}));

vi.mock('../../../main/utils/cliDetection', () => ({
	resolveGhPath: vi.fn(async () => 'gh'),
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const ok = (stdout: string) => ({ stdout, stderr: '', exitCode: 0 });
const PR_JSON = JSON.stringify({
	number: 7,
	url: 'https://github.com/acme/widgets/pull/7',
	state: 'OPEN',
	mergeable: 'MERGEABLE',
	headRefName: 'feat',
	baseRefName: 'main',
});

/** Every git diff names one file per variant; gh pr view answers the PR. */
function processLayer(): void {
	vi.mocked(execFile.execFileNoThrow).mockImplementation(async (cmd, args) => {
		if (cmd === 'git' && args?.[0] === 'diff') {
			if (args.includes('--cached')) return ok('staged.ts\n');
			if (args.some((a) => a.includes('...'))) return ok('committed.ts\n');
			return ok('working.ts\n');
		}
		if (cmd === 'gh' && args?.[0] === 'pr' && args?.[1] === 'view') return ok(PR_JSON);
		return ok('');
	});
}

const calls = (cmd: string, sub: string) =>
	vi
		.mocked(execFile.execFileNoThrow)
		.mock.calls.filter((c) => c[0] === cmd && (c[1] as string[])?.[0] === sub);

/**
 * A managed host with no ceiling installed: the real gate refuses every write
 * `unavailable` and never reads origin; a read never reaches `authorize` at all.
 */
function denyingCeiling() {
	const requests: RepositoryEffectRequest[] = [];
	const repository = {
		standing: () => ({
			standing: 'managed' as const,
			ceiling: null,
			policyRevision: 3,
			reason: 'no repository ceiling is installed for policy revision 3',
		}),
		authorize(request: RepositoryEffectRequest): RepositoryEffectDecision {
			requests.push(request);
			return {
				allowed: false,
				code: 'unavailable',
				message: 'no repository ceiling is installed for policy revision 3',
				managed: {
					policyRevision: 3,
					surface: request.surface,
					actor: 'operator',
					effect: request.effect,
					repository: request.repository,
					remote: request.remote,
					outcome: 'unavailable',
				} as never,
			};
		},
	};
	setGitExecutionGate(createGitExecutionGate({ repository }));
	return { requests };
}

const run = (overrides: Partial<AgentRun> = {}): AgentRun => ({
	id: 'run-1',
	createdAt: 100,
	updatedAt: 100,
	provider: 'claude-code',
	status: 'running',
	artifacts: [],
	touchedFiles: [],
	checks: [],
	reviews: [],
	...overrides,
});

beforeEach(() => {
	vi.clearAllMocks();
	processLayer();
});

afterEach(() => {
	setGitExecutionGate(null);
});

describe('agent-run producers under management (MRC2-04-04A)', () => {
	it('standalone: the default git runner spawns each diff through the executor with the producer timeout', async () => {
		const files = await touchedFilesFromGit('/repo', 'main');

		expect(files).toEqual(['committed.ts', 'staged.ts', 'working.ts']);
		expect(calls('git', 'diff')).toHaveLength(3);
		expect(execFile.execFileNoThrow).toHaveBeenCalledWith(
			'git',
			['diff', '--name-only', 'main...HEAD'],
			'/repo',
			{ timeout: 15_000 }
		);
	});

	it('under a denying ceiling the diffs still run: a read is classified and never held', async () => {
		const ceiling = denyingCeiling();

		const files = await touchedFilesFromGit('/repo', 'main');

		expect(files).toEqual(['committed.ts', 'staged.ts', 'working.ts']);
		expect(calls('git', 'diff')).toHaveLength(3);
		expect(ceiling.requests).toEqual([]);
	});

	it('a write-class command line through the same runner is refused by name with no process', async () => {
		const ceiling = denyingCeiling();

		const result = await defaultGitRunner('/repo', ['commit', '-m', 'oops']);

		expect(result.exitCode).toBe(GIT_REFUSED_EXIT_CODE);
		expect(result.stderr).toMatch(/^\[managed-unavailable\] /);
		expect(calls('git', 'commit')).toHaveLength(0);
		expect(execFile.execFileNoThrow).not.toHaveBeenCalled();
		expect(ceiling.requests).toEqual([
			expect.objectContaining({
				surface: 'git',
				effect: 'commit',
				resource: 'local',
				actor: { kind: 'transport', actor: { peer: 'in-process' } },
			}),
		]);
	});

	it('the default gh runner spawns gh pr view with the producer timeout and maps the answer', async () => {
		const pr = await pullRequestForBranch('/repo', 'feat');

		expect(pr).toEqual({
			number: 7,
			url: 'https://github.com/acme/widgets/pull/7',
			state: 'open',
			mergeable: true,
			headBranch: 'feat',
			baseBranch: 'main',
		});
		expect(execFile.execFileNoThrow).toHaveBeenCalledWith(
			'gh',
			['pr', 'view', 'feat', '--json', 'number,url,state,mergeable,headRefName,baseRefName'],
			'/repo',
			{ timeout: 20_000 }
		);
	});

	it('the default gh runner refuses any gh command line that is not a read, in every mode, with no process', async () => {
		const result = await defaultGhRunner.execFile(
			'gh',
			['pr', 'comment', '7', '--body', 'x'],
			'/repo'
		);

		expect(result.exitCode).toBe(GH_READ_ONLY_EXIT_CODE);
		expect(result.stderr).toContain('"gh pr comment" was not run');
		expect(execFile.execFileNoThrow).not.toHaveBeenCalled();

		expect(isGhReadCommand(['pr', 'view', 'feat', '--json', 'number'])).toBe(true);
		expect(isGhReadCommand(['pr', 'create', '--draft'])).toBe(false);
		expect(isGhReadCommand(['pr', 'ready', '7'])).toBe(false);
		expect(isGhReadCommand(['gist', 'create', 'x'])).toBe(false);
		expect(isGhReadCommand(['pr'])).toBe(false);
		expect(isGhReadCommand([])).toBe(false);
	});

	it('the composed enrich hook with its default runners produces files and the PR under a denying ceiling without one hold', async () => {
		const ceiling = denyingCeiling();
		const hook = buildEnrichHook();

		const enrichment = await hook(run({ cwd: '/repo', branch: 'feat', baseBranch: 'main' }), 0);

		expect(enrichment.touchedFiles).toEqual(['committed.ts', 'staged.ts', 'working.ts']);
		expect(enrichment.pullRequest).toMatchObject({ number: 7, headBranch: 'feat' });
		expect(ceiling.requests).toEqual([]);
		expect(calls('git', 'diff')).toHaveLength(3);
		expect(calls('gh', 'pr')).toHaveLength(1);
	});
});
