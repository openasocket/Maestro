---
type: integration-completion-plan
title: Maestro and Mega-Maestro integration completion
created: 2026-10-29
status: proposed-work-sequence
maestro_revision: 0f31023a8f439aac5f3cae784c06571a31dfd3eb
mega_maestro_revision: d5143a63931dc87a5f90b3fdb7b58fa3726913b1
mega_maestro_source_dirty: true
tags: [maestro, mega-maestro, integration, policy, security, planning]
---

# Maestro and Mega-Maestro integration completion

The next integration milestone is an actual actor-bound policy installation,
followed by one constrained managed execution through the real Maestro client,
endpoint and API. Another Maestro-only hardening pass cannot deliver that result.
Mega-Maestro needs real producers and current artifacts, while Maestro still needs
mandatory headless authorization and several consumer composition fixes. The
required end-user product is the full Tauri desktop: users build and use
agents within endpoint policy. A headless pilot is an integration diagnostic,
not a substitute for that desktop experience.

Related: [[ANALYSIS]], [[EXECUTION-RULES]], [[README]]. The owned work items and
dependencies are in `integration-completion-plan.json`. Source hashes, revisions
and evidence scope are in `completion-review-2026-10-29.json`. This plan does not
change either active Auto Run queue or authorize production enrollment.

## Current readiness

Maestro's current Phase 1 has 147 checked tasks and five open paired checks.
Phase 2 has 101 checked tasks. The original JSON manifests still declare 92 and
74 tasks, respectively; reconcile the manifests with inserted continuations
before relying on their counts for dispatch or completion reporting.

The recorded real-pair execution on October 25 produced zero leases and zero
effects. One of thirteen acceptance rows passed, and that row is standalone
regression. October 29 readiness checks are not new positive pair evidence.
Completed authored tasks establish progress within their scope, not completion
of all Maestro-owned integration code or a secure managed product.

## Corrections to the agent report

| Report claim | Current source finding | Required action |
| --- | --- | --- |
| Registration approval has no API producer | The API already serves `POST /api/enrollment/runtime-registrations/approve`, binds a current browser session and actor, checks scope/nonce/digest, audits approval and supports mTLS redemption. | Compose that existing producer into the pair and approval UX. Do not implement another approval service. |
| `approvalProducer: false` proves no API exists | Maestro's pair script sets it to `Boolean(options.approveCommand)`. This is configuration detection, not an API probe. | Report approval bridge not configured separately from endpoint/API unavailable; exercise the real authenticated flow. |
| Pause and resume are absent | They exist in central signed commands and endpoint receipt/authority machinery. They are absent from the local command union, and the current development command runtime controls a neutral map. | Add compatible local protocol mapping and actual Maestro run-control ownership. Reuse signing, approvals, journals and receipts. |
| Mega-Maestro has shipped none of the services | Dirty application archives contain API, endpoint, ingest, worker and gateway entries. Their absent `components` metadata becomes `components: []` in the inspector. The source includes substantial implementations. | Publish usable, current Linux artifacts with exact producer metadata; do not confuse unusable delivery with absent code. |
| The runtime adapter can close execution security | `createMaestroAdapter` is indeed missing, but it maps a public runtime API. It is not a sandbox or a producer of all required execution leases. | Implement runtime mapping and prepared execution/confinement as separate outcomes. |
| Completing counterpart workflow support activates Maestro | Maestro's own `managed/host-adapter.ts:772-790` still unconditionally rejects workflow, delegation chain and grant references. | Change both producers and consumers under negotiated version support. Never strip context to fit an older protocol. |

The registration producer is in `apps/api/src/enrollment/routes.ts:43`,
`enrollment/service.ts:190-216`, and the domain registration wiring. The endpoint
persists the redeemed actor in `apps/endpoint/src/ipc/provision.ts:68-74`.
Existing `apps/api/test/runtime-registration.test.ts` provides reusable behavior
coverage; its existence is not a fresh passed pair run.

## Security blockers beyond the counterpart list

### Mandatory headless admission

Normal Maestro `turns.send()` submits text without managed context at
`src/shared/maestro-lib/runtime/turns.ts:679`. Dequeue and the actual turn/spawn
path apply management only when optional managed/admission fields are present.
Host standing must require authorization independently of which API the caller
selected. Cover ordinary sends, WebSocket dispatch, queued work, background
turns, retries and resumed processes at dequeue and at the effect boundary.
This is a source-based defect finding, not a reproduced runtime exploit.

Headless custody is a separate issue: `src/cli/services/host-managed.ts` can
remain uncomposed while sealed desktop enrollment exists, and runtime standing
also reads a different binding marker. A missing optional adapter or alternate
data directory must never make an enrolled installation standalone. Choose a
protected service owning identity and dispatch, or independently qualified
headless custody; neither copied Electron secrets nor a plain JSON flag is an
acceptable authority boundary.

### Actual effect authority and endpoint standing

Mega-Maestro's `apps/endpoint/src/broker/runtime.ts:67-78` always reports
execution unavailable and calls the consumer with null prepared execution.
Its inspection path explicitly lacks current actor/delegation authority and
resource, session/descendant, DLP, budget, egress and credential leases. Backend
and provider registries also report no qualified route. Endpoint status at
`apps/endpoint/src/main.ts:408-412` reports certificate-bearing enrollment as
suspended, never managed, with no desired policy revision.

Maestro's `src/main/enterprise/service.ts:589-596` does not inject an effects
producer into its spawn authority. Its content ceiling is unavailable and usage
is null. Publishing new schema fields or making the runtime adapter return
success will not compose these missing authorities. Standing, capabilities and
positive dispatch must derive from live producers; no readiness flag may bypass
their absence.

The synthetic Node route is a useful integration fixture. It qualifies no real
provider and claims no OS security boundary. The recorded Linux image also lacks
a permission flag that this fixture requires. Feature-probe the actual runner,
pin compatible runtime/image versions and observe effects independently.

## Ordered delivery milestones

### Preserve sources and close immediate Maestro gaps

First preserve both trees and identify the Mega-Maestro source changes needed
for a reproducible committed integration build. Do not blanket-stage hundreds of
unrelated changes or reset the developer checkout. Repair the reported dependency
and focused-test failures against the selected revisions.

In parallel, Maestro closes mandatory headless admission and installation-wide
standing. Missing or revoked authority must cause zero child, filesystem or
network effects; ordinary unmanaged behavior stays intact. These fixes do not
need a working counterpart to test at injected unit boundaries.

### Deliver a real registered policy consumer

Mega-Maestro builds clean Linux contracts and application artifacts from the
selected committed source. Maestro imports explicit archive digests and composes
the existing browser-session/CSRF approval bridge. Run actual challenge, approval,
mTLS redemption and actor-bound attachment, then deliver a signed policy and
observe its installation receipt.

Serve the operations needed by this slice through authenticated local adapters,
reusing existing enrollment, policy and identity services. Split unprivileged
runtime requests from privileged enrollment administration. A local peer must
not acquire permission to revoke or remove management merely because a lifecycle
schema exists. Capabilities and status must reflect actual live handlers.

This milestone needs no delegation, pause/resume, paid provider or native macOS
support. It proves actual identity and policy transport, without claiming an
execution effect.

### Produce the first managed execution result

Implement the real pinned public Maestro adapter and one prepared execution
route. Bind actor, current installed policy, immutable resolved inputs/resources,
credential and budget/egress constraints, actual process lifetime and settlement.
Compose the corresponding Maestro effect authority.

The pilot uses a declared harmless provider/tool fixture with actual built
Maestro, endpoint and API. Require an observed bounded file effect, a durable
lease and receipt, and a central lifecycle event. Also prove denial before effect,
changed-input rejection, revoke, replay, crash and lost-receipt/unknown recovery.
Neither a fixture policy table nor a manufactured allow/lease can close it.

Make readiness checks specific to this slice. Do not require future workflow or
platform capabilities before testing actor registration or a direct run. Removing
an unrelated aggregate preflight is acceptable; removing authentication or
required execution authority is not.

### Add delegated workflows and actual management features

Mega-Maestro implements bounded authenticated delegation and durable workflow
owner/epoch/fence/settlement producers, then serves the endpoint operation.
Maestro consumes negotiated support instead of its current unconditional refusal.
Exercise Auto Run, Cue prompt/shell/CLI, group chat and consult lineage with
revocation, restart and concurrent/offline-owner tests.

Reuse central signed command infrastructure for actual pause, resume and cancel,
plus policy refresh and notice/private-feedback receipts. Wire desktop usage into
the real stream. Define a supported content capture boundary and prove permitted
VIBES evidence, TRACE findings and governance links through actual services.
In-memory pending content uploads and a null usage field are unfinished features.

### Qualify provider and platform routes

Select one real provider, version, transport and OS before expanding the matrix.
Qualify its internal file/tool/shell/network/descendant effects, credential access,
revocation and fallback behavior. Launch admission alone is insufficient.

Treat PTY/maestro-p, Codex app-server, OpenCode server and SSH as separate route
qualification work. Correct standard provider arguments where possible and keep
unsupported modes denied. A passing refusal test does not restore the missing
product functionality.

macOS and Windows remain explicit delivery requirements. Native peer/process
identity, protected service installation, custody and effect confinement each
need platform evidence; native peer authentication alone is insufficient.
Linux-first is the proposed pilot scope, not a decision to abandon desktop
platform support.

### Stabilize upstream and complete qualification

Local refs show 103 integration commits absent from the local origin tracking
ref and 223 upstream RC commits absent from this branch. These are local-ref
readings, not a live remote check. Preserve the current integration checkpoint,
integrate a selected reviewed upstream revision in an isolated worktree and
rescan effect/credential paths after resolving conflicts. The reported 38
conflicting files have not been independently recomputed here.

Regenerate library, runtime archive and handoff provenance after source freeze.
Publish reviewable branches/PRs and run the existing workflows; a plain feature
branch push does not trigger the current PR-only qualification path. Repair the
reported failing suites, verify Linux pair behavior and Windows standalone/denied
unsupported behavior, then complete all thirteen required acceptance rows.
Do not create a new CI/CD program as a substitute for integration code.

Independent security review must cover standing/admission, custody and locks,
lease/resource lifetime and recovery, host secrets, bridge identity, egress and
provider effects before real tenant enrollment. Human release approval remains
release follow-up, not a checkbox that stalls unattended code implementation.

## Artifact delivery contract

- Contracts require explicit `contracts.tgz`, SHA-256 and sidecar, SHA-512
  integrity, exact dependency versions, source/input/payload provenance and the
  negotiated endpoint protocol. The current importer accepts contracts
  `>=0.1.0 <0.2.0` and endpoint protocol 1; incompatible extensions require a
  coordinated version/importer update.
- The clean Linux application must identify its real API, endpoint and gateway
  entries and the exact contract archive digest it contains.
- The runtime adapter pin must match that endpoint source revision and bind
  `qualifiedAgainst.maestroRuntimeSha256` to the packaged Maestro runtime
  **archive** digest. The library entry-file digest is a different identifier.
- Workflow authority provenance must identify the actual same-source producers
  and receivers, not only a schema file or a capability declaration.
- Rebuild stale library and handoff provenance after the final source revision.
  Unchanged entry bytes do not make an older source manifest current. Deliver
  explicit producer receipts and rerun affected checks; avoid endless peer polling.

## Full desktop authoring and interactive use

The Tauri desktop GUI remains the primary end-user interface. Users must be able to
create agents, choose permitted workspaces/providers/models/credential references
and tools, edit permitted settings, use tabs and interactive chat, and run the
automation their policy allows. They do not need permission to change enterprise
policy, remove endpoint management, enroll other devices or read other users'
content in order to do ordinary work.

The reviewed Maestro source uses Electron; the user-selected target is Tauri.
The Tauri playbook was not present in the two repository trees reviewed here.
Its existing migration design must be reused before assigning new host paths.
The following source findings describe legacy integration boundaries that the
Tauri host must preserve or replace, not a requirement to retain Electron.

The reviewed GUI is not yet this product. `NewInstanceModal` does not read live
managed choices. `useSessionCrud.ts` creates a local Session record with custom
arguments/environment/model and writes it into renderer state; bulk persistence
needs a host validation boundary. `enterprise/settings-policy.ts` explicitly has
no endpoint settings policy to install, so an enrolled desktop refuses lockable
keys rather than offering policy-constrained editing. Existing status, settings
and inbox components are useful scaffolding, not proof of a usable managed GUI.

Two required work items close this gap. **G-09**, owned by Mega-Maestro, delivers
a signed, versioned, principal-scoped authoring/settings projection through the
real endpoint. **M-06**, owned by Maestro, consumes those choices in the Tauri
GUI and uses one protected host mutation service for create, edit, clone, wizard,
import and session persistence. Client-side disabling is feedback; the host must
reject forbidden changes even when a caller bypasses the form.

The existing registration approval checks fleet-update permission. Preserve its
session/nonce/digest protections while defining narrow permission for an ordinary
user to bind and use an approved desktop runtime; do not solve user onboarding by
granting every employee fleet-management authority.

Policy must distinguish centrally locked settings, fields editable within
constraints and personal preferences. A missing producer cannot be replaced by
unrestricted edits or by permanently disabling normal agent authoring. Endpoint
enrollment and desktop-user actor registration remain distinct responsibilities.

The manifest adds six mandatory desktop journeys: ordinary-user creation, shared
edit/clone/import validation, actual Tauri desktop interactive execution, live policy
changes/revocation, offline/restart continuity, and user/content isolation with
accessible feedback. Run these against actual endpoint-delivered policy, with
positive allowed work and negative forbidden work. Product readiness also needs
a qualified real provider/transport on each declared supported desktop platform;
a headless test or synthetic provider cannot establish that claim. Replacing
the GUI shell does not supply the missing runtime adapter, signed policy and
identity composition, prepared execution leases or provider confinement. Legacy
IPC, custody and process-control code needs a trusted Tauri host/service
equivalent; frontend controls alone cannot enforce those boundaries.

## Proposed implementation queues

The machine-readable backlog has 24 owned work items and dependencies. They are
outcomes to split into bounded IMPLEMENT, TEST and VERIFY checkboxes when the
next playbooks are authored; they are not already running tasks.

| Queue | Primary work | Completion evidence |
| --- | --- | --- |
| Mega-Maestro producer completion | Current artifacts; existing approval composition; endpoint handlers/standing; real runtime adapter; prepared execution; desktop authoring/settings policy; durable delegation/workflow; command mapping | Actual consumer operations and positive/negative/recovery receipts from published artifacts |
| Maestro Phase 3 | Full GUI authoring and interactive use under endpoint policy; mandatory headless admission/custody; effect and workflow consumers; remaining effect/custody/lock gaps; usage/content and CLI parity | Actual ordinary-user GUI journeys, effects observed through real sinks, current revoke tests and unchanged standalone behavior |
| Joint pilot and integration | Actor/policy slice, then direct constrained execution, then wider accepted journeys | First actual leases/effects, source-bound paired artifacts and every required acceptance row |
| Provider and native platform qualification | One real provider route, then SDK/PTY/SSH and native macOS/Windows support | Per-route confinement and platform evidence; unsupported capabilities stay visible until qualified |

The next useful work is Mega-Maestro producer completion alongside the two
Maestro P0 fixes, followed by the first narrow real pair. Further Maestro-only
checkbox completion cannot establish the missing joint result.
