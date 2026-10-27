/**
 * The maestro-p TUI under a managed admission (MRC2-03-05, 03-05A, 03-06,
 * 03-06A; tests MRC2-03-07).
 *
 * The TUI is the one child that spawns a provider of its own outside the
 * desktop's process sink, so a managed host hands it a signed handshake
 * (`MAESTRO_MANAGED_TUI_ADMISSION`) naming the approved binary, its digest,
 * the allowed flags and the run, and the TUI holds its own spawn to it before
 * `pty.spawn`. This suite drives `TuiDriver` with a fake pty factory (no
 * provider is ever started) and covers:
 *
 * - key custody and the wire half: a key minted once at 0600, a handshake
 *   that round-trips through the env and is refused forged, tampered, under a
 *   foreign key, malformed or oversize; absent and no-key reads;
 * - the host half: `buildTuiHandshake` signs the host's flags plus the TUI's
 *   own, adds the bypass only under no pin, refuses host args that bypass
 *   under a pin, and the TUI check passes exactly the args maestro-p spawns;
 * - the spawn check: the approved binary passes, a swapped `MAESTRO_CLAUDE_BIN`,
 *   replaced bytes, an unreadable binary, a flag outside the admission, a
 *   positional and a bypass above the ceiling are each refused by code;
 * - the driver: a matching handshake spawns through the fake pty, a tampered
 *   binary and a bypass under `standard` are refused before any spawn, a
 *   refused read is refused, and a missing handshake spawns unchanged;
 * - the bypass follows the ceiling (`withPermissionBypass`);
 * - the steering channel: planned from the env (none, open, pinned to the
 *   token and the admission identity, closed for a managed turn with no
 *   token), and the real server refuses a frame with no token, a stale token
 *   or another run's identity `not-authorized` while delivering a frame that
 *   carries both, through the real main-process client;
 * - the child env strips the handshake, the socket and the token.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
	buildTuiHandshake,
	checkTuiSpawn,
	CLAUDE_BYPASS_FLAG,
	claudeArgsBypassPermissions,
	createFileDigestCache,
	digestFileSha256,
	encodeTuiHandshake,
	flagNamesOf,
	loadOrCreateTuiHandshakeKey,
	readTuiHandshakeEnv,
	readTuiHandshakeKey,
	TUI_HANDSHAKE_ENV_VAR,
	tuiHandshakeKeyPath,
	tuiHandshakeProblems,
	verifyTuiHandshake,
	type TuiHandshakePayload,
	type TuiHandshakeRead,
} from '../../shared/maestro-lib/managed/tui-handshake';
import {
	isLocalSocketPath,
	parseSteeringRequest,
	STEERING_SOCKET_ENV_VAR,
	STEERING_TOKEN_ENV_VAR,
	type SteeringResultFrame,
} from '../../shared/chatSteering';
import { buildChildEnv, MAESTRO_P_PRIVATE_ENV_VARS } from '../../maestro-p/child-env';
import {
	ceilingAllowsBypass,
	skipsPermissionPrompts,
	tuiAdmissionCeiling,
	withPermissionBypass,
} from '../../maestro-p/open-tool-calls';
import {
	isLocalSocketPath as serverIsLocalSocketPath,
	planSteeringChannel,
	startSteeringServer,
	steeringFrameRefusal,
	steeringRunOf,
	type SteeringChannelAdmission,
} from '../../maestro-p/steering-server';
import { TuiAdmissionError, TuiDriver, type PtySpawn } from '../../maestro-p/tui-driver';
import {
	sendSteeringRequest,
	steeringSocketPathFor,
} from '../../main/process-manager/steering-client';
import { logger } from '../../main/utils/logger';

const run = {
	leaseId: 'lease-1',
	authorityId: 'authority-1',
	attemptId: 'attempt-1',
	requestId: 'request-1',
	runId: null,
	policyRevision: 7,
};
const KEY = 'ab'.repeat(32);
/** The desktop's maestro-p arguments for a turn (after the script path). */
const HOST_ARGS = [
	'-p',
	'--output-format',
	'stream-json',
	'--verbose',
	'--model=opus',
	'--',
	'fix it',
];

let dataDir: string;
let binDir: string;
let binPath: string;

beforeEach(() => {
	vi.clearAllMocks();
	dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tui-managed-data-'));
	binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tui-managed-bin-'));
	binPath = path.join(binDir, 'claude');
	fs.writeFileSync(binPath, '#!/bin/sh\necho claude\n');
});

afterEach(() => {
	fs.rmSync(dataDir, { recursive: true, force: true });
	fs.rmSync(binDir, { recursive: true, force: true });
});

function payload(over: Partial<TuiHandshakePayload> = {}): TuiHandshakePayload {
	return {
		version: 1,
		run,
		binary: { path: binPath, digest: digestFileSha256(binPath) },
		allowedFlags: ['--session-id', '--resume', CLAUDE_BYPASS_FLAG, '--model'],
		permissionMode: null,
		issuedAt: new Date(0).toISOString(),
		...over,
	};
}

const okRead = (over: Partial<TuiHandshakePayload> = {}): TuiHandshakeRead => ({
	status: 'ok',
	payload: payload(over),
});

/** A pty factory that records what would have been spawned and spawns nothing. */
function fakePty(): { spawnPty: PtySpawn; calls: Array<{ file: string; args: string[] }> } {
	const calls: Array<{ file: string; args: string[] }> = [];
	const spawnPty: PtySpawn = (file, args) => {
		calls.push({ file, args: [...args] });
		return {
			pid: 4242,
			onData: () => ({ dispose: () => undefined }),
			onExit: () => ({ dispose: () => undefined }),
			write: () => undefined,
			kill: () => undefined,
			resize: () => undefined,
		} as unknown as ReturnType<PtySpawn>;
	};
	return { spawnPty, calls };
}

function driverWith(
	admission: TuiHandshakeRead | undefined,
	args: string[],
	bin: string = binPath,
	digestFile?: (filePath: string) => string
) {
	const { spawnPty, calls } = fakePty();
	const driver = new TuiDriver({
		binPath: bin,
		args,
		cwd: binDir,
		env: {},
		spawnPty,
		...(digestFile ? { digestFile } : {}),
		...(admission ? { admission } : {}),
	});
	return { driver, calls };
}

/** What maestro-p hands claude for a run-mode turn: the pass-through flags, the bypass by ceiling, its own session id. */
function tuiArgs(passThrough: string[], ceiling: TuiHandshakePayload['permissionMode'] = null) {
	return [...withPermissionBypass(passThrough, ceiling), '--session-id', 'fresh-id'];
}

describe('key custody', () => {
	it('mints a 64-hex key at mode 0600 once, reads it back, and never overwrites a file that is not a key', () => {
		expect(readTuiHandshakeKey(dataDir)).toBeNull();
		const minted = loadOrCreateTuiHandshakeKey(dataDir);
		expect(minted).toMatch(/^[0-9a-f]{64}$/);
		const keyPath = tuiHandshakeKeyPath(dataDir);
		if (process.platform !== 'win32') expect(fs.statSync(keyPath).mode & 0o777).toBe(0o600);
		expect(loadOrCreateTuiHandshakeKey(dataDir)).toBe(minted);
		expect(readTuiHandshakeKey(dataDir)).toBe(minted);
		fs.writeFileSync(keyPath, 'not a key\n');
		expect(readTuiHandshakeKey(dataDir)).toBeNull();
		expect(() => loadOrCreateTuiHandshakeKey(dataDir)).toThrow(/is not a TUI handshake key/);
		expect(fs.readFileSync(keyPath, 'utf8')).toBe('not a key\n');
	});
});

describe('the handshake on the wire', () => {
	it('round-trips through the env against the key at the data directory, canonically', () => {
		fs.writeFileSync(tuiHandshakeKeyPath(dataDir), KEY);
		const encoded = encodeTuiHandshake(payload(), KEY);
		const read = readTuiHandshakeEnv(
			{ [TUI_HANDSHAKE_ENV_VAR]: encoded },
			{ readKey: () => readTuiHandshakeKey(dataDir) }
		);
		expect(read).toEqual({ status: 'ok', payload: payload() });
		// The signature is over canonical JSON: key order does not change the bytes.
		expect(encodeTuiHandshake({ ...payload(), run: { ...run } }, KEY)).toBe(encoded);
	});

	it('refuses a forged signature, a tampered payload, a foreign key, junk, an oversize and a malformed payload', () => {
		const encoded = encodeTuiHandshake(payload(), KEY);
		const signed = JSON.parse(encoded) as { payload: TuiHandshakePayload; signature: string };
		const tampered = {
			...signed,
			payload: payload({ binary: { path: '/evil/claude', digest: 'cd'.repeat(32) } }),
		};
		expect(verifyTuiHandshake(JSON.stringify(tampered), KEY)).toMatchObject({
			ok: false,
			reason: expect.stringContaining('signature'),
		});
		expect(verifyTuiHandshake(encoded, 'ef'.repeat(32))).toMatchObject({ ok: false });
		expect(verifyTuiHandshake('not json', KEY)).toMatchObject({
			ok: false,
			reason: expect.stringContaining('not JSON'),
		});
		expect(verifyTuiHandshake(JSON.stringify({ payload: {}, signature: 'x' }), KEY)).toMatchObject({
			ok: false,
		});
		expect(verifyTuiHandshake('x'.repeat(20_000), KEY)).toMatchObject({
			ok: false,
			reason: expect.stringContaining('exceeds'),
		});
		expect(verifyTuiHandshake(encoded, KEY)).toEqual({ ok: true, payload: payload() });
		expect(
			tuiHandshakeProblems({
				signature: KEY,
				payload: payload({ binary: { path: 'claude', digest: 'zz' } }),
			})
		).toEqual([
			'payload.binary.path is not an absolute path',
			'payload.binary.digest is not a hex SHA-256',
		]);
		expect(
			tuiHandshakeProblems({
				signature: KEY,
				payload: payload({ allowedFlags: ['x'], permissionMode: 'yolo' as never }),
			})
		).toEqual([
			'payload.allowedFlags is not a list of flag names',
			'payload.permissionMode is not a launch permission mode or null',
		]);
	});

	it('reads absent for a blank env, and refuses with no key or an unreadable key', () => {
		expect(readTuiHandshakeEnv({}, { readKey: () => KEY })).toEqual({ status: 'absent' });
		expect(readTuiHandshakeEnv({ [TUI_HANDSHAKE_ENV_VAR]: '  ' }, { readKey: () => KEY })).toEqual({
			status: 'absent',
		});
		const env = { [TUI_HANDSHAKE_ENV_VAR]: encodeTuiHandshake(payload(), KEY) };
		expect(readTuiHandshakeEnv(env, { readKey: () => null })).toMatchObject({
			status: 'refused',
			reason: expect.stringContaining('no key'),
		});
		expect(
			readTuiHandshakeEnv(env, {
				readKey: () => {
					throw new Error('EACCES');
				},
			})
		).toMatchObject({ status: 'refused', reason: expect.stringContaining('EACCES') });
	});
});

describe('the host half: buildTuiHandshake', () => {
	it('names flags up to the prompt separator once each, and the TUI bypass predicate is the shared rule', () => {
		expect(flagNamesOf(HOST_ARGS)).toEqual(['-p', '--output-format', '--verbose', '--model']);
		expect(flagNamesOf(['--model', 'opus', '--model', 'sonnet'])).toEqual(['--model']);
		expect(claudeArgsBypassPermissions(['--permission-mode', 'bypassPermissions'])).toBe(true);
		expect(claudeArgsBypassPermissions(['--permission-mode=bypassPermissions'])).toBe(true);
		expect(claudeArgsBypassPermissions(['--permission-mode', 'plan'])).toBe(false);
		expect(skipsPermissionPrompts([CLAUDE_BYPASS_FLAG])).toBe(true);
		expect(skipsPermissionPrompts(['--model', 'opus'])).toBe(false);
	});

	it('signs the host flags plus the TUI flags and the bypass under no pin, and the TUI check passes the final args', () => {
		const key = loadOrCreateTuiHandshakeKey(dataDir);
		const built = buildTuiHandshake({
			key,
			run,
			binaryPath: binPath,
			args: HOST_ARGS,
			permissionMode: null,
			now: () => new Date(0),
		});
		if (!built.ok) throw new Error(built.reason);
		expect(built.payload).toEqual({
			version: 1,
			run,
			binary: { path: binPath, digest: digestFileSha256(binPath) },
			allowedFlags: [
				'-p',
				'--output-format',
				'--verbose',
				'--model',
				'--session-id',
				'--resume',
				CLAUDE_BYPASS_FLAG,
			],
			permissionMode: null,
			issuedAt: new Date(0).toISOString(),
		});
		expect(verifyTuiHandshake(built.encoded, key)).toEqual({ ok: true, payload: built.payload });
		expect(verifyTuiHandshake(built.encoded, 'ef'.repeat(32))).toMatchObject({ ok: false });
		// maestro-p keeps -p, --output-format and --verbose for itself and forwards the rest.
		const finalArgs = tuiArgs(['--model=opus']);
		expect(finalArgs).toContain(CLAUDE_BYPASS_FLAG);
		const check = (args: string[]) =>
			checkTuiSpawn(built.payload, {
				binPath,
				args,
				bypassesPermissions: skipsPermissionPrompts(args),
			});
		expect(check(finalArgs)).toEqual({ ok: true });
		expect(check([...finalArgs, '--resume', 'abc'])).toEqual({ ok: true });
		expect(check([...finalArgs, '--add-dir', '/x'])).toMatchObject({
			ok: false,
			code: 'argument-not-allowed',
		});
	});

	it('leaves the bypass out under a standard pin, refuses host args that bypass, and admits a plan-mode turn under readonly', () => {
		const key = loadOrCreateTuiHandshakeKey(dataDir);
		const standard = buildTuiHandshake({
			key,
			run,
			binaryPath: binPath,
			args: HOST_ARGS,
			permissionMode: 'standard',
		});
		if (!standard.ok) throw new Error(standard.reason);
		expect(standard.payload.allowedFlags).not.toContain(CLAUDE_BYPASS_FLAG);
		expect(standard.payload.permissionMode).toBe('standard');
		// maestro-p reads the ceiling and withholds the bypass: the final args pass.
		const underPin = tuiArgs(['--model=opus'], 'standard');
		expect(underPin).not.toContain(CLAUDE_BYPASS_FLAG);
		expect(
			checkTuiSpawn(standard.payload, {
				binPath,
				args: underPin,
				bypassesPermissions: skipsPermissionPrompts(underPin),
			})
		).toEqual({ ok: true });
		// A maestro-p that ignored the ceiling and appended the bypass is refused by name.
		const bypassing = tuiArgs(['--model=opus']);
		expect(
			checkTuiSpawn(standard.payload, {
				binPath,
				args: bypassing,
				bypassesPermissions: skipsPermissionPrompts(bypassing),
			})
		).toMatchObject({
			ok: false,
			code: 'argument-not-allowed',
			reason: expect.stringContaining(CLAUDE_BYPASS_FLAG),
		});
		expect(
			buildTuiHandshake({
				key,
				run,
				binaryPath: binPath,
				args: [...HOST_ARGS.slice(0, 5), CLAUDE_BYPASS_FLAG],
				permissionMode: 'standard',
			})
		).toMatchObject({ ok: false, reason: expect.stringContaining('bypass') });
		expect(
			buildTuiHandshake({
				key,
				run,
				binaryPath: binPath,
				args: ['--permission-mode', 'bypassPermissions'],
				permissionMode: 'readonly',
			})
		).toMatchObject({ ok: false });
		const plan = buildTuiHandshake({
			key,
			run,
			binaryPath: binPath,
			args: ['-p', '--permission-mode', 'plan', '--', 'look'],
			permissionMode: 'readonly',
		});
		if (!plan.ok) throw new Error(plan.reason);
		const planArgs = tuiArgs(['--permission-mode', 'plan'], 'readonly');
		expect(planArgs).not.toContain(CLAUDE_BYPASS_FLAG);
		expect(
			checkTuiSpawn(plan.payload, {
				binPath,
				args: planArgs,
				bypassesPermissions: skipsPermissionPrompts(planArgs),
			})
		).toEqual({ ok: true });
	});

	it('refuses a relative or unreadable binary, and the digest cache follows the file identity', () => {
		expect(
			buildTuiHandshake({ key: KEY, run, binaryPath: 'claude', args: [], permissionMode: null })
		).toMatchObject({ ok: false, reason: expect.stringContaining('not an absolute path') });
		expect(
			buildTuiHandshake({
				key: KEY,
				run,
				binaryPath: path.join(binDir, 'missing'),
				args: [],
				permissionMode: null,
			})
		).toMatchObject({ ok: false, reason: expect.stringContaining('could not be read') });
		const digest = createFileDigestCache();
		const first = digest(binPath);
		expect(first).toBe(digestFileSha256(binPath));
		expect(digest(binPath)).toBe(first);
		fs.writeFileSync(binPath, '#!/bin/sh\necho replaced and longer\n');
		expect(digest(binPath)).toBe(digestFileSha256(binPath));
		expect(digest(binPath)).not.toBe(first);
	});
});

describe('checkTuiSpawn', () => {
	it('passes the approved binary and allowed flags with their values', () => {
		expect(
			checkTuiSpawn(payload(), {
				binPath,
				args: ['--session-id', 'abc', '--model', 'opus', CLAUDE_BYPASS_FLAG],
				bypassesPermissions: true,
			})
		).toEqual({ ok: true });
	});

	it('refuses a tampered MAESTRO_CLAUDE_BIN path, a replaced binary and a missing one, by code', () => {
		const approved = payload();
		expect(
			checkTuiSpawn(approved, { binPath: '/evil/claude', args: [], bypassesPermissions: false })
		).toMatchObject({ ok: false, code: 'binary-path' });
		fs.writeFileSync(binPath, '#!/bin/sh\necho evil\n');
		expect(
			checkTuiSpawn(approved, { binPath, args: [], bypassesPermissions: false })
		).toMatchObject({ ok: false, code: 'binary-digest' });
		fs.rmSync(binPath);
		expect(
			checkTuiSpawn(approved, { binPath, args: [], bypassesPermissions: false })
		).toMatchObject({ ok: false, code: 'binary-unreadable' });
	});

	it('refuses a flag outside the admission, a positional, and a bypass above the ceiling', () => {
		expect(
			checkTuiSpawn(payload(), { binPath, args: ['--add-dir', '/x'], bypassesPermissions: false })
		).toMatchObject({
			ok: false,
			code: 'argument-not-allowed',
			reason: expect.stringContaining('--add-dir'),
		});
		expect(
			checkTuiSpawn(payload(), { binPath, args: ['prompt'], bypassesPermissions: false })
		).toMatchObject({ ok: false, code: 'argument-not-allowed' });
		expect(
			checkTuiSpawn(payload({ permissionMode: 'standard' }), {
				binPath,
				args: ['--permission-mode', 'bypassPermissions'],
				bypassesPermissions: true,
			})
		).toMatchObject({ ok: false, code: 'argument-not-allowed' });
		expect(
			checkTuiSpawn(payload({ permissionMode: 'standard', allowedFlags: ['--permission-mode'] }), {
				binPath,
				args: ['--permission-mode', 'bypassPermissions'],
				bypassesPermissions: true,
			})
		).toMatchObject({ ok: false, code: 'permission-above-ceiling' });
		expect(
			checkTuiSpawn(payload({ permissionMode: 'full', allowedFlags: ['--permission-mode'] }), {
				binPath,
				args: ['--permission-mode', 'bypassPermissions'],
				bypassesPermissions: true,
			})
		).toEqual({ ok: true });
	});
});

describe('TuiDriver.start under an admission', () => {
	it('spawns through the fake pty when the binary and flags match the handshake', async () => {
		const { driver, calls } = driverWith(
			okRead({ allowedFlags: ['--session-id', CLAUDE_BYPASS_FLAG] }),
			['--session-id', 'abc', CLAUDE_BYPASS_FLAG]
		);
		await driver.start();
		expect(calls).toEqual([{ file: binPath, args: ['--session-id', 'abc', CLAUDE_BYPASS_FLAG] }]);
		driver.kill('SIGKILL');
	});

	it('reads a handshake the host built, spawns the approved binary, and refuses a swapped or replaced one before spawn', async () => {
		const key = loadOrCreateTuiHandshakeKey(dataDir);
		const built = buildTuiHandshake({
			key,
			run,
			binaryPath: binPath,
			args: HOST_ARGS,
			permissionMode: null,
		});
		if (!built.ok) throw new Error(built.reason);
		const read = readTuiHandshakeEnv(
			{ [TUI_HANDSHAKE_ENV_VAR]: built.encoded },
			{ readKey: () => readTuiHandshakeKey(dataDir) }
		);
		expect(read.status).toBe('ok');
		const args = tuiArgs(['--model=opus']);
		const approved = driverWith(read, args);
		await approved.driver.start();
		expect(approved.calls).toEqual([{ file: binPath, args }]);
		approved.driver.kill('SIGKILL');

		const swappedPath = path.join(binDir, 'evil-claude');
		fs.copyFileSync(binPath, swappedPath);
		const swapped = driverWith(read, args, swappedPath);
		await expect(swapped.driver.start()).rejects.toBeInstanceOf(TuiAdmissionError);
		await expect(swapped.driver.start()).rejects.toMatchObject({ code: 'binary-path' });
		expect(swapped.calls).toHaveLength(0);

		fs.writeFileSync(binPath, '#!/bin/sh\necho evil\n');
		const replaced = driverWith(read, args);
		await expect(replaced.driver.start()).rejects.toMatchObject({ code: 'binary-digest' });
		expect(replaced.calls).toHaveLength(0);
	});

	it('refuses before spawn on a wrong digest and on the TUI bypass under a standard ceiling', async () => {
		const wrong = driverWith(
			okRead({ binary: { path: binPath, digest: '00'.repeat(32) } }),
			['--session-id', 'abc'],
			binPath,
			() => 'ff'.repeat(32)
		);
		await expect(wrong.driver.start()).rejects.toBeInstanceOf(TuiAdmissionError);
		await expect(wrong.driver.start()).rejects.toMatchObject({ code: 'binary-digest' });
		expect(wrong.calls).toHaveLength(0);
		const standard = driverWith(
			okRead({ allowedFlags: ['--session-id'], permissionMode: 'standard' }),
			['--session-id', 'abc', CLAUDE_BYPASS_FLAG]
		);
		await expect(standard.driver.start()).rejects.toMatchObject({ code: 'argument-not-allowed' });
		expect(standard.calls).toHaveLength(0);
		const above = driverWith(
			okRead({ allowedFlags: ['--session-id', '--permission-mode'], permissionMode: 'standard' }),
			['--session-id', 'abc', '--permission-mode', 'bypassPermissions']
		);
		await expect(above.driver.start()).rejects.toMatchObject({ code: 'permission-above-ceiling' });
		expect(above.calls).toHaveLength(0);
	});

	it('refuses a handshake that did not verify, before spawn', async () => {
		const { driver, calls } = driverWith({ status: 'refused', reason: 'no key' }, []);
		await expect(driver.start()).rejects.toMatchObject({
			code: 'handshake-refused',
			message: 'no key',
		});
		expect(calls).toHaveLength(0);
	});

	it('spawns unchanged with an absent handshake and with no admission at all (the unmanaged host)', async () => {
		const absent = driverWith({ status: 'absent' }, ['--anything', 'positional'], 'claude');
		await absent.driver.start();
		expect(absent.calls).toEqual([{ file: 'claude', args: ['--anything', 'positional'] }]);
		absent.driver.kill('SIGKILL');
		const none = driverWith(undefined, [CLAUDE_BYPASS_FLAG], 'claude');
		await none.driver.start();
		expect(none.calls).toEqual([{ file: 'claude', args: [CLAUDE_BYPASS_FLAG] }]);
		none.driver.kill('SIGKILL');
	});
});

describe('withPermissionBypass under a ceiling', () => {
	it('adds the bypass with no ceiling and under full, as before', () => {
		const bypassed = ['--model', 'opus', CLAUDE_BYPASS_FLAG];
		expect(withPermissionBypass(['--model', 'opus'])).toEqual(bypassed);
		expect(withPermissionBypass(['--model', 'opus'], null)).toEqual(bypassed);
		expect(withPermissionBypass(['--model', 'opus'], 'full')).toEqual(bypassed);
	});

	it('withholds the bypass under standard and readonly, rewriting nothing else', () => {
		expect(withPermissionBypass(['--model', 'opus'], 'standard')).toEqual(['--model', 'opus']);
		expect(withPermissionBypass(['--model', 'opus'], 'readonly')).toEqual(['--model', 'opus']);
		expect(withPermissionBypass([], 'standard')).toEqual([]);
		// Args that already bypass are returned as they are: the admission check refuses them by name.
		expect(withPermissionBypass([CLAUDE_BYPASS_FLAG], 'standard')).toEqual([CLAUDE_BYPASS_FLAG]);
		expect(withPermissionBypass(['--permission-mode', 'plan'], 'readonly')).toEqual([
			'--permission-mode',
			'plan',
		]);
	});

	it('reads the ceiling off the admission', () => {
		expect(tuiAdmissionCeiling(undefined)).toBeNull();
		expect(tuiAdmissionCeiling({ status: 'absent' })).toBeNull();
		expect(tuiAdmissionCeiling({ status: 'refused', reason: 'x' })).toBeNull();
		expect(tuiAdmissionCeiling(okRead())).toBeNull();
		expect(tuiAdmissionCeiling(okRead({ permissionMode: 'standard' }))).toBe('standard');
		expect(ceilingAllowsBypass(null)).toBe(true);
		expect(ceilingAllowsBypass('full')).toBe(true);
		expect(ceilingAllowsBypass('standard')).toBe(false);
		expect(ceilingAllowsBypass('readonly')).toBe(false);
	});
});

describe('the steering channel plan', () => {
	const SOCKET = { [STEERING_SOCKET_ENV_VAR]: '/tmp/s.sock' };

	it('names no channel without a socket, and an unmanaged one as before', () => {
		expect(planSteeringChannel({}, null)).toEqual({ kind: 'none' });
		expect(planSteeringChannel({ [STEERING_TOKEN_ENV_VAR]: 'abc' }, null)).toEqual({
			kind: 'none',
		});
		expect(planSteeringChannel(SOCKET, null)).toEqual({ kind: 'open', socketPath: '/tmp/s.sock' });
	});

	it('pins an unmanaged channel to the token the host sent', () => {
		expect(planSteeringChannel({ ...SOCKET, [STEERING_TOKEN_ENV_VAR]: ' tok ' }, null)).toEqual({
			kind: 'open',
			socketPath: '/tmp/s.sock',
			admission: { token: 'tok', run: null },
		});
	});

	it('closes a managed channel sent without a token, and pins one sent with it to the admission identity', () => {
		const closed = planSteeringChannel(SOCKET, steeringRunOf(okRead()));
		expect(closed).toMatchObject({
			kind: 'closed',
			socketPath: '/tmp/s.sock',
			reason: expect.stringContaining('no steering token'),
		});
		expect(
			planSteeringChannel(
				{ ...SOCKET, [STEERING_TOKEN_ENV_VAR]: 'tok' },
				steeringRunOf(okRead({ permissionMode: 'standard' }))
			)
		).toEqual({
			kind: 'open',
			socketPath: '/tmp/s.sock',
			admission: { token: 'tok', run: { leaseId: 'lease-1', attemptId: 'attempt-1' } },
		});
		expect(steeringRunOf(undefined)).toBeNull();
		expect(steeringRunOf({ status: 'absent' })).toBeNull();
		expect(steeringRunOf({ status: 'refused', reason: 'x' })).toBeNull();
	});
});

describe('steeringFrameRefusal', () => {
	const frame = (extra: Record<string, unknown>) =>
		parseSteeringRequest(JSON.stringify({ type: 'steer', id: 'i', text: 't', ...extra }))!;

	it('acts on every frame with no admission, and holds the token with none leaked', () => {
		expect(steeringFrameRefusal(frame({}), undefined)).toBeNull();
		const admission: SteeringChannelAdmission = { token: 'secret', run: null };
		expect(steeringFrameRefusal(frame({}), admission)).toContain('no run token');
		expect(steeringFrameRefusal(frame({ token: 'stale' }), admission)).toContain('not the token');
		expect(steeringFrameRefusal(frame({ token: 'secre' }), admission)).toContain('not the token');
		expect(steeringFrameRefusal(frame({ token: 'stale' }), admission)).not.toContain('secret');
		expect(steeringFrameRefusal(frame({ token: 'secret' }), admission)).toBeNull();
	});

	it('holds the admission identity after the token', () => {
		const admission: SteeringChannelAdmission = {
			token: 'secret',
			run: { leaseId: 'lease-1', attemptId: 'attempt-1' },
		};
		expect(steeringFrameRefusal(frame({ token: 'secret' }), admission)).toContain(
			'no admission identity'
		);
		expect(
			steeringFrameRefusal(
				frame({ token: 'secret', run: { leaseId: 'lease-1', attemptId: 'attempt-2' } }),
				admission
			)
		).toContain('not the identity');
		expect(
			steeringFrameRefusal(
				frame({ token: 'secret', run: { leaseId: 'lease-1', attemptId: 'attempt-1' } }),
				admission
			)
		).toBeNull();
		expect(
			steeringFrameRefusal(
				frame({ token: 'nope', run: { leaseId: 'lease-1', attemptId: 'attempt-1' } }),
				admission
			)
		).toContain('not the token');
	});

	it('parses the credentials by shape and drops malformed ones', () => {
		expect(frame({ token: 'tok', run: { leaseId: 'l', attemptId: 'a' } })).toEqual({
			type: 'steer',
			id: 'i',
			text: 't',
			token: 'tok',
			run: { leaseId: 'l', attemptId: 'a' },
		});
		expect(frame({ token: 42, run: { leaseId: 'l' } })).toEqual({
			type: 'steer',
			id: 'i',
			text: 't',
		});
		expect(frame({ token: 'x'.repeat(257) })).toEqual({ type: 'steer', id: 'i', text: 't' });
	});
});

describe('the steering server and the desktop client', () => {
	const opened: Array<{ close: () => void }> = [];
	const socketPaths: string[] = [];

	afterEach(() => {
		while (opened.length) opened.pop()!.close();
		for (const socketPath of socketPaths.splice(0)) {
			try {
				if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
			} catch {
				// Best effort: a leftover socket file only costs the next run an unlink.
			}
		}
	});

	async function waitForServing(socketPath: string): Promise<void> {
		const net = await import('node:net');
		for (let i = 0; i < 100; i += 1) {
			const ok = await new Promise<boolean>((resolve) => {
				const probe = net.createConnection(socketPath);
				probe.once('connect', () => {
					probe.destroy();
					resolve(true);
				});
				probe.once('error', () => resolve(false));
			});
			if (ok) return;
			await new Promise((r) => setTimeout(r, 10));
		}
		throw new Error(`nothing ever served ${socketPath}`);
	}

	async function serveWith(admission: SteeringChannelAdmission | undefined) {
		const warn = vi.fn();
		const onSteer = vi.fn(
			async (id: string): Promise<SteeringResultFrame> => ({
				type: 'steering',
				id,
				verdict: 'delivered',
			})
		);
		const socketPath = steeringSocketPathFor(`tui-managed-${process.pid}-${Math.random()}`);
		socketPaths.push(socketPath);
		const server = startSteeringServer({ socketPath, onSteer, warn, admission });
		expect(server).not.toBeNull();
		opened.push(server!);
		await waitForServing(socketPath);
		const steer = (
			id: string,
			credentials: { token?: string; run?: { leaseId: string; attemptId: string } } = {}
		) =>
			sendSteeringRequest({
				processKey: 'k',
				socketPath,
				text: 'go',
				id,
				timeoutMs: 2_000,
				...credentials,
			});
		return { socketPath, warn, onSteer, steer };
	}

	it('shares the one loopback rule with the client, and neither opens or dials a numeric path', async () => {
		expect(serverIsLocalSocketPath).toBe(isLocalSocketPath);
		expect(isLocalSocketPath('8080')).toBe(false);
		expect(isLocalSocketPath(' 12 ')).toBe(false);
		expect(isLocalSocketPath('/tmp/x.sock')).toBe(true);
		expect(isLocalSocketPath('\\\\.\\pipe\\maestro-steer-abc')).toBe(true);
		const warn = vi.fn();
		expect(
			startSteeringServer({ socketPath: '8080', onSteer: async () => fail(), warn })
		).toBeNull();
		expect(warn).toHaveBeenCalledOnce();
		expect(warn.mock.calls[0][0]).toContain('TCP port');
		const result = await sendSteeringRequest({
			processKey: 'k',
			socketPath: '8080',
			text: 'x',
			id: 'num',
		});
		expect(result).toMatchObject({ verdict: 'refused', refusal: 'not-running' });
		expect(result.detail).toContain('not a local socket');
		expect(logger.warn).toHaveBeenCalledWith(
			'Steering channel path is not a local socket',
			expect.any(String),
			expect.objectContaining({ socketPath: '8080' })
		);
	});

	it('refuses a frame with no token not-authorized, logs it, and types nothing', async () => {
		const { warn, onSteer, steer } = await serveWith({ token: 'secret', run: null });
		const result = await steer('r1');
		expect(result).toMatchObject({
			type: 'steering',
			id: 'r1',
			verdict: 'refused',
			refusal: 'not-authorized',
			detail: expect.stringContaining('no run token'),
		});
		expect(onSteer).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalledOnce();
		expect(warn.mock.calls[0][0]).toContain('refused steering request r1');
	});

	it('refuses a stale token the same way, never naming the secret', async () => {
		const { onSteer, steer } = await serveWith({ token: 'secret', run: null });
		const result = await steer('r2', { token: 'from-the-last-run' });
		expect(result).toMatchObject({ verdict: 'refused', refusal: 'not-authorized' });
		expect(result.detail).not.toContain('secret');
		expect(onSteer).not.toHaveBeenCalled();
	});

	it('refuses the right token with no identity or another admission identity', async () => {
		const { onSteer, steer } = await serveWith({
			token: 'secret',
			run: { leaseId: 'lease-1', attemptId: 'attempt-1' },
		});
		expect(await steer('r3', { token: 'secret' })).toMatchObject({
			verdict: 'refused',
			refusal: 'not-authorized',
		});
		expect(
			await steer('r4', { token: 'secret', run: { leaseId: 'lease-0', attemptId: 'attempt-1' } })
		).toMatchObject({ verdict: 'refused', refusal: 'not-authorized' });
		expect(onSteer).not.toHaveBeenCalled();
	});

	it('delivers a frame carrying the token and the admission identity, and a bare frame with no admission', async () => {
		const pinned = await serveWith({
			token: 'secret',
			run: { leaseId: 'lease-1', attemptId: 'attempt-1' },
		});
		expect(
			await pinned.steer('r5', {
				token: 'secret',
				run: { leaseId: 'lease-1', attemptId: 'attempt-1' },
			})
		).toMatchObject({ id: 'r5', verdict: 'delivered' });
		expect(pinned.onSteer).toHaveBeenCalledExactlyOnceWith('r5', 'go');
		expect(pinned.warn).not.toHaveBeenCalled();
		const open = await serveWith(undefined);
		expect(await open.steer('r6')).toMatchObject({ id: 'r6', verdict: 'delivered' });
		expect(open.onSteer).toHaveBeenCalledExactlyOnceWith('r6', 'go');
	});
});

function fail(): never {
	throw new Error('onSteer must not run');
}

describe('the child env', () => {
	it('strips the handshake, the steering socket and the token from the claude child environment', () => {
		expect(MAESTRO_P_PRIVATE_ENV_VARS).toContain(TUI_HANDSHAKE_ENV_VAR);
		expect(MAESTRO_P_PRIVATE_ENV_VARS).toContain(STEERING_TOKEN_ENV_VAR);
		const env = buildChildEnv({
			[TUI_HANDSHAKE_ENV_VAR]: 'x',
			[STEERING_SOCKET_ENV_VAR]: '/tmp/s.sock',
			[STEERING_TOKEN_ENV_VAR]: 'secret',
			USER: 'me',
			PATH: '/bin',
		});
		expect(env).not.toHaveProperty(TUI_HANDSHAKE_ENV_VAR);
		expect(env).not.toHaveProperty(STEERING_SOCKET_ENV_VAR);
		expect(env).not.toHaveProperty(STEERING_TOKEN_ENV_VAR);
		expect(env.PATH).toBe('/bin');
	});
});
