import { createHash } from 'node:crypto';
import { canonicalJson } from '../../canonicalJson';
import { managedAccountRef } from '../managed/credentials';
import type { RecordOrigin, TranslationArtifact, TranslationIdentity } from './types';

export function translationHash(bytes: string | Buffer): string {
	return createHash('sha256').update(bytes).digest('hex');
}

export function recordKey(origin: RecordOrigin): string {
	return canonicalJson(origin);
}

export function nativeRecordKey(
	identity: TranslationIdentity,
	sessionId: string,
	eventId: string
): string {
	return recordKey({
		provider: identity.provider,
		account: translationHash(identity.accountRoot),
		sessionId,
		eventId,
	});
}

/**
 * The opaque reference of a translation identity's account: the same digest
 * a dispatch snapshot and a credential reference carry (`managedAccountRef`),
 * so a migration's source and destination accounts can be authorized by
 * reference without a path, an e-mail or a directory name crossing to the
 * authority.
 */
export function accountIdentityRef(
	identity: Pick<TranslationIdentity, 'provider' | 'accountRoot'>
): string {
	return managedAccountRef(identity.provider, identity.accountRoot);
}

/** The account a managed policy approved for an identity: a provider and an opaque account reference. */
export interface ApprovedAccountBinding {
	provider: TranslationIdentity['provider'];
	accountRef: string;
}

export type TranslationIdentityBinding =
	| { ok: true; accountRef: string }
	| { ok: false; problem: 'provider-mismatch' | 'account-mismatch'; message: string };

/**
 * Bind a translation identity to the account the policy approved. The real
 * target (the resolved `accountRoot`) is what is compared, by reference; a
 * destination whose provider or account is not the approved one is refused,
 * and nothing about the identity (no label, no login e-mail) can stand in.
 */
export function bindTranslationIdentity(
	identity: Pick<TranslationIdentity, 'provider' | 'accountRoot'>,
	approved: ApprovedAccountBinding
): TranslationIdentityBinding {
	if (identity.provider !== approved.provider) {
		return {
			ok: false,
			problem: 'provider-mismatch',
			message: `The policy approved ${approved.provider}, not ${identity.provider}.`,
		};
	}
	const accountRef = accountIdentityRef(identity);
	if (accountRef !== approved.accountRef) {
		return {
			ok: false,
			problem: 'account-mismatch',
			message: 'The account this identity resolves to is not the one the policy approved.',
		};
	}
	return { ok: true, accountRef };
}

/**
 * A login identity read from a provider's own files (an e-mail in a Codex
 * `auth.json`, a Claude account name) is display only. It is unverified, it
 * names no principal, and nothing here lets it become one: the value is a
 * label and a `verified: false` that every consumer must carry with it.
 * Provider OAuth stays provider-owned and host-local; this is the only
 * shape of it that may leave the launch boundary.
 */
export interface DisplayOnlyLogin {
	kind: 'display-only';
	label: string;
	verified: false;
}

export function displayOnlyLogin(login: string | null | undefined): DisplayOnlyLogin | null {
	const label = typeof login === 'string' ? login.trim() : '';
	if (!label) return null;
	return { kind: 'display-only', label, verified: false };
}

export function translationArtifact(
	kind: TranslationArtifact['kind'],
	sourcePath: string,
	relativePath: string,
	bytes: Buffer,
	scope: TranslationArtifact['scope'] = 'project'
): TranslationArtifact {
	const sha256 = translationHash(bytes);
	return {
		id: translationHash(canonicalJson({ kind, sourcePath })),
		kind,
		sourcePath,
		originPath: sourcePath,
		relativePath,
		sha256,
		originSha256: sha256,
		bytesBase64: bytes.toString('base64'),
		scope,
	};
}
