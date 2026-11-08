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
import {
	createSettingsPolicySource,
	restoreManagedSettingPins,
} from '../../../../main/enterprise/settings-policy';

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
		const settings = createSettingsPolicySource({
			identity: { read: () => standing.identity },
			policy: () => service.status(),
			verified: service.settings,
		});
		return {
			service,
			settings,
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

	it('exposes bounded opaque options and explicit execution modes without authority', async () => {
		const h = nativeHarness();
		h.source.executionChoices = [
			{ providerRef: 'provider-1', permissions: ['standard'], transports: ['transport-1'] },
		];
		await h.service.refreshProjection();
		const view = h.service.agentOptions(settings);
		expect(view).toMatchObject({
			outcome: 'available',
			authority: 'none',
			policyRevision: 7,
			freshness: 'fresh',
			fields: {
				provider: { editable: false, lockedReason: 'This choice is fixed by policy.' },
				model: {
					editable: true,
					choices: [{ kind: 'model', ref: 'model-1', providerRef: 'provider-1' }],
				},
				workspace: { editable: true, choices: [{ kind: 'workspace', ref: 'workspace-1' }] },
				credential: {
					choices: [{ kind: 'credential', ref: 'credential-1', accountRef: 'account-1' }],
				},
				permission: {
					choices: [{ kind: 'permission', ref: 'standard', providerRef: 'provider-1' }],
				},
				transport: {
					choices: [{ kind: 'transport', ref: 'transport-1', providerRef: 'provider-1' }],
				},
			},
		});
		expect(JSON.stringify(view)).not.toMatch(
			/sonnet|claude-code|accountDir|baseUrl|policyDigest|tenantId/
		);
		if (view.outcome !== 'available') throw new Error('expected options');
		expect(Date.parse(view.expiresAt)).toBe(now + 60_000);
		(view.fields.permission.choices as unknown[]).length = 0;
		expect(h.service.agentOptions(settings)).not.toEqual(view);
		const held = h.service.agentOptions({
			...settings,
			locks: { 'agentConfig.model': { code: 'locked', pinned: false, message: 'Model held' } },
		});
		expect(held).toMatchObject({
			fields: { model: { editable: false, lockedReason: 'Model held' } },
		});
	});

	it('leaves absent execution mappings unavailable and filters disallowed parent references', async () => {
		const h = nativeHarness();
		h.source.desktop.fields.provider = { state: 'user_editable', allowed: [] };
		await h.service.refreshProjection();
		expect(h.service.agentOptions(settings)).toMatchObject({
			fields: {
				model: { editable: false, choices: [] },
				account: { choices: [] },
				credential: { choices: [] },
				permission: {
					editable: false,
					choices: [],
					lockedReason: 'No verified execution choices are available.',
				},
				transport: { editable: false, choices: [] },
			},
		});
	});

	it.each([
		'offline',
		'actor',
		'trust',
		'runtime',
		'epoch',
		'revision',
		'registration expiry',
		'projection expiry',
		'stale observation',
		'settings revision',
	])('withdraws options after %s without clearing installed restrictions', async (change) => {
		const h = nativeHarness();
		await h.service.refreshProjection();
		if (change === 'offline') h.disconnect();
		if (change === 'actor') h.record.registration!.actorId = 'another-actor';
		if (change === 'trust') h.record.endpoint.trustRootDigest = 'c'.repeat(64);
		if (change === 'runtime') h.record.registration!.runtimeId = 'another-runtime';
		if (change === 'epoch') h.record.registration!.processEpoch = 'another-epoch';
		if (change === 'revision')
			h.record.policy.appliedRevision = h.standing.endpoint!.appliedPolicyRevision = 8;
		if (change === 'registration expiry')
			h.record.registration!.expiresAt = new Date(now).toISOString();
		if (change === 'projection expiry') h.clock.now += 60_000;
		if (change === 'stale observation')
			h.record.policy.observedAt = new Date(now - 3_600_000).toISOString();
		expect(
			h.service.agentOptions(
				change === 'settings revision' ? { ...settings, policyRevision: 8 } : settings
			)
		).toMatchObject({ outcome: 'unavailable', authority: 'none' });
		if (change !== 'settings revision')
			expect(h.service.agentOptions(settings)).not.toHaveProperty('fields');
		if (change === 'offline')
			expect(h.service.installedProjection()!.settings.locks).toHaveLength(1);
	});

	it.each(
		[
			[{ providerRef: 'unknown', permissions: ['standard'], transports: [] }],
			[{ providerRef: 'provider-1', permissions: ['yolo'], transports: [] }],
			[{ providerRef: 'provider-1', permissions: ['standard', 'standard'], transports: [] }],
			[{ providerRef: 'provider-1', permissions: [], transports: ['https://secret.example'] }],
			[
				{
					providerRef: 'provider-1',
					permissions: [],
					transports: ['transport-1'],
					secret: 'canary',
				},
			],
		].map((catalog) => [catalog])
	)('rejects malformed execution catalog %j atomically', async (executionChoices) => {
		const h = nativeHarness();
		await h.service.refreshProjection();
		const before = h.service.installedProjection();
		Object.assign(h.source, { executionChoices });
		expect(await h.service.refreshProjection()).toEqual({ installed: false, reason: 'invalid' });
		expect(h.service.installedProjection()).toEqual(before);
	});

	it('replaces displayed choices only after the new applied revision is verified', async () => {
		const h = nativeHarness();
		h.source.executionChoices = [
			{ providerRef: 'provider-1', permissions: ['standard'], transports: ['transport-1'] },
		];
		expect((await h.service.refreshProjection()).installed).toBe(true);
		const displayed = h.service.agentOptions(settings);
		if (displayed.outcome !== 'available') throw new Error('expected choices');
		expect(displayed.fields.model.choices.map(({ ref }) => ref)).toEqual(['model-1']);
		expect(displayed.fields.workspace.choices.map(({ ref }) => ref)).toEqual(['workspace-1']);
		expect(displayed.fields.credential.choices.map(({ ref }) => ref)).toEqual(['credential-1']);

		h.record.policy.appliedRevision = h.standing.endpoint!.appliedPolicyRevision = 8;
		const currentSettings = { ...settings, policyRevision: 8 };
		expect(h.service.agentOptions(currentSettings)).toMatchObject({ outcome: 'unavailable' });
		// A caller retaining the old settings/choice view cannot restore its freshness.
		expect(h.service.agentOptions(settings)).not.toHaveProperty('fields');
		expect((await h.service.refreshProjection()).installed).toBe(false);

		h.source.desktop.binding.policyRevision = h.source.settings.policyRevision = 8;
		h.source.desktop.binding.policyDigest = 'd'.repeat(64);
		Object.values(h.source.ceilings).forEach((ceiling) => {
			ceiling.policyRevision = 8;
		});
		h.source.desktop.choices = [
			...h.source.desktop.choices,
			{ kind: 'workspace', ref: 'workspace-2' },
			{ kind: 'credential', ref: 'credential-2', accountRef: 'account-1' },
		];
		for (const kind of ['model', 'workspace', 'credential'] as const) {
			h.source.desktop.fields[kind] = {
				state: 'constrained',
				allowed: [`${kind}-2`],
				minimum: 1,
				maximum: 1,
			};
		}
		h.source.executionChoices = [
			{ providerRef: 'provider-1', permissions: ['readonly'], transports: ['transport-2'] },
		];
		expect(await h.service.refreshProjection()).toEqual({ installed: true, policyRevision: 8 });
		const refreshed = h.service.agentOptions(currentSettings);
		if (refreshed.outcome !== 'available') throw new Error('expected refreshed choices');
		expect(refreshed).toMatchObject({ authority: 'none', policyRevision: 8, freshness: 'fresh' });
		for (const kind of ['model', 'workspace', 'credential'] as const) {
			expect(refreshed.fields[kind]).toMatchObject({ editable: true, minimum: 1, maximum: 1 });
			expect(refreshed.fields[kind].choices.map(({ ref }) => ref)).toEqual([`${kind}-2`]);
			expect(displayed.fields[kind].choices.map(({ ref }) => ref)).toEqual([`${kind}-1`]);
		}
		expect(refreshed.fields.permission.choices.map(({ ref }) => ref)).toEqual(['readonly']);
		expect(refreshed.fields.transport.choices.map(({ ref }) => ref)).toEqual(['transport-2']);
		expect(h.service.agentOptions(settings)).not.toHaveProperty('fields');
		// An editable display choice does not override the independently installed write lock.
		expect(h.settings.authorizeAgentConfig('claude-code', 'model', 'model-2')).toMatchObject({
			code: 'locked',
			policyRevision: 8,
		});
	});

	it.each(['revision', 'expiry'] as const)(
		'rechecks %s after a pending choice refresh without releasing installed restrictions',
		async (change) => {
			const h = nativeHarness();
			await h.service.refreshProjection();
			const before = h.service.installedProjection();
			let deliver!: (value: unknown) => void;
			h.read.mockImplementationOnce(() => new Promise((resolve) => (deliver = resolve)));
			const pending = h.service.refreshProjection();
			if (change === 'revision')
				h.record.policy.appliedRevision = h.standing.endpoint!.appliedPolicyRevision = 8;
			else h.clock.now += 60_000;
			deliver(h.source);
			expect(await pending).toEqual({
				installed: false,
				reason: change === 'revision' ? 'changed' : 'invalid',
			});
			expect(h.service.agentOptions(settings)).not.toHaveProperty('fields');
			expect(h.service.installedProjection()).toEqual(before);
			expect(h.settings.authorizeAgentConfig('claude-code', 'model', 'model-1').allowed).toBe(
				false
			);
		}
	);

	it('withholds credentials for a disallowed account while retaining approved model and workspace choices', async () => {
		const h = nativeHarness();
		h.source.desktop.fields.account = { state: 'user_editable', allowed: [] };
		await h.service.refreshProjection();
		const view = h.service.agentOptions(settings);
		if (view.outcome !== 'available') throw new Error('expected choices');
		expect(view.fields.account.choices).toEqual([]);
		expect(view.fields.credential).toMatchObject({ choices: [], editable: false });
		expect(view.fields.credential.lockedReason).toBeTruthy();
		expect(view.fields.model.choices.map(({ ref }) => ref)).toEqual(['model-1']);
		expect(view.fields.workspace.choices.map(({ ref }) => ref)).toEqual(['workspace-1']);
	});

	it('restores choices after reconnect and renewal while keeping offline restrictions', async () => {
		const h = nativeHarness();
		await h.service.refreshProjection();
		h.standing.connection!.closed = true;
		h.clock.now += 60_000;
		expect(h.service.agentOptions(settings)).not.toHaveProperty('fields');
		expect(h.settings.authorize('agentConfig.model')).toMatchObject({ code: 'locked' });
		h.standing.connection!.closed = false;
		expect(h.service.agentOptions(settings)).not.toHaveProperty('fields');
		h.source.desktop.issuedAt = new Date(h.clock.now).toISOString();
		h.source.desktop.expiresAt = new Date(h.clock.now + 60_000).toISOString();
		expect((await h.service.refreshProjection()).installed).toBe(true);
		expect(h.service.agentOptions(settings)).toMatchObject({
			outcome: 'available',
			authority: 'none',
			policyRevision: 7,
			expiresAt: h.source.desktop.expiresAt,
		});
		expect(h.settings.authorize('agentConfig.model')).toMatchObject({ code: 'locked' });
	});

	it('installs verified settings and restores pins before refresh returns, allowing unheld edits', async () => {
		const h = nativeHarness();
		h.source.settings.locks.push(
			{ key: 'ghPath', pin: { value: '/managed/gh' } },
			{ key: 'encore.plugins', pin: { value: false } }
		);
		const store = {
			store: { ghPath: '/user/gh', encoreFeatures: { plugins: true } },
			set: vi.fn(),
		};
		const restored = vi.fn(() => restoreManagedSettingPins(store, h.settings.pins()));
		const unsubscribe = h.settings.onChange(restored);
		expect(h.settings.authorize('shellEnvVars')).toMatchObject({ code: 'unavailable' });
		expect((await h.service.refreshProjection()).installed).toBe(true);
		expect(store.set).toHaveBeenCalledWith('ghPath', '/managed/gh');
		expect(store.set).toHaveBeenCalledWith('encoreFeatures', { plugins: false });
		expect(h.settings.authorize('shellEnvVars')).toEqual({ allowed: true });
		expect(h.settings.authorize('ghPath')).toMatchObject({ code: 'locked', policyRevision: 7 });
		expect(h.settings.authorizeAgentConfig('codex', 'model', 'allowed-model')).toMatchObject({
			code: 'locked',
		});
		expect(h.settings.authorizeAgentConfig('codex', 'reasoningEffort', 'high')).toEqual({
			allowed: true,
		});
		expect(h.settings.authorize('wakatimeApiKey')).toMatchObject({ code: 'custody' });
		unsubscribe();
		await h.service.refreshProjection();
		expect(restored).toHaveBeenCalledTimes(1);
	});

	it('keeps verified restrictions across failed refreshes and expiry offline', async () => {
		const h = nativeHarness();
		const heard = vi.fn();
		h.settings.onChange(heard);
		await h.service.refreshProjection();
		h.source.settings.locks = [];
		expect((await h.service.refreshProjection()).installed).toBe(false);
		expect(heard).toHaveBeenCalledTimes(1);
		h.disconnect();
		h.clock.now += 3_600_000;
		h.standing.connection!.closed = true;
		expect((await h.service.refreshProjection()).installed).toBe(false);
		expect(h.settings.authorize('agentConfig.model')).toMatchObject({ code: 'locked' });
		expect(h.settings.authorize('shellEnvVars')).toEqual({ allowed: true });
		expect(h.settings.pins()).toEqual({
			policyRevision: 7,
			locks: [{ key: 'agentConfig.model' }],
		});
	});

	it.each(['tenant', 'actor', 'trust', 'revision'] as const)(
		'holds writes immediately after a %s change without retaining an old settings cache',
		async (change) => {
			const h = nativeHarness();
			await h.service.refreshProjection();
			if (change === 'tenant') h.record.tenantId = 'other-tenant';
			if (change === 'actor') h.record.registration!.actorId = 'other-actor';
			if (change === 'trust') h.record.endpoint.trustRootDigest = 'c'.repeat(64);
			if (change === 'revision')
				h.record.policy.appliedRevision = h.standing.endpoint!.appliedPolicyRevision = 8;
			expect(h.settings.authorize('shellEnvVars')).toMatchObject({ code: 'unavailable' });
			expect(h.settings.authorize('agentConfig.model')).toMatchObject({ code: 'unavailable' });
			expect(h.settings.pins()).toBeNull();
		}
	);

	it('does not let raw installs, clears or mutated reads replace verified settings', async () => {
		const h = nativeHarness();
		await h.service.refreshProjection();
		expect(h.settings.install({ policyRevision: 7, locks: [] }).installed).toBe(false);
		h.settings.clear();
		h.service.settings.read()!.locks.length = 0;
		h.settings.installed()!.locks.length = 0;
		h.settings.pins()!.locks.length = 0;
		expect(h.settings.authorize('agentConfig.model')).toMatchObject({ code: 'locked' });
	});

	it('runs every restorer and reports a sink failure without hiding the installed restrictions', async () => {
		const h = nativeHarness();
		h.settings.onChange(() => {
			throw new Error('test store failure');
		});
		const next = vi.fn();
		h.settings.onChange(next);
		await expect(h.service.refreshProjection()).rejects.toThrow('test store failure');
		expect(next).toHaveBeenCalledOnce();
		expect(h.settings.authorize('agentConfig.model')).toMatchObject({ code: 'locked' });
	});

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
		expect(h.settings.authorize('agentConfig.model')).toEqual({ allowed: true });
		h.source.desktop.binding.policyRevision = h.source.settings.policyRevision = 7;
		Object.values(h.source.ceilings).forEach((ceiling) => {
			ceiling.policyRevision = 7;
		});
		h.record.policy.appliedRevision = h.standing.endpoint!.appliedPolicyRevision = 7;
		expect((await h.service.refreshProjection()).installed).toBe(false);
		expect(h.service.installedProjection()!.desktop.binding.policyRevision).toBe(8);
		expect(h.settings.authorize('agentConfig.model')).toMatchObject({ code: 'unavailable' });
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
