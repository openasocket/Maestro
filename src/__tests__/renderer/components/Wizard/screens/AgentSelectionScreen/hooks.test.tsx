import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentDiscoveryResult } from '../../../../../../shared/types';
import {
	useWizard,
	type WizardState,
} from '../../../../../../renderer/components/Wizard/WizardContext';
import { initialState } from '../../../../../../renderer/components/Wizard/WizardContext/reducer';
import type { AgentConfig } from '../../../../../../renderer/types';
import { useAgentConfigurationPanel } from '../../../../../../renderer/components/Wizard/screens/AgentSelectionScreen/hooks/useAgentConfigurationPanel';
import { useAgentDetection } from '../../../../../../renderer/components/Wizard/screens/AgentSelectionScreen/hooks/useAgentDetection';
import { useAgentSelectionFocus } from '../../../../../../renderer/components/Wizard/screens/AgentSelectionScreen/hooks/useAgentSelectionFocus';
import { useAgentSelectionKeyboard } from '../../../../../../renderer/components/Wizard/screens/AgentSelectionScreen/hooks/useAgentSelectionKeyboard';
import { useSshRemotes } from '../../../../../../renderer/components/Wizard/screens/AgentSelectionScreen/hooks/useSshRemotes';
import { AGENT_TILES } from '../../../../../../renderer/components/Wizard/screens/AgentSelectionScreen/utils/agentTiles';
import { captureException } from '../../../../../../renderer/utils/sentry';

vi.mock('../../../../../../renderer/components/Wizard/WizardContext', () => ({
	useWizard: vi.fn(),
}));

vi.mock('../../../../../../renderer/utils/sentry', () => ({
	captureException: vi.fn(),
	captureMessage: vi.fn(),
}));

function agent(overrides: Partial<AgentConfig>): AgentConfig {
	return {
		id: 'claude-code',
		name: 'Claude Code',
		available: true,
		hidden: false,
		...overrides,
	};
}

function createRefs() {
	const nameInput = document.createElement('input');
	const firstTile = document.createElement('button');
	const secondTile = document.createElement('button');
	vi.spyOn(nameInput, 'focus');
	vi.spyOn(firstTile, 'focus');
	vi.spyOn(secondTile, 'focus');

	return {
		nameInput,
		firstTile,
		secondTile,
		refs: {
			nameInputRef: { current: nameInput } as React.RefObject<HTMLInputElement>,
			tileRefs: { current: [firstTile, secondTile] } as React.RefObject<
				(HTMLButtonElement | null)[]
			>,
			containerRef: { current: null } as React.RefObject<HTMLDivElement>,
		},
	};
}

const FIRST_TILE_ID = AGENT_TILES[0].id;
const SECOND_TILE_ID = AGENT_TILES[1].id;

describe('AgentSelectionScreen hooks', () => {
	let wizardState: WizardState;
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useRealTimers();
		wizardState = { ...initialState, isOpen: true, directoryPath: '/project' };
		vi.mocked(useWizard).mockImplementation(
			() => ({ state: wizardState }) as ReturnType<typeof useWizard>
		);
		vi.mocked(window.maestro.agents.detect).mockResolvedValue([
			agent({ id: 'claude-code', available: true }),
			agent({ id: 'terminal', hidden: true }),
		]);
		vi.mocked(window.maestro.agents.getConfig).mockResolvedValue({});
		vi.mocked(window.maestro.agents.getModels).mockReset().mockResolvedValue([]);
		vi.mocked(window.maestro.agents.getConfigOptions).mockReset().mockResolvedValue([]);
		vi.mocked(window.maestro.agents.setConfig).mockResolvedValue(undefined);
		vi.mocked(window.maestro.agents.setCustomPath).mockResolvedValue(undefined);
		vi.mocked(window.maestro.sshRemote.getConfigs).mockResolvedValue({
			success: true,
			configs: [],
		});
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('detects local agents, filters hidden entries, auto-selects Claude, and announces', async () => {
		const setAvailableAgents = vi.fn();
		const setSelectedAgent = vi.fn();
		const { result } = renderHook(() =>
			useAgentDetection({
				sshRemoteConfig: undefined,
				selectedAgent: null,
				setAvailableAgents,
				setSelectedAgent,
			})
		);

		await waitFor(() => expect(result.current.isDetecting).toBe(false));

		expect(window.maestro.agents.detect).toHaveBeenCalledWith(undefined);
		expect(result.current.detectedAgents).toHaveLength(1);
		expect(setAvailableAgents).toHaveBeenCalledWith([
			expect.objectContaining({ id: 'claude-code' }),
		]);
		expect(setSelectedAgent).toHaveBeenCalledWith('claude-code');
		expect(result.current.announcement).toContain('Claude Code automatically selected');
	});

	it('does not auto-select when a restored agent is already selected', async () => {
		const setAvailableAgents = vi.fn();
		const setSelectedAgent = vi.fn();
		const { result } = renderHook(() =>
			useAgentDetection({
				sshRemoteConfig: undefined,
				selectedAgent: 'codex',
				setAvailableAgents,
				setSelectedAgent,
			})
		);

		await waitFor(() => expect(result.current.isDetecting).toBe(false));

		expect(setSelectedAgent).not.toHaveBeenCalled();
	});

	it('detects with SSH remote ID and exposes all-agent connection errors', async () => {
		const setAvailableAgents = vi.fn();
		const setSelectedAgent = vi.fn();
		vi.mocked(window.maestro.agents.detect).mockResolvedValue([
			agent({ id: 'claude-code', available: false, error: 'Connection timed out' } as any),
			agent({ id: 'codex', available: false, error: 'Connection timed out' } as any),
		]);

		const { result } = renderHook(() =>
			useAgentDetection({
				sshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
				selectedAgent: null,
				setAvailableAgents,
				setSelectedAgent,
			})
		);

		await waitFor(() => expect(result.current.isDetecting).toBe(false));

		expect(window.maestro.agents.detect).toHaveBeenCalledWith('remote-1');
		expect(result.current.sshConnectionError).toBe('Connection timed out');
		expect(result.current.announcement).toContain('Unable to connect to remote host');

		vi.mocked(window.maestro.agents.detect).mockClear();
		await act(async () => result.current.refreshAgentDetection());
		expect(window.maestro.agents.detect).toHaveBeenCalledWith('remote-1');
	});

	it('handles thrown detection errors and ignores stale completion after unmount', async () => {
		const setAvailableAgents = vi.fn();
		const setSelectedAgent = vi.fn();
		vi.mocked(window.maestro.agents.detect).mockRejectedValue(new Error('boom'));

		const { result, unmount } = renderHook(() =>
			useAgentDetection({
				sshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
				selectedAgent: null,
				setAvailableAgents,
				setSelectedAgent,
			})
		);

		await waitFor(() => expect(result.current.isDetecting).toBe(false));
		expect(result.current.sshConnectionError).toBe('boom');

		let resolveDetect: (agents: AgentConfig[]) => void = () => {};
		vi.mocked(window.maestro.agents.detect).mockReturnValue(
			new Promise((resolve) => {
				resolveDetect = resolve;
			})
		);
		const stale = renderHook(() =>
			useAgentDetection({
				sshRemoteConfig: undefined,
				selectedAgent: null,
				setAvailableAgents,
				setSelectedAgent,
			})
		);
		stale.unmount();
		await act(async () => resolveDetect([agent({ id: 'codex' })]));
		expect(setAvailableAgents).not.toHaveBeenCalledWith([expect.objectContaining({ id: 'codex' })]);
		unmount();
	});

	it('loads SSH remotes, syncs restored context, and forwards local or remote selections', async () => {
		const setWizardSessionSshRemoteConfig = vi.fn();
		vi.mocked(window.maestro.sshRemote.getConfigs).mockResolvedValue({
			success: true,
			configs: [{ id: 'remote-1', name: 'Server', host: 'host' } as any],
		});

		const { result, rerender } = renderHook(
			({ sessionSshRemoteConfig }) =>
				useSshRemotes({
					sessionSshRemoteConfig,
					setWizardSessionSshRemoteConfig,
				}),
			{ initialProps: { sessionSshRemoteConfig: undefined as any } }
		);

		await waitFor(() => expect(result.current.sshRemotes).toHaveLength(1));
		expect(window.maestro.sshRemote.getConfigs).toHaveBeenCalledTimes(1);

		act(() => result.current.handleSshRemoteChange('remote-1'));
		expect(result.current.sshRemoteConfig).toEqual({ enabled: true, remoteId: 'remote-1' });
		expect(setWizardSessionSshRemoteConfig).toHaveBeenCalledWith({
			enabled: true,
			remoteId: 'remote-1',
			workingDirOverride: undefined,
		});

		act(() => result.current.handleSshRemoteChange(''));
		expect(setWizardSessionSshRemoteConfig).toHaveBeenCalledWith({
			enabled: false,
			remoteId: null,
		});

		rerender({
			sessionSshRemoteConfig: {
				enabled: true,
				remoteId: 'remote-2',
				workingDirOverride: '/work',
			},
		});

		expect(result.current.sshRemoteConfig).toEqual({
			enabled: true,
			remoteId: 'remote-2',
			workingDirOverride: '/work',
		});
		await waitFor(() => expect(window.maestro.sshRemote.getConfigs).toHaveBeenCalledTimes(2));

		rerender({
			sessionSshRemoteConfig: {
				enabled: true,
				remoteId: 'remote-2',
				workingDirOverride: '/other-work',
			},
		});

		expect(result.current.sshRemoteConfig).toEqual({
			enabled: true,
			remoteId: 'remote-2',
			workingDirOverride: '/other-work',
		});
		expect(window.maestro.sshRemote.getConfigs).toHaveBeenCalledTimes(2);
	});

	it('swallows SSH remote load failures and reports telemetry', async () => {
		const error = new Error('no ssh');
		vi.mocked(window.maestro.sshRemote.getConfigs).mockRejectedValue(error);

		const { result } = renderHook(() =>
			useSshRemotes({
				sessionSshRemoteConfig: undefined,
				setWizardSessionSshRemoteConfig: vi.fn(),
			})
		);

		await waitFor(() => expect(window.maestro.sshRemote.getConfigs).toHaveBeenCalled());
		expect(result.current.sshRemotes).toEqual([]);
		expect(captureException).toHaveBeenCalledWith(error, {
			extra: {
				operation: 'agentSelection:loadSshRemotes',
				sessionRemoteEnabled: false,
				sessionRemoteId: null,
			},
		});
	});

	it('handles unsuccessful SSH remote config responses', async () => {
		vi.mocked(window.maestro.sshRemote.getConfigs).mockResolvedValue({
			success: false,
			error: 'Failed to load',
		});

		const { result } = renderHook(() =>
			useSshRemotes({
				sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
				setWizardSessionSshRemoteConfig: vi.fn(),
			})
		);

		await waitFor(() => expect(window.maestro.sshRemote.getConfigs).toHaveBeenCalled());
		expect(result.current.sshRemotes).toEqual([]);
		expect(captureException).toHaveBeenCalledWith(expect.any(Error), {
			extra: {
				operation: 'agentSelection:loadSshRemotes',
				sessionRemoteEnabled: true,
				sessionRemoteId: 'remote-1',
				error: 'Failed to load',
			},
		});
		expect((vi.mocked(captureException).mock.calls[0][0] as Error).message).toBe('Failed to load');
	});

	it('focuses name field for one selectable agent and tile for multiple selectable agents', () => {
		const { refs, nameInput, secondTile } = createRefs();
		const setFocusedTileIndex = vi.fn();
		const setIsNameFieldFocused = vi.fn();
		const { rerender } = renderHook(
			({ detectedAgents, selectedAgent }) =>
				useAgentSelectionFocus({
					tiles: AGENT_TILES,
					isDetecting: false,
					selectedAgent,
					detectedAgents,
					refs,
					setFocusedTileIndex,
					setIsNameFieldFocused,
				}),
			{
				initialProps: {
					detectedAgents: [agent({ id: FIRST_TILE_ID, available: true })],
					selectedAgent: null as string | null,
				},
			}
		);

		expect(nameInput.focus).toHaveBeenCalled();
		expect(setIsNameFieldFocused).toHaveBeenCalledWith(true);

		// Tile order is alphabetical and grows with every new provider, so drive
		// the assertion off the strip rather than off two hard-coded ids.
		rerender({
			detectedAgents: [
				agent({ id: FIRST_TILE_ID, available: true }),
				agent({ id: SECOND_TILE_ID, available: true }),
			],
			selectedAgent: SECOND_TILE_ID,
		});

		expect(setFocusedTileIndex).toHaveBeenCalledWith(1);
		expect(secondTile.focus).toHaveBeenCalled();
	});

	it('handles keyboard navigation, field focus, selection, and continue', () => {
		const { refs, nameInput, secondTile } = createRefs();
		const setFocusedTileIndex = vi.fn();
		const setIsNameFieldFocused = vi.fn();
		const setSelectedAgent = vi.fn();
		const nextStep = vi.fn();
		const preventDefault = vi.fn();

		const { result, rerender } = renderHook(
			({ isNameFieldFocused, focusedTileIndex }) =>
				useAgentSelectionKeyboard({
					tiles: AGENT_TILES,
					tileColumns: AGENT_TILES.length,
					isNameFieldFocused,
					focusedTileIndex,
					detectedAgents: [
						agent({ id: FIRST_TILE_ID, available: true }),
						agent({ id: SECOND_TILE_ID, available: true }),
					],
					nameInputRef: refs.nameInputRef,
					tileRefs: refs.tileRefs,
					setIsNameFieldFocused,
					setFocusedTileIndex,
					setSelectedAgent,
					canProceedToNext: () => true,
					nextStep,
				}),
			{ initialProps: { isNameFieldFocused: false, focusedTileIndex: 0 } }
		);

		act(() => result.current({ key: 'ArrowRight', preventDefault } as any));
		expect(setFocusedTileIndex).toHaveBeenCalledWith(1);
		expect(secondTile.focus).toHaveBeenCalled();

		act(() => result.current({ key: 'Tab', shiftKey: false, preventDefault } as any));
		expect(setIsNameFieldFocused).toHaveBeenCalledWith(true);
		expect(nameInput.focus).toHaveBeenCalled();

		act(() => result.current({ key: ' ', preventDefault } as any));
		expect(setSelectedAgent).toHaveBeenCalledWith(FIRST_TILE_ID);

		act(() => result.current({ key: 'Enter', preventDefault } as any));
		expect(nextStep).toHaveBeenCalledTimes(1);

		rerender({ isNameFieldFocused: true, focusedTileIndex: 0 });
		act(() => result.current({ key: 'Tab', shiftKey: true, preventDefault } as any));
		expect(setFocusedTileIndex).toHaveBeenCalledWith(1);
	});

	it('navigates the filtered strip, not the full provider registry', () => {
		// With unavailable providers hidden, the strip is two tiles long. Clamping
		// on the registry would let the focus ring walk past what is drawn.
		const { refs, secondTile } = createRefs();
		const setFocusedTileIndex = vi.fn();
		const preventDefault = vi.fn();
		const visibleTiles = AGENT_TILES.slice(0, 2);

		const { result } = renderHook(
			({ focusedTileIndex }) =>
				useAgentSelectionKeyboard({
					tiles: visibleTiles,
					tileColumns: visibleTiles.length,
					isNameFieldFocused: false,
					focusedTileIndex,
					detectedAgents: [
						agent({ id: FIRST_TILE_ID, available: true }),
						agent({ id: SECOND_TILE_ID, available: true }),
					],
					nameInputRef: refs.nameInputRef,
					tileRefs: refs.tileRefs,
					setIsNameFieldFocused: vi.fn(),
					setFocusedTileIndex,
					setSelectedAgent: vi.fn(),
					canProceedToNext: () => true,
					nextStep: vi.fn(),
				}),
			{ initialProps: { focusedTileIndex: 1 } }
		);

		act(() => result.current({ key: 'ArrowRight', preventDefault } as any));
		expect(setFocusedTileIndex).not.toHaveBeenCalled();

		act(() => result.current({ key: 'ArrowLeft', preventDefault } as any));
		expect(setFocusedTileIndex).toHaveBeenCalledWith(0);

		// The strip scrolls the focused tile into view itself, so the browser's own
		// scroll must be suppressed or it parks the tile under an edge fade first.
		expect(secondTile.focus).not.toHaveBeenCalled();
	});

	it('steps a whole row on up/down once the tiles wrap', () => {
		// A filtered list short enough to wrap is drawn as rows, so up/down have
		// somewhere to go. The row width comes from the grid's own measurement -
		// assuming one here would jump the ring to a tile that is not below the
		// current one.
		const { refs } = createRefs();
		const setFocusedTileIndex = vi.fn();
		const preventDefault = vi.fn();
		const visibleTiles = AGENT_TILES.slice(0, 5);

		const { result } = renderHook(
			({ focusedTileIndex }) =>
				useAgentSelectionKeyboard({
					tiles: visibleTiles,
					tileColumns: 3,
					isNameFieldFocused: false,
					focusedTileIndex,
					detectedAgents: visibleTiles.map((tile) => agent({ id: tile.id, available: true })),
					nameInputRef: refs.nameInputRef,
					tileRefs: refs.tileRefs,
					setIsNameFieldFocused: vi.fn(),
					setFocusedTileIndex,
					setSelectedAgent: vi.fn(),
					canProceedToNext: () => true,
					nextStep: vi.fn(),
				}),
			{ initialProps: { focusedTileIndex: 0 } }
		);

		act(() => result.current({ key: 'ArrowDown', preventDefault } as any));
		expect(setFocusedTileIndex).toHaveBeenLastCalledWith(3);

		act(() => result.current({ key: 'ArrowUp', preventDefault } as any));
		expect(setFocusedTileIndex).toHaveBeenCalledTimes(1);
	});

	it('suppresses the browser scroll when moving focus onto a tile', () => {
		const { refs, secondTile } = createRefs();
		const preventDefault = vi.fn();

		const { result } = renderHook(() =>
			useAgentSelectionKeyboard({
				tiles: AGENT_TILES,
				tileColumns: AGENT_TILES.length,
				isNameFieldFocused: false,
				focusedTileIndex: 0,
				detectedAgents: [
					agent({ id: FIRST_TILE_ID, available: true }),
					agent({ id: SECOND_TILE_ID, available: true }),
				],
				nameInputRef: refs.nameInputRef,
				tileRefs: refs.tileRefs,
				setIsNameFieldFocused: vi.fn(),
				setFocusedTileIndex: vi.fn(),
				setSelectedAgent: vi.fn(),
				canProceedToNext: () => true,
				nextStep: vi.fn(),
			})
		);

		act(() => result.current({ key: 'ArrowRight', preventDefault } as any));
		expect(secondTile.focus).toHaveBeenCalledWith({ preventScroll: true });
	});

	it('leaves keys alone for a control that opts out of strip navigation', () => {
		// The keydown handler covers the whole screen, so the availability bar's
		// toggle would otherwise lose its own Tab and arrow keys to tile movement.
		const { refs } = createRefs();
		const setFocusedTileIndex = vi.fn();
		const setIsNameFieldFocused = vi.fn();
		const preventDefault = vi.fn();

		const exempt = document.createElement('label');
		exempt.setAttribute('data-provider-bar-nav-exempt', 'true');
		const toggle = document.createElement('button');
		exempt.appendChild(toggle);

		const { result } = renderHook(() =>
			useAgentSelectionKeyboard({
				tiles: AGENT_TILES,
				tileColumns: AGENT_TILES.length,
				isNameFieldFocused: false,
				focusedTileIndex: 0,
				detectedAgents: [agent({ id: FIRST_TILE_ID, available: true })],
				nameInputRef: refs.nameInputRef,
				tileRefs: refs.tileRefs,
				setIsNameFieldFocused,
				setFocusedTileIndex,
				setSelectedAgent: vi.fn(),
				canProceedToNext: () => true,
				nextStep: vi.fn(),
			})
		);

		act(() => result.current({ key: 'ArrowRight', preventDefault, target: toggle } as any));
		act(() =>
			result.current({ key: 'Tab', shiftKey: false, preventDefault, target: toggle } as any)
		);

		expect(setFocusedTileIndex).not.toHaveBeenCalled();
		expect(setIsNameFieldFocused).not.toHaveBeenCalled();
		expect(preventDefault).not.toHaveBeenCalled();
	});

	it('opens and closes config panel, loading config and models with SSH ID', async () => {
		vi.useFakeTimers();
		vi.mocked(window.maestro.agents.getConfig).mockResolvedValue({ model: 'old' });
		vi.mocked(window.maestro.agents.getModels).mockResolvedValue(['gpt-5']);
		const showConfigView = vi.fn();
		const showGridView = vi.fn();
		const announce = vi.fn();
		const setWizardSessionSshRemoteConfig = vi.fn();

		const { result } = renderHook(() =>
			useAgentConfigurationPanel({
				detectedAgents: [
					agent({
						id: 'codex',
						available: true,
						capabilities: { supportsModelSelection: true } as any,
					}),
				],
				sshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
				configuringAgentId: 'codex',
				setConfiguringAgentId: vi.fn(),
				setSelectedAgent: vi.fn(),
				setWizardCustomPath: vi.fn(),
				setWizardCustomArgs: vi.fn(),
				setWizardCustomEnvVars: vi.fn(),
				setWizardSessionSshRemoteConfig,
				customPath: '/bin/codex',
				customEnvVars: {},
				refreshAgentDetection: vi.fn(),
				showConfigView,
				showGridView,
				announce,
			})
		);

		await act(async () => {
			await result.current.handleOpenConfig('codex');
		});

		expect(window.maestro.agents.getConfig).toHaveBeenCalledWith('codex');
		expect(window.maestro.agents.getModels).toHaveBeenCalledWith('codex', false, 'remote-1');
		expect(result.current.agentConfig).toEqual({ model: 'old' });
		expect(result.current.availableModels).toEqual(['gpt-5']);
		expect(showConfigView).toHaveBeenCalledTimes(1);
		expect(announce).toHaveBeenCalledWith('Configuring Codex');

		const loadError = new Error('load failed');
		vi.mocked(window.maestro.agents.getModels).mockRejectedValueOnce(loadError);
		await act(async () => {
			await result.current.handleOpenConfig('codex');
		});
		expect(captureException).toHaveBeenCalledWith(loadError, {
			extra: {
				operation: 'agentSelection:loadModels',
				agentId: 'codex',
				remoteMode: true,
			},
		});

		act(() => result.current.handleCloseConfig());
		expect(setWizardSessionSshRemoteConfig).toHaveBeenCalledWith({
			enabled: true,
			remoteId: 'remote-1',
			workingDirOverride: undefined,
		});
		expect(showGridView).toHaveBeenCalledWith('codex');
	});

	it('handles custom config, env vars, model refresh, agent refresh, and config persistence', async () => {
		const setWizardCustomPath = vi.fn();
		const setWizardCustomArgs = vi.fn();
		const setWizardCustomEnvVars = vi.fn();
		const refreshAgentDetection = vi.fn();
		vi.mocked(window.maestro.agents.getModels).mockResolvedValue(['model-a']);

		const { result } = renderHook(() =>
			useAgentConfigurationPanel({
				detectedAgents: [agent({ id: 'codex' })],
				sshRemoteConfig: undefined,
				configuringAgentId: 'codex',
				setConfiguringAgentId: vi.fn(),
				setSelectedAgent: vi.fn(),
				setWizardCustomPath,
				setWizardCustomArgs,
				setWizardCustomEnvVars,
				setWizardSessionSshRemoteConfig: vi.fn(),
				customPath: '/bin/codex',
				customEnvVars: { OLD: '1' },
				refreshAgentDetection,
				showConfigView: vi.fn(),
				showGridView: vi.fn(),
				announce: vi.fn(),
			})
		);

		act(() => result.current.setCustomPath(''));
		act(() => result.current.setCustomArgs('--flag'));
		act(() => result.current.handleEnvVarKeyChange('OLD', 'NEW', '2'));
		act(() => result.current.handleEnvVarValueChange('OLD', '3'));
		act(() => result.current.handleEnvVarRemove('OLD'));
		act(() => result.current.handleEnvVarAdd());
		act(() => result.current.handleConfigChange('model', 'gpt-5'));

		await act(async () => result.current.handleConfigBlur('model', 'gpt-5'));
		await act(async () => result.current.handleCustomPathBlur());
		await act(async () => result.current.handleRefreshModels());
		const refreshError = new Error('refresh failed');
		vi.mocked(window.maestro.agents.getModels).mockRejectedValueOnce(refreshError);
		await act(async () => result.current.handleRefreshModels());
		await act(async () => result.current.handleRefreshAgent());

		expect(setWizardCustomPath).toHaveBeenCalledWith(undefined);
		expect(setWizardCustomArgs).toHaveBeenCalledWith('--flag');
		expect(setWizardCustomEnvVars).toHaveBeenCalledWith({ NEW: '2' });
		expect(setWizardCustomEnvVars).toHaveBeenCalledWith({ OLD: '3' });
		expect(setWizardCustomEnvVars).toHaveBeenCalledWith(undefined);
		expect(setWizardCustomEnvVars).toHaveBeenCalledWith({ OLD: '1', '': '' });
		expect(window.maestro.agents.setConfig).toHaveBeenCalledWith('codex', { model: 'gpt-5' });
		expect(window.maestro.agents.setCustomPath).toHaveBeenCalledWith('codex', '/bin/codex');
		expect(window.maestro.agents.getModels).toHaveBeenCalledWith('codex', true, undefined);
		expect(captureException).toHaveBeenCalledWith(refreshError, {
			extra: {
				operation: 'agentSelection:refreshModels',
				agentId: 'codex',
				remoteMode: false,
			},
		});
		expect(refreshAgentDetection).toHaveBeenCalledTimes(2);
	});
	describe('Grok configuration discovery', () => {
		let args: Parameters<typeof useAgentConfigurationPanel>[0];
		beforeEach(() => {
			vi.useFakeTimers();
			wizardState = { ...wizardState, selectedAgent: 'grok' };
			args = {
				detectedAgents: [
					agent({
						id: 'grok',
						configOptions: [
							{ key: 'model', type: 'text', label: 'Model', description: 'Model', default: '' },
							{
								key: 'reasoningEffort',
								type: 'text',
								label: 'Effort',
								description: 'Effort',
								default: '',
							},
						],
					}),
				],
				configuringAgentId: 'grok',
				sshRemoteConfig: undefined,
				customPath: '/bin/grok',
				customEnvVars: {},
				setConfiguringAgentId: vi.fn(),
				setSelectedAgent: vi.fn(),
				setWizardCustomPath: vi.fn(),
				setWizardCustomArgs: vi.fn(),
				setWizardCustomEnvVars: vi.fn(),
				setWizardSessionSshRemoteConfig: vi.fn(),
				refreshAgentDetection: vi.fn(),
				showConfigView: vi.fn(),
				showGridView: vi.fn(),
				announce: vi.fn(),
			};
			vi.mocked(window.maestro.agents.getConfig).mockResolvedValue({
				model: 'manual-model',
				reasoningEffort: 'manual-effort',
			});
			vi.mocked(window.maestro.agents.getModels).mockResolvedValue({
				status: 'discovered',
				options: ['catalog-model'],
			} as never);
			vi.mocked(window.maestro.agents.getConfigOptions).mockResolvedValue({
				status: 'discovered',
				options: ['high'],
			} as never);
		});

		it.each([undefined, {}, { GROK_HOME: '' }] as (Record<string, string> | undefined)[])(
			'preserves raw environment %j and provider-setting clears',
			async (customEnvVars) => {
				wizardState = { ...wizardState, customEnvVars };
				const { result } = renderHook(() => useAgentConfigurationPanel(args));
				await act(async () => result.current.handleOpenConfig('grok'));
				await act(async () => vi.advanceTimersByTimeAsync(300));
				expect(window.maestro.agents.getModels).toHaveBeenLastCalledWith({
					providerId: 'grok',
					context: {
						kind: 'provider-settings',
						cwd: '/project',
						customPath: '/bin/grok',
						customEnvVars,
						model: 'manual-model',
						effort: 'manual-effort',
						sessionSshRemoteConfig: undefined,
					},
				});
				act(() => {
					result.current.handleConfigChange('model', '');
					result.current.handleConfigChange('reasoningEffort', '');
				});
				expect(result.current.availableModels).toEqual([]);
				await act(async () => vi.advanceTimersByTimeAsync(300));
				expect(window.maestro.agents.getModels).toHaveBeenLastCalledWith({
					providerId: 'grok',
					context: expect.objectContaining({ model: '', effort: '', customEnvVars }),
				});
				expect(result.current.agentConfig).toEqual({ model: '', reasoningEffort: '' });
			}
		);

		it.each(['unavailable', 'configured-fallback', 'discovered'] as const)(
			'keeps manual values with %s metadata and counts only discovered options',
			async (status) => {
				vi.mocked(window.maestro.agents.getModels).mockResolvedValue({
					status,
					options: status === 'unavailable' ? [] : ['catalog-model'],
				} as never);
				const { result } = renderHook(() => useAgentConfigurationPanel(args));
				await act(async () => result.current.handleOpenConfig('grok'));
				act(() => result.current.handleConfigChange('model', 'typed-model'));
				act(() => result.current.handleConfigChange('reasoningEffort', 'typed-effort'));
				await act(async () => vi.advanceTimersByTimeAsync(300));
				expect(result.current.modelDiscoveryStatus).toBe(status);
				expect(result.current.availableModels).toEqual(
					status === 'discovered' ? ['catalog-model'] : []
				);
				expect(result.current.agentConfig).toEqual({
					model: 'typed-model',
					reasoningEffort: 'typed-effort',
				});
				if (status !== 'discovered')
					expect(result.current.detectedConfigAgent?.configOptions?.[0].description).toContain(
						'Discovery is unavailable'
					);
			}
		);

		it.each(['missing cwd', 'unresolved SSH'])(
			'forwards %s for host refusal without inventing a local target',
			async (missing) => {
				if (missing === 'missing cwd') wizardState = { ...wizardState, directoryPath: '' };
				else args = { ...args, sshRemoteConfig: { enabled: true, remoteId: '' } };
				vi.mocked(window.maestro.agents.getModels).mockResolvedValue({
					status: 'unavailable',
					options: [],
				} as never);
				const { result } = renderHook(() => useAgentConfigurationPanel(args));
				await act(async () => result.current.handleOpenConfig('grok'));
				await act(async () => vi.advanceTimersByTimeAsync(300));
				expect(window.maestro.agents.getModels).toHaveBeenLastCalledWith({
					providerId: 'grok',
					context: expect.objectContaining({
						cwd: wizardState.directoryPath,
						sessionSshRemoteConfig: args.sshRemoteConfig,
					}),
				});
				expect(result.current.availableModels).toEqual([]);
				expect(result.current.modelDiscoveryStatus).toBe('unavailable');
				expect(result.current.agentConfig.model).toBe('manual-model');
				expect(result.current.detectedConfigAgent?.configOptions?.[0].description).toContain(
					missing === 'missing cwd'
						? 'until a project directory is selected'
						: 'Manual values are preserved'
				);
			}
		);

		it.each(['account', 'executable', 'remote', 'cwd'] as const)(
			'rejects late options after a changed %s selection',
			async (change) => {
				let resolveModels!: (value: AgentDiscoveryResult) => void;
				vi.mocked(window.maestro.agents.getModels).mockReturnValueOnce(
					new Promise<AgentDiscoveryResult>((resolve) => {
						resolveModels = resolve;
					}) as never
				);
				const { result, rerender } = renderHook(() => useAgentConfigurationPanel(args));
				await act(async () => result.current.handleOpenConfig('grok'));
				await act(async () => vi.advanceTimersByTimeAsync(300));
				if (change === 'account')
					wizardState = { ...wizardState, customEnvVars: { GROK_HOME: '/accounts/second' } };
				if (change === 'cwd') wizardState = { ...wizardState, directoryPath: '/other-project' };
				if (change === 'executable') args = { ...args, customPath: '/other/grok' };
				if (change === 'remote')
					args = { ...args, sshRemoteConfig: { enabled: true, remoteId: 'remote-2' } };
				rerender();
				await act(async () => resolveModels({ status: 'discovered', options: ['stale-model'] }));
				expect(result.current.availableModels).toEqual([]);
				await act(async () => vi.advanceTimersByTimeAsync(300));
				expect(result.current.availableModels).toEqual(['catalog-model']);
				expect(result.current.agentConfig).toEqual({
					model: 'manual-model',
					reasoningEffort: 'manual-effort',
				});
				expect(window.maestro.agents.getModels).toHaveBeenLastCalledWith({
					providerId: 'grok',
					context: expect.objectContaining({
						cwd: wizardState.directoryPath,
						customEnvVars: wizardState.customEnvVars,
						customPath: args.customPath,
						sessionSshRemoteConfig: args.sshRemoteConfig,
					}),
				});
			}
		);
	});
});
