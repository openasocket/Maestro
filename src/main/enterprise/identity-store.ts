/**
 * Custody of the enterprise identity this Maestro installation holds.
 *
 * What is held is the client's side of an enrollment with a Mega-Maestro
 * endpoint: which tenant, organization and enrollment this installation
 * belongs to, which local endpoint socket answers for it and what that
 * endpoint's binding digest was when it did, the last actor registration the
 * endpoint consumed, the policy revisions last observed, and the management
 * state (`enrolled`, `suspended`, `revoked`, `retired`). Nothing here is a
 * device key: the endpoint owns the device key and the certificate, and this
 * store never sees either. What it protects is the authority to SAY "this
 * installation is enrolled with that endpoint", which a plain file could be
 * edited or restored to say.
 *
 * Custody is the existing seal and anchor pair (`safe-storage-seal.ts`,
 * `keyring-anchor.ts`): the file is sealed with the key the OS holds for the
 * app, and a freshness anchor in the OS credential store carries the install
 * secret and an epoch the file must match. A file that opens but carries an
 * older epoch is a rollback; one that opens with another install secret is a
 * foreign copy; one that does not open was edited or sealed elsewhere. None of
 * those is "standalone": they are `untrusted`, the record is left exactly
 * where it is, and only the explicit recovery path (`clear` with the
 * installation named and the untrusted state acknowledged) removes it.
 *
 * Persistent managed authority is refused outright when the custody is not
 * protected: no OS encryption, Linux `basic_text`, the built-in obscuring key,
 * or no credential store for the anchor. A store in that state reads
 * `unprotected`, never writes, and never clears what an earlier protected run
 * wrote. There is no session-only mode: an enrollment that lives only in
 * memory would be one that a restart silently loses.
 *
 * Everything that changes the record runs inside `exclusive`, one at a time,
 * so an enroll and a revoke cannot interleave on the same file. Tests inject a
 * fake seal and anchor; nothing here touches the developer's keyring.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { createKeyedWriteQueue } from '../../shared/keyedWriteQueue';
import type {
	ManagedIdentityEndpointRef,
	ManagedIdentityManagement,
	ManagedIdentityRecord,
	ManagedIdentityRegistration,
	ManagedIdentityView,
} from '../../shared/maestro-lib/managed/endpoint-port';
import type { AnchorStore } from '../utils/keyring-anchor';
import { sealProtectionProblem, type SealProvider } from '../utils/safe-storage-seal';

export const ENTERPRISE_IDENTITY_VERSION = 1 as const;
/** Sealed bytes, never JSON: a `.bin` so nothing lists it as a config file. */
export const ENTERPRISE_IDENTITY_FILE_NAME = 'enterprise-identity.bin';
/** The anchor's service name; the account is per data directory (`anchorAccountForDirectory`). */
export const ENTERPRISE_IDENTITY_ANCHOR_SERVICE = 'com.maestro.enterprise-identity';
/** A sealed file larger than this is not ours. */
const MAX_FILE_BYTES = 64 * 1024;
const MAX_ID_LENGTH = 256;

/**
 * The record shapes are the library's (`managed/endpoint-port.ts`), so a headless
 * host and the desktop hold the same thing; this module is their sealed home.
 */
export type EnterpriseManagementState = ManagedIdentityManagement;
export type EnterpriseEndpointRef = ManagedIdentityEndpointRef;
export type EnterpriseActorRegistration = ManagedIdentityRegistration;
export type EnterprisePolicyObservation = ManagedIdentityRecord['policy'];
export type EnterpriseIdentityRecord = ManagedIdentityRecord;

/** What the sealed file holds: the record plus the two anchor facts. */
interface SealedIdentityFile {
	version: typeof ENTERPRISE_IDENTITY_VERSION;
	installSecret: string;
	epoch: number;
	record: EnterpriseIdentityRecord;
}

export type IdentityCustodyRefusal =
	| 'encryption-unavailable'
	| 'anchor-unavailable'
	| 'seal-not-protected';

export type IdentityCustodyState =
	| { state: 'protected' }
	| { state: 'unprotected'; reason: IdentityCustodyRefusal; message: string };

export type IdentityUntrustedReason =
	| 'anchor-missing'
	| 'foreign'
	| 'rollback'
	| 'unsealable'
	| 'malformed';

export type IdentityRead =
	| { status: 'none' }
	| { status: 'ok'; record: EnterpriseIdentityRecord; epoch: number }
	| {
			status: 'unprotected';
			reason: IdentityCustodyRefusal;
			message: string;
			/** A file from an earlier, protected run is still there; it is not read. */
			fileExists: boolean;
	  }
	| { status: 'untrusted'; reason: IdentityUntrustedReason; message: string };

export type IdentityWriteInput = Omit<EnterpriseIdentityRecord, 'version' | 'updatedAt'>;

export type IdentityClearInput = {
	installationId: string;
	/** Required to remove an `untrusted` file; without it the record is kept for inspection. */
	acknowledgeUntrusted?: boolean;
};

export type IdentityClearOutcome =
	| { ok: true; removed: boolean }
	| {
			ok: false;
			reason: 'unprotected' | 'installation-mismatch' | 'untrusted' | 'write-failed';
			message: string;
	  };

export interface EnterpriseIdentityStore {
	readonly file: string;
	custody(): IdentityCustodyState;
	read(): IdentityRead;
	/**
	 * Seal and anchor `input` as the current record, at the next epoch. Throws
	 * when custody is not protected or the file is untrusted (nothing is
	 * overwritten by guessing) or the credential store refuses the anchor.
	 */
	write(input: IdentityWriteInput): Promise<EnterpriseIdentityRecord>;
	/** Remove the record and its anchor, naming the installation it enrolls. */
	clear(input: IdentityClearInput): Promise<IdentityClearOutcome>;
	/** Serialize lifecycle work on this file. Re-entrant calls deadlock; do not nest. */
	exclusive<T>(work: () => Promise<T>): Promise<T>;
}

export interface EnterpriseIdentityStoreDeps {
	file: string;
	seal: SealProvider;
	anchor: AnchorStore;
	platform?: NodeJS.Platform;
	now?: () => number;
	newSecret?: () => string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);
const isId = (value: unknown): value is string =>
	typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH;
const isIdOrNull = (value: unknown): value is string | null => value === null || isId(value);
const isRevision = (value: unknown): value is number | null =>
	value === null || (typeof value === 'number' && Number.isInteger(value) && value >= 0);
const MANAGEMENT_STATES: readonly EnterpriseManagementState[] = [
	'enrolled',
	'suspended',
	'revoked',
	'retired',
];

/** Structural problems with a value offered as a record; empty when the shape is right. */
export function enterpriseIdentityProblems(value: unknown): string[] {
	if (!isRecord(value)) return ['record is not an object'];
	const problems: string[] = [];
	if (value.version !== ENTERPRISE_IDENTITY_VERSION) problems.push('version is not 1');
	for (const key of [
		'installationId',
		'tenantId',
		'orgId',
		'enrollmentId',
		'enrolledAt',
		'updatedAt',
	] as const) {
		if (!isId(value[key])) problems.push(`${key} is not an id`);
	}
	if (!MANAGEMENT_STATES.includes(value.management as EnterpriseManagementState)) {
		problems.push('management is not a management state');
	}
	const endpoint = value.endpoint;
	if (!isRecord(endpoint)) problems.push('endpoint is not an object');
	else {
		if (!isId(endpoint.socketPath) || !path.isAbsolute(endpoint.socketPath)) {
			problems.push('endpoint.socketPath is not an absolute path');
		}
		if (!isId(endpoint.bindingDigest)) problems.push('endpoint.bindingDigest is not an id');
		if (!isIdOrNull(endpoint.trustRootDigest)) {
			problems.push('endpoint.trustRootDigest is not an id or null');
		}
	}
	const registration = value.registration;
	if (registration !== null) {
		if (!isRecord(registration)) problems.push('registration is not an object or null');
		else {
			const keys = [
				'challengeId',
				'runtimeId',
				'processEpoch',
				'bindingDigest',
				'challengeDigest',
				'expiresAt',
				'registeredAt',
			] as const;
			for (const key of keys) {
				if (!isId(registration[key])) problems.push(`registration.${key} is not an id`);
			}
			for (const key of ['actorId', 'processBirthDigest'] as const) {
				if (!isIdOrNull(registration[key]))
					problems.push(`registration.${key} is not an id or null`);
			}
		}
	}
	const policy = value.policy;
	if (!isRecord(policy)) problems.push('policy is not an object');
	else {
		if (!isRevision(policy.desiredRevision))
			problems.push('policy.desiredRevision is not a revision');
		if (!isRevision(policy.appliedRevision))
			problems.push('policy.appliedRevision is not a revision');
		if (!isIdOrNull(policy.observedAt))
			problems.push('policy.observedAt is not a timestamp or null');
	}
	return problems;
}

function isSealedFile(value: unknown): value is SealedIdentityFile {
	return (
		isRecord(value) &&
		value.version === ENTERPRISE_IDENTITY_VERSION &&
		typeof value.installSecret === 'string' &&
		value.installSecret.length > 0 &&
		typeof value.epoch === 'number' &&
		Number.isInteger(value.epoch) &&
		value.epoch >= 0 &&
		enterpriseIdentityProblems(value.record).length === 0
	);
}

export function createEnterpriseIdentityStore(
	deps: EnterpriseIdentityStoreDeps
): EnterpriseIdentityStore {
	const now = deps.now ?? (() => Date.now());
	const newSecret = deps.newSecret ?? (() => randomBytes(32).toString('base64url'));
	const queue = createKeyedWriteQueue();

	function custody(): IdentityCustodyState {
		const sealProblem = sealProtectionProblem(deps.seal, deps.platform);
		if (sealProblem !== null) {
			const reason: IdentityCustodyRefusal = deps.seal.available()
				? 'seal-not-protected'
				: 'encryption-unavailable';
			return { state: 'unprotected', reason, message: sealProblem };
		}
		if (!deps.anchor.available()) {
			return {
				state: 'unprotected',
				reason: 'anchor-unavailable',
				message:
					'No OS credential store holds a freshness anchor, so a rollback could not be told from the newest record.',
			};
		}
		return { state: 'protected' };
	}

	function fileExists(): boolean {
		try {
			return fs.statSync(deps.file).isFile();
		} catch {
			return false;
		}
	}

	function read(): IdentityRead {
		const state = custody();
		if (state.state === 'unprotected') {
			return {
				status: 'unprotected',
				reason: state.reason,
				message: state.message,
				fileExists: fileExists(),
			};
		}
		let blob: Buffer;
		try {
			blob = fs.readFileSync(deps.file);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === 'ENOENT' || code === 'ENOTDIR') return { status: 'none' };
			return {
				status: 'untrusted',
				reason: 'unsealable',
				message: `${deps.file} cannot be read: ${code ?? String(error)}`,
			};
		}
		const anchor = deps.anchor.read();
		if (!anchor) {
			return {
				status: 'untrusted',
				reason: 'anchor-missing',
				message: `${deps.file} exists and the credential store holds no anchor for it; it may be an older copy.`,
			};
		}
		if (blob.length > MAX_FILE_BYTES) {
			return {
				status: 'untrusted',
				reason: 'malformed',
				message: `${deps.file} is ${blob.length} bytes, larger than any record this store writes.`,
			};
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(deps.seal.unseal(blob));
		} catch {
			return {
				status: 'untrusted',
				reason: 'unsealable',
				message: `${deps.file} does not open with this app's key; it was edited or sealed elsewhere.`,
			};
		}
		if (!isSealedFile(parsed)) {
			return {
				status: 'untrusted',
				reason: 'malformed',
				message: `${deps.file} opened but does not hold an enterprise identity record.`,
			};
		}
		if (parsed.installSecret !== anchor.installSecret) {
			return {
				status: 'untrusted',
				reason: 'foreign',
				message: `${deps.file} was sealed under another install secret than the anchor holds.`,
			};
		}
		if (parsed.epoch !== anchor.epoch) {
			return {
				status: 'untrusted',
				reason: 'rollback',
				message: `${deps.file} is at epoch ${parsed.epoch}; the anchor is at ${anchor.epoch}. An older copy was put back.`,
			};
		}
		return { status: 'ok', record: parsed.record, epoch: parsed.epoch };
	}

	function persist(sealed: SealedIdentityFile): void {
		// Anchor first: a locked credential store throws here, before a file the
		// anchor cannot vouch for exists.
		deps.anchor.write({ installSecret: sealed.installSecret, epoch: sealed.epoch });
		fs.mkdirSync(path.dirname(deps.file), { recursive: true });
		const tmp = `${deps.file}.tmp`;
		fs.writeFileSync(tmp, deps.seal.seal(JSON.stringify(sealed)), { mode: 0o600 });
		fs.renameSync(tmp, deps.file);
	}

	async function write(input: IdentityWriteInput): Promise<EnterpriseIdentityRecord> {
		const state = custody();
		if (state.state === 'unprotected') {
			throw new Error(`Enterprise identity cannot be kept: ${state.message}`);
		}
		const current = read();
		if (current.status === 'untrusted') {
			throw new Error(
				`Enterprise identity is not written over an untrusted record (${current.reason}): ${current.message}`
			);
		}
		const record: EnterpriseIdentityRecord = {
			...input,
			version: ENTERPRISE_IDENTITY_VERSION,
			updatedAt: new Date(now()).toISOString(),
		};
		const problems = enterpriseIdentityProblems(record);
		if (problems.length > 0) {
			throw new Error(`Enterprise identity record is malformed: ${problems.join('; ')}`);
		}
		if (current.status === 'ok' && current.record.installationId !== record.installationId) {
			throw new Error(
				`Enterprise identity enrolls installation ${current.record.installationId}, not ${record.installationId}.`
			);
		}
		const anchor = deps.anchor.read();
		const sealed: SealedIdentityFile = {
			version: ENTERPRISE_IDENTITY_VERSION,
			installSecret: current.status === 'ok' && anchor ? anchor.installSecret : newSecret(),
			epoch: current.status === 'ok' ? current.epoch + 1 : 0,
			record,
		};
		persist(sealed);
		return record;
	}

	async function clear(input: IdentityClearInput): Promise<IdentityClearOutcome> {
		const current = read();
		switch (current.status) {
			case 'unprotected':
				return {
					ok: false,
					reason: 'unprotected',
					message: `${current.message} Nothing is removed while custody cannot be verified.`,
				};
			case 'none':
				return { ok: true, removed: false };
			case 'untrusted':
				if (!input.acknowledgeUntrusted) {
					return {
						ok: false,
						reason: 'untrusted',
						message: `${current.message} Acknowledge the untrusted record to remove it.`,
					};
				}
				break;
			case 'ok':
				if (current.record.installationId !== input.installationId) {
					return {
						ok: false,
						reason: 'installation-mismatch',
						message: `The record enrolls ${current.record.installationId}, not ${input.installationId}.`,
					};
				}
				break;
		}
		try {
			fs.rmSync(deps.file, { force: true });
			deps.anchor.clear();
		} catch (error) {
			return {
				ok: false,
				reason: 'write-failed',
				message: error instanceof Error ? error.message : String(error),
			};
		}
		return { ok: true, removed: true };
	}

	return {
		file: deps.file,
		custody,
		read,
		write: (input) => queue.enqueue(deps.file, () => write(input)),
		clear: (input) => queue.enqueue(deps.file, () => clear(input)),
		exclusive: (work) => queue.enqueue(deps.file, work),
	};
}

/**
 * The record as a renderer, a log line or a status answer may see it. It is
 * already free of secrets, so this is the same shape with the file's own
 * facts (epoch, install secret) left out; it exists so every surface that
 * shows the identity shows the one projection.
 */
export function publicEnterpriseIdentity(read: IdentityRead): ManagedIdentityView {
	switch (read.status) {
		case 'ok':
			return { status: 'ok', reason: null, message: null, record: structuredClone(read.record) };
		case 'none':
			return { status: 'none', reason: null, message: null, record: null };
		case 'unprotected':
		case 'untrusted':
			return { status: read.status, reason: read.reason, message: read.message, record: null };
	}
}
