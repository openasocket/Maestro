/**
 * useMemoryStore Hook
 *
 * Fetches and manages memories for a specific scope (skill area, project, or global).
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import type {
	MemoryEntry,
	MemoryScope,
	MemoryType,
	MemorySource,
	MemorySearchResult,
	SkillAreaId,
	ExperienceContext,
} from '../../../shared/memory-types';

export interface UseMemoryStoreReturn {
	memories: MemoryEntry[];
	loading: boolean;
	error: string | null;
	addMemory: (entry: {
		content: string;
		type?: MemoryType;
		tags?: string[];
		source?: MemorySource;
		confidence?: number;
		pinned?: boolean;
		experienceContext?: ExperienceContext;
		personaId?: string;
		roleId?: string;
	}) => Promise<void>;
	updateMemory: (
		id: string,
		updates: Partial<
			Pick<
				MemoryEntry,
				'content' | 'type' | 'tags' | 'confidence' | 'pinned' | 'active' | 'experienceContext'
			>
		>
	) => Promise<void>;
	deleteMemory: (id: string) => Promise<void>;
	searchMemories: (query: string, agentType: string) => Promise<MemorySearchResult[]>;
	refresh: () => void;
	exportLibrary: () => Promise<{
		memories: MemoryEntry[];
		exportedAt: number;
		scope: MemoryScope;
		skillAreaId?: SkillAreaId;
		projectPath?: string;
	}>;
	importLibrary: (json: {
		memories: Array<{
			content: string;
			type?: MemoryType;
			tags?: string[];
			confidence?: number;
			pinned?: boolean;
			experienceContext?: ExperienceContext;
		}>;
	}) => Promise<{ imported: number }>;
}

export function useMemoryStore(
	scope: MemoryScope,
	skillAreaId?: SkillAreaId,
	projectPath?: string | null
): UseMemoryStoreReturn {
	const [memories, setMemories] = useState<MemoryEntry[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const mountedRef = useRef(true);

	const resolvedProject = projectPath ?? undefined;

	const fetchMemories = useCallback(async () => {
		try {
			setLoading(true);
			setError(null);

			const res = await window.maestro.memory.list(scope, skillAreaId, resolvedProject);

			if (!mountedRef.current) return;

			if (!res.success) {
				setError(res.error);
				return;
			}

			setMemories(res.data);
		} catch (err) {
			if (mountedRef.current) {
				setError(err instanceof Error ? err.message : 'Failed to fetch memories');
			}
		} finally {
			if (mountedRef.current) {
				setLoading(false);
			}
		}
	}, [scope, skillAreaId, resolvedProject]);

	// Debounced refresh
	const refresh = useCallback(() => {
		if (refreshTimerRef.current) {
			clearTimeout(refreshTimerRef.current);
		}
		refreshTimerRef.current = setTimeout(() => {
			fetchMemories();
		}, 150);
	}, [fetchMemories]);

	// Fetch on mount and when scope/skillAreaId/projectPath change
	useEffect(() => {
		mountedRef.current = true;
		fetchMemories();
		return () => {
			mountedRef.current = false;
			if (refreshTimerRef.current) {
				clearTimeout(refreshTimerRef.current);
			}
		};
	}, [fetchMemories]);

	const addMemory = useCallback(
		async (entry: {
			content: string;
			type?: MemoryType;
			tags?: string[];
			source?: MemorySource;
			confidence?: number;
			pinned?: boolean;
			experienceContext?: ExperienceContext;
			personaId?: string;
			roleId?: string;
		}) => {
			const res = await window.maestro.memory.add(
				{
					...entry,
					scope,
					skillAreaId,
				},
				resolvedProject
			);
			if (!res.success) throw new Error(res.error);
			refresh();
		},
		[scope, skillAreaId, resolvedProject, refresh]
	);

	const updateMemory = useCallback(
		async (
			id: string,
			updates: Partial<
				Pick<
					MemoryEntry,
					'content' | 'type' | 'tags' | 'confidence' | 'pinned' | 'active' | 'experienceContext'
				>
			>
		) => {
			const res = await window.maestro.memory.update(
				id,
				updates,
				scope,
				skillAreaId,
				resolvedProject
			);
			if (!res.success) throw new Error(res.error);
			refresh();
		},
		[scope, skillAreaId, resolvedProject, refresh]
	);

	const deleteMemory = useCallback(
		async (id: string) => {
			const res = await window.maestro.memory.delete(id, scope, skillAreaId, resolvedProject);
			if (!res.success) throw new Error(res.error);
			refresh();
		},
		[scope, skillAreaId, resolvedProject, refresh]
	);

	const searchMemories = useCallback(
		async (query: string, agentType: string): Promise<MemorySearchResult[]> => {
			const res = await window.maestro.memory.search(query, agentType, resolvedProject);
			if (!res.success) throw new Error(res.error);
			return res.data;
		},
		[resolvedProject]
	);

	const exportLibrary = useCallback(async () => {
		const res = await window.maestro.memory.export(scope, skillAreaId, resolvedProject);
		if (!res.success) throw new Error(res.error);
		return res.data;
	}, [scope, skillAreaId, resolvedProject]);

	const importLibrary = useCallback(
		async (json: {
			memories: Array<{
				content: string;
				type?: MemoryType;
				tags?: string[];
				confidence?: number;
				pinned?: boolean;
				experienceContext?: ExperienceContext;
			}>;
		}) => {
			const res = await window.maestro.memory.import(json, scope, skillAreaId, resolvedProject);
			if (!res.success) throw new Error(res.error);
			refresh();
			return res.data;
		},
		[scope, skillAreaId, resolvedProject, refresh]
	);

	return {
		memories,
		loading,
		error,
		addMemory,
		updateMemory,
		deleteMemory,
		searchMemories,
		refresh,
		exportLibrary,
		importLibrary,
	};
}
