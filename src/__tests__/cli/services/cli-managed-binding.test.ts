/**
 * The bare CLI's managed binding over real files (MCOMP-09-04C): `readCliManagedBinding` reads
 * the binding beside the data-dir lock and holds it to the installation standing, so the binding
 * file can neither supply nor erase the standing. A data directory whose binding file was deleted
 * while the sealed record (or its anchor) remains is managed and unreadable, and a planted file
 * the custody does not hold supplies no authority. `agent-spawner.test.ts` mocks `fs` wholesale,
 * so the real binding is proven here, over a temporary `MAESTRO_USER_DATA`. No case reads the
 * developer's keyring: the default standing is read only over a directory holding a record, and
 * the anchor is consulted only when no record is present.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
	cliSpawnAuthority,
	readCliManagedBinding,
	resetCliSpawnAuthority,
} from '../../../cli/services/agent-spawner';
import { ENTERPRISE_IDENTITY_FILE_NAME } from '../../../main/enterprise/identity-store';
import {
	bindingDigest,
	managedBindingPath,
	type InstallationStanding,
	type ManagedBindingRecord,
} from '../../../shared/maestro-lib/managed/binding';
import { MANAGED_CONTRACT_VERSION } from '../../../shared/maestro-lib/managed/types';

const ENROLLMENT = {
	installationId: 'inst-cli',
	authorityId: 'authority-cli',
	endpointRef: '/tmp/endpoint.sock',
	enrolledAt: '2026-10-21T00:00:00.000Z',
	policySources: [] as string[],
	policyRevision: 2,
};

function source(standing: InstallationStanding) {
	return { read: () => standing };
}

const STANDALONE: InstallationStanding = { standing: 'standalone', detail: 'nothing held' };
const HELD_UNREADABLE: InstallationStanding = {
	standing: 'managed',
	enrollment: null,
	management: null,
	detail: 'the record was removed without the authenticated release',
};
const HELD_ENROLLED: InstallationStanding = {
	standing: 'managed',
	enrollment: ENROLLMENT,
	management: 'enrolled',
	detail: 'enrolled',
};

describe('readCliManagedBinding over real files', () => {
	let dir: string;
	let savedUserData: string | undefined;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-managed-binding-'));
		savedUserData = process.env.MAESTRO_USER_DATA;
		process.env.MAESTRO_USER_DATA = dir;
		resetCliSpawnAuthority();
	});
	afterEach(() => {
		if (savedUserData === undefined) delete process.env.MAESTRO_USER_DATA;
		else process.env.MAESTRO_USER_DATA = savedUserData;
		resetCliSpawnAuthority();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	function plantBinding(): string {
		const base = {
			contractVersion: MANAGED_CONTRACT_VERSION,
			installationId: ENROLLMENT.installationId,
			authorityId: ENROLLMENT.authorityId,
			endpointRef: ENROLLMENT.endpointRef,
			enrolledAt: ENROLLMENT.enrolledAt,
			policySources: [],
			policyRevision: ENROLLMENT.policyRevision,
		};
		const record: ManagedBindingRecord = { ...base, digest: bindingDigest(base) };
		const file = managedBindingPath(dir);
		fs.writeFileSync(file, JSON.stringify(record));
		return file;
	}

	it('is standalone only when the custody holds nothing and no file is present', () => {
		expect(readCliManagedBinding(source(STANDALONE))).toMatchObject({ state: 'standalone' });
	});

	it('stays managed with the binding file deleted while the custody holds a record it cannot open', () => {
		expect(fs.existsSync(managedBindingPath(dir))).toBe(false);
		expect(readCliManagedBinding(source(HELD_UNREADABLE))).toMatchObject({ state: 'unreadable' });
	});

	it('names the custody enrollment unavailable with no binding file and no attached host', () => {
		const binding = readCliManagedBinding(source(HELD_ENROLLED));
		expect(binding).toMatchObject({
			state: 'enrolled-unavailable',
			record: { installationId: 'inst-cli', authorityId: 'authority-cli' },
		});
		if (binding.state !== 'enrolled-unavailable') throw new Error('unreachable');
		expect(binding.reason).toContain('no attached host authority');
	});

	it('gives a planted binding file the custody does not hold no authority', () => {
		const file = plantBinding();
		const binding = readCliManagedBinding(source(STANDALONE));
		expect(binding).toMatchObject({ state: 'enrolled-unavailable', file });
		if (binding.state !== 'enrolled-unavailable') throw new Error('unreachable');
		expect(binding.reason).toContain('no attached host authority');
	});

	it('reads the default standing over this data directory: a sealed record with no binding file refuses every launch', () => {
		// A record this plain Node process cannot open (no protected seal): the standing reads it
		// by its presence, so the keyring is never consulted.
		fs.writeFileSync(path.join(dir, ENTERPRISE_IDENTITY_FILE_NAME), 'sealed bytes');
		expect(readCliManagedBinding()).toMatchObject({ state: 'unreadable' });
		const authority = cliSpawnAuthority();
		expect(authority.standing()).toBe('managed');
		expect(authority.unavailableReason).toContain('cannot be opened in this process');
	});
});
