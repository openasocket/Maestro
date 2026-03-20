/**
 * GroupChatModal.tsx
 *
 * Unified modal for creating and editing Group Chats. Supports two modes:
 * - 'create': Empty initial state, "Create" button, Beta badge, description text
 * - 'edit': Pre-populated from existing group chat, "Save" button, moderator change warning
 *
 * Allows user to:
 * - Select a moderator agent from a dropdown of available agents
 * - Customize moderator settings (CLI args, path, ENV vars) via expandable panel
 * - Enter/edit a name for the group chat
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import {
	X,
	Settings,
	ChevronDown,
	Check,
	BookTemplate,
	Users,
	Star,
	ChevronRight,
	Sparkles,
} from 'lucide-react';
import { isBetaAgent } from '../../shared/agentMetadata';
import type { TeamTemplate } from '../../shared/group-chat-types';
import type { Theme, AgentConfig, ModeratorConfig, GroupChat } from '../types';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { Modal, ModalFooter, FormInput } from './ui';
import { AGENT_TILES } from './Wizard/screens/AgentSelectionScreen';
import { AgentConfigPanel } from './shared/AgentConfigPanel';
import { SshRemoteSelector } from './shared/SshRemoteSelector';
import { TemplateBrowserModal } from './TemplateBrowserModal';
import { useAgentConfiguration } from '../hooks/agent';
import { useSettingsStore } from '../stores/settingsStore';
import { useModalStore } from '../stores/modalStore';

interface GroupChatModalCreateProps {
	mode: 'create';
	theme: Theme;
	isOpen: boolean;
	onClose: () => void;
	onCreate: (name: string, moderatorAgentId: string, moderatorConfig?: ModeratorConfig) => void;
	groupChat?: undefined;
	onSave?: undefined;
}

interface GroupChatModalEditProps {
	mode: 'edit';
	theme: Theme;
	isOpen: boolean;
	onClose: () => void;
	onSave: (
		id: string,
		name: string,
		moderatorAgentId: string,
		moderatorConfig?: ModeratorConfig
	) => void;
	groupChat: GroupChat | null;
	onCreate?: undefined;
}

type GroupChatModalProps = GroupChatModalCreateProps | GroupChatModalEditProps;

export function GroupChatModal(props: GroupChatModalProps): JSX.Element | null {
	const { mode, theme, isOpen, onClose } = props;
	const groupChat = mode === 'edit' ? props.groupChat : undefined;

	const [name, setName] = useState('');
	// Track if user has visited/modified the config panel (edit mode only)
	const [configWasModified, setConfigWasModified] = useState(false);

	// Template state (create mode only)
	const [templates, setTemplates] = useState<TeamTemplate[]>([]);
	const [selectedTemplate, setSelectedTemplate] = useState<TeamTemplate | null>(null);
	const [showTemplateBrowser, setShowTemplateBrowser] = useState(false);

	// Feature flags for templates
	const encoreFeatures = useSettingsStore((s) => s.encoreFeatures);
	const teamOrchestrationSettings = useSettingsStore((s) => s.teamOrchestrationSettings);
	const templatesEnabled =
		encoreFeatures.teamOrchestration && teamOrchestrationSettings.enableTemplates;

	const nameInputRef = useRef<HTMLInputElement>(null);

	// Use centralized agent configuration hook
	const ac = useAgentConfiguration({
		enabled: isOpen,
		loadSshRemotes: true,
		autoSelect: false, // We handle auto-select with AGENT_TILES priority
	});

	// Initialize state from groupChat when modal opens (edit mode)
	useEffect(() => {
		if (mode !== 'edit' || !isOpen || !groupChat) {
			return;
		}

		// Pre-populate from existing group chat
		setName(groupChat.name);
		ac.setSelectedAgent(groupChat.moderatorAgentId);
		ac.setCustomPath(groupChat.moderatorConfig?.customPath || '');
		ac.setCustomArgs(groupChat.moderatorConfig?.customArgs || '');
		ac.setCustomEnvVars(groupChat.moderatorConfig?.customEnvVars || {});
		ac.setSshRemoteConfig(groupChat.moderatorConfig?.sshRemoteConfig as any);
	}, [mode, isOpen, groupChat]);

	// Focus name input when agents detected
	useEffect(() => {
		if (!ac.isDetecting && isOpen) {
			nameInputRef.current?.focus();
		}
	}, [ac.isDetecting, isOpen]);

	// Auto-select first supported agent (create mode only) after detection,
	// and revalidate if current selection is no longer available
	useEffect(() => {
		if (mode !== 'create' || ac.isDetecting) return;

		if (ac.detectedAgents.length === 0) {
			ac.setSelectedAgent(null);
			return;
		}

		// If current selection is still valid, keep it
		if (ac.selectedAgent && ac.detectedAgents.some((a) => a.id === ac.selectedAgent)) return;

		const firstSupported = AGENT_TILES.find((tile) => {
			if (!tile.supported) return false;
			return ac.detectedAgents.some((a: AgentConfig) => a.id === tile.id);
		});
		if (firstSupported) {
			ac.setSelectedAgent(firstSupported.id);
		} else {
			ac.setSelectedAgent(ac.detectedAgents[0].id);
		}
	}, [mode, ac.isDetecting, ac.detectedAgents, ac.selectedAgent, ac.setSelectedAgent]);

	// Reset local state when modal closes
	useEffect(() => {
		if (!isOpen) {
			setName('');
			setConfigWasModified(false);
			setSelectedTemplate(null);
		}
	}, [isOpen]);

	// Load templates when create mode modal opens and feature is enabled
	useEffect(() => {
		if (mode !== 'create' || !isOpen || !templatesEnabled) {
			setTemplates([]);
			return;
		}
		window.maestro.teamTemplates
			.list()
			.then(setTemplates)
			.catch(() => setTemplates([]));
	}, [mode, isOpen, templatesEnabled]);

	// Apply a template to the form
	const applyTemplate = useCallback(
		(template: TeamTemplate) => {
			setSelectedTemplate(template);
			// Set moderator agent from template
			if (ac.detectedAgents.some((a) => a.id === template.moderatorAgentId)) {
				ac.setSelectedAgent(template.moderatorAgentId);
			}
			// Apply moderator config from template
			if (template.moderatorConfig?.customArgs) {
				ac.setCustomArgs(template.moderatorConfig.customArgs);
			}
			if (
				template.moderatorConfig?.customEnvVars &&
				Object.keys(template.moderatorConfig.customEnvVars).length > 0
			) {
				ac.setCustomEnvVars(template.moderatorConfig.customEnvVars);
			}
		},
		[ac]
	);

	// Handle template selection from browser modal
	const handleBrowserTemplateSelect = useCallback(
		(template: TeamTemplate) => {
			applyTemplate(template);
			setShowTemplateBrowser(false);
		},
		[applyTemplate]
	);

	// Build moderator config from state
	const buildModeratorConfig = useCallback((): ModeratorConfig | undefined => {
		const customModelValue = ac.agentConfig.model;
		const hasConfig =
			ac.customPath ||
			ac.customArgs ||
			Object.keys(ac.customEnvVars).length > 0 ||
			customModelValue ||
			ac.sshRemoteConfig;
		if (!hasConfig) return undefined;

		return {
			customPath: ac.customPath || undefined,
			customArgs: ac.customArgs || undefined,
			customEnvVars: Object.keys(ac.customEnvVars).length > 0 ? ac.customEnvVars : undefined,
			customModel: customModelValue || undefined,
			sshRemoteConfig: ac.sshRemoteConfig || undefined,
		};
	}, [ac.customPath, ac.customArgs, ac.customEnvVars, ac.agentConfig.model, ac.sshRemoteConfig]);

	const handleSubmit = useCallback(() => {
		if (!name.trim() || !ac.selectedAgent) return;

		const moderatorConfig = buildModeratorConfig();

		if (mode === 'create') {
			props.onCreate(name.trim(), ac.selectedAgent, moderatorConfig);
		} else if (groupChat) {
			props.onSave(groupChat.id, name.trim(), ac.selectedAgent, moderatorConfig);
		}

		setName('');
		setConfigWasModified(false);
		onClose();
	}, [name, ac.selectedAgent, buildModeratorConfig, mode, props, groupChat, onClose]);

	// Check if anything has changed (edit mode only)
	const hasChanges = useCallback((): boolean => {
		if (!groupChat) return false;

		const nameChanged = name.trim() !== groupChat.name;
		const agentChanged = ac.selectedAgent !== groupChat.moderatorAgentId;
		const pathChanged = ac.customPath !== (groupChat.moderatorConfig?.customPath || '');
		const argsChanged = ac.customArgs !== (groupChat.moderatorConfig?.customArgs || '');

		const originalEnvVars = groupChat.moderatorConfig?.customEnvVars || {};
		const envVarsChanged = JSON.stringify(ac.customEnvVars) !== JSON.stringify(originalEnvVars);

		const originalSshConfig = groupChat.moderatorConfig?.sshRemoteConfig;
		const sshChanged = JSON.stringify(ac.sshRemoteConfig) !== JSON.stringify(originalSshConfig);

		return (
			nameChanged ||
			agentChanged ||
			pathChanged ||
			argsChanged ||
			envVarsChanged ||
			sshChanged ||
			configWasModified
		);
	}, [
		groupChat,
		name,
		ac.selectedAgent,
		ac.customPath,
		ac.customArgs,
		ac.customEnvVars,
		ac.sshRemoteConfig,
		configWasModified,
	]);

	const canSubmit =
		name.trim().length > 0 && ac.selectedAgent !== null && (mode === 'create' || hasChanges());

	if (!isOpen) return null;
	if (mode === 'edit' && !groupChat) return null;

	// Filter AGENT_TILES to only show supported + detected agents
	const availableTiles = AGENT_TILES.filter((tile) => {
		if (!tile.supported) return false;
		return ac.detectedAgents.some((a: AgentConfig) => a.id === tile.id);
	});

	// Get selected agent info
	const selectedAgentConfig = ac.detectedAgents.find((a) => a.id === ac.selectedAgent);
	const selectedTile = AGENT_TILES.find((t) => t.id === ac.selectedAgent);

	const isCreate = mode === 'create';
	const modalTitle = isCreate ? 'New Group Chat' : 'Edit Group Chat';
	const modalPriority = isCreate
		? MODAL_PRIORITIES.NEW_GROUP_CHAT
		: MODAL_PRIORITIES.EDIT_GROUP_CHAT;

	return (
		<Modal
			theme={theme}
			title={modalTitle}
			priority={modalPriority}
			onClose={onClose}
			initialFocusRef={nameInputRef}
			width={600}
			customHeader={
				isCreate ? (
					<div
						className="p-4 border-b flex items-center justify-between shrink-0"
						style={{ borderColor: theme.colors.border }}
					>
						<div className="flex items-center gap-3">
							<h2 className="text-sm font-bold" style={{ color: theme.colors.textMain }}>
								New Group Chat
							</h2>
							<span
								className="text-[10px] font-semibold tracking-wide uppercase px-2 py-0.5 rounded"
								style={{
									backgroundColor: `${theme.colors.accent}20`,
									color: theme.colors.accent,
									border: `1px solid ${theme.colors.accent}40`,
								}}
							>
								Beta
							</span>
						</div>
						<button
							type="button"
							onClick={onClose}
							className="p-1 rounded hover:bg-white/10 transition-colors"
							style={{ color: theme.colors.textDim }}
							aria-label="Close modal"
						>
							<X className="w-4 h-4" />
						</button>
					</div>
				) : undefined
			}
			footer={
				<ModalFooter
					theme={theme}
					onCancel={onClose}
					onConfirm={handleSubmit}
					confirmLabel={isCreate ? 'Create' : 'Save'}
					confirmDisabled={!canSubmit}
				/>
			}
		>
			<div>
				{/* Description (create mode only) */}
				{isCreate && (
					<div className="mb-6 text-sm leading-relaxed" style={{ color: theme.colors.textDim }}>
						A Group Chat lets you collaborate with multiple AI agents in a single conversation. The{' '}
						<span style={{ color: theme.colors.textMain }}>moderator</span> manages the conversation
						flow, deciding when to involve other agents. You can{' '}
						<span style={{ color: theme.colors.accent }}>@mention</span> any agent defined in
						Maestro to bring them into the discussion. We're still working on this feature, but
						right now Claude appears to be the best performing moderator.
					</div>
				)}

				{/* Build with AI (create mode only, gated behind teamOrchestration) */}
				{isCreate && encoreFeatures.teamOrchestration && (
					<div className="mb-6">
						<button
							type="button"
							onClick={() => {
								onClose();
								useModalStore.getState().openModal('teamBuilderWizard');
							}}
							className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg border transition-colors hover:bg-white/5"
							style={{
								borderColor: theme.colors.accent,
								color: theme.colors.accent,
								backgroundColor: `${theme.colors.accent}10`,
							}}
						>
							<Sparkles className="w-4 h-4" />
							<span className="text-sm font-medium">Build with AI</span>
						</button>
					</div>
				)}

				{/* Start from Template (create mode only, gated behind feature flag) */}
				{isCreate && templatesEnabled && templates.length > 0 && (
					<div className="mb-6">
						<div className="flex items-center justify-between mb-2">
							<label
								className="block text-xs font-bold opacity-70 uppercase"
								style={{ color: theme.colors.textMain }}
							>
								Start from Template
							</label>
							<button
								type="button"
								onClick={() => setShowTemplateBrowser(true)}
								className="flex items-center gap-1 text-xs transition-colors hover:underline"
								style={{ color: theme.colors.accent }}
							>
								Browse All Templates
								<ChevronRight className="w-3 h-3" />
							</button>
						</div>
						<div className="flex gap-2 pb-2 overflow-x-auto scrollbar-thin">
							{templates.map((template) => {
								const isActive = selectedTemplate?.id === template.id;
								return (
									<button
										key={template.id}
										type="button"
										onClick={() => applyTemplate(template)}
										className="shrink-0 flex flex-col gap-1.5 p-3 rounded-lg border text-left transition-colors"
										style={{
											width: 180,
											borderColor: isActive ? theme.colors.accent : theme.colors.border,
											backgroundColor: isActive ? `${theme.colors.accent}10` : 'transparent',
										}}
									>
										<div className="flex items-center gap-2">
											{template.category === 'builtin' ? (
												<Star
													className="w-3.5 h-3.5 shrink-0"
													style={{ color: theme.colors.accent }}
												/>
											) : (
												<BookTemplate
													className="w-3.5 h-3.5 shrink-0"
													style={{ color: theme.colors.accent }}
												/>
											)}
											<span
												className="text-xs font-medium truncate"
												style={{ color: theme.colors.textMain }}
											>
												{template.name}
											</span>
										</div>
										<p className="text-[11px] line-clamp-2" style={{ color: theme.colors.textDim }}>
											{template.description}
										</p>
										<div
											className="flex items-center gap-1"
											style={{ color: theme.colors.textDim }}
										>
											<Users className="w-3 h-3" />
											<span className="text-[10px]">
												{template.roles.length} role
												{template.roles.length !== 1 ? 's' : ''}
											</span>
										</div>
									</button>
								);
							})}
						</div>
						{selectedTemplate && (
							<div
								className="mt-2 text-xs px-3 py-2 rounded"
								style={{
									backgroundColor: `${theme.colors.accent}10`,
									color: theme.colors.textDim,
									border: `1px solid ${theme.colors.accent}20`,
								}}
							>
								<span style={{ color: theme.colors.textMain }}>{selectedTemplate.name}:</span>{' '}
								{selectedTemplate.description}
								{selectedTemplate.roles.length > 0 && (
									<span>
										{' '}
										&mdash; Roles: {selectedTemplate.roles.map((r) => r.name).join(', ')}
									</span>
								)}
							</div>
						)}
					</div>
				)}

				{/* Template Browser Modal */}
				{showTemplateBrowser && (
					<TemplateBrowserModal
						theme={theme}
						isOpen={showTemplateBrowser}
						onClose={() => setShowTemplateBrowser(false)}
						onSelect={handleBrowserTemplateSelect}
					/>
				)}

				{/* Name Input (edit mode: before moderator, create mode: after) */}
				{!isCreate && (
					<div className="mb-6">
						<FormInput
							ref={nameInputRef}
							theme={theme}
							label="Chat Name"
							value={name}
							onChange={setName}
							onSubmit={canSubmit ? handleSubmit : undefined}
							placeholder="e.g., Auth Feature Implementation"
						/>
					</div>
				)}

				{/* Moderator Selection - Dropdown with Customize button */}
				<div className="mb-6">
					<label
						className="block text-xs font-bold opacity-70 uppercase mb-2"
						style={{ color: theme.colors.textMain }}
					>
						{isCreate ? 'Select Moderator' : 'Moderator Agent'}
					</label>

					{ac.isDetecting ? (
						<div className="flex items-center gap-2 py-2">
							<div
								className="w-4 h-4 border-2 border-t-transparent rounded-full animate-spin"
								style={{ borderColor: theme.colors.accent, borderTopColor: 'transparent' }}
							/>
							<span className="text-sm" style={{ color: theme.colors.textDim }}>
								Detecting agents...
							</span>
						</div>
					) : availableTiles.length === 0 ? (
						<div className="text-sm py-2" style={{ color: theme.colors.textDim }}>
							No agents available. Please install Claude Code, OpenCode, Codex, or Factory Droid.
						</div>
					) : (
						<div className="flex items-center gap-2">
							{/* Dropdown */}
							<div className="relative flex-1" style={{ zIndex: 10000 }}>
								<select
									value={ac.selectedAgent || ''}
									onChange={(e) => ac.handleAgentChange(e.target.value)}
									className="w-full px-3 py-2 pr-10 rounded-lg border outline-none appearance-none cursor-pointer text-sm relative"
									style={{
										backgroundColor: theme.colors.bgMain,
										borderColor: theme.colors.border,
										color: theme.colors.textMain,
										zIndex: 10000,
									}}
									aria-label="Select moderator agent"
								>
									{availableTiles.map((tile) => {
										const isBeta = isBetaAgent(tile.id);
										return (
											<option key={tile.id} value={tile.id}>
												{tile.name}
												{isBeta ? ' (Beta)' : ''}
											</option>
										);
									})}
								</select>
								<ChevronDown
									className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 pointer-events-none"
									style={{ color: theme.colors.textDim, zIndex: 10001 }}
								/>
							</div>

							{/* Customize button */}
							<button
								onClick={ac.toggleConfigExpanded}
								className="flex items-center gap-1.5 px-3 py-2 rounded-lg border transition-colors hover:bg-white/5"
								style={{
									borderColor: ac.isConfigExpanded ? theme.colors.accent : theme.colors.border,
									color: ac.isConfigExpanded ? theme.colors.accent : theme.colors.textDim,
									backgroundColor: ac.isConfigExpanded ? `${theme.colors.accent}10` : 'transparent',
								}}
								title="Customize moderator settings"
							>
								<Settings className="w-4 h-4" />
								<span className="text-sm">Customize</span>
								{ac.hasCustomization && (
									<span
										className="w-2 h-2 rounded-full"
										style={{ backgroundColor: theme.colors.accent }}
									/>
								)}
							</button>
						</div>
					)}

					{/* Expandable Configuration Panel */}
					{ac.isConfigExpanded && selectedAgentConfig && selectedTile && (
						<div
							className="mt-3 p-4 rounded-lg border"
							style={{
								backgroundColor: theme.colors.bgActivity,
								borderColor: theme.colors.border,
							}}
						>
							<div className="flex items-center justify-between mb-3">
								<span className="text-xs font-medium" style={{ color: theme.colors.textDim }}>
									{selectedTile.name} Configuration
								</span>
								{ac.hasCustomization && (
									<div className="flex items-center gap-1">
										<Check className="w-3 h-3" style={{ color: theme.colors.success }} />
										<span className="text-xs" style={{ color: theme.colors.success }}>
											Customized
										</span>
									</div>
								)}
							</div>
							<AgentConfigPanel
								theme={theme}
								agent={selectedAgentConfig}
								customPath={ac.customPath}
								onCustomPathChange={ac.setCustomPath}
								onCustomPathBlur={() => {
									/* Local state only */
								}}
								onCustomPathClear={() => ac.setCustomPath('')}
								customArgs={ac.customArgs}
								onCustomArgsChange={ac.setCustomArgs}
								onCustomArgsBlur={() => {
									/* Local state only */
								}}
								onCustomArgsClear={() => ac.setCustomArgs('')}
								customEnvVars={ac.customEnvVars}
								onEnvVarKeyChange={(oldKey, newKey, value) => {
									const newVars = { ...ac.customEnvVars };
									delete newVars[oldKey];
									newVars[newKey] = value;
									ac.setCustomEnvVars(newVars);
								}}
								onEnvVarValueChange={(key, value) => {
									ac.setCustomEnvVars({ ...ac.customEnvVars, [key]: value });
								}}
								onEnvVarRemove={(key) => {
									const newVars = { ...ac.customEnvVars };
									delete newVars[key];
									ac.setCustomEnvVars(newVars);
								}}
								onEnvVarAdd={() => {
									let newKey = 'NEW_VAR';
									let counter = 1;
									while (ac.customEnvVars[newKey]) {
										newKey = `NEW_VAR_${counter}`;
										counter++;
									}
									ac.setCustomEnvVars({ ...ac.customEnvVars, [newKey]: '' });
								}}
								onEnvVarsBlur={() => {
									/* Local state only */
								}}
								agentConfig={ac.agentConfig}
								onConfigChange={(key, value) => {
									const newConfig = { ...ac.agentConfig, [key]: value };
									ac.setAgentConfig(newConfig);
									ac.agentConfigRef.current = newConfig;
									if (mode === 'edit') {
										setConfigWasModified(true);
									}
								}}
								onConfigBlur={async () => {
									if (ac.selectedAgent) {
										await ac.saveAgentConfig(ac.selectedAgent);
										if (mode === 'edit') {
											setConfigWasModified(true);
										}
									}
								}}
								availableModels={ac.availableModels}
								loadingModels={ac.loadingModels}
								onRefreshModels={ac.refreshModels}
								onRefreshAgent={ac.refreshAgent}
								refreshingAgent={ac.refreshingAgent}
								compact
								showBuiltInEnvVars
							/>
						</div>
					)}
				</div>

				{/* SSH Remote Execution - Top Level */}
				{ac.sshRemotes.length > 0 && (
					<div className="mb-6">
						<SshRemoteSelector
							theme={theme}
							sshRemotes={ac.sshRemotes}
							sshRemoteConfig={ac.sshRemoteConfig}
							onSshRemoteConfigChange={ac.setSshRemoteConfig}
						/>
					</div>
				)}

				{/* Warning about changing moderator (edit mode only) */}
				{mode === 'edit' && groupChat && ac.selectedAgent !== groupChat.moderatorAgentId && (
					<div
						className="text-xs p-3 rounded"
						style={{
							backgroundColor: `${theme.colors.warning}20`,
							color: theme.colors.warning,
							border: `1px solid ${theme.colors.warning}40`,
						}}
					>
						<strong>Note:</strong> Changing the moderator agent will restart the moderator process.
						Existing conversation history will be preserved.
					</div>
				)}

				{/* Name Input (create mode: at bottom) */}
				{isCreate && (
					<FormInput
						ref={nameInputRef}
						theme={theme}
						label="Chat Name"
						value={name}
						onChange={setName}
						onSubmit={canSubmit ? handleSubmit : undefined}
						placeholder="e.g., Auth Feature Implementation"
					/>
				)}
			</div>
		</Modal>
	);
}
