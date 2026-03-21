/**
 * @file team-template-storage.ts
 * @description Storage utilities for Team Templates feature.
 *
 * Team templates are stored in the Maestro config directory under 'team-templates/'.
 * Each template is a '{templateId}.json' file containing the full TeamTemplate object.
 *
 * On first run, built-in templates are seeded from getBuiltinTemplates().
 * Built-in templates are read-only — users can duplicate them to customize.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { app } from 'electron';
import Store from 'electron-store';
import { v4 as uuidv4 } from 'uuid';
import type { TeamTemplate } from '../../shared/group-chat-types';

// ---------------------------------------------------------------------------
// Write serialization & atomic file I/O
// ---------------------------------------------------------------------------

/**
 * Per-template write queue. Serializes all writes for a given template ID
 * so concurrent callers don't race on the same JSON file.
 */
const writeQueues = new Map<string, Promise<void>>();

/**
 * Enqueue an async callback so it runs after all previously queued writes for
 * the same template ID have settled. Returns the callback's result.
 * Automatically cleans up the queue entry once it settles.
 */
function enqueueWrite<T>(templateId: string, fn: () => Promise<T>): Promise<T> {
	const prev = writeQueues.get(templateId) ?? Promise.resolve();
	const next = prev.then(fn, fn);
	const settled = next.then(
		() => {},
		() => {}
	);
	writeQueues.set(templateId, settled);
	settled.then(() => {
		if (writeQueues.get(templateId) === settled) {
			writeQueues.delete(templateId);
		}
	});
	return next;
}

/**
 * Atomically write JSON content to a file by writing to a temp file first,
 * then renaming. Prevents partial/corrupt reads if the process crashes mid-write.
 */
async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
	const tmp = filePath + '.tmp';
	await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
	await fs.rename(tmp, filePath);
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

interface BootstrapSettings {
	customSyncPath?: string;
}

const bootstrapStore = new Store<BootstrapSettings>({
	name: 'maestro-bootstrap',
	defaults: {},
});

/**
 * Get the Maestro config directory path.
 * Uses custom sync path if configured, otherwise falls back to Electron's userData.
 */
function getConfigDir(): string {
	const customPath = bootstrapStore.get('customSyncPath');
	return customPath || app.getPath('userData');
}

/**
 * Get the team templates directory path.
 */
export function getTeamTemplatesDir(): string {
	return path.join(getConfigDir(), 'team-templates');
}

/**
 * Get the file path for a specific team template.
 */
function getTemplatePath(id: string): string {
	return path.join(getTeamTemplatesDir(), `${id}.json`);
}

// ---------------------------------------------------------------------------
// Built-in template seeding
// ---------------------------------------------------------------------------

/** Track whether builtin templates have been seeded this session. */
let builtinSeeded = false;

/**
 * Returns the array of built-in team templates.
 * These are read-only starter templates shipped with Maestro.
 * Built-in templates have deterministic IDs and are read-only — users can
 * duplicate them to customize.
 */
export function getBuiltinTemplates(): TeamTemplate[] {
	const now = Date.now();
	return [
		{
			id: 'builtin-code-review',
			name: 'Code Review Team',
			description:
				'Collaborative code review with implementation, review, and testing perspectives.',
			icon: 'GitPullRequest',
			category: 'builtin',
			createdAt: now,
			updatedAt: now,
			moderatorAgentId: 'claude-code',
			roles: [
				{
					name: 'Implementer',
					agentId: 'claude-code',
					description:
						'Writes and refactors code based on review feedback. Focuses on clean implementation.',
					inputContract: ['Task description', 'Review feedback (if revision)'],
					outputContract: ['Code changes', 'Summary of implementation approach'],
				},
				{
					name: 'Code Reviewer',
					agentId: 'claude-code',
					description:
						'Reviews code for correctness, style, and maintainability. Identifies bugs and suggests improvements.',
					inputContract: ['Code changes to review'],
					outputContract: ['Review comments', 'Approval or rejection with rationale'],
				},
				{
					name: 'Test Writer',
					agentId: 'claude-code',
					description:
						'Writes unit and integration tests to verify code changes. Ensures adequate coverage.',
					inputContract: ['Code changes', 'Review approval'],
					outputContract: ['Test files', 'Coverage report summary'],
				},
			],
			topology: {
				pattern: 'review-loop',
				entryPoint: 'Implementer',
				exitPoint: 'Test Writer',
				edges: [
					{
						source: 'Implementer',
						target: 'Code Reviewer',
						edgeType: 'sequential',
					},
					{
						source: 'Code Reviewer',
						target: 'Test Writer',
						condition: 'Code is approved and ready for testing',
						edgeType: 'conditional',
					},
					{
						source: 'Code Reviewer',
						target: 'Implementer',
						condition: 'Code needs changes or has issues to address',
						edgeType: 'conditional',
					},
				],
			},
		},
		{
			id: 'builtin-research-synthesis',
			name: 'Research & Synthesis Team',
			description: 'Multi-perspective research with analysis and synthesis into a final report.',
			icon: 'BookOpen',
			category: 'builtin',
			createdAt: now,
			updatedAt: now,
			moderatorAgentId: 'claude-code',
			roles: [
				{
					name: 'Researcher',
					agentId: 'claude-code',
					description: 'Gathers information, explores codebases, and surfaces relevant findings.',
					inputContract: ['Research topic', 'Scope constraints'],
					outputContract: ['Raw findings', 'Source references'],
				},
				{
					name: 'Analyst',
					agentId: 'claude-code',
					description:
						'Evaluates findings for patterns, risks, and trade-offs. Provides structured analysis.',
					inputContract: ['Raw findings', 'Source references'],
					outputContract: ['Structured analysis', 'Key patterns and risks'],
				},
				{
					name: 'Synthesizer',
					agentId: 'claude-code',
					description:
						'Combines research and analysis into a coherent final report with actionable recommendations.',
					inputContract: ['Structured analysis', 'Key patterns and risks'],
					outputContract: ['Final report', 'Actionable recommendations'],
				},
			],
			topology: {
				pattern: 'pipeline',
				entryPoint: 'Researcher',
				exitPoint: 'Synthesizer',
				edges: [
					{
						source: 'Researcher',
						target: 'Analyst',
						edgeType: 'sequential',
					},
					{
						source: 'Analyst',
						target: 'Synthesizer',
						edgeType: 'sequential',
					},
				],
			},
		},
		{
			id: 'builtin-full-stack',
			name: 'Full Stack Development',
			description: 'Cross-functional development team for full-stack feature work.',
			icon: 'Layers',
			category: 'builtin',
			createdAt: now,
			updatedAt: now,
			moderatorAgentId: 'claude-code',
			roles: [
				{
					name: 'Frontend Developer',
					agentId: 'claude-code',
					description:
						'Builds UI components, handles client-side logic, and ensures responsive design.',
				},
				{
					name: 'Backend Developer',
					agentId: 'claude-code',
					description:
						'Implements APIs, business logic, and data layer. Focuses on performance and correctness.',
				},
				{
					name: 'DevOps Engineer',
					agentId: 'claude-code',
					description:
						'Handles deployment configuration, CI/CD pipelines, and infrastructure concerns.',
				},
			],
		},
		{
			id: 'builtin-architecture-review',
			name: 'Architecture Review',
			description: 'Technical architecture review from multiple engineering perspectives.',
			icon: 'Building',
			category: 'builtin',
			createdAt: now,
			updatedAt: now,
			moderatorAgentId: 'claude-code',
			roles: [
				{
					name: 'Architect',
					agentId: 'claude-code',
					description:
						'Evaluates system design, component boundaries, and scalability. Proposes structural improvements.',
				},
				{
					name: 'Security Reviewer',
					agentId: 'claude-code',
					description:
						'Audits for security vulnerabilities, access control gaps, and data protection concerns.',
				},
				{
					name: 'Performance Analyst',
					agentId: 'claude-code',
					description:
						'Identifies performance bottlenecks, memory issues, and optimization opportunities.',
				},
			],
		},
	];
}

/**
 * Ensure built-in templates exist on disk. Called lazily on first list/get.
 * Only writes templates whose IDs don't already exist (non-destructive).
 */
async function seedBuiltinTemplates(): Promise<void> {
	if (builtinSeeded) return;
	builtinSeeded = true;

	const dir = getTeamTemplatesDir();
	await fs.mkdir(dir, { recursive: true });

	const builtins = getBuiltinTemplates();
	for (const template of builtins) {
		const templatePath = getTemplatePath(template.id);
		try {
			await fs.access(templatePath);
			// Already exists — don't overwrite (user may have been given a copy)
		} catch {
			// Doesn't exist — seed it
			await atomicWriteJson(templatePath, template);
		}
	}
}

// ---------------------------------------------------------------------------
// CRUD operations
// ---------------------------------------------------------------------------

/**
 * Load a single team template by ID.
 *
 * @param id - The template ID
 * @returns The TeamTemplate object, or null if not found
 */
export async function getTemplate(id: string): Promise<TeamTemplate | null> {
	await seedBuiltinTemplates();
	try {
		const templatePath = getTemplatePath(id);
		const content = await fs.readFile(templatePath, 'utf-8');
		if (!content.trim()) {
			return null;
		}
		return JSON.parse(content) as TeamTemplate;
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return null;
		}
		if (error instanceof SyntaxError) {
			return null;
		}
		throw error;
	}
}

/**
 * List all team templates (builtin + user + exchange).
 *
 * @returns Array of all TeamTemplate objects, sorted by category then name
 */
export async function listTemplates(): Promise<TeamTemplate[]> {
	await seedBuiltinTemplates();
	const dir = getTeamTemplatesDir();

	try {
		const entries = await fs.readdir(dir);
		const templates: TeamTemplate[] = [];

		for (const entry of entries) {
			if (!entry.endsWith('.json') || entry.endsWith('.tmp')) continue;

			const id = entry.replace(/\.json$/, '');
			const template = await getTemplate(id);
			if (template) {
				templates.push(template);
			}
		}

		// Sort: builtin first, then user, then exchange; alphabetical within each
		const categoryOrder: Record<string, number> = { builtin: 0, user: 1, exchange: 2 };
		templates.sort((a, b) => {
			const catDiff = (categoryOrder[a.category] ?? 9) - (categoryOrder[b.category] ?? 9);
			if (catDiff !== 0) return catDiff;
			return a.name.localeCompare(b.name);
		});

		return templates;
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return [];
		}
		throw error;
	}
}

/**
 * Save a team template to disk. Creates or updates the template file.
 * Always sets updatedAt to current time.
 *
 * @param template - The TeamTemplate to save
 */
export function saveTemplate(template: TeamTemplate): Promise<void> {
	return enqueueWrite(template.id, async () => {
		const dir = getTeamTemplatesDir();
		await fs.mkdir(dir, { recursive: true });

		const updated = { ...template, updatedAt: Date.now() };
		const templatePath = getTemplatePath(template.id);
		await atomicWriteJson(templatePath, updated);
	});
}

/**
 * Delete a team template. Only user-created templates can be deleted.
 * Built-in and exchange templates are protected.
 *
 * @param id - The template ID to delete
 * @throws Error if template is not found or is not a user template
 */
export function deleteTemplate(id: string): Promise<void> {
	return enqueueWrite(id, async () => {
		const template = await getTemplate(id);
		if (!template) {
			throw new Error(`Template not found: ${id}`);
		}
		if (template.category !== 'user') {
			throw new Error(
				`Cannot delete ${template.category} template. Only user-created templates can be deleted.`
			);
		}

		const templatePath = getTemplatePath(id);
		const maxRetries = 5;
		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			try {
				await fs.unlink(templatePath);
				return;
			} catch (err) {
				const code = (err as NodeJS.ErrnoException).code;
				if ((code === 'EPERM' || code === 'EBUSY') && attempt < maxRetries) {
					await new Promise((resolve) => setTimeout(resolve, 1000 * Math.pow(2, attempt)));
					continue;
				}
				throw err;
			}
		}
	});
}

/**
 * Duplicate an existing template with a new name.
 * The duplicate is always created as a 'user' template with a new UUID.
 *
 * @param id - The source template ID to duplicate
 * @param newName - The name for the duplicated template
 * @returns The newly created TeamTemplate
 * @throws Error if source template is not found
 */
export function duplicateTemplate(id: string, newName: string): Promise<TeamTemplate> {
	return enqueueWrite(id, async () => {
		const source = await getTemplate(id);
		if (!source) {
			throw new Error(`Template not found: ${id}`);
		}

		const now = Date.now();
		const duplicate: TeamTemplate = {
			...source,
			id: uuidv4(),
			name: newName,
			category: 'user',
			createdAt: now,
			updatedAt: now,
		};

		const dir = getTeamTemplatesDir();
		await fs.mkdir(dir, { recursive: true });

		const templatePath = getTemplatePath(duplicate.id);
		await atomicWriteJson(templatePath, duplicate);

		return duplicate;
	});
}

/**
 * Reset the builtin-seeded flag. Used for testing.
 */
export function _resetSeededFlag(): void {
	builtinSeeded = false;
}
