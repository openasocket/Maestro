/**
 * Declared secrets (`requiredSecrets`) in the launch plan: resolved for the
 * agent that declared them and no other, on the CLI and Cue surfaces only,
 * into the spawn environment and never into `envVars` (which is shown in
 * Process Details and crosses to an SSH remote).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	buildAgentLaunchPlan,
	describeUndeliveredSecrets,
	type AgentLaunchInput,
	type AgentLaunchPlan,
} from '../../../../shared/maestro-lib/launch/launch-plan';
import { getAgentDefinition } from '../../../../shared/maestro-lib/providers/definitions';
import { getAgentCapabilities } from '../../../../shared/maestro-lib/providers/capabilities';
import type { SshRemoteConfig } from '../../../../shared/types';
import {
	ALL_ROUTE_ENV_NAMES,
	applyManagedEnvCeiling,
	type ManagedRouteCeiling,
} from '../../../../shared/maestro-lib/launch/env';
import { bindApprovedCredentials } from '../../../../shared/maestro-lib/managed/credentials';
import { MANAGED_CONTRACT_VERSION } from '../../../../shared/maestro-lib/managed/types';

const SENTINEL = 'sentinel-7f3a91c2-do-not-leak';

let tmp: string;
let runSecrets: string;
let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'launch-plan-secrets-')));
	runSecrets = path.join(tmp, 'run-secrets');
	fs.mkdirSync(runSecrets);
	fs.writeFileSync(path.join(runSecrets, 'GITHUB_TOKEN'), `${SENTINEL}\n`);
	savedEnv = { ...process.env };
	// An engine secret no agent declared, and an unrelated engine variable.
	process.env.ENGINE_ONLY_SECRET = 'engine-only';
	process.env.UNRELATED_ENGINE_VAR = 'unrelated';
	delete process.env.MAESTRO_SERVER_MODE;
	delete process.env.GITHUB_TOKEN;
});

afterEach(() => {
	process.env = savedEnv;
	fs.rmSync(tmp, { recursive: true, force: true });
});

function input(overrides: Partial<AgentLaunchInput> = {}): AgentLaunchInput {
	return {
		surface: 'cue',
		agent: { ...getAgentDefinition('codex'), capabilities: getAgentCapabilities('codex') },
		command: '/usr/local/bin/codex',
		args: ['exec', '--json'],
		cwd: '/project',
		prompt: 'fix the bug',
		isWindowsHost: false,
		secretLookup: { env: {}, runSecretsDir: runSecrets },
		...overrides,
	};
}

function plan(overrides: Partial<AgentLaunchInput> = {}): AgentLaunchPlan {
	const result = buildAgentLaunchPlan(input(overrides));
	if (!result.ok) throw new Error(result.error);
	return result.plan;
}

describe('declared secrets under server mode (Cue)', () => {
	it('reach the agent that declared them even though they are not allowlisted', () => {
		const p = plan({ isServerMode: true, requiredSecrets: ['GITHUB_TOKEN'] });
		expect(p.env?.GITHUB_TOKEN).toBe(SENTINEL);
		expect(p.secrets).toEqual({
			injected: [{ name: 'GITHUB_TOKEN', source: 'run-secrets' }],
			missing: [],
			unusable: [],
			notDeliveredToRemote: [],
		});
	});

	it('keep the rest of the engine environment out', () => {
		const p = plan({ isServerMode: true, requiredSecrets: ['GITHUB_TOKEN'] });
		expect(p.env?.ENGINE_ONLY_SECRET).toBeUndefined();
		expect(p.env?.UNRELATED_ENGINE_VAR).toBeUndefined();
	});

	it('are not given to an agent that did not declare them', () => {
		const p = plan({ isServerMode: true });
		expect(p.env?.GITHUB_TOKEN).toBeUndefined();
		expect(p.secrets).toBeUndefined();
	});

	it('never appear in envVars, the record that is shown and sent to remotes', () => {
		const p = plan({ isServerMode: true, requiredSecrets: ['GITHUB_TOKEN'] });
		expect(JSON.stringify(p.envVars ?? {})).not.toContain(SENTINEL);
		const { env: _env, ...rest } = p;
		expect(JSON.stringify(rest)).not.toContain(SENTINEL);
	});

	it('lose to a value the agent record sets for the same name', () => {
		const p = plan({
			isServerMode: true,
			requiredSecrets: ['GITHUB_TOKEN'],
			sessionCustomEnvVars: { GITHUB_TOKEN: 'set-on-the-agent' },
		});
		expect(p.env?.GITHUB_TOKEN).toBe('set-on-the-agent');
	});

	it('never touch process.env', () => {
		plan({ isServerMode: true, requiredSecrets: ['GITHUB_TOKEN'] });
		expect(process.env.GITHUB_TOKEN).toBeUndefined();
	});

	it('report a missing secret by name', () => {
		const p = plan({ isServerMode: true, requiredSecrets: ['GITHUB_TOKEN', 'NPM_TOKEN'] });
		expect(p.secrets?.missing).toEqual(['NPM_TOKEN']);
		const warning = describeUndeliveredSecrets('Deployer', p.secrets);
		expect(warning).toContain('Agent "Deployer" requires secrets it did not receive');
		expect(warning).toContain('NPM_TOKEN');
		expect(warning).not.toContain(SENTINEL);
		expect(
			describeUndeliveredSecrets('Deployer', plan({ requiredSecrets: ['GITHUB_TOKEN'] }).secrets)
		).toBeUndefined();
	});
});

describe('declared secrets on the CLI surface', () => {
	it('win over the same name exported in the shell (files before environment)', () => {
		process.env.GITHUB_TOKEN = 'stale-shell-value';
		const p = plan({ surface: 'cli', requiredSecrets: ['GITHUB_TOKEN'] });
		expect(p.env?.GITHUB_TOKEN).toBe(SENTINEL);
	});

	it('are not overwritten by provider defaults, which only fill unset names', () => {
		const p = plan({
			surface: 'cli',
			requiredSecrets: ['GITHUB_TOKEN'],
			agent: {
				...getAgentDefinition('codex'),
				capabilities: getAgentCapabilities('codex'),
				defaultEnvVars: { GITHUB_TOKEN: 'provider-default' },
			},
		});
		expect(p.env?.GITHUB_TOKEN).toBe(SENTINEL);
	});

	it('are not given to an agent that did not declare them', () => {
		expect(plan({ surface: 'cli' }).env?.GITHUB_TOKEN).toBeUndefined();
	});
});

describe('surfaces that never read secret files', () => {
	it('desktop ignores requiredSecrets entirely', () => {
		const p = plan({ surface: 'desktop', requiredSecrets: ['GITHUB_TOKEN'] });
		expect(p.env?.GITHUB_TOKEN).toBeUndefined();
		expect(p.secrets).toBeUndefined();
	});

	it('an SSH remote gets no value, and the plan says so', () => {
		const remote = {
			id: 'remote-1',
			name: 'Build Box',
			host: 'build.example.com',
			port: 22,
			username: 'dev',
			privateKeyPath: '',
			enabled: true,
		} as SshRemoteConfig;
		const p = plan({
			requiredSecrets: ['GITHUB_TOKEN'],
			sshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
			sshStore: { getSshRemotes: () => [remote] },
		});
		expect(p.target.kind).toBe('remote');
		expect(JSON.stringify(p)).not.toContain(SENTINEL);
		expect(p.secrets?.notDeliveredToRemote).toEqual(['GITHUB_TOKEN']);
	});
});

// ─── The managed route ceiling (MRC-05-03) ───────────────────────────────────

describe('the managed route ceiling', () => {
	const NOW = Date.parse('2026-10-21T12:00:00Z');
	const claude = (): AgentLaunchInput['agent'] => ({
		...getAgentDefinition('claude-code'),
		capabilities: getAgentCapabilities('claude-code'),
	});
	const route = (overrides: Partial<ManagedRouteCeiling> = {}): ManagedRouteCeiling => ({
		providerId: 'claude-code',
		model: null,
		baseUrl: null,
		accountDir: null,
		login: 'approved-credential',
		permissionMode: null,
		...overrides,
	});
	const approved = (envVar = 'ANTHROPIC_API_KEY', secretName = 'GITHUB_TOKEN') =>
		bindApprovedCredentials(
			[
				{
					contractVersion: MANAGED_CONTRACT_VERSION,
					refId: 'cred-team',
					tenantId: 't',
					actorId: 'a',
					agentId: 'agent-1',
					audience: { providerId: 'claude-code', destination: null },
					accountRef: null,
					policyRevision: 1,
					issuedAt: '2026-10-21T00:00:00Z',
					expiresAt: '2026-10-22T00:00:00Z',
					status: 'active',
					source: { kind: 'server-secret', secretName, envVar },
				},
			],
			{
				tenantId: 't',
				actorId: 'a',
				agentId: 'agent-1',
				providerId: 'claude-code',
				destination: null,
				accountRef: null,
				policyRevision: 1,
				now: NOW,
			}
		);
	const managedInput = (overrides: Partial<AgentLaunchInput> = {}): AgentLaunchInput =>
		input({
			surface: 'desktop',
			agent: claude(),
			command: '/usr/local/bin/claude',
			args: ['--print'],
			sessionCustomEnvVars: {
				ANTHROPIC_API_KEY: 'personal-key',
				ANTHROPIC_BASE_URL: 'https://personal-gateway.example',
				CLAUDE_CONFIG_DIR: '/home/u/.claude-personal',
				MAESTRO_QUERY_SOURCE: 'forged',
				MAESTRO_MANAGED_LEASE: 'forged-lease',
				KEEP_ME: 'kept',
			},
			maestroEnvVars: { MAESTRO_CALLER_AGENT_ID: 'caller-1' },
			querySource: 'user',
			...overrides,
		});

	beforeEach(() => {
		// Inherited provider keys the ceiling must remove on every surface.
		process.env.OPENAI_API_KEY = 'inherited-openai';
		process.env.ANTHROPIC_AUTH_TOKEN = 'inherited-token';
	});

	it.each(['desktop', 'cli', 'cue'] as const)(
		'on %s: strips every route and authority name, delivers the approved credential, restates Maestro facts',
		(surface) => {
			const result = buildAgentLaunchPlan(
				managedInput({
					surface,
					managed: { route: route(), credentials: approved(), now: NOW },
				})
			);
			if (!result.ok) throw new Error(result.error);
			const env = result.plan.env!;
			expect(env.ANTHROPIC_API_KEY).toBe(SENTINEL);
			expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
			expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
			expect(env.OPENAI_API_KEY).toBeUndefined();
			expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
			expect(env.MAESTRO_MANAGED_LEASE).toBeUndefined();
			expect(env.MAESTRO_QUERY_SOURCE).toBe('user');
			expect(env.MAESTRO_CALLER_AGENT_ID).toBe('caller-1');
			expect(env.KEEP_ME).toBe('kept');
			expect(result.plan.managedCredentials?.ceiling?.removed).toEqual(
				expect.arrayContaining([
					'ANTHROPIC_API_KEY',
					'ANTHROPIC_BASE_URL',
					'CLAUDE_CONFIG_DIR',
					'OPENAI_API_KEY',
					'ANTHROPIC_AUTH_TOKEN',
					'MAESTRO_MANAGED_LEASE',
				])
			);
			const { env: _env, ...rest } = result.plan;
			expect(JSON.stringify(rest)).not.toContain(SENTINEL);
			expect(JSON.stringify(rest)).not.toContain('personal-key');
		}
	);

	it('pins the model, the gateway and the account home over whatever the user set', () => {
		const result = buildAgentLaunchPlan(
			managedInput({
				managed: {
					route: route({
						model: 'claude-pinned',
						baseUrl: 'https://gateway.corp.example',
						accountDir: '/srv/accounts/team',
					}),
					credentials: approved(),
					now: NOW,
				},
			})
		);
		if (!result.ok) throw new Error(result.error);
		expect(result.plan.env?.ANTHROPIC_MODEL).toBe('claude-pinned');
		expect(result.plan.env?.ANTHROPIC_BASE_URL).toBe('https://gateway.corp.example');
		expect(result.plan.env?.CLAUDE_CONFIG_DIR).toBe('/srv/accounts/team');
		expect(result.plan.args.slice(0, 3)).toEqual(['--print', '--model', 'claude-pinned']);
		expect(result.plan.envVars?.ANTHROPIC_MODEL).toBe('claude-pinned');
		expect(result.plan.envVars?.ANTHROPIC_API_KEY).toBeUndefined();
		expect(result.plan.managedCredentials?.ceiling?.pinned).toEqual([
			'ANTHROPIC_BASE_URL',
			'ANTHROPIC_MODEL',
			'CLAUDE_CONFIG_DIR',
		]);
	});

	it('refuses the personal-login fallback: an approved-credential route with nothing delivered', () => {
		const result = buildAgentLaunchPlan(managedInput({ managed: { route: route(), now: NOW } }));
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe('managed-route-refused');
			expect(result.error).toContain('personal login');
			expect(result.error).not.toContain('personal-key');
		}
		// The same launch is planned when the policy lets the provider login bill.
		const allowed = buildAgentLaunchPlan(
			managedInput({ managed: { route: route({ login: 'provider-login' }), now: NOW } })
		);
		expect(allowed.ok).toBe(true);
		if (allowed.ok) expect(allowed.plan.env?.ANTHROPIC_API_KEY).toBeUndefined();
	});

	it('refuses a delivered credential the provider does not read, and a provider other than the route', () => {
		const wrongVar = buildAgentLaunchPlan(
			managedInput({
				managed: { route: route(), credentials: approved('OPENAI_API_KEY'), now: NOW },
			})
		);
		expect(wrongVar.ok).toBe(false);
		if (!wrongVar.ok)
			expect(wrongVar.error).toContain('OPENAI_API_KEY is not a credential variable');
		const wrongProvider = buildAgentLaunchPlan(
			managedInput({
				agent: { ...getAgentDefinition('codex'), capabilities: getAgentCapabilities('codex') },
				managed: { route: route(), credentials: approved(), now: NOW },
			})
		);
		expect(wrongProvider.ok).toBe(false);
		if (!wrongProvider.ok) {
			expect(wrongProvider.reason).toBe('managed-route-refused');
			expect(wrongProvider.error).toContain('routes this launch to claude-code, not codex');
		}
	});

	it.each([
		[['--print', '--model', 'other-model'], 'names other-model but the policy pins claude-pinned'],
		[['--print', '-m=other-model'], 'names other-model'],
		[['--print', '--api-key', 'x'], '--api-key is not allowed under management'],
		[['--print', '--base-url=https://x'], '--base-url is not allowed'],
		[['--print', '--settings', '{"env":{"ANTHROPIC_API_KEY":"x"}}'], '--settings sets env'],
		[['--print', '--settings', '{"apiKeyHelper":"/bin/x"}'], '--settings sets apiKeyHelper'],
		[['--print', '--settings', '/path/settings.json'], 'cannot be checked'],
		[['exec', '-c', 'model_provider="mine"'], '-c model_provider is not allowed'],
		[['exec', '--config', 'base_url="https://x"'], '--config base_url is not allowed'],
	] as const)('refuses arguments that route around the policy: %j', (args, message) => {
		const result = buildAgentLaunchPlan(
			managedInput({
				args: [...args],
				managed: { route: route({ model: 'claude-pinned' }), credentials: approved(), now: NOW },
			})
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe('managed-route-refused');
			expect(result.error).toContain(message);
		}
	});

	it('accepts arguments that agree with the pin and never appends a second model flag', () => {
		const result = buildAgentLaunchPlan(
			managedInput({
				args: ['--print', '--model', 'claude-pinned', '-c', 'model="claude-pinned"'],
				managed: { route: route({ model: 'claude-pinned' }), credentials: approved(), now: NOW },
			})
		);
		if (!result.ok) throw new Error(result.error);
		expect(result.plan.args.filter((arg) => arg === '--model')).toHaveLength(1);
	});

	it('is never applied to an unmanaged launch: every surface keeps its own order', () => {
		for (const surface of ['desktop', 'cli', 'cue'] as const) {
			const result = buildAgentLaunchPlan(managedInput({ surface }));
			if (!result.ok) throw new Error(result.error);
			expect(result.plan.env?.ANTHROPIC_API_KEY).toBe('personal-key');
			expect(result.plan.env?.ANTHROPIC_BASE_URL).toBe('https://personal-gateway.example');
			expect(result.plan.env?.CLAUDE_CONFIG_DIR).toBe('/home/u/.claude-personal');
			expect(result.plan.env?.OPENAI_API_KEY).toBe('inherited-openai');
			expect(result.plan.managedCredentials).toBeUndefined();
		}
	});

	it('applies the ceiling in place and reports names only', () => {
		const env: NodeJS.ProcessEnv = {
			ANTHROPIC_API_KEY: 'personal',
			CODEX_HOME: '/x',
			MAESTRO_MANAGED_GRANT: 'g',
			PATH: '/bin',
		};
		const report = applyManagedEnvCeiling(env, {
			ceiling: route({ accountDir: '/srv/team' }),
			credentialEnvVars: { ANTHROPIC_API_KEY: SENTINEL },
		});
		expect(env).toEqual({
			PATH: '/bin',
			CLAUDE_CONFIG_DIR: '/srv/team',
			ANTHROPIC_API_KEY: SENTINEL,
		});
		expect(report).toEqual({
			removed: ['ANTHROPIC_API_KEY', 'CODEX_HOME', 'MAESTRO_MANAGED_GRANT'],
			pinned: ['CLAUDE_CONFIG_DIR'],
			problems: [],
		});
		expect(JSON.stringify(report)).not.toContain(SENTINEL);
		expect(ALL_ROUTE_ENV_NAMES).toEqual(
			expect.arrayContaining(['ANTHROPIC_API_KEY', 'OPENAI_BASE_URL', 'COPILOT_HOME'])
		);
	});
});
