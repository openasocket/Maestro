// Slash commands - both built-in Maestro commands and custom AI commands
// Built-in commands are intercepted by Maestro before being sent to the agent

import type { AITab, Session, ToolType } from './types';
import type { GrokCommandDiscoveryResult } from '../main/agents/grok-skills';
import { isSessionRemote } from './utils/sessionHelpers';
import { logger } from './utils/logger';

export interface SlashCommand {
	command: string;
	description: string;
	terminalOnly?: boolean; // Only show this command in terminal mode
	aiOnly?: boolean; // Only show this command in AI mode
	agentTypes?: ToolType[]; // Only show for specific agent types (if undefined, show for all)
}

// Built-in Maestro slash commands
// These are intercepted by Maestro and handled specially (not passed to the agent)
export const slashCommands: SlashCommand[] = [
	{
		command: '/history',
		description: 'Generate a synopsis of recent work and add to history',
		aiOnly: true,
	},
	{
		command: '/wizard',
		description: 'Start the planning wizard for Auto Run documents',
		aiOnly: true,
	},
	{
		command: '/skills',
		description: 'List available Claude Code skills for this project',
		aiOnly: true,
		agentTypes: ['claude-code'],
	},
];

/**
 * Explain a native Grok command refusal using the selected host's current catalog.
 * Advertisements contain no expandable prompt and authorize no ordinary chat send.
 * Until the admitted ACP sink accepts/revalidates their binding, even an advertised
 * command is unavailable. Never cache these receipts in Session.agentCommands.
 */
export async function getGrokSlashCommandRefusal(
	session: Session,
	tab: AITab | undefined,
	input: string
): Promise<string> {
	if (isSessionRemote(session)) {
		return 'Grok native slash commands are unavailable for SSH agents. No command was sent.';
	}
	// The current discovery API resolves the stored active tab. Never use that
	// catalog for a background queued tab or a fresh, unbound conversation.
	if (!tab?.agentSessionId || tab.id !== session.activeTabId) {
		return 'Grok native slash commands require discovery for this conversation. No command was sent.';
	}

	let result: GrokCommandDiscoveryResult | null;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		// A disconnected browser bridge can leave an IPC promise pending. Bound
		// this advisory read so a refusal cannot strand the queue in busy state.
		result = await Promise.race([
			window.maestro.agents.discoverSlashCommands({
				providerId: 'grok',
				context: {
					kind: 'agent',
					sessionId: session.id,
					model: tab.customModel || session.customModel,
					effort: tab.customEffort || session.customEffort,
				},
			}),
			new Promise<null>((resolve) => {
				timer = setTimeout(() => resolve(null), 3_000);
			}),
		]);
	} catch {
		// Do not expose rejected IPC payloads, account details or command arguments.
		logger.error('[GrokSlashCommands] Selected command discovery failed');
		return 'Grok command discovery failed. No command was sent.';
	} finally {
		clearTimeout(timer);
	}

	if (result?.status !== 'discovered') {
		switch (result?.reason) {
			case 'remote-unqualified':
				return 'Grok native slash commands are unavailable for SSH agents. No command was sent.';
			case 'managed-unqualified':
				return 'Grok native slash commands are unavailable on this managed host. No command was sent.';
			case 'executable-unavailable':
				return 'The selected Grok executable is unavailable for command discovery. No command was sent.';
			case 'canceled':
				return 'Grok command discovery was canceled. No command was sent.';
			case 'invalid-catalog':
				return 'Grok returned an invalid command catalog. No command was sent.';
			default:
				return 'Grok command discovery is unavailable for this conversation. No command was sent.';
		}
	}

	const binding = result.binding;
	if (
		binding?.route !== 'grok-acp' ||
		binding.sessionId !== tab.agentSessionId ||
		!binding.processGeneration ||
		!binding.configGeneration ||
		!binding.agentVersion ||
		!Number.isSafeInteger(binding.catalogRevision) ||
		binding.catalogRevision < 0 ||
		!Number.isFinite(binding.observedAt) ||
		binding.observedAt > Date.now() ||
		Date.now() - binding.observedAt >= 30_000
	) {
		return 'Grok command discovery is stale or belongs to another conversation. No command was sent.';
	}
	if (!Array.isArray(result.commands)) {
		return 'Grok returned an invalid command catalog. No command was sent.';
	}
	const name = input.trim().split(/\s+/, 1)[0].slice(1);
	if (!result.commands.some((command) => command?.name === name)) {
		return 'This command is not advertised for this Grok conversation. TUI-only actions and CLI subcommands cannot run through chat. No command was sent.';
	}
	return 'Grok advertised this command, but native command execution is not available in Maestro yet. No command was sent.';
}
