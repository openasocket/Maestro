---
type: dependency-request
title: Mega-Maestro producers the Maestro integration is waiting on
created: 2026-10-25
status: open
maestro_branch: feature/mega-maestro-v1.1.0-rc
maestro_head: 78689ade2
maestro_lib_version: 0.32.0
maestro_lib_sha256: 133436f7
counterpart_repository: /Users/dr3/dev-shit/mega-maestro
counterpart_commit: d5143a63931dc87a5f90b3fdb7b58fa3726913b1
counterpart_dirty_entries: 935
rechecked: 2026-10-28 (MRC2-08-03)
tags: [mega-maestro, maestro, integration, dependencies, handoff]
---

# Producers Maestro is waiting on

Related: [[PHASE2-GAPS]], [[EXECUTION-RULES]], [[ANALYSIS]], [[README]]. The
evidence behind every row is in `evidence/01.md`, `evidence/02.md`,
`evidence/03.md`, `evidence/04.json`, `evidence/11.json` and
`joint-integration.json` beside this file.

Maestro's side of the managed integration is code complete on
`feature/mega-maestro-v1.1.0-rc`: 147 of 152 Phase 1 tasks are checked, and
Phase 2 (the eight `MAESTRO-MEGA-P2-01..08` documents, gap closure) is
checked through P2-07 with P2-08 in progress as of 2026-10-28. The
five that remain are real-pair verifications (MRC-01-06, MRC-02-07, MRC-03-08,
MRC-04-05, MRC-12-06). Each has been run against the actual Mega-Maestro
endpoint in an owned Linux container and left unchecked on purpose, because
the execution rules forbid passing a paired check on a double. They cannot
move until the producers below exist. Nothing in this list can be built from
the Maestro repository.

## What a producer unblocks

| ID     | Producer Mega-Maestro owns                                                                                                                                                                                                                                             | Maestro consumer waiting                                                                                                                                            | Phase 1 task it unblocks                                       |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| CP-01  | A clean, source-pinned contracts archive and packaged endpoint, API and gateway artifacts built from a committed tree on Linux                                                                                                                                         | `scripts/import-mega-maestro.mjs` pins the digest in `vendor/mega-maestro/contracts.pin.json`; `scripts/mega-maestro-pair.mjs check` refuses dirty-source artifacts | MRC-01-06, MRC-03-08, MRC-04-05, MRC-12-06                     |
| CP-02  | A real `createMaestroAdapter` in `packages/runtime-adapter/src/maestro.ts` that loads the pinned Maestro runtime artifact and serves the runtime port, instead of answering `unsupported` for every request                                                            | The packaged runtime from `scripts/package-mega-maestro-runtime.mjs` and the `headless-library` acceptance row                                                      | MRC-04-05, MRC-12-06                                           |
| CP-03  | Delegation and workflow authority on the wire: a `delegationChain` field in `local-endpoint.ts`, a served `workflow` operation, and a bridge that stops denying `context-mismatch` for a nonempty chain or a non-null workflow                                         | `src/shared/maestro-lib/managed/workflows.ts`, `delegation.ts`, Cue and Auto Run owner fences, consult lineage                                                      | MRC-02-07, MRC-12-06 (rows `autorun`, `cue`, `delegated-work`) |
| CP-04  | The endpoint server advertising and serving `command`, `workflow`, `offline`, `enrollment` and `budget`; today `apps/endpoint/src/ipc/server.ts:65-67` serves only attachment, compatibility, telemetry, inbox, noticeList, execution and model                        | `src/main/enterprise/commands.ts`, `enrollment.ts`, `policy-status.ts`; the enrollment lifecycle requests enroll, rotate, revoke and retire that no handler answers | MRC-03-08, MRC-11-07 (recorded, row not passed), MRC-12-06     |
| CP-04a | A registration-approval producer (API or console) that approves an actor registration challenge, so a registration carries an actor id; today the sealed record's actor is null and every actor-bound command answers `unauthenticated`                                | `createEnrollmentLifecycle()` `completeRegistration`, `createCommandService()` binding                                                                              | MRC-03-08, MRC-04-05, MRC-12-06                                |
| CP-05  | `pause_run` and `resume_run` actions on `commandRequest`; today the action union is `cancel_run`, `refresh_policy`, `report_status` only                                                                                                                               | `src/shared/maestro-lib/managed/commands.ts` lists pause and resume under `DESKTOP_UNCOMPOSED_COMMANDS` and answers `unsupported` by name                           | MRC-11-07 row `commands-notices` (pause and resume cases)      |
| CP-06  | OS peer authentication on macOS and Windows, or a documented statement that managed Maestro is Linux-only; today `apps/endpoint/src/ipc/native.ts:24` throws `IPC_PLATFORM_UNSUPPORTED` off Linux and every application artifact records `nativeEndpoint: unsupported` | The support matrix and the settings pane say "unsupported on this platform"; the pair can only run in the Linux container                                           | Every paired row when run on the developer's macOS host        |

## What Maestro already provides for the pair

- The built library: `npm run build:maestro-lib`, version 0.32.0 at
  `78689ade2` (sha256 prefix `133436f7`; 0.24.0 / `f08ea73d` when this
  document was written), plain Node, no Electron, with the managed surface
  exported from `src/shared/maestro-lib/index.ts`.
- The packaged runtime artifact: `npm run package:mega-maestro-runtime`
  (`scripts/package-mega-maestro-runtime.mjs`) with versions, digests, the
  capability matrix and the acceptance expectations.
- The pair harness: `scripts/mega-maestro-pair.mjs check` names every open
  dependency by id; `scripts/mega-maestro-pair.mjs run` drives the real
  endpoint in a Linux container and writes `joint-integration.json`.
- The acceptance record: `Plans/mega-maestro-rc/joint-integration.json`, 13
  rows, 1 passed (`standalone`), 5 journeys blocked, 0 leases issued.
- The per-route support matrix: `Plans/mega-maestro-rc/support-matrix.json`
  (since MRC2-08-03 also the enforcement section: every sink family of
  [[PHASE2-GAPS]] row by row, the lock keys, the egress and listener classes).
- The public page: `docs/mega-maestro.md`.
- The handoff manifest at the agreed path, `Plans/mega-maestro/evidence/handoff.json`
  (`scripts/write-mega-maestro-handoff.mjs`, regenerated by MRC2-08-03).

## Path mapping

Mega-Maestro's integration design expects Maestro's handoff manifest at
`Plans/mega-maestro/evidence/handoff.json` and a digest-verified copy of
`joint-integration.json` beside it. Phase 1 wrote everything under
`Plans/mega-maestro-rc/`. Phase 2 task P2-01 writes the handoff at the
agreed path and documents the mapping; until then, read
`Plans/mega-maestro-rc/joint-integration.json` directly.

## How Maestro will react when a producer lands

Each of the five open tasks carries a guard: it re-runs the real check only
when the sibling commit, the artifact set or the built library sha has moved.
Deliver any producer as a committed revision plus a rebuilt artifact set and
the next Auto Run pass will exercise it. A development checkout with 935 dirty
entries cannot be certified and will keep every row blocked.

## Re-checked 2026-10-28 (MRC2-08-03)

Read at the end of Phase 2, Maestro HEAD `78689ade2`, library 0.32.0, the
sibling still at `d5143a639` with 935 dirty entries (the files cited below are
unchanged in its working tree). `node scripts/mega-maestro-pair.mjs check --json`
ran at 03:00 UTC on 2026-10-29 (exit 2, `assessment.ready: false`); the
Docker daemon was not running on this host, so no container run was made, and
nothing a container run reads (a counterpart input, the artifact set) has
moved since the last one recorded in [[p2-02]]. Every producer is still open.

| ID     | Observed on this date                                                                                                                                                                                                                                                                                                                                                          |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CP-01  | `vendor/mega-maestro/contracts.pin.json` absent; four packaged application artifacts under `artifacts/application/0.1.0/`, every one darwin/arm64 from `e29195d8` with `sourceDirty: true`, `components: []`, `certifiable: false`; no clean Linux artifact; the pair check names it twice (the pin, the artifact)                                                             |
| CP-02  | `packages/runtime-adapter/src/maestro.ts:7-20`: `createMaestroAdapter` returns `status: "unsupported"` with reason `public-artifact-not-supplied` or `public-artifact-not-qualified` and a port whose `execute` answers `capability-unsupported`; every packaged artifact declares `maestroAdapter.status: unsupported`; `vendor/mega-maestro/runtime-adapter.pin.json` absent |
| CP-03  | `packages/runtime-adapter/src/endpoint.ts:35`: a nonempty `delegationChain` or a non-null `workflow` is denied `context-mismatch`; `local-endpoint.ts` has no delegation field; `vendor/mega-maestro/workflow-authority.pin.json` absent                                                                                                                                       |
| CP-04  | `apps/endpoint/src/ipc/server.ts:65-67`: the served list is attachment, compatibility and (when their producers answer) telemetry, inbox, noticeList, execution, model; `command`, `workflow`, `offline`, `enrollment` and `budget` (declared at `local-endpoint.ts:164-173`) fall through to `unsupported_capability` at `:142`                                               |
| CP-04a | `approvalProducer: false`: no API or console producer approves the actor registration (`--approve-command` has nothing to run), so the handshake stops at the challenge and every actor-bound command answers `unauthenticated`                                                                                                                                                |
| CP-05  | `packages/contracts/src/local-endpoint.ts:79-83`: `commandRequest.action` is the three-member union `cancel_run`, `refresh_policy`, `report_status`; no `pause_run`, no `resume_run`                                                                                                                                                                                           |
| CP-06  | `apps/endpoint/src/ipc/native.ts:24`: `inspectNativePeer` throws `IPC_PLATFORM_UNSUPPORTED` when `process.platform` is not `linux`; no win32 artifact exists and the darwin artifacts record no native component                                                                                                                                                               |

The matrix carries the same observations as `counterpart.rows[].observed`
(`Plans/mega-maestro-rc/support-matrix.json`), and the regenerated handoff
lists the producers under `pendingPrerequisites`.
