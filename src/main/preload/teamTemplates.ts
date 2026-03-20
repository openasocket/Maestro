/**
 * Preload API for Team Template operations
 *
 * Provides the window.maestro.teamTemplates namespace for:
 * - Template CRUD (list, get, save, delete, duplicate)
 * - Creating a template from an existing Group Chat
 */

import { ipcRenderer } from 'electron';
import type { TeamTemplate } from '../../shared/group-chat-types';

export interface TeamTemplatesApi {
	list: () => Promise<TeamTemplate[]>;
	get: (id: string) => Promise<TeamTemplate | null>;
	save: (template: TeamTemplate) => Promise<void>;
	delete: (id: string) => Promise<void>;
	duplicate: (id: string, newName: string) => Promise<TeamTemplate>;
	createFromChat: (chatId: string, name?: string, description?: string) => Promise<TeamTemplate>;
}

/**
 * Creates the Team Templates API object for preload exposure
 */
export function createTeamTemplatesApi(): TeamTemplatesApi {
	return {
		list: (): Promise<TeamTemplate[]> => ipcRenderer.invoke('teamTemplate:list'),

		get: (id: string): Promise<TeamTemplate | null> => ipcRenderer.invoke('teamTemplate:get', id),

		save: (template: TeamTemplate): Promise<void> =>
			ipcRenderer.invoke('teamTemplate:save', template),

		delete: (id: string): Promise<void> => ipcRenderer.invoke('teamTemplate:delete', id),

		duplicate: (id: string, newName: string): Promise<TeamTemplate> =>
			ipcRenderer.invoke('teamTemplate:duplicate', id, newName),

		createFromChat: (chatId: string, name?: string, description?: string): Promise<TeamTemplate> =>
			ipcRenderer.invoke('teamTemplate:createFromChat', chatId, name, description),
	};
}
