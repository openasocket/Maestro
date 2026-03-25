/**
 * Team Generation IPC Handlers
 *
 * Provides IPC handler for AI-powered team structure generation.
 * Uses an ephemeral agent process (via groomContext) to generate a team
 * structure as JSON based on user requirements.
 *
 * Usage:
 * - window.maestro.teamGeneration.generate(request)
 */

import { ipcMain } from 'electron';
import Store from 'electron-store';
import { logger } from '../../utils/logger';
import {
	withIpcErrorLogging,
	requireDependency,
	CreateHandlerOptions,
} from '../../utils/ipcHandler';
import { groomContext } from '../../utils/context-groomer';
import { teamGenerationPrompt } from '../../../prompts';
import type { ProcessManager } from '../../process-manager';
import type { AgentDetector } from '../../agents';
import type { RoleTier } from '../../../shared/group-chat-types';

const LOG_CONTEXT = '[TeamGeneration]';

// Helper to create handler options with consistent context
const handlerOpts = (operation: string): Pick<CreateHandlerOptions, 'context' | 'operation'> => ({
	context: LOG_CONTEXT,
	operation,
});

/**
 * Dependencies required for team generation handler registration
 */
export interface TeamGenerationHandlerDependencies {
	getProcessManager: () => ProcessManager | null;
	getAgentDetector: () => AgentDetector | null;
	agentConfigsStore: Store<{ configs: Record<string, Record<string, any>> }>;
}

/**
 * Request interface for team generation
 */
interface TeamGenerationRequest {
	description: string;
	teamSize?: 'small' | 'medium' | 'large' | 'auto';
	rigor?: 'light' | 'standard' | 'strict';
	domain?: string;
	specializations?: string[];
}

/**
 * A single role in a generated team
 */
interface GeneratedRole {
	name: string;
	tier: RoleTier;
	agentId: string;
	description: string;
	prompt: string;
	reportsTo?: string;
}

/**
 * Result interface for team generation
 */
interface TeamGenerationResult {
	name: string;
	description: string;
	roles: GeneratedRole[];
}

/** Timeout for team generation (3 minutes) */
const GENERATION_TIMEOUT_MS = 3 * 60 * 1000;

/** Valid tier values */
const VALID_TIERS: RoleTier[] = ['executive', 'manager', 'worker'];

/**
 * Build the user prompt portion with constraints from the request.
 */
function buildUserPrompt(request: TeamGenerationRequest): string {
	const parts: string[] = [];

	parts.push(`## Team Description\n${request.description}`);

	if (request.teamSize && request.teamSize !== 'auto') {
		const sizeMap: Record<string, string> = {
			small: '3-5 members',
			medium: '5-8 members',
			large: '8-12 members',
		};
		parts.push(`## Team Size Constraint\nTarget: ${sizeMap[request.teamSize] || request.teamSize}`);
	}

	if (request.rigor) {
		const rigorMap: Record<string, string> = {
			light: 'Light review — one reviewer is sufficient',
			standard: 'Standard review — manager + executive review chain',
			strict: 'Strict review — multi-layer review chain with dedicated quality roles',
		};
		parts.push(`## Review Rigor\n${rigorMap[request.rigor] || request.rigor}`);
	}

	if (request.domain) {
		parts.push(`## Primary Domain\n${request.domain}`);
	}

	if (request.specializations && request.specializations.length > 0) {
		parts.push(
			`## Required Specializations\nInclude specialized roles for: ${request.specializations.join(', ')}`
		);
	}

	return parts.join('\n\n');
}

/**
 * Extract JSON from agent response text.
 * The agent may wrap the JSON in markdown code fences or include preamble text.
 */
function extractJson(text: string): string {
	// Remove ANSI escape codes
	const cleaned = text.replace(/\x1B\[[0-9;]*[mGKH]/g, '');

	// Try to extract from code fences first
	const codeFenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
	if (codeFenceMatch) {
		return codeFenceMatch[1].trim();
	}

	// Try to find a JSON object directly
	const jsonStart = cleaned.indexOf('{');
	const jsonEnd = cleaned.lastIndexOf('}');
	if (jsonStart !== -1 && jsonEnd > jsonStart) {
		return cleaned.slice(jsonStart, jsonEnd + 1);
	}

	return cleaned.trim();
}

/**
 * Validate and normalize the parsed team generation result.
 */
function validateResult(parsed: unknown): TeamGenerationResult {
	if (!parsed || typeof parsed !== 'object') {
		throw new Error('Response is not a valid object');
	}

	const obj = parsed as Record<string, unknown>;

	if (typeof obj.name !== 'string' || !obj.name.trim()) {
		throw new Error('Missing or invalid "name" field');
	}

	if (typeof obj.description !== 'string' || !obj.description.trim()) {
		throw new Error('Missing or invalid "description" field');
	}

	if (!Array.isArray(obj.roles) || obj.roles.length === 0) {
		throw new Error('Missing or empty "roles" array');
	}

	const roles: GeneratedRole[] = obj.roles.map((role: unknown, index: number) => {
		if (!role || typeof role !== 'object') {
			throw new Error(`Role at index ${index} is not a valid object`);
		}

		const r = role as Record<string, unknown>;

		if (typeof r.name !== 'string' || !r.name.trim()) {
			throw new Error(`Role at index ${index} missing "name"`);
		}

		if (!VALID_TIERS.includes(r.tier as RoleTier)) {
			throw new Error(
				`Role "${r.name}" has invalid tier "${r.tier}". Must be: ${VALID_TIERS.join(', ')}`
			);
		}

		return {
			name: r.name as string,
			tier: r.tier as RoleTier,
			agentId: typeof r.agentId === 'string' ? r.agentId : 'claude-code',
			description: typeof r.description === 'string' ? r.description : '',
			prompt: typeof r.prompt === 'string' ? r.prompt : '',
			...(typeof r.reportsTo === 'string' && r.reportsTo.trim() ? { reportsTo: r.reportsTo } : {}),
		};
	});

	return {
		name: obj.name as string,
		description: obj.description as string,
		roles,
	};
}

/**
 * Register Team Generation IPC handlers.
 */
export function registerTeamGenerationHandlers(deps: TeamGenerationHandlerDependencies): void {
	const { getProcessManager, getAgentDetector, agentConfigsStore } = deps;

	logger.info('Registering team generation IPC handlers', LOG_CONTEXT);

	ipcMain.handle(
		'teamGeneration:generate',
		withIpcErrorLogging(
			handlerOpts('generate'),
			async (request: TeamGenerationRequest): Promise<TeamGenerationResult> => {
				const processManager = requireDependency(getProcessManager, 'Process manager');
				const agentDetector = requireDependency(getAgentDetector, 'Agent detector');

				if (!request.description || !request.description.trim()) {
					throw new Error('Team description is required');
				}

				logger.info('Starting team generation', LOG_CONTEXT, {
					descriptionLength: request.description.length,
					teamSize: request.teamSize,
					rigor: request.rigor,
					domain: request.domain,
					specializations: request.specializations,
				});

				const userPrompt = buildUserPrompt(request);
				const fullPrompt = `${teamGenerationPrompt}\n\n${userPrompt}`;

				// Resolve agent config values for the groomer
				const allConfigs = agentConfigsStore.get('configs', {});
				const agentConfigValues = allConfigs['claude-code'] || {};

				// First attempt
				let response: string;
				try {
					const result = await groomContext(
						{
							projectRoot: process.cwd(),
							agentType: 'claude-code',
							prompt: fullPrompt,
							readOnlyMode: true,
							timeoutMs: GENERATION_TIMEOUT_MS,
							agentConfigValues,
						},
						processManager,
						agentDetector
					);
					response = result.response;
				} catch (error) {
					logger.error('Team generation agent call failed', LOG_CONTEXT, {
						error: String(error),
					});
					throw new Error('Failed to generate team structure. The AI agent could not be reached.');
				}

				// Try to parse the response
				const jsonText = extractJson(response);
				try {
					const parsed = JSON.parse(jsonText);
					const validated = validateResult(parsed);
					logger.info('Team generation succeeded', LOG_CONTEXT, {
						teamName: validated.name,
						roleCount: validated.roles.length,
					});
					return validated;
				} catch (parseError) {
					logger.warn(
						'First parse attempt failed, retrying with explicit JSON instruction',
						LOG_CONTEXT,
						{
							error: String(parseError),
							responseLength: response.length,
						}
					);
				}

				// Retry with a more explicit JSON instruction
				const retryPrompt = `${fullPrompt}\n\nIMPORTANT: You MUST respond with ONLY valid JSON. No markdown, no explanation, no code fences. Just the raw JSON object starting with { and ending with }.`;

				try {
					const retryResult = await groomContext(
						{
							projectRoot: process.cwd(),
							agentType: 'claude-code',
							prompt: retryPrompt,
							readOnlyMode: true,
							timeoutMs: GENERATION_TIMEOUT_MS,
							agentConfigValues,
						},
						processManager,
						agentDetector
					);

					const retryJsonText = extractJson(retryResult.response);
					const parsed = JSON.parse(retryJsonText);
					const validated = validateResult(parsed);
					logger.info('Team generation succeeded on retry', LOG_CONTEXT, {
						teamName: validated.name,
						roleCount: validated.roles.length,
					});
					return validated;
				} catch (retryError) {
					logger.error('Team generation retry also failed', LOG_CONTEXT, {
						error: String(retryError),
					});
					throw new Error(
						'Failed to parse team structure from AI response. Please try again with a clearer description.'
					);
				}
			}
		)
	);
}
