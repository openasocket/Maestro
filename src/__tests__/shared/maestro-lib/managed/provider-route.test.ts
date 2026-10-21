/**
 * The synthetic harness route: its bounds, the launch spec it builds (the
 * permission model with the declared grants and a complete environment),
 * and the support it reports (one provider, one route, scope named; never
 * a real provider). Running a program under the spec is the early-pair
 * integration suite's job; this file stays pure.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
	buildHarnessLaunchSpec,
	HARNESS_LIMITS,
	HARNESS_REQUIRED_NODE_FLAGS,
	harnessRouteProblems,
	SYNTHETIC_HARNESS_PROVIDER,
	SYNTHETIC_HARNESS_ROUTE_ID,
	syntheticHarnessRouteSupport,
	type HarnessRouteRequest,
} from '../../../../shared/maestro-lib/managed/provider-route';

describe('synthetic harness route', () => {
	let work: string;
	let input: string;
	beforeEach(() => {
		work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-route-')));
		input = path.join(work, 'input.txt');
		fs.writeFileSync(input, 'hello');
	});
	afterEach(() => fs.rmSync(work, { recursive: true, force: true }));

	const request = (overrides: Partial<HarnessRouteRequest> = {}): HarnessRouteRequest => ({
		script: 'process.exit(0)',
		inputs: [input],
		workDir: work,
		timeoutMs: 5_000,
		...overrides,
	});

	it('accepts a bounded request over canonical regular inputs and an existing work directory', () => {
		expect(harnessRouteProblems(request())).toEqual([]);
		expect(harnessRouteProblems(request({ inputs: [], stdin: 'prompt' }))).toEqual([]);
	});

	it('names every bound the endpoint harness holds, and refuses what is not canonical', () => {
		expect(harnessRouteProblems(request({ script: '' }))).toEqual(['script is empty']);
		expect(
			harnessRouteProblems(request({ script: 'x'.repeat(HARNESS_LIMITS.scriptBytes + 1) }))
		).toEqual([`script exceeds ${HARNESS_LIMITS.scriptBytes} bytes`]);
		expect(harnessRouteProblems(request({ script: 'a\0b' }))).toEqual(['script contains NUL']);
		expect(harnessRouteProblems(request({ timeoutMs: 0 }))).toEqual([
			`timeoutMs is not within ${HARNESS_LIMITS.timeoutMinMs} and ${HARNESS_LIMITS.timeoutMaxMs}`,
		]);
		expect(harnessRouteProblems(request({ timeoutMs: 60_001 }))).toHaveLength(1);
		expect(
			harnessRouteProblems(request({ stdin: 'x'.repeat(HARNESS_LIMITS.stdinBytes + 1) }))
		).toEqual([`stdin exceeds ${HARNESS_LIMITS.stdinBytes} bytes`]);
		expect(
			harnessRouteProblems(request({ inputs: Array.from({ length: 33 }, () => input) }))
		).toContain('33 inputs exceed the bound of 32');
		expect(harnessRouteProblems(request({ inputs: ['relative.txt'] }))).toEqual([
			'inputs[0] is not an absolute path without separators',
		]);
		expect(harnessRouteProblems(request({ inputs: [path.join(work, 'a,b.txt')] }))).toEqual([
			'inputs[0] is not an absolute path without separators',
		]);
		expect(harnessRouteProblems(request({ inputs: [path.join(work, 'missing.txt')] }))).toEqual([
			'inputs[0] does not exist',
		]);
		expect(harnessRouteProblems(request({ inputs: [work] }))).toEqual([
			'inputs[0] is not a regular file',
		]);
		const link = path.join(work, 'link.txt');
		fs.symlinkSync(input, link);
		expect(harnessRouteProblems(request({ inputs: [link] }))).toEqual([
			'inputs[0] is not canonical',
		]);
		expect(harnessRouteProblems(request({ workDir: path.join(work, 'nope') }))).toEqual([
			'workDir does not exist',
		]);
		expect(harnessRouteProblems(request({ workDir: input }))).toEqual([
			'workDir is not a directory',
		]);
		expect(harnessRouteProblems(request({ nodeExecutable: 'node' }))).toEqual([
			'nodeExecutable is not an absolute path',
		]);
	});

	it('builds the permission-model spec with the declared grants and a complete environment', () => {
		const spec = buildHarnessLaunchSpec(request({ stdin: 'the prompt' }));
		expect(spec).toEqual({
			command: process.execPath,
			args: [
				'--permission',
				'--disallow-code-generation-from-strings',
				`--allow-fs-read=${input}`,
				`--allow-fs-write=${work}`,
				'-e',
				'process.exit(0)',
			],
			cwd: work,
			env: { PATH: '/usr/bin:/bin', HOME: work },
			shell: false,
			stdin: 'the prompt',
		});
		expect(spec.args).not.toContain('--allow-net');
		expect(spec.args).not.toContain('--allow-child-process');
		expect(Object.keys(spec.env)).toEqual(['PATH', 'HOME']);
		expect(buildHarnessLaunchSpec(request({ nodeExecutable: '/opt/node' })).command).toBe(
			'/opt/node'
		);
	});

	it('reports one provider on one route, enforcement per effect, and what it does not qualify', () => {
		const flags = new Set(HARNESS_REQUIRED_NODE_FLAGS);
		const support = syntheticHarnessRouteSupport({ platform: 'linux', nodeFlags: flags });
		expect(support).toMatchObject({
			agentId: SYNTHETIC_HARNESS_PROVIDER,
			route: 'child-process',
			routeId: SYNTHETIC_HARNESS_ROUTE_ID,
			standalone: 'implemented',
			managed: 'implemented',
			enforcement: { enforcedBy: 'node-permission-model' },
		});
		expect(support.enforcement.network).toMatch(/denied/);
		expect(support.enforcement.descendants).toMatch(/denied/);
		expect(support.doesNotQualify).toMatch(/Claude, Codex, OpenCode/);

		const noNet = new Set(flags);
		noNet.delete('--allow-net');
		expect(syntheticHarnessRouteSupport({ platform: 'linux', nodeFlags: noNet })).toMatchObject({
			managed: 'unsupported',
			standalone: 'unsupported',
			note: expect.stringContaining('--allow-net'),
		});
		expect(syntheticHarnessRouteSupport({ platform: 'win32', nodeFlags: flags })).toMatchObject({
			managed: 'unsupported',
			note: expect.stringContaining('Windows'),
		});
		// This Node honors the flags the route needs, so the route is on here.
		expect(syntheticHarnessRouteSupport().managed).toBe(
			process.platform === 'win32' ? 'unsupported' : 'implemented'
		);
	});
});
