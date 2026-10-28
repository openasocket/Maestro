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
	type ListenerPolicyCeiling,
	type ListenerRequest,
	type ManagedListenerStanding,
} from '../../../main/enterprise/listener-policy';
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
