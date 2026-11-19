#!/usr/bin/env node
/**
 * Package the Maestro workflow consumer (MAESTRO-WORKFLOW-CONSUMERS-BUILD): the
 * owner fence, the endpoint workflow lifecycle (claim, renew, settle, release)
 * and the owner port, built against the public 0.4.0 contracts.
 *
 *   node scripts/package-mega-maestro-workflow-consumers.mjs
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
	artifactId: 'MAESTRO-WORKFLOW-CONSUMERS-BUILD',
	kind: 'maestro-workflow-consumer',
	entries: Object.freeze([
		'src/shared/maestro-lib/managed/workflow-lifecycle.ts',
		'src/shared/maestro-lib/managed/workflows.ts',
	]),
	outDir: 'dist/mega-maestro-workflow-consumers',
	archiveName: 'workflow-consumers.tgz',
	testedExports: Object.freeze([
		'createWorkflowOwnership',
		'createEndpointWorkflowOwnerPort',
		'endpointWorkflowLifecyclePort',
		'createEndpointWorkflowClient',
	]),
	suites: Object.freeze([
		'src/__tests__/shared/maestro-lib/managed/workflows.test.ts',
		'src/__tests__/shared/maestro-lib/managed/workflow-lifecycle.test.ts',
	]),
	standing:
		'The workflow owner fence and the endpoint workflow lifecycle (claim, renew, settle, release) as Maestro consumes them under contracts 0.4.0. Grants no execution authority and proves no paired, native or real-provider support.',
	scope:
		'Owner fence, lifecycle client and owner port over an injected endpoint port. The endpoint, the workflow registry and the delegation producer are not in this archive.',
	limitations: [
		'The workflow registry and the delegation producer are Mega-owned and are not qualified here.',
	],
});

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	await runConsumerCli(CONSUMER);
}
