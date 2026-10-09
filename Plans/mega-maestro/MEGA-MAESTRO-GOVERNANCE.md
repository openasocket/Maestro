---
type: governance-design
title: Mega-Maestro Governance and Evidence
created: 2026-09-18
status: proposed
tags: [mega-maestro, nist-ai-rmf, governance]
---

# Governance model

Related: [[MEGA-MAESTRO-DESIGN]], [[MEGA-MAESTRO-SECURITY]], [[MEGA-MAESTRO-DELIVERY]].

## Source baseline

Verified 2026-09-18:

- https://www.nist.gov/itl/ai-risk-management-framework
- https://airc.nist.gov/airmf-resources/airmf/5-sec-core/
- https://www.nist.gov/publications/artificial-intelligence-risk-management-framework-generative-artificial-intelligence
- https://www.nist.gov/itl/ai-risk-management-framework/nist-ai-rmf-playbook

Use NIST AI RMF 1.0 and NIST AI 600-1 as versioned baseline resources. NIST states that AI RMF revision is in progress; do not silently apply draft changes. The four functions guide continuing risk management; they are not a software certification checklist. Mega-Maestro records evidence and organizational decisions, and does not issue a "NIST certified" badge.

## Native records

AI use case: purpose, accountable owner, affected parties, org scope, model/provider inventory, data categories, intended/prohibited uses, deployment context, evaluation plan, lifecycle state and review cadence.

Risk: source, scenario, likelihood/impact method, affected parties, inherent risk, mitigations, residual risk, owner, acceptance authority, review/expiry and linked incidents. Support enterprise-defined scoring scales; do not invent a universal risk percentage.

Control: stable ID, objective, owner, technical/procedural type, applicability, implementation, verification method, evidence requirements, review interval and exception handling.

Evidence: stable ID, artifact hash/reference, source identity, collection period, policy/model/software revision, classification, integrity status, provenance, reviewer and validity period. Missing or stale evidence remains a gap. A control with configuration but no verification is not verified effective.

Assessment: use case, framework/version/profile, in-scope controls, methodology, reviewer, findings, residual risk and signed decision. Incident, exception, feedback case, remediation and review records connect to assessments.

## Product-to-framework mapping

These are proposed implementation mappings to functions, not claims that the application fulfills every NIST outcome.

| Function | Product support                                                                                     | Technical evidence                                                          | Required organizational evidence                                                |
| -------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Govern   | Ownership, scoped authority, policy lifecycle, vendor/model registry, exceptions, training/feedback | Approval history, policy revisions, access reviews, retention configuration | Accountability, risk appetite, roles, training, accepted use policy             |
| Map      | Use-case inventory, data classification, affected parties, provider and tool dependencies           | Enrollment, lineage, destination inventory, collection profiles             | Intended context, impact analysis, stakeholder input and applicability          |
| Measure  | Evaluation plans, reliability/quality/security metrics, DLP tests, model/routing comparisons        | Versioned results with sample sizes, uncertainty, coverage and gaps         | Evaluation methodology review, independent validation and fitness-for-purpose   |
| Manage   | Incident response, budget/policy intervention, quarantine, remediation, reviews                     | Command outcomes, policy acknowledgements, remediation verification         | Residual-risk acceptance, response ownership, communication and periodic review |

NIST AI 600-1 is a companion profile focused on generative AI. Each imported suggested action must retain its official source identifier, applicable actor and risk tags. Only include verbatim normative text when redistribution permits; otherwise retain a source link and clearly labeled interpretation.

## Extensible framework packs

A declarative signed pack carries frameworkId, version, publisher, source URI, publication date, license/redistribution metadata, controls and mapping edges. Edges connect external references to native controls and declare supports, partially_supports, or requires_manual_evidence, with rationale and reviewer.

Packs are data, not arbitrary executable plugins. Schema validation, signature/trust policy, diff preview and explicit activation are required. Updating a pack creates a new assessment baseline without rewriting historical results. Mapping a control into two frameworks does not automatically prove equivalence or confer certification.

Support enterprise custom packs and licensed mappings for ISO/IEC 42001, ISO/IEC 23894, NIST CSF and sector-specific requirements. These are integration targets; validate authoritative content and licensing during implementation. Do not synthesize legal obligations from model output.

## Workflows

1. Register a use case and owner, link orgs/devices/models and data categories.
2. Select versioned framework/profile and record applicability with rationale.
3. Assess risks and choose controls, technical policies and procedural activities.
4. Collect machine evidence; assign manual evidence requests to owners.
5. Review effectiveness, gaps, affected-party feedback and residual risk.
6. Approve deployment or require remediation through authorized enterprise workflow.
7. Monitor incidents/metrics and schedule reevaluation on material changes.

Material changes include new model families, data destinations, policy scope, provider capability, collection level, and risk-relevant incidents. Automated recommendations can propose an assessment but cannot sign risk acceptance.

Evidence export contains manifest, scope, methodology, framework versions, policies, assessments, audit checkpoint, accessible artifacts, exclusions and verification instructions. Redacted exports maintain derivative provenance. Export completion is audited and downloadable only through scoped short-lived authorization.

## MVP gate

Ship a validated NIST AI RMF baseline pack and GAI profile mappings, native control/evidence/risk workflows, manual evidence support, periodic review and export. Demonstrate importing a custom framework pack without application code changes and prove that a pack update leaves prior assessments unchanged. Report coverage as applicable controls with fresh reviewed evidence, not an overall compliance score unsupported by methodology.
