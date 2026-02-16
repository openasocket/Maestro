/**
 * ExperienceEditModal
 *
 * Modal for adding or editing experience entries in the GRPO library.
 * Registers with the layer stack for proper Escape handling.
 */

import React, { useState, useCallback, memo } from 'react';
import type { Theme } from '../../types';
import type { ExperienceEntry, ExperienceId } from '../../../shared/grpo-types';
import { useModalLayer } from '../../hooks/ui/useModalLayer';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';

const CATEGORIES = ['testing', 'architecture', 'tooling', 'debugging', 'patterns', 'performance'];
const AGENTS = ['all', 'claude-code', 'codex', 'opencode'];
const MAX_CONTENT_LENGTH = 500;

interface ExperienceEditModalProps {
	theme: Theme;
	entry: ExperienceEntry | null;
	onSave: (
		entry: {
			content: string;
			category: string;
			agentType: string;
			scope: 'project' | 'global';
		},
		existingId?: ExperienceId
	) => void;
	onClose: () => void;
}

export const ExperienceEditModal = memo(function ExperienceEditModal({
	theme,
	entry,
	onSave,
	onClose,
}: ExperienceEditModalProps) {
	const [content, setContent] = useState(entry?.content || '');
	const [category, setCategory] = useState(entry?.category || 'testing');
	const [agentType, setAgentType] = useState(entry?.agentType || 'all');
	const [scope, setScope] = useState<'project' | 'global'>(entry?.scope || 'project');

	const isEditing = !!entry;
	const tokenEstimate = Math.ceil(content.length / 4);
	const isValid = content.trim().length > 0 && content.length <= MAX_CONTENT_LENGTH;

	// Register with layer stack for Escape handling
	useModalLayer(MODAL_PRIORITIES.EXPERIENCE_EDIT, 'Experience Editor', onClose);

	const handleSave = useCallback(() => {
		if (!isValid) return;
		onSave(
			{ content: content.trim(), category, agentType, scope },
			entry?.id
		);
	}, [content, category, agentType, scope, entry?.id, isValid, onSave]);

	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center"
			style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}
			onClick={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
		>
			<div
				className="w-[440px] rounded-xl border shadow-2xl overflow-hidden"
				style={{ backgroundColor: theme.colors.bgSidebar, borderColor: theme.colors.border }}
			>
				{/* Header */}
				<div className="px-5 py-4 border-b" style={{ borderColor: theme.colors.border }}>
					<h3 className="text-sm font-bold" style={{ color: theme.colors.textMain }}>
						{isEditing ? 'Edit Experience' : 'Add Experience'}
					</h3>
				</div>

				{/* Form */}
				<div className="px-5 py-4 space-y-4">
					{/* Category */}
					<div>
						<label className="block text-xs mb-1" style={{ color: theme.colors.textDim }}>
							Category
						</label>
						<select
							value={category}
							onChange={(e) => setCategory(e.target.value)}
							className="w-full p-2 text-xs rounded border bg-transparent outline-none"
							style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
						>
							{CATEGORIES.map((c) => (
								<option key={c} value={c}>{c}</option>
							))}
						</select>
					</div>

					{/* Content */}
					<div>
						<label className="block text-xs mb-1" style={{ color: theme.colors.textDim }}>
							Content
						</label>
						<div className="relative">
							<textarea
								value={content}
								onChange={(e) => setContent(e.target.value.slice(0, MAX_CONTENT_LENGTH))}
								placeholder="When modifying React components in this project, check for existing useMemo patterns before adding new ones."
								className="w-full p-3 rounded border bg-transparent outline-none text-xs resize-none"
								style={{
									borderColor: content.length > MAX_CONTENT_LENGTH ? theme.colors.error : theme.colors.border,
									color: theme.colors.textMain,
									minHeight: '100px',
								}}
								maxLength={MAX_CONTENT_LENGTH}
							/>
							<div
								className="absolute bottom-2 right-2 text-[10px]"
								style={{
									color: content.length > MAX_CONTENT_LENGTH * 0.9
										? theme.colors.warning
										: theme.colors.textDim,
								}}
							>
								{content.length}/{MAX_CONTENT_LENGTH}
							</div>
						</div>
					</div>

					{/* Agent */}
					<div>
						<label className="block text-xs mb-1" style={{ color: theme.colors.textDim }}>
							Agent
						</label>
						<select
							value={agentType}
							onChange={(e) => setAgentType(e.target.value)}
							className="w-full p-2 text-xs rounded border bg-transparent outline-none"
							style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
						>
							{AGENTS.map((a) => (
								<option key={a} value={a}>{a}</option>
							))}
						</select>
					</div>

					{/* Scope */}
					<div>
						<label className="block text-xs mb-1" style={{ color: theme.colors.textDim }}>
							Scope
						</label>
						<div className="flex items-center gap-4">
							<label className="flex items-center gap-1.5 cursor-pointer">
								<input
									type="radio"
									name="scope"
									checked={scope === 'project'}
									onChange={() => setScope('project')}
									className="accent-indigo-500"
								/>
								<span className="text-xs" style={{ color: theme.colors.textMain }}>Project</span>
							</label>
							<label className="flex items-center gap-1.5 cursor-pointer">
								<input
									type="radio"
									name="scope"
									checked={scope === 'global'}
									onChange={() => setScope('global')}
									className="accent-indigo-500"
								/>
								<span className="text-xs" style={{ color: theme.colors.textMain }}>Global</span>
							</label>
						</div>
					</div>

					{/* Token Estimate */}
					<div className="text-xs" style={{ color: theme.colors.textDim }}>
						Token estimate: ~{tokenEstimate} tokens
					</div>
				</div>

				{/* Footer */}
				<div className="px-5 py-3 border-t flex justify-end gap-2" style={{ borderColor: theme.colors.border }}>
					<button
						onClick={onClose}
						className="px-3 py-1.5 text-xs rounded border hover:bg-white/10 transition-colors"
						style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
					>
						Cancel
					</button>
					<button
						onClick={handleSave}
						disabled={!isValid}
						className="px-3 py-1.5 text-xs rounded transition-colors"
						style={{
							backgroundColor: isValid ? theme.colors.accent : theme.colors.border,
							color: isValid ? '#fff' : theme.colors.textDim,
							opacity: isValid ? 1 : 0.5,
						}}
					>
						Save
					</button>
				</div>
			</div>
		</div>
	);
});
