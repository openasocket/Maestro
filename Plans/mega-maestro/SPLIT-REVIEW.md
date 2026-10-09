---
type: review
title: Split playbook review and execution routing
created: 2026-09-18
status: authored-not-launched
---

# Split review

Related: [[MEGA-MAESTRO-INTEGRATION]], [[MEGA-MAESTRO-DELIVERY]].

| Track        | Agent                                                    | Auto Run phase directory                                                                 | Documents | Initial tasks |
| ------------ | -------------------------------------------------------- | ---------------------------------------------------------------------------------------- | --------- | ------------- |
| Maestro      | Maestro-Codex, 9b4b298d-918a-4c8d-a9a8-c9a014a04adb      | /Users/dr3/dev-shit/Maestro/.maestro/playbooks/2026-09-18-Maestro-Enterprise-Integration | 3         | 25            |
| Mega-Maestro | Mega-Maestro-Codex, 0e1de84b-08c2-43f7-a9b3-865419a715ba | /Users/dr3/dev-shit/mega-maestro/.maestro/playbooks/2026-09-18-Mega-Maestro              | 22        | 173           |

The table above records the original split before enforceability-v2; current counts/order are in execution-plan.json. Both configured agent roots match these projects. These are task-based documents, not launched. Preserve application numbering 01-14,16-23; there is deliberately no application 15. Maestro documents are MAESTRO-ENTERPRISE-01 through 03. All 178 original task IDs remain, with 20 explicit independent-bootstrap/handoff/acceptance tasks added, totaling 198.

## Findings and corrections

- The mixed folder could run application tasks on the Maestro agent. It is replaced by repository-local folders and root guards.
- The application phase-01 halt marker was a historical wrong-root attempt, not an application defect. The original bytes are preserved in Maestro Plans/mega-maestro/archive/mixed-playbook-2026-09-18.json; the relocated phase has a fresh root guard and no stale halt.
- Maestro previously assumed completed application contracts. Its local track now implements an owned transport-neutral port with test-only endpoint fixtures, then binds the real schema artifact in a separately gated phase.
- Console phase16 previously required Maestro phase15 completion. It now runs against real local APIs and neutral runtime/device fixtures; actual Maestro evidence is required at joint acceptance instead.
- Contract divergence is addressed through identical agreement snapshots, SHA-256/version pins, single schema ownership, export/import tasks and consumer conformance. No sibling source imports or runtime dependency on another checkout.
- Application phase23 owns real paired execution. Maestro's final acceptance consumes its report, but application phase23 consumes the earlier Maestro real-client handoff, not final acceptance. This removes circular waiting.
- Local, joint and complete-MVP status are separate. Missing counterpart, platform, real identity/provider, scale or human review evidence cannot be promoted to passing.

## Operational boundaries

Maestro implementation still requires a separately provisioned feature/mega-maestro-integration checkout from an explicitly selected clean base. This authoring change does not create or switch that branch. No application code, contract package, endpoint, tests or deployment has been implemented by this split.

The archive preserves removed mixed-folder documents for recovery; it is outside Auto Run and contains no runnable phase documents. Use the local design snapshot in each repo. Amend the integration baseline by version and explicit synchronized snapshot update, not independent edits.

## Review checks

The original split review checked original task preservation, unique IDs, counts, snapshots and branch guards. The enforceability-v2 validator additionally checks ordered task coverage, baseline digests and an acyclic dependency graph. Active halt markers are reported, not erased or interpreted as passing readiness. Application verification still requires actual implemented code and test execution later.

## Enforceability-v2 amendment

Early endpoint/gateway, real Maestro bindings and paired proof now precede feature breadth. The application and Maestro retain ownership; later tasks extend those implementations. External MM-21-05 scale qualification and MM-23-04 release acceptance moved intact to application phase 24. Task IDs were preserved; new IDs cover concrete feasibility, CI, quality/outage and observability work. execution-plan.json records current counts and dependencies.

The existing Maestro phase-01 halt marker is preserved: its current checkout is feature/hom-mode, not the required feature/mega-maestro-integration. This is a valid unresolved branch guard, not stale history to erase during authoring. Provision the authorized clean integration checkout and revalidate the blocker before removing the marker and launching. This authoring change did not switch branches, implement application code or launch a playbook. A separate preflight attempt added a branch-guard halt to the new Maestro early document while authoring was in progress; that marker and its historical report were preserved.

Current enforceability-v2 package: 25 application documents / 201 tasks and 4 Maestro documents / 43 tasks. All 198 pre-amendment task IDs remain exactly once; 46 tasks were added. These are task counts, not duration estimates.
