import { describe, expect, it } from 'vitest';
import {
	MEGA_CONNECT_DEEP_LINK_MAX_LENGTH,
	megaConnectDeepLinkKind,
	parseMegaConnectDeepLink,
} from '../../../shared/megaConnect/deepLink';

const CODE = 'Ab3_dE5-fG7hJ9kL2mN4pQ6r';

describe('parseMegaConnectDeepLink', () => {
	it('parses a join link', () => {
		expect(parseMegaConnectDeepLink(`maestro://join?server=Mega.Acme.com&code=${CODE}`)).toEqual({
			kind: 'join',
			server: 'mega.acme.com',
			code: CODE,
		});
	});

	it('parses a connect link and uppercases the team code', () => {
		expect(
			parseMegaConnectDeepLink('maestro://connect?server=mega.acme.com&team=acme-web-7k3m')
		).toEqual({
			kind: 'connect',
			server: 'mega.acme.com',
			teamCode: 'ACME-WEB-7K3M',
		});
	});

	it('accepts the Windows maestro: form, a trailing slash and either parameter order', () => {
		expect(parseMegaConnectDeepLink(`maestro:join/?code=${CODE}&server=mega.acme.com`)).toEqual({
			kind: 'join',
			server: 'mega.acme.com',
			code: CODE,
		});
	});

	it.each([
		['a bad scheme', `https://join?server=mega.acme.com&code=${CODE}`],
		['another scheme', `evil://join?server=mega.acme.com&code=${CODE}`],
		[
			'an oversized URL',
			`maestro://join?server=mega.acme.com&code=${CODE}&pad=${'x'.repeat(MEGA_CONNECT_DEEP_LINK_MAX_LENGTH)}`,
		],
		['a short code', 'maestro://join?server=mega.acme.com&code=short'],
		['a code with a slash', `maestro://join?server=mega.acme.com&code=${CODE}%2Fx`],
		['a missing server', `maestro://join?code=${CODE}`],
		['a bad server', `maestro://join?server=mega.acme.com:8443/x&code=${CODE}`],
		['a missing code', 'maestro://join?server=mega.acme.com'],
		['a repeated parameter', `maestro://join?server=mega.acme.com&code=${CODE}&code=${CODE}`],
		['an unknown parameter', `maestro://join?server=mega.acme.com&code=${CODE}&approve=1`],
		['a team code on a join link', 'maestro://join?server=mega.acme.com&team=ACME-WEB-7K3M'],
		['a bad team code', 'maestro://connect?server=mega.acme.com&team=acme'],
		['an extra path segment', `maestro://join/now?server=mega.acme.com&code=${CODE}`],
		['a non-connect link', 'maestro://session/abc'],
	])('rejects %s', (_label, url) => {
		expect(parseMegaConnectDeepLink(url)).toBeNull();
	});

	it('returns null for a non-string', () => {
		expect(parseMegaConnectDeepLink(undefined as unknown as string)).toBeNull();
	});
});

describe('megaConnectDeepLinkKind', () => {
	it('names a connect link even when its fields are invalid', () => {
		expect(megaConnectDeepLinkKind('maestro://join?code=short')).toBe('join');
		expect(megaConnectDeepLinkKind('maestro:connect')).toBe('connect');
		expect(megaConnectDeepLinkKind('MAESTRO://JOIN/')).toBe('join');
	});

	it('returns null for other links', () => {
		expect(megaConnectDeepLinkKind('maestro://session/join')).toBeNull();
		expect(megaConnectDeepLinkKind('maestro://focus')).toBeNull();
		expect(megaConnectDeepLinkKind('https://mega.acme.com/join/x')).toBeNull();
	});
});
