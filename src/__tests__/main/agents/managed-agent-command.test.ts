/**
 * MCOMP-23-01: the one host create/edit command for governed agent fields.
 * Options are an explicit contract-shaped double of what PolicyStatusService
 * projects; the resolver is a test double of the DESKTOP-LOCAL/1 host port.
 * Neither is production authority. Standalone behavior must stay unchanged.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
	authorizeManagedAgentCommand,
	governedAgentValues,
	managedAgentRepositoryAuthority,
	type ManagedAgentAuthorityDeps,
} from '../../../main/agents/agent-config-writes';
import {
	checkManagedAgentMutation,
	type ManagedAgentOptionField,
	type ManagedAgentOptions,
	type ManagedAgentRefResolver,
} from '../../../shared/maestro-lib/managed/agent-policy';
import { createAgentRepository } from '../../../shared/maestro-lib/agents/repository';
import { DEFAULT_TAB_DEFAULTS } from '../../../shared/maestro-lib/agents/rules';
import { createEventBus } from '../../../shared/maestro-lib/client/event-bus';
import { resolveMaestroPaths } from '../../../shared/maestro-lib/paths/resolve';
import type { AgentRecord } from '../../../shared/maestro-lib/store/records';

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

function options(over: Partial<Record<string, ManagedAgentOptionField>> = {}): ManagedAgentOptions {
	return {
		outcome: 'available',
		authority: 'none',
		policyRevision: 7,
		freshness: 'fresh',
		expiresAt: '2099-01-01T00:00:00.000Z',
		operations: ['create', 'edit', 'clone'],
		fields: {
			provider: field(
				[
					{ kind: 'provider', ref: 'p-claude' },
					{ kind: 'provider', ref: 'p-codex' },
				],
				{ minimum: 1 }
			),
			model: field([
				{ kind: 'model', ref: 'm-opus', providerRef: 'p-claude' },
				{ kind: 'model', ref: 'm-gpt', providerRef: 'p-codex' },
			]),
			account: field([{ kind: 'account', ref: 'a-work', providerRef: 'p-claude' }]),
			workspace: field([{ kind: 'workspace', ref: 'w-repo' }], { minimum: 1 }),
			credential: field([{ kind: 'credential', ref: 'c-key', accountRef: 'a-work' }], {
				maximum: 4,
			}),
			permission: field([
				{ kind: 'permission', ref: 'standard', providerRef: 'p-claude' },
				{ kind: 'permission', ref: 'readonly', providerRef: 'p-codex' },
			]),
			transport: field([{ kind: 'transport', ref: 't-local', providerRef: 'p-claude' }]),
			tool: field([]),
			automation: field([]),
			...over,
		},
	};
}

const VALUES: Record<string, string> = {
	'p-claude': 'claude-code',
	'p-codex': 'codex',
	'm-opus': 'claude-opus-5-5',
	'm-gpt': 'gpt-6',
	'a-work': 'acct-digest-work',
	'w-repo': '/work/repo',
	'c-key': 'cred-ref-1',
	standard: 'standard',
	readonly: 'readonly',
	't-local': 'transport-local',
};
const resolver: ManagedAgentRefResolver = {
	version: 1,
	resolve: (_kind, ref) => VALUES[ref] ?? null,
};

const record = (over: Partial<AgentRecord> = {}): AgentRecord => ({
	id: 'agent-1',
	name: 'Agent',
	toolType: 'claude-code',
	cwd: '/work/repo',
	...over,
});

function deps(over: Partial<ManagedAgentAuthorityDeps> = {}): ManagedAgentAuthorityDeps {
	return {
		isManaged: () => true,
		options: () => options(),
		resolver,
		accountRefOf: (r) => (r.toolType === 'claude-code' ? 'acct-digest-work' : null),
		...over,
	};
}

describe('checkManagedAgentMutation', () => {
	it('admits approved values with their parents and names every refused field', () => {
		const ok = checkManagedAgentMutation(options(), resolver, {
			operation: 'create',
			expectedPolicyRevision: 7,
			values: {
				provider: ['claude-code'],
				model: ['claude-opus-5-5'],
				workspace: ['/work/repo'],
				account: ['acct-digest-work'],
				credential: ['cred-ref-1'],
				permission: ['standard'],
				transport: ['transport-local'],
			},
		});
		expect(ok).toEqual({ allowed: true, policyRevision: 7 });

		const bad = checkManagedAgentMutation(options(), resolver, {
			operation: 'create',
			expectedPolicyRevision: 7,
			// A Codex model under the Claude provider, a forged workspace, readonly on the wrong parent.
			values: {
				provider: ['claude-code'],
				model: ['gpt-6'],
				workspace: ['/etc'],
				permission: ['readonly'],
			},
		});
		expect(bad.allowed).toBe(false);
		if (bad.allowed) return;
		expect(bad.code).toBe('field');
		expect(bad.fields.map((f) => f.field)).toEqual(['model', 'workspace', 'permission']);
	});

	it('refuses a credential whose account was not selected, and duplicates', () => {
		const verdict = checkManagedAgentMutation(options(), resolver, {
			operation: 'create',
			expectedPolicyRevision: null,
			values: {
				provider: ['claude-code'],
				workspace: ['/work/repo'],
				credential: ['cred-ref-1', 'cred-ref-1'],
			},
		});
		expect(verdict.allowed).toBe(false);
		if (verdict.allowed) return;
		expect(verdict.fields).toEqual([
			{ field: 'credential', reason: 'Choose each credential once.' },
		]);
	});

	it('is stale on a changed revision and unavailable without options or a resolver', () => {
		const mutation = {
			operation: 'create' as const,
			expectedPolicyRevision: 6,
			values: { provider: ['claude-code'], workspace: ['/work/repo'] },
		};
		expect(checkManagedAgentMutation(options(), resolver, mutation)).toMatchObject({
			allowed: false,
			code: 'stale',
			policyRevision: 7,
		});
		expect(
			checkManagedAgentMutation(options(), null, { ...mutation, expectedPolicyRevision: 7 })
		).toMatchObject({ allowed: false, code: 'unavailable' });
		expect(
			checkManagedAgentMutation(
				{
					outcome: 'unavailable',
					authority: 'none',
					policyRevision: null,
					freshness: 'stale',
					reason: 'Refresh policy.',
				},
				resolver,
				mutation
			)
		).toMatchObject({ allowed: false, code: 'unavailable', reason: 'Refresh policy.' });
	});

	it('refuses an operation the policy does not list', () => {
		expect(
			checkManagedAgentMutation(options(), resolver, {
				operation: 'import',
				expectedPolicyRevision: 7,
				values: { provider: ['claude-code'], workspace: ['/work/repo'] },
			})
		).toMatchObject({ allowed: false, code: 'operation' });
	});

	it('treats a resolver that throws as no match, never as approval', () => {
		const throwing: ManagedAgentRefResolver = {
			version: 1,
			resolve: () => {
				throw new Error('custody');
			},
		};
		expect(
			checkManagedAgentMutation(options(), throwing, {
				operation: 'create',
				expectedPolicyRevision: 7,
				values: { provider: ['claude-code'], workspace: ['/work/repo'] },
			})
		).toMatchObject({ allowed: false, code: 'field' });
	});
});

describe('authorizeManagedAgentCommand', () => {
	it('admits everything on a standalone installation without reading options', () => {
		const outcome = authorizeManagedAgentCommand(
			deps({
				isManaged: () => false,
				options: () => {
					throw new Error('must not be read');
				},
			}),
			{
				operation: 'create',
				expectedPolicyRevision: null,
				before: null,
				after: record({ toolType: 'x' }),
			}
		);
		expect(outcome).toEqual({ allowed: true, managed: false });
	});

	it('commits an approved managed create (no blanket refusal)', () => {
		expect(
			authorizeManagedAgentCommand(deps(), {
				operation: 'create',
				expectedPolicyRevision: 7,
				before: null,
				after: record({ customModel: 'claude-opus-5-5' }),
				execution: {
					credentials: ['cred-ref-1'],
					permission: 'standard',
					transport: 'transport-local',
				},
			})
		).toEqual({ allowed: true, managed: true, policyRevision: 7 });
	});

	it('refuses an unapproved provider by field and reads the account from the host', () => {
		const outcome = authorizeManagedAgentCommand(deps(), {
			operation: 'create',
			expectedPolicyRevision: 7,
			before: null,
			after: record({ toolType: 'opencode' }),
		});
		expect(outcome).toMatchObject({ allowed: false, code: 'field' });
		if (outcome.allowed) return;
		expect(outcome.fields.map((f) => f.field)).toContain('provider');
	});

	it('on edit checks only governed fields that change, with their parents', () => {
		const before = record({ name: 'Old', customModel: 'unlisted-legacy' });
		// A rename leaves the unapproved legacy model alone.
		expect(
			authorizeManagedAgentCommand(deps(), {
				operation: 'edit',
				expectedPolicyRevision: null,
				before,
				after: { ...before, name: 'New' },
			})
		).toEqual({ allowed: true, managed: true, policyRevision: 7 });
		// Moving the model to a Codex model under Claude is refused on the model field only.
		const moved = authorizeManagedAgentCommand(deps(), {
			operation: 'edit',
			expectedPolicyRevision: 7,
			before,
			after: { ...before, customModel: 'gpt-6' },
		});
		expect(moved).toMatchObject({ allowed: false, code: 'field', fields: [{ field: 'model' }] });
	});

	it('is unavailable when standing or options cannot be read', () => {
		const command = {
			operation: 'create' as const,
			expectedPolicyRevision: 7,
			before: null,
			after: record(),
		};
		expect(
			authorizeManagedAgentCommand(
				deps({
					isManaged: () => {
						throw new Error('x');
					},
				}),
				command
			)
		).toMatchObject({ allowed: false, code: 'unavailable' });
		expect(
			authorizeManagedAgentCommand(
				deps({
					options: () => {
						throw new Error('x');
					},
				}),
				command
			)
		).toMatchObject({ allowed: false, code: 'unavailable' });
	});

	it('extracts governed values without reading environment secrets', () => {
		expect(
			governedAgentValues(
				record({ customEnvVars: { API_KEY: 'secret' }, customModel: '' }),
				() => null
			)
		).toEqual({ provider: ['claude-code'], model: [], workspace: ['/work/repo'], account: [] });
	});
});

describe('repository authorizeAgentMutation', () => {
	let userData: string;
	beforeEach(() => {
		userData = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-agent-command-'));
	});
	afterEach(() => fs.rmSync(userData, { recursive: true, force: true }));

	async function repository(authorize?: ManagedAgentAuthorityDeps) {
		const repo = createAgentRepository({
			paths: resolveMaestroPaths({ env: { MAESTRO_USER_DATA: userData } }),
			bus: createEventBus('[test]'),
			readTabDefaults: async () => DEFAULT_TAB_DEFAULTS,
			checkCwd: () => null,
			...(authorize ? { authorizeAgentMutation: managedAgentRepositoryAuthority(authorize) } : {}),
		});
		const loaded = await repo.load();
		if (!loaded.ok) throw new Error(loaded.failure.message);
		return repo;
	}

	it('commits an approved create and refuses an unapproved one before any write', async () => {
		const repo = await repository(deps());
		const ok = await repo.createAgent({ name: 'A', provider: 'claude-code', cwd: '/work/repo' });
		expect(ok.ok).toBe(true);
		const refused = await repo.createAgent({ name: 'B', provider: 'codex', cwd: '/elsewhere' });
		expect(refused).toMatchObject({ ok: false, error: { code: 'rejected' } });
		expect(repo.listAgents().map((a) => a.name)).toEqual(['A']);
	});

	it('refuses a governed edit, keeps the stored record, and admits a rename', async () => {
		const repo = await repository(deps());
		const created = await repo.createAgent({
			name: 'A',
			provider: 'claude-code',
			cwd: '/work/repo',
		});
		if (!created.ok) throw new Error('create failed');
		const id = created.value.agentId;
		const refused = await repo.updateAgent(id, { model: 'gpt-6' });
		expect(refused).toMatchObject({ ok: false, error: { code: 'rejected' } });
		expect(repo.getAgent(id)?.customModel).toBeUndefined();
		expect((await repo.updateAgent(id, { name: 'Renamed' })).ok).toBe(true);
		expect(repo.getAgent(id)?.name).toBe('Renamed');
	});

	it('leaves a standalone repository unchanged', async () => {
		const repo = await repository();
		const ok = await repo.createAgent({ name: 'Free', provider: 'codex', cwd: '/anywhere' });
		expect(ok.ok).toBe(true);
	});
});
