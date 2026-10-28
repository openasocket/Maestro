/**
 * The managed redaction rules one by one (MRC2-06-09), beside the named shapes
 * redactSecrets.test.ts pins: for each rule MRC2-06-07 added, the spellings it
 * must catch, the edges of its bound, the innocent twin it must leave, and how
 * it composes with the rules before it and with the `placeholder` and `labels`
 * options. The redactor reads nothing of the enrollment: standalone and managed
 * text are redacted alike.
 */

import { describe, expect, it } from 'vitest';
import { redactSecrets, SECRET_PLACEHOLDERS } from '../../shared/redactSecrets';
import { MANAGED_SENSITIVE_KEYS } from '../../shared/settingsMetadata';
import { MANAGED_AUTHORITY_ENV_PREFIX } from '../../shared/maestro-lib/launch/env';
import { TUI_HANDSHAKE_ENV_VAR } from '../../shared/maestro-lib/managed/tui-handshake';

const b64 = (n: number): string => 'Qz9_-'.repeat(Math.ceil(n / 5)).slice(0, n);
const hex = (n: number): string => '0123456789abcdef'.repeat(Math.ceil(n / 16)).slice(0, n);
const JWT =
	'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyLUFCQyIsImV4cCI6MTc2MTY2NzIwMH0.c2lnbmF0dXJlLWJ5dGVzLWhlcmUtMTIzNDU2Nzg5MA';
const R = SECRET_PLACEHOLDERS.secret;
const same = (text: string) => expect(redactSecrets(text)).toEqual({ text, redacted: false });
const becomes = (text: string, expected: string) =>
	expect(redactSecrets(text)).toEqual({ text: expected, redacted: true });

describe('a MAESTRO_MANAGED_* assignment', () => {
	it('redacts the value of every name under the prefix to the end of its line, CR or LF', () => {
		expect(MANAGED_AUTHORITY_ENV_PREFIX).toBe('MAESTRO_MANAGED_');
		expect(TUI_HANDSHAKE_ENV_VAR.startsWith(MANAGED_AUTHORITY_ENV_PREFIX)).toBe(true);
		becomes(
			`${TUI_HANDSHAKE_ENV_VAR}={"payload":1}\nMAESTRO_MANAGED_LEASE=L1\r\nHOME=/u`,
			`${TUI_HANDSHAKE_ENV_VAR}=${R}\nMAESTRO_MANAGED_LEASE=${R}\r\nHOME=/u`
		);
		becomes('export MAESTRO_MANAGED_A=x', `export MAESTRO_MANAGED_A=${R}`);
		becomes('MAESTRO_MANAGED_9=a b "c" d', `MAESTRO_MANAGED_9=${R}`);
	});

	it('leaves the name without a value, a lowercase name, the bare prefix and a sibling authority name', () => {
		same('MAESTRO_MANAGED_LEASE is set');
		same('maestro_managed_lease=x');
		same('MAESTRO_MANAGED_=x');
		same('MAESTRO_USER_DATA=/tmp/x');
	});

	it('folds a JWT or a signature inside the value into the one placeholder', () => {
		const handshake = `{"payload":{"t":"${JWT}"},"signature":"${hex(64)}"}`;
		becomes(`${TUI_HANDSHAKE_ENV_VAR}=${handshake}`, `${TUI_HANDSHAKE_ENV_VAR}=${R}`);
	});
});

describe('the handshake signature', () => {
	it('redacts 64 hex digits after signature, quoted or bare, after a colon or an equals sign', () => {
		becomes(`"signature":"${hex(64)}"`, `"signature":"${R}"`);
		becomes(`signature = ${hex(64)}`, `signature = ${R}`);
		becomes(`signature: ${hex(64).toUpperCase()}`, `signature: ${R}`);
	});

	it('leaves a run of another length, a prefixed digest and a word', () => {
		same(`signature: ${hex(63)}`);
		same(`signature: ${hex(65)}`);
		same(`X-Hub-Signature-256: sha256=${hex(64)}`);
		same('signature: verified');
	});
});

describe('named managed material', () => {
	const spell = (name: string, sep: string) =>
		name.replace(/[A-Z]/g, (c) => `${sep}${c.toLowerCase()}`);
	const CAMEL = [
		'challengeDigest',
		'keyPossessionProof',
		'installSecret',
		'cliSecret',
		'dispatchTicket',
	];
	const NAMES = [
		'nonce',
		'invitation',
		...CAMEL.flatMap((name) => [name, spell(name, '_'), spell(name, '-')]),
	];

	it.each(NAMES)('%s: after a colon, an equals sign or a space, quoted or not', (name) => {
		const value = b64(43);
		becomes(`${name}: ${value}`, `${name}: ${R}`);
		becomes(`${name}=${value}`, `${name}=${R}`);
		becomes(`${name} ${value}`, `${name} ${R}`);
		// A quoted value: the camelCase and key=value rules that run after may
		// take the quotes with the placeholder, so only the absence is pinned.
		const quoted = redactSecrets(`{"${name}": "${value}"}`);
		expect(quoted.redacted).toBe(true);
		expect(quoted.text).not.toContain(value);
		expect(quoted.text).toContain(R);
	});

	it('matches the name in any case', () => {
		becomes(`NONCE=${b64(43)}`, `NONCE=${R}`);
		becomes(`Install-Secret: ${b64(43)}`, `Install-Secret: ${R}`);
	});

	it('takes a value of 32 to 512 base64url characters and leaves a shorter run', () => {
		same(`nonce: ${b64(31)}`);
		becomes(`nonce: ${b64(32)}`, `nonce: ${R}`);
		becomes(`nonce: ${b64(512)}`, `nonce: ${R}`);
		same(`nonce: ${b64(20)}.${b64(20)}`);
	});

	it('leaves the names in prose', () => {
		same('the nonce is checked once');
		same('invitation: come to the party');
		same('dispatch ticket pending');
		same('challenge digest mismatch');
	});
});

describe('a camelCase credential key', () => {
	it.each([
		'ApiKey',
		'Secret',
		'Token',
		'Password',
		'Passwd',
		'Nonce',
		'Ticket',
		'Proof',
		'Credential',
	])(
		'host%s: the value is kept out, quoted or bare, and a query string keeps its other params',
		(suffix) => {
			becomes(`host${suffix}: v1-value`, `host${suffix}: ${R}`);
			becomes(`"host${suffix}": "v 1"`, `"host${suffix}": ${R}`);
			becomes(`host${suffix}=a&b=2`, `host${suffix}=${R}&b=2`);
		}
	);

	it('is bounded to a word of 48 characters before the suffix, and leaves a count and a key with no value', () => {
		becomes(`${'a'.repeat(48)}Token: abc`, `${'a'.repeat(48)}Token: ${R}`);
		same(`${'a'.repeat(49)}Token: abc`);
		same('maxTokens: 4096 and inputTokens: 12');
		same('webAuthToken:');
		same('refreshToken: ');
	});
});

describe('composition and options', () => {
	it('every key the settings collector masks by name is a shape the redactor catches on its own', () => {
		for (const key of MANAGED_SENSITIVE_KEYS) {
			const value = key === 'signature' ? hex(64) : b64(43);
			const out = redactSecrets(`{"${key}":"${value}"}`);
			expect(out.redacted, key).toBe(true);
			expect(out.text, key).not.toContain(value);
		}
	});

	it('the four rules follow placeholder, which swallows the kept name, and a relabeled secret kind', () => {
		const text = `nonce: ${b64(43)} signature: ${hex(64)} cliSecret=${hex(48)}\nMAESTRO_MANAGED_X=y`;
		expect(redactSecrets(text, { placeholder: '#' }).text).toBe('# # #\n#');
		expect(redactSecrets(text, { labels: { secret: '[S]' } }).text).toBe(
			'nonce: [S] signature: [S] cliSecret=[S]\nMAESTRO_MANAGED_X=[S]'
		);
		expect(redactSecrets('')).toEqual({ text: '', redacted: false });
	});
});
