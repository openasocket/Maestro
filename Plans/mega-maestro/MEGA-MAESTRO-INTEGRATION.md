---
type: integration-plan
title: Independent Maestro and Mega-Maestro delivery agreement
created: 2026-09-18
version: enforceability-v2
status: design-not-implemented
tags: [mega-maestro, contracts, integration]
---

# Independent delivery agreement

Related: [[MEGA-MAESTRO-DELIVERY]], [[MEGA-MAESTRO-MODULARITY]], [[MEGA-MAESTRO-SECURITY]].

## Execution and ownership

Two task-based playbooks, two agents, two repositories. Maestro-Codex (9b4b298d-918a-4c8d-a9a8-c9a014a04adb) uses /Users/dr3/dev-shit/Maestro/.maestro/playbooks/2026-09-18-Maestro-Enterprise-Integration. Mega-Maestro-Codex (0e1de84b-08c2-43f7-a9b3-865419a715ba) uses /Users/dr3/dev-shit/mega-maestro/.maestro/playbooks/2026-09-18-Mega-Maestro. Their configured Auto Run roots were verified as their respective repository's .maestro/playbooks folders. Do not launch either as part of authoring.

Maestro owns the generic runtime facade, current desktop/CLI/Cue adapters, local enterprise client, managed UX, and integration regression tests. Mega-Maestro owns enterprise schemas, policy evaluation/cache, endpoint daemon and privileged execution broker, gateway, central services, console, and joint test orchestration. Do not implement a second policy engine or durable enterprise spool inside Maestro.

Maestro implementation requires feature/mega-maestro-integration and an explicitly selected clean base. The current feature/hom-mode checkout is not authorization to implement on that branch. Provision the integration branch/worktree before launching; preserve the planning documents in its configured readable Auto Run/design roots. Do not switch an active checkout automatically.

## Foundation independence and early enforceability

MEGA-MAESTRO-ENFORCEABILITY.md and execution-plan.json define the amended schedule and early evidence contract. Application 01-06 and Maestro 01 develop independently. Application MEGA-ENFORCEMENT-01 exports the real minimal endpoint/gateway; Maestro MAESTRO-ENFORCEMENT-01 binds it and exports the real client; application MEGA-ENFORCEMENT-02 proves the pair. This real gate blocks application phase 07 and Maestro phase 02 breadth. No producer waits for its consumer's final acceptance.

After that checkpoint, application 07-14,16-22 and Maestro 02 extend the existing implementation. Maestro 03 refreshes the full client before application 23 runs full qualification. Application phase 24 separately owns 10k scale and unified release acceptance. Local preparation, early feasibility, full joint qualification and complete-MVP status are distinct.

Missing counterpart blocks the explicit early binding/pair gate and later full qualification, not independent foundations. A fixture pass cannot close any real gate. Missing external scale/manual evidence blocks release without preventing local readiness reporting or full pair execution. Halt a blocked scheduled gate once and resume when its prerequisite arrives; do not poll indefinitely or silently skip it.

## Bootstrap boundary and artifact convergence

This agreement is a behavioral design baseline, NOT an already released wire protocol. Both repositories receive identical snapshots and record SHA-256 of this file before implementation. Preserve the baseline; propose amendments with a new version/digest. Enterprise wire-schema authority is Mega-Maestro packages/contracts; generic runtime facade authority is Maestro. No competing hand-maintained enterprise wire types.

Before the enterprise package exists, Maestro implements its owned transport-neutral port and dependency-injected endpoint test double. This supports lifecycle, UI, policy-denial and event tests without guessing HTTP/socket messages or importing sibling source. The actual enterprise wire binding is first implemented in MAESTRO-ENFORCEMENT-01 and refreshed for full coverage in phase 03, never supplied by a production fake. Enrolled starts fail closed if that binding/endpoint is unavailable. Standalone behavior remains unchanged.

Mega-Maestro implements its endpoint against a neutral runtime fixture and this behavioral baseline. It exports the enterprise schemas/client and conformance vectors as an immutable local archive. Maestro exports its runtime facade artifact and consumer expectations. Each artifact has semantic version, source commit (or explicitly dirty source-tree digest during development), SHA-256, capabilities and test provenance. Local archives require no public publication and are imported into repository-owned vendor/artifact storage with verified digests, never sibling file dependencies.

Maestro must replace bootstrap test-only assumptions with the exact enterprise archive, pin it in its own dependency metadata, and rerun consumer tests. Mega-Maestro must bind the actual runtime-facade artifact and run those same consumer expectations against its real endpoint. Schema mismatch is repaired in the owning repo with a new version and repeated tests; no agent edits the other repo's implementation or silently widens policy.

## Behavioral contract coverage

Implement fixture and real-adapter cases for every row. Exact serialization and transport are defined once in the owning schema artifact, not independently invented by consumers.

| Boundary           | Required inputs and trusted context                                                                                                       | Required outcomes and invariants                                                                                                                                         |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Attachment/status  | Authenticated local peer, installation/runtime/component IDs, process epoch, supported protocol/capabilities                              | Negotiated capabilities, managed state, desired/applied policy revisions, connectivity and collection profile; unsupported mandatory capability denies activation        |
| Enrollment         | Attended or managed invitation, profile, key possession, tenant trust bootstrap                                                           | Endpoint owns keys and central enrollment; UX only requests/displays enrollment; missing daemon is not unenrollment                                                      |
| Governed execution | Request/attempt/run IDs, actor/source (UX/CLI/Cue/headless), exact arguments/resources, provider/model, causal parent and policy revision | Deny with stable reason or broker-bound authorized execution; altered requests/expired grants/reused decisions cannot dispatch; no authorize-then-unprotected-spawn race |
| Offline operation  | Last verified policy, exception expiry, budget allowance, trusted clock state                                                             | Endpoint keeps mandatory policy while disconnected or UX closed; invalid cache denies, expired allowance cannot be renewed locally                                       |
| Telemetry/content  | Stable event ID, runtime epoch/sequence, run/session/parent, timestamp, policy revision, completeness, capture profile, usage provenance  | ACK only durable acceptance; bounded retries/dedup; gaps explicit; metadata excludes content; original VIBES bytes and derivative hashes remain distinct                 |
| Commands           | Authenticated typed command, command ID, target/run, expiry, policy revision, preconditions                                               | Dedup, reauthorization and accepted/completed/unknown outcomes; no remote shell or implicit prompt injection                                                             |
| Inbox/feedback     | Authenticated user/scope, campaign/message ID, receipt/reply idempotency key                                                              | Private reply isolation, distinct delivery/read/ack/reply states, scoped aggregation                                                                                     |
| Workflow ownership | Workflow/trigger/run/attempt IDs, owner epoch/fence                                                                                       | Cue owns local scheduling; retries reauthorize; no reassignment to a second owner while an offline-enabled owner remains unfenced                                        |
| Budget/routing     | Reservation/request identity, allowed destination, signed offline allowance, actual/estimated usage                                       | No direct-egress bypass, duplicate charge or silently free unknown price; historical org attribution retained                                                            |
| Compatibility      | Enterprise protocol, runtime facade, endpoint, Maestro/UX/CLI/Cue and VIBES versions                                                      | Supported pair passes shared vectors; unsupported versions fail explicitly, never disable required controls                                                              |

Transport security must include local OS peer authentication and protected endpoint binding, remote mutual authentication, bounded framing/payloads/timeouts, replay protection and redacted errors. A claimed tenant/actor in a payload does not grant authority. No new custom cryptography. Error and disconnect outcomes deny governed effects without treating absent telemetry as successful enforcement.

## Handoff and joint acceptance

Each repo writes a handoff manifest: Maestro Plans/mega-maestro/evidence/handoff.json; Mega-Maestro docs/evidence/handoff.json. Fields: integrationId mega-maestro-v1, stage, agreementDigest, enforceabilityDigest, repositoryRevision, sourceTreeDigest with documented implementation-only inclusion rules, artifact paths/digests/versions, capabilities, OS/provider matrix, exact commands/results, localStatus, jointStatus, pending prerequisites. No secrets or absolute paths assumed valid on another host.

Mega-Maestro owns joint orchestration and writes docs/evidence/joint-integration.json. Maestro imports a digest-verified copy into Plans/mega-maestro/evidence/joint-integration.json, validating its own revision/artifact digest. Changed implementation/configuration/lockfiles or artifacts invalidate affected joint evidence; report/checkbox changes do not change the implementation digest. Record digest inclusion rules as specified by the enforceability contract. Tests run real packaged server + endpoint + Maestro in an authorized isolated environment, with safe fixture tool/provider effects; the endpoint or Maestro may not be replaced by a double.

Required joint scenarios: enrollment and policy acknowledgement; desktop/CLI/Cue enforced denial before effects; offline restart with last policy and bounded budget; telemetry/VIBES provenance and cost dedup; operator message/private reply and command replay; UX closure/headless management; incompatible-version rejection and rollback; unenrolled standalone regression. Security, platform/provider, scale, SaaS/self-hosted and human review gates in the design remain mandatory.

Foundations may finish independently; breadth requires the early real-pair evidence defined in the enforceability amendment. Unified capability is complete only after the same source/artifact pair passes actual joint scenarios and all release gates. Neither missing counterpart nor an unmeasured 10k test can be marked passed.
