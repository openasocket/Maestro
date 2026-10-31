/**
 * IPC handlers for per-project memory (Claude Code).
 *
 * Surface consumed by the renderer Memory Viewer.
 */

import { ipcMain } from 'electron';
import {
	listMemoryEntries,
	readMemoryEntry,
	writeMemoryEntry,
	createMemoryEntry,
	deleteMemoryEntry,
	getMemoryDirectoryPath,
	searchMemoryEntries,
	findOrphanMemories,
} from '../../memory-manager';
import { logger } from '../../utils/logger';
import { redactSecrets } from '../../../shared/redactSecrets';

import * as path from 'node:path';
import * as os from 'node:os';
import { buildAgentEnvironment } from '../../../shared/maestro-lib/launch/env';
import { resolveAgentAccountKey } from '../../../shared/providerProfiles';
import {
	discoverClaudeMemoryPath,
	resolveMemoryRepositoryRoot,
} from '../../../shared/maestro-lib/translation/memory';
import { assertTranslationTarget } from '../../../shared/maestro-lib/translation/resource-projections';
import { execGitReadOnly } from '../../utils/remote-git';
import type { ProviderTranslationDependencies } from '../../provider-translation-service';

const LOG_CONTEXT = '[IPC:Memory]';

export function registerMemoryHandlers(
	deps?: Pick<
		ProviderTranslationDependencies,
		'sessionsStore' | 'settingsStore' | 'agentConfigsStore' | 'getAgentDetector'
	>
): void {
	const directoryFor = async (
		projectPath: string,
		agentId: string
	): Promise<string | undefined> => {
		const session = deps?.sessionsStore.get('sessions', []).find((s) => s.id === agentId);
		if (!session) return undefined;
		if (
			session.sessionSshRemoteConfig?.enabled ||
			session.sshRemoteId ||
			path.resolve(session.projectRoot || session.cwd) !== path.resolve(projectPath)
		)
			throw new Error('Memory scope does not match the selected local agent');
		const managed = session.providerTranslationKnowledgeDirectory as string | undefined;
		if (managed) {
			await assertTranslationTarget(path.join(managed, 'memory', 'MEMORY.md'), projectPath);
			return path.join(managed, 'memory');
		}
		// Resolve native support by provider, not the selected Maestro agent's ID.
		// A bound translation directory above does not certify native memory support.
		if (session.toolType !== 'claude-code')
			return getMemoryDirectoryPath(projectPath, session.toolType);
		const config = deps!.agentConfigsStore.get('configs', {})['claude-code'];
		const detected = await deps!.getAgentDetector()?.getAgent('claude-code');
		const env = buildAgentEnvironment({
			surface: 'desktop',
			globalShellEnvVars: deps!.settingsStore.get('shellEnvVars', {}) as Record<string, string>,
			defaultEnvVars: detected?.defaultEnvVars,
			sessionCustomEnvVars: session.customEnvVars,
			agentCustomEnvVars: config?.customEnvVars,
		});
		const accountRoot = resolveAgentAccountKey(
			'claude-code',
			env as Record<string, string>,
			os.homedir()
		);
		if (!accountRoot) throw new Error('Claude account root unavailable');
		const memoryProjectRoot = await resolveMemoryRepositoryRoot(projectPath, async (cwd) => {
			const result = await execGitReadOnly(['rev-parse', '--git-common-dir'], cwd);
			return result.exitCode === 0 ? result.stdout : undefined;
		});
		return discoverClaudeMemoryPath(projectPath, accountRoot, memoryProjectRoot);
	};
	ipcMain.handle(
		'memory:list',
		async (_event, projectPath: string, agentId: string = 'claude-code') => {
			try {
				const result = await listMemoryEntries(
					projectPath,
					agentId,
					undefined,
					await directoryFor(projectPath, agentId)
				);
				return { success: true, ...result };
			} catch (error) {
				const message = redactSecrets(String(error)).text;
				logger.error(`Failed to list memory entries: ${message}`, LOG_CONTEXT);
				return { success: false, error: message };
			}
		}
	);

	ipcMain.handle(
		'memory:read',
		async (_event, projectPath: string, filename: string, agentId: string = 'claude-code') => {
			try {
				const content = await readMemoryEntry(
					projectPath,
					filename,
					agentId,
					undefined,
					await directoryFor(projectPath, agentId)
				);
				return { success: true, content };
			} catch (error) {
				const message = redactSecrets(String(error)).text;
				logger.error(`Failed to read memory: ${message}`, LOG_CONTEXT);
				return { success: false, error: message };
			}
		}
	);

	ipcMain.handle(
		'memory:write',
		async (
			_event,
			projectPath: string,
			filename: string,
			content: string,
			agentId: string = 'claude-code'
		) => {
			try {
				await writeMemoryEntry(
					projectPath,
					filename,
					content,
					agentId,
					undefined,
					await directoryFor(projectPath, agentId)
				);
				return { success: true };
			} catch (error) {
				const message = redactSecrets(String(error)).text;
				logger.error(`Failed to write memory: ${message}`, LOG_CONTEXT);
				return { success: false, error: message };
			}
		}
	);

	ipcMain.handle(
		'memory:create',
		async (
			_event,
			projectPath: string,
			filename: string,
			content: string,
			agentId: string = 'claude-code'
		) => {
			try {
				await createMemoryEntry(
					projectPath,
					filename,
					content,
					agentId,
					undefined,
					await directoryFor(projectPath, agentId)
				);
				return { success: true };
			} catch (error) {
				const message = redactSecrets(String(error)).text;
				logger.error(`Failed to create memory: ${message}`, LOG_CONTEXT);
				return { success: false, error: message };
			}
		}
	);

	ipcMain.handle(
		'memory:delete',
		async (_event, projectPath: string, filename: string, agentId: string = 'claude-code') => {
			try {
				await deleteMemoryEntry(
					projectPath,
					filename,
					agentId,
					undefined,
					await directoryFor(projectPath, agentId)
				);
				return { success: true };
			} catch (error) {
				const message = redactSecrets(String(error)).text;
				logger.error(`Failed to delete memory: ${message}`, LOG_CONTEXT);
				return { success: false, error: message };
			}
		}
	);

	ipcMain.handle(
		'memory:search',
		async (_event, projectPath: string, query: string, agentId: string = 'claude-code') => {
			try {
				const matches = await searchMemoryEntries(
					projectPath,
					query,
					agentId,
					undefined,
					await directoryFor(projectPath, agentId)
				);
				return { success: true, matches };
			} catch (error) {
				const message = redactSecrets(String(error)).text;
				logger.error(`Failed to search memory: ${message}`, LOG_CONTEXT);
				return { success: false, error: message };
			}
		}
	);

	ipcMain.handle(
		'memory:orphans',
		async (_event, projectPath: string, agentId: string = 'claude-code') => {
			try {
				const report = await findOrphanMemories(
					projectPath,
					agentId,
					undefined,
					await directoryFor(projectPath, agentId)
				);
				return { success: true, ...report };
			} catch (error) {
				const message = redactSecrets(String(error)).text;
				logger.error(`Failed to find orphan memories: ${message}`, LOG_CONTEXT);
				return { success: false, error: message };
			}
		}
	);

	ipcMain.handle(
		'memory:getPath',
		async (_event, projectPath: string, agentId: string = 'claude-code') => {
			try {
				return {
					success: true,
					path: getMemoryDirectoryPath(
						projectPath,
						agentId,
						undefined,
						await directoryFor(projectPath, agentId)
					),
				};
			} catch (error) {
				const message = redactSecrets(String(error)).text;
				logger.error(`Failed to resolve memory path: ${message}`, LOG_CONTEXT);
				return { success: false, error: message };
			}
		}
	);

	logger.info('Memory IPC handlers registered', LOG_CONTEXT);
}
