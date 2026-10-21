/**
 * The managed binding: whether this Maestro installation is enrolled with a
 * management peer, and which authority answers for it.
 *
 * Enrollment is a file beside the data-dir lock
 * (`<userData>/maestro-managed-binding.json`, `MANAGED_BINDING_FILE_NAME` in
 * `runtime/data-dir-lock.ts`). It is written only by the process that holds
 * the data directory's single-writer lock, and only through `enroll` /
 * `unenroll`. It outlives everything that is not that explicit call: closing
 * the window, losing the endpoint, restarting the runtime, a renderer that
 * forgets, an environment variable, a session that asks nicely. An enrolled
 * installation that cannot reach its authority is `enrolled-unavailable`: its
 * managed operations answer `unavailable`, never standalone.
 *
 * Four states, and the authority each one answers with:
 *
 *   standalone            No record in this data directory or the production
 *                         one. The injected authority, if any, is used as is.
 *   enrolled              A record, and an injected authority whose id matches
 *                         it. That authority answers.
 *   enrolled-unavailable  A record, and no authority (none injected, or one
 *                         for another binding, or the lock is lost). Every
 *                         admission is `unavailable`.
 *   unreadable            A file that cannot be parsed. Fail closed: treated
 *                         exactly as enrolled-unavailable, since a corrupt
 *                         record is not evidence of standalone.
 *
 * The production data directory is read as well as this one: a development or
 * alternate data directory under an enrolled installation is still that
 * installation, so pointing `MAESTRO_USER_DATA` elsewhere does not opt out.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { canonicalJson } from '../../canonicalJson';
import type { MaestroPaths } from '../paths/resolve';
import { atomicWriteFile } from '../store/atomic-write';
import { MANAGED_BINDING_FILE_NAME, type DataDirVerdict } from '../runtime/data-dir-lock';
import { sha256Hex, unavailableAuthority, type HostAuthority } from './authority';
import {
	MANAGED_CONTRACT_VERSION,
	type ManagedContractVersion,
	type ManagedPolicySource,
} from './types';

/** What is written down. No secret: the endpoint is an opaque reference. */
export interface ManagedBindingRecord {
	contractVersion: ManagedContractVersion;
	installationId: string;
	/** The authority that must answer for this installation (`HostAuthority.authorityId`). */
	authorityId: string;
	/** An opaque reference to the management peer, for the host to look up. */
	endpointRef: string;
	enrolledAt: string;
	policySources: readonly ManagedPolicySource[];
	policyRevision: number | null;
	/** sha256 over every other field, canonical. Tamper evidence, not protection. */
	digest: string;
}

export type ManagedBindingState =
	| { state: 'standalone'; files: readonly string[] }
	| { state: 'enrolled'; record: ManagedBindingRecord; file: string }
	| { state: 'enrolled-unavailable'; record: ManagedBindingRecord; file: string; reason: string }
	| { state: 'unreadable'; file: string; reason: string };

export type ManagedBindingRead =
	| { status: 'none' }
	| { status: 'ok'; record: ManagedBindingRecord }
	| { status: 'unreadable'; reason: string };

export function managedBindingPath(dir: string): string {
	return path.join(dir, MANAGED_BINDING_FILE_NAME);
}

/** The files that can enroll this process: its own data directory first, then the production one. */
export function managedBindingFiles(
	paths: Pick<MaestroPaths, 'userDataDir' | 'productionDataDir'>
): string[] {
	const files = [managedBindingPath(paths.userDataDir)];
	if (paths.productionDataDir !== paths.userDataDir) {
		files.push(managedBindingPath(paths.productionDataDir));
	}
	return files;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);
const isId = (value: unknown): value is string =>
	typeof value === 'string' && value.length > 0 && value.length <= 256;

export function bindingDigest(record: Omit<ManagedBindingRecord, 'digest'>): string {
	const { contractVersion, installationId, authorityId, endpointRef, enrolledAt, policyRevision } =
		record;
	return sha256Hex(
		canonicalJson({
			contractVersion,
			installationId,
			authorityId,
			endpointRef,
			enrolledAt,
			policyRevision,
			policySources: record.policySources,
		})
	);
}

/** The problems with a value offered as a record; empty when it is one and its digest holds. */
export function managedBindingProblems(value: unknown): string[] {
	if (!isRecord(value)) return ['binding is not an object'];
	const problems: string[] = [];
	if (value.contractVersion !== MANAGED_CONTRACT_VERSION) {
		problems.push(`contractVersion is not ${MANAGED_CONTRACT_VERSION}`);
	}
	for (const key of ['installationId', 'authorityId', 'endpointRef', 'enrolledAt'] as const) {
		if (!isId(value[key])) problems.push(`${key} is not an id`);
	}
	if (
		value.policyRevision !== null &&
		(typeof value.policyRevision !== 'number' || !Number.isInteger(value.policyRevision))
	) {
		problems.push('policyRevision is not an integer or null');
	}
	if (!Array.isArray(value.policySources)) problems.push('policySources is not an array');
	else {
		value.policySources.forEach((source, i) => {
			if (!isRecord(source) || !isId(source.id))
				problems.push(`policySources[${i}] is not a source`);
			else if (source.kind !== 'endpoint' && source.kind !== 'cached' && source.kind !== 'local') {
				problems.push(`policySources[${i}].kind is unknown`);
			}
		});
	}
	if (problems.length > 0) return problems;
	const { digest, ...rest } = value as unknown as ManagedBindingRecord;
	if (digest !== bindingDigest(rest)) problems.push('digest does not match the record');
	return problems;
}

export function readManagedBindingFile(file: string): ManagedBindingRead {
	let raw: string;
	try {
		raw = fs.readFileSync(file, 'utf-8');
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === 'ENOENT' || code === 'ENOTDIR') return { status: 'none' };
		return { status: 'unreadable', reason: `${file} cannot be read: ${code ?? String(error)}` };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { status: 'unreadable', reason: `${file} is not JSON` };
	}
	const problems = managedBindingProblems(parsed);
	if (problems.length > 0) {
		return { status: 'unreadable', reason: `${file}: ${problems.join('; ')}` };
	}
	return { status: 'ok', record: parsed as ManagedBindingRecord };
}

export interface ManagedBindingDeps {
	paths: Pick<MaestroPaths, 'userDataDir' | 'productionDataDir'>;
	/** The data-dir lock's verdict: is this process still the single writer? */
	fence(): DataDirVerdict;
	/** The authority the host injected, if it has one. Used only when its id matches the record. */
	authority?: HostAuthority;
	now(): number;
}

export type EnrollInput = Omit<ManagedBindingRecord, 'contractVersion' | 'enrolledAt' | 'digest'>;

export type EnrollOutcome =
	| { ok: true; record: ManagedBindingRecord; file: string }
	| {
			ok: false;
			reason: 'lock-lost' | 'already-enrolled' | 'unreadable' | 'write-failed';
			message: string;
	  };

export type UnenrollOutcome =
	| { ok: true; file: string }
	| {
			ok: false;
			reason: 'lock-lost' | 'not-enrolled' | 'installation-mismatch' | 'write-failed';
			message: string;
	  };

export interface ManagedBinding {
	state(): ManagedBindingState;
	/** Re-read the files. The state is otherwise what was read last. */
	reload(): ManagedBindingState;
	/**
	 * Who answers an admission right now. The injected authority when
	 * standalone, or when enrolled to it and the lock holds; otherwise an
	 * authority that answers `unavailable` and names why.
	 */
	authority(): HostAuthority;
	/** Write the record. Refuses without the lock, over an existing record, or over an unreadable one. */
	enroll(input: EnrollInput): Promise<EnrollOutcome>;
	/** Remove the record, by name. The only way out; nothing implicit leads here. */
	unenroll(input: { installationId: string }): Promise<UnenrollOutcome>;
}

export function createManagedBinding(deps: ManagedBindingDeps): ManagedBinding {
	const files = managedBindingFiles(deps.paths);
	const ownFile = files[0];

	function read(): ManagedBindingState {
		for (const file of files) {
			const found = readManagedBindingFile(file);
			if (found.status === 'none') continue;
			if (found.status === 'unreadable') return { state: 'unreadable', file, reason: found.reason };
			const injected = deps.authority;
			if (!injected) {
				return {
					state: 'enrolled-unavailable',
					record: found.record,
					file,
					reason: `Enrolled with ${found.record.authorityId} and no authority is attached.`,
				};
			}
			if (injected.authorityId !== found.record.authorityId) {
				return {
					state: 'enrolled-unavailable',
					record: found.record,
					file,
					reason: `Enrolled with ${found.record.authorityId}; the attached authority is ${injected.authorityId}.`,
				};
			}
			return { state: 'enrolled', record: found.record, file };
		}
		return { state: 'standalone', files };
	}

	let current = read();

	return {
		state: () => current,
		reload() {
			current = read();
			return current;
		},
		authority() {
			const verdict = deps.fence();
			if (!verdict.ok) return unavailableAuthority(verdict.reason);
			switch (current.state) {
				case 'standalone':
					return deps.authority ?? unavailableAuthority('This host has no authority attached.');
				case 'enrolled':
					return deps.authority ?? unavailableAuthority('This host has no authority attached.');
				case 'enrolled-unavailable':
					return unavailableAuthority(current.reason);
				case 'unreadable':
					return unavailableAuthority(current.reason);
			}
		},
		async enroll(input) {
			const verdict = deps.fence();
			if (!verdict.ok) return { ok: false, reason: 'lock-lost', message: verdict.reason };
			const existing = read();
			if (existing.state === 'unreadable') {
				return { ok: false, reason: 'unreadable', message: existing.reason };
			}
			if (existing.state !== 'standalone') {
				return {
					ok: false,
					reason: 'already-enrolled',
					message: `${existing.file} already enrolls installation ${existing.record.installationId} with ${existing.record.authorityId}.`,
				};
			}
			const base = {
				contractVersion: MANAGED_CONTRACT_VERSION,
				installationId: input.installationId,
				authorityId: input.authorityId,
				endpointRef: input.endpointRef,
				enrolledAt: new Date(deps.now()).toISOString(),
				policySources: [...input.policySources],
				policyRevision: input.policyRevision,
			};
			const record: ManagedBindingRecord = { ...base, digest: bindingDigest(base) };
			try {
				await atomicWriteFile(ownFile, JSON.stringify(record, null, '\t'), { durable: true });
			} catch (error) {
				return {
					ok: false,
					reason: 'write-failed',
					message: error instanceof Error ? error.message : String(error),
				};
			}
			current = read();
			return { ok: true, record, file: ownFile };
		},
		async unenroll(input) {
			const verdict = deps.fence();
			if (!verdict.ok) return { ok: false, reason: 'lock-lost', message: verdict.reason };
			const existing = read();
			if (existing.state === 'standalone') {
				return { ok: false, reason: 'not-enrolled', message: 'This installation is not enrolled.' };
			}
			if (existing.state === 'unreadable') {
				return {
					ok: false,
					reason: 'installation-mismatch',
					message: `${existing.reason}. Repair or remove the file by hand; nothing here guesses.`,
				};
			}
			if (existing.record.installationId !== input.installationId) {
				return {
					ok: false,
					reason: 'installation-mismatch',
					message: `The record enrolls ${existing.record.installationId}, not ${input.installationId}.`,
				};
			}
			if (existing.file !== ownFile) {
				return {
					ok: false,
					reason: 'installation-mismatch',
					message: `The enrollment lives in ${existing.file}; unenroll from that data directory.`,
				};
			}
			try {
				fs.unlinkSync(existing.file);
			} catch (error) {
				return {
					ok: false,
					reason: 'write-failed',
					message: error instanceof Error ? error.message : String(error),
				};
			}
			current = read();
			return { ok: true, file: existing.file };
		},
	};
}
