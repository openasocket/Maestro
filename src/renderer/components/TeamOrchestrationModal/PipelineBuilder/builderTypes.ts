/**
 * Internal types for the Pipeline Builder canvas.
 *
 * These types represent the mutable, visual state of the builder
 * and are converted to/from TeamTemplate via builderSerializer.
 */

import type { TeamTemplateRole } from '../../../../shared/group-chat-types';

// ============================================================================
// Constants
// ============================================================================

/** Grid snap size in pixels */
export const GRID_SIZE = 20;

/** Default node dimensions */
export const NODE_WIDTH = 160;
export const NODE_HEIGHT = 60;

/** Port radius (connection points) */
export const PORT_RADIUS = 6;

/** Spacing for auto-layout */
export const LAYOUT_VERTICAL_SPACING = 200;
export const LAYOUT_HORIZONTAL_SPACING = 220;

// ============================================================================
// Node & Edge types
// ============================================================================

export type BuilderNodeType = 'role' | 'entry' | 'exit';

/** A positioned node on the canvas */
export interface BuilderNode {
	id: string;
	roleId: string;
	x: number;
	y: number;
	width: number;
	height: number;
	type: BuilderNodeType;
}

/** A connection between two nodes */
export interface BuilderEdge {
	id: string;
	sourceNodeId: string;
	targetNodeId: string;
	edgeType: 'sequential' | 'parallel' | 'conditional';
	condition?: string;
}

// ============================================================================
// Viewport
// ============================================================================

export interface Viewport {
	x: number;
	y: number;
	zoom: number;
}

// ============================================================================
// Builder state
// ============================================================================

export interface TemplateMeta {
	name: string;
	description: string;
	category: 'user' | 'exchange';
}

export interface BuilderState {
	nodes: BuilderNode[];
	edges: BuilderEdge[];
	roles: Record<string, TeamTemplateRole>;
	selectedNodeId: string | null;
	selectedEdgeId: string | null;
	viewport: Viewport;
	templateMeta: TemplateMeta;
	dirty: boolean;
}

// ============================================================================
// Actions (discriminated union)
// ============================================================================

export type BuilderAction =
	| { type: 'ADD_NODE'; node: BuilderNode; role: TeamTemplateRole }
	| { type: 'MOVE_NODE'; nodeId: string; x: number; y: number }
	| { type: 'DELETE_NODE'; nodeId: string }
	| { type: 'SELECT_NODE'; nodeId: string | null }
	| { type: 'SELECT_EDGE'; edgeId: string | null }
	| { type: 'ADD_EDGE'; edge: BuilderEdge }
	| { type: 'DELETE_EDGE'; edgeId: string }
	| { type: 'UPDATE_EDGE'; edgeId: string; edgeType: BuilderEdge['edgeType']; condition?: string }
	| { type: 'UPDATE_ROLE'; roleId: string; role: TeamTemplateRole }
	| { type: 'PAN_VIEWPORT'; dx: number; dy: number }
	| { type: 'ZOOM_VIEWPORT'; zoom: number; centerX: number; centerY: number }
	| { type: 'SET_TEMPLATE_META'; meta: Partial<TemplateMeta> }
	| { type: 'LOAD_STATE'; state: BuilderState }
	| {
			type: 'LOAD_PRESET';
			nodes: BuilderNode[];
			edges: BuilderEdge[];
			roles: Record<string, TeamTemplateRole>;
	  }
	| { type: 'CLEAR_SELECTION' };

// ============================================================================
// Helpers
// ============================================================================

/** Snap a value to the grid */
export function snapToGrid(value: number): number {
	return Math.round(value / GRID_SIZE) * GRID_SIZE;
}
