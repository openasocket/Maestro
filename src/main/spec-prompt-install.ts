/**
 * The spec tool prompt refreshers (Spec Kit, OpenSpec, BMAD) under the install
 * ceiling (MRC2-04-08). Each refresh downloads prompt sources from GitHub and
 * writes them into the user data directory, where every agent reads them as
 * its instructions. Standalone, a refresh fetches the latest release as it
 * always did and nothing here is consulted. Under management every file is
 * held BEFORE the first request (so a refusal makes no network call and no
 * write), fetched from the pin's source instead of "latest", and held again by
 * the digest of the bytes received before anything is written; one refusal
 * fails the whole refresh, so a prompt directory is never half updated. The
 * raw `fetchWithTimeout` egress of the three refreshers is not held here: no
 * egress policy exists until P2-05.
 */

import { createHash } from 'crypto';
import {
	INSTALL_OPERATOR,
	InstallRefusedError,
	type InstallActor,
	type InstallArtifact,
	type InstallAuthority,
} from './enterprise/install-policy';

export type SpecPromptArtifact = Extract<
	InstallArtifact,
	'speckit-prompts' | 'openspec-prompts' | 'bmad-prompts'
>;

/** How a refresh was asked for: the transport the IPC call was admitted over, else the operator. */
export interface SpecPromptRefreshOptions {
	actor?: InstallActor;
}

let installAuthority: InstallAuthority | null = null;

/** The desktop hands the one install ceiling source over at startup; null holds nothing (standalone). */
export function setSpecPromptInstallAuthority(authority: InstallAuthority | null): void {
	installAuthority = authority;
}

/** One file a refresh downloads: a bare name and, when the refresher fixes the ref itself, the exact URL. */
export interface SpecPromptFile {
	file: string;
	source?: string;
}

/** Standalone: the refresher picks its URLs. Managed: the pinned source of every held file. */
export type SpecPromptHold =
	| { managed: false }
	| { managed: true; sources: ReadonlyMap<string, string> };

/**
 * Hold every fetch of a refresh before its first request. Throws
 * `InstallRefusedError` on the first file the ceiling does not pin.
 */
export function holdSpecPromptFetches(
	artifact: SpecPromptArtifact,
	files: readonly SpecPromptFile[],
	options: SpecPromptRefreshOptions = {}
): SpecPromptHold {
	if (!installAuthority) return { managed: false };
	const actor = options.actor ?? INSTALL_OPERATOR;
	const sources = new Map<string, string>();
	let managed = false;
	for (const { file, source } of files) {
		const decision = installAuthority.authorize({ artifact, file, stage: 'fetch', source, actor });
		if (!decision.allowed) throw new InstallRefusedError(decision);
		// Standalone answers with no pin; a managed fetch is admitted only with a pin that names a source.
		const pinned = decision.pin?.source;
		if (!pinned) continue;
		managed = true;
		sources.set(file, pinned);
	}
	return managed ? { managed: true, sources } : { managed: false };
}

/** The URL a held file is fetched from: the pin's under management, the refresher's own otherwise. */
export function specPromptSource(hold: SpecPromptHold, file: string, latest: () => string): string {
	const pinned = hold.managed ? hold.sources.get(file) : undefined;
	return pinned ?? latest();
}

/**
 * Hold the bytes a fetch returned before they are transformed or written.
 * Standalone nothing is digested; managed the digest must be the pinned one.
 */
export function holdSpecPromptBytes(
	artifact: SpecPromptArtifact,
	file: string,
	bytes: string,
	options: SpecPromptRefreshOptions & { source?: string } = {}
): void {
	if (!installAuthority) return;
	const decision = installAuthority.authorize({
		artifact,
		file,
		stage: 'execute',
		digest: () => createHash('sha256').update(bytes, 'utf8').digest('hex'),
		source: options.source,
		actor: options.actor ?? INSTALL_OPERATOR,
	});
	if (!decision.allowed) throw new InstallRefusedError(decision);
}

/** The ref segment of a `raw.githubusercontent.com/<owner>/<repo>/<ref>/...` source, for the metadata a pinned refresh records. */
export function specPromptSourceRef(source: string | undefined): string | null {
	if (!source) return null;
	try {
		const url = new URL(source);
		if (url.hostname !== 'raw.githubusercontent.com') return null;
		const [owner, repo, ref, ...rest] = url.pathname.split('/').filter(Boolean);
		return owner && repo && ref && rest.length > 0 ? ref : null;
	} catch {
		return null;
	}
}
