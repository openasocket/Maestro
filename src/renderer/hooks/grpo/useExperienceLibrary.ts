/**
 * useExperienceLibrary Hook
 *
 * Custom hook for managing the experience library for the current project.
 * Handles fetching entries via window.maestro.grpo.*, add/modify/delete,
 * import/export, and prune operations.
 *
 * Follows the useStats pattern: fetch on mount + refresh callback,
 * loading/error states, debounced refresh.
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import type { ExperienceEntry, ExperienceId } from '../../../shared/grpo-types';

export interface UseExperienceLibraryReturn {
	/** Current library entries */
	library: ExperienceEntry[];
	/** Loading state for initial fetch */
	loading: boolean;
	/** Error message if fetch failed */
	error: string | null;
	/** Add a new experience entry */
	addExperience: (entry: {
		content: string;
		category: string;
		agentType: string;
		scope: 'project' | 'global';
	}) => Promise<void>;
	/** Modify an existing experience entry */
	modifyExperience: (id: ExperienceId, updates: {
		content?: string;
		category?: string;
		agentType?: string;
	}) => Promise<void>;
	/** Delete an experience entry */
	deleteExperience: (id: ExperienceId) => Promise<void>;
	/** Manually trigger a data refresh */
	refresh: () => void;
	/** Export library as JSON string */
	exportLibrary: () => Promise<string>;
	/** Import library from JSON string, returns count of imported entries */
	importLibrary: (json: string) => Promise<number>;
	/** Prune stale entries, returns IDs of pruned entries */
	pruneLibrary: () => Promise<ExperienceId[]>;
}

/**
 * Hook for fetching and managing the experience library for the current project.
 *
 * @param projectPath - The project path to scope the library to, or null if unavailable
 * @returns Object containing library data, loading/error states, and mutation functions
 */
export function useExperienceLibrary(projectPath: string | null): UseExperienceLibraryReturn {
	const [library, setLibrary] = useState<ExperienceEntry[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const mountedRef = useRef(true);

	const fetchLibrary = useCallback(async () => {
		if (!projectPath) {
			setLibrary([]);
			setLoading(false);
			return;
		}

		setLoading(true);
		setError(null);

		try {
			const result = await window.maestro.grpo.getLibrary(projectPath);
			if (!mountedRef.current) return;

			if (result.success && result.data) {
				setLibrary(result.data as ExperienceEntry[]);
			} else {
				setError(result.error || 'Failed to load experience library');
			}
		} catch (err) {
			console.error('Failed to fetch experience library:', err);
			if (mountedRef.current) {
				setError(err instanceof Error ? err.message : 'Failed to load experience library');
			}
		} finally {
			if (mountedRef.current) {
				setLoading(false);
			}
		}
	}, [projectPath]);

	const refresh = useCallback(() => {
		fetchLibrary();
	}, [fetchLibrary]);

	// Initial fetch
	useEffect(() => {
		mountedRef.current = true;
		fetchLibrary();
		return () => {
			mountedRef.current = false;
		};
	}, [fetchLibrary]);

	const addExperience = useCallback(async (entry: {
		content: string;
		category: string;
		agentType: string;
		scope: 'project' | 'global';
	}) => {
		if (!projectPath) return;

		const result = await window.maestro.grpo.addExperience(projectPath, entry);
		if (!result.success) {
			throw new Error(result.error || 'Failed to add experience');
		}
		// Refresh to get updated library
		fetchLibrary();
	}, [projectPath, fetchLibrary]);

	const modifyExperience = useCallback(async (id: ExperienceId, updates: {
		content?: string;
		category?: string;
		agentType?: string;
	}) => {
		if (!projectPath) return;

		const result = await window.maestro.grpo.modifyExperience(projectPath, id, updates);
		if (!result.success) {
			throw new Error(result.error || 'Failed to modify experience');
		}
		fetchLibrary();
	}, [projectPath, fetchLibrary]);

	const deleteExperience = useCallback(async (id: ExperienceId) => {
		if (!projectPath) return;

		const result = await window.maestro.grpo.deleteExperience(projectPath, id);
		if (!result.success) {
			throw new Error(result.error || 'Failed to delete experience');
		}
		fetchLibrary();
	}, [projectPath, fetchLibrary]);

	const exportLibrary = useCallback(async (): Promise<string> => {
		if (!projectPath) return '[]';

		const result = await window.maestro.grpo.exportLibrary(projectPath);
		if (!result.success || !result.data) {
			throw new Error(result.error || 'Failed to export library');
		}
		return result.data;
	}, [projectPath]);

	const importLibrary = useCallback(async (json: string): Promise<number> => {
		if (!projectPath) return 0;

		const result = await window.maestro.grpo.importLibrary(projectPath, json);
		if (!result.success) {
			throw new Error(result.error || 'Failed to import library');
		}
		fetchLibrary();
		return result.data ?? 0;
	}, [projectPath, fetchLibrary]);

	const pruneLibrary = useCallback(async (): Promise<ExperienceId[]> => {
		if (!projectPath) return [];

		const result = await window.maestro.grpo.pruneLibrary(projectPath);
		if (!result.success) {
			throw new Error(result.error || 'Failed to prune library');
		}
		fetchLibrary();
		return (result.data ?? []) as ExperienceId[];
	}, [projectPath, fetchLibrary]);

	return useMemo(
		() => ({
			library,
			loading,
			error,
			addExperience,
			modifyExperience,
			deleteExperience,
			refresh,
			exportLibrary,
			importLibrary,
			pruneLibrary,
		}),
		[library, loading, error, addExperience, modifyExperience, deleteExperience, refresh, exportLibrary, importLibrary, pruneLibrary]
	);
}
