/**
 * The coworking service start hands the bridge its two readers: the PID walk
 * that binds a handshake to an agent, and the browser ceiling reader every
 * tool call is held against (MRC-09-04A). The boot start in the IPC bootstrap
 * and the Encore reconcile both go through here, so this is the one seam that
 * decides whether an enrolled desktop's bridge holds from its first call.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../../../main/coworking/coworking-server-paths', () => ({
	ensureCoworkingServerScript: vi.fn(async () => '/tmp/coworking-server.cjs'),
}));
vi.mock('../../../main/coworking/coworking-bridge', () => ({
	startCoworkingBridge: vi.fn(async () => undefined),
	stopCoworkingBridge: vi.fn(async () => undefined),
}));

import {
	startCoworkingService,
	stopCoworkingService,
} from '../../../main/coworking/coworking-lifecycle';
import {
	startCoworkingBridge,
	stopCoworkingBridge,
} from '../../../main/coworking/coworking-bridge';
import { captureException } from '../../../main/utils/sentry';
import type { BrowserEffectAuthority } from '../../../main/enterprise/browser-policy';

describe('startCoworkingService', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('hands the bridge the browser ceiling reader it was started with, unchanged', async () => {
		const authority: BrowserEffectAuthority = { authorize: () => ({ allowed: true }) };
		const reader = () => authority;
		await startCoworkingService(() => null, reader);
		expect(startCoworkingBridge).toHaveBeenCalledTimes(1);
		const options = vi.mocked(startCoworkingBridge).mock.calls[0][0];
		expect(options?.browserAuthority).toBe(reader);
		expect(typeof options?.resolveSessionFromPid).toBe('function');
	});

	it('with no reader the bridge is started with the option absent, so its own reader is left as it was', async () => {
		await startCoworkingService(() => null);
		const options = vi.mocked(startCoworkingBridge).mock.calls[0][0];
		expect(options).toHaveProperty('browserAuthority', undefined);
		expect(typeof options?.resolveSessionFromPid).toBe('function');
	});

	it('the PID walk asks the process manager the start was given for each candidate pid', async () => {
		const getSessionIdByPid = vi.fn((pid: number) => (pid === 41 ? 'sess-41' : null));
		await startCoworkingService(() => ({ getSessionIdByPid, coworkingAdmissionsOf: () => null }));
		const options = vi.mocked(startCoworkingBridge).mock.calls[0][0];
		// A pid the lookup knows resolves without walking the tree.
		await expect(options?.resolveSessionFromPid?.(41)).resolves.toBe('sess-41');
		expect(getSessionIdByPid).toHaveBeenCalledWith(41);
	});

	it('the run admissions a handshake is held to come from the process manager; none yet answers null (MRC2-04-08B)', async () => {
		const run = {
			leaseId: 'lease-1',
			authorityId: 'auth',
			attemptId: 'att-1',
			requestId: 'req-1',
			runId: null,
			policyRevision: 1,
		};
		const coworkingAdmissionsOf = vi.fn((sessionId: string) =>
			sessionId === 'sess-A' ? [run] : []
		);
		let manager: {
			getSessionIdByPid: () => null;
			coworkingAdmissionsOf: typeof coworkingAdmissionsOf;
		} | null = null;
		await startCoworkingService(() => manager);
		const options = vi.mocked(startCoworkingBridge).mock.calls[0][0];
		expect(options?.resolveRunAdmissions?.('sess-A')).toBeNull();
		manager = { getSessionIdByPid: () => null, coworkingAdmissionsOf };
		expect(options?.resolveRunAdmissions?.('sess-A')).toEqual([run]);
		expect(options?.resolveRunAdmissions?.('sess-B')).toEqual([]);
		expect(coworkingAdmissionsOf).toHaveBeenCalledWith('sess-A');
	});

	it('a bridge that fails to start is reported and never throws out of the service', async () => {
		vi.mocked(startCoworkingBridge).mockRejectedValueOnce(new Error('listen failed'));
		await expect(startCoworkingService(() => null)).resolves.toBeUndefined();
		expect(captureException).toHaveBeenCalledTimes(1);
	});

	it('a socket already in use is a warning, not a report', async () => {
		const busy = Object.assign(new Error('in use'), { code: 'EADDRINUSE' });
		vi.mocked(startCoworkingBridge).mockRejectedValueOnce(busy);
		await expect(startCoworkingService(() => null)).resolves.toBeUndefined();
		expect(captureException).not.toHaveBeenCalled();
	});

	it('stopCoworkingService stops the bridge and swallows a failure after reporting it', async () => {
		await stopCoworkingService();
		expect(stopCoworkingBridge).toHaveBeenCalledTimes(1);
		vi.mocked(stopCoworkingBridge).mockRejectedValueOnce(new Error('close failed'));
		await expect(stopCoworkingService()).resolves.toBeUndefined();
		expect(captureException).toHaveBeenCalledTimes(1);
	});
});
