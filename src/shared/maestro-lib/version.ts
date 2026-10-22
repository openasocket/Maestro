// src/shared/maestro-lib/version.ts

import { MANAGED_CONTRACT_VERSION } from './managed/types';

/**
 * The version of maestro-lib's public surface (`index.ts`), for a tool that
 * builds on the library and has to pin what it was written against.
 *
 * Semver over the entry module alone, independent of the app's own version:
 * the app can ship many releases with no change to this surface, and a change
 * to the surface is not an app release. Bump it in the same change that edits
 * what `index.ts` exports or how an exported function behaves: the patch for a
 * fix, the minor for an addition, the major for a removal or a breaking
 * change. Below 1.0 the surface is still being proven, so a minor may break.
 *
 * `npm run build:maestro-lib` writes it into the built package's
 * `package.json`, next to the app version the build was cut from.
 *
 * 0.4.0: the managed-operation contracts (`./managed/types`) and this
 * version descriptor.
 * 0.5.0: the Auto Run lineage (`./autorun/attribution`) a managed host
 * admits each turn on.
 * 0.6.0: the delegated-dispatch context (`./managed/delegation`) one
 * operation hands a child it dispatches or consults.
 * 0.7.0: the room lineage a group chat turn is admitted under
 * (`./groupchat/spawn`: `groupChatRoomContext`, `groupChatTurnContext`).
 * 0.8.0: durable workflow ownership (`./managed/workflows`): the owner fence
 * a host claims from the workflow owner producer and holds across retries.
 * 0.9.0: the ownership wired on the headless hosts: `ManagedHostAdapter.workflows`
 * (the producer port over the adapter's endpoint), `MaestroRuntime.claimWorkflowFence`
 * (the runtime's own ownership, what every Auto Run attempt is admitted on), and
 * `managed.workflowFence` taking the attempt's run and attempt ids.
 * 0.10.0: `ManagedPeerAuthentication` gains `device-pairing` (a device the
 * host paired, Maestro Lite), so a host verifier can record that transport
 * on a verification instead of passing a paired device off as a web login.
 */
export const MAESTRO_LIB_VERSION = '0.10.0';

/** The Node range the built library runs on; `engines.node` of the built package. */
export const MAESTRO_LIB_NODE_RANGE = '>=20';

/**
 * Every version a consumer may have to pin, each independent of the others:
 * the library surface, the managed-operation contract it speaks, and the Node
 * it needs. The app version the build was cut from is not here on purpose: it
 * is the build's to stamp (`maestroAppVersion` in the built `package.json`),
 * and the plugin SDK, plugin host API and any enterprise protocol are
 * versioned by their own packages.
 */
export interface MaestroLibVersionInfo {
	readonly library: string;
	readonly managedContract: string;
	readonly node: string;
}

export const MAESTRO_LIB_VERSION_INFO: MaestroLibVersionInfo = Object.freeze({
	library: MAESTRO_LIB_VERSION,
	managedContract: MANAGED_CONTRACT_VERSION,
	node: MAESTRO_LIB_NODE_RANGE,
});
