/**
 * The install ceiling (MRC2-04-07): a closed, bounded document of pins (an
 * artifact, a bare file name, the SHA-256 of its bytes, one approved source);
 * one installed ceiling projected onto the standing the installer sinks hold
 * every fetch, extraction and run against; the pure verdict that follows a
 * pin's source before a byte is written and compares the bytes on disk with
 * the pin before anything is extracted, installed or run, with a receipt on
 * every managed answer and nothing at all on a standalone host; the headless
 * authority a bare maestro-cli holds with; and the order the desktop composes
 * it in, so a managed host's first fetch at startup is already held.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { IdentityRead } from '../../../main/enterprise/identity-store';
import {
	INSTALL_ARTIFACTS,
	INSTALL_CEILING_LIMITS,
	INSTALL_OPERATOR,
	InstallRefusedError,
	createInstallPolicySource,
	formatInstallRefusal,
	headlessInstallAuthority,
	installVerdict,
	isInstallFileName,
	isInstallSource,
	managedInstallStanding,
	mcpServerVerdict,
	parseInstallPolicyCeiling,
	type InstallPolicyCeiling,
	type InstallRequest,
	type ManagedInstallStanding,
	type McpServerRequest,
} from '../../../main/enterprise/install-policy';

const ZIP_SHA = 'a'.repeat(64);
const BIN_SHA = 'b'.repeat(64);
const SOURCE =
	'https://github.com/wakatime/wakatime-cli/releases/download/v1.73.1/wakatime-cli-darwin-arm64.zip';

function document(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		policyRevision: 3,
		pins: [
			{
				artifact: 'wakatime-cli',
				file: 'wakatime-cli-darwin-arm64.zip',
				sha256: ZIP_SHA,
				source: SOURCE,
			},
			{ artifact: 'wakatime-cli', file: 'wakatime-cli-darwin-arm64', sha256: BIN_SHA },
			{ artifact: 'maestro-cli', file: 'maestro-cli.js', sha256: 'c'.repeat(64), source: null },
		],
		...overrides,
	};
}

function problemsOf(raw: unknown): readonly string[] {
	const parsed = parseInstallPolicyCeiling(raw);
	return parsed.ok ? [] : parsed.problems;
}

function ceilingOf(raw: Record<string, unknown> = document()): InstallPolicyCeiling {
	const parsed = parseInstallPolicyCeiling(raw);
	if (!parsed.ok) throw new Error(parsed.problems.join('; '));
	return parsed.ceiling;
}

const managed = (ceiling = ceilingOf()): ManagedInstallStanding => ({
	standing: 'managed',
	ceiling,
	policyRevision: ceiling.policyRevision,
});

function request(overrides: Partial<InstallRequest> = {}): InstallRequest {
	return {
		artifact: 'wakatime-cli',
		file: 'wakatime-cli-darwin-arm64.zip',
		stage: 'fetch',
		actor: INSTALL_OPERATOR,
		...overrides,
	};
}

const pinOf = (document: Record<string, unknown>, index: number) =>
	(document.pins as Record<string, unknown>[])[index];

describe('parseInstallPolicyCeiling', () => {
	it('accepts a complete document as a fresh value the input cannot reach', () => {
		const raw = document();
		const parsed = parseInstallPolicyCeiling(raw);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.ceiling.policyRevision).toBe(3);
		expect(parsed.ceiling.pins).toEqual([
			{
				artifact: 'wakatime-cli',
				file: 'wakatime-cli-darwin-arm64.zip',
				sha256: ZIP_SHA,
				source: SOURCE,
			},
			{
				artifact: 'wakatime-cli',
				file: 'wakatime-cli-darwin-arm64',
				sha256: BIN_SHA,
				source: null,
			},
			{ artifact: 'maestro-cli', file: 'maestro-cli.js', sha256: 'c'.repeat(64), source: null },
		]);
		(raw.pins as unknown[]).push({
			artifact: 'maestro-cli',
			file: 'evil.js',
			sha256: 'd'.repeat(64),
		});
		pinOf(raw, 0).sha256 = 'e'.repeat(64);
		expect(parsed.ceiling.pins).toHaveLength(3);
		expect(parsed.ceiling.pins[0].sha256).toBe(ZIP_SHA);
	});

	it('admits an empty pin list (nothing is fetched or run)', () => {
		expect(parseInstallPolicyCeiling({ policyRevision: 0, pins: [] })).toEqual({
			ok: true,
			ceiling: { policyRevision: 0, pins: [], mcpServers: [] },
		});
	});

	it('names every problem by path and refuses the whole document on one', () => {
		expect(problemsOf(null)).toEqual(['the install ceiling is not an object']);
		expect(problemsOf(document({ extra: 1 }))).toEqual(['extra is not a known key']);
		expect(problemsOf(document({ policyRevision: -1 }))).toEqual([
			'policyRevision is not a policy revision',
		]);
		expect(problemsOf(document({ policyRevision: '3' }))).toContain(
			'policyRevision is not a policy revision'
		);
		expect(problemsOf(document({ pins: {} }))).toEqual(['pins is not an array']);
		const many = Array.from({ length: INSTALL_CEILING_LIMITS.pins + 1 }, (_, i) => ({
			artifact: 'maestro-cli',
			file: `f${i}.js`,
			sha256: 'c'.repeat(64),
		}));
		expect(problemsOf(document({ pins: many }))).toEqual([
			`pins exceeds ${INSTALL_CEILING_LIMITS.pins} entries`,
		]);
		expect(problemsOf(document({ pins: ['x'] }))).toEqual(['pins[0] is not an object']);
		const bad = document({
			pins: [
				{ artifact: 'npm', file: '../x.zip', sha256: 'A'.repeat(64), source: 'http://a/b', why: 1 },
			],
		});
		expect(problemsOf(bad)).toEqual([
			'pins[0].why is not a known key',
			'pins[0].artifact is not an install artifact',
			'pins[0].file is not a bare file name',
			'pins[0].sha256 is not a lowercase hex SHA-256',
			'pins[0].source is not an https URL without credentials or a fragment',
		]);
		const twice = document();
		pinOf(twice, 1).file = 'wakatime-cli-darwin-arm64.zip';
		pinOf(twice, 1).source = SOURCE;
		expect(problemsOf(twice)).toEqual([
			'pins[1] names wakatime-cli wakatime-cli-darwin-arm64.zip twice',
		]);
	});

	it('pins the spec tool prompts, and the same bare name from several sources (MRC2-04-08)', () => {
		expect(INSTALL_ARTIFACTS).toEqual([
			'wakatime-cli',
			'maestro-cli',
			'speckit-prompts',
			'openspec-prompts',
			'bmad-prompts',
			'marketplace-playbooks',
			'coworking-mcp-server',
			'playbook-archive',
			'cue-backup',
		]);
		const base = 'https://raw.githubusercontent.com/bmad-code-org/BMAD-METHOD/v6.2.0';
		const parsed = parseInstallPolicyCeiling({
			policyRevision: 1,
			pins: [
				{
					artifact: 'speckit-prompts',
					file: 'plan.md',
					sha256: 'a'.repeat(64),
					source:
						'https://raw.githubusercontent.com/github/spec-kit/v0.0.90/templates/commands/plan.md',
				},
				{
					artifact: 'bmad-prompts',
					file: 'workflow.md',
					sha256: 'b'.repeat(64),
					source: `${base}/src/core/skills/bmad-help/workflow.md`,
				},
				{
					artifact: 'bmad-prompts',
					file: 'workflow.md',
					sha256: 'c'.repeat(64),
					source: `${base}/src/core/tasks/bmad-create-prd/workflow.md`,
				},
			],
		});
		expect(parsed.ok).toBe(true);
		if (parsed.ok) expect(parsed.ceiling.pins).toHaveLength(3);
	});

	it('bounds a file to one bare name and a source to one clean https URL', () => {
		expect(isInstallFileName('wakatime-cli-linux-amd64.zip')).toBe(true);
		for (const file of [
			'',
			' x.zip',
			'x.zip ',
			'a/b.zip',
			'a\\b.zip',
			'.',
			'..',
			'a\nb',
			'a\u0000',
		])
			expect(isInstallFileName(file), JSON.stringify(file)).toBe(false);
		expect(isInstallFileName('f'.repeat(INSTALL_CEILING_LIMITS.fileLength + 1))).toBe(false);
		expect(isInstallSource(SOURCE)).toBe(true);
		for (const source of [
			'',
			'http://github.com/x.zip',
			'https://user:pw@github.com/x.zip',
			'https://github.com/x.zip#frag',
			' https://github.com/x.zip',
			'https://github.com/x y.zip',
			'ftp://github.com/x.zip',
			'github.com/x.zip',
		])
			expect(isInstallSource(source), JSON.stringify(source)).toBe(false);
		expect(isInstallSource(`https://h/${'p'.repeat(INSTALL_CEILING_LIMITS.sourceLength)}`)).toBe(
			false
		);
	});
});

describe('managedInstallStanding', () => {
	it('is standalone while unenrolled and names why a ceiling is unavailable', () => {
		const ceiling = ceilingOf();
		expect(managedInstallStanding({ enrolled: false, policy: null, ceiling })).toEqual({
			standing: 'standalone',
		});
		expect(managedInstallStanding({ enrolled: true, policy: null, ceiling })).toEqual({
			standing: 'managed',
			ceiling: null,
			policyRevision: null,
			reason: 'no applied policy revision is known for this host',
		});
		expect(
			managedInstallStanding({ enrolled: true, policy: { appliedRevision: 3 }, ceiling: null })
		).toMatchObject({
			ceiling: null,
			reason: 'no install ceiling is installed for policy revision 3',
		});
		expect(
			managedInstallStanding({ enrolled: true, policy: { appliedRevision: 4 }, ceiling })
		).toMatchObject({
			ceiling: null,
			policyRevision: 4,
			reason: expect.stringContaining('revision 3'),
		});
		expect(
			managedInstallStanding({ enrolled: true, policy: { appliedRevision: 3 }, ceiling })
		).toEqual({ standing: 'managed', ceiling, policyRevision: 3 });
	});
});

describe('installVerdict', () => {
	it('allows everything standalone, with no pin, no receipt and no digest read', () => {
		const digest = vi.fn(() => ZIP_SHA);
		expect(
			installVerdict({ standing: 'standalone' }, request({ stage: 'execute', digest }))
		).toEqual({
			allowed: true,
		});
		expect(digest).not.toHaveBeenCalled();
	});

	it('refuses unauthenticated, then unavailable, with a receipt', () => {
		const unauthenticated = installVerdict(managed(), request(), [
			'device d1 has no registered actor',
		]);
		expect(unauthenticated).toMatchObject({
			allowed: false,
			code: 'unauthenticated',
			message: 'device d1 has no registered actor',
			managed: {
				policyRevision: 3,
				stage: 'fetch',
				actor: 'the operator',
				outcome: 'unauthenticated',
			},
		});
		const unavailable = installVerdict(
			{ standing: 'managed', ceiling: null, policyRevision: 5, reason: 'none for revision 5' },
			request()
		);
		expect(unavailable).toMatchObject({
			allowed: false,
			code: 'unavailable',
			message: 'the managed install ceiling is unavailable (none for revision 5)',
			managed: { policyRevision: 5, source: null, expected: null, actual: null },
		});
	});

	it('refuses a file with no pin, and a fetch of a pin with no source, without reading bytes', () => {
		const digest = vi.fn(() => ZIP_SHA);
		const unpinned = installVerdict(
			managed(),
			request({ file: 'wakatime-cli-linux-amd64.zip', stage: 'execute', digest })
		);
		expect(unpinned).toMatchObject({ allowed: false, code: 'unpinned' });
		expect(digest).not.toHaveBeenCalled();
		if (unpinned.allowed) return;
		expect(formatInstallRefusal(unpinned)).toMatch(
			/^\[managed-unpinned\] the install ceiling pins no wakatime-cli wakatime-cli-linux-amd64\.zip; for the operator only/
		);
		const verifyOnly = installVerdict(
			managed(),
			request({ artifact: 'maestro-cli', file: 'maestro-cli.js' })
		);
		expect(verifyOnly).toMatchObject({
			allowed: false,
			code: 'unpinned',
			message: expect.stringContaining('pinned for verification only'),
			managed: { expected: 'c'.repeat(64), source: null },
		});
	});

	it('matches a sink-named source exactly, and refuses an ambiguous bare name the sink does not qualify', () => {
		const base = 'https://raw.githubusercontent.com/bmad-code-org/BMAD-METHOD/v6.2.0';
		const help = `${base}/src/core/skills/bmad-help/workflow.md`;
		const prd = `${base}/src/core/tasks/bmad-create-prd/workflow.md`;
		const ceiling = ceilingOf({
			policyRevision: 3,
			pins: [
				{ artifact: 'bmad-prompts', file: 'workflow.md', sha256: ZIP_SHA, source: help },
				{ artifact: 'bmad-prompts', file: 'workflow.md', sha256: BIN_SHA, source: prd },
			],
		});
		const workflow = request({ artifact: 'bmad-prompts', file: 'workflow.md' });
		expect(installVerdict(managed(ceiling), { ...workflow, source: prd })).toMatchObject({
			allowed: true,
			pin: { sha256: BIN_SHA, source: prd },
			managed: { source: prd, expected: BIN_SHA, outcome: 'within-ceiling' },
		});
		expect(
			installVerdict(managed(ceiling), {
				...workflow,
				source: `${base}/src/other/workflow.md`,
			})
		).toMatchObject({
			allowed: false,
			code: 'unpinned',
			message: `the install ceiling pins no bmad-prompts workflow.md from ${base}/src/other/workflow.md; for the operator only a file the policy pins by digest is fetched or run`,
		});
		expect(installVerdict(managed(ceiling), workflow)).toMatchObject({
			allowed: false,
			code: 'unpinned',
			message: expect.stringContaining('from 2 sources and the sink names none'),
		});
		// The bytes of a sourced fetch are held against that source's pin, not the first one.
		const digest = vi.fn(() => BIN_SHA);
		expect(
			installVerdict(managed(ceiling), { ...workflow, stage: 'execute', digest, source: prd })
		).toMatchObject({ allowed: true, managed: { actual: BIN_SHA } });
		expect(
			installVerdict(managed(ceiling), { ...workflow, stage: 'execute', digest, source: help })
		).toMatchObject({ allowed: false, code: 'digest-mismatch', managed: { expected: ZIP_SHA } });
		// A refusal a sink cannot answer in a result is thrown by code with its receipt.
		const refused = installVerdict(managed(ceiling), workflow);
		if (refused.allowed) throw new Error('expected a refusal');
		const error = new InstallRefusedError(refused);
		expect(error).toBeInstanceOf(Error);
		expect(error.name).toBe('InstallRefusedError');
		expect(error.code).toBe('unpinned');
		expect(error.receipt).toBe(refused.managed);
		expect(error.message).toMatch(/^\[managed-unpinned\] the install ceiling pins bmad-prompts/);
	});

	it('admits a fetch with the pin to follow and a receipt naming the source', () => {
		expect(installVerdict(managed(), request())).toEqual({
			allowed: true,
			pin: {
				artifact: 'wakatime-cli',
				file: 'wakatime-cli-darwin-arm64.zip',
				sha256: ZIP_SHA,
				source: SOURCE,
			},
			managed: {
				policyRevision: 3,
				artifact: 'wakatime-cli',
				file: 'wakatime-cli-darwin-arm64.zip',
				stage: 'fetch',
				actor: 'the operator',
				source: SOURCE,
				expected: ZIP_SHA,
				actual: null,
				outcome: 'within-ceiling',
			},
		});
	});

	it('holds an execute to the bytes: no bytes, other bytes, the pinned bytes', () => {
		const binary = { file: 'wakatime-cli-darwin-arm64', stage: 'execute' as const };
		expect(installVerdict(managed(), request({ ...binary, digest: null }))).toMatchObject({
			allowed: false,
			code: 'digest-mismatch',
			message: expect.stringContaining('has no bytes to digest (a name on PATH)'),
			managed: { expected: BIN_SHA, actual: null, outcome: 'digest-mismatch' },
		});
		expect(installVerdict(managed(), request({ ...binary, digest: () => ZIP_SHA }))).toMatchObject({
			allowed: false,
			code: 'digest-mismatch',
			message: `the bytes of wakatime-cli wakatime-cli-darwin-arm64 (sha256 ${ZIP_SHA}) are not the pinned ones (${BIN_SHA}); nothing is extracted, installed or run for the operator`,
			managed: { expected: BIN_SHA, actual: ZIP_SHA },
		});
		const actor = { kind: 'transport', actor: { peer: 'host-secret' } } as const;
		expect(
			installVerdict(managed(), request({ ...binary, digest: () => BIN_SHA, actor }))
		).toMatchObject({
			allowed: true,
			pin: { file: 'wakatime-cli-darwin-arm64', source: null },
			managed: {
				actor: 'maestro-cli',
				expected: BIN_SHA,
				actual: BIN_SHA,
				outcome: 'within-ceiling',
			},
		});
	});
});

describe('createInstallPolicySource', () => {
	const none: IdentityRead = { status: 'none' };
	const enrolled: IdentityRead = { status: 'ok', record: {} as never, epoch: 1 };

	it('installs, keeps on a refused document, clears, and holds under the enrollment rule', () => {
		let read: IdentityRead = none;
		const source = createInstallPolicySource({
			identity: { read: () => read },
			policy: () => ({ appliedRevision: 3 }),
		});
		expect(source.standing()).toEqual({ standing: 'standalone' });
		expect(source.authorize(request())).toEqual({ allowed: true });
		read = enrolled;
		expect(source.authorize(request())).toMatchObject({ allowed: false, code: 'unavailable' });
		expect(source.install(document())).toEqual({ installed: true, policyRevision: 3 });
		expect(source.installed()?.pins).toHaveLength(3);
		expect(source.install(document({ pins: 'x' }))).toEqual({
			installed: false,
			problems: ['pins is not an array'],
		});
		expect(source.installed()?.policyRevision).toBe(3);
		expect(source.authorize(request())).toMatchObject({ allowed: true, pin: { source: SOURCE } });
		source.clear();
		expect(source.installed()).toBeNull();
		expect(source.authorize(request())).toMatchObject({ allowed: false, code: 'unavailable' });
	});

	it('answers a download sink and an MCP writer from one document, and follows the revision the host is under (MRC2-04-12)', () => {
		let revision = 3;
		const source = createInstallPolicySource({
			identity: { read: () => enrolled },
			policy: () => ({ appliedRevision: revision }),
		});
		const grant = { agentId: 'claude-code', server: 'maestro-coworking', route: 'child-process' };
		expect(source.install(document({ mcpServers: [grant] }))).toEqual({
			installed: true,
			policyRevision: 3,
		});
		const digest = vi.fn(() => ZIP_SHA);
		const server = (over: Partial<McpServerRequest> = {}): McpServerRequest => ({
			agentId: 'claude-code',
			server: 'maestro-coworking',
			actor: INSTALL_OPERATOR,
			...over,
		});

		// The download sink (WakaTime): a zip the ceiling does not pin is refused
		// at the fetch stage before any byte is requested or written, and at the
		// execute stage before its bytes are digested; the pinned zip is admitted
		// with the source it must download from, and its bytes are held on extract.
		const unpinned = request({ file: 'wakatime-cli-linux-amd64.zip' });
		expect(source.authorize(unpinned)).toMatchObject({
			allowed: false,
			code: 'unpinned',
			managed: { stage: 'fetch', source: null, expected: null, actual: null },
		});
		expect(source.authorize({ ...unpinned, stage: 'execute', digest })).toMatchObject({
			allowed: false,
			code: 'unpinned',
		});
		expect(digest).not.toHaveBeenCalled();
		expect(source.authorize(request())).toMatchObject({
			allowed: true,
			pin: { source: SOURCE, sha256: ZIP_SHA },
			managed: { stage: 'fetch', source: SOURCE },
		});
		expect(source.authorize(request({ stage: 'execute', digest }))).toMatchObject({
			allowed: true,
			managed: { stage: 'execute', actual: ZIP_SHA, outcome: 'within-ceiling' },
		});
		expect(digest).toHaveBeenCalledTimes(1);

		// The MCP writer: the grant binds the one agent and server it names; any
		// other entry is refused server-denied and nothing is written.
		expect(source.authorizeMcpServer(server())).toMatchObject({
			allowed: true,
			grant,
			managed: { route: 'child-process', outcome: 'within-ceiling' },
		});
		expect(source.authorizeMcpServer(server({ agentId: 'codex' }))).toMatchObject({
			allowed: false,
			code: 'server-denied',
			managed: { agentId: 'codex', route: null, outcome: 'server-denied' },
		});
		expect(source.authorizeMcpServer(server({ server: 'other-server' }))).toMatchObject({
			allowed: false,
			code: 'server-denied',
		});

		// A revision the host moved past leaves the installed document behind:
		// both sinks are refused unavailable, by name, until a new one lands.
		revision = 4;
		expect(source.authorize(request())).toMatchObject({
			allowed: false,
			code: 'unavailable',
			message: expect.stringContaining('revision 3'),
			managed: { policyRevision: 4 },
		});
		expect(source.authorizeMcpServer(server())).toMatchObject({
			allowed: false,
			code: 'unavailable',
			managed: { policyRevision: 4 },
		});
		expect(source.install(document({ policyRevision: 4 }))).toEqual({
			installed: true,
			policyRevision: 4,
		});
		expect(source.authorize(request())).toMatchObject({
			allowed: true,
			managed: { policyRevision: 4 },
		});
		// The new document grants no server, so the writer is refused again.
		expect(source.authorizeMcpServer(server())).toMatchObject({
			allowed: false,
			code: 'server-denied',
			managed: { policyRevision: 4 },
		});
	});

	it('refuses a paired device with no registered actor before reading the ceiling', () => {
		const source = createInstallPolicySource({
			identity: { read: () => enrolled },
			policy: () => ({ appliedRevision: 3 }),
		});
		source.install(document());
		const device = {
			kind: 'transport',
			actor: { peer: 'device-pairing', deviceId: 'd1' },
		} as const;
		expect(source.authorize(request({ actor: device }))).toMatchObject({
			allowed: false,
			code: 'unauthenticated',
		});
	});
});

describe('mcpServers grants and mcpServerVerdict (MRC2-04-08A)', () => {
	const grant = { agentId: 'claude-code', server: 'maestro-coworking', route: 'child-process' };
	const request = (overrides: Partial<McpServerRequest> = {}): McpServerRequest => ({
		agentId: 'claude-code',
		server: 'maestro-coworking',
		actor: INSTALL_OPERATOR,
		...overrides,
	});

	it('parses the grant clause as a fresh value, absent means none, and names every problem', () => {
		const parsed = parseInstallPolicyCeiling(document({ mcpServers: [grant] }));
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.ceiling.mcpServers).toEqual([grant]);
		expect(parsed.ceiling.mcpServers[0]).not.toBe(grant);
		expect(ceilingOf().mcpServers).toEqual([]);
		expect(problemsOf(document({ mcpServers: {} }))).toEqual(['mcpServers is not an array']);
		const many = Array.from({ length: INSTALL_CEILING_LIMITS.mcpServers + 1 }, (_, i) => ({
			...grant,
			server: `s${i}`,
		}));
		expect(problemsOf(document({ mcpServers: many }))).toEqual([
			`mcpServers exceeds ${INSTALL_CEILING_LIMITS.mcpServers} entries`,
		]);
		expect(problemsOf(document({ mcpServers: ['x'] }))).toEqual(['mcpServers[0] is not an object']);
		expect(
			problemsOf(
				document({
					mcpServers: [{ agentId: '', server: 'a/b', route: 'http', why: 1 }],
				})
			)
		).toEqual([
			'mcpServers[0].why is not a known key',
			'mcpServers[0].agentId is not an agent id',
			'mcpServers[0].server is not a server name',
			'mcpServers[0].route is not a managed route',
		]);
		expect(problemsOf(document({ mcpServers: [grant, { ...grant }] }))).toEqual([
			'mcpServers[1] names maestro-coworking for claude-code on child-process twice',
		]);
	});

	it('allows standalone with no receipt; refuses unauthenticated, then unavailable', () => {
		expect(mcpServerVerdict({ standing: 'standalone' }, request())).toEqual({ allowed: true });
		expect(mcpServerVerdict(managed(), request(), ['no registered actor'])).toMatchObject({
			allowed: false,
			code: 'unauthenticated',
			managed: { agentId: 'claude-code', server: 'maestro-coworking', route: null },
		});
		const unavailable: ManagedInstallStanding = {
			standing: 'managed',
			ceiling: null,
			policyRevision: 3,
			reason: 'no install ceiling is installed for policy revision 3',
		};
		expect(mcpServerVerdict(unavailable, request())).toMatchObject({
			allowed: false,
			code: 'unavailable',
			message:
				'the managed install ceiling is unavailable (no install ceiling is installed for policy revision 3)',
		});
	});

	it('refuses a server the ceiling grants to no agent, by name, with a receipt', () => {
		const decision = mcpServerVerdict(managed(), request());
		expect(decision).toEqual({
			allowed: false,
			code: 'server-denied',
			message:
				'the install ceiling grants the maestro-coworking MCP server for claude-code on no route; for the operator no MCP entry is written',
			managed: {
				policyRevision: 3,
				agentId: 'claude-code',
				server: 'maestro-coworking',
				route: null,
				actor: 'the operator',
				outcome: 'server-denied',
			},
		});
		// A grant for another agent, or another server, is not this one.
		const others = ceilingOf(
			document({
				mcpServers: [
					{ ...grant, agentId: 'codex' },
					{ ...grant, server: 'other-server' },
				],
			})
		);
		expect(mcpServerVerdict(managed(others), request())).toMatchObject({ code: 'server-denied' });
	});

	it('honors a grant only on a route the provider has managed enforcement on', () => {
		// claude-code runs over pty and ssh standalone, but only its child-process launch is admitted.
		const pty = ceilingOf(document({ mcpServers: [{ ...grant, route: 'pty' }] }));
		expect(mcpServerVerdict(managed(pty), request())).toMatchObject({
			allowed: false,
			code: 'route-unsupported',
			message:
				'the maestro-coworking MCP server for claude-code is granted on pty, where claude-code has no managed enforcement in this build; a grant that cannot be bound writes nothing',
			managed: { route: null, outcome: 'route-unsupported' },
		});
		// A provider with no batch mode has no enforced route at all.
		const gemini = ceilingOf(document({ mcpServers: [{ ...grant, agentId: 'gemini-cli' }] }));
		expect(mcpServerVerdict(managed(gemini), request({ agentId: 'gemini-cli' }))).toMatchObject({
			code: 'route-unsupported',
		});
		// The first enforced grant is the one bound; the receipt names its route.
		const both = ceilingOf(document({ mcpServers: [{ ...grant, route: 'ssh' }, grant] }));
		expect(mcpServerVerdict(managed(both), request())).toEqual({
			allowed: true,
			grant,
			managed: {
				policyRevision: 3,
				agentId: 'claude-code',
				server: 'maestro-coworking',
				route: 'child-process',
				actor: 'the operator',
				outcome: 'within-ceiling',
			},
		});
		// The route table is an input: a build that enforces ssh binds the ssh grant.
		const sshOnly = ceilingOf(document({ mcpServers: [{ ...grant, route: 'ssh' }] }));
		const enforcedSsh = () => [
			{
				agentId: 'claude-code',
				route: 'ssh',
				standalone: 'implemented',
				managed: 'implemented',
				note: '',
			},
		];
		expect(mcpServerVerdict(managed(sshOnly), request(), [], enforcedSsh as never)).toMatchObject({
			allowed: true,
			managed: { route: 'ssh' },
		});
	});

	it('is held by the source under the enrollment and paired-device rules, and names a refusal', () => {
		let read: IdentityRead = { status: 'none' };
		const source = createInstallPolicySource({
			identity: { read: () => read },
			policy: () => ({ appliedRevision: 3 }),
		});
		expect(source.authorizeMcpServer(request())).toEqual({ allowed: true });
		read = { status: 'ok', record: {} as never, epoch: 1 };
		expect(source.authorizeMcpServer(request())).toMatchObject({ code: 'unavailable' });
		source.install(document({ mcpServers: [grant] }));
		expect(source.authorizeMcpServer(request())).toMatchObject({ allowed: true, grant });
		const device = {
			kind: 'transport',
			actor: { peer: 'device-pairing', deviceId: 'd1' },
		} as const;
		const refused = source.authorizeMcpServer(request({ actor: device }));
		expect(refused).toMatchObject({ allowed: false, code: 'unauthenticated' });
		if (refused.allowed) return;
		const error = new InstallRefusedError(refused);
		expect(error.code).toBe('unauthenticated');
		expect(error.receipt).toMatchObject({
			server: 'maestro-coworking',
			outcome: 'unauthenticated',
		});
		expect(error.message.startsWith('[managed-unauthenticated] ')).toBe(true);
	});
});

describe('headlessInstallAuthority', () => {
	it('holds nothing standalone and refuses every install unavailable when enrolled', () => {
		const standalone = headlessInstallAuthority({
			standing: () => 'standalone',
			unavailableReason: null,
		});
		expect(standalone.authorize(request())).toEqual({ allowed: true });
		const enrolled = headlessInstallAuthority({
			standing: () => 'managed',
			unavailableReason: 'maestro-cli holds no attached host authority.',
		});
		expect(enrolled.authorize(request({ stage: 'execute', digest: () => ZIP_SHA }))).toMatchObject({
			allowed: false,
			code: 'unavailable',
			message:
				'the managed install ceiling is unavailable (maestro-cli holds no attached host authority.)',
			managed: { policyRevision: null, stage: 'execute' },
		});
	});
});

describe('desktop wiring (src/main/index.ts)', () => {
	const source = readFileSync(path.resolve(__dirname, '../../../main/index.ts'), 'utf8');

	it('composes one source beside the other ceilings and hands it to both managers', () => {
		expect(source.match(/createInstallPolicySource\(\{/g)).toHaveLength(1);
		expect(source).toMatch(
			/const installPolicy = createInstallPolicySource\(\{\n\t+identity: \{ read: \(\) => enterpriseService\?\.identity\.read\(\) \?\? \{ status: 'none' \} \},\n\t+policy: \(\) => enterpriseService\?\.policy\.status\(\) \?\? null,\n\t+\}\);/
		);
		expect(source).toContain('wakatimeManager.setInstallAuthority(installPolicy);');
		expect(source).toContain('maestroCliManager.setInstallAuthority(installPolicy);');
		// The three spec tool prompt refreshers hold with the same source (MRC2-04-08).
		expect(source).toContain('setSpecPromptInstallAuthority(installPolicy);');
		// Marketplace imports and the coworking MCP config writers too (MRC2-04-08A).
		expect(source).toContain('setMarketplaceInstallAuthority(installPolicy);');
		expect(source).toContain('setMcpInstallAuthority(installPolicy);');
	});

	it('runs the WakaTime startup install only after the enterprise service is composed', () => {
		const composed = source.indexOf('enterpriseService = createEnterpriseService({');
		const handed = source.indexOf('wakatimeManager.setInstallAuthority(installPolicy);');
		const startup = source.indexOf('wakatimeManager.ensureCliInstalled();');
		expect(composed).toBeGreaterThan(0);
		expect(handed).toBeGreaterThan(0);
		expect(handed).toBeLessThan(composed);
		expect(startup).toBeGreaterThan(composed);
		expect(source.match(/wakatimeManager\.ensureCliInstalled\(\);/g)).toHaveLength(2);
	});
});
