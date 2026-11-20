/**
 * The Mega-Maestro server address rules: the host, port and socket the operator
 * types are checked before anything is saved or contacted, and the origin an
 * enrollment request names is built from them exactly.
 */

import { describe, expect, it } from 'vitest';
import {
	megaServerHealthStatus,
	megaServerHealthUrl,
	megaServerHostProblem,
	megaServerOrigin,
	megaServerPortProblem,
	megaServerSettingsProblem,
	megaServerSocketProblem,
} from '../../shared/megaServer';

describe('megaServerHostProblem', () => {
	it.each(['mega.example.com', 'mega-1', '10.0.0.5', '192.168.1.20', '2001:db8::1'])(
		'accepts %s',
		(host) => {
			expect(megaServerHostProblem(host)).toBeNull();
		}
	);

	it('refuses an empty host', () => {
		expect(megaServerHostProblem('')).toMatch(/Enter the host name/);
	});

	it.each([
		['https://mega.example.com', 'without a scheme'],
		['mega.example.com/path', 'without a scheme'],
		['user@mega.example.com', 'without a scheme'],
		['mega example', 'without a scheme'],
	])('refuses %s', (host) => {
		expect(megaServerHostProblem(host)).toMatch(/only the host name or IP address/);
	});

	it('refuses a host name that is not a valid name', () => {
		expect(megaServerHostProblem('-bad-.example')).toMatch(/not a valid host name/);
	});

	it('refuses an IPv4 literal that is out of range', () => {
		expect(megaServerHostProblem('10.0.0.300')).toMatch(/not a valid IPv4 address/);
	});
});

describe('megaServerPortProblem', () => {
	it('accepts 1 to 65535', () => {
		expect(megaServerPortProblem(1)).toBeNull();
		expect(megaServerPortProblem(65535)).toBeNull();
	});

	it.each([0, 65536, 443.5, Number.NaN])('refuses %s', (port) => {
		expect(megaServerPortProblem(port)).toMatch(/whole number from 1 to 65535/);
	});
});

describe('megaServerSocketProblem', () => {
	it('allows an empty socket, meaning none chosen yet', () => {
		expect(megaServerSocketProblem('')).toBeNull();
	});

	it('requires an absolute path', () => {
		expect(megaServerSocketProblem('run/ipc.sock')).toMatch(/absolute path/);
		expect(megaServerSocketProblem('/var/lib/mega/run/ipc.sock')).toBeNull();
	});

	it('refuses a control character in the path', () => {
		expect(megaServerSocketProblem('/tmp/a\nb')).toMatch(/control character/);
	});
});

describe('megaServerOrigin', () => {
	it('writes the default port out of the origin only when it is not 443', () => {
		expect(megaServerOrigin({ host: 'mega.example.com', port: 443 })).toBe(
			'https://mega.example.com'
		);
		expect(megaServerOrigin({ host: 'mega.example.com', port: 8443 })).toBe(
			'https://mega.example.com:8443'
		);
	});

	it('brackets an IPv6 literal', () => {
		expect(megaServerOrigin({ host: '2001:db8::1', port: 443 })).toBe('https://[2001:db8::1]');
	});

	it('names the health route under the origin', () => {
		expect(megaServerHealthUrl({ host: '10.0.0.5', port: 9443 })).toBe(
			'https://10.0.0.5:9443/healthz'
		);
	});
});

describe('megaServerSettingsProblem', () => {
	it('reports the first problem and none when valid', () => {
		expect(megaServerSettingsProblem({ host: '', port: 443, endpointSocket: '' })).toMatch(
			/Enter the host/
		);
		expect(
			megaServerSettingsProblem({ host: 'mega.example', port: 0, endpointSocket: '' })
		).toMatch(/1 to 65535/);
		expect(
			megaServerSettingsProblem({ host: 'mega.example', port: 443, endpointSocket: 'x' })
		).toMatch(/absolute/);
		expect(
			megaServerSettingsProblem({ host: 'mega.example', port: 443, endpointSocket: '' })
		).toBeNull();
	});
});

describe('megaServerHealthStatus', () => {
	it('reads the status of a JSON health body', () => {
		expect(megaServerHealthStatus('{"status":"alive"}')).toBe('alive');
	});

	it('is null for a body that is not JSON, or has no status', () => {
		expect(megaServerHealthStatus('ok')).toBeNull();
		expect(megaServerHealthStatus('{"up":true}')).toBeNull();
	});
});
