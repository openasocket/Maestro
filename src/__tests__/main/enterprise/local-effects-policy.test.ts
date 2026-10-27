/**
 * The local-effects ceiling (MRC2-04-09): a closed, bounded document of one
 * verdict (allow, deny or confirm) per class; one installed ceiling projected
 * onto the standing the system and filesystem handlers hold every open,
 * trash, delete and clipboard write against; the pure three-way verdict with
 * a receipt on every managed answer and nothing at all on a standalone host;
 * and the source resolving a `confirm` through the injected confirmer so a
 * sink only ever sees allow or deny.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IdentityRead } from '../../../main/enterprise/identity-store';
import {
	LOCAL_EFFECTS,
	LOCAL_EFFECT_CLASS_OF,
	LocalEffectRefusedError,
	callingLocalEffectActor,
	createLocalEffectsPolicySource,
	describeLocalEffect,
	holdDeleteEffect,
	holdLocalEffect,
	localEffectActorLabel,
	localEffectVerdict,
	managedLocalEffectsStanding,
	parseLocalEffectsPolicyCeiling,
	resolveLocalEffectVerdict,
	type LocalEffectActor,
	type LocalEffectConfirmer,
	type LocalEffectRequest,
	type LocalEffectsPolicyCeiling,
	type ManagedLocalEffectsStanding,
} from '../../../main/enterprise/local-effects-policy';
import { logger } from '../../../main/utils/logger';
import { runAsTransport } from '../../../main/web-server/auth/transport-actor';

vi.mock('../../../main/utils/logger', () => ({
	logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

function document(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		policyRevision: 3,
		classes: [
			{ class: 'data-transfer', verdict: 'allow' },
			{ class: 'destructive', verdict: 'confirm' },
		],
		...overrides,
	};
}

function problemsOf(raw: unknown): readonly string[] {
	const parsed = parseLocalEffectsPolicyCeiling(raw);
	return parsed.ok ? [] : parsed.problems;
}

function ceilingOf(raw: Record<string, unknown> = document()): LocalEffectsPolicyCeiling {
	const parsed = parseLocalEffectsPolicyCeiling(raw);
	if (!parsed.ok) throw new Error(parsed.problems.join('; '));
	return parsed.ceiling;
}

const managed = (ceiling = ceilingOf()): ManagedLocalEffectsStanding => ({
	standing: 'managed',
	ceiling,
	policyRevision: ceiling.policyRevision,
});

function request(overrides: Partial<LocalEffectRequest> = {}): LocalEffectRequest {
	return {
		effect: 'open-external',
		actor: { kind: 'transport', actor: { peer: 'in-process' } },
		target: 'https://example.com/path?q=1#frag',
		...overrides,
	};
}

const enrolled: IdentityRead = {
	status: 'ok',
	epoch: 1,
	record: {
		registration: { actorId: 'actor', registeredAt: 1 },
		policy: { appliedRevision: 3, appliedAt: 1 },
	} as never,
};

describe('parseLocalEffectsPolicyCeiling', () => {
	it('accepts a complete document as a fresh value the input cannot reach', () => {
		const raw = document();
		const parsed = parseLocalEffectsPolicyCeiling(raw);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.ceiling).toEqual({
			policyRevision: 3,
			classes: [
				{ class: 'data-transfer', verdict: 'allow' },
				{ class: 'destructive', verdict: 'confirm' },
			],
		});
		(raw.classes as unknown[]).push({ class: 'destructive', verdict: 'allow' });
		(raw.classes as { verdict: string }[])[1].verdict = 'allow';
		expect(parsed.ceiling.classes).toHaveLength(2);
		expect(parsed.ceiling.classes[1].verdict).toBe('confirm');
	});

	it('admits an empty class list (every effect is outside the ceiling)', () => {
		expect(ceilingOf(document({ classes: [] })).classes).toEqual([]);
	});

	it('names every problem by path and refuses the whole document on one', () => {
		expect(problemsOf(null)).toEqual(['the local-effects ceiling is not an object']);
		expect(problemsOf(document({ policyRevision: -1 }))).toEqual([
			'policyRevision is not a policy revision',
		]);
		expect(problemsOf(document({ policyRevision: 1.5 }))).toEqual([
			'policyRevision is not a policy revision',
		]);
		expect(problemsOf(document({ extra: true }))).toEqual(['extra is not a known key']);
		expect(problemsOf(document({ classes: {} }))).toEqual(['classes is not an array']);
		expect(problemsOf(document({ classes: [null] }))).toEqual(['classes[0] is not an object']);
		expect(
			problemsOf(document({ classes: [{ class: 'network', verdict: 'maybe', x: 1 }] }))
		).toEqual([
			'classes[0].x is not a known key',
			'classes[0].class is not a local-effect class',
			'classes[0].verdict is not allow, deny or confirm',
		]);
		expect(
			problemsOf(
				document({
					classes: [
						{ class: 'destructive', verdict: 'allow' },
						{ class: 'destructive', verdict: 'deny' },
					],
				})
			)
		).toEqual(['classes[1].class "destructive" is named twice']);
		expect(
			problemsOf(
				document({
					classes: [
						{ class: 'destructive', verdict: 'allow' },
						{ class: 'data-transfer', verdict: 'deny' },
						{ class: 'destructive', verdict: 'deny' },
					],
				})
			)
		).toEqual(['classes exceeds 2 entries']);
	});
});

describe('managedLocalEffectsStanding', () => {
	const policy = { appliedRevision: 3 };

	it('is standalone while not enrolled, whatever is installed', () => {
		expect(managedLocalEffectsStanding({ enrolled: false, policy, ceiling: ceilingOf() })).toEqual({
			standing: 'standalone',
		});
	});

	it('is managed with the ceiling only when it matches the applied revision', () => {
		expect(managedLocalEffectsStanding({ enrolled: true, policy, ceiling: ceilingOf() })).toEqual(
			managed()
		);
		expect(
			managedLocalEffectsStanding({ enrolled: true, policy: null, ceiling: ceilingOf() })
		).toEqual({
			standing: 'managed',
			ceiling: null,
			policyRevision: null,
			reason: 'no applied policy revision is known for this host',
		});
		expect(managedLocalEffectsStanding({ enrolled: true, policy, ceiling: null })).toEqual({
			standing: 'managed',
			ceiling: null,
			policyRevision: 3,
			reason: 'no local-effects ceiling is installed for policy revision 3',
		});
		expect(
			managedLocalEffectsStanding({
				enrolled: true,
				policy,
				ceiling: ceilingOf(document({ policyRevision: 2 })),
			})
		).toEqual({
			standing: 'managed',
			ceiling: null,
			policyRevision: 3,
			reason:
				'the installed local-effects ceiling is for policy revision 2; this host is under revision 3',
		});
	});
});

describe('localEffectVerdict', () => {
	it('every effect is filed in exactly one class', () => {
		expect(Object.keys(LOCAL_EFFECT_CLASS_OF).sort()).toEqual([...LOCAL_EFFECTS].sort());
		expect(LOCAL_EFFECT_CLASS_OF).toEqual({
			'open-external': 'data-transfer',
			'open-path': 'data-transfer',
			'clipboard-write': 'data-transfer',
			trash: 'destructive',
			delete: 'destructive',
		});
	});

	it('standalone allows everything with no receipt', () => {
		for (const effect of LOCAL_EFFECTS)
			expect(localEffectVerdict({ standing: 'standalone' }, request({ effect }))).toEqual({
				verdict: 'allow',
			});
	});

	it('an allowed class answers allow with a receipt that keeps a URL origin, a path, or nothing', () => {
		const standing = managed();
		expect(localEffectVerdict(standing, request())).toEqual({
			verdict: 'allow',
			managed: {
				policyRevision: 3,
				class: 'data-transfer',
				effect: 'open-external',
				actor: 'the operator',
				target: 'https://example.com',
				count: 1,
				outcome: 'within-ceiling',
			},
		});
		const opened = localEffectVerdict(
			standing,
			request({ effect: 'open-path', target: '/Users/me/report.pdf' })
		);
		expect(opened.verdict === 'allow' && opened.managed?.target).toBe('/Users/me/report.pdf');
		const copied = localEffectVerdict(
			standing,
			request({
				effect: 'clipboard-write',
				target: 'never a target',
				actor: { kind: 'transport', actor: { peer: 'web-login', username: 'ana' } },
			})
		);
		expect(copied.verdict === 'allow' && copied.managed).toMatchObject({
			target: null,
			actor: 'web-login:ana',
		});
	});

	it('a confirm class answers confirm with the within-ceiling receipt pending', () => {
		const verdict = localEffectVerdict(
			managed(),
			request({ effect: 'delete', target: '/tmp/a.txt', count: 3 })
		);
		expect(verdict.verdict).toBe('confirm');
		if (verdict.verdict !== 'confirm') return;
		expect(verdict.message).toMatch(
			/^the local-effects ceiling requires the operator's confirmation for the destructive class before deleting items \(3 items, the first \/tmp\/a\.txt\) \(asked by the operator\)$/
		);
		expect(verdict.managed).toEqual({
			policyRevision: 3,
			class: 'destructive',
			effect: 'delete',
			actor: 'the operator',
			target: '/tmp/a.txt',
			count: 3,
			outcome: 'within-ceiling',
		});
	});

	it('denies by name: unavailable, unauthenticated, outside-ceiling, denied', () => {
		const unavailable = localEffectVerdict(
			{ standing: 'managed', ceiling: null, policyRevision: 3, reason: 'no ceiling' },
			request({ effect: 'trash', target: '/tmp/x' })
		);
		expect(unavailable).toMatchObject({
			verdict: 'deny',
			code: 'unavailable',
			message:
				'the managed local-effects ceiling is unavailable (no ceiling); moving /tmp/x to the trash for the operator is refused',
			managed: { outcome: 'unavailable', class: 'destructive', target: '/tmp/x' },
		});
		const unauthenticated = localEffectVerdict(
			managed(),
			request({ actor: { kind: 'transport', actor: { peer: 'device-pairing', deviceId: 'd1' } } }),
			['no registered actor']
		);
		expect(unauthenticated).toMatchObject({
			verdict: 'deny',
			code: 'unauthenticated',
			message: 'no registered actor',
			managed: { actor: 'lite-device:d1', outcome: 'unauthenticated' },
		});
		const outside = localEffectVerdict(
			managed(ceilingOf(document({ classes: [{ class: 'destructive', verdict: 'allow' }] }))),
			request()
		);
		expect(outside).toMatchObject({
			verdict: 'deny',
			code: 'outside-ceiling',
			message:
				'the local-effects ceiling names no verdict for the data-transfer class; opening https://example.com/path?q=1#frag outside Maestro for the operator is refused',
		});
		const denied = localEffectVerdict(
			managed(ceilingOf(document({ classes: [{ class: 'data-transfer', verdict: 'deny' }] }))),
			request({ effect: 'clipboard-write', target: null })
		);
		expect(denied).toMatchObject({
			verdict: 'deny',
			code: 'denied',
			message:
				'the local-effects ceiling denies the data-transfer class; writing to the system clipboard for the operator is refused',
			managed: { target: null, outcome: 'denied' },
		});
	});

	it('describes an effect in words for a prompt', () => {
		expect(describeLocalEffect({ effect: 'trash', target: '/a' })).toBe('moving /a to the trash');
		expect(describeLocalEffect({ effect: 'trash', target: '/a', count: 2 })).toBe(
			'moving items to the trash (2 items, the first /a)'
		);
		expect(describeLocalEffect({ effect: 'delete', target: null })).toBe('deleting an item');
		expect(describeLocalEffect({ effect: 'open-path', target: '/a' })).toBe(
			'opening /a in its default application'
		);
	});
});

describe('resolveLocalEffectVerdict', () => {
	const confirmVerdict = () => {
		const verdict = localEffectVerdict(managed(), request({ effect: 'trash', target: '/tmp/x' }));
		if (verdict.verdict !== 'confirm') throw new Error('expected confirm');
		return verdict;
	};

	it('passes allow and deny through untouched', async () => {
		const allow = localEffectVerdict(managed(), request());
		expect(await resolveLocalEffectVerdict(allow, request(), null)).toEqual({
			allowed: true,
			managed: allow.verdict === 'allow' ? allow.managed : undefined,
		});
		expect(await resolveLocalEffectVerdict({ verdict: 'allow' }, request(), null)).toEqual({
			allowed: true,
		});
		const deny = localEffectVerdict(
			{ standing: 'managed', ceiling: null, policyRevision: 3, reason: 'r' },
			request()
		);
		const confirm = vi.fn();
		expect(await resolveLocalEffectVerdict(deny, request(), confirm)).toEqual({
			allowed: false,
			code: 'unavailable',
			message: deny.verdict === 'deny' ? deny.message : '',
			managed: deny.managed,
		});
		expect(confirm).not.toHaveBeenCalled();
	});

	it('a confirm with no confirmer is refused confirm-unavailable', async () => {
		const verdict = confirmVerdict();
		expect(
			await resolveLocalEffectVerdict(verdict, request({ effect: 'trash', target: '/tmp/x' }), null)
		).toEqual({
			allowed: false,
			code: 'confirm-unavailable',
			message:
				"the local-effects ceiling requires the operator's confirmation for moving /tmp/x to the trash, and this host has no way to ask",
			managed: { ...verdict.managed, outcome: 'confirm-unavailable' },
		});
	});

	it('a confirm is put to the confirmer with the full target; confirmed, declined and unavailable each answer by name', async () => {
		const verdict = confirmVerdict();
		const req = request({ effect: 'trash', target: '/tmp/x' });
		const confirm = vi.fn(async () => 'confirmed' as const);
		expect(await resolveLocalEffectVerdict(verdict, req, confirm)).toEqual({
			allowed: true,
			managed: { ...verdict.managed, outcome: 'confirmed' },
		});
		expect(confirm).toHaveBeenCalledWith({
			effect: 'trash',
			class: 'destructive',
			target: '/tmp/x',
			count: 1,
			actor: 'the operator',
			message: verdict.message,
		});
		expect(await resolveLocalEffectVerdict(verdict, req, async () => 'declined')).toMatchObject({
			allowed: false,
			code: 'declined',
			message: 'the operator declined moving /tmp/x to the trash',
			managed: { outcome: 'declined' },
		});
		expect(await resolveLocalEffectVerdict(verdict, req, async () => 'unavailable')).toMatchObject({
			allowed: false,
			code: 'confirm-unavailable',
			message: /no one could be asked \(no window to show the prompt in\)$/,
		});
	});
});

describe('createLocalEffectsPolicySource and holdLocalEffect', () => {
	it('is standalone while unenrolled, and holds nothing with no authority', async () => {
		const source = createLocalEffectsPolicySource({
			identity: { read: () => ({ status: 'none' }) },
			policy: () => ({ appliedRevision: 3 }),
		});
		expect(source.standing()).toEqual({ standing: 'standalone' });
		expect(await source.authorize(request({ effect: 'delete', target: '/x' }))).toEqual({
			allowed: true,
		});
		expect(await holdLocalEffect(null, request())).toEqual({ allowed: true });
		expect(await holdLocalEffect(undefined, request())).toEqual({ allowed: true });
	});

	it('enrolled with nothing installed refuses unavailable; a refused document keeps the previous ceiling', async () => {
		const source = createLocalEffectsPolicySource({
			identity: { read: () => enrolled },
			policy: () => ({ appliedRevision: 3 }),
		});
		expect(source.installed()).toBeNull();
		const first = await holdLocalEffect(source, request());
		expect(first).toMatchObject({ allowed: false, code: 'unavailable' });
		expect(source.install(document({ classes: 'nope' }))).toEqual({
			installed: false,
			problems: ['classes is not an array'],
		});
		expect(source.installed()).toBeNull();
		expect(source.install(document())).toEqual({ installed: true, policyRevision: 3 });
		expect(source.installed()).toEqual(ceilingOf());
		expect(await holdLocalEffect(source, request())).toMatchObject({
			allowed: true,
			managed: { outcome: 'within-ceiling' },
		});
		source.clear();
		expect(await holdLocalEffect(source, request())).toMatchObject({
			allowed: false,
			code: 'unavailable',
		});
	});

	it('resolves a confirm through the injected confirmer, and refuses when none is injected', async () => {
		const confirm = vi.fn(async () => 'declined' as const);
		const source = createLocalEffectsPolicySource({
			identity: { read: () => enrolled },
			policy: () => ({ appliedRevision: 3 }),
			confirm,
		});
		source.install(document());
		const declined = await source.authorize(request({ effect: 'delete', target: '/tmp/a' }));
		expect(declined).toMatchObject({ allowed: false, code: 'declined' });
		expect(confirm).toHaveBeenCalledTimes(1);
		confirm.mockResolvedValueOnce('confirmed' as never);
		expect(await source.authorize(request({ effect: 'delete', target: '/tmp/a' }))).toMatchObject({
			allowed: true,
			managed: { outcome: 'confirmed' },
		});
		// An allowed class never asks.
		expect(await source.authorize(request())).toMatchObject({ allowed: true });
		expect(confirm).toHaveBeenCalledTimes(2);

		const unasked = createLocalEffectsPolicySource({
			identity: { read: () => enrolled },
			policy: () => ({ appliedRevision: 3 }),
		});
		unasked.install(document());
		expect(await unasked.authorize(request({ effect: 'trash', target: '/tmp/a' }))).toMatchObject({
			allowed: false,
			code: 'confirm-unavailable',
		});
	});

	it('a paired device with no registered actor is refused unauthenticated before the ceiling is read', async () => {
		const unregistered: IdentityRead = {
			status: 'ok',
			epoch: 1,
			record: { policy: { appliedRevision: 3, appliedAt: 1 } } as never,
		};
		const source = createLocalEffectsPolicySource({
			identity: { read: () => unregistered },
			policy: () => ({ appliedRevision: 3 }),
		});
		source.install(document());
		const decision = await source.authorize(
			request({
				actor: { kind: 'transport', actor: { peer: 'device-pairing', deviceId: 'lite-9' } },
			})
		);
		expect(decision).toMatchObject({
			allowed: false,
			code: 'unauthenticated',
			managed: { actor: 'lite-device:lite-9', outcome: 'unauthenticated' },
		});
		if (decision.allowed) return;
		const error = new LocalEffectRefusedError(decision);
		expect(error.name).toBe('LocalEffectRefusedError');
		expect(error.code).toBe('unauthenticated');
		expect(error.receipt).toBe(decision.managed);
		expect(error.message).toMatch(/^\[managed-unauthenticated\] a paired Lite device \(lite-9\)/);
	});
});

describe('holdDeleteEffect and the actor labels (MRC2-04-09A, MRC2-04-12)', () => {
	const operator: LocalEffectActor = { kind: 'transport', actor: { peer: 'in-process' } };
	let work: string;
	beforeEach(() => {
		work = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-local-effects-'));
		vi.mocked(logger.warn).mockClear();
	});
	afterEach(() => fs.rmSync(work, { recursive: true, force: true }));

	/** Real files on disk: a refusal is proven to leave them, not told to. */
	function files(...names: string[]): string[] {
		return names.map((name) => {
			const file = path.join(work, name);
			fs.writeFileSync(file, name);
			return file;
		});
	}

	function enrolledSource(
		doc: Record<string, unknown> = document(),
		confirm?: LocalEffectConfirmer
	) {
		const source = createLocalEffectsPolicySource({
			identity: { read: () => enrolled },
			policy: () => ({ appliedRevision: 3 }),
			...(confirm ? { confirm } : {}),
		});
		expect(source.install(doc)).toMatchObject({ installed: true });
		return source;
	}

	it('holds nothing with no authority or on a standalone host, and never touches a path itself', async () => {
		const [a, b] = files('a.txt', 'b.txt');
		await expect(holdDeleteEffect(null, [a, b], operator, 'FS')).resolves.toBeUndefined();
		await expect(holdDeleteEffect(undefined, [], operator, 'FS')).resolves.toBeUndefined();
		const standalone = createLocalEffectsPolicySource({
			identity: { read: () => ({ status: 'none' }) },
			policy: () => ({ appliedRevision: 3 }),
		});
		const authorize = vi.spyOn(standalone, 'authorize');
		await expect(holdDeleteEffect(standalone, [a, b], operator, 'FS')).resolves.toBeUndefined();
		expect(authorize).toHaveBeenCalledTimes(1);
		expect(fs.existsSync(a)).toBe(true);
		expect(fs.existsSync(b)).toBe(true);
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it('a batch is one hold of its first path with the count; a denying destructive class throws by code, logs under the sink context and leaves every path', async () => {
		const [a, b, c] = files('a.txt', 'b.txt', 'c.txt');
		const source = enrolledSource(
			document({ classes: [{ class: 'destructive', verdict: 'deny' }] })
		);
		const authorize = vi.spyOn(source, 'authorize');
		const failure = await holdDeleteEffect(source, [a, b, c], operator, 'AutoRun').then(
			() => null,
			(error: unknown) => error
		);
		expect(failure).toBeInstanceOf(LocalEffectRefusedError);
		const error = failure as LocalEffectRefusedError;
		expect(error.code).toBe('denied');
		expect(error.message).toMatch(/^\[managed-denied\] /);
		expect(error.receipt).toEqual({
			policyRevision: 3,
			class: 'destructive',
			effect: 'delete',
			actor: 'the operator',
			target: a,
			count: 3,
			outcome: 'denied',
		});
		expect(authorize).toHaveBeenCalledTimes(1);
		expect(authorize).toHaveBeenCalledWith({
			effect: 'delete',
			actor: operator,
			target: a,
			count: 3,
		});
		expect(logger.warn).toHaveBeenCalledTimes(1);
		expect(logger.warn).toHaveBeenCalledWith(
			'Delete refused by the managed local-effects ceiling; nothing was removed',
			'AutoRun',
			{ code: 'denied', receipt: error.receipt }
		);
		for (const file of [a, b, c]) expect(fs.existsSync(file)).toBe(true);
	});

	it('enrolled with no ceiling refuses unavailable before anything; a class the ceiling omits is outside it', async () => {
		const [a] = files('a.txt');
		const bare = createLocalEffectsPolicySource({
			identity: { read: () => enrolled },
			policy: () => ({ appliedRevision: 3 }),
		});
		await expect(holdDeleteEffect(bare, [a], operator, 'FS')).rejects.toMatchObject({
			name: 'LocalEffectRefusedError',
			code: 'unavailable',
			receipt: { policyRevision: 3, effect: 'delete', outcome: 'unavailable' },
		});
		const dataOnly = enrolledSource(
			document({ classes: [{ class: 'data-transfer', verdict: 'allow' }] })
		);
		await expect(holdDeleteEffect(dataOnly, [a], operator, 'FS')).rejects.toMatchObject({
			code: 'outside-ceiling',
			receipt: { class: 'destructive', outcome: 'outside-ceiling' },
		});
		expect(logger.warn).toHaveBeenCalledTimes(2);
		expect(vi.mocked(logger.warn).mock.calls.map((call) => call[1])).toEqual(['FS', 'FS']);
		expect(fs.existsSync(a)).toBe(true);
	});

	it('a confirm class puts the whole batch to the operator once, naming who asked; declined throws declined, confirmed resolves unlogged', async () => {
		const [a, b] = files('a.txt', 'b.txt');
		const confirm = vi.fn<LocalEffectConfirmer>(async () => 'declined');
		const source = enrolledSource(document(), confirm);
		const plugin: LocalEffectActor = { kind: 'plugin', pluginId: 'p' };
		await expect(holdDeleteEffect(source, [a, b], plugin, 'FS')).rejects.toMatchObject({
			code: 'declined',
			receipt: { actor: 'plugin "p"', count: 2, outcome: 'declined' },
		});
		expect(confirm).toHaveBeenCalledTimes(1);
		expect(confirm.mock.calls[0][0]).toMatchObject({
			effect: 'delete',
			class: 'destructive',
			target: a,
			count: 2,
			actor: 'plugin "p"',
		});
		expect(logger.warn).toHaveBeenCalledTimes(1);
		confirm.mockResolvedValueOnce('confirmed' as never);
		await expect(holdDeleteEffect(source, [a, b], operator, 'FS')).resolves.toBeUndefined();
		expect(confirm).toHaveBeenCalledTimes(2);
		expect(logger.warn).toHaveBeenCalledTimes(1);
		expect(fs.existsSync(a)).toBe(true);
		expect(fs.existsSync(b)).toBe(true);
	});

	it('labels a plugin by id and a transport by its peer; the calling actor is the transport the call was admitted over', () => {
		expect(localEffectActorLabel({ kind: 'plugin', pluginId: 'p' })).toBe('plugin "p"');
		expect(localEffectActorLabel(operator)).toBe('the operator');
		expect(localEffectActorLabel({ kind: 'transport', actor: { peer: 'host-secret' } })).toBe(
			'maestro-cli'
		);
		expect(callingLocalEffectActor()).toEqual({
			kind: 'transport',
			actor: { peer: 'in-process' },
		});
		expect(runAsTransport({ kind: 'cli' }, () => callingLocalEffectActor())).toEqual({
			kind: 'transport',
			actor: { peer: 'host-secret' },
		});
	});
});
