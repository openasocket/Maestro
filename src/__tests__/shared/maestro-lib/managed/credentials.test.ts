/**
 * Approved credential references: the binding (every reference answered,
 * approved or refused with a reason), the brand only `bindApprovedCredentials`
 * applies, and the launch plan resolving an approved reference at the launch
 * boundary with a secret canary, or refusing the launch when it cannot.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
	bindApprovedCredentials,
	describeCredentialRefusals,
	isApprovedCredentialSet,
	managedAccountRef,
	managedCredentialRefProblems,
	type CredentialLaunchBinding,
	type ManagedCredentialRef,
} from '../../../../shared/maestro-lib/managed/credentials';
import {
	buildAgentLaunchPlan,
	isManagedLaunchRefusal,
	type AgentLaunchInput,
} from '../../../../shared/maestro-lib/launch/launch-plan';
import type { ManagedRouteCeiling } from '../../../../shared/maestro-lib/launch/env';
import { MANAGED_CONTRACT_VERSION } from '../../../../shared/maestro-lib/managed/types';
import { getAgentDefinition } from '../../../../shared/maestro-lib/providers/definitions';
import { getAgentCapabilities } from '../../../../shared/maestro-lib/providers/capabilities';
import type { SshRemoteConfig } from '../../../../shared/types';

const CANARY = 'canary-4d1e-approved-value-never-shown';
const ROUTE: ManagedRouteCeiling = {
	providerId: 'claude-code',
	model: null,
	baseUrl: null,
	accountDir: null,
	login: 'approved-credential',
};
const NOW = Date.parse('2026-10-21T12:00:00Z');

const ref = (overrides: Partial<ManagedCredentialRef> = {}): ManagedCredentialRef => ({
	contractVersion: MANAGED_CONTRACT_VERSION,
	refId: 'cred-1',
	tenantId: 'tenant-a',
	actorId: 'actor-1',
	agentId: 'agent-1',
	audience: { providerId: 'claude-code', destination: null },
	accountRef: null,
	policyRevision: 7,
	issuedAt: '2026-10-21T00:00:00Z',
	expiresAt: '2026-10-22T00:00:00Z',
	status: 'active',
	source: { kind: 'server-secret', secretName: 'ANTHROPIC_KEY_TEAM', envVar: 'ANTHROPIC_API_KEY' },
	...overrides,
});

const binding = (overrides: Partial<CredentialLaunchBinding> = {}): CredentialLaunchBinding => ({
	tenantId: 'tenant-a',
	actorId: 'actor-1',
	agentId: 'agent-1',
	providerId: 'claude-code',
	destination: null,
	accountRef: null,
	policyRevision: 7,
	now: NOW,
	...overrides,
});

describe('managedCredentialRefProblems', () => {
	it('accepts a well-formed reference and names every structural fault', () => {
		expect(managedCredentialRefProblems(ref())).toEqual([]);
		expect(managedCredentialRefProblems(null)).toEqual(['credential ref is not an object']);
		const problems = managedCredentialRefProblems({
			...ref(),
			contractVersion: 'other',
			refId: '',
			audience: { providerId: '', destination: 7 },
			policyRevision: 1.5,
			status: 'maybe',
			source: { kind: 'file', secretName: 'bad name', envVar: '1X' },
		});
		expect(problems).toEqual(
			expect.arrayContaining([
				`contractVersion is not ${MANAGED_CONTRACT_VERSION}`,
				'refId is not an id',
				'audience.providerId is not an id',
				'audience.destination is not an id or null',
				'policyRevision is not an integer',
				'status is not active or revoked',
				'source.kind is unknown',
				'source.secretName is not a secret name',
				'source.envVar is not an environment variable name',
			])
		);
	});
});

describe('bindApprovedCredentials', () => {
	it('approves a reference whose every binding matches, and brands the result', () => {
		const set = bindApprovedCredentials([ref()], binding());
		expect(set.approved).toEqual([
			{
				refId: 'cred-1',
				secretName: 'ANTHROPIC_KEY_TEAM',
				envVar: 'ANTHROPIC_API_KEY',
				source: 'server-secret',
				accountRef: null,
				expiresAt: '2026-10-22T00:00:00Z',
			},
		]);
		expect(set.refused).toEqual([]);
		expect(set.boundAt).toBe(new Date(NOW).toISOString());
		expect(isApprovedCredentialSet(set)).toBe(true);
		expect(isApprovedCredentialSet({ ...set })).toBe(false);
		expect(isApprovedCredentialSet(structuredClone(set))).toBe(false);
	});

	it.each([
		['revoked', ref({ status: 'revoked' }), binding()],
		['expired', ref(), binding({ now: Date.parse('2026-10-23T00:00:00Z') })],
		['not-yet-valid', ref(), binding({ now: Date.parse('2026-10-20T00:00:00Z') })],
		['tenant-mismatch', ref(), binding({ tenantId: 'tenant-b' })],
		['actor-mismatch', ref(), binding({ actorId: 'actor-2' })],
		['agent-mismatch', ref(), binding({ agentId: 'agent-2' })],
		['audience-mismatch', ref(), binding({ providerId: 'codex' })],
		['audience-mismatch', ref(), binding({ destination: 'https://gateway.example' })],
		['account-mismatch', ref({ accountRef: 'acct-x' }), binding({ accountRef: 'acct-y' })],
		['policy-revision-mismatch', ref(), binding({ policyRevision: 8 })],
		['policy-revision-mismatch', ref(), binding({ policyRevision: null })],
	] as const)('refuses with %s', (reason, candidate, launch) => {
		const set = bindApprovedCredentials([candidate], launch);
		expect(set.approved).toEqual([]);
		expect(set.refused.map((entry) => entry.reason)).toEqual([reason]);
		expect(describeCredentialRefusals(set.refused)).toContain(reason);
	});

	it('answers every reference, refuses a second value for one variable, and never carries a value', () => {
		const set = bindApprovedCredentials(
			[
				ref({
					refId: 'cred-2',
					source: { kind: 'server-secret', secretName: 'OTHER', envVar: 'ANTHROPIC_API_KEY' },
				}),
				ref(),
				{ refId: 'junk' },
			],
			binding()
		);
		expect(set.approved.map((entry) => entry.refId)).toEqual(['cred-1']);
		expect(set.refused.map((entry) => [entry.refId, entry.reason])).toEqual([
			['cred-2', 'duplicate-env-var'],
			['junk', 'invalid-ref'],
		]);
		expect(JSON.stringify(set)).not.toContain(CANARY);
	});

	it('does not bind an account-bound reference without the launch account, and binds it with it', () => {
		const account = managedAccountRef('claude-code', '/home/u/.claude-team/');
		expect(account).toBe(managedAccountRef('claude-code', '/home/u/.claude-team'));
		expect(account).not.toBe(managedAccountRef('codex', '/home/u/.claude-team'));
		expect(
			bindApprovedCredentials([ref({ accountRef: account })], binding()).refused[0]?.reason
		).toBe('account-mismatch');
		expect(
			bindApprovedCredentials([ref({ accountRef: account })], binding({ accountRef: account }))
				.approved
		).toHaveLength(1);
	});
});

describe('the launch plan under management', () => {
	let tmp: string;
	let runSecrets: string;

	beforeEach(() => {
		tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'managed-credentials-')));
		runSecrets = path.join(tmp, 'run-secrets');
		fs.mkdirSync(runSecrets);
		fs.writeFileSync(path.join(runSecrets, 'ANTHROPIC_KEY_TEAM'), `${CANARY}\n`);
	});
	afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

	const input = (overrides: Partial<AgentLaunchInput> = {}): AgentLaunchInput => ({
		surface: 'desktop',
		agent: {
			...getAgentDefinition('claude-code'),
			capabilities: getAgentCapabilities('claude-code'),
		},
		command: '/usr/local/bin/claude',
		args: ['--print'],
		cwd: '/project',
		prompt: 'hello',
		isWindowsHost: false,
		// A personal key on the agent and a stale one in the "shell".
		sessionCustomEnvVars: { ANTHROPIC_API_KEY: 'personal-key-on-the-agent' },
		secretLookup: { env: { ANTHROPIC_API_KEY: 'stale-shell-key' }, runSecretsDir: runSecrets },
		...overrides,
	});

	it('delivers an approved reference under its env var, over the user layers, on the desktop surface too', () => {
		const set = bindApprovedCredentials([ref()], binding());
		const result = buildAgentLaunchPlan(
			input({ managed: { route: ROUTE, credentials: set, now: NOW } })
		);
		if (!result.ok) throw new Error(result.error);
		expect(result.plan.env?.ANTHROPIC_API_KEY).toBe(CANARY);
		expect(result.plan.managedCredentials).toEqual({
			approved: [{ refId: 'cred-1', envVar: 'ANTHROPIC_API_KEY' }],
			delivered: [{ refId: 'cred-1', envVar: 'ANTHROPIC_API_KEY', source: 'run-secrets' }],
			bindingDigest: set.digest,
			ceiling: { removed: expect.arrayContaining(['ANTHROPIC_API_KEY']), pinned: [] },
		});
		// Names only everywhere but the child's environment.
		const { env: _env, ...rest } = result.plan;
		expect(JSON.stringify(rest)).not.toContain(CANARY);
		expect(JSON.stringify(result.plan.envVars ?? {})).not.toContain(CANARY);
	});

	it('refuses a set that was not bound here, and a set with a refused reference', () => {
		const forged = structuredClone(bindApprovedCredentials([ref()], binding()));
		const unbound = buildAgentLaunchPlan(input({ managed: { route: ROUTE, credentials: forged } }));
		expect(unbound.ok).toBe(false);
		if (!unbound.ok) expect(unbound.reason).toBe('managed-credentials-unbound');

		const set = bindApprovedCredentials(
			[ref(), ref({ refId: 'cred-9', status: 'revoked' })],
			binding()
		);
		const refused = buildAgentLaunchPlan(
			input({ managed: { route: ROUTE, credentials: set, now: NOW } })
		);
		expect(refused.ok).toBe(false);
		if (!refused.ok) {
			expect(refused.reason).toBe('managed-credential-refused');
			expect(refused.error).toContain('cred-9');
			expect(refused.error).toContain('revoked');
			expect(isManagedLaunchRefusal(refused.reason)).toBe(true);
		}
	});

	it('refuses a reference that expired between binding and launch', () => {
		const set = bindApprovedCredentials([ref()], binding());
		const late = buildAgentLaunchPlan(
			input({
				managed: { route: ROUTE, credentials: set, now: Date.parse('2026-10-23T00:00:00Z') },
			})
		);
		expect(late.ok).toBe(false);
		if (!late.ok) expect(late.reason).toBe('managed-credential-refused');
	});

	it('denies when the approved value is missing or unusable, where an ordinary launch would warn and start', () => {
		const set = bindApprovedCredentials(
			[
				ref({
					source: {
						kind: 'server-secret',
						secretName: 'ABSENT_SECRET',
						envVar: 'ANTHROPIC_API_KEY',
					},
				}),
			],
			binding()
		);
		const missing = buildAgentLaunchPlan(
			input({ managed: { route: ROUTE, credentials: set, now: NOW } })
		);
		expect(missing.ok).toBe(false);
		if (!missing.ok) {
			expect(missing.reason).toBe('managed-credential-unavailable');
			expect(missing.error).toContain('ABSENT_SECRET');
		}
		fs.writeFileSync(path.join(runSecrets, 'EMPTY_SECRET'), '');
		const empty = buildAgentLaunchPlan(
			input({
				managed: {
					route: ROUTE,
					credentials: bindApprovedCredentials(
						[
							ref({
								source: {
									kind: 'server-secret',
									secretName: 'EMPTY_SECRET',
									envVar: 'ANTHROPIC_API_KEY',
								},
							}),
						],
						binding()
					),
					now: NOW,
				},
			})
		);
		expect(empty.ok).toBe(false);
		if (!empty.ok) expect(empty.reason).toBe('managed-credential-unavailable');

		// The same name declared the ordinary way still warns and starts.
		const ordinary = buildAgentLaunchPlan(
			input({ surface: 'cue', requiredSecrets: ['ABSENT_SECRET'], sessionCustomEnvVars: {} })
		);
		expect(ordinary.ok).toBe(true);
		if (ordinary.ok) expect(ordinary.plan.secrets?.missing).toEqual(['ABSENT_SECRET']);
	});

	it('ignores requiredSecrets under management: a declared name grants nothing', () => {
		fs.writeFileSync(path.join(runSecrets, 'DECLARED_ONLY'), 'declared-value\n');
		const set = bindApprovedCredentials([ref()], binding());
		const result = buildAgentLaunchPlan(
			input({
				surface: 'cue',
				requiredSecrets: ['DECLARED_ONLY'],
				managed: { route: ROUTE, credentials: set, now: NOW },
			})
		);
		if (!result.ok) throw new Error(result.error);
		expect(result.plan.env?.DECLARED_ONLY).toBeUndefined();
		expect(result.plan.secrets).toBeUndefined();
		expect(result.plan.env?.ANTHROPIC_API_KEY).toBe(CANARY);
	});

	it('never forwards an approved value to an SSH remote: the launch is refused instead', () => {
		const remote: SshRemoteConfig = {
			id: 'r1',
			name: 'box',
			host: 'box.example',
			port: 22,
			username: 'u',
			enabled: true,
		} as SshRemoteConfig;
		const set = bindApprovedCredentials([ref()], binding());
		const result = buildAgentLaunchPlan(
			input({
				managed: { route: ROUTE, credentials: set, now: NOW },
				sshRemoteConfig: { enabled: true, remoteId: 'r1' } as never,
				sshStore: { getSshRemotes: () => [remote] },
			})
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe('managed-credential-remote');
			expect(result.error).not.toContain(CANARY);
		}
	});
});
