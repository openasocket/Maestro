/**
 * @file Unit tests for the per-agent ephemeral MCP-config adapters: each strategy
 * produces the right globalArgs / env / temp files, and the agent map marks the
 * installed CLIs verified and the rest best-guess.
 */
import { describe, it, expect } from 'vitest';
import { parse as parseToml } from 'smol-toml';
import {
	buildMcpInjection,
	mcpInjectionProblem,
	mergeMcpInjectionArgs,
	MCP_CONFIG_BY_AGENT,
	MCP_SERVER_NAME,
	type McpConfigCapability,
	type McpServerSpec,
} from '../../../shared/plugins/mcp-agent-config';

const spec: McpServerSpec = {
	command: '/bin/electron',
	args: ['/cli.js', 'mcp', 'serve', '--tab', 't1'],
	env: { ELECTRON_RUN_AS_NODE: '1' },
};
const opts = { tmpDir: '/tmp', join: (...p: string[]) => p.join('/') };

describe('buildMcpInjection - claude-mcp-config', () => {
	it('emits inline --mcp-config JSON (additive, no --strict, no temp files)', () => {
		const inj = buildMcpInjection({ strategy: 'claude-mcp-config', verified: true }, spec, opts);
		expect(inj.files).toEqual([]);
		expect(inj.env).toEqual({});
		expect(inj.globalArgs[0]).toBe('--mcp-config');
		expect(inj.globalArgs).toHaveLength(2);
		expect(JSON.parse(inj.globalArgs[1])).toEqual({
			mcpServers: { [MCP_SERVER_NAME]: { command: spec.command, args: spec.args, env: spec.env } },
		});
	});
});

describe('buildMcpInjection - codex-config-override', () => {
	it('emits -c mcp_servers overrides with TOML-encoded values, no files', () => {
		const inj = buildMcpInjection(
			{ strategy: 'codex-config-override', verified: true },
			spec,
			opts
		);
		expect(inj.files).toEqual([]);
		expect(inj.env).toEqual({});
		expect(inj.globalArgs).toContain(
			`mcp_servers.${MCP_SERVER_NAME}.command=${JSON.stringify(spec.command)}`
		);
		expect(inj.globalArgs).toContain(
			`mcp_servers.${MCP_SERVER_NAME}.args=["/cli.js", "mcp", "serve", "--tab", "t1"]`
		);
		expect(inj.globalArgs.some((a) => a.startsWith(`mcp_servers.${MCP_SERVER_NAME}.env=`))).toBe(
			true
		);
	});

	it('omits the env override when the spec carries no env', () => {
		const inj = buildMcpInjection(
			{ strategy: 'codex-config-override', verified: true },
			{ command: 'codex', args: [] },
			opts
		);
		expect(inj.globalArgs.some((a) => a.includes('.env='))).toBe(false);
	});
});

describe('buildMcpInjection - opencode-env-config', () => {
	it('writes a temp opencode.json and points OPENCODE_CONFIG at it', () => {
		const inj = buildMcpInjection(
			{
				strategy: 'opencode-env-config',
				verified: true,
				envVar: 'OPENCODE_CONFIG',
				fileName: 'oc.json',
			},
			spec,
			opts
		);
		expect(inj.globalArgs).toEqual([]);
		expect(inj.env).toEqual({ OPENCODE_CONFIG: '/tmp/oc.json' });
		expect(inj.files).toHaveLength(1);
		expect(inj.files[0].path).toBe('/tmp/oc.json');
		const cfg = JSON.parse(inj.files[0].content);
		expect(cfg.mcp[MCP_SERVER_NAME]).toMatchObject({
			type: 'local',
			command: [spec.command, ...spec.args],
			environment: spec.env,
			enabled: true,
		});
	});
});

describe('buildMcpInjection - mcp-json-file', () => {
	it('writes a { mcpServers } file and sets env when an envVar is given', () => {
		const inj = buildMcpInjection(
			{ strategy: 'mcp-json-file', verified: false, envVar: 'X_CFG', fileName: 'x.json' },
			spec,
			opts
		);
		expect(inj.env).toEqual({ X_CFG: '/tmp/x.json' });
		expect(JSON.parse(inj.files[0].content)).toEqual({
			mcpServers: { [MCP_SERVER_NAME]: { command: spec.command, args: spec.args, env: spec.env } },
		});
	});

	it('writes the file but sets no env when no envVar is given', () => {
		const inj = buildMcpInjection(
			{ strategy: 'mcp-json-file', verified: false, fileName: 'x.json' },
			spec,
			opts
		);
		expect(inj.env).toEqual({});
		expect(inj.files).toHaveLength(1);
	});
});

describe('MCP_CONFIG_BY_AGENT', () => {
	it('marks the auto-injected installed CLIs (claude, codex) verified', () => {
		expect(MCP_CONFIG_BY_AGENT['claude-code'].verified).toBe(true);
		expect(MCP_CONFIG_BY_AGENT.codex.verified).toBe(true);
	});

	it('marks the other agents as best-guess (unverified)', () => {
		for (const id of [
			'opencode',
			'gemini-cli',
			'qwen3-coder',
			'copilot-cli',
			'factory-droid',
			'hermes',
			'pi',
		]) {
			expect(MCP_CONFIG_BY_AGENT[id].verified).toBe(false);
		}
	});
});

describe('mergeMcpInjectionArgs', () => {
	const injectionArgs = ['-c', 'mcp_servers.maestro.command="/bin/electron"'];

	it.each([
		['-C', '/project', 'exec', '-c', 'model_reasoning_summary=auto'],
		['-C', '/project', 'exec', 'resume', 'provider-id', '-c', 'model_reasoning_summary=auto'],
	])('keeps Codex MCP overrides in the same scope as agent config: %j', (...agentArgs) => {
		expect(mergeMcpInjectionArgs(MCP_CONFIG_BY_AGENT.codex, agentArgs, injectionArgs)).toEqual([
			...agentArgs,
			...injectionArgs,
		]);
	});

	it('inserts Codex config before a positional prompt, preserving prompt contents', () => {
		const args = ['exec', 'resume', 'provider-id', '-c', 'model_reasoning_summary=auto'];
		const prompt = '-c mcp_servers.maestro.command="untrusted prompt content"';
		expect(
			mergeMcpInjectionArgs(MCP_CONFIG_BY_AGENT.codex, [...args, '--', prompt], injectionArgs)
		).toEqual([...args, ...injectionArgs, '--', prompt]);
	});

	it('preserves global placement for Claude', () => {
		const args = ['--print', '--', 'prompt'];
		const config = ['--mcp-config', '{"mcpServers":{}}'];
		expect(mergeMcpInjectionArgs(MCP_CONFIG_BY_AGENT['claude-code'], args, config)).toEqual([
			...config,
			...args,
		]);
	});
});

// GT1-07-07: the Grok overlay. The account's own config.toml is never named,
// read or written; the injection is one owned file under the caller's temp root.
describe('Grok MCP configuration overlay (GT1-07-07)', () => {
	const production = MCP_CONFIG_BY_AGENT.grok;
	/** The production entry with a qualified binary, as Phase 11 would list it. */
	const qualified: McpConfigCapability = {
		...production,
		verified: true,
		qualifiedVersions: ['0.1.200'],
	};
	const ownedRoot = '/tmp/maestro-mcp-profile-a';
	const at = (tmpDir: string) => ({ tmpDir, join: (...p: string[]) => p.join('/') });
	/** The bridge carries the run proof as a file path, never the token itself. */
	const bridge: McpServerSpec = {
		command: '/Applications/Maestro.app/Contents/MacOS/Maestro',
		args: ['/cli.js', 'mcp', 'serve', '--tab', 't1'],
		env: {
			ELECTRON_RUN_AS_NODE: '1',
			MAESTRO_PLUGIN_RUN_TOKEN_FILE: '/tmp/maestro-plugin-run-x/proof',
		},
	};

	describe('buildMcpInjection - grok-config-overlay', () => {
		it('writes one owned config.toml under the given root and points GROK_CONFIG_PATH at it', () => {
			const inj = buildMcpInjection(production, bridge, at(ownedRoot));
			expect(inj.globalArgs).toEqual([]);
			expect(inj.env).toEqual({ GROK_CONFIG_PATH: `${ownedRoot}/config.toml` });
			expect(inj.files).toEqual([
				{ path: `${ownedRoot}/config.toml`, content: expect.any(String) },
			]);
			expect(inj.files[0].content.endsWith('\n')).toBe(true);
		});

		it('holds the Maestro bridge table and nothing else, so account settings and servers merge untouched', () => {
			const cfg = parseToml(buildMcpInjection(production, bridge, at(ownedRoot)).files[0].content);
			expect(cfg).toEqual({
				mcp_servers: {
					[MCP_SERVER_NAME]: {
						command: bridge.command,
						args: bridge.args,
						env: bridge.env,
						enabled: true,
					},
				},
			});
		});

		it('omits the env table when the bridge carries no environment', () => {
			const cfg = parseToml(
				buildMcpInjection(production, { command: 'node', args: [] }, at(ownedRoot)).files[0].content
			) as { mcp_servers: Record<string, Record<string, unknown>> };
			expect(cfg.mcp_servers[MCP_SERVER_NAME]).toEqual({
				command: 'node',
				args: [],
				enabled: true,
			});
		});

		it('keeps hostile names and values inside their strings: no extra server, table or key', () => {
			const hostile: McpServerSpec = {
				command: '/bin/x"\n[mcp_servers.evil]\ncommand = "/bin/sh',
				args: ['--tab', '"]\n[mcp_servers.other]\nenabled = true\n#', "it's\\ok"],
				env: {
					'KEY = "x"\n[mcp_servers.injected]': 'v"\nenabled = false',
					PLAIN: 'line\r\nbreak\ttab',
				},
			};
			const cfg = parseToml(
				buildMcpInjection(production, hostile, at(ownedRoot)).files[0].content
			) as {
				mcp_servers: Record<string, Record<string, unknown>>;
			};
			expect(Object.keys(cfg)).toEqual(['mcp_servers']);
			expect(Object.keys(cfg.mcp_servers)).toEqual([MCP_SERVER_NAME]);
			expect(cfg.mcp_servers[MCP_SERVER_NAME]).toEqual({
				command: hostile.command,
				args: hostile.args,
				env: hostile.env,
				enabled: true,
			});
		});

		it('gives each profile root its own file and never addresses the account config', () => {
			const a = buildMcpInjection(production, bridge, at('/tmp/maestro-mcp-profile-a'));
			const b = buildMcpInjection(production, bridge, at('/tmp/maestro-mcp-profile-b'));
			expect(a.files[0].path).not.toBe(b.files[0].path);
			for (const inj of [a, b]) {
				const target = inj.env.GROK_CONFIG_PATH;
				expect(inj.files.map((f) => f.path)).toEqual([target]);
				expect(target).not.toMatch(/(^~|\/\.grok\/|\/home\/|^\/Users\/)/);
			}
		});

		it('copies no credential into the overlay: only the bridge env, with the proof as a path', () => {
			const token = 'a'.repeat(64);
			const inj = buildMcpInjection(production, bridge, at(ownedRoot));
			const serialized = JSON.stringify(inj);
			expect(serialized).not.toContain(token);
			expect(serialized).not.toMatch(/XAI_API_KEY|GROK_API_KEY|Authorization|Bearer/i);
			expect(inj.files[0].content).toContain('MAESTRO_PLUGIN_RUN_TOKEN_FILE');
		});

		it('leaves the Grok argv as the caller built it', () => {
			const args = ['agent', 'stdio'];
			const inj = buildMcpInjection(production, bridge, at(ownedRoot));
			expect(mergeMcpInjectionArgs(production, args, inj.globalArgs)).toEqual(args);
		});
	});

	describe('mcpInjectionProblem - the one admission rule', () => {
		it('refuses the production entry for every version: nothing is qualified yet', () => {
			for (const version of [undefined, null, '', '0.1.200', '9.9.9']) {
				expect(mcpInjectionProblem(production, { version })).toBe('unverified');
			}
		});

		it('refuses an agent with no strategy', () => {
			expect(mcpInjectionProblem(undefined, { version: '0.1.200' })).toBe('no-strategy');
		});

		it('admits only an exactly listed version, never an assumed range or an unknown one', () => {
			expect(mcpInjectionProblem(qualified, { version: '0.1.200' })).toBeUndefined();
			expect(mcpInjectionProblem(qualified, { version: '  0.1.200\n' })).toBeUndefined();
			for (const version of [
				undefined,
				null,
				'',
				'   ',
				'0.1.201',
				'0.1.20',
				'0.1.200-beta',
				'v0.1.200',
			]) {
				expect(mcpInjectionProblem(qualified, { version })).toBe('version-unqualified');
			}
			expect(
				mcpInjectionProblem({ ...qualified, qualifiedVersions: [] }, { version: '0.1.200' })
			).toBe('version-unqualified');
		});

		it('refuses a remote target, so no owned file lands on the wrong machine', () => {
			expect(mcpInjectionProblem(qualified, { version: '0.1.200', remote: true })).toBe(
				'remote-unsupported'
			);
		});

		it("refuses rather than replacing a GROK_CONFIG_PATH the user's environment already names", () => {
			expect(
				mcpInjectionProblem(qualified, {
					version: '0.1.200',
					env: { GROK_CONFIG_PATH: '/Users/me/.grok/work.toml' },
				})
			).toBe('config-path-conflict');
		});

		it('treats a blank GROK_CONFIG_PATH as unset, and other variables as irrelevant', () => {
			for (const value of [undefined, '', '   ']) {
				expect(
					mcpInjectionProblem(qualified, {
						version: '0.1.200',
						env: { GROK_CONFIG_PATH: value, XAI_API_KEY: 'secret', OPENCODE_CONFIG: '/x' },
					})
				).toBeUndefined();
			}
		});

		it('checks verification before version, and version before the target', () => {
			expect(mcpInjectionProblem(production, { version: '0.1.200', remote: true })).toBe(
				'unverified'
			);
			expect(mcpInjectionProblem(qualified, { version: '1.0.0', remote: true })).toBe(
				'version-unqualified'
			);
		});
	});

	describe('MCP_CONFIG_BY_AGENT.grok', () => {
		it('stays unverified with no qualified version, pinned to its schema source', () => {
			expect(production).toMatchObject({
				strategy: 'grok-config-overlay',
				verified: false,
				envVar: 'GROK_CONFIG_PATH',
				fileName: 'config.toml',
				qualifiedVersions: [],
			});
			expect(production.schemaSource).toMatch(/^xai-org\/grok-build@[0-9a-f]{40}$/);
		});

		it('proves required plugin tools only by host observation, and is the only entry that does', () => {
			expect(production.toolEvidence).toBe('observed');
			for (const [id, cap] of Object.entries(MCP_CONFIG_BY_AGENT)) {
				if (id !== 'grok') expect(cap.toolEvidence).toBeUndefined();
			}
		});
	});
});
