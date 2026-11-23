/**
 * Shape checks for what a person types into Connect to your organization: a
 * work email, a join link, a team code, a server host. Pure, so main validates
 * every renderer input with the same rules the panel uses as a hint.
 *
 * The validate* functions are SHAPE checks: the renderer's hint. Main decides
 * with the connect* functions below, which transcribe the contracts 0.5.0
 * connect schemas (endpointConnectInput: z.email, parseJoinLink, teamCode,
 * serverHost). They are transcribed, not imported, because no product code
 * loads the vendored contracts (the house style of endpoint-port.ts); a test
 * holds them equal to the vendored schemas.
 *
 * A rejection carries a reason code and never the rejected value: a join code
 * or a team code must not reach a log line through an error message.
 */

import { megaServerHostProblem } from '../megaServer';
import { isServerHost } from '../maestro-lib/managed/endpoint-port';

export type MegaConnectInputReason =
	| 'empty'
	| 'tooLong'
	| 'notAscii'
	| 'badEmail'
	| 'notUrl'
	| 'notHttps'
	| 'credentials'
	| 'query'
	| 'badHost'
	| 'badPin'
	| 'badPath'
	| 'badCode'
	| 'badTeamCode';

export type MegaConnectInputResult<T> =
	| { ok: true; value: T }
	| { ok: false; reason: MegaConnectInputReason };

/** A join link that passed its shape check. */
export interface MegaJoinLink {
	/** The https URL: from validateJoinLink without a fragment; from connectJoinLink the exact text, issuer pin kept. */
	url: string;
	/** The server host, lowercased, without brackets. */
	host: string;
	code: string;
}

export const WORK_EMAIL_MAX_LENGTH = 254;
export const JOIN_LINK_MAX_LENGTH = 2048;
export const TEAM_CODE_MAX_LENGTH = 64;

const ASCII_PRINTABLE = /^[\x21-\x7e]+$/;
const EMAIL_LOCAL = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/;
const DOMAIN_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const JOIN_CODE = /^[A-Za-z0-9_-]{20,64}$/;
const JOIN_PATH = /^\/join\/([A-Za-z0-9_-]{20,64})$/;
const PIN_FRAGMENT = /^#pin=([a-f0-9]{64})$/;

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
	if (url.search !== '') return fail('query');
	const host = url.hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase();
	if (megaServerHostProblem(host) !== null) return fail('badHost');
	const match = JOIN_PATH.exec(url.pathname);
	if (match === null) return fail(url.pathname.startsWith('/join/') ? 'badCode' : 'badPath');
	const pin = PIN_FRAGMENT.exec(url.hash);
	if (pin === null) return fail('badPin');
	// Any HTTPS port is valid (the contract accepts any origin); the link keeps its pin.
	return {
		ok: true,
		value: { url: `${url.origin}/join/${match[1]}#pin=${pin[1]}`, host, code: match[1] },
	};
}

/**
 * A join code on its own (the last segment of a join link, or the code of a
 * maestro://join deep link): 20 to 64 URL-safe characters, kept as typed.
 */
export function validateJoinCode(input: string): MegaConnectInputResult<string> {
	const code = input.trim();
	if (code.length === 0) return fail('empty');
	if (!ASCII_PRINTABLE.test(code)) return fail('notAscii');
	if (!JOIN_CODE.test(code)) return fail('badCode');
	return { ok: true, value: code };
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
	const match = CONTRACT_TEAM_CODE.exec(code);
	if (match === null || teamCodeCheckCharacter(match[1] + match[2] + match[3]) !== match[4])
		return fail('badTeamCode');
	return { ok: true, value: code };
}

// The contracts 0.5.0 connect schemas, transcribed (see the file comment).

/** zod 4 z.email(), as endpointConnectInput uses it with max(254). */
const CONTRACT_EMAIL =
	/^(?:[A-Za-z0-9_'+\-]+\.)*[A-Za-z0-9_'+\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$/;
/** joinCode: 26 Crockford base32 characters, 128 bits, so the first is 0-7. */
const CONTRACT_JOIN_CODE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
/** issuerPin: SHA-256, lowercase hex. */
const CONTRACT_PIN = /^[a-f0-9]{64}$/;
const CONTRACT_TEAM_CODE = /^([A-Z0-9]{1,16})-([A-Z0-9]{1,16})-([0-9A-HJKMNP-TV-Z]{4})([0-9A-Z])$/;
const ALPHABET_36 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** The team code check character: Luhn mod 36 over tenant, team and random. */
function teamCodeCheckCharacter(body: string): string {
	let sum = 0;
	let double = true;
	for (let i = body.length - 1; i >= 0; i -= 1) {
		let value = ALPHABET_36.indexOf(body[i]);
		if (double) {
			value *= 2;
			value = Math.floor(value / 36) + (value % 36);
		}
		sum += value;
		double = !double;
	}
	return ALPHABET_36[(36 - (sum % 36)) % 36];
}

/** Contracts parseJoinLink: exactly `https://<origin>/join/<code>#pin=<pin>`, or null. */
function contractJoinLink(text: string): MegaJoinLink | null {
	if (text.length > JOIN_LINK_MAX_LENGTH) return null;
	let url: URL;
	try {
		url = new URL(text);
	} catch {
		return null;
	}
	const code = /^\/join\/([^/]+)$/.exec(url.pathname)?.[1];
	const pin = /^#pin=([^&=]+)$/.exec(url.hash)?.[1];
	if (
		url.protocol !== 'https:' ||
		url.username !== '' ||
		url.password !== '' ||
		url.search !== '' ||
		code === undefined ||
		pin === undefined ||
		!CONTRACT_JOIN_CODE.test(code) ||
		!CONTRACT_PIN.test(pin) ||
		`${url.origin}/join/${code}#pin=${pin}` !== text
	)
		return null;
	return { url: text, host: url.hostname, code };
}

/** Main's rule: the contract decides; a rejection names the shape rule it broke, or the fallback. */
function decide<T>(
	shape: MegaConnectInputResult<unknown>,
	value: T | null,
	fallback: MegaConnectInputReason
): MegaConnectInputResult<T> {
	if (value !== null) return { ok: true, value };
	return fail(shape.ok ? fallback : shape.reason);
}

/** A work email by the contracts (z.email().max(254)). Trimmed and lowercased. */
export function connectWorkEmail(input: string): MegaConnectInputResult<string> {
	const email = input.trim().toLowerCase();
	const ok = email.length <= WORK_EMAIL_MAX_LENGTH && CONTRACT_EMAIL.test(email);
	return decide(validateWorkEmail(input), ok ? email : null, 'badEmail');
}

/**
 * A join link by the contracts (parseJoinLink): the exact canonical text, its
 * issuer pin kept, since the endpoint receives it unchanged.
 */
export function connectJoinLink(input: string): MegaConnectInputResult<MegaJoinLink> {
	return decide(validateJoinLink(input), contractJoinLink(input.trim()), 'badCode');
}

/** A team code by the contracts (teamCode): uppercase, check character right. */
export function connectTeamCode(input: string): MegaConnectInputResult<string> {
	const typed = input.trim();
	// ASCII before uppercasing, as validateTeamCode does.
	const code = ASCII_PRINTABLE.test(typed) ? typed.toUpperCase() : '';
	const match = code.length <= 40 ? CONTRACT_TEAM_CODE.exec(code) : null;
	const ok = match !== null && teamCodeCheckCharacter(match[1] + match[2] + match[3]) === match[4];
	return decide(validateTeamCode(input), ok ? code : null, 'badTeamCode');
}

/** A server host by the contracts (serverHost): a lowercase DNS host, optional port. */
export function connectServerHost(input: string): MegaConnectInputResult<string> {
	const host = input.trim().toLowerCase();
	return decide(validateServerHost(input), isServerHost(host) ? host : null, 'badHost');
}
