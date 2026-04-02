/**
 * Extraction Provider Resolver
 *
 * Resolves which batch-capable AI agent to use for experience extraction.
 * Supports auto-detection (first available in preference order) or explicit
 * selection via config.extractionProvider.
 */

import { AGENT_DEFINITIONS, type AgentDefinition } from '../agents/definitions';
import { getAgentCapabilities } from '../agents/capabilities';
import { checkBinaryExists } from '../agents/path-prober';

export interface ResolvedExtractionProvider {
	agentId: string;
	command: string;
	args: string[];
	env: Record<string, string>;
	modelArgs?: (modelId: string) => string[];
	promptArgs: (prompt: string) => string[];
}

/** Preferred order for auto-detection */
const PREFERENCE_ORDER = ['claude-code', 'opencode', 'codex', 'factory-droid'];

/**
 * Build the base CLI args for batch-mode extraction from an agent definition.
 */
function buildBaseArgs(def: AgentDefinition): string[] {
	const args: string[] = [];
	if (def.batchModePrefix) args.push(...def.batchModePrefix);
	if (def.batchModeArgs) args.push(...def.batchModeArgs);
	if (def.jsonOutputArgs) args.push(...def.jsonOutputArgs);
	// For claude-code, the args field already contains batch mode flags
	if (def.id === 'claude-code') {
		return [...def.args];
	}
	return args;
}

/**
 * Build a prompt-args function for an agent definition.
 */
function buildPromptArgs(def: AgentDefinition): (prompt: string) => string[] {
	if (def.promptArgs) {
		return def.promptArgs;
	}
	// Claude Code uses -p for prompt
	if (def.id === 'claude-code') {
		return (prompt: string) => ['-p', prompt];
	}
	// Default: use -- separator then prompt (unless noPromptSeparator)
	if (def.noPromptSeparator) {
		return (prompt: string) => [prompt];
	}
	return (prompt: string) => ['--', prompt];
}

/**
 * Resolve which agent to use for experience extraction.
 *
 * @param preferredId - Agent ID from config.extractionProvider (optional)
 * @returns Resolved provider, or null if no batch-capable agent is available
 */
export async function resolveExtractionProvider(
	preferredId?: string
): Promise<ResolvedExtractionProvider | null> {
	// Build list of candidates in order
	const candidateIds = preferredId ? [preferredId] : PREFERENCE_ORDER;

	for (const agentId of candidateIds) {
		const def = AGENT_DEFINITIONS.find((d) => d.id === agentId);
		if (!def) continue;

		const caps = getAgentCapabilities(agentId);
		if (!caps.supportsBatchMode) continue;

		// Check if binary is available
		const detection = await checkBinaryExists(def.binaryName);
		if (!detection.exists) continue;

		return {
			agentId: def.id,
			command: detection.path || def.command,
			args: buildBaseArgs(def),
			env: def.defaultEnvVars ?? {},
			modelArgs: def.modelArgs,
			promptArgs: buildPromptArgs(def),
		};
	}

	return null;
}
