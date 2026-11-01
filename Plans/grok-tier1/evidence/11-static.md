---
type: report
title: Grok phase 11 pass one, static registry and contract coverage
created: 2026-11-01
tags: [grok, tier1, acceptance, static, audit, evidence]
related:
  - '[[CONTRACT]]'
  - '[[REFERENCE]]'
  - '[[GROK-TIER1-11]]'
  - '[[01]]'
  - '[[10]]'
---

# Phase 11 pass one: static registry and contract coverage

Contract: [[CONTRACT]]. Reference: [[REFERENCE]]. Phase document: [[GROK-TIER1-11]]. Prior
evidence: [[01]] (branch audit B01-B48) through [[10]] (phase 10 reconciliation).

## GT1-11-01 AUDIT: acceptance pass one from current source

- Source revision: `808b926082dd43ad2e1dc10be406af41877fa211` on
  `auto-run-feature/grok-cli-integration`, execution root
  `/Users/dr3/dev-shit/worktrees/auto-run-feature/grok-cli-integration` (verified with
  `git rev-parse --show-toplevel` and `git branch --show-current`).
- Ancestry: merge base with `feature/mega-maestro-v1.1.0-rc` is `0a56e0fa1c18`; the source
  is 477 commits ahead of it and the RC branch has moved 10 commits past it (head
  `882d658a8`, integration-completion coordination). The audit reads this checkout only;
  nothing from the RC head is claimed.
- Method: an independent read-only reviewer (a separate Explore agent given only the goal,
  the provider ids and the allowlist families, not this playbook's matrix or the
  implementation author's notes) swept every non-test `src/` branch on `claude-code`,
  `codex` and `antigravity` and every registry family named in the task. The auditor then
  re-read each reported anchor in source, rejected or confirmed it, and separately
  challenged the Grok capability block (`src/shared/maestro-lib/providers/capabilities.ts`),
  the Grok definition (`providers/definitions.ts`), the selected-account snapshot rule
  (`src/main/agents/capability-snapshot.ts`) and every consumer of `readOnlyCliEnforced`.
- No test, build or live call was run by this AUDIT; static check commands belong to
  GT1-11-03. Live calls: 0. Images analyzed: 0.

### Registries confirmed handled

Grok is present, by name or through a generic definition/capability lookup, in:
`BETA_AGENTS`, `AGENT_PICKER_META`, `AGENT_LOGIN_COMMANDS` (`src/shared/agentMetadata.ts`);
`DEFAULT_CONTEXT_WINDOWS` (`grok: 0`, unknown on purpose) in `src/shared/agentConstants.ts`;
`SYNOPSIS_PROVIDER_PREFERENCE` (last on purpose) in `src/shared/directorNotesProvider.ts`;
`PROVIDER_PROFILE_CONFIGS` in `src/shared/providerProfiles.ts`; `PROVIDER_ROUTE_ENV_NAMES`
in `src/shared/maestro-lib/launch/env.ts`; `MCP_CONFIG_BY_AGENT` in
`src/shared/plugins/mcp-agent-config.ts`; the coworking `INSTALLERS` map
(`grokInstaller`); the session storage registry (`src/main/storage/index.ts`); the parser
factory; the error pattern registry (`src/shared/agentErrorPatterns.ts`); `EFFORT_LADDERS`
and `TIER_MODELS` (`src/shared/modelTiers.ts`, Grok tier excluded with a reason);
`src/shared/effortRejection.ts`; translation support, registry and service branches;
both token-usage `COVERAGE_BY_AGENT` tables; `StdoutHandler` reasoning-tag and usage
branches; resumable-session origins; global stats (`agentSessions.ts`); detector model and
effort discovery; skills discovery (`grok-skills.ts`); auth identity and feedback account
branches; the CLI type list (derived from `AGENT_IDS`); the wizard and feedback
`buildArgsForAgent` switches; the steer eligibility refusal; renderer display tables.
Claude-only memory folder resolution and the Claude/Codex quota samplers are excluded
with reasons recorded in phase 10 (`grok-native-quota-unavailable`).

### Discoveries

| ID      | Anchor                                                                                                                                                 | Classification                                      | Consequence                                                                                                                                                                                                                                                                                                                                                                    | Rows                                      | Disposition         |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- | ------------------- |
| A11-F01 | `src/shared/authPaths.ts:1-9`, `src/main/ipc/handlers/agents.ts:1813-1826`, `src/renderer/components/shared/AuthPathValueInput.tsx:30-34`              | accidental exclusion (phase 01 B18, never repaired) | `KnownAuthDirs` carries only `claudeConfigDirs` and `codexHomes`; `GROK_HOME` gets a plain text box with no known-account suggestions although Grok has a provider profile config.                                                                                                                                                                                             | REG-PROFILE, P04, S01                     | repair GT1-11-01B   |
| A11-F02 | `src/renderer/services/contextGroomer.ts:72` `AGENT_ARTIFACTS`, `:149` `AGENT_TARGET_NOTES`                                                            | accidental exclusion (phase 01 B21, never repaired) | A Grok source has no artifact scrubbing list and a Grok target gets `No specific notes for this agent.` in the transfer prompt; Claude, Codex, OpenCode and Factory Droid have entries.                                                                                                                                                                                        | S06, P21                                  | repair GT1-11-01A   |
| A11-F03 | `src/shared/maestro-lib/launch/path-prober.ts:356-441` (Windows) and `:526-614` (Unix)                                                                 | accidental exclusion (new)                          | Known install locations list `claude`, `codex`, `agy` and others but not `grok`; discovery of a Grok binary off `PATH` relies on the `which`/`where` fallback alone, unlike the comparators.                                                                                                                                                                                   | P03, REG-DISCOVERY                        | repair GT1-11-01C   |
| A11-F04 | `src/renderer/components/Settings/searchableSettingsEncore.ts:164-175`, `:240-242`                                                                     | stale copy (new, cosmetic)                          | The coworking description and keywords name Claude Code, Codex, OpenCode and Factory Droid, and the synopsis-provider keywords omit Grok, so a Settings search for `grok` finds neither surface Grok participates in.                                                                                                                                                          | S35, S18                                  | repair GT1-11-01D   |
| A11-F05 | `src/shared/maestro-lib/providers/definitions.ts:920` `readOnlyCliEnforced: true` with `readOnlyArgs: ['--permission-mode','plan','--deny','Bash(*)']` | unqualified native-enforcement claim (new)          | The flag admits Grok on read-only-required callers (`planSessionTurn` in `run/session.ts:116`, `tabNaming.ts:280`, `feedbackAccounts.ts:69`, `context-groomer.ts:461`, `agent-args.ts:463`, `env.ts:1112`, CLI `agent-spawner.ts:1463`) on the strength of `grok --help`. No evidence shows plan mode plus `--deny Bash(*)` blocks file writes, MCP, web, subagents and hooks. | C-supportsReadOnlyMode, META-03, S19, S33 | blocker, live-owned |
| A11-F06 | `src/shared/agentMetadata.ts:225-232` `AGENT_AUTOSELECT_ORDER`                                                                                         | intentional (confirmed)                             | Grok is reachable through the alphabetical fallback in `GroupChatModal.tsx:187` but never preferred; META-04 already records the preference as intentional while moderation refuses Grok.                                                                                                                                                                                      | META-04                                   | no change           |

A11-F05 sharpens an existing prose limitation on C-supportsReadOnlyMode ("Grok plan plus
Bash deny is wired but does not establish complete filesystem/network/MCP/child
containment on each OS") into a machine-readable blocker on every row whose callers the
flag admits; the separate `grok-required-no-tools-unsupported` blocker stays as it is.
It is not a locally fixable defect: the read-only mechanism is the native one and
turning the flag off would refuse callers without proof either way. It is bound to the
native negative policy suite (GT1-11-12) and the read-only utility cases (GT1-11-11D) as
blocker `grok-readonly-cli-enforcement-unqualified`; managed routes already refuse every
Grok effect (phase 09).

### Capability flags challenged

| Flag                                                                                                                                                         | Value | Producer / builder                          | Finding                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| supportsReadOnlyMode                                                                                                                                         | true  | `readOnlyArgs`, `readOnlyCliEnforced: true` | builder exists; enforcement claim unqualified (A11-F05)                                                                     |
| supportsContextMerge                                                                                                                                         | true  | shared formatter                            | marked PROVISIONAL in source; existing blocker `grok-context-merge-flag-provisional` stands; target notes missing (A11-F02) |
| supportsWizard                                                                                                                                               | true  | wizard `buildArgsForAgent` `case 'grok'`    | discovery runs `--always-approve`; existing wizard caller blockers stand                                                    |
| supportsImageInput, supportsImageInputOnResume                                                                                                               | true  | `plainPathImagePrompt`                      | path in prompt relies on the model calling `read_file`; existing `grok-image-host-bounds-producer-absent` stands            |
| supportsCostTracking, supportsUsageStats                                                                                                                     | true  | native parser, ACP accumulator              | existing `acp-wire-tick-precision` and `acp-turn-consumers` blockers stand                                                  |
| supportsSlashCommands                                                                                                                                        | false | `grok-skills.ts` discovery exists           | implemented but withheld; candidate snapshot evaluation belongs to GT1-11-08A                                               |
| supportsGroupChatModeration                                                                                                                                  | false | router refuses                              | honest false; `grok-groupchat-moderation-refused` stands                                                                    |
| supportsAppendSystemPrompt, supportsProjectMemory, supportsAdditionalDirectories, supportsStreamJsonInput, supportsPromptViaStdin, usesCombinedContextWindow | false | none qualified                              | honest false with blockers; GT1-11-14A owns any promotion                                                                   |
| models, contextWindow on the snapshot                                                                                                                        | n/a   | `capability-snapshot.ts:194-197`            | Grok catalogs withheld from the provider-keyed snapshot (selected-account rule); consistent with REG-MODEL blockers         |

Every row of the reference union (P01-P48, C-\*, REG-\*, S01-S37, META-\*) remains an
accountable row in `parity.json` with `implementation: pending` and `static`,
`deterministic` and `live` at `not-run`; this AUDIT promotes nothing. No capability flag is
counted as implementation: each `true` flag above already carries, or now carries, a row
blocker naming the missing builder, consumer or native evidence.

### Repair tasks added

Inserted in [[GROK-TIER1-11]] after GT1-11-01 and before GT1-11-02, so the static TEST and
VERIFY packets see the repaired registries:

- GT1-11-01A IMPLEMENT: `src/renderer/services/contextGroomer.ts` Grok entries (A11-F02).
- GT1-11-01B IMPLEMENT: `KnownAuthDirs` Grok homes across `src/shared/authPaths.ts`, the
  `agents:getKnownAuthDirs` handler and `AuthPathValueInput.tsx` (A11-F01).
- GT1-11-01C IMPLEMENT: Grok known install locations in `path-prober.ts` (A11-F03).
- GT1-11-01D IMPLEMENT: Settings search copy in `searchableSettingsEncore.ts` (A11-F04).
- GT1-11-01E TEST: at most three existing suites pinning the four repairs.

`parity.json` gains `phase11StaticAudit` and the row blockers listed in the table above.

## GT1-11-03 VERIFY: pass-one static checks

- Source revision: `d84638bfce6e883809688a051fdd11265e68111e` on
  `auto-run-feature/grok-cli-integration` (GT1-11-02 head). The tree was clean apart from
  untracked `.sloptimize/` caches. Toolchain: Node v26.13.0, TypeScript 6.0.3, ESLint 9.39.4,
  Prettier 3.8.3, Vitest 4.1.11.
- Runner: `Working/gt1-11-03/run.mjs` (results in `results.json`), auditor scans in
  `scan.mjs` (`scan.json`), parity reconciliation in `build.mjs`. Live calls: 0. Images
  analyzed: 0. No production or test source was edited by this VERIFY.
- Scoped static set: 23 source files (every tracked `src/` file with `grok` in the path,
  plus every source file changed `808b92608..HEAD`) and 21 test or fixture files on the same
  rule.

### Commands and results

| Check                     | Command (from the execution root)                                                                                              | Exit | Result                                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---- | ------------------------------------------------------------------------------------------------------------------------- |
| Type check (lint config)  | `node node_modules/typescript/bin/tsc -p tsconfig.lint.json`                                                                   | 2    | one diagnostic: `src/main/plugins/plugin-host-handlers.ts(1196,76) TS2339`. It is pre-existing and outside the Grok scope |
| Type check (main)         | `node node_modules/typescript/bin/tsc -p tsconfig.main.json --noEmit`                                                          | 0    | clean                                                                                                                     |
| Type check (CLI)          | `node node_modules/typescript/bin/tsc -p tsconfig.cli.json --noEmit`                                                           | 0    | clean                                                                                                                     |
| ESLint, scoped source     | `node node_modules/eslint/bin/eslint.js --max-warnings=0 <23 source files>`                                                    | 0    | 0 errors, 0 warnings                                                                                                      |
| ESLint, tests (dash rule) | `node node_modules/eslint/bin/eslint.js -c eslint.dashes.config.mjs <21 test files>` (the main config ignores `src/__tests__`) | 0    | clean                                                                                                                     |
| Prettier                  | `node node_modules/prettier/bin/prettier.cjs --check <44 files>`                                                               | 0    | all formatted                                                                                                             |
| Docs paths                | `node scripts/verify-docs-paths.mjs`                                                                                           | 0    | clean                                                                                                                     |
| Isolation sentinel        | `node node_modules/vitest/vitest.mjs run -t isolation src/__tests__/main/agents/agent-completeness.test.ts`                    | 0    | 13 passed, 109 filtered out                                                                                               |
| Completeness and contract | `node node_modules/vitest/vitest.mjs run <8 suites below>`                                                                     | 0    | 8 files, 561 passed, 0 failed, 0 skipped (77 Grok-named cases)                                                            |

Per-suite totals: `agent-completeness.test.ts` 122 (GT1-02-12A isolation, the prior
completeness body and the GT1-11-02 Grok block), `capabilities.test.ts` 25,
`managed/contracts.test.ts` 31, `contextGroomer.test.ts` 32, `ipc/handlers/agents.test.ts`
154, `useKnownAuthDirs.test.ts` 1, `path-prober.test.ts` 52, `searchableSettings.test.ts` 144.

**GT1-01-07 scope reconciliation.** The GT1-02-12A isolation sentinel ran first and on its
own. All 13 isolation cases passed: real adapters behind the in-memory store, the Node
preferences fallback blocked even with `MAESTRO_USER_DATA` set, string, buffer and URL
paths refused, redacted refusal diagnostics, and sync and promise reads and writes
refused. The full completeness body then ran in the same file. Production-home access was
not restored, and `HOME` and `CODEX_HOME` were not changed.

### Independent inspection: shared-library coupling, fallback routes, suppressions

An independent read-only reviewer (a separate Explore agent given only the goal and the
three defect classes) swept the library. The verifier re-read every anchor it reported and
ran its own scans (`scan.mjs`).

- **Desktop coupling: none.** None of the 210 non-test files under `src/shared/maestro-lib/`
  imports `electron`, `electron-store`, `src/main`, `src/renderer`, `src/cli` or the web
  trees, statically or through `import()`/`require()`. This was checked by resolving every
  relative specifier. Relative imports leave the library only for `src/shared/`. The
  remaining `window`/`electron` matches are local identifiers, comments, or
  `process.versions.electron` reads.
- **Suppressions: none unreviewed.** The branch added 61 suppression-pattern lines since the
  merge base `0a56e0fa1c18`. None is `eslint-disable`, `@ts-ignore`, `@ts-expect-error` or
  `@ts-nocheck`.
  - 59 are `as any` casts on test doubles in test files.
  - One is a false positive in a comment (`pianola-agent-select.test.ts:123`).
  - The only non-test line is `src/renderer/utils/spawnHelpers.ts:169`
    (`session: templateSession as any`). The same cast existed at the merge base on
    `opts.session`; the branch only renamed its operand, so it is pre-existing and reviewed.
  - No non-test file with `grok` in the path contains any suppression.
- **Fallback routes on the Grok launch path: none that substitute another provider, route
  or host.**
  - The Grok route selector refuses rather than falling back. Unqualified routes, ACP over
    SSH and remote discovery all produce structured refusals.
  - SSH Grok on ACP is refused, and no hardcoded Grok model or effort default exists.
  - The library's `ssh-spawn-wrapper.ts:193` local return (`sshRemoteUsed: null`) is
    refused by every traced caller. `buildAgentLaunchPlan` refuses unresolved targets.
  - An invalid local custom path falls back to the same provider binary on `PATH` with a
    warning (`turns/provider-binary.ts:48`, CLI `agent-spawner.ts:625`). This is comparator
    parity, and SSH uses the configured path.
  - A Grok translation source projects skills and subagents with Claude metadata
    (`translation/resources.ts:342`). This is archive data, not a launch.
  - All three are recorded as observed with no change.

| ID      | Anchor                                                                                                              | Classification              | Consequence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Rows     | Disposition             |
| ------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------------------- |
| A11-F07 | `src/shared/maestro-lib/groupchat/turn-end.ts:29`, `groupchat/session-recovery.ts:40`, `runtime/group-chats.ts:305` | hardcoded provider fallback | `turnEndOf` calls `detectSessionNotFoundError(tails)` with no provider, so the headless runtime's group chat reads every participant's stdout and stderr tails through Claude's `session_not_found` patterns before the router applies the provider's own (`router.ts:3104`). Grok reaches the right recovery decision only by coincidence: Claude's `/session.*not found/i` also matches Grok's non-fatal `not found locally, restoring from remote` line. A successful Grok remote restore with no answer text then counts as having output. | P31, S14 | repair GT1-11-03A / 03B |

### Parity reconciliation

`parity.json` gains `phase11StaticVerify`, which holds the commands, exits, totals, scope,
toolchain, scans, A11-F07 and the observed no-change items.

The four blockers repaired in this phase are cleared on this passing static run. Each row
also carries a limitation note naming its repair:

- `grok-known-auth-dirs-missing` (REG-PROFILE, P04, S01; GT1-11-01B/01B1)
- `grok-context-transfer-metadata-missing` (S06, P21; GT1-11-01A)
- `grok-known-install-paths-missing` (P03, REG-DISCOVERY; GT1-11-01C)
- `grok-settings-search-copy-stale` (S35, S18; GT1-11-01D)

Blocker `grok-groupchat-turn-end-claude-patterns` is added to P31 and S14, owned by
GT1-11-03A (implementation) and GT1-11-03B (test).

A11-F05 (`grok-readonly-cli-enforcement-unqualified`) stays open and live-owned. No row
status was promoted: whole-row deterministic and live stay `not-run` until pass two and
pass three.

### Repair tasks added

Inserted in [[GROK-TIER1-11]] after GT1-11-03 and before GT1-11-04:

- GT1-11-03A IMPLEMENT: pass the participant provider id into the headless group chat turn
  end (`turn-end.ts`, `runtime/group-chats.ts`).
- GT1-11-03B TEST: pin Grok and Claude tails in `groupchat/__tests__/turn-end.test.ts`.
