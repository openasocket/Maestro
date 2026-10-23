/**
 * Content capture under the signed collection policy (MRC-10-05): the
 * endpoint's profile decides whether anything is kept, the ceiling grants each
 * role by name for the applied revision, a redacted profile keeps a derivative
 * only with the exact original digest beside it, a full profile keeps the
 * original, VIBES evidence is admitted by `full_vibes` alone, the hold sheds
 * and revokes by count, and no text, secret or path reaches a record under any
 * key. Delivery is named as the CP-01 gap it is.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
	CONTENT_REDACTION_RULE_ID,
	CONTENT_ROLE_FAMILIES,
	CONTENT_ROLES,
	contentDeliveryStanding,
	contentFactProblems,
	createContentCapture,
	createContentCollectionSource,
	parseContentCollectionCeiling,
	profileAdmits,
	type ContentCaptureInput,
	type ContentCollectionCeiling,
} from '../../../main/enterprise/content';
import type {
	EndpointCollectionProfile,
	ManagedEnrollmentStatus,
} from '../../../shared/maestro-lib/managed/endpoint-port';
import { redactSecrets } from '../../../shared/redactSecrets';

const sha = (text: string) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

const record = () =>
	({
		version: 1,
		installationId: 'inst-1',
		tenantId: 'tenant-1',
		orgId: 'org-eng',
		enrollmentId: 'enr-1',
		endpoint: { socketPath: '/tmp/endpoint.sock' },
		management: 'managed',
		registration: null,
		policy: { desiredRevision: 3, appliedRevision: 3, observedAt: null },
		enrolledAt: '2026-10-22T11:00:00.000Z',
		updatedAt: '2026-10-22T11:00:00.000Z',
	}) as never;

/** A standing as the lifecycle projects it: standalone, enrolled but detached, or registered and attached under a profile. */
function standing(
	kind: 'standalone' | 'detached' | 'attached',
	profile: EndpointCollectionProfile = 'full',
	revision = 3
): ManagedEnrollmentStatus {
	if (kind === 'standalone') {
		return {
			identity: { status: 'none', reason: null, message: null, record: null },
			connection: null,
			endpoint: null,
			authority: 'none',
			reason: 'This host holds no enrollment.',
			pendingApproval: null,
			lastDenial: null,
		};
	}
	const attached = kind === 'attached';
	return {
		identity: { status: 'ok', reason: null, message: null, record: record() },
		connection: attached
			? ({ connection: 1, registration: 'registered', attached: true } as never)
			: null,
		endpoint: attached
			? {
					outcome: 'attached',
					protocol: 1,
					capabilities: ['telemetry'],
					management: 'managed',
					desiredPolicyRevision: revision,
					appliedPolicyRevision: revision,
					connectivity: 'online',
					collectionProfile: profile,
				}
			: null,
		authority: attached ? 'registered' : 'none',
		reason: attached ? null : 'No endpoint is attached.',
		pendingApproval: null,
		lastDenial: null,
	};
}

const ceiling = (overrides: Partial<ContentCollectionCeiling> = {}): ContentCollectionCeiling => ({
	policyRevision: 3,
	profile: 'full',
	roles: ['user.prompt', 'assistant.output', 'tool.input'],
	permissions: {
		capture: true,
		upload: true,
		storage: true,
		index: false,
		display: false,
		export: false,
	},
	sensitivity: 'confidential',
	maxPayloadBytes: 4096,
	redactionRuleIds: ['dlp-rule-7'],
	...overrides,
});

const input = (overrides: Partial<ContentCaptureInput> = {}): ContentCaptureInput => ({
	role: 'user.prompt',
	text: 'Rotate the key sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij0123456789 in prod',
	sessionId: 'agent-1-ai-tab-1',
	agentId: 'agent-1',
	tabId: 'tab-1',
	provider: 'claude-code',
	runId: 'run-1',
	at: Date.parse('2026-10-22T12:00:00.000Z'),
	...overrides,
});

/** A source under one standing with one installed ceiling, and a capture over it. */
function capture(
	kind: 'standalone' | 'detached' | 'attached',
	profile: EndpointCollectionProfile = 'full',
	doc: ContentCollectionCeiling | null = ceiling({ profile }),
	options: { capacity?: number; holdBytes?: number } = {}
) {
	const source = createContentCollectionSource({ status: () => standing(kind, profile) });
	if (doc) expect(source.install(doc).ok).toBe(true);
	let n = 0;
	const cap = createContentCapture({
		source,
		now: () => Date.parse('2026-10-22T12:00:00.000Z'),
		newId: () => `ref-${++n}`,
		...options,
	});
	return { source, capture: cap };
}

describe('roles, profiles and the ceiling', () => {
	it('maps each role to its contract family and admits by profile', () => {
		expect(CONTENT_ROLE_FAMILIES['tool.input']).toBe('tool.requested');
		expect(CONTENT_ROLE_FAMILIES['vibes.annotations']).toBe('vibes.annotation');
		expect(profileAdmits('metadata', 'user.prompt')).toBe('none');
		expect(profileAdmits('redacted', 'assistant.output')).toBe('derivative');
		expect(profileAdmits('full', 'assistant.output')).toBe('original');
		// Explicit representations: full never implicitly includes full_vibes.
		expect(profileAdmits('full', 'vibes.annotations')).toBe('none');
		expect(profileAdmits('full_vibes', 'vibes.annotations')).toBe('original');
		expect(profileAdmits('redacted', 'vibes.annotations')).toBe('none');
	});

	it('parses a ceiling in full and refuses a malformed one whole, by name', () => {
		expect(parseContentCollectionCeiling(ceiling())).toEqual({ ok: true, ceiling: ceiling() });
		const bad = parseContentCollectionCeiling({
			...ceiling(),
			roles: ['user.prompt', 'reasoning', 'user.prompt'],
			permissions: { ...ceiling().permissions, capture: 'yes', peek: true },
			maxPayloadBytes: 9 * 1024 * 1024,
			redactionRuleIds: [''],
			text: 'smuggled',
		});
		expect(bad.ok).toBe(false);
		if (bad.ok) return;
		expect(bad.problems).toEqual(
			expect.arrayContaining([
				'text is not a known key',
				'roles[1] is not a content role',
				'roles[2] repeats a role',
				'permissions.peek is not a known permission',
				'permissions.capture is not a boolean',
				'maxPayloadBytes is not 1..8388608',
				'redactionRuleIds[0] is not an identifier',
			])
		);
		expect(parseContentCollectionCeiling('nope')).toEqual({
			ok: false,
			problems: ['ceiling is not an object'],
		});
	});
});

describe('the collection standing', () => {
	it('is standalone with no enrollment, refused by name until the endpoint reports a profile and a ceiling matches the revision', () => {
		const detached = createContentCollectionSource({ status: () => standing('detached') });
		expect(
			createContentCollectionSource({ status: () => standing('standalone') }).standing()
		).toEqual({
			mode: 'standalone',
		});
		expect(detached.standing()).toMatchObject({
			mode: 'managed',
			ok: false,
			reason: 'No endpoint is attached.',
			profile: null,
			policyRevision: null,
		});
		const metadata = createContentCollectionSource({
			status: () => standing('attached', 'metadata'),
		});
		expect(metadata.standing()).toMatchObject({
			ok: false,
			profile: 'metadata',
			reason: expect.stringContaining('metadata profile: no content is collected'),
		});
		const full = createContentCollectionSource({ status: () => standing('attached', 'full') });
		expect(full.standing()).toMatchObject({ ok: false, reason: expect.stringContaining('CP-01') });
		expect(full.install(ceiling({ policyRevision: 2 })).ok).toBe(true);
		expect(full.standing()).toMatchObject({
			ok: false,
			reason: 'The installed ceiling is for revision 2, not 3.',
		});
		full.install(ceiling({ profile: 'redacted' }));
		expect(full.standing()).toMatchObject({
			ok: false,
			reason: expect.stringContaining('names profile redacted; the endpoint reports full'),
		});
		full.install(ceiling({ permissions: { ...ceiling().permissions, capture: false } }));
		expect(full.standing()).toMatchObject({ ok: false, reason: 'The ceiling grants no capture.' });
		// A refused document keeps the previous one; a cleared source holds none.
		expect(full.install({ nope: true }).ok).toBe(false);
		expect(full.installed()?.permissions.capture).toBe(false);
		full.install(ceiling());
		expect(full.standing()).toMatchObject({ ok: true, profile: 'full', policyRevision: 3 });
		full.clear();
		expect(full.installed()).toBeNull();
	});
});

describe('capturing content', () => {
	it('keeps nothing standalone or under a refused standing, and refuses a role the ceiling does not grant', () => {
		expect(capture('standalone').capture.capture(input())).toEqual({
			outcome: 'not-collected',
			reason: 'standalone: content collection is not managed here',
		});
		expect(capture('attached', 'metadata', null).capture.capture(input())).toMatchObject({
			outcome: 'not-collected',
			reason: expect.stringContaining('metadata'),
		});
		const { capture: cap } = capture('attached', 'full');
		expect(cap.capture(input({ role: 'tool.output' }))).toEqual({
			outcome: 'not-collected',
			reason: 'the ceiling grants no tool.output',
		});
		expect(cap.status()).toMatchObject({ records: 0, notCollected: 1 });
	});

	it('under redacted keeps a derivative only, with the exact original digest beside it and the rules that made it', () => {
		const { capture: cap } = capture('attached', 'redacted');
		const out = cap.capture(input());
		expect(out.outcome).toBe('recorded');
		if (out.outcome !== 'recorded') return;
		const { fact } = out;
		const redacted = 'Rotate the key [REDACTED_API_KEY] in prod';
		expect(fact).toMatchObject({
			role: 'user.prompt',
			family: 'user.prompt',
			profile: 'redacted',
			policyRevision: 3,
			sensitivity: 'confidential',
			kept: 'derivative',
			completeness: 'pending_upload',
			verification: 'verified_locally',
			gap: null,
			original: {
				referenceId: 'ref-1',
				sha256: sha(input().text),
				representation: 'original',
				byteLength: Buffer.byteLength(input().text),
			},
			derivative: {
				referenceId: 'ref-2',
				sha256: sha(redacted),
				representation: 'derivative',
				byteLength: Buffer.byteLength(redacted),
			},
			transformation: { ruleIds: [CONTENT_REDACTION_RULE_ID, 'dlp-rule-7'], at: fact.at },
		});
		expect(fact.derivative!.sha256).not.toBe(fact.original.sha256);
		// The original bytes were hashed, never held; the derivative is held and verifies against its digest.
		expect(cap.take('ref-1')).toBeNull();
		const held = cap.take('ref-2')!;
		expect(held.bytes.toString('utf8')).toBe(redacted);
		expect(sha(held.bytes.toString('utf8'))).toBe(fact.derivative!.sha256);
		// No text, secret or path under any key of the record.
		const json = JSON.stringify(fact);
		expect(json).not.toContain('sk-ant');
		expect(json).not.toContain('Rotate');
		expect(contentFactProblems(fact)).toEqual([]);
	});

	it('under full keeps the original; VIBES evidence is admitted by full_vibes alone', () => {
		const { capture: full } = capture(
			'attached',
			'full',
			ceiling({ roles: ['vibes.annotations', 'tool.input'] })
		);
		expect(
			full.capture(input({ role: 'vibes.annotations', text: '{"type":"session"}\n' }))
		).toEqual({
			outcome: 'not-collected',
			reason: 'profile full admits no vibes.annotations',
		});
		const call = full.capture(
			input({
				role: 'tool.input',
				text: '{"toolName":"Bash","toolState":{"command":"ls"}}',
				toolName: 'Bash',
			})
		);
		expect(call).toMatchObject({
			outcome: 'recorded',
			fact: { kept: 'original', derivative: null, transformation: null, toolName: 'Bash' },
		});
		if (call.outcome !== 'recorded') return;
		expect(full.take(call.fact.original.referenceId)!.bytes.toString('utf8')).toContain(
			'"command":"ls"'
		);
		const { capture: vibes } = capture(
			'attached',
			'full_vibes',
			ceiling({ profile: 'full_vibes', roles: ['vibes.annotations'] })
		);
		expect(
			vibes.capture(input({ role: 'vibes.annotations', text: '{"type":"session"}\n' }))
		).toMatchObject({
			outcome: 'recorded',
			fact: { family: 'vibes.annotation', kept: 'original', profile: 'full_vibes' },
		});
	});

	it('records an oversize payload with its exact digest and no bytes, sheds the oldest held bytes by count, forgets past capacity, and revokes by name', () => {
		const big = 'x'.repeat(5000);
		const { capture: cap } = capture('attached', 'full', ceiling(), { capacity: 3, holdBytes: 40 });
		const oversize = cap.capture(input({ text: big }));
		expect(oversize).toMatchObject({
			outcome: 'recorded',
			fact: {
				kept: 'none',
				completeness: 'unavailable',
				gap: 'oversize',
				original: { sha256: sha(big), byteLength: 5000 },
			},
		});
		const a = cap.capture(input({ text: 'a'.repeat(30), role: 'assistant.output' }));
		const b = cap.capture(input({ text: 'b'.repeat(30), role: 'assistant.output' }));
		if (a.outcome !== 'recorded' || b.outcome !== 'recorded') throw new Error('not recorded');
		// 30 + 30 > 40: the first held bytes went, counted, and the record says so.
		expect(a.fact).toMatchObject({ kept: 'none', completeness: 'unavailable', gap: 'shed' });
		expect(b.fact.kept).toBe('original');
		expect(cap.take(a.fact.original.referenceId)).toBeNull();
		expect(cap.status()).toMatchObject({
			records: 3,
			held: { count: 1, bytes: 30 },
			shed: 1,
			forgotten: 0,
			byRole: { 'user.prompt': 1, 'assistant.output': 2 },
		});
		// Past capacity the oldest record is forgotten, counted; its bytes (if any) go with it.
		cap.capture(input({ text: 'c', role: 'assistant.output' }));
		expect(cap.facts().map((fact) => fact.original.byteLength)).toEqual([30, 30, 1]);
		expect(cap.status().forgotten).toBe(1);
		expect(cap.revoke('ceiling cleared')).toBe(2);
		expect(cap.facts().every((fact) => fact.kept === 'none')).toBe(true);
		expect(b.fact.gap).toBe('revoked: ceiling cleared');
		expect(cap.status()).toMatchObject({ held: { count: 0, bytes: 0 }, revoked: 2 });
	});
});

describe('the fact reader and delivery', () => {
	it('refuses a fact that smuggles text, a prompt, bytes or a path under any key', () => {
		const { capture: cap } = capture('attached', 'full');
		const out = cap.capture(input());
		if (out.outcome !== 'recorded') throw new Error('not recorded');
		for (const key of ['text', 'prompt', 'bytes', 'cwd', 'path', 'reasoning'])
			expect(contentFactProblems({ ...out.fact, [key]: 'x' })).toEqual([
				`${key} is not a fact field`,
			]);
		expect(
			contentFactProblems({ ...out.fact, original: { ...out.fact.original, url: 'file:///x' } })
		).toEqual(['original.url is not a reference field']);
		expect(contentFactProblems(null)).toEqual(['fact is not an object']);
	});

	it('names delivery as the coordination gap it is', () => {
		expect(contentDeliveryStanding()).toEqual({
			available: false,
			reason: expect.stringContaining('CP-01'),
		});
	});
});

// MRC-10-08: metadata-only exclusion, separate permissions, exact integrity, revoke and bounded input.
describe('bounded content (MRC-10-08)', () => {
	const T = Date.parse('2026-10-22T12:00:00.000Z');

	it('metadata-only: under the metadata profile no role is collected whatever the ceiling grants, no byte is held, and nothing of the inputs is kept anywhere', () => {
		const { source, capture: cap } = capture(
			'attached',
			'metadata',
			ceiling({ profile: 'metadata', roles: [...CONTENT_ROLES] })
		);
		expect(source.installed()?.roles).toEqual(CONTENT_ROLES);
		for (const role of CONTENT_ROLES) {
			expect(
				cap.capture(input({ role, text: `CANARY ${role} sk-ant-api03-XYZ0123456789` }))
			).toEqual({
				outcome: 'not-collected',
				reason: expect.stringContaining('metadata profile: no content is collected'),
			});
		}
		expect(cap.status()).toMatchObject({
			records: 0,
			held: { count: 0, bytes: 0 },
			notCollected: CONTENT_ROLES.length,
			byRole: {},
		});
		expect(cap.facts()).toEqual([]);
		expect(JSON.stringify([cap.status(), source.standing()])).not.toContain('CANARY');
	});

	it('a standing that lapses mid-turn refuses the next line by name and keeps what it held until a revoke; a standing that returns admits again', () => {
		let kind: 'attached' | 'detached' = 'attached';
		let profile: EndpointCollectionProfile = 'full';
		const source = createContentCollectionSource({ status: () => standing(kind, profile) });
		expect(source.install(ceiling()).ok).toBe(true);
		let n = 0;
		const cap = createContentCapture({ source, now: () => T, newId: () => `ref-${++n}` });
		expect(cap.capture(input({ text: 'first line' }))).toMatchObject({ outcome: 'recorded' });
		kind = 'detached';
		expect(cap.capture(input({ text: 'second line' }))).toEqual({
			outcome: 'not-collected',
			reason: 'No endpoint is attached.',
		});
		kind = 'attached';
		profile = 'metadata';
		expect(cap.capture(input({ text: 'third line' }))).toMatchObject({
			outcome: 'not-collected',
			reason: expect.stringContaining('metadata'),
		});
		// A lapse is not a revoke: the first line is still held, until the host says otherwise.
		expect(cap.take('ref-1')?.bytes.toString('utf8')).toBe('first line');
		expect(cap.revoke('standing lapsed')).toBe(1);
		profile = 'full';
		expect(cap.capture(input({ text: 'fourth line' }))).toMatchObject({
			outcome: 'recorded',
			fact: { kept: 'original', gap: null },
		});
		expect(cap.status()).toMatchObject({
			records: 2,
			notCollected: 2,
			revoked: 1,
			held: { count: 1, bytes: Buffer.byteLength('fourth line') },
		});
		expect(JSON.stringify(cap.facts())).not.toContain('line');
	});

	it('separate permissions: each role is its own grant checked before the profile, and the permission words ride the fact as a copy of the parsed ceiling', () => {
		const only = ceiling({
			roles: ['assistant.output'],
			permissions: {
				capture: true,
				upload: false,
				storage: false,
				index: false,
				display: false,
				export: false,
			},
		});
		const { source, capture: cap } = capture('attached', 'full', only);
		expect(cap.capture(input({ role: 'user.prompt' }))).toEqual({
			outcome: 'not-collected',
			reason: 'the ceiling grants no user.prompt',
		});
		expect(cap.capture(input({ role: 'tool.input', text: '{}' }))).toEqual({
			outcome: 'not-collected',
			reason: 'the ceiling grants no tool.input',
		});
		expect(cap.capture(input({ role: 'vibes.annotations', text: '{}' }))).toEqual({
			outcome: 'not-collected',
			reason: 'the ceiling grants no vibes.annotations',
		});
		const out = cap.capture(input({ role: 'assistant.output', text: 'an answer' }));
		expect(out).toMatchObject({
			outcome: 'recorded',
			fact: { permissions: { ...only.permissions }, sensitivity: 'confidential' },
		});
		if (out.outcome !== 'recorded') return;
		// The document handed in is not the ceiling held: a later change to it reaches neither the source nor the fact.
		only.permissions.upload = true;
		expect(source.installed()?.permissions.upload).toBe(false);
		expect(out.fact.permissions.upload).toBe(false);
		// The profile that would admit VIBES evidence does not grant it: the grant is the ceiling's alone.
		const { capture: ungranted } = capture(
			'attached',
			'full_vibes',
			ceiling({ profile: 'full_vibes', roles: ['user.prompt'] })
		);
		expect(ungranted.capture(input({ role: 'vibes.annotations', text: '{}' }))).toEqual({
			outcome: 'not-collected',
			reason: 'the ceiling grants no vibes.annotations',
		});
		expect(ungranted.capture(input())).toMatchObject({
			outcome: 'recorded',
			fact: { profile: 'full_vibes', kept: 'original' },
		});
		expect(cap.status()).toMatchObject({
			records: 1,
			notCollected: 3,
			byRole: { 'assistant.output': 1 },
		});
	});

	it('exact integrity: the original digest is of the bytes as given, the derivative digest is of the bytes held, multi-byte text counts in bytes, and a take is a copy', () => {
		const text =
			'Déploie la clé sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij0123456789 puis Bearer eyJhbGciOiJIUzI1NiJ9.CANARYCLAIMS.CANARYSIG en prod';
		const expected = redactSecrets(text, { hexBlobs: true }).text;
		expect(expected).not.toContain('sk-ant');
		expect(expected).not.toContain('CANARY');
		expect(Buffer.byteLength(text, 'utf8')).toBeGreaterThan(text.length);
		const { capture: redacted } = capture('attached', 'redacted');
		const out = redacted.capture(input({ text }));
		if (out.outcome !== 'recorded') throw new Error('not recorded');
		expect(out.fact.original).toEqual({
			referenceId: 'ref-1',
			sha256: sha(text),
			representation: 'original',
			byteLength: Buffer.byteLength(text, 'utf8'),
		});
		const held = redacted.take(out.fact.derivative!.referenceId)!;
		expect(held.bytes.toString('utf8')).toBe(expected);
		expect(out.fact.derivative).toEqual({
			referenceId: 'ref-2',
			sha256: sha(expected),
			representation: 'derivative',
			byteLength: held.bytes.byteLength,
		});
		expect(held.fact).toBe(out.fact);
		// A copy: writing into the taken buffer changes nothing held.
		held.bytes.fill(0);
		expect(redacted.take('ref-2')!.bytes.toString('utf8')).toBe(expected);
		// Text with nothing to redact: byte-identical, which the two digests say, and still a derivative under the rules.
		const plain = redacted.capture(input({ text: 'nothing secret here' }));
		if (plain.outcome !== 'recorded') throw new Error('not recorded');
		expect(plain.fact.derivative!.sha256).toBe(plain.fact.original.sha256);
		expect(plain.fact).toMatchObject({
			kept: 'derivative',
			transformation: { ruleIds: [CONTENT_REDACTION_RULE_ID, 'dlp-rule-7'], at: plain.fact.at },
		});
		// Under full the held bytes are the input itself, verified against the digest, and no derivative is made.
		const { capture: full } = capture('attached', 'full');
		const kept = full.capture(input({ text }));
		if (kept.outcome !== 'recorded') throw new Error('not recorded');
		const original = full.take(kept.fact.original.referenceId)!;
		expect(original.bytes.toString('utf8')).toBe(text);
		expect(sha(original.bytes.toString('utf8'))).toBe(kept.fact.original.sha256);
		expect(kept.fact).toMatchObject({ derivative: null, transformation: null });
		// The ledgers hold digests and lengths, never the text.
		const ledgers = JSON.stringify([
			redacted.facts(),
			full.facts(),
			redacted.status(),
			full.status(),
		]);
		for (const canary of ['sk-ant', 'CANARY', 'Déploie', 'nothing secret', 'REDACTED']) {
			expect(ledgers).not.toContain(canary);
		}
		for (const fact of [...redacted.facts(), ...full.facts()]) {
			expect(contentFactProblems(fact)).toEqual([]);
		}
	});

	it('revoke drops every held byte across roles by name and leaves the records with their digests; a later capture is held afresh; an empty revoke is zero', () => {
		const { capture: cap } = capture('attached', 'full');
		const outs = [
			cap.capture(input({ text: 'prompt' })),
			cap.capture(input({ role: 'assistant.output', text: 'answer' })),
			cap.capture(input({ role: 'tool.input', text: '{"toolName":"Read"}', toolName: 'Read' })),
		];
		expect(cap.status().held).toEqual({ count: 3, bytes: 6 + 6 + 19 });
		expect(cap.revoke('policy revision 4 applied')).toBe(3);
		for (const out of outs) {
			if (out.outcome !== 'recorded') throw new Error('not recorded');
			expect(out.fact).toMatchObject({
				kept: 'none',
				completeness: 'unavailable',
				gap: 'revoked: policy revision 4 applied',
			});
			expect(out.fact.original.sha256).toMatch(/^[a-f0-9]{64}$/);
			expect(cap.take(out.fact.original.referenceId)).toBeNull();
		}
		expect(cap.revoke('again')).toBe(0);
		expect(cap.status()).toMatchObject({ records: 3, held: { count: 0, bytes: 0 }, revoked: 3 });
		expect(cap.capture(input({ text: 'after' }))).toMatchObject({
			outcome: 'recorded',
			fact: { kept: 'original', completeness: 'pending_upload', gap: null },
		});
		expect(cap.status().held).toEqual({ count: 1, bytes: 5 });
		expect(cap.facts().map((fact) => fact.gap)).toEqual([
			'revoked: policy revision 4 applied',
			'revoked: policy revision 4 applied',
			'revoked: policy revision 4 applied',
			null,
		]);
	});

	it('bounded input: the payload cap holds at the byte and applies to the kept representation, one capture can shed several, a tool name is cut at 128, and empty text is a record', () => {
		const { capture: capped } = capture('attached', 'full', ceiling({ maxPayloadBytes: 16 }));
		expect(capped.capture(input({ text: 'x'.repeat(16) }))).toMatchObject({
			outcome: 'recorded',
			fact: { kept: 'original', gap: null, original: { byteLength: 16 } },
		});
		// Nine characters, eighteen bytes: the cap is in bytes.
		expect(capped.capture(input({ text: 'é'.repeat(9) }))).toMatchObject({
			outcome: 'recorded',
			fact: {
				kept: 'none',
				gap: 'oversize',
				original: { byteLength: 18, sha256: sha('é'.repeat(9)) },
			},
		});
		expect(capped.status()).toMatchObject({ records: 2, held: { count: 1, bytes: 16 } });
		// Under redacted the cap is measured on the derivative: an original over the cap whose derivative fits is kept.
		const { capture: redacted } = capture(
			'attached',
			'redacted',
			ceiling({ profile: 'redacted', maxPayloadBytes: 48 })
		);
		const secret = redacted.capture(input());
		if (secret.outcome !== 'recorded') throw new Error('not recorded');
		expect(secret.fact.original.byteLength).toBeGreaterThan(48);
		expect(secret.fact.derivative!.byteLength).toBeLessThanOrEqual(48);
		expect(secret.fact).toMatchObject({ kept: 'derivative', gap: null });
		// One capture sheds as many of the oldest held as it needs, each counted and named.
		const { capture: hold } = capture('attached', 'full', ceiling(), { holdBytes: 24 });
		const a = hold.capture(input({ text: 'a'.repeat(10) }));
		const b = hold.capture(input({ text: 'b'.repeat(10) }));
		const c = hold.capture(input({ text: 'c'.repeat(16) }));
		if (a.outcome !== 'recorded' || b.outcome !== 'recorded' || c.outcome !== 'recorded')
			throw new Error('not recorded');
		expect([a.fact.gap, b.fact.gap, c.fact.gap]).toEqual(['shed', 'shed', null]);
		expect(hold.status()).toMatchObject({ shed: 2, held: { count: 1, bytes: 16 }, records: 3 });
		expect(hold.take(a.fact.original.referenceId)).toBeNull();
		expect(hold.take(c.fact.original.referenceId)!.bytes.toString('utf8')).toBe('c'.repeat(16));
		// The ledger bound forgets the oldest record and its bytes.
		const { capture: one } = capture('attached', 'full', ceiling(), { capacity: 1 });
		const first = one.capture(input({ text: 'first' }));
		one.capture(input({ text: 'second' }));
		if (first.outcome !== 'recorded') throw new Error('not recorded');
		expect(one.facts()).toHaveLength(1);
		expect(one.take(first.fact.original.referenceId)).toBeNull();
		expect(one.status()).toMatchObject({ forgotten: 1, held: { count: 1, bytes: 6 } });
		// A tool name is bounded; empty text is a record with the digest of nothing.
		const { capture: tools } = capture('attached', 'full');
		const call = tools.capture(
			input({ role: 'tool.input', text: '{}', toolName: 'T'.repeat(200) })
		);
		expect(call).toMatchObject({ outcome: 'recorded', fact: { toolName: 'T'.repeat(128) } });
		expect(tools.capture(input({ role: 'assistant.output', text: '' }))).toMatchObject({
			outcome: 'recorded',
			fact: { kept: 'original', original: { byteLength: 0, sha256: sha('') } },
		});
	});
});
