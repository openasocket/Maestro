/**
 * TeamBuilderWizard — AI-powered team composition wizard
 *
 * Follows MASFactory's three-stage "Vibe Graphing" pipeline:
 * 1. Intent -> Role Assignment: User describes task, AI suggests roles
 * 2. Role Assignment -> Topology: AI proposes communication pattern
 * 3. Topology -> Instantiation: AI fills in per-role instructions
 *
 * Each stage is human-in-the-loop: approve, edit, or revise.
 */

import { useState, useCallback, useRef } from 'react';
import {
	Wand2,
	Plus,
	Trash2,
	ChevronDown,
	ChevronRight,
	RotateCcw,
	ArrowRight,
	ArrowLeft,
	Save,
	MessageSquarePlus,
	Loader2,
	X,
} from 'lucide-react';
import type { Theme } from '../../types';
import type {
	TeamTemplateRole,
	WorkflowTopology,
	WorkflowEdge,
} from '../../../shared/group-chat-types';
import { Modal } from '../ui';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { useSettingsStore } from '../../stores/settingsStore';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type WizardStep = 0 | 1 | 2 | 3;

interface RoleAssignment {
	teamName: string;
	description: string;
	roles: TeamTemplateRole[];
	moderatorAgentId: string;
	reasoning: string;
}

interface TopologyResult {
	pattern: WorkflowTopology['pattern'];
	edges: WorkflowEdge[];
	entryPoint: string;
	exitPoint: string;
	reasoning: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EXAMPLE_INTENTS = [
	'Build a full-stack feature with code review',
	'Research a topic and produce a comprehensive report',
	'Refactor a module with architecture and security review',
	'Debug a complex issue across frontend and backend',
];

const AGENT_OPTIONS = [
	{ id: 'claude-code', name: 'Claude Code' },
	{ id: 'codex', name: 'Codex' },
	{ id: 'opencode', name: 'OpenCode' },
	{ id: 'factory-droid', name: 'Factory Droid' },
];

const STEP_LABELS = ['Describe', 'Roles', 'Topology', 'Confirm'];

// ---------------------------------------------------------------------------
// AI Invocation (placeholder — will be replaced with IPC agent calls)
// ---------------------------------------------------------------------------

/**
 * Invoke the role assignment stage via AI.
 *
 * TODO: Replace with real agent invocation. Spawn a temporary agent session,
 * pass src/prompts/team-builder-role-assignment.md as system prompt,
 * send intent as user message, parse JSON response.
 */
async function invokeRoleAssignment(intent: string): Promise<RoleAssignment> {
	// Simulated AI response for UI development
	await new Promise((r) => setTimeout(r, 1500));
	return {
		teamName: 'Development Team',
		description: `Team to ${intent.toLowerCase().replace(/\.$/, '')}`,
		roles: [
			{
				name: 'Lead Developer',
				agentId: 'claude-code',
				description: 'Implements core functionality and coordinates work',
			},
			{
				name: 'Code Reviewer',
				agentId: 'claude-code',
				description: 'Reviews code for quality, security, and best practices',
			},
			{
				name: 'Test Engineer',
				agentId: 'claude-code',
				description: 'Writes and runs tests to ensure correctness',
			},
		],
		moderatorAgentId: 'claude-code',
		reasoning:
			'A focused team with clear separation of implementation, review, and testing responsibilities.',
	};
}

/** Invoke topology design stage via AI. */
async function invokeTopology(_intent: string, roles: TeamTemplateRole[]): Promise<TopologyResult> {
	await new Promise((r) => setTimeout(r, 1200));
	const names = roles.map((r) => r.name);
	return {
		pattern: 'review-loop',
		edges:
			names.length >= 2
				? [
						{ source: names[0], target: names[1], edgeType: 'sequential' as const },
						{
							source: names[1],
							target: names[0],
							condition: 'Changes requested',
							edgeType: 'conditional' as const,
						},
						...(names.length >= 3
							? [
									{
										source: names[1],
										target: names[2],
										condition: 'Approved',
										edgeType: 'conditional' as const,
									},
								]
							: []),
					]
				: [],
		entryPoint: names[0] || '',
		exitPoint: names[names.length - 1] || '',
		reasoning: 'A review-loop pattern ensures quality through iterative review.',
	};
}

/** Invoke semantic completion stage via AI. */
async function invokeCompletion(
	_intent: string,
	roles: TeamTemplateRole[],
	_topology: TopologyResult | null
): Promise<TeamTemplateRole[]> {
	await new Promise((r) => setTimeout(r, 1000));
	return roles.map((r) => ({
		...r,
		systemPromptSuffix: `You are the ${r.name}. ${r.description}. Focus on delivering high-quality work within your area of responsibility.`,
		inputContract: ['Task description', 'Relevant code context'],
		outputContract: ['Completed work', 'Summary of changes'],
	}));
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface TeamBuilderWizardProps {
	theme: Theme;
	isOpen: boolean;
	onClose: () => void;
	onCreateGroupChat: (
		teamName: string,
		moderatorAgentId: string,
		roles: TeamTemplateRole[],
		topology?: WorkflowTopology
	) => void;
	onSaveTemplate: (template: {
		name: string;
		description: string;
		moderatorAgentId: string;
		roles: TeamTemplateRole[];
		topology?: WorkflowTopology;
	}) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TeamBuilderWizard({
	theme,
	isOpen,
	onClose,
	onCreateGroupChat,
	onSaveTemplate,
}: TeamBuilderWizardProps) {
	const [step, setStep] = useState<WizardStep>(0);
	const [intent, setIntent] = useState('');
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const [roleAssignment, setRoleAssignment] = useState<RoleAssignment | null>(null);
	const [topology, setTopology] = useState<TopologyResult | null>(null);
	const [editableRoles, setEditableRoles] = useState<TeamTemplateRole[]>([]);
	const [editableTeamName, setEditableTeamName] = useState('');
	const [moderatorAgentId, setModeratorAgentId] = useState('claude-code');

	const [expandedContracts, setExpandedContracts] = useState<Set<number>>(new Set());
	const [contractInputValues, setContractInputValues] = useState<Record<string, string>>({});

	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const enableTopology = useSettingsStore(
		(s) => s.teamOrchestrationSettings?.enableWorkflowTopology ?? false
	);

	// -- Helpers --

	const reset = useCallback(() => {
		setStep(0);
		setIntent('');
		setLoading(false);
		setError(null);
		setRoleAssignment(null);
		setTopology(null);
		setEditableRoles([]);
		setEditableTeamName('');
		setModeratorAgentId('claude-code');
		setExpandedContracts(new Set());
		setContractInputValues({});
	}, []);

	const handleClose = useCallback(() => {
		reset();
		onClose();
	}, [reset, onClose]);

	const buildTopologyData = useCallback(
		(): WorkflowTopology | undefined =>
			topology
				? {
						pattern: topology.pattern,
						edges: topology.edges,
						entryPoint: topology.entryPoint,
						exitPoint: topology.exitPoint,
					}
				: undefined,
		[topology]
	);

	// -- Step transitions --

	const handleBuildTeam = useCallback(async () => {
		if (!intent.trim()) return;
		setLoading(true);
		setError(null);
		try {
			const result = await invokeRoleAssignment(intent.trim());
			setRoleAssignment(result);
			setEditableRoles(result.roles);
			setEditableTeamName(result.teamName);
			setModeratorAgentId(result.moderatorAgentId);
			setStep(1);
		} catch {
			setError('Failed to generate team configuration. Try again or adjust your description.');
		} finally {
			setLoading(false);
		}
	}, [intent]);

	const proceedToCompletion = useCallback(
		async (topologyForCompletion: TopologyResult | null) => {
			setLoading(true);
			setError(null);
			try {
				const completed = await invokeCompletion(intent, editableRoles, topologyForCompletion);
				setEditableRoles(completed);
				setStep(3);
			} catch {
				setError('Failed to finalize configuration. Try again.');
			} finally {
				setLoading(false);
			}
		},
		[intent, editableRoles]
	);

	const handleApproveRoles = useCallback(async () => {
		if (!enableTopology) {
			proceedToCompletion(null);
			return;
		}
		setLoading(true);
		setError(null);
		try {
			const result = await invokeTopology(intent, editableRoles);
			setTopology(result);
			setStep(2);
		} catch {
			setError('Failed to generate topology. Try again.');
		} finally {
			setLoading(false);
		}
	}, [enableTopology, intent, editableRoles, proceedToCompletion]);

	const handleApproveTopology = useCallback(() => {
		proceedToCompletion(topology);
	}, [proceedToCompletion, topology]);

	const handleSkipTopology = useCallback(() => {
		setTopology(null);
		proceedToCompletion(null);
	}, [proceedToCompletion]);

	// -- Role editing --

	const updateRole = useCallback((index: number, updates: Partial<TeamTemplateRole>) => {
		setEditableRoles((prev) => prev.map((r, i) => (i === index ? { ...r, ...updates } : r)));
	}, []);

	const removeRole = useCallback((index: number) => {
		setEditableRoles((prev) => prev.filter((_, i) => i !== index));
	}, []);

	const addRole = useCallback(() => {
		setEditableRoles((prev) => [
			...prev,
			{ name: 'New Role', agentId: 'claude-code', description: 'Describe this role' },
		]);
	}, []);

	// -- Contract editing --

	const toggleContractExpanded = useCallback((index: number) => {
		setExpandedContracts((prev) => {
			const next = new Set(prev);
			if (next.has(index)) {
				next.delete(index);
			} else {
				next.add(index);
			}
			return next;
		});
	}, []);

	const addContractItem = useCallback(
		(roleIndex: number, type: 'inputContract' | 'outputContract') => {
			const key = `${roleIndex}-${type}`;
			const value = contractInputValues[key]?.trim();
			if (!value) return;

			setEditableRoles((prev) =>
				prev.map((r, i) => {
					if (i !== roleIndex) return r;
					const existing = r[type] || [];
					return { ...r, [type]: [...existing, value] };
				})
			);
			setContractInputValues((prev) => ({ ...prev, [key]: '' }));
		},
		[contractInputValues]
	);

	const removeContractItem = useCallback(
		(roleIndex: number, type: 'inputContract' | 'outputContract', itemIndex: number) => {
			setEditableRoles((prev) =>
				prev.map((r, i) => {
					if (i !== roleIndex) return r;
					const existing = r[type] || [];
					return { ...r, [type]: existing.filter((_, j) => j !== itemIndex) };
				})
			);
		},
		[]
	);

	// -- Final actions --

	const handleCreateChat = useCallback(() => {
		onCreateGroupChat(editableTeamName, moderatorAgentId, editableRoles, buildTopologyData());
		handleClose();
	}, [
		editableTeamName,
		moderatorAgentId,
		editableRoles,
		buildTopologyData,
		onCreateGroupChat,
		handleClose,
	]);

	const handleSaveTemplate = useCallback(() => {
		onSaveTemplate({
			name: editableTeamName,
			description: roleAssignment?.description || '',
			moderatorAgentId,
			roles: editableRoles,
			topology: buildTopologyData(),
		});
		handleClose();
	}, [
		editableTeamName,
		roleAssignment,
		moderatorAgentId,
		editableRoles,
		buildTopologyData,
		onSaveTemplate,
		handleClose,
	]);

	const handleCreateAndSave = useCallback(() => {
		const topologyData = buildTopologyData();
		onSaveTemplate({
			name: editableTeamName,
			description: roleAssignment?.description || '',
			moderatorAgentId,
			roles: editableRoles,
			topology: topologyData,
		});
		onCreateGroupChat(editableTeamName, moderatorAgentId, editableRoles, topologyData);
		handleClose();
	}, [
		editableTeamName,
		roleAssignment,
		moderatorAgentId,
		editableRoles,
		buildTopologyData,
		onSaveTemplate,
		onCreateGroupChat,
		handleClose,
	]);

	if (!isOpen) return null;

	// -- Render --

	const renderStepDots = () => (
		<div className="flex items-center gap-2 mb-5">
			{STEP_LABELS.map((label, i) => {
				if (i === 2 && !enableTopology) return null;
				const isActive = i === step;
				const isPast = i < step;
				return (
					<div key={label} className="flex items-center gap-2">
						{i > 0 && !(i === 2 && !enableTopology) && (
							<div
								className="w-5 h-px"
								style={{
									backgroundColor: isPast ? theme.colors.accent : theme.colors.border,
								}}
							/>
						)}
						<div className="flex items-center gap-1.5" title={label}>
							<div
								className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold"
								style={{
									backgroundColor: isActive
										? theme.colors.accent
										: isPast
											? `${theme.colors.accent}40`
											: 'transparent',
									color: isActive
										? theme.colors.accentForeground
										: isPast
											? theme.colors.accent
											: theme.colors.textDim,
									border: `1px solid ${isActive || isPast ? theme.colors.accent : theme.colors.border}`,
								}}
							>
								{i}
							</div>
							{isActive && (
								<span className="text-xs font-medium" style={{ color: theme.colors.textMain }}>
									{label}
								</span>
							)}
						</div>
					</div>
				);
			})}
		</div>
	);

	const renderError = () =>
		error ? (
			<div
				className="flex items-center gap-2 px-3 py-2 rounded text-xs mb-4"
				style={{
					backgroundColor: `${theme.colors.error}15`,
					color: theme.colors.error,
					border: `1px solid ${theme.colors.error}30`,
				}}
			>
				<span className="flex-1">{error}</span>
				<button
					onClick={() => setError(null)}
					className="px-2 py-1 rounded hover:bg-white/10 transition-colors text-xs font-medium"
				>
					Dismiss
				</button>
			</div>
		) : null;

	const renderLoading = () => (
		<div className="flex flex-col items-center justify-center py-12 gap-3">
			<Loader2 className="w-6 h-6 animate-spin" style={{ color: theme.colors.accent }} />
			<span className="text-sm" style={{ color: theme.colors.textDim }}>
				Building your team...
			</span>
		</div>
	);

	// Step 0: Intent input
	const renderIntent = () => (
		<div>
			<textarea
				ref={textareaRef}
				value={intent}
				onChange={(e) => setIntent(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && intent.trim()) {
						handleBuildTeam();
					}
				}}
				placeholder="Describe what you want this team to accomplish..."
				className="w-full h-32 px-3 py-2 rounded-lg border outline-none resize-none text-sm"
				style={{
					backgroundColor: theme.colors.bgMain,
					borderColor: theme.colors.border,
					color: theme.colors.textMain,
				}}
				autoFocus
			/>
			<div className="flex flex-wrap gap-2 mt-3">
				{EXAMPLE_INTENTS.map((example) => (
					<button
						key={example}
						onClick={() => setIntent(example)}
						className="px-3 py-1.5 rounded-full border text-xs transition-colors hover:bg-white/5"
						style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
					>
						{example}
					</button>
				))}
			</div>
		</div>
	);

	// Step 1: Role assignment review
	const renderRoles = () => (
		<div>
			<div className="mb-4">
				<label
					className="block text-xs font-bold opacity-70 uppercase mb-1"
					style={{ color: theme.colors.textMain }}
				>
					Team Name
				</label>
				<input
					value={editableTeamName}
					onChange={(e) => setEditableTeamName(e.target.value)}
					className="w-full px-3 py-2 rounded-lg border outline-none text-sm"
					style={{
						backgroundColor: theme.colors.bgMain,
						borderColor: theme.colors.border,
						color: theme.colors.textMain,
					}}
				/>
			</div>

			{roleAssignment?.reasoning && (
				<p className="text-xs mb-3" style={{ color: theme.colors.textDim }}>
					{roleAssignment.reasoning}
				</p>
			)}

			<div className="flex flex-col gap-2">
				{editableRoles.map((role, i) => (
					<div
						key={i}
						className="p-3 rounded-lg border"
						style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
					>
						<div className="flex items-start gap-2">
							<div className="flex-1 space-y-2">
								<input
									value={role.name}
									onChange={(e) => updateRole(i, { name: e.target.value })}
									className="w-full text-sm font-medium bg-transparent outline-none"
									style={{ color: theme.colors.textMain }}
									placeholder="Role name"
								/>
								<input
									value={role.description}
									onChange={(e) => updateRole(i, { description: e.target.value })}
									className="w-full text-xs bg-transparent outline-none"
									style={{ color: theme.colors.textDim }}
									placeholder="Role description"
								/>
								<div className="relative inline-block">
									<select
										value={role.agentId}
										onChange={(e) => updateRole(i, { agentId: e.target.value })}
										className="text-[11px] px-2 py-1 rounded border appearance-none pr-6 outline-none cursor-pointer"
										style={{
											backgroundColor: theme.colors.bgSidebar,
											borderColor: theme.colors.border,
											color: theme.colors.textDim,
										}}
									>
										{AGENT_OPTIONS.map((a) => (
											<option key={a.id} value={a.id}>
												{a.name}
											</option>
										))}
									</select>
									<ChevronDown
										className="absolute right-1.5 top-1/2 -translate-y-1/2 w-3 h-3 pointer-events-none"
										style={{ color: theme.colors.textDim }}
									/>
								</div>
							</div>
							<button
								onClick={() => removeRole(i)}
								className="p-1 rounded hover:bg-white/10 transition-colors shrink-0"
								style={{ color: theme.colors.textDim }}
								title="Remove role"
							>
								<Trash2 className="w-3.5 h-3.5" />
							</button>
						</div>
					</div>
				))}
			</div>

			<button
				onClick={addRole}
				className="flex items-center gap-1.5 mt-3 px-3 py-1.5 rounded-lg border text-xs transition-colors hover:bg-white/5"
				style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
			>
				<Plus className="w-3.5 h-3.5" />
				Add Role
			</button>
		</div>
	);

	// Step 2: Topology review
	const renderTopology = () => {
		if (!topology) return null;
		return (
			<div>
				<div
					className="inline-block px-3 py-1 rounded-full text-xs font-medium mb-3"
					style={{ backgroundColor: `${theme.colors.accent}15`, color: theme.colors.accent }}
				>
					Pattern: {topology.pattern}
				</div>

				{topology.reasoning && (
					<p className="text-xs mb-3" style={{ color: theme.colors.textDim }}>
						{topology.reasoning}
					</p>
				)}

				<div className="flex flex-col gap-1.5">
					{topology.edges.map((edge, i) => (
						<div
							key={i}
							className="flex items-center gap-2 px-3 py-2 rounded text-xs"
							style={{ backgroundColor: theme.colors.bgMain, color: theme.colors.textMain }}
						>
							<span className="font-medium">{edge.source}</span>
							<ArrowRight className="w-3 h-3 shrink-0" style={{ color: theme.colors.accent }} />
							<span className="font-medium">{edge.target}</span>
							{edge.condition && (
								<span className="ml-auto text-[10px]" style={{ color: theme.colors.textDim }}>
									{edge.condition}
								</span>
							)}
						</div>
					))}
				</div>

				<div className="flex gap-4 mt-4 text-xs" style={{ color: theme.colors.textDim }}>
					<span>
						Entry: <strong style={{ color: theme.colors.textMain }}>{topology.entryPoint}</strong>
					</span>
					<span>
						Exit: <strong style={{ color: theme.colors.textMain }}>{topology.exitPoint}</strong>
					</span>
				</div>
			</div>
		);
	};

	// Step 3: Confirmation
	const renderConfirm = () => (
		<div>
			<div className="mb-4">
				<h3 className="text-sm font-bold" style={{ color: theme.colors.textMain }}>
					{editableTeamName}
				</h3>
				<p className="text-xs mt-1" style={{ color: theme.colors.textDim }}>
					{roleAssignment?.description}
				</p>
			</div>

			<label
				className="block text-xs font-bold opacity-70 uppercase mb-2"
				style={{ color: theme.colors.textMain }}
			>
				Roles ({editableRoles.length})
			</label>
			<div className="flex flex-col gap-2 mb-4">
				{editableRoles.map((role, i) => {
					const isContractExpanded = expandedContracts.has(i);
					const hasContracts =
						(role.inputContract && role.inputContract.length > 0) ||
						(role.outputContract && role.outputContract.length > 0);

					return (
						<div
							key={i}
							className="px-3 py-2 rounded border text-xs"
							style={{
								borderColor: theme.colors.border,
								backgroundColor: theme.colors.bgMain,
							}}
						>
							<div className="flex items-center justify-between">
								<span className="font-medium" style={{ color: theme.colors.textMain }}>
									{role.name}
								</span>
								<span style={{ color: theme.colors.textDim }}>
									{AGENT_OPTIONS.find((a) => a.id === role.agentId)?.name || role.agentId}
								</span>
							</div>
							<p className="mt-1" style={{ color: theme.colors.textDim }}>
								{role.description}
							</p>

							{/* Collapsible contracts section */}
							<button
								onClick={() => toggleContractExpanded(i)}
								className="flex items-center gap-1 mt-2 text-[10px] hover:opacity-80 transition-opacity cursor-pointer"
								style={{ color: theme.colors.textDim }}
							>
								{isContractExpanded ? (
									<ChevronDown className="w-3 h-3" />
								) : (
									<ChevronRight className="w-3 h-3" />
								)}
								Input/Output Contracts
								{hasContracts && (
									<span
										className="ml-1 px-1 rounded"
										style={{
											backgroundColor: `${theme.colors.accent}20`,
											color: theme.colors.accent,
										}}
									>
										{(role.inputContract?.length || 0) + (role.outputContract?.length || 0)}
									</span>
								)}
							</button>

							{isContractExpanded && (
								<div
									className="mt-2 pl-3 border-l-2 space-y-2"
									style={{ borderColor: `${theme.colors.accent}30` }}
								>
									{/* Input contracts */}
									<div>
										<span
											className="text-[10px] font-bold uppercase"
											style={{ color: theme.colors.textDim }}
										>
											Expects
										</span>
										<div className="flex flex-wrap gap-1 mt-1">
											{(role.inputContract || []).map((item, j) => (
												<span
													key={j}
													className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px]"
													style={{
														backgroundColor: `${theme.colors.accent}15`,
														color: theme.colors.accent,
													}}
												>
													{item}
													<button
														onClick={() => removeContractItem(i, 'inputContract', j)}
														className="hover:opacity-60 cursor-pointer"
													>
														<X className="w-2.5 h-2.5" />
													</button>
												</span>
											))}
										</div>
										<div className="flex items-center gap-1 mt-1">
											<input
												value={contractInputValues[`${i}-inputContract`] || ''}
												onChange={(e) =>
													setContractInputValues((prev) => ({
														...prev,
														[`${i}-inputContract`]: e.target.value,
													}))
												}
												onKeyDown={(e) => {
													if (e.key === 'Enter') {
														e.preventDefault();
														addContractItem(i, 'inputContract');
													}
												}}
												placeholder="e.g., requirements document"
												className="flex-1 px-1.5 py-0.5 rounded border text-[10px] outline-none"
												style={{
													backgroundColor: 'transparent',
													borderColor: theme.colors.border,
													color: theme.colors.textMain,
												}}
											/>
											<button
												onClick={() => addContractItem(i, 'inputContract')}
												className="px-1.5 py-0.5 rounded text-[10px] hover:opacity-80 transition-opacity cursor-pointer"
												style={{
													backgroundColor: `${theme.colors.accent}20`,
													color: theme.colors.accent,
												}}
											>
												Add
											</button>
										</div>
									</div>

									{/* Output contracts */}
									<div>
										<span
											className="text-[10px] font-bold uppercase"
											style={{ color: theme.colors.textDim }}
										>
											Produces
										</span>
										<div className="flex flex-wrap gap-1 mt-1">
											{(role.outputContract || []).map((item, j) => (
												<span
													key={j}
													className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px]"
													style={{
														backgroundColor: `${theme.colors.success}15`,
														color: theme.colors.success,
													}}
												>
													{item}
													<button
														onClick={() => removeContractItem(i, 'outputContract', j)}
														className="hover:opacity-60 cursor-pointer"
													>
														<X className="w-2.5 h-2.5" />
													</button>
												</span>
											))}
										</div>
										<div className="flex items-center gap-1 mt-1">
											<input
												value={contractInputValues[`${i}-outputContract`] || ''}
												onChange={(e) =>
													setContractInputValues((prev) => ({
														...prev,
														[`${i}-outputContract`]: e.target.value,
													}))
												}
												onKeyDown={(e) => {
													if (e.key === 'Enter') {
														e.preventDefault();
														addContractItem(i, 'outputContract');
													}
												}}
												placeholder="e.g., implementation plan"
												className="flex-1 px-1.5 py-0.5 rounded border text-[10px] outline-none"
												style={{
													backgroundColor: 'transparent',
													borderColor: theme.colors.border,
													color: theme.colors.textMain,
												}}
											/>
											<button
												onClick={() => addContractItem(i, 'outputContract')}
												className="px-1.5 py-0.5 rounded text-[10px] hover:opacity-80 transition-opacity cursor-pointer"
												style={{
													backgroundColor: `${theme.colors.success}20`,
													color: theme.colors.success,
												}}
											>
												Add
											</button>
										</div>
									</div>
								</div>
							)}
						</div>
					);
				})}
			</div>

			{topology && (
				<div>
					<label
						className="block text-xs font-bold opacity-70 uppercase mb-2"
						style={{ color: theme.colors.textMain }}
					>
						Topology
					</label>
					<span
						className="inline-block px-2 py-1 rounded text-xs"
						style={{ backgroundColor: `${theme.colors.accent}15`, color: theme.colors.accent }}
					>
						{topology.pattern}
					</span>
				</div>
			)}
		</div>
	);

	// -- Footer --

	const renderFooter = () => {
		if (loading) return null;

		const backBtn = (targetStep: WizardStep) => (
			<button
				onClick={() => setStep(targetStep)}
				className="px-4 py-2 rounded border hover:bg-white/5 transition-colors outline-none flex items-center gap-1.5"
				style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
			>
				<ArrowLeft className="w-3.5 h-3.5" />
				Back
			</button>
		);

		const accentBtn = (
			label: string,
			onClick: () => void,
			disabled = false,
			icon?: JSX.Element
		) => (
			<button
				onClick={onClick}
				disabled={disabled}
				className="px-4 py-2 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed outline-none flex items-center gap-1.5"
				style={{ backgroundColor: theme.colors.accent, color: theme.colors.accentForeground }}
			>
				{icon}
				{label}
			</button>
		);

		const dimBtn = (label: string, onClick: () => void, icon?: JSX.Element) => (
			<button
				onClick={onClick}
				className="px-3 py-2 rounded border hover:bg-white/5 transition-colors outline-none flex items-center gap-1.5 text-sm"
				style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
			>
				{icon}
				{label}
			</button>
		);

		switch (step) {
			case 0:
				return (
					<div className="flex items-center gap-2 w-full justify-end">
						{dimBtn('Cancel', handleClose)}
						{accentBtn(
							'Build Team',
							handleBuildTeam,
							!intent.trim(),
							<Wand2 className="w-3.5 h-3.5" />
						)}
					</div>
				);
			case 1:
				return (
					<div className="flex items-center gap-2 w-full">
						{backBtn(0)}
						<div className="flex-1" />
						{dimBtn('Revise', handleBuildTeam, <RotateCcw className="w-3.5 h-3.5" />)}
						{accentBtn('Approve & Continue', handleApproveRoles, editableRoles.length === 0)}
					</div>
				);
			case 2:
				return (
					<div className="flex items-center gap-2 w-full">
						{backBtn(1)}
						<div className="flex-1" />
						{dimBtn('Skip (use hub-spoke)', handleSkipTopology)}
						{accentBtn('Approve & Continue', handleApproveTopology)}
					</div>
				);
			case 3:
				return (
					<div className="flex items-center gap-2 w-full">
						{backBtn(enableTopology ? 2 : 1)}
						<div className="flex-1" />
						{dimBtn('Save as Template', handleSaveTemplate, <Save className="w-3.5 h-3.5" />)}
						{dimBtn('Create & Save', handleCreateAndSave)}
						{accentBtn(
							'Create Group Chat',
							handleCreateChat,
							false,
							<MessageSquarePlus className="w-3.5 h-3.5" />
						)}
					</div>
				);
			default:
				return null;
		}
	};

	return (
		<Modal
			theme={theme}
			title="Team Builder"
			priority={MODAL_PRIORITIES.TEAM_BUILDER_WIZARD}
			onClose={handleClose}
			width={600}
			headerIcon={<Wand2 className="w-4 h-4" style={{ color: theme.colors.accent }} />}
			footer={renderFooter()}
		>
			{renderStepDots()}
			{renderError()}
			{loading ? (
				renderLoading()
			) : (
				<>
					{step === 0 && renderIntent()}
					{step === 1 && renderRoles()}
					{step === 2 && renderTopology()}
					{step === 3 && renderConfirm()}
				</>
			)}
		</Modal>
	);
}
