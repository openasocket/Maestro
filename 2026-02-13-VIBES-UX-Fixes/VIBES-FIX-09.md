# VIBES-FIX-09: Fix Manifest Entry Loss (Flush Race Condition + Shutdown Safety)

Manifest entries are queued via a 500ms debounce (`addManifestEntry` in `vibes-io.ts`) but can be permanently lost when: (1) the app shuts down before the debounce fires, (2) sessions end without clean process exit, or (3) annotation buffers flush before the manifest debounce. This causes `vibecheck verify` to report "references missing environment_hash/command_hash/reasoning_hash" for entries that were computed but never written to `manifest.json`.

## Root Cause

Empirically confirmed: the Codex-VIBES project has annotations from Feb 13 sessions referencing 41 manifest hashes (32 command + 9 reasoning) that don't exist in the manifest. All manifest entries have timestamps starting Feb 14 — the Feb 13 entries were lost when the app was closed between sessions.

**Data flow timing problem:**
1. `createCommandEntry()` → computes hash → `addManifestEntry()` queued with 500ms debounce
2. `createLineAnnotation()` → references that hash → annotation buffered (flushes at 20 items or 2s)
3. If app closes before debounce fires, annotation is on disk but manifest entry is lost

**Missing safety net:** `flushAll()` is only called from `endSession()`. No global app shutdown handler exists to flush pending manifest writes.

## Fixes

Three complementary fixes to eliminate the race condition:

---

- [ ] **Task 1: Write environment manifest entry immediately (not debounced).** The environment entry is the single most critical manifest entry — every annotation in the session references it. In `src/main/vibes/vibes-io.ts`, add a new exported function `addManifestEntryImmediate` after the existing `addManifestEntry` function (around line 519):
  ```typescript
  /**
   * Write a manifest entry immediately (bypasses debounce).
   * Use for critical entries like environment that must exist before
   * any annotations reference them.
   */
  export async function addManifestEntryImmediate(
  	projectPath: string,
  	hash: string,
  	entry: VibesManifestEntry,
  ): Promise<void> {
  	try {
  		await ensureAuditDir(projectPath);
  		const manifest = await readVibesManifest(projectPath);
  		if (!(hash in manifest.entries)) {
  			manifest.entries[hash] = entry;
  			await writeVibesManifest(projectPath, manifest);
  		}
  	} catch (err) {
  		logWarn('Failed to write immediate manifest entry', err);
  	}
  }
  ```

  Then in `src/main/vibes/vibes-session.ts`, add `addManifestEntryImmediate` to the import from `./vibes-io` (line 7), and add a new method `recordManifestEntryImmediate` after the existing `recordManifestEntry` (around line 195):
  ```typescript
  /**
   * Record a manifest entry immediately (bypasses debounce).
   * Use for critical entries that must exist before annotations reference them.
   */
  async recordManifestEntryImmediate(
  	sessionId: string,
  	hash: string,
  	entry: VibesManifestEntry,
  ): Promise<void> {
  	const state = this.sessions.get(sessionId);
  	if (!state || !state.isActive) {
  		return;
  	}
  	await addManifestEntryImmediate(state.projectPath, hash, entry);
  }
  ```

  Finally, in `src/main/vibes/vibes-coordinator.ts`, change line 312 from:
  ```typescript
  await this.sessionManager.recordManifestEntry(sessionId, envHash, envEntry);
  ```
  to:
  ```typescript
  await this.sessionManager.recordManifestEntryImmediate(sessionId, envHash, envEntry);
  ```
  This ensures the environment entry is written to disk before any annotations can reference it.

- [ ] **Task 2: Flush manifest before annotation buffer flush.** In `src/main/vibes/vibes-io.ts`, modify `flushAll()` (line 529) to flush manifests BEFORE annotations, ensuring all referenced hashes exist on disk before the annotations that reference them. Change from:
  ```typescript
  export async function flushAll(): Promise<void> {
  	const flushPromises: Promise<void>[] = [];

  	// Flush all annotation buffers
  	for (const projectPath of annotationBuffers.keys()) {
  		flushPromises.push(
  			flushAnnotationBuffer(projectPath).catch((err) => {
  				logWarn(`flushAll: annotation flush failed for ${projectPath}`, err);
  			}),
  		);
  	}

  	// Flush all manifest debounces
  	for (const projectPath of manifestDebounces.keys()) {
  		flushPromises.push(
  			flushManifestDebounce(projectPath).catch((err) => {
  				logWarn(`flushAll: manifest flush failed for ${projectPath}`, err);
  			}),
  		);
  	}

  	await Promise.all(flushPromises);
  }
  ```
  to:
  ```typescript
  export async function flushAll(): Promise<void> {
  	// Flush manifests FIRST — ensures all referenced hashes exist on disk
  	// before the annotations that reference them are written.
  	const manifestPromises: Promise<void>[] = [];
  	for (const projectPath of manifestDebounces.keys()) {
  		manifestPromises.push(
  			flushManifestDebounce(projectPath).catch((err) => {
  				logWarn(`flushAll: manifest flush failed for ${projectPath}`, err);
  			}),
  		);
  	}
  	await Promise.all(manifestPromises);

  	// Then flush annotation buffers
  	const annotationPromises: Promise<void>[] = [];
  	for (const projectPath of annotationBuffers.keys()) {
  		annotationPromises.push(
  			flushAnnotationBuffer(projectPath).catch((err) => {
  				logWarn(`flushAll: annotation flush failed for ${projectPath}`, err);
  			}),
  		);
  	}
  	await Promise.all(annotationPromises);
  }
  ```

- [ ] **Task 3: Add app shutdown flush handler.** In `src/main/vibes/vibes-coordinator.ts`, add a `shutdown()` method to the `VibesCoordinator` class that flushes all pending writes and ends all active sessions. Add after the `handleProcessExit` method (around line 375):
  ```typescript
  /**
   * Graceful shutdown — end all active sessions and flush all pending writes.
   * Must be called on app quit/before-quit to prevent manifest entry loss.
   */
  async shutdown(): Promise<void> {
  	const activeSessions = this.sessionManager.getActiveSessions();
  	for (const sessionId of activeSessions) {
  		try {
  			const agentType = this.sessionAgentTypes.get(sessionId);
  			if (agentType) {
  				const instrumenter = this.getInstrumenter(agentType);
  				if (instrumenter) {
  					await instrumenter.flush(sessionId);
  				}
  			}
  			await this.sessionManager.endSession(sessionId);
  		} catch (err) {
  			logWarn(`shutdown: failed to end session ${sessionId}`, err);
  		}
  	}
  	// Final safety flush for any remaining debounced writes
  	await flushAll();
  }
  ```
  Import `flushAll` from `./vibes-io` at the top of the file. Also add `logWarn` import from `./vibes-io` if not already present.

  Then add a `getActiveSessions()` method to `VibesSessionManager` in `src/main/vibes/vibes-session.ts` (after `getSession`, around line 152):
  ```typescript
  /**
   * Return all active session IDs.
   */
  getActiveSessions(): string[] {
  	return [...this.sessions.entries()]
  		.filter(([_, state]) => state.isActive)
  		.map(([id]) => id);
  }
  ```

  Finally, wire the shutdown into the Electron app lifecycle. In `src/main/index.ts`, find the `app.on('before-quit')` or `app.on('will-quit')` handler (or the main window close handler) and add:
  ```typescript
  await vibesCoordinator.shutdown();
  ```
  If no such handler exists, add one:
  ```typescript
  app.on('before-quit', async (event) => {
  	if (vibesCoordinator) {
  		event.preventDefault();
  		await vibesCoordinator.shutdown();
  		app.exit(0);
  	}
  });
  ```
  (Check existing shutdown patterns in `index.ts` to match the codebase conventions.)

- [ ] **Task 4: Verify.** Run `npm run lint` to confirm no TypeScript errors. To test: (1) Start a VIBES-enabled session, perform several tool executions, then close the app, (2) Run `vibecheck verify` — all command/reasoning hashes should exist in the manifest, (3) Verify no "Open session (no end event)" warnings for sessions that were active when the app closed.
