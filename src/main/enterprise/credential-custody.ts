/**
 * The custody ceiling a managed desktop holds credentials and sealed state to
 * (MRC2-06-06).
 *
 * Three stores Phase 1 did not name keep a value an agent, a support package
 * or a disk search must not find: the chain of thought export state
 * (`src/main/cot-export/config-store.ts`, sealed when the OS can seal and
 * otherwise under the app's built-in obscuring key), the WakaTime API key (a
 * plain settings key, or `~/.wakatime.cfg`) and the 0DIN token Cue's SusFactor
 * reads from the environment. Standalone every one of them does what it always
 * did and nothing here is consulted. Under management a value is kept only
 * under protected custody: the OS key store (`sealProtectionProblem()` names
 * nothing) with a freshness anchor in the OS credential store. The obscuring
 * fallback is refused, never fallen back to; a plain file is refused; an
 * environment variable, inherited by every child process and collected by a
 * support package, is refused. The feature that needs the value is then off on
 * that host, by name, and the value is never persisted around the refusal.
 *
 * One authority, read at the sink. The desktop composes a source over its
 * enrollment standing (`identityStandingOf()`, the one rule of MRC2-05-10A)
 * and sets it as the module authority every `holdCredentialCustody()` reads;
 * the WakaTime manager, which also runs in the maestro-cli bundle, takes the
 * authority by injection like its install ceiling. A refusal names the
 * credential and its custody, never a value.
 */

import type { AnchorStore } from '../utils/keyring-anchor';
import { sealProtectionProblem, type SealProvider } from '../utils/safe-storage-seal';
import {
	identityStandingOf,
	type EnterpriseIdentityStore,
	type IdentityStanding,
} from './identity-store';

/** What is held: the turn log state, the WakaTime API key, Cue's 0DIN token. */
export const MANAGED_CREDENTIALS = [
	'cot-export.state',
	'wakatime.apiKey',
	'cue.odinToken',
] as const;
export type ManagedCredential = (typeof MANAGED_CREDENTIALS)[number];

const CREDENTIAL_LABELS: Record<ManagedCredential, string> = {
	'cot-export.state': 'the turn log state',
	'wakatime.apiKey': 'the WakaTime API key',
	'cue.odinToken': 'the 0DIN API token',
};

/** Where a value would be kept, as the sink about to keep or read it knows. */
export type CredentialCustody =
	| { kind: 'sealed'; seal: SealProvider; anchor: AnchorStore }
	| { kind: 'plain-file'; file: string }
	| { kind: 'environment'; name: string };

/** The settings keys that are a credential in the plain settings file, by the credential they hold. */
export const PLAIN_SETTINGS_CREDENTIAL_KEYS: Readonly<Record<string, ManagedCredential>> =
	Object.freeze({ wakatimeApiKey: 'wakatime.apiKey' });
/** The custody of a value in `maestro-settings.json`. */
export const SETTINGS_FILE_CUSTODY: CredentialCustody = Object.freeze({
	kind: 'plain-file',
	file: 'maestro-settings.json',
});

export type CredentialCustodyDenial = 'unprotected' | 'plain-file' | 'environment';
export type CredentialCustodyDecision =
	| { allowed: true }
	| { allowed: false; code: CredentialCustodyDenial; message: string };

/**
 * Hold keeping `credential` under `custody`. Pure. Standalone admits every
 * custody; managed admits only the OS key store with an anchor available, and
 * names the credential and the custody it refuses.
 */
export function credentialCustodyVerdict(
	standing: IdentityStanding,
	credential: ManagedCredential,
	custody: CredentialCustody,
	platform: NodeJS.Platform = process.platform
): CredentialCustodyDecision {
	if (standing === 'standalone') return { allowed: true };
	const deny = (code: CredentialCustodyDenial, why: string): CredentialCustodyDecision => ({
		allowed: false,
		code,
		message: `${CREDENTIAL_LABELS[credential]} is not kept on this managed host: ${why}`,
	});
	switch (custody.kind) {
		case 'sealed': {
			const problem = sealProtectionProblem(custody.seal, platform);
			if (problem !== null) return deny('unprotected', problem);
			if (!custody.anchor.available()) {
				return deny(
					'unprotected',
					'no OS credential store holds a freshness anchor, so an older copy could not be told from the newest.'
				);
			}
			return { allowed: true };
		}
		case 'plain-file':
			return deny(
				'plain-file',
				`${custody.file} is a readable file, and a managed host keeps a credential only under the OS key store.`
			);
		case 'environment':
			return deny(
				'environment',
				`the ${custody.name} environment variable is inherited by every child process and collected by a support package, and a managed host keeps a credential only under the OS key store.`
			);
	}
}

/** The refusal line a sink logs: the code first, so it never reads as a failed save. */
export function formatCredentialRefusal(decision: { code: string; message: string }): string {
	return `[managed-${decision.code}] ${decision.message}`;
}

export interface CredentialCustodyAuthority {
	standing(): IdentityStanding;
	authorize(credential: ManagedCredential, custody: CredentialCustody): CredentialCustodyDecision;
}

export interface CredentialCustodySourceDeps {
	identity: Pick<EnterpriseIdentityStore, 'read'>;
	platform?: NodeJS.Platform;
}

/** The desktop's authority, under the enrollment rule every other ceiling reads. */
export function createCredentialCustodySource(
	deps: CredentialCustodySourceDeps
): CredentialCustodyAuthority {
	const standing = () => identityStandingOf(deps.identity.read());
	return {
		standing,
		authorize: (credential, custody) =>
			credentialCustodyVerdict(standing(), credential, custody, deps.platform),
	};
}

/** A process with no desktop (a bare maestro-cli): the standing it read beside the data-dir lock. */
export function headlessCredentialAuthority(managed: {
	standing(): IdentityStanding;
}): CredentialCustodyAuthority {
	return {
		standing: () => managed.standing(),
		authorize: (credential, custody) =>
			credentialCustodyVerdict(managed.standing(), credential, custody),
	};
}

// The one authority every sink in this process reads. Null until the desktop
// composes a source (and forever on a host that never does): standalone.
let custodyAuthority: CredentialCustodyAuthority | null = null;

export function setCredentialCustodyAuthority(authority: CredentialCustodyAuthority | null): void {
	custodyAuthority = authority;
}

/** Hold keeping or reading `credential` under `custody` through the one authority. Standalone: allowed. */
export function holdCredentialCustody(
	credential: ManagedCredential,
	custody: CredentialCustody
): CredentialCustodyDecision {
	return custodyAuthority ? custodyAuthority.authorize(credential, custody) : { allowed: true };
}
