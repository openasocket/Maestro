/**
 * Copy diagnostics (MSX-03-04). What is defended: the bundle is built from an
 * allowlist, so a grant ID, the matching number, the request reference and the
 * names never enter it whatever the status carries; whatever does enter is
 * passed through the contracts `redact()` and then `redactSecrets()`, so a
 * token that lands in an allowed field (the socket path, the app version) is
 * gone from the raw clipboard text; the refusal history keeps codes alone, the
 * last 50.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { createConnectService, type ConnectRefusal } from '../../../main/enterprise/connect';
import {
	CONNECT_DIAGNOSTICS_SCHEMA,
	CONNECT_REFUSAL_HISTORY_CAP,
	buildConnectDiagnostics,
	collectConnectDiagnostics,
	connectDiagnosticsText,
	createConnectRefusalHistory,
} from '../../../main/enterprise/connect-diagnostics';
import { MAESTRO_LIB_VERSION } from '../../../shared/maestro-lib/version';
import type { ConnectPort } from '../../../shared/megaConnect/port';
import type { MegaConnectStatus } from '../../../shared/megaConnect/view';

const NOW = Date.UTC(2026, 10, 22, 1, 2, 3);
const GRANT_ID = '6f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f';
const MATCH_NUMBER = '83';
const TOKEN43 = 'Q'.repeat(20) + '_-' + 'w'.repeat(21);
const API_KEY = `sk-ant-api03-${'Kx'.repeat(20)}`;
const SECRETS = [GRANT_ID, MATCH_NUMBER, TOKEN43, API_KEY, 'Acme Holdings', 'alice@acme.com'];

/** A status carrying every value the bundle must leave out, plus a smuggled grant field. */
const LOUD_STATUS = {
	kind: 'browserOpened',
	matchNumber: MATCH_NUMBER,
	request: GRANT_ID,
	serverName: 'mega.acme.com',
	grantId: GRANT_ID,
	token: TOKEN43,
} as unknown as MegaConnectStatus;

function portWith(status: MegaConnectStatus): ConnectPort {
	return {
		start: async () => {
			throw new Error(`endpoint said ${TOKEN43}`);
		},
		status: async () => ({
			status,
			names: { account: 'alice@acme.com', device: GRANT_ID, server: 'Acme Holdings' },
		}),
		disconnect: async () => {
			throw new Error(GRANT_ID);
		},
	};
}

function loudService() {
	return createConnectService({
		port: portWith(LOUD_STATUS),
		localEffects: null,
		notify: () => undefined,
		openExternal: async () => undefined,
		now: () => NOW,
		setTimer: () => () => undefined,
		diagnostics: {
			appVersion: `1.4.0 ${API_KEY}`,
			socket: () => ({ socketPath: `/tmp/mega/${TOKEN43}/endpoint.sock`, source: 'saved' }),
		},
	});
}

describe('connect diagnostics bundle', () => {
	it('never lets a grant ID, the matching number or a token reach the clipboard text', async () => {
		const service = loudService();
		await service.status();
		await service.start({ kind: 'email', email: 'alice@acme.com' });
		await service.disconnect();
		const text = connectDiagnosticsText(await service.diagnostics());
		for (const secret of SECRETS) expect(text).not.toContain(secret);
		const bundle = JSON.parse(text);
		expect(bundle).toEqual({
			schema: CONNECT_DIAGNOSTICS_SCHEMA,
			collected_at: '2026-11-22T01:02:03.000Z',
			connection_status: 'browserOpened',
			app_version: '1.4.0 [REDACTED_API_KEY]',
			library_version: MAESTRO_LIB_VERSION,
			socket_path: '/tmp/mega/[token removed]/endpoint.sock',
			socket_source: 'saved',
			recent_refusals: ['endpoint_failed', 'endpoint_failed'],
			certificate_expiry: null,
		});
	});

	it('reads only the state name of a status, however much it carries', () => {
		const bundle = collectConnectDiagnostics({
			status: { status: LOUD_STATUS, names: { account: 'alice@acme.com' } },
			refusals: [],
			appVersion: '1.4.0',
			socket: { socketPath: null, source: 'deferred', reason: 'none' },
			certificateExpiry: null,
			now: NOW,
		});
		expect(Object.keys(bundle).sort()).toEqual([
			'app_version',
			'certificate_expiry',
			'collected_at',
			'connection_status',
			'library_version',
			'recent_refusals',
			'schema',
			'socket_path',
			'socket_source',
		]);
		expect(JSON.stringify(bundle)).not.toContain(GRANT_ID);
		expect(JSON.stringify(bundle)).not.toContain(MATCH_NUMBER);
	});

	it('runs redact() and then redactSecrets() over what the allowlist let in', async () => {
		const redacted = await buildConnectDiagnostics({
			status: { status: { kind: 'unavailable' } },
			refusals: [],
			// redact() alone keeps an API key that is not 43 characters; redactSecrets() alone
			// keeps a bare 43-character token. Both must be gone.
			appVersion: `${API_KEY} ${TOKEN43}`,
			socket: { socketPath: '/var/run/mega.sock', source: 'standard' },
			certificateExpiry: null,
			now: NOW,
		});
		const text = connectDiagnosticsText(redacted);
		expect(text).not.toContain(API_KEY);
		expect(text).not.toContain(TOKEN43);
		expect(text).toContain('/var/run/mega.sock');
	});

	it('works with no diagnostics deps: no app version, the standard socket', async () => {
		const service = createConnectService({
			port: null,
			localEffects: null,
			notify: () => undefined,
			openExternal: async () => undefined,
			now: () => NOW,
		});
		const bundle = (await service.diagnostics()) as Record<string, unknown>;
		expect(bundle.connection_status).toBe('unavailable');
		expect(bundle.app_version).toBeNull();
		expect(bundle.certificate_expiry).toBeNull();
	});
});

describe('connect refusal history', () => {
	it('keeps the last 50 codes, oldest first', () => {
		const history = createConnectRefusalHistory();
		const codes: ConnectRefusal[] = [];
		for (let i = 0; i < 60; i++) {
			const code: ConnectRefusal = i % 2 ? 'pin_mismatch' : 'endpoint_failed';
			codes.push(code);
			history.note(code);
		}
		expect(history.list()).toEqual(codes.slice(-CONNECT_REFUSAL_HISTORY_CAP));
		expect(history.list()).toHaveLength(50);
	});

	it('hands out a copy', () => {
		const history = createConnectRefusalHistory();
		history.note('open_refused');
		history.list().push('pin_mismatch');
		expect(history.list()).toEqual(['open_refused']);
	});

	it('records every refusal the service answers, and the ones a handler notes, by code only', async () => {
		const service = createConnectService({
			port: null,
			localEffects: null,
			notify: () => undefined,
			openExternal: async () => undefined,
		});
		await service.start({ kind: 'email', email: 'not an email' });
		await service.start({ kind: 'email', email: 'alice@acme.com' });
		await service.disconnect();
		service.noteRefusal('invalid_input');
		expect(service.refusals()).toEqual([
			'invalid_input',
			'endpoint_connect_unavailable',
			'endpoint_connect_unavailable',
			'invalid_input',
		]);
	});

	it('caps the service history at 50 too', async () => {
		const service = createConnectService({
			port: null,
			localEffects: null,
			notify: () => undefined,
			openExternal: async () => undefined,
		});
		for (let i = 0; i < 70; i++) await service.disconnect();
		expect(service.refusals()).toHaveLength(50);
	});
});
