/**
 * The local-effects ceiling a managed desktop holds its own hand-offs to the OS
 * to (MRC2-04-09), in two classes: `data-transfer` (a URL to the browser, a path
 * to its default application, a clipboard write) and `destructive` (a trash, a
 * delete in place). Standalone runs every one of them as it always has. Under
 * management each class carries ONE verdict in the signed ceiling of the host's
 * policy revision: `allow` runs with a receipt, `deny` refuses by name before
 * any Electron or `fs` call, `confirm` asks the operator through a confirmer the
 * composition injects (none: `confirm-unavailable`); an unnamed class is
 * `outside-ceiling`. A receipt keeps a URL's origin or a path, never clipboard
 * content. No endpoint operation installs one yet (CP-01): an enrolled desktop
 * refuses every effect `unavailable` by name.
 */

import type { ManagedPolicyStatus } from '../../shared/maestro-lib/managed/host-adapter';
import { logger } from '../utils/logger';
import { getActingTransport, transportSpawnActor } from '../web-server/auth/transport-actor';
import {
	browserActorLabel,
	browserDestinationOrigin,
	isPlainObject,
	unknownKeys,
	type BrowserEffectActor,
} from './browser-policy';
import type { EnterpriseIdentityStore } from './identity-store';
import { pairedDeviceActorProblems } from './spawn-authority';

export const LOCAL_EFFECT_CLASSES = ['data-transfer', 'destructive'] as const;
export type LocalEffectClass = (typeof LOCAL_EFFECT_CLASSES)[number];

/** The effects the sinks hold, each in exactly one class. */
export const LOCAL_EFFECT_CLASS_OF = {
	'open-external': 'data-transfer',
	'open-path': 'data-transfer',
	'clipboard-write': 'data-transfer',
	trash: 'destructive',
	delete: 'destructive',
} as const satisfies Record<string, LocalEffectClass>;
export type LocalEffectKind = keyof typeof LOCAL_EFFECT_CLASS_OF;
export const LOCAL_EFFECTS = Object.keys(LOCAL_EFFECT_CLASS_OF) as readonly LocalEffectKind[];

export const LOCAL_EFFECT_VERDICTS = ['allow', 'deny', 'confirm'] as const;
export type LocalEffectCeilingVerdict = (typeof LOCAL_EFFECT_VERDICTS)[number];

/**
 * Who asks for an effect: the transport an IPC call was admitted over, the
 * agent session a bridge handshake bound, or a plugin whose brokered host
 * call reaches the OS through the plugin host (MRC2-04-10), named as itself.
 */
export type LocalEffectActor = BrowserEffectActor | { kind: 'plugin'; pluginId: string };

/** The label a receipt and a message name the actor by. */
export function localEffectActorLabel(actor: LocalEffectActor): string {
	if (actor.kind === 'plugin') return `plugin "${actor.pluginId}"`;
	return browserActorLabel(actor)[1];
}

/** The transport the current IPC call was admitted over; a sink reads it before any await so the hold binds that actor. */
export function callingLocalEffectActor(): BrowserEffectActor {
	return { kind: 'transport', actor: transportSpawnActor(getActingTransport()) };
}

export interface LocalEffectRequest {
	effect: LocalEffectKind;
	actor: LocalEffectActor;
	/** The full URL, the absolute path, or null for the clipboard; a batch names its first path. */
	target: string | null;
	/** How many items one hold covers (a `fs:deleteMany` batch); 1 when omitted. */
	count?: number;
}

export interface LocalEffectsPolicyCeiling {
	policyRevision: number;
	/** A class absent here is refused: the policy vouched for no verdict on it. */
	classes: { class: LocalEffectClass; verdict: LocalEffectCeilingVerdict }[];
}

const CEILING_KEYS = ['policyRevision', 'classes'] as const;
const CLASS_KEYS = ['class', 'verdict'] as const;

export type LocalEffectsCeilingParse =
	| { ok: true; ceiling: LocalEffectsPolicyCeiling }
	| { ok: false; problems: readonly string[] };

/** Validate a ceiling document: a fresh value, every problem named by its path, one problem refusing it all. */
export function parseLocalEffectsPolicyCeiling(raw: unknown): LocalEffectsCeilingParse {
	if (!isPlainObject(raw))
		return { ok: false, problems: ['the local-effects ceiling is not an object'] };
	const problems = unknownKeys(raw, CEILING_KEYS, '');
	if (!Number.isSafeInteger(raw.policyRevision) || (raw.policyRevision as number) < 0)
		problems.push('policyRevision is not a policy revision');
	const classes: LocalEffectsPolicyCeiling['classes'] = [];
	if (!Array.isArray(raw.classes)) problems.push('classes is not an array');
	else if (raw.classes.length > LOCAL_EFFECT_CLASSES.length)
		problems.push(`classes exceeds ${LOCAL_EFFECT_CLASSES.length} entries`);
	else
		raw.classes.forEach((entry, index) => {
			const at = `classes[${index}]`;
			if (!isPlainObject(entry)) return problems.push(`${at} is not an object`);
			const before = problems.push(...unknownKeys(entry, CLASS_KEYS, `${at}.`));
			if (!(LOCAL_EFFECT_CLASSES as readonly unknown[]).includes(entry.class))
				problems.push(`${at}.class is not a local-effect class`);
			if (!(LOCAL_EFFECT_VERDICTS as readonly unknown[]).includes(entry.verdict))
				problems.push(`${at}.verdict is not allow, deny or confirm`);
			if (problems.length !== before) return;
			if (classes.some((seen) => seen.class === entry.class))
				problems.push(`${at}.class "${entry.class}" is named twice`);
			else
				classes.push({
					class: entry.class as LocalEffectClass,
					verdict: entry.verdict as LocalEffectCeilingVerdict,
				});
		});
	if (problems.length > 0) return { ok: false, problems };
	return { ok: true, ceiling: { policyRevision: raw.policyRevision as number, classes } };
}

export type ManagedLocalEffectsStanding =
	| { standing: 'standalone' }
	| { standing: 'managed'; ceiling: LocalEffectsPolicyCeiling; policyRevision: number }
	| { standing: 'managed'; ceiling: null; policyRevision: number | null; reason: string };

/** The standing the sinks hold against: the rule of `managedBrowserStanding`, for this ceiling. */
export function managedLocalEffectsStanding(input: {
	enrolled: boolean;
	policy: Pick<ManagedPolicyStatus, 'appliedRevision'> | null;
	ceiling: LocalEffectsPolicyCeiling | null;
}): ManagedLocalEffectsStanding {
	if (!input.enrolled) return { standing: 'standalone' };
	const revision = input.policy?.appliedRevision ?? null;
	const reason =
		revision === null
			? 'no applied policy revision is known for this host'
			: !input.ceiling
				? `no local-effects ceiling is installed for policy revision ${revision}`
				: input.ceiling.policyRevision !== revision
					? `the installed local-effects ceiling is for policy revision ${input.ceiling.policyRevision}; this host is under revision ${revision}`
					: null;
	if (reason !== null || !input.ceiling || revision === null)
		return { standing: 'managed', ceiling: null, policyRevision: revision, reason: reason ?? '' };
	return { standing: 'managed', ceiling: input.ceiling, policyRevision: revision };
}

export type LocalEffectDenial =
	| 'unavailable'
	| 'unauthenticated'
	| 'outside-ceiling'
	| 'denied'
	| 'confirm-unavailable'
	| 'declined';

export interface LocalEffectReceipt {
	policyRevision: number | null;
	class: LocalEffectClass;
	effect: LocalEffectKind;
	actor: string;
	/** A URL's origin or a path; never clipboard content. */
	target: string | null;
	count: number;
	outcome: 'within-ceiling' | 'confirmed' | LocalEffectDenial;
}

/** The pure three-way answer, before any confirmation is sought. */
export type LocalEffectVerdict =
	| { verdict: 'allow'; managed?: LocalEffectReceipt }
	| { verdict: 'deny'; code: LocalEffectDenial; message: string; managed: LocalEffectReceipt }
	| { verdict: 'confirm'; message: string; managed: LocalEffectReceipt };

export type LocalEffectDecision =
	| { allowed: true; managed?: LocalEffectReceipt }
	| { allowed: false; code: LocalEffectDenial; message: string; managed: LocalEffectReceipt };

export function describeLocalEffect(
	request: Pick<LocalEffectRequest, 'effect' | 'target' | 'count'>
): string {
	const count = request.count ?? 1;
	const many = count > 1 ? ` (${count} items, the first ${request.target ?? 'unnamed'})` : '';
	const item = count > 1 ? 'items' : (request.target ?? 'an item');
	switch (request.effect) {
		case 'open-external':
			return `opening ${request.target ?? 'a URL'} outside Maestro`;
		case 'open-path':
			return `opening ${request.target ?? 'a path'} in its default application`;
		case 'clipboard-write':
			return 'writing to the system clipboard';
		case 'trash':
			return `moving ${item} to the trash${many}`;
		case 'delete':
			return `deleting ${item}${many}`;
	}
}

/**
 * Hold one effect against the standing. Pure: `unbindable` is what the caller knows
 * about the actor. The class is derived from the effect, so a sink cannot misfile a delete.
 */
export function localEffectVerdict(
	standing: ManagedLocalEffectsStanding,
	request: LocalEffectRequest,
	unbindable: readonly string[] = []
): LocalEffectVerdict {
	if (standing.standing === 'standalone') return { verdict: 'allow' };
	const label = localEffectActorLabel(request.actor);
	const effectClass = LOCAL_EFFECT_CLASS_OF[request.effect];
	const receipt = (outcome: LocalEffectReceipt['outcome']): LocalEffectReceipt => ({
		policyRevision: standing.policyRevision,
		class: effectClass,
		effect: request.effect,
		actor: label,
		target:
			request.effect === 'clipboard-write'
				? null
				: request.effect === 'open-external'
					? browserDestinationOrigin(request.target)
					: request.target,
		count: request.count ?? 1,
		outcome,
	});
	const deny = (code: LocalEffectDenial, message: string): LocalEffectVerdict => ({
		verdict: 'deny',
		code,
		message,
		managed: receipt(code),
	});
	const what = `${describeLocalEffect(request)} for ${label} is refused`;
	if (unbindable.length > 0) return deny('unauthenticated', unbindable.join('; '));
	if (!standing.ceiling)
		return deny(
			'unavailable',
			`the managed local-effects ceiling is unavailable (${standing.reason}); ${what}`
		);
	const entry = standing.ceiling.classes.find((candidate) => candidate.class === effectClass);
	if (!entry)
		return deny(
			'outside-ceiling',
			`the local-effects ceiling names no verdict for the ${effectClass} class; ${what}`
		);
	if (entry.verdict === 'deny')
		return deny('denied', `the local-effects ceiling denies the ${effectClass} class; ${what}`);
	if (entry.verdict === 'confirm')
		return {
			verdict: 'confirm',
			message: `the local-effects ceiling requires the operator's confirmation for the ${effectClass} class before ${describeLocalEffect(request)} (asked by ${label})`,
			managed: receipt('within-ceiling'),
		};
	return { verdict: 'allow', managed: receipt('within-ceiling') };
}

/** Thrown by a sink whose contract has no result to answer a refusal in (the IPC handlers reject). */
export class LocalEffectRefusedError extends Error {
	readonly code: LocalEffectDenial;
	readonly receipt: LocalEffectReceipt;
	constructor(decision: Extract<LocalEffectDecision, { allowed: false }>) {
		super(`[managed-${decision.code}] ${decision.message}`);
		this.name = 'LocalEffectRefusedError';
		this.code = decision.code;
		this.receipt = decision.managed;
	}
}

/** The operator's answer to a `confirm`; `unavailable` when there is no one to ask (no window). */
export type LocalEffectConfirmation = 'confirmed' | 'declined' | 'unavailable';

/** What the operator is shown: the full target (a URL, a path), who asked, and the verdict's message. */
export type LocalEffectConfirmPrompt = Pick<
	LocalEffectReceipt,
	'effect' | 'class' | 'count' | 'actor'
> & { target: string | null; message: string };

/** Puts a `confirm` verdict to the operator at the desktop; injected by the composition. */
export type LocalEffectConfirmer = (
	prompt: LocalEffectConfirmPrompt
) => Promise<LocalEffectConfirmation>;

/** Resolve a verdict into a decision: a `confirm` is put to the confirmer, or refused when there is none. */
export async function resolveLocalEffectVerdict(
	verdict: LocalEffectVerdict,
	request: LocalEffectRequest,
	confirm: LocalEffectConfirmer | null
): Promise<LocalEffectDecision> {
	if (verdict.verdict === 'allow')
		return verdict.managed ? { allowed: true, managed: verdict.managed } : { allowed: true };
	if (verdict.verdict === 'deny') {
		const { code, message, managed } = verdict;
		return { allowed: false, code, message, managed };
	}
	const what = describeLocalEffect(request);
	const ask = `the local-effects ceiling requires the operator's confirmation for ${what}, and`;
	const refuse = (code: LocalEffectDenial, message: string): LocalEffectDecision => ({
		allowed: false,
		code,
		message,
		managed: { ...verdict.managed, outcome: code },
	});
	if (!confirm) return refuse('confirm-unavailable', `${ask} this host has no way to ask`);
	const answer = await confirm({
		effect: request.effect,
		class: verdict.managed.class,
		target: request.target,
		count: request.count ?? 1,
		actor: verdict.managed.actor,
		message: verdict.message,
	});
	if (answer === 'confirmed')
		return { allowed: true, managed: { ...verdict.managed, outcome: 'confirmed' } };
	if (answer === 'declined') return refuse('declined', `the operator declined ${what}`);
	return refuse(
		'confirm-unavailable',
		`${ask} no one could be asked (no window to show the prompt in)`
	);
}

export interface LocalEffectsPolicySourceDeps {
	identity: Pick<EnterpriseIdentityStore, 'read'>;
	policy(): Pick<ManagedPolicyStatus, 'appliedRevision'> | null;
	/** How a `confirm` verdict reaches the operator; absent refuses `confirm-unavailable`. */
	confirm?: LocalEffectConfirmer | null;
}

/** What a sink holds an effect with: the source, or a test double. */
export interface LocalEffectAuthority {
	authorize(request: LocalEffectRequest): Promise<LocalEffectDecision>;
}

export interface LocalEffectsPolicySource extends LocalEffectAuthority {
	standing(): ManagedLocalEffectsStanding;
	installed(): LocalEffectsPolicyCeiling | null;
	/** Install a ceiling an authenticated endpoint path handed over; a refused document keeps the previous one. */
	install(
		raw: unknown
	):
		| { installed: true; policyRevision: number }
		| { installed: false; problems: readonly string[] };
	clear(): void;
}

export function createLocalEffectsPolicySource(
	deps: LocalEffectsPolicySourceDeps
): LocalEffectsPolicySource {
	let installed: LocalEffectsPolicyCeiling | null = null;
	const standing = (read = deps.identity.read()) =>
		managedLocalEffectsStanding({
			enrolled: read.status !== 'none',
			policy: deps.policy(),
			ceiling: installed,
		});
	return {
		standing: () => standing(),
		installed: () => installed,
		install(raw) {
			const parsed = parseLocalEffectsPolicyCeiling(raw);
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
			return resolveLocalEffectVerdict(
				localEffectVerdict(standing(read), request, unbindable),
				request,
				deps.confirm ?? null
			);
		},
	};
}

/** The one call a sink makes right before its effect; no authority (tests, a bare host) holds nothing. */
export async function holdLocalEffect(
	authority: LocalEffectAuthority | null | undefined,
	request: LocalEffectRequest
): Promise<LocalEffectDecision> {
	if (!authority) return { allowed: true };
	return authority.authorize(request);
}

/**
 * Hold a delete of one path, or of a batch held ONCE with its count, before
 * anything is removed, locally or on a remote. Shared by every delete sink
 * (`fs:delete`, the Auto Run images, backups and folder, the playbooks file,
 * a Cue backup): a refusal leaves every path in place, reaches the log with
 * its receipt under the sink's own context, and throws by code.
 */
export async function holdDeleteEffect(
	authority: LocalEffectAuthority | null | undefined,
	targetPaths: readonly string[],
	actor: LocalEffectActor,
	logContext: string
): Promise<void> {
	const decision = await holdLocalEffect(authority, {
		effect: 'delete',
		actor,
		target: targetPaths[0] ?? null,
		count: targetPaths.length,
	});
	if (decision.allowed) return;
	logger.warn(
		'Delete refused by the managed local-effects ceiling; nothing was removed',
		logContext,
		{ code: decision.code, receipt: decision.managed }
	);
	throw new LocalEffectRefusedError(decision);
}
