# VIBES Windows Parity - Manual Validation Checklist

The VIBES/VERIFY feature (`src/main/vibes/`) was hardened for Windows against documented Win32 behavior and locked in with `process.platform = 'win32'` unit tests, but the developer has no Windows machine. Each fix below needs a one-time manual confirmation by a tester on a stock Windows 11 install (no admin elevation, no Developer Mode).

This document also records the cross-platform rules the hardening established. Read them before touching `src/main/vibes/` path, hashing, spawn, or key-storage code.

## Cross-platform invariants (hash stability)

### Forward-slash spec identifiers (DO NOT CHANGE)

These `/`-joined values are VIBES-spec identifiers, NOT filesystem paths. They are hashed, stored in the audit files, or sent over the network, so forcing backslashes on Windows CORRUPTS the audit format:

- in-toto subject names `${AUDIT_DIR}/${fileName}` in `vibes-key-manager.ts` and `vibes-attestation.ts`.
- The blob relative path `${BLOBS_DIR}/${blobFileName}` stored in the manifest (`vibes-io.ts`).
- `path.join(projectPath, subject.name)` in `vibes-verify-attestation.ts` - `path.join` already tolerates `/` on Windows; leave it.
- HTTPS URL builders in `vibes-provider-keystore.ts` - URLs always use `/`.
- The annotation `file_path` field: both instrumenters (`claude-code-instrumenter.ts`, `codex-instrumenter.ts`) normalize it with `relative.split(path.sep).join('/')` after relativizing, so it is forward-slash and project-relative on every OS. It feeds the hashed attestation subject, exclude-glob matching, and the `vibes-io.ts` coverage functions.

Rule of thumb: a value that is HASHED, STORED in the audit files, or sent over the network stays forward-slash. Only strings passed to `fs` APIs as real OS paths use `path.join`/`path.sep`.

### LF normalization before hashing

`createLineAnnotationWithAnchors()` in `vibes-annotations.ts` canonicalizes file content with `content.replace(/\r\n/g, '\n')` immediately after `readFile`, and computes ALL of `file_content_hash`, `anchor_context`, and `anchor_hash` over the LF-normalized text. Without this, a CRLF checkout on Windows produces different bytes (and false tamper/drift reports) than the same logical content on an LF checkout. Any new content-derived hash must follow the same rule.

### Compressed-reasoning hashing (gzip header canonicalization)

`reasoning_text_compressed` (base64 of `gzipSync(text)`) is part of a manifest entry hashed by `computeVibesHashV2`. The gzip header carries an OS byte (offset 9) that varies by platform/zlib build (0x13 on Darwin zlib-ng, 0x03 on stock Linux zlib, 0x00/0x0a/0x0b on Windows), so raw gzip output is NOT hash-stable. Phase 1 verified the instability is real and fixed it by canonicalizing the header before storing: MTIME (bytes 4-7) zeroed and the OS byte pinned to 0xff ("unknown" per RFC 1952). Hashing the raw plaintext instead was rejected because `rehashManifest()` in `vibes-io.ts` must be able to recompute keys from the stored entry bytes. The stored payload remains a valid gzip stream (`gunzipSync` roundtrips unchanged). Residual caveat: different zlib backends can emit different deflate streams for the same input, but Electron ships one zlib per release across all platforms, so this does not vary by OS for a given Maestro build.

## Windows runtime rules

### vibecheck binary resolution and shell spawn

`vibes-bridge.ts` probes each candidate location with platform-appropriate extensions: `['.exe', '.cmd', '.bat', '']` on win32 (a cargo install produces `vibecheck.exe`; npm shims are `vibecheck.cmd`), bare name only on POSIX. The POSIX-only `/usr/local/bin` candidate is skipped on Windows; `%USERPROFILE%\.cargo\bin` is covered via `os.homedir()`. Resolved `.cmd`/`.bat` shims MUST be spawned through a shell (resolved via `getWindowsShellForAgentExecution()`, args escaped via `escapeArgsForShell()`) because `execFile` throws EINVAL on them in modern Node; `.exe` targets stay on plain `execFile`. The renderer install copy (`VibesInstallGuide.tsx`, `VibesPanel.tsx`) branches on `isWindows()` and points Windows users at `%USERPROFILE%\.cargo\bin` / `vibecheck.exe`, matching what the resolver actually probes.

### atomicWriteFile rename retry

On Windows, `rename` over an existing target fails with `EPERM`/`EACCES`/`EBUSY` under mandatory file locking (readers, antivirus, Search Indexer can hold `manifest.json`/`annotations.jsonl` open), and the debounced flush paths would otherwise silently drop updates. `atomicWriteFile` in `vibes-io.ts` therefore renames via `renameWithRetry()`: 5 attempts with 10/30/80/200ms backoff, retrying ONLY on those three codes and rethrowing anything else (and final exhaustion) immediately; the orphaned temp file is best-effort unlinked on final failure. Temp paths use a module-level monotonic counter (`${filePath}.${n}.tmp`) so concurrent writers cannot collide. `rehashManifest` also writes through `atomicWriteFile`.

## Key-at-rest model (seal + export, NO passphrase)

The canonical Ed25519 private key is SEALED with the OS keychain (Electron `safeStorage`) at `<userData>/vibes/vibescheck.key.sealed`; Maestro's own signing unseals it in memory and never needs a plaintext file. The plaintext PKCS8 PEM at the spec path `~/.vibescheck/keys/vibescheck.key` exists ONLY when:

- the user explicitly clicks "Export key for the vibecheck CLI" (Settings > VIBES, behind an UNENCRYPTED-key warning confirm), or
- sealing is unavailable (`safeStorage.isEncryptionAvailable()` false: keyring-less Linux, headless/SSH), where key generation degrades to a hardened plaintext write rather than blocking, or
- the install predates sealing (legacy key; migrated into the sealed store on startup by `migrateLegacyKeyIfNeeded()`, plaintext left in place for the CLI).

Honesty and hardening rules:

- `getUserKeyInfo()` reports `encryptedAtRest` truthfully (`true` only when a sealed key exists AND the keychain can unseal it) plus a reason (`os-keychain-unavailable` or `plaintext-legacy-key`) when false. The renderer shows this state; never pretend a plaintext key is encrypted.
- Every plaintext private-key write goes through `hardenPrivateKeyFile()`: POSIX `chmod 0600`; Windows best-effort ACL restriction via `icacls <path> /inheritance:r /grant:r <user>:F` (failure is swallowed with a logged warning).
- `checkKeyPermissions()` only warns about a REAL problem: no plaintext key on disk (sealed or no key at all) is valid; a plaintext key is mode-checked (0600) on POSIX only; on Windows an existing key is treated as valid and the `chmod` wording is never emitted.
- There is NO passphrase flow (product decision; do not add one).

## Needs manual Windows validation

- [ ] **vibecheck binary resolution and execution** (`src/main/vibes/vibes-bridge.ts`): install `vibecheck` via `cargo install` (produces `%USERPROFILE%\.cargo\bin\vibecheck.exe`), open a VIBES-initialized project in Maestro, and confirm `vibesBuild`/`vibesReport` work from the VIBES panel (no "vibecheck binary not found" error). Bonus: also test an npm-installed `vibecheck.cmd` shim in the project's `node_modules\.bin` and confirm commands still succeed (the `.cmd` shim is spawned through a shell).
- [ ] **Atomic writes under Windows file locking** (`src/main/vibes/vibes-io.ts`): on Windows, run a VIBES session while the project's `.ai-audit` folder is open in Explorer and/or being scanned (antivirus, Search Indexer), and confirm manifest/annotation updates are not lost - `manifest.json` and `annotations.jsonl` keep growing during the session and no `[vibes-io]` rename warnings appear in the System Log Viewer.
- [ ] **Key generation + honest status** (`vibes-key-manager.ts`, `VibesKeygenWizard.tsx`, `VibesSettings.tsx`): generate a key via the wizard on Windows, restart Maestro, and confirm NO key-permission warning toast appears on launch (the old build fired a bogus `chmod 600` warning every start). Confirm Settings > VIBES shows "Encrypted at rest (OS keychain)" and the wizard's step 2 shows the same storage status with `%USERPROFILE%\.vibescheck\keys` shaped paths.
- [ ] **CLI key export + ACL restriction** (`exportPrivateKeyForCli`): click "Export key for the vibecheck CLI" in Settings > VIBES, confirm the plaintext key appears at `%USERPROFILE%\.vibescheck\keys\vibescheck.key`, and run `icacls "%USERPROFILE%\.vibescheck\keys\vibescheck.key"` - the output should list ONLY the current user (inheritance stripped). A success toast should show the written path.
- [ ] **Cross-platform hash reproducibility** (Phase 1, highest value): annotate the SAME repo (same commits, same edits) once on Windows and once on macOS, then compare the resulting `.ai-audit/manifest.json` and `annotations.jsonl` hashes/entries - they must match byte-for-byte for the same logical operations (forward-slash `file_path`, LF-normalized content hashes, canonicalized gzip headers).
- [ ] **vibecheck build/report against the exported key**: with the key exported (previous item), run `vibecheck build` and `vibecheck report` from the VIBES panel on Windows and confirm they succeed using the exported plaintext key.

Note for maintainers: the key ceremony script (`scripts/vibes-key-ceremony.mjs`) writes the maintainer key with `mode: 0o600`, which is a no-op on Windows (no POSIX modes on NTFS). Run the ceremony on a POSIX machine.
