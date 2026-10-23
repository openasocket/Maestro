/**
 * Preload API for enterprise enrollment (`window.maestro.enterprise`).
 *
 * Mirrors the `enterprise:*` channels registered in
 * `src/main/ipc/handlers/enterprise.ts`. Desktop-only by construction: the
 * web-desktop bridge's method inventory has no `enterprise` namespace, so a
 * browser holds this object and gets nothing back from it. Everything here
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
		inboxState: (): Promise<ManagedInboxView | null> => ipcRenderer.invoke('enterprise:inboxState'),
		/** List the endpoint's notices again (records `delivered` for the new ones). */
		inboxRefresh: (): Promise<InboxRefresh | null> => ipcRenderer.invoke('enterprise:inboxRefresh'),
		/** Record one receipt (read, acknowledged, or a private reply sent once and kept nowhere). */
		inboxAct: (input: {
			campaignId: string;
			messageId: string;
			action: EndpointInboxAction;
		}): Promise<InboxActionOutcome> => ipcRenderer.invoke('enterprise:inboxAct', input),
		requestEnrollment: (
			input: EnrollmentRequestInput
		): Promise<LifecycleOutcome<EndpointEnrollmentResult>> =>
			ipcRenderer.invoke('enterprise:requestEnrollment', input),
		connect: (): Promise<LifecycleOutcome<EndpointStatus>> =>
			ipcRenderer.invoke('enterprise:connect'),
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
