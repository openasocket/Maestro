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
 */

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
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

const b64 = (n: number) => 'Qz9_-'.repeat(Math.ceil(n / 5)).slice(0, n);
const CANARIES = {
	installSecret: 'k' + b64(42),
	nonce: 'n' + b64(42),
	dispatchTicket: 'T' + b64(31),
	cliSecret: 'f0e1d2c3'.repeat(6),
	webAuthToken: 'web-' + 'a9'.repeat(20),
	codexAccessToken:
		'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyLUFCQyIsImV4cCI6MTc2MTY2NzIwMH0.c2lnbmF0dXJlLWJ5dGVzLWhlcmUtMTIzNDU2Nzg5MA',
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
		] as never);
		const settingsStore = store({
			theme: 'dark',
			webAuthToken: CANARIES.webAuthToken,
			installSecret: CANARIES.installSecret,
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
		const settings = JSON.parse(entries.find(([name]) => name === 'settings.json')![1]);
		expect(settings.raw.theme).toBe('dark');
		expect(settings.raw.webAuthToken).toBe('[REDACTED]');
		expect(settings.raw.installSecret).toBe('[REDACTED]');
		expect(settings.raw.notes).toBe('anchor installSecret: [REDACTED_SECRET] seen');
	});
});
