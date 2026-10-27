/**
 * The WakaTime manager under the install ceiling (MRC2-04-07), over the real
 * policy source with a mocked network, filesystem and process runner: on a
 * standalone host the "latest" zip is fetched and extracted as before and no
 * file is ever digested; on an enrolled host an unpinned fetch is refused
 * before a byte is written or a directory made, a pinned fetch follows the
 * pin's source and is extracted only when the bytes on disk carry the pinned
 * digest, a name on PATH never runs, the binary runs only by its bytes, the
 * daily "latest" check is skipped, and an enrollment that lands after a PATH
 * name was cached stops the next heartbeat.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import os from 'os';
import path from 'path';

vi.mock('electron', () => ({ app: { getVersion: vi.fn(() => '1.0.0') } }));
vi.mock('../../main/utils/execFile', () => ({ execFileNoThrow: vi.fn() }));
vi.mock('../../main/utils/logger', () => ({
	logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../shared/platformDetection', () => ({
	isWindows: vi.fn(() => false),
	getWhichCommand: vi.fn(() => 'which'),
}));
vi.mock('fs', () => {
	const api = {
		existsSync: vi.fn(() => false),
		readFileSync: vi.fn(() => ''),
		mkdirSync: vi.fn(),
		chmodSync: vi.fn(),
		createWriteStream: vi.fn(),
		unlinkSync: vi.fn(),
		unlink: vi.fn(),
	};
	return { default: api, ...api };
});
vi.mock('https', () => {
	const get = vi.fn();
	return { default: { get }, get };
});
const { digests } = vi.hoisted(() => ({ digests: new Map<string, string>() }));
vi.mock('../../shared/maestro-lib/managed/tui-handshake', () => ({
	createFileDigestCache: () => (file: string) => {
		const digest = digests.get(file);
		if (digest === undefined) throw new Error(`no digest fixture for ${file}`);
		return digest;
	},
}));

import fs from 'fs';
import https from 'https';
import { execFileNoThrow } from '../../main/utils/execFile';
import { logger } from '../../main/utils/logger';
import { WakaTimeManager } from '../../main/wakatime-manager';
import { createInstallPolicySource } from '../../main/enterprise/install-policy';
import type { IdentityRead } from '../../main/enterprise/identity-store';

const PLATFORM = { darwin: 'darwin', win32: 'windows', linux: 'linux' }[process.platform as string];
const ARCH = { arm64: 'arm64', x64: 'amd64', ia32: '386' }[process.arch as string];
const BINARY = `wakatime-cli-${PLATFORM}-${ARCH}`;
const ZIP = `${BINARY}.zip`;
const ZIP_PATH = path.join(os.tmpdir(), ZIP);
const INSTALL_DIR = path.join(os.homedir(), '.wakatime');
const BINARY_PATH = path.join(INSTALL_DIR, BINARY);
const LATEST = `https://github.com/wakatime/wakatime-cli/releases/latest/download/${ZIP}`;
const PINNED = `https://github.com/wakatime/wakatime-cli/releases/download/v1.73.1/${ZIP}`;
const ZIP_SHA = 'a'.repeat(64);
const BIN_SHA = 'b'.repeat(64);

const none: IdentityRead = { status: 'none' };
const enrolled: IdentityRead = { status: 'ok', record: {} as never, epoch: 1 };

function ceiling(pins: Record<string, unknown>[]) {
	return { policyRevision: 3, pins };
}
const zipPin = { artifact: 'wakatime-cli', file: ZIP, sha256: ZIP_SHA, source: PINNED };
const binaryPin = { artifact: 'wakatime-cli', file: BINARY, sha256: BIN_SHA };

/** `https.get` answering every request with a 200 whose body "pipes" straight to a finished stream. */
function serveDownloads(): string[] {
	const urls: string[] = [];
	vi.mocked(fs.createWriteStream).mockImplementation((() => {
		let finish: (() => void) | null = null;
		const stream = {
			on: vi.fn((event: string, cb: () => void) => {
				if (event === 'finish') finish = cb;
				return stream;
			}),
			close: vi.fn(),
			settle: () => finish?.(),
		};
		return stream;
	}) as never);
	vi.mocked(https.get).mockImplementation(((url: unknown, cb: (res: unknown) => void) => {
		urls.push(String(url));
		setTimeout(() => {
			cb({
				statusCode: 200,
				headers: {},
				resume: vi.fn(),
				pipe: (stream: { settle: () => void }) => setTimeout(() => stream.settle(), 0),
			});
		}, 0);
		return { on: vi.fn() };
	}) as never);
	return urls;
}

const commandsRun = () => vi.mocked(execFileNoThrow).mock.calls.map((call) => call[0]);
const warnings = () => vi.mocked(logger.warn).mock.calls.map((call) => String(call[0]));

describe('WakaTimeManager under the install ceiling', () => {
	let read: IdentityRead;
	let manager: WakaTimeManager;
	let source: ReturnType<typeof createInstallPolicySource>;

	beforeEach(() => {
		vi.clearAllMocks();
		// Implementations leak across cases under clearAllMocks; a case that downloads installs its own.
		vi.mocked(https.get)
			.mockReset()
			.mockReturnValue({ on: vi.fn() } as never);
		vi.mocked(fs.createWriteStream).mockReset();
		digests.clear();
		read = none;
		source = createInstallPolicySource({
			identity: { read: () => read },
			policy: () => ({ appliedRevision: 3 }),
		});
		manager = new WakaTimeManager({ get: vi.fn() } as never, '1.0.0');
		manager.setInstallAuthority(source);
		// Nothing on PATH or in ~/.wakatime/ unless a case says so.
		vi.mocked(execFileNoThrow).mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' });
		vi.mocked(fs.existsSync).mockReturnValue(false);
	});

	it('standalone: probes PATH, fetches the latest zip and extracts it without digesting anything', async () => {
		const urls = serveDownloads();
		vi.mocked(execFileNoThrow).mockImplementation(async (cmd) =>
			cmd === 'unzip'
				? { exitCode: 0, stdout: '', stderr: '' }
				: { exitCode: 1, stdout: '', stderr: '' }
		);

		expect(await manager.ensureCliInstalled()).toBe(true);

		expect(commandsRun()).toEqual(['wakatime-cli', 'wakatime', 'unzip']);
		expect(urls).toEqual([LATEST]);
		expect(fs.mkdirSync).toHaveBeenCalledWith(INSTALL_DIR, { recursive: true });
		expect(fs.chmodSync).toHaveBeenCalledWith(BINARY_PATH, 0o755);
		expect(manager.getCliPath()).toBe(BINARY_PATH);
		expect(warnings()).toEqual([]);
	});

	it('enrolled with no ceiling: runs no PATH name, fetches nothing, makes no directory, says why once', async () => {
		read = enrolled;

		expect(await manager.ensureCliInstalled()).toBe(false);
		expect(await manager.ensureCliInstalled()).toBe(false);

		expect(execFileNoThrow).not.toHaveBeenCalled();
		expect(https.get).not.toHaveBeenCalled();
		expect(fs.mkdirSync).not.toHaveBeenCalled();
		expect(fs.createWriteStream).not.toHaveBeenCalled();
		// One reason, one line: the PATH probe, the fetch and the second call all name the same missing ceiling.
		expect(warnings()).toEqual([
			expect.stringMatching(
				/^WakaTime CLI execute refused: \[managed-unavailable\] the managed install ceiling is unavailable \(no install ceiling is installed for policy revision 3\)$/
			),
		]);
	});

	it('enrolled with a ceiling that does not pin this zip: refused unpinned before any byte is written', async () => {
		read = enrolled;
		source.install(ceiling([binaryPin]));

		expect(await manager.ensureCliInstalled()).toBe(false);

		expect(https.get).not.toHaveBeenCalled();
		expect(fs.mkdirSync).not.toHaveBeenCalled();
		expect(fs.createWriteStream).not.toHaveBeenCalled();
		expect(warnings()).toContainEqual(
			expect.stringMatching(
				/fetch refused: \[managed-unpinned\] the install ceiling pins no wakatime-cli wakatime-cli-.*\.zip;/
			)
		);
	});

	it('enrolled with a pinned zip: fetches the pinned source, not latest, and extracts only the pinned bytes', async () => {
		read = enrolled;
		source.install(ceiling([zipPin, binaryPin]));
		const urls = serveDownloads();
		digests.set(ZIP_PATH, 'f'.repeat(64));

		expect(await manager.ensureCliInstalled()).toBe(false);

		expect(urls).toEqual([PINNED]);
		expect(fs.mkdirSync).not.toHaveBeenCalled();
		expect(commandsRun()).not.toContain('unzip');
		expect(fs.chmodSync).not.toHaveBeenCalled();
		expect(fs.unlinkSync).toHaveBeenCalledWith(ZIP_PATH);
		expect(warnings()).toContainEqual(
			expect.stringMatching(
				/execute refused: \[managed-digest-mismatch\] the bytes of wakatime-cli .*\.zip \(sha256 f{64}\) are not the pinned ones \(a{64}\)/
			)
		);

		// The same host, the pinned bytes: extracted, made executable, and run by its digest.
		vi.clearAllMocks();
		serveDownloads();
		digests.set(ZIP_PATH, ZIP_SHA);
		digests.set(BINARY_PATH, BIN_SHA);
		vi.mocked(execFileNoThrow).mockImplementation(async (cmd) =>
			cmd === 'unzip' || cmd === BINARY_PATH
				? { exitCode: 0, stdout: 'wakatime-cli 1.73.1', stderr: '' }
				: { exitCode: 1, stdout: '', stderr: '' }
		);
		expect(await manager.ensureCliInstalled()).toBe(true);
		expect(fs.mkdirSync).toHaveBeenCalledWith(INSTALL_DIR, { recursive: true });
		expect(commandsRun()).toEqual(['unzip']);
		expect(fs.chmodSync).toHaveBeenCalledWith(BINARY_PATH, 0o755);

		// Detection re-runs after an install: PATH names are never tried, the binary is held by its bytes.
		vi.mocked(fs.existsSync).mockImplementation((file) => file === BINARY_PATH);
		expect(await manager.ensureCliInstalled()).toBe(true);
		expect(commandsRun()).toEqual(['unzip', BINARY_PATH]);
		expect(vi.mocked(execFileNoThrow).mock.calls[1][1]).toEqual(['--version']);
		// Under management the pin says what is installed: the "latest" API is never asked.
		expect(vi.mocked(https.get).mock.calls.map((call) => String(call[0]))).toEqual([PINNED]);
	});

	it('enrolled: a local binary whose bytes are not the pinned ones is never run', async () => {
		read = enrolled;
		source.install(ceiling([binaryPin]));
		vi.mocked(fs.existsSync).mockImplementation((file) => file === BINARY_PATH);
		digests.set(BINARY_PATH, 'e'.repeat(64));

		expect(await manager.ensureCliInstalled()).toBe(false);

		expect(execFileNoThrow).not.toHaveBeenCalled();
		expect(warnings()).toContainEqual(expect.stringContaining('[managed-digest-mismatch]'));
	});

	it('an enrollment that lands after a PATH name was cached stops the next heartbeat', async () => {
		vi.mocked(execFileNoThrow).mockResolvedValue({
			exitCode: 0,
			stdout: 'wakatime-cli 1.73.1',
			stderr: '',
		});
		const store = { get: vi.fn((key: string) => (key === 'wakatimeApiKey' ? 'key-1' : true)) };
		manager = new WakaTimeManager(store as never, '1.0.0');
		manager.setInstallAuthority(source);
		expect(await manager.ensureCliInstalled()).toBe(true);
		expect(manager.getCliPath()).toBe('wakatime-cli');
		vi.mocked(execFileNoThrow).mockClear();

		read = enrolled;
		source.install(ceiling([zipPin, binaryPin]));
		await manager.sendHeartbeat('s1', 'proj');

		expect(execFileNoThrow).not.toHaveBeenCalled();
		expect(warnings()).toContainEqual(
			expect.stringMatching(
				/execute refused: \[managed-unpinned\] the install ceiling pins no wakatime-cli wakatime-cli;/
			)
		);
	});
});
