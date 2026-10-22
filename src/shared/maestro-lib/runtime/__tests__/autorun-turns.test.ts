/**
 * The Auto Run turn runner when the provider refuses the effort a turn asked for: it runs the turn
 * once more at the agent's own effort, as the CLI and the desktop do. Each turn is the real
 * `runAgentTurn` over the fake agent, replaying a refusal or an answer.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { claudeStream } from '../../../../__tests__/shared/maestro-lib/run/fakeGroupChatProvider';
import {
	FAKE_AGENT_PATH,
	writeFakeTurn,
} from '../../../../__tests__/shared/maestro-lib/run/fakeAgent';
import { getEffortRejection, resetEffortRejections } from '../../../effortRejection';
import type { AutoRunWorkflowIdentity } from '../../autorun/attribution';
import { createLocalHostAuthority } from '../../managed/authority';
import { createManagedBinding } from '../../managed/binding';
import { createHeadlessSpawnAuthority, installationIdentity } from '../../managed/host-adapter';
import { resolveMaestroPaths } from '../../paths/resolve';
import type { AgentRecord } from '../../store/records';
import type { AssembledTurn } from '../../turns/assemble';
import { runAgentTurn } from '../../turns/run-agent-turn';
import {
	createAutoRunTurnRunner,
	type AutoRunAdmissionEvent,
	type AutoRunSpawnAuthorityPort,
	type AutoRunTurnRunnerOptions,
} from '../autorun-turns';
import { createProcessRegistry } from '../processes';

const BUNDLED_PROMPTS = path.resolve(__dirname, '../../../../prompts');

/** Codex's answer to a retired effort value, as the Responses API words it. */
const REFUSAL = JSON.stringify({
	type: 'error',
	status: 400,
	error: {
		message:
			"Unsupported value: 'minimal' is not supported with the 'gpt-6-astra' model. " +
			"Supported values are: 'low', 'medium', 'high'.",
		param: 'reasoning.effort',
	},
});

type Reply = 'refuse' | 'fail' | 'answer';

describe('Auto Run turns: a refused effort, and the fence claimed per attempt', () => {
	let dir: string;
	/** The effort each turn was assembled with, in order. */
	let efforts: Array<string | undefined>;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-autorun-turns-'));
		efforts = [];
		resetEffortRejections();
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	function runner(
		replies: Reply[],
		extra: Pick<AutoRunTurnRunnerOptions, 'workflow' | 'managed'> = {}
	) {
		const record = {
			id: 'a1',
			name: 'Alpha',
			toolType: 'claude-code',
			cwd: dir,
			projectRoot: dir,
		} as unknown as AgentRecord;
		return createAutoRunTurnRunner({
			...extra,
			agentId: 'a1',
			paths: resolveMaestroPaths({ env: { MAESTRO_USER_DATA: dir } }),
			repository: { getAgent: () => record },
			registry: createProcessRegistry({ waitMs: 2_000 }),
			statsRecorder: { recordQuery: async () => ({ ok: true, id: 'q1' }) },
			host: { bundledPromptsDir: BUNDLED_PROMPTS },
			deps: {
				now: () => Date.now(),
				probeBinary: async (binaryName) => ({ exists: true, path: `/fake/bin/${binaryName}` }),
				runAgentTurn: (turn: AssembledTurn, options) => {
					efforts.push(turn.settings.effort);
					const reply = replies.shift() ?? 'answer';
					const recording = writeFakeTurn(
						dir,
						reply === 'answer'
							? { chunks: claudeStream('Done.', 'sess-1'), close: { code: 0, signal: null } }
							: {
									chunks: [],
									stderr: reply === 'refuse' ? `${REFUSAL}\n` : 'something else broke\n',
									close: { code: 1, signal: null },
								}
					);
					return runAgentTurn(
						{
							...turn,
							launch: {
								...turn.launch,
								command: process.execPath,
								args: [FAKE_AGENT_PATH, ...turn.launch.args],
								sessionCustomEnvVars: {
									...turn.launch.sessionCustomEnvVars,
									FAKE_AGENT_RECORDING: recording,
								},
							},
						},
						{ ...options, stopGraceMs: 200 }
					);
				},
			},
			onStream: () => undefined,
		});
	}

	it('runs the turn once more without the effort, and notes the refusal', async () => {
		const result = await runner(['refuse', 'answer']).run({
			purpose: 'task',
			prompt: 'do the task',
			effort: 'minimal',
		});

		expect(efforts).toEqual(['minimal', undefined]);
		expect(result).toMatchObject({ success: true, response: 'Done.' });
		expect(getEffortRejection('claude-code', 'minimal')).toBeDefined();
	});

	it('does not retry a turn that sent no effort of its own', async () => {
		const result = await runner(['refuse']).run({ purpose: 'task', prompt: 'do the task' });

		expect(efforts).toEqual([undefined]);
		expect(result.success).toBe(false);
	});

	it('does not retry a failure that is not a refused effort', async () => {
		const result = await runner(['fail', 'answer']).run({
			purpose: 'task',
			prompt: 'do the task',
			effort: 'minimal',
		});

		expect(efforts).toEqual(['minimal']);
		expect(result.success).toBe(false);
	});

	/**
	 * Under management (MRC-07-06A): the workflow's owner fence is claimed on every attempt for
	 * that attempt's request and attempt ids, through the host's producer seam, and the producer's
	 * refusal is the turn's reason. The port is the real headless spawn authority over a binding
	 * enrolled in the temp data directory to a local authority that allows everything, a double.
	 */
	describe('the fence claimed per attempt', () => {
		const workflow: AutoRunWorkflowIdentity = {
			workflowId: 'playbook:nightly',
			version: 'v1',
			triggerEventId: 'cli:launch:1',
			runId: 'run-1',
		};

		async function managedPort(): Promise<AutoRunSpawnAuthorityPort> {
			let leases = 0;
			const authority = createLocalHostAuthority({
				authorityId: 'fleet-authority',
				decide: () => ({ decision: 'allow', policyRevision: 1 }),
				now: () => Date.now(),
				newId: () => `lease-${++leases}`,
				leaseTtlMs: 60_000,
			});
			const binding = createManagedBinding({
				paths: { userDataDir: dir, productionDataDir: dir },
				fence: () => ({ ok: true }),
				authority,
				now: () => Date.now(),
			});
			const installation = installationIdentity({
				hostname: 'testhost',
				productionDataDir: dir,
				mode: 'tui',
				pid: 1,
				startedAt: new Date().toISOString(),
			});
			const enrolled = await binding.enroll({
				installationId: installation.installationId,
				authorityId: 'fleet-authority',
				endpointRef: 'ep',
				policySources: [],
				policyRevision: 1,
			});
			if (!enrolled.ok) throw new Error(enrolled.message);
			return createHeadlessSpawnAuthority({
				installation,
				binding: binding.state(),
				host: { authority, policy: () => ({ sources: [], policyRevision: 1 }) },
				origin: 'headless',
				actor: { kind: 'human', id: 'operator' },
			});
		}

		it('claims for the request and each attempt, the effort retry included, and admits on the fence it was given', async () => {
			const claims: Array<{ runId: string; attemptId: string }> = [];
			const admissions: AutoRunAdmissionEvent[] = [];
			const result = await runner(['refuse', 'answer'], {
				workflow,
				managed: {
					port: await managedPort(),
					fence: (run) => {
						claims.push(run);
						return { ownerEpoch: '2', fencingToken: 'fence-2' };
					},
					onAdmission: (event) => admissions.push(event),
				},
			}).run({ purpose: 'task', prompt: 'do the task', effort: 'minimal' });

			expect(result).toMatchObject({ success: true, response: 'Done.' });
			expect(efforts).toEqual(['minimal', undefined]);
			// Two attempts of one request: the same run id, a fresh attempt id, a claim for each.
			expect(claims).toHaveLength(2);
			expect(claims[0].runId).toBe(claims[1].runId);
			expect(claims[0].attemptId).not.toBe(claims[1].attemptId);
			expect(admissions.map((event) => event.kind)).toEqual(['admitted', 'admitted']);
			const [first, retry] = admissions as Array<AutoRunAdmissionEvent & { kind: 'admitted' }>;
			expect(first.attribution.requestId).toBe(claims[0].runId);
			expect(first.attribution.attemptId).toBe(claims[0].attemptId);
			expect(retry.attribution.attemptId).toBe(claims[1].attemptId);
			expect(retry.attribution.attempt).toBe(2);
		});

		it("is refused with the producer's state and code when the claim is answered that way, later, and starts nothing", async () => {
			const admissions: AutoRunAdmissionEvent[] = [];
			const result = await runner(['answer'], {
				workflow,
				managed: {
					port: await managedPort(),
					fence: async () => ({
						fence: null,
						state: 'unknown',
						code: 'outcome-unknown',
						message: 'The answer to the claim on workflow "playbook:nightly" was lost.',
					}),
					onAdmission: (event) => admissions.push(event),
				},
			}).run({ purpose: 'task', prompt: 'do the task', effort: 'minimal' });

			expect(result).toMatchObject({
				success: false,
				error: '[managed-unknown] The answer to the claim on workflow "playbook:nightly" was lost.',
				managed: { state: 'unknown', code: 'outcome-unknown' },
				agentError: { type: 'permission_denied', recoverable: true },
			});
			// No process, no effort retry of a turn that never ran, one refusal on the record.
			expect(efforts).toEqual([]);
			expect(admissions).toEqual([
				expect.objectContaining({
					kind: 'refused',
					state: 'unknown',
					code: 'outcome-unknown',
					attribution: expect.objectContaining({ workflow, attempt: 1 }),
				}),
			]);
		});
	});
});
