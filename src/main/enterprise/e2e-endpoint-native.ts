/**
 * The declared fixture native endpoint port for UNPACKAGED e2e builds
 * (MCOMP-31-05A).
 *
 * Since MCOMP-31-04A a macOS or Windows desktop with no `EndpointNativePort`
 * refuses to open the endpoint, so the fixture-mode enrolled e2e journeys
 * (which dial the contract-fixture daemon) could not enroll on those hosts.
 * This port lets them, and only them: it is returned solely when the app is
 * unpackaged, `NODE_ENV === 'test'` and `MAESTRO_E2E_ENDPOINT_NATIVE=fixture`
 * are all true. A packaged build ignores the variable entirely. The identity it
 * answers is a LABEL, never read from the OS, so it proves nothing about the
 * peer; real platform peer identity stays MCOMP-32.
 */
import { createHash } from 'node:crypto';
import {
	ENDPOINT_NATIVE_PORT_VERSION,
	endpointTransportOf,
	type EndpointNativePort,
	type EndpointServerIdentity,
} from '../../shared/maestro-lib/managed/endpoint-port';

export const E2E_ENDPOINT_NATIVE_ENV = 'MAESTRO_E2E_ENDPOINT_NATIVE';
export const E2E_FIXTURE_ENDPOINT_PRINCIPAL = 'maestro-e2e-fixture-endpoint';

const label = (part: string) =>
	createHash('sha256').update(`${E2E_FIXTURE_ENDPOINT_PRINCIPAL}:${part}`).digest('hex');

/** The labeled server every fixture connection is "verified" as. */
export const E2E_FIXTURE_ENDPOINT_SERVER: EndpointServerIdentity = Object.freeze({
	pid: 1,
	processBirthDigest: label('birth'),
	executableDigest: label('executable'),
	principal: E2E_FIXTURE_ENDPOINT_PRINCIPAL,
});

export interface E2eEndpointNativeGate {
	isPackaged: boolean;
	env: Readonly<Record<string, string | undefined>>;
	platform: NodeJS.Platform;
}

/** The fixture port when every gate holds, else undefined (install nothing). */
export function e2eFixtureEndpointNative(
	gate: E2eEndpointNativeGate
): EndpointNativePort | undefined {
	if (gate.isPackaged) return undefined;
	if (gate.env.NODE_ENV !== 'test') return undefined;
	if (gate.env[E2E_ENDPOINT_NATIVE_ENV] !== 'fixture') return undefined;
	const transport = endpointTransportOf(gate.platform);
	if (transport === null) return undefined;
	const port: EndpointNativePort = {
		version: ENDPOINT_NATIVE_PORT_VERSION,
		platform: gate.platform,
		transport,
		verifyServer: async ({ signal }) =>
			signal.aborted
				? { status: 'unavailable' as const, reason: 'The verification was cancelled.' }
				: { status: 'verified' as const, server: { ...E2E_FIXTURE_ENDPOINT_SERVER } },
	};
	return Object.freeze(port);
}
