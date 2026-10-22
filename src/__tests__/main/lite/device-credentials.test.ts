import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rename } from 'node:fs/promises';
const protection = vi.hoisted(() => ({ available: true }));
vi.mock('electron', async () => {
	const { createCipheriv, createDecipheriv } = await import('node:crypto');
	const key = Buffer.alloc(32, 7),
		iv = Buffer.alloc(12, 8);
	return {
		safeStorage: {
			isEncryptionAvailable: () => protection.available,
			getSelectedStorageBackend: () => 'secret_service',
			encryptString: (text: string) => {
				const c = createCipheriv('aes-256-gcm', key, iv);
				const body = Buffer.concat([c.update(text, 'utf8'), c.final()]);
				return Buffer.concat([c.getAuthTag(), body]);
			},
			decryptString: (bytes: Buffer) => {
				const d = createDecipheriv('aes-256-gcm', key, iv);
				d.setAuthTag(bytes.subarray(0, 16));
				return Buffer.concat([d.update(bytes.subarray(16)), d.final()]).toString('utf8');
			},
		},
	};
});
vi.mock('node:fs/promises', async (original) => {
	const fs = await original<typeof import('node:fs/promises')>();
	return { ...fs, rename: vi.fn(fs.rename) };
});
import { DeviceCredentials } from '../../../main/lite/device-credentials';
import { PairedDevices, type PairedDevice } from '../../../main/lite/pairing/paired-devices';
import {
	LITE_DEVICE_CREDENTIALS_FILE_NAME,
	LITE_PAIRED_DEVICES_FILE_NAME,
	isLitePairingStoreFile,
	litePairingDeviceId,
} from '../../../shared/litePairingCredential';
import {
	createProcessSpawnAuthority,
	pairedDeviceActorProblems,
	spawnDelegationChain,
} from '../../../main/enterprise/spawn-authority';
import type { IdentityRead } from '../../../main/enterprise/identity-store';
import {
	PAIRED_DEVICE_USER_ID_PREFIX,
	PAIRED_DEVICE_USERNAME,
	resolveTransportAdmission,
	sameSpawnActor,
	transportSpawnActor,
} from '../../../main/web-server/auth/transport-actor';
import { redactSecrets } from '../../../shared/redactSecrets';
import { fakeSpawnPort } from '../../helpers/managedSpawnPort';
let directory: string;
const origin = 'https://aster.synthetic.ts.net',
	first = 'A'.repeat(43) + '.' + 'B'.repeat(43),
	second = 'C'.repeat(43) + '.' + 'D'.repeat(43);
beforeEach(() => {
	directory = mkdtempSync(path.join(tmpdir(), 'lite-credential-'));
	protection.available = true;
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));
describe('OS-protected paired device persistence', () => {
	it('does not roll back a newer successful save when an earlier concurrent write fails', async () => {
		const store = new DeviceCredentials(directory);
		await store.get('aster-id', origin);
		vi.mocked(rename).mockRejectedValueOnce(new Error('Synthetic disk failure'));
		const results = await Promise.allSettled([
			store.save('aster-id', origin, first),
			store.save('aster-id', origin, second),
		]);
		expect(results.map((result) => result.status)).toEqual(['rejected', 'fulfilled']);
		expect(await store.get('aster-id', origin)).toBe(second);
		expect(await new DeviceCredentials(directory).get('aster-id', origin)).toBe(second);
	});
	it('restores only the same host/origin and forgets without deleting a newer credential', async () => {
		const store = new DeviceCredentials(directory);
		await store.save('aster-id', origin, first);
		const disk = readFileSync(path.join(directory, 'lite-device-credentials.json'), 'utf8');
		expect(disk).not.toContain(first);
		expect(disk).not.toContain('B'.repeat(43));
		const restarted = new DeviceCredentials(directory);
		expect(await restarted.get('aster-id', origin)).toBe(first);
		await expect(restarted.get('changed-id', origin)).rejects.toThrow('identity changed');
		expect(await restarted.get('aster-id', 'https://different.synthetic.ts.net')).toBeUndefined();
		await restarted.save('aster-id', origin, second);
		await restarted.forget(origin, first);
		expect(await restarted.get('aster-id', origin)).toBe(second);
		await restarted.forget(origin);
		expect(await new DeviceCredentials(directory).get('aster-id', origin)).toBeUndefined();
	});
	it('refuses pairing storage when OS protection is unavailable, without a plaintext fallback', async () => {
		protection.available = false;
		const store = new DeviceCredentials(directory);
		await expect(store.get('aster-id', origin)).rejects.toThrow('credential store');
		await expect(store.save('aster-id', origin, first)).rejects.toThrow('credential store');
		expect(existsSync(path.join(directory, 'lite-device-credentials.json'))).toBe(false);
	});
	it('pins direct credentials to the locally authenticated Tailscale node identity', async () => {
		const store = new DeviceCredentials(directory),
			direct = 'http://100.64.0.10:56036';
		await store.save('aster-id', direct, first, 'host-node');
		const restarted = new DeviceCredentials(directory);
		expect(await restarted.get('aster-id', direct, 'host-node')).toBe(first);
		await expect(restarted.get('aster-id', direct, 'replacement-node')).rejects.toThrow('identity');
		await expect(restarted.get('aster-id', direct)).rejects.toThrow('node identity');
	});
	it('restores LAN pairing without Tailscale and keeps its credential encrypted and tied to host identity', async () => {
		const store = new DeviceCredentials(directory),
			lan = 'http://192.168.1.10:56036';
		await store.save('aster-id', lan, first);
		expect(
			readFileSync(path.join(directory, 'lite-device-credentials.json'), 'utf8')
		).not.toContain(first);
		const restarted = new DeviceCredentials(directory);
		expect(await restarted.get('aster-id', lan)).toBe(first);
		await expect(restarted.get('replacement-host', lan)).rejects.toThrow('identity changed');
		expect(await restarted.get('aster-id', 'http://192.168.1.11:56036')).toBeUndefined();
		await restarted.forget(lan);
		expect(await new DeviceCredentials(directory).get('aster-id', lan)).toBeUndefined();
	});
});
describe('host paired device persistence', () => {
	it('revokes live access immediately while waiting for another pairing write', async () => {
		const store = new PairedDevices(directory);
		await store.add(first, 'First device', 'aster-id', origin);
		let finishWrite!: () => void;
		const persist = vi.mocked(rename).getMockImplementation()!;
		vi.mocked(rename).mockImplementationOnce(async (...args) => {
			await new Promise<void>((resolve) => (finishWrite = resolve));
			return persist(...args);
		});
		const adding = store.add(second, 'Second device', 'aster-id', origin);
		await vi.waitFor(() => expect(finishWrite).toBeTypeOf('function'));
		const revoking = store.revoke(first.split('.')[0]);
		expect(store.resolve(first, 'aster-id', origin)).toBeUndefined();
		finishWrite();
		await Promise.all([adding, revoking]);
		const restarted = new PairedDevices(directory);
		await restarted.load();
		expect(restarted.resolve(first, 'aster-id', origin)).toBeUndefined();
		expect(restarted.resolve(second, 'aster-id', origin)?.name).toBe('Second device');
	});
	it('hands out the public device id and never the proof or the verifier (MRC-08-03)', async () => {
		const store = new PairedDevices(directory);
		await store.add(first, 'First device', 'aster-id', origin);
		const proof = first.split('.')[1];
		const resolved = store.resolve(first, 'aster-id', origin);
		expect(resolved).toBeDefined();
		expect(resolved?.id).toBe(litePairingDeviceId(first));
		expect(Object.keys(resolved!).sort()).toEqual([
			'createdAt',
			'id',
			'instanceId',
			'name',
			'origin',
		]);
		expect(JSON.stringify(store.list('aster-id'))).not.toContain(proof);
		const disk = readFileSync(path.join(directory, LITE_PAIRED_DEVICES_FILE_NAME), 'utf8');
		expect(disk).toContain(resolved!.id);
		expect(disk).not.toContain(proof);
		expect(disk).not.toContain(first);
		// A credential that shares the public half but not the proof is not the device.
		expect(store.resolve(resolved!.id + '.' + 'Z'.repeat(43), 'aster-id', origin)).toBeUndefined();
	});
	it('keeps the two stores under the names the exporter refuses by', async () => {
		await new PairedDevices(directory).add(first, 'First device', 'aster-id', origin);
		await new DeviceCredentials(directory).save('aster-id', origin, second);
		expect(existsSync(path.join(directory, LITE_PAIRED_DEVICES_FILE_NAME))).toBe(true);
		expect(existsSync(path.join(directory, LITE_DEVICE_CREDENTIALS_FILE_NAME))).toBe(true);
	});
	it('does not persist a failed pairing through a later concurrent successful write', async () => {
		const store = new PairedDevices(directory);
		await store.load();
		vi.mocked(rename).mockRejectedValueOnce(new Error('Synthetic disk failure'));
		const results = await Promise.allSettled([
			store.add(first, 'First device', 'aster-id', origin),
			store.add(second, 'Second device', 'aster-id', origin),
		]);
		expect(results.map((result) => result.status)).toEqual(['rejected', 'fulfilled']);
		expect(store.resolve(first, 'aster-id', origin)).toBeUndefined();
		const restarted = new PairedDevices(directory);
		await restarted.load();
		expect(restarted.resolve(first, 'aster-id', origin)).toBeUndefined();
		expect(restarted.resolve(second, 'aster-id', origin)?.name).toBe('Second device');
	});
});

/**
 * Identity across surfaces (MRC-08-03, MRC-08-06): what a resolved pairing is
 * good for. The device the host registry resolves is the transport behind a
 * socket, bound at the sink as `device-pairing` with its public id; it is
 * refused until the enrollment registers an enterprise actor and rides the
 * delegation chain as attribution after. The credential never becomes a key:
 * nothing past the registry carries the proof. A reconnect is the same device;
 * a revoke leaves nothing to reconnect as, live and after a restart.
 */
describe('a pairing admits a transport, never an enterprise actor (MRC-08-06)', () => {
	const INSTALLATION = { installationId: 'inst-1', runtimeId: 'desktop-1', processEpoch: 'e1' };
	const UNREGISTERED: IdentityRead = {
		status: 'ok',
		epoch: 1,
		record: { registration: null } as never,
	};
	const REGISTERED: IdentityRead = {
		status: 'ok',
		epoch: 1,
		record: { registration: { actorId: 'actor-registered' } } as never,
	};
	const turn = {
		identity: {
			requestId: 'req-1',
			idempotencyKey: 'req-1',
			attemptId: 'att-1',
			runId: null,
			rootRunId: null,
			parentRunId: null,
		},
		traceId: 'agent-1-ai-tab-1',
		policyRevision: 3,
		workflow: null,
	};
	const authority = (read: IdentityRead) =>
		createProcessSpawnAuthority({
			installation: INSTALLATION,
			identity: { read: () => read },
			host: { policy: () => ({ sources: [], policyRevision: 3 }) },
			dispatch: { authority: fakeSpawnPort().authority },
			now: () => 1_000_000,
		});
	// What the Lite connection route builds for a device it resolved: the
	// synthesized History account and the admission method, recorded at the
	// upgrade. The transport is read off the method, never off the account.
	const socketFor = (device: PairedDevice) => ({
		admission: 'device-pairing' as const,
		user: {
			id: PAIRED_DEVICE_USER_ID_PREFIX + device.id,
			username: PAIRED_DEVICE_USERNAME,
			displayName: device.name,
		},
	});
	const actorFor = (device: PairedDevice) =>
		transportSpawnActor(resolveTransportAdmission(socketFor(device)));

	it('binds a resolved device as the device, refuses it until an actor is registered, then carries it as attribution', async () => {
		const store = new PairedDevices(directory);
		await store.add(first, 'Pixel 9', 'aster-id', origin);
		const device = store.resolve(first, 'aster-id', origin)!;

		const admission = resolveTransportAdmission(socketFor(device));
		expect(admission).toEqual({
			kind: 'lite',
			deviceId: litePairingDeviceId(first),
			deviceName: 'Pixel 9',
		});
		const actor = transportSpawnActor(admission);
		expect(actor).toEqual({ peer: 'device-pairing', deviceId: device.id });

		// Lite-only: the pairing is transport admission, not the enterprise
		// actor a managed action needs. Refused by name, never as the operator.
		const refused = authority(UNREGISTERED).verify({ actor, ...turn });
		expect(refused.ok).toBe(false);
		if (refused.ok) throw new Error('expected refusal');
		expect(refused.code).toBe('unauthenticated');
		expect(refused.problems).toEqual([expect.stringContaining(device.id)]);
		expect(refused.problems[0]).toContain('registered enterprise actor');
		expect(refused.problems[0]).not.toContain('operator');
		expect(pairedDeviceActorProblems(actor, { status: 'none' })).toHaveLength(1);

		const admitted = authority(REGISTERED).verify({ actor, ...turn });
		expect(admitted.ok).toBe(true);
		if (!admitted.ok) throw new Error('expected admission');
		expect(admitted.context.actor).toEqual({ kind: 'human', id: 'actor-registered' });
		expect(admitted.context.delegation.chain).toEqual([
			{ kind: 'service', id: `lite-device:${device.id}` },
		]);
	});

	it('carries the public id only: no proof in the admission, the actor, the chain or the verified context', async () => {
		const store = new PairedDevices(directory);
		await store.add(first, 'Pixel 9', 'aster-id', origin);
		const device = store.resolve(first, 'aster-id', origin)!;
		const proof = first.split('.')[1];
		const actor = actorFor(device);

		const verified = authority(REGISTERED).verify({ actor, ...turn });
		const everything = JSON.stringify({
			admission: resolveTransportAdmission(socketFor(device)),
			actor,
			chain: spawnDelegationChain(actor),
			verified,
		});
		expect(everything).toContain(device.id);
		expect(everything).not.toContain(proof);
		expect(everything).not.toContain(first);

		// A pasted credential is scrubbed from anything persisted or shown;
		// the device on a chain stays readable.
		const scrubbed = redactSecrets(
			`x-maestro-device-credential: ${first} for lite-device:${device.id}`
		);
		expect(scrubbed.redacted).toBe(true);
		expect(scrubbed.text).not.toContain(proof);
		expect(scrubbed.text).toContain(`lite-device:${device.id}`);
		// Both stores live under the names the bundle exporter refuses.
		expect(isLitePairingStoreFile(LITE_PAIRED_DEVICES_FILE_NAME)).toBe(true);
		expect(isLitePairingStoreFile(LITE_DEVICE_CREDENTIALS_FILE_NAME)).toBe(true);
	});

	it('a reconnect is the same device; a revoke leaves nothing to reconnect as, live and after a restart', async () => {
		const store = new PairedDevices(directory);
		await store.add(first, 'Pixel 9', 'aster-id', origin);
		await store.add(second, 'Tablet', 'aster-id', origin);
		const phone = actorFor(store.resolve(first, 'aster-id', origin)!);
		const tablet = actorFor(store.resolve(second, 'aster-id', origin)!);
		expect(sameSpawnActor(phone, tablet)).toBe(false);

		// The host restarted and the phone presented the same credential on a
		// new socket: the same actor, so the sink's "same caller" rule holds.
		const restarted = new PairedDevices(directory);
		await restarted.load();
		const reconnected = actorFor(restarted.resolve(first, 'aster-id', origin)!);
		expect(sameSpawnActor(phone, reconnected)).toBe(true);

		// The registry's immediate revoke: what the socket's reauthorization
		// re-resolves before the next message is gone, the other device is not.
		await restarted.revoke(litePairingDeviceId(first)!);
		expect(restarted.resolve(first, 'aster-id', origin)).toBeUndefined();
		expect(restarted.resolve(second, 'aster-id', origin)).toBeDefined();

		const later = new PairedDevices(directory);
		await later.load();
		expect(later.resolve(first, 'aster-id', origin)).toBeUndefined();
		expect(sameSpawnActor(tablet, actorFor(later.resolve(second, 'aster-id', origin)!))).toBe(true);
		// The surviving pairing is still bound to its instance and origin.
		expect(later.resolve(second, 'aster-id', 'https://other.synthetic.ts.net')).toBeUndefined();
		expect(later.resolve(second, 'other-id', origin)).toBeUndefined();
	});
});
