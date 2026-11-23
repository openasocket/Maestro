import { beforeAll, describe, expect, it } from 'vitest';
import {
	connectJoinLink,
	connectServerHost,
	connectTeamCode,
	connectWorkEmail,
	validateJoinCode,
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

const JL_PIN = 'a'.repeat(64);
const JL_LINK = `https://mega.acme.com/join/${CODE}#pin=${JL_PIN}`;

describe('validateJoinLink', () => {
	it('accepts a link with its pin and lowercases the host', () => {
		expect(validateJoinLink(`https://Mega.Acme.com/join/${CODE}#pin=${JL_PIN}`)).toEqual({
			ok: true,
			value: { url: JL_LINK, host: 'mega.acme.com', code: CODE },
		});
	});

	it('drops an explicit 443 and keeps any other port', () => {
		expect(validateJoinLink(`https://mega.acme.com:443/join/${CODE}#pin=${JL_PIN}`)).toEqual({
			ok: true,
			value: { url: JL_LINK, host: 'mega.acme.com', code: CODE },
		});
		expect(validateJoinLink(`https://mega.acme.com:8443/join/${CODE}#pin=${JL_PIN}`)).toEqual({
			ok: true,
			value: {
				url: `https://mega.acme.com:8443/join/${CODE}#pin=${JL_PIN}`,
				host: 'mega.acme.com',
				code: CODE,
			},
		});
	});

	it.each([
		['', 'empty'],
		['not a url', 'notAscii'],
		['mega.acme.com/join/x', 'notUrl'],
		[`http://mega.acme.com/join/${CODE}#pin=${JL_PIN}`, 'notHttps'],
		[`maestro://join/${CODE}#pin=${JL_PIN}`, 'notHttps'],
		[`https://alice:pw@mega.acme.com/join/${CODE}#pin=${JL_PIN}`, 'credentials'],
		[`https://alice@mega.acme.com/join/${CODE}#pin=${JL_PIN}`, 'credentials'],
		[`https://mega.acme.com/join/${CODE}?issuer=abc#pin=${JL_PIN}`, 'query'],
		[`https://mega.acme.com/join/${CODE}`, 'badPin'],
		[`https://mega.acme.com/join/${CODE}#frag`, 'badPin'],
		[`https://mega.acme.com/join/${CODE}#pin=${JL_PIN.toUpperCase()}`, 'badPin'],
		[`https://mega.acme.com/invite/${CODE}#pin=${JL_PIN}`, 'badPath'],
		[`https://mega.acme.com/join/${CODE}/#pin=${JL_PIN}`, 'badCode'],
		[`https://mega.acme.com/join/${CODE}/extra#pin=${JL_PIN}`, 'badCode'],
		[`https://mega.acme.com/join/short#pin=${JL_PIN}`, 'badCode'],
		[`https://mega.acme.com/join/${'a'.repeat(65)}#pin=${JL_PIN}`, 'badCode'],
		[`https://mega.acme.com/join/${CODE}#pin=${JL_PIN}${'a'.repeat(2048)}`, 'tooLong'],
	])('rejects %j as %s without echoing it', (input, reason) => {
		const result = validateJoinLink(input);
		expect(reasonOf(result)).toBe(reason);
		expectNoEcho(input, result);
		expect(JSON.stringify(result)).not.toContain(CODE);
	});
});

describe('validateTeamCode', () => {
	it('accepts a team code with its check character and uppercases it', () => {
		expect(validateTeamCode('ACME-WEB-7K3M0')).toEqual({ ok: true, value: 'ACME-WEB-7K3M0' });
		expect(validateTeamCode(' abc-def-7k3m6 ')).toEqual({ ok: true, value: 'ABC-DEF-7K3M6' });
	});

	it.each([
		['', 'empty'],
		['AB-CD', 'badTeamCode'],
		['ACME-WEB-7K3M', 'badTeamCode'],
		['ACME-WEB-7K3M1', 'badTeamCode'],
		['ACME-WEB-7K3I0', 'badTeamCode'],
		['ACMEWEB7K3M0', 'badTeamCode'],
		['ACME--WEB', 'badTeamCode'],
		['-ACME-WEB', 'badTeamCode'],
		['ACME_WEB-7K3M0', 'badTeamCode'],
		['ACME WEB-7K3M0', 'notAscii'],
		['straße-web', 'notAscii'],
		[`ACME-${'A'.repeat(64)}`, 'tooLong'],
	])('rejects %j as %s without echoing it', (input, reason) => {
		const result = validateTeamCode(input);
		expect(reasonOf(result)).toBe(reason);
		expectNoEcho(input, result);
	});
});

describe('validateJoinCode', () => {
	it('accepts a bare join code as typed', () => {
		expect(validateJoinCode(` ${CODE} `)).toEqual({ ok: true, value: CODE });
	});

	it.each([
		['', 'empty'],
		['short-code', 'badCode'],
		['x'.repeat(65), 'badCode'],
		['has/slash/aaaaaaaaaaaaaaaa', 'badCode'],
		['codé-aaaaaaaaaaaaaaaaaaaaa', 'notAscii'],
	])('rejects %j as %s without echoing it', (input, reason) => {
		const result = validateJoinCode(input);
		expect(reasonOf(result)).toBe(reason);
		expectNoEcho(input, result);
	});
});

// MSX-02-09: main decides by the contracts 0.5.0 connect schemas.
const PIN = 'ab'.repeat(32);
const JOIN_CODE = '0123456789ABCDEFGHJKMNPQRS';
const LINK = `https://mega.acme.com/join/${JOIN_CODE}#pin=${PIN}`;
const TEAM = 'ACME-WEB-7K3M0';

let contracts: typeof import('../../../../vendor/mega-maestro/contracts/dist/connect.js');
let zod: typeof import('../../../../vendor/mega-maestro/contracts/node_modules/zod/index.js');
beforeAll(async () => {
	contracts = await import('../../../../vendor/mega-maestro/contracts/dist/connect.js');
	zod = await import('../../../../vendor/mega-maestro/contracts/node_modules/zod/index.js');
});

describe('connect* (contracts authority)', () => {
	it('accepts what the contracts accept, normalized as main sends it', () => {
		expect(connectWorkEmail(' Alice@Acme.COM ')).toEqual({ ok: true, value: 'alice@acme.com' });
		expect(connectJoinLink(` ${LINK} `)).toEqual({
			ok: true,
			value: { url: LINK, host: 'mega.acme.com', code: JOIN_CODE },
		});
		expect(connectTeamCode('acme-web-7k3m0')).toEqual({ ok: true, value: TEAM });
		expect(connectServerHost('Mega.Acme.com:8443')).toEqual({
			ok: true,
			value: 'mega.acme.com:8443',
		});
	});

	it.each([
		['email', 'alice@localhost', 'badEmail'],
		['email', 'alice', 'badEmail'],
		['joinLink', `https://mega.acme.com/join/${CODE}`, 'badPin'],
		['joinLink', `https://mega.acme.com/join/${JOIN_CODE}`, 'badPin'],
		['joinLink', `https://mega.acme.com/join/${JOIN_CODE}?x=1#pin=${PIN}`, 'query'],
		['joinLink', `http://mega.acme.com/join/${JOIN_CODE}#pin=${PIN}`, 'notHttps'],
		['teamCode', 'ACME-WEB-7K3M', 'badTeamCode'],
		['teamCode', 'ACME-WEB-7K3M1', 'badTeamCode'],
		['server', 'fd00::1', 'badHost'],
		['server', 'https://mega.acme.com', 'badHost'],
	])('rejects a %s the contracts refuse (%j) as %s without echoing it', (kind, input, reason) => {
		const check = {
			email: connectWorkEmail,
			joinLink: connectJoinLink,
			teamCode: connectTeamCode,
			server: connectServerHost,
		}[kind as 'email' | 'joinLink' | 'teamCode' | 'server'];
		const result = check(input);
		expect(reasonOf(result)).toBe(reason);
		expectNoEcho(input, result);
	});

	it('agrees with the vendored 0.5.0 schemas on every case', () => {
		const email = zod.z.email().max(254);
		const emails = [
			'alice@acme.com',
			"o'brien@eng.acme.co.uk",
			'alice@localhost',
			'a@b.c',
			'a..b@acme.com',
			`${'a'.repeat(250)}@acme.com`,
		];
		for (const value of emails)
			expect([value, connectWorkEmail(value).ok]).toEqual([value, email.safeParse(value).success]);
		const links = [
			LINK,
			`https://mega.acme.com:8443/join/${JOIN_CODE}#pin=${PIN}`,
			`https://mega.acme.com:443/join/${JOIN_CODE}#pin=${PIN}`,
			`https://Mega.acme.com/join/${JOIN_CODE}#pin=${PIN}`,
			`https://mega.acme.com/join/8${JOIN_CODE.slice(1)}#pin=${PIN}`,
			`https://mega.acme.com/join/${JOIN_CODE}#pin=${PIN.toUpperCase()}`,
			`https://u@mega.acme.com/join/${JOIN_CODE}#pin=${PIN}`,
			`https://mega.acme.com/join/${CODE}`,
		];
		for (const value of links)
			expect([value, connectJoinLink(value).ok]).toEqual([
				value,
				contracts.parseJoinLink(value) !== undefined,
			]);
		const teams = [
			TEAM,
			'ACME-WEB-7K3M',
			'ACME-WEB-7K3MZ',
			'A-B-0000' + contracts.teamCodeCheckCharacter('AB0000'),
			'ACME-WEB-7K3I0',
		];
		for (const value of teams)
			expect([value, connectTeamCode(value).ok]).toEqual([
				value,
				contracts.teamCode.safeParse(value).success,
			]);
		const hosts = [
			'mega.acme.com',
			'mega.acme.com:65535',
			'mega.acme.com:65536',
			'mega.acme.com:0',
			'10.0.0.5',
			'fd00::1',
			'-bad.com',
		];
		for (const value of hosts)
			expect([value, connectServerHost(value).ok]).toEqual([
				value,
				contracts.serverHost.safeParse(value).success,
			]);
	});
});
