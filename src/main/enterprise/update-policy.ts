/**
 * The update ceiling a managed desktop holds its own roll-forward to
 * (MRC2-05-04). Two sinks move this installation to another version: the
 * GitHub releases checker (`src/main/update-checker.ts`, which decides what
 * the Update modal offers) and electron-updater (`src/main/auto-updater.ts`,
 * which reads the release feed, downloads the installer and installs it on
 * quit). Standalone both do what they always did: the person's "beta updates"
 * setting picks the channel and the newest release is offered. Under
 * management the policy may HOLD updates entirely (nothing is offered,
 * downloaded or installed), fix the CHANNEL (`stable` caps the person's
 * prerelease opt-in; `prerelease` leaves the setting to decide) or PIN a
 * version (the one version this host may roll forward to: a newer one is
 * held, and a host at the pin is kept there). A candidate is held BEFORE a
 * feed is read or a byte is downloaded, a refusal is named by a stable code so
 * it never reads as "up to date" or as a failed check, and a prerelease feed
 * is never consulted under a stable channel. `parseUpdatePolicyCeiling()`
 * validates the closed document; `updateVerdict()` is the pure decision
 * (standalone: allowed, no receipt); `createUpdatePolicySource()` holds the
 * one installed ceiling, in memory only, under the enrollment rule the spawn
 * authority uses, and is what `setUpdateAuthority()` installs on the checker
 * at app-ready. No endpoint operation of this build carries an update ceiling
 * (CP-01), so nothing calls `install()` and an enrolled desktop holds every
 * roll-forward `unavailable` by name.
 */

import type { ManagedPolicyStatus } from '../../shared/maestro-lib/managed/host-adapter';
import {
	browserActorLabel,
	isPlainObject,
	unknownKeys,
	type BrowserEffectActor,
} from './browser-policy';
import type { EgressDenial } from './egress-policy';
import type { EnterpriseIdentityStore } from './identity-store';
import { pairedDeviceActorProblems } from './spawn-authority';

/** `stable`: no prerelease is consulted or offered, whatever the person set; `prerelease`: the person's setting decides. */
export const UPDATE_CHANNELS = ['stable', 'prerelease'] as const;
export type UpdateChannel = (typeof UPDATE_CHANNELS)[number];

/** Who asked for the roll-forward: the browser ceiling's actor model. */
export type UpdateActor = BrowserEffectActor;

/** The desktop's own update check, download and install act as the operator who enabled them. */
export const UPDATE_OPERATOR: UpdateActor = {
	kind: 'transport',
	actor: { peer: 'in-process' },
};

export interface UpdateRequest {
	/** The version this process runs. */
	current: string;
	/** The version about to be offered, downloaded or installed; null asks whether a feed may be consulted at all. */
	candidate: string | null;
	/** Whether the feed or the candidate includes prereleases; derived from the candidate when omitted. */
	prerelease?: boolean;
	/** Absent: the operator. */
	actor?: UpdateActor;
}

export interface UpdatePolicyCeiling {
	policyRevision: number;
	/** True: nothing is offered, downloaded or installed while the ceiling is in force. */
	hold: boolean;
	channel: UpdateChannel;
	/** The one version this host may roll forward to, with or without a leading `v`; null: the newest the channel admits. */
	pin: string | null;
}

export const UPDATE_CEILING_LIMITS = { versionLength: 64 } as const;

const CEILING_KEYS = ['policyRevision', 'hold', 'channel', 'pin'] as const;
const VERSION = /^v?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

export type UpdateCeilingParse =
	| { ok: true; ceiling: UpdatePolicyCeiling }
	| { ok: false; problems: readonly string[] };

/** One release version: `1.2.3`, `v1.2.3` or `1.2.3-rc.1`, nothing else. */
export function isUpdateVersion(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length <= UPDATE_CEILING_LIMITS.versionLength &&
		VERSION.test(value)
	);
}

/** `1.2.3-rc.1` is a prerelease; `1.2.3` is not. The release feed's tag spelling (`v1.2.3-beta`) counts the same. */
export function isPrereleaseVersion(version: string): boolean {
	return version.replace(/^v/, '').includes('-');
}

/** The spelling two versions are compared by: no leading `v`, as `compareVersions()` in `src/shared/pathUtils.ts` does. */
export function normalizeUpdateVersion(version: string): string {
	return version.trim().replace(/^v/, '');
}

/**
 * Validate an update ceiling document. The result is a fresh value the
 * caller's input can no longer reach; every problem is named by its path, and
 * one problem refuses the whole document.
 */
export function parseUpdatePolicyCeiling(raw: unknown): UpdateCeilingParse {
	if (!isPlainObject(raw)) return { ok: false, problems: ['the update ceiling is not an object'] };
	const problems = unknownKeys(raw, CEILING_KEYS, '');
	if (!Number.isSafeInteger(raw.policyRevision) || (raw.policyRevision as number) < 0)
		problems.push('policyRevision is not a policy revision');
	if (typeof raw.hold !== 'boolean') problems.push('hold is not a boolean');
	if (!(UPDATE_CHANNELS as readonly unknown[]).includes(raw.channel))
		problems.push('channel is not an update channel');
	if (raw.pin !== null && !isUpdateVersion(raw.pin))
		problems.push('pin is not a release version or null');
	if (problems.length > 0) return { ok: false, problems };
	return {
		ok: true,
		ceiling: {
			policyRevision: raw.policyRevision as number,
			hold: raw.hold as boolean,
			channel: raw.channel as UpdateChannel,
			pin: raw.pin as string | null,
		},
	};
}

export type ManagedUpdateStanding =
	| { standing: 'standalone' }
	| { standing: 'managed'; ceiling: UpdatePolicyCeiling; policyRevision: number }
	| { standing: 'managed'; ceiling: null; policyRevision: number | null; reason: string };

/** The standing the sinks hold against: the rule of `managedEgressStanding`, for the update ceiling. */
export function managedUpdateStanding(input: {
	enrolled: boolean;
	policy: Pick<ManagedPolicyStatus, 'appliedRevision'> | null;
	ceiling: UpdatePolicyCeiling | null;
}): ManagedUpdateStanding {
	if (!input.enrolled) return { standing: 'standalone' };
	const revision = input.policy?.appliedRevision ?? null;
	const reason =
		revision === null
			? 'no applied policy revision is known for this host'
			: !input.ceiling
				? `no update ceiling is installed for policy revision ${revision}`
				: input.ceiling.policyRevision !== revision
					? `the installed update ceiling is for policy revision ${input.ceiling.policyRevision}; this host is under revision ${revision}`
					: null;
	if (reason !== null || !input.ceiling || revision === null)
		return { standing: 'managed', ceiling: null, policyRevision: revision, reason: reason ?? '' };
	return { standing: 'managed', ceiling: input.ceiling, policyRevision: revision };
}

export type UpdateDenial =
	| 'unavailable'
	| 'unauthenticated'
	| 'held'
	| 'channel-denied'
	| 'pin-denied';

export interface UpdateReceipt {
	policyRevision: number | null;
	current: string;
	candidate: string | null;
	actor: string;
	outcome: 'within-ceiling' | UpdateDenial;
}

export type UpdateDecision =
	| { allowed: true; managed?: UpdateReceipt }
	| { allowed: false; code: UpdateDenial; message: string; managed: UpdateReceipt };

/**
 * What a sink carries in place of an update: the code, the sentence, the
 * revision and what was held. The code is the update ceiling's, or the egress
 * ceiling's when the feed itself was refused as an `updates` request.
 */
export interface UpdateHold {
	code: UpdateDenial | EgressDenial;
	message: string;
	policyRevision: number | null;
	candidate: string | null;
}

/** The one line a refusal is reported as, so a held update never reads as "up to date" or a failed check. */
export function formatUpdateRefusal(decision: { code: string; message: string }): string {
	return `[managed-${decision.code}] ${decision.message}`;
}

/**
 * Hold one roll-forward against the standing. Pure: `unbindable` is what the
 * caller knows about the actor (a paired device before an actor is
 * registered). A hold answers before anything else; a stable channel refuses a
 * prerelease feed or candidate; a pin admits exactly the pinned version.
 */
export function updateVerdict(
	standing: ManagedUpdateStanding,
	request: UpdateRequest,
	unbindable: readonly string[] = []
): UpdateDecision {
	if (standing.standing === 'standalone') return { allowed: true };
	const actor = request.actor ?? UPDATE_OPERATOR;
	const [, label] = browserActorLabel(actor);
	const { candidate } = request;
	const receipt = (outcome: UpdateReceipt['outcome']): UpdateReceipt => ({
		policyRevision: standing.policyRevision,
		current: request.current,
		candidate,
		actor: label,
		outcome,
	});
	const deny = (code: UpdateDenial, message: string): UpdateDecision => ({
		allowed: false,
		code,
		message,
		managed: receipt(code),
	});
	if (unbindable.length > 0) return deny('unauthenticated', unbindable.join('; '));
	if (!standing.ceiling)
		return deny('unavailable', `the managed update ceiling is unavailable (${standing.reason})`);
	const { ceiling } = standing;
	const what = candidate ? `an update to ${candidate}` : 'the release feed';
	if (ceiling.hold)
		return deny(
			'held',
			`the update ceiling holds updates for ${label}; ${what} is not offered, downloaded or installed while the hold is in force`
		);
	const prerelease = request.prerelease ?? (candidate !== null && isPrereleaseVersion(candidate));
	if (ceiling.channel === 'stable' && prerelease)
		return deny(
			'channel-denied',
			candidate
				? `${candidate} is a prerelease and the update ceiling fixes ${label} to the stable channel; only a stable release is offered`
				: `the update ceiling fixes ${label} to the stable channel; no prerelease feed is consulted`
		);
	if (
		candidate !== null &&
		ceiling.pin !== null &&
		normalizeUpdateVersion(candidate) !== normalizeUpdateVersion(ceiling.pin)
	)
		return deny(
			'pin-denied',
			`the update ceiling pins ${label} to ${ceiling.pin}; ${candidate} is not offered, downloaded or installed`
		);
	return { allowed: true, managed: receipt('within-ceiling') };
}

export type UpdateCeilingInstallOutcome =
	| { installed: true; policyRevision: number }
	| { installed: false; problems: readonly string[] };

export interface UpdatePolicySourceDeps {
	identity: Pick<EnterpriseIdentityStore, 'read'>;
	policy(): Pick<ManagedPolicyStatus, 'appliedRevision'> | null;
}

/** What the sinks hold a roll-forward with: the source, or a test double. */
export interface UpdateAuthority {
	evaluateUpdate(request: UpdateRequest): UpdateDecision;
}

export interface UpdatePolicySource extends UpdateAuthority {
	standing(): ManagedUpdateStanding;
	installed(): UpdatePolicyCeiling | null;
	/** Install a ceiling an authenticated endpoint path handed over; a refused document keeps the previous one. */
	install(raw: unknown): UpdateCeilingInstallOutcome;
	clear(): void;
}

export function createUpdatePolicySource(deps: UpdatePolicySourceDeps): UpdatePolicySource {
	let installed: UpdatePolicyCeiling | null = null;
	const standing = (read = deps.identity.read()) =>
		managedUpdateStanding({
			enrolled: read.status !== 'none',
			policy: deps.policy(),
			ceiling: installed,
		});
	return {
		standing: () => standing(),
		installed: () => installed,
		install(raw) {
			const parsed = parseUpdatePolicyCeiling(raw);
			if (!parsed.ok) return { installed: false, problems: parsed.problems };
			installed = parsed.ceiling;
			return { installed: true, policyRevision: parsed.ceiling.policyRevision };
		},
		clear() {
			installed = null;
		},
		evaluateUpdate(request) {
			const read = deps.identity.read();
			const actor = request.actor ?? UPDATE_OPERATOR;
			const unbindable =
				actor.kind === 'transport' ? pairedDeviceActorProblems(actor.actor, read) : [];
			return updateVerdict(standing(read), request, unbindable);
		},
	};
}
