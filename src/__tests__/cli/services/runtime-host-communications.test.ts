/**
 * The inbox and command verbs against a detached host (MCOMP-29-03A): the real `maestro-cli`
 * verbs (`managedInboxList`, `managedInboxAct`, `managedCommand`, `managedCommandStatus`) over the
 * real bridge connection to a real `startRuntimeHost` (its `startRuntimeServer` and handler), found
 * through the real discovery file. A composed host answers from its own inbox and command service
 * with the desktop's reply shapes; an uncomposed one refuses every verb by name.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	managedCommand,
	managedCommandStatus,
	managedInboxAct,
	managedInboxList,
} from '../../../cli/commands/managed-inbox';
import type { HostCue } from '../../../cli/services/host-cue';
import { composeHostManaged } from '../../../cli/services/host-managed';
import {
	startRuntimeHost,
	type RunningHost,
	type RuntimeHostDeps,
} from '../../../cli/services/runtime-host';
import { setListenerAuthority } from '../../../main/enterprise/listener-gate';
import { listenerVerdict, type ListenerAuthority } from '../../../main/enterprise/listener-policy';
import { NO_MANAGED_COMMUNICATIONS_MESSAGE } from '../../../shared/maestro-lib/runtime/server-requests';
import { fakeAnchor, fakeSeal } from '../../main/enterprise/fakeCustody';

class Exit extends Error {
	constructor(readonly code: number | undefined) {
		super(`exit ${code}`);
	}
}

const loopbackCeiling = (): ListenerAuthority => ({
	evaluateListener: (request) =>
		listenerVerdict(
			{
				standing: 'managed',
				ceiling: { policyRevision: 2, listeners: [{ kind: 'runtime-host', reach: 'loopback' }] },
				policyRevision: 2,
			},
			request
		),
});

describe('managed inbox and command verbs on a detached host', () => {
	let dir: string;
	let running: RunningHost[];
	let lines: string[];
	let printed: string[];
	let savedDataDir: string | undefined;

	const options = () => ({
		paths: {
			userDataDir: dir,
			productionDataDir: dir,
			settingsFile: path.join(dir, 'maestro-settings.json'),
			cliServerFile: path.join(dir, 'cli-server.json'),
		},
		moduleDirectory: dir,
		version: '1.2.3',
		log: (line: string) => lines.push(line),
	});
	const deps = {
		startCue: async (): Promise<HostCue> => ({
			state: () => ({ state: 'disabled' as const }),
			activeRuns: () => 0,
			stop: async () => undefined,
		}),
		promptsLoad: () => true,
		listenerAuthority: () => loopbackCeiling(),
		composeManaged: (input: Parameters<RuntimeHostDeps['composeManaged']>[0]) =>
			composeHostManaged({ ...input, anchorFor: () => fakeAnchor({ value: null }) }),
	};

	/** Run one CLI verb; what it printed as JSON, and the exit code it asked for (undefined = none). */
	async function cli(verb: () => Promise<void>): Promise<{ out: any; code: number | undefined }> {
		printed = [];
		let code: number | undefined;
		try {
			await verb();
		} catch (error) {
			if (!(error instanceof Exit)) throw error;
			code = error.code;
		}
		expect(printed).toHaveLength(1);
		return { out: JSON.parse(printed[0]), code };
	}

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-host-comms-'));
		fs.writeFileSync(
			path.join(dir, 'maestro-sessions.json'),
			JSON.stringify({ sessions: [], activeSessionId: null })
		);
		running = [];
		lines = [];
		savedDataDir = process.env.MAESTRO_USER_DATA;
		process.env.MAESTRO_USER_DATA = dir;
		vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
			printed.push(String(line));
		});
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
			throw new Exit(code);
		}) as never);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const host of running) await host.stop();
		setListenerAuthority(null);
		if (savedDataDir === undefined) delete process.env.MAESTRO_USER_DATA;
		else process.env.MAESTRO_USER_DATA = savedDataDir;
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('a composed host answers every verb from its own inbox and command service', async () => {
		const composition = composeHostManaged({
			userDataDir: dir,
			productionDataDir: dir,
			version: '1.2.3',
			custody: { ok: true, seal: fakeSeal(), anchor: fakeAnchor({ value: null }) },
		});
		if (!composition.composed) throw new Error(composition.reason);
		const host = await startRuntimeHost({ ...options(), managedComposition: composition }, deps);
		running.push(host);
		const inbox = composition.communications.inbox();
		const commands = composition.communications.commands();
		expect(inbox).not.toBeNull();
		expect(commands).not.toBeNull();

		// The read: the host's own command service, as the desktop reply carries it.
		const status = await cli(() => managedCommandStatus({ json: true }));
		expect(status.code).toBeUndefined();
		expect(status.out).toEqual({
			success: true,
			status: JSON.parse(JSON.stringify(commands!.status())),
		});

		// The held inbox: the host's standing (unenrolled), never a notice it does not hold.
		const listing = await cli(() => managedInboxList({ json: true, held: true }));
		expect(listing.code).toBeUndefined();
		expect(listing.out.success).toBe(true);
		expect(listing.out.listing.refresh).toBeNull();
		expect(listing.out.listing.view.notices).toEqual([]);
		expect(listing.out.listing.view.status.standing).toEqual(inbox!.status().standing);
		expect(listing.out.listing.view.status.standing.ok).toBe(false);

		// A receipt on an unenrolled host is refused with its standing, attributed to the CLI peer.
		const act = await cli(() => managedInboxAct('acknowledged', 'm-1', { json: true }));
		expect(act.code).toBe(1);
		expect(act.out).toEqual({
			success: false,
			outcome: { status: 'unavailable', detail: inbox!.status().standing.reason },
		});
		expect(lines).toContain('managed_inbox_act acknowledged on m-1 by maestro-cli');

		// A command reaches the host's executor: it is recorded or refused by the service, never
		// the "nothing composed" sentence.
		const before = commands!.status().commands.total;
		const report = await cli(() => managedCommand({ kind: 'report-status' }, { json: true }));
		expect(report.out.execution.status).toEqual(expect.any(String));
		expect(report.out.execution.detail ?? '').not.toContain('No command service is composed');
		expect(commands!.status().commands.total).toBeGreaterThanOrEqual(before);

		// A refused input names the field, never the value, exactly as the desktop does.
		const bad = await cli(() =>
			managedCommand({ kind: 'cancel-run', runId: '' } as never, { json: true })
		);
		expect(bad.code).toBe(1);
		expect(bad.out).toEqual({
			success: false,
			error: 'action.runId must be a string of 1 to 256 characters.',
		});
	});

	it('an uncomposed host refuses every verb by name and reads no ledger file', async () => {
		const host = await startRuntimeHost(options(), deps);
		running.push(host);
		expect(host.managedComposition?.composed).toBe(false);

		for (const verb of [
			() => managedCommandStatus({ json: true }),
			() => managedInboxList({ json: true, held: true }),
			() => managedInboxAct('read', 'm-1', { json: true }),
			() => managedCommand({ kind: 'report-status' }, { json: true }),
		]) {
			const answer = await cli(verb);
			expect(answer.code).toBe(1);
			expect(answer.out).toEqual({ success: false, error: NO_MANAGED_COMMUNICATIONS_MESSAGE });
		}
		// Nothing was created on disk by a refusal.
		expect(
			fs.readdirSync(dir).filter((name) => /inbox|command/i.test(name) && name.endsWith('.json'))
		).toEqual([]);
	});
});
