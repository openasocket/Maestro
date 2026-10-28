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
 *
 * The per-provider configuration (MRC2-06-03: path, arguments, environment,
 * model, effort) is held the same way through `holdAgentConfigWrite()`, read
 * by the `agents:setConfig*` IPC handlers and the bridge's
 * `update_session_config`: the lock first, then what the Phase 1 provider
 * ceiling would refuse at launch, named at write time instead of silently
 * stripped later. The admin sets (MRC2-06-04) are held by `holdPromptSetWrite()`
 * and `holdPluginSetWrite()`; the SSH remote handlers hold their settings keys.
 * The Storage Location and the remote-access actions (MRC2-06-04A) are held by
 * `holdManagedKey()`, the key by its own name; their sinks restore with it.
 * `readManagedSettingLocks()` (MRC2-06-05) is what a Settings pane shows of
 * the same authority: every key it refuses right now, named with the same line.
 */

import type { ManagedPolicyStatus } from '../../shared/maestro-lib/managed/host-adapter';
import { parseCustomArgs } from '../../shared/maestro-lib/launch/agent-args';
import {
	ALL_ROUTE_ENV_NAMES,
	MANAGED_AUTHORITY_ENV_NAMES,
	MANAGED_AUTHORITY_ENV_PREFIX,
	managedArgsProblems,
	type ManagedRouteCeiling,
} from '../../shared/maestro-lib/launch/env';
import { isWindows } from '../../shared/platformDetection';
import {
	LOCKABLE_SETTING_KEYS,
	MANAGED_LOCK_KEYS,
	NO_MANAGED_SETTING_LOCKS,
	PLUGIN_SET_LOCK_KEY,
	PROMPT_SET_LOCK_KEY,
	agentConfigLockKey,
	applyManagedPins,
	isSettingLockable,
	managedSettingLockReason,
	managedSettingPin,
	parseManagedSettingsPolicy,
	type ManagedSettingLockCode,
	type ManagedSettingLocksView,
	type ManagedSettingsPolicy,
} from '../../shared/managedSettingsLock';
import {
	PLAIN_SETTINGS_CREDENTIAL_KEYS,
	SETTINGS_FILE_CUSTODY,
	credentialCustodyVerdict,
} from './credential-custody';
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

export type SettingWriteDenial = ManagedSettingLockCode;
export type SettingWriteDecision =
	| { allowed: true }
	| { allowed: false; code: SettingWriteDenial; message: string; policyRevision: number | null };

/**
 * Hold one write against the standing. Pure. Standalone admits everything; a
 * credential key the plain settings file would keep is refused on every
 * managed host, policy or no policy (MRC2-06-06); a key the metadata never
 * marked lockable is admitted under any standing; a managed host with no
 * usable policy refuses every lockable key by name.
 */
export function settingWriteVerdict(
	standing: ManagedSettingsStanding,
	key: string
): SettingWriteDecision {
	if (standing.standing === 'standalone') return { allowed: true };
	const deny = (code: SettingWriteDenial, message: string): SettingWriteDecision => ({
		allowed: false,
		code,
		message,
		policyRevision: standing.policyRevision,
	});
	const credential = PLAIN_SETTINGS_CREDENTIAL_KEYS[key];
	if (credential !== undefined) {
		const custody = credentialCustodyVerdict('managed', credential, SETTINGS_FILE_CUSTODY);
		if (!custody.allowed) return deny('custody', custody.message);
	}
	if (!isSettingLockable(key)) return { allowed: true };
	if (!standing.policy)
		return deny(
			'unavailable',
			`the "${key}" setting is held by managed policy and the managed settings policy is unavailable (${standing.reason})`
		);
	const reason = managedSettingLockReason(key, standing.policy);
	return reason === null ? { allowed: true } : deny('locked', reason);
}

export type AgentConfigWriteDenial = SettingWriteDenial | 'ceiling';
export type AgentConfigWriteDecision =
	| { allowed: true }
	| {
			allowed: false;
			code: AgentConfigWriteDenial;
			message: string;
			policyRevision: number | null;
	  };

/** A ceiling that pins nothing: only the flags and names no policy admits are a problem. */
const unpinnedCeiling = (providerId: string): ManagedRouteCeiling => ({
	providerId,
	model: null,
	baseUrl: null,
	accountDir: null,
	login: 'provider-login',
	permissionMode: null,
});

const removedByEnvCeiling = (name: string): boolean => {
	const same = (known: string) =>
		known === name || (isWindows() && known.toUpperCase() === name.toUpperCase());
	return (
		ALL_ROUTE_ENV_NAMES.some(same) ||
		MANAGED_AUTHORITY_ENV_NAMES.some(same) ||
		name.toUpperCase().startsWith(MANAGED_AUTHORITY_ENV_PREFIX)
	);
};

/**
 * What the Phase 1 provider ceiling would refuse at launch, named at write
 * time: an argument that routes around it (`managedArgsProblems` under a
 * ceiling that pins nothing) and an environment name `applyManagedEnvCeiling`
 * removes. The pinned model, origin, account home and permission mode stay
 * the launch plan's to hold, so a value admitted here can still be refused there.
 */
export function agentConfigCeilingProblems(
	providerId: string,
	field: string,
	value: unknown
): string[] {
	if (field === 'customArgs' && typeof value === 'string')
		return managedArgsProblems(parseCustomArgs(value), unpinnedCeiling(providerId));
	if (field === 'customEnvVars' && value && typeof value === 'object')
		return Object.keys(value)
			.filter(removedByEnvCeiling)
			.map((name) => `${name} is removed by the managed environment ceiling at launch`);
	return [];
}

/**
 * Hold one per-provider configuration write: the lock (`agentConfig.<field>`,
 * the rule of `settingWriteVerdict`), then, under a usable policy, the
 * ceiling. A field no policy may hold, and standalone, admit everything.
 */
export function agentConfigWriteVerdict(
	standing: ManagedSettingsStanding,
	providerId: string,
	field: string,
	value: unknown
): AgentConfigWriteDecision {
	const key = agentConfigLockKey(field);
	if (key === null || standing.standing === 'standalone') return { allowed: true };
	const lock = settingWriteVerdict(standing, key);
	if (!lock.allowed) return lock;
	const problems = agentConfigCeilingProblems(providerId, field, value);
	if (problems.length === 0) return { allowed: true };
	return {
		allowed: false,
		code: 'ceiling',
		message: `the ${field} configuration of ${providerId} would route around the managed provider ceiling: ${problems.join('; ')}`,
		policyRevision: standing.policyRevision,
	};
}

export interface SettingsPolicySourceDeps {
	identity: Pick<EnterpriseIdentityStore, 'read'>;
	policy(): Pick<ManagedPolicyStatus, 'appliedRevision'> | null;
}

/** What a write path holds a key with: the source, or a test double. */
export interface SettingsWriteAuthority {
	authorize(key: string): SettingWriteDecision;
	/** Hold a per-provider configuration field (`customPath`, `customArgs`, `customEnvVars`, `model`, `reasoningEffort`). */
	authorizeAgentConfig(providerId: string, field: string, value: unknown): AgentConfigWriteDecision;
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
		authorizeAgentConfig: (providerId, field, value) =>
			agentConfigWriteVerdict(standing(), providerId, field, value),
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
		readonly code: AgentConfigWriteDenial,
		message: string
	) {
		super(message);
		this.name = 'ManagedSettingLockedError';
	}

	/** The policy's line alone: a handler wrapper that answers `String(error)` shows no class name. */
	toString(): string {
		return this.message;
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

/** Hold a per-provider configuration write for `providerId` through the same authority. Standalone: allowed. */
export function holdAgentConfigWrite(
	providerId: string,
	field: string,
	value: unknown
): AgentConfigWriteDecision {
	return writeAuthority
		? writeAuthority.authorizeAgentConfig(providerId, field, value)
		: { allowed: true };
}

/** Hold a save or reset of a Maestro Prompts customization through the same authority. Standalone: allowed. */
export function holdPromptSetWrite(): SettingWriteDecision {
	return writeAuthority ? writeAuthority.authorize(PROMPT_SET_LOCK_KEY) : { allowed: true };
}

/**
 * Hold a write to a key held by its own name (`storage.syncPath`,
 * `web.liveSessions`, `web.tunnel`, `lite.control`; MRC2-06-04A), never split
 * at a dot. Standalone: allowed. For an action key the same verdict decides the
 * restore: what it refuses to turn on, the sink ends at startup and on every
 * policy change.
 */
export function holdManagedKey(key: string): SettingWriteDecision {
	return writeAuthority ? writeAuthority.authorize(key) : { allowed: true };
}

/**
 * What a Settings pane shows of the lock (MRC2-06-05): every key the authority
 * refuses right now, with the line a refused write is named with and whether a
 * pin holds its value. Read by `settings:managedLocks`; standalone, and under
 * no authority, nothing is held. A projection of the same verdict the write
 * paths meet, never a second lock read.
 */
export function readManagedSettingLocks(): ManagedSettingLocksView {
	if (!writeAuthority) return NO_MANAGED_SETTING_LOCKS;
	const policy = writeAuthority.pins();
	const locks: Record<string, ManagedSettingLocksView['locks'][string]> = {};
	let policyRevision = policy?.policyRevision ?? null;
	for (const key of MANAGED_LOCK_KEYS) {
		const decision = writeAuthority.authorize(key);
		if (decision.allowed) continue;
		policyRevision ??= decision.policyRevision;
		locks[key] = {
			code: decision.code,
			message: decision.message,
			pinned: managedSettingPin(key, policy) !== null,
		};
	}
	return { policyRevision, locks };
}

/** A change to the installed plugin set, held before the files or the ledger are touched. */
export type PluginSetChange = { op: 'install' | 'uninstall'; pluginId: string } | { op: 'update' };

/**
 * Hold a plugin-set change: the lock's own verdict (`lock`, on `PLUGIN_SET_LOCK_KEY`),
 * then under a pin the set itself: an install of a listed id, an uninstall of an
 * unlisted one and an update are admitted; nothing is restored (no source exists).
 */
export function pluginSetVerdict(
	lock: SettingWriteDecision,
	policy: ManagedSettingsPolicy | null,
	change: PluginSetChange
): SettingWriteDecision {
	if (lock.allowed || lock.code !== 'locked') return lock;
	const pin = managedSettingPin(PLUGIN_SET_LOCK_KEY, policy);
	if (!pin) return lock;
	if (change.op === 'update') return { allowed: true };
	const listed = (pin.value as string[]).includes(change.pluginId);
	if (listed === (change.op === 'install')) return { allowed: true };
	return {
		...lock,
		message: `plugin "${change.pluginId}" is ${listed ? 'in' : 'not in'} the plugin set pinned by managed policy revision ${lock.policyRevision}`,
	};
}

/** Hold a change to the installed plugin set through the same authority. Standalone: allowed. */
export function holdPluginSetWrite(change: PluginSetChange): SettingWriteDecision {
	if (!writeAuthority) return { allowed: true };
	return pluginSetVerdict(
		writeAuthority.authorize(PLUGIN_SET_LOCK_KEY),
		writeAuthority.pins(),
		change
	);
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
