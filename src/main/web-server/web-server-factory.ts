import type { ConfirmQueueItem, ReleaseQueueItem } from '../stores/queue-item-receipt';
/**
 * Web server factory for creating and configuring the web server.
 * Extracted from main/index.ts for better modularity.
 */

import { randomUUID } from 'crypto';
import * as path from 'path';
import { app, BrowserWindow, safeStorage } from 'electron';
import {
	createCustodyCredentialSlot,
	credentialCustodyStanding,
	custodyReferenceFor,
	formatCredentialRefusal,
	type CredentialCustodyDecision,
	type CustodyCredentialSlot,
} from '../enterprise/credential-custody';
import { anchorAccountForDirectory, createKeyringAnchor } from '../utils/keyring-anchor';
import { safeStorageSeal } from '../utils/safe-storage-seal';
import { WebServer, type WebServerOptions } from './WebServer';
import { tunnelManager } from '../tunnel-manager';
import { createRemoteHostStatusProvider } from './remote-host-status';
import { logger } from '../utils/logger';
import { isWebContentsAvailable } from '../utils/safe-send';
import {
	bindCrossAgentConsultInitiator,
	withdrawCrossAgentConsult,
} from '../cross-agent/cross-agent-router';
import type { ProcessManager } from '../process-manager';
import type { SettingsStoreInterface as SettingsStore } from '../stores/types';
import type { DebugPackageDependencies } from '../debug-package';
import type { ManagedOperations } from '../enterprise/service';
import type { AgentConfigsStore } from '../agents/agent-config-writes';
import type { CueGraphSession, CueRunResult } from '../../shared/cue/contracts';
import type { CadenzaPayload } from '../../shared/cadenza-types';
import { registerSessionCallbacks } from './callbacks/sessionCallbacks';
import { registerThemeCallbacks } from './callbacks/themeCallbacks';
import { registerNotificationCallbacks } from './callbacks/notificationCallbacks';
import { registerTerminalCallbacks } from './callbacks/terminalCallbacks';
import { registerCommandCallbacks } from './callbacks/commandCallbacks';
import { registerTabCallbacks } from './callbacks/tabCallbacks';
import { registerBrowserTabCallbacks } from './callbacks/browserTabCallbacks';
import { registerQueueCallbacks } from './callbacks/queueCallbacks';
import { registerGistCallbacks } from './callbacks/gistCallbacks';
import { registerContextOpsCallbacks } from './callbacks/contextOpsCallbacks';
import { registerUsageAchievementsCallbacks } from './callbacks/usageAchievementsCallbacks';
import { registerAutoRunConfigCallbacks } from './callbacks/autoRunConfigCallbacks';
import { registerSessionCrudCallbacks } from './callbacks/sessionCrudCallbacks';
import { registerGroupCrudCallbacks } from './callbacks/groupCrudCallbacks';
import { registerWindowCommandCallbacks } from './callbacks/windowCommandCallbacks';
import { registerThroughputGaugeCallbacks } from './callbacks/throughputGaugeCallbacks';
import { registerGitCallbacks } from './callbacks/gitCallbacks';
import { registerGroupChatCallbacks } from './callbacks/groupChatCallbacks';
import { registerDirectorNotesCallbacks } from './callbacks/directorNotesCallbacks';
import { registerAutoRunControlCallbacks } from './callbacks/autoRunControlCallbacks';
import { registerPlaybookCallbacks } from './callbacks/playbookCallbacks';
import { registerCueCallbacks } from './callbacks/cueCallbacks';
import { registerSettingsCallbacks } from './callbacks/settingsCallbacks';
import { registerMarketplaceCallbacks } from './callbacks/marketplaceCallbacks';
import { registerCadenzaMovementCallbacks } from './callbacks/cadenzaMovementCallbacks';

/** UUID v4 format regex for validating stored security tokens.
 *  Enforces version nibble (4) and variant bits ([89ab]). */
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Store interface for sessions */
interface SessionsStore {
	get<T>(key: string, defaultValue?: T): T;
}

/** Store interface for groups */
interface GroupsStore {
	get<T>(key: string, defaultValue?: T): T;
}

/** Dependencies required for creating the web server */
export interface WebServerFactoryDependencies {
	/** Internal persistence readback, never a renderer-supplied approval. */
	confirmQueueItem?: ConfirmQueueItem;
	releaseQueueItem?: ReleaseQueueItem;
	/** Settings store for reading web interface configuration */
	settingsStore: SettingsStore;
	/** Sessions store for reading session data */
	sessionsStore: SessionsStore;
	/** Groups store for reading group data */
	groupsStore: GroupsStore;
	/** Per-provider configuration store; absent = the bridge reports provider writes as unconfigured. */
	agentConfigsStore?: AgentConfigsStore;
	/** Function to get the main window reference */
	getMainWindow: () => BrowserWindow | null;
	/** Resolve the Electron window that currently owns a session. */
	getWindowForSession?: (sessionId: string) => BrowserWindow | null;
	/**
	 * Deliver a cadenza payload to the desktop HUD window - the transparent,
	 * always-on-top overlay that floats cadenza views over other apps (created
	 * lazily, buffered until its renderer subscribes). Returns true if the HUD
	 * handled it; false (or absent) means fall back to the in-app renderer.
	 */
	deliverCadenza?: (payload: CadenzaPayload) => boolean;
	/** Function to get the process manager reference */
	getProcessManager: () => ProcessManager | null;
	/** Direct CUE subscription trigger - bypasses renderer IPC round-trip */
	triggerCueSubscription?: (
		subscriptionName: string,
		prompt?: string,
		sourceAgentId?: string
	) => boolean;
	/** Direct CUE graph-data snapshot - bypasses renderer IPC round-trip.
	 *  Required by `setGetCueSubscriptionsCallback` to answer the CLI's
	 *  `get_cue_subscriptions` message in-process instead of forwarding it
	 *  to the renderer (which never registered a listener, so every CLI
	 *  `cue list` call timed out). */
	getCueGraphData?: () => CueGraphSession[];
	/** Direct toggle for a single subscription's `enabled` flag in YAML.
	 *  `subscriptionId` follows the `${sessionId}::${pipeline}::${name}` shape
	 *  emitted by `getCueGraphData` flattening (via `composeCueSubscriptionId`)
	 *  - same dead-bridge fix as `getCueGraphData`. Returns `false` when the
	 *  id can't be resolved, the YAML can't be parsed, or the named
	 *  subscription isn't present. Async because the engine serialises
	 *  per-`projectRoot` writes via a promise chain to keep concurrent
	 *  toggles from clobbering each other. */
	setCueSubscriptionEnabled?: (subscriptionId: string, enabled: boolean) => Promise<boolean>;
	/** Direct CUE activity-log snapshot - bypasses renderer IPC round-trip.
	 *  Used by `setGetCueActivityCallback` (web UI's activity dashboard).
	 *  Same dead-bridge fix as `getCueGraphData`. */
	getCueActivityLog?: () => CueRunResult[];
	/** Collectors for a support package (`maestro-cli support-package`,
	 *  `feedback submit --support-package`). Absent = the CLI reports the
	 *  feature as unconfigured instead of shipping a hollow zip. */
	getDebugPackageDeps?: () => DebugPackageDependencies;
	/** The managed operation facade (`EnterpriseService.managed`) the `managed_*`
	 *  bridge messages answer from (MRC2-07-03). Absent or null = the CLI is told
	 *  no enrollment service runs in this desktop. */
	getManaged?: () => ManagedOperations | null;
}

// ============================================================================
// The persistent web link token (MCOMP-21-05)
// ============================================================================

/** The file the sealed token lives in, in the data folder and never in the synced settings. */
export const WEB_AUTH_TOKEN_FILE = 'maestro-web-link.json';
const WEB_AUTH_TOKEN_ANCHOR_SERVICE = 'com.maestro.web-auth-token';
/** What the `webAuthToken` setting holds under management: a marker, never the token. */
export const WEB_AUTH_TOKEN_REFERENCE = custodyReferenceFor('web.authToken');

let webAuthTokenSlot: CustodyCredentialSlot | null = null;

/** Replace the token's custody slot (tests). Null rebuilds the production slot on next use. */
export function setWebAuthTokenSlot(slot: CustodyCredentialSlot | null): void {
	webAuthTokenSlot = slot;
}

function getWebAuthTokenSlot(): CustodyCredentialSlot {
	if (!webAuthTokenSlot) {
		const dir = app.getPath('userData');
		webAuthTokenSlot = createCustodyCredentialSlot({
			credential: 'web.authToken',
			file: path.join(dir, WEB_AUTH_TOKEN_FILE),
			seal: safeStorageSeal(safeStorage),
			anchor: createKeyringAnchor(
				WEB_AUTH_TOKEN_ANCHOR_SERVICE,
				anchorAccountForDirectory('web-auth-token', dir)
			),
		});
	}
	return webAuthTokenSlot;
}

function writeSlot(slot: CustodyCredentialSlot, token: string): CredentialCustodyDecision {
	try {
		return slot.write(token);
	} catch {
		return {
			allowed: false,
			code: 'unprotected',
			message: 'the persistent web link token could not be sealed under the OS key store.',
		};
	}
}

/**
 * The token a persistent web link starts with. Standalone it is the plain
 * `webAuthToken` setting, as it always was. Under management the setting holds
 * only the slot's opaque reference and the token lives sealed for the current
 * installation; a plaintext token left in settings is migrated into custody
 * (or, when custody refuses, rotated) and never kept. A token that does not
 * open for this owner (another installation, an enrollment that is gone, an
 * older copy) is rotated. No token value is ever logged.
 */
export function resolvePersistentWebAuthToken(settingsStore: SettingsStore): string {
	const stored = settingsStore.get<string | null>('webAuthToken', null);
	const plain = stored && UUID_V4_REGEX.test(stored) ? stored : null;
	if (credentialCustodyStanding() === 'standalone') {
		if (plain) return plain;
		// A reference left by an enrollment that is gone opens nothing here: drop its sealed copy.
		if (stored === WEB_AUTH_TOKEN_REFERENCE) getWebAuthTokenSlot().clear();
		else if (stored) {
			logger.warn(
				'Stored webAuthToken is not a valid UUID, generating new token',
				'WebServerFactory'
			);
		}
		const fresh = randomUUID();
		try {
			settingsStore.set('webAuthToken', fresh);
		} catch {
			// Persist failure is non-fatal - server starts with an ephemeral token
			logger.warn(
				'Failed to persist new webAuthToken, URL will not survive restart',
				'WebServerFactory'
			);
		}
		return fresh;
	}
	const slot = getWebAuthTokenSlot();
	if (stored === slot.reference) {
		const kept = slot.read();
		if (kept) return kept;
	}
	// Migrate a plaintext token, or rotate one that no longer opens for this owner.
	const token = plain ?? randomUUID();
	const decision = writeSlot(slot, token);
	try {
		settingsStore.set('webAuthToken', decision.allowed ? slot.reference : null);
	} catch {
		logger.warn('Failed to replace the stored web link token', 'WebServerFactory');
	}
	if (decision.allowed) return token;
	slot.clear();
	logger.warn(
		`${formatCredentialRefusal(decision)} The web link changes at every start.`,
		'WebServerFactory'
	);
	// A plaintext token custody refused is not reused: the link rotates.
	return randomUUID();
}

/**
 * Keep `token` as the persistent web link token and turn the link on. Under
 * management it is sealed first and refused by name when custody refuses;
 * nothing is written then. Throws on a settings write failure (the caller rolls back).
 */
export function persistWebAuthToken(
	settingsStore: SettingsStore,
	token: string
): { ok: true } | { ok: false; message: string } {
	if (credentialCustodyStanding() === 'standalone') {
		settingsStore.set('persistentWebLink', true);
		settingsStore.set('webAuthToken', token);
		return { ok: true };
	}
	const slot = getWebAuthTokenSlot();
	const decision = writeSlot(slot, token);
	if (!decision.allowed) return { ok: false, message: formatCredentialRefusal(decision) };
	settingsStore.set('persistentWebLink', true);
	settingsStore.set('webAuthToken', slot.reference);
	return { ok: true };
}

/** Turn the persistent web link off and forget its token, in settings and in custody. */
export function clearPersistedWebAuthToken(settingsStore: SettingsStore): void {
	const stored = settingsStore.get<string | null>('webAuthToken', null);
	settingsStore.set('persistentWebLink', false);
	settingsStore.set('webAuthToken', null);
	if (credentialCustodyStanding() !== 'standalone' || stored === WEB_AUTH_TOKEN_REFERENCE) {
		getWebAuthTokenSlot().clear();
	}
}

/**
 * Creates a factory function for creating web servers with the given dependencies.
 * This allows dependency injection and makes the code more testable.
 */
export function createWebServerFactory(deps: WebServerFactoryDependencies) {
	const { settingsStore } = deps;

	/**
	 * Create and configure the web server with all necessary callbacks.
	 * Pass `lanAccess` only for Live Mode; the default is the loopback-only
	 * server that backs maestro-cli.
	 */
	return function createWebServer(options: WebServerOptions = {}): WebServer {
		// Use custom port if enabled, otherwise 0 for random port assignment
		const useCustomPort = settingsStore.get('webInterfaceUseCustomPort', false);
		const customPort = settingsStore.get('webInterfaceCustomPort', 8080);
		const port = useCustomPort ? customPort : 0;

		// Determine security token: persistent or ephemeral
		const persistentWebLink = settingsStore.get('persistentWebLink', false);
		const securityToken = persistentWebLink
			? resolvePersistentWebAuthToken(settingsStore)
			: undefined;

		const server = new WebServer(port, securityToken, options);

		// The Remote Control tunnel serves the web interface from a public
		// trycloudflare.com origin; accept it alongside the request's own host.
		server.setTrustedOriginsProvider(() => {
			const { url } = tunnelManager.getStatus();
			return url ? [url] : [];
		});
		server.setRemoteHostStatusProvider(createRemoteHostStatusProvider(deps), deps.getMainWindow);

		// Roaming to a different network changes the LAN IP the URL and QR code
		// are built from. A LAN server keeps serving (it binds 0.0.0.0), so all
		// that is needed is telling every window to redraw the new address -
		// no restart, no token rotation, and any phone already connected over
		// the old address just reconnects. Broadcast rather than main-window
		// only: each window draws its own Left Bar with its own LIVE panel.
		server.setOnLocalAddressChanged((url) => {
			logger.info(`Local network address changed, new web URL: ${url}`, 'WebServerFactory');
			for (const win of BrowserWindow.getAllWindows()) {
				if (isWebContentsAvailable(win)) {
					win.webContents.send('live:urlChanged', { url });
				}
			}
		});

		// A forwarded caller credential (`maestro-cli ask` run from inside a chat turn)
		// authenticates only through the process manager that minted it (MCOMP-17-03AR).
		// Re-read the manager on every ask: with none (startup, shutdown) the credential
		// authenticates nobody, and the ask refuses before anything is dispatched.
		server.setCallerSourceResolver(
			(credential) => deps.getProcessManager()?.callerSourceOf(credential) ?? null
		);

		// A forwarded Auto Run attempt credential authenticates the same way, through the
		// manager's Auto Run lookup only (MCOMP-17-03BD). The handler tries it after the chat
		// resolver, so neither kind of credential ever resolves as the other.
		server.setAutoRunCallerSourceResolver(
			(credential) => deps.getProcessManager()?.autoRunCallerSourceOf(credential) ?? null
		);

		// A forwarded room participant credential authenticates through the manager's group chat
		// lookup only (MCOMP-17-03BP). It answers the room, the participant name and the process,
		// never an agent: the handler maps the name to a live agent, after the chat and Auto Run
		// resolvers, so no kind of credential ever resolves as another.
		server.setGroupChatCallerSourceResolver(
			(credential) => deps.getProcessManager()?.groupChatCallerSourceOf(credential) ?? null
		);

		// An Auto Run attempt's ask carries the lineage the attempt was admitted on (MCOMP-17-03BI).
		// The handler offers the attempt credential and the ask ticket it just issued; the manager
		// answers that lineage only while it still holds the credential, and the router binds it to
		// the ticket so the consult it starts records the asking run as its initiator. Anything
		// short of a binding (no manager, no lineage, a ticket already bound or withdrawn) answers
		// false, and the handler refuses the ask instead of admitting it unbound.
		server.setAutoRunConsultLineageBinder((credential, ticket) => {
			const lineage = deps.getProcessManager()?.autoRunCallerLineageOf(credential) ?? null;
			return lineage !== null && bindCrossAgentConsultInitiator(ticket, lineage);
		});

		// A room participant's ask carries the room lineage its turn was admitted on (MCOMP-17-03BT).
		// The same rule as the Auto Run binder, through the manager's group chat lineage lookup
		// only: the manager answers the verified room child while it still holds the participant
		// credential, the router binds it to the ticket, and anything short of a binding answers
		// false so the handler refuses the ask instead of admitting it unbound.
		server.setGroupChatConsultLineageBinder((credential, ticket) => {
			const lineage = deps.getProcessManager()?.groupChatCallerLineageOf(credential) ?? null;
			return lineage !== null && bindCrossAgentConsultInitiator(ticket, lineage);
		});

		// When that caller loses custody mid-consult, the ask handler withdraws the ask and hands
		// over the dispatch ticket it issued (MCOMP-17-03AW). The router cancels the consult the
		// ticket started and tombstones the ticket, so a later arrival on it is refused as canceled.
		server.setCallerConsultWithdrawer((ticket) => {
			withdrawCrossAgentConsult(ticket);
		});

		registerSessionCallbacks(server, deps);
		registerThemeCallbacks(server, deps);

		registerTerminalCallbacks(server, deps);
		registerCommandCallbacks(server, deps);
		registerTabCallbacks(server, deps);
		registerNotificationCallbacks(server, deps);

		registerCadenzaMovementCallbacks(server, deps);

		registerBrowserTabCallbacks(server, deps);

		registerQueueCallbacks(server, deps);

		registerAutoRunConfigCallbacks(server, deps);

		registerSettingsCallbacks(server, deps);

		registerSessionCrudCallbacks(server, deps);
		registerGroupCrudCallbacks(server, deps);
		registerWindowCommandCallbacks(server, deps);
		registerThroughputGaugeCallbacks(server, deps);

		registerGitCallbacks(server, deps);

		registerAutoRunControlCallbacks(server, deps);
		registerPlaybookCallbacks(server, deps);

		registerGroupChatCallbacks(server, deps);

		registerContextOpsCallbacks(server, deps);
		registerGistCallbacks(server, deps);

		registerCueCallbacks(server, deps);

		registerUsageAchievementsCallbacks(server, deps);

		registerDirectorNotesCallbacks(server, deps);

		registerMarketplaceCallbacks(server, deps);

		if (deps.getDebugPackageDeps) {
			server.setGetDebugPackageDepsCallback(deps.getDebugPackageDeps);
		}
		if (deps.getManaged) {
			server.setGetManagedCallback(deps.getManaged);
		}

		return server;
	};
}
