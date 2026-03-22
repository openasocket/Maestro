/**
 * TemplatesTab
 *
 * Template library browser for the Team Orchestration modal. Displays:
 * - Category filter pills (All, Built-in, User, Exchange)
 * - Debounced search bar
 * - 2-column template card grid
 * - Detail side panel for selected template
 *
 * Features:
 * - Fetches templates via window.maestro.teamTemplates.list()
 * - Per-template usage stats from TeamOrchAggregation.byTemplate
 * - Compact WorkflowGraph preview for topology templates
 * - Responsive layout (2-col grid → 1-col on narrow)
 * - CRUD: Create, Edit, Duplicate, Delete templates
 * - Import/Export: JSON file import via file dialog, export via save dialog
 */

import { memo, useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
	Search,
	Plus,
	Upload,
	Download,
	Copy,
	Pencil,
	Trash2,
	X,
	GripVertical,
} from 'lucide-react';
import type { Theme } from '../../types';
import type { TeamOrchAggregation } from '../../../shared/team-orch-stats-types';
import type { TeamTemplate, TeamTemplateRole } from '../../../shared/group-chat-types';
import { AGENT_IDS } from '../../../shared/agentIds';
import { WorkflowGraph } from '../GroupChat/WorkflowGraph';
import { TeamOrchEmptyState } from './TeamOrchEmptyState';
import { topologyDisplayName, formatPercentage } from './teamOrchUtils';
import { notifyToast } from '../../stores/notificationStore';
import { safeClipboardWrite } from '../../utils/clipboard';
import { PipelineBuilder } from './PipelineBuilder/PipelineBuilder';

type CategoryFilter = 'all' | 'builtin' | 'user' | 'exchange';

const CATEGORY_PILLS: { value: CategoryFilter; label: string }[] = [
	{ value: 'all', label: 'All' },
	{ value: 'builtin', label: 'Built-in' },
	{ value: 'user', label: 'User' },
	{ value: 'exchange', label: 'Exchange' },
];

/** Agent IDs available for role assignment (exclude terminal) */
const ROLE_AGENT_IDS = AGENT_IDS.filter((id) => id !== 'terminal');

interface TemplatesTabProps {
	theme: Theme;
	data: TeamOrchAggregation | null;
}

/**
 * Generate a UUID v4 string
 */
function generateUUID(): string {
	return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
		const r = (Math.random() * 16) | 0;
		const v = c === 'x' ? r : (r & 0x3) | 0x8;
		return v.toString(16);
	});
}

/**
 * Create a blank role for the inline form
 */
function createBlankRole(): TeamTemplateRole {
	return { name: '', agentId: 'claude-code', description: '' };
}

/**
 * Validate that an object has the required TeamTemplate fields
 */
function isValidTemplateShape(obj: unknown): obj is Partial<TeamTemplate> {
	if (!obj || typeof obj !== 'object') return false;
	const t = obj as Record<string, unknown>;
	return typeof t.name === 'string' && typeof t.description === 'string' && Array.isArray(t.roles);
}

export const TemplatesTab = memo(function TemplatesTab({ theme, data }: TemplatesTabProps) {
	const [templates, setTemplates] = useState<TeamTemplate[]>([]);
	const [loading, setLoading] = useState(true);
	const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
	const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('all');
	const [searchQuery, setSearchQuery] = useState('');
	const [debouncedSearch, setDebouncedSearch] = useState('');
	const [showCreateForm, setShowCreateForm] = useState(false);
	const [builderOpen, setBuilderOpen] = useState(false);
	const [editingTemplate, setEditingTemplate] = useState<TeamTemplate | null>(null);
	const mountedRef = useRef(true);

	// Debounce search input (300ms)
	useEffect(() => {
		const timer = setTimeout(() => {
			setDebouncedSearch(searchQuery);
		}, 300);
		return () => clearTimeout(timer);
	}, [searchQuery]);

	// Fetch templates on mount
	const fetchTemplates = useCallback(async () => {
		try {
			const list = await window.maestro.teamTemplates.list();
			if (mountedRef.current) {
				setTemplates(list);
			}
		} catch (err) {
			console.error('Failed to fetch templates:', err);
		} finally {
			if (mountedRef.current) {
				setLoading(false);
			}
		}
	}, []);

	useEffect(() => {
		mountedRef.current = true;
		fetchTemplates();
		return () => {
			mountedRef.current = false;
		};
	}, [fetchTemplates]);

	// Filter templates by category and search
	const filteredTemplates = useMemo(() => {
		let result = templates;

		if (categoryFilter !== 'all') {
			result = result.filter((t) => t.category === categoryFilter);
		}

		if (debouncedSearch) {
			const q = debouncedSearch.toLowerCase();
			result = result.filter(
				(t) => t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q)
			);
		}

		return result;
	}, [templates, categoryFilter, debouncedSearch]);

	const selectedTemplate = useMemo(
		() => templates.find((t) => t.id === selectedTemplateId) ?? null,
		[templates, selectedTemplateId]
	);

	// CRUD handlers
	const handleCreateSave = useCallback(
		async (name: string, description: string, roles: TeamTemplateRole[]) => {
			const now = Date.now();
			const template: TeamTemplate = {
				id: generateUUID(),
				name: name.trim(),
				description: description.trim(),
				category: 'user',
				createdAt: now,
				updatedAt: now,
				moderatorAgentId: 'claude-code',
				roles,
			};
			await window.maestro.teamTemplates.save(template);
			setShowCreateForm(false);
			await fetchTemplates();
			notifyToast({
				type: 'success',
				title: 'Template created',
				message: `"${template.name}" created.`,
			});
		},
		[fetchTemplates]
	);

	const handleEditSave = useCallback(
		async (updated: TeamTemplate) => {
			await window.maestro.teamTemplates.save({ ...updated, updatedAt: Date.now() });
			await fetchTemplates();
			notifyToast({
				type: 'success',
				title: 'Template updated',
				message: `"${updated.name}" saved.`,
			});
		},
		[fetchTemplates]
	);

	const handleDuplicate = useCallback(
		async (templateId: string) => {
			const original = templates.find((t) => t.id === templateId);
			const newName = original ? `${original.name} (Copy)` : 'Copy';
			await window.maestro.teamTemplates.duplicate(templateId, newName);
			await fetchTemplates();
			notifyToast({
				type: 'success',
				title: 'Template duplicated',
				message: `"${newName}" created.`,
			});
		},
		[fetchTemplates, templates]
	);

	const handleDelete = useCallback(
		async (templateId: string) => {
			const template = templates.find((t) => t.id === templateId);
			const confirmed = window.confirm(
				`Delete "${template?.name ?? 'template'}"? This cannot be undone.`
			);
			if (!confirmed) return;

			await window.maestro.teamTemplates.delete(templateId);
			if (selectedTemplateId === templateId) {
				setSelectedTemplateId(null);
			}
			await fetchTemplates();
			notifyToast({ type: 'success', title: 'Template deleted', message: `Template removed.` });
		},
		[fetchTemplates, templates, selectedTemplateId]
	);

	const handleExport = useCallback(async (template: TeamTemplate) => {
		const json = JSON.stringify(template, null, 2);
		try {
			const filePath = await window.maestro.dialog.saveFile({
				defaultPath: `${template.name.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`,
				filters: [{ name: 'JSON Files', extensions: ['json'] }],
				title: 'Export Template',
			});
			if (filePath) {
				await window.maestro.fs.writeFile(filePath, json);
				notifyToast({
					type: 'success',
					title: 'Template exported',
					message: `Saved to ${filePath}`,
				});
			}
		} catch {
			// Fallback: copy to clipboard
			const ok = await safeClipboardWrite(json);
			notifyToast({
				type: ok ? 'info' : 'error',
				title: ok ? 'Copied to clipboard' : 'Export failed',
				message: ok ? 'Template JSON copied to clipboard.' : 'Could not export template.',
			});
		}
	}, []);

	const handleImport = useCallback(async () => {
		try {
			const filePath = await window.maestro.dialog.openFile({
				filters: [{ name: 'JSON Files', extensions: ['json'] }],
				title: 'Import Template',
			});
			if (!filePath) return;

			const content = await window.maestro.fs.readFile(filePath);
			if (!content) {
				notifyToast({ type: 'error', title: 'Import failed', message: 'Could not read file.' });
				return;
			}

			let parsed: unknown;
			try {
				parsed = JSON.parse(content);
			} catch {
				notifyToast({ type: 'error', title: 'Import failed', message: 'Invalid JSON file.' });
				return;
			}

			if (!isValidTemplateShape(parsed)) {
				notifyToast({
					type: 'error',
					title: 'Import failed',
					message: 'JSON does not match template format (requires name, description, roles).',
				});
				return;
			}

			const now = Date.now();
			const imported: TeamTemplate = {
				...(parsed as TeamTemplate),
				id: generateUUID(),
				category: 'user',
				createdAt: now,
				updatedAt: now,
			};
			await window.maestro.teamTemplates.save(imported);
			await fetchTemplates();
			notifyToast({
				type: 'success',
				title: 'Template imported',
				message: `"${imported.name}" added.`,
			});
		} catch (err) {
			notifyToast({
				type: 'error',
				title: 'Import failed',
				message: err instanceof Error ? err.message : 'An unexpected error occurred.',
			});
		}
	}, [fetchTemplates]);

	// Pipeline Builder handlers
	const handleBuilderSave = useCallback(
		async (template: TeamTemplate) => {
			await window.maestro.teamTemplates.save(template);
			setBuilderOpen(false);
			setEditingTemplate(null);
			await fetchTemplates();
			notifyToast({
				type: 'success',
				title: 'Template saved',
				message: `"${template.name}" saved via Pipeline Builder.`,
			});
		},
		[fetchTemplates]
	);

	const handleBuilderCancel = useCallback(() => {
		setBuilderOpen(false);
		setEditingTemplate(null);
	}, []);

	const handleOpenBuilderForEdit = useCallback((template: TeamTemplate) => {
		setEditingTemplate(template);
		setBuilderOpen(true);
	}, []);

	// When builder is open, render it instead of the template list
	if (builderOpen) {
		return (
			<div style={{ height: 500 }}>
				<PipelineBuilder
					template={editingTemplate ?? undefined}
					onSave={handleBuilderSave}
					onCancel={handleBuilderCancel}
					theme={theme}
				/>
			</div>
		);
	}

	if (loading) {
		return (
			<div className="space-y-3">
				{Array.from({ length: 4 }).map((_, i) => (
					<div
						key={i}
						className="h-24 rounded-lg"
						style={{
							backgroundColor: theme.colors.border,
							opacity: 0.15,
							animation: 'skeleton-shimmer 1.5s ease-in-out infinite',
							animationDelay: `${i * 100}ms`,
						}}
					/>
				))}
			</div>
		);
	}

	return (
		<div className="flex gap-4" style={{ minHeight: 400 }}>
			{/* Left panel: filters + grid */}
			<div className={selectedTemplate ? 'flex-1 min-w-0' : 'w-full'}>
				{/* Action buttons row */}
				<div className="flex items-center gap-2 mb-3">
					<button
						onClick={() => {
							setBuilderOpen(true);
							setEditingTemplate(null);
						}}
						className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
						style={{
							backgroundColor: theme.colors.accent,
							color: '#fff',
						}}
					>
						<Plus className="w-3.5 h-3.5" />
						Create Template
					</button>
					<button
						onClick={() => setShowCreateForm((v) => !v)}
						className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
						style={{
							backgroundColor: theme.colors.bgActivity,
							color: theme.colors.textDim,
						}}
					>
						<Plus className="w-3.5 h-3.5" />
						Quick Create
					</button>
					<button
						onClick={handleImport}
						className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
						style={{
							backgroundColor: theme.colors.bgActivity,
							color: theme.colors.textDim,
						}}
					>
						<Upload className="w-3.5 h-3.5" />
						Import
					</button>
				</div>

				{/* Inline create form */}
				{showCreateForm && (
					<CreateTemplateForm
						theme={theme}
						onSave={handleCreateSave}
						onCancel={() => setShowCreateForm(false)}
					/>
				)}

				{/* Category filter pills */}
				<div
					className="flex items-center gap-2 mb-3"
					role="radiogroup"
					aria-label="Filter by category"
				>
					{CATEGORY_PILLS.map((pill) => (
						<button
							key={pill.value}
							onClick={() => setCategoryFilter(pill.value)}
							role="radio"
							aria-checked={categoryFilter === pill.value}
							className="px-3 py-1.5 rounded-full text-xs font-medium transition-colors"
							style={{
								backgroundColor:
									categoryFilter === pill.value ? theme.colors.accent : theme.colors.bgActivity,
								color: categoryFilter === pill.value ? '#fff' : theme.colors.textDim,
							}}
						>
							{pill.label}
						</button>
					))}
				</div>

				{/* Search bar */}
				<div className="relative mb-4">
					<Search
						className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 pointer-events-none"
						style={{ color: theme.colors.textDim }}
					/>
					<input
						type="text"
						placeholder="Search templates..."
						aria-label="Search templates"
						value={searchQuery}
						onChange={(e) => setSearchQuery(e.target.value)}
						className="w-full pl-9 pr-3 py-2 rounded-lg text-sm border outline-none"
						style={{
							backgroundColor: theme.colors.bgActivity,
							borderColor: theme.colors.border,
							color: theme.colors.textMain,
						}}
					/>
				</div>

				{/* Template card grid */}
				{filteredTemplates.length === 0 ? (
					<TeamOrchEmptyState theme={theme} message="No templates found" />
				) : (
					<div
						className="grid gap-3"
						style={{
							gridTemplateColumns: selectedTemplate
								? '1fr'
								: 'repeat(auto-fill, minmax(280px, 1fr))',
						}}
					>
						{filteredTemplates.map((template) => (
							<TemplateCard
								key={template.id}
								template={template}
								theme={theme}
								selected={template.id === selectedTemplateId}
								stats={data?.byTemplate?.[template.id] ?? null}
								onClick={() =>
									setSelectedTemplateId(template.id === selectedTemplateId ? null : template.id)
								}
							/>
						))}
					</div>
				)}
			</div>

			{/* Detail side panel */}
			{selectedTemplate && (
				<TemplateDetailPanel
					template={selectedTemplate}
					theme={theme}
					stats={data?.byTemplate?.[selectedTemplate.id] ?? null}
					onClose={() => setSelectedTemplateId(null)}
					onEditSave={handleEditSave}
					onDuplicate={handleDuplicate}
					onDelete={handleDelete}
					onExport={handleExport}
					onOpenBuilder={handleOpenBuilderForEdit}
				/>
			)}
		</div>
	);
});

/**
 * Inline form for creating a new template.
 */
const CreateTemplateForm = memo(function CreateTemplateForm({
	theme,
	onSave,
	onCancel,
}: {
	theme: Theme;
	onSave: (name: string, description: string, roles: TeamTemplateRole[]) => Promise<void>;
	onCancel: () => void;
}) {
	const [name, setName] = useState('');
	const [description, setDescription] = useState('');
	const [roles, setRoles] = useState<TeamTemplateRole[]>([createBlankRole()]);
	const [saving, setSaving] = useState(false);
	const nameRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		nameRef.current?.focus();
	}, []);

	const canSave = name.trim().length > 0 && roles.some((r) => r.name.trim().length > 0) && !saving;

	const handleSave = useCallback(async () => {
		if (!canSave) return;
		setSaving(true);
		try {
			const validRoles = roles.filter((r) => r.name.trim().length > 0);
			await onSave(name, description, validRoles);
		} catch (err) {
			notifyToast({
				type: 'error',
				title: 'Failed to create template',
				message: err instanceof Error ? err.message : 'An unexpected error occurred.',
			});
			setSaving(false);
		}
	}, [canSave, name, description, roles, onSave]);

	const updateRole = useCallback((idx: number, field: keyof TeamTemplateRole, value: string) => {
		setRoles((prev) => prev.map((r, i) => (i === idx ? { ...r, [field]: value } : r)));
	}, []);

	const removeRole = useCallback((idx: number) => {
		setRoles((prev) => prev.filter((_, i) => i !== idx));
	}, []);

	const addRole = useCallback(() => {
		setRoles((prev) => [...prev, createBlankRole()]);
	}, []);

	return (
		<div
			className="mb-4 p-4 rounded-lg border"
			style={{ borderColor: theme.colors.accent, backgroundColor: theme.colors.bgActivity }}
		>
			<div className="flex items-center justify-between mb-3">
				<h4 className="text-sm font-semibold" style={{ color: theme.colors.textMain }}>
					New Template
				</h4>
				<button
					onClick={onCancel}
					className="p-1 rounded hover:opacity-80"
					style={{ color: theme.colors.textDim }}
					aria-label="Cancel creating template"
				>
					<X className="w-4 h-4" aria-hidden="true" />
				</button>
			</div>

			<input
				ref={nameRef}
				type="text"
				placeholder="Template name"
				value={name}
				onChange={(e) => setName(e.target.value)}
				className="w-full px-3 py-2 rounded-lg text-sm border outline-none mb-2"
				style={{
					backgroundColor: theme.colors.bgMain,
					borderColor: theme.colors.border,
					color: theme.colors.textMain,
				}}
			/>
			<textarea
				placeholder="Description"
				value={description}
				onChange={(e) => setDescription(e.target.value)}
				rows={2}
				className="w-full px-3 py-2 rounded-lg text-sm border outline-none resize-none mb-3"
				style={{
					backgroundColor: theme.colors.bgMain,
					borderColor: theme.colors.border,
					color: theme.colors.textMain,
				}}
			/>

			{/* Roles */}
			<div className="mb-3">
				<div className="flex items-center justify-between mb-2">
					<span
						className="text-xs font-semibold uppercase tracking-wide"
						style={{ color: theme.colors.textDim }}
					>
						Roles
					</span>
					<button
						onClick={addRole}
						className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded"
						style={{ color: theme.colors.accent }}
					>
						<Plus className="w-3 h-3" /> Add Role
					</button>
				</div>
				<div className="space-y-2">
					{roles.map((role, idx) => (
						<RoleEditor
							key={idx}
							role={role}
							theme={theme}
							onChange={(field, value) => updateRole(idx, field, value)}
							onRemove={roles.length > 1 ? () => removeRole(idx) : undefined}
						/>
					))}
				</div>
			</div>

			<div className="flex justify-end gap-2">
				<button
					onClick={onCancel}
					className="px-3 py-1.5 rounded text-xs"
					style={{ color: theme.colors.textDim }}
				>
					Cancel
				</button>
				<button
					onClick={handleSave}
					disabled={!canSave}
					className="px-3 py-1.5 rounded text-xs font-medium"
					style={{
						backgroundColor: canSave ? theme.colors.accent : theme.colors.border,
						color: '#fff',
						opacity: canSave ? 1 : 0.5,
					}}
				>
					{saving ? 'Saving...' : 'Create'}
				</button>
			</div>
		</div>
	);
});

/**
 * Inline editor for a single role (used in create and edit forms).
 */
const RoleEditor = memo(function RoleEditor({
	role,
	theme,
	onChange,
	onRemove,
}: {
	role: TeamTemplateRole;
	theme: Theme;
	onChange: (field: keyof TeamTemplateRole, value: string) => void;
	onRemove?: () => void;
}) {
	return (
		<div
			className="flex items-start gap-2 p-2 rounded border"
			style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
		>
			<GripVertical
				className="w-3.5 h-3.5 mt-2 flex-shrink-0"
				style={{ color: theme.colors.textDim, opacity: 0.4 }}
			/>
			<div className="flex-1 min-w-0 space-y-1">
				<div className="flex gap-2">
					<input
						type="text"
						placeholder="Role name"
						value={role.name}
						onChange={(e) => onChange('name', e.target.value)}
						className="flex-1 px-2 py-1 rounded text-xs border outline-none"
						style={{
							backgroundColor: theme.colors.bgActivity,
							borderColor: theme.colors.border,
							color: theme.colors.textMain,
						}}
					/>
					<select
						value={role.agentId}
						onChange={(e) => onChange('agentId', e.target.value)}
						className="px-2 py-1 rounded text-xs border outline-none"
						style={{
							backgroundColor: theme.colors.bgActivity,
							borderColor: theme.colors.border,
							color: theme.colors.textMain,
						}}
					>
						{ROLE_AGENT_IDS.map((id) => (
							<option key={id} value={id}>
								{id}
							</option>
						))}
					</select>
				</div>
				<input
					type="text"
					placeholder="Description"
					value={role.description}
					onChange={(e) => onChange('description', e.target.value)}
					className="w-full px-2 py-1 rounded text-xs border outline-none"
					style={{
						backgroundColor: theme.colors.bgActivity,
						borderColor: theme.colors.border,
						color: theme.colors.textMain,
					}}
				/>
			</div>
			{onRemove && (
				<button
					onClick={onRemove}
					className="p-1 mt-1 rounded hover:opacity-80 flex-shrink-0"
					style={{ color: theme.colors.textDim }}
					aria-label="Remove role"
				>
					<X className="w-3.5 h-3.5" aria-hidden="true" />
				</button>
			)}
		</div>
	);
});

/**
 * A single template card in the grid.
 */
const TemplateCard = memo(function TemplateCard({
	template,
	theme,
	selected,
	stats,
	onClick,
}: {
	template: TeamTemplate;
	theme: Theme;
	selected: boolean;
	stats: { count: number; successRate: number; avgIterations: number } | null;
	onClick: () => void;
}) {
	const [hovered, setHovered] = useState(false);

	return (
		<button
			type="button"
			onClick={onClick}
			onMouseEnter={() => setHovered(true)}
			onMouseLeave={() => setHovered(false)}
			className="text-left p-4 rounded-lg border transition-colors outline-none"
			role="listitem"
			aria-selected={selected}
			style={{
				backgroundColor: hovered ? theme.colors.bgActivity : theme.colors.bgMain,
				borderColor: selected ? theme.colors.accent : theme.colors.border,
				borderWidth: selected ? 2 : 1,
			}}
		>
			<div className="flex items-start gap-3">
				{/* Icon fallback: first character */}
				<div
					className="flex-shrink-0 w-9 h-9 rounded-lg flex items-center justify-center text-sm font-bold"
					style={{
						backgroundColor: `${theme.colors.accent}15`,
						color: theme.colors.accent,
					}}
				>
					{template.name.charAt(0).toUpperCase()}
				</div>

				<div className="min-w-0 flex-1">
					<div className="text-sm font-semibold truncate" style={{ color: theme.colors.textMain }}>
						{template.name}
					</div>
					<div className="text-xs mt-0.5 line-clamp-2" style={{ color: theme.colors.textDim }}>
						{template.description}
					</div>

					{/* Badges row */}
					<div className="flex items-center gap-2 mt-2 flex-wrap">
						<span
							className="text-[10px] px-2 py-0.5 rounded-full"
							style={{
								backgroundColor: `${theme.colors.accent}15`,
								color: theme.colors.accent,
							}}
						>
							{template.roles.length} role{template.roles.length !== 1 ? 's' : ''}
						</span>

						{template.topology && (
							<span
								className="text-[10px] px-2 py-0.5 rounded-full"
								style={{
									backgroundColor: `${theme.colors.accent}15`,
									color: theme.colors.accent,
								}}
							>
								{topologyDisplayName(template.topology.pattern)}
							</span>
						)}

						{stats && stats.count > 0 && (
							<span
								className="text-[10px] px-2 py-0.5 rounded-full"
								style={{
									backgroundColor: `${theme.colors.success}15`,
									color: theme.colors.success,
								}}
							>
								{stats.count} run{stats.count !== 1 ? 's' : ''} ·{' '}
								{formatPercentage(stats.successRate)}
							</span>
						)}
					</div>
				</div>
			</div>
		</button>
	);
});

/**
 * Detail panel shown when a template is selected.
 * Supports inline editing for user templates.
 */
const TemplateDetailPanel = memo(function TemplateDetailPanel({
	template,
	theme,
	stats,
	onClose,
	onEditSave,
	onDuplicate,
	onDelete,
	onExport,
	onOpenBuilder,
}: {
	template: TeamTemplate;
	theme: Theme;
	stats: { count: number; successRate: number; avgIterations: number } | null;
	onClose: () => void;
	onEditSave: (updated: TeamTemplate) => Promise<void>;
	onDuplicate: (templateId: string) => Promise<void>;
	onDelete: (templateId: string) => Promise<void>;
	onExport: (template: TeamTemplate) => Promise<void>;
	onOpenBuilder: (template: TeamTemplate) => void;
}) {
	const [editing, setEditing] = useState(false);
	const [editName, setEditName] = useState(template.name);
	const [editDescription, setEditDescription] = useState(template.description);
	const [editRoles, setEditRoles] = useState<TeamTemplateRole[]>(template.roles);
	const [saving, setSaving] = useState(false);

	const isUserTemplate = template.category === 'user';

	// Reset edit state when template changes
	useEffect(() => {
		setEditing(false);
		setEditName(template.name);
		setEditDescription(template.description);
		setEditRoles(template.roles);
	}, [template.id, template.name, template.description, template.roles]);

	const startEditing = useCallback(() => {
		setEditName(template.name);
		setEditDescription(template.description);
		setEditRoles([...template.roles]);
		setEditing(true);
	}, [template]);

	const cancelEditing = useCallback(() => {
		setEditing(false);
		setEditName(template.name);
		setEditDescription(template.description);
		setEditRoles(template.roles);
	}, [template]);

	const handleEditSave = useCallback(async () => {
		if (!editName.trim()) return;
		setSaving(true);
		try {
			const validRoles = editRoles.filter((r) => r.name.trim().length > 0);
			await onEditSave({
				...template,
				name: editName.trim(),
				description: editDescription.trim(),
				roles: validRoles,
			});
			setEditing(false);
		} catch (err) {
			notifyToast({
				type: 'error',
				title: 'Failed to save',
				message: err instanceof Error ? err.message : 'An unexpected error occurred.',
			});
		} finally {
			setSaving(false);
		}
	}, [editName, editDescription, editRoles, template, onEditSave]);

	const updateEditRole = useCallback(
		(idx: number, field: keyof TeamTemplateRole, value: string) => {
			setEditRoles((prev) => prev.map((r, i) => (i === idx ? { ...r, [field]: value } : r)));
		},
		[]
	);

	const removeEditRole = useCallback((idx: number) => {
		setEditRoles((prev) => prev.filter((_, i) => i !== idx));
	}, []);

	const addEditRole = useCallback(() => {
		setEditRoles((prev) => [...prev, createBlankRole()]);
	}, []);

	const actionBtnStyle = {
		backgroundColor: theme.colors.bgActivity,
		color: theme.colors.textDim,
	};

	return (
		<div
			className="w-[40%] min-w-[280px] max-w-[400px] rounded-lg border p-4 overflow-y-auto flex-shrink-0"
			style={{
				backgroundColor: theme.colors.bgMain,
				borderColor: theme.colors.border,
			}}
		>
			{/* Header */}
			<div className="flex items-start justify-between mb-4">
				<div className="min-w-0 flex-1">
					{editing ? (
						<>
							<input
								type="text"
								value={editName}
								onChange={(e) => setEditName(e.target.value)}
								className="w-full text-base font-semibold px-2 py-1 rounded border outline-none mb-1"
								style={{
									backgroundColor: theme.colors.bgActivity,
									borderColor: theme.colors.border,
									color: theme.colors.textMain,
								}}
							/>
							<textarea
								value={editDescription}
								onChange={(e) => setEditDescription(e.target.value)}
								rows={2}
								className="w-full text-xs px-2 py-1 rounded border outline-none resize-none"
								style={{
									backgroundColor: theme.colors.bgActivity,
									borderColor: theme.colors.border,
									color: theme.colors.textMain,
								}}
							/>
						</>
					) : (
						<>
							<h3 className="text-base font-semibold" style={{ color: theme.colors.textMain }}>
								{template.name}
							</h3>
							<p className="text-xs mt-1" style={{ color: theme.colors.textDim }}>
								{template.description}
							</p>
						</>
					)}
				</div>
				<button
					onClick={onClose}
					className="flex-shrink-0 ml-2 text-xs px-2 py-1 rounded hover:opacity-80"
					style={{ color: theme.colors.textDim }}
					aria-label="Close template details"
				>
					✕
				</button>
			</div>

			{/* Category badge */}
			<div className="mb-4">
				<span
					className="text-[10px] px-2 py-0.5 rounded-full font-medium"
					style={{
						backgroundColor: `${theme.colors.accent}15`,
						color: theme.colors.accent,
					}}
				>
					{template.category}
				</span>
			</div>

			{/* Action buttons */}
			<div className="flex items-center gap-2 mb-4 flex-wrap">
				{isUserTemplate && !editing && (
					<>
						<button
							onClick={() => onOpenBuilder(template)}
							className="flex items-center gap-1 px-2.5 py-1.5 rounded text-xs transition-colors hover:opacity-80"
							style={actionBtnStyle}
						>
							<Pencil className="w-3 h-3" /> Open in Builder
						</button>
						<button
							onClick={startEditing}
							className="flex items-center gap-1 px-2.5 py-1.5 rounded text-xs transition-colors hover:opacity-80"
							style={actionBtnStyle}
						>
							<Pencil className="w-3 h-3" /> Quick Edit
						</button>
					</>
				)}
				{editing && (
					<>
						<button
							onClick={handleEditSave}
							disabled={saving || !editName.trim()}
							className="flex items-center gap-1 px-2.5 py-1.5 rounded text-xs font-medium transition-colors"
							style={{
								backgroundColor:
									editName.trim() && !saving ? theme.colors.accent : theme.colors.border,
								color: '#fff',
								opacity: editName.trim() && !saving ? 1 : 0.5,
							}}
						>
							{saving ? 'Saving...' : 'Save'}
						</button>
						<button
							onClick={cancelEditing}
							className="px-2.5 py-1.5 rounded text-xs transition-colors hover:opacity-80"
							style={actionBtnStyle}
						>
							Cancel
						</button>
					</>
				)}
				{!editing && (
					<>
						<button
							onClick={() => onDuplicate(template.id)}
							className="flex items-center gap-1 px-2.5 py-1.5 rounded text-xs transition-colors hover:opacity-80"
							style={actionBtnStyle}
						>
							<Copy className="w-3 h-3" /> Duplicate
						</button>
						<button
							onClick={() => onExport(template)}
							className="flex items-center gap-1 px-2.5 py-1.5 rounded text-xs transition-colors hover:opacity-80"
							style={actionBtnStyle}
						>
							<Download className="w-3 h-3" /> Export
						</button>
						{isUserTemplate && (
							<button
								onClick={() => onDelete(template.id)}
								className="flex items-center gap-1 px-2.5 py-1.5 rounded text-xs transition-colors hover:opacity-80"
								style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.error }}
							>
								<Trash2 className="w-3 h-3" aria-hidden="true" /> Delete
							</button>
						)}
					</>
				)}
			</div>

			{/* Usage stats */}
			{stats && stats.count > 0 && (
				<div
					className="mb-4 p-3 rounded-lg text-xs"
					style={{ backgroundColor: theme.colors.bgActivity }}
				>
					<div className="flex justify-between mb-1">
						<span style={{ color: theme.colors.textDim }}>Times used</span>
						<span style={{ color: theme.colors.textMain }}>{stats.count}</span>
					</div>
					<div className="flex justify-between mb-1">
						<span style={{ color: theme.colors.textDim }}>Success rate</span>
						<span style={{ color: theme.colors.textMain }}>
							{formatPercentage(stats.successRate)}
						</span>
					</div>
					<div className="flex justify-between">
						<span style={{ color: theme.colors.textDim }}>Avg iterations</span>
						<span style={{ color: theme.colors.textMain }}>{stats.avgIterations.toFixed(1)}</span>
					</div>
				</div>
			)}

			{/* Roles list */}
			<div className="mb-4">
				<div className="flex items-center justify-between mb-2">
					<h4
						className="text-xs font-semibold uppercase tracking-wide"
						style={{ color: theme.colors.textDim }}
					>
						Roles ({editing ? editRoles.length : template.roles.length})
					</h4>
					{editing && (
						<button
							onClick={addEditRole}
							className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded"
							style={{ color: theme.colors.accent }}
						>
							<Plus className="w-3 h-3" /> Add
						</button>
					)}
				</div>
				{editing ? (
					<div className="space-y-2">
						{editRoles.map((role, idx) => (
							<RoleEditor
								key={idx}
								role={role}
								theme={theme}
								onChange={(field, value) => updateEditRole(idx, field, value)}
								onRemove={editRoles.length > 1 ? () => removeEditRole(idx) : undefined}
							/>
						))}
					</div>
				) : (
					<div className="space-y-2" role="list" aria-label="Template roles">
						{template.roles.map((role, idx) => (
							<div
								key={idx}
								className="p-2 rounded border text-xs"
								style={{
									borderColor: theme.colors.border,
									backgroundColor: theme.colors.bgActivity,
								}}
							>
								<div className="flex items-center gap-2 mb-0.5">
									<span className="font-medium" style={{ color: theme.colors.textMain }}>
										{role.name}
									</span>
									<span
										className="text-[10px] px-1.5 py-0.5 rounded"
										style={{
											backgroundColor: `${theme.colors.border}80`,
											color: theme.colors.textDim,
										}}
									>
										{role.agentId}
									</span>
								</div>
								<p style={{ color: theme.colors.textDim }}>{role.description}</p>
							</div>
						))}
					</div>
				)}
			</div>

			{/* Topology preview */}
			{template.topology && (
				<div className="mb-4">
					<h4
						className="text-xs font-semibold mb-2 uppercase tracking-wide"
						style={{ color: theme.colors.textDim }}
					>
						Topology
					</h4>
					<div className="rounded-lg border p-3" style={{ borderColor: theme.colors.border }}>
						<WorkflowGraph
							topology={template.topology}
							participants={[]}
							theme={theme}
							compact={true}
						/>
					</div>
				</div>
			)}

			{/* Moderator */}
			<div className="mb-4">
				<h4
					className="text-xs font-semibold mb-1 uppercase tracking-wide"
					style={{ color: theme.colors.textDim }}
				>
					Moderator
				</h4>
				<span className="text-xs" style={{ color: theme.colors.textMain }}>
					{template.moderatorAgentId}
				</span>
			</div>

			{/* Timestamps */}
			<div className="text-[10px] space-y-1" style={{ color: theme.colors.textDim }}>
				<div>Created: {new Date(template.createdAt).toLocaleDateString()}</div>
				<div>Updated: {new Date(template.updatedAt).toLocaleDateString()}</div>
			</div>
		</div>
	);
});

export default TemplatesTab;
