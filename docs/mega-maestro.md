---
title: Mega-Maestro (Managed Operation)
description: How a Maestro installation is enrolled with a Mega-Maestro endpoint, what management admits and refuses today, how to start, test and recover it, and which producers are still missing.
icon: building-shield
---

Managed operation lets an enterprise endpoint (Mega-Maestro) apply policy to a Maestro installation: which launches are admitted, under which identity, with what evidence coming back. This page is the public handoff for the integration branch `feature/mega-maestro-v1.1.0-rc`. It says what is wired and exercised, what is refused by name, and what still needs a producer on the Mega-Maestro side. It does not claim a complete enterprise product: every "passed" below was observed against real Maestro code, and every gap is named with its owner.

## What it is, and what it is not

It is:

- **Admission at the sink.** The desktop process manager, the headless runtime, the CLI, Cue, the permission relay and the plugin host each ask an authority for a lease right before the spawn or the effect. A context (who asks, from which installation, under which run) is attribution; the authority binds tenant, device, actor, policy revision and run identity itself. Nothing is admitted on the context's own word.
- **Fail closed.** A route the installation cannot enforce answers `unsupported`; an authority that cannot be reached answers `unavailable`; a lost answer is `unknown`. None of them falls back to an unmanaged launch. Standalone (unenrolled) behavior is unchanged: nothing is listed, nothing is decided, and the tests say so by name.
- **Metadata out, bodies held.** Lifecycle, usage and inventory leave the host as metadata under the negotiated collection profile. Prompts, answers, paths, tokens and account identifiers never cross the wire; the integration tests plant canaries and check.

It is not:

- **Not an enterprise product.** The endpoint, its API, console and gateway are Mega-Maestro's. Maestro consumes the public contract by digest and never reads the sibling repository at run time.
- **Not qualified real-provider enforcement.** Only the launch of a child-process route is admitted. What Claude, Codex or OpenCode does once running (its tools, files and network) is not governed here. The one route whose effects are enforced is the synthetic harness below.
- **Not a channel for private recording.** The desktop's private per-agent recording and export machinery and its local store are not an enterprise collection channel: nothing managed reads it, exposes its configuration, or puts its controls into an agent prompt. The lifecycle projector has its own producers (the agent-run capture, the turn recorder) and the private recording is not one of them.

## Where it stands

| Milestone                                       | Observed                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Maestro-side seams (phases 01 to 11)            | Built and covered by deterministic tests over injected custody, clocks and endpoint doubles; the real desktop composition (`createEnterpriseService`) runs in the integration tests against a labeled double of the daemon.                                                                   |
| Real pair (`scripts/mega-maestro-pair.mjs run`) | The real endpoint starts in its Linux container and answers the real socket client, but it is unenrolled and no producer approves the actor registration. The last run ended with exit code 3 (completed, not certifiable), 5 journeys blocked, 0 leases minted.                              |
| Acceptance rows                                 | Every required row of the plan's acceptance matrix is recorded `passed: false` in `Plans/mega-maestro-rc/evidence/*.json`: positive behavior at the Maestro boundary, the real pair as a failed attempt. The missing producers are listed in [Residual requirements](#residual-requirements). |

## Start

**Desktop.** Settings, Environment tab, "Mega-Maestro management". The pane is a diagnostics surface: it shows the standing the main process projects and offers three verbs (refresh the policy, recover the standing, complete a registration). Enrollment is requested through `window.maestro.enterprise.requestEnrollment` with the endpoint's socket path, the invitation, the collection profile, the trust root digest and the key possession proof the endpoint tooling produced, plus the tenant and org asserted from the invitation; the endpoint answers `enrollment_pending` until its administrator approves. Registration then hands back a one-time approval code shown once and never stored. Nothing here switches management off: a record the endpoint still manages is released by the endpoint administrator, and a local retire or forget is refused with `management-required`.

The standing words (`managed-state.ts`), best to worst: `managed`, `stale`, `unregistered`, `offline`, `denied`, `suspended`, `enrolling`, `revoked`, `retired`, `custody-refused`, `unenrolled`. Only `managed` admits. The record lives in the data directory as `enterprise-identity.bin`, sealed with the key the OS holds for the desktop app and anchored in the keyring so a rolled-back or copied file reads `untrusted`. Beside it: `maestro-managed-binding.json`, `maestro-managed-dispatch-receipts.json`, `maestro-managed-workflows.json`, `maestro-managed-events.json`, the command ledger and `maestro-managed-inbox-receipts.json`.

**Headless host.** `maestro-cli host start` composes the same parts when it holds protected custody for the record and prints `Managed: ...` at start; `maestro-cli host status --json` reports `managed` (the attested standing and the SSH route table) or `managedUnavailable` (why none). A plain Node process holds the keyring anchor but not the Electron seal, so a detached host of this build composes nothing and says so. `maestro-cli cue engine start` on an enrolled machine has no standing to claim under and refuses every Auto Run as unavailable.

**Library.** A host injects its own custody and socket: `createMaestroRuntime({ managed: { host, workflowFence } })` with `createManagedHostAdapter()`. The library never opens a socket or reads a keyring itself. See [maestro-lib](./maestro-lib#managed-operations).

## What management admits and refuses

The per-route table is `providerRouteSupport(agentId)`, and `Plans/mega-maestro-rc/support-matrix.json` is its export for this build (the command that regenerates it is recorded in the file). The words are `implemented`, `unverified`, `unsupported` and `unsupported-by-counterpart`; a caller that reads anything but `implemented` refuses. The last word marks a row whose Maestro consumer exists while the producer belongs to Mega-Maestro and is not yet published; the file's `counterpart` section lists those rows (the endpoint operations `command`, `workflow`, `offline`, `enrollment` and `budget`; the `pause_run` and `resume_run` command actions; OS peer authentication on macOS and Windows) with the owner, the dependency id and the counterpart source line as evidence.

| Route              | Standalone                                                                                                      | Managed                                                                                                                                                       |
| ------------------ | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `child-process`    | `implemented` for every provider with a batch mode (all 11 visible)                                             | `implemented`: the launch is admitted at the real spawn; provider-internal tool, file and network effects are not governed                                    |
| `pty`              | `implemented` for Claude Code, Qwen3 Coder, Copilot-CLI; `unverified` for providers that need a prompt to start | `unsupported`                                                                                                                                                 |
| `codex-app-server` | `implemented` for Codex only                                                                                    | `unsupported`                                                                                                                                                 |
| `opencode-server`  | `implemented` for OpenCode only                                                                                 | `unsupported`                                                                                                                                                 |
| `ssh`              | `unverified` (the remote launch exists; containment there is not proven)                                        | `unsupported`; a remote that attests a registered authority with `managed: implemented` on its own `ssh` row would qualify, and no build of this version does |

Two readings of that table matter. Hermes shows `implemented` on `child-process` because the capability table gives it a batch mode, but `planSessionTurn` refuses it with `no-parser`, so no Hermes turn runs on any surface. And `implemented` under `managed` means the launch, not the provider: an enrolled desktop with the reviewed endpoint refuses every real launch as `unavailable`, because the broker's effect authority and the delegation producer are not there (CP-01, CP-03). What does run end to end is the synthetic harness route (`syntheticHarnessRouteSupport()`): an inline Node program under `node --permission`, allowed to read exactly its declared inputs and write exactly its private work directory, with the network, child processes and workers refused by the runtime. It needs a Node that honors `--allow-net` (Node 26 does, the endpoint's pinned container image at Node 22.16 does not) and is not offered on Windows.

Everything else a managed host does is decided under a registered standing and refused by name otherwise: Auto Run attempts need an owner fence from the workflow producer (none mints one locally); group chat turns and consults carry a delegation chain the reviewed bridge rejects; a managed SSH launch is refused at the launch plan unless the remote is qualified; approved credential references resolve once at the launch boundary and a personal-login fallback, a custom base URL or a bypassing argument is refused; plugin grants, browser relay effects and Symphony repository effects are intersected with the signed ceiling. Typed commands (`cancel_run`, `report_status`, `refresh_policy`) execute on the desktop under a registered actor; `pause_run`, `resume_run` and `operator_prompt` have no desktop producer and are refused by name.

## Test

Build, package and check the pair from the repository root:

```bash
npm run build:maestro-lib                         # dist/maestro-lib (about 10 s)
npm run package:mega-maestro-runtime              # dist/mega-maestro-runtime/<version>/<sha256>/
node scripts/mega-maestro-pair.mjs check --json   # exit 0: a certifiable pair can run; 2: a named producer blocks it
node scripts/mega-maestro-pair.mjs run --runtime dist/mega-maestro-runtime/<version>/<sha256> --out evidence.json
```

`run` needs Docker on a Linux-capable host and the sibling endpoint source or a packaged artifact; it exits 0 for a certifiable pass, 3 for a completed run that is not certifiable (a dirty endpoint source, a stale library or a missing producer), 1 for a container failure. Each run leaves `.maestro/playbooks/Working/pair-<stamp>/` with the driver log and the endpoint's answers. A new commit makes the packaged runtime `stale` until it is repackaged; `--allow-stale` records that instead of refusing.

The integration tests under `src/__tests__/integration/mega-maestro/` run without Docker:

| File                       | What it proves                                                                                                                                                                                           |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `early-pair.test.ts`       | The synthetic harness route through the protected dispatch: allow with observed effects, deny before any effect, replay, changed inputs, wrong runtime, endpoint loss.                                   |
| `full-pair.test.ts`        | The journeys catalog against the endpoint double; every managed origin; revoke and re-register; fleet evidence, usage, VIBES, TRACE, governance, commands and notices over the real desktop composition. |
| `offline-recovery.test.ts` | The daemon gone at start, dropped mid-session, a host restart over the same data directory, a revoked registration, another schema version.                                                              |
| `standalone.test.ts`       | The built library loads in plain Node with no Electron, exports exactly what the source entry exports, reports the same capability matrix the packager writes, and unmanaged behavior is preserved.      |

```bash
node node_modules/vitest/vitest.mjs run src/__tests__/integration/mega-maestro
```

A case that needs a missing producer is skipped by that producer's name and a non-skipped case asserts the naming; no required case passes through a skip.

## Recover

- **Endpoint offline.** The record and the installed policy stay in force; every managed port answers `unavailable` by name, nothing is admitted and nothing is journaled as sent. A bound lease and its live child are left alone. When the socket is back, "Recover" (or `connect()`) re-attaches and the telemetry client resumes, each journal entry answered once.
- **Host restart.** The receipts, the event journal and the inbox receipts are read as they were; a receipt whose lease was live reads `unknown` ("the host restarted while this lease was live"). The endpoint wants a registration again before anything is admitted: "Complete registration" redeems it.
- **Revoked registration.** Admission and refresh turn `unauthenticated`; `revokeAll` ends live children; a completed registration restores admission. A `revoked` or `retired` record is final and may be forgotten; a managed record is released only by the endpoint.
- **Custody refused.** An unprotected seal (no OS key, Linux `basic_text`), a missing anchor or a stale record reads `custody-refused`, and nothing managed runs. Fix the custody (or `acknowledgeUntrusted` after inspection); never copy the file between devices.
- **Another schema version.** A daemon speaking another version is refused `unsupported_version` at compatibility and at attach; nothing is admitted and nothing is sent.

## Residual requirements

Producers owned by Mega-Maestro, each checked by `mega-maestro-pair.mjs check` and named in `report.producers`:

- **CP-01**, current public contracts and a clean packaged endpoint artifact: `vendor/mega-maestro/contracts.pin.json` is absent, so the collection ceiling is harness-installed and no fleet record exists to compare against.
- **CP-02**, a supported `createMaestroAdapter`: the reviewed one is unsupported, the daemon serves no command operation on the runtime socket, and `headless.turn` cannot pass.
- **CP-03**, authenticated delegation and workflow authority: the bridge rejects any delegation chain, grant reference or workflow fence, so Auto Run, group chat and consults are refused on an enrolled host.
- **registration-approval** (CP-04 in the plan): no API or console approves the actor registration, so the real daemon never reaches an attached standing and the registration names no actor; notice custody at the endpoint is development-only.

Platform: identity custody needs Electron safeStorage or an equivalent protected seal (a plain Node host composes none); the harness route needs the Node permission flags and a POSIX host; the endpoint's pinned container runs Node 22.16 without `--allow-net`.

Maestro-owned gaps, open and recorded in `Plans/mega-maestro-rc/evidence/11.json`: pause and resume of a running turn, a desktop prompt port, the usage producer composed into the process stream, commands and inbox on `maestro-cli host`, a public documentation navigation entry for this page, and a hardening pass on how lineage identity is copied.

## See also

- [maestro-lib](./maestro-lib) for the library surface the managed contracts are exported from, release by release.
- [Maestro CLI](./cli#headless-host-maestro-cli-host) for `maestro-cli host`.
- `Plans/mega-maestro-rc/` in the repository: the execution rules, the plan and its evidence.
- `Plans/mega-maestro/evidence/handoff.json`: the handoff manifest at the path the integration design names, written by `scripts/write-mega-maestro-handoff.mjs` (the implementation-tree and library digests, the open producers, the local and joint status); the digest-verified copy of the counterpart's `joint-integration.json` belongs beside it, written only by `scripts/import-joint-integration.mjs` when the record names this checkout's revision, implementation-tree digest and built library, while the Phase 1 evidence stays under `Plans/mega-maestro-rc/`.
