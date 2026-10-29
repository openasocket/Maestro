/**
 * Main-process enforcement of the settings lock model (MRC2-06-02): standing,
 * verdict, source, store guard, pin restoration and the bridge's set_setting.
 * Standalone: unchanged. (The settings:set IPC path is in persistence.test.ts.)
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { IdentityRead } from '../../../main/enterprise/identity-store';
import {
	ManagedSettingLockedError,
	agentConfigWriteVerdict,
	createSettingsPolicySource,
	guardSettingsStore,
	holdAgentConfigWrite,
	holdManagedKey,
	holdPluginSetWrite,
	holdPromptSetWrite,
	holdSettingWrite,
	managedSettingsStanding,
	pluginSetVerdict,
	readManagedSettingLocks,
	restoreManagedSettingPins,
	setSettingsWriteAuthority,
	settingWriteVerdict,
} from '../../../main/enterprise/settings-policy';
import { handleUpdateSessionConfig } from '../../../main/web-server/handlers/messageHandlers/sessions';
import { MANAGED_LOCK_KEYS } from '../../../shared/managedSettingsLock';
import { handleSetSetting } from '../../../main/web-server/handlers/messageHandlers/settings';
import type { MessageHandlerContext } from '../../../main/web-server/handlers/messageHandlers/types';

const document = (overrides: Record<string, unknown> = {}) => ({
	policyRevision: 3,
	locks: [{ key: 'ghPath', pin: { value: '/opt/managed/gh' } }, { key: 'webAuthEnabled' }],
	...overrides,
});

function fakeStore(data: Record<string, unknown>) {
	const writes: unknown[][] = [];
	const record = (...args: unknown[]) => void writes.push(args);
	return {
		writes,
		store: data,
		set(...args: unknown[]) {
			record(...args);
			if (typeof args[0] === 'string') data[args[0]] = args[1];
		},
		delete: record,
		reset: record,
		clear: record,
	};
}

const enrolled: IdentityRead = { status: 'ok', record: {} as never, fileExists: true } as never;

const source = (read: IdentityRead = enrolled, appliedRevision: number | null = 3) =>
	createSettingsPolicySource({
		identity: { read: () => read },
		policy: () => (appliedRevision === null ? null : { appliedRevision }),
	});

/** A source with the document installed, composed as the one write authority. */
function installed(raw: Record<string, unknown> = document()) {
	const current = source();
	expect(current.install(raw)).toEqual({ installed: true, policyRevision: 3 });
	setSettingsWriteAuthority(current);
	return current;
}

afterEach(() => setSettingsWriteAuthority(null));

describe('managedSettingsStanding and settingWriteVerdict', () => {
	it('is standalone when not enrolled (or unprotected with no file) and admits every key', () => {
		const standing = managedSettingsStanding({ enrolled: false, policy: null, installed: null });
		expect(standing).toEqual({ standing: 'standalone' });
		expect(settingWriteVerdict(standing, 'ghPath')).toEqual({ allowed: true });
		expect(source({ status: 'unprotected', fileExists: false } as never).standing()).toEqual({
			standing: 'standalone',
		});
	});

	it('names why a managed host has no usable policy and refuses only lockable keys', () => {
		const none = managedSettingsStanding({ enrolled: true, policy: null, installed: null });
		expect(settingWriteVerdict(none, 'shellEnvVars')).toEqual({
			allowed: false,
			code: 'unavailable',
			message:
				'the "shellEnvVars" setting is held by managed policy and the managed settings policy is unavailable (no applied policy revision is known for this host)',
			policyRevision: null,
		});
		expect(settingWriteVerdict(none, 'fontSize')).toEqual({ allowed: true });
		expect(source(enrolled, 4).standing()).toMatchObject({
			reason: 'no settings policy is installed for policy revision 4',
		});
		const stale = source(enrolled, 4);
		stale.install(document());
		expect(stale.standing()).toMatchObject({
			policy: null,
			reason:
				'the installed settings policy is for policy revision 3; this host is under revision 4',
		});
		const withFile = source({ status: 'unprotected', fileExists: true } as never);
		expect(withFile.authorize('ghPath')).toMatchObject({ code: 'unavailable' });
	});

	it('holds a locked key by the lock model reason and admits the rest', () => {
		const current = installed();
		expect(current.authorize('ghPath')).toEqual({
			allowed: false,
			code: 'locked',
			message: 'the "ghPath" setting is locked and pinned by managed policy revision 3',
			policyRevision: 3,
		});
		expect(current.authorize('webAuthEnabled')).toMatchObject({
			message: 'the "webAuthEnabled" setting is locked by managed policy revision 3',
		});
		expect(current.authorize('shellEnvVars')).toEqual({ allowed: true });
		expect(current.authorize('fontSize')).toEqual({ allowed: true });
	});

	it('refuses a credential the plain settings file would keep on every managed host (MRC2-06-06)', () => {
		const none = managedSettingsStanding({ enrolled: true, policy: null, installed: null });
		expect(settingWriteVerdict(none, 'wakatimeApiKey')).toEqual({
			allowed: false,
			code: 'custody',
			message:
				'the WakaTime API key is not kept on this managed host: maestro-settings.json is a readable file, and a managed host keeps a credential only under the OS key store.',
			policyRevision: null,
		});
		expect(installed().authorize('wakatimeApiKey')).toMatchObject({
			code: 'custody',
			policyRevision: 3,
		});
		expect(() => guardSettingsStore(fakeStore({})).set('wakatimeApiKey', 'k')).toThrow(
			ManagedSettingLockedError
		);
		expect(settingWriteVerdict({ standing: 'standalone' }, 'wakatimeApiKey')).toEqual({
			allowed: true,
		});
	});

	it('keeps the previous policy on a refused document and hears every change', () => {
		const current = source();
		const heard = vi.fn();
		current.onChange(heard);
		current.install(document());
		expect(current.install(document({ locks: [{ key: 'fontSize' }] }))).toEqual({
			installed: false,
			problems: ['locks[0].key is not a lockable setting key'],
		});
		expect(current.installed()?.policyRevision).toBe(3);
		current.clear();
		expect(current.pins()).toBeNull();
		expect(heard).toHaveBeenCalledTimes(2);
	});
});

describe('holdSettingWrite and guardSettingsStore', () => {
	it('admits every write with no authority composed (standalone), dotted keys included', () => {
		const store = guardSettingsStore(fakeStore({ ghPath: '/usr/bin/gh' }));
		store.set('ghPath', '/x');
		store.set({ ghPath: '/y', fontSize: 12 });
		store.delete('ghPath');
		store.reset('ghPath');
		store.clear();
		expect(store.writes).toHaveLength(5);
		expect(holdSettingWrite('shellEnvVars.PATH')).toEqual({ allowed: true });
	});

	it('refuses a direct write to a held key by name and writes nothing, even beside admitted keys', () => {
		installed();
		const store = guardSettingsStore(fakeStore({ ghPath: '/usr/bin/gh', fontSize: 14 }));
		expect(() => store.set('ghPath', '/x')).toThrow(ManagedSettingLockedError);
		expect(() => store.set({ fontSize: 12, ghPath: '/x' })).toThrow(
			'the "ghPath" setting is locked and pinned by managed policy revision 3'
		);
		expect(() => store.delete('webAuthEnabled')).toThrow(ManagedSettingLockedError);
		expect(() => store.reset('fontSize', 'ghPath')).toThrow(ManagedSettingLockedError);
		expect(() => store.clear()).toThrow(ManagedSettingLockedError);
		expect(store.writes).toEqual([]);
		store.set('fontSize', 12);
		store.set('shellEnvVars.PATH', '/bin');
		expect(store.writes).toHaveLength(2);
		expect(holdSettingWrite('ghPath.nested')).toMatchObject({ code: 'locked' });
	});

	it('restores pinned values through the unguarded setter and nothing else', () => {
		const current = installed();
		const store = guardSettingsStore(fakeStore({ ghPath: '/usr/bin/gh', webAuthEnabled: true }));
		expect(restoreManagedSettingPins(store, current.pins())).toEqual(['ghPath']);
		expect(store.store).toEqual({ ghPath: '/opt/managed/gh', webAuthEnabled: true });
		expect(restoreManagedSettingPins(store, current.pins())).toEqual([]);
		expect(store.writes).toEqual([['ghPath', '/opt/managed/gh']]);
	});
});

describe('the bridge set_setting handler', () => {
	it('refuses a held key by the stable reason, state and code, and never reaches the renderer', () => {
		installed(document({ locks: [{ key: 'encoreFeatures' }] }));
		const ctx = { send: vi.fn(), sendError: vi.fn(), callbacks: { setSetting: vi.fn() } };
		const client = { cli: true } as never;
		const send = (key: string, value: unknown) =>
			handleSetSetting(ctx as unknown as MessageHandlerContext, client, {
				type: 'set_setting',
				key,
				value,
			} as never);
		send('encoreFeatures', { cue: false });
		expect(ctx.sendError).toHaveBeenCalledWith(
			client,
			'the "encoreFeatures" setting is locked by managed policy revision 3',
			{ key: 'encoreFeatures', managed: { state: 'denied', code: 'locked' } }
		);
		expect(ctx.callbacks.setSetting).not.toHaveBeenCalled();
		ctx.callbacks.setSetting.mockResolvedValue(true);
		send('fontSize', 12);
		expect(ctx.callbacks.setSetting).toHaveBeenCalledWith('fontSize', 12);
		expect(ctx.sendError).toHaveBeenCalledTimes(1);
	});

	it('admits a lockable top-level key from the CLI alone, so settings set|reset reaches the hold (MRC2-06-03B)', () => {
		const ctx = { send: vi.fn(), sendError: vi.fn(), callbacks: { setSetting: vi.fn() } };
		ctx.callbacks.setSetting.mockResolvedValue(true);
		const send = (client: unknown, key: string, requestId?: string) =>
			handleSetSetting(
				ctx as unknown as MessageHandlerContext,
				client as never,
				{
					type: 'set_setting',
					key,
					value: '/opt/gh',
					requestId,
				} as never
			);
		// Standalone: the CLI's write of a lockable key goes to the renderer.
		send({ cli: true }, 'ghPath');
		expect(ctx.callbacks.setSetting).toHaveBeenCalledWith('ghPath', '/opt/gh');
		// A browser, a dotted path and an agentConfig lock key keep the allowlist.
		for (const [client, key] of [
			[{ cli: false }, 'ghPath'],
			[{ cli: true }, 'ghPath.nested'],
			[{ cli: true }, 'agentConfig.customPath'],
		] as const) {
			send(client, key, 'r-1');
			expect(ctx.sendError).toHaveBeenLastCalledWith(
				client,
				`Setting key '${key}' is not modifiable from the web interface`,
				{ requestId: 'r-1' }
			);
		}
		expect(ctx.callbacks.setSetting).toHaveBeenCalledTimes(1);
		// Held: the refusal frame carries the request id, so the CLI's call settles on it.
		installed(document({ locks: [{ key: 'ghPath' }] }));
		send({ cli: true }, 'ghPath', 'r-2');
		expect(ctx.sendError).toHaveBeenLastCalledWith(
			{ cli: true },
			'the "ghPath" setting is locked by managed policy revision 3',
			{ key: 'ghPath', managed: { state: 'denied', code: 'locked' }, requestId: 'r-2' }
		);
		expect(ctx.callbacks.setSetting).toHaveBeenCalledTimes(1);
	});
});

describe('agentConfigWriteVerdict and holdAgentConfigWrite (MRC2-06-03)', () => {
	const standalone = managedSettingsStanding({ enrolled: false, policy: null, installed: null });
	const none = managedSettingsStanding({ enrolled: true, policy: null, installed: null });

	it('admits every field standalone and with no authority composed, and a field no policy may hold anywhere', () => {
		expect(agentConfigWriteVerdict(standalone, 'codex', 'customArgs', '--api-key k')).toEqual({
			allowed: true,
		});
		expect(agentConfigWriteVerdict(none, 'codex', 'contextWindow', 9)).toEqual({ allowed: true });
		expect(holdAgentConfigWrite('claude-code', 'customPath', '/x')).toEqual({ allowed: true });
	});

	it('refuses every held field unavailable with no usable policy, by the field name', () => {
		expect(agentConfigWriteVerdict(none, 'codex', 'model', 'gpt-5')).toEqual({
			allowed: false,
			code: 'unavailable',
			message:
				'the "agentConfig.model" setting is held by managed policy and the managed settings policy is unavailable (no applied policy revision is known for this host)',
			policyRevision: null,
		});
	});

	it('holds a locked field by the lock reason, then an admitted one to the provider ceiling', () => {
		const current = installed(
			document({ locks: [{ key: 'agentConfig.customPath' }, { key: 'agentConfig.model' }] })
		);
		expect(current.authorizeAgentConfig('codex', 'customPath', null)).toEqual({
			allowed: false,
			code: 'locked',
			message: 'the "agentConfig.customPath" setting is locked by managed policy revision 3',
			policyRevision: 3,
		});
		expect(holdAgentConfigWrite('codex', 'reasoningEffort', 'high')).toEqual({ allowed: true });
		expect(holdAgentConfigWrite('codex', 'customArgs', '--sandbox read-only -m o3')).toEqual({
			allowed: true,
		});
		expect(holdAgentConfigWrite('codex', 'customArgs', '--api-key sk -c model_provider=x')).toEqual(
			{
				allowed: false,
				code: 'ceiling',
				message:
					'the customArgs configuration of codex would route around the managed provider ceiling: --api-key is not allowed under management; -c model_provider is not allowed under management',
				policyRevision: 3,
			}
		);
		expect(
			holdAgentConfigWrite('claude-code', 'customArgs', '--settings {"env":{"A":"1"},"model":"m"}')
		).toMatchObject({ code: 'ceiling' });
		expect(holdAgentConfigWrite('claude-code', 'customEnvVars', { EDITOR: 'vi' })).toEqual({
			allowed: true,
		});
		expect(
			holdAgentConfigWrite('claude-code', 'customEnvVars', {
				ANTHROPIC_API_KEY: 'k',
				MAESTRO_MANAGED_LEASE: 'l',
				OPENAI_BASE_URL: 'u',
				HOME: '/h',
			})
		).toMatchObject({
			code: 'ceiling',
			message:
				'the customEnvVars configuration of claude-code would route around the managed provider ceiling: ANTHROPIC_API_KEY is removed by the managed environment ceiling at launch; MAESTRO_MANAGED_LEASE is removed by the managed environment ceiling at launch; OPENAI_BASE_URL is removed by the managed environment ceiling at launch',
		});
	});
});

describe('the bridge update_session_config handler', () => {
	const client = { cli: true } as never;
	const ctxOf = () => ({
		send: vi.fn(),
		sendError: vi.fn(),
		callbacks: {
			updateSessionConfig: vi.fn().mockResolvedValue({ success: true }),
			getSessions: () => [{ id: 'a1', toolType: 'codex' }],
		},
	});
	const send = (ctx: ReturnType<typeof ctxOf>, configPatch: Record<string, unknown>) =>
		handleUpdateSessionConfig(ctx as unknown as MessageHandlerContext, client, {
			type: 'update_session_config',
			sessionId: 'a1',
			requestId: 'r1',
			configPatch,
		} as never);

	it('refuses a held field of the record as a typed result and never reaches the renderer', () => {
		installed(document({ locks: [{ key: 'agentConfig.customEnvVars' }] }));
		const ctx = ctxOf();
		send(ctx, { nudgeMessage: 'hi', customEnvVars: { A: '1' } });
		expect(ctx.send).toHaveBeenCalledWith(client, {
			type: 'update_session_config_result',
			success: false,
			error: 'the "agentConfig.customEnvVars" setting is locked by managed policy revision 3',
			sessionId: 'a1',
			requestId: 'r1',
			managed: { state: 'denied', code: 'locked' },
		});
		send(ctx, { customModel: 'o3', customArgs: '--base-url http://x' });
		expect(ctx.send).toHaveBeenLastCalledWith(
			client,
			expect.objectContaining({ success: false, managed: { state: 'denied', code: 'ceiling' } })
		);
		expect(ctx.callbacks.updateSessionConfig).not.toHaveBeenCalled();
		send(ctx, { nudgeMessage: 'hi', customModel: 'o3', customEffort: null });
		expect(ctx.callbacks.updateSessionConfig).toHaveBeenCalledWith('a1', {
			nudgeMessage: 'hi',
			customModel: 'o3',
			customEffort: null,
		});
	});

	it('answers unavailable on an enrolled host with no policy and passes everything standalone', () => {
		setSettingsWriteAuthority(source(enrolled, null));
		const ctx = ctxOf();
		send(ctx, { customPath: '/bin/codex' });
		expect(ctx.send).toHaveBeenCalledWith(
			client,
			expect.objectContaining({ managed: { state: 'unavailable', code: 'unavailable' } })
		);
		setSettingsWriteAuthority(null);
		send(ctx, { customPath: '/bin/codex', customEnvVars: { ANTHROPIC_API_KEY: 'k' } });
		expect(ctx.callbacks.updateSessionConfig).toHaveBeenCalledTimes(1);
	});
});

describe('the admin sets: holdPromptSetWrite and holdPluginSetWrite (MRC2-06-04)', () => {
	const PLUGINS = 'plugins.installed';
	const install = (pluginId: string) => ({ op: 'install' as const, pluginId });
	const uninstall = (pluginId: string) => ({ op: 'uninstall' as const, pluginId });

	it('admits everything standalone and refuses both sets unavailable with no usable policy', () => {
		expect(holdPromptSetWrite()).toEqual({ allowed: true });
		expect(holdPluginSetWrite(install('x'))).toEqual({ allowed: true });
		setSettingsWriteAuthority(source(enrolled, null));
		expect(holdPromptSetWrite()).toMatchObject({ code: 'unavailable' });
		expect(holdPluginSetWrite(uninstall('x'))).toMatchObject({ code: 'unavailable' });
		expect(holdPluginSetWrite({ op: 'update' })).toMatchObject({ code: 'unavailable' });
	});

	it('holds a locked set outright, and a pinned plugin set to its ids', () => {
		const current = installed(
			document({
				locks: [{ key: 'prompts.customizations' }, { key: PLUGINS, pin: { value: ['kept'] } }],
			})
		);
		expect(holdPromptSetWrite()).toMatchObject({
			code: 'locked',
			message: 'the "prompts.customizations" setting is locked by managed policy revision 3',
		});
		expect(holdPluginSetWrite(install('kept'))).toEqual({ allowed: true });
		expect(holdPluginSetWrite(install('other'))).toMatchObject({
			code: 'locked',
			message: 'plugin "other" is not in the plugin set pinned by managed policy revision 3',
		});
		expect(holdPluginSetWrite(uninstall('kept'))).toMatchObject({
			message: 'plugin "kept" is in the plugin set pinned by managed policy revision 3',
		});
		expect(holdPluginSetWrite(uninstall('other'))).toEqual({ allowed: true });
		expect(holdPluginSetWrite({ op: 'update' })).toEqual({ allowed: true });
		const lock = settingWriteVerdict(current.standing(), PLUGINS);
		expect(pluginSetVerdict(lock, null, { op: 'update' })).toBe(lock);
		// The pins are not settings values: the store restorer leaves them alone.
		const store = guardSettingsStore(fakeStore({ ghPath: '/gh' }));
		expect(restoreManagedSettingPins(store, current.pins())).toEqual([]);
		expect(store.writes).toEqual([]);
	});
});

describe('holdManagedKey (MRC2-06-04A)', () => {
	it('admits standalone and an unlocked key, refuses unavailable with no usable policy and locked under a lock', () => {
		expect(holdManagedKey('web.tunnel')).toEqual({ allowed: true });
		setSettingsWriteAuthority(source(enrolled, null));
		expect(holdManagedKey('lite.control')).toMatchObject({ code: 'unavailable' });
		installed(
			document({
				locks: [{ key: 'web.liveSessions' }, { key: 'storage.syncPath', pin: { value: null } }],
			})
		);
		expect(holdManagedKey('web.liveSessions')).toMatchObject({
			code: 'locked',
			message: 'the "web.liveSessions" setting is locked by managed policy revision 3',
		});
		expect(holdManagedKey('storage.syncPath')).toMatchObject({ code: 'locked' });
		expect(holdManagedKey('web.tunnel')).toEqual({ allowed: true });
	});
});

describe('readManagedSettingLocks (MRC2-06-05)', () => {
	it('names nothing standalone, every key unavailable with no usable policy, and the held keys with their line and pin', () => {
		const none = { policyRevision: null, locks: {} };
		expect(readManagedSettingLocks()).toEqual(none);
		setSettingsWriteAuthority(source({ status: 'none' } as IdentityRead));
		expect(readManagedSettingLocks()).toEqual(none);
		setSettingsWriteAuthority(source(enrolled, null));
		const unavailable = readManagedSettingLocks();
		expect(unavailable.policyRevision).toBeNull();
		expect(Object.keys(unavailable.locks)).toEqual([...MANAGED_LOCK_KEYS]);
		expect(unavailable.locks.ghPath).toMatchObject({ code: 'unavailable', pinned: false });
		installed();
		expect(readManagedSettingLocks()).toEqual({
			policyRevision: 3,
			locks: {
				ghPath: {
					code: 'locked',
					message: 'the "ghPath" setting is locked and pinned by managed policy revision 3',
					pinned: true,
				},
				webAuthEnabled: {
					code: 'locked',
					message: 'the "webAuthEnabled" setting is locked by managed policy revision 3',
					pinned: false,
				},
			},
		});
	});
});

describe('Encore flag pins (MRC2-07-06)', () => {
	const pinned = () =>
		installed(document({ locks: [{ key: 'encore.plugins', pin: { value: false } }] }));
	const line = 'the "encore.plugins" setting is locked and pinned by managed policy revision 3';

	it('holds a write of encoreFeatures by value: a flipped pin is refused, a kept pin admitted', () => {
		pinned();
		expect(holdSettingWrite('encoreFeatures')).toEqual({ allowed: true });
		expect(holdSettingWrite('encoreFeatures', { value: { plugins: true } })).toMatchObject({
			code: 'locked',
			message: line,
			policyRevision: 3,
		});
		expect(
			holdSettingWrite('encoreFeatures', { value: { plugins: false, symphony: false } })
		).toEqual({ allowed: true });
		expect(holdSettingWrite('encoreFeatures.plugins', { value: true })).toMatchObject({
			code: 'locked',
			message: line,
		});
		expect(holdSettingWrite('encoreFeatures.symphony', { value: true })).toEqual({
			allowed: true,
		});
		// The key itself is held by its own name, never split at the dot.
		expect(holdManagedKey('encore.plugins')).toMatchObject({ code: 'locked', message: line });
		expect(holdSettingWrite('encore.plugins')).toEqual({ allowed: true });
	});

	it('guards the store by value and restores the pin into the stored object', () => {
		const current = pinned();
		const store = guardSettingsStore(
			fakeStore({ encoreFeatures: { plugins: true, symphony: false } })
		);
		expect(() => store.set('encoreFeatures', { plugins: true })).toThrow(line);
		expect(() => store.set({ encoreFeatures: { plugins: true }, fontSize: 1 })).toThrow(
			ManagedSettingLockedError
		);
		store.set('encoreFeatures', { plugins: false, symphony: true });
		expect(store.writes).toEqual([['encoreFeatures', { plugins: false, symphony: true }]]);
		// A removal falls back to the default (off): admitted under this pin.
		store.delete('encoreFeatures');
		expect(restoreManagedSettingPins(store, current.pins())).toEqual([]);
		store.store.encoreFeatures = { plugins: true };
		expect(restoreManagedSettingPins(store, current.pins())).toEqual(['encore.plugins']);
		expect(store.store.encoreFeatures).toEqual({ plugins: false });
		expect(store.writes.at(-1)).toEqual(['encoreFeatures', { plugins: false }]);
	});

	it('shows the pin on the locks view, by key and by flag', () => {
		pinned();
		const view = readManagedSettingLocks();
		expect(view.locks['encore.plugins']).toEqual({ code: 'locked', message: line, pinned: true });
		expect(view.encorePins).toEqual({ plugins: false });
		installed();
		expect(readManagedSettingLocks().encorePins).toBeUndefined();
	});
});
