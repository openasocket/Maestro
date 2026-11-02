---
type: report
title: GT1-11-10 native offline verification
created: 2026-11-01
tags: [grok, verify, native, offline, provenance]
related:
  - '[[11-static]]'
  - '[[11-integration]]'
---

# GT1-11-10 native offline verification

Source: `ba5db25c2b8d303344eed36084c9c651d5344515` (auto-run-feature/grok-cli-integration, tree clean). Node v26.13.0. Recorded 2026-11-01T23:56:05.921Z.

**Result:** offline safety tests pass; every binary probe is not-run. No Grok binary was executed, no network contact, no credential or configuration file read, zero paid requests. Readiness stays false.

## 1. Offline harness safety tests

`node node_modules/vitest/vitest.mjs run src/__tests__/scripts/grok-qualification-spend.test.ts src/__tests__/scripts/grok-qualification-harness.test.ts`: exit 0, 41/41 passed.

| Suite                                                      | Owner                             | Passed | Failed |
| ---------------------------------------------------------- | --------------------------------- | ------ | ------ |
| `src/__tests__/scripts/grok-qualification-harness.test.ts` | GT1-11-09/09A isolation/discovery | 20     | 0      |
| `src/__tests__/scripts/grok-qualification-spend.test.ts`   | GT1-11-09 budget/cleanup          | 21     | 0      |

## 2. Harness with no config (default run-state)

`node scripts/grok-qualification.mjs --json --no-write`: exit 0; configSource `default-run-state`, configProblems 0. Totals: 48 cases, 0 admitted, 48 not-run, spawned 0, paid 0, network 0. Ledger limits 0 USD / 0 calls / 0 turns, nothing reserved. Capabilities: isolationPreflight=true, atomicSpendAdmission=true, caseExecutor=false.

Not-run reasons across all cases (count of occurrences):

| Reason                                   | Count |
| ---------------------------------------- | ----- |
| `live-authorization-absent`              | 48    |
| `credential-reference-absent`            | 60    |
| `binary-unpinned`                        | 48    |
| `auto-update-not-disabled`               | 48    |
| `allowed-roots-absent`                   | 48    |
| `host-isolation-unqualified`             | 48    |
| `endpoints-unapproved`                   | 48    |
| `models-unselected`                      | 44    |
| `live-limits-unset`                      | 352   |
| `spend-guarantee-absent`                 | 44    |
| `spend-bounds-undeclared`                | 44    |
| `case-executor-unimplemented`            | 48    |
| `isolation-undeclared`                   | 48    |
| `ssh-target-unapproved`                  | 24    |
| `discovery-authorization-absent`         | 8     |
| `discovery-operation-unauthorized`       | 8     |
| `cross-provider-authorization-absent`    | 8     |
| `cross-provider-preflight-unimplemented` | 8     |

E02 (offline inspection plus discovery, rows P01, P04, P09):

| Case                        | Reasons                                                                                                                                                                                                                                                                                                               |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `E02:native-headless:local` | live-authorization-absent, credential-reference-absent, binary-unpinned, auto-update-not-disabled, allowed-roots-absent, host-isolation-unqualified, endpoints-unapproved, discovery-authorization-absent, case-executor-unimplemented, discovery-operation-unauthorized, isolation-undeclared                        |
| `E02:native-headless:ssh`   | live-authorization-absent, credential-reference-absent, binary-unpinned, auto-update-not-disabled, allowed-roots-absent, host-isolation-unqualified, endpoints-unapproved, ssh-target-unapproved, discovery-authorization-absent, case-executor-unimplemented, discovery-operation-unauthorized, isolation-undeclared |
| `E02:acp-stdio:local`       | live-authorization-absent, credential-reference-absent, binary-unpinned, auto-update-not-disabled, allowed-roots-absent, host-isolation-unqualified, endpoints-unapproved, discovery-authorization-absent, case-executor-unimplemented, discovery-operation-unauthorized, isolation-undeclared                        |
| `E02:acp-stdio:ssh`         | live-authorization-absent, credential-reference-absent, binary-unpinned, auto-update-not-disabled, allowed-roots-absent, host-isolation-unqualified, endpoints-unapproved, ssh-target-unapproved, discovery-authorization-absent, case-executor-unimplemented, discovery-operation-unauthorized, isolation-undeclared |

## 3. Local artifact (read-only, not executed, not selected)

The only Grok on this host is the operator's production install. It is not an explicitly selected isolated binary, so it was inspected from disk only.

| Field                | Value                                                                                                                                                                                                                                                                                                            |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PATH resolution      | `/Users/dr3/.local/bin/grok`, `/Users/dr3/.grok/bin/grok`                                                                                                                                                                                                                                                        |
| Links                | `/Users/dr3/.local/bin/grok` -> `/Users/dr3/.grok/bin/grok`; `/Users/dr3/.grok/bin/grok` -> `../downloads/grok-macos-aarch64`                                                                                                                                                                                    |
| Target               | `/Users/dr3/.grok/downloads/grok-macos-aarch64`                                                                                                                                                                                                                                                                  |
| Bytes / mode / mtime | 179063008 / 755 / 2026-10-30T05:32:58.685Z                                                                                                                                                                                                                                                                       |
| sha256               | `5c8a688251bf61e35370b828b6a353b0a20fcc3f64000de8a91d426039f29cec`                                                                                                                                                                                                                                               |
| sha512               | `d36c523acffdea846e9f245149fac200cd8faadaef818e7f796d6eff90bd8536d68e21d840f6443849a6eb70544599aa30feb9b9ea6b6aa7253c6b08918cd151`                                                                                                                                                                               |
| Format               | Mach-O 64-bit executable arm64 (magic `cffaedfe0c000001`)                                                                                                                                                                                                                                                        |
| Signature            | Identifier=xai-grok-pager; Format=Mach-O thin (arm64); Signature size=8983; Authority=Developer ID Application: X.AI Corporation (5Y6N3AJ54S); Authority=Developer ID Certification Authority; Authority=Apple Root CA; Timestamp=Oct 23, 2026 at 12:24:35 PM; TeamIdentifier=5Y6N3AJ54S; Runtime Version=27.0.0 |
| Install metadata     | version.json 1.0.70 (stable 1.0.70, checked 2026-10-31T06:15:17.25096Z); .metadata_version 1.0.70                                                                                                                                                                                                                |

Not read: auth.json, config.toml, sessions, logs, memory, models_cache.json, settings_cache.json.

## 4. Identity kept distinct

| Identity         | Value                                                                       | Status                                           |
| ---------------- | --------------------------------------------------------------------------- | ------------------------------------------------ |
| npm              | `@xai-official/grok@1.0.70`, integrity `sha512-Q2Nc...6CQ==` (REFERENCE.md) | not downloaded, integrity not-run                |
| Source           | public `2bdd1d6a`, monorepo `559751fd` (REFERENCE.md)                       | not built, relationship unknown                  |
| Executable       | sha256 `5c8a688251bf61e3...`, Developer ID X.AI Corporation                 | observed on disk, unselected, version unexecuted |
| Install metadata | 1.0.70                                                                      | a file claim, not executable identity            |

No equivalence between these is claimed.

## 5. Offline versus network evidence

| Check                                                 | Class                  | Result   | Reason                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------- | ---------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Harness safety suites                                 | deterministic, offline | pass     | 41/41                                                                                                                                                                                                                                                                                                                                          |
| Disk artifact integrity (hash, format, signature)     | offline, no execution  | observed | section 3                                                                                                                                                                                                                                                                                                                                      |
| Offline version/help (E02 offline-inspection)         | offline execution      | not-run  | No explicitly selected isolated binary: run-state binary unpinned, autoUpdateDisabled false, no isolationReceipt or allowedRoots, live.enabled false; the only local binary is the operator production install, which this task does not execute. Harness: discovery-authorization-absent and case-executor-unimplemented also hold (A11-F14). |
| ACP initialize / protocol advertisement               | network discovery      | not-run  | discovery-authorization-absent, endpoints-unapproved, credential-reference-absent; may touch credentials or configured endpoints.                                                                                                                                                                                                              |
| Model/config discovery                                | network discovery      | not-run  | Same as ACP; no discovery operation authorized.                                                                                                                                                                                                                                                                                                |
| npm artifact integrity (sha512 vs referenceIntegrity) | network fetch          | not-run  | Would need a registry download; offline task, no fetch.                                                                                                                                                                                                                                                                                        |
| Native auto-update disablement                        | offline execution      | not-run  | GROK_DISABLE_AUTOUPDATER=1 is source-supported in GROK_CONTROL_ENV but its efficacy on this binary is unverified without running it; the production install shows the updater active (D3).                                                                                                                                                     |

## 6. Documentation discrepancies

- **D1.** REFERENCE.md: official package `@xai-official/grok` 1.0.70 with a Node launcher (`>=20`). Observed: The PATH binary is a self-managed native Mach-O (Mach-O 64-bit executable arm64) at /Users/dr3/.grok/downloads/grok-macos-aarch64, reached through /Users/dr3/.local/bin/grok -> /Users/dr3/.grok/bin/grok; no npm launcher is on PATH. The npm tarball was not fetched (offline), so npm-to-executable identity is unknown.
- **D2.** Executable name `grok`. Observed: Code signature Identifier is `xai-grok-pager`, TeamIdentifier 5Y6N3AJ54S; `~/.grok/bin/agent` links to the same file.
- **D3.** run-state `installedGrok.version: null, invoked: false`; candidate 1.0.70. Observed: Install metadata (not the executable) says version 1.0.70, stable 1.0.70, update check at 2026-10-31T06:15:17.25096Z, after the binary mtime 2026-10-30T05:32:58.685Z. The native updater is active on this production install; a metadata string is not executable identity.
- **D4.** Reference public source commit 2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8. Observed: No source checkout or build; source-to-executable relationship stays unknown (binarySourceRelationship unknown).

## 7. Finding

- **A11-F14** (harness-gap; `scripts/grok-qualification/harness.ts:324`, `scripts/grok-qualification/harness.ts:811`, `scripts/grok-qualification/harness.ts:2022`): Offline inspection cannot be admitted apart from network discovery: E02 carries both execution classes, so a pinned binary with an isolation receipt still needs discovery authorization, endpoints and credential references before `--version`/`--help` may run, and no executor exists for any admitted tuple (case-executor-unimplemented names GT1-11-10, a VERIFY packet that may not add harness code). Offline evidence and network evidence therefore cannot be produced or recorded as distinct results. Blocker `grok-offline-inspection-not-separable` on P01; repair GT1-11-10A (IMPLEMENT) and GT1-11-10B (TEST), inserted before GT1-11-11. Even after the repair, the offline probe stays not-run until run-state pins an isolated binary (path, sha256, version), sets autoUpdateDisabled with an isolation receipt, and declares allowed roots.

Script: `Working/gt1-11-10/run.mjs` (results.json), `build.mjs` (this report and `parity.json` `phase11NativeOffline`).

<!-- GT1-11-11 section -->

# GT1-11-11 pass three: bounded isolated positive workflows

Source: `d5ca54d0a8cd6a888c9e9e88de67b3806c90f9d0` (tree clean). Node v26.13.0. Recorded 2026-11-02T00:15:40.232Z.

**Result:** every positive workflow is not-run. run-state supplies none of the live prerequisites, so nothing was spawned, prompted or sent; no production account, workspace or Grok install was touched (production binary sha256 `5c8a688251bf61e3...` unchanged, never executed). Readiness stays false.

## 8. Live prerequisites (run-state, read only)

Missing (17): `live.enabled false`, `live.credentialsReference null`, `live.authorizationReference null`, `live.budgetUsd 0`, `live.maxCalls 0`, `live.maxTurns 0`, `live.maxWallClockSeconds 0`, `live.allowedEndpoints empty`, `selectedBinaryPath null`, `selectedBinarySha256 null`, `selectedLiveModels empty`, `authorization.configurationReference null`, `authorization.expiresAt null`, `authorization.isolationReceipt null`, `authorization.allowedRoots empty`, `no provider cap or worst-case reservation`, `authorization.sharedBudgetLedgerReference null`. No qualification config under `tmp/grok-tier1-environment/runs/`. Required live blockers still open: `live-authorization-absent`, `binary-unpinned`, `host-isolation-unqualified`, `background-egress-unqualified`, `discovery-authorization-absent`, `live-limits-unset`, `spend-guarantee-absent`.

## 9. Harness safety and admission at this source

- `node node_modules/vitest/vitest.mjs run src/__tests__/scripts/grok-qualification-spend.test.ts src/__tests__/scripts/grok-qualification-harness.test.ts`: exit 0, 48/48 passed (grok-qualification-harness.test.ts 27, grok-qualification-spend.test.ts 21; includes the GT1-11-10B offline-leg block).
- `node scripts/grok-qualification.mjs --json --no-write`: exit 0, 48 cases, 0 admitted, 48 not-run, spawned 0, paid 0, network 0. Capabilities: isolationPreflight=true, atomicSpendAdmission=true, offlineExecutor=true, caseExecutor=false.

## 10. Per-workflow outcome

Each workflow expands over routes native-headless/acp-stdio x targets local/ssh x platforms 6 x version profiles (none qualified) x models (none selected). No tuple ran; no subset certifies another.

| Workflow                                                           | Family | Rows                                   | Cases | Outcome | Admission reasons                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------ | ------ | -------------------------------------- | ----- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New and resumed multi-turn sessions                                | E04    | P10, P12, P14                          | 4     | not-run | `live-authorization-absent`, `credential-reference-absent`, `binary-unpinned`, `auto-update-not-disabled`, `allowed-roots-absent`, `host-isolation-unqualified`, `endpoints-unapproved`, `models-unselected`, `live-limits-unset`, `spend-guarantee-absent`, `spend-bounds-undeclared`, `case-executor-unimplemented`, `isolation-undeclared`, `ssh-target-unapproved`                                                                       |
| Large Unicode, empty and multiline prompts                         | E03    | P06, P07, P08                          | 4     | not-run | `live-authorization-absent`, `credential-reference-absent`, `binary-unpinned`, `auto-update-not-disabled`, `allowed-roots-absent`, `host-isolation-unqualified`, `endpoints-unapproved`, `models-unselected`, `live-limits-unset`, `spend-guarantee-absent`, `spend-bounds-undeclared`, `case-executor-unimplemented`, `isolation-undeclared`, `ssh-target-unapproved`                                                                       |
| Images, fresh and resumed                                          | E03    | P06, P07, P08                          | 4     | not-run | `live-authorization-absent`, `credential-reference-absent`, `binary-unpinned`, `auto-update-not-disabled`, `allowed-roots-absent`, `host-isolation-unqualified`, `endpoints-unapproved`, `models-unselected`, `live-limits-unset`, `spend-guarantee-absent`, `spend-bounds-undeclared`, `case-executor-unimplemented`, `isolation-undeclared`, `ssh-target-unapproved`                                                                       |
| Real native and MCP tools                                          | E08    | P18, P19, P25, P26, P27, P28           | 4     | not-run | `live-authorization-absent`, `credential-reference-absent`, `binary-unpinned`, `auto-update-not-disabled`, `allowed-roots-absent`, `host-isolation-unqualified`, `endpoints-unapproved`, `models-unselected`, `live-limits-unset`, `spend-guarantee-absent`, `spend-bounds-undeclared`, `case-executor-unimplemented`, `isolation-undeclared`, `ssh-target-unapproved`                                                                       |
| Subagents and child attribution                                    | E05    | P13, P14, P15, P16                     | 4     | not-run | `live-authorization-absent`, `credential-reference-absent`, `binary-unpinned`, `auto-update-not-disabled`, `allowed-roots-absent`, `host-isolation-unqualified`, `endpoints-unapproved`, `models-unselected`, `live-limits-unset`, `spend-guarantee-absent`, `spend-bounds-undeclared`, `case-executor-unimplemented`, `isolation-undeclared`, `ssh-target-unapproved`                                                                       |
| Model and effort changes                                           | E07    | P04, P05, P33                          | 4     | not-run | `live-authorization-absent`, `credential-reference-absent`, `binary-unpinned`, `auto-update-not-disabled`, `allowed-roots-absent`, `host-isolation-unqualified`, `endpoints-unapproved`, `discovery-authorization-absent`, `models-unselected`, `live-limits-unset`, `spend-guarantee-absent`, `spend-bounds-undeclared`, `case-executor-unimplemented`, `discovery-operation-unauthorized`, `isolation-undeclared`, `ssh-target-unapproved` |
| History reload and export                                          | E05    | P13, P14, P15, P16                     | 4     | not-run | `live-authorization-absent`, `credential-reference-absent`, `binary-unpinned`, `auto-update-not-disabled`, `allowed-roots-absent`, `host-isolation-unqualified`, `endpoints-unapproved`, `models-unselected`, `live-limits-unset`, `spend-guarantee-absent`, `spend-bounds-undeclared`, `case-executor-unimplemented`, `isolation-undeclared`, `ssh-target-unapproved`                                                                       |
| Cancellation and resume                                            | E04    | P10, P12, P14                          | 4     | not-run | `live-authorization-absent`, `credential-reference-absent`, `binary-unpinned`, `auto-update-not-disabled`, `allowed-roots-absent`, `host-isolation-unqualified`, `endpoints-unapproved`, `models-unselected`, `live-limits-unset`, `spend-guarantee-absent`, `spend-bounds-undeclared`, `case-executor-unimplemented`, `isolation-undeclared`, `ssh-target-unapproved`                                                                       |
| Token and cost reconciliation                                      | E06    | P11, P40                               | 4     | not-run | `live-authorization-absent`, `credential-reference-absent`, `binary-unpinned`, `auto-update-not-disabled`, `allowed-roots-absent`, `host-isolation-unqualified`, `endpoints-unapproved`, `models-unselected`, `live-limits-unset`, `spend-guarantee-absent`, `spend-bounds-undeclared`, `case-executor-unimplemented`, `isolation-undeclared`, `ssh-target-unapproved`                                                                       |
| Desktop, library, CLI, Auto Run, Cue, group chat and web consumers | E09    | P17, P20, P29, P30, P31, P32, P37, P38 | 4     | not-run | `live-authorization-absent`, `credential-reference-absent`, `binary-unpinned`, `auto-update-not-disabled`, `allowed-roots-absent`, `host-isolation-unqualified`, `endpoints-unapproved`, `models-unselected`, `live-limits-unset`, `spend-guarantee-absent`, `spend-bounds-undeclared`, `case-executor-unimplemented`, `isolation-undeclared`, `ssh-target-unapproved`                                                                       |
| Platform paths, signals and remote roots                           | E12    | P15, P39, P43                          | 4     | not-run | `live-authorization-absent`, `credential-reference-absent`, `binary-unpinned`, `auto-update-not-disabled`, `allowed-roots-absent`, `host-isolation-unqualified`, `endpoints-unapproved`, `models-unselected`, `live-limits-unset`, `spend-guarantee-absent`, `spend-bounds-undeclared`, `case-executor-unimplemented`, `isolation-undeclared`, `ssh-target-unapproved`                                                                       |

Fixture hashes and assertions: none recorded, because no fixture was materialized and no assertion was evaluated; a fixture-only pass is not native evidence.

## 11. Finding

- **A11-F15** (harness-gap; `scripts/grok-qualification/harness.ts:2077`): No paid-case executor exists: HARNESS_CAPABILITIES.caseExecutor is false and case-executor-unimplemented names GT1-11-11 as owner for every paid leg, but GT1-11-11 is a VERIFY packet that may not add harness code. Even with every run-state prerequisite supplied, no positive workflow (E03-E09, E12) nor any other paid family could be admitted or observed, so pass three cannot produce native evidence through the harness. Blocker `grok-paid-executor-unimplemented` on 38 rows; repair GT1-11-11P1 (IMPLEMENT) and GT1-11-11P2 (TEST), inserted after GT1-11-11. The discovery executor (owner GT1-11-11A, also a VERIFY) is the same gap for discovery legs; GT1-11-11A inserts its own continuation when it runs. After the repair, every workflow stays not-run until run-state supplies the prerequisites in section 8.

Script: `Working/gt1-11-11/run.mjs` (results.json), `build.mjs` (this section and `parity.json` `phase11NativePositive`).
