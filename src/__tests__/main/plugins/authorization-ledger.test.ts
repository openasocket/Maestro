import { fakeAnchor } from '../../helpers/mockAnchor';
/**
 * @file authorization-ledger.test.ts
 * @description Security tests for the sealed authorization ledger - the plugin
 * authorization gate. Proves the contract: nothing on disk authorizes a plugin
 * without a mint, and a file-writer cannot forge, roll back, or revive
 * authorization. Uses fakes for the seal and the credential-store anchor so the
 * anchor persists (like a real keyring) while the ledger file is independently
 * rolled back - the exact rollback attack.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
	AuthorizationStore,
	ManagedPluginAuthorizationError,
	createKeyringAnchor,
	shouldDisablePluginForVerifyResult,
	type SealProvider,
	type AnchorStore,
	type Anchor,
	type AuthIdentity,
} from '../../../main/plugins/authorization-ledger';
import type { SignatureStatus } from '../../../shared/plugins/signing';
import type { PermissionGrant } from '../../../shared/plugins/permissions';
import { isPermitted, parseAllowlistScope } from '../../../shared/plugins/permissions';
import { PermissionBroker } from '../../../main/plugins/permission-broker';
import { createPluginPolicySource } from '../../../main/enterprise/plugin-policy';
import {
	effectiveTrustedKeys,
	parseManagedSettingsPolicy,
} from '../../../shared/managedSettingsLock';

let tmpDir: string;
let ledgerPath: string;

/** Reversible "seal" with a marker so foreign/garbage bytes fail to unseal. */
function fakeSeal(available = true): SealProvider {
	const MARK = 'SEALED\u0000';
	return {
		available: () => available,
		seal: (plaintext) => Buffer.from(MARK + plaintext, 'utf-8'),
		unseal: (blob) => {
			const s = blob.toString('utf-8');
			if (!s.startsWith(MARK)) throw new Error('not sealed by us');
			return s.slice(MARK.length);
		},
	};
}

/** In-memory anchor backed by an external holder - simulates the OS credential
 * vault, which is NOT rolled back when the ledger file is restored. */

it('createKeyringAnchor degrades unavailable native keyring to session-only', () => {
	const missing = createKeyringAnchor('com.maestro.test', 'freshness', () => null);
	expect(missing.available()).toBe(false);
	expect(missing.read()).toBeNull();
	expect(() => missing.write({ installSecret: 's', epoch: 1 })).not.toThrow();

	const throwing = createKeyringAnchor('com.maestro.test', 'freshness', () => {
		throw new Error('native module unavailable');
	});
	expect(throwing.available()).toBe(false);
	expect(() => throwing.clear()).not.toThrow();
});

it('createKeyringAnchor wraps a lazy keyring Entry module', () => {
	const passwords = new Map<string, string>();
	class FakeEntry {
		private readonly key: string;

		constructor(service: string, account: string) {
			this.key = `${service}:${account}`;
		}

		getPassword(): string | null {
			return passwords.get(this.key) ?? null;
		}

		setPassword(password: string): void {
			passwords.set(this.key, password);
		}

		deletePassword(): boolean {
			return passwords.delete(this.key);
		}
	}

	const anchor = createKeyringAnchor('com.maestro.test', 'freshness', () => ({
		Entry: FakeEntry,
	}));

	expect(anchor.available()).toBe(true);
	anchor.write({ installSecret: 'secret', epoch: 7 });
	expect(anchor.read()).toEqual({ installSecret: 'secret', epoch: 7 });
	anchor.clear();
	expect(anchor.read()).toBeNull();
});

const caps = (cap: PermissionGrant['capability'], scope?: string): PermissionGrant[] => [
	{ capability: cap, scope, grantedAt: 1 },
];

const ident = (
	contentHash: string,
	signatureStatus: SignatureStatus = 'unsigned',
	signerKey: string | null = null
): AuthIdentity => ({ contentHash, signatureStatus, signerKey });

function makeStore(seal: SealProvider, anchor: AnchorStore, seq = { n: 0 }): AuthorizationStore {
	return new AuthorizationStore({
		seal,
		anchor,
		ledgerPath,
		now: () => 1000,
		newSecret: () => `secret-${++seq.n}`,
	});
}

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-ledger-'));
	ledgerPath = path.join(tmpDir, 'auth-ledger.bin');
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('AuthorizationStore - mint / revoke', () => {
	it('mint enables and grants exactly the approved caps; unminted plugins get nothing', () => {
		const holder = { value: null as Anchor | null };
		const store = makeStore(fakeSeal(), fakeAnchor(holder));

		expect(store.readGrants('a')).toEqual([]); // default-deny
		expect(store.isEnabled('a')).toBe(false);

		store.mint('a', caps('fs:read', '/data'), ident('hash-a'));

		expect(store.isEnabled('a')).toBe(true);
		expect(store.readGrants('a')).toEqual([
			{ capability: 'fs:read', scope: '/data', grantedAt: 1 },
		]);
		expect(store.entryIdentity('a')?.contentHash).toBe('hash-a');
		expect(store.trustState()).toBe('persistent');
	});

	it('revoke disables, drops grants, and tombstones', () => {
		const holder = { value: null as Anchor | null };
		const store = makeStore(fakeSeal(), fakeAnchor(holder));
		store.mint('a', caps('net:fetch', 'example.com'), ident('hash-a'));
		store.revoke('a');
		expect(store.isEnabled('a')).toBe(false);
		expect(store.readGrants('a')).toEqual([]);
		expect(store.isTombstoned('a')).toBe(true);
	});
});

describe('AuthorizationStore - setAllowlistScope (host-managed allow list, #1250)', () => {
	const dispatchGrant = (scope: string, unattended = false): PermissionGrant[] => [
		{
			capability: 'agents:dispatch',
			scope,
			grantedAt: 1,
			...(unattended ? { unattended: true } : {}),
		},
	];

	it('widens the allow list of an already-consented dispatch grant', () => {
		const holder = { value: null as Anchor | null };
		const store = makeStore(fakeSeal(), fakeAnchor(holder));
		store.mint('relay', dispatchGrant('agent-1'), ident('hash'));

		expect(
			store.setAllowlistScope('relay', 'agents:dispatch', ['agent-1', 'agent-2', 'agent-3'])
		).toBe(true);
		const grants = store.readGrants('relay');
		expect(grants).toHaveLength(1);
		expect(parseAllowlistScope(grants[0].scope)).toEqual(['agent-1', 'agent-2', 'agent-3']);
		expect(isPermitted(grants, 'agents:dispatch', 'agent-3')).toBe(true);
	});

	it('an empty set clears the scope to deny-all (never a wildcard)', () => {
		const holder = { value: null as Anchor | null };
		const store = makeStore(fakeSeal(), fakeAnchor(holder));
		store.mint('relay', dispatchGrant('agent-1'), ident('hash'));

		expect(store.setAllowlistScope('relay', 'agents:dispatch', [])).toBe(true);
		const grants = store.readGrants('relay');
		expect(grants[0].scope).toBeUndefined();
		expect(isPermitted(grants, 'agents:dispatch', 'agent-1')).toBe(false);
	});

	it('preserves the unattended flag and any other grants', () => {
		const holder = { value: null as Anchor | null };
		const store = makeStore(fakeSeal(), fakeAnchor(holder));
		store.mint(
			'relay',
			[
				{ capability: 'agents:dispatch', scope: 'agent-1', grantedAt: 1, unattended: true },
				{ capability: 'net:connect', scope: 'gateway.discord.gg', grantedAt: 1 },
			],
			ident('hash')
		);

		store.setAllowlistScope('relay', 'agents:dispatch', ['agent-1', 'agent-2']);
		const grants = store.readGrants('relay');
		const dispatch = grants.find((g) => g.capability === 'agents:dispatch');
		const net = grants.find((g) => g.capability === 'net:connect');
		expect(dispatch?.unattended).toBe(true);
		expect(parseAllowlistScope(dispatch?.scope)).toEqual(['agent-1', 'agent-2']);
		expect(net?.scope).toBe('gateway.discord.gg');
	});

	it('returns false when the plugin holds no grant for the capability', () => {
		const holder = { value: null as Anchor | null };
		const store = makeStore(fakeSeal(), fakeAnchor(holder));
		store.mint('data', caps('fs:read', '/data'), ident('hash'));
		expect(store.setAllowlistScope('data', 'agents:dispatch', ['agent-1'])).toBe(false);
		expect(store.setAllowlistScope('missing', 'agents:dispatch', ['agent-1'])).toBe(false);
	});

	it('refuses a non-allowlist capability and leaves its scope untouched', () => {
		const holder = { value: null as Anchor | null };
		const store = makeStore(fakeSeal(), fakeAnchor(holder));
		store.mint('data', caps('fs:read', '/data'), ident('hash'));
		expect(store.setAllowlistScope('data', 'fs:read', ['/other'])).toBe(false);
		expect(store.readGrants('data')[0].scope).toBe('/data');
	});

	it('persists the widened scope across restarts (sealed + anchored)', () => {
		const holder = { value: null as Anchor | null };
		const store = makeStore(fakeSeal(), fakeAnchor(holder));
		store.mint('relay', dispatchGrant('agent-1'), ident('hash'));
		store.setAllowlistScope('relay', 'agents:dispatch', ['agent-1', 'agent-2']);

		const reopened = makeStore(fakeSeal(), fakeAnchor(holder));
		expect(parseAllowlistScope(reopened.readGrants('relay')[0].scope)).toEqual([
			'agent-1',
			'agent-2',
		]);
		expect(reopened.trustState()).toBe('persistent');
	});

	it('the widened scope survives verify() with an unchanged identity', () => {
		const holder = { value: null as Anchor | null };
		const store = makeStore(fakeSeal(), fakeAnchor(holder));
		store.mint('relay', dispatchGrant('agent-1'), ident('hash'));
		store.setAllowlistScope('relay', 'agents:dispatch', ['agent-1', 'agent-2']);

		const result = store.verify('relay', ident('hash'), ['agents:dispatch']);
		expect(result.authorized).toBe(true);
		expect(parseAllowlistScope(result.caps[0].scope)).toEqual(['agent-1', 'agent-2']);
	});

	it('refuses the whole edit if any member is invalid, leaving the scope unchanged', () => {
		const holder = { value: null as Anchor | null };
		const store = makeStore(fakeSeal(), fakeAnchor(holder));
		store.mint('relay', dispatchGrant('agent-1'), ident('hash'));

		// A comma would split the scope into two members; a '*' could smuggle
		// pattern semantics - both must be refused outright, never silently dropped.
		expect(
			store.setAllowlistScope('relay', 'agents:dispatch', ['agent-2', 'agent-1,agent-3'])
		).toBe(false);
		expect(store.setAllowlistScope('relay', 'agents:dispatch', ['agent-*'])).toBe(false);
		// The original scope is untouched.
		expect(parseAllowlistScope(store.readGrants('relay')[0].scope)).toEqual(['agent-1']);
	});
});

describe('AuthorizationStore - persistence', () => {
	it('persists across instances when sealed + anchored', () => {
		const holder = { value: null as Anchor | null };
		makeStore(fakeSeal(), fakeAnchor(holder)).mint('a', caps('storage:write'), ident('hash-a'));

		const reopened = makeStore(fakeSeal(), fakeAnchor(holder));
		expect(reopened.isEnabled('a')).toBe(true);
		expect(reopened.readGrants('a')).toHaveLength(1);
		expect(reopened.trustState()).toBe('persistent');
	});
});

describe('AuthorizationStore - anti-rollback (the contract)', () => {
	it('rejects a restored OLD sealed ledger (epoch regression) → re-consent, grant NOT honored', () => {
		const holder = { value: null as Anchor | null };
		makeStore(fakeSeal(), fakeAnchor(holder)).mint('a', caps('fs:write', '/d'), ident('hash-a'));

		// Snapshot the epoch-1 sealed file (the attacker's saved copy).
		const old = fs.readFileSync(ledgerPath);

		// User later narrows: revoke 'a' (epoch advances; anchor advances with it).
		makeStore(fakeSeal(), fakeAnchor(holder)).revoke('a');

		// Attacker rolls the FILE back to the broad-grant version. The anchor (in the
		// credential vault) is NOT rolled back.
		fs.writeFileSync(ledgerPath, old);

		const after = makeStore(fakeSeal(), fakeAnchor(holder));
		expect(after.isEnabled('a')).toBe(false); // rollback rejected
		expect(after.readGrants('a')).toEqual([]);
		expect(after.priorStateDropped()).toBe(true);
		expect(after.trustState()).toBe('re-consent');
	});

	it('uninstall + restore old folder/ledger cannot silently re-enable', () => {
		const holder = { value: null as Anchor | null };
		makeStore(fakeSeal(), fakeAnchor(holder)).mint('a', caps('ui:command'), ident('hash-a'));
		const old = fs.readFileSync(ledgerPath);

		makeStore(fakeSeal(), fakeAnchor(holder)).uninstall('a');
		fs.writeFileSync(ledgerPath, old); // restore pre-uninstall ledger

		const after = makeStore(fakeSeal(), fakeAnchor(holder));
		expect(after.isEnabled('a')).toBe(false);
	});

	it('rejects a tampered/foreign sealed file → re-consent', () => {
		const holder = { value: null as Anchor | null };
		makeStore(fakeSeal(), fakeAnchor(holder)).mint('a', caps('fs:read', '/d'), ident('hash-a'));
		fs.writeFileSync(ledgerPath, Buffer.from('garbage-not-sealed', 'utf-8'));

		const after = makeStore(fakeSeal(), fakeAnchor(holder));
		expect(after.isEnabled('a')).toBe(false);
		expect(after.priorStateDropped()).toBe(true);
	});

	it('missing anchor with an existing sealed ledger drops grants and requires re-consent', () => {
		const holder = { value: null as Anchor | null };
		makeStore(fakeSeal(), fakeAnchor(holder)).mint('a', caps('agents:dispatch'), ident('hash-a'));
		holder.value = null; // keyring entry missing/corrupt while the sealed ledger file still exists

		const after = makeStore(fakeSeal(), fakeAnchor(holder));
		expect(after.isEnabled('a')).toBe(false);
		expect(after.readGrants('a')).toEqual([]);
		expect(after.priorStateDropped()).toBe(true);
		expect(after.trustState()).toBe('re-consent');
		expect(after.isSessionOnly()).toBe(false);
	});

	it('re-consent after a drop persists again (storage mode stays persistent)', () => {
		const holder = { value: null as Anchor | null };
		makeStore(fakeSeal(), fakeAnchor(holder)).mint('a', caps('fs:read', '/d'), ident('hash-a'));
		const old = fs.readFileSync(ledgerPath);
		makeStore(fakeSeal(), fakeAnchor(holder)).revoke('a');
		fs.writeFileSync(ledgerPath, old); // rollback

		const dropped = makeStore(fakeSeal(), fakeAnchor(holder));
		expect(dropped.trustState()).toBe('re-consent');
		expect(dropped.isSessionOnly()).toBe(false); // still persistent storage
		dropped.mint('a', caps('fs:read', '/d'), ident('hash-a2')); // user re-approves

		const reopened = makeStore(fakeSeal(), fakeAnchor(holder));
		expect(reopened.isEnabled('a')).toBe(true);
		expect(reopened.trustState()).toBe('persistent');
	});
});

describe('AuthorizationStore - session-only fail-safe', () => {
	it('no seal → in-memory grants this session, nothing persisted', () => {
		const holder = { value: null as Anchor | null };
		const store = makeStore(fakeSeal(false), fakeAnchor(holder));
		expect(store.isSessionOnly()).toBe(true);

		store.mint('a', caps('fs:read', '/d'), ident('hash-a'));
		expect(store.readGrants('a')).toHaveLength(1); // usable this run
		expect(fs.existsSync(ledgerPath)).toBe(false); // never written

		const reopened = makeStore(fakeSeal(false), fakeAnchor(holder));
		expect(reopened.isEnabled('a')).toBe(false); // not persisted
	});

	it('no anchor (no credential store) → session-only', () => {
		const holder = { value: null as Anchor | null };
		const store = makeStore(fakeSeal(true), fakeAnchor(holder, false));
		expect(store.isSessionOnly()).toBe(true);
	});
});

describe('AuthorizationStore - persist failure (locked keyring) fails safe', () => {
	it('an anchor write that throws degrades to session-only, not a crash', () => {
		const holder = { value: null as Anchor | null };
		const throwingAnchor: AnchorStore = {
			available: () => true,
			read: () => holder.value,
			write: () => {
				throw new Error('keyring locked');
			},
			clear: () => {},
		};
		const store = makeStore(fakeSeal(), throwingAnchor);
		// First-run persist() hits the throwing write and must NOT throw.
		expect(() => store.mint('a', caps('fs:read', '/d'), ident('hash-a'))).not.toThrow();
		expect(store.isSessionOnly()).toBe(true); // degraded safely
		expect(store.readGrants('a')).toHaveLength(1); // usable this session
		expect(fs.existsSync(ledgerPath)).toBe(false);
	});

	it('a seal/file write failing after the anchor write stays session-only for all later mints', () => {
		const holder = { value: null as Anchor | null };
		let failSeal = true;
		const flakySeal: SealProvider = {
			available: () => true,
			seal: () => {
				if (failSeal) throw new Error('disk/seal failure after anchor write');
				return Buffer.from('unused');
			},
			unseal: () => {
				throw new Error('unused');
			},
		};
		const store = makeStore(flakySeal, fakeAnchor(holder));
		// First-run persist(): anchor.write succeeds, then seal()/file write throws → caught.
		expect(() => store.mint('a', caps('fs:read', '/d'), ident('hash-a'))).not.toThrow();
		expect(store.isSessionOnly()).toBe(true);
		expect(fs.existsSync(ledgerPath)).toBe(false);

		// Even though the seal would now succeed, later mints MUST stay session-only
		// and never write a skipped epoch (persist early-returns once degraded).
		failSeal = false;
		store.mint('b', caps('ui:command'), ident('hash-b'));
		expect(store.isSessionOnly()).toBe(true);
		expect(fs.existsSync(ledgerPath)).toBe(false);
		expect(store.readGrants('b')).toHaveLength(1); // usable in-memory
	});
});

describe('AuthorizationStore - verify (refresh-time gate)', () => {
	const newStore = () => makeStore(fakeSeal(), fakeAnchor({ value: null as Anchor | null }));

	it('authorizes when identity matches and caps are still requested', () => {
		const store = newStore();
		store.mint('a', caps('fs:read', '/d'), ident('h1', 'trusted', 'key1'));
		const r = store.verify('a', ident('h1', 'trusted', 'key1'), ['fs:read']);
		expect(r.authorized).toBe(true);
		expect(r.reason).toBe('ok');
		expect(r.caps).toHaveLength(1);
	});

	it('rejects on content-hash change', () => {
		const store = newStore();
		store.mint('a', caps('fs:read', '/d'), ident('h1'));
		expect(store.verify('a', ident('h2'), ['fs:read'])).toMatchObject({
			authorized: false,
			reason: 'identity-changed',
		});
	});

	it('rejects on signer/trust change even when files are unchanged', () => {
		const store = newStore();
		store.mint('a', caps('fs:read', '/d'), ident('h1', 'untrusted', 'keyX'));
		expect(store.verify('a', ident('h1', 'trusted', 'keyY'), ['fs:read'])).toMatchObject({
			authorized: false,
			reason: 'identity-changed',
		});
	});

	it('not-authorized when never minted', () => {
		expect(newStore().verify('a', ident('h1'), ['fs:read'])).toMatchObject({
			authorized: false,
			reason: 'not-authorized',
		});
	});

	it('refresh-time gate disables any non-authorized result, including not-authorized', () => {
		expect(
			shouldDisablePluginForVerifyResult({
				authorized: false,
				reason: 'not-authorized',
				caps: [],
			})
		).toBe(true);
	});

	it('removed when tombstoned (post-uninstall)', () => {
		const store = newStore();
		store.mint('a', caps('fs:read', '/d'), ident('h1'));
		store.uninstall('a');
		expect(store.verify('a', ident('h1'), ['fs:read'])).toMatchObject({
			authorized: false,
			reason: 'removed',
		});
	});

	it('rejects when a granted cap is no longer requested by the manifest', () => {
		const store = newStore();
		store.mint('a', caps('fs:write', '/d'), ident('h1'));
		expect(store.verify('a', ident('h1'), ['fs:read'])).toMatchObject({
			authorized: false,
			reason: 'identity-changed',
		});
	});
});

describe('readConsent (MRC-09-01)', () => {
	it('returns the grants, identity and mint epoch of an enabled entry, and null once revoked', () => {
		const holder = { value: null as Anchor | null };
		const store = new AuthorizationStore({
			seal: fakeSeal(),
			anchor: fakeAnchor(holder),
			ledgerPath,
			now: () => 42,
		});
		const identity: AuthIdentity = {
			contentHash: 'h1',
			signatureStatus: 'trusted',
			signerKey: 'k1',
		};
		expect(store.readConsent('p')).toBeNull();
		store.mint('p', [{ capability: 'fs:read', scope: '/data', grantedAt: 1 }], identity);
		const view = store.readConsent('p');
		expect(view).toEqual({
			caps: [{ capability: 'fs:read', scope: '/data', grantedAt: 1 }],
			identity,
			mintedAt: 42,
			epoch: 1,
			trust: 'persistent',
		});
		// A copy: mutating the view never reaches the ledger.
		view!.caps[0].scope = '/';
		expect(store.readGrants('p')[0].scope).toBe('/data');
		store.revoke('p');
		expect(store.readConsent('p')).toBeNull();
	});

	it('moves the epoch when the user edits an allowlist scope, and reads null for an entry without one', () => {
		const holder = { value: null as Anchor | null };
		const store = new AuthorizationStore({
			seal: fakeSeal(),
			anchor: fakeAnchor(holder),
			ledgerPath,
		});
		const identity: AuthIdentity = {
			contentHash: 'h1',
			signatureStatus: 'trusted',
			signerKey: 'k1',
		};
		store.mint('p', [{ capability: 'agents:dispatch', scope: 'a', grantedAt: 1 }], identity);
		expect(store.readConsent('p')?.epoch).toBe(1);
		expect(store.setAllowlistScope('p', 'agents:dispatch', ['a', 'b'])).toBe(true);
		expect(store.readConsent('p')?.epoch).toBe(2);

		// An entry persisted before epoch recording: re-read through a fresh store.
		const reread = new AuthorizationStore({
			seal: fakeSeal(),
			anchor: fakeAnchor(holder),
			ledgerPath,
		});
		expect(reread.readConsent('p')?.epoch).toBe(2);
	});
});

describe('the sealed ledger under a managed ceiling (MRC-09-06)', () => {
	const identity = ident('h1', 'trusted', 'k1');
	const grants: PermissionGrant[] = [
		{ capability: 'fs:read', scope: '/data', grantedAt: 1 },
		{ capability: 'fs:write', scope: '/data', grantedAt: 1 },
		{ capability: 'agents:dispatch', scope: 'a', grantedAt: 1 },
	];
	/** A ceiling naming "p" as minted, narrower than consent on fs:write and agents, wider on shell:openExternal. */
	const document = (entry: Record<string, unknown> = {}) => ({
		policyRevision: 3,
		plugins: [
			{
				pluginId: 'p',
				contentHash: 'h1',
				signerKey: 'k1',
				capabilities: [
					{ capability: 'fs:read', scopes: ['/data'] },
					{ capability: 'fs:write', scopes: ['/data/out'] },
					{ capability: 'agents:dispatch', scopes: ['a'] },
					{ capability: 'shell:openExternal' },
				],
				...entry,
			},
		],
	});

	/** The desktop's composition: the ledger is the grant and consent source, the policy source the standing. */
	function managedHost() {
		const holder = { value: null as Anchor | null };
		const store = makeStore(fakeSeal(), fakeAnchor(holder));
		store.mint('p', grants, identity);
		const state = { enrolled: true, applied: 3 as number | null };
		const policy = createPluginPolicySource({
			enrolled: () => state.enrolled,
			policy: () => (state.applied === null ? null : { appliedRevision: state.applied }),
		});
		const broker = new PermissionBroker({
			getGrants: (pluginId) => store.readGrants(pluginId),
			managed: () => policy.standing(),
			getConsent: (pluginId) => store.readConsent(pluginId),
		});
		const read = () => broker.authorize('p', 'fs.read', { path: '/data/a.txt' });
		return { holder, store, policy, state, broker, read };
	}

	it('a central revoke denies and rewrites nothing: the sealed bytes, the anchor, the epoch and a fresh re-read are unchanged', () => {
		const { holder, store, policy, read } = managedHost();
		policy.install(document());
		expect(read()).toMatchObject({
			allowed: true,
			managed: { outcome: 'within-ceiling', contentHash: 'h1', signerKey: 'k1', consentEpoch: 1 },
		});
		const bytes = fs.readFileSync(ledgerPath);
		const anchor = { ...holder.value };
		policy.install(document({ revoked: true }));
		expect(read()).toMatchObject({
			allowed: false,
			reason: /"p" is revoked by the managed plugin ceiling of policy revision 3/,
			managed: { outcome: 'revoked', consentEpoch: 1 },
		});
		expect(fs.readFileSync(ledgerPath).equals(bytes)).toBe(true);
		expect(holder.value).toEqual(anchor);
		expect(store.isEnabled('p')).toBe(true);
		expect(store.isTombstoned('p')).toBe(false);
		expect(store.authorizedIds()).toEqual(['p']);
		expect(store.readConsent('p')).toMatchObject({ epoch: 1, identity, caps: grants });
		// A fresh store over the same file and anchor reads the same consent: nothing the ceiling did reached disk.
		expect(makeStore(fakeSeal(), fakeAnchor(holder)).readConsent('p')?.epoch).toBe(1);
		// The revoke withdrawn: the consent that was never touched runs again.
		policy.install(document());
		expect(read().allowed).toBe(true);
	});

	it('the ceiling narrows consent and never mints it; a local revoke is authoritative under it and tombstones', () => {
		const { store, policy, broker, read } = managedHost();
		policy.install(document());
		// Consented /data, ceiling /data/out: the wider write is outside the ceiling, the narrower one within.
		expect(broker.authorize('p', 'fs.write', { path: '/data/other.txt' })).toMatchObject({
			allowed: false,
			reason: /fs:write \(\/data\/other.txt\) is outside the managed plugin ceiling/,
			managed: { outcome: 'outside-ceiling' },
		});
		expect(broker.authorize('p', 'fs.write', { path: '/data/out/x.txt' }).allowed).toBe(true);
		// The ceiling admits shell:openExternal; the ledger holds no such grant: denied with no receipt.
		const minted = broker.authorize('p', 'shell.openExternal', { url: 'https://x.test' });
		expect(minted).toEqual({
			allowed: false,
			capability: 'shell:openExternal',
			target: 'x.test',
			reason: 'permission denied: shell:openExternal (x.test)',
		});
		expect(store.readGrants('p').some((g) => g.capability === 'shell:openExternal')).toBe(false);
		// The user revokes locally: the ledger tombstones, and a ceiling naming the plugin changes nothing.
		store.revoke('p');
		expect(store.isTombstoned('p')).toBe(true);
		expect(read()).toEqual({
			allowed: false,
			capability: 'fs:read',
			target: '/data/a.txt',
			reason: 'permission denied: fs:read (/data/a.txt)',
		});
		policy.install(document({ capabilities: [{ capability: 'fs:read' }] }));
		expect(read().allowed).toBe(false);
		expect(read().managed).toBeUndefined();
	});

	it('a plugin change re-minted under a new identity mismatches the ceiling until it names the digest, and a scope edit moves the epoch the receipt carries', () => {
		const { store, policy, broker } = managedHost();
		policy.install(document());
		const dispatch = (agentId: string) =>
			broker.authorize('p', 'agents.dispatch', { agentId, prompt: 'summarize' });
		expect(dispatch('a')).toMatchObject({ allowed: true, managed: { consentEpoch: 1 } });
		// The plugin updates and the user re-consents to the new content under the same publisher.
		store.mint('p', grants, ident('h2', 'trusted', 'k1'));
		expect(dispatch('a')).toMatchObject({
			allowed: false,
			reason: /names a different content digest, publisher or signature status for "p"/,
			managed: {
				outcome: 'identity-mismatch',
				contentHash: 'h2',
				signerKey: 'k1',
				consentEpoch: 2,
			},
		});
		policy.install(document({ contentHash: 'h2' }));
		expect(dispatch('a')).toMatchObject({ allowed: true, managed: { consentEpoch: 2 } });
		// The user widens the allowlist in the ledger: the epoch moves with it, and the ceiling still admits only "a".
		expect(store.setAllowlistScope('p', 'agents:dispatch', ['a', 'b'])).toBe(true);
		expect(dispatch('a')).toMatchObject({ allowed: true, managed: { consentEpoch: 3 } });
		expect(dispatch('b')).toMatchObject({
			allowed: false,
			managed: { outcome: 'outside-ceiling', consentEpoch: 3 },
		});
		expect(isPermitted(store.readGrants('p'), 'agents:dispatch', 'b')).toBe(true);
	});
});

/**
 * Authorization acts under the managed standing (MCOMP-21-14, over MCOMP-21-07):
 * a consent mint, an allowlist widening and a load-time verify are held to the
 * same plugin ceiling the broker reads, before the sealed ledger moves. A
 * refused act leaves the sealed bytes, the anchor, the epoch and every other
 * plugin's consent exactly as they were; a ceiling only narrows, so a revoke
 * and a narrowing are never held, and a standalone host is unchanged.
 */
describe('authorization acts under the managed standing (MCOMP-21-14)', () => {
	const identity = ident('h1', 'trusted', 'k1');
	const ceiling = (entry: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
		policyRevision: 4,
		plugins: [
			{
				pluginId: 'p',
				contentHash: 'h1',
				signerKey: 'k1',
				capabilities: [
					{ capability: 'fs:read', scopes: ['/data'] },
					{ capability: 'agents:dispatch', scopes: ['a', 'b'] },
				],
				...entry,
			},
		],
		...extra,
	});

	/** A store composed the way index.ts composes it: the policy source's standing read per act. */
	function managed(state = { enrolled: true }) {
		const holder = { value: null as Anchor | null };
		const store = makeStore(fakeSeal(), fakeAnchor(holder));
		const policy = createPluginPolicySource({
			enrolled: () => state.enrolled,
			policy: () => ({ appliedRevision: 4 }),
		});
		store.setManagedStanding(() => policy.standing());
		// Another plugin consented before enrollment: the witness that a refusal touches nothing.
		const before = { ...state };
		state.enrolled = false;
		store.mint('other', caps('fs:read', '/x'), ident('o1'));
		state.enrolled = before.enrolled;
		const snapshot = () => ({
			bytes: fs.readFileSync(ledgerPath),
			anchor: holder.value ? { ...holder.value } : null,
			other: store.readConsent('other'),
		});
		const unchangedSince = (taken: ReturnType<typeof snapshot>) => {
			expect(fs.readFileSync(ledgerPath).equals(taken.bytes)).toBe(true);
			expect(holder.value).toEqual(taken.anchor);
			expect(store.readConsent('other')).toEqual(taken.other);
			// A fresh store over the same file and anchor reads the same ledger.
			expect(makeStore(fakeSeal(), fakeAnchor(holder)).readConsent('other')).toEqual(taken.other);
		};
		return { holder, store, policy, state, snapshot, unchangedSince };
	}

	it('refuses a mint with no delivered ceiling, by name, before the ledger moves', () => {
		const { store, snapshot, unchangedSince } = managed();
		const taken = snapshot();
		let thrown: unknown;
		try {
			store.mint('p', caps('fs:read', '/data'), identity);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(ManagedPluginAuthorizationError);
		expect(thrown).toMatchObject({ pluginId: 'p', outcome: 'unavailable' });
		expect((thrown as Error).message).toMatch(/managed plugin ceiling is unavailable/);
		expect(store.isEnabled('p')).toBe(false);
		expect(store.readGrants('p')).toEqual([]);
		unchangedSince(taken);
	});

	it('mints within the ceiling and persists it; refuses a capability, a plugin or bytes it does not name', () => {
		const { holder, store, policy, snapshot, unchangedSince } = managed();
		policy.install(ceiling());
		const taken = snapshot();
		expect(() => store.mint('p', caps('shell:openExternal'), identity)).toThrow(
			/shell:openExternal is outside the managed plugin ceiling for "p" \(policy revision 4\)/
		);
		expect(() => store.mint('q', caps('fs:read', '/data'), ident('h1', 'trusted', 'k1'))).toThrow(
			/"q" is not within the managed plugin ceiling of policy revision 4/
		);
		// A user-trusted signature over other bytes is not the identity the ceiling names.
		expect(() => store.mint('p', caps('fs:read', '/data'), ident('h2', 'trusted', 'k1'))).toThrow(
			ManagedPluginAuthorizationError
		);
		unchangedSince(taken);

		store.mint('p', caps('fs:read', '/data'), identity);
		expect(store.readGrants('p')).toEqual(caps('fs:read', '/data'));
		expect(makeStore(fakeSeal(), fakeAnchor(holder)).readConsent('p')?.caps).toEqual(
			caps('fs:read', '/data')
		);
	});

	it('refuses a plugin whose publisher the ceiling revokes, even under a trusted signature', () => {
		const { store, policy, snapshot, unchangedSince } = managed();
		policy.install(ceiling({}, { revokedPublishers: ['k1'] }));
		const taken = snapshot();
		expect(() => store.mint('p', caps('fs:read', '/data'), identity)).toThrow(
			/"p" is revoked by the managed plugin ceiling of policy revision 4/
		);
		unchangedSince(taken);
	});

	it('holds an allowlist widening to the ceiling members, and never a narrowing', () => {
		const { store, policy, state, snapshot, unchangedSince } = managed();
		policy.install(ceiling());
		store.mint('p', caps('agents:dispatch', 'a'), identity);
		const taken = snapshot();
		expect(store.setAllowlistScope('p', 'agents:dispatch', ['a', 'c'])).toBe(false);
		expect(parseAllowlistScope(store.readGrants('p')[0].scope)).toEqual(['a']);
		unchangedSince(taken);

		expect(store.setAllowlistScope('p', 'agents:dispatch', ['a', 'b'])).toBe(true);
		expect(parseAllowlistScope(store.readGrants('p')[0].scope)).toEqual(['a', 'b']);

		// The ceiling withdrawn: a widening is refused, a narrowing still goes through.
		policy.clear();
		expect(store.setAllowlistScope('p', 'agents:dispatch', ['a', 'b', 'c'])).toBe(false);
		expect(store.setAllowlistScope('p', 'agents:dispatch', ['b'])).toBe(true);
		expect(parseAllowlistScope(store.readGrants('p')[0].scope)).toEqual(['b']);
		expect(state.enrolled).toBe(true);
	});

	it('loads a consented plugin only within the ceiling, keeps the consent when it is outside, and revokes under any standing', () => {
		const { store, policy } = managed();
		policy.install(ceiling());
		store.mint('p', caps('fs:read', '/data'), identity);
		expect(store.verify('p', identity, ['fs:read'])).toMatchObject({ authorized: true });

		policy.install(ceiling({ revoked: true }));
		expect(store.verify('p', identity, ['fs:read'])).toEqual({
			authorized: false,
			reason: 'managed',
			caps: [],
		});
		expect(store.isEnabled('p')).toBe(true);
		expect(store.readConsent('p')?.caps).toEqual(caps('fs:read', '/data'));

		policy.clear();
		store.revoke('p');
		expect(store.isEnabled('p')).toBe(false);
		expect(store.isTombstoned('p')).toBe(true);
	});

	it('is unchanged standalone: no standing composed, or a standing that reads standalone', () => {
		const plain = makeStore(fakeSeal(), fakeAnchor({ value: null }));
		plain.mint('p', caps('shell:openExternal'), identity);
		expect(plain.isEnabled('p')).toBe(true);

		const { store, state } = managed({ enrolled: false });
		store.mint('p', caps('shell:openExternal'), identity);
		expect(store.setAllowlistScope('p', 'shell:openExternal', ['x'])).toBe(false); // not allowlist-scoped
		expect(store.verify('p', identity, ['shell:openExternal'])).toMatchObject({ authorized: true });
		// Enrolled afterwards, with no ceiling delivered: the same consent no longer loads.
		state.enrolled = true;
		expect(store.verify('p', identity, ['shell:openExternal'])).toMatchObject({
			authorized: false,
			reason: 'managed',
		});
	});

	it("replaces the user's trusted publisher keys with a pinned list, and keeps them when nothing is pinned", () => {
		const pinned = parseManagedSettingsPolicy({
			policyRevision: 4,
			locks: [{ key: 'pluginTrustedKeys', pin: { value: ['UElOTkVE'] } }],
		});
		expect(pinned.ok).toBe(true);
		if (!pinned.ok) return;
		const userKeys = ['VVNFUg=='];
		expect(effectiveTrustedKeys(userKeys, pinned.policy)).toEqual(['UElOTkVE']);
		const lockedOnly = parseManagedSettingsPolicy({
			policyRevision: 4,
			locks: [{ key: 'plugins.installed' }],
		});
		expect(lockedOnly.ok).toBe(true);
		if (!lockedOnly.ok) return;
		expect(effectiveTrustedKeys(userKeys, lockedOnly.policy)).toEqual(userKeys);
		expect(effectiveTrustedKeys(userKeys, null)).toEqual(userKeys);
		// The answer is a copy: a caller mutating it cannot widen the pin.
		const answer = effectiveTrustedKeys(userKeys, pinned.policy);
		answer.push('VVNFUg==');
		expect(effectiveTrustedKeys(userKeys, pinned.policy)).toEqual(['UElOTkVE']);
	});
});

describe('legacy original export grant migration', () => {
	it('strips unmarked export members on load without changing voice consent or writing during a read', () => {
		const holder = { value: null as Anchor | null };
		const seal = fakeSeal(),
			anchor = fakeAnchor(holder);
		const store = makeStore(seal, anchor);
		store.mint(
			'relay',
			[{ capability: 'media:tools', scope: 'discord-voice,discord-original-audio', grantedAt: 1 }],
			ident('old-hash')
		);
		const originalBytes = fs.readFileSync(ledgerPath);
		const reopened = makeStore(seal, anchor);
		expect(reopened.readGrants('relay')).toEqual([
			{ capability: 'media:tools', scope: 'discord-voice', grantedAt: 1 },
		]);
		expect(fs.readFileSync(ledgerPath)).toEqual(originalBytes);
		reopened.mint('other', caps('fs:read', '/data'), ident('other-hash'));
		expect(JSON.parse(seal.unseal(fs.readFileSync(ledgerPath))).entries.relay.caps[0].scope).toBe(
			'discord-voice'
		);
	});
	it('retains a separately consented marked scope through persistence', () => {
		const holder = { value: null as Anchor | null };
		const seal = fakeSeal(),
			anchor = fakeAnchor(holder);
		const store = makeStore(seal, anchor);
		store.mint(
			'relay',
			[
				{
					capability: 'media:tools',
					scope: 'discord-voice,discord-original-audio',
					grantedAt: 1,
					originalAudioExport: true,
				},
			],
			ident('new-hash')
		);
		const reopened = makeStore(seal, anchor);
		expect(isPermitted(reopened.readGrants('relay'), 'media:tools', 'discord-original-audio')).toBe(
			true
		);
	});
});
