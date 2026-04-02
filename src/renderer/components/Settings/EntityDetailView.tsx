/**
 * EntityDetailView — Editable detail panel for a selected role or persona.
 *
 * Replaces the empty "Select a skill area" state in the right panel
 * when a role or persona node is selected in the memory tree browser.
 * Shows name, description, system prompt, and (for personas) agent/project assignments.
 * Includes "Reset to Default" for seed-derived entities.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Save, RotateCcw, Users, User } from 'lucide-react';
import type { Theme } from '../../types';
import type { Role, Persona } from '../../../shared/memory-types';
import { isSeedRole, getSeedRole, isSeedPersona, getSeedPersona } from '../../utils/seedDefaults';

// ─── Agent options (same as HierarchyEditModals) ──────────────────────────

const AGENT_OPTIONS = [
	{ id: 'claude-code', label: 'Claude Code' },
	{ id: 'codex', label: 'Codex' },
	{ id: 'opencode', label: 'OpenCode' },
	{ id: 'factory-droid', label: 'Factory Droid' },
] as const;

// ─── Types ────────────────────────────────────────────────────────────────

interface RoleDetailViewProps {
	theme: Theme;
	role: Role;
	onSave: (
		id: string,
		updates: { name?: string; description?: string; systemPrompt?: string }
	) => Promise<void>;
}

interface PersonaDetailViewProps {
	theme: Theme;
	persona: Persona;
	parentRoleName: string;
	onSave: (id: string, updates: Partial<Persona>) => Promise<void>;
}

// ─── Shared field styles ──────────────────────────────────────────────────

function FieldLabel({ theme, children }: { theme: Theme; children: React.ReactNode }) {
	return (
		<label
			className="block text-xs font-bold opacity-70 uppercase mb-1.5"
			style={{ color: theme.colors.textMain }}
		>
			{children}
		</label>
	);
}

// ─── RoleDetailView ───────────────────────────────────────────────────────

export function RoleDetailView({ theme, role, onSave }: RoleDetailViewProps) {
	const [name, setName] = useState(role.name);
	const [description, setDescription] = useState(role.description);
	const [systemPrompt, setSystemPrompt] = useState(role.systemPrompt);
	const [saving, setSaving] = useState(false);
	const [confirmReset, setConfirmReset] = useState(false);
	const entityIdRef = useRef(role.id);

	// Reset local state when a different role is selected
	useEffect(() => {
		if (entityIdRef.current !== role.id) {
			entityIdRef.current = role.id;
			setConfirmReset(false);
		}
		setName(role.name);
		setDescription(role.description);
		setSystemPrompt(role.systemPrompt);
	}, [role]);

	const isDirty =
		name !== role.name || description !== role.description || systemPrompt !== role.systemPrompt;

	const isSeed = isSeedRole(role.name);

	const handleSave = useCallback(async () => {
		setSaving(true);
		try {
			await onSave(role.id, {
				name: name.trim(),
				description: description.trim(),
				systemPrompt: systemPrompt.trim(),
			});
		} finally {
			setSaving(false);
		}
	}, [role.id, name, description, systemPrompt, onSave]);

	const handleReset = useCallback(async () => {
		const seed = getSeedRole(role.name);
		if (!seed) return;
		setSaving(true);
		try {
			await onSave(role.id, {
				name: seed.name,
				description: seed.description,
				systemPrompt: seed.systemPrompt,
			});
			setConfirmReset(false);
		} finally {
			setSaving(false);
		}
	}, [role.id, role.name, onSave]);

	return (
		<div className="flex flex-col h-full">
			{/* Header */}
			<div
				className="shrink-0 px-4 py-3 border-b flex items-center justify-between"
				style={{ borderColor: theme.colors.border }}
			>
				<div className="flex items-center gap-2">
					<Users className="w-4 h-4" style={{ color: theme.colors.accent }} />
					<span className="text-xs font-bold" style={{ color: theme.colors.textMain }}>
						Role
					</span>
					{isSeed && (
						<span
							className="text-[10px] px-1.5 py-0.5 rounded-full"
							style={{ backgroundColor: `${theme.colors.accent}20`, color: theme.colors.accent }}
						>
							Seed Default
						</span>
					)}
				</div>
				<div className="flex items-center gap-1.5">
					{isSeed && (
						<button
							className="flex items-center gap-1 px-2 py-1 rounded text-xs transition-opacity hover:opacity-80"
							style={{ color: theme.colors.textDim }}
							onClick={() => (confirmReset ? handleReset() : setConfirmReset(true))}
							disabled={saving}
							title="Reset to default values from SEED_ROLES"
						>
							<RotateCcw className="w-3 h-3" />
							{confirmReset ? 'Confirm Reset' : 'Reset to Default'}
						</button>
					)}
					{confirmReset && (
						<button
							className="text-xs px-2 py-1 rounded transition-opacity hover:opacity-80"
							style={{ color: theme.colors.textDim }}
							onClick={() => setConfirmReset(false)}
						>
							Cancel
						</button>
					)}
				</div>
			</div>

			{/* Form */}
			<div className="flex-1 overflow-y-auto scrollbar-thin p-4 space-y-4">
				<div>
					<FieldLabel theme={theme}>Name</FieldLabel>
					<input
						type="text"
						value={name}
						onChange={(e) => setName(e.target.value)}
						className="w-full p-2.5 rounded border bg-transparent outline-none text-sm"
						style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
					/>
				</div>

				<div>
					<FieldLabel theme={theme}>Description</FieldLabel>
					<textarea
						value={description}
						onChange={(e) => setDescription(e.target.value)}
						rows={3}
						className="w-full p-2.5 rounded border bg-transparent outline-none resize-y text-sm"
						style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
					/>
				</div>

				<div>
					<FieldLabel theme={theme}>System Prompt</FieldLabel>
					<p className="text-xs mb-1.5" style={{ color: theme.colors.textDim }}>
						Behavioral directive injected when this role is active.
					</p>
					<textarea
						value={systemPrompt}
						onChange={(e) => setSystemPrompt(e.target.value)}
						rows={10}
						className="w-full p-2.5 rounded border bg-transparent outline-none resize-y text-xs font-mono leading-relaxed"
						style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
					/>
				</div>
			</div>

			{/* Footer */}
			{isDirty && (
				<div
					className="shrink-0 px-4 py-2.5 border-t flex items-center justify-end"
					style={{ borderColor: theme.colors.border }}
				>
					<button
						className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors hover:opacity-90"
						style={{
							backgroundColor: theme.colors.accent,
							color: theme.colors.accentForeground,
						}}
						onClick={handleSave}
						disabled={saving || !name.trim()}
					>
						<Save className="w-3 h-3" />
						{saving ? 'Saving...' : 'Save Changes'}
					</button>
				</div>
			)}
		</div>
	);
}

// ─── PersonaDetailView ────────────────────────────────────────────────────

export function PersonaDetailView({
	theme,
	persona,
	parentRoleName,
	onSave,
}: PersonaDetailViewProps) {
	const [name, setName] = useState(persona.name);
	const [description, setDescription] = useState(persona.description);
	const [systemPrompt, setSystemPrompt] = useState(persona.systemPrompt);
	const [assignedAgents, setAssignedAgents] = useState<string[]>(persona.assignedAgents);
	const [projectsText, setProjectsText] = useState(persona.assignedProjects.join('\n'));
	const [saving, setSaving] = useState(false);
	const [confirmReset, setConfirmReset] = useState(false);
	const entityIdRef = useRef(persona.id);

	// Reset local state when a different persona is selected
	useEffect(() => {
		if (entityIdRef.current !== persona.id) {
			entityIdRef.current = persona.id;
			setConfirmReset(false);
		}
		setName(persona.name);
		setDescription(persona.description);
		setSystemPrompt(persona.systemPrompt);
		setAssignedAgents(persona.assignedAgents);
		setProjectsText(persona.assignedProjects.join('\n'));
	}, [persona]);

	const isDirty =
		name !== persona.name ||
		description !== persona.description ||
		systemPrompt !== persona.systemPrompt ||
		JSON.stringify(assignedAgents.sort()) !== JSON.stringify([...persona.assignedAgents].sort()) ||
		projectsText !== persona.assignedProjects.join('\n');

	const isSeed = isSeedPersona(parentRoleName, persona.name);

	const toggleAgent = (agentId: string) => {
		setAssignedAgents((prev) =>
			prev.includes(agentId) ? prev.filter((a) => a !== agentId) : [...prev, agentId]
		);
	};

	const handleSave = useCallback(async () => {
		setSaving(true);
		try {
			const assignedProjects = projectsText
				.split('\n')
				.map((p) => p.trim())
				.filter(Boolean);
			await onSave(persona.id, {
				name: name.trim(),
				description: description.trim(),
				systemPrompt: systemPrompt.trim(),
				assignedAgents,
				assignedProjects,
			});
		} finally {
			setSaving(false);
		}
	}, [persona.id, name, description, systemPrompt, assignedAgents, projectsText, onSave]);

	const handleReset = useCallback(async () => {
		const seed = getSeedPersona(parentRoleName, persona.name);
		if (!seed) return;
		setSaving(true);
		try {
			await onSave(persona.id, {
				name: seed.name,
				description: seed.description,
				systemPrompt: seed.systemPrompt,
			});
			setConfirmReset(false);
		} finally {
			setSaving(false);
		}
	}, [persona.id, persona.name, parentRoleName, onSave]);

	return (
		<div className="flex flex-col h-full">
			{/* Header */}
			<div
				className="shrink-0 px-4 py-3 border-b flex items-center justify-between"
				style={{ borderColor: theme.colors.border }}
			>
				<div className="flex items-center gap-2">
					<User className="w-4 h-4" style={{ color: theme.colors.accent }} />
					<span className="text-xs" style={{ color: theme.colors.textDim }}>
						{parentRoleName} &gt;
					</span>
					<span className="text-xs font-bold" style={{ color: theme.colors.textMain }}>
						Persona
					</span>
					{isSeed && (
						<span
							className="text-[10px] px-1.5 py-0.5 rounded-full"
							style={{ backgroundColor: `${theme.colors.accent}20`, color: theme.colors.accent }}
						>
							Seed Default
						</span>
					)}
				</div>
				<div className="flex items-center gap-1.5">
					{isSeed && (
						<button
							className="flex items-center gap-1 px-2 py-1 rounded text-xs transition-opacity hover:opacity-80"
							style={{ color: theme.colors.textDim }}
							onClick={() => (confirmReset ? handleReset() : setConfirmReset(true))}
							disabled={saving}
							title="Reset to default values from SEED_ROLES"
						>
							<RotateCcw className="w-3 h-3" />
							{confirmReset ? 'Confirm Reset' : 'Reset to Default'}
						</button>
					)}
					{confirmReset && (
						<button
							className="text-xs px-2 py-1 rounded transition-opacity hover:opacity-80"
							style={{ color: theme.colors.textDim }}
							onClick={() => setConfirmReset(false)}
						>
							Cancel
						</button>
					)}
				</div>
			</div>

			{/* Form */}
			<div className="flex-1 overflow-y-auto scrollbar-thin p-4 space-y-4">
				<div>
					<FieldLabel theme={theme}>Name</FieldLabel>
					<input
						type="text"
						value={name}
						onChange={(e) => setName(e.target.value)}
						className="w-full p-2.5 rounded border bg-transparent outline-none text-sm"
						style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
					/>
				</div>

				<div>
					<FieldLabel theme={theme}>Description</FieldLabel>
					<textarea
						value={description}
						onChange={(e) => setDescription(e.target.value)}
						rows={3}
						className="w-full p-2.5 rounded border bg-transparent outline-none resize-y text-sm"
						style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
					/>
				</div>

				<div>
					<FieldLabel theme={theme}>System Prompt</FieldLabel>
					<p className="text-xs mb-1.5" style={{ color: theme.colors.textDim }}>
						Behavioral directive injected when this persona is active.
					</p>
					<textarea
						value={systemPrompt}
						onChange={(e) => setSystemPrompt(e.target.value)}
						rows={10}
						className="w-full p-2.5 rounded border bg-transparent outline-none resize-y text-xs font-mono leading-relaxed"
						style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
					/>
				</div>

				{/* Assigned Agents */}
				<div>
					<FieldLabel theme={theme}>Assigned Agents</FieldLabel>
					<p className="text-xs mb-1.5" style={{ color: theme.colors.textDim }}>
						Leave unchecked to apply to all agents.
					</p>
					<div className="space-y-1">
						{AGENT_OPTIONS.map((agent) => (
							<button
								key={agent.id}
								type="button"
								className="w-full flex items-center gap-2.5 py-1.5 px-2 rounded text-left hover:opacity-80"
								onClick={() => toggleAgent(agent.id)}
							>
								<div
									className="w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0"
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
											className="w-2 h-2"
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
					<FieldLabel theme={theme}>Assigned Projects</FieldLabel>
					<p className="text-xs mb-1.5" style={{ color: theme.colors.textDim }}>
						One path per line. Leave empty to apply to all projects.
					</p>
					<textarea
						value={projectsText}
						onChange={(e) => setProjectsText(e.target.value)}
						rows={3}
						className="w-full p-2.5 rounded border bg-transparent outline-none resize-y text-xs font-mono"
						style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
						placeholder={'/home/user/project-a\n/home/user/project-b'}
					/>
				</div>
			</div>

			{/* Footer */}
			{isDirty && (
				<div
					className="shrink-0 px-4 py-2.5 border-t flex items-center justify-end"
					style={{ borderColor: theme.colors.border }}
				>
					<button
						className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors hover:opacity-90"
						style={{
							backgroundColor: theme.colors.accent,
							color: theme.colors.accentForeground,
						}}
						onClick={handleSave}
						disabled={saving || !name.trim()}
					>
						<Save className="w-3 h-3" />
						{saving ? 'Saving...' : 'Save Changes'}
					</button>
				</div>
			)}
		</div>
	);
}
