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
