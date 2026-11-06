---
type: execution-order
title: Integration completion stage order
created: 2026-11-05
tags: [autorun, integration, handoff]
---

# Stage order

Related: [[README]], [[EXECUTION-RULES]]. Generated from `program.json` as amended on
2026-11-05. Launch one stage per batch with its owning agent, after the receipts
the stage requires exist. A stage with no inputs can start at once.

Do not launch a qualification document in the same batch as the implementation
document that produces its input unless that implementation document is already
complete. The desktop runner skips a stalled document and moves on, so the
qualification document would run with its input missing and only leave a note.

| Stage | Owner        | Documents                                                                                          | Tasks | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----- | ------------ | -------------------------------------------------------------------------------------------------- | ----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S01   | mega-maestro | GCOMP-01                                                                                           |    32 | Versioned public contracts and reproducible producer delivery                                                                                                                                                                                                                                                                                                                                                                                                                               |
| S01Q  | mega-maestro | GCOMP-02                                                                                           |     1 | Versioned public contracts and reproducible producer delivery                                                                                                                                                                                                                                                                                                                                                                                                                               |
| S02   | maestro      | MCOMP-01, MCOMP-02, MCOMP-03, MCOMP-04                                                             |    38 | Stabilize the current Maestro integration and preserve upstream work; Publish the current public runtime bootstrap before counterpart adapter work                                                                                                                                                                                                                                                                                                                                          |
| S03   | mega-maestro | GCOMP-03, GCOMP-04, GCOMP-05, GCOMP-06, GCOMP-07, GCOMP-08                                         |    46 | Scoped actor registration and real signed policy consumer; Pinned public Maestro runtime adapter; Protected Linux endpoint custody and service identity; Exact prepared execution and durable authority leases; Constrained effect backend and first real managed run                                                                                                                                                                                                                       |
| S04   | maestro      | MCOMP-07, MCOMP-08, MCOMP-09                                                                       |    17 | Publish early actor, desktop and provider consumer contracts; Close mandatory admission and protected headless standing defects                                                                                                                                                                                                                                                                                                                                                             |
| S05   | mega-maestro | GCOMP-09, GCOMP-10, GCOMP-11                                                                       |     3 | Scoped actor registration and real signed policy consumer; Protected Linux endpoint custody and service identity; Exact prepared execution and durable authority leases                                                                                                                                                                                                                                                                                                                     |
| S06   | maestro      | MCOMP-10, MCOMP-13                                                                                 |     7 | Close mandatory admission and protected headless standing defects; Consume prepared execution and per-effect authority with an early real pair                                                                                                                                                                                                                                                                                                                                              |
| S07   | mega-maestro | GCOMP-12                                                                                           |     1 | Constrained effect backend and first real managed run                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| S08   | maestro      | MCOMP-14                                                                                           |     1 | Consume prepared execution and per-effect authority with an early real pair                                                                                                                                                                                                                                                                                                                                                                                                                 |
| S09   | mega-maestro | GCOMP-13, GCOMP-14, GCOMP-15, GCOMP-16, GCOMP-17, GCOMP-18, GCOMP-19, GCOMP-20, GCOMP-21           |    73 | Principal-scoped desktop authoring and settings policies; Authenticated delegation and durable workflow fencing; Actual signed run commands and private notice actions; Governed usage content provenance and detection telemetry; Offline budget and policy freshness on real runtime routes; Native macOS peer service custody and constrained effects; Native Windows peer service custody and constrained effects; Real provider transport qualification without customer account gates |
| S10   | maestro      | MCOMP-15, MCOMP-16, MCOMP-17                                                                       |    12 | Consume policy projections and usable approved desktop choices; Consume workflow ownership and authenticated delegation without hardcoded denial                                                                                                                                                                                                                                                                                                                                            |
| S11   | mega-maestro | GCOMP-22, GCOMP-23                                                                                 |     2 | Authenticated delegation and durable workflow fencing; Offline budget and policy freshness on real runtime routes                                                                                                                                                                                                                                                                                                                                                                           |
| S12   | maestro      | MCOMP-18, MCOMP-19, MCOMP-20, MCOMP-21, MCOMP-22, MCOMP-23, MCOMP-24, MCOMP-25, MCOMP-26, MCOMP-27 |    45 | Consume workflow ownership and authenticated delegation without hardcoded denial; Close native desktop residual effects and CLI parity; Close concrete remaining headless custody lock and after-effect gaps; Build complete policy-guided native GUI agent creation and editing; Deliver visible policy-governed native GUI execution and recovery; Wire actual lifecycle usage content and evidence delivery                                                                              |
| S13   | mega-maestro | GCOMP-24                                                                                           |     1 | Governed usage content provenance and detection telemetry                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| S14   | maestro      | MCOMP-28, MCOMP-29                                                                                 |     6 | Wire actual lifecycle usage content and evidence delivery; Complete typed communications and usable end-user notices                                                                                                                                                                                                                                                                                                                                                                        |
| S15   | mega-maestro | GCOMP-25                                                                                           |     1 | Actual signed run commands and private notice actions                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| S16   | maestro      | MCOMP-30, MCOMP-31                                                                                 |     7 | Complete typed communications and usable end-user notices; Qualify actual provider routes and native platforms without fallback                                                                                                                                                                                                                                                                                                                                                             |
| S17   | mega-maestro | GCOMP-26, GCOMP-27, GCOMP-28                                                                       |     3 | Native macOS peer service custody and constrained effects; Native Windows peer service custody and constrained effects; Real provider transport qualification without customer account gates                                                                                                                                                                                                                                                                                                |
| S18   | maestro      | MCOMP-32, MCOMP-33                                                                                 |     6 | Qualify actual provider routes and native platforms without fallback; Package repaired public runtime and verify the complete native application pair                                                                                                                                                                                                                                                                                                                                       |
| S19   | mega-maestro | GCOMP-29, GCOMP-30                                                                                 |     9 | Final immutable delivery and full desktop integration acceptance                                                                                                                                                                                                                                                                                                                                                                                                                            |
| S20   | maestro      | MCOMP-34                                                                                           |     1 | Package repaired public runtime and verify the complete native application pair                                                                                                                                                                                                                                                                                                                                                                                                             |

## S01 inputs

None; independent starting batch.

## S01Q inputs

`MEGA-CONTRACTS-FOUNDATION-BUILD`

## S02 inputs

None; independent starting batch.

## S03 inputs

`MAESTRO-M0-RUNTIME-BUILD`, `MEGA-CONTRACTS-FOUNDATION`, `MEGA-CONTRACTS-FOUNDATION-BUILD`

## S04 inputs

`MAESTRO-M0-RUNTIME-BUILD`, `MEGA-ACTOR-POLICY-BUILD`, `MEGA-CONTRACTS-FOUNDATION-BUILD`

## S05 inputs

`MAESTRO-ACTOR-BRIDGE-BUILD`, `MAESTRO-DESKTOP-CONTRACT-BUILD`, `MAESTRO-M0-RUNTIME-BUILD`, `MAESTRO-P0-CLOSURE-BUILD`, `MAESTRO-PROVIDER-CONTRACT-BUILD`, `MEGA-ACTOR-POLICY-BUILD`, `MEGA-CONTRACTS-FOUNDATION`, `MEGA-PREPARED-AUTHORITY-BUILD`, `MEGA-PROTECTED-LINUX-BUILD`, `MEGA-RUNTIME-ADAPTER`

## S06 inputs

`MAESTRO-M0-RUNTIME`, `MAESTRO-P0-CLOSURE-BUILD`, `MEGA-ACTOR-POLICY-BUILD`, `MEGA-CONTRACTS-FOUNDATION-BUILD`, `MEGA-PREPARED-EXECUTION-BUILD`, `MEGA-RUNTIME-ADAPTER-BUILD`

## S07 inputs

`MAESTRO-EFFECT-CONSUMERS-BUILD`, `MEGA-PREPARED-AUTHORITY`, `MEGA-PREPARED-EXECUTION-BUILD`

## S08 inputs

`MAESTRO-EFFECT-CONSUMERS-BUILD`, `MEGA-ACTOR-POLICY-BUILD`, `MEGA-PREPARED-EXECUTION-BUILD`, `MEGA-RUNTIME-ADAPTER-BUILD`

## S09 inputs

`MAESTRO-ACTOR-BRIDGE-BUILD`, `MAESTRO-DESKTOP-CONTRACT-BUILD`, `MAESTRO-PROVIDER-CONTRACT-BUILD`, `MEGA-ACTOR-POLICY`, `MEGA-ACTOR-POLICY-BUILD`, `MEGA-PREPARED-EXECUTION`, `MEGA-PREPARED-EXECUTION-BUILD`, `MEGA-RUNTIME-ADAPTER`, `MEGA-RUNTIME-ADAPTER-BUILD`, `PAIR-ACTOR-POLICY-EVIDENCE`, `PAIR-DIRECT-EVIDENCE`

## S10 inputs

`MAESTRO-EFFECT-CONSUMERS-BUILD`, `MEGA-ACTOR-POLICY-BUILD`, `MEGA-DESKTOP-POLICY-BUILD`, `MEGA-PREPARED-EXECUTION`, `MEGA-WORKFLOW-BUILD`, `PAIR-DIRECT-EVIDENCE`

## S11 inputs

`MAESTRO-WORKFLOW-CONSUMERS-BUILD`, `MEGA-DESKTOP-POLICY`, `MEGA-OFFLINE-RUNTIME-BUILD`, `MEGA-PREPARED-EXECUTION`, `MEGA-WORKFLOW-BUILD`, `PAIR-DIRECT-EVIDENCE`

## S12 inputs

`MAESTRO-EFFECT-CONSUMERS`, `MAESTRO-EFFECT-CONSUMERS-BUILD`, `MAESTRO-WORKFLOW-CONSUMERS-BUILD`, `MEGA-ACTOR-POLICY-BUILD`, `MEGA-COLLECTION-BUILD`, `MEGA-DESKTOP-POLICY-BUILD`, `MEGA-PREPARED-EXECUTION`, `MEGA-PREPARED-EXECUTION-BUILD`, `MEGA-WORKFLOW-BUILD`, `PAIR-DIRECT-EVIDENCE`

## S13 inputs

`MAESTRO-COLLECTION-CONSUMERS-BUILD`, `MEGA-COLLECTION-BUILD`, `MEGA-DESKTOP-POLICY`, `MEGA-PREPARED-EXECUTION`, `PAIR-DIRECT-EVIDENCE`

## S14 inputs

`MAESTRO-COLLECTION-CONSUMERS-BUILD`, `MAESTRO-DESKTOP-APP`, `MAESTRO-WORKFLOW-CONSUMERS-BUILD`, `MEGA-COLLECTION-BUILD`, `MEGA-COMMANDS-BUILD`

## S15 inputs

`MAESTRO-COMMAND-CONSUMERS-BUILD`, `MEGA-COMMANDS-BUILD`, `MEGA-PREPARED-EXECUTION`, `MEGA-WORKFLOW`, `PAIR-DIRECT-EVIDENCE`

## S16 inputs

`MAESTRO-COMMAND-CONSUMERS-BUILD`, `MAESTRO-DESKTOP-APP`, `MEGA-COMMANDS-BUILD`, `MEGA-DESKTOP-POLICY-BUILD`, `MEGA-NATIVE-MACOS-BUILD`, `MEGA-NATIVE-WINDOWS-BUILD`, `MEGA-QUALIFIED-PROVIDERS-BUILD`

## S17 inputs

`MAESTRO-ACTOR-BRIDGE-BUILD`, `MAESTRO-APP-MACOS-BUILD`, `MAESTRO-APP-WINDOWS-BUILD`, `MAESTRO-DESKTOP-CONTRACT-BUILD`, `MAESTRO-PROVIDER-CONTRACT-BUILD`, `MAESTRO-PROVIDER-ROUTES-BUILD`, `MEGA-DESKTOP-POLICY`, `MEGA-NATIVE-MACOS-BUILD`, `MEGA-NATIVE-WINDOWS-BUILD`, `MEGA-PREPARED-EXECUTION`, `MEGA-QUALIFIED-PROVIDERS-BUILD`, `PAIR-DIRECT-EVIDENCE`, `RUNNER-MACOS`, `RUNNER-WINDOWS`

## S18 inputs

`MAESTRO-APP-MACOS-BUILD`, `MAESTRO-APP-WINDOWS-BUILD`, `MAESTRO-DESKTOP-APP`, `MAESTRO-DESKTOP-APP-BUILD`, `MAESTRO-PROVIDER-ROUTES-BUILD`, `MAESTRO-WORKFLOW-CONSUMERS-BUILD`, `MEGA-COLLECTION-BUILD`, `MEGA-COMMANDS-BUILD`, `MEGA-DESKTOP-POLICY-BUILD`, `MEGA-QUALIFIED-PROVIDERS-BUILD`, `MEGA-RUNTIME-ADAPTER-BUILD`

## S19 inputs

`MAESTRO-DESKTOP-APP-BUILD`, `MAESTRO-FINAL-CONSUMERS-BUILD`, `MEGA-COLLECTION`, `MEGA-COLLECTION-BUILD`, `MEGA-COMMANDS`, `MEGA-COMMANDS-BUILD`, `MEGA-DESKTOP-POLICY`, `MEGA-DESKTOP-POLICY-BUILD`, `MEGA-NATIVE-MACOS`, `MEGA-NATIVE-MACOS-BUILD`, `MEGA-NATIVE-WINDOWS`, `MEGA-NATIVE-WINDOWS-BUILD`, `MEGA-OFFLINE-RUNTIME`, `MEGA-OFFLINE-RUNTIME-BUILD`, `MEGA-QUALIFIED-PROVIDERS`, `MEGA-QUALIFIED-PROVIDERS-BUILD`, `MEGA-WORKFLOW`, `MEGA-WORKFLOW-BUILD`

## S20 inputs

`MAESTRO-DESKTOP-APP`, `MAESTRO-FINAL-CONSUMERS-BUILD`, `MAESTRO-WORKFLOW-CONSUMERS`, `MEGA-COLLECTION-BUILD`, `MEGA-COMMANDS-BUILD`, `MEGA-DESKTOP-POLICY-BUILD`, `MEGA-FINAL-INTEGRATION`, `MEGA-QUALIFIED-PROVIDERS-BUILD`, `MEGA-RUNTIME-ADAPTER-BUILD`
