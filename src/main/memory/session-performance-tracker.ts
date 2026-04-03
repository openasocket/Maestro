/**
 * SessionPerformanceTracker — session-level performance history and trend analysis.
 *
 * Implements the HyperAgents paper's PerformanceTracker pattern:
 * windowed moving averages, regression detection, and memory correlation.
 *
 * Storage: <configDir>/memories/performance/performance-history.jsonl
 *
 * @see HYPERAGENT-01
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type {
	SessionPerformanceEntry,
	PerformanceTrend,
	PerformanceSummary,
} from '../../shared/memory-types';

/** Direction thresholds matching HyperAgents paper */
const IMPROVING_THRESHOLD = 0.05;
const DECLINING_THRESHOLD = -0.05;

/** Regression alert threshold */
const REGRESSION_THRESHOLD = -0.1;

/** Maximum in-memory entries (ring buffer cap) */
const MAX_CACHE_ENTRIES = 500;

/** Default trend window size */
const DEFAULT_WINDOW = 5;

const HISTORY_FILENAME = 'performance-history.jsonl';

export class SessionPerformanceTracker {
	private readonly storageDir: string;
	private readonly historyPath: string;
	private cache: SessionPerformanceEntry[] = [];
	private loaded = false;

	constructor(storageDir: string) {
		this.storageDir = storageDir;
		this.historyPath = path.join(storageDir, HISTORY_FILENAME);
	}

	// ─── Public API ──────────────────────────────────────────────────────────

	/**
	 * Append a session performance entry to the JSONL file and in-memory cache.
	 */
	async recordSession(entry: SessionPerformanceEntry): Promise<void> {
		await this._ensureLoaded();
		await this._appendEntry(entry);
		this.cache.push(entry);
		// Ring-buffer cap: drop oldest when exceeding limit
		if (this.cache.length > MAX_CACHE_ENTRIES) {
			this.cache = this.cache.slice(this.cache.length - MAX_CACHE_ENTRIES);
		}
	}

	/**
	 * Get filtered history entries, most recent first.
	 */
	async getHistory(options?: {
		personaId?: string;
		projectPath?: string;
		limit?: number;
	}): Promise<SessionPerformanceEntry[]> {
		await this._ensureLoaded();
		let entries = this.cache;

		if (options?.personaId) {
			entries = entries.filter((e) => e.personaId === options.personaId);
		}
		if (options?.projectPath) {
			entries = entries.filter((e) => e.projectPath === options.projectPath);
		}

		// Most recent first
		const sorted = [...entries].reverse();

		if (options?.limit && options.limit > 0) {
			return sorted.slice(0, options.limit);
		}
		return sorted;
	}

	/**
	 * Compute windowed improvement trend using the HyperAgents paper algorithm.
	 *
	 * recentAvg = avg(last N scores)
	 * olderAvg  = avg(scores N+1 to 2N)
	 * delta     = recentAvg - olderAvg
	 * direction = improving if delta > 0.05, declining if < -0.05, else stable
	 */
	async getTrend(options?: {
		personaId?: string;
		projectPath?: string;
		window?: number;
	}): Promise<PerformanceTrend | null> {
		await this._ensureLoaded();
		const window = options?.window ?? DEFAULT_WINDOW;
		const entries = this._filteredEntries(options);
		return this._computeTrend(entries, window);
	}

	/**
	 * Compute full performance summary with per-persona/project breakdowns
	 * and memory correlation analysis.
	 */
	async getSummary(options?: {
		personaId?: string;
		projectPath?: string;
	}): Promise<PerformanceSummary> {
		await this._ensureLoaded();
		const entries = this._filteredEntries(options);

		if (entries.length === 0) {
			return {
				totalSessions: 0,
				overallAvg: 0,
				bestScore: 0,
				worstScore: 0,
				trend: null,
				byPersona: {},
				byProject: {},
				topMemories: [],
				decliningMemories: [],
			};
		}

		const scores = entries.map((e) => e.outcomeScore);
		const overallAvg = scores.reduce((s, v) => s + v, 0) / scores.length;

		// Per-persona breakdown
		const byPersona: PerformanceSummary['byPersona'] = {};
		const personaGroups = this._groupBy(entries, (e) => e.personaId ?? '__none__');
		for (const [pid, group] of Object.entries(personaGroups)) {
			if (pid === '__none__') continue;
			const avg = group.reduce((s, e) => s + e.outcomeScore, 0) / group.length;
			byPersona[pid] = {
				count: group.length,
				avg,
				trend: this._computeTrend(group, DEFAULT_WINDOW),
			};
		}

		// Per-project breakdown
		const byProject: PerformanceSummary['byProject'] = {};
		const projectGroups = this._groupBy(entries, (e) => e.projectPath ?? '__none__');
		for (const [proj, group] of Object.entries(projectGroups)) {
			if (proj === '__none__') continue;
			const avg = group.reduce((s, e) => s + e.outcomeScore, 0) / group.length;
			byProject[proj] = {
				count: group.length,
				avg,
				trend: this._computeTrend(group, DEFAULT_WINDOW),
			};
		}

		// Memory correlation analysis
		const { topMemories, decliningMemories } = this._computeMemoryCorrelations(entries, overallAvg);

		return {
			totalSessions: entries.length,
			overallAvg,
			bestScore: Math.max(...scores),
			worstScore: Math.min(...scores),
			trend: this._computeTrend(entries, DEFAULT_WINDOW),
			byPersona,
			byProject,
			topMemories,
			decliningMemories,
		};
	}

	/**
	 * Identify regressions: personas, projects, or memories that have declined
	 * by more than 0.1 in the recent window vs previous window.
	 */
	async identifyRegressions(
		window?: number
	): Promise<
		Array<{ type: 'persona' | 'project' | 'memory'; id: string; name?: string; delta: number }>
	> {
		await this._ensureLoaded();
		const w = window ?? DEFAULT_WINDOW;
		const regressions: Array<{
			type: 'persona' | 'project' | 'memory';
			id: string;
			name?: string;
			delta: number;
		}> = [];

		// Persona regressions
		const personaGroups = this._groupBy(this.cache, (e) => e.personaId ?? '__none__');
		for (const [pid, group] of Object.entries(personaGroups)) {
			if (pid === '__none__') continue;
			const trend = this._computeTrend(group, w);
			if (trend && trend.delta < REGRESSION_THRESHOLD) {
				const name = group[group.length - 1]?.personaName;
				regressions.push({ type: 'persona', id: pid, name, delta: trend.delta });
			}
		}

		// Project regressions
		const projectGroups = this._groupBy(this.cache, (e) => e.projectPath ?? '__none__');
		for (const [proj, group] of Object.entries(projectGroups)) {
			if (proj === '__none__') continue;
			const trend = this._computeTrend(group, w);
			if (trend && trend.delta < REGRESSION_THRESHOLD) {
				regressions.push({ type: 'project', id: proj, delta: trend.delta });
			}
		}

		// Memory regressions
		const memoryScores = this._computeMemoryWindowedScores(this.cache, w);
		for (const [memId, scores] of Object.entries(memoryScores)) {
			if (scores.recentAvg !== null && scores.olderAvg !== null) {
				const delta = scores.recentAvg - scores.olderAvg;
				if (delta < REGRESSION_THRESHOLD) {
					regressions.push({ type: 'memory', id: memId, delta });
				}
			}
		}

		return regressions;
	}

	// ─── Private Helpers ─────────────────────────────────────────────────────

	private _filteredEntries(options?: {
		personaId?: string;
		projectPath?: string;
	}): SessionPerformanceEntry[] {
		let entries = this.cache;
		if (options?.personaId) {
			entries = entries.filter((e) => e.personaId === options.personaId);
		}
		if (options?.projectPath) {
			entries = entries.filter((e) => e.projectPath === options.projectPath);
		}
		return entries;
	}

	/**
	 * HyperAgents windowed trend computation.
	 * Needs at least 2*window entries to produce a trend.
	 */
	private _computeTrend(
		entries: SessionPerformanceEntry[],
		window: number
	): PerformanceTrend | null {
		if (entries.length < window * 2) return null;

		// Sort by timestamp ascending to get chronological order
		const sorted = [...entries].sort((a, b) => a.timestamp - b.timestamp);
		const recent = sorted.slice(-window);
		const older = sorted.slice(-window * 2, -window);

		const recentAvg = recent.reduce((s, e) => s + e.outcomeScore, 0) / recent.length;
		const olderAvg = older.reduce((s, e) => s + e.outcomeScore, 0) / older.length;
		const delta = recentAvg - olderAvg;

		let direction: PerformanceTrend['direction'];
		if (delta > IMPROVING_THRESHOLD) {
			direction = 'improving';
		} else if (delta < DECLINING_THRESHOLD) {
			direction = 'declining';
		} else {
			direction = 'stable';
		}

		return { window, recentAvg, olderAvg, delta, direction };
	}

	/**
	 * Compute memory correlation scores.
	 * Groups sessions by injected memory, computes average outcome per memory.
	 */
	private _computeMemoryCorrelations(
		entries: SessionPerformanceEntry[],
		overallAvg: number
	): {
		topMemories: Array<{ memoryId: string; correlationScore: number }>;
		decliningMemories: Array<{ memoryId: string; correlationScore: number }>;
	} {
		const memoryScoreMap = new Map<string, number[]>();

		for (const entry of entries) {
			for (const memId of entry.injectedMemoryIds) {
				let arr = memoryScoreMap.get(memId);
				if (!arr) {
					arr = [];
					memoryScoreMap.set(memId, arr);
				}
				arr.push(entry.outcomeScore);
			}
		}

		const memoryAvgs: Array<{ memoryId: string; avg: number }> = [];
		for (const [memoryId, scores] of memoryScoreMap) {
			if (scores.length < 2) continue; // Need at least 2 data points
			const avg = scores.reduce((s, v) => s + v, 0) / scores.length;
			memoryAvgs.push({ memoryId, avg });
		}

		// Sort by average descending for top, ascending for declining
		const sorted = [...memoryAvgs].sort((a, b) => b.avg - a.avg);

		const topMemories = sorted
			.filter((m) => m.avg >= overallAvg)
			.slice(0, 10)
			.map((m) => ({ memoryId: m.memoryId, correlationScore: m.avg }));

		const decliningMemories = sorted
			.filter((m) => m.avg < overallAvg)
			.reverse()
			.slice(0, 10)
			.map((m) => ({ memoryId: m.memoryId, correlationScore: m.avg }));

		return { topMemories, decliningMemories };
	}

	/**
	 * Compute per-memory windowed average scores for regression detection.
	 */
	private _computeMemoryWindowedScores(
		entries: SessionPerformanceEntry[],
		window: number
	): Record<string, { recentAvg: number | null; olderAvg: number | null }> {
		// Collect sessions per memory in chronological order
		const memSessions = new Map<string, SessionPerformanceEntry[]>();
		const sorted = [...entries].sort((a, b) => a.timestamp - b.timestamp);

		for (const entry of sorted) {
			for (const memId of entry.injectedMemoryIds) {
				let arr = memSessions.get(memId);
				if (!arr) {
					arr = [];
					memSessions.set(memId, arr);
				}
				arr.push(entry);
			}
		}

		const result: Record<string, { recentAvg: number | null; olderAvg: number | null }> = {};
		for (const [memId, sessions] of memSessions) {
			if (sessions.length < window * 2) {
				result[memId] = { recentAvg: null, olderAvg: null };
				continue;
			}
			const recent = sessions.slice(-window);
			const older = sessions.slice(-window * 2, -window);
			result[memId] = {
				recentAvg: recent.reduce((s, e) => s + e.outcomeScore, 0) / recent.length,
				olderAvg: older.reduce((s, e) => s + e.outcomeScore, 0) / older.length,
			};
		}
		return result;
	}

	private _groupBy<T>(items: T[], keyFn: (item: T) => string): Record<string, T[]> {
		const groups: Record<string, T[]> = {};
		for (const item of items) {
			const key = keyFn(item);
			if (!groups[key]) groups[key] = [];
			groups[key].push(item);
		}
		return groups;
	}

	// ─── File I/O ────────────────────────────────────────────────────────────

	private async _ensureLoaded(): Promise<void> {
		if (this.loaded) return;
		await this._loadHistory();
		this.loaded = true;
	}

	/**
	 * Load JSONL history from disk into the in-memory cache.
	 * Keeps only the last MAX_CACHE_ENTRIES.
	 */
	private async _loadHistory(): Promise<void> {
		try {
			const raw = await fs.readFile(this.historyPath, 'utf-8');
			const lines = raw.split('\n').filter((l) => l.trim().length > 0);
			const entries: SessionPerformanceEntry[] = [];
			for (const line of lines) {
				try {
					entries.push(JSON.parse(line) as SessionPerformanceEntry);
				} catch {
					// Skip malformed lines
				}
			}
			// Keep only the last MAX_CACHE_ENTRIES
			this.cache =
				entries.length > MAX_CACHE_ENTRIES
					? entries.slice(entries.length - MAX_CACHE_ENTRIES)
					: entries;
		} catch {
			// File doesn't exist yet — start with empty cache
			this.cache = [];
		}
	}

	/**
	 * Append a single entry to the JSONL file.
	 * Creates the directory and file if they don't exist.
	 */
	private async _appendEntry(entry: SessionPerformanceEntry): Promise<void> {
		await fs.mkdir(this.storageDir, { recursive: true });
		const line = JSON.stringify(entry) + '\n';
		await fs.appendFile(this.historyPath, line, 'utf-8');
	}
}

// ─── Singleton ──────────────────────────────────────────────────────────────

let _instance: SessionPerformanceTracker | null = null;

export function getSessionPerformanceTracker(storageDir: string): SessionPerformanceTracker {
	if (!_instance) {
		_instance = new SessionPerformanceTracker(storageDir);
	}
	return _instance;
}

/** Reset the singleton (for testing) */
export function resetSessionPerformanceTracker(): void {
	_instance = null;
}
