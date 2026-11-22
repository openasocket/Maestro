/**
 * scripts/live-execution-check.mjs: the loader that runs the live execution
 * check from a packaged runtime archive. Defended here: the arguments it
 * refuses (nothing written inside the read-only checkout, a settled effect
 * needs evidence), the archive digest it insists on, and the tar reader that
 * refuses an entry escaping its directory or anything but files and folders.
 * The check itself is covered over the fake endpoint in
 * src/__tests__/shared/maestro-lib/managed/live-execution-check.test.ts.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	DEFAULT_SOCKET,
	extractTar,
	issuedAuthority,
	loadRuntime,
	main,
	needsIssuedAuthority,
	parse,
	readIdentity,
	registrationMode,
} from '../../../scripts/live-execution-check.mjs';

const SHA = 'a'.repeat(64);
const base = ['--runtime', '/tmp/runtime.tgz', '--sha256', SHA, '--request', '/tmp/request.json'];
const checkout = path.resolve(__dirname, '../../..');
const scratch: string[] = [];
afterEach(() => {
	for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const tmp = () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-check-test-'));
	scratch.push(dir);
	return dir;
};

/** One ustar header plus its data blocks. */
function entry(name: string, data: Buffer, type = '0'): Buffer {
	const header = Buffer.alloc(512);
	header.write(name, 0, 100);
	header.write('0000644\0', 100);
	header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
	header.write(type, 156);
	header.write('ustar\0', 257);
	const body = Buffer.alloc(Math.ceil(data.length / 512) * 512);
	data.copy(body);
	return Buffer.concat([header, body]);
}
const tar = (...entries: Buffer[]) => Buffer.concat([...entries, Buffer.alloc(1024)]);

describe('live-execution-check', () => {
	it('requires the runtime, its digest and the request, and defaults to the protected service socket', () => {
		for (const drop of ['--runtime', '--sha256', '--request']) {
			const args = [...base];
			args.splice(args.indexOf(drop), 2);
			expect(() => parse(args)).toThrow(`${drop} is required`);
		}
		expect(() =>
			parse([...base.slice(0, 2), '--sha256', 'A'.repeat(64), ...base.slice(4)])
		).toThrow('64 lowercase hex');
		expect(parse(base).socket).toBe(DEFAULT_SOCKET);
	});

	it('writes nothing inside the checkout, and takes no effect of its own to settle', () => {
		expect(() => parse([...base, '--out', path.join(checkout, 'obs.json')])).toThrow(
			'outside the checkout'
		);
		expect(() => parse([...base, '--work-dir', path.join(checkout, 'Plans')])).toThrow(
			'outside the checkout'
		);
		// The endpoint settles a dispatched effect itself; the driver never names one.
		expect(() => parse([...base, '--effect', 'completed'])).toThrow("Unknown option '--effect'");
		expect(parse([...base, '--out', path.join(os.tmpdir(), 'obs.json')]).out).toBe(
			path.join(os.tmpdir(), 'obs.json')
		);
	});

	it('extracts files and folders, and refuses an escaping or special entry', () => {
		const into = tmp();
		extractTar(
			tar(entry('package/', Buffer.alloc(0), '5'), entry('package/a.txt', Buffer.from('hello'))),
			into
		);
		expect(fs.readFileSync(path.join(into, 'package/a.txt'), 'utf8')).toBe('hello');
		expect(() => extractTar(tar(entry('../escape.txt', Buffer.from('x'))), tmp())).toThrow(
			'unsafe entry'
		);
		expect(() => extractTar(tar(entry('package/link', Buffer.alloc(0), '2')), tmp())).toThrow(
			'not a file or directory'
		);
	});

	it('reads the enrolled identity and refuses one missing a field', () => {
		const dir = tmp();
		const file = path.join(dir, 'identity.json');
		fs.writeFileSync(
			file,
			JSON.stringify({ installationId: 'inst', runtimeId: 'rt', processEpoch: 'ep', extra: 1 })
		);
		expect(readIdentity(file)).toEqual({
			installationId: 'inst',
			runtimeId: 'rt',
			processEpoch: 'ep',
		});
		fs.writeFileSync(file, JSON.stringify({ installationId: 'inst', runtimeId: 'rt' }));
		expect(() => readIdentity(file)).toThrow('--identity has no processEpoch');
		expect(parse([...base, '--identity', file]).identity).toBe(file);
		expect(parse(base).authorityMs).toBe(60000);
		expect(() => parse([...base, '--authority-timeout-ms', '-1'])).toThrow(
			'--authority-timeout-ms'
		);
	});

	it('waits for authority.json only after a registered pass stopped at the claim', async () => {
		const failedAt = (step: string, redeemed: boolean) => ({
			outcome: 'failed',
			failure: { step, detail: 'denied' },
			steps: redeemed ? [{ step: 'registration_redeem', status: 'ok' }] : [],
		});
		expect(needsIssuedAuthority(failedAt('workflow_claim', true))).toBe(true);
		expect(needsIssuedAuthority(failedAt('workflow_claim', false))).toBe(false);
		expect(needsIssuedAuthority(failedAt('execution', true))).toBe(false);

		const dir = tmp();
		expect(await issuedAuthority(dir, 'c1', 0, 1)).toBeNull();
		const authority = { delegation: { grant: {}, chain: [{}] }, grants: [] };
		fs.writeFileSync(
			path.join(dir, 'authority.json'),
			JSON.stringify({ challengeId: 'old', authority })
		);
		await expect(issuedAuthority(dir, 'c1', 0, 1)).rejects.toThrow('names challenge old');
		fs.writeFileSync(
			path.join(dir, 'authority.json'),
			JSON.stringify({ challengeId: 'c1', authority })
		);
		expect((await issuedAuthority(dir, 'c1', 0, 1))?.authority).toEqual(authority);
	});

	it('runs a second pass with the issued authority, the enrolled identity and one key per pass', async () => {
		const pkg = tmp();
		const lib = `
const calls = (globalThis.__liveCheckCalls = []);
exports.MAESTRO_LIB_VERSION = '0.0.0-test';
exports.LOCAL_ENDPOINT_PROTOCOL = 2;
exports.LIVE_EXECUTION_CAPABILITIES = ['registration_use'];
exports.installationIdentity = () => { throw new Error('the enrolled identity must be used'); };
exports.createLocalEndpointClient = () => ({ close: async () => {} });
exports.runLiveExecutionCheck = async (input) => {
	const keys = [input.newId(), input.newId(), input.newId()];
	calls.push({ input, keys });
	if (calls.length === 1) {
		await input.approve({ challengeId: 'c1' });
		return { outcome: 'failed', failure: { step: 'workflow_claim', detail: 'denied' },
			steps: [{ step: 'registration_redeem', status: 'ok' }, { step: 'workflow_claim', status: 'denied' }] };
	}
	return { outcome: 'passed', registration: { purpose: 'runtime_use' }, steps: [{ step: 'workflow_claim', status: 'ok' }] };
};`;
		const archive = path.join(pkg, 'runtime.tgz');
		fs.writeFileSync(
			archive,
			gzipSync(
				tar(
					entry('package/', Buffer.alloc(0), '5'),
					entry('package/library/', Buffer.alloc(0), '5'),
					entry('package/library/index.js', Buffer.from(lib))
				)
			)
		);
		const digest = createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
		const work = tmp();
		const issued = { delegation: { grant: { g: 2 }, chain: [{ g: 2 }] }, grants: [] };
		fs.writeFileSync(path.join(work, 'approval.json'), JSON.stringify({ challengeId: 'c1' }));
		fs.writeFileSync(
			path.join(work, 'authority.json'),
			JSON.stringify({ challengeId: 'c1', authority: issued })
		);
		const request = path.join(pkg, 'request.json');
		fs.writeFileSync(
			request,
			JSON.stringify({
				authority: { delegation: { grant: { g: 1 }, chain: [{ g: 1 }] }, grants: [] },
				execution: { provider: 'synthetic-node', resourceIds: [], idempotencyKey: 'ignored' },
				workflow: { runId: 'run-from-request' },
			})
		);
		const identity = path.join(pkg, 'identity.json');
		fs.writeFileSync(
			identity,
			JSON.stringify({ installationId: 'inst', runtimeId: 'rt', processEpoch: 'ep' })
		);
		const out = path.join(pkg, 'obs.json');
		const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
		const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
		let code: number;
		try {
			code = await main([
				'--runtime',
				archive,
				'--sha256',
				digest,
				'--request',
				request,
				'--identity',
				identity,
				'--work-dir',
				work,
				'--out',
				out,
			]);
		} finally {
			write.mockRestore();
			err.mockRestore();
		}
		expect(code).toBe(0);
		const calls = (globalThis as { __liveCheckCalls?: any[] }).__liveCheckCalls!;
		expect(calls).toHaveLength(2);
		const [first, second] = calls;
		expect(first.input.attachment).toMatchObject({
			installationId: 'inst',
			runtimeId: 'rt',
			processEpoch: 'ep',
			supportedProtocols: [2],
		});
		expect(first.input.workflow.runId).toBe('run-from-request');
		expect(second.input.workflow.runId).not.toBe('run-from-request');
		expect(second.input.authority).toEqual(issued);
		for (const { input, keys } of calls) {
			expect(new Set(keys).size).toBe(1);
			expect(input.execution.idempotencyKey).toBe(keys[0]);
		}
		expect(first.keys[0]).not.toBe(second.keys[0]);
		const report = JSON.parse(fs.readFileSync(out, 'utf8'));
		expect(report.outcome).toBe('passed');
		expect(report.installation.source).toBe('identity');
		// The last pass ran no challenge step, so the report names grant mode.
		expect(report.registration).toEqual({ purpose: 'runtime_use', mode: 'grant' });
		expect(
			report.passes.map((p: { pass: number; outcome: string }) => [p.pass, p.outcome])
		).toEqual([
			[1, 'failed'],
			[2, 'passed'],
		]);
	});

	it('names how a pass registered, and no mode when nothing was projected', () => {
		const registration = { purpose: 'runtime_use' };
		expect(registrationMode({ registration: null, steps: [] })).toBeNull();
		expect(
			registrationMode({
				registration,
				steps: [{ step: 'attachment' }, { step: 'registration_challenge' }],
			})
		).toBe('challenge');
		expect(
			registrationMode({
				registration,
				steps: [{ step: 'attachment' }, { step: 'registration_use' }],
			})
		).toBe('grant');
	});

	it('loads nothing from an archive whose digest is not the one given', () => {
		const dir = tmp();
		const archive = path.join(dir, 'runtime.tgz');
		fs.writeFileSync(archive, gzipSync(tar(entry('package/', Buffer.alloc(0), '5'))));
		expect(() => loadRuntime(archive, SHA, tmp())).toThrow('not ' + SHA);
	});
});
