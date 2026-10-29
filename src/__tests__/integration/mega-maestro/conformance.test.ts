/**
 * The public adapter conformance fixture (MCOMP-03-03): the `conformance`
 * section of the runtime pin file is well formed, secret-free, independent of
 * the sibling's private source and of the acceptance artifacts, names only
 * functions the public entry exports, and speaks only published statuses,
 * codes and capabilities. Deriving each step's envelope and running the
 * fixture against a host composed from the public exports is the
 * continuation's job (MCOMP-03-03A).
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
import {
	CONFORMANCE_OPERATION_CAPABILITY,
	RUNTIME_CONFORMANCE_FILE,
	readAdapterConformance,
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
