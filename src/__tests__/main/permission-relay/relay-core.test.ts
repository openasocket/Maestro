import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as net from 'net';
import {
	registerSpawn,
	lookupBinding,
	createPending,
	resolvePending,
	relayRegistryStats,
} from '../../../main/permission-relay/registry';
import { buildRelayArgs } from '../../../main/permission-relay/spawn-args';
import { parseQuestionRequest } from '../../../main/permission-relay/question-request';
import { PermissionRelayServer } from '../../../main/permission-relay/PermissionRelayServer';
import {
	RELAY_PERMISSION_PROMPT_TOOL,
	RELAY_MCP_SERVER_NAME,
} from '../../../main/permission-relay/types';
import type { PermissionRequest } from '../../../main/permission-relay/types';
import type { RelaySpawnBinding } from '../../../main/permission-relay/types';
import { claudeToolEffect, createRelayManagedGate } from '../../../main/enterprise/dispatch';
import { fakeAdmission, fakeSpawnPort, tableEffects } from '../../helpers/managedSpawnPort';

describe('permission-relay registry', () => {
	it('registers a spawn and looks up its binding', () => {
		const { token, cleanup } = registerSpawn({ sessionId: 's1', tabId: 't1' });
		expect(lookupBinding(token)).toEqual({ sessionId: 's1', tabId: 't1' });
		cleanup();
		expect(lookupBinding(token)).toBeUndefined();
	});

	it('generates unique tokens per spawn', () => {
		const a = registerSpawn({ sessionId: 's1' });
		const b = registerSpawn({ sessionId: 's1' });
		expect(a.token).not.toBe(b.token);
		a.cleanup();
		b.cleanup();
	});

	it('isolates spawns: cleaning up one leaves the other binding + pending intact', async () => {
		const a = registerSpawn({ sessionId: 'sA', tabId: 'tA' });
		const b = registerSpawn({ sessionId: 'sB', tabId: 'tB' });
		const aPending = createPending('req-a', a.token, 10_000);
		const bPending = createPending('req-b', b.token, 10_000);

		// Tearing down spawn A must not touch spawn B's binding or pending request.
		a.cleanup();
		expect(lookupBinding(a.token)).toBeUndefined();
		expect(lookupBinding(b.token)).toEqual({ sessionId: 'sB', tabId: 'tB' });

		// A's pending was denied by its cleanup; B's is still live and resolvable.
		await expect(aPending).resolves.toEqual({
			behavior: 'deny',
			message: 'Agent process exited.',
		});
		expect(resolvePending('req-b', { behavior: 'allow' })).toBe(true);
		await expect(bPending).resolves.toEqual({ behavior: 'allow' });
		b.cleanup();
	});

	it('rejects lookups for unknown/forged tokens', () => {
		expect(lookupBinding('not-a-real-token')).toBeUndefined();
	});

	it('resolves a pending request via resolvePending', async () => {
		const { token, cleanup } = registerSpawn({ sessionId: 's1' });
		const promise = createPending('req-1', token, 10_000);
		expect(resolvePending('req-1', { behavior: 'allow' })).toBe(true);
		await expect(promise).resolves.toEqual({ behavior: 'allow' });
		cleanup();
	});

	it('returns false when resolving an unknown request', () => {
		expect(resolvePending('does-not-exist', { behavior: 'allow' })).toBe(false);
	});

	it('auto-denies a pending request after the timeout', async () => {
		vi.useFakeTimers();
		try {
			const { token, cleanup } = registerSpawn({ sessionId: 's1' });
			const promise = createPending('req-timeout', token, 1_000);
			vi.advanceTimersByTime(1_001);
			await expect(promise).resolves.toEqual({
				behavior: 'deny',
				message: 'Permission request timed out with no response.',
			});
			cleanup();
		} finally {
			vi.useRealTimers();
		}
	});

	it('cleanup denies any still-pending requests for that spawn', async () => {
		const { token, cleanup } = registerSpawn({ sessionId: 's1' });
		const promise = createPending('req-live', token, 10_000);
		cleanup();
		await expect(promise).resolves.toEqual({
			behavior: 'deny',
			message: 'Agent process exited.',
		});
	});

	afterEach(() => {
		// Sanity: no bindings should leak across tests that clean up.
		// (Not strict - other tests may register; just ensure it's callable.)
		expect(typeof relayRegistryStats().bindings).toBe('number');
	});
});

describe('permission-relay spawn-args', () => {
	it('writes the mcp config to a file and passes it by path (shell-safe)', () => {
		const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-args-'));
		try {
			const { args, configPath } = buildRelayArgs(
				'/path/to/node',
				'/path/to/bridge.js',
				'/tmp/relay.sock',
				'toktokreallylong0123456789abcdef',
				configDir
			);
			expect(args[0]).toBe('--permission-prompt-tool');
			expect(args[1]).toBe(RELAY_PERMISSION_PROMPT_TOOL);
			expect(args[2]).toBe('--mcp-config');
			// The 4th arg is a FILE PATH, not inline JSON (no shell metacharacters).
			expect(args[3]).toBe(configPath);
			expect(configPath.startsWith(configDir)).toBe(true);
			expect(args[3]).not.toContain('{');

			const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
			const server = config.mcpServers[RELAY_MCP_SERVER_NAME];
			expect(server.command).toBe('/path/to/node');
			expect(server.args).toEqual(['/path/to/bridge.js']);
			expect(server.env.ELECTRON_RUN_AS_NODE).toBe('1');
			expect(server.env.MAESTRO_RELAY_SOCKET).toBe('/tmp/relay.sock');
			expect(server.env.MAESTRO_RELAY_TOKEN).toBe('toktokreallylong0123456789abcdef');
		} finally {
			fs.rmSync(configDir, { recursive: true, force: true });
		}
	});

	it('uses the mcp__server__tool naming for the prompt tool', () => {
		expect(RELAY_PERMISSION_PROMPT_TOOL).toBe(`mcp__${RELAY_MCP_SERVER_NAME}__approve`);
	});
});

describe('permission-relay parseQuestionRequest', () => {
	it('returns null for ordinary (non-AskUserQuestion) tools', () => {
		expect(parseQuestionRequest('Bash', { command: 'ls' })).toBeNull();
		expect(parseQuestionRequest('Edit', { file_path: '/tmp/x' })).toBeNull();
	});

	it('parses a single-select question into the typed shape', () => {
		const parsed = parseQuestionRequest('AskUserQuestion', {
			questions: [
				{
					question: 'Which color do you prefer?',
					header: 'Color',
					options: [{ label: 'Red', description: 'The red one' }, { label: 'Blue' }],
					multiSelect: false,
				},
			],
		});
		expect(parsed).toEqual({
			kind: 'question',
			questions: [
				{
					question: 'Which color do you prefer?',
					header: 'Color',
					options: [{ label: 'Red', description: 'The red one' }, { label: 'Blue' }],
					multiSelect: false,
				},
			],
		});
	});

	it('preserves multiSelect and parses multiple questions', () => {
		const parsed = parseQuestionRequest('AskUserQuestion', {
			questions: [
				{ question: 'Pick colors', options: [{ label: 'Red' }], multiSelect: true },
				{ question: 'Pick a size', options: [{ label: 'S' }], multiSelect: false },
			],
		});
		expect(parsed?.questions).toHaveLength(2);
		expect(parsed?.questions[0].multiSelect).toBe(true);
		expect(parsed?.questions[1].multiSelect).toBe(false);
		// Absent header stays undefined, not the empty string.
		expect(parsed?.questions[0].header).toBeUndefined();
	});

	it('tolerates bare-string options', () => {
		const parsed = parseQuestionRequest('AskUserQuestion', {
			questions: [{ question: 'Q?', options: ['A', 'B'], multiSelect: false }],
		});
		expect(parsed?.questions[0].options).toEqual([{ label: 'A' }, { label: 'B' }]);
	});

	it('drops malformed questions and returns null when none survive', () => {
		expect(
			parseQuestionRequest('AskUserQuestion', { questions: [{}, { header: 'x' }] })
		).toBeNull();
		expect(parseQuestionRequest('AskUserQuestion', {})).toBeNull();
		expect(parseQuestionRequest('AskUserQuestion', { questions: 'nope' })).toBeNull();
	});
});

describe('permission-relay server AskUserQuestion round-trip', () => {
	/** Collect newline-delimited JSON messages arriving on a client socket. */
	function collectMessages(
		client: net.Socket,
		onMessage: (msg: Record<string, unknown>) => void
	): void {
		let buffer = '';
		client.setEncoding('utf8');
		client.on('data', (chunk: string) => {
			buffer += chunk;
			let idx: number;
			while ((idx = buffer.indexOf('\n')) !== -1) {
				const line = buffer.slice(0, idx).trim();
				buffer = buffer.slice(idx + 1);
				if (line.length > 0) {
					onMessage(JSON.parse(line));
				}
			}
		});
	}

	// Production runs exactly one relay server per process; its socket path (a
	// pid-derived named pipe on Windows) is process-global. Each `it` spinning up
	// its own server and calling stop() collided on Windows: server.close() is
	// async and does not release the named pipe synchronously, so the next
	// listen() on the same pipe threw EADDRINUSE. Share one server across the
	// block and set the per-test onRequest handler instead.
	let server: PermissionRelayServer;
	let socketPath: string;
	let serverDir: string;

	beforeAll(async () => {
		server = new PermissionRelayServer();
		serverDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-srv-'));
		socketPath = await server.ensureStarted(serverDir);
	});

	afterAll(() => {
		server.stop();
		fs.rmSync(serverDir, { recursive: true, force: true });
	});

	it('surfaces a kind=question request and round-trips a deny+message answer', async () => {
		const { token, cleanup } = registerSpawn({ sessionId: 'sQ', tabId: 'tQ' });
		let captured: PermissionRequest | undefined;

		// Stand in for the renderer: answer via deny+message (the proven shape).
		server.setOnRequest((req) => {
			captured = req;
			resolvePending(req.requestId, { behavior: 'deny', message: 'Color: Blue' });
		});

		const client = net.createConnection(socketPath);

		try {
			const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
				collectMessages(client, (msg) => {
					if (msg.type === 'permission-response') {
						resolve(msg);
					}
				});
				client.on('error', reject);
				client.on('connect', () => {
					client.write(JSON.stringify({ type: 'hello', token }) + '\n');
					client.write(
						JSON.stringify({
							type: 'permission-request',
							token,
							requestId: 'b1',
							toolName: 'AskUserQuestion',
							input: {
								questions: [
									{
										question: 'Which color do you prefer?',
										header: 'Color',
										options: [{ label: 'Red' }, { label: 'Blue' }],
										multiSelect: false,
									},
								],
							},
						}) + '\n'
					);
				});
			});

			expect(captured?.kind).toBe('question');
			expect(captured?.questions?.[0].question).toBe('Which color do you prefer?');
			expect(captured?.questions?.[0].options.map((o) => o.label)).toEqual(['Red', 'Blue']);
			expect(response.requestId).toBe('b1');
			expect(response.decision).toEqual({ behavior: 'deny', message: 'Color: Blue' });
		} finally {
			client.destroy();
			cleanup();
		}
	});

	it('leaves an ordinary tool request unchanged (no kind/questions)', async () => {
		const { token, cleanup } = registerSpawn({ sessionId: 'sB', tabId: 'tB' });
		let captured: PermissionRequest | undefined;

		server.setOnRequest((req) => {
			captured = req;
			resolvePending(req.requestId, { behavior: 'allow' });
		});

		const client = net.createConnection(socketPath);

		try {
			await new Promise<void>((resolve, reject) => {
				collectMessages(client, (msg) => {
					if (msg.type === 'permission-response') {
						resolve();
					}
				});
				client.on('error', reject);
				client.on('connect', () => {
					client.write(JSON.stringify({ type: 'hello', token }) + '\n');
					client.write(
						JSON.stringify({
							type: 'permission-request',
							token,
							requestId: 'b2',
							toolName: 'Bash',
							input: { command: 'ls' },
						}) + '\n'
					);
				});
			});

			expect(captured?.toolName).toBe('Bash');
			expect(captured?.kind).toBeUndefined();
			expect(captured?.questions).toBeUndefined();
		} finally {
			client.destroy();
			cleanup();
		}
	});

	/**
	 * Managed intersection (MRC-06-07, MRC-06-09): the host decides first on
	 * the exact tool request; a user allow never overrides a managed deny, an
	 * allow is intersected with the lease as it stands after the user answers,
	 * and a gate that fails is a refusal. A standalone gate changes nothing.
	 */
	async function relayRequest(
		token: string,
		requestId: string,
		toolName: string,
		input: Record<string, unknown>
	): Promise<Record<string, unknown>> {
		const client = net.createConnection(socketPath);
		try {
			return await new Promise<Record<string, unknown>>((resolve, reject) => {
				collectMessages(client, (msg) => {
					if (msg.type === 'permission-response') resolve(msg);
				});
				client.on('error', reject);
				client.on('connect', () => {
					client.write(JSON.stringify({ type: 'hello', token }) + '\n');
					client.write(
						JSON.stringify({ type: 'permission-request', token, requestId, toolName, input }) + '\n'
					);
				});
			});
		} finally {
			client.destroy();
		}
	}

	it('denies at once on a managed deny and never asks the user, whatever the user would say', async () => {
		const { token, cleanup } = registerSpawn({ sessionId: 'sM1', tabId: 'tM1' });
		const asked: PermissionRequest[] = [];
		server.setOnRequest((req) => {
			asked.push(req);
			resolvePending(req.requestId, { behavior: 'allow' });
		});
		const seen: Array<{ binding: RelaySpawnBinding; tool: string }> = [];
		server.setManagedGate({
			decide: async (binding, request) => {
				seen.push({ binding, tool: request.toolName });
				return { managed: true, decision: { decision: 'deny', reason: 'rm is not allowed' } };
			},
			recheck: () => ({ ok: true }),
		});
		try {
			const response = await relayRequest(token, 'm1', 'Bash', { command: 'rm -rf /' });
			expect(response.decision).toEqual({
				behavior: 'deny',
				message: 'Refused under management: rm is not allowed',
			});
			expect(asked).toEqual([]);
			expect(seen).toEqual([{ binding: { sessionId: 'sM1', tabId: 'tM1' }, tool: 'Bash' }]);
		} finally {
			server.setManagedGate(null);
			cleanup();
		}
	});

	it('asks the user after a managed allow and keeps their deny', async () => {
		const { token, cleanup } = registerSpawn({ sessionId: 'sM2' });
		server.setOnRequest((req) =>
			resolvePending(req.requestId, { behavior: 'deny', message: 'no' })
		);
		server.setManagedGate({
			decide: async () => ({ managed: true, decision: { decision: 'allow' } }),
			recheck: () => ({ ok: true }),
		});
		try {
			const response = await relayRequest(token, 'm2', 'Bash', { command: 'ls' });
			expect(response.decision).toEqual({ behavior: 'deny', message: 'no' });
		} finally {
			server.setManagedGate(null);
			cleanup();
		}
	});

	it('denies a user-approved request whose admission ended while the prompt was open', async () => {
		const { token, cleanup } = registerSpawn({ sessionId: 'sM3' });
		let live = true;
		server.setOnRequest((req) => {
			// The lease is revoked while the user is looking at the prompt.
			live = false;
			resolvePending(req.requestId, { behavior: 'allow' });
		});
		server.setManagedGate({
			decide: async () => ({ managed: true, decision: { decision: 'allow' } }),
			recheck: () => (live ? { ok: true } : { ok: false, reason: 'the lease is revoked.' }),
		});
		try {
			const response = await relayRequest(token, 'm3', 'Edit', { file_path: '/p/a.ts' });
			expect(response.decision).toEqual({
				behavior: 'deny',
				message: 'Refused under management: the lease is revoked.',
			});
		} finally {
			server.setManagedGate(null);
			cleanup();
		}
	});

	it('passes a user allow through when the gate allows and the admission is still live', async () => {
		const { token, cleanup } = registerSpawn({ sessionId: 'sM4' });
		server.setOnRequest((req) => resolvePending(req.requestId, { behavior: 'allow' }));
		server.setManagedGate({
			decide: async () => ({ managed: true, decision: { decision: 'allow' } }),
			recheck: () => ({ ok: true }),
		});
		try {
			const response = await relayRequest(token, 'm4', 'Read', { file_path: '/p/a.ts' });
			expect(response.decision).toEqual({ behavior: 'allow' });
		} finally {
			server.setManagedGate(null);
			cleanup();
		}
	});

	it('treats a gate that throws as a refusal, and a standalone gate as the user alone', async () => {
		const { token, cleanup } = registerSpawn({ sessionId: 'sM5' });
		server.setOnRequest((req) => resolvePending(req.requestId, { behavior: 'allow' }));
		try {
			server.setManagedGate({
				decide: async () => {
					throw new Error('endpoint gone');
				},
				recheck: () => ({ ok: true }),
			});
			const refused = await relayRequest(token, 'm5a', 'Bash', { command: 'ls' });
			expect((refused.decision as { behavior: string }).behavior).toBe('deny');
			expect((refused.decision as { message: string }).message).toContain('endpoint gone');

			server.setManagedGate({
				decide: async () => ({ managed: false }),
				recheck: () => ({ ok: false, reason: 'never consulted' }),
			});
			const allowed = await relayRequest(token, 'm5b', 'Bash', { command: 'ls' });
			expect(allowed.decision).toEqual({ behavior: 'allow' });
		} finally {
			server.setManagedGate(null);
			cleanup();
		}
	});

	it('composes the gate over the process manager: no live admission denies, the effect authority decides the exact tool', async () => {
		const effects = tableEffects((effect) =>
			effect.kind === 'command' && effect.command === 'ls'
				? { decision: 'allow' }
				: { decision: 'deny', reason: `${effect.kind} is not allowed` }
		);
		const port = fakeSpawnPort({ effects });
		const admissions = new Map<string, ReturnType<typeof fakeAdmission>>();
		const gate = createRelayManagedGate({
			port: () => port,
			admissionOf: (sessionId) => admissions.get(sessionId) ?? null,
			admissionLive: (sessionId) =>
				admissions.has(sessionId) ? { ok: true } : { ok: false, reason: 'no admission' },
		});
		const request = (toolName: string, input: Record<string, unknown>): PermissionRequest => ({
			requestId: 'r1',
			token: 't',
			sessionId: 'sG',
			tabId: 'tab-7',
			toolName,
			input,
			createdAt: 0,
		});

		expect(await gate.decide({ sessionId: 'sG' }, request('Bash', { command: 'ls' }))).toEqual({
			managed: true,
			decision: { decision: 'deny', reason: expect.stringContaining('no live admission') },
		});

		admissions.set('sG', fakeAdmission({ leaseId: 'lease-g', provider: 'claude-code' }));
		expect(
			await gate.decide({ sessionId: 'sG', tabId: 'tab-7' }, request('Bash', { command: 'ls' }))
		).toEqual({ managed: true, decision: { decision: 'allow' } });
		expect(effects.asked[0].binding).toEqual({
			leaseId: 'lease-g',
			actor: { kind: 'human', id: 'ada' },
			provider: 'claude-code',
			threadId: null,
			turnId: 'tab-7',
			requestId: 'r1',
		});
		expect(
			await gate.decide({ sessionId: 'sG' }, request('Write', { file_path: '/p/a.ts' }))
		).toEqual({
			managed: true,
			decision: { decision: 'deny', reason: 'file-change is not allowed' },
		});
		expect(claudeToolEffect('Edit', { file_path: '/p/a.ts', old_string: 'x' })).toEqual({
			kind: 'file-change',
			paths: ['/p/a.ts'],
			cwd: null,
		});
		expect(claudeToolEffect('WebFetch', { url: 'https://x' })).toEqual({
			kind: 'tool-call',
			tool: 'WebFetch',
			input: { url: 'https://x' },
		});

		port.setStanding('standalone');
		expect(await gate.decide({ sessionId: 'sG' }, request('Bash', { command: 'ls' }))).toEqual({
			managed: false,
		});
	});
});
