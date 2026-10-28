/**
 * The releases checker under management (MRC2-05-04): the feed leaves as an
 * `updates` request; a hold answers before any feed is read; an enrolled
 * host with no ceiling is held `unavailable`; a pin admits exactly the pinned
 * release and reports the newer one held by name; a host at the pin is kept
 * there with nothing offered; a stable channel caps the person's prerelease
 * opt-in instead of consulting a prerelease feed; an egress refusal of the
 * feed is reported by name; and with no authority installed the check runs
 * exactly as it always has.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IdentityRead } from '../../main/enterprise/identity-store';
import { createEgressPolicySource } from '../../main/enterprise/egress-policy';
import { createUpdatePolicySource } from '../../main/enterprise/update-policy';
import { setEgressAuthority } from '../../main/utils/fetchWithTimeout';
import { checkForUpdates, setUpdateAuthority } from '../../main/update-checker';
import { denyingEgressAuthority } from '../helpers/egressAuthority';

const mockFetch = vi.fn();

function release(tag: string, prerelease = false) {
	return {
		tag_name: tag,
		name: tag,
		body: '',
		html_url: `https://github.com/RunMaestro/Maestro/releases/tag/${tag}`,
		published_at: '2026-01-01T00:00:00Z',
		prerelease,
		draft: false,
		assets: [{ name: 'Maestro.dmg', browser_download_url: '', size: 1, content_type: '' }],
	};
}

function feed(...releases: ReturnType<typeof release>[]) {
	mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve(releases) });
}

function enrolled(): IdentityRead {
	return {
		status: 'ok',
		epoch: 1,
		record: {
			registration: { actorId: 'actor', registeredAt: 1 },
			policy: { appliedRevision: 3, appliedAt: 1 },
		},
	} as never;
}

function updateSource(ceiling: Record<string, unknown> | null) {
	const source = createUpdatePolicySource({
		identity: { read: () => enrolled() },
		policy: () => ({ appliedRevision: 3 }),
	});
	if (ceiling) {
		const outcome = source.install({
			policyRevision: 3,
			hold: false,
			channel: 'stable',
			pin: null,
			...ceiling,
		});
		if (!outcome.installed) throw new Error(outcome.problems.join('; '));
	}
	return source;
}

/** An egress authority that admits everything and records what it was asked. */
function recordingEgress() {
	const source = createEgressPolicySource({
		identity: { read: () => enrolled() },
		policy: () => ({ appliedRevision: 3 }),
	});
	source.install({ policyRevision: 3, classes: [{ class: 'updates', destinations: ['*'] }] });
	return source;
}

describe('checkForUpdates under an update authority', () => {
	const realFetch = global.fetch;

	beforeEach(() => {
		mockFetch.mockReset();
		global.fetch = mockFetch as unknown as typeof fetch;
	});

	afterEach(() => {
		setUpdateAuthority(null);
		setEgressAuthority(null);
		global.fetch = realFetch;
	});

	it('names the feed an updates request and runs as before with no update authority', async () => {
		const egress = recordingEgress();
		const evaluate = vi.spyOn(egress, 'evaluateEgress');
		setEgressAuthority(egress);
		feed(release('v1.2.0-beta', true), release('v1.1.0'), release('v1.0.0'));
		const result = await checkForUpdates('1.0.0', true);
		expect(evaluate).toHaveBeenCalledTimes(1);
		expect(evaluate.mock.calls[0][0]).toMatchObject({
			class: 'updates',
			url: 'https://api.github.com/repos/RunMaestro/Maestro/releases',
		});
		expect(result.updateAvailable).toBe(true);
		expect(result.latestVersion).toBe('1.2.0-beta');
		expect(result.held).toBeUndefined();
	});

	it('holds the check by name before any feed is read when the ceiling holds', async () => {
		setUpdateAuthority(updateSource({ hold: true }));
		const result = await checkForUpdates('1.0.0');
		expect(mockFetch).not.toHaveBeenCalled();
		expect(result.updateAvailable).toBe(false);
		expect(result.error).toBeUndefined();
		expect(result.held).toMatchObject({ code: 'held', policyRevision: 3, candidate: null });
	});

	it('holds an enrolled host with no ceiling unavailable, reading no feed', async () => {
		setUpdateAuthority(updateSource(null));
		const result = await checkForUpdates('1.0.0');
		expect(mockFetch).not.toHaveBeenCalled();
		expect(result.held).toMatchObject({ code: 'unavailable' });
	});

	it('offers exactly the pinned release and reports the newer one held', async () => {
		setUpdateAuthority(updateSource({ pin: '1.2.0' }));
		feed(release('v1.3.0'), release('v1.2.0'), release('v1.1.0'), release('v1.0.0'));
		const result = await checkForUpdates('1.0.0');
		expect(result.updateAvailable).toBe(true);
		expect(result.latestVersion).toBe('1.2.0');
		expect(result.versionsBehind).toBe(1);
		expect(result.releases.map((r) => r.tag_name)).toEqual(['v1.2.0']);
		expect(result.assetsReady).toBe(true);
		expect(result.held).toMatchObject({ code: 'pin-denied', candidate: 'v1.3.0' });
	});

	it('keeps a host at the pin there: nothing offered, the newer release held by name', async () => {
		setUpdateAuthority(updateSource({ pin: 'v1.2.0' }));
		feed(release('v1.3.0'), release('v1.2.0'));
		const result = await checkForUpdates('1.2.0');
		expect(result.updateAvailable).toBe(false);
		expect(result.latestVersion).toBe('1.2.0');
		expect(result.releases).toEqual([]);
		expect(result.assetsReady).toBe(false);
		expect(result.held).toMatchObject({ code: 'pin-denied', candidate: 'v1.3.0' });
	});

	it('caps a prerelease opt-in to the stable channel instead of consulting a prerelease feed', async () => {
		setUpdateAuthority(updateSource({ channel: 'stable' }));
		feed(release('v1.2.0-beta', true), release('v1.1.0'), release('v1.0.0'));
		const result = await checkForUpdates('1.0.0', true);
		expect(mockFetch).toHaveBeenCalledTimes(1);
		expect(result.updateAvailable).toBe(true);
		expect(result.latestVersion).toBe('1.1.0');
		expect(result.releases.map((r) => r.tag_name)).toEqual(['v1.1.0']);
		expect(result.held).toBeUndefined();
	});

	it('reports an egress refusal of the feed by name, as a managed hold and not a network failure', async () => {
		setUpdateAuthority(updateSource({}));
		const { authority, requests } = denyingEgressAuthority('class-denied');
		setEgressAuthority(authority);
		const result = await checkForUpdates('1.0.0');
		expect(mockFetch).not.toHaveBeenCalled();
		expect(requests.map((r) => r.class)).toEqual(['updates']);
		expect(result.updateAvailable).toBe(false);
		expect(result.error).toMatch(/^\[managed-class-denied\] /);
	});
});
