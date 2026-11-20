/**
 * The Mega-Maestro server settings file and the lookup of a server: its health
 * route over the enterprise egress class, and what the local endpoint negotiates
 * when it is asked. Nothing here attaches, enrolls or registers; approval is the
 * relayed enrollment request, which the lifecycle sends.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	EMPTY_MEGA_SERVER,
	MEGA_SERVER_FILE_NAME,
	MEGA_SERVER_VERSION_NOTE,
	megaServerHealthStatus,
	megaServerHealthUrl,
	megaServerSettingsProblem,
	type MegaServerLookup,
	type MegaServerSettings,
} from '../../shared/megaServer';
import { createPlatformEndpointClient } from '../../shared/maestro-lib/managed/endpoint-client';
import type { EndpointCompatibilityRequest } from '../../shared/maestro-lib/managed/endpoint-port';
import { fetchWithTimeout } from '../utils/fetchWithTimeout';
import { MAESTRO_LIB_VERSION } from '../../shared/maestro-lib/version';

export const MEGA_SERVER_LOOKUP_TIMEOUT_MS = 8_000;

/** Reads and writes the one settings file in the data directory. */
export interface MegaServerStore {
	read(): MegaServerSettings;
	/** Validates, then writes atomically. Returns the problem, or null when saved. */
	save(settings: MegaServerSettings): string | null;
	readonly file: string;
}

export function createMegaServerStore(userDataDir: string): MegaServerStore {
	const file = path.join(userDataDir, MEGA_SERVER_FILE_NAME);
	return {
		file,
		read(): MegaServerSettings {
			if (!fs.existsSync(file)) return { ...EMPTY_MEGA_SERVER };
			try {
				const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<MegaServerSettings>;
				const merged: MegaServerSettings = {
					host: typeof raw.host === 'string' ? raw.host : EMPTY_MEGA_SERVER.host,
					port: typeof raw.port === 'number' ? raw.port : EMPTY_MEGA_SERVER.port,
					endpointSocket:
						typeof raw.endpointSocket === 'string'
							? raw.endpointSocket
							: EMPTY_MEGA_SERVER.endpointSocket,
				};
				return merged;
			} catch {
				// A file that is not JSON is not a server choice: start empty, never guess.
				return { ...EMPTY_MEGA_SERVER };
			}
		},
		save(settings: MegaServerSettings): string | null {
			const problem = megaServerSettingsProblem(settings);
			if (problem) return problem;
			fs.mkdirSync(userDataDir, { recursive: true });
			const tmp = `${file}.${process.pid}.tmp`;
			fs.writeFileSync(
				tmp,
				`${JSON.stringify({ host: settings.host, port: settings.port, endpointSocket: settings.endpointSocket }, null, 2)}\n`,
				{ mode: 0o600 }
			);
			fs.renameSync(tmp, file);
			return null;
		},
	};
}

export interface MegaServerLookupDeps {
	/** The HTTPS GET of the health route, through the enterprise egress ceiling. Defaults to fetchWithTimeout. */
	fetchHealth?: (url: string) => Promise<{ status: number; body: string }>;
	/** Asks the local endpoint what it negotiates. Defaults to a real compatibility call on the socket. */
	probeEndpoint?: (socketPath: string) => Promise<MegaServerLookup['endpoint']>;
	/** The capabilities this desktop supports, sent in the compatibility request. */
	supportedCapabilities: readonly string[];
	versions: { maestro: string; library: string; contracts: string | null };
	now?: () => Date;
}

async function defaultFetchHealth(url: string): Promise<{ status: number; body: string }> {
	const response = await fetchWithTimeout(
		url,
		{ method: 'GET', headers: { accept: 'application/json' } },
		MEGA_SERVER_LOOKUP_TIMEOUT_MS,
		'enterprise-endpoint'
	);
	return { status: response.status, body: await response.text() };
}

/** Asks the local endpoint's compatibility route. Sends nothing before or after: no attach. */
export function probeEndpointCompatibility(
	supportedCapabilities: readonly string[]
): (socketPath: string) => Promise<MegaServerLookup['endpoint']> {
	return async (socketPath) => {
		const port = createPlatformEndpointClient({ socketPath, timeoutMs: 6_000 });
		const request: EndpointCompatibilityRequest = {
			supportedProtocols: [2],
			supportedCapabilities: [...supportedCapabilities],
			requiredCapabilities: [],
		};
		const outcome = await port.compatibility(request);
		if (outcome.status === 'ok') {
			return {
				status: 'negotiated',
				protocol: outcome.payload.protocol,
				capabilities: [...outcome.payload.capabilities],
			};
		}
		return {
			status: 'unavailable',
			message:
				outcome.status === 'unavailable'
					? outcome.message
					: outcome.status === 'denied'
						? `The endpoint denied the compatibility request: ${outcome.reason}.`
						: outcome.message,
		};
	};
}

/**
 * Looks a server up. A server that cannot be reached is a finding, not an
 * error: the result says so and what was tried. Never throws for a network fault.
 */
export async function lookupMegaServer(
	settings: MegaServerSettings,
	deps: MegaServerLookupDeps
): Promise<MegaServerLookup> {
	const now = deps.now ?? (() => new Date());
	const problem = megaServerSettingsProblem(settings);
	const checkedAt = now().toISOString();
	const versions = deps.versions;
	if (problem) {
		return {
			checkedAt,
			reachable: false,
			health: null,
			httpStatus: null,
			serverVersion: null,
			serverVersionNote: MEGA_SERVER_VERSION_NOTE,
			endpoint: { status: 'unavailable', message: 'No server is saved yet.' },
			versions,
			message: problem,
		};
	}

	const fetchHealth = deps.fetchHealth ?? defaultFetchHealth;
	let reachable = false;
	let health: string | null = null;
	let httpStatus: number | null = null;
	let message: string;
	try {
		const answer = await fetchHealth(megaServerHealthUrl(settings));
		reachable = true;
		httpStatus = answer.status;
		health = megaServerHealthStatus(answer.body);
		message =
			answer.status === 200
				? `The server answered its health route${health ? ` (${health})` : ''}.`
				: `The server answered with HTTP ${answer.status} on its health route.`;
	} catch (error) {
		message = `The server could not be reached: ${error instanceof Error ? error.message : String(error)}.`;
	}

	let endpoint: MegaServerLookup['endpoint'];
	if (settings.endpointSocket.length === 0) {
		endpoint = {
			status: 'unavailable',
			message: 'No local endpoint socket is set, so none was asked.',
		};
	} else {
		try {
			endpoint = await (
				deps.probeEndpoint ?? probeEndpointCompatibility(deps.supportedCapabilities)
			)(settings.endpointSocket);
		} catch (error) {
			endpoint = {
				status: 'unavailable',
				message: `The local endpoint could not be asked: ${error instanceof Error ? error.message : String(error)}.`,
			};
		}
	}

	return {
		checkedAt,
		reachable,
		health,
		httpStatus,
		serverVersion: null,
		serverVersionNote: MEGA_SERVER_VERSION_NOTE,
		endpoint,
		versions,
		message,
	};
}

/** The Mega-Maestro server service the enterprise service exposes: the saved choice, its save and its lookup. */
export interface MegaServerService {
	readonly file: string;
	settings(): MegaServerSettings;
	save(settings: MegaServerSettings): string | null;
	lookup(settings?: MegaServerSettings): Promise<MegaServerLookup>;
}

export interface MegaServerServiceDeps {
	userDataDir: string;
	appVersion: string;
	supportedCapabilities: readonly string[];
	/** The contracts pin's version, read the way the inventory reads it; null when none is named here. */
	contractsVersion(): string | null;
	/** Test seams. */
	fetchHealth?: MegaServerLookupDeps['fetchHealth'];
	probeEndpoint?: MegaServerLookupDeps['probeEndpoint'];
}

export function createMegaServerService(deps: MegaServerServiceDeps): MegaServerService {
	const store = createMegaServerStore(deps.userDataDir);
	return {
		file: store.file,
		settings: () => store.read(),
		save: (settings) => store.save(settings),
		lookup: (settings) =>
			lookupMegaServer(settings ?? store.read(), {
				fetchHealth: deps.fetchHealth,
				probeEndpoint: deps.probeEndpoint,
				supportedCapabilities: deps.supportedCapabilities,
				versions: {
					maestro: deps.appVersion,
					library: MAESTRO_LIB_VERSION,
					contracts: deps.contractsVersion(),
				},
			}),
	};
}
