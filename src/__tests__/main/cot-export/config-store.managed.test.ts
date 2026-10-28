/**
 * The chain of thought export state under the credential custody ceiling
 * (MRC2-06-09), over INJECTED seals and anchors from fakeCustody.ts: nothing
 * here touches Electron's safeStorage or the developer's keyring. The real
 * authority (createCredentialCustodySource over a fake identity read) is the
 * module authority the store's default custody reads, as the desktop composes
 * it. Pinned: every unprotected custody is refused by the custody line with
 * nothing written and no fallback seal asked; the OS key store with an anchor
 * seals as before; the standing is read at every save; no refusal names a folder.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '' }, safeStorage: {} }));
vi.mock('../../../main/stores/getters', () => ({
	getSessionsStore: () => ({ get: () => [] }),
	getLiveSessions: () => [],
	getSyncPath: (): string => {
		throw new Error('Stores not initialized.');
	},
}));
vi.mock('../../../main/utils/logger', () => ({
	logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));

import {
	COT_CONFIG_STORE_NAME,
	PERSIST_INTERVAL_MS,
	createCotConfigStore,
} from '../../../main/cot-export/config-store';
import type { CotConfigStore, CotConfigStoreDeps } from '../../../main/cot-export/config-store';
import {
	createCredentialCustodySource,
	setCredentialCustodyAuthority,
} from '../../../main/enterprise/credential-custody';
import type { IdentityRead } from '../../../main/enterprise/identity-store';
import type { Anchor, AnchorStore } from '../../../main/utils/keyring-anchor';
import { logger } from '../../../main/utils/logger';
import { obscuringSeal } from '../../../main/utils/safe-storage-seal';
import type { SealProvider } from '../../../main/utils/safe-storage-seal';
import { fakeAnchor, fakeSeal } from '../enterprise/fakeCustody';

const AGENT = 'agent-1';
const HASH_A = 'a'.repeat(64);
const enrolled: IdentityRead = { status: 'ok', record: {} as never, epoch: 1 };
const standalone: IdentityRead = { status: 'none' };
const line = (why: string): string => `the turn log state is not kept on this managed host: ${why}`;
const NO_ENCRYPTION = 'The operating system offers no encryption for this app.';
const NO_ANCHOR =
	'no OS credential store holds a freshness anchor, so an older copy could not be told from the newest.';
/** The one bland line the clock logs: no file name, no folder, no value. */
const SAVE_REFUSED = ['Could not save a state file (MANAGED_CUSTODY).', 'Stores'];

/** A fallback seal that counts its uses: under management it must never be asked. */
function countingFallback(): SealProvider & { calls: number } {
	const inner = fakeSeal({ mark: 'OBSCURED\u0000' });
	const seal = {
		calls: 0,
		available: () => true,
		seal: (text: string): Buffer => {
			seal.calls += 1;
			return inner.seal(text);
		},
		unseal: inner.unseal,
	};
	return seal;
}

describe('cot-export/config-store under injected custody (MRC2-06-09)', () => {
	let root: string;
	let dataDir: string;
	let read: IdentityRead;
	let stores: CotConfigStore[];
	let fallback: ReturnType<typeof countingFallback>;
	const deps = {
		identity: { read: (): IdentityRead => read },
		platform: 'darwin' as NodeJS.Platform,
	};

	const storeFile = (): string => path.join(dataDir, `${COT_CONFIG_STORE_NAME}.json`);
	const onDisk = (): Record<string, string> => JSON.parse(fs.readFileSync(storeFile(), 'utf8'));
	const logs = (): string => path.join(root, 'logs');
	const warnings = () => vi.mocked(logger.warn).mock.calls;
	const turnOn = (store: CotConfigStore) =>
		store.setAgentConfig(AGENT, { enabled: true, folder: logs() });

	/** A store over the temp data dir. The stores made before it stop their clocks, as a gone process does. */
	const makeStore = (extra: Partial<CotConfigStoreDeps> = {}): CotConfigStore => {
		for (const earlier of stores) earlier.dispose();
		return openStore(extra);
	};
	/** A store that reads what is on disk and never saves: its clock is stopped at once. */
	const readBack = (extra: Partial<CotConfigStoreDeps> = {}): CotConfigStore => {
		const reader = openStore(extra);
		reader.dispose();
		return reader;
	};
	const openStore = (extra: Partial<CotConfigStoreDeps> = {}): CotConfigStore => {
		const store = createCotConfigStore({
			cwd: dataDir,
			seal: fakeSeal(),
			fallbackSeal: fallback,
			getFolderContext: () => ({
				agentDirs: [],
				userDataPath: dataDir,
				homeDir: path.join(root, 'home'),
			}),
			now: () => 1_700_000_000_000,
			...extra,
		});
		stores.push(store);
		return store;
	};

	beforeEach(() => {
		vi.mocked(logger.warn).mockClear();
		root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cot-managed-')));
		dataDir = path.join(root, 'data');
		fs.mkdirSync(dataDir);
		fs.mkdirSync(path.join(root, 'home'));
		stores = [];
		read = enrolled;
		deps.platform = 'darwin';
		fallback = countingFallback();
		setCredentialCustodyAuthority(createCredentialCustodySource(deps));
	});

	afterEach(() => {
		setCredentialCustodyAuthority(null);
		vi.useRealTimers();
		for (const store of stores) store.dispose();
		fs.rmSync(root, { recursive: true, force: true });
	});

	it.each([
		['no encryption', () => ({ seal: fakeSeal({ available: false }) }), NO_ENCRYPTION],
		[
			'the obscuring seal as the primary',
			() => ({ seal: obscuringSeal() }),
			'The obscuring seal uses a key built into the app; it is not credential protection.',
		],
		[
			'a seal that names no custody',
			() => ({ seal: fakeSeal({ custody: null }) }),
			'The seal provider does not say who holds its key.',
		],
		[
			'no freshness anchor',
			() => ({ anchor: fakeAnchor({ value: null }, { available: false }) }),
			NO_ANCHOR,
		],
		['no anchor at all', () => ({ anchor: undefined }), NO_ANCHOR],
	])(
		'managed with %s: refused by the custody line, nothing written, the fallback never asked, no folder named',
		(_name, arrange, why) => {
			const anchored = { anchor: fakeAnchor({ value: null }), ...arrange() };
			const store = makeStore(anchored);

			const result = turnOn(store);

			expect(result).toEqual({ ok: false, reason: line(why) });
			expect(store.isEnabled(AGENT)).toBe(false);
			expect(fs.readdirSync(dataDir)).toEqual([]);
			expect(fallback.calls).toBe(0);
			expect(warnings()).toEqual([]);
			expect(JSON.stringify(result)).not.toContain(root);
		}
	);

	it('managed on Linux with a basic_text keyring: refused by name; the same seal on macOS is admitted', () => {
		const seal = fakeSeal({ custody: { kind: 'os-keystore', backend: 'basic_text' } });
		const anchor = fakeAnchor({ value: null });
		deps.platform = 'linux';
		expect(turnOn(makeStore({ seal, anchor }))).toEqual({
			ok: false,
			reason: line(
				'Linux is storing app secrets as basic_text; unlock a keyring before enrolling.'
			),
		});
		expect(fs.readdirSync(dataDir)).toEqual([]);

		deps.platform = 'darwin';
		expect(turnOn(makeStore({ seal, anchor })).ok).toBe(true);
		expect(Object.keys(onDisk())).toEqual(['blob']);
	});

	it('managed under the OS key store with an anchor: sealed by the injected seal, anchored, the fallback never asked', () => {
		const holder: { value: Anchor | null } = { value: null };
		const seal = fakeSeal();
		const store = makeStore({ seal, anchor: fakeAnchor(holder), newSecret: () => 'secret-1' });

		expect(turnOn(store).ok).toBe(true);

		const file = onDisk();
		expect(Object.keys(file)).toEqual(['blob']);
		const state = JSON.parse(seal.unseal(Buffer.from(file.blob, 'base64')));
		expect(state.agents[AGENT].config).toMatchObject({ enabled: true, folder: logs() });
		expect(state).toMatchObject({ epoch: 1, installSecret: 'secret-1' });
		expect(holder.value).toEqual({ installSecret: 'secret-1', epoch: 1 });
		expect(fallback.calls).toBe(0);
		expect(warnings()).toEqual([]);
		expect(makeStore({ seal, anchor: fakeAnchor(holder) }).isEnabled(AGENT)).toBe(true);
	});

	it('standalone: every custody is admitted as before; the fallback obscures when there is no encryption', () => {
		read = standalone;
		const unsealed = fakeSeal({ available: false });
		expect(turnOn(makeStore({ seal: unsealed })).ok).toBe(true);
		expect(Object.keys(onDisk())).toEqual(['obscured']);
		expect(fallback.calls).toBe(1);
		expect(makeStore({ seal: unsealed }).isEnabled(AGENT)).toBe(true);

		fs.rmSync(storeFile());
		expect(turnOn(makeStore({ seal: fakeSeal({ custody: null }) })).ok).toBe(true);
		expect(Object.keys(onDisk())).toEqual(['blob']);
		expect(warnings()).toEqual([]);
	});

	it('the standing is read at every save: an enrollment stops the clock by the custody line, said once; a release resumes it', () => {
		vi.useFakeTimers();
		read = standalone;
		const seal = fakeSeal({ available: false });
		const store = makeStore({ seal });
		turnOn(store);
		const before = fs.readFileSync(storeFile(), 'utf8');
		expect(fallback.calls).toBe(1);

		read = enrolled;
		store.setChainHead(AGENT, { folder: logs(), head: HASH_A, chainSeq: 1 });
		vi.advanceTimersByTime(3 * PERSIST_INTERVAL_MS);
		store.flushSync();

		// Read, never saved again: the obscured file a standalone run wrote is the one on disk.
		expect(fs.readFileSync(storeFile(), 'utf8')).toBe(before);
		expect(fallback.calls).toBe(1);
		expect(warnings()).toEqual([SAVE_REFUSED]);
		expect(store.setAgentConfig(AGENT, { enabled: false, folder: logs() })).toEqual({
			ok: false,
			reason: line(NO_ENCRYPTION),
		});
		expect(store.isEnabled(AGENT)).toBe(true);

		read = standalone;
		vi.advanceTimersByTime(PERSIST_INTERVAL_MS);
		expect(fs.readFileSync(storeFile(), 'utf8')).not.toBe(before);
		expect(fallback.calls).toBe(2);
		expect(readBack({ seal }).getChainState(AGENT, logs())?.head).toBe(HASH_A);
		expect(warnings()).toEqual([SAVE_REFUSED]);
	});

	it('managed: an anchor that goes away stops the next save, said once per run of failures; a returned anchor resumes it', () => {
		vi.useFakeTimers();
		const holder: { value: Anchor | null } = { value: null };
		let anchorUp = true;
		const anchor: AnchorStore = { ...fakeAnchor(holder), available: () => anchorUp };
		const seal = fakeSeal();
		const store = makeStore({ seal, anchor });
		expect(turnOn(store).ok).toBe(true);
		const before = fs.readFileSync(storeFile(), 'utf8');

		anchorUp = false;
		store.setChainHead(AGENT, { folder: logs(), head: HASH_A, chainSeq: 1 });
		vi.advanceTimersByTime(2 * PERSIST_INTERVAL_MS);
		expect(fs.readFileSync(storeFile(), 'utf8')).toBe(before);
		expect(warnings()).toEqual([SAVE_REFUSED]);
		expect(store.setAgentConfig(AGENT, { enabled: false, folder: logs() })).toEqual({
			ok: false,
			reason: line(NO_ANCHOR),
		});

		anchorUp = true;
		vi.advanceTimersByTime(PERSIST_INTERVAL_MS);
		expect(readBack({ seal, anchor }).getChainState(AGENT, logs())?.head).toBe(HASH_A);
		expect(fallback.calls).toBe(0);

		anchorUp = false;
		vi.advanceTimersByTime(PERSIST_INTERVAL_MS);
		expect(warnings()).toEqual([SAVE_REFUSED, SAVE_REFUSED]);
	});
});
