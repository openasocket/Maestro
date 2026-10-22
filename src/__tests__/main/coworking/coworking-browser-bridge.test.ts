/**
 * Bridge dispatch tests for the browser tools: read methods, param validation,
 * and the per-agent interaction permission gate (a hand-configured MCP client
 * must not be able to bypass the UI toggle).
 *
 * Like coworking-bridge.test.ts we drive `dispatch` directly via the test-only
 * export. coworking-tools is mocked, but coworking-registry is real so the
 * interaction-permission gate exercises the actual registry state.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('electron', () => ({
	app: { getPath: () => '/tmp/coworking-test-userdata' },
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../main/coworking/coworking-tools', () => ({
	listTerminals: vi.fn(),
	readTerminal: vi.fn(),
	listBrowsers: vi.fn(() => ({
		browsers: [
			{
				id: 'browser:1',
				url: 'https://e',
				title: 'E',
				canGoBack: false,
				canGoForward: false,
				isLoading: false,
			},
		],
	})),
	getBrowserUrl: vi.fn((_sessionId: string, args: { id: string }) => ({
		id: args.id,
		url: 'https://e',
		title: 'E',
	})),
	readBrowser: vi.fn(
		async (_sessionId: string, args: { id: string; format?: string; maxChars?: number }) => ({
			id: args.id,
			url: 'https://e',
			title: 'E',
			format: args.format ?? 'text',
			content: 'PAGE',
			truncated: false,
			totalChars: 4,
		})
	),
	browserInteract: vi.fn(async (_sessionId: string, args: { op: { kind: string } }) => ({
		ok: true,
		content: 'did ' + args.op.kind,
	})),
}));

import { __testing, coworkingEffectOf } from '../../../main/coworking/coworking-bridge';
import type { BrowserOp } from '../../../main/coworking/coworking-types';
import type {
	BrowserEffectAuthority,
	BrowserEffectDecision,
	BrowserEffectKind,
	BrowserEffectRequest,
} from '../../../main/enterprise/browser-policy';
import * as tools from '../../../main/coworking/coworking-tools';
import { coworkingRegistry } from '../../../main/coworking/coworking-registry';
import type { Socket } from 'net';
import {
	setBrowserAuditSink,
	type BrowserAuditEntry,
} from '../../../main/coworking/coworking-audit';

function newConn(): Socket {
	return {} as unknown as Socket;
}

async function helloAs(conn: Socket, sessionId: string): Promise<void> {
	await __testing.dispatch(conn, { id: 1, method: 'hello', params: { sessionId } });
}

describe('coworking-bridge browser dispatch', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		__testing.setResolveSessionFromPid(null);
		coworkingRegistry.reset();
	});

	it('listBrowsers after hello dispatches with the bound sessionId', async () => {
		const conn = newConn();
		__testing.connections.set(conn, { sessionId: null });
		await helloAs(conn, 'sess-A');
		const resp = await __testing.dispatch(conn, { id: 2, method: 'listBrowsers' });
		expect(resp.error).toBeUndefined();
		expect(tools.listBrowsers).toHaveBeenCalledWith('sess-A');
	});

	it('listBrowsers is rejected before hello', async () => {
		const conn = newConn();
		__testing.connections.set(conn, { sessionId: null });
		const resp = await __testing.dispatch(conn, { id: 1, method: 'listBrowsers' });
		expect(resp.error?.code).toBe(-32002);
		expect(tools.listBrowsers).not.toHaveBeenCalled();
	});

	it('getBrowserUrl requires an id', async () => {
		const conn = newConn();
		__testing.connections.set(conn, { sessionId: null });
		await helloAs(conn, 'sess-A');
		const resp = await __testing.dispatch(conn, { id: 2, method: 'getBrowserUrl', params: {} });
		expect(resp.error?.code).toBe(-32602);
	});

	it('readBrowser rejects an invalid format and a non-positive maxChars', async () => {
		const conn = newConn();
		__testing.connections.set(conn, { sessionId: null });
		await helloAs(conn, 'sess-A');
		const badFormat = await __testing.dispatch(conn, {
			id: 2,
			method: 'readBrowser',
			params: { id: 'browser:1', format: 'pdf' },
		});
		expect(badFormat.error?.code).toBe(-32602);
		const badMax = await __testing.dispatch(conn, {
			id: 3,
			method: 'readBrowser',
			params: { id: 'browser:1', maxChars: 0 },
		});
		expect(badMax.error?.code).toBe(-32602);
	});

	it('readBrowser dispatches with valid params', async () => {
		const conn = newConn();
		__testing.connections.set(conn, { sessionId: null });
		await helloAs(conn, 'sess-A');
		const resp = await __testing.dispatch(conn, {
			id: 2,
			method: 'readBrowser',
			params: { id: 'browser:1', format: 'html', maxChars: 100 },
		});
		expect(resp.error).toBeUndefined();
		expect(tools.readBrowser).toHaveBeenCalledWith('sess-A', {
			id: 'browser:1',
			format: 'html',
			maxChars: 100,
		});
	});

	it('browserInteract is rejected when interaction is not enabled for the session', async () => {
		const conn = newConn();
		__testing.connections.set(conn, { sessionId: null });
		await helloAs(conn, 'sess-A');
		const resp = await __testing.dispatch(conn, {
			id: 2,
			method: 'browserInteract',
			params: { id: 'browser:1', op: { kind: 'reload' } },
		});
		expect(resp.error?.code).toBe(-32002);
		expect(tools.browserInteract).not.toHaveBeenCalled();
	});

	it('browserInteract dispatches when interaction is enabled for the session', async () => {
		const conn = newConn();
		__testing.connections.set(conn, { sessionId: null });
		await helloAs(conn, 'sess-A');
		coworkingRegistry.syncSessionBrowsers('sess-A', [], true);
		const resp = await __testing.dispatch(conn, {
			id: 2,
			method: 'browserInteract',
			params: { id: 'browser:1', op: { kind: 'reload' } },
		});
		expect(resp.error).toBeUndefined();
		expect(tools.browserInteract).toHaveBeenCalledWith('sess-A', {
			id: 'browser:1',
			op: { kind: 'reload' },
		});
	});

	it('browserInteract rejects the read op (reads must use read_browser)', async () => {
		const conn = newConn();
		__testing.connections.set(conn, { sessionId: null });
		await helloAs(conn, 'sess-A');
		coworkingRegistry.syncSessionBrowsers('sess-A', [], true);
		const resp = await __testing.dispatch(conn, {
			id: 2,
			method: 'browserInteract',
			params: { id: 'browser:1', op: { kind: 'read', format: 'text' } },
		});
		expect(resp.error?.code).toBe(-32602);
		expect(tools.browserInteract).not.toHaveBeenCalled();
	});

	it('browserInteract accepts navigate with a url and rejects it without one', async () => {
		const conn = newConn();
		__testing.connections.set(conn, { sessionId: null });
		await helloAs(conn, 'sess-A');
		coworkingRegistry.syncSessionBrowsers('sess-A', [], true);
		const ok = await __testing.dispatch(conn, {
			id: 2,
			method: 'browserInteract',
			params: { id: 'browser:1', op: { kind: 'navigate', url: 'https://x.com' } },
		});
		expect(ok.error).toBeUndefined();
		expect(tools.browserInteract).toHaveBeenCalledWith('sess-A', {
			id: 'browser:1',
			op: { kind: 'navigate', url: 'https://x.com' },
		});
		const bad = await __testing.dispatch(conn, {
			id: 3,
			method: 'browserInteract',
			params: { id: 'browser:1', op: { kind: 'navigate' } },
		});
		expect(bad.error?.code).toBe(-32602);
	});

	it('browserInteract dispatches newTab without an id (session-scoped op)', async () => {
		const conn = newConn();
		__testing.connections.set(conn, { sessionId: null });
		await helloAs(conn, 'sess-A');
		coworkingRegistry.syncSessionBrowsers('sess-A', [], true);
		const resp = await __testing.dispatch(conn, {
			id: 2,
			method: 'browserInteract',
			params: { op: { kind: 'newTab', url: 'https://x.com', ephemeral: true } },
		});
		expect(resp.error).toBeUndefined();
		expect(tools.browserInteract).toHaveBeenCalledWith('sess-A', {
			id: undefined,
			op: { kind: 'newTab', url: 'https://x.com', ephemeral: true },
		});
	});

	it('browserInteract newTab rejects mistyped url/ephemeral params', async () => {
		const conn = newConn();
		__testing.connections.set(conn, { sessionId: null });
		await helloAs(conn, 'sess-A');
		coworkingRegistry.syncSessionBrowsers('sess-A', [], true);
		const badUrl = await __testing.dispatch(conn, {
			id: 2,
			method: 'browserInteract',
			params: { op: { kind: 'newTab', url: 42 } },
		});
		expect(badUrl.error?.code).toBe(-32602);
		const badEphemeral = await __testing.dispatch(conn, {
			id: 3,
			method: 'browserInteract',
			params: { op: { kind: 'newTab', ephemeral: 'yes' } },
		});
		expect(badEphemeral.error?.code).toBe(-32602);
		expect(tools.browserInteract).not.toHaveBeenCalled();
	});

	it('browserInteract still requires an id for every non-newTab op', async () => {
		const conn = newConn();
		__testing.connections.set(conn, { sessionId: null });
		await helloAs(conn, 'sess-A');
		coworkingRegistry.syncSessionBrowsers('sess-A', [], true);
		for (const op of [
			{ kind: 'closeTab' },
			{ kind: 'reload' },
			{ kind: 'waitFor', selector: '#x' },
		]) {
			const resp = await __testing.dispatch(conn, {
				id: 2,
				method: 'browserInteract',
				params: { op },
			});
			expect(resp.error?.code, `op ${op.kind} without id`).toBe(-32602);
		}
		expect(tools.browserInteract).not.toHaveBeenCalled();
	});

	it('browserInteract accepts closeTab with an id', async () => {
		const conn = newConn();
		__testing.connections.set(conn, { sessionId: null });
		await helloAs(conn, 'sess-A');
		coworkingRegistry.syncSessionBrowsers('sess-A', [], true);
		const resp = await __testing.dispatch(conn, {
			id: 2,
			method: 'browserInteract',
			params: { id: 'browser:1', op: { kind: 'closeTab' } },
		});
		expect(resp.error).toBeUndefined();
		expect(tools.browserInteract).toHaveBeenCalledWith('sess-A', {
			id: 'browser:1',
			op: { kind: 'closeTab' },
		});
	});

	it('waitFor validation enforces the selector and the 1..30000 integer timeout', async () => {
		const conn = newConn();
		__testing.connections.set(conn, { sessionId: null });
		await helloAs(conn, 'sess-A');
		coworkingRegistry.syncSessionBrowsers('sess-A', [], true);
		const cases: Array<{ name: string; op: Record<string, unknown>; ok: boolean }> = [
			{ name: 'no timeout', op: { kind: 'waitFor', selector: '#x' }, ok: true },
			{ name: 'min timeout 1', op: { kind: 'waitFor', selector: '#x', timeoutMs: 1 }, ok: true },
			{
				name: 'max timeout 30000',
				op: { kind: 'waitFor', selector: '#x', timeoutMs: 30000 },
				ok: true,
			},
			{ name: 'zero timeout', op: { kind: 'waitFor', selector: '#x', timeoutMs: 0 }, ok: false },
			{
				name: 'over max timeout',
				op: { kind: 'waitFor', selector: '#x', timeoutMs: 30001 },
				ok: false,
			},
			{
				name: 'non-integer timeout',
				op: { kind: 'waitFor', selector: '#x', timeoutMs: 1.5 },
				ok: false,
			},
			{ name: 'missing selector', op: { kind: 'waitFor', timeoutMs: 100 }, ok: false },
			{ name: 'non-string selector', op: { kind: 'waitFor', selector: 7 }, ok: false },
		];
		let reqId = 10;
		for (const c of cases) {
			const resp = await __testing.dispatch(conn, {
				id: reqId++,
				method: 'browserInteract',
				params: { id: 'browser:1', op: c.op },
			});
			if (c.ok) {
				expect(resp.error, c.name).toBeUndefined();
			} else {
				expect(resp.error?.code, c.name).toBe(-32602);
			}
		}
	});
});

describe('coworking-bridge browser audit', () => {
	let entries: BrowserAuditEntry[];

	beforeEach(() => {
		vi.clearAllMocks();
		__testing.setResolveSessionFromPid(null);
		coworkingRegistry.reset();
		entries = [];
		setBrowserAuditSink((e) => entries.push(e));
	});

	afterEach(() => {
		setBrowserAuditSink(null);
	});

	it('records an ok entry with agentType for a read tool', async () => {
		const conn = newConn();
		__testing.connections.set(conn, { sessionId: null });
		await helloAs(conn, 'sess-A');
		coworkingRegistry.syncSessionBrowsers('sess-A', [], false, 'claude-code');
		await __testing.dispatch(conn, { id: 2, method: 'listBrowsers' });
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			sessionId: 'sess-A',
			agentType: 'claude-code',
			tool: 'list_browsers',
			status: 'ok',
		});
		expect(typeof entries[0].ts).toBe('number');
	});

	it('records a denied entry when interaction is not enabled', async () => {
		const conn = newConn();
		__testing.connections.set(conn, { sessionId: null });
		await helloAs(conn, 'sess-A');
		const resp = await __testing.dispatch(conn, {
			id: 2,
			method: 'browserInteract',
			params: { id: 'browser:1', op: { kind: 'reload' } },
		});
		expect(resp.error?.code).toBe(-32002);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ tool: 'browser_interact', status: 'denied' });
	});

	it('records ok with opKind + redacted detail for an allowed interaction op', async () => {
		const conn = newConn();
		__testing.connections.set(conn, { sessionId: null });
		await helloAs(conn, 'sess-A');
		coworkingRegistry.syncSessionBrowsers('sess-A', [], true, 'codex');
		await __testing.dispatch(conn, {
			id: 2,
			method: 'browserInteract',
			params: { id: 'browser:1', op: { kind: 'navigate', url: 'https://x.com' } },
		});
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			tool: 'browser_interact',
			opKind: 'navigate',
			status: 'ok',
			agentType: 'codex',
		});
		expect(entries[0].detail).toContain('https://x.com');
	});

	it('records an error entry when the tool throws', async () => {
		const conn = newConn();
		__testing.connections.set(conn, { sessionId: null });
		await helloAs(conn, 'sess-A');
		vi.mocked(tools.readBrowser).mockRejectedValueOnce(new Error('boom'));
		await __testing.dispatch(conn, { id: 2, method: 'readBrowser', params: { id: 'browser:1' } });
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ tool: 'read_browser', status: 'error' });
	});

	it('records list_terminals with the session agentType', async () => {
		const conn = newConn();
		__testing.connections.set(conn, { sessionId: null });
		await helloAs(conn, 'sess-A');
		coworkingRegistry.syncSessionBrowsers('sess-A', [], false, 'opencode');
		await __testing.dispatch(conn, { id: 2, method: 'listTerminals' });
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			sessionId: 'sess-A',
			agentType: 'opencode',
			tool: 'list_terminals',
			status: 'ok',
		});
	});

	it('records read_terminal with an id/lines detail (never terminal content)', async () => {
		const conn = newConn();
		__testing.connections.set(conn, { sessionId: null });
		await helloAs(conn, 'sess-A');
		coworkingRegistry.syncSessionBrowsers('sess-A', [], false, 'claude-code');
		vi.mocked(tools.readTerminal).mockResolvedValueOnce({
			id: 'term:1',
			content: 'SECRET SCROLLBACK',
			truncated: false,
			totalLines: 1,
		});
		await __testing.dispatch(conn, {
			id: 2,
			method: 'readTerminal',
			params: { id: 'term:1', lines: 5 },
		});
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			sessionId: 'sess-A',
			agentType: 'claude-code',
			tool: 'read_terminal',
			status: 'ok',
			detail: 'id=term:1 lines=5',
		});
		expect(JSON.stringify(entries[0])).not.toContain('SECRET SCROLLBACK');
	});

	it('newTab audit detail is redacted to origin+path and flags ephemeral', async () => {
		const conn = newConn();
		__testing.connections.set(conn, { sessionId: null });
		await helloAs(conn, 'sess-A');
		coworkingRegistry.syncSessionBrowsers('sess-A', [], true, 'codex');
		await __testing.dispatch(conn, {
			id: 2,
			method: 'browserInteract',
			params: { op: { kind: 'newTab', url: 'https://x.com/p?token=abc', ephemeral: true } },
		});
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ tool: 'browser_interact', opKind: 'newTab', status: 'ok' });
		expect(entries[0].detail).toContain('url=https://x.com/p');
		expect(entries[0].detail).toContain('ephemeral');
		expect(entries[0].detail).not.toContain('token');
	});
});

describe('coworking-bridge browser ceiling (MRC-09-04A)', () => {
	let entries: BrowserAuditEntry[];
	let held: BrowserEffectRequest[];
	/** The ceiling double: refuse every effect kind this names, by name. */
	let refuse: Set<BrowserEffectKind>;
	let asked: number;

	const receipt = (request: BrowserEffectRequest, outcome: 'outside-ceiling') => ({
		policyRevision: 3,
		surface: request.surface,
		actor: 'agent sess-A',
		effect: request.effect,
		destination: null,
		outcome,
	});

	const ceiling = (): BrowserEffectAuthority => ({
		authorize(request): BrowserEffectDecision {
			asked += 1;
			held.push(request);
			if (!refuse.has(request.effect)) return { allowed: true };
			return {
				allowed: false,
				code: 'outside-ceiling',
				message: `the ceiling admits no ${request.effect} for agents`,
				managed: receipt(request, 'outside-ceiling'),
			};
		},
	});

	const page = (tabUuid: string, url: string) => ({
		tabUuid,
		url,
		title: 'T',
		canGoBack: false,
		canGoForward: false,
		isLoading: false,
	});

	async function bound(
		interaction = false,
		agentType?: string,
		tabs = [page('uuid-1', 'https://app.example.com/path?token=secret')]
	): Promise<Socket> {
		const conn = newConn();
		__testing.connections.set(conn, { sessionId: null });
		await helloAs(conn, 'sess-A');
		coworkingRegistry.syncSessionBrowsers('sess-A', tabs, interaction, agentType);
		return conn;
	}

	beforeEach(() => {
		vi.clearAllMocks();
		__testing.setResolveSessionFromPid(null);
		coworkingRegistry.reset();
		entries = [];
		held = [];
		refuse = new Set();
		asked = 0;
		setBrowserAuditSink((e) => entries.push(e));
		__testing.setBrowserAuthority(ceiling);
	});

	afterEach(() => {
		setBrowserAuditSink(null);
		__testing.setBrowserAuthority(null);
	});

	it.each([
		['no reader', null],
		['a reader answering null (standalone)', () => null],
	] as const)('holds nothing with %s: every call runs as before', async (_name, reader) => {
		__testing.setBrowserAuthority(reader);
		const conn = await bound(true, 'claude-code');
		const list = await __testing.dispatch(conn, { id: 2, method: 'listBrowsers' });
		expect(list.error).toBeUndefined();
		const read = await __testing.dispatch(conn, {
			id: 3,
			method: 'readBrowser',
			params: { id: 'browser:1' },
		});
		expect(read.error).toBeUndefined();
		const act = await __testing.dispatch(conn, {
			id: 4,
			method: 'browserInteract',
			params: { id: 'browser:1', op: { kind: 'eval', code: '1' } },
		});
		expect(act.error).toBeUndefined();
		expect(tools.browserInteract).toHaveBeenCalledTimes(1);
		expect(asked).toBe(0);
		expect(entries.map((e) => e.status)).toEqual(['ok', 'ok', 'ok']);
	});

	it('a refused read is audited denied by name and the tool is never called', async () => {
		refuse.add('read');
		const conn = await bound(false, 'codex');
		const resp = await __testing.dispatch(conn, {
			id: 2,
			method: 'readBrowser',
			params: { id: 'browser:1', format: 'html' },
		});
		expect(resp.error).toEqual({
			code: -32002,
			message: 'coworking bridge: [managed-outside-ceiling] the ceiling admits no read for agents',
		});
		expect(tools.readBrowser).not.toHaveBeenCalled();
		expect(entries).toEqual([
			expect.objectContaining({
				sessionId: 'sess-A',
				agentType: 'codex',
				tool: 'read_browser',
				status: 'denied',
				detail: 'managed-outside-ceiling',
			}),
		]);
		expect(entries[0]).not.toHaveProperty('opKind');
		expect(held).toEqual([
			{
				surface: 'coworking',
				effect: 'read',
				actor: { kind: 'agent', sessionId: 'sess-A', agentType: 'codex' },
				resource: 'page',
				destination: 'https://app.example.com/path?token=secret',
			},
		]);
	});

	it('a within-ceiling call runs and is audited ok, held once', async () => {
		const conn = await bound(false, 'codex');
		const resp = await __testing.dispatch(conn, {
			id: 2,
			method: 'getBrowserUrl',
			params: { id: 'browser:1' },
		});
		expect(resp.error).toBeUndefined();
		expect(tools.getBrowserUrl).toHaveBeenCalledWith('sess-A', { id: 'browser:1' });
		expect(asked).toBe(1);
		expect(held[0]).toMatchObject({ effect: 'view', resource: 'page' });
		expect(entries).toEqual([expect.objectContaining({ tool: 'get_browser_url', status: 'ok' })]);
	});

	it('a tab the registry never heard of is a page effect with no destination', async () => {
		const conn = await bound(false, 'codex');
		await __testing.dispatch(conn, { id: 2, method: 'readBrowser', params: { id: 'browser:9' } });
		expect(held[0]).toMatchObject({ effect: 'read', resource: 'page', destination: null });
	});

	it('navigate is held against the URL it names, not the page the tab is on', async () => {
		refuse.add('navigate');
		const conn = await bound(true, 'claude-code');
		const resp = await __testing.dispatch(conn, {
			id: 2,
			method: 'browserInteract',
			params: { id: 'browser:1', op: { kind: 'navigate', url: 'https://other.test/x' } },
		});
		expect(resp.error?.code).toBe(-32002);
		expect(resp.error?.message).toMatch(/^coworking bridge: \[managed-outside-ceiling\] /);
		expect(tools.browserInteract).not.toHaveBeenCalled();
		expect(held).toEqual([
			expect.objectContaining({
				effect: 'navigate',
				resource: 'page',
				destination: 'https://other.test/x',
			}),
		]);
		expect(entries).toEqual([
			expect.objectContaining({
				tool: 'browser_interact',
				opKind: 'navigate',
				status: 'denied',
				detail: 'managed-outside-ceiling',
			}),
		]);
	});

	it('newTab is held against its URL, or against no destination for the home page', async () => {
		const conn = await bound(true, 'claude-code');
		await __testing.dispatch(conn, {
			id: 2,
			method: 'browserInteract',
			params: { op: { kind: 'newTab', url: 'https://new.test/' } },
		});
		await __testing.dispatch(conn, {
			id: 3,
			method: 'browserInteract',
			params: { op: { kind: 'newTab' } },
		});
		expect(held.map((h) => [h.effect, h.resource, h.destination])).toEqual([
			['navigate', 'page', 'https://new.test/'],
			['navigate', 'page', null],
		]);
		expect(tools.browserInteract).toHaveBeenCalledTimes(2);
	});

	it('eval is an execute and click an input; each refused by itself with the tab still listed', async () => {
		refuse.add('execute').add('input');
		const conn = await bound(true, 'claude-code');
		const evalResp = await __testing.dispatch(conn, {
			id: 2,
			method: 'browserInteract',
			params: { id: 'browser:1', op: { kind: 'eval', code: 'document.title' } },
		});
		const clickResp = await __testing.dispatch(conn, {
			id: 3,
			method: 'browserInteract',
			params: { id: 'browser:1', op: { kind: 'click', selector: '#go' } },
		});
		const reload = await __testing.dispatch(conn, {
			id: 4,
			method: 'browserInteract',
			params: { id: 'browser:1', op: { kind: 'reload' } },
		});
		expect(evalResp.error?.message).toContain('[managed-outside-ceiling]');
		expect(clickResp.error?.message).toContain('[managed-outside-ceiling]');
		expect(reload.error).toBeUndefined();
		expect(held.map((h) => h.effect)).toEqual(['execute', 'input', 'navigate']);
		expect(held.map((h) => h.destination)).toEqual([
			'https://app.example.com/path?token=secret',
			'https://app.example.com/path?token=secret',
			'https://app.example.com/path?token=secret',
		]);
		expect(tools.browserInteract).toHaveBeenCalledTimes(1);
		expect(entries.map((e) => [e.opKind, e.status, e.detail])).toEqual([
			['eval', 'denied', 'managed-outside-ceiling'],
			['click', 'denied', 'managed-outside-ceiling'],
			['reload', 'ok', expect.any(String)],
		]);
		expect(JSON.stringify(entries)).not.toContain('document.title');
	});

	it('the interaction toggle refuses before the ceiling is asked', async () => {
		const conn = await bound(false, 'claude-code');
		const resp = await __testing.dispatch(conn, {
			id: 2,
			method: 'browserInteract',
			params: { id: 'browser:1', op: { kind: 'reload' } },
		});
		expect(resp.error?.code).toBe(-32002);
		expect(resp.error?.message).not.toContain('managed-');
		expect(asked).toBe(0);
		expect(entries).toEqual([
			expect.objectContaining({ tool: 'browser_interact', status: 'denied' }),
		]);
	});

	it('an invalid op and a missing id are refused before the ceiling is asked', async () => {
		const conn = await bound(true, 'claude-code');
		const badOp = await __testing.dispatch(conn, {
			id: 2,
			method: 'browserInteract',
			params: { id: 'browser:1', op: { kind: 'navigate', url: 'file:///etc/passwd' } },
		});
		const noId = await __testing.dispatch(conn, {
			id: 3,
			method: 'browserInteract',
			params: { op: { kind: 'reload' } },
		});
		const noReadId = await __testing.dispatch(conn, { id: 4, method: 'readBrowser', params: {} });
		expect([badOp.error?.code, noId.error?.code, noReadId.error?.code]).toEqual([
			-32602, -32602, -32602,
		]);
		expect(asked).toBe(0);
	});

	it('the handshake is required before the ceiling is asked', async () => {
		const conn = newConn();
		__testing.connections.set(conn, { sessionId: null });
		const resp = await __testing.dispatch(conn, { id: 1, method: 'listBrowsers' });
		expect(resp.error?.code).toBe(-32002);
		expect(asked).toBe(0);
	});

	it('listTerminals, readTerminal and listBrowsers are session effects with no destination', async () => {
		refuse.add('view');
		const conn = await bound(false, 'opencode');
		const terminals = await __testing.dispatch(conn, { id: 2, method: 'listTerminals' });
		const read = await __testing.dispatch(conn, {
			id: 3,
			method: 'readTerminal',
			params: { id: 'term:1', lines: 5 },
		});
		const browsers = await __testing.dispatch(conn, { id: 4, method: 'listBrowsers' });
		expect(terminals.error?.message).toContain('[managed-outside-ceiling]');
		expect(read.error).toBeUndefined();
		expect(browsers.error?.message).toContain('[managed-outside-ceiling]');
		expect(tools.listTerminals).not.toHaveBeenCalled();
		expect(tools.readTerminal).toHaveBeenCalledTimes(1);
		expect(tools.listBrowsers).not.toHaveBeenCalled();
		expect(held).toEqual([
			expect.objectContaining({ effect: 'view', resource: 'session', destination: null }),
			expect.objectContaining({ effect: 'read', resource: 'session', destination: null }),
			expect.objectContaining({ effect: 'view', resource: 'session', destination: null }),
		]);
		expect(entries.map((e) => [e.tool, e.status])).toEqual([
			['list_terminals', 'denied'],
			['read_terminal', 'ok'],
			['list_browsers', 'denied'],
		]);
	});

	it('the actor carries the agent type the registry mirrors, or null when none is known', async () => {
		const typed = await bound(false, 'claude-code');
		await __testing.dispatch(typed, { id: 2, method: 'listBrowsers' });
		coworkingRegistry.reset();
		const untyped = newConn();
		__testing.connections.set(untyped, { sessionId: null });
		await helloAs(untyped, 'sess-A');
		await __testing.dispatch(untyped, { id: 3, method: 'listBrowsers' });
		expect(held.map((h) => h.actor)).toEqual([
			{ kind: 'agent', sessionId: 'sess-A', agentType: 'claude-code' },
			{ kind: 'agent', sessionId: 'sess-A', agentType: null },
		]);
	});

	it('the reader is consulted per call, so a ceiling that appears mid-connection holds the next call', async () => {
		let source: BrowserEffectAuthority | null = null;
		__testing.setBrowserAuthority(() => source);
		const conn = await bound(false, 'codex');
		await __testing.dispatch(conn, { id: 2, method: 'readBrowser', params: { id: 'browser:1' } });
		refuse.add('read');
		source = ceiling();
		const second = await __testing.dispatch(conn, {
			id: 3,
			method: 'readBrowser',
			params: { id: 'browser:1' },
		});
		expect(second.error?.message).toContain('[managed-outside-ceiling]');
		expect(tools.readBrowser).toHaveBeenCalledTimes(1);
	});

	it.each([
		['listTerminals', undefined, 'view'],
		['readTerminal', undefined, 'read'],
		['listBrowsers', undefined, 'view'],
		['getBrowserUrl', undefined, 'view'],
		['readBrowser', undefined, 'read'],
		['browserInteract', { kind: 'navigate', url: 'https://x' }, 'navigate'],
		['browserInteract', { kind: 'back' }, 'navigate'],
		['browserInteract', { kind: 'forward' }, 'navigate'],
		['browserInteract', { kind: 'reload' }, 'navigate'],
		['browserInteract', { kind: 'stop' }, 'navigate'],
		['browserInteract', { kind: 'newTab' }, 'navigate'],
		['browserInteract', { kind: 'closeTab' }, 'navigate'],
		['browserInteract', { kind: 'click', selector: '#a' }, 'input'],
		['browserInteract', { kind: 'type', selector: '#a', text: 'hi' }, 'input'],
		['browserInteract', { kind: 'waitFor', selector: '#a' }, 'input'],
		['browserInteract', { kind: 'eval', code: '1' }, 'execute'],
		['browserInteract', { kind: 'screenshot' }, 'view'],
		['browserInteract', { kind: 'read' }, 'read'],
	] as const)('coworkingEffectOf(%s, %j) is %s', (method, op, effect) => {
		expect(coworkingEffectOf(method, op as BrowserOp | undefined)).toBe(effect);
	});
});
