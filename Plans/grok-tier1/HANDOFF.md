---
type: report
title: Grok tier-1 handoff - implementation, verification and certification status
created: 2026-11-02
tags:
  - maestro
  - grok
  - handoff
  - release-readiness
related:
  - '[[DESIGN]]'
  - '[[Plans/grok-tier1/evidence/12]]'
  - '[[Plans/grok-tier1/evidence/11]]'
  - '[[Plans/grok-tier1/evidence/11-static]]'
  - '[[Plans/grok-tier1/evidence/11-integration]]'
---

# Grok tier-1 handoff

This is the reviewer's entry point for the Grok tier-1 work. It is written to be read
without any chat context. **Outcome: not certified.** Grok CLI stays a beta provider; the
playbook's evidence report is complete, tier-1 certification is not.

## Status at a glance

| Question                                | Answer | Basis                                                                                                                                                                                                                                     |
| --------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Is the implementation complete?         | **No** | The integration is built end to end on the shared library (below), but several capabilities are refused or withheld by design and 125 rows still name implementation-or-evidence gaps; `implementationComplete: false` in readiness.json. |
| Is deterministic verification complete? | **No** | Repository checks run (lint fails on one pre-existing TS2339; unit has environmental and flaky failures, none from this branch), but zero acceptance runs exist in the evidence catalog, so no row's static or deterministic lane passes. |
| Is Grok tier-1 certified?               | **No** | `tier1Ready: false`, `outcome: pending-qualification`: no qualified binary, no live authorization, no platform evidence, three phase-11 audits stale.                                                                                     |
| Was Grok promoted from beta?            | **No** | GT1-12-07 withheld promotion; `grok` stays in `BETA_AGENTS` (`src/shared/agentMetadata.ts`).                                                                                                                                              |
| Is delivery complete?                   | **No** | `deliveryComplete` requires `tier1Ready`; P47 and P48 stay incomplete by the contract.                                                                                                                                                    |

Derived status is read from [readiness.json](readiness.json), which
`node scripts/verify-grok-tier1.mjs --write` regenerates from the evidence; the section
[Derived readiness](#derived-readiness) copies its current values. If the two ever
disagree, readiness.json wins and this file is stale.

## Source identity

| Item               | Value                                                                                                                                                                |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Execution checkout | `/Users/dr3/dev-shit/worktrees/auto-run-feature/grok-cli-integration` (registered worktree agent `404dfe62`)                                                         |
| Branch             | `auto-run-feature/grok-cli-integration` (local only: never pushed, no PR, no merge, no version bump)                                                                 |
| Base               | merge-base with `feature/mega-maestro-v1.1.0-rc` is `0a56e0fa1c18e25a8e8a70dfc37378ae7d076b4f`; the RC tip `882d658a8` is 10 commits ahead of it and not merged here |
| Branch commits     | 590 since the merge-base (HEAD is recorded in [Derived readiness](#derived-readiness))                                                                               |
| Diff vs merge-base | 624 files, +251,626 / -5,618 lines (after the cache untrack below); `Plans/grok-tier1` is about 106k of the added lines (JSON evidence)                              |

Reproduce: `git diff --stat 0a56e0fa1..auto-run-feature/grok-cli-integration`.

### Only intended files

GT1-12-09 checked the local diff. Every changed path is Grok integration source, its tests,
the qualification harness and validator, the three provider docs, the user docs, or plan
evidence, with one exception that was removed: goal-mode checkpoint `6d574a72f` had
committed 58 `.sloptimize/output_cache` files (11 of them under `src/`, which also entered
the validator's behavioral fingerprint). Commit `cf6981095` untracks them with
`git rm --cached`; the files remain on disk as the tool left them. No unrelated work was
discarded; the primary `feature/mega-maestro-v1.1.0-rc` checkout was not touched.

## Changed modules

| Area                               | What changed                                                                                                                                                                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/shared/maestro-lib/grok/`     | New: `route.ts` (negotiated selector), `acp-protocol.ts`, `acp-client.ts`, `acp-session.ts`, `acp-events.ts`, `acp-requests.ts`, `acp-turn.ts` (about 4,200 lines)                                                              |
| `src/shared/maestro-lib/protocol/` | New `rpc-requests.ts`: request correlation extracted for ACP and Codex                                                                                                                                                          |
| `src/shared/maestro-lib/` (other)  | runtime, streaming (structured terminal facts, usage), translation (Grok adapter), groupchat, launch, turns, run, agents, parsers, control, providers (`AGENT_CAPABILITIES.grok`, `GROK_CAPABILITY_EVIDENCE`, `grok-acp` route) |
| `src/main/`                        | `process-manager/spawners/GrokAcpSpawner.ts`, `storage/grok-session-storage.ts`, IPC handlers, Cue executors, agents (detector, path prober), permission relay, group chat, stats                                               |
| `src/renderer/`                    | Composer and settings controls, refusal copy, onboarding and wizard callers, resume, services and stores                                                                                                                        |
| `src/cli/`                         | Agent spawner and command wiring (`create-agent --type grok`)                                                                                                                                                                   |
| `src/shared/` (top level)          | Account and auth resolution (`agentAccountDir.ts`, `providerAuthIdentity.ts`, `providerProfiles.ts`), error patterns, retry classification, usage ledger, `grokSpawnSelection.ts`                                               |
| `scripts/`                         | `grok-qualification.mjs` + `grok-qualification/` (bounded live harness, zero budget by default), `verify-grok-tier1.mjs` (readiness validator)                                                                                  |
| Tests                              | 286 test files under `src/__tests__/`, colocated suites and `e2e/grok-agent.spec.ts` (validator: `src/__tests__/scripts/verify-grok-tier1.test.ts`, 37 cases)                                                                   |
| Docs                               | `PROVIDER-SUPPORT.md`, `CLAUDE-AGENTS.md`, `docs/agent-guides/AGENT-INFRA.md`, `docs/provider-notes.md`, `docs/installation.md`, `docs/cli-reference.md` (Grok hunks only)                                                      |
| Plans                              | `Plans/grok-tier1/` run-state, parity, readiness, DESIGN, evidence 01-12, this handoff                                                                                                                                          |

## What the built integration does

Facts below are implemented and covered by deterministic suites in this branch; none is
qualified against a real Grok binary.

- **Provider identity.** Existing `grok` provider, displayed as Grok CLI, executable `grok`
  from the official `@xai-official/grok` package. The community `grok-cli` package is not
  supported. Candidate version 1.0.70; `qualifiedVersions` is empty.
- **Two routes, one selector.** `selectGrokRoute` (`src/shared/maestro-lib/grok/route.ts`)
  runs Full Access and Read-Only turns on `native-headless` (`grok --output-format
streaming-json` with an owned `--prompt-file`) and Standard permission turns on
  `acp-stdio` (`grok agent stdio`), where permission requests reach the existing consent
  and effect ports. A missing requirement is a named refusal (`GrokRouteGap`), never a
  silent fallback.
- **Refused or withheld:** images on every route, ACP over SSH, custom argv on ACP,
  steering, group chat moderation, additional directories, project memory, slash commands
  as a capability, context merge, append system prompt. Managed read-only refuses Grok.
- **Accounts.** Per-agent `GROK_HOME` scopes sessions and settings; credentials come from
  `grok login` / `login --device-auth`, `XAI_API_KEY`, `GROK_AUTH_PATH` or `GROK_AUTH`.
  `GROK_HOME` is not a billing identity. Cost is reported when the provider reports it and
  stays unknown otherwise; no plan quota tracking.
- **Native history.** `GrokSessionStorage` reads `$GROK_HOME/sessions`; resume uses
  `--resume <id>` bound to the tab's confirmed native session.
- **Discovery.** Models and efforts from an owned ACP session's observed state; empty
  defaults; context window 0 (unknown).

## Exact CLI and platform support

| Dimension      | Supported (qualified) | Candidate, not qualified                                                                             |
| -------------- | --------------------- | ---------------------------------------------------------------------------------------------------- |
| Grok version   | none                  | `@xai-official/grok` 1.0.70 (registry integrity recorded; binary sha256 and source relation unknown) |
| Platforms      | none                  | darwin-arm64, darwin-x64, linux-arm64, linux-x64, win32-x64, win32-arm64 (all `not-run`)             |
| Routes         | none                  | native-headless local and SSH; acp-stdio local only                                                  |
| Legacy parsers | fixtures only         | 0.2.93, 1.0.5, 1.0.41 observations behind several capability comments                                |

## Evidence and audits

- Requirement matrix: [parity.json](parity.json) (134 required rows: P01-P48 plus 86
  capability, registry, surface and metadata rows).
- Derived readiness: [readiness.json](readiness.json); validator `scripts/verify-grok-tier1.mjs`.
- Repository check receipt: [evidence/12-checks.json](evidence/12-checks.json); report
  [[Plans/grok-tier1/evidence/12]].
- The three phase-11 checks:
  1. Static registry and contract coverage: [[Plans/grok-tier1/evidence/11-static]]
     (GT1-11-03, source `d84638bfc`).
  2. Deterministic integration through real consumers: [[Plans/grok-tier1/evidence/11-integration]]
     (GT1-11-07, source `3cc958d88`).
  3. Independent audit: [[Plans/grok-tier1/evidence/11]] (GT1-11-14, source `e2d5c7f86`).
     Native qualification receipts (all `not-run`): `evidence/11-native*.md`, `11-policy-native.md`,
     `11-translation-native.md`.
- Design: [[DESIGN]], including the GT1-12-09 reconciliation section that records where the
  built code diverged from the phase-01 design.

## Commands

| Purpose                    | Command                                                                                                                                                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Validate readiness         | `node scripts/verify-grok-tier1.mjs --json`                                                                                                                                                                                                |
| Regenerate readiness       | `node scripts/verify-grok-tier1.mjs --write`                                                                                                                                                                                               |
| Validator tests            | `node node_modules/vitest/vitest.mjs run src/__tests__/scripts/verify-grok-tier1.test.ts`                                                                                                                                                  |
| Plan live cases (no calls) | `node scripts/grok-qualification.mjs --json --no-write`                                                                                                                                                                                    |
| Repository checks          | `npm run lint`, `npm run lint:eslint`, `npm run docs:verify`, `npm test`, `npm run test:integration`, `npm run build:main`, `build:renderer`, `build:web-desktop`, `build:cli`, `build:maestro-lib` (run with TMPDIR outside the checkout) |

## Unresolved blockers and the smallest inputs that close them

Global gates from readiness.json. Each blocks `tier1Ready` on its own.

| Gate(s)                                                                                                                          | Cause                                                                                                                                                                                                                                                  | Smallest external input needed                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version:qualification-absent`, `version:binary-unqualified`, `version:binary-source-unknown`, `version:supported-range-unknown` | No exact Grok binary has been executed and recorded                                                                                                                                                                                                    | One installed `@xai-official/grok` release per platform with its executable sha256, the binary-to-source relationship, a declared supported range and an expiry for the qualification                                                                                            |
| `external:qualified-binary-and-platforms-missing`                                                                                | None of the six platform targets has a run                                                                                                                                                                                                             | Access to hosts (or CI runners) for each of the six targets, plus one permitted SSH target for the remote cases                                                                                                                                                                  |
| `live:authorization-absent`, `external:live-authorization-absent`                                                                | `run-state.json` `liveBoundary` is disabled with a zero budget                                                                                                                                                                                         | A disposable xAI test account reference, an isolated workspace, allowed endpoints, a finite USD budget with a provider-enforced spend cap, and turn and wall-clock limits recorded in run-state                                                                                  |
| `external:grok-readonly-cli-enforcement-unqualified`                                                                             | Read-only rests on plan + deny observed on 1.0.5; containment never proven                                                                                                                                                                             | A native policy run on the qualified binary showing zero write, shell and network effects under Read-Only (the GT1-11 policy cases)                                                                                                                                              |
| `regression:lint:fail`, `regression:baseline-failure-unwaived:lint`, `regression:baseline-failure-unwaived:tsc-lint`             | `src/main/plugins/plugin-host-handlers.ts(1196,76)` TS2339, inherited from the RC base, not this branch                                                                                                                                                | A fix on the RC base (`dispatcher` on `RequestInit`) merged into this branch; not waivable                                                                                                                                                                                       |
| `regression:unit:fail`                                                                                                           | The 2 remaining unit failures are not branch regressions: `remote-worktree-paths` (environmental, commit signing on this host; also failing at the RC base). An intermittent Cue file-watcher case failed in the GT1-12-06A run and passed in this one | A run on a host without forced commit signing, or the fixture passing `-c commit.gpgsign=false` (a test-fixture fix outside this playbook's scope)                                                                                                                               |
| `audit:phase11StaticVerify:*`, `audit:phase11IntegrationVerify:*`, `audit:phase11Audit:*`                                        | All three phase-11 checks predate the last product change (`d83f2967c`); findings A11-F07, A11-F13, A11-F33, A11-F36, A11-F38, A11-F39 are not recorded as settled                                                                                     | Rerun the three checks at the current source and record each finding as settled (F07 and F13 already have repairs, GT1-11-03A and GT1-11-07A, which added `e2e/grok-agent.spec.ts`; that spec has not been run here because the Electron native ABI is unqualified on this host) |

Per-row blockers: 297 blocker ids over the 134 rows. The largest classes (counts from
GT1-12-06): every row lacks an acceptance-run catalog entry (`gap:*`, 134), 60 rows wait
on ACP harness legs, 38 on the paid executor, 24 on ACP turn consumers. Classes and counts
are in `parity.json` `phase12Readiness.blockerClasses`; the full list is
`readiness.json` `blockerIds`. Closing the global gates above is necessary but not
sufficient: each row then needs acceptance runs (command, exit 0, environment, hash,
assertion, current source) for every applicable lane.

## Derived readiness

Copied from [readiness.json](readiness.json) as regenerated by GT1-12-10
(`node scripts/verify-grok-tier1.mjs --write`, exit 0), after it reconciled the delivery
rows P47 and P48. The verdict is unchanged from GT1-12-09: only `sourceCommit` moved, and
the behavioral fingerprint is the one the repository check receipt names, so the evidence
is current.

| Field                    | Value                                                                               |
| ------------------------ | ----------------------------------------------------------------------------------- |
| `sourceCommit`           | `1f5c23ee3490551502382e2113a37a097f6a5b93`                                          |
| `behavioralFingerprint`  | `ffacd32a8547de4d94530e6f606519bc75b4daca358134679f6a27fa068a2928`                  |
| `tier1Ready`             | false                                                                               |
| `deliveryComplete`       | false                                                                               |
| `implementationComplete` | false                                                                               |
| `testComplete`           | false                                                                               |
| `liveComplete`           | false                                                                               |
| `outcome`                | `pending-qualification`                                                             |
| Rows                     | 134 required: 132 qualification (all incomplete), 2 delivery (P47, P48, incomplete) |
| Structural errors        | 0                                                                                   |
| Global gates             | 22 (table above)                                                                    |
| Per-row blocker ids      | 297                                                                                 |

### Delivery rows (P47, P48)

| Row | Decision                                                                                                                        | Why the row is still incomplete                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| P47 | Promotion withheld (GT1-12-07, verified by GT1-12-08 and GT1-12-10): `grok` stays in `BETA_AGENTS` and every doc labels it beta | Its static and deterministic lanes have no acceptance run, and a promotion can only follow `tier1Ready: true` (blocker `gap:P47`) |
| P48 | This report delivered (GT1-12-09) and checked against readiness.json by GT1-12-10                                               | Its lanes have no acceptance run, and `deliveryComplete` requires `tier1Ready` by contract (blocker `gap:P48`)                    |

Both rows now read `implementation: implemented` in parity.json (evidence
`phase12-delivery`, section `phase12Delivery`): the decision and the report exist at the
current fingerprint. Neither is certified. **Final outcome: not certified**; the required
external evidence (the global gates above) is absent, and closing it means regenerating
readiness.json, rerunning GT1-12-07 and GT1-12-08, and refreshing this file.

Repository check receipt behind the `regression:*` gates
([evidence/12-checks.json](evidence/12-checks.json), rerun by GT1-12-09 at `cf6981095`,
darwin-arm64, Node 26.13.0, TMPDIR under `/tmp`, `GROK_`/`XAI_` stripped, 0 live calls):
validator 37/37, `lint:eslint`, `docs:verify` and all five builds pass; `npm run lint`
exit 2 on the pre-existing TS2339 only (the main and CLI tsc legs pass on their own);
unit 2,601 files, 64,286 tests, 64,175 passed, 2 failed (`remote-worktree-paths`,
environmental, also failing at the RC base), 109 skipped; integration 1 failure
(`group-chat.integration`, also failing at the RC base); e2e not run (Electron native ABI
unqualified on this host). Nothing is waived.
