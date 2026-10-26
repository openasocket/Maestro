/**
 * MRC2-01-06: the published command vocabulary against what this desktop
 * composes. `pause_run` and `resume_run` are signed fleet actions the local
 * endpoint's published union does not carry (CP-05) and the desktop composes
 * no port for: a command naming either is refused `unsupported-capability` by
 * name before any effect, with the same words every time, and the ledger
 * keeps no record. A `cancel_run` whose recipient names another process epoch
 * is `stale-run` before the port, and when the epoch moves between the bind
 * and the recheck after acceptance the id is burned on `stale-run` and the
 * port is still never reached. Real ledger, injected ports, no socket.
 */
import { describe, expect, it } from 'vitest';

import { DESKTOP_UNCOMPOSED_COMMANDS } from '../../../../main/enterprise/commands';
import { COUNTERPART_SUPPORT } from '../../../../shared/maestro-lib/managed/compatibility';
import {
	ENDPOINT_COMMAND_ACTIONS,
	commandBindingProblem,
	commandCapability,
	commandKindOfAction,
	createCommandExecutor,
	createCommandLedger,
	type CommandBinding,
	type CommandPortAnswer,
	type ManagedCommandKind,
} from '../../../../shared/maestro-lib/managed/commands';
import vectors from '../../../fixtures/mega-maestro/contract-vectors.json';
import {
	COMMAND_PRECONDITIONS,
	COMMAND_RECIPIENT,
	INSTALLATION,
	NOW,
	anotherCommand,
	runtimeCommand,
} from '../../../main/enterprise/fakeManaged';

const UNCOMPOSED = ['pause-run', 'resume-run'] as const;
const DESKTOP_CAPABILITIES = [
	'command-cancel_run',
	'command-report_status',
	'command-refresh_policy',
];

function binding(over: Partial<CommandBinding> = {}): CommandBinding {
	return {
		installation: INSTALLATION,
		standing: { ok: true },
		actorId: COMMAND_RECIPIENT.actorId,
		enrollmentId: COMMAND_RECIPIENT.enrollmentId,
		tenantId: 'tenant-1',
		policyRevision: COMMAND_PRECONDITIONS.policyRevision,
		runState: (runId) => (runId === 'run-1' ? 'live' : 'unknown'),
		now: NOW,
		...over,
	};
}

/** A port that records every call and answers completed; the tests expect it never to be reached. */
function recorder() {
	const calls: unknown[][] = [];
	const port = async (...args: unknown[]): Promise<CommandPortAnswer> => {
		calls.push(args);
		return { outcome: 'completed' };
	};
	return { calls, port };
}

/** The desktop's composed set: cancel, report and refresh ports, nothing for pause or resume. */
function desktopExecutor(bindingOf: () => CommandBinding = () => binding()) {
	const ledger = createCommandLedger({ now: () => NOW });
	const cancel = recorder();
	const report = recorder();
	const refresh = recorder();
	const executor = createCommandExecutor({
		ledger,
		binding: bindingOf,
		ports: { cancel: cancel.port, report: report.port, refresh: refresh.port },
		now: () => NOW,
	});
	const reached = () => cancel.calls.length + report.calls.length + refresh.calls.length;
	return { ledger, executor, cancel, reached };
}

const onRun = (id: string, kind: ManagedCommandKind) =>
	anotherCommand(id, {
		action: { kind } as never,
		preconditions: { ...COMMAND_PRECONDITIONS, requiredCapability: commandCapability(kind) },
	});

describe('the published actions and the two the desktop does not compose', () => {
	it('names pause_run and resume_run as uncomposed, outside the published union and on the CP-05 rows', () => {
		expect(Object.keys(DESKTOP_UNCOMPOSED_COMMANDS)).toEqual([...UNCOMPOSED]);
		for (const kind of UNCOMPOSED) {
			const action = ENDPOINT_COMMAND_ACTIONS[kind];
			expect(DESKTOP_UNCOMPOSED_COMMANDS[kind]).toMatch(/\S/);
			expect(vectors.localEndpoint.commandActions).not.toContain(action);
			expect(vectors.maestro.commandActionExtensions).toContain(action);
			expect(COUNTERPART_SUPPORT.find((row) => row.key === `command.${action}`)).toMatchObject({
				status: 'unsupported-by-counterpart',
				dependency: 'CP-05',
				owner: 'mega-maestro',
			});
		}
		for (const action of vectors.localEndpoint.commandActions) {
			expect(commandKindOfAction(action), action).not.toBeNull();
			expect(
				COUNTERPART_SUPPORT.some((row) => row.key === `command.${action}`),
				action
			).toBe(false);
		}
	});

	it('refuses pause_run and resume_run before any effect, with the same reason every time and no record', async () => {
		const { executor, ledger, reached } = desktopExecutor();
		expect(executor.capabilities()).toEqual(DESKTOP_CAPABILITIES);
		for (const kind of UNCOMPOSED) {
			const command = onRun(`cmd-${kind}`, kind);
			const refused = {
				status: 'denied',
				commandId: `cmd-${kind}`,
				reason: 'unsupported-capability',
				detail: `this host does not execute ${commandCapability(kind)}`,
			};
			expect(await executor.execute(command)).toEqual(refused);
			expect(await executor.execute(command)).toEqual(refused);
			// Claiming a composed capability in the preconditions changes nothing: the action decides.
			const lying = { ...command, preconditions: COMMAND_PRECONDITIONS };
			expect(await executor.execute(lying)).toMatchObject({ reason: 'unsupported-capability' });
			expect(commandBindingProblem(command, binding(), DESKTOP_CAPABILITIES)).toEqual({
				reason: 'unsupported-capability',
				detail: refused.detail,
			});
		}
		expect(ledger.list()).toEqual([]);
		expect(reached()).toBe(0);
	});
});

describe('cancel_run against the process epoch', () => {
	const elsewhere = runtimeCommand({
		recipient: { ...COMMAND_RECIPIENT, processEpoch: `${INSTALLATION.processEpoch}-next` },
	});

	it('refuses a command naming another process epoch before the port, ahead of every later check', async () => {
		const { executor, ledger, cancel } = desktopExecutor();
		const refused = {
			status: 'denied',
			commandId: 'cmd-1',
			reason: 'stale-run',
			detail: 'the command names another process epoch',
		};
		expect(await executor.execute(elsewhere)).toEqual(refused);
		// Ahead of the capability and policy checks: the epoch is read before either.
		const alsoWrong = {
			...elsewhere,
			action: { kind: 'pause-run' },
			preconditions: { ...COMMAND_PRECONDITIONS, policyRevision: 9 },
		};
		expect(await executor.execute(alsoWrong)).toMatchObject({ reason: 'stale-run' });
		expect(
			commandBindingProblem(runtimeCommand(), binding(), DESKTOP_CAPABILITIES),
			'the same command binds to its own epoch'
		).toBeNull();
		expect(ledger.list()).toEqual([]);
		expect(cancel.calls).toEqual([]);
	});

	it('burns the id on stale-run when the epoch moves between the bind and the recheck, never reaching the port', async () => {
		let reads = 0;
		const replaced = { ...INSTALLATION, processEpoch: `${INSTALLATION.processEpoch}-next` };
		// The first read binds this process; the process is replaced before the recheck that follows acceptance.
		const { executor, ledger, cancel } = desktopExecutor(() =>
			binding({ installation: ++reads >= 2 ? replaced : INSTALLATION })
		);
		expect(await executor.execute(runtimeCommand())).toEqual({
			status: 'denied',
			commandId: 'cmd-1',
			reason: 'stale-run',
			detail: 'the command names another process epoch',
		});
		expect(ledger.get('cmd-1')).toMatchObject({
			state: 'denied',
			refusal: 'stale-run',
			dispatchedAt: null,
			evidenceDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
		});
		expect(ledger.open()).toEqual([]);
		// From history now: the same answer, and still no effect.
		expect(await executor.execute(runtimeCommand())).toMatchObject({
			status: 'denied',
			reason: 'stale-run',
		});
		expect(cancel.calls).toEqual([]);
	});
});
