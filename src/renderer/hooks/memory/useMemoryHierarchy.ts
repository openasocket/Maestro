/**
 * useMemoryHierarchy Hook
 *
 * Fetches and manages the full hierarchy: roles, personas, skill areas.
 * Provides CRUD operations for all three levels.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import type {
	Role,
	Persona,
	SkillArea,
	RoleId,
	PersonaId,
	SkillAreaId,
} from '../../../shared/memory-types';

export interface UseMemoryHierarchyReturn {
	roles: Role[];
	personas: Persona[];
	skillAreas: SkillArea[];
	loading: boolean;
	error: string | null;
	// Role CRUD
	createRole: (name: string, description: string) => Promise<void>;
	updateRole: (id: RoleId, updates: { name?: string; description?: string }) => Promise<void>;
	deleteRole: (id: RoleId) => Promise<void>;
	// Persona CRUD
	createPersona: (
		roleId: RoleId,
		name: string,
		description: string,
		assignedAgents?: string[],
		assignedProjects?: string[]
	) => Promise<void>;
	updatePersona: (id: PersonaId, updates: Partial<Persona>) => Promise<void>;
	deletePersona: (id: PersonaId) => Promise<void>;
	// Skill Area CRUD
	createSkillArea: (personaId: PersonaId, name: string, description: string) => Promise<void>;
	updateSkillArea: (id: SkillAreaId, updates: Partial<SkillArea>) => Promise<void>;
	deleteSkillArea: (id: SkillAreaId) => Promise<void>;
	// Utility
	refresh: () => void;
	seedDefaults: () => Promise<void>;
}

export function useMemoryHierarchy(): UseMemoryHierarchyReturn {
	const [roles, setRoles] = useState<Role[]>([]);
	const [personas, setPersonas] = useState<Persona[]>([]);
	const [skillAreas, setSkillAreas] = useState<SkillArea[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	// Debounce refresh to avoid rapid successive fetches
	const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const mountedRef = useRef(true);

	const fetchAll = useCallback(async () => {
		try {
			setLoading(true);
			setError(null);

			const [rolesRes, personasRes, skillsRes] = await Promise.all([
				window.maestro.memory.role.list(),
				window.maestro.memory.persona.list(),
				window.maestro.memory.skill.list(),
			]);

			if (!mountedRef.current) return;

			if (!rolesRes.success) {
				setError(rolesRes.error);
				return;
			}
			if (!personasRes.success) {
				setError(personasRes.error);
				return;
			}
			if (!skillsRes.success) {
				setError(skillsRes.error);
				return;
			}

			setRoles(rolesRes.data);
			setPersonas(personasRes.data);
			setSkillAreas(skillsRes.data);
		} catch (err) {
			if (mountedRef.current) {
				setError(err instanceof Error ? err.message : 'Failed to fetch memory hierarchy');
			}
		} finally {
			if (mountedRef.current) {
				setLoading(false);
			}
		}
	}, []);

	// Debounced refresh
	const refresh = useCallback(() => {
		if (refreshTimerRef.current) {
			clearTimeout(refreshTimerRef.current);
		}
		refreshTimerRef.current = setTimeout(() => {
			fetchAll();
		}, 150);
	}, [fetchAll]);

	// Fetch on mount
	useEffect(() => {
		mountedRef.current = true;
		fetchAll();
		return () => {
			mountedRef.current = false;
			if (refreshTimerRef.current) {
				clearTimeout(refreshTimerRef.current);
			}
		};
	}, [fetchAll]);

	// ─── Role CRUD ────────────────────────────────────────────────────────────

	const createRole = useCallback(
		async (name: string, description: string) => {
			const res = await window.maestro.memory.role.create(name, description);
			if (!res.success) throw new Error(res.error);
			refresh();
		},
		[refresh]
	);

	const updateRole = useCallback(
		async (id: RoleId, updates: { name?: string; description?: string }) => {
			const res = await window.maestro.memory.role.update(id, updates);
			if (!res.success) throw new Error(res.error);
			refresh();
		},
		[refresh]
	);

	const deleteRole = useCallback(
		async (id: RoleId) => {
			const res = await window.maestro.memory.role.delete(id);
			if (!res.success) throw new Error(res.error);
			refresh();
		},
		[refresh]
	);

	// ─── Persona CRUD ─────────────────────────────────────────────────────────

	const createPersona = useCallback(
		async (
			roleId: RoleId,
			name: string,
			description: string,
			assignedAgents?: string[],
			assignedProjects?: string[]
		) => {
			const res = await window.maestro.memory.persona.create(
				roleId,
				name,
				description,
				assignedAgents,
				assignedProjects
			);
			if (!res.success) throw new Error(res.error);
			refresh();
		},
		[refresh]
	);

	const updatePersona = useCallback(
		async (id: PersonaId, updates: Partial<Persona>) => {
			const { name, description, assignedAgents, assignedProjects, active } = updates;
			const res = await window.maestro.memory.persona.update(id, {
				name,
				description,
				assignedAgents,
				assignedProjects,
				active,
			});
			if (!res.success) throw new Error(res.error);
			refresh();
		},
		[refresh]
	);

	const deletePersona = useCallback(
		async (id: PersonaId) => {
			const res = await window.maestro.memory.persona.delete(id);
			if (!res.success) throw new Error(res.error);
			refresh();
		},
		[refresh]
	);

	// ─── Skill Area CRUD ──────────────────────────────────────────────────────

	const createSkillArea = useCallback(
		async (personaId: PersonaId, name: string, description: string) => {
			const res = await window.maestro.memory.skill.create(personaId, name, description);
			if (!res.success) throw new Error(res.error);
			refresh();
		},
		[refresh]
	);

	const updateSkillArea = useCallback(
		async (id: SkillAreaId, updates: Partial<SkillArea>) => {
			const { name, description, active } = updates;
			const res = await window.maestro.memory.skill.update(id, { name, description, active });
			if (!res.success) throw new Error(res.error);
			refresh();
		},
		[refresh]
	);

	const deleteSkillArea = useCallback(
		async (id: SkillAreaId) => {
			const res = await window.maestro.memory.skill.delete(id);
			if (!res.success) throw new Error(res.error);
			refresh();
		},
		[refresh]
	);

	// ─── Utility ──────────────────────────────────────────────────────────────

	const seedDefaults = useCallback(async () => {
		const res = await window.maestro.memory.seedDefaults();
		if (!res.success) throw new Error(res.error);
		refresh();
	}, [refresh]);

	return {
		roles,
		personas,
		skillAreas,
		loading,
		error,
		createRole,
		updateRole,
		deleteRole,
		createPersona,
		updatePersona,
		deletePersona,
		createSkillArea,
		updateSkillArea,
		deleteSkillArea,
		refresh,
		seedDefaults,
	};
}
