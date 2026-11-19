#!/usr/bin/env node
/**
 * Package the Maestro collection consumer (MAESTRO-COLLECTION-CONSUMERS-BUILD):
 * the content collection ceiling and capture under the signed profile, and the
 * VIBES evidence graph built from a capture, built against the public 0.4.0
 * contracts.
 *
 *   node scripts/package-mega-maestro-collection-consumers.mjs
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
	artifactId: 'MAESTRO-COLLECTION-CONSUMERS-BUILD',
	kind: 'maestro-collection-consumer',
	entries: Object.freeze(['src/main/enterprise/content.ts', 'src/main/enterprise/vibes.ts']),
	outDir: 'dist/mega-maestro-collection-consumers',
	archiveName: 'collection-consumers.tgz',
	testedExports: Object.freeze([
		'profileAdmits',
		'parseContentCollectionCeiling',
		'createContentCapture',
		'createContentCollectionSource',
		'buildVibesRecordedGraph',
		'vibesEvidenceOf',
	]),
	suites: Object.freeze([
		'src/__tests__/main/enterprise/content.test.ts',
		'src/__tests__/main/enterprise/vibes.test.ts',
	]),
	standing:
		'The content collection ceiling, capture and delivery under the signed profile, and the VIBES evidence graph, as Maestro builds them under contracts 0.4.0. Grants no collection authority and proves no paired, native or real-tenant support.',
	scope:
		'Content capture and VIBES evidence over an injected delivery port and a fixture profile. The Mega collection endpoint and the signed profile are not in this archive.',
	limitations: [
		'The collection endpoint, the signed profile and the tenant are Mega-owned and are not qualified here.',
	],
});

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	await runConsumerCli(CONSUMER);
}
