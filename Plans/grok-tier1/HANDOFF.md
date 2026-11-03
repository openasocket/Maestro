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
  - '[[Plans/grok-tier1/evidence/13]]'
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

| Question                                | Answer | Basis                                                                                                                                                                                                                                                                                  |
| --------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Is the implementation complete?         | **No** | The integration is built end to end on the shared library (below), but several capabilities are refused or withheld by design and 125 rows still name implementation-or-evidence gaps; `implementationComplete: false` in readiness.json.                                              |
| Is deterministic verification complete? | **No** | Repository checks rerun by GT1-13-15 (lint fails on one pre-existing TS2339; unit has 2 environmental failures, an intermittent Cue case and the flaky Grok case GT1-07-04B), and zero acceptance runs exist in the evidence catalog, so no row's static or deterministic lane passes. |
| Is Grok tier-1 certified?               | **No** | `tier1Ready: false`, `outcome: pending-qualification`: no qualified binary, no live authorization, no platform evidence, three phase-11 audits stale.                                                                                                                                  |
| Was Grok promoted from beta?            | **No** | GT1-12-07 withheld promotion; `grok` stays in `BETA_AGENTS` (`src/shared/agentMetadata.ts`).                                                                                                                                                                                           |
| Is delivery complete?                   | **No** | `deliveryComplete` requires `tier1Ready`; P47 and P48 stay incomplete by the contract.                                                                                                                                                                                                 |

Derived status is read from [readiness.json](readiness.json), which
`node scripts/verify-grok-tier1.mjs --write` regenerates from the evidence; the section
[Derived readiness](#derived-readiness) copies its current values. If the two ever
disagree, readiness.json wins and this file is stale.

## Source identity

| Item               | Value                                                                                                                                                                       |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Execution checkout | `/Users/dr3/dev-shit/worktrees/auto-run-feature/grok-cli-integration` (registered worktree agent `404dfe62`)                                                                |
| Branch             | `auto-run-feature/grok-cli-integration`, pushed to `origin` (`openasocket/Maestro`) on 2026-11-03; no merge, no version bump                                                |
| Pull request       | [openasocket/Maestro#1](https://github.com/openasocket/Maestro/pull/1) into `feature/mega-maestro-v1.1.0-rc`, opened 2026-11-03; the first CI run the branch has had        |
| Base               | RC tip `882d658a8cfb8c538d59eae3d8cb041724b9d1f5` merged by GT1-13-14 (merge commit `742004ac8`); it is now the merge-base with `feature/mega-maestro-v1.1.0-rc` (0 behind) |
| Branch commits     | 621 not on the RC tip: 616 playbook commits through GT1-13-15, four PR-preparation commits (`997b92fa3`, `b2027b5e5`, `b490f90b2`, `992d8c5fa`) and this handoff update     |
| Diff vs RC tip     | 651 files (584 under `src/`, 297 of them tests; 48 under `Plans/grok-tier1`), +256,569 / -5,729 lines at `992d8c5fa`; most added lines are JSON evidence and fixtures       |

Reproduce: `git diff --stat 882d658a8..auto-run-feature/grok-cli-integration`.

### Only intended files

GT1-12-09 checked the local diff. Every changed path is Grok integration source, its tests,
the qualification harness and validator, the three provider docs, the user docs, or plan
evidence, with one exception that was removed: goal-mode checkpoint `6d574a72f` had
committed 58 `.sloptimize/output_cache` files (11 of them under `src/`, which also entered
the validator's behavioral fingerprint). Commit `cf6981095` untracks them with
`git rm --cached`; the files remain on disk as the tool left them. No unrelated work was
discarded; the primary `feature/mega-maestro-v1.1.0-rc` checkout was not touched.

## Changed modules

| Area                               | What changed                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/shared/maestro-lib/grok/`     | New: `route.ts` (negotiated selector), `acp-protocol.ts`, `acp-client.ts`, `acp-session.ts`, `acp-events.ts`, `acp-requests.ts`, `acp-turn.ts` (about 4,200 lines)                                                                                                                                                                                                                                                                                                   |
| `src/shared/maestro-lib/protocol/` | New `rpc-requests.ts`: request correlation extracted for ACP and Codex                                                                                                                                                                                                                                                                                                                                                                                               |
| `src/shared/maestro-lib/` (other)  | runtime, streaming (structured terminal facts, usage), translation (Grok adapter), groupchat, launch, turns, run, agents, parsers, control, providers (`AGENT_CAPABILITIES.grok`, `GROK_CAPABILITY_EVIDENCE`, `grok-acp` route)                                                                                                                                                                                                                                      |
| `src/main/`                        | `process-manager/spawners/GrokAcpSpawner.ts`, `storage/grok-session-storage.ts`, IPC handlers, Cue executors, agents (detector, path prober), permission relay, group chat, stats                                                                                                                                                                                                                                                                                    |
| `src/renderer/`                    | Composer and settings controls, refusal copy, onboarding and wizard callers, resume, services and stores                                                                                                                                                                                                                                                                                                                                                             |
| `src/cli/`                         | Agent spawner and command wiring (`create-agent --type grok`); `group-chat start --moderator grok` refused before spawn (GT1-13-08)                                                                                                                                                                                                                                                                                                                                  |
| Phase 13 (code-audit gaps)         | `capabilities.ts` (Standard declared, `GROK_CAPABILITY_EVIDENCE.flagDecisions`), `providers/definitions.ts` (`GROK_COMPAT_ISOLATION_ENV_VARS`), `providers/grok-flag-ledger.ts`, `main/agents/detector.ts` (models cache), `main/agents/grok-inspect-probe.ts`, `storage/grok-session-storage.ts` (`prompt_context.json`), `renderer/utils/contextUsage.ts`, `GroupChatModal.tsx`, `handle-spawn.ts` (SSH Standard refusal), `scripts/refresh-grok-help-fixture.mjs` |
| `src/shared/` (top level)          | Account and auth resolution (`agentAccountDir.ts`, `providerAuthIdentity.ts`, `providerProfiles.ts`), error patterns, retry classification, usage ledger, `grokSpawnSelection.ts`                                                                                                                                                                                                                                                                                    |
| `scripts/`                         | `grok-qualification.mjs` + `grok-qualification/` (bounded live harness, zero budget by default), `verify-grok-tier1.mjs` (readiness validator)                                                                                                                                                                                                                                                                                                                       |
| Tests                              | 286 test files under `src/__tests__/`, colocated suites and `e2e/grok-agent.spec.ts` (validator: `src/__tests__/scripts/verify-grok-tier1.test.ts`, 37 cases)                                                                                                                                                                                                                                                                                                        |
| Docs                               | `PROVIDER-SUPPORT.md`, `CLAUDE-AGENTS.md`, `docs/agent-guides/AGENT-INFRA.md`, `docs/provider-notes.md`, `docs/installation.md`, `docs/cli-reference.md` (Grok hunks only)                                                                                                                                                                                                                                                                                           |
| Plans                              | `Plans/grok-tier1/` run-state, parity, readiness, DESIGN, evidence 01-13, this handoff                                                                                                                                                                                                                                                                                                                                                                               |

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
- **Standard permission mode** is declared (GT1-13-01): the composer offers it for a local
  Grok tab and the turn runs on `acp-stdio`; a Standard turn on an SSH remote is refused
  in `handle-spawn` before any probe (`acp-remote-route`). Ask-back questions surface as a
  visible gap with no answer channel.
- **Refused or withheld:** images on every route, ACP over SSH, custom argv on ACP,
  steering, group chat moderation (the modal no longer offers grok as moderator, the CLI
  refuses before spawn), additional directories, project memory (native memory facts are
  read as metadata only), slash commands as a capability, context merge, append system
  prompt (`--rules`, `--json-schema`, `--system-prompt-override` decided unused, pinned by
  the 1.0.70 help fixture and flag ledger). `--sandbox` is left unwired (session-fixed
  profile). Managed read-only refuses Grok.
- **Inherited vendor configuration.** Every launch sets the ten
  `GROK_{CLAUDE,CURSOR}_*_ENABLED=false` compat switches, so Claude and Cursor skills,
  hooks, rules, agents and MCP servers stay off. Grok 1.0.70 still reads
  `~/.claude/settings*.json` permission rules with no native switch; the owned
  `grok inspect` probe that would refuse read-only on it answers `probe-refused` until
  Grok probes are admitted.
- **Accounts.** Per-agent `GROK_HOME` scopes sessions and settings; credentials come from
  `grok login` / `login --device-auth`, `XAI_API_KEY`, `GROK_AUTH_PATH` or `GROK_AUTH`.
  `GROK_HOME` is not a billing identity. Cost is reported when the provider reports it and
  stays unknown otherwise; no plan quota tracking.
- **Native history.** `GrokSessionStorage` reads `$GROK_HOME/sessions` (including each
  session's `prompt_context.json` memory facts); resume uses `--resume <id>` bound to the
  tab's confirmed native session.
- **Discovery.** Models and efforts from an owned ACP session's observed state; empty
  defaults. Context window from the account's `$GROK_HOME/models_cache.json` for the tab's
  model, ACP observation first; 0 (unknown) when no entry matches.

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
- Repository check receipt: [evidence/12-checks.json](evidence/12-checks.json) (rerun by
  GT1-13-15 at `742004ac8`); reports [[Plans/grok-tier1/evidence/12]] and
  [[Plans/grok-tier1/evidence/13]] (phase 13: the code-audit findings, each task's commit,
  the scoped static and deterministic reruns and the `grok inspect` before and after).
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

| Gate(s)                                                                                                                          | Cause                                                                                                                                                                                                                                                                                                                                                 | Smallest external input needed                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version:qualification-absent`, `version:binary-unqualified`, `version:binary-source-unknown`, `version:supported-range-unknown` | No exact Grok binary has been executed and recorded                                                                                                                                                                                                                                                                                                   | One installed `@xai-official/grok` release per platform with its executable sha256, the binary-to-source relationship, a declared supported range and an expiry for the qualification                                                                                            |
| `external:qualified-binary-and-platforms-missing`                                                                                | None of the six platform targets has a run                                                                                                                                                                                                                                                                                                            | Access to hosts (or CI runners) for each of the six targets, plus one permitted SSH target for the remote cases                                                                                                                                                                  |
| `live:authorization-absent`, `external:live-authorization-absent`                                                                | `run-state.json` `liveBoundary` is disabled with a zero budget                                                                                                                                                                                                                                                                                        | A disposable xAI test account reference, an isolated workspace, allowed endpoints, a finite USD budget with a provider-enforced spend cap, and turn and wall-clock limits recorded in run-state                                                                                  |
| `external:grok-readonly-cli-enforcement-unqualified`                                                                             | Read-only rests on plan + deny observed on 1.0.5; containment never proven                                                                                                                                                                                                                                                                            | A native policy run on the qualified binary showing zero write, shell and network effects under Read-Only (the GT1-11 policy cases)                                                                                                                                              |
| `regression:lint:fail`, `regression:baseline-failure-unwaived:lint`, `regression:baseline-failure-unwaived:tsc-lint`             | `src/main/plugins/plugin-host-handlers.ts(1196,76)` TS2339, inherited from the RC base, not this branch                                                                                                                                                                                                                                               | A fix on the RC base (`dispatcher` on `RequestInit`) merged into this branch; not waivable                                                                                                                                                                                       |
| `regression:unit:fail`                                                                                                           | 4 failures in the GT1-13-15 run: `remote-worktree-paths` x2 (environmental, commit signing on this host; also failing at the RC base), the intermittent Cue file-watcher case (19/19 alone), and the flaky Grok case GT1-07-04B in `process-manager.test.ts` (fails 1 of 139 in 2 of 3 solo runs; a test-timing flake, not a phase-13 product change) | A run on a host without forced commit signing (or the fixture passing `-c commit.gpgsign=false`), plus a deterministic wait in the GT1-07-04B case before its assertion                                                                                                          |
| `audit:phase11StaticVerify:*`, `audit:phase11IntegrationVerify:*`, `audit:phase11Audit:*`                                        | All three phase-11 checks predate the phase-13 product changes and the base merge (`742004ac8`); GT1-13-15 reran only the rows phase 13 touched, so the sections stay stale; findings A11-F07, A11-F13, A11-F33, A11-F36, A11-F38, A11-F39 are not recorded as settled                                                                                | Rerun the three checks at the current source and record each finding as settled (F07 and F13 already have repairs, GT1-11-03A and GT1-11-07A, which added `e2e/grok-agent.spec.ts`; that spec has not been run here because the Electron native ABI is unqualified on this host) |

Phase 13 audit rows (not global gates; they live on the rows):

| Row(s)                                                     | State after phase 13                                                                                                                                                                                                                       | Still needs                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `C-supportsStandardPermissionMode`, `P34`                  | **Docs disagreement closed.** The flag is declared, the composer, tooltip, `CLAUDE-AGENTS.md`, `PROVIDER-SUPPORT.md` and provider notes agree that Standard runs locally over `grok agent stdio`; SSH Standard is refused before any probe | Native consent proof on the qualified binary; positive ask-back (`acp-question-negotiation:P34`) stays unsupported, yet `docs/provider-notes.md` ("ask-back questions only work in Standard mode") and `CLAUDE-AGENTS.md` ("ask-back ... need ACP") still read as if it works there: a residual wording fix, found by GT1-13-15, not made in this VERIFY |
| `C-supportsReadOnlyMode` (sandbox)                         | `--sandbox read-only` identified offline and left unwired: the profile is fixed per session and a resume with another profile is refused                                                                                                   | A native policy run on the qualified binary deciding whether a session-fixed sandbox can carry Read-Only without breaking resume                                                                                                                                                                                                                         |
| `C-supportsReadOnlyMode` (isolation)                       | Wired: the ten compat switches on every launch (re-probed at `742004ac8`: 10 of 13 cells off, 12 Claude skills disabled). Not wired: Claude permission files (no native switch in 1.0.70); `probeGrokInspect` answers `probe-refused`      | A Grok release with a switch for `~/.claude/settings*.json`, or `runProviderProbe` admitting Grok probes (proven probe lifetime) so the refusal runs                                                                                                                                                                                                     |
| `C-usesCombinedContextWindow`                              | Account `models_cache.json` window per model, fixture-pinned                                                                                                                                                                               | Live confirmation against the qualified binary's cache                                                                                                                                                                                                                                                                                                   |
| `C-supportsAppendSystemPrompt`, group chat, project memory | Decided and pinned (help fixture F284-F289, moderator refusal, memory metadata read-only)                                                                                                                                                  | Acceptance runs only                                                                                                                                                                                                                                                                                                                                     |

Per-row blockers: 297 blocker ids over the 134 rows. The largest classes (counts from
GT1-12-06): every row lacks an acceptance-run catalog entry (`gap:*`, 134), 60 rows wait
on ACP harness legs, 38 on the paid executor, 24 on ACP turn consumers. Classes and counts
are in `parity.json` `phase12Readiness.blockerClasses`; the full list is
`readiness.json` `blockerIds`. Closing the global gates above is necessary but not
sufficient: each row then needs acceptance runs (command, exit 0, environment, hash,
assertion, current source) for every applicable lane.

## Derived readiness

Copied from [readiness.json](readiness.json) as regenerated by GT1-13-15
(`node scripts/verify-grok-tier1.mjs --write`, exit 0), after phase 13's source changes and
the base merge moved the behavioral fingerprint and the repository checks were rerun at
it. The verdict is unchanged from GT1-12-10: the same 22 global gates and the same 297
blocker ids; the fingerprint is the one the repository check receipt names
(`742004ac8`), so the evidence is current.

| Field                    | Value                                                                               |
| ------------------------ | ----------------------------------------------------------------------------------- |
| `sourceCommit`           | `742004ac84290cea9810c475f7beb446dd7e3469`                                          |
| `behavioralFingerprint`  | `f382dbf718324ec6667e1eeeae74be11831dbc905659155de53dbe1c24abc847`                  |
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

Both rows read `implementation: implemented` in parity.json; after the base merge made
`phase12-delivery` stale, GT1-13-15 re-pointed their implementation evidence at
`phase13-delivery` (this refreshed report at the current fingerprint; the decision is
unchanged and `grok` is still in `BETA_AGENTS`). Neither is certified. **Final outcome: not certified**; the required
external evidence (the global gates above) is absent, and closing it means regenerating
readiness.json, rerunning GT1-12-07 and GT1-12-08, and refreshing this file.

Repository check receipt behind the `regression:*` gates
([evidence/12-checks.json](evidence/12-checks.json), rerun by GT1-13-15 at `742004ac8`,
darwin-arm64, Node 26.13.0, TMPDIR under `/tmp`, `GROK_`/`XAI_` stripped, 0 live calls):
validator 37/37, `lint:eslint`, `docs:verify` and all five builds pass; `npm run lint`
exit 2 on the pre-existing TS2339 only (the main and CLI tsc legs pass on their own);
unit 2,603 files, 64,354 tests, 64,241 passed, 4 failed (`remote-worktree-paths` x2,
environmental, also failing at the RC base; the intermittent Cue file-watcher case; the
flaky Grok case GT1-07-04B), 109 skipped; integration 1 failure
(`group-chat.integration`, also failing at the RC base); e2e not run (Electron native ABI
unqualified on this host). Nothing is waived.
