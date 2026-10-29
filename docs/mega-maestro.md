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

## Drive it from maestro-cli

Every action the management pane offers has a `maestro-cli managed` verb that reaches the same function: `EnterpriseService.managed` (`createManagedOperations()` in `src/main/enterprise/service.ts`), the one facade the pane, the `enterprise:*` IPC handlers and the bridge handlers read, so an agent and a person see the same projection and the same refusal. Each verb sends one typed message over the desktop's WebSocket bridge (`managed_status`, `managed_inventory`, `managed_support_matrix`, `managed_locks`, `managed_policy_refresh`, `managed_enroll_request`, `managed_inbox_list`, `managed_inbox_act`, `managed_command`, `managed_command_status`, answered in `src/main/web-server/handlers/messageHandlers/managed.ts`). A missing desktop is exit 3, an older desktop that does not answer the message is exit 4, a desktop with no enterprise service is exit 1 with its own line, and every write prints the durable receipt or the word `unknown` when this host recorded the act and never saw the endpoint's answer. Nothing printed is a secret: every answer is the pane's projection, and the enrollment request (the one secret-carrying input) is read from a file, relayed once and never echoed, not even in an error. `maestro-cli open managed-status` (aliases `mega-maestro`, `enterprise`, `managed-inbox`) opens the pane itself.

| Verb                                                                                   | Pane action                                                                                     | What it answers                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `managed status`                                                                       | The standing block (enrollment, installation, endpoint, actor, policy, capabilities, admission) | `projectManagedState()` over the lifecycle, the policy status, custody and the egress, update and listener holds                                                                                       |
| `managed inventory`                                                                    | The Installation row                                                                            | `createInstallationInventory()`: versions, providers, collection health, gaps                                                                                                                          |
| `managed support-matrix`                                                               | The Capabilities row                                                                            | This build's capability rows, the counterpart rows and every pickable provider per route                                                                                                               |
| `managed locks`                                                                        | The Managed badge and the disabled sections in Settings                                         | `readManagedSettingLocks()`: every held key with the line a refused write is named with, and the Encore flags the policy pins                                                                          |
| `managed policy refresh`                                                               | Refresh policy                                                                                  | Re-attaches over the registered socket for a fresh policy status                                                                                                                                       |
| `managed enroll request --file <json>`                                                 | The enrollment request (`window.maestro.enterprise.requestEnrollment`)                          | Relays the file's request (socket path, tenant, org, mode, collection profile, trust root digest, invitation, key possession proof); CLI-secret clients only, a browser never enrolls                  |
| `managed inbox list [--held] [--bodies]`                                               | Refresh notices                                                                                 | The endpoint listing, with `delivered` recorded for every notice newly held, or with `--held` what this host holds; a body is for the person at the terminal and prints only under `--bodies`          |
| `managed inbox read <id>`, `ack <id>`, `reply <id> -m <text>`                          | Mark read, Acknowledge, Reply                                                                   | One receipt on the inbox ledger, attributed to the transport that admitted the caller (a paired Lite device with no registered actor is refused); `--campaign` when one id is held under two campaigns |
| `managed command status`                                                               | None (no pane reads the ledger)                                                                 | The command ledger: total, open, by state                                                                                                                                                              |
| `managed command cancel-run <runId>`, `report-status`, `refresh-policy [--revision n]` | None (no pane issues a command)                                                                 | A local operator's typed command, bound to the standing of the moment and recorded in the same ledger as an endpoint command; pause and resume are not offered (CP-05)                                 |

Two pane actions have no verb yet, Recover standing (`recoverPolicy`) and Complete registration (`completeRegistration`); they are recorded as Open gaps in `docs/agent-guides/CLI-UI-PARITY.md`, which keeps one Covered row per pane action above. The headless host (`maestro-cli host`) answers none of these verbs: they need the desktop bridge.

## What management admits and refuses

The per-route table is `providerRouteSupport(agentId)`, and `Plans/mega-maestro-rc/support-matrix.json` is its export for this build (the command that regenerates it is recorded in the file). The words are `implemented`, `unverified`, `unsupported` and `unsupported-by-counterpart`; a caller that reads anything but `implemented` refuses. The last word marks a row whose Maestro consumer exists while the producer belongs to Mega-Maestro and is not yet published; the file's `counterpart` section lists those rows (the endpoint operations `command`, `workflow`, `offline`, `enrollment` and `budget`; the `pause_run` and `resume_run` command actions; OS peer authentication on macOS and Windows) with the owner, the dependency id and the counterpart source line as evidence. The rows, at counterpart revision `COUNTERPART_SUPPORT_REVISION` in `src/shared/maestro-lib/managed/compatibility.ts`:

| Row                                                   | Dependency | Maestro consumer that refuses today                                                                                                                                            |
| ----------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `endpoint.command`                                    | CP-04      | `src/main/enterprise/commands.ts`; the endpoint serves attachment, compatibility, telemetry, inbox, noticeList, execution and model only                                       |
| `endpoint.workflow`                                   | CP-04      | `src/shared/maestro-lib/managed/workflows.ts` (owner fences, with CP-03)                                                                                                       |
| `endpoint.offline`, `endpoint.budget`                 | CP-04      | None built; both are in the shared endpoint-port vocabulary only (usage leaves through telemetry)                                                                              |
| `endpoint.enrollment`                                 | CP-04      | `src/main/enterprise/enrollment.ts` (enroll, rotate, revoke, retire)                                                                                                           |
| `command.pause_run`, `command.resume_run`             | CP-05      | `DESKTOP_UNCOMPOSED_COMMANDS` in `src/main/enterprise/commands.ts` answers each unsupported by name; neither the pane nor `maestro-cli managed command` offers them            |
| `transport.os-peer.darwin`, `transport.os-peer.win32` | CP-06      | OS peer authentication is Linux only: a macOS or Windows Maestro cannot be managed through this endpoint, and every application artifact records `nativeEndpoint: unsupported` |

| Route              | Standalone                                                                                                      | Managed                                                                                                                                                       |
| ------------------ | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `child-process`    | `implemented` for every provider with a batch mode (all 11 visible)                                             | `implemented`: the launch is admitted at the real spawn; provider-internal tool, file and network effects are not governed                                    |
| `pty`              | `implemented` for Claude Code, Qwen3 Coder, Copilot-CLI; `unverified` for providers that need a prompt to start | `unsupported`                                                                                                                                                 |
| `codex-app-server` | `implemented` for Codex only                                                                                    | `unsupported`                                                                                                                                                 |
| `opencode-server`  | `implemented` for OpenCode only                                                                                 | `unsupported`                                                                                                                                                 |
| `ssh`              | `unverified` (the remote launch exists; containment there is not proven)                                        | `unsupported`; a remote that attests a registered authority with `managed: implemented` on its own `ssh` row would qualify, and no build of this version does |

Two readings of that table matter. Hermes shows `implemented` on `child-process` because the capability table gives it a batch mode, but `planSessionTurn` refuses it with `no-parser`, so no Hermes turn runs on any surface. And `implemented` under `managed` means the launch, not the provider: an enrolled desktop with the reviewed endpoint refuses every real launch as `unavailable`, because the broker's effect authority and the delegation producer are not there (CP-01, CP-03). What does run end to end is the synthetic harness route (`syntheticHarnessRouteSupport()`): an inline Node program under `node --permission`, allowed to read exactly its declared inputs and write exactly its private work directory, with the network, child processes and workers refused by the runtime. It needs a Node that honors `--allow-net` (Node 26 does, the endpoint's pinned container image at Node 22.16 does not) and is not offered on Windows.

Everything else a managed host does is decided under a registered standing and refused by name otherwise: Auto Run attempts need an owner fence from the workflow producer (none mints one locally); group chat turns and consults carry a delegation chain the reviewed bridge rejects; a managed SSH launch is refused at the launch plan unless the remote is qualified; approved credential references resolve once at the launch boundary and a personal-login fallback, a custom base URL or a bypassing argument is refused; plugin grants, browser relay effects and Symphony repository effects are intersected with the signed ceiling. Typed commands (`cancel_run`, `report_status`, `refresh_policy`) execute on the desktop under a registered actor; `pause_run`, `resume_run` and `operator_prompt` have no desktop producer and are refused by name.

## What a policy holds

Three ceilings and one lock model come with a policy revision. No endpoint operation of this build carries any of them (CP-01), so nothing installs one: an enrolled desktop refuses every held thing `unavailable` by name, and standalone none of them is consulted.

**Settings locks** (`src/shared/managedSettingsLock.ts`, held by `src/main/enterprise/settings-policy.ts`). A policy names the keys it holds; a lock may also pin the key to one value, restored at startup and on every policy change. Which keys a policy may hold is the metadata's call alone: a settings key is lockable only where `SETTINGS_METADATA` marks it so (its value reaches a shell, a network, a credential, a reporting channel or a feature gate), and a sensitive key may be locked but never pinned. Beside the settings keys: the per-provider configuration fields as `agentConfig.customPath`, `agentConfig.customArgs`, `agentConfig.customEnvVars`, `agentConfig.model` and `agentConfig.reasoningEffort` (locked, never pinned); the admin sets `prompts.customizations`, `plugins.installed` and `storage.syncPath`; the remote-access actions `web.liveSessions`, `web.tunnel` and `lite.control` (locked, never pinned: turning the action on is refused and its sink ends what is on, turning it off is never held); and one `encore.<flag>` key per Encore Feature, always pinned on or off, since management itself is never a flag a person switches. A refused write is named with a stable code: `locked` (the key is held, with the line "locked by managed policy revision N" or "locked and pinned"), `unavailable` (enrolled, no policy installed) or `custody` (a credential the plain settings file would keep, refused on every managed host). `maestro-cli managed locks` and the Managed badge in Settings read the same view.

**Egress** (`src/main/enterprise/egress-policy.ts`). Every main-process HTTP request leaves through `fetchWithTimeout()` naming a destination class: `vendor-telemetry` (check-in, Cue stats, the leaderboard, the 0din exchange), `updates`, `provider-account` (a provider's account pages polled for usage or credits), `content` (documents, images, catalogs, marketplace manifests; the default), `github` (the GitHub API outside `gh`), `plugin`, `user-webhook` and `enterprise-endpoint` (the management endpoint, reached over a Unix socket and never through here). The ceiling admits classes, each to a bounded list of destination patterns (`*`, `host`, `*.host`, `scheme://host:port`), and a `provider-account` request is held once more by the opaque account reference it carries. A class the ceiling does not name leaves nothing, so vendor telemetry is off on a managed host unless the policy lists it. Refusals: `url-invalid`, `class-denied`, `destination-denied`, `account-denied`, `unauthenticated`, `unavailable`.

**Listeners** (`src/main/enterprise/listener-policy.ts`). Every socket Maestro opens for others to reach is a listener of a closed kind: `web` (the fastify server behind maestro-cli and Live Mode), `tunnel` (the cloudflared quick tunnel), `ssh-tunnel` (a Lite client's `ssh -L` forward), `lite-control`, `tailnet`, `mdns`, `cue-webhook`, `cue-status`, `relay` (the permission relay bridge), `steering` (the maestro-p steering socket) and `coworking` (the coworking MCP server). The ceiling says how far a kind may reach: `loopback`, `tailnet`, `lan`, `any` or `public` (only a tunnel ever is). The policy answers before the bind, so a forbidden listener never exists for a moment; a kind it does not list may not bind at all. Refusals: `kind-denied`, `reach-denied`, `unavailable`.

**Updates** (`src/main/enterprise/update-policy.ts`). The policy may hold updates entirely, fix the channel (`stable` caps the person's prerelease opt-in; `prerelease` leaves the setting to decide) or pin one version; a candidate is held before a feed is read or a byte is downloaded. Refusals: `held`, `channel-denied`, `pin-denied`, `unavailable`.

## Test

Build, package and check the pair from the repository root:

```bash
npm run build:maestro-lib                         # dist/maestro-lib (about 10 s)
npm run package:mega-maestro-runtime              # dist/mega-maestro-runtime/<version>/<sha256>/
node scripts/mega-maestro-pair.mjs check --json   # exit 0: a certifiable pair can run; 2: a named producer blocks it
node scripts/mega-maestro-pair.mjs run --runtime dist/mega-maestro-runtime/<version>/<sha256> --out evidence.json
```

`run` needs Docker on a Linux-capable host and the sibling endpoint source or a packaged artifact; it exits 0 for a certifiable pass, 3 for a completed run that is not certifiable (a dirty endpoint source, a stale library or a missing producer), 1 for a container failure. Each run leaves `.maestro/playbooks/Working/pair-<stamp>/` with the driver log and the endpoint's answers.

The archive holds implementation inputs only (HEAD, the branch, tree dirtiness and the acceptance rows are recorded beside it in `artifact.json` and `acceptance.json`), so a commit that touches no implementation file leaves an existing archive current and an implementation change always yields a new digest. The archive a pair loads is the one named by the committed pin, the `runtime` section of `Plans/integration-completion/runtime-conformance.json`:

```bash
node scripts/package-mega-maestro-runtime.mjs --runtime dist/mega-maestro-runtime/<version>/<sha256>             # exit 0: ready; 2: drift, dirty, unpinned, a foreign pin or a receipt in the pin
node scripts/package-mega-maestro-runtime.mjs --runtime dist/mega-maestro-runtime/<version>/<sha256> --write-pin # pin a verified archive, then commit the pin
```

`ready` means the archive is bound to its sidecar and manifest by sha256 and sha512, the archived implementation map and library inputs are the working tree's now, and the pin names it; `drift` lists the files that moved. No flag admits anything else to a run, and `--allow-stale` applies only to `dist/maestro-lib`. The pin is an identity: an adapter's `qualifiedAgainst.maestroRuntimeSha256` names `archive.sha256` in the adapter's own pin, never here, so qualifying an archive cannot change it.

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

Maestro-owned gaps, open and recorded in `Plans/mega-maestro-rc/evidence/11.json`: pause and resume of a running turn, a desktop prompt port, the usage producer composed into the process stream, commands and inbox on `maestro-cli host` (the desktop verbs of P2-07 need the bridge), a public documentation navigation entry for this page, and a hardening pass on how lineage identity is copied.

## See also

- [maestro-lib](./maestro-lib) for the library surface the managed contracts are exported from, release by release.
- [Maestro CLI](./cli#headless-host-maestro-cli-host) for `maestro-cli host`.
- `Plans/mega-maestro-rc/` in the repository: the execution rules, the plan and its evidence.
- `Plans/mega-maestro/evidence/handoff.json`: the handoff manifest at the path the integration design names, written by `scripts/write-mega-maestro-handoff.mjs` (the implementation-tree and library digests, the open producers, the local and joint status); the digest-verified copy of the counterpart's `joint-integration.json` belongs beside it, written only by `scripts/import-joint-integration.mjs` when the record names this checkout's revision, implementation-tree digest and built library, while the Phase 1 evidence stays under `Plans/mega-maestro-rc/`.
