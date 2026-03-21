/**
 * @file message-formatter.ts
 * @description Formats messages for downstream agents based on input/output contracts.
 *
 * Implements MASFactory's "Message Adapter" concept: instead of passing the full
 * chat history to every agent, contracts define what each role needs and produces.
 * The formatter builds a focused context package for each downstream agent.
 *
 * Designed to be usable from both Group Chat routing and the Teams orchestrator
 * (TEAMS-03) — no Group Chat-specific dependencies.
 */

import type { TeamTemplateRole, WorkflowTopology } from '../../shared/group-chat-types';

/**
 * An upstream agent's output paired with its role name.
 */
export interface UpstreamOutput {
	roleName: string;
	output: string;
}

/**
 * Format a message for a downstream agent based on its input contract
 * and the upstream agent's output.
 *
 * If contracts are defined: extracts only relevant portions and adds structure.
 * If no contracts: returns the full upstream output unchanged (backward compatible).
 *
 * @param downstreamRole - The role definition of the agent receiving the message
 * @param upstreamOutputs - Outputs from upstream agents
 * @param userOriginalMessage - The original user request
 * @param topology - Optional topology for determining which upstream outputs are relevant
 * @returns Formatted message string for the downstream agent
 */
export function formatAgentInput(
	downstreamRole: TeamTemplateRole,
	upstreamOutputs: UpstreamOutput[],
	userOriginalMessage: string,
	topology?: WorkflowTopology
): string {
	const hasInputContract = downstreamRole.inputContract && downstreamRole.inputContract.length > 0;
	const hasOutputContract =
		downstreamRole.outputContract && downstreamRole.outputContract.length > 0;

	// No contracts defined — return concatenated upstream outputs (backward compatible)
	if (!hasInputContract && !hasOutputContract) {
		if (upstreamOutputs.length === 0) {
			return userOriginalMessage;
		}
		// Return all upstream outputs with the original message
		const parts = [userOriginalMessage];
		for (const upstream of upstreamOutputs) {
			parts.push(`\n---\n[From ${upstream.roleName}]:\n${upstream.output}`);
		}
		return parts.join('\n');
	}

	// Contracts defined — build a structured context package
	const sections: string[] = [];

	// Header
	sections.push('## Task Context');

	// Always include the original user request
	sections.push('\n### Original Request');
	sections.push(userOriginalMessage);

	// Filter upstream outputs to only those that feed into this role (via topology edges)
	const relevantOutputs = filterRelevantUpstream(downstreamRole.name, upstreamOutputs, topology);

	// Include relevant upstream outputs
	for (const upstream of relevantOutputs) {
		sections.push(`\n### From ${upstream.roleName}:`);
		sections.push(upstream.output);
	}

	// Add assignment section with output contract as checklist
	if (hasOutputContract) {
		sections.push('\n## Your Assignment');
		sections.push('Complete the following deliverables:');
		for (const item of downstreamRole.outputContract!) {
			sections.push(`- [ ] ${item}`);
		}
	}

	return sections.join('\n');
}

/**
 * Format agent responses for moderator synthesis, including contract metadata.
 *
 * @param responses - Array of agent responses with their role info
 * @returns Formatted string with contract metadata for the moderator
 */
export function formatSynthesisContext(
	responses: Array<{ roleName: string; output: string; outputContract?: string[] }>
): string {
	const sections: string[] = ['## Agent Responses'];

	for (const response of responses) {
		const contractNote =
			response.outputContract && response.outputContract.length > 0
				? ` (expected to produce: ${response.outputContract.join(', ')})`
				: '';
		sections.push(`\n### ${response.roleName}${contractNote}`);
		sections.push(response.output);
	}

	return sections.join('\n');
}

/**
 * Filter upstream outputs to only those connected to the downstream role via topology edges.
 * If no topology is provided, returns all upstream outputs.
 */
function filterRelevantUpstream(
	downstreamRoleName: string,
	upstreamOutputs: UpstreamOutput[],
	topology?: WorkflowTopology
): UpstreamOutput[] {
	if (!topology || !topology.edges || topology.edges.length === 0) {
		return upstreamOutputs;
	}

	// Find all roles that have edges leading into the downstream role
	const incomingSources = new Set<string>();
	for (const edge of topology.edges) {
		if (edge.target === downstreamRoleName) {
			incomingSources.add(edge.source);
		}
	}

	// If no incoming edges found (shouldn't happen in valid topologies), return all
	if (incomingSources.size === 0) {
		return upstreamOutputs;
	}

	return upstreamOutputs.filter((u) => incomingSources.has(u.roleName));
}
