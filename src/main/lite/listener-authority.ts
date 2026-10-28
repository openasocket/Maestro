/**
 * The Lite process's listener authority (MRC2-05-06C).
 *
 * `startLite()` runs from `bootstrap.ts` and never reaches the composition block
 * of `src/main/index.ts`, so the Lite sinks (`lite-control`, `ssh-tunnel`, the
 * `mdns` browser) were consulted against no authority. This composes the same
 * `createListenerPolicySource()` the desktop installs and puts it on the leaf
 * gate BEFORE the window, the control endpoint, a discovery socket or any
 * forward exists.
 *
 * Where Lite's enrollment comes from, decided here: Lite carries NO enrollment
 * of its own (its data directory holds profiles and device credentials, and
 * nothing in Lite enrolls). It is under the HOST INSTALLATION's: the record the
 * full desktop sealed at `<host userData>/enterprise-identity.bin`, read
 * through the same sealed, anchored store (same service and account as
 * `createEnterpriseService()`; Lite never writes it). The host directory is the
 * one the desktop runs with (`liteHostDataDirectory()`: `MAESTRO_USER_DATA` when
 * set, else Electron's default userData), taken BEFORE Lite re-points userData.
 *
 * What one read decides (`enrollment()`), by name:
 *   - no record (`none`), or a custody that cannot read one and no file from an
 *     earlier protected run: STANDALONE by name, never managed by assumption.
 *   - a record that opens (`ok`): MANAGED under its last applied revision, the
 *     policy a host keeps offline. No endpoint operation hands Lite a ceiling
 *     (CP-01) and Lite has no socket to receive one on, so every listener is
 *     refused `unavailable`: the control endpoint writes `disabled-by-policy`
 *     and `openTunnel()` refuses every forward before a probe or a spawn.
 *   - a record that is there but does not open or match its anchor
 *     (`untrusted`, or `unprotected` with a file): MANAGED with the custody's
 *     reason; an enrollment Lite cannot verify is not "no enrollment". The seal
 *     key is the one the OS holds for the RUNNING app name and Lite renames
 *     itself before it is ready, so on a platform that keys the seal by app
 *     name (the macOS Keychain item) the host's record reads `untrusted:
 *     unsealable` here: reported by name, refusing what a missing ceiling would.
 *
 * The same enrollment composes Lite's settings lock source (MRC2-06-04A), set as
 * the one write authority of the Lite process: `liteControlHold()` holds the
 * controls that discover, pair, connect or change a host profile on
 * `lite.control`, so an enrolled host's Lite refuses them `unavailable` by name
 * (no settings policy reaches Lite, CP-01) and a standalone Lite is never asked.
 *
 * Standalone Lite is unchanged; nothing here opens a store, a socket or a runtime.
 */

import * as path from 'node:path';

import { resolveUserDataDir } from '../../shared/userDataDir';
import {
	createEnterpriseIdentityStore,
	ENTERPRISE_IDENTITY_ANCHOR_SERVICE,
	ENTERPRISE_IDENTITY_FILE_NAME,
	type IdentityRead,
} from '../enterprise/identity-store';
import { setListenerAuthority } from '../enterprise/listener-gate';
import {
	createSettingsPolicySource,
	holdManagedKey,
	setSettingsWriteAuthority,
	type SettingsPolicySource,
	type SettingWriteDecision,
} from '../enterprise/settings-policy';
import { LITE_CONTROL_LOCK_KEY } from '../../shared/managedSettingsLock';
import {
	createListenerPolicySource,
	type ListenerPolicySource,
} from '../enterprise/listener-policy';
import {
	anchorAccountForDirectory,
	createKeyringAnchor,
	type AnchorStore,
} from '../utils/keyring-anchor';
import {
	safeStorageSeal,
	type SafeStorageLike,
	type SealProvider,
} from '../utils/safe-storage-seal';

/** The host installation's data directory, the one the full desktop runs with. Read it BEFORE Lite re-points userData. */
export function liteHostDataDirectory(
	electronUserData: string,
	env: NodeJS.ProcessEnv = process.env
): string {
	return env.MAESTRO_USER_DATA ? resolveUserDataDir({ env }) : path.resolve(electronUserData);
}

export interface LiteListenerAuthorityDeps {
	/** The host installation's data directory (`liteHostDataDirectory()`), never Lite's own. */
	hostDataDir: string;
	/** Electron's `safeStorage`, or an injected `seal` and `anchor` (tests). */
	safeStorage?: SafeStorageLike;
	seal?: SealProvider;
	anchor?: AnchorStore;
	platform?: NodeJS.Platform;
}

export type LiteEnrollment =
	| { standing: 'standalone'; file: string; reason: string }
	| {
			standing: 'managed';
			file: string;
			reason: string;
			/** The identity store's read the standing came from. */
			identity: Exclude<IdentityRead['status'], 'none'>;
			/** The record's last applied revision; null when the record did not open. */
			appliedRevision: number | null;
	  };

export interface LiteListenerAuthority {
	/** The real source over the host's enrollment; what `installLiteListenerAuthority()` puts on the gate. */
	source: ListenerPolicySource;
	/** The settings lock source over the same enrollment (MRC2-06-04A); what `liteControlHold()` reads. */
	settings: SettingsPolicySource;
	/** The record it reads, under the host directory. */
	file: string;
	/** One fresh read, decided by the rule in the header. */
	enrollment(): LiteEnrollment;
}

function describeRead(read: IdentityRead, file: string): LiteEnrollment {
	switch (read.status) {
		case 'none':
			return {
				standing: 'standalone',
				file,
				reason: `no enrollment record at ${file}; this Lite client is standalone`,
			};
		case 'unprotected':
			if (!read.fileExists)
				return {
					standing: 'standalone',
					file,
					reason: `no enrollment record at ${file} and none could be read here (${read.message}); this Lite client is standalone`,
				};
			return {
				standing: 'managed',
				file,
				identity: read.status,
				appliedRevision: null,
				reason: `${file} was written by an enrolled host and cannot be read under this custody: ${read.message}`,
			};
		case 'untrusted':
			return {
				standing: 'managed',
				file,
				identity: read.status,
				appliedRevision: null,
				reason: `the enrollment record at ${file} is ${read.reason}: ${read.message}`,
			};
		case 'ok':
			return {
				standing: 'managed',
				file,
				identity: read.status,
				appliedRevision: read.record.policy.appliedRevision,
				reason: `this Lite client runs under the host installation ${read.record.installationId} enrolled with ${read.record.orgId} (${read.record.tenantId}), management ${read.record.management}`,
			};
	}
}

/** Compose the authority without installing it; `installLiteListenerAuthority()` is what `startLite()` calls. */
export function composeLiteListenerAuthority(
	deps: LiteListenerAuthorityDeps
): LiteListenerAuthority {
	const seal = deps.seal ?? (deps.safeStorage ? safeStorageSeal(deps.safeStorage) : null);
	if (!seal) throw new Error('A Lite listener authority needs safeStorage or an injected seal.');
	const file = path.join(deps.hostDataDir, ENTERPRISE_IDENTITY_FILE_NAME);
	const store = createEnterpriseIdentityStore({
		file,
		seal,
		anchor:
			deps.anchor ??
			createKeyringAnchor(
				ENTERPRISE_IDENTITY_ANCHOR_SERVICE,
				anchorAccountForDirectory('enterprise-identity', deps.hostDataDir)
			),
		...(deps.platform ? { platform: deps.platform } : {}),
	});
	const enrollment = (): LiteEnrollment => describeRead(store.read(), file);
	const sourceDeps = {
		// The sources read `identityStandingOf()`, the same rule as the header's;
		// a standalone decision (no record, or none readable and no file) is
		// still handed to them as `none` so the one rule in the header decides.
		identity: {
			read: (): IdentityRead => {
				const read = store.read();
				return describeRead(read, file).standing === 'standalone' ? { status: 'none' } : read;
			},
		},
		// The policy a host keeps offline: the record's last applied revision.
		policy: () => {
			const read = store.read();
			return read.status === 'ok' ? { appliedRevision: read.record.policy.appliedRevision } : null;
		},
	};
	return {
		source: createListenerPolicySource(sourceDeps),
		settings: createSettingsPolicySource(sourceDeps),
		file,
		enrollment,
	};
}

/** The Lite controls a lock on `lite.control` refuses: those that discover, pair, connect or change a host profile. Reading, dismissing, disconnecting and closing are never held. */
export const LITE_CONTROL_HELD_ACTIONS: readonly string[] = Object.freeze([
	'discovery-start',
	'discovery-import',
	'network-changed',
	'pair-request',
	'pair-submit',
	'connect',
	'reconnect',
	'save',
	'trust',
]);

/** Hold one Lite control action through the lock the host's enrollment composes; standalone, and an action never held: allowed. */
export function liteControlHold(name: string): SettingWriteDecision {
	return LITE_CONTROL_HELD_ACTIONS.includes(name)
		? holdManagedKey(LITE_CONTROL_LOCK_KEY)
		: { allowed: true };
}

/** Compose over the host's enrollment and install on the gate; call before the first sink. */
export function installLiteListenerAuthority(
	deps: LiteListenerAuthorityDeps
): LiteListenerAuthority {
	const authority = composeLiteListenerAuthority(deps);
	setListenerAuthority(authority.source);
	setSettingsWriteAuthority(authority.settings);
	return authority;
}
