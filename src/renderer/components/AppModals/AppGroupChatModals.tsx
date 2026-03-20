import { memo, useCallback } from 'react';
import type { Theme, GroupChat, GroupChatMessage, ModeratorConfig } from '../../types';
import type { TeamTemplateRole, WorkflowTopology } from '../../../shared/group-chat-types';
import { useModalStore } from '../../stores/modalStore';
import { useGroupChatStore } from '../../stores/groupChatStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { notifyToast } from '../../stores/notificationStore';
import { generateId } from '../../utils/ids';

// Group Chat Modal Components
import { GroupChatModal } from '../GroupChatModal';
import { DeleteGroupChatModal } from '../DeleteGroupChatModal';
import { RenameGroupChatModal } from '../RenameGroupChatModal';
import { GroupChatInfoOverlay } from '../GroupChatInfoOverlay';
import { TeamBuilderWizard } from '../GroupChat/TeamBuilderWizard';

/**
 * Props for the AppGroupChatModals component
 */
export interface AppGroupChatModalsProps {
	theme: Theme;
	groupChats: GroupChat[];

	// NewGroupChatModal
	showNewGroupChatModal: boolean;
	onCloseNewGroupChatModal: () => void;
	onCreateGroupChat: (
		name: string,
		moderatorAgentId: string,
		moderatorConfig?: ModeratorConfig
	) => void;

	// DeleteGroupChatModal
	showDeleteGroupChatModal: string | null;
	onCloseDeleteGroupChatModal: () => void;
	onConfirmDeleteGroupChat: () => void;

	// RenameGroupChatModal
	showRenameGroupChatModal: string | null;
	onCloseRenameGroupChatModal: () => void;
	onRenameGroupChat: (newName: string) => void;

	// EditGroupChatModal
	showEditGroupChatModal: string | null;
	onCloseEditGroupChatModal: () => void;
	onUpdateGroupChat: (
		id: string,
		name: string,
		moderatorAgentId: string,
		moderatorConfig?: ModeratorConfig
	) => void;

	// GroupChatInfoOverlay
	showGroupChatInfo: boolean;
	activeGroupChatId: string | null;
	groupChatMessages: GroupChatMessage[];
	onCloseGroupChatInfo: () => void;
	onOpenModeratorSession: (moderatorSessionId: string) => void;
}

/**
 * AppGroupChatModals - Renders Group Chat management modals
 *
 * Contains:
 * - NewGroupChatModal: Create a new group chat
 * - DeleteGroupChatModal: Confirm deletion of a group chat
 * - RenameGroupChatModal: Rename an existing group chat
 * - EditGroupChatModal: Edit group chat settings (name, moderator)
 * - GroupChatInfoOverlay: View group chat info and statistics
 * - TeamBuilderWizard: AI-powered team composition wizard (gated behind teamOrchestration)
 */
export const AppGroupChatModals = memo(function AppGroupChatModals({
	theme,
	groupChats,
	// NewGroupChatModal
	showNewGroupChatModal,
	onCloseNewGroupChatModal,
	onCreateGroupChat,
	// DeleteGroupChatModal
	showDeleteGroupChatModal,
	onCloseDeleteGroupChatModal,
	onConfirmDeleteGroupChat,
	// RenameGroupChatModal
	showRenameGroupChatModal,
	onCloseRenameGroupChatModal,
	onRenameGroupChat,
	// EditGroupChatModal
	showEditGroupChatModal,
	onCloseEditGroupChatModal,
	onUpdateGroupChat,
	// GroupChatInfoOverlay
	showGroupChatInfo,
	activeGroupChatId,
	groupChatMessages,
	onCloseGroupChatInfo,
	onOpenModeratorSession,
}: AppGroupChatModalsProps) {
	// Team Builder Wizard state (self-sourced from modal store)
	const teamBuilderWizardOpen = useModalStore(
		(s) => s.modals.get('teamBuilderWizard')?.open ?? false
	);
	const teamOrchestrationEnabled = useSettingsStore((s) => s.encoreFeatures.teamOrchestration);

	const handleCloseTeamBuilderWizard = useCallback(() => {
		useModalStore.getState().closeModal('teamBuilderWizard');
	}, []);

	const handleTeamBuilderCreateGroupChat = useCallback(
		async (
			teamName: string,
			moderatorAgentId: string,
			roles: TeamTemplateRole[],
			_topology?: WorkflowTopology
		) => {
			const { closeModal } = useModalStore.getState();
			const { setGroupChats } = useGroupChatStore.getState();
			try {
				// Create the group chat with moderator
				const chat = await window.maestro.groupChat.create(teamName, moderatorAgentId);
				setGroupChats((prev) => [chat, ...prev]);

				// Add each role as a participant
				for (const role of roles) {
					await window.maestro.groupChat.addParticipant(chat.id, role.name, role.agentId);
				}

				closeModal('teamBuilderWizard');

				// Open the newly created group chat
				const { setActiveGroupChatId } = useGroupChatStore.getState();
				setActiveGroupChatId(chat.id);
			} catch (err) {
				closeModal('teamBuilderWizard');
				notifyToast({
					type: 'error',
					title: 'Team Builder',
					message: 'Failed to create group chat from team configuration',
				});
				throw err; // Let Sentry capture
			}
		},
		[]
	);

	const handleTeamBuilderSaveTemplate = useCallback(
		async (template: {
			name: string;
			description: string;
			moderatorAgentId: string;
			roles: TeamTemplateRole[];
			topology?: WorkflowTopology;
		}) => {
			try {
				const now = Date.now();
				await window.maestro.teamTemplates.save({
					id: generateId(),
					name: template.name,
					description: template.description,
					category: 'user',
					createdAt: now,
					updatedAt: now,
					moderatorAgentId: template.moderatorAgentId,
					roles: template.roles,
					topology: template.topology,
				});
				notifyToast({
					type: 'success',
					title: 'Team Builder',
					message: 'Team template saved',
				});
			} catch (err) {
				notifyToast({
					type: 'error',
					title: 'Team Builder',
					message: 'Failed to save team template',
				});
				throw err;
			}
		},
		[]
	);

	// Find group chats by ID for modal props
	const deleteGroupChat = showDeleteGroupChatModal
		? groupChats.find((c) => c.id === showDeleteGroupChatModal)
		: null;

	const renameGroupChat = showRenameGroupChatModal
		? groupChats.find((c) => c.id === showRenameGroupChatModal)
		: null;

	const editGroupChat = showEditGroupChatModal
		? groupChats.find((c) => c.id === showEditGroupChatModal)
		: null;

	const infoGroupChat = activeGroupChatId
		? groupChats.find((c) => c.id === activeGroupChatId)
		: null;

	return (
		<>
			{/* --- NEW GROUP CHAT MODAL --- */}
			{showNewGroupChatModal && (
				<GroupChatModal
					mode="create"
					theme={theme}
					isOpen={showNewGroupChatModal}
					onClose={onCloseNewGroupChatModal}
					onCreate={onCreateGroupChat}
				/>
			)}

			{/* --- DELETE GROUP CHAT MODAL --- */}
			{showDeleteGroupChatModal && deleteGroupChat && (
				<DeleteGroupChatModal
					theme={theme}
					isOpen={!!showDeleteGroupChatModal}
					groupChatName={deleteGroupChat.name}
					onClose={onCloseDeleteGroupChatModal}
					onConfirm={onConfirmDeleteGroupChat}
				/>
			)}

			{/* --- RENAME GROUP CHAT MODAL --- */}
			{showRenameGroupChatModal && renameGroupChat && (
				<RenameGroupChatModal
					theme={theme}
					isOpen={!!showRenameGroupChatModal}
					currentName={renameGroupChat.name}
					onClose={onCloseRenameGroupChatModal}
					onRename={onRenameGroupChat}
				/>
			)}

			{/* --- EDIT GROUP CHAT MODAL --- */}
			{showEditGroupChatModal && (
				<GroupChatModal
					mode="edit"
					theme={theme}
					isOpen={!!showEditGroupChatModal}
					groupChat={editGroupChat || null}
					onClose={onCloseEditGroupChatModal}
					onSave={onUpdateGroupChat}
				/>
			)}

			{/* --- GROUP CHAT INFO OVERLAY --- */}
			{showGroupChatInfo && activeGroupChatId && infoGroupChat && (
				<GroupChatInfoOverlay
					theme={theme}
					isOpen={showGroupChatInfo}
					groupChat={infoGroupChat}
					messages={groupChatMessages}
					onClose={onCloseGroupChatInfo}
					onOpenModeratorSession={onOpenModeratorSession}
				/>
			)}

			{/* --- TEAM BUILDER WIZARD (gated behind teamOrchestration) --- */}
			{teamBuilderWizardOpen && teamOrchestrationEnabled && (
				<TeamBuilderWizard
					theme={theme}
					isOpen={teamBuilderWizardOpen}
					onClose={handleCloseTeamBuilderWizard}
					onCreateGroupChat={handleTeamBuilderCreateGroupChat}
					onSaveTemplate={handleTeamBuilderSaveTemplate}
				/>
			)}
		</>
	);
});
