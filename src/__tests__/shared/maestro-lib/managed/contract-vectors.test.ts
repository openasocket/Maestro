/**
 * The contract vectors: the published Mega-Maestro port facts Maestro depends
 * on, recorded as data with the counterpart revision they were read from.
 * Maestro's enumerations in `endpoint-port.ts`, `types.ts` and `commands.ts`
 * must equal the fixture exactly (the published set plus the extensions it
 * names), and `scripts/check-mega-contract-vectors.mjs`, run as a child on a
 * synthetic extracted package (real zod schemas under the permission model),
 * must pass on the fixture, name every difference on an edited one, and
 * refuse a digest or payload mismatch before anything is loaded.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import vectors from '../../../fixtures/mega-maestro/contract-vectors.json';
import {
	LOCAL_ENDPOINT_DENIAL_REASONS,
	LOCAL_ENDPOINT_MAX_REQUEST_BYTES,
	LOCAL_ENDPOINT_MAX_RESPONSE_BYTES,
	LOCAL_ENDPOINT_OPERATIONS,
	LOCAL_ENDPOINT_PROTOCOL,
	endpointComponentProblems,
	isEndpointDenied,
} from '../../../../shared/maestro-lib/managed/endpoint-port';
import {
	MANAGED_CAPABILITIES,
	MANAGED_CONTRACT_VERSION,
	MANAGED_ORIGINS,
	type ManagedDenialCode,
	type ManagedOperationResult,
} from '../../../../shared/maestro-lib/managed/types';
import { ENDPOINT_COMMAND_ACTIONS } from '../../../../shared/maestro-lib/managed/commands';
import {
	CHECKED_FACTS,
	diffFacts,
	payloadDigestOf,
	readFixture,
} from '../../../../../scripts/check-mega-contract-vectors.mjs';

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const SCRIPT = path.join(REPO_ROOT, 'scripts/check-mega-contract-vectors.mjs');
const FIXTURE = path.join(REPO_ROOT, 'src/__tests__/fixtures/mega-maestro/contract-vectors.json');
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const sorted = (values: readonly string[]) => [...values].sort();
const { runtimePort, localEndpoint, maestro } = vectors;

// Compile-time exhaustiveness: these unions have no runtime list in types.ts,
// so the tuples must name every member and nothing else to compile.
type Never<T> = [T] extends [never] ? true : never;
type Status = ManagedOperationResult<unknown>['status'];
const STATUSES = ['ok', 'denied', 'unsupported', 'unavailable', 'unknown'] as const;
const statusesComplete: Never<Exclude<Status, (typeof STATUSES)[number]>> = true;
const CODES = [
	'policy-denied',
	'unauthenticated',
	'context-mismatch',
	'version-unsupported',
	'capability-unsupported',
	'invalid-input',
	'idempotency-conflict',
	'not-found',
	'runtime-unavailable',
	'outcome-unknown',
	'lease-invalid',
] as const satisfies readonly ManagedDenialCode[];
const codesComplete: Never<Exclude<ManagedDenialCode, (typeof CODES)[number]>> = true;

describe('Maestro enumerations equal the contract vectors', () => {
	it('fixture is the format the script reads, with disjoint published and extension sets', () => {
		expect(readFixture(FIXTURE).counterpart.sourceRevision).toMatch(/^[a-f0-9]{40}$/);
		expect(Object.keys(localEndpoint).sort()).toEqual(sorted(CHECKED_FACTS));
		const overlap = [
			...runtimePort.capabilities.filter((c) => maestro.capabilityExtensions.includes(c)),
			...runtimePort.resultCodes.filter((c) => maestro.denialCodeExtensions.includes(c)),
			...localEndpoint.commandActions.filter((a) => maestro.commandActionExtensions.includes(a)),
		];
		expect(overlap).toEqual([]);
	});

	it('endpoint-port.ts speaks the recorded protocol, operations, reasons, kinds and limits', () => {
		expect(LOCAL_ENDPOINT_PROTOCOL).toBe(localEndpoint.protocol);
		expect([...LOCAL_ENDPOINT_OPERATIONS]).toEqual(localEndpoint.operations);
		expect([...LOCAL_ENDPOINT_DENIAL_REASONS]).toEqual(localEndpoint.denialReasons);
		expect(LOCAL_ENDPOINT_MAX_REQUEST_BYTES).toBe(localEndpoint.maxRequestBytes);
		expect(LOCAL_ENDPOINT_MAX_RESPONSE_BYTES).toBe(localEndpoint.maxResponseBytes);
		const kindProblems = (kind: string) =>
			endpointComponentProblems({ id: 'c', kind, version: '1' }, 'c');
		for (const kind of localEndpoint.componentKinds) expect(kindProblems(kind)).toEqual([]);
		// The runtime port's ComponentIdentity has an `enterprise` kind; the local endpoint does not.
		for (const kind of ['enterprise', 'desktop', '']) {
			expect(kindProblems(kind)).toEqual(['c.kind is unknown']);
		}
		for (const reason of localEndpoint.denialReasons) {
			expect(isEndpointDenied({ outcome: 'denied', reason })).toBe(true);
		}
		expect(isEndpointDenied({ outcome: 'denied', reason: 'policy-denied' })).toBe(false);
	});

	it('types.ts and commands.ts carry the published sets plus the named extensions', () => {
		expect(MANAGED_CONTRACT_VERSION).toBe(maestro.contractVersion);
		expect(sorted(MANAGED_CAPABILITIES)).toEqual(
			sorted([...runtimePort.capabilities, ...maestro.capabilityExtensions])
		);
		const aliases: Record<string, string> = maestro.originAliases;
		const maestroName = Object.fromEntries(Object.entries(aliases).map(([m, p]) => [p, m]));
		expect(sorted(MANAGED_ORIGINS)).toEqual(
			sorted([...runtimePort.origins.map((o) => maestroName[o] ?? o), ...maestro.originExtensions])
		);
		expect(statusesComplete && codesComplete).toBe(true);
		expect(sorted(STATUSES)).toEqual(sorted(runtimePort.resultStatuses));
		expect(sorted(CODES)).toEqual(
			sorted([...runtimePort.resultCodes, ...maestro.denialCodeExtensions])
		);
		expect(sorted(Object.values(ENDPOINT_COMMAND_ACTIONS))).toEqual(
			sorted([...localEndpoint.commandActions, ...maestro.commandActionExtensions])
		);
	});
});

describe('check-mega-contract-vectors.mjs', () => {
	let sandbox: string;
	let packageDir: string;
	let digest: string;

	/** A synthetic extracted contracts package whose zod schemas carry `facts`. */
	function writePackage(dir: string, facts: typeof localEndpoint, sourceDirty = false) {
		const names = (values: readonly string[]) => `z.enum(${JSON.stringify(values)})`;
		const actions = facts.commandActions
			.map((a) => `z.strictObject({ kind: z.literal(${JSON.stringify(a)}) })`)
			.join(', ');
		const module = [
			`import { z } from 'zod';`,
			`const component = z.strictObject({ id: z.string(), kind: ${names(facts.componentKinds)} });`,
			`export const attachmentRequest = z.strictObject({ supportedProtocols: z.array(z.literal(${facts.protocol})), components: z.array(component) });`,
			`export const denied = z.strictObject({ reason: ${names(facts.denialReasons)} });`,
			`export const commandRequest = z.strictObject({ action: z.discriminatedUnion('kind', [${actions}]) });`,
			`export const executionRequest = z.strictObject({ source: ${names(facts.executionSources)} });`,
			`export const localRequestEnvelope = z.strictObject({ operation: ${names(facts.operations)} });`,
			`export const localMaximumRequestBytes = ${facts.maxRequestBytes};`,
			`export const localMaximumResponseBytes = ${facts.maxResponseBytes};`,
		].join('\n');
		fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
		fs.writeFileSync(path.join(dir, 'dist/local-endpoint.js'), module);
		const payloadSha256 = { 'dist/local-endpoint.js': sha256(module) };
		const { sourceRevision } = vectors.counterpart;
		const provenance = { formatVersion: 1, sourceRevision, sourceDirty, payloadSha256 };
		fs.writeFileSync(path.join(dir, 'provenance.json'), JSON.stringify(provenance));
		return payloadDigestOf(payloadSha256);
	}

	/** Run the script as a child on `dir` with `sha` and any extra flags. */
	function run(dir: string, sha: string, ...flags: string[]) {
		const args = dir
			? [SCRIPT, '--contracts-dir', dir, '--expect-sha256', sha, ...flags]
			: [SCRIPT];
		const result = spawnSync(process.execPath, args, { cwd: REPO_ROOT, encoding: 'utf8' });
		if (result.error) throw result.error;
		const report = result.stdout ? JSON.parse(result.stdout) : null;
		return { status: result.status, stderr: result.stderr, report };
	}

	beforeAll(() => {
		sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-vectors-'));
		packageDir = path.join(sandbox, 'package');
		digest = writePackage(packageDir, localEndpoint);
	});
	afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));

	it('passes on a package whose schemas carry the recorded facts, and leaves no scratch', () => {
		const { status, report, stderr } = run(packageDir, digest);
		expect(stderr).toBe('');
		expect(status).toBe(0);
		expect(report).toMatchObject({
			ok: true,
			archive: { mode: 'extracted', digest, sourceDirty: false, revisionMatchesFixture: true },
			runtimePort: 'not-in-archive',
			observed: localEndpoint,
			drift: [],
		});
		const scratch = fs.readdirSync(REPO_ROOT).filter((n) => n.startsWith('.mega-contract-check-'));
		expect(scratch).toEqual([]);
	});

	it('reports drift on a deliberately edited fixture, naming what is missing and extra', () => {
		const edited = structuredClone(vectors);
		const local = edited.localEndpoint;
		local.denialReasons = [...local.denialReasons.filter((r) => r !== 'owner_unfenced'), 'made_up'];
		local.commandActions = [...local.commandActions, 'pause_run'];
		local.maxResponseBytes = 32 * 1024;
		const fixture = path.join(sandbox, 'edited.json');
		fs.writeFileSync(fixture, JSON.stringify(edited));
		const { status, report } = run(packageDir, digest, '--fixture', fixture);
		expect(status).toBe(1);
		expect(report.ok).toBe(false);
		expect(report.drift).toEqual([
			expect.objectContaining({
				fact: 'denialReasons',
				missing: ['made_up'],
				extra: ['owner_unfenced'],
			}),
			expect.objectContaining({ fact: 'commandActions', missing: ['pause_run'], extra: [] }),
			{ fact: 'maxResponseBytes', expected: 32 * 1024, observed: 64 * 1024 },
		]);
		expect(diffFacts(localEndpoint, localEndpoint)).toEqual([]);
	});

	it('refuses a wrong digest, a tampered or extra payload and a dirty build before loading', () => {
		const wrong = run(packageDir, '0'.repeat(64));
		expect(wrong).toMatchObject({ status: 2, report: null });
		expect(wrong.stderr).toMatch(/refused \(digest-mismatch\)/);

		const tampered = path.join(sandbox, 'tampered');
		writePackage(tampered, localEndpoint);
		fs.appendFileSync(path.join(tampered, 'dist/local-endpoint.js'), '\n// edited\n');
		const payload = run(tampered, digest);
		expect(payload).toMatchObject({ status: 2, report: null });
		expect(payload.stderr).toMatch(/refused \(payload-digest\)/);

		const extra = path.join(sandbox, 'extra');
		writePackage(extra, localEndpoint);
		fs.writeFileSync(path.join(extra, 'dist/stowaway.js'), 'export const x = 1;');
		expect(run(extra, digest).stderr).toMatch(/refused \(payload-extra\).*stowaway/);

		const dirty = path.join(sandbox, 'dirty');
		writePackage(dirty, localEndpoint, true);
		expect(run(dirty, digest).stderr).toMatch(/refused \(dirty-source\)/);
		const allowed = run(dirty, digest, '--allow-dirty-source');
		expect(allowed.status).toBe(0);
		expect(allowed.report.archive.sourceDirty).toBe(true);

		const bare = path.join(sandbox, 'bare');
		fs.mkdirSync(bare);
		fs.writeFileSync(path.join(bare, 'contracts.tgz'), 'not an archive');
		expect(run(bare, digest).stderr).toMatch(/refused \(missing-input\)/);
		expect(run('', '').stderr).toMatch(/refused \(usage\)/);
	});
});
