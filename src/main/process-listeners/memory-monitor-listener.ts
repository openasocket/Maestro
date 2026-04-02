/**
 * Memory Monitor Listener — tracks per-session state and triggers
 * mid-session memory injection when conditions warrant.
 *
 * Trigger conditions:
 * 1. Repeated errors (same error type 2+ times) → search memories with error message
 * 2. New tool domain detected → search memories for that tool/technology
 * 3. Periodic refresh (every 5th user write, >60s since last search) → search for new experiences
 * 4. Domain shift signal ([domain-shift: X] in agent output) → search memories for domain X
 * 5. High context usage (>70%) → reduce injection budget; >90% → stop injection
 *
 * Rate limiting:
 * - Max 1 search per liveSearchCooldownSeconds (default 60) per session
 * - Injection count/token caps enforced by LiveContextQueue (EXP-LIVE-01)
 *
 * Exclusions:
 * - Group chat sessions (prefix 'group-chat-')
 * - Batch sessions (regex match)
 * - Synopsis sessions (regex match)
 * - Sessions without projectPath
 * - SSH remote sessions (handled by LiveContextQueue drain)
 */

import { BrowserWindow } from 'electron';
import type { ProcessManager } from '../process-manager';
import type { ProcessListenerDependencies } from './types';
import { GROUP_CHAT_PREFIX } from './types';
import { isWebContentsAvailable } from '../utils/safe-send';
import type { UsageStats, ToolExecution, QueryCompleteData } from '../process-manager/types';
import type { AgentError, HistoryEntry } from '../../shared/types';
import type {
	CheckpointPriority,
	CheckpointEventType,
	CheckpointInjectionEvent,
} from '../../shared/memory-types';

/** Per-turn tool execution log entry for rich extraction */
export interface TurnToolLog {
	turnIndex: number;
	startedAt: number;
	tools: Array<{
		name: string;
		input: string;
		success: boolean;
		durationMs: number;
	}>;
	errors: string[];
}

export interface SessionMonitorState {
	sessionId: string;
	agentType: string;
	projectPath: string;
	/** Context usage percentage 0-100, updated on each usage event */
	lastContextUsage: number;
	/** Context window size for budget calculations */
	lastContextWindow: number;
	/** Error type counts for repeated-error detection */
	errorCounts: Map<string, number>;
	/** Timestamp of last error (for cooldown) */
	lastErrorAt: number;
	/** Unique tool names used in this session (for new-domain detection) */
	toolDomains: Set<string>;
	/** Timestamp of last memory search (for cooldown enforcement) */
	lastSearchAt: number;
	/** Effective token budget (reduced when context >70%) */
	effectiveBudget: number;
	/** Current turn index (incremented on each turn-complete for this session) */
	turnIndex: number;
	/** Timestamp when the current turn started (set on turn-start) */
	currentTurnStartedAt: number;
	/** Tool executions accumulated during the current turn */
	currentTurnToolExecutions: ToolExecution[];
	/** Error events accumulated during the current turn */
	currentTurnErrors: AgentError[];
	/** Usage stats from the most recent usage event in this turn */
	currentTurnUsage: UsageStats | null;
	/** Annotation count snapshot at turn start (for computing VIBES delta) */
	annotationCountAtTurnStart: number;
	/** Manifest entry count snapshot at turn start */
	manifestCountAtTurnStart: number;
	/** Number of per-turn extractions triggered in this session */
	perTurnExtractionCount: number;
	/** Timestamp of last per-turn extraction (for cooldown) */
	lastPerTurnExtractionAt: number;
	/** Initial persona match from spawn time (set on first re-evaluation) */
	initialPersonaMatch: { id: string; name: string; score: number } | null;
	/** Turn index of last persona re-evaluation */
	lastPersonaEvalTurnIndex: number;
	/** Timestamp of last persona re-evaluation */
	lastPersonaEvalAt: number;
	/** Checkpoint injection count this session */
	checkpointInjectionCount: number;
	/** Per-checkpoint-type cooldown timestamps */
	checkpointCooldowns: Map<CheckpointEventType, number>;
	/** Whether the 60% context pressure checkpoint has fired */
	contextPressureFired: boolean;
	/** Checkpoint injection events for UI display */
	checkpointEvents: CheckpointInjectionEvent[];
	/** Accumulated per-turn tool execution logs for rich extraction (MEM-EVOLVE-05) */
	sessionToolLog: TurnToolLog[];
}

/** Memory store shape used by this listener */
export interface MemoryStoreAccessor {
	getConfig: () => Promise<Record<string, unknown>>;
	cascadingSearch: (
		query: string,
		config: unknown,
		agentType: string,
		projectPath?: string
	) => Promise<
		Array<{
			entry: { id: string; type?: string; content: string };
			similarity: number;
			combinedScore: number;
		}>
	>;
	selectMatchingPersonas: (
		query: string,
		config: unknown,
		agentType: string,
		projectPath?: string
	) => Promise<
		Array<{
			persona: { id: string; name: string };
			personaName: string;
			roleName: string;
			roleSystemPrompt: string;
			similarity: number;
		}>
	>;
}

/** Live context queue shape used by this listener */
export interface LiveQueueAccessor {
	enqueue: (
		sessionId: string,
		content: string,
		source: string,
		tokenEstimate: number,
		memoryIds: string[],
		hasDiff?: boolean
	) => void;
	getWriteCount: (sessionId: string) => number;
}

/** Diff injection helpers from memory-injector (MEM-EVOLVE-02) */
export interface InjectorAccessor {
	getInjectionRecord: (sessionId: string) =>
		| {
				ids: string[];
				scopeGroups: any[];
				contentHashes: Map<string, string>;
				lastInjectedAt: number;
				totalTokensSaved: number;
				injectionEvents: import('../../shared/memory-types').InjectionTrackingEvent[];
		  }
		| undefined;
	generateDiffInjection: (
		newResults: any[],
		previousRecord: any
	) => {
		injectedPrompt: string;
		addedIds: string[];
		removedIds: string[];
		modifiedIds: string[];
		unchangedCount: number;
		tokenCount: number;
	};
	recordSessionInjection: (
		sessionId: string,
		memoryIds: string[],
		scopeGroups?: any[],
		searchResults?: any[],
		precomputedHashes?: Map<string, string>,
		trigger?: import('../../shared/memory-types').InjectionTrigger,
		turnIndex?: number
	) => void;
	hashContent: (content: string) => string;
}

/** Injectable memory module accessors — resolved lazily in production, injected in tests */
export interface MemoryModuleAccessors {
	getMemoryStore: () => MemoryStoreAccessor;
	getLiveContextQueue: () => LiveQueueAccessor;
	getInjector?: () => InjectorAccessor;
}

// ─── Per-Turn Interestingness Scoring ──────────────────────────────────────

export interface TurnSignals {
	turnDurationMs: number;
	errors: AgentError[];
	toolExecutions: ToolExecution[];
	usage: UsageStats | null;
	vibesAnnotationsDelta: number;
	vibesManifestDelta: number;
	turnIndex: number;
	entrySuccess: boolean | undefined;
}

export function scoreTurnInterestingness(signals: TurnSignals): number {
	let score = 0;

	// Turn duration (longer turns = more likely substantive work)
	if (signals.turnDurationMs > 30_000) score += 0.1;
	if (signals.turnDurationMs > 120_000) score += 0.15;

	// Errors (especially error→fix pattern)
	if (signals.errors.length > 0) score += 0.3;
	if (signals.errors.length > 0 && signals.entrySuccess === true) score += 0.2;

	// Tool execution volume
	if (signals.toolExecutions.length > 3) score += 0.1;
	if (signals.toolExecutions.length > 8) score += 0.15;

	// VIBES richness
	if (signals.vibesAnnotationsDelta > 5) score += 0.15;
	if (signals.vibesManifestDelta > 0) score += 0.1;

	// Output token volume
	if (signals.usage) {
		const outputTokens = signals.usage.outputTokens ?? 0;
		if (outputTokens > 2000) score += 0.1;
		if (outputTokens > 5000) score += 0.1;
	}

	// Failed turns teach
	if (signals.entrySuccess === false) score += 0.15;

	// Early turns (setup/context) get penalty
	if (signals.turnIndex <= 2) score *= 0.5;

	return Math.min(score, 1.0);
}

// ─── VIBES Delta Tracking ──────────────────────────────────────────────────

async function snapshotVibesCounts(state: SessionMonitorState): Promise<void> {
	try {
		const fs = await import('fs/promises');
		const path = await import('path');

		// Count annotation lines
		try {
			const annotPath = path.join(state.projectPath, '.ai-audit', 'annotations.jsonl');
			const content = await fs.readFile(annotPath, 'utf-8');
			state.annotationCountAtTurnStart = content
				.trim()
				.split('\n')
				.filter((l) => l.length > 0).length;
		} catch {
			state.annotationCountAtTurnStart = 0;
		}

		// Count manifest entries
		try {
			const manifestPath = path.join(state.projectPath, '.ai-audit', 'manifest.json');
			const content = await fs.readFile(manifestPath, 'utf-8');
			const manifest = JSON.parse(content);
			const entries = manifest.entries;
			state.manifestCountAtTurnStart = Array.isArray(entries)
				? entries.length
				: entries && typeof entries === 'object'
					? Object.keys(entries).length
					: 0;
		} catch {
			state.manifestCountAtTurnStart = 0;
		}
	} catch {
		// VIBES not available — leave snapshots at 0
	}
}

async function computeVibesDeltas(
	state: SessionMonitorState
): Promise<{ annotationsDelta: number; manifestDelta: number }> {
	let currentAnnotations = 0;
	let currentManifest = 0;

	try {
		const fs = await import('fs/promises');
		const path = await import('path');

		try {
			const annotPath = path.join(state.projectPath, '.ai-audit', 'annotations.jsonl');
			const content = await fs.readFile(annotPath, 'utf-8');
			currentAnnotations = content
				.trim()
				.split('\n')
				.filter((l) => l.length > 0).length;
		} catch {
			/* no file */
		}

		try {
			const manifestPath = path.join(state.projectPath, '.ai-audit', 'manifest.json');
			const content = await fs.readFile(manifestPath, 'utf-8');
			const manifest = JSON.parse(content);
			const entries = manifest.entries;
			currentManifest = Array.isArray(entries)
				? entries.length
				: entries && typeof entries === 'object'
					? Object.keys(entries).length
					: 0;
		} catch {
			/* no file */
		}
	} catch {
		/* fs import failed */
	}

	return {
		annotationsDelta: Math.max(0, currentAnnotations - state.annotationCountAtTurnStart),
		manifestDelta: Math.max(0, currentManifest - state.manifestCountAtTurnStart),
	};
}

// ─── Effectiveness Evaluation on Exit (MEM-EVOLVE-04) ──────────────────────

/**
 * Gather SessionOutcomeSignals from accumulated monitor state and evaluate
 * effectiveness for all injected memories. Called once at session exit.
 */
async function evaluateEffectivenessOnExit(
	state: SessionMonitorState,
	exitCode: number,
	logger: { debug: (msg: string, category: string, meta?: Record<string, unknown>) => void }
): Promise<void> {
	try {
		const { getInjectionRecord, clearSessionInjection } = await import('../memory/memory-injector');
		const record = getInjectionRecord(state.sessionId);
		if (!record || record.ids.length === 0) return;

		const { EffectivenessEvaluator } = await import('../memory/effectiveness-evaluator');
		const { getMemoryStore } = await import('../memory/memory-store');

		// Gather signals from accumulated monitor state
		const totalErrors = Array.from(state.errorCounts.values()).reduce((s, c) => s + c, 0);
		const completed = exitCode === 0;
		const cancelled = exitCode !== 0 && exitCode !== null;

		// Check for git diff (code changes produced)
		let gitDiffProduced = false;
		try {
			const { execFile } = await import('child_process');
			const { promisify } = await import('util');
			const execFileAsync = promisify(execFile);
			const result = await execFileAsync('git', ['diff', '--stat', 'HEAD'], {
				cwd: state.projectPath,
				timeout: 5000,
			});
			gitDiffProduced = (result.stdout ?? '').trim().length > 0;
		} catch {
			// Git unavailable or not a repo — assume no diff
		}

		const signals: import('../../shared/memory-types').SessionOutcomeSignals = {
			completed,
			cancelled,
			errorCount: totalErrors,
			resolvedErrorCount: 0, // Not tracked granularly yet — conservative default
			gitDiffProduced,
			contextUtilization: state.lastContextUsage / 100, // Convert 0-100 to 0.0-1.0
			turnCount: state.turnIndex,
			durationMs:
				Date.now() -
				(state.currentTurnStartedAt > 0
					? state.currentTurnStartedAt - (state.turnIndex > 0 ? 0 : 0)
					: Date.now()),
		};

		// Use session start approximation: first turn started at some point
		// Duration is best-effort since we don't track exact session start
		if (state.turnIndex > 0 && state.currentTurnStartedAt > 0) {
			// Approximate: we know the last turn start, but not session start
			// Use a rough estimate based on turn count
			signals.durationMs = state.turnIndex * 30_000; // ~30s per turn average
		}

		const evaluator = new EffectivenessEvaluator();
		const updates = evaluator.evaluateSession(state.sessionId, record, signals);

		if (updates.length === 0) return;

		const store = getMemoryStore();

		// Group updates by scope+skillAreaId for batch updateEffectiveness calls
		const groups = new Map<
			string,
			{ ids: string[]; score: number; scope: string; skillAreaId?: string }
		>();
		for (const update of updates) {
			const key = update.scope === 'skill' ? `skill:${update.skillAreaId}` : update.scope;
			let group = groups.get(key);
			if (!group) {
				group = {
					ids: [],
					score: update.outcomeScore,
					scope: update.scope,
					skillAreaId: update.skillAreaId,
				};
				groups.set(key, group);
			}
			group.ids.push(update.memoryId);
		}

		for (const group of groups.values()) {
			await store.updateEffectiveness(
				group.ids,
				group.score,
				group.scope as import('../../shared/memory-types').MemoryScope,
				group.skillAreaId,
				state.projectPath
			);
		}

		const avgScore = updates.reduce((sum, u) => sum + u.outcomeScore, 0) / updates.length;

		logger.debug(
			`[memory-effectiveness] Session ${state.sessionId}: updated effectiveness for ${updates.length} memories (avg score: ${avgScore.toFixed(2)})`,
			'MemoryEffectiveness',
			{
				sessionId: state.sessionId,
				memoryCount: updates.length,
				avgScore: avgScore.toFixed(2),
				exitCode,
				signals: {
					completed: signals.completed,
					cancelled: signals.cancelled,
					errorCount: signals.errorCount,
					gitDiffProduced: signals.gitDiffProduced,
					contextUtilization: signals.contextUtilization.toFixed(2),
					turnCount: signals.turnCount,
				},
			}
		);

		// Clean up injection record now that effectiveness has been evaluated
		clearSessionInjection(state.sessionId);
	} catch {
		// Non-critical — effectiveness evaluation is best-effort
	}
}

// ─── Memory Monitor Constants ──────────────────────────────────────────────

/** Common agent tools that don't indicate a novel domain */
const COMMON_TOOLS = new Set(['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'Task']);

/** Domain-shift pattern from EXP-LIVE-03 directives */
const DOMAIN_SHIFT_REGEX = /\[domain-shift:\s*(.+?)\]/;

/** Default accessors that lazy-import memory modules at runtime */
async function defaultGetMemoryAccessors(): Promise<MemoryModuleAccessors | null> {
	try {
		const memStore = await import('../memory/memory-store');
		const { getLiveContextQueue } = await import('../memory/live-context-queue');
		const rawStore = memStore.getMemoryStore();
		return {
			getMemoryStore: () => ({
				getConfig: () => rawStore.getConfig() as unknown as Promise<Record<string, unknown>>,
				cascadingSearch: (q: string, c: unknown, a: string, p?: string) =>
					rawStore.cascadingSearch(q, c as never, a, p),
				selectMatchingPersonas: (q: string, c: unknown, a: string, p?: string) =>
					rawStore.selectMatchingPersonas(q, c as never, a, p),
			}),
			getLiveContextQueue: getLiveContextQueue as unknown as () => LiveQueueAccessor,
		};
	} catch {
		return null;
	}
}

/**
 * Summarize tool input for compact display in the tool execution log.
 * Inspired by claude-subconscious transcript_utils — shows just enough
 * to reconstruct the operational sequence.
 */
export function summarizeToolInput(toolName: string, state: unknown): string {
	if (!state || typeof state !== 'object') return '';
	const s = state as Record<string, unknown>;

	switch (toolName) {
		case 'Read':
		case 'Write':
		case 'Edit':
			return String(s.file_path ?? s.filePath ?? '');
		case 'Bash':
			return String(s.command ?? '').slice(0, 150);
		case 'Grep':
			return `${String(s.pattern ?? '')} ${String(s.path ?? '')}`.trim();
		case 'Glob':
			return `${String(s.pattern ?? '')} ${String(s.path ?? '')}`.trim();
		case 'Agent':
			return String(s.description ?? '');
		case 'WebFetch':
			return String(s.url ?? '');
		default: {
			try {
				return JSON.stringify(s).slice(0, 100);
			} catch {
				return '';
			}
		}
	}
}

/** Module-level ref to sessionStates for the accessor */
let _sessionStatesRef: Map<string, SessionMonitorState> | null = null;

/**
 * Get the accumulated per-turn tool execution log for a session.
 * Used by gatherRichSessionData() in experience-analyzer.ts (MEM-EVOLVE-05).
 */
export function getSessionToolLog(sessionId: string): TurnToolLog[] | null {
	if (!_sessionStatesRef) return null;
	const state = _sessionStatesRef.get(sessionId);
	if (!state) return null;
	return state.sessionToolLog.length > 0 ? state.sessionToolLog : null;
}

export function setupMemoryMonitorListener(
	processManager: ProcessManager,
	deps: Pick<ProcessListenerDependencies, 'logger' | 'patterns'>,
	memoryAccessors?: MemoryModuleAccessors
): void {
	const sessionStates = new Map<string, SessionMonitorState>();
	_sessionStatesRef = sessionStates;
	const { logger, patterns } = deps;
	const { REGEX_BATCH_SESSION, REGEX_SYNOPSIS_SESSION } = patterns;

	function shouldMonitor(sessionId: string): boolean {
		if (sessionId.startsWith(GROUP_CHAT_PREFIX)) return false;
		if (REGEX_BATCH_SESSION.test(sessionId)) return false;
		if (REGEX_SYNOPSIS_SESSION.test(sessionId)) return false;
		return true;
	}

	function getState(sessionId: string): SessionMonitorState | null {
		if (!shouldMonitor(sessionId)) return null;
		let state = sessionStates.get(sessionId);
		if (!state) {
			const proc = processManager.get(sessionId);
			if (!proc?.projectPath) return null;
			state = {
				sessionId,
				agentType: proc.toolType || 'unknown',
				projectPath: proc.projectPath,
				lastContextUsage: 0,
				lastContextWindow: 200000,
				errorCounts: new Map(),
				lastErrorAt: 0,
				toolDomains: new Set(),
				lastSearchAt: 0,
				effectiveBudget: 750,
				turnIndex: 0,
				currentTurnStartedAt: 0,
				currentTurnToolExecutions: [],
				currentTurnErrors: [],
				currentTurnUsage: null,
				annotationCountAtTurnStart: 0,
				manifestCountAtTurnStart: 0,
				perTurnExtractionCount: 0,
				lastPerTurnExtractionAt: 0,
				initialPersonaMatch: null,
				lastPersonaEvalTurnIndex: 0,
				lastPersonaEvalAt: 0,
				checkpointInjectionCount: 0,
				checkpointCooldowns: new Map(),
				contextPressureFired: false,
				checkpointEvents: [],
				sessionToolLog: [],
			};
			sessionStates.set(sessionId, state);

			// Log checkpoint availability per agent type
			if (CHECKPOINT_CAPABLE_AGENTS.has(state.agentType)) {
				logger.debug(
					`[MemoryMonitor] Checkpoint injection available for ${state.agentType}`,
					'MemoryMonitor',
					{ sessionId }
				);
			} else {
				logger.debug(
					`[MemoryMonitor] Checkpoint injection not available for ${state.agentType}, falling back to periodic`,
					'MemoryMonitor',
					{ sessionId }
				);
			}
		}
		return state;
	}

	async function triggerMemorySearch(
		state: SessionMonitorState,
		query: string,
		source: 'monitoring'
	): Promise<void> {
		const now = Date.now();

		try {
			const accessors = memoryAccessors ?? (await defaultGetMemoryAccessors());
			if (!accessors) return;

			const store = accessors.getMemoryStore();
			const config = await store.getConfig();

			if (!config.enableLiveInjection) return;

			const cooldownSeconds = (config.liveSearchCooldownSeconds as number | undefined) ?? 60;
			const cooldownMs = cooldownSeconds * 1000;
			if (now - state.lastSearchAt < cooldownMs) return;

			state.lastSearchAt = now;

			const results = await store.cascadingSearch(
				query,
				config,
				state.agentType,
				state.projectPath
			);
			if (!results || results.length === 0) return;

			// Enqueue into LiveContextQueue if available (EXP-LIVE-01)
			try {
				const queue = accessors.getLiveContextQueue();

				const topResults = results.slice(0, 5);
				const memoryIds = topResults.map((r) => r.entry.id).filter(Boolean);

				// Resolve injector — from accessor (test-injectable) or lazy import (production)
				let injector: InjectorAccessor | undefined;
				if (accessors.getInjector) {
					injector = accessors.getInjector();
				} else {
					try {
						const mod = await import('../memory/memory-injector');
						injector = {
							getInjectionRecord: mod.getInjectionRecord,
							generateDiffInjection: mod.generateDiffInjection,
							recordSessionInjection: mod.recordSessionInjection,
							hashContent: mod.hashContent,
						};
					} catch {
						// memory-injector not available — fall through to non-diff path
					}
				}

				let content: string;
				let tokenEstimate: number;
				let hasDiff = false;

				const previousRecord = injector?.getInjectionRecord(state.sessionId);

				if (injector && previousRecord && previousRecord.contentHashes.size > 0) {
					// Diff-based injection (MEM-EVOLVE-02)
					const diff = injector.generateDiffInjection(topResults, previousRecord);

					if (diff.injectedPrompt === '') {
						// Nothing changed — skip enqueue entirely
						return;
					}

					content = diff.injectedPrompt;
					tokenEstimate = diff.tokenCount;
					hasDiff = true;

					// Track token savings
					const fullLines = topResults.map(
						(r) => `- (${r.entry.type ?? 'experience'}) ${r.entry.content}`
					);
					const fullTokens = Math.ceil(fullLines.join('\n').length / 4);
					const savedTokens = fullTokens - diff.tokenCount;
					if (savedTokens > 0) {
						previousRecord.totalTokensSaved += savedTokens;
					}

					// Merge injection record: keep unchanged + add new - remove old
					const mergedIds = [
						...previousRecord.ids.filter((id) => !diff.removedIds.includes(id)),
						...diff.addedIds,
					];
					injector.recordSessionInjection(
						state.sessionId,
						mergedIds,
						previousRecord.scopeGroups,
						topResults,
						undefined,
						'live',
						state.turnIndex
					);
				} else {
					// First mid-session injection — full format
					const lines = topResults.map(
						(r) => `- (${r.entry.type ?? 'experience'}) ${r.entry.content}`
					);
					content = lines.join('\n');
					tokenEstimate = Math.ceil(content.length / 4);

					// Record for future diff comparisons
					if (injector) {
						injector.recordSessionInjection(
							state.sessionId,
							memoryIds,
							[],
							topResults,
							undefined,
							'live',
							state.turnIndex
						);
					}
				}

				queue.enqueue(state.sessionId, content, source, tokenEstimate, memoryIds, hasDiff);
			} catch {
				// LiveContextQueue not available yet (EXP-LIVE-01) — skip enqueue
			}

			logger.debug('[MemoryMonitor] Triggered memory search', 'MemoryMonitor', {
				sessionId: state.sessionId,
				query: query.slice(0, 100),
				resultCount: Math.min(results.length, 5),
				source,
			});
		} catch (err) {
			logger.debug('[MemoryMonitor] Search failed (non-critical)', 'MemoryMonitor', {
				error: String(err),
			});
		}
	}

	// ── Checkpoint injection helpers ──

	/** Agents that support rich checkpoint events (result, tool, error parsing) */
	const CHECKPOINT_CAPABLE_AGENTS = new Set(['claude-code', 'codex', 'opencode', 'factory-droid']);

	/** Default cooldowns per checkpoint type (ms) */
	const CHECKPOINT_COOLDOWN_MAP: Record<CheckpointEventType, number> = {
		'first-error': 0, // critical — bypass cooldown
		'context-pressure': 0, // critical — bypass cooldown
		'query-complete': 120_000, // standard — 2 min
		'new-tool-domain': 120_000, // standard — 2 min
		'domain-shift': 120_000, // standard — 2 min
		'persona-shift': 120_000, // standard — 2 min
		'periodic-refresh': 300_000, // low — 5 min
	};

	const CHECKPOINT_PRIORITY_MAP: Record<CheckpointEventType, CheckpointPriority> = {
		'first-error': 'critical',
		'context-pressure': 'critical',
		'query-complete': 'standard',
		'new-tool-domain': 'standard',
		'domain-shift': 'standard',
		'persona-shift': 'standard',
		'periodic-refresh': 'low',
	};

	/**
	 * Trigger a checkpoint-style memory injection. Respects per-type cooldowns,
	 * per-session caps, and priority levels. Uses diff-based injection when
	 * previous injections exist.
	 */
	async function triggerCheckpointSearch(
		state: SessionMonitorState,
		eventType: CheckpointEventType,
		query: string,
		budgetOverride?: number
	): Promise<void> {
		const now = Date.now();
		const priority = CHECKPOINT_PRIORITY_MAP[eventType];

		try {
			const accessors = memoryAccessors ?? (await defaultGetMemoryAccessors());
			if (!accessors) return;

			const store = accessors.getMemoryStore();
			const config = await store.getConfig();

			if (!config.enableCheckpointInjection) return;
			if (!config.enableLiveInjection) return;

			// Per-session cap
			const maxPerSession = (config.checkpointMaxPerSession as number | undefined) ?? 5;
			if (state.checkpointInjectionCount >= maxPerSession) return;

			// Per-type cooldown (critical bypasses)
			if (priority !== 'critical') {
				const cooldownMs =
					(config.checkpointCooldownSeconds as number | undefined) !== undefined
						? (config.checkpointCooldownSeconds as number) * 1000
						: CHECKPOINT_COOLDOWN_MAP[eventType];
				const lastFired = state.checkpointCooldowns.get(eventType) ?? 0;
				if (now - lastFired < cooldownMs) return;
			}

			// Budget check
			if (state.effectiveBudget === 0 && priority !== 'critical') return;

			state.checkpointCooldowns.set(eventType, now);

			const effectiveBudget = budgetOverride ?? state.effectiveBudget;

			const results = await store.cascadingSearch(
				query,
				config,
				state.agentType,
				state.projectPath
			);
			if (!results || results.length === 0) return;

			// Enqueue via LiveContextQueue with diff support
			try {
				const queue = accessors.getLiveContextQueue();
				const topResults = results.slice(0, 5);
				const memoryIds = topResults.map((r) => r.entry.id).filter(Boolean);

				// Resolve injector
				let injector: InjectorAccessor | undefined;
				if (accessors.getInjector) {
					injector = accessors.getInjector();
				} else {
					try {
						const mod = await import('../memory/memory-injector');
						injector = {
							getInjectionRecord: mod.getInjectionRecord,
							generateDiffInjection: mod.generateDiffInjection,
							recordSessionInjection: mod.recordSessionInjection,
							hashContent: mod.hashContent,
						};
					} catch {
						// memory-injector not available
					}
				}

				let content: string;
				let tokenEstimate: number;
				let hasDiff = false;

				const previousRecord = injector?.getInjectionRecord(state.sessionId);

				if (injector && previousRecord && previousRecord.contentHashes.size > 0) {
					const diff = injector.generateDiffInjection(topResults, previousRecord);
					if (diff.injectedPrompt === '') return; // nothing changed

					content = diff.injectedPrompt;
					tokenEstimate = diff.tokenCount;
					hasDiff = true;

					// Token savings tracking
					const fullLines = topResults.map(
						(r) => `- (${r.entry.type ?? 'experience'}) ${r.entry.content}`
					);
					const fullTokens = Math.ceil(fullLines.join('\n').length / 4);
					const savedTokens = fullTokens - diff.tokenCount;
					if (savedTokens > 0) {
						previousRecord.totalTokensSaved += savedTokens;
					}

					const mergedIds = [
						...previousRecord.ids.filter((id) => !diff.removedIds.includes(id)),
						...diff.addedIds,
					];
					injector.recordSessionInjection(
						state.sessionId,
						mergedIds,
						previousRecord.scopeGroups,
						topResults,
						undefined,
						'checkpoint',
						state.turnIndex
					);
				} else {
					const lines = topResults.map(
						(r) => `- (${r.entry.type ?? 'experience'}) ${r.entry.content}`
					);
					content = lines.join('\n');
					tokenEstimate = Math.ceil(content.length / 4);

					if (injector) {
						injector.recordSessionInjection(
							state.sessionId,
							memoryIds,
							[],
							topResults,
							undefined,
							'checkpoint',
							state.turnIndex
						);
					}
				}

				// Enforce budget
				if (tokenEstimate > effectiveBudget && effectiveBudget > 0) {
					content = content.slice(0, effectiveBudget * 4);
					tokenEstimate = effectiveBudget;
				}

				queue.enqueue(
					state.sessionId,
					content,
					`checkpoint:${eventType}`,
					tokenEstimate,
					memoryIds,
					hasDiff
				);

				state.checkpointInjectionCount++;

				// Record event for UI (local state)
				state.checkpointEvents.push({
					timestamp: now,
					sessionId: state.sessionId,
					triggerType: eventType,
					priority,
					searchQuery: query.slice(0, 200),
					resultCount: topResults.length,
					tokenEstimate,
					usedDiff: hasDiff,
				});

				// Record in the global injection event ring buffer for StatusTab display
				try {
					const { pushInjectionEvent } = await import('../memory/memory-injector');
					pushInjectionEvent({
						sessionId: state.sessionId,
						memoryIds,
						tokenCount: tokenEstimate,
						timestamp: now,
						scopeGroups: [],
						checkpointType: eventType,
					});
				} catch {
					// memory-injector not available
				}

				logger.debug('[MemoryMonitor] Checkpoint injection triggered', 'MemoryMonitor', {
					sessionId: state.sessionId,
					eventType,
					priority,
					query: query.slice(0, 100),
					resultCount: topResults.length,
					count: `${state.checkpointInjectionCount}/${maxPerSession}`,
					hasDiff,
				});
			} catch {
				// LiveContextQueue not available
			}
		} catch (err) {
			logger.debug('[MemoryMonitor] Checkpoint search failed (non-critical)', 'MemoryMonitor', {
				error: String(err),
			});
		}
	}

	// ── Event handlers ──

	// 1. Usage event: track context utilization, adjust budget
	processManager.on('usage', (sessionId: string, usageStats: UsageStats) => {
		const state = getState(sessionId);
		if (!state) return;

		const totalTokens = usageStats.inputTokens + usageStats.outputTokens;
		const window = usageStats.contextWindow > 0 ? usageStats.contextWindow : 200000;
		if (totalTokens > window) return; // Accumulated multi-tool — skip

		state.lastContextUsage = Math.round((totalTokens / window) * 100);
		state.lastContextWindow = window;

		if (state.lastContextUsage > 90) {
			state.effectiveBudget = 0;
		} else if (state.lastContextUsage > 70) {
			state.effectiveBudget = 300;
		} else {
			state.effectiveBudget = 750;
		}

		// Per-turn accumulator: store latest usage stats
		state.currentTurnUsage = usageStats;

		// Checkpoint: context pressure at 60% — proactively inject critical memories
		if (
			state.lastContextUsage >= 60 &&
			!state.contextPressureFired &&
			CHECKPOINT_CAPABLE_AGENTS.has(state.agentType)
		) {
			state.contextPressureFired = true;
			triggerCheckpointSearch(
				state,
				'context-pressure',
				`critical context for ${state.projectPath}`,
				300 // reduced budget for context-constrained injection
			).catch(() => {});
		}
	});

	// 2. Error event: track error counts, trigger on repeated errors + first-error checkpoint
	processManager.on('agent-error', (sessionId: string, error: AgentError) => {
		const state = getState(sessionId);
		if (!state) return;

		const errorType = error.type || 'unknown';
		const count = (state.errorCounts.get(errorType) || 0) + 1;
		state.errorCounts.set(errorType, count);
		state.lastErrorAt = Date.now();

		// Per-turn accumulator: track errors for interestingness scoring
		state.currentTurnErrors.push(error);

		if (state.effectiveBudget === 0) return;

		// Checkpoint: first error in session — critical priority
		if (count === 1 && CHECKPOINT_CAPABLE_AGENTS.has(state.agentType)) {
			const query = error.message || errorType;
			triggerCheckpointSearch(state, 'first-error', query).catch(() => {});
		}

		// Existing: repeated error trigger (2nd occurrence)
		if (count === 2) {
			const query = error.message || errorType;
			triggerMemorySearch(state, query, 'monitoring').catch(() => {});
		}
	});

	// 3. Tool execution event: track tool domains, trigger on new domain
	processManager.on('tool-execution', (sessionId: string, toolExec: ToolExecution) => {
		const state = getState(sessionId);
		if (!state) return;

		// Per-turn accumulator: track tool executions for interestingness scoring
		state.currentTurnToolExecutions.push(toolExec);

		if (state.effectiveBudget === 0) return;

		const toolName = toolExec.toolName;
		if (!toolName) return;

		if (!state.toolDomains.has(toolName)) {
			state.toolDomains.add(toolName);

			if (!COMMON_TOOLS.has(toolName)) {
				triggerMemorySearch(state, toolName, 'monitoring').catch(() => {});
			}
		}
	});

	// 4. Data event: detect domain-shift signals in agent output
	processManager.on('data', (sessionId: string, data: string) => {
		const state = getState(sessionId);
		if (!state) return;
		if (state.effectiveBudget === 0) return;

		const domainShiftMatch = data.match(DOMAIN_SHIFT_REGEX);
		if (domainShiftMatch) {
			const domain = domainShiftMatch[1];
			logger.debug('[MemoryMonitor] Domain shift detected', 'MemoryMonitor', {
				sessionId,
				domain,
			});
			triggerMemorySearch(state, domain, 'monitoring').catch(() => {});
		}
	});

	// 4b. Checkpoint: query-complete — agent finished responding, good time to inject
	//     memories before the user's next message. Uses the agent's response summary
	//     as search context.
	processManager.on('query-complete', (sessionId: string, _data: QueryCompleteData) => {
		const state = getState(sessionId);
		if (!state) return;
		if (!CHECKPOINT_CAPABLE_AGENTS.has(state.agentType)) return;

		// Only fire after the first few turns when there's meaningful context
		if (state.turnIndex < 2) return;

		// Use project path as a generic query — the cascading search will
		// match against recent session context
		const query = `recent experiences for ${state.projectPath}`;
		triggerCheckpointSearch(state, 'query-complete', query).catch(() => {});
	});

	// 5. Persona shift re-evaluation: run selectMatchingPersonas periodically
	//    and detect when a different persona becomes more relevant mid-session.
	const PERSONA_EVAL_TURN_INTERVAL = 5;
	const PERSONA_EVAL_TIME_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
	const PERSONA_SHIFT_MARGIN = 0.1;

	async function evaluatePersonaShift(
		state: SessionMonitorState,
		turnContext: string,
		turnIndex: number
	): Promise<void> {
		const now = Date.now();

		// Performance guard: only re-evaluate every N turns or M minutes
		const turnsSinceLastEval = turnIndex - state.lastPersonaEvalTurnIndex;
		const timeSinceLastEval = now - state.lastPersonaEvalAt;
		if (
			turnsSinceLastEval < PERSONA_EVAL_TURN_INTERVAL &&
			timeSinceLastEval < PERSONA_EVAL_TIME_INTERVAL_MS
		) {
			return;
		}

		try {
			let accessors_ = memoryAccessors;
			if (!accessors_) {
				const resolved = await defaultGetMemoryAccessors();
				if (!resolved) return;
				accessors_ = resolved;
			}

			const store = accessors_.getMemoryStore();
			const config = await store.getConfig();
			if (!config.enabled) return;

			const matches = await store.selectMatchingPersonas(
				turnContext,
				config,
				state.agentType,
				state.projectPath
			);

			state.lastPersonaEvalTurnIndex = turnIndex;
			state.lastPersonaEvalAt = now;

			if (matches.length === 0) return;

			const topMatch = matches.reduce((best, m) => (m.similarity > best.similarity ? m : best));

			// Set initial persona on first evaluation
			if (!state.initialPersonaMatch) {
				state.initialPersonaMatch = {
					id: topMatch.persona.id,
					name: topMatch.personaName,
					score: topMatch.similarity,
				};
				logger.debug('[MemoryMonitor] Initial persona match set', 'MemoryMonitor', {
					sessionId: state.sessionId,
					personaId: topMatch.persona.id,
					personaName: topMatch.personaName,
					score: topMatch.similarity.toFixed(3),
				});
				return;
			}

			// Check if a different persona now has a higher score by the margin threshold
			if (
				topMatch.persona.id !== state.initialPersonaMatch.id &&
				topMatch.similarity > state.initialPersonaMatch.score + PERSONA_SHIFT_MARGIN
			) {
				const { pushPersonaShiftEvent, setSessionLastPersona } =
					await import('../memory/memory-injector');
				pushPersonaShiftEvent({
					timestamp: now,
					sessionId: state.sessionId,
					fromPersona: { ...state.initialPersonaMatch },
					toPersona: {
						id: topMatch.persona.id,
						name: topMatch.personaName,
						score: topMatch.similarity,
					},
					triggerContext: turnContext.slice(0, 500),
				});
				BrowserWindow.getAllWindows().forEach((win) => {
					if (isWebContentsAvailable(win)) {
						win.webContents.send('memory:personaChanged', {
							type: 'shift',
							sessionId: state.sessionId,
							fromPersona: { ...state.initialPersonaMatch },
							toPersona: {
								id: topMatch.persona.id,
								name: topMatch.personaName,
								score: topMatch.similarity,
							},
							timestamp: now,
						});
					}
				});

				logger.debug(
					'[MemoryMonitor] Persona shift detected — triggering checkpoint injection',
					'MemoryMonitor',
					{
						sessionId: state.sessionId,
						from: state.initialPersonaMatch.name,
						to: topMatch.personaName,
						scoreDelta: (topMatch.similarity - state.initialPersonaMatch.score).toFixed(3),
					}
				);

				// Update the per-session last persona tracker so pre-spawn detection stays in sync
				setSessionLastPersona(state.sessionId, {
					id: topMatch.persona.id,
					name: topMatch.personaName,
					score: topMatch.similarity,
				});

				// Update baseline to the new persona so we detect further shifts
				state.initialPersonaMatch = {
					id: topMatch.persona.id,
					name: topMatch.personaName,
					score: topMatch.similarity,
				};

				// Trigger a checkpoint injection with the new persona's context.
				// cascadingSearch will naturally match the new best persona and pull
				// its memories, giving the agent updated knowledge mid-session.
				// Gated by enableLivePersonaShift — user can disable mid-session shifts.
				if (config.enableLivePersonaShift) {
					triggerCheckpointSearch(state, 'persona-shift', turnContext).catch(() => {
						// Non-critical — persona shift is best-effort
					});
				}
			}
		} catch (err) {
			logger.debug('[MemoryMonitor] Persona shift evaluation failed', 'MemoryMonitor', {
				sessionId: state.sessionId,
				error: String(err),
			});
		}
	}

	// 6. Per-turn tracking: subscribe to turn-start and turn-complete events
	import('../memory/turn-tracker')
		.then(({ getTurnTracker }) => {
			const turnTracker = getTurnTracker();

			// On turn-start: reset accumulators, snapshot VIBES counts
			turnTracker.on('turn-start', ({ sessionId }: { sessionId: string }) => {
				const state = sessionStates.get(sessionId);
				if (!state) return;

				state.currentTurnStartedAt = Date.now();
				state.currentTurnToolExecutions = [];
				state.currentTurnErrors = [];
				state.currentTurnUsage = null;

				// Snapshot VIBES file sizes for delta tracking
				snapshotVibesCounts(state).catch(() => {});
			});

			// On turn-complete: compute signals, score interestingness, maybe enqueue extraction
			turnTracker.on(
				'turn-complete',
				async ({
					sessionId,
					entry,
					turnIndex,
				}: {
					sessionId: string;
					entry: HistoryEntry;
					turnIndex: number;
				}) => {
					const state = sessionStates.get(sessionId);
					if (!state) return;

					state.turnIndex = turnIndex;

					// Accumulate per-turn tool log for rich extraction (MEM-EVOLVE-05)
					if (state.currentTurnToolExecutions.length > 0 || state.currentTurnErrors.length > 0) {
						const turnLog: TurnToolLog = {
							turnIndex,
							startedAt: state.currentTurnStartedAt || Date.now(),
							tools: state.currentTurnToolExecutions.map((te) => ({
								name: te.toolName,
								input: summarizeToolInput(te.toolName, te.state),
								success: true, // ToolExecution doesn't track failure; errors captured separately
								durationMs: 0, // ToolExecution doesn't track duration
							})),
							errors: state.currentTurnErrors.map((e) => e.message || String(e)),
						};
						state.sessionToolLog.push(turnLog);
						// Cap at 50 turns to prevent memory bloat
						if (state.sessionToolLog.length > 50) {
							state.sessionToolLog = state.sessionToolLog.slice(-50);
						}
					}

					// Skip excluded session types (same exclusions as existing monitor)
					if (sessionId.startsWith(GROUP_CHAT_PREFIX)) return;
					if (/batch-\d+$/.test(sessionId)) return;
					if (/synopsis-\d+$/.test(sessionId)) return;

					// Persona shift re-evaluation (fire-and-forget, best-effort)
					const turnContext = entry.summary || entry.fullResponse?.slice(0, 500) || '';
					if (turnContext.length > 0) {
						evaluatePersonaShift(state, turnContext, turnIndex).catch(() => {});
					}

					// Check config
					try {
						let accessors_ = memoryAccessors;
						if (!accessors_) {
							const resolved = await defaultGetMemoryAccessors();
							if (!resolved) return;
							accessors_ = resolved;
						}

						const store = accessors_.getMemoryStore();
						const config = await store.getConfig();
						if (
							!config.enabled ||
							!config.enableExperienceExtraction ||
							!config.enablePerTurnExtraction
						) {
							logger.debug(
								'[MemoryMonitor] Per-turn extraction disabled by config',
								'MemoryMonitor',
								{
									enabled: config.enabled,
									experienceExtraction: config.enableExperienceExtraction,
									perTurnExtraction: config.enablePerTurnExtraction,
								}
							);
							return;
						}

						// Check per-session extraction cap
						const maxExtractions =
							(config.perTurnMaxExtractionsPerSession as number | undefined) ?? 10;
						if (state.perTurnExtractionCount >= maxExtractions) {
							logger.debug('[MemoryMonitor] Per-turn extraction cap reached', 'MemoryMonitor', {
								sessionId: state.sessionId,
								count: state.perTurnExtractionCount,
								max: maxExtractions,
							});
							return;
						}

						// Check per-session cooldown
						const cooldownMs = ((config.perTurnCooldownSeconds as number | undefined) ?? 60) * 1000;
						if (Date.now() - state.lastPerTurnExtractionAt < cooldownMs) {
							logger.debug('[MemoryMonitor] Per-turn extraction in cooldown', 'MemoryMonitor', {
								sessionId: state.sessionId,
								remaining: cooldownMs - (Date.now() - state.lastPerTurnExtractionAt),
							});
							return;
						}

						// Check high context usage (same guard as existing monitor)
						if (state.lastContextUsage > 90) return;

						// Compute VIBES deltas
						const vibesDeltas = await computeVibesDeltas(state);

						// Build turn signals and score
						const turnDurationMs =
							state.currentTurnStartedAt > 0
								? Date.now() - state.currentTurnStartedAt
								: (entry.elapsedTimeMs ?? 0);

						const signals = {
							turnDurationMs,
							errors: state.currentTurnErrors,
							toolExecutions: state.currentTurnToolExecutions,
							usage: state.currentTurnUsage,
							vibesAnnotationsDelta: vibesDeltas.annotationsDelta,
							vibesManifestDelta: vibesDeltas.manifestDelta,
							turnIndex,
							entrySuccess: entry.success,
						};

						const score = scoreTurnInterestingness(signals);
						const threshold =
							(config.perTurnInterestingnessThreshold as number | undefined) ?? 0.25;

						logger.debug('[MemoryMonitor] Turn interestingness scored', 'MemoryMonitor', {
							sessionId: state.sessionId,
							turnIndex,
							score: score.toFixed(2),
							threshold: threshold.toFixed(2),
							passed: score >= threshold,
						});

						if (score < threshold) return;

						// Enqueue per-turn extraction
						const { getMemoryJobQueue } = await import('../memory/memory-job-queue');
						getMemoryJobQueue().enqueue({
							type: 'experience-extraction',
							priority: 4,
							payload: {
								sessionId: state.sessionId,
								projectPath: state.projectPath,
								agentType: state.agentType,
								trigger: 'per-turn',
								turnIndex,
								interestScore: score,
								historyEntry: {
									summary: entry.summary,
									fullResponse: entry.fullResponse?.slice(0, 1500),
									success: entry.success,
									elapsedTimeMs: entry.elapsedTimeMs,
								},
								vibesAnnotationsDelta: vibesDeltas.annotationsDelta,
								vibesManifestDelta: vibesDeltas.manifestDelta,
							},
						});

						// Update per-turn tracking state
						state.perTurnExtractionCount++;
						state.lastPerTurnExtractionAt = Date.now();

						logger.debug('[MemoryMonitor] Per-turn extraction enqueued', 'MemoryMonitor', {
							sessionId: state.sessionId,
							turnIndex,
							score: score.toFixed(2),
						});
					} catch {
						// Non-critical — extraction will happen on exit
					}
				}
			);
		})
		.catch(() => {
			// TurnTracker not available — per-turn extraction won't work
		});

	// 7. Periodic trigger: check via interval for write-count based refreshes
	// Also triggers mid-session experience extraction at every 10th write
	const midSessionCheckpoints = new Set<string>(); // tracks "sessionId:checkpoint" keys
	const periodicInterval = setInterval(async () => {
		for (const [, state] of sessionStates) {
			if (state.effectiveBudget === 0) continue;

			try {
				let accessors_ = memoryAccessors;
				if (!accessors_) {
					const resolved = await defaultGetMemoryAccessors();
					if (!resolved) continue;
					accessors_ = resolved;
				}

				const queue = accessors_.getLiveContextQueue();
				const writeCount = queue.getWriteCount(state.sessionId);

				// Memory search refresh at every 5th write
				if (writeCount > 0 && writeCount % 5 === 0) {
					const now = Date.now();
					if (now - state.lastSearchAt >= 60000) {
						triggerMemorySearch(
							state,
							`recent experiences for ${state.projectPath}`,
							'monitoring'
						).catch(() => {});
					}
				}

				// Mid-session experience extraction at every 10th write
				if (writeCount >= 10 && writeCount % 10 === 0) {
					const checkpoint = `${state.sessionId}:mid:${Math.floor(writeCount / 10)}`;
					if (!midSessionCheckpoints.has(checkpoint)) {
						midSessionCheckpoints.add(checkpoint);
						// Fire-and-forget: check config + enqueue extraction job
						(async () => {
							try {
								const store = accessors_.getMemoryStore();
								const config = await store.getConfig();
								if (!config.enabled || !config.enableExperienceExtraction) return;
								// Skip mid-session extraction when per-turn extraction handles it
								if (config.enablePerTurnExtraction) return;

								const { getMemoryJobQueue } = await import('../memory/memory-job-queue');
								getMemoryJobQueue().enqueue({
									type: 'experience-extraction',
									priority: 4, // Between exit (3) and retroactive (5)
									payload: {
										sessionId: state.sessionId,
										projectPath: state.projectPath,
										agentType: state.agentType,
										trigger: 'mid-session',
									},
								});
								logger.debug('[MemoryMonitor] Mid-session extraction enqueued', 'MemoryMonitor', {
									sessionId: state.sessionId,
									writeCount,
									checkpoint,
								});
							} catch {
								// Non-critical — extraction will happen on exit
							}
						})();
					}
				}
			} catch {
				// Module not loaded yet — skip
			}
		}
	}, 10000);

	// Keep interval from preventing process exit
	if (periodicInterval.unref) {
		periodicInterval.unref();
	}

	// Cleanup + effectiveness evaluation on exit
	processManager.on('exit', (sessionId: string, code: number) => {
		const state = sessionStates.get(sessionId);

		// Fire-and-forget effectiveness evaluation before cleanup
		if (state) {
			evaluateEffectivenessOnExit(state, code, logger).catch(() => {});
		}

		sessionStates.delete(sessionId);
		// Clean up mid-session checkpoint entries for this session
		for (const key of midSessionCheckpoints) {
			if (key.startsWith(`${sessionId}:`)) {
				midSessionCheckpoints.delete(key);
			}
		}
	});
}
