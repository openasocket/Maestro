# VIBES / VERIFY conformance: handoff to the `vibecheck` tool and itsavibe.ai registry

**Audience:** the maintainers (human or agent) of the `vibecheck` Rust CLI and the
`itsavibe.ai` attestation registry / reference spec.

**From:** the Maestro team. Maestro implements the VIBES "direct-write" fast path
(it writes `.ai-audit/` and produces DSSE attestations natively, without shelling
out to `vibecheck build`). For attestations to verify at the registry and for
`vibecheck verify` to accept Maestro-written audit dirs, both implementations must
agree **byte for byte** on hashing and signing. This document lists every point
where the two sides must be confirmed identical, the choice Maestro currently
makes, and the changes we believe are needed on one or both sides.

We could not fetch the normative spec text (`itsavibe.ai` returns HTTP 403 to
automated fetches), so several items below are **requests to confirm the canonical
value**, not assertions that `vibecheck` is wrong. Where we are confident a change
is needed, it is marked **ACTION**. Please reply against each numbered item.

---

## 0. TL;DR of what we need from you

1. Confirm the **canonical JSON** algorithm used for manifest-entry hashes and
   annotation IDs (recursive key sort + compact JSON? full RFC 8785 JCS?). Test
   vectors below.
2. Confirm whether **DSSE PAE** is computed over the **raw in-toto body** or over
   the **base64url payload string**. (Maestro currently uses the base64url string;
   the DSSE standard says raw body. This one likely needs a coordinated change.)
3. Confirm the **cosignature contract**: does the tool provider sign the raw PAE
   bytes, or `SHA-256(PAE)`? Maestro sends the hash but verifies over the full PAE
   - one of the two must change, and it depends on what the registry's cosign
     endpoint actually signs.
4. Confirm the signature **`keytype`** enumerated values (`user` / `tool` /
   `tool_provider`).
5. Confirm **keyId**, **attestation ID**, **subject naming**, and the
   **`version`/`standard_version`** envelope values (we believe we match; quick
   confirmation avoids silent drift).

---

## 1. Canonical JSON for content hashing (manifest entries + annotation IDs)

**Where it matters:** every `manifest.json` entry is content-addressed - the entry
key is `SHA-256(canonical_json(entry_without_created_at))`. Annotation IDs are
`SHA-256(canonical_json(record_without_annotation_id))`. If Maestro and `vibecheck`
canonicalize differently, every key differs and `vibecheck verify` / registry
validation reject Maestro-written dirs.

**Maestro's algorithm (after our fix):**

1. Shallow-remove `created_at` (manifest entry) or `annotation_id` (annotation).
2. **Recursively** sort object keys at every nesting depth (ascending, by
   JavaScript default sort = UTF-16 code unit order). Arrays preserve order.
3. Serialize compact (no whitespace) via the equivalent of `JSON.stringify`.
4. `SHA-256`, lowercase hex, 64 chars. (Manifest keys use the full 64; some UI
   truncates to 16 for display only.)

The `type` field IS included in the hash (this was our "V2" hash; the deprecated
V1 excluded `type`).

> Note: we previously had a bug where nested objects were dropped from the hash
> (a `JSON.stringify` replacer-array misuse). That is fixed. The algorithm above
> is the corrected, intended one.

**Test vectors** (please confirm `vibecheck` produces the identical canonical
string and SHA-256 for each):

Input entry (keys deliberately unsorted, nested object present):

```json
{
	"type": "environment",
	"model_version": "opus",
	"model_name": "claude",
	"tool_name": "maestro",
	"tool_version": "1.0",
	"model_parameters": { "top_p": 0.9, "temperature": 0.7 },
	"created_at": "2026-01-01T00:00:00Z"
}
```

Maestro canonical string (after removing `created_at`, recursive sort, compact):

```
{"model_name":"claude","model_parameters":{"temperature":0.7,"top_p":0.9},"model_version":"opus","tool_name":"maestro","tool_version":"1.0","type":"environment"}
```

`SHA-256` of that string (UTF-8), as Maestro computes it:

```
86a5383787687f5151fb8e4fe602bdd36a2404ed865cc0f4eea9d96e6d7c1aa6
```

If `vibecheck` computes a different digest for the same input entry, the
canonicalization algorithms differ (most likely float formatting per item 1a) and
we must reconcile before any Maestro-written manifest will verify.

**Open questions for you:**

- **1a.** Is the canonical form a plain recursive-key-sort + `serde_json` compact
  serialization, or **full RFC 8785 (JCS)**? These differ for numbers (JCS
  re-formats floats/exponents) and for non-ASCII escaping. VIBES entry values are
  mostly strings + small integers, but `model_parameters` can carry floats
  (`temperature: 0.7`). **If `vibecheck` uses JCS number normalization and Maestro
  uses `JSON.stringify`, float-bearing entries will mismatch.** Please state the
  exact algorithm.
- **1b.** Key sort order: UTF-16 code units (JS default) vs Unicode code points vs
  bytes. For ASCII field names these coincide; confirm there are no non-ASCII keys
  in the spec.
- **1c.** Confirm `created_at` is the ONLY excluded field for manifest entries and
  `annotation_id` the only excluded field for annotation records.

---

## 2. DSSE PAE input: raw body vs base64url payload string

**ACTION (likely coordinated change).** Per the DSSE standard, the signature is
over `PAE(payloadType, body)` where `body` is the raw serialized in-toto JSON
bytes; the envelope's `payload` field is merely `base64(body)` for transport. A
standard DSSE verifier base64-decodes `payload` and computes PAE over the decoded
body.

**Maestro currently computes `PAE(payloadType, base64url(body))`** - i.e. it feeds
the base64url _string_ into PAE, not the raw body. This is internally consistent
(Maestro's own build and verify agree), so it round-trips locally, but a
**standard DSSE verifier - including, we expect, the itsavibe.ai registry - will
reject it**, because it will PAE over the decoded body and get different bytes.

- **2a.** What does `vibecheck` / the registry actually do - PAE over the raw body
  (DSSE standard) or over the base64url string?
- **2b.** If the standard (raw body): Maestro will change its three PAE sites to
  feed the raw body. **This must land in lockstep** or previously-produced
  attestations stop verifying. Please confirm so we can schedule the change
  together. (`payloadType` = `application/vnd.in-toto+json`; `payload` field stays
  base64url of the body.)
- **2c.** PAE framing we use (confirm identical): `"DSSEv1" SP LEN(payloadType) SP
payloadType SP LEN(payload) SP payload`, where `SP` = 0x20 and `LEN` is the
  **byte** length as decimal ASCII. Our `computePAE` implements exactly this; only
  the _input_ (item 2a) is in question.

---

## 3. Tool-provider cosignature contract (hash vs full PAE)

**Where it matters:** Maestro requests a cosignature from the provider by sending
`pae_hash = SHA-256(PAE_bytes)` (hex) - the module's stated privacy design is that
the provider sees only the hash, never the payload. But Maestro's verifier checks
the returned signature with **Ed25519 over the full PAE bytes**, not over the
32-byte hash. Ed25519 is not a pre-hash scheme, so "sign the hash" and "verify
over the full PAE" cannot both be correct - the real cosign->verify loop is
internally contradictory on our side.

- **3a.** What does the itsavibe.ai cosign endpoint sign - the raw PAE bytes it is
  given, or the 32-byte `pae_hash` we send? (I.e. is the Ed25519 _message_ the PAE
  or the hash-of-PAE?)
- **3b.** Depending on 3a, exactly one side changes: either the provider must
  receive/sign the full PAE (and Maestro stops pre-hashing), or Maestro's verifier
  must verify the cosignature over the same 32-byte hash it transmitted. We will
  align Maestro to your answer. Please state the canonical contract.

---

## 4. Signature `keytype` enumerated values

Maestro emits `keytype: "user"` for the user signature and `keytype:
"tool_provider"` for the cosignature.

- **4a.** Confirm the exact enumerated string the registry/spec expects for the
  tool cosignature. If it is `"tool"` (not `"tool_provider"`), Maestro will change
  it - but a wrong value here could cause the registry to silently drop or
  mis-attribute the cosignature (downgrading the trust tier). Please confirm
  `"user"` is also correct for the user signature.

---

## 5. Items we believe already match (please spot-confirm)

- **5a. keyId** = `SHA-256(SPKI DER of the Ed25519 public key)` truncated to the
  first 16 hex chars (8 bytes). Hashes the DER, not the PEM text.
- **5b. Attestation ID** = `SHA-256(canonical_json(full_DSSE_envelope))`, same
  recursive-sort canonicalization as item 1, 64-char lowercase hex.
- **5c. in-toto statement**: `_type` = `https://in-toto.io/Statement/v1`;
  `predicateType` = `https://itsavibe.ai/vibes/attestation/v1`; each `subject`
  entry is `{ name: ".ai-audit/<file>", digest: { sha256: <hex of file bytes> } }`
  with **forward-slash** names on every OS (spec identifier, not a filesystem
  path). Subject files: `manifest.json`, `annotations.jsonl`, `config.json`.
- **5d. Signature encoding**: `sig` is base64url (no padding) of the raw 64-byte
  Ed25519 signature.
- **5e. Envelope/version fields**: `manifest.json` = `{ standard: "VIBES",
version: "1.0", entries: {...} }`; `config.json` `standard: "VIBES"`,
  `standard_version: "1.0"`. Maestro's readers also _tolerate_ `"1.1"` (fail-open
  forward-compat) but never _write_ it. Confirm `"1.0"` is current and whether
  `"1.1"` exists.
- **5f. Assurance levels**: Maestro uses `low` / `medium` / `high`. Confirm these
  are the spec names and confirm the capture-gating expectation (e.g. reasoning at
  `high`, prompts at `medium`+). One specific question: **are decision records
  required at ALL assurance levels, or only `medium`+?** Maestro currently
  suppresses auto-detected decisions at `low`, but a code comment cites "section
  5.6: present at all levels" - we need the authoritative answer.

---

## 6. Does `vibecheck` itself need changes?

Likely **yes for items 2 and possibly 3**, if the registry is meant to be a
standard DSSE verifier:

- **If the registry/spec is standard-DSSE (PAE over raw body):** `vibecheck` is
  probably already correct and **Maestro changes** (item 2b). No `vibecheck`
  change needed - just confirm.
- **If `vibecheck` currently PAEs over the base64url string (matching Maestro
  today):** then `vibecheck` and Maestro are mutually consistent but both diverge
  from standard DSSE and from any third-party verifier. Recommend **both** move to
  standard raw-body PAE in a coordinated release.
- **Cosign contract (item 3):** whichever side is "wrong" relative to the endpoint
  must change; if `vibecheck` also verifies cosignatures, it must use the same
  rule Maestro settles on.

For items 1, 4, 5: no `vibecheck` change expected if the values above are already
canonical - we just need confirmation to lock them in and add cross-implementation
test vectors.

---

## 7. Requested deliverable from your side

Please provide, ideally as a small `conformance-vectors.json` we can both test
against:

- 3-5 manifest entries (incl. one with a nested float-bearing `model_parameters`)
  with their expected canonical string and SHA-256.
- 1-2 annotation records with expected `annotation_id`.
- One full in-toto statement with its expected PAE bytes (hex) and attestation ID.
- One keypair (test-only) with its expected keyId.
- The exact cosign request/response shape and what the provider signs.

With those vectors, Maestro can add a `vibecheck`-parity test suite and guarantee
byte-for-byte agreement going forward.

---

_Generated from a Maestro-side audit of `src/main/vibes/`. Contact: the Maestro
VIBES integration owners. Maestro has already fixed the two internal-consistency
BLOCKERs (recursive canonical hashing; identical PAE bytes for user + cosign);
the remaining interop items above require your confirmation before Maestro can
finalize alignment._
