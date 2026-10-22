/**
 * The detached host's transport, end to end: a real runtime on a temp data directory, served by
 * `startRuntimeServer`, read by the real `createWsMaestroClient`. Nothing is faked between the two
 * but the clock, the pid probe, and the provider probe, so a request the client sends is answered
 * by the same handler a `maestro-cli host` answers it with.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CLI_SECRET_HEADER } from '../../../webLogin';
import { DEFAULT_TAB_DEFAULTS } from '../../agents/rules';
import { writeCliServerInfoTo } from '../../client/discovery';
import { requestHostStatus, requestHostStop } from '../../client/host-control';
import type { ClientResult, MaestroClient, MaestroEvent } from '../../client/types';
import { createWsMaestroClient } from '../../client/ws-client';
import { sshRemoteEndpointProblems } from '../../launch/ssh-remote-resolver';
import type {
	ManagedEnrollmentStatus,
	ManagedIdentityRecord,
	ManagedIdentityView,
} from '../../managed/endpoint-port';
import { createManagedHostAdapter, managedAuthorityId } from '../../managed/host-adapter';
import { MANAGED_CONTRACT_VERSION } from '../../managed/types';
import { getVisibleAgentDefinitions } from '../../providers/definitions';
import { createMaestroRuntime, type MaestroRuntime, type RuntimeDeps } from '../index';
import {
	hostManagedStanding,
	hostManagedUnavailable,
	startRuntimeServer,
	type RuntimeServer,
} from '../server';
import type { WatchDirectory } from '../settings-watch';

const T0 = Date.parse('2026-10-04T12:00:00Z');
const TOKEN = 'test-token';
const SECRET = 'test-secret';

const watchDirectory: WatchDirectory = () => ({ close: () => undefined });

function deps(): Partial<RuntimeDeps> {
	let id = 0;
	let now = 1_000;
	return {
		pid: 100,
		now: () => T0,
		bootTime: () => T0 - 3_600_000,
		isPidAlive: (pid) => pid === 100,
		hostname: () => 'testhost',
		rules: { newId: () => `id-${++id}`, now: () => ++now, random: () => 0 },
		checkCwd: () => null,
		readTabDefaults: async () => DEFAULT_TAB_DEFAULTS,
		watchDirectory,
		probeBinary: async (binaryName) => ({ exists: true, path: `/fake/bin/${binaryName}` }),
	};
}

function value<T>(result: ClientResult<T>): T {
	if (!result.ok) throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
	return result.value;
}
function errorOf(result: ClientResult<unknown>) {
	if (result.ok) throw new Error('expected a failure');
	return result.error;
}

async function waitFor(check: () => boolean, what: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!check()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe('runtime server', () => {
	let dir: string;
	let runtime: MaestroRuntime;
	let server: RuntimeServer;
	let client: MaestroClient;
	let stopRequests: number;
	let inFlight: { turns: number };
	/** Cue runs the host process says are in flight; undefined for a host that reports none. */
	let cueRuns: number | undefined;

	function publish(overrides: Partial<{ token: string; cliSecret: string }> = {}): void {
		writeCliServerInfoTo(dir, {
			port: server.port,
			token: overrides.token ?? TOKEN,
			pid: process.pid,
			startedAt: Date.now(),
			cliSecret: overrides.cliSecret ?? SECRET,
			hostKind: 'headless',
		});
	}

	beforeEach(async () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-server-'));
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
						aiTabs: [
							{
								id: 't1',
								agentSessionId: null,
								name: null,
								logs: [{ id: 'l1', timestamp: 10, source: 'user', text: 'hello' }],
							},
						],
						activeTabId: 't1',
						unifiedTabOrder: [{ type: 'ai', id: 't1' }],
					},
				],
				activeSessionId: 'a1',
			})
		);
		const started = await createMaestroRuntime({ dataDir: dir, mode: 'host', deps: deps() });
		if (!started.ok) throw new Error(`refused: ${started.refusal.message}`);
		inFlight = { turns: 0 };
		// A wrapper so a test can claim work in flight without running a provider.
		runtime = new Proxy(started.runtime, {
			get: (target, key) =>
				key === 'turnsInFlight' ? () => inFlight.turns : Reflect.get(target, key),
		});
		stopRequests = 0;
		cueRuns = undefined;
		server = await startRuntimeServer({
			runtime,
			token: TOKEN,
			cliSecret: SECRET,
			onStopRequested: () => {
				stopRequests += 1;
			},
			describe: () => ({
				cue: { state: 'disabled' },
				version: '9.9.9',
				...(cueRuns !== undefined ? { cueRuns } : {}),
			}),
		});
		publish();
		client = createWsMaestroClient({
			userDataDir: dir,
			reconcileIntervalMs: 0,
			heartbeatIntervalMs: 60_000,
		});
	});

	afterEach(async () => {
		await client.connection.close();
		await server.close();
		await runtime.connection.close();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('is attached as a headless host and reads the agents', async () => {
		const host = value(await client.connection.connect());
		expect(host.kind).toBe('headless');
		expect(host.label).toBe(`headless pid ${process.pid}`);
		const agents = value(await client.agents.list());
		expect(agents.map((agent) => agent.name)).toEqual(['Alpha']);
		expect(value(await client.tabs.transcript('a1', 't1')).map((entry) => entry.text)).toEqual([
			'hello',
		]);
	});

	it('creates, edits, and removes an agent through the runtime', async () => {
		value(await client.connection.connect());
		const { agentId } = value(
			await client.agents.create({ name: 'Beta', provider: 'claude-code', cwd: dir })
		);
		expect(value(await runtime.agents.get(agentId)).name).toBe('Beta');

		value(await client.agents.rename(agentId, 'Gamma'));
		const receipt = value(await client.agents.update(agentId, { model: 'opus' }));
		expect(receipt.applied).toEqual(['model']);
		const stored = value(await runtime.agents.get(agentId));
		expect(stored.name).toBe('Gamma');
		expect(stored.customModel).toBe('opus');

		value(await client.agents.remove(agentId));
		expect(errorOf(await runtime.agents.get(agentId)).code).toBe('not-found');
	});

	it('runs groups and tabs', async () => {
		value(await client.connection.connect());
		const { groupId } = value(await client.groups.create({ name: 'Work' }));
		value(await client.groups.moveAgent('a1', groupId));
		expect(value(await runtime.agents.get('a1')).groupId).toBe(groupId);
		value(await client.groups.rename(groupId, 'Play'));
		// Group names are stored upper-cased.
		expect(value(await runtime.groups.list()).map((group) => group.name)).toEqual(['PLAY']);
		value(await client.groups.remove(groupId));
		expect(value(await runtime.groups.list())).toEqual([]);

		const { tabId } = value(await client.tabs.create('a1'));
		value(await client.tabs.rename('a1', tabId, 'Notes'));
		value(await client.tabs.star('a1', tabId, true));
		value(await client.tabs.update('a1', tabId, { readOnly: true }));
		const tab = value(await runtime.tabs.list('a1')).find((candidate) => candidate.id === tabId);
		expect(tab).toMatchObject({ name: 'Notes', starred: true, readOnlyMode: true });
		value(await client.tabs.close('a1', tabId));
		expect(value(await runtime.tabs.list('a1')).map((candidate) => candidate.id)).toEqual(['t1']);
	});

	it("answers managed operations in the runtime's own scope, end to end (MRC-08-05)", async () => {
		value(await client.connection.connect());
		const managed = client.managed;
		if (!managed?.scope) throw new Error('the WebSocket client exposes managed.scope');
		const scope = value(await managed.scope());
		expect(scope).toEqual({
			installation: runtime.installation,
			actor: { kind: 'human', id: `operator:${runtime.installation.installationId}` },
			policyRevision: null,
			binding: 'standalone',
		});
		const context = (actor = scope.actor) => ({
			contractVersion: MANAGED_CONTRACT_VERSION,
			installation: scope.installation,
			origin: 'cli' as const,
			actor,
			delegation: { chain: [], grantRef: null },
			identity: {
				requestId: 'req-1',
				idempotencyKey: 'key-1',
				attemptId: 'attempt-1',
				runId: null,
				rootRunId: null,
				parentRunId: null,
			},
			policyRevision: scope.policyRevision,
			workflow: null,
			traceId: 'trace-1',
			requestedCapabilities: ['capabilities.negotiate' as const, 'agents.list' as const],
		});
		// The facade verified the context the handler admitted: the actor is the scope's, by the host's own verifier.
		expect(value(await managed.identity({ context: context(), input: {} }))).toMatchObject({
			status: 'ok',
			requestId: 'req-1',
			value: {
				actor: scope.actor,
				installation: runtime.installation,
				binding: 'standalone',
				verification: { peer: 'in-process' },
			},
		});
		expect(
			value(await managed.agents({ context: context(), input: { cursor: null, limit: 5 } }))
		).toMatchObject({ status: 'ok', value: { items: [{ agentId: 'a1' }], nextCursor: null } });
		// Another principal is refused at the bridge, on state, before the facade sees it.
		const someoneElse = await managed.identity({
			context: context({ kind: 'service', id: 'fleet' }),
			input: {},
		});
		expect(errorOf(someoneElse)).toMatchObject({
			code: 'rejected',
			method: 'managed.identity',
			message: expect.stringContaining("host's own principal"),
		});
	});

	it('answers settings and providers', async () => {
		fs.writeFileSync(
			path.join(dir, 'maestro-settings.json'),
			JSON.stringify({ fontSize: 15, sshRemotes: [{ id: 'r1', name: 'box' }] })
		);
		value(await client.connection.connect());
		expect(value(await client.settings.get(['fontSize', 'missing']))).toEqual({ fontSize: 15 });
		expect(value(await client.settings.sshRemotes())).toEqual([{ id: 'r1', name: 'box' }]);
		const providers = value(await client.providers.list());
		expect(providers.find((provider) => provider.id === 'claude-code')?.available).toBe(true);
	});

	it('reports a missing agent as not found and a refused move as rejected', async () => {
		value(await client.connection.connect());
		expect(errorOf(await client.tabs.rename('nope', 't', 'x')).code).toBe('not-found');
		expect(errorOf(await client.turns.send('nope', 't', { text: 'hi' })).code).toBe('not-found');
		expect(errorOf(await client.autoRun.launchGoal('nope', { goal: 'x' })).code).toBe('not-found');
	});

	it('tells an attached client about a change another writer made', async () => {
		value(await client.connection.connect());
		const seen: MaestroEvent[] = [];
		client.events.subscribe((event) => seen.push(event), { types: ['agent.updated'] });
		value(await runtime.agents.rename('a1', 'Renamed'));
		await waitFor(
			() => seen.some((event) => event.type === 'agent.updated' && event.agent.name === 'Renamed'),
			'the rename'
		);
	});

	it('answers group chat and consult requests with a reason, not a crash', async () => {
		value(await client.connection.connect());
		expect(value(await client.groupChats.list())).toEqual([]);
		expect(errorOf(await client.groupChats.get('nope')).code).toBe('not-found');
		expect(errorOf(await client.groupChats.send('nope', 'hi')).code).toBe('rejected');
		expect(
			errorOf(await client.groupChats.create({ name: 'x', participantIds: ['nope'] })).code
		).toBe('not-found');
		expect(
			errorOf(await client.consults.ask({ targetAgentId: 'nope', question: 'hi' })).message
		).toMatch(/nope/);
	});

	describe('who may connect', () => {
		const url = (token = TOKEN) => `ws://127.0.0.1:${server.port}/${token}/ws`;

		/** Resolves with the HTTP status the upgrade was refused with, or 'open'. */
		function attempt(target: string, headers: Record<string, string>): Promise<number | 'open'> {
			return new Promise((resolve) => {
				const ws = new WebSocket(target, { headers });
				ws.on('open', () => {
					ws.close();
					resolve('open');
				});
				ws.on('unexpected-response', (_request, response) => resolve(response.statusCode ?? 0));
				ws.on('error', () => undefined);
			});
		}

		it('admits the token and the secret together', async () => {
			expect(await attempt(url(), { [CLI_SECRET_HEADER]: SECRET })).toBe('open');
		});

		it('refuses a wrong token, a wrong secret, and a missing secret', async () => {
			expect(await attempt(url('other'), { [CLI_SECRET_HEADER]: SECRET })).toBe(401);
			expect(await attempt(url(), { [CLI_SECRET_HEADER]: 'wrong' })).toBe(401);
			expect(await attempt(url(), {})).toBe(401);
		});

		it('refuses a browser, which always sends an Origin', async () => {
			expect(
				await attempt(url(), { [CLI_SECRET_HEADER]: SECRET, Origin: 'http://evil.example' })
			).toBe(403);
		});

		it('echoes a message it does not know, which a client reads as unsupported', async () => {
			const reply = await new Promise<Record<string, unknown>>((resolve, reject) => {
				const ws = new WebSocket(url(), { headers: { [CLI_SECRET_HEADER]: SECRET } });
				ws.on('error', reject);
				ws.on('open', () => ws.send(JSON.stringify({ type: 'no_such_message', requestId: 'r1' })));
				ws.on('message', (data) => {
					const frame = JSON.parse(data.toString()) as Record<string, unknown>;
					if (frame.type !== 'echo') return;
					ws.close();
					resolve(frame);
				});
			});
			expect(reply).toMatchObject({ originalType: 'no_such_message', originalRequestId: 'r1' });
		});
	});

	describe('host control', () => {
		it('reports the host', async () => {
			const report = await requestHostStatus(dir);
			expect(report).toMatchObject({
				pid: 100,
				version: '9.9.9',
				clients: 1,
				work: { turns: 0, runs: [] },
				cue: { state: 'disabled' },
			});
			expect(report.lock.mode).toBe('host');
			// A standalone host attests no managed standing at all: the key is absent, not null.
			expect('managed' in report).toBe(false);
		});

		it('refuses to stop while a turn is in flight, and stops when forced', async () => {
			inFlight.turns = 1;
			const refused = await requestHostStop(dir, {});
			expect(refused).toEqual({
				stopping: false,
				reason: 'work-in-flight',
				work: { turns: 1, runs: [], rounds: 0, consults: 0 },
			});
			expect(stopRequests).toBe(0);

			const forced = await requestHostStop(dir, { force: true });
			expect(forced).toEqual({ stopping: true });
			await vi.waitFor(() => expect(stopRequests).toBe(1));
		});

		it('counts a Cue run as work: it shows in status and a plain stop is refused', async () => {
			cueRuns = 2;
			expect((await requestHostStatus(dir)).work).toMatchObject({ turns: 0, cueRuns: 2 });

			const refused = await requestHostStop(dir, {});
			expect(refused).toEqual({
				stopping: false,
				reason: 'work-in-flight',
				work: { turns: 0, runs: [], rounds: 0, consults: 0, cueRuns: 2 },
			});
			expect(stopRequests).toBe(0);

			expect(await requestHostStop(dir, { force: true })).toEqual({ stopping: true });
			await vi.waitFor(() => expect(stopRequests).toBe(1));
		});

		it('stops with Cue running and none of its runs in flight', async () => {
			cueRuns = 0;
			expect(await requestHostStop(dir, {})).toEqual({ stopping: true });
			await vi.waitFor(() => expect(stopRequests).toBe(1));
		});

		it('stops an idle host without force', async () => {
			expect(await requestHostStop(dir, {})).toEqual({ stopping: true });
			await vi.waitFor(() => expect(stopRequests).toBe(1));
		});
	});
});

/**
 * The managed standing a host attests (MRC-08-04A): an enrolled runtime served by the real server,
 * with a host adapter over an in-memory custody view and an injected lifecycle standing (declared
 * doubles; nothing opens an endpoint socket). What is proven: the report carries the standing from
 * the host's own custody and policy, `registered` only while the lifecycle says so, the ssh rows are
 * this build's own and read `unverified`, a custody view short of `ok` attests nothing, and the
 * desktop's rule refuses this build's host by its own word.
 */
describe('runtime server managed standing', () => {
	let dir: string;
	let runtime: MaestroRuntime;
	let server: RuntimeServer;
	let view: ManagedIdentityView;
	let authority: ManagedEnrollmentStatus['authority'];

	function record(installationId: string): ManagedIdentityRecord {
		return {
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
			management: 'enrolled',
			registration: null,
			policy: { desiredRevision: 3, appliedRevision: 3, observedAt: new Date(T0).toISOString() },
			enrolledAt: new Date(T0).toISOString(),
			updatedAt: new Date(T0).toISOString(),
		};
	}
	const okView = (r: ManagedIdentityRecord): ManagedIdentityView => ({
		status: 'ok',
		reason: null,
		message: null,
		record: r,
	});
	const standing = (): ManagedEnrollmentStatus => ({
		identity: view,
		connection: null,
		endpoint: null,
		authority,
		reason: authority === 'registered' ? null : 'not attached in this process',
		pendingApproval: null,
		lastDenial: null,
	});

	beforeEach(async () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-server-managed-'));
		fs.writeFileSync(
			path.join(dir, 'maestro-sessions.json'),
			JSON.stringify({ sessions: [], activeSessionId: null })
		);
		authority = 'none';
		const started = await createMaestroRuntime({
			dataDir: dir,
			mode: 'host',
			managed: {
				host: (installation) => {
					view = okView(record(installation.installationId));
					return createManagedHostAdapter({
						installation,
						identity: { read: () => view },
						endpoint: null,
						status: standing,
						now: () => T0,
					});
				},
			},
			deps: deps(),
		});
		if (!started.ok) throw new Error(`refused: ${started.refusal.message}`);
		runtime = started.runtime;
		server = await startRuntimeServer({
			runtime,
			token: TOKEN,
			cliSecret: SECRET,
			onStopRequested: () => undefined,
		});
		writeCliServerInfoTo(dir, {
			port: server.port,
			token: TOKEN,
			pid: process.pid,
			startedAt: Date.now(),
			cliSecret: SECRET,
			hostKind: 'headless',
		});
	});

	afterEach(async () => {
		await server.close();
		await runtime.connection.close();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('attests the standing from its own custody and policy, with authority none while unattached', async () => {
		expect(runtime.managedBinding.state().state).toBe('enrolled');
		const report = await requestHostStatus(dir);
		expect(report.managed).toBeDefined();
		const managed = report.managed!;
		expect(managed).toMatchObject({
			contractVersion: MANAGED_CONTRACT_VERSION,
			installationId: runtime.installation.installationId,
			runtimeId: 'host-100',
			processEpoch: runtime.installation.processEpoch,
			tenantId: 'tenant-1',
			orgId: 'org-1',
			authorityId: managedAuthorityId(view.record!),
			policyRevision: 3,
			authority: 'none',
		});
		expect(managed.authorityId).toBe(runtime.managedHost!.authority.authorityId);
		// The routes are this build's own ssh rows for every provider the runtime serves: one row
		// per visible provider, each the `ssh` arrival, and none claiming confinement. The row's
		// `managed` is the confinement column of `providerRouteSupport` (`unsupported` here: the
		// launch route exists, `standalone` is `unverified`, but nothing confines it on the remote).
		expect(managed.routes.map((row) => row.providerId)).toEqual(
			getVisibleAgentDefinitions().map((definition) => definition.id)
		);
		for (const row of managed.routes) expect(row.route).toBe('ssh');
		expect(managed.routes.find((row) => row.providerId === 'claude-code')).toMatchObject({
			managed: 'unsupported',
			note: expect.stringContaining('containment on the remote is not proven here'),
		});
		expect(managed.routes.find((row) => row.providerId === 'hermes')).toMatchObject({
			managed: 'unsupported',
		});
		expect(managed.routes.some((row) => row.managed === 'implemented')).toBe(false);
	});

	it('attests registered only while the lifecycle says so, and the report follows the standing', async () => {
		authority = 'registered';
		expect((await requestHostStatus(dir)).managed?.authority).toBe('registered');
		authority = 'none';
		expect((await requestHostStatus(dir)).managed?.authority).toBe('none');
	});

	it('attests nothing when the custody view is short of ok, and again once it is', async () => {
		const ok = view;
		view = {
			status: 'untrusted',
			reason: 'rollback',
			message: 'The record was rolled back.',
			record: ok.record,
		};
		const untrusted = await requestHostStatus(dir);
		expect('managed' in untrusted).toBe(false);
		// With an adapter, the reason is the adapter's own custody view (MRC-08-04C).
		expect(untrusted.managedUnavailable).toBe('The record was rolled back.');
		view = { status: 'none', reason: null, message: null, record: null };
		const none = await requestHostStatus(dir);
		expect('managed' in none).toBe(false);
		expect('managedUnavailable' in none).toBe(false);
		view = ok;
		const attested = await requestHostStatus(dir);
		expect(attested.managed?.tenantId).toBe('tenant-1');
		expect('managedUnavailable' in attested).toBe(false);
	});

	it('names why no standing is reported: the custody view with an adapter, the host process without', () => {
		const read = (v: ManagedIdentityView) => ({ identity: { read: () => v } });
		expect(hostManagedUnavailable({ host: null })).toBeUndefined();
		expect(hostManagedUnavailable({ host: null, composed: 'no seal here' })).toBe('no seal here');
		expect(
			hostManagedUnavailable({ host: read(okView(record('i'))), composed: 'no seal here' })
		).toBeUndefined();
		expect(
			hostManagedUnavailable({
				host: read({ status: 'unprotected', reason: 'basic_text', message: null, record: null }),
			})
		).toBe('the identity custody reads unprotected');
		expect(
			hostManagedUnavailable({
				host: read({ status: 'untrusted', reason: 'foreign', message: 'Foreign.', record: null }),
				composed: 'ignored: the adapter speaks for itself',
			})
		).toBe('Foreign.');
	});

	it("is refused by the desktop's own rule, by this build's word, before any launch is handed over", async () => {
		authority = 'registered';
		const managed = (await requestHostStatus(dir)).managed;
		const problems = sshRemoteEndpointProblems(managed, {
			tenantId: 'tenant-1',
			orgId: 'org-1',
			providerId: 'claude-code',
			policyRevision: 3,
		});
		// The shape and the enterprise pass; the only refusal is the route this build does not confine.
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain('does not confine claude-code launches arriving over SSH');
		expect(problems[0]).toContain('route table says unsupported');
		// A peer in another enterprise is refused on that too, never admitted on the shape alone.
		expect(
			sshRemoteEndpointProblems(managed, {
				tenantId: 'tenant-2',
				orgId: 'org-1',
				providerId: 'claude-code',
				policyRevision: null,
			})
		).toEqual(expect.arrayContaining([expect.stringContaining('tenant tenant-1 / org org-1')]));
	});

	it('the producer alone: no adapter is no attestation, and the rows follow the providers named', () => {
		const installation = runtime.installation;
		expect(hostManagedStanding({ installation, host: null })).toBeUndefined();
		const host = runtime.managedHost!;
		const named = hostManagedStanding({ installation, host, providerIds: ['codex', 'hermes'] });
		expect(named?.routes).toEqual([
			expect.objectContaining({ providerId: 'codex', route: 'ssh', managed: 'unsupported' }),
			expect.objectContaining({ providerId: 'hermes', route: 'ssh', managed: 'unsupported' }),
		]);
		// An id no definition names has rows too (the capability table answers for any id), still never confined.
		const unknown = hostManagedStanding({ installation, host, providerIds: ['not-a-provider'] });
		expect(unknown?.routes.every((row) => row.managed !== 'implemented')).toBe(true);
	});
});
