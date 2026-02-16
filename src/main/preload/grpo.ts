/**
 * Preload API for GRPO operations
 *
 * Provides the window.maestro.grpo namespace for:
 * - Experience library management
 * - Reward collection
 * - GRPO stats and configuration
 */

import { ipcRenderer } from 'electron';

export function createGrpoApi() {
	return {
		getConfig: (): Promise<{ success: boolean; data?: any; error?: string }> =>
			ipcRenderer.invoke('grpo:getConfig'),
		setConfig: (config: Record<string, unknown>): Promise<{ success: boolean; error?: string }> =>
			ipcRenderer.invoke('grpo:setConfig', config),
		getLibrary: (projectPath: string, scope?: string): Promise<{ success: boolean; data?: any[]; error?: string }> =>
			ipcRenderer.invoke('grpo:getLibrary', projectPath, scope),
		addExperience: (projectPath: string, entry: Record<string, unknown>): Promise<{ success: boolean; data?: any; error?: string }> =>
			ipcRenderer.invoke('grpo:addExperience', projectPath, entry),
		modifyExperience: (projectPath: string, id: string, updates: Record<string, unknown>): Promise<{ success: boolean; data?: any; error?: string }> =>
			ipcRenderer.invoke('grpo:modifyExperience', projectPath, id, updates),
		deleteExperience: (projectPath: string, id: string): Promise<{ success: boolean; error?: string }> =>
			ipcRenderer.invoke('grpo:deleteExperience', projectPath, id),
		getHistory: (projectPath: string, limit?: number): Promise<{ success: boolean; data?: any[]; error?: string }> =>
			ipcRenderer.invoke('grpo:getHistory', projectPath, limit),
		collectRewards: (projectPath: string, exitCode: number, agentOutput: string): Promise<{ success: boolean; data?: any[]; error?: string }> =>
			ipcRenderer.invoke('grpo:collectRewards', projectPath, exitCode, agentOutput),
		getStats: (projectPath: string): Promise<{ success: boolean; data?: any; error?: string }> =>
			ipcRenderer.invoke('grpo:getStats', projectPath),
		pruneLibrary: (projectPath: string): Promise<{ success: boolean; data?: string[]; error?: string }> =>
			ipcRenderer.invoke('grpo:pruneLibrary', projectPath),
		exportLibrary: (projectPath: string): Promise<{ success: boolean; data?: string; error?: string }> =>
			ipcRenderer.invoke('grpo:exportLibrary', projectPath),
		importLibrary: (projectPath: string, json: string): Promise<{ success: boolean; data?: number; error?: string }> =>
			ipcRenderer.invoke('grpo:importLibrary', projectPath, json),
		// Symphony Collector (Auto Run signal collection)
		onAutoRunTaskComplete: (
			taskContent: string, projectPath: string, agentType: string, sessionId: string,
			exitCode: number, output: string, durationMs: number, documentPath: string,
		): Promise<{ success: boolean; data?: any; error?: string }> =>
			ipcRenderer.invoke('grpo:onAutoRunTaskComplete', taskContent, projectPath, agentType, sessionId, exitCode, output, durationMs, documentPath),
		onAutoRunBatchComplete: (projectPath: string, batchResults: any[]): Promise<{ success: boolean; data?: any; error?: string }> =>
			ipcRenderer.invoke('grpo:onAutoRunBatchComplete', projectPath, batchResults),
		getTrainingReadiness: (projectPath: string): Promise<{ success: boolean; data?: any; error?: string }> =>
			ipcRenderer.invoke('grpo:getTrainingReadiness', projectPath),
		formNaturalRolloutGroups: (projectPath: string): Promise<{ success: boolean; data?: any[]; error?: string }> =>
			ipcRenderer.invoke('grpo:formNaturalRolloutGroups', projectPath),
		// Embedding model status and cache management
		getModelStatus: (): Promise<{ success: boolean; data?: string; error?: string }> =>
			ipcRenderer.invoke('grpo:getModelStatus'),
		clearModelCache: (): Promise<{ success: boolean; error?: string }> =>
			ipcRenderer.invoke('grpo:clearModelCache'),
		// Download progress event listener (for first-run model download)
		onModelDownloadProgress: (callback: (info: { progress: number; file?: string; done?: boolean }) => void): (() => void) => {
			const handler = (_event: any, info: any) => callback(info);
			ipcRenderer.on('grpo:model-download-progress', handler);
			return () => { ipcRenderer.removeListener('grpo:model-download-progress', handler); };
		},
	};
}

export type GrpoApi = ReturnType<typeof createGrpoApi>;
