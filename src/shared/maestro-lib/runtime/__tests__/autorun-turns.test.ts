/**
 * The Auto Run turn runner when the provider refuses the effort a turn asked for: it runs the turn
 * once more at the agent's own effort, as the CLI and the desktop do. Each turn is the real
 * `runAgentTurn` over the fake agent, replaying a refusal or an answer.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { claudeStream } from '../../../../__tests__/shared/maestro-lib/run/fakeGroupChatProvider';
import {
	FAKE_AGENT_PATH,
	writeFakeTurn,
} from '../../../../__tests__/shared/maestro-lib/run/fakeAgent';
import { getEffortRejection, resetEffortRejections } from '../../../effortRejection';
import type { AutoRunOwnerFence, AutoRunWorkflowIdentity } from '../../autorun/attribution';
import {
	createLocalHostAuthority,
	type AdmissionRequest,
	type PolicyDecision,
} from '../../managed/authority';
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

/** `hold`: answer, then stay running until stopped (a turn mid-work, for a revocation to reach). */
type Reply = 'refuse' | 'fail' | 'answer' | 'hold';

describe('Auto Run turns: a refused effort, and the fence claimed per attempt', () => {
	let dir: string;
	/** The effort each turn was assembled with, in order (assembled, which is before the authority is asked). */
	let efforts: Array<string | undefined>;
	/** How many processes actually started: the fake agent writes one file per process it runs as. */
	const startedProcesses = (): number =>
		fs.readdirSync(dir).filter((name) => name.startsWith('started-')).length;

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
						reply === 'answer' || reply === 'hold'
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
									FAKE_AGENT_ARGV_OUT: path.join(dir, `started-${efforts.length}.json`),
									...(reply === 'hold' ? { FAKE_AGENT_HOLD: '1' } : {}),
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

		const FENCE: AutoRunOwnerFence = { ownerEpoch: '2', fencingToken: 'fence-2' };
		const ALLOW: PolicyDecision = { decision: 'allow', policyRevision: 1 };

		/**
		 * The port, and the authority behind it so a test can revoke what it minted. `decide` is
		 * the policy table double; the default allows everything.
		 */
		async function managedPort(
			decide: (request: AdmissionRequest) => PolicyDecision = () => ALLOW
		): Promise<{
			port: AutoRunSpawnAuthorityPort;
			authority: ReturnType<typeof createLocalHostAuthority>;
		}> {
			let leases = 0;
			const authority = createLocalHostAuthority({
				authorityId: 'fleet-authority',
				decide,
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
			const port = createHeadlessSpawnAuthority({
				installation,
				binding: binding.state(),
				host: { authority, policy: () => ({ sources: [], policyRevision: 1 }) },
				origin: 'headless',
				actor: { kind: 'human', id: 'operator' },
			});
			return { port, authority };
		}

		it('claims for the request and each attempt, the effort retry included, and admits on the fence it was given', async () => {
			const claims: Array<{ runId: string; attemptId: string }> = [];
			const admissions: AutoRunAdmissionEvent[] = [];
			const result = await runner(['refuse', 'answer'], {
				workflow,
				managed: {
					port: (await managedPort()).port,
					fence: (run) => {
						claims.push(run);
						return FENCE;
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
					port: (await managedPort()).port,
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

		/**
		 * Zero effect (MRC-07-07): an owner the registry fenced, a policy that changed between two
		 * attempts, a lease revoked while the turn runs, and a lineage with a fabricated trigger or
		 * fence. Each one leaves no process behind that should not exist, and each is told apart by
		 * its state and code rather than folded into one failure.
		 */
		describe('zero effect: a revoked owner, a revoked policy, a fabricated trigger', () => {
			const task = { purpose: 'task' as const, prompt: 'do the task', effort: 'minimal' };

			it('an owner the registry fenced (owner_unfenced) starts nothing, retries nothing, and is a denial nobody retries into', async () => {
				const decide = vi.fn(() => ALLOW);
				const admissions: AutoRunAdmissionEvent[] = [];
				const { port } = await managedPort(decide);

				const result = await runner(['answer'], {
					workflow,
					managed: {
						port,
						fence: () => ({
							fence: null,
							state: 'denied',
							code: 'policy-denied',
							message:
								'Workflow "playbook:nightly" is fenced: the registry holds it for another owner (owner_unfenced).',
						}),
						onAdmission: (event) => admissions.push(event),
					},
				}).run(task);

				expect(result).toMatchObject({
					success: false,
					error:
						'[managed-denied] Workflow "playbook:nightly" is fenced: the registry holds it for another owner (owner_unfenced).',
					managed: { state: 'denied', code: 'policy-denied' },
					// A decision, so the run parks for a person instead of retrying into it.
					agentError: { type: 'permission_denied', recoverable: false },
				});
				// The authority was never asked and no process was started: the fence comes first.
				expect(decide).not.toHaveBeenCalled();
				expect(efforts).toEqual([]);
				expect(startedProcesses()).toBe(0);
				expect(admissions).toEqual([
					expect.objectContaining({ kind: 'refused', state: 'denied', code: 'policy-denied' }),
				]);
			});

			it('a policy that changes between two attempts of one request is applied to the retry: the first attempt ran, the retry is refused with the decision, and nothing starts for it', async () => {
				const answers: PolicyDecision[] = [
					ALLOW,
					{
						decision: 'deny',
						reason: 'policy revision 2 forbids automation on this host',
						policyRevision: 2,
					},
				];
				const claims: Array<{ runId: string; attemptId: string }> = [];
				const admissions: AutoRunAdmissionEvent[] = [];
				const { port } = await managedPort(() => answers.shift() ?? ALLOW);

				const result = await runner(['refuse', 'answer'], {
					workflow,
					managed: {
						port,
						fence: (run) => {
							claims.push(run);
							return FENCE;
						},
						onAdmission: (event) => admissions.push(event),
					},
				}).run(task);

				// Attempt 1 ran (and was refused its effort by the provider). Attempt 2 was assembled
				// and taken to the authority, which is where the new policy met it: no second process.
				expect(efforts).toEqual(['minimal', undefined]);
				expect(startedProcesses()).toBe(1);
				expect(result).toMatchObject({
					success: false,
					error: '[managed-denied] policy revision 2 forbids automation on this host',
					managed: { state: 'denied', code: 'policy-denied' },
				});
				expect(answers).toEqual([]);
				// The retry claimed its own fence and was decided on its own attempt.
				expect(claims).toHaveLength(2);
				expect(admissions.map((event) => event.kind)).toEqual(['admitted', 'refused']);
				expect(admissions[1]).toMatchObject({
					kind: 'refused',
					attribution: { attempt: 2, requestId: claims[1].runId, attemptId: claims[1].attemptId },
				});
			});

			it('a revocation while the turn runs stops the process; the authority owns that stop, the turn is interrupted, and no lease stays live', async () => {
				const admissions: AutoRunAdmissionEvent[] = [];
				const { port, authority } = await managedPort();

				const running = runner(['hold'], {
					workflow,
					managed: {
						port,
						fence: () => FENCE,
						onAdmission: (event) => admissions.push(event),
					},
				}).run({ purpose: 'task', prompt: 'do the task' });

				await vi.waitFor(() => expect(admissions).toHaveLength(1));
				const admitted = admissions[0] as AutoRunAdmissionEvent & { kind: 'admitted' };
				// The lease is bound to the process the instant it exists.
				await vi.waitFor(() =>
					expect(authority.live().map((lease) => [lease.leaseId, lease.state()])).toEqual([
						[admitted.leaseId, 'bound'],
					])
				);
				const [lease] = authority.live();
				// And running: the revocation reaches a process at work, not one still loading.
				await vi.waitFor(() => expect(startedProcesses()).toBe(1));

				expect(authority.revoke(admitted.leaseId, 'the owner withdrew the workflow')).toBe(true);
				const result = await running;

				// Stopped by the authority: not a success, not a crash, and not an operator stop
				// either, so the engine neither records a finished task nor retries into it.
				expect(result.success).toBe(false);
				expect(result.outcome).toBe('interrupted');
				expect(lease.ended()).toMatchObject({
					state: 'revoked',
					reason: 'the owner withdrew the workflow',
				});
				expect(authority.live()).toEqual([]);
				expect(startedProcesses()).toBe(1);
			});

			it('a fabricated trigger, or a fabricated fence, is refused by the verifier before the authority is asked, and nothing starts', async () => {
				const decide = vi.fn(() => ALLOW);
				const { port } = await managedPort(decide);

				// A trigger nobody raised: the workflow names no event it was started by.
				const forgedTrigger = await runner(['answer'], {
					workflow: { ...workflow, triggerEventId: '' },
					managed: { port, fence: () => FENCE },
				}).run(task);
				expect(forgedTrigger).toMatchObject({
					success: false,
					error: expect.stringContaining('workflow.triggerEventId is not an id'),
					managed: { state: 'denied', code: 'invalid-input' },
				});

				// A fence no registry issued: a token that is not one.
				const forgedFence = await runner(['answer'], {
					workflow,
					managed: { port, fence: () => ({ ownerEpoch: '3', fencingToken: '' }) },
				}).run(task);
				expect(forgedFence).toMatchObject({
					success: false,
					error: expect.stringContaining('workflow.fencingToken is not an id'),
					managed: { state: 'denied', code: 'invalid-input' },
				});

				expect(decide).not.toHaveBeenCalled();
				expect(efforts).toEqual([]);
				expect(startedProcesses()).toBe(0);
			});
		});
	});
});
