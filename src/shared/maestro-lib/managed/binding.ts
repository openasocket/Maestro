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
 * The production directory the data directory itself maps to
 * (`resolveProductionDataDir`) is read whatever the caller named as the
 * production directory: a caller's choice can add a directory to read, never
 * take one away.
 *
 * The file is a MIRROR (MCOMP-09-04). Its digest is tamper evidence, not
 * protection: anyone who can write the data directory can write a well-formed
 * record or delete one. The standing a host acts on is the protected custody's
 * (`InstallationStandingSource`: the sealed identity record and its freshness
 * anchor in the OS credential store, as `src/main/enterprise/identity-store.ts`
 * keeps them). When a source is attached, the custody decides and the file is
 * held to it: an enrollment the custody holds and the file lacks is still
 * enrolled (the lock holder writes the mirror); a file the custody does not
 * vouch for supplies no authority; a record the custody holds but cannot open
 * here (unsealable, rolled back, foreign, unprotected on this machine, or
 * removed while its anchor remains) is managed and unavailable; a revoked or
 * suspended record is managed and unavailable; and the only way to
 * standalone is the custody's own authenticated release (a `retired`
 * record), after which `unenroll` removes the stale mirror by name. Without a
 * source (a process that holds no custody at all, a test over the files
 * alone) the file is what is read, as it always was.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { canonicalJson } from '../../canonicalJson';
import type { MaestroPaths } from '../paths/resolve';
import { resolveProductionDataDir } from '../paths/userDataDir';
import { atomicWriteFile } from '../store/atomic-write';
import { MANAGED_BINDING_FILE_NAME, type DataDirVerdict } from '../runtime/data-dir-lock';
import { sha256Hex, unavailableAuthority, type HostAuthority } from './authority';
import type { ManagedIdentityManagement } from './endpoint-port';
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

/**
 * The files that can enroll this process: its own data directory first, then
 * the production directory it maps to, then the production directory the
 * caller named when that is yet another one. A directory is only ever added
 * to the list, so no choice of `productionDataDir` removes one from it.
 */
export function managedBindingFiles(
	paths: Pick<MaestroPaths, 'userDataDir' | 'productionDataDir'>
): string[] {
	const files = [managedBindingPath(paths.userDataDir)];
	for (const dir of [resolveProductionDataDir(paths.userDataDir), paths.productionDataDir]) {
		const file = managedBindingPath(dir);
		if (!files.includes(file)) files.push(file);
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

export type EnrollInput = Omit<ManagedBindingRecord, 'contractVersion' | 'enrolledAt' | 'digest'>;

/**
 * What the protected custody says of this installation, read on every call
 * (MCOMP-09-04). The custody is the sealed identity record and its anchor; a
 * host composes the source over them (`createHostInstallationStanding` in
 * `src/cli/services/host-managed.ts`), and the binding holds its mirror file
 * to the answer. `standalone` means the custody holds nothing for this
 * installation: no record and no anchor, or a record the endpoint retired
 * (the authenticated release). `managed` with an `enrollment` is a record the
 * custody opened and trusts, as the mirror would carry it; `managed` with no
 * `enrollment` is a record it holds but cannot vouch for here, which is never
 * standalone. `detail` is one sentence for a reason or a log line.
 */
export type InstallationStanding =
	| { standing: 'standalone'; detail: string }
	| {
			standing: 'managed';
			enrollment: (EnrollInput & { enrolledAt: string }) | null;
			management: ManagedIdentityManagement | null;
			detail: string;
	  };

export interface InstallationStandingSource {
	read(): InstallationStanding;
}

export interface ManagedBindingDeps {
	paths: Pick<MaestroPaths, 'userDataDir' | 'productionDataDir'>;
	/** The data-dir lock's verdict: is this process still the single writer? */
	fence(): DataDirVerdict;
	/** The authority the host injected, if it has one. Used only when its id matches the record. */
	authority?: HostAuthority;
	/**
	 * The protected custody's own word on this installation. With it the file
	 * is a mirror that can neither supply nor erase the standing; without it
	 * the file is what is read.
	 */
	standing?: InstallationStandingSource;
	now(): number;
}

export type EnrollOutcome =
	| { ok: true; record: ManagedBindingRecord; file: string }
	| {
			ok: false;
			reason: 'lock-lost' | 'already-enrolled' | 'unreadable' | 'custody-mismatch' | 'write-failed';
			message: string;
	  };

export type UnenrollOutcome =
	| { ok: true; file: string }
	| {
			ok: false;
			reason:
				| 'lock-lost'
				| 'not-enrolled'
				| 'installation-mismatch'
				| 'management-required'
				| 'write-failed';
			message: string;
	  };

export interface ManagedBinding {
	state(): ManagedBindingState;
	/** Re-read the files and the custody. The state is otherwise what was read last. */
	reload(): ManagedBindingState;
	/**
	 * Who answers an admission right now. The injected authority when
	 * standalone, or when enrolled to it and the lock holds; otherwise an
	 * authority that answers `unavailable` and names why.
	 */
	authority(): HostAuthority;
	/**
	 * Write the record. Refuses without the lock, over an existing record, over
	 * an unreadable one, and, with a custody attached, for anything but the
	 * enrollment the custody holds.
	 */
	enroll(input: EnrollInput): Promise<EnrollOutcome>;
	/**
	 * Remove the record, by name. The only way out; nothing implicit leads
	 * here, and with a custody attached nothing local does either: while the
	 * custody holds the enrollment the mirror stays.
	 */
	unenroll(input: { installationId: string }): Promise<UnenrollOutcome>;
}

/** What the files alone say, before the custody is heard. */
type MirrorRead =
	| { kind: 'none' }
	| { kind: 'ok'; record: ManagedBindingRecord; file: string }
	| { kind: 'unreadable'; file: string; reason: string };

/** The record the custody's enrollment would be mirrored as, when no file holds it yet. */
function recordOf(enrollment: EnrollInput & { enrolledAt: string }): ManagedBindingRecord {
	const base = {
		contractVersion: MANAGED_CONTRACT_VERSION,
		installationId: enrollment.installationId,
		authorityId: enrollment.authorityId,
		endpointRef: enrollment.endpointRef,
		enrolledAt: enrollment.enrolledAt,
		policySources: [...enrollment.policySources],
		policyRevision: enrollment.policyRevision,
	};
	return { ...base, digest: bindingDigest(base) };
}

export function createManagedBinding(deps: ManagedBindingDeps): ManagedBinding {
	const files = managedBindingFiles(deps.paths);
	const ownFile = files[0];

	function readMirror(): MirrorRead {
		for (const file of files) {
			const found = readManagedBindingFile(file);
			if (found.status === 'none') continue;
			if (found.status === 'unreadable') return { kind: 'unreadable', file, reason: found.reason };
			return { kind: 'ok', record: found.record, file };
		}
		return { kind: 'none' };
	}

	/** The authority rule over a record that is this installation's: the injected one answers only by id. */
	function withAuthority(record: ManagedBindingRecord, file: string): ManagedBindingState {
		const injected = deps.authority;
		if (!injected) {
			return {
				state: 'enrolled-unavailable',
				record,
				file,
				reason: `Enrolled with ${record.authorityId} and no authority is attached.`,
			};
		}
		if (injected.authorityId !== record.authorityId) {
			return {
				state: 'enrolled-unavailable',
				record,
				file,
				reason: `Enrolled with ${record.authorityId}; the attached authority is ${injected.authorityId}.`,
			};
		}
		return { state: 'enrolled', record, file };
	}

	/** The files alone: what every binding read before a custody could be attached. */
	function fromMirror(mirror: MirrorRead): ManagedBindingState {
		switch (mirror.kind) {
			case 'none':
				return { state: 'standalone', files };
			case 'unreadable':
				return { state: 'unreadable', file: mirror.file, reason: mirror.reason };
			case 'ok':
				return withAuthority(mirror.record, mirror.file);
		}
	}

	/** The custody decides; the mirror is held to it. */
	function fromCustody(custody: InstallationStanding, mirror: MirrorRead): ManagedBindingState {
		if (custody.standing === 'standalone') {
			if (mirror.kind !== 'ok') return fromMirror(mirror);
			return {
				state: 'enrolled-unavailable',
				record: mirror.record,
				file: mirror.file,
				reason:
					`${mirror.file} enrolls installation ${mirror.record.installationId} with ${mirror.record.authorityId}, ` +
					`and the protected custody holds no enrollment for this installation (${custody.detail}). ` +
					'A binding file alone supplies no authority; unenroll it by name.',
			};
		}
		if (!custody.enrollment) {
			// Held and not readable here: managed, and nothing answers. A mirror
			// that agrees changes nothing; one that is missing or broken is
			// reported with the custody's own reason.
			if (mirror.kind === 'ok') {
				return {
					state: 'enrolled-unavailable',
					record: mirror.record,
					file: mirror.file,
					reason: custody.detail,
				};
			}
			return {
				state: 'unreadable',
				file: mirror.kind === 'unreadable' ? mirror.file : ownFile,
				reason:
					mirror.kind === 'unreadable'
						? `${custody.detail} The binding file is unreadable too: ${mirror.reason}`
						: custody.detail,
			};
		}
		if (mirror.kind === 'unreadable') return fromMirror(mirror);
		const expected = recordOf(custody.enrollment);
		let record = expected;
		let file = ownFile;
		if (mirror.kind === 'ok') {
			if (
				mirror.record.installationId !== expected.installationId ||
				mirror.record.authorityId !== expected.authorityId
			) {
				return {
					state: 'enrolled-unavailable',
					record: expected,
					file: mirror.file,
					reason:
						`${mirror.file} enrolls installation ${mirror.record.installationId} with ${mirror.record.authorityId}; ` +
						`the protected custody enrolls ${expected.installationId} with ${expected.authorityId}. ` +
						'The binding file is stale and supplies no authority.',
				};
			}
			record = mirror.record;
			file = mirror.file;
		}
		if (custody.management === 'revoked' || custody.management === 'suspended') {
			return {
				state: 'enrolled-unavailable',
				record,
				file,
				reason: `Management of this installation is ${custody.management} (${custody.detail}). It stays managed; nothing runs under it until the endpoint says otherwise.`,
			};
		}
		return withAuthority(record, file);
	}

	function read(): ManagedBindingState {
		const mirror = readMirror();
		const custody = deps.standing?.read();
		return custody ? fromCustody(custody, mirror) : fromMirror(mirror);
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
			const mirror = readMirror();
			if (mirror.kind === 'unreadable') {
				return { ok: false, reason: 'unreadable', message: mirror.reason };
			}
			if (mirror.kind === 'ok') {
				return {
					ok: false,
					reason: 'already-enrolled',
					message: `${mirror.file} already enrolls installation ${mirror.record.installationId} with ${mirror.record.authorityId}.`,
				};
			}
			const custody = deps.standing?.read();
			if (custody) {
				// The mirror carries what the custody holds, and nothing else.
				if (custody.standing !== 'managed' || !custody.enrollment) {
					return {
						ok: false,
						reason: 'custody-mismatch',
						message: `The protected custody holds no enrollment a binding file may mirror: ${custody.detail}`,
					};
				}
				if (
					custody.enrollment.installationId !== input.installationId ||
					custody.enrollment.authorityId !== input.authorityId
				) {
					return {
						ok: false,
						reason: 'custody-mismatch',
						message: `The protected custody enrolls installation ${custody.enrollment.installationId} with ${custody.enrollment.authorityId}, not ${input.installationId} with ${input.authorityId}.`,
					};
				}
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
			const mirror = readMirror();
			if (mirror.kind === 'none') {
				return { ok: false, reason: 'not-enrolled', message: 'This installation is not enrolled.' };
			}
			if (mirror.kind === 'unreadable') {
				return {
					ok: false,
					reason: 'installation-mismatch',
					message: `${mirror.reason}. Repair or remove the file by hand; nothing here guesses.`,
				};
			}
			if (mirror.record.installationId !== input.installationId) {
				return {
					ok: false,
					reason: 'installation-mismatch',
					message: `The record enrolls ${mirror.record.installationId}, not ${input.installationId}.`,
				};
			}
			if (mirror.file !== ownFile) {
				return {
					ok: false,
					reason: 'installation-mismatch',
					message: `The enrollment lives in ${mirror.file}; unenroll from that data directory.`,
				};
			}
			const custody = deps.standing?.read();
			if (custody?.standing === 'managed') {
				return {
					ok: false,
					reason: 'management-required',
					message:
						`Management of this installation is ${custody.management ?? 'held by the protected custody'} (${custody.detail}). ` +
						"Release is the endpoint administrator's, through an authenticated retire; the binding file is not where it is switched off.",
				};
			}
			try {
				fs.unlinkSync(mirror.file);
			} catch (error) {
				return {
					ok: false,
					reason: 'write-failed',
					message: error instanceof Error ? error.message : String(error),
				};
			}
			current = read();
			return { ok: true, file: mirror.file };
		},
	};
}
