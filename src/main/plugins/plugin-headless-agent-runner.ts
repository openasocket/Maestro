/**
 * One host-owned, headless provider turn, shared by plugin send and CLI send.
 * Under management (MRC-09-02) it is admitted by the host's own spawn
 * authority (`deps.managed`, through `pluginHeadlessAuthority`), not by the
 * data dir's binding, which on an enrolled desktop holds no authority.
 */
import type { SessionInfo } from '../../shared/types';
import type { ProcessSpawnAuthorityPort } from '../process-manager/types';
import type { HeadlessSpawnAuthority } from '../../shared/maestro-lib/managed/host-adapter';
import type { ManagedPrincipalRef } from '../../shared/maestro-lib/managed/types';
import { RELAY_PLUGIN_ID } from '../../shared/plugins/relay-identity';
import { pluginPrincipal } from './plugin-host-handlers';
import type { AgentResult, SpawnAgentOptions } from '../../cli/services/agent-spawner';
import type { HeadlessAgentRunner } from './plugin-manager-singleton';
import { createPluginRunProofFile, removePluginRunProofFile } from './plugin-tool-run-identity';
import type { PluginToolReceipt } from './plugin-tool-run-identity';
import { MCP_CONFIG_BY_AGENT } from '../../shared/plugins/mcp-agent-config';
import { logger } from '../utils/logger';
import { captureException } from '../utils/sentry';
import { getClaudeTokenMode } from '../../shared/claudeTokenMode';
import { trackHeadlessAgentActivity } from '../utils/headless-agent-activity';
import { checkCustomPath } from '../agents/path-prober';

import {
	HEADLESS_RUN_TIMEOUT_MS,
	HEADLESS_RUN_COMPLETION_TIMEOUT_MS,
} from '../../shared/plugins/headless-agent-timeouts';

export interface PluginHeadlessRunnerDeps {
	getAgent: (agentId: string) => SessionInfo | undefined;
	detectAgent: (type: SessionInfo['toolType']) => Promise<{ available: boolean; path?: string }>;
	getAgentConfig?: (type: SessionInfo['toolType']) => Record<string, unknown>;
	getGlobalEnvVars?: () => Record<string, string>;
	hasPluginTools: () => boolean;
	spawn: (
		type: SessionInfo['toolType'],
		cwd: string,
		prompt: string,
		sessionId?: string,
		options?: SpawnAgentOptions
	) => Promise<AgentResult>;
	prepareSystemPrompt: (agent: SessionInfo) => Promise<string | undefined>;
	issueRunToken: (agentId: string, ttlMs: number, receiptToolId?: string) => string;
	getRunReceipts?: (token: string) => PluginToolReceipt[];
	hasRunReceiptOverflow?: (token: string) => boolean;
	revokeRunToken: (token: string) => void;
	cliScriptPath: () => string;
	audit: (agentId: string, resumed: boolean) => void;
	recordRelayOrigin?: (agent: SessionInfo, providerSessionId: string) => void;
	/**
	 * The host's managed spawn authority, read per run (MRC-09-02). Present and
	 * managed, the turn is admitted by this host with the origin's plugin on the
	 * chain; standalone runs as before; absent or null, the spawner reads the
	 * data dir's binding. Never a way to opt out: a refusal is the turn's result.
	 */
	managed?: () => ProcessSpawnAuthorityPort | null;
}

/**
 * The chain a headless plugin turn carries, by what the caller said of itself:
 * the Relay plugin for a Relay conversation (the one caller that names itself
 * through the origin), nothing for a turn no plugin is named for. Threading
 * the calling plugin's consent-bound binding through `agents.send` is
 * MRC-09-02A; until then an `auto` turn is a direct action of this process.
 */
export function pluginHeadlessChain(origin: 'user' | 'auto' | 'relay'): ManagedPrincipalRef[] {
	return origin === 'relay' ? [pluginPrincipal(RELAY_PLUGIN_ID)] : [];
}

/**
 * The host's spawn authority under the shape the CLI spawner admits with: the
 * process sink's standing, authority and policy, the context bound through the
 * port's own verifier as an in-process action (no transport carried a plugin)
 * with the chain the caller names, so the lease records the plugin behind the
 * turn. A caller that already carries a chain keeps it; nothing is widened.
 */
export function pluginHeadlessAuthority(
	port: ProcessSpawnAuthorityPort,
	chain: readonly ManagedPrincipalRef[]
): HeadlessSpawnAuthority {
	return {
		standing: () => port.standing(),
		get authority() {
			return port.authority;
		},
		policy: () => port.policy(),
		unavailableReason: null,
		context: (input) =>
			port.verify({
				actor: { peer: 'in-process' },
				identity: input.identity,
				traceId: input.traceId,
				policyRevision: input.policyRevision,
				workflow: input.workflow ?? null,
				...(input.delegation
					? { delegation: input.delegation }
					: chain.length > 0
						? { delegation: { chain: [...chain], grantRef: null } }
						: {}),
			}),
	};
}

/** Build a cancellable host turn using live desktop provider settings and execution mode.
 * Required tools/receipts fail before spawn when no authenticated local MCP bridge exists.
 * Every issued proof is revoked in finally, including provider and cleanup failures.
 */
export function createPluginHeadlessAgentRunner(
	deps: PluginHeadlessRunnerDeps
): HeadlessAgentRunner {
	return async (
		agentId,
		prompt,
		providerSessionId,
		signal,
		origin = 'auto',
		onProgress,
		receiptToolId,
		requirePluginTools = false
	) => {
		const agent = deps.getAgent(agentId);
		if (!agent) throw new Error(`agents.send: no agent "${agentId}"`);
		const local = !agent.sessionSshRemoteConfig?.enabled;
		if (
			(receiptToolId || requirePluginTools) &&
			(!local ||
				!MCP_CONFIG_BY_AGENT[agent.toolType]?.verified ||
				(agent.toolType === 'claude-code' && getClaudeTokenMode(agent) !== 'api') ||
				!deps.hasPluginTools() ||
				(!!receiptToolId && (!deps.getRunReceipts || !deps.hasRunReceiptOverflow)))
		) {
			return {
				success: false,
				response: null,
				sessionId: null,
				error: receiptToolId
					? 'Authenticated plugin tool receipt unavailable'
					: 'Authenticated plugin tools unavailable',
			};
		}
		const customBinary =
			local && agent.customPath ? await checkCustomPath(agent.customPath) : undefined;
		const detection = local
			? customBinary
				? { available: customBinary.exists, path: customBinary.path }
				: await deps.detectAgent(agent.toolType)
			: undefined;
		if (local && !detection?.available) {
			return {
				success: false,
				response: null,
				sessionId: null,
				error: `Agent CLI unavailable: ${agent.toolType}`,
			};
		}
		const runToken =
			local && deps.hasPluginTools()
				? deps.issueRunToken(agent.id, HEADLESS_RUN_COMPLETION_TIMEOUT_MS, receiptToolId)
				: undefined;
		let pluginRunProofFile: string | undefined;
		let releaseActivity: (() => void) | undefined;
		let settled = false;
		let conversationId = providerSessionId;
		try {
			pluginRunProofFile = runToken
				? createPluginRunProofFile(runToken, HEADLESS_RUN_COMPLETION_TIMEOUT_MS)
				: undefined;
			deps.audit(agent.id, !!providerSessionId);
			// The host's own authority admits the turn (read now, so an enrollment
			// that appeared since the last run governs this one).
			const port = deps.managed?.() ?? null;
			const managed = port ? pluginHeadlessAuthority(port, pluginHeadlessChain(origin)) : undefined;
			if (signal?.aborted) {
				return {
					success: false,
					response: null,
					sessionId: null,
					error: 'Agent run timed out or was cancelled',
				};
			}
			const result = await deps.spawn(agent.toolType, agent.cwd, prompt, providerSessionId, {
				customModel: agent.customModel,
				customEffort: agent.customEffort,
				customArgs: agent.customArgs,
				customEnvVars: agent.customEnvVars,
				globalEnvVars: deps.getGlobalEnvVars?.(),
				agentConfigValues: deps.getAgentConfig?.(agent.toolType),
				agentCommand: detection?.path,
				additionalDirectories: agent.additionalDirectories,
				sshRemoteConfig: agent.sessionSshRemoteConfig,
				appendSystemPrompt: await deps.prepareSystemPrompt(agent),
				enableMaestroP: agent.enableMaestroP,
				maestroPMode: agent.maestroPMode,
				maestroPPath: agent.maestroPPath,
				querySource: origin === 'relay' ? 'auto' : origin,
				...(managed ? { managed } : {}),
				pluginRunProofFile,
				mcpCliScriptPath: deps.cliScriptPath(),
				timeoutMs: HEADLESS_RUN_TIMEOUT_MS,
				signal,
				onProcessStarted: (pid) => {
					if (pid && !signal?.aborted && !settled && !releaseActivity) {
						releaseActivity = trackHeadlessAgentActivity(agent.id);
					}
				},
				onProgress,
			});
			conversationId = result.agentSessionId || providerSessionId;

			const receiptsOverflowed =
				!!receiptToolId && !!runToken && deps.hasRunReceiptOverflow!(runToken);
			const success =
				result.success &&
				typeof result.response === 'string' &&
				result.response.trim().length > 0 &&
				!signal?.aborted &&
				!receiptsOverflowed;
			return {
				success,
				response: success ? result.response! : null,
				sessionId: result.agentSessionId ?? null,
				usageStats: result.usageStats,
				...(receiptToolId && runToken ? { toolReceipts: deps.getRunReceipts!(runToken) } : {}),
				...(success
					? {}
					: {
							error: receiptsOverflowed
								? `Plugin tool receipt limit exceeded; inspect recorded receipts before retrying${result.error ? `; provider error: ${result.error}` : ''}`
								: (result.error ?? 'Agent run failed or returned no final text'),
						}),
			};
		} finally {
			settled = true;
			releaseActivity?.();
			// Provenance belongs to the conversation even when delivery is cancelled.
			// The broker deliberately refuses late results/bindings on plugin stop;
			// recording here preserves origin without granting resume authority.
			if (origin === 'relay' && conversationId) {
				try {
					deps.recordRelayOrigin?.(agent, conversationId);
				} catch (error) {
					// Keep the original exception; reporting must not delay authority cleanup.
					void captureException(error, { operation: 'plugin-headless.recordRelayOrigin' });
				}
			}
			// Revoke authority even if removing the on-disk proof fails.
			if (runToken) deps.revokeRunToken(runToken);
			if (pluginRunProofFile) {
				try {
					removePluginRunProofFile(pluginRunProofFile);
				} catch (error) {
					logger.warn('Could not remove plugin run proof file', '[PluginRunIdentity]', {
						error: String(error),
					});
				}
			}
		}
	};
}
