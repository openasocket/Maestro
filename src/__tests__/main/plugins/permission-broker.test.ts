import { describe, it, expect, vi } from 'vitest';
import {
	PermissionBroker,
	managedPluginStanding,
	type ManagedPluginStanding,
	type PluginPolicyCeiling,
} from '../../../main/plugins/permission-broker';
import type { PluginConsentView } from '../../../main/plugins/authorization-ledger';
import type { PermissionGrant } from '../../../shared/plugins/permissions';

function grant(capability: string, scope?: string): PermissionGrant {
	return { capability, ...(scope ? { scope } : {}), grantedAt: 1 } as PermissionGrant;
}

describe('PermissionBroker', () => {
	it('denies by default when the plugin has no grants', () => {
		const broker = new PermissionBroker({ getGrants: () => [] });
		const d = broker.authorize('p', 'fs.read', { path: '/x' });
		expect(d.allowed).toBe(false);
		expect(d.capability).toBe('fs:read');
		expect(d.reason).toMatch(/permission denied/);
	});

	it('allows a scoped fs.read inside the granted path', () => {
		const broker = new PermissionBroker({ getGrants: () => [grant('fs:read', '/data')] });
		expect(broker.authorize('p', 'fs.read', { path: '/data/x' }).allowed).toBe(true);
		expect(broker.authorize('p', 'fs.read', { path: '/etc/x' }).allowed).toBe(false);
	});

	it('maps net.fetch to net:fetch and checks host scope', () => {
		const broker = new PermissionBroker({ getGrants: () => [grant('net:fetch', 'example.com')] });
		expect(broker.authorize('p', 'net.fetch', { url: 'https://api.example.com' }).allowed).toBe(
			true
		);
		expect(broker.authorize('p', 'net.fetch', { url: 'https://evil.com' }).allowed).toBe(false);
	});

	it('maps net.connect to net:connect and checks host scope', () => {
		const broker = new PermissionBroker({
			getGrants: () => [grant('net:connect', 'gateway.discord.gg')],
		});
		expect(
			broker.authorize('p', 'net.connect', { url: 'wss://gateway.discord.gg/?v=10' }).allowed
		).toBe(true);
		expect(broker.authorize('p', 'net.connect', { url: 'wss://evil.example' }).allowed).toBe(false);
	});

	it('allows net.send/net.close on a SCOPED net:connect grant (handler re-authorizes the socket URL)', () => {
		// These methods carry only a socketId, so extractTarget yields no host. The
		// broker must not reject a scoped grant for a missing target - it confirms
		// the capability is held and the handler re-checks the stored socket origin.
		const broker = new PermissionBroker({
			getGrants: () => [grant('net:connect', 'gateway.discord.gg')],
		});
		expect(broker.authorize('p', 'net.send', { socketId: 's', data: 'hi' }).allowed).toBe(true);
		expect(broker.authorize('p', 'net.close', { socketId: 's' }).allowed).toBe(true);
	});

	it('denies net.send/net.close when the plugin holds no net:connect grant at all', () => {
		const broker = new PermissionBroker({ getGrants: () => [grant('net:fetch', 'example.com')] });
		expect(broker.authorize('p', 'net.send', { socketId: 's', data: 'hi' }).allowed).toBe(false);
		expect(broker.authorize('p', 'net.close', { socketId: 's' }).allowed).toBe(false);
	});

	it('re-reads grants on each call (live revocation)', () => {
		let grants: PermissionGrant[] = [grant('notifications:toast')];
		const broker = new PermissionBroker({ getGrants: () => grants });
		expect(broker.authorize('p', 'notifications.toast', {}).allowed).toBe(true);
		grants = [];
		expect(broker.authorize('p', 'notifications.toast', {}).allowed).toBe(false);
	});

	it('audits every decision', () => {
		const onDecision = vi.fn();
		const broker = new PermissionBroker({ getGrants: () => [], onDecision });
		broker.authorize('p', 'process.spawn', { command: 'ls' });
		expect(onDecision).toHaveBeenCalledWith(
			'p',
			'process.spawn',
			expect.objectContaining({ allowed: false, capability: 'process:spawn' })
		);
	});

	it('checks live media grants without emitting synthetic RPC audit decisions', () => {
		let grants: PermissionGrant[] = [grant('media:tools', 'discord-voice')];
		const onDecision = vi.fn();
		const broker = new PermissionBroker({ getGrants: () => grants, onDecision });
		expect(broker.authorize('p', 'media.open', {}).allowed).toBe(true);
		expect(broker.authorize('p', 'media.open', {}, { audit: false }).allowed).toBe(true);
		grants = [grant('media:tools', '*')];
		expect(broker.authorize('p', 'media.open', {}, { audit: false }).allowed).toBe(false);
		grants = [];
		expect(broker.authorize('p', 'media.open', {}, { audit: false }).allowed).toBe(false);
		expect(onDecision).toHaveBeenCalledTimes(1);
		expect(broker.authorize('p', 'media.open', {}).allowed).toBe(false);
		expect(onDecision).toHaveBeenCalledTimes(2);
	});

	it('preserves protected-path refusal when a host check suppresses auditing', () => {
		const onDecision = vi.fn();
		const broker = new PermissionBroker({
			getGrants: () => [grant('fs:read')],
			protectedPaths: () => ['/private/config'],
			onDecision,
		});
		expect(
			broker.authorize('p', 'fs.read', { path: '/private/config/grants.json' }, { audit: false })
		).toMatchObject({
			allowed: false,
			reason: expect.stringContaining('protected location'),
		});
		expect(onDecision).not.toHaveBeenCalled();
	});

	it('per-plugin isolation: grants for one plugin do not leak to another', () => {
		const broker = new PermissionBroker({
			getGrants: (id) => (id === 'trusted' ? [grant('fs:read')] : []),
		});
		expect(broker.authorize('trusted', 'fs.read', { path: '/x' }).allowed).toBe(true);
		expect(broker.authorize('other', 'fs.read', { path: '/x' }).allowed).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Managed plugin ceiling (MRC-09-01): intersection with live local consent
// ---------------------------------------------------------------------------

function consentOf(overrides: Partial<PluginConsentView> = {}): PluginConsentView {
	return {
		caps: [grant('fs:read', '/data'), grant('net:fetch', 'example.com')],
		identity: { contentHash: 'sha256:abc', signatureStatus: 'trusted', signerKey: 'pub-1' },
		mintedAt: 5,
		epoch: 7,
		trust: 'persistent',
		...overrides,
	};
}

function ceilingOf(overrides: Partial<PluginPolicyCeiling> = {}): PluginPolicyCeiling {
	return {
		policyRevision: 3,
		plugins: [
			{
				pluginId: 'p',
				contentHash: 'sha256:abc',
				signerKey: 'pub-1',
				capabilities: [
					{ capability: 'fs:read', scopes: ['/data/allowed'] },
					{ capability: 'net:fetch', scopes: ['example.com'] },
					{ capability: 'notifications:toast' },
					{ capability: 'agents:dispatch', scopes: ['agent-a'] },
				],
			},
		],
		...overrides,
	};
}

function managedWith(
	ceiling: PluginPolicyCeiling | null,
	reason = 'none installed'
): ManagedPluginStanding {
	return ceiling
		? { standing: 'managed', ceiling, policyRevision: ceiling.policyRevision }
		: { standing: 'managed', ceiling: null, policyRevision: 3, reason };
}

describe('PermissionBroker managed ceiling (MRC-09-01)', () => {
	const localGrants = () => [
		grant('fs:read', '/data'),
		grant('net:fetch', 'example.com'),
		grant('notifications:toast'),
		grant('agents:dispatch', 'agent-a,agent-b'),
	];

	it('leaves a standalone host on local consent alone, with no managed receipt', () => {
		const broker = new PermissionBroker({
			getGrants: localGrants,
			managed: () => ({ standing: 'standalone' }),
			getConsent: () => consentOf(),
		});
		const d = broker.authorize('p', 'fs.read', { path: '/data/anything' });
		expect(d.allowed).toBe(true);
		expect(d.managed).toBeUndefined();
	});

	it('allows a call inside both consent and the ceiling, stamping the receipt', () => {
		const broker = new PermissionBroker({
			getGrants: localGrants,
			managed: () => managedWith(ceilingOf()),
			getConsent: () => consentOf(),
		});
		const d = broker.authorize('p', 'fs.read', { path: '/data/allowed/file' });
		expect(d.allowed).toBe(true);
		expect(d.managed).toEqual({
			policyRevision: 3,
			outcome: 'within-ceiling',
			contentHash: 'sha256:abc',
			signerKey: 'pub-1',
			consentEpoch: 7,
		});
	});

	it('narrows consent: a target the user consented to but the ceiling does not is denied', () => {
		const broker = new PermissionBroker({
			getGrants: localGrants,
			managed: () => managedWith(ceilingOf()),
			getConsent: () => consentOf(),
		});
		const d = broker.authorize('p', 'fs.read', { path: '/data/elsewhere' });
		expect(d.allowed).toBe(false);
		expect(d.reason).toMatch(/outside the managed plugin ceiling/);
		expect(d.managed?.outcome).toBe('outside-ceiling');
		// An allowlist member the ceiling omits is denied even though consent names it.
		expect(
			broker.authorize('p', 'agents.dispatch', { agentId: 'agent-b', prompt: 'x' }).allowed
		).toBe(false);
		expect(
			broker.authorize('p', 'agents.dispatch', { agentId: 'agent-a', prompt: 'x' }).allowed
		).toBe(true);
	});

	it('never mints consent: a capability the ceiling admits but the user did not grant stays denied', () => {
		const broker = new PermissionBroker({
			getGrants: () => [grant('fs:read', '/data')],
			managed: () => managedWith(ceilingOf()),
			getConsent: () => consentOf({ caps: [grant('fs:read', '/data')] }),
		});
		const d = broker.authorize('p', 'notifications.toast', { title: 't', message: 'm' });
		expect(d.allowed).toBe(false);
		expect(d.reason).toBe('permission denied: notifications:toast');
		expect(d.managed).toBeUndefined();
	});

	it('keeps the protected-location exclusion ahead of the ceiling', () => {
		const broker = new PermissionBroker({
			getGrants: () => [grant('fs:read')],
			protectedPaths: () => ['/data/allowed'],
			managed: () =>
				managedWith(
					ceilingOf({
						plugins: [
							{
								pluginId: 'p',
								contentHash: 'sha256:abc',
								signerKey: 'pub-1',
								capabilities: [{ capability: 'fs:read' }],
							},
						],
					})
				),
			getConsent: () => consentOf({ caps: [grant('fs:read')] }),
		});
		const d = broker.authorize('p', 'fs.read', { path: '/data/allowed/secret' });
		expect(d.allowed).toBe(false);
		expect(d.reason).toMatch(/protected location/);
		expect(d.managed).toBeUndefined();
	});

	it('denies a plugin the ceiling does not name', () => {
		const broker = new PermissionBroker({
			getGrants: localGrants,
			managed: () => managedWith(ceilingOf()),
			getConsent: () => consentOf(),
		});
		const d = broker.authorize('other', 'notifications.toast', { title: 't', message: 'm' });
		expect(d.allowed).toBe(false);
		expect(d.managed?.outcome).toBe('outside-ceiling');
	});

	it('binds the ceiling to the consented identity: content, publisher and signature status', () => {
		const mk = (consent: PluginConsentView, ceiling = ceilingOf()) =>
			new PermissionBroker({
				getGrants: localGrants,
				managed: () => managedWith(ceiling),
				getConsent: () => consent,
			}).authorize('p', 'notifications.toast', { title: 't', message: 'm' });
		expect(mk(consentOf()).allowed).toBe(true);
		const content = mk(
			consentOf({
				identity: { contentHash: 'sha256:other', signatureStatus: 'trusted', signerKey: 'pub-1' },
			})
		);
		expect(content.allowed).toBe(false);
		expect(content.managed?.outcome).toBe('identity-mismatch');
		const publisher = mk(
			consentOf({
				identity: { contentHash: 'sha256:abc', signatureStatus: 'trusted', signerKey: 'pub-2' },
			})
		);
		expect(publisher.allowed).toBe(false);
		expect(publisher.managed?.outcome).toBe('identity-mismatch');
		const strict = ceilingOf();
		strict.plugins = [{ ...strict.plugins[0], signatureStatus: 'trusted' }];
		const status = mk(
			consentOf({
				identity: { contentHash: 'sha256:abc', signatureStatus: 'unsigned', signerKey: 'pub-1' },
			}),
			strict
		);
		expect(status.allowed).toBe(false);
		expect(status.managed?.outcome).toBe('identity-mismatch');
	});

	it('denies when no consented identity is readable, even if grants are present', () => {
		const broker = new PermissionBroker({
			getGrants: localGrants,
			managed: () => managedWith(ceilingOf()),
		});
		const d = broker.authorize('p', 'notifications.toast', { title: 't', message: 'm' });
		expect(d.allowed).toBe(false);
		expect(d.managed).toMatchObject({
			outcome: 'identity-mismatch',
			contentHash: null,
			consentEpoch: null,
		});
	});

	it('honors a central revoke of the plugin or its publisher immediately, re-read per call', () => {
		let ceiling = ceilingOf();
		const broker = new PermissionBroker({
			getGrants: localGrants,
			managed: () => managedWith(ceiling),
			getConsent: () => consentOf(),
		});
		expect(broker.authorize('p', 'notifications.toast', { title: 't', message: 'm' }).allowed).toBe(
			true
		);
		ceiling = ceilingOf({ plugins: [{ ...ceilingOf().plugins[0], revoked: true }] });
		const revoked = broker.authorize('p', 'notifications.toast', { title: 't', message: 'm' });
		expect(revoked.allowed).toBe(false);
		expect(revoked.managed?.outcome).toBe('revoked');
		ceiling = ceilingOf({ revokedPublishers: ['pub-1'] });
		expect(
			broker.authorize('p', 'notifications.toast', { title: 't', message: 'm' }).managed?.outcome
		).toBe('revoked');
	});

	it('keeps a local revoke authoritative under the ceiling', () => {
		let grants = localGrants();
		let consent: PluginConsentView | null = consentOf();
		const broker = new PermissionBroker({
			getGrants: () => grants,
			managed: () => managedWith(ceilingOf()),
			getConsent: () => consent,
		});
		expect(broker.authorize('p', 'notifications.toast', { title: 't', message: 'm' }).allowed).toBe(
			true
		);
		grants = [];
		consent = null;
		const d = broker.authorize('p', 'notifications.toast', { title: 't', message: 'm' });
		expect(d.allowed).toBe(false);
		expect(d.reason).toBe('permission denied: notifications:toast');
		expect(d.managed).toBeUndefined();
	});

	it('refuses every plugin call by name on a managed host with no usable ceiling', () => {
		const broker = new PermissionBroker({
			getGrants: localGrants,
			managed: () => managedWith(null, 'no plugin ceiling is installed for policy revision 3'),
			getConsent: () => consentOf(),
		});
		const d = broker.authorize('p', 'notifications.toast', { title: 't', message: 'm' });
		expect(d.allowed).toBe(false);
		expect(d.reason).toMatch(
			/ceiling is unavailable \(no plugin ceiling is installed for policy revision 3\)/
		);
		expect(d.managed?.outcome).toBe('unavailable');
	});

	it('exempts release and status methods from the ceiling so a revocation never blocks letting go', () => {
		const broker = new PermissionBroker({
			getGrants: () => [],
			managed: () => managedWith(null),
		});
		expect(broker.authorize('p', 'media.close', { jobId: 'j' }).allowed).toBe(true);
		expect(broker.authorize('p', 'services.cancel', { callId: 'c' }).allowed).toBe(true);
		expect(broker.authorize('p', 'services.status', { callId: 'c' }).managed).toBeUndefined();
	});

	it('holds a handler-reauthorized method to the ceiling capability without a target', () => {
		const held = new PermissionBroker({
			getGrants: () => [grant('net:connect', 'gateway.discord.gg')],
			managed: () =>
				managedWith(
					ceilingOf({
						plugins: [
							{
								pluginId: 'p',
								contentHash: 'sha256:abc',
								signerKey: 'pub-1',
								capabilities: [{ capability: 'net:connect', scopes: ['gateway.discord.gg'] }],
							},
						],
					})
				),
			getConsent: () => consentOf({ caps: [grant('net:connect', 'gateway.discord.gg')] }),
		});
		expect(held.authorize('p', 'net.send', { socketId: 's', data: 'hi' }).allowed).toBe(true);
		const notHeld = new PermissionBroker({
			getGrants: () => [grant('net:connect', 'gateway.discord.gg')],
			managed: () => managedWith(ceilingOf()),
			getConsent: () => consentOf({ caps: [grant('net:connect', 'gateway.discord.gg')] }),
		});
		expect(notHeld.authorize('p', 'net.send', { socketId: 's', data: 'hi' }).allowed).toBe(false);
	});

	it('an allowlist capability with no ceiling scopes admits nothing (never wildcard)', () => {
		const broker = new PermissionBroker({
			getGrants: localGrants,
			managed: () =>
				managedWith(
					ceilingOf({
						plugins: [
							{
								pluginId: 'p',
								contentHash: 'sha256:abc',
								signerKey: 'pub-1',
								capabilities: [{ capability: 'agents:dispatch' }],
							},
						],
					})
				),
			getConsent: () => consentOf(),
		});
		expect(
			broker.authorize('p', 'agents.dispatch', { agentId: 'agent-a', prompt: 'x' }).allowed
		).toBe(false);
	});
});

describe('managedPluginStanding (MRC-09-01)', () => {
	const ceiling = ceilingOf();
	it('is standalone with no enrollment, whatever else is present', () => {
		expect(managedPluginStanding({ enrolled: false, policy: null, ceiling })).toEqual({
			standing: 'standalone',
		});
	});
	it('names a missing applied revision, a missing ceiling and a stale ceiling', () => {
		expect(managedPluginStanding({ enrolled: true, policy: null, ceiling })).toMatchObject({
			standing: 'managed',
			ceiling: null,
			policyRevision: null,
			reason: /no applied policy revision/,
		});
		expect(
			managedPluginStanding({ enrolled: true, policy: { appliedRevision: 3 }, ceiling: null })
		).toMatchObject({
			ceiling: null,
			policyRevision: 3,
			reason: /no plugin ceiling is installed for policy revision 3/,
		});
		expect(
			managedPluginStanding({ enrolled: true, policy: { appliedRevision: 4 }, ceiling })
		).toMatchObject({
			ceiling: null,
			policyRevision: 4,
			reason: /revision 3; this host is under revision 4/,
		});
	});
	it('hands the ceiling over only for the revision the host is under', () => {
		expect(
			managedPluginStanding({ enrolled: true, policy: { appliedRevision: 3 }, ceiling })
		).toEqual({
			standing: 'managed',
			ceiling,
			policyRevision: 3,
		});
	});
});

describe('PermissionBroker.holds: live holds on kept resources (MRC-09-03)', () => {
	// The grants the service host re-checks: the caller's provider/service pair
	// and the fixed media profile, the provider's own service and the delegated
	// profile, plus an fs path a watcher keeps.
	const serviceGrants = () => [
		grant('services:call', 'stt/transcription'),
		grant('services:provide', 'transcription'),
		grant('media:tools', 'discord-voice,service-transcription'),
		grant('fs:read', '/data'),
	];
	const serviceCeiling = (): PluginPolicyCeiling =>
		ceilingOf({
			plugins: [
				{
					pluginId: 'p',
					contentHash: 'sha256:abc',
					signerKey: 'pub-1',
					capabilities: [
						{ capability: 'services:call', scopes: ['stt/transcription'] },
						{ capability: 'media:tools', scopes: ['discord-voice'] },
						{ capability: 'fs:read', scopes: ['/data/allowed'] },
					],
				},
			],
		});

	it('answers exactly what the pure matcher answers on a standalone host, with no receipt', () => {
		const broker = new PermissionBroker({
			getGrants: serviceGrants,
			managed: () => ({ standing: 'standalone' }),
			getConsent: () => consentOf(),
		});
		expect(broker.holds('p', 'services:call', 'stt/transcription')).toEqual({
			allowed: true,
			capability: 'services:call',
			target: 'stt/transcription',
		});
		expect(broker.holds('p', 'services:provide', 'transcription').allowed).toBe(true);
		expect(broker.holds('p', 'media:tools', 'service-transcription').allowed).toBe(true);
		expect(broker.holds('p', 'media:tools', 'discord-voice').allowed).toBe(true);
		// An allowlist capability never matches without a concrete target or outside the set.
		expect(broker.holds('p', 'services:call', 'other/transcription')).toMatchObject({
			allowed: false,
			reason: 'permission denied: services:call (other/transcription)',
		});
		expect(broker.holds('p', 'services:call').allowed).toBe(false);
		expect(broker.holds('p', 'agents:dispatch', 'agent-a').allowed).toBe(false);
	});

	it('keeps the protected-location exclusion on a held fs path', () => {
		const broker = new PermissionBroker({
			getGrants: () => [grant('fs:read')],
			protectedPaths: () => ['/data/userdata'],
		});
		expect(broker.holds('p', 'fs:read', '/data/userdata/plugins/kv.json')).toMatchObject({
			allowed: false,
			reason: /into a protected location/,
		});
		expect(broker.holds('p', 'fs:read', '/data/userdata-other/x').allowed).toBe(true);
	});

	it('holds a kept resource within the ceiling and stamps the receipt', () => {
		const broker = new PermissionBroker({
			getGrants: serviceGrants,
			managed: () => managedWith(serviceCeiling()),
			getConsent: () => consentOf(),
		});
		const d = broker.holds('p', 'services:call', 'stt/transcription');
		expect(d.allowed).toBe(true);
		expect(d.managed).toEqual({
			policyRevision: 3,
			outcome: 'within-ceiling',
			contentHash: 'sha256:abc',
			signerKey: 'pub-1',
			consentEpoch: 7,
		});
		expect(broker.holds('p', 'media:tools', 'discord-voice').allowed).toBe(true);
		expect(broker.holds('p', 'fs:read', '/data/allowed/file').allowed).toBe(true);
	});

	it('narrows a held resource the ceiling omits, by capability, scope member or path, and never widens', () => {
		const broker = new PermissionBroker({
			getGrants: serviceGrants,
			managed: () => managedWith(serviceCeiling()),
			getConsent: () => consentOf(),
		});
		// The provider's own service: consented locally, not admitted by the ceiling.
		expect(broker.holds('p', 'services:provide', 'transcription')).toMatchObject({
			allowed: false,
			reason:
				/services:provide is outside the managed plugin ceiling for "p" \(policy revision 3\)/,
			managed: { outcome: 'outside-ceiling', policyRevision: 3 },
		});
		// The delegated profile: consent names it, the ceiling names only discord-voice.
		expect(broker.holds('p', 'media:tools', 'service-transcription')).toMatchObject({
			allowed: false,
			managed: { outcome: 'outside-ceiling' },
		});
		// A path inside consent but outside the ceiling prefix.
		expect(broker.holds('p', 'fs:read', '/data/other')).toMatchObject({
			allowed: false,
			managed: { outcome: 'outside-ceiling' },
		});
		// A pair the ceiling admits but consent does not is denied before the ceiling is read.
		const wideCeiling = ceilingOf({
			plugins: [
				{
					pluginId: 'p',
					contentHash: 'sha256:abc',
					signerKey: 'pub-1',
					capabilities: [{ capability: 'services:call', scopes: ['other/transcription'] }],
				},
			],
		});
		const wide = new PermissionBroker({
			getGrants: serviceGrants,
			managed: () => managedWith(wideCeiling),
			getConsent: () => consentOf(),
		});
		const d = wide.holds('p', 'services:call', 'other/transcription');
		expect(d.allowed).toBe(false);
		expect(d.managed).toBeUndefined();
	});

	it('ends a held resource the instant the plugin or its publisher is revoked, or the ceiling goes', () => {
		let standing: ManagedPluginStanding = managedWith(serviceCeiling());
		const broker = new PermissionBroker({
			getGrants: serviceGrants,
			managed: () => standing,
			getConsent: () => consentOf(),
		});
		expect(broker.holds('p', 'services:call', 'stt/transcription').allowed).toBe(true);
		standing = managedWith({ ...serviceCeiling(), revokedPublishers: ['pub-1'] });
		expect(broker.holds('p', 'services:call', 'stt/transcription')).toMatchObject({
			allowed: false,
			managed: { outcome: 'revoked' },
		});
		standing = managedWith(null, 'the endpoint withdrew the ceiling');
		expect(broker.holds('p', 'services:call', 'stt/transcription')).toMatchObject({
			allowed: false,
			reason: /the managed plugin ceiling is unavailable \(the endpoint withdrew the ceiling\)/,
			managed: { outcome: 'unavailable', policyRevision: 3 },
		});
		standing = { standing: 'standalone' };
		// A standing that went standalone is the local answer again (the source never does this once enrolled).
		expect(broker.holds('p', 'services:call', 'stt/transcription').managed).toBeUndefined();
	});

	it('binds the hold to the consented identity, never to the folder', () => {
		const broker = new PermissionBroker({
			getGrants: serviceGrants,
			managed: () => managedWith(serviceCeiling()),
			getConsent: () =>
				consentOf({
					identity: { contentHash: 'sha256:other', signatureStatus: 'trusted', signerKey: 'pub-1' },
				}),
		});
		expect(broker.holds('p', 'services:call', 'stt/transcription')).toMatchObject({
			allowed: false,
			managed: { outcome: 'identity-mismatch', contentHash: 'sha256:other' },
		});
	});

	it('audits a hold under its capability unless the host-owned sweep opts out', () => {
		const onDecision = vi.fn();
		const broker = new PermissionBroker({ getGrants: serviceGrants, onDecision });
		broker.holds('p', 'services:call', 'stt/transcription');
		expect(onDecision).toHaveBeenCalledWith(
			'p',
			'services:call',
			expect.objectContaining({ allowed: true, target: 'stt/transcription' })
		);
		onDecision.mockClear();
		broker.holds('p', 'services:call', 'stt/transcription', { audit: false });
		expect(onDecision).not.toHaveBeenCalled();
	});
});
