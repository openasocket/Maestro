---
type: report
title: Endpoint v2 client and post-handoff cutover status
created: 2026-11-13
tags:
  - integration-completion
  - endpoint-v2
  - status
related:
  - '[[README]]'
  - '[[RUN-ORDER]]'
  - '[[EXECUTION-RULES]]'
---

# Endpoint v2 client and post-handoff cutover status (2026-11-13)

This records which MMV2 and MCOMP items are closed after the two Maestro Auto Run
playbooks of 2026-11-13, and the receipt each closure rests on. It claims nothing
beyond those receipts. The playbook documents live under `.maestro/playbooks/`,
which is gitignored, so this file is the committed record.

- `2026-11-13-Maestro-Mega-Endpoint-V2-Client` (MMV2-01 to MMV2-08)
- `2026-11-13-Maestro-Post-Handoff-Cutover` (MPC-01 to MPC-08)

## Closed: MMV2 (endpoint v2 client, contracts 0.2.0)

All eight MMV2 phases are checked. Every v2 operation stays behind the attach
negotiation, and `V2_OPERATIONS_SELECTED` is still empty, so no production caller
uses a v2 operation yet. These are unit-level closures against the test fake, not
live checks against the real endpoint.

| Item    | Commit      | What closed                                                                  |
| ------- | ----------- | ---------------------------------------------------------------------------- |
| MMV2-01 | `87a751f46` | v2 invoke and attach path behind the v1 default                              |
| MMV2-02 | `5853c01a4` | execution no longer advertised (enrollment and workflow kept, real v1 gates) |
| MMV2-03 | `0ee7aa2f5` | challenge digest stored; registration_use bootstrap gated on negotiation     |
| MMV2-04 | `d10d95b87` | workflow owner epoch opaque; one conversion at the v1 boundary               |
| MMV2-05 | `f571bba02` | v2 workflow lifecycle client checked against the echoed owner                |
| MMV2-06 | `6063004ce` | v2 operation clients behind a negotiation gate, selection empty              |
| MMV2-07 | `1e4e7c514` | 0.2.0 consumer receipt published and its three readers repointed (see below) |
| MMV2-08 | none        | close-out: typecheck, prettier and the affected suites changed nothing       |

Follow-on commits on the same line: `350fd1be0` (attach on protocol 2 first, on
its own connection), `5a4ef5e09` (desktopPolicy known as a v1 operation),
`7a4ec931d` and `70e681178` (reusable consumer BUILD receipt writer,
`scripts/write-consumer-build-receipt.mjs`), `b0d1dbe42` (formatting).

MMV2-07 first closed with no receipt because no writer existed. The writer was
then added, and the receipt it produced is the closure evidence:

- Receipt: `Plans/integration-completion/evidence/contract-inputs-build-0.2.0.json`
  (`maestro-build-receipt/1`, task MCOMP-00-03, status `published`)
- Archive: `@mega-maestro/contracts` 0.2.0, sha256
  `7b292e89321d0a526491c3a9a597ab7cfb84cbffed2b1f9662d5917b093137b7`
- Readers repointed: desktop-contract, provider-contract and
  provider-route-evidence suites under `src/__tests__/shared/maestro-lib/managed/`

## Closed: MPC (post-handoff cutover)

| Item      | Evidence                                                                                                                                                                                                                          |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MPC-04-05 | Check only: `ENTERPRISE_SUPPORTED_CAPABILITIES` and `_V2` in `src/main/enterprise/service.ts` hold no execution capability                                                                                                        |
| MPC-08-01 | Baseline at `b0d1dbe42`: three typechecks exit 0; vitest 2915 of 2920 files pass, 2 tests fail in `remote-worktree-paths.test.ts` from the headless 1Password commit signer (environment only, file untouched by either playbook) |
| MPC-08-02 | This document                                                                                                                                                                                                                     |

The cutover playbook produced no new receipt file. Each receipt it was meant to
write is still absent:

- `evidence/contract-inputs-build-0.3.0.json` (MPC-01-03)
- `evidence/endpoint-v2-live-registration.json` (MPC-04-02, MPC-04-04)
- `evidence/maestro-v2-consumer-build.json` (MPC-05-03)

## Open, and why

| Item                            | Blocked on                                                                                                                                                  |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MPC-01-01 to MPC-01-03          | Mega has not published the 0.3.0 handoff (`MAESTRO-V2-HANDOFF.md`, `endpoint-v2-contract-0.3.0-build.json`, `artifacts/enterprise/0.3.0/`); pin stays 0.2.0 |
| MPC-02 (enrollment D1)          | 0.3.0 contracts (request, prove, activate operations)                                                                                                       |
| MPC-03 (local control D2)       | 0.3.0 contracts (`cancel_run`, `report_status`, `refresh_policy`)                                                                                           |
| MPC-04-01 to MPC-04-04          | Mega has no endpoint-v2 parity matrix yet (only `00-baseline.md` and `02-maestro-notified.md`)                                                              |
| MPC-05                          | MPC-04-02; no operation is selected until the parity matrix shows it served and passing                                                                     |
| MPC-06 (v1 removal, one socket) | MPC-05-03 and Mega retiring the v1 wire                                                                                                                     |
| MPC-07-01 to MPC-07-11          | MPC-05-03 and the 0.3.0 handoff; each later item also needs its Mega build receipt (g07, g08, g09, g10, g14)                                                |
| MPC-08-03                       | Chains on this task; runs next                                                                                                                              |

MCOMP items still open, none closed by either playbook. Each is the single VERIFY
task in its document under `.maestro/playbooks/2026-10-29-Maestro-Integration-Completion/`:

| MCOMP    | Scope                                             | Runs through                 |
| -------- | ------------------------------------------------- | ---------------------------- |
| MCOMP-14 | first real positive direct pair                   | MPC-07-01                    |
| MCOMP-16 | endpoint policy changes real host behavior        | MPC-07-02                    |
| MCOMP-18 | automated and delegated pair                      | MPC-07-03                    |
| MCOMP-20 | residual native and shared effects                | MPC-07-04                    |
| MCOMP-22 | residual authority closure through actual sinks   | MPC-07-05                    |
| MCOMP-24 | native GUI create and edit flow                   | MPC-07-06                    |
| MCOMP-26 | complete native end-user loop                     | MPC-07-07                    |
| MCOMP-28 | native run reaches central evidence and detection | MPC-07-08                    |
| MCOMP-30 | central native communication outcomes             | MPC-07-09                    |
| MCOMP-32 | route and native platform support matrix          | MPC-07-10                    |
| MCOMP-34 | final native GUI and runtime pair                 | MPC-07-11                    |
| MCOMP-36 | Windows application archive                       | manual, needs RUNNER-WINDOWS |

## Standing decisions

- Runtime archive pin stays at `3d037e43`; `eb443aa7`
  (`evidence/requalification-2026-11-12.json`) is not adopted, because receipts
  that name `3d037e43` would go stale.
- Execution stays unadvertised until Mega's GCOMP-15-07 clears.
- Local commits are unsigned and unpushed; the pre-push hook fails on files outside
  this work (untracked `Plans/ci-cost-policy/`). Push and signing are manual.
