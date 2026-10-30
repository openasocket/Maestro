import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { AgentCreationDialog } from '../../../renderer/components/AgentCreationDialog';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import { getAgentDefinition } from '../../../shared/maestro-lib/providers/definitions';
import { getAgentCapabilities } from '../../../shared/maestro-lib/providers/capabilities';
import type { AgentDiscoveryRequest, AgentDiscoveryResult } from '../../../shared/types';
import type { RegisteredRepository, SymphonyIssue } from '../../../shared/symphony-types';
import { mockTheme } from '../../helpers/mockTheme';

// Isolate store-backed UI utilities; exercise the real config panel and discovery hooks.
vi.mock('../../../renderer/utils/openUrl', () => ({ openUrl: vi.fn() }));
vi.mock('../../../renderer/hooks/ui/useResizableModal', () => ({
	useResizableModal: () => ({ modalRef: { current: null }, style: {}, onResizeStart: vi.fn() }),
}));
const repo: RegisteredRepository = {
	slug: 'test-owner/test-repo',
	name: 'Test Repository',
	description: 'Synthetic repository',
	url: 'https://github.com/test-owner/test-repo',
	category: 'developer-tools',
	maintainer: { name: 'Test' },
	isActive: true,
	addedAt: '2026-10-30',
};
const issue: SymphonyIssue = {
	number: 1,
	title: 'Test Issue',
	body: '',
	url: 'https://example.test/issues/1',
	htmlUrl: 'https://example.test/issues/1',
	author: 'test',
	createdAt: '2026-10-30',
	updatedAt: '2026-10-30',
	labels: [],
	status: 'available',
	documentPaths: [{ name: 'task.md', path: 'docs/task.md', isExternal: false }],
};
const unavailable: AgentDiscoveryResult = { status: 'unavailable', options: [] };
const originalModels = window.maestro.agents.getModels;
const originalOptions = window.maestro.agents.getConfigOptions;
const onCreateAgent = vi.fn().mockResolvedValue({ success: true });
const props = { theme: mockTheme, isOpen: true, onClose: vi.fn(), repo, issue, onCreateAgent };
const dialog = (overrides: Partial<typeof props> = {}) => (
	<LayerStackProvider>
		<AgentCreationDialog {...props} {...overrides} />
	</LayerStackProvider>
);
const settle = async () => {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(300);
	});
};
const field = (label: string) =>
	within(screen.getByText(label).parentElement!).getByRole('textbox');
const change = (input: HTMLElement, value: string) =>
	fireEvent.change(input, { target: { value } });

beforeEach(() => {
	vi.useFakeTimers();
	vi.clearAllMocks();
	vi.mocked(window.maestro.agents.detect).mockResolvedValue(
		['grok', 'codex'].map((id) => ({
			...getAgentDefinition(id)!,
			available: true,
			path: `/synthetic/bin/${id}`,
			capabilities: getAgentCapabilities(id),
		}))
	);
	vi.mocked(window.maestro.agents.getConfig).mockReset().mockResolvedValue({});
	vi.mocked(window.maestro.fs.homeDir).mockReset().mockResolvedValue('/synthetic/home');
	window.maestro.agents.getModels = vi
		.fn()
		.mockImplementation(async (request) =>
			typeof request === 'string' ? ['legacy-model'] : unavailable
		);
	window.maestro.agents.getConfigOptions = vi
		.fn()
		.mockImplementation(async (request) =>
			typeof request === 'string' ? ['low', 'high'] : unavailable
		);
});
afterEach(() => {
	cleanup();
	window.maestro.agents.getModels = originalModels;
	window.maestro.agents.getConfigOptions = originalOptions;
	vi.mocked(window.maestro.agents.getConfig).mockReset().mockResolvedValue({});
	vi.mocked(window.maestro.fs.homeDir).mockReset().mockResolvedValue('/synthetic/home');
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe('Symphony Grok draft discovery', () => {
	it.each(['absent', 'removed', 'blank', 'account'])(
		'uses the same %s environment for discovery and creation',
		async (mode) => {
			render(dialog());
			await act(async () => {});
			fireEvent.click(screen.getByText('Grok CLI'));
			change(screen.getByPlaceholderText('/path/to/grok'), '/synthetic/custom grok');
			change(screen.getByPlaceholderText('~/Maestro-Symphony/owner-repo'), '/synthetic/work');
			change(field('Model'), 'manual-model');
			change(field('Reasoning Effort'), 'manual-effort');
			if (mode !== 'absent') {
				fireEvent.click(screen.getByText('Add Variable'));
				const key = screen.getByRole('combobox');
				change(key, 'GROK_HOME');
				fireEvent.blur(key);
				if (mode === 'account')
					change(screen.getByPlaceholderText('value'), '/synthetic/account-a');
				if (mode === 'removed') fireEvent.click(screen.getByTitle('Remove variable'));
			}
			const customEnvVars =
				mode === 'blank'
					? { GROK_HOME: '' }
					: mode === 'account'
						? { GROK_HOME: '/synthetic/account-a' }
						: undefined;
			const context: AgentDiscoveryRequest['context'] = {
				kind: 'draft',
				cwd: '/synthetic/work',
				customPath: '/synthetic/custom grok',
				customEnvVars,
				model: 'manual-model',
				effort: 'manual-effort',
			};
			await settle();
			expect(window.maestro.agents.getModels).toHaveBeenLastCalledWith({
				providerId: 'grok',
				context,
			});
			expect(window.maestro.agents.getConfigOptions).toHaveBeenCalledWith(
				{ providerId: 'grok', context },
				'reasoningEffort'
			);
			expect(screen.getByTestId('config-option-note-model')).toHaveTextContent('unavailable');
			await act(async () => {
				fireEvent.click(screen.getByRole('button', { name: 'Create Agent' }));
			});
			expect(onCreateAgent).toHaveBeenCalledWith(
				expect.objectContaining({
					agentType: 'grok',
					workingDirectory: context.cwd,
					customPath: context.customPath,
					customEnvVars,
					agentConfig: { model: 'manual-model', reasoningEffort: 'manual-effort' },
				})
			);
		}
	);

	it.each(['unavailable', 'configured-fallback'] as const)(
		'retains manual values after %s refresh',
		async (status) => {
			render(dialog());
			await act(async () => {});
			fireEvent.click(screen.getByText('Grok CLI'));
			change(field('Model'), 'manual-model');
			change(field('Reasoning Effort'), 'manual-effort');
			await settle();
			vi.mocked(window.maestro.agents.getModels).mockResolvedValue({
				status,
				options: status === 'unavailable' ? [] : ['configured-model'],
			});
			vi.mocked(window.maestro.agents.getConfigOptions).mockResolvedValue({
				status,
				options: ['configured-effort'],
			});
			fireEvent.click(screen.getByTitle('Refresh available models'));
			expect(window.maestro.agents.getModels).toHaveBeenLastCalledWith(
				expect.objectContaining({
					providerId: 'grok',
					forceRefresh: true,
					context: expect.objectContaining({ model: 'manual-model', effort: 'manual-effort' }),
				})
			);
			await act(async () => {});
			await settle();
			expect(field('Model')).toHaveValue('manual-model');
			expect(field('Reasoning Effort')).toHaveValue('manual-effort');
			expect(screen.getByTestId('config-option-note-model')).toHaveTextContent('unavailable');
			expect(screen.getByTestId('config-option-note-reasoningEffort')).toHaveTextContent(
				'unavailable'
			);
		}
	);

	it.each(['account', 'path', 'cwd', 'provider', 'close', 'refresh'])(
		'ignores late catalogs after a %s change',
		async (transition) => {
			const view = render(dialog());
			await act(async () => {});
			fireEvent.click(screen.getByText('Grok CLI'));
			change(field('Model'), 'manual');
			change(field('Reasoning Effort'), 'manual-effort');
			await settle();
			let resolveOld!: (value: AgentDiscoveryResult) => void;
			const old = new Promise<AgentDiscoveryResult>((resolve) => {
				resolveOld = resolve;
			});
			vi.mocked(window.maestro.agents.getModels).mockReturnValueOnce(old);
			if (transition === 'refresh') fireEvent.click(screen.getByTitle('Refresh available models'));
			else {
				vi.mocked(window.maestro.agents.getConfigOptions)
					.mockReturnValueOnce(old)
					.mockReturnValueOnce(old);
				change(screen.getByPlaceholderText('/path/to/grok'), '/synthetic/pending');
				await settle();
			}
			if (transition === 'provider') fireEvent.click(screen.getByText('Codex'));
			else if (transition === 'close') view.rerender(dialog({ isOpen: false }));
			else if (transition === 'account') {
				fireEvent.click(screen.getByText('Add Variable'));
				const key = screen.getByRole('combobox');
				change(key, 'GROK_HOME');
				fireEvent.blur(key);
				change(screen.getByPlaceholderText('value'), '/synthetic/account-b');
			} else if (transition === 'cwd')
				change(screen.getByPlaceholderText('~/Maestro-Symphony/owner-repo'), '/synthetic/next');
			else change(screen.getByPlaceholderText('/path/to/grok'), '/synthetic/current');
			await settle();
			const calls = vi.mocked(window.maestro.agents.getModels).mock.calls.length;
			await act(async () => {
				resolveOld({ status: 'discovered', options: ['manual-old-account'] });
			});
			await settle();
			expect(window.maestro.agents.getModels).toHaveBeenCalledTimes(calls);
			if (transition === 'close') {
				expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
				view.rerender(dialog());
				await act(async () => {});
				await settle();
			} else if (transition === 'provider') {
				expect(window.maestro.agents.getModels).toHaveBeenCalledWith('codex', false);
				fireEvent.click(screen.getByText('Grok CLI'));
				await settle();
			}
			fireEvent.focus(field('Model'));
			expect(screen.queryByRole('button', { name: 'manual-old-account' })).not.toBeInTheDocument();
			expect(field('Model')).toHaveValue('manual');
			expect(field('Reasoning Effort')).toHaveValue('manual-effort');
			expect(screen.getByTestId('config-option-note-reasoningEffort')).toHaveTextContent(
				'unavailable'
			);
		}
	);

	it('hides a populated menu immediately when cwd changes, before debounced discovery', async () => {
		render(dialog());
		await act(async () => {});
		fireEvent.click(screen.getByText('Grok CLI'));
		vi.mocked(window.maestro.agents.getModels).mockResolvedValue({
			status: 'discovered',
			options: ['old-account-model'],
		});
		await settle();
		fireEvent.focus(field('Model'));
		expect(screen.getByRole('button', { name: 'old-account-model' })).toBeInTheDocument();
		const calls = vi.mocked(window.maestro.agents.getModels).mock.calls.length;
		change(
			screen.getByPlaceholderText('~/Maestro-Symphony/owner-repo'),
			'/synthetic/new-workspace'
		);
		expect(screen.queryByRole('button', { name: 'old-account-model' })).not.toBeInTheDocument();
		expect(window.maestro.agents.getModels).toHaveBeenCalledTimes(calls);
		await settle();
		expect(window.maestro.agents.getModels).toHaveBeenCalledTimes(calls + 1);
	});

	// GT1-02-05D2 repairs the manual-edit race; keep this desired invariant executable.
	it.each(['repo', 'close', 'manual'])(
		'does not apply a late home directory to a changed %s draft',
		async (transition) => {
			let resolveHome!: (value: string) => void;
			vi.mocked(window.maestro.fs.homeDir).mockReturnValueOnce(
				new Promise((resolve) => {
					resolveHome = resolve;
				})
			);
			const view = render(dialog());
			await act(async () => {});
			if (transition === 'close') {
				view.rerender(dialog({ isOpen: false }));
				view.rerender(dialog());
			} else if (transition === 'repo')
				view.rerender(dialog({ repo: { ...repo, slug: 'new-owner/new-repo' } }));
			await act(async () => {});
			const cwd = screen.getByPlaceholderText('~/Maestro-Symphony/owner-repo');
			change(cwd, '/synthetic/manual-work');
			await act(async () => {
				resolveHome('/synthetic/obsolete-home');
			});
			expect(cwd).toHaveValue('/synthetic/manual-work');
			fireEvent.click(screen.getByText('Grok CLI'));
			await settle();
			expect(window.maestro.agents.getModels).toHaveBeenLastCalledWith(
				expect.objectContaining({
					context: expect.objectContaining({ cwd: '/synthetic/manual-work' }),
				})
			);
		}
	);
});
