/**
 * TemplateBrowserModal.tsx
 *
 * Full-screen modal for browsing, searching, and filtering team templates.
 * Opened from the "Browse All Templates" link in GroupChatModal or as a standalone browser.
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import { Search, BookTemplate, Users, Star, Copy, Trash2 } from 'lucide-react';
import type { Theme } from '../types';
import type { TeamTemplate } from '../../shared/group-chat-types';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { Modal, ModalFooter } from './ui';
import { notifyToast } from '../stores/notificationStore';

type CategoryFilter = 'all' | 'builtin' | 'user' | 'exchange';

interface TemplateBrowserModalProps {
	theme: Theme;
	isOpen: boolean;
	onClose: () => void;
	onSelect?: (template: TeamTemplate) => void;
}

export function TemplateBrowserModal({
	theme,
	isOpen,
	onClose,
	onSelect,
}: TemplateBrowserModalProps): JSX.Element | null {
	const [templates, setTemplates] = useState<TeamTemplate[]>([]);
	const [loading, setLoading] = useState(true);
	const [search, setSearch] = useState('');
	const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('all');
	const [selectedId, setSelectedId] = useState<string | null>(null);

	// Load templates when modal opens
	useEffect(() => {
		if (!isOpen) return;
		setLoading(true);
		setSearch('');
		setCategoryFilter('all');
		setSelectedId(null);

		window.maestro.teamTemplates
			.list()
			.then(setTemplates)
			.catch(() => setTemplates([]))
			.finally(() => setLoading(false));
	}, [isOpen]);

	const filtered = useMemo(() => {
		let result = templates;
		if (categoryFilter !== 'all') {
			result = result.filter((t) => t.category === categoryFilter);
		}
		if (search.trim()) {
			const q = search.trim().toLowerCase();
			result = result.filter(
				(t) =>
					t.name.toLowerCase().includes(q) ||
					t.description.toLowerCase().includes(q) ||
					t.roles.some((r) => r.name.toLowerCase().includes(q))
			);
		}
		return result;
	}, [templates, categoryFilter, search]);

	const selectedTemplate = useMemo(
		() => templates.find((t) => t.id === selectedId) ?? null,
		[templates, selectedId]
	);

	const handleSelect = useCallback(() => {
		if (selectedTemplate && onSelect) {
			onSelect(selectedTemplate);
			onClose();
		}
	}, [selectedTemplate, onSelect, onClose]);

	const handleDuplicate = useCallback(async (template: TeamTemplate) => {
		try {
			const duplicated = await window.maestro.teamTemplates.duplicate(
				template.id,
				`${template.name} (Copy)`
			);
			setTemplates((prev) => [...prev, duplicated]);
			notifyToast({
				type: 'success',
				title: 'Template duplicated',
				message: `"${duplicated.name}" has been created.`,
			});
		} catch (err) {
			notifyToast({
				type: 'error',
				title: 'Failed to duplicate template',
				message: err instanceof Error ? err.message : 'An unexpected error occurred.',
			});
		}
	}, []);

	const handleDelete = useCallback(
		async (template: TeamTemplate) => {
			if (template.category !== 'user') {
				notifyToast({
					type: 'warning',
					title: 'Cannot delete built-in template',
					message:
						'Built-in templates cannot be deleted. Duplicate it to create a customizable copy.',
				});
				return;
			}
			try {
				await window.maestro.teamTemplates.delete(template.id);
				setTemplates((prev) => prev.filter((t) => t.id !== template.id));
				if (selectedId === template.id) setSelectedId(null);
				notifyToast({
					type: 'success',
					title: 'Template deleted',
					message: `"${template.name}" has been deleted.`,
				});
			} catch (err) {
				notifyToast({
					type: 'error',
					title: 'Failed to delete template',
					message: err instanceof Error ? err.message : 'An unexpected error occurred.',
				});
			}
		},
		[selectedId]
	);

	if (!isOpen) return null;

	const categories: { key: CategoryFilter; label: string }[] = [
		{ key: 'all', label: 'All' },
		{ key: 'builtin', label: 'Built-in' },
		{ key: 'user', label: 'Custom' },
	];

	return (
		<Modal
			theme={theme}
			title="Team Templates"
			priority={MODAL_PRIORITIES.TEMPLATE_BROWSER}
			onClose={onClose}
			width={700}
			headerIcon={<BookTemplate className="w-4 h-4" style={{ color: theme.colors.accent }} />}
			footer={
				onSelect ? (
					<ModalFooter
						theme={theme}
						onCancel={onClose}
						onConfirm={handleSelect}
						confirmLabel="Use Template"
						confirmDisabled={!selectedTemplate}
					/>
				) : undefined
			}
		>
			<div className="flex flex-col gap-4" style={{ maxHeight: '60vh' }}>
				{/* Search + Filter */}
				<div className="flex items-center gap-3">
					<div
						className="flex items-center gap-2 flex-1 px-3 py-2 rounded-lg border"
						style={{
							borderColor: theme.colors.border,
							backgroundColor: theme.colors.bgMain,
						}}
					>
						<Search className="w-4 h-4 shrink-0" style={{ color: theme.colors.textDim }} />
						<input
							type="text"
							value={search}
							onChange={(e) => setSearch(e.target.value)}
							placeholder="Search templates..."
							className="flex-1 bg-transparent outline-none text-sm"
							style={{ color: theme.colors.textMain }}
						/>
					</div>
					<div className="flex gap-1">
						{categories.map((cat) => (
							<button
								key={cat.key}
								type="button"
								onClick={() => setCategoryFilter(cat.key)}
								className="px-3 py-1.5 rounded text-xs font-medium transition-colors"
								style={{
									backgroundColor:
										categoryFilter === cat.key ? `${theme.colors.accent}20` : 'transparent',
									color: categoryFilter === cat.key ? theme.colors.accent : theme.colors.textDim,
									border: `1px solid ${categoryFilter === cat.key ? theme.colors.accent : theme.colors.border}`,
								}}
							>
								{cat.label}
							</button>
						))}
					</div>
				</div>

				{/* Template list */}
				<div className="overflow-y-auto flex flex-col gap-2" style={{ minHeight: 200 }}>
					{loading ? (
						<div className="flex items-center justify-center py-8">
							<div
								className="w-5 h-5 border-2 border-t-transparent rounded-full animate-spin"
								style={{
									borderColor: theme.colors.accent,
									borderTopColor: 'transparent',
								}}
							/>
						</div>
					) : filtered.length === 0 ? (
						<div className="text-center py-8 text-sm" style={{ color: theme.colors.textDim }}>
							{search.trim() ? 'No templates match your search.' : 'No templates available.'}
						</div>
					) : (
						filtered.map((template) => {
							const isSelected = selectedId === template.id;
							return (
								<button
									key={template.id}
									type="button"
									onClick={() => setSelectedId(template.id)}
									onDoubleClick={() => {
										if (onSelect) {
											onSelect(template);
											onClose();
										}
									}}
									className="flex items-start gap-3 p-3 rounded-lg border text-left transition-colors"
									style={{
										borderColor: isSelected ? theme.colors.accent : theme.colors.border,
										backgroundColor: isSelected ? `${theme.colors.accent}10` : 'transparent',
									}}
								>
									{/* Icon */}
									<div
										className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
										style={{
											backgroundColor: `${theme.colors.accent}15`,
										}}
									>
										{template.category === 'builtin' ? (
											<Star className="w-4 h-4" style={{ color: theme.colors.accent }} />
										) : (
											<BookTemplate className="w-4 h-4" style={{ color: theme.colors.accent }} />
										)}
									</div>

									{/* Content */}
									<div className="flex-1 min-w-0">
										<div className="flex items-center gap-2">
											<span
												className="text-sm font-medium truncate"
												style={{ color: theme.colors.textMain }}
											>
												{template.name}
											</span>
											<span
												className="text-[10px] px-1.5 py-0.5 rounded uppercase font-medium shrink-0"
												style={{
													backgroundColor: `${template.category === 'builtin' ? theme.colors.accent : theme.colors.success}15`,
													color:
														template.category === 'builtin'
															? theme.colors.accent
															: theme.colors.success,
												}}
											>
												{template.category}
											</span>
										</div>
										<p
											className="text-xs mt-0.5 line-clamp-1"
											style={{ color: theme.colors.textDim }}
										>
											{template.description}
										</p>
										<div
											className="flex items-center gap-1 mt-1"
											style={{ color: theme.colors.textDim }}
										>
											<Users className="w-3 h-3" />
											<span className="text-[11px]">
												{template.roles.length} role
												{template.roles.length !== 1 ? 's' : ''}
											</span>
										</div>
									</div>

									{/* Actions */}
									<div
										className="flex items-center gap-1 shrink-0"
										onClick={(e) => e.stopPropagation()}
									>
										<button
											type="button"
											onClick={(e) => {
												e.stopPropagation();
												handleDuplicate(template);
											}}
											className="p-1.5 rounded hover:bg-white/10 transition-colors"
											title="Duplicate template"
											style={{ color: theme.colors.textDim }}
										>
											<Copy className="w-3.5 h-3.5" />
										</button>
										{template.category === 'user' && (
											<button
												type="button"
												onClick={(e) => {
													e.stopPropagation();
													handleDelete(template);
												}}
												className="p-1.5 rounded hover:bg-white/10 transition-colors"
												title="Delete template"
												style={{ color: theme.colors.error }}
											>
												<Trash2 className="w-3.5 h-3.5" />
											</button>
										)}
									</div>
								</button>
							);
						})
					)}
				</div>
			</div>
		</Modal>
	);
}
