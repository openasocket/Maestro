---
type: report
title: 'Phase 2 completion report (MRC2-08-06): Maestro managed integration, gap closure'
created: 2026-10-28
phase: 2
task: MRC2-08-06
document: MAESTRO-MEGA-P2-08
base_revision: 6400a6da0cfbae97bd90c4b361eea163fc3a1223
head_revision: d2435d07b
branch: feature/mega-maestro-v1.1.0-rc
counterpart_revision: d5143a63931dc87a5f90b3fdb7b58fa3726913b1
library_version: 0.32.0
tags: [maestro, mega-maestro, integration, report, phase-2, completion]
related:
  - '[[EXECUTION-RULES]]'
  - '[[PHASE2-GAPS]]'
  - '[[counterpart-requests]]'
  - '[[p2-standalone]]'
  - '[[p2-01]]'
  - '[[p2-02]]'
  - '[[p2-03]]'
  - '[[p2-04]]'
  - '[[p2-05]]'
  - '[[p2-06]]'
  - '[[p2-07]]'
  - '[[12-standalone]]'
  - '[[mega-maestro]]'
  - '[[CLI-UI-PARITY]]'
  - '[[README]]'
---

# Phase 2 completion report (MRC2-08-06)

Related: [[EXECUTION-RULES]], [[PHASE2-GAPS]], [[counterpart-requests]],
[[p2-standalone]], [[p2-01]], [[p2-02]], [[p2-03]], [[p2-04]], [[p2-05]],
[[p2-06]], [[p2-07]], [[12-standalone]], [[mega-maestro]],
[[CLI-UI-PARITY]], [[README]]. Written on 2026-10-28 (early on the 29th UTC)
at HEAD `d2435d07b` of `feature/mega-maestro-v1.1.0-rc`, the branch that
carries the managed integration of Maestro `v1.1.0-RC` (base
`6400a6da0cfbae97bd90c4b361eea163fc3a1223`, an ancestor of HEAD) with
Mega-Maestro at `d5143a639` (a development checkout, 935 dirty entries). The
per-document evidence is beside this file; the per-route support matrix is
`Plans/mega-maestro-rc/support-matrix.json`; the per-sink inventory is
`evidence/p2-sink-inventory.json`; the handoff manifest at the agreed path is
`Plans/mega-maestro/evidence/handoff.json`. A reader who sees only this file
should come away knowing what is done, what is proven, and what is blocked.

## Three words, kept apart

| Word                      | Verdict | What it rests on                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Maestro code complete** | yes     | Every Phase 1 implementation and test task (147 of 152) and every Phase 2 task (the eight `MAESTRO-MEGA-P2-01..08` documents, including the two bounded repairs of P2-08) is checked. Every seam is on the branch with a suite that drives the real sink and proves the refusal with nothing run, and the standalone path unchanged beside it. The whole suite at `9b2b5a3a7` fails only the environment set (15 files that need `npm install` or a signing override), see [[p2-standalone]].                  |
| **Jointly verified**      | no      | No real pair journey has passed. The five Phase 1 verification tasks (MRC-01-06, MRC-02-07, MRC-03-08, MRC-04-05, MRC-12-06) stay unchecked on purpose: each needs a producer Mega-Maestro owns and has not published (CP-01 through CP-06 and the registration approval, below). The last container run (2026-10-25, [[p2-02]] re-ran it on 2026-10-27) ended with 0 journeys passed, 5 blocked, 0 leases; on this date the Docker daemon was not running and no counterpart input moved, so no run was made. |
| **Production qualified**  | no      | Beyond the pair, the managed desktop is Linux-only by the counterpart's OS peer check (CP-06); no endpoint has ever delivered a policy document, so every ceiling built in Phase 2 has been exercised against a test table, never an endpoint's word (CP-01); no real provider route is enforced beyond launch admission (provider-internal tool, file and network effects stay unqualified); and the Maestro-owned leftovers listed at the end are open.                                                      |

## The branch

| Fact                                   | Value                                                                                                                                                                               |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| branch, base                           | `feature/mega-maestro-v1.1.0-rc` on `6400a6da0` (`v1.1.0-RC`)                                                                                                                       |
| commits since the base                 | 279: 177 Phase 1 (`MAESTRO: MRC-`), 102 Phase 2 (`MAESTRO: MRC2-`)                                                                                                                  |
| whole branch                           | 677 files changed, 140,692 insertions, 2,538 deletions                                                                                                                              |
| Phase 2 alone (`34822c6ec..d2435d07b`) | 399 files changed, 57,934 insertions, 2,630 deletions: 239 source files, 134 test files, the rest plans and docs                                                                    |
| library                                | maestro-lib 0.24.0 at the end of Phase 1, 0.32.0 now (`maestro-managed/1`, endpoint protocol 1, Node >= 20); the last build from `9b2b5a3a7` is clean, `index.js` sha256 `133436f7` |
| counterpart                            | `d5143a639`, dirty, unchanged since the Phase 1 reconciliation                                                                                                                      |
| CI                                     | never run on this branch (the fork runs only on pull requests into `main`, `rc` or `*-RC`); both legs, `test (ubuntu-latest)` and `test (windows-latest)`, are owed before a merge  |

## Phase 2 by document

| Document | Commits | Files | What it closed                                                                                                                                                                                                                                                                                                                                       | Evidence          |
| -------- | ------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| P2-01    | 9       | 20    | the published contract facts as data (`contract-vectors.json`, a drift check), the `unsupported-by-counterpart` support word, the handoff manifest at the agreed path, the joint record importer                                                                                                                                                     | [[p2-01]]         |
| P2-02    | 19      | 51    | purpose and origin on every spawn snapshot, the permission-mode consult, the utility-turn admission and route ceiling (groomer, tab naming, Quick Chat, the consult router, Codex skill discovery, the Pianola and Computer History supervisors)                                                                                                     | [[p2-02]]         |
| P2-03    | 12      | 45    | the permission-mode ceiling (readonly, standard, full) in the final argument check and the builder, consumed by the CLI, the desktop handler and the Codex app-server sink; provider probes under admission; the maestro-p TUI handshake, tool approvals and steering token                                                                          | [[p2-03]]         |
| P2-04    | 17      | 113   | the repository ceiling on the shared git executor and every forge call, the setup-script effect, the shell ceiling on notification commands, the install ceiling on binaries, spec prompts, marketplace imports, MCP writers and ZIP imports, the local-effects ceiling on open, trash, clipboard and delete, the plugin sinks out of the entry file | [[p2-04]]         |
| P2-05    | 16      | 89    | the egress ceiling at the one fetch chokepoint (eight classes), vendor telemetry off by default, the update ceiling, provider-account polling by account, the listener ceiling (eleven kinds, five reaches) over every inbound socket, remote identity over every SSH file operation and probe                                                       | [[p2-05]]         |
| P2-06    | 14      | 114   | the settings lock model (44 keys then, 59 now) and the one write authority over store, IPC, bridge, CLI, per-provider fields, admin sets, the Storage Location and remote access; the Settings badge; credential custody over three stores; redaction at the support-package chokepoint                                                              | [[p2-06]]         |
| P2-07    | 8       | 53    | `maestro-cli managed` (status, inventory, support-matrix, locks, policy refresh, enroll request, inbox, command), ten typed bridge messages and the allowlist, the `managed-status` surface, `encore.<flag>` pins, documentation and the parity record (16 of 18 UI actions covered)                                                                 | [[p2-07]]         |
| P2-08    | 7       | 10    | the canonical registrations, the matrix with observed rows and the enforcement section, the handoff refresh, the whole-repository checks with two bounded repairs, the sink inventory, this report                                                                                                                                                   | [[p2-standalone]] |

Six tasks in P2-06 and five in P2-07 ran over the 500-line bound, each
recorded in its task note; in P2-08 the matrix (1,090 lines) and the
inventory (5,511) are the deliverables and are flagged, not cut.

## Verified routes

Read off the 0.32.0 build by the packager's `capabilityMatrix()` (the
`routes` section of the matrix), the same words since MRC-12-04:

| Route              | Standalone                             | Managed     | Reading                                                                                                                                                                                             |
| ------------------ | -------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `child-process`    | implemented, all 11 pickable providers | implemented | the launch is admitted at the real spawn (`runAgentTurn`, `startTurn`, `ProcessManager.spawnAdmitted`) against a local authority; the provider's own tool, file and network effects are unqualified |
| `pty`              | implemented for 4, unverified for 7    | unsupported | no managed enforcement producer; P2-03 added the TUI handshake as a consumer on the local pty that maestro-p uses for `claude-code`                                                                 |
| `codex-app-server` | implemented (Codex)                    | unsupported | P2-03 holds the sandbox to the pin at the sink; no enforcement producer                                                                                                                             |
| `opencode-server`  | implemented (OpenCode)                 | unsupported | no enforcement producer                                                                                                                                                                             |
| `ssh`              | unverified                             | unsupported | a managed route on an SSH remote is refused by the plan until a remote attests a registered authority (CP-02)                                                                                       |
| synthetic harness  | implemented                            | implemented | an inline Node program under `--permission`, the one route that runs end to end on this host; it qualifies nothing a real provider does                                                             |

"Verified" above means proven on this host with the real local authority and
verifier behind a test port. No route is verified against the real endpoint.

## The enforceability table (permission modes, P2-03)

Twelve providers, three requested modes, four pins, every cell measured on
the real batch argument set (`permissionModes` in the matrix, 144 cells):

| Finding                                                            | Providers                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a `full` request is refused by mode under `standard` or `readonly` | all twelve                                                                                                                                                                                                                                               |
| a `standard` request fits under a `standard` pin                   | `claude-code`, `pi`, `omp`, `opencode` only                                                                                                                                                                                                              |
| a `standard` request is refused by flag under a `standard` pin     | `codex`, `gemini-cli`, `antigravity`, `qwen3-coder`, `hermes`, `factory-droid`, `copilot-cli`, `grok`: their `batchModeArgs` carry a full-access flag, so the command line asks for full access whatever the label says; only their `readonly` turns fit |
| a `readonly` request is refused under a `readonly` pin             | `gemini-cli` (its read-only flag is `-y`), `antigravity` (`--sandbox` accepted, not enforced), `hermes` (no read-only flag)                                                                                                                              |
| full access leaves no flag                                         | `pi`, `omp` (flagless), `opencode` (`OPENCODE_CONFIG_CONTENT`, env-only): held at the request level only                                                                                                                                                 |

Every verdict is the consumer's answer to a ceiling a test port lends; no
production producer of `routeCeiling` or `permissionCeiling` exists (CP-01).

## Locked settings (P2-06, P2-07)

59 keys a policy may hold, read off `managedSettingsLock.ts` by a throwaway
spec on this date (`enforcement.settingsLocks` in the matrix): 33 settings
keys (`utilityAgentId`, `utilityModelId`, `defaultShell`, `customShellPath`,
`shellArgs`, `shellEnvVars`, `shellEnvVarsDisabled`, `ghPath`,
`audioFeedbackCommand`, `idleNotificationCommand`, `checkForUpdatesOnStartup`,
`enableBetaUpdates`, `crashReportingEnabled`, `webAuthEnabled`,
`webAuthToken`, `persistentWebLink`, `webInterfaceAutoStart`,
`webInterfaceUseCustomPort`, `webInterfaceCustomPort`, `sshRemotes`,
`defaultSshRemoteId`, `speckitEnabled`, `openspecEnabled`, `bmadEnabled`,
`statsCollectionEnabled`, `leaderboardRegistration`, `wakatimeEnabled`,
`encoreFeatures`, `coworkingBrowserInteraction`,
`coworkingBrowserInteractionConfirm`, `coworkingBackgroundBrowsers`,
`coworkingBackgroundBrowsersLimit`, `installationId`); 5 per-provider fields
(`agentConfig.customPath`, `customArgs`, `customEnvVars`, `model`,
`reasoningEffort`); 3 admin sets (`prompts.customizations`,
`plugins.installed`, `storage.syncPath`); 3 action keys (`web.liveSessions`,
`web.tunnel`, `lite.control`); 15 `encore.<flag>` pins, one per Encore
Feature, always pinned to a boolean. `webAuthToken` is the one sensitive key
a policy may lock and never pin. One write authority holds every write path
(the store guard, `settings:set`, the bridge, the four CLI verbs, the five
per-provider handlers, the admin handlers, the Storage Location, the tunnel,
Live Mode, the Lite controls), and the Settings pane badges the same verdict.
Not represented by any key: the renderer's own write of one agent's record
(the Edit Agent modal, the composer chips) and `pluginTrustedKeys`.

## Egress and listener classes (P2-05)

| Family        | Classes                                                                                                                                                                                                                                                                    | Held at                                                                                                                                                                     |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| egress        | `vendor-telemetry`, `updates`, `provider-account`, `content` (the default), `github`, `plugin`, `user-webhook`, `enterprise-endpoint`                                                                                                                                      | `fetchWithTimeout()` before the timer and the one `fetch(` of the process; raw `https` is gone from `src/main`; three callers still name no class and are held as `content` |
| updates       | `stable`, `prerelease`                                                                                                                                                                                                                                                     | `updateHoldFor()` before every electron-updater step and the releases feed                                                                                                  |
| listeners     | 11 kinds: `web`, `tunnel`, `ssh-tunnel`, `lite-control`, `tailnet`, `mdns`, `cue-webhook` gated before the first socket primitive; `cue-status`, `relay`, `steering`, `coworking` loopback or OS-local by record; 5 reaches: `loopback`, `tailnet`, `lan`, `any`, `public` | `holdListener()` over `listenerVerdict()`; the Lite process composes its own authority; `maestro-cli host` and the headless Cue engine install none                         |
| local effects | `open-external`, `open-path`, `clipboard-write`, `remote-write` (data-transfer); `trash`, `delete` (destructive)                                                                                                                                                           | `holdLocalEffect()`, `holdDeleteEffect()`                                                                                                                                   |
| shell         | one surface, `notification`                                                                                                                                                                                                                                                | `holdNotificationCommand()` over an exact-string allowlist                                                                                                                  |
| install       | `wakatime-cli`, `maestro-cli`, `speckit-prompts`, `openspec-prompts`, `bmad-prompts`, `marketplace-playbooks`, `coworking-mcp-server`, `playbook-archive`, `cue-backup`                                                                                                    | `InstallAuthority.authorize()` and its thin adapters                                                                                                                        |
| repository    | `clone`, `branch`, `commit`, `fork`, `push`, `pull-request`, `finalize`, `cancel`, `gist`, `setup-script`, `issue`, `upload`, `poll`                                                                                                                                       | `holdGitCommand()` / `holdGitForgeEffect()` on the shared executor                                                                                                          |
| remote access | `read`, `write`, `delete`, `probe`                                                                                                                                                                                                                                         | `holdRemoteAccess()` before every remote-fs operation and SSH probe                                                                                                         |
| credentials   | three: the turn log state store seal, `wakatime.apiKey`, `cue.odinToken`                                                                                                                                                                                                   | `credentialCustodyVerdict()` before a read or a write                                                                                                                       |

With no policy installed (CP-01) an enrolled desktop refuses every one of
these by name; a standalone desktop reads nothing and runs as before, proven
beside every refusal in the suites.

## The sink inventory (P2-08)

`evidence/p2-sink-inventory.json`, 279 rows at `2a5b54135`, zero
unclassified: 236 guarded, 33 standalone-only, 9 loopback-only, 1
unavailable (the CLI `gh auth login` under management). The 33 standalone-only
rows are, by group: the nine git and delete after-effects p2-04 named (the
local worktree checkout and removal, the two empty-directory `rmdir`s,
Symphony's post-fork remote rename, its `push --delete` and two clone
removals, the overwrite clear of a remote move); `shell.showItemInFolder` and
the subframe `shell.openExternal`; the five read-class debug collectors; the
renderer's CSP source list; `pluginTrustedKeys`; the two Lite peer transports
over `node:https`; the `autoInstallOnAppQuit` after-effect; the Codex
`auth.json` readers and the plugin ledger anchor (sealed in every mode, no
managed verdict); the CLI and Cue maestro-p surfaces that send no TUI
handshake; the `maestro-cli host` listener, the headless Cue engine and the
CLI `test-ssh-remote` verb, which compose no authority.

## CP-01 through CP-06, and the registration approval

Every producer is open, owner `mega-maestro`, observed on this date by the
pair check and by reading the sibling files at `d5143a639` (the matrix's
`counterpart.rows[].observed` and `producerRows`, [[counterpart-requests]]):

| ID     | Producer owed                                                                             | Observed                                                                                                                                             | Phase 1 task it holds unchecked            |
| ------ | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| CP-01  | a clean, source-pinned contracts archive and packaged endpoint, API and gateway artifacts | `vendor/mega-maestro/contracts.pin.json` absent; four packaged artifacts, all darwin/arm64 from dirty `e29195d8`; no clean Linux artifact            | MRC-01-06, MRC-03-08, MRC-04-05, MRC-12-06 |
| CP-02  | a real `createMaestroAdapter` serving the runtime port                                    | `packages/runtime-adapter/src/maestro.ts:7-20` returns `unsupported`; every artifact declares the adapter unsupported                                | MRC-04-05, MRC-12-06                       |
| CP-03  | delegation and workflow authority on the wire                                             | `packages/runtime-adapter/src/endpoint.ts:35` denies a nonempty chain or a non-null workflow `context-mismatch`; no delegation field in the contract | MRC-02-07, MRC-12-06                       |
| CP-04  | the endpoint serving `command`, `workflow`, `offline`, `enrollment`, `budget`             | `apps/endpoint/src/ipc/server.ts:65-67` serves attachment, compatibility, telemetry, inbox, noticeList, execution, model only                        | MRC-03-08, MRC-12-06                       |
| CP-04a | an API or console producer that approves the actor registration                           | `approvalProducer: false`; every actor-bound command answers `unauthenticated`                                                                       | MRC-03-08, MRC-04-05, MRC-12-06            |
| CP-05  | `pause_run` and `resume_run` on `commandRequest`                                          | `packages/contracts/src/local-endpoint.ts:79-83`: `cancel_run`, `refresh_policy`, `report_status` only                                               | MRC-11-07 row `commands-notices`           |
| CP-06  | OS peer authentication on macOS and Windows, or a Linux-only statement                    | `apps/endpoint/src/ipc/native.ts:24` throws `IPC_PLATFORM_UNSUPPORTED` off Linux                                                                     | every paired row on this macOS host        |

The handoff manifest lists the same eight prerequisites (CP-01 through
CP-06, CP-04a, registration-approval) as `open`, with `localStatus:
complete` and `jointStatus: not-verified`.

## The exact remaining dependencies

**Owed by Mega-Maestro (nothing here can close them):** CP-01 through CP-06
and the registration approval, above, delivered as a committed revision plus
a rebuilt artifact set; each of the five open Phase 1 tasks re-runs its real
check when the sibling commit, the artifact set or the built library sha
moves, and not before.

**Owed by the host that runs the pair:** a Linux machine with a Docker
engine (the pinned image `node:22.16.0-bookworm`; Node 22 lacks `--allow-net`
so `headless.turn` cannot pass inside it either); on this macOS host the
daemon was not running on this date.

**Owed by Maestro (open leftovers, each named in its evidence file):**

- Recover standing and Complete registration have no `maestro-cli` verb
  ([[CLI-UI-PARITY]] Open gap 0); pause and resume exist on no surface (Open
  gap 17, CP-05).
- The renderer's own write of one agent's record and `pluginTrustedKeys` are
  held by no lock key; `maestro-cli create-ssh-remote` with no desktop writes
  the file directly; `webAuthToken` stays in plain settings outside the
  custody ceiling; the Codex `auth.json` readers and the plugin ledger have
  no custody verdict.
- Three egress callers name no class (the two plugin fetches, the Cue notify
  webhook); the remote-access ledger is not in `ManagedStateView`.
- The CLI and Cue maestro-p surfaces send no TUI handshake and no steering
  token; the headless Cue engine composes no listener, egress, remote-access,
  git or credential authority; `maestro-cli host` is a listener with no kind
  and composes neither the command service nor the inbox client.
- Eight providers' `batchModeArgs` carry a full-access flag, so only their
  `readonly` turns fit under a `standard` pin; OpenCode's env-only full
  access is held by the mode word alone.
- `createUsageCapture` is not composed into the desktop process stream;
  `docs/mega-maestro.md` stays out of `docs/docs.json` by the MRC-12-04
  decision until the pair certifies.
- The live round trip of the `managed` verbs needs the desktop rebuilt and
  restarted by the person; the Windows CI leg has never run on this branch.
- On this host the suite needs `npm install` (`dns-packet`, `smol-toml`,
  `@serenity-kit/opaque`) and the one git fixture a signing override;
  `npm run test:integration` fails four files, named in [[p2-standalone]].
- `upstream/rc` is 223 commits past the base with 38 conflicting files on a
  dry-run merge; a rebase is a separate decision.

## What the person does next (from the document's manual follow-up)

1. Push `feature/mega-maestro-v1.1.0-rc` (pushes need interactive
   confirmation on this machine) and open a pull request into an `*-RC`
   branch so both CI legs run; the branch is not mergeable on a local
   single-OS pass.
2. Hand `Plans/mega-maestro-rc/counterpart-requests.md` to the Mega-Maestro
   owner for CP-01 through CP-06 and the registration approval.
3. Run the real pair on an owned Linux host once CP-01 and CP-02 artifacts
   exist; the next Auto Run pass of the five open Phase 1 tasks will exercise
   whatever lands.

## Not claimed

No acceptance row changed in Phase 2 and no real pair journey passed; the
integration is not jointly verified and not production qualified. Every
managed verdict on this branch stands on the real local sources behind a test
identity whose policy document is a table, and the producer of those
documents is absent. Nothing in the sibling repository was written. The
source tree gained this file alone.
