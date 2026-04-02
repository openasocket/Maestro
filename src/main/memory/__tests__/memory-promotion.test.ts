/**
 * Tests for Experience → Rule Promotion pipeline.
 *
 * Covers getPromotionCandidates(), promoteExperience(), dismissPromotion(),
 * and the heuristic rule text generation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('electron', () => ({
	app: {
		getPath: vi.fn(() => '/mock/userData'),
	},
}));

vi.mock('electron-store', () => {
	return {
		default: class MockStore {
			private data: Record<string, unknown> = {};
			constructor(_opts?: unknown) {}
			get(key: string) {
				return this.data[key];
			}
			set(key: string, value: unknown) {
				this.data[key] = value;
			}
		},
	};
});

const fsState = new Map<string, string>();

vi.mock('fs/promises', () => ({
	readFile: vi.fn(async (filePath: string) => {
		const content = fsState.get(filePath);
		if (content === undefined) {
			const err = new Error(
				`ENOENT: no such file or directory, open '${filePath}'`
			) as NodeJS.ErrnoException;
			err.code = 'ENOENT';
			throw err;
		}
		return content;
	}),
	writeFile: vi.fn(async (filePath: string, content: string) => {
		fsState.set(filePath, content);
	}),
	rename: vi.fn(async (from: string, to: string) => {
		const content = fsState.get(from);
		if (content !== undefined) {
			fsState.set(to, content);
			fsState.delete(from);
		}
	}),
	mkdir: vi.fn(async () => {}),
	appendFile: vi.fn(async (filePath: string, content: string) => {
		const existing = fsState.get(filePath) ?? '';
		fsState.set(filePath, existing + content);
	}),
}));

function realCosineSimilarity(a: number[], b: number[]): number {
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}
	const denom = Math.sqrt(normA) * Math.sqrt(normB);
	return denom === 0 ? 0 : dot / denom;
}

const mockEncode = vi.fn(async (..._args: any[]) => new Array(384).fill(0));
const mockEncodeBatch = vi.fn(async (..._args: any[]) =>
	new Array(384).fill(0).map(() => new Array(384).fill(0))
);

vi.mock('../../../main/grpo/embedding-service', () => ({
	encode: (...args: unknown[]) => mockEncode(...args),
	encodeBatch: (...args: unknown[]) => mockEncodeBatch(...args),
	cosineSimilarity: realCosineSimilarity,
	VECTOR_DIM: 384,
}));

import { MemoryStore } from '../../memory/memory-store';

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function createHierarchy(store: MemoryStore) {
	const role = await store.createRole('Dev', 'Development');
	const persona = await store.createPersona(role.id, 'TypeScript Dev', 'TS work');
	const skill = await store.createSkillArea(persona.id, 'Testing', 'Testing expertise');
	return { role, persona, skill };
}

async function addExperience(
	store: MemoryStore,
	skillAreaId: string,
	overrides: Partial<{
		content: string;
		effectivenessScore: number;
		useCount: number;
		confidence: number;
		tags: string[];
		pinned: boolean;
		archived: boolean;
		learningText: string;
	}> = {}
) {
	const entry = await store.addMemory({
		content: overrides.content ?? 'When migrating to ESM, circular imports cause silent failures',
		type: 'experience',
		scope: 'skill',
		skillAreaId,
		tags: overrides.tags ?? [],
		source: 'session-analysis',
		confidence: overrides.confidence ?? 0.8,
		experienceContext: {
			situation: 'ESM migration',
			learning:
				overrides.learningText ?? 'Circular imports cause silent failures during ESM migration',
		},
	});

	// Directly patch the stored entry for testing specific field values
	const dirPath = store.getMemoryPath('skill', skillAreaId);
	const lib = await (store as any).readLibrary(dirPath);
	const idx = lib.entries.findIndex((e: any) => e.id === entry.id);
	if (idx !== -1) {
		if (overrides.effectivenessScore !== undefined) {
			lib.entries[idx].effectivenessScore = overrides.effectivenessScore;
		}
		if (overrides.useCount !== undefined) {
			lib.entries[idx].useCount = overrides.useCount;
		}
		if (overrides.confidence !== undefined) {
			lib.entries[idx].confidence = overrides.confidence;
		}
		if (overrides.pinned !== undefined) {
			lib.entries[idx].pinned = overrides.pinned;
		}
		if (overrides.archived !== undefined) {
			lib.entries[idx].archived = overrides.archived;
		}
		await (store as any).writeLibrary(dirPath, lib);
	}

	return entry;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Experience → Rule Promotion', () => {
	let store: MemoryStore;

	beforeEach(() => {
		fsState.clear();
		mockEncode.mockReset();
		mockEncodeBatch.mockReset();
		mockEncode.mockResolvedValue(new Array(384).fill(0));
		mockEncodeBatch.mockResolvedValue([]);
		store = new MemoryStore();
	});

	// ─── getPromotionCandidates ──────────────────────────────────────────

	describe('getPromotionCandidates()', () => {
		it('returns empty when no experiences qualify', async () => {
			const { skill } = await createHierarchy(store);
			// Add experience that doesn't meet criteria (low effectiveness)
			await addExperience(store, skill.id, {
				effectivenessScore: 0.3,
				useCount: 1,
				confidence: 0.4,
			});

			const candidates = await store.getPromotionCandidates();
			expect(candidates).toHaveLength(0);
		});

		it('returns qualifying experiences as candidates', async () => {
			const { skill } = await createHierarchy(store);
			await addExperience(store, skill.id, {
				effectivenessScore: 0.85,
				useCount: 10,
				confidence: 0.75,
			});

			const candidates = await store.getPromotionCandidates();
			expect(candidates).toHaveLength(1);
			expect(candidates[0].memory.type).toBe('experience');
			expect(candidates[0].suggestedRuleText).toBeTruthy();
			expect(candidates[0].qualificationReason).toContain('85%');
			expect(candidates[0].promotionScore).toBeGreaterThan(0);
			expect(candidates[0].promotionScore).toBeLessThanOrEqual(1);
		});

		it('excludes experiences below effectiveness threshold', async () => {
			const { skill } = await createHierarchy(store);
			await addExperience(store, skill.id, {
				effectivenessScore: 0.69,
				useCount: 10,
				confidence: 0.8,
			});

			const candidates = await store.getPromotionCandidates();
			expect(candidates).toHaveLength(0);
		});

		it('excludes experiences below useCount threshold', async () => {
			const { skill } = await createHierarchy(store);
			await addExperience(store, skill.id, {
				effectivenessScore: 0.8,
				useCount: 4,
				confidence: 0.8,
			});

			const candidates = await store.getPromotionCandidates();
			expect(candidates).toHaveLength(0);
		});

		it('excludes experiences below confidence threshold', async () => {
			const { skill } = await createHierarchy(store);
			await addExperience(store, skill.id, {
				effectivenessScore: 0.8,
				useCount: 10,
				confidence: 0.59,
			});

			const candidates = await store.getPromotionCandidates();
			expect(candidates).toHaveLength(0);
		});

		it('excludes archived experiences', async () => {
			const { skill } = await createHierarchy(store);
			await addExperience(store, skill.id, {
				effectivenessScore: 0.85,
				useCount: 10,
				confidence: 0.8,
				archived: true,
			});

			const candidates = await store.getPromotionCandidates();
			expect(candidates).toHaveLength(0);
		});

		it('excludes pinned experiences', async () => {
			const { skill } = await createHierarchy(store);
			await addExperience(store, skill.id, {
				effectivenessScore: 0.85,
				useCount: 10,
				confidence: 0.8,
				pinned: true,
			});

			const candidates = await store.getPromotionCandidates();
			expect(candidates).toHaveLength(0);
		});

		it('excludes promotion:dismissed experiences', async () => {
			const { skill } = await createHierarchy(store);
			await addExperience(store, skill.id, {
				effectivenessScore: 0.85,
				useCount: 10,
				confidence: 0.8,
				tags: ['promotion:dismissed'],
			});

			const candidates = await store.getPromotionCandidates();
			expect(candidates).toHaveLength(0);
		});

		it('sorts candidates by promotion score descending', async () => {
			const { skill } = await createHierarchy(store);
			await addExperience(store, skill.id, {
				content: 'Low scorer',
				effectivenessScore: 0.7,
				useCount: 5,
				confidence: 0.6,
				learningText: 'Low scoring learning',
			});
			await addExperience(store, skill.id, {
				content: 'High scorer',
				effectivenessScore: 0.95,
				useCount: 20,
				confidence: 0.9,
				learningText: 'High scoring learning',
			});

			const candidates = await store.getPromotionCandidates();
			expect(candidates).toHaveLength(2);
			expect(candidates[0].memory.content).toBe('High scorer');
			expect(candidates[1].memory.content).toBe('Low scorer');
			expect(candidates[0].promotionScore).toBeGreaterThan(candidates[1].promotionScore);
		});

		it('also scans global memories', async () => {
			await createHierarchy(store);
			// Add a global experience manually
			const entry = await store.addMemory({
				content: 'Global experience: always validate inputs',
				type: 'experience',
				scope: 'global',
				tags: [],
				source: 'session-analysis',
				confidence: 0.8,
				experienceContext: {
					situation: 'Validation',
					learning: 'Always validate inputs at system boundaries',
				},
			});
			// Patch it to qualify
			const dirPath = store.getMemoryPath('global');
			const lib = await (store as any).readLibrary(dirPath);
			const idx = lib.entries.findIndex((e: any) => e.id === entry.id);
			if (idx !== -1) {
				lib.entries[idx].effectivenessScore = 0.9;
				lib.entries[idx].useCount = 8;
				lib.entries[idx].confidence = 0.75;
				await (store as any).writeLibrary(dirPath, lib);
			}

			const candidates = await store.getPromotionCandidates();
			expect(candidates).toHaveLength(1);
			expect(candidates[0].memory.scope).toBe('global');
		});
	});

	// ─── Rule Text Generation ────────────────────────────────────────────

	describe('heuristic rule text generation', () => {
		it('uses learning field from experienceContext', async () => {
			const { skill } = await createHierarchy(store);
			await addExperience(store, skill.id, {
				content: 'We discovered that X causes Y',
				effectivenessScore: 0.85,
				useCount: 10,
				confidence: 0.8,
				learningText: 'X causes Y in production',
			});

			const candidates = await store.getPromotionCandidates();
			expect(candidates).toHaveLength(1);
			expect(candidates[0].suggestedRuleText).toBe('Rule: X causes Y in production');
		});

		it('preserves "When" prefix as conditional rule', async () => {
			const { skill } = await createHierarchy(store);
			await addExperience(store, skill.id, {
				effectivenessScore: 0.85,
				useCount: 10,
				confidence: 0.8,
				learningText: 'When migrating to ESM, check for circular imports',
			});

			const candidates = await store.getPromotionCandidates();
			expect(candidates[0].suggestedRuleText).toBe(
				'When migrating to ESM, check for circular imports'
			);
		});

		it('prefixes anti-pattern category with "Avoid:"', async () => {
			const { skill } = await createHierarchy(store);
			await addExperience(store, skill.id, {
				effectivenessScore: 0.85,
				useCount: 10,
				confidence: 0.8,
				tags: ['category:anti-pattern-identified'],
				learningText: 'Using global state for component communication',
			});

			const candidates = await store.getPromotionCandidates();
			expect(candidates[0].suggestedRuleText).toBe(
				'Avoid: Using global state for component communication'
			);
		});

		it('prefixes pattern-established category with "Prefer:"', async () => {
			const { skill } = await createHierarchy(store);
			await addExperience(store, skill.id, {
				effectivenessScore: 0.85,
				useCount: 10,
				confidence: 0.8,
				tags: ['category:pattern-established'],
				learningText: 'Using dependency injection for testability',
			});

			const candidates = await store.getPromotionCandidates();
			expect(candidates[0].suggestedRuleText).toBe(
				'Prefer: Using dependency injection for testability'
			);
		});

		it('prefixes dependency-discovered category with "Ensure:"', async () => {
			const { skill } = await createHierarchy(store);
			await addExperience(store, skill.id, {
				effectivenessScore: 0.85,
				useCount: 10,
				confidence: 0.8,
				tags: ['category:dependency-discovered'],
				learningText: 'Module A must be initialized before module B',
			});

			const candidates = await store.getPromotionCandidates();
			expect(candidates[0].suggestedRuleText).toBe(
				'Ensure: Module A must be initialized before module B'
			);
		});
	});

	// ─── promoteExperience ───────────────────────────────────────────────

	describe('promoteExperience()', () => {
		it('converts experience to rule with approved text', async () => {
			const { skill } = await createHierarchy(store);
			const entry = await addExperience(store, skill.id, {
				effectivenessScore: 0.85,
				useCount: 10,
				confidence: 0.75,
			});

			const result = await store.promoteExperience(
				entry.id,
				'Always check for circular imports when migrating to ESM',
				'skill',
				skill.id
			);

			expect(result).not.toBeNull();
			expect(result!.type).toBe('rule');
			expect(result!.content).toBe('Always check for circular imports when migrating to ESM');
			expect(result!.source).toBe('consolidation');
			expect(result!.confidence).toBeGreaterThanOrEqual(0.8);
			expect(result!.tags).toContain('promoted:experience');
			expect(result!.embedding).toBeNull(); // Cleared for re-computation
			expect(result!.experienceContext).toBeDefined(); // Provenance preserved
		});

		it('boosts confidence to at least 0.8', async () => {
			const { skill } = await createHierarchy(store);
			const entry = await addExperience(store, skill.id, {
				effectivenessScore: 0.85,
				useCount: 10,
				confidence: 0.65,
			});

			const result = await store.promoteExperience(entry.id, 'Rule text', 'skill', skill.id);

			expect(result!.confidence).toBe(0.8);
		});

		it('preserves higher confidence if already above 0.8', async () => {
			const { skill } = await createHierarchy(store);
			const entry = await addExperience(store, skill.id, {
				effectivenessScore: 0.85,
				useCount: 10,
				confidence: 0.95,
			});

			const result = await store.promoteExperience(entry.id, 'Rule text', 'skill', skill.id);

			expect(result!.confidence).toBe(0.95);
		});

		it('returns null for non-experience entries', async () => {
			const { skill } = await createHierarchy(store);
			const rule = await store.addMemory({
				content: 'Already a rule',
				type: 'rule',
				scope: 'skill',
				skillAreaId: skill.id,
			});

			const result = await store.promoteExperience(rule.id, 'Updated rule text', 'skill', skill.id);

			expect(result).toBeNull();
		});

		it('returns null for non-existent memory', async () => {
			await createHierarchy(store);

			const result = await store.promoteExperience('non-existent-id', 'Rule text', 'global');

			expect(result).toBeNull();
		});

		it('records consolidate history entry', async () => {
			const { skill } = await createHierarchy(store);
			const entry = await addExperience(store, skill.id, {
				effectivenessScore: 0.85,
				useCount: 10,
				confidence: 0.75,
			});

			await store.promoteExperience(entry.id, 'Promoted rule text', 'skill', skill.id);

			const dirPath = store.getMemoryPath('skill', skill.id);
			const historyContent = fsState.get(`${dirPath}/history.jsonl`);
			expect(historyContent).toBeDefined();
			const lines = historyContent!.trim().split('\n').filter(Boolean);
			const lastEntry = JSON.parse(lines[lines.length - 1]);
			expect(lastEntry.operation).toBe('consolidate');
			expect(lastEntry.content).toContain('Promoted experience to rule');
		});

		it('no longer appears as promotion candidate after promotion', async () => {
			const { skill } = await createHierarchy(store);
			const entry = await addExperience(store, skill.id, {
				effectivenessScore: 0.85,
				useCount: 10,
				confidence: 0.75,
			});

			// Should appear before promotion
			let candidates = await store.getPromotionCandidates();
			expect(candidates).toHaveLength(1);

			await store.promoteExperience(entry.id, 'Promoted rule text', 'skill', skill.id);

			// Should not appear after promotion (it's now a rule)
			candidates = await store.getPromotionCandidates();
			expect(candidates).toHaveLength(0);
		});
	});

	// ─── dismissPromotion ────────────────────────────────────────────────

	describe('dismissPromotion()', () => {
		it('adds promotion:dismissed tag', async () => {
			const { skill } = await createHierarchy(store);
			const entry = await addExperience(store, skill.id, {
				effectivenessScore: 0.85,
				useCount: 10,
				confidence: 0.8,
			});

			const result = await store.dismissPromotion(entry.id, 'skill', skill.id);
			expect(result).not.toBeNull();
			expect(result!.tags).toContain('promotion:dismissed');
		});

		it('dismissed candidate no longer appears in promotion list', async () => {
			const { skill } = await createHierarchy(store);
			const entry = await addExperience(store, skill.id, {
				effectivenessScore: 0.85,
				useCount: 10,
				confidence: 0.8,
			});

			let candidates = await store.getPromotionCandidates();
			expect(candidates).toHaveLength(1);

			await store.dismissPromotion(entry.id, 'skill', skill.id);

			candidates = await store.getPromotionCandidates();
			expect(candidates).toHaveLength(0);
		});

		it('is idempotent — dismissing twice does not add duplicate tag', async () => {
			const { skill } = await createHierarchy(store);
			const entry = await addExperience(store, skill.id, {
				effectivenessScore: 0.85,
				useCount: 10,
				confidence: 0.8,
			});

			await store.dismissPromotion(entry.id, 'skill', skill.id);
			const result = await store.dismissPromotion(entry.id, 'skill', skill.id);

			const dismissedTags = result!.tags.filter((t) => t === 'promotion:dismissed');
			expect(dismissedTags).toHaveLength(1);
		});

		it('returns null for non-existent memory', async () => {
			await createHierarchy(store);

			const result = await store.dismissPromotion('non-existent', 'global');
			expect(result).toBeNull();
		});
	});

	// ─── Promotion Score Computation ────────────────────────────────────

	describe('promotion score formula', () => {
		it('computes score with formula: eff*0.5 + (use/20)*0.3 + conf*0.2', async () => {
			const { skill } = await createHierarchy(store);
			await addExperience(store, skill.id, {
				effectivenessScore: 0.8,
				useCount: 10,
				confidence: 0.7,
			});

			const candidates = await store.getPromotionCandidates();
			expect(candidates).toHaveLength(1);

			// Expected: 0.8*0.5 + (10/20)*0.3 + 0.7*0.2 = 0.4 + 0.15 + 0.14 = 0.69
			expect(candidates[0].promotionScore).toBeCloseTo(0.69, 2);
		});

		it('clamps useCount contribution to max 1.0 (at 20+ uses)', async () => {
			const { skill } = await createHierarchy(store);
			await addExperience(store, skill.id, {
				effectivenessScore: 1.0,
				useCount: 100,
				confidence: 1.0,
			});

			const candidates = await store.getPromotionCandidates();
			expect(candidates).toHaveLength(1);

			// Expected: 1.0*0.5 + min(1, 100/20)*0.3 + 1.0*0.2 = 0.5 + 0.3 + 0.2 = 1.0
			expect(candidates[0].promotionScore).toBeCloseTo(1.0, 2);
		});
	});
});
