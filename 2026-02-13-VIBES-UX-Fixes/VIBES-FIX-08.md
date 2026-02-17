# VIBES-FIX-08: Fix Hash Algorithm Mismatch (Strip `type` Field)

Maestro's `computeVibesHash()` includes the `type` field in the SHA-256 input, but the VIBES spec (and vibecheck's Rust `compute_hash()`) strips both `created_at` AND `type` before hashing. This causes every manifest entry key to differ from what vibecheck computes, producing "Hash mismatch" verification failures and preventing correct hash lookups.

## Root Cause

**Maestro** (`vibes-hash.ts:17-26`):
```
SHA256({"model_name":"unknown","tool_name":"Claude Code","type":"environment",...})
```

**vibecheck** (`hash.rs`):
```
SHA256({"model_name":"unknown","tool_name":"Claude Code",...})
// strips both created_at AND type
```

Result: 6 "Hash mismatch: key=X computed=Y" failures on every `vibecheck verify`, plus all hash-based lookups fail.

## Impact

- Every manifest entry stored by Maestro has the wrong key
- Existing `.ai-audit/manifest.json` files in all projects will have incorrect keys
- Annotations reference the old (incorrect) hashes, so after fixing the hash function, a re-hash migration is needed for existing data

---

- [ ] **Task 1: Fix `computeVibesHash` to strip `type` field.** In `src/main/vibes/vibes-hash.ts`, change line 19 from:
  ```typescript
  const { created_at: _, ...rest } = context;
  ```
  to:
  ```typescript
  const { created_at: _, type: __, ...rest } = context;
  ```
  Also update the docstring (lines 10-15) to reflect the algorithm change — add step 1b: "Remove `type` field (serde discriminant tag, not part of content identity)".

- [ ] **Task 2: Add a manifest re-hash migration utility.** In `src/main/vibes/vibes-io.ts`, add a new exported async function `rehashManifest` after the `flushAll` function (around line 551). This function re-keys all manifest entries and updates all annotation hash references to match. Implementation:
  ```typescript
  /**
   * Re-hash all manifest entries and update annotation references.
   * Required after fixing computeVibesHash to strip the `type` field.
   * Idempotent — entries already matching the new hash are skipped.
   */
  export async function rehashManifest(projectPath: string): Promise<{ rehashedEntries: number; updatedAnnotations: number }> {
  	const manifest = await readVibesManifest(projectPath);
  	const hashMap = new Map<string, string>(); // oldHash → newHash
  	const newEntries: Record<string, VibesManifestEntry> = {};
  	let rehashedEntries = 0;

  	for (const [oldHash, entry] of Object.entries(manifest.entries)) {
  		const newHash = computeVibesHash(entry as unknown as Record<string, unknown>);
  		if (oldHash !== newHash) {
  			hashMap.set(oldHash, newHash);
  			rehashedEntries++;
  		}
  		newEntries[newHash] = entry;
  	}

  	// Write updated manifest
  	manifest.entries = newEntries;
  	await writeVibesManifest(projectPath, manifest);

  	// Update annotation hash references
  	let updatedAnnotations = 0;
  	if (hashMap.size > 0) {
  		const annotations = await readAnnotations(projectPath);
  		const updated = annotations.map((a) => {
  			let changed = false;
  			const record = { ...a } as Record<string, unknown>;
  			for (const field of ['environment_hash', 'command_hash', 'prompt_hash', 'reasoning_hash']) {
  				const oldVal = record[field] as string | undefined;
  				if (oldVal && hashMap.has(oldVal)) {
  					record[field] = hashMap.get(oldVal);
  					changed = true;
  				}
  			}
  			if (changed) updatedAnnotations++;
  			return record;
  		});

  		// Rewrite annotations.jsonl
  		const auditDir = path.join(projectPath, '.ai-audit');
  		const annotationsPath = path.join(auditDir, 'annotations.jsonl');
  		const content = updated.map((a) => JSON.stringify(a)).join('\n') + '\n';
  		await writeFile(annotationsPath, content, 'utf-8');
  	}

  	return { rehashedEntries, updatedAnnotations };
  }
  ```
  Import `computeVibesHash` from `./vibes-hash` at the top of the file. Ensure `readAnnotations`, `readVibesManifest`, `writeVibesManifest`, `writeFile`, and `path` are already imported (they should be).

- [ ] **Task 3: Add a `vibes:rehash` IPC handler.** In `src/main/ipc/handlers/vibes-handlers.ts`, add a new handler after the existing `vibes:build` handler. The handler should call `rehashManifest`:
  ```typescript
  ipcMain.handle('vibes:rehash', async (_event, projectPath: string) => {
  	try {
  		const result = await rehashManifest(projectPath);
  		return { success: true, data: JSON.stringify(result) };
  	} catch (error) {
  		logger.error('rehash error', LOG_CONTEXT, { error: String(error) });
  		return { success: false, error: String(error) };
  	}
  });
  ```
  Import `rehashManifest` from `../../vibes/vibes-io` (add to existing import).

- [ ] **Task 4: Verify.** Run `npm run lint` to confirm no TypeScript errors. To test the fix end-to-end: (1) Run the `vibes:rehash` handler against a project with existing VIBES data, (2) Run `vibecheck verify` — the 6 "Hash mismatch" errors should be resolved, (3) New annotations created after the fix should use correct hashes natively.
