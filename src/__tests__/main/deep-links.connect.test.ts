/**
 * Connect deep links (maestro://join, maestro://connect) in the main process:
 * they reach the renderer as a prefill on megaConnect:prefill, never connect,
 * and never put the URL (which carries a join or team code) in a log line.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

const handlers = new Map<string, (...args: unknown[]) => void>();

vi.mock('electron', () => ({
	app: {
		isPackaged: false,
		setAsDefaultProtocolClient: vi.fn(),
		requestSingleInstanceLock: vi.fn().mockReturnValue(true),
		on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
			handlers.set(event, handler);
		}),
		quit: vi.fn(),
	},
	BrowserWindow: { getAllWindows: vi.fn().mockReturnValue([]) },
}));

const logger = vi.hoisted(() => ({
	info: vi.fn(),
	debug: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
}));
vi.mock('../../main/utils/logger', () => ({ logger }));

vi.mock('../../main/utils/safe-send', () => ({
	isWebContentsAvailable: vi.fn().mockReturnValue(true),
}));

vi.mock('../../main/utils/sentry', () => ({ captureException: vi.fn() }));

const CODE = 'Ab3_dE5-fG7hJ9kL2mN4pQ6r';
const JOIN = `maestro://join?server=mega.acme.com&code=${CODE}`;
const CONNECT = 'maestro://connect?server=mega.acme.com&team=ACME-WEB-7K3M';

function fakeWindow() {
	return {
		isMinimized: vi.fn().mockReturnValue(false),
		restore: vi.fn(),
		show: vi.fn(),
		focus: vi.fn(),
		webContents: { send: vi.fn() },
	};
}

type FakeWindow = ReturnType<typeof fakeWindow>;

async function setup(win: FakeWindow | null) {
	vi.resetModules();
	handlers.clear();
	const mod = await import('../../main/deep-links');
	let current = win;
	const getWindow = () => current as never;
	expect(mod.setupDeepLinkHandling(getWindow)).toBe(true);
	return {
		mod,
		getWindow,
		setWindow: (w: FakeWindow) => {
			current = w;
		},
		openUrl: (url: string) => handlers.get('open-url')!({ preventDefault: vi.fn() }, url),
		secondInstance: (argv: string[]) => handlers.get('second-instance')!({}, argv),
	};
}

function loggedText(): string {
	return JSON.stringify([
		...logger.info.mock.calls,
		...logger.debug.mock.calls,
		...logger.warn.mock.calls,
		...logger.error.mock.calls,
	]);
}

beforeEach(() => {
	process.env.ENFORCE_SINGLE_INSTANCE_IN_DEV = '1';
	vi.clearAllMocks();
});

afterEach(() => {
	delete process.env.ENFORCE_SINGLE_INSTANCE_IN_DEV;
});

describe('connect deep links', () => {
	it('sends a join link to the renderer as a prefill (macOS open-url)', async () => {
		const win = fakeWindow();
		const { openUrl } = await setup(win);
		openUrl(JOIN);
		expect(win.focus).toHaveBeenCalled();
		expect(win.webContents.send).toHaveBeenCalledTimes(1);
		expect(win.webContents.send).toHaveBeenCalledWith('megaConnect:prefill', {
			kind: 'join',
			server: 'mega.acme.com',
			code: CODE,
		});
	});

	it('sends a connect link to the renderer as a prefill (second-instance argv)', async () => {
		const win = fakeWindow();
		const { secondInstance } = await setup(win);
		secondInstance(['/Applications/Maestro', '--flag', CONNECT]);
		expect(win.webContents.send).toHaveBeenCalledTimes(1);
		expect(win.webContents.send).toHaveBeenCalledWith('megaConnect:prefill', {
			kind: 'connect',
			server: 'mega.acme.com',
			teamCode: 'ACME-WEB-7K3M',
		});
	});

	it('queues the prefill until the window exists', async () => {
		const { mod, openUrl, setWindow, getWindow } = await setup(null);
		openUrl(JOIN);
		const win = fakeWindow();
		setWindow(win);
		expect(win.webContents.send).not.toHaveBeenCalled();
		mod.flushPendingDeepLink(getWindow);
		expect(win.webContents.send).toHaveBeenCalledWith(
			'megaConnect:prefill',
			expect.objectContaining({ kind: 'join', code: CODE })
		);
	});

	it.each([
		['a bad code', 'maestro://join?server=mega.acme.com&code=short-but-secret'],
		['an oversized URL', `${JOIN}&pad=${'x'.repeat(2100)}`],
		['an unknown parameter', `${JOIN}&approve=1`],
	])('drops %s without sending or logging the URL', async (_label, url) => {
		const win = fakeWindow();
		const { openUrl } = await setup(win);
		openUrl(url);
		expect(win.webContents.send).not.toHaveBeenCalled();
		expect(logger.warn).toHaveBeenCalledWith('Rejected connect deep link', 'DeepLink', {
			link: 'join',
		});
		expect(loggedText()).not.toContain('short-but-secret');
		expect(loggedText()).not.toContain(CODE);
	});

	it('never logs a join or team code on the accepted path', async () => {
		const { openUrl, secondInstance, mod, getWindow } = await setup(fakeWindow());
		openUrl(JOIN);
		secondInstance([CONNECT]);
		mod.flushPendingDeepLink(getWindow);
		const text = loggedText();
		expect(text).not.toContain(CODE);
		expect(text).not.toContain('ACME-WEB-7K3M');
		expect(text).not.toContain('mega.acme.com');
	});

	it('leaves navigation links on app:deepLink', async () => {
		const win = fakeWindow();
		const { openUrl } = await setup(win);
		openUrl('maestro://session/abc');
		expect(win.webContents.send).toHaveBeenCalledWith('app:deepLink', {
			action: 'session',
			sessionId: 'abc',
		});
	});

	it('never reaches connect: the deep link path imports nothing that can enroll', () => {
		// SX3: a deep link authorizes nothing. The only effect is the prefill send
		// above; the module must not import the enterprise service or any connect
		// operation that could act on it.
		const source = readFileSync(path.join(__dirname, '../../main/deep-links.ts'), 'utf8');
		const imports = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
		expect(imports.filter((i) => /enterprise|enroll|connect\b|megaConnect\/port/.test(i))).toEqual(
			[]
		);
		expect(source).not.toMatch(/\bconnect\(/);
	});
});
