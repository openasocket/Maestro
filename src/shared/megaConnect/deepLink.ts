/**
 * Connect deep links: maestro://join and maestro://connect.
 *
 *   maestro://join?server=<host>&code=<join code>
 *   maestro://connect?server=<host>&team=<team code>
 *
 * A deep link only PREFILLS the Connect to your organization form. It never
 * connects, enrolls or approves anything (invariant SX3): main parses it,
 * sends the prefill to the renderer on MEGA_CONNECT_PREFILL_CHANNEL, and the
 * person still presses Connect.
 *
 * Every field goes through the shape validators in ./input. Anything else
 * (an unknown or repeated parameter, an oversized URL, a bad host or code)
 * returns null. Pure, so it runs in main and in tests.
 *
 * An https join link pasted as text is not a deep link; validateJoinLink
 * handles that in the panel.
 */

import { validateJoinCode, validateServerHost, validateTeamCode } from './input';

export const MEGA_CONNECT_PREFILL_CHANNEL = 'megaConnect:prefill';

/** Same ceiling as a pasted join link. */
export const MEGA_CONNECT_DEEP_LINK_MAX_LENGTH = 2048;

export type MegaConnectDeepLinkKind = 'join' | 'connect';

export type MegaConnectPrefill =
	| { kind: 'join'; server: string; code: string }
	| { kind: 'connect'; server: string; teamCode: string };

const SCHEME = /^maestro:(\/\/)?/i;

const PARAMS: Record<MegaConnectDeepLinkKind, readonly string[]> = {
	join: ['server', 'code'],
	connect: ['server', 'team'],
};

function splitLink(url: string): { resource: string; query: string } | null {
	const match = SCHEME.exec(url);
	if (match === null) return null;
	let rest = url.slice(match[0].length);
	const hash = rest.indexOf('#');
	if (hash >= 0) rest = rest.slice(0, hash);
	const q = rest.indexOf('?');
	const path = q >= 0 ? rest.slice(0, q) : rest;
	const query = q >= 0 ? rest.slice(q + 1) : '';
	return { resource: path.replace(/\/+$/, '').toLowerCase(), query };
}

/**
 * Which connect link this is, from the resource name alone, whether or not
 * its fields are valid. Main uses it to keep the URL (which carries a join or
 * team code) out of every log line, including the rejection line.
 */
export function megaConnectDeepLinkKind(url: string): MegaConnectDeepLinkKind | null {
	if (typeof url !== 'string') return null;
	const parts = splitLink(url);
	if (parts === null) return null;
	return parts.resource === 'join' || parts.resource === 'connect' ? parts.resource : null;
}

/** Parse a connect deep link into a prefill, or null when anything is off. */
export function parseMegaConnectDeepLink(url: string): MegaConnectPrefill | null {
	if (typeof url !== 'string' || url.length > MEGA_CONNECT_DEEP_LINK_MAX_LENGTH) return null;
	const kind = megaConnectDeepLinkKind(url);
	if (kind === null) return null;
	const { query } = splitLink(url)!;

	let params: URLSearchParams;
	try {
		params = new URLSearchParams(query);
	} catch {
		return null;
	}
	const allowed = PARAMS[kind];
	const seen = new Set<string>();
	for (const key of params.keys()) {
		if (!allowed.includes(key) || seen.has(key)) return null;
		seen.add(key);
	}
	if (seen.size !== allowed.length) return null;

	const server = validateServerHost(params.get('server') ?? '');
	if (!server.ok) return null;

	if (kind === 'join') {
		const code = validateJoinCode(params.get('code') ?? '');
		return code.ok ? { kind, server: server.value, code: code.value } : null;
	}
	const team = validateTeamCode(params.get('team') ?? '');
	return team.ok ? { kind, server: server.value, teamCode: team.value } : null;
}
