/**
 * Preset pattern generators for the Pipeline Builder.
 *
 * Each function returns a set of nodes, edges, and role definitions
 * that can be loaded onto the canvas via the LOAD_PRESET action.
 */

import type { TeamTemplateRole } from '../../../../shared/group-chat-types';
import type { BuilderNode, BuilderEdge } from './builderTypes';
import { NODE_WIDTH, NODE_HEIGHT } from './builderTypes';
import { generateId } from '../../../utils/ids';

export interface PresetResult {
	nodes: BuilderNode[];
	edges: BuilderEdge[];
	roles: Record<string, TeamTemplateRole>;
}

// ============================================================================
// Helpers
// ============================================================================

function makeNode(
	type: BuilderNode['type'],
	x: number,
	y: number,
	roleId?: string
): { node: BuilderNode; roleId: string } {
	const id = generateId();
	const rId = roleId ?? generateId();
	return {
		node: { id, roleId: rId, x, y, width: NODE_WIDTH, height: NODE_HEIGHT, type },
		roleId: rId,
	};
}

function makeRole(name: string, description: string): TeamTemplateRole {
	return {
		name,
		agentId: 'claude-code',
		description,
		systemPromptSuffix: '',
	};
}

function makeEdge(
	sourceNodeId: string,
	targetNodeId: string,
	edgeType: BuilderEdge['edgeType'],
	condition?: string
): BuilderEdge {
	return { id: generateId(), sourceNodeId, targetNodeId, edgeType, condition };
}

// ============================================================================
// Pipeline: Entry → Step 1 → Step 2 → Step 3 → Exit
// ============================================================================

export function createPipelinePreset(): PresetResult {
	const roles: Record<string, TeamTemplateRole> = {};

	const entry = makeNode('entry', 300, 0);
	roles[entry.roleId] = makeRole('Entry', 'Workflow start');

	const step1 = makeNode('role', 300, 80);
	roles[step1.roleId] = makeRole('Step 1', 'First pipeline stage');

	const step2 = makeNode('role', 300, 240);
	roles[step2.roleId] = makeRole('Step 2', 'Second pipeline stage');

	const step3 = makeNode('role', 300, 400);
	roles[step3.roleId] = makeRole('Step 3', 'Third pipeline stage');

	const exit = makeNode('exit', 300, 520);
	roles[exit.roleId] = makeRole('Exit', 'Workflow end');

	const nodes = [entry.node, step1.node, step2.node, step3.node, exit.node];
	const edges = [
		makeEdge(entry.node.id, step1.node.id, 'sequential'),
		makeEdge(step1.node.id, step2.node.id, 'sequential'),
		makeEdge(step2.node.id, step3.node.id, 'sequential'),
		makeEdge(step3.node.id, exit.node.id, 'sequential'),
	];

	return { nodes, edges, roles };
}

// ============================================================================
// Parallel + Merge: Entry → Worker A + Worker B → Merger → Exit
// ============================================================================

export function createParallelMergePreset(): PresetResult {
	const roles: Record<string, TeamTemplateRole> = {};

	const entry = makeNode('entry', 300, 60);
	roles[entry.roleId] = makeRole('Entry', 'Workflow start');

	const workerA = makeNode('role', 200, 200);
	roles[workerA.roleId] = makeRole('Worker A', 'Parallel worker A');

	const workerB = makeNode('role', 400, 200);
	roles[workerB.roleId] = makeRole('Worker B', 'Parallel worker B');

	const merger = makeNode('role', 300, 360);
	roles[merger.roleId] = makeRole('Merger', 'Merges parallel outputs');

	const exit = makeNode('exit', 300, 480);
	roles[exit.roleId] = makeRole('Exit', 'Workflow end');

	const nodes = [entry.node, workerA.node, workerB.node, merger.node, exit.node];
	const edges = [
		makeEdge(entry.node.id, workerA.node.id, 'parallel'),
		makeEdge(entry.node.id, workerB.node.id, 'parallel'),
		makeEdge(workerA.node.id, merger.node.id, 'sequential'),
		makeEdge(workerB.node.id, merger.node.id, 'sequential'),
		makeEdge(merger.node.id, exit.node.id, 'sequential'),
	];

	return { nodes, edges, roles };
}

// ============================================================================
// Review Loop: Entry → Implementer → Reviewer → Exit (with conditional back-edge)
// ============================================================================

export function createReviewLoopPreset(): PresetResult {
	const roles: Record<string, TeamTemplateRole> = {};

	const entry = makeNode('entry', 300, 40);
	roles[entry.roleId] = makeRole('Entry', 'Workflow start');

	const implementer = makeNode('role', 300, 160);
	roles[implementer.roleId] = makeRole('Implementer', 'Implements the solution');

	const reviewer = makeNode('role', 300, 320);
	roles[reviewer.roleId] = makeRole('Reviewer', 'Reviews the implementation');

	const exit = makeNode('exit', 300, 460);
	roles[exit.roleId] = makeRole('Exit', 'Workflow end');

	const nodes = [entry.node, implementer.node, reviewer.node, exit.node];
	const edges = [
		makeEdge(entry.node.id, implementer.node.id, 'sequential'),
		makeEdge(implementer.node.id, reviewer.node.id, 'sequential'),
		makeEdge(reviewer.node.id, exit.node.id, 'sequential'),
		makeEdge(reviewer.node.id, implementer.node.id, 'conditional', 'Needs revision'),
	];

	return { nodes, edges, roles };
}

// ============================================================================
// Hub & Spoke: Center Moderator + 3 surrounding spoke nodes
// ============================================================================

export function createHubSpokePreset(): PresetResult {
	const roles: Record<string, TeamTemplateRole> = {};

	const moderator = makeNode('role', 300, 250);
	roles[moderator.roleId] = makeRole('Moderator', 'Central coordinator');

	const spoke1 = makeNode('role', 150, 100);
	roles[spoke1.roleId] = makeRole('Specialist A', 'Domain specialist');

	const spoke2 = makeNode('role', 450, 100);
	roles[spoke2.roleId] = makeRole('Specialist B', 'Domain specialist');

	const spoke3 = makeNode('role', 300, 420);
	roles[spoke3.roleId] = makeRole('Specialist C', 'Domain specialist');

	const nodes = [moderator.node, spoke1.node, spoke2.node, spoke3.node];
	const edges = [
		makeEdge(moderator.node.id, spoke1.node.id, 'sequential'),
		makeEdge(spoke1.node.id, moderator.node.id, 'sequential'),
		makeEdge(moderator.node.id, spoke2.node.id, 'sequential'),
		makeEdge(spoke2.node.id, moderator.node.id, 'sequential'),
		makeEdge(moderator.node.id, spoke3.node.id, 'sequential'),
		makeEdge(spoke3.node.id, moderator.node.id, 'sequential'),
	];

	return { nodes, edges, roles };
}
