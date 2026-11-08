import { beforeAll, describe, expect, it } from 'vitest';
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
});
