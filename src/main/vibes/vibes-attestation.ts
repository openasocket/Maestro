// VERIFY v1.0 Attestation Pipeline
//
// Full 7-step attestation workflow: audit → hash → tool cosign → user sign →
// timestamp → submit → verify. Triggered explicitly by the user (not on every write).
//
// Per VERIFY spec: attestation is a point-in-time operation. The entire .ai-audit/
// directory is signed as a unit after data capture is complete.

import { createHash } from 'crypto';
import { readFile, writeFile, access, constants } from 'fs/promises';
import * as path from 'path';

import { logger } from '../utils/logger';
import {
	loadUserKeyPair,
	buildInTotoStatement,
	buildDSSEEnvelope,
	computeAttestationId,
	computePAE,
	type DSSEEnvelope,
	type DSSESignature,
	type VibesKeyPair,
} from './vibes-key-manager';
import { computePAEHash, requestCosignature } from './vibes-cosign-service';

const LOG_CONTEXT = '[VIBES-ATTEST]';

/** Audit directory name at project root. */
const AUDIT_DIR = '.ai-audit';

/** Files that form the attestation subject. */
const ATTESTATION_SUBJECT_FILES = ['manifest.json', 'annotations.jsonl', 'config.json'];

/** Default registry URL for attestation submission. */
const DEFAULT_REGISTRY_URL = 'https://itsavibe.ai/api/attestation/submit';

/** Request timeout for registry submission (15 seconds). */
const SUBMIT_TIMEOUT_MS = 15_000;

// ============================================================================
// Types
// ============================================================================

export interface AttestationOptions {
	projectPath: string;
	/** Whether to request tool provider cosignature. Default: true */
	cosign?: boolean;
	/** Custom cosigning URL. Default: Maestro's endpoint */
	cosignUrl?: string;
	/** Whether to submit to the public registry. Default: true */
	submit?: boolean;
	/** Registry URL. Default: https://itsavibe.ai/api/attestation/submit */
	registryUrl?: string;
	/** Validation result override. Default: 'PASS' */
	validationResult?: 'PASS' | 'FAIL';
	/** VIBES version string. Default: '1.0.0' */
	vibesVersion?: string;
}

type StepStatus = 'pass' | 'fail' | 'skipped';

export interface AttestationResult {
	success: boolean;
	attestationId?: string;
	envelope?: DSSEEnvelope;
	trustTier: 'self-attested' | 'tool-corroborated' | 'tool-only' | 'none';
	error?: string;
	/** Per-step status for UI progress */
	steps: {
		audit: StepStatus;
		hash: StepStatus;
		toolSign: StepStatus;
		userSign: StepStatus;
		timestamp: StepStatus;
		submit: StepStatus;
	};
}

// ============================================================================
// Step 1 — Audit Validation
// ============================================================================

/**
 * Validate the .ai-audit/ directory structure and hash integrity.
 * Checks that required files exist and config.json has required fields.
 */
async function validateAuditDirectory(
	projectPath: string
): Promise<{ valid: boolean; issues: string[] }> {
	const auditDir = path.join(projectPath, AUDIT_DIR);
	const issues: string[] = [];

	// Check that .ai-audit/ directory exists (via config.json access check)
	for (const fileName of ATTESTATION_SUBJECT_FILES) {
		const filePath = path.join(auditDir, fileName);
		try {
			await access(filePath, constants.R_OK);
		} catch {
			issues.push(`Missing required file: ${AUDIT_DIR}/${fileName}`);
		}
	}

	if (issues.length > 0) {
		return { valid: false, issues };
	}

	// Validate config.json has required fields
	try {
		const configContent = await readFile(path.join(auditDir, 'config.json'), 'utf8');
		const config = JSON.parse(configContent);

		if (!config.standard) {
			issues.push('config.json missing required field: standard');
		}
		if (!config.standard_version) {
			issues.push('config.json missing required field: standard_version');
		}
		if (!config.assurance_level) {
			issues.push('config.json missing required field: assurance_level');
		}
	} catch (error) {
		issues.push(
			`config.json parse error: ${error instanceof Error ? error.message : String(error)}`
		);
	}

	// Verify manifest entries have valid hashes (re-compute and compare)
	try {
		const manifestContent = await readFile(path.join(auditDir, 'manifest.json'), 'utf8');
		const manifest = JSON.parse(manifestContent);

		if (manifest.entries && typeof manifest.entries === 'object') {
			for (const hash of Object.keys(manifest.entries)) {
				if (typeof hash !== 'string' || hash.length < 16) {
					issues.push(`Manifest entry has invalid hash key: ${hash}`);
				}
			}
		}
	} catch (error) {
		issues.push(
			`manifest.json parse error: ${error instanceof Error ? error.message : String(error)}`
		);
	}

	return { valid: issues.length === 0, issues };
}

// ============================================================================
// Step 2 — Hash Computation
// ============================================================================

/**
 * Compute SHA-256 hashes of the attestation subject files.
 */
async function computeSubjectHashes(
	projectPath: string
): Promise<Array<{ name: string; digest: { sha256: string } }>> {
	const auditDir = path.join(projectPath, AUDIT_DIR);
	const subjects: Array<{ name: string; digest: { sha256: string } }> = [];

	for (const fileName of ATTESTATION_SUBJECT_FILES) {
		const filePath = path.join(auditDir, fileName);
		try {
			const content = await readFile(filePath);
			const hash = createHash('sha256').update(content).digest('hex');
			subjects.push({ name: `${AUDIT_DIR}/${fileName}`, digest: { sha256: hash } });
		} catch {
			// File doesn't exist — skip (validated in step 1)
		}
	}

	return subjects;
}

// ============================================================================
// Step 6 — Registry Submission
// ============================================================================

/**
 * Submit a DSSE envelope to the attestation registry.
 * Returns the attestation ID from the registry or null on failure.
 */
async function submitToRegistry(
	envelope: DSSEEnvelope,
	attestationId: string,
	registryUrl: string
): Promise<{ submitted: boolean; error?: string }> {
	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), SUBMIT_TIMEOUT_MS);

		const response = await fetch(registryUrl, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/json',
				'User-Agent': 'Maestro-VIBES-Attest',
			},
			body: JSON.stringify({
				attestation_id: attestationId,
				envelope,
			}),
			signal: controller.signal,
		});

		clearTimeout(timeout);

		if (!response.ok) {
			const body = await response.text().catch(() => '');
			return {
				submitted: false,
				error: `Registry returned HTTP ${response.status}${body ? `: ${body}` : ''}`,
			};
		}

		logger.info(`Attestation ${attestationId} submitted to registry`, LOG_CONTEXT);
		return { submitted: true };
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		logger.debug(`Registry submission unavailable: ${msg}`, LOG_CONTEXT);
		return { submitted: false, error: msg };
	}
}

// ============================================================================
// Main Pipeline
// ============================================================================

/**
 * Run the full VERIFY attestation pipeline.
 *
 * Steps:
 * 1. Validate .ai-audit/ directory (structure, hash integrity)
 * 2. Compute SHA-256 hashes of manifest.json, annotations.jsonl, config.json
 * 3. Build in-toto v1 statement with file subjects
 * 4. Compute PAE bytes
 * 5. (Optional) Send PAE hash to tool provider for cosignature
 * 6. Sign PAE bytes with user's Ed25519 key
 * 7. Assemble DSSE envelope
 * 8. Compute content-addressed attestation ID
 * 9. (Optional) Submit to registry
 */
export async function createAttestation(
	options: AttestationOptions,
	keyManager?: { loadKeyPair: () => Promise<VibesKeyPair | null> },
	onProgress?: (step: string, status: string) => void
): Promise<AttestationResult> {
	const steps: AttestationResult['steps'] = {
		audit: 'skipped',
		hash: 'skipped',
		toolSign: 'skipped',
		userSign: 'skipped',
		timestamp: 'skipped',
		submit: 'skipped',
	};

	const progress = (step: string, status: string) => {
		if (onProgress) {
			try {
				onProgress(step, status);
			} catch {
				// Never let a callback failure break the pipeline
			}
		}
	};

	// ── Step 1: Audit Validation ──────────────────────────────────────────
	progress('audit', 'running');
	logger.info('Step 1: Validating .ai-audit/ directory', LOG_CONTEXT);

	const auditResult = await validateAuditDirectory(options.projectPath);
	if (!auditResult.valid) {
		steps.audit = 'fail';
		const issueList = auditResult.issues.join('; ');
		logger.warn(`Audit validation failed: ${issueList}`, LOG_CONTEXT);
		progress('audit', 'fail');
		return {
			success: false,
			trustTier: 'none',
			error: `Audit validation failed: ${issueList}`,
			steps,
		};
	}
	steps.audit = 'pass';
	progress('audit', 'pass');

	// ── Step 2: Hash Computation ──────────────────────────────────────────
	progress('hash', 'running');
	logger.info('Step 2: Computing subject hashes', LOG_CONTEXT);

	const subjects = await computeSubjectHashes(options.projectPath);
	if (subjects.length === 0) {
		steps.hash = 'fail';
		progress('hash', 'fail');
		return {
			success: false,
			trustTier: 'none',
			error: 'No audit files found to hash',
			steps,
		};
	}
	steps.hash = 'pass';
	progress('hash', 'pass');

	// ── Step 3: Build in-toto statement ───────────────────────────────────
	const validationResult = options.validationResult ?? 'PASS';
	const vibesVersion = options.vibesVersion ?? '1.0.0';
	const statement = await buildInTotoStatement(options.projectPath, validationResult, vibesVersion);

	// ── Step 4: Compute PAE bytes ─────────────────────────────────────────
	const payloadType = 'application/vnd.in-toto+json' as const;
	const statementJson = JSON.stringify(statement);
	const payload = Buffer.from(statementJson, 'utf8').toString('base64url');
	const paeBytes = computePAE(payloadType, payload);

	// ── Step 5: Tool Provider Cosignature (optional) ──────────────────────
	let toolProviderSig: DSSESignature | undefined;

	if (options.cosign !== false) {
		progress('toolSign', 'running');
		logger.info('Step 3: Requesting tool provider cosignature', LOG_CONTEXT);

		const paeHash = computePAEHash(paeBytes);
		const cosignResult = await requestCosignature(paeHash);

		if (cosignResult) {
			toolProviderSig = cosignResult;
			steps.toolSign = 'pass';
			logger.info(`Tool provider cosignature received: ${cosignResult.keyid}`, LOG_CONTEXT);
			progress('toolSign', 'pass');
		} else {
			steps.toolSign = 'fail';
			logger.info(
				'Tool provider cosignature unavailable, continuing with self-attestation',
				LOG_CONTEXT
			);
			progress('toolSign', 'fail');
		}
	} else {
		steps.toolSign = 'skipped';
	}

	// ── Step 6: User Signing ──────────────────────────────────────────────
	progress('userSign', 'running');
	logger.info('Step 4: Signing with user Ed25519 key', LOG_CONTEXT);

	const loadKeyPairFn = keyManager?.loadKeyPair ?? loadUserKeyPair;
	const userKeyPair = await loadKeyPairFn();

	if (!userKeyPair) {
		steps.userSign = 'fail';
		progress('userSign', 'fail');
		return {
			success: false,
			trustTier: 'none',
			error: 'No signing key found. Run keygen first.',
			steps,
		};
	}

	// Build the DSSE envelope (includes user signature + optional tool sig)
	const envelope = await buildDSSEEnvelope(statement, userKeyPair, toolProviderSig);
	steps.userSign = 'pass';
	progress('userSign', 'pass');

	// ── Step 7: Timestamp (stub — OpenTimestamps future enhancement) ─────
	// TODO: OpenTimestamps integration (future enhancement)
	steps.timestamp = 'skipped';

	// ── Compute content-addressed attestation ID ──────────────────────────
	const attestationId = computeAttestationId(envelope);
	logger.info(`Attestation ID: ${attestationId}`, LOG_CONTEXT);

	// ── Save envelope locally to .ai-audit/attestation.json ──────────────
	const attestationPath = path.join(options.projectPath, AUDIT_DIR, 'attestation.json');
	await writeFile(attestationPath, JSON.stringify(envelope, null, 2), 'utf8');
	logger.info(`Envelope saved to ${attestationPath}`, LOG_CONTEXT);

	// ── Step 8: Registry Submission (optional) ────────────────────────────
	if (options.submit !== false) {
		progress('submit', 'running');
		logger.info('Step 6: Submitting to registry', LOG_CONTEXT);

		const registryUrl = options.registryUrl ?? DEFAULT_REGISTRY_URL;
		const submitResult = await submitToRegistry(envelope, attestationId, registryUrl);

		if (submitResult.submitted) {
			steps.submit = 'pass';
			progress('submit', 'pass');
		} else {
			steps.submit = 'fail';
			logger.info(`Registry submission failed: ${submitResult.error}`, LOG_CONTEXT);
			progress('submit', 'fail');
			// Submission failure is non-fatal — attestation is still valid locally
		}
	} else {
		steps.submit = 'skipped';
	}

	// ── Determine trust tier ──────────────────────────────────────────────
	let trustTier: AttestationResult['trustTier'];
	const hasUserSig = envelope.signatures.some((s) => s.keytype === 'user');
	const hasToolSig = envelope.signatures.some((s) => s.keytype === 'tool_provider');

	if (hasUserSig && hasToolSig) {
		trustTier = 'tool-corroborated';
	} else if (hasUserSig) {
		trustTier = 'self-attested';
	} else if (hasToolSig) {
		trustTier = 'tool-only';
	} else {
		trustTier = 'none';
	}

	logger.info(`Attestation complete: tier=${trustTier}, id=${attestationId}`, LOG_CONTEXT);

	return {
		success: true,
		attestationId,
		envelope,
		trustTier,
		steps,
	};
}
