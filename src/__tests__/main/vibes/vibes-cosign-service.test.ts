/**
 * Tests for src/main/vibes/vibes-cosign-service.ts
 * Validates tool provider cosigning: static-file key pulls, cosignature
 * requests, PAE hash computation, and provider signature verification.
 *
 * Provider keys use static-file distribution (see vibes-provider-keystore.ts):
 * the published file's content hash (keyId) IS the key version, and every key
 * ever pulled is retained locally so old attestations verify after rotation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import { rmSync } from 'fs';

// Provider keys persist under homedir now (static-file keystore); isolate it.
// vi.hoisted runs before module load, when the keystore bakes its dir constant.
const mocks = vi.hoisted(() => {
	const os = require('os') as typeof import('os');
	const fs = require('fs') as typeof import('fs');
	const pathMod = require('path') as typeof import('path');
	const tempHome = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'vibes-cosign-'));
	return { tempHome };
});

vi.mock('os', async (importOriginal) => {
	const actual = await importOriginal<typeof import('os')>();
	return {
		...actual,
		homedir: () => mocks.tempHome,
		default: { ...actual, homedir: () => mocks.tempHome },
	};
});

import {
	generateKeyPair,
	computePAE,
	signPAE,
	computeKeyId,
} from '../../../main/vibes/vibes-key-manager';

import {
	fetchProviderKeys,
	requestCosignature,
	verifyProviderSignature,
	computePAEHash,
	clearProviderKeyCache,
	findProviderKey,
} from '../../../main/vibes/vibes-cosign-service';

import type { CosignResponse } from '../../../main/vibes/vibes-cosign-service';

import { createHash } from 'crypto';

// ============================================================================
// Mock fetch globally
// ============================================================================

const mockFetch = vi.fn();

beforeEach(() => {
	// Wipe the persisted keystore between tests (shared temp home; the store
	// path is baked into the module at load time)
	rmSync(path.join(mocks.tempHome, '.vibescheck'), { recursive: true, force: true });
	vi.stubGlobal('fetch', mockFetch);
	clearProviderKeyCache();
	mockFetch.mockReset();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

/** Response shim for the static key FILE endpoint (text body + headers). */
function keyFileResponse(body: string, status = 200) {
	return {
		ok: status >= 200 && status < 300,
		status,
		headers: { get: () => null },
		text: async () => body,
	};
}

// ============================================================================
// computePAEHash
// ============================================================================

describe('computePAEHash', () => {
	it('should compute SHA-256 of PAE bytes as hex', () => {
		const paeBytes = computePAE('application/vnd.in-toto+json', 'test-payload');
		const hash = computePAEHash(paeBytes);

		const expected = createHash('sha256').update(paeBytes).digest('hex');
		expect(hash).toBe(expected);
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
	});

	it('should produce different hashes for different PAE bytes', () => {
		const pae1 = computePAE('application/vnd.in-toto+json', 'payload-1');
		const pae2 = computePAE('application/vnd.in-toto+json', 'payload-2');

		expect(computePAEHash(pae1)).not.toBe(computePAEHash(pae2));
	});

	it('should be deterministic', () => {
		const paeBytes = computePAE('application/vnd.in-toto+json', 'stable');
		const h1 = computePAEHash(paeBytes);
		const h2 = computePAEHash(paeBytes);
		expect(h1).toBe(h2);
	});
});

// ============================================================================
// fetchProviderKeys (static-file backed)
// ============================================================================

describe('fetchProviderKeys', () => {
	it('pulls the static key file and shapes it as a bundle (keyid = content hash)', async () => {
		const { publicKey } = generateKeyPair();
		mockFetch.mockResolvedValueOnce(keyFileResponse(publicKey));

		const bundle = await fetchProviderKeys();

		expect(bundle?.provider).toBe('Maestro');
		expect(bundle?.keys).toHaveLength(1);
		expect(bundle?.keys[0].keyid).toBe(computeKeyId(publicKey));
		expect(bundle?.keys[0].status).toBe('active');
	});

	it('serves the persisted store without refetching within the throttle window', async () => {
		const { publicKey } = generateKeyPair();
		mockFetch.mockResolvedValue(keyFileResponse(publicKey));

		await fetchProviderKeys();
		const again = await fetchProviderKeys();

		expect(again?.keys).toHaveLength(1);
		// key file + endorsement file for the new key; throttled re-check adds none
		expect(mockFetch).toHaveBeenCalledTimes(2);
	});

	it('returns null when the network is unavailable and nothing is stored', async () => {
		mockFetch.mockRejectedValueOnce(new Error('offline'));
		expect(await fetchProviderKeys()).toBeNull();
	});

	it('keeps serving stored keys after a later HTTP error', async () => {
		const { publicKey } = generateKeyPair();
		mockFetch.mockResolvedValueOnce(keyFileResponse(publicKey));
		await fetchProviderKeys();

		mockFetch.mockResolvedValueOnce(keyFileResponse('', 500));
		const after = await fetchProviderKeys();
		expect(after?.keys).toHaveLength(1);
	});

	it('returns null for unparseable key file content', async () => {
		mockFetch.mockResolvedValueOnce(keyFileResponse('this is not a key'));
		expect(await fetchProviderKeys()).toBeNull();
	});

	it('accepts the legacy JSON bundle shape as a fallback', async () => {
		const { publicKey } = generateKeyPair();
		mockFetch.mockResolvedValueOnce(
			keyFileResponse(JSON.stringify({ keys: [{ public_key_pem: publicKey }] }))
		);

		const bundle = await fetchProviderKeys();
		expect(bundle?.keys[0].keyid).toBe(computeKeyId(publicKey));
	});
});

// ============================================================================
// requestCosignature
// ============================================================================

describe('requestCosignature', () => {
	it('should send PAE hash and return cosign response', async () => {
		const mockResponse: CosignResponse = {
			keyid: 'deadbeef12345678',
			sig: 'base64url-signature-data',
			keytype: 'tool_provider',
		};

		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: async () => mockResponse,
		});

		const result = await requestCosignature('abcdef1234567890');

		expect(result).toEqual(mockResponse);
		expect(result!.keytype).toBe('tool_provider');
		expect(mockFetch).toHaveBeenCalledTimes(1);

		// Verify the request body
		const call = mockFetch.mock.calls[0];
		const body = JSON.parse(call[1].body);
		expect(body.pae_hash).toBe('abcdef1234567890');
	});

	it('should include optional fields when provided', async () => {
		const mockResponse: CosignResponse = {
			keyid: 'deadbeef12345678',
			sig: 'sig-data',
			keytype: 'tool_provider',
		};

		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: async () => mockResponse,
		});

		await requestCosignature('hash123', {
			toolSessionId: 'session-abc',
			appVersion: '2.0.0',
		});

		const body = JSON.parse(mockFetch.mock.calls[0][1].body);
		expect(body.tool_session_id).toBe('session-abc');
		expect(body.app_version).toBe('2.0.0');
	});

	it('should return null on HTTP error', async () => {
		mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });

		const result = await requestCosignature('hash');
		expect(result).toBeNull();
	});

	it('should return null on network failure', async () => {
		mockFetch.mockRejectedValueOnce(new Error('Connection refused'));

		const result = await requestCosignature('hash');
		expect(result).toBeNull();
	});

	it('should return null if response is missing required fields', async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: async () => ({ keyid: 'abc' }), // missing sig
		});

		const result = await requestCosignature('hash');
		expect(result).toBeNull();
	});

	it('should ensure keytype is set to tool_provider', async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				keyid: 'abc123',
				sig: 'sig-data',
				// keytype omitted by server
			}),
		});

		const result = await requestCosignature('hash');
		expect(result!.keytype).toBe('tool_provider');
	});
});

// ============================================================================
// findProviderKey (content-addressed lookup, historical retention)
// ============================================================================

describe('findProviderKey', () => {
	it('finds a key by its content-hash keyid', async () => {
		const { publicKey } = generateKeyPair();
		mockFetch.mockResolvedValueOnce(keyFileResponse(publicKey));

		const pem = await findProviderKey(computeKeyId(publicKey));
		expect(pem?.trim()).toBe(publicKey.trim());
	});

	it('returns null for an unknown keyid', async () => {
		const { publicKey } = generateKeyPair();
		mockFetch.mockResolvedValue(keyFileResponse(publicKey));

		expect(await findProviderKey('0000000000000000')).toBeNull();
	});

	it('still resolves a ROTATED-OUT key (historical keys verify old attestations)', async () => {
		const oldKey = generateKeyPair().publicKey;
		const newKey = generateKeyPair().publicKey;

		mockFetch.mockResolvedValueOnce(keyFileResponse(oldKey));
		await fetchProviderKeys();

		// Provider rotates: the published file now serves only the new key
		mockFetch.mockResolvedValue(keyFileResponse(newKey));
		const pem = await findProviderKey(computeKeyId(oldKey));

		expect(pem?.trim()).toBe(oldKey.trim());
	});

	it('returns null when keys cannot be fetched', async () => {
		mockFetch.mockRejectedValue(new Error('offline'));
		expect(await findProviderKey('abcdef0123456789')).toBeNull();
	});
});

// ============================================================================
// verifyProviderSignature
// ============================================================================

describe('verifyProviderSignature', () => {
	it('should verify a valid provider signature', async () => {
		const providerKeyPair = generateKeyPair();
		const paeBytes = computePAE('application/vnd.in-toto+json', 'test-statement');
		const sig = signPAE(paeBytes, providerKeyPair.privateKey);

		mockFetch.mockResolvedValueOnce(keyFileResponse(providerKeyPair.publicKey));

		const valid = await verifyProviderSignature(paeBytes, sig, providerKeyPair.keyId);
		expect(valid).toBe(true);
	});

	it('should reject a signature with tampered data', async () => {
		const providerKeyPair = generateKeyPair();
		const paeBytes = computePAE('application/vnd.in-toto+json', 'original');
		const sig = signPAE(paeBytes, providerKeyPair.privateKey);

		mockFetch.mockResolvedValueOnce(keyFileResponse(providerKeyPair.publicKey));

		const tamperedPae = computePAE('application/vnd.in-toto+json', 'tampered');
		const valid = await verifyProviderSignature(tamperedPae, sig, providerKeyPair.keyId);
		expect(valid).toBe(false);
	});

	it('should reject a signature from an unknown keyid', async () => {
		const providerKeyPair = generateKeyPair();
		const paeBytes = computePAE('application/vnd.in-toto+json', 'data');
		const sig = signPAE(paeBytes, providerKeyPair.privateKey);

		mockFetch.mockResolvedValue(keyFileResponse(providerKeyPair.publicKey));

		const valid = await verifyProviderSignature(paeBytes, sig, '0000000000000000');
		expect(valid).toBe(false);
	});

	it('should reject when provider keys are unavailable', async () => {
		const providerKeyPair = generateKeyPair();
		const paeBytes = computePAE('application/vnd.in-toto+json', 'data');
		const sig = signPAE(paeBytes, providerKeyPair.privateKey);

		mockFetch.mockRejectedValue(new Error('offline'));

		const valid = await verifyProviderSignature(paeBytes, sig, providerKeyPair.keyId);
		expect(valid).toBe(false);
	});
});
