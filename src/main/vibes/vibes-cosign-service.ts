// VERIFY v1.0 Tool Provider Cosigning Service
//
// Per VERIFY spec section 9:
// 1. Tool computes PAE bytes from the in-toto statement
// 2. Only the 32-byte SHA-256 of PAE bytes is sent to the provider
// 3. Provider signs and returns the signature
//
// This module handles step 2-3 from Maestro's perspective as the tool provider.
// Privacy guarantee: Only the SHA-256 hash of PAE bytes is sent. The server
// never sees prompts, code, reasoning, or any audit content.

import { createHash } from 'crypto';
import { logger } from '../utils/logger';
import { verifyPAESignature } from './vibes-key-manager';
import {
	checkProviderKeyUpdate,
	getProviderKeyById,
	loadProviderKeyStore,
} from './vibes-provider-keystore';

const LOG_CONTEXT = '[VIBES-COSIGN]';

// ============================================================================
// Constants
// ============================================================================

/** Maestro cosigning endpoint. */
const COSIGN_ENDPOINT = 'https://api.maestro.sh/vibes/cosign';

/** Request timeout for cosigning operations (10 seconds). */
const REQUEST_TIMEOUT_MS = 10_000;

// ============================================================================
// Types
// ============================================================================

export interface ProviderKeyEntry {
	keyid: string;
	algorithm: 'Ed25519';
	public_key_pem: string;
	valid_from: string;
	valid_until: string;
	status: 'active' | 'revoked';
}

export interface ProviderKeyBundle {
	provider: string; // "Maestro"
	tool_name: string; // "Maestro"
	keys: ProviderKeyEntry[];
	rotation_policy: string;
}

export interface CosignRequest {
	pae_hash: string; // SHA-256 of PAE bytes (32 bytes, hex)
	tool_session_id?: string; // For audit logging
	app_version?: string;
}

export interface CosignResponse {
	keyid: string;
	sig: string; // Base64url Ed25519 signature
	keytype: 'tool_provider';
}

// ============================================================================
// Provider Keys (static-file distribution — see vibes-provider-keystore.ts)
// ============================================================================

/**
 * Clear cached provider key state. The persistent store on disk is the source
 * of truth; this only forces the next check to hit the network.
 */
export function clearProviderKeyCache(): void {
	// The keystore throttles by last_checked; nothing in-memory to clear.
	// Kept for API compatibility with existing callers/tests.
}

/**
 * Fetch the provider's published keys, shaped as the legacy bundle for
 * existing consumers. Backed by the static key FILE on the website: the
 * file's content hash (keyId) is the version, historical keys are retained
 * locally, and offline calls serve the persisted store.
 */
export async function fetchProviderKeys(): Promise<ProviderKeyBundle | null> {
	await checkProviderKeyUpdate();
	const store = await loadProviderKeyStore();
	if (store.keys.length === 0) return null;

	return {
		provider: 'Maestro',
		tool_name: 'Maestro',
		rotation_policy: 'static-file; content-hash (keyId) is the key version',
		keys: store.keys.map((k) => ({
			keyid: k.keyid,
			algorithm: 'Ed25519' as const,
			public_key_pem: k.public_key_pem,
			valid_from: k.first_seen,
			// Historical keys stay valid for VERIFYING old attestations forever;
			// only the current key is used for new cosignatures.
			valid_until: '9999-12-31T23:59:59Z',
			status: 'active' as const,
		})),
	};
}

// ============================================================================
// Cosigning
// ============================================================================

/**
 * Compute the SHA-256 hash of PAE bytes for transmission to the cosigning endpoint.
 * Only this hash is sent — audit data stays local.
 */
export function computePAEHash(paeBytes: Buffer): string {
	return createHash('sha256').update(paeBytes).digest('hex');
}

/**
 * Request a cosignature from Maestro's signing service.
 * Only the 32-byte PAE hash is sent — audit data stays local.
 * Returns null if offline or endpoint unavailable. Never throws.
 */
export async function requestCosignature(
	paeHash: string,
	options?: { toolSessionId?: string; appVersion?: string }
): Promise<CosignResponse | null> {
	try {
		const body: CosignRequest = {
			pae_hash: paeHash,
		};

		if (options?.toolSessionId) {
			body.tool_session_id = options.toolSessionId;
		}
		if (options?.appVersion) {
			body.app_version = options.appVersion;
		}

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

		const response = await fetch(COSIGN_ENDPOINT, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/json',
				'User-Agent': 'Maestro-VIBES-Cosign',
			},
			body: JSON.stringify(body),
			signal: controller.signal,
		});

		clearTimeout(timeout);

		if (!response.ok) {
			logger.warn(`Cosign request failed: HTTP ${response.status}`, LOG_CONTEXT);
			return null;
		}

		const result = (await response.json()) as CosignResponse;

		// Validate response shape
		if (!result.keyid || !result.sig) {
			logger.warn('Cosign response missing required fields', LOG_CONTEXT);
			return null;
		}

		// Ensure keytype is set
		result.keytype = 'tool_provider';

		logger.info(`Received cosignature from provider key ${result.keyid}`, LOG_CONTEXT);

		return result;
	} catch (error) {
		logger.debug(
			`Cosign request unavailable: ${error instanceof Error ? error.message : String(error)}`,
			LOG_CONTEXT
		);
		return null;
	}
}

// ============================================================================
// Provider Signature Verification
// ============================================================================

/**
 * Find an active provider key by keyid from the cached or freshly-fetched bundle.
 * Returns the PEM public key or null if not found/revoked/expired.
 */
export async function findProviderKey(keyid: string): Promise<string | null> {
	return getProviderKeyById(keyid);
}

/**
 * Verify a tool provider signature against the published keys.
 * Fetches/uses cached provider keys, finds the matching keyid,
 * and verifies the Ed25519 signature over the PAE bytes.
 */
export async function verifyProviderSignature(
	paeBytes: Buffer,
	signature: string,
	keyid: string
): Promise<boolean> {
	const publicKeyPem = await findProviderKey(keyid);
	if (!publicKeyPem) {
		logger.warn(`No active provider key found for keyid ${keyid}`, LOG_CONTEXT);
		return false;
	}

	return verifyPAESignature(paeBytes, signature, publicKeyPem);
}
