/**
 * The Mega-Maestro server this desktop talks to: the address the operator types,
 * validated and turned into the management origin an enrollment request names.
 * Pure: the renderer, the main process and the CLI read the same rules.
 */

export const MEGA_SERVER_DEFAULT_PORT = 443;
export const MEGA_SERVER_FILE_NAME = 'maestro-mega-server.json';

export interface MegaServerSettings {
	/** A host name or an IPv4 or IPv6 literal. No scheme, path or credentials. */
	host: string;
	port: number;
	/** The local endpoint socket this desktop attaches through. Empty: none chosen yet. */
	endpointSocket: string;
}

export const EMPTY_MEGA_SERVER: MegaServerSettings = {
	host: '',
	port: MEGA_SERVER_DEFAULT_PORT,
	endpointSocket: '',
};

const HOST_NAME =
	/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const IPV6 = /^[0-9a-f:.]+$/i;

/** Why `host` is not an address this desktop can contact, or null when it is one. */
export function megaServerHostProblem(host: string): string | null {
	if (host.length === 0) return 'Enter the host name or IP address of the Mega-Maestro server.';
	if (/[\s/@?#]|:\/\//.test(host))
		return 'Enter only the host name or IP address, without a scheme, path or credentials.';
	if (IPV4.test(host)) return null;
	// A dotted run of digits is an IPv4 address, never a host name: a bad one is refused as such.
	if (/^[0-9.]+$/.test(host)) return 'That is not a valid IPv4 address.';
	if (host.includes(':'))
		return IPV6.test(host) && host.split(':').length >= 3
			? null
			: 'That IPv6 address is not valid.';
	if (HOST_NAME.test(host)) return null;
	return 'That is not a valid host name or IP address.';
}

/** Why `port` is not a TCP port, or null when it is one. */
export function megaServerPortProblem(port: number): string | null {
	return Number.isInteger(port) && port >= 1 && port <= 65535
		? null
		: 'The port must be a whole number from 1 to 65535.';
}

/** Why `socketPath` is not a usable endpoint socket, or null. Empty is allowed (none chosen). */
export function megaServerSocketProblem(socketPath: string): string | null {
	if (socketPath.length === 0) return null;
	if (
		!socketPath.startsWith('/') &&
		!/^[a-zA-Z]:\\/.test(socketPath) &&
		!socketPath.startsWith('\\\\')
	)
		return 'The endpoint socket must be an absolute path.';
	if (/[\0\n\r]/.test(socketPath)) return 'The endpoint socket path holds a control character.';
	return null;
}

/** The first problem with `settings`, or null when they are all valid. */
export function megaServerSettingsProblem(settings: MegaServerSettings): string | null {
	return (
		megaServerHostProblem(settings.host) ??
		megaServerPortProblem(settings.port) ??
		megaServerSocketProblem(settings.endpointSocket)
	);
}

/**
 * The management origin an enrollment request names: `https://host:port`. An
 * IPv6 literal is bracketed; the default port is written out so the origin is
 * exact. Callers validate first.
 */
export function megaServerOrigin(settings: Pick<MegaServerSettings, 'host' | 'port'>): string {
	const host = settings.host.includes(':') ? `[${settings.host}]` : settings.host;
	return settings.port === MEGA_SERVER_DEFAULT_PORT
		? `https://${host}`
		: `https://${host}:${settings.port}`;
}

/** The read-only health route every Mega server exposes. */
export function megaServerHealthUrl(settings: Pick<MegaServerSettings, 'host' | 'port'>): string {
	return `${megaServerOrigin(settings)}/healthz`;
}

/** What a lookup found. Every field is a fact of the answer, never a guess. */
export interface MegaServerLookup {
	checkedAt: string;
	/** The server answered its health route. */
	reachable: boolean;
	/** The `status` its health route reported, when the body held one. */
	health: string | null;
	httpStatus: number | null;
	/** The server's own build version. Null: neither the health route nor the endpoint reports one. */
	serverVersion: null;
	/** Why the server build version is unknown, in words the pane shows as is. */
	serverVersionNote: string;
	/** What the local endpoint negotiated, or why it could not be asked. */
	endpoint:
		| { status: 'negotiated'; protocol: number; capabilities: readonly string[] }
		| { status: 'unavailable'; message: string };
	/** The versions this desktop build runs and pins. */
	versions: {
		maestro: string;
		library: string;
		contracts: string | null;
	};
	/** A plain sentence for the reachability result. */
	message: string;
}

export const MEGA_SERVER_VERSION_NOTE =
	'Mega-Maestro does not publish its build version on its health route or its endpoint, so this desktop cannot show it.';

/** The health body's `status` when the body is JSON with one, else null. */
export function megaServerHealthStatus(body: string): string | null {
	try {
		const parsed: unknown = JSON.parse(body);
		if (
			typeof parsed === 'object' &&
			parsed !== null &&
			typeof (parsed as { status?: unknown }).status === 'string'
		)
			return (parsed as { status: string }).status;
	} catch {
		return null;
	}
	return null;
}
