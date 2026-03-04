/**
 * ExperienceAnalyzer — LLM-powered session analysis for automatic experience extraction (Strategy 2).
 *
 * Singleton service that runs after session completion. Gathers session data
 * (history entries, git diffs, VIBES audit data, stats) and feeds it to an LLM
 * to extract discrete, novel learnings. Extracted experiences are deduplicated
 * against existing memories and stored with cascading skill area placement.
 *
 * Key behaviors:
 * - Rate-limited: max 1 analysis per 5 minutes per project (configurable)
 * - Non-blocking: never blocks session cleanup
 * - Graceful degradation: tolerates missing data sources (no git, no VIBES, etc.)
 */

import type {
	MemoryConfig,
	ExtractionDiagnostic,
	ExtractionProgress,
} from '../../shared/memory-types';
import { MEMORY_CONFIG_DEFAULTS } from '../../shared/memory-types';
import { experienceExtractionPrompt, experienceExtractionTurnPrompt } from '../../prompts';

// ─── Interfaces ──────────────────────────────────────────────────────────────

export interface ExperienceAnalyzerInput {
	/** Session identifier */
	sessionId: string;
	/** Agent type that ran the session */
	agentType: string;
	/** Project path */
	projectPath: string;
	/** Session history entries (summary + fullResponse for each turn) */
	historyEntries: {
		summary: string;
		fullResponse?: string;
		success?: boolean;
		elapsedTimeMs?: number;
	}[];
	/** Git diff from session start to end (truncated to ~4000 chars) */
	gitDiff?: string;
	/** VIBES manifest entries from this session (commands, prompts, reasoning) */
	vibesManifest?: { type: string; content: string }[];
	/** VIBES annotations (files modified, actions taken) */
	vibesAnnotations?: { filePath: string; action: string; lineRange?: string }[];
	/** Total session cost and duration */
	sessionCostUsd?: number;
	sessionDurationMs?: number;
	/** Detected deviations in session history (error→fix, retries, backtracks) */
	detectedDeviations?: DeviationSignal[];
	/** Decision provenance signals extracted from VIBES reasoning traces or history */
	decisionSignals?: DecisionSignal[];
	/** Context utilization % at session end (0.0-1.0) — quality indicator */
	contextUtilizationAtEnd?: number;
	/** Matched persona context — guides extraction perspective */
	personaContext?: {
		personaId: string;
		personaName: string;
		personaSystemPrompt: string;
		roleName: string;
		roleSystemPrompt: string;
	};
}

/** What kind of learning this experience represents */
export type ExperienceCategory =
	| 'pattern-established' // A reusable approach or technique that worked
	| 'problem-solved' // A specific problem encountered and resolved
	| 'dependency-discovered' // A dependency, integration, or wiring requirement found
	| 'anti-pattern-identified' // Something that failed or should be avoided
	| 'decision-made'; // A significant architectural or approach decision

/** Valid category values for runtime validation */
export const EXPERIENCE_CATEGORIES: readonly ExperienceCategory[] = [
	'pattern-established',
	'problem-solved',
	'dependency-discovered',
	'anti-pattern-identified',
	'decision-made',
] as const;

export interface DecisionSignal {
	/** What was decided */
	decision: string;
	/** What alternatives were mentioned */
	alternatives: string[];
	/** Why this choice was made (from reasoning trace) */
	rationale: string;
	/** Source of this signal */
	source: 'vibes' | 'history';
	/** Timestamp of the decision moment */
	timestamp?: number;
}

/** A detected deviation in the session — where the agent had to backtrack, retry, or change approach */
export interface DeviationSignal {
	/** Type of deviation detected */
	type: 'error-fix' | 'backtrack' | 'retry' | 'approach-change';
	/** Which history entry indices are involved */
	entryIndices: number[];
	/** Brief description of what happened */
	description: string;
	/** How many attempts were made (for retries) */
	attemptCount?: number;
}

export interface ExtractedExperience {
	/** The experience content — what was learned */
	content: string;
	/** Brief description of what happened */
	situation: string;
	/** The discrete learning or teaching */
	learning: string;
	/** What kind of learning this experience represents */
	category: ExperienceCategory;
	/** Suggested tags */
	tags: string[];
	/** How novel/important this learning is (0.0-1.0) */
	noveltyScore: number;
	/** What alternatives were considered (required for decision-made) */
	alternativesConsidered?: string;
	/** Why this approach was chosen (required for decision-made) */
	rationale?: string;
	/** Specific technical keywords for retrieval (function names, error codes, etc.) */
	keywords?: string[];
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Extract the text content from a raw VIBES manifest entry.
 * VIBES entries are a tagged union with type-specific text fields
 * (e.g. `prompt_text`, `command_text`, `reasoning_text`).
 */
function extractManifestContent(entry: Record<string, unknown>): string {
	switch (String(entry.type ?? 'unknown')) {
		case 'prompt':
			return String(entry.prompt_text ?? '');
		case 'command': {
			const cmd = String(entry.command_text ?? '');
			return entry.command_output_summary ? `${cmd} -> ${entry.command_output_summary}` : cmd;
		}
		case 'reasoning':
			return String(entry.reasoning_text ?? entry.reasoning_text_compressed ?? '');
		case 'decision':
			return `${entry.decision_point}: chose ${entry.selected} (${entry.rationale})`;
		case 'environment':
			return `${entry.tool_name} / ${entry.model_name}`;
		default:
			return String(entry.content ?? entry.text ?? '');
	}
}

// ─── ExperienceAnalyzer ─────────────────────────────────────────────────────

export class ExperienceAnalyzer {
	/** Per-project cooldown tracking: projectPath → last analysis timestamp */
	private readonly lastAnalysisTime = new Map<string, number>();
	/** Last extraction diagnostic — read by job queue after each run */
	public lastDiagnostic: ExtractionDiagnostic | null = null;

	/**
	 * Analyze a completed session and extract experiences.
	 *
	 * This is the main entry point, called from the exit listener.
	 * Gathers session data, runs LLM analysis, deduplicates results,
	 * and stores experiences in the memory system.
	 *
	 * @param sessionId - The session that just completed
	 * @param projectPath - Project path for the session
	 * @param agentType - Agent type that ran the session
	 * @returns Number of experiences stored (0 if skipped/failed)
	 */
	async analyzeCompletedSession(
		sessionId: string,
		projectPath: string,
		agentType: string,
		trigger: 'exit' | 'retroactive' | 'mid-session' = 'exit',
		onProgress?: (progress: ExtractionProgress) => void
	): Promise<number> {
		const baseDiag: Omit<ExtractionDiagnostic, 'status' | 'message'> = {
			timestamp: Date.now(),
			sessionId,
			agentType,
			projectPath,
			trigger,
		};

		const startedAt = Date.now();
		const emitProgress = (
			stage: ExtractionProgress['stage'],
			message: string,
			extra?: Partial<ExtractionProgress>
		) => {
			onProgress?.({
				stage,
				message,
				startedAt,
				tokensStreamed: 0,
				estimatedTotalTokens: 10000,
				estimatedCostSoFar: 0,
				sessionId,
				...extra,
			});
		};

		// Check if experience extraction is enabled (check first — cheapest guard)
		const config = await this.getMemoryConfig();
		if (config.enableExperienceExtraction === false) {
			this.lastDiagnostic = {
				...baseDiag,
				status: 'skipped-disabled',
				message: 'Experience extraction is disabled in config',
			};
			return 0;
		}

		// Check if already analyzed (prevents duplicate work during retroactive scans,
		// including sessions already covered by per-turn extraction)
		try {
			const { getAnalyzedSessionsRegistry } = await import('./analyzed-sessions');
			const registry = getAnalyzedSessionsRegistry();
			if (await registry.isAnalyzed(sessionId)) {
				// Determine if this was covered by per-turn extraction
				const entry = await registry.getEntry(sessionId);
				const coveredByPerTurn = entry?.trigger === 'per-turn';
				this.lastDiagnostic = {
					...baseDiag,
					status: 'skipped-already-analyzed',
					message: coveredByPerTurn
						? `Session already covered by per-turn extraction`
						: `Session ${sessionId.slice(0, 8)}... already analyzed`,
				};
				return 0;
			}
		} catch {
			// Registry unavailable — proceed without dedup check
		}

		// Check rate limit
		if (await this.isOnCooldown(projectPath)) {
			this.lastDiagnostic = {
				...baseDiag,
				status: 'skipped-cooldown',
				message: `On cooldown for project ${projectPath}`,
			};
			return 0;
		}

		// Gather session data
		emitProgress('gathering', 'Gathering session data...');
		const input = await this.gatherSessionData(sessionId, projectPath, agentType);

		// Check minimum history threshold
		const minEntries = config.minHistoryEntriesForAnalysis ?? 3;
		if (input.historyEntries.length < minEntries) {
			this.lastDiagnostic = {
				...baseDiag,
				status: 'skipped-insufficient-history',
				message: `Only ${input.historyEntries.length} history entries (need ${minEntries})`,
			};
			return 0;
		}

		// Run LLM analysis
		const experiences = await this.analyzeSession(
			input,
			onProgress
				? (tokens, cost, provider) => {
						emitProgress('streaming', 'Streaming LLM response...', {
							tokensStreamed: tokens,
							estimatedCostSoFar: cost,
							providerUsed: provider,
						});
					}
				: undefined
		);

		if (experiences.length === 0) {
			this.lastDiagnostic = {
				...baseDiag,
				status: 'failed-no-experiences',
				message: 'LLM returned no parseable experiences',
				providerUsed: this.lastDiagnostic?.providerUsed,
			};
			emitProgress('error', 'No experiences extracted');
			return 0;
		}

		// Filter by novelty score
		emitProgress('parsing', `Filtering ${experiences.length} experiences...`, {
			providerUsed: this.lastDiagnostic?.providerUsed,
		});
		const minNovelty = config.minNoveltyScore ?? 0.4;
		const novel = experiences.filter((e) => e.noveltyScore >= minNovelty);

		// Store with deduplication
		emitProgress('storing', `Storing ${novel.length} experiences...`, {
			providerUsed: this.lastDiagnostic?.providerUsed,
		});
		const stored = await this.storeExperiences(novel, input);

		// Record analysis time for rate limiting
		this.lastAnalysisTime.set(projectPath, Date.now());

		// Mark session as analyzed in registry
		try {
			const { getAnalyzedSessionsRegistry } = await import('./analyzed-sessions');
			await getAnalyzedSessionsRegistry().markAnalyzed({
				sessionId,
				analyzedAt: Date.now(),
				experiencesStored: stored,
				providerUsed: this.lastDiagnostic?.providerUsed,
				trigger,
			});
		} catch {
			// Registry write failed — non-critical
		}

		this.lastDiagnostic = {
			...baseDiag,
			status: 'success',
			message: `Extracted ${experiences.length} experiences, stored ${stored} after dedup/novelty filter`,
			experiencesStored: stored,
			tokenUsage: this.lastDiagnostic?.tokenUsage,
			providerUsed: this.lastDiagnostic?.providerUsed,
		};

		emitProgress('complete', `Stored ${stored} experiences`, {
			tokensStreamed: this.lastDiagnostic?.tokenUsage
				? this.lastDiagnostic.tokenUsage.inputTokens + this.lastDiagnostic.tokenUsage.outputTokens
				: 0,
			estimatedCostSoFar: this.lastDiagnostic?.tokenUsage
				? (this.lastDiagnostic.tokenUsage.inputTokens / 1_000_000) * 3 +
					(this.lastDiagnostic.tokenUsage.outputTokens / 1_000_000) * 15
				: 0,
			providerUsed: this.lastDiagnostic?.providerUsed,
		});

		return stored;
	}

	/**
	 * Analyze a single completed turn for experience extraction.
	 * Lighter than analyzeCompletedSession — operates on a single history entry
	 * with turn-scoped VIBES data.
	 */
	async analyzeTurn(
		sessionId: string,
		projectPath: string,
		agentType: string,
		turnIndex: number,
		interestScore: number,
		historyEntry: {
			summary: string;
			fullResponse?: string;
			success?: boolean;
			elapsedTimeMs?: number;
		},
		vibesAnnotationsDelta: number,
		vibesManifestDelta: number,
		onProgress?: (progress: ExtractionProgress) => void
	): Promise<number> {
		const config = await this.getMemoryConfig();
		const baseDiag: Partial<ExtractionDiagnostic> = {
			timestamp: Date.now(),
			sessionId,
			agentType,
			projectPath,
			trigger: 'per-turn',
		};

		const emitProgress = (
			stage: ExtractionProgress['stage'],
			message: string,
			extra?: Partial<ExtractionProgress>
		) => {
			if (onProgress) {
				onProgress({
					stage,
					message,
					startedAt: baseDiag.timestamp!,
					tokensStreamed: 0,
					estimatedTotalTokens: 5000,
					estimatedCostSoFar: 0,
					sessionId,
					...extra,
				});
			}
		};

		// Check if this turn was already analyzed
		try {
			const { getAnalyzedSessionsRegistry } = await import('./analyzed-sessions');
			const turnKey = `${sessionId}:turn:${turnIndex}`;
			if (await getAnalyzedSessionsRegistry().isAnalyzed(turnKey)) {
				this.lastDiagnostic = {
					...baseDiag,
					status: 'skipped-already-analyzed',
					message: `Turn ${turnIndex} already analyzed`,
				} as ExtractionDiagnostic;
				return 0;
			}
		} catch {
			// Registry unavailable — proceed
		}

		// Gather turn data
		emitProgress('gathering', `Gathering turn ${turnIndex} data...`);
		const input = await this.gatherTurnData(
			sessionId,
			projectPath,
			agentType,
			historyEntry,
			vibesAnnotationsDelta,
			vibesManifestDelta
		);

		// Compile per-turn prompt
		const compiledPrompt = this.compileTurnPrompt(input, turnIndex, interestScore);

		// Run LLM analysis (reuse existing analyzeSession infrastructure with pre-compiled prompt)
		const experiences = await this.analyzeSession(
			input,
			onProgress
				? (tokens, cost, provider) => {
						emitProgress('streaming', 'Streaming LLM response...', {
							tokensStreamed: tokens,
							estimatedCostSoFar: cost,
							providerUsed: provider,
						});
					}
				: undefined,
			compiledPrompt
		);

		if (experiences.length === 0) {
			this.lastDiagnostic = {
				...baseDiag,
				status: 'failed-no-experiences',
				message: `Turn ${turnIndex}: no experiences extracted`,
				providerUsed: this.lastDiagnostic?.providerUsed,
			} as ExtractionDiagnostic;
			return 0;
		}

		// Filter by novelty
		const minNovelty = config.minNoveltyScore ?? 0.4;
		const novel = experiences.filter((e) => e.noveltyScore >= minNovelty);

		// Store with deduplication
		emitProgress('storing', `Storing ${novel.length} experiences from turn ${turnIndex}...`);
		const stored = await this.storeExperiences(novel, input);

		// Mark turn as analyzed
		try {
			const { getAnalyzedSessionsRegistry } = await import('./analyzed-sessions');
			const turnKey = `${sessionId}:turn:${turnIndex}`;
			const registry = getAnalyzedSessionsRegistry();
			await registry.markAnalyzed({
				sessionId: turnKey,
				analyzedAt: Date.now(),
				experiencesStored: stored,
				providerUsed: this.lastDiagnostic?.providerUsed,
				trigger: 'per-turn',
			});

			// Also mark bare sessionId to prevent retroactive double-extraction
			if (stored > 0) {
				await registry.markAnalyzed({
					sessionId,
					analyzedAt: Date.now(),
					experiencesStored: stored,
					providerUsed: this.lastDiagnostic?.providerUsed,
					trigger: 'per-turn',
				});
			}
		} catch {
			// Non-critical
		}

		this.lastDiagnostic = {
			...baseDiag,
			status: 'success',
			message: `Turn ${turnIndex}: ${stored} experiences stored`,
			experiencesStored: stored,
			tokenUsage: this.lastDiagnostic?.tokenUsage,
			providerUsed: this.lastDiagnostic?.providerUsed,
		} as ExtractionDiagnostic;

		emitProgress('complete', `Turn ${turnIndex}: ${stored} experiences stored`);
		return stored;
	}

	/**
	 * Check if a project is on cooldown (rate limiting).
	 */
	async isOnCooldown(projectPath: string): Promise<boolean> {
		const lastTime = this.lastAnalysisTime.get(projectPath);
		if (!lastTime) return false;
		const cooldownMs = await this.getCooldownMs();
		return Date.now() - lastTime < cooldownMs;
	}

	/**
	 * Get the cooldown period in milliseconds.
	 * Uses analysisCooldownMs from MemoryConfig — default 300000 (5 minutes).
	 */
	private async getCooldownMs(): Promise<number> {
		const config = await this.getMemoryConfig();
		return config.analysisCooldownMs ?? 300000;
	}

	/**
	 * Gather all available data for a completed session.
	 * Degrades gracefully if any data source is unavailable.
	 */
	async gatherSessionData(
		sessionId: string,
		projectPath: string,
		agentType: string
	): Promise<ExperienceAnalyzerInput> {
		const input: ExperienceAnalyzerInput = {
			sessionId,
			agentType,
			projectPath,
			historyEntries: [],
		};

		// History: load via HistoryManager
		try {
			const { getHistoryManager } = await import('../history-manager');
			const historyManager = getHistoryManager();
			const entries = historyManager.getEntries(sessionId);
			// Take last 20, extract relevant fields, truncate fullResponse
			const recent = entries.slice(-20);
			input.historyEntries = recent.map((e) => ({
				summary: e.summary,
				fullResponse: e.fullResponse?.slice(0, 500),
				success: e.success,
				elapsedTimeMs: e.elapsedTimeMs,
			}));
		} catch {
			// History unavailable — proceed with empty
		}

		// Detect deviations in history entries
		if (input.historyEntries.length > 0) {
			input.detectedDeviations = this.detectDeviations(input.historyEntries);
		}

		// Git diff: attempt to get diff from session start
		try {
			const { execFile } = await import('child_process');
			const { promisify } = await import('util');
			const execFileAsync = promisify(execFile);
			const result = await execFileAsync('git', ['diff', '--stat', 'HEAD~5..HEAD'], {
				cwd: projectPath,
				timeout: 10000,
			});
			const diffStat = result.stdout?.slice(0, 1000) ?? '';

			// Get the actual diff (truncated)
			const diffResult = await execFileAsync('git', ['diff', 'HEAD~5..HEAD'], {
				cwd: projectPath,
				timeout: 10000,
			});
			const fullDiff = diffResult.stdout?.slice(0, 4000) ?? '';
			input.gitDiff = diffStat ? `${diffStat}\n\n${fullDiff}` : fullDiff;
		} catch {
			// No git repo or git unavailable — proceed without diff
		}

		// VIBES data: attempt to read manifest and annotations
		try {
			const fs = await import('fs/promises');
			const path = await import('path');

			// Manifest
			const manifestPath = path.join(projectPath, '.ai-audit', 'manifest.json');
			const manifestContent = await fs.readFile(manifestPath, 'utf-8');
			const manifest = JSON.parse(manifestContent);
			// VIBES v1.0 stores entries as object keyed by content hash; normalize to array
			const rawEntries = manifest.entries;
			const entryArray: Record<string, unknown>[] = Array.isArray(rawEntries)
				? rawEntries
				: rawEntries && typeof rawEntries === 'object'
					? Object.values(rawEntries)
					: [];

			if (entryArray.length > 0) {
				input.vibesManifest = entryArray.slice(-20).map((e: Record<string, unknown>) => ({
					type: String(e.type ?? 'unknown'),
					content: extractManifestContent(e).slice(0, 500),
				}));
			}

			// Annotations
			const annotationsPath = path.join(projectPath, '.ai-audit', 'annotations.jsonl');
			const annotationsContent = await fs.readFile(annotationsPath, 'utf-8');
			const lines = annotationsContent.trim().split('\n').slice(-20);
			input.vibesAnnotations = lines
				.map((line) => {
					try {
						const a = JSON.parse(line);
						return {
							filePath: String(a.filePath ?? ''),
							action: String(a.action ?? ''),
							...(a.lineRange != null ? { lineRange: String(a.lineRange) } : {}),
						} as { filePath: string; action: string; lineRange?: string };
					} catch {
						return null;
					}
				})
				.filter((a): a is { filePath: string; action: string; lineRange?: string } => a !== null);
		} catch {
			// VIBES not available — proceed without
		}

		// Decision provenance: extract from VIBES reasoning traces or history
		try {
			input.decisionSignals = await this.gatherDecisionProvenance(
				projectPath,
				sessionId,
				input.vibesManifest,
				input.vibesAnnotations,
				input.historyEntries
			);
		} catch {
			// Decision provenance unavailable — proceed without
		}

		// Stats: query stats.db for session query events to get total duration
		try {
			const { getStatsDB } = await import('../stats');
			const statsDb = getStatsDB();
			const queryEvents = statsDb.getQueryEvents('all', { sessionId });
			if (queryEvents.length > 0) {
				input.sessionDurationMs = queryEvents.reduce((sum, q) => sum + q.duration, 0);
			}
		} catch {
			// Stats DB unavailable — proceed without duration
		}

		// Context utilization: capture from the last history entry's contextUsage field
		try {
			const { getHistoryManager } = await import('../history-manager');
			const historyManager = getHistoryManager();
			const entries = historyManager.getEntries(sessionId);
			if (entries.length > 0) {
				const lastEntry = entries[entries.length - 1];
				if (lastEntry.contextUsage !== undefined) {
					input.contextUtilizationAtEnd = lastEntry.contextUsage;
				}
			}
		} catch {
			// Context utilization unavailable — proceed without
		}

		// Persona context for full-session extraction
		try {
			const { getMemoryStore } = await import('./memory-store');
			const store = getMemoryStore();
			const config = await store.getConfig();
			const queryText = input.historyEntries
				.slice(0, 5)
				.map((e) => e.summary)
				.join(' ')
				.slice(0, 2000);
			const matchedPersonas = await store.selectMatchingPersonas(
				queryText,
				config,
				agentType,
				projectPath
			);
			if (matchedPersonas.length > 0) {
				const top = matchedPersonas[0];
				input.personaContext = {
					personaId: top.persona.id,
					personaName: top.personaName,
					personaSystemPrompt: top.persona.systemPrompt ?? '',
					roleName: top.roleName,
					roleSystemPrompt: top.roleSystemPrompt,
				};
			}
		} catch {
			// Persona selection unavailable — proceed without
		}

		return input;
	}

	/**
	 * Gather data for a single turn (lighter than full-session gatherSessionData).
	 * Uses the history entry passed in from the job payload instead of reading all entries.
	 */
	private async gatherTurnData(
		sessionId: string,
		projectPath: string,
		agentType: string,
		historyEntry: {
			summary: string;
			fullResponse?: string;
			success?: boolean;
			elapsedTimeMs?: number;
		},
		vibesAnnotationsDelta: number,
		vibesManifestDelta: number
	): Promise<ExperienceAnalyzerInput> {
		const input: ExperienceAnalyzerInput = {
			sessionId,
			agentType,
			projectPath,
			historyEntries: [
				{
					summary: historyEntry.summary,
					fullResponse: historyEntry.fullResponse?.slice(0, 1500),
					success: historyEntry.success,
					elapsedTimeMs: historyEntry.elapsedTimeMs,
				},
			],
		};

		// Incremental git diff (HEAD~1 instead of HEAD~5, smaller budget)
		try {
			const { execFile } = await import('child_process');
			const { promisify } = await import('util');
			const execFileAsync = promisify(execFile);
			const { stdout } = await execFileAsync('git', ['diff', 'HEAD'], {
				cwd: projectPath,
				timeout: 5000,
			});
			if (stdout) {
				input.gitDiff = stdout.slice(0, 2000);
			}
		} catch {
			// No git or no recent commits — proceed without
		}

		// VIBES: read only turn-scoped entries using deltas
		try {
			const fs = await import('fs/promises');
			const path = await import('path');

			if (vibesManifestDelta > 0) {
				const manifestPath = path.join(projectPath, '.ai-audit', 'manifest.json');
				const manifestContent = await fs.readFile(manifestPath, 'utf-8');
				const manifest = JSON.parse(manifestContent);
				const rawEntries = manifest.entries;
				const entryArray: Record<string, unknown>[] = Array.isArray(rawEntries)
					? rawEntries
					: rawEntries && typeof rawEntries === 'object'
						? Object.values(rawEntries)
						: [];

				const recentEntries = entryArray.slice(-vibesManifestDelta);
				input.vibesManifest = recentEntries.map((e) => ({
					type: String(e.type ?? 'unknown'),
					content: extractManifestContent(e).slice(0, 500),
				}));
			}

			if (vibesAnnotationsDelta > 0) {
				const annotationsPath = path.join(projectPath, '.ai-audit', 'annotations.jsonl');
				const annotationsContent = await fs.readFile(annotationsPath, 'utf-8');
				const allLines = annotationsContent.trim().split('\n');
				const recentLines = allLines.slice(-vibesAnnotationsDelta);
				input.vibesAnnotations = recentLines
					.map((line) => {
						try {
							const a = JSON.parse(line);
							return {
								filePath: String(a.filePath ?? ''),
								action: String(a.action ?? ''),
								...(a.lineRange != null ? { lineRange: String(a.lineRange) } : {}),
							} as { filePath: string; action: string; lineRange?: string };
						} catch {
							return null;
						}
					})
					.filter((a): a is { filePath: string; action: string; lineRange?: string } => a !== null);
			}
		} catch {
			// VIBES not available — proceed without
		}

		// Persona context: select matching persona for extraction perspective
		try {
			const { getMemoryStore } = await import('./memory-store');
			const store = getMemoryStore();
			const config = await store.getConfig();
			const matchedPersonas = await store.selectMatchingPersonas(
				historyEntry.summary.slice(0, 2000),
				config,
				agentType,
				projectPath
			);
			if (matchedPersonas.length > 0) {
				const top = matchedPersonas[0];
				input.personaContext = {
					personaId: top.persona.id,
					personaName: top.personaName,
					personaSystemPrompt: top.persona.systemPrompt ?? '',
					roleName: top.roleName,
					roleSystemPrompt: top.roleSystemPrompt,
				};
			}
		} catch {
			// Persona selection unavailable — proceed without
		}

		return input;
	}

	/**
	 * Compile the per-turn extraction prompt with template variable substitution.
	 */
	private compileTurnPrompt(
		input: ExperienceAnalyzerInput,
		turnIndex: number,
		interestScore: number
	): string {
		let prompt = experienceExtractionTurnPrompt;

		prompt = prompt.replace('{{AGENT_TYPE}}', input.agentType);
		prompt = prompt.replace('{{PROJECT_PATH}}', input.projectPath);
		prompt = prompt.replace('{{TURN_INDEX}}', String(turnIndex));
		prompt = prompt.replace('{{INTEREST_SCORE}}', interestScore.toFixed(2));

		// History entry (single turn)
		const historyText =
			input.historyEntries.length > 0
				? input.historyEntries
						.map(
							(e) =>
								`Summary: ${e.summary}\nSuccess: ${e.success ?? 'unknown'}\nDuration: ${e.elapsedTimeMs ?? 'unknown'}ms\n${e.fullResponse ? `Response:\n${e.fullResponse}` : ''}`
						)
						.join('\n---\n')
				: 'No history data available.';
		prompt = prompt.replace('{{HISTORY_ENTRIES}}', historyText);

		// Git diff
		prompt = prompt.replace('{{GIT_DIFF}}', input.gitDiff || 'No code changes detected.');

		// VIBES data
		let vibesText = '';
		if (input.vibesManifest && input.vibesManifest.length > 0) {
			vibesText +=
				'Manifest entries:\n' +
				input.vibesManifest.map((e) => `- [${e.type}] ${e.content}`).join('\n');
		}
		if (input.vibesAnnotations && input.vibesAnnotations.length > 0) {
			vibesText +=
				'\n\nAnnotations:\n' +
				input.vibesAnnotations
					.map((a) => `- ${a.action}: ${a.filePath}${a.lineRange ? ` (${a.lineRange})` : ''}`)
					.join('\n');
		}
		prompt = prompt.replace('{{VIBES_DATA}}', vibesText || 'No VIBES data for this turn.');

		// Persona context
		if (input.personaContext) {
			const ctx = [
				`Persona: ${input.personaContext.personaName}`,
				`Role: ${input.personaContext.roleName}`,
				input.personaContext.personaSystemPrompt
					? `Persona Perspective:\n${input.personaContext.personaSystemPrompt}`
					: '',
				input.personaContext.roleSystemPrompt
					? `Role Guidance:\n${input.personaContext.roleSystemPrompt}`
					: '',
			]
				.filter(Boolean)
				.join('\n');
			prompt = prompt.replace('{{PERSONA_CONTEXT}}', ctx);
		} else {
			prompt = prompt.replace('{{PERSONA_CONTEXT}}', 'No persona matched for this agent.');
		}

		return prompt;
	}

	/**
	 * Extract decision provenance signals from VIBES audit data.
	 *
	 * VIBES reasoning traces often contain explicit decision moments —
	 * "I could do X or Y, choosing X because..." These are richer than
	 * history entry summaries because they capture the agent's actual
	 * deliberation process.
	 *
	 * When VIBES is unavailable, falls back to scanning history entry
	 * summaries for decision language (lighter signals with source='history').
	 */
	async gatherDecisionProvenance(
		_projectPath: string,
		_sessionId: string,
		vibesManifest?: ExperienceAnalyzerInput['vibesManifest'],
		_vibesAnnotations?: ExperienceAnalyzerInput['vibesAnnotations'],
		historyEntries?: ExperienceAnalyzerInput['historyEntries']
	): Promise<DecisionSignal[]> {
		const signals: DecisionSignal[] = [];

		// Decision keyword patterns
		const decisionPatterns = [
			/\b(?:I could (?:do|use|try) .+? or .+)/i,
			/\b(?:choosing .+? because)\b/i,
			/\b(?:decided to .+)/i,
			/\b(?:opted for .+)/i,
			/\b(?:going with .+)/i,
			/\b(?:alternatives?:)/i,
			/\b(?:options?:)/i,
			/\b(?:trade-?off)/i,
			/\b(?:pros and cons)\b/i,
		];

		// Alternatives extraction pattern: "X or Y" / "X vs Y" / "X versus Y"
		const alternativesPattern =
			/\b(\w[\w\s.-]*?)\s+(?:or|vs\.?|versus)\s+(\w[\w\s.-]*?)(?:\s|[.,;!?]|$)/gi;

		// Rationale extraction: "because ..." clause
		const rationalePattern = /\bbecause\s+(.{10,200}?)(?:\.|$)/i;

		/**
		 * Extract surrounding context (±200 chars) from a match position.
		 */
		const extractContext = (text: string, matchIndex: number, matchLength: number): string => {
			const start = Math.max(0, matchIndex - 200);
			const end = Math.min(text.length, matchIndex + matchLength + 200);
			return text.slice(start, end).trim();
		};

		/**
		 * Extract a decision signal from a text match.
		 */
		const extractSignal = (
			text: string,
			matchIndex: number,
			matchStr: string,
			source: 'vibes' | 'history',
			timestamp?: number
		): DecisionSignal => {
			const context = extractContext(text, matchIndex, matchStr.length);

			// Extract the sentence containing the decision keyword
			const sentences = context.split(/(?<=[.!?])\s+/);
			const decisionSentence =
				sentences.find((s) => decisionPatterns.some((p) => p.test(s))) || matchStr;

			// Extract alternatives
			const alternatives: string[] = [];
			let altMatch: RegExpExecArray | null;
			const altRegex = new RegExp(alternativesPattern.source, alternativesPattern.flags);
			while ((altMatch = altRegex.exec(context)) !== null) {
				const a = altMatch[1].trim();
				const b = altMatch[2].trim();
				if (a && !alternatives.includes(a)) alternatives.push(a);
				if (b && !alternatives.includes(b)) alternatives.push(b);
			}

			// Extract rationale
			const ratMatch = rationalePattern.exec(context);
			const rationale = ratMatch ? ratMatch[1].trim() : '';

			return {
				decision: decisionSentence.slice(0, 300),
				alternatives,
				rationale: rationale.slice(0, 500),
				source,
				...(timestamp != null ? { timestamp } : {}),
			};
		};

		// VIBES path: scan reasoning entries from manifest
		if (vibesManifest && vibesManifest.length > 0) {
			for (const entry of vibesManifest) {
				if (entry.type !== 'reasoning') continue;
				const text = extractManifestContent(entry);
				for (const pattern of decisionPatterns) {
					const match = pattern.exec(text);
					if (match) {
						signals.push(extractSignal(text, match.index, match[0], 'vibes'));
						break; // One signal per manifest entry
					}
				}
			}
		}

		// Internal fallback: scan history entry summaries
		if (historyEntries && historyEntries.length > 0) {
			for (const entry of historyEntries) {
				const text = entry.summary + (entry.fullResponse ? ' ' + entry.fullResponse : '');
				for (const pattern of decisionPatterns) {
					const match = pattern.exec(text);
					if (match) {
						signals.push(extractSignal(text, match.index, match[0], 'history'));
						break; // One signal per history entry
					}
				}
			}
		}

		return signals;
	}

	/**
	 * Run LLM analysis on gathered session data to extract experiences.
	 *
	 * Spawns Claude Code in batch mode (`--print --output-format stream-json`)
	 * with the compiled prompt. Parses the JSONL output to extract the result
	 * text, then parses the JSON experiences array.
	 *
	 * Graceful failure: if the agent fails, times out, or returns unparseable
	 * output, logs and returns empty — never blocks session cleanup.
	 *
	 * Token budget: history truncation (20 entries × 500 chars) plus diff
	 * truncation (4000 chars) keep the prompt under ~8000 tokens.
	 */
	async analyzeSession(
		input: ExperienceAnalyzerInput,
		onStreamProgress?: (tokensStreamed: number, estimatedCost: number, provider: string) => void,
		preCompiledPrompt?: string
	): Promise<ExtractedExperience[]> {
		// Allow callers to pass a pre-compiled prompt (used by per-turn extraction)
		const prompt = preCompiledPrompt || this.compilePrompt(input);
		if (!prompt) return [];

		this.logDebug(
			`analyzeSession: Prompt compiled (${prompt.length} chars, ${input.historyEntries.length} history entries, ${input.historyEntries.filter((e) => e.fullResponse).length} with fullResponse)`
		);

		try {
			const { spawn } = await import('child_process');

			// Resolve provider
			const config = await this.getMemoryConfig();
			const { resolveExtractionProvider } = await import('./extraction-provider-resolver');
			const provider = await resolveExtractionProvider(config.extractionProvider);

			if (!provider) {
				this.lastDiagnostic = {
					timestamp: Date.now(),
					sessionId: input.sessionId,
					agentType: input.agentType,
					projectPath: input.projectPath,
					status: 'failed-provider-not-found',
					message: config.extractionProvider
						? `Configured provider '${config.extractionProvider}' not available`
						: 'No batch-capable AI provider found on this system',
				};
				return [];
			}

			// Build CLI args from resolved provider
			const args = [...provider.args];
			if (config.extractionModel && provider.modelArgs) {
				args.push(...provider.modelArgs(config.extractionModel));
			}
			args.push(...provider.promptArgs(prompt));

			this.lastDiagnostic = {
				timestamp: Date.now(),
				sessionId: input.sessionId,
				agentType: input.agentType,
				projectPath: input.projectPath,
				status: 'success', // tentative — overwritten on failure
				message: `Running extraction via ${provider.agentId}`,
				providerUsed: provider.agentId,
			};

			// Spawn with streaming to get real-time progress
			const rawOutput = await new Promise<string>((resolve, reject) => {
				const child = spawn(provider.command, args, {
					env: { ...process.env, ...provider.env },
					stdio: ['ignore', 'pipe', 'pipe'],
				});

				let stdout = '';
				let stderr = '';
				let tokensStreamed = 0;

				// Token cost rates ($/MTok)
				const inputRate = 3;
				const outputRate = 15;

				child.stdout.on('data', (chunk: Buffer) => {
					const text = chunk.toString();
					stdout += text;

					// Parse JSONL lines for streaming token updates
					const lines = text.split('\n').filter((l: string) => l.trim());
					for (const line of lines) {
						try {
							const event = JSON.parse(line);
							// Look for usage data in stream-json events
							if (event.usage) {
								tokensStreamed = (event.usage.input_tokens ?? 0) + (event.usage.output_tokens ?? 0);
								const cost =
									((event.usage.input_tokens ?? 0) / 1_000_000) * inputRate +
									((event.usage.output_tokens ?? 0) / 1_000_000) * outputRate;
								onStreamProgress?.(tokensStreamed, cost, provider.agentId);
							} else if (event.type === 'content_block_delta' || event.type === 'message_delta') {
								// Approximate tokens from streaming deltas (rough: 4 chars ≈ 1 token)
								const deltaText = event.delta?.text ?? event.delta?.content ?? '';
								if (deltaText) {
									tokensStreamed += Math.ceil(deltaText.length / 4);
									const estimatedCost = (tokensStreamed / 1_000_000) * outputRate;
									onStreamProgress?.(tokensStreamed, estimatedCost, provider.agentId);
								}
							}
						} catch {
							// Not valid JSON line — ignore (partial line, etc.)
						}
					}
				});

				child.stderr.on('data', (chunk: Buffer) => {
					stderr += chunk.toString();
				});

				const timeout = setTimeout(() => {
					child.kill('SIGTERM');
					reject(new Error('ETIMEDOUT: extraction timed out after 120s'));
				}, 120000);

				child.on('close', (code) => {
					clearTimeout(timeout);
					if (code !== 0 && !stdout.trim()) {
						reject(new Error(`Process exited with code ${code}: ${stderr.slice(0, 500)}`));
					} else {
						resolve(stdout);
					}
				});

				child.on('error', (err) => {
					clearTimeout(timeout);
					reject(err);
				});
			});

			// Extract real token usage from output
			const tokenUsage = this.extractTokenUsage(rawOutput);
			if (tokenUsage) {
				this.lastDiagnostic.tokenUsage = tokenUsage;
			}

			// Extract text from stream-json JSONL output
			const text = this.extractResultText(rawOutput);
			this.logDebug(
				`analyzeSession: Extracted result text (${text.length} chars). Preview: ${text.slice(0, 500)}`
			);

			const experiences = this.parseExperiences(text);
			if (experiences.length === 0) {
				this.lastDiagnostic.status = 'failed-parse';
				this.lastDiagnostic.message = `Provider returned ${text.length} chars but no experiences parsed. Preview: ${text.slice(0, 200)}`;
				this
					.logDebug(`analyzeSession: Zero experiences parsed. Raw output (${rawOutput.length} chars), extracted text (${text.length} chars). Text preview:
${text.slice(0, 1000)}`);
			} else {
				this.logDebug(`analyzeSession: Parsed ${experiences.length} experiences from LLM output`);
			}
			return experiences;
		} catch (err) {
			const isTimeout = err instanceof Error && err.message.includes('ETIMEDOUT');
			this.lastDiagnostic = {
				timestamp: Date.now(),
				sessionId: input.sessionId,
				agentType: input.agentType,
				projectPath: input.projectPath,
				status: isTimeout ? 'failed-timeout' : 'failed-spawn',
				message: `LLM analysis failed: ${err instanceof Error ? err.message : String(err)}`,
				providerUsed: this.lastDiagnostic?.providerUsed,
			};
			this.logDebug(`LLM analysis failed: ${err}`);
			return [];
		}
	}

	/**
	 * Extract real token usage from LLM output.
	 *
	 * Claude's stream-json emits a `result` event with `usage: { input_tokens, output_tokens }`.
	 * Other providers may include similar fields. Returns null if no usage data found.
	 */
	extractTokenUsage(rawOutput: string): { inputTokens: number; outputTokens: number } | null {
		const lines = rawOutput.split('\n');
		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				const event = JSON.parse(line);
				// Claude Code stream-json result event
				if (event.type === 'result' && event.usage) {
					const inputTokens = event.usage.input_tokens ?? event.usage.inputTokens ?? 0;
					const outputTokens = event.usage.output_tokens ?? event.usage.outputTokens ?? 0;
					if (inputTokens > 0 || outputTokens > 0) {
						return { inputTokens, outputTokens };
					}
				}
				// Generic usage block (some providers embed it at top level)
				if (event.usage && !event.type) {
					const inputTokens = event.usage.input_tokens ?? event.usage.prompt_tokens ?? 0;
					const outputTokens = event.usage.output_tokens ?? event.usage.completion_tokens ?? 0;
					if (inputTokens > 0 || outputTokens > 0) {
						return { inputTokens, outputTokens };
					}
				}
			} catch {
				// Not valid JSON — skip
			}
		}
		return null;
	}

	/**
	 * Extract the result text from Claude Code stream-json JSONL output.
	 *
	 * Claude Code's stream-json format emits one JSON object per line:
	 * - `{ type: 'result', result: '...' }` — final complete response (preferred)
	 * - `{ type: 'assistant', message: { content: [...] } }` — streaming text blocks (fallback)
	 *
	 * Returns the result text, or concatenated assistant text blocks, or raw output as last resort.
	 */
	extractResultText(rawOutput: string): string {
		const lines = rawOutput.split('\n');
		const textParts: string[] = [];

		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				const event = JSON.parse(line);

				// Result event contains the complete final response
				if (event.type === 'result' && typeof event.result === 'string') {
					return event.result;
				}

				// Assistant message with text content (streaming fallback)
				if (event.type === 'assistant' && event.message?.content) {
					const content = event.message.content;
					if (typeof content === 'string') {
						textParts.push(content);
					} else if (Array.isArray(content)) {
						for (const block of content) {
							if (block.type === 'text' && typeof block.text === 'string') {
								textParts.push(block.text);
							}
						}
					}
				}
			} catch {
				// Not valid JSON — skip
			}
		}

		// Prefer joined text parts over raw output
		return textParts.length > 0 ? textParts.join('\n') : rawOutput;
	}

	/**
	 * Compile the analysis prompt from the experience-extraction template.
	 *
	 * Loads the prompt from src/prompts/experience-extraction.md (compiled to
	 * a TypeScript constant at build time) and substitutes template variables.
	 */
	compilePrompt(input: ExperienceAnalyzerInput): string {
		const historyText = input.historyEntries
			.map((e, i) => {
				const header = `${i + 1}. ${e.summary}${e.success === false ? ' [FAILED]' : ''}${e.elapsedTimeMs ? ` (${e.elapsedTimeMs}ms)` : ''}`;
				if (e.fullResponse) {
					return `${header}\n   Context: ${e.fullResponse}`;
				}
				return header;
			})
			.join('\n');

		const durationStr = input.sessionDurationMs
			? `${Math.round(input.sessionDurationMs / 1000)}s`
			: 'unknown';
		const costStr =
			input.sessionCostUsd !== undefined ? `$${input.sessionCostUsd.toFixed(4)}` : 'unknown';

		const vibesText = input.vibesManifest
			? input.vibesManifest.map((v) => `[${v.type}] ${v.content}`).join('\n')
			: 'N/A';

		const annotationsText = input.vibesAnnotations
			? input.vibesAnnotations
					.map((a) => `${a.action}: ${a.filePath}${a.lineRange ? ` (${a.lineRange})` : ''}`)
					.join('\n')
			: '';

		const vibesSection =
			vibesText !== 'N/A' || annotationsText ? `${vibesText}\n${annotationsText}` : 'N/A';

		const deviationText = input.detectedDeviations?.length
			? input.detectedDeviations
					.map(
						(d, i) =>
							`${i + 1}. [${d.type}] ${d.description}${d.attemptCount ? ` (${d.attemptCount} attempts)` : ''}`
					)
					.join('\n')
			: 'None detected';

		const decisionText = input.decisionSignals?.length
			? input.decisionSignals
					.map(
						(d, i) =>
							`${i + 1}. [${d.source}] ${d.decision}` +
							(d.alternatives.length ? `\n   Alternatives: ${d.alternatives.join(', ')}` : '') +
							(d.rationale ? `\n   Rationale: ${d.rationale}` : '')
					)
					.join('\n')
			: 'None detected';

		let prompt = experienceExtractionPrompt
			.replace('{{AGENT_TYPE}}', input.agentType)
			.replace('{{PROJECT_PATH}}', input.projectPath)
			.replace('{{DURATION}}', durationStr)
			.replace('{{COST}}', costStr)
			.replace('{{HISTORY_ENTRIES}}', historyText || 'N/A')
			.replace('{{DEVIATION_SIGNALS}}', deviationText)
			.replace('{{DECISION_SIGNALS}}', decisionText)
			.replace('{{GIT_DIFF}}', input.gitDiff || 'N/A')
			.replace('{{VIBES_DATA}}', vibesSection);

		// Persona context
		if (input.personaContext) {
			const ctx = [
				`Persona: ${input.personaContext.personaName}`,
				`Role: ${input.personaContext.roleName}`,
				input.personaContext.personaSystemPrompt
					? `Persona Perspective:\n${input.personaContext.personaSystemPrompt}`
					: '',
				input.personaContext.roleSystemPrompt
					? `Role Guidance:\n${input.personaContext.roleSystemPrompt}`
					: '',
			]
				.filter(Boolean)
				.join('\n');
			prompt = prompt.replace('{{PERSONA_CONTEXT}}', ctx);
		} else {
			prompt = prompt.replace('{{PERSONA_CONTEXT}}', 'No persona matched for this agent.');
		}

		return prompt;
	}

	/**
	 * Parse the LLM output into ExtractedExperience[].
	 * Handles JSON extraction from potentially noisy output.
	 */
	parseExperiences(output: string): ExtractedExperience[] {
		try {
			// Try to find a JSON array in the output
			const jsonMatch = output.match(/\[[\s\S]*\]/);
			if (!jsonMatch) {
				this.logDebug(
					`parseExperiences: No JSON array found in output (${output.length} chars). Preview: ${output.slice(0, 300)}`
				);
				return [];
			}

			const parsed = JSON.parse(jsonMatch[0]);
			if (!Array.isArray(parsed)) {
				this.logDebug(`parseExperiences: Parsed JSON is not an array, got ${typeof parsed}`);
				return [];
			}

			const validEntries = parsed.filter(
				(e: unknown) =>
					typeof e === 'object' &&
					e !== null &&
					typeof (e as Record<string, unknown>).content === 'string' &&
					typeof (e as Record<string, unknown>).situation === 'string' &&
					typeof (e as Record<string, unknown>).learning === 'string' &&
					typeof (e as Record<string, unknown>).noveltyScore === 'number'
			);

			if (validEntries.length < parsed.length) {
				this.logDebug(
					`parseExperiences: ${parsed.length - validEntries.length}/${parsed.length} entries filtered out (missing required fields)`
				);
			}

			return validEntries.map((e: Record<string, unknown>) => {
				// Validate category — default to 'pattern-established' if missing or invalid
				const rawCategory = e.category;
				const category: ExperienceCategory =
					typeof rawCategory === 'string' &&
					(EXPERIENCE_CATEGORIES as readonly string[]).includes(rawCategory)
						? (rawCategory as ExperienceCategory)
						: 'pattern-established';

				return {
					content: String(e.content),
					situation: String(e.situation),
					learning: String(e.learning),
					category,
					tags: Array.isArray(e.tags) ? e.tags.filter((t: unknown) => typeof t === 'string') : [],
					noveltyScore: Number(e.noveltyScore),
					...(typeof e.alternativesConsidered === 'string'
						? { alternativesConsidered: e.alternativesConsidered }
						: {}),
					...(typeof e.rationale === 'string' ? { rationale: e.rationale } : {}),
					keywords: Array.isArray(e.keywords)
						? e.keywords.filter((k: unknown) => typeof k === 'string')
						: [],
				};
			});
		} catch (err) {
			this.logDebug(
				`parseExperiences: JSON parse error: ${err instanceof Error ? err.message : String(err)}. Preview: ${output.slice(0, 300)}`
			);
			return [];
		}
	}

	/**
	 * Store extracted experiences with deduplication and cascading placement.
	 *
	 * For each experience:
	 * 1. Search existing memories for duplicates (similarity > 0.80 → skip)
	 * 2. Use cascading search to find the best skill area
	 * 3. Create memory entry with type 'experience', source 'session-analysis'
	 *
	 * @returns Number of experiences actually stored
	 */
	async storeExperiences(
		experiences: ExtractedExperience[],
		input: ExperienceAnalyzerInput
	): Promise<number> {
		if (experiences.length === 0) return 0;

		const { getMemoryStore } = await import('./memory-store');
		const store = getMemoryStore();
		const config = await store.getConfig();

		let stored = 0;

		for (const exp of experiences) {
			try {
				// Dedup via cascading search
				let searchResults: import('../../shared/memory-types').MemorySearchResult[] = [];
				try {
					searchResults = await store.cascadingSearch(
						exp.content,
						config,
						input.agentType,
						input.projectPath,
						10
					);
				} catch {
					// Embedding service unavailable — skip dedup
				}

				// Skip if too similar to existing memory
				if (searchResults.some((r) => r.similarity > 0.8)) {
					continue;
				}

				// Determine placement: skill scope if cascading search found a match
				let scope: 'skill' | 'project' = 'project';
				let skillAreaId: string | undefined;

				if (searchResults.length > 0 && searchResults[0].entry.skillAreaId) {
					scope = 'skill';
					skillAreaId = searchResults[0].entry.skillAreaId;
				}

				// Prepend category tag if not already present
				const categoryTag = exp.category ? `category:${exp.category}` : null;
				const tags =
					categoryTag && !exp.tags.includes(categoryTag)
						? [categoryTag, ...exp.tags]
						: [...exp.tags];

				// Merge keywords into tags with kw: prefix for keyword-based retrieval
				if (exp.keywords && exp.keywords.length > 0) {
					for (const kw of exp.keywords) {
						const kwTag = `kw:${kw}`;
						if (!tags.includes(kwTag)) {
							tags.push(kwTag);
						}
					}
				}

				// For decision-made, determine provenanceSource from matching decision signals
				let provenanceSource: 'vibes' | 'history' | 'inferred' | undefined;
				let signalAlternatives: string | undefined;
				let signalRationale: string | undefined;

				if (exp.category === 'decision-made') {
					provenanceSource = 'inferred'; // default for decisions

					// Check if any decision signal matches this experience
					if (input.decisionSignals?.length) {
						const matchedSignal = input.decisionSignals.find(
							(s) =>
								s.decision.includes(exp.situation) ||
								exp.situation.includes(s.decision) ||
								s.decision.includes(exp.content) ||
								exp.content.includes(s.decision)
						);
						if (matchedSignal) {
							provenanceSource = matchedSignal.source;
							if (matchedSignal.alternatives.length > 0) {
								signalAlternatives = matchedSignal.alternatives.join('; ');
							}
							if (matchedSignal.rationale) {
								signalRationale = matchedSignal.rationale;
							}
						}
					}
				}

				// Match deviation context: check if experience situation overlaps with any deviation description
				let deviationFields:
					| { isDeviation: true; deviationType: DeviationSignal['type']; attemptCount?: number }
					| Record<string, never> = {};
				if (input.detectedDeviations?.length) {
					const matchedDeviation = input.detectedDeviations.find(
						(d) => d.description.includes(exp.situation) || exp.situation.includes(d.description)
					);
					if (matchedDeviation) {
						deviationFields = {
							isDeviation: true as const,
							deviationType: matchedDeviation.type,
							...(matchedDeviation.attemptCount != null
								? { attemptCount: matchedDeviation.attemptCount }
								: {}),
						};
					}
				}

				const newMemory = await store.addMemory(
					{
						content: exp.content,
						type: 'experience',
						scope,
						skillAreaId,
						source: 'session-analysis',
						confidence: 0.5,
						pinned: false,
						tags,
						experienceContext: {
							situation: exp.situation,
							learning: exp.learning,
							sourceSessionId: input.sessionId,
							sourceProjectPath: input.projectPath,
							sourceAgentType: input.agentType,
							diffSummary: input.gitDiff?.slice(0, 500),
							sessionCostUsd: input.sessionCostUsd,
							sessionDurationMs: input.sessionDurationMs,
							...(signalAlternatives || exp.alternativesConsidered
								? { alternativesConsidered: signalAlternatives ?? exp.alternativesConsidered }
								: {}),
							...(signalRationale || exp.rationale
								? { rationale: signalRationale ?? exp.rationale }
								: {}),
							...(provenanceSource ? { provenanceSource } : {}),
							...deviationFields,
							...(input.contextUtilizationAtEnd !== undefined
								? { contextUtilizationAtEnd: input.contextUtilizationAtEnd }
								: {}),
						},
					},
					scope === 'project' ? input.projectPath : undefined
				);

				// Auto-link: memories with similarity 0.5-0.8 are related but not duplicates
				const relatedResults = searchResults.filter(
					(r) => r.similarity >= 0.5 && r.similarity < 0.8
				);
				const projectPath = scope === 'project' ? input.projectPath : undefined;
				for (const related of relatedResults.slice(0, 3)) {
					try {
						await store.linkMemories(
							newMemory.id,
							scope,
							related.entry.id,
							related.entry.scope,
							newMemory.skillAreaId,
							projectPath,
							related.entry.skillAreaId,
							related.entry.scope === 'project' ? input.projectPath : undefined
						);
					} catch {
						// Linking failed — non-critical, continue
					}
				}

				// Notify cross-agent broadcaster (EXP-LIVE-04)
				import('./live-context-broadcaster')
					.then(({ getLiveBroadcaster }) => {
						getLiveBroadcaster().onMemoryCreated(newMemory, input.projectPath, input.sessionId);
					})
					.catch(() => {});

				stored++;
			} catch {
				// Individual experience storage failed — continue with others
			}
		}

		// Trigger cross-project scan if experiences were stored and feature is enabled
		if (stored > 0) {
			import('./memory-store')
				.then(async ({ getMemoryStore }) => {
					const cfg = await getMemoryStore().getConfig();
					if (cfg.enableCrossProjectPromotion) {
						const { getMemoryJobQueue } = await import('./memory-job-queue');
						getMemoryJobQueue().enqueue({
							type: 'cross-project-scan',
							priority: 8,
							payload: {},
							deferUntil: Date.now() + 30000, // 30s defer to batch rapid extractions
						});
					}
				})
				.catch(() => {});
		}

		return stored;
	}

	/**
	 * Detect deviations in session history — error→fix sequences, backtracks, retries.
	 *
	 * Heuristics:
	 * 1. error-fix: A history entry with success=false followed by success=true on similar content
	 * 2. retry: Multiple entries with very similar summaries (same task attempted multiple times)
	 * 3. backtrack: Entry summary contains "revert", "undo", "go back", "previous approach"
	 * 4. approach-change: Entry summary contains "different approach", "try instead", "let me try", "alternative"
	 */
	detectDeviations(entries: ExperienceAnalyzerInput['historyEntries']): DeviationSignal[] {
		const deviations: DeviationSignal[] = [];
		const usedIndices = new Set<number>();

		// 1. error-fix: consecutive failures followed by a success
		for (let i = 0; i < entries.length; i++) {
			if (entries[i].success !== false) continue;
			if (usedIndices.has(i)) continue;

			// Count consecutive failures starting at i
			let failEnd = i;
			while (failEnd + 1 < entries.length && entries[failEnd + 1].success === false) {
				failEnd++;
			}

			// Look for a success within the next 3 entries after the failure block
			let fixIndex = -1;
			for (let j = failEnd + 1; j <= Math.min(failEnd + 3, entries.length - 1); j++) {
				if (entries[j].success === true) {
					fixIndex = j;
					break;
				}
			}

			if (fixIndex !== -1) {
				const indices: number[] = [];
				for (let k = i; k <= fixIndex; k++) indices.push(k);
				const failCount = failEnd - i + 1;
				deviations.push({
					type: 'error-fix',
					entryIndices: indices,
					description: `Error at entry ${i + 1} resolved at entry ${fixIndex + 1}: "${entries[i].summary}" → "${entries[fixIndex].summary}"`,
					attemptCount: failCount + 1,
				});
				for (const idx of indices) usedIndices.add(idx);
			}
		}

		// 2. retry: entries with >60% word overlap (Jaccard similarity)
		const summaryWords = entries.map((e) => {
			const words = e.summary.toLowerCase().split(/\s+/).filter(Boolean);
			return new Set(words);
		});

		const retryGroups: number[][] = [];
		const retryUsed = new Set<number>();

		for (let i = 0; i < entries.length; i++) {
			if (retryUsed.has(i)) continue;
			const group = [i];
			for (let j = i + 1; j < entries.length; j++) {
				if (retryUsed.has(j)) continue;
				const a = summaryWords[i];
				const b = summaryWords[j];
				const intersection = new Set([...a].filter((w) => b.has(w)));
				const union = new Set([...a, ...b]);
				const jaccard = union.size > 0 ? intersection.size / union.size : 0;
				if (jaccard > 0.6) {
					group.push(j);
					retryUsed.add(j);
				}
			}
			if (group.length >= 2) {
				retryUsed.add(i);
				retryGroups.push(group);
			}
		}

		for (const group of retryGroups) {
			// Skip if all indices are already used by error-fix
			if (group.every((idx) => usedIndices.has(idx))) continue;
			deviations.push({
				type: 'retry',
				entryIndices: group,
				description: `Retried "${entries[group[0]].summary}" ${group.length} times`,
				attemptCount: group.length,
			});
			for (const idx of group) usedIndices.add(idx);
		}

		// 3. backtrack: keyword detection in summaries
		const backtrackKeywords = [
			'revert',
			'undo',
			'go back',
			'roll back',
			'previous approach',
			'original approach',
			'back to',
		];

		for (let i = 0; i < entries.length; i++) {
			if (usedIndices.has(i)) continue;
			const lower = entries[i].summary.toLowerCase();
			if (backtrackKeywords.some((kw) => lower.includes(kw))) {
				deviations.push({
					type: 'backtrack',
					entryIndices: [i],
					description: `Backtrack detected at entry ${i + 1}: "${entries[i].summary}"`,
				});
				usedIndices.add(i);
			}
		}

		// 4. approach-change: keyword detection in summaries
		const approachChangeKeywords = [
			'different approach',
			'try instead',
			'let me try',
			'alternative',
			'switch to',
			'changed approach',
			'new approach',
		];

		for (let i = 0; i < entries.length; i++) {
			if (usedIndices.has(i)) continue;
			const lower = entries[i].summary.toLowerCase();
			if (approachChangeKeywords.some((kw) => lower.includes(kw))) {
				deviations.push({
					type: 'approach-change',
					entryIndices: [i],
					description: `Approach change detected at entry ${i + 1}: "${entries[i].summary}"`,
				});
				usedIndices.add(i);
			}
		}

		return deviations;
	}

	/**
	 * Log a debug message via the main process logger.
	 * Fire-and-forget — silently ignores if logger is unavailable.
	 */
	private logDebug(message: string): void {
		import('../utils/logger')
			.then(({ logger }) => logger.debug(`[Memory] ${message}`, 'ExperienceAnalyzer'))
			.catch(() => {});
	}

	/**
	 * Get the current memory config.
	 * Experience extraction fields are typed in MemoryConfig with defaults.
	 */
	private async getMemoryConfig(): Promise<MemoryConfig> {
		try {
			const { getMemoryStore } = await import('./memory-store');
			const store = getMemoryStore();
			return await store.getConfig();
		} catch {
			return { ...MEMORY_CONFIG_DEFAULTS };
		}
	}
}

// ─── Singleton ──────────────────────────────────────────────────────────────

let _instance: ExperienceAnalyzer | null = null;

/**
 * Get the singleton ExperienceAnalyzer instance.
 * Creates on first use (lazy initialization). Non-blocking.
 */
export function getExperienceAnalyzer(): ExperienceAnalyzer {
	if (!_instance) {
		_instance = new ExperienceAnalyzer();
	}
	return _instance;
}

/**
 * Initialize the singleton ExperienceAnalyzer.
 * Tolerates initialization failures — logs and returns null.
 */
export async function initializeExperienceAnalyzer(): Promise<ExperienceAnalyzer | null> {
	try {
		return getExperienceAnalyzer();
	} catch {
		// Construction failed — degrade silently
		return null;
	}
}

/**
 * Reset the singleton (for testing).
 */
export function resetExperienceAnalyzer(): void {
	_instance = null;
}
