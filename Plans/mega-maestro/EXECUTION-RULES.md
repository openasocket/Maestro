---
type: execution-contract
title: Continuous delivery execution rules
created: 2026-10-08
tags: [maestro, playbook, implementation]
---

# Continuous delivery execution rules

These are task-based Maestro Auto Run playbooks. Each checkbox runs in a fresh context and returns control to the engine. Only checkbox tasks execute; a JSON manifest or prose description does not dispatch work. Use the named existing agents and explicit document order. No loops or resetting completed tasks are needed for a finite delivery checklist.

## Profile and completion

The run prompt chooses its profile. `complete` is the full delivery chain: Maestro foundations, application foundations and early endpoint, real Maestro binding, real pair proof, breadth, full paired acceptance, then external qualification and the MM-24-01 delivery report. It uses CHAIN-01 through CHAIN-09 through the normal desktop CLI. A batch ending after its handoff is normal; the next owner continues the chain. The entire effort finishes only when MM-24-01 proves the required acceptance gates.

`foundations` is a limited application phases 01-06 recovery batch. It deliberately ends at MM-06-06 and never starts peer/enforcement work. The foundationRecovery flags apply only to this selected profile. Do not infer a complete-product outcome from finishing this limited run.

## Implementation outcomes

Read the relevant specification and search reusable code before each task. IMPLEMENT produces the named source modules wired into actual package/runtime callers. TEST authors executable behavioral coverage. VERIFY runs the specified suite, build or real-service scenario and records commands, exit codes and tested source/artifact identities. A Markdown summary, package manifest, mock, skipped test or health endpoint alone cannot prove an implemented feature or integration.

Every new workspace package must have exact maintained dependency pins, strict recursive source compilation and applicable check/lint/test/build/runtime commands. If target files exceed three or changes exceed 500 lines, split distinct work into self-contained continuation checkboxes before its tests/verification. Keep generated output outside authored-source change limits; generated output is still checked for reproducibility. Tests, implementation and execution remain separate tasks. Do not omit migration scripts, exported APIs, route composition or runtime entry points and expect verification to invent them.

Use the authoritative application schema package for enterprise/domain contracts and the Maestro-owned generic runtime facade for runtime lifecycle. Generate the console HTTP client from actual central API route schemas. Avoid competing wire types, unowned policy engines and private sibling source imports. Real enforcement evidence requires actual packaged components and independent observed effects; fixtures only prove their declared test boundary.

## Progress and repair

One writer owns each active document and its local manifest. Preserve checked tasks and evidence. Record detailed results in task-specific evidence files; keep the checklist concise. When a local failure is repairable, fix it through the existing pending repair or add one distinct IMPLEMENT continuation immediately before its affected tests/VERIFY task. Update the owning task list and dependency edges once and run structural validation. Do not add repeated plan-audit tasks or duplicate IDs for the same defect.

Before a consumer relies on a previous phase or peer, read its required verification/handoff evidence and validate the relevant source/artifact identities. Checked implementation lines alone do not pass a producer gate. If the engine skipped an unfinished required producer, stop explicitly with the concrete missing predecessor; do not claim progress by building against invented interfaces. A real security failure or missing authority remains unchecked and visibly stopped. No endless identical retries.

A signing or staging failure does not erase implemented/tested work. Keep exact dirty-source provenance and report the failure separately. Preserve unrelated Git work and locks; do not disable signing or delete an unexplained lock just to advance.

## Human prerequisites

Human-only work is never an AI checkbox. Place Maestro's HITL marker immediately before dependent tasks; the conductor completes the human step and resumes the same run. Do not write a human acknowledgement on their behalf. Use trailing plain bullets for human follow-up that does not block execution. A fresh blocker requiring human input becomes a visible pause; authored playbooks never ship permanent halt comments.

Current gates cover a usable local Docker daemon, an explicitly authorized isolated enforcement host, and authorized scale/release-review infrastructure. These are different from implementation defects. Docker is needed for real-service verification, not document review. Host policy, privileged installation, paid access and production deployment are not inferred from an Auto Run launch.

## Handoffs and owner snapshots

Each repository's execution-plan.json owns its local task list and local repair edges. The validator composes those owned tracks. Shared baseline digests, execution profiles, cross-track edges and CHAIN schedule must match; routine local repair history is not copied to peers. Never edit peer implementation to reconcile a schema mismatch; the owner produces a new artifact.

Before dispatch, validate actual producer evidence, target identity/root and idle state. Write launch-intent to the named local receipt, then invoke exactly the target documents/agent through maestro-cli auto-run --launch. Acknowledged receipts prevent duplicate dispatch; unknown/ambiguous receipts require reconciliation against desktop history. Return after acknowledged launch, without waiting for the consumer or executing its tasks in the sender. Acknowledgement proves dispatch only. Never overwrite unrelated busy work.

Launching the complete profile authorizes these named handoffs, not arbitrary messages, agents or production operations. Do not create a second scheduler. Every handoff command declares `Execution profile: complete` so the receiver does not apply limited foundation recovery restrictions accidentally.

## Acceptance

R01-R15 remain the delivery requirements in MEGA-MAESTRO-DELIVERY.md. Local code/tests, actual pair, platform/provider coverage, SaaS/self-hosted packaging, 10k measurements and human review each have their own evidence. MM-24-01 reconciles all tasks, repair continuations and actual required evidence before saying complete. Release eligibility and publication are separate: this playbook does not publish, deploy production or enroll real enterprise endpoints.
