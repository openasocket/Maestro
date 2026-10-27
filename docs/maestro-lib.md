---
title: maestro-lib (Library)
description: Plan, run, stream, resume and stop an AI coding agent turn from your own Node program, without the desktop app or the CLI.
icon: book
---

maestro-lib is the part of Maestro that starts a coding agent (Claude Code, Codex, OpenCode and others), sends it a prompt, reads its reply as it streams, stops it, and reports how the turn ended. The desktop app, `maestro-cli` and Cue all run their agents through it. You can use it from your own Node program through one entry module.

For a worked example, see the [terminal example](https://github.com/RunMaestro/Maestro/tree/main/examples/maestro-lib-tui): a small interactive program that starts, streams, resumes and stops turns with nothing but this entry.

## What it is, and what it is not

It is:

- **Plain Node.** Nothing it loads needs Electron or the desktop app. It runs on Node 20 or later, on a laptop, a server or in CI.
- **One turn at a time.** A turn is one prompt sent to one agent process. The agent keeps the conversation; to continue it, you pass the session id the last turn returned.
- **Local.** It starts the agent on the machine your program runs on, in the folder you give it.

It is not:

- **Not the desktop app or the CLI.** There are no agents in a Left Bar, no tabs, no Auto Run, no playbooks, no Cue pipelines and no stored history. Your program keeps whatever state it needs.
- **Not an agent.** It runs agent CLIs you have installed and logged in to. It does not call a model API itself.
- **Not remote.** SSH remotes belong to the desktop app and the CLI, which store them. The library can qualify a remote for a managed launch (see [Managed operations](#managed-operations)), but it never opens an SSH connection of its own.
- **Not a provider installer.** If the provider's binary is not on this machine, planning the turn fails with `not-installed`.

## Providers

`planSessionTurn` checks every request before anything starts, and refuses what could not run correctly:

| Reason          | When                                                                                                                                                                                                                                                                  |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unknown-agent` | The agent id is not one Maestro knows.                                                                                                                                                                                                                                |
| `no-batch-mode` | The provider cannot run a single turn without a terminal.                                                                                                                                                                                                             |
| `no-parser`     | Maestro has no parser for the provider's output, so the answer could not be read. The turn is refused rather than run blind.                                                                                                                                          |
| `no-resume`     | You asked to resume, and the provider cannot resume a session.                                                                                                                                                                                                        |
| `no-read-only`  | You asked for a read-only turn, and the provider's command line cannot enforce one. A program with nobody watching gets read-only or a refusal, never a turn that only looks read-only.                                                                               |
| `not-installed` | The provider's binary was not found on `PATH`, in its known install locations, or at the `command` you gave.                                                                                                                                                          |
| `windows-shell` | On Windows, the provider is installed as a `.cmd` shim that only starts through cmd.exe, and an argument cannot pass through cmd.exe intact (a prompt with a line break, `%` or `^`, for a provider that cannot read its prompt from stdin). See [Windows](#windows). |
| `launch`        | The launch could not be planned. The message says why.                                                                                                                                                                                                                |

What each provider supports in maestro-lib `0.31.0`:

| Agent id        | Name            | Runs a turn | Resume | Read-only |
| --------------- | --------------- | ----------- | ------ | --------- |
| `claude-code`   | Claude Code     | yes         | yes    | yes       |
| `codex`         | Codex           | yes         | yes    | yes       |
| `opencode`      | OpenCode        | yes         | yes    | yes       |
| `factory-droid` | Factory Droid   | yes         | yes    | yes       |
| `copilot-cli`   | Copilot-CLI     | yes         | yes    | yes       |
| `qwen3-coder`   | Qwen3 Coder     | yes         | yes    | yes       |
| `pi`            | Pi              | yes         | yes    | yes       |
| `omp`           | Oh My Pi        | yes         | yes    | yes       |
| `grok`          | Grok CLI        | yes         | yes    | yes       |
| `antigravity`   | Antigravity CLI | yes         | yes    | no        |
| `hermes`        | Hermes          | no          | no     | no        |

Hermes is refused with `no-parser`. To list providers at run time, use `getVisibleAgentDefinitions()` and `getAgentCapabilities(id)`.

## Install

maestro-lib is built from the Maestro repository. It is not published to a package registry.

```bash
git clone https://github.com/RunMaestro/Maestro.git
cd Maestro
npm ci
npm run build:maestro-lib
```

The build writes `dist/maestro-lib/`:

| File              | What it is                                                                                                                                                                    |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.js`        | The library, one CommonJS file for Node 20. Both `require` and `import` load it.                                                                                              |
| `index.d.ts`      | Type declarations for everything the entry exports (the files they refer to are under `types/`).                                                                              |
| `package.json`    | Name `maestro-lib`, the library version, `maestroAppVersion` (the Maestro version it was built from) and `maestroManagedContract` (the managed-operation contract it speaks). |
| `provenance.json` | The sha256 of every other file in the folder, the git revision the build was cut from, whether that source was dirty, and the Node that built it.                             |
| `README.md`       | This page.                                                                                                                                                                    |

Add it to your program as a local dependency:

```json
{
	"dependencies": {
		"maestro-lib": "file:../Maestro/dist/maestro-lib"
	}
}
```

The bundle has no runtime dependencies. For types, your program needs `@types/node`. The declarations also name `node-pty`, for stopping a PTY you started yourself; it is an optional peer, and with `skipLibCheck` (the TypeScript default for most setups) you do not need it.

## Version

The library has its own version, separate from the Maestro app's version. The app can ship many releases with no change to the library.

- `MAESTRO_LIB_VERSION`, exported from the entry, and `version` in the built `package.json` hold the same value.
- It follows semver over what the entry exports. Below `1.0.0`, a minor release may change the surface.
- `MAESTRO_LIB_VERSION_INFO` names every version a consumer may pin, each independent of the others: `library` (the same value), `managedContract` (the managed-operation contract, see below) and `node` (the Node range). The app version is deliberately not in it: the build stamps it as `maestroAppVersion`, and the plugin SDK, plugin host API and any enterprise protocol are versioned by their own packages. None of these implies another.
- To pin it, build from a Maestro commit or tag, keep that `dist/maestro-lib/` folder with its `provenance.json`, and check the versions at startup:

```ts
import {
	MAESTRO_LIB_VERSION,
	MAESTRO_LIB_VERSION_INFO,
	MANAGED_CONTRACT_VERSION,
} from 'maestro-lib';

const SUPPORTED = '0.24.';

if (!MAESTRO_LIB_VERSION.startsWith(SUPPORTED)) {
	throw new Error(`This tool needs maestro-lib ${SUPPORTED}x, found ${MAESTRO_LIB_VERSION}`);
}
if (MAESTRO_LIB_VERSION_INFO.managedContract !== MANAGED_CONTRACT_VERSION) {
	throw new Error(`Unexpected managed contract ${MAESTRO_LIB_VERSION_INFO.managedContract}`);
}
```

Import from `maestro-lib` only. The files under `types/` mirror the library's internal modules; they are there for the declarations, and their paths can change in any release.

## Run a first turn

`planSessionTurn` turns an agent id, a folder and a prompt into a process spec. `runToCompletion` starts it and resolves once the agent has exited.

```ts
import { BACKGROUND_STOP_GRACE_MS, planSessionTurn, runToCompletion } from 'maestro-lib';

export async function askOnce(cwd: string, prompt: string): Promise<string | undefined> {
	const planned = await planSessionTurn({ agentId: 'claude-code', cwd, prompt });
	if (!planned.ok) {
		throw new Error(`${planned.reason}: ${planned.error}`);
	}

	const turn = await runToCompletion(planned.spec, {
		agentId: 'claude-code',
		sessionId: 'my-tool',
		stopGraceMs: BACKGROUND_STOP_GRACE_MS,
	});
	return turn.answerText;
}
```

The request (`SessionTurnRequest`) takes:

| Field             | Meaning                                                                                                        |
| ----------------- | -------------------------------------------------------------------------------------------------------------- |
| `agentId`         | The provider, for example `claude-code`.                                                                       |
| `cwd`             | The folder the agent works in. It must exist; a missing folder ends the turn as `crashed`.                     |
| `prompt`          | What to send.                                                                                                  |
| `resumeSessionId` | The session to continue. See [Resume a session](#resume-a-session).                                            |
| `model`           | A model id the provider accepts.                                                                               |
| `readOnly`        | The agent may read but not change anything. Refused for a provider that cannot enforce it.                     |
| `command`         | The provider's binary, when it is not on `PATH` or in its usual install location.                              |
| `envVars`         | Environment variables for this turn. They are set over your program's environment and the provider's defaults. |
| `querySource`     | `'user'`, `'auto'` or `'cue'`: who asked for the turn. It is passed to the agent as `MAESTRO_QUERY_SOURCE`.    |

The run options (`RunTurnOptions`) need three fields. `agentId` is the same provider. `sessionId` is a label for your program, used in log lines; it is not the provider's session id, and a fixed name such as `'my-tool'` is fine. `stopGraceMs` is how long each stop stage waits before the next one: `INTERACTIVE_STOP_GRACE_MS` (2 seconds) for a turn someone is watching, `BACKGROUND_STOP_GRACE_MS` (5 seconds) for an unattended one.

The agent's environment is your program's environment, then the provider's defaults for any variable your environment leaves unset, then `envVars`. This is the order `maestro-cli` uses.

## Stream the reply

`runTurn` returns at once with a handle and a promise. The handlers are called while the agent runs. Each line the provider's parser understands arrives in `onEvent` as a `ParsedEvent`.

```ts
import { INTERACTIVE_STOP_GRACE_MS, planSessionTurn, runTurn, type ParsedEvent } from 'maestro-lib';

function show(event: ParsedEvent): void {
	switch (event.type) {
		case 'init':
			if (event.sessionId) console.log(`[session ${event.sessionId}]`);
			break;
		case 'text':
			if (!event.isReasoning && event.text) process.stdout.write(event.text);
			break;
		case 'tool_use':
			console.log(`\n[tool ${event.toolName ?? 'unknown'}]`);
			break;
		case 'usage':
			if (event.usage) console.log(`\n[${event.usage.outputTokens} tokens out]`);
			break;
		case 'error':
			console.error(`\n[error] ${event.text ?? ''}`);
			break;
		default:
			break;
	}
}

export async function streamTurn(cwd: string, prompt: string): Promise<void> {
	const planned = await planSessionTurn({ agentId: 'opencode', cwd, prompt });
	if (!planned.ok) throw new Error(planned.error);

	const { completed } = runTurn(
		planned.spec,
		{ agentId: 'opencode', sessionId: 'my-tool', stopGraceMs: INTERACTIVE_STOP_GRACE_MS },
		{
			onStarted: (pid) => console.log(`[started, pid ${pid ?? 'unknown'}]`),
			onEvent: (event) => show(event),
		}
	);
	await completed;
}
```

The event types:

| `type`     | Carries                                                                                                                      |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `init`     | `sessionId` when the provider announces it at the start.                                                                     |
| `text`     | `text`. `isPartial` marks a fragment of a longer message; `isReasoning` marks the agent's thinking, which is not the answer. |
| `tool_use` | `toolName`, `toolCallId`, and `toolState`, whose shape is the provider's own.                                                |
| `usage`    | `usage`: `inputTokens`, `outputTokens`, and for some providers cache tokens, `costUsd` and `contextWindow`.                  |
| `result`   | The provider's final message. `text` is the answer when the provider sends one.                                              |
| `error`    | `text`, an error the provider reported in its stream.                                                                        |
| `system`   | A provider message that is not part of the conversation.                                                                     |

Providers differ in which events they send and how they split text. Show events as they arrive, and use `CompletedTurn.answerText` for the final answer: it is the result text when the provider sent one, and otherwise the text streamed during the turn.

The other handlers are `onStdout` and `onStderr` (raw chunks), `onLine` (each stdout line before parsing), `onOversizedLine` (output dropped because a line grew past the limit) and `onStdinError` (the prompt could not be written to the agent). Every handler for a chunk returns before the next chunk is read, and all of them return before `completed` resolves.

## Resume a session

The provider keeps the conversation. A finished turn returns its `sessionId`; pass it as `resumeSessionId` to send the next message in the same conversation. `planned.resuming` is `true` when the plan resumes one.

```ts
import {
	BACKGROUND_STOP_GRACE_MS,
	planSessionTurn,
	runToCompletion,
	type CompletedTurn,
} from 'maestro-lib';

async function send(cwd: string, prompt: string, resumeSessionId?: string): Promise<CompletedTurn> {
	const planned = await planSessionTurn({ agentId: 'claude-code', cwd, prompt, resumeSessionId });
	if (!planned.ok) throw new Error(planned.error);
	return runToCompletion(planned.spec, {
		agentId: 'claude-code',
		sessionId: 'my-tool',
		stopGraceMs: BACKGROUND_STOP_GRACE_MS,
	});
}

export async function conversation(cwd: string): Promise<void> {
	const first = await send(cwd, 'Name one prime number.');
	if (!first.sessionId) throw new Error('The provider did not report a session id');

	const second = await send(cwd, 'Now name the next one.', first.sessionId);
	console.log(second.answerText);
}
```

Store the session id if your program should continue the conversation after a restart. Each provider keeps its sessions in its own files, so the id only works on the machine (and for the account) that created it.

## Stop a turn

A running turn is stopped through its `TurnHandle`:

| Method                        | What it does                                                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `interrupt()`                 | Stops the way a user does: an interrupt first, so the agent can end its turn, then terminate, then kill, each after `stopGraceMs`.   |
| `terminate()`                 | Skips the interrupt: terminate, then kill. For a timeout or a cancelled job.                                                         |
| `terminateNow({ blocking? })` | Runs every stage at once with no grace period, for a program that is about to exit. `blocking` also waits for `taskkill` on Windows. |
| `stopRequested()`             | Whether a stop has been asked for.                                                                                                   |

A stop also ends the processes the agent started during the turn (a shell command a tool was running, for example), once the agent has exited. A turn you stopped resolves with outcome `interrupted`, whatever the process's exit code says.

```ts
import {
	INTERACTIVE_STOP_GRACE_MS,
	planSessionTurn,
	runTurn,
	type CompletedTurn,
} from 'maestro-lib';

export async function runWithStop(
	cwd: string,
	prompt: string,
	timeoutMs: number
): Promise<CompletedTurn> {
	const planned = await planSessionTurn({ agentId: 'codex', cwd, prompt });
	if (!planned.ok) throw new Error(planned.error);

	const { handle, completed } = runTurn(planned.spec, {
		agentId: 'codex',
		sessionId: 'my-tool',
		stopGraceMs: INTERACTIVE_STOP_GRACE_MS,
	});

	// Ctrl+C stops the turn the way a user would; a second Ctrl+C ends it at once.
	const onSigint = (): void => {
		if (handle.stopRequested()) handle.terminateNow({ blocking: true });
		else handle.interrupt();
	};
	process.on('SIGINT', onSigint);

	// A turn that runs too long is terminated without the interrupt stage.
	const timer = setTimeout(() => handle.terminate(), timeoutMs);

	try {
		return await completed;
	} finally {
		clearTimeout(timer);
		process.off('SIGINT', onSigint);
	}
}
```

You can also pass an `AbortSignal` as `signal` in the run options. Aborting it stops the turn from `terminate`.

## Read the outcome

`completed` resolves with a `CompletedTurn`:

| Field        | Meaning                                                                                                     |
| ------------ | ----------------------------------------------------------------------------------------------------------- |
| `outcome`    | `completed`, `completed-with-warning`, `interrupted` or `crashed`.                                          |
| `answerText` | The answer, or `undefined` when there was none.                                                             |
| `sessionId`  | The provider's session id, for the next turn's `resumeSessionId`.                                           |
| `usage`      | Token and cost totals for this turn (`UsageStats`), when the provider reported them.                        |
| `error`      | An `AgentError` when the turn crashed on a failure the library could classify.                              |
| `exit`       | `TurnExit`: `exitCode`, `signal`, `interrupted`, a tail of `stderrText` and `stdoutText`, and `spawnError`. |

The outcomes:

- `completed`: the agent finished its turn.
- `completed-with-warning`: there is an answer, but the agent exited with an error code or never sent its final result message. Show the answer, and flag it.
- `interrupted`: you stopped it.
- `crashed`: the agent failed. `error.type` names the cause when it is known, for example `auth_expired`, `rate_limited`, `token_exhaustion`, `network_error` or `agent_crashed` (the full list is the `AgentErrorType` type), and `error.message` describes it. A crash with no `error` (killed by a signal you did not send, for example) is described by `exit`.

```ts
import type { CompletedTurn } from 'maestro-lib';

export function describeTurn(turn: CompletedTurn): string {
	switch (turn.outcome) {
		case 'completed':
			return turn.answerText ?? '(no answer)';
		case 'completed-with-warning':
			return `${turn.answerText ?? ''}\n(warning: the agent exited with code ${turn.exit.exitCode})`;
		case 'interrupted':
			return '(stopped)';
		case 'crashed': {
			if (turn.exit.spawnError) return `Could not start the agent: ${turn.exit.spawnError.message}`;
			if (turn.error) return `${turn.error.type}: ${turn.error.message}`;
			const how = turn.exit.signal ? `signal ${turn.exit.signal}` : `code ${turn.exit.exitCode}`;
			return `The agent exited with ${how}: ${turn.exit.stderrText.trim()}`;
		}
	}
}
```

## Host hooks

The library sends log lines and error reports to whatever your program registers. All hooks are optional; without them, log lines and reports are dropped.

```ts
import { setMaestroLibErrorReporter, setMaestroLibLogger } from 'maestro-lib';

const debug = process.env.MY_TOOL_DEBUG === '1';

setMaestroLibLogger({
	debug: (message, context) => {
		if (debug) console.error(`[debug] ${context ?? ''} ${message}`);
	},
	info: (message, context) => console.error(`[info] ${context ?? ''} ${message}`),
	warn: (message, context) => console.error(`[warn] ${context ?? ''} ${message}`),
	error: (message, context, data) =>
		console.error(`[error] ${context ?? ''} ${message}`, data ?? ''),
});

setMaestroLibErrorReporter({
	captureException: (error, extra) => console.error('[report]', error, extra ?? ''),
	captureMessage: (message, level, extra) =>
		console.error(`[report ${level ?? 'error'}]`, message, extra ?? ''),
});
```

Log lines go to the logger you register at the time of the call, so register hooks once at startup. Keep the library's output on stderr if your program prints results on stdout.

Two more hooks exist for hosts that have the data: `setMaestroLibImageRefResolver` resolves Maestro's `maestro-image://` image references (without it, such a reference is treated as unreadable), and `setMaestroLibCapabilitySnapshotLookup` supplies live per-agent capability data (without it, context windows fall back to built-in defaults). A program that is not Maestro does not need either.

## Windows

npm installs most agent CLIs on Windows as `.cmd` shims (`claude.cmd`, `codex.cmd`), and Node cannot start a `.cmd` file without a shell. `planSessionTurn` handles this the same way the Maestro desktop app does:

- If the binary is a `.cmd` or `.bat` shim, a bare `.exe` name, or a shebang script, the spec has `shell: true`. Every argument is escaped for cmd.exe, and a command path with spaces is quoted. A plain `.exe` with a path starts directly, with no shell.
- The prompt goes over stdin for every provider that can read it there, so quotes, `%`, `&`, `|`, `^` and line breaks reach the agent as typed. This also avoids cmd.exe's limit of about 8 KB per command line.
- A provider that only takes its prompt on the command line keeps it there. If an argument contains a line break, `%` or `^`, cmd.exe cannot pass it intact, so the turn is refused with `windows-shell` instead of running with a changed prompt.

On other hosts the spec is unchanged.

If you build a spec yourself, pass it through `applyWindowsShellRules(spec)` to apply the same rules. It returns the spec unchanged on other hosts, for a command that can start directly, and for a spec that already sets `shell`, so applying it twice is safe. `turnProcessSpecFromPlan` already applies it. Put the prompt in `spec.stdin` when the provider reads its prompt from stdin, and check other arguments with `cmdShellArgProblem(arg)`, which returns the reason cmd.exe cannot carry an argument, or `null` if it can.

## Lower-level pieces

`planSessionTurn` and `runTurn` cover a program that runs turns. The entry also exports the steps they are made of, for a program that needs more control:

- **Plan:** `buildAgentArgs` (the provider's arguments, resume included), `buildAgentLaunchPlan` (environment and prompt delivery), `turnProcessSpecFromPlan` (which applies `applyWindowsShellRules`, see [Windows](#windows)), and `checkBinaryExists` / `checkCustomPath` to find a provider's binary.
- **Run:** `startTurn` starts and streams a turn and reports how the process ended, without deciding whether it succeeded. `TurnCapture` folds its events into an answer, session id and usage, and `resolveTurnOutcome` decides the outcome. `runTurn` is these three together.
- **Stop:** `stopProcess` runs the same stop stages on a process you started yourself; `snapshotProcessTree` and `killProcessTreeNow` record and end what it started.
- **Parsers:** `createOutputParser(agentId)` returns a new parser for one stream. `initializeOutputParsers()`, then `getOutputParser(agentId)`, gives a shared instance for read-only checks.

```ts
import {
	BACKGROUND_STOP_GRACE_MS,
	createOutputParser,
	resolveTurnOutcome,
	startTurn,
	TurnCapture,
	type TurnOutcome,
	type TurnProcessSpec,
} from 'maestro-lib';

export async function runByHand(spec: TurnProcessSpec, agentId: string): Promise<TurnOutcome> {
	const parser = createOutputParser(agentId);
	if (!parser) throw new Error(`No parser for ${agentId}`);

	const capture = new TurnCapture(agentId, parser);
	const handle = startTurn(
		spec,
		{ onEvent: (event) => capture.handleEvent(event) },
		{ parser, stopGraceMs: BACKGROUND_STOP_GRACE_MS }
	);
	const exit = await handle.done;

	const { outcome } = resolveTurnOutcome(
		{
			exitCode: exit.exitCode,
			signal: exit.signal,
			interrupted: exit.interrupted,
			stderrText: exit.stderrText,
			stdoutText: exit.stdoutText,
			explicitError: capture.inBandError,
			stdinError: exit.stdinError,
			capturedAnswerText: capture.answerText,
			resultMessageSeen: capture.resultMessageSeen,
		},
		parser,
		{ providerId: agentId, sessionId: 'my-tool' }
	);
	return outcome;
}
```

## The headless runtime

Since `0.3.0` the entry also exports what lets Maestro run with no desktop. This page does not cover these yet; each line points at where they are described.

- **Paths:** `resolveMaestroPaths` and the data directory resolvers, plus the doctor that reports on a data directory (`paths/`).
- **Locks:** the cross-process lock primitive (`createProcessLock`) and the data-dir lock that makes one process the only writer of a data directory (`acquireDataDirLock`). See `Plans/maestro-tui-runtime.md`, sections 3 and 4.
- **Runtime and in-process client:** `createMaestroRuntime()`, the in-process `MaestroClient` that owns writes to a data directory, and the server `maestro-cli host` runs it in. See [Headless Host](./cli#headless-host-maestro-cli-host).
- **Store readers:** read-only readers of the agent, group, settings and history stores, without electron-store.
- **Auto Run:** the playbook and goal engines the CLI and the runtime share. See `Plans/maestro-tui-autorun-engine.md`.
- **Group chat and consults:** the group chat engine, its storage, and the cross-agent consult service.
- **Client and discovery:** the `MaestroClient` interface with its WebSocket implementation, and the discovery file (`cli-server.json`) a client finds a running host by. See `Plans/maestro-tui-client-api.md`.

## Managed operations

Since `0.4.0` the entry exports the generic contracts a management peer (an enterprise endpoint, a fleet controller, a test harness) uses to drive a Maestro host: `ManagedOperationContext` (who asks, from which installation, runtime and process epoch, under which delegation reference, for which run, attempt and idempotency key), `ManagedCapabilityOffer` with its all-or-nothing `ManagedNegotiationOutcome`, `ManagedOperationResult` (with `unknown` as a real answer), and the run, receipt and event records. They are Maestro's own, serializable and product-neutral; an enterprise product's wire types stay in the package it ships. A context is attribution, not authority: a host verifies it against the peer it arrived from and binds authority at the sink, never from the context's fields. `managedContextProblems()` checks the shape:

```ts
import {
	managedContextProblems,
	MANAGED_CONTRACT_VERSION,
	type ManagedOperationContext,
} from 'maestro-lib';

const context: ManagedOperationContext = {
	contractVersion: MANAGED_CONTRACT_VERSION,
	installation: { installationId: 'inst-1', runtimeId: 'rt-1', processEpoch: 'epoch-1' },
	origin: 'headless',
	actor: { kind: 'service', id: 'fleet-controller' },
	delegation: { chain: [], grantRef: null },
	identity: {
		requestId: 'req-1',
		idempotencyKey: 'submit-1',
		attemptId: 'attempt-1',
		runId: null,
		rootRunId: null,
		parentRunId: null,
	},
	policyRevision: null,
	workflow: null,
	traceId: 'trace-1',
	requestedCapabilities: ['runs.submit'],
};

const problems = managedContextProblems(context);
if (problems.length > 0) throw new Error(problems.join('; '));
```

The client interface carries the extension as `MaestroClient.managed`, optional: a host without it is `unsupported`, never "unmanaged, so allowed".

What that adds up to in `0.31.0`, before the release-by-release detail below:

- **Standalone is untouched.** A program that never passes `managed` to `createMaestroRuntime`, and a `startTurn` with no `admission`, plan and run exactly as the earlier sections describe. Nothing here reads a keyring, opens a socket or asks a peer.
- **A managed host admits launches, not providers.** `providerRouteSupport(agentId)` is the table: `managed` is `implemented` on the `child-process` route alone (the launch is admitted at the real spawn), and `unsupported` on `pty`, `codex-app-server`, `opencode-server` and `ssh`. What a provider's own tools do once running is not governed. The one route whose effects are enforced is the synthetic harness route, which qualifies no real provider.
- **An enrolled host with the reviewed endpoint refuses every real launch.** The broker's effect authority and the delegation producer are not there yet (CP-01, CP-03), so admission answers `unavailable` by name and nothing runs unmanaged in its place. A standalone host is unaffected.
- **Words.** `unsupported` is a route this build cannot enforce; `unavailable` is an authority that could not be reached; `denied` is a decision; `unknown` is an answer that was lost. None of them permits a fallback.

How to enroll a desktop, start a managed host, run the pair harness and recover from a lost daemon is on [Mega-Maestro (Managed Operation)](./mega-maestro), with the producers still missing and who owns them.

The entry also exports the endpoint port (`EndpointPort`, `ManagedIdentityPort`, the protocol-1 envelope helpers and validators in `managed/endpoint-port.ts`) and the host adapter (`createManagedHostAdapter()`, `installationIdentity()`, `projectPolicyStatus()` in `managed/host-adapter.ts`). A host injects its own custody and socket through `createMaestroRuntime({ managed: { host } })`; the library never opens a socket or reads a keyring itself, and `ManagedApi.policy()` answers the adapter's policy projection.

The entry also exports the one qualified synthetic route (`managed/provider-route.ts`): `buildHarnessLaunchSpec()` runs an inline Node program under the Node permission model with exactly the declared inputs readable, its private work directory writable, and the network, child processes and workers refused by the runtime; `syntheticHarnessRouteSupport()` reports that route alone, with its enforcement per effect, and says in so many words that it qualifies no real provider. The route is `unsupported` on Windows and on a Node that does not honor every flag in `HARNESS_REQUIRED_NODE_FLAGS` (`--allow-net` among them: Node 26 does, Node 22.16 does not), and a caller then refuses rather than spawn unconstrained. Every snapshot now carries a `DispatchOperation` (`start`, `input`, `resume`), and a lease an endpoint-backed authority minted carries the broker's `ManagedDecisionReceipt`.

The entry also exports the managed credential and routing seams (`managed/credentials.ts`, `launch/env.ts`, `launch/launch-plan.ts`): `bindApprovedCredentials()` binds opaque, tenant/actor/agent/audience/account-bound references to one launch and is the only producer the launch plan accepts; `AgentLaunchInput.managed` carries the policy's route ceiling and approved references, and the plan then resolves values once at the launch boundary (every reference or nothing), applies `applyManagedEnvCeiling()` on every surface after the user layers, refuses bypassing arguments (`managedArgsProblems()`), a personal-login fallback, an SSH remote and a provider other than the route, and ignores `requiredSecrets`. Provider swaps and resumes are reauthorized by a bound grant (`authorizeProviderSwap()`, `authorizeManagedResume()`) with the original provider lineage kept; a migration under `TranslationGovernance` holds dispatch, reauthorizes its destination, project memory and resource export, and binds its knowledge index to a hash. An unmanaged launch or migration is planned exactly as before.

Since `0.5.0` the entry also exports the lineage an Auto Run's turns carry (`autorun/attribution.ts`): `AutoRunWorkflowIdentity` (the playbook or goal as a workflow, with its version, trigger event and run id), `newAutoRunTurnRequest()` and `nextAutoRunAttempt()` (one request per task, one attempt per try), and `autoRunRunIdentity()` / `autoRunWorkflowRef()`, which turn one attempt into the contract's `ManagedRunIdentity` and `ManagedWorkflowRef`. The headless runtime builds that identity for every run it launches and admits each attempt (a task, its effort retry, a synopsis, a goal handoff) on it through `createHeadlessSpawnAuthority()` over its binding and attached host, with the enrollment's registered actor as the principal (`managedActorPrincipal()`). The owner fence is never minted here: `createMaestroRuntime({ managed: { workflowFence } })` is where a workflow owner producer supplies one, and until it does a managed runtime refuses every Auto Run as unavailable before any process starts, while a standalone runtime runs as before.

Since `0.6.0` the entry also exports the delegated-dispatch context (`managed/delegation.ts`): `ManagedDelegationContext`, the attribution half of a `ManagedOperationContext` one operation hands a child it dispatches or consults (run identity, trace, workflow with its fence, delegation chain, the policy generation it was admitted under; never the installation, origin or actor, which are the child host's own), `delegationContextOf()` to read it off the context an operation runs under, `childDelegationContext()` to derive the child's (chain one link deeper, parented under the initiator's run), `intersectDelegationScope()` (a managed initiator's child on a host with no enrollment is refused, never run unmanaged; a managed host admits under its own generation), `delegatedWritable()`, and the env carriage `MAESTRO_DELEGATION_CONTEXT` through `delegationContextEnv()` / `readDelegationContextEnv()` (an invalid record is a refusal, never an anonymous child). `maestro-cli dispatch` reads it and forwards it to the desktop, whose process sink binds the dispatched turn as that operation's child; the headless consult stamps it on the target; a Cue `mode: cli` action is its first producer. The record is attribution, not authority: the receiving host verifies it and asks its own authority at effect time, and a host adapter that cannot describe a chain to its endpoint answers unavailable rather than dropping it.

Since `0.7.0` the entry also exports the room lineage a group chat turn is admitted under (`groupchat/spawn.ts`): `groupChatRoomContext(chatId)` is the room as the operation every turn in it is a child of (run `group-chat:<chatId>`, the room as the first principal on the chain, no workflow, no policy generation), `groupChatTurnContext(spawn)` is one turn's context (the record the spawn carries for a consult, else the room's child with the process id as request, attempt and link), `groupChatIdOf()` / `groupChatRoomRunId()` name the room, and `groupChatTurnAttribution()` is what the authority is told beside the final process spec (provider, configured model, local or SSH target, the agent's directory as a resource). The headless runtime's background runner (`createBackgroundTurns({ managed })`) binds that context on the host's spawn port and asks for a lease on the final spec right before the spawn, for a moderator, participant, synthesis, recovery or consult turn alike, and refuses rather than run a turn it did not admit; the desktop's `spawnGroupChatAgent` hands the same room record and the same ids to `ProcessManager.spawnAdmitted`, so one turn is one context on either host. Both stamp the record on the process, so what the agent itself asks or dispatches carries the chain one link deeper. A host adapter that cannot describe a delegation chain to its endpoint still answers unavailable (CP-03), so an enrolled installation with the reviewed bridge refuses every group chat turn and consult explicitly instead of running it unmanaged.

Since `0.8.0` the entry also exports durable workflow ownership (`managed/workflows.ts`): `createWorkflowOwnership({ file, port, owner, now })` claims the owner fence of a workflow (an Auto Run, a Cue pipeline) from the workflow owner producer the endpoint's `workflow` operation names, once per run and attempt, and keeps what the registry answered in `maestro-managed-workflows.json` so a retry, a resume and a restarted host re-claim with the same epoch and token; nothing in it mints a fence, a fenced or unknown holder answers none, an offline-enabled holder keeps the one it was issued while the producer is unreachable, and a missing producer is refused by name. `workflowFenceOf()` turns a claim into the answer a host's `workflowFence` seam takes, `endpointWorkflowOwnerPort()` builds the producer port over an `EndpointPort`, and `workflowEndpointId()` names a Maestro id to the registry.

Since `0.9.0` that ownership is wired on the headless hosts (MRC-07-06A). `ManagedHostAdapter.workflows` is the producer port over the adapter's endpoint socket, null while none is attached. `createMaestroRuntime` composes one `createWorkflowOwnership` over `maestro-managed-workflows.json` in its data directory, loaded under the lock at start, claiming as the installation under the authority the binding names and through that port; every Auto Run attempt is admitted on `MaestroRuntime.claimWorkflowFence(workflow, { runId, attemptId })` (the task's request id and the attempt id, re-claimed on an effort retry), and a Cue engine hosted in the same process (`maestro-cli host`) is handed the same claim, so one record holds every fence there. `managed.workflowFence` on the runtime options, `RuntimeAutoRunManagedOptions.workflowFence` and `AutoRunManagedOptions.fence` all take the attempt's ids and may answer later; the producer's refusal (`WorkflowFenceRefusal`) is the turn's reason with its state and code, and a bare null is still an unowned workflow. With no attached producer (no host adapter, or `maestro-cli cue engine start` on an enrolled machine, which then has no standing to claim under) the claim is refused by that name; nothing mints a fence in the registry's place, and a standalone runtime never asks.

Since `0.10.0` the managed contract names one more transport a host verifier can authenticate a peer over: `ManagedPeerAuthentication` adds `device-pairing`, a device the host paired (Maestro Lite) and authenticated by a pairing credential bound to the host's origin, beside `in-process`, `os-peer`, `host-secret` (a process presenting the host's per-boot secret, the Maestro CLI) and `web-login`. Each is transport admission and none is a principal: a verification records the transport, the principal stays the enrollment's registered actor, and the transport's peer is carried on the delegation chain as attribution (a web login as the human account, the CLI secret as the `maestro-cli` service, a paired device as `lite-device:<deviceId>`). A host that cannot authenticate a transport leaves it out of its `hostCompatibilityProfile().transports`, as before.

Since `0.11.0` a launch target on an SSH remote can carry the identity of the enrolled runtime there (MRC-08-04). `SshRemoteEndpointIdentity` is what that runtime attests about itself over the launch's own SSH connection: contract version, installation, runtime and process epoch, tenant and org, its authority id and applied policy revision, whether its authority is `registered`, and its own route table for launches that arrive over SSH. `sshRemoteEndpointProblems(value, expect)` is the pure rule a host applies before handing a managed launch over (the same enterprise, a registered authority there, a policy no older than the host's, `managed: 'implemented'` on the provider's `ssh` row); `qualifySshLaunchTarget(target, read, expect)` binds the identity onto a resolved remote target as `endpoint`, or refuses by name with the new unresolved reason `remote-unqualified`, whose message promises the launch ran nowhere (not on the remote unmanaged, not locally instead). `wrapManagedSpawnWithSsh` is the managed wrap: with SSH on it never answers with a local launch, and its `SshSpawnWrapResult.sshRemoteEndpoint` is set only when the remote qualified. The attestation is the remote's word and transport admission, never authority: a working login, a local approval and the local route table prove nothing about the remote's tools, files or egress, and a remote runtime of this version attests `ssh` as `unverified`, so every real remote is refused until a producer there admits SSH arrivals at its sink. Standalone launches are untouched (`resolveSshLaunchTarget` and `wrapSpawnWithSsh` behave as before).

Since `0.12.0` a host attests that standing itself (MRC-08-04A). `HostStatusReport.managed` is the `SshRemoteEndpointIdentity` a `maestro-cli host` reports in `host status --json`, which is what a desktop's remote endpoint probe reads over SSH. `hostManagedStanding({ installation, host, providerIds? })` in `runtime/server.ts` produces it from the host's own standing alone: the installation the runtime computed, the enrollment record the host adapter's custody holds (tenant, org, and the authority id that record implies), the policy revision the adapter applies, `authority: 'registered'` only while the enrollment lifecycle says so in that process (an enrolled host that is not attached attests `none`), and the `ssh` row of that build's own `providerRouteSupport` table for every provider the runtime serves, with the row's confinement column as `managed`. No adapter, no record, or a custody view short of `ok` is no `managed` at all: a standalone host reports none, and the key is absent rather than null. `RuntimeHostOptions.managed` hands a composed adapter to `startRuntimeHost`. At `0.12.0` `maestro-cli host start` composed none; since `0.14.0` it composes the adapter when it holds protected custody for the record, which a plain Node process does not (see below), so a real detached host still reports none and says why. A host that does attest reports its `ssh` rows as `unsupported`, so a probing desktop refuses it by its own word until a producer there admits SSH arrivals at its sink.

Since `0.13.0` a managed dispatch target on an SSH remote can name the endpoint it was qualified against (MRC-08-04B). The `ssh` variant of `ManagedDispatchTarget` gains an optional `endpoint: ManagedSshEndpointRef` (installation, runtime, process epoch, authority id and policy revision of the enrolled runtime on the remote), and `managedSshEndpointRef(identity)` in `launch/ssh-remote-resolver.ts` reads it off an attested `SshRemoteEndpointIdentity`. A sink that admits a managed SSH launch puts it in the snapshot's target, so the lease the authority grants says which remote installation and authority the launch goes to, not only the remote's local id; the request digest changes with it. The desktop is the first sink to do so: its spawn handler asks the enterprise service's remote endpoint qualifier beside the launch plan, before any side effect, refuses by the remote's word with nothing run anywhere, and on a qualified remote carries the attestation to the process manager, which binds the ref into the lease and admits the local `ssh` child only while it is present. A standalone launch carries no endpoint and is unchanged; the CLI and Cue hosts still refuse a managed SSH launch at the launch plan, since no qualifier is composed on them.

Since `0.14.0` a host that attests no standing can say why (MRC-08-04C). `HostStatusReport.managedUnavailable` is a reason beside `managed`, never a standing: with a host adapter composed it is the adapter's own custody view when that is short of `ok` (an unprotected or untrusted record; a view of `none` is a standalone host and says nothing), and with no adapter it is what the host process gave `startRuntimeServer`'s `describe().managedUnavailable`. `hostManagedUnavailable({ host, composed? })` in `runtime/server.ts` produces it. `maestro-cli host start` now composes the same parts the desktop composes (the identity store over the data directory's sealed record, the endpoint client over the socket that record names, the enrollment lifecycle, `createManagedHostAdapter`) when it holds protected custody for the record, re-attaches once the runtime holds the directory, and attests as that host; a plain Node process holds the keyring anchor but no protected seal (the record is sealed with the key Electron safeStorage keeps for the desktop app, and the obscuring seal is not credential protection), so a real detached host of this version composes nothing, logs that reason once at start, reports it in `host status`, and runs an enrolled data directory enrolled-unavailable as before.

Since `0.15.0` a detached host answers managed operations over its bridge (MRC-08-05). One message, `managed_operation` (`MANAGED_OPERATION_MESSAGE` in `client/host-control.ts`, with the closed list `MANAGED_WIRE_OPERATIONS`), carries each `ManagedApi` call plus `scope`, and `createWsMaestroClient().managed` drives it, so a TUI or another process reaches the same facade an in-process caller holds. The host admits a request in its own scope (`runtimeManagedScope(runtime)` in `runtime/server-requests.ts`, read per request from the host adapter custody and the enrollment record, never from an option): the caller presented the host per-boot secret, which admits the transport and grants no role, so the context must name this installation, runtime and process epoch, the principal the host custody names (`managedActorPrincipal`), no delegation chain or grant reference, and, for `submit`, `cancel` and `interrupt`, the policy generation the host applies now; `managedScopeRefusal()` refuses anything else by name (`unauthenticated` or `context-mismatch`), before the facade verifies the context again with its own verifier. `ManagedApi.scope()` is the read a transport caller fills its context from (`ManagedScope`: installation, actor, policy revision, binding); the in-process facade has none. A desktop or an older host echoes the message, which the client reports as `unsupported`, never as unmanaged. On the turn service the single-writer rule now holds at the sink: a managed send on a runtime that lost its data directory is refused and journaled before anything is queued, every turn is refused before its spawn once the lock is lost, and a managed turn whose provider launch answered with a process and no lease is stopped before it is registered, written down or streamed, so an embedding host that replaced the launch cannot run a managed turn unadmitted.

Since `0.16.0` the facade records which transport admitted an operation (MRC-08-05A). `ManagedOperationEnvelope` carries an optional `peer`, and only the host sets it: the bridge handler stamps `host-secret` on the envelope it hands the facade once the scope has admitted the context, and an in-process caller stamps nothing. An envelope that arrives over the bridge already naming a `peer` is refused `invalid-input`; a caller never names the transport it came over. The facade (`createManagedOperations`) holds one verifier per transport (`ManagedOperationsDeps.verifiers`, keyed by `ManagedPeerAuthentication`, beside the in-process `verifier`), and `createMaestroRuntime` builds the `host-secret` one under the same installation rule with the verifier id `host-secret:<runtimeId>`. So `identity` over the bridge answers `verification: { peer: 'host-secret' }` and the in-process facade still `in-process`; a transport the host has no verifier for is refused `unauthenticated`, never verified as in-process. The negotiation profile lists the transports the facade can verify.

Since `0.17.0` the entry exports the lifecycle metadata projection (`managed/events.ts`, MRC-10-01). `createLifecycleProjector({ installation, origin, actor, policyRevision })` is what a host composes once and hands its real lifecycle producers: the desktop's agent-run capture (every `ProcessManager` spawn, supersede and exit, with the terminal and group-chat sessions the AgentRun ledger omits by design projected as `record: 'omitted'` instead of left out) and the runtime's turn recorder (every finished turn, through `RuntimeTurnOptions.lifecycle`). A producer reports a `LifecycleFact`: the surface and process session, the agent and tab, the provider and model, its own run id and where it recorded the run (`ledger`, `journal`, `omitted`, `none`), the state, exit code and duration, the managed lineage when the work had one (`lifecycleLineageOf(context)`) and the decision it ran under (`lifecycleAdmissionOfLease(lease)`: lease, authority, request digest, broker receipt). The projector answers `ManagedLifecycleEvent`s in the `ManagedEvent` shape, a `decision` before the `run-state` of an admitted start, with an id that is a digest of the fact (the same fact twice is one event), a sequence numbered from 1 in this process, and a bounded `recent()` window whose loss is counted in `gaps()`; `subscribe()` is what a durable journal or a telemetry client reads. The fact type has no field for a prompt, an answer, a tool body, a working directory or an environment value, and `lifecycleFactProblems()` refuses a fact that carries an unknown field whole. This is a projection, not delivery: nothing in it acknowledges anything to a peer, and the desktop's private per-agent recording is not a producer.

Since `0.18.0` the entry exports the durable event journal (`managed/event-journal.ts`, MRC-10-02). `createEventJournal({ file, now, newId })` over `<userData>/maestro-managed-events.json` (`managedEventJournalPath(paths)`) is what a host attaches to its lifecycle projector (`attach(projector)`): every projected event is kept under the journal's own sequence, which continues across a restart (the projector's starts at 1 per process), a replayed fact is one entry (dedup by event id), and the file is written atomically through `writeStoreDocument` with a burst coalesced into one write. It is a boundary record, not a second spool: the endpoint daemon's `telemetry` operation owns the durable upload toward the fleet, and the journal records what this host handed over and what came back. `take(limit)` hands the oldest unconfirmed entries to a transport once; `acknowledge(ids, receipt)` is the only path to `received` and is called from the endpoint's own answer; `settle(ids, 'uncertain', detail)` keeps an entry whose answer was lost eligible for a resend, and `'unavailable'` (nothing left the process) releases it unchanged. Missingness is recorded, never inferred: a projector refusal, a hole in the projector's sequence, a restart that went unobserved, and a trimmed entry the endpoint never confirmed are each a `JournalGap` placed after a sequence, bounded and counted when forgotten. `page({ cursor, limit })` answers `ManagedEventPage` oldest first with an opaque cursor (`encodeEventCursor` / `decodeEventCursor`, naming the journal and a sequence) and `completeness`: `gap` when anything between the cursor and the last item was lost, `unknown` for a cursor another journal issued, and a `nextCursor` that is the position after the last item so a poller hands it back later. `ManagedEventsQuery` in `client/types.ts` is what `managed.events` is asked; `status()` reports the delivery counts, the held batch, the gaps and the last failed write, which `flush()` also rejects with. The headless runtime composes both halves (MRC-10-02A): its own `createLifecycleProjector` under its installation, with the enrollment's registered actor (else the operator) and the adapter's policy revision, handed to the turn recorder unless the host passed `turns.lifecycle`, and the journal under its data directory attached to it; `runtime.lifecycle` is where a host's own producers report facts, `runtime.managedEvents` is the journal (null when its file would not load, which is logged and left alone), `ManagedApi.events` pages from it and the facade then reports `events.resume` as implemented, and shutdown flushes it after the last turn records itself. The desktop does the same through `EnterpriseService.eventJournal`, attached to `EnterpriseService.events` at start and flushed at close. Nothing here sends anything; the telemetry client is MRC-10-03.

Since `0.19.0` the host adapter carries the telemetry seam (MRC-10-03). `ManagedHostAdapter.telemetry` is the endpoint's `telemetry` operation over the adapter's socket (`endpointTelemetryPort(endpoint)`: one `EndpointTelemetryEvent` per request, answered with the endpoint's durable receipt or its denial; null while no socket is open), and `telemetryStanding()` says whether a report may be handed over right now: `ok` with the `TelemetryBinding` every report carries (the enrollment id as `deviceId`, the installation, the applied policy revision collection is authorized under) when this process holds a registered, attached, managed standing whose connection negotiated the `telemetry` capability and whose record names an enrollment id and a revision, else the one reason it may not. Both answers carry a `standingKey` (connection, registration, attachment, management, revision, capabilities): a telemetry hold placed under one key is released when the key changes. `EndpointTelemetryEvent` is the transcription of the endpoint's runtime report: bound to `deviceId`, `instanceId` and `bootId`, `source: 'runtime'`, a lifecycle family, `collectionProfile: 'metadata'`, a `completeness` triple and no agent, session, run or trace identity (the endpoint refuses them on a runtime report). `EventJournal.take(limit, { skip })` leaves an entry the transport cannot carry in place, unheld and not counted as an attempt. The client that drives the loop (take, report, settle: `received` from a receipt only, `uncertain` for a lost answer and a resend by the same id, a hold on a policy or standing denial, an earlier boot's entries left in place by name) is `createTelemetryClient()` in `src/main/enterprise/telemetry.ts`, plain Node, composed by the desktop service and by a `maestro-cli host`.

Since `0.20.0` the entry exports usage provenance (`streaming/usage-accumulator.ts`, MRC-10-04) and the usage half of the projection (`managed/events.ts`, MRC-10-04A). `UsageProvenanceTracker` watches one process's usage reports as the parser extracted them, before `parsedUsageToStats` fills an absent field with 0, so a cost or a cache count the stream never carried is known to be absent; it sums nothing (the totals in `usage-totals.ts` do that) and names the reporting style (`running-total`, `turn-total`, `per-step`, `single-event`, `none`) and the correction replays it skipped. `describeUsageProvenance(observed, total, model)` says what a total is made of: the contract word (`usageProvenanceOf`: a runtime says only `estimated` or `unavailable`; `gateway_metered` is the gateway's word and `provider_reported` the provider's billing record, never a runtime's), where the tokens came from, where the cost came from (`reported` by the stream, `priced` here from the rate table with `usagePriceRevision(model)` naming the entry, or `none`), the cache convention (`inside-input` for OpenAI, `beside-input` for Anthropic), a `null` for every count the stream never carried, and `unavailable` with no counts for a stream that carried nothing. A `UsageFact` is that provenance with the run's identities (the lifecycle fact's fields, the account reference as a digest, the tenant and org the enrollment record named when the work ran, kept as the attribution of record) and the lineage and admission a managed run settled under; `usageFactProblems()` refuses any other key, inside `usage` and `counts` too, and holds the words to the figures. `LifecycleProjector.recordUsage(fact)` raises one `usage` event (`ManagedUsageEvent`) under the same sequence as the run's lifecycle events, with an id that digests the run, the figures and their provenance, so the same settled usage twice is one event and a corrected total is another. The desktop's producer is `createUsageCapture()` in `src/main/enterprise/usage.ts`; the telemetry client sends a usage event as the `usage` family with the fact's provenance and keeps the figures, account and org in the journal. Nothing here is billing authority: a Usage Dashboard bucket is a display.

Since `0.21.0` the projection carries the inventory half (`managed/events.ts`, MRC-10-06). An `InventoryFact` is what one host reports of its installation, in the sibling `fleetInventory` vocabulary where the endpoint has one: the device (the enrollment id as `deviceId`, a hostname and an OS label, each or null), the runtimes it knows of with their components (`runtimeId`, `processEpoch`, the same `EndpointComponent` list the attachment announced), each provider with its detected installation (`detected`, `absent`, `unknown`, the probed version or null: detection, never enforcement) beside the per-route `standalone` and `managed` support words of `providerRouteSupport()`, the subagents as an `InventoryObservation` (`observed` with a count, or `unavailable` with none: an unobserved count is never a zero), the applied policy revision, a completeness word and every gap named. `inventoryFactProblems()` refuses a fact with an unknown field at any level (a socket path or a token under any key), an unbounded or repeating list, or a word that is not ours, whole. `LifecycleProjector.recordInventory(fact)` raises one `inventory` event (`ManagedInventoryEvent`, `ManagedEventKind` gains `inventory`) under the same sequence, window and listeners as the lifecycle events, with the host process as its lifecycle surface (`host`, the new `LIFECYCLE_SURFACES` member: session `runtimeId`, run `host:<runtimeId>:<processEpoch>`, provider `maestro`, `record: none`) and no run record; its id (`inventoryEventId`) digests the inventory and not its time, so an unchanged inventory reported again is one event (the journal keeps it once) and a change (a new boot, a provider detected, a revision applied) is the delta. The desktop producer and reader are `src/main/enterprise/inventory.ts` (MRC-10-06A); the endpoint takes no inventory family from a runtime source, so the event stays on the host, paged by `events.resume`.

Since `0.22.0` the entry exports typed runtime commands (`managed/commands.ts`, MRC-11-01): the endpoint's six typed actions (`pause_run`, `resume_run`, `cancel_run`, `report_status`, `refresh_policy`, `operator_prompt`) as `ManagedRuntimeCommand`, the fields of the signed payload without the signature plus the release id the delivery carried; `managedCommandProblems()` refuses any other shape whole, and `commandBindingProblem()` binds a command to this tenant, enrollment, installation, process epoch, registered actor, advertised capability (`commandCapability(kind)` is `command-<action>`), applied policy revision, validity window and known run, refusing by name (`CommandRefusal`: `invalid-input`, `unauthenticated`, `stale-run`, `policy-denied`, `expired`, `unsupported-capability`, `approval-required`, `replay`). An operator prompt runs only under a separate `approved` approval bound to the payload digest. The settlement words are the published ones: `accepted`, `completed`, `failed`, `no-effect`, `unknown` and `denied` stay distinct, and `commandEvidenceDigest()` covers the id, the kind, the outcome and the facts a port reported.

Since `0.23.0` the same module holds the durable command ledger and the executor (MRC-11-01A). `createCommandLedger({ file, now, maxCommands })` keeps one record per command id and refuses a reused id under another payload, a consumed nonce or a consumed idempotency key as `replay` enrollment-wide; `load()` turns a record accepted by an earlier process `unknown`, and a file that will not load is named and never overwritten. `createCommandExecutor({ ledger, binding, ports, now })` advertises `command-<action>` for exactly the ports a host composed (`CommandPorts`: `pause`, `resume`, `cancel`, `report`, `refresh`, `prompt`), executes a command inside `COMMAND_DISPATCH_WINDOW_MS`, answers a known id from history without running anything again, and `settle()` records a port's later effect. The desktop composes it in `src/main/enterprise/commands.ts` (cancel revokes the run's live leases through the dispatch authority, report answers metadata, refresh re-attaches; pause and resume are not composed and are refused by name; no prompt port exists on the desktop).

Since `0.24.0` the host adapter carries the notice inbox seam (`managed/host-adapter.ts`, MRC-11-02): `ManagedHostAdapter.inbox` is the endpoint's `noticeList` and `inbox` operations over the adapter's socket (`endpointInboxPort(endpoint)`: `EndpointNotice`, `EndpointNoticeListRequest`, `EndpointNoticeListResult`, `EndpointInboxRequest` with its `delivered`, `read`, `acknowledged` and `reply` actions, `EndpointInboxReceipt`; null while no socket is open), and `inboxStanding()` says whether a notice may be listed or a receipt recorded right now: `ok` with the `InboxBinding` (tenant, enrollment, registration, actor, installation, policy revision and the two negotiated capabilities) under a registered, attached, managed standing, else the one reason, under the same `standingKey` rule as telemetry. The client that lists, holds and records (`createInboxClient` over `createInboxReceiptLedger`) is `src/main/enterprise/inbox.ts`, plain Node, composed by the desktop service; a body reaches the person's surface and nothing else.

Since `0.25.0` the dispatch snapshot carries a launch classification (`managed/authority.ts`, MRC2-02-01): `DispatchPurpose` says what the launch is for (`conversation` for a person's turn, `utility` for a tab name or a synopsis Maestro runs beside one, `probe` for a read-only look at a provider, `supervisor` for a background service's child) and the contract's `ManagedOrigin` says which surface raised it; both are optional on `DispatchSnapshot`, set from `DispatchAttribution` and left out of the digest when a surface does not classify, so a policy can tell a person's turn from Maestro's own. They are attribution, never a permission level: a utility turn is admitted or refused like any other. The desktop sink classifies every spawn (`buildSpawnRequestSnapshot` in `src/main/process-manager/ProcessManager.ts`, from `ProcessConfig.purpose` and `ProcessConfig.origin`).

Since `0.26.0` a probe (a provider started for its metadata alone, with no prompt of the person's: Codex's skill list) has its own admission in `managed/host-adapter.ts` (MRC2-02-04). `admitProbeTurn({ authority, policy, context, spec, attribution })` asks the host's authority for a lease on the snapshot of the probe's final spec, stamped `purpose: probe` and `operation: start`, and hands back the `admission` that `startTurn` takes, built over `leaseAdmission` so the lease is checked again against the spec that reaches `spawn`, bound to the pid, released with the exit and revocable. `probeRouteRefusal(providerId, route)` holds a probe to the route's managed standing in `providerRouteSupport` before the authority is asked (a route with no enforcement producer refuses `unavailable` by name, never runs unmanaged), `probeTurnIdentity()` is a probe's own run identity (one request, one attempt, no run above it), and `createProbeRefusalCache()` remembers a refusal per authority, policy revision, provider, route and caller scope for `PROBE_REFUSAL_TTL_MS`, so a surface that probes on every detection does not ask again for the same answer; a new revision is a new key and an admission is never cached. A standalone host passes no `managed` to the surface and probes as before.

Since `0.27.0` a supervisor's child (a long-running process of Maestro's own that a background service of the host starts and keeps alive: a Pianola watcher or orchestration through the bundled CLI, the Computer History accessibility helper) has its own admission in `managed/host-adapter.ts` (MRC2-02-05). Nobody is at a keyboard for it, so `admitSupervisorChild({ port, service, traceId, spec, attribution? })` binds this process through the port's `verify` with the service on the delegation chain (`supervisorServicePrincipal(service)`, a `service` principal `maestro-supervisor:<service>`; the installation and its principal come from the port's verified context) and asks the authority for a lease on the snapshot of exactly the spawn the supervisor will make (`purpose: supervisor`, `operation: start`, origin `desktop`, provider `supervisorChildProvider(service)` so a policy that denies `maestro-supervisor:pianola` denies every Pianola child and nothing else). The admitted answer carries a `SupervisedChildLifetime` the supervisor drives around the raw child it spawns itself: `admit()` re-checks the lease against the spec the instant before `spawn` (a changed spec is `lease-invalid` and the lease is released), `spawned(child)` binds the pid, `onRevoked` hears a revocation so the supervisor stops the child, `exited(exit)` releases with the exit or who stopped it, `withdraw(message)` releases a lease nothing started on. A refusal is a `ManagedAdmissionRefusal` (state, code, message; `ProbeTurnRefusal` and `SupervisorChildRefusal` alias it), reported as the supervisor's own state and never retried on a timer; `ownRunIdentity()` is the identity of a launch that is its own request. A standalone port, or none, admits nothing and the supervisor spawns as before.

Since `0.28.0` the route ceiling pins a permission mode (`launch/env.ts`, MRC2-03-01). `ManagedRouteCeiling.permissionMode` is the widest `LaunchPermissionMode` (`readonly` < `standard` < `full`) a launch on that provider may ask for, or null for none pinned. A request above it is refused by name and never lowered to fit: `buildAgentArgs` given `managedCeiling` (an authority is present) throws `ManagedPermissionModeError` where the request is still a mode, so a provider whose full access is an environment setting or has no flag is still held; `managedArgsProblems` refuses, under a pin below `full`, every flag of the provider's full-access vocabulary (`KNOWN_FULL_ACCESS_FLAGS` plus its own `fullAccessArgs` / `yoloModeArgs`, read by `permissionVocabularyOf` / `fullAccessFlagsOf`) and every mode flag whose value names full access (`--permission-mode bypassPermissions`, `--approval-mode yolo`, `--sandbox danger-full-access`, `--ask-for-approval never`), and under `readonly` a provider whose read-only mode the command line does not enforce (`readOnlyCliEnforced`) or a command line that does not carry its read-only flags. `permissionModeWithinCeiling` is the one width rule every surface compares with, and `managedPermissionModeProblem` words the refusal. A ceiling that pins no mode, and an unmanaged launch, change nothing.

Since `0.29.0` the launch plan carries the permission decision (`launch/launch-plan.ts`, MRC2-03-03). `AgentLaunchInput.permissionMode` is the mode the surface asks for (the CLI names `full` for an unattended batch launch whose command line carries a flag of the provider's full-access vocabulary, `readonly` in read-only mode and `standard` otherwise; a surface that names none gets `defaultLaunchPermissionMode`, which is `readonly` or `standard` and never `full`). Under `managed.route` the plan measures that mode against `route.permissionMode` before it looks at the flags, so a provider whose full access is an environment setting or has no flag is held too; a request above the pin is `managed-route-refused` with the ceiling's own words, nothing is lowered to fit, and the flags are then checked by `managedArgsProblems` as before. Every plan returns `permission: LaunchPermissionDecision` (`requested`, `ceiling`, the latter null for an unmanaged launch or a route with no pin), the one decision the sinks that emit or map access flags read: the CLI spawner takes Claude's full-access flag from the provider definition and refuses the launch (exit nonzero, zero processes, `managed: { state: 'denied' }`) when the plan does, and the Codex app-server invocation (`src/main/codex-app-server/invocation.ts`, in the desktop, not the library) maps the ceiling to the widest sandbox it allows, refuses a wider one with `refused: true` (never the exec fallback) and pins a turn that named no sandbox at the ceiling instead of `config.toml`. `HeadlessSpawnAuthority.routeCeiling(providerId)` lends an attached host's route to a headless launch (`HeadlessSpawnHost.routeCeiling`, the same object as the desktop port's `routeCeiling` seam); a standalone binding, a bare CLI with no attached host and a host with no producer answer null and plan exactly as before.

Since `0.30.0` a managed host hands maestro-p what it admitted the spawn on (`managed/tui-handshake.ts`, MRC2-03-05). The TUI spawns Claude in a pty of its own, from the binary in `MAESTRO_CLAUDE_BIN`, outside the sink the lease covers; the handshake closes that gap. `encodeTuiHandshake` signs (HMAC-SHA256 over the canonical JSON, with a key the host keeps at mode 0600 in its data directory) a `TuiHandshakePayload`: the approved binary's absolute path and the SHA-256 of its bytes, the flags the TUI may hand Claude by name (the TUI's own `--session-id` and `--resume` among them, Claude's full-access flag only when the ceiling allows it), the route's `permissionMode`, and the lease's run identity; the host stamps it as `TUI_HANDSHAKE_ENV_VAR` (`MAESTRO_MANAGED_TUI_ADMISSION`, a name the environment ceiling strips from every user layer) after the ceiling. maestro-p reads it with `readTuiHandshakeEnv`, verifying against the key at the data directory it resolves for itself (`resolveUserDataDir`), and `TuiDriver.start()` holds the spawn to it with `checkTuiSpawn` right before `pty.spawn`: a different or replaced binary, a flag outside the admission, a positional, or a bypass of approvals under a ceiling below `full` is refused by name (`tui_admission_refused`, exit 10, never exit 2 and so never replayed through the API) and nothing is spawned. No handshake is an unmanaged host, where the TUI runs exactly as before; a handshake with no key to verify it is a refusal. The host half followed in 0.31.0, below.

Since `0.31.0` the host half of that handshake is in the same module (MRC2-03-05A). `loadOrCreateTuiHandshakeKey(dataDir)` reads the 64-hex key at `tuiHandshakeKeyPath` or mints 32 random bytes there at mode 0600 with `wx` (two hosts racing on one directory both end up with the winner's key; a file that is there and is not a key is an error, never overwritten). `buildTuiHandshake({ key, run, binaryPath, args, permissionMode })` signs the payload for one admitted spawn: the allowlist is `flagNamesOf(args)` (the flags the host handed maestro-p after its script, up to `--`; a superset of what maestro-p forwards, since it keeps its own flags) plus the TUI's own `--session-id` and `--resume`, plus `--dangerously-skip-permissions` only when the ceiling is null or `full`; under a lower pin, arguments that already bypass prompts (`claudeArgsBypassPermissions`, the one rule maestro-p's `skipsPermissionPrompts` now delegates to) are refused rather than signed, as is a relative or unreadable binary, since the digest is the approval. `createFileDigestCache()` remembers a binary's digest per device, inode, size and mtime, so a host signing the same provider binary on every turn reads it once. The desktop sink (`ProcessManager.spawn`, after the lease is checked and the coworking env injected) stamps the encoded handshake and `MAESTRO_USER_DATA` on the maestro-p child's environment for a managed local interactive Claude launch, never in the request the snapshot digests; a handshake it cannot build (no data directory, a key file that is not a key, no or a relative `MAESTRO_CLAUDE_BIN`) refuses the spawn by name with the lease released, and a standalone desktop stamps nothing. The CLI and Cue maestro-p surfaces send no handshake yet.

## See also

- [Maestro CLI](./cli) for running agents and playbooks from a shell.
- [Mega-Maestro (Managed Operation)](./mega-maestro) for enrolling an installation, the per-route support table, the pair harness and recovery.
- [Running Cue on a Server](./maestro-cue-server) for unattended pipelines.
- [`examples/maestro-lib-tui`](https://github.com/RunMaestro/Maestro/tree/main/examples/maestro-lib-tui), an interactive terminal chat built on the built entry alone: provider choice, streaming, resume, Ctrl+C to stop. Its README says how to run it.
- `maestro-lib-run`, a small program in the Maestro build that runs one turn with these same calls and prints JSON lines. Its source, `src/shared/maestro-lib/bin/run-turn.ts`, is a complete example.
