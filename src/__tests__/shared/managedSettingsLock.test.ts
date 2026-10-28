/**
 * @file managedSettingsLock.test.ts
 * @description The settings lock model (MRC2-06-01): which keys a policy may
 * hold, the closed policy document, lock and pin semantics, and the standalone
 * rule that nothing is ever held without a policy.
 */

import { describe, it, expect } from 'vitest';
import {
	AGENT_CONFIG_LOCK_KEYS,
	LOCKABLE_SETTING_KEYS,
	MANAGED_SETTINGS_LIMITS,
	MANAGED_SET_LOCK_KEYS,
	SESSION_CONFIG_LOCK_FIELDS,
	agentConfigLockKey,
	applyManagedPins,
	changedAgentConfigFields,
	isSettingLockable,
	isSettingLocked,
	lockedSettingKeys,
	managedSettingLockReason,
	managedSettingPin,
	parseManagedSettingsPolicy,
	type ManagedSettingsPolicy,
} from '../../shared/managedSettingsLock';
import { SETTINGS_METADATA } from '../../shared/settingsMetadata';

/** The keys P2-06 names, by the surface their value reaches. */
const EXPECTED_LOCKABLE = [
	...['utilityAgentId', 'utilityModelId', 'defaultShell', 'customShellPath', 'shellArgs'],
	...['shellEnvVars', 'shellEnvVarsDisabled', 'ghPath'],
	...['audioFeedbackCommand', 'idleNotificationCommand'],
	...['checkForUpdatesOnStartup', 'enableBetaUpdates', 'crashReportingEnabled'],
	...['statsCollectionEnabled', 'leaderboardRegistration', 'wakatimeEnabled', 'installationId'],
	...['webAuthEnabled', 'webAuthToken', 'persistentWebLink', 'webInterfaceAutoStart'],
	...['webInterfaceUseCustomPort', 'webInterfaceCustomPort', 'sshRemotes', 'defaultSshRemoteId'],
	...['encoreFeatures', 'speckitEnabled', 'openspecEnabled', 'bmadEnabled'],
	...['coworkingBrowserInteraction', 'coworkingBrowserInteractionConfirm'],
	...['coworkingBackgroundBrowsers', 'coworkingBackgroundBrowsersLimit'],
];

const policyOf = (locks: ManagedSettingsPolicy['locks']): ManagedSettingsPolicy => ({
	policyRevision: 7,
	locks,
});
const parse = (locks: unknown) => parseManagedSettingsPolicy({ policyRevision: 1, locks });
const pin = (key: string, value: unknown) => parse([{ key, pin: { value } }]);
const refused = (...problems: string[]) => ({ ok: false, problems });

describe('SETTINGS_METADATA lockable flag', () => {
	it('marks exactly the keys the policy may hold, and no other', () => {
		expect([...LOCKABLE_SETTING_KEYS].sort()).toEqual([...EXPECTED_LOCKABLE].sort());
		expect(Object.isFrozen(LOCKABLE_SETTING_KEYS)).toBe(true);
		for (const [key, meta] of Object.entries(SETTINGS_METADATA)) {
			const expected = EXPECTED_LOCKABLE.includes(key);
			expect(meta.lockable, key).toBe(expected ? true : undefined);
			expect(isSettingLockable(key), key).toBe(expected);
		}
		expect(isSettingLockable('noSuchSetting')).toBe(false);
	});
});

describe('parseManagedSettingsPolicy', () => {
	it('accepts lockable keys with and without pins, as a fresh value', () => {
		const pinned = { maestroCue: false };
		const locks = [
			{ key: 'defaultShell', pin: { value: 'zsh' } },
			{ key: 'encoreFeatures', pin: { value: pinned } },
			{ key: 'utilityAgentId', pin: { value: null } },
			{ key: 'webAuthToken' },
		];
		const parsed = parseManagedSettingsPolicy({ policyRevision: 3, locks });
		const expected = { policyRevision: 3, locks: structuredClone(locks) };
		pinned.maestroCue = true;
		locks.length = 0;
		expect(parsed).toEqual({ ok: true, policy: expected });
	});

	it.each([
		[null, 'the settings policy is not an object'],
		[{ policyRevision: 1, locks: [], extra: 1 }, 'extra is not a known key'],
		[{ policyRevision: -1, locks: [] }, 'policyRevision is not a policy revision'],
		[{ policyRevision: '1', locks: [] }, 'policyRevision is not a policy revision'],
		[{ policyRevision: 1, locks: {} }, 'locks is not an array'],
	])('refuses the document %j', (raw, problem) => {
		expect(parseManagedSettingsPolicy(raw)).toEqual(refused(problem));
	});

	it('refuses an unlockable or unknown key, a duplicate, a stray key and an oversized list', () => {
		expect(parse([{ key: 'theme' }, { key: 'noSuchSetting' }, { key: 7 }, 'ghPath'])).toEqual(
			refused(
				'locks[0].key is not a lockable setting key',
				'locks[1].key is not a lockable setting key',
				'locks[2].key is not a lockable setting key',
				'locks[3] is not an object'
			)
		);
		expect(parse([{ key: 'ghPath' }, { key: 'ghPath', pin: { value: '/gh' } }])).toEqual(
			refused('locks[1].key "ghPath" is named twice')
		);
		expect(parse([{ key: 'ghPath', extra: true }])).toEqual(
			refused('locks[0].extra is not a known key')
		);
		const bound =
			LOCKABLE_SETTING_KEYS.length + AGENT_CONFIG_LOCK_KEYS.length + MANAGED_SET_LOCK_KEYS.length;
		const many = Array.from({ length: bound + 1 }, () => ({ key: 'ghPath' }));
		expect(parse(many)).toEqual(refused(`locks exceeds ${bound} entries`));
	});

	it.each([
		['defaultShell', 1, 'is not a string'],
		['webInterfaceCustomPort', Number.NaN, 'is not a number'],
		['crashReportingEnabled', 'no', 'is not a boolean'],
		['encoreFeatures', [], 'is not an object'],
		['sshRemotes', {}, 'is not an array'],
		['defaultShell', null, 'is null for a key that is never null'],
	])('holds a %s pin of %j to the declared type', (key, value, problem) => {
		const suffix = `(the "${key}" setting is ${SETTINGS_METADATA[key].type})`;
		expect(pin(key, value)).toEqual(refused(`locks[0].pin.value ${problem} ${suffix}`));
	});

	it('lets a sensitive key be locked but never pinned', () => {
		expect(SETTINGS_METADATA.webAuthToken.sensitive).toBe(true);
		expect(parse([{ key: 'webAuthToken' }])).toMatchObject({ ok: true });
		expect(pin('webAuthToken', 'hunter2')).toEqual(
			refused(
				'locks[0].pin.value pins "webAuthToken", a sensitive key that may be locked but never pinned'
			)
		);
	});

	it('accepts null where the default is null, and refuses a missing, non-JSON or oversized pin', () => {
		expect(pin('defaultSshRemoteId', null)).toMatchObject({ ok: true });
		expect(pin('leaderboardRegistration', null)).toMatchObject({ ok: true });
		expect(parse([{ key: 'ghPath', pin: {} }])).toEqual(refused('locks[0].pin.value is missing'));
		expect(parse([{ key: 'ghPath', pin: { value: 'gh', also: 1 } }])).toEqual(
			refused('locks[0].pin.also is not a known key')
		);
		expect(pin('encoreFeatures', { when: new Date(0) })).toEqual(
			refused(expect.stringContaining('locks[0].pin.value'))
		);
		expect(pin('shellArgs', 'x'.repeat(MANAGED_SETTINGS_LIMITS.pinLength))).toEqual(
			refused(`locks[0].pin.value exceeds ${MANAGED_SETTINGS_LIMITS.pinLength} characters`)
		);
	});
});

describe('lock semantics', () => {
	const policy = policyOf([
		{ key: 'defaultShell', pin: { value: 'zsh' } },
		{ key: 'crashReportingEnabled' },
		{ key: 'defaultShell' },
		{ key: 'theme', pin: { value: 'dracula' } },
	]);

	it.each([null, undefined])('holds nothing standalone (%s)', (none) => {
		expect(isSettingLocked('defaultShell', none)).toBe(false);
		expect(lockedSettingKeys(none)).toEqual([]);
		expect(managedSettingPin('defaultShell', none)).toBeNull();
		expect(managedSettingLockReason('defaultShell', none)).toBeNull();
		const settings = { defaultShell: 'bash' };
		expect(applyManagedPins(settings, none)).toEqual({ settings, restored: [] });
		expect(applyManagedPins(settings, none).settings).toBe(settings);
	});

	it('holds the lockable keys the policy names, each once, never an unmarked one', () => {
		expect(isSettingLocked('defaultShell', policy)).toBe(true);
		expect(isSettingLocked('crashReportingEnabled', policy)).toBe(true);
		expect(isSettingLocked('ghPath', policy)).toBe(false);
		expect(isSettingLocked('theme', policy)).toBe(false);
		expect(lockedSettingKeys(policy)).toEqual(['defaultShell', 'crashReportingEnabled']);
		expect(managedSettingPin('theme', policy)).toBeNull();
		const applied = applyManagedPins({ theme: 'light' }, policy);
		expect(applied.restored).toEqual(['defaultShell']);
		expect(applied.settings.theme).toBe('light');
	});

	it('answers the pin as a fresh copy, null for a lock without one, and a stable reason', () => {
		const pinned = policyOf([{ key: 'encoreFeatures', pin: { value: { maestroCue: false } } }]);
		const got = managedSettingPin('encoreFeatures', pinned);
		expect(got).toEqual({ value: { maestroCue: false } });
		(got!.value as Record<string, unknown>).maestroCue = true;
		expect(managedSettingPin('encoreFeatures', pinned)).toEqual({ value: { maestroCue: false } });
		expect(managedSettingPin('crashReportingEnabled', policy)).toBeNull();
		expect(managedSettingLockReason('defaultShell', policy)).toBe(
			'the "defaultShell" setting is locked and pinned by managed policy revision 7'
		);
		expect(managedSettingLockReason('crashReportingEnabled', policy)).toBe(
			'the "crashReportingEnabled" setting is locked by managed policy revision 7'
		);
		expect(managedSettingLockReason('ghPath', policy)).toBeNull();
	});
});

describe('applyManagedPins', () => {
	const settings = {
		defaultShell: 'bash',
		crashReportingEnabled: true,
		encoreFeatures: { maestroCue: true, symphony: false },
		theme: 'light',
	};

	it('hands the same object back for a lock without a pin or a pin already held (any key order)', () => {
		const policy = policyOf([
			{ key: 'crashReportingEnabled' },
			{ key: 'encoreFeatures', pin: { value: { symphony: false, maestroCue: true } } },
		]);
		expect(applyManagedPins(settings, policy)).toEqual({ settings, restored: [] });
		expect(applyManagedPins(settings, policy).settings).toBe(settings);
	});

	it('restores every differing pin as a fresh copy without mutating the input', () => {
		const policy = policyOf([
			{ key: 'defaultShell', pin: { value: 'zsh' } },
			{ key: 'crashReportingEnabled' },
			{ key: 'encoreFeatures', pin: { value: { maestroCue: false } } },
			{ key: 'utilityAgentId', pin: { value: null } },
		]);
		const applied = applyManagedPins(settings, policy);
		expect(applied.restored).toEqual(['defaultShell', 'encoreFeatures', 'utilityAgentId']);
		expect(applied.settings).not.toBe(settings);
		expect(applied.settings).toEqual({
			...settings,
			defaultShell: 'zsh',
			encoreFeatures: { maestroCue: false },
			utilityAgentId: null,
		});
		expect(settings.defaultShell).toBe('bash');
		expect(settings).not.toHaveProperty('utilityAgentId');
		(applied.settings.encoreFeatures as Record<string, unknown>).maestroCue = true;
		expect(policy.locks[2].pin).toEqual({ value: { maestroCue: false } });
	});
});

describe('the per-provider configuration namespace (MRC2-06-03)', () => {
	it('names the five fields as agentConfig.* keys beside, not inside, the settings keys', () => {
		expect(AGENT_CONFIG_LOCK_KEYS).toEqual([
			'agentConfig.customPath',
			'agentConfig.customArgs',
			'agentConfig.customEnvVars',
			'agentConfig.model',
			'agentConfig.reasoningEffort',
		]);
		expect(AGENT_CONFIG_LOCK_KEYS.every(isSettingLockable)).toBe(true);
		expect(AGENT_CONFIG_LOCK_KEYS.some((key) => LOCKABLE_SETTING_KEYS.includes(key))).toBe(false);
		expect(agentConfigLockKey('customArgs')).toBe('agentConfig.customArgs');
		expect(agentConfigLockKey('contextWindow')).toBeNull();
		expect(isSettingLockable('agentConfig.contextWindow')).toBe(false);
		expect(isSettingLockable('agentConfig')).toBe(false);
		expect(Object.values(SESSION_CONFIG_LOCK_FIELDS).map(agentConfigLockKey)).toEqual(
			AGENT_CONFIG_LOCK_KEYS
		);
	});

	it('parses a lock on an agentConfig key, refuses its pin, and holds it by the one reason', () => {
		const parsed = parseManagedSettingsPolicy({
			policyRevision: 2,
			locks: [{ key: 'agentConfig.customEnvVars' }, { key: 'ghPath' }],
		});
		expect(parsed.ok).toBe(true);
		const policy = parsed.ok ? parsed.policy : null;
		expect(lockedSettingKeys(policy)).toEqual(['agentConfig.customEnvVars', 'ghPath']);
		expect(isSettingLocked('agentConfig.customEnvVars', policy)).toBe(true);
		expect(isSettingLocked('agentConfig.customArgs', policy)).toBe(false);
		expect(managedSettingLockReason('agentConfig.customEnvVars', policy)).toBe(
			'the "agentConfig.customEnvVars" setting is locked by managed policy revision 2'
		);
		expect(managedSettingPin('agentConfig.customEnvVars', policy)).toBeNull();
		expect(applyManagedPins({ ghPath: '/g' }, policy).restored).toEqual([]);
		expect(
			parseManagedSettingsPolicy({
				policyRevision: 2,
				locks: [{ key: 'agentConfig.model', pin: { value: 'gpt-5' } }],
			})
		).toEqual({
			ok: false,
			problems: [
				'locks[0].pin.value pins "agentConfig.model", a per-provider configuration key that may be locked but never pinned',
			],
		});
	});

	it('lists only the held fields a whole-config write changes (admin sets below)', () => {
		const before = { customPath: '/a', customEnvVars: { A: '1' }, contextWindow: 5 };
		expect(changedAgentConfigFields(before, { ...before, contextWindow: 9 })).toEqual([]);
		expect(changedAgentConfigFields(before, { customEnvVars: { A: '1' } })).toEqual(['customPath']);
		expect(
			changedAgentConfigFields(before, { ...before, customArgs: '--x', customEnvVars: { A: '2' } })
		).toEqual(['customArgs', 'customEnvVars']);
	});
});

describe('the admin set namespace (MRC2-06-04)', () => {
	const PROMPTS = 'prompts.customizations';
	const PLUGINS = 'plugins.installed';

	it('names the two sets beside the settings keys and pins each to its closed shape', () => {
		expect(MANAGED_SET_LOCK_KEYS).toEqual([PROMPTS, PLUGINS]);
		expect(LOCKABLE_SETTING_KEYS).not.toContain(PROMPTS);
		expect(isSettingLockable(PLUGINS)).toBe(true);
		const prompts = { 'wizard-system': 'pinned' };
		expect(pin(PROMPTS, prompts)).toEqual({
			ok: true,
			policy: { ...policyOf([{ key: PROMPTS, pin: { value: prompts } }]), policyRevision: 1 },
		});
		expect(pin(PLUGINS, ['kept', 'a.b-c'])).toMatchObject({ ok: true });
		expect(pin(PROMPTS, { nope: 'x' })).toEqual(
			refused('locks[0].pin.value names "nope", which is not a Maestro prompt id')
		);
		expect(pin(PROMPTS, { 'wizard-system': 1 })).toEqual(
			refused('locks[0].pin.value holds a non-string content for "wizard-system"')
		);
		expect(pin(PLUGINS, {})).toEqual(refused('locks[0].pin.value is not an array of plugin ids'));
		expect(pin(PLUGINS, ['../x'])).toEqual(
			refused('locks[0].pin.value names "../x", which is not a plugin id')
		);
		expect(pin(PLUGINS, ['a', 'a'])).toEqual(refused('locks[0].pin.value names a plugin id twice'));
		// Held by the one reason; the pin is never written into the settings.
		const policy = policyOf([{ key: PROMPTS, pin: { value: { 'wizard-system': 'p' } } }]);
		expect(managedSettingLockReason(PROMPTS, policy)).toBe(
			'the "prompts.customizations" setting is locked and pinned by managed policy revision 7'
		);
		const settings = { ghPath: '/gh' };
		expect(applyManagedPins(settings, policy)).toEqual({ settings, restored: [] });
	});
});
