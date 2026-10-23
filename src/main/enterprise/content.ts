/**
 * Content capture under the signed collection policy (MRC-10-05): what a
 * managed desktop may keep of the content a provider showed, and the exact
 * record of what it kept. Three decisions, each a named refusal first. The
 * PROFILE is the endpoint's word (its attachment answer; the record keeps
 * none, so a detached host collects nothing, and under `metadata` no byte,
 * hash or reference is kept). The ROLES are separate permissions: prompt,
 * answer, tool input, tool output and VIBES evidence are different content
 * classes, each granted by name in the signed ceiling with the sibling
 * `contentPermissions` and a sensitivity; hidden reasoning is NOT a role (the
 * parsers surface none and nothing here promises it) and the private
 * per-agent recording (`src/main/cot-export/`) is neither a source nor a
 * configuration read here. The REPRESENTATION follows the profile: `redacted`
 * admits a derivative only (the original is hashed, never held), `full` holds
 * the original, `full_vibes` alone admits VIBES evidence; every record carries
 * the exact SHA-256 and byte length of the original and of the derivative with
 * the rule ids that made it.
 *
 * A bounded hold keeps admitted bytes in memory until an endpoint capture
 * takes them. No endpoint operation of this build carries content
 * (`LOCAL_ENDPOINT_OPERATIONS` names none; `telemetry` refuses a content
 * reference; CP-01), so `contentDeliveryStanding()` says so, every record
 * stays `pending_upload`, and shed, revoked or oversize bytes are counted with
 * the record moved to `unavailable` and the reason on it. Not a spool, not a
 * second policy engine, not audit authority.
 */

import { createHash } from 'node:crypto';
import {
	LOCAL_ENDPOINT_OPERATIONS,
	type EndpointCollectionProfile,
	type ManagedEnrollmentStatus,
} from '../../shared/maestro-lib/managed/endpoint-port';
import { redactSecrets } from '../../shared/redactSecrets';
import { generateUUID } from '../../shared/uuid';

// ---- Roles, profiles, representations

/** The content classes a ceiling grants by name. `tool.output` is declared for the ceiling; the parsers of this build surface no tool result body, so no producer fills it. */
export const CONTENT_ROLES = [
	'user.prompt',
	'assistant.output',
	'tool.input',
	'tool.output',
	'vibes.annotations',
] as const;
export type ContentRole = (typeof CONTENT_ROLES)[number];

/** The contract event family each role is reported under. */
export const CONTENT_ROLE_FAMILIES: Readonly<Record<ContentRole, string>> = {
	'user.prompt': 'user.prompt',
	'assistant.output': 'assistant.output',
	'tool.input': 'tool.requested',
	'tool.output': 'tool.completed',
	'vibes.annotations': 'vibes.annotation',
};

const PROFILES = 'metadata redacted full full_vibes'.split(' ') as EndpointCollectionProfile[];
export const CONTENT_SENSITIVITIES = ['internal', 'confidential', 'restricted'] as const;
export type ContentSensitivity = (typeof CONTENT_SENSITIVITIES)[number];
export type ContentRepresentation = 'original' | 'derivative';

/** What a profile admits of a role: nothing, a derivative only, or the original. `full` never includes VIBES evidence. */
export function profileAdmits(
	profile: EndpointCollectionProfile,
	role: ContentRole
): ContentRepresentation | 'none' {
	if (profile === 'metadata') return 'none';
	if (role === 'vibes.annotations') return profile === 'full_vibes' ? 'original' : 'none';
	return profile === 'redacted' ? 'derivative' : 'original';
}

// ---- The ceiling: the signed per-role grant, bound to the applied revision

const PERMISSION_KEYS = ['capture', 'upload', 'storage', 'index', 'display', 'export'] as const;
/** The sibling `contentPermissions`: six independent ceilings; none grants a reader anything. */
export type ContentPermissions = Record<(typeof PERMISSION_KEYS)[number], boolean>;

export interface ContentCollectionCeiling {
	policyRevision: number;
	profile: EndpointCollectionProfile;
	roles: readonly ContentRole[];
	permissions: ContentPermissions;
	sensitivity: ContentSensitivity;
	maxPayloadBytes: number;
	/** The signed redaction rule ids a derivative is made under, beside this host's own. */
	redactionRuleIds: readonly string[];
}

/** Bounds a ceiling may not exceed; past any of them it is refused, never truncated. The byte cap is the sibling TRACE evidence binding's. */
export const CONTENT_CEILING_LIMITS = { ruleIds: 32, idLength: 256, maxPayloadBytes: 8 << 20 };
const CEILING_KEYS =
	'policyRevision profile roles permissions sensitivity maxPayloadBytes redactionRuleIds'.split(
		' '
	);

export type ContentCeilingParse =
	| { ok: true; ceiling: ContentCollectionCeiling }
	| { ok: false; problems: readonly string[] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);
const isId = (value: unknown): value is string =>
	typeof value === 'string' && value.length > 0 && value.length <= CONTENT_CEILING_LIMITS.idLength;
const isCount = (value: unknown, max: number): value is number =>
	Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max;
const unknownKeys = (value: Record<string, unknown>, known: readonly string[], at = ''): string[] =>
	Object.keys(value)
		.filter((key) => !known.includes(key))
		.map((key) => `${at}${key} is not a known ${at ? 'permission' : 'key'}`);

/** Validates a ceiling document in full: one unknown key, role, profile, permission or rule id refuses the whole document by name. */
export function parseContentCollectionCeiling(raw: unknown): ContentCeilingParse {
	if (!isRecord(raw)) return { ok: false, problems: ['ceiling is not an object'] };
	const problems = unknownKeys(raw, CEILING_KEYS);
	const fail = (message: string): void => {
		problems.push(message);
	};
	if (!isCount(raw.policyRevision, Number.MAX_SAFE_INTEGER))
		fail('policyRevision is not a revision');
	if (!PROFILES.includes(raw.profile as EndpointCollectionProfile))
		fail('profile is not a collection profile');
	const roles: ContentRole[] = [];
	if (!Array.isArray(raw.roles)) fail('roles is not an array');
	else
		raw.roles.forEach((role, i) => {
			if (!(CONTENT_ROLES as readonly unknown[]).includes(role))
				fail(`roles[${i}] is not a content role`);
			else if (roles.includes(role as ContentRole)) fail(`roles[${i}] repeats a role`);
			else roles.push(role as ContentRole);
		});
	const permissions = {} as ContentPermissions;
	if (!isRecord(raw.permissions)) fail('permissions is not an object');
	else {
		problems.push(...unknownKeys(raw.permissions, PERMISSION_KEYS, 'permissions.'));
		for (const key of PERMISSION_KEYS) {
			if (typeof raw.permissions[key] !== 'boolean') fail(`permissions.${key} is not a boolean`);
			else permissions[key] = raw.permissions[key] as boolean;
		}
	}
	if (!(CONTENT_SENSITIVITIES as readonly unknown[]).includes(raw.sensitivity))
		fail('sensitivity is not a content sensitivity');
	if (
		!isCount(raw.maxPayloadBytes, CONTENT_CEILING_LIMITS.maxPayloadBytes) ||
		raw.maxPayloadBytes === 0
	)
		fail(`maxPayloadBytes is not 1..${CONTENT_CEILING_LIMITS.maxPayloadBytes}`);
	const ruleIds: string[] = [];
	if (!Array.isArray(raw.redactionRuleIds)) fail('redactionRuleIds is not an array');
	else if (raw.redactionRuleIds.length > CONTENT_CEILING_LIMITS.ruleIds)
		fail(`redactionRuleIds exceeds ${CONTENT_CEILING_LIMITS.ruleIds} entries`);
	else
		raw.redactionRuleIds.forEach((id, i) => {
			if (isId(id)) ruleIds.push(id);
			else fail(`redactionRuleIds[${i}] is not an identifier`);
		});
	if (problems.length > 0) return { ok: false, problems };
	return {
		ok: true,
		ceiling: {
			policyRevision: raw.policyRevision as number,
			profile: raw.profile as EndpointCollectionProfile,
			roles,
			permissions,
			sensitivity: raw.sensitivity as ContentSensitivity,
			maxPayloadBytes: raw.maxPayloadBytes as number,
			redactionRuleIds: ruleIds,
		},
	};
}

// ---- The standing: profile from the endpoint, ceiling for the applied revision

export type ContentCollectionStanding =
	/** Never enrolled: content collection is a managed feature; nothing is kept and nothing is refused. */
	| { mode: 'standalone' }
	| {
			mode: 'managed';
			ok: false;
			reason: string;
			profile: EndpointCollectionProfile | null;
			policyRevision: number | null;
	  }
	| {
			mode: 'managed';
			ok: true;
			profile: EndpointCollectionProfile;
			policyRevision: number;
			ceiling: ContentCollectionCeiling;
	  };

export interface ContentCollectionSource {
	standing(): ContentCollectionStanding;
	/** For a document read over the registered, attached connection. A refused document keeps the previous one. */
	install(document: unknown): ContentCeilingParse;
	clear(): void;
	installed(): ContentCollectionCeiling | null;
}

/** Holds at most one ceiling, in memory only (a restart holds none, which is fail-closed), and projects the standing a capture reads. */
export function createContentCollectionSource(deps: {
	status: () => ManagedEnrollmentStatus;
}): ContentCollectionSource {
	let ceiling: ContentCollectionCeiling | null = null;
	return {
		standing() {
			const standing = deps.status();
			const identity = standing.identity;
			if (identity.status === 'none' && identity.record === null) return { mode: 'standalone' };
			const live = standing.connection?.attached ? standing.endpoint : null;
			const profile = live?.collectionProfile ?? null;
			const revision = live?.appliedPolicyRevision ?? null;
			const refuse = (reason: string): ContentCollectionStanding => ({
				mode: 'managed',
				ok: false,
				reason,
				profile,
				policyRevision: revision,
			});
			if (standing.authority !== 'registered' || !live)
				return refuse(standing.reason ?? 'No endpoint is attached.');
			if (profile === null || revision === null)
				return refuse('The attached endpoint reports no collection profile or applied revision.');
			if (profile === 'metadata')
				return refuse(
					'The endpoint puts this device under the metadata profile: no content is collected.'
				);
			if (!ceiling)
				return refuse(
					'No content ceiling is installed; no endpoint operation of this build carries one (CP-01).'
				);
			if (ceiling.policyRevision !== revision)
				return refuse(
					`The installed ceiling is for revision ${ceiling.policyRevision}, not ${revision}.`
				);
			if (ceiling.profile !== profile)
				return refuse(
					`The installed ceiling names profile ${ceiling.profile}; the endpoint reports ${profile}.`
				);
			if (!ceiling.permissions.capture) return refuse('The ceiling grants no capture.');
			return { mode: 'managed', ok: true, profile, policyRevision: revision, ceiling };
		},
		install(document) {
			const parsed = parseContentCollectionCeiling(document);
			if (parsed.ok) ceiling = parsed.ceiling;
			return parsed;
		},
		clear() {
			ceiling = null;
		},
		installed: () => ceiling,
	};
}

// ---- The capture: exact references, a bounded hold, a bounded ledger

/** The sibling `contentReference`: an opaque id, the exact digest and length, never a URL, a path or the bytes. */
export interface ContentReference {
	referenceId: string;
	sha256: string;
	representation: ContentRepresentation;
	byteLength: number;
}

export interface ContentFact {
	role: ContentRole;
	family: string;
	profile: EndpointCollectionProfile;
	policyRevision: number;
	sensitivity: ContentSensitivity;
	permissions: ContentPermissions;
	/** ISO 8601. */ at: string;
	sessionId: string;
	agentId: string;
	tabId: string | null;
	provider: string;
	runId: string | null;
	toolName: string | null;
	/** The tool call a subagent's content hangs under; null for the main transcript. */
	parentToolCallId: string | null;
	/** The exact original, always: hashed before any transformation, held only under `full`. */
	original: ContentReference;
	/** The derivative this host made, under `redacted`; null when the original is the kept representation. */
	derivative: ContentReference | null;
	transformation: { ruleIds: readonly string[]; at: string } | null;
	/** Which representation the hold has bytes for right now. */
	kept: ContentRepresentation | 'none';
	completeness: 'pending_upload' | 'unavailable';
	/** `verified_locally`: this host computed the digest itself; never central verification. */
	verification: 'verified_locally';
	/** Why the bytes are not held, by name: `oversize`, `shed`, `revoked: <reason>`; null while held. */
	gap: string | null;
}

/** Every key a fact may carry. A reader refuses a value with any other key, whatever it holds. */
export const CONTENT_FACT_FIELDS = (
	'role family profile policyRevision sensitivity permissions at sessionId agentId tabId provider ' +
	'runId toolName parentToolCallId original derivative transformation kept completeness verification gap'
).split(' ') as readonly (keyof ContentFact)[];
const REFERENCE_KEYS = ['referenceId', 'sha256', 'representation', 'byteLength'];

/** The structural problems with a value offered as a fact: text, a prompt, bytes or a path under any key is an unknown field. */
export function contentFactProblems(value: unknown): string[] {
	if (!isRecord(value)) return ['fact is not an object'];
	const problems = Object.keys(value)
		.filter((key) => !(CONTENT_FACT_FIELDS as readonly string[]).includes(key))
		.map((key) => `${key} is not a fact field`);
	for (const key of ['original', 'derivative'] as const) {
		const ref = value[key];
		if (ref === null && key === 'derivative') continue;
		if (!isRecord(ref)) problems.push(`${key} is not a reference`);
		else
			for (const k of Object.keys(ref))
				if (!REFERENCE_KEYS.includes(k)) problems.push(`${key}.${k} is not a reference field`);
	}
	return problems;
}

export interface ContentCaptureInput {
	role: ContentRole;
	/** The provider-visible text, as shown. Hashed as UTF-8. */
	text: string;
	sessionId: string;
	agentId: string;
	tabId: string | null;
	provider: string;
	runId: string | null;
	toolName?: string | null;
	parentToolCallId?: string | null;
	/** Epoch milliseconds. Default now. */
	at?: number;
}

export type ContentCaptureOutcome =
	| { outcome: 'not-collected'; reason: string }
	| { outcome: 'recorded'; fact: ContentFact };

/** This host's own derivative rule: `redactSecrets` with hex blobs, as the agent-run ledger opts in. */
export const CONTENT_REDACTION_RULE_ID = 'maestro.redact-secrets.v1';
const MAX_TOOL_NAME = 128;
const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** Whether this build can hand content to the endpoint. Read off the operations list, so a build that gains one changes the answer here. */
export function contentDeliveryStanding(): { available: false; reason: string } {
	const operation = (LOCAL_ENDPOINT_OPERATIONS as readonly string[]).find(
		(name) => name === 'content' || name === 'capture'
	);
	return {
		available: false,
		reason: operation
			? `The endpoint names a ${operation} operation this host has no port for yet.`
			: 'No endpoint operation of this build carries content; telemetry refuses a content reference (CP-01, owner mega-maestro).',
	};
}

export interface ContentCaptureStatus {
	records: number;
	held: { count: number; bytes: number };
	forgotten: number;
	shed: number;
	revoked: number;
	notCollected: number;
	byRole: Partial<Record<ContentRole, number>>;
	delivery: ReturnType<typeof contentDeliveryStanding>;
}

/** `capture` records under the standing; `take` hands held bytes to an endpoint capture; `revoke` drops every held byte (the records stay, `unavailable`, with the reason). */
export type ContentCapture = ReturnType<typeof createContentCapture>;

export interface ContentCaptureDeps {
	source: Pick<ContentCollectionSource, 'standing'>;
	now?: () => number;
	newId?: () => string;
	/** Records the ledger keeps (default 2000) and bytes the hold keeps (default 16 MiB); the oldest goes first, counted. */
	capacity?: number;
	holdBytes?: number;
}

export function createContentCapture(deps: ContentCaptureDeps) {
	const now = deps.now ?? (() => Date.now());
	const newId = deps.newId ?? generateUUID;
	const capacity = Math.max(1, deps.capacity ?? 2000);
	const holdBytes = Math.max(1, deps.holdBytes ?? 16 << 20);
	const ledger: ContentFact[] = [];
	const hold = new Map<string, { bytes: Buffer; fact: ContentFact }>();
	let heldBytes = 0;
	const counters = { forgotten: 0, shed: 0, revoked: 0, notCollected: 0 };
	const byRole: Partial<Record<ContentRole, number>> = {};

	const release = (fact: ContentFact, gap: string): void => {
		fact.kept = 'none';
		fact.completeness = 'unavailable';
		fact.gap = gap;
	};
	const drop = (referenceId: string): void => {
		const held = hold.get(referenceId);
		if (!held) return;
		hold.delete(referenceId);
		heldBytes -= held.bytes.byteLength;
	};
	const reference = (bytes: Buffer, representation: ContentRepresentation): ContentReference => ({
		referenceId: newId(),
		sha256: sha256(bytes),
		representation,
		byteLength: bytes.byteLength,
	});
	const refuse = (reason: string): ContentCaptureOutcome => {
		counters.notCollected += 1;
		return { outcome: 'not-collected', reason };
	};

	return {
		capture(input: ContentCaptureInput): ContentCaptureOutcome {
			const standing = deps.source.standing();
			if (standing.mode === 'standalone')
				return refuse('standalone: content collection is not managed here');
			if (!standing.ok) return refuse(standing.reason);
			const { ceiling, profile } = standing;
			if (!ceiling.roles.includes(input.role)) return refuse(`the ceiling grants no ${input.role}`);
			const admits = profileAdmits(profile, input.role);
			if (admits === 'none') return refuse(`profile ${profile} admits no ${input.role}`);
			const at = new Date(input.at ?? now()).toISOString();
			let kept = Buffer.from(input.text, 'utf8');
			const fact: ContentFact = {
				role: input.role,
				family: CONTENT_ROLE_FAMILIES[input.role],
				profile,
				policyRevision: standing.policyRevision,
				sensitivity: ceiling.sensitivity,
				permissions: { ...ceiling.permissions },
				at,
				sessionId: input.sessionId,
				agentId: input.agentId,
				tabId: input.tabId,
				provider: input.provider,
				runId: input.runId,
				toolName: input.toolName ? input.toolName.slice(0, MAX_TOOL_NAME) : null,
				parentToolCallId: input.parentToolCallId ?? null,
				original: reference(kept, 'original'),
				derivative: null,
				transformation: null,
				kept: admits,
				completeness: 'pending_upload',
				verification: 'verified_locally',
				gap: null,
			};
			if (admits === 'derivative') {
				kept = Buffer.from(redactSecrets(input.text, { hexBlobs: true }).text, 'utf8');
				fact.derivative = reference(kept, 'derivative');
				fact.transformation = {
					ruleIds: [CONTENT_REDACTION_RULE_ID, ...ceiling.redactionRuleIds],
					at,
				};
			}
			if (kept.byteLength > ceiling.maxPayloadBytes) release(fact, 'oversize');
			else {
				// The oldest held bytes go first, counted, their record saying so.
				while (heldBytes + kept.byteLength > holdBytes && hold.size > 0) {
					const [oldestId, oldest] = hold.entries().next().value!;
					drop(oldestId);
					release(oldest.fact, 'shed');
					counters.shed += 1;
				}
				hold.set((fact.derivative ?? fact.original).referenceId, { bytes: kept, fact });
				heldBytes += kept.byteLength;
			}
			ledger.push(fact);
			while (ledger.length > capacity) {
				const forgotten = ledger.shift()!;
				drop((forgotten.derivative ?? forgotten.original).referenceId);
				counters.forgotten += 1;
			}
			byRole[input.role] = (byRole[input.role] ?? 0) + 1;
			return { outcome: 'recorded', fact };
		},
		take(referenceId: string): { bytes: Buffer; fact: ContentFact } | null {
			const held = hold.get(referenceId);
			return held ? { bytes: Buffer.from(held.bytes), fact: held.fact } : null;
		},
		revoke(reason: string): number {
			const dropped = hold.size;
			for (const { fact } of hold.values()) release(fact, `revoked: ${reason}`);
			hold.clear();
			heldBytes = 0;
			counters.revoked += dropped;
			return dropped;
		},
		facts: (): readonly ContentFact[] => [...ledger],
		status: (): ContentCaptureStatus => ({
			records: ledger.length,
			held: { count: hold.size, bytes: heldBytes },
			...counters,
			byRole: { ...byRole },
			delivery: contentDeliveryStanding(),
		}),
	};
}
