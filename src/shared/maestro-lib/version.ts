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
 * 0.11.0: the remote endpoint identity (`./launch/ssh-remote-resolver`):
 * `SshRemoteEndpointIdentity`, `sshRemoteEndpointProblems`,
 * `qualifySshLaunchTarget` (`endpoint` on a remote target, `remote-unqualified`
 * among the unresolved reasons) and `wrapManagedSpawnWithSsh`.
 * 0.12.0: a host attests its managed standing (`HostStatusReport.managed`,
 * produced by `hostManagedStanding` in `./runtime/server`): what a peer's
 * remote endpoint probe reads over SSH. `RuntimeHostOptions.managed` hands a
 * composed host adapter to `startRuntimeHost`.
 * 0.13.0: a managed dispatch target on an SSH remote names the endpoint it
 * was qualified against (`ManagedSshEndpointRef`, `endpoint` on the `ssh`
 * variant of `ManagedDispatchTarget`; `managedSshEndpointRef` reads it off an
 * attested `SshRemoteEndpointIdentity`), so a lease says which remote
 * installation and authority a launch goes to.
 * 0.14.0: a host that attests no standing can say why (`HostStatusReport.managedUnavailable`,
 * produced by `hostManagedUnavailable` in `./runtime/server` from the host adapter's own
 * custody view or the host process's reason for composing none; `describe().managedUnavailable`
 * on `startRuntimeServer`).
 * 0.15.0: managed operations over the bridge (`managed_operation`, MRC-08-05): a detached host
 * answers `ManagedApi` in its own scope (`runtimeManagedScope` in `./runtime/server-requests`),
 * `createWsMaestroClient().managed` drives it, and `ManagedApi.scope` reads that scope (`ManagedScope`).
 * 0.16.0: the facade records the transport that admitted an operation (MRC-08-05A):
 * `ManagedOperationEnvelope.peer` is stamped by the host's own handler (`host-secret` over the
 * bridge, nothing in process) and refused from a caller; `ManagedOperationsDeps.verifiers` holds
 * one verifier per transport, so a verification record names the transport, never a default.
 * 0.17.0: the lifecycle metadata projection (`./managed/events`, MRC-10-01): `createLifecycleProjector`
 * turns the facts the real lifecycle producers report (the desktop's agent-run capture, the runtime's
 * turn recorder) into metadata-only `ManagedLifecycleEvent`s with digest-stable ids, a per-process
 * sequence and a counted bounded window; `RuntimeTurnOptions.lifecycle` hands a sink to the runtime.
 * 0.18.0: the durable event journal (`./managed/event-journal`, MRC-10-02): `createEventJournal` keeps
 * the projected events under one sequence that survives a restart, dedups by event id, hands batches
 * to a telemetry client and marks `received` only from an endpoint receipt, answers cursor pages with
 * `completeness`, and records every gap; `ManagedEventsQuery` names what `managed.events` is asked.
 * 0.19.0: the telemetry seam on the host adapter (MRC-10-03): `ManagedHostAdapter.telemetry` (the
 * endpoint's `telemetry` operation over the adapter's socket, `endpointTelemetryPort`), the wire
 * shape `EndpointTelemetryEvent`, and `telemetryStanding()` (whether a report may go now, the
 * `TelemetryBinding` it carries, and the `standingKey` a hold is released on); `EventJournal.take`
 * takes a `skip` so an entry the transport cannot carry is left in place, not counted as an attempt.
 * 0.20.0: usage provenance (`./streaming/usage-accumulator`, MRC-10-04): `UsageProvenanceTracker` watches
 * the parsed reports before a total fills their gaps, `describeUsageProvenance` says what a total is made of
 * (the contract word, where the tokens and the cost came from, the rate table revision `usagePriceRevision`,
 * the reporting style, the cache convention, a null for a count the stream never carried); and the usage
 * half of the projection (`./managed/events`, MRC-10-04A): `UsageFact`, `usageFactProblems`,
 * `LifecycleProjector.recordUsage` raising a `usage` event under the shared sequence.
 * 0.21.0: the inventory half of the projection (`./managed/events`, MRC-10-06): `InventoryFact` (the
 * device, the runtimes and their components in the endpoint's attachment vocabulary, each provider's
 * detected installation beside its route enforcement, subagents as an observation or `unavailable`,
 * the applied revision, completeness and named gaps), `inventoryFactProblems`, and
 * `LifecycleProjector.recordInventory` raising an `inventory` event whose id digests the inventory,
 * so an unchanged inventory is one event and a change is the delta; the `host` lifecycle surface.
 * 0.22.0: typed runtime commands (`./managed/commands`, MRC-11-01): the endpoint's six typed actions
 * as `ManagedRuntimeCommand` with `managedCommandProblems`, the binding of a command to this run,
 * process epoch, actor, policy revision and approval (`commandBindingProblem`), the durable command
 * ledger (`createCommandLedger`, one record per command id, nonce and idempotency key enrollment-wide,
 * an accepted record a restart turns unknown) and `createCommandExecutor` over injected ports, keeping
 * accepted, completed, no-effect, failed, denied and unknown distinct in the published settlement words.
 * 0.23.0: the ledger and the executor that note names, delivered (MRC-11-01A); 0.22.0 shipped the
 * contract half alone (the vocabulary, `managedCommandProblems`, `commandBindingProblem`, the settlement words).
 * 0.24.0: the inbox port (`./managed/host-adapter`, MRC-11-02): the endpoint's `noticeList` and `inbox`
 * operations (`EndpointNotice`, `EndpointInboxRequest`, `EndpointInboxReceipt`, `InboxPort`) as
 * `ManagedHostAdapter.inbox` / `endpointInboxPort`, and `inboxStanding()` (this process's registration, its actor, the capabilities).
 * 0.25.0: launch classification on the dispatch snapshot (`./managed/authority`, MRC2-02-01): `DispatchPurpose`
 * (`conversation`, `utility`, `probe`, `supervisor`) and the contract's `ManagedOrigin` as optional `purpose` and
 * `origin` on `DispatchSnapshot`, set from `DispatchAttribution` and left out of the digest when a surface does not
 * classify, so a policy can tell a person's turn from Maestro's own; attribution, never a permission level.
 * 0.26.0: probe turns (`./managed/host-adapter`, MRC2-02-04): `admitProbeTurn` asks the host's authority for a
 * lease on the snapshot of a probe's final spec (`purpose: probe`, `operation: start`) and hands back the
 * `startTurn` admission over `leaseAdmission`; `probeRouteRefusal` holds a probe to its route's managed standing
 * before the authority is asked; `probeTurnIdentity` is a probe's own run identity; `createProbeRefusalCache`
 * remembers a refusal per authority, policy revision, provider, route and scope for `PROBE_REFUSAL_TTL_MS`.
 * 0.27.0: supervisor children (`./managed/host-adapter`, MRC2-02-05): `admitSupervisorChild` binds a host's
 * own background service on the delegation chain (`supervisorServicePrincipal`, `supervisorChildProvider`)
 * through the port's `verify` and asks the authority for a lease on the snapshot of the exact spawn
 * (`purpose: supervisor`, `operation: start`), handing back a `SupervisedChildLifetime` the supervisor
 * drives around the raw child it spawns itself (admit, spawned, onRevoked, exited, withdraw); a refusal is
 * a `ManagedAdmissionRefusal` (the shape `ProbeTurnRefusal` now aliases); `ownRunIdentity` is the identity
 * of a launch that is its own request (`probeTurnIdentity` calls it).
 * 0.28.0: the permission-mode ceiling (`./launch/env`, MRC2-03-01): `ManagedRouteCeiling.permissionMode`
 * (the widest `LaunchPermissionMode` a launch may ask for, or null), `permissionModeWithinCeiling`,
 * `managedPermissionModeProblem`, the full-access vocabulary (`KNOWN_FULL_ACCESS_FLAGS`,
 * `permissionVocabularyOf`, `fullAccessFlagsOf`) and `managedArgsProblems` refusing a flag that asks for
 * a wider mode than the pin, or a read-only pin the provider's command line cannot enforce or does not
 * carry; `buildAgentArgs` (`./launch/agent-args`) takes `managedCeiling` and throws
 * `ManagedPermissionModeError` instead of a weaker command line; `KNOWN_YOLO_FLAGS` is exported.
 */
export const MAESTRO_LIB_VERSION = '0.28.0';

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
