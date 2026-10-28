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
import {
	ManagedSettingLockedError,
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
