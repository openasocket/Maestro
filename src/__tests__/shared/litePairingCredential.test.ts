/**
 * The one home of the Lite pairing credential shape (MRC-08-03): what counts
 * as a credential, which half is the public device id, and which file names
 * are the pairing stores that never leave the machine.
 */

import { describe, expect, it } from 'vitest';
import {
	isLitePairingCredential,
	isLitePairingStoreFile,
	LITE_DEVICE_CREDENTIALS_FILE_NAME,
	LITE_PAIRED_DEVICES_FILE_NAME,
	LITE_PAIRING_CREDENTIAL_SOURCE,
	litePairingDeviceId,
} from '../../shared/litePairingCredential';

const ID = 'A'.repeat(43);
const PROOF = 'b-_'.repeat(14) + 'c';
const CREDENTIAL = ID + '.' + PROOF;

describe('isLitePairingCredential', () => {
	it('accepts exactly two 43-character base64url halves joined by a dot', () => {
		expect(PROOF).toHaveLength(43);
		expect(isLitePairingCredential(CREDENTIAL)).toBe(true);
	});

	it.each([
		['the id alone', ID],
		['a short proof', ID + '.' + 'b'.repeat(42)],
		['a long id', 'A'.repeat(44) + '.' + PROOF],
		['a third segment', CREDENTIAL + '.x'],
		['standard base64 characters', ID + '.' + 'b'.repeat(41) + '+/'],
		['surrounding whitespace', ' ' + CREDENTIAL],
		['not a string', 42],
		['undefined', undefined],
	])('refuses %s', (_name, value) => {
		expect(isLitePairingCredential(value)).toBe(false);
	});
});

describe('litePairingDeviceId', () => {
	it('is the public first half of a credential and nothing of the proof', () => {
		expect(litePairingDeviceId(CREDENTIAL)).toBe(ID);
		expect(litePairingDeviceId(CREDENTIAL)).not.toContain(PROOF);
	});

	it('is undefined for anything that is not a credential', () => {
		expect(litePairingDeviceId(ID)).toBeUndefined();
		expect(litePairingDeviceId(null)).toBeUndefined();
	});
});

describe('LITE_PAIRING_CREDENTIAL_SOURCE in running text', () => {
	const find = (text: string) => text.match(new RegExp(LITE_PAIRING_CREDENTIAL_SOURCE, 'g')) ?? [];

	it('finds a credential between words and at either end', () => {
		expect(find(`header ${CREDENTIAL} end`)).toEqual([CREDENTIAL]);
		expect(find(`${CREDENTIAL} first`)).toEqual([CREDENTIAL]);
		expect(find(`last ${CREDENTIAL}`)).toEqual([CREDENTIAL]);
		expect(find(`x-maestro-device-credential: ${CREDENTIAL}\r\n`)).toEqual([CREDENTIAL]);
	});

	it('leaves the device id alone where the chain and History name a device', () => {
		expect(find(`lite-device:${ID} ran it`)).toEqual([]);
		expect(find(`paired-device:${ID}`)).toEqual([]);
	});

	it('does not cut a credential out of a longer base64url run', () => {
		expect(find('Z' + CREDENTIAL)).toEqual([]);
		expect(find(CREDENTIAL + '_')).toEqual([]);
	});
});

describe('the pairing store files', () => {
	it('are the two names the stores own', () => {
		expect(LITE_DEVICE_CREDENTIALS_FILE_NAME).toBe('lite-device-credentials.json');
		expect(LITE_PAIRED_DEVICES_FILE_NAME).toBe('lite-paired-devices.json');
	});

	it.each([
		LITE_DEVICE_CREDENTIALS_FILE_NAME,
		LITE_PAIRED_DEVICES_FILE_NAME,
		'lite-paired-devices.json.tmp',
		'LITE-DEVICE-CREDENTIALS.bak',
		'lite-device-credentials',
	])('recognizes %s in any case, extension or suffix', (name) => {
		expect(isLitePairingStoreFile(name)).toBe(true);
	});

	it.each(['lite-profiles.json', 'device-credentials.md', 'maestro-sessions.json', ''])(
		'leaves %s alone',
		(name) => {
			expect(isLitePairingStoreFile(name)).toBe(false);
		}
	);
});
