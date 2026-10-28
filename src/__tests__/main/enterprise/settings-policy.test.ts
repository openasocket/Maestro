/**
 * Main-process enforcement of the settings lock model (MRC2-06-02): standing,
 * verdict, source, store guard, pin restoration and the bridge's set_setting.
 * Standalone: unchanged. (The settings:set IPC path is in persistence.test.ts.)
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { IdentityRead } from '../../../main/enterprise/identity-store';
import {
	ManagedSettingLockedError,
	createSettingsPolicySource,
	guardSettingsStore,
	holdSettingWrite,
	managedSettingsStanding,
	restoreManagedSettingPins,
	setSettingsWriteAuthority,
	settingWriteVerdict,
} from '../../../main/enterprise/settings-policy';
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
});
