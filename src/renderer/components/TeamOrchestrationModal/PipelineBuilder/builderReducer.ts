/**
 * Pure reducer for Pipeline Builder canvas state.
 *
 * Single source of truth for all builder mutations.
 * Every case returns a new BuilderState object.
 */

import type { BuilderState, BuilderAction } from './builderTypes';
import { snapToGrid } from './builderTypes';

export const INITIAL_BUILDER_STATE: BuilderState = {
	nodes: [],
	edges: [],
	roles: {},
	selectedNodeId: null,
	selectedEdgeId: null,
	viewport: { x: 0, y: 0, zoom: 1 },
	templateMeta: { name: '', description: '', category: 'user' },
	dirty: false,
};

export function builderReducer(state: BuilderState, action: BuilderAction): BuilderState {
	switch (action.type) {
		case 'ADD_NODE': {
			return {
				...state,
				nodes: [...state.nodes, action.node],
				roles: { ...state.roles, [action.node.roleId]: action.role },
				selectedNodeId: action.node.id,
				selectedEdgeId: null,
				dirty: true,
			};
		}

		case 'MOVE_NODE': {
			const x = snapToGrid(action.x);
			const y = snapToGrid(action.y);
			return {
				...state,
				nodes: state.nodes.map((n) => (n.id === action.nodeId ? { ...n, x, y } : n)),
				dirty: true,
			};
		}

		case 'DELETE_NODE': {
			const node = state.nodes.find((n) => n.id === action.nodeId);
			if (!node) return state;

			// Remove node, associated edges, and role entry
			const newEdges = state.edges.filter(
				(e) => e.sourceNodeId !== action.nodeId && e.targetNodeId !== action.nodeId
			);
			const newRoles = { ...state.roles };
			// Only delete role if no other node references it
			const otherNodesWithRole = state.nodes.filter(
				(n) => n.id !== action.nodeId && n.roleId === node.roleId
			);
			if (otherNodesWithRole.length === 0) {
				delete newRoles[node.roleId];
			}

			return {
				...state,
				nodes: state.nodes.filter((n) => n.id !== action.nodeId),
				edges: newEdges,
				roles: newRoles,
				selectedNodeId: state.selectedNodeId === action.nodeId ? null : state.selectedNodeId,
				selectedEdgeId: null,
				dirty: true,
			};
		}

		case 'SELECT_NODE': {
			return {
				...state,
				selectedNodeId: action.nodeId,
				selectedEdgeId: null,
			};
		}

		case 'SELECT_EDGE': {
			return {
				...state,
				selectedEdgeId: action.edgeId,
				selectedNodeId: null,
			};
		}

		case 'ADD_EDGE': {
			// Prevent duplicate edges between same nodes
			const exists = state.edges.some(
				(e) =>
					e.sourceNodeId === action.edge.sourceNodeId && e.targetNodeId === action.edge.targetNodeId
			);
			if (exists) return state;

			return {
				...state,
				edges: [...state.edges, action.edge],
				selectedEdgeId: action.edge.id,
				selectedNodeId: null,
				dirty: true,
			};
		}

		case 'DELETE_EDGE': {
			return {
				...state,
				edges: state.edges.filter((e) => e.id !== action.edgeId),
				selectedEdgeId: state.selectedEdgeId === action.edgeId ? null : state.selectedEdgeId,
				dirty: true,
			};
		}

		case 'UPDATE_EDGE': {
			return {
				...state,
				edges: state.edges.map((e) =>
					e.id === action.edgeId
						? { ...e, edgeType: action.edgeType, condition: action.condition }
						: e
				),
				dirty: true,
			};
		}

		case 'UPDATE_ROLE': {
			return {
				...state,
				roles: { ...state.roles, [action.roleId]: action.role },
				dirty: true,
			};
		}

		case 'PAN_VIEWPORT': {
			return {
				...state,
				viewport: {
					...state.viewport,
					x: state.viewport.x + action.dx,
					y: state.viewport.y + action.dy,
				},
			};
		}

		case 'ZOOM_VIEWPORT': {
			const clampedZoom = Math.max(0.25, Math.min(3, action.zoom));
			// Zoom toward cursor: adjust viewport so the point under the cursor stays put
			const scale = clampedZoom / state.viewport.zoom;
			const newX = action.centerX - (action.centerX - state.viewport.x) * scale;
			const newY = action.centerY - (action.centerY - state.viewport.y) * scale;
			return {
				...state,
				viewport: { x: newX, y: newY, zoom: clampedZoom },
			};
		}

		case 'SET_TEMPLATE_META': {
			return {
				...state,
				templateMeta: { ...state.templateMeta, ...action.meta },
				dirty: true,
			};
		}

		case 'LOAD_STATE': {
			return action.state;
		}

		case 'LOAD_PRESET': {
			return {
				...state,
				nodes: action.nodes,
				edges: action.edges,
				roles: action.roles,
				selectedNodeId: null,
				selectedEdgeId: null,
				viewport: { x: 0, y: 0, zoom: 1 },
				dirty: true,
			};
		}

		case 'LAYOUT_NODES': {
			// Replace node positions from auto-layout while preserving everything else
			const posMap = new Map(action.nodes.map((n) => [n.id, { x: n.x, y: n.y }]));
			return {
				...state,
				nodes: state.nodes.map((n) => {
					const pos = posMap.get(n.id);
					return pos ? { ...n, x: pos.x, y: pos.y } : n;
				}),
				dirty: true,
			};
		}

		case 'CLEAR_SELECTION': {
			return {
				...state,
				selectedNodeId: null,
				selectedEdgeId: null,
			};
		}

		default:
			return state;
	}
}
