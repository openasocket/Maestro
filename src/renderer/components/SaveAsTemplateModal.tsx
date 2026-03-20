/**
 * SaveAsTemplateModal.tsx
 *
 * Modal for saving an existing Group Chat configuration as a reusable Team Template.
 * Prompts user for a template name and description, then calls the IPC API.
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { BookTemplate } from 'lucide-react';
import type { Theme } from '../types';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { Modal, ModalFooter, FormInput } from './ui';
import { notifyToast } from '../stores/notificationStore';

interface SaveAsTemplateModalProps {
	theme: Theme;
	isOpen: boolean;
	chatId: string;
	chatName: string;
	onClose: () => void;
}

export function SaveAsTemplateModal({
	theme,
	isOpen,
	chatId,
	chatName,
	onClose,
}: SaveAsTemplateModalProps): JSX.Element | null {
	const [name, setName] = useState('');
	const [description, setDescription] = useState('');
	const [saving, setSaving] = useState(false);
	const nameInputRef = useRef<HTMLInputElement>(null);

	// Reset fields when modal opens
	useEffect(() => {
		if (isOpen) {
			setName(chatName);
			setDescription('');
			setSaving(false);
		}
	}, [isOpen, chatName]);

	const canSave = name.trim().length > 0 && !saving;

	const handleSave = useCallback(async () => {
		if (!canSave) return;

		setSaving(true);
		try {
			await window.maestro.teamTemplates.createFromChat(
				chatId,
				name.trim(),
				description.trim() || undefined
			);
			notifyToast({
				type: 'success',
				title: 'Team template saved',
				message: `"${name.trim()}" has been saved as a team template.`,
			});
			onClose();
		} catch (err) {
			notifyToast({
				type: 'error',
				title: 'Failed to save template',
				message: err instanceof Error ? err.message : 'An unexpected error occurred.',
			});
			setSaving(false);
		}
	}, [canSave, chatId, name, description, onClose]);

	if (!isOpen) return null;

	return (
		<Modal
			theme={theme}
			title="Save Team Template"
			priority={MODAL_PRIORITIES.SAVE_AS_TEMPLATE}
			onClose={onClose}
			initialFocusRef={nameInputRef}
			headerIcon={<BookTemplate className="w-4 h-4" style={{ color: theme.colors.accent }} />}
			width={450}
			footer={
				<ModalFooter
					theme={theme}
					onCancel={onClose}
					onConfirm={handleSave}
					confirmLabel={saving ? 'Saving...' : 'Save Template'}
					confirmDisabled={!canSave}
				/>
			}
		>
			<div className="flex flex-col gap-4">
				<FormInput
					ref={nameInputRef}
					theme={theme}
					label="Template Name"
					value={name}
					onChange={setName}
					onSubmit={canSave ? handleSave : undefined}
					placeholder="e.g., Code Review Team"
					autoFocus
				/>
				<div className="w-full">
					<label
						className="block text-xs font-bold opacity-70 uppercase mb-2"
						style={{ color: theme.colors.textMain }}
					>
						Description
					</label>
					<textarea
						value={description}
						onChange={(e) => setDescription(e.target.value)}
						placeholder="What does this team configuration do?"
						rows={3}
						className="w-full p-3 rounded border bg-transparent outline-none resize-none text-sm"
						style={{
							borderColor: theme.colors.border,
							color: theme.colors.textMain,
						}}
					/>
					<p className="mt-2 text-xs" style={{ color: theme.colors.textDim }}>
						The template will capture the current participants and moderator configuration.
					</p>
				</div>
			</div>
		</Modal>
	);
}
