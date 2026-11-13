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
	REPO_ROOT,
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
			'acceptedEndpointProtocols',
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
});
