---
type: evidence
title: 'P2-08 evidence (MRC2-08-04): standalone and whole-repository checks'
created: 2026-10-28
phase: 2
task: MRC2-08-04
document: MAESTRO-MEGA-P2-08
base_revision: 6400a6da0cfbae97bd90c4b361eea163fc3a1223
head_revision: 9b2b5a3a721a845d244c0321919902d873e4007a
branch: feature/mega-maestro-v1.1.0-rc
counterpart_revision: d5143a63931dc87a5f90b3fdb7b58fa3726913b1
tags: [maestro, mega-maestro, integration, evidence, phase-2, p2-08, standalone]
related:
  - '[[EXECUTION-RULES]]'
  - '[[PHASE2-GAPS]]'
  - '[[counterpart-requests]]'
  - '[[12-standalone]]'
  - '[[p2-07]]'
  - '[[p2-06]]'
  - '[[p2-05]]'
  - '[[p2-04]]'
  - '[[p2-03]]'
  - '[[p2-02]]'
  - '[[p2-01]]'
  - '[[mega-maestro]]'
  - '[[README]]'
---

# P2-08 evidence (MRC2-08-04): standalone and whole-repository checks

Related: [[EXECUTION-RULES]], [[PHASE2-GAPS]], [[counterpart-requests]],
[[12-standalone]], [[p2-07]], [[p2-06]], [[p2-05]], [[p2-04]], [[p2-03]],
[[p2-02]], [[p2-01]], [[mega-maestro]], [[README]]. Verification run on
2026-10-29 between 03:12 and 03:39 UTC (the evening of 2026-10-28 local) in
the Maestro checkout on `feature/mega-maestro-v1.1.0-rc` (macOS, Darwin 27,
arm64, Node `v26.12.1` from `/opt/homebrew/bin`). The branch was verified
before any edit; the RC base `6400a6da0` is an ancestor of HEAD. The checks
ran twice: once at `d43b4f5f6` (MRC2-08-03), which surfaced one regression of
this document's own making and three the branch had carried for days, and
once more at `9b2b5a3a7` after the two bounded repairs (MRC2-08-03A,
MRC2-08-03B) landed. The figures below are those of the second run unless a
row says otherwise. The sibling Mega-Maestro checkout is still at `d5143a639`
and was not read by this task beyond the pair check MRC2-08-03 recorded in
[[counterpart-requests]] and the support matrix.

This task runs the whole-repository commands the document names, confirms the
real-pair suites skip visibly with their dependency reason under the default
vitest project (the one both CI legs run), loads the built library in plain
Node, checks that the standalone paths reach no managed module and that the
library payload carries none, and re-runs every failed suite alone before
calling anything a regression. Scratch and every log live under
`Working/p2-08-04/` (`run-checks.mjs`, `node-load.mjs`, `poll.mjs`,
`steps-*.json`, `suite.json`, `suite-summary.json`, `retry.json`,
`boundary.json`, every `*.log`; not committed).

## Commands and exit codes

| Command                                                     | Exit | Result                                                                                                                                                                                                                              |
| ----------------------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run lint`                                              | 2    | the chain stops at `tsc -p tsconfig.lint.json` on the three baseline errors: `lite/pairing/host.ts` (`@serenity-kit/opaque` absent), `translation/resources.ts` (`smol-toml` absent), `plugin-host-handlers.ts:1196` (`dispatcher`) |
| `tsc -p tsconfig.main.json --noEmit`                        | 2    | 3 errors: `lite/pairing/client.ts` and `host.ts` (`@serenity-kit/opaque`), `translation/resources.ts` (`smol-toml`)                                                                                                                 |
| `tsc -p tsconfig.cli.json --noEmit`                         | 2    | 2 errors: `lite/pairing/host.ts`, `translation/resources.ts` (the same absent modules)                                                                                                                                              |
| `npm run lint:eslint` (`eslint src/` and the dashes config) | 0    | clean on both halves                                                                                                                                                                                                                |
| `npm run docs:verify`                                       | 0    | 1183 asserted paths and 392 index entries resolve against 392 full entries, 0 findings                                                                                                                                              |
| `npm run build:maestro-lib`                                 | 0    | maestro-lib 0.32.0 from `9b2b5a3a7`, clean, 294 payload files, `index.js` sha256 `133436f7` (the same bytes as the `78689ade2` and `d43b4f5f6` builds: no library source changed in P2-08), Node 26.12.1                            |
| `npm run test` (second run, at `9b2b5a3a7`)                 | 1    | 2583 files: 2567 passed, 15 failed, 1 skipped; 57196 tests: 57098 passed, 2 failed, 96 skipped; 496 s (03:29:54 to 03:38:11 UTC)                                                                                                    |
| `npm run test` (first run, at `d43b4f5f6`)                  | 1    | 2580 files: 31 failed; 56722 tests: 10 failed; 569 s; the 30-file baseline of the repository memory plus `compatibility.counterpart.test.ts` (one case), see Repairs                                                                |
| every failed file re-run alone (`vitest run <file>`)        | 1    | 15 of 15 fail alone too (first run: 31 of 31); nothing was a flake                                                                                                                                                                  |
| `npm run test:integration` (`vitest.integration.config.ts`) | 1    | 11 files: 4 failed, 7 skipped (bail 1); 289 tests: 1 failed, 5 passed, 75 skipped; 7 s; see below                                                                                                                                   |
| `vitest run src/__tests__/integration/mega-maestro`         | 0    | 4 files passed; 31 tests passed, 2 skipped with the printed dependency reason (see below)                                                                                                                                           |
| `node Working/p2-08-04/node-load.mjs`                       | 0    | the built library loaded in plain Node (see below)                                                                                                                                                                                  |

Every type error is a module absent without a fresh `npm install`
(`@serenity-kit/opaque`, `smol-toml`) or the pre-existing `dispatcher` error;
all three were in the baseline before Phase 2 (see [[p2-01]] through
[[p2-07]]). Logs: `lint.log`, `tsc-main.log`, `tsc-cli.log`, `eslint-src.log`,
`eslint-dashes.log`, `eslint.log`, `docs.log`, `build-lib.log`, `suite.log`,
`suite.json`, `integration.log`, `mega-skip.log`, `node-load.log`,
`retry-*.log` under `Working/p2-08-04/`.

## The whole suite: what fails, and that none of it is a flake

The 15 files that fail at `9b2b5a3a7`, each re-run alone with the same result
(`retry.json`), are the environment set the repository memory has recorded on
every full run of this branch and of the release branch, not code:

| Files | Reason                                                                                                                                                                                                                                                                                                                  |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4     | `Cannot find package 'dns-packet'`: `lite.discovery-pairing`, `lite.discovery-probe`, `lite/host-discovery`, `lite/lan`                                                                                                                                                                                                 |
| 4     | `Cannot find package '@serenity-kit/opaque'`: `lite/direct-lan`, `lite/direct-tailnet`, `web-server/WebServer`, `web-server/routes/liteConnectionRoutes`                                                                                                                                                                |
| 6     | `Cannot find package 'smol-toml'`: `provider-translation-service` and the five `shared/maestro-lib/translation-*` suites                                                                                                                                                                                                |
| 1     | `utils/remote-worktree-paths.test.ts`, 2 tests (`retains a removed but unpruned real Git worktree`, `exposes a real Git registry alias after its parent group is migrated and replaced by a symlink`): the fixture's real `git commit` returns status null under 1Password commit signing (see [[test-suite-env-deps]]) |

All three packages are in `package.json` and the lockfile; `node_modules` on
this host predates them, so `npm install` is the fix and no source change is.
The suite's 96 skipped tests are the repository's own `it.skip` and
`skipIf` cases, 2 of them the real-pair cases below.

The flaky suites the repository memory names (`stats-listener` retry timing,
`rowHoverCss` timeout, the `cue-engine` wall-clock collision at 07:00 and
19:00 local, `cue-file-watcher-missing-base` double FSEvents add, the
`full-pair` 1600 canary and its notices held-map reset) did not fire in either
run; neither run started between :54 and :56 before 07:00 or 19:00 local.

### Repairs made between the two runs (bounded, before this VERIFY)

The first run (at `d43b4f5f6`) failed 31 files and 10 tests. Sixteen were not
environment, and all sixteen were deterministic alone:

- `shared/maestro-lib/managed/compatibility.counterpart.test.ts`, one case:
  this document's MRC2-08-03 had added four producer rows to
  `support-matrix.json` `counterpart.rows`, which the test pins key for key to
  the nine rows of `COUNTERPART_SUPPORT`. Repaired by MRC2-08-03A
  (`725d7a585`): the four producers live under `counterpart.producerRows`,
  the writer refuses any other count, and the handoff was regenerated.
- The thirteen Cue suites (`cue-chain-lineage`, `cue-completion-chains`,
  `cue-concurrency`, `cue-engine-integration`, `cue-engine`,
  `cue-github-poller`, `cue-multi-hop-chains`, `cue-race-conditions`,
  `cue-run-manager`, `cue-session-lifecycle`, `cue-sleep-prevention`,
  `cue-sleep-wake`, `cue-startup`) failed at import with `No "createHash"
export is defined on the "crypto" mock`: they double `crypto` with
  `randomUUID` alone, and since `a824c1e54` (MRC2-06-06) `cue-susfactor.ts`
  reaches `safe-storage-seal.ts`, whose obscuring key called `createHash` at
  import. Repaired by MRC2-08-03B (`9b2b5a3a7`): the key is derived on first
  use (`obscuringKeyOf()`), the same bytes.
- `renderer/turns/assemble-parity.test.ts`, 6 cases, `managedPort is not a
function`: its process-manager double lacked the two methods the handler
  has called since MRC-06-01 and MRC2-02-01A. Repaired by MRC2-08-03B: the
  double answers `managedPort()` null and `spawnAdmitted()` through `spawn`.
- `cot-export/leak-guard.test.ts`, 1 case: the `content.ts` entry of
  `CANONICAL-UTILITIES.md` (MRC-10-04) named the private recording store's
  folder. Repaired by MRC2-08-03B: the phrase no longer names it.

The focused run of those 20 suites passed 626 of 626 before the commit, and
the second whole run confirms all four repairs: 474 more tests load and pass
(57196 against 56722), and the failed set is the environment set alone.

## `npm run test:integration`

The integration config (`vitest.integration.config.ts`: jsdom, forks,
`singleFork`, `bail: 1`, 3-minute test timeout) is documented as a manual or
dedicated-CI run that "requires real agents"; it is not part of `npm run
test` and the mega-maestro suites are not in its include list (they run in
the default project, below). It exits 1 with four failed files, and the same
four at `d43b4f5f6`:

| File                                                | Failure                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `integration/AutoRunRightPanel.test.tsx`            | transform error, 4 parse errors: lines 16 and 17 are the same `import type { Session, Shortcut, BatchRunState, RightPanelTab }` statement twice (`Identifier 'Session' has already been declared`); the default config does not include this file                                                                                                                                                                                                                                                                                       |
| `integration/remote-control.integration.test.ts`    | `Cannot find package '@serenity-kit/opaque'` (environment, as above)                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `integration/remote-tab-rename.integration.test.ts` | the same absent package                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `integration/symphony.integration.test.ts`          | one case, `should complete full contribution flow`: `symphony:startContribution` answers `{ success: false, error: "TypeError: Cannot read properties of undefined (reading 'get')" }` (read with a throwaway copy of the test that printed the result, deleted). The handler reads a store the test's dependency double does not provide; the handler's own suites in the default project pass (`ipc/handlers/symphony.test.ts`, 249 tests at [[p2-04]]). Not repaired here: a mock gap of a manual suite, outside this task's targets |

The other 7 files are skipped whole by their own guards (no live provider,
no `MAESTRO_INTEGRATION` opt-in). None of the four is a managed-mode failure;
`bail: 1` stops the run after the Symphony case, so the 75 skipped tests of
that file and the later files were not reached.

## The real-pair suites skip visibly, under the default project

`src/__tests__/integration/mega-maestro/{early-pair,full-pair,offline-recovery,standalone}.test.ts`
run under the default vitest project (they are plain `.test.ts` files under
`src/__tests__`, which `npm run test` includes and the integration config
does not). The two cases that need the certifiable pair are guarded by
`it.skipIf(!report.assessment.ready)` (`early-pair.test.ts:391`,
`full-pair.test.ts:477`), and the case name carries the reason the harness
report computed at run time, so a skip is never silent. Run at 03:29:49 UTC
with `--reporter=verbose`: 4 files passed, 31 tests passed, 2 skipped, and
each skipped line reads, in full:

> `(blocked: CP-01 (mega-maestro): no clean contracts artifact is pinned (vendor/mega-maestro/contracts.pin.json); CP-01 (mega-maestro): no clean Linux application artifact (4 dirty-source packaged artifact(s); development checkout is never certifiable); CP-02 (mega-maestro): runtime adapter pin absent, declared unsupported; needs a supported createMaestroAdapter from endpoint source d5143a63931dc87a5f90b3fdb7b58fa3726913b1 (dirty or absent); CP-03 (mega-maestro): workflow authority pin absent; needs the delegation/workflow owner producer from endpoint source d5143a63931dc87a5f90b3fdb7b58fa3726913b1 (dirty or absent); linux-host (maestro): no Linux Docker engine with built-in seccomp; registration-approval (mega-maestro): no API/console producer to approve the actor registration (--approve-command))`

The 31 that run are the labeled-double journeys, the offline recovery cases,
the standalone cases and the two "names every producer the pair waits on"
cases, which assert `report.assessment.dependencies.length > 0` whenever the
pair is not ready (`full-pair.test.ts:468`), so a run that lost its
dependency list would fail rather than pass. The CI matrix
(`.github/workflows/ci.yml:40-56`) runs `npm run test -- --shard=N/2` on
`ubuntu-latest` and `windows-latest`; both legs therefore see the same
`skipIf` with the same printed reason, counted as skipped by vitest, never as
passed. On the Windows leg the harness route is also not offered
(`syntheticHarnessRouteSupport()` on win32), which the standalone suite
asserts only on the platforms that offer it. This task could not run the
Windows leg itself; the claim rests on the guard being in the default
project, which this host exercised, and on the workflow text.

## The built library in plain Node, and the standalone boundary

`Working/p2-08-04/node-load.mjs` imports `dist/maestro-lib/index.js` in a
child Node started with `PATH` and `HOME` alone (no Electron in the process:
`process.versions.electron` is undefined; the `electron` package is
resolvable from the repository's `node_modules` but never loaded):

| Fact                                                                             | Value                                                                                                 |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `MAESTRO_LIB_VERSION`                                                            | `0.32.0`; 813 exports                                                                                 |
| `planSessionTurn`, `startTurn`, `buildAgentLaunchPlan`, `providerRouteSupport`   | functions                                                                                             |
| `createHeadlessSpawnAuthority`, `createManagedBinding`, `negotiateCompatibility` | functions (the managed surface the build insists on)                                                  |
| a headless authority over `{ state: 'standalone' }` with no host                 | `standing()` is `standalone`, `policy().policyRevision` is null; nothing read, no socket, no anchor   |
| `providerRouteSupport('claude-code', 'child-process')`                           | `implemented` / `implemented`, the note naming the launch admitted at the real spawn and nothing more |
| modules loaded from `src/main`                                                   | none (the bundle is self-contained)                                                                   |

The boundary (`boundary.json`): the 294 payload files of the build carry no
file from `src/main` (the 28 modules of `src/main/enterprise/` are desktop
composition, never bundled); `index.js` (1,774,573 bytes) contains no
`require('electron')` and no `from 'electron'`; its four textual mentions of
`main/enterprise` are the consumer names inside the `COUNTERPART_SUPPORT`
row notes (documentation strings, not imports). The committed
`standalone.test.ts` proves the same from inside the suite and passed in both
runs: the library loads with no Electron resolvable, names no electron
require and bundles nothing from the desktop main process; the bundle's
capability matrix equals the packager's and the source's; an unenrolled
desktop service reports standalone standing, opens no port and touches no
anchor; a headless authority over a standalone binding needs no lease and the
sink starts the turn with no admission; `resolveSecrets` reports and
continues where `resolveSecretsStrict` fails closed; and the declaration
entry names exactly the source entry's exports.

What "no managed module is imported by a standalone path" means here, said
precisely: the desktop main process does compose every enterprise module at
startup (`src/main/index.ts` builds the policy sources, the custody and the
facade whatever the enrollment), and that is by design; what the standalone
path never does is call into a ceiling. With no policy installed every
authority is null or answers `standalone`, and the managed suites of
[[p2-04]], [[p2-05]] and [[p2-06]] prove beside each refusal that the
standalone call reads nothing (`setEgressAuthority(null)`,
`setListenerAuthority(null)`, `gitExecutionGate` null, `localEffects()` null,
`shellAuthority` null, `installAuthority` null, the settings guard with no
policy). The library, the CLI and a headless host reach the managed modules
only through `createHeadlessSpawnAuthority()` over the binding file, which the
probe above shows answering `standalone` with nothing read.

## Not claimed

No acceptance row changed and no real pair journey ran. The Windows CI leg
was not run by this task; its visible skip is argued from the guard's place in
the default project and the workflow text. `npm run test:integration` is
recorded as failing with the four files named, not as passed; the Symphony
case is a mock gap left for its owner. The 15 environment files are listed,
not hidden: they need `npm install` on this host and a commit-signing
override in the one fixture, neither of which this task made. The source tree
gained this file alone; the two repairs are the separate commits named above.
