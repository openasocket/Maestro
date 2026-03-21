/**
 * TopologyEditor - Minimal text-based editor for workflow topologies.
 * Allows editing pattern, edges, entry/exit points with basic validation.
 * Gated behind enableWorkflowTopology feature flag.
 */

import { useState, useMemo, useCallback } from 'react';
import { Plus, Trash2, AlertTriangle } from 'lucide-react';
import type { Theme } from '../../types';
import type { WorkflowTopology, WorkflowEdge } from '../../../shared/group-chat-types';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { Modal, ModalFooter } from '../ui';

const PATTERNS: WorkflowTopology['pattern'][] = [
	'hub-spoke',
	'pipeline',
	'parallel-then-merge',
	'review-loop',
	'custom',
];

const PATTERN_LABELS: Record<string, string> = {
	'hub-spoke': 'Hub & Spoke (default)',
	pipeline: 'Pipeline',
	'parallel-then-merge': 'Parallel then Merge',
	'review-loop': 'Review Loop',
	custom: 'Custom',
};

const EDGE_TYPES: WorkflowEdge['edgeType'][] = ['sequential', 'parallel', 'conditional'];

interface TopologyEditorProps {
	theme: Theme;
	isOpen: boolean;
	topology: WorkflowTopology;
	roleNames: string[];
	onSave: (topology: WorkflowTopology) => void;
	onClose: () => void;
}

export function TopologyEditor({
	theme,
	isOpen,
	topology,
	roleNames,
	onSave,
	onClose,
}: TopologyEditorProps): JSX.Element | null {
	const [pattern, setPattern] = useState<WorkflowTopology['pattern']>(topology.pattern);
	const [edges, setEdges] = useState<WorkflowEdge[]>(() => [...topology.edges]);
	const [entryPoint, setEntryPoint] = useState(topology.entryPoint);
	const [exitPoint, setExitPoint] = useState(topology.exitPoint);

	// All possible node names: roles + special markers
	const nodeOptions = useMemo(() => ['__entry__', ...roleNames, '__exit__'], [roleNames]);

	// Validation warnings
	const warnings = useMemo(() => {
		const w: string[] = [];
		if (!entryPoint) w.push('No entry point defined');
		else if (!roleNames.includes(entryPoint))
			w.push(`Entry point "${entryPoint}" is not a known role`);
		if (!exitPoint) w.push('No exit point defined');
		else if (!roleNames.includes(exitPoint))
			w.push(`Exit point "${exitPoint}" is not a known role`);

		// Check for disconnected nodes
		const connectedNodes = new Set<string>();
		for (const edge of edges) {
			connectedNodes.add(edge.source);
			connectedNodes.add(edge.target);
		}
		for (const role of roleNames) {
			if (!connectedNodes.has(role)) {
				w.push(`${role} is not connected to any edge`);
			}
		}
		if (edges.length === 0) w.push('No edges defined');
		return w;
	}, [entryPoint, exitPoint, edges, roleNames]);

	const handleAddEdge = useCallback(() => {
		const source = roleNames[0] || '__entry__';
		const target = roleNames.length > 1 ? roleNames[1] : roleNames[0] || '__exit__';
		setEdges((prev) => [...prev, { source, target, edgeType: 'sequential' }]);
	}, [roleNames]);

	const handleRemoveEdge = useCallback((index: number) => {
		setEdges((prev) => prev.filter((_, i) => i !== index));
	}, []);

	const handleEdgeChange = useCallback(
		(index: number, field: keyof WorkflowEdge, value: string) => {
			setEdges((prev) => prev.map((edge, i) => (i === index ? { ...edge, [field]: value } : edge)));
		},
		[]
	);

	const handleSave = useCallback(() => {
		onSave({ pattern, edges, entryPoint, exitPoint });
	}, [pattern, edges, entryPoint, exitPoint, onSave]);

	if (!isOpen) return null;

	const selectStyle = {
		backgroundColor: theme.colors.bgMain,
		borderColor: theme.colors.border,
		color: theme.colors.textMain,
	};

	const inputStyle = {
		backgroundColor: theme.colors.bgMain,
		borderColor: theme.colors.border,
		color: theme.colors.textMain,
	};

	return (
		<Modal
			theme={theme}
			title="Workflow Topology"
			priority={MODAL_PRIORITIES.TOPOLOGY_EDITOR}
			onClose={onClose}
			width={520}
			maxHeight="80vh"
			footer={
				<ModalFooter
					theme={theme}
					onCancel={onClose}
					onConfirm={handleSave}
					confirmLabel="Save"
					cancelLabel="Cancel"
				/>
			}
		>
			<div className="flex flex-col gap-4 p-4">
				{/* Pattern selector */}
				<div>
					<label
						className="block text-[11px] font-medium mb-1"
						style={{ color: theme.colors.textDim }}
					>
						Pattern
					</label>
					<select
						value={pattern}
						onChange={(e) => setPattern(e.target.value as WorkflowTopology['pattern'])}
						className="w-full px-2 py-1.5 rounded border text-xs"
						style={selectStyle}
					>
						{PATTERNS.map((p) => (
							<option key={p} value={p}>
								{PATTERN_LABELS[p]}
							</option>
						))}
					</select>
				</div>

				{/* Entry / Exit point */}
				<div className="grid grid-cols-2 gap-3">
					<div>
						<label
							className="block text-[11px] font-medium mb-1"
							style={{ color: theme.colors.textDim }}
						>
							Entry Point
						</label>
						<select
							value={entryPoint}
							onChange={(e) => setEntryPoint(e.target.value)}
							className="w-full px-2 py-1.5 rounded border text-xs"
							style={selectStyle}
						>
							<option value="">— select —</option>
							{roleNames.map((r) => (
								<option key={r} value={r}>
									{r}
								</option>
							))}
						</select>
					</div>
					<div>
						<label
							className="block text-[11px] font-medium mb-1"
							style={{ color: theme.colors.textDim }}
						>
							Exit Point
						</label>
						<select
							value={exitPoint}
							onChange={(e) => setExitPoint(e.target.value)}
							className="w-full px-2 py-1.5 rounded border text-xs"
							style={selectStyle}
						>
							<option value="">— select —</option>
							{roleNames.map((r) => (
								<option key={r} value={r}>
									{r}
								</option>
							))}
						</select>
					</div>
				</div>

				{/* Edges list */}
				<div>
					<div className="flex items-center justify-between mb-1">
						<label className="text-[11px] font-medium" style={{ color: theme.colors.textDim }}>
							Edges
						</label>
						<button
							type="button"
							onClick={handleAddEdge}
							className="flex items-center gap-1 px-2 py-0.5 rounded border text-[10px] transition-colors hover:bg-white/5"
							style={{ borderColor: theme.colors.border, color: theme.colors.accent }}
						>
							<Plus className="w-3 h-3" />
							Add Edge
						</button>
					</div>

					{edges.length === 0 && (
						<div className="text-[11px] py-2" style={{ color: theme.colors.textDim }}>
							No edges defined. Add edges to connect roles.
						</div>
					)}

					<div className="flex flex-col gap-2 max-h-[200px] overflow-y-auto">
						{edges.map((edge, i) => (
							<div
								key={i}
								className="flex items-center gap-2 p-2 rounded border"
								style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
							>
								{/* Source */}
								<select
									value={edge.source}
									onChange={(e) => handleEdgeChange(i, 'source', e.target.value)}
									className="flex-1 min-w-0 px-1.5 py-1 rounded border text-[11px]"
									style={selectStyle}
								>
									{nodeOptions.map((n) => (
										<option key={n} value={n}>
											{n}
										</option>
									))}
								</select>

								<span className="text-[11px] shrink-0" style={{ color: theme.colors.textDim }}>
									→
								</span>

								{/* Target */}
								<select
									value={edge.target}
									onChange={(e) => handleEdgeChange(i, 'target', e.target.value)}
									className="flex-1 min-w-0 px-1.5 py-1 rounded border text-[11px]"
									style={selectStyle}
								>
									{nodeOptions.map((n) => (
										<option key={n} value={n}>
											{n}
										</option>
									))}
								</select>

								{/* Edge type */}
								<select
									value={edge.edgeType}
									onChange={(e) => handleEdgeChange(i, 'edgeType', e.target.value)}
									className="w-[90px] shrink-0 px-1.5 py-1 rounded border text-[11px]"
									style={selectStyle}
								>
									{EDGE_TYPES.map((t) => (
										<option key={t} value={t}>
											{t}
										</option>
									))}
								</select>

								{/* Remove button */}
								<button
									type="button"
									onClick={() => handleRemoveEdge(i)}
									className="shrink-0 p-1 rounded transition-colors hover:bg-white/10"
									style={{ color: theme.colors.error }}
									title="Remove"
								>
									<Trash2 className="w-3 h-3" />
								</button>
							</div>
						))}
					</div>

					{/* Condition input for conditional edges */}
					{edges.map(
						(edge, i) =>
							edge.edgeType === 'conditional' && (
								<div key={`cond-${i}`} className="ml-4 mt-1">
									<label className="text-[10px]" style={{ color: theme.colors.textDim }}>
										Condition for {edge.source} → {edge.target}:
									</label>
									<input
										type="text"
										value={edge.condition || ''}
										onChange={(e) => handleEdgeChange(i, 'condition', e.target.value)}
										placeholder="e.g., output contains 'approved'"
										className="w-full mt-0.5 px-2 py-1 rounded border text-[11px]"
										style={inputStyle}
									/>
								</div>
							)
					)}
				</div>

				{/* Validation warnings */}
				{warnings.length > 0 && (
					<div
						className="flex flex-col gap-1 p-2 rounded border"
						style={{
							borderColor: theme.colors.warning,
							backgroundColor: `${theme.colors.warning}10`,
						}}
					>
						{warnings.map((w, i) => (
							<div
								key={i}
								className="flex items-center gap-1.5 text-[11px]"
								style={{ color: theme.colors.warning }}
							>
								<AlertTriangle className="w-3 h-3 shrink-0" />
								{w}
							</div>
						))}
					</div>
				)}
			</div>
		</Modal>
	);
}
