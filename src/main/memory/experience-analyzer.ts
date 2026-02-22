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
							filePath: a.filePath ?? '',
							action: a.action ?? '',
							lineRange: a.lineRange,
						};
					} catch {
						return null;
					}
				})
				.filter((a): a is { filePath: string; action: string; lineRange?: string } => a !== null);
		} catch {
			// VIBES not available — proceed without
		}

		return input;
	}

	/**
	 * Run LLM analysis on gathered session data to extract experiences.
	 * Spawns a batch-mode agent process.
	 *
	 * Stub: will be fully implemented in Task 6.
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
				['--print', '--output-format', 'text', '-p', prompt],
				{ timeout: 120000 }
			);

			return this.parseExperiences(result.stdout ?? '');
		} catch {
			// LLM analysis failed — degrade silently
			return [];
		}
	}

	/**
	 * Compile the analysis prompt from template and input data.
	 *
	 * Stub: will be fully implemented in Task 5/6 with the prompt template.
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

		return [
			'You are an experience extraction agent. Analyze the following coding session data and extract discrete, novel learnings that would be valuable to remember for future similar work.',
			'',
			'## Session Context',
			`- Agent: ${input.agentType}`,
			`- Project: ${input.projectPath}`,
			`- Duration: ${durationStr}`,
			`- Cost: ${costStr}`,
			'',
			'## Session History',
			historyText || 'N/A',
			'',
			'## Code Changes (Git Diff)',
			input.gitDiff || 'N/A',
			'',
			'## VIBES Audit Trail',
			vibesSection,
			'',
			'## Instructions',
			'',
			'Extract 0-5 discrete experiences from this session. Each experience should be:',
			'1. **Novel** — not obvious common knowledge.',
			'2. **Actionable** — something that changes future behavior.',
			'3. **Specific** — grounded in what actually happened, not generic advice.',
			'',
			'If the session was routine with no novel learnings, return an empty array.',
			'',
			'Respond with ONLY a JSON array:',
			'```json',
			'[',
			'  {',
			'    "content": "Short memory-style statement of the learning",',
			'    "situation": "What happened that led to this learning",',
			'    "learning": "The discrete insight or teaching",',
			'    "tags": ["tag1", "tag2"],',
			'    "noveltyScore": 0.0-1.0',
			'  }',
			']',
			'```',
			'',
			'Return `[]` if nothing novel was learned.',
		].join('\n');
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
			return await store.getConfig();
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
