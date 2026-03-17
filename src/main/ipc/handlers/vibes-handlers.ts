/**
 * VIBES IPC Handlers
 *
 * Provides IPC handlers for VIBES integration:
 * - isInitialized: Check if VIBES is initialized in a project
 * - init: Initialize a VIBES audit directory
 * - build: Rebuild audit manifest from annotations
 * - getStats: Get project statistics
 * - getBlame: Get per-line provenance data
 * - getLog: Get annotation log with filters
 * - getCoverage: Get VIBES coverage statistics
 * - getReport: Generate a VIBES report
 * - getSessions: List all sessions
 * - getModels: List all models used
 * - findBinary: Find the vibecheck binary and return path + version
 * - clearBinaryCache: Clear cached binary path (on settings change)
 */

import { ipcMain } from 'electron';
import { gunzipSync } from 'zlib';
import { readFile } from 'fs/promises';
import * as path from 'path';
import type Store from 'electron-store';
import type { MaestroSettings } from './persistence';
import { logger } from '../../utils/logger';
import {
	findVibesCheckBinary,
	getVibesCheckVersion,
	clearBinaryPathCache,
	isVibesInitialized,
	vibesInit,
	vibesBuild,
	vibesBlame,
	vibesLog,
	vibesCoverage,
	vibesReport,
	vibesSessions,
	vibesModels,
	vibesBackfillCommit,
} from '../../vibes/vibes-bridge';
import type { VibesAssuranceLevel } from '../../../shared/vibes-types';
import {
	computeStatsFromAnnotations,
	extractSessionsFromAnnotations,
	extractModelsFromManifest,
	computeBlameFromAnnotations,
	computeCoverageFromAnnotations,
	computeLocCoverageFromAnnotations,
	readAnnotations,
	readVibesManifest,
	readVibesConfig,
	writeVibesConfig,
	rehashManifest,
	validateDelegationChain,
} from '../../vibes/vibes-io';
import {
	generateKeyPair,
	saveUserKeyPair,
	getUserKeyInfo,
	checkKeyPermissions,
	exportPublicKey,
	loadUserKeyPair,
	buildInTotoStatement,
	buildDSSEEnvelope,
	computeAttestationId,
	computePAE,
	verifyPAESignature,
} from '../../vibes/vibes-key-manager';
import type { DSSEEnvelope, DSSESignature } from '../../vibes/vibes-key-manager';
import {
	fetchProviderKeys,
	requestCosignature,
	computePAEHash,
	verifyProviderSignature,
} from '../../vibes/vibes-cosign-service';

const LOG_CONTEXT = '[VIBES]';

/**
 * Dependencies required for VIBES handler registration.
 */
export interface VibesHandlerDependencies {
	settingsStore: Store<MaestroSettings>;
}

/**
 * Get the custom binary path from the settings store.
 */
function getCustomBinaryPath(settingsStore: Store<{ [key: string]: unknown }>): string | undefined {
	const path = settingsStore.get('vibesCheckBinaryPath', '') as string;
	return path || undefined;
}

/**
 * Register all VIBES IPC handlers.
 */
export function registerVibesHandlers(deps: VibesHandlerDependencies): void {
	const { settingsStore } = deps;

	// Check if VIBES is initialized in a project
	ipcMain.handle('vibes:isInitialized', async (_event, projectPath: string) => {
		try {
			return await isVibesInitialized(projectPath);
		} catch (error) {
			logger.error('isInitialized error', LOG_CONTEXT, { error: String(error) });
			return false;
		}
	});

	// Initialize a VIBES audit directory
	ipcMain.handle(
		'vibes:init',
		async (
			_event,
			projectPath: string,
			config: {
				projectName: string;
				assuranceLevel: VibesAssuranceLevel;
				extensions?: string[];
			}
		) => {
			try {
				const customPath = getCustomBinaryPath(settingsStore);
				return await vibesInit(projectPath, config, customPath);
			} catch (error) {
				logger.error('init error', LOG_CONTEXT, { error: String(error) });
				return { success: false, error: String(error) };
			}
		}
	);

	// Get project statistics (falls back to direct file reading when binary unavailable)
	// NOTE: `vibecheck stats` does not support `--json` — its output is human-readable
	// text. We always use the direct computation fallback for reliable JSON output.
	ipcMain.handle('vibes:getStats', async (_event, projectPath: string, _file?: string) => {
		try {
			const stats = await computeStatsFromAnnotations(projectPath);
			return { success: true, data: JSON.stringify(stats) };
		} catch (error) {
			logger.error('getStats error', LOG_CONTEXT, { error: String(error) });
			return { success: false, error: String(error) };
		}
	});

	// Get per-line provenance data (falls back to direct annotation parsing)
	ipcMain.handle('vibes:getBlame', async (_event, projectPath: string, file: string) => {
		try {
			const customPath = getCustomBinaryPath(settingsStore);
			const binaryPath = await findVibesCheckBinary(customPath);
			if (binaryPath) {
				return await vibesBlame(projectPath, file, customPath);
			}
			// Fallback: compute blame from raw annotations
			const blame = await computeBlameFromAnnotations(projectPath, file);
			return { success: true, data: JSON.stringify(blame) };
		} catch (error) {
			logger.error('getBlame error', LOG_CONTEXT, { error: String(error) });
			return { success: false, error: String(error) };
		}
	});

	// Get annotation log with filters (falls back to direct file reading)
	ipcMain.handle(
		'vibes:getLog',
		async (
			_event,
			projectPath: string,
			options?: {
				file?: string;
				model?: string;
				session?: string;
				limit?: number;
				json?: boolean;
			}
		) => {
			try {
				const customPath = getCustomBinaryPath(settingsStore);
				const binaryPath = await findVibesCheckBinary(customPath);
				if (binaryPath) {
					return await vibesLog(projectPath, options, customPath);
				}
				// Fallback: read annotations directly and apply filters
				let annotations = await readAnnotations(projectPath);
				if (options?.file) {
					annotations = annotations.filter((a) => 'file_path' in a && a.file_path === options.file);
				}
				if (options?.session) {
					annotations = annotations.filter(
						(a) => 'session_id' in a && a.session_id === options.session
					);
				}
				if (options?.limit && options.limit > 0) {
					annotations = annotations.slice(-options.limit);
				}
				return { success: true, data: JSON.stringify(annotations) };
			} catch (error) {
				logger.error('getLog error', LOG_CONTEXT, { error: String(error) });
				return { success: false, error: String(error) };
			}
		}
	);

	// Get VIBES coverage statistics (falls back to direct annotation parsing)
	ipcMain.handle('vibes:getCoverage', async (_event, projectPath: string) => {
		try {
			const customPath = getCustomBinaryPath(settingsStore);
			const binaryPath = await findVibesCheckBinary(customPath);
			if (binaryPath) {
				return await vibesCoverage(projectPath, true, customPath);
			}
			// Fallback: compute coverage from raw annotations
			const coverage = await computeCoverageFromAnnotations(projectPath);
			return { success: true, data: JSON.stringify(coverage) };
		} catch (error) {
			logger.error('getCoverage error', LOG_CONTEXT, { error: String(error) });
			return { success: false, error: String(error) };
		}
	});

	// Get VIBES LOC-based coverage statistics (line-level, not file-level)
	ipcMain.handle('vibes:getLocCoverage', async (_event, projectPath: string) => {
		try {
			const locCoverage = await computeLocCoverageFromAnnotations(projectPath);
			return { success: true, data: JSON.stringify(locCoverage) };
		} catch (error) {
			logger.error('getLocCoverage error', LOG_CONTEXT, { error: String(error) });
			return { success: false, error: String(error) };
		}
	});

	// Generate a VIBES report
	ipcMain.handle(
		'vibes:getReport',
		async (_event, projectPath: string, format?: 'markdown' | 'html' | 'json') => {
			try {
				const customPath = getCustomBinaryPath(settingsStore);
				return await vibesReport(projectPath, format, customPath);
			} catch (error) {
				logger.error('getReport error', LOG_CONTEXT, { error: String(error) });
				return { success: false, error: String(error) };
			}
		}
	);

	// List all sessions (falls back to direct annotation parsing)
	ipcMain.handle('vibes:getSessions', async (_event, projectPath: string) => {
		try {
			const customPath = getCustomBinaryPath(settingsStore);
			const binaryPath = await findVibesCheckBinary(customPath);
			if (binaryPath) {
				return await vibesSessions(projectPath, customPath);
			}
			// Fallback: extract sessions from raw annotations
			const sessions = await extractSessionsFromAnnotations(projectPath);
			return { success: true, data: JSON.stringify(sessions) };
		} catch (error) {
			logger.error('getSessions error', LOG_CONTEXT, { error: String(error) });
			return { success: false, error: String(error) };
		}
	});

	// List all models used (falls back to direct manifest reading)
	ipcMain.handle('vibes:getModels', async (_event, projectPath: string) => {
		try {
			const customPath = getCustomBinaryPath(settingsStore);
			const binaryPath = await findVibesCheckBinary(customPath);
			if (binaryPath) {
				return await vibesModels(projectPath, customPath);
			}
			// Fallback: extract models from raw manifest
			const models = await extractModelsFromManifest(projectPath);
			return { success: true, data: JSON.stringify(models) };
		} catch (error) {
			logger.error('getModels error', LOG_CONTEXT, { error: String(error) });
			return { success: false, error: String(error) };
		}
	});

	// Rebuild audit manifest from annotations
	ipcMain.handle('vibes:build', async (_event, projectPath: string) => {
		try {
			const customPath = getCustomBinaryPath(settingsStore);
			return await vibesBuild(projectPath, customPath);
		} catch (error) {
			logger.error('build error', LOG_CONTEXT, { error: String(error) });
			return { success: false, error: String(error) };
		}
	});

	// Re-hash all manifest entries and update annotation references
	ipcMain.handle('vibes:rehash', async (_event, projectPath: string) => {
		try {
			const result = await rehashManifest(projectPath);
			return { success: true, data: JSON.stringify(result) };
		} catch (error) {
			logger.error('rehash error', LOG_CONTEXT, { error: String(error) });
			return { success: false, error: String(error) };
		}
	});

	// Validate EVOLVE delegation chain integrity (EVOLVE spec section 3)
	ipcMain.handle('vibes:validateDelegationChain', async (_event, projectPath: string) => {
		try {
			const result = await validateDelegationChain(projectPath);
			return { success: true, data: JSON.stringify(result) };
		} catch (error) {
			logger.error('validateDelegationChain error', LOG_CONTEXT, { error: String(error) });
			return { success: false, error: String(error) };
		}
	});

	// Update per-project VIBES config fields (e.g. assurance_level)
	ipcMain.handle(
		'vibes:updateConfig',
		async (
			_event,
			projectPath: string,
			updates: Partial<{
				assurance_level: VibesAssuranceLevel;
				tracked_extensions: string[];
				exclude_patterns: string[];
			}>
		) => {
			try {
				const config = await readVibesConfig(projectPath);
				if (!config) {
					return { success: false, error: 'No VIBES config found. Initialize VIBES first.' };
				}
				const updated = { ...config, ...updates };
				await writeVibesConfig(projectPath, updated);
				return { success: true };
			} catch (error) {
				logger.error('updateConfig error', LOG_CONTEXT, { error: String(error) });
				return { success: false, error: String(error) };
			}
		}
	);

	// Find the vibecheck binary — returns { path, version } or { path: null, version: null }
	ipcMain.handle('vibes:findBinary', async (_event, customPath?: string) => {
		try {
			const binaryPath = await findVibesCheckBinary(customPath);
			if (!binaryPath) {
				return { path: null, version: null };
			}
			const version = await getVibesCheckVersion(binaryPath);
			return { path: binaryPath, version };
		} catch (error) {
			logger.error('findBinary error', LOG_CONTEXT, { error: String(error) });
			return { path: null, version: null };
		}
	});

	// Clear the binary path cache (called when settings change)
	ipcMain.handle('vibes:clearBinaryCache', async () => {
		clearBinaryPathCache();
	});

	// Get the manifest (resolved provenance entries keyed by content hash)
	ipcMain.handle('vibes:getManifest', async (_event, projectPath: string) => {
		try {
			const manifest = await readVibesManifest(projectPath);
			return { success: true, data: JSON.stringify(manifest) };
		} catch (error) {
			logger.error('getManifest error', LOG_CONTEXT, { error: String(error) });
			return { success: false, error: String(error) };
		}
	});

	// Backfill commit_hash on annotations missing it
	ipcMain.handle(
		'vibes:backfillCommit',
		async (_event, projectPath: string, commitHash: string, sessionId?: string) => {
			try {
				const customPath = getCustomBinaryPath(settingsStore);
				return await vibesBackfillCommit(projectPath, commitHash, sessionId, customPath);
			} catch (error) {
				logger.error('backfillCommit error', LOG_CONTEXT, { error: String(error) });
				return { success: false, updatedCount: 0, error: String(error) };
			}
		}
	);

	// Decompress compressed reasoning text or read external blob files
	ipcMain.handle(
		'vibes:decompress-reasoning',
		async (
			_event,
			params: {
				compressed?: string | null;
				blobPath?: string | null;
				projectPath?: string | null;
			}
		) => {
			try {
				// Handle compressed inline text (gzip + base64)
				if (params.compressed) {
					const buf = Buffer.from(params.compressed, 'base64');
					const decompressed = gunzipSync(buf);
					return { text: decompressed.toString('utf-8'), error: null };
				}

				// Handle external blob file
				if (params.blobPath && params.projectPath) {
					const fullPath = path.join(params.projectPath, '.ai-audit', params.blobPath);
					const content = await readFile(fullPath, 'utf-8');
					return { text: content, error: null };
				}

				return { text: null, error: 'No compressed data or blob path provided' };
			} catch (error) {
				logger.error('decompress-reasoning error', LOG_CONTEXT, { error: String(error) });
				return { text: null, error: String(error) };
			}
		}
	);

	// ========================================================================
	// VERIFY Spec: Key Management & Attestation Handlers
	// ========================================================================

	// Generate Ed25519 keypair, save to ~/.vibescheck/keys/, return public key info
	ipcMain.handle('vibes:keygen', async () => {
		try {
			const keyPair = generateKeyPair();
			await saveUserKeyPair(keyPair);
			return {
				success: true,
				data: {
					publicKey: keyPair.publicKey,
					keyId: keyPair.keyId,
					exists: true,
				},
			};
		} catch (error) {
			logger.error('keygen error', LOG_CONTEXT, { error: String(error) });
			return { success: false, error: String(error) };
		}
	});

	// Get user key info (public key + key ID) without loading private key
	ipcMain.handle('vibes:getKeyInfo', async () => {
		try {
			const keyInfo = await getUserKeyInfo();
			return { success: true, data: keyInfo };
		} catch (error) {
			logger.error('getKeyInfo error', LOG_CONTEXT, { error: String(error) });
			return { success: false, error: String(error) };
		}
	});

	// Check if private key file has correct permissions (0600)
	ipcMain.handle('vibes:checkKeyPermissions', async () => {
		try {
			const result = await checkKeyPermissions();
			return { success: true, data: result };
		} catch (error) {
			logger.error('checkKeyPermissions error', LOG_CONTEXT, { error: String(error) });
			return { success: false, error: String(error) };
		}
	});

	// Export public key in PEM or SSH format
	ipcMain.handle('vibes:exportPublicKey', async (_event, format: 'pem' | 'ssh') => {
		try {
			const keyInfo = await getUserKeyInfo();
			if (!keyInfo.exists) {
				return { success: false, error: 'No keypair found. Run keygen first.' };
			}
			const exported = exportPublicKey(keyInfo.publicKey, format);
			return { success: true, data: exported };
		} catch (error) {
			logger.error('exportPublicKey error', LOG_CONTEXT, { error: String(error) });
			return { success: false, error: String(error) };
		}
	});

	// Build in-toto statement, DSSE envelope, optionally cosign via tool provider
	ipcMain.handle(
		'vibes:attest',
		async (
			_event,
			projectPath: string,
			options?: {
				cosign?: boolean;
				validationResult?: 'PASS' | 'FAIL';
				vibesVersion?: string;
			}
		) => {
			try {
				// Load or require user keypair
				const userKeyPair = await loadUserKeyPair();
				if (!userKeyPair) {
					return {
						success: false,
						error: 'No keypair found. Run keygen first.',
					};
				}

				// Build the in-toto statement
				const validationResult = options?.validationResult ?? 'PASS';
				const vibesVersion = options?.vibesVersion ?? '1.0.0';
				const statement = await buildInTotoStatement(projectPath, validationResult, vibesVersion);

				// Optionally request a tool provider cosignature
				let toolProviderSig: DSSESignature | undefined;
				if (options?.cosign) {
					const tempPayload = Buffer.from(JSON.stringify(statement), 'utf8').toString('base64url');
					const paeBytes = computePAE('application/vnd.in-toto+json', tempPayload);
					const paeHash = computePAEHash(paeBytes);
					const cosignResult = await requestCosignature(paeHash);
					if (cosignResult) {
						toolProviderSig = cosignResult;
					}
				}

				// Build the DSSE envelope
				const envelope = await buildDSSEEnvelope(statement, userKeyPair, toolProviderSig);
				const attestationId = computeAttestationId(envelope);

				return {
					success: true,
					data: {
						envelope,
						attestationId,
						statement,
						trustTier: toolProviderSig ? 'tool-corroborated' : 'self-attested',
					},
				};
			} catch (error) {
				logger.error('attest error', LOG_CONTEXT, { error: String(error) });
				return { success: false, error: String(error) };
			}
		}
	);

	// Verify a DSSE envelope: check signatures and file hash integrity
	ipcMain.handle(
		'vibes:verifyAttestation',
		async (_event, projectPath: string, envelope: DSSEEnvelope) => {
			try {
				const results: Array<{
					keyid: string;
					keytype?: string;
					valid: boolean;
					error?: string;
				}> = [];

				const paeBytes = computePAE(envelope.payloadType, envelope.payload);

				for (const sigEntry of envelope.signatures) {
					if (sigEntry.keytype === 'tool_provider') {
						// Verify against published provider keys
						const valid = await verifyProviderSignature(paeBytes, sigEntry.sig, sigEntry.keyid);
						results.push({
							keyid: sigEntry.keyid,
							keytype: 'tool_provider',
							valid,
						});
					} else {
						// Verify user signature — need the user's public key
						const keyInfo = await getUserKeyInfo();
						if (!keyInfo.exists || keyInfo.keyId !== sigEntry.keyid) {
							results.push({
								keyid: sigEntry.keyid,
								keytype: 'user',
								valid: false,
								error: 'User public key not found or key ID mismatch',
							});
						} else {
							const valid = verifyPAESignature(paeBytes, sigEntry.sig, keyInfo.publicKey);
							results.push({
								keyid: sigEntry.keyid,
								keytype: 'user',
								valid,
							});
						}
					}
				}

				// Verify file hashes from the in-toto statement
				let hashesValid = true;
				try {
					const statementJson = Buffer.from(envelope.payload, 'base64url').toString('utf8');
					const statement = JSON.parse(statementJson);
					const { createHash } = await import('crypto');
					const { readFile: readFileAsync } = await import('fs/promises');

					for (const subject of statement.subject || []) {
						const filePath = path.join(projectPath, subject.name);
						try {
							const content = await readFileAsync(filePath);
							const hash = createHash('sha256').update(content).digest('hex');
							if (hash !== subject.digest?.sha256) {
								hashesValid = false;
							}
						} catch {
							hashesValid = false;
						}
					}
				} catch {
					hashesValid = false;
				}

				const allSignaturesValid = results.every((r) => r.valid);

				return {
					success: true,
					data: {
						signatures: results,
						allSignaturesValid,
						hashesValid,
						valid: allSignaturesValid && hashesValid,
					},
				};
			} catch (error) {
				logger.error('verifyAttestation error', LOG_CONTEXT, {
					error: String(error),
				});
				return { success: false, error: String(error) };
			}
		}
	);

	// Fetch and return the Maestro tool provider public keys
	ipcMain.handle('vibes:getProviderKeys', async () => {
		try {
			const keys = await fetchProviderKeys();
			return { success: true, data: keys };
		} catch (error) {
			logger.error('getProviderKeys error', LOG_CONTEXT, { error: String(error) });
			return { success: false, error: String(error) };
		}
	});
}
