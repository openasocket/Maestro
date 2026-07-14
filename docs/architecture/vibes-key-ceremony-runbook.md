# VIBES Provider Key Ceremony - Maestro Runbook

Audience: the Maestro release owner (human) or an agent acting on their behalf.
Outcome: three files published on the Maestro website that let every VIBES
client verify Maestro's cosignatures AND verify that the developer authorized
the signing key.

Everything uses `scripts/vibes-key-ceremony.mjs` (zero dependencies, Node >= 18,
same crypto conventions as `src/main/vibes/vibes-key-manager.ts`). Run all
commands from the repo root.

## What gets produced

| File               | Publish at                                    | Contains                                                                |
| ------------------ | --------------------------------------------- | ----------------------------------------------------------------------- |
| `maestro.pub`      | `https://{toolDomain}/vibes/maestro.pub`      | Operational public key (the cosign service signs with its private half) |
| `maestro.pub.sig`  | `https://{toolDomain}/vibes/maestro.pub.sig`  | Root-key endorsement of the operational key                             |
| `maestro.root.pub` | `https://{toolDomain}/vibes/maestro.root.pub` | Developer root public key                                               |

`{toolDomain}` is the canonical website domain. The code currently uses
`maestro.sh` (`MAESTRO_TOOL_DOMAIN` in `src/main/vibes/vibes-provider-keystore.ts`);
if the canonical domain is `runmaestro.io`, change that constant (and its two
test expectations) BEFORE publishing so clients pull from the right place.

## Step 1 - Generate the DEVELOPER ROOT key (once, ever)

Run on the most trusted machine available (ideally offline / air-gapped).
The root key endorses operational keys; it is the anchor of trust.

```bash
node scripts/vibes-key-ceremony.mjs keygen --name maestro-root --out-dir ~/maestro-root-key
```

Output: `maestro-root.pub` (public), `maestro-root.key` (PRIVATE, mode 0600),
and the root keyId printed to the terminal. Record the keyId.

Then:

- [ ] Copy `maestro-root.key` to offline storage (password manager secure note,
      encrypted USB, or printed). It should NOT live on a day-to-day laptop and
      must NEVER be on the web server, in the repo, or in CI.
- [ ] Keep `maestro-root.pub` handy; it gets published in Step 4.

## Step 2 - Generate the OPERATIONAL key

This is the key the cosign service (`api.maestro.sh/vibes/cosign`, when built)
signs with. Generate it wherever that service's secrets will live (locally is
fine for staging; regenerate inside the production secret store when the
service ships, then re-run Step 3 for the new key).

```bash
node scripts/vibes-key-ceremony.mjs keygen --name maestro --out-dir ~/maestro-ops-key
```

Output: `maestro.pub`, `maestro.key` (PRIVATE), and the operational keyId.

- [ ] `maestro.key` goes ONLY into the cosign service's secret storage.
- [ ] Record the operational keyId (clients show it as the key "version").

## Step 3 - Endorse the operational key with the root key

This produces the signed proof that the developer authorized this operational
key. Needs both files present briefly (do it on the trusted machine, then
remove the root private key again):

```bash
node scripts/vibes-key-ceremony.mjs endorse \
  --key ~/maestro-ops-key/maestro.pub \
  --signer ~/maestro-root-key/maestro-root.key \
  --out maestro.pub.sig
```

Sanity-check it before publishing:

```bash
node scripts/vibes-key-ceremony.mjs verify \
  --key ~/maestro-ops-key/maestro.pub \
  --sig maestro.pub.sig \
  --signer-pub ~/maestro-root-key/maestro-root.pub
# expect: OK: <ops keyId> is endorsed by <root keyId>
```

## Step 4 - Publish (all three together)

Upload to the website, byte-for-byte as generated:

- [ ] `~/maestro-ops-key/maestro.pub` → `/vibes/maestro.pub`
- [ ] `maestro.pub.sig` → `/vibes/maestro.pub.sig`
- [ ] `~/maestro-root-key/maestro-root.pub` → `/vibes/maestro.root.pub`
      (note the published filename is `maestro.root.pub`)

Serve as plain static files over HTTPS. No special headers needed; ETag /
Last-Modified from the host enable clients' cheap freshness checks.

Verify from any machine:

```bash
curl -s https://{toolDomain}/vibes/maestro.pub | node scripts/vibes-key-ceremony.mjs keyid --key /dev/stdin
# must print the operational keyId from Step 2
```

## Later: rotating the operational key

Generate the replacement, then endorse it with BOTH the outgoing operational
key (rotation chain) and the root key, into the same file:

```bash
node scripts/vibes-key-ceremony.mjs keygen --name maestro-v2 --out-dir ~/maestro-ops-key-v2
node scripts/vibes-key-ceremony.mjs endorse --key ~/maestro-ops-key-v2/maestro-v2.pub \
  --signer ~/maestro-ops-key/maestro.key --out maestro.pub.sig
node scripts/vibes-key-ceremony.mjs endorse --key ~/maestro-ops-key-v2/maestro-v2.pub \
  --signer ~/maestro-root-key/maestro-root.key --out maestro.pub.sig
```

Publish the new key's `.pub` content at `/vibes/maestro.pub` (same URL - the
content hash IS the version) together with the updated `maestro.pub.sig`.
`maestro.root.pub` stays unchanged. Old attestations keep verifying: clients
retain every key version they have ever pulled.

## Security rules (non-negotiable)

1. Private keys (`*.key`) never enter the repo, the website, chat, or CI logs.
   The repo already gitignores `.maestro-provider-key/`.
2. The root private key is used ONLY in Step 3 / rotation, then goes back to
   offline storage.
3. If the ROOT key is ever compromised, there is no recovery path within the
   scheme - clients must be re-anchored out-of-band. Guard it accordingly.
4. If an OPERATIONAL key is compromised, rotate immediately (root endorsement
   makes the replacement trusted even though the compromised key also could
   have chain-signed an attacker key - clients accept root-endorsed keys, and
   the published file controls which key is current).

## Reference

- Client trust rules and file formats: `docs/architecture/vibes-integration.md`
  → "Provider Key Distribution" and "Key Endorsement (signed keys)".
- Implementation: `src/main/vibes/vibes-provider-keystore.ts`
  (`createKeyEndorsement`, `verifyKeyEndorsement`, `checkProviderKeyUpdate`).
- A prior test keypair (keyId `d83ab33ea749cbb2`) exists in the gitignored
  `.maestro-provider-key/` dir from early testing; it has no root endorsement
  and should be superseded by the output of this ceremony.
