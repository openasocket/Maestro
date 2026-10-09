---
type: index
title: Mega-Maestro Design and Playbook Index
created: 2026-09-18
tags: [mega-maestro, index]
---

# Mega-Maestro planning package

- [[MEGA-MAESTRO-DESIGN]]: product, UX, architecture, data, enrollment, policy, VIBES, FinOps and scale.
- [[MEGA-MAESTRO-SECURITY]]: trust boundaries, enforcement, offline semantics, DLP, keys and audit.
- [[MEGA-MAESTRO-GOVERNANCE]]: NIST baseline, native evidence/risk model and framework packs.
- [[MEGA-MAESTRO-MODULARITY]]: future Lib/UX/CLI/Cue boundaries, runtime adapters, headless inventory and migration.
- [[MEGA-MAESTRO-DELIVERY]]: requirements, phase order, task execution roots and complete-MVP gates.

- [[MEGA-MAESTRO-ENFORCEABILITY]]: early real enforcement, outage semantics and evidence contract.
- execution-plan.json: exact document/task ordering, dependencies and baseline digests.

Application Auto Run directory: /Users/dr3/dev-shit/mega-maestro/.maestro/playbooks/2026-09-18-Mega-Maestro/

Maestro Auto Run directory: /Users/dr3/dev-shit/Maestro/.maestro/playbooks/2026-09-18-Maestro-Enterprise-Integration/

Do not launch either directory by lexicographic order. Follow execution-plan.json; early enforcement documents are inserted between foundation and breadth phases. External qualification is scheduled separately.

Status: authored, not launched. Read [[MEGA-MAESTRO-INTEGRATION]] and [[MEGA-MAESTRO-DELIVERY]] for the two task-based tracks with independent foundations and a shared early enforcement checkpoint. Maestro uses /Users/dr3/dev-shit/Maestro/.maestro/playbooks/2026-09-18-Maestro-Enterprise-Integration; Mega-Maestro uses /Users/dr3/dev-shit/mega-maestro/.maestro/playbooks/2026-09-18-Mega-Maestro. Both repositories have local design snapshots. Maestro implementation requires feature/mega-maestro-integration; no branch was switched while authoring. Local fixtures enable independent progress, but actual paired evidence is mandatory for unified acceptance. See SPLIT-REVIEW.md for review findings, routing and task counts.

## Planning validation

Run `python3 docs/design/mega-maestro/validate-playbooks.py --application-root /Users/dr3/dev-shit/mega-maestro` in the application checkout, or `python3 Plans/mega-maestro/validate-playbooks.py --maestro-root /Users/dr3/dev-shit/Maestro` in Maestro. Supply both root options to check both document sets together. Adjust root arguments for an authorized integration worktree; no sibling checkout is required for independent validation.

This checks task preservation/order, scheduled document coverage, dependency cycles, mandatory early gates, branch declarations and baseline digests. It reports halt markers without deleting them. A valid planning structure is not evidence of implemented enforcement. See [[ENFORCEABILITY-REVIEW]] for amendment validation and known execution blockers.

## Automatic run entry point

Use [[AUTO-RUN-CHAIN]] for the current launch schedule. Launch only Maestro MAESTRO-ENTERPRISE-01; executable CHAIN tasks dispatch each subsequent batch to the correct project agent after producer verification. Existing artifact and security prerequisites remain mandatory. MINT-03-04 now lives in MAESTRO-ENTERPRISE-04, after application phase23. External qualification phase24 remains separate. Current schedule has 30 documents and 252 tasks; execution-plan.json is authoritative. No chain was launched while authoring.
