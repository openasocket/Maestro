/**
 * Tests for the Symphony Runner Service
 *
 * The Symphony Runner orchestrates git operations and PR workflows for
 * Symphony contributions, including cloning repos, creating branches,
 * pushing changes, and managing draft PRs.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock fs/promises
vi.mock('fs/promises', () => ({
	default: {
		mkdir: vi.fn(),
		rm: vi.fn(),
		writeFile: vi.fn(),
		copyFile: vi.fn(),
	},
}));

// Mock execFileNoThrow
vi.mock('../../../main/utils/execFile', () => ({
	execFileNoThrow: vi.fn(),
}));

// Mock the logger
vi.mock('../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

// Mock symphony-fork
vi.mock('../../../main/utils/symphony-fork', () => ({
	ensureForkSetup: vi.fn(),
}));

// Mock cliDetection - resolveGhPath returns 'gh' so existing assertions still match
vi.mock('../../../main/utils/cliDetection', () => ({
	resolveGhPath: vi.fn().mockResolvedValue('gh'),
}));

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Import mocked modules after mocks are set up
import fs from 'fs/promises';
import { execFileNoThrow } from '../../../main/utils/execFile';
import { logger } from '../../../main/utils/logger';
import { ensureForkSetup } from '../../../main/utils/symphony-fork';
import {
	startContribution,
	finalizeContribution,
	cancelContribution,
	type SymphonyRepositoryGate,
} from '../../../main/services/symphony-runner';
import {
	REPOSITORY_EFFECTS,
	createRepositoryPolicySource,
	type RepositoryEffectActor,
	type RepositoryEffectAuthority,
	type RepositoryEffectDecision,
	type RepositoryEffectKind,
	type RepositoryEffectRequest,
} from '../../../main/enterprise/repository-policy';
import type { IdentityRead } from '../../../main/enterprise/identity-store';
import { runAsTransport } from '../../../main/web-server/auth/transport-actor';
import { isGitHubAuthError, isGitHubMissingScopeError } from '../../../main/utils/ghErrors';

describe('Symphony Runner Service', () => {
	// Helper to set up full successful workflow mocks (7 calls for startContribution)
	const mockSuccessfulWorkflow = (prUrl = 'https://github.com/owner/repo/pull/1') => {
		vi.mocked(execFileNoThrow)
			.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // clone
			.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // checkout -b
			.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // config user.name
			.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // config user.email
			.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // commit --allow-empty
			.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // push
			.mockResolvedValueOnce({ stdout: prUrl, stderr: '', exitCode: 0 }); // pr create
	};

	// Helper to set up finalize workflow mocks (8 calls)
	const mockFinalizeWorkflow = (prUrl = 'https://github.com/owner/repo/pull/1') => {
		vi.mocked(execFileNoThrow)
			.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // config user.name
			.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // config user.email
			.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // git add -A
			.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // git commit
			.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // git push
			.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // gh pr ready
			.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // gh pr edit
			.mockResolvedValueOnce({ stdout: prUrl, stderr: '', exitCode: 0 }); // gh pr view
	};

	beforeEach(() => {
		vi.clearAllMocks();

		// Default mock implementations for fs
		vi.mocked(fs.mkdir).mockResolvedValue(undefined);
		vi.mocked(fs.rm).mockResolvedValue(undefined);
		vi.mocked(fs.writeFile).mockResolvedValue(undefined);
		vi.mocked(fs.copyFile).mockResolvedValue(undefined);

		// Default: no fork needed
		vi.mocked(ensureForkSetup).mockResolvedValue({ isFork: false });
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	// ============================================================================
	// Test File Setup
	// ============================================================================

	describe('test file setup', () => {
		it('should have proper imports and mocks for fs/promises', () => {
			expect(fs.mkdir).toBeDefined();
			expect(fs.rm).toBeDefined();
			expect(fs.writeFile).toBeDefined();
			expect(fs.copyFile).toBeDefined();
		});

		it('should have proper mock for execFileNoThrow', () => {
			expect(execFileNoThrow).toBeDefined();
			expect(vi.isMockFunction(execFileNoThrow)).toBe(true);
		});

		it('should have proper mock for logger', () => {
			expect(logger.info).toBeDefined();
			expect(logger.warn).toBeDefined();
			expect(logger.error).toBeDefined();
			expect(logger.debug).toBeDefined();
		});

		it('should have proper mock for global fetch', () => {
			expect(global.fetch).toBeDefined();
			expect(vi.isMockFunction(global.fetch)).toBe(true);
		});
	});

	// ============================================================================
	// Clone Repo Tests
	// ============================================================================

	describe('cloneRepo', () => {
		it('calls git clone with --depth=1 flag', async () => {
			mockSuccessfulWorkflow();

			await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 123,
				issueTitle: 'Test Issue',
				documentPaths: [],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
			});

			expect(execFileNoThrow).toHaveBeenCalledWith('git', [
				'clone',
				'--depth=1',
				'https://github.com/owner/repo',
				'/tmp/test-repo',
			]);
		});

		it('writes two references sharing a basename to separate files', async () => {
			// docs/architecture.md and spec/architecture.md both reduce to
			// architecture.md. Both must survive rather than the second
			// overwriting the first.
			mockSuccessfulWorkflow();

			await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 123,
				issueTitle: 'Test Issue',
				documentPaths: [
					{ name: 'docs/architecture.md', path: 'docs/architecture.md', isExternal: false },
					{ name: 'spec/architecture.md', path: 'spec/architecture.md', isExternal: false },
				],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
			});

			const destinations = vi.mocked(fs.copyFile).mock.calls.map((c) => c[1]);
			expect(destinations).toHaveLength(2);
			expect(new Set(destinations).size).toBe(2);
			expect(destinations.some((d) => String(d).endsWith('architecture.md'))).toBe(true);
			expect(destinations.some((d) => String(d).endsWith('architecture-2.md'))).toBe(true);
		});

		it('returns true on successful clone (exitCode 0)', async () => {
			mockSuccessfulWorkflow();

			const result = await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 123,
				issueTitle: 'Test Issue',
				documentPaths: [],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
			});

			expect(result.success).toBe(true);
		});

		it('returns false on failed clone (non-zero exitCode)', async () => {
			vi.mocked(execFileNoThrow).mockResolvedValueOnce({
				stdout: '',
				stderr: 'fatal: repository not found',
				exitCode: 128,
			});

			const result = await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 123,
				issueTitle: 'Test Issue',
				documentPaths: [],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
			});

			expect(result.success).toBe(false);
			expect(result.error).toBe('Clone failed');
		});
	});

	// ============================================================================
	// Create Branch Tests
	// ============================================================================

	describe('createBranch', () => {
		it('calls git checkout -b with branch name', async () => {
			mockSuccessfulWorkflow();

			await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 123,
				issueTitle: 'Test Issue',
				documentPaths: [],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
			});

			expect(execFileNoThrow).toHaveBeenCalledWith(
				'git',
				['checkout', '-b', 'symphony/test-branch'],
				'/tmp/test-repo'
			);
		});

		it('uses correct working directory', async () => {
			mockSuccessfulWorkflow();

			await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 123,
				issueTitle: 'Test Issue',
				documentPaths: [],
				localPath: '/custom/path/repo',
				branchName: 'symphony/test-branch',
			});

			expect(execFileNoThrow).toHaveBeenCalledWith(
				'git',
				['checkout', '-b', 'symphony/test-branch'],
				'/custom/path/repo'
			);
		});

		it('returns true on success', async () => {
			mockSuccessfulWorkflow();

			const result = await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 123,
				issueTitle: 'Test Issue',
				documentPaths: [],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
			});

			expect(result.success).toBe(true);
		});

		it('returns false on failure', async () => {
			vi.mocked(execFileNoThrow)
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // clone succeeds
				.mockResolvedValueOnce({
					stdout: '',
					stderr: 'error: branch already exists',
					exitCode: 128,
				}); // checkout -b fails

			const result = await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 123,
				issueTitle: 'Test Issue',
				documentPaths: [],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
			});

			expect(result.success).toBe(false);
			expect(result.error).toBe('Branch creation failed');
		});
	});

	// ============================================================================
	// Configure Git User Tests
	// ============================================================================

	describe('configureGitUser', () => {
		it('sets user.name to "Maestro Symphony"', async () => {
			mockSuccessfulWorkflow();

			await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 123,
				issueTitle: 'Test Issue',
				documentPaths: [],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
			});

			expect(execFileNoThrow).toHaveBeenCalledWith(
				'git',
				['config', 'user.name', 'Maestro Symphony'],
				'/tmp/test-repo'
			);
		});

		it('sets user.email to "symphony@runmaestro.ai"', async () => {
			mockSuccessfulWorkflow();

			await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 123,
				issueTitle: 'Test Issue',
				documentPaths: [],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
			});

			expect(execFileNoThrow).toHaveBeenCalledWith(
				'git',
				['config', 'user.email', 'symphony@runmaestro.ai'],
				'/tmp/test-repo'
			);
		});

		it('returns true when both configs succeed', async () => {
			mockSuccessfulWorkflow();

			const result = await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 123,
				issueTitle: 'Test Issue',
				documentPaths: [],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
			});

			expect(result.success).toBe(true);
		});

		it('logs warning when user.name config fails', async () => {
			vi.mocked(execFileNoThrow)
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // clone
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // checkout -b
				.mockResolvedValueOnce({ stdout: '', stderr: 'error', exitCode: 1 }) // config user.name fails
				// Note: user.email is NOT called because configureGitUser returns early
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // commit --allow-empty
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // push
				.mockResolvedValueOnce({
					stdout: 'https://github.com/owner/repo/pull/1',
					stderr: '',
					exitCode: 0,
				}); // pr create

			await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 123,
				issueTitle: 'Test Issue',
				documentPaths: [],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
			});

			expect(logger.warn).toHaveBeenCalledWith(
				'Failed to set git user.name',
				expect.any(String),
				expect.any(Object)
			);
		});

		it('logs warning when user.email config fails', async () => {
			vi.mocked(execFileNoThrow)
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // clone
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // checkout -b
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // config user.name succeeds
				.mockResolvedValueOnce({ stdout: '', stderr: 'error', exitCode: 1 }) // config user.email fails
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // commit --allow-empty
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // push
				.mockResolvedValueOnce({
					stdout: 'https://github.com/owner/repo/pull/1',
					stderr: '',
					exitCode: 0,
				}); // pr create

			const result = await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 123,
				issueTitle: 'Test Issue',
				documentPaths: [],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
			});

			expect(logger.warn).toHaveBeenCalledWith(
				'Failed to set git user.email',
				expect.any(String),
				expect.any(Object)
			);
			// Workflow continues despite config failure
			expect(result.success).toBe(true);
		});
	});

	// ============================================================================
	// Create Empty Commit Tests
	// ============================================================================

	describe('createEmptyCommit', () => {
		it('calls git commit with --allow-empty flag', async () => {
			mockSuccessfulWorkflow();

			await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 123,
				issueTitle: 'Test Issue',
				documentPaths: [],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
			});

			expect(execFileNoThrow).toHaveBeenCalledWith(
				'git',
				['commit', '--allow-empty', '-m', '[Symphony] Start contribution for #123'],
				'/tmp/test-repo'
			);
		});

		it('uses provided commit message', async () => {
			mockSuccessfulWorkflow();

			await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 456,
				issueTitle: 'Test Issue',
				documentPaths: [],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
			});

			expect(execFileNoThrow).toHaveBeenCalledWith(
				'git',
				['commit', '--allow-empty', '-m', '[Symphony] Start contribution for #456'],
				'/tmp/test-repo'
			);
		});

		it('returns true on success', async () => {
			mockSuccessfulWorkflow();

			const result = await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 123,
				issueTitle: 'Test Issue',
				documentPaths: [],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
			});

			expect(result.success).toBe(true);
		});

		it('returns false on failure', async () => {
			vi.mocked(execFileNoThrow)
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // clone
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // checkout -b
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // config user.name
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // config user.email
				.mockResolvedValueOnce({ stdout: '', stderr: 'error', exitCode: 1 }); // commit --allow-empty fails

			const result = await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 123,
				issueTitle: 'Test Issue',
				documentPaths: [],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
			});

			expect(result.success).toBe(false);
			expect(result.error).toBe('Empty commit failed');
		});
	});

	// ============================================================================
	// Push Branch Tests
	// ============================================================================

	describe('pushBranch', () => {
		it('calls git push with -u origin and branch name', async () => {
			mockSuccessfulWorkflow();

			await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 123,
				issueTitle: 'Test Issue',
				documentPaths: [],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
			});

			expect(execFileNoThrow).toHaveBeenCalledWith(
				'git',
				['push', '-u', 'origin', 'symphony/test-branch'],
				'/tmp/test-repo'
			);
		});

		it('returns true on success', async () => {
			mockSuccessfulWorkflow();

			const result = await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 123,
				issueTitle: 'Test Issue',
				documentPaths: [],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
			});

			expect(result.success).toBe(true);
		});

		it('returns false on failure', async () => {
			vi.mocked(execFileNoThrow)
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // clone
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // checkout -b
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // config user.name
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // config user.email
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // commit --allow-empty
				.mockResolvedValueOnce({ stdout: '', stderr: 'error: push failed', exitCode: 1 }); // push fails

			const result = await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 123,
				issueTitle: 'Test Issue',
				documentPaths: [],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
			});

			expect(result.success).toBe(false);
			expect(result.error).toBe('Push failed');
		});
	});

	// ============================================================================
	// Create Draft PR Tests
	// ============================================================================

	describe('createDraftPR', () => {
		it('calls gh pr create with --draft flag', async () => {
			mockSuccessfulWorkflow();

			await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 123,
				issueTitle: 'Test Issue',
				documentPaths: [],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
			});

			expect(execFileNoThrow).toHaveBeenCalledWith(
				'gh',
				expect.arrayContaining(['pr', 'create', '--draft']),
				'/tmp/test-repo'
			);
		});

		it('includes issue reference in body with Closes #N', async () => {
			mockSuccessfulWorkflow();

			await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 789,
				issueTitle: 'Test Issue',
				documentPaths: [],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
			});

			const prCreateCall = vi
				.mocked(execFileNoThrow)
				.mock.calls.find((call) => call[0] === 'gh' && call[1]?.includes('pr'));
			expect(prCreateCall).toBeDefined();
			const bodyIndex = prCreateCall![1].indexOf('--body');
			expect(bodyIndex).toBeGreaterThan(-1);
			const bodyArg = prCreateCall![1][bodyIndex + 1];
			expect(bodyArg).toContain('Closes #789');
		});

		it('returns success with prUrl from stdout', async () => {
			mockSuccessfulWorkflow('https://github.com/owner/repo/pull/42');

			const result = await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 123,
				issueTitle: 'Test Issue',
				documentPaths: [],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
			});

			expect(result.success).toBe(true);
			expect(result.draftPrUrl).toBe('https://github.com/owner/repo/pull/42');
		});

		it('parses PR number from URL correctly', async () => {
			mockSuccessfulWorkflow('https://github.com/owner/repo/pull/99');

			const result = await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 123,
				issueTitle: 'Test Issue',
				documentPaths: [],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
			});

			expect(result.success).toBe(true);
			expect(result.draftPrNumber).toBe(99);
		});

		it('returns error message on failure', async () => {
			vi.mocked(execFileNoThrow)
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // clone
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // checkout -b
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // config user.name
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // config user.email
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // commit --allow-empty
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // push
				.mockResolvedValueOnce({ stdout: '', stderr: 'gh auth required', exitCode: 1 }); // pr create fails

			const result = await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 123,
				issueTitle: 'Test Issue',
				documentPaths: [],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
			});

			expect(result.success).toBe(false);
			expect(result.error).toContain('PR creation failed');
		});
	});

	// ============================================================================
	// Download File Tests
	// ============================================================================

	describe('downloadFile', () => {
		it('fetches URL and writes buffer to destination', async () => {
			const mockArrayBuffer = new ArrayBuffer(8);
			mockFetch.mockResolvedValueOnce({
				ok: true,
				arrayBuffer: vi.fn().mockResolvedValue(mockArrayBuffer),
			});

			mockSuccessfulWorkflow();

			await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 123,
				issueTitle: 'Test Issue',
				documentPaths: [{ name: 'doc.md', path: 'https://example.com/doc.md', isExternal: true }],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
			});

			expect(mockFetch).toHaveBeenCalledWith(
				'https://example.com/doc.md',
				expect.objectContaining({ signal: expect.anything() })
			);
			expect(fs.writeFile).toHaveBeenCalledWith(
				'/tmp/test-repo/.maestro/playbooks/doc.md',
				expect.any(Buffer)
			);
		});

		it('returns true on successful download', async () => {
			const mockArrayBuffer = new ArrayBuffer(8);
			mockFetch.mockResolvedValueOnce({
				ok: true,
				arrayBuffer: vi.fn().mockResolvedValue(mockArrayBuffer),
			});

			mockSuccessfulWorkflow();

			const result = await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 123,
				issueTitle: 'Test Issue',
				documentPaths: [{ name: 'doc.md', path: 'https://example.com/doc.md', isExternal: true }],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
			});

			expect(result.success).toBe(true);
		});

		it('returns false on HTTP error response', async () => {
			mockFetch.mockResolvedValueOnce({
				ok: false,
				status: 404,
			});

			mockSuccessfulWorkflow();

			const result = await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 123,
				issueTitle: 'Test Issue',
				documentPaths: [{ name: 'doc.md', path: 'https://example.com/doc.md', isExternal: true }],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
			});

			// Download failure logs error but doesn't fail the whole operation
			expect(logger.error).toHaveBeenCalledWith(
				'Failed to download file',
				expect.any(String),
				expect.objectContaining({ status: 404 })
			);
		});

		it('returns false on network error', async () => {
			mockFetch.mockRejectedValueOnce(new Error('Network error'));

			mockSuccessfulWorkflow();

			const result = await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 123,
				issueTitle: 'Test Issue',
				documentPaths: [{ name: 'doc.md', path: 'https://example.com/doc.md', isExternal: true }],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
			});

			// Network error logs but doesn't fail the whole operation
			expect(logger.error).toHaveBeenCalledWith(
				'Error downloading file',
				expect.any(String),
				expect.objectContaining({ error: expect.any(Error) })
			);
		});
	});

	// ============================================================================
	// Setup .maestro/playbooks Tests
	// ============================================================================

	describe('setupAutoRunDocs', () => {
		it('creates .maestro/playbooks directory', async () => {
			mockSuccessfulWorkflow();

			await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 123,
				issueTitle: 'Test Issue',
				documentPaths: [],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
			});

			expect(fs.mkdir).toHaveBeenCalledWith('/tmp/test-repo/.maestro/playbooks', {
				recursive: true,
			});
		});

		it('downloads external documents (isExternal: true)', async () => {
			const mockArrayBuffer = new ArrayBuffer(8);
			mockFetch.mockResolvedValueOnce({
				ok: true,
				arrayBuffer: vi.fn().mockResolvedValue(mockArrayBuffer),
			});

			mockSuccessfulWorkflow();

			await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 123,
				issueTitle: 'Test Issue',
				documentPaths: [
					{ name: 'external.md', path: 'https://example.com/external.md', isExternal: true },
				],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
			});

			expect(mockFetch).toHaveBeenCalledWith(
				'https://example.com/external.md',
				expect.objectContaining({ signal: expect.anything() })
			);
			expect(logger.info).toHaveBeenCalledWith(
				'Downloading external document',
				expect.any(String),
				expect.objectContaining({ name: 'external.md' })
			);
		});

		it('copies repo-internal documents (isExternal: false)', async () => {
			mockSuccessfulWorkflow();

			await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 123,
				issueTitle: 'Test Issue',
				documentPaths: [{ name: 'internal.md', path: 'docs/internal.md', isExternal: false }],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
			});

			expect(fs.copyFile).toHaveBeenCalledWith(
				'/tmp/test-repo/docs/internal.md',
				'/tmp/test-repo/.maestro/playbooks/internal.md'
			);
		});

		it('handles download failures without stopping', async () => {
			mockFetch.mockRejectedValueOnce(new Error('Download failed'));

			mockSuccessfulWorkflow();

			const result = await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 123,
				issueTitle: 'Test Issue',
				documentPaths: [{ name: 'fail.md', path: 'https://example.com/fail.md', isExternal: true }],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
			});

			// Should succeed overall despite download failure
			expect(result.success).toBe(true);
			expect(logger.warn).toHaveBeenCalledWith(
				'Failed to download document, skipping',
				expect.any(String),
				expect.objectContaining({ name: 'fail.md' })
			);
		});

		it('handles copy failures without stopping', async () => {
			vi.mocked(fs.copyFile).mockRejectedValueOnce(new Error('Copy failed'));

			mockSuccessfulWorkflow();

			const result = await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 123,
				issueTitle: 'Test Issue',
				documentPaths: [{ name: 'fail.md', path: 'docs/fail.md', isExternal: false }],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
			});

			// Should succeed overall despite copy failure
			expect(result.success).toBe(true);
			expect(logger.warn).toHaveBeenCalledWith(
				'Failed to copy document',
				expect.any(String),
				expect.objectContaining({ name: 'fail.md' })
			);
		});

		it('returns path to .maestro/playbooks directory', async () => {
			mockSuccessfulWorkflow();

			const result = await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 123,
				issueTitle: 'Test Issue',
				documentPaths: [],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
			});

			expect(result.autoRunPath).toBe('/tmp/test-repo/.maestro/playbooks');
		});
	});

	// ============================================================================
	// Start Contribution Integration Tests
	// ============================================================================

	describe('startContribution', () => {
		it('executes full workflow: clone, branch, commit, push, PR, docs', async () => {
			mockSuccessfulWorkflow();

			const result = await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 123,
				issueTitle: 'Test Issue',
				documentPaths: [],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
			});

			expect(result.success).toBe(true);

			// Verify all steps were called
			const calls = vi.mocked(execFileNoThrow).mock.calls;
			expect(calls[0][0]).toBe('git');
			expect(calls[0][1]).toContain('clone');
			expect(calls[1][1]).toContain('checkout');
			expect(calls[2][1]).toContain('config');
			expect(calls[3][1]).toContain('config');
			expect(calls[4][1]).toContain('commit');
			expect(calls[5][1]).toContain('push');
			expect(calls[6][0]).toBe('gh');
		});

		it('calls onStatusChange callback at each step', async () => {
			mockSuccessfulWorkflow();

			const onStatusChange = vi.fn();

			await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 123,
				issueTitle: 'Test Issue',
				documentPaths: [],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
				onStatusChange,
			});

			expect(onStatusChange).toHaveBeenCalledWith('cloning');
			expect(onStatusChange).toHaveBeenCalledWith('setting_up');
			expect(onStatusChange).toHaveBeenCalledWith('running');
		});

		it('cleans up on clone failure', async () => {
			vi.mocked(execFileNoThrow).mockResolvedValueOnce({
				stdout: '',
				stderr: 'clone failed',
				exitCode: 128,
			});

			await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 123,
				issueTitle: 'Test Issue',
				documentPaths: [],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
			});

			// Clone failure doesn't trigger cleanup (nothing to clean)
			expect(fs.rm).not.toHaveBeenCalled();
		});

		it('cleans up on branch creation failure', async () => {
			vi.mocked(execFileNoThrow)
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // clone
				.mockResolvedValueOnce({ stdout: '', stderr: 'branch failed', exitCode: 1 }); // checkout -b fails

			await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 123,
				issueTitle: 'Test Issue',
				documentPaths: [],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
			});

			expect(fs.rm).toHaveBeenCalledWith('/tmp/test-repo', { recursive: true, force: true });
		});

		it('cleans up on empty commit failure', async () => {
			vi.mocked(execFileNoThrow)
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // clone
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // checkout -b
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // config user.name
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // config user.email
				.mockResolvedValueOnce({ stdout: '', stderr: 'commit failed', exitCode: 1 }); // commit fails

			await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 123,
				issueTitle: 'Test Issue',
				documentPaths: [],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
			});

			expect(fs.rm).toHaveBeenCalledWith('/tmp/test-repo', { recursive: true, force: true });
		});

		it('cleans up on push failure', async () => {
			vi.mocked(execFileNoThrow)
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // clone
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // checkout -b
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // config user.name
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // config user.email
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // commit
				.mockResolvedValueOnce({ stdout: '', stderr: 'push failed', exitCode: 1 }); // push fails

			await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 123,
				issueTitle: 'Test Issue',
				documentPaths: [],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
			});

			expect(fs.rm).toHaveBeenCalledWith('/tmp/test-repo', { recursive: true, force: true });
		});

		it('cleans up on PR creation failure', async () => {
			vi.mocked(execFileNoThrow)
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // clone
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // checkout -b
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // config user.name
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // config user.email
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // commit
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // push
				.mockResolvedValueOnce({ stdout: '', stderr: 'pr create failed', exitCode: 1 }); // pr create fails

			await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 123,
				issueTitle: 'Test Issue',
				documentPaths: [],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
			});

			expect(fs.rm).toHaveBeenCalledWith('/tmp/test-repo', { recursive: true, force: true });
		});

		it('returns draftPrUrl, draftPrNumber, autoRunPath on success', async () => {
			mockSuccessfulWorkflow('https://github.com/owner/repo/pull/42');

			const result = await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 123,
				issueTitle: 'Test Issue',
				documentPaths: [],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
			});

			expect(result.success).toBe(true);
			expect(result.draftPrUrl).toBe('https://github.com/owner/repo/pull/42');
			expect(result.draftPrNumber).toBe(42);
			expect(result.autoRunPath).toBe('/tmp/test-repo/.maestro/playbooks');
		});

		it('handles unexpected errors gracefully', async () => {
			vi.mocked(execFileNoThrow)
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // clone
				.mockRejectedValueOnce(new Error('Unexpected error'));

			const result = await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 123,
				issueTitle: 'Test Issue',
				documentPaths: [],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
			});

			expect(result.success).toBe(false);
			expect(result.error).toBe('Unexpected error');
			expect(fs.rm).toHaveBeenCalledWith('/tmp/test-repo', { recursive: true, force: true });
		});
	});

	// ============================================================================
	// Finalize Contribution Tests
	// ============================================================================

	describe('finalizeContribution', () => {
		it('configures git user', async () => {
			mockFinalizeWorkflow();

			await finalizeContribution('/tmp/test-repo', 1, 123, 'Test Issue');

			expect(execFileNoThrow).toHaveBeenCalledWith(
				'git',
				['config', 'user.name', 'Maestro Symphony'],
				'/tmp/test-repo'
			);
			expect(execFileNoThrow).toHaveBeenCalledWith(
				'git',
				['config', 'user.email', 'symphony@runmaestro.ai'],
				'/tmp/test-repo'
			);
		});

		it('stages all changes with git add -A', async () => {
			mockFinalizeWorkflow();

			await finalizeContribution('/tmp/test-repo', 1, 123, 'Test Issue');

			expect(execFileNoThrow).toHaveBeenCalledWith('git', ['add', '-A'], '/tmp/test-repo');
		});

		it('creates commit with Symphony message', async () => {
			mockFinalizeWorkflow();

			await finalizeContribution('/tmp/test-repo', 1, 456, 'Test Issue Title');

			const commitCall = vi
				.mocked(execFileNoThrow)
				.mock.calls.find((call) => call[0] === 'git' && call[1]?.includes('commit'));
			expect(commitCall).toBeDefined();
			expect(commitCall![1]).toContain('-m');
			const messageIndex = commitCall![1].indexOf('-m');
			const message = commitCall![1][messageIndex + 1];
			expect(message).toContain('[Symphony] Complete contribution for #456');
			expect(message).toContain('Test Issue Title');
		});

		it('handles "nothing to commit" gracefully', async () => {
			vi.mocked(execFileNoThrow)
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // config user.name
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // config user.email
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // git add -A
				.mockResolvedValueOnce({ stdout: '', stderr: 'nothing to commit', exitCode: 1 }) // git commit (nothing to commit)
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // git push
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // gh pr ready
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // gh pr edit
				.mockResolvedValueOnce({
					stdout: 'https://github.com/owner/repo/pull/1',
					stderr: '',
					exitCode: 0,
				}); // gh pr view

			const result = await finalizeContribution('/tmp/test-repo', 1, 123, 'Test Issue');

			// Should continue despite nothing to commit
			expect(result.success).toBe(true);
		});

		it('pushes changes to remote', async () => {
			mockFinalizeWorkflow();

			await finalizeContribution('/tmp/test-repo', 1, 123, 'Test Issue');

			expect(execFileNoThrow).toHaveBeenCalledWith('git', ['push'], '/tmp/test-repo');
		});

		it('returns error on push failure', async () => {
			vi.mocked(execFileNoThrow)
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // config user.name
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // config user.email
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // git add -A
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // git commit
				.mockResolvedValueOnce({ stdout: '', stderr: 'push failed', exitCode: 1 }); // git push fails

			const result = await finalizeContribution('/tmp/test-repo', 1, 123, 'Test Issue');

			expect(result.success).toBe(false);
			expect(result.error).toContain('Push failed');
		});

		it('marks PR as ready using gh pr ready', async () => {
			mockFinalizeWorkflow('https://github.com/owner/repo/pull/42');

			await finalizeContribution('/tmp/test-repo', 42, 123, 'Test Issue');

			expect(execFileNoThrow).toHaveBeenCalledWith('gh', ['pr', 'ready', '42'], '/tmp/test-repo');
		});

		it('returns error on ready failure', async () => {
			vi.mocked(execFileNoThrow)
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // config user.name
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // config user.email
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // git add -A
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // git commit
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // git push
				.mockResolvedValueOnce({ stdout: '', stderr: 'ready failed', exitCode: 1 }); // gh pr ready fails

			const result = await finalizeContribution('/tmp/test-repo', 1, 123, 'Test Issue');

			expect(result.success).toBe(false);
			expect(result.error).toContain('Failed to mark PR ready');
		});

		it('updates PR body with completion summary', async () => {
			mockFinalizeWorkflow();

			await finalizeContribution('/tmp/test-repo', 1, 123, 'Test Issue');

			const editCall = vi
				.mocked(execFileNoThrow)
				.mock.calls.find((call) => call[0] === 'gh' && call[1]?.includes('edit'));
			expect(editCall).toBeDefined();
			expect(editCall![1]).toContain('--body');
		});

		it('returns final PR URL', async () => {
			mockFinalizeWorkflow('https://github.com/owner/repo/pull/99');

			const result = await finalizeContribution('/tmp/test-repo', 99, 123, 'Test Issue');

			expect(result.success).toBe(true);
			expect(result.prUrl).toBe('https://github.com/owner/repo/pull/99');
		});
	});

	// ============================================================================
	// Cancel Contribution Tests
	// ============================================================================

	describe('cancelContribution', () => {
		it('closes draft PR with gh pr close --delete-branch', async () => {
			vi.mocked(execFileNoThrow).mockResolvedValueOnce({
				stdout: '',
				stderr: '',
				exitCode: 0,
			});

			await cancelContribution('/tmp/test-repo', 42, true);

			expect(execFileNoThrow).toHaveBeenCalledWith(
				'gh',
				['pr', 'close', '42', '--delete-branch'],
				'/tmp/test-repo'
			);
		});

		it('returns failure when PR close fails', async () => {
			vi.mocked(execFileNoThrow).mockResolvedValueOnce({
				stdout: '',
				stderr: 'pr close failed',
				exitCode: 1,
			});

			const result = await cancelContribution('/tmp/test-repo', 42, true);

			expect(logger.warn).toHaveBeenCalledWith(
				'Failed to close PR',
				expect.any(String),
				expect.objectContaining({ prNumber: 42 })
			);
			expect(result.success).toBe(false);
			expect(result.error).toContain('pr close failed');
		});

		it('removes local directory when cleanup=true', async () => {
			vi.mocked(execFileNoThrow).mockResolvedValueOnce({
				stdout: '',
				stderr: '',
				exitCode: 0,
			});

			await cancelContribution('/tmp/test-repo', 42, true);

			expect(fs.rm).toHaveBeenCalledWith('/tmp/test-repo', { recursive: true, force: true });
		});

		it('preserves local directory when cleanup=false', async () => {
			vi.mocked(execFileNoThrow).mockResolvedValueOnce({
				stdout: '',
				stderr: '',
				exitCode: 0,
			});

			await cancelContribution('/tmp/test-repo', 42, false);

			expect(fs.rm).not.toHaveBeenCalled();
		});

		it('does not clean up local directory when PR close fails', async () => {
			vi.mocked(execFileNoThrow).mockResolvedValueOnce({
				stdout: '',
				stderr: 'error',
				exitCode: 1,
			});

			const result = await cancelContribution('/tmp/test-repo', 42, true);

			expect(result.success).toBe(false);
			expect(fs.rm).not.toHaveBeenCalled();
		});

		it('adds --repo flag without --delete-branch for fork contributions', async () => {
			vi.mocked(execFileNoThrow).mockResolvedValueOnce({
				stdout: '',
				stderr: '',
				exitCode: 0,
			});

			await cancelContribution('/tmp/test-repo', 42, true, 'upstream-owner/repo');

			expect(execFileNoThrow).toHaveBeenCalledWith(
				'gh',
				['pr', 'close', '42', '--repo', 'upstream-owner/repo'],
				'/tmp/test-repo'
			);
		});
	});

	// ============================================================================
	// Fork Support Tests
	// ============================================================================

	describe('fork support', () => {
		const defaultOptions = {
			contributionId: 'test-id',
			repoSlug: 'upstream-owner/repo',
			repoUrl: 'https://github.com/upstream-owner/repo.git',
			issueNumber: 42,
			issueTitle: 'Test Fork Issue',
			documentPaths: [],
			localPath: '/tmp/test-repo',
			branchName: 'symphony/test-branch',
		};

		describe('startContribution with fork', () => {
			it('calls ensureForkSetup after clone and branch creation', async () => {
				mockSuccessfulWorkflow();

				await startContribution(defaultOptions);

				expect(ensureForkSetup).toHaveBeenCalledWith('/tmp/test-repo', 'upstream-owner/repo');

				// Verify ensureForkSetup runs after checkout -b (2nd execFileNoThrow call)
				const checkoutOrder = vi.mocked(execFileNoThrow).mock.invocationCallOrder[1]; // checkout -b
				const forkSetupOrder = vi.mocked(ensureForkSetup).mock.invocationCallOrder[0];
				expect(forkSetupOrder).toBeGreaterThan(checkoutOrder);
			});

			it('returns fork info when ensureForkSetup detects a fork', async () => {
				vi.mocked(ensureForkSetup).mockResolvedValue({
					isFork: true,
					forkSlug: 'myuser/repo',
				});
				vi.mocked(execFileNoThrow)
					.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // clone
					.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // checkout -b
					.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // config user.name
					.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // config user.email
					.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // commit --allow-empty
					.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // push
					.mockResolvedValueOnce({ stdout: 'symphony/test-branch', stderr: '', exitCode: 0 }) // git rev-parse --abbrev-ref HEAD
					.mockResolvedValueOnce({
						stdout: 'https://github.com/upstream-owner/repo/pull/5',
						stderr: '',
						exitCode: 0,
					}); // pr create

				const result = await startContribution(defaultOptions);

				expect(result.success).toBe(true);
				expect(result.isFork).toBe(true);
				expect(result.forkSlug).toBe('myuser/repo');
			});

			it('passes --repo and --head to gh pr create for fork contributions', async () => {
				vi.mocked(ensureForkSetup).mockResolvedValue({
					isFork: true,
					forkSlug: 'myuser/repo',
				});
				vi.mocked(execFileNoThrow)
					.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // clone
					.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // checkout -b
					.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // config user.name
					.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // config user.email
					.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // commit --allow-empty
					.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // push
					.mockResolvedValueOnce({ stdout: 'symphony/test-branch', stderr: '', exitCode: 0 }) // git rev-parse --abbrev-ref HEAD
					.mockResolvedValueOnce({
						stdout: 'https://github.com/upstream-owner/repo/pull/5',
						stderr: '',
						exitCode: 0,
					}); // pr create

				await startContribution(defaultOptions);

				const prCreateCall = vi
					.mocked(execFileNoThrow)
					.mock.calls.find((call) => call[0] === 'gh' && call[1]?.includes('create'));
				expect(prCreateCall).toBeDefined();
				expect(prCreateCall![1]).toContain('--repo');
				expect(prCreateCall![1]).toContain('upstream-owner/repo');
				expect(prCreateCall![1]).toContain('--head');
				expect(prCreateCall![1]).toContain('myuser:symphony/test-branch');
			});

			it('cleans up and returns error when ensureForkSetup fails', async () => {
				vi.mocked(ensureForkSetup).mockResolvedValue({
					isFork: false,
					error: 'GitHub CLI not authenticated',
				});
				vi.mocked(execFileNoThrow)
					.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // clone
					.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }); // checkout -b

				const result = await startContribution(defaultOptions);

				expect(result.success).toBe(false);
				expect(result.error).toContain('Fork setup failed');
				expect(fs.rm).toHaveBeenCalledWith('/tmp/test-repo', { recursive: true, force: true });
			});

			it('does not pass --repo/--head for non-fork contributions', async () => {
				vi.mocked(ensureForkSetup).mockResolvedValue({ isFork: false });
				mockSuccessfulWorkflow();

				await startContribution(defaultOptions);

				const prCreateCall = vi
					.mocked(execFileNoThrow)
					.mock.calls.find((call) => call[0] === 'gh' && call[1]?.includes('create'));
				expect(prCreateCall).toBeDefined();
				expect(prCreateCall![1]).not.toContain('--repo');
				expect(prCreateCall![1]).not.toContain('--head');
			});
		});

		describe('finalizeContribution with fork', () => {
			it('adds --repo flag to gh pr ready, edit, and view for fork contributions', async () => {
				mockFinalizeWorkflow('https://github.com/upstream-owner/repo/pull/5');

				await finalizeContribution('/tmp/test-repo', 5, 42, 'Test Issue', 'upstream-owner/repo');

				const readyCall = vi
					.mocked(execFileNoThrow)
					.mock.calls.find((call) => call[0] === 'gh' && call[1]?.includes('ready'));
				expect(readyCall![1]).toContain('--repo');
				expect(readyCall![1]).toContain('upstream-owner/repo');

				const editCall = vi
					.mocked(execFileNoThrow)
					.mock.calls.find((call) => call[0] === 'gh' && call[1]?.includes('edit'));
				expect(editCall![1]).toContain('--repo');
				expect(editCall![1]).toContain('upstream-owner/repo');

				const viewCall = vi
					.mocked(execFileNoThrow)
					.mock.calls.find((call) => call[0] === 'gh' && call[1]?.includes('view'));
				expect(viewCall![1]).toContain('--repo');
				expect(viewCall![1]).toContain('upstream-owner/repo');
			});

			it('does not add --repo flag when upstreamSlug is not provided', async () => {
				mockFinalizeWorkflow();

				await finalizeContribution('/tmp/test-repo', 1, 123, 'Test Issue');

				const readyCall = vi
					.mocked(execFileNoThrow)
					.mock.calls.find((call) => call[0] === 'gh' && call[1]?.includes('ready'));
				expect(readyCall![1]).not.toContain('--repo');
			});
		});

		describe('cancelContribution with fork', () => {
			it('does not add --repo flag when upstreamSlug is not provided', async () => {
				vi.mocked(execFileNoThrow).mockResolvedValueOnce({
					stdout: '',
					stderr: '',
					exitCode: 0,
				});

				await cancelContribution('/tmp/test-repo', 42, true);

				expect(execFileNoThrow).toHaveBeenCalledWith(
					'gh',
					['pr', 'close', '42', '--delete-branch'],
					'/tmp/test-repo'
				);
			});
		});
	});
});

// ============================================================================
// Managed repository gate (MRC-09-05)
// ============================================================================

describe('Symphony Runner under a managed repository gate (MRC-09-05)', () => {
	const successfulStart = (prUrl = 'https://github.com/owner/repo/pull/1') => {
		vi.mocked(execFileNoThrow)
			.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // clone
			.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // checkout -b
			.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // config user.name
			.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // config user.email
			.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // commit --allow-empty
			.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // push
			.mockResolvedValueOnce({ stdout: prUrl, stderr: '', exitCode: 0 }); // pr create
	};
	const successfulFinalize = (prUrl = 'https://github.com/owner/repo/pull/1') => {
		vi.mocked(execFileNoThrow)
			.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // config user.name
			.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // config user.email
			.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // git add -A
			.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // git commit
			.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // git push
			.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // gh pr ready
			.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // gh pr edit
			.mockResolvedValueOnce({ stdout: prUrl, stderr: '', exitCode: 0 }); // gh pr view
	};

	type Request = RepositoryEffectRequest;
	type Decision = RepositoryEffectDecision;

	const okExec = { stdout: '', stderr: '', exitCode: 0 };
	const actor: RepositoryEffectActor = {
		kind: 'transport',
		actor: { peer: 'web-login', username: 'ada' },
	};

	/** A ceiling double: refuses the named effects by code, admits the rest with a receipt. */
	function authority(refuse: Partial<Record<Request['effect'], string>> = {}) {
		const requests: Request[] = [];
		return {
			requests,
			authorize(request: Request): Decision {
				requests.push(request);
				const receipt = {
					policyRevision: 7,
					surface: request.surface,
					actor: 'ada',
					effect: request.effect,
					repository: request.repository,
					remote: request.remote,
					outcome: 'within-ceiling' as const,
				};
				const code = refuse[request.effect];
				if (!code) return { allowed: true, managed: receipt };
				return {
					allowed: false,
					code: code as never,
					message: `no ${request.effect} for ada`,
					managed: { ...receipt, outcome: code as never },
				};
			},
		};
	}

	const startOptions = (gate: SymphonyRepositoryGate) => ({
		contributionId: 'contrib-1',
		repoSlug: 'acme/widgets',
		repoUrl: 'https://github.com/acme/widgets',
		issueNumber: 12,
		issueTitle: 'Fix widgets',
		documentPaths: [],
		localPath: '/tmp/managed-repo',
		branchName: 'symphony/issue-12',
		gate,
	});

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(fs.mkdir).mockResolvedValue(undefined);
		vi.mocked(fs.rm).mockResolvedValue(undefined);
		vi.mocked(ensureForkSetup).mockResolvedValue({ isFork: false });
	});

	it('runs byte-for-byte standalone with a null authority: no receipts, two-argument fork setup', async () => {
		successfulStart();

		const result = await startContribution(startOptions({ authority: null }));

		expect(result.success).toBe(true);
		expect('managed' in result).toBe(false);
		expect(ensureForkSetup).toHaveBeenCalledWith('/tmp/managed-repo', 'acme/widgets');
	});

	it('holds every effect in order before it runs and returns the receipts', async () => {
		successfulStart();
		const auth = authority();

		const result = await startContribution(startOptions({ authority: auth, actor }));

		expect(result.success).toBe(true);
		expect(auth.requests.map((r) => [r.effect, r.resource, r.repository, r.remote])).toEqual([
			['clone', 'remote', 'acme/widgets', 'https://github.com/acme/widgets'],
			['branch', 'local', 'acme/widgets', null],
			['commit', 'local', 'acme/widgets', null],
			['push', 'remote', 'acme/widgets', 'https://github.com/acme/widgets'],
			['pull-request', 'remote', 'acme/widgets', 'https://github.com/acme/widgets'],
		]);
		expect(auth.requests.every((r) => r.surface === 'symphony-runner' && r.actor === actor)).toBe(
			true
		);
		expect(result.managed?.map((r) => r.effect)).toEqual([
			'clone',
			'branch',
			'commit',
			'push',
			'pull-request',
		]);
	});

	it('refuses the clone before anything runs, with nothing to clean up', async () => {
		const auth = authority({ clone: 'outside-ceiling' });

		const result = await startContribution(startOptions({ authority: auth, actor }));

		expect(result).toEqual({
			success: false,
			error: '[managed-outside-ceiling] no clone for ada',
			managed: [expect.objectContaining({ effect: 'clone', outcome: 'outside-ceiling' })],
		});
		expect(execFileNoThrow).not.toHaveBeenCalled();
		expect(fs.rm).not.toHaveBeenCalled();
	});

	it('refuses the push after the clone, removes the clone and never pushes or opens a PR', async () => {
		vi.mocked(execFileNoThrow).mockResolvedValue(okExec);
		const auth = authority({ push: 'remote-denied' });

		const result = await startContribution(startOptions({ authority: auth, actor }));

		expect(result.success).toBe(false);
		expect(result.error).toBe('[managed-remote-denied] no push for ada');
		expect(result.managed?.at(-1)).toMatchObject({ effect: 'push', outcome: 'remote-denied' });
		const commands = vi.mocked(execFileNoThrow).mock.calls.map((call) => call[1]);
		expect(commands).not.toContainEqual(expect.arrayContaining(['push']));
		expect(commands).not.toContainEqual(expect.arrayContaining(['pr']));
		expect(fs.rm).toHaveBeenCalledWith('/tmp/managed-repo', { recursive: true, force: true });
	});

	it('refuses the draft PR after the push and names it by code, not as a gh failure', async () => {
		vi.mocked(execFileNoThrow).mockResolvedValue(okExec);
		const auth = authority({ 'pull-request': 'outside-ceiling' });

		const result = await startContribution(startOptions({ authority: auth, actor }));

		expect(result.error).toBe('[managed-outside-ceiling] no pull-request for ada');
		const commands = vi.mocked(execFileNoThrow).mock.calls.map((call) => call[1]);
		expect(commands).toContainEqual(['push', '-u', 'origin', 'symphony/issue-12']);
		expect(commands).not.toContainEqual(expect.arrayContaining(['pr', 'create']));
	});

	it('holds the fork where it happens and the push against the fork, when one is set up', async () => {
		successfulStart();
		const auth = authority();
		vi.mocked(ensureForkSetup).mockImplementation(async (_path, _slug, options) => {
			const refusal = await options?.beforeFork?.();
			return refusal
				? { isFork: false, error: refusal }
				: { isFork: true, forkSlug: 'ada/widgets' };
		});

		const result = await startContribution(startOptions({ authority: auth, actor }));

		expect(result).toMatchObject({ success: true, isFork: true, forkSlug: 'ada/widgets' });
		expect(auth.requests.map((r) => [r.effect, r.remote])).toEqual([
			['clone', 'https://github.com/acme/widgets'],
			['branch', null],
			['fork', 'https://github.com/acme/widgets'],
			['commit', null],
			['push', 'https://github.com/ada/widgets.git'],
			['pull-request', 'https://github.com/acme/widgets'],
		]);
	});

	it('refuses the fork before it is created and reports the managed refusal, not a fork failure', async () => {
		vi.mocked(execFileNoThrow).mockResolvedValue(okExec);
		const auth = authority({ fork: 'outside-ceiling' });
		vi.mocked(ensureForkSetup).mockImplementation(async (_path, _slug, options) => {
			const refusal = await options?.beforeFork?.();
			return refusal
				? { isFork: false, error: refusal }
				: { isFork: true, forkSlug: 'ada/widgets' };
		});

		const result = await startContribution(startOptions({ authority: auth, actor }));

		expect(result).toEqual({
			success: false,
			error: '[managed-outside-ceiling] no fork for ada',
			managed: expect.arrayContaining([
				expect.objectContaining({ effect: 'fork', outcome: 'outside-ceiling' }),
			]),
		});
		expect(fs.rm).toHaveBeenCalledWith('/tmp/managed-repo', { recursive: true, force: true });
		const commands = vi.mocked(execFileNoThrow).mock.calls.map((call) => call[1]);
		expect(commands).not.toContainEqual(expect.arrayContaining(['commit']));
	});

	it('binds the actor to the transport of the call when the gate names none', async () => {
		successfulStart();
		const auth = authority();

		await startContribution(startOptions({ authority: auth }));

		expect(auth.requests[0].actor).toEqual({ kind: 'transport', actor: { peer: 'in-process' } });
	});

	describe('finalizeContribution', () => {
		it('reads origin, holds commit, push and finalize, and returns the receipts', async () => {
			vi.mocked(execFileNoThrow)
				.mockResolvedValueOnce({
					stdout: 'https://github.com/ada/widgets.git\n',
					stderr: '',
					exitCode: 0,
				}) // remote get-url origin
				.mockResolvedValueOnce(okExec) // config user.name
				.mockResolvedValueOnce(okExec) // config user.email
				.mockResolvedValueOnce(okExec) // add -A
				.mockResolvedValueOnce(okExec) // commit
				.mockResolvedValueOnce(okExec) // push
				.mockResolvedValueOnce(okExec) // pr ready
				.mockResolvedValueOnce(okExec) // pr edit
				.mockResolvedValueOnce({
					stdout: 'https://github.com/acme/widgets/pull/9',
					stderr: '',
					exitCode: 0,
				}); // pr view
			const auth = authority();

			const result = await finalizeContribution(
				'/tmp/managed-repo',
				9,
				12,
				'Fix widgets',
				'acme/widgets',
				{ authority: auth, actor }
			);

			expect(result).toEqual({
				success: true,
				prUrl: 'https://github.com/acme/widgets/pull/9',
				managed: [
					expect.objectContaining({ effect: 'commit', repository: 'acme/widgets', remote: null }),
					expect.objectContaining({
						effect: 'push',
						repository: 'acme/widgets',
						remote: 'https://github.com/ada/widgets.git',
					}),
					expect.objectContaining({ effect: 'finalize', repository: 'acme/widgets' }),
				],
			});
			expect(vi.mocked(execFileNoThrow).mock.calls[0][1]).toEqual(['remote', 'get-url', 'origin']);
		});

		it('names the repository from origin when no upstream slug is given', async () => {
			vi.mocked(execFileNoThrow).mockResolvedValue({
				stdout: 'git@github.com:acme/widgets.git\n',
				stderr: '',
				exitCode: 0,
			});
			const auth = authority();

			await finalizeContribution('/tmp/managed-repo', 9, 12, 'Fix widgets', undefined, {
				authority: auth,
				actor,
			});

			expect(auth.requests[0]).toMatchObject({ effect: 'commit', repository: 'acme/widgets' });
			expect(auth.requests[1]).toMatchObject({
				effect: 'push',
				remote: 'git@github.com:acme/widgets.git',
			});
		});

		it('refuses the finalize after the push and never marks the PR ready', async () => {
			vi.mocked(execFileNoThrow).mockResolvedValue(okExec);
			const auth = authority({ finalize: 'outside-ceiling' });

			const result = await finalizeContribution(
				'/tmp/managed-repo',
				9,
				12,
				'Fix widgets',
				'acme/widgets',
				{ authority: auth, actor }
			);

			expect(result.success).toBe(false);
			expect(result.error).toBe('[managed-outside-ceiling] no finalize for ada');
			const commands = vi.mocked(execFileNoThrow).mock.calls.map((call) => call[1]);
			expect(commands).toContainEqual(['push']);
			expect(commands).not.toContainEqual(expect.arrayContaining(['pr', 'ready']));
		});

		it('refuses the push before it runs, after the local commit', async () => {
			vi.mocked(execFileNoThrow).mockResolvedValue(okExec);
			const auth = authority({ push: 'remote-denied' });

			const result = await finalizeContribution(
				'/tmp/managed-repo',
				9,
				12,
				'Fix widgets',
				'acme/widgets',
				{ authority: auth, actor }
			);

			expect(result.error).toBe('[managed-remote-denied] no push for ada');
			const commands = vi.mocked(execFileNoThrow).mock.calls.map((call) => call[1]);
			expect(commands).not.toContainEqual(['push']);
			expect(commands).toContainEqual(['add', '-A']);
		});

		it('does not read origin with a null authority', async () => {
			successfulFinalize();

			const result = await finalizeContribution(
				'/tmp/managed-repo',
				9,
				12,
				'Fix widgets',
				undefined,
				{ authority: null }
			);

			expect(result.success).toBe(true);
			expect('managed' in result).toBe(false);
			expect(vi.mocked(execFileNoThrow).mock.calls[0][1]).toEqual([
				'config',
				'user.name',
				'Maestro Symphony',
			]);
		});
	});

	describe('cancelContribution', () => {
		it('holds the cancel against origin before gh pr close', async () => {
			vi.mocked(execFileNoThrow)
				.mockResolvedValueOnce({
					stdout: 'https://github.com/acme/widgets.git\n',
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce(okExec);
			const auth = authority();

			const result = await cancelContribution('/tmp/managed-repo', 9, true, undefined, {
				authority: auth,
				actor,
			});

			expect(result).toEqual({
				success: true,
				managed: [
					expect.objectContaining({
						effect: 'cancel',
						repository: 'acme/widgets',
						remote: 'https://github.com/acme/widgets.git',
					}),
				],
			});
			expect(auth.requests[0].resource).toBe('remote');
			expect(vi.mocked(execFileNoThrow).mock.calls[1][1]).toEqual([
				'pr',
				'close',
				'9',
				'--delete-branch',
			]);
			expect(fs.rm).toHaveBeenCalledWith('/tmp/managed-repo', { recursive: true, force: true });
		});

		it('refuses the cancel and leaves the PR and the clone alone', async () => {
			vi.mocked(execFileNoThrow).mockResolvedValue(okExec);
			const auth = authority({ cancel: 'outside-ceiling' });

			const result = await cancelContribution('/tmp/managed-repo', 9, true, 'acme/widgets', {
				authority: auth,
				actor,
			});

			expect(result).toEqual({
				success: false,
				error: '[managed-outside-ceiling] no cancel for ada',
				managed: [expect.objectContaining({ effect: 'cancel', outcome: 'outside-ceiling' })],
			});
			const commands = vi.mocked(execFileNoThrow).mock.calls.map((call) => call[1]);
			expect(commands).not.toContainEqual(expect.arrayContaining(['pr', 'close']));
			expect(fs.rm).not.toHaveBeenCalled();
		});
	});
});

// ============================================================================
// The real repository ceiling over a local fixture (MRC-09-07)
// ============================================================================

describe('Symphony Runner over the real repository ceiling (MRC-09-07)', () => {
	const okExec = { stdout: '', stderr: '', exitCode: 0 };
	/** The local fixture: a bare repository on this disk, the only remote the ceiling admits. */
	const LOCAL_REMOTE = '/tmp/remotes/acme/widgets.git';
	const LOCAL_PATH = '/tmp/managed-local';
	const identity = (read: object) => read as unknown as IdentityRead;
	const enrolled = identity({ status: 'ok', record: { registration: { actorId: 'actor-1' } } });
	const unregistered = identity({ status: 'ok', record: {} });
	const neverEnrolled = identity({ status: 'none' });
	const device = { kind: 'lite' as const, deviceId: 'dev-1', deviceName: 'Phone' };

	/** A ceiling admitting the operator (and a paired device) the named effects, against acme/* over a local remote only. */
	const localCeiling = (effects: readonly RepositoryEffectKind[] = REPOSITORY_EFFECTS) => ({
		policyRevision: 3,
		actors: [
			{ actor: 'operator', effects: [...effects] },
			{ actor: 'lite-device', effects: [...REPOSITORY_EFFECTS] },
		],
		repositories: { allow: ['acme/*'] },
		remotes: { allow: ['file:'] },
	});

	/** The desktop's composition: one source reading the identity and the applied revision live, per call. */
	function ceiling(options: { read?: IdentityRead; install?: unknown } = {}) {
		const state = { read: options.read ?? enrolled, revision: 3 as number | null };
		const source = createRepositoryPolicySource({
			identity: { read: () => state.read },
			policy: () => (state.revision === null ? null : { appliedRevision: state.revision }),
		});
		if (options.install !== undefined) {
			const outcome = source.install(options.install);
			if (!outcome.installed) throw new Error(outcome.problems.join('; '));
		}
		return { source, state };
	}

	const startOptions = (authority: RepositoryEffectAuthority | null, repoUrl = LOCAL_REMOTE) => ({
		contributionId: 'contrib-7',
		repoSlug: 'acme/widgets',
		repoUrl,
		issueNumber: 12,
		issueTitle: 'Fix widgets',
		documentPaths: [],
		localPath: LOCAL_PATH,
		branchName: 'symphony/issue-12',
		gate: { authority },
	});

	/** Every command the sinks issued: the binary first, then its arguments. */
	const commandsRun = () =>
		vi.mocked(execFileNoThrow).mock.calls.map((call) => [call[0], ...(call[1] ?? [])]);
	const ran = (...prefix: string[]) =>
		commandsRun().some((command) => prefix.every((word, index) => command[index] === word));
	/** Origin points at the local fixture; everything else succeeds. */
	function originIsLocal() {
		vi.mocked(execFileNoThrow).mockImplementation(async (_command, args) =>
			args?.[0] === 'remote' && args[1] === 'get-url'
				? { stdout: `${LOCAL_REMOTE}\n`, stderr: '', exitCode: 0 }
				: okExec
		);
	}

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(execFileNoThrow).mockReset();
		vi.mocked(execFileNoThrow).mockResolvedValue(okExec);
		vi.mocked(fs.mkdir).mockResolvedValue(undefined);
		vi.mocked(fs.rm).mockResolvedValue(undefined);
		vi.mocked(ensureForkSetup).mockReset();
		vi.mocked(ensureForkSetup).mockResolvedValue({ isFork: false });
	});

	it('admits the whole start over the local fixture, one receipt per effect naming file: and never the path', async () => {
		const { source } = ceiling({ install: localCeiling() });

		const result = await startContribution(startOptions(source));

		expect(result.success).toBe(true);
		const shape = (r: NonNullable<typeof result.managed>[number]) =>
			[r.effect, r.remote, r.outcome, r.policyRevision, r.actor, r.repository, r.surface].join(' ');
		expect(result.managed?.map(shape)).toEqual([
			'clone file: within-ceiling 3 the operator acme/widgets symphony-runner',
			'branch  within-ceiling 3 the operator acme/widgets symphony-runner',
			'commit  within-ceiling 3 the operator acme/widgets symphony-runner',
			'push file: within-ceiling 3 the operator acme/widgets symphony-runner',
			'pull-request file: within-ceiling 3 the operator acme/widgets symphony-runner',
		]);
		expect(JSON.stringify(result.managed)).not.toContain('/tmp/remotes');
		expect(ran('git', 'clone', '--depth=1', LOCAL_REMOTE, LOCAL_PATH)).toBe(true);
		expect(ran('git', 'push', '-u', 'origin', 'symphony/issue-12')).toBe(true);
		expect(ran('gh', 'pr', 'create', '--draft')).toBe(true);
		expect(fs.rm).not.toHaveBeenCalled();
	});

	it('admits the finalization and the cancel against the origin the clone points at, the local fixture', async () => {
		const { source } = ceiling({ install: localCeiling() });
		originIsLocal();

		const finalized = await finalizeContribution(LOCAL_PATH, 9, 12, 'Fix widgets', undefined, {
			authority: source,
		});

		expect(finalized.success).toBe(true);
		expect(finalized.managed?.map((r) => [r.effect, r.repository, r.remote, r.outcome])).toEqual([
			['commit', 'acme/widgets', null, 'within-ceiling'],
			['push', 'acme/widgets', 'file:', 'within-ceiling'],
			['finalize', 'acme/widgets', 'file:', 'within-ceiling'],
		]);
		expect(ran('gh', 'pr', 'ready', '9')).toBe(true);

		vi.mocked(execFileNoThrow).mockClear();
		const cancelled = await cancelContribution(LOCAL_PATH, 9, true, undefined, {
			authority: source,
		});

		expect(cancelled).toEqual({
			success: true,
			managed: [
				expect.objectContaining({ effect: 'cancel', remote: 'file:', outcome: 'within-ceiling' }),
			],
		});
		expect(ran('gh', 'pr', 'close', '9')).toBe(true);
		expect(fs.rm).toHaveBeenCalledWith(LOCAL_PATH, { recursive: true, force: true });
	});

	it('refuses a remote and a repository outside the local fixture before the clone, by name', async () => {
		const { source } = ceiling({ install: localCeiling() });

		const remote = await startContribution(
			startOptions(source, 'https://token@github.com/acme/widgets.git')
		);

		expect(remote).toEqual({
			success: false,
			error: '[managed-remote-denied] the repository ceiling does not admit https://github.com',
			managed: [
				expect.objectContaining({
					effect: 'clone',
					remote: 'https://github.com',
					outcome: 'remote-denied',
				}),
			],
		});
		expect(JSON.stringify(remote.managed)).not.toContain('token');

		const repository = await startContribution({
			...startOptions(source),
			repoSlug: 'other/widgets',
		});

		expect(repository.error).toBe(
			'[managed-repository-denied] the repository ceiling does not admit other/widgets'
		);
		expect(execFileNoThrow).not.toHaveBeenCalled();
		expect(fs.rm).not.toHaveBeenCalled();
	});

	it('holds each effect by itself: the admitted clone is no permit for a push the ceiling omits', async () => {
		const { source } = ceiling({
			install: localCeiling(['clone', 'branch', 'commit', 'pull-request']),
		});

		const result = await startContribution(startOptions(source));

		expect(result.success).toBe(false);
		expect(result.error).toBe(
			'[managed-outside-ceiling] the repository ceiling admits no push effect for the operator'
		);
		expect(result.managed?.map((r) => [r.effect, r.outcome])).toEqual([
			['clone', 'within-ceiling'],
			['branch', 'within-ceiling'],
			['commit', 'within-ceiling'],
			['push', 'outside-ceiling'],
		]);
		expect(ran('git', 'clone')).toBe(true);
		expect(ran('git', 'commit', '--allow-empty')).toBe(true);
		expect(ran('git', 'push')).toBe(false);
		expect(ran('gh')).toBe(false);
		expect(fs.rm).toHaveBeenCalledWith(LOCAL_PATH, { recursive: true, force: true });
	});

	it('refuses the draft PR after the push, by name, and removes the clone', async () => {
		const { source } = ceiling({
			install: localCeiling(['clone', 'branch', 'commit', 'push']),
		});

		const result = await startContribution(startOptions(source));

		expect(result.error).toBe(
			'[managed-outside-ceiling] the repository ceiling admits no pull-request effect for the operator'
		);
		expect(ran('git', 'push', '-u', 'origin', 'symphony/issue-12')).toBe(true);
		expect(ran('gh')).toBe(false);
		expect(result.managed?.at(-1)).toMatchObject({
			effect: 'pull-request',
			outcome: 'outside-ceiling',
		});
		expect(fs.rm).toHaveBeenCalledWith(LOCAL_PATH, { recursive: true, force: true });
	});

	it('refuses the finalization before gh pr ready and leaves the draft a draft', async () => {
		const { source } = ceiling({
			install: localCeiling(['clone', 'branch', 'commit', 'push', 'pull-request']),
		});
		originIsLocal();

		const result = await finalizeContribution(LOCAL_PATH, 9, 12, 'Fix widgets', 'acme/widgets', {
			authority: source,
		});

		expect(result).toEqual({
			success: false,
			error:
				'[managed-outside-ceiling] the repository ceiling admits no finalize effect for the operator',
			managed: [
				expect.objectContaining({ effect: 'commit', outcome: 'within-ceiling' }),
				expect.objectContaining({ effect: 'push', outcome: 'within-ceiling' }),
				expect.objectContaining({ effect: 'finalize', outcome: 'outside-ceiling' }),
			],
		});
		expect(ran('git', 'push')).toBe(true);
		expect(ran('gh')).toBe(false);
	});

	it('refuses the fork where it happens and reports the ceiling, never a fork or a login failure', async () => {
		const { source } = ceiling({
			install: localCeiling(['clone', 'branch', 'commit', 'push', 'pull-request']),
		});
		vi.mocked(ensureForkSetup).mockImplementation(async (_path, _slug, options) => {
			const refusal = await options?.beforeFork?.();
			return refusal
				? { isFork: false, error: refusal }
				: { isFork: true, forkSlug: 'ada/widgets' };
		});

		const result = await startContribution(startOptions(source));

		expect(result.error).toBe(
			'[managed-outside-ceiling] the repository ceiling admits no fork effect for the operator'
		);
		expect(result.error).not.toMatch(/^Fork setup failed/);
		expect(isGitHubAuthError({ message: result.error, stderr: '' })).toBe(false);
		expect(result.managed?.at(-1)).toMatchObject({ effect: 'fork', outcome: 'outside-ceiling' });
		expect(ran('git', 'commit')).toBe(false);
		expect(fs.rm).toHaveBeenCalledWith(LOCAL_PATH, { recursive: true, force: true });
	});

	it('never answers a refusal as an authentication failure a login would fix', async () => {
		const cases: Array<{
			code: string;
			install?: unknown;
			options?: Partial<ReturnType<typeof startOptions>>;
		}> = [
			{ code: 'unavailable' },
			{ code: 'outside-ceiling', install: localCeiling(['branch']) },
			{ code: 'repository-unknown', install: localCeiling(), options: { repoSlug: '' } },
			{ code: 'repository-denied', install: localCeiling(), options: { repoSlug: 'acme-x/w' } },
			{ code: 'remote-unknown', install: localCeiling(), options: { repoUrl: 'widgets' } },
			{
				code: 'remote-denied',
				install: localCeiling(),
				options: { repoUrl: 'git@github.com:acme/widgets.git' },
			},
		];
		for (const scenario of cases) {
			vi.mocked(execFileNoThrow).mockClear();
			const { source } = ceiling({ install: scenario.install });

			const result = await startContribution({ ...startOptions(source), ...scenario.options });

			expect(result.success, scenario.code).toBe(false);
			expect(result.error, scenario.code).toMatch(new RegExp(`^\\[managed-${scenario.code}\\] `));
			expect(result.managed?.at(-1)?.outcome, scenario.code).toBe(scenario.code);
			expect(result.error, scenario.code).not.toBe('GitHub CLI not authenticated');
			expect(result.error, scenario.code).not.toMatch(/gh auth|log ?in|logged|credential/i);
			expect(isGitHubAuthError({ message: result.error, stderr: '' }), scenario.code).toBe(false);
			expect(isGitHubMissingScopeError({ message: result.error }), scenario.code).toBe(false);
			expect(execFileNoThrow, scenario.code).not.toHaveBeenCalled();
			expect(ensureForkSetup, scenario.code).not.toHaveBeenCalled();
		}
	});

	it('binds the actor to the admitting transport: a paired device is held as itself, registered or not', async () => {
		const { source, state } = ceiling({ install: localCeiling() });

		const registered = await runAsTransport(device, () => startContribution(startOptions(source)));

		expect(registered.success).toBe(true);
		expect(registered.managed?.[0]).toMatchObject({
			effect: 'clone',
			actor: 'lite-device:dev-1',
			outcome: 'within-ceiling',
		});

		state.read = unregistered;
		vi.mocked(execFileNoThrow).mockClear();
		const unbound = await runAsTransport(device, () => startContribution(startOptions(source)));

		expect(unbound.error).toMatch(/^\[managed-unauthenticated\] a paired Lite device \(dev-1\)/);
		expect(unbound.error).toContain('registered enterprise actor');
		expect(isGitHubAuthError({ message: unbound.error, stderr: '' })).toBe(false);
		expect(execFileNoThrow).not.toHaveBeenCalled();
	});

	it('refuses an enrolled host with no ceiling before the clone, and holds a host never enrolled to nothing', async () => {
		const { source } = ceiling();

		const refused = await startContribution(startOptions(source));

		expect(refused.error).toBe(
			'[managed-unavailable] the managed repository ceiling is unavailable (no repository ceiling is installed for policy revision 3)'
		);
		expect(execFileNoThrow).not.toHaveBeenCalled();

		const standalone = ceiling({ read: neverEnrolled, install: localCeiling() }).source;
		const result = await startContribution(
			startOptions(standalone, 'https://github.com/acme/widgets')
		);

		expect(result.success).toBe(true);
		expect('managed' in result).toBe(false);
		const forkCall = vi.mocked(ensureForkSetup).mock.calls[0];
		expect(forkCall.slice(0, 2)).toEqual([LOCAL_PATH, 'acme/widgets']);
		await expect(forkCall[2]?.beforeFork?.()).resolves.toBeNull();
	});

	it('a policy move between the clone and the push ends the contribution by name', async () => {
		const { source, state } = ceiling({ install: localCeiling() });
		vi.mocked(execFileNoThrow).mockImplementation(async (_command, args) => {
			if (args?.[0] === 'commit') state.revision = 4;
			return okExec;
		});

		const result = await startContribution(startOptions(source));

		expect(result.error).toBe(
			'[managed-unavailable] the managed repository ceiling is unavailable (the installed repository ceiling is for policy revision 3; this host is under revision 4)'
		);
		expect(result.managed?.map((r) => [r.effect, r.policyRevision, r.outcome])).toEqual([
			['clone', 3, 'within-ceiling'],
			['branch', 3, 'within-ceiling'],
			['commit', 3, 'within-ceiling'],
			['push', 4, 'unavailable'],
		]);
		expect(ran('git', 'push')).toBe(false);
		expect(fs.rm).toHaveBeenCalledWith(LOCAL_PATH, { recursive: true, force: true });
	});
});
