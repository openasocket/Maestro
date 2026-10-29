---
type: phase-plan
title: Maestro managed integration, Phase 3 (completion plan consumer)
created: 2026-10-29
status: authored
maestro_branch: feature/mega-maestro-v1.1.0-rc
maestro_head: 0f31023a8
source_document: /Users/dr3/dev-shit/mega-maestro/docs/design/maestro-rc/INTEGRATION-COMPLETION-2026-10-29.md
source_backlog: /Users/dr3/dev-shit/mega-maestro/docs/design/maestro-rc/integration-completion-plan.json
counterpart_commit: d5143a63931dc87a5f90b3fdb7b58fa3726913b1
tags: [mega-maestro, maestro, integration, autorun, phase3, security]
---

# Phase 3: the Maestro half of the integration completion plan

Related: [[EXECUTION-RULES]], [[PHASE2-GAPS]], [[counterpart-requests]],
[[p2-final]]. The Auto Run documents are
`.maestro/playbooks/2026-10-29-Maestro-Mega-Integration-P3/MAESTRO-MEGA-P3-01..08.md`.

Mega-Maestro's completion document of 2026-10-29 lists 24 owned work items.
Seven are Maestro's (`maestroPhase3` in its backlog): M-01, M-02, M-03, M-04,
M-05, M-06 and BASE-02, plus Maestro's half of G-02, G-07, G-08 and VERIFY-01.
This plan turns those into bounded tasks and records what each Phase 3 document
closes, what it must leave open, and why.

## Source claims verified on this branch (2026-10-29, HEAD 0f31023a8)

| Claim in the completion document | Verified at | Finding |
| --- | --- | --- |
| `turns.send()` submits without managed context | `src/shared/maestro-lib/runtime/turns.ts:665-695`, `submitText()` at `:613-641` | `send()` calls `submitText(agentId, tabId, text)` with no fourth argument; `managed` is spread onto the item only when a caller passes it (`:640`). The dequeue path at `:285` reads `item.managed` and admits only when present. The managed port `sendManaged()` at `:705` is the only caller that attaches one. |
| Host adapter unconditionally refuses workflow and delegation | `src/shared/maestro-lib/managed/host-adapter.ts:772-792` | Confirmed: `context.workflow` and a nonempty chain or grant ref answer `unavailable` before negotiation is consulted. |
| Spawn authority receives no effects producer | `src/main/enterprise/service.ts:589-596`, `spawn-authority.ts:183-185` | Confirmed: `createProcessSpawnAuthority()` is composed without `effects`, so the port falls back to `unavailableEffectAuthority()`. |
| Usage is null | `service.ts:655-656` | Confirmed: `usage: () => null` with a comment naming MRC-10-04A open. |
| Settings policy has nothing installed | `src/main/enterprise/settings-policy.ts:72-86, 245-266` | Confirmed: `createSettingsPolicySource()` holds `installed = null` until something calls install; no endpoint operation delivers one. |
| GUI authoring bypasses the host | `NewInstanceModal.tsx` (1294 lines, no managed read), `useSessionCrud.ts:257-293` | Confirmed: the renderer builds the Session with custom args, env and model and writes it with `setSessions()` then `flushSessionPersistence()`; the main process `sessions:setAll` and `sessions:setMany` handlers hold no per-field policy. |
| Headless custody can stay uncomposed | `src/cli/services/host-managed.ts:84-97`, `agent-spawner.ts:751-776` | Confirmed: with no protected seal the host composes nothing and answers `unavailable`; the CLI reads the binding file from the current then production data dir and answers `enrolled-unavailable` or `standalone`. Neither can mint standing. The defect is that a plain Node host has no custody path at all. |
| Pair script `approvalProducer` is configuration, not a probe | `scripts/mega-maestro-pair.mjs:257-260, 481` | Confirmed: `Boolean(options.approveCommand)`. |

## What Phase 3 can and cannot close alone

| Document | Backlog item | Closable from this repository | Needs a counterpart producer |
| --- | --- | --- | --- |
| P3-01 | M-01 | Yes, at injected unit boundaries | No |
| P3-02 | M-02 | Yes for standing; headless custody needs a protected seal design decision recorded, not a copied Electron key | No |
| P3-03 | M-03 consumer half, G-02 Maestro half | The effects port wiring, the feature probe, the approval bridge and the honest diagnostic | G-05 for a real effect, G-01 and the API for a real approval |
| P3-04 | M-04 consumer half, G-07 and G-08 Maestro halves | Negotiated-support consumption, pause and resume run-state adapter, usage composition | G-06, G-07 and G-08 producers for the real pair |
| P3-05 | M-05 | Yes | No |
| P3-06 | M-06 consumer half | The one host mutation service, renderer consumption of a projection, field-level denials, drafts | G-09 for a real policy projection |
| P3-07 | BASE-02 | Yes, in an isolated worktree | No |
| P3-08 | VERIFY-01 Maestro half | Focused repairs, standalone proof, the six GUI journeys against an injected projection | CI needs a pull request the person opens; the real pair needs CP-01 through CP-06 |

Every real-pair VERIFY task in Phase 3 carries the same guard the five open
Phase 1 tasks carry: compare the sibling commit, artifact set and library sha
against the newest note and stop in one line when nothing moved.

## Rules carried forward

Everything in [[EXECUTION-RULES]] applies. In particular: no second policy
engine, no copied Electron secrets as headless custody, no readiness flag that
bypasses an absent producer, standalone behavior unchanged, a stub or skipped
test is never a pass, one to three authored files and fewer than 500 changed
lines per task measured after `prettier --write`, Node 26 from
`/opt/homebrew/bin`, commit with signing disabled, pushing is the person's.
