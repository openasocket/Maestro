---
type: delivery-plan
title: Mega-Maestro Delivery and Auto Run
created: 2026-09-18
status: authored-not-launched
tags: [mega-maestro, playbook, delivery]
---

# Delivery plan

Related: [[MEGA-MAESTRO-DESIGN]], [[MEGA-MAESTRO-SECURITY]], [[MEGA-MAESTRO-GOVERNANCE]], [[MEGA-MAESTRO-MODULARITY]].

## Authoring outcome and execution boundary

This is a design and implementation-playbook deliverable. The user has provisioned and initialized the independent application Git repository at /Users/dr3/dev-shit/mega-maestro; its root was verified. No application implementation, real enrollment, cloud deployment or Auto Run launch has occurred.

Each repository carries the design snapshot: Maestro Plans/mega-maestro and Mega-Maestro docs/design/mega-maestro. Playbooks are local to /Users/dr3/dev-shit/Maestro/.maestro/playbooks/2026-09-18-Maestro-Enterprise-Integration and /Users/dr3/dev-shit/mega-maestro/.maestro/playbooks/2026-09-18-Mega-Maestro. Both are task-based. MEGA-MAESTRO-INTEGRATION.md defines independent execution and shared acceptance.

The application repository is /Users/dr3/dev-shit/mega-maestro (the user's ~/dev-shit/mega-maestro), already initialized as an independent Git repository. Browser application is the proposed initial client; an optional Electron shell can reuse its UI and backend. Both SaaS and self-hosted distribution are complete-MVP requirements. Application design sources and Auto Run documents reside in the application repository; its implementation tasks execute with /Users/dr3/dev-shit/mega-maestro as their writable working directory. Do not reinitialize or replace the existing repository.

Before execution, provide an application agent whose writable root is the independent Git repository at /Users/dr3/dev-shit/mega-maestro and a Maestro integration agent on feature/mega-maestro-integration in the Maestro repository. Prefer a dedicated Maestro worktree based on a recorded clean integration baseline. Do not base compatibility work on feature/hom-mode by default or include unrelated changes. Make the five design documents and phase artifacts readable to both. The implementation runner must not treat "application" as permission to create a nested app under Maestro or silently write to a sibling checkout.

## Repository and compatibility contract

| Repository   | Ownership                                                                                         | Branch and review boundary                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| mega-maestro | Console, central services, endpoint service, gateway, contracts, deployments and enterprise tests | Independent Git history, application feature branches, CI, lockfiles and releases                                     |
| Maestro      | Enrollment UI, local endpoint client, execution integration, telemetry bridge and user inbox      | feature/mega-maestro-integration, based on an explicitly recorded clean Maestro revision; dedicated compatibility PRs |

No application source is embedded in Maestro and no Maestro source is vendored into Mega-Maestro. A worktree of Maestro is not a separate application repository: verify distinct Git common directories for the two codebases. Keep commits and PRs scoped to their repository and link related changes using a shared integration identifier.

Enterprise protocol ownership is mega-maestro/packages/contracts; generic runtime contract ownership stays with Maestro and its planned Lib interface. packages/runtime-adapter maps between them without circular dependencies. See MEGA-MAESTRO-MODULARITY.md for Lib/UX/CLI/Cue responsibilities and migration. Package or generate immutable schema/client artifacts with semantic version, source commit and checksum. Consumers pin the artifact in their own lockfile. Do not use sibling-directory imports, symlinks, local path dependencies or manually divergent copies. During local development use a checksummed package archive; public package publication is a separate release action.

Both repositories must build and run unit/contract tests independently. Joint CI checks out explicit commits in separate directories and runs black-box integration through the supported interfaces. Publish a compatibility matrix containing Maestro version, endpoint version, server version, runtime-facade/Lib version, UX/CLI/Cue component versions, protocol version, VIBES producer version and required capabilities. Test supported older-client/newer-server and newer-client/older-server combinations, plus explicit rejection of unsupported versions. Never downgrade mandatory enterprise controls to obtain compatibility.

Prefer additive protocol evolution: deploy compatible server support, then endpoint/client support, then activate policies requiring new capabilities only after acknowledgements. Breaking changes require a new major protocol, explicit migration, a documented support window and tested rollback. An unenrolled standalone Maestro installation must retain its existing behavior, while an enrolled installation cannot silently fall back to unmanaged execution.

Cross-repository handoff evidence includes each source revision, independent test results, contract artifact digest, integration results, compatibility matrix and paired change references. Required VIBES changes are explicit dependencies reviewed for the selected Maestro baseline; never merge an unrelated feature branch automatically.

## Enforceability-first schedule

Read [[MEGA-MAESTRO-ENFORCEABILITY]] and execution-plan.json for the explicit dependency graph. Do not launch all documents by filename order.

1. Application 01-06 and Maestro 01 are independent foundations.
2. Application MEGA-ENFORCEMENT-01 exports the real minimal endpoint/gateway. Maestro MAESTRO-ENFORCEMENT-01 consumes it and exports the real client. Application MEGA-ENFORCEMENT-02 proves real enforcement, with Maestro reproduction at the start of phase 02.
3. Only after that proof, continue application 07-14,16-22 and Maestro 02. Extend early implementations in place.
4. Maestro 03 exports its full client before its final joint-acceptance checkbox. Application 23 runs full joint qualification; Maestro then validates that report.
5. Application 24 separately runs MM-21-05 scale qualification and MM-23-04 unified acceptance, preserving their original task IDs. External capacity and human reviews remain mandatory release gates without blocking local readiness or full paired testing.

Current task counts and exact ordered IDs are in execution-plan.json. This is a schedule for the launcher/operator, not a built-in Maestro dependency feature. Each preflight must enforce its named evidence prerequisites; early gates are never inferred from a checked task alone. Production execution changes require the feature branch and authorized environments. The actual early provider/backend matrix is chosen in MM-01-15, before dependent implementation.

Do not launch during authoring. Use each agent's own Auto Run root, never the removed mixed-repository folder. The application agent records docs/implementation-context.json and docs/evidence/handoff.json. Maestro records Plans/mega-maestro/MAESTRO-INTEGRATION-MAP.md and Plans/mega-maestro/evidence/handoff.json. No chat-memory or sibling source dependency.

## Requirement matrix

| ID  | Requirement                                            | Primary delivery phases             | Pilot evidence                                                                                                    |
| --- | ------------------------------------------------------ | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| R01 | Separate enterprise experience, SaaS and self-hosted   | 01,16-18,20                         | Both deployment profiles and working authenticated console                                                        |
| R02 | Entra/SSO, org/suborg/BU/group structure, scoped roles | 02,03,18                            | Scope-isolation, identity lifecycle and enterprise-provider tests                                                 |
| R03 | 10k-plus fleet inventory, hierarchical attribution     | 02,07,12,16,21,24                   | 10k sustained test, org history and bounded query latency                                                         |
| R04 | Secure enrollment, key rotation, lifecycle             | 04,M01-M03,18,21,E01-E02,ME01       | Replay/rotation/revoke/reinstall and actual managed endpoint                                                      |
| R05 | Enterprise authority and policy lifecycle              | 05,06,10,M01-M03,17,E01-E02,ME01    | Conflict simulation, signed install, all-path bypass tests                                                        |
| R06 | Last policy enforced offline                           | 06,10,12,M01-M03,21,E01-E02,ME01    | Restart/disconnect/cert-expiry/clock/budget scenarios                                                             |
| R07 | Instances, agents, subagents, prompts and outputs      | 07,08,M01-M03,16                    | Trace lineage, snapshot reconciliation and missingness                                                            |
| R08 | Configurable collection including full available VIBES | 08,09,M01-M03,16                    | Producer conformance, full roundtrip and redaction provenance                                                     |
| R09 | DLP, tool/provider/plugin/subagent security controls   | 09,10,M01-M03,17,21,E01-E02,ME01    | Pre-side-effect protection and labeled DLP/bypass corpus                                                          |
| R10 | Mandatory allowed model routing                        | 10,11,M01-M03,17,21,E01-E02,ME01    | Real managed route, denied direct/fallback paths                                                                  |
| R11 | Costs, forecasts, budgets, KPIs and optimization       | 11,12,17,21                         | Accounting invariants, offline allowances and quality-constrained routes                                          |
| R12 | Operator commands and individual/group feedback        | 13,M01-M03,18,19                    | Delivery/ack/reply, replay safety and scoped summaries                                                            |
| R13 | NIST AI RMF/GAI profile, extensible frameworks         | 14,18,19                            | Control/evidence workflow, custom pack and immutable assessment                                                   |
| R14 | Security, operations, recovery, complete MVP           | 19-24                               | Packaged installs, measured resilience, review packet and no open critical gates                                  |
| R15 | Future Maestro Lib/UX/CLI/Cue boundaries               | 01,10,13,M01-M03,21,22,E01-E02,ME01 | Runtime facade, headless management, equivalent policy, stable inventory, Cue ownership and migration conformance |

## Phase inventory

| Phase   | Work                                                      | Execution root | Initially authored tasks |
| ------- | --------------------------------------------------------- | -------------- | ------------------------ |
| 01      | Repository foundations and contracts                      | application    | 18                       |
| 02      | Tenant organization and authorization                     | application    | 7                        |
| 03      | SSO and lifecycle provisioning                            | application    | 7                        |
| 04      | Enrollment and device identity                            | application    | 7                        |
| 05      | Policy schema and deterministic evaluation                | application    | 6                        |
| 06      | Policy studio services and signed rollout                 | application    | 7                        |
| 07      | Durable telemetry and fleet projections                   | application    | 7                        |
| 08      | Content vault VIBES and lineage                           | application    | 8                        |
| 09      | DLP services and endpoint inspection                      | application    | 7                        |
| 10      | Managed execution and provider conformance                | application    | 9                        |
| 11      | Model gateway metering and route enforcement              | application    | 7                        |
| 12      | Budgets allocation forecasts and optimization             | application    | 13                       |
| 13      | Fleet commands and communications                         | application    | 12                       |
| 14      | Governance risk and framework evidence                    | application    | 8                        |
| M01-M03 | Maestro foundations, breadth and full acceptance          | maestro        | 26                       |
| 16      | Console shell fleet and activity                          | application    | 8                        |
| 17      | Console policy security and FinOps                        | application    | 7                        |
| 18      | Console governance communications and administration      | application    | 7                        |
| 19      | Enterprise exports integrations and operations            | application    | 9                        |
| 20      | SaaS and self-hosted production packaging                 | application    | 8                        |
| 21      | Integrated scale security and resilience qualification    | application    | 10                       |
| 22      | Release evidence and local readiness handoff              | application    | 5                        |
| 23      | Full paired integration qualification                     | application    | 4                        |
| 24      | External scale and unified release acceptance             | application    | 3                        |
| E01-E02 | Early real endpoint, gateway and paired enforcement proof | application    | 17                       |
| ME01    | Early real Maestro wire binding and guarded entrypoints   | maestro        | 17                       |

Original baseline: 178 checkbox tasks across 22 documents. The split preserves these task IDs and adds explicit bootstrap, artifact and joint gates. Current counts and ordered task IDs are recorded in execution-plan.json; this table records initial phase sizing. Current owned task lists and the complete profile are described in execution-plan.json and EXECUTION-RULES.md. Tasks are intentionally small. Preflight may insert additional bounded tasks when the verified tree needs more integration files; this is especially necessary for Maestro's several entry points and platform conformance. Task counts are planning counts, not an effort estimate or completion metric.

Application phase 23 retains full paired qualification; phase 24 owns separately scheduled scale and unified release acceptance. Early E01/E02 documents precede breadth. Existing task IDs remain stable for evidence traceability. Maestro phases M01-M03 replace original phase 15.

## Work slicing and evidence rules

Each implementation task targets 1-3 files and less than 500 changed lines. Test authoring and test execution are separate tasks. A new necessary integration step is inserted as an unchecked task into the scheduled document before verification. Do not leave required work in prose or in an unscheduled companion file.

Each phase evidence report contains:

- requirement IDs, commit/worktree state, source versions and files changed;
- exact executed commands, exit status, date and artifacts;
- implementation versus test-double boundaries;
- passed checks, failed checks and unavailable evidence;
- measured limitations and following-phase prerequisites.

Phase preflight evidence filenames use docs/evidence/NN-preflight.md in the application repository and Plans/mega-maestro/evidence/15-preflight.md in Maestro. Markdown artifacts use YAML metadata and related wiki-links. Tests should exercise public behavior and security invariants rather than duplicate implementation details.

When API/registration/wiring requires additional files beyond a slice, insert a bounded wiring task rather than leave a module unreachable. When a test exposes a normal defect, fix it in bounded tasks and rerun relevant checks. Halt only for a real shared blocker such as wrong checkout, missing trust/protocol dependency, unavailable mandatory validation environment or an architectural impossibility.

No automatic git push, public repository creation, production tenant enrollment, live user messaging or deployment is in scope. A local test deployment is allowed only within a test environment authorized to the executing agent.

## Complete MVP test journeys

1. Enterprise bootstrap: deploy either profile, configure identity, create org/BU/groups, assign least-privilege roles, enroll a managed installation and verify effective policy.
2. Governed run: start a permitted agent, observe provider session and available child lineage, deny a prohibited tool before effect, prevent prohibited model destination, and show the reason to the user.
3. Offline: disconnect, restart, continue allowed work under the same policy; deny forbidden work; expire temporary exceptions, consume only allocated budget and reconnect without duplicate spend/events.
4. Evidence: enable full_vibes for a subgroup, run supported provider activity, verify manifests/blobs/attestations and supplemental outputs, inspect redacted view as a limited user, export authorized evidence.
5. Intervention: operator sends individual and group notices, collects private replies/acknowledgements, sends an authorized run-specific command, and observes pending/unknown/terminal outcomes accurately.
6. FinOps: allocate child activity to the correct historical BU, reconcile usage, forecast budget breach, enforce an allowed alternative route, validate quality and compare realized cost.
7. Governance: register use case, map NIST controls, collect technical and manual evidence, review residual risk, import custom framework, and export without changing historical assessments.
8. Failure: corrupt a pending policy, revoke an identity, fill a spool, restart workers, replay a command, move an org and restore a backup; prove authority, isolation, accounting and deletion invariants.
9. Scale: exercise 10k active identities and declared content volume for 24 hours, burst and reconnect; demonstrate measured freshness, fair scheduling, query latency and recovery goals.

10. Modularity: execute equivalent operations through UX, CLI, Cue and a neutral headless runtime fixture; compare policy/attribution, close UX, reconnect, and test adapter migration without duplicate side effects. Actual future-Lib testing stays pending until its release exists.

## Mandatory pre-release reviews (human activities)

- Confirm real Entra/enterprise SAML configuration, SCIM lifecycle and scoped administrator experience.
- Validate actual managed installs on every advertised OS and every supported provider/version. At least one fully enforced route must exist per supported OS; unavailable combinations remain denied and clearly documented.
- Independently review the threat model and perform penetration testing against tenant isolation, endpoint bypass and policy/command authority.
- Review NIST mappings, organizational control owners, data collection/retention settings and evidence applicability with enterprise stakeholders.
- Verify SaaS and self-hosted installation/upgrade/recovery in representative environments, using signed release artifacts.
- Confirm 10k load infrastructure and measured results, reference resource costs and full-content storage estimates.
- Obtain release acceptance against R01-R15 and a documented rollback plan. Open critical security or missing requirement gates prevent complete-MVP designation.

These are plain bullets because an automated coding task cannot perform stakeholder approval or independent human review. Release automation reports pending gates honestly.

## Research and design decisions still to validate during implementation

No further product preference is required to draft this design. MM-01-15 must pin the initial enforcement provider/OS/backend matrix before the early slice. Later qualification extends the supported matrix. Engineering validation must also pin VIBES producer commit, maintained library versions, persistence/broker choices and reference hardware. Choose maintained implementations using official documentation and an ADR; do not silently redesign confirmed requirements.

Full available VIBES is an integration dependency rather than an assumed feature on the current Hom-Mode branch. Do not cherry-pick or merge a feature branch merely to make a task pass without an authorized integration plan.

## Optional Electron packaging follow-up

After the browser MVP is validated, an Electron shell may add enterprise desktop distribution, native keychain session storage, deep links and update control. It must reuse server authorization and the browser experience, with context isolation, restricted navigation and signed updates. No desktop shell should contain privileged service credentials. This is the only proposed client packaging deferral; all requested governance/security/operations domains are MVP requirements.

## Automatic run entry point

Use [[AUTO-RUN-CHAIN]] for the current launch schedule. Launch only Maestro MAESTRO-ENTERPRISE-01; executable CHAIN tasks dispatch each subsequent batch to the correct project agent after producer verification. Existing artifact and security prerequisites remain mandatory. MINT-03-04 now lives in MAESTRO-ENTERPRISE-04, after application phase23. External qualification phase24 remains separate. Current schedule has 30 documents and 252 tasks; execution-plan.json is authoritative. No chain was launched while authoring.
