/**
 * Preload API for VIBES integration
 *
 * Provides the window.maestro.vibes namespace for:
 * - Checking VIBES initialization status
 * - Initializing VIBES audit directories
 * - Getting stats, blame, log, coverage, and report data
 * - Listing sessions and models
 * - Building audit manifests
 * - Finding the vibecheck binary
 * - Key management and attestation (VERIFY spec)
 */

import { ipcRenderer } from 'electron';

import type { VibesAssuranceLevel, VibesActivityFeedEvent } from '../../shared/vibes-types';

/**
 * Standard result type for VIBES CLI commands.
 */
export interface VibesCommandResult {
	success: boolean;
	data?: string;
	error?: string;
}

/**
 * Result from the vibes:findBinary IPC call.
 */
export interface VibesBinaryInfo {
	path: string | null;
	version: string | null;
}

/**
 * Configuration for vibecheck init.
 */
export interface VibesInitConfig {
	projectName: string;
	assuranceLevel: VibesAssuranceLevel;
	extensions?: string[];
}

/**
 * Options for vibecheck log filtering.
 */
export interface VibesLogOptions {
	file?: string;
	model?: string;
	session?: string;
	limit?: number;
	json?: boolean;
}

/**
 * Standard result type for VIBES attestation commands.
 */
export interface VibesAttestationResult {
	success: boolean;
	data?: unknown;
	error?: string;
}

/**
 * Payload for the `vibes:annotation-update` event emitted by the main process
 * whenever annotations are written. Used by the renderer for live counts.
 */
export interface VibesAnnotationUpdatePayload {
	sessionId: string;
	annotationCount: number;
	lastAnnotation: {
		type: string;
		filePath?: string;
		action?: string;
		timestamp: string;
	};
}

/**
 * Creates the VIBES API object for preload exposure.
 */
export function createVibesApi() {
	return {
		isInitialized: (projectPath: string): Promise<boolean> =>
			ipcRenderer.invoke('vibes:isInitialized', projectPath),

		init: (
			projectPath: string,
			config: VibesInitConfig
		): Promise<{ success: boolean; error?: string }> =>
			ipcRenderer.invoke('vibes:init', projectPath, config),

		updateConfig: (
			projectPath: string,
			updates: Record<string, unknown>
		): Promise<{ success: boolean; error?: string }> =>
			ipcRenderer.invoke('vibes:updateConfig', projectPath, updates),

		getStats: (projectPath: string, file?: string): Promise<VibesCommandResult> =>
			ipcRenderer.invoke('vibes:getStats', projectPath, file),

		getBlame: (projectPath: string, file: string): Promise<VibesCommandResult> =>
			ipcRenderer.invoke('vibes:getBlame', projectPath, file),

		getLog: (projectPath: string, options?: VibesLogOptions): Promise<VibesCommandResult> =>
			ipcRenderer.invoke('vibes:getLog', projectPath, options),

		getCoverage: (projectPath: string): Promise<VibesCommandResult> =>
			ipcRenderer.invoke('vibes:getCoverage', projectPath),

		getLocCoverage: (projectPath: string): Promise<VibesCommandResult> =>
			ipcRenderer.invoke('vibes:getLocCoverage', projectPath),

		getReport: (
			projectPath: string,
			format?: 'markdown' | 'html' | 'json'
		): Promise<VibesCommandResult> => ipcRenderer.invoke('vibes:getReport', projectPath, format),

		getSessions: (projectPath: string): Promise<VibesCommandResult> =>
			ipcRenderer.invoke('vibes:getSessions', projectPath),

		getModels: (projectPath: string): Promise<VibesCommandResult> =>
			ipcRenderer.invoke('vibes:getModels', projectPath),

		getManifest: (projectPath: string): Promise<VibesCommandResult> =>
			ipcRenderer.invoke('vibes:getManifest', projectPath),

		build: (projectPath: string): Promise<{ success: boolean; error?: string }> =>
			ipcRenderer.invoke('vibes:build', projectPath),

		findBinary: (customPath?: string): Promise<VibesBinaryInfo> =>
			ipcRenderer.invoke('vibes:findBinary', customPath),

		clearBinaryCache: (): Promise<void> => ipcRenderer.invoke('vibes:clearBinaryCache'),

		validateDelegationChain: (projectPath: string): Promise<VibesCommandResult> =>
			ipcRenderer.invoke('vibes:validateDelegationChain', projectPath),

		decompressReasoning: (params: {
			compressed?: string | null;
			blobPath?: string | null;
			projectPath?: string | null;
		}): Promise<{ text: string | null; error: string | null }> =>
			ipcRenderer.invoke('vibes:decompress-reasoning', params),

		/**
		 * Subscribe to live annotation update events from the main process.
		 * Emitted whenever the VibesCoordinator records an annotation.
		 * Returns a cleanup function to unsubscribe.
		 */
		onAnnotationUpdate: (
			callback: (payload: VibesAnnotationUpdatePayload) => void
		): (() => void) => {
			const handler = (_: unknown, payload: VibesAnnotationUpdatePayload) => callback(payload);
			ipcRenderer.on('vibes:annotation-update', handler);
			return () => ipcRenderer.removeListener('vibes:annotation-update', handler);
		},

		/**
		 * Subscribe to live activity feed events from the main process.
		 * Emitted by the VibesCoordinator for real-time insights display.
		 * Returns a cleanup function to unsubscribe.
		 */
		onActivityFeed: (callback: (event: VibesActivityFeedEvent) => void): (() => void) => {
			const handler = (_: unknown, event: VibesActivityFeedEvent) => callback(event);
			ipcRenderer.on('vibes:activity-feed', handler);
			return () => ipcRenderer.removeListener('vibes:activity-feed', handler);
		},

		/**
		 * Subscribe to key permission warnings emitted on startup.
		 * Fires once if the signing key has incorrect file permissions.
		 * Returns a cleanup function to unsubscribe.
		 */
		onKeyPermissionsWarning: (callback: (payload: { message: string }) => void): (() => void) => {
			const handler = (_: unknown, payload: { message: string }) => callback(payload);
			ipcRenderer.on('vibes:keyPermissionsWarning', handler);
			return () => ipcRenderer.removeListener('vibes:keyPermissionsWarning', handler);
		},

		/**
		 * VERIFY spec: Key management and attestation sub-namespace.
		 */
		attestation: {
			keygen: (): Promise<VibesAttestationResult> => ipcRenderer.invoke('vibes:keygen'),

			getKeyInfo: (): Promise<VibesAttestationResult> => ipcRenderer.invoke('vibes:getKeyInfo'),

			checkKeyPermissions: (): Promise<VibesAttestationResult> =>
				ipcRenderer.invoke('vibes:checkKeyPermissions'),

			exportPublicKey: (format: 'pem' | 'ssh'): Promise<VibesAttestationResult> =>
				ipcRenderer.invoke('vibes:exportPublicKey', format),

			attest: (
				projectPath: string,
				options?: {
					cosign?: boolean;
					validationResult?: 'PASS' | 'FAIL';
					vibesVersion?: string;
				}
			): Promise<VibesAttestationResult> =>
				ipcRenderer.invoke('vibes:attest', projectPath, options),

			verifyAttestation: (
				projectPath: string,
				envelope?: unknown
			): Promise<VibesAttestationResult> =>
				ipcRenderer.invoke('vibes:verifyAttestation', projectPath, envelope),

			getProviderKeys: (): Promise<VibesAttestationResult> =>
				ipcRenderer.invoke('vibes:getProviderKeys'),
		},
	};
}

export type VibesApi = ReturnType<typeof createVibesApi>;
