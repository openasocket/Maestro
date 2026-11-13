/**
 * Provider route evidence (MCOMP-31-01): the consumer of the pinned public
 * signedProviderRouteQualification receipt. Fixtures are contract-conforming
 * (each one parses under the real published schema) and live only here; the
 * verifier is a test double, so nothing below qualifies a provider. Real
 * provider confinement is MCOMP-32's job.
 */

import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { readPin } from '../../../../../scripts/import-mega-maestro.mjs';
import { inspectContractsDir } from '../../../../../scripts/check-mega-contract-vectors.mjs';
import receipt from '../../../../../Plans/integration-completion/evidence/contract-inputs-build-0.2.0.json';
import {
	approveProviderRoute,
	PROVIDER_ROUTE_ALLOW_CASES,
	PROVIDER_ROUTE_DENY_CASES,
	providerRouteEvidenceProblems,
	type ProviderRouteCandidate,
	type ProviderRouteEvidenceVerifier,
	type SignedProviderRouteQualification,
} from '../../../../shared/maestro-lib/index';

const d = (c: string) => c.repeat(64);
const NOW = Date.parse('2026-11-09T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

const candidate = (): ProviderRouteCandidate => ({
	provider: 'claude-code',
	adapterId: 'claude-cli-v1',
	transport: 'cli-process',
	binary: { digest: d('a'), version: '2.1.0', identity: 'inode:42' },
	os: { platform: 'linux', release: '6.8.0', arch: 'x64' },
	backend: { id: 'bwrap-v1', evidenceDigest: d('b') },
	inputDigest: d('c'),
});

function evidence(): SignedProviderRouteQualification {
	const c = candidate();
	return {
		payload: {
			version: 1,
			receiptId: '0b6f1b9e-4a3c-4d8e-9f00-1234567890ab',
			producer: {
				owner: 'mega-maestro',
				implementationRevision: 'e'.repeat(40),
				observedRevision: 'e'.repeat(40),
			},
			tier: 'real-cli-fixture-model',
			modelTransport: 'deterministic-fixture',
			route: { provider: c.provider, adapterId: c.adapterId, transport: c.transport },
			binary: { ...c.binary },
			os: { platform: 'linux', release: c.os.release, arch: 'x64' },
			backend: { ...c.backend },
			inputSnapshot: {
				inputDigest: c.inputDigest,
				inputs: [
					['a/bin', d('1')],
					['b/cfg', d('2')],
				],
			},
			observations: [
				...PROVIDER_ROUTE_ALLOW_CASES.map((name) => ({
					case: name,
					expected: 'allowed' as const,
					observed: 'allowed' as const,
					observer: 'receipt' as const,
					evidenceDigest: d('3'),
				})),
				...PROVIDER_ROUTE_DENY_CASES.map((name) => ({
					case: name,
					expected: 'denied' as const,
					observed: 'denied' as const,
					observer: 'filesystem' as const,
					evidenceDigest: d('4'),
				})),
			],
			observedAt: new Date(NOW - DAY).toISOString(),
		},
		payloadDigest: d('5'),
		keyId: 'route-key-1',
		algorithm: 'Ed25519',
		signature: `${'A'.repeat(86)}==`,
	};
}

const verifier = (
	verdict: 'verified' | 'invalid' | 'unavailable' = 'verified',
	during?: () => void
): ProviderRouteEvidenceVerifier & { calls: number } => {
	const v = {
		version: 1 as const,
		calls: 0,
		async verify() {
			v.calls += 1;
			during?.();
			return verdict;
		},
	};
	return v;
};

const opts = (signal = new AbortController().signal) => ({
	maxAgeMs: 30 * DAY,
	now: () => NOW,
	signal,
});

describe('provider route evidence', () => {
	let published: {
		providerRouteAllowCases: readonly string[];
		providerRouteDenyCases: readonly string[];
		signedProviderRouteQualification: { safeParse(value: unknown): { success: boolean } };
	};
	beforeAll(async () => {
		const pin = readPin(path.resolve(receipt.archive.pin.path));
		expect(pin.sha256).toBe(receipt.archive.sha256);
		inspectContractsDir({
			contractsDir: path.resolve(receipt.archive.extractedPackage),
			expectedSha256: pin.payloadDigest,
		});
		published = await import('../../../../../vendor/mega-maestro/contracts/dist/execution.js');
	});

	it('mirrors the published case vocabulary and its fixtures conform to the published schema', () => {
		expect([...PROVIDER_ROUTE_ALLOW_CASES]).toEqual([...published.providerRouteAllowCases]);
		expect([...PROVIDER_ROUTE_DENY_CASES]).toEqual([...published.providerRouteDenyCases]);
		expect(published.signedProviderRouteQualification.safeParse(evidence()).success).toBe(true);
	});

	it('approves only a verified, exactly bound, fresh, fully observed real-provider receipt', async () => {
		const v = verifier();
		const approval = await approveProviderRoute(evidence(), candidate(), v, opts());
		expect(approval).toEqual({
			state: 'qualified',
			receiptId: evidence().payload.receiptId,
			tier: 'real-cli-fixture-model',
			payloadDigest: d('5'),
		});
		expect(v.calls).toBe(1);
	});

	it('is unavailable without a trusted verifier or when verification fails', async () => {
		expect(await approveProviderRoute(evidence(), candidate(), undefined, opts())).toEqual({
			state: 'unavailable',
			reasons: ['no trusted route evidence verifier'],
		});
		for (const verdict of ['invalid', 'unavailable'] as const) {
			const approval = await approveProviderRoute(
				evidence(),
				candidate(),
				verifier(verdict),
				opts()
			);
			expect(approval).toEqual({ state: 'unavailable', reasons: [`signature ${verdict}`] });
		}
		const throwing: ProviderRouteEvidenceVerifier = {
			version: 1,
			verify: () => Promise.reject(new Error('lost')),
		};
		expect((await approveProviderRoute(evidence(), candidate(), throwing, opts())).state).toBe(
			'unavailable'
		);
	});

	it('refuses a receipt bound to any other binary, OS, transport, backend or input set', () => {
		const cases: Array<[(c: ProviderRouteCandidate) => void, string]> = [
			[(c) => (c.binary.digest = d('f')), 'binary.digest differs'],
			[(c) => (c.binary.version = '2.1.1'), 'binary.version differs'],
			[(c) => (c.os.platform = 'darwin'), 'os.platform differs'],
			[(c) => (c.transport = 'pty'), 'route.transport differs'],
			[(c) => (c.adapterId = 'other'), 'route.adapterId differs'],
			[(c) => (c.backend.evidenceDigest = d('9')), 'backend.evidenceDigest differs'],
			[(c) => (c.inputDigest = d('8')), 'inputSnapshot.inputDigest differs'],
		];
		for (const [mutate, problem] of cases) {
			const c = candidate();
			mutate(c);
			expect(providerRouteEvidenceProblems(evidence(), c, opts())).toContain(problem);
		}
	});

	it('requires every mandatory case observed as expected, once, with outside evidence', () => {
		const missing = evidence();
		missing.payload.observations = missing.payload.observations.filter(
			(o) => o.case !== 'direct_dns'
		);
		expect(providerRouteEvidenceProblems(missing, candidate(), opts())).toEqual([
			'case direct_dns was not observed',
		]);
		const escaped = evidence();
		escaped.payload.observations.find((o) => o.case === 'descendant_escape')!.observed = 'allowed';
		expect(providerRouteEvidenceProblems(escaped, candidate(), opts())).toEqual([
			'case descendant_escape was allowed',
		]);
		const unobserved = evidence();
		unobserved.payload.observations[0].observed = 'unobserved';
		expect(providerRouteEvidenceProblems(unobserved, candidate(), opts())).toEqual([
			'case approved_tool_roundtrip was unobserved',
		]);
		const duplicated = evidence();
		duplicated.payload.observations.push({ ...duplicated.payload.observations[2] });
		expect(providerRouteEvidenceProblems(duplicated, candidate(), opts())[0]).toMatch(
			/is duplicated/
		);
	});

	it('never lets a node-harness or mismatched tier qualify a production provider', async () => {
		const harness = evidence();
		harness.payload.tier = 'node-harness';
		harness.payload.modelTransport = 'none';
		harness.payload.route.provider = 'synthetic-node';
		const c = { ...candidate(), provider: 'synthetic-node' };
		const v = verifier();
		expect(await approveProviderRoute(harness, c, v, opts())).toEqual({
			state: 'unavailable',
			reasons: ['a node-harness receipt qualifies no production provider'],
		});
		expect(v.calls).toBe(0);
		const lying = evidence();
		lying.payload.modelTransport = 'live-provider';
		expect(providerRouteEvidenceProblems(lying, candidate(), opts())).toEqual([
			'modelTransport does not match tier',
		]);
	});

	it('refuses stale, future, unbounded-age and malformed evidence', () => {
		const stale = evidence();
		stale.payload.observedAt = new Date(NOW - 31 * DAY).toISOString();
		expect(providerRouteEvidenceProblems(stale, candidate(), opts())).toEqual([
			'evidence is stale',
		]);
		const future = evidence();
		future.payload.observedAt = new Date(NOW + 1000).toISOString();
		expect(providerRouteEvidenceProblems(future, candidate(), opts())).toEqual([
			'observedAt is in the future',
		]);
		expect(
			providerRouteEvidenceProblems(evidence(), candidate(), { maxAgeMs: 0, now: () => NOW })
		).toEqual(['maxAgeMs is outside its bounds']);
		expect(providerRouteEvidenceProblems(null, candidate(), opts())).toEqual([
			'evidence is not a signed receipt',
		]);
	});

	it('rechecks cancellation and the candidate after the verification await', async () => {
		const controller = new AbortController();
		expect(
			await approveProviderRoute(
				evidence(),
				candidate(),
				verifier('verified', () => controller.abort()),
				opts(controller.signal)
			)
		).toEqual({ state: 'unavailable', reasons: ['cancelled'] });
		const c = candidate();
		expect(
			await approveProviderRoute(
				evidence(),
				c,
				verifier('verified', () => (c.binary.version = '9')),
				opts()
			)
		).toEqual({ state: 'unavailable', reasons: ['candidate changed during verification'] });
	});
});
