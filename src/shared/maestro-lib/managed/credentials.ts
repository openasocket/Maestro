/**
 * Approved credential references: how a managed launch names the credential
 * it may use, without ever holding the credential.
 *
 * A reference is opaque and bound. Opaque: `refId` is an identifier the
 * policy authority issued, and nothing about it can be acted on by a reader.
 * Bound: it names the tenant, the actor, the Maestro agent, the audience (the
 * provider and the gateway destination the value is for), an opaque account
 * reference, a policy revision and a validity window. A reference whose
 * binding does not match the launch it is offered for is refused, and a
 * refused reference delivers nothing.
 *
 * What a reference carries that is NOT secret: `source`, the host-resolved
 * metadata saying where the value lives (a named server secret, looked up by
 * `lookupSecret()` at the launch boundary) and which environment variable
 * the consumer reads it from. The value itself is read once, by the launch
 * plan, into one child's environment, and is never on the reference, in a
 * journal, in a bundle or in a report.
 *
 * What is NOT credential authority, and has no constructor here:
 *   - a `requiredSecrets` name (a launch dependency declaration; a bundle or
 *     an agent record can state it, which proves nothing);
 *   - an account directory name, an e-mail address read from a provider's
 *     login file, an API key suffix or any other label;
 *   - a reference typed by hand. `bindApprovedCredentials()` is the one
 *     producer of an `ApprovedCredentialSet`, a module-private set backs the
 *     result, and the launch plan refuses a set that is not one of its own
 *     (`isApprovedCredentialSet()`), the same way a verified context works.
 *
 * Serializable records only, so a reference crosses IPC and a journal
 * unchanged; the host decides, the reference attributes.
 */

import { createHash } from 'node:crypto';

import { canonicalJson } from '../../canonicalJson';
import { isValidSecretName } from '../../serverSecrets';
import { MANAGED_CONTRACT_VERSION, type ManagedContractVersion } from './types';

/** Where a host finds a credential's value. One kind in this build: a named server secret. */
export type ManagedCredentialSourceKind = 'server-secret';

/**
 * Non-secret source metadata, resolved by the host. `secretName` is what
 * `lookupSecret()` is asked for (systemd credential, `/run/secrets`, then the
 * environment); `envVar` is the variable the consumer reads the value from,
 * which need not be the same name.
 */
export interface ManagedCredentialSource {
	kind: ManagedCredentialSourceKind;
	secretName: string;
	envVar: string;
}

/** Who the credential is for: the provider, and the gateway origin or `null` for the provider's own API. */
export interface ManagedCredentialAudience {
	providerId: string;
	destination: string | null;
}

export type ManagedCredentialStatus = 'active' | 'revoked';

/** An approved credential, as the policy authority issued it. Nothing here is a value. */
export interface ManagedCredentialRef {
	contractVersion: ManagedContractVersion;
	/** Opaque. Issued by the authority; nothing can be derived from it. */
	refId: string;
	tenantId: string;
	actorId: string;
	/** The Maestro agent the credential is bound to. */
	agentId: string;
	audience: ManagedCredentialAudience;
	/** An opaque account reference (`managedAccountRef()`), or null when not account-bound. */
	accountRef: string | null;
	policyRevision: number;
	/** ISO 8601. */
	issuedAt: string;
	/** ISO 8601. A reference past this instant delivers nothing. */
	expiresAt: string;
	status: ManagedCredentialStatus;
	source: ManagedCredentialSource;
}

/** The launch a reference is offered for, as the host resolved it. Never from a label. */
export interface CredentialLaunchBinding {
	tenantId: string;
	actorId: string;
	agentId: string;
	providerId: string;
	/** The gateway origin the launch routes to, or null for the provider's own API. */
	destination: string | null;
	/** The opaque reference of the account the launch runs as, or null when unknown. */
	accountRef: string | null;
	/** The policy revision the launch is decided on; null when none is known (then no reference binds). */
	policyRevision: number | null;
	/** Epoch milliseconds. Injected, never read from the clock inside. */
	now: number;
}

export type CredentialRefusalReason =
	| 'invalid-ref'
	| 'revoked'
	| 'expired'
	| 'not-yet-valid'
	| 'tenant-mismatch'
	| 'actor-mismatch'
	| 'agent-mismatch'
	| 'audience-mismatch'
	| 'account-mismatch'
	| 'policy-revision-mismatch'
	| 'duplicate-env-var';

export interface CredentialRefusal {
	refId: string;
	reason: CredentialRefusalReason;
	/** Safe to show. Names, never values. */
	detail: string;
}

/** One reference the binding accepted: what to look up, and where it goes. */
export interface ApprovedCredential {
	refId: string;
	secretName: string;
	envVar: string;
	source: ManagedCredentialSourceKind;
	accountRef: string | null;
	expiresAt: string;
}

/**
 * The outcome of binding a set of references to one launch. Only
 * `bindApprovedCredentials()` produces one, and `isApprovedCredentialSet()`
 * recognizes only those. `approved` is empty when nothing bound; `refused`
 * says why for each reference that did not.
 */
export interface ApprovedCredentialSet {
	readonly approved: readonly ApprovedCredential[];
	readonly refused: readonly CredentialRefusal[];
	readonly binding: Omit<CredentialLaunchBinding, 'now'>;
	/** When the binding was decided. ISO 8601. */
	readonly boundAt: string;
	/** Digest over the approved references and the binding; never over a value. */
	readonly digest: string;
}

const BOUND = new WeakSet<object>();

const MAX_ID_LENGTH = 256;
const isId = (value: unknown): value is string =>
	typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH;
const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);
const isIsoDate = (value: unknown): value is string =>
	typeof value === 'string' && Number.isFinite(Date.parse(value));

/** Structural problems with a value offered as a reference. Empty means the shape is right, nothing more. */
export function managedCredentialRefProblems(value: unknown): string[] {
	if (!isRecord(value)) return ['credential ref is not an object'];
	const problems: string[] = [];
	if (value.contractVersion !== MANAGED_CONTRACT_VERSION) {
		problems.push(`contractVersion is not ${MANAGED_CONTRACT_VERSION}`);
	}
	for (const key of ['refId', 'tenantId', 'actorId', 'agentId'] as const) {
		if (!isId(value[key])) problems.push(`${key} is not an id`);
	}
	const audience = value.audience;
	if (!isRecord(audience)) problems.push('audience is not an object');
	else {
		if (!isId(audience.providerId)) problems.push('audience.providerId is not an id');
		if (audience.destination !== null && !isId(audience.destination)) {
			problems.push('audience.destination is not an id or null');
		}
	}
	if (value.accountRef !== null && !isId(value.accountRef)) {
		problems.push('accountRef is not an id or null');
	}
	if (!Number.isInteger(value.policyRevision)) problems.push('policyRevision is not an integer');
	if (!isIsoDate(value.issuedAt)) problems.push('issuedAt is not a date');
	if (!isIsoDate(value.expiresAt)) problems.push('expiresAt is not a date');
	if (value.status !== 'active' && value.status !== 'revoked') {
		problems.push('status is not active or revoked');
	}
	const source = value.source;
	if (!isRecord(source)) problems.push('source is not an object');
	else {
		if (source.kind !== 'server-secret') problems.push('source.kind is unknown');
		if (typeof source.secretName !== 'string' || !isValidSecretName(source.secretName)) {
			problems.push('source.secretName is not a secret name');
		}
		if (typeof source.envVar !== 'string' || !isValidSecretName(source.envVar)) {
			problems.push('source.envVar is not an environment variable name');
		}
	}
	return problems;
}

export function isManagedCredentialRef(value: unknown): value is ManagedCredentialRef {
	return managedCredentialRefProblems(value).length === 0;
}

/**
 * Bind references to one launch. Pure: the clock is `binding.now`. Every
 * reference is answered, approved or refused with a reason; a reference is
 * never partly approved. Two approved references naming the same
 * environment variable refuse the second (sorted by `refId`), since one
 * variable cannot carry two values.
 */
export function bindApprovedCredentials(
	refs: readonly unknown[],
	binding: CredentialLaunchBinding
): ApprovedCredentialSet {
	const approved: ApprovedCredential[] = [];
	const refused: CredentialRefusal[] = [];
	const envVars = new Set<string>();

	const candidates = [...refs].sort((a, b) => {
		const left = isRecord(a) && typeof a.refId === 'string' ? a.refId : '';
		const right = isRecord(b) && typeof b.refId === 'string' ? b.refId : '';
		return left < right ? -1 : left > right ? 1 : 0;
	});

	for (const candidate of candidates) {
		const problems = managedCredentialRefProblems(candidate);
		if (problems.length > 0) {
			const refId = isRecord(candidate) && isId(candidate.refId) ? candidate.refId : '(invalid)';
			refused.push({ refId, reason: 'invalid-ref', detail: problems.join('; ') });
			continue;
		}
		const ref = candidate as ManagedCredentialRef;
		const refuse = (reason: CredentialRefusalReason, detail: string) =>
			refused.push({ refId: ref.refId, reason, detail });

		if (ref.status === 'revoked') {
			refuse('revoked', 'the reference is revoked');
		} else if (binding.now >= Date.parse(ref.expiresAt)) {
			refuse('expired', `the reference expired at ${ref.expiresAt}`);
		} else if (binding.now < Date.parse(ref.issuedAt)) {
			refuse('not-yet-valid', `the reference is not valid before ${ref.issuedAt}`);
		} else if (ref.tenantId !== binding.tenantId) {
			refuse('tenant-mismatch', 'the reference belongs to another tenant');
		} else if (ref.actorId !== binding.actorId) {
			refuse('actor-mismatch', 'the reference belongs to another actor');
		} else if (ref.agentId !== binding.agentId) {
			refuse('agent-mismatch', 'the reference is bound to another agent');
		} else if (
			ref.audience.providerId !== binding.providerId ||
			ref.audience.destination !== binding.destination
		) {
			refuse(
				'audience-mismatch',
				`the reference is for ${ref.audience.providerId} at ${ref.audience.destination ?? 'the provider API'}`
			);
		} else if (ref.accountRef !== null && ref.accountRef !== binding.accountRef) {
			refuse('account-mismatch', 'the reference is bound to another account');
		} else if (binding.policyRevision === null || ref.policyRevision !== binding.policyRevision) {
			refuse(
				'policy-revision-mismatch',
				`the reference was issued on policy revision ${ref.policyRevision}, the launch is on ${binding.policyRevision ?? 'none'}`
			);
		} else if (envVars.has(ref.source.envVar)) {
			refuse('duplicate-env-var', `${ref.source.envVar} is already delivered by another reference`);
		} else {
			envVars.add(ref.source.envVar);
			approved.push({
				refId: ref.refId,
				secretName: ref.source.secretName,
				envVar: ref.source.envVar,
				source: ref.source.kind,
				accountRef: ref.accountRef,
				expiresAt: ref.expiresAt,
			});
		}
	}

	const { now, ...bound } = binding;
	const set: ApprovedCredentialSet = Object.freeze({
		approved: Object.freeze(approved),
		refused: Object.freeze(refused),
		binding: Object.freeze(bound),
		boundAt: new Date(now).toISOString(),
		digest: createHash('sha256')
			.update(canonicalJson({ approved, binding: bound }), 'utf8')
			.digest('hex'),
	});
	BOUND.add(set);
	return set;
}

/** True only for a set `bindApprovedCredentials()` produced. A copy, a cast or a literal does not pass. */
export function isApprovedCredentialSet(value: unknown): value is ApprovedCredentialSet {
	return typeof value === 'object' && value !== null && BOUND.has(value);
}

/**
 * The opaque reference of one provider account: the provider and the
 * normalized account directory, digested. This is what a credential
 * reference's `accountRef` and a dispatch snapshot's `account` carry, so a
 * path never crosses to an authority and a directory NAME never acts as one.
 */
export function managedAccountRef(providerId: string, accountDir: string): string {
	const normalized = accountDir.replace(/\\/g, '/').replace(/\/+$/, '');
	return createHash('sha256')
		.update(canonicalJson({ providerId, accountDir: normalized }), 'utf8')
		.digest('hex');
}

/** One line for a log or a notice: reference ids and reasons, never a value. */
export function describeCredentialRefusals(refused: readonly CredentialRefusal[]): string {
	return refused.map((entry) => `${entry.refId}: ${entry.reason} (${entry.detail})`).join('; ');
}
