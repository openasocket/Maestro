// Slash commands - both built-in Maestro commands and custom AI commands
// Built-in commands are intercepted by Maestro before being sent to the agent

import type { AITab, Session, ToolType } from './types';
import type { GrokCommandDiscoveryResult } from '../main/agents/grok-skills';
import { isSessionRemote } from './utils/sessionHelpers';
import { logger } from './utils/logger';

export interface SlashCommand {
	command: string;
	description: string;
	prompt?: string;
	terminalOnly?: boolean; // Only show this command in terminal mode
	aiOnly?: boolean; // Only show this command in AI mode
	agentTypes?: ToolType[]; // Only show for specific agent types (if undefined, show for all)
	/** Advisory native metadata never supplies a prompt or grants invocation. */
	nativeCommand?: {
		provider: 'grok';
		metadata: GrokCommandDiscoveryResult['commands'][number];
		binding: NonNullable<GrokCommandDiscoveryResult['binding']>;
	};
	selectable?: false;
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

/** Narrow discovery inputs: no streamed logs, draft text or persisted command bodies. */
export function getGrokCommandScope(session: Session | null | undefined) {
	if (session?.toolType !== 'grok') return null;
	const tab = session.aiTabs.find((candidate) => candidate.id === session.activeTabId);
	return {
		sessionId: session.id,
		tabId: tab?.id,
		nativeSessionId: tab?.agentSessionId,
		nativeSessionBinding: tab?.nativeSessionBinding,
		cwd: session.cwd,
		projectRoot: session.projectRoot,
		customPath: session.customPath,
		customArgs: session.customArgs,
		customEnvVars: session.customEnvVars,
		model: tab?.customModel || session.customModel,
		effort: tab?.customEffort || session.customEffort,
		sshRemoteId: session.sshRemoteId,
		sshRemote: session.sshRemote,
		sshConfig: session.sessionSshRemoteConfig,
		pid: session.aiPid,
		state: tab?.state,
	};
}

/** IPC metadata is bounded and checked before any completion render dereferences it. */
function hasValidGrokCommandCatalog(commands: GrokCommandDiscoveryResult['commands']): boolean {
	return (
		Array.isArray(commands) &&
		commands.length <= 256 &&
		Array.from(commands).every(
			(command) =>
				command &&
				typeof command.name === 'string' &&
				command.name.length > 0 &&
				command.name.length <= 128 &&
				typeof command.description === 'string' &&
				command.description.length <= 4096 &&
				['skill', 'native-command', 'workflow'].includes(command.kind) &&
				(command.scope === undefined ||
					['local', 'repo', 'user', 'server', 'bundled', 'plugin'].includes(command.scope)) &&
				(command.argumentHint === undefined ||
					(typeof command.argumentHint === 'string' && command.argumentHint.length <= 1024))
		)
	);
}

/** One bounded read for completion and dispatch refusal; never starts a probe. */
export async function readGrokCommandDiscovery(
	session: Session,
	tab: AITab | undefined,
	signal?: AbortSignal
): Promise<GrokCommandDiscoveryResult | null> {
	if (signal?.aborted) return { status: 'unavailable', commands: [], reason: 'canceled' };
	if (isSessionRemote(session)) {
		return { status: 'unavailable', commands: [], reason: 'remote-unqualified' };
	}
	// Main resolves the stored active tab. Never borrow its catalog for a queued tab.
	if (!tab?.agentSessionId || tab.id !== session.activeTabId) {
		return { status: 'unavailable', commands: [], reason: 'missing-context' };
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	let cancel: (() => void) | undefined;
	try {
		// A disconnected browser bridge can leave an IPC promise pending.
		const result = await Promise.race([
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
				cancel = () => resolve(null);
				signal?.addEventListener('abort', cancel, { once: true });
			}),
		]);
		if (result?.status === 'discovered' && !hasValidGrokCommandCatalog(result.commands)) {
			return { status: 'unavailable', commands: [], reason: 'invalid-catalog' };
		}
		return result;
	} finally {
		clearTimeout(timer);
		if (cancel) signal?.removeEventListener('abort', cancel);
	}
}

export function hasCurrentGrokCommandBinding(
	result: GrokCommandDiscoveryResult,
	nativeSessionId: string | null | undefined
): boolean {
	const binding = result.binding;
	return !!(
		result.status === 'discovered' &&
		binding?.route === 'grok-acp' &&
		binding.sessionId === nativeSessionId &&
		binding.processGeneration &&
		binding.configGeneration &&
		binding.agentVersion &&
		Number.isSafeInteger(binding.catalogRevision) &&
		binding.catalogRevision >= 0 &&
		Number.isFinite(binding.observedAt) &&
		binding.observedAt <= Date.now() &&
		Date.now() - binding.observedAt < 30_000
	);
}

/** Preserve exact server names/provenance, but keep every native candidate unselectable. */
export function grokCommandCompletions(result: GrokCommandDiscoveryResult | null): SlashCommand[] {
	if (
		result?.status !== 'discovered' ||
		!result.binding ||
		!hasValidGrokCommandCatalog(result.commands)
	)
		return [];
	const binding = result.binding;
	return result.commands.map((command) => ({
		command: `/${command.name}`,
		description: command.description,
		aiOnly: true,
		nativeCommand: { provider: 'grok', metadata: command, binding },
		selectable: false,
	}));
}

/** Existing completion order: Maestro, custom/bundled macros, then provider entries. */
export function assembleSlashCommandCompletions({
	toolType,
	supportsProviderCommands,
	customCommands,
	agentCommands,
	grokDiscovery,
}: {
	toolType?: ToolType;
	supportsProviderCommands: boolean;
	customCommands: NonNullable<Session['agentCommands']>;
	agentCommands: Session['agentCommands'];
	grokDiscovery: GrokCommandDiscoveryResult | null;
}): SlashCommand[] {
	const candidates: SlashCommand[] = [
		...slashCommands.filter(
			(cmd) => !cmd.agentTypes || (toolType && cmd.agentTypes.includes(toolType))
		),
		...customCommands.map((cmd) => ({
			command: cmd.command,
			description: cmd.description,
			prompt: cmd.prompt,
			aiOnly: true,
		})),
		...(toolType !== 'grok' && supportsProviderCommands
			? (agentCommands ?? []).map((cmd) => ({
					command: cmd.command,
					description: cmd.description,
					aiOnly: true,
				}))
			: []),
		...(toolType === 'grok' ? grokCommandCompletions(grokDiscovery) : []),
	];
	// Native advertisements have no admitted invocation path yet. Keep them out
	// of keyboard/mouse completion, regardless of capability flags or name collisions.
	return candidates.filter((command) => command.selectable !== false);
}

/** Advertisements authorize no ordinary chat send, even for known native commands. */
export async function getGrokSlashCommandRefusal(
	session: Session,
	tab: AITab | undefined,
	input: string
): Promise<string> {
	let result: GrokCommandDiscoveryResult | null;
	try {
		result = await readGrokCommandDiscovery(session, tab);
	} catch {
		// Do not expose rejected IPC payloads, account details or command arguments.
		logger.error('[GrokSlashCommands] Selected command discovery failed');
		return 'Grok command discovery failed. No command was sent.';
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
			case 'missing-context':
				return 'Grok native slash commands require discovery for this conversation. No command was sent.';
			case 'invalid-catalog':
				return 'Grok returned an invalid command catalog. No command was sent.';
			default:
				return 'Grok command discovery is unavailable for this conversation. No command was sent.';
		}
	}

	if (!hasCurrentGrokCommandBinding(result, tab?.agentSessionId)) {
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
