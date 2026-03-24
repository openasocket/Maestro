/**
 * useBuilderHistory — Wraps the builder reducer with undo/redo history tracking.
 *
 * Maintains past/present/future stacks. Non-mutating actions (selection, viewport)
 * are excluded from history. History is capped at 50 entries.
 */

import { useReducer, useCallback, useMemo } from 'react';
import type { BuilderState, BuilderAction } from './builderTypes';
import { builderReducer, INITIAL_BUILDER_STATE } from './builderReducer';

const HISTORY_LIMIT = 50;

/** Actions that do NOT push onto the undo stack */
const NON_HISTORY_ACTIONS = new Set<string>([
	'SELECT_NODE',
	'SELECT_EDGE',
	'PAN_VIEWPORT',
	'ZOOM_VIEWPORT',
	'CLEAR_SELECTION',
	'LOAD_STATE', // Used for initialization and viewport manipulation
]);

interface HistoryState {
	past: BuilderState[];
	present: BuilderState;
	future: BuilderState[];
}

type HistoryAction =
	| { type: 'UNDO' }
	| { type: 'REDO' }
	| { type: 'DISPATCH'; action: BuilderAction };

function historyReducer(historyState: HistoryState, historyAction: HistoryAction): HistoryState {
	switch (historyAction.type) {
		case 'UNDO': {
			if (historyState.past.length === 0) return historyState;
			const previous = historyState.past[historyState.past.length - 1];
			return {
				past: historyState.past.slice(0, -1),
				present: {
					...previous,
					// Preserve viewport and clear selection on undo
					viewport: historyState.present.viewport,
					selectedNodeId: null,
					selectedEdgeId: null,
				},
				future: [historyState.present, ...historyState.future],
			};
		}

		case 'REDO': {
			if (historyState.future.length === 0) return historyState;
			const next = historyState.future[0];
			return {
				past: [...historyState.past, historyState.present],
				present: {
					...next,
					// Preserve viewport and clear selection on redo
					viewport: historyState.present.viewport,
					selectedNodeId: null,
					selectedEdgeId: null,
				},
				future: historyState.future.slice(1),
			};
		}

		case 'DISPATCH': {
			const { action } = historyAction;
			const newPresent = builderReducer(historyState.present, action);

			// No-op: reducer returned the same reference
			if (newPresent === historyState.present) return historyState;

			// Non-history action: update present without touching stacks
			if (NON_HISTORY_ACTIONS.has(action.type)) {
				return { ...historyState, present: newPresent };
			}

			// History-affecting action: push present onto past, clear future
			const newPast = [...historyState.past, historyState.present];
			if (newPast.length > HISTORY_LIMIT) {
				newPast.shift();
			}

			return {
				past: newPast,
				present: newPresent,
				future: [],
			};
		}

		default:
			return historyState;
	}
}

export interface BuilderHistoryControls {
	canUndo: boolean;
	canRedo: boolean;
	undo: () => void;
	redo: () => void;
	isDirty: boolean;
}

export function useBuilderHistory(): [
	BuilderState,
	React.Dispatch<BuilderAction>,
	BuilderHistoryControls,
] {
	const [historyState, historyDispatch] = useReducer(historyReducer, {
		past: [],
		present: INITIAL_BUILDER_STATE,
		future: [],
	});

	const dispatch = useCallback((action: BuilderAction) => {
		historyDispatch({ type: 'DISPATCH', action });
	}, []);

	const undo = useCallback(() => {
		historyDispatch({ type: 'UNDO' });
	}, []);

	const redo = useCallback(() => {
		historyDispatch({ type: 'REDO' });
	}, []);

	const controls = useMemo<BuilderHistoryControls>(
		() => ({
			canUndo: historyState.past.length > 0,
			canRedo: historyState.future.length > 0,
			undo,
			redo,
			isDirty: historyState.past.length > 0,
		}),
		[historyState.past.length, historyState.future.length, undo, redo]
	);

	return [historyState.present, dispatch, controls];
}
