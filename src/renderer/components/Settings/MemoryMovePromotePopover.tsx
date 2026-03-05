/**
 * MemoryMovePromotePopover - Unified Move/Promote popover for memory cards.
 *
 * Shows context-sensitive actions based on the memory's current type and scope:
 *   - Experience → Rule (upward promotion)
 *   - Rule → Experience (demotion/contextualization)
 *   - Project → Global (scope promotion)
 *   - Global → Project (scope narrowing)
 *   - Skill → Different Skill (lateral move)
 *   - Unscoped → Skill (hierarchy assignment)
 *
 * Created during MEM-TAB-07 for cross-tab promotion/demotion flows.
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import {
	ArrowUpCircle,
	ArrowDownCircle,
	Globe,
	FolderInput,
	Layers,
	ChevronRight,
	ArrowRightLeft,
} from 'lucide-react';
import type { Theme } from '../../types';
import type { MemoryEntry, SkillArea, Persona } from '../../../shared/memory-types';

export type MovePromoteAction =
	| { kind: 'promote-to-rule'; memory: MemoryEntry }
	| { kind: 'demote-to-experience'; memory: MemoryEntry }
	| { kind: 'scope-to-global'; memory: MemoryEntry }
	| { kind: 'scope-to-project'; memory: MemoryEntry }
	| { kind: 'move-to-skill'; memory: MemoryEntry; skillAreaId: string }
	| { kind: 'assign-skill'; memory: MemoryEntry; skillAreaId: string };

interface MemoryMovePromotePopoverProps {
	memory: MemoryEntry;
	theme: Theme;
	skillAreas?: SkillArea[];
	personas?: Persona[];
	onAction: (action: MovePromoteAction) => void;
}

export function MemoryMovePromotePopover({
	memory,
	theme,
	skillAreas = [],
	personas = [],
	onAction,
}: MemoryMovePromotePopoverProps) {
	const [open, setOpen] = useState(false);
	const [showSkillPicker, setShowSkillPicker] = useState<'move' | 'assign' | null>(null);
	const popoverRef = useRef<HTMLDivElement>(null);

	// Close on outside click
	useEffect(() => {
		if (!open) return;
		const handler = (e: MouseEvent) => {
			if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
				setOpen(false);
				setShowSkillPicker(null);
			}
		};
		document.addEventListener('mousedown', handler);
		return () => document.removeEventListener('mousedown', handler);
	}, [open]);

	const handleAction = useCallback(
		(action: MovePromoteAction) => {
			setOpen(false);
			setShowSkillPicker(null);
			onAction(action);
		},
		[onAction]
	);

	const isExperience = memory.type === 'experience';
	const isRule = memory.type === 'rule';
	const isProject = memory.scope === 'project';
	const isGlobal = memory.scope === 'global';
	const isSkill = memory.scope === 'skill';

	// Group skills by persona for the picker
	const skillsByPersona = skillAreas.reduce(
		(acc, skill) => {
			const personaName = personas.find((p) => p.id === skill.personaId)?.name ?? 'Unknown';
			if (!acc[personaName]) acc[personaName] = [];
			acc[personaName].push(skill);
			return acc;
		},
		{} as Record<string, SkillArea[]>
	);

	// Filter out current skill for lateral moves
	const availableSkills = skillAreas.filter((s) => s.id !== memory.skillAreaId);

	const hasAnyAction =
		isExperience || isRule || isProject || isGlobal || isSkill || availableSkills.length > 0;

	if (!hasAnyAction) return null;

	return (
		<div className="relative" ref={popoverRef}>
			<button
				className="p-0.5 rounded hover:opacity-80 transition-opacity"
				style={{ color: open ? theme.colors.accent : theme.colors.textDim }}
				title="Move / Promote"
				onClick={(e) => {
					e.stopPropagation();
					setOpen(!open);
					setShowSkillPicker(null);
				}}
			>
				<ArrowRightLeft className="w-3 h-3" />
			</button>

			{open && (
				<div
					className="absolute right-0 top-full mt-1 z-50 rounded-lg border shadow-lg py-1 min-w-[200px]"
					style={{
						backgroundColor: theme.colors.bgSidebar,
						borderColor: theme.colors.border,
					}}
					onClick={(e) => e.stopPropagation()}
				>
					{showSkillPicker ? (
						<>
							<div
								className="px-3 py-1.5 text-[10px] font-medium border-b"
								style={{ color: theme.colors.textDim, borderColor: theme.colors.border }}
							>
								{showSkillPicker === 'move' ? 'Move to Skill' : 'Assign to Skill'}
							</div>
							<div className="max-h-[200px] overflow-y-auto scrollbar-thin">
								{Object.entries(skillsByPersona).map(([personaName, skills]) => {
									const filteredSkills = skills.filter((s) => s.id !== memory.skillAreaId);
									if (filteredSkills.length === 0) return null;
									return (
										<div key={personaName}>
											<div
												className="px-3 py-1 text-[10px] font-medium"
												style={{ color: theme.colors.textDim }}
											>
												{personaName}
											</div>
											{filteredSkills.map((skill) => (
												<button
													key={skill.id}
													className="w-full text-left px-4 py-1.5 text-xs hover:opacity-80 transition-opacity"
													style={{ color: theme.colors.textMain }}
													onClick={() =>
														handleAction(
															showSkillPicker === 'move'
																? { kind: 'move-to-skill', memory, skillAreaId: skill.id }
																: { kind: 'assign-skill', memory, skillAreaId: skill.id }
														)
													}
												>
													{skill.name}
												</button>
											))}
										</div>
									);
								})}
							</div>
							<button
								className="w-full text-left px-3 py-1.5 text-[10px] border-t hover:opacity-80 transition-opacity"
								style={{ color: theme.colors.textDim, borderColor: theme.colors.border }}
								onClick={() => setShowSkillPicker(null)}
							>
								Back
							</button>
						</>
					) : (
						<>
							{/* Type promotion/demotion */}
							{isExperience && (
								<button
									className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 hover:opacity-80 transition-opacity"
									style={{ color: theme.colors.accent }}
									onClick={() => handleAction({ kind: 'promote-to-rule', memory })}
								>
									<ArrowUpCircle className="w-3.5 h-3.5" />
									Promote to Rule
								</button>
							)}
							{isRule && (
								<button
									className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 hover:opacity-80 transition-opacity"
									style={{ color: theme.colors.warning }}
									onClick={() => handleAction({ kind: 'demote-to-experience', memory })}
								>
									<ArrowDownCircle className="w-3.5 h-3.5" />
									Convert to Experience
								</button>
							)}

							{/* Scope promotion/narrowing */}
							{isProject && (
								<button
									className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 hover:opacity-80 transition-opacity"
									style={{ color: theme.colors.textMain }}
									onClick={() => handleAction({ kind: 'scope-to-global', memory })}
								>
									<Globe className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
									Promote to Global
								</button>
							)}
							{isGlobal && (
								<button
									className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 hover:opacity-80 transition-opacity"
									style={{ color: theme.colors.textMain }}
									onClick={() => handleAction({ kind: 'scope-to-project', memory })}
								>
									<FolderInput className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
									Narrow to Project
								</button>
							)}

							{/* Skill lateral moves */}
							{isSkill && availableSkills.length > 0 && (
								<button
									className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 hover:opacity-80 transition-opacity"
									style={{ color: theme.colors.textMain }}
									onClick={() => setShowSkillPicker('move')}
								>
									<Layers className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
									Move to Skill
									<ChevronRight
										className="w-3 h-3 ml-auto"
										style={{ color: theme.colors.textDim }}
									/>
								</button>
							)}

							{/* Unscoped → Skill assignment */}
							{!isSkill && availableSkills.length > 0 && (
								<button
									className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 hover:opacity-80 transition-opacity"
									style={{ color: theme.colors.textMain }}
									onClick={() => setShowSkillPicker('assign')}
								>
									<Layers className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
									Assign to Skill
									<ChevronRight
										className="w-3 h-3 ml-auto"
										style={{ color: theme.colors.textDim }}
									/>
								</button>
							)}
						</>
					)}
				</div>
			)}
		</div>
	);
}

// ─── Promotion Dialog ────────────────────────────────────────────────────────

interface PromotionDialogProps {
	memory: MemoryEntry;
	theme: Theme;
	onConfirm: (ruleText: string, archiveSource: boolean) => void;
	onClose: () => void;
}

export function PromotionDialog({ memory, theme, onConfirm, onClose }: PromotionDialogProps) {
	const ctx = memory.experienceContext;
	const defaultRuleText = ctx?.learning ? toImperative(ctx.learning) : toImperative(memory.content);
	const [ruleText, setRuleText] = useState(defaultRuleText);
	const [archiveSource, setArchiveSource] = useState(true);

	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center"
			style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}
			onClick={onClose}
		>
			<div
				className="rounded-lg border shadow-xl p-4 max-w-md w-full space-y-3"
				style={{
					backgroundColor: theme.colors.bgSidebar,
					borderColor: theme.colors.border,
				}}
				onClick={(e) => e.stopPropagation()}
			>
				<div className="flex items-center gap-2">
					<ArrowUpCircle className="w-4 h-4" style={{ color: theme.colors.accent }} />
					<span className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
						Promote Experience to Rule
					</span>
				</div>

				{/* Original experience */}
				<div className="space-y-1">
					<div className="text-[10px] font-medium" style={{ color: theme.colors.textDim }}>
						Original Experience
					</div>
					{ctx?.situation && (
						<div
							className="text-xs italic px-2 py-1 rounded"
							style={{ backgroundColor: `${theme.colors.border}20`, color: theme.colors.textDim }}
						>
							{ctx.situation}
						</div>
					)}
					{ctx?.learning && (
						<div
							className="text-xs font-semibold px-2 py-1 rounded"
							style={{ backgroundColor: `${theme.colors.border}20`, color: theme.colors.textMain }}
						>
							{ctx.learning}
						</div>
					)}
					{!ctx?.situation && !ctx?.learning && (
						<div
							className="text-xs px-2 py-1 rounded"
							style={{ backgroundColor: `${theme.colors.border}20`, color: theme.colors.textMain }}
						>
							{memory.content.length > 200 ? `${memory.content.slice(0, 200)}...` : memory.content}
						</div>
					)}
				</div>

				{/* Proposed rule text */}
				<div className="space-y-1">
					<div className="text-[10px] font-medium" style={{ color: theme.colors.textDim }}>
						Proposed Rule (editable)
					</div>
					<textarea
						className="w-full text-xs px-2 py-1.5 rounded border outline-none resize-y min-h-[60px]"
						style={{
							backgroundColor: theme.colors.bgMain,
							borderColor: theme.colors.border,
							color: theme.colors.textMain,
						}}
						value={ruleText}
						onChange={(e) => setRuleText(e.target.value)}
					/>
				</div>

				{/* Archive option */}
				<label
					className="flex items-center gap-2 text-xs cursor-pointer"
					style={{ color: theme.colors.textDim }}
				>
					<input
						type="checkbox"
						checked={archiveSource}
						onChange={(e) => setArchiveSource(e.target.checked)}
						className="accent-current"
						style={{ accentColor: theme.colors.accent }}
					/>
					Archive source experience after promotion
				</label>

				{/* Actions */}
				<div className="flex justify-end gap-2 pt-1">
					<button
						className="text-xs px-3 py-1.5 rounded hover:opacity-80 transition-opacity"
						style={{ color: theme.colors.textDim }}
						onClick={onClose}
					>
						Cancel
					</button>
					<button
						className="text-xs px-3 py-1.5 rounded font-medium hover:opacity-80 transition-opacity"
						style={{ backgroundColor: theme.colors.accent, color: '#fff' }}
						onClick={() => onConfirm(ruleText.trim(), archiveSource)}
						disabled={!ruleText.trim()}
					>
						Promote
					</button>
				</div>
			</div>
		</div>
	);
}

// ─── Scope Confirmation Dialog ───────────────────────────────────────────────

interface ScopeConfirmDialogProps {
	direction: 'to-global' | 'to-project';
	theme: Theme;
	onConfirm: (keepCopy: boolean) => void;
	onClose: () => void;
}

export function ScopeConfirmDialog({
	direction,
	theme,
	onConfirm,
	onClose,
}: ScopeConfirmDialogProps) {
	const [keepCopy, setKeepCopy] = useState(false);

	const isToGlobal = direction === 'to-global';
	const title = isToGlobal ? 'Promote to Global Scope' : 'Narrow to Project Scope';
	const description = isToGlobal
		? 'This memory will be available across all projects.'
		: 'This memory will be scoped to the current project.';

	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center"
			style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}
			onClick={onClose}
		>
			<div
				className="rounded-lg border shadow-xl p-4 max-w-sm w-full space-y-3"
				style={{
					backgroundColor: theme.colors.bgSidebar,
					borderColor: theme.colors.border,
				}}
				onClick={(e) => e.stopPropagation()}
			>
				<div className="flex items-center gap-2">
					{isToGlobal ? (
						<Globe className="w-4 h-4" style={{ color: theme.colors.accent }} />
					) : (
						<FolderInput className="w-4 h-4" style={{ color: theme.colors.accent }} />
					)}
					<span className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
						{title}
					</span>
				</div>

				<div className="text-xs" style={{ color: theme.colors.textDim }}>
					{description}
				</div>

				{isToGlobal && (
					<label
						className="flex items-center gap-2 text-xs cursor-pointer"
						style={{ color: theme.colors.textDim }}
					>
						<input
							type="checkbox"
							checked={keepCopy}
							onChange={(e) => setKeepCopy(e.target.checked)}
							className="accent-current"
							style={{ accentColor: theme.colors.accent }}
						/>
						Keep a copy in the current scope
					</label>
				)}

				<div className="flex justify-end gap-2 pt-1">
					<button
						className="text-xs px-3 py-1.5 rounded hover:opacity-80 transition-opacity"
						style={{ color: theme.colors.textDim }}
						onClick={onClose}
					>
						Cancel
					</button>
					<button
						className="text-xs px-3 py-1.5 rounded font-medium hover:opacity-80 transition-opacity"
						style={{ backgroundColor: theme.colors.accent, color: '#fff' }}
						onClick={() => onConfirm(keepCopy)}
					>
						{isToGlobal ? 'Promote' : 'Move'}
					</button>
				</div>
			</div>
		</div>
	);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Convert experience text to imperative voice for rule suggestion */
function toImperative(text: string): string {
	const trimmed = text.trim();
	// If it already starts with an imperative verb, return as-is
	const imperativeRe =
		/^(always|never|use|avoid|prefer|ensure|make|keep|do|don't|dont|follow|apply|run|check|require|enforce)\b/i;
	if (imperativeRe.test(trimmed)) return trimmed;

	// Strip common experience prefixes
	const cleaned = trimmed
		.replace(/^(I learned that|we found that|it turned out that|discovered that)\s+/i, '')
		.replace(/^(when|if)\s+.+?,\s*/i, '');

	// Capitalize first letter
	return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}
