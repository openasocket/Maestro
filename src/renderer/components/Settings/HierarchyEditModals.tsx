/**
 * HierarchyEditModals - Role, Persona, and Skill Area create/edit modals.
 *
 * Three small modals in one file for managing the memory hierarchy entities.
 * All follow the same pattern: { theme, entity | null, onSave, onClose }.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { Users, User, Zap } from 'lucide-react';
import type { Theme } from '../../types';
import type { Role, Persona, SkillArea } from '../../../shared/memory-types';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { Modal, ModalFooter } from '../ui/Modal';

// ─── Agent options for persona assignment ──────────────────────────────────

const AGENT_OPTIONS = [
	{ id: 'claude-code', label: 'Claude Code' },
	{ id: 'codex', label: 'Codex' },
	{ id: 'opencode', label: 'OpenCode' },
	{ id: 'factory-droid', label: 'Factory Droid' },
] as const;

// ─── RoleEditModal ─────────────────────────────────────────────────────────

export interface RoleEditModalProps {
	theme: Theme;
	role: Role | null; // null = create mode
	onSave: (data: { name: string; description: string; systemPrompt: string }) => Promise<void>;
	onClose: () => void;
}

export function RoleEditModal({ theme, role, onSave, onClose }: RoleEditModalProps) {
	const [name, setName] = useState(role?.name ?? '');
	const [description, setDescription] = useState(role?.description ?? '');
	const [systemPrompt, setSystemPrompt] = useState(role?.systemPrompt ?? '');
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const nameRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		requestAnimationFrame(() => nameRef.current?.focus());
	}, []);

	const isValid = name.trim().length > 0;

	const handleSave = useCallback(async () => {
		if (!isValid) return;
		setSaving(true);
		setError(null);
		try {
			await onSave({
				name: name.trim(),
				description: description.trim(),
				systemPrompt: systemPrompt.trim(),
			});
			onClose();
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to save role');
		} finally {
			setSaving(false);
		}
	}, [isValid, name, description, systemPrompt, onSave, onClose]);

	return (
		<Modal
			theme={theme}
			title={role ? 'Edit Role' : 'Add Role'}
			priority={MODAL_PRIORITIES.HIERARCHY_EDIT}
			onClose={onClose}
			width={560}
			headerIcon={<Users className="w-4 h-4" style={{ color: theme.colors.accent }} />}
			footer={
				<ModalFooter
					theme={theme}
					onCancel={onClose}
					onConfirm={handleSave}
					confirmLabel={saving ? 'Saving...' : role ? 'Update' : 'Create'}
					confirmDisabled={!isValid || saving}
				/>
			}
		>
			<div className="space-y-4">
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

				<div>
					<label
						className="block text-xs font-bold opacity-70 uppercase mb-2"
						style={{ color: theme.colors.textMain }}
					>
						Name
					</label>
					<input
						ref={nameRef}
						type="text"
						value={name}
						onChange={(e) => setName(e.target.value)}
						className="w-full p-3 rounded border bg-transparent outline-none text-sm"
						style={{
							borderColor: theme.colors.border,
							color: theme.colors.textMain,
						}}
						placeholder="e.g. Software Developer"
					/>
				</div>

				<div>
					<label
						className="block text-xs font-bold opacity-70 uppercase mb-2"
						style={{ color: theme.colors.textMain }}
					>
						Description
					</label>
					<textarea
						value={description}
						onChange={(e) => setDescription(e.target.value)}
						rows={3}
						className="w-full p-3 rounded border bg-transparent outline-none resize-y text-sm"
						style={{
							borderColor: theme.colors.border,
							color: theme.colors.textMain,
						}}
						placeholder="What does this role cover?"
					/>
				</div>

				<div>
					<label
						className="block text-xs font-bold opacity-70 uppercase mb-2"
						style={{ color: theme.colors.textMain }}
					>
						System Prompt
					</label>
					<p className="text-xs mb-2" style={{ color: theme.colors.textDim }}>
						Behavioral directive injected when this role is active.
					</p>
					<textarea
						value={systemPrompt}
						onChange={(e) => setSystemPrompt(e.target.value)}
						rows={8}
						className="w-full p-3 rounded border bg-transparent outline-none resize-y text-xs font-mono leading-relaxed"
						style={{
							borderColor: theme.colors.border,
							color: theme.colors.textMain,
						}}
						placeholder="You are operating as a..."
					/>
				</div>
			</div>
		</Modal>
	);
}

// ─── PersonaEditModal ──────────────────────────────────────────────────────

export interface PersonaEditModalProps {
	theme: Theme;
	persona: Persona | null; // null = create mode
	roleId: string;
	onSave: (data: {
		name: string;
		description: string;
		systemPrompt: string;
		assignedAgents: string[];
		assignedProjects: string[];
	}) => Promise<void>;
	onClose: () => void;
}

export function PersonaEditModal({
	theme,
	persona,
	roleId: _roleId,
	onSave,
	onClose,
}: PersonaEditModalProps) {
	const [name, setName] = useState(persona?.name ?? '');
	const [description, setDescription] = useState(persona?.description ?? '');
	const [systemPrompt, setSystemPrompt] = useState(persona?.systemPrompt ?? '');
	const [assignedAgents, setAssignedAgents] = useState<string[]>(persona?.assignedAgents ?? []);
	const [projectsText, setProjectsText] = useState((persona?.assignedProjects ?? []).join('\n'));
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const nameRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		requestAnimationFrame(() => nameRef.current?.focus());
	}, []);

	const isValid = name.trim().length > 0;

	const toggleAgent = (agentId: string) => {
		setAssignedAgents((prev) =>
			prev.includes(agentId) ? prev.filter((a) => a !== agentId) : [...prev, agentId]
		);
	};

	const handleSave = useCallback(async () => {
		if (!isValid) return;
		setSaving(true);
		setError(null);
		try {
			const assignedProjects = projectsText
				.split('\n')
				.map((p) => p.trim())
				.filter(Boolean);
			await onSave({
				name: name.trim(),
				description: description.trim(),
				systemPrompt: systemPrompt.trim(),
				assignedAgents,
				assignedProjects,
			});
			onClose();
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to save persona');
		} finally {
			setSaving(false);
		}
	}, [isValid, name, description, systemPrompt, assignedAgents, projectsText, onSave, onClose]);

	return (
		<Modal
			theme={theme}
			title={persona ? 'Edit Persona' : 'Add Persona'}
			priority={MODAL_PRIORITIES.HIERARCHY_EDIT}
			onClose={onClose}
			width={560}
			headerIcon={<User className="w-4 h-4" style={{ color: theme.colors.accent }} />}
			footer={
				<ModalFooter
					theme={theme}
					onCancel={onClose}
					onConfirm={handleSave}
					confirmLabel={saving ? 'Saving...' : persona ? 'Update' : 'Create'}
					confirmDisabled={!isValid || saving}
				/>
			}
		>
			<div className="space-y-4">
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

				<div>
					<label
						className="block text-xs font-bold opacity-70 uppercase mb-2"
						style={{ color: theme.colors.textMain }}
					>
						Name
					</label>
					<input
						ref={nameRef}
						type="text"
						value={name}
						onChange={(e) => setName(e.target.value)}
						className="w-full p-3 rounded border bg-transparent outline-none text-sm"
						style={{
							borderColor: theme.colors.border,
							color: theme.colors.textMain,
						}}
						placeholder="e.g. Rust Systems Developer"
					/>
				</div>

				<div>
					<label
						className="block text-xs font-bold opacity-70 uppercase mb-2"
						style={{ color: theme.colors.textMain }}
					>
						Description
					</label>
					<textarea
						value={description}
						onChange={(e) => setDescription(e.target.value)}
						rows={3}
						className="w-full p-3 rounded border bg-transparent outline-none resize-y text-sm"
						style={{
							borderColor: theme.colors.border,
							color: theme.colors.textMain,
						}}
						placeholder="Describe this persona's area of expertise"
					/>
				</div>

				<div>
					<label
						className="block text-xs font-bold opacity-70 uppercase mb-2"
						style={{ color: theme.colors.textMain }}
					>
						System Prompt
					</label>
					<p className="text-xs mb-2" style={{ color: theme.colors.textDim }}>
						Behavioral directive injected when this persona is active.
					</p>
					<textarea
						value={systemPrompt}
						onChange={(e) => setSystemPrompt(e.target.value)}
						rows={8}
						className="w-full p-3 rounded border bg-transparent outline-none resize-y text-xs font-mono leading-relaxed"
						style={{
							borderColor: theme.colors.border,
							color: theme.colors.textMain,
						}}
						placeholder="You are a specialized expert in..."
					/>
				</div>

				{/* Assigned Agents */}
				<div>
					<label
						className="block text-xs font-bold opacity-70 uppercase mb-2"
						style={{ color: theme.colors.textMain }}
					>
						Assigned Agents
					</label>
					<p className="text-xs mb-2" style={{ color: theme.colors.textDim }}>
						Leave unchecked to apply to all agents
					</p>
					<div className="space-y-1.5">
						{AGENT_OPTIONS.map((agent) => (
							<button
								key={agent.id}
								type="button"
								className="w-full flex items-center gap-3 py-1.5 px-2 rounded text-left hover:opacity-80"
								onClick={() => toggleAgent(agent.id)}
							>
								<div
									className="w-4 h-4 rounded border flex items-center justify-center shrink-0"
									style={{
										borderColor: assignedAgents.includes(agent.id)
											? theme.colors.accent
											: theme.colors.border,
										backgroundColor: assignedAgents.includes(agent.id)
											? theme.colors.accent
											: 'transparent',
									}}
								>
									{assignedAgents.includes(agent.id) && (
										<svg
											className="w-2.5 h-2.5"
											fill="none"
											viewBox="0 0 24 24"
											stroke="#fff"
											strokeWidth={3}
										>
											<path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
										</svg>
									)}
								</div>
								<span className="text-xs" style={{ color: theme.colors.textMain }}>
									{agent.label}
								</span>
							</button>
						))}
					</div>
				</div>

				{/* Assigned Projects */}
				<div>
					<label
						className="block text-xs font-bold opacity-70 uppercase mb-2"
						style={{ color: theme.colors.textMain }}
					>
						Assigned Projects
					</label>
					<p className="text-xs mb-2" style={{ color: theme.colors.textDim }}>
						One path per line. Leave empty to apply to all projects.
					</p>
					<textarea
						value={projectsText}
						onChange={(e) => setProjectsText(e.target.value)}
						rows={3}
						className="w-full p-3 rounded border bg-transparent outline-none resize-y text-xs font-mono"
						style={{
							borderColor: theme.colors.border,
							color: theme.colors.textMain,
						}}
						placeholder={'/home/user/project-a\n/home/user/project-b'}
					/>
				</div>
			</div>
		</Modal>
	);
}

// ─── SkillEditModal ────────────────────────────────────────────────────────

export interface SkillEditModalProps {
	theme: Theme;
	skill: SkillArea | null; // null = create mode
	personaId: string;
	onSave: (data: { name: string; description: string }) => Promise<void>;
	onClose: () => void;
}

export function SkillEditModal({
	theme,
	skill,
	personaId: _personaId,
	onSave,
	onClose,
}: SkillEditModalProps) {
	const [name, setName] = useState(skill?.name ?? '');
	const [description, setDescription] = useState(skill?.description ?? '');
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const nameRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		requestAnimationFrame(() => nameRef.current?.focus());
	}, []);

	const isValid = name.trim().length > 0;

	const handleSave = useCallback(async () => {
		if (!isValid) return;
		setSaving(true);
		setError(null);
		try {
			await onSave({ name: name.trim(), description: description.trim() });
			onClose();
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to save skill area');
		} finally {
			setSaving(false);
		}
	}, [isValid, name, description, onSave, onClose]);

	return (
		<Modal
			theme={theme}
			title={skill ? 'Edit Skill Area' : 'Add Skill Area'}
			priority={MODAL_PRIORITIES.HIERARCHY_EDIT}
			onClose={onClose}
			width={440}
			headerIcon={<Zap className="w-4 h-4" style={{ color: theme.colors.accent }} />}
			footer={
				<ModalFooter
					theme={theme}
					onCancel={onClose}
					onConfirm={handleSave}
					confirmLabel={saving ? 'Saving...' : skill ? 'Update' : 'Create'}
					confirmDisabled={!isValid || saving}
				/>
			}
		>
			<div className="space-y-4">
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

				<div>
					<label
						className="block text-xs font-bold opacity-70 uppercase mb-2"
						style={{ color: theme.colors.textMain }}
					>
						Name
					</label>
					<input
						ref={nameRef}
						type="text"
						value={name}
						onChange={(e) => setName(e.target.value)}
						className="w-full p-3 rounded border bg-transparent outline-none text-sm"
						style={{
							borderColor: theme.colors.border,
							color: theme.colors.textMain,
						}}
						placeholder="e.g. Error Handling"
					/>
				</div>

				<div>
					<label
						className="block text-xs font-bold opacity-70 uppercase mb-2"
						style={{ color: theme.colors.textMain }}
					>
						Description
					</label>
					<textarea
						value={description}
						onChange={(e) => setDescription(e.target.value)}
						rows={3}
						className="w-full p-3 rounded border bg-transparent outline-none resize-y text-sm"
						style={{
							borderColor: theme.colors.border,
							color: theme.colors.textMain,
						}}
						placeholder="Describe this skill domain"
					/>
				</div>
			</div>
		</Modal>
	);
}
