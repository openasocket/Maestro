import { describe, expect, it } from 'vitest';
import {
	validateJoinLink,
	validateServerHost,
	validateTeamCode,
	validateWorkEmail,
	type MegaConnectInputResult,
} from '../../../shared/megaConnect/input';

const CODE = 'Ab3_dE5-fG7hJ9kL2mN4pQ6r';

function reasonOf<T>(result: MegaConnectInputResult<T>): string {
	expect(result.ok).toBe(false);
	return result.ok ? '' : result.reason;
}

/** A rejection never echoes the rejected value back. */
function expectNoEcho<T>(input: string, result: MegaConnectInputResult<T>): void {
	expect(result.ok).toBe(false);
	const text = JSON.stringify(result);
	const trimmed = input.trim();
	if (trimmed.length >= 3) expect(text).not.toContain(trimmed);
	if (trimmed.length >= 3) expect(text.toLowerCase()).not.toContain(trimmed.toLowerCase());
}

describe('validateWorkEmail', () => {
	it('accepts and lowercases a work email', () => {
		expect(validateWorkEmail('Alice.Smith@Acme.COM')).toEqual({
			ok: true,
			value: 'alice.smith@acme.com',
		});
		expect(validateWorkEmail('  bob+maestro@eng.acme.co.uk ')).toEqual({
			ok: true,
			value: 'bob+maestro@eng.acme.co.uk',
		});
	});

	it.each([
		['', 'empty'],
		['alice', 'badEmail'],
		['alice@@acme.com', 'badEmail'],
		['alice@acme@evil.com', 'badEmail'],
		['alice@localhost', 'badEmail'],
		['alice@acme..com', 'badEmail'],
		['.alice@acme.com', 'badEmail'],
		['alice smith@acme.com', 'notAscii'],
		['alicé@acme.com', 'notAscii'],
		[`${'a'.repeat(250)}@acme.com`, 'tooLong'],
	])('rejects %j as %s without echoing it', (input, reason) => {
		const result = validateWorkEmail(input);
		expect(reasonOf(result)).toBe(reason);
		expectNoEcho(input, result);
	});
});

describe('validateServerHost', () => {
	it('accepts host names and IP literals', () => {
		expect(validateServerHost('Mega.Acme.com')).toEqual({ ok: true, value: 'mega.acme.com' });
		expect(validateServerHost('10.0.0.5')).toEqual({ ok: true, value: '10.0.0.5' });
		expect(validateServerHost('fd00::1')).toEqual({ ok: true, value: 'fd00::1' });
	});

	it.each([
		['', 'empty'],
		['https://mega.acme.com', 'badHost'],
		['mega.acme.com/join', 'badHost'],
		['user@mega.acme.com', 'badHost'],
		['999.1.1.1', 'badHost'],
		['méga.acme.com', 'notAscii'],
	])('rejects %j as %s without echoing it', (input, reason) => {
		const result = validateServerHost(input);
		expect(reasonOf(result)).toBe(reason);
		expectNoEcho(input, result);
	});
});

describe('validateJoinLink', () => {
	it('accepts a join link and splits out the host and code', () => {
		expect(validateJoinLink(`https://Mega.Acme.com/join/${CODE}`)).toEqual({
			ok: true,
			value: { url: `https://mega.acme.com/join/${CODE}`, host: 'mega.acme.com', code: CODE },
		});
	});

	it('accepts an explicit 443, a trailing slash and a query; drops the fragment', () => {
		const result = validateJoinLink(`https://mega.acme.com:443/join/${CODE}/?issuer=abc#frag`);
		expect(result).toEqual({
			ok: true,
			value: {
				url: `https://mega.acme.com/join/${CODE}/?issuer=abc`,
				host: 'mega.acme.com',
				code: CODE,
			},
		});
	});

	it('allows another port only on localhost', () => {
		expect(validateJoinLink(`https://localhost:8443/join/${CODE}`).ok).toBe(true);
		expect(reasonOf(validateJoinLink(`https://mega.acme.com:8443/join/${CODE}`))).toBe('badPort');
	});

	it.each([
		['', 'empty'],
		['not a url', 'notAscii'],
		['mega.acme.com/join/x', 'notUrl'],
		[`http://mega.acme.com/join/${CODE}`, 'notHttps'],
		[`maestro://join/${CODE}`, 'notHttps'],
		[`https://alice:pw@mega.acme.com/join/${CODE}`, 'credentials'],
		[`https://alice@mega.acme.com/join/${CODE}`, 'credentials'],
		[`https://mega.acme.com/invite/${CODE}`, 'badPath'],
		[`https://mega.acme.com/join/${CODE}/extra`, 'badCode'],
		['https://mega.acme.com/join/short', 'badCode'],
		[`https://mega.acme.com/join/${'a'.repeat(65)}`, 'badCode'],
		['https://mega.acme.com/join/abc!def%20ghijklmnopqrstu', 'badCode'],
		[`https://mega.acme.com/join/${CODE}?x=${'a'.repeat(2048)}`, 'tooLong'],
	])('rejects %j as %s without echoing it', (input, reason) => {
		const result = validateJoinLink(input);
		expect(reasonOf(result)).toBe(reason);
		expectNoEcho(input, result);
		expect(JSON.stringify(result)).not.toContain(CODE);
	});
});

describe('validateTeamCode', () => {
	it('accepts and uppercases a team code', () => {
		expect(validateTeamCode('ACME-WEB-7K3M')).toEqual({ ok: true, value: 'ACME-WEB-7K3M' });
		expect(validateTeamCode(' abc-def-7k3m ')).toEqual({ ok: true, value: 'ABC-DEF-7K3M' });
	});

	it.each([
		['', 'empty'],
		['AB-CD', 'badTeamCode'],
		['ACMEWEB7K3M', 'badTeamCode'],
		['ACME--WEB', 'badTeamCode'],
		['-ACME-WEB', 'badTeamCode'],
		['ACME_WEB-7K3M', 'badTeamCode'],
		['ACME WEB-7K3M', 'notAscii'],
		['straße-web', 'notAscii'],
		[`ACME-${'A'.repeat(64)}`, 'tooLong'],
	])('rejects %j as %s without echoing it', (input, reason) => {
		const result = validateTeamCode(input);
		expect(reasonOf(result)).toBe(reason);
		expectNoEcho(input, result);
	});
});
