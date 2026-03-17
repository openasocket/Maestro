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

const LOG_CONTEXT = '[VIBES-COSIGN]';

// ============================================================================
// Constants
// ============================================================================

/** Maestro cosigning endpoint. */
const COSIGN_ENDPOINT = 'https://api.maestro.sh/vibes/cosign';

/** Published key bundle URL for verification. */
const PROVIDER_KEYS_URL = 'https://maestro.sh/vibes/vibes-signing-keys.json';

/** Cache TTL for the provider key bundle (24 hours). */
const KEY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Request timeout for cosigning and key fetch operations (10 seconds). */
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
// Key Cache
// ============================================================================

let cachedKeyBundle: ProviderKeyBundle | null = null;
let cacheTimestamp = 0;

/**
 * Clear the cached provider key bundle. Useful for testing or forced refresh.
 */
export function clearProviderKeyCache(): void {
	cachedKeyBundle = null;
	cacheTimestamp = 0;
}

// ============================================================================
// Provider Key Fetching
// ============================================================================

/**
 * Fetch and cache the Maestro tool provider public keys.
 * Returns null if offline or endpoint unavailable. Never throws.
 */
export async function fetchProviderKeys(): Promise<ProviderKeyBundle | null> {
	// Return cached bundle if still valid
	if (cachedKeyBundle && Date.now() - cacheTimestamp < KEY_CACHE_TTL_MS) {
		return cachedKeyBundle;
	}

	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

		const response = await fetch(PROVIDER_KEYS_URL, {
			method: 'GET',
			headers: {
				Accept: 'application/json',
				'User-Agent': 'Maestro-VIBES-Cosign',
			},
			signal: controller.signal,
		});

		clearTimeout(timeout);

		if (!response.ok) {
			logger.warn(`Provider keys fetch failed: HTTP ${response.status}`, LOG_CONTEXT);
			return cachedKeyBundle; // Return stale cache if available
		}

		const bundle = (await response.json()) as ProviderKeyBundle;

		// Basic validation
		if (!bundle.keys || !Array.isArray(bundle.keys)) {
			logger.warn('Provider keys response has invalid shape', LOG_CONTEXT);
			return cachedKeyBundle;
		}

		cachedKeyBundle = bundle;
		cacheTimestamp = Date.now();

		logger.info(
			`Fetched ${bundle.keys.length} provider key(s) from ${bundle.provider}`,
			LOG_CONTEXT
		);

		return bundle;
	} catch (error) {
		// Network errors, timeouts, AbortError — all acceptable offline scenarios
		logger.debug(
			`Provider keys fetch unavailable: ${error instanceof Error ? error.message : String(error)}`,
			LOG_CONTEXT
		);
		return cachedKeyBundle; // Return stale cache if available
	}
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
	const bundle = await fetchProviderKeys();
	if (!bundle) return null;

	const now = new Date().toISOString();

	const entry = bundle.keys.find(
		(k) => k.keyid === keyid && k.status === 'active' && k.valid_from <= now && k.valid_until >= now
	);

	return entry?.public_key_pem ?? null;
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
