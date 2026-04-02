/**
 * Experience Repository IPC handlers.
 *
 * Local operations (import from file, export, verify signature, trusted keys, uninstall)
 * are fully implemented. API-dependent operations (catalog browse, download, submit)
 * return "not yet available" stubs until the server API is live.
 */

import { ipcMain, dialog } from 'electron';
import { promises as fs } from 'fs';
import { createIpcDataHandler, CreateHandlerOptions } from '../../utils/ipcHandler';
import type {
	ExperienceBundle,
	SignedExperienceBundle,
	TrustedKeyEntry,
	ExperienceSubmission,
	RepositoryCatalogResponse,
	RepositoryDownloadResponse,
} from '../../../shared/experience-bundle-types';
import type { MemoryScope } from '../../../shared/memory-types';

const LOG_CONTEXT = '[ExperienceRepo]';

const handlerOpts = (operation: string): Pick<CreateHandlerOptions, 'context' | 'operation'> => ({
	context: LOG_CONTEXT,
	operation,
});

export function registerExperienceRepositoryHandlers(): void {
	// ─── API Stubs (not yet available) ───────────────────────────────────

	ipcMain.handle(
		'experienceRepo:getCatalog',
		createIpcDataHandler(
			handlerOpts('getCatalog'),
			async (
				_page?: number,
				_pageSize?: number,
				_category?: string,
				_search?: string
			): Promise<RepositoryCatalogResponse> => {
				return { entries: [], totalCount: 0, page: 1, pageSize: 20 };
			}
		)
	);

	ipcMain.handle(
		'experienceRepo:downloadBundle',
		createIpcDataHandler(
			handlerOpts('downloadBundle'),
			async (_bundleId: string): Promise<RepositoryDownloadResponse> => {
				throw new Error('Experience Repository is not yet available. This feature is coming soon.');
			}
		)
	);

	ipcMain.handle(
		'experienceRepo:submitExperiences',
		createIpcDataHandler(
			handlerOpts('submitExperiences'),
			async (_submission: ExperienceSubmission) => {
				return {
					accepted: false,
					message:
						'Experience Repository submissions are not yet available. This feature is coming soon.',
				};
			}
		)
	);

	// ─── Local Operations (fully implemented) ────────────────────────────

	ipcMain.handle(
		'experienceRepo:importFromFile',
		createIpcDataHandler(handlerOpts('importFromFile'), async () => {
			const result = await dialog.showOpenDialog({
				title: 'Import Experience Bundle',
				filters: [{ name: 'Experience Bundle', extensions: ['json'] }],
				properties: ['openFile'],
			});

			if (result.canceled || result.filePaths.length === 0) {
				throw new Error('Import cancelled');
			}

			const content = await fs.readFile(result.filePaths[0], 'utf-8');
			const parsed = JSON.parse(content);

			const { validateBundleIntegrity, verifyBundleSignature, importBundle } =
				await import('../../memory/experience-bundle');

			// Check if it's a signed bundle or a plain bundle
			let bundle: ExperienceBundle;
			let signatureVerified = false;
			let signerTrusted = false;

			if (parsed.bundle && parsed.signature && parsed.algorithm) {
				// Signed bundle
				const signed = parsed as SignedExperienceBundle;
				const sigResult = await verifyBundleSignature(signed);
				signatureVerified = sigResult.valid;
				signerTrusted = sigResult.trusted;
				bundle = signed.bundle;
			} else {
				// Plain bundle
				bundle = parsed as ExperienceBundle;
			}

			const validation = validateBundleIntegrity(bundle);
			if (!validation.valid) {
				throw new Error(`Invalid bundle: ${validation.errors.join(', ')}`);
			}

			return importBundle(bundle, signatureVerified, signerTrusted);
		})
	);

	ipcMain.handle(
		'experienceRepo:exportToFile',
		createIpcDataHandler(
			handlerOpts('exportToFile'),
			async (
				memoryIds: string[],
				scope: MemoryScope,
				skillAreaId?: string,
				projectPath?: string,
				metadata?: Partial<ExperienceBundle>
			) => {
				const { exportAsBundle } = await import('../../memory/experience-bundle');
				const bundle = await exportAsBundle(
					memoryIds,
					scope,
					metadata ?? {},
					skillAreaId,
					projectPath
				);

				const result = await dialog.showSaveDialog({
					title: 'Export Experience Bundle',
					defaultPath: `${bundle.name.replace(/[^a-zA-Z0-9-_]/g, '_')}.maestro-bundle.json`,
					filters: [{ name: 'Experience Bundle', extensions: ['json'] }],
				});

				if (result.canceled || !result.filePath) {
					throw new Error('Export cancelled');
				}

				await fs.writeFile(result.filePath, JSON.stringify(bundle, null, 2));
				return { filePath: result.filePath };
			}
		)
	);

	ipcMain.handle(
		'experienceRepo:getImported',
		createIpcDataHandler(handlerOpts('getImported'), async () => {
			const { getImportedBundles } = await import('../../memory/experience-bundle');
			return getImportedBundles();
		})
	);

	ipcMain.handle(
		'experienceRepo:uninstall',
		createIpcDataHandler(handlerOpts('uninstall'), async (bundleId: string) => {
			const { uninstallBundle } = await import('../../memory/experience-bundle');
			return uninstallBundle(bundleId);
		})
	);

	ipcMain.handle(
		'experienceRepo:verifySignature',
		createIpcDataHandler(handlerOpts('verifySignature'), async (signed: SignedExperienceBundle) => {
			const { verifyBundleSignature } = await import('../../memory/experience-bundle');
			return verifyBundleSignature(signed);
		})
	);

	ipcMain.handle(
		'experienceRepo:getTrustedKeys',
		createIpcDataHandler(handlerOpts('getTrustedKeys'), async () => {
			const { getTrustedKeys } = await import('../../memory/experience-bundle');
			return getTrustedKeys();
		})
	);

	ipcMain.handle(
		'experienceRepo:addTrustedKey',
		createIpcDataHandler(handlerOpts('addTrustedKey'), async (key: TrustedKeyEntry) => {
			const { addTrustedKey } = await import('../../memory/experience-bundle');
			await addTrustedKey(key);
		})
	);

	ipcMain.handle(
		'experienceRepo:removeTrustedKey',
		createIpcDataHandler(handlerOpts('removeTrustedKey'), async (publicKey: string) => {
			const { removeTrustedKey } = await import('../../memory/experience-bundle');
			await removeTrustedKey(publicKey);
		})
	);
}
