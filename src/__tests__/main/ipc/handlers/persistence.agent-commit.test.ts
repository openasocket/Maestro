/**
 * MCOMP-23-02: whole-record persistence routed through the host create/edit
 * command. `sessions:commitAgent` is the one validated create/edit operation
 * and returns the canonical record; `sessions:setMany` / `sessions:setAll`
 * cannot change a governed field around it. The options and resolver are
 * contract-shaped test doubles of the DESKTOP-LOCAL/1 ports, never production
 * authority; standalone behavior must stay unchanged.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ipcMain } from 'electron';

vi.mock('electron', () => ({
	ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
	app: { getPath: vi.fn().mockReturnValue('/mock/user/data'), on: vi.fn() },
	BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));
vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../../main/web-server/handlers/bridgeHandlers', () => ({
	broadcastBridgeEvent: vi.fn(),
}));
vi.mock('../../../../main/storage/session-image-store', () => ({
	relocateSessionImages: vi.fn(async (sessions: unknown[]) => ({ sessions, relocated: 0 })),
	resolveToDataUrl: vi.fn(),
}));
vi.mock('../../../../main/stores/sessions-backup', () => ({
	backupSessionsBeforeWipe: vi.fn(async () => undefined),
}));

import {
	SESSION_LIFECYCLE_SYNC_CHANNEL,
	holdTouchedAgentRecords,
	registerPersistenceHandlers,
	setAgentMutationAuthority,
	type AgentCommitOutcome,
	type PersistenceHandlerDependencies,
} from '../../../../main/ipc/handlers/persistence';
import type { ManagedAgentAuthorityDeps } from '../../../../main/agents/agent-config-writes';
import type {
	ManagedAgentOptionField,
	ManagedAgentOptions,
} from '../../../../shared/maestro-lib/managed/agent-policy';
import type { StoredSession } from '../../../../main/stores/types';

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

const OPTIONS: ManagedAgentOptions = {
	outcome: 'available',
	authority: 'none',
	policyRevision: 7,
	freshness: 'fresh',
	expiresAt: '2099-01-01T00:00:00.000Z',
	operations: ['create', 'edit', 'clone'],
	fields: {
		provider: field([{ kind: 'provider', ref: 'p-claude' }], { minimum: 1 }),
		model: field([{ kind: 'model', ref: 'm-opus', providerRef: 'p-claude' }]),
		account: field([]),
		workspace: field([{ kind: 'workspace', ref: 'w-repo' }], { minimum: 1 }),
		credential: field([]),
		permission: field([]),
		transport: field([]),
		tool: field([]),
		automation: field([]),
	},
} as ManagedAgentOptions;

const VALUES: Record<string, string> = {
	'p-claude': 'claude-code',
	'm-opus': 'claude-opus-5-5',
	'w-repo': '/work/repo',
};

/** An enrolled host; `resolver: false` is the production composition (no DESKTOP-LOCAL/1 resolver). */
const managed = (resolver = true): ManagedAgentAuthorityDeps => ({
	isManaged: () => true,
	options: () => OPTIONS,
	resolver: resolver ? { version: 1, resolve: (_kind, ref) => VALUES[ref] ?? null } : null,
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

describe('whole-record persistence through the host mutation policy (MCOMP-23-02)', () => {
	let handlers: Map<string, (...args: unknown[]) => unknown>;
	let stored: StoredSession[];
	let sender: { id: number; isDestroyed: () => boolean; send: ReturnType<typeof vi.fn> };
	const call = (channel: string, ...args: unknown[]) =>
		handlers.get(channel)!({ sender } as never, ...args);
	const commit = (request: unknown) =>
		call('sessions:commitAgent', request) as Promise<AgentCommitOutcome>;
	const sent = () =>
		sender.send.mock.calls
			.filter((c) => c[0] === SESSION_LIFECYCLE_SYNC_CHANNEL)
			.map((c) => c[1] as { removedIds: string[]; updated?: StoredSession[] });

	beforeEach(() => {
		vi.clearAllMocks();
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
	});

	afterEach(() => setAgentMutationAuthority(null));

	describe('standalone (no authority installed)', () => {
		it('commits a create and returns the canonical stored record', async () => {
			const outcome = await commit({ operation: 'create', record: agent({ customModel: 'any' }) });
			expect(outcome).toMatchObject({ ok: true, managed: false, policyRevision: null });
			expect(stored).toHaveLength(1);
			expect(outcome.ok && outcome.record).toEqual(stored[0]);
		});

		it('an edit moves configuration only and keeps the stored transcript', async () => {
			stored = [agent()];
			const outcome = await commit({
				operation: 'edit',
				record: { id: 'agent-1', toolType: 'claude-code', name: 'Renamed', aiTabs: [] },
			});
			expect(outcome.ok).toBe(true);
			expect(stored[0].name).toBe('Renamed');
			expect(stored[0].aiTabs).toEqual(agent().aiTabs);
		});

		it('flushes commit governed changes unchanged', async () => {
			stored = [agent()];
			await call('sessions:setMany', [agent({ customModel: 'other' }), agent({ id: 'agent-2' })]);
			expect(stored.map((s) => [s.id, s.customModel])).toEqual([
				['agent-1', 'other'],
				['agent-2', 'claude-opus-5-5'],
			]);
		});
	});

	describe('managed, with approved choices', () => {
		beforeEach(() => setAgentMutationAuthority(managed()));

		it('commits an approved create with the policy revision (no blanket denial)', async () => {
			const outcome = await commit({
				operation: 'create',
				record: agent(),
				expectedPolicyRevision: 7,
			});
			expect(outcome).toMatchObject({ ok: true, managed: true, policyRevision: 7 });
			expect(stored).toHaveLength(1);
		});

		it('refuses an unapproved model by field and writes nothing', async () => {
			const outcome = await commit({
				operation: 'create',
				record: agent({ customModel: 'gpt-6' }),
			});
			expect(outcome).toMatchObject({ ok: false, code: 'field', policyRevision: 7 });
			expect(!outcome.ok && outcome.fields.map((f) => f.field)).toEqual(['model']);
			expect(stored).toEqual([]);
		});

		it('refuses a form built from another revision as stale', async () => {
			const outcome = await commit({
				operation: 'create',
				record: agent(),
				expectedPolicyRevision: 6,
			});
			expect(outcome).toMatchObject({ ok: false, code: 'stale' });
			expect(stored).toEqual([]);
		});

		it('refuses an operation the policy does not list', async () => {
			const outcome = await commit({ operation: 'import', record: agent() });
			expect(outcome).toMatchObject({ ok: false, code: 'operation' });
		});

		it('refuses forged or conflicting requests by name', async () => {
			expect(await commit({ operation: 'drop', record: agent() })).toMatchObject({
				code: 'invalid',
			});
			expect(await commit({ operation: 'create', record: { name: 'x' } })).toMatchObject({
				code: 'invalid',
			});
			expect(await commit({ operation: 'edit', record: agent() })).toMatchObject({
				code: 'conflict',
			});
			stored = [agent()];
			expect(await commit({ operation: 'create', record: agent() })).toMatchObject({
				code: 'conflict',
			});
		});

		it('a closed agent cannot be re-created by a stale commit', async () => {
			stored = [agent()];
			await call('sessions:setMany', [], ['agent-1']);
			expect(await commit({ operation: 'create', record: agent() })).toMatchObject({
				code: 'conflict',
			});
		});

		it('a flush that moves a governed field to an unapproved value has it put back', async () => {
			stored = [agent()];
			const update = agent({
				customModel: 'gpt-6',
				name: 'Kept',
				aiTabs: [{ id: 'tab-1', logs: [{ id: 'l2', text: 'new turn' }] }],
			} as never);
			await call('sessions:setMany', [update], [], [agent()]);
			expect(stored[0].customModel).toBe('claude-opus-5-5');
			expect(stored[0].name).toBe('Kept');
			expect(stored[0].aiTabs).toEqual(update.aiTabs);
			expect(sent().at(-1)?.updated?.[0].customModel).toBe('claude-opus-5-5');
		});
	});

	describe('managed, production composition (no reference resolver)', () => {
		beforeEach(() => setAgentMutationAuthority(managed(false)));

		it('the commit answers unavailable by name', async () => {
			const outcome = await commit({ operation: 'create', record: agent() });
			expect(outcome).toMatchObject({ ok: false, code: 'unavailable' });
			expect(stored).toEqual([]);
		});

		it('a flushed new record is not persisted and its writer is told', async () => {
			await call('sessions:setMany', [agent()]);
			expect(stored).toEqual([]);
			expect(sent().at(-1)?.removedIds).toEqual(['agent-1']);
		});

		it('setAll cannot change a governed field either', async () => {
			stored = [agent()];
			await call('sessions:setAll', [agent({ cwd: '/elsewhere', name: 'Kept' })], [agent()]);
			expect(stored[0].cwd).toBe('/work/repo');
			expect(stored[0].name).toBe('Kept');
		});

		it('an edit that touches no governed field still commits', async () => {
			stored = [agent()];
			const outcome = await commit({
				operation: 'edit',
				record: { id: 'agent-1', toolType: 'claude-code', name: 'Renamed' },
			});
			expect(outcome).toMatchObject({ ok: true, managed: true });
			expect(stored[0].name).toBe('Renamed');
		});

		it('the plugin store path meets the same rule', () => {
			const previous = new Map([['agent-1', agent()]]);
			const { sessions, refusedIds } = holdTouchedAgentRecords(
				[agent({ toolType: 'codex' }), agent({ id: 'agent-9' })],
				new Set(['agent-1', 'agent-9']),
				previous
			);
			expect(sessions.map((s) => [s.id, s.toolType])).toEqual([['agent-1', 'claude-code']]);
			expect(refusedIds).toEqual(['agent-9']);
		});
	});
});
