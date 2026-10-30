import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'node:path';
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
import {
	getAgentCapabilities,
	GROK_DIRECTORY_GRANT_SUPPORT,
} from '../../../../shared/maestro-lib/providers/capabilities';
import type { SshRemoteConfig } from '../../../../shared/types';
import { noteEffortRejection, resetEffortRejections } from '../../../../shared/effortRejection';
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

describe('Grok directory-grant planning (native filesystem qualification remains phase 11)', () => {
	const agent = { ...getAgentDefinition('grok'), capabilities: getAgentCapabilities('grok') };
	const unsupported =
		'Grok CLI additional-directory read and write grants have no qualified native mechanism. Remove the grants to run with the selected working directory.';
	const readonly = "Grok CLI writable directory grants exceed this launch's read-only mode.";

	describe.each([
		{ host: 'local', resumed: false },
		{ host: 'local', resumed: true },
		{ host: 'remote', resumed: false },
		{ host: 'remote', resumed: true },
	])('$host, resumed=$resumed', ({ host, resumed }) => {
		const isRemote = host === 'remote';
		const cwd = isRemote ? '/selected/work tree/工作' : path.resolve('fixture work tree', '工作');
		const root = isRemote ? '~/other root/资料' : path.resolve('fixture other root', '资料');
		const account = isRemote ? '/accounts/selected' : path.resolve('fixture selected account');
		const destination = isRemote ? '/remote/tmp/prompt.json' : path.resolve('fixture prompt.json');
		const args = [...agent.workingDirArgs!(cwd), ...(resumed ? agent.resumeArgs!('turn-id') : [])];
		const selection: Partial<AgentLaunchInput> = {
			agent,
			args,
			cwd,
			command: path.resolve('fixture grok'),
			remoteCommand: '/remote/bin/custom grok',
			isResuming: resumed,
			prompt: `private prompt mentioning ${root} does not grant access`,
			sessionCustomEnvVars: { GROK_HOME: account },
			sshRemoteConfig: isRemote ? { enabled: true, remoteId: 'remote-1' } : undefined,
			sshStore: storeWith(remote()),
			promptFileDestination: {
				path: destination,
				owner: isRemote ? 'remote' : 'local',
				...(isRemote ? { sshRemoteId: 'remote-1' } : {}),
			},
		};

		it.each([
			['absent', undefined],
			['empty', []],
			['blank', [{ path: ' \t ', read: true, write: true }]],
			['inert', [{ path: root, read: false, write: false }]],
			[
				'last duplicate disabled',
				[
					{ path: root, read: true, write: true },
					{ path: ` ${root} `, read: false, write: false },
				],
			],
		] satisfies [string, AgentLaunchInput['additionalDirectories']][])(
			'preserves selected host/cwd/account/resume without a grant for %s rows',
			(_label, additionalDirectories) => {
				const original = structuredClone(additionalDirectories);
				const result = buildAgentLaunchPlan(input({ ...selection, additionalDirectories }));
				if (!result.ok) throw new Error(result.error);
				expect(result.plan.args).toEqual([...args, '--prompt-file', destination]);
				expect(result.plan.cwd).toBe(cwd);
				expect(result.plan.command).toBe(isRemote ? selection.remoteCommand : selection.command);
				expect(result.plan.target).toEqual(
					isRemote ? { kind: 'remote', remote: remote() } : { kind: 'local' }
				);
				expect(result.plan.envVars).toEqual({ GROK_HOME: account });
				if (isRemote) expect(result.plan.env).toBeUndefined();
				else expect(result.plan.env?.GROK_HOME).toBe(account);
				expect(result.plan.permission).toEqual({ requested: 'standard', ceiling: null });
				expect(result.plan.prompt).toMatchObject({
					via: 'file',
					artifact: selection.promptFileDestination,
				});
				expect(result.plan.stdin).toBeUndefined();
				expect(additionalDirectories).toEqual(original);
			}
		);

		it.each([
			['read only', [{ path: root, read: true, write: false }]],
			['write only', [{ path: root, read: false, write: true }]],
			['read and write', [{ path: root, read: true, write: true }]],
			['cwd is not a grant exception', [{ path: cwd, read: true, write: false }]],
			[
				'independent read/write roots',
				[
					{ path: root, read: true, write: false },
					{
						path: isRemote ? path.posix.join(root, 'output') : path.join(root, 'output'),
						read: false,
						write: true,
					},
				],
			],
			[
				'last duplicate enabled',
				[
					{ path: root, read: false, write: false },
					{ path: ` ${root} `, read: true, write: false },
				],
			],
		] satisfies [string, AgentLaunchInput['additionalDirectories']][])(
			'refuses %s before prompt delivery without exposing selected paths or content',
			(_label, additionalDirectories) => {
				const original = structuredClone(additionalDirectories);
				const result = buildAgentLaunchPlan(
					input({ ...selection, additionalDirectories, promptFileDestination: undefined })
				);
				expect(result).toEqual({
					ok: false,
					reason: 'grok-directory-grants-refused',
					error: unsupported,
				});
				expect(additionalDirectories).toEqual(original);
				for (const privateText of [root, cwd, account, selection.prompt!]) {
					expect(JSON.stringify(result)).not.toContain(privateText);
				}
			}
		);

		it.each(['readOnlyMode', 'permissionMode', 'managed'] as const)(
			'intersects writes with the %s readonly ceiling without treating reads as writes',
			(source) => {
				const mode: Partial<AgentLaunchInput> =
					source === 'readOnlyMode' ? { readOnlyMode: true } : { permissionMode: 'readonly' };
				if (source === 'managed') {
					mode.managed = {
						route: {
							providerId: 'grok',
							model: null,
							baseUrl: null,
							accountDir: null,
							login: 'provider-login',
							permissionMode: 'readonly',
						},
					};
				}
				for (const write of [false, true]) {
					const result = buildAgentLaunchPlan(
						input({
							...selection,
							...mode,
							args: [...args, ...agent.readOnlyArgs!],
							additionalDirectories: [{ path: root, read: !write, write }],
						})
					);
					expect(result).toEqual({
						ok: false,
						reason: 'grok-directory-grants-refused',
						error: write ? readonly : unsupported,
					});
				}
				// Last-row semantics must remove an earlier write rather than falsely
				// classify the remaining read as a writable-ceiling violation.
				const downgraded = buildAgentLaunchPlan(
					input({
						...selection,
						...mode,
						args: [...args, ...agent.readOnlyArgs!],
						additionalDirectories: [
							{ path: root, read: false, write: true },
							{ path: ` ${root} `, read: true, write: false },
						],
					})
				);
				expect(downgraded).toEqual({
					ok: false,
					reason: 'grok-directory-grants-refused',
					error: unsupported,
				});
				const upgraded = buildAgentLaunchPlan(
					input({
						...selection,
						...mode,
						args: [...args, ...agent.readOnlyArgs!],
						additionalDirectories: [
							{ path: root, read: true, write: false },
							{ path: ` ${root} `, read: false, write: true },
						],
					})
				);
				expect(upgraded).toEqual({
					ok: false,
					reason: 'grok-directory-grants-refused',
					error: readonly,
				});
			}
		);

		it('preserves the managed readonly refusal before conflicting custom root grants', () => {
			const result = buildAgentLaunchPlan(
				input({
					...selection,
					permissionMode: 'full',
					args: [...args, '--add-dir', root],
					additionalDirectories: [{ path: root, read: true, write: true }],
					managed: {
						route: {
							providerId: 'grok',
							model: null,
							baseUrl: null,
							accountDir: null,
							login: 'provider-login',
							permissionMode: 'readonly',
						},
					},
				})
			);
			expect(result).toEqual({
				ok: false,
				reason: 'managed-route-refused',
				error:
					'The launch asks for more than the policy allows - permission mode "full" asks for more than the policy\'s ceiling, which allows at most "readonly" for grok',
			});
		});

		it.each([['--add-dir', root], [`--add-dir=${root}`]])(
			'refuses the unqualified custom grant spelling %j even without typed rows',
			(...customArgs) => {
				const result = buildAgentLaunchPlan(
					input({ ...selection, args: [...args, ...customArgs] })
				);
				expect(result).toEqual({
					ok: false,
					reason: 'grok-directory-grants-refused',
					error: 'Grok CLI has no qualified --add-dir argument for additional-directory grants.',
				});
			}
		);
	});

	it.each([undefined, '0.2.93', '1.0.5', '1.0.70', '999.0.0-unqualified'])(
		'a reported version %s cannot promote unqualified directory support',
		(version) => {
			const discoveredAgent = {
				...agent,
				snapshot: { status: 'ok' as const, version, lastProbedAt: 0 },
			};
			expect(GROK_DIRECTORY_GRANT_SUPPORT.supportedVersionRange).toBeNull();
			expect(discoveredAgent.capabilities.supportsAdditionalDirectories).toBe(false);
			expect(discoveredAgent.additionalDirArgs).toBeUndefined();
			const result = buildAgentLaunchPlan(
				input({
					agent: discoveredAgent,
					args: [],
					additionalDirectories: [{ path: path.resolve('version grant'), read: true, write: true }],
				})
			);
			expect(result).toEqual({
				ok: false,
				reason: 'grok-directory-grants-refused',
				error: unsupported,
			});
		}
	);

	it.each([
		['--allow', 'Read(*)'],
		['--deny', 'Write(*)'],
		['--sandbox', 'workspace-write'],
	])('does not mistake the %s tool/sandbox rule for an extra-root mechanism', (...args) => {
		const result = buildAgentLaunchPlan(
			input({
				agent,
				args,
				additionalDirectories: [{ path: path.resolve('rule grant'), read: true, write: false }],
			})
		);
		expect(result).toEqual({
			ok: false,
			reason: 'grok-directory-grants-refused',
			error: unsupported,
		});
	});
});

describe('registered Grok prompt-file launch planning', () => {
	const agent = { ...getAgentDefinition('grok'), capabilities: getAgentCapabilities('grok') };

	it.each(['desktop', 'cli', 'cue'] as const)(
		'%s keeps large prompts in one host-owned JSON artifact on fresh and resumed turns',
		(surface) => {
			const prompt = '  private-unicode-🧪界\n"quotes" $(echo nope) & | %PATH% `nope`\r\n'.repeat(
				1_000
			);
			expect(prompt.length).toBeGreaterThan(32_767);
			for (const isRemote of [false, true]) {
				for (const isResuming of [false, true]) {
					const destination = {
						owner: isRemote ? ('remote' as const) : ('local' as const),
						path: isRemote ? '/remote/owned/prompt.json' : path.resolve('owned prompt.json'),
						...(isRemote ? { sshRemoteId: 'remote-1' } : {}),
					};
					const args = [
						...agent.jsonOutputArgs!,
						...(isResuming ? agent.resumeArgs!('turn-id') : []),
					];
					const result = buildAgentLaunchPlan(
						input({
							agent,
							surface,
							args,
							prompt,
							isResuming,
							isWindowsHost: true,
							cmdShellLaunch: true,
							sshRemoteConfig: isRemote ? { enabled: true, remoteId: 'remote-1' } : undefined,
							sshStore: storeWith(remote()),
							promptFileDestination: destination,
						})
					);
					if (!result.ok) throw new Error(result.error);
					expect(result.plan.target.kind).toBe(isRemote ? 'remote' : 'local');
					expect(result.plan.args).toEqual([...args, '--prompt-file', destination.path]);
					expect(result.plan.stdin).toBeUndefined();
					expect(result.plan.prompt).toMatchObject({
						via: 'file',
						artifact: {
							...destination,
							content: JSON.stringify({ type: 'acp', content: [{ type: 'text', text: prompt }] }),
							encoding: 'utf8',
							mode: 0o600,
							flag: 'wx',
							cleanup: 'turn',
						},
					});
					expect(JSON.stringify(result.plan.args)).not.toContain('private-unicode');
					expect(args).toEqual([
						...agent.jsonOutputArgs!,
						...(isResuming ? agent.resumeArgs!('turn-id') : []),
					]);
				}
			}
		}
	);

	it('allocates distinct local JSON names without falling back to ignored stdin', () => {
		const first = buildAgentLaunchPlan(input({ agent, args: [], prompt: '', isWindowsHost: true }));
		const second = buildAgentLaunchPlan(
			input({ agent, args: [], prompt: '', isWindowsHost: true })
		);
		if (!first.ok || !second.ok) throw new Error('expected local file plans');
		if (first.plan.prompt.via !== 'file' || second.plan.prompt.via !== 'file')
			throw new Error('expected artifacts');
		expect(path.isAbsolute(first.plan.prompt.artifact.path)).toBe(true);
		expect(path.extname(first.plan.prompt.artifact.path)).toBe('.json');
		expect(first.plan.prompt.artifact.path).not.toBe(second.plan.prompt.artifact.path);
		expect(first.plan.prompt.artifact.content).toBe(
			'{"type":"acp","content":[{"type":"text","text":""}]}'
		);
		expect(first.plan.args).toEqual(['--prompt-file', first.plan.prompt.artifact.path]);
		expect(first.plan.stdin).toBeUndefined();
	});

	it.each([
		undefined,
		{ owner: 'local', path: path.resolve('local private.json') },
		{ owner: 'remote', path: '/remote/private.json', sshRemoteId: 'different-remote' },
	] satisfies AgentLaunchInput['promptFileDestination'][])(
		'refuses an absent or foreign SSH destination without exposing prompt text: %j',
		(promptFileDestination) => {
			const prompt = 'private-prompt-must-not-be-diagnostic';
			const result = buildAgentLaunchPlan(
				input({
					agent,
					args: [],
					prompt,
					promptFileDestination,
					sshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
					sshStore: storeWith(remote()),
				})
			);
			expect(result).toMatchObject({ ok: false, reason: 'prompt-delivery-refused' });
			expect(result).not.toHaveProperty('plan');
			expect(JSON.stringify(result)).not.toContain(prompt);
			expect(JSON.stringify(result)).not.toContain('private.json');
		}
	);

	it.each([false, true])(
		'requires embedded image bytes rather than a path on resume=%s',
		(isResuming) => {
			const prompt = `inspect privately\n${agent.imagePromptBuilder!([path.resolve('private image.png')])}`;
			const selection = input({
				agent,
				args: isResuming ? agent.resumeArgs!('turn-id') : [],
				prompt,
				hasImages: true,
				isResuming,
			});
			const refused = buildAgentLaunchPlan(selection);
			expect(refused).toEqual({
				ok: false,
				reason: 'prompt-delivery-refused',
				error: 'Image content is missing from the ACP prompt file.',
			});
			expect(JSON.stringify(refused)).not.toContain(prompt);
			const blocks = [
				{ type: 'text' as const, text: 'inspect privately' },
				{ type: 'image' as const, mimeType: 'image/png', data: 'AQID' },
			];
			const delivered = buildAgentLaunchPlan({
				...selection,
				prompt: undefined,
				promptBlocks: blocks,
				embeddedImageSupport: {
					mimeTypes: ['image/png'],
					maxCount: 1,
					maxBytesPerImage: 3,
					maxTotalBytes: 3,
				},
			});
			if (!delivered.ok) throw new Error(delivered.error);
			if (delivered.plan.prompt.via !== 'file') throw new Error('expected image artifact');
			expect(JSON.parse(delivered.plan.prompt.artifact.content)).toEqual({
				type: 'acp',
				content: blocks,
			});
			expect(delivered.plan.stdin).toBeUndefined();
		}
	);
});

describe('Grok final launch model and effort validation', () => {
	const agent = { ...getAgentDefinition('grok'), capabilities: getAgentCapabilities('grok') };
	const localDestination = { owner: 'local' as const, path: path.resolve('effort prompt.json') };
	const menu: NonNullable<AgentLaunchInput['grokEffortMenu']> = {
		status: 'discovered',
		model: 'selected-model',
		wireValues: ['none', 'high'],
	};

	beforeEach(resetEffortRejections);
	afterEach(resetEffortRejections);

	it.each(['desktop', 'cli', 'cue'] as const)(
		'%s validates one normalized effort before local or SSH prompt placement',
		(surface) => {
			for (const sshRemoteConfig of [undefined, { enabled: true, remoteId: 'remote-1' }]) {
				const args = [
					'--model= selected-model ',
					'-m',
					'selected-model',
					'--effort= HiGh ',
					'--reasoning-effort',
					'high',
				];
				const original = [...args];
				const result = buildAgentLaunchPlan(
					input({
						agent,
						surface,
						command: '/opt/grok',
						args,
						grokEffortMenu: menu,
						sshRemoteConfig,
						sshStore: storeWith(remote()),
						sessionCustomEnvVars: { GROK_HOME: '/account/selected' },
						prompt: '--effort=none is prompt text',
						promptFileDestination: sshRemoteConfig
							? { owner: 'remote', path: '/remote/owned/effort.json', sshRemoteId: 'remote-1' }
							: localDestination,
					})
				);
				if (!result.ok) throw new Error(result.error);
				expect(result.plan.args).toEqual([
					'-m',
					'selected-model',
					'--reasoning-effort',
					'HiGh',
					'--prompt-file',
					sshRemoteConfig ? '/remote/owned/effort.json' : localDestination.path,
				]);
				expect(result.plan.command).toBe(sshRemoteConfig ? 'grok' : '/opt/grok');
				expect(result.plan.target.kind).toBe(sshRemoteConfig ? 'remote' : 'local');
				expect(result.plan.envVars).toEqual({ GROK_HOME: '/account/selected' });
				expect(args).toEqual(original);
			}
		}
	);

	it.each([
		['missing', undefined],
		['unavailable', { ...menu, status: 'unavailable' as const }],
		['configured fallback', { ...menu, status: 'configured-fallback' as const }],
		['stale model', { ...menu, model: 'previous-model' }],
		['different model casing', { ...menu, model: 'SELECTED-MODEL' }],
	] as const)(
		'preserves explicit high but refuses none with a %s menu',
		(_label, grokEffortMenu) => {
			for (const effort of ['high', 'none']) {
				const result = buildAgentLaunchPlan(
					input({
						agent,
						grokEffortMenu,
						args: ['-m', 'selected-model', '--effort', effort],
						promptFileDestination: localDestination,
					})
				);
				if (effort === 'high') {
					if (!result.ok) throw new Error(result.error);
					expect(result.plan.args).toEqual([
						'-m',
						'selected-model',
						'--reasoning-effort',
						'high',
						'--prompt-file',
						localDestination.path,
					]);
				} else {
					expect(result).toMatchObject({
						ok: false,
						reason: 'grok-model-effort-refused',
						error: expect.stringContaining('requires verified support'),
					});
					expect(result).not.toHaveProperty('plan');
				}
			}
		}
	);

	it.each(['none', 'high'])('accepts advertised %s without adding a fallback effort', (effort) => {
		const result = buildAgentLaunchPlan(
			input({
				agent,
				grokEffortMenu: menu,
				args: ['--model=selected-model', `--effort=${effort}`],
				promptFileDestination: localDestination,
			})
		);
		if (!result.ok) throw new Error(result.error);
		expect(result.plan.args).toEqual([
			'-m',
			'selected-model',
			'--reasoning-effort',
			effort,
			'--prompt-file',
			localDestination.path,
		]);
	});

	it.each([
		[['--effort=none'], menu, 'requires verified support'],
		[['-m', 'selected-model', '--effort=medium'], menu, 'not advertised'],
		[
			['-m', 'selected-model', '--effort=none'],
			{ ...menu, wireValues: ['high'] as const },
			'not advertised',
		],
		[['-m', 'selected-model', '--effort=high'], { ...menu, wireValues: [] }, 'not advertised'],
		[
			['-m', 'selected-model', '--model=other-model', '--effort=high'],
			menu,
			'Conflicting Grok model',
		],
		[['--effort=high', '--reasoning-effort=low'], undefined, 'Conflicting Grok effort'],
		[['--effort', '  '], undefined, 'nonempty value'],
		[['--model='], undefined, 'nonempty value'],
		[['--reasoning-effort'], undefined, 'nonempty value'],
		[['-mselected-model'], undefined, 'Use -m <model>'],
		[['--', '--effort=none'], undefined, 'cannot end options'],
	] as const)(
		'refuses unsafe composed selectors %j before creating a plan',
		(args, grokEffortMenu, message) => {
			const result = buildAgentLaunchPlan(input({ agent, args: [...args], grokEffortMenu }));
			expect(result).toMatchObject({
				ok: false,
				reason: 'grok-model-effort-refused',
				error: expect.stringContaining(message),
			});
			expect(result).not.toHaveProperty('plan');
		}
	);

	it('retains native defaults when no effort was selected', () => {
		const result = buildAgentLaunchPlan(
			input({
				agent,
				args: ['--model=selected-model'],
				grokEffortMenu: menu,
				promptFileDestination: localDestination,
			})
		);
		if (!result.ok) throw new Error(result.error);
		expect(result.plan.args).toEqual([
			'-m',
			'selected-model',
			'--prompt-file',
			localDestination.path,
		]);
	});

	it('refuses a remembered uppercase rejection even when the selected model advertises it', () => {
		noteEffortRejection('grok', { value: 'HIGH', model: 'previous-model', supported: ['low'] });
		const result = buildAgentLaunchPlan(
			input({ agent, grokEffortMenu: menu, args: ['-m', 'selected-model', '--effort=high'] })
		);
		expect(result).toMatchObject({
			ok: false,
			reason: 'grok-model-effort-refused',
			error: 'Grok CLI rejected effort "HIGH" for previous-model. It accepts low.',
		});
		expect(result).not.toHaveProperty('plan');
	});

	it('validates effort against the final managed model pin before environment delivery', () => {
		const result = buildAgentLaunchPlan(
			input({
				agent,
				args: ['--effort=none'],
				grokEffortMenu: { ...menu, wireValues: ['high'] },
				managed: {
					route: {
						providerId: 'grok',
						model: 'selected-model',
						baseUrl: null,
						accountDir: null,
						login: 'provider-login',
						permissionMode: null,
					},
				},
			})
		);
		expect(result).toMatchObject({
			ok: false,
			reason: 'grok-model-effort-refused',
			error: expect.stringContaining('not advertised'),
		});
		expect(result).not.toHaveProperty('plan');
	});

	it.each(['--model=selected-model', '-m=selected-model'])(
		'does not add a second managed model pin beside %s',
		(modelArg) => {
			const modelArgs = vi.fn(agent.modelArgs);
			const result = buildAgentLaunchPlan(
				input({
					agent: { ...agent, modelArgs },
					args: [modelArg, '--effort=none'],
					grokEffortMenu: menu,
					managed: {
						route: {
							providerId: 'grok',
							model: 'selected-model',
							baseUrl: null,
							accountDir: null,
							login: 'provider-login',
							permissionMode: null,
						},
					},
				})
			);
			expect(modelArgs).not.toHaveBeenCalled();
			// Model/effort validation succeeds; Grok's managed env route is still unsupported.
			expect(result).toMatchObject({
				ok: false,
				reason: 'managed-route-refused',
				error: expect.stringContaining('no variable for it'),
			});
			expect(result).not.toHaveProperty('plan');
		}
	);

	it('keeps another provider argv unchanged despite Grok menus and rejection memory', () => {
		noteEffortRejection('grok', { value: 'none', supported: ['high'] });
		const args = ['exec', '--model=codex-model', '--effort=none'];
		const result = buildAgentLaunchPlan(input({ args, grokEffortMenu: menu }));
		if (!result.ok) throw new Error(result.error);
		expect(result.plan.args).toEqual([...args, '--', 'fix the bug']);
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
		permissionMode: null,
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
