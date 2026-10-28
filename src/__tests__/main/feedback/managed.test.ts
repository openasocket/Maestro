/**
 * Send Feedback under management (MRC2-04-05). Every write feedback makes on
 * the forge (an issue, a comment, a reaction, a label, the attachments
 * repository and the files put in it) is held against the repository ceiling
 * through the shared git executor's forge hold, right before the gh call that
 * performs it, and a refusal is a result with `refused: true` and no process.
 * Reads (the login, a label or repository check) are never held. What leaves
 * the machine passes through `redactSecrets()` first. Standalone, the gh
 * calls are what they were before.
 *
 * The real executor (`remote-git.ts`) and the real gate (`repository-policy.ts`)
 * run here over a mocked process layer and a ceiling double.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
	app: {
		isPackaged: false,
		getAppPath: () => '/mock/app',
		getVersion: () => '0.15.3',
		getPath: (name: string) => `/mock/${name}`,
	},
}));

const written = new Map<string, string>();
vi.mock('fs/promises', () => {
	const mock = {
		readFile: vi.fn(async () => {
			throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
		}),
		writeFile: vi.fn(async (file: string, content: string) => {
			written.set(file, content);
		}),
		unlink: vi.fn(async () => {}),
		mkdir: vi.fn(async () => {}),
		rename: vi.fn(async () => {}),
		access: vi.fn(async () => {}),
		readdir: vi.fn(async () => []),
	};
	return { ...mock, default: mock };
});

vi.mock('../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		error: vi.fn(),
		warn: vi.fn(),
		debug: vi.fn(),
		getLogFilePath: vi.fn(() => '/mock/logs/maestro.log'),
	},
}));
vi.mock('../../../main/prompt-manager', () => ({ getPrompt: vi.fn(() => 'TEMPLATE') }));
vi.mock('../../../main/utils/cliDetection', () => ({
	clearGhCache: vi.fn(),
	isGhInstalled: vi.fn(),
	setCachedGhStatus: vi.fn(),
	getCachedGhStatus: vi.fn(),
	getExpandedEnv: vi.fn(() => ({ PATH: '/usr/bin' })),
	resolveGhPath: vi.fn(async (customPath?: string) => customPath ?? 'gh'),
}));
vi.mock('../../../main/utils/execFile', () => ({ execFileNoThrow: vi.fn() }));
vi.mock('../../../main/stores/instances', () => ({ isInitialized: () => false }));
vi.mock('../../../main/stores/getters', () => ({
	getSettingsStore: () => ({ get: () => undefined }),
}));
vi.mock('../../../main/debug-package', () => ({ generateDebugPackage: vi.fn() }));
vi.mock('../../../main/feedback/live-state', () => ({
	captureFeedbackLiveDiagnosis: vi.fn(async () => ({ rendererAvailable: false })),
}));
vi.mock('../../../shared/feedbackLiveState', () => ({
	formatLiveDiagnosisForIssue: () => '',
	formatLiveDiagnosisForPrompt: () => '',
}));
vi.mock('../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
	captureMessage: vi.fn(),
}));
vi.mock('../../../main/utils/atomic-json-store', () => ({
	atomicWriteJson: vi.fn(async () => {}),
	createKeyedWriteQueue: () => ({ enqueue: (_key: string, fn: () => unknown) => fn() }),
}));

import * as execFile from '../../../main/utils/execFile';
import { setGitExecutionGate } from '../../../main/utils/remote-git';
import {
	createGitExecutionGate,
	type RepositoryEffectDecision,
	type RepositoryEffectKind,
	type RepositoryEffectRequest,
} from '../../../main/enterprise/repository-policy';
import {
	submitFeedback,
	submitFeedbackConversation,
	subscribeFeedbackIssue,
} from '../../../main/feedback/index';

const TOKEN = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij';
const ok = (stdout = '') => ({ stdout, stderr: '', exitCode: 0 });
const fail = (stderr = 'HTTP 404') => ({ stdout: '', stderr, exitCode: 1 });

/** gh as the forge answers it: the login, a missing label, a present attachments repo, an issue URL. */
function processLayer(): void {
	vi.mocked(execFile.execFileNoThrow).mockImplementation(async (_cmd, args) => {
		const line = (args as string[]).join(' ');
		if (line.startsWith('api user')) return ok('me\n');
		if (line.startsWith('api repos/RunMaestro/Maestro/labels/')) return fail();
		if (line.startsWith('api repos/me/maestro-feedback-attachments ')) return ok('{}');
		if (line.startsWith('api repos/me/maestro-feedback-attachments/contents/'))
			return ok(JSON.stringify({ content: { download_url: 'https://raw/x.png' } }));
		if (line.startsWith('issue create'))
			return ok('https://github.com/RunMaestro/Maestro/issues/9\n');
		return ok('');
	});
}

const ghLines = () =>
	vi.mocked(execFile.execFileNoThrow).mock.calls.map((c) => (c[1] as string[]).join(' '));

/** A managed host whose ceiling admits exactly `effects` for the operator; null admits nothing (unavailable). */
function ceiling(effects: readonly RepositoryEffectKind[] | null) {
	const requests: RepositoryEffectRequest[] = [];
	const standing = effects
		? {
				standing: 'managed' as const,
				ceiling: {
					policyRevision: 3,
					actors: [{ actor: 'operator' as const, effects: [...effects] }],
				},
				policyRevision: 3,
			}
		: {
				standing: 'managed' as const,
				ceiling: null,
				policyRevision: 3,
				reason: 'no repository ceiling is installed for policy revision 3',
			};
	const repository = {
		standing: () => standing,
		authorize(request: RepositoryEffectRequest): RepositoryEffectDecision {
			requests.push(request);
			const receipt = {
				policyRevision: 3,
				surface: request.surface,
				actor: 'operator',
				effect: request.effect,
				repository: request.repository,
				remote: request.remote,
			};
			if (!effects)
				return {
					allowed: false,
					code: 'unavailable',
					message: 'no repository ceiling is installed for policy revision 3',
					managed: { ...receipt, outcome: 'unavailable' },
				};
			if (!effects.includes(request.effect))
				return {
					allowed: false,
					code: 'outside-ceiling',
					message: `the repository ceiling admits no ${request.effect} effect for operator`,
					managed: { ...receipt, outcome: 'outside-ceiling' },
				};
			return { allowed: true, managed: { ...receipt, outcome: 'within-ceiling' } };
		},
	};
	setGitExecutionGate(createGitExecutionGate({ repository }));
	return { requests, effects: () => requests.map((r) => r.effect) };
}

/** A managed identifier (MRC2-06-07): a registration nonce, 43 base64url characters. */
const NONCE = 'n' + 'Qz9_-'.repeat(9).slice(0, 42);

const conversation = (overrides: Record<string, unknown> = {}) => ({
	category: 'bug_report' as const,
	summary: 'The composer loses my draft',
	expectedBehavior: 'The draft stays',
	actualBehavior: `It is gone, and the log shows token ${TOKEN} being sent after nonce: ${NONCE}`,
	...overrides,
});

const png = {
	name: 'shot.png',
	dataUrl: `data:image/png;base64,${Buffer.from('x').toString('base64')}`,
};

beforeEach(() => {
	vi.clearAllMocks();
	written.clear();
	processLayer();
});

afterEach(() => {
	setGitExecutionGate(null);
});

describe('Send Feedback under management (MRC2-04-05)', () => {
	it('standalone: files the issue with the same gh calls as before, and the body leaves redacted', async () => {
		const result = await submitFeedbackConversation(conversation());

		expect(result).toEqual({
			success: true,
			issueUrl: 'https://github.com/RunMaestro/Maestro/issues/9',
		});
		expect(ghLines().map((l) => l.split(' ').slice(0, 2).join(' '))).toEqual([
			'api repos/RunMaestro/Maestro/labels/Maestro-feedback',
			'label create',
			'issue create',
		]);
		const body = [...written.values()].find((text) => text.includes('## Summary'));
		expect(body).toContain('[REDACTED_API_KEY]');
		expect(body).not.toContain(TOKEN);
		expect(body).toContain('nonce: [REDACTED_SECRET]');
		expect(body).not.toContain(NONCE);
	});

	it('managed with no ceiling: the issue is refused up front with zero gh processes and the draft untouched', async () => {
		const held = ceiling(null);

		const result = await submitFeedbackConversation(conversation({ attachments: [png] }));

		expect(result).toEqual({
			success: false,
			refused: true,
			error: expect.stringContaining('[managed-unavailable]'),
		});
		expect(execFile.execFileNoThrow).not.toHaveBeenCalled();
		expect(written.size).toBe(0);
		expect(held.requests).toEqual([
			expect.objectContaining({
				surface: 'git',
				effect: 'issue',
				resource: 'remote',
				repository: 'RunMaestro/Maestro',
				remote: 'https://github.com',
			}),
		]);
	});

	it('a ceiling that admits the issue but not the upload: the login is read, then the upload is refused before the repository is touched', async () => {
		const held = ceiling(['issue']);

		const result = await submitFeedbackConversation(conversation({ attachments: [png] }));

		expect(result).toEqual({
			success: false,
			refused: true,
			error: expect.stringContaining('[managed-outside-ceiling]'),
		});
		expect(ghLines()).toEqual(['api user --jq .login']);
		expect(held.effects()).toEqual(['issue', 'upload']);
		expect(held.requests[1]).toMatchObject({
			repository: 'me/maestro-feedback-attachments',
			remote: 'https://github.com',
		});
	});

	it('a ceiling that admits both: each effect is held right before its gh call, in order', async () => {
		const held = ceiling(['issue', 'upload']);

		const result = await submitFeedbackConversation(conversation({ attachments: [png] }));

		expect(result.success).toBe(true);
		expect(held.effects()).toEqual(['issue', 'upload', 'issue', 'issue']);
		// The upload's content path carries a timestamp, so each line is named by its stem.
		expect(ghLines().map((l) => l.replace(/contents\/feedback\/\S+/, 'contents/<file>'))).toEqual([
			'api user --jq .login',
			'api repos/me/maestro-feedback-attachments',
			expect.stringMatching(
				/^api repos\/me\/maestro-feedback-attachments\/contents\/<file> --method PUT/
			),
			'api repos/RunMaestro/Maestro/labels/Maestro-feedback',
			expect.stringMatching(/^label create Maestro-feedback -R RunMaestro\/Maestro/),
			expect.stringMatching(/^issue create -R RunMaestro\/Maestro/),
		]);
	});

	it('subscribing to an issue: refused with no process under a denying ceiling; standalone, the comment leaves redacted', async () => {
		ceiling(null);
		const refused = await subscribeFeedbackIssue({ issueNumber: 4, comment: 'me too' });
		expect(refused).toEqual({
			success: false,
			refused: true,
			error: expect.stringContaining('[managed-unavailable]'),
		});
		expect(execFile.execFileNoThrow).not.toHaveBeenCalled();

		setGitExecutionGate(null);
		const result = await subscribeFeedbackIssue({ issueNumber: 4, comment: `mine too: ${TOKEN}` });
		expect(result).toEqual({ success: true });
		const comment = ghLines().find((l) => l.startsWith('issue comment 4'));
		expect(comment).toContain('[REDACTED_API_KEY]');
		expect(comment).not.toContain(TOKEN);
	});

	it('the legacy one-shot submit is held up front too: nothing is uploaded or filed under a denying ceiling', async () => {
		const held = ceiling(null);

		const result = await submitFeedback({
			sessionId: 's1',
			category: 'feature_request',
			summary: 'More themes',
			expectedBehavior: 'A dark theme',
			details: 'Please',
			attachments: [png],
		});

		expect(result).toEqual({
			success: false,
			refused: true,
			error: expect.stringContaining('[managed-unavailable]'),
		});
		expect(execFile.execFileNoThrow).not.toHaveBeenCalled();
		expect(held.effects()).toEqual(['issue']);
	});
});
