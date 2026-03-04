/**
 * MemoryEditModal - Modal for adding/editing a single memory entry.
 *
 * Supports both rule-type and experience-type memories with scope selection,
 * skill area dropdown grouped by persona, tags input, confidence slider,
 * and pinned checkbox.
 *
 * Handles rule→experience conversion with auto-population of situation/learning,
 * and supports adding experienceContext to rules without type conversion.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { Brain, Pin, Info } from 'lucide-react';
import type { Theme } from '../../types';
import type {
	MemoryEntry,
	MemoryType,
	MemoryScope,
	SkillAreaId,
	PersonaId,
	RoleId,
	ExperienceContext,
} from '../../../shared/memory-types';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { Modal, ModalFooter } from '../ui/Modal';

/** Common imperative verbs that indicate a prescriptive rule */
const IMPERATIVE_VERB_RE =
	/^(always|never|use|avoid|prefer|ensure|make|keep|do|don't|dont|follow|apply|run|check|require|enforce|validate|prevent|limit)\b/i;

/** Extract the first sentence from text, or up to 120 chars if no sentence boundary found */
function getFirstSentence(text: string): string {
	const trimmed = text.trim();
	const match = trimmed.match(/^[^.!?]+[.!?]/);
	return match ? match[0].trim() : trimmed.slice(0, 120);
}

export interface MemoryEditModalProps {
	theme: Theme;
	memory: MemoryEntry | null; // null = add mode
	defaultScope: MemoryScope;
	defaultSkillAreaId?: SkillAreaId;
	defaultPersonaId?: PersonaId;
	defaultRoleId?: RoleId;
	/** Available skill areas for the dropdown (from hierarchy) */
	availableSkills: { id: SkillAreaId; name: string; personaName: string }[];
	/** When true, show context fields even for rule type (for "Add Context" flow) */
	initialShowContext?: boolean;
	onSave: (data: {
		content: string;
		type: MemoryType;
		scope: MemoryScope;
		skillAreaId?: SkillAreaId;
		personaId?: PersonaId;
		roleId?: RoleId;
		tags: string[];
		confidence: number;
		pinned: boolean;
		experienceContext?: ExperienceContext;
	}) => Promise<void>;
	onClose: () => void;
}

export function MemoryEditModal({
	theme,
	memory,
	defaultScope,
	defaultSkillAreaId,
	defaultPersonaId,
	defaultRoleId,
	availableSkills,
	initialShowContext,
	onSave,
	onClose,
}: MemoryEditModalProps) {
	// Form state
	const [type, setType] = useState<MemoryType>(memory?.type ?? 'rule');
	const [content, setContent] = useState(memory?.content ?? '');
	const [scope, setScope] = useState<MemoryScope>(memory?.scope ?? defaultScope);
	const [skillAreaId, setSkillAreaId] = useState<SkillAreaId | undefined>(
		memory?.skillAreaId ?? defaultSkillAreaId
	);
	const [tags, setTags] = useState<string>(memory?.tags?.join(', ') ?? '');
	const [confidence, setConfidence] = useState(memory?.confidence ?? 0.8);
	const [pinned, setPinned] = useState(memory?.pinned ?? false);

	// Experience context fields
	const [situation, setSituation] = useState(memory?.experienceContext?.situation ?? '');
	const [learning, setLearning] = useState(memory?.experienceContext?.learning ?? '');

	// Show context fields for rules (via "Add Context" flow or existing context)
	const [showRuleContext, setShowRuleContext] = useState(
		initialShowContext ?? (memory?.type === 'rule' && !!memory?.experienceContext)
	);
	// Helper text shown during rule→experience conversion
	const [conversionHelper, setConversionHelper] = useState(false);

	// Whether context fields should be visible
	const showContextFields = type === 'experience' || showRuleContext;

	// UI state
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const contentRef = useRef<HTMLTextAreaElement>(null);

	// Focus content textarea on mount
	useEffect(() => {
		requestAnimationFrame(() => {
			contentRef.current?.focus();
		});
	}, []);

	// Group available skills by persona name
	const groupedSkills = availableSkills.reduce<Record<string, { id: SkillAreaId; name: string }[]>>(
		(acc, skill) => {
			if (!acc[skill.personaName]) {
				acc[skill.personaName] = [];
			}
			acc[skill.personaName].push({ id: skill.id, name: skill.name });
			return acc;
		},
		{}
	);

	// Handle type change with auto-population for rule→experience conversion
	const handleTypeChange = useCallback(
		(newType: MemoryType) => {
			const oldType = type;
			setType(newType);

			if (oldType === 'rule' && newType === 'experience') {
				// Auto-populate situation from content if empty
				if (!situation.trim() && content.trim()) {
					const firstSentence = getFirstSentence(content);
					if (IMPERATIVE_VERB_RE.test(content.trim())) {
						setSituation(`Observed pattern: ${firstSentence}`);
					} else {
						setSituation(firstSentence);
					}
				}
				// Auto-populate learning with full content if empty
				if (!learning.trim() && content.trim()) {
					setLearning(content.trim());
				}
				setConversionHelper(true);
				setShowRuleContext(false); // Not needed when type is experience
			} else {
				setConversionHelper(false);
			}
		},
		[type, content, situation, learning]
	);

	const isValid = content.trim().length > 0 && (scope !== 'skill' || skillAreaId);

	const handleSave = useCallback(async () => {
		if (!isValid) return;

		setSaving(true);
		setError(null);

		try {
			const parsedTags = tags
				.split(',')
				.map((t) => t.trim())
				.filter(Boolean);

			const data: Parameters<typeof onSave>[0] = {
				content: content.trim(),
				type,
				scope,
				tags: parsedTags,
				confidence,
				pinned,
			};

			if (scope === 'skill' && skillAreaId) {
				data.skillAreaId = skillAreaId;
				// Try to derive personaId/roleId from the hierarchy context
				if (defaultPersonaId) data.personaId = defaultPersonaId;
				if (defaultRoleId) data.roleId = defaultRoleId;
			}

			// Include experienceContext when type is experience, or when
			// context fields have content (rules with added context)
			const hasSituationOrLearning = situation.trim() || learning.trim();
			if (type === 'experience' || hasSituationOrLearning) {
				data.experienceContext = {
					situation: situation.trim(),
					learning: learning.trim(),
					// Preserve existing source metadata when editing
					...(memory?.experienceContext?.sourceSessionId && {
						sourceSessionId: memory.experienceContext.sourceSessionId,
					}),
					...(memory?.experienceContext?.sourceProjectPath && {
						sourceProjectPath: memory.experienceContext.sourceProjectPath,
					}),
					...(memory?.experienceContext?.sourceAgentType && {
						sourceAgentType: memory.experienceContext.sourceAgentType,
					}),
				};
			}

			await onSave(data);
			onClose();
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to save memory');
		} finally {
			setSaving(false);
		}
	}, [
		isValid,
		content,
		type,
		scope,
		skillAreaId,
		tags,
		confidence,
		pinned,
		situation,
		learning,
		memory,
		defaultPersonaId,
		defaultRoleId,
		availableSkills,
		onSave,
		onClose,
	]);

	const title = memory ? 'Edit Memory' : 'Add Memory';

	return (
		<Modal
			theme={theme}
			title={title}
			priority={MODAL_PRIORITIES.MEMORY_EDIT}
			onClose={onClose}
			width={520}
			headerIcon={<Brain className="w-4 h-4" style={{ color: theme.colors.accent }} />}
			footer={
				<ModalFooter
					theme={theme}
					onCancel={onClose}
					onConfirm={handleSave}
					confirmLabel={saving ? 'Saving...' : memory ? 'Update' : 'Add'}
					confirmDisabled={!isValid || saving}
				/>
			}
		>
			<div className="space-y-4">
				{/* Error */}
				{error && (
					<div
						className="p-3 rounded text-xs"
						style={{
							backgroundColor: `${theme.colors.error}15`,
							color: theme.colors.error,
						}}
					>
						{error}
					</div>
				)}

				{/* Type Selector */}
				<div>
					<label
						className="block text-xs font-bold opacity-70 uppercase mb-2"
						style={{ color: theme.colors.textMain }}
					>
						Type
					</label>
					<div className="flex gap-2">
						{(['rule', 'experience'] as MemoryType[]).map((t) => (
							<button
								key={t}
								type="button"
								onClick={() => handleTypeChange(t)}
								className="px-3 py-1.5 rounded border text-xs font-medium transition-colors"
								style={{
									borderColor: type === t ? theme.colors.accent : theme.colors.border,
									backgroundColor: type === t ? `${theme.colors.accent}15` : 'transparent',
									color: type === t ? theme.colors.accent : theme.colors.textMain,
								}}
							>
								{t === 'rule' ? 'Rule' : 'Experience'}
							</button>
						))}
					</div>
					<p className="text-xs mt-1" style={{ color: theme.colors.textDim }}>
						{type === 'rule'
							? 'Prescriptive: "always do X" — user-curated'
							: 'Empirical: "we learned Y when Z happened" — contextual'}
					</p>
					{conversionHelper && (
						<div
							className="flex items-center gap-2 mt-1.5 p-2 rounded text-xs"
							style={{
								backgroundColor: `${theme.colors.accent}10`,
								color: theme.colors.accent,
							}}
						>
							<Info className="w-3.5 h-3.5 shrink-0" />
							Converting to experience — fill in the context of when this was learned
						</div>
					)}
				</div>

				{/* Content */}
				<div>
					<label
						className="block text-xs font-bold opacity-70 uppercase mb-2"
						style={{ color: theme.colors.textMain }}
					>
						Content
					</label>
					<textarea
						ref={contentRef}
						value={content}
						onChange={(e) => setContent(e.target.value)}
						rows={5}
						className="w-full p-3 rounded border bg-transparent outline-none resize-y text-sm"
						style={{
							borderColor: theme.colors.border,
							color: theme.colors.textMain,
						}}
						placeholder={
							type === 'rule'
								? 'Always use structured error types instead of string errors...'
								: 'When refactoring the auth module, we discovered that...'
						}
					/>
				</div>

				{/* Experience Context Fields — shown for experiences, or rules with "Add Context" */}
				{showContextFields && (
					<div className="space-y-3">
						{type === 'rule' && showRuleContext && (
							<p className="text-xs" style={{ color: theme.colors.textDim }}>
								Adding provenance context to this rule — type remains &quot;rule&quot;
							</p>
						)}
						<div>
							<label
								className="block text-xs font-bold opacity-70 uppercase mb-2"
								style={{ color: theme.colors.textMain }}
							>
								Situation
							</label>
							<textarea
								value={situation}
								onChange={(e) => setSituation(e.target.value)}
								rows={2}
								className="w-full p-3 rounded border bg-transparent outline-none resize-y text-sm"
								style={{
									borderColor: theme.colors.border,
									color: theme.colors.textMain,
								}}
								placeholder="What happened — brief description of the context"
							/>
						</div>
						<div>
							<label
								className="block text-xs font-bold opacity-70 uppercase mb-2"
								style={{ color: theme.colors.textMain }}
							>
								Learning
							</label>
							<textarea
								value={learning}
								onChange={(e) => setLearning(e.target.value)}
								rows={2}
								className="w-full p-3 rounded border bg-transparent outline-none resize-y text-sm"
								style={{
									borderColor: theme.colors.border,
									color: theme.colors.textMain,
								}}
								placeholder="The discrete insight or teaching gained"
							/>
						</div>
					</div>
				)}

				{/* Scope Selector */}
				<div>
					<label
						className="block text-xs font-bold opacity-70 uppercase mb-2"
						style={{ color: theme.colors.textMain }}
					>
						Scope
					</label>
					<div className="flex gap-2">
						{(['skill', 'project', 'global'] as MemoryScope[]).map((s) => (
							<button
								key={s}
								type="button"
								onClick={() => setScope(s)}
								className="px-3 py-1.5 rounded border text-xs font-medium transition-colors"
								style={{
									borderColor: scope === s ? theme.colors.accent : theme.colors.border,
									backgroundColor: scope === s ? `${theme.colors.accent}15` : 'transparent',
									color: scope === s ? theme.colors.accent : theme.colors.textMain,
								}}
							>
								{s === 'skill' ? 'Skill Area' : s === 'project' ? 'Project' : 'Global'}
							</button>
						))}
					</div>
				</div>

				{/* Skill Area Dropdown */}
				{scope === 'skill' && (
					<div>
						<label
							className="block text-xs font-bold opacity-70 uppercase mb-2"
							style={{ color: theme.colors.textMain }}
						>
							Skill Area
						</label>
						<select
							value={skillAreaId ?? ''}
							onChange={(e) => setSkillAreaId(e.target.value || undefined)}
							className="w-full p-3 rounded border bg-transparent outline-none text-sm"
							style={{
								borderColor: !skillAreaId ? theme.colors.error : theme.colors.border,
								color: theme.colors.textMain,
								backgroundColor: theme.colors.bgSidebar,
							}}
						>
							<option value="">Select a skill area...</option>
							{Object.entries(groupedSkills).map(([personaName, skills]) => (
								<optgroup key={personaName} label={personaName}>
									{skills.map((skill) => (
										<option key={skill.id} value={skill.id}>
											{skill.name}
										</option>
									))}
								</optgroup>
							))}
						</select>
						{!skillAreaId && (
							<p className="text-xs mt-1" style={{ color: theme.colors.error }}>
								A skill area is required for skill-scoped memories
							</p>
						)}
					</div>
				)}

				{/* Tags Input */}
				<div>
					<label
						className="block text-xs font-bold opacity-70 uppercase mb-2"
						style={{ color: theme.colors.textMain }}
					>
						Tags
					</label>
					<input
						type="text"
						value={tags}
						onChange={(e) => setTags(e.target.value)}
						className="w-full p-3 rounded border bg-transparent outline-none text-sm"
						style={{
							borderColor: theme.colors.border,
							color: theme.colors.textMain,
						}}
						placeholder="error-handling, rust, async (comma-separated)"
					/>
				</div>

				{/* Confidence Slider */}
				<div className="flex items-center justify-between gap-4">
					<div className="flex-1 min-w-0">
						<div
							className="text-xs font-bold opacity-70 uppercase"
							style={{ color: theme.colors.textMain }}
						>
							Confidence
						</div>
						<div className="text-xs mt-0.5" style={{ color: theme.colors.textDim }}>
							Higher confidence memories are prioritized during injection
						</div>
					</div>
					<div className="flex items-center gap-2 shrink-0">
						<input
							type="range"
							min={0}
							max={1}
							step={0.05}
							value={confidence}
							onChange={(e) => setConfidence(Number(e.target.value))}
							className="w-24 h-1 rounded-full appearance-none cursor-pointer"
							style={{ accentColor: theme.colors.accent }}
						/>
						<span
							className="text-xs font-mono w-10 text-right"
							style={{ color: theme.colors.textMain }}
						>
							{confidence.toFixed(2)}
						</span>
					</div>
				</div>

				{/* Pinned Checkbox */}
				<button
					type="button"
					className="w-full flex items-center gap-3 py-2 text-left"
					onClick={() => setPinned(!pinned)}
				>
					<div
						className="w-4 h-4 rounded border flex items-center justify-center shrink-0"
						style={{
							borderColor: pinned ? theme.colors.accent : theme.colors.border,
							backgroundColor: pinned ? theme.colors.accent : 'transparent',
						}}
					>
						{pinned && <Pin className="w-2.5 h-2.5" style={{ color: '#fff' }} />}
					</div>
					<div className="flex-1 min-w-0">
						<div className="text-xs font-medium" style={{ color: theme.colors.textMain }}>
							Pinned
						</div>
						<div className="text-xs" style={{ color: theme.colors.textDim }}>
							Pinned memories skip pruning and confidence decay
						</div>
					</div>
				</button>
			</div>
		</Modal>
	);
}

export default MemoryEditModal;
