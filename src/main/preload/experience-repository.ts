/**
 * Preload API for Experience Repository operations.
 *
 * Provides window.maestro.experienceRepository namespace for:
 * - Browsing the central repository (stub)
 * - Downloading signed bundles (stub)
 * - Importing/exporting bundles locally
 * - Submitting experiences to the repository (stub)
 * - Managing imported bundles and trusted keys
 */

import { ipcRenderer } from 'electron';
import type {
	RepositoryCatalogResponse,
	RepositoryDownloadResponse,
	SignedExperienceBundle,
	TrustedKeyEntry,
	ExperienceSubmission,
	ExperienceBundle,
	BundleImportResult,
	ImportedBundleRecord,
	SubmissionResponse,
	MemoryScope,
} from '../../shared/experience-bundle-types';

type IpcResponse<T> = { success: true; data: T } | { success: false; error: string };

export function createExperienceRepositoryApi() {
	return {
		getCatalog: (
			page?: number,
			pageSize?: number,
			category?: string,
			search?: string
		): Promise<IpcResponse<RepositoryCatalogResponse>> =>
			ipcRenderer.invoke('experienceRepo:getCatalog', page, pageSize, category, search),

		downloadBundle: (bundleId: string): Promise<IpcResponse<RepositoryDownloadResponse>> =>
			ipcRenderer.invoke('experienceRepo:downloadBundle', bundleId),

		importFromFile: (): Promise<IpcResponse<BundleImportResult>> =>
			ipcRenderer.invoke('experienceRepo:importFromFile'),

		exportToFile: (
			memoryIds: string[],
			scope: MemoryScope,
			skillAreaId?: string,
			projectPath?: string,
			metadata?: Partial<ExperienceBundle>
		): Promise<IpcResponse<{ filePath: string }>> =>
			ipcRenderer.invoke(
				'experienceRepo:exportToFile',
				memoryIds,
				scope,
				skillAreaId,
				projectPath,
				metadata
			),

		submitExperiences: (
			submission: ExperienceSubmission
		): Promise<IpcResponse<SubmissionResponse>> =>
			ipcRenderer.invoke('experienceRepo:submitExperiences', submission),

		getImported: (): Promise<IpcResponse<ImportedBundleRecord[]>> =>
			ipcRenderer.invoke('experienceRepo:getImported'),

		uninstall: (bundleId: string): Promise<IpcResponse<{ removed: number }>> =>
			ipcRenderer.invoke('experienceRepo:uninstall', bundleId),

		verifySignature: (
			signed: SignedExperienceBundle
		): Promise<IpcResponse<{ valid: boolean; trusted: boolean }>> =>
			ipcRenderer.invoke('experienceRepo:verifySignature', signed),

		getTrustedKeys: (): Promise<IpcResponse<TrustedKeyEntry[]>> =>
			ipcRenderer.invoke('experienceRepo:getTrustedKeys'),

		addTrustedKey: (key: TrustedKeyEntry): Promise<IpcResponse<void>> =>
			ipcRenderer.invoke('experienceRepo:addTrustedKey', key),

		removeTrustedKey: (publicKey: string): Promise<IpcResponse<void>> =>
			ipcRenderer.invoke('experienceRepo:removeTrustedKey', publicKey),
	};
}

export type ExperienceRepositoryApi = ReturnType<typeof createExperienceRepositoryApi>;
