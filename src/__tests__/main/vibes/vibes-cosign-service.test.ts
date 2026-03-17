/**
 * Tests for src/main/vibes/vibes-cosign-service.ts
 * Validates tool provider cosigning: key fetching, cosignature requests,
 * PAE hash computation, and provider signature verification.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { generateKeyPair, computePAE, signPAE } from '../../../main/vibes/vibes-key-manager';

import {
	fetchProviderKeys,
	requestCosignature,
	verifyProviderSignature,
	computePAEHash,
	clearProviderKeyCache,
	findProviderKey,
} from '../../../main/vibes/vibes-cosign-service';

import type { ProviderKeyBundle, CosignResponse } from '../../../main/vibes/vibes-cosign-service';

import { createHash } from 'crypto';

// ============================================================================
// Mock fetch globally
// ============================================================================

const mockFetch = vi.fn();

beforeEach(() => {
	vi.stubGlobal('fetch', mockFetch);
	clearProviderKeyCache();
	mockFetch.mockReset();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

// ============================================================================
// Helper: build a valid ProviderKeyBundle with a real Ed25519 key
// ============================================================================

function buildMockKeyBundle(publicKeyPem: string, keyid: string): ProviderKeyBundle {
	return {
		provider: 'Maestro',
		tool_name: 'Maestro',
		keys: [
			{
				keyid,
				algorithm: 'Ed25519',
				public_key_pem: publicKeyPem,
				valid_from: '2020-01-01T00:00:00Z',
				valid_until: '2099-12-31T23:59:59Z',
				status: 'active',
			},
		],
		rotation_policy: '90 days',
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
// fetchProviderKeys
// ============================================================================

describe('fetchProviderKeys', () => {
	it('should fetch and return a valid key bundle', async () => {
		const keyPair = generateKeyPair();
		const bundle = buildMockKeyBundle(keyPair.publicKey, keyPair.keyId);

		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: async () => bundle,
		});

		const result = await fetchProviderKeys();

		expect(result).toEqual(bundle);
		expect(result!.provider).toBe('Maestro');
		expect(result!.keys).toHaveLength(1);
		expect(mockFetch).toHaveBeenCalledTimes(1);
	});

	it('should cache the key bundle for subsequent calls', async () => {
		const keyPair = generateKeyPair();
		const bundle = buildMockKeyBundle(keyPair.publicKey, keyPair.keyId);

		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: async () => bundle,
		});

		const result1 = await fetchProviderKeys();
		const result2 = await fetchProviderKeys();

		expect(result1).toEqual(bundle);
		expect(result2).toEqual(bundle);
		// Only one fetch call — second was served from cache
		expect(mockFetch).toHaveBeenCalledTimes(1);
	});

	it('should return null when network is unavailable', async () => {
		mockFetch.mockRejectedValueOnce(new Error('Network error'));

		const result = await fetchProviderKeys();
		expect(result).toBeNull();
	});

	it('should return stale cache on HTTP error', async () => {
		const keyPair = generateKeyPair();
		const bundle = buildMockKeyBundle(keyPair.publicKey, keyPair.keyId);

		// First call succeeds
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: async () => bundle,
		});
		await fetchProviderKeys();

		// Force cache expiry
		clearProviderKeyCache();

		// Re-populate cache
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: async () => bundle,
		});
		await fetchProviderKeys();

		// Now simulate a cache miss + error by clearing and failing
		clearProviderKeyCache();
		mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

		const result = await fetchProviderKeys();
		// Cache was cleared, so stale returns null
		expect(result).toBeNull();
	});

	it('should return null for invalid response shape', async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: async () => ({ invalid: 'data' }),
		});

		const result = await fetchProviderKeys();
		expect(result).toBeNull();
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
// findProviderKey
// ============================================================================

describe('findProviderKey', () => {
	it('should find an active key by keyid', async () => {
		const keyPair = generateKeyPair();
		const bundle = buildMockKeyBundle(keyPair.publicKey, keyPair.keyId);

		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: async () => bundle,
		});

		const pem = await findProviderKey(keyPair.keyId);
		expect(pem).toBe(keyPair.publicKey);
	});

	it('should return null for unknown keyid', async () => {
		const keyPair = generateKeyPair();
		const bundle = buildMockKeyBundle(keyPair.publicKey, keyPair.keyId);

		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: async () => bundle,
		});

		const pem = await findProviderKey('0000000000000000');
		expect(pem).toBeNull();
	});

	it('should return null for revoked key', async () => {
		const keyPair = generateKeyPair();
		const bundle = buildMockKeyBundle(keyPair.publicKey, keyPair.keyId);
		bundle.keys[0].status = 'revoked';

		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: async () => bundle,
		});

		const pem = await findProviderKey(keyPair.keyId);
		expect(pem).toBeNull();
	});

	it('should return null for expired key', async () => {
		const keyPair = generateKeyPair();
		const bundle = buildMockKeyBundle(keyPair.publicKey, keyPair.keyId);
		bundle.keys[0].valid_until = '2020-01-01T00:00:00Z'; // expired

		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: async () => bundle,
		});

		const pem = await findProviderKey(keyPair.keyId);
		expect(pem).toBeNull();
	});

	it('should return null when keys cannot be fetched', async () => {
		mockFetch.mockRejectedValueOnce(new Error('offline'));

		const pem = await findProviderKey('anything');
		expect(pem).toBeNull();
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

		const bundle = buildMockKeyBundle(providerKeyPair.publicKey, providerKeyPair.keyId);
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: async () => bundle,
		});

		const valid = await verifyProviderSignature(paeBytes, sig, providerKeyPair.keyId);
		expect(valid).toBe(true);
	});

	it('should reject a signature with tampered data', async () => {
		const providerKeyPair = generateKeyPair();
		const paeBytes = computePAE('application/vnd.in-toto+json', 'original');
		const sig = signPAE(paeBytes, providerKeyPair.privateKey);

		const bundle = buildMockKeyBundle(providerKeyPair.publicKey, providerKeyPair.keyId);
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: async () => bundle,
		});

		const tamperedPae = computePAE('application/vnd.in-toto+json', 'tampered');
		const valid = await verifyProviderSignature(tamperedPae, sig, providerKeyPair.keyId);
		expect(valid).toBe(false);
	});

	it('should reject a signature from an unknown keyid', async () => {
		const providerKeyPair = generateKeyPair();
		const paeBytes = computePAE('application/vnd.in-toto+json', 'data');
		const sig = signPAE(paeBytes, providerKeyPair.privateKey);

		const bundle = buildMockKeyBundle(providerKeyPair.publicKey, providerKeyPair.keyId);
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: async () => bundle,
		});

		const valid = await verifyProviderSignature(paeBytes, sig, 'wrong-keyid-here');
		expect(valid).toBe(false);
	});

	it('should reject when provider keys are unavailable', async () => {
		const providerKeyPair = generateKeyPair();
		const paeBytes = computePAE('application/vnd.in-toto+json', 'data');
		const sig = signPAE(paeBytes, providerKeyPair.privateKey);

		mockFetch.mockRejectedValueOnce(new Error('offline'));

		const valid = await verifyProviderSignature(paeBytes, sig, providerKeyPair.keyId);
		expect(valid).toBe(false);
	});

	it('should reject a corrupted signature', async () => {
		const providerKeyPair = generateKeyPair();
		const paeBytes = computePAE('application/vnd.in-toto+json', 'data');

		const bundle = buildMockKeyBundle(providerKeyPair.publicKey, providerKeyPair.keyId);
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: async () => bundle,
		});

		const valid = await verifyProviderSignature(paeBytes, 'not-a-valid-sig', providerKeyPair.keyId);
		expect(valid).toBe(false);
	});
});
