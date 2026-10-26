/**
 * Preload API for AI command mode
 *
 * Provides the window.maestro.aiCommand namespace for turning a plain-English
 * request into one shell command line. This is only the suggestion round trip -
 * running the accepted command still goes through window.maestro.process, so a
 * suggested command and a typed `!` command execute through the same path.
 */

import { ipcRenderer } from 'electron';
import type { AiCommandHistoryEntry } from '../../shared/aiCommand';
import type { ClaudeTokenSourceFields } from '../../shared/claudeTokenMode';

export interface AiCommandSuggestRequest {
	/** The user's plain-English description of what they want to do. */
	request: string;
	/** Provider that owns the tab. */
	agentType: string;
	/** Directory the accepted command will run in. */
	cwd: string;
	isGitRepo?: boolean;
	sessionSshRemoteConfig?: {
		enabled: boolean;
		remoteId: string | null;
		workingDirOverride?: string;
	};
	sshRemoteName?: string;
	customPath?: string;
	customArgs?: string;
	customEnvVars?: Record<string, string>;
	/** The tab's current model and effort. */
	customModel?: string;
	customEffort?: string;
	/** The agent's Claude token source, so a TUI agent suggests through maestro-p. */
	claudeTokenSource?: ClaudeTokenSourceFields;
	/** Commands already run in this tab, oldest first, so follow-ups can refine. */
	recentCommands?: AiCommandHistoryEntry[];
	/**
	 * The agent and tab the suggestion serves (MRC2-02-02A), so the main
	 * process traces the turn beside that tab's own turns. Attribution only:
	 * the ids lend the turn nothing. Both optional; a tab without its agent is
	 * refused.
	 */
	sessionId?: string;
	tabId?: string;
}

export interface AiCommandSuggestResult {
	success: boolean;
	command?: string;
	error?: string;
}

export function createAiCommandApi() {
	return {
		suggest: (config: AiCommandSuggestRequest): Promise<AiCommandSuggestResult> =>
			ipcRenderer.invoke('aiCommand:suggest', config),
	};
}

export type AiCommandApi = ReturnType<typeof createAiCommandApi>;
