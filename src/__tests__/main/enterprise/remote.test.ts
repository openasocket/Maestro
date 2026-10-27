/**
 * The remote endpoint identity (MRC-08-04): what the desktop requires of an
 * SSH remote before a managed launch may target it. The probe's reading is
 * pure, the probe runs the launch's own ssh command with a bound, the
 * expectation comes from this host's sealed enrollment (and refuses with
 * none), and the qualifier binds the attested identity to the launch target
 * or refuses by name. Nothing here opens ssh.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const mockBuildSshCommand = vi.fn();
vi.mock('../../../shared/maestro-lib/launch/ssh-command-builder', () => ({
	buildSshCommand: (...args: unknown[]) => mockBuildSshCommand(...args),
}));

import {
	createRemoteEndpointProbe,
	createRemoteEndpointQualifier,
	readRemoteAttestation,
	remoteExpectation,
	REMOTE_ATTESTATION_ARGS,
	REMOTE_ATTESTATION_MAX_BYTES,
	REMOTE_ATTESTATION_TIMEOUT_MS,
	REMOTE_ATTESTATION_VIA,
} from '../../../main/enterprise/remote';
import type { IdentityRead } from '../../../main/enterprise/identity-store';
import { sshRemoteEndpointProblems } from '../../../shared/maestro-lib/launch/ssh-remote-resolver';
import { MANAGED_CONTRACT_VERSION } from '../../../shared/maestro-lib/managed/types';
import type {
	ManagedEnrollmentStatus,
	ManagedIdentityRecord,
	ManagedIdentityView,
} from '../../../shared/maestro-lib/managed/endpoint-port';
import { hostManagedStanding } from '../../../shared/maestro-lib/runtime/server';
import type { SshRemoteConfig } from '../../../shared/types';

const T0 = Date.parse('2026-10-22T12:00:00Z');

const buildBox: SshRemoteConfig = {
	id: 'remote-1',
	name: 'Build Box',
	host: 'build.example.com',
	port: 22,
	username: 'ci',
	privateKeyPath: '',
	enabled: true,
};
const store = { getSshRemotes: () => [buildBox] };

function record(overrides: Partial<ManagedIdentityRecord> = {}): ManagedIdentityRecord {
	return {
		version: 1,
		installationId: 'inst-1',
		tenantId: 'tenant-1',
		orgId: 'org-1',
		enrollmentId: 'enr-1',
		endpoint: {
			socketPath: '/tmp/endpoint.sock',
			bindingDigest: 'a'.repeat(64),
			trustRootDigest: null,
		},
		management: 'enrolled',
		registration: null,
		policy: { desiredRevision: 3, appliedRevision: 3, observedAt: new Date(T0).toISOString() },
		enrolledAt: new Date(T0).toISOString(),
		updatedAt: new Date(T0).toISOString(),
		...overrides,
	};
}

const okRead: IdentityRead = { status: 'ok', record: record(), epoch: 1 };

function attested(overrides: Record<string, unknown> = {}) {
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
		routes: [{ providerId: 'claude-code', route: 'ssh', managed: 'implemented' }],
		...overrides,
	};
}

const running = (managed?: unknown) =>
	JSON.stringify({
		running: true,
		pid: 42,
		startedAt: T0,
		uptimeMs: 1000,
		lock: { mode: 'headless', pid: 42 },
		clients: 0,
		work: { turns: 0, runs: [] },
		cue: { state: 'off' },
		...(managed === undefined ? {} : { managed }),
	});

describe('readRemoteAttestation', () => {
	it('is unreachable when ssh fails, with the connection error described', () => {
		expect(
			readRemoteAttestation({
				stdout: '',
				stderr: 'ssh: connect to host build.example.com port 22: Connection refused',
				exitCode: 255,
			})
		).toEqual({ status: 'unreachable', reason: 'Connection refused. Check host and port.' });
	});

	it("is unreachable when the remote has no maestro-cli, with the shell's own words", () => {
		expect(
			readRemoteAttestation({
				stdout: '',
				stderr: 'bash: line 1: maestro-cli: command not found',
				exitCode: 127,
			})
		).toEqual({ status: 'unreachable', reason: 'bash: line 1: maestro-cli: command not found' });
		expect(readRemoteAttestation({ stdout: '', stderr: '', exitCode: 1 })).toEqual({
			status: 'unreachable',
			reason: 'the probe exited 1 with no output',
		});
	});

	it('is unattested when the remote answers no report, no running host, or a host with no managed standing', () => {
		expect(readRemoteAttestation({ stdout: 'hello\n', stderr: '', exitCode: 0 })).toEqual({
			status: 'unattested',
			reason: 'the remote ran the probe but answered no status report',
		});
		expect(
			readRemoteAttestation({
				stdout: JSON.stringify({ running: false, reason: 'No host is running.' }),
				stderr: '',
				exitCode: 3,
			})
		).toEqual({
			status: 'unattested',
			reason: 'no Maestro runtime is running on the remote (No host is running.)',
		});
		const noManaged = readRemoteAttestation({ stdout: running(), stderr: '', exitCode: 0 });
		expect(noManaged.status).toBe('unattested');
		if (noManaged.status !== 'unattested') throw new Error('expected unattested');
		expect(noManaged.reason).toContain('reports no managed standing');
		expect(noManaged.reason).toContain('holds no enrollment, or predates the attestation');
	});

	it("reads a real host's report as attested, and the rule refuses this build's host by its own word", () => {
		// The producer the headless host answers `host status` with (MRC-08-04A), over an in-memory
		// custody view and a registered standing, printed the way `hostStatus --json` prints it.
		const view: ManagedIdentityView = {
			status: 'ok',
			reason: null,
			message: null,
			record: record({ installationId: 'inst-remote' }),
		};
		const standing: ManagedEnrollmentStatus = {
			identity: view,
			connection: null,
			endpoint: null,
			authority: 'registered',
			reason: null,
			pendingApproval: null,
			lastDenial: null,
		};
		const managed = hostManagedStanding({
			installation: {
				installationId: 'inst-remote',
				runtimeId: 'host-42',
				processEpoch: 'epoch-remote',
			},
			host: {
				identity: { read: () => view },
				policy: () => ({ sources: [], policyRevision: 3 }),
				status: () => standing,
			},
		});
		expect(managed).toBeDefined();
		const read = readRemoteAttestation({ stdout: running(managed), stderr: '', exitCode: 0 });
		expect(read).toEqual({ status: 'attested', identity: managed, via: REMOTE_ATTESTATION_VIA });
		if (read.status !== 'attested') throw new Error('expected attested');
		const problems = sshRemoteEndpointProblems(read.identity, {
			tenantId: 'tenant-1',
			orgId: 'org-1',
			providerId: 'claude-code',
			policyRevision: 3,
		});
		// Shape, enterprise, authority and policy all pass; the one refusal is the ssh row this
		// build attests `unsupported` (its confinement column; the route itself is `unverified`).
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain('route table says unsupported');
	});

	it('is attested with the raw managed value, unread, when a running host reports one', () => {
		const identity = attested();
		expect(
			readRemoteAttestation({ stdout: `\n${running(identity)}\n`, stderr: '', exitCode: 0 })
		).toEqual({
			status: 'attested',
			identity,
			via: REMOTE_ATTESTATION_VIA,
		});
		// Not accepted here: a nonsense value is still handed on to the rule.
		expect(
			readRemoteAttestation({ stdout: running('nonsense'), stderr: '', exitCode: 0 })
		).toMatchObject({
			status: 'attested',
			identity: 'nonsense',
		});
	});

	it('refuses to read an answer larger than a status report', () => {
		const huge = running(attested({ note: 'x'.repeat(REMOTE_ATTESTATION_MAX_BYTES) }));
		const read = readRemoteAttestation({ stdout: huge, stderr: '', exitCode: 0 });
		expect(read.status).toBe('unattested');
		if (read.status !== 'unattested') throw new Error('expected unattested');
		expect(read.reason).toContain('where a status report was expected');
	});
});

describe('createRemoteEndpointProbe', () => {
	it("runs the launch's own ssh command for maestro-cli host status --json, bounded in time", async () => {
		mockBuildSshCommand.mockResolvedValueOnce({
			command: '/usr/bin/ssh',
			args: ['-T', 'ci@build.example.com', '/bin/bash -c ...'],
		});
		const execSsh = vi.fn(async () => ({
			stdout: running(attested()),
			stderr: '',
			exitCode: 0,
		}));
		const probe = createRemoteEndpointProbe({ execSsh });
		const read = await probe(buildBox);
		expect(mockBuildSshCommand).toHaveBeenCalledWith(buildBox, {
			command: 'maestro-cli',
			args: [...REMOTE_ATTESTATION_ARGS],
		});
		expect(execSsh).toHaveBeenCalledWith(
			'/usr/bin/ssh',
			['-T', 'ci@build.example.com', '/bin/bash -c ...'],
			REMOTE_ATTESTATION_TIMEOUT_MS
		);
		expect(read.status).toBe('attested');
	});

	it('honors a custom program and timeout', async () => {
		mockBuildSshCommand.mockResolvedValueOnce({ command: 'ssh', args: ['h'] });
		const execSsh = vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 255 }));
		await createRemoteEndpointProbe({
			execSsh,
			cliCommand: '/opt/maestro/bin/maestro-cli',
			timeoutMs: 500,
		})(buildBox);
		expect(mockBuildSshCommand).toHaveBeenCalledWith(buildBox, {
			command: '/opt/maestro/bin/maestro-cli',
			args: [...REMOTE_ATTESTATION_ARGS],
		});
		expect(execSsh).toHaveBeenCalledWith('ssh', ['h'], 500);
	});

	it('is unreachable, never a thrown error, when the command cannot be built or run', async () => {
		mockBuildSshCommand.mockRejectedValueOnce(new Error('no ssh binary'));
		const probe = createRemoteEndpointProbe({ execSsh: vi.fn() });
		expect(await probe(buildBox)).toEqual({ status: 'unreachable', reason: 'no ssh binary' });

		mockBuildSshCommand.mockResolvedValueOnce({ command: 'ssh', args: [] });
		const failing = createRemoteEndpointProbe({
			execSsh: async () => {
				throw new Error('spawn ETIMEDOUT');
			},
		});
		expect(await failing(buildBox)).toEqual({ status: 'unreachable', reason: 'spawn ETIMEDOUT' });
	});
});

describe('remoteExpectation', () => {
	it("is this host's enterprise and applied policy, for the provider", () => {
		expect(remoteExpectation(okRead, 'codex')).toEqual({
			ok: true,
			expect: { tenantId: 'tenant-1', orgId: 'org-1', providerId: 'codex', policyRevision: 3 },
		});
		expect(
			remoteExpectation(
				{
					status: 'ok',
					record: record({
						policy: { desiredRevision: null, appliedRevision: null, observedAt: null },
					}),
					epoch: 1,
				},
				'codex'
			)
		).toMatchObject({ ok: true, expect: { policyRevision: null } });
	});

	it('refuses with no trusted enrollment to compare against, rather than accepting any remote', () => {
		expect(remoteExpectation({ status: 'none' }, 'codex')).toEqual({
			ok: false,
			detail: 'this host holds no enrollment to compare the remote against.',
		});
		const untrusted = remoteExpectation(
			{ status: 'untrusted', reason: 'rollback', message: 'the file is older than its anchor' },
			'codex'
		);
		expect(untrusted.ok).toBe(false);
		if (untrusted.ok) throw new Error('expected refusal');
		expect(untrusted.detail).toContain('custody is untrusted (the file is older than its anchor)');
		const unprotected = remoteExpectation(
			{
				status: 'unprotected',
				reason: 'encryption-unavailable',
				message: 'no keychain',
				fileExists: true,
			},
			'codex'
		);
		expect(unprotected).toMatchObject({ ok: false });
	});
});

describe('createRemoteEndpointQualifier', () => {
	const qualifier = (
		read: IdentityRead,
		probe = vi.fn(async () => ({ status: 'attested' as const, identity: attested(), via: 'probe' }))
	) => ({
		probe,
		qualifier: createRemoteEndpointQualifier({ identity: { read: () => read }, probe }),
	});

	it('is local when SSH is off, and asks nothing', async () => {
		const { qualifier: q, probe } = qualifier(okRead);
		expect(
			await q.qualify({
				sshConfig: { enabled: false, remoteId: 'remote-1' },
				sshStore: store,
				providerId: 'claude-code',
			})
		).toEqual({ kind: 'local' });
		expect(
			await q.qualify({ sshConfig: undefined, sshStore: store, providerId: 'claude-code' })
		).toEqual({ kind: 'local' });
		expect(probe).not.toHaveBeenCalled();
	});

	it("is the resolver's refusal for a remote that does not resolve, before asking", async () => {
		const { qualifier: q, probe } = qualifier(okRead);
		const target = await q.qualify({
			sshConfig: { enabled: true, remoteId: 'gone' },
			sshStore: store,
			providerId: 'claude-code',
		});
		expect(target).toMatchObject({ kind: 'unresolved', reason: 'remote-not-found' });
		expect(probe).not.toHaveBeenCalled();
	});

	it('binds the attested identity onto a qualified remote', async () => {
		const { qualifier: q, probe } = qualifier(okRead);
		const target = await q.qualify({
			sshConfig: { enabled: true, remoteId: 'remote-1' },
			sshStore: store,
			providerId: 'claude-code',
		});
		expect(probe).toHaveBeenCalledWith(buildBox);
		expect(target).toEqual({ kind: 'remote', remote: buildBox, endpoint: attested() });
	});

	it('refuses with no trusted local enrollment, without asking the remote', async () => {
		const { qualifier: q, probe } = qualifier({ status: 'none' });
		const target = await q.qualify({
			sshConfig: { enabled: true, remoteId: 'remote-1' },
			sshStore: store,
			providerId: 'claude-code',
		});
		expect(target).toMatchObject({ kind: 'unresolved', reason: 'remote-unqualified' });
		if (target.kind !== 'unresolved') throw new Error('expected unresolved');
		expect(target.message).toContain('holds no enrollment to compare the remote against');
		expect(target.message).toContain('nothing ran on this machine instead');
		expect(probe).not.toHaveBeenCalled();
	});

	it("refuses by the remote's own word: unreachable, unattested, or a route it does not confine", async () => {
		const cases = [
			[
				{ status: 'unreachable' as const, reason: 'Connection timed out. Check host and network.' },
				'could not be asked',
			],
			[
				{
					status: 'unattested' as const,
					reason: 'no Maestro runtime is running on the remote (No host is running.)',
				},
				'no Maestro runtime',
			],
			[
				{
					status: 'attested' as const,
					identity: attested({
						routes: [{ providerId: 'claude-code', route: 'ssh', managed: 'unverified' }],
					}),
					via: 'probe',
				},
				'route table says unverified',
			],
			[
				{ status: 'attested' as const, identity: attested({ policyRevision: 1 }), via: 'probe' },
				"behind this host's 3",
			],
		] as const;
		for (const [read, fragment] of cases) {
			const { qualifier: q } = qualifier(
				okRead,
				vi.fn(async () => read)
			);
			const target = await q.qualify({
				sshConfig: { enabled: true, remoteId: 'remote-1' },
				sshStore: store,
				providerId: 'claude-code',
			});
			expect(target).toMatchObject({ kind: 'unresolved', reason: 'remote-unqualified' });
			if (target.kind !== 'unresolved') throw new Error('expected unresolved');
			expect(target.message).toContain(fragment);
			expect(target.message).toContain('nothing ran on the remote unmanaged');
		}
	});

	it('uses the real probe by default, exposed for the host to reuse', () => {
		const q = createRemoteEndpointQualifier({ identity: { read: () => okRead } });
		expect(typeof q.probe).toBe('function');
	});

	describe('qualifyResolved (a command that launches no provider, MRC2-04-01A)', () => {
		it('binds the attested identity onto a remote the caller already holds, with no provider route to confine', async () => {
			const { qualifier: q, probe } = qualifier(okRead);
			const target = await q.qualifyResolved(buildBox);
			expect(probe).toHaveBeenCalledWith(buildBox);
			expect(target).toEqual({ kind: 'remote', remote: buildBox, endpoint: attested() });
			expect(remoteExpectation(okRead, null)).toMatchObject({
				ok: true,
				expect: { tenantId: 'tenant-1', orgId: 'org-1', providerId: null, policyRevision: 3 },
			});
		});

		it('accepts a remote whose route table confines no provider, and still refuses on its enrollment', async () => {
			const noRoutes = attested({ routes: [] });
			const { qualifier: q } = qualifier(
				okRead,
				vi.fn(async () => ({ status: 'attested' as const, identity: noRoutes, via: 'probe' }))
			);
			expect(await q.qualifyResolved(buildBox)).toEqual({
				kind: 'remote',
				remote: buildBox,
				endpoint: noRoutes,
			});
			const unregistered = qualifier(
				okRead,
				vi.fn(async () => ({
					status: 'attested' as const,
					identity: attested({ authority: 'none' }),
					via: 'probe',
				}))
			);
			const refused = await unregistered.qualifier.qualifyResolved(buildBox);
			expect(refused).toMatchObject({ kind: 'unresolved', reason: 'remote-unqualified' });
			if (refused.kind !== 'unresolved') throw new Error('expected unresolved');
			expect(refused.message).toContain('no registered authority');
			expect(refused.message).toContain('nothing ran on the remote unmanaged');
			expect(refused.message).toContain('nothing ran on this machine instead');
		});

		it('refuses a disabled remote, or a host with no trusted enrollment, without asking the remote', async () => {
			const { qualifier: q, probe } = qualifier(okRead);
			expect(await q.qualifyResolved({ ...buildBox, enabled: false })).toMatchObject({
				kind: 'unresolved',
				reason: 'remote-disabled',
			});
			const none = qualifier({ status: 'none' });
			const target = await none.qualifier.qualifyResolved(buildBox);
			expect(target).toMatchObject({ kind: 'unresolved', reason: 'remote-unqualified' });
			if (target.kind !== 'unresolved') throw new Error('expected unresolved');
			expect(target.message).toContain('holds no enrollment to compare the remote against');
			expect(probe).not.toHaveBeenCalled();
			expect(none.probe).not.toHaveBeenCalled();
		});
	});
});
