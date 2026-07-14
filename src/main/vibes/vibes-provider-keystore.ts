// VERIFY v1.0 Provider Key Store — static-file key distribution.
//
// The provider publishes its CURRENT public key as a plain static file on the
// website at the VIBES-standard path https://{toolDomain}/vibes/{toolName}.pub
// (a bare SPKI PEM). No API, no bundle service: pulling the file IS the
// protocol, and any verifier can derive any tool's key URL from its domain
// and name alone.
//
// Versioning is content-addressed: the VERIFY key ID (SHA-256 of the DER
// public key, first 16 hex chars) doubles as the key's version. A new file
// content means a new keyId means a new key version — no separate version
// field needed. HTTP ETag / Last-Modified headers are used for cheap
// freshness checks (conditional GET, 304 = no change).
//
// Every key ever pulled is retained in a local store
// (~/.vibescheck/keys/providers/index.json) so attestations cosigned under a
// ROTATED-OUT key still verify offline forever. Rotation appends; it never
// deletes.

import { readFile, writeFile, mkdir } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
	createPrivateKey,
	createPublicKey,
	sign as cryptoSign,
	verify as cryptoVerify,
} from 'crypto';
import { computeKeyId } from './vibes-key-manager';
import { logger } from '../utils/logger';

const LOG_CONTEXT = '[VIBES-PROVIDER-KEYS]';

// ============================================================================
// Constants
// ============================================================================

/**
 * VIBES-standard location for a tool provider's published public key:
 *
 *     https://{toolDomain}/vibes/{toolName}.pub
 *
 * where toolDomain is the tool's website domain and toolName is the
 * lowercase tool name. The file contains the tool's CURRENT public key as a
 * bare SPKI PEM — a plain static file fetched with a simple GET. Any
 * VIBES-verifying client can derive the key URL for any tool from just its
 * domain and name; no registry or discovery API is needed.
 */
export function buildProviderKeyUrl(toolDomain: string, toolName: string): string {
	const domain = toolDomain.replace(/^https?:\/\//, '').replace(/\/+$/, '');
	return `https://${domain}/vibes/${toolName.toLowerCase()}.pub`;
}

/**
 * Sibling endorsement file for the published key (VIBES key endorsement):
 * {toolName}.pub.sig — JSON `{ version: 1, endorsements: [...] }` where each
 * endorsement signs the endorsed key's SPKI DER bytes with a PREVIOUS
 * operational key (rotation chaining) or the developer ROOT key.
 */
export function buildProviderKeySigUrl(toolDomain: string, toolName: string): string {
	return `${buildProviderKeyUrl(toolDomain, toolName)}.sig`;
}

/**
 * Developer root key location: {toolName}.root.pub — an OFFLINE key that
 * endorses operational keys. Kept separate from the operational key so a
 * website compromise cannot mint trusted keys.
 */
export function buildProviderRootKeyUrl(toolDomain: string, toolName: string): string {
	return buildProviderKeyUrl(toolDomain, toolName).replace(/\.pub$/, '.root.pub');
}

/** Maestro's own tool identity for the VIBES-standard key path. */
export const MAESTRO_TOOL_DOMAIN = 'maestro.sh';
export const MAESTRO_TOOL_NAME = 'maestro';

/** Maestro's published key file per the standard path convention. */
export const PROVIDER_KEY_FILE_URL = buildProviderKeyUrl(MAESTRO_TOOL_DOMAIN, MAESTRO_TOOL_NAME);

/** Directory holding the persisted provider key store. */
const PROVIDER_KEYS_DIR = path.join(os.homedir(), '.vibescheck', 'keys', 'providers');

/** Store index filename. */
const INDEX_FILE = 'index.json';

/** Minimum interval between network freshness checks (1 hour). */
export const KEY_CHECK_INTERVAL_MS = 60 * 60 * 1000;

/** Request timeout for key file fetches (10 seconds). */
const REQUEST_TIMEOUT_MS = 10_000;

// ============================================================================
// Types
// ============================================================================

/**
 * Trust level recorded when a key version was ingested.
 * - 'endorsed-root': endorsement verified against the developer root key
 * - 'endorsed-chain': endorsement verified against a previously-held key
 * - 'unendorsed': no endorsement file was published (trust-on-first-use via
 *   HTTPS/domain control only)
 * Keys whose PUBLISHED endorsement fails verification are REJECTED and never
 * enter the store.
 */
export type ProviderKeyTrust = 'endorsed-root' | 'endorsed-chain' | 'unendorsed';

/** One entry in the published {toolName}.pub.sig endorsement file. */
export interface ProviderKeyEndorsement {
	/** keyId (content-hash version) of the ENDORSED key. */
	keyid: string;
	/** keyId of the signer: a previous operational key or the root key. */
	signed_by: string;
	/** base64url Ed25519 signature over the endorsed key's SPKI DER bytes. */
	sig: string;
	/** Optional ISO timestamp of when the endorsement was created. */
	signed_at?: string;
}

/** One provider key as persisted locally. keyid is the content-hash version. */
export interface StoredProviderKey {
	/** VERIFY key ID — SHA-256(DER)[0:16]. Doubles as the key version. */
	keyid: string;
	/** SPKI PEM public key exactly as published. */
	public_key_pem: string;
	/** ISO timestamp when this key was first pulled down. */
	first_seen: string;
	/** ISO timestamp of the most recent fetch that returned this key. */
	last_fetched: string;
	/** URL the key was pulled from. */
	source_url: string;
	/** Trust level at ingestion time (absent on keys stored before endorsement support). */
	trust?: ProviderKeyTrust;
	/** keyId that endorsed this key (when trust is endorsed-root / endorsed-chain). */
	endorsed_by?: string;
}

/** The on-disk provider key store. */
export interface ProviderKeyStore {
	/** Schema version for forward migrations. */
	version: 1;
	/** keyid of the provider's current key (the one new cosignatures use). */
	current_keyid: string | null;
	/** Every key ever pulled, newest first. Rotation appends, never deletes. */
	keys: StoredProviderKey[];
	/** HTTP cache validators from the last successful fetch. */
	etag: string | null;
	last_modified: string | null;
	/** ISO timestamp of the last network check (successful or 304). */
	last_checked: string | null;
	/** Developer root key, once fetched from {toolName}.root.pub. */
	root_key?: { keyid: string; public_key_pem: string; first_seen: string } | null;
}

/** Result of a freshness check against the published key file. */
export interface ProviderKeyUpdateResult {
	/** Whether a network check was actually performed (false = offline/skipped). */
	checked: boolean;
	/** Whether a NEW key version was pulled down. */
	updated: boolean;
	/** The current key after the check (from store; may predate the check when offline). */
	currentKeyId: string | null;
	/** The keyId that was current before this check (differs from currentKeyId when updated). */
	previousKeyId: string | null;
	/** Human-readable status for logs/UI. */
	detail: string;
}

// ============================================================================
// Store I/O
// ============================================================================

/** Fresh empty store. A factory (not a constant) so callers can never share
 * and mutate the same keys array reference. */
function emptyStore(): ProviderKeyStore {
	return {
		version: 1,
		current_keyid: null,
		keys: [],
		etag: null,
		last_modified: null,
		last_checked: null,
	};
}

function indexPath(): string {
	return path.join(PROVIDER_KEYS_DIR, INDEX_FILE);
}

/** Load the persisted store. Returns an empty store when missing/corrupt. */
export async function loadProviderKeyStore(): Promise<ProviderKeyStore> {
	try {
		const raw = await readFile(indexPath(), 'utf8');
		const parsed = JSON.parse(raw) as ProviderKeyStore;
		if (parsed.version !== 1 || !Array.isArray(parsed.keys)) return emptyStore();
		return parsed;
	} catch {
		return emptyStore();
	}
}

async function saveProviderKeyStore(store: ProviderKeyStore): Promise<void> {
	await mkdir(PROVIDER_KEYS_DIR, { recursive: true });
	await writeFile(indexPath(), JSON.stringify(store, null, '\t'), 'utf8');
}

// ============================================================================
// Key File Parsing
// ============================================================================

/**
 * Parse the published key file content into one or more PEM keys.
 * Primary format is a bare SPKI PEM. A JSON body with
 * `{ keys: [{ public_key_pem }] }` (the legacy bundle shape) is also
 * accepted so the URL can be swapped without a client update.
 */
export function parsePublishedKeyFile(content: string): string[] {
	const trimmed = content.trim();

	if (trimmed.startsWith('-----BEGIN PUBLIC KEY-----')) {
		// One or more concatenated PEM blocks
		const blocks = trimmed.match(/-----BEGIN PUBLIC KEY-----[\s\S]*?-----END PUBLIC KEY-----/g);
		return blocks ?? [];
	}

	// Legacy JSON bundle fallback
	try {
		const parsed = JSON.parse(trimmed) as {
			keys?: Array<{ public_key_pem?: string }>;
		};
		if (Array.isArray(parsed.keys)) {
			return parsed.keys
				.map((k) => k.public_key_pem)
				.filter((pem): pem is string => typeof pem === 'string' && pem.length > 0);
		}
	} catch {
		// Not JSON either — fall through
	}

	return [];
}

// ============================================================================
// Key Endorsement (signed keys)
// ============================================================================

/**
 * Verify an endorsement signature: Ed25519 over the endorsed key's SPKI DER
 * bytes, checked against the signer's public key.
 */
export function verifyKeyEndorsement(
	endorsedPublicKeyPem: string,
	sigBase64Url: string,
	signerPublicKeyPem: string
): boolean {
	try {
		const der = createPublicKey(endorsedPublicKeyPem).export({
			type: 'spki',
			format: 'der',
		}) as Buffer;
		return cryptoVerify(
			null,
			der,
			createPublicKey(signerPublicKeyPem),
			Buffer.from(sigBase64Url, 'base64url')
		);
	} catch {
		return false;
	}
}

/**
 * Create an endorsement for a key (ops/tooling helper): signs the endorsed
 * key's SPKI DER with the signer's private key. Used when rotating (old key
 * signs new key) or endorsing with the developer root key.
 */
export function createKeyEndorsement(
	endorsedPublicKeyPem: string,
	signerPrivateKeyPem: string,
	signerKeyId: string
): ProviderKeyEndorsement {
	const der = createPublicKey(endorsedPublicKeyPem).export({
		type: 'spki',
		format: 'der',
	}) as Buffer;
	const sig = cryptoSign(null, der, createPrivateKey(signerPrivateKeyPem));
	return {
		keyid: computeKeyId(endorsedPublicKeyPem),
		signed_by: signerKeyId,
		sig: sig.toString('base64url'),
		signed_at: new Date().toISOString(),
	};
}

/** Best-effort fetch of the published endorsement file. null = absent/offline. */
async function fetchEndorsementsFile(keyFileUrl: string): Promise<ProviderKeyEndorsement[] | null> {
	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
		const response = await fetch(`${keyFileUrl}.sig`, {
			method: 'GET',
			headers: { Accept: 'application/json', 'User-Agent': 'Maestro-VIBES-Cosign' },
			signal: controller.signal,
		});
		clearTimeout(timeout);
		if (!response.ok) return null;
		const parsed = JSON.parse(await response.text()) as
			| { endorsements?: ProviderKeyEndorsement[] }
			| ProviderKeyEndorsement[];
		const list = Array.isArray(parsed) ? parsed : parsed.endorsements;
		if (!Array.isArray(list)) return null;
		return list.filter(
			(e) =>
				!!e &&
				typeof e.keyid === 'string' &&
				typeof e.signed_by === 'string' &&
				typeof e.sig === 'string'
		);
	} catch {
		return null;
	}
}

/** Best-effort fetch of the developer root key ({toolName}.root.pub). */
async function fetchRootKey(
	keyFileUrl: string
): Promise<{ keyid: string; public_key_pem: string } | null> {
	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
		const response = await fetch(keyFileUrl.replace(/\.pub$/, '.root.pub'), {
			method: 'GET',
			headers: {
				Accept: 'text/plain, application/x-pem-file',
				'User-Agent': 'Maestro-VIBES-Cosign',
			},
			signal: controller.signal,
		});
		clearTimeout(timeout);
		if (!response.ok) return null;
		const pems = parsePublishedKeyFile(await response.text());
		if (pems.length === 0) return null;
		return { keyid: computeKeyId(pems[0]), public_key_pem: pems[0] };
	} catch {
		return null;
	}
}

/**
 * Decide the trust level for a NEW key version.
 * Rules (see docs/architecture/vibes-integration.md):
 * - No endorsement file published → 'unendorsed' (TOFU via HTTPS only).
 * - File published: the key MUST have at least one endorsement that verifies
 *   against a known signer (a previously-held key = chain, or the developer
 *   root key = root). Any published-but-unverifiable state → null (REJECT).
 */
async function evaluateNewKeyTrust(
	pem: string,
	keyid: string,
	endorsements: ProviderKeyEndorsement[] | null,
	knownPems: Map<string, string>,
	store: ProviderKeyStore,
	keyFileUrl: string
): Promise<{ trust: ProviderKeyTrust; endorsedBy?: string } | null> {
	if (endorsements === null) return { trust: 'unendorsed' };

	const matches = endorsements.filter((e) => e.keyid === keyid);
	if (matches.length === 0) {
		logger.warn(`Published endorsement file has no entry for key ${keyid}; rejecting`, LOG_CONTEXT);
		return null;
	}

	// Lazily resolve the root key only when an endorsement references it
	let root: { keyid: string; public_key_pem: string } | null = store.root_key ?? null;
	for (const match of matches) {
		let signerPem = knownPems.get(match.signed_by) ?? null;
		let viaRoot = false;

		if (!signerPem) {
			if (!root) {
				const fetched = await fetchRootKey(keyFileUrl);
				if (fetched) {
					store.root_key = { ...fetched, first_seen: new Date().toISOString() };
					root = store.root_key;
				}
			}
			if (root && root.keyid === match.signed_by) {
				signerPem = root.public_key_pem;
				viaRoot = true;
			}
		}

		if (signerPem && verifyKeyEndorsement(pem, match.sig, signerPem)) {
			return { trust: viaRoot ? 'endorsed-root' : 'endorsed-chain', endorsedBy: match.signed_by };
		}
	}

	logger.warn(
		`No endorsement for key ${keyid} verified against a trusted signer; rejecting`,
		LOG_CONTEXT
	);
	return null;
}

// ============================================================================
// Pull & Version Check
// ============================================================================

/**
 * Check the published key file for a new key version and pull it down.
 *
 * Flow:
 * 1. Conditional GET with If-None-Match / If-Modified-Since from the store.
 * 2. 304 → no new key; bump last_checked and return.
 * 3. 200 → parse PEM, compute keyId (the content-hash version).
 *    - keyId already known → refresh last_fetched/current pointer.
 *    - new keyId → append to the store (retaining old keys) and mark current.
 *
 * Offline/network errors never throw: the persisted store keeps serving.
 *
 * @param options.force       Skip the KEY_CHECK_INTERVAL_MS throttle.
 * @param options.url         Override the published key URL directly (tests).
 * @param options.toolDomain  Derive the URL from a tool identity per the
 * @param options.toolName    standard path: https://{domain}/vibes/{name}.pub.
 */
export async function checkProviderKeyUpdate(options?: {
	force?: boolean;
	url?: string;
	toolDomain?: string;
	toolName?: string;
}): Promise<ProviderKeyUpdateResult> {
	const store = await loadProviderKeyStore();
	const previousKeyId = store.current_keyid;
	const url =
		options?.url ??
		(options?.toolDomain && options?.toolName
			? buildProviderKeyUrl(options.toolDomain, options.toolName)
			: PROVIDER_KEY_FILE_URL);

	// Throttle: skip the network when checked recently (unless forced)
	if (!options?.force && store.last_checked) {
		const elapsed = Date.now() - Date.parse(store.last_checked);
		if (Number.isFinite(elapsed) && elapsed < KEY_CHECK_INTERVAL_MS) {
			return {
				checked: false,
				updated: false,
				currentKeyId: previousKeyId,
				previousKeyId,
				detail: 'Checked recently; using stored key',
			};
		}
	}

	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

		const headers: Record<string, string> = {
			Accept: 'text/plain, application/x-pem-file, application/json',
			'User-Agent': 'Maestro-VIBES-Cosign',
		};
		if (store.etag) headers['If-None-Match'] = store.etag;
		if (store.last_modified) headers['If-Modified-Since'] = store.last_modified;

		const response = await fetch(url, { method: 'GET', headers, signal: controller.signal });
		clearTimeout(timeout);

		const now = new Date().toISOString();

		if (response.status === 304) {
			store.last_checked = now;
			await saveProviderKeyStore(store);
			return {
				checked: true,
				updated: false,
				currentKeyId: previousKeyId,
				previousKeyId,
				detail: 'Key file unchanged (HTTP 304)',
			};
		}

		if (!response.ok) {
			logger.warn(`Provider key fetch failed: HTTP ${response.status}`, LOG_CONTEXT);
			return {
				checked: true,
				updated: false,
				currentKeyId: previousKeyId,
				previousKeyId,
				detail: `Fetch failed (HTTP ${response.status}); using stored key`,
			};
		}

		const body = await response.text();
		const pems = parsePublishedKeyFile(body);
		if (pems.length === 0) {
			logger.warn('Published key file contained no parseable public key', LOG_CONTEXT);
			return {
				checked: true,
				updated: false,
				currentKeyId: previousKeyId,
				previousKeyId,
				detail: 'Key file had no parseable key; using stored key',
			};
		}

		// The FIRST key in the file is the provider's current key; any extra
		// blocks are still ingested so verification covers overlap windows.
		let updated = false;
		let currentKeyId = previousKeyId;
		let anyRejected = false;
		let newTrustDetail = '';

		// Signed-keys support: when NEW key versions appear, pull the sibling
		// endorsement file once and verify each new key's endorsement (rotation
		// chain via previously-held keys, or the developer root key).
		const knownPems = new Map(store.keys.map((k) => [k.keyid, k.public_key_pem] as const));
		const hasNewKey = pems.some((pem) => {
			try {
				return !knownPems.has(computeKeyId(pem));
			} catch {
				return false;
			}
		});
		const endorsements = hasNewKey ? await fetchEndorsementsFile(url) : null;

		for (let i = 0; i < pems.length; i++) {
			const pem = pems[i];
			let keyid: string;
			try {
				keyid = computeKeyId(pem);
			} catch (err) {
				logger.warn(`Skipping malformed published key: ${String(err)}`, LOG_CONTEXT);
				continue;
			}

			const existing = store.keys.find((k) => k.keyid === keyid);
			if (existing) {
				existing.last_fetched = now;
			} else {
				const evaluated = await evaluateNewKeyTrust(
					pem,
					keyid,
					endorsements,
					knownPems,
					store,
					url
				);
				if (!evaluated) {
					// Published endorsement failed verification: the key does NOT
					// enter the store and cannot become current.
					anyRejected = true;
					continue;
				}
				store.keys.unshift({
					keyid,
					public_key_pem: pem,
					first_seen: now,
					last_fetched: now,
					source_url: url,
					trust: evaluated.trust,
					...(evaluated.endorsedBy ? { endorsed_by: evaluated.endorsedBy } : {}),
				});
				knownPems.set(keyid, pem);
				updated = true;
				newTrustDetail = ` (${evaluated.trust})`;
				logger.info(
					`Pulled down new provider key version ${keyid} [${evaluated.trust}]`,
					LOG_CONTEXT
				);
			}
		}

		// Current = the first published key that made it into the store (a
		// rejected first key leaves the previous current in place).
		for (const pem of pems) {
			try {
				const kid = computeKeyId(pem);
				if (store.keys.some((k) => k.keyid === kid)) {
					currentKeyId = kid;
					break;
				}
			} catch {
				// skip malformed
			}
		}

		store.current_keyid = currentKeyId;
		// Skip storing HTTP validators when a key was rejected so the next check
		// re-fetches instead of 304-ing into a permanently unverified state.
		if (!anyRejected) {
			store.etag = response.headers.get('etag');
			store.last_modified = response.headers.get('last-modified');
		} else {
			store.etag = null;
			store.last_modified = null;
		}
		store.last_checked = now;
		await saveProviderKeyStore(store);

		return {
			checked: true,
			updated,
			currentKeyId,
			previousKeyId,
			detail: updated
				? `New key version ${currentKeyId} pulled down${newTrustDetail}`
				: anyRejected
					? 'Published key REJECTED: endorsement failed verification; keeping stored key'
					: 'Key file re-fetched; version unchanged',
		};
	} catch (error) {
		// Offline / DNS / timeout — the persisted store keeps working
		logger.debug(
			`Provider key check unavailable: ${error instanceof Error ? error.message : String(error)}`,
			LOG_CONTEXT
		);
		return {
			checked: false,
			updated: false,
			currentKeyId: previousKeyId,
			previousKeyId,
			detail: 'Offline; using stored key',
		};
	}
}

/**
 * Look up a provider public key by keyid (content-hash version).
 * Historical keys remain valid for verifying old attestations, so this
 * searches the whole store — not just the current key. Falls back to a
 * network check when the keyid is unknown locally (e.g. verifying an
 * attestation made by a newer Maestro install).
 */
export async function getProviderKeyById(keyid: string): Promise<string | null> {
	const store = await loadProviderKeyStore();
	const local = store.keys.find((k) => k.keyid === keyid);
	if (local) return local.public_key_pem;

	const result = await checkProviderKeyUpdate({ force: true });
	if (!result.checked) return null;

	const refreshed = await loadProviderKeyStore();
	return refreshed.keys.find((k) => k.keyid === keyid)?.public_key_pem ?? null;
}

/** Get the provider's current key (pulling the file if the store is empty). */
export async function getCurrentProviderKey(): Promise<StoredProviderKey | null> {
	let store = await loadProviderKeyStore();
	if (!store.current_keyid) {
		await checkProviderKeyUpdate({ force: true });
		store = await loadProviderKeyStore();
	}
	if (!store.current_keyid) return null;
	return store.keys.find((k) => k.keyid === store.current_keyid) ?? null;
}
