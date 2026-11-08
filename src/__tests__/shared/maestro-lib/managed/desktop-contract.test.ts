import { beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { readPin } from '../../../../../scripts/import-mega-maestro.mjs';
import { inspectContractsDir } from '../../../../../scripts/check-mega-contract-vectors.mjs';
import receipt from '../../../../../Plans/integration-completion/evidence/contract-inputs-build.json';
import { mapDesktopPolicy } from '../../../../shared/maestro-lib/index';
import type {
	DesktopPolicyBinding,
	DesktopPolicyProjection,
	DesktopPolicySchemaPort,
} from '../../../../shared/maestro-lib/managed/desktop-contract';
import {
	isSettingLockable,
	type ManagedSettingLocksView,
} from '../../../../shared/managedSettingsLock';
import {
	createPolicyStatusService,
	type NativePolicyProjection,
	type NativePolicyProjectionPort,
} from '../../../../main/enterprise/policy-status';
import { registeredStatus } from '../../../main/enterprise/fakeManaged';

const now = Date.parse('2026-11-08T12:00:00Z');
const uuid = '11111111-1111-4111-8111-111111111111';
const binding: DesktopPolicyBinding = {
	tenantId: uuid,
	orgId: uuid,
	principal: { id: uuid, kind: 'user' },
	enrollmentId: uuid,
	installationId: 'test-installation',
	runtimeId: 'test-runtime',
	processEpoch: 'test-epoch',
	policyId: uuid,
	policyRevision: 7,
	policyDigest: 'a'.repeat(64),
};

// Contract fixtures only. No authenticated service or production policy is supplied.
function projection(): DesktopPolicyProjection {
	return {
		schemaVersion: 1,
		binding: structuredClone(binding),
		issuedAt: new Date(now - 1_000).toISOString(),
		expiresAt: new Date(now + 60_000).toISOString(),
		operations: ['create', 'edit', 'clone', 'import'],
		choices: [
			{ kind: 'provider', ref: 'provider-1' },
			{ kind: 'model', ref: 'model-1', providerRef: 'provider-1' },
			{ kind: 'model', ref: 'model-2', providerRef: 'provider-1' },
			{ kind: 'account', ref: 'account-1', providerRef: 'provider-1' },
			{ kind: 'workspace', ref: 'workspace-1' },
			{ kind: 'tool', ref: 'tool-1' },
			{ kind: 'automation', ref: 'automation-1' },
			{ kind: 'credential', ref: 'credential-1', accountRef: 'account-1' },
		],
		fields: {
			provider: { state: 'locked', values: ['provider-1'] },
			model: { state: 'constrained', allowed: ['model-1'], minimum: 1, maximum: 1 },
			account: { state: 'locked', values: ['account-1'] },
			workspace: { state: 'user_editable', allowed: ['workspace-1'] },
			tool: { state: 'user_editable', allowed: ['tool-1'] },
			automation: { state: 'constrained', allowed: ['automation-1'], minimum: 0, maximum: 1 },
			credential: { state: 'locked', values: ['credential-1'] },
		},
	};
}

describe('desktop authoring mapping against pinned public schema 1', () => {
	let schema: DesktopPolicySchemaPort;
	const settings: ManagedSettingLocksView = { policyRevision: 7, locks: {} };
	const options = () => ({ schema, binding, settings, now });
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
		({ desktopPolicyResult: schema } =
			await import('../../../../../vendor/mega-maestro/contracts/dist/desktop-policy.js'));
	});

	// Local authenticated-producer double only; the real endpoint has no delivery mapping.
	function nativeHarness() {
		const standing = registeredStatus({ actorId: uuid, applied: 7 });
		const record = standing.identity.record!;
		Object.assign(record, {
			tenantId: uuid,
			orgId: uuid,
			enrollmentId: uuid,
			installationId: binding.installationId,
		});
		Object.assign(record.registration!, {
			runtimeId: binding.runtimeId,
			processEpoch: binding.processEpoch,
			expiresAt: new Date(now + 3_600_000).toISOString(),
		});
		record.endpoint.trustRootDigest = 'b'.repeat(64);
		record.policy.observedAt = new Date(now).toISOString();
		const source: NativePolicyProjection = {
			desktop: projection(),
			settings: { policyRevision: 7, locks: [{ key: 'agentConfig.model' }] },
			routes: [
				{
					providerId: 'claude-code',
					model: 'sonnet',
					baseUrl: null,
					accountDir: null,
					login: 'approved-credential',
					permissionMode: 'standard',
				},
			],
			ceilings: {
				browser: { policyRevision: 7, actors: [] },
				shell: { policyRevision: 7, surfaces: [] },
				plugins: { policyRevision: 7, plugins: [] },
				install: { policyRevision: 7, pins: [], mcpServers: [] },
				egress: { policyRevision: 7, classes: [] },
				listeners: { policyRevision: 7, listeners: [] },
				localEffects: { policyRevision: 7, classes: [] },
				repository: { policyRevision: 7, actors: [] },
				updates: { policyRevision: 7, hold: true, channel: 'stable', pin: null },
			},
		};
		const read = vi.fn(async (): Promise<unknown> => structuredClone(source));
		let port: NativePolicyProjectionPort | null = { version: 1, schema, readVerified: read };
		const clock = { now };
		const service = createPolicyStatusService({
			lifecycle: {
				status: () => standing,
				connect: async () => ({ status: 'ok', value: standing.endpoint! }),
				beginRegistration: async () => ({
					status: 'refused',
					reason: 'not-enrolled',
					message: 'test',
				}),
			},
			projections: () => port,
			now: () => clock.now,
		});
		return {
			service,
			source,
			standing,
			record,
			read,
			clock,
			disconnect: () => {
				port = null;
			},
		};
	}

	it('atomically receives all native restrictions and returns detached copies, including offline', async () => {
		const h = nativeHarness();
		expect(await h.service.refreshProjection()).toEqual({ installed: true, policyRevision: 7 });
		expect(h.service.installedProjection()).toEqual(h.source);
		expect(h.read.mock.calls[0]).toEqual([{ identity: h.record, connection: 1 }]);
		h.source.settings.locks.length = 0;
		h.service.installedProjection()!.settings.locks.length = 0;
		h.disconnect();
		h.standing.connection!.attached = false;
		h.clock.now += 3_600_001;
		expect(await h.service.refreshProjection()).toEqual({
			installed: false,
			reason: 'unavailable',
		});
		expect(h.service.installedProjection()!.settings.locks).toHaveLength(1);
		expect(h.service.status().admission.possible).toBe(false);
	});

	it.each([
		[
			'tenant',
			(h: ReturnType<typeof nativeHarness>) => {
				h.source.desktop.binding.tenantId = '22222222-2222-4222-8222-222222222222';
			},
		],
		[
			'revision',
			(h: ReturnType<typeof nativeHarness>) => {
				h.source.desktop.binding.policyRevision = 6;
			},
		],
		[
			'actor',
			(h: ReturnType<typeof nativeHarness>) => {
				h.source.desktop.binding.principal.id = '22222222-2222-4222-8222-222222222222';
			},
		],
		[
			'epoch',
			(h: ReturnType<typeof nativeHarness>) => {
				h.source.desktop.binding.processEpoch = 'other';
			},
		],
		[
			'expiry',
			(h: ReturnType<typeof nativeHarness>) => {
				h.clock.now += 60_000;
			},
		],
		[
			'future issue',
			(h: ReturnType<typeof nativeHarness>) => {
				h.source.desktop.issuedAt = new Date(now + 1_000).toISOString();
			},
		],
		[
			'settings',
			(h: ReturnType<typeof nativeHarness>) => {
				h.source.settings.policyRevision = 6;
			},
		],
		[
			'ceiling',
			(h: ReturnType<typeof nativeHarness>) => {
				h.source.ceilings.browser.policyRevision = 6;
			},
		],
		[
			'malformed ceiling',
			(h: ReturnType<typeof nativeHarness>) => {
				Object.assign(h.source.ceilings.egress, { extra: true });
			},
		],
		[
			'missing ceiling',
			(h: ReturnType<typeof nativeHarness>) => {
				Reflect.deleteProperty(h.source.ceilings, 'shell');
			},
		],
		[
			'route',
			(h: ReturnType<typeof nativeHarness>) => {
				h.source.routes[0].baseUrl = 'https://user:secret@example.test';
			},
		],
		[
			'duplicate route',
			(h: ReturnType<typeof nativeHarness>) => {
				h.source.routes.push(h.source.routes[0]);
			},
		],
	])('rejects %s without replacing the previous batch', async (_name, corrupt) => {
		const h = nativeHarness();
		expect((await h.service.refreshProjection()).installed).toBe(true);
		const before = h.service.installedProjection();
		corrupt(h);
		expect((await h.service.refreshProjection()).installed).toBe(false);
		expect(h.service.installedProjection()).toEqual(before);
	});

	it('keeps prior restrictions after signature failure and refuses absent authenticated authority', async () => {
		const h = nativeHarness();
		await h.service.refreshProjection();
		h.read.mockRejectedValueOnce(new Error('signature rejected: secret-canary'));
		expect(await h.service.refreshProjection()).toEqual({
			installed: false,
			reason: 'unavailable',
		});
		expect(h.service.installedProjection()).toEqual(h.source);
		h.record.registration!.actorId = null;
		expect((await h.service.refreshProjection()).installed).toBe(false);
		expect(h.service.installedProjection()).toBeNull();
		expect(h.read).toHaveBeenCalledTimes(2);
	});

	it('rejects same-revision replacement and rollback but accepts renewed and newer applied policy', async () => {
		const h = nativeHarness();
		await h.service.refreshProjection();
		h.source.desktop.issuedAt = new Date(now).toISOString();
		expect((await h.service.refreshProjection()).installed).toBe(true);
		h.source.settings.locks = [];
		expect((await h.service.refreshProjection()).installed).toBe(false);
		h.source.desktop.binding.policyRevision = h.source.settings.policyRevision = 8;
		Object.values(h.source.ceilings).forEach((ceiling) => {
			ceiling.policyRevision = 8;
		});
		h.record.policy.appliedRevision = h.standing.endpoint!.appliedPolicyRevision = 8;
		expect((await h.service.refreshProjection()).installed).toBe(true);
		h.source.desktop.binding.policyRevision = h.source.settings.policyRevision = 7;
		Object.values(h.source.ceilings).forEach((ceiling) => {
			ceiling.policyRevision = 7;
		});
		h.record.policy.appliedRevision = h.standing.endpoint!.appliedPolicyRevision = 7;
		expect((await h.service.refreshProjection()).installed).toBe(false);
		expect(h.service.installedProjection()!.desktop.binding.policyRevision).toBe(8);
	});

	it.each(['connection', 'trust', 'tenant', 'registration', 'producer'] as const)(
		'rejects a pending delivery across a %s change',
		async (change) => {
			const h = nativeHarness();
			let deliver!: (value: unknown) => void;
			h.read.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						deliver = resolve;
					})
			);
			const pending = h.service.refreshProjection();
			if (change === 'connection') h.standing.connection!.connection++;
			if (change === 'trust') h.record.endpoint.trustRootDigest = 'c'.repeat(64);
			if (change === 'tenant') h.record.tenantId = 'other';
			if (change === 'registration') h.record.registration!.challengeId = 'other';
			if (change === 'producer') h.disconnect();
			deliver(h.source);
			expect(await pending).toEqual({ installed: false, reason: 'changed' });
			expect(h.service.installedProjection()).toBeNull();
		}
	);

	it('fences superseded reads and refreshes projections through the existing refresh path', async () => {
		const h = nativeHarness();
		let deliver!: (value: unknown) => void;
		h.read.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					deliver = resolve;
				})
		);
		const first = h.service.refreshProjection();
		await h.service.refresh();
		deliver(h.source);
		expect(await first).toEqual({ installed: false, reason: 'changed' });
		expect(h.service.installedProjection()).toEqual(h.source);
	});

	it('preserves field states, reference relationships and operation choices without granting authority', () => {
		const source = projection();
		const view = mapDesktopPolicy({ outcome: 'available', projection: source }, options());
		expect(view.outcome).toBe('available');
		if (view.outcome !== 'available') throw new Error('expected mapping');
		expect(view.authority).toBe('none');
		expect(view.projection).toEqual(source);
		expect(view.fields.provider).toMatchObject({
			editable: false,
			minimum: 1,
			maximum: 1,
			host: { field: 'provider' },
		});
		expect(view.fields.model).toMatchObject({
			editable: true,
			minimum: 1,
			maximum: 1,
			host: { field: 'model' },
		});
		expect(view.fields.model.choices).toEqual([
			{ kind: 'model', ref: 'model-1', providerRef: 'provider-1' },
		]);
		expect(view.fields.workspace).toMatchObject({
			editable: true,
			minimum: 0,
			maximum: 1,
			host: { field: 'cwd' },
		});
		expect(view.fields.account.host).toEqual({ kind: 'credential-binding', field: 'accountRef' });
		expect(view.fields.credential.host).toEqual({ kind: 'credential-reference', field: 'refId' });
		expect(view.fields.credential.choices).toEqual([
			{ kind: 'credential', ref: 'credential-1', accountRef: 'account-1' },
		]);
		for (const kind of ['tool', 'automation'] as const) {
			expect(view.fields[kind]).toMatchObject({
				editable: false,
				host: { kind: 'unavailable', reason: 'mapping_unavailable' },
			});
			expect(view.fields[kind].policy).toEqual(source.fields[kind]);
		}
		expect(view.personalSettingKeys).toContain('fontSize');
		expect(view.personalSettingKeys.some(isSettingLockable)).toBe(false);
		expect(view.settings).toEqual(settings);
	});

	it('keeps central settings locks alongside constrained choices and personal preferences', () => {
		const locks = {
			'agentConfig.model': { code: 'locked' as const, pinned: false, message: 'held' },
		};
		const view = mapDesktopPolicy(
			{ outcome: 'available', projection: projection() },
			{ ...options(), settings: { policyRevision: 7, locks } }
		);
		expect(view).toMatchObject({
			fields: {
				model: {
					editable: false,
					localLock: locks['agentConfig.model'],
					policy: { state: 'constrained' },
				},
			},
			settings: { locks },
		});
	});

	it.each([
		'tenantId',
		'orgId',
		'principal',
		'enrollmentId',
		'installationId',
		'runtimeId',
		'processEpoch',
		'policyId',
		'policyRevision',
		'policyDigest',
	] as const)('rejects a different %s binding', (key) => {
		const other = {
			...binding,
			[key]:
				key === 'principal'
					? { ...binding.principal, kind: 'service' }
					: key === 'policyRevision'
						? 8
						: 'different',
		};
		expect(
			mapDesktopPolicy(
				{ outcome: 'available', projection: projection() },
				{ ...options(), binding: other as DesktopPolicyBinding }
			)
		).toEqual({ outcome: 'denied', reason: 'binding_mismatch' });
	});

	it.each([now - 2_000, now + 60_000, NaN, Infinity])(
		'rejects an invalid or stale observation time %s',
		(time) => {
			expect(
				mapDesktopPolicy(
					{ outcome: 'available', projection: projection() },
					{ ...options(), now: time }
				)
			).toEqual({ outcome: 'unavailable', reason: 'policy_expired' });
		}
	);

	it.each([null, 6, 8])('requires a matching settings revision (%s)', (policyRevision) => {
		expect(
			mapDesktopPolicy(
				{ outcome: 'available', projection: projection() },
				{ ...options(), settings: { policyRevision, locks: {} } }
			)
		).toEqual({ outcome: 'unavailable', reason: 'mapping_unavailable' });
	});

	it.each([
		{ outcome: 'denied', reason: 'unauthenticated' },
		{ outcome: 'denied', reason: 'policy_denied' },
		{ outcome: 'denied', reason: 'unsupported_version' },
		{ outcome: 'unavailable', reason: 'runtime_unavailable' },
		{ outcome: 'unavailable', reason: 'mapping_unavailable' },
	])('preserves refusal $reason without choices', (result) => {
		expect(mapDesktopPolicy(result, options())).toEqual(result);
	});

	it('refuses absent ports and bindings, suppressing secret-bearing schema failures', () => {
		const raw = { outcome: 'available', projection: projection() };
		expect(mapDesktopPolicy(raw, { ...options(), binding: null })).toEqual({
			outcome: 'denied',
			reason: 'unauthenticated',
		});
		const unavailable = { outcome: 'unavailable', reason: 'mapping_unavailable' };
		expect(mapDesktopPolicy(raw, { ...options(), schema: null })).toEqual(unavailable);
		expect(
			mapDesktopPolicy(raw, {
				...options(),
				schema: {
					safeParse: () => {
						throw new Error('secret-canary');
					},
				},
			})
		).toEqual(unavailable);
	});

	it.each([
		{ schemaVersion: 2 },
		{ actorId: 'forged-authority' },
		{ operations: ['execute'] },
		{ choices: [{ kind: 'workspace', ref: '/secret-host-path' }] },
		{ fields: {} },
		{ fields: { ...projection().fields, model: { state: 'user_editable', allowed: ['absent'] } } },
		{
			fields: {
				...projection().fields,
				model: { state: 'constrained', allowed: ['model-1'], minimum: 2, maximum: 1 },
			},
		},
	])('uses the strict public schema for invalid input %#', (patch) => {
		expect(
			mapDesktopPolicy(
				{ outcome: 'available', projection: { ...projection(), ...patch } },
				options()
			)
		).toEqual({ outcome: 'unavailable', reason: 'mapping_unavailable' });
	});

	it.each([
		['duplicate operation', { operations: ['create', 'create'] }],
		['duplicate choice', { choices: [...projection().choices, projection().choices[0]] }],
		[
			'unknown provider',
			{
				choices: projection().choices.map((choice) =>
					choice.kind === 'model' ? { ...choice, providerRef: 'absent' } : choice
				),
			},
		],
		[
			'unknown account',
			{
				choices: projection().choices.map((choice) =>
					choice.kind === 'credential' ? { ...choice, accountRef: 'absent' } : choice
				),
			},
		],
		[
			'cross-kind reference',
			{
				fields: {
					...projection().fields,
					workspace: { state: 'user_editable', allowed: ['provider-1'] },
				},
			},
		],
		[
			'duplicate selection',
			{
				fields: {
					...projection().fields,
					credential: { state: 'locked', values: ['credential-1', 'credential-1'] },
				},
			},
		],
		[
			'multiple single selections',
			{
				fields: {
					...projection().fields,
					model: { state: 'locked', values: ['model-1', 'model-2'] },
				},
			},
		],
		['unbounded lifetime', { expiresAt: new Date(now + 300_000).toISOString() }],
		['zero lifetime', { expiresAt: new Date(now - 1_000).toISOString() }],
		[
			'credential value',
			{
				choices: projection().choices.map((choice) =>
					choice.kind === 'credential' ? { ...choice, secret: 'credential-secret-canary' } : choice
				),
			},
		],
		[
			'workspace path',
			{
				choices: projection().choices.map((choice) =>
					choice.kind === 'workspace' ? { ...choice, path: '/private/path-canary' } : choice
				),
			},
		],
	])('rejects public projection fault: %s', (_name, patch) => {
		const raw = { outcome: 'available', projection: { ...projection(), ...patch } };
		const before = structuredClone(raw);
		expect(schema.safeParse(raw).success).toBe(false);
		expect(mapDesktopPolicy(raw, options())).toEqual({
			outcome: 'unavailable',
			reason: 'mapping_unavailable',
		});
		expect(raw).toEqual(before);
	});

	it('rechecks the current user and freshness when a previously usable projection is replayed', () => {
		const raw = { outcome: 'available', projection: projection() };
		expect(mapDesktopPolicy(raw, options()).outcome).toBe('available');
		const otherUser = {
			...binding,
			principal: {
				...binding.principal,
				id: '22222222-2222-4222-8222-222222222222',
			},
		};
		expect(mapDesktopPolicy(raw, { ...options(), binding: otherUser })).toEqual({
			outcome: 'denied',
			reason: 'binding_mismatch',
		});
		expect(mapDesktopPolicy(raw, { ...options(), now: now + 60_000 })).toEqual({
			outcome: 'unavailable',
			reason: 'policy_expired',
		});
	});

	it.each([
		{ outcome: 'denied', reason: 'policy_denied' },
		{ outcome: 'unavailable', reason: 'mapping_unavailable' },
	])('refuses choices smuggled alongside $outcome without leaking them', (refusal) => {
		const raw = { ...refusal, projection: projection(), secret: 'response-secret-canary' };
		expect(schema.safeParse(raw).success).toBe(false);
		expect(mapDesktopPolicy(raw, options())).toEqual({
			outcome: 'unavailable',
			reason: 'mapping_unavailable',
		});
	});
});
