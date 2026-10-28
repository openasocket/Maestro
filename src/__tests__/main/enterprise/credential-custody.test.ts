/**
 * The credential custody ceiling (MRC2-06-06): the pure verdict over the
 * three custodies, the source over the enrollment rule, the headless form and
 * the module authority. Injected fake seals and anchors only; the sinks
 * (config-store, WakaTime, SusFactor, the settings verdict) are covered in
 * their own suites.
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
	MANAGED_CREDENTIALS,
	PLAIN_SETTINGS_CREDENTIAL_KEYS,
	SETTINGS_FILE_CUSTODY,
	createCredentialCustodySource,
	credentialCustodyVerdict,
	formatCredentialRefusal,
	headlessCredentialAuthority,
	holdCredentialCustody,
	setCredentialCustodyAuthority,
	type CredentialCustody,
} from '../../../main/enterprise/credential-custody';
import type { IdentityRead } from '../../../main/enterprise/identity-store';
import { obscuringSeal } from '../../../main/utils/safe-storage-seal';
import { fakeAnchor, fakeSeal } from './fakeCustody';

const sealed = (seal = fakeSeal(), anchor = fakeAnchor({ value: null })): CredentialCustody => ({
	kind: 'sealed',
	seal,
	anchor,
});
const env: CredentialCustody = { kind: 'environment', name: 'ODIN_API_TOKEN' };
const enrolled: IdentityRead = { status: 'ok', record: {} as never, epoch: 1 };

afterEach(() => setCredentialCustodyAuthority(null));

describe('credentialCustodyVerdict', () => {
	it('standalone admits every custody of every credential', () => {
		for (const credential of MANAGED_CREDENTIALS) {
			for (const custody of [sealed(fakeSeal({ available: false })), SETTINGS_FILE_CUSTODY, env]) {
				expect(credentialCustodyVerdict('standalone', credential, custody)).toEqual({
					allowed: true,
				});
			}
		}
	});

	it('managed admits only the OS key store with an anchor, and names what it refuses', () => {
		expect(credentialCustodyVerdict('managed', 'cot-export.state', sealed())).toEqual({
			allowed: true,
		});
		const unprotected = [
			[sealed(fakeSeal({ available: false })), 'The operating system offers no encryption'],
			[sealed(obscuringSeal()), 'The obscuring seal uses a key built into the app'],
			[sealed(fakeSeal({ custody: null })), 'does not say who holds its key'],
			[sealed(fakeSeal(), fakeAnchor({ value: null }, { available: false })), 'freshness anchor'],
		] as const;
		for (const [custody, why] of unprotected) {
			expect(credentialCustodyVerdict('managed', 'cot-export.state', custody)).toMatchObject({
				allowed: false,
				code: 'unprotected',
				message: expect.stringMatching(
					new RegExp(`^the turn log state is not kept on this managed host: .*${why}`)
				),
			});
		}
		const basicText = sealed(fakeSeal({ custody: { kind: 'os-keystore', backend: 'basic_text' } }));
		expect(
			credentialCustodyVerdict('managed', 'cot-export.state', basicText, 'linux')
		).toMatchObject({ code: 'unprotected', message: expect.stringContaining('basic_text') });
		expect(credentialCustodyVerdict('managed', 'cot-export.state', basicText, 'darwin')).toEqual({
			allowed: true,
		});
		expect(credentialCustodyVerdict('managed', 'wakatime.apiKey', SETTINGS_FILE_CUSTODY)).toEqual({
			allowed: false,
			code: 'plain-file',
			message:
				'the WakaTime API key is not kept on this managed host: maestro-settings.json is a readable file, and a managed host keeps a credential only under the OS key store.',
		});
		const token = credentialCustodyVerdict('managed', 'cue.odinToken', env);
		expect(token).toMatchObject({
			code: 'environment',
			message: expect.stringMatching(
				/^the 0DIN API token is not kept on this managed host: the ODIN_API_TOKEN environment variable is inherited by every child process/
			),
		});
		expect(formatCredentialRefusal(token as { code: string; message: string })).toMatch(
			/^\[managed-environment\] the 0DIN API token/
		);
		expect(PLAIN_SETTINGS_CREDENTIAL_KEYS).toEqual({ wakatimeApiKey: 'wakatime.apiKey' });
	});
});

describe('the source, the headless authority and the module hold', () => {
	it('reads the enrollment rule: none and unprotected-without-file are standalone, a record is managed', () => {
		let read: IdentityRead = { status: 'none' };
		const source = createCredentialCustodySource({ identity: { read: () => read } });
		expect(source.standing()).toBe('standalone');
		expect(source.authorize('cue.odinToken', env)).toEqual({ allowed: true });
		read = { status: 'unprotected', reason: 'anchor-unavailable', message: 'x', fileExists: false };
		expect(source.authorize('cue.odinToken', env)).toEqual({ allowed: true });
		read = enrolled;
		expect(source.standing()).toBe('managed');
		expect(source.authorize('cue.odinToken', env)).toMatchObject({ code: 'environment' });
		expect(source.authorize('cot-export.state', sealed())).toEqual({ allowed: true });
	});

	it('a headless process holds by the standing it read; the module hold answers allowed until a source is set', () => {
		expect(holdCredentialCustody('cue.odinToken', env)).toEqual({ allowed: true });
		setCredentialCustodyAuthority(headlessCredentialAuthority({ standing: () => 'managed' }));
		expect(holdCredentialCustody('cue.odinToken', env)).toMatchObject({ allowed: false });
		expect(holdCredentialCustody('wakatime.apiKey', sealed())).toEqual({ allowed: true });
		setCredentialCustodyAuthority(headlessCredentialAuthority({ standing: () => 'standalone' }));
		expect(holdCredentialCustody('cue.odinToken', env)).toEqual({ allowed: true });
	});
});
