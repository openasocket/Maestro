/**
 * The per-provider configuration lock on every write sink (MRC2-06-08), over
 * the REAL policy source as the one authority: the agents:setConfig* handlers,
 * the provider ceiling on setConfigValue, the bridge's set_agent_config_value
 * and update_session_config, `maestro-cli settings agent set`; standalone open.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ipcMain } from 'electron';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), removeHandler: vi.fn() } }));
vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../../main/utils/sentry', () => ({ captureException: vi.fn() }));
// The translation archive's TOML codec is never exercised here (as in agents.test.ts).
vi.mock('smol-toml', () => ({ parse: () => ({}), stringify: () => '' }));
vi.mock('../../../../main/agents/path-prober', () => ({
	checkCustomPath: vi.fn(async (requestedPath: string) => ({ exists: true, path: requestedPath })),
}));
// The CLI verb: the file readers are doubles, the desktop is the real bridge handler below.
vi.mock('../../../../cli/services/storage', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../../cli/services/storage')>()),
	readAgentConfigs: vi.fn(() => ({})),
	readAgentConfigValue: vi.fn(),
	writeAgentConfigValue: vi.fn(() => true),
	getSessionById: vi.fn(() => null),
	dataDirHasManagedBinding: vi.fn(() => false),
}));
vi.mock('../../../../cli/services/maestro-client', () => ({ withMaestroClient: vi.fn() }));

import { registerAgentsHandlers } from '../../../../main/ipc/handlers/agents';
import { applyAgentConfigWrite } from '../../../../main/agents/agent-config-writes';
import {
	ManagedSettingLockedError,
	createSettingsPolicySource,
	setSettingsWriteAuthority,
} from '../../../../main/enterprise/settings-policy';
import { handleAgentConfigValueWrite } from '../../../../main/web-server/handlers/messageHandlers/settings';
import { handleUpdateSessionConfig } from '../../../../main/web-server/handlers/messageHandlers/sessions';
import type { MessageHandlerContext } from '../../../../main/web-server/handlers/messageHandlers/types';
import { settingsAgentSet } from '../../../../cli/commands/settings-agent';
import { withMaestroClient } from '../../../../cli/services/maestro-client';
import { writeAgentConfigValue } from '../../../../cli/services/storage';
import { installManagedSettingsPolicy } from '../../../helpers/managedSettingsPolicy';

const CUSTOM_PATH = 'the "agentConfig.customPath" setting is locked by managed policy revision 3';
const MODEL = 'the "agentConfig.model" setting is locked by managed policy revision 3';
const CEILING =
	'the customArgs configuration of codex would route around the managed provider ceiling: --api-key is not allowed under management';

describe('the per-provider configuration lock on every write sink (MRC2-06-08)', () => {
	let handlers: Map<string, (...args: never[]) => unknown>;
	let configs: Record<string, Record<string, unknown>>;
	let store: { get: () => typeof configs; set: ReturnType<typeof vi.fn> };
	let setCustomPaths: ReturnType<typeof vi.fn>;
	const call = (channel: string, ...args: unknown[]) =>
		handlers.get(channel)!({} as never, ...(args as never[])) as Promise<unknown>;
	const setValue = (providerId: string, key: string, value: unknown) =>
		call('agents:setConfigValue', providerId, key, value);
	/** The policy of these cases: path and model locked, arguments and environment left to the ceiling. */
	const policy = () =>
		installManagedSettingsPolicy([{ key: 'agentConfig.customPath' }, { key: 'agentConfig.model' }]);

	beforeEach(() => {
		vi.clearAllMocks();
		handlers = new Map();
		vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
			handlers.set(channel, handler as never);
		});
		configs = { codex: { customPath: '/old' } };
		store = { get: () => configs, set: vi.fn() };
		setCustomPaths = vi.fn();
		registerAgentsHandlers({
			getAgentDetector: () => ({ setCustomPaths, clearCache: vi.fn() }) as never,
			agentConfigsStore: store as never,
		});
	});

	afterEach(() => setSettingsWriteAuthority(null));

	it('refuses a held field by name on setConfigValue, setCustomPath and a whole-config write, writing nothing', async () => {
		policy();
		await expect(setValue('codex', 'customPath', '/x')).rejects.toMatchObject({
			name: 'ManagedSettingLockedError',
			key: 'agentConfig.customPath',
			code: 'locked',
			message: CUSTOM_PATH,
		});
		await expect(call('agents:setCustomPath', 'codex', '/x')).rejects.toThrow(CUSTOM_PATH);
		await expect(setValue('claude-code', 'model', 'opus')).rejects.toThrow(MODEL);
		await expect(
			call('agents:setConfig', 'codex', { customPath: '/old', model: 'o3' })
		).rejects.toThrow(ManagedSettingLockedError);
		expect(store.set).not.toHaveBeenCalled();
		expect(setCustomPaths).not.toHaveBeenCalled();
		// A field the policy does not hold, and a whole-config write that leaves the held fields as they are.
		await expect(setValue('codex', 'contextWindow', 9)).resolves.toBe(true);
		await expect(setValue('codex', 'reasoningEffort', 'high')).resolves.toBe(true);
		await expect(
			call('agents:setConfig', 'codex', { customPath: '/old', contextWindow: 12 })
		).resolves.toBe(true);
		expect(store.set).toHaveBeenCalledTimes(3);
		expect(store.set).toHaveBeenLastCalledWith('configs', {
			codex: { customPath: '/old', contextWindow: 12 },
		});
	});

	it('holds an admitted field to the provider ceiling on setConfigValue, named by provider and field', async () => {
		policy();
		await expect(setValue('codex', 'customArgs', '--api-key sk')).rejects.toMatchObject({
			key: 'agentConfig.customArgs',
			code: 'ceiling',
			message: CEILING,
		});
		await expect(
			setValue('claude-code', 'customEnvVars', { ANTHROPIC_API_KEY: 'k', EDITOR: 'vi' })
		).rejects.toThrow(
			'the customEnvVars configuration of claude-code would route around the managed provider ceiling: ANTHROPIC_API_KEY is removed by the managed environment ceiling at launch'
		);
		await expect(
			call('agents:setCustomEnvVars', 'codex', { MAESTRO_MANAGED_LEASE: 'l' })
		).rejects.toMatchObject({ code: 'ceiling' });
		expect(store.set).not.toHaveBeenCalled();
		await expect(setValue('codex', 'customArgs', '--sandbox read-only')).resolves.toBe(true);
		await expect(call('agents:setCustomEnvVars', 'codex', { EDITOR: 'vi' })).resolves.toBe(true);
		expect(store.set).toHaveBeenCalledTimes(2);
	});

	it('the bridge set_agent_config_value, update_session_config and maestro-cli settings agent set are refused through the one write', async () => {
		policy();
		const frames: Record<string, unknown>[] = [];
		const ctx = {
			send: (_client: unknown, frame: Record<string, unknown>) => void frames.push(frame),
			sendError: (_client: unknown, message: string) =>
				void frames.push({ type: 'error', message }),
			callbacks: {
				// The desktop's callback: the one write over the same store the IPC handlers hold.
				writeAgentConfigValue: async (request: never) =>
					applyAgentConfigWrite(store as never, request),
				updateSessionConfig: vi.fn().mockResolvedValue({ success: true }),
				getSessions: () => [{ id: 'a1', toolType: 'codex' }],
			},
		} as unknown as MessageHandlerContext;
		const cli = { cli: true } as never;
		// update-agent's patch of the agent's own record: a held field refused as a typed result.
		handleUpdateSessionConfig(ctx, cli, {
			type: 'update_session_config',
			sessionId: 'a1',
			configPatch: { customModel: 'o3' },
		} as never);
		expect(frames).toEqual([
			expect.objectContaining({
				success: false,
				error: MODEL,
				managed: { state: 'denied', code: 'locked' },
			}),
		]);
		expect(ctx.callbacks.updateSessionConfig).not.toHaveBeenCalled();
		// settings agent set, with the desktop's handler as the client's far end.
		const sendCommand = vi.fn(async (message: Record<string, unknown>) => {
			const before = frames.length;
			handleAgentConfigValueWrite(ctx, cli, message as never, message.op as 'set');
			await vi.waitFor(() => expect(frames.length).toBe(before + 1));
			return frames[before];
		});
		vi.mocked(withMaestroClient).mockImplementation(async (action) =>
			action({ sendCommand } as never)
		);
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(process, 'exit').mockImplementation((code) => {
			throw new Error(`process.exit(${code})`);
		});
		try {
			await expect(
				settingsAgentSet('codex', 'customPath', '/opt/codex', { json: true })
			).rejects.toThrow('process.exit(1)');
			expect(JSON.parse(String(errorSpy.mock.calls[0][0]))).toEqual({
				error: CUSTOM_PATH,
				managed: { state: 'denied', code: 'locked', policyRevision: 3 },
			});
			await expect(
				settingsAgentSet('codex', 'customArgs', '--api-key sk', { json: true })
			).rejects.toThrow('process.exit(1)');
			expect(JSON.parse(String(errorSpy.mock.calls[1][0]))).toMatchObject({
				error: CEILING,
				managed: { state: 'denied', code: 'ceiling' },
			});
			expect(store.set).not.toHaveBeenCalled();
			await settingsAgentSet('codex', 'contextWindow', '128000', { json: true });
			expect(frames[3]).toMatchObject({ type: 'set_agent_config_value_result', success: true });
			expect(store.set).toHaveBeenCalledWith('configs', {
				codex: { customPath: '/old', contextWindow: 128000 },
			});
			expect(writeAgentConfigValue).not.toHaveBeenCalled();
		} finally {
			vi.restoreAllMocks();
		}
	});

	it('holds every field unavailable on an enrolled host with no usable policy, and admits everything standalone', async () => {
		setSettingsWriteAuthority(
			createSettingsPolicySource({
				identity: { read: () => ({ status: 'ok', record: {}, fileExists: true }) as never },
				policy: () => null,
			})
		);
		await expect(setValue('codex', 'model', 'o3')).rejects.toMatchObject({
			code: 'unavailable',
			message:
				'the "agentConfig.model" setting is held by managed policy and the managed settings policy is unavailable (no applied policy revision is known for this host)',
		});
		await expect(call('agents:setCustomArgs', 'codex', '--verbose')).rejects.toMatchObject({
			key: 'agentConfig.customArgs',
			code: 'unavailable',
		});
		await expect(setValue('codex', 'contextWindow', 9)).resolves.toBe(true);
		expect(store.set).toHaveBeenCalledTimes(1);
		setSettingsWriteAuthority(null);
		await expect(setValue('codex', 'customPath', '/x')).resolves.toBe(true);
		await expect(setValue('codex', 'customArgs', '--api-key sk')).resolves.toBe(true);
		await expect(
			call('agents:setCustomEnvVars', 'claude-code', { ANTHROPIC_API_KEY: 'k' })
		).resolves.toBe(true);
		expect(store.set).toHaveBeenCalledTimes(4);
	});
});
