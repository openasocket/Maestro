/**
 * The desktop sink's half of the maestro-p admission (MRC2-03-05A) and the
 * steering authority (MRC2-03-06A): `ProcessManager.spawn()` recognises a
 * local maestro-p launch, stamps the host's signed TUI handshake on a managed
 * one, mints a per-run steering token for every one, remembers the token with
 * the admission identity on the process record, and `steer()` carries both to
 * the channel. The TUI side is the real `TuiDriver` over a fake pty and the
 * REAL maestro-p steering server planned from the captured env, exactly as
 * maestro-p plans it. No provider is spawned: the spawners are stubs that
 * register a record the way the real ones do.
 */
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManagedProcess, ProcessConfig, SpawnResult } from '../../../main/process-manager';

const SPAWN_RESULT: SpawnResult = { pid: 4242, success: true };

const captured = vi.hoisted(() => ({
	child: [] as ProcessConfig[],
	pty: [] as ProcessConfig[],
	codex: [] as ProcessConfig[],
	processes: null as Map<string, ManagedProcess> | null,
	warns: [] as unknown[][],
}));

vi.mock('../../../main/coworking/coworking-socket-path', () => ({
	getBridgeSocketPath: () => '/tmp/test-bridge.sock',
}));
vi.mock('../../../main/process-manager/spawners/ChildProcessSpawner', () => ({
	ChildProcessSpawner: class {
		constructor(private readonly processes: Map<string, ManagedProcess>) {
			captured.processes = processes;
		}
		spawn(config: ProcessConfig): SpawnResult {
			captured.child.push(config);
			this.processes.set(config.sessionId, {
				sessionId: config.sessionId,
				toolType: config.toolType,
				cwd: config.cwd,
				pid: SPAWN_RESULT.pid,
				isTerminal: false,
				startTime: Date.now(),
			});
			return SPAWN_RESULT;
		}
	},
}));
vi.mock('../../../main/process-manager/spawners/PtySpawner', () => ({
	PtySpawner: class {
		spawn(config: ProcessConfig): SpawnResult {
			captured.pty.push(config);
			return SPAWN_RESULT;
		}
	},
}));
vi.mock('../../../main/process-manager/spawners/OpencodeServerSpawner', () => ({
	OpencodeServerSpawner: class {
		spawn(): SpawnResult {
			return SPAWN_RESULT;
		}
	},
}));
vi.mock('../../../main/process-manager/spawners/CodexAppServerSpawner', () => ({
	CodexAppServerSpawner: class {
		spawn(config: ProcessConfig): SpawnResult {
			captured.codex.push(config);
			return SPAWN_RESULT;
		}
	},
}));
vi.mock('../../../main/utils/logger', () => ({
	logger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: (...args: unknown[]) => captured.warns.push(args),
		error: vi.fn(),
	},
}));

import { ProcessManager, localTuiLaunchOf } from '../../../main/process-manager/ProcessManager';
import {
	sendSteeringRequest,
	steeringSocketPathFor,
} from '../../../main/process-manager/steering-client';
import {
	STEERING_SOCKET_ENV_VAR,
	STEERING_TOKEN_ENV_VAR,
	type SteeringResultFrame,
} from '../../../shared/chatSteering';
import {
	planSteeringChannel,
	startSteeringServer,
	steeringRunOf,
} from '../../../maestro-p/steering-server';
import {
	CLAUDE_BYPASS_FLAG,
	digestFileSha256,
	readTuiHandshakeEnv,
	readTuiHandshakeKey,
	TUI_HANDSHAKE_ENV_VAR,
	tuiHandshakeKeyPath,
} from '../../../shared/maestro-lib/managed/tui-handshake';
import { withPermissionBypass } from '../../../maestro-p/open-tool-calls';
import { TuiAdmissionError, TuiDriver, type PtySpawn } from '../../../maestro-p/tui-driver';
import { fakeSpawnPort } from '../../helpers/managedSpawnPort';

const MAESTRO_P = '/app/resources/maestro-p.js';
const HOST_ARGS = [
	'-p',
	'--output-format',
	'stream-json',
	'--verbose',
	'--model=opus',
	'--',
	'fix it',
];
const HEX64 = /^[0-9a-f]{64}$/;

let dataDir: string;
let binDir: string;
let binPath: string;
const opened: Array<{ close: () => void }> = [];

beforeEach(() => {
	dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tui-launch-data-'));
	binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tui-launch-bin-'));
	binPath = path.join(binDir, 'claude');
	fs.writeFileSync(binPath, '#!/bin/sh\necho claude\n');
	captured.child.length = 0;
	captured.pty.length = 0;
	captured.codex.length = 0;
	captured.warns.length = 0;
	captured.processes?.clear();
});

afterEach(() => {
	while (opened.length) opened.pop()!.close();
	fs.rmSync(dataDir, { recursive: true, force: true });
	fs.rmSync(binDir, { recursive: true, force: true });
});

let nextId = 0;
/** The desktop's maestro-p launch as the handler hands it to the sink. */
function tuiTurn(overrides: Partial<ProcessConfig> = {}): ProcessConfig {
	nextId += 1;
	const sessionId = `tui-launch-agent-ai-tab-${nextId}`;
	return {
		sessionId,
		toolType: 'claude-code',
		cwd: binDir,
		command: '/app/Maestro',
		args: [MAESTRO_P, ...HOST_ARGS],
		prompt: 'fix it',
		customEnvVars: {
			MAESTRO_CLAUDE_BIN: binPath,
			ELECTRON_RUN_AS_NODE: '1',
			[STEERING_SOCKET_ENV_VAR]: steeringSocketPathFor(sessionId),
		},
		permission: { requested: 'standard', ceiling: null },
		querySource: 'user',
		...overrides,
	};
}

/** What maestro-p hands the TUI for a run-mode turn built from HOST_ARGS. */
function tuiArgs(passThrough: string[]): string[] {
	return [...withPermissionBypass(passThrough), '--session-id', 'fresh-id'];
}

function fakePty(): { spawnPty: PtySpawn; calls: Array<{ file: string; args: string[] }> } {
	const calls: Array<{ file: string; args: string[] }> = [];
	const spawnPty: PtySpawn = (file, args) => {
		calls.push({ file, args });
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

async function admitAndSpawn(manager: ProcessManager, turn: ProcessConfig) {
	const admitted = await manager.admitSpawn(turn, { peer: 'in-process' });
	if (admitted.state !== 'admitted') throw new Error(admitted.state);
	const result = manager.spawn({ ...turn, admission: admitted.admission });
	return { turn, admission: admitted.admission, result };
}

/** A managed host: one authority port for the manager's lifetime, keyed at the data dir. */
function managedManager(options: { userDataDir?: string | null } = {}): ProcessManager {
	const port = fakeSpawnPort();
	const userDataDir = options.userDataDir === undefined ? dataDir : options.userDataDir;
	return new ProcessManager(undefined, {
		spawnAuthority: () => port,
		...(userDataDir ? { userDataDir } : {}),
	});
}

function envOf(config: ProcessConfig | undefined): Record<string, string> {
	return config?.customEnvVars ?? {};
}

async function waitForServing(socketPath: string): Promise<void> {
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

/** Serve the channel as maestro-p does: planned from the env the sink stamped. */
async function serveAsMaestroP(env: Record<string, string>) {
	const read = readTuiHandshakeEnv(env, {
		readKey: () => (env.MAESTRO_USER_DATA ? readTuiHandshakeKey(env.MAESTRO_USER_DATA) : null),
	});
	const plan = planSteeringChannel(env, steeringRunOf(read));
	if (plan.kind !== 'open') throw new Error(`channel ${plan.kind}`);
	const onSteer = vi.fn(
		async (id: string): Promise<SteeringResultFrame> => ({
			type: 'steering',
			id,
			verdict: 'delivered',
		})
	);
	const warn = vi.fn();
	const server = startSteeringServer({
		socketPath: plan.socketPath,
		admission: plan.admission,
		onSteer,
		warn,
	});
	if (!server) throw new Error('server not started');
	opened.push(server);
	await waitForServing(plan.socketPath);
	return { plan, onSteer, warn, read };
}

/** A frame built by hand, bypassing the record `steer()` reads. */
function rawFrame(
	socketPath: string,
	frame: { id: string; text: string; token?: string; run?: { leaseId: string; attemptId: string } }
): Promise<SteeringResultFrame> {
	return sendSteeringRequest({
		processKey: 'raw',
		socketPath,
		text: frame.text,
		id: frame.id,
		...(frame.token ? { token: frame.token } : {}),
		...(frame.run ? { run: frame.run } : {}),
		timeoutMs: 2_000,
	});
}

describe('localTuiLaunchOf', () => {
	it('recognises the desktop maestro-p launch and an agent whose Path is maestro-p', () => {
		expect(localTuiLaunchOf(tuiTurn())).toEqual({ claudeBinPath: binPath, args: HOST_ARGS });
		expect(
			localTuiLaunchOf(tuiTurn({ command: '/opt/maestro-p', args: HOST_ARGS, customEnvVars: {} }))
		).toEqual({ claudeBinPath: null, args: HOST_ARGS });
	});

	it('is null for an SSH launch, a Codex turn, and a bare claude command', () => {
		expect(localTuiLaunchOf(tuiTurn({ sshRemoteId: 'remote-1' }))).toBeNull();
		expect(localTuiLaunchOf(tuiTurn({ toolType: 'codex' }))).toBeNull();
		expect(
			localTuiLaunchOf(tuiTurn({ command: '/usr/local/bin/claude', args: HOST_ARGS }))
		).toBeNull();
	});
});

describe('the managed sink stamps the handshake', () => {
	it('stamps a handshake the TUI verifies against the key at the data directory, and spawns through it', async () => {
		const manager = managedManager();
		const turn = tuiTurn({ permission: { requested: 'full', ceiling: 'full' } });
		const spawned = await admitAndSpawn(manager, turn);
		expect(spawned.result).toEqual(SPAWN_RESULT);
		expect(captured.child).toHaveLength(1);
		const env = envOf(captured.child[0]);
		expect(env.MAESTRO_USER_DATA).toBe(dataDir);
		expect(env.MAESTRO_CLAUDE_BIN).toBe(binPath);
		expect(env[STEERING_SOCKET_ENV_VAR]).toBe(steeringSocketPathFor(turn.sessionId));
		expect(env[TUI_HANDSHAKE_ENV_VAR]).toBeTruthy();
		const key = readTuiHandshakeKey(dataDir);
		expect(key).toMatch(HEX64);
		expect(fs.statSync(tuiHandshakeKeyPath(dataDir)).mode & 0o777).toBe(0o600);
		// The request the lease digests is unchanged: the stamp is the spawner's env.
		expect(turn.customEnvVars?.[TUI_HANDSHAKE_ENV_VAR]).toBeUndefined();
		expect(turn.customEnvVars?.MAESTRO_USER_DATA).toBeUndefined();

		// What the TUI does with it: read against the key where the host minted it.
		const read = readTuiHandshakeEnv(env, {
			readKey: () => readTuiHandshakeKey(env.MAESTRO_USER_DATA),
		});
		expect(read).toMatchObject({
			status: 'ok',
			payload: {
				run: {
					leaseId: spawned.admission.leaseId,
					authorityId: spawned.admission.authorityId,
					attemptId: spawned.admission.attemptId,
					requestId: spawned.admission.requestId,
					runId: null,
					policyRevision: spawned.admission.policyRevision,
				},
				binary: { path: binPath, digest: digestFileSha256(binPath) },
				permissionMode: 'full',
			},
		});
		if (read.status !== 'ok') throw new Error(read.status);
		expect(read.payload.allowedFlags).toContain(CLAUDE_BYPASS_FLAG);

		const { spawnPty, calls } = fakePty();
		const driver = new TuiDriver({
			binPath: env.MAESTRO_CLAUDE_BIN,
			args: tuiArgs(['--model=opus']),
			cwd: binDir,
			env: {},
			spawnPty,
			admission: read,
		});
		await driver.start();
		expect(calls).toEqual([{ file: binPath, args: tuiArgs(['--model=opus']) }]);
		driver.kill('SIGKILL');

		// The same turn with a swapped MAESTRO_CLAUDE_BIN: refused before spawn.
		const swapped = path.join(binDir, 'evil-claude');
		fs.copyFileSync(binPath, swapped);
		const tampered = new TuiDriver({
			binPath: swapped,
			args: tuiArgs(['--model=opus']),
			cwd: binDir,
			env: {},
			spawnPty,
			admission: read,
		});
		await expect(tampered.start()).rejects.toBeInstanceOf(TuiAdmissionError);
		await expect(tampered.start()).rejects.toMatchObject({ code: 'binary-path' });
		expect(calls).toHaveLength(1);
		// And the approved path with replaced bytes.
		fs.writeFileSync(binPath, '#!/bin/sh\necho evil\n');
		const replaced = new TuiDriver({
			binPath,
			args: tuiArgs(['--model=opus']),
			cwd: binDir,
			env: {},
			spawnPty,
			admission: read,
		});
		await expect(replaced.start()).rejects.toMatchObject({ code: 'binary-digest' });
		expect(calls).toHaveLength(1);
	});

	it('carries the plan ceiling and the second turn reuses the key', async () => {
		const manager = managedManager();
		const first = await admitAndSpawn(
			manager,
			tuiTurn({ permission: { requested: 'standard', ceiling: 'standard' } })
		);
		expect(first.result).toEqual(SPAWN_RESULT);
		const key = readTuiHandshakeKey(dataDir);
		expect(key).toMatch(HEX64);
		const second = await admitAndSpawn(
			manager,
			tuiTurn({ permission: { requested: 'readonly', ceiling: 'standard' } })
		);
		expect(second.result).toEqual(SPAWN_RESULT);
		expect(readTuiHandshakeKey(dataDir)).toBe(key);
		expect(captured.child).toHaveLength(2);
		for (const config of captured.child) {
			const read = readTuiHandshakeEnv(envOf(config), { readKey: () => key });
			expect(read).toMatchObject({ status: 'ok', payload: { permissionMode: 'standard' } });
			if (read.status === 'ok') expect(read.payload.allowedFlags).not.toContain(CLAUDE_BYPASS_FLAG);
		}
		const [a, b] = captured.child.map((config) => envOf(config)[TUI_HANDSHAKE_ENV_VAR]);
		expect(a).not.toBe(b);
	});

	it('stamps nothing on a standalone host, on an API-mode claude turn, or on a managed non-TUI turn', async () => {
		const standalone = new ProcessManager(undefined, { userDataDir: dataDir });
		expect(standalone.spawn(tuiTurn())).toEqual(SPAWN_RESULT);
		expect(envOf(captured.child[0])[TUI_HANDSHAKE_ENV_VAR]).toBeUndefined();
		expect(envOf(captured.child[0]).MAESTRO_USER_DATA).toBeUndefined();
		expect(fs.existsSync(tuiHandshakeKeyPath(dataDir))).toBe(false);

		const manager = managedManager();
		const api = await admitAndSpawn(
			manager,
			tuiTurn({ command: binPath, args: HOST_ARGS, customEnvVars: { CLAUDE_CONFIG_DIR: '/x' } })
		);
		expect(api.result).toEqual(SPAWN_RESULT);
		expect(envOf(captured.child[1])[TUI_HANDSHAKE_ENV_VAR]).toBeUndefined();
		expect(envOf(captured.child[1]).MAESTRO_USER_DATA).toBeUndefined();

		const codex = await admitAndSpawn(
			manager,
			tuiTurn({
				toolType: 'codex',
				command: 'codex',
				args: ['exec', '--sandbox', 'read-only'],
				customEnvVars: {},
				permission: { requested: 'readonly', ceiling: 'readonly' },
			})
		);
		expect(codex.result).toEqual(SPAWN_RESULT);
		for (const config of [...captured.child.slice(2), ...captured.codex]) {
			expect(envOf(config)[TUI_HANDSHAKE_ENV_VAR]).toBeUndefined();
			expect(envOf(config).MAESTRO_USER_DATA).toBeUndefined();
			expect(envOf(config)[STEERING_TOKEN_ENV_VAR]).toBeUndefined();
		}
		expect(captured.child.length + captured.codex.length).toBe(3);
		expect(fs.existsSync(tuiHandshakeKeyPath(dataDir))).toBe(false);
	});

	it('refuses by name, spawns nothing and releases the lease when no handshake can be built', async () => {
		const errors: unknown[] = [];
		// No data directory: nowhere to keep a key.
		const bare = managedManager({ userDataDir: null });
		bare.on('agent-error', (_id: string, error: unknown) => errors.push(error));
		const noDir = await admitAndSpawn(bare, tuiTurn());
		expect(noDir.result).toMatchObject({
			success: false,
			pid: -1,
			error: expect.stringContaining('no data directory'),
			managed: { state: 'denied', code: 'policy-denied' },
		});
		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatchObject({ type: 'permission_denied', recoverable: false });
		expect(captured.child).toHaveLength(0);
		expect(captured.processes!.has(noDir.turn.sessionId)).toBe(false);
		// The lease was released: the same admission is refused at the sink now.
		expect(bare.spawn({ ...noDir.turn, admission: noDir.admission })).toMatchObject({
			success: false,
			managed: { state: 'denied', code: 'lease-invalid' },
		});
		expect(captured.child).toHaveLength(0);

		const manager = managedManager();
		manager.on('agent-error', (_id: string, error: unknown) => errors.push(error));
		// A relative MAESTRO_CLAUDE_BIN: no binary the host digested.
		const relative = await admitAndSpawn(
			manager,
			tuiTurn({ customEnvVars: { MAESTRO_CLAUDE_BIN: 'claude' } })
		);
		expect(relative.result).toMatchObject({
			success: false,
			error: expect.stringContaining('not an absolute path'),
			managed: { state: 'denied', code: 'policy-denied' },
		});
		// An agent whose Path is maestro-p itself: no MAESTRO_CLAUDE_BIN at all.
		const direct = await admitAndSpawn(
			manager,
			tuiTurn({ command: '/opt/maestro-p', args: HOST_ARGS, customEnvVars: {} })
		);
		expect(direct.result).toMatchObject({
			success: false,
			error: expect.stringContaining('names no MAESTRO_CLAUDE_BIN'),
			managed: { state: 'denied', code: 'policy-denied' },
		});
		// A key file that is not a key: never overwritten, the spawn refused.
		fs.writeFileSync(tuiHandshakeKeyPath(dataDir), 'junk');
		const junk = await admitAndSpawn(manager, tuiTurn());
		expect(junk.result).toMatchObject({
			success: false,
			error: expect.stringContaining('is not a TUI handshake key'),
			managed: { state: 'denied', code: 'policy-denied' },
		});
		expect(fs.readFileSync(tuiHandshakeKeyPath(dataDir), 'utf8')).toBe('junk');
		// Four handshake refusals are permission denials; the resubmitted admission
		// (second) was refused for its released lease, which is not a permission call.
		expect(errors.map((e) => (e as { type: string }).type)).toEqual([
			'permission_denied',
			'unknown',
			'permission_denied',
			'permission_denied',
			'permission_denied',
		]);
		expect(captured.child).toHaveLength(0);
		expect(captured.pty).toHaveLength(0);
		expect(captured.codex).toHaveLength(0);
		for (const refused of [relative, direct, junk]) {
			expect(manager.spawn({ ...refused.turn, admission: refused.admission })).toMatchObject({
				success: false,
				managed: { state: 'denied', code: 'lease-invalid' },
			});
		}
		expect(captured.child).toHaveLength(0);
	});
});

describe('the steering token on a standalone host', () => {
	it('mints a fresh token per local maestro-p launch, stamps it on the spawner env only, and steers with it', async () => {
		const manager = new ProcessManager(undefined, { userDataDir: dataDir });
		const turn = tuiTurn();
		expect(manager.spawn(turn)).toEqual(SPAWN_RESULT);
		const env = envOf(captured.child[0]);
		expect(env[STEERING_TOKEN_ENV_VAR]).toMatch(HEX64);
		expect(env[TUI_HANDSHAKE_ENV_VAR]).toBeUndefined();
		expect(turn.customEnvVars?.[STEERING_TOKEN_ENV_VAR]).toBeUndefined();
		const record = captured.processes!.get(turn.sessionId)!;
		expect(record.steering).toEqual({ token: env[STEERING_TOKEN_ENV_VAR], run: null });

		const second = tuiTurn();
		expect(manager.spawn(second)).toEqual(SPAWN_RESULT);
		const secondToken = envOf(captured.child[1])[STEERING_TOKEN_ENV_VAR];
		expect(secondToken).toMatch(HEX64);
		expect(secondToken).not.toBe(env[STEERING_TOKEN_ENV_VAR]);
		expect(captured.processes!.get(second.sessionId)!.steering).toEqual({
			token: secondToken,
			run: null,
		});

		// maestro-p plans an unmanaged channel pinned to the token.
		const { plan, onSteer, warn } = await serveAsMaestroP(env);
		expect(plan).toMatchObject({ admission: { token: env[STEERING_TOKEN_ENV_VAR], run: null } });
		const result = await manager.steer(turn.sessionId, 'use tabs');
		expect(result).toMatchObject({ verdict: 'delivered' });
		expect(onSteer).toHaveBeenCalledExactlyOnceWith(result.id, 'use tabs');
		expect(warn).not.toHaveBeenCalled();

		// The same socket without the token, or with a stale one: refused, nothing typed.
		const bare = await rawFrame(plan.socketPath, { id: 'bare', text: 'nope' });
		expect(bare).toMatchObject({ verdict: 'refused', refusal: 'not-authorized' });
		const stale = await rawFrame(plan.socketPath, {
			id: 'stale',
			text: 'nope',
			token: 'f'.repeat(64),
		});
		expect(stale).toMatchObject({ verdict: 'refused', refusal: 'not-authorized' });
		expect(onSteer).toHaveBeenCalledOnce();
	});

	it('stamps no token and remembers none for a claude --print launch or a Codex launch', async () => {
		const manager = new ProcessManager(undefined, { userDataDir: dataDir });
		const api = tuiTurn({ command: binPath, args: HOST_ARGS });
		expect(manager.spawn(api)).toEqual(SPAWN_RESULT);
		expect(envOf(captured.child[0])[STEERING_TOKEN_ENV_VAR]).toBeUndefined();
		expect(captured.processes!.get(api.sessionId)!.steering).toBeUndefined();
		expect(captured.processes!.get(api.sessionId)).not.toHaveProperty('steering');
		const codex = tuiTurn({
			toolType: 'codex',
			command: 'codex',
			args: ['exec'],
			customEnvVars: {},
		});
		expect(manager.spawn(codex)).toEqual(SPAWN_RESULT);
		const codexConfig = captured.child[1] ?? captured.codex[0];
		expect(envOf(codexConfig)).toEqual({
			MAESTRO_COWORKING_SESSION_ID: expect.any(String),
			MAESTRO_COWORKING_SOCKET_OVERRIDE: '/tmp/test-bridge.sock',
		});
		expect(captured.processes!.get(codex.sessionId)?.steering).toBeUndefined();
	});
});

describe('the steering token on a managed host', () => {
	it('remembers the lease and attempt the handshake names, and steer() carries them', async () => {
		const manager = managedManager();
		const spawned = await admitAndSpawn(
			manager,
			tuiTurn({ permission: { requested: 'standard', ceiling: 'standard' } })
		);
		expect(spawned.result).toEqual(SPAWN_RESULT);
		const env = envOf(captured.child[0]);
		expect(env[STEERING_TOKEN_ENV_VAR]).toMatch(HEX64);
		expect(env[TUI_HANDSHAKE_ENV_VAR]).toBeTruthy();
		expect(spawned.turn.customEnvVars?.[STEERING_TOKEN_ENV_VAR]).toBeUndefined();
		const record = captured.processes!.get(spawned.turn.sessionId)!;
		expect(record.steering).toEqual({
			token: env[STEERING_TOKEN_ENV_VAR],
			run: { leaseId: spawned.admission.leaseId, attemptId: spawned.admission.attemptId },
		});

		const { plan, onSteer, read } = await serveAsMaestroP(env);
		expect(read.status).toBe('ok');
		if (read.status !== 'ok') throw new Error(read.status);
		// The record's identity is the handshake's: the TUI's two checks agree.
		expect(record.steering!.run).toEqual({
			leaseId: read.payload.run.leaseId,
			attemptId: read.payload.run.attemptId,
		});
		expect(plan).toMatchObject({
			admission: {
				token: env[STEERING_TOKEN_ENV_VAR],
				run: { leaseId: spawned.admission.leaseId, attemptId: spawned.admission.attemptId },
			},
		});
		const result = await manager.steer(spawned.turn.sessionId, 'use tabs');
		expect(result).toMatchObject({ verdict: 'delivered' });
		expect(onSteer).toHaveBeenCalledExactlyOnceWith(result.id, 'use tabs');
		expect(captured.warns.filter((w) => String(w[0]).includes('not authorized'))).toHaveLength(0);

		// No token, the token alone, and another attempt's identity: refused.
		const token = env[STEERING_TOKEN_ENV_VAR];
		expect(await rawFrame(plan.socketPath, { id: 'no-token', text: 'x' })).toMatchObject({
			verdict: 'refused',
			refusal: 'not-authorized',
		});
		expect(
			await rawFrame(plan.socketPath, { id: 'stale', text: 'x', token: 'f'.repeat(64) })
		).toMatchObject({ verdict: 'refused', refusal: 'not-authorized' });
		expect(await rawFrame(plan.socketPath, { id: 'no-run', text: 'x', token })).toMatchObject({
			verdict: 'refused',
			refusal: 'not-authorized',
		});
		expect(
			await rawFrame(plan.socketPath, {
				id: 'other-run',
				text: 'x',
				token,
				run: { leaseId: spawned.admission.leaseId, attemptId: 'another-attempt' },
			})
		).toMatchObject({ verdict: 'refused', refusal: 'not-authorized' });
		expect(onSteer).toHaveBeenCalledOnce();
	});

	it('answers not-authorized from a channel holding other credentials, and the sink logs it', async () => {
		const manager = new ProcessManager(undefined, { userDataDir: dataDir });
		const turn = tuiTurn();
		expect(manager.spawn(turn)).toEqual(SPAWN_RESULT);
		const env = {
			...envOf(captured.child[0]),
			[STEERING_TOKEN_ENV_VAR]: 'e'.repeat(64),
		};
		const { onSteer } = await serveAsMaestroP(env);
		const result = await manager.steer(turn.sessionId, 'x');
		expect(result).toMatchObject({ verdict: 'refused', refusal: 'not-authorized' });
		expect(onSteer).not.toHaveBeenCalled();
		const warned = captured.warns.find((w) => String(w[0]).includes('not authorized'));
		expect(warned).toBeDefined();
		expect(warned![2]).toMatchObject({
			sessionId: turn.sessionId,
			steerId: result.id,
			hasToken: true,
			hasRun: false,
		});
	});

	it('mints nothing when the handshake refuses the spawn', async () => {
		const bare = managedManager({ userDataDir: null });
		const refused = await admitAndSpawn(bare, tuiTurn());
		expect(refused.result).toMatchObject({
			success: false,
			managed: { state: 'denied', code: 'policy-denied' },
		});
		expect(captured.child).toHaveLength(0);
		expect(captured.processes!.has(refused.turn.sessionId)).toBe(false);
		const steer = await bare.steer(refused.turn.sessionId, 'x');
		expect(steer).toMatchObject({ verdict: 'refused', refusal: 'not-running' });
	});
});
