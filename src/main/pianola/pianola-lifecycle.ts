/**
 * Constructs the Pianola supervised daemon and its scheduled re-learn job.
 *
 * Only construction and the two pure CLI-mining/rules-read helpers live here
 * - the supervisor/scheduler instances themselves stay as `let`s in
 * main/index.ts because they're read and mutated from several other
 * unscoped locations there (start, stop, the first-party supervisor
 * cross-wire, IPC registration). See CLAUDE.md's decomposition plan for
 * src/main/index.ts (Phase 5 refactoring).
 *
 * Both spawns here are Maestro's own, raised by no person. On a managed
 * desktop each is admitted first (MRC2-02-05B): the supervisor's children
 * through `deps.spawnAuthority` handed to it as `managedPort`, and the
 * re-learn job's one-shot mine through `admitSupervisorChild` as the
 * `pianola-relearn` service, so the job stages nothing from an unadmitted
 * process. Standalone (no authority, or a standalone standing) spawns as it
 * always did.
 */

import { spawn, type ChildProcess } from 'child_process';
import { resolveMaestroCliScriptPath } from '../cue/cue-cli-executor';
import { PianolaSupervisor } from './pianola-supervisor';
import { PianolaRelearnScheduler } from './pianola-relearn-scheduler';
import { runRelearnJob } from './pianola-relearn';
import { isEncoreFeatureEnabled } from '../../shared/encoreFeatureDefaults';
import { readRules, writeSuggestions, getProfile } from './pianola-store-main';
import {
	stopProcess,
	BACKGROUND_STOP_GRACE_MS,
} from '../../shared/maestro-lib/control/termination';
import {
	admitSupervisorChild,
	type SupervisedChildLifetime,
	type SupervisorChildAdmission,
	type SupervisorChildPort,
} from '../../shared/maestro-lib/managed/host-adapter';
import type { DispatchSpecLike } from '../../shared/maestro-lib/managed/authority';
import type { ProcessSpawnAuthorityPort } from '../process-manager/types';
import type { DecisionPair } from '../../shared/pianola/transcript-mining';
import type { PianolaRule } from '../../shared/pianola/types';
import type { getSettingsStore, getSessionsStore } from '../stores';

/** Cap on decision pairs the scheduled re-learn pulls from the CLI per run. */
const RELEARN_MAX_PAIRS = 100_000;

/**
 * The service the re-learn job's one-shot mine is admitted as. It is not a
 * supervised child (nothing restarts it), so it is named apart from the
 * `pianola` supervisor: a policy may allow the watchers and deny the mine.
 */
export const PIANOLA_RELEARN_SERVICE = 'pianola-relearn';

/** The mine's spawn exactly as it will be made, so a managed authority admits what runs. */
interface RelearnMineLaunch extends DispatchSpecLike {
	command: string;
	args: string[];
	cwd: string;
	env: Record<string, string | undefined>;
	shell: false;
}

function buildMineLaunch(cliScriptPath: string): RelearnMineLaunch {
	return {
		command: process.execPath,
		args: [cliScriptPath, 'pianola', 'learn', '--json', '--max-pairs', String(RELEARN_MAX_PAIRS)],
		cwd: process.cwd(),
		env: {
			...process.env,
			// In packaged Electron, process.execPath is the app binary, not
			// Node; without this it would launch the app instead of the CLI.
			ELECTRON_RUN_AS_NODE: '1',
			MAESTRO_CLI_JS: cliScriptPath,
		},
		shell: false,
	};
}

/**
 * Mine the installed CLIs' native transcripts into a decision corpus by spawning
 * the existing `pianola learn --json` crawler (the single source of transcript
 * discovery + parsing) and parsing its `pairs`. Rejects on spawn/exit/parse
 * failure so a failed mine leaves the previously staged suggestions untouched.
 *
 * Under management the mine is admitted first as the `pianola-relearn`
 * service, on the exact launch; anything but `standalone` or `admitted`
 * rejects with the refusal, so nothing is staged from an unadmitted process,
 * and a lease revoked mid-mine stops the crawler and rejects the same way.
 */
export async function mineDecisionPairsViaCli(
	managedPort?: () => SupervisorChildPort | null
): Promise<DecisionPair[]> {
	const launch = buildMineLaunch(resolveMaestroCliScriptPath());
	const port = managedPort?.() ?? null;
	if (!port || port.standing() !== 'managed') return runMine(launch, null);
	let admission: SupervisorChildAdmission;
	try {
		admission = await admitSupervisorChild({
			port,
			service: PIANOLA_RELEARN_SERVICE,
			traceId: 'pianola-relearn',
			spec: launch,
			attribution: { target: { kind: 'local' }, resourceIds: ['pianola-relearn'] },
		});
	} catch (error) {
		// The authority never throws by contract; a port that does is an answer lost.
		throw new Error(
			`[managed-unknown] The managed host's answer was lost: ${error instanceof Error ? error.message : String(error)}. Nothing was mined.`
		);
	}
	if (admission.state === 'standalone') return runMine(launch, null);
	if (admission.state !== 'admitted') {
		throw new Error(`[managed-${admission.state}] ${admission.message}`);
	}
	return runMine(launch, admission.lifetime);
}

/** Make the mine's spawn, driving the lease around the child when one was admitted. */
function runMine(
	launch: RelearnMineLaunch,
	lifetime: SupervisedChildLifetime | null
): Promise<DecisionPair[]> {
	return new Promise<DecisionPair[]>((resolve, reject) => {
		if (lifetime) {
			// The lease sees exactly what spawn sees: nothing runs between the two.
			const verdict = lifetime.admit();
			if (!verdict.ok) {
				reject(new Error(`[managed-${verdict.state}] ${verdict.message}`));
				return;
			}
		}
		let child: ChildProcess;
		try {
			child = spawn(launch.command, launch.args, {
				cwd: launch.cwd,
				env: launch.env,
				stdio: ['ignore', 'pipe', 'pipe'],
			});
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err));
			lifetime?.spawnFailed(error);
			reject(error);
			return;
		}
		lifetime?.spawned(child);
		let released = false;
		let revokedReason: string | null = null;
		const unsubscribe = lifetime?.onRevoked((reason) => {
			if (revokedReason !== null) return;
			revokedReason = reason;
			stopProcess(
				{ child },
				{ from: 'terminate', graceMs: BACKGROUND_STOP_GRACE_MS, label: 'pianola-relearn' }
			);
		});
		let stdout = '';
		let stderr = '';
		child.stdout?.setEncoding('utf8');
		child.stdout?.on('data', (d: string) => {
			stdout += d;
		});
		child.stderr?.setEncoding('utf8');
		child.stderr?.on('data', (d: string) => {
			stderr += d;
		});
		child.on('error', (err) => {
			// A pid-less error is a spawn that never happened (ENOENT); no exit follows it.
			if (!released && child.pid === undefined) {
				released = true;
				unsubscribe?.();
				lifetime?.spawnFailed(err);
			}
			reject(err);
		});
		child.on('exit', (code, signal) => {
			if (!released) {
				released = true;
				unsubscribe?.();
				lifetime?.exited({
					exitCode: code,
					signal,
					stoppedBy: revokedReason !== null ? 'authority' : undefined,
				});
			}
			if (revokedReason !== null) {
				reject(
					new Error(
						`[managed-denied] The managed host revoked the re-learn mine's lease: ${revokedReason}. It was stopped and nothing is staged.`
					)
				);
				return;
			}
			if (code !== 0) {
				reject(new Error(`pianola learn exited ${code ?? 'null'}: ${stderr.trim().slice(0, 200)}`));
				return;
			}
			try {
				const parsed = JSON.parse(stdout) as { pairs?: unknown };
				resolve(Array.isArray(parsed.pairs) ? (parsed.pairs as DecisionPair[]) : []);
			} catch (err) {
				reject(err instanceof Error ? err : new Error(String(err)));
			}
		});
	});
}

/**
 * Read the user's live rules and global decision-profile markdown for the
 * re-learn baseline. A missing or malformed profiles file degrades to an empty
 * baseline (getProfile already returns a well-formed empty result), so the job
 * stages a fresh draft rather than crashing.
 */
export function readExistingForRelearn(): { rules: PianolaRule[]; profile: string } {
	return { rules: readRules(), profile: getProfile().entry?.profile ?? '' };
}

export interface PianolaLifecycleDependencies {
	settingsStore: ReturnType<typeof getSettingsStore>;
	sessionsStore: ReturnType<typeof getSessionsStore>;
	logger: { info: (msg: string, tag: string) => void };
	/**
	 * The host's spawn authority (the enterprise service's), read on every
	 * spawn so an enrollment that appears after construction governs the next
	 * child and the next mine. Absent or null, or a standalone standing: both
	 * spawn as they always did, admitted by nobody.
	 */
	spawnAuthority?: () => ProcessSpawnAuthorityPort | null;
}

export interface PianolaLifecycle {
	supervisor: PianolaSupervisor;
	relearnScheduler: PianolaRelearnScheduler;
}

export function createPianolaLifecycle(deps: PianolaLifecycleDependencies): PianolaLifecycle {
	// Initialize the Pianola supervised daemon. It owns Pianola's background
	// watchers and orchestrations as supervised child processes (restart on
	// crash, relaunch on app start, visible health), replacing the unmanaged
	// nohup model. It is started only while encoreFeatures.pianola is on (the
	// Encore lifecycle in main/index.ts), still self-gates on it, and reconciles
	// from a shared store file that both the CLI and renderer write.
	const supervisor = new PianolaSupervisor({
		getStoredSessions: () => deps.sessionsStore.get('sessions', []),
		isEnabled: () => isEncoreFeatureEnabled(deps.settingsStore, 'pianola'),
		getPianolaAgentId: () => {
			const sessions = deps.sessionsStore.get('sessions', []) as Array<{
				id?: string;
				isPianola?: boolean;
			}>;
			return sessions.find((s) => s?.isPianola === true)?.id;
		},
		managedPort: deps.spawnAuthority,
	});

	// Pianola scheduled re-learn: keeps the learned profile fresh as a PROPOSAL
	// (stages suggestions; never overwrites the live profile/rules) and
	// relaunches stale supervised targets, on a fixed cadence. Armed only while
	// encoreFeatures.pianola is on, and still self-gates per tick on it. Mining
	// reuses the existing `pianola learn` crawler via the bundled CLI; the
	// composition is pure with injected deps.
	const relearnScheduler = new PianolaRelearnScheduler({
		isEnabled: () => isEncoreFeatureEnabled(deps.settingsStore, 'pianola'),
		runJob: async () => {
			await runRelearnJob({
				isEnabled: () => isEncoreFeatureEnabled(deps.settingsStore, 'pianola'),
				mine: () => mineDecisionPairsViaCli(deps.spawnAuthority),
				readExisting: readExistingForRelearn,
				writeSuggestions,
				relaunchStale: () => supervisor?.relaunchStale() ?? 0,
				now: Date.now,
				log: (line) => deps.logger.info(line, '[PianolaRelearn]'),
			});
		},
	});

	return { supervisor, relearnScheduler };
}
