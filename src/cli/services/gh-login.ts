/**
 * Run the GitHub CLI login for `maestro-cli feedback login`, attached to the
 * caller's terminal. Its own module so tests can stand in for the process.
 *
 * Under management the login never starts here (MRC2-04-05): a bare CLI on an
 * enrolled installation holds no attached host authority, so it cannot hold
 * the login to any ceiling, and a sign-in it cannot hold is refused by name
 * rather than run unmanaged. The desktop's own "Log in to GitHub" runs gh in
 * a terminal tab the process manager admits, so it is held there.
 */

import { spawn } from 'child_process';
import type { FeedbackGhLoginCommand } from '../../shared/feedback';
import type { HeadlessSpawnAuthority } from '../../shared/maestro-lib/managed/host-adapter';
import { cliSpawnAuthority } from './agent-spawner';

/** The managed standing refused the login before any process started. */
export class GhLoginRefusedError extends Error {
	readonly refused = true as const;
	constructor(message: string) {
		super(message);
		this.name = 'GhLoginRefusedError';
	}
}

/** What the login is held against: the CLI's own binding, or a test double. */
export type GhLoginManagedStanding = Pick<HeadlessSpawnAuthority, 'standing' | 'unavailableReason'>;

/**
 * Run the gh login with this terminal attached, resolving to its exit code.
 * `keepStdoutClean` routes gh's stdout to stderr, so a `--json` caller's stdout
 * carries only the result. A managed standing rejects with
 * `GhLoginRefusedError` and spawns nothing.
 */
export function runGhLogin(
	login: FeedbackGhLoginCommand,
	keepStdoutClean = false,
	managed: GhLoginManagedStanding = cliSpawnAuthority()
): Promise<number> {
	if (managed.standing() === 'managed') {
		const reason =
			managed.unavailableReason ??
			'this process holds no authority that could hold the login to a ceiling.';
		return Promise.reject(
			new GhLoginRefusedError(
				`[managed-unavailable] under management maestro-cli cannot sign the GitHub CLI in from this terminal: ${reason} Nothing was run; sign in from the desktop's Feedback modal instead.`
			)
		);
	}
	return new Promise((resolve, reject) => {
		const child = spawn(login.command, login.args, {
			stdio: keepStdoutClean ? ['inherit', 2, 'inherit'] : 'inherit',
		});
		child.on('error', reject);
		child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
	});
}
