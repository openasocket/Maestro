/**
 * The Cue GitHub poller under management (MRC2-04-05). A poll is held, by the
 * subscription's repository, before the first gh call that reaches GitHub;
 * a denied poll is reported on the Cue log (once per reason) and the schedule
 * keeps running, so the poller never stops silently and a ceiling installed
 * later is honored on the next tick. Standalone, no hold runs and the gh
 * calls are what they were.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockExecFile, mockMarkGitHubItemSeen } = vi.hoisted(() => ({
	mockExecFile: vi.fn(),
	mockMarkGitHubItemSeen: vi.fn(),
}));

vi.mock('child_process', () => ({ default: { execFile: mockExecFile }, execFile: mockExecFile }));
vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn(async () => {}) }));
vi.mock('../../../main/utils/cliDetection', () => ({
	resolveGhPath: vi.fn().mockResolvedValue('gh'),
	getExpandedEnv: vi.fn().mockReturnValue(process.env),
}));
vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../main/cue/cue-db', () => ({
	isCueDbReady: () => true,
	isGitHubItemSeen: () => false,
	markGitHubItemSeen: (...args: unknown[]) => mockMarkGitHubItemSeen(...args),
	hasAnyGitHubSeen: () => true,
	pruneGitHubSeen: vi.fn(),
	pruneSusFactorBlocks: vi.fn(),
	getGitHubItemState: () => null,
	recordGitHubRetrigger: vi.fn(),
	setGitHubItemRevision: vi.fn(),
}));

import { setGitExecutionGate } from '../../../main/utils/remote-git';
import {
	createGitExecutionGate,
	type RepositoryEffectRequest,
} from '../../../main/enterprise/repository-policy';
import {
	createCueGitHubPoller,
	githubPollTarget,
	type CueGitHubPollerConfig,
} from '../../../main/cue/cue-github-poller';

/** gh answers its version and an empty list; anything else is unexpected. */
function processLayer(): void {
	mockExecFile.mockImplementation(
		(
			cmd: string,
			args: string[],
			_opts: unknown,
			cb: (e: Error | null, o: string, s: string) => void
		) => {
			const line = `${cmd} ${args.join(' ')}`;
			if (line.includes('--version')) return cb(null, '2.0.0', '');
			if (line.includes('pr list')) return cb(null, '[]', '');
			cb(new Error(`unexpected: ${line}`), '', '');
		}
	);
}

const ghLines = () => mockExecFile.mock.calls.map((c) => (c[1] as string[]).join(' '));

function config(overrides: Partial<CueGitHubPollerConfig> = {}): CueGitHubPollerConfig {
	return {
		eventType: 'github.pull_request',
		repo: 'owner/repo',
		pollMinutes: 5,
		projectRoot: '/projects/test',
		onEvent: vi.fn((_e: unknown, onOutcome: (o: 'emitted') => void) => onOutcome('emitted')),
		onLog: vi.fn(),
		triggerName: 'watch-prs',
		subscriptionId: 'session-1:watch-prs',
		...overrides,
	};
}

const denials = (cfg: CueGitHubPollerConfig) =>
	vi
		.mocked(cfg.onLog)
		.mock.calls.filter((c) => c[0] === 'warn' && String(c[1]).includes('GitHub poll denied'));

beforeEach(() => {
	vi.clearAllMocks();
	vi.useFakeTimers();
	processLayer();
});

afterEach(() => {
	setGitExecutionGate(null);
	vi.useRealTimers();
});

describe('Cue GitHub poller under management (MRC2-04-05)', () => {
	it('names what a poll is held against: the forge host the repo names, else github.com', () => {
		expect(githubPollTarget('owner/repo')).toEqual({
			destination: 'https://github.com',
			repository: 'owner/repo',
		});
		expect(githubPollTarget('GHE.corp/team/app')).toEqual({
			destination: 'https://ghe.corp',
			repository: 'team/app',
		});
		expect(githubPollTarget(null)).toEqual({ destination: 'https://github.com', repository: null });
	});

	it('a denied poll asks GitHub nothing, is reported once per reason, keeps its schedule and seeds the first run', async () => {
		const holdPoll = vi
			.fn<(repo: string | null) => Promise<string | null>>()
			.mockResolvedValue('[managed-unavailable] no ceiling is installed');
		const cfg = config({ holdPoll });
		const cleanup = createCueGitHubPoller(cfg);

		await vi.advanceTimersByTimeAsync(2000);
		expect(holdPoll).toHaveBeenCalledWith('owner/repo');
		expect(ghLines()).toEqual(['--version']);
		expect(denials(cfg)).toHaveLength(1);
		expect(denials(cfg)[0][1]).toContain('[managed-unavailable] no ceiling is installed');
		expect(mockMarkGitHubItemSeen).toHaveBeenCalledWith('session-1:watch-prs', '__seed_marker__');
		expect(cfg.onEvent).not.toHaveBeenCalled();

		// The next tick holds again, and the same reason is not repeated.
		await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
		expect(holdPoll).toHaveBeenCalledTimes(2);
		expect(denials(cfg)).toHaveLength(1);

		// A ceiling installed later admits the poll on the following tick.
		holdPoll.mockResolvedValue(null);
		await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
		expect(ghLines().filter((l) => l.startsWith('pr list'))).toHaveLength(1);

		cleanup();
	});

	it('standalone (no gate installed): the default hold runs nothing extra and the poll proceeds', async () => {
		const cfg = config();
		const cleanup = createCueGitHubPoller(cfg);

		await vi.advanceTimersByTimeAsync(2000);
		expect(ghLines()).toEqual(['--version', expect.stringMatching(/^pr list --repo owner\/repo/)]);
		expect(denials(cfg)).toHaveLength(0);

		cleanup();
	});

	it('the default hold reaches the real gate: a managed host with no ceiling refuses the poll effect by name', async () => {
		const requests: RepositoryEffectRequest[] = [];
		setGitExecutionGate(
			createGitExecutionGate({
				repository: {
					standing: () => ({
						standing: 'managed',
						ceiling: null,
						policyRevision: 3,
						reason: 'no repository ceiling is installed for policy revision 3',
					}),
					authorize(request) {
						requests.push(request);
						return {
							allowed: false,
							code: 'unavailable',
							message: 'no repository ceiling is installed for policy revision 3',
							managed: {
								policyRevision: 3,
								surface: 'git',
								actor: 'operator',
								effect: request.effect,
								repository: request.repository,
								remote: request.remote,
								outcome: 'unavailable',
							},
						};
					},
				},
			})
		);
		const cfg = config({ repo: 'ghe.corp/team/app' });
		const cleanup = createCueGitHubPoller(cfg);

		await vi.advanceTimersByTimeAsync(2000);
		expect(ghLines()).toEqual(['--version']);
		expect(requests).toEqual([
			expect.objectContaining({
				surface: 'git',
				effect: 'poll',
				resource: 'remote',
				repository: 'team/app',
				remote: 'https://ghe.corp',
			}),
		]);
		expect(denials(cfg)[0][1]).toContain('[managed-unavailable]');

		cleanup();
	});
});
