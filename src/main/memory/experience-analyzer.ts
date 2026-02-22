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

import { experienceExtractionPrompt } from '../../prompts';

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
}

export interface ExtractedExperience {
	/** The experience content — what was learned */
	content: string;
	/** Brief description of what happened */
	situation: string;
	/** The discrete learning or teaching */
	learning: string;
	/** Suggested tags */
	tags: string[];
	/** How novel/important this learning is (0.0-1.0) */
	noveltyScore: number;
}

// ─── ExperienceAnalyzer ─────────────────────────────────────────────────────

export class ExperienceAnalyzer {
	/** Per-project cooldown tracking: projectPath → last analysis timestamp */
	private readonly lastAnalysisTime = new Map<string, number>();

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
		agentType: string
	): Promise<number> {
		// Check rate limit
		if (this.isOnCooldown(projectPath)) {
			return 0;
		}

		// Gather session data
		const input = await this.gatherSessionData(sessionId, projectPath, agentType);

		// Check minimum history threshold
		const config = await this.getMemoryConfig();
		const minEntries = config.minHistoryEntriesForAnalysis ?? 3;
		if (input.historyEntries.length < minEntries) {
			return 0;
		}

		// Check if experience extraction is enabled
		if (config.enableExperienceExtraction === false) {
			return 0;
		}

		// Run LLM analysis
		const experiences = await this.analyzeSession(input);

		// Filter by novelty score
		const minNovelty = config.minNoveltyScore ?? 0.4;
		const novel = experiences.filter((e) => e.noveltyScore >= minNovelty);

		// Store with deduplication
		const stored = await this.storeExperiences(novel, input);

		// Record analysis time for rate limiting
		this.lastAnalysisTime.set(projectPath, Date.now());

		return stored;
	}

	/**
	 * Check if a project is on cooldown (rate limiting).
	 */
	isOnCooldown(projectPath: string): boolean {
		const lastTime = this.lastAnalysisTime.get(projectPath);
		if (!lastTime) return false;
		return Date.now() - lastTime < this.getCooldownMs();
	}

	/**
	 * Get the cooldown period in milliseconds.
	 * Can be overridden by config (analysisCooldownMs).
	 * Default: 300000 (5 minutes).
	 */
	private getCooldownMs(): number {
		// Will be configurable via MemoryConfig in Task 11
		return 300000;
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
			if (Array.isArray(manifest.entries)) {
				input.vibesManifest = manifest.entries
					.slice(-20)
					.map((e: { type?: string; content?: string }) => ({
						type: e.type ?? 'unknown',
						content: (e.content ?? '').slice(0, 500),
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

		return input;
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
	async analyzeSession(input: ExperienceAnalyzerInput): Promise<ExtractedExperience[]> {
		// Compile prompt from template
		const prompt = this.compilePrompt(input);
		if (!prompt) return [];

		try {
			const { execFile } = await import('child_process');
			const { promisify } = await import('util');
			const execFileAsync = promisify(execFile);

			const result = await execFileAsync(
				'claude',
				['--print', '--output-format', 'stream-json', '-p', prompt],
				{ timeout: 120000, maxBuffer: 1024 * 1024 }
			);

			const rawOutput = result.stdout ?? '';

			// Extract text from stream-json JSONL output
			const text = this.extractResultText(rawOutput);

			return this.parseExperiences(text);
		} catch (err) {
			// LLM analysis failed — degrade silently, log for diagnostics
			this.logDebug(`LLM analysis failed: ${err}`);
			return [];
		}
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
			.map(
				(e, i) =>
					`${i + 1}. ${e.summary}${e.success === false ? ' [FAILED]' : ''}${e.elapsedTimeMs ? ` (${e.elapsedTimeMs}ms)` : ''}`
			)
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

		return experienceExtractionPrompt
			.replace('{{AGENT_TYPE}}', input.agentType)
			.replace('{{PROJECT_PATH}}', input.projectPath)
			.replace('{{DURATION}}', durationStr)
			.replace('{{COST}}', costStr)
			.replace('{{HISTORY_ENTRIES}}', historyText || 'N/A')
			.replace('{{GIT_DIFF}}', input.gitDiff || 'N/A')
			.replace('{{VIBES_DATA}}', vibesSection);
	}

	/**
	 * Parse the LLM output into ExtractedExperience[].
	 * Handles JSON extraction from potentially noisy output.
	 */
	parseExperiences(output: string): ExtractedExperience[] {
		try {
			// Try to find a JSON array in the output
			const jsonMatch = output.match(/\[[\s\S]*\]/);
			if (!jsonMatch) return [];

			const parsed = JSON.parse(jsonMatch[0]);
			if (!Array.isArray(parsed)) return [];

			return parsed
				.filter(
					(e: unknown) =>
						typeof e === 'object' &&
						e !== null &&
						typeof (e as Record<string, unknown>).content === 'string' &&
						typeof (e as Record<string, unknown>).situation === 'string' &&
						typeof (e as Record<string, unknown>).learning === 'string' &&
						typeof (e as Record<string, unknown>).noveltyScore === 'number'
				)
				.map((e: Record<string, unknown>) => ({
					content: String(e.content),
					situation: String(e.situation),
					learning: String(e.learning),
					tags: Array.isArray(e.tags) ? e.tags.filter((t: unknown) => typeof t === 'string') : [],
					noveltyScore: Number(e.noveltyScore),
				}));
		} catch {
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

				await store.addMemory(
					{
						content: exp.content,
						type: 'experience',
						scope,
						skillAreaId,
						source: 'session-analysis',
						confidence: 0.5,
						pinned: false,
						tags: exp.tags,
						experienceContext: {
							situation: exp.situation,
							learning: exp.learning,
							sourceSessionId: input.sessionId,
							sourceProjectPath: input.projectPath,
							sourceAgentType: input.agentType,
							diffSummary: input.gitDiff?.slice(0, 500),
							sessionCostUsd: input.sessionCostUsd,
							sessionDurationMs: input.sessionDurationMs,
						},
					},
					scope === 'project' ? input.projectPath : undefined
				);

				stored++;
			} catch {
				// Individual experience storage failed — continue with others
			}
		}

		return stored;
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
	 * Get the current memory config (with defaults for new fields).
	 */
	private async getMemoryConfig(): Promise<{
		enableExperienceExtraction?: boolean;
		minHistoryEntriesForAnalysis?: number;
		minNoveltyScore?: number;
		analysisCooldownMs?: number;
	}> {
		try {
			const { getMemoryStore } = await import('./memory-store');
			const store = getMemoryStore();
			// Config file may contain experience-analyzer-specific keys beyond the typed MemoryConfig
			const raw = (await store.getConfig()) as unknown as Record<string, unknown>;
			return {
				enableExperienceExtraction:
					typeof raw.enableExperienceExtraction === 'boolean'
						? raw.enableExperienceExtraction
						: undefined,
				minHistoryEntriesForAnalysis:
					typeof raw.minHistoryEntriesForAnalysis === 'number'
						? raw.minHistoryEntriesForAnalysis
						: undefined,
				minNoveltyScore: typeof raw.minNoveltyScore === 'number' ? raw.minNoveltyScore : undefined,
				analysisCooldownMs:
					typeof raw.analysisCooldownMs === 'number' ? raw.analysisCooldownMs : undefined,
			};
		} catch {
			return {};
		}
	}
}

// ─── Singleton ──────────────────────────────────────────────────────────────

let _instance: ExperienceAnalyzer | null = null;

export function getExperienceAnalyzer(): ExperienceAnalyzer {
	if (!_instance) {
		_instance = new ExperienceAnalyzer();
	}
	return _instance;
}
