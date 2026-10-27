/**
 * The Claude Code and Codex MCP config writers under the install ceiling
 * (MRC2-04-08A), over the real installers in a scratch home and the real
 * policy source: standalone each writes its entry as before and nothing is
 * digested; enrolled with no ceiling the write is refused `unavailable` with
 * the configuration file untouched; a ceiling that pins the server script but
 * grants the server to no agent refuses `server-denied`; a grant on a route
 * the provider has no managed enforcement on refuses `route-unsupported`; the
 * pinned script with a grant on the enforced route writes the entry for that
 * agent only; other script bytes refuse `digest-mismatch`. A refused write
 * never creates the file and never changes an existing one.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { createInstallPolicySource } from '../../../../main/enterprise/install-policy';
import type { IdentityRead } from '../../../../main/enterprise/identity-store';
import { claudeCodeInstaller } from '../../../../main/coworking/installers/claude-code';
import { codexInstaller } from '../../../../main/coworking/installers/codex';
import { factoryDroidInstaller } from '../../../../main/coworking/installers/factory-droid';
import { opencodeInstaller } from '../../../../main/coworking/installers/opencode';
import {
	holdMcpServerWrite,
	mcpServerScriptPath,
	setMcpInstallAuthority,
} from '../../../../main/coworking/installers/managed';

const SCRIPT = '// the bundled coworking MCP server\nconsole.log("hello");\n';
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const none: IdentityRead = { status: 'none' };
const enrolled: IdentityRead = { status: 'ok', record: {} as never, epoch: 1 };
const grant = (agentId: string, route = 'child-process') => ({
	agentId,
	server: 'maestro-coworking',
	route,
});

describe('coworking MCP writers under the install ceiling', () => {
	let tmpHome: string;
	let scriptPath: string;
	let read: IdentityRead;
	let source: ReturnType<typeof createInstallPolicySource>;
	const env: Record<string, string | undefined> = {};

	beforeEach(() => {
		tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-coworking-managed-'));
		for (const key of ['HOME', 'USERPROFILE']) {
			env[key] = process.env[key];
			process.env[key] = tmpHome;
		}
		scriptPath = path.join(tmpHome, 'coworking-mcp-server.js');
		fs.writeFileSync(scriptPath, SCRIPT);
		read = none;
		source = createInstallPolicySource({
			identity: { read: () => read },
			policy: () => ({ appliedRevision: 3 }),
		});
		setMcpInstallAuthority(source);
	});

	afterEach(() => {
		setMcpInstallAuthority(null);
		for (const key of ['HOME', 'USERPROFILE']) {
			if (env[key] === undefined) delete process.env[key];
			else process.env[key] = env[key];
		}
		fs.rmSync(tmpHome, { recursive: true, force: true });
	});

	const spec = () => ({
		command: '/usr/local/bin/node',
		args: [scriptPath],
		env: { MAESTRO_COWORKING_SOCKET: '/tmp/maestro-coworking.sock' },
	});
	const claudeConfig = () => path.join(tmpHome, '.claude.json');
	const codexConfig = () => path.join(tmpHome, '.codex', 'config.toml');
	const pinned = (bytes = SCRIPT) => ({
		artifact: 'coworking-mcp-server',
		file: 'coworking-mcp-server.js',
		sha256: sha(bytes),
		source: null,
	});

	it('names the script the entry points at', () => {
		expect(mcpServerScriptPath(spec())).toBe(scriptPath);
		expect(mcpServerScriptPath({ command: '/x/server.js', args: [], env: {} })).toBe(
			'/x/server.js'
		);
	});

	it('standalone: both installers write their entry as before', async () => {
		await claudeCodeInstaller.install(spec());
		await codexInstaller.install(spec());
		expect(
			JSON.parse(fs.readFileSync(claudeConfig(), 'utf8')).mcpServers['maestro-coworking']
		).toEqual(spec());
		expect(fs.readFileSync(codexConfig(), 'utf8')).toContain('[mcp_servers.maestro-coworking]');
		// Nothing was held: a standalone host never needs the script on disk.
		fs.rmSync(scriptPath);
		await expect(claudeCodeInstaller.install(spec())).resolves.toBeUndefined();
	});

	it('enrolled with no ceiling: refused unavailable, no file created', async () => {
		read = enrolled;
		const refusal =
			/^\[managed-unavailable\] the managed install ceiling is unavailable \(no install ceiling is installed for policy revision 3\)$/;
		await expect(claudeCodeInstaller.install(spec())).rejects.toThrow(refusal);
		await expect(codexInstaller.install(spec())).rejects.toThrow(refusal);
		expect(fs.existsSync(claudeConfig())).toBe(false);
		expect(fs.existsSync(path.join(tmpHome, '.codex'))).toBe(false);
	});

	it('a pinned script with no grant: refused server-denied, an existing file untouched', async () => {
		read = enrolled;
		source.install({ policyRevision: 3, pins: [pinned()] });
		const seed = '{\n  // user comment\n  "theme": "dark"\n}\n';
		fs.writeFileSync(claudeConfig(), seed);
		await expect(claudeCodeInstaller.install(spec())).rejects.toThrow(
			/^\[managed-server-denied\] the install ceiling grants the maestro-coworking MCP server for claude-code on no route; for the operator no MCP entry is written$/
		);
		expect(fs.readFileSync(claudeConfig(), 'utf8')).toBe(seed);
		await expect(codexInstaller.install(spec())).rejects.toThrow(/^\[managed-server-denied\]/);
		expect(fs.existsSync(codexConfig())).toBe(false);
	});

	it('a grant on a route without managed enforcement: refused route-unsupported, nothing written', async () => {
		read = enrolled;
		source.install({
			policyRevision: 3,
			pins: [pinned()],
			mcpServers: [grant('claude-code', 'pty'), grant('codex', 'codex-app-server')],
		});
		await expect(claudeCodeInstaller.install(spec())).rejects.toThrow(
			/^\[managed-route-unsupported\] the maestro-coworking MCP server for claude-code is granted on pty, where claude-code has no managed enforcement in this build/
		);
		await expect(codexInstaller.install(spec())).rejects.toThrow(
			/^\[managed-route-unsupported\] .* granted on codex-app-server/
		);
		expect(fs.existsSync(claudeConfig())).toBe(false);
		expect(fs.existsSync(codexConfig())).toBe(false);
	});

	it('the pinned script granted on the enforced route: written for that agent only', async () => {
		read = enrolled;
		source.install({
			policyRevision: 3,
			pins: [pinned()],
			mcpServers: [grant('claude-code')],
		});
		const actor = { kind: 'transport', actor: { peer: 'host-secret' } } as const;
		await claudeCodeInstaller.install(spec(), { actor });
		expect(
			JSON.parse(fs.readFileSync(claudeConfig(), 'utf8')).mcpServers['maestro-coworking']
		).toEqual(spec());
		await expect(codexInstaller.install(spec(), { actor })).rejects.toThrow(
			/^\[managed-server-denied\] .* for maestro-cli no MCP entry is written$/
		);
		expect(fs.existsSync(codexConfig())).toBe(false);
		// The hold itself answers the same way, by the transport named.
		expect(() => holdMcpServerWrite('claude-code', spec(), { actor })).not.toThrow();
		expect(() => holdMcpServerWrite('codex', spec(), { actor })).toThrow(
			/^\[managed-server-denied\]/
		);
	});

	it('other script bytes: refused digest-mismatch before the file is read', async () => {
		read = enrolled;
		source.install({
			policyRevision: 3,
			pins: [pinned(`${SCRIPT}// tampered\n`)],
			mcpServers: [grant('claude-code'), grant('codex')],
		});
		await expect(claudeCodeInstaller.install(spec())).rejects.toThrow(
			/^\[managed-digest-mismatch\] the bytes of coworking-mcp-server coworking-mcp-server\.js \(sha256 [a-f0-9]{64}\) are not the pinned ones/
		);
		await expect(codexInstaller.install(spec())).rejects.toThrow(/^\[managed-digest-mismatch\]/);
		expect(fs.existsSync(claudeConfig())).toBe(false);
		expect(fs.existsSync(codexConfig())).toBe(false);
		// The script the entry would launch is read only when a pin asks: unpinned, no bytes are read.
		source.install({ policyRevision: 3, pins: [], mcpServers: [grant('claude-code')] });
		fs.rmSync(scriptPath);
		await expect(claudeCodeInstaller.install(spec())).rejects.toThrow(
			/^\[managed-unpinned\] the install ceiling pins no coworking-mcp-server coworking-mcp-server\.js;/
		);
	});

	// MRC2-04-08B: the OpenCode and Factory Droid writers hold the same way.
	describe('the OpenCode and Factory Droid writers', () => {
		let xdg: string | undefined;
		beforeEach(() => {
			xdg = process.env.XDG_CONFIG_HOME;
			delete process.env.XDG_CONFIG_HOME;
		});
		afterEach(() => {
			if (xdg === undefined) delete process.env.XDG_CONFIG_HOME;
			else process.env.XDG_CONFIG_HOME = xdg;
		});
		const opencodeConfig = () => path.join(tmpHome, '.config', 'opencode', 'opencode.json');
		const droidConfig = () => path.join(tmpHome, '.factory', 'mcp.json');

		it('standalone: both write their entry as before, with no script on disk', async () => {
			fs.rmSync(scriptPath);
			await opencodeInstaller.install(spec());
			await factoryDroidInstaller.install(spec());
			expect(
				JSON.parse(fs.readFileSync(opencodeConfig(), 'utf8')).mcp['maestro-coworking']
			).toEqual({
				type: 'local',
				command: [spec().command, scriptPath],
				environment: spec().env,
				enabled: true,
			});
			expect(
				JSON.parse(fs.readFileSync(droidConfig(), 'utf8')).mcpServers['maestro-coworking']
			).toEqual({ type: 'stdio', ...spec() });
		});

		it('enrolled with no ceiling: both refused unavailable, no file created', async () => {
			read = enrolled;
			const refusal = /^\[managed-unavailable\] the managed install ceiling is unavailable/;
			await expect(opencodeInstaller.install(spec())).rejects.toThrow(refusal);
			await expect(factoryDroidInstaller.install(spec())).rejects.toThrow(refusal);
			expect(fs.existsSync(path.join(tmpHome, '.config'))).toBe(false);
			expect(fs.existsSync(path.join(tmpHome, '.factory'))).toBe(false);
		});

		it('the pinned script granted to opencode on the enforced route: written for opencode only, an existing droid file untouched', async () => {
			read = enrolled;
			source.install({
				policyRevision: 3,
				pins: [pinned()],
				mcpServers: [grant('opencode'), grant('factory-droid', 'pty')],
			});
			const seed = '{\n  // user comment\n  "mcpServers": {}\n}\n';
			fs.mkdirSync(path.dirname(droidConfig()), { recursive: true });
			fs.writeFileSync(droidConfig(), seed);
			const actor = { kind: 'transport', actor: { peer: 'host-secret' } } as const;
			await opencodeInstaller.install(spec(), { actor });
			expect(await opencodeInstaller.isInstalled()).toBe(true);
			await expect(factoryDroidInstaller.install(spec(), { actor })).rejects.toThrow(
				/^\[managed-route-unsupported\] the maestro-coworking MCP server for factory-droid is granted on pty/
			);
			expect(fs.readFileSync(droidConfig(), 'utf8')).toBe(seed);
			// Other script bytes refuse both before any file is read.
			source.install({
				policyRevision: 3,
				pins: [pinned(`${SCRIPT}// tampered\n`)],
				mcpServers: [grant('opencode'), grant('factory-droid')],
			});
			await expect(opencodeInstaller.install(spec())).rejects.toThrow(
				/^\[managed-digest-mismatch\]/
			);
			await expect(factoryDroidInstaller.install(spec())).rejects.toThrow(
				/^\[managed-digest-mismatch\]/
			);
			expect(fs.readFileSync(droidConfig(), 'utf8')).toBe(seed);
		});
	});
});
