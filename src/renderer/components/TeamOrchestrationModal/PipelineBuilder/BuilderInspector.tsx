/**
 * BuilderInspector — Context-sensitive right panel for the Pipeline Builder.
 *
 * Three views:
 * 1. No selection → Template Metadata (name, description, category, detected pattern, counts)
 * 2. Node selected → Role Configuration (name, agent, description, system prompt, contracts, delete)
 * 3. Edge selected → Edge Configuration (type, condition, visual preview, delete)
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import {
	Play,
	Flag,
	User,
	ArrowRight,
	GitBranch,
	HelpCircle,
	Trash2,
	ArrowDown,
	RefreshCw,
	LayoutGrid,
} from 'lucide-react';
import type { Theme } from '../../../types';
import type { TeamTemplateRole } from '../../../../shared/group-chat-types';
import { AGENT_IDS } from '../../../../shared/agentIds';
import { AGENT_DISPLAY_NAMES } from '../../../../shared/agentMetadata';
import type { BuilderAction, BuilderNode, BuilderEdge, BuilderState } from './builderTypes';
import { detectPattern } from './builderSerializer';

/** Agent IDs available for role assignment (exclude terminal) */
const ROLE_AGENT_IDS = AGENT_IDS.filter((id) => id !== 'terminal');

/** Pattern display info */
const PATTERN_INFO: Record<string, { label: string; icon: typeof ArrowDown }> = {
	pipeline: { label: 'Pipeline', icon: ArrowDown },
	'parallel-then-merge': { label: 'Parallel + Merge', icon: GitBranch },
	'review-loop': { label: 'Review Loop', icon: RefreshCw },
	custom: { label: 'Custom', icon: LayoutGrid },
};

interface BuilderInspectorProps {
	state: BuilderState;
	dispatch: React.Dispatch<BuilderAction>;
	theme: Theme;
	selectedNode: BuilderNode | null;
	selectedEdge: BuilderEdge | null;
	selectedRole: TeamTemplateRole | null;
}

export function BuilderInspector({
	state,
	dispatch,
	theme,
	selectedNode,
	selectedEdge,
	selectedRole,
}: BuilderInspectorProps): JSX.Element {
	const containerStyle = {
		borderColor: theme.colors.border,
		backgroundColor: theme.colors.bgSidebar,
	};

	// Determine which view to render
	const viewKey = selectedNode ? 'node' : selectedEdge ? 'edge' : 'meta';

	return (
		<div
			className="flex-shrink-0 border-l overflow-y-auto"
			style={{ ...containerStyle, width: 280 }}
		>
			<div key={viewKey} className="p-3" style={{ animation: 'inspectorFadeIn 150ms ease-out' }}>
				{selectedNode && selectedRole ? (
					<RoleInspector
						node={selectedNode}
						role={selectedRole}
						dispatch={dispatch}
						theme={theme}
					/>
				) : selectedEdge ? (
					<EdgeInspector edge={selectedEdge} state={state} dispatch={dispatch} theme={theme} />
				) : (
					<MetadataInspector state={state} dispatch={dispatch} theme={theme} />
				)}
			</div>

			{/* Inline keyframe for fade transition */}
			<style>{`
				@keyframes inspectorFadeIn {
					from { opacity: 0; transform: translateY(4px); }
					to   { opacity: 1; transform: translateY(0); }
				}
			`}</style>
		</div>
	);
}

// ============================================================================
// Shared input styles helper
// ============================================================================

function inputStyles(theme: Theme) {
	return {
		backgroundColor: theme.colors.bgMain,
		borderColor: theme.colors.border,
		color: theme.colors.textMain,
	};
}

function SectionDivider({ theme }: { theme: Theme }) {
	return (
		<hr className="my-3 border-0" style={{ height: 1, backgroundColor: theme.colors.border }} />
	);
}

function SectionLabel({ children, theme }: { children: React.ReactNode; theme: Theme }) {
	return (
		<span className="text-[10px] font-medium" style={{ color: theme.colors.textDim }}>
			{children}
		</span>
	);
}

// ============================================================================
// Template Metadata View
// ============================================================================

function MetadataInspector({
	state,
	dispatch,
	theme,
}: {
	state: BuilderState;
	dispatch: React.Dispatch<BuilderAction>;
	theme: Theme;
}) {
	const pattern = detectPattern(state.nodes, state.edges);
	const patternInfo = PATTERN_INFO[pattern] ?? PATTERN_INFO.custom;
	const PatternIcon = patternInfo.icon;

	return (
		<>
			<h4
				className="text-[10px] font-semibold uppercase tracking-wide mb-3"
				style={{ color: theme.colors.textDim }}
			>
				Template
			</h4>

			<label className="block mb-2">
				<SectionLabel theme={theme}>Name</SectionLabel>
				<input
					type="text"
					value={state.templateMeta.name}
					onChange={(e) => dispatch({ type: 'SET_TEMPLATE_META', meta: { name: e.target.value } })}
					placeholder="Template name"
					className="w-full mt-0.5 px-2 py-1 rounded text-xs border outline-none"
					style={inputStyles(theme)}
				/>
			</label>

			<label className="block mb-2">
				<SectionLabel theme={theme}>Description</SectionLabel>
				<textarea
					value={state.templateMeta.description}
					onChange={(e) =>
						dispatch({
							type: 'SET_TEMPLATE_META',
							meta: { description: e.target.value },
						})
					}
					rows={3}
					placeholder="What does this template do?"
					className="w-full mt-0.5 px-2 py-1 rounded text-xs border outline-none resize-none"
					style={inputStyles(theme)}
				/>
			</label>

			<div className="mb-3">
				<SectionLabel theme={theme}>Category</SectionLabel>
				<div
					className="flex mt-1 rounded overflow-hidden border"
					style={{ borderColor: theme.colors.border }}
				>
					{(['user', 'exchange'] as const).map((cat) => (
						<button
							key={cat}
							onClick={() => dispatch({ type: 'SET_TEMPLATE_META', meta: { category: cat } })}
							className="flex-1 px-2 py-1 text-[10px] font-medium capitalize transition-colors"
							style={{
								backgroundColor:
									state.templateMeta.category === cat ? theme.colors.accent : theme.colors.bgMain,
								color: state.templateMeta.category === cat ? '#fff' : theme.colors.textDim,
							}}
						>
							{cat}
						</button>
					))}
				</div>
			</div>

			<SectionDivider theme={theme} />

			{/* Detected topology pattern */}
			<div className="mb-3">
				<SectionLabel theme={theme}>Detected Pattern</SectionLabel>
				<div
					className="flex items-center gap-2 mt-1 px-2 py-1.5 rounded"
					style={{ backgroundColor: theme.colors.bgActivity }}
				>
					<PatternIcon
						className="w-3.5 h-3.5 flex-shrink-0"
						style={{ color: theme.colors.accent }}
					/>
					<span className="text-xs" style={{ color: theme.colors.textMain }}>
						{patternInfo.label}
					</span>
				</div>
			</div>

			{/* Node/edge counts */}
			<div className="flex gap-3 text-[10px]" style={{ color: theme.colors.textDim }}>
				<div>
					<span className="font-semibold" style={{ color: theme.colors.textMain }}>
						{state.nodes.length}
					</span>{' '}
					{state.nodes.length === 1 ? 'node' : 'nodes'}
				</div>
				<div>
					<span className="font-semibold" style={{ color: theme.colors.textMain }}>
						{state.edges.length}
					</span>{' '}
					{state.edges.length === 1 ? 'edge' : 'edges'}
				</div>
			</div>
		</>
	);
}

// ============================================================================
// Role Configuration View
// ============================================================================

function RoleInspector({
	node,
	role,
	dispatch,
	theme,
}: {
	node: BuilderNode;
	role: TeamTemplateRole;
	dispatch: React.Dispatch<BuilderAction>;
	theme: Theme;
}) {
	const [deleteConfirm, setDeleteConfirm] = useState(false);

	const updateRole = useCallback(
		(updates: Partial<TeamTemplateRole>) => {
			dispatch({
				type: 'UPDATE_ROLE',
				roleId: node.roleId,
				role: { ...role, ...updates },
			});
		},
		[dispatch, node.roleId, role]
	);

	const isEntry = node.type === 'entry';
	const isExit = node.type === 'exit';
	const isSpecial = isEntry || isExit;

	const NodeIcon = isEntry ? Play : isExit ? Flag : User;
	const headerLabel = isEntry ? 'Entry Point' : isExit ? 'Exit Point' : 'Role Configuration';

	const handleDelete = useCallback(() => {
		if (!deleteConfirm) {
			setDeleteConfirm(true);
			return;
		}
		dispatch({ type: 'DELETE_NODE', nodeId: node.id });
	}, [deleteConfirm, dispatch, node.id]);

	// Reset delete confirmation after 3 seconds
	useEffect(() => {
		if (!deleteConfirm) return;
		const timer = setTimeout(() => setDeleteConfirm(false), 3000);
		return () => clearTimeout(timer);
	}, [deleteConfirm]);

	return (
		<>
			{/* Header */}
			<div className="flex items-center gap-2 mb-3">
				<NodeIcon
					className="w-3.5 h-3.5 flex-shrink-0"
					style={{
						color: isEntry
							? theme.colors.success
							: isExit
								? theme.colors.textDim
								: theme.colors.accent,
					}}
				/>
				<h4
					className="text-[10px] font-semibold uppercase tracking-wide"
					style={{ color: theme.colors.textDim }}
				>
					{headerLabel}
				</h4>
			</div>

			{isSpecial && (
				<p className="text-[10px] mb-3" style={{ color: theme.colors.textDim }}>
					{isEntry
						? 'The starting point of the workflow. First role to receive input.'
						: 'The endpoint of the workflow. Produces the final output.'}
				</p>
			)}

			{!isSpecial && (
				<>
					<label className="block mb-2">
						<SectionLabel theme={theme}>Name</SectionLabel>
						<input
							type="text"
							value={role.name}
							onChange={(e) => updateRole({ name: e.target.value })}
							className="w-full mt-0.5 px-2 py-1 rounded text-xs border outline-none"
							style={inputStyles(theme)}
						/>
					</label>

					<label className="block mb-2">
						<SectionLabel theme={theme}>Agent</SectionLabel>
						<select
							value={role.agentId}
							onChange={(e) => updateRole({ agentId: e.target.value })}
							className="w-full mt-0.5 px-2 py-1 rounded text-xs border outline-none"
							style={inputStyles(theme)}
						>
							{ROLE_AGENT_IDS.map((id) => (
								<option key={id} value={id}>
									{AGENT_DISPLAY_NAMES[id]}
								</option>
							))}
						</select>
					</label>

					<label className="block mb-2">
						<SectionLabel theme={theme}>Description</SectionLabel>
						<textarea
							value={role.description}
							onChange={(e) => updateRole({ description: e.target.value })}
							rows={2}
							className="w-full mt-0.5 px-2 py-1 rounded text-xs border outline-none resize-none"
							style={inputStyles(theme)}
						/>
					</label>

					<label className="block mb-2">
						<SectionLabel theme={theme}>System Prompt Suffix</SectionLabel>
						<textarea
							value={role.systemPromptSuffix ?? ''}
							onChange={(e) => updateRole({ systemPromptSuffix: e.target.value || undefined })}
							rows={4}
							placeholder="Additional context for this role..."
							className="w-full mt-0.5 px-2 py-1 rounded text-xs border outline-none resize-none font-mono"
							style={inputStyles(theme)}
						/>
					</label>

					<SectionDivider theme={theme} />

					{/* Input Contract */}
					<div className="mb-2">
						<SectionLabel theme={theme}>Input Contract</SectionLabel>
						<TagInput
							tags={role.inputContract ?? []}
							onChange={(tags) => updateRole({ inputContract: tags })}
							theme={theme}
							placeholder="Add input..."
						/>
					</div>

					{/* Output Contract */}
					<div className="mb-2">
						<SectionLabel theme={theme}>Output Contract</SectionLabel>
						<TagInput
							tags={role.outputContract ?? []}
							onChange={(tags) => updateRole({ outputContract: tags })}
							theme={theme}
							placeholder="Add output..."
						/>
					</div>
				</>
			)}

			{/* Also show name/agent for entry/exit nodes */}
			{isSpecial && (
				<>
					<label className="block mb-2">
						<SectionLabel theme={theme}>Name</SectionLabel>
						<input
							type="text"
							value={role.name}
							onChange={(e) => updateRole({ name: e.target.value })}
							className="w-full mt-0.5 px-2 py-1 rounded text-xs border outline-none"
							style={inputStyles(theme)}
						/>
					</label>

					<label className="block mb-2">
						<SectionLabel theme={theme}>Agent</SectionLabel>
						<select
							value={role.agentId}
							onChange={(e) => updateRole({ agentId: e.target.value })}
							className="w-full mt-0.5 px-2 py-1 rounded text-xs border outline-none"
							style={inputStyles(theme)}
						>
							{ROLE_AGENT_IDS.map((id) => (
								<option key={id} value={id}>
									{AGENT_DISPLAY_NAMES[id]}
								</option>
							))}
						</select>
					</label>
				</>
			)}

			<SectionDivider theme={theme} />

			{/* Delete */}
			<button
				onClick={handleDelete}
				className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded text-xs transition-colors hover:opacity-80"
				style={{
					backgroundColor: deleteConfirm ? theme.colors.error : `${theme.colors.error}15`,
					color: deleteConfirm ? '#fff' : theme.colors.error,
				}}
			>
				<Trash2 className="w-3 h-3" />
				{deleteConfirm ? 'Click again to confirm' : 'Delete Node'}
			</button>
		</>
	);
}

// ============================================================================
// Edge Configuration View
// ============================================================================

const EDGE_TYPES: Array<{
	value: BuilderEdge['edgeType'];
	label: string;
	icon: typeof ArrowRight;
}> = [
	{ value: 'sequential', label: 'Sequential', icon: ArrowRight },
	{ value: 'parallel', label: 'Parallel', icon: GitBranch },
	{ value: 'conditional', label: 'Conditional', icon: HelpCircle },
];

function EdgeInspector({
	edge,
	state,
	dispatch,
	theme,
}: {
	edge: BuilderEdge;
	state: BuilderState;
	dispatch: React.Dispatch<BuilderAction>;
	theme: Theme;
}) {
	const sourceNode = state.nodes.find((n) => n.id === edge.sourceNodeId);
	const targetNode = state.nodes.find((n) => n.id === edge.targetNodeId);
	const sourceName = sourceNode ? (state.roles[sourceNode.roleId]?.name ?? 'Unknown') : 'Unknown';
	const targetName = targetNode ? (state.roles[targetNode.roleId]?.name ?? 'Unknown') : 'Unknown';

	return (
		<>
			{/* Header */}
			<h4
				className="text-[10px] font-semibold uppercase tracking-wide mb-1"
				style={{ color: theme.colors.textDim }}
			>
				Connection
			</h4>
			<div
				className="flex items-center gap-1 text-xs mb-3"
				style={{ color: theme.colors.textMain }}
			>
				<span className="truncate max-w-[100px]">{sourceName}</span>
				<ArrowRight className="w-3 h-3 flex-shrink-0" style={{ color: theme.colors.textDim }} />
				<span className="truncate max-w-[100px]">{targetName}</span>
			</div>

			{/* Edge Type segmented control */}
			<div className="mb-2">
				<SectionLabel theme={theme}>Edge Type</SectionLabel>
				<div
					className="flex mt-1 rounded overflow-hidden border"
					style={{ borderColor: theme.colors.border }}
				>
					{EDGE_TYPES.map(({ value, label, icon: Icon }) => {
						const active = edge.edgeType === value;
						return (
							<button
								key={value}
								onClick={() =>
									dispatch({
										type: 'UPDATE_EDGE',
										edgeId: edge.id,
										edgeType: value,
										condition: edge.condition,
									})
								}
								className="flex-1 flex items-center justify-center gap-1 px-1 py-1.5 text-[10px] font-medium transition-colors"
								style={{
									backgroundColor: active ? theme.colors.accent : theme.colors.bgMain,
									color: active ? '#fff' : theme.colors.textDim,
								}}
								title={label}
							>
								<Icon className="w-3 h-3" />
								<span className="hidden sm:inline">{label}</span>
							</button>
						);
					})}
				</div>
			</div>

			{/* Condition (conditional edges only) */}
			{edge.edgeType === 'conditional' && (
				<label className="block mb-2">
					<SectionLabel theme={theme}>Condition</SectionLabel>
					<textarea
						value={edge.condition ?? ''}
						onChange={(e) =>
							dispatch({
								type: 'UPDATE_EDGE',
								edgeId: edge.id,
								edgeType: edge.edgeType,
								condition: e.target.value || undefined,
							})
						}
						rows={2}
						placeholder="e.g., Needs revision"
						className="w-full mt-0.5 px-2 py-1 rounded text-xs border outline-none resize-none"
						style={inputStyles(theme)}
					/>
				</label>
			)}

			<SectionDivider theme={theme} />

			{/* Edge style preview */}
			<div className="mb-3">
				<SectionLabel theme={theme}>Preview</SectionLabel>
				<EdgePreview edgeType={edge.edgeType} theme={theme} />
			</div>

			<SectionDivider theme={theme} />

			{/* Delete */}
			<button
				onClick={() => dispatch({ type: 'DELETE_EDGE', edgeId: edge.id })}
				className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded text-xs transition-colors hover:opacity-80"
				style={{
					backgroundColor: `${theme.colors.error}15`,
					color: theme.colors.error,
				}}
			>
				<Trash2 className="w-3 h-3" />
				Delete Connection
			</button>
		</>
	);
}

// ============================================================================
// Edge style preview (inline SVG)
// ============================================================================

function EdgePreview({ edgeType, theme }: { edgeType: BuilderEdge['edgeType']; theme: Theme }) {
	const strokeColor =
		edgeType === 'parallel'
			? theme.colors.accent
			: edgeType === 'conditional'
				? theme.colors.warning
				: theme.colors.textMain;

	const dashArray = edgeType === 'conditional' ? '4 3' : undefined;

	return (
		<svg
			width="100%"
			height="32"
			viewBox="0 0 240 32"
			className="mt-1 rounded"
			style={{ backgroundColor: theme.colors.bgMain }}
		>
			<defs>
				<marker id="preview-arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
					<path d="M0,0 L6,3 L0,6 Z" fill={strokeColor} />
				</marker>
			</defs>

			{/* Main line */}
			<line
				x1="20"
				y1="16"
				x2="210"
				y2="16"
				stroke={strokeColor}
				strokeWidth="2"
				strokeDasharray={dashArray}
				markerEnd="url(#preview-arrow)"
			/>

			{/* Parallel markers */}
			{edgeType === 'parallel' && (
				<>
					<line x1="110" y1="8" x2="110" y2="24" stroke={strokeColor} strokeWidth="1.5" />
					<line x1="116" y1="8" x2="116" y2="24" stroke={strokeColor} strokeWidth="1.5" />
				</>
			)}

			{/* Conditional diamond */}
			{edgeType === 'conditional' && (
				<polygon
					points="113,8 121,16 113,24 105,16"
					fill="none"
					stroke={strokeColor}
					strokeWidth="1.5"
				/>
			)}

			{/* Start/end dots */}
			<circle cx="20" cy="16" r="3" fill={strokeColor} />
		</svg>
	);
}

// ============================================================================
// Tag-style input for contracts
// ============================================================================

function TagInput({
	tags,
	onChange,
	theme,
	placeholder,
}: {
	tags: string[];
	onChange: (tags: string[]) => void;
	theme: Theme;
	placeholder?: string;
}) {
	const [inputValue, setInputValue] = useState('');
	const inputRef = useRef<HTMLInputElement>(null);

	const addTag = useCallback(() => {
		const trimmed = inputValue.trim();
		if (!trimmed || tags.includes(trimmed)) return;
		onChange([...tags, trimmed]);
		setInputValue('');
	}, [inputValue, tags, onChange]);

	const removeTag = useCallback(
		(index: number) => {
			onChange(tags.filter((_, i) => i !== index));
		},
		[tags, onChange]
	);

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				addTag();
			} else if (e.key === 'Backspace' && !inputValue && tags.length > 0) {
				removeTag(tags.length - 1);
			}
		},
		[addTag, inputValue, tags.length, removeTag]
	);

	return (
		<div
			className="mt-0.5 flex flex-wrap gap-1 p-1.5 rounded border min-h-[32px] cursor-text"
			style={{
				backgroundColor: theme.colors.bgMain,
				borderColor: theme.colors.border,
			}}
			onClick={() => inputRef.current?.focus()}
		>
			{tags.map((tag, i) => (
				<span
					key={`${tag}-${i}`}
					className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px]"
					style={{
						backgroundColor: `${theme.colors.accent}20`,
						color: theme.colors.accent,
					}}
				>
					{tag}
					<button
						onClick={(e) => {
							e.stopPropagation();
							removeTag(i);
						}}
						className="ml-0.5 hover:opacity-70 leading-none"
						style={{ color: theme.colors.accent }}
					>
						&times;
					</button>
				</span>
			))}
			<input
				ref={inputRef}
				type="text"
				value={inputValue}
				onChange={(e) => setInputValue(e.target.value)}
				onKeyDown={handleKeyDown}
				onBlur={addTag}
				placeholder={tags.length === 0 ? placeholder : ''}
				className="flex-1 min-w-[60px] text-[10px] bg-transparent outline-none border-none"
				style={{ color: theme.colors.textMain }}
			/>
		</div>
	);
}
