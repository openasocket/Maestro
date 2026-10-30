/**
 * `startTurn` against a real process.
 *
 * The run layer is the part that owns a process, so its tests start one: the
 * fake agent in `src/__tests__/fixtures/fake-agent.mjs`, replaying a turn.
 * The ownership-race cases below isolate process operations with scoped spies.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import * as childProcess from 'child_process';
import * as artifactFs from 'fs';
import * as parserFactory from '../../../../shared/maestro-lib/parsers/parser-factory';
import { logger } from '../../../../shared/maestro-lib/host';
import * as processTree from '../../../../shared/maestro-lib/control/process-tree';
import * as platform from '../../../../shared/platformDetection';
import {
	trackProcessTree,
	TREE_REFRESH_MS,
} from '../../../../shared/maestro-lib/control/termination';

// Mutable facades allow scoped spies without changing the real-process cases.
vi.mock('child_process', async (original) => ({
	...(await original<typeof import('child_process')>()),
}));
vi.mock('fs', async (original) => ({ ...(await original<typeof import('fs')>()) }));
vi.mock('../../../../shared/maestro-lib/parsers/parser-factory', async (original) => ({
	...(await original<typeof import('../../../../shared/maestro-lib/parsers/parser-factory')>()),
}));
vi.mock('../../../../shared/maestro-lib/control/process-tree', async (original) => ({
	...(await original<typeof import('../../../../shared/maestro-lib/control/process-tree')>()),
}));
vi.mock('../../../../shared/platformDetection', async (original) => ({
	...(await original<typeof import('../../../../shared/platformDetection')>()),
}));
import fs from 'node:fs';
import path from 'node:path';

import {
	applyWindowsShellRules,
	DispatchRefusedError,
	startTurn,
	turnProcessSpecFromPlan,
	type DispatchAdmission,
	type TurnProcessSpec,
	type LocalLaunchPlan,
	type StartTurnOptions,
	type TurnHandlers,
	type TurnHandle,
} from '../../../../shared/maestro-lib/run/start-turn';
import {
	buildDispatchSnapshot,
	createContextVerifier,
	createLocalHostAuthority,
	dispatchSnapshotDigest,
	type DispatchLease,
	type HostAuthority,
} from '../../../../shared/maestro-lib/managed/authority';
import { MANAGED_CONTRACT_VERSION } from '../../../../shared/maestro-lib/managed/types';
import type { ParsedEvent } from '../../../../shared/maestro-lib/parsers/agent-output-parser';
import { createOutputParser } from '../../../../shared/maestro-lib/parsers/parser-factory';
// The desktop spawners' own import path: the library must escape with that code.
import { escapeCmdArg } from '../../../../main/process-manager/utils/shellEscape';
import { CAPTURED_RECORDINGS } from '../../../main/process-manager/recordings/captured';
import { createScratchDir, fakeAgentSpec, fakeTurnFromRecording, type FakeTurn } from './fakeAgent';

const OPTIONS: StartTurnOptions = { stopGraceMs: 200 };
const posixIt = it.skipIf(process.platform === 'win32');

/** A real OpenCode turn, as captured: every chunk exactly as it arrived. */
const OPENCODE_TURN = fakeTurnFromRecording(CAPTURED_RECORDINGS['captured-opencode-normal']);
const OPENCODE_LINES = OPENCODE_TURN.chunks
	.join('')
	.split('\n')
	.filter((text) => text.length > 0);

/** What the provider's parser makes of those lines, with no process involved. */
function parseInProcess(lines: string[]): ParsedEvent[] {
	const parser = createOutputParser('opencode')!;
	return lines
		.map((text) => parser.parseJsonLine(text))
		.filter((event): event is ParsedEvent => event !== null);
}

let scratch: { dir: string; cleanup: () => void };

beforeAll(() => {
	scratch = createScratchDir('maestro-run-layer');
});

afterAll(() => {
	scratch.cleanup();
});

/** Handlers that record everything they hear, in the order they hear it. */
function recorder() {
	const heard: string[] = [];
	const lines: string[] = [];
	const events: ParsedEvent[] = [];
	const handlers: TurnHandlers = {
		onStarted: () => heard.push('started'),
		onStdout: () => heard.push('stdout'),
		onStderr: () => heard.push('stderr'),
		onLine: (text) => {
			heard.push('line');
			lines.push(text);
		},
		onEvent: (event) => {
			heard.push(`event:${event.type}`);
			events.push(event);
		},
	};
	return { heard, lines, events, handlers };
}

describe('startTurn private prompt artifacts', () => {
	let files: ReturnType<typeof createScratchDir>;
	let child: childProcess.ChildProcess;
	let current: TurnHandle | undefined;
	let spec: TurnProcessSpec;
	let artifact: NonNullable<TurnProcessSpec['promptArtifact']>;
	let descriptor: number | undefined;
	let descriptorOpen: boolean;
	const attribution = { provider: 'grok' } as const;

	beforeEach(() => {
		vi.useFakeTimers();
		files = createScratchDir('maestro-prompt-artifact');
		current = undefined;
		descriptor = undefined;
		descriptorOpen = false;
		artifact = {
			owner: 'local',
			path: path.join(files.dir, 'private-prompt.json'),
			content: JSON.stringify({ prompt: 'synthetic-private-content 🦊\nnext line' }),
			encoding: 'utf8',
			mode: 0o600,
			flag: 'wx',
			cleanup: 'turn',
		};
		spec = {
			command: process.execPath,
			args: ['--prompt-file', artifact.path],
			cwd: files.dir,
			env: {},
			promptArtifact: artifact,
		};
		child = Object.assign(new EventEmitter(), {
			pid: 4242,
			exitCode: null,
			signalCode: null,
			kill: vi.fn(() => true),
			stdin: new PassThrough(),
			stdout: new PassThrough(),
			stderr: new PassThrough(),
		}) as unknown as childProcess.ChildProcess;
		vi.spyOn(childProcess, 'spawn').mockReturnValue(child);
		vi.spyOn(platform, 'isWindows').mockReturnValue(false);
		vi.spyOn(processTree, 'snapshotProcessTree').mockReturnValue({ owned: false, descendants: [] });
		vi.spyOn(processTree, 'killProcessTreeNow').mockImplementation(() => {});
		vi.spyOn(process, 'kill').mockReturnValue(true);
		vi.spyOn(artifactFs, 'openSync').mockImplementation((...args) => {
			descriptor = fs.openSync(...args);
			descriptorOpen = true;
			return descriptor;
		});
		vi.spyOn(artifactFs, 'closeSync').mockImplementation((fd) => {
			fs.closeSync(fd);
			if (fd === descriptor) descriptorOpen = false;
		});
		vi.spyOn(logger, 'warn').mockImplementation(() => {});
	});

	afterEach(async () => {
		try {
			child.emit('close', 0, null);
			await current?.done;
		} finally {
			child.stdin?.destroy();
			child.stdout?.destroy();
			child.stderr?.destroy();
			vi.clearAllTimers();
			vi.useRealTimers();
			vi.restoreAllMocks();
			// Also release a leaked descriptor when an assertion exposes a regression.
			if (descriptorOpen && descriptor !== undefined) {
				try {
					fs.closeSync(descriptor);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== 'EBADF') throw error;
				}
			}
			files.cleanup();
		}
	});

	function expectClosed() {
		expect(descriptor).toBeTypeOf('number');
		expect(artifactFs.closeSync).toHaveBeenCalledExactlyOnceWith(descriptor);
		expect(() => fs.fstatSync(descriptor!)).toThrow(expect.objectContaining({ code: 'EBADF' }));
	}

	it.each([
		['empty bytes', '', 0],
		['empty JSON prompt', '{"prompt":""}', 0],
		['Unicode JSON', JSON.stringify({ prompt: '雪 🦊\n"quoted"\r\n\t' }), 0],
		['large JSON', JSON.stringify({ prompt: '🦊\n'.repeat(100_000) }), 7],
	] as const)('preserves %s until reader close', async (_label, content, code) => {
		artifact.content = content;
		current = startTurn(spec, {}, OPTIONS);
		expect(artifactFs.openSync).toHaveBeenCalledExactlyOnceWith(artifact.path, 'wx', 0o600);
		expect(fs.readFileSync(artifact.path)).toEqual(Buffer.from(content, 'utf8'));
		if (process.platform !== 'win32') expect(fs.statSync(artifact.path).mode & 0o777).toBe(0o600);
		expect((child.stdin as PassThrough).read()).toBeNull();
		Object.assign(child, { exitCode: code });
		child.emit('exit', code, null);
		expect(fs.existsSync(artifact.path)).toBe(true);
		expect(artifactFs.closeSync).not.toHaveBeenCalled();
		child.emit('close', code, null);
		expect(await current.done).toMatchObject({ exitCode: code, interrupted: false });
		expect(fs.existsSync(artifact.path)).toBe(false);
		expectClosed();
	});

	it('preserves an exclusive-create collision without acquiring a descriptor', () => {
		fs.writeFileSync(artifact.path, 'other owner');
		expect(() => startTurn(spec, {}, OPTIONS)).toThrow(
			/^Could not prepare the private prompt artifact\.$/
		);
		expect(fs.readFileSync(artifact.path, 'utf8')).toBe('other owner');
		expect(descriptor).toBeUndefined();
		expect(artifactFs.closeSync).not.toHaveBeenCalled();
		expect(childProcess.spawn).not.toHaveBeenCalled();
	});

	it.each(['replacement', 'missing'] as const)(
		'closes its descriptor after a %s path',
		async (kind) => {
			current = startTurn(spec, {}, OPTIONS);
			if (kind === 'replacement')
				fs.renameSync(artifact.path, path.join(files.dir, 'original.json'));
			else fs.unlinkSync(artifact.path);
			if (kind === 'replacement') fs.writeFileSync(artifact.path, 'other owner');
			child.emit('close', 0, null);
			await current.done;
			if (kind === 'replacement') {
				expect(fs.readFileSync(artifact.path, 'utf8')).toBe('other owner');
				expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
					'Prompt artifact changed ownership; cleanup skipped.',
					'startTurn'
				);
			} else expect(logger.warn).not.toHaveBeenCalled();
			expectClosed();
		}
	);

	it('removes partial writes and reports a fixed preparation error', () => {
		vi.spyOn(artifactFs, 'writeFileSync').mockImplementationOnce((fd) => {
			fs.writeSync(fd as number, 'partial');
			throw new Error(`write failed: ${artifact.path} ${artifact.content}`);
		});
		expect(() => startTurn(spec, {}, OPTIONS)).toThrow(
			/^Could not prepare the private prompt artifact\.$/
		);
		expect(fs.existsSync(artifact.path)).toBe(false);
		expect(childProcess.spawn).not.toHaveBeenCalled();
		expect(logger.warn).not.toHaveBeenCalled();
		expectClosed();
	});

	it.each(['synchronous', 'asynchronous'] as const)(
		'cleans up a %s spawn failure',
		async (kind) => {
			const error = Object.assign(new Error('synthetic spawn failure'), { code: 'ENOENT' });
			if (kind === 'synchronous') {
				vi.mocked(childProcess.spawn).mockImplementationOnce(() => {
					throw error;
				});
				expect(() => startTurn(spec, {}, OPTIONS)).toThrow(error);
			} else {
				Object.assign(child, { pid: undefined });
				current = startTurn(spec, {}, OPTIONS);
				child.emit('error', error);
				expect((await current.done).spawnError).toBe(error);
				child.emit('close', -2, null);
			}
			expect(fs.existsSync(artifact.path)).toBe(false);
			expectClosed();
		}
	);

	it('constructs the parser before acquiring a file or child', () => {
		vi.spyOn(parserFactory, 'createOutputParser').mockImplementationOnce(() => {
			throw new Error('synthetic parser failure');
		});
		expect(() => startTurn(spec, {}, { ...OPTIONS, agentId: 'grok' })).toThrow(
			'synthetic parser failure'
		);
		expect(artifactFs.openSync).not.toHaveBeenCalled();
		expect(artifactFs.closeSync).not.toHaveBeenCalled();
		expect(childProcess.spawn).not.toHaveBeenCalled();
	});

	it.each(['before', 'preflight', 'final'] as const)(
		'cleans cancellation %s admission without spawning',
		(when) => {
			const controller = new AbortController();
			if (when === 'before') controller.abort();
			const admit = vi.fn<DispatchAdmission['admit']>(() => {
				if (when === 'preflight' || admit.mock.calls.length === 2) controller.abort();
				return { ok: true };
			});
			expect(() =>
				startTurn(
					spec,
					{},
					{ ...OPTIONS, signal: controller.signal, admission: { gate: { admit }, attribution } }
				)
			).toThrow(/^Prompt-file launch was cancelled before spawn\.$/);
			expect(fs.existsSync(artifact.path)).toBe(false);
			expect(childProcess.spawn).not.toHaveBeenCalled();
			if (when === 'final') expectClosed();
			else expect(artifactFs.openSync).not.toHaveBeenCalled();
		}
	);

	it.each(['cancellation', 'signal error'] as const)(
		'retains ownership after %s until reader close',
		async (reason) => {
			const controller = new AbortController();
			const released = vi.fn();
			current = startTurn(
				spec,
				{},
				{
					...OPTIONS,
					signal: controller.signal,
					admission: { gate: { admit: () => ({ ok: true }), released }, attribution },
				}
			);
			if (reason === 'cancellation') controller.abort();
			else child.emit('error', Object.assign(new Error('signal denied'), { code: 'EPERM' }));
			expect(child.kill).toHaveBeenCalledWith('SIGTERM');
			Object.assign(child, { signalCode: 'SIGTERM' });
			child.emit('exit', null, 'SIGTERM');
			expect(fs.readFileSync(artifact.path, 'utf8')).toBe(artifact.content);
			expect(artifactFs.closeSync).not.toHaveBeenCalled();
			expect(released).not.toHaveBeenCalled();
			child.emit('close', null, 'SIGTERM');
			expect(await current.done).toMatchObject({ signal: 'SIGTERM', interrupted: true });
			expect((await current.done).spawnError).toBeUndefined();
			expect(released).toHaveBeenCalledTimes(1);
			expect(fs.existsSync(artifact.path)).toBe(false);
			expectClosed();
		}
	);

	it.each(['preflight', 'final'] as const)(
		'refuses %s admission and removes only owned preparation',
		(when) => {
			const admit = vi.fn<DispatchAdmission['admit']>(() => {
				expect(fs.existsSync(artifact.path)).toBe(admit.mock.calls.length === 2);
				return when === 'preflight' || admit.mock.calls.length === 2
					? { ok: false, state: 'denied', code: 'policy-denied', message: 'synthetic denial' }
					: { ok: true };
			});
			const bound = vi.fn();
			expect(() =>
				startTurn(spec, {}, { ...OPTIONS, admission: { gate: { admit, bound }, attribution } })
			).toThrow(DispatchRefusedError);
			expect(bound).not.toHaveBeenCalled();
			expect(childProcess.spawn).not.toHaveBeenCalled();
			expect(fs.existsSync(artifact.path)).toBe(false);
			if (when === 'final') expectClosed();
			else expect(artifactFs.openSync).not.toHaveBeenCalled();
		}
	);

	it('keeps admitted bytes and launch inputs when callbacks mutate the originals', async () => {
		const original = { ...artifact };
		const snapshot = buildDispatchSnapshot(spec, attribution);
		const admit = vi.fn<DispatchAdmission['admit']>((seen) => {
			expect(seen).toEqual(snapshot);
			artifact.content = 'replaced';
			artifact.path = path.join(files.dir, 'redirected.json');
			spec.args[1] = artifact.path;
			spec.env.REPLACED = 'yes';
			spec.command = 'replaced';
			return { ok: true };
		});
		current = startTurn(spec, {}, { ...OPTIONS, admission: { gate: { admit }, attribution } });
		expect(admit).toHaveBeenCalledTimes(2);
		expect(fs.readFileSync(original.path, 'utf8')).toBe(original.content);
		expect(fs.existsSync(artifact.path)).toBe(false);
		expect(childProcess.spawn).toHaveBeenCalledWith(
			process.execPath,
			['--prompt-file', original.path],
			{ cwd: files.dir, env: {}, shell: false, stdio: ['pipe', 'pipe', 'pipe'] }
		);
		child.emit('close', 0, null);
		await current.done;
		expect(fs.existsSync(original.path)).toBe(false);
		expectClosed();
	});

	it.each(['fstatSync', 'lstatSync', 'unlinkSync', 'closeSync'] as const)(
		'reports %s cleanup failure without private data',
		async (operation) => {
			current = startTurn(spec, {}, OPTIONS);
			vi.spyOn(artifactFs, operation).mockImplementationOnce(() => {
				// Simulate an error after closing so the fixture never intentionally leaks.
				if (operation === 'closeSync') {
					fs.closeSync(descriptor!);
					descriptorOpen = false;
				}
				throw Object.assign(new Error(`${artifact.path}: ${artifact.content}`), { code: 'EIO' });
			});
			child.emit('close', 0, null);
			await current.done;
			expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
				operation === 'closeSync'
					? 'Could not close an owned prompt artifact.'
					: 'Could not remove an owned prompt artifact.',
				'startTurn'
			);
			expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain(artifact.path);
			expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain(artifact.content);
			expect(fs.existsSync(artifact.path)).toBe(operation !== 'closeSync');
			expectClosed();
		}
	);
});

describe('startTurn', () => {
	it('streams every line and parsed event, then reports a clean exit', async () => {
		const { heard, lines, events, handlers } = recorder();

		const turn = startTurn(fakeAgentSpec(scratch.dir, OPENCODE_TURN), handlers, {
			...OPTIONS,
			agentId: 'opencode',
		});
		const exit = await turn.done;

		expect(exit).toMatchObject({
			exitCode: 0,
			signal: null,
			interrupted: false,
			droppedOutputBytes: 0,
		});
		expect(exit.spawnError).toBeUndefined();
		expect(lines).toEqual(OPENCODE_LINES);
		// A process in between adds nothing and loses nothing.
		expect(events).toEqual(parseInProcess(OPENCODE_LINES));
		expect(events.length).toBeGreaterThan(0);
		expect(heard[0]).toBe('started');
		expect(turn.pid).toBeGreaterThan(0);
	});

	it('has delivered every event by the time done resolves', async () => {
		const { events, handlers } = recorder();

		const turn = startTurn(fakeAgentSpec(scratch.dir, OPENCODE_TURN), handlers, {
			...OPTIONS,
			agentId: 'opencode',
		});
		let eventsAtSettle = -1;
		await turn.done.then(() => {
			eventsAtSettle = events.length;
		});

		expect(eventsAtSettle).toBe(parseInProcess(OPENCODE_LINES).length);
	});

	it('reads a last line that has no trailing newline', async () => {
		const { lines, handlers } = recorder();

		const turn = startTurn(
			fakeAgentSpec(scratch.dir, {
				chunks: ['first\n', 'second with no newline'],
				close: { code: 0, signal: null },
			}),
			handlers,
			OPTIONS
		);
		await turn.done;

		expect(lines).toEqual(['first', 'second with no newline']);
	});

	it('reassembles a line that arrived split across chunks', async () => {
		const { lines, handlers } = recorder();
		const whole = JSON.stringify({ type: 'text', text: 'a'.repeat(200) });

		const turn = startTurn(
			fakeAgentSpec(scratch.dir, {
				chunks: [whole.slice(0, 40), whole.slice(40, 120), `${whole.slice(120)}\n`],
				close: { code: 0, signal: null },
			}),
			handlers,
			OPTIONS
		);
		await turn.done;

		expect(lines).toEqual([whole]);
	});

	it('keeps a multibyte character that was split across two reads', async () => {
		const { lines, handlers } = recorder();

		const turn = startTurn(
			fakeAgentSpec(scratch.dir, {
				chunks: ['café \u{1F600} déjà vu\n'],
				close: { code: 0, signal: null },
			}),
			handlers,
			OPTIONS
		);
		await turn.done;

		expect(lines).toEqual(['café \u{1F600} déjà vu']);
	});

	it('reports stderr and a non-zero exit code', async () => {
		const { handlers } = recorder();

		const turn = startTurn(
			fakeAgentSpec(scratch.dir, {
				chunks: [],
				stderr: 'Error: not logged in\n',
				close: { code: 7, signal: null },
			}),
			handlers,
			OPTIONS
		);
		const exit = await turn.done;

		expect(exit.exitCode).toBe(7);
		expect(exit.stderrText).toBe('Error: not logged in\n');
		expect(exit.interrupted).toBe(false);
	});

	it('keeps only a bounded tail of stdout', async () => {
		const turn = startTurn(
			fakeAgentSpec(scratch.dir, {
				chunks: [`${'x'.repeat(500)}\n`, 'the end\n'],
				close: { code: 0, signal: null },
			}),
			{},
			{ ...OPTIONS, stdoutTailLimit: 16 }
		);
		const exit = await turn.done;

		expect(exit.stdoutText).toHaveLength(16);
		expect(exit.stdoutText.endsWith('the end\n')).toBe(true);
	});

	it('keeps all of stderr unless the caller sets a limit', async () => {
		const noisy = `${'w'.repeat(500)}\nError: not logged in\n`;
		const spec = () =>
			fakeAgentSpec(scratch.dir, { chunks: [], stderr: noisy, close: { code: 7, signal: null } });

		const whole = await startTurn(spec(), {}, OPTIONS).done;
		const tail = await startTurn(spec(), {}, { ...OPTIONS, stderrTailLimit: 21 }).done;

		expect(whole.stderrText).toBe(noisy);
		expect(tail.stderrText).toBe('Error: not logged in\n');
	});

	it('keeps no copy of either stream for a caller that holds its own', async () => {
		let heardStdout = '';
		let heardStderr = '';

		const turn = startTurn(
			fakeAgentSpec(scratch.dir, {
				chunks: ['the answer\n'],
				stderr: 'a warning\n',
				close: { code: 0, signal: null },
			}),
			{
				onStdout: (text) => (heardStdout += text),
				onStderr: (text) => (heardStderr += text),
			},
			{ ...OPTIONS, stdoutTailLimit: 0, stderrTailLimit: 0 }
		);
		const exit = await turn.done;

		expect(exit.stdoutText).toBe('');
		expect(exit.stderrText).toBe('');
		// The handlers still receive every chunk.
		expect(heardStdout).toBe('the answer\n');
		expect(heardStderr).toBe('a warning\n');
	});

	it('reports a stdin error to its handler instead of throwing it at the host', async () => {
		// With no listener on the stream, this error is an uncaught exception.
		const errors: Error[] = [];
		const turn = startTurn(
			fakeAgentSpec(scratch.dir, OPENCODE_TURN),
			{ onStdinError: (error) => errors.push(error) },
			OPTIONS
		);
		const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });

		expect(() => turn.child.stdin!.emit('error', epipe)).not.toThrow();
		const exit = await turn.done;

		expect(errors).toEqual([epipe]);
		expect(exit.exitCode).toBe(0);
	});

	it('survives a stdin error when the caller passes no handler for it', async () => {
		const turn = startTurn(fakeAgentSpec(scratch.dir, OPENCODE_TURN), {}, OPTIONS);

		expect(() => turn.child.stdin!.emit('error', new Error('write EPIPE'))).not.toThrow();
		const exit = await turn.done;
		expect(exit.exitCode).toBe(0);
		// Not a failure of the prompt's own write, so the turn is not charged with it.
		expect(exit.stdinError).toBeUndefined();
	});

	posixIt(
		'keeps the error of a prompt the process closed stdin on, even on a clean exit',
		async () => {
			// A prompt larger than the pipe's buffer is still being written when the
			// process closes its end, so the write fails with EPIPE. The process then
			// exits 0, which alone would read as a finished turn.
			const errors: Error[] = [];
			const turn = startTurn(
				{
					command: process.execPath,
					args: ['-e', 'require("fs").closeSync(0); setTimeout(() => process.exit(0), 200);'],
					cwd: scratch.dir,
					env: process.env,
					stdin: 'p'.repeat(4 * 1024 * 1024),
				},
				{ onStdinError: (error) => errors.push(error) },
				OPTIONS
			);
			const exit = await turn.done;

			expect(exit.exitCode).toBe(0);
			expect((exit.stdinError as NodeJS.ErrnoException | undefined)?.code).toBe('EPIPE');
			expect(errors).toContain(exit.stdinError);
		}
	);

	it('has no stdin error for a prompt the process read', async () => {
		const turn = startTurn(
			fakeAgentSpec(scratch.dir, OPENCODE_TURN, { stdin: 'the prompt' }),
			{},
			OPTIONS
		);

		expect((await turn.done).stdinError).toBeUndefined();
	});

	it('counts and reports the bytes of a line too long to buffer', async () => {
		const { lines, handlers } = recorder();
		let reported = 0;

		// The long line is the unterminated tail. A long line followed by its
		// newline only trips the cap when the pipe delivers the two in separate
		// reads; when they coalesce the line is complete and nothing is dropped,
		// which made this test flake under CI load. An unterminated tail is
		// over the cap however the pipe splits it.
		const turn = startTurn(
			fakeAgentSpec(scratch.dir, {
				chunks: ['short\n', 'y'.repeat(4096)],
				close: { code: 0, signal: null },
			}),
			{ ...handlers, onOversizedLine: (dropped) => (reported += dropped) },
			{ ...OPTIONS, maxLineLength: 1024 }
		);
		const exit = await turn.done;

		expect(exit.droppedOutputBytes).toBeGreaterThan(0);
		expect(reported).toBe(exit.droppedOutputBytes);
		expect(lines).toContain('short');
	});

	it('frames no lines for a caller that takes only the raw stream', async () => {
		// Desktop chat frames the stream itself. With nobody to hand a line to,
		// nothing is buffered, so a stream that never ends a line costs nothing
		// and nothing is reported as dropped.
		let raw = '';
		let reported = 0;

		const turn = startTurn(
			fakeAgentSpec(scratch.dir, {
				chunks: ['y'.repeat(8192)],
				close: { code: 0, signal: null },
			}),
			{ onStdout: (text) => (raw += text), onOversizedLine: (dropped) => (reported += dropped) },
			{ ...OPTIONS, maxLineLength: 1024 }
		);
		const exit = await turn.done;

		expect(raw).toHaveLength(8192);
		expect(exit.droppedOutputBytes).toBe(0);
		expect(reported).toBe(0);
	});

	it('buffers a line of any length when no limit is set', async () => {
		const { lines, handlers } = recorder();
		const long = 'z'.repeat(2 * 1024 * 1024);

		const turn = startTurn(
			fakeAgentSpec(scratch.dir, { chunks: [`${long}\n`], close: { code: 0, signal: null } }),
			handlers,
			OPTIONS
		);
		const exit = await turn.done;

		expect(exit.droppedOutputBytes).toBe(0);
		expect(lines).toEqual([long]);
	});

	it('writes the spec stdin to the process and closes it', async () => {
		const stdinOut = path.join(scratch.dir, 'stdin-delivered.txt');

		const turn = startTurn(
			fakeAgentSpec(scratch.dir, OPENCODE_TURN, {
				stdin: 'What is the capital of France?',
				stdinOut,
			}),
			{},
			OPTIONS
		);
		const exit = await turn.done;

		// The fake agent reads stdin to its END before replaying, so a clean exit
		// also proves stdin was closed.
		expect(exit.exitCode).toBe(0);
		expect(fs.readFileSync(stdinOut, 'utf8')).toBe('What is the capital of France?');
	});

	it('closes stdin when there is nothing to write', async () => {
		const stdinOut = path.join(scratch.dir, 'stdin-empty.txt');

		const turn = startTurn(fakeAgentSpec(scratch.dir, OPENCODE_TURN, { stdinOut }), {}, OPTIONS);
		const exit = await turn.done;

		expect(exit.exitCode).toBe(0);
		expect(fs.readFileSync(stdinOut, 'utf8')).toBe('');
	});

	it('gives the process the null device when asked to ignore an empty stdin', async () => {
		const stdinOut = path.join(scratch.dir, 'stdin-ignored.txt');

		const turn = startTurn(
			fakeAgentSpec(scratch.dir, OPENCODE_TURN, { stdinOut }),
			{},
			{ ...OPTIONS, emptyStdin: 'ignore' }
		);
		const exit = await turn.done;

		expect(turn.child.stdin).toBeNull();
		expect(exit.exitCode).toBe(0);
		expect(fs.readFileSync(stdinOut, 'utf8')).toBe('');
	});

	it('reports a command that does not exist through done, not by throwing', async () => {
		const turn = startTurn(
			{
				command: path.join(scratch.dir, 'no-such-binary'),
				args: [],
				cwd: scratch.dir,
				env: process.env,
			},
			{},
			OPTIONS
		);
		const exit = await turn.done;

		expect(exit.spawnError).toBeInstanceOf(Error);
		expect((exit.spawnError as NodeJS.ErrnoException).code).toBe('ENOENT');
		expect(exit.exitCode).toBeNull();
	});

	it('parses nothing when no provider is named', async () => {
		const { lines, events, handlers } = recorder();

		const turn = startTurn(fakeAgentSpec(scratch.dir, OPENCODE_TURN), handlers, OPTIONS);
		await turn.done;

		expect(turn.parser).toBeNull();
		expect(lines).toEqual(OPENCODE_LINES);
		expect(events).toEqual([]);
	});

	it('gives each turn its own parser', async () => {
		const first = startTurn(
			fakeAgentSpec(scratch.dir, OPENCODE_TURN),
			{},
			{ ...OPTIONS, agentId: 'codex' }
		);
		const second = startTurn(
			fakeAgentSpec(scratch.dir, OPENCODE_TURN),
			{},
			{ ...OPTIONS, agentId: 'codex' }
		);
		await Promise.all([first.done, second.done]);

		expect(first.parser).not.toBeNull();
		expect(first.parser).not.toBe(second.parser);
	});

	posixIt('reports the signal that ended the process', async () => {
		const turn = startTurn(
			fakeAgentSpec(scratch.dir, { chunks: [], close: { code: null, signal: 'SIGTERM' } }),
			{},
			OPTIONS
		);
		const exit = await turn.done;

		expect(exit).toMatchObject({ exitCode: null, signal: 'SIGTERM', interrupted: false });
	});
});

describe('stopping a turn', () => {
	/** Resolves once the fake agent has replayed its turn and is holding. */
	function startHeldTurn(options: Partial<StartTurnOptions> = {}) {
		let ready!: () => void;
		const replayed = new Promise<void>((resolve) => {
			ready = resolve;
		});
		const turn = startTurn(
			fakeAgentSpec(scratch.dir, OPENCODE_TURN, { hold: true }),
			{
				onEvent: (event) => {
					if (event.type === 'result') ready();
				},
			},
			{ ...OPTIONS, agentId: 'opencode', ...options }
		);
		return { turn, replayed };
	}

	it('interrupt ends the turn and marks it interrupted', async () => {
		const { turn, replayed } = startHeldTurn();
		await replayed;
		expect(turn.stopRequested()).toBe(false);

		turn.interrupt();
		const exit = await turn.done;

		expect(turn.stopRequested()).toBe(true);
		expect(exit.interrupted).toBe(true);
	});

	it('terminate ends the turn and marks it interrupted', async () => {
		const { turn, replayed } = startHeldTurn();
		await replayed;

		turn.terminate();
		const exit = await turn.done;

		expect(exit.interrupted).toBe(true);
	});

	it('terminateNow ends the turn without waiting out a grace period', async () => {
		const { turn, replayed } = startHeldTurn({ stopGraceMs: 60_000 });
		await replayed;

		const before = Date.now();
		turn.terminateNow();
		const exit = await turn.done;

		expect(exit.interrupted).toBe(true);
		expect(Date.now() - before).toBeLessThan(5000);
	});

	it('an abort signal stops the turn', async () => {
		const controller = new AbortController();
		const { turn, replayed } = startHeldTurn({ signal: controller.signal });
		await replayed;

		controller.abort();
		const exit = await turn.done;

		expect(exit.interrupted).toBe(true);
	});

	it('a signal that was already aborted stops the turn as soon as it starts', async () => {
		const controller = new AbortController();
		controller.abort();

		const { turn } = startHeldTurn({ signal: controller.signal });
		const exit = await turn.done;

		expect(exit.interrupted).toBe(true);
	});

	it('a turn that finished on its own is not marked interrupted by a late abort', async () => {
		const controller = new AbortController();
		const turn = startTurn(
			fakeAgentSpec(scratch.dir, OPENCODE_TURN),
			{},
			{ ...OPTIONS, signal: controller.signal }
		);
		const exit = await turn.done;
		controller.abort();

		expect(exit.interrupted).toBe(false);
		expect(turn.stopRequested()).toBe(false);
	});
});

describe('turnProcessSpecFromPlan', () => {
	it('carries the plan command, arguments, directory, environment and stdin', () => {
		const plan: LocalLaunchPlan = {
			target: { kind: 'local' },
			command: '/usr/local/bin/hermes',
			args: ['chat', '--query-file', '-'],
			cwd: '/project',
			prompt: { via: 'stdin', format: 'raw', args: ['--query-file', '-'] },
			stdin: 'fix the bug',
			envVars: { HERMES_HOME: '/h' },
			env: { PATH: '/usr/bin', HERMES_HOME: '/h' },
		};

		expect(turnProcessSpecFromPlan(plan)).toEqual({
			command: '/usr/local/bin/hermes',
			args: ['chat', '--query-file', '-'],
			cwd: '/project',
			env: { PATH: '/usr/bin', HERMES_HOME: '/h' },
			stdin: 'fix the bug',
		});
	});
});

describe('applyWindowsShellRules', () => {
	const SHIM = 'C:\\Users\\First Last\\AppData\\Roaming\\npm\\codex.cmd';
	const ARGS = ['exec', '--json', 'a b', 'say "hi"', 'x&y', 'up^down'];
	const spec = (command: string, extra: Partial<TurnProcessSpec> = {}): TurnProcessSpec => ({
		command,
		args: ARGS,
		cwd: 'C:\\project',
		env: {},
		stdin: 'the prompt',
		...extra,
	});

	it('turns the shell on for a .cmd shim, quotes its path and escapes every argument as the desktop does', () => {
		expect(applyWindowsShellRules(spec(SHIM), { isWindowsHost: true })).toEqual({
			...spec(SHIM),
			command: `"${SHIM}"`,
			args: ARGS.map(escapeCmdArg),
			shell: true,
		});
	});

	it('changes nothing the second time', () => {
		const once = applyWindowsShellRules(spec(SHIM), { isWindowsHost: true });
		expect(applyWindowsShellRules(once, { isWindowsHost: true })).toEqual(once);
	});

	it('turns the shell on for a bare .exe name, which only a shell finds on PATH', () => {
		expect(applyWindowsShellRules(spec('codex.exe'), { isWindowsHost: true }).shell).toBe(true);
	});

	it('starts an .exe with a path directly', () => {
		const direct = spec('C:\\Program Files\\Codex\\codex.exe');
		expect(applyWindowsShellRules(direct, { isWindowsHost: true })).toBe(direct);
	});

	it('leaves a spec that already names its shell to its caller', () => {
		const chosen = spec(SHIM, {
			shell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
		});
		expect(applyWindowsShellRules(chosen, { isWindowsHost: true })).toBe(chosen);
	});

	it('changes nothing off Windows', () => {
		const shim = spec(SHIM);
		expect(applyWindowsShellRules(shim, { isWindowsHost: false })).toBe(shim);
	});

	it('is applied by turnProcessSpecFromPlan', () => {
		const plan: LocalLaunchPlan = {
			target: { kind: 'local' },
			command: SHIM,
			args: ARGS,
			cwd: 'C:\\project',
			prompt: { via: 'stdin', format: 'raw', args: [] },
			stdin: 'the prompt',
			env: {},
		};
		expect(turnProcessSpecFromPlan(plan, { isWindowsHost: true })).toEqual(
			applyWindowsShellRules(spec(SHIM), { isWindowsHost: true })
		);
	});

	// A real cmd.exe and a real npm-style shim: only the Windows CI leg has them.
	it.runIf(process.platform === 'win32')(
		'starts a .cmd shim under a path with spaces and delivers the prompt intact',
		async () => {
			const shimDir = path.join(scratch.dir, 'npm dir');
			fs.mkdirSync(shimDir, { recursive: true });
			fs.writeFileSync(
				path.join(shimDir, 'echo.mjs'),
				[
					"let stdin = '';",
					"process.stdin.setEncoding('utf8');",
					"process.stdin.on('data', (chunk) => (stdin += chunk));",
					"process.stdin.on('end', () => process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), stdin }) + '\\n'));",
				].join('\n')
			);
			const shimPath = path.join(shimDir, 'echo.cmd');
			// What npm writes, reduced to its essentials.
			fs.writeFileSync(shimPath, `@"${process.execPath}" "%~dp0\\echo.mjs" %*\r\n`);

			const prompt = 'say "hi" & echo 50% | more ^ done\nsecond line\r\nthird';
			const args = ['--flag', 'a b', 'x&y|z', 'say "hi"'];
			const handle = startTurn(
				applyWindowsShellRules({
					command: shimPath,
					args,
					cwd: scratch.dir,
					env: process.env,
					stdin: prompt,
				}),
				{},
				OPTIONS
			);
			const exit = await handle.done;

			expect(exit.spawnError).toBeUndefined();
			expect(exit.exitCode).toBe(0);
			expect(JSON.parse(exit.stdoutText.trim())).toEqual({ argv: args, stdin: prompt });
		}
	);
});

describe('managed admission at the spawn', () => {
	const HOLD_TURN: FakeTurn = {
		chunks: ['{"type":"text","text":"hi"}\n'],
		close: { code: 0, signal: null },
	};

	function authority(decision: 'allow' | 'deny' = 'allow') {
		let now = 0;
		let ids = 0;
		const auth = createLocalHostAuthority({
			authorityId: 'test-authority',
			decide: () =>
				decision === 'allow'
					? { decision: 'allow', policyRevision: 1 }
					: { decision: 'deny', reason: 'refused by the table', policyRevision: 1 },
			now: () => now,
			newId: () => `lease-${++ids}`,
			leaseTtlMs: 60_000,
		});
		return { auth, tick: (ms: number) => (now += ms) };
	}

	function context() {
		const verifier = createContextVerifier({
			verifierId: 'test',
			peer: 'in-process',
			now: () => 0,
			accept: () => [],
		});
		const verified = verifier.verify({
			contractVersion: MANAGED_CONTRACT_VERSION,
			installation: { installationId: 'i', runtimeId: 'r', processEpoch: 'e' },
			origin: 'cli',
			actor: { kind: 'service', id: 'fleet' },
			delegation: { chain: [], grantRef: null },
			identity: {
				requestId: 'q',
				idempotencyKey: 'k',
				attemptId: 'a',
				runId: 'run',
				rootRunId: 'run',
				parentRunId: null,
			},
			policyRevision: 1,
			workflow: null,
			traceId: 't',
			requestedCapabilities: ['runs.submit'],
		});
		if (!verified.ok) throw new Error(verified.problems.join());
		return verified.context;
	}

	const ATTRIBUTION = { provider: 'opencode' } as const;

	/** A lease admitted on `spec`, and the sink gate that re-checks it, as `runAgentTurn` builds them. */
	async function gateFor(auth: HostAuthority, spec: TurnProcessSpec) {
		const outcome = await auth.admit({
			context: context(),
			snapshot: buildDispatchSnapshot(spec, ATTRIBUTION),
			policy: { sources: [], policyRevision: 1 },
		});
		if (outcome.state !== 'admitted') throw new Error(`not admitted: ${outcome.state}`);
		const lease = outcome.lease;
		const seen: string[] = [];
		const gate: DispatchAdmission = {
			admit(snapshot) {
				const verdict = auth.check(lease, dispatchSnapshotDigest(snapshot));
				seen.push(verdict.ok ? 'admit:ok' : `admit:${verdict.reason}`);
				return verdict.ok
					? { ok: true }
					: { ok: false, state: 'denied', code: 'lease-invalid', message: verdict.reason };
			},
			bound: (pid) => {
				seen.push(`bound:${typeof pid}`);
				lease.bind(pid);
			},
			released: (exit) => {
				seen.push(`released:${exit.exitCode}:${exit.stoppedBy ?? 'none'}`);
				lease.release({ outcome: 'exited', exitCode: exit.exitCode, signal: exit.signal });
			},
			onRevoked: (listener) => lease.onRevoked(listener),
		};
		return { lease, gate, seen };
	}

	describe('observed descendant ownership', () => {
		const root = { pid: 4242, startedAt: 'original-root' };
		const tool = { pid: 5000, startedAt: 'original-tool' };
		let child: childProcess.ChildProcess;
		let tree: processTree.ProcessTreeSnapshot;
		let current: TurnHandle | undefined;
		let resolveRead: ((value: processTree.ProcessTreeSnapshot) => void) | undefined;

		beforeEach(() => {
			vi.useFakeTimers();
			current = undefined;
			resolveRead = undefined;
			tree = { owned: true, root, descendants: [tool] };
			child = Object.assign(new EventEmitter(), {
				pid: root.pid,
				exitCode: null,
				signalCode: null,
				kill: vi.fn(() => true),
				stdin: new PassThrough(),
				stdout: new PassThrough(),
				stderr: new PassThrough(),
			}) as unknown as childProcess.ChildProcess;
			vi.spyOn(childProcess, 'spawn').mockReturnValue(child);
			vi.spyOn(platform, 'isWindows').mockReturnValue(false);
			vi.spyOn(processTree, 'snapshotProcessTree').mockImplementation(() => tree);
			vi.spyOn(processTree, 'refreshProcessTree').mockImplementation(async (_pid, prior) => prior);
			vi.spyOn(processTree, 'killSurvivors').mockReturnValue(0);
			vi.spyOn(processTree, 'killProcessTreeNow').mockImplementation(() => {});
			// Defense in depth: no synthetic PID may reach the operating system.
			vi.spyOn(process, 'kill').mockReturnValue(true);
		});

		afterEach(async () => {
			resolveRead?.(tree);
			child.emit('close', 0, null);
			await current?.done;
			child.stdin?.destroy();
			child.stdout?.destroy();
			child.stderr?.destroy();
			vi.clearAllTimers();
			vi.useRealTimers();
			vi.restoreAllMocks();
		});

		async function observed(options: Partial<StartTurnOptions> = {}, handlers: TurnHandlers = {}) {
			const spec = { command: process.execPath, args: [], cwd: scratch.dir, env: {} };
			const { lease, gate, seen } = await gateFor(authority().auth, spec);
			const release = vi.spyOn(lease, 'release');
			const unsubscribe = vi.fn();
			const onRevoked = gate.onRevoked!;
			gate.onRevoked = (listener) => {
				const off = onRevoked(listener);
				return () => {
					unsubscribe();
					off();
				};
			};
			current = startTurn(spec, handlers, {
				...OPTIONS,
				trackDescendants: true,
				...options,
				admission: { gate, attribution: ATTRIBUTION },
			});
			return { turn: current, lease, release, seen, unsubscribe };
		}

		it.each(['timeout', 'cancellation'] as const)(
			'joins a late observation after parent exit and %s before releasing the lease',
			async (reason) => {
				const controller = new AbortController();
				const removeAbort = vi.spyOn(controller.signal, 'removeEventListener');
				const { turn, lease, release, unsubscribe } = await observed({ signal: controller.signal });
				const finish = trackProcessTree(child);
				expect(trackProcessTree(child)).toBe(finish);
				expect(vi.getTimerCount()).toBe(1);
				vi.mocked(processTree.refreshProcessTree).mockImplementationOnce(
					() =>
						new Promise((resolve) => {
							resolveRead = resolve;
						})
				);
				await vi.advanceTimersByTimeAsync(TREE_REFRESH_MS * 3);
				expect(processTree.refreshProcessTree).toHaveBeenCalledTimes(1);
				const synchronousTool = { pid: 5001, startedAt: 'sync-tool' };
				const lateTool = { pid: 5002, startedAt: 'late-tool' };
				tree = { ...tree, descendants: [tool, synchronousTool] };
				Object.assign(child, { exitCode: 0 });
				child.emit('exit', 0, null);
				expect(release).not.toHaveBeenCalled();
				if (reason === 'timeout') {
					setTimeout(() => turn.terminate(), 100);
					await vi.advanceTimersByTimeAsync(100);
				} else controller.abort();
				expect(processTree.killSurvivors).toHaveBeenLastCalledWith(
					[tool, synchronousTool],
					expect.any(Object)
				);
				expect(child.kill).not.toHaveBeenCalled();
				child.emit('close', 0, null);
				expect(vi.getTimerCount()).toBe(0);
				expect(lease.state()).toBe('bound');
				expect(release).not.toHaveBeenCalled();
				resolveRead!({ owned: true, root, descendants: [tool, lateTool] });
				const exit = await turn.done;
				expect(processTree.killSurvivors).toHaveBeenLastCalledWith(
					[tool, synchronousTool, lateTool],
					expect.any(Object)
				);
				expect(exit).toMatchObject({ exitCode: 0, interrupted: true, stoppedBy: 'caller' });
				expect(lease.state()).toBe('released');
				expect(release).toHaveBeenCalledTimes(1);
				expect(unsubscribe).toHaveBeenCalledTimes(1);
				expect(removeAbort).toHaveBeenCalledWith('abort', expect.any(Function));
				expect(child.listenerCount('exit')).toBe(0);
				const sweeps = vi.mocked(processTree.killSurvivors).mock.calls.length;
				turn.terminateNow();
				controller.abort();
				child.emit('close', 0, null);
				expect(processTree.killSurvivors).toHaveBeenCalledTimes(sweeps);
				expect(release).toHaveBeenCalledTimes(1);
				expect(process.kill).not.toHaveBeenCalled();
			}
		);

		it('drains trailing stdout and stderr after exit, then joins a normal pending read without stopping', async () => {
			const { lines, handlers } = recorder();
			const { turn, release } = await observed({}, handlers);
			vi.mocked(processTree.refreshProcessTree).mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						resolveRead = resolve;
					})
			);
			await vi.advanceTimersByTimeAsync(TREE_REFRESH_MS);
			child.stdout!.emit('data', 'first\nlast');
			Object.assign(child, { exitCode: 0 });
			child.emit('exit', 0, null);
			child.stdout!.emit('data', ' line');
			child.stderr!.emit('data', 'trailing warning');
			expect(release).not.toHaveBeenCalled();
			child.emit('close', 0, null);
			expect(lines).toEqual(['first', 'last line']);
			expect(release).not.toHaveBeenCalled();
			resolveRead!(tree);
			expect(await turn.done).toMatchObject({
				stdoutText: 'first\nlast line',
				stderrText: 'trailing warning',
				interrupted: false,
			});
			expect(release).toHaveBeenCalledTimes(1);
			expect(processTree.killSurvivors).not.toHaveBeenCalled();
			expect(vi.getTimerCount()).toBe(0);
		});

		it('retains ownership after a post-spawn signal error and cleans up a failed table read', async () => {
			const { turn, lease, release } = await observed();
			vi.mocked(processTree.refreshProcessTree).mockRejectedValueOnce(
				new Error('table unavailable')
			);
			await vi.advanceTimersByTimeAsync(TREE_REFRESH_MS);
			child.emit('error', Object.assign(new Error('signal denied'), { code: 'EPERM' }));
			expect(child.kill).toHaveBeenCalledWith('SIGTERM');
			expect(lease.state()).toBe('bound');
			expect(release).not.toHaveBeenCalled();
			expect(child.listenerCount('exit')).toBe(1);
			expect(vi.getTimerCount()).toBe(2); // one tracker and one escalation
			Object.assign(child, { signalCode: 'SIGTERM' });
			child.emit('exit', null, 'SIGTERM');
			child.emit('close', null, 'SIGTERM');
			expect(await turn.done).toMatchObject({ signal: 'SIGTERM', interrupted: true });
			expect((await turn.done).spawnError).toBeUndefined();
			expect(release).toHaveBeenCalledTimes(1);
			expect(child.listenerCount('exit')).toBe(0);
			expect(vi.getTimerCount()).toBe(0);
		});

		it('releases a failed spawn once without starting observation', async () => {
			Object.assign(child, { pid: undefined });
			const { turn, release } = await observed();
			const error = Object.assign(new Error('missing executable'), { code: 'ENOENT' });
			child.emit('error', error);
			child.emit('close', -2, null);
			expect((await turn.done).spawnError).toBe(error);
			expect(release).toHaveBeenCalledTimes(1);
			expect(processTree.snapshotProcessTree).not.toHaveBeenCalled();
			expect(vi.getTimerCount()).toBe(0);
		});

		it.each([undefined, false])(
			'preserves untracked spawn and stop behavior with trackDescendants=%s',
			async (trackDescendants) => {
				const { turn } = await observed({ trackDescendants });
				expect(childProcess.spawn).toHaveBeenCalledWith(process.execPath, [], {
					cwd: scratch.dir,
					env: {},
					shell: false,
					stdio: ['pipe', 'pipe', 'pipe'],
				});
				expect(processTree.snapshotProcessTree).not.toHaveBeenCalled();
				expect(vi.getTimerCount()).toBe(0);
				turn.terminateNow();
				expect(processTree.killProcessTreeNow).toHaveBeenCalledWith(root.pid, expect.any(Object));
				child.emit('close', null, 'SIGKILL');
				await turn.done;
				expect(vi.getTimerCount()).toBe(0);
			}
		);
	});

	it('admits a harmless launch: the lease is checked at the spawn, bound to the pid, released on exit', async () => {
		const { auth } = authority();
		const argvOut = path.join(scratch.dir, 'managed-argv.json');
		const spec = fakeAgentSpec(scratch.dir, OPENCODE_TURN, { argvOut, args: ['--managed'] });
		const { lease, gate, seen } = await gateFor(auth, spec);

		const turn = startTurn(
			spec,
			{},
			{ ...OPTIONS, agentId: 'opencode', admission: { gate, attribution: ATTRIBUTION } }
		);
		expect(lease.state()).toBe('bound');
		expect(lease.pid()).toBe(turn.pid);
		const exit = await turn.done;

		expect(exit.exitCode).toBe(0);
		expect(exit.stoppedBy).toBeUndefined();
		expect(seen).toEqual(['admit:ok', 'bound:number', 'released:0:none']);
		expect(lease.state()).toBe('released');
		expect(JSON.parse(fs.readFileSync(argvOut, 'utf-8'))).toEqual(['--managed']);
	});

	it('refuses a denied launch before any effect: no process, no stdin, no file touched', async () => {
		const { auth } = authority('deny');
		const argvOut = path.join(scratch.dir, 'denied-argv.json');
		const spec = fakeAgentSpec(scratch.dir, OPENCODE_TURN, { argvOut, stdin: 'never read' });
		const outcome = await auth.admit({
			context: context(),
			snapshot: buildDispatchSnapshot(spec, ATTRIBUTION),
			policy: { sources: [], policyRevision: 1 },
		});
		expect(outcome).toMatchObject({
			state: 'denied',
			code: 'policy-denied',
			message: 'refused by the table',
		});

		// Nothing admitted means nothing to hand the sink; a gate that says no is refused the same way.
		const gate: DispatchAdmission = {
			admit: () => ({
				ok: false,
				state: 'denied',
				code: 'policy-denied',
				message: 'refused by the table',
			}),
			bound: () => {
				throw new Error('must not bind');
			},
		};
		let started = false;
		expect(() =>
			startTurn(
				spec,
				{ onStarted: () => (started = true) },
				{ ...OPTIONS, admission: { gate, attribution: ATTRIBUTION } }
			)
		).toThrow(DispatchRefusedError);
		try {
			startTurn(spec, {}, { ...OPTIONS, admission: { gate, attribution: ATTRIBUTION } });
		} catch (error) {
			expect(error).toMatchObject({ state: 'denied', code: 'policy-denied' });
		}
		expect(started).toBe(false);
		expect(fs.existsSync(argvOut)).toBe(false);
		expect(auth.live()).toEqual([]);
	});

	it('refuses a changed plan: a lease admitted on one spec does not start another', async () => {
		const { auth } = authority();
		const admittedSpec = fakeAgentSpec(scratch.dir, OPENCODE_TURN, { args: ['--admitted'] });
		const { gate, seen, lease } = await gateFor(auth, admittedSpec);
		const argvOut = path.join(scratch.dir, 'replaced-argv.json');
		const replaced = {
			...admittedSpec,
			args: [...admittedSpec.args.slice(0, 1), '--replaced'],
			env: { ...admittedSpec.env, FAKE_AGENT_ARGV_OUT: argvOut },
		};

		expect(() =>
			startTurn(replaced, {}, { ...OPTIONS, admission: { gate, attribution: ATTRIBUTION } })
		).toThrow(/snapshot-mismatch/);
		expect(seen).toEqual(['admit:snapshot-mismatch']);
		expect(fs.existsSync(argvOut)).toBe(false);
		expect(lease.state()).toBe('issued');
		// Different attribution over the same spec is a different snapshot too.
		expect(() =>
			startTurn(
				admittedSpec,
				{},
				{ ...OPTIONS, admission: { gate, attribution: { provider: 'claude-code' } } }
			)
		).toThrow(/snapshot-mismatch/);
		// The admitted spec itself still starts.
		const turn = startTurn(
			admittedSpec,
			{},
			{ ...OPTIONS, admission: { gate, attribution: ATTRIBUTION } }
		);
		expect((await turn.done).exitCode).toBe(0);
	});

	it('refuses a stale, forged or already-used lease at the spawn', async () => {
		const { auth, tick } = authority();
		const spec = fakeAgentSpec(scratch.dir, OPENCODE_TURN);
		const expired = await gateFor(auth, spec);
		tick(60_001);
		expect(() =>
			startTurn(
				spec,
				{},
				{ ...OPTIONS, admission: { gate: expired.gate, attribution: ATTRIBUTION } }
			)
		).toThrow(/expired/);

		const { lease } = await gateFor(auth, spec);
		const forged = { ...lease } as DispatchLease;
		const forgedGate: DispatchAdmission = {
			admit: (snapshot) => {
				const verdict = auth.check(forged, dispatchSnapshotDigest(snapshot));
				return verdict.ok
					? { ok: true }
					: { ok: false, state: 'denied', code: 'lease-invalid', message: verdict.reason };
			},
		};
		expect(() =>
			startTurn(spec, {}, { ...OPTIONS, admission: { gate: forgedGate, attribution: ATTRIBUTION } })
		).toThrow(/forged/);

		const used = await gateFor(auth, spec);
		const first = startTurn(
			spec,
			{},
			{ ...OPTIONS, admission: { gate: used.gate, attribution: ATTRIBUTION } }
		);
		expect(() =>
			startTurn(spec, {}, { ...OPTIONS, admission: { gate: used.gate, attribution: ATTRIBUTION } })
		).toThrow(/already-bound/);
		await first.done;
		expect(() =>
			startTurn(spec, {}, { ...OPTIONS, admission: { gate: used.gate, attribution: ATTRIBUTION } })
		).toThrow(/released/);
	});

	it('stops the process when the lease is revoked mid-run, and the authority owns that stop', async () => {
		const { auth } = authority();
		const spec = fakeAgentSpec(scratch.dir, HOLD_TURN, { hold: true });
		const { lease, gate, seen } = await gateFor(auth, spec);
		const turn = startTurn(
			spec,
			{},
			{ ...OPTIONS, agentId: 'opencode', admission: { gate, attribution: ATTRIBUTION } }
		);
		expect(lease.state()).toBe('bound');

		expect(auth.revoke(lease.leaseId, 'policy revision 2 forbids it')).toBe(true);
		const exit = await turn.done;

		expect(exit.interrupted).toBe(true);
		expect(exit.stoppedBy).toBe('authority');
		expect(turn.stopRequested()).toBe(true);
		expect(lease.ended()).toMatchObject({
			state: 'revoked',
			reason: 'policy revision 2 forbids it',
		});
		expect(seen[seen.length - 1]).toMatch(/^released:.*:authority$/);
	});

	it('records a caller stop as the caller, not the authority', async () => {
		const { auth } = authority();
		const spec = fakeAgentSpec(scratch.dir, HOLD_TURN, { hold: true });
		const { gate } = await gateFor(auth, spec);
		const turn = startTurn(spec, {}, { ...OPTIONS, admission: { gate, attribution: ATTRIBUTION } });
		turn.terminate();
		const exit = await turn.done;
		expect(exit.interrupted).toBe(true);
		expect(exit.stoppedBy).toBe('caller');
	});

	it('runs unmanaged when no admission is given, exactly as before', async () => {
		const turn = startTurn(fakeAgentSpec(scratch.dir, OPENCODE_TURN), {}, OPTIONS);
		const exit = await turn.done;
		expect(exit.exitCode).toBe(0);
		expect(exit.stoppedBy).toBeUndefined();
	});
});
