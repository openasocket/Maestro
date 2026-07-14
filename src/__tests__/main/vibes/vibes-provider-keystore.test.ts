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
	buildProviderKeyUrl,
	buildProviderKeySigUrl,
	buildProviderRootKeyUrl,
	createKeyEndorsement,
	verifyKeyEndorsement,
	PROVIDER_KEY_FILE_URL,
	MAESTRO_TOOL_DOMAIN,
	MAESTRO_TOOL_NAME,
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

function jsonResponse(body: unknown, status = 200) {
	return {
		ok: status >= 200 && status < 300,
		status,
		headers: { get: () => null },
		text: async () => JSON.stringify(body),
	};
}

function notFoundResponse() {
	return {
		ok: false,
		status: 404,
		headers: { get: () => null },
		text: async () => 'not found',
	};
}

describe('buildProviderKeyUrl (VIBES-standard key path)', () => {
	it('builds https://{toolDomain}/vibes/{toolName}.pub', () => {
		expect(buildProviderKeyUrl('example.com', 'mytool')).toBe(
			'https://example.com/vibes/mytool.pub'
		);
	});

	it('lowercases the tool name and strips scheme/trailing slash from the domain', () => {
		expect(buildProviderKeyUrl('https://Example.com/', 'MyTool')).toBe(
			'https://Example.com/vibes/mytool.pub'
		);
	});

	it("Maestro's own key URL follows the standard path", () => {
		expect(PROVIDER_KEY_FILE_URL).toBe(buildProviderKeyUrl(MAESTRO_TOOL_DOMAIN, MAESTRO_TOOL_NAME));
		expect(PROVIDER_KEY_FILE_URL).toBe('https://maestro.sh/vibes/maestro.pub');
	});

	it('checkProviderKeyUpdate derives the URL from a tool identity', async () => {
		const { publicKey } = generateKeyPair();
		mockFetch.mockResolvedValueOnce(pemResponse(publicKey));

		await checkProviderKeyUpdate({
			force: true,
			toolDomain: 'other-tool.dev',
			toolName: 'OtherTool',
		});

		expect(mockFetch.mock.calls[0][0]).toBe('https://other-tool.dev/vibes/othertool.pub');
	});
});

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

		// calls: [0] key file, [1] endorsement file (new key), [2] the 304 re-check
		const secondCallHeaders = mockFetch.mock.calls[2][1].headers as Record<string, string>;
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
		// key file + endorsement file for the new key; throttled check adds none
		expect(mockFetch).toHaveBeenCalledTimes(2);
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
		// key file + endorsement file
		expect(mockFetch).toHaveBeenCalledTimes(2);
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

describe('key endorsement (signed keys: rotation chaining + developer root)', () => {
	it('builds the sibling endorsement and root key URLs', () => {
		expect(buildProviderKeySigUrl('example.com', 'mytool')).toBe(
			'https://example.com/vibes/mytool.pub.sig'
		);
		expect(buildProviderRootKeyUrl('example.com', 'mytool')).toBe(
			'https://example.com/vibes/mytool.root.pub'
		);
	});

	it('createKeyEndorsement/verifyKeyEndorsement roundtrip; tampered key fails', () => {
		const signer = generateKeyPair();
		const endorsed = generateKeyPair();
		const other = generateKeyPair();

		const e = createKeyEndorsement(endorsed.publicKey, signer.privateKey, signer.keyId);
		expect(e.keyid).toBe(computeKeyId(endorsed.publicKey));
		expect(e.signed_by).toBe(signer.keyId);
		expect(verifyKeyEndorsement(endorsed.publicKey, e.sig, signer.publicKey)).toBe(true);
		// endorsement does not transfer to a different key
		expect(verifyKeyEndorsement(other.publicKey, e.sig, signer.publicKey)).toBe(false);
	});

	it('accepts a rotation endorsed by the previously-held key (endorsed-chain)', async () => {
		const keyA = generateKeyPair();
		const keyB = generateKeyPair();

		// First pull: key A, no endorsement file published yet -> unendorsed
		mockFetch.mockResolvedValueOnce(pemResponse(keyA.publicKey));
		mockFetch.mockResolvedValueOnce(notFoundResponse());
		await checkProviderKeyUpdate({ force: true });

		// Rotation: key B published, endorsed by key A
		const endorsement = createKeyEndorsement(keyB.publicKey, keyA.privateKey, keyA.keyId);
		mockFetch.mockResolvedValueOnce(pemResponse(keyB.publicKey));
		mockFetch.mockResolvedValueOnce(jsonResponse({ version: 1, endorsements: [endorsement] }));

		const result = await checkProviderKeyUpdate({ force: true });
		expect(result.updated).toBe(true);
		expect(result.currentKeyId).toBe(keyB.keyId);
		expect(result.detail).toContain('endorsed-chain');

		const store = await loadProviderKeyStore();
		const stored = store.keys.find((k) => k.keyid === keyB.keyId);
		expect(stored?.trust).toBe('endorsed-chain');
		expect(stored?.endorsed_by).toBe(keyA.keyId);
	});

	it('REJECTS a rotated key whose published endorsement does not verify', async () => {
		const keyA = generateKeyPair();
		const keyB = generateKeyPair();
		const attacker = generateKeyPair();

		mockFetch.mockResolvedValueOnce(pemResponse(keyA.publicKey));
		mockFetch.mockResolvedValueOnce(notFoundResponse());
		await checkProviderKeyUpdate({ force: true });

		// Attacker publishes key B with an endorsement signed by an UNKNOWN key
		const bogus = createKeyEndorsement(keyB.publicKey, attacker.privateKey, attacker.keyId);
		mockFetch.mockResolvedValueOnce(pemResponse(keyB.publicKey));
		mockFetch.mockResolvedValueOnce(jsonResponse({ version: 1, endorsements: [bogus] }));
		// root key fetch attempt (signer unknown) -> not published
		mockFetch.mockResolvedValueOnce(notFoundResponse());

		const result = await checkProviderKeyUpdate({ force: true });
		expect(result.updated).toBe(false);
		expect(result.currentKeyId).toBe(keyA.keyId);
		expect(result.detail).toContain('REJECTED');

		const store = await loadProviderKeyStore();
		expect(store.keys).toHaveLength(1);
		expect(store.current_keyid).toBe(keyA.keyId);
	});

	it('REJECTS a new key when the endorsement file omits it', async () => {
		const keyA = generateKeyPair();
		const keyB = generateKeyPair();

		mockFetch.mockResolvedValueOnce(pemResponse(keyA.publicKey));
		mockFetch.mockResolvedValueOnce(notFoundResponse());
		await checkProviderKeyUpdate({ force: true });

		// Endorsement file exists but has no entry for key B
		const unrelated = createKeyEndorsement(keyA.publicKey, keyA.privateKey, keyA.keyId);
		mockFetch.mockResolvedValueOnce(pemResponse(keyB.publicKey));
		mockFetch.mockResolvedValueOnce(jsonResponse({ version: 1, endorsements: [unrelated] }));

		const result = await checkProviderKeyUpdate({ force: true });
		expect(result.updated).toBe(false);
		expect(result.currentKeyId).toBe(keyA.keyId);
	});

	it('accepts a first pull endorsed by the developer root key (endorsed-root)', async () => {
		const root = generateKeyPair();
		const operational = generateKeyPair();
		const endorsement = createKeyEndorsement(operational.publicKey, root.privateKey, root.keyId);

		mockFetch.mockResolvedValueOnce(pemResponse(operational.publicKey));
		mockFetch.mockResolvedValueOnce(jsonResponse({ version: 1, endorsements: [endorsement] }));
		// signer unknown locally -> root key fetched from {toolName}.root.pub
		mockFetch.mockResolvedValueOnce(pemResponse(root.publicKey));

		const result = await checkProviderKeyUpdate({ force: true });
		expect(result.updated).toBe(true);
		expect(result.detail).toContain('endorsed-root');

		const store = await loadProviderKeyStore();
		const stored = store.keys.find((k) => k.keyid === operational.keyId);
		expect(stored?.trust).toBe('endorsed-root');
		expect(stored?.endorsed_by).toBe(root.keyId);
		expect(store.root_key?.keyid).toBe(root.keyId);
	});

	it('keys pulled with no published endorsement file record unendorsed trust', async () => {
		const key = generateKeyPair();
		mockFetch.mockResolvedValueOnce(pemResponse(key.publicKey));
		mockFetch.mockResolvedValueOnce(notFoundResponse());

		await checkProviderKeyUpdate({ force: true });
		const store = await loadProviderKeyStore();
		expect(store.keys[0].trust).toBe('unendorsed');
	});
});
