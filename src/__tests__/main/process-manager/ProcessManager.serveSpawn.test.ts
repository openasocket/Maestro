/**
 * The `spawn` event on the OpenCode serve transport.
 *
 * That transport reports its `exit` through the handlers every other process
 * uses, so anything that pairs a start with an end (the agent-run capture, the
 * dispatch callbacks) has to be told of the start too. This pins that the
 * process manager emits `spawn` for it exactly as it does for a CLI process:
 * once, with the config it was given, after the spawner has the process.
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('os', async (importOriginal) => ({
	...(await importOriginal<typeof import('os')>()),
}));

vi.mock('fs', async (importOriginal) => {
	const actual = await importOriginal<typeof import('fs')>();
	const writes = {
		openSync: vi.fn(() => {
			throw new Error('Admission tests must not open prompt files.');
		}),
		writeFileSync: vi.fn(() => {
			throw new Error('Admission tests must not write prompt files.');
		}),
	};
	return { ...actual, ...writes, default: { ...actual, ...writes } };
});

// Admission tests stop at the fake spawners, before any artifact I/O or child.
vi.mock('../../../shared/maestro-lib/run/start-turn', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../shared/maestro-lib/run/start-turn')>()),
	startTurn: vi.fn(() => {
		throw new Error('Admission tests must not reach artifact materialization or process launch.');
	}),
}));

vi.mock('node-pty', () => ({
	spawn: vi.fn(),
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../main/coworking/coworking-socket-path', () => ({
	getBridgeSocketPath: () => '/tmp/maestro-test-coworking.sock',
}));

import { ProcessManager } from '../../../main/process-manager';
import {
	buildSpawnRequestSnapshot,
	dispatchedChildContext,
} from '../../../main/process-manager/ProcessManager';
import {
	buildDispatchSnapshot,
	dispatchSnapshotDigest,
} from '../../../shared/maestro-lib/managed/authority';
import { startTurn } from '../../../shared/maestro-lib/run/start-turn';
import { logger } from '../../../main/utils/logger';
import { COWORKING_RUN_ADMISSION_ENV_VAR } from '../../../main/coworking/coworking-types';
import { MANAGED_CONTRACT_VERSION } from '../../../shared/maestro-lib/managed/types';
import type { SshRemoteEndpointIdentity } from '../../../shared/maestro-lib/launch/ssh-remote-resolver';
import type { ManagedProcess, ProcessConfig } from '../../../main/process-manager/types';
import {
	buildServerKey,
	OPENCODE_MANAGED_PERMISSION_CONFIG,
	opencodeServerPermissionConfig,
} from '../../../main/opencode-server/OpencodeServerManager';
import {
	managedOpencodeRefusal,
	opencodeManagedScope,
	opencodePermissionEffect,
} from '../../../main/process-manager/spawners/OpencodeServerSpawner';
import { fakeAdmission, fakeSpawnPort } from '../../helpers/managedSpawnPort';
import { createProcessSpawnAuthority } from '../../../main/enterprise/spawn-authority';
import {
	PAIRED_DEVICE_USER_ID_PREFIX,
	PAIRED_DEVICE_USERNAME,
	getActingTransport,
	runAsClient,
	transportSpawnActor,
} from '../../../main/web-server/auth/transport-actor';
import {
	autoRunRunIdentity,
	autoRunTraceId,
	autoRunWorkflowRef,
	newAutoRunTurnRequest,
	nextAutoRunAttempt,
	type AutoRunWorkflowIdentity,
} from '../../../shared/maestro-lib/autorun/attribution';
import {
	delegationContextOf,
	type ManagedDelegationContext,
} from '../../../shared/maestro-lib/managed/delegation';
import type { WorkflowFenceAnswer } from '../../../shared/maestro-lib/managed/workflows';

const SERVE_RESULT = { pid: -1, success: true };

function config(overrides: Partial<ProcessConfig> = {}): ProcessConfig {
	return {
		sessionId: 'agent-1-ai-tab-1',
		toolType: 'opencode',
		cwd: os.tmpdir(),
		command: 'opencode',
		args: [],
		prompt: 'List the files.',
		...overrides,
	} as ProcessConfig;
}

/** A manager whose serve transport is on, with the two spawners stood in for. */
function createManager(): {
	manager: ProcessManager;
	order: string[];
	serve: ReturnType<typeof vi.fn>;
	cli: ReturnType<typeof vi.fn>;
} {
	const manager = new ProcessManager(() => true);
	const order: string[] = [];
	const serve = vi.fn(() => {
		order.push('serve spawner');
		return SERVE_RESULT;
	});
	const cli = vi.fn(() => {
		order.push('cli spawner');
		return { pid: 4242, success: true };
	});
	const internals = manager as unknown as {
		opencodeServerSpawner: { spawn: typeof serve };
		childProcessSpawner: { spawn: typeof cli };
	};
	internals.opencodeServerSpawner = { spawn: serve };
	internals.childProcessSpawner = { spawn: cli };
	manager.on('spawn', () => order.push('spawn event'));
	return { manager, order, serve, cli };
}

describe('ProcessManager spawn event on the OpenCode serve transport', () => {
	it('emits spawn once, with the config, after the serve spawner has the process', () => {
		const { manager, order, serve, cli } = createManager();
		const heard: ProcessConfig[] = [];
		manager.on('spawn', (spawned: ProcessConfig) => heard.push(spawned));
		const spawned = config();

		expect(manager.spawn(spawned)).toBe(SERVE_RESULT);

		expect(serve).toHaveBeenCalledWith(spawned);
		expect(cli).not.toHaveBeenCalled();
		expect(heard).toEqual([spawned]);
		expect(heard[0]).toBe(spawned);
		expect(order).toEqual(['serve spawner', 'spawn event']);
	});

	it('does not let a listener that throws break the spawn', () => {
		const { manager } = createManager();
		manager.on('spawn', () => {
			throw new Error('A capture listener failed.');
		});

		expect(manager.spawn(config())).toBe(SERVE_RESULT);
	});

	it('emits spawn once on the CLI path too, for a turn the serve transport does not take', () => {
		const { manager, order, serve } = createManager();

		// An image keeps an OpenCode turn on the CLI path.
		manager.spawn(config({ images: ['data:image/png;base64,AAAA'] }));

		expect(serve).not.toHaveBeenCalled();
		expect(order).toEqual(['cli spawner', 'spawn event']);
	});
});

/**
 * Managed admission at the process manager's sink (MRC-06-01, MRC-06-08):
 * on a managed host nothing spawns without an admission this manager minted,
 * still live, for the digest of the exact request; the lease is bound to the
 * spawner's result, released by the exit, and a revocation kills. The lease
 * authority is real; only its policy answer is a table.
 */
describe('ProcessManager managed admission at the sink', () => {
	function managedManager(port = fakeSpawnPort()) {
		const manager = new ProcessManager(() => true, { spawnAuthority: () => port });
		const serve = vi.fn(() => SERVE_RESULT);
		const cli = vi.fn((_config: ProcessConfig) => ({ pid: 4242, success: true }));
		const internals = manager as unknown as {
			opencodeServerSpawner: { spawn: typeof serve };
			childProcessSpawner: { spawn: typeof cli };
		};
		internals.opencodeServerSpawner = { spawn: serve };
		internals.childProcessSpawner = { spawn: cli };
		const errors: unknown[] = [];
		manager.on('agent-error', (_id: string, error: unknown) => errors.push(error));
		return { manager, port, serve, cli, errors };
	}

	it('refuses a managed spawn that carries no admission, before any branch', () => {
		const { manager, serve, cli, errors } = managedManager();
		const result = manager.spawn(config());

		expect(result).toMatchObject({
			success: false,
			pid: -1,
			managed: { state: 'denied', code: 'lease-invalid' },
		});
		expect(serve).not.toHaveBeenCalled();
		expect(cli).not.toHaveBeenCalled();
		expect(errors).toHaveLength(1);
		expect((errors[0] as { message: string }).message).toContain('carries no admission');
	});

	it('refuses a look-alike admission this manager did not mint', () => {
		const { manager, serve } = managedManager();
		expect(manager.spawn(config({ admission: fakeAdmission() }))).toMatchObject({
			success: false,
			managed: { state: 'denied', code: 'lease-invalid' },
		});
		expect(serve).not.toHaveBeenCalled();
	});

	it('admits the exact request, refuses a changed one, binds the lease and releases it on exit', async () => {
		const { manager, port, serve } = managedManager();
		const request = config();
		const admitted = await manager.admitSpawn(request, { peer: 'in-process' });
		expect(admitted.state).toBe('admitted');
		if (admitted.state !== 'admitted') return;
		expect(port.asked).toHaveLength(1);
		expect(port.asked[0].snapshot).toMatchObject({
			provider: 'opencode',
			operation: 'start',
			executable: 'opencode',
			target: { kind: 'local' },
		});
		expect(port.asked[0].context.actor).toEqual({ kind: 'human', id: 'ada' });

		// A different prompt is a different request: the digest does not match.
		expect(
			manager.spawn({ ...request, prompt: 'Delete everything.', admission: admitted.admission })
		).toMatchObject({ success: false, managed: { state: 'denied', code: 'lease-invalid' } });
		expect(serve).not.toHaveBeenCalled();

		// The admitted request runs on the serve transport under the lease.
		expect(manager.spawn({ ...request, admission: admitted.admission })).toBe(SERVE_RESULT);
		expect(serve).toHaveBeenCalledTimes(1);
		const [lease] = port.authority.live();
		expect(lease.state()).toBe('bound');
		expect(manager.admissionOf(request.sessionId)).toBe(admitted.admission);
		expect(manager.admissionLive(request.sessionId)).toEqual({ ok: true });

		// The lease is spent: the same admission cannot start a second process.
		expect(manager.spawn({ ...request, admission: admitted.admission })).toMatchObject({
			success: false,
			managed: { state: 'denied', code: 'lease-invalid' },
		});

		manager.emit('exit', request.sessionId, 0);
		expect(port.authority.live()).toHaveLength(0);
		expect(lease.ended()).toMatchObject({ state: 'released', release: { outcome: 'exited' } });
		expect(manager.admissionOf(request.sessionId)).toBeNull();
	});

	it('returns a policy denial as a decision and starts nothing', async () => {
		const port = fakeSpawnPort({
			decide: () => ({ decision: 'deny', reason: 'opencode is not allowed', policyRevision: 1 }),
		});
		const { manager, serve } = managedManager(port);
		const outcome = await manager.admitSpawn(config(), { peer: 'in-process' });
		expect(outcome).toEqual({
			state: 'denied',
			code: 'policy-denied',
			message: 'opencode is not allowed',
		});
		expect(await manager.spawnAdmitted(config(), { peer: 'in-process' })).toMatchObject({
			success: false,
			managed: { state: 'denied', code: 'policy-denied' },
		});
		expect(serve).not.toHaveBeenCalled();
	});

	it('refuses an actor the verifier does not accept, before the authority is asked', async () => {
		const port = fakeSpawnPort({ accept: () => ['the actor is not registered here'] });
		const { manager } = managedManager(port);
		const outcome = await manager.admitSpawn(config(), { peer: 'web-login', username: 'mallory' });
		expect(outcome).toMatchObject({ state: 'denied', code: 'unauthenticated' });
		expect(port.asked).toHaveLength(0);
	});

	it('kills the process when the authority revokes its lease', async () => {
		const { manager, port } = managedManager();
		const kill = vi.spyOn(manager, 'kill').mockReturnValue(true);
		const request = config();
		const admitted = await manager.admitSpawn(request, { peer: 'in-process' });
		if (admitted.state !== 'admitted') throw new Error(admitted.state);
		manager.spawn({ ...request, admission: admitted.admission });

		expect(port.authority.revokeAll('policy changed')).toBe(1);
		expect(kill).toHaveBeenCalledWith(request.sessionId);
		expect(manager.admissionLive(request.sessionId)).toMatchObject({ ok: false });
	});

	it('releases the lease as a spawn failure when the spawner fails', async () => {
		const { manager, port, serve } = managedManager();
		serve.mockReturnValueOnce({ pid: -1, success: false, error: 'no server' });
		const request = config();
		const admitted = await manager.admitSpawn(request, { peer: 'in-process' });
		if (admitted.state !== 'admitted') throw new Error(admitted.state);
		expect(manager.spawn({ ...request, admission: admitted.admission }).success).toBe(false);
		expect(port.authority.live()).toHaveLength(0);
	});

	it('spawns as before on a standalone host and never asks the authority', async () => {
		const port = fakeSpawnPort({ standing: 'standalone' });
		const { manager, serve } = managedManager(port);
		expect(await manager.admitSpawn(config(), { peer: 'in-process' })).toEqual({
			state: 'standalone',
		});
		expect(manager.spawn(config())).toBe(SERVE_RESULT);
		expect(serve).toHaveBeenCalledTimes(1);
		expect(port.asked).toHaveLength(0);
	});

	describe('private prompt artifact admission (GT1-02-10E0T)', () => {
		const artifact: NonNullable<ProcessConfig['promptArtifact']> = {
			owner: 'local',
			path: path.join(os.tmpdir(), 'maestro-prompt-00000000-0000-4000-8000-000000000001.json'),
			content: JSON.stringify([{ type: 'text', text: 'PRIVATE prompt: 雪\nsecond line' }]),
			encoding: 'utf8',
			mode: 0o600,
			flag: 'wx',
			cleanup: 'turn',
		};

		beforeEach(() => {
			vi.clearAllMocks();
			// Exercise the real tilde-copy path without reading the operator's home.
			vi.spyOn(os, 'homedir').mockReturnValue(os.tmpdir());
		});
		afterEach(() => {
			vi.restoreAllMocks();
			expect(startTurn).not.toHaveBeenCalled();
			expect(fs.openSync).not.toHaveBeenCalled();
			expect(fs.writeFileSync).not.toHaveBeenCalled();
		});

		describe.each(['local', 'remote'] as const)(
			'%s pending-admission cancellation (GT1-02-10G1T)',
			(owner) => {
				let request: ProcessConfig;
				let controller: AbortController;
				beforeEach(() => {
					controller = new AbortController();
					request = config({
						toolType: 'grok',
						command: owner === 'remote' ? 'ssh' : 'grok',
						prompt: undefined,
						promptArtifact: {
							...artifact,
							owner,
							...(owner === 'remote'
								? { path: '/var/tmp/private-prompt.json', sshRemoteId: 'remote-selected' }
								: {}),
						},
						sshRemoteId: owner === 'remote' ? 'remote-selected' : undefined,
						sshStdinScript: owner === 'remote' ? 'PRIVATE SSH script' : undefined,
					});
				});

				it.each(['standalone', 'managed'] as const)(
					'pre-abort never asks admission or starts a reader on a %s host',
					async (standing) => {
						const { manager, port, cli, serve, errors } = managedManager(
							fakeSpawnPort({ standing })
						);
						const admit = vi.spyOn(manager, 'admitSpawn');
						const capture = vi.fn();
						manager.on('spawn', capture);
						controller.abort(new Error(`PRIVATE abort ${request.promptArtifact!.path}`));
						expect(
							await manager.spawnAdmitted(
								request,
								{ peer: 'in-process' },
								{ signal: controller.signal }
							)
						).toEqual({ pid: -1, success: false, error: 'Spawn cancelled before starting.' });
						for (const sink of [admit, cli, serve, capture]) expect(sink).not.toHaveBeenCalled();
						expect(port.asked).toHaveLength(0);
						expect(port.authority.live()).toHaveLength(0);
						expect(errors).toEqual([]);
						for (const log of Object.values(logger)) expect(log).not.toHaveBeenCalled();
					}
				);

				it.each(['standalone', 'admitted', 'denied', 'unavailable', 'rejected'] as const)(
					'cancellation wins over a pending %s decision without reaching artifact I/O or SSH',
					async (decision) => {
						const port = fakeSpawnPort({
							standing: decision === 'standalone' ? 'standalone' : 'managed',
							decide: () =>
								decision === 'denied'
									? {
											decision: 'deny',
											reason: `PRIVATE denial ${request.promptArtifact!.path}`,
											policyRevision: 1,
										}
									: { decision: 'allow', policyRevision: 1 },
						});
						const { manager, cli, serve, errors } = managedManager(port);
						const capture = vi.fn();
						const kill = vi.spyOn(manager, 'kill').mockReturnValue(true);
						manager.on('spawn', capture);
						let settle!: () => void;
						const pending = new Promise<void>((resolve) => {
							settle = resolve;
						});
						let lease: ReturnType<typeof port.authority.live>[number] | undefined;
						const realAdmit = manager.admitSpawn.bind(manager);
						const admit = vi
							.spyOn(manager, 'admitSpawn')
							.mockImplementation(async (config, actor) => {
								await pending;
								if (decision === 'rejected')
									throw new Error(`PRIVATE rejection ${artifact.content}`);
								if (decision === 'unavailable')
									return {
										state: 'unavailable',
										code: 'runtime-unavailable',
										message: `PRIVATE refusal ${artifact.path}`,
									};
								const outcome = await realAdmit(config, actor);
								if (outcome.state === 'admitted') {
									[lease] = port.authority.live();
									vi.spyOn(lease, 'release');
								}
								return outcome;
							});
						const result = manager.spawnAdmitted(
							request,
							{ peer: 'in-process' },
							{ signal: controller.signal }
						);
						expect(admit).toHaveBeenCalledExactlyOnceWith(request, { peer: 'in-process' });
						expect(port.asked).toHaveLength(0);
						controller.abort(new Error(`PRIVATE abort ${artifact.content}`));
						settle();
						expect(await result).toEqual({
							pid: -1,
							success: false,
							error: 'Spawn cancelled before starting.',
						});
						for (const sink of [cli, serve, capture, kill]) expect(sink).not.toHaveBeenCalled();
						expect(errors).toEqual([]);
						expect(port.asked).toHaveLength(
							decision === 'admitted' || decision === 'denied' ? 1 : 0
						);
						expect(port.authority.live()).toHaveLength(0);
						expect(manager.admissionOf(request.sessionId)).toBeNull();
						// Later cancellation and an unrelated exit cannot release the unused lease again.
						controller.abort();
						manager.emit('exit', request.sessionId, 0);
						if (decision === 'admitted') {
							expect(lease).toBeDefined();
							expect(lease!.release).toHaveBeenCalledExactlyOnceWith({
								outcome: 'spawn-failed',
								message: 'Spawn cancelled before starting.',
							});
							expect(lease!.ended()).toMatchObject({ state: 'released' });
						}
						const disclosed = JSON.stringify([
							await result,
							errors,
							capture.mock.calls,
							port.asked,
							...Object.values(logger).map((log) => vi.mocked(log).mock.calls),
						]);
						for (const privateValue of [
							request.promptArtifact!.path,
							'PRIVATE',
							'signal',
							'reason',
						])
							expect(disclosed).not.toContain(privateValue);
					}
				);

				it.each(['standalone', 'managed'] as const)(
					'keeps a successful %s spawn private and leaves a bound reader with its existing owner',
					async (standing) => {
						const { manager, port, cli, serve } = managedManager(fakeSpawnPort({ standing }));
						const kill = vi.spyOn(manager, 'kill').mockReturnValue(true);
						const capture = vi.fn();
						manager.on('spawn', capture);
						const before = buildSpawnRequestSnapshot(request);
						expect(
							await manager.spawnAdmitted(
								request,
								{ peer: 'in-process' },
								{ signal: controller.signal }
							)
						).toEqual({ pid: 4242, success: true });
						expect(cli).toHaveBeenCalledTimes(1);
						expect(serve).not.toHaveBeenCalled();
						expect(cli.mock.calls[0][0].promptArtifact).toBe(request.promptArtifact);
						expect(cli.mock.calls[0][0]).not.toHaveProperty('signal');
						expect(capture).toHaveBeenCalledTimes(1);
						const [lease] = port.authority.live();
						if (standing === 'managed') {
							expect(lease.state()).toBe('bound');
							vi.spyOn(lease, 'release');
							expect(port.asked[0].snapshot).toEqual(before);
							expect(manager.admissionOf(request.sessionId)?.requestDigest).toBe(
								dispatchSnapshotDigest(before)
							);
						} else expect(port.asked).toEqual([]);
						controller.abort(new Error(`PRIVATE abort ${artifact.content}`));
						expect(kill).not.toHaveBeenCalled();
						if (lease) expect(lease.release).not.toHaveBeenCalled();
						expect(buildSpawnRequestSnapshot(request)).toEqual(before);
						for (const value of [request, before, capture.mock.calls[0][0]])
							expect(value).not.toHaveProperty('signal');
						for (const key of ['promptArtifact', 'prompt', 'sshStdinScript'])
							expect(capture.mock.calls[0][0]).not.toHaveProperty(key);
						const disclosed = JSON.stringify([
							capture.mock.calls,
							port.asked,
							...Object.values(logger).map((log) => vi.mocked(log).mock.calls),
						]);
						for (const privateValue of [request.promptArtifact!.path, 'PRIVATE', 'signal'])
							expect(disclosed).not.toContain(privateValue);
						manager.emit('exit', request.sessionId, 0);
						manager.emit('exit', request.sessionId, 0);
						if (lease)
							expect(lease.release).toHaveBeenCalledExactlyOnceWith({
								outcome: 'exited',
								exitCode: 0,
								signal: null,
							});
						expect(port.authority.live()).toHaveLength(0);
					}
				);
			}
		);

		it.each(['standalone', 'managed'] as const)(
			'preserves ordinary %s serve spawns with internal cancellation controls (GT1-02-10G1T)',
			async (standing) => {
				const { manager, port, serve, cli } = managedManager(fakeSpawnPort({ standing }));
				const request = config();
				const capture = vi.fn();
				manager.on('spawn', capture);
				const controller = new AbortController();
				expect(
					await manager.spawnAdmitted(
						request,
						{ peer: 'in-process' },
						{ signal: controller.signal }
					)
				).toBe(SERVE_RESULT);
				expect(serve).toHaveBeenCalledTimes(1);
				expect(cli).not.toHaveBeenCalled();
				expect(capture).toHaveBeenCalledTimes(1);
				expect(serve).toHaveBeenCalledExactlyOnceWith(capture.mock.calls[0][0]);
				expect(capture.mock.calls[0][0]).not.toHaveProperty('signal');
				expect(JSON.stringify(capture.mock.calls)).not.toContain('signal');
				expect(port.asked).toHaveLength(standing === 'managed' ? 1 : 0);
				manager.emit('exit', request.sessionId, 0);
				expect(port.authority.live()).toHaveLength(0);
			}
		);

		it.each<[string, Partial<ProcessConfig>]>([
			['terminal attach', { toolType: 'terminal', reuseTerminal: true, prompt: undefined }],
			['PTY', { toolType: 'grok', requiresPty: true, prompt: undefined }],
			['OpenCode serve', { toolType: 'opencode' }],
			['Codex app-server', { toolType: 'codex', codexTransport: 'app-server' }],
		])(
			'refuses artifact %s after admission without replacing the owner (GT1-02-10E1T)',
			async (_route, overrides) => {
				const { manager, port, cli, serve, errors } = managedManager();
				const internals = manager as unknown as {
					processes: Map<string, ManagedProcess>;
					ptySpawner: { spawn: (request: ProcessConfig) => unknown };
					codexAppServerSpawner: { spawn: (request: ProcessConfig) => unknown };
				};
				const pty = vi.spyOn(internals.ptySpawner, 'spawn').mockReturnValue({ success: true });
				const sdk = vi
					.spyOn(internals.codexAppServerSpawner, 'spawn')
					.mockReturnValue({ success: true });
				const capture = vi.fn();
				manager.on('spawn', capture);
				const request = config({ promptArtifact: artifact, ...overrides });
				const old = {
					sessionId: request.sessionId,
					pid: 73,
					isTerminal: true,
					ptyProcess: { kill: vi.fn() },
				} as unknown as ManagedProcess;
				internals.processes.set(request.sessionId, old);
				// Ordinary terminal reattachment still bypasses a new spawn/admission.
				expect(manager.spawn(config({ toolType: 'terminal', reuseTerminal: true }))).toEqual({
					pid: 73,
					success: true,
					attached: true,
				});
				expect(manager.spawn(request)).toMatchObject({
					success: false,
					managed: { code: 'lease-invalid' },
				});
				const snapshot = buildSpawnRequestSnapshot(request);
				const admitted = await manager.admitSpawn(request, { peer: 'in-process' });
				if (admitted.state !== 'admitted') throw new Error(admitted.state);
				const [lease] = port.authority.live();
				const release = vi.spyOn(lease, 'release');
				const message =
					'Prompt-file delivery is unavailable on this transport. Nothing was started.';
				expect(manager.spawn({ ...request, admission: admitted.admission })).toEqual({
					pid: -1,
					success: false,
					error: message,
				});
				expect(release).toHaveBeenCalledExactlyOnceWith({ outcome: 'spawn-failed', message });
				expect(port.authority.live()).toHaveLength(0);
				expect(port.asked[0].snapshot).toEqual(snapshot);
				expect(buildSpawnRequestSnapshot(request)).toEqual(snapshot);
				expect(manager.get(request.sessionId)).toBe(old);
				expect(old.ptyProcess!.kill).not.toHaveBeenCalled();
				for (const sink of [cli, serve, pty, sdk, capture]) expect(sink).not.toHaveBeenCalled();
				expect(errors).toHaveLength(2);
				expect(errors[1]).toMatchObject({ message, recoverable: false });
				const disclosed = JSON.stringify([
					errors,
					...Object.values(logger).map((log) => vi.mocked(log).mock.calls),
				]);
				expect(disclosed).not.toContain(artifact.path);
				expect(disclosed).not.toContain('PRIVATE prompt');
			}
		);

		it('captures remote identity without changing the admitted private request (GT1-02-10E1T)', async () => {
			const { manager, port, cli } = managedManager();
			const selected = {
				...artifact,
				owner: 'remote' as const,
				path: '/var/tmp/private-remote-prompt.json',
				sshRemoteId: 'selected-remote',
			};
			const request = config({
				toolType: 'grok',
				command: 'ssh',
				prompt: undefined,
				promptArtifact: selected,
				sshRemoteId: selected.sshRemoteId,
				sshRemoteHost: 'synthetic.invalid',
				sshStdinScript: 'PRIVATE remote script',
				sshRemoteCommand: selected.path,
				args: ['synthetic.invalid', 'bash'],
				agentSessionId: 'resume-native',
				tabId: 'tab-1',
			});
			const original = structuredClone(request);
			const heard: ProcessConfig[] = [];
			manager.on('spawn', (value) => heard.push(value));
			expect((await manager.spawnAdmitted(request, { peer: 'in-process' })).success).toBe(true);
			const spawned = cli.mock.calls[0][0];
			expect(spawned.promptArtifact).toBe(selected);
			expect(spawned.sshStdinScript).toBe(request.sshStdinScript);
			expect(spawned.admission?.requestDigest).toBe(
				dispatchSnapshotDigest(buildSpawnRequestSnapshot(original))
			);
			expect(request).toEqual(original);
			expect(heard).toHaveLength(1);
			expect(heard[0]).toMatchObject({
				sshRemoteId: selected.sshRemoteId,
				sshRemoteHost: request.sshRemoteHost,
				agentSessionId: 'resume-native',
				tabId: 'tab-1',
				args: [],
			});
			for (const key of ['promptArtifact', 'sshStdinScript', 'sshRemoteCommand'])
				expect(heard[0]).not.toHaveProperty(key);
			const disclosed = JSON.stringify([
				heard,
				...Object.values(logger).map((log) => vi.mocked(log).mock.calls),
			]);
			for (const privateValue of [selected.path, 'PRIVATE prompt', 'PRIVATE remote script'])
				expect(disclosed).not.toContain(privateValue);
			manager.emit('exit', request.sessionId, 0);
			expect(port.authority.live()).toHaveLength(0);
		});

		it.each(['local', 'remote'] as const)(
			'binds a %s artifact by digest without publishing its private fields',
			(owner) => {
				const selected = {
					...artifact,
					owner,
					...(owner === 'remote'
						? { path: '/var/tmp/private-prompt.json', sshRemoteId: 'remote-selected' }
						: {}),
				};
				const request = config({
					toolType: 'grok',
					command: owner === 'remote' ? 'ssh' : 'grok',
					prompt: undefined,
					promptArtifact: selected,
					sshRemoteId: selected.sshRemoteId,
					sshStdinScript: owner === 'remote' ? 'PRIVATE SSH script' : undefined,
				});
				const snapshot = buildSpawnRequestSnapshot(request);
				const legacy = buildSpawnRequestSnapshot({ ...request, promptArtifact: undefined });
				expect(snapshot.promptArtifactDigest).toMatch(/^[a-f0-9]{64}$/);
				expect(snapshot).toEqual({ ...legacy, promptArtifactDigest: expect.any(String) });
				expect(snapshot.target).toEqual(
					owner === 'remote' ? { kind: 'ssh', remoteId: 'remote-selected' } : { kind: 'local' }
				);
				expect(snapshot.stdinDigest).toBe(legacy.stdinDigest);
				expect(snapshot).not.toHaveProperty('promptArtifact');
				// No path is in argv here: isolate the private field from public argv.
				const serialized = JSON.stringify(snapshot);
				for (const privateValue of [
					selected.path,
					path.basename(selected.path),
					selected.content,
					'PRIVATE prompt',
					'PRIVATE SSH',
				]) {
					expect(serialized).not.toContain(privateValue);
				}
				expect(dispatchSnapshotDigest(snapshot)).not.toBe(dispatchSnapshotDigest(legacy));
				expect(buildSpawnRequestSnapshot({ ...request, promptArtifact: { ...selected } })).toEqual(
					snapshot
				);
			}
		);

		it.each([
			['content', { content: 'REPLACEMENT private prompt' }],
			['empty content', { content: '' }],
			['destination', { path: path.join(os.tmpdir(), 'private-replacement.json') }],
			['owner', { owner: 'remote' }],
			['remote identity', { sshRemoteId: 'remote-other' }],
			['encoding', { encoding: 'utf16le' }],
			['mode', { mode: 0o644 }],
			['creation flag', { flag: 'w' }],
			['cleanup lifetime', { cleanup: 'never' }],
			['omission', null],
		] as const)(
			'rejects changed artifact %s before spawn, without consuming the original lease',
			async (_label, change) => {
				const { manager, port, cli, serve, errors } = managedManager();
				const capture = vi.fn();
				manager.on('spawn', capture);
				const request = config({ toolType: 'grok', command: 'grok', promptArtifact: artifact });
				const snapshot = buildSpawnRequestSnapshot(request);
				const admitted = await manager.admitSpawn(request, { peer: 'in-process' });
				if (admitted.state !== 'admitted') throw new Error(admitted.state);
				const [lease] = port.authority.live();
				// Malformed metadata is deliberate. Even an unchecked runtime caller
				// cannot reuse a lease with different file ownership or creation rules.
				const changed = {
					...request,
					promptArtifact: change ? { ...artifact, ...change } : undefined,
					admission: admitted.admission,
				} as ProcessConfig;
				const changedSnapshot = buildSpawnRequestSnapshot(changed);
				expect(changedSnapshot.promptArtifactDigest).not.toBe(snapshot.promptArtifactDigest);
				expect(dispatchSnapshotDigest(changedSnapshot)).not.toBe(admitted.admission.requestDigest);
				expect(changedSnapshot.stdinDigest).toBe(snapshot.stdinDigest);
				expect(changed.args).toBe(request.args);
				const result = manager.spawn(changed);
				expect(result).toMatchObject({
					success: false,
					pid: -1,
					managed: { state: 'denied', code: 'lease-invalid' },
				});
				expect(cli).not.toHaveBeenCalled();
				expect(serve).not.toHaveBeenCalled();
				expect(capture).not.toHaveBeenCalled();
				expect(lease.state()).toBe('issued');
				expect(port.asked).toHaveLength(1);
				expect(port.asked[0].snapshot).toEqual(snapshot);
				expect(errors).toHaveLength(1);
				const disclosed = JSON.stringify([
					result,
					errors,
					...Object.values(logger).map((log) => vi.mocked(log).mock.calls),
				]);
				for (const privateValue of [
					artifact.path,
					path.basename(artifact.path),
					'PRIVATE prompt',
					'REPLACEMENT private',
					'private-replacement',
				]) {
					expect(disclosed).not.toContain(privateValue);
				}

				expect(manager.spawn({ ...request, admission: admitted.admission })).toEqual({
					pid: 4242,
					success: true,
				});
				expect(cli).toHaveBeenCalledTimes(1);
				expect(lease.state()).toBe('bound');
				expect(manager.admissionOf(request.sessionId)).toBe(admitted.admission);
				manager.emit('exit', request.sessionId, 0);
				expect(lease.ended()).toMatchObject({ state: 'released', release: { outcome: 'exited' } });
				expect(port.authority.live()).toHaveLength(0);
			}
		);

		it('detects mutation of the original artifact after admission', async () => {
			const { manager, port, cli, serve } = managedManager();
			const request = config({
				toolType: 'grok',
				command: 'grok',
				promptArtifact: { ...artifact },
			});
			const admitted = await manager.admitSpawn(request, { peer: 'in-process' });
			if (admitted.state !== 'admitted') throw new Error(admitted.state);
			const snapshot = structuredClone(port.asked[0].snapshot);
			request.promptArtifact!.content = 'MUTATED private prompt';
			expect(manager.spawn({ ...request, admission: admitted.admission })).toMatchObject({
				success: false,
				managed: { state: 'denied', code: 'lease-invalid' },
			});
			expect(port.asked[0].snapshot).toEqual(snapshot);
			expect(cli).not.toHaveBeenCalled();
			expect(serve).not.toHaveBeenCalled();
			port.authority.live()[0].release({ outcome: 'stopped', by: 'caller' });
		});

		it.each(['fresh', 'empty', 'resumed'] as const)(
			'preserves the %s artifact through admitted, cwd and environment copies',
			async (turn) => {
				const { manager, port, cli, serve } = managedManager();
				const selected = { ...artifact, content: turn === 'empty' ? '' : artifact.content };
				const request = config({
					toolType: 'grok',
					command: 'grok',
					cwd: '~',
					prompt: undefined,
					args: ['--prompt-file', selected.path],
					promptArtifact: selected,
					customEnvVars: { GROK_HOME: path.join(os.tmpdir(), 'synthetic-grok-account') },
					agentSessionId: turn === 'resumed' ? 'native-resume-id' : undefined,
				});
				const original = structuredClone(request);
				const snapshot = buildSpawnRequestSnapshot(request);
				expect(await manager.spawnAdmitted(request, { peer: 'in-process' })).toEqual({
					pid: 4242,
					success: true,
				});
				expect(cli).toHaveBeenCalledTimes(1);
				expect(serve).not.toHaveBeenCalled();
				const spawned = cli.mock.calls[0][0] as ProcessConfig;
				expect(spawned).not.toBe(request);
				expect(spawned.promptArtifact).toBe(selected);
				expect(spawned).toMatchObject({
					cwd: os.tmpdir(),
					args: request.args,
					agentSessionId: request.agentSessionId,
				});
				expect(spawned.customEnvVars).toMatchObject({
					...request.customEnvVars,
					MAESTRO_COWORKING_SESSION_ID: 'agent-1',
					MAESTRO_COWORKING_SOCKET_OVERRIDE: '/tmp/maestro-test-coworking.sock',
					[COWORKING_RUN_ADMISSION_ENV_VAR]: expect.any(String),
				});
				expect(spawned.admission?.requestDigest).toBe(dispatchSnapshotDigest(snapshot));
				expect(port.asked[0].snapshot).toEqual(snapshot);
				expect(snapshot.operation).toBe(turn === 'resumed' ? 'resume' : 'start');
				expect(snapshot.stdinDigest).toBeNull();
				expect(snapshot.promptArtifactDigest).toMatch(/^[a-f0-9]{64}$/);
				expect(request).toEqual(original);
				manager.emit('exit', request.sessionId, 0);
				expect(port.authority.live()).toHaveLength(0);
			}
		);

		it('projects capture metadata without exposing or stripping the private spawner input', async () => {
			const { manager, port, cli } = managedManager();
			const heard: ProcessConfig[] = [];
			manager.on('spawn', (captured) => heard.push(captured));
			// Poison every legacy carrier to catch capture leaks, not to qualify
			// a mixed delivery plan at the child spawner (which is fake here).
			const request = config({
				toolType: 'grok',
				command: 'grok',
				promptArtifact: artifact,
				args: ['--prompt-file', artifact.path],
				prompt: artifact.content,
				sshStdinScript: artifact.content,
				sshRemoteCommand: artifact.path,
				images: [artifact.content],
				customEnvVars: { PRIVATE_FIXTURE: artifact.content },
				promptArgs: () => [artifact.content],
				imagePromptBuilder: () => artifact.path,
				querySource: 'auto',
				tabId: 'tab-1',
				projectPath: os.tmpdir(),
				purpose: 'utility',
				utilityOf: { sessionId: 'agent-1', tabId: 'tab-1' },
			});
			expect((await manager.spawnAdmitted(request, { peer: 'in-process' })).success).toBe(true);
			expect(heard).toHaveLength(1);
			expect(heard[0]).toMatchObject({
				sessionId: request.sessionId,
				toolType: 'grok',
				cwd: request.cwd,
				command: 'grok',
				args: [],
				querySource: 'auto',
				tabId: 'tab-1',
				projectPath: os.tmpdir(),
				purpose: 'utility',
				utilityOf: request.utilityOf,
				admission: manager.admissionOf(request.sessionId),
			});
			for (const key of [
				'promptArtifact',
				'prompt',
				'sshStdinScript',
				'sshRemoteCommand',
				'images',
				'customEnvVars',
				'promptArgs',
				'imagePromptBuilder',
			]) {
				expect(heard[0]).not.toHaveProperty(key);
			}
			const disclosed = JSON.stringify([
				heard,
				...Object.values(logger).map((log) => vi.mocked(log).mock.calls),
			]);
			expect(disclosed).not.toContain(artifact.path);
			expect(disclosed).not.toContain(path.basename(artifact.path));
			expect(disclosed).not.toContain('PRIVATE prompt');
			const spawned = cli.mock.calls[0][0] as ProcessConfig;
			expect(spawned.promptArtifact).toBe(artifact);
			expect(spawned.args).toEqual(request.args);
			expect(spawned.promptArgs).toBe(request.promptArgs);
			expect(spawned.sshStdinScript).toBe(artifact.content);
			manager.emit('exit', request.sessionId, 0);
			expect(port.authority.live()).toHaveLength(0);
		});

		it.each(['missing admission', 'policy denial'] as const)(
			'refuses %s before artifact preparation or spawn',
			async (reason) => {
				const port = fakeSpawnPort({
					decide: () => ({
						decision: 'deny',
						reason: 'Fixture policy refuses this launch.',
						policyRevision: 1,
					}),
				});
				const { manager, cli, serve, errors } = managedManager(port);
				const capture = vi.fn();
				manager.on('spawn', capture);
				const request = config({ toolType: 'grok', command: 'grok', promptArtifact: artifact });
				const result =
					reason === 'missing admission'
						? manager.spawn(request)
						: await manager.spawnAdmitted(request, { peer: 'in-process' });
				expect(result).toMatchObject({
					pid: -1,
					success: false,
					managed: {
						state: 'denied',
						code: reason === 'missing admission' ? 'lease-invalid' : 'policy-denied',
					},
				});
				expect(cli).not.toHaveBeenCalled();
				expect(serve).not.toHaveBeenCalled();
				expect(capture).not.toHaveBeenCalled();
				expect(errors).toHaveLength(1);
				expect(port.asked).toHaveLength(reason === 'missing admission' ? 0 : 1);
				expect(port.authority.live()).toHaveLength(0);
				const disclosed = JSON.stringify([
					result,
					errors,
					port.asked,
					...Object.values(logger).map((log) => vi.mocked(log).mock.calls),
				]);
				expect(disclosed).not.toContain(artifact.path);
				expect(disclosed).not.toContain(path.basename(artifact.path));
				expect(disclosed).not.toContain('PRIVATE prompt');
			}
		);

		it.each(['omitted', 'undefined'] as const)(
			'preserves the legacy digest and capture identity with an %s artifact',
			async (field) => {
				const { manager, port, serve } = managedManager();
				const request = config(field === 'undefined' ? { promptArtifact: undefined } : {});
				const legacy = buildDispatchSnapshot(
					{
						command: request.command,
						args: request.args,
						cwd: request.cwd,
						env: {},
						stdin: request.prompt,
						shell: false,
					},
					{
						provider: 'opencode',
						operation: 'start',
						target: { kind: 'local' },
						purpose: 'conversation',
						origin: 'desktop',
					}
				);
				expect(buildSpawnRequestSnapshot(request)).toEqual(legacy);
				expect(legacy).not.toHaveProperty('promptArtifactDigest');
				const admitted = await manager.admitSpawn(request, { peer: 'in-process' });
				if (admitted.state !== 'admitted') throw new Error(admitted.state);
				expect(admitted.admission.requestDigest).toBe(dispatchSnapshotDigest(legacy));
				const carried = { ...request, admission: admitted.admission };
				const heard: ProcessConfig[] = [];
				manager.on('spawn', (captured) => heard.push(captured));
				expect(manager.spawn(carried)).toBe(SERVE_RESULT);
				expect(serve).toHaveBeenCalledWith(carried);
				expect(heard).toHaveLength(1);
				expect(heard[0]).toBe(carried);
				manager.emit('exit', request.sessionId, 0);
				expect(port.authority.live()).toHaveLength(0);
			}
		);
	});
});

/**
 * An Auto Run attempt at the sink (MRC-07-01B): a spawn that carries its
 * lineage (`config.autoRun`) is bound on the task's request and attempt ids
 * under the workflow's run, with the workflow reference and its owner fence
 * in the verified context, instead of the anonymous identity a chat turn
 * gets. An unowned workflow (no fence) is refused unavailable before the
 * authority is asked, and a standalone host ignores the lineage.
 */
describe('ProcessManager admission on an Auto Run lineage', () => {
	const WORKFLOW: AutoRunWorkflowIdentity = {
		workflowId: 'playbook:/work/.maestro/playbooks/release',
		version: 'docs-2-0badf00d',
		triggerEventId: 'operator:1700000000000',
		runId: 'run-root',
	};
	const FENCE = { ownerEpoch: 'epoch-1', fencingToken: 'fence-1' };
	let ids = 0;
	const newId = () => `id-${++ids}`;
	const taskRequest = () =>
		newAutoRunTurnRequest(WORKFLOW, { purpose: 'task', document: '01-build', newId });

	function managedManager(port = fakeSpawnPort()) {
		const manager = new ProcessManager(() => true, { spawnAuthority: () => port });
		const serve = vi.fn(() => SERVE_RESULT);
		(
			manager as unknown as { opencodeServerSpawner: { spawn: typeof serve } }
		).opencodeServerSpawner = { spawn: serve };
		return { manager, port, serve };
	}

	it('binds the attempt on its lineage: identity, workflow reference, fence and trace id', async () => {
		const { manager, port, serve } = managedManager();
		const attribution = taskRequest();
		const request = config({ autoRun: { attribution, fence: FENCE } });

		const admitted = await manager.admitSpawn(request, { peer: 'in-process' });
		expect(admitted.state).toBe('admitted');
		if (admitted.state !== 'admitted') return;

		expect(port.asked).toHaveLength(1);
		const { context } = port.asked[0];
		expect(context.identity).toEqual(autoRunRunIdentity(attribution));
		expect(context.identity).toMatchObject({
			requestId: attribution.requestId,
			attemptId: attribution.attemptId,
			rootRunId: 'run-root',
			parentRunId: 'run-root',
		});
		expect(context.workflow).toEqual(autoRunWorkflowRef(WORKFLOW, FENCE));
		expect(context.workflow).toMatchObject({
			workflowId: WORKFLOW.workflowId,
			ownerEpoch: 'epoch-1',
			fencingToken: 'fence-1',
		});
		expect(context.traceId).toBe(autoRunTraceId(attribution));
		expect(context.traceId).not.toBe(request.sessionId);
		// The admission the handler journals names the task's request and attempt.
		expect(admitted.admission.requestId).toBe(attribution.requestId);
		expect(admitted.admission.attemptId).toBe(attribution.attemptId);

		expect(manager.spawn({ ...request, admission: admitted.admission })).toBe(SERVE_RESULT);
		expect(serve).toHaveBeenCalledTimes(1);
	});

	it('admits a retry as its own attempt under the same request', async () => {
		const { manager, port } = managedManager();
		const first = taskRequest();
		const retry = nextAutoRunAttempt(first, newId);

		const one = await manager.admitSpawn(
			config({ autoRun: { attribution: first, fence: FENCE } }),
			{ peer: 'in-process' }
		);
		const two = await manager.admitSpawn(
			config({ autoRun: { attribution: retry, fence: FENCE } }),
			{ peer: 'in-process' }
		);
		expect(one.state).toBe('admitted');
		expect(two.state).toBe('admitted');
		if (one.state !== 'admitted' || two.state !== 'admitted') return;

		expect(two.admission.requestId).toBe(one.admission.requestId);
		expect(two.admission.attemptId).not.toBe(one.admission.attemptId);
		expect(two.admission.leaseId).not.toBe(one.admission.leaseId);
		expect(port.asked.map((ask) => ask.context.identity.attemptId)).toEqual([
			first.attemptId,
			retry.attemptId,
		]);
	});

	it('refuses an unowned workflow as unavailable before the authority is asked', async () => {
		const { manager, port, serve } = managedManager();
		const request = config({ autoRun: { attribution: taskRequest(), fence: null } });

		const outcome = await manager.admitSpawn(request, { peer: 'in-process' });
		expect(outcome).toMatchObject({ state: 'unavailable', code: 'runtime-unavailable' });
		if (outcome.state !== 'unavailable') return;
		expect(outcome.message).toContain(WORKFLOW.workflowId);
		expect(outcome.message).toContain('no workflow owner fence');
		// A port with no producer is named as the reason, not papered over.
		expect(outcome.message).toContain('no workflow owner producer');
		expect(port.asked).toHaveLength(0);

		// Admit-then-spawn reports the same refusal and starts nothing.
		expect(await manager.spawnAdmitted(request, { peer: 'in-process' })).toMatchObject({
			success: false,
			managed: { state: 'unavailable', code: 'runtime-unavailable' },
		});
		expect(serve).not.toHaveBeenCalled();
	});

	it('binds a chat turn under a fresh identity with no workflow, as before', async () => {
		const { manager, port } = managedManager();
		const request = config();
		const admitted = await manager.admitSpawn(request, { peer: 'in-process' });
		expect(admitted.state).toBe('admitted');
		const { context } = port.asked[0];
		expect(context.workflow).toBeNull();
		expect(context.identity).toMatchObject({ runId: null, rootRunId: null, parentRunId: null });
		expect(context.identity.idempotencyKey).toBe(context.identity.requestId);
		expect(context.traceId).toBe(request.sessionId);
	});

	it('ignores the lineage on a standalone host', async () => {
		const port = fakeSpawnPort({ standing: 'standalone' });
		const { manager, serve } = managedManager(port);
		const request = config({ autoRun: { attribution: taskRequest(), fence: null } });
		expect(await manager.admitSpawn(request, { peer: 'in-process' })).toEqual({
			state: 'standalone',
		});
		expect(manager.spawn(request)).toBe(SERVE_RESULT);
		expect(serve).toHaveBeenCalledTimes(1);
		expect(port.asked).toHaveLength(0);
	});
});

/**
 * The owner fence claimed at the sink (MRC-07-06B): the renderer sends every
 * Auto Run lineage unowned (`fence: null`, it has no producer and must not
 * claim), and the sink claims the fence through the port's workflow owner
 * producer for exactly that attempt's request and attempt ids before the
 * context is verified. The registry's fence is what the attempt is bound on;
 * the producer's refusal is the sink's answer with its state and code, before
 * the authority is asked; a lineage that arrives with a fence is carried, not
 * re-claimed; a chat turn and a standalone host never ask the producer.
 */
describe('ProcessManager claiming the owner fence at the sink', () => {
	const WORKFLOW: AutoRunWorkflowIdentity = {
		workflowId: 'playbook:/work/.maestro/playbooks/release',
		version: 'docs-2-0badf00d',
		triggerEventId: 'operator:1700000000000',
		runId: 'run-root',
	};
	const REGISTRY_FENCE = { ownerEpoch: '3', fencingToken: 'fence-3' };
	const CARRIED_FENCE = { ownerEpoch: 'epoch-1', fencingToken: 'fence-1' };
	let ids = 0;
	const newId = () => `fence-id-${++ids}`;
	const taskRequest = () =>
		newAutoRunTurnRequest(WORKFLOW, { purpose: 'task', document: '01-build', newId });

	/** The managed port with a workflow owner producer standing in: a table answering what a claim comes to. */
	function fencedManager(
		answer: (
			workflow: AutoRunWorkflowIdentity,
			run: { runId: string; attemptId: string }
		) => WorkflowFenceAnswer | Promise<WorkflowFenceAnswer>,
		standing: 'standalone' | 'managed' = 'managed'
	) {
		const workflowFence = vi.fn(answer);
		const port = { ...fakeSpawnPort({ standing }), workflowFence };
		const manager = new ProcessManager(() => true, { spawnAuthority: () => port });
		const serve = vi.fn(() => SERVE_RESULT);
		(
			manager as unknown as { opencodeServerSpawner: { spawn: typeof serve } }
		).opencodeServerSpawner = { spawn: serve };
		return { manager, port, serve, workflowFence };
	}

	it('claims the fence of an unowned lineage for this attempt and binds the attempt on it', async () => {
		const { manager, port, serve, workflowFence } = fencedManager(async () => REGISTRY_FENCE);
		const attribution = taskRequest();
		const request = config({ autoRun: { attribution, fence: null } });

		const admitted = await manager.admitSpawn(request, { peer: 'in-process' });
		expect(admitted.state).toBe('admitted');
		if (admitted.state !== 'admitted') return;

		// Claimed once, for the workflow identity and the attempt's own ids.
		expect(workflowFence).toHaveBeenCalledTimes(1);
		expect(workflowFence).toHaveBeenCalledWith(WORKFLOW, {
			runId: attribution.requestId,
			attemptId: attribution.attemptId,
		});
		// Bound on the REGISTRY's fence, the rest of the lineage as before.
		expect(port.asked).toHaveLength(1);
		const { context } = port.asked[0];
		expect(context.workflow).toEqual(autoRunWorkflowRef(WORKFLOW, REGISTRY_FENCE));
		expect(context.workflow).toMatchObject({ ownerEpoch: '3', fencingToken: 'fence-3' });
		expect(context.identity).toEqual(autoRunRunIdentity(attribution));
		expect(context.traceId).toBe(autoRunTraceId(attribution));
		expect(admitted.admission.requestId).toBe(attribution.requestId);
		expect(admitted.admission.attemptId).toBe(attribution.attemptId);

		// The admission covers the request as the handler spawns it (fence still null on the wire).
		expect(manager.spawn({ ...request, admission: admitted.admission })).toBe(SERVE_RESULT);
		expect(serve).toHaveBeenCalledTimes(1);
	});

	it('claims again on a retry, for the retry attempt under the same request', async () => {
		const { manager, port, workflowFence } = fencedManager(() => REGISTRY_FENCE);
		const first = taskRequest();
		const retry = nextAutoRunAttempt(first, newId);

		const one = await manager.admitSpawn(config({ autoRun: { attribution: first, fence: null } }), {
			peer: 'in-process',
		});
		const two = await manager.admitSpawn(config({ autoRun: { attribution: retry, fence: null } }), {
			peer: 'in-process',
		});
		expect(one.state).toBe('admitted');
		expect(two.state).toBe('admitted');
		if (one.state !== 'admitted' || two.state !== 'admitted') return;

		expect(workflowFence.mock.calls.map(([, run]) => run)).toEqual([
			{ runId: first.requestId, attemptId: first.attemptId },
			{ runId: first.requestId, attemptId: retry.attemptId },
		]);
		expect(two.admission.requestId).toBe(one.admission.requestId);
		expect(two.admission.attemptId).not.toBe(one.admission.attemptId);
		expect(port.asked.map((ask) => ask.context.workflow?.fencingToken)).toEqual([
			'fence-3',
			'fence-3',
		]);
	});

	it('answers the producer refusal with its state and code, before the authority is asked, and starts nothing', async () => {
		const { manager, port, serve, workflowFence } = fencedManager(async () => ({
			fence: null,
			state: 'unavailable',
			code: 'capability-unsupported',
			message: 'The endpoint serves no workflow owner operation in this build (CP-03).',
		}));
		const request = config({ autoRun: { attribution: taskRequest(), fence: null } });

		const outcome = await manager.admitSpawn(request, { peer: 'in-process' });
		expect(outcome).toEqual({
			state: 'unavailable',
			code: 'capability-unsupported',
			message: 'The endpoint serves no workflow owner operation in this build (CP-03).',
		});
		expect(port.asked).toHaveLength(0);

		// The run's spawn failure carries the producer's reason; nothing ran.
		expect(await manager.spawnAdmitted(request, { peer: 'in-process' })).toMatchObject({
			success: false,
			error: expect.stringContaining('CP-03'),
			managed: { state: 'unavailable', code: 'capability-unsupported' },
		});
		expect(workflowFence).toHaveBeenCalledTimes(2);
		expect(serve).not.toHaveBeenCalled();
	});

	it('answers a fenced owner as the producer denied it, and a lost answer as unknown, not as a fence', async () => {
		const denied = fencedManager(() => ({
			fence: null,
			state: 'denied',
			code: 'policy-denied',
			message: 'Workflow "playbook:release" is fenced: another owner holds epoch 4.',
		}));
		expect(
			await denied.manager.admitSpawn(
				config({ autoRun: { attribution: taskRequest(), fence: null } }),
				{ peer: 'in-process' }
			)
		).toMatchObject({ state: 'denied', code: 'policy-denied' });
		expect(denied.port.asked).toHaveLength(0);

		const lost = fencedManager(() => ({
			fence: null,
			state: 'unknown',
			code: 'outcome-unknown',
			message: 'The workflow owner answer was lost.',
		}));
		expect(
			await lost.manager.admitSpawn(
				config({ autoRun: { attribution: taskRequest(), fence: null } }),
				{ peer: 'in-process' }
			)
		).toMatchObject({ state: 'unknown', code: 'outcome-unknown' });
		expect(lost.port.asked).toHaveLength(0);
	});

	it('refuses an unowned workflow the producer answers nothing for, by name', async () => {
		const { manager, port, workflowFence } = fencedManager(() => null);
		const outcome = await manager.admitSpawn(
			config({ autoRun: { attribution: taskRequest(), fence: null } }),
			{ peer: 'in-process' }
		);
		expect(outcome).toMatchObject({ state: 'unavailable', code: 'runtime-unavailable' });
		if (outcome.state !== 'unavailable') return;
		expect(outcome.message).toContain('the workflow owner producer answered none');
		expect(workflowFence).toHaveBeenCalledTimes(1);
		expect(port.asked).toHaveLength(0);
	});

	it('carries a fence the lineage arrived with and does not claim', async () => {
		const { manager, port, workflowFence } = fencedManager(() => REGISTRY_FENCE);
		const attribution = taskRequest();
		const admitted = await manager.admitSpawn(
			config({ autoRun: { attribution, fence: CARRIED_FENCE } }),
			{ peer: 'in-process' }
		);
		expect(admitted.state).toBe('admitted');
		expect(workflowFence).not.toHaveBeenCalled();
		expect(port.asked[0].context.workflow).toEqual(autoRunWorkflowRef(WORKFLOW, CARRIED_FENCE));
	});

	it('never asks the producer for a chat turn, nor on a standalone host', async () => {
		const chat = fencedManager(() => REGISTRY_FENCE);
		const admitted = await chat.manager.admitSpawn(config(), { peer: 'in-process' });
		expect(admitted.state).toBe('admitted');
		expect(chat.workflowFence).not.toHaveBeenCalled();
		expect(chat.port.asked[0].context.workflow).toBeNull();

		const standalone = fencedManager(() => REGISTRY_FENCE, 'standalone');
		expect(
			await standalone.manager.admitSpawn(
				config({ autoRun: { attribution: taskRequest(), fence: null } }),
				{ peer: 'in-process' }
			)
		).toEqual({ state: 'standalone' });
		expect(standalone.workflowFence).not.toHaveBeenCalled();
		expect(standalone.port.asked).toHaveLength(0);
	});
});

/**
 * The receiving sink of a delegated dispatch (MRC-07-04B): a spawn that
 * carries the dispatching operation's record (`config.delegation`, what
 * `maestro-cli dispatch` read off its shell) is bound as that operation's
 * child, never as a fresh chat turn, and the initiator's scope is met with
 * this host's standing before the authority is asked.
 */
describe('ProcessManager admission on a delegated dispatch', () => {
	const initiator = (
		overrides: Partial<Pick<ManagedDelegationContext, 'workflow' | 'policyRevision'>> = {}
	): ManagedDelegationContext => ({
		...delegationContextOf({
			identity: {
				requestId: 'req-cue-1',
				idempotencyKey: 'req-cue-1',
				attemptId: 'att-cue-1',
				runId: 'run-cue-1',
				rootRunId: 'run-root',
				parentRunId: null,
			},
			traceId: 'cue:run-root:req-cue-1:att-cue-1',
			workflow: null,
			delegation: { chain: [{ kind: 'agent', id: 'owner-agent' }], grantRef: null },
			policyRevision: null,
		}),
		...overrides,
	});
	const FENCED_WORKFLOW = {
		workflowId: 'cue:/work:nightly',
		version: 'v1',
		triggerEventId: 'evt-1',
		ownerEpoch: 'epoch-1',
		fencingToken: 'fence-1',
	};

	function managedManager(port = fakeSpawnPort()) {
		const manager = new ProcessManager(() => true, { spawnAuthority: () => port });
		const serve = vi.fn(() => SERVE_RESULT);
		(
			manager as unknown as { opencodeServerSpawner: { spawn: typeof serve } }
		).opencodeServerSpawner = { spawn: serve };
		return { manager, port, serve };
	}

	it('binds the dispatched turn as the initiator child: chain, parent run, trace, own generation', async () => {
		const { manager, port } = managedManager();
		const request = config({ delegation: initiator() });
		const admitted = await manager.admitSpawn(request, { peer: 'in-process' });
		expect(admitted.state).toBe('admitted');
		const { context } = port.asked[0];
		// The chain is the initiator's with the target agent appended, never the
		// transport's attribution and never a fresh chat identity.
		expect(context.delegation).toEqual({
			chain: [
				{ kind: 'agent', id: 'owner-agent' },
				{ kind: 'agent', id: 'agent-1' },
			],
			grantRef: null,
		});
		expect(context.identity).toMatchObject({ rootRunId: 'run-root', parentRunId: 'run-cue-1' });
		expect(context.identity.requestId).not.toBe('req-cue-1');
		expect(context.identity.runId).toBe(context.identity.requestId);
		expect(context.traceId).toBe(
			`delegated:run-root:${context.identity.requestId}:${context.identity.attemptId}`
		);
		expect(context.workflow).toBeNull();
		// The host's current generation, not the initiator's claim (null, standalone).
		expect(context.policyRevision).toBe(1);
		if (admitted.state === 'admitted') {
			expect(admitted.admission.requestId).toBe(context.identity.requestId);
		}
	});

	it('binds the child under the ids the spawn handler minted, the record the process is stamped with (MRC-07-04C)', async () => {
		const { manager, port } = managedManager();
		const request = config({
			delegation: initiator(),
			dispatchedAs: { requestId: 'req-child', attemptId: 'att-child' },
		});
		// The one derivation the handler stamps on the process and the sink binds.
		const child = dispatchedChildContext(request);
		expect(child).toMatchObject({
			identity: {
				requestId: 'req-child',
				attemptId: 'att-child',
				runId: 'req-child',
				rootRunId: 'run-root',
				parentRunId: 'run-cue-1',
			},
			traceId: 'delegated:run-root:req-child:att-child',
			delegation: {
				chain: [
					{ kind: 'agent', id: 'owner-agent' },
					{ kind: 'agent', id: 'agent-1' },
				],
				grantRef: null,
			},
			workflow: null,
			policyRevision: null,
		});
		expect(dispatchedChildContext(request)).toEqual(child);

		const admitted = await manager.admitSpawn(request, { peer: 'in-process' });
		expect(admitted.state).toBe('admitted');
		const { context } = port.asked[0];
		expect(context.identity).toEqual(child!.identity);
		expect(context.traceId).toBe(child!.traceId);
		expect(context.delegation).toEqual(child!.delegation);
		if (admitted.state === 'admitted') {
			expect(admitted.admission.requestId).toBe('req-child');
		}

		// With no minted ids the sink mints its own, fresh per derivation, and a
		// config with no record derives nothing.
		const unminted = config({ delegation: initiator() });
		const a = dispatchedChildContext(unminted);
		const b = dispatchedChildContext(unminted);
		expect(a?.identity.requestId).not.toBe(b?.identity.requestId);
		expect(a?.delegation).toEqual(child!.delegation);
		expect(dispatchedChildContext(config())).toBeUndefined();
	});

	it('carries the initiator workflow and fence as the context workflow, minting nothing', async () => {
		const { manager, port } = managedManager();
		const request = config({ delegation: initiator({ workflow: FENCED_WORKFLOW }) });
		expect((await manager.admitSpawn(request, { peer: 'in-process' })).state).toBe('admitted');
		expect(port.asked[0].context.workflow).toEqual(FENCED_WORKFLOW);
	});

	it('refuses a managed initiator child on a standalone host, before any authority', async () => {
		const port = fakeSpawnPort({ standing: 'standalone' });
		const { manager, serve } = managedManager(port);
		const request = config({ delegation: initiator({ policyRevision: 7 }) });
		expect(await manager.admitSpawn(request, { peer: 'in-process' })).toMatchObject({
			state: 'unavailable',
			code: 'runtime-unavailable',
		});
		const result = await manager.spawnAdmitted(request, { peer: 'in-process' });
		expect(result.success).toBe(false);
		expect(serve).not.toHaveBeenCalled();
		expect(port.asked).toHaveLength(0);
	});

	it('runs a standalone initiator child on a standalone host as before', async () => {
		const port = fakeSpawnPort({ standing: 'standalone' });
		const { manager, serve } = managedManager(port);
		const request = config({ delegation: initiator() });
		expect(await manager.admitSpawn(request, { peer: 'in-process' })).toEqual({
			state: 'standalone',
		});
		expect(manager.spawn(request)).toBe(SERVE_RESULT);
		expect(serve).toHaveBeenCalledTimes(1);
	});

	it('refuses a record that is not a context, and one beside an Auto Run lineage, unasked', async () => {
		const { manager, port } = managedManager();
		const malformed = { ...initiator(), extra: 'field' } as unknown as ManagedDelegationContext;
		expect(
			await manager.admitSpawn(config({ delegation: malformed }), { peer: 'in-process' })
		).toMatchObject({ state: 'denied', code: 'invalid-input' });

		const workflow: AutoRunWorkflowIdentity = {
			workflowId: 'playbook:/work/.maestro/playbooks/release',
			version: 'docs-1',
			triggerEventId: 'operator:1',
			runId: 'run-ar',
		};
		const attribution = newAutoRunTurnRequest(workflow, {
			purpose: 'task',
			document: '01-build',
			newId: () => 'id-ar',
		});
		const both = config({
			delegation: initiator(),
			autoRun: { attribution, fence: { ownerEpoch: 'e', fencingToken: 'f' } },
		});
		expect(await manager.admitSpawn(both, { peer: 'in-process' })).toMatchObject({
			state: 'denied',
			code: 'invalid-input',
		});
		expect(port.asked).toHaveLength(0);
	});
});

/**
 * OpenCode server isolation (MRC-06-04): a managed scope never shares an
 * instance with a standalone session or another actor or policy, starts in
 * ask mode, and the route stays explicitly unavailable until the table
 * qualifies it; permission events map to exact effects.
 */
describe('OpenCode server isolation under management', () => {
	const base = { binaryPath: '/opt/opencode', cwd: '/p' };
	const scope = (actorId: string, policyRevision: number | null = 3) => ({
		authorityId: 'endpoint-1',
		actor: { kind: 'human' as const, id: actorId },
		policyRevision,
	});

	it('keys a managed server by authority, actor and policy revision, apart from standalone', () => {
		const standalone = buildServerKey(base);
		const ada = buildServerKey({ ...base, managed: scope('ada') });
		expect(ada).not.toBe(standalone);
		expect(buildServerKey({ ...base, managed: scope('ada') })).toBe(ada);
		expect(buildServerKey({ ...base, managed: scope('bob') })).not.toBe(ada);
		expect(buildServerKey({ ...base, managed: scope('ada', 4) })).not.toBe(ada);
		expect(
			buildServerKey({ ...base, managed: { ...scope('ada'), authorityId: 'other' } })
		).not.toBe(ada);
	});

	it('starts a managed server in ask mode and a standalone one with the auto-approve config', () => {
		expect(opencodeServerPermissionConfig(scope('ada'))).toBe(OPENCODE_MANAGED_PERMISSION_CONFIG);
		expect(OPENCODE_MANAGED_PERMISSION_CONFIG.permission['*']).toBe('ask');
		expect(OPENCODE_MANAGED_PERMISSION_CONFIG.permission.question).toBe('deny');
		expect(opencodeServerPermissionConfig(undefined).permission['*']).toBe('allow');
	});

	it('refuses a managed OpenCode turn while the route table has no qualified producer, and none standalone', () => {
		expect(managedOpencodeRefusal(config())).toBeNull();
		expect(managedOpencodeRefusal(config({ admission: fakeAdmission() }))).toMatchObject({
			state: 'unavailable',
			code: 'capability-unsupported',
		});
	});

	it('takes the server scope from the admission and the effect from the permission event', () => {
		expect(opencodeManagedScope(fakeAdmission({ policyRevision: 7 }))).toEqual({
			authorityId: 'test-authority',
			actor: { kind: 'human', id: 'ada' },
			policyRevision: 7,
		});
		const permission = (type: string, pattern: string | string[], metadata = {}) => ({
			id: 'perm-1',
			type,
			pattern,
			sessionID: 'ses',
			messageID: 'msg',
			title: 'May I?',
			metadata,
			time: { created: 1 },
		});
		expect(opencodePermissionEffect(permission('bash', 'rm *', { command: 'rm -rf /' }))).toEqual({
			kind: 'command',
			command: 'rm -rf /',
			cwd: null,
			argv: null,
		});
		expect(opencodePermissionEffect(permission('edit', ['/p/b.ts', '/p/a.ts']))).toEqual({
			kind: 'file-change',
			paths: ['/p/a.ts', '/p/b.ts'],
			cwd: null,
		});
		expect(
			opencodePermissionEffect(permission('webfetch', 'https://x', { url: 'https://x' }))
		).toEqual({ kind: 'tool-call', tool: 'webfetch', input: { url: 'https://x' } });
	});
});

/**
 * The actor each transport binds at the sink (MRC-08-01A): the desktop's REAL
 * spawn authority (createProcessSpawnAuthority over a registered enrollment,
 * the fake port's lease authority recording what the policy table was asked)
 * admits a spawn for the actor the acting transport maps to. A CLI caller is
 * the maestro-cli service on the chain, a paired device is the device, a Web
 * Login is the account, the bare path token and the renderer are the operator;
 * the principal is the registered actor for every one of them, and the lease
 * records which transport asked. Standalone asks nothing.
 */
describe('ProcessManager: the actor each transport binds (MRC-08-01A)', () => {
	const INSTALLATION = { installationId: 'inst-1', runtimeId: 'desktop-1', processEpoch: 'e1' };
	const ada = { id: 'u1', username: 'ada', displayName: 'Ada' };
	const device = {
		id: `${PAIRED_DEVICE_USER_ID_PREFIX}dev-7`,
		username: PAIRED_DEVICE_USERNAME,
		displayName: 'Pixel 9',
	};

	function desktopPort(status: 'ok' | 'none' = 'ok') {
		const fake = fakeSpawnPort();
		const port = createProcessSpawnAuthority({
			installation: INSTALLATION,
			identity: {
				read: () =>
					status === 'ok'
						? ({
								status: 'ok',
								record: { registration: { actorId: 'actor-registered' } },
							} as never)
						: { status: 'none' },
			},
			host: { policy: () => ({ sources: [], policyRevision: 3 }) },
			dispatch: { authority: fake.authority },
			now: () => 1_000_000,
		});
		const manager = new ProcessManager(() => true, { spawnAuthority: () => port });
		const serve = vi.fn(() => SERVE_RESULT);
		(
			manager as unknown as { opencodeServerSpawner: { spawn: typeof serve } }
		).opencodeServerSpawner = { spawn: serve };
		return { manager, fake, serve };
	}

	/** What a sink does: admit for the actor the acting transport maps to, then spawn. */
	async function admitAs(
		manager: ProcessManager,
		client: Parameters<typeof runAsClient>[0],
		request = config()
	) {
		return runAsClient(client, async () => {
			await Promise.resolve();
			return manager.admitSpawn(request, transportSpawnActor(getActingTransport()));
		});
	}

	it('binds a CLI caller as the maestro-cli service, not as the operator at the keyboard', async () => {
		const { manager, fake } = desktopPort();
		const admitted = await admitAs(manager, { cli: true, user: ada });
		expect(admitted.state).toBe('admitted');
		expect(fake.asked).toHaveLength(1);
		const { context } = fake.asked[0];
		expect(context.verification.peer).toBe('host-secret');
		expect(context.delegation.chain).toEqual([{ kind: 'service', id: 'maestro-cli' }]);
		expect(context.actor).toEqual({ kind: 'human', id: 'actor-registered' });
	});

	it('binds a paired Lite device as the device, not as the paired-device Web Login human', async () => {
		const { manager, fake } = desktopPort();
		const admitted = await admitAs(manager, { admission: 'device-pairing', user: device });
		expect(admitted.state).toBe('admitted');
		const { context } = fake.asked[0];
		expect(context.verification.peer).toBe('device-pairing');
		expect(context.delegation.chain).toEqual([{ kind: 'service', id: 'lite-device:dev-7' }]);
		expect(context.actor).toEqual({ kind: 'human', id: 'actor-registered' });
	});

	it('binds a Web Login as the account, and the bare token and the renderer as the operator', async () => {
		const { manager, fake } = desktopPort();
		await admitAs(manager, { user: ada });
		await admitAs(manager, {});
		await manager.admitSpawn(config(), transportSpawnActor(getActingTransport()));
		expect(fake.asked.map((a) => a.context.verification.peer)).toEqual([
			'web-login',
			'in-process',
			'in-process',
		]);
		expect(fake.asked.map((a) => a.context.delegation.chain)).toEqual([
			[{ kind: 'human', id: 'web-login:ada' }],
			[],
			[],
		]);
		expect(new Set(fake.asked.map((a) => a.context.actor.id))).toEqual(
			new Set(['actor-registered'])
		);
	});

	it('runs the admitted request under a lease whose context names the transport', async () => {
		const { manager, fake, serve } = desktopPort();
		const request = config();
		const admitted = await admitAs(manager, { cli: true }, request);
		if (admitted.state !== 'admitted') throw new Error(admitted.state);
		expect(manager.spawn({ ...request, admission: admitted.admission })).toBe(SERVE_RESULT);
		expect(serve).toHaveBeenCalledTimes(1);
		const [lease] = fake.authority.live();
		expect(lease.state()).toBe('bound');
		// The lease is the one minted on the admission the CLI transport asked for:
		// same digest, the registered actor as principal, the CLI on the chain.
		expect(fake.asked).toHaveLength(1);
		const { context } = fake.asked[0];
		expect(lease.snapshotDigest).toBe(admitted.admission.requestDigest);
		expect(lease.actor).toEqual({ kind: 'human', id: 'actor-registered' });
		expect(context.verification.peer).toBe('host-secret');
		expect(context.delegation.chain).toEqual([{ kind: 'service', id: 'maestro-cli' }]);
	});

	it('asks nothing of a standalone host, for any transport', async () => {
		const { manager, fake } = desktopPort('none');
		expect(await admitAs(manager, { cli: true })).toEqual({ state: 'standalone' });
		expect(await admitAs(manager, { admission: 'device-pairing', user: device })).toEqual({
			state: 'standalone',
		});
		expect(fake.asked).toHaveLength(0);
	});
});

/**
 * MRC-08-04B: a managed SSH request names the enrolled remote runtime the
 * spawn handler qualified it against, so the lease the authority grants says
 * which remote installation and authority the launch goes to, not only the
 * remote's local id. Only the identifying fields are bound (never the
 * remote's route table), and the request digest changes with them.
 */
describe('ProcessManager: the remote endpoint in the lease target (MRC-08-04B)', () => {
	const identity: SshRemoteEndpointIdentity = {
		contractVersion: MANAGED_CONTRACT_VERSION,
		installationId: 'inst-remote',
		runtimeId: 'rt-remote',
		processEpoch: 'epoch-remote',
		tenantId: 'tenant-1',
		orgId: 'org-1',
		authorityId: 'authority-remote',
		policyRevision: 3,
		authority: 'registered',
		routes: [{ providerId: 'claude-code', route: 'ssh', managed: 'implemented' }],
	};
	const endpointRef = {
		installationId: 'inst-remote',
		runtimeId: 'rt-remote',
		processEpoch: 'epoch-remote',
		authorityId: 'authority-remote',
		policyRevision: 3,
	};
	const sshRequest = (overrides: Partial<ProcessConfig> = {}) =>
		config({
			toolType: 'claude-code',
			command: 'ssh',
			args: ['-o', 'BatchMode=yes', 'devuser@dev.example.com'],
			prompt: undefined,
			sshRemoteId: 'remote-1',
			sshRemoteHost: 'dev.example.com',
			sshStdinScript: 'cd /remote/project\nexec claude --print\n',
			...overrides,
		});

	it('binds the qualified endpoint into the snapshot and the lease, by its identifying fields alone', async () => {
		const port = fakeSpawnPort();
		const manager = new ProcessManager(() => true, { spawnAuthority: () => port });

		const admitted = await manager.admitSpawn(sshRequest({ sshRemoteEndpoint: identity }), {
			peer: 'in-process',
		});

		expect(admitted.state).toBe('admitted');
		if (admitted.state !== 'admitted') return;
		const target = { kind: 'ssh', remoteId: 'remote-1', endpoint: endpointRef };
		expect(admitted.admission.target).toEqual(target);
		expect(port.asked).toHaveLength(1);
		expect(port.asked[0].snapshot.target).toEqual(target);
		expect(admitted.admission.target).not.toHaveProperty('endpoint.routes');
		expect(admitted.admission.target).not.toHaveProperty('endpoint.tenantId');
	});

	it('names only the remote id without an attestation, and the digest tells the two apart', () => {
		const bare = buildSpawnRequestSnapshot(sshRequest());
		const bound = buildSpawnRequestSnapshot(sshRequest({ sshRemoteEndpoint: identity }));

		expect(bare.target).toEqual({ kind: 'ssh', remoteId: 'remote-1' });
		expect(bound.target).toEqual({ kind: 'ssh', remoteId: 'remote-1', endpoint: endpointRef });
		expect(dispatchSnapshotDigest(bare)).not.toBe(dispatchSnapshotDigest(bound));
		// A local request is untouched by the field.
		expect(buildSpawnRequestSnapshot(config({ sshRemoteEndpoint: identity })).target).toEqual({
			kind: 'local',
		});
	});
});
