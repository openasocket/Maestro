/**
 * One per-provider configuration write, shared by the agents:setConfigValue
 * IPC handler and the bridge's set_agent_config_value / reset_agent_config_value
 * (MRC2-06-03A): held once, a refusal typed, standalone unchanged. The
 * exhaustive lock cases are MRC2-06-08's.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	applyAgentConfigWrite,
	applyAgentConfigWriteStrict,
	type AgentConfigsStore,
} from '../../../main/agents/agent-config-writes';
import type { IdentityRead } from '../../../main/enterprise/identity-store';
import {
	ManagedSettingLockedError,
	createSettingsPolicySource,
	setSettingsWriteAuthority,
	type SettingsWriteAuthority,
} from '../../../main/enterprise/settings-policy';
import { handleAgentConfigValueWrite } from '../../../main/web-server/handlers/messageHandlers/settings';
import type { MessageHandlerContext } from '../../../main/web-server/handlers/messageHandlers/types';

function fakeStore(configs: Record<string, Record<string, unknown>>) {
	const sets: unknown[] = [];
	const store = {
		get: () => configs,
		set: (_key: string, value: unknown) => void sets.push(structuredClone(value)),
	} as unknown as AgentConfigsStore;
	return { store, sets };
}

/** Holds customPath (locked) and admits the rest. */
const authority: SettingsWriteAuthority = {
	authorize: () => ({ allowed: true }),
	authorizeAgentConfig: (providerId, field) =>
		field === 'customPath'
			? {
					allowed: false,
					code: 'locked',
					message: `the "agentConfig.customPath" setting is locked by managed policy revision 5 (${providerId})`,
					policyRevision: 5,
				}
			: { allowed: true },
	pins: () => null,
};
const set = (providerId: string, key: string, value: unknown) =>
	({ op: 'set', providerId, key, value }) as const;
const reset = (providerId: string, key: string) => ({ op: 'reset', providerId, key }) as const;

afterEach(() => setSettingsWriteAuthority(null));

describe('applyAgentConfigWrite (MRC2-06-03A)', () => {
	it('standalone: sets, resets (dropping an emptied provider), and a missing key says so', () => {
		const { store, sets } = fakeStore({ codex: { model: 'old' } });
		expect(applyAgentConfigWrite(store, set('codex', 'model', 'x'))).toEqual({
			success: true,
			previous: 'old',
		});
		expect(applyAgentConfigWrite(store, set('pi', 'contextWindow', 9))).toMatchObject({
			success: true,
		});
		expect(applyAgentConfigWrite(store, reset('codex', 'model'))).toEqual({
			success: true,
			previous: 'x',
			removed: true,
		});
		expect(applyAgentConfigWrite(store, reset('codex', 'model'))).toMatchObject({ removed: false });
		expect(sets).toEqual([
			{ codex: { model: 'x' } },
			{ codex: { model: 'x' }, pi: { contextWindow: 9 } },
			{ pi: { contextWindow: 9 } },
		]);
	});

	it('refuses a held field as a typed outcome, set or reset, writes nothing; the strict spelling throws by name', () => {
		setSettingsWriteAuthority(authority);
		const { store, sets } = fakeStore({ codex: { customPath: '/old' } });
		expect(applyAgentConfigWrite(store, set('codex', 'customPath', '/x'))).toEqual({
			success: false,
			error: 'the "agentConfig.customPath" setting is locked by managed policy revision 5 (codex)',
			managed: { state: 'denied', code: 'locked', policyRevision: 5 },
		});
		expect(applyAgentConfigWrite(store, reset('codex', 'customPath')).success).toBe(false);
		expect(() => applyAgentConfigWriteStrict(store, reset('codex', 'customPath'))).toThrow(
			ManagedSettingLockedError
		);
		expect(() => applyAgentConfigWriteStrict(store, set('codex', 'customPath', '/x'))).toThrow(
			expect.objectContaining({ key: 'agentConfig.customPath', code: 'locked' })
		);
		expect(sets).toEqual([]);
		expect(applyAgentConfigWriteStrict(store, set('codex', 'model', 'm')).previous).toBeUndefined();
		expect(sets).toHaveLength(1);
	});
});

describe('bridge set_agent_config_value / reset_agent_config_value', () => {
	it('is CLI only, then answers the typed result of the one write as it is', async () => {
		const ctx = {
			send: vi.fn(),
			sendError: vi.fn(),
			callbacks: { writeAgentConfigValue: vi.fn() },
		};
		const cli = { cli: true } as never;
		const send = (client: unknown, op: 'set' | 'reset', message: Record<string, unknown>) =>
			handleAgentConfigValueWrite(
				ctx as unknown as MessageHandlerContext,
				client as never,
				{ type: `${op}_agent_config_value`, requestId: 'r1', ...message } as never,
				op
			);
		send({ cli: false }, 'set', { providerId: 'codex', key: 'model', value: 'x' });
		expect(ctx.sendError).toHaveBeenCalledWith(
			{ cli: false },
			'Provider configuration is written from maestro-cli only'
		);
		expect(ctx.callbacks.writeAgentConfigValue).not.toHaveBeenCalled();

		ctx.callbacks.writeAgentConfigValue.mockResolvedValueOnce({ success: true, previous: 'old' });
		send(cli, 'set', { providerId: 'codex', key: 'model', value: 'x' });
		await vi.waitFor(() => expect(ctx.send).toHaveBeenCalledTimes(1));
		expect(ctx.callbacks.writeAgentConfigValue).toHaveBeenCalledWith(set('codex', 'model', 'x'));
		expect(ctx.send).toHaveBeenCalledWith(cli, {
			type: 'set_agent_config_value_result',
			providerId: 'codex',
			key: 'model',
			requestId: 'r1',
			success: true,
			previous: 'old',
		});
		const refused = {
			success: false,
			error: 'locked',
			managed: { state: 'denied', code: 'locked' },
		};
		ctx.callbacks.writeAgentConfigValue.mockResolvedValueOnce(refused);
		send(cli, 'reset', { providerId: 'codex', key: 'customPath' });
		await vi.waitFor(() => expect(ctx.send).toHaveBeenCalledTimes(2));
		expect(ctx.send).toHaveBeenLastCalledWith(
			cli,
			expect.objectContaining({ type: 'reset_agent_config_value_result', ...refused })
		);
	});
});

/**
 * GT1-09-05: Grok writes through the one store writer under a real installed
 * settings policy source. Only the identity read is a synthetic fixture (an
 * enrolled host); every secret is the literal string 'synthetic'.
 */
describe('Grok configuration writes under a managed policy (GT1-09-05)', () => {
	const enrolled = { status: 'ok', record: {}, fileExists: true } as unknown as IdentityRead;
	function managed(locks: unknown[] | null) {
		const source = createSettingsPolicySource({
			identity: { read: () => enrolled },
			policy: () => (locks === null ? null : { appliedRevision: 7 }),
		});
		if (locks !== null)
			expect(source.install({ policyRevision: 7, locks })).toMatchObject({
				installed: true,
			});
		setSettingsWriteAuthority(source);
	}
	const stored = () => ({
		grok: {
			model: 'grok-managed',
			reasoningEffort: 'high',
			customEnvVars: { EDITOR: 'vi' },
			customArgs: '--permission-mode plan',
		},
		codex: { model: 'o3' },
	});

	it('standalone: every Grok field, an unknown key included, persists exactly as written', () => {
		const { store, sets } = fakeStore(stored());
		for (const [key, value] of [
			['model', 'grok-4'],
			['customArgs', '--always-approve -m grok-4'],
			['customEnvVars', { XAI_API_KEY: 'synthetic', GROK_HOME: '/h' }],
			['fooBar', { nested: true }],
		] as const)
			expect(applyAgentConfigWrite(store, set('grok', key, value)).success).toBe(true);
		expect(sets.at(-1)).toEqual({
			grok: {
				model: 'grok-4',
				reasoningEffort: 'high',
				customEnvVars: { XAI_API_KEY: 'synthetic', GROK_HOME: '/h' },
				customArgs: '--always-approve -m grok-4',
				fooBar: { nested: true },
			},
			codex: { model: 'o3' },
		});
	});

	it('refuses locked Grok fields, set or reset, and persists nothing', () => {
		managed([
			{ key: 'agentConfig.model' },
			{ key: 'agentConfig.reasoningEffort' },
			{ key: 'agentConfig.customPath' },
		]);
		const { store, sets } = fakeStore(stored());
		expect(applyAgentConfigWrite(store, set('grok', 'model', 'grok-4'))).toEqual({
			success: false,
			error: 'the "agentConfig.model" setting is locked by managed policy revision 7',
			managed: { state: 'denied', code: 'locked', policyRevision: 7 },
		});
		expect(applyAgentConfigWrite(store, reset('grok', 'model')).success).toBe(false);
		expect(applyAgentConfigWrite(store, reset('grok', 'reasoningEffort')).success).toBe(false);
		expect(applyAgentConfigWrite(store, set('grok', 'customPath', '/tmp/grok')).success).toBe(
			false
		);
		expect(() => applyAgentConfigWriteStrict(store, set('grok', 'reasoningEffort', 'low'))).toThrow(
			expect.objectContaining({ key: 'agentConfig.reasoningEffort', code: 'locked' })
		);
		expect(sets).toEqual([]);
		expect(store.get('configs', {})).toEqual(stored());
	});

	it('refuses a Grok credential, account or endpoint write as ceiling and keeps no secret', () => {
		managed([]);
		const { store, sets } = fakeStore(stored());
		for (const env of [
			{ EDITOR: 'vi', XAI_API_KEY: 'synthetic' },
			{ GROK_AUTH: 'synthetic' },
			{ GROK_AUTH_PATH: '/synthetic/auth.json' },
			{ GROK_HOME: '/other-account' },
			{ GROK_XAI_API_BASE_URL: 'https://synthetic.invalid' },
		])
			expect(applyAgentConfigWrite(store, set('grok', 'customEnvVars', env))).toMatchObject({
				success: false,
				managed: { state: 'denied', code: 'ceiling', policyRevision: 7 },
			});
		expect(() =>
			applyAgentConfigWriteStrict(store, set('grok', 'customArgs', '--api-key synthetic'))
		).toThrow(expect.objectContaining({ key: 'agentConfig.customArgs', code: 'ceiling' }));
		expect(sets).toEqual([]);
		expect(JSON.stringify(store.get('configs', {}))).not.toContain('synthetic');
	});

	it('admits unmanaged Grok writes and unknown keys verbatim, beside a lock', () => {
		managed([{ key: 'agentConfig.model' }]);
		const { store, sets } = fakeStore(stored());
		expect(applyAgentConfigWrite(store, set('grok', 'customEnvVars', { EDITOR: 'nano' }))).toEqual({
			success: true,
			previous: { EDITOR: 'vi' },
		});
		expect(applyAgentConfigWrite(store, set('grok', 'contextWindow', 256000)).success).toBe(true);
		expect(applyAgentConfigWrite(store, set('grok', 'fooBar', 'kept')).success).toBe(true);
		expect(applyAgentConfigWrite(store, reset('grok', 'customArgs'))).toMatchObject({
			success: true,
			removed: true,
		});
		expect(sets.at(-1)).toEqual({
			grok: {
				model: 'grok-managed',
				reasoningEffort: 'high',
				customEnvVars: { EDITOR: 'nano' },
				contextWindow: 256000,
				fooBar: 'kept',
			},
			codex: { model: 'o3' },
		});
	});

	it('refuses held Grok fields unavailable on an enrolled host with no applied policy', () => {
		managed(null);
		const { store, sets } = fakeStore(stored());
		expect(
			applyAgentConfigWrite(store, set('grok', 'customEnvVars', { EDITOR: 'nano' }))
		).toMatchObject({
			success: false,
			managed: { state: 'unavailable', code: 'unavailable', policyRevision: null },
		});
		expect(applyAgentConfigWrite(store, set('grok', 'contextWindow', 1)).success).toBe(true);
		expect(sets).toHaveLength(1);
	});
});
