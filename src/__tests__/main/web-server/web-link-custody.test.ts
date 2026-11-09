/**
 * The persistent web link token under credential custody (MCOMP-21-05, tested by
 * MCOMP-21-15B): `resolvePersistentWebAuthToken`, `persistWebAuthToken` and
 * `clearPersistedWebAuthToken` over a REAL `createCustodyCredentialSlot()` in a
 * scratch folder, owned through the REAL desktop custody source. Under
 * management a plaintext token in settings is migrated into the sealed slot and
 * the settings keep only the opaque reference; the token is never in the slot
 * file, the logs or the settings afterwards; a copy sealed for another owner or
 * an older anchored epoch is never served; a custody refusal writes nothing;
 * standalone keeps the plain settings path.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';

vi.mock('electron', () => ({
	app: { getPath: vi.fn(() => '/nonexistent/maestro-test-user-data'), on: vi.fn() },
	BrowserWindow: { getAllWindows: vi.fn(() => []) },
	ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn() },
	safeStorage: {
		isEncryptionAvailable: () => {
			throw new Error('the production slot must not be built in this suite');
		},
	},
}));
vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
	WEB_AUTH_TOKEN_FILE,
	WEB_AUTH_TOKEN_REFERENCE,
	clearPersistedWebAuthToken,
	persistWebAuthToken,
	resolvePersistentWebAuthToken,
	setWebAuthTokenSlot,
} from '../../../main/web-server/web-server-factory';
import {
	createCredentialCustodySource,
	createCustodyCredentialSlot,
	setCredentialCustodyAuthority,
} from '../../../main/enterprise/credential-custody';
import type { Anchor, AnchorStore } from '../../../main/utils/keyring-anchor';
import type { SealProvider } from '../../../main/utils/safe-storage-seal';
import { logger } from '../../../main/utils/logger';

/** A seal the OS key store would hold: reversible, never the plaintext bytes. */
const keystoreSeal = (): SealProvider => ({
	available: () => true,
	custody: () => ({ kind: 'os-keystore', backend: null }),
	seal: (text) => Buffer.from(Buffer.from(text, 'utf8').map((b) => b ^ 0x5a)),
	unseal: (blob) => Buffer.from(blob.map((b) => b ^ 0x5a)).toString('utf8'),
});
/** The built-in obscuring key: not credential protection, so custody refuses it. */
const obscuringSealDouble = (): SealProvider => ({
	...keystoreSeal(),
	custody: () => ({ kind: 'obscuring' }),
});

function memoryAnchor(): AnchorStore & { value: Anchor | null } {
	const anchor = {
		value: null as Anchor | null,
		available: () => true,
		read: () => anchor.value,
		write: (next: Anchor) => void (anchor.value = next),
		clear: () => void (anchor.value = null),
	};
	return anchor;
}

function settings(data: Record<string, unknown>) {
	return {
		data,
		get: vi.fn((key: string, fallback?: unknown) => (key in data ? data[key] : fallback)),
		set: vi.fn((key: string, value: unknown) => void (data[key] = value)),
	};
}
type Settings = ReturnType<typeof settings>;
const resolve = (store: Settings) => resolvePersistentWebAuthToken(store as never);

describe('the persistent web link token under credential custody (MCOMP-21-05)', () => {
	let dir: string;
	let file: string;
	let anchor: ReturnType<typeof memoryAnchor>;
	let owner: { tenantId: string; installationId: string };

	const manage = () =>
		setCredentialCustodyAuthority(
			createCredentialCustodySource({
				identity: {
					read: () => ({ status: 'ok', record: { ...owner }, fileExists: true }) as never,
				},
				platform: 'darwin',
			})
		);
	const useSlot = (seal: SealProvider = keystoreSeal()) =>
		setWebAuthTokenSlot(
			createCustodyCredentialSlot({ credential: 'web.authToken', file, seal, anchor })
		);
	/** Every place a token could leak to: the slot file, the settings and every log line. */
	const leaksOf = (store: Settings, token: string) => {
		const places = [
			fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '',
			JSON.stringify(store.data),
			JSON.stringify(vi.mocked(logger.warn).mock.calls),
			JSON.stringify(vi.mocked(logger.info).mock.calls),
			JSON.stringify(vi.mocked(logger.error).mock.calls),
			JSON.stringify(vi.mocked(logger.debug).mock.calls),
		];
		return places.filter((text) => text.includes(token));
	};

	beforeEach(() => {
		vi.clearAllMocks();
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-web-link-'));
		file = path.join(dir, WEB_AUTH_TOKEN_FILE);
		anchor = memoryAnchor();
		owner = { tenantId: 'tenant-a', installationId: 'install-1' };
	});
	afterEach(() => {
		setCredentialCustodyAuthority(null);
		setWebAuthTokenSlot(null);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('migrates a plaintext token into the sealed slot, keeps only the reference, and leaks it nowhere', () => {
		manage();
		useSlot();
		const legacy = randomUUID();
		const store = settings({ webAuthToken: legacy, persistentWebLink: true });
		expect(resolve(store)).toBe(legacy);
		expect(store.data.webAuthToken).toBe(WEB_AUTH_TOKEN_REFERENCE);
		expect(fs.existsSync(file)).toBe(true);
		expect(anchor.value).toMatchObject({ epoch: 1 });
		expect(leaksOf(store, legacy)).toEqual([]);
		// The next start opens the same token from custody and writes nothing.
		store.set.mockClear();
		expect(resolve(store)).toBe(legacy);
		expect(store.set).not.toHaveBeenCalled();
		expect(leaksOf(store, legacy)).toEqual([]);
	});

	it('never serves a copy sealed for another tenant or installation, and rotates it', () => {
		manage();
		useSlot();
		const kept = randomUUID();
		const store = settings({ webAuthToken: kept });
		expect(resolve(store)).toBe(kept);
		owner = { tenantId: 'tenant-b', installationId: 'install-1' };
		const rotated = resolve(store);
		expect(rotated).not.toBe(kept);
		expect(store.data.webAuthToken).toBe(WEB_AUTH_TOKEN_REFERENCE);
		owner = { tenantId: 'tenant-b', installationId: 'install-2' };
		const again = resolve(store);
		expect([kept, rotated]).not.toContain(again);
		expect(leaksOf(store, again)).toEqual([]);
	});

	it('never serves an older copy put back behind a newer anchored epoch', () => {
		manage();
		useSlot();
		const first = randomUUID();
		const store = settings({});
		expect(persistWebAuthToken(store as never, first)).toEqual({ ok: true });
		const olderCopy = fs.readFileSync(file, 'utf8');
		const second = randomUUID();
		expect(persistWebAuthToken(store as never, second)).toEqual({ ok: true });
		expect(anchor.value?.epoch).toBe(2);
		expect(resolve(store)).toBe(second);
		// Roll the file back: the anchor still names epoch 2, so the first token opens nothing.
		fs.writeFileSync(file, olderCopy);
		const served = resolve(store);
		expect([first, second]).not.toContain(served);
		expect(store.data).toEqual({ persistentWebLink: true, webAuthToken: WEB_AUTH_TOKEN_REFERENCE });
		expect(leaksOf(store, first)).toEqual([]);
		expect(leaksOf(store, second)).toEqual([]);
	});

	it('a custody refusal writes nothing: persist is refused by name, resolve drops the plaintext and rotates', () => {
		manage();
		useSlot(obscuringSealDouble());
		const store = settings({});
		const refused = persistWebAuthToken(store as never, randomUUID());
		expect(refused).toMatchObject({ ok: false });
		expect((refused as { message: string }).message).toMatch(
			/^\[managed-unprotected\] the persistent web link token is not kept on this managed host/
		);
		expect(store.set).not.toHaveBeenCalled();
		expect(fs.existsSync(file)).toBe(false);
		expect(anchor.value).toBeNull();
		// A plaintext token custody cannot keep is removed from settings and never reused.
		const legacy = randomUUID();
		store.data.webAuthToken = legacy;
		const served = resolve(store);
		expect(served).not.toBe(legacy);
		expect(store.data.webAuthToken).toBeNull();
		expect(fs.existsSync(file)).toBe(false);
		expect(leaksOf(store, legacy)).toEqual([]);
		expect(leaksOf(store, served)).toEqual([]);
		expect(vi.mocked(logger.warn).mock.calls[0][0]).toMatch(/^\[managed-unprotected\]/);
	});

	it('clear forgets the token in settings and in custody', () => {
		manage();
		useSlot();
		const store = settings({});
		expect(persistWebAuthToken(store as never, randomUUID())).toEqual({ ok: true });
		clearPersistedWebAuthToken(store as never);
		expect(store.data).toEqual({ persistentWebLink: false, webAuthToken: null });
		expect(fs.existsSync(file)).toBe(false);
		expect(anchor.value).toBeNull();
		// Managed, the sealed copy goes even when the settings no longer name the reference.
		expect(persistWebAuthToken(store as never, randomUUID())).toEqual({ ok: true });
		store.data.webAuthToken = randomUUID();
		clearPersistedWebAuthToken(store as never);
		expect(fs.existsSync(file)).toBe(false);
		expect(anchor.value).toBeNull();
	});

	it('standalone keeps the plain settings path and never touches the slot', () => {
		useSlot();
		const plain = randomUUID();
		const store = settings({ webAuthToken: plain });
		expect(resolve(store)).toBe(plain);
		expect(store.set).not.toHaveBeenCalled();
		const next = randomUUID();
		expect(persistWebAuthToken(store as never, next)).toEqual({ ok: true });
		expect(store.data).toEqual({ webAuthToken: next, persistentWebLink: true });
		clearPersistedWebAuthToken(store as never);
		expect(store.data).toEqual({ webAuthToken: null, persistentWebLink: false });
		expect(fs.existsSync(file)).toBe(false);
		expect(anchor.value).toBeNull();
		// A reference left by an enrollment that is gone drops its sealed copy and rotates.
		manage();
		const sealed = randomUUID();
		expect(persistWebAuthToken(store as never, sealed)).toEqual({ ok: true });
		expect(fs.existsSync(file)).toBe(true);
		setCredentialCustodyAuthority(null);
		const fresh = resolve(store);
		expect(fresh).not.toBe(sealed);
		expect(store.data.webAuthToken).toBe(fresh);
		expect(fs.existsSync(file)).toBe(false);
	});
});
