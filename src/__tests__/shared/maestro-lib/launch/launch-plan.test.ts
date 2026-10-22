import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
	buildAgentLaunchPlan,
	isManagedLaunchRefusal,
	type AgentLaunchInput,
} from '../../../../shared/maestro-lib/launch/launch-plan';
import {
	qualifySshLaunchTarget,
	resolveSshLaunchTarget,
	type SshRemoteEndpointIdentity,
	type SshRemoteExpectation,
} from '../../../../shared/maestro-lib/launch/ssh-remote-resolver';
import { getAgentDefinition } from '../../../../shared/maestro-lib/providers/definitions';
import { getAgentCapabilities } from '../../../../shared/maestro-lib/providers/capabilities';
import type { SshRemoteConfig } from '../../../../shared/types';
import type { ManagedRouteCeiling } from '../../../../shared/maestro-lib/launch/env';
import { bindApprovedCredentials } from '../../../../shared/maestro-lib/managed/credentials';
import { MANAGED_CONTRACT_VERSION } from '../../../../shared/maestro-lib/managed/types';

function remote(overrides: Partial<SshRemoteConfig> = {}): SshRemoteConfig {
	return {
		id: 'remote-1',
		name: 'Build Box',
		host: 'build.example.com',
		port: 22,
		username: 'dev',
		privateKeyPath: '',
		enabled: true,
		...overrides,
	} as SshRemoteConfig;
}

function storeWith(...remotes: SshRemoteConfig[]) {
	return { getSshRemotes: () => remotes };
}

function codex(): AgentLaunchInput['agent'] {
	return { ...getAgentDefinition('codex'), capabilities: getAgentCapabilities('codex') };
}

function input(overrides: Partial<AgentLaunchInput> = {}): AgentLaunchInput {
	return {
		surface: 'desktop',
		agent: codex(),
		command: '/usr/local/bin/codex',
		args: ['exec', '--json'],
		cwd: '/project',
		prompt: 'fix the bug',
		isWindowsHost: false,
		...overrides,
	};
}

describe('resolveSshLaunchTarget: an unusable remote is an error, never a local run', () => {
	it('is local when SSH is off or unset', () => {
		expect(resolveSshLaunchTarget(storeWith(remote()), undefined)).toEqual({ kind: 'local' });
		expect(
			resolveSshLaunchTarget(storeWith(remote()), { enabled: false, remoteId: 'remote-1' })
		).toEqual({ kind: 'local' });
	});

	it('resolves an enabled remote', () => {
		const target = resolveSshLaunchTarget(storeWith(remote()), {
			enabled: true,
			remoteId: 'remote-1',
		});

		expect(target.kind).toBe('remote');
	});

	it.each([
		[
			'no remote is selected',
			storeWith(remote()),
			{ enabled: true, remoteId: null },
			'no-remote-selected',
			'no remote is selected',
		],
		[
			'the remote was deleted',
			storeWith(),
			{ enabled: true, remoteId: 'remote-1' },
			'remote-not-found',
			'"remote-1" no longer exists',
		],
		[
			'the remote is disabled',
			storeWith(remote({ enabled: false })),
			{ enabled: true, remoteId: 'remote-1' },
			'remote-disabled',
			'"Build Box" is disabled',
		],
		[
			'there is no remote list to look it up in',
			undefined,
			{ enabled: true, remoteId: 'remote-1' },
			'no-remote-store',
			'cannot be looked up',
		],
	])('fails with a specific message when %s', (_case, store, config, reason, fragment) => {
		const target = resolveSshLaunchTarget(store, config);

		expect(target).toMatchObject({ kind: 'unresolved', reason });
		if (target.kind !== 'unresolved') throw new Error('expected unresolved');
		expect(target.message).toContain(fragment);
		expect(target.message).toContain('nothing ran on this machine');
	});
});

describe('buildAgentLaunchPlan', () => {
	let savedEnv: NodeJS.ProcessEnv;

	beforeEach(() => {
		savedEnv = { ...process.env };
	});

	afterEach(() => {
		process.env = savedEnv;
	});

	it('fails before planning anything when the SSH remote cannot be resolved', () => {
		const result = buildAgentLaunchPlan(
			input({ sshRemoteConfig: { enabled: true, remoteId: 'gone' }, sshStore: storeWith() })
		);

		expect(result).toMatchObject({ ok: false, reason: 'remote-not-found' });
		if (result.ok) throw new Error('expected failure');
		expect(result.error).toContain('"gone" no longer exists');
	});

	it('plans a local launch: command, argv prompt, cwd and the full environment', () => {
		process.env.FROM_PROCESS = 'yes';
		const result = buildAgentLaunchPlan(
			input({
				globalShellEnvVars: { GLOBAL: 'g' },
				sessionCustomEnvVars: { SESSION: 's' },
				querySource: 'auto',
			})
		);

		if (!result.ok) throw new Error(result.error);
		const { plan } = result;
		expect(plan.target).toEqual({ kind: 'local' });
		expect(plan.command).toBe('/usr/local/bin/codex');
		expect(plan.args).toEqual(['exec', '--json', '--', 'fix the bug']);
		expect(plan.cwd).toBe('/project');
		expect(plan.prompt.via).toBe('argv');
		expect(plan.stdin).toBeUndefined();
		expect(plan.env?.FROM_PROCESS).toBe('yes');
		expect(plan.env?.GLOBAL).toBe('g');
		expect(plan.env?.SESSION).toBe('s');
		expect(plan.env?.MAESTRO_QUERY_SOURCE).toBe('auto');
		// The global Settings vars reach the local process but are not part of
		// the record Maestro sets: that record also crosses to an SSH remote.
		expect(plan.envVars).toEqual({ SESSION: 's' });
	});

	it('builds the environment by the rules of the launching surface', () => {
		process.env.SHELL_SET = 'from-shell';
		const agent = { defaultEnvVars: { SHELL_SET: 'from-default' } };
		const planned = (surface: AgentLaunchInput['surface']) => {
			const result = buildAgentLaunchPlan(
				input({ surface, agent, globalShellEnvVars: { GLOBAL: 'g' } })
			);
			if (!result.ok) throw new Error(result.error);
			return result.plan.env;
		};

		// Desktop and Cue put a provider default over the inherited value; the
		// CLI lets the shell that ran the command keep its own.
		expect(planned('desktop')?.SHELL_SET).toBe('from-default');
		expect(planned('cue')?.SHELL_SET).toBe('from-default');
		expect(planned('cli')?.SHELL_SET).toBe('from-shell');
		// Settings -> Environment is a desktop layer.
		expect(planned('desktop')?.GLOBAL).toBe('g');
		expect(planned('cue')?.GLOBAL).toBeUndefined();
		expect(planned('cli')?.GLOBAL).toBeUndefined();
	});

	it('plans stdin delivery on a Windows host: prompt on stdin, not in argv', () => {
		const result = buildAgentLaunchPlan(input({ isWindowsHost: true }));

		if (!result.ok) throw new Error(result.error);
		expect(result.plan.args).toEqual(['exec', '--json']);
		expect(result.plan.prompt).toEqual({ via: 'stdin', format: 'raw', args: [] });
		expect(result.plan.stdin).toBe('fix the bug');
	});

	it.each(['cli', 'cue'] as const)(
		'keeps the prompt on the command line on a Windows host for the %s surface',
		(surface) => {
			const result = buildAgentLaunchPlan(input({ surface, isWindowsHost: true }));

			if (!result.ok) throw new Error(result.error);
			expect(result.plan.args).toEqual(['exec', '--json', '--', 'fix the bug']);
			expect(result.plan.prompt.via).toBe('argv');
			expect(result.plan.stdin).toBeUndefined();
		}
	);

	it('plans a remote launch: bare binary name, no local env, remote env record', () => {
		const result = buildAgentLaunchPlan(
			input({
				sshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
				sshStore: storeWith(remote()),
				globalShellEnvVars: { GLOBAL: 'g' },
				sessionCustomEnvVars: { SESSION: 's' },
				readOnlyMode: true,
			})
		);

		if (!result.ok) throw new Error(result.error);
		const { plan } = result;
		expect(plan.target.kind).toBe('remote');
		expect(plan.command).toBe('codex');
		// The SSH wrapper places the prompt; the plan does not.
		expect(plan.args).toEqual(['exec', '--json']);
		expect(plan.prompt).toEqual({ via: 'ssh' });
		expect(plan.env).toBeUndefined();
		// Settings -> Environment is not in the plan's record. (Desktop's SSH
		// wrapper still merges it beneath this record on the remote, as `rc` does.)
		expect(plan.envVars).toEqual({ SESSION: 's' });
	});

	it('applies the provider defaults, batch vars and read-only overrides from the definition', () => {
		const agent = {
			defaultEnvVars: { A: 'default' },
			batchModeEnvVars: { B: 'batch' },
			readOnlyEnvOverrides: { A: 'read-only' },
		};

		const batch = buildAgentLaunchPlan(input({ agent, batchMode: true }));
		const readOnly = buildAgentLaunchPlan(input({ agent, readOnlyMode: true }));
		const plain = buildAgentLaunchPlan(input({ agent }));

		if (!batch.ok || !readOnly.ok || !plain.ok) throw new Error('plan failed');
		expect(batch.plan.envVars).toEqual({ A: 'default', B: 'batch' });
		expect(readOnly.plan.envVars).toEqual({ A: 'read-only' });
		expect(plain.plan.envVars).toEqual({ A: 'default' });
	});
});

/**
 * A managed launch and an SSH remote (MRC-08-04, MRC-08-06). The plan's rule
 * is the one every surface shares: under management a remote is not a route
 * this host can bound, so it is refused as unsupported and nothing is planned
 * locally in its place; with SSH on and no usable remote, the resolver's own
 * refusal comes first and is never dressed up as a managed one; an approved
 * credential is never forwarded over SSH. The desktop sink asks the remote's
 * runtime for its standing beside the plan (`qualifySshLaunchTarget` binds the
 * attested identity, `EnterpriseService.remote` reads it): that qualification
 * names where a lease goes, it is not support for this plan. Standalone is
 * untouched.
 */
describe('a managed launch on an SSH remote is unsupported, never local (MRC-08-06)', () => {
	const NOW = Date.parse('2026-10-22T12:00:00Z');
	const SENTINEL = 'sentinel-0d4c7b1e-never-forwarded';
	const route = (): ManagedRouteCeiling => ({
		providerId: 'codex',
		model: null,
		baseUrl: null,
		accountDir: null,
		login: 'provider-login',
	});
	const sshOn = (): Partial<AgentLaunchInput> => ({
		sshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
		sshStore: storeWith(remote()),
	});
	const approved = () =>
		bindApprovedCredentials(
			[
				{
					contractVersion: MANAGED_CONTRACT_VERSION,
					refId: 'cred-codex',
					tenantId: 't',
					actorId: 'a',
					agentId: 'agent-1',
					audience: { providerId: 'codex', destination: null },
					accountRef: null,
					policyRevision: 1,
					issuedAt: '2026-10-22T00:00:00Z',
					expiresAt: '2026-10-23T00:00:00Z',
					status: 'active',
					source: { kind: 'server-secret', secretName: 'OPENAI_KEY', envVar: 'OPENAI_API_KEY' },
				},
			],
			{
				tenantId: 't',
				actorId: 'a',
				agentId: 'agent-1',
				providerId: 'codex',
				destination: null,
				accountRef: null,
				policyRevision: 1,
				now: NOW,
			}
		);

	it('refuses a managed route on a resolved remote by name, with no local plan in its place', () => {
		const result = buildAgentLaunchPlan(
			input({ ...sshOn(), managed: { route: route(), now: NOW } })
		);

		expect(result).toMatchObject({ ok: false, reason: 'managed-route-refused' });
		if (result.ok) throw new Error('expected refusal');
		expect(isManagedLaunchRefusal(result.reason)).toBe(true);
		expect(result.error).toContain('not supported on an SSH remote');
		expect(result.error).toContain('cannot be bounded from this host');
		expect('plan' in result).toBe(false);

		// The refusal is about the remote, not about management: the same
		// managed launch with SSH off is planned, locally, under the ceiling.
		const local = buildAgentLaunchPlan(input({ managed: { route: route(), now: NOW } }));
		expect(local.ok).toBe(true);
		if (local.ok) expect(local.plan.target).toEqual({ kind: 'local' });
	});

	it('leaves the standalone remote launch exactly as it was', () => {
		const result = buildAgentLaunchPlan(input(sshOn()));

		if (!result.ok) throw new Error(result.error);
		expect(result.plan.target).toEqual({ kind: 'remote', remote: remote() });
		expect(result.plan.command).toBe('codex');
		expect(result.plan.managedCredentials).toBeUndefined();
		// No endpoint identity rides an unmanaged plan: nothing asked the remote.
		expect('endpoint' in result.plan.target).toBe(false);
	});

	it.each([
		[
			'no remote is selected',
			storeWith(remote()),
			{ enabled: true, remoteId: null },
			'no-remote-selected',
		],
		[
			'the remote was deleted',
			storeWith(),
			{ enabled: true, remoteId: 'remote-1' },
			'remote-not-found',
		],
		[
			'the remote is disabled',
			storeWith(remote({ enabled: false })),
			{ enabled: true, remoteId: 'remote-1' },
			'remote-disabled',
		],
		[
			'there is no remote list',
			undefined,
			{ enabled: true, remoteId: 'remote-1' },
			'no-remote-store',
		],
	])(
		'under management, when %s, the resolver refuses first and the refusal is not a managed one',
		(_case, sshStore, sshRemoteConfig, reason) => {
			const result = buildAgentLaunchPlan(
				input({
					sshStore,
					sshRemoteConfig,
					// A credential set the plan would refuse as unbound: never reached.
					managed: { route: route(), credentials: {} as never, now: NOW },
				})
			);

			expect(result).toMatchObject({ ok: false, reason });
			if (result.ok) throw new Error('expected refusal');
			expect(isManagedLaunchRefusal(result.reason)).toBe(false);
			expect(result.error).toContain('nothing ran on this machine instead');
			expect(result.error).not.toContain('managed');
		}
	);

	it('never forwards an approved credential to a remote: refused by variable name, the value unread', () => {
		const lookup = { env: { OPENAI_KEY: SENTINEL }, runSecretsDir: null };
		const result = buildAgentLaunchPlan(
			input({
				...sshOn(),
				surface: 'cli',
				managed: { route: route(), credentials: approved(), now: NOW },
				secretLookup: lookup,
			})
		);

		expect(result).toMatchObject({ ok: false, reason: 'managed-credential-remote' });
		if (result.ok) throw new Error('expected refusal');
		expect(result.error).toContain('OPENAI_API_KEY');
		expect(result.error).toContain('not forwarded');
		expect(JSON.stringify(result)).not.toContain(SENTINEL);

		// The same binding on a local launch delivers the value to this child
		// alone, and never into the record that is shown and sent to remotes.
		const local = buildAgentLaunchPlan(
			input({
				surface: 'cli',
				managed: { route: route(), credentials: approved(), now: NOW },
				secretLookup: lookup,
			})
		);
		if (!local.ok) throw new Error(local.error);
		expect(local.plan.env?.OPENAI_API_KEY).toBe(SENTINEL);
		expect(local.plan.managedCredentials?.delivered).toMatchObject([
			{ refId: 'cred-codex', envVar: 'OPENAI_API_KEY' },
		]);
		expect(JSON.stringify(local.plan.envVars ?? {})).not.toContain(SENTINEL);
	});

	it("a qualified remote is identity for the sink's lease, not support for the plan; an unqualified one runs nowhere", () => {
		const target = resolveSshLaunchTarget(storeWith(remote()), {
			enabled: true,
			remoteId: 'remote-1',
		});
		const expectation: SshRemoteExpectation = {
			tenantId: 't',
			orgId: 'o',
			providerId: 'codex',
			policyRevision: 2,
		};
		const identity: SshRemoteEndpointIdentity = {
			contractVersion: MANAGED_CONTRACT_VERSION,
			installationId: 'inst-remote',
			runtimeId: 'rt-remote',
			processEpoch: 'epoch-remote',
			tenantId: 't',
			orgId: 'o',
			authorityId: 'authority-remote',
			policyRevision: 2,
			authority: 'registered',
			routes: [{ providerId: 'codex', route: 'ssh', managed: 'implemented' }],
		};
		const via = 'maestro-cli host status --json';

		const qualified = qualifySshLaunchTarget(
			target,
			{ status: 'attested', identity, via },
			expectation
		);
		expect(qualified).toMatchObject({
			kind: 'remote',
			remote: { id: 'remote-1' },
			endpoint: { installationId: 'inst-remote', authorityId: 'authority-remote' },
		});
		// The plan takes no endpoint: the remote's word names where a lease goes;
		// it does not make the remote environment this host's to bound.
		const planned = buildAgentLaunchPlan(
			input({ ...sshOn(), managed: { route: route(), now: NOW } })
		);
		expect(planned).toMatchObject({ ok: false, reason: 'managed-route-refused' });

		// A remote that does not confine codex launches arriving over SSH, or
		// one that cannot be asked, is refused with the promise for both machines.
		const unconfined = qualifySshLaunchTarget(
			target,
			{
				status: 'attested',
				identity: {
					...identity,
					routes: [{ providerId: 'codex', route: 'ssh', managed: 'unverified', note: 'no sink' }],
				},
				via,
			},
			expectation
		);
		expect(unconfined).toMatchObject({ kind: 'unresolved', reason: 'remote-unqualified' });
		if (unconfined.kind !== 'unresolved') throw new Error('expected refusal');
		expect(unconfined.message).toContain('does not confine codex launches arriving over SSH');
		expect(unconfined.message).toContain(
			'nothing ran on the remote unmanaged, and nothing ran on this machine instead'
		);
		const unreachable = qualifySshLaunchTarget(
			target,
			{ status: 'unreachable', reason: 'ssh: connect timed out' },
			expectation
		);
		expect(unreachable).toMatchObject({ kind: 'unresolved', reason: 'remote-unqualified' });
		if (unreachable.kind !== 'unresolved') throw new Error('expected refusal');
		expect(unreachable.message).toContain('connect timed out');

		// Standalone: SSH off is local and is never qualified.
		expect(
			qualifySshLaunchTarget(
				{ kind: 'local' },
				{ status: 'unreachable', reason: 'never asked' },
				expectation
			)
		).toEqual({ kind: 'local' });
	});
});
