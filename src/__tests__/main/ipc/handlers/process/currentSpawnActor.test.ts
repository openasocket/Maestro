/**
 * `currentSpawnActor()` (MRC-08-01A): the actor the renderer's spawn handler
 * and the web terminal callback hand `admitSpawn()`, read off the acting
 * TRANSPORT and never off the acting user. A CLI caller is the host secret,
 * a paired Lite device is the device, a Web Login is the account, and an
 * Electron IPC call outside any context (or a bare path token) is the
 * operator at the keyboard. The acting user is untouched: History still
 * names a paired device `paired-device` while the sink sees a pairing.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
	app: { getPath: (): string => '/tmp/maestro-test-user-data' },
	safeStorage: {
		isEncryptionAvailable: (): boolean => false,
	},
}));
vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('../../../../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../../../main/utils/sentry', () => ({
	captureException: vi.fn(async () => undefined),
	captureMessage: vi.fn(async () => undefined),
	addBreadcrumb: vi.fn(async () => undefined),
}));

import { currentSpawnActor } from '../../../../../main/ipc/handlers/process/handle-spawn';
import { getActingUser, runAsActingUser } from '../../../../../main/web-server/auth/acting-user';
import {
	PAIRED_DEVICE_USER_ID_PREFIX,
	PAIRED_DEVICE_USERNAME,
	runAsClient,
} from '../../../../../main/web-server/auth/transport-actor';

const ada = { id: 'u1', username: 'ada', displayName: 'Ada' };
const device = {
	id: `${PAIRED_DEVICE_USER_ID_PREFIX}dev-7`,
	username: PAIRED_DEVICE_USERNAME,
	displayName: 'Pixel 9',
};

describe('currentSpawnActor', () => {
	it('is the operator at the keyboard outside any context (an Electron IPC call)', () => {
		expect(currentSpawnActor()).toEqual({ peer: 'in-process' });
	});

	it('is the operator for a bare path token socket', () => {
		expect(runAsClient({}, () => currentSpawnActor())).toEqual({ peer: 'in-process' });
	});

	it('is the account for a Web Login, across an await', async () => {
		const actor = await runAsClient({ user: ada }, async () => {
			await Promise.resolve();
			return currentSpawnActor();
		});
		expect(actor).toEqual({ peer: 'web-login', username: 'ada' });
	});

	it('is the host secret for a CLI caller, even one carrying a cookie', () => {
		expect(runAsClient({ cli: true }, () => currentSpawnActor())).toEqual({ peer: 'host-secret' });
		expect(runAsClient({ cli: true, user: ada }, () => currentSpawnActor())).toEqual({
			peer: 'host-secret',
		});
	});

	it('is the device for a Lite pairing, while the acting user still names paired-device', () => {
		const seen = runAsClient({ admission: 'device-pairing', user: device }, () => ({
			actor: currentSpawnActor(),
			user: getActingUser(),
		}));
		expect(seen.actor).toEqual({ peer: 'device-pairing', deviceId: 'dev-7' });
		expect(seen.user).toEqual(device);
	});

	it('does not read the acting user: a user with no transport context is still the operator', () => {
		// Nothing in the app establishes an acting user without runAsClient; if
		// something did, the sink would still not promote it to a transport.
		expect(runAsActingUser(ada, () => currentSpawnActor())).toEqual({ peer: 'in-process' });
	});
});
