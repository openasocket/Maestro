---
type: analysis
title: Grok tier-1 execution baseline and design ledger
created: 2026-10-30
tags: [maestro, grok, baseline, design]
related:
  - '[[CONTRACT]]'
  - '[[REFERENCE]]'
  - '[[Plans/grok-tier1/evidence/01]]'
---

# Grok tier-1 execution baseline

GT1-01-01 records the starting environment. Provider implementation, transport design,
acceptance coverage and release qualification remain pending. The machine-readable record is
[run-state.json](run-state.json); the command receipts are [[Plans/grok-tier1/evidence/01]].

The governing documents are the canonical
[contract](/Users/dr3/dev-shit/Maestro/.maestro/playbooks/2026-10-30-Grok-Tier1/CONTRACT.md)
and [reference](/Users/dr3/dev-shit/Maestro/.maestro/playbooks/2026-10-30-Grok-Tier1/REFERENCE.md),
also linked as [[CONTRACT]] and [[REFERENCE]]. Their SHA-256 hashes are in run-state so
later tasks can distinguish this baseline from changed instructions.

## Execution identity

Maestro's registered agent `404dfe62-cb4a-4e29-b2e3-a2cbb6ee3bb9` has the expected name
`auto-run-feature/grok-cli-integration`, provider `codex`, and cwd
`/Users/dr3/dev-shit/worktrees/auto-run-feature/grok-cli-integration`. Git independently
reports that root and branch. The common repository is `/Users/dr3/dev-shit/Maestro/.git`.
The registered Auto Run folder is the shared `.maestro/playbooks` folder; its
`2026-10-30-Grok-Tier1` subfolder contains this playbook. No new worktree is needed.

| Baseline identity             | Observed value                              |
| ----------------------------- | ------------------------------------------- |
| Starting execution HEAD       | `0a56e0fa1c18e25a8e8a70dfc37378ae7d076b4f`  |
| Resolved local base           | `refs/heads/feature/mega-maestro-v1.1.0-rc` |
| Base commit                   | `dab0dbb9ccad90b5f3d5c0784cd0d0151b24e796`  |
| Merge base                    | `0a56e0fa1c18e25a8e8a70dfc37378ae7d076b4f`  |
| Execution ahead / behind base | 0 / 2                                       |

The origin tracking ref matches the resolved local base; no upstream tracking ref for
that branch exists. No fetch was performed. The two base-only commits change two
`Plans/integration-completion/evidence/` records, with no source-code difference. This
task preserves the existing checkout instead of updating its ancestry. `sourceCommit`
always means the pre-task HEAD; the baseline artifact commit is necessarily later.

The initial tracked tree is clean. The observed untracked `.sloptimize/output_cache/`
file is tool output and is preserved outside this task's commit. The primary checkout,
dependency tree and repository configuration remain unchanged.

## Provider identity and architecture boundaries

The target remains provider ID `grok`, display name Grok CLI, executable `grok`.
[[REFERENCE]] selects the official `@xai-official/grok@1.0.70` candidate and records
its registry integrity. These are inherited provenance, awaiting independent artifact
verification. The reference's public source snapshot is
`2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8`; its source-monorepo provenance is
`559751fdcec02d413e4c57c8832ab275e4f44980`. Neither SHA is a claim about the npm binary's
build source. The located user executable was not invoked, and its version remains unknown.

Existing reuse boundaries verified in this checkout:

- Definitions and capabilities: `src/shared/maestro-lib/providers/definitions.ts` and
  `capabilities.ts`; their `src/main/agents/` counterparts are compatibility re-exports.
- Output parser: `src/shared/maestro-lib/parsers/grok-output-parser.ts`; the main parser
  path is a compatibility re-export.
- Native session storage: `src/main/storage/grok-session-storage.ts` still owns the implementation.
- Picker identity: `src/shared/agentMetadata.ts`; do not introduce another provider ID.

Current guides mix historical CLI versions and describe Grok as implemented while retaining
Beta status. Those statements do not qualify the selected candidate or prove parity. No
capability, parser, storage, permission, pricing or beta behavior changes in this baseline.

## Tooling and recovery

The host is macOS 27.2 arm64 with Node 26.13.0 and npm 11.20.0. The manifest requires
Node >=22.0.0, `.npmrc` enforces engines, and package-lock version 3 pins dependencies.
There is no exact package-manager/runtime pin. GT1-01-01 initially found no
execution-checkout `node_modules`; GT1-01-01A subsequently installed 1,445 lock-matching
packages with `npm ci` and caches/temp files under `tmp/grok-tier1-setup/`.
The supported `MAESTRO_SERVER_INSTALL=1` mode preserves Node ABI 147: local test/build
tool versions, the dependency tree and SQLite/canvas/PTY binding smoke checks passed.
Electron native rebuild remains `not-run` because the pinned rebuild tool hardcodes
`~/.electron-gyp`, outside this task's write boundary. Electron's binary is present,
but neither desktop ABI readiness nor application tests are implied by setup success.
The lifecycle scripts and available native prerequisites are recorded in [[Plans/grok-tier1/evidence/01]].

GT1-01-01 borrowed the primary checkout's lock-matching Prettier read-only. After
GT1-01-01A, use the worktree's installed Prettier 3.8.3. The remaining repository suites
are explicitly `not-run` until GT1-01-06. Run-state retains the original baseline
provenance; its `setup` receipt records GT1-01-01A's source revision and commands.

The local commit hook calls unpinned, unavailable `npx lint-staged`. Use a command-local
`core.hooksPath=/dev/null` for this documentation-only commit after explicit formatting
and artifact checks; do not change shared Git configuration. The specific contract's
prohibition on pushing overrides the generic Auto Run push instruction. Keep this task's
commit local; do not create a PR or publish anything.

## Live boundary and later owners

Run-state has `live.enabled: false`, a null credentials/authorization reference and zero
spend, calls, turns and wall-clock budget. No provider process, authentication flow,
discovery endpoint or paid request was executed. Linux, Windows and SSH coverage are
unqualified. Missing authorization is a blocker, never permission to use ambient accounts.

GT1-01-02 and GT1-01-03 own the parity ledger and consumer audit. GT1-01-04 owns the
versioned native/ACP contract, GT1-01-05 the isolated acceptance/live configuration, and
GT1-01-06 the baseline repository checks. Each later task must recheck root/branch,
read run-state and the canonical contract/reference, and preserve these provenance and
live-execution boundaries. No images accompany this task; zero were analyzed.
