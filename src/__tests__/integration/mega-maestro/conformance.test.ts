/**
 * The public adapter conformance fixture (MCOMP-03-03): the `conformance`
 * section of the runtime pin file is well formed, secret-free, independent of
 * the sibling's private source and of the acceptance artifacts, names only
 * functions the public entry exports, and speaks only published statuses,
 * codes and capabilities. Then (MCOMP-03-03A) each step's envelope is derived
 * from the fixture's defaults and the whole fixture runs against a host
 * composed from the public exports alone (`conformance-host.ts`): every case
 * passes there, and a host that breaks correlation (a dropped requestId, a
 * missing run answered ok) fails by step id. The fixture is read as published:
 * a mismatch is a facade or fixture repair, never a loosened expectation.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

import vectors from '../../fixtures/mega-maestro/contract-vectors.json';
import * as lib from '../../../shared/maestro-lib/index';
import { sha256Hex } from '../../../shared/maestro-lib/managed/authority';
import { MANAGED_ENDPOINT_PROTOCOLS } from '../../../shared/maestro-lib/managed/compatibility';
import {
	MANAGED_CAPABILITIES,
	MANAGED_CONTRACT_VERSION,
} from '../../../shared/maestro-lib/managed/types';
import {
	MANAGED_PORT,
	RUNTIME_PIN_FILE,
	findCanaries,
} from '../../../../scripts/package-mega-maestro-runtime.mjs';
import type { ManagedApi } from '../../../shared/maestro-lib/client/types';
import { composeConformanceHost, runAdapterConformance } from './conformance-host';
import {
	CONFORMANCE_OPERATION_CAPABILITY,
	RUNTIME_CONFORMANCE_FILE,
	conformanceEnvelope,
	readAdapterConformance,
	subsetProblems,
	type ConformanceStep,
} from './fixtures';

const fixture = readAdapterConformance();
const text = fs.readFileSync(RUNTIME_CONFORMANCE_FILE, 'utf8');
const STATUSES = vectors.runtimePort.resultStatuses;
const CODES = [...vectors.runtimePort.resultCodes, ...vectors.maestro.denialCodeExtensions];
const RECEIPT_KEYS = ['qualifiedAgainst', 'adapter', 'qualification', 'passed'];

describe('the public adapter conformance fixture', () => {
	it('is the conformance section of the committed pin file, beside an untouched runtime pin', () => {
		expect(RUNTIME_CONFORMANCE_FILE.endsWith(RUNTIME_PIN_FILE)).toBe(true);
		const pin = JSON.parse(text) as { runtime: Record<string, unknown> };
		expect(pin.runtime.artifactId).toBe('MAESTRO-M0-RUNTIME');
		expect(Object.keys(pin.runtime).filter((key) => RECEIPT_KEYS.includes(key))).toEqual([]);
		expect(fixture).toMatchObject({
			artifactId: 'MAESTRO-M0-ADAPTER-CONFORMANCE',
			formatVersion: 1,
			contract: {
				managedContract: MANAGED_CONTRACT_VERSION,
				endpointProtocol: MANAGED_ENDPOINT_PROTOCOLS[0],
				transport: 'in-process',
			},
		});
		expect(fixture.standing).toMatch(/qualifies nothing/);
		expect(Object.keys(fixture.semantics)).toEqual([
			'denied',
			'unsupported',
			'unavailable',
			'unknown',
		]);
	});

	it('carries no secret, no sibling source path, no acceptance artifact and no receipt key', () => {
		expect(findCanaries(text)).toEqual([]);
		const section = JSON.stringify(fixture);
		expect(section).not.toMatch(/mega-maestro\/(packages|src|docs|apps)\//);
		expect(section).not.toMatch(/Plans\/mega-maestro-rc\/evidence|\/Users\/|C:\\\\/);
		for (const key of RECEIPT_KEYS) expect(section).not.toContain(`"${key}"`);
		for (const content of Object.values(fixture.host.content)) {
			expect(sha256Hex(content.text)).toBe(content.sha256);
		}
	});

	it('names only functions the public entry exports, inside the packaged managed port', () => {
		expect(fixture.invocation.entry).toBe('library/index.js');
		const exported = lib as unknown as Record<string, unknown>;
		for (const name of fixture.invocation.host.compose) {
			expect(MANAGED_PORT.exports, name).toContain(name);
			expect(typeof exported[name], name).toBe('function');
		}
		for (const name of ['negotiateCompatibility', 'managedContextProblems', 'inProcessContext']) {
			expect(typeof exported[name], name).toBe('function');
		}
		expect(fixture.invocation.consumer.operations).toEqual(
			Object.keys(CONFORMANCE_OPERATION_CAPABILITY)
		);
	});

	it('speaks only published statuses, codes and capabilities', () => {
		const ids = fixture.operations.steps.map((step) => step.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const step of fixture.operations.steps) {
			expect(Object.keys(CONFORMANCE_OPERATION_CAPABILITY), step.id).toContain(step.op);
			expect(STATUSES, step.id).toContain(step.expect.status);
			if ('code' in step.expect) expect(CODES, step.id).toContain(step.expect.code);
			for (const capability of step.caps ?? []) expect(MANAGED_CAPABILITIES).toContain(capability);
		}
	});
});

const stepNamed = (id: string): ConformanceStep => {
	const step = fixture.operations.steps.find((candidate) => candidate.id === id);
	if (!step) throw new Error(`the fixture has no step ${id}`);
	return step;
};

describe('the fixture over a host composed from the public exports (MCOMP-03-03A)', () => {
	it('derives each step envelope from the published defaults', () => {
		const accepted = conformanceEnvelope(fixture, stepNamed('submit-accepted'));
		expect(accepted.peer).toBeUndefined();
		expect(accepted.context).toMatchObject({
			contractVersion: MANAGED_CONTRACT_VERSION,
			installation: fixture.host.installation,
			origin: 'headless',
			actor: fixture.host.actor,
			delegation: { chain: [], grantRef: null },
			identity: {
				requestId: 'req:submit-accepted',
				idempotencyKey: 'idem-a',
				attemptId: 'att:submit-accepted',
				runId: 'run-a',
				rootRunId: null,
				parentRunId: null,
			},
			policyRevision: fixture.host.policyRevision,
			workflow: null,
			traceId: 'trace:submit-accepted',
			requestedCapabilities: ['runs.submit'],
		});
		expect(accepted.input).toEqual({
			...fixture.host.defaultSubmit,
			content: fixture.host.content.pong,
			resourceIds: ['res-approved'],
		});
		// An object names the text and the digest by separate keys; the digest then does not match.
		const mismatch = conformanceEnvelope(fixture, stepNamed('submit-digest-mismatch'));
		expect(mismatch.input).toMatchObject({
			content: { text: fixture.host.content.pong.text, sha256: fixture.host.content.ping.sha256 },
		});
		expect(
			conformanceEnvelope(fixture, stepNamed('submit-capability-not-requested')).context
		).toMatchObject({ requestedCapabilities: ['runs.inspect'] });
		expect(conformanceEnvelope(fixture, stepNamed('submit-unverified-transport')).peer).toBe(
			'os-peer'
		);
		expect(
			conformanceEnvelope(fixture, stepNamed('submit-malformed-context')).context
		).toMatchObject({ identity: { requestId: '' } });
		const inspect = conformanceEnvelope(fixture, stepNamed('inspect-queued'));
		expect(inspect.input).toEqual({ runId: 'run-a' });
		expect(inspect.context.requestedCapabilities).toEqual(['runs.inspect']);
		expect(subsetProblems({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }] })).toEqual([]);
		expect(subsetProblems({ a: 1, b: [1] }, { a: 2, b: [1, 2], c: {} })).toEqual([
			'result.a is 1, expected 2',
			'result.b has 1 item(s), expected 2',
			'result.c is not an object',
		]);
	});

	it('passes every negotiation case and operation step, reaching the declared sink as scripted', async () => {
		const host = await composeConformanceHost(fixture);
		try {
			const report = await runAdapterConformance(host.api, fixture, host.sink);
			expect(report.cases.map((c) => c.id)).toEqual([
				...fixture.negotiation.cases.map((c) => c.id),
				...fixture.operations.steps.map((step) => step.id),
			]);
			expect(report.cases.filter((c) => c.problems.length > 0)).toEqual([]);
			expect(report.failed).toEqual([]);
			// The runs the fixture named are journaled; none was ever handed a process.
			const runs = host.journal.list({ cursor: null, limit: 100 }).items;
			expect(runs.map((run) => run.runId)).toEqual(
				expect.arrayContaining(['run-a', 'run-c', 'run-d'])
			);
			for (const run of runs) {
				for (const attempt of run.attempts) expect(attempt.pid).toBeNull();
			}
			expect(fs.existsSync(host.journal.file)).toBe(true);
		} finally {
			host.close();
		}
	});

	it('fails by step id on a host that breaks correlation', async () => {
		const host = await composeConformanceHost(fixture);
		try {
			const broken: ManagedApi = {
				...host.api,
				// Drops the requestId echo on every submit.
				submit: async (envelope) => {
					const answered = await host.api.submit(envelope);
					return answered.ok
						? { ok: true, value: { ...answered.value, requestId: 'dropped' } }
						: answered;
				},
				// Answers a run the journal does not hold as if it existed.
				inspect: async (envelope) => {
					const answered = await host.api.inspect(envelope);
					if (!answered.ok || answered.value.status !== 'denied') return answered;
					const { runId } = envelope.input;
					return {
						ok: true,
						value: {
							status: 'ok',
							requestId: answered.value.requestId,
							value: {
								runId,
								rootRunId: runId,
								parentRunId: null,
								attemptId: '',
								agentId: '',
								providerSessionId: null,
								state: 'queued',
							},
						},
					};
				},
			};
			const report = await runAdapterConformance(broken, fixture, host.sink);
			const submits = fixture.operations.steps
				.filter((step) => step.op === 'submit')
				.map((step) => step.id);
			expect(report.failed).toEqual(
				fixture.operations.steps
					.map((step) => step.id)
					.filter((id) => submits.includes(id) || id === 'inspect-not-found')
			);
			const notFound = report.cases.find((c) => c.id === 'inspect-not-found');
			expect(notFound?.problems).toEqual([
				'result.status is "ok", expected "denied"',
				'result.code is undefined, expected "not-found"',
			]);
			const accepted = report.cases.find((c) => c.id === 'submit-accepted');
			expect(accepted?.problems).toEqual([
				'result.requestId is "dropped", the context sent "req:submit-accepted"',
			]);
		} finally {
			host.close();
		}
	});
});
