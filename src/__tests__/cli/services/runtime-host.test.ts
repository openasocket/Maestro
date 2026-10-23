/**
 * The detached host on a temp data directory: the real runtime, the real server, and the real
 * discovery file, with Cue replaced (the engine has its own tests) and the clock real. What is
 * proven here is the order a host starts and stops in, and that what it publishes is attachable.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HostCue } from '../../../cli/services/host-cue';
import { composeHostManaged } from '../../../cli/services/host-managed';
import {
	HostPromptsMissingError,
	HostStartError,
	startRuntimeHost,
	type RunningHost,
} from '../../../cli/services/runtime-host';
import { createEnterpriseIdentityStore } from '../../../main/enterprise/identity-store';
import type { Anchor } from '../../../main/utils/keyring-anchor';
import { fakeAnchor, fakeSeal } from '../../main/enterprise/fakeCustody';
import {
	createManagedHostAdapter,
	createWsMaestroClient,
	readCliServerInfoFrom,
	requestHostStatus,
	requestHostStop,
	writeCliServerInfoTo,
	type ManagedEnrollmentStatus,
	type ManagedIdentityView,
} from '../../../shared/maestro-lib';

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
		stop: async () => undefined,
	});
	// The temp directory is no bundle, so the prompt probe is answered for it.
	const noCue = { startCue: async () => idleCue(), promptsLoad: () => true };

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
			expect(host.runtime.managedHost).toBeNull();
			// An enrolled directory with no standing stays enrolled-unavailable, never standalone.
			expect(host.runtime.managedBinding.state().state).toBe('enrolled-unavailable');
			const report = await requestHostStatus(dir);
			expect('managed' in report).toBe(false);
			expect(report.managedUnavailable).toBe(standing.reason);
			expect(report.managedUnavailable).toContain(
				'no protected seal exists in a plain Node process'
			);
			expect(report.managedUnavailable).toContain('cannot be opened here');
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
		// `dir` holds no prompts/core, which is the bundle copied without its prompts.
		const createRuntime = vi.fn();
		await expect(
			startRuntimeHost(options(), { startCue: async () => idleCue(), createRuntime })
		).rejects.toBeInstanceOf(HostPromptsMissingError);
		await expect(
			startRuntimeHost(options(), { startCue: async () => idleCue(), createRuntime })
		).rejects.toThrow(/prompts/);

		expect(createRuntime).not.toHaveBeenCalled();
		expect(fs.existsSync(path.join(dir, 'maestro-runtime.lock'))).toBe(false);
		expect(readCliServerInfoFrom(dir)).toBeNull();
	});

	it('starts from a checkout, where the prompts are found from the bundle directory', async () => {
		// `dist/cli` is where the CLI bundle sits in a checkout; the probe is the real one.
		const host = await startRuntimeHost(
			{ ...options(), moduleDirectory: path.resolve(__dirname, '../../../../dist/cli') },
			{ startCue: async () => idleCue() }
		);
		running.push(host);
		expect(readCliServerInfoFrom(dir)?.pid).toBe(process.pid);
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
});
