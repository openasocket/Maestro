/**
 * Integration tests for the VERIFY attestation pipeline.
 *
 * These tests exercise cross-module flows end-to-end:
 *  1. Full round-trip: keygen → attest → save to disk → load from disk → verify
 *  2. Stale detection: attest → modify file → verify → stale indicator
 *  3. Permission check: key with wrong permissions → coordinator warning via IPC
 *
 * Unlike the unit tests in vibes-attestation.test.ts, these tests:
 *  - Load envelopes from disk (verifyAttestation without passing envelope)
 *  - Verify cross-module data flow integrity
 *  - Test the coordinator permission check flow with real file operations
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile, chmod, stat } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// ============================================================================
// Module-level mocks
// ============================================================================

vi.mock('../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		debug: vi.fn(),
		error: vi.fn(),
	},
}));

vi.mock('../../main/vibes/vibes-cosign-service', async (importOriginal) => {
	const mod = await importOriginal<typeof import('../../main/vibes/vibes-cosign-service')>();
	return {
		...mod,
		requestCosignature: vi.fn().mockResolvedValue(null),
		findProviderKey: vi.fn().mockResolvedValue(null),
	};
});

vi.mock('../../main/vibes/vibes-key-manager', async (importOriginal) => {
	const mod = await importOriginal<typeof import('../../main/vibes/vibes-key-manager')>();
	return {
		...mod,
		getUserKeyInfo: vi.fn().mockResolvedValue({ exists: false, publicKey: '', keyId: '' }),
		checkKeyPermissions: vi.fn().mockResolvedValue({ valid: true }),
	};
});

// ============================================================================
// Imports
// ============================================================================

import {
	generateKeyPair,
	computeAttestationId,
	getUserKeyInfo,
	checkKeyPermissions,
	type VibesKeyPair,
} from '../../main/vibes/vibes-key-manager';

import { createAttestation } from '../../main/vibes/vibes-attestation';
import { verifyAttestation } from '../../main/vibes/vibes-verify-attestation';
import { requestCosignature } from '../../main/vibes/vibes-cosign-service';

import { VibesCoordinator } from '../../main/vibes/vibes-coordinator';
import type { VibesSettingsStore, SafeSendFn } from '../../main/vibes/vibes-coordinator';

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
		project_name: 'integration-test-project',
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
		JSON.stringify({ type: 'line', model_name: 'claude-4', content: 'original-line-1' }),
		JSON.stringify({ type: 'session', model_name: 'gpt-5', content: 'original-session-1' }),
		JSON.stringify({ type: 'line', model_name: 'claude-4', content: 'original-line-2' }),
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

/** Create a mock settings store for coordinator tests. */
function createMockSettingsStore(overrides: Record<string, unknown> = {}): VibesSettingsStore {
	const settings: Record<string, unknown> = {
		vibesEnabled: true,
		vibesAssuranceLevel: 'medium',
		vibesPerAgentConfig: {
			'claude-code': { enabled: true },
			codex: { enabled: true },
		},
		vibesMaestroOrchestrationEnabled: true,
		...overrides,
	};

	return {
		get<T>(key: string, defaultValue?: T): T {
			const value = settings[key];
			return (value !== undefined ? value : defaultValue) as T;
		},
	};
}

// ============================================================================
// Tests
// ============================================================================

describe('VIBES attestation integration', () => {
	let tempDir: string;
	let testKeyPair: VibesKeyPair;

	beforeEach(async () => {
		tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibes-integration-test-'));
		testKeyPair = generateKeyPair();
		vi.mocked(requestCosignature).mockReset().mockResolvedValue(null);
		vi.mocked(getUserKeyInfo).mockReset().mockResolvedValue({
			exists: false,
			publicKey: '',
			keyId: '',
		});
		vi.mocked(checkKeyPermissions).mockReset().mockResolvedValue({ valid: true });
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	// ── 1. Full attestation flow: keygen → attest → verify round-trip ────
	describe('full attestation round-trip', () => {
		it('should complete keygen → attest → disk save → disk load → verify cycle', async () => {
			// Step 1: Generate keys (real Ed25519 crypto)
			const keyPair = generateKeyPair();
			expect(keyPair.keyId).toMatch(/^[0-9a-f]{16}$/);
			expect(keyPair.publicKey).toContain('-----BEGIN PUBLIC KEY-----');
			expect(keyPair.privateKey).toContain('-----BEGIN PRIVATE KEY-----');

			// Step 2: Set up audit directory
			await setupAuditDir(tempDir);

			// Step 3: Create attestation (real crypto signing)
			const attestResult = await createAttestation(
				{ projectPath: tempDir, cosign: false, submit: false },
				mockKeyManager(keyPair)
			);

			expect(attestResult.success).toBe(true);
			expect(attestResult.envelope).toBeDefined();
			expect(attestResult.attestationId).toMatch(/^[0-9a-f]{64}$/);
			expect(attestResult.trustTier).toBe('self-attested');
			expect(attestResult.steps.audit).toBe('pass');
			expect(attestResult.steps.hash).toBe('pass');
			expect(attestResult.steps.userSign).toBe('pass');

			// Step 4: Verify envelope was saved to disk
			const envelopePath = path.join(tempDir, '.ai-audit', 'attestation.json');
			const savedContent = await readFile(envelopePath, 'utf8');
			const savedEnvelope = JSON.parse(savedContent);
			expect(savedEnvelope.payloadType).toBe('application/vnd.in-toto+json');
			expect(savedEnvelope.signatures).toBeDefined();

			// Step 5: Verify by loading from disk (NOT passing envelope)
			vi.mocked(getUserKeyInfo).mockResolvedValue({
				exists: true,
				publicKey: keyPair.publicKey,
				keyId: keyPair.keyId,
			});

			const verifyResult = await verifyAttestation(tempDir);

			// Step 6: Assert full verification passes
			expect(verifyResult.valid).toBe(true);
			expect(verifyResult.trustTier).toBe('self-attested');
			expect(verifyResult.issues).toHaveLength(0);

			// Signatures verified
			expect(verifyResult.signatures).toHaveLength(1);
			expect(verifyResult.signatures[0].keyid).toBe(keyPair.keyId);
			expect(verifyResult.signatures[0].keytype).toBe('user');
			expect(verifyResult.signatures[0].valid).toBe(true);

			// File integrity verified
			expect(verifyResult.fileIntegrity.length).toBe(3);
			expect(verifyResult.fileIntegrity.every((f) => f.matches)).toBe(true);
			const fileNames = verifyResult.fileIntegrity.map((f) => f.name);
			expect(fileNames).toContain('.ai-audit/manifest.json');
			expect(fileNames).toContain('.ai-audit/annotations.jsonl');
			expect(fileNames).toContain('.ai-audit/config.json');

			// Attestation ID is consistent between create and verify
			expect(verifyResult.attestationId).toBe(attestResult.attestationId);

			// Attestation ID matches recomputation from saved envelope
			const recomputedId = computeAttestationId(savedEnvelope);
			expect(verifyResult.attestationId).toBe(recomputedId);
		});

		it('should verify cosigned attestation with tool-corroborated trust tier from disk', async () => {
			const keyPair = generateKeyPair();
			await setupAuditDir(tempDir);

			// Cosign with a mock tool provider
			vi.mocked(requestCosignature).mockResolvedValue({
				keyid: 'toolprovider12345',
				sig: 'mock-tool-sig-base64url',
				keytype: 'tool_provider',
			});

			const attestResult = await createAttestation(
				{ projectPath: tempDir, cosign: true, submit: false },
				mockKeyManager(keyPair)
			);

			expect(attestResult.success).toBe(true);
			expect(attestResult.trustTier).toBe('tool-corroborated');
			expect(attestResult.envelope!.signatures).toHaveLength(2);

			// Verify from disk — user signature valid, tool signature fails
			// (tool provider key is not found via findProviderKey mock)
			vi.mocked(getUserKeyInfo).mockResolvedValue({
				exists: true,
				publicKey: keyPair.publicKey,
				keyId: keyPair.keyId,
			});

			const verifyResult = await verifyAttestation(tempDir);

			// User signature valid
			const userSig = verifyResult.signatures.find((s) => s.keytype === 'user');
			expect(userSig).toBeDefined();
			expect(userSig!.valid).toBe(true);

			// Tool provider signature unverifiable without provider key
			const toolSig = verifyResult.signatures.find((s) => s.keytype === 'tool_provider');
			expect(toolSig).toBeDefined();
			expect(toolSig!.valid).toBe(false);
			expect(toolSig!.error).toContain('not found');

			// Overall: self-attested tier (only user sig verified)
			expect(verifyResult.trustTier).toBe('self-attested');
		});
	});

	// ── 2. Stale detection: modify file after attestation → stale ────────
	describe('stale detection after file modification', () => {
		it('should detect stale attestation when annotations.jsonl is modified', async () => {
			const keyPair = generateKeyPair();
			const auditDir = await setupAuditDir(tempDir);

			// Create attestation
			const attestResult = await createAttestation(
				{ projectPath: tempDir, cosign: false, submit: false },
				mockKeyManager(keyPair)
			);
			expect(attestResult.success).toBe(true);

			// Modify annotations.jsonl after attestation
			const newAnnotations = [
				JSON.stringify({ type: 'line', model_name: 'claude-4', content: 'TAMPERED-line' }),
				JSON.stringify({ type: 'session', model_name: 'gpt-5', content: 'TAMPERED-session' }),
			].join('\n');
			await writeFile(path.join(auditDir, 'annotations.jsonl'), newAnnotations);

			// Verify from disk
			vi.mocked(getUserKeyInfo).mockResolvedValue({
				exists: true,
				publicKey: keyPair.publicKey,
				keyId: keyPair.keyId,
			});

			const verifyResult = await verifyAttestation(tempDir);

			// Overall validation should fail
			expect(verifyResult.valid).toBe(false);

			// Signature is still cryptographically valid (envelope not tampered)
			expect(verifyResult.signatures[0].valid).toBe(true);

			// File integrity: annotations.jsonl should be flagged
			const annotationsFile = verifyResult.fileIntegrity.find((f) =>
				f.name.includes('annotations.jsonl')
			);
			expect(annotationsFile).toBeDefined();
			expect(annotationsFile!.matches).toBe(false);
			expect(annotationsFile!.declaredHash).not.toBe(annotationsFile!.actualHash);
			expect(annotationsFile!.actualHash).toMatch(/^[0-9a-f]{64}$/);

			// Other files should still match
			const otherFiles = verifyResult.fileIntegrity.filter(
				(f) => !f.name.includes('annotations.jsonl')
			);
			expect(otherFiles.every((f) => f.matches)).toBe(true);

			// Issues should mention annotations.jsonl
			expect(verifyResult.issues.some((i) => i.includes('annotations.jsonl'))).toBe(true);
		});

		it('should detect stale attestation when config.json is modified', async () => {
			const keyPair = generateKeyPair();
			const auditDir = await setupAuditDir(tempDir);

			const attestResult = await createAttestation(
				{ projectPath: tempDir, cosign: false, submit: false },
				mockKeyManager(keyPair)
			);
			expect(attestResult.success).toBe(true);

			// Modify config.json
			const newConfig = {
				standard: 'VIBES',
				standard_version: '2.0',
				assurance_level: 'low',
				project_name: 'tampered-project',
			};
			await writeFile(path.join(auditDir, 'config.json'), JSON.stringify(newConfig));

			vi.mocked(getUserKeyInfo).mockResolvedValue({
				exists: true,
				publicKey: keyPair.publicKey,
				keyId: keyPair.keyId,
			});

			const verifyResult = await verifyAttestation(tempDir);

			expect(verifyResult.valid).toBe(false);

			const configFile = verifyResult.fileIntegrity.find((f) => f.name.includes('config.json'));
			expect(configFile).toBeDefined();
			expect(configFile!.matches).toBe(false);

			// Manifest and annotations should still match
			const manifestFile = verifyResult.fileIntegrity.find((f) => f.name.includes('manifest.json'));
			expect(manifestFile).toBeDefined();
			expect(manifestFile!.matches).toBe(true);
		});

		it('should detect multiple stale files when both manifest and annotations are modified', async () => {
			const keyPair = generateKeyPair();
			const auditDir = await setupAuditDir(tempDir);

			const attestResult = await createAttestation(
				{ projectPath: tempDir, cosign: false, submit: false },
				mockKeyManager(keyPair)
			);
			expect(attestResult.success).toBe(true);

			// Modify both manifest.json and annotations.jsonl
			await writeFile(
				path.join(auditDir, 'manifest.json'),
				JSON.stringify({ entries: {}, modified: true })
			);
			await writeFile(
				path.join(auditDir, 'annotations.jsonl'),
				JSON.stringify({ type: 'tampered' })
			);

			vi.mocked(getUserKeyInfo).mockResolvedValue({
				exists: true,
				publicKey: keyPair.publicKey,
				keyId: keyPair.keyId,
			});

			const verifyResult = await verifyAttestation(tempDir);

			expect(verifyResult.valid).toBe(false);

			const staleFiles = verifyResult.fileIntegrity.filter((f) => !f.matches);
			expect(staleFiles.length).toBe(2);

			const staleNames = staleFiles.map((f) => f.name);
			expect(staleNames.some((n) => n.includes('manifest.json'))).toBe(true);
			expect(staleNames.some((n) => n.includes('annotations.jsonl'))).toBe(true);
		});
	});

	// ── 3. Permission check: wrong permissions → warning ─────────────────
	describe('key permission check triggers warning', () => {
		it('should detect incorrect permissions on a key file and report via coordinator', async () => {
			// Step 1: Create real key files with wrong permissions in temp dir
			const keysDir = path.join(tempDir, '.vibescheck', 'keys');
			await mkdir(keysDir, { recursive: true });

			const keyPair = generateKeyPair();
			const privatePath = path.join(keysDir, 'vibescheck.key');
			const publicPath = path.join(keysDir, 'vibescheck.pub');

			await writeFile(privatePath, keyPair.privateKey, 'utf8');
			await chmod(privatePath, 0o644); // Wrong — should be 0600
			await writeFile(publicPath, keyPair.publicKey, 'utf8');
			await chmod(publicPath, 0o644);

			// Verify the file actually has wrong permissions
			const stats = await stat(privatePath);
			expect(stats.mode & 0o777).toBe(0o644);

			// Step 2: Configure coordinator to detect the problem
			vi.mocked(getUserKeyInfo).mockResolvedValue({
				exists: true,
				publicKey: keyPair.publicKey,
				keyId: keyPair.keyId,
			});
			vi.mocked(checkKeyPermissions).mockResolvedValue({
				valid: false,
				message: `Private key permissions are 644, expected 600. Run: chmod 600 ${privatePath}`,
			});

			// Step 3: Coordinator should send IPC warning
			const safeSend = vi.fn() as unknown as SafeSendFn;
			const store = createMockSettingsStore();
			const coordinator = new VibesCoordinator({ settingsStore: store, safeSend });

			await coordinator.checkKeyPermissionsOnStartup();

			expect(safeSend).toHaveBeenCalledTimes(1);
			expect(safeSend).toHaveBeenCalledWith('vibes:keyPermissionsWarning', {
				message: expect.stringContaining('644'),
			});
			expect(safeSend).toHaveBeenCalledWith('vibes:keyPermissionsWarning', {
				message: expect.stringContaining('chmod 600'),
			});
		});

		it('should not warn when key file has correct 0600 permissions', async () => {
			// Create key files with correct permissions
			const keysDir = path.join(tempDir, '.vibescheck', 'keys');
			await mkdir(keysDir, { recursive: true });

			const keyPair = generateKeyPair();
			const privatePath = path.join(keysDir, 'vibescheck.key');

			await writeFile(privatePath, keyPair.privateKey, 'utf8');
			await chmod(privatePath, 0o600); // Correct

			// Verify correct permissions
			const stats = await stat(privatePath);
			expect(stats.mode & 0o777).toBe(0o600);

			// Configure coordinator — key exists, permissions OK
			vi.mocked(getUserKeyInfo).mockResolvedValue({
				exists: true,
				publicKey: keyPair.publicKey,
				keyId: keyPair.keyId,
			});
			vi.mocked(checkKeyPermissions).mockResolvedValue({ valid: true });

			const safeSend = vi.fn() as unknown as SafeSendFn;
			const store = createMockSettingsStore();
			const coordinator = new VibesCoordinator({ settingsStore: store, safeSend });

			await coordinator.checkKeyPermissionsOnStartup();

			expect(safeSend).not.toHaveBeenCalled();
		});

		it('should only send permission warning once even with multiple startup checks', async () => {
			vi.mocked(getUserKeyInfo).mockResolvedValue({
				exists: true,
				publicKey: 'mock-pub-key',
				keyId: 'a1b2c3d4e5f6a7b8',
			});
			vi.mocked(checkKeyPermissions).mockResolvedValue({
				valid: false,
				message: 'Private key permissions are 755, expected 600',
			});

			const safeSend = vi.fn() as unknown as SafeSendFn;
			const store = createMockSettingsStore();
			const coordinator = new VibesCoordinator({ settingsStore: store, safeSend });

			// Simulate multiple startup check attempts
			await coordinator.checkKeyPermissionsOnStartup();
			await coordinator.checkKeyPermissionsOnStartup();
			await coordinator.checkKeyPermissionsOnStartup();

			// Warning sent exactly once (one-time flag)
			expect(safeSend).toHaveBeenCalledTimes(1);
			expect(safeSend).toHaveBeenCalledWith('vibes:keyPermissionsWarning', {
				message: expect.stringContaining('755'),
			});
		});
	});
});
