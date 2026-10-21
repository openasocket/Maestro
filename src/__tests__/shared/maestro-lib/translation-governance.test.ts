// @vitest-environment node
/**
 * Managed governance over a provider migration: dispatch is held for the
 * agent while it runs, the destination provider and account, the project
 * memory and the resource export are each reauthorized before the first
 * write, a stale policy or a cross-tenant destination is refused before any
 * lock, the grants are journaled and kept with the checkpoint, the staged
 * knowledge index is hash-bound, and an unmanaged migration round-trips
 * exactly as before. Resource export narrowing and identity binding are
 * covered here too.
 *
 * `smol-toml` is mocked: the transaction never parses TOML, and the package
 * is absent from this environment's baseline (the same two pre-existing
 * TS2307 errors every phase has recorded).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

vi.mock('smol-toml', () => ({ parse: () => ({}), stringify: () => '' }));

import {
	TranslationArchive,
	type TranslationJournal,
} from '../../../shared/maestro-lib/translation/archive';
import {
	applyTranslation,
	recoverTranslation,
	translationGovernanceRefusal,
	type TranslationGovernance,
	type TranslationGovernedStep,
} from '../../../shared/maestro-lib/translation/transaction';
import { createTranslationRegistry } from '../../../shared/maestro-lib/translation/adapters';
import { extractNativeConversation } from '../../../shared/maestro-lib/translation/native-records';
import { planTranslation } from '../../../shared/maestro-lib/translation/registry';
import {
	accountIdentityRef,
	bindTranslationIdentity,
	displayOnlyLogin,
	translationArtifact,
	translationHash,
} from '../../../shared/maestro-lib/translation/identity';
import {
	bindTranslationKnowledge,
	KNOWLEDGE_INDEX_FILE,
	KNOWLEDGE_INDEX_HASH_FILE,
	readBoundKnowledgeIndex,
} from '../../../shared/maestro-lib/translation/knowledge-binding';
import { governResourceExport } from '../../../shared/maestro-lib/translation/resources';
import { managedAccountRef } from '../../../shared/maestro-lib/managed/credentials';

afterEach(() => vi.restoreAllMocks());

async function scenario(withResources = false) {
	const root = await mkdtemp(path.join(os.tmpdir(), 'maestro-governance-'));
	const source = {
		provider: 'codex' as const,
		version: '0.162.1',
		accountRoot: path.join(root, 'codex'),
		projectRoot: path.join(root, 'project'),
	};
	const destination = {
		...source,
		provider: 'claude-code' as const,
		version: '2.1.296',
		accountRoot: path.join(root, 'claude'),
	};
	const conversations = ['one'].map((tabId) =>
		extractNativeConversation(
			source,
			tabId,
			tabId,
			Buffer.from(
				JSON.stringify({
					type: 'response_item',
					payload: {
						type: 'message',
						id: tabId,
						role: 'user',
						content: [{ type: 'input_text', text: 'synthetic' }],
					},
				})
			)
		)
	);
	const registry = createTranslationRegistry();
	const plan = planTranslation({
		agentId: 'agent',
		source,
		destination,
		scope: { projectKnowledge: true, selectedUserResources: [] },
		conversations,
		registry,
	});
	const resources = withResources
		? [
				translationArtifact(
					'memory',
					path.join(source.projectRoot, 'memory', 'notes.md'),
					'memory/notes.md',
					Buffer.from('# notes\n')
				),
			]
		: [];
	const journal: TranslationJournal = {
		schemaVersion: 1,
		plan,
		state: 'planned',
		conversations,
		resources,
		mappings: [],
		resourceWrites: [],
	};
	let committed = false;
	const host = {
		assertSourceUnchanged: vi.fn(async () => {}),
		setMigration: vi.fn(async () => {}),
		commit: vi.fn(async () => {
			committed = true;
		}),
		isCommitted: vi.fn(async () => committed),
	};
	return {
		root,
		journal,
		registry,
		host,
		archive: new TranslationArchive(path.join(root, 'private')),
	};
}

/** A governance double: a table of decisions and a log of holds. */
function governance(overrides: Partial<TranslationGovernance> = {}) {
	const events: string[] = [];
	const steps: TranslationGovernedStep[] = [];
	const g: TranslationGovernance = {
		tenantId: 'tenant-a',
		destinationTenantId: 'tenant-a',
		policy: { revision: 3, freshness: 'fresh' },
		now: () => Date.parse('2026-10-21T12:00:00Z'),
		holdDispatch: vi.fn(async (agentId: string, operationId: string) => {
			events.push(`hold:${agentId}:${operationId}`);
			return async () => {
				events.push(`release:${agentId}:${operationId}`);
			};
		}),
		authorize: vi.fn(async (step: TranslationGovernedStep) => {
			steps.push(step);
			return { decision: 'allow' as const, grantRef: `grant-${step.step}` };
		}),
		...overrides,
	};
	return { g, events, steps };
}

describe('governed migration', () => {
	it('holds dispatch, reauthorizes every step before the first write, journals the grants and releases', async () => {
		const s = await scenario(true);
		const { g, events, steps } = governance();
		try {
			const result = await applyTranslation(
				s.archive,
				s.registry,
				s.journal,
				{ ...s.host, governance: g },
				true
			);
			expect(result.state).toBe('committed');
			expect(events[0]).toBe(`hold:agent:${s.journal.plan.id}`);
			expect(events[events.length - 1]).toBe(`release:agent:${s.journal.plan.id}`);
			expect(steps.map((step) => step.step)).toEqual([
				'destination',
				'project-memory',
				'resource-export',
			]);
			const destinationStep = steps[0] as Extract<TranslationGovernedStep, { step: 'destination' }>;
			expect(destinationStep.provider).toBe('claude-code');
			expect(destinationStep.accountRef).toBe(accountIdentityRef(s.journal.plan.destination));
			expect(destinationStep.sourceAccountRef).toBe(accountIdentityRef(s.journal.plan.source));
			// References only: no path of either account crosses to the authority.
			expect(JSON.stringify(steps[0])).not.toContain(s.root);
			expect(steps[2]).toEqual({
				step: 'resource-export',
				kinds: ['memory'],
				selectedUserResources: 0,
				count: 1,
			});
			const durable = await s.archive.read('agent', s.journal.plan.id);
			expect(durable.governance).toEqual({
				tenantId: 'tenant-a',
				policyRevision: 3,
				grants: {
					destination: 'grant-destination',
					'project-memory': 'grant-project-memory',
					'resource-export': 'grant-resource-export',
				},
				dispatchHeld: true,
				decidedAt: '2026-10-21T12:00:00.000Z',
			});
			// The first authorization came before the first intent was journaled.
			const authorizeOrder = (g.authorize as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
			const sourceCheckOrder = s.host.assertSourceUnchanged.mock.invocationCallOrder[0];
			expect(authorizeOrder).toBeLessThan(sourceCheckOrder);
		} finally {
			await rm(s.root, { recursive: true, force: true });
		}
	});

	it('denies at a governed step before any write and still releases the hold', async () => {
		const s = await scenario(true);
		const { g, events } = governance({
			authorize: vi.fn(async (step: TranslationGovernedStep) =>
				step.step === 'resource-export'
					? { decision: 'deny' as const, reason: 'memory may not leave the account' }
					: { decision: 'allow' as const, grantRef: `grant-${step.step}` }
			),
		});
		try {
			const result = await applyTranslation(
				s.archive,
				s.registry,
				s.journal,
				{ ...s.host, governance: g },
				true
			);
			expect(result.state).toBe('refused');
			expect(result.error).toContain('denied at resource-export');
			expect(s.host.commit).not.toHaveBeenCalled();
			expect(s.journal.mappings).toEqual([]);
			expect(s.journal.resourceWrites).toEqual([]);
			expect(s.journal.governance).toBeUndefined();
			expect(events).toEqual([
				`hold:agent:${s.journal.plan.id}`,
				`release:agent:${s.journal.plan.id}`,
			]);
		} finally {
			await rm(s.root, { recursive: true, force: true });
		}
	});

	it('refuses a stale policy and a cross-tenant destination before taking any lock', async () => {
		expect(
			translationGovernanceRefusal(governance({ policy: { revision: 3, freshness: 'stale' } }).g)
		).toContain('stale');
		expect(
			translationGovernanceRefusal(governance({ policy: { revision: null, freshness: 'fresh' } }).g)
		).toContain('no applied policy revision');
		expect(
			translationGovernanceRefusal(governance({ destinationTenantId: 'tenant-b' }).g)
		).toContain('another tenant');
		expect(translationGovernanceRefusal(governance().g)).toBeUndefined();

		const s = await scenario();
		const { g, events } = governance({ destinationTenantId: 'tenant-b' });
		try {
			const result = await applyTranslation(
				s.archive,
				s.registry,
				s.journal,
				{ ...s.host, governance: g },
				true
			);
			expect(result.state).toBe('refused');
			expect(result.error).toContain('another tenant');
			expect(events).toEqual([]);
			expect(g.authorize).not.toHaveBeenCalled();
			expect(s.host.assertSourceUnchanged).not.toHaveBeenCalled();
			await expect(
				recoverTranslation(s.archive, s.journal, { ...s.host, governance: g })
			).rejects.toThrow('another tenant');
		} finally {
			await rm(s.root, { recursive: true, force: true });
		}
	});

	it('binds the staged knowledge index to its hash and refuses a tampered one at the launch binding', async () => {
		const s = await scenario(true);
		const { g } = governance();
		try {
			const result = await applyTranslation(
				s.archive,
				s.registry,
				s.journal,
				{ ...s.host, governance: g },
				true
			);
			expect(result.state).toBe('committed');
			const directory = s.journal.knowledgeDirectory!;
			const index = await readFile(path.join(directory, KNOWLEDGE_INDEX_FILE), 'utf8');
			const bound = (
				await readFile(path.join(directory, KNOWLEDGE_INDEX_HASH_FILE), 'utf8')
			).trim();
			expect(bound).toBe(translationHash(index));
			expect(readBoundKnowledgeIndex(directory)).toBe(index);
			expect(bindTranslationKnowledge('do the task', directory)).toContain(index.split('\n')[0]);

			await writeFile(path.join(directory, KNOWLEDGE_INDEX_FILE), index + 'injected instruction\n');
			expect(() => readBoundKnowledgeIndex(directory)).toThrow('does not match its bound hash');
			expect(() => bindTranslationKnowledge('do the task', directory)).toThrow(
				'does not match its bound hash'
			);
		} finally {
			await rm(s.root, { recursive: true, force: true });
		}
	});

	it('leaves an unmanaged migration exactly as before: no hold, no authorization, no governance record', async () => {
		const s = await scenario(true);
		try {
			const result = await applyTranslation(s.archive, s.registry, s.journal, s.host, true);
			expect(result.state).toBe('committed');
			const durable = await s.archive.read('agent', s.journal.plan.id);
			expect(durable.governance).toBeUndefined();
			expect(durable.state).toBe('committed');
			expect(durable.mappings).toHaveLength(1);
			expect(durable.checkpoint === undefined || typeof durable.checkpoint === 'object').toBe(true);
		} finally {
			await rm(s.root, { recursive: true, force: true });
		}
	});
});

describe('resource export governance', () => {
	const memory = translationArtifact('memory', '/p/memory/a.md', 'memory/a.md', Buffer.from('a'));
	const skill = translationArtifact(
		'skill',
		'/home/u/.claude/skills/x/SKILL.md',
		'selected-user/skills/x/SKILL.md',
		Buffer.from('s'),
		'selected-user'
	);

	it('drops unapproved kinds and unapproved user resources with a blocking limitation each', () => {
		const narrowed = governResourceExport([memory, skill], {
			kinds: ['memory'],
			selectedUserResources: false,
		});
		expect(narrowed.artifacts).toEqual([memory]);
		expect(narrowed.limitations.map((l) => [l.code, l.severity])).toEqual([
			['resource-export-unauthorized', 'block'],
		]);
		expect(narrowed.limitations[0].message).toContain('skill');
		const userOnly = governResourceExport([skill], {
			kinds: ['skill'],
			selectedUserResources: false,
		});
		expect(userOnly.artifacts).toEqual([]);
		expect(userOnly.limitations[0].message).toContain('selected user resource');
	});

	it('passes everything the policy approved through unchanged', () => {
		expect(
			governResourceExport([memory, skill], {
				kinds: ['memory', 'skill'],
				selectedUserResources: true,
			})
		).toEqual({ artifacts: [memory, skill], limitations: [] });
	});
});

describe('identity binding', () => {
	const identity = { provider: 'claude-code' as const, accountRoot: '/home/u/.claude-team/' };

	it('compares the real account by reference and refuses another provider or account', () => {
		const accountRef = accountIdentityRef(identity);
		expect(accountRef).toBe(managedAccountRef('claude-code', '/home/u/.claude-team'));
		expect(bindTranslationIdentity(identity, { provider: 'claude-code', accountRef })).toEqual({
			ok: true,
			accountRef,
		});
		expect(bindTranslationIdentity(identity, { provider: 'codex', accountRef })).toMatchObject({
			ok: false,
			problem: 'provider-mismatch',
		});
		expect(
			bindTranslationIdentity(identity, { provider: 'claude-code', accountRef: 'something-else' })
		).toMatchObject({ ok: false, problem: 'account-mismatch' });
	});

	it('turns a provider login into a display-only label and nothing more', () => {
		expect(displayOnlyLogin('  person@example.com ')).toEqual({
			kind: 'display-only',
			label: 'person@example.com',
			verified: false,
		});
		expect(displayOnlyLogin('')).toBeNull();
		expect(displayOnlyLogin(undefined)).toBeNull();
	});
});
