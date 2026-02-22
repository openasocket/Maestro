/**
 * Agent Experiences System types — hierarchical knowledge organization.
 *
 * Hierarchy: Role → Persona → Skill Area → Memory
 *
 * - Role: broadest categorization ("Software Developer", "Security Researcher")
 * - Persona: expert profile within a role ("Rust Systems Developer")
 * - Skill Area: domain of expertise within a persona ("Error Handling")
 * - Memory: individual knowledge entries within a skill area
 *
 * Additionally, project-scoped and global memories exist outside the hierarchy
 * for project-specific facts and universal rules.
 *
 * Operates alongside GRPO (separate storage, separate token budget).
 */

// ─── Identifiers ───────────────────────────────────────────────────────────

export type RoleId = string;
export type PersonaId = string;
export type SkillAreaId = string;
export type MemoryId = string;

// ─── Hierarchy ─────────────────────────────────────────────────────────────

/** Top-level role — the broadest categorization of agent behavior */
export interface Role {
	id: RoleId;
	/** Human-readable name (e.g., "Software Developer") */
	name: string;
	/** Description of what this role covers */
	description: string;
	/** Ordered list of persona IDs belonging to this role */
	personaIds: PersonaId[];
	createdAt: number;
	updatedAt: number;
}

/** A persona within a role — a specific expert profile */
export interface Persona {
	id: PersonaId;
	/** Parent role */
	roleId: RoleId;
	/** Human-readable name (e.g., "Rust Systems Developer") */
	name: string;
	/** Description of this persona's expertise */
	description: string;
	/** 384-dim embedding of the description — used for prompt→persona matching */
	embedding: number[] | null;
	/** Ordered list of skill area IDs belonging to this persona */
	skillAreaIds: SkillAreaId[];
	/** Which agent types this persona is assigned to (empty = all agents) */
	assignedAgents: string[];
	/** Which project paths this persona is active in (empty = all projects) */
	assignedProjects: string[];
	/** Whether this persona is active */
	active: boolean;
	createdAt: number;
	updatedAt: number;
}

/** A skill area groups related memories within a persona */
export interface SkillArea {
	id: SkillAreaId;
	/** Parent persona */
	personaId: PersonaId;
	/** Human-readable name (e.g., "Error Handling") */
	name: string;
	/** Description of this skill domain */
	description: string;
	/** 384-dim embedding of the description — used for prompt→skill matching */
	embedding: number[] | null;
	/** Whether this skill area is active */
	active: boolean;
	createdAt: number;
	updatedAt: number;
}

// ─── Memory Entries ────────────────────────────────────────────────────────

/** How the memory was created */
export type MemorySource =
	| 'user' // Manually added by user via UI
	| 'grpo' // Promoted from a GRPO experience
	| 'auto-run' // Auto-collected from Auto Run outcomes
	| 'session-analysis' // Extracted by LLM analysis of session history/VIBES/diffs
	| 'consolidation' // Created by merging similar memories
	| 'import'; // Imported from file

/** Whether the entry is a prescriptive rule or an empirical experience */
export type MemoryType =
	| 'rule' // Declarative: "always do X" — prescriptive, user-curated
	| 'experience'; // Empirical: "we learned Y when Z happened" — contextual, earned through practice

/** Where the memory lives */
export type MemoryScope =
	| 'skill' // Within the hierarchy (Role → Persona → Skill → Memory)
	| 'project' // Project-specific, outside the hierarchy
	| 'global'; // Universal, outside the hierarchy

/** Contextual metadata for experience-type entries */
export interface ExperienceContext {
	/** What happened — brief description of the situation */
	situation: string;
	/** What was learned — the discrete teaching or insight */
	learning: string;
	/** Source session ID where this experience was extracted from */
	sourceSessionId?: string;
	/** Project path where the experience occurred */
	sourceProjectPath?: string;
	/** Agent type that produced this experience */
	sourceAgentType?: string;
	/** Git diff summary (if available) — what changed in the codebase */
	diffSummary?: string;
	/** Token cost of the session that produced this experience */
	sessionCostUsd?: number;
	/** How long the session took (ms) */
	sessionDurationMs?: number;
}

/** A single memory entry — explicit declarative knowledge or empirical experience */
export interface MemoryEntry {
	id: MemoryId;
	/** The memory content — natural-language knowledge, SOP, rule, or experience */
	content: string;
	/** Whether this is a prescriptive rule or an empirical experience */
	type: MemoryType;
	/** Where this memory lives */
	scope: MemoryScope;
	/** For type='experience': contextual metadata about when/how this was learned */
	experienceContext?: ExperienceContext;
	/** For scope='skill': parent skill area ID */
	skillAreaId?: SkillAreaId;
	/** For scope='skill': parent persona ID (denormalized for fast lookup) */
	personaId?: PersonaId;
	/** For scope='skill': parent role ID (denormalized for fast lookup) */
	roleId?: RoleId;
	/** User/system categorization tags (freeform, for filtering) */
	tags: string[];
	/** How this memory was created */
	source: MemorySource;
	/** Confidence score 0.0-1.0 — decays over time if not reinforced */
	confidence: number;
	/** Pinned memories skip pruning and confidence decay */
	pinned: boolean;
	/** Soft-delete flag */
	active: boolean;
	/** 384-dim embedding vector for semantic search, null if not yet computed */
	embedding: number[] | null;
	/** Effectiveness score: EMA of injection→outcome correlation (0.0-1.0) */
	effectivenessScore: number;
	/** How many times this memory has been injected into an agent prompt */
	useCount: number;
	/** Estimated token count for injection budgeting */
	tokenEstimate: number;
	/** When this memory was last injected (ms timestamp) */
	lastUsedAt: number;
	createdAt: number;
	updatedAt: number;
}

// ─── Configuration ─────────────────────────────────────────────────────────

export interface MemoryConfig {
	enabled: boolean;
	/** Maximum token budget for memory injection — default 1500 */
	maxTokenBudget: number;
	/** Minimum cosine similarity to consider a memory relevant — default 0.65 */
	similarityThreshold: number;
	/** Minimum cosine similarity for persona matching (coarser filter) — default 0.40 */
	personaMatchThreshold: number;
	/** Minimum cosine similarity for skill area matching — default 0.50 */
	skillMatchThreshold: number;
	/** Maximum memories per skill area before pruning — default 50 */
	maxMemoriesPerSkillArea: number;
	/** Cosine similarity threshold for consolidation — default 0.85 */
	consolidationThreshold: number;
	/** Confidence decay half-life in days — default 30 */
	decayHalfLifeDays: number;
	enableAutoConsolidation: boolean;
	enableEffectivenessTracking: boolean;
}

export const MEMORY_CONFIG_DEFAULTS: MemoryConfig = {
	enabled: false,
	maxTokenBudget: 1500,
	similarityThreshold: 0.65,
	personaMatchThreshold: 0.4,
	skillMatchThreshold: 0.5,
	maxMemoriesPerSkillArea: 50,
	consolidationThreshold: 0.85,
	decayHalfLifeDays: 30,
	enableAutoConsolidation: true,
	enableEffectivenessTracking: true,
};

// ─── Stats and Results ─────────────────────────────────────────────────────

export interface MemoryStats {
	totalRoles: number;
	totalPersonas: number;
	totalSkillAreas: number;
	totalMemories: number;
	byScope: Record<MemoryScope, number>;
	bySource: Record<MemorySource, number>;
	byType: Record<MemoryType, number>;
	totalInjections: number;
	averageEffectiveness: number;
	pendingEmbeddings: number;
}

export interface MemoryHistoryEntry {
	timestamp: number;
	operation:
		| 'add'
		| 'update'
		| 'delete'
		| 'consolidate'
		| 'create-role'
		| 'update-role'
		| 'delete-role'
		| 'create-persona'
		| 'update-persona'
		| 'delete-persona'
		| 'create-skill'
		| 'update-skill'
		| 'delete-skill';
	entityType: 'role' | 'persona' | 'skill' | 'memory';
	entityId: string;
	content?: string;
	oldContent?: string;
	newContent?: string;
	reason?: string;
	source?: MemorySource;
}

export interface MemorySearchResult {
	entry: MemoryEntry;
	similarity: number;
	combinedScore: number;
	/** Which persona this memory came from (for display) */
	personaName?: string;
	/** Which skill area this memory came from */
	skillAreaName?: string;
}

/** Scope grouping for injected memories — used by effectiveness tracking. */
export interface InjectionScopeGroup {
	scope: MemoryScope;
	skillAreaId?: SkillAreaId;
	projectPath?: string;
	ids: MemoryId[];
}

export interface MemoryInjectionResult {
	injectedPrompt: string;
	injectedIds: MemoryId[];
	tokenCount: number;
	/** Which personas contributed memories */
	personaContributions: { personaId: PersonaId; personaName: string; count: number }[];
	/** How many project/global memories were injected */
	flatScopeCounts: { project: number; global: number };
	/** Scope groupings for effectiveness tracking (EXP-11) */
	scopeGroups: InjectionScopeGroup[];
}

// ─── Seed Data ─────────────────────────────────────────────────────────────

/** Default roles offered during first-time setup */
export const SEED_ROLES: {
	name: string;
	description: string;
	personas: { name: string; description: string; skills: string[] }[];
}[] = [
	{
		name: 'Software Developer',
		description: 'Full-stack software development across languages, frameworks, and paradigms',
		personas: [
			{
				name: 'Rust Systems Developer',
				description:
					'Systems programming in Rust with focus on safety, performance, and correctness',
				skills: ['Error Handling', 'Performance', 'Testing', 'Memory Safety', 'Async/Concurrency'],
			},
			{
				name: 'React Frontend Engineer',
				description: 'React/TypeScript frontend development with modern patterns and tooling',
				skills: ['State Management', 'Component Design', 'Performance', 'Testing', 'Accessibility'],
			},
			{
				name: 'Python Backend Developer',
				description:
					'Python backend services, APIs, and scripting with emphasis on clean architecture',
				skills: ['API Design', 'Testing', 'Database', 'Error Handling', 'Packaging'],
			},
		],
	},
	{
		name: 'Security Researcher',
		description: 'Security analysis, vulnerability assessment, and defensive engineering',
		personas: [
			{
				name: 'Penetration Tester',
				description: 'Systematic security testing of web applications, APIs, and infrastructure',
				skills: ['Web App Testing', 'Network Analysis', 'Reporting'],
			},
			{
				name: 'Code Auditor',
				description: 'Static and dynamic analysis of codebases for security vulnerabilities',
				skills: ['Vulnerability Patterns', 'Dependency Analysis', 'Secure Coding'],
			},
		],
	},
	{
		name: 'DevOps Engineer',
		description: 'Infrastructure, CI/CD, containerization, and operational excellence',
		personas: [
			{
				name: 'CI/CD Specialist',
				description: 'Build pipeline design, test automation, and deployment workflows',
				skills: ['Pipeline Design', 'Docker/Containers', 'Monitoring', 'IaC'],
			},
		],
	},
	{
		name: 'Technical Writer',
		description: 'Documentation, API references, tutorials, and knowledge base authoring',
		personas: [
			{
				name: 'API Documentation',
				description: 'OpenAPI specs, endpoint documentation, and developer guides',
				skills: ['OpenAPI/Swagger', 'Code Examples', 'Changelog'],
			},
		],
	},
];
