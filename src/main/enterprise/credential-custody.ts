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
 * A command-line value is refused the same way (MCOMP-21-02A): the user info
 * of `cue engine start --notify-webhook https://user:pass@host/` is visible in
 * the process list and the shell history, so a managed host sends no
 * notification carrying it (the credential is never stripped to send anyway).
 *
 * One authority, read at the sink. The desktop composes a source over its
 * enrollment standing (`identityStandingOf()`, the one rule of MRC2-05-10A)
 * and sets it as the module authority every `holdCredentialCustody()` reads;
 * the WakaTime manager, which also runs in the maestro-cli bundle, takes the
 * authority by injection like its install ceiling. A refusal names the
 * credential and its custody, never a value.
 */

import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { AnchorStore } from '../utils/keyring-anchor';
import { sealProtectionProblem, type SealProvider } from '../utils/safe-storage-seal';
import {
	identityStandingOf,
	type EnterpriseIdentityStore,
	type IdentityStanding,
} from './identity-store';

/**
 * What is held: the turn log state, the WakaTime API key, Cue's 0DIN token and
 * the credential in the user info of Cue's notify webhook URL.
 */
export const MANAGED_CREDENTIALS = [
	'cot-export.state',
	'wakatime.apiKey',
	'cue.odinToken',
	'cue.notifyWebhookCredential',
	'web.authToken',
] as const;
export type ManagedCredential = (typeof MANAGED_CREDENTIALS)[number];

const CREDENTIAL_LABELS: Record<ManagedCredential, string> = {
	'cot-export.state': 'the turn log state',
	'wakatime.apiKey': 'the WakaTime API key',
	'cue.odinToken': 'the 0DIN API token',
	'cue.notifyWebhookCredential': 'the notify webhook URL credential',
	'web.authToken': 'the persistent web link token',
};

/** Where a value would be kept, as the sink about to keep or read it knows. */
export type CredentialCustody =
	| { kind: 'sealed'; seal: SealProvider; anchor: AnchorStore }
	| { kind: 'plain-file'; file: string }
	| { kind: 'environment'; name: string }
	| { kind: 'command-line'; flag: string };

/** The settings keys that are a credential in the plain settings file, by the credential they hold. */
export const PLAIN_SETTINGS_CREDENTIAL_KEYS: Readonly<Record<string, ManagedCredential>> =
	Object.freeze({ wakatimeApiKey: 'wakatime.apiKey' });
/** The custody of a value in `maestro-settings.json`. */
export const SETTINGS_FILE_CUSTODY: CredentialCustody = Object.freeze({
	kind: 'plain-file',
	file: 'maestro-settings.json',
});

export type CredentialCustodyDenial = 'unprotected' | 'plain-file' | 'environment' | 'command-line';
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
		case 'command-line':
			return deny(
				'command-line',
				`the ${custody.flag} value is visible in the process list and the shell history, and a managed host keeps a credential only under the OS key store.`
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
	/**
	 * Who a kept credential belongs to on a managed host: the tenant and
	 * installation of the current, trusted enrollment record (MCOMP-21-05).
	 * Null when no trusted record names one (standalone, untrusted, unreadable).
	 */
	owner?(): string | null;
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
		owner: () => {
			const read = deps.identity.read();
			return read.status === 'ok' ? `${read.record.tenantId}/${read.record.installationId}` : null;
		},
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

/** The standing of the one authority. Standalone when no desktop composed one. */
export function credentialCustodyStanding(): IdentityStanding {
	return custodyAuthority ? custodyAuthority.standing() : 'standalone';
}

/** The owner of the one authority (see `CredentialCustodyAuthority.owner`). Null standalone. */
export function credentialCustodyOwner(): string | null {
	return custodyAuthority?.owner?.() ?? null;
}

// ============================================================================
// A credential kept by the service, never in settings (MCOMP-21-05)
// ============================================================================

/**
 * A credential a managed host keeps for itself, under protected custody, in
 * its own file beside the settings: what the settings file, the renderer, a
 * support package or a settings export see is `reference`, an opaque marker
 * that opens nothing. The value is sealed with the OS key store together with
 * its owner (`credentialCustodyOwner()`) and a freshness epoch mirrored in
 * the OS credential store, so a copy from another installation, an enrollment
 * that is gone, an older copy put back, or a file whose anchor is gone opens
 * nothing (`read()` answers null and the caller rotates). Every write is held
 * by `holdCredentialCustody()` first, so a refusal persists nothing at all.
 */
export interface CustodyCredentialSlot {
	readonly credential: ManagedCredential;
	/** The opaque marker a plain store keeps in place of the value. */
	readonly reference: string;
	/** The value, only for its current owner and only from the newest copy; null otherwise. */
	read(): string | null;
	/** Seal `value` for the current owner. A refusal writes nothing and is returned. */
	write(value: string): CredentialCustodyDecision;
	/** Remove the value and its anchor. Never throws. */
	clear(): void;
}

export interface CustodyCredentialSlotDeps {
	credential: ManagedCredential;
	/** The file the sealed value lives in. */
	file: string;
	seal: SealProvider;
	anchor: AnchorStore;
	/** Defaults to the one authority's owner. */
	owner?: () => string | null;
	/** Defaults to the one authority. */
	hold?: (credential: ManagedCredential, custody: CredentialCustody) => CredentialCustodyDecision;
}

interface SealedCredentialRecord {
	nonce: string;
	credential: ManagedCredential;
	owner: string;
	value: string;
	installSecret: string;
	epoch: number;
}

/** The marker kept in place of `credential` in a plain store. Never a usable value. */
export function custodyReferenceFor(credential: ManagedCredential): string {
	return `custody:${credential}`;
}

export function createCustodyCredentialSlot(
	deps: CustodyCredentialSlotDeps
): CustodyCredentialSlot {
	const owner = deps.owner ?? credentialCustodyOwner;
	const hold = deps.hold ?? holdCredentialCustody;
	const custody: CredentialCustody = { kind: 'sealed', seal: deps.seal, anchor: deps.anchor };
	const readRecord = (): SealedCredentialRecord | null => {
		try {
			const file: unknown = JSON.parse(fs.readFileSync(deps.file, 'utf8'));
			if (typeof file !== 'object' || file === null || !('blob' in file)) return null;
			if (typeof file.blob !== 'string') return null;
			const parsed: unknown = JSON.parse(deps.seal.unseal(Buffer.from(file.blob, 'base64')));
			if (typeof parsed !== 'object' || parsed === null) return null;
			const r = parsed as Partial<SealedCredentialRecord>;
			if (
				r.credential !== deps.credential ||
				typeof r.owner !== 'string' ||
				typeof r.value !== 'string' ||
				typeof r.installSecret !== 'string' ||
				typeof r.epoch !== 'number'
			) {
				return null;
			}
			return r as SealedCredentialRecord;
		} catch {
			return null;
		}
	};
	return {
		credential: deps.credential,
		reference: custodyReferenceFor(deps.credential),
		read: () => {
			const current = owner();
			if (current === null) return null;
			if (hold(deps.credential, custody).allowed !== true) return null;
			const record = readRecord();
			if (!record || record.owner !== current) return null;
			// Freshness: the anchor binds the file and says how new the newest copy is.
			const anchor = deps.anchor.read();
			if (!anchor || anchor.installSecret !== record.installSecret || record.epoch < anchor.epoch) {
				return null;
			}
			return record.value;
		},
		write: (value) => {
			const decision = hold(deps.credential, custody);
			if (!decision.allowed) return decision;
			const current = owner();
			if (current === null) {
				return {
					allowed: false,
					code: 'unprotected',
					message: `${CREDENTIAL_LABELS[deps.credential]} is not kept on this managed host: no trusted enrollment record names the installation that would own it.`,
				};
			}
			const previous = deps.anchor.read();
			const record: SealedCredentialRecord = {
				nonce: randomBytes(16).toString('hex'),
				credential: deps.credential,
				owner: current,
				value,
				installSecret: previous?.installSecret ?? randomBytes(32).toString('hex'),
				epoch: (previous?.epoch ?? 0) + 1,
			};
			const blob = deps.seal.seal(JSON.stringify(record)).toString('base64');
			fs.mkdirSync(path.dirname(deps.file), { recursive: true });
			const tmp = `${deps.file}.${process.pid}.tmp`;
			fs.writeFileSync(tmp, JSON.stringify({ blob }), { mode: 0o600 });
			fs.renameSync(tmp, deps.file);
			// The file is written first: a stop before the anchor leaves a file one epoch
			// ahead, which still opens; the anchor never names a copy that is not there.
			deps.anchor.write({ installSecret: record.installSecret, epoch: record.epoch });
			return { allowed: true };
		},
		clear: () => {
			try {
				fs.rmSync(deps.file, { force: true });
			} catch {
				/* best-effort */
			}
			deps.anchor.clear();
		},
	};
}
