/**
 * Fixtures for the Mega-Maestro early-pair tests. Two kinds, each labeled
 * for what it is:
 *
 *   - Discovery of the REAL pair inputs (the built library, the CP-01 pin,
 *     the packaged endpoint artifacts or the sibling checkout, the Linux
 *     host) through the harness script's `check` mode, so a test runs the
 *     real pair when it can and names the missing producer when it cannot.
 *     Nothing here stands in for the endpoint, the adapter or a lease.
 *
 *   - The declared harmless provider double: a Node script that plays the
 *     agent binary and leaves effects a test can observe INDEPENDENTLY of
 *     what the process says about itself: a file written into its working
 *     directory, a connection attempt against a loopback listener the test
 *     owns, a descendant spawn attempt. It reaches nothing outside the
 *     machine and nothing outside its working directory; under the Node
 *     permission model the connection and the spawn are refused and the
 *     script reports the refusal rather than hiding it.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';

export const PAIR_HARNESS_SCRIPT = path.resolve(process.cwd(), 'scripts/mega-maestro-pair.mjs');

/** The id the synthetic provider double runs under. The route is `managed/provider-route.ts`. */
export const SYNTHETIC_PROVIDER_ID = 'synthetic-harness';

export interface PairDependency {
	id: string;
	owner: 'maestro' | 'mega-maestro';
	status: 'open';
	detail: string;
}

/** The harness `check` record, typed for what the tests read of it. */
export interface PairCheckReport {
	reportVersion: number;
	checkedAt: string;
	host: { platform: string; node: string; maestroHead: string | null; maestroDirty: boolean };
	library: { status: string; sourceRevision?: string; sourceDirty?: boolean; stale?: boolean };
	pin: { status: 'pinned' | 'absent' | 'malformed' };
	endpointSources: Array<{
		kind: 'packaged' | 'development-checkout';
		status: string;
		certifiable: boolean;
	}>;
	linuxHost: { docker: boolean; linux?: boolean; image: { ref: string; present: boolean } };
	approvalProducer: boolean;
	assessment: { ready: boolean; dependencies: PairDependency[] };
}

export interface RunPairCheckOptions {
	sibling?: string;
	library?: string;
	artifact?: string;
	timeoutMs?: number;
}

/** Run the harness in `check` mode and parse its record. Throws when the script itself fails. */
export function runPairCheck(options: RunPairCheckOptions = {}): PairCheckReport {
	const args = [PAIR_HARNESS_SCRIPT, 'check', '--json'];
	if (options.sibling) args.push('--sibling', options.sibling);
	if (options.library) args.push('--library', options.library);
	if (options.artifact) args.push('--artifact', options.artifact);
	const result = spawnSync(process.execPath, args, {
		encoding: 'utf8',
		timeout: options.timeoutMs ?? 60_000,
	});
	if (result.error) throw result.error;
	if (result.status !== 0 && result.status !== 2) {
		throw new Error(`mega-maestro-pair check exited ${result.status}: ${result.stderr}`);
	}
	return JSON.parse(result.stdout) as PairCheckReport;
}

/** One line naming why the real pair cannot run, for a skip message that says who owns it. */
export function describePairSkip(report: PairCheckReport): string {
	return report.assessment.dependencies
		.map((dependency) => `${dependency.id} (${dependency.owner}): ${dependency.detail}`)
		.join('; ');
}

// ---------------------------------------------------------------------------
// The synthetic provider double and its observers
// ---------------------------------------------------------------------------

export interface SyntheticProviderEffects {
	/** The file the double wrote into its working directory. */
	wroteFile: string;
	stdinBytes: number;
	/** `true` when a loopback connection was accepted; the error code when it was refused. */
	connected: boolean | string;
	/** `true` when a child process started; the error code when the runtime refused it. */
	spawnedChild: boolean | string;
	cwd: string;
	pid: number;
}

export const SYNTHETIC_EFFECTS_FILE = 'synthetic-provider-effects.json';

/**
 * The provider double. Declared harmless: it reads its prompt from stdin,
 * writes one JSON file into its cwd, tries one loopback connection to the
 * port in `PAIR_PROBE_PORT` (none when unset), tries to start one child,
 * prints one JSON line and exits 0. Every attempt is recorded as it went.
 */
const SYNTHETIC_PROVIDER_SOURCE = String.raw`
'use strict';
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const effects = { wroteFile: '', stdinBytes: 0, connected: false, spawnedChild: false, cwd: process.cwd(), pid: process.pid };
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
	effects.stdinBytes = Buffer.concat(chunks).length;
	try {
		const { spawnSync } = require('node:child_process');
		const child = spawnSync(process.execPath, ['-e', '0']);
		effects.spawnedChild = child.error ? child.error.code || String(child.error) : true;
	} catch (error) { effects.spawnedChild = error.code || String(error); }
	const finish = () => {
		const file = path.join(process.cwd(), '${SYNTHETIC_EFFECTS_FILE}');
		try { fs.writeFileSync(file, JSON.stringify(effects)); effects.wroteFile = file; }
		catch (error) { effects.wroteFile = 'refused:' + (error.code || String(error)); }
		process.stdout.write(JSON.stringify({ type: 'synthetic-provider', effects }) + '\n');
		process.exit(0);
	};
	const port = Number(process.env.PAIR_PROBE_PORT || 0);
	if (!port) return finish();
	try {
		const socket = net.connect({ host: '127.0.0.1', port });
		socket.once('connect', () => { effects.connected = true; socket.end(); finish(); });
		socket.once('error', (error) => { effects.connected = error.code || String(error); finish(); });
	} catch (error) { effects.connected = error.code || String(error); finish(); }
});
`;

/** Write the double into `dir` and return its path. */
export function writeSyntheticProvider(dir: string): string {
	const script = path.join(dir, 'synthetic-provider.cjs');
	fs.writeFileSync(script, SYNTHETIC_PROVIDER_SOURCE);
	return script;
}

/** The effects file the double left in `cwd`, or null when nothing ran there. */
export function readSyntheticEffects(cwd: string): SyntheticProviderEffects | null {
	const file = path.join(cwd, SYNTHETIC_EFFECTS_FILE);
	if (!fs.existsSync(file)) return null;
	return JSON.parse(fs.readFileSync(file, 'utf8')) as SyntheticProviderEffects;
}

export interface EgressObserver {
	port: number;
	/** Connections the listener accepted, counted by the test, not reported by the child. */
	connections(): number;
	close(): Promise<void>;
}

/** A loopback listener that counts what reaches it: the independent witness of egress. */
export function startEgressObserver(): Promise<EgressObserver> {
	return new Promise((resolve, reject) => {
		let accepted = 0;
		const server = net.createServer((socket) => {
			accepted += 1;
			socket.end();
		});
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			if (!address || typeof address === 'string') {
				reject(new Error('the observer did not bind a TCP port'));
				return;
			}
			resolve({
				port: address.port,
				connections: () => accepted,
				close: () =>
					new Promise<void>((done) => {
						server.close(() => done());
					}),
			});
		});
	});
}
