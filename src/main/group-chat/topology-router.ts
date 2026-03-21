/**
 * @file topology-router.ts
 * @description Graph-based workflow routing engine for Group Chat.
 *
 * Determines agent activation order based on workflow topology patterns
 * (pipeline, parallel-then-merge, review-loop, custom) instead of the
 * default hub-spoke moderator routing.
 *
 * Designed to be usable from both Group Chat and the Teams orchestrator
 * (TEAMS-03) — no Group Chat-specific dependencies in core functions.
 */

import type {
	WorkflowTopology,
	WorkflowEdge,
	WorkflowExecutionState,
} from '../../shared/group-chat-types';

// ============================================================================
// EXECUTION STATE MANAGEMENT
// ============================================================================

/**
 * Initialize execution state for a topology when a workflow begins.
 * Sets the entry point as the first active node.
 *
 * @param topology - The workflow topology to initialize
 * @returns Fresh execution state ready for the first routing decision
 */
export function initExecutionState(topology: WorkflowTopology): WorkflowExecutionState {
	// Collect all unique role names from edges (excluding __entry__ and __exit__)
	const allNodes = new Set<string>();
	for (const edge of topology.edges) {
		if (edge.source !== '__entry__' && edge.source !== '__exit__') {
			allNodes.add(edge.source);
		}
		if (edge.target !== '__entry__' && edge.target !== '__exit__') {
			allNodes.add(edge.target);
		}
	}

	// Entry point is active, everything else is pending
	const pendingNodes = [...allNodes].filter((n) => n !== topology.entryPoint);

	return {
		currentPhase: topology.entryPoint,
		completedNodes: [],
		pendingNodes,
		activeNodes: [topology.entryPoint],
		iterationCount: 0,
		nodeOutputs: {},
		status: 'running',
	};
}

// ============================================================================
// ROUTING LOGIC
// ============================================================================

/**
 * Given a topology and execution state, determine which agents should be
 * activated next after a given node completes.
 *
 * @param topology - The workflow topology definition
 * @param executionState - Current execution state
 * @param completedNode - The node (role name) that just completed
 * @param moderatorDecision - For conditional edges, the moderator's chosen path
 * @returns Array of role names to activate next (may be empty if workflow is done)
 */
export function getNextNodes(
	topology: WorkflowTopology,
	executionState: WorkflowExecutionState,
	completedNode: string,
	moderatorDecision?: string
): string[] {
	switch (topology.pattern) {
		case 'pipeline':
			return getNextNodesPipeline(topology, completedNode);

		case 'parallel-then-merge':
			return getNextNodesParallelMerge(topology, executionState, completedNode);

		case 'review-loop':
			return getNextNodesReviewLoop(topology, executionState, completedNode, moderatorDecision);

		case 'custom':
			return getNextNodesCustom(topology, executionState, completedNode, moderatorDecision);

		case 'hub-spoke':
			// Hub-spoke doesn't use topology routing — return empty to fall back
			return [];

		default:
			return [];
	}
}

/**
 * Pipeline: After node A completes, activate the next node in the chain.
 */
function getNextNodesPipeline(topology: WorkflowTopology, completedNode: string): string[] {
	// Find outgoing edges from the completed node
	const outgoing = topology.edges.filter((e) => e.source === completedNode);

	// Filter out __exit__ targets — those signal workflow completion
	const nextNodes = outgoing.map((e) => e.target).filter((t) => t !== '__exit__');

	return nextNodes;
}

/**
 * Parallel-then-merge: After entry, activate all parallel nodes.
 * After ALL parallel nodes complete, activate the merger.
 */
function getNextNodesParallelMerge(
	topology: WorkflowTopology,
	executionState: WorkflowExecutionState,
	completedNode: string
): string[] {
	// If the entry point just completed, activate all parallel branches
	if (completedNode === topology.entryPoint) {
		const parallelTargets = topology.edges
			.filter((e) => e.source === topology.entryPoint && e.edgeType === 'parallel')
			.map((e) => e.target)
			.filter((t) => t !== '__exit__');
		return parallelTargets;
	}

	// Find all nodes that have parallel incoming edges from the entry point
	const parallelNodes = topology.edges
		.filter((e) => e.source === topology.entryPoint && e.edgeType === 'parallel')
		.map((e) => e.target)
		.filter((t) => t !== '__exit__');
	const parallelNodeSet = new Set(parallelNodes);

	// If the completed node is NOT a parallel node (i.e., it's the merger),
	// use pipeline logic for its outgoing edges
	if (!parallelNodeSet.has(completedNode)) {
		const outgoing = topology.edges.filter((e) => e.source === completedNode);
		return outgoing.map((e) => e.target).filter((t) => t !== '__exit__');
	}

	// Check if all parallel nodes have completed
	// Include the just-completed node in the completed set for this check
	const completedSet = new Set([...executionState.completedNodes, completedNode]);
	const allParallelDone = parallelNodes.every((n) => completedSet.has(n));

	if (allParallelDone) {
		// Find the merge target — nodes that receive edges from parallel nodes
		// but are not parallel nodes themselves
		const mergeTargets = new Set<string>();
		for (const edge of topology.edges) {
			if (
				parallelNodeSet.has(edge.source) &&
				!parallelNodeSet.has(edge.target) &&
				edge.target !== '__exit__'
			) {
				mergeTargets.add(edge.target);
			}
		}
		return [...mergeTargets];
	}

	// Not all parallel nodes done yet — wait
	return [];
}

/**
 * Review-loop: After reviewer completes, check for approval/rejection.
 * Approved → proceed to exit. Rejected → loop back to implementer.
 */
function getNextNodesReviewLoop(
	topology: WorkflowTopology,
	executionState: WorkflowExecutionState,
	completedNode: string,
	moderatorDecision?: string
): string[] {
	// Find outgoing edges from the completed node
	const outgoing = topology.edges.filter((e) => e.source === completedNode);

	// If there are no conditional edges, treat as simple pipeline
	const conditionalEdges = outgoing.filter((e) => e.edgeType === 'conditional');
	if (conditionalEdges.length === 0) {
		return outgoing.map((e) => e.target).filter((t) => t !== '__exit__');
	}

	// For conditional edges, use moderator decision to pick the path
	if (moderatorDecision) {
		const matchingEdge = conditionalEdges.find(
			(e) => e.condition && moderatorDecision.toLowerCase().includes(e.condition.toLowerCase())
		);
		if (matchingEdge && matchingEdge.target !== '__exit__') {
			return [matchingEdge.target];
		}
		// If decision matches an exit edge, return empty (workflow will complete)
		if (matchingEdge && matchingEdge.target === '__exit__') {
			return [];
		}
	}

	// Default: if no moderator decision or no match, check for approval keywords
	// in the node output as a fallback
	const nodeOutput = executionState.nodeOutputs[completedNode] || '';
	const approvalSignals = ['approved', 'lgtm', 'looks good', 'accepted', 'passed'];
	const isApproved = approvalSignals.some((signal) => nodeOutput.toLowerCase().includes(signal));

	if (isApproved) {
		// Find the exit/approval edge
		const approvalEdge = conditionalEdges.find(
			(e) => e.condition && /approv|accept|pass|lgtm/i.test(e.condition)
		);
		if (approvalEdge) {
			return approvalEdge.target === '__exit__' ? [] : [approvalEdge.target];
		}
		// No explicit approval edge — workflow is done
		return [];
	}

	// Rejection: find the rejection/loop-back edge
	const rejectionEdge = conditionalEdges.find(
		(e) => e.condition && /reject|fail|revise|loop/i.test(e.condition)
	);
	if (rejectionEdge && rejectionEdge.target !== '__exit__') {
		return [rejectionEdge.target];
	}

	// Fallback for non-conditional outgoing edges
	const nonConditional = outgoing.filter((e) => e.edgeType !== 'conditional');
	return nonConditional.map((e) => e.target).filter((t) => t !== '__exit__');
}

/**
 * Custom: Follow edges generically. For conditional edges, use moderator
 * decision to pick the path.
 */
function getNextNodesCustom(
	topology: WorkflowTopology,
	_executionState: WorkflowExecutionState,
	completedNode: string,
	moderatorDecision?: string
): string[] {
	const outgoing = topology.edges.filter((e) => e.source === completedNode);

	// Separate conditional and non-conditional edges
	const conditionalEdges = outgoing.filter((e) => e.edgeType === 'conditional');
	const nonConditionalEdges = outgoing.filter((e) => e.edgeType !== 'conditional');

	const nextNodes: string[] = [];

	// Add all non-conditional targets
	for (const edge of nonConditionalEdges) {
		if (edge.target !== '__exit__' && !nextNodes.includes(edge.target)) {
			nextNodes.push(edge.target);
		}
	}

	// For conditional edges, use moderator decision
	if (conditionalEdges.length > 0 && moderatorDecision) {
		const matchingEdge = conditionalEdges.find(
			(e) => e.condition && moderatorDecision.toLowerCase().includes(e.condition.toLowerCase())
		);
		if (
			matchingEdge &&
			matchingEdge.target !== '__exit__' &&
			!nextNodes.includes(matchingEdge.target)
		) {
			nextNodes.push(matchingEdge.target);
		}
	} else if (conditionalEdges.length > 0 && !moderatorDecision) {
		// No moderator decision — take the first conditional edge as default
		const firstTarget = conditionalEdges[0].target;
		if (firstTarget !== '__exit__' && !nextNodes.includes(firstTarget)) {
			nextNodes.push(firstTarget);
		}
	}

	return nextNodes;
}

// ============================================================================
// WORKFLOW COMPLETION CHECK
// ============================================================================

/**
 * Check if the workflow has reached a terminal state.
 * Terminal conditions:
 * - The exit point node has completed
 * - Max iterations reached (for loop patterns)
 * - All paths lead to __exit__
 *
 * @param topology - The workflow topology
 * @param executionState - Current execution state
 * @param maxIterations - Maximum allowed loop iterations
 * @returns True if the workflow should terminate
 */
export function isWorkflowComplete(
	topology: WorkflowTopology,
	executionState: WorkflowExecutionState,
	maxIterations: number
): boolean {
	// Already in a terminal status
	if (
		executionState.status === 'completed' ||
		executionState.status === 'failed' ||
		executionState.status === 'terminated'
	) {
		return true;
	}

	// Exit point has completed
	if (executionState.completedNodes.includes(topology.exitPoint)) {
		return true;
	}

	// Max iterations reached (for loop patterns)
	if (executionState.iterationCount >= maxIterations) {
		return true;
	}

	// No active nodes and no pending nodes — everything is done
	if (executionState.activeNodes.length === 0 && executionState.pendingNodes.length === 0) {
		return true;
	}

	return false;
}

// ============================================================================
// EXECUTION STATE UPDATE HELPERS
// ============================================================================

/**
 * Update execution state after a node completes.
 * Moves the node from active to completed, stores its output, and
 * activates the next nodes.
 *
 * @param executionState - Current state (will not be mutated)
 * @param completedNode - The node that just completed
 * @param output - The output produced by the node
 * @param nextNodes - Nodes to activate next
 * @param isLoop - Whether this transition is a loop-back (increments iterationCount)
 * @returns Updated execution state
 */
export function updateExecutionState(
	executionState: WorkflowExecutionState,
	completedNode: string,
	output: string,
	nextNodes: string[],
	isLoop: boolean = false
): WorkflowExecutionState {
	const completedNodes = executionState.completedNodes.includes(completedNode)
		? executionState.completedNodes
		: [...executionState.completedNodes, completedNode];

	const activeNodes = executionState.activeNodes
		.filter((n) => n !== completedNode)
		.concat(nextNodes.filter((n) => !executionState.activeNodes.includes(n)));

	const pendingNodes = executionState.pendingNodes.filter((n) => !nextNodes.includes(n));

	const currentPhase = nextNodes.length > 0 ? nextNodes[0] : completedNode;

	return {
		currentPhase,
		completedNodes,
		pendingNodes,
		activeNodes,
		iterationCount: isLoop ? executionState.iterationCount + 1 : executionState.iterationCount,
		nodeOutputs: {
			...executionState.nodeOutputs,
			[completedNode]: output,
		},
		status: executionState.status,
	};
}

/**
 * Mark the workflow as completed or terminated.
 *
 * @param executionState - Current state
 * @param status - Final status
 * @returns Updated execution state with terminal status
 */
export function finalizeWorkflow(
	executionState: WorkflowExecutionState,
	status: 'completed' | 'failed' | 'terminated'
): WorkflowExecutionState {
	return {
		...executionState,
		activeNodes: [],
		pendingNodes: [],
		status,
	};
}

// ============================================================================
// CONDITION EVALUATION PROMPT
// ============================================================================

/**
 * For conditional edges, format a decision prompt for the moderator
 * to evaluate which downstream path to take.
 *
 * @param edges - The conditional edges to choose between
 * @param nodeOutput - The output from the node that just completed
 * @returns A formatted prompt string for the moderator
 */
export function buildConditionEvalPrompt(edges: WorkflowEdge[], nodeOutput: string): string {
	const options = edges
		.filter((e) => e.condition)
		.map(
			(e, i) =>
				`${i + 1}. "${e.condition}" → route to ${e.target === '__exit__' ? 'workflow exit' : `@${e.target}`}`
		)
		.join('\n');

	return `## Routing Decision Required

The previous agent has completed their work. Based on their output, decide which path to take.

### Agent Output (summary):
${nodeOutput.substring(0, 1000)}${nodeOutput.length > 1000 ? '\n...(truncated)' : ''}

### Available Paths:
${options}

**Respond with ONLY the condition text that best matches the output.** For example, if the output indicates approval, respond with the approval condition text. Do not add any other text.`;
}

// ============================================================================
// TOPOLOGY VALIDATION
// ============================================================================

/**
 * Validate a workflow topology for common issues.
 *
 * @param topology - The topology to validate
 * @param roleNames - Available role names to validate against
 * @returns Array of validation warnings (empty if valid)
 */
export function validateTopology(topology: WorkflowTopology, roleNames: string[]): string[] {
	const warnings: string[] = [];
	const roleSet = new Set(roleNames);

	// Check entry point exists
	if (!roleSet.has(topology.entryPoint)) {
		warnings.push(`Entry point "${topology.entryPoint}" is not a known role`);
	}

	// Check exit point exists
	if (!roleSet.has(topology.exitPoint)) {
		warnings.push(`Exit point "${topology.exitPoint}" is not a known role`);
	}

	// Check all edge sources/targets are valid
	for (const edge of topology.edges) {
		if (edge.source !== '__entry__' && edge.source !== '__exit__' && !roleSet.has(edge.source)) {
			warnings.push(`Edge source "${edge.source}" is not a known role`);
		}
		if (edge.target !== '__entry__' && edge.target !== '__exit__' && !roleSet.has(edge.target)) {
			warnings.push(`Edge target "${edge.target}" is not a known role`);
		}
	}

	// Check for disconnected nodes (roles with no edges)
	const connectedNodes = new Set<string>();
	for (const edge of topology.edges) {
		if (edge.source !== '__entry__' && edge.source !== '__exit__') {
			connectedNodes.add(edge.source);
		}
		if (edge.target !== '__entry__' && edge.target !== '__exit__') {
			connectedNodes.add(edge.target);
		}
	}
	for (const role of roleNames) {
		if (!connectedNodes.has(role)) {
			warnings.push(`"${role}" is not connected to any edge`);
		}
	}

	// Check edges exist
	if (topology.edges.length === 0) {
		warnings.push('Topology has no edges defined');
	}

	return warnings;
}

// ============================================================================
// TOPOLOGY DESCRIPTION HELPER
// ============================================================================

/**
 * Generate a human-readable description of a workflow topology.
 * Used for moderator system prompts and UI display.
 *
 * @param topology - The topology to describe
 * @returns A human-readable description string
 */
export function describeTopology(topology: WorkflowTopology): string {
	const lines: string[] = [];
	lines.push(`Pattern: ${topology.pattern}`);
	lines.push(`Entry: ${topology.entryPoint} → Exit: ${topology.exitPoint}`);

	if (topology.edges.length > 0) {
		lines.push('Flow:');
		for (const edge of topology.edges) {
			const source = edge.source === '__entry__' ? '(start)' : edge.source;
			const target = edge.target === '__exit__' ? '(end)' : edge.target;
			const condition = edge.condition ? ` [if: ${edge.condition}]` : '';
			const type = edge.edgeType !== 'sequential' ? ` (${edge.edgeType})` : '';
			lines.push(`  ${source} → ${target}${type}${condition}`);
		}
	}

	return lines.join('\n');
}
