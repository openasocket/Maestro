/**
 * The detached host on a temp data directory: the real runtime, the real server, and the real
 * discovery file, with Cue replaced (the engine has its own tests) and the clock real. What is
 * proven here is the order a host starts and stops in, and that what it publishes is attachable.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cueEngineLockOwnerToken, type CueEngineLockInfo } from '../../../main/cue/cue-engine-lock';
import { startHostCue, type HostCue, type HostCueEngine } from '../../../cli/services/host-cue';
import { composeHostManaged } from '../../../cli/services/host-managed';
import {
	HostPromptsMissingError,
	HostStartError,
	RUNTIME_HOST_BIND,
	runtimeHostListenerAuthority,
	startRuntimeHost,
	type RunningHost,
	type RuntimeHostDeps,
} from '../../../cli/services/runtime-host';
import { createEnterpriseIdentityStore } from '../../../main/enterprise/identity-store';
import {
	heldListeners,
	isListenerDeniedError,
	setListenerAuthority,
} from '../../../main/enterprise/listener-gate';
import {
	listenerVerdict,
	type ListenerAuthority,
	type ListenerCeilingEntry,
} from '../../../main/enterprise/listener-policy';
import type { Anchor } from '../../../main/utils/keyring-anchor';
import { fakeAnchor, fakeSeal } from '../../main/enterprise/fakeCustody';
import {
	createMaestroRuntime,
	createManagedHostAdapter,
	createWsMaestroClient,
	readCliServerInfoFrom,
	requestHostStatus,
	requestHostStop,
	startRuntimeServer,
	writeCliServerInfoTo,
	type ManagedEnrollmentStatus,
	type ManagedIdentityView,
} from '../../../shared/maestro-lib';
import { BridgeConnection } from '../../../shared/maestro-lib/client/bridge-connection';

/**
 * A ceiling an authenticated endpoint delivered (test fixture only: no published operation
 * delivers one, DESKTOP-LOCAL/1), judged by the real verdict. Admits the bridge at loopback, so the
 * cases about what an enrolled host attests can reach a listening host.
 */
const deliveredCeiling =
	(listeners: ListenerCeilingEntry[] = [{ kind: 'runtime-host', reach: 'loopback' }]) =>
	(): ListenerAuthority => ({
		evaluateListener: (request) =>
			listenerVerdict(
				{ standing: 'managed', ceiling: { policyRevision: 2, listeners }, policyRevision: 2 },
				request
			),
	});

describe('startRuntimeHost', () => {
	let dir: string;
	let running: RunningHost[];
	let lines: string[];

	const options = () => ({
		paths: {
			userDataDir: dir,
			productionDataDir: dir,
			settingsFile: path.join(dir, 'maestro-settings.json'),
			cliServerFile: path.join(dir, 'cli-server.json'),
		},
		moduleDirectory: dir,
		version: '1.2.3',
		log: (line: string) => lines.push(line),
	});

	const idleCue = (): HostCue => ({
		state: () => ({ state: 'disabled' as const }),
		activeRuns: () => 0,
		drain: async () => undefined,
		forceStop: () => undefined,
		stop: async () => undefined,
		answer: async () => undefined,
	});
	/** A sleep guard that records what it was asked, so no test spawns a real caffeinate. */
	const recordingGuard = () => {
		const calls: boolean[] = [];
		let held = false;
		let stopped = false;
		return {
			calls,
			stopped: () => stopped,
			guard: {
				update: (hasWork: boolean) => {
					calls.push(hasWork);
					held = hasWork;
				},
				holding: () => held,
				stop: () => {
					stopped = true;
					held = false;
				},
			},
		};
	};
	// The temp directory is no bundle, so the prompt probe is answered for it.
	const noCue = {
		startCue: async () => idleCue(),
		promptsLoad: () => true,
		listenerAuthority: deliveredCeiling(),
		composeManaged: (input: Parameters<RuntimeHostDeps['composeManaged']>[0]) =>
			composeHostManaged({
				...input,
				anchorFor: () => fakeAnchor({ value: null }),
			}),
		createSleepGuard: () => recordingGuard().guard,
	};

	async function start(): Promise<RunningHost> {
		const host = await startRuntimeHost(options(), noCue);
		running.push(host);
		return host;
	}

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-host-'));
		fs.writeFileSync(
			path.join(dir, 'maestro-sessions.json'),
			JSON.stringify({
				sessions: [
					{
						id: 'a1',
						name: 'Alpha',
						toolType: 'claude-code',
						cwd: dir,
						projectRoot: dir,
						aiTabs: [{ id: 't1', agentSessionId: null, name: null, logs: [] }],
						activeTabId: 't1',
					},
				],
				activeSessionId: 'a1',
			})
		);
		running = [];
		lines = [];
	});

	afterEach(async () => {
		for (const host of running) await host.stop();
		setListenerAuthority(null);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('publishes an attachable discovery file, owner-only, once it is listening', async () => {
		const host = await start();
		const info = readCliServerInfoFrom(dir);
		expect(info).toMatchObject({
			port: host.server.port,
			token: host.token,
			pid: process.pid,
			version: '1.2.3',
			hostKind: 'headless',
			// What `cue trigger` compares with the Cue lock to find this host's own engine.
			cueLockToken: cueEngineLockOwnerToken(),
		});
		expect(info?.cliSecret).toBeTruthy();
		if (process.platform !== 'win32') {
			expect(fs.statSync(path.join(dir, 'cli-server.json')).mode & 0o777).toBe(0o600);
		}
		expect(host.runtime.lock.mode).toBe('host');

		const client = createWsMaestroClient({ userDataDir: dir, reconcileIntervalMs: 0 });
		try {
			const attached = await client.connection.connect();
			expect(attached.ok && attached.value.label).toBe(`headless pid ${process.pid}`);
			const agents = await client.agents.list();
			expect(agents.ok && agents.value.map((agent) => agent.name)).toEqual(['Alpha']);
		} finally {
			await client.connection.close();
		}

		const report = await requestHostStatus(dir);
		expect(report).toMatchObject({
			pid: process.pid,
			version: '1.2.3',
			cue: { state: 'disabled' },
		});
		// No managed host composed: a standalone host attests no managed standing.
		expect('managed' in report).toBe(false);
	});

	it('composes the directory standing by default, even without a caller supplying managed options', async () => {
		fs.writeFileSync(path.join(dir, 'enterprise-identity.bin'), 'unopenable sealed record');
		const composeManaged = vi.fn(noCue.composeManaged);
		const host = await startRuntimeHost(options(), { ...noCue, composeManaged });
		running.push(host);
		expect(composeManaged).toHaveBeenCalledWith({
			userDataDir: dir,
			productionDataDir: dir,
			version: '1.2.3',
		});
		expect(host.managedComposition?.composed).toBe(false);
		expect(host.runtime.managedBinding.state().state).toBe('unreadable');
		expect(host.runtime.managedHost?.identity.read().status).toBe('unprotected');
		const result = await host.runtime.turns.send('a1', 't1', { text: 'must not run' });
		expect(result.ok).toBe(false);
		expect(host.runtime.turnsInFlight()).toBe(0);
	});

	it('keeps a supplied composition and its controls together through shutdown', async () => {
		const composition = composeHostManaged({
			userDataDir: dir,
			productionDataDir: dir,
			version: '1.2.3',
			custody: { ok: true, seal: fakeSeal(), anchor: fakeAnchor({ value: null }) },
		});
		if (!composition.composed) throw new Error(composition.reason);
		const composeManaged = vi.fn(noCue.composeManaged);
		const host = await startRuntimeHost(
			{ ...options(), managedComposition: composition },
			{ ...noCue, composeManaged }
		);
		running.push(host);
		expect(composeManaged).not.toHaveBeenCalled();
		expect(host.managedComposition).toBe(composition);
		expect(await composition.control.beginRegistration()).toMatchObject({
			status: 'refused',
			reason: 'not-enrolled',
		});
		await host.stop();
		expect(await composition.control.beginRegistration()).toMatchObject({ status: 'unavailable' });
		expect(fs.existsSync(path.join(dir, 'maestro-runtime.lock'))).toBe(false);
	});

	it('rejects a composition mixed with an unrelated lifecycle before starting the runtime', async () => {
		const createRuntime = vi.fn();
		await expect(
			startRuntimeHost(
				{
					...options(),
					managedComposition: noCue.composeManaged({ userDataDir: dir, version: '1' }),
					managed: {},
				},
				{ ...noCue, createRuntime }
			)
		).rejects.toThrow('without separate managed options');
		expect(createRuntime).not.toHaveBeenCalled();
	});

	it('hands a composed managed host to the runtime, which then attests its standing in status', async () => {
		let view: ManagedIdentityView = { status: 'none', reason: null, message: null, record: null };
		const standing = (): ManagedEnrollmentStatus => ({
			identity: view,
			connection: null,
			endpoint: null,
			authority: 'none',
			reason: 'not attached in this process',
			pendingApproval: null,
			lastDenial: null,
		});
		const host = await startRuntimeHost(
			{
				...options(),
				managed: {
					host: (installation) => {
						view = {
							status: 'ok',
							reason: null,
							message: null,
							record: {
								version: 1,
								installationId: installation.installationId,
								tenantId: 'tenant-1',
								orgId: 'org-1',
								enrollmentId: 'enr-1',
								endpoint: {
									socketPath: '/tmp/endpoint.sock',
									bindingDigest: 'a'.repeat(64),
									trustRootDigest: null,
								},
								management: 'enrolled',
								registration: null,
								policy: { desiredRevision: 2, appliedRevision: 2, observedAt: null },
								enrolledAt: '2026-10-22T12:00:00.000Z',
								updatedAt: '2026-10-22T12:00:00.000Z',
							},
						};
						return createManagedHostAdapter({
							installation,
							identity: { read: () => view },
							endpoint: null,
							status: standing,
						});
					},
				},
			},
			noCue
		);
		running.push(host);
		expect(host.runtime.managedHost).not.toBeNull();
		expect(host.runtime.managedBinding.state().state).toBe('enrolled');
		// Enrolled but unattached: the standing is attested, with no authority claimed.
		expect((await requestHostStatus(dir)).managed).toMatchObject({
			installationId: host.runtime.installation.installationId,
			runtimeId: `host-${process.pid}`,
			tenantId: 'tenant-1',
			orgId: 'org-1',
			policyRevision: 2,
			authority: 'none',
		});
	});

	describe('the standing maestro-cli host start composes (MRC-08-04C)', () => {
		let holder: { value: Anchor | null };
		beforeEach(() => {
			holder = { value: null };
		});

		/** The sealed record a desktop enrollment would have left on the directory, under fake custody. */
		async function enroll(): Promise<void> {
			const installation = await (async () => {
				// The installation id the runtime will compute for this directory and host name.
				const probe = await startRuntimeHost(options(), noCue);
				const id = probe.runtime.installation.installationId;
				await probe.stop();
				return id;
			})();
			await createEnterpriseIdentityStore({
				file: path.join(dir, 'enterprise-identity.bin'),
				seal: fakeSeal(),
				anchor: fakeAnchor(holder),
				platform: 'darwin',
			}).write({
				installationId: installation,
				tenantId: 'tenant-1',
				orgId: 'org-1',
				enrollmentId: 'enr-1',
				endpoint: {
					socketPath: '/tmp/endpoint.sock',
					bindingDigest: 'a'.repeat(64),
					trustRootDigest: null,
				},
				management: 'enrolled',
				registration: null,
				policy: { desiredRevision: 2, appliedRevision: 2, observedAt: null },
				enrolledAt: '2026-10-22T12:00:00.000Z',
			});
		}

		it('composed over protected custody: the host attests the record and admits as the adapter', async () => {
			await enroll();
			const standing = composeHostManaged({
				userDataDir: dir,
				version: '1.2.3',
				custody: { ok: true, seal: fakeSeal(), anchor: fakeAnchor(holder) },
				platform: 'darwin',
			});
			if (!standing.composed) throw new Error(standing.reason);
			const attach = vi.spyOn(standing.lifecycle, 'attach');
			const close = vi.spyOn(standing.lifecycle, 'close');
			const host = await startRuntimeHost(
				{ ...options(), managed: standing.managed, managedLifecycle: standing.lifecycle },
				noCue
			);
			running.push(host);
			// Re-attached before the host published, with the record's dial refused (no socket there).
			expect(attach).toHaveBeenCalledTimes(1);
			expect(standing.status()).toMatchObject({ authority: 'none', identity: { status: 'ok' } });
			expect(host.runtime.managedBinding.state().state).toBe('enrolled');
			// The binding's authority is the adapter's, and the report attests the record's standing.
			expect(host.runtime.managedBinding.authority().authorityId).toBe(
				host.runtime.managedHost!.authority.authorityId
			);
			const report = await requestHostStatus(dir);
			expect(report.managed).toMatchObject({
				installationId: host.runtime.installation.installationId,
				tenantId: 'tenant-1',
				orgId: 'org-1',
				policyRevision: 2,
				authority: 'none',
				authorityId: host.runtime.managedHost!.authority.authorityId,
			});
			expect('managedUnavailable' in report).toBe(false);
			// The telemetry client runs over the runtime's journal and adapter, and sends nothing
			// without a standing: the record's socket is not there to attach to (MRC-10-03B).
			expect(host.telemetry).not.toBeNull();
			expect(host.telemetry!.status().running).toBe(true);
			expect(await host.telemetry!.pump()).toMatchObject({ outcome: 'no-standing', taken: 0 });

			await host.stop();
			expect(host.telemetry!.status().running).toBe(false);
			expect(close).toHaveBeenCalledTimes(1);
			expect(lines).not.toContain(expect.stringContaining('managed standing failed'));
		});

		it('refused: no managed in the report, and the named reason beside it', async () => {
			await enroll();
			// A managed host ran here once and mirrored the enrollment into the binding file.
			const composed = composeHostManaged({
				userDataDir: dir,
				version: '1.2.3',
				custody: { ok: true, seal: fakeSeal(), anchor: fakeAnchor(holder) },
				platform: 'darwin',
			});
			if (!composed.composed) throw new Error(composed.reason);
			const earlier = await startRuntimeHost(
				{ ...options(), managed: composed.managed, managedLifecycle: composed.lifecycle },
				noCue
			);
			expect(earlier.runtime.managedBinding.state().state).toBe('enrolled');
			await earlier.stop();

			// A plain Node process: no seal injected, so custody is refused by name.
			const standing = composeHostManaged({ userDataDir: dir, version: '1.2.3' });
			expect(standing.composed).toBe(false);
			if (standing.composed) throw new Error('unreachable');
			const host = await startRuntimeHost(
				{ ...options(), managedUnavailable: standing.reason },
				noCue
			);
			running.push(host);
			expect(host.runtime.managedHost?.identity.read().status).toBe('unprotected');
			// The existing binding stays enrolled-unavailable under the default held adapter.
			expect(host.runtime.managedBinding.state().state).toBe('enrolled-unavailable');
			const report = await requestHostStatus(dir);
			expect('managed' in report).toBe(false);
			expect(report.managedUnavailable).toContain('cannot be opened');
			expect(report.managedUnavailable).toContain(
				'no protected seal exists in a plain Node process'
			);
			expect(report.managedUnavailable).toContain('no protected custody');
		});

		it('logs a lifecycle that fails to attach or close, and finishes either way', async () => {
			const host = await startRuntimeHost(
				{
					...options(),
					managedLifecycle: {
						attach: async () => {
							throw new Error('socket refused');
						},
						close: async () => {
							throw new Error('already closed');
						},
					},
				},
				noCue
			);
			expect(lines).toContain('Re-attaching the managed standing failed: socket refused');
			expect(readCliServerInfoFrom(dir)?.pid).toBe(process.pid);
			await host.stop();
			expect(lines).toContain('Closing the managed standing failed: already closed');
			expect(lines[lines.length - 1]).toBe('Host stopped.');
			expect(fs.existsSync(path.join(dir, 'maestro-runtime.lock'))).toBe(false);
		});
	});

	it('serves the Cue answers of the engine it runs, and echoes the ones it cannot give', async () => {
		const host = await startRuntimeHost(options(), {
			...noCue,
			startCue: async () => ({
				...idleCue(),
				state: () => ({ state: 'running' as const }),
				answer: async (message) =>
					message.type === 'get_cue_subscriptions'
						? { type: 'cue_subscriptions', subscriptions: [{ id: 'a1::beat::beat' }] }
						: undefined,
			}),
		});
		running.push(host);

		const connection = new BridgeConnection({ userDataDir: dir });
		await connection.connect();
		try {
			await expect(
				connection.sendCommand({ type: 'get_cue_subscriptions' }, 'cue_subscriptions')
			).resolves.toMatchObject({ subscriptions: [{ id: 'a1::beat::beat' }] });
			await expect(
				connection.sendCommand({ type: 'get_cue_activity' }, 'cue_activity')
			).rejects.toMatchObject({ name: 'UnsupportedCommandError', hostKind: 'headless' });
		} finally {
			connection.disconnect();
		}
	});

	it('unpublishes first on stop, releases the lock, and closes the port', async () => {
		const host = await start();
		await host.stop();
		await host.stopped;

		expect(readCliServerInfoFrom(dir)).toBeNull();
		expect(fs.existsSync(path.join(dir, 'maestro-runtime.lock'))).toBe(false);
		await expect(requestHostStatus(dir)).rejects.toThrow();
		// A host that has stopped can be started again on the same directory.
		const again = await start();
		expect(readCliServerInfoFrom(dir)?.port).toBe(again.server.port);
	});

	it('stop is idempotent and does not remove the discovery file of a newer host', async () => {
		const host = await start();
		// Another host published since: its file is not ours to delete.
		writeCliServerInfoTo(dir, {
			port: 1,
			token: 't',
			pid: process.pid + 1,
			startedAt: Date.now(),
		});
		await Promise.all([host.stop(), host.stop()]);
		expect(readCliServerInfoFrom(dir)?.pid).toBe(process.pid + 1);
	});

	it('stops when the server asks to', async () => {
		const host = await start();
		expect(await requestHostStop(dir, {})).toEqual({ stopping: true });
		await host.stopped;
		expect(lines[lines.length - 1]).toBe('Host stopped.');
	});

	it('refuses a directory a live desktop is serving', async () => {
		// Any live pid that is not this process stands in for the desktop.
		writeCliServerInfoTo(dir, { port: 9, token: 't', pid: process.ppid, startedAt: Date.now() });
		await expect(startRuntimeHost(options(), noCue)).rejects.toBeInstanceOf(HostStartError);
		// Nothing was served and the other host's file is untouched.
		expect(readCliServerInfoFrom(dir)?.pid).toBe(process.ppid);
	});

	it('refuses to start from a bundle whose prompts cannot load, before it takes the directory', async () => {
		// Explicitly model a bundle copied without prompts, even if TMPDIR is inside this checkout.
		const createRuntime = vi.fn();
		await expect(
			startRuntimeHost(options(), {
				startCue: async () => idleCue(),
				promptsLoad: () => false,
				createRuntime,
			})
		).rejects.toBeInstanceOf(HostPromptsMissingError);
		await expect(
			startRuntimeHost(options(), {
				startCue: async () => idleCue(),
				promptsLoad: () => false,
				createRuntime,
			})
		).rejects.toThrow(/prompts/);

		expect(createRuntime).not.toHaveBeenCalled();
		expect(fs.existsSync(path.join(dir, 'maestro-runtime.lock'))).toBe(false);
		expect(readCliServerInfoFrom(dir)).toBeNull();
	});

	it('starts from a checkout, where the prompts are found from the bundle directory', async () => {
		// `dist/cli` is where the CLI bundle sits in a checkout; the probe is the real one.
		const host = await startRuntimeHost(
			{ ...options(), moduleDirectory: path.resolve(__dirname, '../../../../dist/cli') },
			{ startCue: async () => idleCue(), composeManaged: noCue.composeManaged }
		);
		running.push(host);
		expect(readCliServerInfoFrom(dir)?.pid).toBe(process.pid);
	});

	describe('sleep prevention', () => {
		it('holds while a Cue run is in flight, releases when idle, and reports it in status', async () => {
			const recorded = recordingGuard();
			const createSleepGuard = vi.fn(() => recorded.guard);
			let cueRuns = 0;
			let workChanged: (() => void) | undefined;
			const host = await startRuntimeHost(options(), {
				...noCue,
				createSleepGuard,
				startCue: async (context) => {
					workChanged = context.onWorkChanged;
					return { ...idleCue(), activeRuns: () => cueRuns };
				},
			});
			running.push(host);
			expect(createSleepGuard).toHaveBeenCalledWith(
				expect.objectContaining({ enabled: true, pid: process.pid })
			);

			cueRuns = 1;
			workChanged?.();
			// A burst of changes is one look, taken on the next turn of the event loop.
			workChanged?.();
			await vi.waitFor(() => expect(recorded.calls).toEqual([true]));
			expect(await requestHostStatus(dir)).toMatchObject({ preventingSleep: true });

			cueRuns = 0;
			workChanged?.();
			await vi.waitFor(() => expect(recorded.calls).toEqual([true, false]));
			expect(await requestHostStatus(dir)).toMatchObject({ preventingSleep: false });

			await host.stop();
			expect(recorded.stopped()).toBe(true);
		});

		it('looks at the work again on a runtime event', async () => {
			const recorded = recordingGuard();
			const host = await startRuntimeHost(options(), {
				...noCue,
				createSleepGuard: () => recorded.guard,
			});
			running.push(host);

			const client = createWsMaestroClient({ userDataDir: dir, reconcileIntervalMs: 0 });
			try {
				await client.connection.connect();
				// Renaming the agent raises `agent.updated` in the runtime.
				await client.agents.update('a1', { name: 'Renamed' });
				await vi.waitFor(() => expect(recorded.calls).toContain(false));
			} finally {
				await client.connection.close();
			}
		});

		it('is off under --no-prevent-sleep', async () => {
			const createSleepGuard = vi.fn(() => recordingGuard().guard);
			const host = await startRuntimeHost(
				{ ...options(), preventSleep: false },
				{ ...noCue, createSleepGuard }
			);
			running.push(host);
			expect(createSleepGuard).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
		});
	});

	describe('Cue in the host', () => {
		it('hands Cue the runtime it serves', async () => {
			const startCue = vi.fn(async () => idleCue());
			const host = await startRuntimeHost(options(), { ...noCue, startCue });
			running.push(host);

			expect(startCue).toHaveBeenCalledWith({
				userDataDir: dir,
				settingsFile: path.join(dir, 'maestro-settings.json'),
				runtime: host.runtime,
				onWorkChanged: expect.any(Function),
			});
		});

		it('reports a Cue run as work and will not stop over it without force', async () => {
			let cueRuns = 1;
			const host = await startRuntimeHost(options(), {
				...noCue,
				startCue: async () => ({ ...idleCue(), activeRuns: () => cueRuns }),
			});
			running.push(host);

			expect((await requestHostStatus(dir)).work).toMatchObject({ turns: 0, cueRuns: 1 });
			// The same work in process, which is what a signal drain waits on.
			expect(host.work()).toEqual({ turns: 0, runs: [], rounds: 0, consults: 0, cueRuns: 1 });
			expect(await requestHostStop(dir, {})).toMatchObject({
				stopping: false,
				reason: 'work-in-flight',
				work: { cueRuns: 1 },
			});
			// Still serving: the refusal stopped nothing.
			expect(readCliServerInfoFrom(dir)?.pid).toBe(process.pid);

			cueRuns = 0;
			expect(await requestHostStop(dir, {})).toEqual({ stopping: true });
			await host.stopped;
		});

		it('on a forced stop ends the Cue runs and waits for them before the runtime closes', async () => {
			const seen: string[] = [];
			let cueStopped!: () => void;
			const host = await startRuntimeHost(options(), {
				...noCue,
				startCue: async () => ({
					...idleCue(),
					activeRuns: () => 1,
					stop: () =>
						new Promise<void>((resolve) => {
							// The runtime still holds the directory while Cue's runs are being ended.
							seen.push(
								fs.existsSync(path.join(dir, 'maestro-runtime.lock'))
									? 'cue-stop:locked'
									: 'cue-stop'
							);
							cueStopped = () => {
								seen.push('cue-stopped');
								resolve();
							};
						}),
				}),
			});
			running.push(host);

			expect(await requestHostStop(dir, { force: true })).toEqual({ stopping: true });
			await vi.waitFor(() => expect(seen).toEqual(['cue-stop:locked']));
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(fs.existsSync(path.join(dir, 'maestro-runtime.lock'))).toBe(true);
			expect(lines).not.toContain('Host stopped.');

			cueStopped();
			await host.stopped;
			expect(fs.existsSync(path.join(dir, 'maestro-runtime.lock'))).toBe(false);
			expect(lines[lines.length - 1]).toBe('Host stopped.');
		});

		/** The real host Cue over a fake engine that holds the lock, to see what a host stop does to it. */
		function engineCue() {
			const held: CueEngineLockInfo = {
				pid: process.pid,
				mode: 'standalone',
				startedAt: '2026-10-19T12:00:00.000Z',
			};
			const engine: HostCueEngine = {
				start: vi.fn(),
				stop: vi.fn(),
				triggerSubscription: vi.fn(() => true),
				getActiveRuns: vi.fn(() => []),
				stopAll: vi.fn(),
				drain: vi.fn(async () => ({})),
				forceStop: vi.fn(),
				refreshSession: vi.fn(),
				removeSession: vi.fn(),
			};
			const startCue: typeof startHostCue = (context) =>
				startHostCue(context, {
					isEnabled: async () => true,
					readLock: () => held,
					createEngine: async () => engine,
					startInbox: () => () => undefined,
					waitForRunsToEnd: async () => 0,
					pid: process.pid,
				});
			return { engine, startCue };
		}

		it('on `host stop` drains Cue with no wait, so the queue survives, and never stops the engine', async () => {
			const { engine, startCue } = engineCue();
			const host = await startRuntimeHost(options(), { ...noCue, startCue });
			running.push(host);
			expect(host.cue.state()).toEqual({ state: 'running' });

			expect(await requestHostStop(dir, {})).toEqual({ stopping: true });
			await host.stopped;
			expect(engine.drain).toHaveBeenCalledTimes(1);
			expect(engine.drain).toHaveBeenCalledWith({ timeoutMs: 0 });
			// `stop()` deletes the persisted queue the drain just wrote.
			expect(engine.stop).not.toHaveBeenCalled();
			expect(engine.stopAll).not.toHaveBeenCalled();
		});

		it('after a signal, the host stop joins the drain the signal started instead of starting another', async () => {
			const { engine, startCue } = engineCue();
			let finishDrain!: () => void;
			(engine.drain as ReturnType<typeof vi.fn>).mockImplementation(
				() =>
					new Promise((resolve) => {
						finishDrain = () => resolve({});
					})
			);
			const host = await startRuntimeHost(options(), { ...noCue, startCue });
			running.push(host);

			const drained = host.cue.drain(30_000);
			await vi.waitFor(() => expect(engine.drain).toHaveBeenCalledWith({ timeoutMs: 30_000 }));
			const stopping = host.stop();
			await new Promise((resolve) => setTimeout(resolve, 20));
			// Still draining: the runtime keeps the directory until Cue is done.
			expect(fs.existsSync(path.join(dir, 'maestro-runtime.lock'))).toBe(true);
			finishDrain();
			await Promise.all([drained, stopping]);
			expect(engine.drain).toHaveBeenCalledTimes(1);
			expect(engine.stop).not.toHaveBeenCalled();
		});

		it('finishes stopping when Cue fails to stop, and says so', async () => {
			const host = await startRuntimeHost(options(), {
				...noCue,
				startCue: async () => ({
					...idleCue(),
					stop: async () => {
						throw new Error('db closed');
					},
				}),
			});
			await host.stop();
			expect(lines).toContain('Stopping Cue failed: db closed');
			expect(fs.existsSync(path.join(dir, 'maestro-runtime.lock'))).toBe(false);
		});
	});
	describe('the round parent custody a host composes (MCOMP-17-03CC)', () => {
		// A host adapter whose custody reads `status`: ok is an enrolled installation, none is not.
		const hostManaged = (status: 'ok' | 'none') => ({
			host: (installation: Parameters<typeof createManagedHostAdapter>[0]['installation']) => {
				const view: ManagedIdentityView =
					status === 'none'
						? { status: 'none', reason: null, message: null, record: null }
						: {
								status: 'ok',
								reason: null,
								message: null,
								record: {
									version: 1,
									installationId: installation.installationId,
									tenantId: 'tenant-1',
									orgId: 'org-1',
									enrollmentId: 'enr-1',
									endpoint: {
										socketPath: '/tmp/endpoint.sock',
										bindingDigest: 'a'.repeat(64),
										trustRootDigest: null,
									},
									management: 'enrolled',
									registration: null,
									policy: { desiredRevision: 2, appliedRevision: 2, observedAt: null },
									enrolledAt: '2026-10-22T12:00:00.000Z',
									updatedAt: '2026-10-22T12:00:00.000Z',
								},
							};
				return createManagedHostAdapter({
					installation,
					identity: { read: () => view },
					endpoint: null,
					status: () => ({
						identity: view,
						connection: null,
						endpoint: null,
						authority: 'none',
						reason: 'not attached in this process',
						pendingApproval: null,
						lastDenial: null,
					}),
				});
			},
		});

		async function startWith(
			managed: NonNullable<Parameters<typeof createMaestroRuntime>[0]['managed']>
		) {
			const createRuntime = vi.fn(createMaestroRuntime);
			const startServer = vi.fn(startRuntimeServer);
			const host = await startRuntimeHost(
				{ ...options(), managed },
				{ ...noCue, createRuntime, startServer }
			);
			running.push(host);
			return {
				host,
				runtimeManaged: createRuntime.mock.calls[0][0].managed!,
				roundParents: startServer.mock.calls[0][0].roundParents,
			};
		}

		it('serves one custody to the handler and gives the runtime its lookup on an enrolled host', async () => {
			const managed = hostManaged('ok');
			const { host, runtimeManaged, roundParents } = await startWith(managed);
			expect(host.runtime.managedBinding.state().state).toBe('enrolled');
			// The standing the caller composed reaches the runtime whole.
			expect(runtimeManaged.host).toBe(managed.host);
			expect(host.runtime.managedHost).not.toBeNull();

			expect(roundParents).toBeDefined();
			const lookup = runtimeManaged.backgroundParentContext;
			expect(typeof lookup).toBe('function');
			// One stable function: a round that started with it can tell when it goes away.
			expect(runtimeManaged.backgroundParentContext).toBe(lookup);

			// The lookup the runtime holds is the custody the handler runs rounds in.
			const inRound = await roundParents!.run(async () => lookup!('room-turn-1'));
			expect(inRound).toMatchObject({ ok: true });
			expect(inRound.ok && inRound.context.installation.installationId).toBe(
				host.runtime.installation.installationId
			);
			// Bound to its round, the process still finds its parent after the round returns.
			expect(lookup!('room-turn-1')).toMatchObject({ ok: true });
			// A process no round of this host started has no parent.
			expect(lookup!('stray-turn')).toMatchObject({ ok: false, code: 'unauthenticated' });
		});

		it('gives the runtime no lookup while the binding is standalone, and runs a round with no parent', async () => {
			const { host, runtimeManaged, roundParents } = await startWith(hostManaged('none'));
			expect(host.runtime.managedBinding.state().state).toBe('standalone');
			expect('backgroundParentContext' in runtimeManaged).toBe(true);
			expect(runtimeManaged.backgroundParentContext).toBeUndefined();
			expect(roundParents).toBeDefined();
			await expect(roundParents!.run(async () => 'ran')).resolves.toBe('ran');
		});

		it('keeps a lookup the caller supplies and composes no custody of its own', async () => {
			const own = vi.fn(() => ({ ok: false, code: 'unauthenticated', problems: ['own'] }) as const);
			const { runtimeManaged, roundParents } = await startWith({
				...hostManaged('ok'),
				backgroundParentContext: own,
			});
			expect(runtimeManaged.backgroundParentContext).toBe(own);
			expect(roundParents).toBeUndefined();
		});
	});

	describe('the bridge listener (MCOMP-21-03)', () => {
		const enrolledRecord = (installationId: string) => ({
			version: 1,
			installationId,
			tenantId: 'tenant-1',
			orgId: 'org-1',
			enrollmentId: 'enr-1',
			endpoint: {
				socketPath: '/tmp/endpoint.sock',
				bindingDigest: 'a'.repeat(64),
				trustRootDigest: null,
			},
			management: 'enrolled' as const,
			registration: null,
			policy: { desiredRevision: 2, appliedRevision: 2, observedAt: null },
			enrolledAt: '2026-10-22T12:00:00.000Z',
			updatedAt: '2026-10-22T12:00:00.000Z',
		});
		const enrolledManaged = () => ({
			host: (installation: Parameters<typeof createManagedHostAdapter>[0]['installation']) => {
				const view: ManagedIdentityView = {
					status: 'ok',
					reason: null,
					message: null,
					record: enrolledRecord(installation.installationId),
				};
				return createManagedHostAdapter({
					installation,
					identity: { read: () => view },
					endpoint: null,
					status: () => ({
						identity: view,
						connection: null,
						endpoint: null,
						authority: 'none',
						reason: 'not attached in this process',
						pendingApproval: null,
						lastDenial: null,
					}),
				});
			},
		});
		const real = { ...noCue, listenerAuthority: runtimeHostListenerAuthority };

		it('standalone: binds loopback under the explicit kind and holds nothing', async () => {
			const startServer = vi.fn(startRuntimeServer);
			const host = await startRuntimeHost(options(), { ...real, startServer });
			running.push(host);
			expect(host.runtime.managedBinding.state().state).toBe('standalone');
			expect(startServer.mock.calls[0][0].address).toBe(RUNTIME_HOST_BIND);
			expect(RUNTIME_HOST_BIND).toBe('127.0.0.1');
			expect(heldListeners()).toEqual([]);
			expect(readCliServerInfoFrom(dir)?.port).toBe(host.server.port);
		});

		it('enrolled with no delivered ceiling: refused by name before telemetry, Cue or a socket, and the directory is released', async () => {
			const startCue = vi.fn(async () => idleCue());
			const startServer = vi.fn(startRuntimeServer);
			const error = await startRuntimeHost(
				{ ...options(), managed: enrolledManaged() },
				{ ...real, startCue, startServer }
			).then(
				() => null,
				(caught: unknown) => caught
			);
			expect(isListenerDeniedError(error)).toBe(true);
			expect((error as Error).message).toBe(
				'[managed-unavailable] the managed listener ceiling is unavailable (no listener ceiling is installed for policy revision 2); the runtime-host listener on 127.0.0.1:0 is not opened'
			);
			expect(startCue).not.toHaveBeenCalled();
			expect(startServer).not.toHaveBeenCalled();
			expect(readCliServerInfoFrom(dir)).toBeNull();
			expect(heldListeners()).toMatchObject([
				{ kind: 'runtime-host', bind: '127.0.0.1', code: 'unavailable', policyRevision: 2 },
			]);
			// Released: the next process takes the same directory at once.
			const next = await createMaestroRuntime({
				dataDir: dir,
				productionDataDir: dir,
				mode: 'host',
			});
			expect(next.ok).toBe(true);
			if (next.ok) await next.runtime.connection.close();
		});

		it('an unreadable standing (a sealed record this process cannot open) is managed, never standalone', async () => {
			fs.writeFileSync(path.join(dir, 'enterprise-identity.bin'), 'unopenable sealed record');
			await expect(startRuntimeHost(options(), real)).rejects.toThrow(
				'[managed-unavailable] the managed listener ceiling is unavailable (no applied policy revision is known for this host); the runtime-host listener on 127.0.0.1:0 is not opened'
			);
			expect(readCliServerInfoFrom(dir)).toBeNull();
		});

		it('names its own kind: a ceiling admitting only web refuses the bridge, one admitting the bridge binds', async () => {
			await expect(
				startRuntimeHost(
					{ ...options(), managed: enrolledManaged() },
					{ ...noCue, listenerAuthority: deliveredCeiling([{ kind: 'web', reach: 'any' }]) }
				)
			).rejects.toThrow(
				'[managed-kind-denied] the listener ceiling admits no runtime-host listener'
			);
			const host = await startRuntimeHost({ ...options(), managed: enrolledManaged() }, noCue);
			running.push(host);
			expect(host.runtime.managedBinding.state().state).toBe('enrolled');
			expect(readCliServerInfoFrom(dir)?.port).toBe(host.server.port);
		});

		it('judges the runtime binding per bind: standalone admits, every managed state refuses under its revision', () => {
			const record = { policyRevision: 7 } as never;
			const authorityOver = (state: unknown, applied: number | null = 9) =>
				runtimeHostListenerAuthority({
					managedBinding: { state: () => state } as never,
					managedHost: { policyStatus: () => ({ appliedRevision: applied }) } as never,
				});
			const request = { kind: 'runtime-host' as const, bind: '127.0.0.1', port: 0 };
			expect(authorityOver({ state: 'standalone', files: [] }).evaluateListener(request)).toEqual({
				allowed: true,
			});
			expect(
				authorityOver({ state: 'enrolled', record, file: 'b' }).evaluateListener(request)
			).toMatchObject({ allowed: false, code: 'unavailable', managed: { policyRevision: 9 } });
			expect(
				authorityOver({
					state: 'enrolled-unavailable',
					record,
					file: 'b',
					reason: 'r',
				}).evaluateListener(request)
			).toMatchObject({ allowed: false, code: 'unavailable', managed: { policyRevision: 7 } });
			expect(
				authorityOver({ state: 'unreadable', file: 'b', reason: 'r' }).evaluateListener(request)
			).toMatchObject({ allowed: false, code: 'unavailable', managed: { policyRevision: null } });
			// Read on every bind: the same authority follows the binding as it changes.
			let state: unknown = { state: 'standalone', files: [] };
			const live = runtimeHostListenerAuthority({
				managedBinding: { state: () => state } as never,
				managedHost: null,
			});
			expect(live.evaluateListener(request).allowed).toBe(true);
			state = { state: 'enrolled', record, file: 'b' };
			expect(live.evaluateListener(request)).toMatchObject({
				allowed: false,
				managed: { policyRevision: 7 },
			});
		});
	});
});
