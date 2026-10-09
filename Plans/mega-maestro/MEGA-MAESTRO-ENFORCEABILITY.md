---
type: execution-contract
title: Early enforceability and evidence gates
created: 2026-09-19
version: enforceability-v2
status: authored-not-launched
tags: [mega-maestro, enforcement, integration, acceptance]
---

# Enforceability contract

Related: [[MEGA-MAESTRO-INTEGRATION]], [[MEGA-MAESTRO-DELIVERY]], [[MEGA-MAESTRO-SECURITY]].

This amendment changes delivery order, not complete-MVP scope. It replaces late discovery of execution feasibility with an early real-artifact checkpoint. It does not authorize implementation on feature/hom-mode, a branch switch, execution on this workstation, external deployment, paid model traffic, or a playbook launch.

## Scheduled order and ownership

Use execution-plan.json in this design directory as the explicit document schedule. Do not launch the directory in lexicographic order. Each track lists documents and ordered task IDs; each task lists its exact predecessors. Tasks within a document run in their listed order; inserted continuation tasks inherit that position and must be added to the manifest before resuming. This manifest is planning data, not a claim that Maestro automatically enforces dependencies.

1. Application phases 01-06 establish contracts, authenticated tenant services, enrollment and signed policy. Maestro phase 01 independently maps execution paths and builds its generic runtime facade.
2. Application MEGA-ENFORCEMENT-01 implements a minimal reusable endpoint, execution broker and gateway on those real foundations. It publishes an early archive, without waiting for Maestro or the later enterprise features.
3. Maestro MAESTRO-ENFORCEMENT-01 consumes that archive after Maestro phase 01, wires the real client and governed entry points, and publishes its early client/runtime handoff. It does not wait for application joint evidence.
4. Application MEGA-ENFORCEMENT-02 consumes that client and runs the real pair. Maestro imports/reproduces this evidence at the beginning of its phase 02. Application phase 07 and Maestro phase 02 cannot begin feature breadth until the early gate passes.
5. Continue application 07-14,16-22 and Maestro 02. Existing implementations from the early slice are extended in place. No second endpoint, broker, gateway, client or policy engine.
6. Maestro phase 03 refreshes the full wire binding and exports its full client before its final acceptance task. Application phase 23 runs full joint qualification. Maestro's final acceptance consumes that report, never the reverse.
7. Application phase 24 separately runs external scale qualification and unified release acceptance. Pending infrastructure or human reviews cannot block phase 22 local-readiness reporting or phase 23 joint tests, but always block complete-MVP designation.

Missing counterpart evidence is a deliberate blocker at the early pair gate. Fixture-based foundation work can progress independently; breadth cannot bypass this checkpoint. Do not repeatedly retry blocked tasks. Resume only when the named immutable artifact or environment becomes available. Each runner records its own status without claiming the other track has passed.

## Supported enforcement matrix

Before the early slice, choose one initial OS/provider/version/backend combination based on actual available authorized test infrastructure. Record executable/build hashes, provider tool/model interception, process and descendant confinement, file and network boundaries, credential custody, endpoint peer authentication, management-binding protection, capture limits, and interruption support. Pin official implementation references during that task; do not choose a platform mechanism from memory.

The early slice proves at least one real provider adapter. A synthetic provider can validate a harness but cannot close this gate. Model responses may come from a controlled local test server only when the actual provider supports that endpoint and its real request/tool loop is exercised. Otherwise a separately authorized provider test environment is a prerequisite. No paid traffic is implied by this plan.

For every entry point, record one of: enforced with evidence, denied before dispatch with evidence, unsupported and denied, or unverified. Only the first state counts as supported functionality. The early slice must exercise successful desktop and CLI managed execution plus Cue prompt dispatch; Cue shell/CLI actions, Auto Run, terminal, SSH, embedded hosts and other discovered entry points must either use the same broker or fail closed. Later advertised routes require successful positive and negative tests, not just a blanket deny.

Endpoint loss must not erase enrollment. Use protected persisted management binding established through authenticated enrollment; ordinary settings, renderer state, environment variables, alternate binaries or deleted user files cannot turn an enrolled installation into standalone mode. Record the OS/MDM prerequisite that protects that binding. Local root/kernel compromise remains outside software-only guarantees. Unenrolled standalone behavior stays unchanged.

## Required early proof

Run actual packaged central enrollment/policy services, endpoint, gateway, Maestro client and selected provider. Fakes are limited to safe data, tool targets and permitted model-response transport. Do not replace the endpoint, runtime, confinement backend, or real provider adapter with doubles. Use an isolated workspace and explicit test-environment allowlist; never install the service on the developer workstation as a side effect.

- Authenticate enrollment, install signed policy, and show exact desired/applied revision.
- Execute an allowed safe action through desktop, CLI and Cue prompt paths. Observe its actual effect and correlate run, request, policy and receipt IDs.
- Deny a forbidden filesystem/process action and prove absence of its effect using an independent observer. A denial log alone is insufficient.
- Block direct model destinations, alternate credentials/environment overrides, raw network/subprocess escape, and configured unsafe permission flags. Observe the forbidden test server receiving no protected request. Mandatory egress controls must cover descendants.
- Reject forged local peer identity, changed arguments, symlink/resource substitution, replayed grants and post-authorization mutation. Reused authorization cannot spawn again.
- Stop/restart the endpoint, close the UX and disconnect central policy service. Verify management binding persists and last valid policy remains authoritative; absent/corrupt trust cache denies execution.
- Exercise the outage cases below and report supported continuation separately from denied work. Do not claim an offline budget feature before phase 12 proves allowance conservation.
- Preserve a durable minimal decision/event receipt across restart and replay, without duplicate governed effects. Metadata mode must exclude prompt/tool bodies.
- Verify unenrolled standalone regression and incompatible-version rejection.

Record tests, commands, exit status, observed effects, platform/provider versions and artifact digests in early-integration.json. Status is passed only when all mandatory early scenarios passed for the declared initial combination; unsupported additional platforms remain release gaps. A real bypass halts breadth, even when all fixture tests pass.

## Outage semantics

| Failure                                        | Permitted behavior                                                                                                                                                                    | Required denial                                                                                                                |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Control service unavailable, gateway reachable | Cached signed policy remains active. Gateway and endpoint must agree on an explicitly compatible policy identity/revision; apply no widening.                                         | Operations needing fresh approval, unsupported policy reconciliation or unavailable budget reservation.                        |
| Gateway unavailable, control service reachable | Local non-model work permitted by policy may continue. An already approved local/customer-local model route requires its own proven DLP, egress, credentials and metering boundaries. | Direct provider fallback or unapproved model routing.                                                                          |
| All central connectivity unavailable           | Cached-policy local work may continue. Model execution requires a previously approved reachable local route and valid bounded offline allowance once phase 12 exists.                 | Network model routes, expired approvals, exhausted/unavailable allowance, or any mandatory protection that cannot be enforced. |
| Endpoint unavailable or cache/trust invalid    | Status/recovery operations only for an enrolled installation.                                                                                                                         | Managed execution, including resume/send into an existing provider session. Never silently revert to standalone.               |

The initial slice may explicitly deny offline model work. It must still prove offline policy enforcement on safe local actions. Phase 12 must implement and prove bounded allowance behavior for the declared offline-capable route, or leave that capability and corresponding complete-MVP requirement pending. Online financial reservation is also mandatory before any live paid route is claimed supported.

## Artifact and evidence contract

Each producer writes early-handoff.json in its existing evidence directory. Fields: integrationId, stage (early/full), agreementDigest, enforceabilityDigest, repositoryRevision, sourceTreeDigest, artifact-relative paths, SHA-256, semantic versions, supported matrix, scenario results, producer status and prerequisites. SourceTreeDigest covers implementation/configuration/lockfiles, excluding generated reports, archives and playbook checkbox changes to avoid self-invalidating evidence. Document the exact inclusion rules; source changes invalidate affected pair evidence.

Producers write immutable archives under their own artifacts/enterprise/<version>/<sha256>/ directory. Consumers receive an explicit readable path or approved private artifact URI, verify digest and provenance, then copy into their own vendor/enterprise/<sha256>/ directory. No sibling runtime imports, public publication, mutable latest alias, embedded secret or automatic credential creation. A separately authorized CI credential may retrieve a pinned private artifact. Retain artifacts referenced by an active compatibility/release manifest; garbage collection cannot remove those artifacts.

Application owns docs/evidence/early-integration.json; Maestro imports a digest-verified copy into Plans/mega-maestro/evidence/early-integration.json and reproduces denial/offline/standalone smoke tests. Gate validation checks both exact source/artifact identities, both document digests, scenario coverage and passed status. Missing, stale, failed and fixture-only evidence are distinct non-passing states. Never infer acceptance from a checked Markdown task or a process exit without its evidence.

## Later qualification and task reuse

Phases 07,09,10,11,13 extend the early spool, DLP boundary, broker, gateway and daemon respectively. Their tasks remain required and must inspect early implementation before editing. Phase 09 receives a buildable gateway package before its gateway tests. Phase 13 composes mature communications and command services into the existing endpoint rather than introducing its first executable daemon.

Quality-based automatic routing stays disabled until a versioned outcome/evaluation contract, externally sourced accepted outcomes, representative baseline, sample requirements and rollback criteria exist. Agent completion claims cannot supply acceptance. Early CI validates contracts, migrations, fixture boundaries and plan structure; real integration jobs require explicit artifacts and environments. Instrument endpoint, gateway and ingestion alongside API/workers with bounded-cardinality, redacted metrics.

Human approvals and external infrastructure remain release requirements. They are not simulated by an agent. The final qualification document consumes their recorded evidence and remains unchecked until all mandatory gates pass.
