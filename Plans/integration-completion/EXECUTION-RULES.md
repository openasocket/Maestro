---
type: execution-rules
title: Integration completion execution rules
created: 2026-10-29
tags: [maestro, mega-maestro, autorun, implementation, policy]
---

# Integration completion execution rules

These rules govern the new completion program in [[README]] and `program.json`.
The source specification is [[INTEGRATION-COMPLETION-2026-10-29]]. This program
implements its outcomes; the specification and previous queues remain historical
records. Authoring this program does not establish any completed runtime feature.

## Ownership and execution

Mega-Maestro tasks execute only in `/Users/dr3/dev-shit/mega-maestro`, with agent
`0e1de84b-08c2-43f7-a9b3-865419a715ba`. Maestro tasks execute only in its own
workspace, `/Users/dr3/dev-shit/Maestro`, with agent
`9b4b298d-918a-4c8d-a9a8-c9a014a04adb`, or an explicitly prepared owned worktree.
Do not write sibling source, enroll real tenants, launch another agent, alter live
Maestro JSON stores, or activate Cue while executing a single-owner stage.

Use the preserved integration feature branch and its current changes. The old
`v1.1.0-RC` commit is a comparison point, never a reset target. Snapshot relevant
work without blanket staging, forced checkout, history rewriting or changing
signing configuration. If another process is editing the tree, use a supported
isolated worktree. Integration must preserve upstream and standalone behavior.

Every checkbox is self-contained for task-based fresh contexts. Read the task,
these rules, its `program.json` entry, source contracts and required receipts.
Search for an existing service, helper or equivalent module before adding one.
Proposed filenames identify the intended boundary; reuse a current equivalent and
record the mapping rather than create a second implementation. Recheck migration
numbers at execution time. Adapt Tauri paths once if an actual Maestro scaffold
already exists; SLOP's Tauri playbook belongs to another application.

IMPLEMENT changes application behavior. TEST authors focused unit or harness
cases. VERIFY executes checks and records results; keep these separate. Each task
authors at most three files and fewer than 500 changed lines. For a larger native
backend, migration, merge or frontend port, insert concrete bounded IMPLEMENT and
TEST continuations before the dependent verification; do not check an umbrella
task while required behavior remains absent. Reconcile new task IDs/counts with
the manifest. Generated-file changes produced by tools must be recorded honestly.

## Finite stages and handoffs

`program.json` is a dependency-checked finite program, split into owner batches.
Each saved stage runs its own ordered documents to completion without looping or
resetting checkboxes. Choose a stage whose required artifacts are present and
current. A stage ending after publishing its outputs is a completed handoff;
starting the next owner is orchestration outside that stage. No peer dispatcher
or recurring scheduler is installed by this authoring effort.

The first independent Mega stage and Maestro baseline stages can begin without
the counterpart's final service. Later producer code uses immutable public
consumer BUILD artifacts, then a real pair qualifies the composed behavior.
Never wait for the other side's final qualified receipt to implement the producer
that receipt itself requires. Do not repeatedly poll peers or recreate old plans.

Do not introduce aggregate Docker/native/provider preflights into every task.
Compile and unit-test source work independently. When a real service check needs
an isolated database, Linux service fixture or native machine, provision it using
the owned workspace/test runner and existing supported infrastructure. Use only
declared isolated test identities, profiles, keys, services and resource limits.
Do not change host startup/storage or install privileged services outside the
execution workspace to satisfy an unrelated precondition.

Repair ordinary failures: inspect the error, add a bounded implementation/test
continuation before the failing check, run it and retry the actual check. Never
erase failures, disable required guards or mark absent effects as success. A truly
missing cross-owner input is named with producing stage and exact artifact, and
the dependent verification stays incomplete; independent code work remains
available in other ready stages. Do not preauthor stop/approval markers.

## Public artifacts and immutable input authority

Consume the other repository through its public versioned contracts, runtime,
service/native archives and receipts. Private sibling imports are not integration.
Check archive SHA-256/sidecar, SHA-512 integrity, exact dependency closure,
manifest identity, payload paths/hashes and negotiated wire versions before code
loading. Current contract importer assumptions are `>=0.1.0 <0.2.0`, protocol 1;
incompatible changes require a coordinated importer/version change.

An implementation snapshot records clean implementation commit, observed checkout
HEAD, exhaustive build/runtime input map and payload map. Inputs include lockfiles,
native binaries, configuration, schemas, templates, runtime prompts and generated
inputs; Markdown is not automatically excluded. Only proven non-input checklist
or coordination receipts may change without invalidating unchanged artifacts.
Never label a dirty implementation clean or substitute `allow-dirty`/stale bypasses.
Export a clean committed snapshot while preserving unrelated developer work.

Every emitted receipt records schema version, artifact ID, owner, proof class,
implementation/observed revisions, input digest, archive/payload hashes, dependency
artifact IDs and hashes, actual commands/exit results, cases and redacted evidence
paths. Never include credentials, cookies, raw key material or private user content.
Store receipts in `docs/evidence/integration-completion/` for Mega and
`Plans/integration-completion/evidence/` for Maestro. Public archive locations and
hashes must be explicit, not just filenames or a success boolean.

A `*-BUILD` receipt is a real compiled, unit-tested implementation input. It
unblocks another agent's composition work. It grants no lease or policy authority,
enables no provider support and proves no paired/native security outcome. A
qualified receipt requires independently observed real boundary effects, denial
and recovery cases as specified. Source declarations, capability flags, DTOs,
synthetic maps and fabricated leases cannot qualify support. The endpoint must
derive readiness from live authority and current genuine qualification evidence.

The adapter's `qualifiedAgainst.maestroRuntimeSha256` names the Maestro runtime
ARCHIVE digest, not an entry-file digest. The endpoint and adapter use the same
Mega implementation snapshot. Final packaging consumes the final Maestro runtime
cohort, refreshes pins and reruns all affected proofs. Intermediate M0 evidence is
not final source qualification. Keep coordination receipts outside the input set
only when they really are not application/build inputs, avoiding reciprocal pin
commits that invalidate unchanged binaries forever.

Apply that refresh at each paired milestone, not just at final packaging. If the
current consumer BUILD contains a newer runtime than M0, rebind the owned adapter
to that actual archive and rerun affected conformance in the current task's bounded
continuations. Pin drift from real source changes is repair work; archive swapping
or trusting the old proof is not a valid shortcut.

## Required application behavior

Reuse the existing browser-session/CSRF runtime-registration approval API, mTLS
redemption, signing, audit and nonce/digest protections. An absent harness approval
command is not evidence that the API does not exist. Separate ordinary runtime
binding/use permission from fleet administration. No supplied actor JSON, copied
bearer token or permissive fixture policy can replace authenticated actor binding.

Implement real `createMaestroAdapter` mapping separately from prepared execution
and effect confinement. Mandatory admission follows installation standing at
normal send, dequeue, retry/resume and actual effects, regardless of caller flags
or data-directory choice. Exact inputs/resources, actor, policy revision, DLP,
credential/egress/budget grants, process/descendant ownership and durable settlement
remain bound through the effect. Uncertain outcomes require reconciliation.

Preserve current delegation scope and workflow owner/epoch/fence end to end.
Replace unconditional unsupported answers only after negotiated actual support;
never strip delegation fields to make a request fit. Reuse signed pause/resume/
cancel and durable command journals; prove effects on an actual owned process.
Notices are private inbox actions, never an implicit instruction channel to agents.

The product target is the full Maestro **Tauri** desktop. Existing Electron paths
are migration anchors. Reuse the current React UI and public runtime in a trusted
native host/packaged authenticated sidecar instead of duplicating the backend.
[Tauri IPC](https://v2.tauri.app/concept/inter-process-communication/),
[capabilities](https://v2.tauri.app/security/capabilities/) and
[sidecars](https://v2.tauri.app/develop/sidecar/) define the host boundaries;
webview capability permissions do not replace enterprise policy authorization.

Ordinary users create/edit/clone/import agents, choose approved providers/models/
workspaces/credential references/tools and run interactive work. One host mutation
boundary validates every path, including wizard and whole-session persistence.
Distinguish locked, constrained-editable and personal settings. Preserve drafts,
keyboard access, screen-reader feedback, translation keys and actionable reasons.
Neither an enterprise badge nor blanket lockdown delivers this application.

Compose real usage and authorized provider-visible capture into existing durable
spool/vault/VIBES/TRACE/governance paths, with provenance, privacy and gaps. Missing
content remains unavailable; never invent metering or hidden provider reasoning.
Retain least-privilege credential custody and close the recorded headless Cue,
TUI token, plugin/renderer lock, egress/listener and post-admission sink gaps.

## Verification and completion

Use meaningful focused unit tests and reusable harnesses. A synthetic Node route
can prove a narrow real lease/effect integration slice but qualifies no real
provider. Use an actual pinned provider executable with deterministic compatible
local model responses to exercise internal tools without customer accounts or
paid requests. Label the fixture model transport honestly. Qualify CLI, persistent
SDK, PTY and SSH routes individually, including real confinement, credentials,
descendants, revocation and fallback. Unsupported mandatory routes remain open.

The Linux pilot first proves actor/policy, then a bounded direct run and actual
central receipt. macOS and Windows require real connected-peer/process birth
identity, protected installation/custody and native effect evidence. Cross-builds,
Linux mocks and platform-skipped tests do not prove these requirements. Native
qualification stages declare RUNNER-MACOS/RUNNER-WINDOWS; these are execution
inputs, not established infrastructure or optional waivers. Do not block unrelated
implementation on their absence or claim full unattended native completion.

Automate the actual Tauri binary through its trusted commands and supported native
driver. Follow [current native WebDriver guidance](https://v2.tauri.app/develop/tests/webdriver/).
A browser-only render, IPC double or screenshot cannot close desktop acceptance.
Require all original 13 acceptance rows plus GUI-01 through GUI-06 in the manifest,
with positive, negative and recovery observations against the final pinned pair.
Keep standalone regression, user/content isolation and required provider/platform
tuples explicit. A deny-only required row stays incomplete.

Use existing build/test/PR workflows after focused repairs. Publish only the owned
reviewable feature branch/draft PR when running the final verification stage; no
forced push or upstream merge. Record current workflow run URLs/revision/results;
local checks alone cannot claim CI qualification. Fix existing checks rather than
build a new CI/CD platform. Record final source/runtime/API/endpoint/native hashes,
actual observed effects, receipts and remaining limitations.

Source implementation, paired functional completion and production qualification
are separate claims. Final completion requires every mandatory row and native/
provider tuple, not a task count or blanket complete flag. Independent human
security review and production release approval remain plain follow-up items,
never unattended checkboxes. Do not enroll real tenants before that review.
