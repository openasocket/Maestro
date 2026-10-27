/**
 * @file plugin-host-handlers.sinks.test.ts
 * @description The plugin effect sinks (MRC2-04-10): the OS hand-off, the
 * host's own execFile and the raw wss sockets, composed by
 * `createPluginEffectSinks` behind the plugin host instead of inline in
 * src/main/index.ts. Standalone every sink runs as it always has; under
 * management each is admitted per call: the broker's receipt binds the plugin
 * (none: nothing is done), the real local-effects ceiling holds the hand-off
 * as the plugin, the real lease authority admits the launch on its snapshot,
 * and the egress guard's lookup pins the socket. The children here are real
 * (node itself, a loopback socket that is refused), never a mock of the sink.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	buildHostCallHandlers,
	createPluginEffectSinks,
	pluginActBinding,
	requirePluginBinding,
	type HostHandlerDeps,
	type PluginActBinding,
	type PluginEffectSinkDeps,
	type ResolvedSpawnSpec,
} from '../../../main/plugins/plugin-host-handlers';
import { ActionGuard } from '../../../main/plugins/action-guard';
import { PluginKvStore } from '../../../main/plugins/plugin-kv-store';
import { PluginEventBusImpl } from '../../../main/plugins/plugin-event-bus';
import type { EgressGuard } from '../../../main/plugins/net-egress-guard';
import {
	createLocalEffectsPolicySource,
	LocalEffectRefusedError,
	type LocalEffectAuthority,
	type LocalEffectDecision,
	type LocalEffectRequest,
} from '../../../main/enterprise/local-effects-policy';
import type { IdentityRead } from '../../../main/enterprise/identity-store';
import { fakeSpawnPort } from '../../helpers/managedSpawnPort';

const receipt = {
	policyRevision: 3,
	outcome: 'within-ceiling' as const,
	contentHash: 'sha256:abc',
	signerKey: 'pub-1',
	consentEpoch: 7,
};
const binding: PluginActBinding = pluginActBinding('p', { allowed: true, managed: receipt })!;

const enrolled: IdentityRead = {
	status: 'ok',
	epoch: 1,
	record: {
		registration: { actorId: 'actor', registeredAt: 1 },
		policy: { appliedRevision: 3, appliedAt: 1 },
	} as never,
};

/** The real ceiling source, enrolled at revision 3 unless told otherwise, with every decision it answers recorded. */
function localEffects(verdict: 'allow' | 'deny' | null, identity: IdentityRead = enrolled) {
	const source = createLocalEffectsPolicySource({
		identity: { read: () => identity },
		policy: () => ({ appliedRevision: 3 }),
	});
	if (verdict) {
		expect(
			source.install({ policyRevision: 3, classes: [{ class: 'data-transfer', verdict }] })
		).toMatchObject({ installed: true });
	}
	const decisions: LocalEffectDecision[] = [];
	const requests: LocalEffectRequest[] = [];
	const authority: LocalEffectAuthority = {
		authorize: async (request) => {
			requests.push(request);
			const decision = await source.authorize(request);
			decisions.push(decision);
			return decision;
		},
	};
	return { authority, decisions, requests };
}

/** A guard that admits every URL and pins the connect to loopback, where nothing listens on port 1. */
const loopbackGuard: EgressGuard = {
	assertUrlAllowed: async () => {},
	lookup: (_hostname, options, callback) => {
		if (options?.all) callback(null, [{ address: '127.0.0.1', family: 4 }]);
		else callback(null, '127.0.0.1', 4);
	},
};

const REFUSED_SOCKET_URL = 'wss://gateway.example:1/socket';

function sinks(over: Partial<PluginEffectSinkDeps> = {}) {
	const openExternal = vi.fn(async () => {});
	const pushed: Array<{ topic: string; payload: unknown }> = [];
	const closed = new Map<string, () => void>();
	const pushEvent = vi.fn((_pluginId: string, event: { topic: string; payload: unknown }) => {
		pushed.push(event);
		const payload = event.payload as { type?: string; socketId?: string };
		if (payload.type === 'close' && payload.socketId) closed.get(payload.socketId)?.();
		return true;
	});
	/** Resolves when the sink reports the socket closed (a refused loopback connect errors, then closes). */
	const whenClosed = (socketId: string): Promise<void> =>
		new Promise((resolve) => {
			if (
				pushed.some(
					(e) =>
						(e.payload as { type?: string; socketId?: string }).socketId === socketId &&
						(e.payload as { type?: string }).type === 'close'
				)
			) {
				resolve();
				return;
			}
			closed.set(socketId, resolve);
		});
	const built = createPluginEffectSinks({
		spawnAuthority: () => null,
		localEffects: () => null,
		egressGuard: loopbackGuard,
		pushEvent,
		openExternal,
		...over,
	});
	return { sinks: built, openExternal, pushEvent, pushed, whenClosed };
}

let work: string;
beforeEach(() => {
	work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-plugin-sinks-')));
});
afterEach(() => {
	fs.rmSync(work, { recursive: true, force: true });
});

/** A real child: node writes a marker file and exits with the given code. */
function nodeSpec(marker: string, exitCode = 0): ResolvedSpawnSpec {
	const env: Record<string, string> = {};
	for (const key of ['PATH', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'HOME']) {
		const value = process.env[key];
		if (value) env[key] = value;
	}
	return {
		name: 'node-marker',
		binaryPath: process.execPath,
		args: [
			'-e',
			`require('fs').writeFileSync(process.argv[1], 'ran'); process.stdout.write('hi'); process.exitCode = ${exitCode}`,
			marker,
		],
		env,
		cwd: work,
	};
}

describe('createPluginEffectSinks: standalone', () => {
	it('shell.openExternal hands the URL to the OS with no ceiling consulted', async () => {
		// An unenrolled host: the real source is standalone whatever is installed.
		const held = localEffects(null, { status: 'none' });
		const { sinks: s, openExternal } = sinks({ localEffects: () => held.authority });
		await s.openExternal('p', 'https://docs.example/page', { activate: true });
		expect(openExternal).toHaveBeenCalledWith('https://docs.example/page', { activate: true });
		// Standalone: the real source answers allow with no receipt.
		expect(held.decisions).toEqual([{ allowed: true }]);
		expect(held.requests[0]).toEqual({
			effect: 'open-external',
			actor: { kind: 'plugin', pluginId: 'p' },
			target: 'https://docs.example/page',
		});
	});

	it('an isolated demo instance opens nothing and writes the audit line the e2e row asserts', async () => {
		const { sinks: s, openExternal } = sinks({ demoMode: true });
		await expect(s.openExternal('p', 'https://docs.example/page')).resolves.toBeUndefined();
		expect(openExternal).not.toHaveBeenCalled();
	});

	it('process.spawn runs the blessed binary with no shell and bounds its output', async () => {
		const { sinks: s } = sinks();
		const marker = path.join(work, 'marker.txt');
		await expect(s.spawn('p', nodeSpec(marker, 3))).resolves.toEqual({
			exitCode: 3,
			stdout: 'hi',
			stderr: '',
		});
		expect(fs.readFileSync(marker, 'utf8')).toBe('ran');
	});

	it('process.spawn reports a binary that cannot start as a spawn failure', async () => {
		const { sinks: s } = sinks();
		const spec: ResolvedSpawnSpec = {
			name: 'missing',
			binaryPath: path.join(work, 'no-such-binary'),
			args: [],
			env: {},
		};
		await expect(s.spawn('p', spec)).rejects.toThrow(/^process\.spawn: /);
	});

	it('net.connect opens a real socket pinned to the guard lookup, reports its close and frees the quota slot', async () => {
		const { sinks: s, pushed, whenClosed } = sinks();
		const release = vi.fn();
		s.registerNetSocketRelease(release);
		const { socketId } = await s.netConnect('p', REFUSED_SOCKET_URL, { protocols: ['v1', 7] });
		expect(socketId).toMatch(/^net_/);
		// A send before OPEN is refused by the sink itself.
		await expect(s.netSend('p', socketId, 'early')).rejects.toThrow(/socket not open/);
		await whenClosed(socketId);
		const types = pushed
			.filter((e) => e.topic === `net.connect:${socketId}`)
			.map((e) => (e.payload as { type: string }).type);
		expect(types).toContain('error');
		expect(types[types.length - 1]).toBe('close');
		// The error reached the plugin as a message string only.
		const error = pushed.find((e) => (e.payload as { type: string }).type === 'error');
		expect(typeof (error?.payload as { message: unknown }).message).toBe('string');
		expect(release).toHaveBeenCalledWith('p', socketId);
		// The sink dropped the socket: the id is unknown to send, close is best-effort.
		await expect(s.netSend('p', socketId, 'late')).rejects.toThrow(/unknown socketId/);
		await expect(s.netClose('p', socketId)).resolves.toEqual({ ok: true });
	});

	it('net.send and net.close refuse a socket the plugin does not own', async () => {
		const { sinks: s } = sinks();
		await expect(s.netSend('p', 'net_nope', 'x')).rejects.toThrow(/unknown socketId/);
		await expect(s.netClose('other', 'net_nope')).resolves.toEqual({ ok: true });
	});
});

describe('createPluginEffectSinks: managed', () => {
	it('a managed host performs nothing for a call that carries no receipt: open, socket and spawn all refuse by name', async () => {
		const port = fakeSpawnPort();
		const held = localEffects('allow');
		const {
			sinks: s,
			openExternal,
			pushEvent,
		} = sinks({
			spawnAuthority: () => port,
			localEffects: () => held.authority,
		});
		await expect(s.openExternal('p', 'https://docs.example/page')).rejects.toThrow(
			/shell\.openExternal: \[managed-unauthenticated\] .*"p".*Nothing was done/
		);
		expect(openExternal).not.toHaveBeenCalled();
		expect(held.requests).toHaveLength(0);
		await expect(s.netConnect('p', REFUSED_SOCKET_URL, {})).rejects.toThrow(
			/net\.connect: \[managed-unauthenticated\]/
		);
		expect(pushEvent).not.toHaveBeenCalled();
		const marker = path.join(work, 'marker.txt');
		await expect(s.spawn('p', nodeSpec(marker))).rejects.toThrow(
			/process\.spawn: \[managed-denied\] .*Nothing was started/
		);
		expect(fs.existsSync(marker)).toBe(false);
		expect(port.asked).toHaveLength(0);
		// The rule itself, for a sink that launches nothing.
		expect(() => requirePluginBinding(null, 'x', 'p', undefined)).not.toThrow();
		expect(() => requirePluginBinding(port, 'x', 'p', binding)).not.toThrow();
		port.setStanding('standalone');
		expect(() => requirePluginBinding(port, 'x', 'p', undefined)).not.toThrow();
	});

	it('shell.openExternal is held to the real local-effects ceiling as the plugin: deny opens nothing, allow carries a receipt', async () => {
		const port = fakeSpawnPort();
		const denied = localEffects('deny');
		const { sinks: refusing, openExternal: refusedOpen } = sinks({
			spawnAuthority: () => port,
			localEffects: () => denied.authority,
		});
		const failure = await refusing
			.openExternal('p', 'https://docs.example/page?x=1', undefined, binding)
			.then(
				() => null,
				(error: unknown) => error
			);
		expect(failure).toBeInstanceOf(LocalEffectRefusedError);
		expect((failure as LocalEffectRefusedError).code).toBe('denied');
		expect((failure as Error).message).toMatch(/\[managed-denied\] .*plugin "p"/);
		expect((failure as LocalEffectRefusedError).receipt).toEqual({
			policyRevision: 3,
			class: 'data-transfer',
			effect: 'open-external',
			actor: 'plugin "p"',
			target: 'https://docs.example',
			count: 1,
			outcome: 'denied',
		});
		expect(refusedOpen).not.toHaveBeenCalled();

		const allowed = localEffects('allow');
		const { sinks: admitting, openExternal } = sinks({
			spawnAuthority: () => port,
			localEffects: () => allowed.authority,
		});
		await admitting.openExternal('p', 'https://docs.example/page?x=1', undefined, binding);
		expect(openExternal).toHaveBeenCalledWith('https://docs.example/page?x=1', undefined);
		expect(allowed.decisions[0]).toMatchObject({
			allowed: true,
			managed: { actor: 'plugin "p"', outcome: 'within-ceiling', target: 'https://docs.example' },
		});

		// An enrolled host with no ceiling for its revision refuses unavailable, by name.
		const bare = localEffects(null);
		const { sinks: unavailable, openExternal: bareOpen } = sinks({
			spawnAuthority: () => port,
			localEffects: () => bare.authority,
		});
		await expect(
			unavailable.openExternal('p', 'https://docs.example/page', undefined, binding)
		).rejects.toThrow(/\[managed-unavailable\]/);
		expect(bareOpen).not.toHaveBeenCalled();
	});

	it('process.spawn under a binding runs the real child under a lease the authority minted on its snapshot', async () => {
		const port = fakeSpawnPort();
		const { sinks: s } = sinks({ spawnAuthority: () => port });
		const marker = path.join(work, 'marker.txt');
		const spec = nodeSpec(marker);
		await expect(s.spawn('p', spec, binding)).resolves.toEqual({
			exitCode: 0,
			stdout: 'hi',
			stderr: '',
		});
		expect(fs.readFileSync(marker, 'utf8')).toBe('ran');
		expect(port.asked).toHaveLength(1);
		expect(port.asked[0].snapshot).toMatchObject({
			executable: process.execPath,
			args: spec.args,
			cwd: work,
			shell: false,
			provider: 'plugin-process',
			resourceIds: ['binary:node-marker', 'plugin:p'],
		});
		expect(port.asked[0].context.delegation.chain).toEqual([{ kind: 'service', id: 'plugin:p' }]);
	});

	it('process.spawn refused by the policy starts nothing', async () => {
		const port = fakeSpawnPort({
			decide: () => ({
				decision: 'deny',
				code: 'policy-denied',
				reason: 'no tools today',
				policyRevision: 1,
			}),
		});
		const { sinks: s } = sinks({ spawnAuthority: () => port });
		const marker = path.join(work, 'marker.txt');
		await expect(s.spawn('p', nodeSpec(marker), binding)).rejects.toThrow(
			/process\.spawn: \[managed-denied\] no tools today/
		);
		expect(fs.existsSync(marker)).toBe(false);
	});

	it('net.connect under a binding opens the socket as before, pinned to the guard', async () => {
		const port = fakeSpawnPort();
		const { sinks: s, whenClosed, pushed } = sinks({ spawnAuthority: () => port });
		const { socketId } = await s.netConnect('p', REFUSED_SOCKET_URL, {}, binding);
		await whenClosed(socketId);
		expect(pushed.map((e) => (e.payload as { type: string }).type)).toContain('close');
	});
});

describe('the handlers hand the sinks the binding', () => {
	let kvBase: string;
	beforeEach(() => {
		kvBase = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-sinks-kv-'));
	});
	afterEach(() => fs.rmSync(kvBase, { recursive: true, force: true }));

	function deps(managed: boolean, over: Partial<HostHandlerDeps>): HostHandlerDeps {
		return {
			broker: {
				authorize: (_pluginId: string, method: string) => ({
					allowed: true,
					capability: method.replace('.', ':'),
					...(managed ? { managed: receipt } : {}),
				}),
			} as unknown as HostHandlerDeps['broker'],
			actionGuard: new ActionGuard(),
			kvStore: new PluginKvStore({ baseDir: kvBase }),
			eventBus: new PluginEventBusImpl({ isPermitted: () => true, push: () => true }),
			egressGuard: loopbackGuard,
			settingsGet: () => null,
			settingsSet: () => {},
			settingsDeleteNamespace: () => {},
			sessionsList: () => [],
			sessionsGet: () => null,
			runUiCommand: async () => true,
			listAgents: () => [],
			isPluginTrusted: () => true,
			readSessionTranscript: async () => [],
			assertTranscriptReadAllowed: () => {},
			auditTranscriptRead: () => {},
			...over,
		};
	}

	it('shell.openExternal: three arguments on standalone, the binding fourth under management', async () => {
		const { sinks: s, openExternal } = sinks();
		const spy = vi.fn(s.openExternal);
		const standalone = buildHostCallHandlers(deps(false, { openExternal: spy }));
		await expect(
			standalone['shell.openExternal']!('p', { url: 'https://docs.example/a' })
		).resolves.toEqual({ ok: true });
		expect(spy.mock.calls[0]).toEqual(['p', 'https://docs.example/a', undefined]);
		expect(openExternal).toHaveBeenCalledWith('https://docs.example/a', undefined);

		const port = fakeSpawnPort();
		const held = localEffects('deny');
		const { sinks: m } = sinks({
			spawnAuthority: () => port,
			localEffects: () => held.authority,
		});
		const managedSpy = vi.fn(m.openExternal);
		const managed = buildHostCallHandlers(deps(true, { openExternal: managedSpy }));
		await expect(
			managed['shell.openExternal']!('p', { url: 'https://docs.example/a' })
		).rejects.toThrow(/\[managed-denied\]/);
		expect(managedSpy.mock.calls[0]).toHaveLength(4);
		expect((managedSpy.mock.calls[0] as unknown[])[3]).toMatchObject({
			pluginId: 'p',
			receipt,
		});
		expect(held.requests[0].actor).toEqual({ kind: 'plugin', pluginId: 'p' });
	});

	it('net.connect: the binding reaches the real sink and a self-closed socket frees the handler slot', async () => {
		const port = fakeSpawnPort();
		const { sinks: m, whenClosed } = sinks({ spawnAuthority: () => port });
		const spy = vi.fn(m.netConnect);
		const h = buildHostCallHandlers(
			deps(true, {
				netConnect: spy,
				netSend: m.netSend,
				netClose: m.netClose,
				registerNetSocketRelease: m.registerNetSocketRelease,
			})
		);
		const { socketId } = (await h['net.connect']!('p', { url: REFUSED_SOCKET_URL })) as {
			socketId: string;
		};
		expect(spy.mock.calls[0]).toHaveLength(4);
		expect((spy.mock.calls[0] as unknown[])[3]).toMatchObject({ pluginId: 'p', receipt });
		await whenClosed(socketId);
		// The sink told the handler; its own map no longer knows the socket.
		await expect(h['net.send']!('p', { socketId, data: 'x' })).rejects.toThrow(/unknown socketId/);
	});
});
