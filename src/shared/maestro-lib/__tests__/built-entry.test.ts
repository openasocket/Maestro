/**
 * The public entry, as another tool gets it: built, then loaded by plain Node.
 *
 * `scripts/build-maestro-lib.mjs` (the script behind `npm run
 * build:maestro-lib`) builds into a scratch folder with no node_modules above
 * it, so nothing the bundle asks for at run time can be found except what it
 * carries, and Electron cannot be found at all. Each check then runs in a
 * separate `node` process that loads the BUILT files, never the TypeScript.
 *
 * The turn checks drive the library the way a consumer would, from the entry
 * alone: plan, start, stream, resume with the returned session id, and stop.
 * The provider is the fake agent replaying recorded turns. POSIX only, as in
 * `headless-program.test.ts`: the fake agent is started through its shebang.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

import { MAESTRO_LIB_VERSION } from '../version';
import { MANAGED_CONTRACT_VERSION } from '../managed/types';
import {
	CAPTURED_RECORDINGS,
	CAPTURED_CLAUDE_CODE_SESSION_ID,
} from '../../../__tests__/main/process-manager/recordings/captured';
import type { TurnRecording } from '../../../__tests__/main/process-manager/recordings/fixtures';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const BUILD_SCRIPT = path.join(REPO_ROOT, 'scripts/build-maestro-lib.mjs');
const FAKE_AGENT = path.resolve(__dirname, '../../../__tests__/fixtures/fake-agent.mjs');
const posixOnly = describe.skipIf(process.platform === 'win32');

/** Every runtime export a consumer of the entry relies on. */
const FUNCTION_EXPORTS = [
	'getAgentIds',
	'getAgentDefinition',
	'getVisibleAgentDefinitions',
	'getAgentCapabilities',
	'hasCapability',
	'planSessionTurn',
	'buildAgentArgs',
	'buildAgentLaunchPlan',
	'checkBinaryExists',
	'checkCustomPath',
	'turnProcessSpecFromPlan',
	'startTurn',
	'runTurn',
	'runToCompletion',
	'TurnCapture',
	'UnknownProviderError',
	'stopProcess',
	'killProcessTreeNow',
	'snapshotProcessTree',
	'resolveTurnOutcome',
	'initializeOutputParsers',
	'createOutputParser',
	'getOutputParser',
	'hasOutputParser',
	'getAllOutputParsers',
	'setMaestroLibLogger',
	'setMaestroLibErrorReporter',
	'setMaestroLibImageRefResolver',
	'setMaestroLibCapabilitySnapshotLookup',
	// The management extension (0.4.0).
	'negotiateCompatibility',
	'hostCompatibilityProfile',
	'supportAtLeast',
	'managedContextProblems',
	'isManagedOperationContext',
	'providerRouteSupport',
	// The Auto Run lineage (0.5.0).
	'newAutoRunTurnRequest',
	'nextAutoRunAttempt',
	'autoRunWorkflowVersion',
	// The delegated-dispatch context (0.6.0).
	'childDelegationContext',
	'intersectDelegationScope',
	'readDelegationContextEnv',
	// The room lineage a group chat turn is admitted under (0.7.0).
	'groupChatRoomContext',
	'groupChatTurnContext',
	// Durable workflow ownership (0.8.0).
	'createWorkflowOwnership',
	'workflowFenceOf',
];

let scratch: string;
let libDir: string;

/** Run a script under plain `node` in the scratch folder and parse the JSON it prints. */
function runNode(args: string[]): unknown {
	const env = { ...process.env };
	delete env.NODE_PATH;
	delete env.NODE_OPTIONS;
	delete env.ELECTRON_RUN_AS_NODE;
	const result = spawnSync(process.execPath, args, {
		cwd: scratch,
		env,
		encoding: 'utf8',
		timeout: 30_000,
	});
	if (result.status !== 0) {
		throw new Error(`node exited ${result.status}: ${result.stderr}`);
	}
	return JSON.parse(result.stdout);
}

function writeRecording(name: string, recording: TurnRecording): string {
	const file = path.join(scratch, `${name}.json`);
	fs.writeFileSync(
		file,
		JSON.stringify({
			chunks: recording.chunks,
			stderr: recording.stderrBuffer,
			close: { code: recording.exitCode, signal: recording.exitSignal ?? null },
		})
	);
	return file;
}

beforeAll(() => {
	scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-lib-built-'));
	libDir = path.join(scratch, 'maestro-lib');
	const build = spawnSync(process.execPath, [BUILD_SCRIPT, '--out-dir', libDir], {
		cwd: REPO_ROOT,
		encoding: 'utf8',
		timeout: 120_000,
	});
	if (build.status !== 0) {
		throw new Error(`build:maestro-lib failed:\n${build.stdout}\n${build.stderr}`);
	}
}, 150_000);

afterAll(() => {
	fs.rmSync(scratch, { recursive: true, force: true });
});

describe('the built maestro-lib entry', () => {
	it('loads with require in plain Node, with no Electron to be found', () => {
		const loaded = runNode([
			'-e',
			`
			const lib = require(${JSON.stringify(libDir)});
			let electron = 'found';
			try { require.resolve('electron', { paths: [${JSON.stringify(libDir)}] }); }
			catch { electron = 'absent'; }
			const types = {};
			for (const name of ${JSON.stringify(FUNCTION_EXPORTS)}) types[name] = typeof lib[name];
			// Negotiate through the built entry: the one managed capability this
			// build has activates, a required one it lacks is refused.
			const profile = lib.hostCompatibilityProfile({ providers: lib.getAgentIds() });
			const request = {
				contractVersions: [lib.MANAGED_CONTRACT_VERSION],
				endpointProtocols: [1],
				transport: 'in-process',
				required: ['capabilities.negotiate'],
			};
			console.log(JSON.stringify({
				version: lib.MAESTRO_LIB_VERSION,
				info: lib.MAESTRO_LIB_VERSION_INFO,
				types,
				agents: lib.getAgentIds().length,
				electron,
				activated: lib.negotiateCompatibility(profile, request),
				denied: lib.negotiateCompatibility(profile, { ...request, required: ['runs.submit'] }),
			}));
			`,
		]) as {
			version: string;
			info: { library: string; managedContract: string; node: string };
			types: Record<string, string>;
			agents: number;
			electron: string;
			activated: { outcome: string; capabilities?: string[] };
			denied: { outcome: string; reasons?: { reason: string }[] };
		};

		expect(loaded.electron).toBe('absent');
		expect(loaded.version).toBe(MAESTRO_LIB_VERSION);
		expect(loaded.info).toEqual({
			library: MAESTRO_LIB_VERSION,
			managedContract: MANAGED_CONTRACT_VERSION,
			node: '>=20',
		});
		expect(loaded.agents).toBeGreaterThan(0);
		for (const name of FUNCTION_EXPORTS) {
			expect(loaded.types[name], name).toBe('function');
		}
		expect(loaded.activated).toMatchObject({
			outcome: 'activated',
			capabilities: ['capabilities.negotiate'],
		});
		expect(loaded.denied).toMatchObject({
			outcome: 'denied',
			reasons: [{ reason: 'missing-required-capability' }],
		});
	});

	it('loads with import from an ES module', () => {
		const loaded = runNode([
			'--input-type=module',
			'-e',
			`
			import { MAESTRO_LIB_VERSION, runTurn, planSessionTurn } from ${JSON.stringify(
				// ESM takes a URL, and a Windows path reads as one with a "c:" scheme.
				pathToFileURL(path.join(libDir, 'index.js')).href
			)};
			console.log(JSON.stringify({
				version: MAESTRO_LIB_VERSION,
				runTurn: typeof runTurn,
				planSessionTurn: typeof planSessionTurn,
			}));
			`,
		]);

		expect(loaded).toEqual({
			version: MAESTRO_LIB_VERSION,
			runTurn: 'function',
			planSessionTurn: 'function',
		});
	});

	it('is a versioned package with its declarations', () => {
		const libPackage = JSON.parse(fs.readFileSync(path.join(libDir, 'package.json'), 'utf8'));
		const appPackage = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));

		expect(libPackage).toMatchObject({
			name: 'maestro-lib',
			version: MAESTRO_LIB_VERSION,
			private: true,
			main: 'index.js',
			types: 'index.d.ts',
			engines: { node: '>=20' },
			maestroAppVersion: appPackage.version,
			maestroManagedContract: MANAGED_CONTRACT_VERSION,
		});
		expect(fs.existsSync(path.join(libDir, 'index.d.ts'))).toBe(true);
		expect(fs.readFileSync(path.join(libDir, 'README.md'), 'utf8')).toBe(
			fs.readFileSync(path.join(REPO_ROOT, 'docs/maestro-lib.md'), 'utf8')
		);
		// The entry re-exports whole modules (`export * from './run/session'`), so the
		// name lives in that module's declarations and the entry's point at it.
		const types = path.join(libDir, 'types/shared/maestro-lib');
		expect(fs.readFileSync(path.join(types, 'index.d.ts'), 'utf8')).toContain("'./run/session'");
		expect(fs.readFileSync(path.join(types, 'run/session.d.ts'), 'utf8')).toContain(
			'planSessionTurn'
		);
		expect(fs.existsSync(path.join(types, 'managed/compatibility.d.ts'))).toBe(true);
	});

	it('records its own provenance: every file hashed, the source revision named', () => {
		const provenance = JSON.parse(fs.readFileSync(path.join(libDir, 'provenance.json'), 'utf8'));
		expect(provenance).toMatchObject({
			formatVersion: 1,
			name: 'maestro-lib',
			version: MAESTRO_LIB_VERSION,
			maestroManagedContract: MANAGED_CONTRACT_VERSION,
			tooling: { node: process.versions.node },
		});
		expect(
			provenance.sourceRevision === null || /^[a-f0-9]{40}$/.test(provenance.sourceRevision)
		).toBe(true);
		expect(typeof provenance.sourceDirty === 'boolean' || provenance.sourceDirty === null).toBe(
			true
		);

		const files: string[] = [];
		const walk = (dir: string) => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) walk(full);
				else files.push(path.relative(libDir, full).split(path.sep).join('/'));
			}
		};
		walk(libDir);
		const hashed = Object.keys(provenance.payloadSha256).sort();
		expect(hashed).toEqual(files.filter((file) => file !== 'provenance.json').sort());
		for (const file of ['index.js', 'index.d.ts', 'package.json', 'README.md']) {
			const actual = createHash('sha256')
				.update(fs.readFileSync(path.join(libDir, file)))
				.digest('hex');
			expect(provenance.payloadSha256[file], file).toBe(actual);
		}
	});
});

posixOnly('a consumer built only on the entry', () => {
	it('plans, streams, resumes and stops a turn', () => {
		const consumer = path.join(scratch, 'consumer.js');
		fs.writeFileSync(
			consumer,
			`
			const lib = require(process.argv[2]);
			const config = JSON.parse(process.argv[3]);

			async function turn(recording, extra, stopAfterFirstEvent) {
				const planned = await lib.planSessionTurn({
					agentId: 'claude-code',
					cwd: config.cwd,
					prompt: 'What is the capital of France?',
					command: config.fakeAgent,
					envVars: { FAKE_AGENT_RECORDING: recording, ...extra },
					resumeSessionId: config.resume,
				});
				if (!planned.ok) throw new Error(planned.error);
				const events = [];
				const running = lib.runTurn(
					planned.spec,
					{ agentId: 'claude-code', sessionId: 'consumer', stopGraceMs: lib.INTERACTIVE_STOP_GRACE_MS },
					{
						onEvent: (event) => {
							events.push(event.type);
							if (stopAfterFirstEvent && events.length === 1) running.handle.interrupt();
						},
					}
				);
				const done = await running.completed;
				return { resuming: planned.resuming, events, outcome: done.outcome, sessionId: done.sessionId, answer: done.answerText };
			}

			(async () => {
				const first = await turn(config.normal, {}, false);
				config.resume = first.sessionId;
				const resumed = await turn(config.resumed, { FAKE_AGENT_ARGV_OUT: config.argvOut }, false);
				const resumeArgs = JSON.parse(require('fs').readFileSync(config.argvOut, 'utf8'));
				config.resume = undefined;
				const stopped = await turn(config.normal, { FAKE_AGENT_HOLD: '1' }, true);
				console.log(JSON.stringify({ first, resumed, resumeArgs, stopped }));
			})().catch((error) => {
				console.error(error && error.stack ? error.stack : String(error));
				process.exit(1);
			});
			`
		);

		const result = runNode([
			consumer,
			libDir,
			JSON.stringify({
				cwd: scratch,
				fakeAgent: FAKE_AGENT,
				normal: writeRecording('normal', CAPTURED_RECORDINGS['captured-claude-code-normal']),
				resumed: writeRecording('resumed', CAPTURED_RECORDINGS['captured-claude-code-resumed']),
				argvOut: path.join(scratch, 'resume-argv.json'),
			}),
		]) as {
			first: { resuming: boolean; events: string[]; outcome: string; sessionId: string };
			resumed: { resuming: boolean; outcome: string; sessionId: string };
			resumeArgs: string[];
			stopped: { outcome: string };
		};

		expect(result.first).toMatchObject({
			resuming: false,
			outcome: 'completed',
			sessionId: CAPTURED_CLAUDE_CODE_SESSION_ID,
		});
		expect(result.first.events).toContain('text');

		expect(result.resumed).toMatchObject({
			resuming: true,
			outcome: 'completed',
			sessionId: CAPTURED_CLAUDE_CODE_SESSION_ID,
		});
		const at = result.resumeArgs.indexOf('--resume');
		expect(result.resumeArgs[at + 1]).toBe(CAPTURED_CLAUDE_CODE_SESSION_ID);

		expect(result.stopped.outcome).toBe('interrupted');
	}, 60_000);
});
