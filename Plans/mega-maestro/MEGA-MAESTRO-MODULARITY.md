---
type: architecture-decision
title: Maestro Lib UX CLI Cue Integration
created: 2026-09-18
status: proposed
tags: [mega-maestro, maestro-lib, maestro-ux, maestro-cli, maestro-cue]
---

# Future Maestro component integration

Execution amendment: [[MEGA-MAESTRO-ENFORCEABILITY]] defines early real-provider/backend proof, protected management binding, outage semantics and explicit dependency gates. Read it with [[MEGA-MAESTRO-INTEGRATION]] before implementing this design.

Related: [[MEGA-MAESTRO-DESIGN]], [[MEGA-MAESTRO-SECURITY]], [[MEGA-MAESTRO-DELIVERY]].

## Decision and evidence

The planned Maestro components are Maestro Lib, Maestro UX, Maestro CLI and Maestro Cue. Only these names and their future direction are confirmed. Responsibilities below are proposed boundaries, not an assertion that extracted packages or public APIs already exist. Package names, release dates and final repository placement remain the responsibility of the Maestro modularization work.

Current evidence: ProcessManager and process-listeners expose runtime operations and events; src/cli/services/agent-spawner.ts has separate spawning; src/main/cue/cue-spawn-builder.ts builds spawn specifications; Cue also supports shell and CLI executors. The current Cue spawn builder explicitly requests yoloMode. Existing Electron IPC, renderer stores and files are internal implementation details, not a stable enterprise protocol.

Prepare for the split with a small runtime facade and replaceable current-Maestro adapter. Do not undertake wholesale Maestro extraction as part of Mega-Maestro. The feature can run against the current supported integration build, then adopt released Maestro Lib through the same contract.

## Responsibilities

| Component                | Proposed responsibility                                                                                                      | Mega-Maestro integration                                                                                       |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Maestro Lib              | Headless runtime operations, agent/provider session lifecycle, provider adapters, normalized events and execution interfaces | Runtime facade adapter, pre-execution authorization, command handling, canonical event/VIBES source            |
| Maestro UX               | Desktop/web interaction, local agent views, enrollment presentation, policy explanations, user inbox                         | Client of runtime and local management APIs; contains no enterprise policy authority                           |
| Maestro CLI              | Human and machine command frontend, structured output, automation and local/headless operation                               | Same runtime operations with authenticated actor context; stable JSON output and exit semantics                |
| Maestro Cue              | Trigger scheduling, durable queues, workflow versions, retries, fan-out/fan-in and recovery                                  | Dispatch through runtime authorization; centrally govern workflow definitions and observe workflow/run lineage |
| Mega-Maestro             | Fleet identity, org scope, signed policy, aggregation, gateway/routing, budgets, governance and enterprise UX                | Owns enterprise protocol and service; works with desktop or headless runtimes                                  |
| Managed endpoint service | Device trust, last signed policy, local enforcement broker, durable spool and central transport                              | Survives UX exit; one managed identity connects runtime components without duplicate enrollment                |

These responsibilities do not prescribe four new repositories. The independent Mega-Maestro repository remains /Users/dr3/dev-shit/mega-maestro. Maestro-side changes remain on feature/mega-maestro-integration in the Maestro repository until a separately authorized upstream extraction changes their location.

## Dependency and contract ownership

Maestro-owned generic runtime contracts must not depend on the Mega-Maestro API, database, UI, tenant hierarchy or enterprise deployment. Their eventual home is the Maestro Lib public interface. Until that exists, define a narrow compatibility facade in Maestro and a versioned adapter mapping at the enterprise boundary.

Mega-Maestro packages/contracts continues to own the enterprise enrollment/policy/telemetry/command protocol. It does not become the owner of every Maestro runtime type. packages/runtime-adapter in Mega-Maestro holds the mapping to a negotiated runtime contract and depends only on released/checksummed interface artifacts. Do not make Maestro Lib import application services or require cloud enrollment to work standalone.

Runtime concepts: list capabilities, list agents/runs, submit a run, inspect a run, cancel/interrupt if supported, subscribe/resume events, and expose management authorization before execution. These are logical interfaces; implementation validates exact method names and transport. Cancellation is best effort with explicit supported/unsupported/unknown results.

Enterprise hooks: authenticate management context, authorize action with exact immutable inputs, collect normalized event, read effective policy status and deliver user communication. A hook returning permission is not proof of OS confinement; retain the execution broker and provider conformance requirements.

Transport adapters can be in-process for trusted library hosts, authenticated local IPC for separate processes, and authenticated remote service protocol where supported. Business requests/results are serializable and do not expose BrowserWindow, renderer stores, PTY objects or filesystem handles. All remote operations reauthorize at the receiver. No browser-held privileged library handles.

## Stable operation context

Every operation includes request/idempotency ID, runtime ID, calling component, principal kind (human/service), principal ID, actor/delegation chain, run/provider-session linkage, origin (ux/cli/cue/enterprise), policy revision and requested capabilities. Identity and authority are established by the trusted host; callers cannot self-assert admin rights in JSON.

Changes in frontend cannot change permission. UX, CLI, Cue, direct library embedding and remote administration execute the same governed action through the same authorization boundary. Local direct shell, MCP, provider-internal tools and remote SSH remain explicit paths in the conformance matrix.

Retries preserve logical operation ID while attempts have distinct IDs. Normalize event streams once at the runtime boundary; raw provider records remain attributable evidence. Do not double count one execution reported by Lib, CLI, Cue, endpoint and gateway.

## Installation and component inventory

An enrolled installation owns device identity and management binding. Runtime IDs distinguish concurrent processes/hosts under that installation; component records contain component kind, version, build digest, runtime-contract version, process epoch, health and capabilities. Agent and provider-session IDs are stable independently of the UI tab layout.

A headless Lib/CLI/Cue installation is a first-class managed installation. UX absence is not an offline or unhealthy runtime. Closing UX does not terminate the endpoint service or erase policy. CLI ephemeral processes may attach to the protected local runtime/service; a separately embedded runtime registers its own runtime ID without minting another device identity.

Show component-level compatibility, not only one Maestro version string. Preserve historical instance IDs using explicit aliases/mapping records during migration; do not create new billable devices or duplicate runs when a monolith splits. Several runtime versions can coexist when the capability policy permits them.

## CLI and Cue semantics

CLI APIs use structured requests, machine-readable results and stable error codes with human-readable explanations. Enterprise clients use the API or structured protocol, never scrape terminal text. Reuse credential and policy service; CLI convenience flags cannot bypass managed authorization.

Cue owns trigger and workflow execution state. Enterprise policy owns permission to register/modify/enable workflows and to run each action. A workflow can be allowed at registration and denied later at dispatch after a policy change. Recheck on dequeue, retry, fan-out child and downstream action.

Capture workflow ID/version, trigger event ID, root run ID, attempt ID, causal parent, actor and cost attribution. Every fan-out child inherits the permitted scope and a budget allocation. Retries do not obtain additional authority. Capture shell/CLI actions and chained prompt runs using the same controls as direct runs.

Central orchestration assigns each workflow an execution owner with a persisted epoch/fencing token; local and central schedulers cannot both dispatch the same logical trigger. Offline operation uses already assigned ownership under the last policy. Do not transfer authority for a disconnected owner's offline-enabled workflow until safely fenced or acknowledged; global exactly-once side effects across a partition cannot be promised. Explicit at-least-once semantics and side-effect idempotency remain required.

## Migration sequence

1. Publish/version enterprise contracts and document the provisional runtime facade.
2. Build a current-Maestro adapter on the dedicated feature branch, reusing canonical utilities and preserving standalone behavior.
3. Route current UX/CLI/Cue and existing remote execution through the governed facade. Keep legacy adapters while callers migrate; prohibit an unguarded alternate path.
4. Establish shared contract/conformance fixtures for identity, policy, events, cancel and retry behavior.
5. When Maestro Lib is released, pin its interface and implement a Lib adapter behind the same enterprise mapping.
6. Compare normalized events/decisions on recorded or synthetic workloads. Shadow only reads/evaluation; never send production side-effect commands to both adapters.
7. Canary the new adapter per installation/component and verify policy, capture, billing and workflow ownership before wider rollout.
8. Retain compatible rollback, stable IDs and audit provenance. Remove obsolete adapter code only in a separately reviewed cleanup after the support window.

Do not block the complete MVP on future Maestro Lib publication. Ship the tested current-runtime adapter and an executable neutral fake-runtime conformance harness. Actual future-Lib compatibility remains pending until tested against a released version. Enterprise UI must state this distinction.

## Additional acceptance requirements (R15)

- Generic runtime interfaces have no Electron/React or Mega-Maestro service dependencies.
- Current adapter and neutral headless fixture both pass the same runtime contract tests; future adapter uses those fixtures later.
- Equivalent UX, CLI, Cue and embedded-runtime operations return equivalent enterprise decisions with correct source attribution.
- Endpoint policy continues after UX shutdown and while central connectivity is unavailable.
- Component/version inventory and stable IDs survive a simulated split without duplicate enrollment or spend.
- Unsupported protocol/capability combinations fail explicitly without weakening policy.
- Cue registration, queue replay, fan-out, offline ownership and shell/CLI actions respect policy and budget.
- Adapter canary/rollback cannot execute a side effect twice.
- Paired release manifest records server, endpoint, Lib/runtime facade, UX, CLI, Cue, enterprise protocol and VIBES versions; absent future components are unavailable, never fabricated.

Implementation task paths are provisional seams. If upstream extraction already exists when a task runs, map to the actual public interface and record the mapping; do not recreate obsolete files solely to satisfy a filename in this playbook.
