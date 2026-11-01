---
type: report
title: Grok tier-1 phase 11 pass two - consumer integration verification
created: 2026-11-01
tags:
  - grok
  - verification
  - phase-11
related:
  - '[[11-static]]'
  - '[[10]]'
---

# GT1-11-07 VERIFY: pass-two consumer integration

- Execution root `/Users/dr3/dev-shit/worktrees/auto-run-feature/grok-cli-integration`, branch `auto-run-feature/grok-cli-integration`, source HEAD
  `3cc958d88e202e25cacb6c0ca7accf8784e16739` (GT1-11-06). Working tree clean apart from untracked `.sloptimize/` folders.
- Node v26.13.0, vitest 4.1.11, Electron 41.10.7, Playwright 1.59.1, macOS 27.2 arm64.
  Installed dependencies only; nothing installed.
- Kind: VERIFY. Authored files: this evidence file and `parity.json` `phase11IntegrationVerify`.
  No Grok binary launched, no account or provider contacted, no production data read. Live calls: 0.
  Images analyzed: 0. Runner and raw results: playbook `Working/gt1-11-07/` (`run.mjs`, `results.json`, `build.mjs`), not committed.

## Deterministic consumer suites

Every command runs from the execution root as
`node node_modules/vitest/vitest.mjs run --reporter=json <suites>` with `CI=1`; the exact suite list per
group is in `parity.json` `phase11IntegrationVerify.groups.<name>.command`.

| Group              | Tasks                                                                 | Surface                                                   | Files | Passed    | Failed | Skipped | Grok cases | Exit |
| ------------------ | --------------------------------------------------------------------- | --------------------------------------------------------- | ----- | --------- | ------ | ------- | ---------- | ---- |
| pass2Consumers     | GT1-11-04, GT1-11-04A, GT1-11-04B                                     | pass-two consumer integration (desktop, runtime, CLI)     | 4     | 640/640   | 0      | 0       | 358/358    | 0    |
| pass2Workflows     | GT1-11-03A, GT1-11-03B, GT1-11-05, GT1-11-05A, GT1-11-05B, GT1-11-05C | pass-two workflow integration (Auto Run, Cue, group chat) | 8     | 479/480   | 0      | 1       | 73/73      | 0    |
| pass2Managed       | GT1-11-06                                                             | pass-two adversarial managed/plugin/account               | 4     | 134/134   | 0      | 0       | 55/55      | 0    |
| recording          | phase 04, GT1-10-13                                                   | recording and turn record                                 | 2     | 62/62     | 0      | 0       | 14/14      | 0    |
| contextTranslation | phase 08                                                              | context and translation                                   | 14    | 450/450   | 0      | 0       | 131/131    | 0    |
| webLite            | GT1-10-03, GT1-10-04                                                  | web / web-desktop / Lite bridge (mocked transport)        | 5     | 683/683   | 0      | 0       | 50/50      | 0    |
| usage              | GT1-10-08, GT1-10-09\*                                                | usage, stats, cost                                        | 9     | 699/699   | 0      | 0       | 459/459    | 0    |
| remote             | phase 09                                                              | remote / SSH (mocked ssh and fs)                          | 6     | 476/490   | 0      | 14      | 48/49      | 0    |
| completeness       | GT1-11-02                                                             | completeness gate rerun                                   | 2     | 147/147   | 0      | 0       | 15/15      | 0    |
| **total**          |                                                                       |                                                           | 54    | 3770/3785 | 0      | 15      | 1204       |      |

Skipped cases, all accounted for:

- `ssh-command-builder.test.ts`, 13 cases in `owned script lifetime`:
  `describe.skipIf(process.platform !== 'linux')`. They run a synthetic provider on real bash and belong to the
  Linux CI leg. One of them is the cancelled Grok transfer case, so the remote group reads 48/49 Grok cases here.
- `batch-processor.test.ts`, 1 case (`should respect maxLoops limit`): skipped before this branch, not Grok.

### Suite membership

- **pass2Consumers**: `cli/services/agent-spawner.test.ts` 301 (Grok 92), `main/process-manager/recordings/turn-recordings.test.ts` 48 (Grok 18), `shared/maestro-lib/grok/acp-turn.test.ts` 102 (Grok 102), `shared/maestro-lib/turns/run-agent-turn.test.ts` 189 (Grok 146)
- **pass2Workflows**: `renderer/hooks/useBatchProcessor.test.ts` 177, `renderer/hooks/batch/useDocumentProcessor.steering.test.ts` 11 (Grok 8), `cli/services/batch-processor.test.ts` 110 (Grok 19), `cli/commands/run-doc.test.ts` 8, `cli/commands/run-playbook.test.ts` 33, `main/cue/cue-process-lifecycle.test.ts` 94 (Grok 29), `main/group-chat/output-parser.test.ts` 35 (Grok 14), `src/shared/maestro-lib/groupchat/__tests__/turn-end.test.ts` 11 (Grok 3)
- **pass2Managed**: `main/enterprise/dispatch.test.ts` 27 (Grok 20), `main/enterprise/spawn-authority.test.ts` 36 (Grok 15), `main/permission-relay/relay-core.test.ts` 35 (Grok 12), `shared/maestro-lib/managed/host-adapter.test.ts` 36 (Grok 8)
- **recording**: `shared/maestro-lib/turns/context.test.ts` 31 (Grok 6), `shared/maestro-lib/turns/record-turn.test.ts` 31 (Grok 8)
- **contextTranslation**: `renderer/services/contextCompaction.test.ts` 15 (Grok 7), `renderer/services/contextGroomer.test.ts` 32 (Grok 8), `renderer/services/providerTranslation.test.ts` 17 (Grok 7), `renderer/utils/contextExtractor.test.ts` 85 (Grok 43), `renderer/utils/contextWindowResolver.test.ts` 27 (Grok 14), `main/provider-translation-service.test.ts` 43 (Grok 8), `main/utils/context-groomer.managed.test.ts` 35 (Grok 5), `main/utils/context-groomer.test.ts` 74 (Grok 21), `shared/maestro-lib/translation-adapters.test.ts` 16 (Grok 4), `shared/maestro-lib/translation-native.test.ts` 15 (Grok 6), `shared/maestro-lib/translation-resources.test.ts` 16 (Grok 2), `shared/maestro-lib/translation-session.test.ts` 34, `shared/maestro-lib/translation-transaction.test.ts` 36 (Grok 5), `main/ipc/handlers/context-groom.test.ts` 5 (Grok 1)
- **webLite**: `renderer/hooks/useRemoteHandlers.test.ts` 99 (Grok 11), `renderer/hooks/useRemoteIntegration.test.ts` 157 (Grok 23), `main/web-server/callbacks/sessionCallbacks.test.ts` 8 (Grok 4), `main/web-server/handlers/messageHandlers.managed.test.ts` 11 (Grok 2), `main/web-server/handlers/messageHandlers.test.ts` 408 (Grok 10)
- **usage**: `renderer/components/UsageDashboard/AgentOverviewCards.test.tsx` 89 (Grok 18), `renderer/components/UsageDashboard/TokenStatsLegend.test.tsx` 19 (Grok 3), `cli/commands/stats.test.ts` 16, `main/cue/cue-stats-query.test.ts` 39 (Grok 16), `main/cue/cue-token-accessor.test.ts` 26 (Grok 5), `main/stats/usage-export.test.ts` 23 (Grok 12), `main/utils/statsCache.test.ts` 25 (Grok 7), `main/ipc/handlers/agentSessions.test.ts` 416 (Grok 383), `main/stats/token-usage/token-usage-accessor.test.ts` 46 (Grok 15)
- **remote**: `renderer/hooks/batch/useBatchProcessor.remote.test.ts` 9 (Grok 4), `renderer/components/Wizard/services/phaseGenerator_ssh.test.ts` 14 (Grok 7), `main/enterprise/remote.test.ts` 24 (Grok 4), `main/utils/remote-fs.test.ts` 305 (Grok 33), `main/utils/ssh-command-builder.test.ts` 98 (Grok 1), `main/utils/ssh-spawn-wrapper.test.ts` 26
- **completeness**: `main/agents/agent-completeness.test.ts` 122 (Grok 15), `main/agents/capabilities.test.ts` 25

### Mocked versus native branches

| Branch                          | How it ran here                                                                                                                                            |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Grok producer                   | synthetic native records and the synthetic ACP peer (`src/__tests__/fixtures/grok-acp-peer.ts`) through real parsers, handlers and turn runners; no binary |
| Remote / SSH                    | `ssh` and remote fs mocked; the Linux-only real-bash cases skipped on macOS                                                                                |
| Windows / cmd.exe               | fake platform in the launch suites (phase 10); no Windows host                                                                                             |
| Web / web-desktop / Lite bridge | mocked WebSocket transport and callbacks; Lite native host below                                                                                           |
| Managed authority               | real desktop sink and ACP request adapter over a labeled synthetic policy / fake endpoint                                                                  |
| Desktop app (Electron)          | real built app in the isolated Playwright and Lite harnesses below; no Grok-specific spec exists                                                           |

## Repaired findings now covered by a passing run

| Finding | Blocker cleared                               | Repair                                | Pinning suites (this run)                                           | Rows     |
| ------- | --------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------- | -------- |
| A11-F07 | `grok-groupchat-turn-end-claude-patterns`     | GT1-11-03A/03B (84be096ef, 5ca81dcee) | turn-end.test.ts (pass2Workflows)                                   | P31, S14 |
| A11-F09 | `grok-acp-transport-loss-reads-as-stop`       | GT1-11-04A/04B (c79a3e969, dc07c81)   | run-agent-turn.test.ts, acp-turn.test.ts (pass2Consumers)           | P10, P38 |
| A11-F11 | `grok-shared-autorun-failed-turn-keeps-ticks` | GT1-11-05A/05C (1863a2ac2, a7bb8ff3a) | batch-processor.test.ts, useBatchProcessor.test.ts (pass2Workflows) | P29, S10 |
| A11-F12 | `grok-room-text-after-terminal-routed`        | GT1-11-05B/05C (99742f718, a7bb8ff3a) | output-parser.test.ts (pass2Workflows)                              | P31, S14 |

Row statuses are unchanged: these are synthetic consumer proofs, not native qualification.

## Native application harness (isolated, native-independent)

Isolation: the Playwright fixture launches `dist/` with `MAESTRO_DATA_DIR` and `MAESTRO_DEMO_DIR` in a fresh
`os.tmpdir()` folder and `MAESTRO_E2E_TEST=true`; the Lite fixture uses a `mkdtemp` data dir and its own
`--user-data-dir`. Production Maestro data was never read.

| Step               | Command                                                                                                                            | Exit   | Result                                                                                                                                          |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Main build         | `npm run build:main`                                                                                                               | 0      | pass (gitignored `dist/`, no tracked file changed)                                                                                              |
| Renderer build     | `npm run build:renderer`                                                                                                           | 0      | pass                                                                                                                                            |
| E2E seeded specs   | `node node_modules/@playwright/test/cli.js test e2e/browser-tab.spec.ts e2e/concerto-html.spec.ts --reporter=line --retries=0`     | 1      | concerto-html 2 passed; browser-tab 2 failed (`browser:pageAction`: "Registered host browser tab is unavailable", and a 15 s predicate timeout) |
| E2E unseeded specs | `node node_modules/@playwright/test/cli.js test e2e/group-chat-load-demo.spec.ts e2e/bionify-reading-mode.spec.ts --reporter=line` | 1      | 2 failed after retries: `TypographyChoiceModal` intercepts pointer events                                                                       |
| Lite native        | `node --test src/__tests__/integration/lite-native-ipc.test.cjs` via a process-group runner (SIGKILL at 100 s)                     | killed | **not-run**, `host-display-locked`                                                                                                              |

Attribution: 496 branch commits since the merge base `0a56e0fa`; none touches `e2e/`, `playwright.config.ts`,
`src/main/browser`, the onboarding host, `TypographyChoiceModal`, `src/main/lite` or `src/lite` (the only
`src/__tests__/integration` hit is the GT1-09-12A mega-maestro unit suite). The e2e failures are:

1. Base-harness drift: `bionify-reading-mode` and `group-chat-load-demo` do not seed
   `typographyPromptSeen`/`themePromptSeen`/`updatesPromptSeen`/`agentPowersPromptSeen` the way
   `browser-tab` and `concerto-html` do, so the first-run modal covers the window. Not a Grok defect; left to the
   upstream harness owner.
2. Host: the browser-tab webview host is unavailable on this locked macOS session
   (`CGSSessionScreenIsLocked = true`). Recorded, not attributed.
3. Lite native: six `NATIVE_CASE` lines, then `remote.capturePage()` at `lite-native-entry.cjs:634` throws
   "Current display surface not available for capture". Identical to GT1-10-05. Needs an unlocked interactive
   session or a CI desktop leg.

## Finding A11-F13 and the bounded repair

No Playwright spec in the isolated application harness seeds or drives a Grok agent, so the desktop UI surfaces (Left Bar entry, provider label, composer model/effort controls, refusal copy) have unit/component evidence only. Separately, two existing specs (bionify-reading-mode, group-chat-load-demo) do not seed the onboarding flags and time out behind TypographyChoiceModal; that is base-harness drift (no branch commit touches e2e, onboarding or the modal), not a Grok defect.

Repair task **GT1-11-07A** (TEST) was inserted after this task: one seeded Grok case in an existing Playwright spec,
with provider processes disabled, proving the isolated app renders the Grok agent and its provider-specific
controls and spawns nothing.

## Matrix surfaces after pass two

| Surface                                                               | Consumer-level evidence                                                | Native                                      |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------- |
| Desktop process path (parser, StdoutHandler, ExitHandler, recordings) | pass2Consumers, recording                                              | not-run (no binary)                         |
| Runtime / library turns, ACP route, peer loss                         | pass2Consumers                                                         | not-run                                     |
| CLI spawner, playbooks, run-doc                                       | pass2Consumers, pass2Workflows                                         | not-run                                     |
| Auto Run (desktop and shared engines), Cue lifecycle, group chat      | pass2Workflows                                                         | not-run                                     |
| Managed sink, ACP permission wire, endpoint offline/stale             | pass2Managed                                                           | not-run                                     |
| Context transfer, grooming, translation                               | contextTranslation                                                     | not-run                                     |
| Web / web-desktop bridge                                              | webLite                                                                | Lite native not-run (`host-display-locked`) |
| Usage, stats, cost, export                                            | usage                                                                  | not-run                                     |
| Remote / SSH                                                          | remote (mocked)                                                        | not-run; Linux-only cases on CI             |
| Completeness gate                                                     | completeness                                                           | n/a                                         |
| Desktop UI (Electron)                                                 | component suites only; isolated e2e harness has no Grok spec (A11-F13) | GT1-11-07A                                  |

Live Grok over any surface remains GT1-11-08 onward, gated on the contract's isolated credential, target and
budget inputs.
