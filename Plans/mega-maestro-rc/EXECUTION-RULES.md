---
type: execution-contract
title: Maestro 1.1.0-RC managed integration execution rules
created: 2026-10-19
tags: [maestro, mega-maestro, integration, autorun, security]
execution_root: maestro
base_ref: v1.1.0-RC
base_revision: 6400a6da0cfbae97bd90c4b361eea163fc3a1223
feature_branch: feature/mega-maestro-v1.1.0-rc
---

# Maestro 1.1.0-RC managed integration execution rules

Related: [[EXECUTION-RULES]], [[AGENTS]], [[CLAUDE-AGENTS]], [[CLAUDE-IPC]], [[CLAUDE-PLUGINS]]. The source evidence is `source-review.json` beside this document. The installed copy of these rules belongs at `Plans/mega-maestro-rc/EXECUTION-RULES.md` in the Maestro worktree.

## Ownership and objective

Implement the Maestro side of managed operation with Mega-Maestro, based on the reviewed release `v1.1.0-RC` at `6400a6da0cfbae97bd90c4b361eea163fc3a1223`. Twelve ordered Auto Run phases build enrollment, policy and identity bindings, qualified execution controls, governed telemetry and operational surfaces. Preserve normal unmanaged Maestro behavior and existing user data. Unsupported managed routes must refuse execution explicitly, without fallback to unmanaged operation.

This document is authored and staged in the Mega-Maestro workspace. Authoring does not authorize this agent to modify the sibling Maestro checkout. A Maestro-owned agent must install and execute the playbook in its prepared isolated worktree. Do not build application code, switch references, launch Auto Run, change installed settings, or mutate the sibling repository merely to prepare this analysis package.

The worktree must use `feature/mega-maestro-v1.1.0-rc` and the exact base revision above. The installer must inspect current `maestro-cli` worktree help, then use the supported CLI worktree creation operation with `--base-branch 6400a6da0cfbae97bd90c4b361eea163fc3a1223` and the requested branch. Verify the resulting worktree, branch and base ancestry. Do not silently reuse an unrelated branch or reset an existing dirty branch. Worktree preparation must not launch an agent or playbook. Installation and execution are separate actions; launch only when requested, through Maestro's Auto Run engine with the intended agent explicitly selected.

## Dispatch and bounded tasks

Use one finite, task-based run in the manifest's twelve-phase order. Every checkbox starts with a fresh context and must name the rules, source contracts, files, expected behavior and success criteria it needs. Return to the engine after each task. A reply or document boundary is not completion of the run. Disable looping and checkbox resets. Do not start another agent, peer playbook or project run automatically.

Implementation, test authoring and verification are separate checkbox tasks. Keep each task to one to three authored files and fewer than 500 changed lines. Include wiring, exports and configuration in those limits; create a uniquely named bounded continuation when more files are necessary. Generated files must be reproducible and reported separately. A manifest-only package, unreachable adapter, denial-only implementation or test double is not a working feature.

Read the installed worktree's `AGENTS.md` and the relevant guide from `docs/agent-guides/` before changing code. Follow the provider, IPC, session, process, platform, Cue and plugin references when their boundaries are involved. Search existing code before creating a helper, store, queue, parser, schema or component. Extend `maestro-lib`, existing process launch paths and existing IPC/CLI adapters. Consume the public Mega-Maestro contract, policy evaluator, endpoint transport and durable queue; do not create a second policy engine, spool, device identity or command execution protocol inside Maestro.

Preserve checked tasks and unrelated changes. Before writing, confirm the current source still has the named seam; adapt a task to its existing equivalent instead of creating a duplicate. Keep task IDs, manifest order and completion counts synchronized when inserting a repair. Do not copy old playbook snapshots into the active queue.

## Cross-project dependency contract

The Maestro agent owns only the Maestro worktree and its permitted artifacts. Never modify Mega-Maestro's repository, perform a peer commit, or silently patch public packages locally to make integration pass. Consume versioned public packages and explicitly configured loopback service artifacts. Record the package version, digest, source revision and configuration used, without secret values.

Three mandatory coordination prerequisites are tracked independently:

- **CP-01: current public packages and services.** Obtain compatible public contracts and packaged endpoint/API/gateway artifacts built from the current Mega-Maestro implementation. Earlier snapshots, stale library archives and schema-only compatibility do not prove that the actual producers exist or interoperate.
- **CP-02: actual Maestro runtime adapter.** Mega-Maestro's reviewed `createMaestroAdapter` is unsupported. Its real producer must become available and pass the negotiated runtime contract. A neutral runtime or a Maestro-side fake cannot satisfy this prerequisite.
- **CP-03: delegated workflow authority.** The reviewed bridge rejects the required delegation/workflow authority. Obtain a supported producer that binds authenticated actor, tenant, device, agent, policy and workflow/run authority through command handoff and receipts. A transport token or fabricated lease cannot substitute for it.

Phase 04 must run an early real Maestro/endpoint/API pairing exercise. Phase 12 must repeat and complete the full paired journeys, including the gateway when routing is exercised. Unit doubles prove local behavior only and cannot close either milestone. If a prerequisite is absent, keep its dependent verification and the final completion task unchecked, name the producer and owner, and record evidence. Independent bounded implementation can still be prepared where meaningful; do not certify integration, skip the failed check or claim end-to-end success. A genuine missing peer producer is a coordination dependency, not permission to weaken verification or change the peer repository.

## Identity, credentials and routing

Managed authority must come from a verified Mega-Maestro identity and delegation chain. Bind tenant, device, agent, actor, policy generation and workflow/run identity at the authoritative host operation. Labels, agent-supplied environment variables, account directory names, API-key suffixes and unverified token claims are not authenticated principals.

Maestro Web Login's local users are equal operators; its cookie is not enterprise RBAC. The CLI's per-boot secret and Lite paired-device credentials admit their respective transports; neither grants a tenant role, device enrollment authority or permission to mint execution grants. Add managed authorization at host sinks and reconnect/resume paths while preserving existing transport checks. Do not broaden remote browser access to provider credentials or private host settings.

Keep credential regimes distinct:

- Provider OAuth stores remain provider-owned and host-local. Do not collect or upload their token files. Existing account discovery, billing profiles and reauthentication labels may inform UI but never enterprise authorization.
- `lookupSecret()` and `resolveSecrets()` supply named systemd, `/run/secrets` and environment values. Existing `requiredSecrets` is a launch dependency declaration, not authorization. Missing values warn in ordinary Cue behavior; managed launches must fail closed when an approved credential is required but missing, revoked, expired or mismatched.
- Lite `DeviceCredentials` protects remote pairing with OS encryption and exact host/origin binding. Preserve Tailscale peer binding and immediate revocation. Do not reuse this bearer credential as the Mega-Maestro device identity.
- New managed identity custody must use the existing seal and keyring-anchor primitives, separate device/profile/tenant namespaces and an explicit recovery path. Refuse persistent managed authority when encryption is unavailable, Linux uses `basic_text`, or freshness cannot be established. `obscuringSeal()` has an embedded shared key and is never acceptable credential protection.

Store opaque approved credential references and safe status metadata in ordinary configuration. Resolve values only at the host launch boundary for the authorized consumer. Keep private material out of renderer state, IPC responses, process details, logs, CLI listings, bundle archives, synced settings and managed telemetry. Tests must inject fake credential stores and anchors rather than access the developer's keyring or provider accounts.

Managed provider, model, gateway origin, account selection and credential bindings must take precedence over user environment and arguments. Inspect desktop, CLI, Cue, SSH, plugins, group chat, Symphony and resume paths for bypasses. Inherited provider variables, custom base URLs, shell commands and fallback-to-personal OAuth must not bypass the approved route. Unsupported remote credential delivery or provider behavior remains denied and visibly unsupported. Outside managed mode, preserve existing environment precedence and login behavior.

Intersect plugin grants with the signed managed ceiling at the existing broker and execution handlers. Preserve local consent, manifest and signature identity, unattended consent, protected paths, target checks, cancellation and immediate revocation. Managed policy may narrow existing consent; it must not manufacture consent, rewrite the sealed grant ledger or elevate a trusted publisher to unrestricted authority.

## Execution qualification and evidence privacy

Treat SDK-backed agents, terminal/PTY agents, SSH processes, provider internal tools, sandboxed plugin calls and shell executors as separate enforcement routes. A qualified route requires positive allowed execution, denied execution before side effects, policy/identity binding, lifecycle and cancellation behavior, and evidence from the actual protected sink. Parsing tool output, adding a system prompt, setting a flag or disabling a UI button does not qualify enforcement.

Report capability support precisely by provider, launch surface, operating system and route. Never advertise a route solely because its binary starts or metadata says it supports a capability. Preserve denial until its real authority and enforcement producers are implemented. A managed restriction must remain effective during reconnect, restart, stale policy, credential revocation and agent-initiated nested execution. Same-user local storage and prompts do not establish an OS security boundary.

Use the existing governed collection contract and endpoint queue for telemetry. Apply authorization, consent, projection/redaction, content limits and retention before data leaves the appropriate boundary. Test secret canaries through live events, diagnostics, bundles and exported evidence. Preserve event provenance and explicitly report gaps or discarded payloads; do not fabricate tool events or claim complete capture from partial provider output.

Do not repurpose private per-agent recording controls or their local store as the enterprise collection channel, expose them through new CLI/web surfaces, or use them as enterprise audit authority. Any additional collection capability, content scope or feature outside the agreed integration remains a surfaced proposal until reviewed. A separate allowlisted managed event channel must follow the governed collection contract and existing endpoint delivery mechanisms.

## Verification and recovery

Reuse the repository's test factories and harnesses. Add deterministic unit tests with injected policy readers, identity verifiers, clocks, custody providers and process adapters. Focus checks on externally visible behavior, authorization and failure recovery. Run the focused tests and relevant type/build checks for a phase; repeat or broaden only for changed code or unresolved failures. Do not add CI/CD pipelines, release automation, broad continuous load suites or human approval checkboxes to this implementation run.

Use isolated synthetic identities, deliberate provider doubles and project-owned service namespaces for ordinary development. Label them explicitly. Real pair verification must use actual Maestro code and the actual public Mega-Maestro endpoint/API/gateway producers; synthetic accounts may supply development identity, but a fake runtime or fabricated lease does not prove that pair. No paid provider traffic, production enrollment/deployment, live user messages, publishing or automatic merge is authorized by this playbook.

Repair ordinary build, test, local service and configuration failures using bounded continuations before the failed consumer, then retry the focused check. Do not add blanket preflights, preauthored halt/HITL markers, repeated whole-repository reviews or manual sign-off gates. Inspect service ownership and ports before starting a harness; do not stop the user's running browser/API stack. Never bypass authentication, downgrade policy or mark skipped verification successful just to keep dispatch moving.

Write concise evidence with YAML front matter and wiki links under the installed plan's evidence directory. Record source/package revisions, commands and exit codes, positive/negative behavior, skipped tests, capability limitations and named dependencies. Do not include credential values or unredacted private content. Preserve a failing check as incomplete when the required producer is external to this worktree and unavailable.

## Completion

The twelve-phase run finishes only when all implementation and repair tasks are complete, focused checks pass, both real paired milestones pass, and the final capability matrix matches demonstrated behavior. Every required row in the manifest's positiveAcceptanceMatrix must pass with actual Maestro/endpoint/API boundaries, the declared safe provider fixtures and independently observed effects. Disabling a required channel, declaring all routes unsupported or counting only denials cannot satisfy completion. Unqualified real-provider or native platform routes remain separately denied. Required cross-project producers must be present and their real exercised artifacts recorded. Neither completed local code nor all-green unit doubles is equivalent to completed integration.

The final report identifies the feature branch/base, changes, verified routes, paired artifacts and limitations. Unqualified routes remain unavailable. Optional feature suggestions and production/manual follow-up are plain prose and do not silently expand scope. If CP-01, CP-02 or CP-03 remains missing, report the actual dependency and partial results without marking the integration complete.
