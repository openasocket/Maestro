import { beforeAll, describe, expect, expectTypeOf, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { readPin } from '../../../../../scripts/import-mega-maestro.mjs';
import { inspectContractsDir } from '../../../../../scripts/check-mega-contract-vectors.mjs';
import receipt from '../../../../../Plans/integration-completion/evidence/contract-inputs-build-0.2.0.json';
import {
	MANAGED_ROUTES,
	PROVIDER_CONFORMANCE_LIMITS,
	PROVIDER_HOST_CONTRACT_VERSION,
	providerCallProblems,
	providerResourceProblems,
	providerRouteSupport,
	providerTransportForRoute,
	type DispatchLease,
	type EndpointInvokeOutcome,
	type ManagedEffectDecision,
	type ProviderCallContext,
	type ProviderConnectedPeer,
	type ProviderEffectPort,
	type ProviderExecutionScope,
	type ProviderPermittedResource,
	type ProviderProcessLifetime,
	type ProviderTransportPort,
} from '../../../../shared/maestro-lib/index';

const call = (patch: Partial<ProviderCallContext> = {}): ProviderCallContext => ({
	signal: new AbortController().signal,
	timeoutMs: 100,
	requestBytes: 1024,
	responseBytes: 1024,
	...patch,
});

describe('local provider/host conformance contracts', () => {
	// The real pinned public schemas, with test-only resource declarations.
	let resourcesSchema: { safeParse(value: unknown): { success: boolean } };
	let transports: readonly string[];
	beforeAll(async () => {
		const pin = readPin(path.resolve(receipt.archive.pin.path));
		expect(pin.sha256).toBe(receipt.archive.sha256);
		const contractsDir = path.resolve(receipt.archive.extractedPackage);
		const checked = inspectContractsDir({ contractsDir, expectedSha256: pin.payloadDigest });
		expect(checked.sourceRevision).toBe(pin.sourceRevision);
		expect(
			JSON.parse(fs.readFileSync(path.join(contractsDir, 'node_modules/zod/package.json'), 'utf8'))
				.version
		).toBe(pin.dependencies.zod);
		const published =
			await import('../../../../../vendor/mega-maestro/contracts/dist/execution.js');
		resourcesSchema = published.executionBinding.shape.resources;
		transports = published.providerRouteTransport.options;
	});

	it('maps every existing route to published vocabulary without changing provider support', () => {
		const support = providerRouteSupport('codex');
		expect(PROVIDER_HOST_CONTRACT_VERSION).toBe(1);
		expect(MANAGED_ROUTES.map(providerTransportForRoute)).toEqual([
			'cli-process',
			'persistent-sdk',
			'persistent-sdk',
			'pty',
			'ssh',
		]);
		expect(new Set(MANAGED_ROUTES.map(providerTransportForRoute))).toEqual(new Set(transports));
		expect(providerRouteSupport('codex')).toEqual(support);
		expect(() => providerTransportForRoute('invented' as never)).toThrow(
			'Unknown managed provider route.'
		);
	});

	it('reuses leases, authenticated contexts and distinct uncertain outcomes in its ports', () => {
		expectTypeOf<ProviderExecutionScope['lease']>().toEqualTypeOf<DispatchLease>();
		expectTypeOf<Awaited<ReturnType<ProviderTransportPort['invoke']>>>().toEqualTypeOf<
			EndpointInvokeOutcome<unknown>
		>();
		expectTypeOf<
			Awaited<ReturnType<ProviderEffectPort['decide']>>
		>().toEqualTypeOf<ManagedEffectDecision>();
		expectTypeOf<ProviderConnectedPeer['process']['startedAt']>().toEqualTypeOf<string>();
		expectTypeOf<
			Extract<Awaited<ReturnType<ProviderProcessLifetime['cancel']>>, { outcome: 'unknown' }>
		>().toEqualTypeOf<{ outcome: 'unknown'; message: string }>();
		// A plain process claim cannot supply the verifier's branded context.
		expectTypeOf<{ actor: { id: string } }>().not.toMatchTypeOf<ProviderConnectedPeer['context']>();
	});

	it.each(['read', 'write', 'execute'] as const)(
		'accepts the public %s resource shape only',
		(access) => {
			const resources: ProviderPermittedResource[] = [
				{ path: '/test/input', identity: 'test-inode', access },
			];
			expect(providerResourceProblems(resources)).toEqual([]);
			expect(resourcesSchema.safeParse(resources).success).toBe(true);
		}
	);

	it.each(
		[
			[],
			Array.from({ length: 64 }, () => ({ path: 'x', identity: 'i', access: 'read' })),
			[{ path: 'x'.repeat(4096), identity: 'i'.repeat(4096), access: 'read' }],
			null,
			[null],
			new Array(1),
			[[]],
			Array.from({ length: 65 }, () => ({ path: 'x', identity: 'i', access: 'read' })),
			[{ path: '', identity: 'i', access: 'read' }],
			[{ path: 'x', identity: '', access: 'read' }],
			[{ path: 'x'.repeat(4097), identity: 'i', access: 'read' }],
			[{ path: 'x', identity: 'i'.repeat(4097), access: 'read' }],
			[{ path: 'x\0y', identity: 'i', access: 'read' }],
			[{ path: 'x', identity: 'i\0j', access: 'read' }],
			[{ path: 'x', identity: 'i', access: 'admin' }],
			[{ path: 'x', identity: 'i', access: 'read', actorId: 'forged' }],
			[{ path: 'x', access: 'read' }],
		].map((resources, index) => ({ resources, index }))
	)('matches public resource bounds, vector $index', ({ resources }) => {
		expect(providerResourceProblems(resources).length === 0).toBe(
			resourcesSchema.safeParse(resources).success
		);
	});

	it('does not resolve, normalize or grant a declared path, and emits no input in diagnostics', () => {
		const resources = [{ path: '../private', identity: 'secret-value', access: 'invalid' }];
		const before = JSON.stringify(resources);
		expect(providerResourceProblems(resources)).toEqual(['resources[0].access is unknown']);
		expect(JSON.stringify(resources)).toBe(before);
	});

	it('accepts explicit positive limits up to the shared ceilings', () => {
		expect(providerCallProblems(call({ ...PROVIDER_CONFORMANCE_LIMITS }), {})).toEqual([]);
		expect(Object.isFrozen(PROVIDER_CONFORMANCE_LIMITS)).toBe(true);
	});

	it.each(['timeoutMs', 'requestBytes', 'responseBytes'] as const)(
		'refuses invalid %s without clamping',
		(key) => {
			for (const value of [0, -1, 1.5, NaN, Infinity, PROVIDER_CONFORMANCE_LIMITS[key] + 1]) {
				expect(providerCallProblems(call({ [key]: value }), {})).toContain(
					`${key} is outside the conformance bounds`
				);
			}
		}
	);

	it('counts the complete UTF-8 envelope, including multibyte characters', () => {
		const envelope = { input: '🌍' };
		const bytes = Buffer.byteLength(JSON.stringify(envelope));
		expect(providerCallProblems(call({ requestBytes: bytes }), envelope)).toEqual([]);
		expect(providerCallProblems(call({ requestBytes: bytes - 1 }), envelope)).toEqual([
			'request exceeds its byte bound',
		]);
	});

	it('refuses cancellation and non-serializable requests without leaking their contents', () => {
		const controller = new AbortController();
		controller.abort('private-reason');
		expect(providerCallProblems(call({ signal: controller.signal }), {})).toEqual([
			'call is cancelled',
		]);
		const cycle: unknown[] = [];
		cycle.push(cycle);
		for (const envelope of [
			cycle,
			1n,
			undefined,
			{
				toJSON() {
					throw new Error('private-reason');
				},
			},
		]) {
			expect(providerCallProblems(call(), envelope)).toEqual(['request is not JSON serializable']);
		}
	});
});
