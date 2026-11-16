/**
 * scripts/live-execution-check.mjs: the loader that runs the live execution
 * check from a packaged runtime archive. Defended here: the arguments it
 * refuses (nothing written inside the read-only checkout, a settled effect
 * needs evidence), the archive digest it insists on, and the tar reader that
 * refuses an entry escaping its directory or anything but files and folders.
 * The check itself is covered over the fake endpoint in
 * src/__tests__/shared/maestro-lib/managed/live-execution-check.test.ts.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';

import {
	DEFAULT_SOCKET,
	extractTar,
	loadRuntime,
	parse,
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
		expect(parse(base).effect).toBe('uncertain');
	});

	it('writes nothing inside the checkout, and settles only with evidence', () => {
		expect(() => parse([...base, '--out', path.join(checkout, 'obs.json')])).toThrow(
			'outside the checkout'
		);
		expect(() => parse([...base, '--work-dir', path.join(checkout, 'Plans')])).toThrow(
			'outside the checkout'
		);
		expect(() => parse([...base, '--effect', 'completed'])).toThrow('--evidence-file');
		expect(() => parse([...base, '--effect', 'teleported'])).toThrow('uncertain, completed');
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

	it('loads nothing from an archive whose digest is not the one given', () => {
		const dir = tmp();
		const archive = path.join(dir, 'runtime.tgz');
		fs.writeFileSync(archive, gzipSync(tar(entry('package/', Buffer.alloc(0), '5'))));
		expect(() => loadRuntime(archive, SHA, tmp())).toThrow('not ' + SHA);
	});
});
