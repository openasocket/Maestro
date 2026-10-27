/**
 * The shell ceiling a managed desktop holds user-configured shell commands to
 * (MRC2-04-06). One sink reaches it today: the notification command runner
 * (`src/main/ipc/handlers/notifications.ts`), which runs the person's
 * `audioFeedbackCommand` and `idleNotificationCommand` settings through a
 * shell (`shell: true`, so pipes and chains work), with the summary on stdin
 * and the Maestro context in `MAESTRO_NOTIFY_*` variables. Standalone, any
 * command the person configures runs, as it always has. Under management the
 * EXACT command string is held against the signed ceiling of the policy
 * revision the host is under: the ceiling allowlists command strings per
 * surface, a string that is not listed character for character never spawns,
 * and the refusal is named by code so it can never read as a command that
 * failed. No pattern, prefix or argument matching exists on purpose: a shell
 * command line is a program, and the only thing a policy can vouch for is the
 * one it read. `parseShellPolicyCeiling()` validates a document against a
 * closed, bounded schema; `shellCommandVerdict()` is the pure decision
 * (standalone: allowed, no receipt); `createShellPolicySource()` holds the one
 * installed ceiling, in memory only, under the enrollment rule the spawn
 * authority uses. No endpoint operation of this build carries a shell ceiling
 * (CP-01), so nothing calls `install()` and an enrolled desktop refuses every
 * configured command `unavailable` by name. The two settings are marked
 * `lockable` in `src/shared/settingsMetadataConnectivity.ts` so the settings
 * lock model (P2-06) can pin them to the strings the ceiling admits.
 */

import type { ManagedPolicyStatus } from '../../shared/maestro-lib/managed/host-adapter';
import {
	browserActorLabel,
	isPlainObject,
	parseStringList,
	unknownKeys,
	type BrowserEffectActor,
} from './browser-policy';
import type { EnterpriseIdentityStore } from './identity-store';
import { pairedDeviceActorProblems } from './spawn-authority';

/** Where a configured shell command runs from. `notification`: the audio feedback and idle commands. */
export const SHELL_SURFACES = ['notification'] as const;
export type ShellSurface = (typeof SHELL_SURFACES)[number];

/** Who asked for the command to run: the browser ceiling's actor model (which transport, or which agent). */
export type ShellCommandActor = BrowserEffectActor;

export interface ShellCommandRequest {
	surface: ShellSurface;
	/** The exact command line the sink is about to hand to the shell, after its own trim. */
	command: string;
	actor: ShellCommandActor;
}

export interface ShellCeilingSurface {
	surface: ShellSurface;
	/** Exact command strings; nothing else runs on this surface. Empty admits none. */
	commands: string[];
}

export interface ShellPolicyCeiling {
	policyRevision: number;
	/** A surface absent here runs no configured command at all. */
	surfaces: ShellCeilingSurface[];
}

export const SHELL_CEILING_LIMITS = { commands: 64, commandLength: 4096 } as const;

const CEILING_KEYS = ['policyRevision', 'surfaces'] as const;
const SURFACE_KEYS = ['surface', 'commands'] as const;

export type ShellCeilingParse =
	| { ok: true; ceiling: ShellPolicyCeiling }
	| { ok: false; problems: readonly string[] };

/**
 * An allowlisted command is a single line, already trimmed, with no control
 * character: what a sink compares against is what the policy author read.
 */
export function isShellCommandString(command: string): boolean {
	return (
		command.length > 0 &&
		command.length <= SHELL_CEILING_LIMITS.commandLength &&
		command === command.trim() &&
		!/[\u0000-\u001f\u007f]/.test(command)
	);
}

function parseSurface(raw: unknown, at: string, problems: string[]): ShellCeilingSurface | null {
	if (!isPlainObject(raw)) {
		problems.push(`${at} is not an object`);
		return null;
	}
	problems.push(...unknownKeys(raw, SURFACE_KEYS, `${at}.`));
	const before = problems.length;
	if (!(SHELL_SURFACES as readonly unknown[]).includes(raw.surface))
		problems.push(`${at}.surface is not a shell surface`);
	const commands = parseStringList(
		raw.commands,
		`${at}.commands`,
		SHELL_CEILING_LIMITS.commands,
		'an exact single-line command string',
		isShellCommandString,
		problems
	);
	if (problems.length !== before || !commands) return null;
	return { surface: raw.surface as ShellSurface, commands };
}

/**
 * Validate a shell ceiling document. The result is a fresh value the caller's
 * input can no longer reach; every problem is named by its path, and one
 * problem refuses the whole document.
 */
export function parseShellPolicyCeiling(raw: unknown): ShellCeilingParse {
	if (!isPlainObject(raw)) return { ok: false, problems: ['the shell ceiling is not an object'] };
	const problems = unknownKeys(raw, CEILING_KEYS, '');
	if (!Number.isSafeInteger(raw.policyRevision) || (raw.policyRevision as number) < 0)
		problems.push('policyRevision is not a policy revision');
	const surfaces: ShellCeilingSurface[] = [];
	if (!Array.isArray(raw.surfaces)) problems.push('surfaces is not an array');
	else if (raw.surfaces.length > SHELL_SURFACES.length)
		problems.push(`surfaces exceeds ${SHELL_SURFACES.length} entries`);
	else
		raw.surfaces.forEach((entry, index) => {
			const parsed = parseSurface(entry, `surfaces[${index}]`, problems);
			if (parsed && surfaces.some((seen) => seen.surface === parsed.surface))
				problems.push(`surfaces[${index}].surface "${parsed.surface}" is named twice`);
			else if (parsed) surfaces.push(parsed);
		});
	if (problems.length > 0) return { ok: false, problems };
	return { ok: true, ceiling: { policyRevision: raw.policyRevision as number, surfaces } };
}

export type ManagedShellStanding =
	| { standing: 'standalone' }
	| { standing: 'managed'; ceiling: ShellPolicyCeiling; policyRevision: number }
	| { standing: 'managed'; ceiling: null; policyRevision: number | null; reason: string };

/** The standing the sink holds against: the rule of `managedBrowserStanding`, for the shell ceiling. */
export function managedShellStanding(input: {
	enrolled: boolean;
	policy: Pick<ManagedPolicyStatus, 'appliedRevision'> | null;
	ceiling: ShellPolicyCeiling | null;
}): ManagedShellStanding {
	if (!input.enrolled) return { standing: 'standalone' };
	const revision = input.policy?.appliedRevision ?? null;
	const reason =
		revision === null
			? 'no applied policy revision is known for this host'
			: !input.ceiling
				? `no shell ceiling is installed for policy revision ${revision}`
				: input.ceiling.policyRevision !== revision
					? `the installed shell ceiling is for policy revision ${input.ceiling.policyRevision}; this host is under revision ${revision}`
					: null;
	if (reason !== null || !input.ceiling || revision === null)
		return { standing: 'managed', ceiling: null, policyRevision: revision, reason: reason ?? '' };
	return { standing: 'managed', ceiling: input.ceiling, policyRevision: revision };
}

export type ShellCommandDenial = 'unavailable' | 'unauthenticated' | 'outside-ceiling';

export interface ShellCommandReceipt {
	policyRevision: number | null;
	surface: ShellSurface;
	actor: string;
	/** The exact string held; what the person configured, never a secret the host holds. */
	command: string;
	outcome: 'within-ceiling' | ShellCommandDenial;
}

export type ShellCommandDecision =
	| { allowed: true; managed?: ShellCommandReceipt }
	| { allowed: false; code: ShellCommandDenial; message: string; managed: ShellCommandReceipt };

/**
 * Hold one configured command against the standing. Pure: `unbindable` is
 * what the caller knows about the actor (a paired device before an actor is
 * registered). The comparison is exact: the ceiling's string and the sink's
 * trimmed command line are the same characters, or the command never runs.
 */
export function shellCommandVerdict(
	standing: ManagedShellStanding,
	request: ShellCommandRequest,
	unbindable: readonly string[] = []
): ShellCommandDecision {
	if (standing.standing === 'standalone') return { allowed: true };
	const [, label] = browserActorLabel(request.actor);
	const receipt = (outcome: ShellCommandReceipt['outcome']): ShellCommandReceipt => ({
		policyRevision: standing.policyRevision,
		surface: request.surface,
		actor: label,
		command: request.command,
		outcome,
	});
	const deny = (code: ShellCommandDenial, message: string): ShellCommandDecision => ({
		allowed: false,
		code,
		message,
		managed: receipt(code),
	});
	if (unbindable.length > 0) return deny('unauthenticated', unbindable.join('; '));
	if (!standing.ceiling)
		return deny('unavailable', `the managed shell ceiling is unavailable (${standing.reason})`);
	const entry = standing.ceiling.surfaces.find(
		(candidate) => candidate.surface === request.surface
	);
	if (!entry)
		return deny(
			'outside-ceiling',
			`the shell ceiling admits no ${request.surface} command for ${label}; a configured command runs only when the policy lists it exactly`
		);
	if (!entry.commands.includes(request.command))
		return deny(
			'outside-ceiling',
			`the shell ceiling does not list the configured ${request.surface} command "${request.command}" for ${label}; only a command string the policy lists exactly runs`
		);
	return { allowed: true, managed: receipt('within-ceiling') };
}

export type ShellCeilingInstallOutcome =
	| { installed: true; policyRevision: number }
	| { installed: false; problems: readonly string[] };

export interface ShellPolicySourceDeps {
	identity: Pick<EnterpriseIdentityStore, 'read'>;
	policy(): Pick<ManagedPolicyStatus, 'appliedRevision'> | null;
}

/** What a sink holds a command with: the source, or a test double. */
export interface ShellCommandAuthority {
	authorize(request: ShellCommandRequest): ShellCommandDecision;
}

export interface ShellPolicySource extends ShellCommandAuthority {
	standing(): ManagedShellStanding;
	installed(): ShellPolicyCeiling | null;
	/** Install a ceiling an authenticated endpoint path handed over; a refused document keeps the previous one. */
	install(raw: unknown): ShellCeilingInstallOutcome;
	clear(): void;
}

export function createShellPolicySource(deps: ShellPolicySourceDeps): ShellPolicySource {
	let installed: ShellPolicyCeiling | null = null;
	const standing = (read = deps.identity.read()) =>
		managedShellStanding({
			enrolled: read.status !== 'none',
			policy: deps.policy(),
			ceiling: installed,
		});
	return {
		standing: () => standing(),
		installed: () => installed,
		install(raw) {
			const parsed = parseShellPolicyCeiling(raw);
			if (!parsed.ok) return { installed: false, problems: parsed.problems };
			installed = parsed.ceiling;
			return { installed: true, policyRevision: parsed.ceiling.policyRevision };
		},
		clear() {
			installed = null;
		},
		authorize(request) {
			const read = deps.identity.read();
			const unbindable =
				request.actor.kind === 'transport'
					? pairedDeviceActorProblems(request.actor.actor, read)
					: [];
			return shellCommandVerdict(standing(read), request, unbindable);
		},
	};
}
