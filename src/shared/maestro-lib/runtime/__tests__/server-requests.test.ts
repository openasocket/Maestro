/**
 * The host's request handler, message by message: what `maestro-cli` sends a desktop, answered by a
 * host. The rule under test is the same for each: a request is applied, or it is refused with the
 * reason. It is never answered with success for work that did not happen.
 *
 * Config updates run against a real runtime on a temp data directory, since the answer is what
 * lands in the agent record. Auto Run and dispatch run against a recording client, so nothing here
 * starts a provider.
 */
import { createHash } from 'node:crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AGENT_EDITABLE_KEYS, DEFAULT_TAB_DEFAULTS } from '../../agents/rules';
import type {
	ClientError,
	ClientResult,
	MaestroClient,
	TurnInput,
	TurnSendReceipt,
} from '../../client/types';
import { createLocalHostAuthority, type PolicyDecision } from '../../managed/authority';
import { inProcessContext } from '../../managed/operations';
import {
	MANAGED_CAPABILITIES,
	MANAGED_CONTRACT_VERSION,
	type ManagedOperationContext,
} from '../../managed/types';
import { createMaestroRuntime, type MaestroRuntime, type RuntimeDeps } from '../index';
import { createRequestHandler, runtimeManagedScope, type RequestHandler } from '../server-requests';
import type { WatchDirectory } from '../settings-watch';

const ok = <T>(value: T): ClientResult<T> => ({ ok: true, value });
const fail = (code: ClientError['code'], message: string): ClientResult<never> => ({
	ok: false,
	error: { code, message, method: 'turns.send' },
});

describe('update_session_config', () => {
	let dir: string;
	let runtime: MaestroRuntime;
	let handle: RequestHandler;

	const watchDirectory: WatchDirectory = () => ({ close: () => undefined });

	function deps(): Partial<RuntimeDeps> {
		let id = 0;
		let now = 1_000;
		return {
			pid: 100,
			now: () => 5_000,
			bootTime: () => 1_000,
			isPidAlive: (pid) => pid === 100,
			hostname: () => 'testhost',
			rules: { newId: () => `id-${++id}`, now: () => ++now, random: () => 0 },
			checkCwd: () => null,
			readTabDefaults: async () => DEFAULT_TAB_DEFAULTS,
			watchDirectory,
			probeBinary: async (binaryName) => ({ exists: true, path: `/fake/bin/${binaryName}` }),
		};
	}

	beforeEach(async () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-requests-'));
		fs.writeFileSync(
			path.join(dir, 'maestro-sessions.json'),
			JSON.stringify({
				sessions: [
					{
						id: 'a1',
						name: 'Alpha',
						toolType: 'codex',
						cwd: dir,
						projectRoot: dir,
						aiTabs: [{ id: 't1', agentSessionId: null, name: null, logs: [] }],
						activeTabId: 't1',
						unifiedTabOrder: [{ type: 'ai', id: 't1' }],
					},
				],
				activeSessionId: 'a1',
			})
		);
		const started = await createMaestroRuntime({ dataDir: dir, mode: 'host', deps: deps() });
		if (!started.ok) throw new Error(`refused: ${started.refusal.message}`);
		runtime = started.runtime;
		handle = createRequestHandler(runtime);
	});

	afterEach(async () => {
		await runtime.connection.close();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	const update = (configPatch: Record<string, unknown>) =>
		handle({ type: 'update_session_config', sessionId: 'a1', configPatch });
	const stored = async (): Promise<Record<string, unknown>> => {
		const agent = await runtime.agents.get('a1');
		if (!agent.ok) throw new Error(agent.error.message);
		return agent.value;
	};

	/** A value each allowlisted key accepts. A key added to the allowlist without one fails the test below. */
	const SAMPLE: Record<string, unknown> = {
		nudgeMessage: 'keep going',
		newSessionMessage: 'hello',
		customPath: '/opt/bin/codex',
		customArgs: '--flag',
		customEnvVars: { A: '1' },
		customModel: 'gpt-x',
		customEffort: 'high',
		customContextWindow: 123456,
		contextWindowSource: 'user-edited',
		enableMaestroP: true,
		maestroPMode: 'dynamic',
		maestroPPath: '/opt/bin/maestro-p',
		codexTransport: 'app-server',
		bookmarked: true,
	};

	it('applies every allowlisted key it is sent on its own, or says why not', async () => {
		expect(Object.keys(SAMPLE).sort()).toEqual([...AGENT_EDITABLE_KEYS].sort());
		for (const key of AGENT_EDITABLE_KEYS) {
			const reply = await update({ [key]: SAMPLE[key] });
			expect(reply, key).toMatchObject({ type: 'update_session_config_result', success: true });
			expect((await stored())[key], key).toEqual(SAMPLE[key]);
		}
	});

	it('clears every allowlisted key on null', async () => {
		for (const key of AGENT_EDITABLE_KEYS) {
			expect(await update({ [key]: SAMPLE[key] }), key).toMatchObject({ success: true });
			expect(await update({ [key]: null }), key).toMatchObject({ success: true });
			expect(key in (await stored()), key).toBe(false);
		}
	});

	it('takes only a known Codex transport, and stores exec as an unset field', async () => {
		expect(await update({ codexTransport: 'app-server' })).toMatchObject({ success: true });
		expect((await stored()).codexTransport).toBe('app-server');

		expect(await update({ codexTransport: 'websocket' })).toEqual({
			type: 'update_session_config_result',
			success: false,
			error: "Invalid value for field 'codexTransport'",
		});
		expect((await stored()).codexTransport).toBe('app-server');

		expect(await update({ codexTransport: 'exec' })).toMatchObject({ success: true });
		expect('codexTransport' in (await stored())).toBe(false);
	});

	it('refuses a patch with nothing a client may write, instead of answering success', async () => {
		const before = await stored();
		for (const configPatch of [{}, { state: 'busy' }, { aiTabs: [], cwd: '/elsewhere' }]) {
			expect(await update(configPatch)).toEqual({
				type: 'update_session_config_result',
				success: false,
				error: 'No editable config fields in patch',
			});
		}
		expect(await stored()).toEqual(before);
	});

	it.each(['plan', 'apply', 'status', 'recover', 'rollback'])(
		'refuses provider translation %s without switching the provider or editing settings',
		async (migrationAction) => {
			const before = await stored();
			expect(
				await update({ toolType: 'claude-code', customModel: 'opus', migrationAction })
			).toEqual({
				type: 'update_session_config_result',
				success: false,
				error:
					'Provider translation requires the desktop app; the headless host cannot migrate native conversations.',
			});
			expect(await stored()).toEqual(before);
		}
	);
});

/** A client that records what it is asked and answers from a script. Only what these messages reach exists. */
function recordingClient(
	options: {
		activeTabId?: string;
		tabs?: string[];
		send?: (agentId: string, tabId: string, input: TurnInput) => ClientResult<TurnSendReceipt>;
		launch?: () => ClientResult<void>;
	} = {}
) {
	const calls: Array<{ method: string; args: unknown[] }> = [];
	const note = (method: string, ...args: unknown[]): void => void calls.push({ method, args });
	let created = 0;
	const client = {
		agents: {
			get: async (agentId: string) => {
				if (agentId !== 'a1') return fail('not-found', `No agent ${agentId}.`);
				return ok({
					id: 'a1',
					name: 'Alpha',
					toolType: 'claude-code',
					...(options.activeTabId !== undefined ? { activeTabId: options.activeTabId } : {}),
				});
			},
		},
		tabs: {
			list: async () => ok((options.tabs ?? []).map((id) => ({ id }))),
			create: async (agentId: string) => {
				note('tabs.create', agentId);
				if (agentId !== 'a1') return fail('not-found', `No agent ${agentId}.`);
				created += 1;
				return ok({ tabId: `new-${created}` });
			},
		},
		turns: {
			send: async (agentId: string, tabId: string, input: TurnInput) => {
				note('turns.send', agentId, tabId, input);
				return options.send?.(agentId, tabId, input) ?? ok({ status: 'started' as const });
			},
		},
		autoRun: {
			launch: async (agentId: string, input: unknown) => {
				note('autoRun.launch', agentId, input);
				return options.launch?.() ?? ok(undefined);
			},
		},
	};
	const handle = createRequestHandler(client as unknown as MaestroClient);
	const named = (method: string) => calls.filter((call) => call.method === method);
	return { handle, calls, named };
}

describe('configure_auto_run', () => {
	const documents = [{ filename: '/docs/plan.md', resetOnCompletion: true }];
	const base = { type: 'configure_auto_run', sessionId: 'a1', documents };

	it('launches when asked to, with the prompt and the run-scoped settings', async () => {
		const host = recordingClient();
		const reply = await host.handle({
			...base,
			launch: true,
			prompt: 'Do exactly one task.',
			loopEnabled: true,
			maxLoops: 2,
			model: 'opus',
			effort: 'high',
			ignoreModelHints: true,
		});
		expect(reply).toEqual({ type: 'configure_auto_run_result', success: true });
		expect(host.named('autoRun.launch')).toEqual([
			{
				method: 'autoRun.launch',
				args: [
					'a1',
					{
						documents: [{ file: '/docs/plan.md', resetOnCompletion: true }],
						loop: true,
						maxLoops: 2,
						prompt: 'Do exactly one task.',
						model: 'opus',
						effort: 'high',
						ignoreModelHints: true,
					},
				],
			},
		]);
	});

	it('refuses to configure without launching, since a host has no panel to fill', async () => {
		for (const launch of [undefined, false]) {
			const host = recordingClient();
			const reply = await host.handle({ ...base, ...(launch === undefined ? {} : { launch }) });
			expect(reply).toEqual({
				type: 'configure_auto_run_result',
				success: false,
				error:
					'A headless host has no Auto Run panel to configure. Pass --launch to start the run.',
			});
			expect(host.calls).toEqual([]);
		}
	});

	it('refuses to save a playbook, and launches nothing', async () => {
		for (const launch of [undefined, true]) {
			const host = recordingClient();
			const reply = await host.handle({ ...base, launch, saveAsPlaybook: 'Nightly' });
			expect(reply).toMatchObject({ type: 'configure_auto_run_result', success: false });
			expect(String(reply?.error)).toContain('cannot save a playbook');
			expect(String(reply?.error)).toContain('Nothing was saved or launched');
			expect(reply).not.toHaveProperty('playbookId');
			expect(host.calls).toEqual([]);
		}
	});

	it('refuses a worktree run rather than running in the main checkout', async () => {
		const host = recordingClient();
		const reply = await host.handle({
			...base,
			launch: true,
			worktree: { enabled: true, path: '/wt', branchName: 'feat/x', baseBranch: '' },
		});
		expect(reply).toMatchObject({ type: 'configure_auto_run_result', success: false });
		expect(String(reply?.error)).toContain('cannot run Auto Run in a worktree');
		expect(host.calls).toEqual([]);
	});

	it('answers a launch the runtime refuses with its reason', async () => {
		const host = recordingClient({ launch: () => fail('rejected', 'The agent is busy.') });
		expect(await host.handle({ ...base, launch: true })).toEqual({
			type: 'configure_auto_run_result',
			success: false,
			error: 'The agent is busy.',
		});
	});
});

describe('dispatch messages', () => {
	const queued = (): ClientResult<TurnSendReceipt> =>
		ok({ status: 'queued', itemId: 'q1', position: 2, queueLength: 2 });

	describe('enqueue_command', () => {
		const base = { type: 'enqueue_command', sessionId: 'a1', command: 'hello', inputMode: 'ai' };

		it('sends to the agent’s active tab when none is named', async () => {
			const host = recordingClient({ activeTabId: 't-active' });
			expect(await host.handle(base)).toEqual({
				type: 'enqueue_command_result',
				success: true,
				sessionId: 'a1',
				tabId: 't-active',
				queued: false,
			});
			expect(host.named('turns.send')[0].args).toEqual(['a1', 't-active', { text: 'hello' }]);
		});

		it('sends to the named tab, and reports a place in line', async () => {
			const host = recordingClient({ activeTabId: 't-active', send: queued });
			expect(await host.handle({ ...base, tabId: 't2' })).toEqual({
				type: 'enqueue_command_result',
				success: true,
				sessionId: 'a1',
				tabId: 't2',
				queued: true,
				itemId: 'q1',
				queuePosition: 2,
				queueLength: 2,
			});
			expect(host.named('turns.send')[0].args.slice(0, 2)).toEqual(['a1', 't2']);
		});

		it('falls back to the first tab of an agent with no active tab, and says when there is none', async () => {
			const withTabs = recordingClient({ tabs: ['t1', 't2'] });
			expect(await withTabs.handle(base)).toMatchObject({ success: true, tabId: 't1' });

			const none = recordingClient();
			expect(await none.handle(base)).toMatchObject({ success: false, reason: 'no-ai-tabs' });
			expect(none.named('turns.send')).toEqual([]);
		});

		it('refuses a held message instead of running it', async () => {
			const host = recordingClient({ activeTabId: 't-active' });
			const reply = await host.handle({ ...base, held: true });
			expect(reply).toMatchObject({ type: 'enqueue_command_result', success: false });
			expect(String(reply?.error)).toContain('cannot queue a held message');
			expect(host.named('turns.send')).toEqual([]);
		});

		it('words a missing agent and a missing tab the way the CLI maps to its codes', async () => {
			const host = recordingClient({
				activeTabId: 't-active',
				send: () => fail('not-found', 'No tab gone.'),
			});
			expect(await host.handle({ ...base, sessionId: 'nobody' })).toMatchObject({
				success: false,
				error: 'Session not found',
				reason: 'session-not-found',
			});
			expect(await host.handle({ ...base, tabId: 'gone' })).toMatchObject({
				success: false,
				error: 'Tab not found: gone',
				reason: 'tab-not-found',
			});
		});
	});

	describe('send_command', () => {
		const base = { type: 'send_command', sessionId: 'a1', command: 'hello', inputMode: 'ai' };

		it('sends to the active tab and answers with command_result', async () => {
			const host = recordingClient({ activeTabId: 't-active' });
			expect(await host.handle({ ...base, background: true })).toEqual({
				type: 'command_result',
				success: true,
				sessionId: 'a1',
				tabId: 't-active',
				queued: false,
			});
			expect(host.named('turns.send')[0].args).toEqual(['a1', 't-active', { text: 'hello' }]);
		});

		it('sends to the named tab, and says when a busy agent queued it', async () => {
			const host = recordingClient({ activeTabId: 't-active', send: queued });
			expect(await host.handle({ ...base, tabId: 't2', force: true })).toMatchObject({
				type: 'command_result',
				success: true,
				tabId: 't2',
				queued: true,
				itemId: 'q1',
			});
		});

		it('answers a send the runtime refuses with its reason', async () => {
			const host = recordingClient({
				activeTabId: 't-active',
				send: () => fail('unsupported', 'Images cannot be sent from here yet.'),
			});
			expect(await host.handle({ ...base, images: ['data:image/png;base64,AAAA'] })).toEqual({
				type: 'command_result',
				success: false,
				error: 'Images cannot be sent from here yet.',
				sessionId: 'a1',
			});
			expect(host.named('turns.send')[0].args[2]).toEqual({
				text: 'hello',
				images: ['data:image/png;base64,AAAA'],
			});
		});

		it('refuses a terminal command and a completion callback before sending anything', async () => {
			const host = recordingClient({ activeTabId: 't-active' });
			const terminal = await host.handle({ ...base, inputMode: 'terminal' });
			expect(terminal).toMatchObject({ type: 'command_result', success: false });
			expect(String(terminal?.error)).toContain('no terminal');

			const callback = await host.handle({ ...base, tabId: 't1', notifyOnComplete: 'a2' });
			expect(callback).toMatchObject({ type: 'command_result', success: false });
			expect(String(callback?.error)).toContain('cannot arm a completion callback');
			expect(callback).not.toHaveProperty('callbackId');
			expect(host.calls).toEqual([]);
		});
	});

	describe('new_ai_tab_with_prompt', () => {
		const base = { type: 'new_ai_tab_with_prompt', sessionId: 'a1', prompt: 'start here' };

		it('creates a tab, sends the prompt to it, and answers with its id', async () => {
			const host = recordingClient({ activeTabId: 't-active' });
			expect(await host.handle({ ...base, background: true, hidden: true })).toEqual({
				type: 'new_ai_tab_with_prompt_result',
				success: true,
				sessionId: 'a1',
				tabId: 'new-1',
			});
			expect(host.calls).toEqual([
				{ method: 'tabs.create', args: ['a1'] },
				{ method: 'turns.send', args: ['a1', 'new-1', { text: 'start here' }] },
			]);
		});

		it('says when the prompt waits behind a running turn', async () => {
			const host = recordingClient({ send: queued });
			expect(await host.handle(base)).toMatchObject({
				success: true,
				tabId: 'new-1',
				queued: true,
			});
		});

		it('creates no tab for a request it will refuse', async () => {
			const host = recordingClient();
			expect(await host.handle({ ...base, prompt: '  ' })).toMatchObject({
				success: false,
				error: 'Missing sessionId or prompt',
			});
			const callback = await host.handle({ ...base, notifyOnComplete: 'a2' });
			expect(callback).toMatchObject({ type: 'new_ai_tab_with_prompt_result', success: false });
			expect(host.calls).toEqual([]);

			expect(await host.handle({ ...base, sessionId: 'nobody' })).toMatchObject({
				success: false,
				error: 'Session not found',
			});
			expect(host.named('turns.send')).toEqual([]);
		});

		it('reports a prompt that could not start with the tab it was created for', async () => {
			const host = recordingClient({
				send: () => fail('failed', 'The provider is not installed.'),
			});
			expect(await host.handle(base)).toEqual({
				type: 'new_ai_tab_with_prompt_result',
				success: false,
				error: 'The provider is not installed.',
				sessionId: 'a1',
				tabId: 'new-1',
			});
		});
	});
});

/**
 * Managed operations over the bridge (MRC-08-05): a real runtime with an injected authority that
 * denies every launch, so a submission reaches the facade and the journal with zero effect. The
 * rule under test is the scope: a caller over the host's secret acts as the host's own principal,
 * carries no delegation, and names this installation and, for an effect, the current policy
 * generation; anything else is refused by name before the facade sees it.
 */
describe('managed_operation (MRC-08-05)', () => {
	let dir: string;
	let runtime: MaestroRuntime;
	let handle: RequestHandler;
	const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
	const watchDirectory: WatchDirectory = () => ({ close: () => undefined });

	function hostDeps(): Partial<RuntimeDeps> {
		let id = 0;
		let now = 1_000;
		return {
			pid: 100,
			now: () => 5_000,
			bootTime: () => 1_000,
			isPidAlive: (pid) => pid === 100,
			hostname: () => 'testhost',
			rules: { newId: () => `id-${++id}`, now: () => ++now, random: () => 0 },
			checkCwd: () => null,
			readTabDefaults: async () => DEFAULT_TAB_DEFAULTS,
			watchDirectory,
			probeBinary: async (binaryName) => ({ exists: true, path: `/fake/bin/${binaryName}` }),
		};
	}

	const decision: PolicyDecision = {
		decision: 'deny',
		reason: 'nothing runs here',
		policyRevision: 1,
	};

	beforeEach(async () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-requests-managed-'));
		fs.writeFileSync(
			path.join(dir, 'maestro-sessions.json'),
			JSON.stringify({
				sessions: [
					{
						id: 'a1',
						name: 'Alpha',
						toolType: 'claude-code',
						cwd: dir,
						projectRoot: dir,
						aiTabs: [{ id: 't1', agentSessionId: null, name: null, logs: [] }],
						activeTabId: 't1',
						unifiedTabOrder: [{ type: 'ai', id: 't1' }],
					},
				],
				activeSessionId: 'a1',
			})
		);
		const started = await createMaestroRuntime({
			dataDir: dir,
			mode: 'host',
			deps: hostDeps(),
			managed: {
				authority: createLocalHostAuthority({
					authorityId: 'fleet-authority',
					decide: () => decision,
					now: () => Date.now(),
					newId: () => 'lease-1',
				}),
			},
		});
		if (!started.ok) throw new Error(`refused: ${started.refusal.message}`);
		runtime = started.runtime;
		handle = createRequestHandler(runtime, { managedScope: runtimeManagedScope(runtime) });
	});

	afterEach(async () => {
		await runtime.connection.close();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	const operator = () => ({
		kind: 'human' as const,
		id: `operator:${runtime.installation.installationId}`,
	});
	const context = (overrides: Partial<ManagedOperationContext> = {}): ManagedOperationContext =>
		inProcessContext({
			installation: runtime.installation,
			actor: operator(),
			delegation: { chain: [], grantRef: null },
			identity: {
				requestId: 'req-1',
				idempotencyKey: 'key-1',
				attemptId: 'attempt-1',
				runId: null,
				rootRunId: null,
				parentRunId: null,
			},
			policyRevision: null,
			workflow: null,
			traceId: 'trace-1',
			requestedCapabilities: [...MANAGED_CAPABILITIES],
			...overrides,
		});
	const send = (operation: string, fields: Record<string, unknown> = {}) =>
		handle({ type: 'managed_operation', operation, ...fields });
	const submission = (text: string) => ({
		agentId: 'a1',
		tabId: 't1',
		providerId: 'claude-code',
		modelId: null,
		content: { text, sha256: sha(text) },
		resourceIds: [],
	});
	const listed = async () => {
		const reply = await send('runs', {
			envelope: { context: context(), input: { cursor: null, limit: 5 } },
		});
		return (reply?.result as { value: { items: unknown[] } }).value.items;
	};

	it("answers scope from the runtime's own standing: this installation, its operator, no policy, standalone", async () => {
		expect(await send('scope')).toEqual({
			type: 'managed_operation_result',
			success: true,
			operation: 'scope',
			result: {
				installation: runtime.installation,
				actor: operator(),
				policyRevision: null,
				binding: 'standalone',
			},
		});
	});

	it('answers the reads and the negotiation in scope, through the facade', async () => {
		const identity = await send('identity', { envelope: { context: context(), input: {} } });
		expect(identity).toMatchObject({
			success: true,
			operation: 'identity',
			result: {
				status: 'ok',
				requestId: 'req-1',
				value: { actor: operator(), binding: 'standalone', verification: { peer: 'in-process' } },
			},
		});
		const agents = await send('agents', {
			envelope: { context: context(), input: { cursor: null, limit: 10 } },
		});
		expect(agents).toMatchObject({
			success: true,
			result: { status: 'ok', value: { items: [{ agentId: 'a1', providerId: 'claude-code' }] } },
		});
		expect(await listed()).toEqual([]);
		expect(
			await send('negotiate', {
				offer: {
					supportedVersions: [MANAGED_CONTRACT_VERSION],
					required: ['capabilities.negotiate'],
				},
			})
		).toMatchObject({
			success: true,
			operation: 'negotiate',
			result: { outcome: 'activated', contractVersion: MANAGED_CONTRACT_VERSION },
		});
		// The facade's own answer rides the wire: a capability this build has not verified is denied, not downgraded.
		expect(
			await send('negotiate', {
				offer: { supportedVersions: [MANAGED_CONTRACT_VERSION], required: ['agents.list'] },
			})
		).toMatchObject({
			success: true,
			result: { outcome: 'denied', reason: 'missing-required-capability' },
		});
	});

	it('submits through the facade and reports its decision: a denial reaches the journal with zero effect', async () => {
		const reply = await send('submit', {
			envelope: { context: context(), input: submission('forbidden') },
		});
		expect(reply).toMatchObject({
			success: true,
			operation: 'submit',
			result: {
				status: 'denied',
				code: 'policy-denied',
				message: expect.stringContaining('nothing runs here'),
			},
		});
		expect(await listed()).toEqual([expect.objectContaining({ agentId: 'a1', state: 'failed' })]);
		const transcript = await runtime.tabs.transcript('a1', 't1');
		expect(transcript.ok && transcript.value).toEqual([]);
	});

	it('refuses a context out of scope by name, before the facade: another actor, a delegation, another installation, a stale generation', async () => {
		const otherActor = await send('identity', {
			envelope: { context: context({ actor: { kind: 'service', id: 'fleet' } }), input: {} },
		});
		expect(otherActor).toMatchObject({
			success: false,
			operation: 'identity',
			reason: 'unauthenticated',
			error: expect.stringContaining("host's own principal"),
		});
		const delegated = await send('agents', {
			envelope: {
				context: context({ delegation: { chain: [operator()], grantRef: null } }),
				input: { cursor: null, limit: 1 },
			},
		});
		expect(delegated).toMatchObject({ success: false, reason: 'unauthenticated' });
		const elsewhere = await send('identity', {
			envelope: {
				context: context({
					installation: { ...runtime.installation, processEpoch: 'an-earlier-start' },
				}),
				input: {},
			},
		});
		expect(elsewhere).toMatchObject({
			success: false,
			reason: 'context-mismatch',
			error: expect.stringContaining('Read scope'),
		});
		// A read is answered on a stale generation; an effect is not.
		const staleRead = await send('identity', {
			envelope: { context: context({ policyRevision: 7 }), input: {} },
		});
		expect(staleRead).toMatchObject({ success: true, result: { status: 'ok' } });
		const staleSubmit = await send('submit', {
			envelope: { context: context({ policyRevision: 7 }), input: submission('stale') },
		});
		expect(staleSubmit).toMatchObject({
			success: false,
			operation: 'submit',
			reason: 'context-mismatch',
			error: expect.stringContaining('policy revision 7'),
		});
		expect(await listed()).toEqual([]);
	});

	it('refuses what it does not do: an unknown operation, a malformed envelope or input, and the route without a scope', async () => {
		expect(await send('enroll')).toMatchObject({
			success: false,
			reason: 'unsupported',
			error: expect.stringContaining('Unknown managed operation "enroll"'),
		});
		expect(await send('identity', { envelope: 'nope' })).toMatchObject({
			success: false,
			reason: 'invalid-input',
			error: 'envelope is not an object',
		});
		expect(
			await send('identity', { envelope: { context: { ...context(), traceId: '' }, input: {} } })
		).toMatchObject({
			success: false,
			reason: 'invalid-input',
			error: expect.stringContaining('traceId'),
		});
		expect(
			await send('agents', { envelope: { context: context(), input: { cursor: null, limit: 0 } } })
		).toMatchObject({
			success: false,
			reason: 'invalid-input',
			error: expect.stringContaining('limit'),
		});
		expect(await send('inspect', { envelope: { context: context(), input: {} } })).toMatchObject({
			success: false,
			reason: 'invalid-input',
			error: 'envelope.input.runId is not an id',
		});
		expect(
			await send('submit', { envelope: { context: context(), input: { agentId: 'a1' } } })
		).toMatchObject({ success: false, reason: 'invalid-input' });
		expect(
			await send('negotiate', { offer: { supportedVersions: 'x', required: [] } })
		).toMatchObject({
			success: false,
			reason: 'invalid-input',
		});
		const unscoped = createRequestHandler(runtime);
		expect(await unscoped({ type: 'managed_operation', operation: 'scope' })).toMatchObject({
			success: false,
			operation: 'scope',
			reason: 'unsupported',
			error: expect.stringContaining('no scope'),
		});
		expect(await listed()).toEqual([]);
	});
});
