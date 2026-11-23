/**
 * Copy diagnostics for Connect to your organization (MSX-03-04): the bundle
 * the Troubleshoot tab's Copy diagnostics button puts on the clipboard, which
 * `enterprise:connectDiagnostics` answers and `maestro-cli managed connect
 * diagnostics` prints (through the bridge `managed_connect_diagnostics`). All
 * three read `ConnectService.diagnostics()`, which calls this module.
 *
 * The bundle is built from an allowlist: the connection state's NAME, the app
 * and library versions, the endpoint socket in use, the last 50 refusal codes
 * and the certificate expiry. Nothing else of the status is copied, so the
 * matching number, the request reference, a grant ID, the organization and
 * the account never enter it (the generic redactor intentionally keeps IDs and
 * digests, so leaving them out here is the only protection they get). The
 * bundle then goes through the contracts `redact()` (transcribed in
 * `megaConnect/diagnostics.ts`) and then through `redactSecrets()` on every
 * string, and only that result leaves main.
 *
 * Certificate expiry: the endpoint owns the device certificate
 * (`identity-store.ts`), and no Maestro surface exposes its expiry yet, so the
 * field is null until the endpoint publishes one.
 */

import { MAESTRO_LIB_VERSION } from '../../shared/maestro-lib/version';
import { redact, type Redacted } from '../../shared/megaConnect/diagnostics';
import type { ResolvedEndpointSocket } from '../../shared/megaServer';
import { redactSecrets } from '../../shared/redactSecrets';
import type { ConnectRefusal, ConnectStatusView } from './connect';

/** How many refusal codes the history keeps: the last 50, oldest first. */
export const CONNECT_REFUSAL_HISTORY_CAP = 50;

/** The bundle's schema name, so a reader can tell a bundle apart from other JSON. */
export const CONNECT_DIAGNOSTICS_SCHEMA = 'maestro-connect-diagnostics/1';

/**
 * The refusal codes of this app session, in memory only and never persisted.
 * It holds codes alone: never an input value, a rule reason or a timestamp.
 */
export interface ConnectRefusalHistory {
	note(refusal: ConnectRefusal): void;
	/** Oldest first; at most `CONNECT_REFUSAL_HISTORY_CAP`. */
	list(): ConnectRefusal[];
}

export function createConnectRefusalHistory(
	cap: number = CONNECT_REFUSAL_HISTORY_CAP
): ConnectRefusalHistory {
	const codes: ConnectRefusal[] = [];
	return {
		note(refusal) {
			codes.push(refusal);
			if (codes.length > cap) codes.splice(0, codes.length - cap);
		},
		list: () => [...codes],
	};
}

/** What the collector reads. Every field is a value main already holds. */
export interface ConnectDiagnosticsInput {
	status: ConnectStatusView;
	refusals: readonly string[];
	appVersion: string | null;
	socket: ResolvedEndpointSocket;
	certificateExpiry: string | null;
	now: number;
}

/** The allowlisted bundle, before redaction. */
export interface ConnectDiagnosticsBundle {
	schema: typeof CONNECT_DIAGNOSTICS_SCHEMA;
	collected_at: string;
	connection_status: string;
	app_version: string | null;
	library_version: string;
	socket_path: string | null;
	socket_source: ResolvedEndpointSocket['source'];
	recent_refusals: string[];
	certificate_expiry: string | null;
}

/**
 * Build the bundle from the allowlist. Only `status.kind` is read from the
 * status; its other fields (the matching number, the request, names, policy)
 * are never touched, whatever the status carries.
 */
export function collectConnectDiagnostics(
	input: ConnectDiagnosticsInput
): ConnectDiagnosticsBundle {
	return {
		schema: CONNECT_DIAGNOSTICS_SCHEMA,
		collected_at: new Date(input.now).toISOString(),
		connection_status: input.status.status.kind,
		app_version: input.appVersion,
		library_version: MAESTRO_LIB_VERSION,
		socket_path: input.socket.socketPath,
		socket_source: input.socket.source,
		recent_refusals: input.refusals.slice(-CONNECT_REFUSAL_HISTORY_CAP).map(String),
		certificate_expiry: input.certificateExpiry,
	};
}

function redactSecretStrings(value: Redacted): Redacted {
	if (typeof value === 'string') return redactSecrets(value).text;
	if (Array.isArray(value)) return value.map(redactSecretStrings);
	if (value !== null && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [key, redactSecretStrings(item)])
		);
	}
	return value;
}

/**
 * The bundle as it may leave main: the contracts `redact()` first, then
 * `redactSecrets()` on every string. Per string rather than over the JSON
 * text, so the result always stays valid JSON.
 */
export async function redactConnectDiagnostics(
	bundle: ConnectDiagnosticsBundle
): Promise<Redacted> {
	return redactSecretStrings(await redact(bundle));
}

/** Collect, then redact: the one path every surface takes. */
export async function buildConnectDiagnostics(input: ConnectDiagnosticsInput): Promise<Redacted> {
	return redactConnectDiagnostics(collectConnectDiagnostics(input));
}

/** The clipboard text of a redacted bundle. */
export function connectDiagnosticsText(redacted: Redacted): string {
	return `${JSON.stringify(redacted, null, 2)}\n`;
}
