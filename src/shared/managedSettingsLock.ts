/**
 * The settings lock model a managed desktop holds its settings to (MRC2-06-01).
 *
 * Pure and Electron-free, so the store write path, the IPC and web-bridge
 * handlers, the Settings badge and the CLI all agree on which key is held and
 * to what. A policy names the keys it locks; a lock may also PIN the key to
 * one value (restored at startup and on each policy change). Standalone there
 * is no policy (`null`) and every function answers "not held" and returns its
 * input. Which keys a policy MAY hold is the metadata's call alone: a key is
 * `lockable` in `SETTINGS_METADATA` where its value reaches a shell, a
 * network, a credential, a reporting channel or a feature gate; the parser
 * refuses any other key and `isSettingLocked()` never holds an unmarked one,
 * even when a hand-built policy lists it. A pin is a JSON value of the key's
 * declared type (or `null` where the default is `null`); a `sensitive` key
 * may be locked but never pinned, since a policy document is ordinary
 * configuration and a credential in it would land in plain settings.
 *
 * Beside the settings keys, a policy may hold the per-provider configuration
 * fields (MRC2-06-03) as `agentConfig.<field>` keys: the binary path, the
 * arguments, the environment, the model and the effort every agent of a
 * provider launches with (`maestro-agent-configs.json`) and the same fields on
 * one agent's own record. Locked, never pinned: what a managed launch may ask
 * for is the route ceiling's call at spawn, not a settings value.
 *
 * And two admin sets (MRC2-06-04), lockable and pinnable, neither a settings
 * value: the Maestro Prompts customizations (`prompts.customizations`, restored
 * by the prompts handler) and the installed plugin set (`plugins.installed`,
 * held at install and uninstall); `applyManagedPins()` leaves both alone.
 *
 * MRC2-06-04A adds the Storage Location sync folder (`storage.syncPath`,
 * pinned to an absolute folder or null for the user-data default, restored by
 * the system handler through the migration the Settings tab runs) and three
 * remote-access ACTION keys, locked and never pinned: `web.liveSessions`,
 * `web.tunnel` and `lite.control`. A lock on an action key refuses turning
 * the action on, and its sink ends what is on at startup and on every policy
 * change; turning an action off is never held.
 */

import { canonicalJson } from './canonicalJson';
import { PLUGIN_ID_PATTERN } from './plugins/plugin-manifest';
import { CORE_PROMPTS } from './promptDefinitions';
import { SETTINGS_METADATA, type SettingMetadata, type SettingType } from './settingsMetadata';

export interface ManagedSettingsLock {
	key: string;
	/** Present when the policy pins the value; absent holds the key at the value it has. */
	pin?: { value: unknown };
}

export interface ManagedSettingsPolicy {
	policyRevision: number;
	locks: ManagedSettingsLock[];
}

/** No policy: standalone. */
export type ManagedSettingsPolicyRef = ManagedSettingsPolicy | null | undefined;

export const MANAGED_SETTINGS_LIMITS = { pinLength: 65536 } as const;

const POLICY_KEYS = ['policyRevision', 'locks'] as const;
const LOCK_KEYS = ['key', 'pin'] as const;
const PIN_KEYS = ['value'] as const;

/** Every key `SETTINGS_METADATA` marks lockable, in registry order. */
export const LOCKABLE_SETTING_KEYS: readonly string[] = Object.freeze(
	Object.entries(SETTINGS_METADATA)
		.filter(([, meta]) => meta.lockable === true)
		.map(([key]) => key)
);

/** The per-provider configuration fields a policy may hold, in registry order. */
export const AGENT_CONFIG_LOCK_FIELDS = [
	'customPath',
	'customArgs',
	'customEnvVars',
	'model',
	'reasoningEffort',
] as const;
export type AgentConfigLockField = (typeof AGENT_CONFIG_LOCK_FIELDS)[number];
export const AGENT_CONFIG_LOCK_PREFIX = 'agentConfig.';
/** The lock keys of {@link AGENT_CONFIG_LOCK_FIELDS}: `agentConfig.customPath` and so on. */
export const AGENT_CONFIG_LOCK_KEYS: readonly string[] = Object.freeze(
	AGENT_CONFIG_LOCK_FIELDS.map((field) => `${AGENT_CONFIG_LOCK_PREFIX}${field}`)
);
/** An agent record's own field (`customModel`) to the configuration field it is held as (`model`). */
export const SESSION_CONFIG_LOCK_FIELDS: Readonly<Record<string, AgentConfigLockField>> =
	Object.freeze({
		customPath: 'customPath',
		customArgs: 'customArgs',
		customEnvVars: 'customEnvVars',
		customModel: 'model',
		customEffort: 'reasoningEffort',
	});

export function isAgentConfigLockField(field: string): field is AgentConfigLockField {
	return (AGENT_CONFIG_LOCK_FIELDS as readonly string[]).includes(field);
}

/** The lock key a per-provider configuration field is held by, or null for a field no policy may hold. */
export function agentConfigLockKey(field: string): string | null {
	return isAgentConfigLockField(field) ? `${AGENT_CONFIG_LOCK_PREFIX}${field}` : null;
}

/** The Maestro Prompts customization set, pinned as `{ [promptId]: content }`. */
export const PROMPT_SET_LOCK_KEY = 'prompts.customizations';
/** The installed community plugin set, pinned as plugin ids. */
export const PLUGIN_SET_LOCK_KEY = 'plugins.installed';
/** The Storage Location sync folder (`maestro-bootstrap.json`), pinned as an absolute folder or null for the user-data default. */
export const SYNC_PATH_LOCK_KEY = 'storage.syncPath';
export const MANAGED_SET_LOCK_KEYS: readonly string[] = Object.freeze([
	PROMPT_SET_LOCK_KEY,
	PLUGIN_SET_LOCK_KEY,
	SYNC_PATH_LOCK_KEY,
]);

/** Remote-access actions a policy may hold, locked and never pinned: Live Mode sessions, the cloudflared tunnel, the Lite client's controls. */
export const LIVE_SESSIONS_LOCK_KEY = 'web.liveSessions';
export const TUNNEL_LOCK_KEY = 'web.tunnel';
export const LITE_CONTROL_LOCK_KEY = 'lite.control';
export const MANAGED_ACTION_LOCK_KEYS: readonly string[] = Object.freeze([
	LIVE_SESSIONS_LOCK_KEY,
	TUNNEL_LOCK_KEY,
	LITE_CONTROL_LOCK_KEY,
]);

const LOCK_BOUND =
	LOCKABLE_SETTING_KEYS.length +
	AGENT_CONFIG_LOCK_KEYS.length +
	MANAGED_SET_LOCK_KEYS.length +
	MANAGED_ACTION_LOCK_KEYS.length;

export function isSettingLockable(key: string): boolean {
	return (
		SETTINGS_METADATA[key]?.lockable === true ||
		AGENT_CONFIG_LOCK_KEYS.includes(key) ||
		MANAGED_SET_LOCK_KEYS.includes(key) ||
		MANAGED_ACTION_LOCK_KEYS.includes(key)
	);
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const unknownKeys = (value: object, known: readonly string[], at: string): string[] =>
	Object.keys(value)
		.filter((key) => !known.includes(key))
		.map((key) => `${at}${key} is not a known key`);

const TYPE_CHECKS: Record<SettingType, (value: unknown) => boolean> = {
	string: (value) => typeof value === 'string',
	number: (value) => typeof value === 'number' && Number.isFinite(value),
	boolean: (value) => typeof value === 'boolean',
	object: isPlainObject,
	array: Array.isArray,
	null: () => false,
};

function typeProblem(meta: SettingMetadata, value: unknown): string | null {
	if (value === null) return meta.default === null ? null : 'is null for a key that is never null';
	if (TYPE_CHECKS[meta.type](value)) return null;
	return `is not ${/^[aeiou]/.test(meta.type) ? 'an' : 'a'} ${meta.type}`;
}

/** What an admin set's pin must be: a closed shape, every member a known id. */
const MANAGED_SET_PIN_PROBLEM: Record<string, (value: unknown) => string | null> = {
	[PROMPT_SET_LOCK_KEY]: (value) => {
		if (!isPlainObject(value)) return 'is not an object of prompt id to content';
		for (const [id, content] of Object.entries(value)) {
			if (!CORE_PROMPTS.some((prompt) => prompt.id === id))
				return `names "${id}", which is not a Maestro prompt id`;
			if (typeof content !== 'string') return `holds a non-string content for "${id}"`;
		}
		return null;
	},
	[PLUGIN_SET_LOCK_KEY]: (value) => {
		if (!Array.isArray(value)) return 'is not an array of plugin ids';
		const bad = value.find((id) => typeof id !== 'string' || !PLUGIN_ID_PATTERN.test(id));
		if (bad !== undefined) return `names ${JSON.stringify(bad)}, which is not a plugin id`;
		return new Set(value).size === value.length ? null : 'names a plugin id twice';
	},
	[SYNC_PATH_LOCK_KEY]: (value) => {
		if (value === null) return null;
		if (typeof value !== 'string') return 'is not an absolute folder path or null';
		if (!/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(value)) return 'is not an absolute folder path';
		if (value.includes('\0') || value.split(/[/\\]/).includes('..'))
			return 'is not a plain absolute folder path';
		return null;
	},
};

function pinProblem(key: string, raw: unknown): string | null {
	if (key.startsWith(AGENT_CONFIG_LOCK_PREFIX))
		return `pins "${key}", a per-provider configuration key that may be locked but never pinned`;
	if (MANAGED_ACTION_LOCK_KEYS.includes(key))
		return `pins "${key}", an action key that may be locked but never pinned`;
	const setProblem = MANAGED_SET_PIN_PROBLEM[key];
	if (setProblem) return setProblem(raw);
	const meta = SETTINGS_METADATA[key];
	if (meta.sensitive) return `pins "${key}", a sensitive key that may be locked but never pinned`;
	const mismatch = typeProblem(meta, raw);
	return mismatch ? `${mismatch} (the "${key}" setting is ${meta.type})` : null;
}

/** A fresh JSON copy of a pin the caller's input can no longer reach, or the problem. */
function parsePinValue(key: string, raw: unknown, at: string, problems: string[]): unknown {
	const problem = pinProblem(key, raw);
	if (problem) {
		problems.push(`${at} ${problem}`);
		return undefined;
	}
	let text: string;
	try {
		text = canonicalJson(raw);
	} catch (error) {
		problems.push(`${at} ${error instanceof Error ? error.message : 'is not a JSON value'}`);
		return undefined;
	}
	if (text.length > MANAGED_SETTINGS_LIMITS.pinLength) {
		problems.push(`${at} exceeds ${MANAGED_SETTINGS_LIMITS.pinLength} characters`);
		return undefined;
	}
	return JSON.parse(text);
}

function parseLock(raw: unknown, at: string, problems: string[]): ManagedSettingsLock | null {
	if (!isPlainObject(raw)) {
		problems.push(`${at} is not an object`);
		return null;
	}
	problems.push(...unknownKeys(raw, LOCK_KEYS, `${at}.`));
	const before = problems.length;
	const key = raw.key;
	if (typeof key !== 'string' || !isSettingLockable(key))
		problems.push(`${at}.key is not a lockable setting key`);
	let pin: ManagedSettingsLock['pin'];
	if (raw.pin !== undefined) {
		if (!isPlainObject(raw.pin)) problems.push(`${at}.pin is not an object`);
		else {
			problems.push(...unknownKeys(raw.pin, PIN_KEYS, `${at}.pin.`));
			if (!('value' in raw.pin)) problems.push(`${at}.pin.value is missing`);
			else if (typeof key === 'string' && isSettingLockable(key)) {
				const value = parsePinValue(key, raw.pin.value, `${at}.pin.value`, problems);
				if (problems.length === before) pin = { value };
			}
		}
	}
	if (problems.length !== before) return null;
	return pin ? { key: key as string, pin } : { key: key as string };
}

export type ManagedSettingsPolicyParse =
	| { ok: true; policy: ManagedSettingsPolicy }
	| { ok: false; problems: readonly string[] };

/** Validate a lock document into a fresh value; one problem, named by path, refuses it all. */
export function parseManagedSettingsPolicy(raw: unknown): ManagedSettingsPolicyParse {
	if (!isPlainObject(raw)) return { ok: false, problems: ['the settings policy is not an object'] };
	const problems = unknownKeys(raw, POLICY_KEYS, '');
	if (!Number.isSafeInteger(raw.policyRevision) || (raw.policyRevision as number) < 0)
		problems.push('policyRevision is not a policy revision');
	const locks: ManagedSettingsLock[] = [];
	if (!Array.isArray(raw.locks)) problems.push('locks is not an array');
	else if (raw.locks.length > LOCK_BOUND) problems.push(`locks exceeds ${LOCK_BOUND} entries`);
	else
		raw.locks.forEach((entry, index) => {
			const parsed = parseLock(entry, `locks[${index}]`, problems);
			if (parsed && locks.some((seen) => seen.key === parsed.key))
				problems.push(`locks[${index}].key "${parsed.key}" is named twice`);
			else if (parsed) locks.push(parsed);
		});
	if (problems.length > 0) return { ok: false, problems };
	return { ok: true, policy: { policyRevision: raw.policyRevision as number, locks } };
}

const sameJson = (a: unknown, b: unknown): boolean => {
	try {
		return canonicalJson(a) === canonicalJson(b);
	} catch {
		return false;
	}
};

const cloneJson = (value: unknown): unknown =>
	value === undefined ? undefined : JSON.parse(JSON.stringify(value));

function lockOf(key: string, policy: ManagedSettingsPolicyRef): ManagedSettingsLock | null {
	if (!policy || !isSettingLockable(key)) return null;
	return policy.locks.find((lock) => lock.key === key) ?? null;
}

/** Whether a policy holds this key. Standalone (no policy) and a key the metadata does not mark: never. */
export function isSettingLocked(key: string, policy: ManagedSettingsPolicyRef): boolean {
	return lockOf(key, policy) !== null;
}

/** The keys the policy holds, each once, in the policy's order. */
export function lockedSettingKeys(policy: ManagedSettingsPolicyRef): string[] {
	const keys: string[] = [];
	for (const lock of policy?.locks ?? [])
		if (isSettingLockable(lock.key) && !keys.includes(lock.key)) keys.push(lock.key);
	return keys;
}

/** The value the policy pins this key to, or null when it is unlocked or locked without a pin. */
export function managedSettingPin(
	key: string,
	policy: ManagedSettingsPolicyRef
): { value: unknown } | null {
	const lock = lockOf(key, policy);
	return lock?.pin ? { value: cloneJson(lock.pin.value) } : null;
}

/** The one stable line a refused write is named with (handler, bridge, CLI, badge), or null. */
export function managedSettingLockReason(
	key: string,
	policy: ManagedSettingsPolicyRef
): string | null {
	const lock = lockOf(key, policy);
	if (!lock || !policy) return null;
	return lock.pin
		? `the "${key}" setting is locked and pinned by managed policy revision ${policy.policyRevision}`
		: `the "${key}" setting is locked by managed policy revision ${policy.policyRevision}`;
}

/** The held fields a whole-config write changes; a write that leaves a held field as it is holds nothing. */
export function changedAgentConfigFields(
	before: Record<string, unknown>,
	after: Record<string, unknown>
): AgentConfigLockField[] {
	return AGENT_CONFIG_LOCK_FIELDS.filter(
		(field) => !sameJson(before[field] ?? null, after[field] ?? null)
	);
}

export interface ManagedPinApplication<T> {
	/** The input object itself when nothing changed, otherwise a shallow copy with the pins applied. */
	settings: T;
	/** The pinned keys whose value differed from the policy's, in the policy's order. */
	restored: string[];
}

/**
 * Restore every pinned settings key whose value differs, as a fresh copy. A
 * lock without a pin, a pin already held, an admin set's pin (not a settings
 * value), or no policy at all changes nothing.
 */
export function applyManagedPins<T extends Record<string, unknown>>(
	settings: T,
	policy: ManagedSettingsPolicyRef
): ManagedPinApplication<T> {
	const restored: string[] = [];
	const next: Record<string, unknown> = { ...settings };
	for (const key of lockedSettingKeys(policy)) {
		const lock = lockOf(key, policy);
		if (!lock?.pin || !(key in SETTINGS_METADATA) || sameJson(settings[key], lock.pin.value))
			continue;
		next[key] = cloneJson(lock.pin.value);
		restored.push(key);
	}
	return restored.length === 0 ? { settings, restored } : { settings: next as T, restored };
}
