/**
 * Transport admission (MRC-08-01): which transport admitted a socket, read off
 * the client the upgrade built and kept apart from the acting user. A CLI
 * secret, a Lite pairing, a Web Login cookie and the bare path token are each
 * recognized as what they are; `runAsClient` establishes both the acting user
 * and the transport for one dispatch and leaves nothing behind.
 */

import { describe, expect, it } from 'vitest';
import { getActingUser } from '../../../../main/web-server/auth/acting-user';
import {
	DESKTOP_ADMISSION,
	PAIRED_DEVICE_USER_ID_PREFIX,
	PAIRED_DEVICE_USERNAME,
	describeTransportAdmission,
	getActingTransport,
	resolveTransportAdmission,
	runAsClient,
	runAsTransport,
} from '../../../../main/web-server/auth/transport-actor';

const ada = { id: 'u1', username: 'ada', displayName: 'Ada' };
const device = {
	id: `${PAIRED_DEVICE_USER_ID_PREFIX}dev-7`,
	username: PAIRED_DEVICE_USERNAME,
	displayName: 'Pixel 9',
};

describe('resolveTransportAdmission', () => {
	it('reads a Web Login cookie as a login, with the account attached', () => {
		expect(resolveTransportAdmission({ user: ada })).toEqual({ kind: 'web-login', user: ada });
	});

	it('reads the CLI secret as the CLI, and lets it win over a cookie it may also carry', () => {
		expect(resolveTransportAdmission({ cli: true })).toEqual({ kind: 'cli' });
		expect(resolveTransportAdmission({ cli: true, user: ada })).toEqual({ kind: 'cli' });
	});

	it('reads a device pairing as a device, never as the account the route synthesized', () => {
		expect(resolveTransportAdmission({ admission: 'device-pairing', user: device })).toEqual({
			kind: 'lite',
			deviceId: 'dev-7',
			deviceName: 'Pixel 9',
		});
	});

	it('does not infer a device from the shape of an account; the admission method decides', () => {
		// A Web Login account that happens to look like a device is a login.
		expect(resolveTransportAdmission({ user: device })).toEqual({
			kind: 'web-login',
			user: device,
		});
	});

	it('reads a socket with neither cookie nor secret as the owner the path token admits', () => {
		expect(resolveTransportAdmission({})).toEqual({ kind: 'owner-token' });
		expect(resolveTransportAdmission({ cli: false, user: undefined })).toEqual({
			kind: 'owner-token',
		});
	});
});

describe('describeTransportAdmission', () => {
	it('names the transport, and for a login or a device, which one', () => {
		expect(describeTransportAdmission({ kind: 'desktop' })).toBe('desktop');
		expect(describeTransportAdmission({ kind: 'owner-token' })).toBe('owner-token');
		expect(describeTransportAdmission({ kind: 'cli' })).toBe('cli');
		expect(describeTransportAdmission({ kind: 'web-login', user: ada })).toBe('web-login:ada');
		expect(
			describeTransportAdmission({ kind: 'lite', deviceId: 'dev-7', deviceName: 'Pixel 9' })
		).toBe('lite-device:dev-7');
	});
});

describe('acting transport context', () => {
	it('is the desktop outside any context', () => {
		expect(getActingTransport()).toEqual(DESKTOP_ADMISSION);
		expect(getActingTransport().kind).toBe('desktop');
	});

	it('is visible across awaits inside the context and gone after it', async () => {
		const seen = await runAsTransport({ kind: 'cli' }, async () => {
			await Promise.resolve();
			const inner = getActingTransport();
			await new Promise((r) => setTimeout(r, 1));
			return [inner, getActingTransport()];
		});
		expect(seen).toEqual([{ kind: 'cli' }, { kind: 'cli' }]);
		expect(getActingTransport().kind).toBe('desktop');
	});

	it('does not leak between two concurrent contexts', async () => {
		const [a, b] = await Promise.all([
			runAsTransport({ kind: 'cli' }, async () => {
				await new Promise((r) => setTimeout(r, 2));
				return getActingTransport().kind;
			}),
			runAsTransport({ kind: 'web-login', user: ada }, async () => {
				await new Promise((r) => setTimeout(r, 1));
				return getActingTransport().kind;
			}),
		]);
		expect(a).toBe('cli');
		expect(b).toBe('web-login');
	});
});

describe('runAsClient', () => {
	it('establishes the acting user and the transport together for a login', async () => {
		const seen = await runAsClient({ user: ada }, async () => {
			await Promise.resolve();
			return { user: getActingUser(), transport: getActingTransport() };
		});
		expect(seen).toEqual({ user: ada, transport: { kind: 'web-login', user: ada } });
		expect(getActingUser()).toBeUndefined();
		expect(getActingTransport().kind).toBe('desktop');
	});

	it('keeps the synthesized device account for attribution while the transport says device', () => {
		const seen = runAsClient({ admission: 'device-pairing', user: device }, () => ({
			user: getActingUser(),
			transport: getActingTransport(),
		}));
		// History and stats still name the device; a sink sees a pairing, not a login.
		expect(seen.user).toEqual(device);
		expect(seen.transport).toEqual({ kind: 'lite', deviceId: 'dev-7', deviceName: 'Pixel 9' });
	});

	it('gives the CLI no acting user and the CLI transport', () => {
		const seen = runAsClient({ cli: true }, () => ({
			user: getActingUser(),
			transport: getActingTransport(),
		}));
		expect(seen).toEqual({ user: undefined, transport: { kind: 'cli' } });
	});

	it('gives a bare socket no acting user and the owner-token transport', () => {
		const seen = runAsClient({}, () => ({
			user: getActingUser(),
			transport: getActingTransport(),
		}));
		expect(seen).toEqual({ user: undefined, transport: { kind: 'owner-token' } });
	});
});
