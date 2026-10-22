/**
 * The plugin ceiling source (MRC-09-03): a closed, bounded document schema
 * that refuses by name, and one installed ceiling projected onto the standing
 * the broker reads, bound to the applied policy revision and never a way back
 * to standalone once enrolled.
 */

import { describe, expect, it } from 'vitest';

import {
	PLUGIN_CEILING_LIMITS,
	createPluginPolicySource,
	parsePluginPolicyCeiling,
} from '../../../main/enterprise/plugin-policy';
import { PermissionBroker } from '../../../main/plugins/permission-broker';
import type { PermissionGrant } from '../../../shared/plugins/permissions';

function document(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		policyRevision: 3,
		plugins: [
			{
				pluginId: 'stt',
				contentHash: 'sha256:abc',
				signerKey: 'pub-1',
				signatureStatus: 'trusted',
				capabilities: [
					{ capability: 'services:provide', scopes: ['transcription'] },
					{ capability: 'media:tools', scopes: ['service-transcription'] },
					{ capability: 'notifications:toast' },
				],
			},
			{
				pluginId: 'relay',
				contentHash: 'sha256:def',
				signerKey: null,
				capabilities: [{ capability: 'services:call', scopes: ['stt/transcription'] }],
				revoked: false,
			},
		],
		revokedPublishers: ['pub-old'],
		...overrides,
	};
}

function problemsOf(raw: unknown): readonly string[] {
	const parsed = parsePluginPolicyCeiling(raw);
	return parsed.ok ? [] : parsed.problems;
}

describe('parsePluginPolicyCeiling', () => {
	it('accepts a complete document as a fresh value the input cannot reach', () => {
		const raw = document();
		const parsed = parsePluginPolicyCeiling(raw);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.ceiling).toEqual({
			policyRevision: 3,
			plugins: [
				{
					pluginId: 'stt',
					contentHash: 'sha256:abc',
					signerKey: 'pub-1',
					signatureStatus: 'trusted',
					capabilities: [
						{ capability: 'services:provide', scopes: ['transcription'] },
						{ capability: 'media:tools', scopes: ['service-transcription'] },
						{ capability: 'notifications:toast' },
					],
				},
				{
					pluginId: 'relay',
					contentHash: 'sha256:def',
					signerKey: null,
					capabilities: [{ capability: 'services:call', scopes: ['stt/transcription'] }],
					revoked: false,
				},
			],
			revokedPublishers: ['pub-old'],
		});
		// Mutating the input afterwards changes nothing the broker will read.
		(raw.plugins as unknown[]).push({ pluginId: 'late' });
		((raw.plugins as Record<string, unknown>[])[0].capabilities as unknown[]).length = 0;
		expect(parsed.ceiling.plugins).toHaveLength(2);
		expect(parsed.ceiling.plugins[0].capabilities).toHaveLength(3);
	});

	it('omits optional fields it was not given', () => {
		const parsed = parsePluginPolicyCeiling({
			policyRevision: 0,
			plugins: [{ pluginId: 'p', contentHash: 'h', signerKey: null, capabilities: [] }],
		});
		expect(parsed).toEqual({
			ok: true,
			ceiling: {
				policyRevision: 0,
				plugins: [{ pluginId: 'p', contentHash: 'h', signerKey: null, capabilities: [] }],
			},
		});
	});

	it('refuses anything that is not an object', () => {
		for (const raw of [null, undefined, 'ceiling', 3, [], true]) {
			expect(problemsOf(raw)).toEqual(['the plugin ceiling is not an object']);
		}
	});

	it('refuses an unknown key at every level (the schema is closed)', () => {
		expect(problemsOf(document({ extra: 1 }))).toEqual(['extra is not a known key']);
		const entry = { ...(document().plugins as Record<string, unknown>[])[1], tenant: 't' };
		expect(problemsOf(document({ plugins: [entry] }))).toEqual([
			'plugins[0].tenant is not a known key',
		]);
		const capability = { capability: 'notifications:toast', wildcard: true };
		expect(
			problemsOf(
				document({
					plugins: [
						{ pluginId: 'p', contentHash: 'h', signerKey: null, capabilities: [capability] },
					],
				})
			)
		).toEqual(['plugins[0].capabilities[0].wildcard is not a known key']);
	});

	it('names a malformed revision, plugin list or publisher list', () => {
		expect(problemsOf(document({ policyRevision: -1 }))).toEqual([
			'policyRevision is not a policy revision',
		]);
		expect(problemsOf(document({ policyRevision: 1.5 }))).toEqual([
			'policyRevision is not a policy revision',
		]);
		expect(problemsOf(document({ policyRevision: '3' }))).toEqual([
			'policyRevision is not a policy revision',
		]);
		expect(problemsOf(document({ plugins: {} }))).toEqual(['plugins is not an array']);
		expect(problemsOf(document({ revokedPublishers: 'pub' }))).toEqual([
			'revokedPublishers is not an array',
		]);
		expect(problemsOf(document({ revokedPublishers: ['ok', ''] }))).toEqual([
			'revokedPublishers[1] is not a publisher key',
		]);
	});

	it('names every malformed entry field by path and refuses the whole document', () => {
		const problems = problemsOf(
			document({
				plugins: [
					{
						pluginId: '',
						contentHash: 7,
						signerKey: 1,
						signatureStatus: 'signed',
						capabilities: 'all',
						revoked: 'yes',
					},
					'not-an-entry',
				],
			})
		);
		expect(problems).toEqual([
			'plugins[0].pluginId is not a plugin id',
			'plugins[0].contentHash is not a content digest',
			'plugins[0].signerKey is neither a publisher key nor null',
			'plugins[0].signatureStatus is not a signature status',
			'plugins[0].revoked is not a boolean',
			'plugins[0].capabilities is not an array',
			'plugins[1] is not an object',
		]);
	});

	it('refuses a capability the host does not know and a scope that is not a string', () => {
		expect(
			problemsOf(
				document({
					plugins: [
						{
							pluginId: 'p',
							contentHash: 'h',
							signerKey: null,
							capabilities: [
								{ capability: 'fs:everything' },
								{ capability: 'fs:read', scopes: ['/ok', 3, ''] },
								{ capability: 'net:fetch', scopes: 'example.com' },
							],
						},
					],
				})
			)
		).toEqual([
			'plugins[0].capabilities[0].capability is not a plugin capability',
			'plugins[0].capabilities[1].scopes[1] is not a scope string',
			'plugins[0].capabilities[1].scopes[2] is not a scope string',
			'plugins[0].capabilities[2].scopes is not an array',
		]);
	});

	it('refuses a plugin named twice', () => {
		const entry = (document().plugins as Record<string, unknown>[])[1];
		expect(problemsOf(document({ plugins: [entry, { ...entry }] }))).toEqual([
			'plugins[1].pluginId "relay" is named twice',
		]);
	});

	it('refuses a document past any bound rather than truncating it', () => {
		const entry = (document().plugins as Record<string, unknown>[])[1];
		const many = Array.from({ length: PLUGIN_CEILING_LIMITS.plugins + 1 }, (_, i) => ({
			...entry,
			pluginId: `p${i}`,
		}));
		expect(problemsOf(document({ plugins: many }))).toEqual([
			`plugins exceeds ${PLUGIN_CEILING_LIMITS.plugins} entries`,
		]);
		const capabilities = Array.from(
			{ length: PLUGIN_CEILING_LIMITS.capabilitiesPerPlugin + 1 },
			() => ({ capability: 'notifications:toast' })
		);
		expect(problemsOf(document({ plugins: [{ ...entry, capabilities }] }))).toEqual([
			`plugins[0].capabilities exceeds ${PLUGIN_CEILING_LIMITS.capabilitiesPerPlugin} entries`,
		]);
		const scopes = Array.from(
			{ length: PLUGIN_CEILING_LIMITS.scopesPerCapability + 1 },
			(_, i) => `/p${i}`
		);
		expect(
			problemsOf(
				document({ plugins: [{ ...entry, capabilities: [{ capability: 'fs:read', scopes }] }] })
			)
		).toEqual([
			`plugins[0].capabilities[0].scopes exceeds ${PLUGIN_CEILING_LIMITS.scopesPerCapability} entries`,
		]);
		expect(problemsOf(document({ plugins: [{ ...entry, pluginId: 'x'.repeat(257) }] }))).toEqual([
			'plugins[0].pluginId is not a plugin id',
		]);
	});
});

describe('createPluginPolicySource', () => {
	function source(state: { enrolled: boolean; applied: number | null }) {
		return createPluginPolicySource({
			enrolled: () => state.enrolled,
			policy: () => (state.applied === null ? null : { appliedRevision: state.applied }),
			now: () => Date.parse('2026-10-22T12:00:00Z'),
		});
	}

	it('is standalone while never enrolled, whatever is installed', () => {
		const state = { enrolled: false, applied: 3 };
		const src = source(state);
		expect(src.standing()).toEqual({ standing: 'standalone' });
		expect(src.install(document())).toEqual({ installed: true, policyRevision: 3, pluginCount: 2 });
		expect(src.standing()).toEqual({ standing: 'standalone' });
	});

	it('refuses by name once enrolled until a ceiling for the applied revision is installed', () => {
		const state = { enrolled: true, applied: null as number | null };
		const src = source(state);
		expect(src.standing()).toMatchObject({
			standing: 'managed',
			ceiling: null,
			policyRevision: null,
			reason: /no applied policy revision/,
		});
		state.applied = 3;
		expect(src.standing()).toMatchObject({
			ceiling: null,
			policyRevision: 3,
			reason: /no plugin ceiling is installed for policy revision 3/,
		});
		expect(src.installed()).toBeNull();
	});

	it('hands the installed ceiling to the broker only for the revision the host is under', () => {
		const state = { enrolled: true, applied: 3 };
		const src = source(state);
		src.install(document());
		expect(src.installed()).toMatchObject({
			installedAt: '2026-10-22T12:00:00.000Z',
			ceiling: { policyRevision: 3 },
		});
		const standing = src.standing();
		expect(standing.standing).toBe('managed');
		expect(standing.ceiling?.plugins.map((p) => p.pluginId)).toEqual(['stt', 'relay']);
		// The host moves to revision 4: the revision-3 ceiling is kept but unusable.
		state.applied = 4;
		expect(src.standing()).toMatchObject({
			ceiling: null,
			policyRevision: 4,
			reason: /revision 3; this host is under revision 4/,
		});
		expect(src.installed()?.ceiling.policyRevision).toBe(3);
		// The next document the endpoint hands over replaces it.
		expect(src.install(document({ policyRevision: 4 }))).toMatchObject({
			installed: true,
			policyRevision: 4,
		});
		expect(src.standing()).toMatchObject({ ceiling: { policyRevision: 4 }, policyRevision: 4 });
	});

	it('keeps the previous installation when a document is refused, and holds nothing after clear', () => {
		const state = { enrolled: true, applied: 3 };
		const src = source(state);
		src.install(document());
		expect(src.install(document({ plugins: 'none' }))).toEqual({
			installed: false,
			problems: ['plugins is not an array'],
		});
		expect(src.standing()).toMatchObject({ ceiling: { policyRevision: 3 } });
		src.clear();
		expect(src.installed()).toBeNull();
		expect(src.standing()).toMatchObject({
			ceiling: null,
			reason: /no plugin ceiling is installed for policy revision 3/,
		});
	});

	it('never returns to standalone once enrolled, even with nothing installed', () => {
		const state = { enrolled: true, applied: 3 };
		const src = source(state);
		expect(src.standing().standing).toBe('managed');
		src.clear();
		expect(src.standing().standing).toBe('managed');
	});

	it('feeds the broker so a live hold is narrowed by the installed ceiling and ends when it is withdrawn', () => {
		const state = { enrolled: true, applied: 3 };
		const src = source(state);
		const grants: PermissionGrant[] = [
			{ capability: 'services:call', scope: 'stt/transcription', grantedAt: 1 },
			{ capability: 'media:tools', scope: 'discord-voice', grantedAt: 1 },
		];
		const broker = new PermissionBroker({
			getGrants: () => grants,
			managed: () => src.standing(),
			getConsent: () => ({
				caps: grants,
				identity: { contentHash: 'sha256:def', signatureStatus: 'unsigned', signerKey: null },
				mintedAt: 1,
				epoch: 2,
				trust: 'persistent',
			}),
		});
		// Nothing installed: the hold is refused by name, never run on consent alone.
		expect(broker.holds('relay', 'services:call', 'stt/transcription')).toMatchObject({
			allowed: false,
			managed: { outcome: 'unavailable', policyRevision: 3 },
		});
		src.install(document());
		expect(broker.holds('relay', 'services:call', 'stt/transcription')).toMatchObject({
			allowed: true,
			managed: { outcome: 'within-ceiling', contentHash: 'sha256:def', consentEpoch: 2 },
		});
		// The media profile is consented but the ceiling admits relay no media:tools.
		expect(broker.holds('relay', 'media:tools', 'discord-voice')).toMatchObject({
			allowed: false,
			managed: { outcome: 'outside-ceiling' },
		});
		// A central revoke of the plugin ends the hold on the next sweep.
		const revoked = document();
		(revoked.plugins as Record<string, unknown>[])[1].revoked = true;
		src.install(revoked);
		expect(broker.holds('relay', 'services:call', 'stt/transcription')).toMatchObject({
			allowed: false,
			managed: { outcome: 'revoked' },
		});
		src.clear();
		expect(broker.holds('relay', 'services:call', 'stt/transcription').managed?.outcome).toBe(
			'unavailable'
		);
	});
});
