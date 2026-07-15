// VERIFY v1.0 Key Management & Attestation — Ed25519 keypair generation,
// DSSE envelope construction, and in-toto v1 attestation statement building.
//
// Implements the VERIFY specification for cryptographic signing of VIBES audit data.
// The canonical private key is SEALED with the OS keychain (Electron safeStorage)
// inside Maestro userData; the public key lives in plaintext at the spec path
// ~/.vibescheck/keys/ so the external vibecheck CLI can read it. A plaintext
// private key at the spec path is only a fallback (legacy installs, CLI export,
// or hosts where safeStorage is unavailable).
//
// No external crypto dependencies — uses Node.js 18+ native Ed25519 support.

import {
	generateKeyPairSync,
	createHash,
	sign,
	verify as cryptoVerify,
	createPublicKey,
	KeyObject,
} from 'crypto';
import { readFile, writeFile, mkdir, stat, chmod, access, constants } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { safeStorageSeal } from '../plugins/authorization-ledger';
import type { SealProvider } from '../plugins/authorization-ledger';
import { isWindows } from '../../shared/platformDetection';
import { execFileNoThrow } from '../utils/execFile';
import { logger } from '../utils/logger';

// ============================================================================
// Constants
// ============================================================================

/** Root directory for VIBES keys (per VERIFY spec). */
const KEYS_DIR = path.join(os.homedir(), '.vibescheck', 'keys');

/** Private key filename. */
const PRIVATE_KEY_FILE = 'vibescheck.key';

/** Public key filename. */
const PUBLIC_KEY_FILE = 'vibescheck.pub';

/** Sealed private-key filename (inside Maestro userData, NOT the spec dir). */
export const SEALED_KEY_FILE = 'vibescheck.key.sealed';

/** Audit directory name at project root. */
const AUDIT_DIR = '.ai-audit';

/** Files that form the attestation subject. */
const ATTESTATION_SUBJECT_FILES = ['manifest.json', 'annotations.jsonl', 'config.json'];

// ============================================================================
// Types
// ============================================================================

export interface VibesKeyPair {
	publicKey: string; // SPKI PEM
	privateKey: string; // PKCS8 PEM (NEVER log)
	keyId: string; // SHA-256[0:16] of DER public key (16 hex chars)
}

/** Why the private key is NOT encrypted at rest. */
export type EncryptedAtRestReason = 'os-keychain-unavailable' | 'plaintext-legacy-key';

export interface VibesKeyInfo {
	publicKey: string;
	keyId: string;
	exists: boolean;
	/**
	 * True when the canonical private key is sealed with the OS keychain
	 * (Electron safeStorage) in Maestro userData. False means the key lives
	 * as hardened plaintext at the spec path. Optional only so existing
	 * mocks stay shape-compatible; getUserKeyInfo always sets it.
	 */
	encryptedAtRest?: boolean;
	/** Set when encryptedAtRest is false and the cause is known. */
	encryptedAtRestReason?: EncryptedAtRestReason;
}

export type { SealProvider } from '../plugins/authorization-ledger';

/**
 * Injectable storage context for key persistence. Production resolves lazily
 * to Electron safeStorage + userData; unit tests inject a fake SealProvider
 * and temp directories so this module never needs an Electron runtime.
 */
export interface KeyStoreContext {
	seal: SealProvider;
	/** Directory holding the sealed private key (production: <userData>/vibes). */
	sealedKeyDir: string;
	/** Directory holding the plaintext spec keys (production: ~/.vibescheck/keys). */
	specKeysDir: string;
}

// VERIFY spec types — re-exported from shared for backward compat
export type { DSSEEnvelope, DSSESignature, InTotoStatement } from '../../shared/vibes-types';

import type { DSSEEnvelope, DSSESignature, InTotoStatement } from '../../shared/vibes-types';

// ============================================================================
// Key Generation & ID Computation
// ============================================================================

/**
 * Generate Ed25519 keypair per VERIFY spec.
 * Returns SPKI PEM public key, PKCS8 PEM private key, and computed key ID.
 */
export function generateKeyPair(): VibesKeyPair {
	const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
		publicKeyEncoding: { type: 'spki', format: 'pem' },
		privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
	});

	const keyId = computeKeyId(publicKey);

	return { publicKey, privateKey, keyId };
}

/**
 * Compute key ID: SHA-256(DER public key)[0:16] as hex.
 * Per VERIFY spec — deterministic 16-character hex string.
 */
export function computeKeyId(publicKeyPem: string): string {
	const keyObj: KeyObject = createPublicKey(publicKeyPem);
	const derBytes = keyObj.export({ type: 'spki', format: 'der' });
	return createHash('sha256').update(derBytes).digest('hex').slice(0, 16);
}

// ============================================================================
// Key Persistence
// ============================================================================

let productionContext: KeyStoreContext | null = null;

/**
 * Resolve the storage context. When none is injected, lazily binds the
 * production context (Electron safeStorage + userData). The electron import
 * stays dynamic so unit tests can drive persistence with a fake context
 * without an Electron runtime.
 */
async function resolveKeyStoreContext(ctx?: KeyStoreContext): Promise<KeyStoreContext> {
	if (ctx) return ctx;
	if (!productionContext) {
		const { app, safeStorage } = await import('electron');
		productionContext = {
			seal: safeStorageSeal(safeStorage),
			sealedKeyDir: path.join(app.getPath('userData'), 'vibes'),
			specKeysDir: KEYS_DIR,
		};
	}
	return productionContext;
}

/** Derive the SPKI PEM public key from a PKCS8 PEM private key. */
function derivePublicKeyPem(privateKeyPem: string): string {
	return createPublicKey(privateKeyPem).export({ type: 'spki', format: 'pem' }).toString();
}

/**
 * Harden a plaintext private-key file so only the current user can read it.
 * POSIX: chmod 0600. Windows: best-effort ACL restriction via icacls (strip
 * inheritance, grant only the current user full control); a stock user may
 * lack the right on some volumes, so failure is swallowed with a logged
 * warning rather than failing the write.
 */
async function hardenPrivateKeyFile(filePath: string): Promise<void> {
	if (isWindows()) {
		const user = os.userInfo().username;
		const result = await execFileNoThrow('icacls', [
			filePath,
			'/inheritance:r',
			'/grant:r',
			`${user}:F`,
		]);
		if (result.exitCode !== 0) {
			logger.warn(
				'Failed to restrict VIBES private key ACL via icacls - key written but not hardened',
				'VibesKeyManager',
				{ path: filePath, exitCode: result.exitCode, stderr: result.stderr }
			);
		}
		return;
	}
	await chmod(filePath, 0o600);
}

/**
 * Load user keypair. Prefers the sealed store in Maestro userData (unsealed
 * in memory, never written back as plaintext); falls back to a plaintext
 * PKCS8 PEM at the spec path (legacy installs / keys exported for the CLI).
 * Returns null if keys have not been generated yet.
 */
export async function loadUserKeyPair(ctx?: KeyStoreContext): Promise<VibesKeyPair | null> {
	const { seal, sealedKeyDir, specKeysDir } = await resolveKeyStoreContext(ctx);

	if (seal.available()) {
		try {
			const blob = await readFile(path.join(sealedKeyDir, SEALED_KEY_FILE));
			const privateKey = seal.unseal(blob);
			let publicKey: string;
			try {
				publicKey = await readFile(path.join(specKeysDir, PUBLIC_KEY_FILE), 'utf8');
			} catch {
				publicKey = derivePublicKeyPem(privateKey);
			}
			return { publicKey, privateKey, keyId: computeKeyId(publicKey) };
		} catch {
			// No sealed store (or unsealable blob) - fall through to the
			// plaintext spec path below.
		}
	}

	try {
		const privatePath = path.join(specKeysDir, PRIVATE_KEY_FILE);
		const publicPath = path.join(specKeysDir, PUBLIC_KEY_FILE);

		await access(privatePath, constants.R_OK);
		await access(publicPath, constants.R_OK);

		const privateKey = await readFile(privatePath, 'utf8');
		const publicKey = await readFile(publicPath, 'utf8');
		const keyId = computeKeyId(publicKey);

		return { publicKey, privateKey, keyId };
	} catch {
		return null;
	}
}

/**
 * Save user keypair. The public key always goes to the spec path in plaintext
 * (public keys need no protection; the vibecheck CLI reads it there). When
 * sealing is available the private key is sealed into Maestro userData and
 * NO plaintext private key is written. Only when sealing is unavailable
 * (e.g. keyring-less Linux, headless/SSH) does it degrade to the legacy
 * hardened plaintext file at the spec path so key generation still works.
 */
export async function saveUserKeyPair(keyPair: VibesKeyPair, ctx?: KeyStoreContext): Promise<void> {
	const { seal, sealedKeyDir, specKeysDir } = await resolveKeyStoreContext(ctx);

	await mkdir(specKeysDir, { recursive: true });
	const publicPath = path.join(specKeysDir, PUBLIC_KEY_FILE);
	await writeFile(publicPath, keyPair.publicKey, 'utf8');
	await chmod(publicPath, 0o644);

	if (seal.available()) {
		await mkdir(sealedKeyDir, { recursive: true });
		const sealedPath = path.join(sealedKeyDir, SEALED_KEY_FILE);
		await writeFile(sealedPath, seal.seal(keyPair.privateKey));
		await chmod(sealedPath, 0o600);
		return;
	}

	const privatePath = path.join(specKeysDir, PRIVATE_KEY_FILE);
	await writeFile(privatePath, keyPair.privateKey, 'utf8');
	await hardenPrivateKeyFile(privatePath);
}

/**
 * Export the plaintext PKCS8 private key to the spec path
 * (~/.vibescheck/keys/vibescheck.key) so the external vibecheck CLI can sign
 * with it. This is the ONLY code path that intentionally writes the private
 * key unencrypted; it must be triggered by an explicit user action (the UI
 * warns before calling it). The file is permission-hardened after writing.
 * Throws (without writing anything) when no key exists to export.
 */
export async function exportPrivateKeyForCli(ctx?: KeyStoreContext): Promise<{ path: string }> {
	const resolved = await resolveKeyStoreContext(ctx);

	const keyPair = await loadUserKeyPair(resolved);
	if (!keyPair) {
		throw new Error('No signing key to export. Generate a keypair first.');
	}

	await mkdir(resolved.specKeysDir, { recursive: true });
	const privatePath = path.join(resolved.specKeysDir, PRIVATE_KEY_FILE);
	await writeFile(privatePath, keyPair.privateKey, 'utf8');
	await hardenPrivateKeyFile(privatePath);

	return { path: privatePath };
}

/**
 * One-time migration of a legacy plaintext private key into the sealed store.
 * When a plaintext key exists at the spec path, NO sealed store exists yet,
 * and sealing is available, the plaintext is sealed into userData. The
 * plaintext spec file is left in place (the user may rely on it for the
 * vibecheck CLI; loadUserKeyPair prefers the sealed copy from then on).
 * Idempotent: a no-op when a sealed store already exists, sealing is
 * unavailable, or there is no legacy key. Returns true when a migration
 * actually happened.
 */
export async function migrateLegacyKeyIfNeeded(ctx?: KeyStoreContext): Promise<boolean> {
	const { seal, sealedKeyDir, specKeysDir } = await resolveKeyStoreContext(ctx);

	if (!seal.available()) {
		return false;
	}

	const sealedPath = path.join(sealedKeyDir, SEALED_KEY_FILE);
	const sealedExists = await access(sealedPath, constants.R_OK).then(
		() => true,
		() => false
	);
	if (sealedExists) {
		return false;
	}

	let privateKey: string;
	try {
		privateKey = await readFile(path.join(specKeysDir, PRIVATE_KEY_FILE), 'utf8');
	} catch {
		return false;
	}

	await mkdir(sealedKeyDir, { recursive: true });
	await writeFile(sealedPath, seal.seal(privateKey));
	await chmod(sealedPath, 0o600);

	logger.info(
		'Migrated legacy plaintext VIBES signing key into the sealed store (plaintext left in place for the vibecheck CLI)',
		'VibesKeyManager'
	);
	return true;
}

/**
 * Get user key info (public key only; the private key is never written back
 * out). Also reports the honest at-rest encryption status: encryptedAtRest is
 * true only when a sealed private key exists in userData AND the OS keychain
 * (safeStorage) is usable to unseal it. On keyring-less Linux or headless/SSH
 * hosts sealing is unavailable, so the status is false with reason
 * 'os-keychain-unavailable'; a not-yet-migrated plaintext key on a sealing-
 * capable host reports 'plaintext-legacy-key'.
 */
export async function getUserKeyInfo(ctx?: KeyStoreContext): Promise<VibesKeyInfo> {
	const { seal, sealedKeyDir, specKeysDir } = await resolveKeyStoreContext(ctx);

	const sealedPath = path.join(sealedKeyDir, SEALED_KEY_FILE);
	const sealedExists = await access(sealedPath, constants.R_OK).then(
		() => true,
		() => false
	);
	const encryptedAtRest = seal.available() && sealedExists;
	const reason: EncryptedAtRestReason | undefined = encryptedAtRest
		? undefined
		: seal.available()
			? 'plaintext-legacy-key'
			: 'os-keychain-unavailable';

	try {
		const publicPath = path.join(specKeysDir, PUBLIC_KEY_FILE);
		await access(publicPath, constants.R_OK);
		const publicKey = await readFile(publicPath, 'utf8');
		const keyId = computeKeyId(publicKey);
		return encryptedAtRest
			? { publicKey, keyId, exists: true, encryptedAtRest: true }
			: { publicKey, keyId, exists: true, encryptedAtRest: false, encryptedAtRestReason: reason };
	} catch {
		if (encryptedAtRest) {
			// Sealed key present but the spec .pub is missing - derive it in
			// memory (mirrors loadUserKeyPair) so the key still reads as existing.
			try {
				const blob = await readFile(sealedPath);
				const publicKey = derivePublicKeyPem(seal.unseal(blob));
				return {
					publicKey,
					keyId: computeKeyId(publicKey),
					exists: true,
					encryptedAtRest: true,
				};
			} catch {
				// Unsealable blob - report as no key below.
			}
		}
		return {
			publicKey: '',
			keyId: '',
			exists: false,
			encryptedAtRest: false,
			...(seal.available() ? {} : { encryptedAtRestReason: 'os-keychain-unavailable' as const }),
		};
	}
}

/**
 * Check if private key file has correct permissions (0600).
 * Returns { valid: true } if correct, or { valid: false, message } if not.
 */
export async function checkKeyPermissions(): Promise<{ valid: boolean; message?: string }> {
	try {
		const privatePath = path.join(KEYS_DIR, PRIVATE_KEY_FILE);
		const stats = await stat(privatePath);
		const mode = stats.mode & 0o777;

		if (mode !== 0o600) {
			return {
				valid: false,
				message: `Private key permissions are ${mode.toString(8)}, expected 600. Run: chmod 600 ${privatePath}`,
			};
		}

		return { valid: true };
	} catch (error) {
		return {
			valid: false,
			message: `Cannot check key permissions: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

// ============================================================================
// DSSE Pre-Authentication Encoding (PAE)
// ============================================================================

/**
 * Compute PAE (Pre-Authentication Encoding) per DSSE spec.
 *
 * PAE(payloadType, payload) =
 *   "DSSEv1" SP len(payloadType) SP payloadType SP len(payload) SP payload
 *
 * Where SP is a space (0x20) and len() is the byte length as a decimal ASCII string.
 */
export function computePAE(payloadType: string, payload: string): Buffer {
	const payloadTypeBytes = Buffer.from(payloadType, 'utf8');
	const payloadBytes = Buffer.from(payload, 'utf8');

	const header = Buffer.from('DSSEv1 ', 'utf8');
	const ptLen = Buffer.from(payloadTypeBytes.length.toString(), 'utf8');
	const sp1 = Buffer.from(' ', 'utf8');
	const sp2 = Buffer.from(' ', 'utf8');
	const pLen = Buffer.from(payloadBytes.length.toString(), 'utf8');
	const sp3 = Buffer.from(' ', 'utf8');

	return Buffer.concat([header, ptLen, sp1, payloadTypeBytes, sp2, pLen, sp3, payloadBytes]);
}

// ============================================================================
// Signing & Verification
// ============================================================================

/**
 * Sign PAE bytes with Ed25519 private key.
 * Returns base64url-encoded signature (no padding).
 */
export function signPAE(paeBytes: Buffer, privateKeyPem: string): string {
	const signature = sign(null, paeBytes, privateKeyPem);
	return signature.toString('base64url');
}

/**
 * Verify an Ed25519 signature over PAE bytes.
 */
export function verifyPAESignature(
	paeBytes: Buffer,
	signature: string,
	publicKeyPem: string
): boolean {
	try {
		const sigBytes = Buffer.from(signature, 'base64url');
		return cryptoVerify(null, paeBytes, publicKeyPem, sigBytes);
	} catch {
		return false;
	}
}

// ============================================================================
// in-toto v1 Statement Builder
// ============================================================================

/**
 * Build an in-toto v1 attestation statement for a project's .ai-audit/ files.
 * Computes SHA-256 hashes of manifest.json, annotations.jsonl, config.json.
 */
export async function buildInTotoStatement(
	projectPath: string,
	validationResult: 'PASS' | 'FAIL',
	vibesVersion: string
): Promise<InTotoStatement> {
	const auditDir = path.join(projectPath, AUDIT_DIR);

	// Build subjects — compute SHA-256 of each audit file
	const subjects: InTotoStatement['subject'] = [];

	for (const fileName of ATTESTATION_SUBJECT_FILES) {
		const filePath = path.join(auditDir, fileName);
		try {
			const content = await readFile(filePath);
			const hash = createHash('sha256').update(content).digest('hex');
			subjects.push({
				name: `${AUDIT_DIR}/${fileName}`,
				digest: { sha256: hash },
			});
		} catch {
			// File doesn't exist — skip it (e.g., no annotations yet)
		}
	}

	// Count annotations and unique models from annotations.jsonl
	let totalAnnotations = 0;
	const uniqueModels = new Set<string>();

	try {
		const annotationsPath = path.join(auditDir, 'annotations.jsonl');
		const annotationsContent = await readFile(annotationsPath, 'utf8');
		const lines = annotationsContent.split('\n').filter((line) => line.trim());

		for (const line of lines) {
			try {
				const record = JSON.parse(line);
				totalAnnotations++;
				if (record.model_name) {
					uniqueModels.add(record.model_name);
				}
			} catch {
				// Skip malformed lines
			}
		}
	} catch {
		// No annotations file — counts stay at 0
	}

	// Read config for project name and assurance level
	let projectName = path.basename(projectPath);
	let assuranceLevel = 'unknown';

	try {
		const configPath = path.join(auditDir, 'config.json');
		const configContent = await readFile(configPath, 'utf8');
		const config = JSON.parse(configContent);
		if (config.project_name) projectName = config.project_name;
		if (config.assurance_level) assuranceLevel = config.assurance_level;
	} catch {
		// Defaults are fine
	}

	return {
		_type: 'https://in-toto.io/Statement/v1',
		subject: subjects,
		predicateType: 'https://itsavibe.ai/vibes/attestation/v1',
		predicate: {
			validation: { result: validationResult, version: vibesVersion },
			project: { name: projectName, assurance_level: assuranceLevel },
			stats: { total_annotations: totalAnnotations, unique_models: uniqueModels.size },
		},
	};
}

// ============================================================================
// DSSE Envelope Builder
// ============================================================================

/**
 * Build a complete DSSE envelope with user signature.
 * Optionally includes tool provider cosignature.
 */
export async function buildDSSEEnvelope(
	statement: InTotoStatement,
	userKeyPair: VibesKeyPair,
	toolProviderSignature?: DSSESignature
): Promise<DSSEEnvelope> {
	const payloadType = 'application/vnd.in-toto+json' as const;
	const statementJson = JSON.stringify(statement);
	const payload = Buffer.from(statementJson, 'utf8').toString('base64url');

	// Compute PAE and sign
	const paeBytes = computePAE(payloadType, payload);
	const sig = signPAE(paeBytes, userKeyPair.privateKey);

	const signatures: DSSESignature[] = [{ keyid: userKeyPair.keyId, sig, keytype: 'user' }];

	if (toolProviderSignature) {
		signatures.push(toolProviderSignature);
	}

	return { payloadType, payload, signatures };
}

// ============================================================================
// Attestation ID
// ============================================================================

/**
 * Recursively sort all keys in a JSON-compatible value.
 * Per VERIFY spec section 7: "Sort all keys recursively."
 * Arrays preserve order; objects get sorted keys at every nesting level.
 */
export function sortKeysRecursively(value: unknown): unknown {
	if (value === null || value === undefined) return value;
	if (Array.isArray(value)) return value.map(sortKeysRecursively);
	if (typeof value === 'object') {
		const sorted: Record<string, unknown> = {};
		for (const key of Object.keys(value as Record<string, unknown>).sort()) {
			sorted[key] = sortKeysRecursively((value as Record<string, unknown>)[key]);
		}
		return sorted;
	}
	return value;
}

/**
 * Compute content-addressed attestation ID per VERIFY spec section 7.
 * 1. Sort all keys recursively.
 * 2. Serialize with no whitespace.
 * 3. SHA-256 of resulting string.
 * 4. 64-character lowercase hex.
 */
export function computeAttestationId(envelope: DSSEEnvelope): string {
	const canonical = JSON.stringify(sortKeysRecursively(envelope));
	return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

// ============================================================================
// Public Key Export
// ============================================================================

/**
 * Export public key in PEM or SSH format.
 */
export function exportPublicKey(publicKeyPem: string, format: 'pem' | 'ssh'): string {
	if (format === 'pem') {
		return publicKeyPem;
	}

	// Convert PEM to SSH format
	const keyObj = createPublicKey(publicKeyPem);
	const derBytes = keyObj.export({ type: 'spki', format: 'der' });

	// Ed25519 SSH format: "ssh-ed25519 <base64-encoded-key>"
	// The SSH wire format for Ed25519 is:
	// [4 bytes: len("ssh-ed25519")] [11 bytes: "ssh-ed25519"] [4 bytes: keylen] [32 bytes: raw key]
	const keyType = Buffer.from('ssh-ed25519', 'utf8');

	// Extract the raw 32-byte Ed25519 public key from the DER SPKI encoding.
	// SPKI for Ed25519 is: 30 2a 30 05 06 03 2b 65 70 03 21 00 <32 bytes of key>
	// The raw key starts at offset 12.
	const rawKey = derBytes.subarray(12);

	const typeLen = Buffer.alloc(4);
	typeLen.writeUInt32BE(keyType.length);

	const keyLen = Buffer.alloc(4);
	keyLen.writeUInt32BE(rawKey.length);

	const sshBlob = Buffer.concat([typeLen, keyType, keyLen, rawKey]);
	return `ssh-ed25519 ${sshBlob.toString('base64')}`;
}
