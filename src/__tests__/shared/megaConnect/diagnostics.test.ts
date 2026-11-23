/**
 * `megaConnect/diagnostics.ts` is a transcription of the contracts 0.5.1
 * `redact()`; this test runs the vendored one on the same fixtures and holds
 * the two deep-equal, so a drift on either side fails here.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { redact } from '../../../shared/megaConnect/diagnostics';

let vendored: typeof import('../../../../vendor/mega-maestro/contracts/dist/diagnostics.js');
beforeAll(async () => {
	vendored = await import('../../../../vendor/mega-maestro/contracts/dist/diagnostics.js');
});

// PEM fixtures are assembled from parts: they are fake, and spelled whole they
// read as a key to every secret scanner on the way.
const DASHES = '-----';
const begin = (label: string) => `${DASHES}BEGIN ${label}${DASHES}`;
const end = (label: string) => `${DASHES}END ${label}${DASHES}`;
const pem = (label: string, body: string) => `${begin(label)}\n${body}\n${end(label)}`;
const KEY_LABEL = ['PRIVATE', 'KEY'].join(' ');

const TOKEN43 = 'A'.repeat(20) + '_-' + 'b'.repeat(21);
const VALUE86 = 'Z9'.repeat(43);
const JWT = [
	'eyJhbGciOiJIUzI1NiJ9',
	'eyJzdWIiOiIxMjM0NTY3ODkwIn0',
	'dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
].join('.');
const CERT = pem('CERTIFICATE', 'MIIBszCCAVmgAwIBAgIUQ');
const KEY = pem(KEY_LABEL, 'MIGHAgEAMBMGByqGSM49');
const DIGEST = 'a'.repeat(64);

function fixtures(): Array<[string, unknown]> {
	const cyclic: Record<string, unknown> = { name: 'loop' };
	cyclic.self = cyclic;
	const shared = { leaf: 'x' };
	let deep: Record<string, unknown> = { end: true };
	for (let i = 0; i < 20; i++) deep = { next: deep };
	const coded = Object.assign(new Error(`failed at ${TOKEN43}`), { code: 'E_FAIL' });
	// eslint-disable-next-line no-sparse-arrays
	const holes = [1, , 3];
	return [
		['plain string', 'hello'],
		['empty string', ''],
		['numbers', [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]],
		['booleans and null', [true, false, null, undefined]],
		['bigint', 12345678901234567890n],
		['function and symbol leaves', { f: () => 1, s: Symbol('x'), keep: 1 }],
		['top-level function', () => 1],
		['pem certificate', `cert: ${CERT} end`],
		['two certificates', `${CERT}\n${CERT}`],
		['private key', `key ${KEY} after`],
		['cut private key', `${begin(`EC ${KEY_LABEL}`)}\nMHcCAQEEIIr and the rest`],
		['rsa private key label', pem(`RSA ${KEY_LABEL}`, 'abc')],
		['jwt', `It was ${JWT} here`],
		['bearer', 'header Bearer abc.def~ghi+jkl/mno= trailing'],
		['bearer lowercase', 'bearer sometoken'],
		['url with credentials and query', 'https://user:pw@mega.acme.com/path/x?code=1&b=2#frag'],
		['url scheme only host', 'ssh://host.example'],
		['join link code', 'https://mega.acme.com/join/0123456789ABCDEFGHJKMNPQRS#pin=x'],
		['bare join path', 'open /join/ABC-def_1 now'],
		['43-char token', `token ${TOKEN43} end`],
		['43-char token beside a word char', `x${TOKEN43}`],
		['42 and 44 chars', `${'a'.repeat(42)} ${'b'.repeat(44)}`],
		['86-char value', `sig ${VALUE86} end`],
		['86-char padded', `sig ${VALUE86}== end`],
		['86-char after a slash', `https://h.example/${VALUE86}`],
		['digest stays', `sha256 ${DIGEST}`],
		['long string', 'word '.repeat(200)],
		['long string with a token at the cut', `${'y '.repeat(250)}${TOKEN43}`],
		[
			'sensitive keys',
			{
				token: 'x',
				accessToken: 'x',
				SECRET: 'x',
				cookie: 'x',
				csrfThing: 'x',
				password: 'x',
				privateKey: 'x',
				nonce: 'x',
				signature: 'x',
				Authorization: 'x',
				content: 'x',
				prompt: 'x',
				grantId: '6f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f',
				socketPath: '/var/run/mega.sock',
			},
		],
		['nested arrays and objects', { a: [1, { b: [CERT, { c: TOKEN43 }] }], d: { e: 'f' } }],
		['cycle', cyclic],
		['shared sibling (not a cycle)', { one: shared, two: shared }],
		['depth limit', deep],
		['error', new Error('plain failure')],
		['error with code', coded],
		['type error in an object', { err: new TypeError('bad type') }],
		['date', new Date(Date.UTC(2026, 10, 22, 1, 2, 3))],
		['invalid date', new Date(Number.NaN)],
		['uint8array', new Uint8Array([1, 2, 3])],
		['arraybuffer', new ArrayBuffer(8)],
		['dataview', new DataView(new ArrayBuffer(4))],
		['map is an object with no own entries', new Map([['k', 'v']])],
		['array with holes', holes],
	];
}

describe('redact (transcription of contracts 0.5.1 diagnostics)', () => {
	it.each(fixtures())('matches the vendored redact on %s', async (_name, value) => {
		expect(await redact(value)).toEqual(await vendored.redact(value));
	});

	it('drops what the rules say and keeps digests', async () => {
		const out = JSON.stringify(
			await redact({
				note: `${CERT} ${KEY} ${JWT} ${TOKEN43} ${VALUE86} Bearer abc https://u:p@h.example/p?q=1`,
				digest: DIGEST,
				token: 'gone',
			})
		);
		for (const secret of ['MIIBszCC', 'MIGHAgEA', JWT, TOKEN43, VALUE86, 'u:p@', 'q=1', 'gone']) {
			expect(out).not.toContain(secret);
		}
		expect(out).toContain(DIGEST);
		expect(out).toContain('[pem sha256:');
	});

	it('never mutates its input', async () => {
		const input = { token: 'x', nested: { text: TOKEN43 } };
		const before = structuredClone(input);
		await redact(input);
		expect(input).toEqual(before);
	});
});
