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
