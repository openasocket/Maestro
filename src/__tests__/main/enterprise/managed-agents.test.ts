/**
 * MCOMP-23-05: native create/edit against the REAL host handlers. Every case
 * drives `sessions:commitAgent`, `sessions:setMany` or `sessions:setAll` as
 * registered by `registerPersistenceHandlers()`, with the one authority
 * composed by `setAgentMutationAuthority()`. The options and resolver are
 * contract-shaped doubles of the DESKTOP-LOCAL/1 ports (production composes no
 * resolver); they prove the host rule, not native GUI acceptance (MCOMP-24).
 *
 * Covered here and not in persistence.agent-commit.test.ts: clone, wizard and
 * worktree records, edit by field, persistence races (concurrent creates, a
 * revision that moves under an open form, revoked standing, a stale flush after
 * a committed edit), forged request fields, whole-record bypass through
 * `setAll`, and credential canaries that must never leave the host.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ipcMain } from 'electron';

vi.mock('electron', () => ({
	ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
	app: { getPath: vi.fn().mockReturnValue('/mock/user/data'), on: vi.fn() },
	BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));
vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../main/web-server/handlers/bridgeHandlers', () => ({
	broadcastBridgeEvent: vi.fn(),
}));
vi.mock('../../../main/storage/session-image-store', () => ({
	relocateSessionImages: vi.fn(async (sessions: unknown[]) => ({ sessions, relocated: 0 })),
	resolveToDataUrl: vi.fn(),
}));
vi.mock('../../../main/stores/sessions-backup', () => ({
	backupSessionsBeforeWipe: vi.fn(async () => undefined),
}));

import { logger } from '../../../main/utils/logger';
import {
	SESSION_LIFECYCLE_SYNC_CHANNEL,
	registerPersistenceHandlers,
	setAgentMutationAuthority,
	type AgentCommitOutcome,
	type PersistenceHandlerDependencies,
} from '../../../main/ipc/handlers/persistence';
import type { ManagedAgentAuthorityDeps } from '../../../main/agents/agent-config-writes';
import type {
	ManagedAgentOptionField,
	ManagedAgentOptions,
} from '../../../shared/maestro-lib/managed/agent-policy';
import type { StoredSession } from '../../../main/stores/types';

const CANARY = 'sk-ant-CANARY-7f3e9c1d';

const field = (
	choices: ManagedAgentOptionField['choices'],
	over: Partial<ManagedAgentOptionField> = {}
): ManagedAgentOptionField => ({
	choices,
	editable: choices.length > 0,
	minimum: 0,
	maximum: 1,
	lockedReason: choices.length ? null : 'No approved choices are available.',
	...over,
});

/** The live policy the host reads at each commit; tests move its revision under an open form. */
let revision = 7;
const options = (): ManagedAgentOptions =>
	({
		outcome: 'available',
		authority: 'none',
		policyRevision: revision,
		freshness: 'fresh',
		expiresAt: '2099-01-01T00:00:00.000Z',
		operations: ['create', 'edit', 'clone'],
		fields: {
			provider: field([{ kind: 'provider', ref: 'p-claude' }], { minimum: 1 }),
			model: field([
				{ kind: 'model', ref: 'm-opus', providerRef: 'p-claude' },
				{ kind: 'model', ref: 'm-sonnet', providerRef: 'p-claude' },
			]),
			account: field([{ kind: 'account', ref: 'a-team', providerRef: 'p-claude' }]),
			workspace: field([{ kind: 'workspace', ref: 'w-repo' }], { minimum: 1 }),
			credential: field([{ kind: 'credential', ref: 'c-team', accountRef: 'a-team' }]),
			permission: field([{ kind: 'permission', ref: 'perm-std', providerRef: 'p-claude' }]),
			transport: field([]),
			tool: field([]),
			automation: field([]),
		},
	}) as ManagedAgentOptions;

const VALUES: Record<string, string> = {
	'p-claude': 'claude-code',
	'm-opus': 'claude-opus-5-5',
	'm-sonnet': 'claude-sonnet-5-5',
	'a-team': 'acct:team',
	'w-repo': '/work/repo',
	'c-team': 'cred:team',
	'perm-std': 'standard',
};
const resolve = vi.fn((_kind: string, ref: string) => VALUES[ref] ?? null);
let standing: () => boolean = () => true;
const authority = (): ManagedAgentAuthorityDeps => ({
	isManaged: () => standing(),
	options,
	resolver: { version: 1, resolve },
	accountRefOf: () => 'acct:team',
});

const agent = (over: Partial<StoredSession> = {}): StoredSession =>
	({
		id: 'agent-1',
		name: 'Agent',
		toolType: 'claude-code',
		customModel: 'claude-opus-5-5',
		cwd: '/work/repo',
		projectRoot: '/work/repo',
		aiTabs: [{ id: 'tab-1', logs: [{ id: 'l1', text: 'stored turn' }] }],
		...over,
	}) as StoredSession;

describe('native agent create and edit through the host (MCOMP-23-05)', () => {
	let handlers: Map<string, (...args: unknown[]) => unknown>;
	let stored: StoredSession[];
	let sender: { id: number; isDestroyed: () => boolean; send: ReturnType<typeof vi.fn> };
	const call = (channel: string, ...args: unknown[]) =>
		handlers.get(channel)!({ sender } as never, ...args);
	const commit = (request: unknown) =>
		call('sessions:commitAgent', request) as Promise<AgentCommitOutcome>;
	const refused = (outcome: AgentCommitOutcome) =>
		outcome.ok ? [] : outcome.fields.map((f) => f.field);
	const lifecycle = () =>
		sender.send.mock.calls
			.filter((c) => c[0] === SESSION_LIFECYCLE_SYNC_CHANNEL)
			.map((c) => c[1] as { removedIds: string[] });

	beforeEach(() => {
		vi.clearAllMocks();
		revision = 7;
		standing = () => true;
		handlers = new Map();
		vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
			handlers.set(channel, handler as never);
		});
		stored = [];
		sender = { id: 1, isDestroyed: () => false, send: vi.fn() };
		registerPersistenceHandlers({
			settingsStore: { get: vi.fn(), set: vi.fn() } as never,
			sessionsStore: {
				get: () => stored,
				set: (_key: string, value: StoredSession[]) => {
					stored = value;
				},
				path: '/mock/sessions.json',
			} as never,
			groupsStore: { get: () => [], set: vi.fn() } as never,
			getWebServer: () => null,
			flushSessionWrites: async () => {},
		} as PersistenceHandlerDependencies);
		setAgentMutationAuthority(authority());
	});

	afterEach(() => setAgentMutationAuthority(null));

	describe('approved create, clone, wizard and worktree records', () => {
		it('commits an approved create with its credential and permission selections', async () => {
			const outcome = await commit({
				operation: 'create',
				record: agent(),
				expectedPolicyRevision: 7,
				execution: { credentials: ['cred:team'], permission: 'standard' },
			});
			expect(outcome).toMatchObject({ ok: true, managed: true, policyRevision: 7 });
			expect(stored.map((s) => s.id)).toEqual(['agent-1']);
			// The canonical record comes back to the writer; the lifecycle sync is for other clients.
			expect(outcome.ok && outcome.record).toEqual(stored[0]);
		});

		it('a duplicate commits as a clone under the same rule, and an unapproved clone is refused', async () => {
			stored = [agent()];
			const copy = agent({ id: 'agent-2', name: 'Agent (copy)' });
			expect(await commit({ operation: 'clone', record: copy })).toMatchObject({ ok: true });
			const drifted = agent({ id: 'agent-3', customModel: 'gpt-6' });
			const outcome = await commit({ operation: 'clone', record: drifted });
			expect(outcome).toMatchObject({ ok: false, code: 'field' });
			expect(refused(outcome)).toEqual(['model']);
			expect(stored.map((s) => s.id)).toEqual(['agent-1', 'agent-2']);
		});

		it('a wizard-launched agent with an approved directory commits; an unapproved one is refused', async () => {
			const wizard = agent({ id: 'wiz-1', autoRunFolderPath: '/work/repo/.maestro/playbooks' });
			expect(await commit({ operation: 'create', record: wizard })).toMatchObject({ ok: true });
			const outside = await commit({
				operation: 'create',
				record: agent({ id: 'wiz-2', cwd: '/home/me/scratch', projectRoot: '/home/me/scratch' }),
			});
			expect(refused(outside)).toEqual(['workspace']);
			expect(stored.map((s) => s.id)).toEqual(['wiz-1']);
		});

		it('a discovered worktree child outside the approved directories is refused, nothing written', async () => {
			stored = [agent()];
			const child = agent({
				id: 'wt-1',
				parentSessionId: 'agent-1',
				cwd: '/work/repo-worktrees/feature',
				projectRoot: '/work/repo-worktrees/feature',
				worktreeBranch: 'feature',
			} as Partial<StoredSession>);
			const outcome = await commit({ operation: 'create', record: child });
			expect(outcome).toMatchObject({ ok: false, code: 'field', policyRevision: 7 });
			expect(refused(outcome)).toEqual(['workspace']);
			expect(stored.map((s) => s.id)).toEqual(['agent-1']);
		});

		it('an operation the policy does not list is refused before any field is resolved', async () => {
			const outcome = await commit({ operation: 'import', record: agent() });
			expect(outcome).toMatchObject({ ok: false, code: 'operation' });
			expect(resolve).not.toHaveBeenCalled();
		});
	});

	describe('edit by field', () => {
		beforeEach(() => {
			stored = [agent()];
		});

		it('an approved model change commits and keeps the stored transcript', async () => {
			const outcome = await commit({
				operation: 'edit',
				record: { id: 'agent-1', toolType: 'claude-code', customModel: 'claude-sonnet-5-5' },
				expectedPolicyRevision: 7,
			});
			expect(outcome).toMatchObject({ ok: true, policyRevision: 7 });
			expect(stored[0].customModel).toBe('claude-sonnet-5-5');
			expect(stored[0].aiTabs).toEqual(agent().aiTabs);
		});

		it('names only the changed field it refuses and leaves the stored record untouched', async () => {
			const outcome = await commit({
				operation: 'edit',
				record: { ...agent(), cwd: '/elsewhere', name: 'Renamed' },
			});
			expect(refused(outcome)).toEqual(['workspace']);
			expect(stored).toEqual([agent()]);
		});
	});

	describe('persistence races', () => {
		it('two concurrent creates of one id: exactly one commits, the other is a conflict', async () => {
			const [a, b] = await Promise.all([
				commit({ operation: 'create', record: agent({ name: 'First' }) }),
				commit({ operation: 'create', record: agent({ name: 'Second' }) }),
			]);
			expect([a.ok, b.ok]).toEqual([true, false]);
			expect(b).toMatchObject({ code: 'conflict' });
			expect(stored.map((s) => s.name)).toEqual(['First']);
		});

		it('a revision that moves under an open form is stale; the refreshed form then commits', async () => {
			revision = 8;
			const stale = await commit({
				operation: 'create',
				record: agent(),
				expectedPolicyRevision: 7,
			});
			expect(stale).toMatchObject({ ok: false, code: 'stale', policyRevision: 8 });
			expect(stored).toEqual([]);
			const fresh = await commit({
				operation: 'create',
				record: agent(),
				expectedPolicyRevision: 8,
			});
			expect(fresh).toMatchObject({ ok: true, policyRevision: 8 });
		});

		it('standing that cannot be read at commit time is unavailable, never standalone', async () => {
			standing = () => {
				throw new Error('custody sealed');
			};
			const outcome = await commit({ operation: 'create', record: agent() });
			expect(outcome).toMatchObject({ ok: false, code: 'unavailable' });
			expect(stored).toEqual([]);
		});

		it('a flush that was in flight before a committed edit does not revert it', async () => {
			stored = [agent()];
			const before = agent();
			await commit({
				operation: 'edit',
				record: { id: 'agent-1', toolType: 'claude-code', customModel: 'claude-sonnet-5-5' },
			});
			const late = agent({
				aiTabs: [{ id: 'tab-1', logs: [{ id: 'l2', text: 'late turn' }] }],
			} as Partial<StoredSession>);
			await call('sessions:setMany', [late], [], [before]);
			expect(stored[0].customModel).toBe('claude-sonnet-5-5');
			expect(stored[0].aiTabs).toEqual(late.aiTabs);
		});
	});

	describe('forged requests and whole-record bypass', () => {
		it('verdict-shaped fields on the request are ignored; the record is checked as sent', async () => {
			const outcome = await commit({
				operation: 'create',
				record: agent({ customModel: 'gpt-6' }),
				ok: true,
				allowed: true,
				managed: false,
				policyRevision: 7,
				fields: [],
			});
			expect(outcome).toMatchObject({ ok: false, code: 'field' });
			expect(stored).toEqual([]);
		});

		it('an execution selection outside policy is refused by name', async () => {
			const outcome = await commit({
				operation: 'create',
				record: agent(),
				execution: { credentials: ['cred:personal'], permission: 'full' },
			});
			expect(refused(outcome)).toEqual(['credential', 'permission']);
			expect(stored).toEqual([]);
		});

		it('setAll cannot add an unapproved record, and its writer is told it was dropped', async () => {
			stored = [agent()];
			const rogue = agent({ id: 'agent-9', toolType: 'codex' });
			await call('sessions:setAll', [agent(), rogue], [agent()]);
			expect(stored.map((s) => s.id)).toEqual(['agent-1']);
			expect(lifecycle().some((p) => p.removedIds.includes('agent-9'))).toBe(true);
		});
	});

	describe('credential canaries', () => {
		const secretRecord = () =>
			agent({
				customModel: 'gpt-6',
				customEnvVars: { ANTHROPIC_API_KEY: CANARY },
				sessionSshRemoteConfig: { enabled: true, remoteId: 'r1', password: CANARY },
			} as Partial<StoredSession>);

		it('a refusal never echoes a secret the record carries, and the resolver never sees it', async () => {
			const outcome = await commit({ operation: 'create', record: secretRecord() });
			expect(outcome.ok).toBe(false);
			expect(JSON.stringify(outcome)).not.toContain(CANARY);
			expect(JSON.stringify(resolve.mock.calls)).not.toContain(CANARY);
			expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain(CANARY);
			expect(stored).toEqual([]);
		});

		it('a flush refusal logs the field, never the secret', async () => {
			await call('sessions:setMany', [secretRecord()]);
			expect(stored).toEqual([]);
			expect(vi.mocked(logger.warn)).toHaveBeenCalled();
			expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain(CANARY);
		});
	});
});
