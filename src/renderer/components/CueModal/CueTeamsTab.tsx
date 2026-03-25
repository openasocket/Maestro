/**
 * CueTeamsTab — Team template management within the CueModal.
 *
 * Provides full CRUD for team templates inline in the Cue workflow.
 * Two-panel layout: template list (left) + detail/edit panel (right).
 *
 * Sub-components: CreateTemplateForm, TemplateCard, TemplateDetailPanel, RoleRow.
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
	Users,
	ChevronDown,
	List,
	GitFork,
} from 'lucide-react';
import type { Theme } from '../../types';
import type {
	TeamTemplate,
	TeamTemplateRole,
	WorkflowTopology,
	WorkflowEdge,
} from '../../../shared/group-chat-types';
import { WorkflowGraph } from '../GroupChat/WorkflowGraph';
import { AGENT_IDS } from '../../../shared/agentIds';
import { notifyToast } from '../../stores/notificationStore';
import { safeClipboardWrite } from '../../utils/clipboard';
import { TeamBuilderCanvas } from './TeamBuilderCanvas';

// ============================================================================
// Utility functions (duplicated from TemplatesTab per spec — not imported)
// ============================================================================

function generateUUID(): string {
	return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
		const r = (Math.random() * 16) | 0;
		const v = c === 'x' ? r : (r & 0x3) | 0x8;
		return v.toString(16);
	});
}

function createBlankRole(): TeamTemplateRole {
	return { name: '', agentId: 'claude-code', description: '' };
}

function isValidTemplateShape(obj: unknown): obj is Partial<TeamTemplate> {
	if (!obj || typeof obj !== 'object') return false;
	const t = obj as Record<string, unknown>;
	return typeof t.name === 'string' && typeof t.description === 'string' && Array.isArray(t.roles);
}

/** Agent IDs available for role assignment (exclude terminal) */
const ROLE_AGENT_IDS = AGENT_IDS.filter((id) => id !== 'terminal');

// ============================================================================
// Topology helpers
// ============================================================================

const TOPOLOGY_PATTERNS: {
	value: WorkflowTopology['pattern'];
	label: string;
}[] = [
	{ value: 'hub-spoke', label: 'Hub-Spoke' },
	{ value: 'pipeline', label: 'Pipeline' },
	{ value: 'parallel-then-merge', label: 'Parallel-then-Merge' },
	{ value: 'review-loop', label: 'Review-Loop' },
	{ value: 'custom', label: 'Custom' },
];

/**
 * Generate a WorkflowTopology with auto-generated edges based on the selected
 * pattern and the current roles list.
 */
function generateTopologyEdges(
	pattern: WorkflowTopology['pattern'],
	roles: TeamTemplateRole[]
): WorkflowTopology | undefined {
	if (roles.length < 2) return undefined;

	switch (pattern) {
		case 'hub-spoke':
			return {
				pattern: 'hub-spoke',
				edges: [],
				entryPoint: roles[0].name,
				exitPoint: roles[roles.length - 1].name,
			};

		case 'pipeline': {
			const edges: WorkflowEdge[] = [];
			for (let i = 0; i < roles.length - 1; i++) {
				edges.push({
					source: roles[i].name,
					target: roles[i + 1].name,
					edgeType: 'sequential',
				});
			}
			return {
				pattern: 'pipeline',
				edges,
				entryPoint: roles[0].name,
				exitPoint: roles[roles.length - 1].name,
			};
		}

		case 'parallel-then-merge': {
			const edges: WorkflowEdge[] = [];
			const entry = roles[0];
			const exit = roles[roles.length - 1];
			const middle = roles.slice(1, -1);

			// Entry → each middle role (parallel)
			for (const m of middle) {
				edges.push({ source: entry.name, target: m.name, edgeType: 'parallel' });
			}
			// Each middle role → exit
			for (const m of middle) {
				edges.push({ source: m.name, target: exit.name, edgeType: 'sequential' });
			}

			// If only 2 roles, treat second as both parallel and merge target
			if (middle.length === 0) {
				edges.push({ source: entry.name, target: exit.name, edgeType: 'parallel' });
			}

			return {
				pattern: 'parallel-then-merge',
				edges,
				entryPoint: entry.name,
				exitPoint: exit.name,
			};
		}

		case 'review-loop': {
			const edges: WorkflowEdge[] = [
				{ source: roles[0].name, target: roles[1].name, edgeType: 'sequential' },
				{
					source: roles[1].name,
					target: roles[0].name,
					edgeType: 'conditional',
					condition: 'needs revision',
				},
			];
			return {
				pattern: 'review-loop',
				edges,
				entryPoint: roles[0].name,
				exitPoint: roles[1].name,
			};
		}

		case 'custom':
			return {
				pattern: 'custom',
				edges: [],
				entryPoint: roles[0].name,
				exitPoint: roles[roles.length - 1].name,
			};

		default:
			return undefined;
	}
}

type CategoryFilter = 'all' | 'builtin' | 'user';

const CATEGORY_PILLS: { value: CategoryFilter; label: string }[] = [
	{ value: 'all', label: 'All' },
	{ value: 'builtin', label: 'Built-in' },
	{ value: 'user', label: 'User' },
];

// ============================================================================
// CueTeamsTab — Main component
// ============================================================================

export interface CueTeamsTabProps {
	theme: Theme;
	/** Called after any CRUD operation so Pipeline Editor can re-fetch teams */
	onTeamTemplatesChanged?: () => void;
	/** If provided, auto-select this template on mount/change */
	initialSelectedTemplateId?: string;
}

export function CueTeamsTab({
	theme,
	onTeamTemplatesChanged,
	initialSelectedTemplateId,
}: CueTeamsTabProps) {
	const [templates, setTemplates] = useState<TeamTemplate[]>([]);
	const [loading, setLoading] = useState(true);
	const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
	const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('all');
	const [searchQuery, setSearchQuery] = useState('');
	const [debouncedSearch, setDebouncedSearch] = useState('');
	const [showCreateForm, setShowCreateForm] = useState(false);
	const mountedRef = useRef(true);

	// Sub-view toggle: Library (list/CRUD) or Builder (ReactFlow canvas)
	const [view, setView] = useState<'library' | 'builder'>('library');
	const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);

	// Debounce search input (300ms)
	useEffect(() => {
		const timer = setTimeout(() => {
			setDebouncedSearch(searchQuery);
		}, 300);
		return () => clearTimeout(timer);
	}, [searchQuery]);

	// Fetch templates
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

	// Auto-select template when navigated to from Pipeline Editor
	useEffect(() => {
		if (initialSelectedTemplateId) {
			setSelectedTemplateId(initialSelectedTemplateId);
		}
	}, [initialSelectedTemplateId]);

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
			onTeamTemplatesChanged?.();
		},
		[fetchTemplates, onTeamTemplatesChanged]
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
			onTeamTemplatesChanged?.();
		},
		[fetchTemplates, onTeamTemplatesChanged]
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
			onTeamTemplatesChanged?.();
		},
		[fetchTemplates, templates, onTeamTemplatesChanged]
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
			notifyToast({ type: 'success', title: 'Template deleted', message: 'Template removed.' });
			onTeamTemplatesChanged?.();
		},
		[fetchTemplates, templates, selectedTemplateId, onTeamTemplatesChanged]
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
			onTeamTemplatesChanged?.();
		} catch (err) {
			notifyToast({
				type: 'error',
				title: 'Import failed',
				message: err instanceof Error ? err.message : 'An unexpected error occurred.',
			});
		}
	}, [fetchTemplates, onTeamTemplatesChanged]);

	// When switching to Builder, sync the selected template for editing
	const editingTemplate = useMemo(
		() => templates.find((t) => t.id === editingTemplateId) ?? undefined,
		[templates, editingTemplateId]
	);

	const handleSwitchToBuilder = useCallback(
		(templateId?: string) => {
			setEditingTemplateId(templateId ?? selectedTemplateId);
			setView('builder');
		},
		[selectedTemplateId]
	);

	const handleBuilderSave = useCallback(
		async (template: TeamTemplate) => {
			await window.maestro.teamTemplates.save({ ...template, updatedAt: Date.now() });
			await fetchTemplates();
			notifyToast({
				type: 'success',
				title: 'Template saved',
				message: `"${template.name}" saved from builder.`,
			});
			onTeamTemplatesChanged?.();
			setView('library');
			setEditingTemplateId(null);
		},
		[fetchTemplates, onTeamTemplatesChanged]
	);

	const handleBuilderCancel = useCallback(() => {
		setView('library');
		setEditingTemplateId(null);
	}, []);

	// Loading state
	if (loading) {
		return (
			<div className="flex-1 flex items-center justify-center" style={{ padding: 20 }}>
				<div className="text-sm" style={{ color: theme.colors.textDim }}>
					Loading templates...
				</div>
			</div>
		);
	}

	return (
		<div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
			{/* Sub-view toggle bar */}
			<div style={{ padding: '12px 20px 0 20px', flexShrink: 0 }}>
				<div
					className="flex items-center gap-1 rounded-md p-0.5"
					style={{ backgroundColor: theme.colors.bgActivity, display: 'inline-flex' }}
				>
					<button
						onClick={() => setView('library')}
						className="flex items-center gap-1.5 px-3 py-1 rounded text-xs font-medium transition-colors"
						style={{
							backgroundColor: view === 'library' ? theme.colors.bgMain : 'transparent',
							color: view === 'library' ? theme.colors.textMain : theme.colors.textDim,
						}}
					>
						<List className="w-3.5 h-3.5" />
						Library
					</button>
					<button
						onClick={() => handleSwitchToBuilder()}
						className="flex items-center gap-1.5 px-3 py-1 rounded text-xs font-medium transition-colors"
						style={{
							backgroundColor: view === 'builder' ? theme.colors.bgMain : 'transparent',
							color: view === 'builder' ? theme.colors.textMain : theme.colors.textDim,
						}}
					>
						<GitFork className="w-3.5 h-3.5" />
						Builder
					</button>
				</div>
			</div>

			{/* Content */}
			{view === 'builder' ? (
				<TeamBuilderCanvas
					theme={theme}
					editingTemplate={editingTemplate}
					onSave={handleBuilderSave}
					onCancel={handleBuilderCancel}
				/>
			) : (
				<div
					style={{
						display: 'flex',
						gap: 16,
						padding: 20,
						flex: 1,
						minHeight: 0,
						overflow: 'hidden',
					}}
				>
					{/* Left: template list */}
					<div style={{ flex: 1, minWidth: 0, overflowY: 'auto' }}>
						{/* Action row: Create + Import buttons */}
						<div className="flex items-center gap-2 mb-3">
							<button
								onClick={() => setShowCreateForm((v) => !v)}
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

						{/* Inline create form */}
						{showCreateForm && (
							<CreateTemplateForm
								theme={theme}
								onSave={handleCreateSave}
								onCancel={() => setShowCreateForm(false)}
							/>
						)}

						{/* Template card list */}
						{filteredTemplates.length === 0 ? (
							<div
								className="flex flex-col items-center justify-center py-12 text-center"
								style={{ color: theme.colors.textDim }}
							>
								<Users className="w-8 h-8 mb-2" style={{ opacity: 0.4 }} />
								<p className="text-sm">No templates found</p>
							</div>
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
										onClick={() =>
											setSelectedTemplateId(template.id === selectedTemplateId ? null : template.id)
										}
									/>
								))}
							</div>
						)}
					</div>

					{/* Right: detail/edit panel (when selected) */}
					{selectedTemplate && (
						<TemplateDetailPanel
							template={selectedTemplate}
							theme={theme}
							onClose={() => setSelectedTemplateId(null)}
							onEditSave={handleEditSave}
							onDuplicate={handleDuplicate}
							onDelete={handleDelete}
							onExport={handleExport}
						/>
					)}
				</div>
			)}
		</div>
	);
}

// ============================================================================
// CreateTemplateForm
// ============================================================================

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

	const updateRole = useCallback(
		(idx: number, field: keyof TeamTemplateRole, value: string | string[]) => {
			setRoles((prev) => prev.map((r, i) => (i === idx ? { ...r, [field]: value } : r)));
		},
		[]
	);

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
						<RoleRow
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

// ============================================================================
// RoleRow
// ============================================================================

const RoleRow = memo(function RoleRow({
	role,
	theme,
	onChange,
	onRemove,
}: {
	role: TeamTemplateRole;
	theme: Theme;
	onChange: (field: keyof TeamTemplateRole, value: string | string[]) => void;
	onRemove?: () => void;
}) {
	const [expanded, setExpanded] = useState(false);

	return (
		<div
			className="rounded border"
			style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
		>
			<div className="flex items-start gap-2 p-2">
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
				<button
					onClick={() => setExpanded((v) => !v)}
					className="p-1 mt-1 rounded hover:opacity-80 flex-shrink-0"
					style={{ color: theme.colors.textDim }}
					aria-label={expanded ? 'Collapse role details' : 'Expand role details'}
				>
					<ChevronDown
						className="w-3.5 h-3.5 transition-transform"
						style={{ transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)' }}
						aria-hidden="true"
					/>
				</button>
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
			{expanded && (
				<div
					className="px-2 pb-2 pt-1 space-y-2"
					style={{ borderTop: `1px solid ${theme.colors.border}`, marginLeft: 20 }}
				>
					<div>
						<label
							className="block text-[10px] font-medium mb-1"
							style={{ color: theme.colors.textDim }}
						>
							System Prompt Suffix
						</label>
						<textarea
							rows={2}
							placeholder="Additional context injected into this role's prompt..."
							value={role.systemPromptSuffix ?? ''}
							onChange={(e) => onChange('systemPromptSuffix', e.target.value)}
							className="w-full px-2 py-1 rounded text-xs border outline-none resize-none"
							style={{
								backgroundColor: theme.colors.bgActivity,
								borderColor: theme.colors.border,
								color: theme.colors.textMain,
							}}
						/>
					</div>
					<div className="flex gap-2">
						<div className="flex-1">
							<label
								className="block text-[10px] font-medium mb-1"
								style={{ color: theme.colors.textDim }}
							>
								Expects (input)
							</label>
							<input
								type="text"
								placeholder="comma-separated inputs"
								value={(role.inputContract ?? []).join(', ')}
								onChange={(e) => {
									const val = e.target.value;
									const arr = val
										? val
												.split(',')
												.map((s) => s.trim())
												.filter(Boolean)
										: [];
									onChange('inputContract', arr);
								}}
								className="w-full px-2 py-1 rounded text-xs border outline-none"
								style={{
									backgroundColor: theme.colors.bgActivity,
									borderColor: theme.colors.border,
									color: theme.colors.textMain,
								}}
							/>
						</div>
						<div className="flex-1">
							<label
								className="block text-[10px] font-medium mb-1"
								style={{ color: theme.colors.textDim }}
							>
								Produces (output)
							</label>
							<input
								type="text"
								placeholder="comma-separated outputs"
								value={(role.outputContract ?? []).join(', ')}
								onChange={(e) => {
									const val = e.target.value;
									const arr = val
										? val
												.split(',')
												.map((s) => s.trim())
												.filter(Boolean)
										: [];
									onChange('outputContract', arr);
								}}
								className="w-full px-2 py-1 rounded text-xs border outline-none"
								style={{
									backgroundColor: theme.colors.bgActivity,
									borderColor: theme.colors.border,
									color: theme.colors.textMain,
								}}
							/>
						</div>
					</div>
				</div>
			)}
		</div>
	);
});

// ============================================================================
// TemplateCard
// ============================================================================

const TemplateCard = memo(function TemplateCard({
	template,
	theme,
	selected,
	onClick,
}: {
	template: TeamTemplate;
	theme: Theme;
	selected: boolean;
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
				{/* First-character avatar badge */}
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
								{template.topology.pattern}
							</span>
						)}

						<span
							className="text-[10px] px-2 py-0.5 rounded-full"
							style={{
								backgroundColor: `${theme.colors.border}80`,
								color: theme.colors.textDim,
							}}
						>
							{template.category}
						</span>
					</div>
				</div>
			</div>
		</button>
	);
});

// ============================================================================
// TopologyEditor
// ============================================================================

const TopologyEditor = memo(function TopologyEditor({
	topology,
	roles,
	theme,
	onChange,
}: {
	topology: WorkflowTopology | undefined;
	roles: TeamTemplateRole[];
	theme: Theme;
	onChange: (topology: WorkflowTopology | undefined) => void;
}) {
	const validRoles = roles.filter((r) => r.name.trim().length > 0);
	const hasEnoughRoles = validRoles.length >= 2;
	const selectedPattern = topology?.pattern ?? null;

	const handlePatternSelect = useCallback(
		(pattern: WorkflowTopology['pattern']) => {
			if (!hasEnoughRoles) return;
			// Deselect if already selected
			if (selectedPattern === pattern) {
				onChange(undefined);
				return;
			}
			const newTopology = generateTopologyEdges(pattern, validRoles);
			onChange(newTopology);
		},
		[hasEnoughRoles, selectedPattern, validRoles, onChange]
	);

	const handleCustomEdgeAdd = useCallback(() => {
		if (!topology || topology.pattern !== 'custom') return;
		const newEdge: WorkflowEdge = {
			source: validRoles[0]?.name ?? '',
			target: validRoles[1]?.name ?? validRoles[0]?.name ?? '',
			edgeType: 'sequential',
		};
		onChange({ ...topology, edges: [...topology.edges, newEdge] });
	}, [topology, validRoles, onChange]);

	const handleCustomEdgeRemove = useCallback(
		(idx: number) => {
			if (!topology || topology.pattern !== 'custom') return;
			onChange({ ...topology, edges: topology.edges.filter((_, i) => i !== idx) });
		},
		[topology, onChange]
	);

	const handleCustomEdgeUpdate = useCallback(
		(idx: number, field: keyof WorkflowEdge, value: string) => {
			if (!topology || topology.pattern !== 'custom') return;
			const updatedEdges = topology.edges.map((e, i) => (i === idx ? { ...e, [field]: value } : e));
			onChange({ ...topology, edges: updatedEdges });
		},
		[topology, onChange]
	);

	const handleEntryPointChange = useCallback(
		(value: string) => {
			if (!topology) return;
			onChange({ ...topology, entryPoint: value });
		},
		[topology, onChange]
	);

	const handleExitPointChange = useCallback(
		(value: string) => {
			if (!topology) return;
			onChange({ ...topology, exitPoint: value });
		},
		[topology, onChange]
	);

	return (
		<div className="mb-4">
			<h4
				className="text-xs font-semibold mb-2 uppercase tracking-wide"
				style={{ color: theme.colors.textDim }}
			>
				Topology
			</h4>

			{!hasEnoughRoles && (
				<p className="text-[10px] mb-2" style={{ color: theme.colors.textDim }}>
					Add at least 2 roles to configure topology.
				</p>
			)}

			{/* Pattern selector pills */}
			<div className="flex flex-wrap gap-1.5 mb-3">
				{TOPOLOGY_PATTERNS.map((p) => (
					<button
						key={p.value}
						onClick={() => handlePatternSelect(p.value)}
						disabled={!hasEnoughRoles}
						className="px-2.5 py-1 rounded-full text-[10px] font-medium transition-colors"
						style={{
							backgroundColor:
								selectedPattern === p.value ? theme.colors.accent : theme.colors.bgActivity,
							color: selectedPattern === p.value ? '#fff' : theme.colors.textDim,
							opacity: hasEnoughRoles ? 1 : 0.4,
							cursor: hasEnoughRoles ? 'pointer' : 'not-allowed',
						}}
					>
						{p.label}
					</button>
				))}
			</div>

			{/* Topology preview */}
			{topology && (
				<div
					className="mb-3 p-3 rounded-lg border"
					style={{
						borderColor: theme.colors.border,
						backgroundColor: theme.colors.bgActivity,
					}}
				>
					<WorkflowGraph topology={topology} participants={[]} theme={theme} compact={true} />
				</div>
			)}

			{/* Custom Edge Editor */}
			{topology?.pattern === 'custom' && (
				<div className="space-y-2">
					{/* Entry/Exit point selectors */}
					<div className="flex gap-2">
						<div className="flex-1">
							<label
								className="text-[10px] font-medium mb-0.5 block"
								style={{ color: theme.colors.textDim }}
							>
								Entry Point
							</label>
							<select
								value={topology.entryPoint}
								onChange={(e) => handleEntryPointChange(e.target.value)}
								className="w-full px-2 py-1 rounded text-xs border outline-none"
								style={{
									backgroundColor: theme.colors.bgActivity,
									borderColor: theme.colors.border,
									color: theme.colors.textMain,
								}}
							>
								{validRoles.map((r) => (
									<option key={r.name} value={r.name}>
										{r.name}
									</option>
								))}
							</select>
						</div>
						<div className="flex-1">
							<label
								className="text-[10px] font-medium mb-0.5 block"
								style={{ color: theme.colors.textDim }}
							>
								Exit Point
							</label>
							<select
								value={topology.exitPoint}
								onChange={(e) => handleExitPointChange(e.target.value)}
								className="w-full px-2 py-1 rounded text-xs border outline-none"
								style={{
									backgroundColor: theme.colors.bgActivity,
									borderColor: theme.colors.border,
									color: theme.colors.textMain,
								}}
							>
								{validRoles.map((r) => (
									<option key={r.name} value={r.name}>
										{r.name}
									</option>
								))}
							</select>
						</div>
					</div>

					{/* Edge list */}
					{topology.edges.map((edge, idx) => (
						<div
							key={idx}
							className="flex items-center gap-1.5 p-2 rounded border"
							style={{
								borderColor: theme.colors.border,
								backgroundColor: theme.colors.bgMain,
							}}
						>
							<select
								value={edge.source}
								onChange={(e) => handleCustomEdgeUpdate(idx, 'source', e.target.value)}
								className="flex-1 px-1.5 py-1 rounded text-[10px] border outline-none"
								style={{
									backgroundColor: theme.colors.bgActivity,
									borderColor: theme.colors.border,
									color: theme.colors.textMain,
								}}
							>
								{validRoles.map((r) => (
									<option key={r.name} value={r.name}>
										{r.name}
									</option>
								))}
							</select>
							<span className="text-[10px]" style={{ color: theme.colors.textDim }}>
								→
							</span>
							<select
								value={edge.target}
								onChange={(e) => handleCustomEdgeUpdate(idx, 'target', e.target.value)}
								className="flex-1 px-1.5 py-1 rounded text-[10px] border outline-none"
								style={{
									backgroundColor: theme.colors.bgActivity,
									borderColor: theme.colors.border,
									color: theme.colors.textMain,
								}}
							>
								{validRoles.map((r) => (
									<option key={r.name} value={r.name}>
										{r.name}
									</option>
								))}
							</select>
							<select
								value={edge.edgeType}
								onChange={(e) => handleCustomEdgeUpdate(idx, 'edgeType', e.target.value)}
								className="px-1.5 py-1 rounded text-[10px] border outline-none"
								style={{
									backgroundColor: theme.colors.bgActivity,
									borderColor: theme.colors.border,
									color: theme.colors.textMain,
								}}
							>
								<option value="sequential">sequential</option>
								<option value="parallel">parallel</option>
								<option value="conditional">conditional</option>
							</select>
							{edge.edgeType === 'conditional' && (
								<input
									type="text"
									placeholder="Condition..."
									value={edge.condition ?? ''}
									onChange={(e) => handleCustomEdgeUpdate(idx, 'condition', e.target.value)}
									className="flex-1 px-1.5 py-1 rounded text-[10px] border outline-none"
									style={{
										backgroundColor: theme.colors.bgActivity,
										borderColor: theme.colors.border,
										color: theme.colors.textMain,
									}}
								/>
							)}
							<button
								onClick={() => handleCustomEdgeRemove(idx)}
								className="p-0.5 rounded hover:opacity-80 flex-shrink-0"
								style={{ color: theme.colors.textDim }}
								aria-label="Remove edge"
							>
								<X className="w-3 h-3" />
							</button>
						</div>
					))}

					<button
						onClick={handleCustomEdgeAdd}
						className="flex items-center gap-1 text-[10px] px-2 py-1 rounded"
						style={{ color: theme.colors.accent }}
					>
						<Plus className="w-3 h-3" /> Add Edge
					</button>
				</div>
			)}
		</div>
	);
});

// ============================================================================
// TemplateDetailPanel
// ============================================================================

const TemplateDetailPanel = memo(function TemplateDetailPanel({
	template,
	theme,
	onClose,
	onEditSave,
	onDuplicate,
	onDelete,
	onExport,
}: {
	template: TeamTemplate;
	theme: Theme;
	onClose: () => void;
	onEditSave: (updated: TeamTemplate) => Promise<void>;
	onDuplicate: (templateId: string) => Promise<void>;
	onDelete: (templateId: string) => Promise<void>;
	onExport: (template: TeamTemplate) => Promise<void>;
}) {
	const [editing, setEditing] = useState(false);
	const [editName, setEditName] = useState(template.name);
	const [editDescription, setEditDescription] = useState(template.description);
	const [editRoles, setEditRoles] = useState<TeamTemplateRole[]>(template.roles);
	const [editModeratorAgentId, setEditModeratorAgentId] = useState(template.moderatorAgentId);
	const [editTopology, setEditTopology] = useState<WorkflowTopology | undefined>(template.topology);
	const [editCustomArgs, setEditCustomArgs] = useState(template.moderatorConfig?.customArgs ?? '');
	const [editEnvVarEntries, setEditEnvVarEntries] = useState<Array<{ key: string; value: string }>>(
		Object.entries(template.moderatorConfig?.customEnvVars ?? {}).map(([key, value]) => ({
			key,
			value,
		}))
	);
	const [customArgsOpen, setCustomArgsOpen] = useState(false);
	const [envVarsOpen, setEnvVarsOpen] = useState(false);
	const [saving, setSaving] = useState(false);

	const isUserTemplate = template.category === 'user';

	// Reset edit state when template changes
	useEffect(() => {
		setEditing(false);
		setEditName(template.name);
		setEditDescription(template.description);
		setEditRoles(template.roles);
		setEditModeratorAgentId(template.moderatorAgentId);
		setEditTopology(template.topology);
		setEditCustomArgs(template.moderatorConfig?.customArgs ?? '');
		setEditEnvVarEntries(
			Object.entries(template.moderatorConfig?.customEnvVars ?? {}).map(([key, value]) => ({
				key,
				value,
			}))
		);
	}, [
		template.id,
		template.name,
		template.description,
		template.roles,
		template.moderatorAgentId,
		template.topology,
		template.moderatorConfig,
	]);

	const startEditing = useCallback(() => {
		setEditName(template.name);
		setEditDescription(template.description);
		setEditRoles([...template.roles]);
		setEditModeratorAgentId(template.moderatorAgentId);
		setEditTopology(template.topology ? { ...template.topology } : undefined);
		setEditCustomArgs(template.moderatorConfig?.customArgs ?? '');
		setEditEnvVarEntries(
			Object.entries(template.moderatorConfig?.customEnvVars ?? {}).map(([key, value]) => ({
				key,
				value,
			}))
		);
		setEditing(true);
	}, [template]);

	const cancelEditing = useCallback(() => {
		setEditing(false);
		setEditName(template.name);
		setEditDescription(template.description);
		setEditRoles(template.roles);
		setEditModeratorAgentId(template.moderatorAgentId);
		setEditTopology(template.topology);
		setEditCustomArgs(template.moderatorConfig?.customArgs ?? '');
		setEditEnvVarEntries(
			Object.entries(template.moderatorConfig?.customEnvVars ?? {}).map(([key, value]) => ({
				key,
				value,
			}))
		);
	}, [template]);

	const handleEditSave = useCallback(async () => {
		if (!editName.trim()) return;
		setSaving(true);
		try {
			const validRoles = editRoles.filter((r) => r.name.trim().length > 0);

			// Build moderatorConfig from edit state
			const envVars: Record<string, string> = {};
			for (const entry of editEnvVarEntries) {
				if (entry.key.trim()) envVars[entry.key.trim()] = entry.value;
			}
			const hasConfig = editCustomArgs.trim() || Object.keys(envVars).length > 0;
			const moderatorConfig = hasConfig
				? {
						customArgs: editCustomArgs.trim() || undefined,
						customEnvVars: Object.keys(envVars).length > 0 ? envVars : undefined,
					}
				: undefined;

			await onEditSave({
				...template,
				name: editName.trim(),
				description: editDescription.trim(),
				moderatorAgentId: editModeratorAgentId,
				moderatorConfig,
				roles: validRoles,
				topology: editTopology,
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
	}, [
		editName,
		editDescription,
		editRoles,
		editModeratorAgentId,
		editTopology,
		editCustomArgs,
		editEnvVarEntries,
		template,
		onEditSave,
	]);

	const updateEditRole = useCallback(
		(idx: number, field: keyof TeamTemplateRole, value: string | string[]) => {
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
			className="rounded-lg border p-4 overflow-y-auto flex-shrink-0"
			style={{
				width: '40%',
				minWidth: 280,
				maxWidth: 400,
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
					<X className="w-3.5 h-3.5" />
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
					<button
						onClick={startEditing}
						className="flex items-center gap-1 px-2.5 py-1.5 rounded text-xs transition-colors hover:opacity-80"
						style={actionBtnStyle}
					>
						<Pencil className="w-3 h-3" /> Edit
					</button>
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
								style={{
									backgroundColor: theme.colors.bgActivity,
									color: theme.colors.error,
								}}
							>
								<Trash2 className="w-3 h-3" aria-hidden="true" /> Delete
							</button>
						)}
					</>
				)}
			</div>

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
							<RoleRow
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

			{/* Topology section */}
			{editing ? (
				<TopologyEditor
					topology={editTopology}
					roles={editRoles}
					theme={theme}
					onChange={setEditTopology}
				/>
			) : (
				template.topology && (
					<div className="mb-4">
						<h4
							className="text-xs font-semibold mb-2 uppercase tracking-wide"
							style={{ color: theme.colors.textDim }}
						>
							Topology
						</h4>
						<span
							className="text-[10px] px-2 py-0.5 rounded-full"
							style={{
								backgroundColor: `${theme.colors.accent}15`,
								color: theme.colors.accent,
							}}
						>
							{template.topology.pattern}
						</span>
						{/* Preview */}
						<div
							className="mt-2 p-3 rounded-lg border"
							style={{
								borderColor: theme.colors.border,
								backgroundColor: theme.colors.bgActivity,
							}}
						>
							<WorkflowGraph
								topology={template.topology}
								participants={[]}
								theme={theme}
								compact={true}
							/>
						</div>
					</div>
				)
			)}

			{/* Moderator Settings */}
			<div className="mb-4">
				<h4
					className="text-xs font-semibold mb-2 uppercase tracking-wide"
					style={{ color: theme.colors.textDim }}
				>
					Moderator Settings
				</h4>

				{/* Moderator Agent */}
				<div className="mb-3">
					<label
						className="text-[10px] font-medium mb-0.5 block"
						style={{ color: theme.colors.textDim }}
					>
						Moderator Agent
					</label>
					{editing ? (
						<select
							value={editModeratorAgentId}
							onChange={(e) => setEditModeratorAgentId(e.target.value)}
							className="w-full px-2 py-1 rounded text-xs border outline-none"
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
					) : (
						<span className="text-xs" style={{ color: theme.colors.textMain }}>
							{template.moderatorAgentId}
						</span>
					)}
				</div>

				{/* Custom Args (collapsible) */}
				<div className="mb-2">
					<button
						onClick={() => setCustomArgsOpen((v) => !v)}
						className="flex items-center gap-1 text-[10px] font-medium mb-1"
						style={{ color: theme.colors.textDim }}
					>
						<ChevronDown
							className="w-3 h-3 transition-transform"
							style={{
								transform: customArgsOpen ? 'rotate(0deg)' : 'rotate(-90deg)',
							}}
						/>
						Custom Args
					</button>
					{customArgsOpen && (
						<div>
							{editing ? (
								<input
									type="text"
									placeholder="Additional CLI arguments..."
									value={editCustomArgs}
									onChange={(e) => setEditCustomArgs(e.target.value)}
									className="w-full px-2 py-1 rounded text-xs border outline-none"
									style={{
										backgroundColor: theme.colors.bgActivity,
										borderColor: theme.colors.border,
										color: theme.colors.textMain,
									}}
								/>
							) : (
								<span className="text-xs" style={{ color: theme.colors.textMain }}>
									{template.moderatorConfig?.customArgs || '—'}
								</span>
							)}
						</div>
					)}
				</div>

				{/* Custom Environment Variables (collapsible) */}
				<div>
					<button
						onClick={() => setEnvVarsOpen((v) => !v)}
						className="flex items-center gap-1 text-[10px] font-medium mb-1"
						style={{ color: theme.colors.textDim }}
					>
						<ChevronDown
							className="w-3 h-3 transition-transform"
							style={{
								transform: envVarsOpen ? 'rotate(0deg)' : 'rotate(-90deg)',
							}}
						/>
						Custom Environment Variables
					</button>
					{envVarsOpen && (
						<div className="space-y-1.5">
							{editing ? (
								<>
									{editEnvVarEntries.map((entry, idx) => (
										<div key={idx} className="flex items-center gap-1.5">
											<input
												type="text"
												placeholder="KEY"
												value={entry.key}
												onChange={(e) => {
													const updated = [...editEnvVarEntries];
													updated[idx] = {
														...entry,
														key: e.target.value,
													};
													setEditEnvVarEntries(updated);
												}}
												className="flex-1 px-2 py-1 rounded text-[10px] border outline-none font-mono"
												style={{
													backgroundColor: theme.colors.bgActivity,
													borderColor: theme.colors.border,
													color: theme.colors.textMain,
												}}
											/>
											<input
												type="text"
												placeholder="value"
												value={entry.value}
												onChange={(e) => {
													const updated = [...editEnvVarEntries];
													updated[idx] = {
														...entry,
														value: e.target.value,
													};
													setEditEnvVarEntries(updated);
												}}
												className="flex-1 px-2 py-1 rounded text-[10px] border outline-none font-mono"
												style={{
													backgroundColor: theme.colors.bgActivity,
													borderColor: theme.colors.border,
													color: theme.colors.textMain,
												}}
											/>
											<button
												onClick={() => {
													setEditEnvVarEntries((prev) => prev.filter((_, i) => i !== idx));
												}}
												className="p-0.5 rounded hover:opacity-80 flex-shrink-0"
												style={{ color: theme.colors.textDim }}
												aria-label="Remove variable"
											>
												<X className="w-3 h-3" />
											</button>
										</div>
									))}
									<button
										onClick={() =>
											setEditEnvVarEntries((prev) => [...prev, { key: '', value: '' }])
										}
										className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded"
										style={{ color: theme.colors.accent }}
									>
										<Plus className="w-3 h-3" /> Add Variable
									</button>
								</>
							) : (
								<div className="space-y-1">
									{Object.entries(template.moderatorConfig?.customEnvVars ?? {}).length > 0 ? (
										Object.entries(template.moderatorConfig?.customEnvVars ?? {}).map(
											([key, value]) => (
												<div key={key} className="flex gap-2 text-xs font-mono">
													<span style={{ color: theme.colors.accent }}>{key}</span>
													<span style={{ color: theme.colors.textDim }}>=</span>
													<span style={{ color: theme.colors.textMain }}>{value}</span>
												</div>
											)
										)
									) : (
										<span className="text-xs" style={{ color: theme.colors.textDim }}>
											—
										</span>
									)}
								</div>
							)}
						</div>
					)}
				</div>
			</div>

			{/* Timestamps */}
			<div className="text-[10px] space-y-1" style={{ color: theme.colors.textDim }}>
				<div>Created: {new Date(template.createdAt).toLocaleDateString()}</div>
				<div>Updated: {new Date(template.updatedAt).toLocaleDateString()}</div>
			</div>
		</div>
	);
});
