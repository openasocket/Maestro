/**
 * PersonaSelectionScreen.tsx
 *
 * Fourth screen of the onboarding wizard - persona selection.
 * Matches personas based on conversation context and lets the user
 * select which personas to activate for the new agent session.
 */

import { useEffect, useCallback, useState } from 'react';
import { Users, ArrowRight, SkipForward } from 'lucide-react';
import type { Theme } from '../../../types';
import { useWizard } from '../WizardContext';
import { PersonaPicker } from '../../PersonaPicker/PersonaPicker';
import type { Persona } from '../../../../shared/memory-types';

interface PersonaSelectionScreenProps {
	theme: Theme;
}

export function PersonaSelectionScreen({ theme }: PersonaSelectionScreenProps): React.ReactElement {
	const {
		state,
		nextStep,
		setSuggestedPersonas,
		toggleWizardPersona,
	} = useWizard();

	const [allPersonas, setAllPersonas] = useState<Persona[]>([]);
	const [isLoading, setIsLoading] = useState(false);
	const [isMemoryEnabled, setIsMemoryEnabled] = useState(true);

	// Load all personas and run matching on mount
	useEffect(() => {
		let cancelled = false;

		const loadAndMatch = async () => {
			setIsLoading(true);
			try {
				// Load all personas for browse
				const listResult = await window.maestro.memory.persona.list();
				if (!cancelled && listResult.success && listResult.data) {
					setAllPersonas(listResult.data);
				}

				// Run matching if not already done
				if (!state.personaSuggestionsLoaded) {
					const userMessages = state.conversationHistory
						.filter((m) => m.role === 'user')
						.map((m) => m.content)
						.join(' ');
					const matchQuery = [state.agentName || '', state.directoryPath || '', userMessages]
						.filter(Boolean)
						.join(' ')
						.slice(0, 2000);

					if (matchQuery.trim() && state.selectedAgent) {
						const result = await window.maestro.memory.matchPersonas(
							matchQuery,
							state.selectedAgent,
							state.directoryPath
						);
						if (!cancelled && result.success && result.data) {
							const autoSelected = result.data
								.filter((p) => p.similarity >= 0.5)
								.map((p) => p.personaId);
							setSuggestedPersonas(result.data, autoSelected);
						}
					}
				}
			} catch {
				if (!cancelled) setIsMemoryEnabled(false);
			} finally {
				if (!cancelled) setIsLoading(false);
			}
		};

		loadAndMatch();
		return () => { cancelled = true; };
	}, []);  

	const handleContinue = useCallback(() => {
		nextStep();
	}, [nextStep]);

	const selectedCount = state.selectedPersonaIds.length;
	const hasPersonas = state.suggestedPersonas.length > 0 || allPersonas.length > 0;

	return (
		<div className="flex flex-col flex-1 min-h-0" style={{ padding: '32px 40px' }}>
			{/* Header */}
			<div style={{ marginBottom: 24 }}>
				<div className="flex items-center gap-3 mb-2">
					<Users
						className="w-6 h-6"
						style={{ color: theme.colors.accent }}
					/>
					<h2
						className="text-xl font-bold"
						style={{ color: theme.colors.textMain }}
					>
						Select Personas
					</h2>
				</div>
				<p className="text-sm" style={{ color: theme.colors.textDim }}>
					Personas shape how your agent approaches tasks. Select the ones that match your project,
					or skip to use defaults.
				</p>
			</div>

			{/* Persona picker area */}
			<div
				className="flex-1 min-h-0 overflow-y-auto rounded-lg border p-4"
				style={{
					borderColor: theme.colors.border,
					backgroundColor: `${theme.colors.bgMain}80`,
				}}
			>
				<PersonaPicker
					theme={theme}
					matchedPersonas={state.suggestedPersonas}
					allPersonas={allPersonas}
					selectedIds={new Set(state.selectedPersonaIds)}
					onToggle={(id) => toggleWizardPersona(id)}
					isLoading={isLoading}
					isMemoryEnabled={isMemoryEnabled}
					mode="wizard"
				/>
			</div>

			{/* Footer with selection count + continue */}
			<div
				className="flex items-center justify-between pt-4 mt-4"
				style={{ borderTop: `1px solid ${theme.colors.border}` }}
			>
				<div className="text-sm" style={{ color: theme.colors.textDim }}>
					{isLoading
						? 'Matching personas...'
						: selectedCount > 0
							? `${selectedCount} persona${selectedCount !== 1 ? 's' : ''} selected`
							: hasPersonas
								? 'No personas selected'
								: 'No personas available'}
				</div>
				<div className="flex items-center gap-3">
					{hasPersonas && selectedCount === 0 && (
						<button
							onClick={handleContinue}
							className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors"
							style={{
								color: theme.colors.textDim,
								border: `1px solid ${theme.colors.border}`,
							}}
						>
							<SkipForward className="w-4 h-4" />
							Skip
						</button>
					)}
					<button
						onClick={handleContinue}
						className="flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-bold transition-all hover:scale-105"
						style={{
							backgroundColor: theme.colors.accent,
							color: theme.colors.bgMain,
							boxShadow: `0 4px 12px ${theme.colors.accent}40`,
						}}
					>
						Continue
						<ArrowRight className="w-4 h-4" />
					</button>
				</div>
			</div>
		</div>
	);
}
