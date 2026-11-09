/**
 * Tests for AgentCreationDialog (Start Symphony) under the approved-choice model
 * (MCOMP-23-04B): the managed notice, the policy revision sent with the create,
 * and a host refusal returned to the dialog, which keeps its draft.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import {
	AgentCreationDialog,
	type AgentCreationConfig,
	type AgentCreationResult,
} from '../../../renderer/components/AgentCreationDialog';
import { clearCachedResources } from '../../../renderer/hooks/utils/useCachedResource';
import type { AgentCommitRefusal } from '../../../renderer/services/agentCommit';
import type { Theme } from '../../../renderer/types';
import type { RegisteredRepository, SymphonyIssue } from '../../../shared/symphony-types';

vi.mock('../../../renderer/contexts/LayerStackContext', () => ({
	useLayerStack: () => ({
		registerLayer: vi.fn(() => 'layer-1'),
		unregisterLayer: vi.fn(),
		updateLayerHandler: vi.fn(),
	}),
}));

const theme = {
	id: 'test',
	name: 'Test',
	mode: 'dark',
	colors: {
		bgMain: '#1e1e1e',
		bgSidebar: '#252526',
		bgActivity: '#333333',
		textMain: '#d4d4d4',
		textDim: '#808080',
		accent: '#007acc',
		accentForeground: '#ffffff',
		border: '#404040',
		error: '#f14c4c',
		warning: '#cca700',
		success: '#89d185',
		info: '#3794ff',
		textInverse: '#000000',
	},
} as unknown as Theme;

const repo = {
	slug: 'owner/repo',
	name: 'Repo',
	url: 'https://github.com/owner/repo',
} as unknown as RegisteredRepository;

const issue = {
	number: 12,
	title: 'Fix the thing',
	documentPaths: [{ name: 'doc.md', path: 'docs/doc.md', isExternal: false }],
} as unknown as SymphonyIssue;

const claude = {
	id: 'claude-code',
	name: 'Claude Code',
	available: true,
	hidden: false,
	capabilities: { supportsBatchMode: true },
};

const managed = (revision: number) => ({
	standing: 'managed',
	policy: { source: 'endpoint' },
	agentOptions: {
		outcome: 'available',
		authority: 'none',
		policyRevision: revision,
		freshness: 'fresh',
		expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
		operations: ['create'],
		fields: {
			workspace: {
				choices: [{ kind: 'workspace', ref: 'ws-symphony' }],
				editable: true,
				minimum: 1,
				maximum: 1,
				lockedReason: null,
			},
		},
	},
});

const refusal = (code: 'field' | 'stale', revision: number): AgentCommitRefusal => ({
	ok: false,
	code,
	reason:
		code === 'stale'
			? 'The policy changed. Refresh to load the current approved choices.'
			: 'This working directory is not an approved choice.',
	policyRevision: revision,
	fields:
		code === 'field'
			? [{ field: 'workspace', reason: 'This working directory is not an approved choice.' }]
			: [],
});

describe('AgentCreationDialog approved choices and host refusals (MCOMP-23-04B)', () => {
	const originalEnterprise = window.maestro.enterprise;
	const originalAgents = window.maestro.agents;
	const managedState = vi.fn();
	const onClose = vi.fn();
	let onCreateAgent: ReturnType<
		typeof vi.fn<(config: AgentCreationConfig) => Promise<AgentCreationResult>>
	>;

	const renderDialog = () =>
		render(
			<AgentCreationDialog
				theme={theme}
				isOpen={true}
				onClose={onClose}
				repo={repo}
				issue={issue}
				onCreateAgent={onCreateAgent}
			/>
		);

	const selectAgentAndCreate = async () => {
		fireEvent.click(await screen.findByText('Claude Code'));
		await waitFor(() =>
			expect(screen.getByDisplayValue('/home/tester/Maestro-Symphony/owner-repo-12')).toBeTruthy()
		);
		await act(async () => {
			fireEvent.click(screen.getByText('Create Agent'));
		});
	};

	beforeEach(() => {
		clearCachedResources();
		managedState.mockReset();
		onClose.mockReset();
		onCreateAgent = vi.fn();
		(window.maestro as { enterprise: unknown }).enterprise = {
			...originalEnterprise,
			managedState,
		};
		(window.maestro as { agents: unknown }).agents = {
			...originalAgents,
			detect: vi.fn().mockResolvedValue([claude]),
			getConfig: vi.fn().mockResolvedValue({}),
			getModels: vi.fn().mockResolvedValue([]),
			getConfigOptions: vi.fn().mockResolvedValue([]),
			getMaestroPDetectedPath: vi.fn().mockResolvedValue(null),
		};
		window.maestro.fs.homeDir = vi.fn().mockResolvedValue('/home/tester');
	});

	afterEach(() => {
		clearCachedResources();
		(window.maestro as { enterprise: unknown }).enterprise = originalEnterprise;
		(window.maestro as { agents: unknown }).agents = originalAgents;
	});

	it('shows nothing new and sends a null revision on a standalone desktop', async () => {
		managedState.mockResolvedValue({ standing: 'unenrolled', policy: { source: 'none' } });
		onCreateAgent.mockResolvedValue({ success: true });
		renderDialog();
		await selectAgentAndCreate();

		expect(onCreateAgent).toHaveBeenCalledTimes(1);
		expect(onCreateAgent.mock.calls[0][0]).toMatchObject({
			agentType: 'claude-code',
			workingDirectory: '/home/tester/Maestro-Symphony/owner-repo-12',
			expectedPolicyRevision: null,
		});
		expect(screen.queryByTestId('managed-choices-notice')).not.toBeInTheDocument();
	});

	it('shows the approved choices and sends the revision they came from', async () => {
		managedState.mockResolvedValue(managed(6));
		onCreateAgent.mockResolvedValue({ success: true });
		renderDialog();
		expect(await screen.findByTestId('managed-policy-revision')).toHaveTextContent(
			'revision 6, from the endpoint, fresh'
		);
		expect(screen.getByTestId('managed-field-workspace')).toHaveTextContent('ws-symphony');
		await selectAgentAndCreate();

		expect(onCreateAgent.mock.calls[0][0].expectedPolicyRevision).toBe(6);
	});

	it('keeps the draft and lists the reasons by field when the host refuses', async () => {
		managedState.mockResolvedValue(managed(6));
		onCreateAgent.mockResolvedValue({
			success: false,
			error: 'This working directory is not an approved choice.',
			refusal: refusal('field', 6),
		});
		renderDialog();
		await screen.findByTestId('managed-policy-revision');
		fireEvent.click(await screen.findByText('Claude Code'));
		await waitFor(() =>
			expect(screen.getByDisplayValue('/home/tester/Maestro-Symphony/owner-repo-12')).toBeTruthy()
		);
		fireEvent.change(screen.getByDisplayValue('Symphony: owner/repo #12'), {
			target: { value: 'My Symphony Agent' },
		});
		await act(async () => {
			fireEvent.click(screen.getByText('Create Agent'));
		});

		expect(onClose).not.toHaveBeenCalled();
		expect(screen.getByDisplayValue('My Symphony Agent')).toBeInTheDocument();
		expect(screen.getByTestId('managed-refusal')).toHaveTextContent(
			'Not created: This working directory is not an approved choice.'
		);
		expect(screen.getByTestId('managed-refusal-workspace')).toHaveTextContent(
			'Working directory: This working directory is not an approved choice.'
		);
		expect(screen.getByTestId('symphony-workspace-refusal')).toHaveTextContent(
			'This working directory is not an approved choice.'
		);
		// Shown by field (the notice and the input), never repeated as a raw error line.
		expect(screen.getAllByText('This working directory is not an approved choice.')).toHaveLength(
			1
		);
		// Create is available again for a corrected draft.
		expect(screen.getByText('Create Agent').closest('button')).not.toBeDisabled();
	});

	it('refreshes the approved choices after a stale refusal', async () => {
		managedState.mockResolvedValueOnce(managed(6)).mockResolvedValue(managed(7));
		onCreateAgent.mockResolvedValue({
			success: false,
			error: 'The policy changed.',
			refusal: refusal('stale', 7),
		});
		renderDialog();
		expect(await screen.findByTestId('managed-policy-revision')).toHaveTextContent('revision 6');
		await selectAgentAndCreate();

		expect(screen.getByTestId('managed-refusal')).toHaveTextContent(
			'The policy changed while this form was open. Approved choices were refreshed; review them and create again.'
		);
		await waitFor(() =>
			expect(screen.getByTestId('managed-policy-revision')).toHaveTextContent('revision 7')
		);
	});

	it('still reports an ordinary failure as before', async () => {
		managedState.mockResolvedValue({ standing: 'unenrolled', policy: { source: 'none' } });
		onCreateAgent.mockResolvedValue({ success: false, error: 'Failed to clone repository' });
		renderDialog();
		await selectAgentAndCreate();

		expect(screen.getByText('Failed to clone repository')).toBeInTheDocument();
		expect(screen.queryByTestId('managed-refusal')).not.toBeInTheDocument();
	});
});
