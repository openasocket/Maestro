/** Local consumer proof only: declared prepared authority, real child/fs/loopback sinks. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLocalHostAuthority } from '../../../shared/maestro-lib/managed/authority';
import { managedAuthorityId } from '../../../shared/maestro-lib/managed/host-adapter';
import { startTurn } from '../../../shared/maestro-lib/run/start-turn';
import {
	composePair,
	DIRECT_PAIR_SCENARIOS,
	PAIR_POLICY_REVISION,
	PAIR_T0,
	runDirectPairScenario,
	startPairEffectObservers,
	SYNTHETIC_PROVIDER_SOURCE,
	verifiedContext,
	type PairComposition,
} from './fixtures';

describe('direct pair scenarios with declared local authority', () => {
	let root: string;
	let work: string;
	let pair: PairComposition;
	let observers: Awaited<ReturnType<typeof startPairEffectObservers>>;
	let producerCalls: number;
	let loseResponse: boolean;
	beforeEach(async () => {
		root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'direct-pair-')));
		work = path.join(root, 'work');
		fs.mkdirSync(work);
		producerCalls = 0;
		loseResponse = false;
		observers = await startPairEffectObservers(work);
		pair = await composePair({
			dir: root,
			prepared: {
				actorId: 'fixture-actor',
				create: (identity) => {
					const authority = createLocalHostAuthority({
						authorityId: managedAuthorityId(identity),
						now: () => PAIR_T0,
						newId: () => `fixture-lease-${producerCalls}`,
						decide: () => ({ decision: 'allow', policyRevision: PAIR_POLICY_REVISION }),
					});
					return {
						...authority,
						version: 1,
						admit: async (request) => {
							producerCalls++;
							if (loseResponse) throw new Error('declared lost producer response');
							return authority.admit(request);
						},
					};
				},
			},
		});
		expect(await pair.attach()).toBe('ok');
	});
	afterEach(async () => {
		await pair?.close();
		await observers?.close();
		fs.rmSync(root, { recursive: true, force: true });
	});
	const input = (holdOpen = false) =>
		JSON.stringify({
			prompt: 'local fixture',
			probePort: observers.probePort,
			childMarker: observers.childMarker,
			holdOpen,
		});
	it('positive control: independent observers see a child marker, a file and a loopback connection', async () => {
		const handle = startTurn(
			{
				command: process.execPath,
				args: ['-e', SYNTHETIC_PROVIDER_SOURCE],
				cwd: work,
				env: {},
				stdin: input(),
			},
			{},
			{}
		);
		const timeout = setTimeout(() => handle.terminate(), 3000);
		try {
			expect((await handle.done).exitCode).toBe(0);
		} finally {
			clearTimeout(timeout);
		}
		const observed = observers.snapshot();
		expect(observed.connections).toBe(1);
		expect(Number(observed.childMarker)).toBeGreaterThan(0);
		expect(observed.fileBytes).toBeGreaterThan(0);
		expect(observed.files).toContain('child.marker');
	});
	it.each(DIRECT_PAIR_SCENARIOS)(
		'%s: prepares, executes, inspects and cancels through the owned ports',
		async (scenario) => {
			loseResponse = scenario === 'unknown';
			const result = await runDirectPairScenario({
				bridge: pair.bridge,
				scenario,
				observers,
				context: verifiedContext(pair.verifier, {
					actor: {
						kind: 'human',
						id: scenario === 'wrong-actor' ? 'other-actor' : 'fixture-actor',
					},
				}),
				request: {
					script: SYNTHETIC_PROVIDER_SOURCE,
					inputs: [],
					workDir: work,
					timeoutMs: 3000,
					stdin: input(scenario === 'cancel'),
				},
			});
			expect(result.observed.connections).toBe(0);
			expect(result.observed.childMarker).toBeNull();
			expect(pair.host.authority.live()).toHaveLength(0);
			expect(
				pair.fake.calls.filter((c) => (c.body as { operation?: string }).operation === 'execution')
			).toHaveLength(0);
			if (scenario === 'allow' || scenario === 'cancel') {
				expect(result.prepare).toBe('admitted');
				expect(result.observed.fileBytes).toBeGreaterThan(0);
				expect(result.inspect?.effect.pid).toBeGreaterThan(0);
				expect(result.inspect?.effect.state).toBe(scenario === 'cancel' ? 'revoked' : 'released');
				expect(result.cancelled).toBe(scenario === 'cancel');
				if (scenario === 'allow') expect(result.execute).toMatchObject({ exitCode: 0 });
				const ledger = JSON.parse(fs.readFileSync(pair.ledgerFile, 'utf8'));
				expect(ledger.receipts[0].effect).toEqual(result.inspect?.effect);
			} else {
				expect(result.observed).toMatchObject({ fileBytes: 0, files: [] });
				if (scenario === 'changed-input') {
					expect(result.prepare).toBe('admitted');
					expect(result.execute).toHaveProperty('refused');
					expect(result.inspect?.effect.pid).toBeNull();
				} else {
					expect(result.prepare).toBe(scenario === 'unknown' ? 'unknown' : 'denied');
					expect(result.execute).toBeNull();
				}
			}
			if (scenario === 'unknown') expect(result.replay).toBe('unknown');
			expect(producerCalls).toBe(scenario === 'wrong-actor' ? 0 : 1);
		}
	);
	it('refuses a stale observer directory rather than counting previous effects', async () => {
		fs.writeFileSync(observers.childMarker, 'stale');
		await expect(startPairEffectObservers(work)).rejects.toThrow('fresh effects directory');
	});
});
