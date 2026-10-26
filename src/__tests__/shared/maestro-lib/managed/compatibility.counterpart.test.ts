/**
 * MRC2-01-06: the `unsupported-by-counterpart` support state (MRC2-01-02). A
 * capability whose producer the management peer owes is reported by that
 * name: the rows of `COUNTERPART_SUPPORT` (CP-04, CP-05, CP-06, read at a
 * recorded counterpart revision), the fold of a server `unsupported_capability`
 * denial over the host rows, and a negotiation that names the state instead
 * of activating and never drops a member of the required set. The support
 * matrix on disk mirrors the rows field for field. The ManagedApi facade's
 * wire union stays `missing-required-capability` with the detail in `missing`
 * (a contract change for a later task); nothing here claims otherwise.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import {
	COUNTERPART_SUPPORT,
	COUNTERPART_SUPPORT_REVISION,
	MANAGED_CAPABILITY_SUPPORT,
	SUPPORT_RANK,
	SUPPORT_STATUSES,
	applyCounterpartDenial,
	hostCompatibilityProfile,
	isSupportStatus,
	negotiateCompatibility,
	supportAtLeast,
	type CompatibilityRequest,
	type CounterpartCapabilityDenial,
	type SupportEntry,
} from '../../../../shared/maestro-lib/managed/compatibility';
import {
	MANAGED_CONTRACT_VERSION,
	type ManagedCapability,
} from '../../../../shared/maestro-lib/managed/types';
import vectors from '../../../fixtures/mega-maestro/contract-vectors.json';

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const MATRIX_FILE = 'Plans/mega-maestro-rc/support-matrix.json';
const WORD = 'unsupported-by-counterpart';
const keysOf = (rows: readonly SupportEntry[]) => rows.map((row) => row.key);
const rowsOf = (dependency: string) =>
	keysOf(COUNTERPART_SUPPORT.filter((row) => row.dependency === dependency));
const denial = (
	over: Partial<CounterpartCapabilityDenial<ManagedCapability>> = {}
): CounterpartCapabilityDenial<ManagedCapability> => ({
	reason: 'unsupported_capability',
	required: ['runs.submit', 'runs.cancel'],
	served: null,
	evidence: 'Plans/mega-maestro-rc/evidence/p2-01.md',
	...over,
});
const request: CompatibilityRequest = {
	contractVersions: [MANAGED_CONTRACT_VERSION],
	endpointProtocols: [1],
	transport: 'in-process',
	required: ['capabilities.negotiate', 'runs.submit'],
	minimumStatus: 'implemented',
};

describe('the counterpart-unsupported word', () => {
	it('is a support status that ranks with unsupported and never reaches a minimum above it', () => {
		expect(SUPPORT_STATUSES).toContain(WORD);
		expect(isSupportStatus(WORD)).toBe(true);
		expect(isSupportStatus('unsupported_by_counterpart')).toBe(false);
		expect(SUPPORT_RANK[WORD]).toBe(SUPPORT_RANK.unsupported);
		expect(supportAtLeast(WORD, 'unverified')).toBe(false);
		expect(supportAtLeast(WORD, 'unsupported')).toBe(true);
		expect(supportAtLeast('unverified', WORD)).toBe(true);
	});

	it('names the CP-04, CP-05 and CP-06 rows with owner, dependency and a counterpart source line, at the fixture revision', () => {
		expect(COUNTERPART_SUPPORT_REVISION).toBe(vectors.counterpart.sourceRevision);
		expect(rowsOf('CP-04')).toEqual([
			'endpoint.command',
			'endpoint.workflow',
			'endpoint.offline',
			'endpoint.enrollment',
			'endpoint.budget',
		]);
		expect(rowsOf('CP-05')).toEqual(['command.pause_run', 'command.resume_run']);
		expect(rowsOf('CP-06')).toEqual(['transport.os-peer.darwin', 'transport.os-peer.win32']);
		expect(COUNTERPART_SUPPORT).toHaveLength(9);
		for (const row of COUNTERPART_SUPPORT) {
			expect(row, row.key).toMatchObject({ status: WORD, owner: 'mega-maestro' });
			expect(row.evidence, row.key).toMatch(/^mega-maestro [\w/.-]+\.ts:\d+(-\d+)?$/);
			expect(row.note, row.key).toBeTruthy();
		}
		// The endpoint operations and command actions the rows name are published facts.
		for (const key of rowsOf('CP-04')) {
			expect(vectors.localEndpoint.operations).toContain(key.slice('endpoint.'.length));
		}
		for (const key of rowsOf('CP-05')) {
			const action = key.slice('command.'.length);
			expect(vectors.localEndpoint.commandActions).not.toContain(action);
			expect(vectors.maestro.commandActionExtensions).toContain(action);
		}
		// Another vocabulary than the managed capabilities: no key is shared.
		expect(
			keysOf(COUNTERPART_SUPPORT).filter((k) => keysOf(MANAGED_CAPABILITY_SUPPORT).includes(k))
		).toEqual([]);
	});

	it('is mirrored by support-matrix.json row for row, with a consumer named on each', () => {
		const matrix = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, MATRIX_FILE), 'utf8'));
		expect(Object.keys(matrix.words)).toContain(WORD);
		expect(matrix.counterpart.counterpartRevision).toBe(COUNTERPART_SUPPORT_REVISION);
		const pick = ({ key, status, owner, dependency, evidence }: SupportEntry) => ({
			key,
			status,
			owner,
			dependency,
			evidence,
		});
		expect(matrix.counterpart.rows.map(pick)).toEqual(COUNTERPART_SUPPORT.map(pick));
		for (const row of matrix.counterpart.rows) expect(row.consumer, row.key).toBeTruthy();
	});
});

describe('applyCounterpartDenial', () => {
	const rows = MANAGED_CAPABILITY_SUPPORT;
	const before = JSON.stringify(rows);

	it('folds only an unsupported_capability denial, over what the endpoint does not serve', () => {
		expect(applyCounterpartDenial(rows, denial({ reason: 'policy_denied' }))).toBe(rows);
		expect(applyCounterpartDenial(rows, denial({ served: ['runs.submit', 'runs.cancel'] }))).toBe(
			rows
		);

		const unsaid = applyCounterpartDenial(rows, denial());
		expect(keysOf(unsaid)).toEqual(keysOf(rows));
		for (const [i, row] of unsaid.entries()) {
			if (row.key === 'runs.submit' || row.key === 'runs.cancel') {
				expect(row).toEqual({
					...rows[i],
					status: WORD,
					owner: 'mega-maestro',
					evidence: 'Plans/mega-maestro-rc/evidence/p2-01.md',
					note: expect.stringContaining('has not said what it serves'),
				});
			} else expect(row).toBe(rows[i]);
		}

		const partly = applyCounterpartDenial(rows, denial({ served: ['runs.cancel'] }));
		expect(partly.filter((row) => row.status === WORD).map((row) => row.key)).toEqual([
			'runs.submit',
		]);
		expect(partly.find((row) => row.key === 'runs.submit')?.note).toContain(
			'it serves [runs.cancel]'
		);
		expect(partly.find((row) => row.key === 'runs.cancel')).toBe(
			rows.find((row) => row.key === 'runs.cancel')
		);
	});

	it('adds a row for a required key the host never listed, and mutates nothing', () => {
		const without = rows.filter((row) => row.key !== 'runs.cancel');
		const required = Object.freeze(['runs.cancel'] as const);
		const out = applyCounterpartDenial(without, denial({ required }));
		expect(out).toHaveLength(without.length + 1);
		expect(out[out.length - 1]).toEqual({
			key: 'runs.cancel',
			status: WORD,
			owner: 'mega-maestro',
			evidence: 'Plans/mega-maestro-rc/evidence/p2-01.md',
			note: expect.any(String),
		});
		expect(JSON.stringify(rows)).toBe(before);
		expect(required).toEqual(['runs.cancel']);
	});
});

describe('negotiateCompatibility with a counterpart denial', () => {
	const activated = negotiateCompatibility(
		hostCompatibilityProfile({ providers: ['codex'] }),
		request
	);

	it('would activate the same request without the denial, so the denial alone decides', () => {
		expect(activated).toMatchObject({
			outcome: 'activated',
			capabilities: ['capabilities.negotiate', 'runs.submit'],
		});
	});

	it('names the required capability the counterpart refused, keeps the required set, and activates nothing', () => {
		const required = Object.freeze([...request.required]);
		const profile = hostCompatibilityProfile({
			providers: ['codex'],
			counterpartDenial: denial({ required: ['runs.submit'], served: ['capabilities.negotiate'] }),
		});
		const outcome = negotiateCompatibility(profile, { ...request, required });
		expect(outcome).toEqual({
			outcome: 'denied',
			reasons: [
				{
					reason: WORD,
					detail: expect.stringContaining(
						'runs.submit is unsupported-by-counterpart (owner mega-maestro)'
					),
				},
			],
		});
		expect(outcome).not.toHaveProperty('capabilities');
		expect(outcome).not.toHaveProperty('support');
		expect(required).toEqual(request.required);
		// The lowest minimum a peer may ask for still refuses: the rank never admits the row.
		expect(
			negotiateCompatibility(profile, { ...request, minimumStatus: 'unsupported' })
		).toMatchObject({
			outcome: 'denied',
			reasons: [{ reason: WORD }],
		});
		// Another reason from the endpoint says nothing about support.
		const other = hostCompatibilityProfile({
			providers: ['codex'],
			counterpartDenial: denial({ reason: 'unauthenticated', required: ['runs.submit'] }),
		});
		expect(negotiateCompatibility(other, request)).toEqual(activated);
	});

	it('leaves a refused optional capability out of the activation without a reason', () => {
		const profile = hostCompatibilityProfile({
			providers: ['codex'],
			counterpartDenial: denial({ required: ['runs.submit'] }),
		});
		const outcome = negotiateCompatibility(profile, {
			...request,
			required: ['capabilities.negotiate'],
			optional: ['runs.submit'],
		});
		expect(outcome).toMatchObject({
			outcome: 'activated',
			capabilities: ['capabilities.negotiate'],
		});
	});

	it('cites the dependency and the note of a row that carries them', () => {
		const row: SupportEntry<ManagedCapability> = {
			key: 'runs.cancel',
			status: WORD,
			owner: 'mega-maestro',
			dependency: 'CP-04',
			evidence: 'mega-maestro apps/endpoint/src/ipc/server.ts:65-67',
			note: 'the endpoint serves no command operation',
		};
		const profile = hostCompatibilityProfile({
			providers: ['codex'],
			capabilities: [...MANAGED_CAPABILITY_SUPPORT.filter((r) => r.key !== 'runs.cancel'), row],
		});
		const outcome = negotiateCompatibility(profile, { ...request, required: ['runs.cancel'] });
		expect(outcome).toEqual({
			outcome: 'denied',
			reasons: [
				{
					reason: WORD,
					detail:
						'runs.cancel is unsupported-by-counterpart (CP-04, owner mega-maestro): the endpoint serves no command operation',
				},
			],
		});
	});
});
