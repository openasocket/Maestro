/**
 * Analyzed Sessions Registry — tracks which sessions have been analyzed for experience extraction.
 *
 * Append-only JSONL file at <configDir>/memories/analyzed-sessions.jsonl.
 * Prevents duplicate analysis during retroactive scans and mid-session triggers.
 *
 * Design: cheap reads via cached Set<string>, cheap writes via append.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface AnalyzedSessionRecord {
	sessionId: string;
	analyzedAt: number;
	experiencesStored: number;
	providerUsed?: string;
	trigger: 'exit' | 'retroactive' | 'mid-session' | 'per-turn';
}

export class AnalyzedSessionsRegistry {
	private readonly filePath: string;
	/** Cached map of analyzed session keys → records — invalidated on write */
	private cache: Map<string, AnalyzedSessionRecord> | null = null;

	constructor(memoriesDir: string) {
		this.filePath = path.join(memoriesDir, 'analyzed-sessions.jsonl');
	}

	/** Check if a session (or session:checkpoint key) has been analyzed. */
	async isAnalyzed(key: string): Promise<boolean> {
		const map = await this.loadCache();
		return map.has(key);
	}

	/** Get the analysis record for a session key (or undefined if not analyzed). */
	async getEntry(key: string): Promise<AnalyzedSessionRecord | undefined> {
		const map = await this.loadCache();
		return map.get(key);
	}

	/** Mark a session as analyzed. */
	async markAnalyzed(record: AnalyzedSessionRecord): Promise<void> {
		const line = JSON.stringify(record) + '\n';
		await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
		await fs.promises.appendFile(this.filePath, line, 'utf-8');
		// Update cache in-place
		if (this.cache) {
			this.cache.set(record.sessionId, record);
		}
	}

	/** Get count of analyzed sessions. */
	async getAnalyzedCount(): Promise<number> {
		const map = await this.loadCache();
		return map.size;
	}

	/**
	 * Get session IDs that have history but have NOT been analyzed.
	 * Cross-references with historyManager.listSessionsWithHistory().
	 */
	async getUnanalyzedSessionIds(): Promise<string[]> {
		const analyzed = await this.loadCache();
		const { getHistoryManager } = await import('../history-manager');
		const hm = getHistoryManager();
		const allSessions = hm.listSessionsWithHistory();
		return allSessions.filter((sid) => !analyzed.has(sid));
	}

	/** Load the cache from disk (reads once, then cached). */
	private async loadCache(): Promise<Map<string, AnalyzedSessionRecord>> {
		if (this.cache) return this.cache;

		const map = new Map<string, AnalyzedSessionRecord>();
		try {
			const content = await fs.promises.readFile(this.filePath, 'utf-8');
			for (const line of content.split('\n')) {
				if (!line.trim()) continue;
				try {
					const record = JSON.parse(line) as AnalyzedSessionRecord;
					map.set(record.sessionId, record);
				} catch {
					// Malformed line — skip
				}
			}
		} catch {
			// File doesn't exist yet — empty map
		}

		this.cache = map;
		return map;
	}

	/** Invalidate cache (for testing or after external file changes). */
	invalidateCache(): void {
		this.cache = null;
	}
}

// ─── Singleton ──────────────────────────────────────────────────────────────

let _instance: AnalyzedSessionsRegistry | null = null;

export function getAnalyzedSessionsRegistry(): AnalyzedSessionsRegistry {
	if (!_instance) {
		const { app } = require('electron');
		const Store = require('electron-store');
		const bootstrapStore = new Store({ name: 'maestro-bootstrap', defaults: {} });
		const configDir = bootstrapStore.get('customSyncPath') || app.getPath('userData');
		_instance = new AnalyzedSessionsRegistry(path.join(configDir, 'memories'));
	}
	return _instance;
}

export function resetAnalyzedSessionsRegistry(): void {
	_instance = null;
}
