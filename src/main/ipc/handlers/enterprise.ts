/**
 * Enterprise enrollment IPC: the narrow set of lifecycle and status requests
 * the renderer may make of the main-process enrollment service.
 *
 * Over the web bridge (`src/main/web-server/handlers/bridgeDenyList.ts`) a
 * signed-in browser reaches the managed state, the inventory and the inbox
 * (state, refresh, act) alone (MRC2-07-03); enrollment, registration, the
 * lifecycle writes, custody and clearing are desktop-only by construction.
 * What crosses the bridge is the public projection only
 * (`ManagedEnrollmentStatus`, `ManagedPolicyStatus`, the lifecycle's outcome
 * records): no sealed bytes, no install secret, no anchor, nothing the
 * endpoint holds. The one secret-shaped value is the
 * registration approval (`beginRegistration`), a one-time pairing code the
 * actor must read off the screen and type into the console; it is returned
 * once and never persisted or logged anywhere in main.
 *
 * Every verb is validated here before it reaches the lifecycle, and the
 * lifecycle serializes them, so two renderer windows cannot interleave an
 * enroll and a revoke. `withIpcErrorLogging` re-throws, so a genuine fault
 * still reaches Sentry and the renderer's inline error text is the service's
 * own sentence; a refusal is a normal outcome, not a throw.
 */

import { ipcMain } from 'electron';
import * as path from 'path';

import { isEndpointDigest } from '../../../shared/maestro-lib/managed/endpoint-port';
import { resolveEndpointSocket } from '../../../shared/megaServer';
import type { EndpointInboxAction } from '../../../shared/maestro-lib/managed/host-adapter';
import type { CommandService, CommandServiceStatus } from '../../enterprise/commands';
import {
	parseConnectStartInput,
	type ConnectResult,
	type ConnectService,
	type ConnectStatusView,
} from '../../enterprise/connect';
import {
	buildConnectDiagnostics,
	connectDiagnosticsText,
} from '../../enterprise/connect-diagnostics';
import type { Redacted } from '../../../shared/megaConnect/diagnostics';
import type { ManagedRunView } from '../../enterprise/dispatch';
import type {
	EnrollmentLifecycle,
	EnrollmentRequestInput,
	LifecycleOutcome,
} from '../../enterprise/enrollment';
import type {
	EnterpriseIdentityStore,
	IdentityClearOutcome,
	IdentityCustodyState,
} from '../../enterprise/identity-store';
import {
	inboxActionProblem,
	inboxView,
	type InboxActionOutcome,
	type InboxClient,
	type ManagedInboxView,
} from '../../enterprise/inbox';
import { NO_INBOX_OUTCOME, type ManagedInboxActInput } from '../../enterprise/service';
import {
	localReleaseOf,
	type LocalRelease,
	type ManagedStateView,
} from '../../enterprise/managed-state';
import type { PolicyStatusService } from '../../enterprise/policy-status';
import type { ManagedOperations } from '../../enterprise/service';
import type { MegaServerService } from '../../enterprise/mega-server';
import type { MegaServerLookup, MegaServerSettings } from '../../../shared/megaServer';
import { withIpcErrorLogging } from '../../utils/ipcHandler';

const LOG_CONTEXT = '[Enterprise]';
const MAX_TEXT = 8192;
const PHASES = ['request', 'prove', 'activate'] as const;
const ACTIVATION_KEY_STORAGE = ['software', 'customer_kms'] as const;
const NONCE = /^[A-Za-z0-9_-]{43}$/;

export interface EnterpriseHandlerDependencies {
	getLifecycle: () => EnrollmentLifecycle | null;
	getPolicyStatus: () => PolicyStatusService | null;
	getIdentity: () => EnterpriseIdentityStore | null;
	/**
	 * The managed status surface (`service.ts`, MRC2-07-01): the one implementation
	 * of status, enrollment request, policy refresh and inventory that the bridge
	 * and `maestro-cli managed` call too; null when no service runs.
	 */
	getManaged: () => ManagedOperations | null;
	/** The Mega-Maestro server settings and lookup (`mega-server.ts`); null when no service runs. */
	getMegaServer: () => MegaServerService | null;
	/** The notice and inbox client (MRC-11-04); null when no service runs. */
	getInbox: () => InboxClient | null;
	/** The typed runtime command service (MRC-11-05); null when no service runs. Read only: nothing here delivers a command. */
	getCommands: () => CommandService | null;
	/**
	 * Connect to your organization (`connect.ts`, MSX-02-02): start, status and
	 * disconnect; null (or absent) when no service runs.
	 */
	getConnect?: () => ConnectService | null;
	/** Pushes each connect status change to the renderers on `enterprise:connectStatus`. */
	safeSend?: (channel: string, ...args: unknown[]) => void;
}

/** The connect push channel; the same name as the status read, as the preload subscribes to it. */
export const CONNECT_STATUS_CHANNEL = 'enterprise:connectStatus';
/** A desktop with no service cannot connect: the same refusal a service with no port gives. */
export const NO_CONNECT_SERVICE: ConnectResult<never> = {
	ok: false,
	refusal: 'endpoint_connect_unavailable',
};
export const NO_CONNECT_STATUS: ConnectStatusView = { status: { kind: 'unavailable' } };

/**
 * The Copy diagnostics bundle (MSX-03-04), redacted: the connect service's own
 * when one runs, otherwise the same allowlist read with no service (status
 * unavailable, no refusals, no app version, the saved or standard socket).
 * The IPC handler and the bridge `managed_connect_diagnostics` both answer from it.
 */
export function readConnectDiagnostics(
	connect: ConnectService | null,
	savedSocket: string = ''
): Promise<Redacted> {
	if (connect) return connect.diagnostics();
	return buildConnectDiagnostics({
		status: NO_CONNECT_STATUS,
		refusals: [],
		appVersion: null,
		socket: resolveEndpointSocket(savedSocket, process.platform),
		certificateExpiry: null,
		now: Date.now(),
	});
}

/**
 * The renderer's (or a bridge client's) start input, validated in main by the
 * contracts 0.5.0 connect schemas before the service sees it (the connect*
 * rules in `megaConnect/input.ts` through `parseConnectStartInput`). A rejection names
 * its rule and never carries the value (a typed email, a join code).
 */
export function validateConnectStart(raw: unknown): ConnectResult<never> | null {
	const parsed = parseConnectStartInput(raw);
	return parsed.ok ? null : { ok: false, refusal: 'invalid_input', reason: parsed.reason };
}

function handlerOpts(operation: string) {
	return { context: LOG_CONTEXT, operation };
}

function text(value: unknown, name: string, max = MAX_TEXT): string {
	if (typeof value !== 'string' || value.length === 0 || value.length > max) {
		throw new Error(`${name} must be a string of 1 to ${max} characters.`);
	}
	return value;
}

function oneOf<T extends string>(value: unknown, name: string, allowed: readonly T[]): T {
	if (typeof value !== 'string' || !allowed.includes(value as T)) {
		throw new Error(`${name} must be one of ${allowed.join(', ')}.`);
	}
	return value as T;
}

function record(value: unknown, name: string): Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value))
		throw new Error(`${name} must be an object.`);
	return value as Record<string, unknown>;
}

function digest(value: unknown, name: string): string {
	if (!isEndpointDigest(value)) throw new Error(`${name} must be a lowercase sha256 hex digest.`);
	return value;
}

function timestamp(value: unknown, name: string): string {
	const at = text(value, name, 64);
	if (!Number.isFinite(Date.parse(at))) throw new Error(`${name} must be a timestamp.`);
	return at;
}

/** A canonical HTTPS management origin (`new URL(origin).origin === origin`). */
function managementOrigin(value: unknown): string {
	const origin = text(value, 'management.origin', 2048);
	let url: URL;
	try {
		url = new URL(origin);
	} catch {
		throw new Error('management.origin must be a canonical HTTPS origin.');
	}
	if (url.protocol !== 'https:' || url.origin !== origin)
		throw new Error('management.origin must be a canonical HTTPS origin.');
	return origin;
}

/**
 * One relayed enrollment phase as the renderer, the bridge or the CLI may send
 * it (decision D1: request, prove, activate); anything else is refused before
 * the lifecycle. No phase carries an invitation, a bearer or a private key.
 */
export function validateEnrollmentRequest(raw: unknown): EnrollmentRequestInput {
	const input = record(raw, 'The enrollment request');
	// An empty socket means this platform's standard endpoint socket (resolveEndpointSocket).
	const resolved = resolveEndpointSocket(
		input.socketPath === '' ? '' : text(input.socketPath, 'socketPath', 103),
		process.platform
	);
	if (resolved.socketPath === null) throw new Error(resolved.reason);
	const socketPath = resolved.socketPath;
	if (!path.isAbsolute(socketPath))
		throw new Error('socketPath must be an absolute Unix socket path.');
	const m = record(input.management, 'management');
	const management = {
		origin: managementOrigin(m.origin),
		tenantId: text(m.tenantId, 'management.tenantId', 128),
		issuerSha256: digest(m.issuerSha256, 'management.issuerSha256'),
	};
	const phase = oneOf(input.phase, 'phase', PHASES);
	if (phase === 'request') {
		return {
			phase,
			socketPath,
			management,
			orgId: text(input.orgId, 'orgId', 128),
			serverCaPem: text(input.serverCaPem, 'serverCaPem', 32768),
		};
	}
	if (phase === 'prove') {
		const c = record(input.challenge, 'challenge');
		const nonce = text(c.nonce, 'challenge.nonce', 43);
		if (!NONCE.test(nonce)) throw new Error('challenge.nonce must be 43 base64url characters.');
		return {
			phase,
			socketPath,
			management,
			challenge: {
				id: text(c.id, 'challenge.id', 128),
				enrollmentId: text(c.enrollmentId, 'challenge.enrollmentId', 128),
				nonce,
				expiresAt: timestamp(c.expiresAt, 'challenge.expiresAt'),
			},
		};
	}
	const act = record(input.activation, 'activation');
	const trust = record(act.trust, 'activation.trust');
	const activation = {
		enrollmentId: text(act.enrollmentId, 'activation.enrollmentId', 128),
		certificatePem: text(act.certificatePem, 'activation.certificatePem', 16384),
		trust: {
			tenantId: text(trust.tenantId, 'activation.trust.tenantId', 128),
			certificatePem: text(trust.certificatePem, 'activation.trust.certificatePem', 16384),
			issuerSha256: digest(trust.issuerSha256, 'activation.trust.issuerSha256'),
			keyStorage: oneOf(trust.keyStorage, 'activation.trust.keyStorage', ACTIVATION_KEY_STORAGE),
		},
	};
	if (
		activation.trust.tenantId !== management.tenantId ||
		activation.trust.issuerSha256 !== management.issuerSha256
	) {
		throw new Error('The activation must carry the named tenant and trust.');
	}
	return { phase, socketPath, management, activation };
}

function installationInput(raw: unknown): { installationId: string } {
	if (typeof raw !== 'object' || raw === null)
		throw new Error('The request must name an installation.');
	return {
		installationId: text((raw as Record<string, unknown>).installationId, 'installationId', 256),
	};
}

const NO_SERVICE_MESSAGE = 'The enterprise enrollment service is not running in this desktop.';
const NO_SERVICE: LifecycleOutcome<never> = { status: 'unavailable', message: NO_SERVICE_MESSAGE };
const MAX_ID = 256;

/**
 * One inbox act as the renderer may send it; refused here, by name, before the
 * facade sees it. The campaign is optional: the facade resolves it from the
 * held notices (MRC2-07-02), and refuses an id held under two by name.
 */
export function validateInboxAct(raw: unknown): ManagedInboxActInput {
	if (typeof raw !== 'object' || raw === null) throw new Error('An inbox act must be an object.');
	const input = raw as Record<string, unknown>;
	const problem = inboxActionProblem(input.action);
	if (problem) throw new Error(`action: ${problem}.`);
	return {
		...(input.campaignId === undefined
			? {}
			: { campaignId: text(input.campaignId, 'campaignId', MAX_ID) }),
		messageId: text(input.messageId, 'messageId', MAX_ID),
		action: input.action as EndpointInboxAction,
	};
}

/**
 * The narrow standing a settings pane reads (MRC-11-03), or null without a
 * service. The projection itself lives in `service.ts` (`managed.status()`,
 * MRC2-07-01) so the bridge and the CLI answer with the same sentence.
 */
export function readManagedState(deps: EnterpriseHandlerDependencies): ManagedStateView | null {
	return deps.getManaged()?.status() ?? null;
}

/** The address the operator typed, shape-checked; the value rules are `megaServerSettingsProblem`. */
function validateMegaServerSettings(raw: unknown): MegaServerSettings {
	if (typeof raw !== 'object' || raw === null)
		throw new Error('The Mega-Maestro server settings must be an object.');
	const value = raw as Record<string, unknown>;
	if (typeof value.host !== 'string' || value.host.length > 253)
		throw new Error('host must be a string of at most 253 characters.');
	if (typeof value.port !== 'number' || !Number.isFinite(value.port))
		throw new Error('port must be a number.');
	const endpointSocket = value.endpointSocket ?? '';
	if (typeof endpointSocket !== 'string' || endpointSocket.length > 4096)
		throw new Error('endpointSocket must be a string of at most 4096 characters.');
	return { host: value.host.trim(), port: value.port, endpointSocket: endpointSocket.trim() };
}

export function registerEnterpriseHandlers(deps: EnterpriseHandlerDependencies): void {
	const lifecycle = () => deps.getLifecycle();
	// Required management is not a local setting: a record the endpoint still
	// manages cannot be retired, revoked or forgotten from this desktop until the
	// endpoint releases it. Read fresh at each verb, never cached.
	const localRelease = (): LocalRelease => {
		const current = lifecycle();
		return current ? localReleaseOf(current.status()) : { allowed: true, reason: 'no-record' };
	};

	ipcMain.handle(
		'enterprise:status',
		withIpcErrorLogging(handlerOpts('status'), async () => lifecycle()?.status() ?? null)
	);

	ipcMain.handle(
		'enterprise:managedState',
		withIpcErrorLogging(handlerOpts('managedState'), async () => readManagedState(deps))
	);

	ipcMain.handle(
		'enterprise:custody',
		withIpcErrorLogging(
			handlerOpts('custody'),
			async (): Promise<IdentityCustodyState | null> => deps.getIdentity()?.custody() ?? null
		)
	);

	ipcMain.handle(
		'enterprise:policyStatus',
		withIpcErrorLogging(
			handlerOpts('policyStatus'),
			async () => deps.getPolicyStatus()?.status() ?? null
		)
	);

	// The local read of what this installation is and can do: versions, standing,
	// routes with detection apart from enforcement, collection health, named gaps.
	// No path, socket or secret is in it (`src/main/enterprise/inventory.ts`).
	ipcMain.handle(
		'enterprise:inventory',
		withIpcErrorLogging(
			handlerOpts('inventory'),
			async () => deps.getManaged()?.inventory() ?? null
		)
	);

	// The notice inbox (MRC-11-04): the held notices with their bodies for the
	// person's surface alone, a listing on request, one receipt per act. The
	// client refuses an act on a notice this host never listed; the endpoint
	// authorizes every effect itself. Null or unavailable until MRC-11-05 composes it.
	ipcMain.handle(
		'enterprise:inboxState',
		withIpcErrorLogging(handlerOpts('inboxState'), async (): Promise<ManagedInboxView | null> => {
			const inbox = deps.getInbox();
			return inbox ? inboxView(inbox) : null;
		})
	);

	ipcMain.handle(
		'enterprise:inboxRefresh',
		withIpcErrorLogging(handlerOpts('inboxRefresh'), async () => deps.getInbox()?.refresh() ?? null)
	);

	// Through the one facade (MRC2-07-03): the standing first, the campaign from
	// the held set, the caller's transport gated (a paired device with no
	// registered actor is refused), then the client. The bridge and the CLI
	// answer from the same function.
	ipcMain.handle(
		'enterprise:inboxAct',
		withIpcErrorLogging(
			handlerOpts('inboxAct'),
			async (raw: unknown): Promise<InboxActionOutcome> => {
				const input = validateInboxAct(raw);
				return deps.getManaged()?.inboxAct(input) ?? NO_INBOX_OUTCOME;
			}
		)
	);

	// The command service's read (MRC-11-05): what this desktop executes and refuses
	// by name, the ledger's counts and whether a command could be decided right now.
	// A read only: no channel delivers a command, and no renderer verb ever will.
	ipcMain.handle(
		'enterprise:commandStatus',
		withIpcErrorLogging(
			handlerOpts('commandStatus'),
			async (): Promise<CommandServiceStatus | null> => deps.getCommands()?.status() ?? null
		)
	);

	// A managed run read back from the dispatch ledger by lease id (MCOMP-25-01B):
	// the composer's record after the turn ended, so a stopped, revoked or
	// restart-`unknown` run reads back truthfully instead of being resent.
	ipcMain.handle(
		'enterprise:managedRun',
		withIpcErrorLogging(
			handlerOpts('managedRun'),
			async (raw: unknown): Promise<ManagedRunView | null> =>
				deps.getManaged()?.run(text(raw, 'leaseId', MAX_ID)) ?? null
		)
	);

	// The Mega-Maestro server: the saved address, the save of it and a lookup. Nothing here
	// attaches or registers; approval is the relayed enrollment request.
	ipcMain.handle(
		'enterprise:megaServerGet',
		withIpcErrorLogging(
			handlerOpts('megaServerGet'),
			async () => deps.getMegaServer()?.settings() ?? null
		)
	);

	ipcMain.handle(
		'enterprise:megaServerSave',
		withIpcErrorLogging(handlerOpts('megaServerSave'), async (raw: unknown) => {
			const settings = validateMegaServerSettings(raw);
			const service = deps.getMegaServer();
			if (!service) return { status: 'refused' as const, message: NO_SERVICE_MESSAGE };
			const problem = service.save(settings);
			return problem
				? { status: 'refused' as const, message: problem }
				: { status: 'saved' as const, message: 'Saved.' };
		})
	);

	ipcMain.handle(
		'enterprise:megaServerLookup',
		withIpcErrorLogging(
			handlerOpts('megaServerLookup'),
			async (raw: unknown): Promise<MegaServerLookup | null> => {
				const service = deps.getMegaServer();
				if (!service) return null;
				return service.lookup(
					raw === undefined || raw === null ? undefined : validateMegaServerSettings(raw)
				);
			}
		)
	);

	// Connect to your organization (MSX-02-02). Every input is validated here before the
	// service, which validates it again; a refusal is an answer, not a throw. Nothing here
	// logs the matching number, the request reference, the approval URL or a join code.
	ipcMain.handle(
		'enterprise:connectStart',
		withIpcErrorLogging(
			handlerOpts('connectStart'),
			async (raw: unknown): Promise<ConnectResult<ConnectStatusView>> => {
				const rejected = validateConnectStart(raw);
				if (rejected) {
					if (!rejected.ok) deps.getConnect?.()?.noteRefusal(rejected.refusal);
					return rejected;
				}
				return deps.getConnect?.()?.start(raw) ?? NO_CONNECT_SERVICE;
			}
		)
	);

	ipcMain.handle(
		CONNECT_STATUS_CHANNEL,
		withIpcErrorLogging(
			handlerOpts('connectStatus'),
			async (raw: unknown): Promise<ConnectStatusView> => {
				if (raw !== undefined && raw !== null)
					throw new Error('The connect status takes no argument.');
				return deps.getConnect?.()?.status() ?? NO_CONNECT_STATUS;
			}
		)
	);

	ipcMain.handle(
		'enterprise:connectDisconnect',
		withIpcErrorLogging(
			handlerOpts('connectDisconnect'),
			async (raw: unknown): Promise<ConnectResult<ConnectStatusView>> => {
				if (raw !== undefined && raw !== null) throw new Error('Disconnect takes no argument.');
				return deps.getConnect?.()?.disconnect() ?? NO_CONNECT_SERVICE;
			}
		)
	);

	// Copy diagnostics (MSX-03-04): the redacted bundle as clipboard text. The renderer
	// only writes this string to the clipboard; both redactions ran here first.
	ipcMain.handle(
		'enterprise:connectDiagnostics',
		withIpcErrorLogging(
			handlerOpts('connectDiagnostics'),
			async (raw: unknown): Promise<string> => {
				if (raw !== undefined && raw !== null) throw new Error('Diagnostics take no argument.');
				const redacted = await readConnectDiagnostics(
					deps.getConnect?.() ?? null,
					deps.getMegaServer()?.settings().endpointSocket ?? ''
				);
				return connectDiagnosticsText(redacted);
			}
		)
	);

	// Each status change reaches every renderer once; the service owns the poll loop.
	const connectService = deps.getConnect?.();
	if (connectService && deps.safeSend) {
		const send = deps.safeSend;
		connectService.onChange((view) => send(CONNECT_STATUS_CHANNEL, view));
	}

	ipcMain.handle(
		'enterprise:requestEnrollment',
		withIpcErrorLogging(handlerOpts('requestEnrollment'), async (raw: unknown) => {
			const input = validateEnrollmentRequest(raw);
			return deps.getManaged()?.requestEnrollment(input) ?? NO_SERVICE;
		})
	);

	ipcMain.handle(
		'enterprise:connect',
		withIpcErrorLogging(handlerOpts('connect'), async () => lifecycle()?.connect() ?? NO_SERVICE)
	);

	ipcMain.handle(
		'enterprise:beginRegistration',
		withIpcErrorLogging(
			handlerOpts('beginRegistration'),
			async () => lifecycle()?.beginRegistration() ?? NO_SERVICE
		)
	);

	ipcMain.handle(
		'enterprise:completeRegistration',
		withIpcErrorLogging(
			handlerOpts('completeRegistration'),
			async () => lifecycle()?.completeRegistration() ?? NO_SERVICE
		)
	);

	ipcMain.handle(
		'enterprise:refreshPolicy',
		withIpcErrorLogging(
			handlerOpts('refreshPolicy'),
			async () => deps.getManaged()?.refreshPolicy() ?? NO_SERVICE
		)
	);

	ipcMain.handle(
		'enterprise:recoverPolicy',
		withIpcErrorLogging(
			handlerOpts('recoverPolicy'),
			async () => deps.getPolicyStatus()?.recover() ?? NO_SERVICE
		)
	);

	for (const request of ['requestRotation', 'requestRevocation', 'requestRetirement'] as const) {
		ipcMain.handle(
			`enterprise:${request}`,
			withIpcErrorLogging(handlerOpts(request), async () => lifecycle()?.[request]() ?? NO_SERVICE)
		);
	}

	for (const transition of ['acknowledgeRevocation', 'retire'] as const) {
		ipcMain.handle(
			`enterprise:${transition}`,
			withIpcErrorLogging(handlerOpts(transition), async (raw: unknown) => {
				const input = installationInput(raw);
				const release = localRelease();
				if (!release.allowed) {
					return { status: 'refused', reason: 'management-required', message: release.message };
				}
				return lifecycle()?.[transition](input) ?? NO_SERVICE;
			})
		);
	}

	ipcMain.handle(
		'enterprise:clearIdentity',
		withIpcErrorLogging(
			handlerOpts('clearIdentity'),
			async (raw: unknown): Promise<IdentityClearOutcome> => {
				const identity = deps.getIdentity();
				if (!identity) return { ok: false, reason: 'unprotected', message: NO_SERVICE_MESSAGE };
				const { installationId } = installationInput(raw);
				const acknowledgeUntrusted = (raw as Record<string, unknown>).acknowledgeUntrusted === true;
				const release = localRelease();
				if (!release.allowed) {
					return { ok: false, reason: 'management-required', message: release.message };
				}
				// The lifecycle holds the socket for this record; drop it before the record goes.
				await lifecycle()?.close();
				return identity.clear({ installationId, acknowledgeUntrusted });
			}
		)
	);
}
