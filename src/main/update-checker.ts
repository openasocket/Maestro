/**
 * Update checker for Maestro
 * Fetches release information from GitHub API to check for updates
 *
 * It is also where a managed desktop holds its roll-forward (MRC2-05-04):
 * when an update authority is installed (`setUpdateAuthority()`, called once
 * at app-ready with the source from `src/main/enterprise/update-policy.ts`)
 * the feed is consulted only if the ceiling allows it, a stable channel caps
 * the person's prerelease opt-in, and every newer release is held on its own
 * (a pin admits one) BEFORE it is offered. A held release is reported by name
 * in `UpdateCheckResult.held`, never as "up to date" and never as a failed
 * check. With no authority installed (a standalone host, a test) nothing is
 * consulted and the check runs exactly as it always has. The feed request
 * itself leaves as an `updates` request on the egress ceiling.
 */

import { compareVersions } from '../shared/pathUtils';
import { logger } from './utils/logger';
import { fetchWithTimeout } from './utils/fetchWithTimeout';
import type { UpdateAuthority, UpdateHold, UpdateRequest } from './enterprise/update-policy';

// GitHub repository information
const GITHUB_OWNER = 'RunMaestro';
const GITHUB_REPO = 'Maestro';
const RELEASES_URL = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases`;

/** The feed electron-updater's default GitHub provider reads; the URL its requests are held as on the egress ceiling. */
export const RELEASES_ATOM_FEED_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases.atom`;

/** Request budget for the GitHub releases poll. */
const RELEASES_FETCH_TIMEOUT_MS = 15_000;

let updateAuthority: UpdateAuthority | null = null;

/** Install (or, with null, remove) the authority every roll-forward of this process is held with. */
export function setUpdateAuthority(authority: UpdateAuthority | null): void {
	updateAuthority = authority;
}

/**
 * The hold a roll-forward meets, or null when it may proceed. With no
 * authority installed nothing is consulted and the answer is null, so a
 * standalone host never pays for the question.
 */
export function updateHoldFor(request: UpdateRequest): UpdateHold | null {
	if (!updateAuthority) return null;
	const decision = updateAuthority.evaluateUpdate(request);
	if (decision.allowed) return null;
	return {
		code: decision.code,
		message: decision.message,
		policyRevision: decision.managed.policyRevision,
		candidate: request.candidate,
	};
}

/** The one line a hold is logged and answered as (the policy's `formatUpdateRefusal`, spelled here to keep this module a leaf). */
export function formatUpdateHold(hold: Pick<UpdateHold, 'code' | 'message'>): string {
	return `[managed-${hold.code}] ${hold.message}`;
}

/**
 * Build the generic-provider feed URL for a specific release tag.
 *
 * electron-updater's default GitHub provider fetches `releases.atom` to discover
 * the latest version, and that dynamically-generated feed intermittently (and
 * sometimes persistently) returns 504 Gateway Time-out. Release *assets* -
 * including the `latest*.yml` channel files electron-builder publishes - are
 * served from GitHub's reliable CDN instead. Pointing electron-updater at this
 * per-tag download URL via a generic provider sidesteps the atom feed entirely.
 *
 * @param tag The release tag verbatim (e.g. `v1.2.3`), as returned in `tag_name`.
 */
export function getReleaseDownloadFeedUrl(tag: string): string {
	return `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/download/${tag}/`;
}

export interface ReleaseAsset {
	name: string;
	browser_download_url: string;
	size: number;
	content_type: string;
}

export interface Release {
	tag_name: string;
	name: string;
	body: string;
	html_url: string;
	published_at: string;
	prerelease: boolean;
	draft: boolean;
	assets: ReleaseAsset[];
}

export interface UpdateCheckResult {
	currentVersion: string;
	latestVersion: string;
	updateAvailable: boolean;
	versionsBehind: number;
	releases: Release[];
	releasesUrl: string;
	assetsReady: boolean;
	error?: string;
	/** The managed hold on the newest release this host may not roll forward to; absent standalone and when nothing was held. */
	held?: UpdateHold;
}

/**
 * Check if a release has assets available for the current platform
 */
function hasAssetsForPlatform(release: Release): boolean {
	if (!release.assets || release.assets.length === 0) {
		return false;
	}

	const platform = process.platform;
	const assetNames = release.assets.map((a) => a.name.toLowerCase());

	switch (platform) {
		case 'darwin':
			// macOS: look for .dmg or .zip (arm64 or x64)
			return assetNames.some(
				(name) =>
					name.endsWith('.dmg') ||
					(name.endsWith('.zip') && (name.includes('mac') || name.includes('darwin')))
			);
		case 'win32':
			// Windows: look for .exe or .msi
			return assetNames.some((name) => name.endsWith('.exe') || name.endsWith('.msi'));
		case 'linux':
			// Linux: look for .AppImage, .deb, .rpm, or .tar.gz
			return assetNames.some(
				(name) =>
					name.endsWith('.appimage') ||
					name.endsWith('.deb') ||
					name.endsWith('.rpm') ||
					(name.endsWith('.tar.gz') && name.includes('linux'))
			);
		default:
			// Unknown platform, assume assets are ready if any exist
			return release.assets.length > 0;
	}
}

/**
 * Fetch all releases from GitHub API
 * @param includePrerelease - If true, include beta/rc/alpha releases. Default: false (stable only)
 */
async function fetchReleases(includePrerelease: boolean = false): Promise<Release[]> {
	logger.info(
		`Fetching releases from GitHub (includePrerelease: ${includePrerelease})`,
		'UpdateChecker'
	);

	const response = await fetchWithTimeout(
		RELEASES_URL,
		{
			headers: {
				Accept: 'application/vnd.github.v3+json',
				'User-Agent': 'Maestro-Update-Checker',
			},
		},
		RELEASES_FETCH_TIMEOUT_MS,
		'updates'
	);

	if (!response.ok) {
		const errorMsg = `GitHub API error: ${response.status} ${response.statusText}`;
		logger.error(errorMsg, 'UpdateChecker', {
			url: RELEASES_URL,
			status: response.status,
			statusText: response.statusText,
		});
		throw new Error(errorMsg);
	}

	const releases = (await response.json()) as Release[];
	logger.info(`Fetched ${releases.length} total releases from GitHub`, 'UpdateChecker');

	// Filter out drafts (always excluded)
	// Filter out prereleases and prerelease suffixes (-rc, -beta, -alpha) unless includePrerelease is true
	const prereleasePattern = /-(rc|beta|alpha|dev|canary)/i;
	const filtered = releases
		.filter((r) => {
			// Always filter out drafts
			if (r.draft) return false;

			// If including prereleases, allow all non-draft releases
			if (includePrerelease) return true;

			// Otherwise, filter out prereleases and releases with prerelease suffixes
			return !r.prerelease && !prereleasePattern.test(r.tag_name);
		})
		.sort((a, b) => compareVersions(b.tag_name, a.tag_name));

	const filteredOut = releases.length - filtered.length;
	logger.info(
		`After filtering: ${filtered.length} eligible releases (${filteredOut} excluded as drafts/prereleases)`,
		'UpdateChecker',
		{ versions: filtered.map((r) => r.tag_name) }
	);

	return filtered;
}

/**
 * Get releases that are newer than the current version
 */
function getNewerReleases(currentVersion: string, releases: Release[]): Release[] {
	return releases.filter((r) => compareVersions(r.tag_name, currentVersion) > 0);
}

/**
 * Check for updates
 * @param currentVersion - The current app version
 * @param includePrerelease - If true, include beta/rc/alpha releases. Default: false (stable only)
 */
export async function checkForUpdates(
	currentVersion: string,
	includePrerelease: boolean = false
): Promise<UpdateCheckResult> {
	const releasesUrl = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases`;
	const nothing: UpdateCheckResult = {
		currentVersion,
		latestVersion: currentVersion,
		updateAvailable: false,
		versionsBehind: 0,
		releases: [],
		releasesUrl,
		assetsReady: false,
	};

	// The update ceiling answers before any feed is read: a hold ends the check
	// by name, and a stable channel caps the person's prerelease opt-in instead
	// of consulting a prerelease feed. Standalone this asks nothing.
	let effectivePrerelease = includePrerelease;
	const gate = updateHoldFor({
		current: currentVersion,
		candidate: null,
		prerelease: includePrerelease,
	});
	if (gate && gate.code === 'channel-denied') {
		logger.info(
			`Prerelease feed capped to stable by the managed update ceiling: ${formatUpdateHold(gate)}`,
			'UpdateChecker'
		);
		effectivePrerelease = false;
	} else if (gate) {
		logger.info(`Update check held: ${formatUpdateHold(gate)}`, 'UpdateChecker');
		return { ...nothing, held: gate };
	}

	logger.info(
		`Checking for updates (current: ${currentVersion}, includePrerelease: ${effectivePrerelease}, platform: ${process.platform})`,
		'UpdateChecker'
	);

	try {
		const allReleases = await fetchReleases(effectivePrerelease);

		if (allReleases.length === 0) {
			logger.info('No eligible releases found on GitHub', 'UpdateChecker');
			return nothing;
		}

		// Every newer release is held on its own: a pin admits exactly one, and
		// the hold reported is the newest release this host may not move to.
		const newerReleases = getNewerReleases(currentVersion, allReleases);
		const admitted: Release[] = [];
		let held: UpdateHold | undefined;
		for (const release of newerReleases) {
			const hold = updateHoldFor({ current: currentVersion, candidate: release.tag_name });
			if (hold) held ??= hold;
			else admitted.push(release);
		}
		if (held) {
			logger.info(
				`${newerReleases.length - admitted.length} newer release(s) held by the managed update ceiling: ${formatUpdateHold(held)}`,
				'UpdateChecker'
			);
		}

		// What the modal shows as latest, and whose assets are checked: the newest
		// admitted release, or (with nothing held) the newest release as before.
		const top = admitted[0] ?? (held ? null : allReleases[0]);
		const latestVersion = top ? top.tag_name.replace(/^v/, '') : currentVersion;
		const versionsBehind = admitted.length;
		const updateAvailable = versionsBehind > 0;
		const assetsReady = top !== null && hasAssetsForPlatform(top);

		if (updateAvailable) {
			logger.info(
				`Update available: ${currentVersion} → ${latestVersion} (${versionsBehind} version(s) behind, assets ready: ${assetsReady})`,
				'UpdateChecker',
				{ newerVersions: admitted.map((r) => r.tag_name) }
			);
		} else {
			logger.info(
				`Already up to date (current: ${currentVersion}, latest: ${latestVersion})`,
				'UpdateChecker'
			);
		}

		return {
			...nothing,
			latestVersion,
			updateAvailable,
			versionsBehind,
			releases: admitted,
			assetsReady,
			...(held ? { held } : {}),
		};
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : 'Unknown error';
		logger.error(`Update check failed: ${errorMessage}`, 'UpdateChecker', {
			currentVersion,
			includePrerelease: effectivePrerelease,
			stack: error instanceof Error ? error.stack : undefined,
		});
		return { ...nothing, error: errorMessage };
	}
}
