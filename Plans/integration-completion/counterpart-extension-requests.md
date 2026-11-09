# Counterpart extension requests (Mega-Maestro)

Status: draft for the Mega-Maestro owners, written 2026-11-09 from
`Plans/integration-completion/contract-coverage.json`, `program.json` and the
MCOMP readiness probes. Nothing in this file has been sent or published.

## Why these are needed

Maestro has built the local consumer side of each capability below and tested
it against fixtures. Each one stays `proposed-not-negotiated` because Mega-Maestro
has not published the wire operations. Maestro does not advertise these
capabilities, and it does not invent a private transport. Fixture authority is
not production authority.

Until these are negotiated, the paired and native stages below stay blocked:

| Maestro task | Blocked by | Gate |
| --- | --- | --- |
| MCOMP-14-01 (first positive direct pair) | REGISTRATION-HTTP/2, PREPARED/1, EFFECT/1, HEADLESS-CUSTODY/1 | probe reports `blocked`, `missing: []` |
| MCOMP-16-01 (policy verify) | DESKTOP-LOCAL/1, plus receipts below | probe reports `blocked` |
| MCOMP-32-01, MCOMP-34-01 | the same four extensions as MCOMP-14-01 | paired verification |

## 1. REGISTRATION-HTTP/2

- **Need:** a negotiated v2 mapping for `approve_runtime_registration`. The
  current HTTP body remains v1.
- **Missing:** the public `runtimeApprovalInputV2` type exists, but
  `http-operations` accepts only `challengeId`, `nonce` and `challengeDigest`.
  No public session identifier is exposed for consumer-side correlation.
- **Ask:** publish the v2 HTTP mapping that carries `purpose` and `version`, and
  say how session binding is acknowledged while staying server-owned. Maestro
  will not drop `purpose` or `version` to fit v1.
- **Maestro consumers:** MCOMP-07-01 (done, via `createActorApprovalBridge` in
  `scripts/mega-maestro-pair.mjs`), MCOMP-13-01. Paired check: MCOMP-14-01.

## 2. PREPARED/1

- **Need:** a new versioned capability on protocol 2 with four operations:
  `execution_prepare`, `execution_consume`, `execution_settle`,
  `execution_reconcile`. None is shipped.
- **Ask:** the producer must durably consume once, pin native executable and
  resource identities, track descendant ownership, and revoke on policy,
  registration, trust or disconnect. Settle and reconcile must go through the
  original lease. An outcome that is thrown or lost stays `unknown`, even after
  a disconnect.
- **Maestro consumers:** `EndpointPort.preparedExecution`,
  `PreparedExecutionPort.version=1`, the `HostAuthority` lifetime. Paired checks:
  MCOMP-14-01, MCOMP-32-01.
- **Already published:** `executionBinding` and `executionConsumption` schemas.

## 3. EFFECT/1

- **Need:** a new versioned capability on protocol 2 with three operations:
  `effect_authorize`, `effect_settle`, `effect_reconcile`. None is shipped.
- **Ask:** the request must carry the exact command, file, permission or tool
  input, plus `leaseId`, the authenticated actor reference, the provider, thread,
  turn and request IDs, the effect digest, the policy revision, expiry,
  revocation and idempotency. Allow, deny, unavailable and unknown must stay
  distinct. A launch or dispatch receipt must never grant an effect.
- **Maestro consumers:** `ManagedEffectProducer.version=1` via
  `ManagedHostAdapterDeps.effectProducer`. Implementation: MCOMP-13-02, 13-05.
  Paired checks: MCOMP-14-01, MCOMP-32-01.

## 4. HEADLESS-CUSTODY/1

- **Need:** an authenticated, endpoint-owned host identity and custody binding
  for a plain Node host. No public operation exists today, so Maestro sends no
  speculative call. `recover()` answers unsupported until this is published.
- **Ask:** bind the installation, runtime and process epoch, plus the verified OS
  peer, to an independently protected enrollment, a freshness and rollback
  anchor, revocation, and authenticated release. Do not export Electron
  `safeStorage` keys or copy bearer credentials.
- **Maestro consumers:** `SealProvider` and `AnchorStore` (MCOMP-09-05 and
  09-05A are done). Paired checks: MCOMP-14-01, MCOMP-32-01, MCOMP-34-01.

## 5. DESKTOP-LOCAL/1 (reported by the MCOMP-16-01 probe)

- **Need:** local delivery of `desktop_policy`, `offline_choices` and typed
  ceiling batches for desktop-policy schema 1. No local endpoint operation is
  published.
- **Ask:** the producer must authenticate negotiation and sign the entire
  desktop, settings, routes and secondary-ceilings batch against protected
  identity, registration and trust roots before Maestro reads it.
- **Maestro consumer:** `NativePolicyProjectionPort.version=1` in
  `createPolicyStatusService` (MCOMP-15-01).

## Receipts that MCOMP-16-01 also needs

- `MEGA-DESKTOP-POLICY-BUILD` (no receipt declares it yet).
- `PAIR-DIRECT-EVIDENCE` (no receipt declares it yet).
- `MEGA-PREPARED-EXECUTION`: the probe looks for this un-suffixed id, but
  `evidence/g06-build.json` declares `MEGA-PREPARED-EXECUTION-BUILD`. Please
  confirm which id `program.json` intends, so one side can change.

## What Maestro will do when each one is negotiated

Maestro will wire the consumer port that already exists, run the paired task that
names it, and record the result as a receipt. Maestro will not mark a task done on
fixture evidence alone.
