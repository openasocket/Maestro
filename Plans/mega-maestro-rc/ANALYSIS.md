---
type: source-analysis
title: Maestro 1.1.0-RC Managed Integration Analysis
created: 2026-10-19
status: reviewed-source-planning
source_repository: /Users/dr3/dev-shit/Maestro
source_ref: release/v1.1.0-RC
source_tag: v1.1.0-RC
source_commit: 6400a6da0cfbae97bd90c4b361eea163fc3a1223
comparison_tag: v1.0.0
comparison_commit: aa23ffd516bd4a6403b79563834b0432f5cced70
execution_root: maestro
tags: [mega-maestro, maestro, managed-mode, policy, architecture, source-review]
---

# Maestro 1.1.0-RC integration analysis

This analysis reviews the pinned Maestro source above against the prior stable
`v1.0.0` source. It defines changes for Maestro agents to implement on a new
feature branch based on that RC. It does not claim that managed execution,
enterprise policy enforcement, a qualified Mega-Maestro adapter, or a paired
release already exists.

Related enterprise requirements: [[../mega-maestro/MEGA-MAESTRO-MODULARITY]],
[[../mega-maestro/MEGA-MAESTRO-INTEGRATION]],
[[../mega-maestro/MEGA-MAESTRO-ENFORCEABILITY]], and
[[../mega-maestro/MEGA-MAESTRO-SECURITY]]. These describe desired behavior; the
source evidence below describes the actual RC. Where older design documents
describe Maestro Lib as future work, the pinned RC supersedes that assumption.

## Findings that change the implementation plan

1. A real Electron-free Maestro library now exists. Extend its public boundary
   rather than create a second runtime implementation or depend on private
   renderer state.
2. Shared launch and completion machinery has expanded, but provider API
   transports, PTYs, shell actions and plugin brokers remain distinct execution
   families. A guard on one child-process helper is insufficient.
3. Secret handling is improved in specific places, not replaced by a universal
   credential vault. Server secret references, OS-sealed local state, provider
   credentials and ordinary persisted environment variables have different
   custody and exposure properties.
4. Public library events are useful building blocks, but they are not yet a
   durable enterprise event protocol with authenticated actor context,
   replayable cursors and policy-bound content collection.
5. The enterprise runtime adapter still deliberately returns `unsupported`.
   Maestro implementation completion and paired enterprise qualification must
   be separate, truthful milestones.

## Version and packaging boundaries

| Component            | Pinned source fact                                                                                                              | Consequence                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Maestro application  | `package.json`: `1.1.0-RC`, Node `>=22.0.0`                                                                                     | Record application version and source commit separately from runtime contract versions.                                             |
| Maestro Lib          | `src/shared/maestro-lib/version.ts:17`: `0.3.0`                                                                                 | This pre-1.0 surface can change incompatibly across minor releases; pin the artifact and contract, not just the app name.           |
| Library artifact     | `scripts/build-maestro-lib.mjs`: private `maestro-lib` package, CommonJS entry, declarations, Node `>=20`, app-version metadata | Build a reproducible public artifact and checksum. Do not import arbitrary filesystem paths as trusted integration code.            |
| Plugin host API      | `src/shared/plugins/host-api.ts:60`: `1.25.0`                                                                                   | Negotiate plugin compatibility independently of app/runtime protocol versions.                                                      |
| Plugin SDK package   | `packages/plugin-sdk/package.json`: `@maestro/plugin-sdk` `0.19.0`                                                              | SDK package version differs from host API version. Its vendored contracts and drift tests must remain aligned with host sources.    |
| Mega runtime mapping | `packages/runtime-adapter/src/port.ts:2`: `mega-maestro-runtime-port/0.1`                                                       | This is an enterprise mapping contract, not a released Maestro API. Maestro generic types must not depend on the Mega API/database. |

The library build bundles `src/shared/maestro-lib/index.ts`, emits reachable
declarations, rejects bundled Electron and `src/main` inputs, and loads the
result in plain Node. The main application package has no equivalent public
`exports` field. Use the library public entry, not deep imports into desktop
services, as the intended external integration boundary.

## Library structure and shared execution

The public entry at `src/shared/maestro-lib/index.ts:1` exposes paths and data-dir
ownership, the in-process runtime, a WebSocket client, agent/group/tab commands,
stores and history, launch planning, provider definitions and parsers,
streaming, turn execution and termination. It also exports Auto Run and group
chat engines. These are substantive changes from the stable source and make
headless management a practical integration target.

`src/shared/maestro-lib/runtime/index.ts:71` defines runtime options and returns
a client that owns writes to one data directory. The lock in
`runtime/data-dir-lock.ts:44` distinguishes desktop, TUI and host owners and
checks for existing hosts. Do not start a competing writer to administer an
already-running desktop. Attach through its authenticated boundary or operate
a separately identified runtime. A runtime process epoch is distinct from an
installation identity and must not create duplicate fleet devices.

`src/shared/maestro-lib/client/types.ts:314` currently accepts turn text and
images. Its turn methods at `:382` use agent/tab IDs, and its live event surface
at `:589` and `:633` exposes subscriptions. These methods do not supply the
enterprise operation envelope described in Mega's runtime port. A `started`
or `queued` turn receipt is not a durable execution outcome or a permit to
spawn. Add generic serializable managed-operation contracts, trusted-host
authentication hooks, bounded capability negotiation, logical run/attempt
identity, durable events and explicit unknown/gap outcomes.

The library documentation is partially stale. `docs/maestro-lib.md:19` still
describes a small turn-only library without Auto Run, stored history or remote
facilities, while the public entry now exports runtime, stores, Auto Run,
group-chat and SSH-related facilities. Update documentation against the
pinned source; do not remove working exports merely to match old prose.

## Execution families and enforcement coverage

`src/main/process-manager/ProcessManager.ts:263` routes OpenCode server work
before ordinary process spawners. At `:309` it chooses Codex app-server, PTY or
child-process paths. These are not all governed by one process-start callback.

| Family                              | Source evidence                                                                                                                                     | Required managed behavior                                                                                                                                                                                           |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared child-process turns          | `src/shared/maestro-lib/launch/launch-plan.ts:62`; `run/start-turn.ts:254`; `src/main/process-manager/spawners/ChildProcessSpawner.ts:446`          | Bind authorization to resolved immutable command, arguments, environment references, prompt/resources and policy state before protected dispatch. Recheck on replay and dequeue.                                    |
| Codex app-server                    | `src/main/process-manager/spawners/CodexAppServerSpawner.ts:382`; `src/shared/maestro-lib/codex/server-requests.ts:34`                              | Replace blanket full-access approval with managed decisions. Preserve unsupported outcomes when the provider cannot enforce a restriction. Do not fall back to unrestricted exec after a managed transport refusal. |
| OpenCode server                     | `src/main/opencode-server/OpencodeServerManager.ts:32` uses an auto-approve permission configuration                                                | Provide per-session/request authority and tool enforcement for the shared server. Do not infer a requesting principal from only the server PID or process environment.                                              |
| CLI and library hosts               | `src/cli/services/agent-spawner.ts:1047` and `:1375`; `src/shared/maestro-lib/turns/run-agent-turn.ts:282`                                          | Headless and direct library callers must use equivalent managed checks and receipts. A CLI convenience flag cannot disable managed policy.                                                                          |
| Cue and Auto Run                    | `src/main/cue/cue-spawn-builder.ts:140` selects YOLO/full permissions; `:196` builds the launch plan; library Auto Run exports are at `index.ts:79` | Govern registration and each dispatch, retry, fan-out child and shell/CLI action. Preserve causal workflow/run lineage, budgets and ownership fencing.                                                              |
| Background agents and group chat    | `src/shared/maestro-lib/runtime/background-turns.ts`; public consult/group-chat exports in `index.ts:115`                                           | Propagate authenticated delegation with bounded scope. Hidden/background tabs are not exemptions from collection or execution policy.                                                                               |
| PTY, direct shell and SSH           | ProcessManager spawner routing and public launch/SSH/control exports                                                                                | Qualify each route. Local policy checks alone do not prove remote containment or restrictions on provider-internal shell/network/file access.                                                                       |
| Plugin dispatch, tools and services | `src/shared/plugins/permissions.ts`; `capability-policy.ts`; `services.ts`; main plugin brokers                                                     | Intersect local plugin consent with managed policy at the host broker. Plugin identity and delegation must survive dispatch and service calls.                                                                      |

Codex's `approvalPolicy: 'never'` does not mean enterprise authorization is
implemented. The current app-server answer policy grants every approval when
the invocation is `danger-full-access` and otherwise declines. Likewise,
OpenCode's current auto-approval is behavior-preserving desktop behavior, not
a managed policy engine. Maintain standalone behavior outside managed mode;
inside managed mode, incompatible execution paths must be unavailable rather
than silently less restricted.

Pre-execution hooks are necessary but do not themselves establish OS
confinement. Provider-internal tools, MCP, shell, network egress and remote
execution need a truthful conformance matrix and protected backend proof. A
UI indicator or an event emitted after execution is not an enforcement point.

## Credentials, secrets and environment

| Mechanism                  | Source fact                                                                                                                                                                                             | Integration implication                                                                                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server secret names        | `src/shared/serverSecrets.ts:1` resolves systemd credentials, `/run/secrets`, then environment. An existing unusable file fails rather than falling through.                                            | Reuse named references and bounded lookup. This is not a general vault or automatic migration of every stored provider credential.                                                |
| Per-launch secret delivery | `src/shared/maestro-lib/launch/launch-plan.ts:103` accepts `requiredSecrets`; desktop does not read this channel and local secret values are not sent to SSH remotes.                                   | Define desktop/headless/remote custody explicitly. Do not claim remote secret support merely because a local secret name resolves.                                                |
| OS sealing abstraction     | `src/main/utils/safe-storage-seal.ts:42` wraps Electron safeStorage; `:77` also offers an obscuring fallback with an application-built-in key.                                                          | Use an appropriate custody adapter. The obscuring fallback is not acceptable evidence of protected enterprise credential custody.                                                 |
| OS freshness anchor        | `src/main/utils/keyring-anchor.ts:1` binds an install secret and epoch outside the data-folder tree. Its threat model explicitly notes same-user deletion.                                              | Reuse primitives where appropriate but preserve honest same-user/rollback limitations. A local anchor is not remote attestation or an execution lease.                            |
| Lite device credentials    | `src/main/lite/device-credentials.ts:25` refuses unavailable encryption and Linux `basic_text`; `:65` decrypts only an exact host/origin match, with verified Tailscale node identity where applicable. | Reuse exact-origin custody patterns without treating Lite pairing credentials as enterprise administrator identity.                                                               |
| Custom environment values  | `src/shared/maestro-lib/store/records.ts:110`; `launch/env.ts:441`; `agents/providerSwap.ts:82`                                                                                                         | User/provider/session custom environment records remain ordinary structured data, including parked provider overrides. Masking a value in UI does not encrypt its persisted copy. |

Managed mode therefore needs explicit credential references, non-secret public
status, redaction, safe rotation/revocation and rules for permitted environment
overrides. Do not let caller-supplied JSON, environment variables or renderer
state assert tenant administrator authority or replace a protected management
binding. Do not copy provider login material into inventory, events, migration
archives or diagnostics. Actual values should be resolved at the authorized
execution boundary and retained only for the needed operation.

## New identity and provider-migration behavior

`src/shared/maestro-lib/agents/providerSwap.ts:40` parks provider-specific resume
IDs, settings and usage. `:184` resolves the provider that actually started a
turn so late output is not attributed to the newly selected provider.
`translation/types.ts:3` includes account/project identity; `:19` identifies
native record origins; `:89` tracks checkpoint lineage and hash-bound
resources. Translation can carry instructions, memory, skills, attachments
and transcripts. These are security-relevant content moves, not only display
changes.

Managed policy must authorize provider/model/account changes and the movement
of each resource class. A migration must preserve original and destination
provenance, isolate account roots, hold or reauthorize queued turns, and avoid
double-counting cost or minting new enterprise run IDs for the same work.
Foreign native records must remain evidence rather than become trusted system
instructions. Reuse upstream identity and migration transactions instead of
rebuilding parallel provider switch state.

## Plugin and library API responsibilities

The plugin SDK is dependency-free and vendors host contracts, checked by drift
tests. Host API 1.25.0 includes scoped public progress, authenticated tool caller
identity and resumable agent dispatch. These help preserve actor attribution.
Host-mediated services are currently closed, versioned contracts such as
transcription (`src/shared/plugins/services.ts:1`), not an arbitrary enterprise
RPC tunnel. Reuse capability brokers, trust/consent, namespace confinement and
bounded payloads rather than invent an unscoped plugin transport.

A management panel may use a plugin or existing UI contribution system. It
must remain a client of protected core/runtime services. Removing or disabling
a plugin cannot remove enforced enterprise restrictions; plugins cannot own
the authoritative enrollment state, policy trust root or dispatch permit.

## Telemetry, VIBES and private recording boundaries

No VIBES, VibeTrace or ItsAVibe integration was found in the reviewed Maestro
runtime/shared source or documentation. Mega's VIBES/TRACE capabilities do not
automatically make a Maestro event a valid enterprise artifact.

Implement an explicit versioned event and content projection: collection
policy decides allowed content classes, stable source IDs preserve provenance,
and one canonical runtime source prevents duplicate events across library,
CLI, Cue, endpoint and gateway. Bound uploads, preserve gaps/unknown outcomes,
and spool authorized evidence durably without leaking credentials. VIBES
packaging and verification must retain actual format/version/hash provenance.

The RC contains private recording/export machinery with explicit restrictions
against agent-visible prompts, CLI/web exposure and shared state. It is not a
public enterprise event transport. Do not repurpose it, expose its private
configuration, or put private recording controls into managed agent prompts.
Use separately authorized provider-visible event projections. A provider may
expose summaries or no reasoning at all; do not promise access to unavailable
internal reasoning. Same-OS-user local audit storage is not tamper-proof host
isolation, remote attestation or proof of execution authority.

## Cross-project prerequisites and honest completion

These prerequisites are distinct from Maestro-owned implementation tasks. Do
not mark them satisfied by a schema, a fake adapter, a stale archive, a path
that merely exists, or a neutral harness. Supply bounded handoff artifacts and
leave dependent paired qualification visibly pending until owners complete it.

| ID    | Dependency                                      | Required evidence                                                                                                                                                                                                                                                                                                                   |
| ----- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CP-01 | Fresh enterprise public artifacts               | Source-bound, versioned public contract and server/endpoint/gateway artifacts with checksums, build/source identity, supported capabilities and fixtures. Existing old or dirty archives are not release evidence.                                                                                                                  |
| CP-02 | Real enterprise Maestro adapter                 | `packages/runtime-adapter/src/maestro.ts:3` currently rejects all operations, even with an artifact supplied. The Mega owner must implement and qualify a real adapter against the reviewed Maestro public artifact, with bounded loading and positive/negative/recovery tests.                                                     |
| CP-03 | Delegation and workflow protocol implementation | `packages/runtime-adapter/src/endpoint.ts:34` rejects nonempty delegation or workflow context. Contract fields alone do not provide authenticated delegation, handler support, workflow ownership or fencing. Supply actual producers, receivers and conformance evidence before claiming Cue/group-chat/delegated execution works. |

The Maestro branch should deliver a standalone-compatible managed runtime
boundary, credentials/binding and status, policy/dispatch integration across
qualified families, canonical event projection, CLI/UI parity and reusable
tests/harnesses. Paired qualification must then enroll actual instances,
deliver and verify policy, demonstrate allowed and denied execution, ingest
events/detections, and prove revocation and outage behavior against the real
enterprise services. Unsupported families must remain explicit in status and
release evidence.

## Additional product features for review

These are proposals, not automatic additions to the required integration scope:

- Centrally governed provider migration with resource approval and lineage
  views, building on upstream translation and checkpoint structures.
- First-class headless/TUI fleet hosting and per-component compatibility
  inventory, building on the new runtime and single-writer ownership model.
- Plugin publisher/service inventory with centrally reviewed capability
  grants and service-delegation visibility.
- Policy-bound VIBES import/export and portable investigation packages with
  explicit retention, redaction and provenance.
- Provider/account/model throughput and spend views using normalized upstream
  usage events without double-counting retries or provider switches.

Review these separately. Their presence in this analysis does not authorize
expanding the implementation queue or making unverified product claims.
