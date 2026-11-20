/**
 * Preload API for enterprise enrollment (`window.maestro.enterprise`).
 *
 * Mirrors the `enterprise:*` channels registered in
 * `src/main/ipc/handlers/enterprise.ts`. Over the web-desktop bridge a browser
 * reaches the managed state, the inventory and the inbox alone (MRC2-07-03);
 * every other verb here is refused by the bridge's inventory. Everything here
 * answers a public projection or a lifecycle outcome; the only secret-shaped
 * answer is the registration approval, a one-time pairing code the actor
 * reads once and types into the console.
 */

import { ipcRenderer } from 'electron';

import type {
	EndpointEnrollmentResult,
	EndpointStatus,
	ManagedEnrollmentStatus,
	ManagedIdentityManagement,
} from '../../shared/maestro-lib/managed/endpoint-port';
import type {
	EndpointInboxAction,
	ManagedPolicyStatus,
} from '../../shared/maestro-lib/managed/host-adapter';
import type { CommandServiceStatus } from '../enterprise/commands';
import type { ConnectResult, ConnectStatusView } from '../enterprise/connect';
import type { MegaServerLookup, MegaServerSettings } from '../../shared/megaServer';
import {
	MEGA_CONNECT_PREFILL_CHANNEL,
	type MegaConnectPrefill,
} from '../../shared/megaConnect/deepLink';
import type { ManagedRunView } from '../enterprise/dispatch';
import type {
	EnrollmentRequestInput,
	LifecycleOutcome,
	RegistrationApprovalHandoff,
} from '../enterprise/enrollment';
import type { IdentityClearOutcome, IdentityCustodyState } from '../enterprise/identity-store';
import type { InboxActionOutcome, InboxRefresh, ManagedInboxView } from '../enterprise/inbox';
import type { InstallationInventory } from '../enterprise/inventory';
import type { ManagedStateView } from '../enterprise/managed-state';
import type { PolicyRecovery } from '../enterprise/policy-status';

/**
 * A start input as the renderer sends it; main shape-checks every field again
 * (`megaConnect/input.ts`), so a renderer check is only a hint.
 */
export type ConnectStartRequest =
	| { kind: 'email'; email: string }
	| { kind: 'joinLink'; joinLink: string }
	| { kind: 'teamCode'; teamCode: string; server: string }
	| { kind: 'managed' };

/** Connect to your organization (MSX-02-02): `window.maestro.enterprise.connect`. */
function createConnectApi() {
	return {
		/** Validate, open a connect request, and open its approval page; a refusal is an answer. */
		start: (input: ConnectStartRequest): Promise<ConnectResult<ConnectStatusView>> =>
			ipcRenderer.invoke('enterprise:connectStart', input),
		/** Ask the endpoint now; `unavailable` until a connect port is bound. */
		status: (): Promise<ConnectStatusView> => ipcRenderer.invoke('enterprise:connectStatus'),
		/** Revoke this OS account's grant on this installation. */
		disconnect: (): Promise<ConnectResult<ConnectStatusView>> =>
			ipcRenderer.invoke('enterprise:connectDisconnect'),
		/** Hear every status change main observes; returns the unsubscribe function. */
		onStatus: (callback: (view: ConnectStatusView) => void): (() => void) => {
			const handler = (_event: unknown, view: ConnectStatusView) => callback(view);
			ipcRenderer.on('enterprise:connectStatus', handler);
			return () => {
				ipcRenderer.removeListener('enterprise:connectStatus', handler);
			};
		},
		/**
		 * Hear a join or connect deep link (MSX-01-06). It only fills the form;
		 * nothing connects until the person presses Connect (invariant SX3).
		 */
		onPrefill: (callback: (prefill: MegaConnectPrefill) => void): (() => void) => {
			const handler = (_event: unknown, prefill: MegaConnectPrefill) => callback(prefill);
			ipcRenderer.on(MEGA_CONNECT_PREFILL_CHANNEL, handler);
			return () => {
				ipcRenderer.removeListener(MEGA_CONNECT_PREFILL_CHANNEL, handler);
			};
		},
	};
}

export function createEnterpriseApi() {
	return {
		/** Null when the desktop runs no enrollment service. */
		status: (): Promise<ManagedEnrollmentStatus | null> => ipcRenderer.invoke('enterprise:status'),
		custody: (): Promise<IdentityCustodyState | null> => ipcRenderer.invoke('enterprise:custody'),
		policyStatus: (): Promise<ManagedPolicyStatus | null> =>
			ipcRenderer.invoke('enterprise:policyStatus'),
		/** What this installation is and can do (MRC-10-06B): versions, standing, routes, collection health, named gaps. */
		inventory: (): Promise<InstallationInventory | null> =>
			ipcRenderer.invoke('enterprise:inventory'),
		/** The one-word standing with the facts beside it (MRC-11-03); null without a service. */
		managedState: (): Promise<ManagedStateView | null> =>
			ipcRenderer.invoke('enterprise:managedState'),
		/** The held notices, bodies included, for the person's surface (MRC-11-04); null until the client is composed. */
		/** The command service's read (MRC-11-05): capabilities, refusals by name, counts, standing. Nothing delivers a command from here. */
		commandStatus: (): Promise<CommandServiceStatus | null> =>
			ipcRenderer.invoke('enterprise:commandStatus'),
		inboxState: (): Promise<ManagedInboxView | null> => ipcRenderer.invoke('enterprise:inboxState'),
		/** List the endpoint's notices again (records `delivered` for the new ones). */
		inboxRefresh: (): Promise<InboxRefresh | null> => ipcRenderer.invoke('enterprise:inboxRefresh'),
		/** Record one receipt (read, acknowledged, or a private reply sent once and kept nowhere). */
		inboxAct: (input: {
			campaignId: string;
			messageId: string;
			action: EndpointInboxAction;
		}): Promise<InboxActionOutcome> => ipcRenderer.invoke('enterprise:inboxAct', input),
		/** A managed run read back from the dispatch ledger by lease id; null when this host never admitted it. */
		managedRun: (leaseId: string): Promise<ManagedRunView | null> =>
			ipcRenderer.invoke('enterprise:managedRun', leaseId),
		/** The saved Mega-Maestro server address (null when no service runs). */
		megaServerGet: (): Promise<MegaServerSettings | null> =>
			ipcRenderer.invoke('enterprise:megaServerGet'),
		megaServerSave: (
			settings: MegaServerSettings
		): Promise<{ status: 'saved' | 'refused'; message: string }> =>
			ipcRenderer.invoke('enterprise:megaServerSave', settings),
		megaServerLookup: (settings?: MegaServerSettings): Promise<MegaServerLookup | null> =>
			ipcRenderer.invoke('enterprise:megaServerLookup', settings ?? null),
		requestEnrollment: (
			input: EnrollmentRequestInput
		): Promise<LifecycleOutcome<EndpointEnrollmentResult>> =>
			ipcRenderer.invoke('enterprise:requestEnrollment', input),
		/** Re-attach the enrolled installation to its endpoint (the lifecycle verb). */
		connectEndpoint: (): Promise<LifecycleOutcome<EndpointStatus>> =>
			ipcRenderer.invoke('enterprise:connect'),
		/** Connect to your organization: start, status, disconnect and the status subscription. */
		connect: createConnectApi(),
		/** The approval handoff is shown once; nothing keeps it. */
		beginRegistration: (): Promise<LifecycleOutcome<RegistrationApprovalHandoff>> =>
			ipcRenderer.invoke('enterprise:beginRegistration'),
		completeRegistration: (): Promise<LifecycleOutcome<EndpointStatus>> =>
			ipcRenderer.invoke('enterprise:completeRegistration'),
		refreshPolicy: (): Promise<LifecycleOutcome<EndpointStatus>> =>
			ipcRenderer.invoke('enterprise:refreshPolicy'),
		recoverPolicy: (): Promise<PolicyRecovery> => ipcRenderer.invoke('enterprise:recoverPolicy'),
		requestRotation: (): Promise<LifecycleOutcome<never>> =>
			ipcRenderer.invoke('enterprise:requestRotation'),
		requestRevocation: (): Promise<LifecycleOutcome<never>> =>
			ipcRenderer.invoke('enterprise:requestRevocation'),
		requestRetirement: (): Promise<LifecycleOutcome<never>> =>
			ipcRenderer.invoke('enterprise:requestRetirement'),
		acknowledgeRevocation: (input: {
			installationId: string;
		}): Promise<LifecycleOutcome<ManagedIdentityManagement>> =>
			ipcRenderer.invoke('enterprise:acknowledgeRevocation', input),
		retire: (input: {
			installationId: string;
		}): Promise<LifecycleOutcome<ManagedIdentityManagement>> =>
			ipcRenderer.invoke('enterprise:retire', input),
		clearIdentity: (input: {
			installationId: string;
			acknowledgeUntrusted?: boolean;
		}): Promise<IdentityClearOutcome> => ipcRenderer.invoke('enterprise:clearIdentity', input),
	};
}

export type EnterpriseApi = ReturnType<typeof createEnterpriseApi>;
