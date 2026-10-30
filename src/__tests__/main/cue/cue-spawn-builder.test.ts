/**
 * Tests for the Cue Spawn Builder.
 *
 * Verifies spawn spec construction: agent definition lookup, arg building,
 * config overrides, SSH wrapping, and prompt appending.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CueExecutionConfig } from '../../../main/cue/cue-executor';
import type { CueEvent, CueSubscription } from '../../../main/cue/cue-types';
import type { SessionInfo } from '../../../shared/types';
import type { TemplateContext } from '../../../shared/templateVariables';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockGetAgentDefinition = vi.fn();
const mockGetAgentCapabilities = vi.fn(() => ({
	supportsResume: true,
	supportsReadOnlyMode: true,
	supportsJsonOutput: true,
	supportsSessionId: true,
	supportsImageInput: false,
	supportsImageInputOnResume: false,
	supportsSlashCommands: true,
	supportsSessionStorage: true,
	supportsCostTracking: true,
	supportsContextUsage: true,
	supportsThinking: false,
	supportsStdin: false,
	supportsRawStdin: false,
	supportsModelSelection: false,
	supportsModelDiscovery: false,
	supportsBatchMode: true,
	supportsYoloMode: true,
	supportsExitCodes: true,
	supportsWorkingDir: false,
}));

vi.mock('../../../main/agents', () => ({
	getAgentDefinition: (...args: unknown[]) => mockGetAgentDefinition(...args),
	getAgentCapabilities: (...args: unknown[]) => mockGetAgentCapabilities(...args),
}));

const mockBuildAgentArgs = vi.fn((_agent: unknown, _opts: unknown) => ['--print', '--verbose']);
const mockApplyOverrides = vi.fn((_agent: unknown, args: string[], _overrides: unknown) => ({
	args,
	effectiveCustomEnvVars: undefined,
	customArgsSource: 'none' as const,
	customEnvSource: 'none' as const,
	modelSource: 'default' as const,
}));

vi.mock('../../../shared/maestro-lib/launch/agent-args', () => ({
	buildAgentArgs: (...args: unknown[]) => mockBuildAgentArgs(...args),
	applyAgentConfigOverrides: (...args: unknown[]) => mockApplyOverrides(...args),
}));

const mockWrapSpawnWithSsh = vi.fn();
vi.mock('../../../shared/maestro-lib/launch/ssh-spawn-wrapper', async () => {
	const actual = await vi.importActual<
		typeof import('../../../shared/maestro-lib/launch/ssh-spawn-wrapper')
	>('../../../shared/maestro-lib/launch/ssh-spawn-wrapper');
	return {
		...actual,
		wrapSpawnWithSsh: (...args: unknown[]) => mockWrapSpawnWithSsh(...args),
	};
});

const mockPluginsEnabled = vi.fn(() => false);
const mockActivePluginManager = vi.fn(() => null as unknown);
vi.mock('../../../main/plugins/plugin-manager-singleton', () => ({
	isPluginsFeatureEnabled: () => mockPluginsEnabled(),
	getActivePluginManager: () => mockActivePluginManager(),
}));

// Keep real in-memory identities and pure argument builders, but never write a
// proof to the host's temp directory or resolve its installed CLI.
vi.mock('../../../main/plugins/plugin-tool-run-identity', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('../../../main/plugins/plugin-tool-run-identity')>();
	const { join } = await import('node:path');
	return {
		...actual,
		pluginToolRunIdentity: new actual.PluginToolRunIdentity(),
		createPluginRunProofFile: vi.fn(() => join('fixtures', 'maestro-plugin-run-fixture', 'proof')),
		removePluginRunProofFile: vi.fn(),
	};
});
vi.mock('../../../shared/plugins/mcp-agent-config', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../shared/plugins/mcp-agent-config')>();
	return {
		...actual,
		buildMcpInjection: vi.fn(actual.buildMcpInjection),
		mergeMcpInjectionArgs: vi.fn(actual.mergeMcpInjectionArgs),
	};
});
vi.mock('../../../main/cue/cue-cli-executor', () => ({
	resolveMaestroCliScriptPath: vi.fn(() => 'fixture-maestro-cli.js'),
}));
vi.mock('../../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Mock the Claude token-source resolver's leaf dependencies so the maestro-p
// binary reads as present and config-dir resolution is deterministic. The
// resolver itself (resolveClaudeSpawnMode / applyClaudeSpawnDecision) and
// getClaudeTokenMode run for real, so these tests exercise the actual
// command/arg/env rewrite produced inside buildSpawnSpec.
vi.mock('../../../main/agents/claude-usage-startup', () => ({
	getMaestroPBinPath: () => '/bundled/maestro-p.js',
	isMaestroPBinaryPath: (p: string | null | undefined) => !!p && p.includes('maestro-p'),
}));
// A resolved remote is probed for maestro-p before the token mode is chosen.
vi.mock('../../../main/agents/probeRemoteMaestroP', () => ({
	ensureRemoteMaestroPProbed: vi.fn(async () => true),
}));
vi.mock('../../../main/stores/claudeUsageStore', () => ({
	getSnapshot: () => null,
	resolveConfigDirKey: () => 'test-config-key',
}));
vi.mock('fs', async (importOriginal) => {
	const actual = await importOriginal<typeof import('fs')>();
	// Make the resolved maestro-p script read as present; leave every other fs
	// function untouched so the rest of the import graph behaves normally.
	return { ...actual, existsSync: () => true };
});

// Real platform detection, but `isWindows` is a spy so the system-prompt tests
// can pin the non-Windows (inline flag) branch on every CI host.
vi.mock('../../../shared/platformDetection', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../shared/platformDetection')>();
	return { ...actual, isWindows: vi.fn(actual.isWindows) };
});

// Must import after mocks
import { buildSpawnSpec } from '../../../main/cue/cue-spawn-builder';
import {
	pluginToolRunIdentity,
	createPluginRunProofFile,
	removePluginRunProofFile,
} from '../../../main/plugins/plugin-tool-run-identity';
import { buildMcpInjection, mergeMcpInjectionArgs } from '../../../shared/plugins/mcp-agent-config';
import { resolveMaestroCliScriptPath } from '../../../main/cue/cue-cli-executor';
import { logger } from '../../../main/utils/logger';
import { embedSystemPromptInPrompt } from '../../../shared/embeddedSystemPrompt';
import * as platformDetection from '../../../shared/platformDetection';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * An SSH store holding the remotes these tests point at. The launch plan
 * resolves the remote before wrapping, so an empty list is now an error.
 */
function sshStoreWithRemotes() {
	const remote = (id: string) => ({
		id,
		name: `Remote ${id}`,
		host: `${id}.example.com`,
		port: 22,
		username: 'dev',
		privateKeyPath: '',
		enabled: true,
	});
	return { getSshRemotes: vi.fn(() => [remote('remote-1'), remote('r1')]) };
}

const defaultAgentDef = {
	id: 'claude-code',
	name: 'Claude Code',
	binaryName: 'claude',
	command: 'claude',
	args: ['--print', '--verbose'],
};

function createConfig(overrides: Partial<CueExecutionConfig> = {}): CueExecutionConfig {
	return {
		runId: 'run-1',
		session: {
			id: 'session-1',
			name: 'Test',
			toolType: 'claude-code',
			cwd: '/projects/test',
			projectRoot: '/projects/test',
		} as SessionInfo,
		subscription: {
			name: 'test-sub',
			event: 'file.changed',
			enabled: true,
			prompt: 'test',
		} as CueSubscription,
		event: {
			id: 'evt-1',
			type: 'file.changed',
			timestamp: '2026-01-01T00:00:00.000Z',
			triggerName: 'test',
			payload: {},
		} as CueEvent,
		promptPath: 'test prompt',
		toolType: 'claude-code',
		projectRoot: '/projects/test',
		templateContext: {} as TemplateContext,
		timeoutMs: 30000,
		onLog: vi.fn(),
		...overrides,
	};
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('cue-spawn-builder', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(createPluginRunProofFile).mockReset();
		vi.mocked(removePluginRunProofFile).mockReset();
		vi.mocked(buildMcpInjection).mockReset();
		vi.mocked(mergeMcpInjectionArgs).mockReset();
		vi.mocked(resolveMaestroCliScriptPath).mockReset();
		mockPluginsEnabled.mockReturnValue(false);
		mockActivePluginManager.mockReturnValue(null);
		mockGetAgentDefinition.mockReturnValue(defaultAgentDef);
		// The spec env spreads process.env, so an ambient MAESTRO_CLAUDE_BIN
		// (leaked when these tests run inside a maestro/claude agent) would bleed
		// into specs and trip the "maestro-p disabled -> undefined" assertion.
		// Clear it so the suite asserts only what the builder itself injects.
		vi.stubEnv('MAESTRO_CLAUDE_BIN', undefined as unknown as string);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	describe('buildSpawnSpec', () => {
		describe('plugin proof preparation ownership', () => {
			const privatePrompt = 'PRIVATE Cue prompt with credentials';
			const privateError = new Error(`PRIVATE filesystem details: ${privatePrompt}`);

			beforeEach(() => {
				mockPluginsEnabled.mockReturnValue(true);
				mockActivePluginManager.mockReturnValue({ getContributions: () => ({ tools: [{}] }) });
				vi.spyOn(pluginToolRunIdentity, 'issue');
				vi.spyOn(pluginToolRunIdentity, 'revoke');
			});

			afterEach(() => {
				// Also release identities if an assertion fails before executor handoff.
				for (const issued of vi.mocked(pluginToolRunIdentity.issue).mock.results) {
					if (issued.type === 'return') pluginToolRunIdentity.revoke(issued.value);
				}
				vi.restoreAllMocks();
			});

			it.each(['proof file', 'CLI path', 'injection', 'argument merge', 'environment merge'])(
				'revokes its identity and removes any owned proof when %s preparation fails',
				async (stage) => {
					const fail = () => {
						throw privateError;
					};
					if (stage === 'proof file')
						vi.mocked(createPluginRunProofFile).mockImplementationOnce(fail);
					if (stage === 'CLI path')
						vi.mocked(resolveMaestroCliScriptPath).mockImplementationOnce(fail);
					if (stage === 'injection') vi.mocked(buildMcpInjection).mockImplementationOnce(fail);
					if (stage === 'argument merge')
						vi.mocked(mergeMcpInjectionArgs).mockImplementationOnce(fail);
					if (stage === 'environment merge') {
						vi.mocked(buildMcpInjection).mockReturnValueOnce({
							globalArgs: [],
							files: [],
							get env() {
								throw privateError;
							},
						});
					}
					const config = createConfig({ enableMaestroP: false });
					const result = await buildSpawnSpec(config, privatePrompt);
					const token = vi.mocked(pluginToolRunIdentity.issue).mock.results[0].value;
					expect(pluginToolRunIdentity.issue).toHaveBeenCalledExactlyOnceWith('session-1', 90000);
					expect(createPluginRunProofFile).toHaveBeenCalledExactlyOnceWith(token, 90000);
					expect(pluginToolRunIdentity.revoke).toHaveBeenCalledExactlyOnceWith(token);
					expect(pluginToolRunIdentity.resolve(token).callerAgentId).toBeNull();
					if (stage === 'proof file') {
						expect(removePluginRunProofFile).not.toHaveBeenCalled();
					} else {
						expect(removePluginRunProofFile).toHaveBeenCalledExactlyOnceWith(
							vi.mocked(createPluginRunProofFile).mock.results[0].value
						);
					}
					expect(result).toEqual({ ok: false, message: 'Plugin tool preparation unavailable.' });
					expect(config.onLog).not.toHaveBeenCalled();
					expect(logger.warn).not.toHaveBeenCalled();
					expect(mockWrapSpawnWithSsh).not.toHaveBeenCalled();
				}
			);

			it.each([false, true])(
				'releases an unused file injection (cleanup failure: %s)',
				async (cleanupFails) => {
					vi.mocked(buildMcpInjection).mockReturnValueOnce({
						globalArgs: ['--unused-injection'],
						env: { UNUSED_PLUGIN_ENV: 'unused' },
						files: [{ path: 'unused-config.json', content: privatePrompt }],
					});
					if (cleanupFails) {
						vi.mocked(removePluginRunProofFile).mockImplementationOnce(() => {
							throw privateError;
						});
					}
					const result = await buildSpawnSpec(
						createConfig({ enableMaestroP: false }),
						'public prompt'
					);
					const token = vi.mocked(pluginToolRunIdentity.issue).mock.results[0].value;
					expect(result.ok).toBe(true);
					if (!result.ok) throw new Error('Expected a usable spec without plugin injection');
					expect(result.spec.pluginRunToken).toBeUndefined();
					expect(result.spec.pluginRunProofFile).toBeUndefined();
					expect(result.spec.args).toEqual(['--print', '--verbose', '--', 'public prompt']);
					expect(result.spec.env.UNUSED_PLUGIN_ENV).toBeUndefined();
					expect(mergeMcpInjectionArgs).not.toHaveBeenCalled();
					expect(pluginToolRunIdentity.revoke).toHaveBeenCalledExactlyOnceWith(token);
					expect(pluginToolRunIdentity.resolve(token).callerAgentId).toBeNull();
					expect(removePluginRunProofFile).toHaveBeenCalledExactlyOnceWith(
						vi.mocked(createPluginRunProofFile).mock.results[0].value
					);
					if (cleanupFails) {
						expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
							'Could not remove plugin run proof file',
							'[PluginRunIdentity]'
						);
					} else expect(logger.warn).not.toHaveBeenCalled();
					expect(
						JSON.stringify([result.spec.args, vi.mocked(logger.warn).mock.calls])
					).not.toContain(privatePrompt);
				}
			);

			it('keeps the fixed refusal when removing a failed injection proof also throws', async () => {
				vi.mocked(buildMcpInjection).mockImplementationOnce(() => {
					throw privateError;
				});
				vi.mocked(removePluginRunProofFile).mockImplementationOnce(() => {
					throw privateError;
				});
				const result = await buildSpawnSpec(createConfig({ enableMaestroP: false }), privatePrompt);
				const token = vi.mocked(pluginToolRunIdentity.issue).mock.results[0].value;
				expect(result).toEqual({ ok: false, message: 'Plugin tool preparation unavailable.' });
				expect(pluginToolRunIdentity.revoke).toHaveBeenCalledExactlyOnceWith(token);
				expect(pluginToolRunIdentity.resolve(token).callerAgentId).toBeNull();
				expect(removePluginRunProofFile).toHaveBeenCalledExactlyOnceWith(
					vi.mocked(createPluginRunProofFile).mock.results[0].value
				);
				expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
					'Could not remove plugin run proof file',
					'[PluginRunIdentity]'
				);
			});

			it('transfers a successful proof to its caller without revoking or removing it', async () => {
				const result = await buildSpawnSpec(
					createConfig({ enableMaestroP: false }),
					'public prompt'
				);
				expect(result.ok).toBe(true);
				if (!result.ok) throw new Error('Expected proof ownership transfer');
				expect(pluginToolRunIdentity.resolve(result.spec.pluginRunToken).callerAgentId).toBe(
					'session-1'
				);
				expect(result.spec.pluginRunProofFile).toBe(
					vi.mocked(createPluginRunProofFile).mock.results[0].value
				);
				expect(pluginToolRunIdentity.revoke).not.toHaveBeenCalled();
				expect(removePluginRunProofFile).not.toHaveBeenCalled();
			});

			it('never issues or removes a proof when plugin injection is disabled', async () => {
				mockPluginsEnabled.mockReturnValue(false);
				const result = await buildSpawnSpec(
					createConfig({ enableMaestroP: false }),
					'public prompt'
				);
				expect(result.ok).toBe(true);
				if (!result.ok) throw new Error('Expected ordinary launch spec');
				expect(result.spec.pluginRunToken).toBeUndefined();
				expect(result.spec.pluginRunProofFile).toBeUndefined();
				expect(pluginToolRunIdentity.issue).not.toHaveBeenCalled();
				expect(pluginToolRunIdentity.revoke).not.toHaveBeenCalled();
				expect(createPluginRunProofFile).not.toHaveBeenCalled();
				expect(removePluginRunProofFile).not.toHaveBeenCalled();
			});
		});

		it('injects a run-bound local MCP bridge for a Cue agent', async () => {
			mockPluginsEnabled.mockReturnValue(true);
			mockActivePluginManager.mockReturnValue({ getContributions: () => ({ tools: [{}] }) });
			const result = await buildSpawnSpec(createConfig({ enableMaestroP: false }), 'post summary');
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.spec.args).toContain('--mcp-config');
			expect(result.spec.pluginRunToken).toMatch(/^[0-9a-f]{64}$/);
			expect(result.spec.pluginRunProofFile).toContain('maestro-plugin-run-');
			expect(pluginToolRunIdentity.resolve(result.spec.pluginRunToken).callerAgentId).toBe(
				'session-1'
			);
			const mcpConfigArg = result.spec.args[result.spec.args.indexOf('--mcp-config') + 1];
			const mcpConfig = JSON.parse(mcpConfigArg) as {
				mcpServers: { maestro: { env: { MAESTRO_PLUGIN_RUN_TOKEN_FILE: string } } };
			};
			expect(mcpConfig.mcpServers.maestro.env.MAESTRO_PLUGIN_RUN_TOKEN_FILE).toBe(
				result.spec.pluginRunProofFile
			);
			pluginToolRunIdentity.revoke(result.spec.pluginRunToken!);
			removePluginRunProofFile(result.spec.pluginRunProofFile!);
		});
		it('injects a Codex Cue MCP bridge beside exec config and before its prompt', async () => {
			mockBuildAgentArgs.mockReturnValueOnce([
				'exec',
				'resume',
				'provider-session',
				'-c',
				'model_reasoning_summary=auto',
			]);
			mockPluginsEnabled.mockReturnValue(true);
			mockActivePluginManager.mockReturnValue({ getContributions: () => ({ tools: [{}] }) });
			mockGetAgentDefinition.mockReturnValue({
				...defaultAgentDef,
				id: 'codex',
				command: 'codex',
				binaryName: 'codex',
			});
			const session = createConfig().session;
			const result = await buildSpawnSpec(
				createConfig({ toolType: 'codex', session: { ...session, toolType: 'codex' } }),
				'post summary'
			);
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.spec.args.join(' ')).toContain('mcp_servers.maestro.command');
			const bridgeIndex = result.spec.args.findIndex((arg) =>
				arg.startsWith('mcp_servers.maestro.command=')
			);
			expect(bridgeIndex).toBeGreaterThan(result.spec.args.indexOf('model_reasoning_summary=auto'));
			expect(bridgeIndex).toBeLessThan(result.spec.args.indexOf('--'));
			expect(result.spec.args.join(' ')).toContain(JSON.stringify(result.spec.pluginRunProofFile));
			expect(pluginToolRunIdentity.resolve(result.spec.pluginRunToken).callerAgentId).toBe(
				'session-1'
			);
			pluginToolRunIdentity.revoke(result.spec.pluginRunToken!);
			removePluginRunProofFile(result.spec.pluginRunProofFile!);
		});
		it('returns error for unknown agent type', async () => {
			mockGetAgentDefinition.mockReturnValue(undefined);

			const result = await buildSpawnSpec(createConfig({ toolType: 'nonexistent' }), 'prompt');

			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.message).toContain('Unknown agent type: nonexistent');
			}
		});

		it('builds spec with correct command and cwd for local execution', async () => {
			const result = await buildSpawnSpec(createConfig(), 'hello world');

			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.spec.command).toBe('claude');
				expect(result.spec.cwd).toBe('/projects/test');
			}
		});

		it('uses custom path when provided', async () => {
			const result = await buildSpawnSpec(createConfig({ customPath: '/custom/claude' }), 'prompt');

			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.spec.command).toBe('/custom/claude');
			}
		});

		it('appends -- then prompt for default agents (no promptArgs/noPromptSeparator)', async () => {
			const result = await buildSpawnSpec(createConfig(), 'Hello world');

			expect(result.ok).toBe(true);
			if (result.ok) {
				const args = result.spec.args;
				expect(args[args.length - 2]).toBe('--');
				expect(args[args.length - 1]).toBe('Hello world');
			}
		});

		it('uses promptArgs when agent provides it', async () => {
			mockGetAgentDefinition.mockReturnValue({
				...defaultAgentDef,
				promptArgs: (p: string) => ['-p', p],
			});

			const result = await buildSpawnSpec(createConfig(), 'Hello world');

			expect(result.ok).toBe(true);
			if (result.ok) {
				const pIdx = result.spec.args.indexOf('-p');
				expect(pIdx).toBeGreaterThan(-1);
				expect(result.spec.args[pIdx + 1]).toBe('Hello world');
			}
		});

		it('appends prompt directly when noPromptSeparator is true', async () => {
			mockGetAgentDefinition.mockReturnValue({
				...defaultAgentDef,
				noPromptSeparator: true,
			});

			const result = await buildSpawnSpec(createConfig(), 'Hello world');

			expect(result.ok).toBe(true);
			if (result.ok) {
				const args = result.spec.args;
				expect(args[args.length - 1]).toBe('Hello world');
				expect(args[args.length - 2]).not.toBe('--');
			}
		});

		it('calls buildAgentArgs with yoloMode: true', async () => {
			await buildSpawnSpec(createConfig(), 'prompt');

			expect(mockBuildAgentArgs).toHaveBeenCalledWith(
				expect.objectContaining({ id: 'claude-code' }),
				expect.objectContaining({ yoloMode: true, permissionMode: 'full' })
			);
		});

		it('passes config overrides through applyAgentConfigOverrides', async () => {
			const config = createConfig({
				customModel: 'claude-4-opus',
				customArgs: '--max-tokens 1000',
				customEnvVars: { API_KEY: 'test' },
			});

			await buildSpawnSpec(config, 'prompt');

			expect(mockApplyOverrides).toHaveBeenCalledWith(
				expect.anything(),
				expect.any(Array),
				expect.objectContaining({
					sessionCustomModel: 'claude-4-opus',
					sessionCustomArgs: '--max-tokens 1000',
					sessionCustomEnvVars: { API_KEY: 'test' },
				})
			);
		});

		it('includes process.env in the spec env', async () => {
			// Seed a unique env var to avoid platform-fragile assertions (e.g. PATH)
			process.env.__CUE_SPAWN_TEST__ = 'test-value';
			try {
				const result = await buildSpawnSpec(createConfig(), 'prompt');

				expect(result.ok).toBe(true);
				if (result.ok) {
					expect(result.spec.env.__CUE_SPAWN_TEST__).toBe('test-value');
				}
			} finally {
				delete process.env.__CUE_SPAWN_TEST__;
			}
		});

		it('expands a launchd PATH instead of inheriting it verbatim (#1573)', async () => {
			const launchdPath = '/usr/bin:/bin:/usr/sbin:/sbin';
			const originalPath = process.env.PATH;
			process.env.PATH = launchdPath;
			try {
				const result = await buildSpawnSpec(createConfig(), 'prompt');

				expect(result.ok).toBe(true);
				if (result.ok) {
					expect(result.spec.env.PATH).not.toBe(launchdPath);
					expect(result.spec.env.PATH).toContain(launchdPath.split(':')[0]);
					if (process.platform !== 'win32') {
						const parts = result.spec.env.PATH.split(':');
						expect(parts).toContain('/opt/homebrew/bin');
						expect(parts).toContain('/usr/local/bin');
					}
				}
			} finally {
				process.env.PATH = originalPath;
			}
		});

		it('marks the spawn as a cue turn', async () => {
			// Nothing else distinguishes a Cue run from a prompt the user typed:
			// same binary, same args, and the prompt text is the user's own words
			// out of cue.yaml. Downstream tooling reads this var instead of guessing.
			const result = await buildSpawnSpec(createConfig(), 'prompt');

			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.spec.env.MAESTRO_QUERY_SOURCE).toBe('cue');
			}
		});

		it('keeps the cue marker even when the agent sets its own env vars', async () => {
			const result = await buildSpawnSpec(
				createConfig({ customEnvVars: { MAESTRO_QUERY_SOURCE: 'user' } }),
				'prompt'
			);

			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.spec.env.MAESTRO_QUERY_SOURCE).toBe('cue');
			}
		});

		describe('SSH execution', () => {
			it('calls wrapSpawnWithSsh when SSH is enabled', async () => {
				const mockSshStore = sshStoreWithRemotes();

				mockWrapSpawnWithSsh.mockResolvedValue({
					command: 'ssh',
					args: ['user@host', 'claude', '--print'],
					cwd: '/Users/test',
					customEnvVars: undefined,
					prompt: undefined,
					sshRemoteUsed: { id: 'remote-1', name: 'Server', host: 'host.example.com' },
				});

				const result = await buildSpawnSpec(
					createConfig({
						sshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
						sshStore: mockSshStore,
					}),
					'prompt'
				);

				expect(mockWrapSpawnWithSsh).toHaveBeenCalledWith(
					expect.objectContaining({
						command: 'claude',
						agentBinaryName: 'claude',
						// Every Cue SSH run launches through the stdin script so it records
						// the remote pid that Stop, the timeout and shutdown signal.
						launchViaStdinScript: true,
					}),
					{ enabled: true, remoteId: 'remote-1' },
					mockSshStore
				);

				expect(result.ok).toBe(true);
				if (result.ok) {
					expect(result.spec.command).toBe('ssh');
					expect(result.spec.cwd).toBe('/Users/test');
					expect(result.spec.sshRemoteUsed).toEqual({
						id: 'remote-1',
						name: 'Server',
						host: 'host.example.com',
					});
				}
			});

			it('does not append prompt to args for SSH mode (wrapper handles it)', async () => {
				const mockSshStore = sshStoreWithRemotes();

				mockWrapSpawnWithSsh.mockResolvedValue({
					command: 'ssh',
					args: ['user@host', 'claude', '--', 'Hello world'],
					cwd: '/Users/test',
					customEnvVars: undefined,
					prompt: undefined,
					sshRemoteUsed: { id: 'r1', name: 'S', host: 'h' },
				});

				const result = await buildSpawnSpec(
					createConfig({
						sshRemoteConfig: { enabled: true, remoteId: 'r1' },
						sshStore: mockSshStore,
					}),
					'Hello world'
				);

				expect(result.ok).toBe(true);
				if (result.ok) {
					// Only one occurrence of the prompt (from SSH wrapper)
					const promptOccurrences = result.spec.args.filter((a) =>
						a.includes('Hello world')
					).length;
					expect(promptOccurrences).toBe(1);
				}
			});

			it('passes sshStdinScript through when SSH returns it', async () => {
				const mockSshStore = sshStoreWithRemotes();

				mockWrapSpawnWithSsh.mockResolvedValue({
					command: 'ssh',
					args: ['user@host'],
					cwd: '/Users/test',
					customEnvVars: undefined,
					prompt: undefined,
					sshStdinScript: '#!/bin/bash\nclaude "test prompt"',
					sshRemoteUsed: { id: 'r1', name: 'S', host: 'h' },
				});

				const result = await buildSpawnSpec(
					createConfig({
						sshRemoteConfig: { enabled: true, remoteId: 'r1' },
						sshStore: mockSshStore,
					}),
					'test prompt'
				);

				expect(result.ok).toBe(true);
				if (result.ok) {
					expect(result.spec.sshStdinScript).toBe('#!/bin/bash\nclaude "test prompt"');
				}
			});

			it('passes stdinPrompt through when SSH returns prompt for stdin delivery', async () => {
				const mockSshStore = sshStoreWithRemotes();

				mockWrapSpawnWithSsh.mockResolvedValue({
					command: 'ssh',
					args: ['user@host'],
					cwd: '/Users/test',
					customEnvVars: undefined,
					prompt: 'large prompt content',
					sshRemoteUsed: { id: 'r1', name: 'S', host: 'h' },
				});

				const result = await buildSpawnSpec(
					createConfig({
						sshRemoteConfig: { enabled: true, remoteId: 'r1' },
						sshStore: mockSshStore,
					}),
					'large prompt content'
				);

				expect(result.ok).toBe(true);
				if (result.ok) {
					expect(result.spec.stdinPrompt).toBe('large prompt content');
				}
			});

			it('fails instead of spawning locally when the wrapper loses the planned remote', async () => {
				// The plan resolved the remote, but the wrapper handed back the local
				// config (remote deleted or disabled in between). That must fail.
				mockWrapSpawnWithSsh.mockResolvedValue({
					command: 'claude',
					args: ['--print', '--verbose'],
					cwd: '/projects/test',
					customEnvVars: undefined,
					prompt: 'Hello world',
					sshRemoteUsed: null,
				});

				const result = await buildSpawnSpec(
					createConfig({
						sshRemoteConfig: { enabled: true, remoteId: 'r1' },
						sshStore: sshStoreWithRemotes(),
					}),
					'Hello world'
				);

				expect(result).toEqual({
					ok: false,
					message: expect.stringContaining('configured remote "r1" could not be resolved'),
				});
			});

			it('fails instead of running locally when SSH is enabled but there is no remote list', async () => {
				// SSH enabled in config, but no sshStore to resolve the remote in.
				// The run used to fall back to a local spawn with the prompt
				// appended; the user asked for a remote, so it now fails with a
				// message saying why.
				const result = await buildSpawnSpec(
					createConfig({
						sshRemoteConfig: { enabled: true, remoteId: 'r1' },
						// sshStore deliberately omitted
					}),
					'Hello world'
				);

				expect(result.ok).toBe(false);
				if (!result.ok) {
					expect(result.message).toContain('"r1" cannot be looked up');
				}
				expect(mockWrapSpawnWithSsh).not.toHaveBeenCalled();
			});

			it('fails instead of running locally when the configured remote no longer exists', async () => {
				const result = await buildSpawnSpec(
					createConfig({
						sshRemoteConfig: { enabled: true, remoteId: 'deleted-remote' },
						sshStore: sshStoreWithRemotes(),
					}),
					'Hello world'
				);

				expect(result.ok).toBe(false);
				if (!result.ok) {
					expect(result.message).toContain('"deleted-remote" no longer exists');
				}
				expect(mockWrapSpawnWithSsh).not.toHaveBeenCalled();
			});
		});

		describe('Claude token-source (maestro-p) rewrite', () => {
			// A claude-code definition carrying the interactive (maestro-p) wiring
			// the resolver requires to treat the spawn as a TUI candidate.
			const claudeInteractiveAgentDef = {
				...defaultAgentDef,
				interactiveCommand: 'maestro-p',
				interactiveModeArgs: ['--dangerously-skip-permissions'],
				defaultEnvVars: {},
			};

			it('rewrites a local spawn to maestro-p for interactive token mode, keeping the prompt last', async () => {
				mockGetAgentDefinition.mockReturnValue(claudeInteractiveAgentDef);

				const result = await buildSpawnSpec(
					createConfig({ enableMaestroP: true, maestroPMode: 'interactive' }),
					'Hello world'
				);

				expect(result.ok).toBe(true);
				if (result.ok) {
					const { command, args, env } = result.spec;
					// maestro-p runs via the Node execPath...
					expect(command).toBe(process.execPath);
					// ...with the maestro-p script first, then --max-wait derived from
					// the run's timeoutMs (30000ms -> 30s), then the interactive flags...
					expect(args[0]).toBe('/bundled/maestro-p.js');
					expect(args[1]).toBe('--max-wait');
					expect(args[2]).toBe('30');
					expect(args[3]).toBe('--dangerously-skip-permissions');
					// ...and the substituted prompt still the trailing positional.
					expect(args[args.length - 1]).toBe('Hello world');
					// maestro-p is told which real claude binary to drive.
					expect(env.MAESTRO_CLAUDE_BIN).toBeTruthy();
				}
			});

			it('leaves a plain claude batch spec unchanged when maestro-p is disabled', async () => {
				mockGetAgentDefinition.mockReturnValue(claudeInteractiveAgentDef);

				const result = await buildSpawnSpec(createConfig({ enableMaestroP: false }), 'Hello world');

				expect(result.ok).toBe(true);
				if (result.ok) {
					const { command, args, env } = result.spec;
					expect(command).toBe('claude');
					expect(args[0]).not.toBe('/bundled/maestro-p.js');
					expect(args[args.length - 1]).toBe('Hello world');
					expect(env.MAESTRO_CLAUDE_BIN).toBeUndefined();
				}
			});

			it('routes interactive token mode through maestro-p on the remote when SSH is enabled', async () => {
				mockGetAgentDefinition.mockReturnValue(claudeInteractiveAgentDef);
				const mockSshStore = sshStoreWithRemotes();
				mockWrapSpawnWithSsh.mockResolvedValue({
					command: 'ssh',
					args: ['user@host', 'maestro-p', '--dangerously-skip-permissions', '--', 'Hello world'],
					cwd: '/Users/test',
					customEnvVars: undefined,
					prompt: undefined,
					sshRemoteUsed: { id: 'r1', name: 'S', host: 'h' },
				});

				const result = await buildSpawnSpec(
					createConfig({
						enableMaestroP: true,
						maestroPMode: 'interactive',
						sshRemoteConfig: { enabled: true, remoteId: 'r1' },
						sshStore: mockSshStore,
					}),
					'Hello world'
				);

				// The SSH wrapper is handed the REMOTE maestro-p command (not the
				// local execPath rewrite), with --max-wait derived from the run's
				// timeoutMs (30000ms -> 30s) ahead of the interactive flags, then the
				// headless arg list (maestro-p strips those on the remote).
				expect(mockWrapSpawnWithSsh).toHaveBeenCalledWith(
					expect.objectContaining({
						agentBinaryName: 'maestro-p',
						args: expect.arrayContaining(['--max-wait', '30', '--dangerously-skip-permissions']),
					}),
					{ enabled: true, remoteId: 'r1' },
					mockSshStore
				);
				const wrapArgs = mockWrapSpawnWithSsh.mock.calls[0][0].args as string[];
				expect(wrapArgs.slice(0, 3)).toEqual([
					'--max-wait',
					'30',
					'--dangerously-skip-permissions',
				]);

				expect(result.ok).toBe(true);
				if (result.ok) {
					// The local maestro-p execPath rewrite must NOT apply for SSH.
					expect(result.spec.command).toBe('ssh');
					expect(result.spec.command).not.toBe(process.execPath);
				}
			});
		});
	});

	describe('Maestro system prompt (appendSystemPrompt)', () => {
		beforeEach(() => {
			vi.mocked(platformDetection.isWindows).mockReturnValue(false);
		});

		afterEach(async () => {
			const actual = await vi.importActual<typeof import('../../../shared/platformDetection')>(
				'../../../shared/platformDetection'
			);
			vi.mocked(platformDetection.isWindows).mockImplementation(actual.isWindows);
		});

		const nativeCaps = () => ({
			...(mockGetAgentCapabilities() as Record<string, unknown>),
			supportsAppendSystemPrompt: true,
		});

		it('passes the native flag for agents that support it, before the prompt positional', async () => {
			mockGetAgentCapabilities.mockReturnValueOnce(nativeCaps() as any);

			const result = await buildSpawnSpec(createConfig({ appendSystemPrompt: 'SYS' }), 'Do it');

			expect(result.ok).toBe(true);
			if (!result.ok) return;
			const args = result.spec.args;
			const flagIdx = args.indexOf('--append-system-prompt');
			expect(flagIdx).toBeGreaterThan(-1);
			expect(args[flagIdx + 1]).toBe('SYS');
			// The user prompt is untouched and still last.
			expect(args.slice(-2)).toEqual(['--', 'Do it']);
		});

		it('embeds into the positional prompt for agents without the native flag', async () => {
			const result = await buildSpawnSpec(createConfig({ appendSystemPrompt: 'SYS' }), 'Do it');

			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.spec.args).not.toContain('--append-system-prompt');
			expect(result.spec.args.slice(-2)).toEqual(['--', embedSystemPromptInPrompt('SYS', 'Do it')]);
		});

		it('hands the embedded prompt to the SSH wrapper (stdin path)', async () => {
			const mockSshStore = sshStoreWithRemotes();
			mockWrapSpawnWithSsh.mockResolvedValue({
				command: 'ssh',
				args: ['user@host'],
				cwd: '/Users/test',
				customEnvVars: undefined,
				prompt: undefined,
				sshStdinScript: '#!/bin/bash\nclaude',
				sshRemoteUsed: { id: 'r1', name: 'S', host: 'h' },
			});

			await buildSpawnSpec(
				createConfig({
					appendSystemPrompt: 'SYS',
					sshRemoteConfig: { enabled: true, remoteId: 'r1' },
					sshStore: mockSshStore,
				}),
				'Do it'
			);

			const wrapConfig = mockWrapSpawnWithSsh.mock.calls[0][0] as {
				prompt: string;
				args: string[];
			};
			expect(wrapConfig.prompt).toBe(embedSystemPromptInPrompt('SYS', 'Do it'));
		});

		it('hands the native flag to the SSH wrapper inline', async () => {
			mockGetAgentCapabilities.mockReturnValueOnce(nativeCaps() as any);
			const mockSshStore = sshStoreWithRemotes();
			mockWrapSpawnWithSsh.mockResolvedValue({
				command: 'ssh',
				args: ['user@host'],
				cwd: '/Users/test',
				customEnvVars: undefined,
				prompt: undefined,
				sshRemoteUsed: { id: 'r1', name: 'S', host: 'h' },
			});

			await buildSpawnSpec(
				createConfig({
					appendSystemPrompt: 'SYS',
					sshRemoteConfig: { enabled: true, remoteId: 'r1' },
					sshStore: mockSshStore,
				}),
				'Do it'
			);

			const wrapConfig = mockWrapSpawnWithSsh.mock.calls[0][0] as {
				prompt: string;
				args: string[];
			};
			expect(wrapConfig.prompt).toBe('Do it');
			expect(wrapConfig.args).toEqual(expect.arrayContaining(['--append-system-prompt', 'SYS']));
		});

		it('changes nothing when no system prompt is supplied', async () => {
			const result = await buildSpawnSpec(createConfig(), 'Do it');
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.spec.args.slice(-2)).toEqual(['--', 'Do it']);
			expect(result.spec.args).not.toContain('--append-system-prompt');
		});
	});
});
