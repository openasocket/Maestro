/**
 * Redaction canaries on the support package (MRC2-06-07).
 *
 * One canary per managed identifier the redactor learned (an install secret,
 * a registration nonce, a dispatch ticket, the per-boot CLI secret, the TUI
 * handshake as an env assignment and as its bare signed JSON) and one for a
 * Codex access token, planted where a value reaches the package without a
 * collector naming it: a settings value, a log line that printed an
 * environment, and the free text of an error log. The package is generated
 * for real into a temp directory and read back; none of the canaries may
 * appear in any entry, and the placeholders must.
 *
 * The collectors keep no transcript (a conversation never enters the zip),
 * so a transcript line reaches the package only as a log message, which is
 * where the env dump is planted. The same patterns cover Send Feedback's
 * outbound text through `redactOutbound()` (see redactSecrets.test.ts and
 * feedback/managed.test.ts).
 *
 * MRC2-06-09 adds the two credentials the custody ceiling holds (the WakaTime
 * API key in a settings value and an echoed cfg line, the 0DIN token in an env
 * dump and its exchanged JWT), absent from the package, and the plain settings
 * file as the other sink: the real store guard refuses the key by custody.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('electron', () => ({
	app: {
		getVersion: vi.fn(() => '1.0.0'),
		getPath: vi.fn(() => '/mock/userData'),
		isPackaged: false,
	},
}));
vi.mock('electron-store', () => ({
	default: vi.fn().mockImplementation(() => ({ get: vi.fn(), set: vi.fn(), store: {} })),
}));
vi.mock('../../../main/utils/cliDetection', () => ({
	isCloudflaredInstalled: vi.fn(() => Promise.resolve(false)),
}));
vi.mock('../../../main/utils/shellDetector', () => ({
	detectShells: vi.fn(() => Promise.resolve([])),
}));
vi.mock('../../../main/utils/execFile', () => ({
	execFileNoThrow: vi.fn(() => Promise.resolve({ stdout: '', stderr: '', exitCode: 1 })),
}));
vi.mock('../../../main/tunnel-manager', () => ({
	tunnelManager: { getStatus: vi.fn(() => ({ isRunning: false, url: null, error: null })) },
}));
vi.mock('../../../main/agents', () => ({}));
vi.mock('../../../main/process-manager', () => ({}));
vi.mock('../../../main/web-server', () => ({}));
vi.mock('../../../main/utils/logger', () => ({
	logger: {
		getLogs: vi.fn(() => []),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

import { logger } from '../../../main/utils/logger';
import { generateDebugPackage, redactPackageContents } from '../../../main/debug-package';
import { extractZipTo } from '../../../main/utils/zip-archive';
import {
	encodeTuiHandshake,
	TUI_HANDSHAKE_ENV_VAR,
} from '../../../shared/maestro-lib/managed/tui-handshake';
import { PLAIN_SETTINGS_CREDENTIAL_KEYS } from '../../../main/enterprise/credential-custody';
import {
	createSettingsPolicySource,
	guardSettingsStore,
	holdSettingWrite,
	setSettingsWriteAuthority,
} from '../../../main/enterprise/settings-policy';
import { SETTINGS_METADATA } from '../../../shared/settingsMetadata';
import { installManagedSettingsPolicy } from '../../helpers/managedSettingsPolicy';

const b64 = (n: number) => 'Qz9_-'.repeat(Math.ceil(n / 5)).slice(0, n);
const CANARIES = {
	installSecret: 'k' + b64(42),
	nonce: 'n' + b64(42),
	dispatchTicket: 'T' + b64(31),
	cliSecret: 'f0e1d2c3'.repeat(6),
	webAuthToken: 'web-' + 'a9'.repeat(20),
	codexAccessToken:
		'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyLUFCQyIsImV4cCI6MTc2MTY2NzIwMH0.c2lnbmF0dXJlLWJ5dGVzLWhlcmUtMTIzNDU2Nzg5MA',
	// The two credentials the custody ceiling holds (MRC2-06-06).
	wakatimeApiKey: 'waka_' + 'c7d8'.repeat(9),
	odinToken: 'odin_' + 'e5f6'.repeat(9),
	odinJwt:
		'eyJhbGciOiJIUzI1NiJ9.eyJpc3MiOiIwZGluLmFpIiwiZXhwIjoxNzYxNjY3MjAwfQ.MGRpbi1qd3Qtc2lnbmF0dXJlLWJ5dGVzLTk4NzY1NDMyMTA',
};
const HANDSHAKE_KEY = 'ab'.repeat(32);
const handshake = encodeTuiHandshake(
	{
		version: 1,
		run: {
			leaseId: 'lease-1',
			authorityId: 'authority-1',
			attemptId: 'attempt-1',
			requestId: 'request-1',
			runId: null,
			policyRevision: 3,
		},
		binary: { path: '/opt/claude/bin/claude', digest: 'c'.repeat(64) },
		allowedFlags: ['--model'],
		permissionMode: 'standard',
		issuedAt: '2026-10-28T10:00:00.000Z',
	},
	HANDSHAKE_KEY
);
const HANDSHAKE_SIGNATURE = (JSON.parse(handshake) as { signature: string }).signature;

const OUTPUT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-redaction-canaries-'));

afterAll(() => {
	fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
});

beforeEach(() => {
	vi.clearAllMocks();
});

function store(contents: Record<string, unknown>) {
	return {
		get: vi.fn((key: string, fallback?: unknown) => contents[key] ?? fallback),
		set: vi.fn(),
		store: contents,
	};
}

describe('redactPackageContents', () => {
	it('walks every string at any depth and leaves numbers, booleans and null alone', () => {
		const out = redactPackageContents({
			n: 3,
			ok: true,
			none: null,
			list: [`nonce: ${CANARIES.nonce}`, 7],
			nested: { line: `${TUI_HANDSHAKE_ENV_VAR}=${handshake}` },
		});
		expect(out).toEqual({
			n: 3,
			ok: true,
			none: null,
			list: ['nonce: [REDACTED_SECRET]', 7],
			nested: { line: `${TUI_HANDSHAKE_ENV_VAR}=[REDACTED_SECRET]` },
		});
	});
});

describe('support package redaction canaries (MRC2-06-07)', () => {
	it('writes a package that carries none of the planted values', async () => {
		vi.mocked(logger.getLogs).mockReturnValue([
			{
				timestamp: 1,
				level: 'info',
				message: `spawn env: ${TUI_HANDSHAKE_ENV_VAR}=${handshake}`,
				context: 'ProcessManager',
			},
			{
				timestamp: 2,
				level: 'error',
				message: `bridge refused {"dispatchTicket":"${CANARIES.dispatchTicket}"} with x-maestro-cli-secret: ${CANARIES.cliSecret}`,
				context: 'WebServer',
			},
			// Each under the collector's 500-character cap, so a canary is
			// absent because it was redacted, never because it was cut off.
			{
				timestamp: 3,
				level: 'error',
				message: `handshake ${handshake} did not verify`,
				context: 'Enterprise',
			},
			{
				timestamp: 5,
				level: 'error',
				message: `registration challenge nonce: ${CANARIES.nonce} shown once`,
				context: 'Enterprise',
			},
			{
				timestamp: 4,
				level: 'warn',
				message: `codex auth {"tokens":{"access_token":"${CANARIES.codexAccessToken}"}}`,
				context: 'Codex',
			},
			{
				timestamp: 6,
				level: 'debug',
				message: `wakatime cfg read: [settings] api_key = ${CANARIES.wakatimeApiKey}`,
				context: 'WakaTime',
			},
			{
				timestamp: 7,
				level: 'debug',
				message: `cue env: ODIN_API_TOKEN=${CANARIES.odinToken} CUE_POLL_SECONDS=30`,
				context: 'Cue',
			},
			{
				timestamp: 8,
				level: 'debug',
				message: `0din exchange {"token":"${CANARIES.odinJwt}","expires_in":900}`,
				context: 'Cue',
			},
		] as never);
		const settingsStore = store({
			theme: 'dark',
			webAuthToken: CANARIES.webAuthToken,
			installSecret: CANARIES.installSecret,
			wakatimeApiKey: CANARIES.wakatimeApiKey,
			notes: `anchor installSecret: ${CANARIES.installSecret} seen`,
		});
		const sessionsStore = store({ sessions: [] });
		const groupsStore = store({ groups: [] });

		const result = await generateDebugPackage(OUTPUT_DIR, {
			getAgentDetector: () => null,
			getProcessManager: () => null,
			getWebServer: () => null,
			settingsStore: settingsStore as never,
			sessionsStore: sessionsStore as never,
			groupsStore: groupsStore as never,
		});
		expect(result.success).toBe(true);
		expect(result.filesIncluded).toContain('logs.json');
		expect(result.filesIncluded).toContain('settings.json');

		const extracted = path.join(OUTPUT_DIR, 'extracted');
		extractZipTo(result.path!, extracted);
		const entries = fs
			.readdirSync(extracted)
			.map((name) => [name, fs.readFileSync(path.join(extracted, name), 'utf8')] as const);
		expect(entries.map(([name]) => name)).toContain('logs.json');
		const whole = entries.map(([, text]) => text).join('\n');

		for (const [name, canary] of Object.entries(CANARIES)) {
			expect(whole, `${name} reached the package`).not.toContain(canary);
		}
		expect(whole).not.toContain(HANDSHAKE_SIGNATURE);
		expect(whole).not.toContain(HANDSHAKE_KEY);

		// The log messages are JSON strings in the file; read them back as text.
		const logs = (
			JSON.parse(entries.find(([name]) => name === 'logs.json')![1]) as {
				entries: Array<{ message: string }>;
			}
		).entries
			.map((entry) => entry.message)
			.join('\n');
		expect(logs).toContain(`${TUI_HANDSHAKE_ENV_VAR}=[REDACTED_SECRET]`);
		expect(logs).toContain('"signature":"[REDACTED_SECRET]"');
		expect(logs).toContain('challenge nonce: [REDACTED_SECRET]');
		expect(logs).toContain('x-maestro-cli-secret: [REDACTED_SECRET]');
		expect(logs).toContain('"dispatchTicket":[REDACTED_SECRET]');
		expect(logs).toContain('"access_token":[REDACTED_SECRET]');
		expect(logs).toContain('api_key = [REDACTED_SECRET]');
		expect(logs).toContain('ODIN_API_TOKEN=[REDACTED_SECRET] CUE_POLL_SECONDS=30');
		expect(logs).toContain('"token":[REDACTED_SECRET],"expires_in":900');
		const settings = JSON.parse(entries.find(([name]) => name === 'settings.json')![1]);
		expect(settings.raw.theme).toBe('dark');
		expect(settings.raw.webAuthToken).toBe('[REDACTED]');
		expect(settings.raw.installSecret).toBe('[REDACTED]');
		expect(settings.raw.wakatimeApiKey).toBe('[REDACTED]');
		expect(settings.raw.notes).toBe('anchor installSecret: [REDACTED_SECRET] seen');
	});
});

describe('the plain settings file, the other sink of the WakaTime key (MRC2-06-09)', () => {
	const CUSTODY =
		'the WakaTime API key is not kept on this managed host: maestro-settings.json is a readable file, and a managed host keeps a credential only under the OS key store.';
	/** A settings store as the desktop guards it (the chokepoint of `stores/instances.ts`). */
	const guarded = (data: Record<string, unknown>) => {
		const writes: unknown[][] = [];
		const store = guardSettingsStore({
			store: data,
			get: (key: string) => data[key],
			set(key: string | Record<string, unknown>, value?: unknown) {
				const entries = typeof key === 'string' ? [[key, value]] : Object.entries(key);
				for (const [name, next] of entries) {
					writes.push([name, next]);
					data[name as string] = next;
				}
			},
		});
		return { store, writes, data };
	};
	const enrolledWithoutPolicy = () =>
		createSettingsPolicySource({
			identity: { read: () => ({ status: 'ok', record: {}, fileExists: true }) as never },
			policy: () => ({ appliedRevision: 3 }),
		});

	afterEach(() => setSettingsWriteAuthority(null));

	it('the real store guard refuses the key by custody on an enrolled host, policy or no policy, and writes nothing', () => {
		for (const source of [enrolledWithoutPolicy(), installManagedSettingsPolicy([])]) {
			setSettingsWriteAuthority(source);
			const { store, writes, data } = guarded({ theme: 'dark' });

			expect(() => store.set('wakatimeApiKey', CANARIES.wakatimeApiKey)).toThrow(CUSTODY);
			// Not even the other keys of a multi-key write land.
			expect(() => store.set({ theme: 'light', wakatimeApiKey: CANARIES.wakatimeApiKey })).toThrow(
				CUSTODY
			);

			expect(writes).toEqual([]);
			expect(data).toEqual({ theme: 'dark' });
			expect(holdSettingWrite('wakatimeApiKey')).toMatchObject({
				allowed: false,
				code: 'custody',
				message: CUSTODY,
			});
		}
	});

	it('standalone the key is written as before; the 0DIN token has no settings key to be written to', () => {
		const { store, writes } = guarded({});
		store.set('wakatimeApiKey', CANARIES.wakatimeApiKey);
		expect(writes).toEqual([['wakatimeApiKey', CANARIES.wakatimeApiKey]]);
		// The package masks it by exact name because the metadata marks it.
		expect(SETTINGS_METADATA.wakatimeApiKey.sensitive).toBe(true);
		expect(Object.keys(SETTINGS_METADATA).filter((key) => /odin/i.test(key))).toEqual([]);
		expect(PLAIN_SETTINGS_CREDENTIAL_KEYS).toEqual({ wakatimeApiKey: 'wakatime.apiKey' });
	});
});
