#!/usr/bin/env node
/**
 * Package the Maestro commands consumer (MAESTRO-COMMAND-CONSUMERS-BUILD): the
 * typed runtime command ledger and executor, the command receipt and request
 * reader, and the cooperative pause gate, built against the public 0.4.0 contracts.
 *
 *   node scripts/package-mega-maestro-commands-consumers.mjs
 *        --contracts <contracts.tgz> --tests <vitest-report.json>
 *        --receipt <new receipt path> [--out <dir>] [--allow-dirty]
 *
 * `--contracts` is the public contracts archive, for example
 * `../mega-maestro/artifacts/enterprise/0.4.0/<sha256>/contracts.tgz`. `--tests`
 * is the vitest JSON report of the suites named below, produced by a real run.
 * The shared steps are in `scripts/consumer-archive.mjs`.
 */
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { runConsumerCli } from './consumer-archive.mjs';

export const CONSUMER = Object.freeze({
	artifactId: 'MAESTRO-COMMAND-CONSUMERS-BUILD',
	kind: 'maestro-command-consumer',
	entries: Object.freeze(['src/shared/maestro-lib/managed/commands.ts']),
	outDir: 'dist/mega-maestro-command-consumers',
	archiveName: 'command-consumers.tgz',
	testedExports: Object.freeze([
		'createCommandExecutor',
		'createCommandLedger',
		'readCommandRequestV2',
		'commandReceiptV2Of',
		'createCooperativePauseGate',
	]),
	suites: Object.freeze([
		'src/__tests__/shared/maestro-lib/managed/commands.test.ts',
		'src/__tests__/shared/maestro-lib/managed/commands.published.test.ts',
	]),
	standing:
		'The typed runtime command ledger, executor, request and receipt reader, and cooperative pause gate as Maestro consumes them under contracts 0.4.0. Grants no command authority and proves no paired, native or real-provider support.',
	scope:
		'Command ledger, executor and pause gate over injected ports and a fixture ledger file. The signed command producer and the endpoint are not in this archive.',
	limitations: [
		'The signed command producer and the endpoint command service are Mega-owned and are not qualified here.',
	],
});

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	await runConsumerCli(CONSUMER);
}
