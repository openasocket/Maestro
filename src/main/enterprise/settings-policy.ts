/**
 * Main-process enforcement of the settings lock model (MRC2-06-02). The model
 * is `src/shared/managedSettingsLock.ts`; this is where a desktop holds its
 * settings writes to it. The `settings:set` IPC handler (which the bridge's
 * `set_setting` also reaches, through the renderer), the bridge handler and
 * main-process code writing the store directly all read ONE authority through
 * `holdSettingWrite()`; `guardSettingsStore()` wraps the store so a direct
 * write to a held key throws `ManagedSettingLockedError` by name, and
 * `restoreManagedSettingPins()` is the one writer that bypasses the guard, at
 * startup and on each policy change. No endpoint operation of this build
 * carries a settings policy (CP-01), so nothing calls `install()` yet: an
 * enrolled desktop refuses every lockable key `unavailable`; standalone, none.
 */

import type { ManagedPolicyStatus } from '../../shared/maestro-lib/managed/host-adapter';
import {
	LOCKABLE_SETTING_KEYS,
	applyManagedPins,
	isSettingLockable,
	managedSettingLockReason,
	parseManagedSettingsPolicy,
	type ManagedSettingsPolicy,
} from '../../shared/managedSettingsLock';
import { identityStandingOf, type EnterpriseIdentityStore } from './identity-store';

export type ManagedSettingsStanding =
	| { standing: 'standalone' }
	| { standing: 'managed'; policy: ManagedSettingsPolicy; policyRevision: number }
	| { standing: 'managed'; policy: null; policyRevision: number | null; reason: string };

/** The standing a write is held against: the rule of `managedShellStanding`, for the settings policy. */
export function managedSettingsStanding(input: {
	enrolled: boolean;
	policy: Pick<ManagedPolicyStatus, 'appliedRevision'> | null;
	installed: ManagedSettingsPolicy | null;
}): ManagedSettingsStanding {
	if (!input.enrolled) return { standing: 'standalone' };
	const revision = input.policy?.appliedRevision ?? null;
	const reason =
		revision === null
			? 'no applied policy revision is known for this host'
			: !input.installed
				? `no settings policy is installed for policy revision ${revision}`
				: input.installed.policyRevision !== revision
					? `the installed settings policy is for policy revision ${input.installed.policyRevision}; this host is under revision ${revision}`
					: null;
	if (reason !== null || !input.installed || revision === null)
		return { standing: 'managed', policy: null, policyRevision: revision, reason: reason ?? '' };
	return { standing: 'managed', policy: input.installed, policyRevision: revision };
}

export type SettingWriteDenial = 'unavailable' | 'locked';
export type SettingWriteDecision =
	| { allowed: true }
	| { allowed: false; code: SettingWriteDenial; message: string; policyRevision: number | null };

/**
 * Hold one write against the standing. Pure. Standalone admits everything; a
 * key the metadata never marked lockable is admitted under any standing; a
 * managed host with no usable policy refuses every lockable key by name.
 */
export function settingWriteVerdict(
	standing: ManagedSettingsStanding,
	key: string
): SettingWriteDecision {
	if (standing.standing === 'standalone' || !isSettingLockable(key)) return { allowed: true };
	const deny = (code: SettingWriteDenial, message: string): SettingWriteDecision => ({
		allowed: false,
		code,
		message,
		policyRevision: standing.policyRevision,
	});
	if (!standing.policy)
		return deny(
			'unavailable',
			`the "${key}" setting is held by managed policy and the managed settings policy is unavailable (${standing.reason})`
		);
	const reason = managedSettingLockReason(key, standing.policy);
	return reason === null ? { allowed: true } : deny('locked', reason);
}

export interface SettingsPolicySourceDeps {
	identity: Pick<EnterpriseIdentityStore, 'read'>;
	policy(): Pick<ManagedPolicyStatus, 'appliedRevision'> | null;
}

/** What a write path holds a key with: the source, or a test double. */
export interface SettingsWriteAuthority {
	authorize(key: string): SettingWriteDecision;
	/** The policy whose pins a store restores, or null when none is usable. */
	pins(): ManagedSettingsPolicy | null;
}

export interface SettingsPolicySource extends SettingsWriteAuthority {
	standing(): ManagedSettingsStanding;
	installed(): ManagedSettingsPolicy | null;
	/** Install a policy an authenticated endpoint path handed over; a refused document keeps the previous one. */
	install(
		raw: unknown
	):
		| { installed: true; policyRevision: number }
		| { installed: false; problems: readonly string[] };
	clear(): void;
	/** Hear every install and clear: the moment pins are restored. Returns the unsubscribe. */
	onChange(listener: () => void): () => void;
}

export function createSettingsPolicySource(deps: SettingsPolicySourceDeps): SettingsPolicySource {
	let installed: ManagedSettingsPolicy | null = null;
	const listeners = new Set<() => void>();
	const standing = () =>
		managedSettingsStanding({
			enrolled: identityStandingOf(deps.identity.read()) === 'managed',
			policy: deps.policy(),
			installed,
		});
	const changed = () => [...listeners].forEach((listener) => listener());
	return {
		standing,
		installed: () => installed,
		install(raw) {
			const parsed = parseManagedSettingsPolicy(raw);
			if (!parsed.ok) return { installed: false, problems: parsed.problems };
			installed = parsed.policy;
			changed();
			return { installed: true, policyRevision: parsed.policy.policyRevision };
		},
		clear() {
			installed = null;
			changed();
		},
		authorize: (key) => settingWriteVerdict(standing(), key),
		pins() {
			const current = standing();
			return current.standing === 'managed' ? current.policy : null;
		},
		onChange(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}

/** A direct store write to a held key: the refusal, by name, never a write that failed. */
export class ManagedSettingLockedError extends Error {
	constructor(
		readonly key: string,
		readonly code: SettingWriteDenial,
		message: string
	) {
		super(message);
		this.name = 'ManagedSettingLockedError';
	}
}

// The one authority every settings write path reads. Null until the desktop
// composes a source (and forever on a host that never does): standalone.
let writeAuthority: SettingsWriteAuthority | null = null;

export function setSettingsWriteAuthority(authority: SettingsWriteAuthority | null): void {
	writeAuthority = authority;
}

/** Hold a write to `key` (a dotted path is held by its top-level key). Standalone: allowed. */
export function holdSettingWrite(key: string): SettingWriteDecision {
	return writeAuthority ? writeAuthority.authorize(key.split('.')[0]) : { allowed: true };
}

type Setter = (...args: unknown[]) => unknown;
const unguardedSetters = new WeakMap<object, Setter>();

/** The top-level keys a store mutation reaches: `set(key)`, `set(object)`, `delete`, `reset(...keys)`, `clear()`. */
function keysOfMutation(method: string, args: unknown[]): readonly string[] {
	if (method === 'clear') return LOCKABLE_SETTING_KEYS;
	if (method === 'reset') return args.filter((arg): arg is string => typeof arg === 'string');
	const [first] = args;
	if (typeof first === 'string') return [first];
	if (method === 'set' && typeof first === 'object' && first !== null) return Object.keys(first);
	return [];
}

/**
 * Patch a settings store so every mutation is held before it reaches the file:
 * the chokepoint for main-process code that writes the store directly. A held
 * key throws and nothing is written, not even the other keys of a multi-key `set`.
 */
export function guardSettingsStore<T extends object>(store: T): T {
	const target = store as unknown as Record<string, unknown>;
	unguardedSetters.set(store, (target.set as Setter).bind(store));
	for (const method of ['set', 'delete', 'reset', 'clear']) {
		const original = target[method];
		if (typeof original !== 'function') continue;
		const wrapped = (...args: unknown[]) => {
			for (const key of keysOfMutation(method, args)) {
				const decision = holdSettingWrite(key);
				if (!decision.allowed)
					throw new ManagedSettingLockedError(key, decision.code, decision.message);
			}
			return (original as Setter).apply(store, args);
		};
		Object.defineProperty(store, method, { value: wrapped, writable: true, configurable: true });
	}
	return store;
}

/** Restore every pinned key whose value differs, through the unguarded setter; returns the keys restored. */
export function restoreManagedSettingPins(
	store: { readonly store: object; set(key: string, value: unknown): void },
	policy: ManagedSettingsPolicy | null
): string[] {
	const applied = applyManagedPins(store.store as Record<string, unknown>, policy);
	const write = unguardedSetters.get(store) ?? ((key, value) => store.set(key as string, value));
	for (const key of applied.restored) write(key, applied.settings[key]);
	return applied.restored;
}
