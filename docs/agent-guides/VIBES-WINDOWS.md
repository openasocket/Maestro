# VIBES Windows Parity - Manual Validation Checklist

The VIBES/VERIFY feature (`src/main/vibes/`) was hardened for Windows against documented Win32 behavior and locked in with `process.platform = 'win32'` unit tests, but the developer has no Windows machine. Each fix below needs a one-time manual confirmation by a tester on a stock Windows 11 install (no admin elevation, no Developer Mode).

## Needs manual Windows validation

- [ ] **vibecheck binary resolution and execution** (`src/main/vibes/vibes-bridge.ts`): install `vibecheck` via `cargo install` (produces `%USERPROFILE%\.cargo\bin\vibecheck.exe`), open a VIBES-initialized project in Maestro, and confirm `vibesBuild`/`vibesReport` work from the VIBES panel (no "vibecheck binary not found" error). Bonus: also test an npm-installed `vibecheck.cmd` shim in the project's `node_modules\.bin` and confirm commands still succeed (the `.cmd` shim is spawned through a shell).
- [ ] **Atomic writes under Windows file locking** (`src/main/vibes/vibes-io.ts`): on Windows, run a VIBES session while the project's `.ai-audit` folder is open in Explorer and/or being scanned (antivirus, Search Indexer), and confirm manifest/annotation updates are not lost - `manifest.json` and `annotations.jsonl` keep growing during the session and no `[vibes-io]` rename warnings appear in the System Log Viewer.
