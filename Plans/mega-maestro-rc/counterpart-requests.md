---
type: dependency-request
title: Mega-Maestro producers the Maestro integration is waiting on
created: 2026-10-25
status: open
maestro_branch: feature/mega-maestro-v1.1.0-rc
maestro_head: 34822c6ec
maestro_lib_version: 0.24.0
maestro_lib_sha256: f08ea73d
counterpart_repository: /Users/dr3/dev-shit/mega-maestro
counterpart_commit: d5143a63931dc87a5f90b3fdb7b58fa3726913b1
counterpart_dirty_entries: 935
tags: [mega-maestro, maestro, integration, dependencies, handoff]
---

# Producers Maestro is waiting on

Related: [[PHASE2-GAPS]], [[EXECUTION-RULES]], [[ANALYSIS]], [[README]]. The
evidence behind every row is in `evidence/01.md`, `evidence/02.md`,
`evidence/03.md`, `evidence/04.json`, `evidence/11.json` and
`joint-integration.json` beside this file.

Maestro's side of the managed integration is code complete on
`feature/mega-maestro-v1.1.0-rc`: 147 of 152 Phase 1 tasks are checked. The
five that remain are real-pair verifications (MRC-01-06, MRC-02-07, MRC-03-08,
MRC-04-05, MRC-12-06). Each has been run against the actual Mega-Maestro
endpoint in an owned Linux container and left unchecked on purpose, because
the execution rules forbid passing a paired check on a double. They cannot
move until the producers below exist. Nothing in this list can be built from
the Maestro repository.

## What a producer unblocks

| ID | Producer Mega-Maestro owns | Maestro consumer waiting | Phase 1 task it unblocks |
| --- | --- | --- | --- |
| CP-01 | A clean, source-pinned contracts archive and packaged endpoint, API and gateway artifacts built from a committed tree on Linux | `scripts/import-mega-maestro.mjs` pins the digest in `vendor/mega-maestro/contracts.pin.json`; `scripts/mega-maestro-pair.mjs check` refuses dirty-source artifacts | MRC-01-06, MRC-03-08, MRC-04-05, MRC-12-06 |
| CP-02 | A real `createMaestroAdapter` in `packages/runtime-adapter/src/maestro.ts` that loads the pinned Maestro runtime artifact and serves the runtime port, instead of answering `unsupported` for every request | The packaged runtime from `scripts/package-mega-maestro-runtime.mjs` and the `headless-library` acceptance row | MRC-04-05, MRC-12-06 |
| CP-03 | Delegation and workflow authority on the wire: a `delegationChain` field in `local-endpoint.ts`, a served `workflow` operation, and a bridge that stops denying `context-mismatch` for a nonempty chain or a non-null workflow | `src/shared/maestro-lib/managed/workflows.ts`, `delegation.ts`, Cue and Auto Run owner fences, consult lineage | MRC-02-07, MRC-12-06 (rows `autorun`, `cue`, `delegated-work`) |
| CP-04 | The endpoint server advertising and serving `command`, `workflow`, `offline`, `enrollment` and `budget`; today `apps/endpoint/src/ipc/server.ts:65-67` serves only attachment, compatibility, telemetry, inbox, noticeList, execution and model | `src/main/enterprise/commands.ts`, `enrollment.ts`, `policy-status.ts`; the enrollment lifecycle requests enroll, rotate, revoke and retire that no handler answers | MRC-03-08, MRC-11-07 (recorded, row not passed), MRC-12-06 |
| CP-04a | A registration-approval producer (API or console) that approves an actor registration challenge, so a registration carries an actor id; today the sealed record's actor is null and every actor-bound command answers `unauthenticated` | `createEnrollmentLifecycle()` `completeRegistration`, `createCommandService()` binding | MRC-03-08, MRC-04-05, MRC-12-06 |
| CP-05 | `pause_run` and `resume_run` actions on `commandRequest`; today the action union is `cancel_run`, `refresh_policy`, `report_status` only | `src/shared/maestro-lib/managed/commands.ts` lists pause and resume under `DESKTOP_UNCOMPOSED_COMMANDS` and answers `unsupported` by name | MRC-11-07 row `commands-notices` (pause and resume cases) |
| CP-06 | OS peer authentication on macOS and Windows, or a documented statement that managed Maestro is Linux-only; today `apps/endpoint/src/ipc/native.ts:24` throws `IPC_PLATFORM_UNSUPPORTED` off Linux and every application artifact records `nativeEndpoint: unsupported` | The support matrix and the settings pane say "unsupported on this platform"; the pair can only run in the Linux container | Every paired row when run on the developer's macOS host |

## What Maestro already provides for the pair

- The built library: `npm run build:maestro-lib`, version 0.24.0, sha256
  prefix `f08ea73d`, plain Node, no Electron, with the managed surface
  exported from `src/shared/maestro-lib/index.ts`.
- The packaged runtime artifact: `npm run package:mega-maestro-runtime`
  (`scripts/package-mega-maestro-runtime.mjs`) with versions, digests, the
  capability matrix and the acceptance expectations.
- The pair harness: `scripts/mega-maestro-pair.mjs check` names every open
  dependency by id; `scripts/mega-maestro-pair.mjs run` drives the real
  endpoint in a Linux container and writes `joint-integration.json`.
- The acceptance record: `Plans/mega-maestro-rc/joint-integration.json`, 13
  rows, 1 passed (`standalone`), 5 journeys blocked, 0 leases issued.
- The per-route support matrix: `Plans/mega-maestro-rc/support-matrix.json`.
- The public page: `docs/mega-maestro.md`.

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
