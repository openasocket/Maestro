/**
 * @file teamTemplates.ts
 * @description IPC handlers for Team Templates feature.
 *
 * Provides handlers for:
 * - Template CRUD operations (list, get, save, delete, duplicate)
 * - Creating a template from an existing Group Chat configuration
 *
 * All handlers are gated behind the teamOrchestration Encore feature flag.
 */

import { ipcMain } from 'electron';
import { withIpcErrorLogging, CreateHandlerOptions } from '../../utils/ipcHandler';
import { logger } from '../../utils/logger';
import { v4 as uuidv4 } from 'uuid';

// Team template storage imports
import {
	listTemplates,
	getTemplate,
	saveTemplate,
	deleteTemplate,
	duplicateTemplate,
} from '../../group-chat/team-template-storage';

// Group chat storage for createFromChat
import { loadGroupChat } from '../../group-chat/group-chat-storage';

import type { TeamTemplate, TeamTemplateRole } from '../../../shared/group-chat-types';

const LOG_CONTEXT = '[TeamTemplates]';

// Helper to create handler options with consistent context
const handlerOpts = (operation: string): Pick<CreateHandlerOptions, 'context' | 'operation'> => ({
	context: LOG_CONTEXT,
	operation,
});

/**
 * Register all Team Template IPC handlers.
 *
 * These handlers provide:
 * - CRUD: list, get, save, delete, duplicate
 * - createFromChat: create a template from an existing Group Chat's configuration
 */
export function registerTeamTemplateHandlers(): void {
	// List all team templates
	ipcMain.handle(
		'teamTemplate:list',
		withIpcErrorLogging(handlerOpts('list'), async (): Promise<TeamTemplate[]> => {
			logger.debug('Listing team templates', LOG_CONTEXT);
			const templates = await listTemplates();
			logger.debug(`Found ${templates.length} team templates`, LOG_CONTEXT);
			return templates;
		})
	);

	// Get a single team template by ID
	ipcMain.handle(
		'teamTemplate:get',
		withIpcErrorLogging(handlerOpts('get'), async (id: string): Promise<TeamTemplate | null> => {
			logger.debug(`Getting team template: ${id}`, LOG_CONTEXT);
			return getTemplate(id);
		})
	);

	// Save (create or update) a team template
	ipcMain.handle(
		'teamTemplate:save',
		withIpcErrorLogging(handlerOpts('save'), async (template: TeamTemplate): Promise<void> => {
			logger.info(`Saving team template: ${template.id} (${template.name})`, LOG_CONTEXT);
			await saveTemplate(template);
		})
	);

	// Delete a team template (only user-created templates)
	ipcMain.handle(
		'teamTemplate:delete',
		withIpcErrorLogging(handlerOpts('delete'), async (id: string): Promise<void> => {
			logger.info(`Deleting team template: ${id}`, LOG_CONTEXT);
			await deleteTemplate(id);
		})
	);

	// Duplicate a team template with a new name
	ipcMain.handle(
		'teamTemplate:duplicate',
		withIpcErrorLogging(
			handlerOpts('duplicate'),
			async (id: string, newName: string): Promise<TeamTemplate> => {
				logger.info(`Duplicating team template: ${id} as "${newName}"`, LOG_CONTEXT);
				return duplicateTemplate(id, newName);
			}
		)
	);

	// Create a template from an existing Group Chat's configuration
	ipcMain.handle(
		'teamTemplate:createFromChat',
		withIpcErrorLogging(
			handlerOpts('createFromChat'),
			async (chatId: string, name?: string, description?: string): Promise<TeamTemplate> => {
				logger.info(`Creating template from group chat: ${chatId}`, LOG_CONTEXT);

				const chat = await loadGroupChat(chatId);
				if (!chat) {
					throw new Error(`Group chat not found: ${chatId}`);
				}

				// Convert participants to template roles
				const roles: TeamTemplateRole[] = chat.participants.map((p) => ({
					name: p.name,
					agentId: p.agentId,
					description: `Role derived from group chat participant "${p.name}".`,
				}));

				const now = Date.now();
				const template: TeamTemplate = {
					id: uuidv4(),
					name: name || `Template from ${chat.name}`,
					description: description || `Team template created from group chat "${chat.name}".`,
					category: 'user',
					createdAt: now,
					updatedAt: now,
					moderatorAgentId: chat.moderatorAgentId,
					moderatorConfig: chat.moderatorConfig
						? {
								customArgs: chat.moderatorConfig.customArgs,
								customEnvVars: chat.moderatorConfig.customEnvVars,
							}
						: undefined,
					roles,
				};

				await saveTemplate(template);
				logger.info(
					`Created template "${template.name}" (${template.id}) from chat "${chat.name}"`,
					LOG_CONTEXT
				);
				return template;
			}
		)
	);
}
