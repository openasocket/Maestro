// VERIFY v1.0 Attestation Verification Module
//
// Verifies DSSE envelopes per VERIFY spec section 10 (verification flow):
// 1. Decode base64url payload -> in-toto statement
// 2. Recompute PAE bytes
// 3. For each signature: look up public key by keyid, verify Ed25519 over PAE
// 4. For each subject: recompute SHA-256 of local file, compare to declared digest
// 5. Determine trust tier
//
// Standalone module — can verify attestations without the attestation pipeline.

import { createHash } from 'crypto';
import { readFile } from 'fs/promises';
import * as path from 'path';

import { logger } from '../utils/logger';
import {
	computePAE,
	computeAttestationId,
	verifyPAESignature,
	getUserKeyInfo,
	type DSSEEnvelope,
	type InTotoStatement,
} from './vibes-key-manager';
import { findProviderKey } from './vibes-cosign-service';

const LOG_CONTEXT = '[VIBES-VERIFY]';

/** Audit directory name at project root. */
const AUDIT_DIR = '.ai-audit';

/** Local attestation file name. */
const ATTESTATION_FILE = 'attestation.json';

// ============================================================================
// Types
// ============================================================================

export interface VerificationResult {
	valid: boolean;
	trustTier: 'self-attested' | 'tool-corroborated' | 'tool-only' | 'none';
	signatures: Array<{
		keyid: string;
		keytype: 'user' | 'tool_provider';
		valid: boolean;
		error?: string;
	}>;
	fileIntegrity: Array<{
		name: string;
		declaredHash: string;
		actualHash: string;
		matches: boolean;
	}>;
	attestationId: string;
	issues: string[];
}

// ============================================================================
// Envelope Loading
// ============================================================================

/**
 * Load a DSSE envelope from .ai-audit/attestation.json.
 * Returns null if the file does not exist or cannot be parsed.
 */
async function loadEnvelopeFromDisk(projectPath: string): Promise<DSSEEnvelope | null> {
	try {
		const envelopePath = path.join(projectPath, AUDIT_DIR, ATTESTATION_FILE);
		const content = await readFile(envelopePath, 'utf8');
		const envelope = JSON.parse(content) as DSSEEnvelope;

		// Basic shape validation
		if (!envelope.payloadType || !envelope.payload || !Array.isArray(envelope.signatures)) {
			logger.warn('Attestation file has invalid shape', LOG_CONTEXT);
			return null;
		}

		return envelope;
	} catch {
		return null;
	}
}

// ============================================================================
// Signature Verification
// ============================================================================

/**
 * Verify all signatures in a DSSE envelope.
 * Returns per-signature results and a list of issues.
 */
async function verifySignatures(
	envelope: DSSEEnvelope,
	paeBytes: Buffer
): Promise<{
	results: VerificationResult['signatures'];
	issues: string[];
}> {
	const results: VerificationResult['signatures'] = [];
	const issues: string[] = [];

	for (const sigEntry of envelope.signatures) {
		if (sigEntry.keytype === 'tool_provider') {
			// Verify against published provider keys
			const providerPem = await findProviderKey(sigEntry.keyid);
			if (!providerPem) {
				results.push({
					keyid: sigEntry.keyid,
					keytype: 'tool_provider',
					valid: false,
					error: 'Provider key not found, revoked, or expired',
				});
				issues.push(`Tool provider key ${sigEntry.keyid} not found or invalid`);
				continue;
			}

			const valid = verifyPAESignature(paeBytes, sigEntry.sig, providerPem);
			results.push({
				keyid: sigEntry.keyid,
				keytype: 'tool_provider',
				valid,
				error: valid ? undefined : 'Ed25519 signature verification failed',
			});
			if (!valid) {
				issues.push(`Tool provider signature ${sigEntry.keyid} failed verification`);
			}
		} else {
			// User signature — look up local public key
			const keyInfo = await getUserKeyInfo();

			if (!keyInfo.exists) {
				results.push({
					keyid: sigEntry.keyid,
					keytype: 'user',
					valid: false,
					error: 'User public key not found at ~/.vibescheck/keys/vibescheck.pub',
				});
				issues.push('User public key not found');
				continue;
			}

			if (keyInfo.keyId !== sigEntry.keyid) {
				results.push({
					keyid: sigEntry.keyid,
					keytype: 'user',
					valid: false,
					error: `Key ID mismatch: envelope has ${sigEntry.keyid}, local key is ${keyInfo.keyId}`,
				});
				issues.push(`User key ID mismatch: envelope=${sigEntry.keyid}, local=${keyInfo.keyId}`);
				continue;
			}

			const valid = verifyPAESignature(paeBytes, sigEntry.sig, keyInfo.publicKey);
			results.push({
				keyid: sigEntry.keyid,
				keytype: 'user',
				valid,
				error: valid ? undefined : 'Ed25519 signature verification failed',
			});
			if (!valid) {
				issues.push(`User signature ${sigEntry.keyid} failed verification`);
			}
		}
	}

	return { results, issues };
}

// ============================================================================
// File Integrity Verification
// ============================================================================

/**
 * Verify file integrity by recomputing SHA-256 hashes of local files
 * and comparing them to the declared digests in the in-toto statement.
 */
async function verifyFileIntegrity(
	projectPath: string,
	statement: InTotoStatement
): Promise<{
	results: VerificationResult['fileIntegrity'];
	issues: string[];
}> {
	const results: VerificationResult['fileIntegrity'] = [];
	const issues: string[] = [];

	for (const subject of statement.subject || []) {
		const filePath = path.join(projectPath, subject.name);
		const declaredHash = subject.digest?.sha256 ?? '';

		try {
			const content = await readFile(filePath);
			const actualHash = createHash('sha256').update(content).digest('hex');
			const matches = actualHash === declaredHash;

			results.push({
				name: subject.name,
				declaredHash,
				actualHash,
				matches,
			});

			if (!matches) {
				issues.push(
					`File ${subject.name} hash mismatch: declared=${declaredHash.slice(0, 16)}..., actual=${actualHash.slice(0, 16)}...`
				);
			}
		} catch {
			results.push({
				name: subject.name,
				declaredHash,
				actualHash: '',
				matches: false,
			});
			issues.push(`File ${subject.name} not found or unreadable`);
		}
	}

	return { results, issues };
}

// ============================================================================
// Trust Tier Determination
// ============================================================================

/**
 * Determine the trust tier based on which signatures are present and valid.
 */
function determineTrustTier(
	sigResults: VerificationResult['signatures']
): VerificationResult['trustTier'] {
	const hasValidUser = sigResults.some((s) => s.keytype === 'user' && s.valid);
	const hasValidTool = sigResults.some((s) => s.keytype === 'tool_provider' && s.valid);

	if (hasValidUser && hasValidTool) return 'tool-corroborated';
	if (hasValidUser) return 'self-attested';
	if (hasValidTool) return 'tool-only';
	return 'none';
}

// ============================================================================
// Main Verification Entry Point
// ============================================================================

/**
 * Verify a DSSE envelope per VERIFY spec section 10 (verification flow):
 * 1. Decode base64url payload -> in-toto statement
 * 2. Recompute PAE bytes
 * 3. For each signature: look up public key by keyid, verify Ed25519 over PAE
 * 4. For each subject: recompute SHA-256 of local file, compare to declared digest
 * 5. Determine trust tier
 *
 * @param projectPath - Project root containing .ai-audit/ directory
 * @param envelope - DSSE envelope to verify. If not provided, loads from .ai-audit/attestation.json
 */
export async function verifyAttestation(
	projectPath: string,
	envelope?: DSSEEnvelope
): Promise<VerificationResult> {
	const allIssues: string[] = [];

	// ── Load envelope ────────────────────────────────────────────────────
	const envelopeToVerify = envelope ?? (await loadEnvelopeFromDisk(projectPath));

	if (!envelopeToVerify) {
		logger.warn('No attestation envelope found or provided', LOG_CONTEXT);
		return {
			valid: false,
			trustTier: 'none',
			signatures: [],
			fileIntegrity: [],
			attestationId: '',
			issues: ['No attestation envelope found. Expected .ai-audit/attestation.json'],
		};
	}

	// ── Step 1: Decode payload ───────────────────────────────────────────
	let statement: InTotoStatement;
	try {
		const statementJson = Buffer.from(envelopeToVerify.payload, 'base64url').toString('utf8');
		statement = JSON.parse(statementJson) as InTotoStatement;

		if (statement._type !== 'https://in-toto.io/Statement/v1') {
			allIssues.push(
				`Unexpected statement type: ${statement._type} (expected https://in-toto.io/Statement/v1)`
			);
		}
	} catch (error) {
		logger.warn(
			`Failed to decode envelope payload: ${error instanceof Error ? error.message : String(error)}`,
			LOG_CONTEXT
		);
		return {
			valid: false,
			trustTier: 'none',
			signatures: [],
			fileIntegrity: [],
			attestationId: '',
			issues: ['Failed to decode base64url payload from envelope'],
		};
	}

	// ── Step 2: Recompute PAE bytes ──────────────────────────────────────
	const paeBytes = computePAE(envelopeToVerify.payloadType, envelopeToVerify.payload);

	// ── Step 3: Verify all signatures ────────────────────────────────────
	logger.info(`Verifying ${envelopeToVerify.signatures.length} signature(s)`, LOG_CONTEXT);
	const sigVerification = await verifySignatures(envelopeToVerify, paeBytes);
	allIssues.push(...sigVerification.issues);

	// ── Step 4: Verify file integrity ────────────────────────────────────
	logger.info(`Verifying integrity of ${statement.subject?.length ?? 0} file(s)`, LOG_CONTEXT);
	const fileVerification = await verifyFileIntegrity(projectPath, statement);
	allIssues.push(...fileVerification.issues);

	// ── Step 5: Determine trust tier ─────────────────────────────────────
	const trustTier = determineTrustTier(sigVerification.results);

	// ── Compute attestation ID ───────────────────────────────────────────
	const attestationId = computeAttestationId(envelopeToVerify);

	// ── Determine overall validity ───────────────────────────────────────
	const allSignaturesValid =
		sigVerification.results.length > 0 && sigVerification.results.every((s) => s.valid);
	const allFilesValid =
		fileVerification.results.length > 0 && fileVerification.results.every((f) => f.matches);
	const valid = allSignaturesValid && allFilesValid;

	logger.info(
		`Verification complete: valid=${valid}, tier=${trustTier}, id=${attestationId.slice(0, 16)}...`,
		LOG_CONTEXT
	);

	return {
		valid,
		trustTier,
		signatures: sigVerification.results,
		fileIntegrity: fileVerification.results,
		attestationId,
		issues: allIssues,
	};
}
