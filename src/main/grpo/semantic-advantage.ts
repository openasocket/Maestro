/**
 * SemanticAdvantageGenerator — LLM introspection for group-relative comparison.
 *
 * Takes a RolloutGroup (multiple outputs for the same task with different reward scores)
 * and asks an LLM to analyze WHY some succeeded and others failed, then proposes
 * experience library updates based on those insights.
 *
 * This is the "brain" of Training-Free GRPO — it replaces gradient computation
 * with natural-language reasoning about policy improvement.
 */

import { logger } from '../utils/logger';
import { captureException } from '../utils/sentry';
import { groomContext } from '../utils/context-groomer';
import type { GroomingProcessManager } from '../utils/context-groomer';
import type { AgentDetector } from '../agents';
import type {
	RolloutGroup,
	SemanticAdvantage,
	ExperienceUpdateOperation,
	ExperienceEntry,
	GRPOConfig,
} from '../../shared/grpo-types';

const LOG_CONTEXT = '[SemanticAdvantage]';

/** Default max chars for output truncation (~5,000 tokens) */
const DEFAULT_MAX_OUTPUT_CHARS = 20000;

/** Max operations per introspection to prevent runaway library growth */
const MAX_OPERATIONS_PER_INTROSPECTION = 5;

/** Default timeout for introspection agent (2 minutes) */
const DEFAULT_INTROSPECTION_TIMEOUT_MS = 2 * 60 * 1000;

/** Retry timeout (3 minutes) */
const RETRY_INTROSPECTION_TIMEOUT_MS = 3 * 60 * 1000;

/** Valid categories for experience entries */
const VALID_CATEGORIES = new Set([
	'testing',
	'architecture',
	'tooling',
	'debugging',
	'patterns',
	'performance',
]);

// ─── Output Truncation ──────────────────────────────────────────────

/**
 * Truncate a rollout output to fit within the introspection prompt budget.
 *
 * If the output exceeds maxChars, includes the first half and last half
 * with a truncation marker in between.
 */
export function truncateRolloutOutput(output: string, maxChars: number = DEFAULT_MAX_OUTPUT_CHARS): string {
	if (output.length <= maxChars) {
		return output;
	}

	const halfChars = Math.floor(maxChars / 2);
	const head = output.slice(0, halfChars);
	const tail = output.slice(-halfChars);

	return `${head}\n[...truncated ${output.length} total chars...]\n${tail}`;
}

// ─── Prompt Building ─────────────────────────────────────────────────

/**
 * Build the introspection prompt for the semantic advantage generator.
 *
 * The prompt includes: system context, the task prompt, all rollout outputs
 * (sorted best-to-worst with reward breakdowns), the current experience library,
 * and the output format instruction.
 */
export function buildIntrospectionPrompt(
	rolloutGroup: RolloutGroup,
	currentLibrary: ExperienceEntry[],
): string {
	const parts: string[] = [];

	// 1. System context
	parts.push(
		'You are analyzing the results of a group of AI agent rollouts that attempted the same task. ' +
		'Your job is to identify what strategies, patterns, or approaches led to success vs. failure, ' +
		'and propose updates to an experience library that will improve future attempts.'
	);
	parts.push('');

	// 2. Task prompt
	parts.push('## Task');
	parts.push(rolloutGroup.taskPrompt);
	parts.push('');

	// 3. Rollout outputs sorted best-to-worst by aggregate reward
	const sortedOutputs = [...rolloutGroup.outputs].sort(
		(a, b) => b.aggregateReward - a.aggregateReward
	);

	parts.push('## Rollout Results');
	parts.push('');

	for (let i = 0; i < sortedOutputs.length; i++) {
		const output = sortedOutputs[i];
		parts.push(`### Rollout ${i + 1} (score: ${output.aggregateReward.toFixed(2)})`);

		// Reward signal breakdown
		if (output.rewards.length > 0) {
			parts.push('Reward signals:');
			for (const reward of output.rewards) {
				parts.push(`- ${reward.type}: ${reward.score.toFixed(2)} — ${reward.description}`);
			}
		}

		// Highlight human feedback signals with extra context for the introspection LLM
		const humanSignals = output.rewards.filter(r => r.type === 'human-feedback');
		if (humanSignals.length > 0) {
			for (const hs of humanSignals) {
				try {
					const parsed = JSON.parse(hs.rawOutput ?? '{}');
					parts.push(`Human feedback: ${hs.score === 1.0 ? 'APPROVED' : 'DISAPPROVED'}`);
					if (parsed.promptPreview) {
						parts.push(`  User asked: "${parsed.promptPreview}"`);
					}
				} catch { /* ignore */ }
			}
		}

		parts.push('');
		parts.push('Output:');
		parts.push('```');
		parts.push(truncateRolloutOutput(output.output));
		parts.push('```');
		parts.push('');
	}

	// 4. Current experience library
	parts.push('## Current Experience Library');
	if (currentLibrary.length === 0) {
		parts.push('(empty — no existing experiences)');
	} else {
		for (const entry of currentLibrary) {
			parts.push(`- [${entry.id}] (${entry.category}): ${entry.content}`);
		}
	}
	parts.push('');

	// 5. Output format instruction
	parts.push('## Your Response');
	parts.push('');
	parts.push('Respond with:');
	parts.push('1. ANALYSIS: A paragraph explaining what strategies led to better rewards and what caused failures.');
	parts.push('2. OPERATIONS: A JSON array of experience library updates:');
	parts.push('```');
	parts.push('[');
	parts.push('  {"operation": "add", "content": "...", "category": "...", "reasoning": "..."},');
	parts.push('  {"operation": "modify", "targetId": "...", "content": "...", "reasoning": "..."},');
	parts.push('  {"operation": "delete", "targetId": "...", "reasoning": "..."}');
	parts.push(']');
	parts.push('```');
	parts.push('');
	parts.push('Rules:');
	parts.push('- Only propose changes supported by evidence from the rollout comparison');
	parts.push('- Prefer modifying existing experiences over adding duplicates');
	parts.push('- Delete experiences that are contradicted by the evidence');
	parts.push('- Keep each experience entry concise (1-3 sentences)');
	parts.push('- Category must be one of: testing, architecture, tooling, debugging, patterns, performance');

	return parts.join('\n');
}

// ─── Response Parsing ────────────────────────────────────────────────

/**
 * Parse the raw LLM introspection response into structured analysis + operations.
 *
 * Extracts the ANALYSIS section text and the OPERATIONS JSON array.
 * Validates each operation and filters out invalid ones.
 * Limits to MAX_OPERATIONS_PER_INTROSPECTION operations.
 */
export function parseIntrospectionResponse(
	rawOutput: string,
): { analysis: string; operations: ExperienceUpdateOperation[] } {
	// Extract analysis section
	let analysis = '';
	const analysisMatch = rawOutput.match(/ANALYSIS:\s*([\s\S]*?)(?=OPERATIONS:|$)/i);
	if (analysisMatch) {
		analysis = analysisMatch[1].trim();
	} else {
		// Fall back to entire output as analysis if no markers
		analysis = rawOutput.trim();
	}

	// Extract operations JSON
	let operations: ExperienceUpdateOperation[] = [];

	const operationsMatch = rawOutput.match(/OPERATIONS:\s*([\s\S]*?)$/i);
	if (operationsMatch) {
		const operationsText = operationsMatch[1].trim();
		// Try to extract JSON array — may be wrapped in code fences
		const jsonMatch = operationsText.match(/\[[\s\S]*\]/);
		if (jsonMatch) {
			try {
				const parsed = JSON.parse(jsonMatch[0]);
				if (Array.isArray(parsed)) {
					operations = parsed;
				}
			} catch (err) {
				logger.warn(`Failed to parse operations JSON: ${err}`, LOG_CONTEXT);
			}
		}
	}

	// Validate each operation
	const validOperations: ExperienceUpdateOperation[] = [];
	for (const op of operations) {
		if (!op || typeof op !== 'object') {
			logger.warn('Skipping invalid operation (not an object)', LOG_CONTEXT);
			continue;
		}

		if (!op.operation || !['add', 'modify', 'delete'].includes(op.operation)) {
			logger.warn(`Skipping operation with invalid type: ${op.operation}`, LOG_CONTEXT);
			continue;
		}

		if (!op.reasoning || typeof op.reasoning !== 'string') {
			logger.warn(`Skipping ${op.operation} operation without reasoning`, LOG_CONTEXT);
			continue;
		}

		switch (op.operation) {
			case 'add': {
				if (!op.content || typeof op.content !== 'string') {
					logger.warn('Skipping add operation without content', LOG_CONTEXT);
					continue;
				}
				if (!op.category || typeof op.category !== 'string') {
					logger.warn('Skipping add operation without category', LOG_CONTEXT);
					continue;
				}
				validOperations.push({
					operation: 'add',
					content: op.content,
					category: VALID_CATEGORIES.has(op.category) ? op.category : 'patterns',
					reasoning: op.reasoning,
				});
				break;
			}
			case 'modify': {
				if (!op.targetId || typeof op.targetId !== 'string') {
					logger.warn('Skipping modify operation without targetId', LOG_CONTEXT);
					continue;
				}
				if (!op.content || typeof op.content !== 'string') {
					logger.warn('Skipping modify operation without content', LOG_CONTEXT);
					continue;
				}
				validOperations.push({
					operation: 'modify',
					targetId: op.targetId,
					content: op.content,
					category: op.category,
					reasoning: op.reasoning,
				});
				break;
			}
			case 'delete': {
				if (!op.targetId || typeof op.targetId !== 'string') {
					logger.warn('Skipping delete operation without targetId', LOG_CONTEXT);
					continue;
				}
				validOperations.push({
					operation: 'delete',
					targetId: op.targetId,
					reasoning: op.reasoning,
				});
				break;
			}
		}
	}

	// Limit operations to prevent runaway library growth
	if (validOperations.length > MAX_OPERATIONS_PER_INTROSPECTION) {
		logger.warn(
			`Truncating ${validOperations.length} operations to ${MAX_OPERATIONS_PER_INTROSPECTION}`,
			LOG_CONTEXT,
		);
	}

	return {
		analysis,
		operations: validOperations.slice(0, MAX_OPERATIONS_PER_INTROSPECTION),
	};
}

// ─── Agent Spawning ──────────────────────────────────────────────────

/**
 * Spawn an introspection agent in read-only batch mode and collect its output.
 *
 * Uses the groomContext pattern for process management.
 * Falls back to any available agent if the configured one is unavailable.
 */
export async function spawnIntrospectionAgent(
	prompt: string,
	projectPath: string,
	config: GRPOConfig,
	processManager: GroomingProcessManager,
	agentDetector: AgentDetector,
	timeoutMs?: number,
): Promise<string> {
	// Try configured agent first, then fall back
	let agentType = config.introspectionAgent;
	const agent = await agentDetector.getAgent(agentType);

	if (!agent || !agent.available) {
		logger.warn(
			`Introspection agent ${agentType} not available, searching for fallback`,
			LOG_CONTEXT,
		);

		const allAgents = await agentDetector.detectAgents();
		const fallback = allAgents.find(a => a.available && a.id !== 'terminal');

		if (!fallback) {
			throw new Error('No agents available for introspection');
		}

		agentType = fallback.id;
		logger.info(`Using fallback agent ${agentType} for introspection`, LOG_CONTEXT);
	}

	const result = await groomContext(
		{
			projectRoot: projectPath,
			agentType,
			prompt,
			readOnlyMode: true,
			timeoutMs: timeoutMs ?? DEFAULT_INTROSPECTION_TIMEOUT_MS,
		},
		processManager,
		agentDetector,
	);

	return result.response;
}

// ─── Main Generator ──────────────────────────────────────────────────

/**
 * Generate a semantic advantage from a rollout group.
 *
 * This is the core method of Training-Free GRPO: it takes a group of rollout
 * outputs with varying reward scores and produces natural-language analysis
 * plus structured experience library update operations.
 *
 * Key behaviors:
 * - Returns empty advantage if reward variance is below threshold (nothing to learn)
 * - Truncates long rollout outputs before building the prompt
 * - Retries once on agent failure, then returns empty operations
 */
export async function generateAdvantage(
	rolloutGroup: RolloutGroup,
	currentLibrary: ExperienceEntry[],
	config: GRPOConfig,
	processManager: GroomingProcessManager,
	agentDetector: AgentDetector,
	retryCount: number = 0,
): Promise<SemanticAdvantage> {
	// 1. Check variance — no learning from unanimous outcomes
	if (rolloutGroup.rewardStdDev < config.varianceThreshold) {
		logger.info(
			`Skipping introspection for group ${rolloutGroup.id}: ` +
			`stdDev ${rolloutGroup.rewardStdDev.toFixed(3)} < threshold ${config.varianceThreshold}`,
			LOG_CONTEXT,
		);

		return {
			rolloutGroupId: rolloutGroup.id,
			analysis: 'Skipped: reward variance below threshold (no learning signal from unanimous outcomes).',
			operations: [],
			introspectionModel: config.introspectionModel,
			generatedAt: Date.now(),
		};
	}

	// 2. Build introspection prompt (truncation happens inside buildIntrospectionPrompt)
	const prompt = buildIntrospectionPrompt(rolloutGroup, currentLibrary);

	logger.info(
		`Generating semantic advantage for group ${rolloutGroup.id} ` +
		`(${rolloutGroup.outputs.length} outputs, stdDev=${rolloutGroup.rewardStdDev.toFixed(3)}, retry=${retryCount})`,
		LOG_CONTEXT,
	);

	try {
		// 3. Spawn introspection agent
		const timeoutMs = retryCount > 0
			? RETRY_INTROSPECTION_TIMEOUT_MS
			: DEFAULT_INTROSPECTION_TIMEOUT_MS;

		const rawOutput = await spawnIntrospectionAgent(
			prompt,
			rolloutGroup.projectPath,
			config,
			processManager,
			agentDetector,
			timeoutMs,
		);

		// 4. Parse response
		const { analysis, operations } = parseIntrospectionResponse(rawOutput);

		logger.info(
			`Semantic advantage generated for group ${rolloutGroup.id}: ` +
			`${operations.length} operations proposed`,
			LOG_CONTEXT,
		);

		return {
			rolloutGroupId: rolloutGroup.id,
			analysis,
			operations,
			introspectionModel: config.introspectionModel,
			generatedAt: Date.now(),
		};
	} catch (err) {
		// 5. Retry logic
		if (retryCount < 1) {
			logger.warn(
				`Introspection failed for group ${rolloutGroup.id}, retrying (attempt ${retryCount + 1})`,
				LOG_CONTEXT,
			);
			return generateAdvantage(
				rolloutGroup,
				currentLibrary,
				config,
				processManager,
				agentDetector,
				retryCount + 1,
			);
		}

		// Second failure — return empty operations
		logger.warn(
			`Introspection failed twice for group ${rolloutGroup.id}, returning empty operations`,
			LOG_CONTEXT,
		);
		await captureException(err, {
			operation: 'grpo:semanticAdvantage',
			rolloutGroupId: rolloutGroup.id,
		});

		return {
			rolloutGroupId: rolloutGroup.id,
			analysis: `Introspection failed after ${retryCount + 1} attempts: ${err instanceof Error ? err.message : String(err)}`,
			operations: [],
			introspectionModel: config.introspectionModel,
			generatedAt: Date.now(),
		};
	}
}
