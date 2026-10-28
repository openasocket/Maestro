/**
 * Remote file access and connection tests under the remote identity
 * (MRC2-05-07). Phase 1 bound the remote identity to a launch; here every SSH
 * session `remote-fs.ts` opens and every connection test of the SSH remote
 * manager is held to the same qualified endpoint before a session opens: a
 * read binds the identity, a write also passes the local-effects ceiling as
 * `remote-write`, a delete binds the identity (its destructive hold is the
 * delete sink's), a probe binds the identity. An unqualified remote is refused
 * by name with zero ssh spawns; standalone opens sessions as it always has.
 * The qualification is cached per remote and enrollment so a tree walk asks
 * the remote once, and the ledger records a refusal once per remote, class
 * and code. Nothing here opens ssh.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../../../main/utils/cliDetection', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../main/utils/cliDetection')>()),
	resolveSshPath: vi.fn(async () => 'ssh'),
}));
const spawnMock = vi.fn((..._args: unknown[]): never => {
	throw new Error('spawn must not be called');
});
vi.mock('child_process', async (importOriginal) => ({
	...(await importOriginal<typeof import('child_process')>()),
	spawn: (...args: unknown[]) => spawnMock(...args),
}));

import {
	createRemoteAccessAuthority,
	describeRemoteAccess,
	MAX_REMOTE_QUALIFICATION_CACHE,
	REMOTE_ACCESS_CLASSES,
	REMOTE_ACCESS_QUALIFICATION_TTL_MS,
	type RemoteAccessAuthorityDeps,
} from '../../../main/enterprise/remote';
import {
	describeLocalEffect,
	LOCAL_EFFECT_CLASS_OF,
	type LocalEffectAuthority,
	type LocalEffectDecision,
} from '../../../main/enterprise/local-effects-policy';
import type { IdentityRead } from '../../../main/enterprise/identity-store';
import {
	heldRemoteAccess,
	holdRemoteAccess,
	isRemoteAccessRefusal,
	MAX_REMOTE_ACCESS_HOLDS,
	REMOTE_ACCESS_REFUSED_EXIT_CODE,
	remoteAccessRefusal,
	setRemoteAccessAuthority,
	SshRemoteManager,
} from '../../../main/ssh-remote-manager';
import {
	compressFolderRemote,
	deleteManyRemote,
	deleteRemote,
	mkdirRemote,
	readDirRemote,
	readFileRemoteAbortable,
	renameRemote,
	statRemote,
	writeFileRemote,
	type RemoteFsDeps,
} from '../../../main/utils/remote-fs';
import {
	unqualifiedSshLaunchTarget,
	type SshLaunchTarget,
	type SshRemoteEndpointIdentity,
} from '../../../shared/maestro-lib/launch/ssh-remote-resolver';
import type { ManagedIdentityRecord } from '../../../shared/maestro-lib/managed/endpoint-port';
import type { SshRemoteConfig } from '../../../shared/types';

const T0 = Date.parse('2026-10-28T12:00:00Z');

const buildBox: SshRemoteConfig = {
	id: 'remote-1',
	name: 'Build Box',
	host: 'build.example.com',
	port: 22,
	username: 'ci',
	privateKeyPath: '',
	enabled: true,
};
const labBox: SshRemoteConfig = {
	...buildBox,
	id: 'remote-2',
	name: 'Lab Box',
	host: 'lab.example.com',
};

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
const noneRead: IdentityRead = { status: 'none' };

const attestedIdentity: SshRemoteEndpointIdentity = {
	contractVersion: '1',
	installationId: 'inst-remote',
	runtimeId: 'rt-1',
	processEpoch: 'epoch-1',
	tenantId: 'tenant-1',
	orgId: 'org-1',
	authorityId: 'authority-remote',
	policyRevision: 3,
	authority: 'registered',
	routes: [],
};
const qualified = (remote: SshRemoteConfig): SshLaunchTarget => ({
	kind: 'remote',
	remote,
	endpoint: attestedIdentity,
});
const unattested = (remote: SshRemoteConfig): SshLaunchTarget =>
	unqualifiedSshLaunchTarget(remote, 'the remote attests no managed standing.');

type FsDeps = RemoteFsDeps & { execSsh: Mock };
function fsDeps(result = { stdout: 'a.txt\n', stderr: '', exitCode: 0 }): FsDeps {
	return {
		execSsh: vi.fn().mockResolvedValue(result),
		buildSshArgs: vi.fn().mockReturnValue(['ci@build.example.com']),
	};
}

const effectReceipt = {
	policyRevision: 3,
	class: 'data-transfer' as const,
	effect: 'remote-write' as const,
	actor: 'the desktop',
	target: '/srv/app/out.txt',
	count: 1,
	outcome: 'within-ceiling' as const,
};
function localEffects(decision: LocalEffectDecision = { allowed: true }) {
	return {
		authorize: vi.fn().mockResolvedValue(decision),
	} satisfies LocalEffectAuthority & { authorize: Mock };
}

const testActor = { kind: 'plugin', pluginId: 'remote-fs-test' } as const;

function authority(overrides: Partial<RemoteAccessAuthorityDeps> = {}) {
	// The qualifier actually installed is the one returned, so a test that hands
	// its own (or none, with an explicit undefined) asserts on the right mock.
	const qualifyRemote = (
		'qualifyRemote' in overrides
			? overrides.qualifyRemote
			: vi.fn(async (remote: SshRemoteConfig) => qualified(remote))
	) as Mock<(remote: SshRemoteConfig) => Promise<SshLaunchTarget>>;
	const effects = localEffects();
	const created = createRemoteAccessAuthority({
		identity: { read: () => okRead },
		policy: () => ({ appliedRevision: 3 }),
		localEffects: () => effects,
		actor: () => testActor,
		...overrides,
		qualifyRemote,
	});
	return { authority: created, qualifyRemote, effects };
}

beforeEach(() => {
	spawnMock.mockClear();
});
afterEach(() => {
	setRemoteAccessAuthority(null);
});

describe('the remote access rule', () => {
	it('names four classes and describes an access by class, operation, path and count', () => {
		expect([...REMOTE_ACCESS_CLASSES]).toEqual(['read', 'write', 'delete', 'probe']);
		expect(describeRemoteAccess({ class: 'read', operation: 'readDir', target: '/srv' })).toBe(
			'a remote read (readDir of /srv)'
		);
		expect(
			describeRemoteAccess({ class: 'delete', operation: 'deleteMany', target: '/a', count: 3 })
		).toBe('a remote delete (deleteMany of /a, 3 items)');
		expect(describeRemoteAccess({ class: 'probe', operation: 'test-connection' })).toBe(
			'a remote probe (test-connection)'
		);
	});

	it('files remote-write as a data-transfer effect the local-effects ceiling describes', () => {
		expect(LOCAL_EFFECT_CLASS_OF['remote-write']).toBe('data-transfer');
		expect(describeLocalEffect({ effect: 'remote-write', target: '/srv/a' })).toBe(
			'writing /srv/a on an SSH remote'
		);
		expect(describeLocalEffect({ effect: 'remote-write', target: '/srv/a', count: 2 })).toBe(
			'writing items on an SSH remote (2 items, the first /srv/a)'
		);
	});

	it('standalone allows every class with no qualification and no effect consulted', async () => {
		const {
			authority: a,
			qualifyRemote,
			effects,
		} = authority({
			identity: { read: () => noneRead },
		});
		for (const cls of REMOTE_ACCESS_CLASSES)
			expect(await a.hold({ class: cls, remote: buildBox, operation: 'x' })).toEqual({
				allowed: true,
			});
		expect(qualifyRemote).not.toHaveBeenCalled();
		expect(effects.authorize).not.toHaveBeenCalled();
	});

	it('refuses an unqualified remote by name for every class, with no effect consulted', async () => {
		const { authority: a, effects } = authority({
			qualifyRemote: async (remote) => unattested(remote),
		});
		const decision = await a.hold({
			class: 'write',
			remote: buildBox,
			operation: 'writeFile',
			target: '/srv/app/out.txt',
		});
		expect(decision.allowed).toBe(false);
		if (decision.allowed) return;
		expect(decision.code).toBe('remote-unqualified');
		expect(decision.message).toContain('the SSH remote "Build Box"');
		expect(decision.message).toContain('a remote write (writeFile of /srv/app/out.txt)');
		expect(decision.message).toContain('the remote attests no managed standing.');
		expect(decision.message).toContain('No SSH session was opened.');
		expect(decision.managed).toEqual({
			policyRevision: 3,
			class: 'write',
			operation: 'writeFile',
			remoteId: 'remote-1',
			target: '/srv/app/out.txt',
			count: 1,
			endpoint: null,
			effect: null,
			outcome: 'remote-unqualified',
		});
		expect(effects.authorize).not.toHaveBeenCalled();
		for (const cls of ['read', 'delete', 'probe'] as const) {
			const other = await a.hold({ class: cls, remote: buildBox, operation: 'x' });
			expect(other.allowed).toBe(false);
			if (!other.allowed) expect(other.code).toBe('remote-unqualified');
		}
	});

	it('refuses by name when the host binds no qualifier at all', async () => {
		const { authority: a } = authority({ qualifyRemote: undefined });
		const decision = await a.hold({ class: 'read', remote: buildBox, operation: 'stat' });
		expect(decision.allowed).toBe(false);
		if (!decision.allowed) {
			expect(decision.code).toBe('remote-unqualified');
			expect(decision.message).toContain('binds no remote endpoint identity');
		}
	});

	it('a qualified remote admits a read, a delete and a probe with the endpoint bound and no effect consulted', async () => {
		const { authority: a, effects } = authority();
		for (const cls of ['read', 'delete', 'probe'] as const) {
			const decision = await a.hold({
				class: cls,
				remote: buildBox,
				operation: 'x',
				target: '/srv',
				count: 2,
			});
			expect(decision).toEqual({
				allowed: true,
				managed: {
					policyRevision: 3,
					class: cls,
					operation: 'x',
					remoteId: 'remote-1',
					target: '/srv',
					count: 2,
					endpoint: {
						installationId: 'inst-remote',
						runtimeId: 'rt-1',
						processEpoch: 'epoch-1',
						authorityId: 'authority-remote',
						policyRevision: 3,
					},
					effect: null,
					outcome: 'within-ceiling',
				},
			});
		}
		expect(effects.authorize).not.toHaveBeenCalled();
	});

	it('a write on a qualified remote is held on the local-effects ceiling as remote-write with the path, count and actor', async () => {
		const { authority: a, effects } = authority({
			localEffects: () => localEffects({ allowed: true, managed: effectReceipt }),
		});
		const decision = await a.hold({
			class: 'write',
			remote: buildBox,
			operation: 'writeFile',
			target: '/srv/app/out.txt',
		});
		expect(effects.authorize).not.toHaveBeenCalled();
		expect(decision.allowed).toBe(true);
		if (decision.allowed) {
			expect(decision.managed?.effect).toEqual(effectReceipt);
			expect(decision.managed?.outcome).toBe('within-ceiling');
		}
	});

	it('a write the ceiling refuses carries the ceiling code and receipt, and names the remote', async () => {
		const denied = localEffects({
			allowed: false,
			code: 'denied',
			message: 'the local-effects ceiling denies the data-transfer class; writing is refused',
			managed: { ...effectReceipt, outcome: 'denied' },
		});
		const { authority: a } = authority({ localEffects: () => denied });
		const decision = await a.hold({
			class: 'write',
			remote: buildBox,
			operation: 'mkdir',
			target: '/srv/app/dir',
			count: 1,
		});
		expect(denied.authorize).toHaveBeenCalledWith({
			effect: 'remote-write',
			actor: testActor,
			target: '/srv/app/dir',
			count: 1,
		});
		expect(decision.allowed).toBe(false);
		if (decision.allowed) return;
		expect(decision.code).toBe('denied');
		expect(decision.message).toContain('the local-effects ceiling denies the data-transfer class');
		expect(decision.message).toContain(
			'a remote write (mkdir of /srv/app/dir) on the SSH remote "Build Box"'
		);
		expect(decision.message).toContain('no SSH session was opened');
		expect(decision.managed.outcome).toBe('denied');
		expect(decision.managed.effect).toEqual({ ...effectReceipt, outcome: 'denied' });
		expect(decision.managed.endpoint?.installationId).toBe('inst-remote');
	});

	it('a write under management with no local-effects ceiling composed is refused unavailable', async () => {
		const { authority: a } = authority({ localEffects: () => null });
		const decision = await a.hold({
			class: 'write',
			remote: buildBox,
			operation: 'rename',
			target: '/b',
		});
		expect(decision.allowed).toBe(false);
		if (!decision.allowed) {
			expect(decision.code).toBe('unavailable');
			expect(decision.message).toContain('this host composes none');
		}
		const read = await a.hold({ class: 'read', remote: buildBox, operation: 'stat', target: '/b' });
		expect(read.allowed).toBe(true);
	});

	it('the default actor is the transport the call was admitted over', async () => {
		const effects = localEffects();
		const a = createRemoteAccessAuthority({
			identity: { read: () => okRead },
			policy: () => ({ appliedRevision: 3 }),
			qualifyRemote: async (remote) => qualified(remote),
			localEffects: () => effects,
		});
		await a.hold({ class: 'write', remote: buildBox, operation: 'writeFile', target: '/x' });
		expect(effects.authorize).toHaveBeenCalledTimes(1);
		expect(effects.authorize.mock.calls[0][0].actor.kind).toBe('transport');
	});
});

describe('the qualification cache', () => {
	it('concurrent accesses to one remote share one in-flight qualification', async () => {
		const { authority: a, qualifyRemote } = authority();
		const decisions = await Promise.all(
			Array.from({ length: 6 }, (_, i) =>
				a.hold({ class: 'read', remote: buildBox, operation: 'readDir', target: `/d${i}` })
			)
		);
		expect(decisions.every((d) => d.allowed)).toBe(true);
		expect(qualifyRemote).toHaveBeenCalledTimes(1);
	});

	it('keeps an admission for the admitted TTL and a refusal for the refused TTL, then asks again', async () => {
		let t = T0;
		const { authority: a, qualifyRemote } = authority({ now: () => t });
		await a.hold({ class: 'read', remote: buildBox, operation: 'stat' });
		t += REMOTE_ACCESS_QUALIFICATION_TTL_MS.admitted - 1;
		await a.hold({ class: 'read', remote: buildBox, operation: 'stat' });
		expect(qualifyRemote).toHaveBeenCalledTimes(1);
		t += 2;
		await a.hold({ class: 'read', remote: buildBox, operation: 'stat' });
		expect(qualifyRemote).toHaveBeenCalledTimes(2);

		const refusing = authority({
			now: () => t,
			qualifyRemote: vi.fn(async (remote: SshRemoteConfig) => unattested(remote)),
		});
		await refusing.authority.hold({ class: 'read', remote: buildBox, operation: 'stat' });
		t += REMOTE_ACCESS_QUALIFICATION_TTL_MS.refused - 1;
		await refusing.authority.hold({ class: 'read', remote: buildBox, operation: 'stat' });
		expect(refusing.qualifyRemote).toHaveBeenCalledTimes(1);
		t += 2;
		await refusing.authority.hold({ class: 'read', remote: buildBox, operation: 'stat' });
		expect(refusing.qualifyRemote).toHaveBeenCalledTimes(2);
		expect(REMOTE_ACCESS_QUALIFICATION_TTL_MS.refused).toBeLessThan(
			REMOTE_ACCESS_QUALIFICATION_TTL_MS.admitted
		);
	});

	it('keys on the remote, its connection fields and this host enrollment', async () => {
		let read: IdentityRead = okRead;
		const { authority: a, qualifyRemote } = authority({ identity: { read: () => read } });
		await a.hold({ class: 'read', remote: buildBox, operation: 'stat' });
		await a.hold({ class: 'read', remote: labBox, operation: 'stat' });
		expect(qualifyRemote).toHaveBeenCalledTimes(2);
		await a.hold({ class: 'read', remote: { ...buildBox, port: 2222 }, operation: 'stat' });
		expect(qualifyRemote).toHaveBeenCalledTimes(3);
		read = {
			status: 'ok',
			epoch: 2,
			record: record({ policy: { desiredRevision: 4, appliedRevision: 4, observedAt: 'x' } }),
		};
		await a.hold({ class: 'read', remote: buildBox, operation: 'stat' });
		expect(qualifyRemote).toHaveBeenCalledTimes(4);
		await a.hold({ class: 'read', remote: buildBox, operation: 'stat' });
		expect(qualifyRemote).toHaveBeenCalledTimes(4);
	});

	it('a qualifier that throws is not cached and the error reaches the caller', async () => {
		const qualifyRemote = vi
			.fn<(remote: SshRemoteConfig) => Promise<SshLaunchTarget>>()
			.mockRejectedValueOnce(new Error('probe exploded'))
			.mockImplementation(async (remote) => qualified(remote));
		const { authority: a } = authority({ qualifyRemote });
		await expect(a.hold({ class: 'read', remote: buildBox, operation: 'stat' })).rejects.toThrow(
			'probe exploded'
		);
		expect((await a.hold({ class: 'read', remote: buildBox, operation: 'stat' })).allowed).toBe(
			true
		);
		expect(qualifyRemote).toHaveBeenCalledTimes(2);
	});

	it('is bounded', async () => {
		const { authority: a, qualifyRemote } = authority();
		for (let i = 0; i < MAX_REMOTE_QUALIFICATION_CACHE + 1; i++)
			await a.hold({ class: 'read', remote: { ...buildBox, id: `r-${i}` }, operation: 'stat' });
		await a.hold({ class: 'read', remote: { ...buildBox, id: 'r-0' }, operation: 'stat' });
		expect(qualifyRemote).toHaveBeenCalledTimes(MAX_REMOTE_QUALIFICATION_CACHE + 2);
	});
});

describe('the holder in ssh-remote-manager', () => {
	it('with no authority installed nothing is consulted and the ledger is empty', async () => {
		expect(
			await holdRemoteAccess({ class: 'read', remote: buildBox, operation: 'stat', target: '/x' })
		).toBeNull();
		expect(heldRemoteAccess()).toEqual([]);
	});

	it('records a refusal once per remote, class and code with a count, and the refusal result names it', async () => {
		setRemoteAccessAuthority(authority({ qualifyRemote: async (r) => unattested(r) }).authority);
		const first = await holdRemoteAccess({
			class: 'read',
			remote: buildBox,
			operation: 'readDir',
			target: '/a',
		});
		await holdRemoteAccess({ class: 'read', remote: buildBox, operation: 'stat', target: '/b' });
		await holdRemoteAccess({ class: 'write', remote: buildBox, operation: 'mkdir', target: '/c' });
		await holdRemoteAccess({ class: 'read', remote: labBox, operation: 'stat', target: '/d' });
		expect(first).toMatchObject({
			remoteId: 'remote-1',
			remoteName: 'Build Box',
			class: 'read',
			operation: 'readDir',
			code: 'remote-unqualified',
			policyRevision: 3,
			count: 1,
		});
		expect(first?.message.startsWith('[managed-remote-unqualified] ')).toBe(true);
		const rows = heldRemoteAccess().map((h) => [h.remoteId, h.class, h.code, h.count]);
		expect(rows).toEqual([
			['remote-1', 'read', 'remote-unqualified', 2],
			['remote-1', 'write', 'remote-unqualified', 1],
			['remote-2', 'read', 'remote-unqualified', 1],
		]);
		const refusal = remoteAccessRefusal(first!);
		expect(refusal).toEqual({
			stdout: '',
			stderr: first!.message,
			exitCode: REMOTE_ACCESS_REFUSED_EXIT_CODE,
		});
		expect(isRemoteAccessRefusal(refusal)).toBe(true);
		expect(isRemoteAccessRefusal({ stdout: '', stderr: '', exitCode: 1 })).toBe(false);
		setRemoteAccessAuthority(null);
		expect(heldRemoteAccess()).toEqual([]);
	});

	it('bounds the ledger while still answering every refusal', async () => {
		setRemoteAccessAuthority(authority({ qualifyRemote: async (r) => unattested(r) }).authority);
		for (let i = 0; i < MAX_REMOTE_ACCESS_HOLDS + 3; i++) {
			const hold = await holdRemoteAccess({
				class: 'read',
				remote: { ...buildBox, id: `r-${i}` },
				operation: 'stat',
			});
			expect(hold?.code).toBe('remote-unqualified');
		}
		expect(heldRemoteAccess()).toHaveLength(MAX_REMOTE_ACCESS_HOLDS);
	});
});

describe('remote-fs under the authority', () => {
	it('standalone (no authority) runs every command as before', async () => {
		const deps = fsDeps();
		expect((await readDirRemote('/srv', buildBox, deps)).success).toBe(true);
		expect((await writeFileRemote('/srv/a', 'x', buildBox, deps)).success).toBe(true);
		expect(deps.execSsh).toHaveBeenCalledTimes(2);
	});

	it('an enrolled host with a standalone identity read opens sessions as before', async () => {
		const { authority: a, qualifyRemote } = authority({ identity: { read: () => noneRead } });
		setRemoteAccessAuthority(a);
		const deps = fsDeps();
		expect((await statRemote('/srv/a', buildBox, deps)).success).toBe(false);
		expect(deps.execSsh).toHaveBeenCalledTimes(1);
		expect(qualifyRemote).not.toHaveBeenCalled();
	});

	it('a write to an unqualified remote is refused with no SSH session and no retry', async () => {
		setRemoteAccessAuthority(authority({ qualifyRemote: async (r) => unattested(r) }).authority);
		const deps = fsDeps();
		const result = await writeFileRemote('/srv/app/out.txt', 'hello', buildBox, deps);
		expect(result.success).toBe(false);
		expect(result.error).toContain('[managed-remote-unqualified]');
		expect(result.error).toContain('a remote write (writeFile of /srv/app/out.txt)');
		expect(result.error).toContain('No SSH session was opened.');
		expect(deps.execSsh).not.toHaveBeenCalled();
		expect(deps.buildSshArgs).not.toHaveBeenCalled();
	});

	it('a read of an unqualified remote is refused the same way', async () => {
		setRemoteAccessAuthority(authority({ qualifyRemote: async (r) => unattested(r) }).authority);
		const deps = fsDeps();
		const result = await readDirRemote('/srv', buildBox, deps);
		expect(result.success).toBe(false);
		expect(result.error).toContain('[managed-remote-unqualified]');
		expect(result.error).toContain('a remote read (readDir of /srv)');
		expect(deps.execSsh).not.toHaveBeenCalled();
	});

	it('the abortable read is held before its own spawn', async () => {
		setRemoteAccessAuthority(authority({ qualifyRemote: async (r) => unattested(r) }).authority);
		const result = await readFileRemoteAbortable(
			'/srv/log',
			buildBox,
			new AbortController().signal
		);
		expect(result.success).toBe(false);
		expect(result.error).toContain('[managed-remote-unqualified]');
		expect(result.error).toContain('readFileAbortable of /srv/log');
		expect(spawnMock).not.toHaveBeenCalled();
	});

	it('a qualified remote runs reads without the local-effects ceiling and writes through it with the written path', async () => {
		const { authority: a, effects } = authority();
		setRemoteAccessAuthority(a);
		const deps = fsDeps({ stdout: '', stderr: '', exitCode: 0 });
		await readDirRemote('/srv', buildBox, deps);
		expect(effects.authorize).not.toHaveBeenCalled();
		await writeFileRemote('/srv/app/out.txt', 'hello', buildBox, deps);
		await mkdirRemote('/srv/app/dir', buildBox, true, deps);
		await renameRemote('/srv/app/old', '/srv/app/new', buildBox, deps);
		await compressFolderRemote('/srv/app', '/srv/app.zip', buildBox, deps);
		expect(effects.authorize.mock.calls.map((c) => [c[0].effect, c[0].target, c[0].count])).toEqual(
			[
				['remote-write', '/srv/app/out.txt', 1],
				['remote-write', '/srv/app/dir', 1],
				['remote-write', '/srv/app/new', 1],
				['remote-write', '/srv/app.zip', 1],
			]
		);
		expect(deps.execSsh).toHaveBeenCalledTimes(5);
	});

	it('a write the ceiling refuses opens no session and answers the ceiling line', async () => {
		const { authority: a } = authority({
			localEffects: () =>
				localEffects({
					allowed: false,
					code: 'denied',
					message: 'the local-effects ceiling denies the data-transfer class',
					managed: { ...effectReceipt, outcome: 'denied' },
				}),
		});
		setRemoteAccessAuthority(a);
		const deps = fsDeps();
		const result = await mkdirRemote('/srv/app/dir', buildBox, true, deps);
		expect(result).toEqual({
			success: false,
			error: expect.stringContaining('[managed-denied] the local-effects ceiling denies'),
		});
		expect(deps.execSsh).not.toHaveBeenCalled();
		expect(heldRemoteAccess().map((h) => [h.class, h.operation, h.code])).toEqual([
			['write', 'mkdir', 'denied'],
		]);
	});

	it('a delete binds the identity only: the delete sink already held the destructive effect', async () => {
		const { authority: a, effects } = authority();
		setRemoteAccessAuthority(a);
		const deps = fsDeps({ stdout: '', stderr: '', exitCode: 0 });
		expect((await deleteRemote('/srv/app/tmp', buildBox, true, deps)).success).toBe(true);
		const many = await deleteManyRemote(['/srv/a', '/srv/b'], buildBox, true, deps);
		expect(many.every((r) => r.success)).toBe(true);
		expect(effects.authorize).not.toHaveBeenCalled();
		expect(deps.execSsh).toHaveBeenCalledTimes(2);

		setRemoteAccessAuthority(authority({ qualifyRemote: async (r) => unattested(r) }).authority);
		const refused = fsDeps();
		const results = await deleteManyRemote(['/srv/a', '/srv/b'], buildBox, true, refused);
		expect(results.map((r) => r.success)).toEqual([false, false]);
		expect(results[0].error).toContain('[managed-remote-unqualified]');
		expect(refused.execSsh).not.toHaveBeenCalled();
	});

	it('a tree walk asks the remote for its standing once', async () => {
		const { authority: a, qualifyRemote } = authority();
		setRemoteAccessAuthority(a);
		const deps = fsDeps();
		await Promise.all(
			Array.from({ length: 12 }, (_, i) => readDirRemote(`/srv/${i}`, buildBox, deps))
		);
		expect(qualifyRemote).toHaveBeenCalledTimes(1);
		expect(deps.execSsh).toHaveBeenCalledTimes(12);
	});
});

describe('the connection test under the authority', () => {
	const probeResult = { stdout: '', stderr: '', exitCode: 0 };

	it('standalone runs ssh as before', async () => {
		const execSsh = vi.fn().mockResolvedValue(probeResult);
		const manager = new SshRemoteManager({ checkFileAccess: () => true, execSsh });
		await manager.testConnection(buildBox);
		expect(execSsh).toHaveBeenCalledTimes(1);
	});

	it('an unqualified remote is refused as a probe, with no ssh run', async () => {
		setRemoteAccessAuthority(authority({ qualifyRemote: async (r) => unattested(r) }).authority);
		const execSsh = vi.fn().mockResolvedValue(probeResult);
		const manager = new SshRemoteManager({ checkFileAccess: () => true, execSsh });
		const result = await manager.testConnection(buildBox, 'claude');
		expect(result.success).toBe(false);
		expect(result.error).toContain('[managed-remote-unqualified]');
		expect(result.error).toContain('a remote probe (test-connection)');
		expect(execSsh).not.toHaveBeenCalled();
		expect(heldRemoteAccess().map((h) => [h.class, h.operation])).toEqual([
			['probe', 'test-connection'],
		]);
	});

	it('a qualified remote is tested as before, and validation still runs first', async () => {
		const { authority: a, qualifyRemote } = authority();
		setRemoteAccessAuthority(a);
		const execSsh = vi.fn().mockResolvedValue(probeResult);
		const manager = new SshRemoteManager({ checkFileAccess: () => true, execSsh });
		await manager.testConnection(buildBox);
		expect(execSsh).toHaveBeenCalledTimes(1);
		const invalid = await manager.testConnection({ ...buildBox, host: '' });
		expect(invalid).toEqual({ success: false, error: 'Host is required' });
		expect(qualifyRemote).toHaveBeenCalledTimes(1);
	});
});

describe('the desktop composition', () => {
	const indexSource = fs.readFileSync(
		fileURLToPath(new URL('../../../main/index.ts', import.meta.url)),
		'utf8'
	);

	it('installs the remote access authority once, after the local-effects ceiling it consults, over the same qualifier as the git gate', () => {
		expect(indexSource.match(/setRemoteAccessAuthority\(/g)).toHaveLength(1);
		const install = indexSource.indexOf('setRemoteAccessAuthority(');
		expect(install).toBeGreaterThan(indexSource.indexOf('createLocalEffectsPolicySource('));
		expect(install).toBeGreaterThan(indexSource.indexOf('setListenerAuthority(listenerPolicy)'));
		expect(indexSource.match(/qualifyRemote: qualifyManagedRemote,/g)).toHaveLength(2);
		expect(indexSource.indexOf('const qualifyManagedRemote')).toBeLessThan(
			indexSource.indexOf('setGitExecutionGate(')
		);
		const block = indexSource.slice(install, indexSource.indexOf(');', install));
		expect(block).toContain(
			"identity: { read: () => enterpriseService?.identity.read() ?? { status: 'none' } }"
		);
		expect(block).toContain('localEffects: () => localEffectsPolicy');
	});
});
