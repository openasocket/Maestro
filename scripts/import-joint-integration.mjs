#!/usr/bin/env node
/**
 * Import the counterpart's joint integration record. Mega-Maestro owns joint
 * orchestration and writes `docs/evidence/joint-integration.json`; Maestro keeps a
 * digest-verified copy at `Plans/mega-maestro/evidence/joint-integration.json`
 * (MEGA-MAESTRO-INTEGRATION, "Handoff and joint acceptance"). The copy is written
 * only when the record's Maestro facts equal what `write-mega-maestro-handoff.mjs`
 * computes here right now: `repositoryRevision` (HEAD), `sourceTreeDigest` under
 * `SOURCE_TREE_RULES`, and the digests of the built library artifact. Any other
 * value names the differing field and writes nothing.
 *
 *   node scripts/import-joint-integration.mjs <joint-integration.json>
 *     [--out Plans/mega-maestro/evidence/joint-integration.json] [--library dist/maestro-lib]
 *     [--dry-run] [--json]
 *
 * The record's Maestro facts are read from the first of `maestro`,
 * `participants.maestro` or `handoffs.maestro`: `repositoryRevision`,
 * `sourceTreeDigest` and `artifacts[]` (`kind`, `entry.sha256`, `payloadDigest`;
 * `version`, `inputSha256` and `sourceRevision` compared when stated). The copy is
 * the record's bytes, never a re-serialization. Exit 0 imported (or `--dry-run`
 * would import), 1 a mismatch, 2 a refusal (unusable record, no built library, an
 * absolute path or a secret shape in the record, nothing written on either).
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import {
	HandoffRefusal,
	INTEGRATION_ID,
	REPO_ROOT,
	buildHandoff,
	findAbsolutePaths,
	redactSecrets,
} from './write-mega-maestro-handoff.mjs';

export const DEFAULT_JOINT_OUT_FILE = 'Plans/mega-maestro/evidence/joint-integration.json';
/** Where a counterpart record may carry Maestro's handoff facts, first match wins. */
export const MAESTRO_FACT_PATHS = Object.freeze([
	'maestro',
	'participants.maestro',
	'handoffs.maestro',
]);
/** A joint record larger than this is not a record; nothing that size is read into memory. */
export const MAX_RECORD_BYTES = 16 * 1024 * 1024;
/** The artifact members compared when the record states them (`null` skips). */
const OPTIONAL_ARTIFACT_FIELDS = Object.freeze(['version', 'inputSha256', 'sourceRevision']);

const refuse = (code, message) => {
	throw new HandoffRefusal(code, message);
};
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const posix = (file) => file.split(path.sep).join('/');
const HEX40 = /^[a-f0-9]{40}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const isRecord = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const dig = (value, dotted) =>
	dotted.split('.').reduce((v, key) => (isRecord(v) ? v[key] : undefined), value);

// ---------------------------------------------------------------------------
// Reading the record
// ---------------------------------------------------------------------------

/** The record's bytes and parsed value; refuses by name anything that is not a usable record. */
export function readJointRecord(file) {
	const name = posix(path.relative(REPO_ROOT, file));
	const stat = fs.statSync(file, { throwIfNoEntry: false });
	if (!stat?.isFile()) refuse('usage', `${name} is not a file`);
	if (stat.size > MAX_RECORD_BYTES) refuse('too-large', `${name} is ${stat.size} bytes`);
	const bytes = fs.readFileSync(file);
	let record;
	try {
		record = JSON.parse(bytes.toString('utf8'));
	} catch (error) {
		refuse('malformed', `${name}: ${error.message}`);
	}
	if (!isRecord(record)) refuse('malformed', `${name} is not a JSON object`);
	if (record.integrationId !== undefined && record.integrationId !== INTEGRATION_ID) {
		refuse(
			'integration',
			`integrationId ${JSON.stringify(record.integrationId)} is not ${INTEGRATION_ID}`
		);
	}
	const text = bytes.toString('utf8');
	const absolute = findAbsolutePaths(record);
	if (absolute.length)
		refuse('absolute-path', `the record carries absolute paths at ${absolute.join(', ')}`);
	if (redactSecrets(text).redacted) refuse('secret', 'the record carries a secret-shaped value');
	return { bytes, record, sha256: sha256(bytes) };
}

/** Maestro's facts as the record states them, with the path they were found at. */
export function maestroFactsOf(record) {
	const at = MAESTRO_FACT_PATHS.find((p) => isRecord(dig(record, p)));
	if (!at) refuse('no-maestro-facts', `no object at ${MAESTRO_FACT_PATHS.join(', ')}`);
	const facts = dig(record, at);
	const problems = [];
	if (!HEX40.test(facts.repositoryRevision ?? '')) problems.push(`${at}.repositoryRevision`);
	if (!HEX64.test(facts.sourceTreeDigest ?? '')) problems.push(`${at}.sourceTreeDigest`);
	if (!Array.isArray(facts.artifacts)) problems.push(`${at}.artifacts`);
	for (const [i, a] of (Array.isArray(facts.artifacts) ? facts.artifacts : []).entries()) {
		const where = `${at}.artifacts[${i}]`;
		if (!isRecord(a) || typeof a.kind !== 'string') problems.push(`${where}.kind`);
		else {
			if (!HEX64.test(a.entry?.sha256 ?? '')) problems.push(`${where}.entry.sha256`);
			if (!HEX64.test(a.payloadDigest ?? '')) problems.push(`${where}.payloadDigest`);
		}
	}
	if (problems.length) refuse('no-maestro-facts', `missing or malformed: ${problems.join(', ')}`);
	return { at, facts };
}

// ---------------------------------------------------------------------------
// The comparison
// ---------------------------------------------------------------------------

/**
 * Every field where the record's Maestro facts differ from the local handoff, as
 * `{ field, recorded, local }`; empty when the record describes this checkout and
 * this build exactly. The local artifact must be `ready` (built from HEAD, clean):
 * an artifact from another revision cannot be bound to this revision's evidence.
 */
export function compareWithLocal(facts, local, at = 'maestro') {
	const differences = [];
	const differ = (field, recorded, localValue) => {
		if (recorded !== localValue) differences.push({ field, recorded, local: localValue });
	};
	differ(`${at}.repositoryRevision`, facts.repositoryRevision, local.repositoryRevision);
	differ(`${at}.sourceTreeDigest`, facts.sourceTreeDigest, local.sourceTreeDigest);
	for (const artifact of local.artifacts) {
		const field = `${at}.artifacts[kind=${artifact.kind}]`;
		const recorded = facts.artifacts.find((a) => a.kind === artifact.kind);
		if (!recorded) {
			differences.push({ field, recorded: 'absent', local: artifact.entry.sha256 });
			continue;
		}
		if (artifact.status !== 'ready') {
			differences.push({ field: `${field}.status`, recorded: 'ready', local: artifact.status });
		}
		differ(`${field}.entry.sha256`, recorded.entry.sha256, artifact.entry.sha256);
		differ(`${field}.payloadDigest`, recorded.payloadDigest, artifact.payloadDigest);
		for (const name of OPTIONAL_ARTIFACT_FIELDS) {
			if (recorded[name] !== undefined && recorded[name] !== null)
				differ(`${field}.${name}`, recorded[name], artifact[name]);
		}
	}
	return differences;
}

/**
 * Verify `file` against the local handoff facts and, unless `dryRun`, copy its bytes
 * to `out`. Returns the report; `imported` is true only after the copy read back
 * with the same sha256. A mismatch never writes.
 */
export function importJointIntegration(file, options = {}) {
	const source = path.resolve(REPO_ROOT, file);
	const outFile = path.resolve(REPO_ROOT, options.out ?? DEFAULT_JOINT_OUT_FILE);
	if (source === outFile) refuse('usage', 'the record and the destination are the same file');
	const { bytes, record, sha256: digest } = readJointRecord(source);
	const { at, facts } = maestroFactsOf(record);
	const local = buildHandoff({ library: options.library });
	const differences = compareWithLocal(facts, local, at);
	const report = {
		source: posix(path.relative(REPO_ROOT, source)),
		destination: posix(path.relative(REPO_ROOT, outFile)),
		recordSha256: digest,
		recordBytes: bytes.length,
		factsAt: at,
		local: {
			repositoryRevision: local.repositoryRevision,
			sourceTreeDigest: local.sourceTreeDigest,
			artifacts: local.artifacts.map(({ kind, status, entry, payloadDigest }) => ({
				kind,
				status,
				entrySha256: entry.sha256,
				payloadDigest,
			})),
		},
		differences,
		imported: false,
	};
	if (differences.length || options.dryRun) return report;
	fs.mkdirSync(path.dirname(outFile), { recursive: true });
	fs.writeFileSync(outFile, bytes);
	report.imported = sha256(fs.readFileSync(outFile)) === digest;
	if (!report.imported) refuse('copy', `${report.destination} did not read back as written`);
	return report;
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

export function main(argv = process.argv.slice(2)) {
	let values;
	let positionals;
	try {
		const str = { type: 'string' };
		const options = {
			out: { ...str, default: DEFAULT_JOINT_OUT_FILE },
			library: str,
			'dry-run': { type: 'boolean', default: false },
			json: { type: 'boolean', default: false },
		};
		({ values, positionals } = parseArgs({
			args: argv,
			strict: true,
			allowPositionals: true,
			options,
		}));
	} catch (error) {
		refuse('usage', error.message);
	}
	if (positionals.length !== 1)
		refuse('usage', 'name exactly one joint-integration.json to import');
	const report = importJointIntegration(positionals[0], {
		out: values.out,
		library: values.library,
		dryRun: values['dry-run'],
	});
	if (values.json) process.stdout.write(`${JSON.stringify(report, null, '\t')}\n`);
	if (report.differences.length) {
		if (!values.json) {
			const lines = report.differences.map(
				(d) => `  ${d.field}: recorded ${d.recorded}, local ${d.local}`
			);
			process.stdout.write(
				`${report.source} does not describe this checkout:\n${lines.join('\n')}\n`
			);
		}
		return 1;
	}
	if (!values.json) {
		const what = report.imported ? 'imported' : 'would import';
		process.stdout.write(
			`${what} ${report.source} as ${report.destination} (sha256 ${report.recordSha256.slice(0, 12)}, revision ${report.local.repositoryRevision.slice(0, 9)})\n`
		);
	}
	return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	try {
		process.exitCode = main();
	} catch (error) {
		if (!(error instanceof HandoffRefusal)) throw error;
		process.stderr.write(`import-joint-integration refused (${error.code}): ${error.message}\n`);
		process.exitCode = 2;
	}
}
