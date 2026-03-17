/**
 * Integration tests for the VERIFY attestation pipeline and verification flow.
 * Covers: vibes-attestation.ts (createAttestation) and vibes-verify-attestation.ts (verifyAttestation)
 *
 * Test matrix:
 *  1. Full pipeline: audit -> hash -> sign -> envelope -> ID
 *  2. Cosigning: envelope has both user and tool_provider signatures
 *  3. Cosigning offline: graceful degradation to self-attested
 *  4. Verification: valid envelope passes all checks
 *  5. Verification: tampered manifest.json fails file integrity check
 *  6. Verification: tampered signature fails Ed25519 check
 *  7. Trust tier: user-only = self-attested
 *  8. Trust tier: user + tool = tool-corroborated
 *  9. Trust tier: tool-only = tool-only
 * 10. No key: returns helpful error message
 * 11. Attestation ID is deterministic
 * 12. Envelope saved to .ai-audit/attestation.json
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// ============================================================================
// Module-level mocks (vi.mock calls are hoisted above imports)
// ============================================================================

vi.mock('../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		debug: vi.fn(),
		error: vi.fn(),
	},
}));

vi.mock('../../../main/vibes/vibes-cosign-service', async (importOriginal) => {
	const mod = await importOriginal<typeof import('../../../main/vibes/vibes-cosign-service')>();
	return {
		...mod,
		requestCosignature: vi.fn().mockResolvedValue(null),
		findProviderKey: vi.fn().mockResolvedValue(null),
	};
});

vi.mock('../../../main/vibes/vibes-key-manager', async (importOriginal) => {
	const mod = await importOriginal<typeof import('../../../main/vibes/vibes-key-manager')>();
	return {
		...mod,
		getUserKeyInfo: vi.fn().mockResolvedValue({ exists: false, publicKey: '', keyId: '' }),
	};
});

// ============================================================================
// Imports
// ============================================================================

import {
	generateKeyPair,
	computePAE,
	signPAE,
	buildInTotoStatement,
	computeAttestationId,
	getUserKeyInfo,
	type VibesKeyPair,
	type DSSEEnvelope,
} from '../../../main/vibes/vibes-key-manager';

import { createAttestation } from '../../../main/vibes/vibes-attestation';
import { verifyAttestation } from '../../../main/vibes/vibes-verify-attestation';

import { requestCosignature, findProviderKey } from '../../../main/vibes/vibes-cosign-service';

// ============================================================================
// Helpers
// ============================================================================

/** Set up a valid .ai-audit/ directory with required files. */
async function setupAuditDir(projectPath: string): Promise<string> {
	const auditDir = path.join(projectPath, '.ai-audit');
	await mkdir(auditDir, { recursive: true });

	const config = {
		standard: 'VIBES',
		standard_version: '1.0',
		assurance_level: 'high',
		project_name: 'test-project',
	};
	const manifest = {
		entries: {
			abcdef1234567890abcdef: {
				timestamp: '2026-01-01T00:00:00Z',
				type: 'annotation',
			},
		},
	};
	const annotations = [
		JSON.stringify({ type: 'line', model_name: 'claude-4' }),
		JSON.stringify({ type: 'session', model_name: 'gpt-5' }),
		JSON.stringify({ type: 'line', model_name: 'claude-4' }),
	].join('\n');

	await writeFile(path.join(auditDir, 'config.json'), JSON.stringify(config));
	await writeFile(path.join(auditDir, 'manifest.json'), JSON.stringify(manifest));
	await writeFile(path.join(auditDir, 'annotations.jsonl'), annotations);

	return auditDir;
}

/** Create a keyManager that returns the given keypair (or null). */
function mockKeyManager(keyPair: VibesKeyPair | null) {
	return { loadKeyPair: async () => keyPair };
}

// ============================================================================
// Tests
// ============================================================================

describe('vibes-attestation pipeline', () => {
	let tempDir: string;
	let testKeyPair: VibesKeyPair;
	const mockFetch = vi.fn();

	beforeEach(async () => {
		tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibes-attest-test-'));
		testKeyPair = generateKeyPair();
		vi.stubGlobal('fetch', mockFetch);
		mockFetch.mockReset();
		vi.mocked(requestCosignature).mockReset().mockResolvedValue(null);
		vi.mocked(findProviderKey).mockReset().mockResolvedValue(null);
		vi.mocked(getUserKeyInfo).mockReset().mockResolvedValue({
			exists: false,
			publicKey: '',
			keyId: '',
		});
	});

	afterEach(async () => {
		vi.unstubAllGlobals();
		await rm(tempDir, { recursive: true, force: true });
	});

	// ── 1. Full pipeline: audit -> hash -> sign -> envelope -> ID ────────
	it('should complete full attestation pipeline: audit -> hash -> sign -> envelope -> ID', async () => {
		await setupAuditDir(tempDir);

		const result = await createAttestation(
			{ projectPath: tempDir, cosign: false, submit: false },
			mockKeyManager(testKeyPair)
		);

		expect(result.success).toBe(true);
		expect(result.error).toBeUndefined();
		expect(result.steps.audit).toBe('pass');
		expect(result.steps.hash).toBe('pass');
		expect(result.steps.userSign).toBe('pass');
		expect(result.steps.toolSign).toBe('skipped');
		expect(result.steps.timestamp).toBe('skipped');
		expect(result.steps.submit).toBe('skipped');

		// Envelope structure
		expect(result.envelope).toBeDefined();
		expect(result.envelope!.payloadType).toBe('application/vnd.in-toto+json');
		expect(result.envelope!.signatures).toHaveLength(1);
		expect(result.envelope!.signatures[0].keyid).toBe(testKeyPair.keyId);
		expect(result.envelope!.signatures[0].keytype).toBe('user');

		// Attestation ID is a 64-char hex SHA-256
		expect(result.attestationId).toMatch(/^[0-9a-f]{64}$/);

		// Payload decodes to valid in-toto statement
		const decoded = JSON.parse(Buffer.from(result.envelope!.payload, 'base64url').toString('utf8'));
		expect(decoded._type).toBe('https://in-toto.io/Statement/v1');
		expect(decoded.subject.length).toBeGreaterThan(0);
	});

	// ── 2. Cosigning: both user and tool_provider signatures ────────────
	it('should include both user and tool_provider signatures when cosigning succeeds', async () => {
		await setupAuditDir(tempDir);

		vi.mocked(requestCosignature).mockResolvedValue({
			keyid: 'toolprovider12345',
			sig: 'mock-tool-sig-base64url',
			keytype: 'tool_provider',
		});

		const result = await createAttestation(
			{ projectPath: tempDir, cosign: true, submit: false },
			mockKeyManager(testKeyPair)
		);

		expect(result.success).toBe(true);
		expect(result.envelope!.signatures).toHaveLength(2);

		const userSig = result.envelope!.signatures.find((s) => s.keytype === 'user');
		const toolSig = result.envelope!.signatures.find((s) => s.keytype === 'tool_provider');

		expect(userSig).toBeDefined();
		expect(userSig!.keyid).toBe(testKeyPair.keyId);
		expect(toolSig).toBeDefined();
		expect(toolSig!.keyid).toBe('toolprovider12345');
		expect(result.steps.toolSign).toBe('pass');
	});

	// ── 3. Cosigning offline: graceful degradation ──────────────────────
	it('should degrade gracefully to self-attested when cosigning is unavailable', async () => {
		await setupAuditDir(tempDir);
		vi.mocked(requestCosignature).mockResolvedValue(null);

		const result = await createAttestation(
			{ projectPath: tempDir, cosign: true, submit: false },
			mockKeyManager(testKeyPair)
		);

		expect(result.success).toBe(true);
		expect(result.trustTier).toBe('self-attested');
		expect(result.steps.toolSign).toBe('fail');
		expect(result.envelope!.signatures).toHaveLength(1);
		expect(result.envelope!.signatures[0].keytype).toBe('user');
	});

	// ── 4. Verification: valid envelope passes all checks ───────────────
	it('should verify a valid attestation envelope', async () => {
		await setupAuditDir(tempDir);

		const attestResult = await createAttestation(
			{ projectPath: tempDir, cosign: false, submit: false },
			mockKeyManager(testKeyPair)
		);
		expect(attestResult.success).toBe(true);

		vi.mocked(getUserKeyInfo).mockResolvedValue({
			exists: true,
			publicKey: testKeyPair.publicKey,
			keyId: testKeyPair.keyId,
		});

		const verifyResult = await verifyAttestation(tempDir, attestResult.envelope);

		expect(verifyResult.valid).toBe(true);
		expect(verifyResult.trustTier).toBe('self-attested');
		expect(verifyResult.signatures).toHaveLength(1);
		expect(verifyResult.signatures[0].valid).toBe(true);
		expect(verifyResult.signatures[0].keytype).toBe('user');
		expect(verifyResult.fileIntegrity.length).toBeGreaterThan(0);
		expect(verifyResult.fileIntegrity.every((f) => f.matches)).toBe(true);
		expect(verifyResult.issues).toHaveLength(0);
		expect(verifyResult.attestationId).toMatch(/^[0-9a-f]{64}$/);
	});

	// ── 5. Verification: tampered manifest.json fails integrity ─────────
	it('should fail integrity check when manifest.json is tampered after attestation', async () => {
		const auditDir = await setupAuditDir(tempDir);

		const attestResult = await createAttestation(
			{ projectPath: tempDir, cosign: false, submit: false },
			mockKeyManager(testKeyPair)
		);
		expect(attestResult.success).toBe(true);

		// Tamper with manifest.json after attestation
		await writeFile(
			path.join(auditDir, 'manifest.json'),
			JSON.stringify({ entries: {}, tampered: true })
		);

		vi.mocked(getUserKeyInfo).mockResolvedValue({
			exists: true,
			publicKey: testKeyPair.publicKey,
			keyId: testKeyPair.keyId,
		});

		const verifyResult = await verifyAttestation(tempDir, attestResult.envelope);

		expect(verifyResult.valid).toBe(false);
		const manifestFile = verifyResult.fileIntegrity.find((f) => f.name.includes('manifest.json'));
		expect(manifestFile).toBeDefined();
		expect(manifestFile!.matches).toBe(false);
		expect(manifestFile!.declaredHash).not.toBe(manifestFile!.actualHash);
		expect(verifyResult.issues.some((i) => i.includes('manifest.json'))).toBe(true);
	});

	// ── 6. Verification: tampered signature fails Ed25519 ───────────────
	it('should fail Ed25519 check when signature is tampered', async () => {
		await setupAuditDir(tempDir);

		const attestResult = await createAttestation(
			{ projectPath: tempDir, cosign: false, submit: false },
			mockKeyManager(testKeyPair)
		);
		expect(attestResult.success).toBe(true);

		const tamperedEnvelope: DSSEEnvelope = {
			...attestResult.envelope!,
			signatures: [
				{
					...attestResult.envelope!.signatures[0],
					sig: attestResult.envelope!.signatures[0].sig.slice(0, -4) + 'XXXX',
				},
			],
		};

		vi.mocked(getUserKeyInfo).mockResolvedValue({
			exists: true,
			publicKey: testKeyPair.publicKey,
			keyId: testKeyPair.keyId,
		});

		const verifyResult = await verifyAttestation(tempDir, tamperedEnvelope);

		expect(verifyResult.valid).toBe(false);
		expect(verifyResult.signatures[0].valid).toBe(false);
		expect(verifyResult.signatures[0].error).toContain('verification failed');
	});

	// ── 7. Trust tier: user-only = self-attested ────────────────────────
	it('should return self-attested trust tier for user-only signature', async () => {
		await setupAuditDir(tempDir);

		const result = await createAttestation(
			{ projectPath: tempDir, cosign: false, submit: false },
			mockKeyManager(testKeyPair)
		);

		expect(result.success).toBe(true);
		expect(result.trustTier).toBe('self-attested');
	});

	// ── 8. Trust tier: user + tool = tool-corroborated ──────────────────
	it('should return tool-corroborated trust tier when both signatures present', async () => {
		await setupAuditDir(tempDir);

		vi.mocked(requestCosignature).mockResolvedValue({
			keyid: 'toolkey123456789a',
			sig: 'mock-tool-sig',
			keytype: 'tool_provider',
		});

		const result = await createAttestation(
			{ projectPath: tempDir, cosign: true, submit: false },
			mockKeyManager(testKeyPair)
		);

		expect(result.success).toBe(true);
		expect(result.trustTier).toBe('tool-corroborated');
	});

	// ── 9. Trust tier: tool-only = tool-only ────────────────────────────
	it('should determine tool-only trust tier when only tool_provider signature is valid', async () => {
		await setupAuditDir(tempDir);

		// Build an envelope manually with only a tool_provider signature
		const toolKeyPair = generateKeyPair();
		const statement = await buildInTotoStatement(tempDir, 'PASS', '1.0.0');
		const payload = Buffer.from(JSON.stringify(statement)).toString('base64url');
		const paeBytes = computePAE('application/vnd.in-toto+json', payload);
		const toolSig = signPAE(paeBytes, toolKeyPair.privateKey);

		const envelope: DSSEEnvelope = {
			payloadType: 'application/vnd.in-toto+json',
			payload,
			signatures: [
				{
					keyid: toolKeyPair.keyId,
					sig: toolSig,
					keytype: 'tool_provider',
				},
			],
		};

		vi.mocked(findProviderKey).mockResolvedValue(toolKeyPair.publicKey);

		const verifyResult = await verifyAttestation(tempDir, envelope);

		expect(verifyResult.trustTier).toBe('tool-only');
		expect(verifyResult.valid).toBe(true);
		expect(verifyResult.signatures).toHaveLength(1);
		expect(verifyResult.signatures[0].keytype).toBe('tool_provider');
		expect(verifyResult.signatures[0].valid).toBe(true);
	});

	// ── 10. No key: returns helpful error message ───────────────────────
	it('should return helpful error when no signing key is available', async () => {
		await setupAuditDir(tempDir);

		const result = await createAttestation(
			{ projectPath: tempDir, cosign: false, submit: false },
			mockKeyManager(null)
		);

		expect(result.success).toBe(false);
		expect(result.trustTier).toBe('none');
		expect(result.error).toContain('keygen');
		expect(result.steps.userSign).toBe('fail');
	});

	// ── 11. Attestation ID is deterministic ─────────────────────────────
	it('should produce a deterministic attestation ID from the envelope', async () => {
		await setupAuditDir(tempDir);

		const result = await createAttestation(
			{ projectPath: tempDir, cosign: false, submit: false },
			mockKeyManager(testKeyPair)
		);
		expect(result.success).toBe(true);

		// Recompute the attestation ID from the returned envelope
		const recomputedId = computeAttestationId(result.envelope!);
		expect(result.attestationId).toBe(recomputedId);

		// Compute a third time to verify determinism
		const recomputedId2 = computeAttestationId(result.envelope!);
		expect(recomputedId).toBe(recomputedId2);
	});

	// ── 12. Envelope saved to .ai-audit/attestation.json ────────────────
	it('should save the DSSE envelope to .ai-audit/attestation.json', async () => {
		await setupAuditDir(tempDir);

		const result = await createAttestation(
			{ projectPath: tempDir, cosign: false, submit: false },
			mockKeyManager(testKeyPair)
		);
		expect(result.success).toBe(true);

		// Read the saved envelope from disk
		const savedContent = await readFile(
			path.join(tempDir, '.ai-audit', 'attestation.json'),
			'utf8'
		);
		const savedEnvelope = JSON.parse(savedContent) as DSSEEnvelope;

		expect(savedEnvelope.payloadType).toBe(result.envelope!.payloadType);
		expect(savedEnvelope.payload).toBe(result.envelope!.payload);
		expect(savedEnvelope.signatures).toEqual(result.envelope!.signatures);
	});
});
