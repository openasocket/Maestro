/**
 * The Lite process's listener authority (MRC2-05-06C): composed over the HOST
 * installation's enrollment record and installed before the first Lite sink.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ spawn: vi.fn(), execFile: vi.fn() }));
vi.mock('child_process', async (importOriginal) => ({
	...(await importOriginal<typeof import('child_process')>()),
	spawn: fixture.spawn,
	execFile: fixture.execFile,
}));

import {
	composeLiteListenerAuthority,
	installLiteListenerAuthority,
	liteHostDataDirectory,
} from '../../../main/lite/listener-authority';
import { startLiteControlServer } from '../../../main/lite/control-server';
import { openTunnel } from '../../../main/lite/tunnel';
import {
	heldListeners,
	isListenerDeniedError,
	listenerHoldFor,
	setListenerAuthority,
} from '../../../main/enterprise/listener-gate';
import {
	createEnterpriseIdentityStore,
	ENTERPRISE_IDENTITY_FILE_NAME,
	type IdentityWriteInput,
} from '../../../main/enterprise/identity-store';
import type { Anchor } from '../../../main/utils/keyring-anchor';
import type { SealProvider } from '../../../main/utils/safe-storage-seal';
import { sendLiteCommand } from '../../../cli/services/lite-client';
import {
	LITE_CONTROL_DISABLED_BY_POLICY,
	LITE_CONTROL_DISCOVERY_FILE,
	isLiteControlEndpoint,
	isLiteControlHeld,
} from '../../../shared/lite-control';
import type { SshRemoteConfig } from '../../../shared/types';
import { fakeAnchor, fakeSeal } from '../enterprise/fakeCustody';

const NOW = Date.parse('2026-10-28T12:00:00Z');

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	setListenerAuthority(null);
	vi.clearAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function directory(label: string): Promise<string> {
	const dir = await mkdtemp(path.join(os.tmpdir(), `maestro-lite-${label}-`));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

function record(extra: Partial<IdentityWriteInput> = {}): IdentityWriteInput {
	return {
		installationId: 'inst-1',
		tenantId: 'tenant-1',
		orgId: 'org-1',
		enrollmentId: 'enr-1',
		endpoint: {
			socketPath: '/run/endpoint/runtime.sock',
			bindingDigest: 'a'.repeat(64),
			trustRootDigest: null,
		},
		management: 'enrolled',
		registration: null,
		policy: { desiredRevision: 3, appliedRevision: 3, observedAt: new Date(NOW).toISOString() },
		enrolledAt: new Date(NOW).toISOString(),
		...extra,
	};
}

/** What the full desktop leaves behind: the record sealed and anchored under the host directory. */
async function enrollHost(
	hostDir: string,
	holder: { value: Anchor | null },
	seal: SealProvider = fakeSeal(),
	extra: Partial<IdentityWriteInput> = {}
): Promise<void> {
	const store = createEnterpriseIdentityStore({
		file: path.join(hostDir, ENTERPRISE_IDENTITY_FILE_NAME),
		seal,
		anchor: fakeAnchor(holder),
		platform: 'darwin',
		now: () => NOW,
	});
	await store.write(record(extra));
}

const sshConfig: SshRemoteConfig = {
	id: 'host-a',
	name: 'Host A',
	host: 'my-alias',
	port: 22,
	username: '',
	privateKeyPath: '',
	useSshConfig: true,
	enabled: true,
};

describe('Lite listener authority over the host enrollment', () => {
	it('reads no enrollment as standalone by name, and the control endpoint binds as it always has', async () => {
		const hostDir = await directory('host');
		const liteDir = await directory('lite');
		const authority = installLiteListenerAuthority({
			hostDataDir: hostDir,
			seal: fakeSeal(),
			anchor: fakeAnchor({ value: null }),
			platform: 'darwin',
		});
		expect(liteHostDataDirectory('/ignored', { MAESTRO_USER_DATA: hostDir })).toBe(hostDir);
		expect(authority.enrollment()).toEqual({
			standing: 'standalone',
			file: authority.file,
			reason: expect.stringContaining(`no enrollment record at ${authority.file}`),
		});
		const server = await startLiteControlServer(liteDir, async () => ({
			state: { status: 'Disconnected', picker: true, profiles: [], aliases: [] },
		}));
		cleanups.push(server.close);
		expect(server.held).toBeNull();
		const discovery = JSON.parse(
			await readFile(path.join(liteDir, LITE_CONTROL_DISCOVERY_FILE), 'utf8')
		) as { endpoint?: unknown };
		expect(isLiteControlEndpoint(discovery.endpoint)).toBe(true);
		expect(await sendLiteCommand('status', undefined, { userData: liteDir })).toMatchObject({
			success: true,
			state: { status: 'Disconnected' },
		});
		expect(heldListeners()).toEqual([]);
	});

	it('under an enrolled host with no ceiling writes disabled-by-policy and refuses every SSH forward before a probe or a spawn', async () => {
		const hostDir = await directory('host');
		const liteDir = await directory('lite');
		const holder: { value: Anchor | null } = { value: null };
		await enrollHost(hostDir, holder);
		const authority = installLiteListenerAuthority({
			hostDataDir: hostDir,
			seal: fakeSeal(),
			anchor: fakeAnchor(holder),
			platform: 'darwin',
		});
		expect(authority.enrollment()).toMatchObject({
			standing: 'managed',
			identity: 'ok',
			appliedRevision: 3,
			reason: expect.stringContaining('inst-1 enrolled with org-1 (tenant-1), management enrolled'),
		});

		// The control endpoint: nothing listens, the record names the hold, maestro-cli reports it.
		const server = await startLiteControlServer(liteDir, async () => {
			throw new Error('nothing may be dispatched to a held endpoint');
		});
		cleanups.push(server.close);
		expect(server.held).toMatchObject({ kind: 'lite-control', port: 0, code: 'unavailable' });
		const written = JSON.parse(
			await readFile(path.join(liteDir, LITE_CONTROL_DISCOVERY_FILE), 'utf8')
		) as unknown;
		expect(isLiteControlHeld(written)).toBe(true);
		expect(written).toMatchObject({
			status: LITE_CONTROL_DISABLED_BY_POLICY,
			code: 'unavailable',
			message: expect.stringMatching(/^\[managed-unavailable\] /),
		});
		await expect(sendLiteCommand('status', undefined, { userData: liteDir })).rejects.toThrow(
			/disabled-by-policy\. \[managed-unavailable\]/
		);

		// The SSH forward: refused by name before the free-port probe, ssh -G or the spawn.
		const attempt = openTunnel(
			sshConfig,
			new URL('http://127.0.0.1:8080/token-a'),
			new AbortController().signal,
			() => {},
			4321
		);
		await expect(attempt).rejects.toSatisfy((error: unknown) => isListenerDeniedError(error));
		await expect(attempt).rejects.toThrow(/\[managed-unavailable\]/);
		expect(fixture.execFile).not.toHaveBeenCalled();
		expect(fixture.spawn).not.toHaveBeenCalled();
		expect(heldListeners()).toMatchObject([
			{ kind: 'lite-control', code: 'unavailable', reach: 'loopback', count: 1 },
			{ kind: 'ssh-tunnel', bind: '127.0.0.1', port: 4321, code: 'unavailable', count: 1 },
		]);
	});

	it('never reads a record that is there but does not open as standalone', async () => {
		const hostDir = await directory('host');
		const holder: { value: Anchor | null } = { value: null };
		// Sealed under another key, as the host's record is on a platform that keys the seal by app name.
		await enrollHost(hostDir, holder, fakeSeal({ mark: 'OTHER-KEY\u0000' }));
		const authority = composeLiteListenerAuthority({
			hostDataDir: hostDir,
			seal: fakeSeal(),
			anchor: fakeAnchor(holder),
			platform: 'darwin',
		});
		expect(authority.enrollment()).toMatchObject({
			standing: 'managed',
			identity: 'untrusted',
			appliedRevision: null,
			reason: expect.stringMatching(/is unsealable: .*does not open with this app's key/),
		});
		setListenerAuthority(authority.source);
		expect(listenerHoldFor({ kind: 'ssh-tunnel', bind: '127.0.0.1', port: 0 })).toMatchObject({
			kind: 'ssh-tunnel',
			code: 'unavailable',
		});
		expect(listenerHoldFor({ kind: 'lite-control', bind: '/tmp/x.sock', port: 0 })).toMatchObject({
			code: 'unavailable',
		});
	});

	it('is standalone by name under a custody that cannot read and holds no file, and managed once a protected run left one', async () => {
		const hostDir = await directory('host');
		const holder: { value: Anchor | null } = { value: null };
		const unprotected = () =>
			composeLiteListenerAuthority({
				hostDataDir: hostDir,
				seal: fakeSeal({ available: false }),
				anchor: fakeAnchor(holder),
				platform: 'darwin',
			});
		expect(unprotected().enrollment()).toMatchObject({
			standing: 'standalone',
			reason: expect.stringMatching(
				/no enrollment record at .* and none could be read here \(The operating system offers no encryption/
			),
		});
		setListenerAuthority(unprotected().source);
		expect(listenerHoldFor({ kind: 'lite-control', bind: '/tmp/x.sock', port: 0 })).toBeNull();
		await enrollHost(hostDir, holder);
		expect(unprotected().enrollment()).toMatchObject({
			standing: 'managed',
			identity: 'unprotected',
			appliedRevision: null,
			reason: expect.stringContaining(
				'was written by an enrolled host and cannot be read under this custody'
			),
		});
		setListenerAuthority(unprotected().source);
		expect(listenerHoldFor({ kind: 'lite-control', bind: '/tmp/x.sock', port: 0 })).toMatchObject({
			code: 'unavailable',
		});
	});
});

describe('composition in src/main/lite/index.ts', () => {
	// The source of truth for the wiring is `startLite()`; this pins that the
	// host directory is taken before Lite re-points userData, and that the
	// authority is installed once, after Electron is ready and before the
	// window, the discovery controller and the control endpoint exist.
	it('installs the authority once, after whenReady and before the first sink', () => {
		const source = readFileSync(join('src/main/lite/index.ts'), 'utf8');
		const at = (needle: string): number => {
			const index = source.indexOf(needle);
			expect(index, needle).toBeGreaterThanOrEqual(0);
			return index;
		};
		expect(source.match(/installLiteListenerAuthority\(/g)).toHaveLength(1);
		expect(at("const hostDataDir = liteHostDataDirectory(app.getPath('userData'))")).toBeLessThan(
			at("app.setPath('userData', liteData)")
		);
		const install = at('installLiteListenerAuthority({ hostDataDir, safeStorage })');
		expect(at('await app.whenReady()')).toBeLessThan(install);
		expect(install).toBeLessThan(at('new LiteProfiles('));
		expect(install).toBeLessThan(at('new DiscoveryController('));
		expect(install).toBeLessThan(at('new BrowserWindow('));
		expect(install).toBeLessThan(at('startLiteControlServer('));
		expect(install).toBeLessThan(at('openTunnel('));
	});

	it('is the only place the Lite process installs on the gate', () => {
		const module = readFileSync(join('src/main/lite/listener-authority.ts'), 'utf8');
		expect(module.match(/setListenerAuthority\(/g)).toHaveLength(1);
		expect(readFileSync(join('src/main/lite/index.ts'), 'utf8')).not.toContain(
			'setListenerAuthority('
		);
	});
});

function join(file: string): string {
	return path.join(process.cwd(), file);
}
