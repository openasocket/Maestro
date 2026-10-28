import { describe, expect, it } from 'vitest';
import { passesLuhn, redactSecrets } from '../../shared/redactSecrets';

describe('redactSecrets - typed placeholders', () => {
	it.each([
		['sk- provider key', 'use sk-ABCDEFGHIJKLMNOP1234 now', 'use [REDACTED_API_KEY] now'],
		[
			'sk-proj style key with dashes',
			'k sk-proj-abcDEF1234567890xyz end',
			'k [REDACTED_API_KEY] end',
		],
		['ghp_ token', 'tok ghp_wxyzWXYZ0123456789abcd x', 'tok [REDACTED_API_KEY] x'],
		['github_pat_ token', 'a github_pat_11ABCDEFGHIJ0123456789KL b', 'a [REDACTED_API_KEY] b'],
		['slack token', 'xoxb-1234567890-abcdefghij here', '[REDACTED_API_KEY] here'],
		['AWS access key id', 'id AKIAIOSFODNN7EXAMPLE ok', 'id [REDACTED_AWS_ACCESS_KEY] ok'],
		['AWS temporary key id', 'id ASIAIOSFODNN7EXAMPLE ok', 'id [REDACTED_AWS_ACCESS_KEY] ok'],
		[
			'Authorization header',
			'Authorization: Bearer abcdefghij1234567890',
			'Authorization: Bearer [REDACTED_BEARER_TOKEN]',
		],
		['password: value', 'password: hunter2SecretPwd', 'password: [REDACTED_SECRET]'],
		['prefixed env key', 'OPENAI_API_KEY=sk-openai-secret-key', 'OPENAI_API_KEY=[REDACTED_SECRET]'],
		['quoted value', 'api_key: "two words"', 'api_key: [REDACTED_SECRET]'],
		[
			'aws secret access key',
			'aws_secret_access_key = wJalrXUtnFEMI/K7MDENG',
			'aws_secret_access_key = [REDACTED_SECRET]',
		],
	])('%s', (_name, input, expected) => {
		const result = redactSecrets(input);
		expect(result.text).toBe(expected);
		expect(result.redacted).toBe(true);
	});

	it('redacts a Lite pairing credential and leaves the public device id (MRC-08-03)', () => {
		const id = 'A'.repeat(43);
		const credential = id + '.' + 'b-_'.repeat(14) + 'c';
		expect(redactSecrets(`x-maestro-device-credential: ${credential} sent`).text).toBe(
			'x-maestro-device-credential: [REDACTED_SECRET] sent'
		);
		expect(redactSecrets(`lite-device:${id} opened a tab`)).toEqual({
			text: `lite-device:${id} opened a tab`,
			redacted: false,
		});
		expect(redactSecrets('Z' + credential).redacted).toBe(false);
	});

	it('redacts a JWT', () => {
		const jwt =
			'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
		expect(redactSecrets(`cookie ${jwt} end`).text).toBe('cookie [REDACTED_SECRET] end');
	});

	it('redacts a private key block, including one cut off without an END line', () => {
		const block =
			'-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----';
		expect(redactSecrets(`before\n${block}\nafter`).text).toBe('before\n[REDACTED_SECRET]\nafter');
		expect(redactSecrets('x -----BEGIN PRIVATE KEY-----\nMIIEvQ').text).toBe('x [REDACTED_SECRET]');
	});

	it('redacts Luhn-valid card numbers, grouped or not', () => {
		expect(redactSecrets('card 4111 1111 1111 1111 exp').text).toBe(
			'card [REDACTED_CREDIT_CARD] exp'
		);
		expect(redactSecrets('card 4111-1111-1111-1111').text).toBe('card [REDACTED_CREDIT_CARD]');
		expect(redactSecrets('amex 378282246310005.').text).toBe('amex [REDACTED_CREDIT_CARD].');
	});

	it('leaves digit runs that fail Luhn, are too short, or are one repeated digit', () => {
		for (const clean of [
			'order 4111 1111 1111 1112',
			'phone 1-800-555-1234',
			'id 0000 0000 0000 0000',
			'build 1234567890123456789012345',
		]) {
			expect(redactSecrets(clean)).toEqual({ text: clean, redacted: false });
		}
	});

	it('leaves git SHAs alone by default and redacts hex blobs only on request', () => {
		const sha = 'commit deadbeefdeadbeefdeadbeefdeadbeefdeadbeef landed';
		expect(redactSecrets(sha).text).toBe(sha);
		expect(redactSecrets(sha, { hexBlobs: true }).text).toBe('commit [REDACTED_SECRET] landed');
	});

	it('redacts one-time codes only on request, and keeps exit and status codes', () => {
		const otp = { oneTimeCodes: true };
		expect(redactSecrets('Your verification code is 482913', otp).text).toBe(
			'Your verification code is [REDACTED_CODE]'
		);
		expect(redactSecrets('Your Uber code: 4821. Never share it.', otp).text).toBe(
			'Your Uber code: [REDACTED_CODE]. Never share it.'
		);
		expect(redactSecrets('482913 is your Instagram code', otp).text).toBe(
			'[REDACTED_CODE] is your Instagram code'
		);
		expect(redactSecrets('Use G-482913 to verify', otp).text).toBe('Use [REDACTED_CODE] to verify');
		expect(redactSecrets('Security code 482-913', otp).text).toBe('Security code [REDACTED_CODE]');
		expect(redactSecrets('Your one-time password is 482913', otp).text).toBe(
			'Your one-time password is [REDACTED_CODE]'
		);
		expect(redactSecrets('Your temporary PIN: 4829', otp).text).toBe(
			'Your temporary PIN: [REDACTED_CODE]'
		);
		expect(redactSecrets('Your device code is WDJB-MJHT', otp).text).toBe(
			'Your device code is [REDACTED_CODE]'
		);
		for (const clean of [
			'process exited with exit code 1234',
			'status code 4040',
			'zip code 94110',
			'Your status code is 4040',
			'4040 is your status code',
			'Your zip code is 94110',
			'your code is well-known',
		]) {
			expect(redactSecrets(clean, otp).text).toBe(clean);
		}
		expect(redactSecrets('Your verification code is 482913').text).toBe(
			'Your verification code is 482913'
		);
	});

	it('leaves ordinary text untouched', () => {
		const clean = 'Refactor the auth module; the sk-abcd label and token count are fine.';
		expect(redactSecrets(clean)).toEqual({ text: clean, redacted: false });
		expect(redactSecrets('')).toEqual({ text: '', redacted: false });
	});
});

describe('redactSecrets - managed identifiers (MRC2-06-07)', () => {
	const b64 = (n: number) => 'Qz9_-'.repeat(Math.ceil(n / 5)).slice(0, n);
	const NONCE = b64(43);
	const INSTALL_SECRET = 'k' + b64(42);
	const TICKET = 'T' + b64(31);
	const HEX64 = 'a1b2c3d4'.repeat(8);
	const CLI_SECRET = 'f0e1d2c3'.repeat(6);
	const JWT =
		'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyLUFCQyIsImV4cCI6MTc2MTY2NzIwMH0.c2lnbmF0dXJlLWJ5dGVzLWhlcmUtMTIzNDU2Nzg5MA';

	it.each([
		[
			'identity anchor',
			`{"installSecret":"${INSTALL_SECRET}","epoch":3}`,
			'{"installSecret":[REDACTED_SECRET],"epoch":3}',
		],
		[
			'snake install secret',
			`install_secret=${INSTALL_SECRET}`,
			'install_secret=[REDACTED_SECRET]',
		],
		[
			'challenge nonce',
			`registration nonce: ${NONCE} shown once`,
			'registration nonce: [REDACTED_SECRET] shown once',
		],
		['nonce after a space', `nonce ${NONCE}`, 'nonce [REDACTED_SECRET]'],
		['challenge digest', `challengeDigest=${HEX64}`, 'challengeDigest=[REDACTED_SECRET]'],
		['invitation', `"invitation": "${b64(64)}"`, '"invitation": "[REDACTED_SECRET]"'],
		[
			'key possession proof',
			`key-possession-proof: ${b64(86)}`,
			'key-possession-proof: [REDACTED_SECRET]',
		],
		['dispatch ticket', `{"dispatchTicket":"${TICKET}"}`, '{"dispatchTicket":[REDACTED_SECRET]}'],
		[
			'per-boot CLI secret header',
			`x-maestro-cli-secret: ${CLI_SECRET}`,
			'x-maestro-cli-secret: [REDACTED_SECRET]',
		],
		['per-boot CLI secret field', `cliSecret: ${CLI_SECRET}`, 'cliSecret: [REDACTED_SECRET]'],
		[
			'handshake signature',
			`{"payload":{"version":1},"signature":"${HEX64}"}`,
			'{"payload":{"version":1},"signature":"[REDACTED_SECRET]"}',
		],
		[
			'managed env assignment',
			`MAESTRO_MANAGED_TUI_ADMISSION={"payload":{"run":{"leaseId":"L1"}},"signature":"${HEX64}"}\nPATH=/usr/bin`,
			'MAESTRO_MANAGED_TUI_ADMISSION=[REDACTED_SECRET]\nPATH=/usr/bin',
		],
		['camelCase access token', `accessToken: ${CLI_SECRET}`, 'accessToken: [REDACTED_SECRET]'],
		[
			'camelCase web auth token',
			`"webAuthToken": "${CLI_SECRET}"`,
			'"webAuthToken": [REDACTED_SECRET]',
		],
		['camelCase api key', `wakatimeApiKey=waka_${CLI_SECRET}`, 'wakatimeApiKey=[REDACTED_SECRET]'],
	])('%s', (_name, input, expected) => {
		expect(redactSecrets(input)).toEqual({ text: expected, redacted: true });
	});

	it('redacts a Codex auth.json by its token fields, the account id left', () => {
		const auth = `{"OPENAI_API_KEY":"sk-proj-${CLI_SECRET}","tokens":{"access_token":"${JWT}","account_id":"acct_01","id_token":"${JWT}","refresh_token":"rt-${CLI_SECRET}"}}`;
		const out = redactSecrets(auth).text;
		expect(out).toBe(
			'{"OPENAI_API_KEY":[REDACTED_SECRET],"tokens":{"access_token":[REDACTED_SECRET],"account_id":"acct_01","id_token":[REDACTED_SECRET],"refresh_token":[REDACTED_SECRET]}}'
		);
		expect(out).not.toContain(CLI_SECRET);
	});

	it('leaves the shapes alone without a name: a Lite device id, a digest, an id, a token count', () => {
		for (const clean of [
			`lite-device:${NONCE} opened a tab`,
			`binary digest ${HEX64} verified`,
			`lease ${TICKET} released`,
			'maxTokens: 4096 and inputTokens: 12',
			'the nonce is short',
			'ticket: MAESTRO-1234',
			'X-Hub-Signature-256: sha256=' + HEX64,
		]) {
			expect(redactSecrets(clean)).toEqual({ text: clean, redacted: false });
		}
	});
});

describe('redactSecrets - options', () => {
	it('placeholder replaces the whole match, key included', () => {
		expect(
			redactSecrets('the password: x1 and Bearer abcdefghij1234567890', { placeholder: '#' }).text
		).toBe('the # and #');
	});

	it('labels relabel a kind but keep the prefix', () => {
		const out = redactSecrets(
			'Authorization: Bearer abcdefghij1234567890 ghp_wxyzWXYZ0123456789abcd',
			{
				labels: { bearer: '[REDACTED]', github_token: '[REDACTED_GITHUB_TOKEN]' },
			}
		);
		expect(out.text).toBe('Authorization: Bearer [REDACTED] [REDACTED_GITHUB_TOKEN]');
	});
});

describe('passesLuhn', () => {
	it('validates known numbers', () => {
		expect(passesLuhn('4111111111111111')).toBe(true);
		expect(passesLuhn('4111111111111112')).toBe(false);
		expect(passesLuhn('41x1')).toBe(false);
	});
});

describe('redactSecrets - adversarial input stays linear (ReDoS)', () => {
	const K = 64 * 1024;
	const adversarial: Record<string, string> = {
		'hyphen chain': 'a-'.repeat(K / 2),
		'hyphen chain ending in a key name': `${'a-'.repeat(K / 2)}password`,
		'underscore chain': 'a_'.repeat(K / 2),
		'repeated eyJ- (JWT starts)': 'eyJ-'.repeat(K / 4),
		'JWT-like dotted runs': 'eyJaaaaaaaaaa.'.repeat(Math.floor(K / 14)),
		'repeated sk-': 'sk-'.repeat(Math.floor(K / 3)),
		'repeated xoxb-': 'xoxb-'.repeat(Math.floor(K / 5)),
		'repeated Bearer': 'Bearer '.repeat(Math.floor(K / 7)),
		'PEM header parts': '-----BEGIN A '.repeat(Math.floor(K / 13)),
		'unterminated PEM headers': '-----BEGIN PRIVATE KEY-----'.repeat(Math.floor(K / 27)),
		'spaced digits': '1 '.repeat(K / 2),
		'dashed digits': '1-'.repeat(K / 2),
		'repeated token=': 'token='.repeat(K / 6),
		'hex-ish hyphen chain': 'ab-'.repeat(Math.floor(K / 3)),
		'one long word': 'a'.repeat(K),
		'base64url halves and dots': ('A'.repeat(43) + '.').repeat(Math.floor(K / 44)),
		'dotted base64url run': 'A.'.repeat(K / 2),
		'your-word chain': 'your code '.repeat(K / 10),
		'code with no digits': 'verification code '.repeat(K / 18),
		'digits before is your': '1234 is your '.repeat(K / 13),
		'repeated managed env names': 'MAESTRO_MANAGED_A='.repeat(Math.floor(K / 18)),
		'repeated signature:': 'signature: '.repeat(Math.floor(K / 11)),
		'repeated nonce:': 'nonce: '.repeat(Math.floor(K / 7)),
		'nonce before one long word': `nonce ${'a'.repeat(K)}`,
		'camel suffix chain': 'aToken:'.repeat(Math.floor(K / 7)),
		'camel words with colons': 'abcdefgh: '.repeat(K / 10),
	};

	// A linear pass over 64 KB takes about 20 ms on a laptop and about 60 ms on
	// a loaded Windows CI runner, so a tight wall-clock budget fails there
	// without any regression. A pattern that backtracks quadratically takes
	// seconds at this size, which is what this guards against.
	const BUDGET_MS = 1000;

	it.each(Object.entries(adversarial))(`%s redacts in under ${BUDGET_MS} ms`, (_name, input) => {
		const start = performance.now();
		redactSecrets(input, { hexBlobs: true, oneTimeCodes: true });
		expect(performance.now() - start).toBeLessThan(BUDGET_MS);
	});
});
