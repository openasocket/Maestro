/**
 * TeamGenerationWizard — Multi-step overlay for AI-powered team generation.
 *
 * Renders on top of the Team Builder canvas (position: absolute, inset: 0, zIndex: 30).
 * Users describe what they want the team to accomplish, answer guided questions,
 * and an LLM generates a complete team structure with roles, prompts, tiers,
 * and connections. The result can be reviewed/edited before populating the canvas.
 *
 * Steps:
 *   1. Describe Your Team — goal/description textarea + optional name
 *   2. Guided Questions — team size, rigor, domain, specializations
 *   3. Generating — loading state while LLM runs
 *   4. Review Generated Team — preview/edit roles, accept & build
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import {
	Sparkles,
	X,
	ChevronRight,
	ChevronLeft,
	Loader2,
	AlertCircle,
	Pencil,
	Trash2,
	Plus,
	Check,
	RefreshCw,
	Crown,
	Briefcase,
	Wrench,
} from 'lucide-react';
import type { Theme } from '../../types';
import type { RoleTier } from '../../../shared/group-chat-types';
import { TIER_COLORS } from './nodes/RoleBuilderNode';

// ============================================================================
// Types
// ============================================================================

export interface TeamGenerationRole {
	name: string;
	tier: RoleTier;
	agentId: string;
	description: string;
	prompt: string;
	reportsTo?: string;
}

export interface TeamGenerationResult {
	name: string;
	description: string;
	roles: TeamGenerationRole[];
}

export interface TeamGenerationWizardProps {
	theme: Theme;
	onClose: () => void;
	onAccept: (result: TeamGenerationResult) => void;
}

// ============================================================================
// Constants
// ============================================================================

const TEAM_SIZE_OPTIONS = [
	{ value: 'small', label: '3–5 members' },
	{ value: 'medium', label: '5–8 members' },
	{ value: 'large', label: '8–12 members' },
	{ value: 'auto', label: 'Let AI decide' },
] as const;

const RIGOR_OPTIONS = [
	{ value: 'light', label: 'Light', description: 'One reviewer' },
	{ value: 'standard', label: 'Standard', description: 'Manager + exec' },
	{ value: 'strict', label: 'Strict', description: 'Multi-layer review chain' },
] as const;

const DOMAIN_OPTIONS = [
	'Frontend',
	'Backend',
	'Full-Stack',
	'DevOps',
	'Security',
	'Research',
	'General',
] as const;

const SPECIALIZATION_OPTIONS = [
	{ value: 'testing', label: 'Testing' },
	{ value: 'documentation', label: 'Documentation' },
	{ value: 'security', label: 'Security' },
	{ value: 'performance', label: 'Performance' },
] as const;

const TIER_ICONS = {
	executive: Crown,
	manager: Briefcase,
	worker: Wrench,
} as const;

type Step = 1 | 2 | 3 | 4;

// ============================================================================
// Component
// ============================================================================

export function TeamGenerationWizard({ theme, onClose, onAccept }: TeamGenerationWizardProps) {
	// Step state
	const [step, setStep] = useState<Step>(1);

	// Step 1 state
	const [description, setDescription] = useState('');
	const [teamName, setTeamName] = useState('');

	// Step 2 state
	const [teamSize, setTeamSize] = useState<'small' | 'medium' | 'large' | 'auto'>('auto');
	const [rigor, setRigor] = useState<'light' | 'standard' | 'strict'>('standard');
	const [domain, setDomain] = useState<string>('General');
	const [specializations, setSpecializations] = useState<string[]>([]);

	// Step 3/4 state
	const [_generating, setGenerating] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [result, setResult] = useState<TeamGenerationResult | null>(null);

	// Step 4: inline editing
	const [editingRoleIndex, setEditingRoleIndex] = useState<number | null>(null);

	const descriptionRef = useRef<HTMLTextAreaElement>(null);

	// Auto-focus textarea on mount
	useEffect(() => {
		const timer = setTimeout(() => descriptionRef.current?.focus(), 50);
		return () => clearTimeout(timer);
	}, []);

	// Toggle specialization checkbox
	const toggleSpecialization = useCallback((spec: string) => {
		setSpecializations((prev) =>
			prev.includes(spec) ? prev.filter((s) => s !== spec) : [...prev, spec]
		);
	}, []);

	// Generate team via IPC
	const handleGenerate = useCallback(async () => {
		setGenerating(true);
		setError(null);
		try {
			const request = {
				description,
				teamSize: teamSize as 'small' | 'medium' | 'large' | 'auto',
				rigor: rigor as 'light' | 'standard' | 'strict',
				domain,
				specializations,
			};
			const generated = await window.maestro.teamGeneration.generate(request);
			// Apply the user's team name if provided
			if (teamName.trim()) {
				generated.name = teamName.trim();
			}
			setResult(generated);
			setStep(4);
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to generate team. Please try again.');
		} finally {
			setGenerating(false);
		}
	}, [description, teamSize, rigor, domain, specializations, teamName]);

	// Step navigation
	const goToStep2 = useCallback(() => setStep(2), []);
	const goToStep1 = useCallback(() => setStep(1), []);
	const goToStep3 = useCallback(() => {
		setStep(3);
		// Trigger generation on next tick so the loading UI renders first
		setTimeout(() => handleGenerate(), 0);
	}, [handleGenerate]);

	const handleRegenerate = useCallback(() => {
		setResult(null);
		setEditingRoleIndex(null);
		setStep(3);
		setTimeout(() => handleGenerate(), 0);
	}, [handleGenerate]);

	const handleAccept = useCallback(() => {
		if (result) {
			onAccept(result);
		}
	}, [result, onAccept]);

	// Step 4: edit a role field
	const updateRole = useCallback(
		(index: number, updates: Partial<TeamGenerationRole>) => {
			if (!result) return;
			const newRoles = [...result.roles];
			newRoles[index] = { ...newRoles[index], ...updates };
			setResult({ ...result, roles: newRoles });
		},
		[result]
	);

	// Step 4: remove a role
	const removeRole = useCallback(
		(index: number) => {
			if (!result) return;
			const removedName = result.roles[index].name;
			const newRoles = result.roles.filter((_, i) => i !== index);
			// Clear any reportsTo references to the removed role
			for (const role of newRoles) {
				if (role.reportsTo === removedName) {
					role.reportsTo = undefined;
				}
			}
			setResult({ ...result, roles: newRoles });
			setEditingRoleIndex(null);
		},
		[result]
	);

	// Step 4: add a blank role
	const addRole = useCallback(() => {
		if (!result) return;
		const newRole: TeamGenerationRole = {
			name: `New Role ${result.roles.length + 1}`,
			tier: 'worker',
			agentId: 'claude-code',
			description: '',
			prompt: '',
		};
		setResult({ ...result, roles: [...result.roles, newRole] });
		setEditingRoleIndex(result.roles.length);
	}, [result]);

	// Close on Escape
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				e.stopPropagation();
				onClose();
			}
		};
		window.addEventListener('keydown', handleKeyDown);
		return () => window.removeEventListener('keydown', handleKeyDown);
	}, [onClose]);

	// ─── Styles ──────────────────────────────────────────────────────────

	const overlayStyle: React.CSSProperties = {
		position: 'absolute',
		inset: 0,
		zIndex: 30,
		backgroundColor: `${theme.colors.bgMain}f0`,
		backdropFilter: 'blur(4px)',
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
	};

	const panelStyle: React.CSSProperties = {
		width: 'min(600px, 90%)',
		maxHeight: '80%',
		backgroundColor: theme.colors.bgMain,
		border: `1px solid ${theme.colors.border}`,
		borderRadius: 12,
		boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
		display: 'flex',
		flexDirection: 'column',
		overflow: 'hidden',
	};

	const headerStyle: React.CSSProperties = {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'space-between',
		padding: '14px 18px',
		borderBottom: `1px solid ${theme.colors.border}`,
		flexShrink: 0,
	};

	const contentStyle: React.CSSProperties = {
		flex: 1,
		overflow: 'auto',
		padding: '18px',
	};

	const footerStyle: React.CSSProperties = {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'space-between',
		padding: '12px 18px',
		borderTop: `1px solid ${theme.colors.border}`,
		flexShrink: 0,
	};

	const inputStyle: React.CSSProperties = {
		width: '100%',
		backgroundColor: theme.colors.bgActivity,
		border: `1px solid ${theme.colors.border}`,
		borderRadius: 6,
		padding: '8px 12px',
		color: theme.colors.textMain,
		fontSize: 13,
		outline: 'none',
	};

	const labelStyle: React.CSSProperties = {
		color: theme.colors.textMain,
		fontSize: 12,
		fontWeight: 600,
		marginBottom: 6,
		display: 'block',
	};

	const selectStyle: React.CSSProperties = {
		...inputStyle,
		cursor: 'pointer',
		appearance: 'none',
		backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%236b7280' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E")`,
		backgroundRepeat: 'no-repeat',
		backgroundPosition: 'right 10px center',
		paddingRight: 30,
	};

	const primaryBtnStyle: React.CSSProperties = {
		display: 'flex',
		alignItems: 'center',
		gap: 6,
		padding: '6px 16px',
		borderRadius: 6,
		border: `1px solid ${theme.colors.accent}`,
		backgroundColor: `${theme.colors.accent}20`,
		color: theme.colors.accent,
		fontSize: 12,
		fontWeight: 600,
		cursor: 'pointer',
		transition: 'all 0.15s',
	};

	const secondaryBtnStyle: React.CSSProperties = {
		display: 'flex',
		alignItems: 'center',
		gap: 6,
		padding: '6px 16px',
		borderRadius: 6,
		border: `1px solid ${theme.colors.border}`,
		backgroundColor: 'transparent',
		color: theme.colors.textDim,
		fontSize: 12,
		fontWeight: 500,
		cursor: 'pointer',
		transition: 'all 0.15s',
	};

	// ─── Step indicators ─────────────────────────────────────────────────

	const stepLabels = ['Describe', 'Configure', 'Generate', 'Review'];

	const renderStepIndicator = () => (
		<div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
			{stepLabels.map((label, idx) => {
				const stepNum = (idx + 1) as Step;
				const isActive = step === stepNum;
				const isCompleted = step > stepNum;
				return (
					<div key={label} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
						<div
							style={{
								width: 20,
								height: 20,
								borderRadius: '50%',
								display: 'flex',
								alignItems: 'center',
								justifyContent: 'center',
								fontSize: 10,
								fontWeight: 600,
								backgroundColor: isActive
									? theme.colors.accent
									: isCompleted
										? `${theme.colors.accent}40`
										: theme.colors.bgActivity,
								color: isActive
									? theme.colors.accentForeground
									: isCompleted
										? theme.colors.accent
										: theme.colors.textDim,
								border: `1px solid ${isActive || isCompleted ? theme.colors.accent : theme.colors.border}`,
							}}
						>
							{isCompleted ? <Check size={10} /> : stepNum}
						</div>
						<span
							style={{
								fontSize: 10,
								fontWeight: isActive ? 600 : 400,
								color: isActive ? theme.colors.textMain : theme.colors.textDim,
							}}
						>
							{label}
						</span>
						{idx < stepLabels.length - 1 && (
							<div
								style={{
									width: 16,
									height: 1,
									backgroundColor: isCompleted ? theme.colors.accent : theme.colors.border,
								}}
							/>
						)}
					</div>
				);
			})}
		</div>
	);

	// ─── Step 1: Describe Your Team ──────────────────────────────────────

	const renderStep1 = () => (
		<>
			<div style={contentStyle}>
				<div style={{ marginBottom: 16 }}>
					<label style={labelStyle}>What should this team accomplish?</label>
					<textarea
						ref={descriptionRef}
						value={description}
						onChange={(e) => setDescription(e.target.value)}
						placeholder="e.g., Build and review a full-stack feature with automated testing and documentation"
						style={{
							...inputStyle,
							minHeight: 120,
							resize: 'vertical',
							lineHeight: 1.5,
						}}
					/>
				</div>
				<div>
					<label style={labelStyle}>
						Team name{' '}
						<span style={{ fontWeight: 400, color: theme.colors.textDim }}>(optional)</span>
					</label>
					<input
						type="text"
						value={teamName}
						onChange={(e) => setTeamName(e.target.value)}
						placeholder="e.g., Full-Stack Feature Team"
						style={inputStyle}
					/>
				</div>
			</div>
			<div style={footerStyle}>
				<button onClick={onClose} style={secondaryBtnStyle}>
					Cancel
				</button>
				<button
					onClick={goToStep2}
					disabled={!description.trim()}
					style={{
						...primaryBtnStyle,
						opacity: description.trim() ? 1 : 0.5,
						cursor: description.trim() ? 'pointer' : 'not-allowed',
					}}
				>
					Next
					<ChevronRight size={12} />
				</button>
			</div>
		</>
	);

	// ─── Step 2: Guided Questions ────────────────────────────────────────

	const renderStep2 = () => (
		<>
			<div style={contentStyle}>
				<div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
					{/* Team size */}
					<div>
						<label style={labelStyle}>How many team members should there be?</label>
						<select
							value={teamSize}
							onChange={(e) => setTeamSize(e.target.value as 'small' | 'medium' | 'large' | 'auto')}
							style={selectStyle}
						>
							{TEAM_SIZE_OPTIONS.map((opt) => (
								<option key={opt.value} value={opt.value}>
									{opt.label}
								</option>
							))}
						</select>
					</div>

					{/* Review rigor */}
					<div>
						<label style={labelStyle}>What level of review rigor do you need?</label>
						<select
							value={rigor}
							onChange={(e) => setRigor(e.target.value as 'light' | 'standard' | 'strict')}
							style={selectStyle}
						>
							{RIGOR_OPTIONS.map((opt) => (
								<option key={opt.value} value={opt.value}>
									{opt.label} — {opt.description}
								</option>
							))}
						</select>
					</div>

					{/* Domain */}
					<div>
						<label style={labelStyle}>What's the primary domain?</label>
						<select value={domain} onChange={(e) => setDomain(e.target.value)} style={selectStyle}>
							{DOMAIN_OPTIONS.map((d) => (
								<option key={d} value={d}>
									{d}
								</option>
							))}
						</select>
					</div>

					{/* Specializations */}
					<div>
						<label style={labelStyle}>Should the team include specialized roles?</label>
						<div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
							{SPECIALIZATION_OPTIONS.map((spec) => {
								const isChecked = specializations.includes(spec.value);
								return (
									<label
										key={spec.value}
										style={{
											display: 'flex',
											alignItems: 'center',
											gap: 6,
											cursor: 'pointer',
											fontSize: 12,
											color: isChecked ? theme.colors.textMain : theme.colors.textDim,
											backgroundColor: isChecked
												? `${theme.colors.accent}15`
												: theme.colors.bgActivity,
											border: `1px solid ${isChecked ? theme.colors.accent : theme.colors.border}`,
											borderRadius: 6,
											padding: '6px 10px',
											transition: 'all 0.15s',
										}}
									>
										<input
											type="checkbox"
											checked={isChecked}
											onChange={() => toggleSpecialization(spec.value)}
											style={{ display: 'none' }}
										/>
										<div
											style={{
												width: 14,
												height: 14,
												borderRadius: 3,
												border: `1px solid ${isChecked ? theme.colors.accent : theme.colors.border}`,
												backgroundColor: isChecked ? theme.colors.accent : 'transparent',
												display: 'flex',
												alignItems: 'center',
												justifyContent: 'center',
												flexShrink: 0,
											}}
										>
											{isChecked && <Check size={9} color={theme.colors.accentForeground} />}
										</div>
										{spec.label}
									</label>
								);
							})}
						</div>
					</div>
				</div>
			</div>
			<div style={footerStyle}>
				<button onClick={goToStep1} style={secondaryBtnStyle}>
					<ChevronLeft size={12} />
					Back
				</button>
				<button onClick={goToStep3} style={primaryBtnStyle}>
					Generate
					<Sparkles size={12} />
				</button>
			</div>
		</>
	);

	// ─── Step 3: Generating ──────────────────────────────────────────────

	const renderStep3 = () => (
		<>
			<div
				style={{
					...contentStyle,
					display: 'flex',
					flexDirection: 'column',
					alignItems: 'center',
					justifyContent: 'center',
					minHeight: 200,
					gap: 16,
				}}
			>
				{error ? (
					<>
						<AlertCircle size={32} color={theme.colors.error} />
						<div
							style={{
								color: theme.colors.error,
								fontSize: 13,
								textAlign: 'center',
								maxWidth: 400,
							}}
						>
							{error}
						</div>
						<button
							onClick={() => {
								setError(null);
								handleGenerate();
							}}
							style={primaryBtnStyle}
						>
							<RefreshCw size={12} />
							Try Again
						</button>
					</>
				) : (
					<>
						<Loader2
							size={32}
							color={theme.colors.accent}
							style={{ animation: 'spin 1s linear infinite' }}
						/>
						<div style={{ color: theme.colors.textDim, fontSize: 13 }}>
							Generating team structure...
						</div>
					</>
				)}
			</div>
			{error && (
				<div style={footerStyle}>
					<button onClick={goToStep2} style={secondaryBtnStyle}>
						<ChevronLeft size={12} />
						Back
					</button>
					<div />
				</div>
			)}
			{/* Inject keyframes for spinner */}
			<style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
		</>
	);

	// ─── Step 4: Review Generated Team ───────────────────────────────────

	const renderStep4 = () => {
		if (!result) return null;

		return (
			<>
				<div style={contentStyle}>
					{/* Team header */}
					<div style={{ marginBottom: 16 }}>
						<div
							style={{
								color: theme.colors.textMain,
								fontSize: 15,
								fontWeight: 600,
								marginBottom: 4,
							}}
						>
							{result.name}
						</div>
						<div style={{ color: theme.colors.textDim, fontSize: 12 }}>{result.description}</div>
					</div>

					{/* Roles list */}
					<div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
						{result.roles.map((role, idx) => {
							const TierIcon = TIER_ICONS[role.tier];
							const tierColor = TIER_COLORS[role.tier] ?? TIER_COLORS.worker;
							const isEditing = editingRoleIndex === idx;

							return (
								<div
									key={idx}
									style={{
										borderRadius: 8,
										borderLeft: `3px solid ${tierColor}`,
										backgroundColor: theme.colors.bgActivity,
										overflow: 'hidden',
									}}
								>
									{/* Role header row */}
									<div
										style={{
											display: 'flex',
											alignItems: 'center',
											gap: 8,
											padding: '10px 12px',
										}}
									>
										<TierIcon size={14} color={tierColor} />
										<div style={{ flex: 1, minWidth: 0 }}>
											<div
												style={{
													color: theme.colors.textMain,
													fontSize: 13,
													fontWeight: 500,
												}}
											>
												{role.name}
											</div>
											<div
												style={{
													color: theme.colors.textDim,
													fontSize: 11,
													whiteSpace: 'nowrap',
													overflow: 'hidden',
													textOverflow: 'ellipsis',
												}}
											>
												{role.description}
											</div>
										</div>
										{/* Tier badge */}
										<span
											style={{
												fontSize: 9,
												fontWeight: 600,
												textTransform: 'uppercase',
												color: tierColor,
												backgroundColor: `${tierColor}20`,
												padding: '2px 6px',
												borderRadius: 4,
												flexShrink: 0,
											}}
										>
											{role.tier}
										</span>
										{role.reportsTo && (
											<span
												style={{
													fontSize: 9,
													color: theme.colors.textDim,
													backgroundColor: `${theme.colors.border}80`,
													padding: '2px 6px',
													borderRadius: 4,
													flexShrink: 0,
												}}
											>
												→ {role.reportsTo}
											</span>
										)}
										{/* Edit / Delete buttons */}
										<button
											onClick={() => setEditingRoleIndex(isEditing ? null : idx)}
											style={{
												background: 'none',
												border: 'none',
												cursor: 'pointer',
												padding: 4,
												display: 'flex',
												alignItems: 'center',
												color: isEditing ? theme.colors.accent : theme.colors.textDim,
											}}
											title={isEditing ? 'Done editing' : 'Edit role'}
										>
											{isEditing ? <Check size={12} /> : <Pencil size={12} />}
										</button>
										<button
											onClick={() => removeRole(idx)}
											style={{
												background: 'none',
												border: 'none',
												cursor: 'pointer',
												padding: 4,
												display: 'flex',
												alignItems: 'center',
												color: theme.colors.textDim,
											}}
											title="Remove role"
										>
											<Trash2 size={12} />
										</button>
									</div>

									{/* Inline editor */}
									{isEditing && (
										<div
											style={{
												padding: '0 12px 12px',
												display: 'flex',
												flexDirection: 'column',
												gap: 8,
												borderTop: `1px solid ${theme.colors.border}`,
												paddingTop: 10,
											}}
										>
											<div style={{ display: 'flex', gap: 8 }}>
												<div style={{ flex: 1 }}>
													<label
														style={{
															...labelStyle,
															fontSize: 10,
															marginBottom: 3,
														}}
													>
														Name
													</label>
													<input
														type="text"
														value={role.name}
														onChange={(e) =>
															updateRole(idx, {
																name: e.target.value,
															})
														}
														style={{
															...inputStyle,
															fontSize: 12,
															padding: '4px 8px',
														}}
													/>
												</div>
												<div style={{ width: 120 }}>
													<label
														style={{
															...labelStyle,
															fontSize: 10,
															marginBottom: 3,
														}}
													>
														Tier
													</label>
													<div
														style={{
															display: 'flex',
															gap: 2,
														}}
													>
														{(['executive', 'manager', 'worker'] as const).map((t) => (
															<button
																key={t}
																onClick={() => updateRole(idx, { tier: t })}
																style={{
																	flex: 1,
																	fontSize: 9,
																	fontWeight: 600,
																	textTransform: 'uppercase',
																	padding: '4px 0',
																	borderRadius: 4,
																	border: `1px solid ${role.tier === t ? TIER_COLORS[t] : theme.colors.border}`,
																	backgroundColor:
																		role.tier === t ? `${TIER_COLORS[t]}20` : 'transparent',
																	color: role.tier === t ? TIER_COLORS[t] : theme.colors.textDim,
																	cursor: 'pointer',
																	transition: 'all 0.15s',
																}}
															>
																{t.charAt(0).toUpperCase()}
															</button>
														))}
													</div>
												</div>
											</div>
											<div>
												<label
													style={{
														...labelStyle,
														fontSize: 10,
														marginBottom: 3,
													}}
												>
													Prompt
												</label>
												<textarea
													value={role.prompt}
													onChange={(e) =>
														updateRole(idx, {
															prompt: e.target.value,
														})
													}
													style={{
														...inputStyle,
														fontSize: 12,
														padding: '4px 8px',
														minHeight: 60,
														resize: 'vertical',
														lineHeight: 1.4,
													}}
												/>
											</div>
										</div>
									)}
								</div>
							);
						})}
					</div>

					{/* Add Role button */}
					<button
						onClick={addRole}
						style={{
							display: 'flex',
							alignItems: 'center',
							gap: 6,
							marginTop: 10,
							padding: '6px 12px',
							borderRadius: 6,
							border: `1px dashed ${theme.colors.border}`,
							backgroundColor: 'transparent',
							color: theme.colors.textDim,
							fontSize: 12,
							cursor: 'pointer',
							transition: 'all 0.15s',
						}}
					>
						<Plus size={12} />
						Add Role
					</button>
				</div>
				<div style={footerStyle}>
					<button onClick={handleRegenerate} style={secondaryBtnStyle}>
						<RefreshCw size={12} />
						Regenerate
					</button>
					<button onClick={handleAccept} style={primaryBtnStyle}>
						<Check size={12} />
						Accept & Build
					</button>
				</div>
			</>
		);
	};

	// ─── Render ──────────────────────────────────────────────────────────

	return (
		<div style={overlayStyle} onClick={onClose}>
			<div style={panelStyle} onClick={(e) => e.stopPropagation()}>
				{/* Header */}
				<div style={headerStyle}>
					<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
						<Sparkles size={16} color={theme.colors.accent} />
						<span
							style={{
								color: theme.colors.textMain,
								fontSize: 14,
								fontWeight: 600,
							}}
						>
							AI Team Generator
						</span>
					</div>
					{renderStepIndicator()}
					<button
						onClick={onClose}
						style={{
							background: 'none',
							border: 'none',
							cursor: 'pointer',
							padding: 4,
							display: 'flex',
							alignItems: 'center',
							color: theme.colors.textDim,
						}}
					>
						<X size={14} />
					</button>
				</div>

				{/* Step content */}
				{step === 1 && renderStep1()}
				{step === 2 && renderStep2()}
				{step === 3 && renderStep3()}
				{step === 4 && renderStep4()}
			</div>
		</div>
	);
}
