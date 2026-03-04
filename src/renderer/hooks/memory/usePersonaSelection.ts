import { useState, useCallback } from 'react';
import type { Persona } from '../../../shared/memory-types';

export interface MatchedPersona {
	personaId: string;
	personaName: string;
	roleName: string;
	description: string;
	systemPrompt: string;
	similarity: number;
}

export function usePersonaSelection() {
	const [matchedPersonas, setMatchedPersonas] = useState<MatchedPersona[]>([]);
	const [allPersonas, setAllPersonas] = useState<Persona[]>([]);
	const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
	const [isLoading, setIsLoading] = useState(false);
	const [isMemoryEnabled, setIsMemoryEnabled] = useState(true);

	const loadAllPersonas = useCallback(async () => {
		try {
			const result = await window.maestro.memory.persona.list();
			if (result.success && result.data) {
				setAllPersonas(result.data);
			}
		} catch {
			// Memory system unavailable
		}
	}, []);

	const matchPersonas = useCallback(
		async (query: string, agentType: string, projectPath?: string, autoSelectThreshold = 0.5) => {
			if (!query.trim()) return;
			setIsLoading(true);
			try {
				const result = await window.maestro.memory.matchPersonas(query, agentType, projectPath);
				if (result.success && result.data) {
					setMatchedPersonas(result.data);
					// Auto-select personas above threshold
					const autoSelected = new Set(
						result.data.filter((p) => p.similarity >= autoSelectThreshold).map((p) => p.personaId)
					);
					setSelectedIds(autoSelected);
					setIsMemoryEnabled(true);
				} else {
					setIsMemoryEnabled(false);
				}
			} catch {
				setIsMemoryEnabled(false);
			} finally {
				setIsLoading(false);
			}
		},
		[]
	);

	const togglePersona = useCallback((id: string) => {
		setSelectedIds((prev) => {
			const next = new Set(prev);
			if (next.has(id)) {
				next.delete(id);
			} else {
				next.add(id);
			}
			return next;
		});
	}, []);

	const resetSelection = useCallback(() => {
		setSelectedIds(new Set());
		setMatchedPersonas([]);
	}, []);

	return {
		matchedPersonas,
		allPersonas,
		selectedIds,
		selectedIdsArray: Array.from(selectedIds),
		isLoading,
		isMemoryEnabled,
		matchPersonas,
		loadAllPersonas,
		togglePersona,
		setSelectedIds,
		resetSelection,
	};
}
