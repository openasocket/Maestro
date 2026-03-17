// VERIFY v1.0 Key Management & Attestation — Ed25519 keypair generation,
// DSSE envelope construction, and in-toto v1 attestation statement building.
//
// Implements the VERIFY specification for cryptographic signing of VIBES audit data.
// Keys are stored at ~/.vibescheck/keys/ per the spec.
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

// ============================================================================
// Constants
// ============================================================================

/** Root directory for VIBES keys (per VERIFY spec). */
const KEYS_DIR = path.join(os.homedir(), '.vibescheck', 'keys');

/** Private key filename. */
const PRIVATE_KEY_FILE = 'vibescheck.key';

/** Public key filename. */
const PUBLIC_KEY_FILE = 'vibescheck.pub';

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

export interface VibesKeyInfo {
	publicKey: string;
	keyId: string;
	exists: boolean;
}

// === VERIFY Spec: DSSE Envelope ===

export interface DSSEEnvelope {
	payloadType: 'application/vnd.in-toto+json';
	payload: string; // Base64url-encoded in-toto statement
	signatures: DSSESignature[];
}

export interface DSSESignature {
	keyid: string; // 16 hex chars
	sig: string; // Base64url-encoded Ed25519 signature over PAE bytes
	keytype?: 'user' | 'tool_provider';
}

// === VERIFY Spec: in-toto v1 Statement ===

export interface InTotoStatement {
	_type: 'https://in-toto.io/Statement/v1';
	subject: Array<{
		name: string; // e.g., '.ai-audit/manifest.json'
		digest: { sha256: string };
	}>;
	predicateType: 'https://itsavibe.ai/vibes/attestation/v1';
	predicate: {
		validation: { result: 'PASS' | 'FAIL'; version: string };
		project: { name: string; assurance_level: string };
		stats: { total_annotations: number; unique_models: number };
	};
}

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

/**
 * Load user keypair from ~/.vibescheck/keys/.
 * Returns null if keys have not been generated yet.
 */
export async function loadUserKeyPair(): Promise<VibesKeyPair | null> {
	try {
		const privatePath = path.join(KEYS_DIR, PRIVATE_KEY_FILE);
		const publicPath = path.join(KEYS_DIR, PUBLIC_KEY_FILE);

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
 * Save user keypair to ~/.vibescheck/keys/.
 * Sets chmod 0600 on private key, 0644 on public key.
 */
export async function saveUserKeyPair(keyPair: VibesKeyPair): Promise<void> {
	await mkdir(KEYS_DIR, { recursive: true });

	const privatePath = path.join(KEYS_DIR, PRIVATE_KEY_FILE);
	const publicPath = path.join(KEYS_DIR, PUBLIC_KEY_FILE);

	await writeFile(privatePath, keyPair.privateKey, 'utf8');
	await chmod(privatePath, 0o600);

	await writeFile(publicPath, keyPair.publicKey, 'utf8');
	await chmod(publicPath, 0o644);
}

/**
 * Get user key info (public only) without loading private key.
 */
export async function getUserKeyInfo(): Promise<VibesKeyInfo> {
	try {
		const publicPath = path.join(KEYS_DIR, PUBLIC_KEY_FILE);
		await access(publicPath, constants.R_OK);
		const publicKey = await readFile(publicPath, 'utf8');
		const keyId = computeKeyId(publicKey);
		return { publicKey, keyId, exists: true };
	} catch {
		return { publicKey: '', keyId: '', exists: false };
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
 * Compute content-addressed attestation ID per VERIFY spec.
 * SHA-256 of canonicalized (sorted keys, no whitespace) DSSE envelope JSON.
 */
export function computeAttestationId(envelope: DSSEEnvelope): string {
	const canonical = JSON.stringify(envelope, Object.keys(envelope).sort());
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
