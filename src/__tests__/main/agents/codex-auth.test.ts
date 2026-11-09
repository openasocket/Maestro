/**
 * Codex login custody (`src/main/agents/codex-auth.ts`, MCOMP-21-06/21-14).
 *
 * `CODEX_HOME/auth.json` is the user's own OAuth credential in a plain file.
 * Standalone it is read and classified as before. On a managed host there is
 * no protected-custody reader for it, so `readCodexAuth()` reads nothing: no
 * file is opened, no token is returned, no e-mail is decoded from it, and no
 * other login (the personal `~/.codex` fallback included) is tried instead.
 * The custody is real (`headlessCredentialAuthority`); only the standing is a
 * test double, and the read is observed through the real filesystem module.
 */

import fsp from 'fs/promises';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	codexAccountEgress,
	codexAuthHeaders,
	extractEmailFromJwt,
	readCodexAuth,
} from '../../../main/agents/codex-auth';
import {
	headlessCredentialAuthority,
	setCredentialCustodyAuthority,
} from '../../../main/enterprise/credential-custody';
import type { IdentityStanding } from '../../../main/enterprise/identity-store';

const jwt = (claims: Record<string, unknown>) =>
	`h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

let dir: string;
let standing: IdentityStanding;

function writeLogin(home: string, tokens: Record<string, unknown>): string {
	fs.mkdirSync(home, { recursive: true });
	const file = path.join(home, 'auth.json');
	fs.writeFileSync(file, JSON.stringify({ tokens }));
	return file;
}

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-auth-'));
	standing = 'standalone';
	setCredentialCustodyAuthority(headlessCredentialAuthority({ standing: () => standing }));
});
afterEach(() => {
	setCredentialCustodyAuthority(null);
	vi.restoreAllMocks();
	fs.rmSync(dir, { recursive: true, force: true });
});

describe('readCodexAuth standalone', () => {
	it('reads the token, the account id and the e-mail of a logged-in home', async () => {
		const home = path.join(dir, 'work');
		writeLogin(home, {
			access_token: 'tok-1',
			account_id: 'acct-1',
			id_token: jwt({ email: 'a@example.com' }),
		});
		const auth = await readCodexAuth(home);
		expect(auth).toEqual({
			ok: true,
			accessToken: 'tok-1',
			accountId: 'acct-1',
			email: 'a@example.com',
		});
		if (!auth.ok) return;
		expect(codexAuthHeaders(auth)).toMatchObject({
			Authorization: 'Bearer tok-1',
			'ChatGPT-Account-Id': 'acct-1',
		});
	});

	it('keeps a home that was never logged in apart from a login with no token', async () => {
		const never = await readCodexAuth(path.join(dir, 'never'));
		expect(never).toMatchObject({ ok: false, kind: 'missing_auth' });
		if (!never.ok) expect(never.error).toContain('No auth.json at');

		const partial = path.join(dir, 'partial');
		writeLogin(partial, { id_token: jwt({ email: 'p@example.com' }) });
		expect(await readCodexAuth(partial)).toMatchObject({
			ok: false,
			kind: 'unauthenticated',
			email: 'p@example.com',
		});
	});

	it('omits the account header rather than sending it empty', async () => {
		const home = path.join(dir, 'solo');
		writeLogin(home, { access_token: 'tok-2' });
		const auth = await readCodexAuth(home);
		expect(auth.ok).toBe(true);
		if (!auth.ok) return;
		expect(codexAuthHeaders(auth)).not.toHaveProperty('ChatGPT-Account-Id');
	});
});

describe('readCodexAuth on a managed host', () => {
	it('opens no file and hands on no token or e-mail, naming the custody it refuses', async () => {
		const home = path.join(dir, 'work');
		const file = writeLogin(home, {
			access_token: 'tok-secret',
			id_token: jwt({ email: 'a@example.com' }),
		});
		standing = 'managed';
		const read = vi.spyOn(fsp, 'readFile');
		const auth = await readCodexAuth(home);
		expect(read).not.toHaveBeenCalled();
		expect(auth).toMatchObject({ ok: false, kind: 'managed' });
		if (auth.ok) return;
		expect(auth.error).toMatch(/^\[managed-plain-file\] the Codex account login is not kept/);
		expect(auth.error).toContain(file);
		expect(auth).not.toHaveProperty('email');
		expect(JSON.stringify(auth)).not.toContain('tok-secret');
	});

	it('refuses every home alike: no fallback to the personal ~/.codex login', async () => {
		const configured = path.join(dir, 'configured');
		const personal = path.join(dir, 'home', '.codex');
		writeLogin(configured, { access_token: 'tok-work' });
		writeLogin(personal, { access_token: 'tok-personal', id_token: jwt({ email: 'me@x.com' }) });
		standing = 'managed';
		const read = vi.spyOn(fsp, 'readFile');
		for (const home of [configured, personal, path.join(dir, 'never-logged-in')]) {
			const auth = await readCodexAuth(home);
			expect(auth).toMatchObject({ ok: false, kind: 'managed' });
			expect(JSON.stringify(auth)).not.toMatch(/tok-|me@x\.com/);
		}
		expect(read).not.toHaveBeenCalled();
	});

	it('drops what was read when the host becomes managed while the read is in flight', async () => {
		const home = path.join(dir, 'work');
		writeLogin(home, { access_token: 'tok-late', id_token: jwt({ email: 'late@example.com' }) });
		const original = fsp.readFile.bind(fsp);
		const read = vi.spyOn(fsp, 'readFile').mockImplementation((async (...args: unknown[]) => {
			const bytes = await (original as (...a: unknown[]) => Promise<unknown>)(...args);
			standing = 'managed'; // enrolled between the open and the parse
			return bytes;
		}) as typeof fsp.readFile);
		const auth = await readCodexAuth(home);
		expect(read).toHaveBeenCalledTimes(1);
		expect(auth).toMatchObject({ ok: false, kind: 'managed' });
		expect(JSON.stringify(auth)).not.toMatch(/tok-late|late@example\.com/);
	});

	it('reads again once the host is standalone, re-reading the standing per call', async () => {
		const home = path.join(dir, 'work');
		writeLogin(home, { access_token: 'tok-3' });
		standing = 'managed';
		expect(await readCodexAuth(home)).toMatchObject({ ok: false, kind: 'managed' });
		standing = 'standalone';
		expect(await readCodexAuth(home)).toMatchObject({ ok: true, accessToken: 'tok-3' });
	});
});

describe('codexAccountEgress and extractEmailFromJwt', () => {
	it('names the provider-account class and one opaque reference per home', () => {
		const a = codexAccountEgress('/h/a');
		expect(a).toMatchObject({ class: 'provider-account', account: { providerId: 'codex' } });
		expect(a.account?.accountRef).not.toContain('/h/a');
		expect(codexAccountEgress('/h/a')).toEqual(a);
		expect(codexAccountEgress('/h/b').account?.accountRef).not.toBe(a.account?.accountRef);
	});

	it('decodes an e-mail label and answers undefined for anything else', () => {
		expect(extractEmailFromJwt(jwt({ email: 'x@y.z' }))).toBe('x@y.z');
		expect(extractEmailFromJwt(jwt({ email: 7 }))).toBeUndefined();
		expect(extractEmailFromJwt('not-a-jwt')).toBeUndefined();
		expect(extractEmailFromJwt(undefined)).toBeUndefined();
	});
});
