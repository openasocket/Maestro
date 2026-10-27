/**
 * The maestro-cli installer under the install ceiling (MRC2-04-07): the shim
 * write and the Windows PATH update are held to the digest of the bundled
 * maestro-cli.js the shim executes, as the transport the IPC call was admitted
 * over. Standalone nothing is digested and the install proceeds as before; an
 * enrolled host with no ceiling, or with other bytes than the pinned ones,
 * writes no directory, no shim and runs no PowerShell, and answers refused by
 * code; the pinned bytes install.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockExecFileNoThrow, mockAtomicWriteFile, mockDigest } = vi.hoisted(() => ({
	mockExecFileNoThrow: vi.fn(),
	mockAtomicWriteFile: vi.fn(async () => {}),
	mockDigest: vi.fn(() => 'c'.repeat(64)),
}));

vi.mock('electron', () => ({
	app: { getAppPath: vi.fn(() => appDir), getVersion: vi.fn(() => '0.17.4') },
}));
vi.mock('../../main/utils/execFile', () => ({ execFileNoThrow: mockExecFileNoThrow }));
vi.mock('../../main/utils/atomic-json-store', () => ({ atomicWriteFile: mockAtomicWriteFile }));
vi.mock('../../shared/maestro-lib/managed/tui-handshake', () => ({ digestFileSha256: mockDigest }));
vi.mock('../../shared/platformDetection', () => ({
	getWhichCommand: vi.fn(() => 'which'),
	isWindows: vi.fn(() => false),
}));
vi.mock('../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import { MaestroCliManager } from '../../main/maestro-cli-manager';
import {
	createInstallPolicySource,
	type InstallAuthority,
	type InstallRequest,
} from '../../main/enterprise/install-policy';
import type { IdentityRead } from '../../main/enterprise/identity-store';

// A scratch app dir holding a bundled maestro-cli.js; `getAppPath` reads it lazily, after this line runs.
const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-cli-managed-'));
fs.mkdirSync(path.join(appDir, 'dist', 'cli'), { recursive: true });
fs.writeFileSync(path.join(appDir, 'dist', 'cli', 'maestro-cli.js'), '// bundled\n');
const BUNDLED = path.join(appDir, 'dist', 'cli', 'maestro-cli.js');
const INSTALL_DIR = path.join(os.homedir(), '.local', 'bin');
const none: IdentityRead = { status: 'none' };
const enrolled: IdentityRead = { status: 'ok', record: {} as never, epoch: 1 };

describe('MaestroCliManager under the install ceiling', () => {
	let read: IdentityRead;
	let source: ReturnType<typeof createInstallPolicySource>;
	let manager: MaestroCliManager;

	beforeEach(() => {
		vi.clearAllMocks();
		read = none;
		source = createInstallPolicySource({
			identity: { read: () => read },
			policy: () => ({ appliedRevision: 3 }),
		});
		manager = new MaestroCliManager();
		manager.setInstallAuthority(source);
		// The shim lands nowhere real: the directory, the mode bit and the rc append are stubbed.
		vi.spyOn(fs.promises, 'mkdir').mockResolvedValue(undefined);
		vi.spyOn(fs.promises, 'chmod').mockResolvedValue(undefined);
		vi.spyOn(fs.promises, 'appendFile').mockResolvedValue(undefined);
		vi.spyOn(fs.promises, 'readFile').mockResolvedValue('');
		// `which` finds nothing; the shim answers the app's version when run.
		mockExecFileNoThrow.mockImplementation(async (cmd: string) =>
			String(cmd).endsWith('maestro-cli')
				? { exitCode: 0, stdout: '0.17.4\n', stderr: '' }
				: { exitCode: 1, stdout: '', stderr: '' }
		);
	});

	afterAll(() => {
		fs.rmSync(appDir, { recursive: true, force: true });
	});

	const powershellRuns = () =>
		mockExecFileNoThrow.mock.calls.filter((call) => String(call[0]).startsWith('powershell'));

	it('standalone: writes the shim without digesting the bundled file', async () => {
		const result = await manager.installOrUpdate();

		expect(result.refused).toBeUndefined();
		expect(mockDigest).not.toHaveBeenCalled();
		expect(fs.promises.mkdir).toHaveBeenCalledWith(INSTALL_DIR, { recursive: true });
		expect(mockAtomicWriteFile).toHaveBeenCalledWith(
			path.join(INSTALL_DIR, 'maestro-cli'),
			expect.stringContaining(`'${BUNDLED}' "$@"`)
		);
	});

	it('enrolled with no ceiling: refuses unavailable before the directory, the shim or PowerShell', async () => {
		read = enrolled;

		const result = await manager.installOrUpdate();

		expect(result).toMatchObject({
			success: false,
			refused: true,
			error: expect.stringMatching(
				/^\[managed-unavailable\] the managed install ceiling is unavailable/
			),
			pathUpdated: false,
			restartRequired: false,
			shellFilesUpdated: [],
		});
		expect(result.status.bundledCliPath).toBe(BUNDLED);
		expect(fs.promises.mkdir).not.toHaveBeenCalled();
		expect(mockAtomicWriteFile).not.toHaveBeenCalled();
		expect(fs.promises.chmod).not.toHaveBeenCalled();
		expect(powershellRuns()).toEqual([]);
	});

	it('enrolled: other bytes than the pinned maestro-cli.js write nothing; the pinned bytes install', async () => {
		read = enrolled;
		source.install({
			policyRevision: 3,
			pins: [{ artifact: 'maestro-cli', file: 'maestro-cli.js', sha256: 'c'.repeat(64) }],
		});
		mockDigest.mockReturnValueOnce('d'.repeat(64));

		const refused = await manager.installOrUpdate();
		expect(refused).toMatchObject({
			refused: true,
			error: expect.stringMatching(
				/^\[managed-digest-mismatch\] the bytes of maestro-cli maestro-cli\.js \(sha256 d{64}\) are not the pinned ones \(c{64}\)/
			),
		});
		expect(mockDigest).toHaveBeenCalledWith(BUNDLED);
		expect(mockAtomicWriteFile).not.toHaveBeenCalled();
		expect(fs.promises.mkdir).not.toHaveBeenCalled();

		const installed = await manager.installOrUpdate();
		expect(installed.refused).toBeUndefined();
		expect(mockAtomicWriteFile).toHaveBeenCalledTimes(1);
	});

	it('holds the install as the transport the IPC call named', async () => {
		const seen: InstallRequest[] = [];
		const authority: InstallAuthority = {
			authorize(request) {
				seen.push(request);
				return { allowed: true };
			},
		};
		manager.setInstallAuthority(authority);
		const actor = { kind: 'transport', actor: { peer: 'host-secret' } } as const;

		await manager.installOrUpdate({ actor });

		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({
			artifact: 'maestro-cli',
			file: 'maestro-cli.js',
			stage: 'execute',
			actor,
		});
		expect(seen[0].digest?.()).toBe('c'.repeat(64));
		expect(mockDigest).toHaveBeenCalledWith(BUNDLED);
	});
});
