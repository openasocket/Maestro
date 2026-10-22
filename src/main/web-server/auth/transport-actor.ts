/**
 * Transport admission - WHICH transport admitted the caller of a main-process
 * call, kept apart from WHO the caller is.
 *
 * Four things admit a socket to this server, and none of them is an
 * enterprise principal (MRC-08-01):
 *
 *   - the path token alone (`owner-token`): the URL is the credential, every
 *     browser that has it is the owner-operator;
 *   - a Web Login session cookie (`web-login`): local accounts, equal
 *     operators of one desktop, a sender's name for History and stats;
 *   - the per-boot CLI secret (`cli`): a process on this machine that can
 *     read `cli-server.json`, so `maestro-cli` and whatever an agent runs;
 *   - a Lite pairing credential (`lite`): a paired DEVICE, bound to this
 *     host's origin and revocable at once (see `lite/pairing`).
 *
 * Each is transport admission, not tenant IAM: it says the call may reach
 * this server, never which enterprise actor it acts as. The managed
 * authority binds the registered actor as the principal and records the
 * transport on the delegation chain as attribution, so a host sink has to
 * know the transport exactly. Until now only the Web Login account was in
 * scope (`acting-user.ts`), which read a `maestro-cli` call as the desktop
 * and a paired device as a Web Login account named `paired-device`.
 *
 * `runAsClient()` establishes both answers for one dispatch: the acting user
 * (unchanged, for attribution) and the admission (new, for the sinks). The
 * bridge wraps every `bridge.invoke` in it and the WebSocket message handler
 * wraps every message, so a sink deep in the main process asks
 * {@link getActingTransport} the way it asks `getActingUser()`. An Electron
 * renderer call runs outside any context and reads `desktop`.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { WebActingUser } from '../../../shared/webLogin';
import type { ProcessSpawnActor } from '../../process-manager/types';
import type { WebClient } from '../types';
import { runAsActingUser } from './acting-user';

export type TransportAdmission =
	/** An Electron renderer IPC call: the operator at the keyboard. */
	| { kind: 'desktop' }
	/** A socket admitted by the path token alone (Web Login off, no account). */
	| { kind: 'owner-token' }
	/** A socket admitted by a Web Login session cookie. */
	| { kind: 'web-login'; user: WebActingUser }
	/** A socket that presented this boot's CLI secret on its upgrade. */
	| { kind: 'cli' }
	/** A socket admitted by a Lite pairing credential: a paired device. */
	| { kind: 'lite'; deviceId: string; deviceName: string };

export const DESKTOP_ADMISSION: TransportAdmission = Object.freeze({ kind: 'desktop' as const });

/**
 * The acting user the Lite connection route synthesizes for a paired device
 * (`routes/liteConnectionRoutes.ts`), so History and stats can name the
 * device. The id form is what {@link resolveTransportAdmission} reads the
 * device id back from; the username is a constant, never an account.
 */
export const PAIRED_DEVICE_USER_ID_PREFIX = 'paired-device:';
export const PAIRED_DEVICE_USERNAME = 'paired-device';

export type TransportClient = Pick<WebClient, 'cli' | 'user' | 'admission'>;

/**
 * Read the transport that admitted a socket off the client the upgrade built.
 * The CLI secret wins over a cookie (a CLI process may carry a browser's
 * cookie jar, a browser cannot present the secret); a device pairing is
 * recognized by the admission method the upgrade recorded, never by the shape
 * of the user it synthesized; a cookie-less, secret-less socket is the
 * owner-operator the path token admits.
 */
export function resolveTransportAdmission(client: TransportClient): TransportAdmission {
	if (client.cli === true) return { kind: 'cli' };
	if (client.admission === 'device-pairing') {
		const id = client.user?.id ?? '';
		return {
			kind: 'lite',
			deviceId: id.startsWith(PAIRED_DEVICE_USER_ID_PREFIX)
				? id.slice(PAIRED_DEVICE_USER_ID_PREFIX.length)
				: id,
			deviceName: client.user?.displayName ?? '',
		};
	}
	if (client.user) return { kind: 'web-login', user: client.user };
	return { kind: 'owner-token' };
}

/** One word for a log line: which transport, and for a login or a device, which one. */
export function describeTransportAdmission(admission: TransportAdmission): string {
	switch (admission.kind) {
		case 'web-login':
			return `web-login:${admission.user.username}`;
		case 'lite':
			return `lite-device:${admission.deviceId}`;
		default:
			return admission.kind;
	}
}

/**
 * The actor a host sink binds for a transport (MRC-08-01A): what
 * `ProcessManager.admitSpawn()` is handed, and what the spawn authority turns
 * into the verification's peer and the delegation chain's attribution. The
 * desktop renderer and the bare path token are both the owner-operator
 * (`in-process`); a Web Login cookie is the account it named; the CLI secret
 * is the host secret, so `maestro-cli` is never bound as the operator at the
 * keyboard; a Lite pairing is the device, never the `paired-device` account
 * the route synthesizes for History.
 */
export function transportSpawnActor(admission: TransportAdmission): ProcessSpawnActor {
	switch (admission.kind) {
		case 'web-login':
			return { peer: 'web-login', username: admission.user.username };
		case 'cli':
			return { peer: 'host-secret' };
		case 'lite':
			return { peer: 'device-pairing', deviceId: admission.deviceId };
		case 'desktop':
		case 'owner-token':
			return { peer: 'in-process' };
	}
}

const storage = new AsyncLocalStorage<TransportAdmission>();

/** Run `fn` with `admission` as the acting transport for every await inside it. */
export function runAsTransport<T>(admission: TransportAdmission, fn: () => T): T {
	return storage.run(admission, fn);
}

/** The transport the current call was admitted over, or `desktop` outside any context. */
export function getActingTransport(): TransportAdmission {
	return storage.getStore() ?? DESKTOP_ADMISSION;
}

/**
 * Run one dispatch from `client` with both answers in scope: the acting user
 * (`getActingUser()`, attribution) and the transport admission
 * (`getActingTransport()`, what a host sink binds). The one wrapper every
 * server entry point uses, so the two cannot disagree about a caller.
 */
export function runAsClient<T>(client: TransportClient, fn: () => T): T {
	return runAsActingUser(client.user, () => runAsTransport(resolveTransportAdmission(client), fn));
}
