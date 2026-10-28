/**
 * The listener ceiling (MRC2-05-06): a closed document (kind, reach); the
 * reach a bind address has; one installed ceiling projected onto the standing
 * every inbound listener is held against; the pure verdict that refuses a kind
 * the policy omits or a bind that reaches further than its entry, with a
 * receipt on every managed answer and nothing at all standalone; and the leaf
 * gate the sinks call, which answers before a bind and keeps the quiet ledger.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { IdentityRead } from '../../../main/enterprise/identity-store';
import {
	MAX_LISTENER_HOLDS,
	heldListeners,
	holdListener,
	isListenerDeniedError,
	listenerHoldFor,
	setListenerAuthority,
} from '../../../main/enterprise/listener-gate';
import {
	LISTENER_KINDS,
	LISTENER_REACHES,
	createListenerPolicySource,
	isOsLocalEndpoint,
	listenerReach,
	listenerVerdict,
	managedListenerStanding,
	parseListenerPolicyCeiling,
	reachWithin,
	type ListenerKind,
	type ListenerPolicyCeiling,
	type ListenerReach,
	type ListenerRequest,
	type ManagedListenerStanding,
} from '../../../main/enterprise/listener-policy';
import { LITE_CONTROL_DISABLED_BY_POLICY, isLiteControlHeld } from '../../../shared/lite-control';
import {
	denyingListenerAuthority,
	managedListenerAuthority,
} from '../../helpers/listenerAuthority';

function document(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		policyRevision: 3,
		listeners: [
			{ kind: 'web', reach: 'loopback' },
			{ kind: 'cue-status', reach: 'loopback' },
			{ kind: 'tailnet', reach: 'tailnet' },
		],
		...overrides,
	};
}

function problemsOf(raw: unknown): readonly string[] {
	const parsed = parseListenerPolicyCeiling(raw);
	return parsed.ok ? [] : parsed.problems;
}

function ceilingOf(raw: Record<string, unknown> = document()): ListenerPolicyCeiling {
	const parsed = parseListenerPolicyCeiling(raw);
	if (!parsed.ok) throw new Error(parsed.problems.join('; '));
	return parsed.ceiling;
}

const managed = (ceiling = ceilingOf()): ManagedListenerStanding => ({
	standing: 'managed',
	ceiling,
	policyRevision: ceiling.policyRevision,
});

function request(overrides: Partial<ListenerRequest> = {}): ListenerRequest {
	return { kind: 'web', bind: '127.0.0.1', port: 0, ...overrides };
}

function read(status: IdentityRead['status']): IdentityRead {
	return { status, epoch: 1, record: { registration: { actorId: 'a' } } } as never;
}

afterEach(() => setListenerAuthority(null));

describe('kinds and reach', () => {
	it('names the eleven listener kinds and five reaches in order, narrowest first', () => {
		expect(LISTENER_KINDS).toEqual([
			'web',
			'tunnel',
			'ssh-tunnel',
			'lite-control',
			'tailnet',
			'mdns',
			'cue-webhook',
			'cue-status',
			'relay',
			'steering',
			'coworking',
		]);
		expect(LISTENER_REACHES).toEqual(['loopback', 'tailnet', 'lan', 'any', 'public']);
		expect(reachWithin('loopback', 'loopback')).toBe(true);
		expect(reachWithin('any', 'lan')).toBe(false);
		expect(reachWithin('tailnet', 'any')).toBe(true);
	});

	it('reads the reach off the bind address, and a tunnel is public whatever it forwards to', () => {
		expect(listenerReach('web', '127.0.0.1')).toBe('loopback');
		expect(listenerReach('web', '127.9.9.9')).toBe('loopback');
		expect(listenerReach('web', 'localhost')).toBe('loopback');
		expect(listenerReach('web', '::1')).toBe('loopback');
		expect(listenerReach('web', '[::1]')).toBe('loopback');
		expect(listenerReach('web', '::ffff:127.0.0.1')).toBe('loopback');
		expect(listenerReach('web', '0.0.0.0')).toBe('any');
		expect(listenerReach('web', '::')).toBe('any');
		expect(listenerReach('web', '')).toBe('any');
		expect(listenerReach('tailnet', '100.101.102.103')).toBe('tailnet');
		expect(listenerReach('tailnet', '100.64.0.1')).toBe('tailnet');
		expect(listenerReach('tailnet', 'fd7a:115c:a1e0::1')).toBe('tailnet');
		expect(listenerReach('web', '100.128.0.1')).toBe('lan');
		expect(listenerReach('web', '192.168.1.50')).toBe('lan');
		expect(listenerReach('web', 'fe80::1%en0')).toBe('lan');
		expect(listenerReach('tunnel', '127.0.0.1')).toBe('public');
	});

	it('reads an OS-local endpoint as loopback, and an ssh-tunnel forward off its bind, never as public', () => {
		expect(isOsLocalEndpoint('/tmp/maestro-lite-0f.sock')).toBe(true);
		expect(isOsLocalEndpoint('\\\\.\\pipe\\maestro-lite-0f')).toBe(true);
		expect(isOsLocalEndpoint('\\\\?\\pipe\\maestro-lite-0f')).toBe(true);
		expect(isOsLocalEndpoint('//./pipe/maestro-lite-0f')).toBe(true);
		expect(isOsLocalEndpoint('\\\\remote-host\\pipe\\maestro-lite-0f')).toBe(false);
		expect(isOsLocalEndpoint('127.0.0.1')).toBe(false);
		expect(isOsLocalEndpoint('')).toBe(false);
		expect(listenerReach('lite-control', '/tmp/maestro-lite-0f.sock')).toBe('loopback');
		expect(listenerReach('lite-control', '\\\\.\\pipe\\maestro-lite-0f')).toBe('loopback');
		expect(listenerReach('lite-control', '\\\\remote-host\\pipe\\maestro-lite-0f')).toBe('lan');
		expect(listenerReach('ssh-tunnel', '127.0.0.1')).toBe('loopback');
		expect(listenerReach('ssh-tunnel', '0.0.0.0')).toBe('any');
		expect(problemsOf(document({ listeners: [{ kind: 'ssh-tunnel', reach: 'public' }] }))).toEqual([
			'listeners[0].reach "public" is only for the tunnel kind',
		]);
		const standing = managed(
			ceilingOf(
				document({
					listeners: [
						{ kind: 'ssh-tunnel', reach: 'loopback' },
						{ kind: 'lite-control', reach: 'loopback' },
					],
				})
			)
		);
		expect(
			listenerVerdict(standing, request({ kind: 'ssh-tunnel', bind: '127.0.0.1', port: 4321 }))
		).toMatchObject({ allowed: true, managed: { reach: 'loopback', outcome: 'within-ceiling' } });
		expect(
			listenerVerdict(standing, request({ kind: 'lite-control', bind: '/tmp/x.sock', port: 0 }))
		).toMatchObject({ allowed: true, managed: { reach: 'loopback' } });
		expect(listenerVerdict(standing, request({ kind: 'tunnel' }))).toMatchObject({
			allowed: false,
			code: 'kind-denied',
		});
	});
});

describe('parseListenerPolicyCeiling', () => {
	it('accepts a closed document and returns a fresh value', () => {
		const raw = document();
		const parsed = parseListenerPolicyCeiling(raw);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.ceiling).toEqual({
			policyRevision: 3,
			listeners: [
				{ kind: 'web', reach: 'loopback' },
				{ kind: 'cue-status', reach: 'loopback' },
				{ kind: 'tailnet', reach: 'tailnet' },
			],
		});
		expect(parsed.ceiling.listeners).not.toBe(raw.listeners);
		expect(ceilingOf(document({ listeners: [] })).listeners).toEqual([]);
		expect(
			ceilingOf(document({ listeners: [{ kind: 'tunnel', reach: 'public' }] })).listeners
		).toHaveLength(1);
	});

	it('names every problem by its path and refuses the whole document on one', () => {
		expect(problemsOf(null)).toEqual(['the listener ceiling is not an object']);
		expect(problemsOf(document({ extra: 1 }))).toEqual(['extra is not a known key']);
		expect(problemsOf(document({ policyRevision: -1 }))).toEqual([
			'policyRevision is not a policy revision',
		]);
		expect(problemsOf(document({ listeners: 'web' }))).toEqual(['listeners is not an array']);
		expect(
			problemsOf(
				document({ listeners: Array.from({ length: 12 }, () => ({ kind: 'web', reach: 'any' })) })
			)
		).toEqual(['listeners exceeds 11 entries']);
		expect(problemsOf(document({ listeners: ['web'] }))).toEqual(['listeners[0] is not an object']);
		expect(problemsOf(document({ listeners: [{ kind: 'ftp', reach: 'any' }] }))).toEqual([
			'listeners[0].kind is not a listener kind',
		]);
		expect(problemsOf(document({ listeners: [{ kind: 'web', reach: 'world' }] }))).toEqual([
			'listeners[0].reach is not a listener reach',
		]);
		expect(problemsOf(document({ listeners: [{ kind: 'web', reach: 'public' }] }))).toEqual([
			'listeners[0].reach "public" is only for the tunnel kind',
		]);
		expect(problemsOf(document({ listeners: [{ kind: 'web', reach: 'any', port: 80 }] }))).toEqual([
			'listeners[0].port is not a known key',
		]);
		expect(
			problemsOf(
				document({
					listeners: [
						{ kind: 'web', reach: 'any' },
						{ kind: 'web', reach: 'loopback' },
					],
				})
			)
		).toEqual(['listeners[1].kind "web" is named twice']);
	});
});

describe('managedListenerStanding', () => {
	it('is standalone when not enrolled, whatever is installed', () => {
		expect(
			managedListenerStanding({ enrolled: false, policy: null, ceiling: ceilingOf() })
		).toEqual({ standing: 'standalone' });
	});

	it('names why a managed host has no ceiling to hold against', () => {
		expect(managedListenerStanding({ enrolled: true, policy: null, ceiling: null })).toEqual({
			standing: 'managed',
			ceiling: null,
			policyRevision: null,
			reason: 'no applied policy revision is known for this host',
		});
		expect(
			managedListenerStanding({ enrolled: true, policy: { appliedRevision: 3 }, ceiling: null })
		).toMatchObject({
			ceiling: null,
			reason: 'no listener ceiling is installed for policy revision 3',
		});
		expect(
			managedListenerStanding({
				enrolled: true,
				policy: { appliedRevision: 4 },
				ceiling: ceilingOf(),
			})
		).toMatchObject({
			ceiling: null,
			policyRevision: 4,
			reason:
				'the installed listener ceiling is for policy revision 3; this host is under revision 4',
		});
		expect(
			managedListenerStanding({
				enrolled: true,
				policy: { appliedRevision: 3 },
				ceiling: ceilingOf(),
			})
		).toEqual({ standing: 'managed', ceiling: ceilingOf(), policyRevision: 3 });
	});
});

describe('listenerVerdict', () => {
	it('answers allowed with no receipt standalone', () => {
		expect(listenerVerdict({ standing: 'standalone' }, request({ kind: 'tunnel' }))).toEqual({
			allowed: true,
		});
	});

	it('refuses unavailable, by name, when a managed host has no ceiling for its revision', () => {
		const standing: ManagedListenerStanding = {
			standing: 'managed',
			ceiling: null,
			policyRevision: 3,
			reason: 'no listener ceiling is installed for policy revision 3',
		};
		const decision = listenerVerdict(standing, request({ bind: '0.0.0.0', port: 8080 }));
		expect(decision).toMatchObject({
			allowed: false,
			code: 'unavailable',
			message:
				'the managed listener ceiling is unavailable (no listener ceiling is installed for policy revision 3); the web listener on 0.0.0.0:8080 is not opened',
			managed: {
				policyRevision: 3,
				kind: 'web',
				bind: '0.0.0.0',
				port: 8080,
				reach: 'any',
				outcome: 'unavailable',
			},
		});
	});

	it('refuses a kind the ceiling does not list and a bind that reaches further than its entry', () => {
		expect(listenerVerdict(managed(), request({ kind: 'tunnel', port: 3000 }))).toMatchObject({
			allowed: false,
			code: 'kind-denied',
			message:
				'the listener ceiling admits no tunnel listener; the tunnel listener on 127.0.0.1:3000 is opened only when the policy lists the kind',
			managed: { kind: 'tunnel', reach: 'public', outcome: 'kind-denied' },
		});
		expect(listenerVerdict(managed(), request({ bind: '0.0.0.0' }))).toMatchObject({
			allowed: false,
			code: 'reach-denied',
			message:
				'the listener ceiling admits a web listener as far as loopback; 0.0.0.0:0 reaches any and is not opened',
			managed: { kind: 'web', bind: '0.0.0.0', reach: 'any', outcome: 'reach-denied' },
		});
		expect(
			listenerVerdict(managed(), request({ kind: 'tailnet', bind: '192.168.1.50', port: 7 }))
		).toMatchObject({ allowed: false, code: 'reach-denied' });
	});

	it('admits a listener within its entry with a receipt', () => {
		expect(listenerVerdict(managed(), request())).toEqual({
			allowed: true,
			managed: {
				policyRevision: 3,
				kind: 'web',
				bind: '127.0.0.1',
				port: 0,
				reach: 'loopback',
				outcome: 'within-ceiling',
			},
		});
		expect(
			listenerVerdict(managed(), request({ kind: 'tailnet', bind: '100.64.0.9', port: 7 }))
		).toMatchObject({ allowed: true, managed: { reach: 'tailnet', outcome: 'within-ceiling' } });
		const wide = ceilingOf(document({ listeners: [{ kind: 'web', reach: 'any' }] }));
		expect(listenerVerdict(managed(wide), request({ bind: '0.0.0.0' }))).toMatchObject({
			allowed: true,
		});
		const tunnel = ceilingOf(document({ listeners: [{ kind: 'tunnel', reach: 'public' }] }));
		expect(listenerVerdict(managed(tunnel), request({ kind: 'tunnel' }))).toMatchObject({
			allowed: true,
			managed: { reach: 'public' },
		});
	});
});

describe('createListenerPolicySource', () => {
	it('installs a valid ceiling, keeps the previous one on a refused document, and clears', () => {
		const source = createListenerPolicySource({
			identity: { read: () => read('ok') },
			policy: () => ({ appliedRevision: 3 }),
		});
		expect(source.installed()).toBeNull();
		expect(source.evaluateListener(request())).toMatchObject({ code: 'unavailable' });
		expect(source.install(document())).toEqual({ installed: true, policyRevision: 3 });
		expect(source.install(document({ listeners: 'x' }))).toEqual({
			installed: false,
			problems: ['listeners is not an array'],
		});
		expect(source.installed()?.policyRevision).toBe(3);
		expect(source.standing()).toMatchObject({ standing: 'managed', policyRevision: 3 });
		expect(source.evaluateListener(request())).toMatchObject({ allowed: true });
		expect(source.evaluateListener(request({ kind: 'mdns', bind: '0.0.0.0' }))).toMatchObject({
			code: 'kind-denied',
		});
		source.clear();
		expect(source.installed()).toBeNull();
		expect(source.evaluateListener(request())).toMatchObject({ code: 'unavailable' });
	});

	it('is standalone for a host that is not enrolled', () => {
		const source = createListenerPolicySource({
			identity: { read: () => ({ status: 'none' }) as IdentityRead },
			policy: () => null,
		});
		expect(source.standing()).toEqual({ standing: 'standalone' });
		expect(source.evaluateListener(request({ kind: 'tunnel' }))).toEqual({ allowed: true });
	});

	it('reads an unprotected custody with no record as standalone, and one with a record as managed (MRC2-05-10A)', () => {
		const unprotected = (fileExists: boolean): IdentityRead => ({
			status: 'unprotected',
			reason: 'encryption-unavailable',
			message: 'no OS encryption is available',
			fileExists,
		});
		// No file: the installed ceiling omits tunnel, and is not consulted.
		const standalone = createListenerPolicySource({
			identity: { read: () => unprotected(false) },
			policy: () => ({ appliedRevision: 3 }),
		});
		standalone.install(document());
		expect(standalone.standing()).toEqual({ standing: 'standalone' });
		expect(standalone.evaluateListener(request({ kind: 'tunnel', bind: '0.0.0.0' }))).toEqual({
			allowed: true,
		});
		// A file an enrolled run wrote: managed, refused by name, never standalone.
		const held = createListenerPolicySource({
			identity: { read: () => unprotected(true) },
			policy: () => ({ appliedRevision: 3 }),
		});
		expect(held.standing()).toMatchObject({ standing: 'managed' });
		expect(held.evaluateListener(request())).toMatchObject({ allowed: false, code: 'unavailable' });
	});
});

describe('the listener gate', () => {
	it('consults nothing and holds nothing with no authority installed', () => {
		expect(listenerHoldFor(request({ kind: 'tunnel' }))).toBeNull();
		expect(() => holdListener(request({ bind: '0.0.0.0' }))).not.toThrow();
		expect(heldListeners()).toEqual([]);
	});

	it('throws a named refusal before a bind and records it once per kind, code, bind and port', () => {
		const denied = denyingListenerAuthority('kind-denied');
		setListenerAuthority(denied.authority);
		let caught: unknown;
		try {
			holdListener(request({ kind: 'web', bind: '0.0.0.0', port: 8080 }));
		} catch (error) {
			caught = error;
		}
		expect(isListenerDeniedError(caught)).toBe(true);
		expect(isListenerDeniedError(new Error('EADDRINUSE'))).toBe(false);
		expect(caught).toMatchObject({
			name: 'ListenerDeniedError',
			code: 'kind-denied',
			kind: 'web',
			message: '[managed-kind-denied] the listener ceiling admits no web listener',
			receipt: { kind: 'web', bind: '0.0.0.0', port: 8080, reach: 'any', outcome: 'kind-denied' },
		});
		expect(() => holdListener(request({ kind: 'web', bind: '0.0.0.0', port: 8080 }))).toThrow(
			/^\[managed-kind-denied\] /
		);
		const hold = listenerHoldFor(request({ kind: 'tunnel', port: 8080 }));
		expect(hold).toMatchObject({
			kind: 'tunnel',
			bind: '127.0.0.1',
			port: 8080,
			reach: 'public',
			code: 'kind-denied',
			message: '[managed-kind-denied] the listener ceiling admits no tunnel listener',
			policyRevision: 3,
			count: 1,
		});
		expect(denied.requests).toHaveLength(3);
		const ledger = heldListeners();
		expect(ledger).toHaveLength(2);
		expect(ledger[0]).toMatchObject({ kind: 'web', bind: '0.0.0.0', port: 8080, count: 2 });
		expect(ledger[1]).toMatchObject({ kind: 'tunnel', count: 1 });
		expect(ledger[0].firstAt <= ledger[0].lastAt).toBe(true);
		// Copies: a reader cannot alter the record, and a new authority clears it.
		(ledger[0] as { count: number }).count = 99;
		expect(heldListeners()[0].count).toBe(2);
		setListenerAuthority(denied.authority);
		expect(heldListeners()).toEqual([]);
	});

	it('answers the real verdict over an installed ceiling: loopback binds, every interface is refused', () => {
		const real = managedListenerAuthority([{ kind: 'web', reach: 'loopback' }]);
		setListenerAuthority(real.authority);
		expect(listenerHoldFor(request())).toBeNull();
		expect(listenerHoldFor(request({ bind: '0.0.0.0' }))).toMatchObject({ code: 'reach-denied' });
		expect(listenerHoldFor(request({ kind: 'tunnel', port: 3000 }))).toMatchObject({
			code: 'kind-denied',
		});
		expect(real.requests.map((r) => r.kind)).toEqual(['web', 'web', 'tunnel']);
		expect(heldListeners().map((h) => h.code)).toEqual(['reach-denied', 'kind-denied']);
	});

	it('keeps at most MAX_LISTENER_HOLDS distinct records and still answers past the bound', () => {
		setListenerAuthority(denyingListenerAuthority('unavailable').authority);
		for (let port = 1; port <= MAX_LISTENER_HOLDS + 5; port++) {
			expect(listenerHoldFor(request({ port }))).toMatchObject({ code: 'unavailable', port });
		}
		expect(heldListeners()).toHaveLength(MAX_LISTENER_HOLDS);
	});
});

describe('one entry per kind', () => {
	/** The widest reach an entry of the kind may carry: `public` is only for the tunnel. */
	const widest = (kind: ListenerKind): ListenerReach => (kind === 'tunnel' ? 'public' : 'any');
	const loopbackRequest = (kind: ListenerKind): ListenerRequest => ({
		kind,
		bind: '127.0.0.1',
		port: 7,
	});
	const empty = () => managed(ceilingOf(document({ listeners: [] })));

	it('holds each kind by its own entry alone: the ten others are refused kind-denied under any bind', () => {
		for (const kind of LISTENER_KINDS) {
			const alone = managed(ceilingOf(document({ listeners: [{ kind, reach: widest(kind) }] })));
			expect(listenerVerdict(alone, loopbackRequest(kind))).toMatchObject({
				allowed: true,
				managed: { kind, outcome: 'within-ceiling', policyRevision: 3 },
			});
			expect(listenerVerdict(alone, { kind, bind: '0.0.0.0', port: 7 })).toMatchObject({
				allowed: true,
				managed: { reach: widest(kind) },
			});
			for (const other of LISTENER_KINDS) {
				if (other === kind) continue;
				for (const bind of ['127.0.0.1', '0.0.0.0', '/tmp/maestro-lite-0f.sock']) {
					expect(listenerVerdict(alone, { kind: other, bind, port: 7 })).toMatchObject({
						allowed: false,
						code: 'kind-denied',
						managed: { kind: other, bind, port: 7, outcome: 'kind-denied' },
					});
				}
			}
		}
	});

	it('an empty ceiling, the strictest install, refuses every kind kind-denied at the gate and never unavailable', () => {
		const real = managedListenerAuthority([]);
		setListenerAuthority(real.authority);
		for (const kind of LISTENER_KINDS) {
			expect(listenerVerdict(empty(), loopbackRequest(kind))).toMatchObject({
				allowed: false,
				code: 'kind-denied',
			});
			expect(() => holdListener(loopbackRequest(kind))).toThrow(
				`[managed-kind-denied] the listener ceiling admits no ${kind} listener`
			);
			expect(listenerHoldFor(loopbackRequest(kind))).toMatchObject({
				kind,
				code: 'kind-denied',
				count: 2,
			});
		}
		expect(real.requests).toHaveLength(LISTENER_KINDS.length * 2);
		const ledger = heldListeners();
		expect(ledger.map((hold) => hold.kind)).toEqual([...LISTENER_KINDS]);
		expect(ledger.map((hold) => [hold.code, hold.count, hold.policyRevision])).toEqual(
			LISTENER_KINDS.map(() => ['kind-denied', 2, 3])
		);
	});
});

describe('the Lite disabled record', () => {
	it('is the gate hold the control endpoint met (the status word, its code, its line) and never a live discovery', () => {
		setListenerAuthority(managedListenerAuthority([]).authority);
		const hold = listenerHoldFor({
			kind: 'lite-control',
			bind: '/tmp/maestro-lite-0f.sock',
			port: 0,
		});
		expect(hold).toMatchObject({ kind: 'lite-control', reach: 'loopback', code: 'kind-denied' });
		const record = {
			protocolVersion: 1,
			pid: process.pid,
			status: LITE_CONTROL_DISABLED_BY_POLICY,
			code: hold!.code,
			message: hold!.message,
		};
		expect(isLiteControlHeld(record)).toBe(true);
		expect(record.message).toMatch(/^\[managed-kind-denied\] /);
		expect(
			isLiteControlHeld({
				protocolVersion: 1,
				pid: 1,
				endpoint: '/tmp/maestro-lite-0f.sock',
				secret: 'a'.repeat(64),
			})
		).toBe(false);
		expect(isLiteControlHeld({ ...record, status: 'disabled' })).toBe(false);
		expect(isLiteControlHeld({ ...record, code: 7 })).toBe(false);
		expect(isLiteControlHeld(null)).toBe(false);
	});
});

describe('sink classification by source', () => {
	const source = (file: string) => readFileSync(join(process.cwd(), file), 'utf8');
	/** The gate calls of a file with its comments removed (the status server's doc comment spells one it does not make). */
	const gateCalls = (text: string) =>
		text
			.replace(/\/\*[\s\S]*?\*\//g, '')
			.replace(/^\s*\/\/.*$/gm, '')
			.match(/\b(holdListener|listenerHoldFor)\(/g) ?? [];

	/** Every inbound sink: the kind its task assigned, the exact gate call, and the first thing after it that reaches a socket or a process. */
	const SINKS: ReadonlyArray<{ file: string; kind: ListenerKind; call: string; before: string }> = [
		{
			file: 'src/main/web-server/WebServer.ts',
			kind: 'web',
			call: "holdListener({ kind: 'web', bind: bindHost, port: this.port })",
			before: 'this.server.listen(',
		},
		{
			file: 'src/main/tunnel-manager.ts',
			kind: 'tunnel',
			call: "listenerHoldFor({ kind: 'tunnel', bind: TUNNEL_TARGET_HOST, port })",
			before: 'isCloudflaredInstalled()',
		},
		{
			file: 'src/main/lite/tunnel.ts',
			kind: 'ssh-tunnel',
			call: "holdListener({ kind: 'ssh-tunnel', bind: '127.0.0.1', port: preferredPort ?? 0 })",
			before: 'await availablePort(',
		},
		{
			file: 'src/main/lite/control-server.ts',
			kind: 'lite-control',
			call: "listenerHoldFor({ kind: 'lite-control', bind: endpoint, port: 0 })",
			before: 'createServer(',
		},
		{
			file: 'src/main/lite/tailnet-listener.ts',
			kind: 'tailnet',
			call: "holdListener({ kind: 'tailnet', bind: address, port: TAILNET_PORT })",
			before: 'listenDirect(',
		},
		{
			file: 'src/main/lite/tailnet-listener.ts',
			kind: 'tailnet',
			call: "holdListener({ kind: 'tailnet', bind: address, port: LAN_PORT })",
			before: 'server.server.address()',
		},
		{
			file: 'src/main/lite/discovery/mdns.ts',
			kind: 'mdns',
			call: "holdListener({ kind: 'mdns', bind: this.address, port: MDNS_PORT })",
			before: 'this.sockets()',
		},
		{
			file: 'src/main/lite/discovery/advertiser.ts',
			kind: 'mdns',
			call: "listenerHoldFor({ kind: 'mdns', bind: address, port: MDNS_PORT })",
			before: 'this.sockets()',
		},
		{
			file: 'src/main/lite/discovery/tailscale.ts',
			kind: 'tailnet',
			call: 'listenerHoldFor(TAILNET_DISCOVERY_LISTENER)',
			before: 'execFile(',
		},
		{
			file: 'src/main/cue/cue-webhook-server.ts',
			kind: 'cue-webhook',
			call: "listenerHoldFor({ kind: 'cue-webhook', bind: host, port })",
			before: 'http.createServer(',
		},
	];

	/** The kinds no sink of this build holds: loopback-only observability and the three OS-local sockets. */
	const UNHELD: ReadonlyArray<{ file: string; kind: ListenerKind; bind: string }> = [
		{
			file: 'src/main/cue/cue-status-server.ts',
			kind: 'cue-status',
			bind: 'server.listen(options.port, CUE_STATUS_HOST)',
		},
		{
			file: 'src/main/permission-relay/PermissionRelayServer.ts',
			kind: 'relay',
			bind: 'server.listen(socketPath,',
		},
		{
			file: 'src/maestro-p/steering-server.ts',
			kind: 'steering',
			bind: 'server.listen(socketPath)',
		},
		{
			file: 'src/main/coworking/coworking-bridge.ts',
			kind: 'coworking',
			bind: 'srv.listen(socketPath)',
		},
	];

	it('every sink names the kind its task assigned, through the leaf gate, before the first thing that reaches a socket', () => {
		for (const sink of SINKS) {
			const text = source(sink.file);
			expect(text, sink.file).toMatch(/from '(\.\.\/)*(\.\/)?enterprise\/listener-gate'/);
			expect(text, sink.file).not.toMatch(
				/import \{[^}]*\b(holdListener|listenerHoldFor)\b[^}]*\} from '[./]*enterprise\/listener-policy'/
			);
			const at = text.indexOf(sink.call);
			expect(at, `${sink.file} holds ${sink.kind}`).toBeGreaterThan(-1);
			expect(text.indexOf(sink.call, at + 1), `${sink.file} holds ${sink.kind} once`).toBe(-1);
			expect(
				text.slice(0, at),
				`${sink.file} reaches ${sink.before} only after the hold`
			).not.toContain(sink.before);
			expect(text.indexOf(sink.before, at), `${sink.file} reaches ${sink.before}`).toBeGreaterThan(
				at
			);
		}
		const perFile = new Map<string, number>();
		for (const sink of SINKS) perFile.set(sink.file, (perFile.get(sink.file) ?? 0) + 1);
		for (const [file, count] of perFile) expect(gateCalls(source(file)), file).toHaveLength(count);
		expect(source('src/main/lite/discovery/tailscale.ts')).toMatch(
			/const TAILNET_DISCOVERY_LISTENER = \{[^}]*kind: 'tailnet'[^}]*\} as const satisfies ListenerRequest;/
		);
	});

	it('the four kinds no sink holds are loopback-only or OS-local by record, and consult no gate', () => {
		const held = new Set(SINKS.map((sink) => sink.kind));
		expect(LISTENER_KINDS.filter((kind) => !held.has(kind))).toEqual(UNHELD.map((u) => u.kind));
		for (const entry of UNHELD) {
			const text = source(entry.file);
			expect(text, entry.file).not.toMatch(/listener-gate'/);
			expect(gateCalls(text), entry.file).toEqual([]);
			expect(text, entry.file).toContain(entry.bind);
			expect(text, entry.file).not.toMatch(/\.listen\([^)]*'(0\.0\.0\.0|::)'/);
		}
		expect(source('src/main/cue/cue-status-server.ts')).toContain(
			"export const CUE_STATUS_HOST = '127.0.0.1';"
		);
	});

	it('the gate is a leaf: one runtime import (the formatter) and only types of the policy', () => {
		const gate = source('src/main/enterprise/listener-gate.ts');
		expect(gate.match(/^import (?!type )/gm)).toHaveLength(1);
		expect(gate).toContain("import { formatManagedHold } from '../../shared/formatters';");
		expect(gate).toMatch(/import type \{[^}]*\} from '\.\/listener-policy';/);
		expect(gate.match(/from '\.\/listener-policy'/g)).toHaveLength(1);
	});
});

describe('composition in src/main/index.ts', () => {
	// The source of truth for the wiring is the one block in index.ts; this
	// pins it so the gate is installed from the composed source, once, after
	// the egress and update ceilings, and never from a second place.
	it('installs the listener source on the gate once, after the update ceiling', () => {
		const source = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8');
		expect(source).toMatch(
			/const listenerPolicy = createListenerPolicySource\(\{\n\t+identity: \{ read: \(\) => enterpriseService\?\.identity\.read\(\) \?\? \{ status: 'none' \} \},\n\t+policy: \(\) => enterpriseService\?\.policy\.status\(\) \?\? null,\n\t+\}\);\n\t+setListenerAuthority\(listenerPolicy\);/
		);
		expect(source.match(/setListenerAuthority\(/g)).toHaveLength(1);
		expect(source.indexOf('setListenerAuthority(listenerPolicy)')).toBeGreaterThan(
			source.indexOf('setUpdateAuthority(updatePolicy)')
		);
	});
});
