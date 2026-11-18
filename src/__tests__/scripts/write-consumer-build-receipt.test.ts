/**
 * scripts/write-consumer-build-receipt.mjs re-runs the MCOMP-00-03 checks and
 * writes a consumer BUILD receipt only from checks that ran. What is defended
 * here without running the whole check list: the arguments it refuses, that an
 * existing receipt is never rewritten (nothing runs, the bytes stay), that the
 * integrity check refuses an archive digest that is not the archive's, and that
 * fields no build can observe are named, never recorded with a value.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	DEFAULT_EVIDENCE_DIR,
	DEFAULT_FOCUSED_TESTS,
	IN_PROCESS_CHECKS,
	NOT_YET_OBSERVED,
	LIVE_FIELDS,
	LIVE_OBSERVATION_SCHEMA,
	REPO_ROOT,
	liveObservationOf,
	main,
	parse,
} from '../../../scripts/write-consumer-build-receipt.mjs';
import { readPin } from '../../../scripts/import-mega-maestro.mjs';

const SHA = 'a'.repeat(64);
const base = ['--manifest', 'm.json', '--archive', 'a.tgz', '--sha256', SHA];
const scratch: string[] = [];

afterEach(() => {
	for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('write-consumer-build-receipt', () => {
	it('requires the archive triple and a name, and refuses a malformed digest or name', () => {
		expect(() => parse(base)).toThrow('--name is required');
		for (const drop of ['--manifest', '--archive', '--sha256']) {
			const args = ['--name', 'x', ...base];
			args.splice(args.indexOf(drop), 2);
			expect(() => parse(args)).toThrow(`${drop} is required`);
		}
		expect(() => parse(['--name', 'x', ...base.slice(0, 4), '--sha256', 'A'.repeat(64)])).toThrow(
			'64 lowercase hex'
		);
		expect(() => parse(['--name', '../escape', ...base])).toThrow('--name is lowercase');
		expect(() => parse(['--name', 'x', ...base, '--unknown', 'y'])).toThrow();
	});

	it('writes <name>-build.json under the evidence directory and runs the MCOMP-00-03 suites by default', () => {
		const args = parse(['--name', 'contract-inputs-build-9.9.9', ...base]);
		expect(args.output).toBe(
			path.join(REPO_ROOT, DEFAULT_EVIDENCE_DIR, 'contract-inputs-build-9.9.9-build.json')
		);
		expect(args.tests).toEqual([...DEFAULT_FOCUSED_TESTS]);
		expect(args.artifactId).toBe('MAESTRO-CONTRACT-INPUTS-BUILD');
		expect(parse(['--name', 'x', ...base, '--test', 'a.test.ts']).tests).toEqual(['a.test.ts']);
		expect(parse(['--name', 'x', ...base, '--out', 'Plans/r/exact.json']).output).toBe(
			path.join(REPO_ROOT, 'Plans/r/exact.json')
		);
		expect(() => parse(['--name', 'x', ...base, '--out', 'exact.txt'])).toThrow('.json');
	});

	it('exits 2 on bad arguments and never rewrites an existing receipt (exit 1, bytes kept, nothing run)', async () => {
		expect(await main(['--name', 'x'])).toBe(2);
		const out = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-out-'));
		const work = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-work-'));
		scratch.push(out, work);
		const existing = path.join(out, 'old-build.json');
		fs.writeFileSync(existing, '{"historical":true}\n');
		const code = await main([
			'--name',
			'old',
			...base,
			'--out-dir',
			out,
			'--work-dir',
			path.join(work, 'w'),
		]);
		expect(code).toBe(1);
		expect(fs.readFileSync(existing, 'utf8')).toBe('{"historical":true}\n');
		expect(fs.existsSync(path.join(work, 'w'))).toBe(false);
	});

	it('names the fields a build cannot observe and gives none of them a value', () => {
		expect(NOT_YET_OBSERVED.map((entry: { field: string }) => entry.field)).toEqual([
			'liveEndpointProtocols',
			'grantDigest',
			'chainDigest',
			'workflowOwner',
			'negotiatedWorkflowExecution',
		]);
		for (const entry of NOT_YET_OBSERVED) {
			expect(Object.keys(entry).sort()).toEqual(['field', 'reason']);
		}
	});

	const pinFile = path.join(REPO_ROOT, 'vendor/mega-maestro/contracts.pin.json');
	const pin = readPin(pinFile);
	const archiveDir = `/Users/dr3/dev-shit/mega-maestro/artifacts/enterprise/${pin.version}/${pin.sha256}`;
	it.skipIf(!fs.existsSync(path.join(archiveDir, 'contracts.tgz')))(
		'the integrity check refuses a digest that is not the archive and accepts the pinned one',
		() => {
			const input = {
				manifest: path.join(archiveDir, 'artifact.json'),
				archive: path.join(archiveDir, 'contracts.tgz'),
			};
			expect(() => IN_PROCESS_CHECKS.integrity({ ...input, sha256: SHA })).toThrow();
			const checked = IN_PROCESS_CHECKS.integrity({ ...input, sha256: pin.sha256 });
			expect(checked).toMatchObject({ sha256: pin.sha256, payloadDigest: pin.payloadDigest });
		}
	);

	describe('a live observation', () => {
		const runtime = { archive: { sha256: 'b'.repeat(64) }, versions: { library: '0.41.0' } };
		const integrity = { sha256: 'c'.repeat(64) };
		const passing = {
			schema: LIVE_OBSERVATION_SCHEMA,
			outcome: 'passed',
			liveNegotiationPerformed: true,
			host: { platform: 'linux', arch: 'arm64', node: 'v24.21.0', uid: 1001, user: 'maestro' },
			runtime: {
				archive: { sha256: 'b'.repeat(64) },
				library: '0.41.0',
				endpointProtocol: 2,
				contracts: { version: '0.4.0', sha256: 'c'.repeat(64) },
			},
			liveEndpointProtocols: [2],
			negotiatedWorkflowExecution: true,
			grantDigest: '3'.repeat(64),
			chain: [{ grantId: 'g', digest: '3'.repeat(64) }],
			chainDigest: { encoding: 'sha256(canonicalJson(delegation.chain))', value: '4'.repeat(64) },
			workflowOwner: { ownerId: 'o', ownerEpoch: 'e', fencingTokenSha256: '5'.repeat(64) },
			execution: { receipt: { outcome: 'broker_dispatched', state: 'dispatched' } },
			settlement: { by: 'endpoint', effect: 'settled' },
			release: { outcome: 'released' },
		};
		const write = (value: unknown) => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-obs-'));
			scratch.push(dir);
			const file = path.join(dir, 'observation.json');
			fs.writeFileSync(file, JSON.stringify(value));
			return file;
		};

		it('records every live field of a passing run from the pinned runtime on Linux', () => {
			const live = liveObservationOf(write(passing), { runtime, integrity });
			expect(live).toMatchObject({
				liveEndpointProtocols: [2],
				grantDigest: passing.grantDigest,
				chainDigest: passing.chainDigest,
				workflowOwner: passing.workflowOwner,
				negotiatedWorkflowExecution: true,
			});
			expect([...LIVE_FIELDS].sort()).toEqual(
				NOT_YET_OBSERVED.map((entry: { field: string }) => entry.field).sort()
			);
			expect(liveObservationOf(undefined, { runtime, integrity })).toBeUndefined();
			// An unknown dispatch is settled uncertain by the owner and stays held.
			const held = {
				...passing,
				execution: { receipt: { outcome: 'broker_dispatched', state: 'unknown' } },
				settlement: { by: 'consumer', effect: 'uncertain', outcome: 'recorded' },
				release: null,
			};
			expect(liveObservationOf(write(held), { runtime, integrity })).toMatchObject({
				settlement: held.settlement,
				release: null,
			});
		});

		it('refuses a failed run, another platform, another runtime or contracts, and a missing field', () => {
			for (const [over, problem] of [
				[{ outcome: 'failed', failure: { step: 'execution' } }, 'outcome is failed at execution'],
				[{ host: { platform: 'darwin' } }, 'did not run on Linux'],
				[{ liveNegotiationPerformed: false }, 'no live negotiation'],
				[
					{ runtime: { ...passing.runtime, archive: { sha256: 'd'.repeat(64) } } },
					'pinned runtime archive',
				],
				[
					{ runtime: { ...passing.runtime, contracts: { sha256: 'd'.repeat(64) } } },
					'these contracts',
				],
				[{ liveEndpointProtocols: [1, 2] }, 'not [2]'],
				[{ grantDigest: null }, 'no grant digest'],
				[{ chainDigest: null }, 'no chain digest'],
				[{ workflowOwner: null }, 'no workflow owner'],
				[{ negotiatedWorkflowExecution: false }, 'not negotiated'],
				[
					{ settlement: { by: 'consumer', effect: 'uncertain', outcome: 'recorded' } },
					"not the endpoint's settlement",
				],
				[{ release: null }, 'did not release'],
				[
					{ execution: { receipt: { outcome: 'broker_dispatched', state: 'unknown' } } },
					'not settled uncertain',
				],
			] as const) {
				expect(() =>
					liveObservationOf(write({ ...passing, ...over }), { runtime, integrity })
				).toThrow(problem);
			}
		});
	});
});
