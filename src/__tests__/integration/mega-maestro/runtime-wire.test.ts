/**
 * What the production desktop composition (`createEnterpriseService`) puts on
 * the wire, parsed by the pinned 0.4.0 contract (handoff items 1-3, 9): the
 * registration handshake, the protocol 2 attachment, `registration_use` and a
 * v2 workflow claim, all on `/v2/invoke`, every request envelope one
 * `localRequestEnvelopeV2` accepts, and nothing on any other path.
 *
 * The consumer BUILD receipt writer runs this suite with
 * `MAESTRO_WIRE_OBSERVATION=<file>` and records what it wrote under
 * `runtimeWire`. The endpoint is the double in `fakeEndpoint.ts`: the protocol
 * and operations are what this runtime sends; the owner, epoch and token are
 * the double's, so nothing here is live traffic or paired enforcement.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLocalEndpointClient } from '../../../shared/maestro-lib/managed/endpoint-client';
import { createEnterpriseService } from '../../../main/enterprise/service';
import { canonicalJson } from '../../../shared/canonicalJson';
import { fakeAnchor, fakeSeal } from '../../main/enterprise/fakeCustody';
import { startFakeEndpoint, type FakeEndpoint } from '../../main/enterprise/fakeEndpoint';
import {
	projectedRegistrationUse,
	WORKFLOW_OFFER,
	workflowProducer,
} from '../../main/enterprise/workflowProducer';
import { createHash } from 'node:crypto';

const NOW = Date.parse('2026-11-14T12:00:00Z');
const WORKFLOW = {
	workflowId: 'cue-pipeline:Wire check',
	version: 'v1',
	triggerEventId: 'time.scheduled:evt-wire',
};

type Envelope = { schemaVersion: number; operation: string; payload: Record<string, unknown> };

describe('runtime wire: the production composition on protocol 2', () => {
	let dir: string;
	let fake: FakeEndpoint;
	let protocol: typeof import('../../../../vendor/mega-maestro/contracts/dist/protocol.js');

	beforeAll(async () => {
		protocol = await import('../../../../vendor/mega-maestro/contracts/dist/protocol.js');
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-wire-'));
	});
	afterAll(async () => {
		await fake?.close();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('registers, attaches, projects the reference and claims a workflow on /v2/invoke only, in the contract shapes', async () => {
		let installation: { installationId: string; runtimeId: string; processEpoch: string } | null =
			null;
		fake = await startFakeEndpoint({
			registrationRequired: true,
			capabilities: [...WORKFLOW_OFFER],
			now: () => NOW,
			operations: {
				registration_use: () => projectedRegistrationUse(installation!),
				...workflowProducer({ now: () => NOW }),
			},
		});
		const seal = fakeSeal();
		const service = createEnterpriseService({
			userDataDir: dir,
			productionDataDir: dir,
			hostname: 'wirehost',
			pid: 4242,
			startedAt: '2026-11-14T11:59:00.000Z',
			appVersion: '1.1.0-RC',
			safeStorage: {
				isEncryptionAvailable: () => true,
				encryptString: (text) => seal.seal(text),
				decryptString: (blob) => seal.unseal(blob),
				getSelectedStorageBackend: () => 'keychain',
			},
			anchor: fakeAnchor({ value: null }),
			platform: 'darwin',
			now: () => NOW,
			openPort: (socketPath) => createLocalEndpointClient({ socketPath, timeoutMs: 1_000 }),
		});
		installation = service.installation;
		try {
			await service.identity.write({
				installationId: service.installation.installationId,
				tenantId: 'tenant-1',
				orgId: 'org-1',
				enrollmentId: 'enr-1',
				endpoint: {
					socketPath: fake.socketPath,
					bindingDigest: 'a'.repeat(64),
					trustRootDigest: null,
				},
				management: 'enrolled',
				registration: null,
				policy: { desiredRevision: null, appliedRevision: null, observedAt: null },
				enrolledAt: new Date(NOW).toISOString(),
			});
			await service.start();
			expect((await service.policy.recover()).status).toBe('approval-required');
			expect((await service.lifecycle.completeRegistration()).status).toBe('ok');
			expect(service.lifecycle.status().authority).toBe('registered');
			const fence = await service.claimWorkflowFence(WORKFLOW, {
				runId: 'run-wire',
				attemptId: 'att-wire',
			});
			expect(fence).toMatchObject({ ownerId: service.installation.installationId });

			const sent = fake.callsTo('/v2/invoke').map((call) => call.body as Envelope);
			for (const envelope of sent) {
				const checked = protocol.localEndpointContractsV2[
					envelope.operation as keyof typeof protocol.localEndpointContractsV2
				].request.safeParse(envelope.payload);
				expect(
					checked.success ? null : { operation: envelope.operation, issues: checked.error.issues }
				).toBeNull();
				protocol.localRequestEnvelopeV2.parse(envelope);
			}
			const operations = sent.map((envelope) => envelope.operation);
			// The start attaches first and is refused (no registration yet), then the handshake.
			expect(operations.slice(0, 5)).toEqual([
				'attachment',
				'registration_challenge',
				'registration_redeem',
				'attachment',
				'registration_use',
			]);
			expect(operations).toContain('workflow_claim');
			expect(operations).not.toContain('workflow');
			const attach = sent.find((envelope) => envelope.operation === 'attachment')!;
			expect(attach.payload.supportedProtocols).toEqual([2]);
			const claim = sent.find((envelope) => envelope.operation === 'workflow_claim')!;
			expect(claim.payload).toMatchObject({ delegation: null, grants: [] });

			const target = process.env.MAESTRO_WIRE_OBSERVATION;
			if (target) {
				const digest = (value: unknown) =>
					createHash('sha256').update(canonicalJson(value)).digest('hex');
				const owner = fence as { ownerId: string; ownerEpoch: string; fencingToken: string };
				fs.writeFileSync(
					target,
					`${JSON.stringify(
						{
							schemaVersion: 1,
							endpoint:
								'test double src/__tests__/main/enterprise/fakeEndpoint.ts, not a live endpoint',
							composition: 'createEnterpriseService (src/main/enterprise/service.ts)',
							acceptedEndpointProtocols: [
								...new Set(sent.map((envelope) => envelope.schemaVersion)),
							],
							v1Requests: 0,
							v2Requests: sent.length,
							operations: [...new Set(operations)],
							parsedBy: 'localRequestEnvelopeV2 (vendored contracts protocol.js)',
							attachment: {
								supportedProtocols: attach.payload.supportedProtocols,
								supportedCapabilities: attach.payload.supportedCapabilities,
								requiredCapabilities: attach.payload.requiredCapabilities,
							},
							workflowClaim: {
								delegation: claim.payload.delegation,
								grants: claim.payload.grants,
								registrationDigest: digest(claim.payload.registration),
								owner: { ownerId: owner.ownerId, ownerEpoch: owner.ownerEpoch },
								ownerIssuedBy: 'the double',
							},
						},
						null,
						'\t'
					)}\n`
				);
			}
		} finally {
			await service.close();
		}
	}, 30_000);
});
