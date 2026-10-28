/**
 * The update ceiling (MRC2-05-04): a closed document (hold, channel, pin);
 * one installed ceiling projected onto the standing the checker and
 * electron-updater hold every roll-forward against; and the pure verdict
 * that holds a feed or a candidate version, with a receipt on every managed
 * answer and nothing at all on a standalone host.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { IdentityRead } from '../../../main/enterprise/identity-store';
import {
	UPDATE_CHANNELS,
	UPDATE_OPERATOR,
	createUpdatePolicySource,
	formatUpdateRefusal,
	isPrereleaseVersion,
	isUpdateVersion,
	managedUpdateStanding,
	normalizeUpdateVersion,
	parseUpdatePolicyCeiling,
	updateVerdict,
	type ManagedUpdateStanding,
	type UpdatePolicyCeiling,
	type UpdateRequest,
} from '../../../main/enterprise/update-policy';

function document(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return { policyRevision: 3, hold: false, channel: 'stable', pin: null, ...overrides };
}

function problemsOf(raw: unknown): readonly string[] {
	const parsed = parseUpdatePolicyCeiling(raw);
	return parsed.ok ? [] : parsed.problems;
}

function ceilingOf(raw: Record<string, unknown> = document()): UpdatePolicyCeiling {
	const parsed = parseUpdatePolicyCeiling(raw);
	if (!parsed.ok) throw new Error(parsed.problems.join('; '));
	return parsed.ceiling;
}

const managed = (ceiling = ceilingOf()): ManagedUpdateStanding => ({
	standing: 'managed',
	ceiling,
	policyRevision: ceiling.policyRevision,
});

function request(overrides: Partial<UpdateRequest> = {}): UpdateRequest {
	return { current: '1.0.0', candidate: 'v1.2.0', ...overrides };
}

describe('version helpers', () => {
	it('accepts release versions with or without v and a prerelease part, nothing else', () => {
		expect(isUpdateVersion('1.2.3')).toBe(true);
		expect(isUpdateVersion('v1.2.3')).toBe(true);
		expect(isUpdateVersion('1.2.3-rc.1')).toBe(true);
		expect(isUpdateVersion('1.2')).toBe(false);
		expect(isUpdateVersion('latest')).toBe(false);
		expect(isUpdateVersion(' 1.2.3')).toBe(false);
		expect(isUpdateVersion(`1.2.3-${'a'.repeat(80)}`)).toBe(false);
		expect(isUpdateVersion(123)).toBe(false);
	});

	it('tells a prerelease from a stable release and compares without the v', () => {
		expect(isPrereleaseVersion('v1.2.3-beta')).toBe(true);
		expect(isPrereleaseVersion('1.2.3')).toBe(false);
		expect(normalizeUpdateVersion('v1.2.3')).toBe('1.2.3');
		expect(normalizeUpdateVersion(' 1.2.3 ')).toBe('1.2.3');
		expect([...UPDATE_CHANNELS]).toEqual(['stable', 'prerelease']);
	});
});

describe('parseUpdatePolicyCeiling', () => {
	it('accepts the closed document and returns a fresh value', () => {
		const raw = document({ pin: 'v1.2.0' });
		const parsed = parseUpdatePolicyCeiling(raw);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.ceiling).toEqual({
			policyRevision: 3,
			hold: false,
			channel: 'stable',
			pin: 'v1.2.0',
		});
		raw.hold = true;
		expect(parsed.ceiling.hold).toBe(false);
	});

	it('names every problem by path and refuses the whole document on one', () => {
		expect(problemsOf(null)).toEqual(['the update ceiling is not an object']);
		expect(problemsOf(document({ extra: 1 }))).toEqual(['extra is not a known key']);
		expect(problemsOf(document({ policyRevision: -1 }))).toEqual([
			'policyRevision is not a policy revision',
		]);
		expect(problemsOf(document({ hold: 'yes' }))).toEqual(['hold is not a boolean']);
		expect(problemsOf(document({ channel: 'beta' }))).toEqual(['channel is not an update channel']);
		expect(problemsOf(document({ pin: 'latest' }))).toEqual([
			'pin is not a release version or null',
		]);
		expect(problemsOf(document({ pin: undefined }))).toEqual([
			'pin is not a release version or null',
		]);
		expect(problemsOf({ policyRevision: 'x', hold: 1, channel: 1, pin: 1 })).toHaveLength(4);
	});
});

describe('managedUpdateStanding', () => {
	it('is standalone when not enrolled, whatever is installed', () => {
		expect(managedUpdateStanding({ enrolled: false, policy: null, ceiling: ceilingOf() })).toEqual({
			standing: 'standalone',
		});
	});

	it('names why no ceiling binds: no revision, none installed, another revision', () => {
		const none = managedUpdateStanding({ enrolled: true, policy: null, ceiling: ceilingOf() });
		expect(none).toMatchObject({ standing: 'managed', ceiling: null, policyRevision: null });
		const missing = managedUpdateStanding({
			enrolled: true,
			policy: { appliedRevision: 3 },
			ceiling: null,
		});
		expect(missing).toMatchObject({
			ceiling: null,
			reason: 'no update ceiling is installed for policy revision 3',
		});
		const other = managedUpdateStanding({
			enrolled: true,
			policy: { appliedRevision: 4 },
			ceiling: ceilingOf(),
		});
		expect(other).toMatchObject({ ceiling: null, policyRevision: 4 });
		expect((other as { reason: string }).reason).toContain('revision 3');
		expect(
			managedUpdateStanding({
				enrolled: true,
				policy: { appliedRevision: 3 },
				ceiling: ceilingOf(),
			})
		).toEqual(managed());
	});
});

describe('updateVerdict', () => {
	it('allows everything standalone with no receipt', () => {
		expect(updateVerdict({ standing: 'standalone' }, request())).toEqual({ allowed: true });
		expect(
			updateVerdict({ standing: 'standalone' }, request({ candidate: 'v9.0.0-beta' }))
		).toEqual({ allowed: true });
	});

	it('refuses unavailable with no ceiling and unauthenticated for an unbindable actor', () => {
		const unavailable = updateVerdict(
			{ standing: 'managed', ceiling: null, policyRevision: 3, reason: 'none installed' },
			request()
		);
		expect(unavailable.allowed).toBe(false);
		if (unavailable.allowed) return;
		expect(unavailable.code).toBe('unavailable');
		expect(unavailable.message).toContain('none installed');
		expect(unavailable.managed).toEqual({
			policyRevision: 3,
			current: '1.0.0',
			candidate: 'v1.2.0',
			actor: expect.any(String),
			outcome: 'unavailable',
		});
		const unbound = updateVerdict(managed(), request(), ['no actor registered']);
		expect(unbound).toMatchObject({ allowed: false, code: 'unauthenticated' });
	});

	it('holds the feed and every candidate before anything else when the ceiling holds', () => {
		const held = managed(ceilingOf(document({ hold: true, channel: 'prerelease', pin: null })));
		const feed = updateVerdict(held, request({ candidate: null }));
		expect(feed).toMatchObject({ allowed: false, code: 'held' });
		if (!feed.allowed) expect(feed.message).toContain('the release feed');
		const candidate = updateVerdict(held, request({ candidate: 'v1.0.1' }));
		expect(candidate).toMatchObject({ allowed: false, code: 'held' });
		if (!candidate.allowed) expect(candidate.message).toContain('an update to v1.0.1');
		expect(formatUpdateRefusal({ code: 'held', message: 'x' })).toBe('[managed-held] x');
	});

	it('fixes a stable channel: no prerelease feed, no prerelease candidate, a stable one admitted', () => {
		const stable = managed();
		const feed = updateVerdict(stable, request({ candidate: null, prerelease: true }));
		expect(feed).toMatchObject({ allowed: false, code: 'channel-denied' });
		if (!feed.allowed) expect(feed.message).toContain('no prerelease feed is consulted');
		expect(updateVerdict(stable, request({ candidate: null }))).toMatchObject({ allowed: true });
		const beta = updateVerdict(stable, request({ candidate: 'v1.2.0-beta.1' }));
		expect(beta).toMatchObject({ allowed: false, code: 'channel-denied' });
		const admitted = updateVerdict(stable, request({ candidate: 'v1.2.0' }));
		expect(admitted).toEqual({
			allowed: true,
			managed: {
				policyRevision: 3,
				current: '1.0.0',
				candidate: 'v1.2.0',
				actor: expect.any(String),
				outcome: 'within-ceiling',
			},
		});
	});

	it('leaves the person to decide on a prerelease channel', () => {
		const prerelease = managed(ceilingOf(document({ channel: 'prerelease' })));
		expect(updateVerdict(prerelease, request({ candidate: null, prerelease: true })).allowed).toBe(
			true
		);
		expect(updateVerdict(prerelease, request({ candidate: 'v1.2.0-rc.1' })).allowed).toBe(true);
	});

	it('pins exactly one version, spelled with or without v, and keeps a host at the pin', () => {
		const pinned = managed(ceilingOf(document({ pin: '1.2.0' })));
		expect(updateVerdict(pinned, request({ candidate: 'v1.2.0' })).allowed).toBe(true);
		expect(updateVerdict(pinned, request({ candidate: '1.2.0' })).allowed).toBe(true);
		const newer = updateVerdict(pinned, request({ candidate: 'v1.3.0' }));
		expect(newer).toMatchObject({ allowed: false, code: 'pin-denied' });
		if (!newer.allowed) expect(newer.message).toContain('pins');
		expect(updateVerdict(pinned, request({ current: '1.2.0', candidate: 'v1.3.0' }))).toMatchObject(
			{ allowed: false, code: 'pin-denied' }
		);
		// The feed itself may be read under a pin; the candidates it names are held one by one.
		expect(updateVerdict(pinned, request({ candidate: null })).allowed).toBe(true);
		// A stable channel still holds a prerelease even when it is the pin.
		const betaPin = managed(ceilingOf(document({ pin: 'v1.2.0-beta' })));
		expect(updateVerdict(betaPin, request({ candidate: 'v1.2.0-beta' }))).toMatchObject({
			allowed: false,
			code: 'channel-denied',
		});
	});

	it('names the actor in the receipt, the operator by default', () => {
		const decision = updateVerdict(managed(), request({ candidate: 'v1.3.0-rc.1' }));
		expect(decision.allowed).toBe(false);
		if (decision.allowed) return;
		const withActor = updateVerdict(
			managed(),
			request({ candidate: 'v1.3.0-rc.1', actor: UPDATE_OPERATOR })
		);
		expect(withActor).toEqual(decision);
	});
});

describe('createUpdatePolicySource', () => {
	const none: IdentityRead = { status: 'none' };
	const enrolled = (actorId: string | null): IdentityRead =>
		({
			status: 'ok',
			epoch: 1,
			record: {
				registration: actorId ? { actorId, registeredAt: 1 } : undefined,
				policy: { appliedRevision: 3, appliedAt: 1 },
			},
		}) as never;

	function source(read: IdentityRead, revision: number | null = 3) {
		return createUpdatePolicySource({
			identity: { read: () => read },
			policy: () => (revision === null ? null : { appliedRevision: revision }),
		});
	}

	it('holds nothing standalone and refuses unavailable once enrolled with no ceiling', () => {
		expect(source(none).standing()).toEqual({ standing: 'standalone' });
		expect(source(none).evaluateUpdate(request())).toEqual({ allowed: true });
		const decision = source(enrolled('actor')).evaluateUpdate(request());
		expect(decision).toMatchObject({ allowed: false, code: 'unavailable' });
	});

	it('reads an unprotected custody with no record as standalone, and one with a record as managed (MRC2-05-10A)', () => {
		const unprotected = (fileExists: boolean): IdentityRead => ({
			status: 'unprotected',
			reason: 'anchor-unavailable',
			message: 'no OS credential store holds an anchor',
			fileExists,
		});
		// No file: a ceiling that holds every roll-forward is installed, and not consulted.
		const standalone = source(unprotected(false));
		standalone.install(document({ hold: true }));
		expect(standalone.standing()).toEqual({ standing: 'standalone' });
		expect(standalone.evaluateUpdate(request())).toEqual({ allowed: true });
		// A file an enrolled run wrote: managed, refused by name, never standalone.
		const held = source(unprotected(true));
		expect(held.standing()).toMatchObject({ standing: 'managed', ceiling: null });
		expect(held.evaluateUpdate(request())).toMatchObject({ allowed: false, code: 'unavailable' });
	});

	it('installs a valid ceiling, keeps the previous one on a refused document, and clears', () => {
		const s = source(enrolled('actor'));
		expect(s.install(document())).toEqual({ installed: true, policyRevision: 3 });
		expect(s.installed()).toEqual(ceilingOf());
		expect(s.evaluateUpdate(request()).allowed).toBe(true);
		expect(s.install(document({ extra: 1 }))).toEqual({
			installed: false,
			problems: ['extra is not a known key'],
		});
		expect(s.installed()).toEqual(ceilingOf());
		s.clear();
		expect(s.installed()).toBeNull();
		expect(s.evaluateUpdate(request())).toMatchObject({ allowed: false, code: 'unavailable' });
	});

	it('refuses a ceiling of another revision unavailable until the host catches up', () => {
		const s = source(enrolled('actor'), 4);
		s.install(document());
		expect(s.evaluateUpdate(request())).toMatchObject({ allowed: false, code: 'unavailable' });
		expect(source(enrolled('actor'), null).evaluateUpdate(request()).allowed).toBe(false);
	});

	it('refuses a paired device unauthenticated until an actor is registered', () => {
		const device = request({
			actor: { kind: 'transport', actor: { peer: 'device-pairing', deviceId: 'd1' } as never },
		});
		const unregistered = source(enrolled(null));
		unregistered.install(document());
		expect(unregistered.evaluateUpdate(device)).toMatchObject({
			allowed: false,
			code: 'unauthenticated',
		});
		const registered = source(enrolled('actor'));
		registered.install(document());
		expect(registered.evaluateUpdate(device).allowed).toBe(true);
	});
});

describe('desktop wiring', () => {
	const source = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8');

	it('composes one update source over the enterprise service and installs it on the checker', () => {
		expect(source.match(/createUpdatePolicySource\(\{/g)).toHaveLength(1);
		expect(source).toMatch(
			/const updatePolicy = createUpdatePolicySource\(\{\n\t+identity: \{ read: \(\) => enterpriseService\?\.identity\.read\(\) \?\? \{ status: 'none' \} \},\n\t+policy: \(\) => enterpriseService\?\.policy\.status\(\) \?\? null,\n\t+\}\);\n\t+setUpdateAuthority\(updatePolicy\);/
		);
		expect(source.match(/setUpdateAuthority\(/g)).toHaveLength(1);
		expect(source.indexOf('setUpdateAuthority(updatePolicy)')).toBeGreaterThan(
			source.indexOf('setEgressAuthority(egressPolicy)')
		);
	});
});
