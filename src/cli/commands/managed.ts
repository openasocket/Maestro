// Managed operation commands (MRC2-07-01): the maestro-cli path of the
// Mega-Maestro section of Settings > Environment. Every verb sends one typed
// message over the WebSocket bridge, and the desktop answers it from the one
// facade the pane and the `enterprise:*` IPC handlers read as well,
// `EnterpriseService.managed` in `src/main/enterprise/service.ts`.
//
// Wire contract (the bridge handlers of MRC2-07-03 answer these; each
// `<type>_result` carries `success` and the named field):
//   managed_status (state), managed_inventory (inventory), managed_support_matrix (matrix),
//   managed_locks (locks), managed_policy_refresh (outcome), managed_enroll_request (outcome)
// The last one is for CLI-secret clients only: a browser never enrolls. A
// desktop with no enterprise service answers `success: false` with the
// service's own line; an older desktop answers the unknown type (exit 4).
//
// Nothing printed here is a secret: every answer is the projection the pane
// shows. The enrollment request is the one secret-carrying input; it is read
// from a file, relayed once, and never echoed, not even in an error.

import * as fs from 'fs';
import type { EnrollmentRequestInput, LifecycleOutcome } from '../../main/enterprise/enrollment';
import type { InstallationInventory } from '../../main/enterprise/inventory';
import type { ManagedStateView } from '../../main/enterprise/managed-state';
import type { ManagedSupportMatrix } from '../../main/enterprise/service';
import type {
	EndpointEnrollmentResult,
	EndpointStatus,
} from '../../shared/maestro-lib/managed/endpoint-port';
import type { ManagedSettingLocksView } from '../../shared/managedSettingsLock';
import { ExitCode, exitWith } from '../exit-codes';
import { formatSuccess } from '../output/formatter';
import { isQuiet } from '../output/verbosity';
import {
	errorFrameMessage,
	failCommand,
	failFromError,
	sendSimpleCommand,
	type SimpleResult,
} from '../services/session-command';
import { resolveCliPath } from '../utils/parse';

export interface ManagedOptions {
	json?: boolean;
}

export interface ManagedEnrollOptions extends ManagedOptions {
	/** A JSON file holding the enrollment request (see `ENROLLMENT_REQUEST_FIELDS`). */
	file: string;
	socket?: string;
	tenant?: string;
	org?: string;
	mode?: string;
	profile?: string;
	trustRoot?: string;
}

/** The fields an enrollment request file names; the two last are the secrets the endpoint tooling issued. */
export const ENROLLMENT_REQUEST_FIELDS: readonly (keyof EnrollmentRequestInput)[] = [
	'socketPath',
	'tenantId',
	'orgId',
	'mode',
	'collectionProfile',
	'trustRootDigest',
	'invitation',
	'keyPossessionProof',
];

const NO_SERVICE_MESSAGE = 'The enterprise enrollment service is not running in this desktop.';

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Ask the desktop one managed question and return the answer's `field`. A
 * missing app is exit 3, an old app exit 4, a hung one exit 5; a desktop
 * with no service answers `success: false` and is exit 1 with its own line.
 */
async function askDesktop<T>(
	message: Record<string, unknown>,
	responseType: string,
	field: string,
	json?: boolean
): Promise<T> {
	let reply: SimpleResult;
	try {
		reply = await sendSimpleCommand<SimpleResult>(message, responseType);
	} catch (error) {
		return failFromError(error, json);
	}
	const frameError = errorFrameMessage(reply);
	if (frameError) return failCommand(frameError, json);
	if (!reply.success) return failCommand(reply.error || NO_SERVICE_MESSAGE, json);
	const value = reply[field];
	if (value === undefined || value === null) return failCommand(NO_SERVICE_MESSAGE, json);
	return value as T;
}

const revision = (value: number | null): string => (value === null ? 'none' : String(value));
const yesNo = (value: boolean): string => (value ? 'yes' : 'no');

/** One line for a lifecycle outcome that is not `ok`; the endpoint's or the service's own words. */
export function describeOutcome(outcome: LifecycleOutcome<unknown>): string {
	switch (outcome.status) {
		case 'ok':
			return 'ok';
		case 'refused':
			return `refused (${outcome.reason}): ${outcome.message}`;
		case 'unsupported':
			return `unsupported (owner ${outcome.owner}): ${outcome.message}`;
		case 'denied':
			return `denied by the endpoint on ${outcome.operation}: ${outcome.reason}`;
		case 'unavailable':
		case 'unknown':
			return `${outcome.status}: ${outcome.message}`;
	}
}

/** Print a lifecycle outcome; `ok` is exit 0, anything else exit 1 with the outcome kept in the JSON. */
function reportOutcome(
	outcome: LifecycleOutcome<unknown>,
	json: boolean | undefined,
	successLine: (value: never) => string
): void {
	if (json) {
		console.log(JSON.stringify({ success: outcome.status === 'ok', outcome }));
		if (outcome.status !== 'ok') exitWith(ExitCode.GeneralError);
		return;
	}
	if (outcome.status === 'ok') {
		if (!isQuiet()) console.log(formatSuccess(successLine(outcome.value as never)));
		return;
	}
	failCommand(describeOutcome(outcome), json);
}

// ---------------------------------------------------------------------------
// Human-readable renderers. Every value is the pane's projection: printable.
// ---------------------------------------------------------------------------

export function formatManagedStatus(state: ManagedStateView): string {
	const lines: string[] = [];
	lines.push(`Managed standing: ${state.standing}${state.reason ? ` (${state.reason})` : ''}`);
	const e = state.enrollment;
	if (e) {
		lines.push(
			`Enrollment: tenant ${e.tenantId}, org ${e.orgId}, management ${e.management}, enrollment ${e.enrollmentId ?? 'pending'}`
		);
		lines.push(
			`Installation: ${e.installationId} (enrolled ${e.enrolledAt}, updated ${e.updatedAt})`
		);
	} else {
		lines.push('Enrollment: none');
	}
	const ep = state.endpoint;
	lines.push(
		`Endpoint: ${ep.attached ? 'attached' : 'detached'}; connectivity ${ep.connectivity}; management ${ep.management ?? 'unknown'}; profile ${ep.collectionProfile ?? 'none'}`
	);
	if (ep.lastDenial) {
		lines.push(
			`  last denial: ${ep.lastDenial.operation} ${ep.lastDenial.reason} at ${ep.lastDenial.at}`
		);
	}
	const a = state.actor;
	lines.push(
		`Actor: ${a.actorId ?? 'none'}; phase ${a.phase}; registration ${a.registration.state}; approval ${a.approval.state}`
	);
	const p = state.policy;
	const converged = p.converged === null ? 'unknown' : yesNo(p.converged);
	lines.push(
		`Policy: desired ${revision(p.desiredRevision)}, applied ${revision(p.appliedRevision)}, installed ${revision(p.installedRevision)}; source ${p.source}; ${p.freshness}; converged ${converged}; offline mode ${p.offline.mode}`
	);
	const reasons = p.admission.reasons.length ? ` (${p.admission.reasons.join('; ')})` : '';
	lines.push(`Admission: ${p.admission.possible ? 'possible' : 'not possible'}${reasons}`);
	const c = state.capabilities;
	const missing = c.missing.length ? `; missing ${c.missing.join(', ')}` : '';
	lines.push(`Capabilities: ${c.negotiated.length} of ${c.supported.length} negotiated${missing}`);
	lines.push(
		`Held: egress ${state.egress.held.length}, listeners ${state.listeners.held.length}, update ${state.update.held ? 'yes' : 'none'}`
	);
	lines.push(
		`Custody: ${state.custody.state}, record ${state.custody.record}${state.custody.message ? ` (${state.custody.message})` : ''}`
	);
	lines.push(
		state.localRelease.allowed
			? `Local release: allowed (${state.localRelease.reason})`
			: `Local release: required by the endpoint (${state.localRelease.message})`
	);
	return lines.join('\n');
}

/** The inventory and the support matrix are nested records of build and standing facts; without `--json` they print indented, one field per line. */
const indented = (value: unknown): string => JSON.stringify(value, null, 2);

export function formatManagedLocks(view: ManagedSettingLocksView): string {
	const keys = Object.keys(view.locks);
	const rev = view.policyRevision !== null ? ` (policy revision ${view.policyRevision})` : '';
	if (keys.length === 0) return `No settings are held by a managed policy${rev}.`;
	const lines = [`Settings held by the managed policy${rev}: ${keys.length}`];
	for (const key of keys) {
		const lock = view.locks[key];
		lines.push(`  ${key.padEnd(32)} ${lock.code}${lock.pinned ? ', pinned' : ''}: ${lock.message}`);
	}
	return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Verbs
// ---------------------------------------------------------------------------

/** `managed status`: the standing the Settings > Environment pane shows. */
export async function managedStatus(options: ManagedOptions): Promise<void> {
	const state = await askDesktop<ManagedStateView>(
		{ type: 'managed_status' },
		'managed_status_result',
		'state',
		options.json
	);
	if (options.json) console.log(JSON.stringify({ success: true, state }));
	else console.log(formatManagedStatus(state));
}

/** `managed inventory`: what this installation is and can do (MRC-10-06B). */
export async function managedInventory(options: ManagedOptions): Promise<void> {
	const inventory = await askDesktop<InstallationInventory>(
		{ type: 'managed_inventory' },
		'managed_inventory_result',
		'inventory',
		options.json
	);
	if (options.json) console.log(JSON.stringify({ success: true, inventory }));
	else console.log(indented(inventory));
}

/** `managed support-matrix`: this build's capability, counterpart and per-route support rows. */
export async function managedSupportMatrix(options: ManagedOptions): Promise<void> {
	const matrix = await askDesktop<ManagedSupportMatrix>(
		{ type: 'managed_support_matrix' },
		'managed_support_matrix_result',
		'matrix',
		options.json
	);
	if (options.json) console.log(JSON.stringify({ success: true, matrix }));
	else console.log(indented(matrix));
}

/** `managed locks`: every settings key the managed policy holds right now (the Managed badge, MRC2-06-05). */
export async function managedLocks(options: ManagedOptions): Promise<void> {
	const locks = await askDesktop<ManagedSettingLocksView>(
		{ type: 'managed_locks' },
		'managed_locks_result',
		'locks',
		options.json
	);
	if (options.json) console.log(JSON.stringify({ success: true, locks }));
	else console.log(formatManagedLocks(locks));
}

/** `managed policy refresh`: an authenticated status update over the registered socket (the pane's Refresh policy). */
export async function managedPolicyRefresh(options: ManagedOptions): Promise<void> {
	const outcome = await askDesktop<LifecycleOutcome<EndpointStatus>>(
		{ type: 'managed_policy_refresh' },
		'managed_policy_refresh_result',
		'outcome',
		options.json
	);
	reportOutcome(
		outcome,
		options.json,
		(status: EndpointStatus) =>
			`Policy refreshed from the endpoint: management ${status.management}, connectivity ${status.connectivity}, desired revision ${revision(status.desiredPolicyRevision)}, applied ${revision(status.appliedPolicyRevision)}.`
	);
}

/**
 * `managed enroll request`: relay an enrollment request to the endpoint. The
 * request is a JSON file so the invitation and the key-possession proof never
 * sit on a command line; `--socket`, `--tenant`, `--org`, `--mode`,
 * `--profile` and `--trust-root` override the file's non-secret fields. The
 * desktop validates the request before the lifecycle sees it; a missing field
 * is named here, a value never is.
 */
export async function managedEnrollRequest(options: ManagedEnrollOptions): Promise<void> {
	let raw: unknown;
	try {
		raw = JSON.parse(fs.readFileSync(resolveCliPath(options.file), 'utf8'));
	} catch (error) {
		// A parse error quotes the text it choked on; the file holds secrets, so neither is printed.
		const detail =
			error instanceof SyntaxError
				? 'it is not valid JSON'
				: error instanceof Error && 'code' in error
					? `${String((error as NodeJS.ErrnoException).code)}`
					: 'it could not be read';
		return failCommand(`Could not read the enrollment request file: ${detail}.`, options.json);
	}
	if (!isRecord(raw)) {
		return failCommand('The enrollment request file must hold a JSON object.', options.json);
	}
	const overrides: Record<string, string> = {};
	if (options.socket) overrides.socketPath = resolveCliPath(options.socket);
	if (options.tenant) overrides.tenantId = options.tenant;
	if (options.org) overrides.orgId = options.org;
	if (options.mode) overrides.mode = options.mode;
	if (options.profile) overrides.collectionProfile = options.profile;
	if (options.trustRoot) overrides.trustRootDigest = options.trustRoot;
	const request: Record<string, unknown> = {};
	for (const field of ENROLLMENT_REQUEST_FIELDS) {
		const value = overrides[field] ?? raw[field];
		if (value !== undefined) request[field] = value;
	}
	const missing = ENROLLMENT_REQUEST_FIELDS.filter(
		(field) => typeof request[field] !== 'string' || request[field] === ''
	);
	if (missing.length) {
		return failCommand(`The enrollment request is missing: ${missing.join(', ')}.`, options.json);
	}
	const outcome = await askDesktop<LifecycleOutcome<EndpointEnrollmentResult>>(
		{ type: 'managed_enroll_request', request },
		'managed_enroll_request_result',
		'outcome',
		options.json
	);
	reportOutcome(
		outcome,
		options.json,
		(result: EndpointEnrollmentResult) =>
			`Enrollment requested: ${result.outcome}, enrollment ${result.enrollmentId}. Approve it with the endpoint tooling, then run \`managed policy refresh\`.`
	);
}
