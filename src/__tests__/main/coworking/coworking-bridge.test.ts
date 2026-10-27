/**
 * Bridge handshake / session-binding tests. Exercises the per-connection sessionId
 * binding that fixes PR #948's privacy blocker (focus-bound scope leak).
 *
 * We don't actually open a Unix socket here - we drive `dispatch` directly via
 * the test-only export and use a plain object as the connection key (the bridge's
 * connection state is keyed via WeakMap, which accepts any object).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('electron', () => ({
	app: {
		getPath: () => '/tmp/coworking-test-userdata',
	},
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../main/coworking/coworking-tools', () => {
	return {
		listTerminals: vi.fn((sessionId: string) => ({
			terminals: [{ id: 'term:1', cwd: '/x', title: `for ${sessionId}` }],
		})),
		readTerminal: vi.fn(async (sessionId: string, args: { id: string }) => ({
			id: args.id,
			content: `body for ${sessionId}/${args.id}`,
			truncated: false,
			totalLines: 1,
		})),
	};
});

import { __testing } from '../../../main/coworking/coworking-bridge';
import * as tools from '../../../main/coworking/coworking-tools';
import type { Socket } from 'net';

function newConn(): Socket {
	// WeakMap keys must be objects; a plain `{}` is sufficient for dispatch().
	return {} as unknown as Socket;
}

describe('coworking-bridge dispatch (handshake + session binding)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		__testing.setResolveSessionFromPid(null);
		__testing.setResolveRunAdmissions(null);
	});

	it('rejects listTerminals before hello', async () => {
		const conn = newConn();
		__testing.connections.set(conn, { sessionId: null });

		const resp = await __testing.dispatch(conn, { id: 1, method: 'listTerminals' });
		expect(resp.error).toBeDefined();
		expect(resp.error?.code).toBe(-32002);
		expect(tools.listTerminals).not.toHaveBeenCalled();
	});

	it('rejects readTerminal before hello', async () => {
		const conn = newConn();
		__testing.connections.set(conn, { sessionId: null });

		const resp = await __testing.dispatch(conn, {
			id: 1,
			method: 'readTerminal',
			params: { id: 'term:1' },
		});
		expect(resp.error).toBeDefined();
		expect(resp.error?.code).toBe(-32002);
		expect(tools.readTerminal).not.toHaveBeenCalled();
	});

	it('hello with sessionId binds the connection', async () => {
		const conn = newConn();
		const state = { sessionId: null as string | null };
		__testing.connections.set(conn, state);

		const helloResp = await __testing.dispatch(conn, {
			id: 1,
			method: 'hello',
			params: { sessionId: 'sess-A' },
		});
		expect(helloResp.error).toBeUndefined();
		expect(helloResp.result).toEqual({ ok: true });
		expect(state.sessionId).toBe('sess-A');
	});

	it('hello rejects when neither sessionId nor ppid is provided', async () => {
		const conn = newConn();
		__testing.connections.set(conn, { sessionId: null });

		const r1 = await __testing.dispatch(conn, { id: 1, method: 'hello' });
		expect(r1.error?.code).toBe(-32602);

		const r2 = await __testing.dispatch(conn, {
			id: 2,
			method: 'hello',
			params: { sessionId: '' },
		});
		expect(r2.error?.code).toBe(-32602);

		const r3 = await __testing.dispatch(conn, {
			id: 3,
			method: 'hello',
			params: { ppid: 0 },
		});
		expect(r3.error?.code).toBe(-32602);
	});

	it('hello with ppid resolves session via the registered resolver', async () => {
		const conn = newConn();
		__testing.connections.set(conn, { sessionId: null });
		const resolver = vi.fn(async (pid: number) => (pid === 4242 ? 'sess-via-pid' : null));
		__testing.setResolveSessionFromPid(resolver);

		const resp = await __testing.dispatch(conn, {
			id: 1,
			method: 'hello',
			params: { ppid: 4242 },
		});
		expect(resp.error).toBeUndefined();
		expect(resp.result).toEqual({ ok: true });
		expect(resolver).toHaveBeenCalledWith(4242);
		expect(__testing.connections.get(conn)?.sessionId).toBe('sess-via-pid');
	});

	it('hello with ppid rejects when resolver returns null', async () => {
		const conn = newConn();
		__testing.connections.set(conn, { sessionId: null });
		__testing.setResolveSessionFromPid(async () => null);

		const resp = await __testing.dispatch(conn, {
			id: 1,
			method: 'hello',
			params: { ppid: 99999 },
		});
		expect(resp.error?.code).toBe(-32602);
		expect(resp.error?.message).toMatch(/peer PID/i);
		expect(__testing.connections.get(conn)?.sessionId).toBeNull();
	});

	it('hello with ppid but no resolver wired rejects', async () => {
		const conn = newConn();
		__testing.connections.set(conn, { sessionId: null });
		__testing.setResolveSessionFromPid(null);

		const resp = await __testing.dispatch(conn, {
			id: 1,
			method: 'hello',
			params: { ppid: 100 },
		});
		expect(resp.error?.code).toBe(-32602);
		expect(resp.error?.message).toMatch(/resolver not configured/i);
	});

	it('hello with sessionId + a ppid that resolves to the SAME session binds it', async () => {
		const conn = newConn();
		__testing.connections.set(conn, { sessionId: null });
		const resolver = vi.fn(async () => 'sess-explicit');
		__testing.setResolveSessionFromPid(resolver);

		const resp = await __testing.dispatch(conn, {
			id: 1,
			method: 'hello',
			params: { sessionId: 'sess-explicit', ppid: 4242 },
		});
		expect(resp.error).toBeUndefined();
		expect(__testing.connections.get(conn)?.sessionId).toBe('sess-explicit');
		expect(resolver).toHaveBeenCalledWith(4242);
	});

	it('hello with sessionId + a ppid the resolver cannot map (null) still trusts sessionId', async () => {
		const conn = newConn();
		__testing.connections.set(conn, { sessionId: null });
		const resolver = vi.fn(async () => null);
		__testing.setResolveSessionFromPid(resolver);

		const resp = await __testing.dispatch(conn, {
			id: 1,
			method: 'hello',
			params: { sessionId: 'sess-explicit', ppid: 4242 },
		});
		// A null (can't-determine) result is NOT a mismatch: env-propagating
		// agents whose PIDs aren't tracked must not regress.
		expect(resp.error).toBeUndefined();
		expect(__testing.connections.get(conn)?.sessionId).toBe('sess-explicit');
		expect(resolver).toHaveBeenCalledWith(4242);
	});

	it('hello rejects when the ppid resolves to a DIFFERENT session than the claimed sessionId', async () => {
		const conn = newConn();
		__testing.connections.set(conn, { sessionId: null });
		const resolver = vi.fn(async () => 'sess-from-pid');
		__testing.setResolveSessionFromPid(resolver);

		const resp = await __testing.dispatch(conn, {
			id: 1,
			method: 'hello',
			params: { sessionId: 'sess-explicit', ppid: 4242 },
		});
		expect(resp.error?.code).toBe(-32602);
		expect(resp.error?.message).toMatch(/does not match caller process/i);
		expect(__testing.connections.get(conn)?.sessionId).toBeNull();
	});

	it('hello with sessionId and NO resolver wired trusts sessionId (env-only agents)', async () => {
		const conn = newConn();
		__testing.connections.set(conn, { sessionId: null });
		__testing.setResolveSessionFromPid(null);

		const resp = await __testing.dispatch(conn, {
			id: 1,
			method: 'hello',
			params: { sessionId: 'sess-explicit', ppid: 4242 },
		});
		expect(resp.error).toBeUndefined();
		expect(__testing.connections.get(conn)?.sessionId).toBe('sess-explicit');
	});

	it('after hello, listTerminals is dispatched with the bound sessionId', async () => {
		const conn = newConn();
		__testing.connections.set(conn, { sessionId: null });

		await __testing.dispatch(conn, {
			id: 1,
			method: 'hello',
			params: { sessionId: 'sess-A' },
		});
		const resp = await __testing.dispatch(conn, { id: 2, method: 'listTerminals' });
		expect(resp.error).toBeUndefined();
		expect(tools.listTerminals).toHaveBeenCalledWith('sess-A');
	});

	it('after hello, readTerminal is dispatched with the bound sessionId', async () => {
		const conn = newConn();
		__testing.connections.set(conn, { sessionId: null });

		await __testing.dispatch(conn, {
			id: 1,
			method: 'hello',
			params: { sessionId: 'sess-B' },
		});
		const resp = await __testing.dispatch(conn, {
			id: 2,
			method: 'readTerminal',
			params: { id: 'term:7' },
		});
		expect(resp.error).toBeUndefined();
		expect(tools.readTerminal).toHaveBeenCalledWith('sess-B', { id: 'term:7', lines: undefined });
	});

	it('two connections with different sessionIds do not bleed (privacy regression)', async () => {
		const connA = newConn();
		const connB = newConn();
		__testing.connections.set(connA, { sessionId: null });
		__testing.connections.set(connB, { sessionId: null });

		await __testing.dispatch(connA, {
			id: 1,
			method: 'hello',
			params: { sessionId: 'sess-A' },
		});
		await __testing.dispatch(connB, {
			id: 1,
			method: 'hello',
			params: { sessionId: 'sess-B' },
		});

		await __testing.dispatch(connA, { id: 2, method: 'listTerminals' });
		await __testing.dispatch(connB, { id: 2, method: 'listTerminals' });

		expect(tools.listTerminals).toHaveBeenNthCalledWith(1, 'sess-A');
		expect(tools.listTerminals).toHaveBeenNthCalledWith(2, 'sess-B');
	});

	it('readTerminal with missing id returns invalid-params error', async () => {
		const conn = newConn();
		__testing.connections.set(conn, { sessionId: null });
		await __testing.dispatch(conn, {
			id: 1,
			method: 'hello',
			params: { sessionId: 'sess-A' },
		});

		const resp = await __testing.dispatch(conn, { id: 2, method: 'readTerminal', params: {} });
		expect(resp.error?.code).toBe(-32602);
	});

	it('unknown method returns -32601 even after hello', async () => {
		const conn = newConn();
		__testing.connections.set(conn, { sessionId: null });
		await __testing.dispatch(conn, {
			id: 1,
			method: 'hello',
			params: { sessionId: 'sess-A' },
		});

		const resp = await __testing.dispatch(conn, {
			id: 2,
			method: 'wat' as 'hello',
		});
		expect(resp.error?.code).toBe(-32601);
	});
});

/**
 * MRC2-04-08B: on a managed host the handshake carries the run the owning
 * agent process was admitted on, and the bridge holds the connection to a
 * lease still bound to a live process of that session.
 */
describe('coworking-bridge hello under management (the run admission)', () => {
	const run = {
		leaseId: 'lease-7',
		authorityId: 'auth-1',
		attemptId: 'att-7',
		requestId: 'req-7',
		runId: null,
		policyRevision: 3,
	};
	const hello = (conn: Socket, params: Record<string, unknown>) =>
		__testing.dispatch(conn, { id: 1, method: 'hello', params });

	beforeEach(() => {
		vi.clearAllMocks();
		__testing.setResolveSessionFromPid(null);
		__testing.setResolveRunAdmissions(null);
	});

	it('standalone (the resolver answers null, or none is wired): bound as before, with or without an admission', async () => {
		const a = newConn();
		__testing.connections.set(a, { sessionId: null });
		expect(
			(await hello(a, { sessionId: 'sess-A', admission: JSON.stringify(run) })).result
		).toEqual({
			ok: true,
		});
		expect(__testing.connections.get(a)).toEqual({ sessionId: 'sess-A', admission: null });
		const resolver = vi.fn(() => null);
		__testing.setResolveRunAdmissions(resolver);
		const b = newConn();
		__testing.connections.set(b, { sessionId: null });
		expect((await hello(b, { sessionId: 'sess-B' })).result).toEqual({ ok: true });
		expect(resolver).toHaveBeenCalledWith('sess-B');
		expect(__testing.connections.get(b)?.admission).toBeNull();
	});

	it('managed, no admission carried: refused by name, nothing bound, tools stay closed', async () => {
		__testing.setResolveRunAdmissions(() => [run]);
		const conn = newConn();
		__testing.connections.set(conn, { sessionId: null });
		const resp = await hello(conn, { sessionId: 'sess-A' });
		expect(resp.error).toEqual({
			code: -32002,
			message:
				'coworking bridge: [managed-admission-missing] this host runs under management and the handshake for sess-A carries no run admission; the connection is refused',
		});
		expect(__testing.connections.get(conn)?.sessionId).toBeNull();
		const tool = await __testing.dispatch(conn, { id: 2, method: 'listTerminals' });
		expect(tool.error?.code).toBe(-32002);
		expect(tools.listTerminals).not.toHaveBeenCalled();
	});

	it('managed, an admission that is not the stamped shape: refused admission-invalid', async () => {
		__testing.setResolveRunAdmissions(() => [run]);
		const conn = newConn();
		__testing.connections.set(conn, { sessionId: null });
		expect(
			(await hello(conn, { sessionId: 'sess-A', admission: '{not json' })).error?.message
		).toMatch(/^coworking bridge: \[managed-admission-invalid\] the admission is not JSON: /);
		expect(
			(
				await hello(conn, {
					sessionId: 'sess-A',
					admission: JSON.stringify({ ...run, leaseId: '' }),
				})
			).error?.message
		).toBe(
			"coworking bridge: [managed-admission-invalid] the admission's leaseId is not a non-empty string; the connection is refused"
		);
		expect((await hello(conn, { sessionId: 'sess-A', admission: 42 })).error?.message).toMatch(
			/\[managed-admission-invalid\] the admission is not a string/
		);
		expect(__testing.connections.get(conn)?.sessionId).toBeNull();
	});

	it('managed, a lease bound to no live process of the session: refused admission-unbound', async () => {
		__testing.setResolveRunAdmissions((sessionId) => (sessionId === 'sess-A' ? [run] : []));
		const conn = newConn();
		__testing.connections.set(conn, { sessionId: null });
		const stale = JSON.stringify({ ...run, attemptId: 'att-old' });
		expect((await hello(conn, { sessionId: 'sess-A', admission: stale })).error?.message).toBe(
			'coworking bridge: [managed-admission-unbound] lease lease-7 (attempt att-old) is bound to no live process of sess-A; the connection is refused'
		);
		// The same admission claimed for another session is unbound there too.
		expect(
			(await hello(conn, { sessionId: 'sess-B', admission: JSON.stringify(run) })).error?.message
		).toMatch(
			/\[managed-admission-unbound\] lease lease-7 \(attempt att-7\) is bound to no live process of sess-B/
		);
		expect(__testing.connections.get(conn)?.sessionId).toBeNull();
	});

	it('managed, the admission of a live lease: bound, carried on the connection, by sessionId or by ppid', async () => {
		const resolver = vi.fn((sessionId: string) => (sessionId === 'sess-A' ? [run] : []));
		__testing.setResolveRunAdmissions(resolver);
		const conn = newConn();
		__testing.connections.set(conn, { sessionId: null });
		expect(
			(await hello(conn, { sessionId: 'sess-A', admission: JSON.stringify(run) })).result
		).toEqual({ ok: true });
		expect(__testing.connections.get(conn)).toEqual({ sessionId: 'sess-A', admission: run });
		expect(resolver).toHaveBeenCalledWith('sess-A');
		const tool = await __testing.dispatch(conn, { id: 2, method: 'listTerminals' });
		expect(tool.error).toBeUndefined();
		expect(tools.listTerminals).toHaveBeenCalledWith('sess-A');
		// Resolved through the process tree instead: held to the session the walk found.
		__testing.setResolveSessionFromPid(async (pid) => (pid === 4242 ? 'sess-A' : null));
		const byPid = newConn();
		__testing.connections.set(byPid, { sessionId: null });
		expect((await hello(byPid, { ppid: 4242, admission: JSON.stringify(run) })).result).toEqual({
			ok: true,
		});
		expect(__testing.connections.get(byPid)?.admission).toEqual(run);
	});
});
