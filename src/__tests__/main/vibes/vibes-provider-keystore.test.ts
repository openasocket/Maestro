/**
 * Tests for src/main/vibes/vibes-provider-keystore.ts
 *
 * Static-file provider key distribution: the published file IS the protocol.
 * Covers PEM/JSON parsing, content-hash (keyId) versioning, ETag/Last-Modified
 * conditional GETs, rotation retention, throttling, and offline fallback.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import { rmSync } from 'fs';

// The keystore computes its directory constants at module load, so the mocked
// homedir must exist BEFORE any import — vi.hoisted runs ahead of the mocks.
const mocks = vi.hoisted(() => {
	const os = require('os') as typeof import('os');
	const fs = require('fs') as typeof import('fs');
	const pathMod = require('path') as typeof import('path');
	const tempHome = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'vibes-keystore-'));
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

import { generateKeyPair, computeKeyId } from '../../../main/vibes/vibes-key-manager';
import {
	parsePublishedKeyFile,
	checkProviderKeyUpdate,
	getProviderKeyById,
	getCurrentProviderKey,
	loadProviderKeyStore,
} from '../../../main/vibes/vibes-provider-keystore';

const mockFetch = vi.fn();

beforeEach(() => {
	// Per-test isolation: wipe the persisted store (one shared temp home,
	// because the store path is baked in at module load)
	rmSync(path.join(mocks.tempHome, '.vibescheck'), { recursive: true, force: true });
	vi.stubGlobal('fetch', mockFetch);
	mockFetch.mockReset();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

function pemResponse(
	body: string,
	init?: { status?: number; etag?: string; lastModified?: string }
) {
	const headers = new Map<string, string>();
	if (init?.etag) headers.set('etag', init.etag);
	if (init?.lastModified) headers.set('last-modified', init.lastModified);
	return {
		ok: (init?.status ?? 200) >= 200 && (init?.status ?? 200) < 300,
		status: init?.status ?? 200,
		headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
		text: async () => body,
	};
}

describe('parsePublishedKeyFile', () => {
	it('parses a bare SPKI PEM (the primary static-file format)', () => {
		const { publicKey } = generateKeyPair();
		const pems = parsePublishedKeyFile(publicKey);
		expect(pems).toHaveLength(1);
		expect(pems[0]).toContain('BEGIN PUBLIC KEY');
	});

	it('parses multiple concatenated PEM blocks (rotation overlap window)', () => {
		const a = generateKeyPair().publicKey;
		const b = generateKeyPair().publicKey;
		const pems = parsePublishedKeyFile(`${a}\n${b}`);
		expect(pems).toHaveLength(2);
	});

	it('falls back to the legacy JSON bundle shape', () => {
		const { publicKey } = generateKeyPair();
		const json = JSON.stringify({ keys: [{ public_key_pem: publicKey }] });
		const pems = parsePublishedKeyFile(json);
		expect(pems).toHaveLength(1);
	});

	it('returns empty for garbage content', () => {
		expect(parsePublishedKeyFile('not a key at all')).toEqual([]);
		expect(parsePublishedKeyFile('{"nope": true}')).toEqual([]);
	});
});

describe('checkProviderKeyUpdate', () => {
	it('pulls down the key on first check; keyId (content hash) is the version', async () => {
		const { publicKey } = generateKeyPair();
		const expectedKeyId = computeKeyId(publicKey);
		mockFetch.mockResolvedValueOnce(pemResponse(publicKey, { etag: '"v1"' }));

		const result = await checkProviderKeyUpdate({ force: true });

		expect(result.checked).toBe(true);
		expect(result.updated).toBe(true);
		expect(result.currentKeyId).toBe(expectedKeyId);
		expect(result.previousKeyId).toBeNull();

		const store = await loadProviderKeyStore();
		expect(store.current_keyid).toBe(expectedKeyId);
		expect(store.keys).toHaveLength(1);
		expect(store.etag).toBe('"v1"');
	});

	it('sends If-None-Match / If-Modified-Since and treats 304 as no new key', async () => {
		const { publicKey } = generateKeyPair();
		mockFetch.mockResolvedValueOnce(
			pemResponse(publicKey, { etag: '"v1"', lastModified: 'Mon, 01 Jan 2026 00:00:00 GMT' })
		);
		await checkProviderKeyUpdate({ force: true });

		mockFetch.mockResolvedValueOnce(pemResponse('', { status: 304 }));
		const second = await checkProviderKeyUpdate({ force: true });

		expect(second.checked).toBe(true);
		expect(second.updated).toBe(false);

		const secondCallHeaders = mockFetch.mock.calls[1][1].headers as Record<string, string>;
		expect(secondCallHeaders['If-None-Match']).toBe('"v1"');
		expect(secondCallHeaders['If-Modified-Since']).toBe('Mon, 01 Jan 2026 00:00:00 GMT');
	});

	it('detects a rotated key as a new version and RETAINS the old key', async () => {
		const oldKey = generateKeyPair().publicKey;
		const newKey = generateKeyPair().publicKey;

		mockFetch.mockResolvedValueOnce(pemResponse(oldKey));
		const first = await checkProviderKeyUpdate({ force: true });

		mockFetch.mockResolvedValueOnce(pemResponse(newKey));
		const second = await checkProviderKeyUpdate({ force: true });

		expect(second.updated).toBe(true);
		expect(second.currentKeyId).toBe(computeKeyId(newKey));
		expect(second.previousKeyId).toBe(first.currentKeyId);

		// Rotation appends — the old key must remain for verifying old attestations
		const store = await loadProviderKeyStore();
		expect(store.keys).toHaveLength(2);
		expect(store.keys.map((k) => k.keyid)).toContain(computeKeyId(oldKey));
		expect(store.current_keyid).toBe(computeKeyId(newKey));
	});

	it('re-fetching the SAME key is not reported as an update', async () => {
		const { publicKey } = generateKeyPair();
		mockFetch.mockResolvedValue(pemResponse(publicKey));

		await checkProviderKeyUpdate({ force: true });
		const again = await checkProviderKeyUpdate({ force: true });

		expect(again.updated).toBe(false);
		expect((await loadProviderKeyStore()).keys).toHaveLength(1);
	});

	it('throttles unforced checks within the check interval', async () => {
		const { publicKey } = generateKeyPair();
		mockFetch.mockResolvedValue(pemResponse(publicKey));

		await checkProviderKeyUpdate({ force: true });
		const throttled = await checkProviderKeyUpdate();

		expect(throttled.checked).toBe(false);
		expect(mockFetch).toHaveBeenCalledTimes(1);
	});

	it('serves the persisted store when offline', async () => {
		const { publicKey } = generateKeyPair();
		mockFetch.mockResolvedValueOnce(pemResponse(publicKey));
		const first = await checkProviderKeyUpdate({ force: true });

		mockFetch.mockRejectedValueOnce(new Error('ENOTFOUND maestro.sh'));
		const offline = await checkProviderKeyUpdate({ force: true });

		expect(offline.checked).toBe(false);
		expect(offline.updated).toBe(false);
		expect(offline.currentKeyId).toBe(first.currentKeyId);
	});

	it('keeps the stored key on HTTP errors', async () => {
		const { publicKey } = generateKeyPair();
		mockFetch.mockResolvedValueOnce(pemResponse(publicKey));
		const first = await checkProviderKeyUpdate({ force: true });

		mockFetch.mockResolvedValueOnce(pemResponse('', { status: 500 }));
		const errored = await checkProviderKeyUpdate({ force: true });

		expect(errored.updated).toBe(false);
		expect(errored.currentKeyId).toBe(first.currentKeyId);
	});

	it('ingests overlap keys but the FIRST key in the file is current', async () => {
		const current = generateKeyPair().publicKey;
		const overlap = generateKeyPair().publicKey;
		mockFetch.mockResolvedValueOnce(pemResponse(`${current}\n${overlap}`));

		const result = await checkProviderKeyUpdate({ force: true });

		expect(result.currentKeyId).toBe(computeKeyId(current));
		const store = await loadProviderKeyStore();
		expect(store.keys).toHaveLength(2);
	});
});

describe('getProviderKeyById', () => {
	it('finds a historical key locally without hitting the network', async () => {
		const { publicKey } = generateKeyPair();
		mockFetch.mockResolvedValueOnce(pemResponse(publicKey));
		await checkProviderKeyUpdate({ force: true });
		mockFetch.mockClear();

		const pem = await getProviderKeyById(computeKeyId(publicKey));
		expect(pem?.trim()).toBe(publicKey.trim());
		expect(mockFetch).not.toHaveBeenCalled();
	});

	it('falls back to a network pull for an unknown keyid', async () => {
		const { publicKey } = generateKeyPair();
		mockFetch.mockResolvedValueOnce(pemResponse(publicKey));

		const pem = await getProviderKeyById(computeKeyId(publicKey));
		expect(pem?.trim()).toBe(publicKey.trim());
		expect(mockFetch).toHaveBeenCalledTimes(1);
	});

	it('returns null when the keyid is unknown and the network is down', async () => {
		mockFetch.mockRejectedValue(new Error('offline'));
		expect(await getProviderKeyById('deadbeef00000000')).toBeNull();
	});
});

describe('getCurrentProviderKey', () => {
	it('pulls the file when the store is empty', async () => {
		const { publicKey } = generateKeyPair();
		mockFetch.mockResolvedValueOnce(pemResponse(publicKey));

		const key = await getCurrentProviderKey();
		expect(key?.keyid).toBe(computeKeyId(publicKey));
		expect(key?.source_url).toContain('https://');
	});

	it('returns null when empty and offline', async () => {
		mockFetch.mockRejectedValue(new Error('offline'));
		expect(await getCurrentProviderKey()).toBeNull();
	});
});
