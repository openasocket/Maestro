/**
 * Acceptance evidence for the Electron cases (MCOMP-33-02B).
 *
 * Every `electron.*` case of `ACCEPTANCE_CASES` in
 * `src/__tests__/integration/mega-maestro/journeys.ts` writes one
 * `AcceptanceCaseEvidence` record to the JSON array named by
 * MAESTRO_E2E_CASE_EVIDENCE, which the pair runner reads with
 * `--case-evidence` and assesses with `assessAcceptance`.
 *
 * What a record says is read, not declared: the host from the main process
 * (`process.versions.electron`), the observations from the stores and files
 * on disk. Fixture mode is labeled `endpoint: 'fixture'` and names no paired
 * artifact, so it never counts. Endpoint mode needs the exact paired
 * artifacts by name (`artifacts` in MAESTRO_E2E_ENDPOINT_INPUTS and the
 * packaged app at MAESTRO_E2E_APP_PACKAGE); a missing one fails the case
 * before it runs, and nothing is recorded for a case that did not run.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ElectronApplication } from '@playwright/test';
import {
	ACCEPTANCE_CASES,
	type AcceptanceCase,
	type AcceptanceCaseEvidence,
	type AcceptanceHost,
	type AcceptanceObservation,
} from '../../src/__tests__/integration/mega-maestro/journeys';
import type { ManagedMode } from './managed-host';

export { observeLedgerReceipt } from '../../src/__tests__/integration/mega-maestro/journeys';

/** The dispatch ledger the desktop writes into its data directory. */
export const ledgerFile = (dataDir: string) =>
	path.join(dataDir, 'maestro-managed-dispatch-receipts.json');

/** The Electron case of the catalog; an id the catalog does not hold is an authoring error. */
export function electronCase(id: string): AcceptanceCase {
	const spec = ACCEPTANCE_CASES.find((c) => c.id === id && c.runner === 'electron');
	if (!spec) throw new Error(`${id} is not an electron case of ACCEPTANCE_CASES`);
	return spec;
}

/** Where the case ran, as the main process reports it. A browser render has no Electron version. */
export async function observeHost(app: ElectronApplication): Promise<AcceptanceHost> {
	const version = await app.evaluate(() => process.versions.electron ?? null);
	return typeof version === 'string' && version !== '' ? 'electron' : 'browser';
}

const sha256File = (file: string) =>
	createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/**
 * The exact paired artifacts. Fixture mode names none (it never counts);
 * endpoint mode fails by name on each one the environment did not give.
 */
export function caseArtifacts(mode: ManagedMode): AcceptanceCaseEvidence['artifacts'] {
	if (mode === 'fixture') return { runtimeSha256: null, endpointRevision: null, appSha256: null };
	const inputsFile = process.env.MAESTRO_E2E_ENDPOINT_INPUTS;
	const declared = inputsFile
		? ((JSON.parse(fs.readFileSync(inputsFile, 'utf8')) as { artifacts?: Record<string, string> })
				.artifacts ?? {})
		: {};
	const appPackage = process.env.MAESTRO_E2E_APP_PACKAGE;
	const missing = [
		!inputsFile && 'MAESTRO_E2E_ENDPOINT_INPUTS',
		!/^[0-9a-f]{64}$/.test(declared.runtimeSha256 ?? '') && 'artifacts.runtimeSha256',
		!declared.endpointRevision && 'artifacts.endpointRevision',
		!(appPackage && fs.existsSync(appPackage) && fs.statSync(appPackage).isFile()) &&
			'MAESTRO_E2E_APP_PACKAGE (the packaged app file the native receipt names)',
		!process.env.MAESTRO_E2E_CASE_EVIDENCE && 'MAESTRO_E2E_CASE_EVIDENCE',
	].filter(Boolean);
	if (missing.length) throw new Error(`Endpoint-mode acceptance needs: ${missing.join(', ')}.`);
	return {
		runtimeSha256: declared.runtimeSha256,
		endpointRevision: declared.endpointRevision,
		appSha256: sha256File(appPackage!),
	};
}

/**
 * An on-disk observation: each named check is a fact the observer read from
 * a file or a store; any false check is a problem by name.
 */
export function observeOnDisk(
	detail: Record<string, unknown>,
	checks: Record<string, boolean>
): AcceptanceObservation {
	const problems = Object.entries(checks)
		.filter(([, ok]) => !ok)
		.map(([name]) => `not observed: ${name}`);
	return { observed: problems.length === 0, by: 'filesystem', detail, problems };
}

/** The sorted entries of a directory, read back from disk. */
export const listDir = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);

/** The agent records the sessions store wrote to disk (not the renderer's copy). */
export function diskAgents(dataDir: string): Array<{ id: string; name: string; cwd: string }> {
	const file = path.join(dataDir, 'maestro-sessions.json');
	if (!fs.existsSync(file)) return [];
	return JSON.parse(fs.readFileSync(file, 'utf8')).sessions ?? [];
}

/** The ledger's records, read off disk; an absent ledger holds none. */
export function ledgerLeases(dataDir: string): string[] {
	const file = ledgerFile(dataDir);
	if (!fs.existsSync(file)) return [];
	const doc = JSON.parse(fs.readFileSync(file, 'utf8')) as { receipts?: { leaseId: string }[] };
	return (doc.receipts ?? []).map((r) => r.leaseId);
}

/**
 * Write one case's record, replacing an earlier record of the same case (a
 * retry), so the file never holds two records for one case. Playwright runs
 * one worker, so the read-modify-write is not raced; the write is atomic.
 */
export function writeCaseEvidence(record: AcceptanceCaseEvidence, file?: string): void {
	const target = file ?? process.env.MAESTRO_E2E_CASE_EVIDENCE;
	if (!target) return;
	const existing: AcceptanceCaseEvidence[] = fs.existsSync(target)
		? JSON.parse(fs.readFileSync(target, 'utf8'))
		: [];
	const next = [...existing.filter((r) => r.caseId !== record.caseId), record];
	const tmp = `${target}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(next, null, '\t')}\n`);
	fs.renameSync(tmp, target);
}
