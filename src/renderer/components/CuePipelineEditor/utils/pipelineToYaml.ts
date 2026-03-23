/**
 * Converts visual pipeline graph state to YAML content consumable by the Cue engine.
 *
 * A pipeline "trigger -> agent1 -> agent2" produces chained subscriptions:
 *   - First subscription uses the trigger's event type
 *   - Subsequent subscriptions use agent.completed with source_session chaining
 *   - Fan-out uses fan_out array, fan-in uses source_session array
 */

import * as yaml from 'js-yaml';
import type {
	CuePipeline,
	PipelineNode,
	PipelineEdge,
	TriggerNodeData,
	AgentNodeData,
	TeamNodeData,
} from '../../../../shared/cue-pipeline-types';
import type { CueSubscription, CueSettings } from '../../../../main/cue/cue-types';
import { cuePromptFilePath } from '../../../../shared/maestro-paths';

const SOURCE_OUTPUT_VAR = '{{CUE_SOURCE_OUTPUT}}';

/**
 * Ensures the prompt for an agent.completed chain subscription includes the
 * {{CUE_SOURCE_OUTPUT}} template variable so upstream agent output is passed through.
 *
 * - If the prompt already contains the variable (case-insensitive), returns as-is.
 * - If the prompt is empty/whitespace, returns the bare variable.
 * - Otherwise prepends the variable above the user's prompt.
 */
export function ensureSourceOutputVariable(prompt: string): string {
	if (prompt.toUpperCase().includes(SOURCE_OUTPUT_VAR.toUpperCase())) return prompt;
	if (!prompt.trim()) return SOURCE_OUTPUT_VAR;
	return `${SOURCE_OUTPUT_VAR}\n\n${prompt}`;
}

/** Result of converting pipelines to YAML, including external prompt files */
export interface PipelineYamlResult {
	yaml: string;
	promptFiles: Map<string, string>;
}

function buildAdjacency(pipeline: CuePipeline): {
	outgoing: Map<string, PipelineEdge[]>;
	incoming: Map<string, PipelineEdge[]>;
} {
	const outgoing = new Map<string, PipelineEdge[]>();
	const incoming = new Map<string, PipelineEdge[]>();

	for (const edge of pipeline.edges) {
		const out = outgoing.get(edge.source) ?? [];
		out.push(edge);
		outgoing.set(edge.source, out);

		const inc = incoming.get(edge.target) ?? [];
		inc.push(edge);
		incoming.set(edge.target, inc);
	}

	return { outgoing, incoming };
}

function findTriggerNodes(pipeline: CuePipeline): PipelineNode[] {
	return pipeline.nodes.filter((n) => n.type === 'trigger');
}

/** Returns true for nodes that represent executable actions (agents or teams). */
function isActionNode(node: PipelineNode): boolean {
	return node.type === 'agent' || node.type === 'team';
}

/** Returns the name used for source_session chaining and prompt file paths. */
function getActionNodeName(node: PipelineNode): string {
	if (node.type === 'team') return (node.data as TeamNodeData).templateName;
	return (node.data as AgentNodeData).sessionName;
}

/** Returns the ID used for agent_id / team_template binding. */
function getActionNodeId(node: PipelineNode): string {
	if (node.type === 'team') return (node.data as TeamNodeData).templateId;
	return (node.data as AgentNodeData).sessionId;
}

function getEdgeModeComment(edge: PipelineEdge): string | null {
	if (edge.mode === 'debate') {
		const rounds = edge.debateConfig?.maxRounds ?? 3;
		const timeout = edge.debateConfig?.timeoutPerRound ?? 60;
		return `# mode: debate, max_rounds: ${rounds}, timeout_per_round: ${timeout}`;
	}
	if (edge.mode === 'autorun') {
		return '# mode: autorun';
	}
	return null;
}

/**
 * Lower-level helper: converts a single pipeline into CueSubscription objects.
 */
export function pipelineToYamlSubscriptions(pipeline: CuePipeline): CueSubscription[] {
	const subscriptions: CueSubscription[] = [];
	const { outgoing, incoming } = buildAdjacency(pipeline);
	const triggers = findTriggerNodes(pipeline);
	const nodeMap = new Map(pipeline.nodes.map((n) => [n.id, n]));

	// Track visited nodes to avoid duplicates
	const visited = new Set<string>();
	let chainIndex = 0;

	for (const trigger of triggers) {
		const triggerData = trigger.data as TriggerNodeData;
		const triggerOutgoing = outgoing.get(trigger.id) ?? [];

		if (triggerOutgoing.length === 0) continue;

		// Build the first subscription from trigger
		const directTargets = triggerOutgoing
			.map((e) => nodeMap.get(e.target))
			.filter(Boolean) as PipelineNode[];
		const actionTargets = directTargets.filter(isActionNode);

		if (actionTargets.length === 0) continue;

		const subName = chainIndex === 0 ? pipeline.name : `${pipeline.name}-chain-${chainIndex}`;
		chainIndex++;

		const sub: CueSubscription = {
			name: subName,
			event: triggerData.eventType,
			enabled: true,
			prompt: '',
		};

		// Persist trigger's custom label
		if (triggerData.customLabel) {
			sub.label = triggerData.customLabel;
		}

		// Map trigger config fields
		switch (triggerData.eventType) {
			case 'time.heartbeat':
				if (triggerData.config.interval_minutes) {
					sub.interval_minutes = triggerData.config.interval_minutes;
				}
				break;
			case 'time.scheduled':
				if (triggerData.config.schedule_times?.length) {
					sub.schedule_times = triggerData.config.schedule_times;
				}
				if (triggerData.config.schedule_days?.length) {
					sub.schedule_days = triggerData.config.schedule_days as CueSubscription['schedule_days'];
				}
				break;
			case 'file.changed':
				sub.watch = triggerData.config.watch ?? '**/*';
				if (triggerData.config.filter) {
					sub.filter = triggerData.config.filter;
				}
				break;
			case 'github.pull_request':
			case 'github.issue':
				if (triggerData.config.repo) sub.repo = triggerData.config.repo;
				if (triggerData.config.poll_minutes) sub.poll_minutes = triggerData.config.poll_minutes;
				break;
			case 'task.pending':
				sub.watch = triggerData.config.watch ?? '**/*.md';
				break;
			case 'agent.completed':
				// source_session comes from node config, not edges
				break;
		}

		if (actionTargets.length === 1) {
			// Single target (agent or team)
			const target = actionTargets[0];
			const triggerEdge = triggerOutgoing.find((e) => e.target === target.id);

			if (target.type === 'team') {
				const teamData = target.data as TeamNodeData;
				sub.team_template = teamData.templateId;
				sub.prompt = triggerEdge?.prompt ?? teamData.inputPrompt ?? '';
				if (teamData.outputPrompt) sub.output_prompt = teamData.outputPrompt;
			} else {
				const agentData = target.data as AgentNodeData;
				sub.prompt = triggerEdge?.prompt ?? agentData.inputPrompt ?? '';
				if (agentData.outputPrompt) sub.output_prompt = agentData.outputPrompt;
			}

			subscriptions.push(sub);
			visited.add(target.id);

			// Follow the chain from this node
			buildChain(target, pipeline.name, subscriptions, outgoing, incoming, nodeMap, visited);
			chainIndex = subscriptions.length;
		} else {
			// Fan-out: multiple targets from trigger
			sub.fan_out = actionTargets.map((a) => getActionNodeName(a));
			const firstData = actionTargets[0].data as AgentNodeData | TeamNodeData;
			sub.prompt = firstData.inputPrompt ?? '';
			subscriptions.push(sub);

			for (const target of actionTargets) {
				visited.add(target.id);
			}

			// Follow chains from each fan-out target
			for (const target of actionTargets) {
				buildChain(target, pipeline.name, subscriptions, outgoing, incoming, nodeMap, visited);
			}
			chainIndex = subscriptions.length;
		}
	}

	return subscriptions;
}

function buildChain(
	fromNode: PipelineNode,
	pipelineName: string,
	subscriptions: CueSubscription[],
	outgoing: Map<string, PipelineEdge[]>,
	incoming: Map<string, PipelineEdge[]>,
	nodeMap: Map<string, PipelineNode>,
	visited: Set<string>
): void {
	const fromOutgoing = outgoing.get(fromNode.id) ?? [];
	if (fromOutgoing.length === 0) return;

	const targets = fromOutgoing
		.map((e) => nodeMap.get(e.target))
		.filter((n): n is PipelineNode => n != null && isActionNode(n));

	if (targets.length === 0) return;

	const fromSourceName = getActionNodeName(fromNode);

	for (const target of targets) {
		if (visited.has(target.id)) continue;
		visited.add(target.id);

		const inputPrompt =
			target.type === 'team'
				? (target.data as TeamNodeData).inputPrompt
				: (target.data as AgentNodeData).inputPrompt;
		const outputPrompt =
			target.type === 'team'
				? (target.data as TeamNodeData).outputPrompt
				: (target.data as AgentNodeData).outputPrompt;

		// Check for fan-in: does this target have multiple incoming action edges?
		const targetIncoming = incoming.get(target.id) ?? [];
		const incomingActionEdges = targetIncoming.filter((e) => {
			const sourceNode = nodeMap.get(e.source);
			return sourceNode != null && isActionNode(sourceNode);
		});

		const subName = `${pipelineName}-chain-${subscriptions.length}`;

		const shouldInjectSource =
			target.type === 'agent'
				? (target.data as AgentNodeData).includeUpstreamOutput !== false
				: true;
		const sub: CueSubscription = {
			name: subName,
			event: 'agent.completed',
			enabled: true,
			prompt: shouldInjectSource
				? ensureSourceOutputVariable(inputPrompt ?? '')
				: (inputPrompt ?? ''),
			output_prompt: outputPrompt || undefined,
		};

		// Set team_template for team targets
		if (target.type === 'team') {
			sub.team_template = (target.data as TeamNodeData).templateId;
		}

		if (incomingActionEdges.length > 1) {
			// Fan-in: multiple source sessions
			sub.source_session = incomingActionEdges
				.map((e) => {
					const src = nodeMap.get(e.source);
					return src ? getActionNodeName(src) : '';
				})
				.filter(Boolean);
		} else {
			sub.source_session = fromSourceName;
		}

		subscriptions.push(sub);

		// Continue the chain
		buildChain(target, pipelineName, subscriptions, outgoing, incoming, nodeMap, visited);
	}
}

/**
 * Converts pipeline graph state to YAML string with external prompt files.
 * Prompts are saved as external .md files referenced by prompt_file in the YAML.
 */
export function pipelinesToYaml(
	pipelines: CuePipeline[],
	settings?: Partial<CueSettings>
): PipelineYamlResult {
	const allSubscriptions: Array<Record<string, unknown>> = [];
	const comments: string[] = [];
	const promptFiles = new Map<string, string>();

	for (const pipeline of pipelines) {
		// Pipeline metadata comment
		comments.push(`# Pipeline: ${pipeline.name} (color: ${pipeline.color})`);

		const subs = pipelineToYamlSubscriptions(pipeline);

		// Build maps from subscription name to the agent node that owns it
		const subAgentMap = buildSubAgentMap(pipeline);
		const subAgentIdMap = buildSubAgentIdMap(pipeline);

		for (const sub of subs) {
			const record: Record<string, unknown> = {
				name: sub.name,
				event: sub.event,
			};

			// Bind subscription to its owning agent/team
			if (sub.team_template) {
				record.team_template = sub.team_template;
			} else {
				const agentId = subAgentIdMap.get(sub.name);
				if (agentId) record.agent_id = agentId;
			}

			if (sub.label) record.label = sub.label;
			if (sub.interval_minutes != null) record.interval_minutes = sub.interval_minutes;
			if (sub.schedule_times != null) record.schedule_times = sub.schedule_times;
			if (sub.schedule_days != null) record.schedule_days = sub.schedule_days;
			if (sub.watch != null) record.watch = sub.watch;
			if (sub.repo != null) record.repo = sub.repo;
			if (sub.poll_minutes != null) record.poll_minutes = sub.poll_minutes;
			if (sub.source_session != null) record.source_session = sub.source_session;
			if (sub.fan_out != null) record.fan_out = sub.fan_out;
			if (sub.filter != null) record.filter = sub.filter;

			// Save prompts as external files.
			// Use sub.name as the suffix key so multiple triggers targeting the same agent
			// get unique file paths (e.g. agent-pipeline.md vs agent-pipeline-chain-1.md).
			const agentName = subAgentMap.get(sub.name) ?? 'agent';
			const promptSuffix = sub.name === pipeline.name ? pipeline.name : sub.name;

			if (sub.prompt) {
				const filePath = cuePromptFilePath(agentName, promptSuffix);
				record.prompt_file = filePath;
				promptFiles.set(filePath, sub.prompt);
			}

			if (sub.output_prompt) {
				const filePath = cuePromptFilePath(agentName, promptSuffix, 'output');
				record.output_prompt_file = filePath;
				promptFiles.set(filePath, sub.output_prompt);
			}

			allSubscriptions.push(record);
		}

		// Add edge mode annotations as comments
		for (const edge of pipeline.edges) {
			const comment = getEdgeModeComment(edge);
			if (comment) {
				const sourceNode = pipeline.nodes.find((n) => n.id === edge.source);
				const targetNode = pipeline.nodes.find((n) => n.id === edge.target);
				if (sourceNode && targetNode) {
					const sourceName =
						sourceNode.type === 'trigger'
							? (sourceNode.data as TriggerNodeData).label
							: getActionNodeName(sourceNode);
					const targetName = getActionNodeName(targetNode);
					comments.push(`# Edge ${sourceName} -> ${targetName}: ${comment.replace('# ', '')}`);
				}
			}
		}
	}

	const config: Record<string, unknown> = {
		subscriptions: allSubscriptions,
	};

	if (settings) {
		config.settings = settings;
	}

	const yamlStr = yaml.dump(config, {
		indent: 2,
		lineWidth: 120,
		noRefs: true,
		quotingType: "'",
		forceQuotes: false,
	});

	// Prepend pipeline metadata comments
	const header = comments.length > 0 ? comments.join('\n') + '\n\n' : '';
	return { yaml: header + yamlStr, promptFiles };
}

/**
 * Builds a map from subscription name to the action node name (session name or template name).
 * Used for generating prompt file paths.
 */
function buildSubAgentMap(pipeline: CuePipeline): Map<string, string> {
	const result = new Map<string, string>();
	const { outgoing } = buildAdjacency(pipeline);
	const triggers = findTriggerNodes(pipeline);
	const nodeMap = new Map(pipeline.nodes.map((n) => [n.id, n]));

	const visited = new Set<string>();
	let chainIndex = 0;

	for (const trigger of triggers) {
		const triggerOutgoing = outgoing.get(trigger.id) ?? [];
		if (triggerOutgoing.length === 0) continue;

		const directTargets = triggerOutgoing
			.map((e) => nodeMap.get(e.target))
			.filter(Boolean) as PipelineNode[];
		const actionTargets = directTargets.filter(isActionNode);
		if (actionTargets.length === 0) continue;

		const subName = chainIndex === 0 ? pipeline.name : `${pipeline.name}-chain-${chainIndex}`;
		chainIndex++;

		if (actionTargets.length === 1) {
			result.set(subName, getActionNodeName(actionTargets[0]));
			visited.add(actionTargets[0].id);
			buildSubAgentMapChain(actionTargets[0], pipeline.name, result, outgoing, nodeMap, visited);
			chainIndex = result.size;
		} else {
			// Fan-out: use first target's name for the subscription
			result.set(subName, getActionNodeName(actionTargets[0]));
			for (const target of actionTargets) visited.add(target.id);
			for (const target of actionTargets) {
				buildSubAgentMapChain(target, pipeline.name, result, outgoing, nodeMap, visited);
			}
			chainIndex = result.size;
		}
	}

	return result;
}

/**
 * Builds a map from subscription name to the agent session ID that owns it.
 * Used for setting the agent_id field in YAML so subscriptions are bound to specific agents.
 * Team nodes are excluded — they use team_template instead of agent_id.
 */
function buildSubAgentIdMap(pipeline: CuePipeline): Map<string, string> {
	const result = new Map<string, string>();
	const { outgoing } = buildAdjacency(pipeline);
	const triggers = findTriggerNodes(pipeline);
	const nodeMap = new Map(pipeline.nodes.map((n) => [n.id, n]));

	const visited = new Set<string>();
	let chainIndex = 0;

	for (const trigger of triggers) {
		const triggerOutgoing = outgoing.get(trigger.id) ?? [];
		if (triggerOutgoing.length === 0) continue;

		const directTargets = triggerOutgoing
			.map((e) => nodeMap.get(e.target))
			.filter(Boolean) as PipelineNode[];
		const actionTargets = directTargets.filter(isActionNode);
		if (actionTargets.length === 0) continue;

		const subName = chainIndex === 0 ? pipeline.name : `${pipeline.name}-chain-${chainIndex}`;
		chainIndex++;

		if (actionTargets.length === 1) {
			// Only set agent_id for agent nodes, not team nodes
			if (actionTargets[0].type === 'agent') {
				result.set(subName, (actionTargets[0].data as AgentNodeData).sessionId);
			}
			visited.add(actionTargets[0].id);
			buildSubAgentIdMapChain(actionTargets[0], pipeline.name, result, outgoing, nodeMap, visited);
			chainIndex = Math.max(result.size, chainIndex);
		} else {
			// Fan-out: use first agent's ID for the subscription (if it's an agent)
			if (actionTargets[0].type === 'agent') {
				result.set(subName, (actionTargets[0].data as AgentNodeData).sessionId);
			}
			for (const target of actionTargets) visited.add(target.id);
			for (const target of actionTargets) {
				buildSubAgentIdMapChain(target, pipeline.name, result, outgoing, nodeMap, visited);
			}
			chainIndex = Math.max(result.size, chainIndex);
		}
	}

	return result;
}

function buildSubAgentIdMapChain(
	fromNode: PipelineNode,
	pipelineName: string,
	result: Map<string, string>,
	outgoing: Map<string, PipelineEdge[]>,
	nodeMap: Map<string, PipelineNode>,
	visited: Set<string>
): void {
	const fromOutgoing = outgoing.get(fromNode.id) ?? [];
	const targets = fromOutgoing
		.map((e) => nodeMap.get(e.target))
		.filter((n): n is PipelineNode => n != null && isActionNode(n));

	for (const target of targets) {
		if (visited.has(target.id)) continue;
		visited.add(target.id);

		// Only map agent nodes — team nodes use team_template (set on CueSubscription directly)
		if (target.type === 'agent') {
			const subName = `${pipelineName}-chain-${result.size}`;
			result.set(subName, (target.data as AgentNodeData).sessionId);
		}
		buildSubAgentIdMapChain(target, pipelineName, result, outgoing, nodeMap, visited);
	}
}

function buildSubAgentMapChain(
	fromNode: PipelineNode,
	pipelineName: string,
	result: Map<string, string>,
	outgoing: Map<string, PipelineEdge[]>,
	nodeMap: Map<string, PipelineNode>,
	visited: Set<string>
): void {
	const fromOutgoing = outgoing.get(fromNode.id) ?? [];
	const targets = fromOutgoing
		.map((e) => nodeMap.get(e.target))
		.filter((n): n is PipelineNode => n != null && isActionNode(n));

	for (const target of targets) {
		if (visited.has(target.id)) continue;
		visited.add(target.id);

		const subName = `${pipelineName}-chain-${result.size}`;
		result.set(subName, getActionNodeName(target));
		buildSubAgentMapChain(target, pipelineName, result, outgoing, nodeMap, visited);
	}
}
