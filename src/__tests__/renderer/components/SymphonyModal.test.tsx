/**
 * Tests for SymphonyModal pre-flight check dialog
 *
 * Tests the gh CLI verification flow that gates Symphony contribution start:
 * - Loading state while checking gh CLI
 * - Blocking error when gh is not installed
 * - Blocking error when gh is not authenticated
 * - Proceeding to build tools warning when gh is OK
 * - Agent creation: the host admits the agent before any repository step
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, renderHook, screen, fireEvent, waitFor, act } from '@testing-library/react';
import SymphonyModal from '../../../renderer/components/SymphonyModal';
import type { SymphonyModalProps } from '../../../renderer/components/SymphonyModal';
import type { Theme } from '../../../renderer/types';
import { useSymphonyContribution } from '../../../renderer/hooks/symphony/useSymphonyContribution';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import type {
	RegisteredRepository,
	SymphonyIssue,
	SymphonyCategory,
} from '../../../shared/symphony-types';

// ============================================================================
// Mocks
// ============================================================================

const mockRegisterLayer = vi.fn(() => 'layer-123');
const mockUnregisterLayer = vi.fn();
const mockUpdateLayerHandler = vi.fn();

vi.mock('../../../renderer/contexts/LayerStackContext', () => ({
	useLayerStack: () => ({
		registerLayer: mockRegisterLayer,
		unregisterLayer: mockUnregisterLayer,
		updateLayerHandler: mockUpdateLayerHandler,
	}),
}));

// The dialog's own behavior is tested in AgentCreationDialog.test.tsx; here it
// records its props so a test can drive onCreateAgent (MCOMP-23-04B).
const dialogProps = vi.hoisted(() => ({
	current: null as null | {
		onCreateAgent: (
			config: import('../../../renderer/components/AgentCreationDialog').AgentCreationConfig
		) => Promise<import('../../../renderer/components/AgentCreationDialog').AgentCreationResult>;
	},
}));
vi.mock('../../../renderer/components/AgentCreationDialog', () => ({
	AgentCreationDialog: (props: { isOpen: boolean; onCreateAgent: never }) => {
		dialogProps.current = props;
		return props.isOpen ? <div data-testid="agent-creation-dialog" /> : null;
	},
}));

vi.mock('../../../renderer/utils/markdownConfig', () => ({
	REMARK_GFM_PLUGINS: [],
	generateProseStyles: () => '',
	createMarkdownComponents: () => ({}),
}));

vi.mock('../../../renderer/utils/shortcutFormatter', () => ({
	formatShortcutKeys: (keys: string[]) => keys.join('+'),
}));

vi.mock('react-markdown', () => ({
	default: ({ children }: { children: string }) => <div>{children}</div>,
}));

vi.mock('remark-gfm', () => ({
	default: () => null,
}));

// Mock lucide-react icons
vi.mock('lucide-react', () => {
	const icon = (name: string) => {
		const Component = ({ className, style, ...props }: Record<string, unknown>) => (
			<svg
				data-testid={`icon-${name}`}
				className={className as string}
				style={style as React.CSSProperties}
				{...props}
			/>
		);
		Component.displayName = name;
		return Component;
	};
	return {
		Music: icon('Music'),
		RefreshCw: icon('RefreshCw'),
		X: icon('X'),
		Search: icon('Search'),
		Loader2: icon('Loader2'),
		ArrowLeft: icon('ArrowLeft'),
		ExternalLink: icon('ExternalLink'),
		GitBranch: icon('GitBranch'),
		GitPullRequest: icon('GitPullRequest'),
		GitMerge: icon('GitMerge'),
		Clock: icon('Clock'),
		Zap: icon('Zap'),
		Play: icon('Play'),
		Pause: icon('Pause'),
		AlertCircle: icon('AlertCircle'),
		CheckCircle: icon('CheckCircle'),
		Trophy: icon('Trophy'),
		Flame: icon('Flame'),
		FileText: icon('FileText'),
		Hash: icon('Hash'),
		ChevronDown: icon('ChevronDown'),
		HelpCircle: icon('HelpCircle'),
		Github: icon('Github'),
		Terminal: icon('Terminal'),
		Lock: icon('Lock'),
		Star: icon('Star'),
	};
});

// Create mock data
const mockRepo: RegisteredRepository = {
	slug: 'test-owner/test-repo',
	name: 'Test Repository',
	description: 'A test repository',
	url: 'https://github.com/test-owner/test-repo',
	category: 'developer-tools' as SymphonyCategory,
	tags: ['test'],
	maintainer: { name: 'Test', url: 'https://github.com/test' },
	isActive: true,
	featured: false,
	addedAt: '2025-01-01',
};

const mockIssue: SymphonyIssue = {
	number: 1,
	title: 'Test Issue',
	body: 'Test body',
	url: 'https://api.github.com/repos/test/repo/issues/1',
	htmlUrl: 'https://github.com/test/repo/issues/1',
	author: 'test',
	createdAt: '2025-01-01',
	updatedAt: '2025-01-01',
	documentPaths: [{ name: 'task.md', path: 'docs/task.md', isExternal: false }],
	status: 'available',
};

// Mock useSymphony hook
const mockSelectRepository = vi.fn();
const mockUseSymphonyReturn = {
	registry: {
		schemaVersion: '1.0' as const,
		lastUpdated: '2025-01-01',
		repositories: [mockRepo],
	},
	repositories: [mockRepo],
	categories: ['developer-tools'] as SymphonyCategory[],
	isLoading: false,
	isRefreshing: false,
	error: null,
	fromCache: false,
	cacheAge: null,
	selectedCategory: 'all' as const,
	setSelectedCategory: vi.fn(),
	searchQuery: '',
	setSearchQuery: vi.fn(),
	filteredRepositories: [mockRepo],
	selectedRepo: mockRepo,
	repoIssues: [mockIssue],
	isLoadingIssues: false,
	selectRepository: mockSelectRepository,
	symphonyState: null,
	activeContributions: [],
	completedContributions: [],
	stats: null,
	refresh: vi.fn(),
	startContribution: vi.fn(),
	cancelContribution: vi.fn(),
	finalizeContribution: vi.fn(),
	issueCounts: null as Record<string, number> | null,
	isLoadingIssueCounts: false,
};

const mockContributorStatsReturn = {
	stats: null,
	recentContributions: [],
	achievements: [],
	isLoading: false,
	refresh: vi.fn(),
	formattedTotalCost: '$0.00',
	formattedTotalTokens: '0',
	formattedTotalTime: '0m',
	uniqueRepos: 0,
	currentStreakWeeks: 0,
	longestStreakWeeks: 0,
};

vi.mock('../../../renderer/hooks/symphony', () => ({
	useSymphony: () => mockUseSymphonyReturn,
	useContributorStats: () => mockContributorStatsReturn,
}));

vi.mock('../../../renderer/hooks/symphony/useContributorStats', () => ({
	useContributorStats: () => mockContributorStatsReturn,
}));

// ============================================================================
// Helpers
// ============================================================================

const testTheme: Theme = {
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#1e1e1e',
		bgSidebar: '#252526',
		bgActivity: '#333333',
		textMain: '#d4d4d4',
		textDim: '#808080',
		accent: '#007acc',
		border: '#404040',
		error: '#f14c4c',
		warning: '#cca700',
		success: '#89d185',
		info: '#3794ff',
		textInverse: '#000000',
	},
};

/**
 * Navigate into the detail view and select the issue so the "Start Symphony"
 * button appears. The component requires:
 * 1. Click a repo tile → showDetailView=true
 * 2. The issue is auto-selected as the first available issue
 */
async function navigateToStartButton() {
	// Click the repo tile to enter detail view
	const repoTile = screen.getByText('Test Repository');
	await act(async () => {
		fireEvent.click(repoTile);
	});

	// Wait for detail view with the issue
	await waitFor(() => {
		expect(screen.getByText('Test Issue')).toBeInTheDocument();
	});

	// Click the issue to select it
	await act(async () => {
		fireEvent.click(screen.getByText('Test Issue'));
	});

	// Wait for Start Symphony button to appear
	await waitFor(() => {
		expect(screen.getByText('Start Symphony')).toBeInTheDocument();
	});
}

// ============================================================================
// Tests
// ============================================================================

describe('SymphonyModal', () => {
	let checkGhCliMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.clearAllMocks();
		checkGhCliMock = vi.fn();
		window.maestro.git.checkGhCli = checkGhCliMock;
		mockSelectRepository.mockResolvedValue(undefined);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('Pre-flight gh CLI check', () => {
		it('shows loading state while checking gh CLI', async () => {
			let resolveGh!: (value: { installed: boolean; authenticated: boolean }) => void;
			checkGhCliMock.mockReturnValue(
				new Promise((resolve) => {
					resolveGh = resolve;
				})
			);

			render(
				<SymphonyModal
					theme={testTheme}
					isOpen={true}
					onClose={vi.fn()}
					onStartContribution={vi.fn()}
					sessions={[]}
					onSelectSession={vi.fn()}
				/>
			);

			await navigateToStartButton();

			await act(async () => {
				fireEvent.click(screen.getByText('Start Symphony'));
			});

			expect(screen.getByText('Checking prerequisites…')).toBeInTheDocument();

			// Clean up
			await act(async () => {
				resolveGh({ installed: true, authenticated: true });
			});
		});

		it('blocks when gh CLI is not installed', async () => {
			checkGhCliMock.mockResolvedValue({ installed: false, authenticated: false });

			render(
				<SymphonyModal
					theme={testTheme}
					isOpen={true}
					onClose={vi.fn()}
					onStartContribution={vi.fn()}
					sessions={[]}
					onSelectSession={vi.fn()}
				/>
			);

			await navigateToStartButton();

			await act(async () => {
				fireEvent.click(screen.getByText('Start Symphony'));
			});

			await waitFor(() => {
				expect(screen.getByText('GitHub CLI Required')).toBeInTheDocument();
			});

			expect(screen.getByText('cli.github.com')).toBeInTheDocument();
			expect(screen.queryByText('I Have the Build Tools')).not.toBeInTheDocument();
			expect(screen.getByText('Close')).toBeInTheDocument();
		});

		it('blocks when gh CLI is not authenticated', async () => {
			checkGhCliMock.mockResolvedValue({ installed: true, authenticated: false });

			render(
				<SymphonyModal
					theme={testTheme}
					isOpen={true}
					onClose={vi.fn()}
					onStartContribution={vi.fn()}
					sessions={[]}
					onSelectSession={vi.fn()}
				/>
			);

			await navigateToStartButton();

			await act(async () => {
				fireEvent.click(screen.getByText('Start Symphony'));
			});

			await waitFor(() => {
				expect(screen.getByText('GitHub CLI Not Authenticated')).toBeInTheDocument();
			});

			expect(screen.getByText('gh auth login')).toBeInTheDocument();
			expect(screen.queryByText('I Have the Build Tools')).not.toBeInTheDocument();
			expect(screen.getByText('Close')).toBeInTheDocument();
		});

		it('shows build tools warning with gh checkmark when gh is OK', async () => {
			checkGhCliMock.mockResolvedValue({ installed: true, authenticated: true });

			render(
				<SymphonyModal
					theme={testTheme}
					isOpen={true}
					onClose={vi.fn()}
					onStartContribution={vi.fn()}
					sessions={[]}
					onSelectSession={vi.fn()}
				/>
			);

			await navigateToStartButton();

			await act(async () => {
				fireEvent.click(screen.getByText('Start Symphony'));
			});

			await waitFor(() => {
				expect(screen.getByText('GitHub CLI authenticated')).toBeInTheDocument();
			});

			expect(screen.getByText('Build Tools Required')).toBeInTheDocument();
			expect(screen.getByText('I Have the Build Tools')).toBeInTheDocument();
		});

		it('dismisses dialog when Close is clicked on gh error', async () => {
			checkGhCliMock.mockResolvedValue({ installed: false, authenticated: false });

			render(
				<SymphonyModal
					theme={testTheme}
					isOpen={true}
					onClose={vi.fn()}
					onStartContribution={vi.fn()}
					sessions={[]}
					onSelectSession={vi.fn()}
				/>
			);

			await navigateToStartButton();

			await act(async () => {
				fireEvent.click(screen.getByText('Start Symphony'));
			});

			await waitFor(() => {
				expect(screen.getByText('GitHub CLI Required')).toBeInTheDocument();
			});

			await act(async () => {
				fireEvent.click(screen.getByText('Close'));
			});

			expect(screen.queryByText('GitHub CLI Required')).not.toBeInTheDocument();
		});

		it('treats gh CLI check failure as not installed', async () => {
			checkGhCliMock.mockRejectedValue(new Error('IPC failed'));

			render(
				<SymphonyModal
					theme={testTheme}
					isOpen={true}
					onClose={vi.fn()}
					onStartContribution={vi.fn()}
					sessions={[]}
					onSelectSession={vi.fn()}
				/>
			);

			await navigateToStartButton();

			await act(async () => {
				fireEvent.click(screen.getByText('Start Symphony'));
			});

			await waitFor(() => {
				expect(screen.getByText('GitHub CLI Required')).toBeInTheDocument();
			});
		});
	});

	describe('agent creation through the host commit (MCOMP-23-04B)', () => {
		const started = {
			success: true,
			contributionId: 'contrib_1',
			branchName: 'symphony/issue-42',
			autoRunPath: '/tmp/docs',
		};
		const config = (expectedPolicyRevision?: number | null) => ({
			agentType: 'claude-code',
			sessionName: 'Symphony: test-owner/test-repo #42',
			workingDirectory: '/home/u/Maestro-Symphony/test-owner-test-repo-42',
			repo: mockRepo,
			issue: mockIssue,
			...(expectedPolicyRevision !== undefined && { expectedPolicyRevision }),
		});
		const refusal = {
			ok: false as const,
			code: 'field' as const,
			reason: 'This working directory is not an approved choice.',
			policyRevision: 6,
			fields: [{ field: 'workspace' as const, reason: 'Not an approved workspace.' }],
		};

		const openDialog = async (onStartContribution: SymphonyModalProps['onStartContribution']) => {
			checkGhCliMock.mockResolvedValue({ installed: true, authenticated: true });
			render(
				<SymphonyModal
					theme={testTheme}
					isOpen={true}
					onClose={vi.fn()}
					onStartContribution={onStartContribution}
					onSelectSession={vi.fn()}
				/>
			);
			await navigateToStartButton();
			await act(async () => {
				fireEvent.click(screen.getByText('Start Symphony'));
			});
			await act(async () => {
				fireEvent.click(await screen.findByText('I Have the Build Tools'));
			});
			expect(await screen.findByTestId('agent-creation-dialog')).toBeInTheDocument();
		};

		beforeEach(() => {
			dialogProps.current = null;
			mockUseSymphonyReturn.startContribution = vi.fn().mockResolvedValue(started);
		});

		it('keeps the dialog open until the agent is committed, then closes it', async () => {
			let resolveCommit!: (value: { ok: true }) => void;
			const onStartContribution = vi.fn(
				() => new Promise<{ ok: true }>((resolve) => (resolveCommit = resolve))
			);
			await openDialog(onStartContribution);

			let result: Promise<unknown>;
			await act(async () => {
				result = dialogProps.current!.onCreateAgent(config(6));
			});
			expect(onStartContribution).toHaveBeenCalledTimes(1);
			expect(onStartContribution.mock.calls[0][0]).toMatchObject({
				localPath: '/home/u/Maestro-Symphony/test-owner-test-repo-42',
				expectedPolicyRevision: 6,
			});
			// The agent is admitted first: the modal ran no repository step itself
			// and has no contribution to name yet (MCOMP-23-04D).
			expect(onStartContribution.mock.calls[0][0]).not.toHaveProperty('contributionId');
			expect(mockUseSymphonyReturn.startContribution).not.toHaveBeenCalled();
			// The commit has not answered: the dialog still holds the draft.
			expect(screen.getByTestId('agent-creation-dialog')).toBeInTheDocument();

			await act(async () => {
				resolveCommit({ ok: true });
				await expect(result).resolves.toEqual({ success: true });
			});
			expect(screen.queryByTestId('agent-creation-dialog')).not.toBeInTheDocument();
		});

		it('returns a host refusal to the dialog and leaves it open', async () => {
			const onStartContribution = vi.fn().mockResolvedValue({
				ok: false,
				error:
					'This working directory is not an approved choice. (workspace: Not an approved workspace.)',
				refusal,
			});
			await openDialog(onStartContribution);

			let result: unknown;
			await act(async () => {
				result = await dialogProps.current!.onCreateAgent(config(6));
			});
			expect(result).toEqual({
				success: false,
				error:
					'This working directory is not an approved choice. (workspace: Not an approved workspace.)',
				refusal,
			});
			expect(screen.getByTestId('agent-creation-dialog')).toBeInTheDocument();
		});

		it('sends no revision when the dialog sent none, and treats a void handler as done', async () => {
			const onStartContribution = vi.fn().mockResolvedValue(undefined);
			await openDialog(onStartContribution);

			let result: unknown;
			await act(async () => {
				result = await dialogProps.current!.onCreateAgent(config());
			});
			expect(onStartContribution.mock.calls[0][0]).not.toHaveProperty('expectedPolicyRevision');
			expect(result).toEqual({ success: true });
			expect(screen.queryByTestId('agent-creation-dialog')).not.toBeInTheDocument();
		});

		it('hands the repository steps to the handler, run with the admitted agent id', async () => {
			mockUseSymphonyReturn.startContribution = vi
				.fn()
				.mockResolvedValue({ success: false, error: 'Failed to clone repository' });
			const onStartContribution = vi.fn(
				async (data: {
					startRepository?: (id: string) => Promise<{ success: boolean; error?: string }>;
				}) => {
					const start = await data.startRepository!('agent-1');
					return { ok: false as const, error: start.error ?? '' };
				}
			);
			await openDialog(onStartContribution);

			let result: unknown;
			await act(async () => {
				result = await dialogProps.current!.onCreateAgent(config(6));
			});
			expect(mockUseSymphonyReturn.startContribution).toHaveBeenCalledTimes(1);
			const call = (mockUseSymphonyReturn.startContribution as ReturnType<typeof vi.fn>).mock
				.calls[0];
			expect(call[3]).toBe('agent-1');
			expect(call[4]).toBe('/home/u/Maestro-Symphony/test-owner-test-repo-42');
			expect(result).toEqual({ success: false, error: 'Failed to clone repository' });
			expect(screen.getByTestId('agent-creation-dialog')).toBeInTheDocument();
		});

		describe('wired to the contribution handler (MCOMP-23-04E)', () => {
			type CommitRequest = { operation: string; record: Record<string, unknown> } & {
				expectedPolicyRevision?: number | null;
			};
			let events: string[];
			let saved: Record<string, unknown>;
			const commitAgent = vi.fn();
			const cloneRepo = vi.fn();
			const startContributionIpc = vi.fn();
			const setMany = vi.fn();

			beforeEach(() => {
				events = [];
				saved = {
					commitAgent: window.maestro.sessions.commitAgent,
					getAgent: window.maestro.agents.get,
					setMany: window.maestro.sessions.setMany,
					cloneRepo: window.maestro.symphony.cloneRepo,
					startContribution: window.maestro.symphony.startContribution,
				};
				// A managed host at revision 6 (stale for any other revision).
				commitAgent.mockReset().mockImplementation(async (request: CommitRequest) => {
					events.push(`commit:${request.operation}`);
					if (request.operation === 'create' && request.expectedPolicyRevision !== 6) {
						return {
							ok: false,
							code: 'stale',
							reason: 'The policy changed; review the choices again.',
							policyRevision: 6,
							fields: [],
						};
					}
					return { ok: true, record: request.record, managed: true, policyRevision: 6 };
				});
				cloneRepo.mockReset().mockImplementation(async () => {
					events.push('cloneRepo');
					return { success: true };
				});
				startContributionIpc
					.mockReset()
					.mockImplementation(async (params: { sessionId: string }) => {
						events.push(`startContribution:${params.sessionId}`);
						return {
							success: true,
							branchName: 'symphony/issue-42',
							autoRunPath: '/tmp/docs',
							draftPrNumber: 4,
							draftPrUrl: 'https://github.com/test-owner/test-repo/pull/4',
						};
					});
				setMany.mockReset().mockImplementation(async () => {
					events.push('withdraw');
					return true;
				});
				Object.assign(window.maestro.sessions, { commitAgent, setMany });
				window.maestro.agents.get = vi
					.fn()
					.mockResolvedValue({ id: 'claude-code', name: 'Claude Code' });
				Object.assign(window.maestro.symphony, {
					cloneRepo,
					startContribution: startContributionIpc,
				});
				// useSymphony's startContribution body over the IPC doubles.
				mockUseSymphonyReturn.startContribution = vi.fn(
					async (
						_repo: unknown,
						issue: SymphonyIssue,
						_type: string,
						sessionId: string,
						dir: string
					) => {
						const clone = await window.maestro.symphony.cloneRepo({
							repoUrl: mockRepo.url,
							localPath: dir,
						});
						if (!clone.success) return { success: false, error: clone.error };
						const start = await window.maestro.symphony.startContribution({
							contributionId: 'contrib_wired',
							sessionId,
							repoSlug: mockRepo.slug,
							issueNumber: issue.number,
							issueTitle: issue.title,
							localPath: dir,
							documentPaths: issue.documentPaths,
						});
						if (!start.success) return { success: false, error: start.error };
						return { success: true, contributionId: 'contrib_wired', ...start };
					}
				);
				useSessionStore.setState({ sessions: [], activeSessionId: '' } as never);
			});

			afterEach(() => {
				Object.assign(window.maestro.sessions, {
					commitAgent: saved.commitAgent,
					setMany: saved.setMany,
				});
				window.maestro.agents.get = saved.getAgent as typeof window.maestro.agents.get;
				Object.assign(window.maestro.symphony, {
					cloneRepo: saved.cloneRepo,
					startContribution: saved.startContribution,
				});
				useSessionStore.setState({ sessions: [], activeSessionId: '' } as never);
			});

			const openWired = async () => {
				const { result } = renderHook(() =>
					useSymphonyContribution({ startBatchRun: vi.fn(), inputRef: { current: null } })
				);
				await openDialog(result.current.handleStartContribution);
			};

			it('a stale answer reaches the dialog and no repository step runs', async () => {
				await openWired();

				let result: unknown;
				await act(async () => {
					result = await dialogProps.current!.onCreateAgent(config(5));
				});
				expect(result).toEqual({
					success: false,
					error: expect.stringContaining('The policy changed'),
					refusal: expect.objectContaining({ code: 'stale', policyRevision: 6 }),
				});
				expect(events).toEqual(['commit:create']);
				expect(window.maestro.symphony.registerActive).not.toHaveBeenCalled();
				expect(useSessionStore.getState().sessions).toEqual([]);
				expect(screen.getByTestId('agent-creation-dialog')).toBeInTheDocument();
			});

			it('a failed start after the admit leaves no agent and returns the error to the dialog', async () => {
				startContributionIpc.mockImplementation(async () => {
					events.push('startContribution');
					return { success: false, error: 'Could not open the draft PR' };
				});
				await openWired();

				let result: unknown;
				await act(async () => {
					result = await dialogProps.current!.onCreateAgent(config(6));
				});
				expect(events).toEqual(['commit:create', 'cloneRepo', 'startContribution', 'withdraw']);
				expect(result).toEqual({ success: false, error: 'Could not open the draft PR' });
				const admitted = (commitAgent.mock.calls[0][0] as CommitRequest).record.id;
				expect(setMany).toHaveBeenCalledWith([], [admitted]);
				expect(useSessionStore.getState().sessions).toEqual([]);
				expect(window.maestro.symphony.registerActive).not.toHaveBeenCalled();
				expect(screen.getByTestId('agent-creation-dialog')).toBeInTheDocument();
			});

			it('an admit and a successful start close the dialog on one running agent', async () => {
				await openWired();

				let result: unknown;
				await act(async () => {
					result = await dialogProps.current!.onCreateAgent(config(6));
				});
				const sessions = useSessionStore.getState().sessions;
				expect(sessions).toHaveLength(1);
				expect(events).toEqual([
					'commit:create',
					'cloneRepo',
					`startContribution:${sessions[0].id}`,
					'commit:edit',
				]);
				expect(result).toEqual({ success: true });
				expect(sessions[0].autoRunFolderPath).toBe('/tmp/docs');
				expect(sessions[0].symphonyMetadata).toMatchObject({
					contributionId: 'contrib_wired',
					status: 'running',
				});
				expect(window.maestro.symphony.registerActive).toHaveBeenCalledWith(
					expect.objectContaining({ sessionId: sessions[0].id, draftPrNumber: 4 })
				);
				expect(screen.queryByTestId('agent-creation-dialog')).not.toBeInTheDocument();
			});
		});
	});
});
