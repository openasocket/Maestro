/**
 * Typed runtime commands (MRC-11-01, MRC-11-01A): the six typed actions and
 * their binding to this run, process epoch, actor and policy; the durable
 * ledger that keeps one command id from acting twice across a restart; and
 * the executor over injected ports, keeping accepted, completed, no-effect,
 * failed, denied and unknown distinct. Real files in a temp directory; no
 * socket, no process, no model.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
	commandBindingProblem,
	commandCapability,
	commandEvidenceDigest,
	commandKindOfAction,
	createCommandExecutor,
	createCommandLedger,
	managedCommandProblems,
	type CommandBinding,
	type CommandPortAnswer,
	type CommandPorts,
	type ManagedRuntimeCommand,
} from '../../../../shared/maestro-lib/managed/commands';

const NOW = Date.parse('2026-10-22T12:00:00.000Z');
const installation = { installationId: 'inst-1', runtimeId: 'desktop-7', processEpoch: 'epoch-a' };
const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempFile(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-commands-'));
	dirs.push(dir);
	return path.join(dir, 'maestro-managed-commands.json');
}

function command(over: Partial<ManagedRuntimeCommand> = {}): ManagedRuntimeCommand {
	return {
		commandId: 'cmd-1',
		tenantId: 'tenant-1',
		issuerId: 'issuer-1',
		recipient: {
			actorId: 'actor-1',
			enrollmentId: 'enr-1',
			installationId: 'inst-1',
			runtimeId: 'desktop-7',
			processEpoch: 'epoch-a',
			runId: 'run-1',
		},
		action: { kind: 'cancel-run' },
		preconditions: {
			policyRevision: 3,
			requiredCapability: 'command-cancel_run',
			policyDigest: null,
			bindingDigest: null,
		},
		approval: { kind: 'policy-not-required', policyRevision: 3 },
		issuedAt: new Date(NOW - 1_000).toISOString(),
		expiresAt: new Date(NOW + 60_000).toISOString(),
		nonce: 'n'.repeat(64),
		idempotencyKey: 'idem-1',
		payloadDigest: DIGEST_A,
		releaseId: 'rel-1',
		...over,
	};
}

/** A second, unrelated command: its own id, nonce and key, on the runtime itself. */
function refreshCommand(desiredRevision = 4): ManagedRuntimeCommand {
	return command({
		commandId: 'cmd-2',
		nonce: 'm'.repeat(64),
		idempotencyKey: 'idem-2',
		payloadDigest: DIGEST_B,
		recipient: { ...command().recipient, runId: null },
		action: { kind: 'refresh-policy', desiredRevision },
		preconditions: { ...command().preconditions, requiredCapability: 'command-refresh_policy' },
	});
}

function promptCommand(): ManagedRuntimeCommand {
	return command({
		action: { kind: 'operator-prompt', text: 'say hi', agentInput: true },
		preconditions: { ...command().preconditions, requiredCapability: 'command-operator_prompt' },
		approval: {
			kind: 'approved',
			approvalId: 'ap-1',
			approverId: 'admin-1',
			payloadDigest: DIGEST_A,
			expiresAt: new Date(NOW + 60_000).toISOString(),
		},
	});
}

function binding(over: Partial<CommandBinding> = {}): CommandBinding {
	return {
		installation,
		standing: { ok: true },
		actorId: 'actor-1',
		enrollmentId: 'enr-1',
		tenantId: 'tenant-1',
		policyRevision: 3,
		runState: (runId) => (runId === 'run-1' ? 'live' : runId === 'run-2' ? 'ended' : 'unknown'),
		now: NOW,
		...over,
	};
}

const caps = ['command-cancel_run', 'command-operator_prompt', 'command-report_status'];

/** A port that records what it was handed and answers (or throws) the same every time. */
function recorder(answer: CommandPortAnswer | Error) {
	const calls: unknown[][] = [];
	const port = async (...args: unknown[]): Promise<CommandPortAnswer> => {
		calls.push(args);
		if (answer instanceof Error) throw answer;
		return answer;
	};
	return { calls, port };
}

function make(opts: {
	ports: CommandPorts;
	binding?: () => CommandBinding;
	file?: string;
	now?: () => number;
}) {
	const ledger = createCommandLedger({ file: opts.file, now: () => NOW });
	const executor = createCommandExecutor({
		ledger,
		binding: opts.binding ?? (() => binding()),
		ports: opts.ports,
		now: opts.now ?? (() => NOW),
	});
	return { ledger, executor };
}

describe('the contract', () => {
	it('admits only the six typed actions in the right shape', () => {
		expect(managedCommandProblems(command())).toEqual([]);
		expect(managedCommandProblems({ ...command(), action: { kind: 'shell', run: 'rm' } })).toEqual([
			'action.kind "shell" is not a typed command',
		]);
		expect(managedCommandProblems(promptCommand())).toEqual([]);
		expect(managedCommandProblems(refreshCommand(-1))).toContain(
			'action.desiredRevision is not a revision'
		);
		expect(managedCommandProblems(command({ expiresAt: command().issuedAt }))).toContain(
			'expiresAt does not follow issuedAt'
		);
		expect(commandCapability('operator-prompt')).toBe('command-operator_prompt');
		expect(commandKindOfAction('refresh_policy')).toBe('refresh-policy');
		expect(commandKindOfAction('exec')).toBeNull();
	});

	it('binds a command to this run, epoch, actor and policy, now', () => {
		expect(commandBindingProblem(command(), binding(), caps)).toBeNull();
		const r = command().recipient;
		expect(
			commandBindingProblem(
				command({ recipient: { ...r, processEpoch: 'epoch-b' } }),
				binding(),
				caps
			)?.reason
		).toBe('stale-run');
		expect(commandBindingProblem(command(), binding({ actorId: null }), caps)?.reason).toBe(
			'unauthenticated'
		);
		expect(
			commandBindingProblem(command({ recipient: { ...r, actorId: 'actor-2' } }), binding(), caps)
				?.reason
		).toBe('unauthenticated');
		expect(commandBindingProblem(command(), binding({ policyRevision: 4 }), caps)?.reason).toBe(
			'policy-denied'
		);
		expect(
			commandBindingProblem(command({ action: { kind: 'pause-run' } }), binding(), caps)?.reason
		).toBe('unsupported-capability');
		expect(commandBindingProblem(command(), binding({ now: NOW + 61_000 }), caps)?.reason).toBe(
			'expired'
		);
		expect(
			commandBindingProblem(command({ recipient: { ...r, runId: 'run-9' } }), binding(), caps)
				?.reason
		).toBe('stale-run');
	});

	it('requires a separate approval bound to the payload for an operator prompt', () => {
		const approved = promptCommand();
		expect(commandBindingProblem(approved, binding(), caps)).toBeNull();
		expect(
			commandBindingProblem(
				{ ...approved, approval: { kind: 'policy-not-required', policyRevision: 3 } },
				binding(),
				caps
			)?.reason
		).toBe('approval-required');
		expect(
			commandBindingProblem(
				{ ...approved, approval: { ...approved.approval, payloadDigest: DIGEST_B } } as never,
				binding(),
				caps
			)?.reason
		).toBe('approval-required');
		expect(
			commandBindingProblem(
				{ ...approved, recipient: { ...approved.recipient, runId: null } },
				binding(),
				caps
			)?.reason
		).toBe('invalid-input');
	});

	it('digests evidence deterministically', () => {
		const a = commandEvidenceDigest({ commandId: 'c', kind: 'cancel-run', outcome: 'completed' });
		expect(a).toMatch(/^[a-f0-9]{64}$/);
		expect(
			commandEvidenceDigest({ commandId: 'c', kind: 'cancel-run', outcome: 'completed' })
		).toBe(a);
		expect(
			commandEvidenceDigest({ commandId: 'c', kind: 'cancel-run', outcome: 'failed' })
		).not.toBe(a);
	});
});

describe('the ledger', () => {
	it('accepts an id once, answers a duplicate, and refuses a replay by digest, nonce or key', async () => {
		const ledger = createCommandLedger({ now: () => NOW });
		expect((await ledger.accept(command())).disposition).toBe('accepted');
		expect((await ledger.accept(command())).disposition).toBe('duplicate');
		expect((await ledger.accept(command({ payloadDigest: DIGEST_B }))).disposition).toBe('replay');
		// Enrollment-wide: another id reusing the nonce, or the idempotency key, is a replay.
		expect((await ledger.accept(command({ commandId: 'cmd-2' }))).disposition).toBe('replay');
		expect(
			(await ledger.accept(command({ commandId: 'cmd-3', nonce: 'm'.repeat(64) }))).disposition
		).toBe('replay');
		expect((await ledger.accept(refreshCommand())).disposition).toBe('accepted');
		expect(ledger.open().map((r) => r.commandId)).toEqual(['cmd-1', 'cmd-2']);
	});

	it('persists to its file and turns an accepted record unknown when a new process loads it', async () => {
		const file = tempFile();
		const first = createCommandLedger({ file, now: () => NOW });
		expect(await first.load()).toEqual({ ok: true, commands: 0, recoveredUnknown: 0 });
		await first.accept(command());
		expect((await first.markDispatched('cmd-1'))?.dispatchedAt).toBe(new Date(NOW).toISOString());
		const onDisk = JSON.parse(fs.readFileSync(file, 'utf8')) as { commands: { state: string }[] };
		expect(onDisk.commands.map((r) => r.state)).toEqual(['accepted']);

		const restarted = createCommandLedger({ file, now: () => NOW + 10_000 });
		expect(await restarted.load()).toEqual({ ok: true, commands: 1, recoveredUnknown: 1 });
		const record = restarted.get('cmd-1');
		expect(record?.state).toBe('unknown');
		expect(record?.detail).toMatch(/restarted/);
		expect(restarted.open()).toEqual([]);
		// Settled is settled: a late effect does not rewrite what the restart recorded.
		await restarted.settle('cmd-1', {
			state: 'settled',
			outcome: 'completed',
			evidenceDigest: DIGEST_A,
		});
		expect(restarted.get('cmd-1')?.state).toBe('unknown');
	});

	it('settles on an effect, an uncertainty or a burned denial, once', async () => {
		const ledger = createCommandLedger({ now: () => NOW });
		await ledger.accept(command());
		await ledger.accept(refreshCommand());
		await ledger.accept(
			command({ commandId: 'cmd-3', nonce: 'p'.repeat(64), idempotencyKey: 'idem-3' })
		);
		const completed = await ledger.settle('cmd-1', {
			state: 'settled',
			outcome: 'completed',
			evidenceDigest: DIGEST_A,
		});
		expect(completed).toMatchObject({
			state: 'completed',
			evidenceDigest: DIGEST_A,
			refusal: null,
		});
		await ledger.settle('cmd-1', { state: 'settled', outcome: 'failed', evidenceDigest: DIGEST_B });
		expect(ledger.get('cmd-1')).toMatchObject({ state: 'completed', evidenceDigest: DIGEST_A });
		expect(
			await ledger.settle('cmd-2', { state: 'uncertain', reason: 'transport-lost' })
		).toMatchObject({
			state: 'unknown',
			detail: 'transport-lost',
		});
		expect(
			await ledger.settle('cmd-3', {
				state: 'denied',
				reason: 'policy-denied',
				evidenceDigest: DIGEST_B,
			})
		).toMatchObject({ state: 'denied', refusal: 'policy-denied', evidenceDigest: DIGEST_B });
		expect(await ledger.settle('cmd-9', { state: 'uncertain', reason: 'owner-lost' })).toBeNull();
		expect(ledger.open()).toEqual([]);
	});

	it('writes nothing before it is loaded and names a corrupt file', async () => {
		const file = tempFile();
		const ledger = createCommandLedger({ file, now: () => NOW });
		await expect(ledger.accept(command())).rejects.toThrow(/not loaded/);
		fs.writeFileSync(file, '{"commands": [', 'utf8');
		const load = await ledger.load();
		expect(load).toMatchObject({ ok: false, reason: 'corrupt', file });
		await expect(ledger.accept(command())).rejects.toThrow(/not loaded/);
		expect(fs.readFileSync(file, 'utf8')).toBe('{"commands": [');
	});

	it('caps itself by dropping the oldest settled records and never an open one', async () => {
		const ledger = createCommandLedger({ now: () => NOW, maxCommands: 2 });
		const fresh = (n: number) =>
			command({
				commandId: `cmd-${n}`,
				nonce: String(n).padStart(64, '0'),
				idempotencyKey: `idem-${n}`,
			});
		await ledger.accept(fresh(1));
		await ledger.settle('cmd-1', {
			state: 'settled',
			outcome: 'completed',
			evidenceDigest: DIGEST_A,
		});
		await ledger.accept(fresh(2));
		await ledger.settle('cmd-2', { state: 'uncertain', reason: 'deadline-elapsed' });
		await ledger.accept(fresh(3));
		expect(ledger.list().map((r) => r.commandId)).toEqual(['cmd-2', 'cmd-3']);
		await ledger.accept(fresh(4));
		expect(ledger.list().map((r) => r.commandId)).toEqual(['cmd-3', 'cmd-4']);
		await ledger.accept(fresh(5));
		expect(ledger.list().map((r) => r.commandId)).toEqual(['cmd-3', 'cmd-4', 'cmd-5']);
		expect(ledger.get('cmd-1')).toBeNull();
	});
});

describe('the executor', () => {
	it('advertises the capabilities of the ports it was composed with', () => {
		const { executor } = make({
			ports: {
				cancel: recorder({ outcome: 'completed' }).port,
				report: recorder({ outcome: 'completed' }).port,
			},
		});
		expect(executor.capabilities()).toEqual(['command-cancel_run', 'command-report_status']);
		expect(make({ ports: {} }).executor.capabilities()).toEqual([]);
	});

	it('refuses invalid input by name and records nothing', async () => {
		const cancel = recorder({ outcome: 'completed' });
		const { executor, ledger } = make({ ports: { cancel: cancel.port } });
		expect(
			await executor.execute({ ...command(), action: { kind: 'shell', run: 'rm -rf' } })
		).toEqual({
			status: 'denied',
			commandId: 'cmd-1',
			reason: 'invalid-input',
			detail: 'action.kind "shell" is not a typed command',
		});
		expect(await executor.execute('cancel')).toMatchObject({ status: 'denied', commandId: null });
		expect(ledger.list()).toEqual([]);
		expect(cancel.calls).toEqual([]);
	});

	it('completes a cancel through its port and settles the record with its evidence', async () => {
		const cancel = recorder({
			outcome: 'completed',
			detail: 'revoked 1 lease',
			facts: { revoked: 1 },
		});
		const file = tempFile();
		const { executor, ledger } = make({ ports: { cancel: cancel.port }, file });
		await ledger.load();
		const result = await executor.execute(command());
		const evidenceDigest = commandEvidenceDigest({
			commandId: 'cmd-1',
			kind: 'cancel-run',
			outcome: 'completed',
			facts: { revoked: 1 },
		});
		expect(result).toEqual({
			status: 'completed',
			commandId: 'cmd-1',
			duplicate: false,
			evidenceDigest,
			detail: 'revoked 1 lease',
			facts: { revoked: 1 },
		});
		expect(cancel.calls).toEqual([['run-1', command()]]);
		expect(ledger.get('cmd-1')).toMatchObject({
			state: 'completed',
			evidenceDigest,
			dispatchedAt: new Date(NOW).toISOString(),
			kind: 'cancel-run',
			runId: 'run-1',
		});
		expect(JSON.parse(fs.readFileSync(file, 'utf8')).commands[0].state).toBe('completed');
	});

	it('answers a duplicate from history and runs nothing again, whatever the standing is now', async () => {
		const cancel = recorder({ outcome: 'completed' });
		let standing: CommandBinding['standing'] = { ok: true };
		const { executor } = make({
			ports: { cancel: cancel.port },
			binding: () => binding({ standing }),
		});
		const first = await executor.execute(command());
		standing = { ok: false, reason: 'the enrollment was suspended' };
		const again = await executor.execute(command());
		expect(again).toEqual({ ...first, duplicate: true, facts: null });
		expect(cancel.calls).toHaveLength(1);
		expect(await executor.execute(refreshCommand())).toEqual({
			status: 'unavailable',
			commandId: 'cmd-2',
			detail: 'the enrollment was suspended',
		});
	});

	it('refuses a replay: the id under another payload, or a nonce or key another command consumed', async () => {
		const cancel = recorder({ outcome: 'completed' });
		const { executor, ledger } = make({ ports: { cancel: cancel.port } });
		await executor.execute(command());
		expect(await executor.execute(command({ payloadDigest: DIGEST_B }))).toMatchObject({
			status: 'denied',
			reason: 'replay',
			detail: expect.stringMatching(/another payload/),
		});
		expect(
			await executor.execute(command({ commandId: 'cmd-2', payloadDigest: DIGEST_B }))
		).toMatchObject({
			status: 'denied',
			commandId: 'cmd-2',
			reason: 'replay',
			detail: expect.stringMatching(/nonce or idempotency key/),
		});
		expect(ledger.list()).toHaveLength(1);
		expect(cancel.calls).toHaveLength(1);
	});

	it('refuses a command that does not bind and leaves no record', async () => {
		const cancel = recorder({ outcome: 'completed' });
		const { executor, ledger } = make({ ports: { cancel: cancel.port } });
		const r = command().recipient;
		expect(await executor.execute(command({ recipient: { ...r, runId: 'run-9' } }))).toMatchObject({
			status: 'denied',
			reason: 'stale-run',
		});
		expect(
			await executor.execute(command({ recipient: { ...r, actorId: 'actor-2' } }))
		).toMatchObject({
			status: 'denied',
			reason: 'unauthenticated',
		});
		expect(await executor.execute(refreshCommand())).toMatchObject({
			status: 'denied',
			reason: 'unsupported-capability',
			detail: 'this host does not execute command-refresh_policy',
		});
		expect(ledger.list()).toEqual([]);
		expect(cancel.calls).toEqual([]);
	});

	it('burns the id when the recheck after acceptance fails, and never retries it', async () => {
		const cancel = recorder({ outcome: 'completed' });
		let reads = 0;
		const { executor, ledger } = make({
			ports: { cancel: cancel.port },
			// The first read binds; the policy moves before the recheck that follows acceptance.
			binding: () => binding({ policyRevision: ++reads >= 2 ? 4 : 3 }),
		});
		expect(await executor.execute(command())).toEqual({
			status: 'denied',
			commandId: 'cmd-1',
			reason: 'policy-denied',
			detail: 'the command binds policy revision 3; this host applies 4',
		});
		expect(ledger.get('cmd-1')).toMatchObject({
			state: 'denied',
			refusal: 'policy-denied',
			evidenceDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
		});
		expect(await executor.execute(command())).toMatchObject({
			status: 'denied',
			reason: 'policy-denied',
		});
		expect(cancel.calls).toEqual([]);
		expect(ledger.open()).toEqual([]);
	});

	it('leaves a command unknown when the dispatch window elapsed after acceptance', async () => {
		const cancel = recorder({ outcome: 'completed' });
		const { executor, ledger } = make({ ports: { cancel: cancel.port }, now: () => NOW + 6_000 });
		const result = await executor.execute(command());
		expect(result).toMatchObject({ status: 'unknown', duplicate: false, evidenceDigest: null });
		expect(ledger.get('cmd-1')).toMatchObject({
			state: 'unknown',
			detail: 'deadline-elapsed',
			dispatchedAt: null,
		});
		expect(await executor.execute(command())).toMatchObject({ status: 'unknown', duplicate: true });
		expect(cancel.calls).toEqual([]);
	});

	it('leaves a command unknown when the port throws after dispatch, and never retries it', async () => {
		const cancel = recorder(new Error('socket closed'));
		const { executor, ledger } = make({ ports: { cancel: cancel.port } });
		const result = await executor.execute(command());
		expect(result).toMatchObject({
			status: 'unknown',
			detail: 'the port failed after dispatch: socket closed',
		});
		expect(ledger.get('cmd-1')).toMatchObject({
			state: 'unknown',
			dispatchedAt: new Date(NOW).toISOString(),
			detail: 'the port failed after dispatch: socket closed',
		});
		expect(await executor.execute(command())).toMatchObject({ status: 'unknown', duplicate: true });
		expect(cancel.calls).toHaveLength(1);
	});

	it('keeps accepted distinct from completed until the requested effect ends', async () => {
		const cancel = recorder({ outcome: 'accepted', detail: 'stop requested' });
		const { executor, ledger } = make({ ports: { cancel: cancel.port } });
		expect(await executor.execute(command())).toMatchObject({
			status: 'accepted',
			duplicate: false,
			evidenceDigest: null,
			detail: 'stop requested',
		});
		expect(ledger.open().map((r) => r.commandId)).toEqual(['cmd-1']);
		expect(await executor.execute(command())).toMatchObject({
			status: 'accepted',
			duplicate: true,
		});
		expect(cancel.calls).toHaveLength(1);
		const evidenceDigest = commandEvidenceDigest({
			commandId: 'cmd-1',
			kind: 'cancel-run',
			outcome: 'completed',
			facts: { exitCode: 0 },
		});
		await executor.settle(
			'cmd-1',
			{ state: 'settled', outcome: 'completed', evidenceDigest },
			'exited 0'
		);
		expect(ledger.open()).toEqual([]);
		expect(await executor.execute(command())).toMatchObject({
			status: 'completed',
			duplicate: true,
			evidenceDigest,
			detail: 'exited 0',
		});
	});

	it('reports failed and no-effect as the port saw them, with the action it was handed', async () => {
		const cancel = recorder({ outcome: 'no-effect', detail: 'the run had ended' });
		const refresh = recorder({ outcome: 'failed', detail: 'the endpoint answered 503' });
		const report = recorder({ outcome: 'completed', facts: { agents: 2 } });
		const { executor, ledger } = make({
			ports: { cancel: cancel.port, refresh: refresh.port, report: report.port },
		});
		const ended = command({ recipient: { ...command().recipient, runId: 'run-2' } });
		expect(await executor.execute(ended)).toMatchObject({
			status: 'no-effect',
			detail: 'the run had ended',
		});
		expect(cancel.calls).toEqual([['run-2', ended]]);
		expect(await executor.execute(refreshCommand(4))).toMatchObject({ status: 'failed' });
		expect(refresh.calls).toEqual([[4, refreshCommand(4)]]);
		const status = command({
			commandId: 'cmd-3',
			nonce: 'p'.repeat(64),
			idempotencyKey: 'idem-3',
			recipient: { ...command().recipient, runId: null },
			action: { kind: 'report-status' },
			preconditions: { ...command().preconditions, requiredCapability: 'command-report_status' },
		});
		expect(await executor.execute(status)).toMatchObject({
			status: 'completed',
			facts: { agents: 2 },
		});
		expect(report.calls).toEqual([[status]]);
		expect(ledger.list().map((r) => [r.commandId, r.state])).toEqual([
			['cmd-1', 'no-effect'],
			['cmd-2', 'failed'],
			['cmd-3', 'completed'],
		]);
	});

	it('carries an operator prompt to the prompt port alone and keeps none of its text', async () => {
		const prompt = recorder({ outcome: 'completed' });
		const cancel = recorder({ outcome: 'completed' });
		const file = tempFile();
		const { executor, ledger } = make({
			ports: { prompt: prompt.port, cancel: cancel.port },
			file,
		});
		await ledger.load();
		expect(await executor.execute(promptCommand())).toMatchObject({ status: 'completed' });
		expect(prompt.calls).toEqual([['say hi', 'run-1', promptCommand()]]);
		expect(cancel.calls).toEqual([]);
		expect(fs.readFileSync(file, 'utf8')).not.toContain('say hi');
		expect(ledger.get('cmd-1')).toMatchObject({ kind: 'operator-prompt', payloadDigest: DIGEST_A });

		// Without a prompt port the capability is not advertised, so the command never binds.
		const bare = make({ ports: { cancel: recorder({ outcome: 'completed' }).port } });
		expect(await bare.executor.execute(promptCommand())).toMatchObject({
			status: 'denied',
			reason: 'unsupported-capability',
		});
		// Without its own approval it is refused before anything is recorded.
		const unapproved = {
			...promptCommand(),
			approval: { kind: 'policy-not-required', policyRevision: 3 },
		};
		expect(
			await executor.execute({
				...unapproved,
				commandId: 'cmd-2',
				nonce: 'm'.repeat(64),
				idempotencyKey: 'idem-2',
			})
		).toMatchObject({
			status: 'denied',
			reason: 'approval-required',
		});
		expect(ledger.list()).toHaveLength(1);
		expect(prompt.calls).toHaveLength(1);
	});

	it('answers unavailable when the ledger cannot be written, so nothing runs', async () => {
		const cancel = recorder({ outcome: 'completed' });
		const { executor } = make({ ports: { cancel: cancel.port }, file: tempFile() });
		// Never loaded: the ledger refuses to accept, and the executor refuses to act without it.
		expect(await executor.execute(command())).toMatchObject({
			status: 'unavailable',
			commandId: 'cmd-1',
			detail: expect.stringMatching(/could not be written, so nothing ran/),
		});
		expect(cancel.calls).toEqual([]);
	});
});
