---
type: analysis
title: Grok tier-1 execution baseline and design ledger
created: 2026-10-30
tags: [maestro, grok, baseline, design]
related:
  - '[[CONTRACT]]'
  - '[[REFERENCE]]'
  - '[[Plans/grok-tier1/evidence/01]]'
---

# Grok tier-1 execution baseline

GT1-01-01 records the starting environment; GT1-01-04 adds the protocol design below.
Provider implementation and release qualification remain pending. The machine-readable record is
[run-state.json](run-state.json); the command receipts are [[Plans/grok-tier1/evidence/01]].

The governing documents are the canonical
[contract](/Users/dr3/dev-shit/Maestro/.maestro/playbooks/2026-10-30-Grok-Tier1/CONTRACT.md)
and [reference](/Users/dr3/dev-shit/Maestro/.maestro/playbooks/2026-10-30-Grok-Tier1/REFERENCE.md),
also linked as [[CONTRACT]] and [[REFERENCE]]. Their SHA-256 hashes are in run-state so
later tasks can distinguish this baseline from changed instructions.

## Execution identity

Maestro's registered agent `404dfe62-cb4a-4e29-b2e3-a2cbb6ee3bb9` has the expected name
`auto-run-feature/grok-cli-integration`, provider `codex`, and cwd
`/Users/dr3/dev-shit/worktrees/auto-run-feature/grok-cli-integration`. Git independently
reports that root and branch. The common repository is `/Users/dr3/dev-shit/Maestro/.git`.
The registered Auto Run folder is the shared `.maestro/playbooks` folder; its
`2026-10-30-Grok-Tier1` subfolder contains this playbook. No new worktree is needed.

| Baseline identity             | Observed value                              |
| ----------------------------- | ------------------------------------------- |
| Starting execution HEAD       | `0a56e0fa1c18e25a8e8a70dfc37378ae7d076b4f`  |
| Resolved local base           | `refs/heads/feature/mega-maestro-v1.1.0-rc` |
| Base commit                   | `dab0dbb9ccad90b5f3d5c0784cd0d0151b24e796`  |
| Merge base                    | `0a56e0fa1c18e25a8e8a70dfc37378ae7d076b4f`  |
| Execution ahead / behind base | 0 / 2                                       |

The origin tracking ref matches the resolved local base; no upstream tracking ref for
that branch exists. No fetch was performed. The two base-only commits change two
`Plans/integration-completion/evidence/` records, with no source-code difference. This
task preserves the existing checkout instead of updating its ancestry. `sourceCommit`
always means the pre-task HEAD; the baseline artifact commit is necessarily later.

The initial tracked tree is clean. The observed untracked `.sloptimize/output_cache/`
file is tool output and is preserved outside this task's commit. The primary checkout,
dependency tree and repository configuration remain unchanged.

## Provider identity and architecture boundaries

The target remains provider ID `grok`, display name Grok CLI, executable `grok`.
[[REFERENCE]] selects the official `@xai-official/grok@1.0.70` candidate and records
its registry integrity. These are inherited provenance, awaiting independent artifact
verification. The reference's public source snapshot is
`2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8`; its source-monorepo provenance is
`559751fdcec02d413e4c57c8832ab275e4f44980`. Neither SHA is a claim about the npm binary's
build source. The located user executable was not invoked, and its version remains unknown.

Existing reuse boundaries verified in this checkout:

- Definitions and capabilities: `src/shared/maestro-lib/providers/definitions.ts` and
  `capabilities.ts`; their `src/main/agents/` counterparts are compatibility re-exports.
- Output parser: `src/shared/maestro-lib/parsers/grok-output-parser.ts`; the main parser
  path is a compatibility re-export.
- Native session storage: `src/main/storage/grok-session-storage.ts` still owns the implementation.
- Picker identity: `src/shared/agentMetadata.ts`; do not introduce another provider ID.

Current guides mix historical CLI versions and describe Grok as implemented while retaining
Beta status. Those statements do not qualify the selected candidate or prove parity. No
capability, parser, storage, permission, pricing or beta behavior changes in this baseline.

## Tooling and recovery

The host is macOS 27.2 arm64 with Node 26.13.0 and npm 11.20.0. The manifest requires
Node >=22.0.0, `.npmrc` enforces engines, and package-lock version 3 pins dependencies.
There is no exact package-manager/runtime pin. GT1-01-01 initially found no
execution-checkout `node_modules`; GT1-01-01A subsequently installed 1,445 lock-matching
packages with `npm ci` and caches/temp files under `tmp/grok-tier1-setup/`.
The supported `MAESTRO_SERVER_INSTALL=1` mode preserves Node ABI 147: local test/build
tool versions, the dependency tree and SQLite/canvas/PTY binding smoke checks passed.
Electron native rebuild remains `not-run` because the pinned rebuild tool hardcodes
`~/.electron-gyp`, outside this task's write boundary. Electron's binary is present,
but neither desktop ABI readiness nor application tests are implied by setup success.
The lifecycle scripts and available native prerequisites are recorded in [[Plans/grok-tier1/evidence/01]].

GT1-01-01 borrowed the primary checkout's lock-matching Prettier read-only. After
GT1-01-01A, use the worktree's installed Prettier 3.8.3. The remaining repository suites
are explicitly `not-run` until GT1-01-06. Run-state retains the original baseline
provenance; its `setup` receipt records GT1-01-01A's source revision and commands.

The local commit hook calls unpinned, unavailable `npx lint-staged`. Use a command-local
`core.hooksPath=/dev/null` for this documentation-only commit after explicit formatting
and artifact checks; do not change shared Git configuration. The specific contract's
prohibition on pushing overrides the generic Auto Run push instruction. Keep this task's
commit local; do not create a PR or publish anything.

## Live boundary and later owners

Run-state has `live.enabled: false`, a null credentials/authorization reference and zero
spend, calls, turns and wall-clock budget. No provider process, authentication flow,
discovery endpoint or paid request was executed. Linux, Windows and SSH coverage are
unqualified. Missing authorization is a blocker, never permission to use ambient accounts.

GT1-01-02 and GT1-01-03 own the parity ledger and consumer audit. GT1-01-04 owns the
versioned native/ACP contract, GT1-01-05 the isolated acceptance/live configuration, and
GT1-01-06 the baseline repository checks. Each later task must recheck root/branch,
read run-state and the canonical contract/reference, and preserve these provenance and
live-execution boundaries. No images accompany this task; zero were analyzed.

## GT1-01-04: Grok route contract v1

Contract identifier: `grok-route-contract/v1`, recorded 2026-10-30 against Maestro
`4ee75e4fe6c6282176d3ea30000cd1b7a1347c3f`. This is an implementation specification,
not a capability enablement or a passing product test. All existing parity rows and
acceptance statuses remain intact. [[Plans/grok-tier1/evidence/01]] records source
receipts; [parity.json](parity.json) retains implementation/test/verification owners.

### Independent source and distribution identities

| Identity                | Contract value and evidence boundary                                                                                                                                                                                 |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider                | Existing `grok`, executable `grok`, display Grok CLI; exclude the community `grok-cli` package.                                                                                                                      |
| Inspected public source | `2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8`; GitHub commit metadata independently confirms source-monorepo provenance `559751fdcec02d413e4c57c8832ab275e4f44980`.                                                     |
| Distribution candidate  | Official `@xai-official/grok@1.0.70`; registry metadata independently retrieved; launcher requires Node `>=20`.                                                                                                      |
| Artifact integrity      | Registry repeats `sha512-Q2Ncoez//mk1Z9CNhgvp9eAYfZJZmshDAPxs0XAhhGnilH3abGAyTwqOSvqVnsFCUjjzT9TCYZIgAH2A2XL6CQ==`. Artifact bytes and executable hash are not verified.                                             |
| Binary/source relation  | Unknown. Neither source SHA, npm version, reported agent version nor a matching executable name proves the others.                                                                                                   |
| Qualified versions      | Empty for this candidate contract. Minimum/latest supported versions remain unset; legacy 0.2.93/1.0.5/1.0.41 parser evidence is separate and must retain its fixtures.                                              |
| Advertised targets      | npm optional dependencies list darwin/linux/win32 on arm64/x64, including Windows ARM64 absent from REFERENCE's five-target list. These are package advertisements, not tested platforms; GT1-01-05 owns the matrix. |

Official pins used below (all source links resolve the inspected SHA):
[H: headless guide](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/docs/user-guide/14-headless-mode.md),
[I: input parser](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/headless/cli.rs#L31-L130),
[A: ACP initialize](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/agent/mvp_agent/acp_agent.rs#L556-L632),
[S: session setup](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/agent/mvp_agent/session_setup.rs),
[M: model discovery](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/cli_models.rs#L48-L93),
[C: config options](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/agent/handlers/config_option.rs),
[U: usage extension](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/extensions/usage.rs),
[B: accounting producer](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/extensions/notification.rs#L104-L425),
[F: line framing](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-acp-lib/src/line_reader.rs#L25-L174),
[V: ACP dependency pins](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/Cargo.lock#L43-L63),
and [N: npm metadata](https://registry.npmjs.org/@xai-official%2fgrok/1.0.70).
Source-supported facts below do not certify N's native payload.

### Two distinct routes and a negotiated selector

| Route             | Wire and producer                                                                                               | Candidate boundary                                                                                                                                                                                  |
| ----------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `native-headless` | `grok --output-format streaming-json` with one explicit prompt source; stdout NDJSON, stderr diagnostics (H/I). | Output-only telemetry. Retain `GrokOutputParser`; no interactive approval replies over stdin. `plain`, terminal `json`, and `streaming-messages-json` are distinct formats, never parser aliases.   |
| `acp-stdio`       | `grok agent [agent options] stdio`; JSON-RPC requests, responses and notifications over open stdin/stdout (A).  | Candidate preferred route for bidirectional interactions. Agent options precede `stdio`; do not inherit native `--always-approve` batch defaults. No WebSocket listener/relay or PTY is introduced. |

The selector is a pure decision consumed by the existing launch/run ports. Its input
includes final executable identity/hash/version, OS/architecture, local or qualified SSH
endpoint, selected account reference and endpoint/config fingerprint, requested permission
mode, model/effort, native session operation, images/resources, additional roots, interaction
requirements, cancellation, and managed lease/effect requirements. Never persist credentials
or raw environment in this descriptor. Keep source provenance, runtime advertisement,
implementation support, policy verdict and exact-binary qualification as separate fields.

1. Resolve effective profile/env/remote and custom overrides first. Reject conflicting
   prompt, resume, transport, model and permission flags before starting an effectful turn.
   A remote failure never becomes local execution. Bind the final choice to the admitted snapshot.
2. Read version-scoped cached evidence. An unknown binary is unqualified, not a newer member
   of an assumed semver range. Legacy routes retain their own evidence and behavior; do not
   erase sessions or silently reinterpret legacy frames under the new candidate schema.
3. For authorized discovery only, negotiate `initialize` protocol version 1 with the
   implemented client capability subset. Source A advertises `loadSession`, embedded context,
   MCP HTTP/SSE, and conditional session list/resume; it does not explicitly advertise images.
   Do not advertise client file/terminal execution or elicitation handlers we cannot enforce.
   Initialization can contact endpoints: it is not an offline help/version check.
4. Intersect requirements with actual response fields and version-qualified semantics.
   A's `_meta` contains selected extension flags, model state and commands, not an exhaustive
   method inventory. Known optional discovery methods may be tried only in the admitted,
   isolated discovery flow; method-not-found means unavailable, not permission to guess.
   Method success alone does not qualify mutation semantics or preventive effect coverage.
5. Prefer ACP when it satisfies every required feature and the selected consumer can service
   interactions. Native fallback is allowed only before prompt dispatch, with the same
   identity/policy/features and qualified equivalent behavior, and a surfaced route reason.
   Explicit route selection must be honored or refused. Never fall back on a denied request,
   unsupported image, model rejection, lost connection or unknown completion.
6. Return a route plus immutable negotiated facts, or a structured refusal naming missing
   requirements and applicable parity rows. Invalidate on binary/config/account/host/policy
   change. Once dispatch may have occurred, no automatic resend or route switch is safe.

Candidate readiness remains `not-run`. This specification does not switch the current
default route, promote Grok, or assert that existing static flags implement this selector.

### Prompt, attachment and identity invariants

For native input, exactly one of `-p/--single`, `--prompt-json`, `--prompt-file` may carry
the effective prompt. I has no raw-stdin prompt branch. Correct the current unverified
`supportsPromptViaStdin: true` in GT1-02-11; ACP stdin is RPC, not that capability.
The platform guide's SSH stdin advice describes the launcher script transport, not a
Grok prompt reader. Transfer/materialize an owned prompt artifact on the executing host.

I interprets lowercase `.json` files as an ACP content-block array or
`{"type":"acp","content":[...]}`; other extensions become trimmed text. Prefer a `.json`
file containing a text block to preserve leading/trailing whitespace, multiline Unicode,
quotes and large content. Small `--prompt-json` uses the same schema within argv limits.
Do not use shell substitution, duplicate `-p`, or pretend `--verbatim` reverses input trimming.
Plan bytes/path/ownership purely; materialize with restricted permissions and collision-safe
names through the existing launch artifact owner. Cleanup covers refusal, spawn failure,
completion, timeout, cancellation and superseded launches, including remote-owned artifacts.

Native JSON image blocks are a source-supported candidate for fresh/resumed input; ACP
images require actual advertised support and model acceptance. Validate MIME, size and
count before dispatch, preserve order, and keep bytes off logs. Existing prompt-embedded
image paths require a tool read and host-local access; they are not equivalent to embedded
images under no-tools/read-only restrictions. Never grant broader access to rescue an image.
The portable `runAgentTurn` image rejection needs its own consumer change and tests (P08/P38).

Compose Maestro instructions once with `assembleMaestroSystemPrompt` and the canonical
embedded envelope while native append remains unqualified. H's `--rules`/append alias is
candidate native append, not full system replacement or permission enforcement. Resume
must preserve the selected delivery policy without duplicating instructions; long rules
need a qualified file/embedding path rather than overflowing argv.

Persist provider identity as `(grok, account reference, executing host, project cwd, native ID)`
bound to the Maestro agent/tab and turn generation. A tab ID is never a native session ID.
Native `--session-id UUID` creates a new session and rejects a collision; `--resume UUID`
loads exactly that ID. Never use title matching or `--continue` in automation. ACP uses
`session/new` to allocate and `session/load` to restore; any separate advertised resume
method needs its own semantics. Retain the confirmed allocation even if later work fails,
but do not mark an unconfirmed caller-suggested UUID resumable. Missing native `end` must
not fabricate an ID; invalid resume must not create a fresh session. A fork requires a
separate qualified operation and new identity, preserving its source.

One in-flight prompt per native session; existing queues own serialization. Stamp RPC,
tool, plan and permission state with process generation/session/turn. ACP load replay is
history, not new answer text or billable usage. Ignore stale generation updates without
allowing a late completion to replace another tab's mapping. Restart requires explicit
load and re-negotiation; disconnect after dispatch means uncertain completion, not retry.

### Stream, permission and terminal contract

V pins ACP crate 0.10.4 and schema 0.11.4 with unstable features; these are distinct from
wire protocol 1 and npm 1.0.70. F uses newline framing, not Content-Length, with an upstream
64 MiB line ceiling. Maestro must choose bounded frame/queue/diagnostic limits compatible
with its accepted attachment sizes and refuse oversize content before dispatch.
NDJSON framing is incremental across split UTF-8 chunks, bounded per frame and connection,
with stderr separate. ACP requests use unique IDs, matched once; notifications need no
reply. Duplicate/unknown IDs cannot settle another request. Reject malformed/oversized
frames with bounded diagnostics and close pending requests; tolerate unknown informational
extensions without enabling a feature. Do not reuse the explanatory docs' repeated IDs.

Normalize native `text`, `thought`, `tool_call`, `tool_call_update`, `plan`,
`available_commands`, `usage`, `end`, `error` and ACP `session/update` into existing shared
events. Preserve tool ID, input/output, reported child lineage and status. A tool's nonzero
exit is a failed tool even if its transport status says completed; it does not alone prove
the whole turn failed. Render only reported reasoning summaries, never invented thinking.
Plans are ordered snapshots/progress owned by their turn; unknown statuses remain unknown.
Bound retained output with canonical compaction; native JSON and Messages-like JSON are
not interchangeable for identity, deltas, spend or completeness.

The pinned native headless client resolves permission requests internally (allow under
yolo, otherwise cancelled); its streamed events provide no host response channel.
Only `session/request_permission` and other verified pre-effect request methods can enter
consent/effect handling. Use the advertised option ID, never an invented allow response.
Bind decisions to actor, lease, session, turn, request, exact tool arguments and cwd; apply
allow-once only within that request. Denial, timeout, revocation, disconnect, unsupported
options or absent handler produce refusal/cancellation and settle pending interactions once.
An ask-back is a separate negotiated request and ordinary answers never authorize effects.
Unattended consumers cannot wait for a UI that does not exist.

ACP permission support is not a complete sandbox. Auto-approved calls, hooks, MCP
meta-tools, subagents and provider-internal network may bypass that request. Managed
routes needing an unproven preventive control remain refused through the existing authority;
post-execution telemetry cannot repair that boundary. Plan mode, tool lists, deny rules,
and cwd alone prove neither all-tools-off nor writable-root containment (P33-P36).

| Structured terminal fact   | Required settlement and consumer behavior                                                                                                                                                             |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Success                    | Known successful stop reason on the native terminal or correlated ACP prompt response, no overriding lifecycle/error fact; correlation alone is insufficient. Emit one result and flush once.         |
| Refusal / policy denial    | Preserve provider refusal versus Maestro admission/effect refusal; no successful automation completion.                                                                                               |
| Cancelled                  | Requested cancel or provider cancellation; retain partial answer and confirmed ID, but no success. ACP `session/cancel` is a notification; await prompt settlement, not a fabricated cancel response. |
| Limit / incomplete         | `max_tokens`, `max_turn_requests`, unknown/missing terminal reason or absent end after text; retain reason and partial output, never infer completion from exit 0.                                    |
| Timeout                    | Record idle versus explicit run deadline; use shared watchdog and owned termination. Not a provider refusal or successful short answer.                                                               |
| Protocol / process failure | Malformed stream, startup error, signal/crash or transport loss; distinguish failure before dispatch from unknown completion after dispatch. No implicit replay.                                      |

Preserve legacy `EndTurn`/`end_turn` spellings only in their versioned native decoder.
The existing four-valued `TurnOutcome` is too coarse: extend shared structured terminal
facts/reasons and carry them through capture/recorder/CLI/Cue before mapping display state.
Current native parser treats a missing reason as completion; candidate decoding must not.
The upstream native projector maps unknown stop enums to `end_turn`; that information loss
cannot be repaired downstream and requires exact-version qualification or a route refusal.
Use `stopProcess` for escalation/descendants, and keep the lease until owned cleanup ends.
H documents 130/143 after SIGINT/SIGTERM and saved completed tool state; neither exit code
proves rollback or complete child spend. Windows and remote signal behavior need qualification.

### Accounting without invented completeness

Tag normalized reports by route, generation, session, turn/request and scope (response,
turn, in-process cumulative session, native lifetime, or child). H/B native result input is
uncached; B's ACP `_meta.usage.inputTokens` is full input, including `cachedReadTokens`
and `cacheCreationTokens`. Sibling `_meta` token fields describe the last call, not that
aggregate. Subtract cache-read and creation
once for the canonical disjoint buckets, checking nonnegative consistent values. For example,
full input 130, read 20, creation 10 yields uncached 100; native input 100 with those buckets
already disjoint must remain 100. Reasoning is an output subset, not an extra total bucket.

Native response `usage` lines inform context/per-response detail; authoritative turn `end`
or error spend replaces that turn's provisional accounting, never adds the same calls again.
ACP prompt usage is turn-scoped; U's `x.ai/session/usage` is cumulative only within the
current agent process and resets after resume in a new process. Native disk lifetime totals
are reconciliation snapshots, not additional turn deltas. Dedup by proven IDs/scope and
terminal latch, not identical payload text that could occur on two real turns. Missing
IDs require explicitly scoped single-settlement handling rather than guessed identity.

Reuse `UsageAccumulator`, `UsageProvenanceTracker`, shared totals and `modelPricing`;
extend their shared inputs for exact ticks and completeness instead of a Grok pricing engine.
Current `usageReportingFor('grok')` is per-step because the parser emits only end totals;
do not feed it ACP cumulative snapshots or rely on monotonicity to infer scope.
Preserve `cost_is_partial`/`usage_is_incomplete` (native) and corresponding camelCase ACP
facts (`costIsPartial`, `usageIsIncomplete`, `costUsdTicks`) before numeric defaults.
Absent/null cost, an incomplete ledger and Messages-style
zero placeholders mean unknown/partial, not free. Observed exact zero requires explicit
complete provider cost evidence. Validate integer tick tokens losslessly before JS number
coercion; retain decimal-string/BigInt precision at 10^10 ticks per USD. Unsafe parsed
numbers cannot be repaired by rounding. Estimates stay separately labeled with pricing
revision; runtime stream values retain the existing managed provenance classification.

Completed child usage can already be included in parent totals; never add it twice.
Retain per-model call counts, main-agent rounds and context occupancy as distinct measures.
Incomplete child drain/cancellation stays incomplete; compaction/side-model omissions must
remain visible. Reconcile a turn with disk only under the same account/host/native identity.

### Model and effort discovery

M initializes an ACP connection and calls `x.ai/models/list`; its extension envelope can
contain nested `result`/`error`, so transport success alone is not discovery success.
S returns session model state and typed `configOptions`; C validates model/effort IDs via
`session/set_config_option` and returns the updated option list. Cache by binary version,
selected account/endpoint, host and relevant config generation. Invalidate effort options
after model changes and require the acknowledged selection before prompt dispatch. Session
creation can warn and keep a default after model-switch failure; compare returned effective
model/effort rather than assuming a successful create response accepted the requested model.

Canonical vocabulary is `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, but
only the model's advertised options are valid; menu IDs may map to different wire values
or model variants. `none` is not universally accepted. Do not equate a static list with
current permission to route a model, invent three model tiers, silently downgrade effort,
or retry a rejected rung. Reuse `modelTiers` and `effortRejection`; intersect with managed
model/account policy after routing. Stale/offline fallback is labeled, never authoritative.
Network model discovery remains disabled in this task and requires GT1-01-05 isolation.

### Capability producer, transport, consumer and invariant matrix

Every row is a conditional implementation obligation for the canonical capability of the
same name in parity. None enables a flag here. N = native-headless, A = ACP, Hst = existing
host storage/runtime adaptation. Source pins above describe candidate producers; shared
consumer paths are expanded in the reuse table below. Required unsupported outcomes remain
blockers rather than disappearing from the UI and being declared complete.

| Capability                       | Producer / transport                                    | Maestro consumer                                       | Testable invariant; owner phases                                                                       |
| -------------------------------- | ------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `supportsResume`                 | Exact native resume (H) / N; load response (S) / A      | Session planner, recorder, History                     | Same account/host/native ID after restart; failed load never creates; 03/04.                           |
| `supportsReadOnlyMode`           | Version-qualified mode and enforcement / N or A         | Launch permission ceiling, utility callers             | Denied write/shell/network classes have zero effects; label residual permitted temp writes; 02/09/11.  |
| `supportsStandardPermissionMode` | Genuine pre-effect request / A                          | Existing consent and effect ports                      | No allow default; stale/denied reply cannot execute; native output-only cannot substitute; 03/09.      |
| `supportsJsonOutput`             | H native frames / N; A RPC / A                          | Native parser or ACP decoder                           | Never parse the other route's envelope as a successful result; 03.                                     |
| `supportsSessionId`              | Confirmed end (H) / N; allocation/load (S) / A          | Tab mapping and recorder                               | Missing end or rejected proposed UUID never creates a resumable identity; 03/04.                       |
| `supportsImageInput`             | I JSON blocks / N; advertised image content / A         | Prompt delivery, portable/desktop send                 | Bytes/MIME/order survive; refuse absent image capability with no text-only retry; 02/10/11.            |
| `supportsImageInputOnResume`     | Same verified content path on exact loaded ID / N/A     | Resume/send consumers                                  | Attachment stays on original native ID and executing host; 02/04/11.                                   |
| `supportsSlashCommands`          | `available_commands` (H), session command updates / N/A | Existing command discovery/autocomplete                | Scope current commands to session; execution semantics verified, no fake local action; 03/05.          |
| `supportsSessionStorage`         | Native files / Hst                                      | Existing Grok storage, History/search                  | Account/cwd/host-scoped bounded reads; mixed file generations marked partial; 04.                      |
| `supportsCostTracking`           | Optional complete/partial cost (H/U) / N/A/Hst          | Shared provenance, stats/Cue/dashboard                 | Absent cost never becomes zero; exact ticks survive; 03/04/10.                                         |
| `supportsUsageStats`             | Explicit usage scopes (H/U) / N/A/Hst                   | Capture, totals, recorder                              | Cached buckets and child totals counted once; 03/04.                                                   |
| `supportsBatchMode`              | H one-shot / N; host one-turn lifecycle / A             | Queue, run-to-completion, Auto Run                     | One queued task yields one settlement, no hidden interactive wait; 03/08.                              |
| `requiresPromptToStart`          | N input contract; A may initialize without prompt       | Launch planner/process admission                       | Retain N prompt requirement; do not force ACP preflight through raw stdin logic; 02/03.                |
| `supportsStreaming`              | H deltas / N; session updates / A                       | Shared events, desktop/web/Lite                        | Chunk fragmentation preserves text order and bounded buffering; 03/10.                                 |
| `supportsResultMessages`         | H end / N; prompt response / A                          | Turn capture and workflow settlement                   | One terminal result; refusal/incomplete is not success; 03/08.                                         |
| `supportsModelSelection`         | M/S/C catalogs and selection / N/A                      | Detector/settings, model routing                       | Effective selected model acknowledged or refused, never replaced silently; 02/09.                      |
| `supportsStreamJsonInput`        | No native Claude-style stdin producer                   | Prompt delivery                                        | False for N; A RPC is not this flag and must use its own transport port; 02/03.                        |
| `supportsPromptViaStdin`         | No raw-stdin producer in I                              | Windows/SSH launch                                     | False for N; long prompt uses owned file; A uses framed RPC; 02.                                       |
| `supportsThinkingDisplay`        | Reported thought chunks / N/A                           | Shared reasoning events and existing display lifecycle | No invented content or stale thinking in another turn; 03/05.                                          |
| `supportsContextMerge`           | Maestro validated prompt assembly / Hst + N/A           | Existing context merge/translation preflight           | Provenance/limits/loss warnings retained; not native history migration; 06.                            |
| `supportsContextExport`          | Existing native reader / Hst                            | Existing context exporter                              | Roles/tool/image linkage and redaction preserved; never execute transcript; 04/06.                     |
| `supportsWizard`                 | Qualified structured answer plus mode / N/A             | Wizard/grooming callers                                | Schema validation/retry bounded; strict no-tools requests refuse unproven routes; 05/09.               |
| `supportsGroupChatModeration`    | Host orchestration plus qualified turns / N/A           | Existing moderator/runtime                             | Correct participant/turn identity and bounded stop; no interactive stall; 08.                          |
| `usesJsonLineOutput`             | H NDJSON / N                                            | Shared line router                                     | True for native frames; ACP JSON-RPC has distinct route discriminator despite newline framing; 03.     |
| `usesCombinedContextWindow`      | Selected model context metadata / N/A                   | Context gauge/shared usage                             | Context occupancy distinct from session spend, unknown size stays unknown; 02/03.                      |
| `supportsAppendSystemPrompt`     | H rules/alias candidate / N; verified session setup / A | Canonical system delivery                              | Append versus replace distinguished; one instruction copy per delivery policy; 02.                     |
| `supportsProjectMemory`          | Native resource evidence / Hst                          | Existing memory/resource APIs                          | Discovery/trust/export semantics proven separately; native memory name is insufficient; 05/06.         |
| `supportsAdditionalDirectories`  | Actual qualified root-grant mechanism / N/A             | Definition builder/launch/policy                       | Builder/capability agree; cwd/prompt mention never grants write; symlinks and read-only tested; 02/09. |
| `imageResumeMode`                | Existing prompt-embed fallback only where qualified / N | Image and resume assembly                              | Retain legacy meaning; never map an ACP block to tool-read fallback implicitly; 02/04.                 |

### Reuse and bounded adapter ownership

All relative paths in this table are under `src/shared/maestro-lib/` unless fully qualified.
Phase tasks already name candidate files; resolve actual symbols before edits. No second
provider ID, store, broker, spawner or price calculator is proposed.

| Responsibility             | Existing implementation to extend                                                                                                          | Missing adaptation and owner                                                                                                                                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RPC correlation            | `codex/rpc-client.ts` (`CodexAppServerRpc`)                                                                                                | Extract reusable IDs/pending/deadlines/close core to proposed `protocol/json-rpc.ts`, preserving Codex wrapper/tests. ACP schemas stay separate. GT1-03-01/02; GT1-01-07 must split extraction if its existing file bound is exceeded. |
| Route facts                | `providers/capabilities.ts`, `launch/launch-plan.ts`, `src/main/agents/capability-snapshot.ts`                                             | Proposed `grok/route.ts` for pure requirement intersection only; compose existing launch/managed decisions. GT1-01-07 assigns bounded shared and consumer packets; 02/08/09/10 integrate them.                                         |
| ACP wire/session/events    | No existing ACP client; `run/start-turn.ts`, `run/session.ts`, `turns/turn-events.ts` provide ports                                        | Proposed `grok/acp-protocol.ts`, `acp-client.ts`, `acp-session.ts`, `acp-events.ts`, `acp-requests.ts`, `acp-turn.ts`, each limited to its phase03 packet. Client wraps extracted RPC rather than copying it.                          |
| Prompt artifacts           | `launch/prompt-delivery.ts`, provider `promptFileArgs`, `run/pipe-spawn.ts`, desktop `ChildProcessSpawner`                                 | Existing Windows positional replacement would leave Grok's `-p` dangling; extend generic delivery/materialization/remote cleanup, not a Grok writer. GT1-02-09/10/11.                                                                  |
| Lifetime and admission     | `startTurn`, `leaseAdmission`, `control/termination.ts`; `src/main/utils/idle-watchdog.ts`                                                 | Open ACP stdin via existing process port, cancel then owned escalation; reuse admission and lease, no second runner. GT1-03-03/09.                                                                                                     |
| Normalization and outcomes | `parsers/grok-output-parser.ts`, `parsers/agent-output-parser.ts`, `streaming/turn-outcome.ts`                                             | Preserve native decoder; add structured completeness/reason and exact cost facts in shared types/consumers through bounded phase03 packets.                                                                                            |
| Usage and recording        | `run/turn-capture.ts`, `streaming/usage-accumulator.ts`, `streaming/usage-totals.ts`, `turns/record-turn.ts`; `src/shared/modelPricing.ts` | Declare reporting scope explicitly; single recorder owns usage/transcript persistence. GT1-03-05/11 and phase04 consumers.                                                                                                             |
| Native history/identity    | `src/main/storage/grok-session-storage.ts`, `src/shared/providerProfiles.ts`, `src/shared/agentAccountDir.ts`                              | Extend scoped existing reader/resolvers; no new provider-owned store. Phases02/04.                                                                                                                                                     |
| Permission/ask-back        | `managed/effects.ts`, `managed/authority.ts`; `src/main/permission-relay/`                                                                 | Adapt genuine requests to existing host interaction/effect interfaces; headless unavailable response; managed coverage remains separately qualified. GT1-03-07/08A and phases07/09/10.                                                 |
| Discovery                  | `src/main/agents/detector.ts`, `provider-probe.ts`, shared `modelTiers`/`effortRejection`                                                  | Current detector uses process-global Grok home/static efforts; bind selected profile and negotiated menus. GT1-02-05/07.                                                                                                               |

GT1-01-07 must reconcile shared terminal/usage type extensions, generic RPC extraction,
pure route selector and portable image acceptance with concrete bounded task files before
implementation. This design adds no later checkbox and claims no implementation done.
GT1-01-05 owns disposable environment/authorization controls; GT1-01-06 owns baseline
application suites. Product/native/managed/platform evidence remains `not-run`; live
credentials stay unset and every live budget remains zero.
