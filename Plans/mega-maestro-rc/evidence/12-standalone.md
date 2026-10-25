---
type: evidence
title: 'Phase 12 evidence (MRC-12-05): standalone and package boundary'
created: 2026-10-25
phase: 12
task: MRC-12-05
acceptance_row: standalone
base_revision: 6400a6da0cfbae97bd90c4b361eea163fc3a1223
head_revision: 7405e099dcfc95b43f665c0a7fb333f9b1a5669d
branch: feature/mega-maestro-v1.1.0-rc
tags: [maestro, mega-maestro, integration, evidence, phase-12, standalone]
related:
  - '[[EXECUTION-RULES]]'
  - '[[ANALYSIS]]'
  - '[[11]]'
  - '[[mega-maestro]]'
  - '[[maestro-lib]]'
---

# Phase 12 evidence (MRC-12-05): standalone and package boundary

Related: [[EXECUTION-RULES]], [[ANALYSIS]], [[11]], [[mega-maestro]],
[[maestro-lib]]. Verification run on 2026-10-25 between 18:49 and 18:57 UTC
in the Maestro checkout on `feature/mega-maestro-v1.1.0-rc` (macOS, Darwin
27, arm64, Node `v26.12.1`). HEAD is `7405e099d` (MRC-12-04); the tree held
no tracked change (two untracked tool folders only), and the RC base
`6400a6da0` is an ancestor of HEAD (`rcBaseIsAncestor: true` in the packaged
manifest). The sibling Mega-Maestro checkout is unchanged at `d5143a6` with
935 dirty entries and was not read by anything below except the pair check,
which only inspects it.

This task answers one row of the acceptance matrix, `standalone`: "Existing
unmanaged desktop/library/CLI/Cue/plugin behavior preserved and built
library loads without Electron". It does not touch the real pair; that is
MRC-12-06. Everything here runs actual Maestro code on this host; the one
labeled double in the regression suites is the pair double the integration
tests declare, and the two tests that need the real endpoint are skipped
naming their producers and owner (below).

## Commits in phase 12 (MRC-11-07 evidence `06818099c`..HEAD)

| Commit      | Task       | Files                                                                                                                                       |
| ----------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `a1d1a1d3e` | MRC-12-01  | `scripts/package-mega-maestro-runtime.mjs` (new), `scripts/build-maestro-lib.mjs`                                                           |
| `659eb1528` | MRC-12-01A | `src/__tests__/scripts/package-mega-maestro-runtime.test.ts` (new), `package.json`, `CLAUDE.md`, `docs/agent-guides/CANONICAL-UTILITIES.md` |
| `d1ed4eea0` | MRC-12-02  | `src/__tests__/integration/mega-maestro/journeys.ts` (new), `fixtures.ts`                                                                   |
| `007ae9115` | MRC-12-02A | `journeys.ts` (desktop journeys and the provider program)                                                                                   |
| `887fdec18` | MRC-12-02B | `scripts/mega-maestro-pair.mjs` (packaged runtime, producer pins, bundled driver)                                                           |
| `4a7e5af15` | MRC-12-02B | `scripts/mega-maestro-pair.mjs` (reproducible driver bundle digest)                                                                         |
| `5380a8e8a` | MRC-12-03  | `src/__tests__/integration/mega-maestro/full-pair.test.ts` (new)                                                                            |
| `d1247b7fa` | MRC-12-03A | `src/__tests__/integration/mega-maestro/offline-recovery.test.ts` (new)                                                                     |
| `7d8527461` | MRC-12-03B | `src/__tests__/integration/mega-maestro/standalone.test.ts` (new), one repair in the packager (`capabilityMatrix` over visible definitions) |
| `0470cee5a` | MRC-12-03C | `full-pair.test.ts` (fleet evidence, usage, VIBES, TRACE, governance over the real desktop composition)                                     |
| `aa7cdf5d8` | MRC-12-03D | `full-pair.test.ts` (commands and notices over the real desktop composition)                                                                |
| `7405e099d` | MRC-12-04  | `docs/mega-maestro.md` (new), `docs/maestro-lib.md`, `Plans/mega-maestro-rc/support-matrix.json` (new)                                      |

18 files, +4823 -124 across the range (the four `Plans/` evidence re-check
files among them). No library source changed in phase 12: the bundle built
at HEAD has the same `index.js` sha256 (`f08ea73d...`) as every build since
MRC-11-02, so the artifact digests below differ from the MRC-12-02B run only
through the manifest's `source.head`, which is the source binding working.

## Commands and exits

Runner: `.maestro/playbooks/Working/12-verify/run-checks.mjs` (batches
`checks`, `lint`, `boundary`, `lib`, `desktop`, `cli`, `cue`, run one after
another; each step's full output is `<name>.log` beside it and the exits are
in `steps-<batch>.json`).

| Step                                                                       | Exit | Result                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run build:maestro-lib`                                                | 0    | `dist/maestro-lib/index.js` 1705.5 KB, maestro-lib 0.24.0, maestro-managed/1, index.js sha256 `f08ea73d57cc12ead5308b034073ef76f4c489605c5a0120c82a3f96ec7cdf50`, provenance `sourceRevision 7405e099d`, `sourceDirty: false`, 322 inputs                 |
| `npm run build:cli`                                                        | 0    | `dist/cli/maestro-cli.js` 7723.5 KB                                                                                                                                                                                                                       |
| `npm run build:main`                                                       | 2    | FAILED on the three pre-existing `TS2307` errors (`@serenity-kit/opaque` twice, `smol-toml`): packages absent because `npm install` has not been run in this environment since phase 01; identical to every phase's record. Preserved as `build-main.log` |
| `node scripts/package-mega-maestro-runtime.mjs --out .../runtime-a --json` | 0    | packaged, `certifiable: true`, `reasons: []`, archive sha256 `4a7386bec3bc5c980793aa7da661b9a5ca39597ffb1491e4dee172b5383fe29e`, 2,032,227 bytes, components library 294 / contracts 0 / conformance 2                                                    |
| `node scripts/package-mega-maestro-runtime.mjs --out .../runtime-b --json` | 0    | a second, independent packaging into another directory: the same archive sha256 and byte count                                                                                                                                                            |
| `node scripts/mega-maestro-pair.mjs check --json`                          | 2    | `assessment.ready: false`; library `ready` at HEAD; dependencies CP-01 (x2), CP-02, CP-03, registration-approval, all owner mega-maestro (table below). Unchanged in substance since phase 04                                                             |
| `tsc -p tsconfig.lint.json --noEmit`                                       | 2    | only the three pre-existing errors (`@serenity-kit/opaque`, `smol-toml`, `RequestInit.dispatcher`)                                                                                                                                                        |
| `tsc -p tsconfig.main.json --noEmit`                                       | 2    | only the three pre-existing `TS2307` errors                                                                                                                                                                                                               |
| `tsc -p tsconfig.cli.json --noEmit`                                        | 2    | only the two pre-existing `TS2307` errors                                                                                                                                                                                                                 |
| `tsc -p tsconfig.json --noEmit`                                            | 2    | only the three pre-existing errors (as the lint config)                                                                                                                                                                                                   |
| `node scripts/verify-docs-paths.mjs`                                       | 0    | 1082 asserted paths, 366 index entries against 366 full entries, 0 findings                                                                                                                                                                               |
| `prettier --check` on the 14 non-`Plans/` files changed in the range       | 0    | all matched files use Prettier code style                                                                                                                                                                                                                 |
| `eslint src/`                                                              | 0    | clean                                                                                                                                                                                                                                                     |
| `eslint -c eslint.dashes.config.mjs src/__tests__ scripts`                 | 0    | clean                                                                                                                                                                                                                                                     |
| `node .maestro/playbooks/Working/12-verify/boundary.mjs` (attempt 1)       | 1    | FAILED: my tar reader looked for `manifest.json` at the archive root while the packager nests every entry under `package/` (a reader bug, not a packager one). Preserved as `boundary-attempt1.log`                                                       |
| `node .maestro/playbooks/Working/12-verify/boundary.mjs` (attempt 2)       | 0    | 15 of 15 proofs hold (table below); report `boundary.json`                                                                                                                                                                                                |
| vitest `lib` batch (13 files)                                              | 0    | 131 passed, 2 skipped (the two real-pair cases)                                                                                                                                                                                                           |
| vitest `desktop` batch (194 files)                                         | 1    | 189 files passed, 3877 tests passed, 6 skipped; 5 files FAILED TO LOAD, all on `Cannot find package 'smol-toml'` (environment, below)                                                                                                                     |
| vitest `cli` batch (136 files)                                             | 0    | 2518 passed, 1 skipped                                                                                                                                                                                                                                    |
| vitest `cue` batch (126 files)                                             | 0    | 2627 passed, 5 skipped                                                                                                                                                                                                                                    |

Not run: `npm install` (the environment baseline is the user's, as in every
phase); the full `npm test` (the branch baseline of 2026-10-25 11:49 at
`06818099c` is recorded in the session memory: 18 failed files, all
environment, plus one FSEvents flake); any real provider, login, account or
paid model; the container pair run (`scripts/mega-maestro-pair.mjs run`),
which belongs to MRC-12-06 and whose inputs have not moved since the
MRC-12-02B run (`Working/12-02B-pair-run.json`: exit 3, 5 blocked, 0 leases,
runtime `4963972d...` at `4a7e5af15`, sibling `d5143a6` dirty).

## Boundary proofs (`boundary.mjs`, over the two packagings)

| Proof                                                                       | Holds | What was observed                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| archive bytes identical across two packagings                               | yes   | `runtime.tgz` of `runtime-a` and `runtime-b` are byte-equal, sha256 `4a7386be...`, 2,032,227 bytes                                                                                                                                                                                                                                      |
| archive sha256 equals the sidecar and the directory name                    | yes   | `runtime.tgz.sha256`, `artifact.json.archive.sha256` and the leaf directory all name `4a7386be...`                                                                                                                                                                                                                                      |
| artifact manifests equal except `packagedAt`                                | yes   | packaged at 18:49:31.316Z and 18:49:32.087Z; every other field identical                                                                                                                                                                                                                                                                |
| manifest bound to HEAD, clean, certifiable                                  | yes   | `source.head` and `source.library.sourceRevision` both `7405e099d`; `treeDirty: false`, `sourceDirty: false`; `certifiable: true`, `reasons: []`; `rcBaseIsAncestor: true`; `headCommittedAt 2026-10-25T14:43:00-04:00`                                                                                                                 |
| archive is read-only                                                        | yes   | `runtime.tgz` and `artifact.json` mode `0444`, leaf directory `0555`                                                                                                                                                                                                                                                                    |
| every archive entry is under `package/`                                     | yes   | 297 file entries, none outside                                                                                                                                                                                                                                                                                                          |
| archive entries equal the manifest payload and its hashes                   | yes   | 296 payload entries equal `payloadSha256`'s keys; every entry re-hashes to its recorded sha256; plus `manifest.json`                                                                                                                                                                                                                    |
| no profile, credential or ledger name in the archive                        | yes   | `EXCLUDED_NAME` matches no entry; the detector refuses `.env`, `id_rsa`, `maestro-managed-dispatch-receipts.json`, `credentials.json`, `x.pem` when seeded                                                                                                                                                                              |
| no secret canary or private path in any entry                               | yes   | 296 entries scanned (`.map` excluded, as the packager does); `findCanaries` names nothing; seeded with an Anthropic-key shape and the home path it answers `anthropic-key, private-path`                                                                                                                                                |
| one deterministic mtime equal to the HEAD commit time                       | yes   | every entry mtime `1792953780` = `headCommittedAt`                                                                                                                                                                                                                                                                                      |
| archived library is the built library                                       | yes   | 294 `library/` entries; `library/index.js` sha256 `f08ea73d...` equals `dist/maestro-lib/index.js` and the provenance record                                                                                                                                                                                                            |
| bundle names no `electron` and no `src/main` module                         | yes   | 1,746,415 bytes scanned for `require`/`import`/`from` of `electron` or `electron/*` and for any `/src/main/` specifier: none                                                                                                                                                                                                            |
| built library loads in plain Node outside the repository                    | yes   | the archived `library/` extracted to a temp dir with no `node_modules`; a child `node` with `PATH` and `HOME` only `require`s it: exit 0, `electron` not resolvable, 767 exports, `MAESTRO_LIB_VERSION 0.24.0`, every named managed and run export a function, nothing loaded from outside the temp dir                                 |
| support matrix routes equal the rebuilt bundle and the archived conformance | yes   | 55 rows over 11 visible providers, 0 route differences between `support-matrix.json` (read at `4a7e5af15`) and `capabilityMatrix(dist/maestro-lib)` at `7405e099d`; `conformance/capabilities.json` in the archive equals it; `harness` blocks equal; managed implemented 11 / unverified 0 / unsupported 44, standalone implemented 16 |
| library version agrees across source, dist, docs and artifact               | yes   | `version.ts`, `dist/maestro-lib/package.json`, `provenance.json`, `artifact.json.versions.library`, the loaded module and `docs/maestro-lib.md` (3 mentions) all `0.24.0`                                                                                                                                                               |

API drift is proven by `standalone.test.ts` in the `lib` batch (`ts.createProgram`
over the source entry and over the built `index.d.ts`: the declared export
set is identical in both directions and the bundle's runtime keys equal the
declared values exactly), and by `built-entry.test.ts` and
`no-desktop-framework.smoke.test.ts` (every import specifier reachable from
the public entry, none `electron`, none into `src/main`).

## Regressions: unmanaged desktop, library, CLI, Cue and plugins

| Batch     | Targets                                                                                                                                                                                                                                                                                             | Files                | Tests                  |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ---------------------- |
| `lib`     | `src/shared/maestro-lib/__tests__` (built-entry, complete, docs-examples, headless-program, host, no-desktop-framework, tui-example), `managed/contracts.test.ts`, `scripts/package-mega-maestro-runtime.test.ts`, `integration/mega-maestro` (early-pair, full-pair, offline-recovery, standalone) | 13 passed            | 131 passed, 2 skipped  |
| `desktop` | `main/process-manager`, `main/agents`, `main/plugins`, `shared/plugins`, `main/enterprise`, `shared/maestro-lib`, `scripts`, `ipc/handlers/enterprise`, `preload/enterprise`, `index-wiring`                                                                                                        | 189 passed, 5 failed | 3877 passed, 6 skipped |
| `cli`     | `src/__tests__/cli`                                                                                                                                                                                                                                                                                 | 136 passed           | 2518 passed, 1 skipped |
| `cue`     | `src/__tests__/main/cue`                                                                                                                                                                                                                                                                            | 126 passed           | 2627 passed, 5 skipped |

Totals: 469 files, 9153 tests passed, 14 skipped, 5 files failed to load, 0
tests failed.

**The five files that failed to load** are
`src/__tests__/shared/maestro-lib/translation-{acceptance-inputs,adapters,projections,transaction,resources}.test.ts`,
every one at import with `Cannot find package 'smol-toml' imported from
src/shared/maestro-lib/translation/resources.ts`. The package is a declared
dependency that this environment never installed (`node_modules` predates
the dependency; see the `tsc` errors above); the same five are in the
recorded branch baseline and in the release branch's baseline, and
`translation-governance.test.ts`, which mocks that one package, passed in
the same batch. They are an environment gap, not a code regression, and they
are NOT counted as passed: the TOML resource translation they cover is not
demonstrated by this run (see the verdict).

**The fourteen skips, each with its gate:**

- `early-pair.test.ts` and `full-pair.test.ts`, one case each: the
  certifiable real pair, `it.skipIf(!ready)` where `ready` is the pair
  check's assessment; the skip title names CP-01 (x2), CP-02, CP-03 and
  registration-approval with owner mega-maestro. A skipped required case,
  recorded as such; it belongs to MRC-12-06.
- `run/start-turn.test.ts`: the Windows `.cmd` shim case, `skipIf(platform !== win32)`.
- `scripts/server-packaging.test.ts`, five cases: the `install.sh` registry
  checks need a `timeout` binary (`command -v timeout`), absent on macOS.
- `cli/services/batch-processor.test.ts`: `should respect maxLoops limit`,
  an `it.skip` in the file since before this branch (mock coordination).
- `main/cue/cue-engine-lock.test.ts`: the PID-namespace token case,
  `runIf(currentPidNsInode() !== undefined)`, Linux only.
- `main/cue/cue-db-integration.test.ts`, four cases: the real SQLite
  round-trips, `describe.skipIf(!canLoadBetterSqlite3())`, the native
  binding not being loadable under this Node from this checkout.

Expected stderr noise in the CLI batch (typography fixtures throwing
`Unknown surface "sidebar"`, `"big" is not a zoom level` and the like) is
the tests' own negative cases; no test failed.

## Pins recorded

| Item                                 | Value                                                                                                                                                              |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Maestro HEAD / branch                | `7405e099dcfc95b43f665c0a7fb333f9b1a5669d`, `feature/mega-maestro-v1.1.0-rc`, committed 2026-10-25T14:43:00-04:00                                                  |
| RC base                              | `6400a6da0cfbae97bd90c4b361eea163fc3a1223` (`v1.1.0-RC`), ancestor of HEAD                                                                                         |
| App / plugin host API / plugin SDK   | `1.1.0-RC` / `1.25.0` / `0.19.0`                                                                                                                                   |
| maestro-lib                          | `0.24.0`, `maestro-managed/1`, endpoint protocol 1, Node range `>=20`, built with Node 26.12.1, 322 inputs sha256 `d757ec67...`, `index.js` sha256 `f08ea73d...`   |
| Accepted contracts                   | `@mega-maestro/contracts` `>=0.1.0 <0.2.0`, endpoint protocols `[1]`                                                                                               |
| Runtime artifact                     | `.maestro/playbooks/Working/12-verify/runtime-a/0.24.0/4a7386bec3bc5c980793aa7da661b9a5ca39597ffb1491e4dee172b5383fe29e/runtime.tgz`, 2,032,227 bytes, certifiable |
| Contracts pin                        | absent (`vendor/mega-maestro/contracts.pin.json` does not exist): CP-01, owner mega-maestro                                                                        |
| Runtime adapter / workflow authority | pins absent (`vendor/mega-maestro/runtime-adapter.pin.json`, `workflow-authority.pin.json`): CP-02, CP-03, owner mega-maestro                                      |
| Registration approval producer       | none (`--approve-command` not supplied): owner mega-maestro                                                                                                        |
| Sibling Mega-Maestro checkout        | `d5143a6`, 935 dirty entries; four packaged darwin/arm64 application artifacts at `e29195d8`, all `sourceDirty: true`, adapter `unsupported`, none certifiable     |
| Container host                       | Docker 29.9.2, image `node@sha256:71bcbb3b...` present (linux/arm64, created 2025-05-21; Node 22.16, no `--allow-net`)                                             |

## Verdict for the `standalone` row

Demonstrated on this host with actual Maestro code: the built library loads
with no Electron from a directory that has no `node_modules`; the public API
has not drifted from the source entry; the packaged archive carries exactly
the hashed payload, no credential-like name and no secret canary, and two
packagings are byte-identical and bound to HEAD; the unmanaged desktop
process sink, agents, plugins, enterprise seams (standalone standing opens
no port and touches no anchor), CLI, Cue and the library suites pass as
before; an unenrolled installation refuses nothing it used to allow.

Recorded as passed for what it demonstrates, with one named gap: the five
TOML translation suites did not run here (environment, `smol-toml`), so that
part of library behavior is inferred from the unchanged branch baseline, not
shown by this run. Running them needs `npm install` in this checkout, which
is the user's call. The row is independent of the counterpart producers; the
`headless-library` row and the paired completion stay with MRC-12-06, which
remains blocked on CP-01, CP-02, CP-03 and registration approval.

## Observations (not acted on in a VERIFY task)

- `scripts/package-mega-maestro-runtime.mjs:70` is a bare regular-expression
  expression statement left beside the active `EXCLUDED_NAME` on line 69
  (an older, broader pattern). It has no effect; worth a one-line repair.
- `journeys.ts` carries five type errors and `full-pair.test.ts` one, none
  covered by a tsconfig (recorded at MRC-12-02 and MRC-12-03C).
- `providerRouteSupport('hermes')` reads `implemented` on `child-process`
  while `planSessionTurn` refuses Hermes with `no-parser` (documented in
  `docs/mega-maestro.md` and the support matrix at MRC-12-04).

## Working files

`.maestro/playbooks/Working/12-verify/`: `run-checks.mjs`, `boundary.mjs`,
`summarize-vitest.mjs`, `boundary.json`, `boundary.log`,
`boundary-attempt1.log`, `steps-{checks,lint,boundary,lib,desktop,cli,cue}.json`,
`steps-boundary-attempt1.json`, every `<step>.log`, `changed-files.txt`, and
the two packagings `runtime-a/` and `runtime-b/`. The playbook folder is
gitignored; only this document is committed.
