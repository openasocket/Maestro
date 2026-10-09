---
type: security-design
title: Mega-Maestro Trust and Enforcement
created: 2026-09-18
status: proposed
tags: [mega-maestro, security, policy, dlp]
---

# Trust and enforcement design

Execution amendment: [[MEGA-MAESTRO-ENFORCEABILITY]] defines early real-provider/backend proof, protected management binding, outage semantics and explicit dependency gates. Read it with [[MEGA-MAESTRO-INTEGRATION]] before implementing this design.

Related: [[MEGA-MAESTRO-DESIGN]], [[MEGA-MAESTRO-GOVERNANCE]], [[MEGA-MAESTRO-DELIVERY]].

## Trust boundaries and threat model

Protect tenant content, credentials, user identity, device identity, policy authority, money, execution resources and audit integrity. Threat actors include unauthorized users, compromised agents/tools/plugins, malicious content, replaying devices, stolen enrollment tokens, compromised ordinary endpoints, mis-scoped enterprise operators and compromised service accounts. Local root/kernel compromise needs OS management and cannot be solved by signed JSON alone.

| Boundary              | Required defense                                                                     | Proof before pilot                                                              |
| --------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| Browser to API        | SSO, CSRF protection, secure sessions, action/resource authorization, content scopes | Cross-org and cross-tenant negative tests on reads/writes/exports/subscriptions |
| Endpoint enrollment   | Single-use scoped invitation, proof of key possession, trusted roots                 | Replay, identity cloning, wrong-tenant and enrollment race tests                |
| Endpoint transport    | Device mTLS, rotation, revocation checks, bounded payloads                           | Expired/revoked key, rotation and reconnect tests                               |
| Policy to endpoint    | Signature, trusted key ID, audience, monotonic revision, atomic activation           | Corrupt cache, downgrade, signer rotation and restart tests                     |
| Agent to tools        | Pre-execution broker or verified provider hook plus confinement                      | Shell/subprocess/network/MCP/SSH bypass suite                                   |
| Agent to model        | Managed credentials, egress restriction, classification, gateway authorization       | Direct endpoint, alternate credentials and unauthorized fallback tests          |
| Payload to storage/UI | Local DLP, scoped encryption, untrusted rendering, decompression limits              | Secrets, stored XSS, archive bombs and object-link isolation                    |
| Operators to fleet    | Scoped signed expiring commands, preconditions, idempotency                          | Replay, scope removal, duplicate execution and stale-run tests                  |
| Worker to tenant data | Explicit authenticated job context, tenant checks, scoped secrets                    | Forged job payload, cache key collision and export leakage tests                |
| Audit and evidence    | Append-only authenticated records, checkpoints and controlled retention              | Tamper detection, deletion receipts and restore consistency                     |

## Policy object and deterministic semantics

Canonical policy document includes schemaVersion, tenantId, policyId, revision, supersedes, author/approver, issuedAt, effectiveAt, scope snapshot, required capabilities, rules, collection, routing, budgets, offline behavior, exception references and signature metadata. The compiled artifact is content-addressed and signed separately from mutable delivery receipts.

Rules declare target, conditions, effect (deny, allow_with_constraints, require_central_approval, audit), enforcement point and reason. Unknown action or unavailable mandatory fact denies managed execution. Valid observation-only rules cannot satisfy a mandatory enforcement requirement.

Evaluation order:

1. Verify identity, tenant binding, bundle integrity and supported schema.
2. Establish resource/action facts from trusted adapters, not model assertions.
3. Resolve inherited mandatory constraints and explicit central exceptions.
4. Enforce accumulated denies, intersect allowed sets, apply numeric ceilings.
5. Require non-expired central authorization if the policy calls for it.
6. Reserve budget and pass DLP/egress controls.
7. Execute under the evaluated immutable inputs; record decision and actual result.

Tie authorization to exact tool arguments, canonical resource, executable identity and model route. Prevent symlink/path changes and argument mutation between check and use through broker-owned handles or sandbox boundaries. Local prompt overrides, env vars, alternate binaries and terminal commands must not bypass management.

Policy editing permissions are narrower than tenant root. Authors cannot approve their own sensitive policy when separation of duties is configured. Tenant-root authority is the source of enterprise rules; lower admins cannot widen inherited constraints. Every exception is an explicit central rule with evidence and expiration, never a local bypass button.

## Offline contract

Continue enforcing the last fully validated and atomically installed revision. Keep a durable signed cache, trusted signer history, anti-rollback high-water mark and recovery copy. Verify integrity on every service start. New invalid policy leaves the previous valid revision in force and reports rejection.

Last policy has no connectivity-based expiration. Individual exceptions, approvals and budget allocations can expire according to its rules; expiry never relaxes controls. Monotonic elapsed-time checks and conservative clock uncertainty prevent wall-clock rollback from extending authorization.

Transport certificate expiry prevents synchronization until renewal/recovery, not local policy evaluation. A recovery identity proves possession and uses a limited re-enrollment channel; expired credentials do not regain normal service access.

Disconnected clients cannot learn new central revocations. Show "central revoked; endpoint acknowledgement pending" and last contact. Remote termination is not guaranteed when offline. Upon reconnect, prioritize identity status and policy updates before queued optional uploads or new commands.

New org placement while a device is offline does not retroactively install policy. Keep an explicit pending assignment and disable new central grants until the endpoint acknowledges the new compiled policy. Cached assignments remain attributable to their earlier revision.

## DLP pipeline

Define classification taxonomy and rule packs scoped by org/project/destination. Rules can match known secrets, structured identifiers, exact confidential fingerprints, paths, labels and external enterprise classifiers. Bound regex execution and external classifier time. Rules have severity, action, reason, test fixtures, revision and false-positive review.

Enforcement locations:

- Before model transmission: inspect prompt, attachments, assembled context and tool results.
- Before tool side effects: validate arguments, files, destination and data classification.
- Before user delivery/export: classify output, buffer when required, redact or quarantine.
- Before central ingestion: apply collection rules locally, including VIBES derivatives.
- Before central search/export/AI summaries: reevaluate viewer, purpose and onward destination.

Streaming requires bounded buffering before release; a scanner seeing tokens after network transmission cannot prevent that disclosure. For large payloads enforce size caps and policy-approved chunking; cross-chunk matches require overlap/state. Unsupported modalities fail the mandatory scan gate rather than being labeled clean.

Actions: allow, redact, deny, quarantine, request central exception, or monitor when explicitly configured. Original content only enters a restricted vault if enterprise retention permits. Detection error, timeout, size limit and unsupported format are distinct outcomes. Scanner failure follows signed policy, with mandatory-protection paths denied.

DLP cannot promise detection of every encoding or semantic secret. Record test-set precision/recall and known coverage; confinement and approved egress are independent defenses. Findings quote only authorized redacted excerpts.

## Key and secret lifecycle

Separate device authentication keys, policy signing keys, command signing keys, VIBES evidence keys and data encryption keys. Use maintained crypto libraries and enterprise KMS/HSM where configured; do not implement crypto primitives. Tenant key wrapping scopes content access and supports rotation.

Policy key rotation requires endorsement by a previously trusted root or authenticated enterprise recovery. A device offline through several rotations receives a verifiable transition chain. Tenant compromise recovery is an explicit privileged workflow, not automatic acceptance of a new key URL.

Provider secrets stay server-side or in an approved local vault where local models require them. Never include them in prompts, environment telemetry, command logs or VIBES exports. Enrollment tokens are redacted from URLs/logs and consumed atomically. Customer-managed encryption is supported through a key-provider interface in SaaS and self-hosted profiles.

## Audit, retention, and privacy

Every admin action, content read/export, policy decision, key change, enrollment, command, budget mutation and evidence review emits an attributable audit record. Required audit durability must precede a privileged side effect, or the action fails closed. Signed checkpoints can detect modification; they do not prove that a compromised endpoint reported every action.

Raw content and security audit metadata have independent retention. Provisional defaults: 30 days raw content, 90 days searchable activity, 365 days administrative/security audit, 24 months aggregated cost data; enterprises configure these before rollout. Legal holds and deletion obligations are explicit central policies. Expired content disappears from indexes, caches, derivatives, exports controlled by the system and scheduled backup retention; retained tombstones contain no sensitive raw content. Restore reapplies deletion journals before serving data.

Collection changes are prospective by default. Retroactive export of pre-enrollment history requires a separate scoped enterprise policy. Managed users can view collection notices and request correction or review. Aggregate feedback and suggestions respect cohort thresholds and original access restrictions.

## Deployment, supply chain, and recovery

Production uses signed images/installers, SBOMs, dependency scanning, restricted service accounts, regional network segmentation, secrets management, backup encryption, restore tests and documented emergency operations. SaaS support access requires tenant-authorized, time-limited, audited access; self-hosted deployment has no mandatory vendor content channel.

Endpoint service runs outside the renderer with least privilege. Elevated operations are isolated in a narrow helper. OS ACLs, MDM, service supervision and approved binary policies protect managed configuration. Protect update manifests and downgrade rules. Electron shell, if shipped, disables Node integration in remote content, uses context isolation and a narrow preload, validates navigation and updates, and stores no embedded admin credentials.

Incident actions: central quarantine, credential revoke, restrictive policy rollout, scoped evidence preservation, communications and case creation. Do not delete user projects as an incident action. Recovery restores trust, reconciles unknown commands, verifies ledger consistency and records fresh capability tests.

## Security completion criteria

A pilot is blocked by any demonstrated cross-tenant read/write, mandatory-control bypass on a supported execution route, unaudited privileged operation, policy downgrade acceptance, silent raw-data escape, duplicated non-idempotent remote effect, or irreversible loss of acknowledged audit records within the configured durable cluster. Document threat coverage and residual risks in a release evidence bundle. External penetration testing and organizational risk acceptance are manual release gates, not unchecked tasks that an agent can claim to perform.
