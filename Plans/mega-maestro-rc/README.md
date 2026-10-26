---
type: execution-guide
title: Maestro 1.1.0-RC integration playbook package
created: 2026-10-19
tags: [maestro, mega-maestro, integration, autorun]
---

# Maestro-owned integration plan

Related: [[ANALYSIS]], [[EXECUTION-RULES]]. Source review and task order are in
`source-review.json` and `execution-plan.json` beside this guide.

Reviewed Maestro `v1.1.0-RC` at
`6400a6da0cfbae97bd90c4b361eea163fc3a1223`, compared with `v1.0.0`.
The plan has twelve task-based documents and 92 initial tasks: 62 IMPLEMENT,
17 TEST and 13 VERIFY. Each task receives a fresh context. It builds a separate
`feature/mega-maestro-v1.1.0-rc` worktree; no changes are made on the release
branch. The app/library/plugin SDK/host API/enterprise protocol versions remain
distinct. Source pinning is deliberate; a later moved tag requires another review.

| Phase | Maestro-owned outcome                                                       |
| ----- | --------------------------------------------------------------------------- |
| 01    | Public enterprise artifact import, generic managed API and compatibility    |
| 02    | Protected authority, durable runs and shared runtime dispatch               |
| 03    | Enrollment, identity custody, endpoint client and policy/offline status     |
| 04    | Early real Maestro/endpoint/API execution slice                             |
| 05    | Approved credential/account references, routing, translation and bundles    |
| 06    | Desktop SDK, CLI, child process, terminal and permission-relay coverage     |
| 07    | Auto Run, Cue, consult/group-chat delegation and durable workflow ownership |
| 08    | Web, Lite, SSH, host and TUI authorization                                  |
| 09    | Plugin, browser/coworking and Symphony repository effects                   |
| 10    | Fleet events, cursors, usage and policy-bounded VIBES evidence              |
| 11    | Typed commands, notices/private feedback and managed UX                     |
| 12    | Immutable public handoff, standalone regressions and complete real pair     |

## Install from the Maestro agent

The authoring agent may only write inside Mega-Maestro. Consequently this package
is staged here, not registered as an executable Mega-Maestro application playbook.
Its documents explicitly require a Maestro worktree. Do not run them with
Mega-Maestro-Codex or mix them into either current application playbook.

The Maestro parent agent is `9b4b298d-918a-4c8d-a9a8-c9a014a04adb`, currently
configured for `/Users/dr3/dev-shit/Maestro`. That agent can run:

```sh
node /Users/dr3/dev-shit/mega-maestro/scripts/prepare-maestro-rc-playbook.mjs --prepare
```

Run it from that agent's Maestro working directory. The one-time preparer:

1. Verifies the reviewed tag and source hashes, refusing drift.
2. Calls `maestro-cli create-worktree` with the exact base SHA and feature branch,
   in the background with no initial message. The current checkout is preserved.
3. Finds the new worktree agent and verifies its branch and HEAD.
4. Copies these analysis/rules/manifests into `Plans/mega-maestro-rc/` in the new
   worktree, and the twelve documents into its configured Auto Run folder.
5. Configures/verifies the new agent's Auto Run folder through the application
   API, then saves **Maestro 1.1.0-RC Mega-Maestro Integration** with relative
   document identifiers, no loops or resets.
6. Records agent ID, worktree, saved playbook ID and base in
   `Plans/mega-maestro-rc/prepared-run.json`, then refreshes the Auto Run panel.

Preparation does not dispatch a prompt or launch Auto Run. It refuses an existing
feature branch and existing destination files rather than reset work. For a
partial preparation, inspect the created worktree and receipt; do not delete or
recreate it blindly. A missing save receipt does not mean worktree creation failed.

Read-only checks from this authoring repository:

```sh
python3 scripts/validate-maestro-rc-playbook.py --maestro-root /Users/dr3/dev-shit/Maestro
node scripts/prepare-maestro-rc-playbook.mjs --check
```

Once installed, inspect the saved playbook and perform a dry run. It must see all
initial unchecked tasks, starting at MRC-01-01 and ending at MRC-12-06. Future
repairs may legitimately increase that count. Absolute paths or repeated `.md`
extensions in saved identifiers can reproduce historical zero-task bugs.

When launch is explicitly requested, use `maestro-cli auto-run` with the twelve
installed document paths in manifest order, `--agent <prepared-agent-id>` and
`--launch`, plus the installed execution-rules prompt. Use the desktop Auto Run
engine. Do not use the headless `playbook` runner for a visible desktop run,
manually execute the checklist in chat, reset completed boxes or enable looping.

## Required counterpart work

This is a source-based implementation plan, not a claim of current dispatch or
integration readiness. CP-01 supplies current source-bound enterprise archives
and real service artifacts. CP-02 replaces Mega-Maestro's currently unsupported
Maestro adapter. CP-03 supplies authenticated delegation/workflow producers and
receivers; the current enterprise bridge rejects those fields. These are explicit
Mega-Maestro-owned dependencies, not tasks that may mutate the sibling repository
from a Maestro agent. Provide them before their real paired consumers need them.

There are no preauthored halt/HITL markers or human-only checkbox gates. Ordinary
code/service failures get bounded repairs. A missing mandatory counterpart still
keeps its paired checks and final completion incomplete; stubs or skipped tests
cannot satisfy them. No plan can honestly guarantee completion without its real
producers. Native OS/provider production qualification, customer identity/cloud
configuration and external scale/release approval remain separate from local
paired functionality.

The manifest also names thirteen mandatory positive acceptance journeys. They
cover real enrollment/policy, protected effects, library/headless and desktop/CLI
dispatch, Auto Run, Cue, delegated ownership, credentials/routing, secondary
effects, fleet evidence, commands/notices and standalone regression. Disabling a
required surface and testing only denial cannot close the integration milestone.

Additional product ideas are listed separately in [[ANALYSIS]] for review. They
do not add implementation scope automatically. Required controls around existing
translation, headless operation and plugins remain in this playbook even though
new central product experiences for those features are optional.

## Handoff and joint evidence (Phase 2)

Phase 1 wrote its rules, plan, support matrix and evidence under
`Plans/mega-maestro-rc/`. The integration design (MEGA-MAESTRO-INTEGRATION,
"Handoff and joint acceptance") names `Plans/mega-maestro/evidence/` as the path
the counterpart reads and writes to, so Phase 2 keeps both:

| Path                                                 | Written by                                  | Content                                                                   |
| ---------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------- |
| `Plans/mega-maestro-rc/`                             | Phase 1 and 2 tasks                         | Rules, plans, support matrix, per-phase evidence, the Phase 1 pair record |
| `Plans/mega-maestro/evidence/handoff.json`           | `scripts/write-mega-maestro-handoff.mjs`    | Maestro's handoff manifest, the record Mega-Maestro keys on               |
| `Plans/mega-maestro/evidence/joint-integration.json` | `scripts/import-joint-integration.mjs` only | The digest-verified copy of Mega-Maestro's joint record                   |

Both scripts need Node 26 from `/opt/homebrew/bin` and a built library
(`npm run build:maestro-lib`); `Plans/mega-maestro/evidence/` is excluded from
Prettier so neither file is ever reformatted.

```sh
node scripts/write-mega-maestro-handoff.mjs --agreement <MEGA-MAESTRO-INTEGRATION.md> --enforceability <MEGA-MAESTRO-ENFORCEABILITY.md>
node scripts/write-mega-maestro-handoff.mjs --check   # 0 when the file on disk reproduces, 1 when it differs
node scripts/import-joint-integration.mjs <joint-integration.json from Mega-Maestro> [--dry-run] [--json]
```

The writer records `repositoryRevision` (HEAD), `sourceTreeDigest` over the
git-tracked implementation tree (`src/`, `scripts/`, `package.json`, the
lockfile, `tsconfig*.json` and the contracts pin; `Plans/`, `.maestro/` and
`docs/` excluded, so a report or checkbox edit never moves it), the built
library's digests, the capability and OS/provider matrix, the pair commands, the
local and joint status and the open producers CP-01 through CP-06. It is
deterministic and refuses an absolute path or a secret shape before writing
(exit 2). A committed manifest always names the commit before it, so `--check`
reads "differs" right after a commit until the next regeneration.

The importer copies the counterpart record byte for byte, and only when the
Maestro facts it carries (an object at `maestro`, `participants.maestro` or
`handoffs.maestro` with `repositoryRevision`, `sourceTreeDigest` and
`artifacts[]` naming `kind`, `entry.sha256` and `payloadDigest`) equal what the
writer computes on this checkout right now, with the library built from HEAD. A
differing field is named and nothing is written (exit 1); an unusable record, a
missing build, an absolute path or a secret shape is refused (exit 2). Changed
implementation, lockfiles or artifacts therefore invalidate the joint evidence
by construction, exactly as the design requires. The counterpart has not yet
published a joint record; the shape above is what the importer reads once it does.

## Authoring verification

The structural validator checks task order/uniqueness/counts, one-to-three file
targets, execution owner, disabled loop/reset/handoffs, absent stop markers and
the reviewed source hashes. This does not execute runtime tests. The preparer's
read-only check and JavaScript syntax check pass. The preparer has not been run
with `--prepare`: no Maestro file, branch, worktree, credential or saved playbook
has been changed, and no run has started.
