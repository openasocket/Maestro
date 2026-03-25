/**
 * Preload API for Team Generation operations
 *
 * Provides the window.maestro.teamGeneration namespace for:
 * - AI-powered team structure generation
 */

import { ipcRenderer } from 'electron';
import type { RoleTier } from '../../shared/group-chat-types';

export interface TeamGenerationRequest {
	description: string;
	teamSize?: 'small' | 'medium' | 'large' | 'auto';
	rigor?: 'light' | 'standard' | 'strict';
	domain?: string;
	specializations?: string[];
}

export interface TeamGenerationResult {
	name: string;
	description: string;
	roles: Array<{
		name: string;
		tier: RoleTier;
		agentId: string;
		description: string;
		prompt: string;
		reportsTo?: string;
	}>;
}

export interface TeamGenerationApi {
	generate: (request: TeamGenerationRequest) => Promise<TeamGenerationResult>;
}

/**
 * Creates the Team Generation API object for preload exposure
 */
export function createTeamGenerationApi(): TeamGenerationApi {
	return {
		generate: (request: TeamGenerationRequest): Promise<TeamGenerationResult> =>
			ipcRenderer.invoke('teamGeneration:generate', request),
	};
}
