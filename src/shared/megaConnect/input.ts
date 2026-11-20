/**
 * Shape checks for what a person types into Connect to your organization: a
 * work email, a join link, a team code, a server host. Pure, so main validates
 * every renderer input with the same rules the panel uses as a hint.
 *
 * These are SHAPE checks only. The authoritative check moves to the contracts
 * 0.5.0 schemas in MSX-02-09; until then main runs these before anything leaves
 * the process.
 *
 * A rejection carries a reason code and never the rejected value: a join code
 * or a team code must not reach a log line through an error message.
 */

import { megaServerHostProblem } from '../megaServer';

export type MegaConnectInputReason =
	| 'empty'
	| 'tooLong'
	| 'notAscii'
	| 'badEmail'
	| 'notUrl'
	| 'notHttps'
	| 'credentials'
	| 'badPort'
	| 'badHost'
	| 'badPath'
	| 'badCode'
	| 'badTeamCode';

export type MegaConnectInputResult<T> =
	| { ok: true; value: T }
	| { ok: false; reason: MegaConnectInputReason };

/** A join link that passed its shape check. */
export interface MegaJoinLink {
	/** The normalized https URL, without a fragment. */
	url: string;
	/** The server host, lowercased, without brackets. */
	host: string;
	code: string;
}

export const WORK_EMAIL_MAX_LENGTH = 254;
export const JOIN_LINK_MAX_LENGTH = 2048;
export const TEAM_CODE_MIN_LENGTH = 8;
export const TEAM_CODE_MAX_LENGTH = 64;

const ASCII_PRINTABLE = /^[\x21-\x7e]+$/;
const EMAIL_LOCAL = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/;
const DOMAIN_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const JOIN_PATH = /^\/join\/([A-Za-z0-9_-]{20,64})\/?$/;
const TEAM_CODE = /^[A-Z0-9]+(-[A-Z0-9]+)+$/;

function fail<T>(reason: MegaConnectInputReason): MegaConnectInputResult<T> {
	return { ok: false, reason };
}

/** A work email: ASCII, one @, a dotted domain, at most 254 characters. Lowercased. */
export function validateWorkEmail(input: string): MegaConnectInputResult<string> {
	const email = input.trim();
	if (email.length === 0) return fail('empty');
	if (email.length > WORK_EMAIL_MAX_LENGTH) return fail('tooLong');
	if (!ASCII_PRINTABLE.test(email)) return fail('notAscii');
	const lower = email.toLowerCase();
	const parts = lower.split('@');
	if (parts.length !== 2) return fail('badEmail');
	const [local, domain] = parts;
	if (
		!EMAIL_LOCAL.test(local) ||
		local.startsWith('.') ||
		local.endsWith('.') ||
		local.includes('..')
	)
		return fail('badEmail');
	const labels = domain.split('.');
	if (labels.length < 2 || !labels.every((label) => DOMAIN_LABEL.test(label)))
		return fail('badEmail');
	return { ok: true, value: lower };
}

/** A server host: what megaServerHostProblem accepts. Lowercased. */
export function validateServerHost(input: string): MegaConnectInputResult<string> {
	const host = input.trim();
	if (host.length === 0) return fail('empty');
	if (!ASCII_PRINTABLE.test(host)) return fail('notAscii');
	if (megaServerHostProblem(host) !== null) return fail('badHost');
	return { ok: true, value: host.toLowerCase() };
}

/**
 * A join link: `https://<host>/join/<code>`, the code 20 to 64 URL-safe
 * characters. No credentials, and port 443 unless the host is localhost. A
 * query (an issuer pin, say) is kept; a fragment is dropped.
 */
export function validateJoinLink(input: string): MegaConnectInputResult<MegaJoinLink> {
	const text = input.trim();
	if (text.length === 0) return fail('empty');
	if (text.length > JOIN_LINK_MAX_LENGTH) return fail('tooLong');
	if (!ASCII_PRINTABLE.test(text)) return fail('notAscii');
	let url: URL;
	try {
		url = new URL(text);
	} catch {
		return fail('notUrl');
	}
	if (url.protocol !== 'https:') return fail('notHttps');
	if (url.username !== '' || url.password !== '') return fail('credentials');
	const host = url.hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase();
	if (megaServerHostProblem(host) !== null) return fail('badHost');
	// URL drops the scheme's default port, so an empty port means 443.
	if (url.port !== '' && url.port !== '443' && host !== 'localhost') return fail('badPort');
	const match = JOIN_PATH.exec(url.pathname);
	if (match === null) return fail(url.pathname.startsWith('/join/') ? 'badCode' : 'badPath');
	url.hash = '';
	return { ok: true, value: { url: url.toString(), host, code: match[1] } };
}

/**
 * A team code (ACME-WEB-7K3M): uppercase letters and digits in dash-separated
 * groups, at least 8 characters. Typed lowercase is uppercased first.
 */
export function validateTeamCode(input: string): MegaConnectInputResult<string> {
	const typed = input.trim();
	if (typed.length === 0) return fail('empty');
	if (typed.length > TEAM_CODE_MAX_LENGTH) return fail('tooLong');
	// ASCII before uppercasing: 'ß'.toUpperCase() is 'SS', which would pass.
	if (!ASCII_PRINTABLE.test(typed)) return fail('notAscii');
	const code = typed.toUpperCase();
	if (code.length < TEAM_CODE_MIN_LENGTH || !TEAM_CODE.test(code)) return fail('badTeamCode');
	return { ok: true, value: code };
}
