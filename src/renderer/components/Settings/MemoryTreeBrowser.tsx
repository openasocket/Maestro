/**
 * Memory Tree Browser
 *
 * Hierarchical tree view for navigating Role → Persona → Skill Area.
 * Each node is expandable/collapsible. Selected node determines which
 * memories are displayed in the adjacent panel.
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';
import {
	ChevronRight,
	ChevronDown,
	Plus,
	MoreHorizontal,
	Edit3,
	Trash2,
	Users,
	Folder,
	FolderOpen,
	Globe,
	Sparkles,
	Brain,
	Lightbulb,
} from 'lucide-react';
import type { Theme } from '../../types';
import type { UseMemoryHierarchyReturn } from '../../hooks/memory/useMemoryHierarchy';
import type { RoleId, PersonaId, SkillAreaId } from '../../../shared/memory-types';

// ─── Types ────────────────────────────────────────────────────────────────

export type TreeNode =
	| { type: 'role'; id: RoleId }
	| { type: 'persona'; id: PersonaId }
	| { type: 'skill'; id: SkillAreaId }
	| { type: 'project' }
	| { type: 'global' }
	| { type: 'all-experiences' };

function nodeKey(node: TreeNode): string {
	if (node.type === 'project') return '__project__';
	if (node.type === 'global') return '__global__';
	if (node.type === 'all-experiences') return '__all-experiences__';
	return `${node.type}:${'id' in node ? node.id : ''}`;
}

function nodesEqual(a: TreeNode | null, b: TreeNode | null): boolean {
	if (a === null || b === null) return a === b;
	return nodeKey(a) === nodeKey(b);
}

interface MemoryTreeBrowserProps {
	theme: Theme;
	hierarchy: UseMemoryHierarchyReturn;
	selectedNode: TreeNode | null;
	onSelectNode: (node: TreeNode) => void;
	/** Total experience count for the "All Experiences" node */
	totalExperienceCount?: number;
}

// ─── Inline Name Editor ───────────────────────────────────────────────────

function InlineNameEditor({
	initialValue,
	theme,
	onConfirm,
	onCancel,
	placeholder,
}: {
	initialValue: string;
	theme: Theme;
	onConfirm: (value: string) => void;
	onCancel: () => void;
	placeholder?: string;
}) {
	const [value, setValue] = useState(initialValue);
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		inputRef.current?.focus();
		inputRef.current?.select();
	}, []);

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === 'Enter') {
			e.preventDefault();
			if (value.trim()) onConfirm(value.trim());
		} else if (e.key === 'Escape') {
			e.preventDefault();
			onCancel();
		}
	};

	return (
		<input
			ref={inputRef}
			type="text"
			value={value}
			onChange={(e) => setValue(e.target.value)}
			onKeyDown={handleKeyDown}
			onBlur={() => {
				if (value.trim()) onConfirm(value.trim());
				else onCancel();
			}}
			placeholder={placeholder}
			className="w-full bg-transparent outline-none text-xs px-1 py-0.5 rounded"
			style={{
				color: theme.colors.textMain,
				borderBottom: `1px solid ${theme.colors.accent}`,
			}}
		/>
	);
}

// ─── Context Menu ─────────────────────────────────────────────────────────

function NodeContextMenu({
	theme,
	onEdit,
	onDelete,
	onClose,
}: {
	theme: Theme;
	onEdit: () => void;
	onDelete: () => void;
	onClose: () => void;
}) {
	const menuRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const handleClickOutside = (e: MouseEvent) => {
			if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
				onClose();
			}
		};
		document.addEventListener('mousedown', handleClickOutside);
		return () => document.removeEventListener('mousedown', handleClickOutside);
	}, [onClose]);

	return (
		<div
			ref={menuRef}
			className="absolute right-0 top-full mt-1 z-50 rounded-lg border shadow-lg py-1 min-w-[120px]"
			style={{
				backgroundColor: theme.colors.bgMain,
				borderColor: theme.colors.border,
			}}
		>
			<button
				className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left hover:opacity-80 transition-opacity"
				style={{ color: theme.colors.textMain }}
				onClick={(e) => {
					e.stopPropagation();
					onEdit();
				}}
			>
				<Edit3 className="w-3 h-3" />
				Rename
			</button>
			<button
				className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left hover:opacity-80 transition-opacity"
				style={{ color: theme.colors.error }}
				onClick={(e) => {
					e.stopPropagation();
					onDelete();
				}}
			>
				<Trash2 className="w-3 h-3" />
				Delete
			</button>
		</div>
	);
}

// ─── Main Component ───────────────────────────────────────────────────────

export function MemoryTreeBrowser({
	theme,
	hierarchy,
	selectedNode,
	onSelectNode,
	totalExperienceCount,
}: MemoryTreeBrowserProps): React.ReactElement {
	const { roles, personas, skillAreas } = hierarchy;

	// Collapsed state — stores keys of collapsed nodes (expanded by default)
	const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

	// Inline editing state
	const [editingNode, setEditingNode] = useState<string | null>(null);
	const [addingChild, setAddingChild] = useState<string | null>(null);

	// Context menu state
	const [menuOpen, setMenuOpen] = useState<string | null>(null);

	const toggleCollapse = useCallback((key: string) => {
		setCollapsed((prev) => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	}, []);

	// ─── CRUD Handlers ────────────────────────────────────────────────────

	const handleAddRole = useCallback(() => {
		setAddingChild('__new_role__');
	}, []);

	const handleConfirmAddRole = useCallback(
		async (name: string) => {
			try {
				await hierarchy.createRole(name, '');
			} catch {
				// Error handled by hierarchy hook
			}
			setAddingChild(null);
		},
		[hierarchy]
	);

	const handleAddPersona = useCallback((roleId: RoleId) => {
		setAddingChild(`role:${roleId}:new_persona`);
		// Ensure role is expanded
		setCollapsed((prev) => {
			const next = new Set(prev);
			next.delete(`role:${roleId}`);
			return next;
		});
	}, []);

	const handleConfirmAddPersona = useCallback(
		async (roleId: RoleId, name: string) => {
			try {
				await hierarchy.createPersona(roleId, name, '');
			} catch {
				// Error handled by hierarchy hook
			}
			setAddingChild(null);
		},
		[hierarchy]
	);

	const handleAddSkill = useCallback((personaId: PersonaId) => {
		setAddingChild(`persona:${personaId}:new_skill`);
		// Ensure persona is expanded
		setCollapsed((prev) => {
			const next = new Set(prev);
			next.delete(`persona:${personaId}`);
			return next;
		});
	}, []);

	const handleConfirmAddSkill = useCallback(
		async (personaId: PersonaId, name: string) => {
			try {
				await hierarchy.createSkillArea(personaId, name, '');
			} catch {
				// Error handled by hierarchy hook
			}
			setAddingChild(null);
		},
		[hierarchy]
	);

	const handleRename = useCallback(
		async (nodeType: string, id: string, newName: string) => {
			try {
				if (nodeType === 'role') {
					await hierarchy.updateRole(id, { name: newName });
				} else if (nodeType === 'persona') {
					await hierarchy.updatePersona(id, { name: newName });
				} else if (nodeType === 'skill') {
					await hierarchy.updateSkillArea(id, { name: newName });
				}
			} catch {
				// Error handled by hierarchy hook
			}
			setEditingNode(null);
		},
		[hierarchy]
	);

	const handleDelete = useCallback(
		async (nodeType: string, id: string) => {
			try {
				if (nodeType === 'role') {
					await hierarchy.deleteRole(id);
				} else if (nodeType === 'persona') {
					await hierarchy.deletePersona(id);
				} else if (nodeType === 'skill') {
					await hierarchy.deleteSkillArea(id);
				}
			} catch {
				// Error handled by hierarchy hook
			}
			setMenuOpen(null);
		},
		[hierarchy]
	);

	// ─── Render Helpers ───────────────────────────────────────────────────

	const getMemoryCount = useCallback((skillId: SkillAreaId): number | null => {
		// We don't have per-skill counts readily available from the hierarchy hook,
		// so we return null (the library panel shows actual counts)
		void skillId;
		return null;
	}, []);

	const getPersonasForRole = useCallback(
		(roleId: RoleId) => personas.filter((p) => p.roleId === roleId),
		[personas]
	);

	const getSkillsForPersona = useCallback(
		(personaId: PersonaId) => skillAreas.filter((s) => s.personaId === personaId),
		[skillAreas]
	);

	// ─── Empty State ──────────────────────────────────────────────────────

	if (roles.length === 0 && !hierarchy.loading) {
		return (
			<div className="flex flex-col items-center justify-center h-full gap-3 p-4">
				<Brain className="w-8 h-8 opacity-30" style={{ color: theme.colors.textDim }} />
				<div className="text-xs text-center" style={{ color: theme.colors.textDim }}>
					No roles defined yet.
					<br />
					Get started by seeding defaults or adding a role.
				</div>
				<div className="flex gap-2">
					<button
						className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors hover:opacity-80"
						style={{
							backgroundColor: theme.colors.accent,
							color: theme.colors.accentForeground,
						}}
						onClick={() => hierarchy.seedDefaults()}
					>
						<Sparkles className="w-3 h-3" />
						Seed Defaults
					</button>
					<button
						className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors hover:opacity-80"
						style={{
							borderColor: theme.colors.border,
							color: theme.colors.textMain,
						}}
						onClick={handleAddRole}
					>
						<Plus className="w-3 h-3" />
						Add Role
					</button>
				</div>
				{addingChild === '__new_role__' && (
					<div className="w-full px-2">
						<InlineNameEditor
							initialValue=""
							theme={theme}
							placeholder="Role name..."
							onConfirm={handleConfirmAddRole}
							onCancel={() => setAddingChild(null)}
						/>
					</div>
				)}
			</div>
		);
	}

	// ─── Tree Rendering ───────────────────────────────────────────────────

	return (
		<div className="flex flex-col h-full">
			{/* Header */}
			<div
				className="flex items-center justify-between px-3 py-2 border-b shrink-0"
				style={{ borderColor: theme.colors.border }}
			>
				<div className="text-xs font-bold" style={{ color: theme.colors.textMain }}>
					Hierarchy
				</div>
				<button
					className="p-1 rounded hover:opacity-80 transition-opacity"
					style={{ color: theme.colors.accent }}
					onClick={handleAddRole}
					title="Add Role"
				>
					<Plus className="w-3.5 h-3.5" />
				</button>
			</div>

			{/* Tree Content */}
			<div className="flex-1 overflow-y-auto scrollbar-thin py-1">
				{/* Add role inline editor */}
				{addingChild === '__new_role__' && (
					<div className="px-3 py-1">
						<InlineNameEditor
							initialValue=""
							theme={theme}
							placeholder="Role name..."
							onConfirm={handleConfirmAddRole}
							onCancel={() => setAddingChild(null)}
						/>
					</div>
				)}

				{/* Role nodes */}
				{roles.map((role) => {
					const roleKey = `role:${role.id}`;
					const isRoleCollapsed = collapsed.has(roleKey);
					const isRoleSelected = nodesEqual(selectedNode, { type: 'role', id: role.id });
					const rolePersonas = getPersonasForRole(role.id);

					return (
						<div key={role.id}>
							{/* Role row */}
							<div
								className="group flex items-center gap-1 px-2 py-1 cursor-pointer hover:opacity-90 transition-opacity"
								style={{
									backgroundColor: isRoleSelected ? `${theme.colors.accent}18` : 'transparent',
								}}
								onClick={() => onSelectNode({ type: 'role', id: role.id })}
							>
								<button
									className="p-0.5 shrink-0"
									style={{ color: theme.colors.textDim }}
									onClick={(e) => {
										e.stopPropagation();
										toggleCollapse(roleKey);
									}}
								>
									{isRoleCollapsed ? (
										<ChevronRight className="w-3 h-3" />
									) : (
										<ChevronDown className="w-3 h-3" />
									)}
								</button>

								{editingNode === roleKey ? (
									<InlineNameEditor
										initialValue={role.name}
										theme={theme}
										onConfirm={(name) => handleRename('role', role.id, name)}
										onCancel={() => setEditingNode(null)}
									/>
								) : (
									<span
										className="flex-1 text-xs font-semibold truncate"
										style={{ color: theme.colors.textMain }}
									>
										{role.name}
									</span>
								)}

								{/* Action buttons */}
								<div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
									<button
										className="p-0.5 rounded hover:opacity-80"
										style={{ color: theme.colors.textDim }}
										title="Add Persona"
										onClick={(e) => {
											e.stopPropagation();
											handleAddPersona(role.id);
										}}
									>
										<Plus className="w-3 h-3" />
									</button>
									<div className="relative">
										<button
											className="p-0.5 rounded hover:opacity-80"
											style={{ color: theme.colors.textDim }}
											onClick={(e) => {
												e.stopPropagation();
												setMenuOpen(menuOpen === roleKey ? null : roleKey);
											}}
										>
											<MoreHorizontal className="w-3 h-3" />
										</button>
										{menuOpen === roleKey && (
											<NodeContextMenu
												theme={theme}
												onEdit={() => {
													setMenuOpen(null);
													setEditingNode(roleKey);
												}}
												onDelete={() => handleDelete('role', role.id)}
												onClose={() => setMenuOpen(null)}
											/>
										)}
									</div>
								</div>
							</div>

							{/* Persona children */}
							{!isRoleCollapsed && (
								<>
									{rolePersonas.map((persona) => {
										const personaKey = `persona:${persona.id}`;
										const isPersonaCollapsed = collapsed.has(personaKey);
										const isPersonaSelected = nodesEqual(selectedNode, {
											type: 'persona',
											id: persona.id,
										});
										const personaSkills = getSkillsForPersona(persona.id);

										return (
											<div key={persona.id}>
												{/* Persona row */}
												<div
													className="group flex items-center gap-1 pl-6 pr-2 py-1 cursor-pointer hover:opacity-90 transition-opacity"
													style={{
														backgroundColor: isPersonaSelected
															? `${theme.colors.accent}18`
															: 'transparent',
													}}
													onClick={() =>
														onSelectNode({
															type: 'persona',
															id: persona.id,
														})
													}
												>
													<button
														className="p-0.5 shrink-0"
														style={{ color: theme.colors.textDim }}
														onClick={(e) => {
															e.stopPropagation();
															toggleCollapse(personaKey);
														}}
													>
														{isPersonaCollapsed ? (
															<ChevronRight className="w-3 h-3" />
														) : (
															<ChevronDown className="w-3 h-3" />
														)}
													</button>

													{editingNode === personaKey ? (
														<InlineNameEditor
															initialValue={persona.name}
															theme={theme}
															onConfirm={(name) => handleRename('persona', persona.id, name)}
															onCancel={() => setEditingNode(null)}
														/>
													) : (
														<span
															className="flex-1 text-xs truncate"
															style={{ color: theme.colors.textMain }}
														>
															{persona.name}
														</span>
													)}

													{/* Agent assignment indicators */}
													{persona.assignedAgents.length > 0 && (
														<span title={`Assigned to: ${persona.assignedAgents.join(', ')}`}>
															<Users
																className="w-3 h-3 shrink-0"
																style={{ color: theme.colors.textDim }}
															/>
														</span>
													)}

													{/* Action buttons */}
													<div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
														<button
															className="p-0.5 rounded hover:opacity-80"
															style={{ color: theme.colors.textDim }}
															title="Add Skill Area"
															onClick={(e) => {
																e.stopPropagation();
																handleAddSkill(persona.id);
															}}
														>
															<Plus className="w-3 h-3" />
														</button>
														<div className="relative">
															<button
																className="p-0.5 rounded hover:opacity-80"
																style={{ color: theme.colors.textDim }}
																onClick={(e) => {
																	e.stopPropagation();
																	setMenuOpen(menuOpen === personaKey ? null : personaKey);
																}}
															>
																<MoreHorizontal className="w-3 h-3" />
															</button>
															{menuOpen === personaKey && (
																<NodeContextMenu
																	theme={theme}
																	onEdit={() => {
																		setMenuOpen(null);
																		setEditingNode(personaKey);
																	}}
																	onDelete={() => handleDelete('persona', persona.id)}
																	onClose={() => setMenuOpen(null)}
																/>
															)}
														</div>
													</div>
												</div>

												{/* Skill area children */}
												{!isPersonaCollapsed && (
													<>
														{personaSkills.map((skill) => {
															const skillKey = `skill:${skill.id}`;
															const isSkillSelected = nodesEqual(selectedNode, {
																type: 'skill',
																id: skill.id,
															});
															const count = getMemoryCount(skill.id);

															return (
																<div
																	key={skill.id}
																	className="group flex items-center gap-1.5 pl-11 pr-2 py-1 cursor-pointer hover:opacity-90 transition-opacity"
																	style={{
																		backgroundColor: isSkillSelected
																			? `${theme.colors.accent}18`
																			: 'transparent',
																	}}
																	onClick={() =>
																		onSelectNode({
																			type: 'skill',
																			id: skill.id,
																		})
																	}
																>
																	{editingNode === skillKey ? (
																		<InlineNameEditor
																			initialValue={skill.name}
																			theme={theme}
																			onConfirm={(name) => handleRename('skill', skill.id, name)}
																			onCancel={() => setEditingNode(null)}
																		/>
																	) : (
																		<>
																			<span
																				className="flex-1 text-xs truncate"
																				style={{
																					color: theme.colors.textMain,
																				}}
																			>
																				{skill.name}
																			</span>
																			{count !== null && (
																				<span
																					className="text-[10px] px-1.5 py-0.5 rounded-full shrink-0"
																					style={{
																						backgroundColor: `${theme.colors.accent}20`,
																						color: theme.colors.accent,
																					}}
																				>
																					{count}
																				</span>
																			)}
																		</>
																	)}

																	{/* Action buttons */}
																	<div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
																		<div className="relative">
																			<button
																				className="p-0.5 rounded hover:opacity-80"
																				style={{
																					color: theme.colors.textDim,
																				}}
																				onClick={(e) => {
																					e.stopPropagation();
																					setMenuOpen(menuOpen === skillKey ? null : skillKey);
																				}}
																			>
																				<MoreHorizontal className="w-3 h-3" />
																			</button>
																			{menuOpen === skillKey && (
																				<NodeContextMenu
																					theme={theme}
																					onEdit={() => {
																						setMenuOpen(null);
																						setEditingNode(skillKey);
																					}}
																					onDelete={() => handleDelete('skill', skill.id)}
																					onClose={() => setMenuOpen(null)}
																				/>
																			)}
																		</div>
																	</div>
																</div>
															);
														})}

														{/* Add skill inline */}
														{addingChild === `persona:${persona.id}:new_skill` && (
															<div className="pl-11 pr-2 py-1">
																<InlineNameEditor
																	initialValue=""
																	theme={theme}
																	placeholder="Skill area name..."
																	onConfirm={(name) => handleConfirmAddSkill(persona.id, name)}
																	onCancel={() => setAddingChild(null)}
																/>
															</div>
														)}
													</>
												)}
											</div>
										);
									})}

									{/* Add persona inline */}
									{addingChild === `role:${role.id}:new_persona` && (
										<div className="pl-6 pr-2 py-1">
											<InlineNameEditor
												initialValue=""
												theme={theme}
												placeholder="Persona name..."
												onConfirm={(name) => handleConfirmAddPersona(role.id, name)}
												onCancel={() => setAddingChild(null)}
											/>
										</div>
									)}
								</>
							)}
						</div>
					);
				})}

				{/* Separator */}
				<div className="my-2 mx-3 border-t" style={{ borderColor: theme.colors.border }} />

				{/* All Experiences */}
				<div
					className="group flex items-center gap-1.5 px-2 py-1 cursor-pointer hover:opacity-90 transition-opacity"
					style={{
						backgroundColor: nodesEqual(selectedNode, { type: 'all-experiences' })
							? `${theme.colors.accent}18`
							: 'transparent',
					}}
					onClick={() => onSelectNode({ type: 'all-experiences' })}
				>
					<Lightbulb
						className="w-3.5 h-3.5 shrink-0"
						style={{
							color: nodesEqual(selectedNode, { type: 'all-experiences' })
								? theme.colors.warning
								: theme.colors.textDim,
						}}
					/>
					<span className="flex-1 text-xs font-medium" style={{ color: theme.colors.textMain }}>
						All Experiences
					</span>
					{totalExperienceCount !== undefined && totalExperienceCount > 0 && (
						<span
							className="text-[10px] px-1.5 py-0.5 rounded-full shrink-0"
							style={{
								backgroundColor: `${theme.colors.warning}20`,
								color: theme.colors.warning,
							}}
						>
							{totalExperienceCount}
						</span>
					)}
				</div>

				{/* Project Memories */}
				<div
					className="group flex items-center gap-1.5 px-2 py-1 cursor-pointer hover:opacity-90 transition-opacity"
					style={{
						backgroundColor: nodesEqual(selectedNode, { type: 'project' })
							? `${theme.colors.accent}18`
							: 'transparent',
					}}
					onClick={() => onSelectNode({ type: 'project' })}
				>
					{nodesEqual(selectedNode, { type: 'project' }) ? (
						<FolderOpen className="w-3.5 h-3.5 shrink-0" style={{ color: theme.colors.accent }} />
					) : (
						<Folder className="w-3.5 h-3.5 shrink-0" style={{ color: theme.colors.textDim }} />
					)}
					<span className="flex-1 text-xs font-medium" style={{ color: theme.colors.textMain }}>
						Project Memories
					</span>
				</div>

				{/* Global Memories */}
				<div
					className="group flex items-center gap-1.5 px-2 py-1 cursor-pointer hover:opacity-90 transition-opacity"
					style={{
						backgroundColor: nodesEqual(selectedNode, { type: 'global' })
							? `${theme.colors.accent}18`
							: 'transparent',
					}}
					onClick={() => onSelectNode({ type: 'global' })}
				>
					<Globe
						className="w-3.5 h-3.5 shrink-0"
						style={{
							color: nodesEqual(selectedNode, { type: 'global' })
								? theme.colors.accent
								: theme.colors.textDim,
						}}
					/>
					<span className="flex-1 text-xs font-medium" style={{ color: theme.colors.textMain }}>
						Global Memories
					</span>
				</div>
			</div>
		</div>
	);
}
