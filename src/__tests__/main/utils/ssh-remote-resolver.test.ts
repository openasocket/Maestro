/**
 * Tests for SSH Remote Configuration Resolver.
 *
 * SSH is SESSION-LEVEL ONLY:
 * - Each session can have its own SSH config
 * - No agent-level or global defaults
 */

import { describe, it, expect, vi } from 'vitest';
import {
	getSshRemoteConfig,
	createSshRemoteStoreAdapter,
	SshRemoteSettingsStore,
} from '../../../main/utils/ssh-remote-resolver';
import type { SshRemoteConfig } from '../../../shared/types';

describe('getSshRemoteConfig', () => {
	// Test fixtures
	const remote1: SshRemoteConfig = {
		id: 'remote-1',
		name: 'Dev Server',
		host: 'dev.example.com',
		port: 22,
		username: 'user',
		privateKeyPath: '~/.ssh/id_ed25519',
		enabled: true,
	};

	const remote2: SshRemoteConfig = {
		id: 'remote-2',
		name: 'Production Server',
		host: 'prod.example.com',
		port: 22,
		username: 'admin',
		privateKeyPath: '~/.ssh/id_rsa',
		enabled: true,
	};

	const disabledRemote: SshRemoteConfig = {
		id: 'remote-disabled',
		name: 'Disabled Server',
		host: 'disabled.example.com',
		port: 22,
		username: 'user',
		privateKeyPath: '~/.ssh/id_ed25519',
		enabled: false,
	};

	/**
	 * Create a mock store with specified SSH remotes.
	 * Note: SSH is session-level only - no agent-level or global defaults.
	 */
	function createMockStore(sshRemotes: SshRemoteConfig[] = []): SshRemoteSettingsStore {
		return {
			getSshRemotes: vi.fn(() => sshRemotes),
		};
	}

	describe('when no SSH remotes are configured', () => {
		it('returns null config with source "none"', () => {
			const store = createMockStore([]);
			const result = getSshRemoteConfig(store, {});

			expect(result.config).toBeNull();
			expect(result.source).toBe('none');
		});

		it('returns null even with session SSH config when no remotes exist', () => {
			const store = createMockStore([]);
			const result = getSshRemoteConfig(store, {
				sessionSshConfig: { enabled: true, remoteId: 'remote-1' },
			});

			expect(result.config).toBeNull();
			expect(result.source).toBe('none');
		});
	});

	describe('when no session SSH config is provided (local execution)', () => {
		it('returns null config with source "none" even when remotes exist', () => {
			const store = createMockStore([remote1, remote2]);
			const result = getSshRemoteConfig(store, {});

			// No session config = local execution (no defaults)
			expect(result.config).toBeNull();
			expect(result.source).toBe('none');
		});

		it('returns null when only disabled remotes exist', () => {
			const store = createMockStore([disabledRemote]);
			const result = getSshRemoteConfig(store, {});

			expect(result.config).toBeNull();
			expect(result.source).toBe('none');
		});
	});

	describe('when using session-specific SSH remote config', () => {
		it('returns session config with source "session" when enabled', () => {
			const store = createMockStore([remote1, remote2]);
			const result = getSshRemoteConfig(store, {
				sessionSshConfig: { enabled: true, remoteId: 'remote-2' },
			});

			expect(result.config).toEqual(remote2);
			expect(result.source).toBe('session');
		});

		it('returns null with source "disabled" when session SSH is explicitly disabled', () => {
			const store = createMockStore([remote1, remote2]);
			const result = getSshRemoteConfig(store, {
				sessionSshConfig: { enabled: false, remoteId: null },
			});

			expect(result.config).toBeNull();
			expect(result.source).toBe('disabled');
		});

		it('returns session config when matching remote ID', () => {
			const store = createMockStore([remote1]);
			const result = getSshRemoteConfig(store, {
				sessionSshConfig: { enabled: true, remoteId: 'remote-1' },
			});

			expect(result.config).toEqual(remote1);
			expect(result.source).toBe('session');
		});

		it('returns null with source "none" when session remote ID not found', () => {
			const store = createMockStore([remote1, remote2]);
			const result = getSshRemoteConfig(store, {
				sessionSshConfig: { enabled: true, remoteId: 'non-existent' },
			});

			// Remote not found = local execution
			expect(result.config).toBeNull();
			expect(result.source).toBe('none');
		});

		it('returns null with source "none" when session remote is disabled', () => {
			const store = createMockStore([remote1, disabledRemote]);
			const result = getSshRemoteConfig(store, {
				sessionSshConfig: { enabled: true, remoteId: 'remote-disabled' },
			});

			// Remote disabled = local execution
			expect(result.config).toBeNull();
			expect(result.source).toBe('none');
		});

		it('returns null when session enabled but no remoteId specified', () => {
			const store = createMockStore([remote1]);
			const result = getSshRemoteConfig(store, {
				sessionSshConfig: { enabled: true, remoteId: null },
			});

			expect(result.config).toBeNull();
			expect(result.source).toBe('none');
		});
	});

	describe('priority ordering', () => {
		it('session-specific disabled takes precedence (returns disabled source)', () => {
			const store = createMockStore([remote1]);
			const result = getSshRemoteConfig(store, {
				sessionSshConfig: { enabled: false, remoteId: null },
			});

			expect(result.config).toBeNull();
			expect(result.source).toBe('disabled');
		});

		it('session-specific remote is used when valid', () => {
			const store = createMockStore([remote1, remote2]);
			const result = getSshRemoteConfig(store, {
				sessionSshConfig: { enabled: true, remoteId: 'remote-2' },
			});

			expect(result.config).toEqual(remote2);
			expect(result.source).toBe('session');
		});
	});
});

describe('createSshRemoteStoreAdapter', () => {
	const remote1: SshRemoteConfig = {
		id: 'remote-1',
		name: 'Dev Server',
		host: 'dev.example.com',
		port: 22,
		username: 'user',
		privateKeyPath: '~/.ssh/id_ed25519',
		enabled: true,
	};

	it('creates adapter that delegates to store.get for sshRemotes', () => {
		const mockGet = vi.fn().mockImplementation((key: string, defaultValue: unknown) => {
			if (key === 'sshRemotes') return [remote1];
			return defaultValue;
		});
		const mockStore = { get: mockGet };

		const adapter = createSshRemoteStoreAdapter(mockStore);
		const remotes = adapter.getSshRemotes();

		expect(remotes).toEqual([remote1]);
		expect(mockGet).toHaveBeenCalledWith('sshRemotes', []);
	});

	it('returns empty array for sshRemotes when not set', () => {
		const mockGet = vi.fn().mockImplementation((_key: string, defaultValue: unknown) => {
			return defaultValue;
		});
		const mockStore = { get: mockGet };

		const adapter = createSshRemoteStoreAdapter(mockStore);
		const remotes = adapter.getSshRemotes();

		expect(remotes).toEqual([]);
	});
});

describe('integration with getSshRemoteConfig', () => {
	const remote1: SshRemoteConfig = {
		id: 'remote-1',
		name: 'Dev Server',
		host: 'dev.example.com',
		port: 22,
		username: 'user',
		privateKeyPath: '~/.ssh/id_ed25519',
		enabled: true,
	};

	it('works end-to-end with store adapter and session config', () => {
		const mockGet = vi.fn().mockImplementation((key: string, defaultValue: unknown) => {
			if (key === 'sshRemotes') return [remote1];
			return defaultValue;
		});
		const mockStore = { get: mockGet };

		const adapter = createSshRemoteStoreAdapter(mockStore);
		const result = getSshRemoteConfig(adapter, {
			sessionSshConfig: { enabled: true, remoteId: 'remote-1' },
		});

		expect(result.config).toEqual(remote1);
		expect(result.source).toBe('session');
	});

	it('returns null for local execution when no session config', () => {
		const mockGet = vi.fn().mockImplementation((key: string, defaultValue: unknown) => {
			if (key === 'sshRemotes') return [remote1];
			return defaultValue;
		});
		const mockStore = { get: mockGet };

		const adapter = createSshRemoteStoreAdapter(mockStore);
		const result = getSshRemoteConfig(adapter, {});

		// No session config = local execution
		expect(result.config).toBeNull();
		expect(result.source).toBe('none');
	});
});

/**
 * MRC-08-04: the remote endpoint identity. Under management a remote that
 * resolves is still nothing a launch may be handed to until the runtime THERE
 * attests a standing this host accepts; the rule is pure and the refusal
 * promises the launch ran nowhere.
 */
import {
	qualifySshLaunchTarget,
	resolveSshLaunchTarget,
	sshRemoteEndpointProblems,
	unqualifiedSshLaunchTarget,
	SSH_REMOTE_ARRIVAL_ROUTE,
	type SshRemoteEndpointIdentity,
	type SshRemoteExpectation,
} from '../../../main/utils/ssh-remote-resolver';
import { MANAGED_CONTRACT_VERSION } from '../../../shared/maestro-lib/managed/types';

const buildBox: SshRemoteConfig = {
	id: 'remote-1',
	name: 'Build Box',
	host: 'build.example.com',
	port: 22,
	username: 'ci',
	privateKeyPath: '~/.ssh/id_ed25519',
	enabled: true,
};

const expectation: SshRemoteExpectation = {
	tenantId: 'tenant-1',
	orgId: 'org-1',
	providerId: 'claude-code',
	policyRevision: 3,
};

function attested(overrides: Partial<SshRemoteEndpointIdentity> = {}): SshRemoteEndpointIdentity {
	return {
		contractVersion: MANAGED_CONTRACT_VERSION,
		installationId: 'inst-remote',
		runtimeId: 'headless-42',
		processEpoch: 'epoch-remote',
		tenantId: 'tenant-1',
		orgId: 'org-1',
		authorityId: 'endpoint-remote',
		policyRevision: 3,
		authority: 'registered',
		routes: [
			{ providerId: 'claude-code', route: SSH_REMOTE_ARRIVAL_ROUTE, managed: 'implemented' },
		],
		...overrides,
	};
}

describe('sshRemoteEndpointProblems', () => {
	it('accepts a remote enrolled with the same enterprise, registered, current and confining', () => {
		expect(sshRemoteEndpointProblems(attested(), expectation)).toEqual([]);
	});

	it('accepts a remote ahead of this host, and any remote when this host applies no policy yet', () => {
		expect(sshRemoteEndpointProblems(attested({ policyRevision: 9 }), expectation)).toEqual([]);
		expect(
			sshRemoteEndpointProblems(attested({ policyRevision: null }), {
				...expectation,
				policyRevision: null,
			})
		).toEqual([]);
	});

	it('skips the route-row check for a command that launches no provider, and keeps every other rule', () => {
		const noProvider: SshRemoteExpectation = { ...expectation, providerId: null };
		expect(sshRemoteEndpointProblems(attested({ routes: [] }), noProvider)).toEqual([]);
		expect(
			sshRemoteEndpointProblems(
				attested({ routes: [{ providerId: 'claude-code', route: 'ssh', managed: 'unverified' }] }),
				noProvider
			)
		).toEqual([]);
		expect(sshRemoteEndpointProblems(attested({ authority: 'none' }), noProvider)).toEqual([
			'the remote runtime holds no registered authority (enrolled but unattached, or no actor registered there)',
		]);
		expect(
			sshRemoteEndpointProblems(attested({ tenantId: 'tenant-2' }), noProvider).join('; ')
		).toContain('enrolled with tenant tenant-2');
		expect(
			sshRemoteEndpointProblems(attested({ policyRevision: 2 }), noProvider).join('; ')
		).toContain("behind this host's 3");
		expect(sshRemoteEndpointProblems(attested({ routes: 'none' as never }), noProvider)).toEqual([
			'routes is not an array',
		]);
	});

	it('refuses a malformed attestation as such, before reading anything else', () => {
		expect(sshRemoteEndpointProblems('yes', expectation)).toEqual([
			'the remote attestation is not an object',
		]);
		const problems = sshRemoteEndpointProblems(
			{ ...attested(), contractVersion: 'other/9', tenantId: '', routes: [{ providerId: 1 }] },
			expectation
		);
		expect(problems).toEqual([
			`the remote runtime speaks managed contract other/9, not ${MANAGED_CONTRACT_VERSION}`,
			'tenantId is not an id',
			'routes[0] is not a route row',
		]);
	});

	it.each([
		[
			'another tenant',
			attested({ tenantId: 'tenant-2' }),
			'enrolled with tenant tenant-2 / org org-1, not this host',
		],
		['another org', attested({ orgId: 'org-9' }), 'enrolled with tenant tenant-1 / org org-9'],
		['no registered authority', attested({ authority: 'none' }), 'no registered authority'],
		[
			'a policy behind this host',
			attested({ policyRevision: 2 }),
			"policy revision 2, behind this host's 3",
		],
		[
			'no policy where this host has one',
			attested({ policyRevision: null }),
			"policy revision none, behind this host's 3",
		],
		[
			'no row for the provider',
			attested({ routes: [{ providerId: 'codex', route: 'ssh', managed: 'implemented' }] }),
			'does not report whether it confines claude-code launches arriving over SSH',
		],
		[
			'a row for another route only',
			attested({
				routes: [{ providerId: 'claude-code', route: 'child-process', managed: 'implemented' }],
			}),
			'does not report whether it confines claude-code',
		],
		[
			'an unverified ssh row (what a remote of this build attests)',
			attested({
				routes: [
					{
						providerId: 'claude-code',
						route: 'ssh',
						managed: 'unverified',
						note: 'containment on the remote is not proven here',
					},
				],
			}),
			'does not confine claude-code launches arriving over SSH (its route table says unverified: containment on the remote is not proven here)',
		],
	])('refuses %s', (_case, identity, fragment) => {
		const problems = sshRemoteEndpointProblems(identity, expectation);
		expect(problems.length).toBeGreaterThan(0);
		expect(problems.join('; ')).toContain(fragment);
	});
});

describe('qualifySshLaunchTarget', () => {
	const store = { getSshRemotes: () => [buildBox] };
	const resolved = resolveSshLaunchTarget(store, { enabled: true, remoteId: 'remote-1' });

	it('passes a local or already unresolved target through', () => {
		expect(
			qualifySshLaunchTarget({ kind: 'local' }, { status: 'unreachable', reason: 'x' }, expectation)
		).toEqual({ kind: 'local' });
		const missing = resolveSshLaunchTarget(store, { enabled: true, remoteId: 'gone' });
		expect(
			qualifySshLaunchTarget(missing, { status: 'unreachable', reason: 'x' }, expectation)
		).toBe(missing);
	});

	it('binds the attested identity onto a qualified remote, as a copy', () => {
		const identity = attested();
		const target = qualifySshLaunchTarget(
			resolved,
			{ status: 'attested', identity, via: 'maestro-cli host status --json' },
			expectation
		);
		expect(target).toEqual({ kind: 'remote', remote: buildBox, endpoint: identity });
		if (target.kind !== 'remote') throw new Error('expected remote');
		expect(target.endpoint).not.toBe(identity);
	});

	it.each([
		[
			'the remote is unreachable',
			{ status: 'unreachable' as const, reason: 'Connection refused. Check host and port.' },
			'could not be asked for its managed standing (Connection refused. Check host and port.)',
		],
		[
			'the remote attests no standing',
			{ status: 'unattested' as const, reason: 'no Maestro runtime is running on the remote' },
			'no Maestro runtime is running on the remote.',
		],
		[
			'the attestation fails the expectation',
			{ status: 'attested' as const, identity: attested({ authority: 'none' }), via: 'probe' },
			'holds no registered authority',
		],
		[
			'the attestation is malformed',
			{ status: 'attested' as const, identity: null, via: 'probe' },
			'the remote attestation is not an object',
		],
	])('refuses by name when %s, and the launch runs nowhere', (_case, read, fragment) => {
		const target = qualifySshLaunchTarget(resolved, read, expectation);
		expect(target).toMatchObject({ kind: 'unresolved', reason: 'remote-unqualified' });
		if (target.kind !== 'unresolved') throw new Error('expected unresolved');
		expect(target.message).toContain('"Build Box" is not a qualified managed endpoint');
		expect(target.message).toContain(fragment);
		expect(target.message).toContain('nothing ran on the remote unmanaged');
		expect(target.message).toContain('nothing ran on this machine instead');
	});

	it('names the remote by id when it has no name', () => {
		const target = unqualifiedSshLaunchTarget({ id: 'r-7', name: '' }, 'because.');
		expect(target.message).toContain('"r-7" is not a qualified managed endpoint: because.');
	});
});
