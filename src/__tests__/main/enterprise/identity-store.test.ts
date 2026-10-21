/**
 * Custody of the enterprise identity record, with the seal and the anchor
 * injected. What is defended: the record persists only under protected
 * custody; an unprotected store (no encryption, the obscuring key, Linux
 * basic_text, no anchor, a seal that will not say who holds its key) never
 * writes and never clears; a rolled-back, foreign, edited, oversized or
 * malformed file is untrusted and kept until acknowledged; no device key or
 * approval nonce is ever in the file; and the enterprise custody shares
 * nothing with Lite pairing or the other sealed stores.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
	createEnterpriseIdentityStore,
	ENTERPRISE_IDENTITY_ANCHOR_SERVICE,
	ENTERPRISE_IDENTITY_FILE_NAME,
	enterpriseIdentityProblems,
	publicEnterpriseIdentity,
	type EnterpriseIdentityStore,
	type IdentityWriteInput,
} from '../../../main/enterprise/identity-store';
import { COT_STATE_ANCHOR_SERVICE } from '../../../main/cot-export/config-store';
import { anchorAccountForDirectory, type Anchor } from '../../../main/utils/keyring-anchor';
import { obscuringSeal, sealProtectionProblem } from '../../../main/utils/safe-storage-seal';
import { fakeAnchor, fakeSeal } from './fakeCustody';

const NOW = Date.parse('2026-10-21T12:00:00Z');

function input(extra: Partial<IdentityWriteInput> = {}): IdentityWriteInput {
	return {
		installationId: 'inst-1',
		tenantId: 'tenant-1',
		orgId: 'org-1',
		enrollmentId: 'enr-1',
		endpoint: {
			socketPath: '/run/endpoint/runtime.sock',
			bindingDigest: 'a'.repeat(64),
			trustRootDigest: null,
		},
		management: 'enrolled',
		registration: null,
		policy: { desiredRevision: 3, appliedRevision: 3, observedAt: new Date(NOW).toISOString() },
		enrolledAt: new Date(NOW).toISOString(),
		...extra,
	};
}

describe('enterprise identity store', () => {
	let dir: string;
	let file: string;
	let holder: { value: Anchor | null };

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-store-'));
		file = path.join(dir, ENTERPRISE_IDENTITY_FILE_NAME);
		holder = { value: null };
	});
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	function store(
		overrides: Partial<Parameters<typeof createEnterpriseIdentityStore>[0]> = {}
	): EnterpriseIdentityStore {
		return createEnterpriseIdentityStore({
			file,
			seal: fakeSeal(),
			anchor: fakeAnchor(holder),
			platform: 'darwin',
			now: () => NOW,
			newSecret: () => 'install-secret-1',
			...overrides,
		});
	}

	it('writes a sealed, anchored record at epoch 0 and bumps the epoch on every write', async () => {
		const s = store();
		expect(s.custody()).toEqual({ state: 'protected' });
		expect(s.read()).toEqual({ status: 'none' });
		const record = await s.write(input());
		expect(record).toMatchObject({ version: 1, updatedAt: new Date(NOW).toISOString() });
		expect(holder.value).toEqual({ installSecret: 'install-secret-1', epoch: 0 });
		expect(s.read()).toMatchObject({ status: 'ok', epoch: 0, record: { tenantId: 'tenant-1' } });
		await s.write(input({ management: 'suspended' }));
		expect(holder.value).toEqual({ installSecret: 'install-secret-1', epoch: 1 });
		expect(s.read()).toMatchObject({ status: 'ok', epoch: 1, record: { management: 'suspended' } });
		expect((fs.statSync(file).mode & 0o777).toString(8)).toBe('600');
		// The injected seal is a reversible marker; what the real seal hides is
		// proven by the obscuring-seal suite. Here: the bytes went through the seal.
		expect(fs.readFileSync(file, 'utf8').startsWith('SEALED')).toBe(true);
	});

	it('refuses a record for another installation and a malformed record, writing nothing', async () => {
		const s = store();
		await s.write(input());
		await expect(s.write(input({ installationId: 'inst-2' }))).rejects.toThrow(
			/enrolls installation inst-1/
		);
		await expect(
			s.write(
				input({ endpoint: { socketPath: 'relative', bindingDigest: 'x', trustRootDigest: null } })
			)
		).rejects.toThrow(/malformed/);
		expect(holder.value?.epoch).toBe(0);
		expect(
			enterpriseIdentityProblems({ ...input(), version: 1, updatedAt: 'now', management: 'lost' })
		).toContain('management is not a management state');
	});

	it('keeps a rolled-back file as untrusted until the installation acknowledges it', async () => {
		const s = store();
		await s.write(input());
		const older = fs.readFileSync(file);
		await s.write(input({ management: 'revoked' }));
		fs.writeFileSync(file, older);
		expect(s.read()).toMatchObject({ status: 'untrusted', reason: 'rollback' });
		await expect(s.write(input())).rejects.toThrow(/untrusted record \(rollback\)/);
		expect(await s.clear({ installationId: 'inst-1' })).toMatchObject({
			ok: false,
			reason: 'untrusted',
		});
		expect(fs.existsSync(file)).toBe(true);
		expect(await s.clear({ installationId: 'inst-1', acknowledgeUntrusted: true })).toEqual({
			ok: true,
			removed: true,
		});
		expect(fs.existsSync(file)).toBe(false);
		expect(holder.value).toBeNull();
		expect(s.read()).toEqual({ status: 'none' });
	});

	it('calls a foreign, edited, oversized, malformed or unanchored file untrusted and names which', async () => {
		const s = store();
		await s.write(input());
		const sealed = fs.readFileSync(file);

		holder.value = { installSecret: 'another-install', epoch: 0 };
		expect(s.read()).toMatchObject({ status: 'untrusted', reason: 'foreign' });
		holder.value = { installSecret: 'install-secret-1', epoch: 0 };

		const touched = Buffer.from(sealed);
		touched[touched.length - 3] ^= 0x01;
		fs.writeFileSync(file, touched);
		expect(s.read()).toMatchObject({ status: 'untrusted', reason: 'unsealable' });

		fs.writeFileSync(
			file,
			fakeSeal().seal(
				JSON.stringify({ version: 1, installSecret: 'install-secret-1', epoch: 0, record: {} })
			)
		);
		expect(s.read()).toMatchObject({ status: 'untrusted', reason: 'malformed' });

		fs.writeFileSync(file, fakeSeal().seal('x'.repeat(70 * 1024)));
		expect(s.read()).toMatchObject({ status: 'untrusted', reason: 'malformed' });

		fs.writeFileSync(file, sealed);
		holder.value = null;
		expect(s.read()).toMatchObject({ status: 'untrusted', reason: 'anchor-missing' });
		// Another machine's key: the bytes do not open here.
		expect(
			store({
				seal: fakeSeal({ mark: 'OTHER\u0000' }),
				anchor: fakeAnchor({ value: { installSecret: 'install-secret-1', epoch: 0 } }),
			}).read()
		).toMatchObject({
			status: 'untrusted',
			reason: 'unsealable',
		});
	});

	it('refuses persistent custody without encryption, under basic_text, with the obscuring key, or with no anchor', async () => {
		const cases: Array<[string, EnterpriseIdentityStore, string]> = [
			['no encryption', store({ seal: fakeSeal({ available: false }) }), 'encryption-unavailable'],
			[
				'basic_text on linux',
				store({
					seal: fakeSeal({ custody: { kind: 'os-keystore', backend: 'basic_text' } }),
					platform: 'linux',
				}),
				'seal-not-protected',
			],
			['obscuring seal', store({ seal: obscuringSeal() }), 'seal-not-protected'],
			['custody unknown', store({ seal: fakeSeal({ custody: null }) }), 'seal-not-protected'],
			[
				'no anchor',
				store({ anchor: fakeAnchor(holder, { available: false }) }),
				'anchor-unavailable',
			],
		];
		for (const [name, s, reason] of cases) {
			expect(s.custody(), name).toMatchObject({ state: 'unprotected', reason });
			expect(s.read(), name).toMatchObject({ status: 'unprotected', reason, fileExists: false });
			await expect(s.write(input()), name).rejects.toThrow(/cannot be kept/);
			expect(fs.existsSync(file), name).toBe(false);
		}
		// basic_text is a Linux refusal only; the same backend string elsewhere is the OS store.
		expect(
			store({
				seal: fakeSeal({ custody: { kind: 'os-keystore', backend: 'basic_text' } }),
				platform: 'darwin',
			}).custody()
		).toEqual({ state: 'protected' });

		// A file an earlier protected run wrote is reported, never read, never cleared.
		await store().write(input());
		const later = store({ seal: fakeSeal({ available: false }) });
		expect(later.read()).toMatchObject({ status: 'unprotected', fileExists: true });
		expect(
			await later.clear({ installationId: 'inst-1', acknowledgeUntrusted: true })
		).toMatchObject({ ok: false, reason: 'unprotected' });
		expect(fs.existsSync(file)).toBe(true);
	});

	it('a locked credential store refuses the write before any file exists', async () => {
		const s = store({ anchor: fakeAnchor(holder, { writeThrows: true }) });
		await expect(s.write(input())).rejects.toThrow('credential store is locked');
		expect(fs.existsSync(file)).toBe(false);
		expect(s.read()).toEqual({ status: 'none' });
	});

	it('clear names the installation and serializes with writes', async () => {
		const s = store();
		await s.write(input());
		expect(await s.clear({ installationId: 'someone-else' })).toMatchObject({
			ok: false,
			reason: 'installation-mismatch',
		});
		const order: string[] = [];
		await Promise.all([
			s.exclusive(async () => {
				await new Promise((resolve) => setTimeout(resolve, 20));
				order.push('first');
			}),
			s.write(input({ management: 'suspended' })).then(() => order.push('write')),
			s.clear({ installationId: 'inst-1' }).then(() => order.push('clear')),
		]);
		expect(order).toEqual(['first', 'write', 'clear']);
		expect(s.read()).toEqual({ status: 'none' });
		expect(await s.clear({ installationId: 'inst-1' })).toEqual({ ok: true, removed: false });
	});

	it('keeps no device key and no approval nonce, and projects the same public view everywhere', async () => {
		const s = store();
		await s.write(
			input({
				registration: {
					challengeId: 'c1',
					actorId: null,
					runtimeId: 'desktop-1',
					processEpoch: 'e1',
					bindingDigest: 'a'.repeat(64),
					processBirthDigest: null,
					challengeDigest: 'c'.repeat(64),
					expiresAt: new Date(NOW + 60_000).toISOString(),
					registeredAt: new Date(NOW).toISOString(),
				},
			})
		);
		const text = fakeSeal().unseal(fs.readFileSync(file));
		expect(text).not.toMatch(/privateKey|PRIVATE KEY|nonce|keyPossessionProof|invitation/);
		const view = publicEnterpriseIdentity(s.read());
		expect(view).toMatchObject({
			status: 'ok',
			reason: null,
			message: null,
			record: { registration: { challengeId: 'c1' } },
		});
		expect(JSON.stringify(view)).not.toContain('install-secret-1');
		expect(
			publicEnterpriseIdentity({ status: 'untrusted', reason: 'rollback', message: 'older copy' })
		).toEqual({
			status: 'untrusted',
			reason: 'rollback',
			message: 'older copy',
			record: null,
		});
	});

	it('shares nothing with Lite pairing, the plugin ledger or the CoT export store', () => {
		expect(ENTERPRISE_IDENTITY_FILE_NAME).not.toBe('lite-device-credentials.json');
		expect(ENTERPRISE_IDENTITY_FILE_NAME).not.toBe('plugin-authorization.bin');
		expect(ENTERPRISE_IDENTITY_ANCHOR_SERVICE).not.toBe('com.maestro.plugin-authorization');
		expect(ENTERPRISE_IDENTITY_ANCHOR_SERVICE).not.toBe(COT_STATE_ANCHOR_SERVICE);
		expect(anchorAccountForDirectory('enterprise-identity', dir)).toMatch(
			/^enterprise-identity:[a-f0-9]{16}$/
		);
		expect(anchorAccountForDirectory('enterprise-identity', dir)).not.toBe(
			anchorAccountForDirectory('state', dir)
		);
		// The fallback the CoT export store accepts is refused here.
		expect(sealProtectionProblem(obscuringSeal())).toMatch(/obscuring/);
	});
});
