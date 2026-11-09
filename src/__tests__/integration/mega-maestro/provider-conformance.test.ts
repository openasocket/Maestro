/**
 * Provider and native platform conformance (MCOMP-31-05): the four provider
 * transports (CLI process, persistent SDK, PTY, SSH) and NATIVE-ENDPOINT/1,
 * through the production consumers. `fixture` mode (default) proves route
 * mapping, evidence validation and refusal on contract-shaped receipts with a
 * declared verifier double; it qualifies nothing. `real` mode
 * (MAESTRO_QUAL_PROVIDER_MODE=real + MAESTRO_QUAL_PROVIDER_INPUTS) holds the
 * mandatory cases MCOMP-32 executes; a missing input fails by name, never skips.
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { bindApprovedCredentials } from '../../../shared/maestro-lib/managed/credentials';
import {
	approveProviderRoute,
	PROVIDER_ROUTE_ALLOW_CASES,
	PROVIDER_ROUTE_DENY_CASES,
	type ProviderEvidenceTransport,
	type ProviderRouteCandidate,
	type ProviderRouteEvidenceVerifier,
	type SignedProviderRouteQualification,
} from '../../../shared/maestro-lib/managed/provider-route';
import {
	ENDPOINT_NATIVE_PORT_VERSION,
	endpointAddressProblem,
	endpointNativePortProblem,
	endpointServerVerificationProblems,
	endpointTransportOf,
	type EndpointNativePort,
} from '../../../shared/maestro-lib/managed/endpoint-port';
import { MANAGED_CONTRACT_VERSION } from '../../../shared/maestro-lib/managed/types';
import type { ManagedLaunchInput } from '../../../shared/maestro-lib/launch/launch-plan';
import { codexManagedRequestSession } from '../../../shared/maestro-lib/codex/server-requests';
import { providerRouteLaunchProblems } from '../../../shared/maestro-lib/turns/run-agent-turn';
import { cueShellRouteProblems } from '../../../main/enterprise/dispatch';

const MODE = process.env.MAESTRO_QUAL_PROVIDER_MODE || 'fixture';
if (MODE !== 'fixture' && MODE !== 'real') {
	throw new Error(`MAESTRO_QUAL_PROVIDER_MODE must be "fixture" or "real", not "${MODE}".`);
}

const d = (c: string) => c.repeat(64);
const NOW = Date.parse('2026-11-09T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const TRANSPORTS: ProviderEvidenceTransport[] = ['cli-process', 'persistent-sdk', 'pty', 'ssh'];
/** The provider each transport is exercised with; every one is a production route. */
const ROUTES: Record<ProviderEvidenceTransport, { provider: string; adapterId: string }> = {
	'cli-process': { provider: 'claude-code', adapterId: 'claude-cli-v1' },
	'persistent-sdk': { provider: 'codex', adapterId: 'codex-app-server-v1' },
	pty: { provider: 'claude-code', adapterId: 'claude-tui-v1' },
	ssh: { provider: 'opencode', adapterId: 'opencode-ssh-v1' },
};

const candidate = (transport: ProviderEvidenceTransport): ProviderRouteCandidate => ({
	...ROUTES[transport],
	transport,
	binary: { digest: d('a'), version: '1.0.0', identity: 'inode:42' },
	os: { platform: 'linux', release: '6.8.0', arch: 'x64' },
	backend: { id: 'bwrap-v1', evidenceDigest: d('b') },
	inputDigest: d('c'),
});

/** A contract-shaped receipt for `c` with every mandatory case observed as expected. */
function receiptFor(c: ProviderRouteCandidate): SignedProviderRouteQualification {
	const observe = (expected: 'allowed' | 'denied') => (name: string) => ({
		case: name as never,
		expected,
		observed: expected,
		observer: expected === 'allowed' ? ('receipt' as const) : ('process' as const),
		evidenceDigest: d(expected === 'allowed' ? '3' : '4'),
	});
	return {
		payload: {
			version: 1,
			receiptId: `route-${c.transport}`,
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
			inputSnapshot: { inputDigest: c.inputDigest, inputs: [['bin', d('1')]] },
			observations: [
				...PROVIDER_ROUTE_ALLOW_CASES.map(observe('allowed')),
				...PROVIDER_ROUTE_DENY_CASES.map(observe('denied')),
			],
			observedAt: new Date(NOW - DAY).toISOString(),
		},
		payloadDigest: d('5'),
		keyId: 'route-key-1',
		algorithm: 'Ed25519',
		signature: `${'A'.repeat(86)}==`,
	};
}

/** Declared double: it says `verified` and counts; `during` runs inside the await. */
function fixtureVerifier(during?: () => void) {
	const v = {
		version: 1 as const,
		calls: 0,
		async verify() {
			v.calls += 1;
			during?.();
			return 'verified' as const;
		},
	};
	return v;
}

const options = (signal = new AbortController().signal, now = () => NOW) => ({
	maxAgeMs: 30 * DAY,
	now,
	signal,
});

if (MODE === 'fixture') {
	describe('provider routes through contract fixtures', () => {
		it.each(TRANSPORTS)(
			'%s: a receipt bound to exactly this route qualifies it and no other',
			async (transport) => {
				const c = candidate(transport);
				const evidence = receiptFor(c);
				expect(await approveProviderRoute(evidence, c, fixtureVerifier(), options())).toMatchObject(
					{
						state: 'qualified',
						receiptId: `route-${transport}`,
					}
				);
				// No fallback: the same receipt never stands in for another transport.
				for (const other of TRANSPORTS.filter((t) => t !== transport)) {
					const v = fixtureVerifier();
					// Same provider, adapter and binary: only the transport differs.
					const approval = await approveProviderRoute(
						evidence,
						{ ...c, transport: other },
						v,
						options()
					);
					expect(approval).toEqual({ state: 'unavailable', reasons: ['route.transport differs'] });
					expect(v.calls).toBe(0);
				}
			}
		);

		it.each(PROVIDER_ROUTE_DENY_CASES)(
			'denied escape %s observed as allowed refuses the route',
			async (name) => {
				const c = candidate('cli-process');
				const evidence = receiptFor(c);
				const entry = evidence.payload.observations.find((o) => o.case === name)!;
				entry.observed = 'allowed';
				const v = fixtureVerifier();
				const approval = await approveProviderRoute(evidence, c, v, options());
				expect(approval).toEqual({ state: 'unavailable', reasons: [`case ${name} was allowed`] });
				expect(v.calls).toBe(0);
			}
		);

		it.each(PROVIDER_ROUTE_ALLOW_CASES)(
			'allowed output %s left unobserved refuses the route',
			async (name) => {
				const c = candidate('persistent-sdk');
				const evidence = receiptFor(c);
				evidence.payload.observations = evidence.payload.observations.filter(
					(o) => o.case !== name
				);
				const approval = await approveProviderRoute(evidence, c, fixtureVerifier(), options());
				expect(approval).toEqual({
					state: 'unavailable',
					reasons: [`case ${name} was not observed`],
				});
			}
		);

		it.each([
			['binary.digest', (c: ProviderRouteCandidate) => (c.binary.digest = d('9'))],
			['os.platform', (c: ProviderRouteCandidate) => (c.os.platform = 'darwin')],
			['backend.id', (c: ProviderRouteCandidate) => (c.backend.id = 'none')],
			['inputSnapshot.inputDigest', (c: ProviderRouteCandidate) => (c.inputDigest = d('8'))],
		])('a host whose %s drifted from the receipt is refused by name', async (field, drift) => {
			const evidence = receiptFor(candidate('pty'));
			const c = candidate('pty');
			drift(c);
			const approval = await approveProviderRoute(evidence, c, fixtureVerifier(), options());
			expect(approval.state === 'unavailable' && approval.reasons).toContain(`${field} differs`);
		});

		it('credential and actor isolation: the route binds one approved credential set, never a login', () => {
			const scope = { tenantId: 't', agentId: 'agent-1', accountRef: null, policyRevision: 1 };
			const bind = (actorId: string) =>
				bindApprovedCredentials(
					[
						{
							...scope,
							contractVersion: MANAGED_CONTRACT_VERSION,
							refId: 'cred-team',
							actorId,
							audience: { providerId: 'claude-code', destination: null },
							issuedAt: '2026-11-09T00:00:00Z',
							expiresAt: '2026-11-10T00:00:00Z',
							status: 'active',
							source: {
								kind: 'server-secret',
								secretName: 'TEAM_KEY',
								envVar: 'ANTHROPIC_API_KEY',
							},
						},
					],
					{ ...scope, actorId, providerId: 'claude-code', destination: null, now: NOW }
				);
			const mine = bind('actor-a');
			const theirs = bind('actor-b');
			expect(mine.approved).toHaveLength(1);
			expect(mine.digest).not.toBe(theirs.digest);
			const launch = (
				credentials = mine,
				login: 'approved-credential' | 'provider-login' = 'approved-credential'
			): ManagedLaunchInput => ({
				route: {
					providerId: 'claude-code',
					model: null,
					baseUrl: null,
					accountDir: null,
					login,
					permissionMode: null,
				},
				credentials,
			});
			const input = {
				evidence: receiptFor(candidate('cli-process')),
				candidate: candidate('cli-process'),
				gateway: null,
				credentialBindingDigest: mine.digest,
				maxAgeMs: 30 * DAY,
			};
			const expected = { providerId: 'claude-code', transport: 'cli-process' as const };
			expect(providerRouteLaunchProblems(input, launch(), expected)).toEqual([]);
			expect(providerRouteLaunchProblems(input, launch(theirs), expected)).toEqual([
				'the candidate credential binding is not the launch binding',
			]);
			expect(
				providerRouteLaunchProblems(input, launch(mine, 'provider-login'), expected)
			).toContain(
				'the route lets the provider login bill; a qualified route needs an approved credential'
			);
			expect(
				providerRouteLaunchProblems(input, launch(), { providerId: 'codex', transport: 'pty' })
			).toEqual(
				expect.arrayContaining([
					'the candidate names another provider',
					'the candidate transport is not pty',
				])
			);
		});

		it.each([
			'candidate changed during verification',
			'evidence changed during verification',
			'cancelled',
			'evidence is stale',
		])('a change in the middle of verification is refused: %s', async (reason) => {
			const c = candidate('ssh');
			const evidence = receiptFor(c);
			const abort = new AbortController();
			let now = NOW;
			const v = fixtureVerifier(() => {
				if (reason.startsWith('candidate')) c.binary.version = '1.0.1';
				else if (reason.startsWith('evidence changed')) evidence.payload.receiptId = 'swapped';
				else if (reason === 'cancelled') abort.abort();
				else now = NOW + 30 * DAY;
			});
			const approval = await approveProviderRoute(
				evidence,
				c,
				v,
				options(abort.signal, () => now)
			);
			expect(approval).toEqual({ state: 'unavailable', reasons: [reason] });
		});

		it('persistent SDK: a server request is decided only under the thread and turn this run owns', () => {
			type Session = { threadId: string | null; turnId: string | null };
			const owned: Session = { threadId: 'thr-1', turnId: 'turn-1' };
			const ask = (params: Record<string, unknown>, session = owned) =>
				codexManagedRequestSession(
					{ id: 7, method: 'item/fileChange/requestApproval', params },
					session
				);
			expect(ask({ threadId: 'thr-1', turnId: 'turn-1' })).toEqual({ ...owned, requestId: '7' });
			// A foreign thread, a turn this run did not start, or no observed thread at all.
			expect(ask({ threadId: 'thr-2' })).toHaveProperty('problem');
			expect(ask({ threadId: 'thr-1', turnId: 'turn-9' })).toHaveProperty('problem');
			expect(ask({}, { threadId: null, turnId: null })).toHaveProperty('problem');
		});

		it('SSH shell route: evidence must name the cue-shell provider and the enrolled endpoint of this very remote', () => {
			const endpoint = {
				installationId: 'i',
				runtimeId: 'r',
				processEpoch: 'e',
				authorityId: 'a',
				policyRevision: 3,
			};
			const c = { ...candidate('ssh'), provider: 'cue-shell' };
			const offer = (remote: { remoteId: string; endpoint: typeof endpoint } | null) => ({
				evidence: receiptFor(c),
				candidate: c,
				maxAgeMs: 30 * DAY,
				remote,
			});
			const plan = { route: 'ssh-shell' as const, remoteId: 'remote-1' };
			expect(cueShellRouteProblems(offer({ remoteId: 'remote-1', endpoint }), plan)).toEqual([]);
			expect(cueShellRouteProblems(offer({ remoteId: 'remote-2', endpoint }), plan)).toEqual([
				'the attested endpoint belongs to another remote',
			]);
			expect(cueShellRouteProblems(offer(null), plan)).toEqual([
				'the remote attested no enrolled endpoint',
			]);
			expect(cueShellRouteProblems(offer(null), { route: 'local-shell', remoteId: null })).toEqual([
				'the candidate transport is not cli-process',
			]);
		});
	});

	describe('native endpoint platforms through contract fixtures', () => {
		const port = (over: Partial<EndpointNativePort> = {}): EndpointNativePort => ({
			version: ENDPOINT_NATIVE_PORT_VERSION,
			platform: 'darwin',
			transport: 'unix-socket',
			verifyServer: async () => ({ status: 'unavailable', reason: 'fixture' }),
			...over,
		});
		it.each(['darwin', 'win32'])(
			'%s with no native port is unavailable; Linux needs none',
			(platform) => {
				expect(endpointNativePortProblem(platform, undefined)).toMatch(
					/No native endpoint port is installed/
				);
				expect(endpointNativePortProblem('linux', undefined)).toBeNull();
			}
		);
		it('a port of another version, platform or transport is refused; a matching one is accepted', () => {
			expect(endpointNativePortProblem('darwin', port())).toBeNull();
			expect(
				endpointNativePortProblem('win32', port({ platform: 'win32', transport: 'named-pipe' }))
			).toBeNull();
			expect(endpointNativePortProblem('darwin', port({ version: 2 as never }))).toMatch(
				/version 2/
			);
			expect(endpointNativePortProblem('darwin', port({ platform: 'win32' }))).toMatch(
				/reads win32/
			);
			expect(endpointNativePortProblem('win32', port({ platform: 'win32' }))).toMatch(/named-pipe/);
		});
		it('only a local socket or local pipe is an endpoint address', () => {
			expect(endpointAddressProblem('win32', '\\\\.\\pipe\\mega-maestro')).toBeNull();
			expect(endpointAddressProblem('win32', '\\\\host\\pipe\\mega-maestro')).not.toBeNull();
			expect(endpointAddressProblem('darwin', 'https://127.0.0.1:9000')).not.toBeNull();
			expect(endpointAddressProblem('linux', 'relative.sock')).not.toBeNull();
		});
		it('a verification must name a whole server identity; refusals and partial answers are problems', () => {
			const server = {
				pid: 41,
				processBirthDigest: d('1'),
				executableDigest: d('2'),
				principal: 'svc-mega',
			};
			expect(endpointServerVerificationProblems({ status: 'verified', server })).toEqual([]);
			expect(
				endpointServerVerificationProblems({ status: 'refused', reason: 'squatter' })
			).toHaveLength(1);
			expect(
				endpointServerVerificationProblems({ status: 'verified', server: { ...server, pid: 0 } })
			).not.toEqual([]);
		});
	});
}

/** What real mode needs from the environment that runs it (MCOMP-32). */
interface RealQualificationInputs {
	/** ESM module whose default export is the trusted ProviderRouteEvidenceVerifier. */
	verifierModule: string;
	maxAgeMs: number;
	/** One per required provider tuple: the producer's receipt and the host's exact candidate. */
	routes: Array<{ evidenceFile: string; candidate: ProviderRouteCandidate }>;
	/** macOS/Windows: ESM module whose default export is the host's EndpointNativePort. */
	nativePortModule?: string;
	/** The real endpoint address on this host. */
	endpointAddress: string;
}

function readRealInputs(): RealQualificationInputs {
	const file = process.env.MAESTRO_QUAL_PROVIDER_INPUTS;
	if (!file) {
		throw new Error(
			'Real mode needs MAESTRO_QUAL_PROVIDER_INPUTS (a JSON file: verifierModule, maxAgeMs, routes, endpointAddress, nativePortModule on macOS/Windows).'
		);
	}
	const inputs = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<RealQualificationInputs>;
	const covered = new Set((inputs.routes ?? []).map((r) => r.candidate?.transport));
	const missing = [
		!inputs.verifierModule && 'verifierModule',
		!inputs.maxAgeMs && 'maxAgeMs',
		!inputs.endpointAddress && 'endpointAddress',
		process.platform !== 'linux' && !inputs.nativePortModule && 'nativePortModule',
		...TRANSPORTS.filter((t) => !covered.has(t)).map((t) => `routes[${t}]`),
	].filter(Boolean);
	if (missing.length)
		throw new Error(`Real qualification inputs in ${file} lack: ${missing.join(', ')}.`);
	return inputs as RealQualificationInputs;
}

const loadDefault = async <T>(module: string): Promise<T> =>
	((await import(pathToFileURL(path.resolve(module)).href)) as { default: T }).default;

if (MODE === 'real') {
	describe(`real provider and native qualification on ${process.platform} (MCOMP-32)`, () => {
		it('every required transport has a real receipt that qualifies exactly its route under the trusted verifier', async () => {
			const inputs = readRealInputs();
			const verifier = await loadDefault<ProviderRouteEvidenceVerifier>(inputs.verifierModule);
			for (const route of inputs.routes) {
				const evidence = JSON.parse(
					fs.readFileSync(route.evidenceFile, 'utf8')
				) as SignedProviderRouteQualification;
				const opts = { maxAgeMs: inputs.maxAgeMs, signal: new AbortController().signal };
				const approval = await approveProviderRoute(evidence, route.candidate, verifier, opts);
				expect(approval, `${route.candidate.provider}/${route.candidate.transport}`).toMatchObject({
					state: 'qualified',
				});
				const forged = structuredClone(evidence);
				forged.payload.observations[0].evidenceDigest = d('0');
				expect((await approveProviderRoute(forged, route.candidate, verifier, opts)).state).toBe(
					'unavailable'
				);
				const drifted = {
					...route.candidate,
					binary: { ...route.candidate.binary, digest: d('0') },
				};
				expect((await approveProviderRoute(evidence, drifted, verifier, opts)).state).toBe(
					'unavailable'
				);
			}
		});

		it('the native port names the real endpoint server and refuses a squatter on the same transport', async () => {
			const inputs = readRealInputs();
			const platform = process.platform;
			if (platform === 'linux') {
				expect(endpointNativePortProblem(platform, undefined)).toBeNull();
				expect(endpointAddressProblem(platform, inputs.endpointAddress)).toBeNull();
				return;
			}
			const native = await loadDefault<EndpointNativePort>(inputs.nativePortModule!);
			expect(endpointNativePortProblem(platform, native)).toBeNull();
			const verifyAt = (address: string) =>
				new Promise<unknown>((resolve, reject) => {
					const socket = net.connect(address, () => {
						native
							.verifyServer({ address, handle: socket, signal: AbortSignal.timeout(10_000) })
							.then(resolve, reject)
							.finally(() => socket.destroy());
					});
					socket.once('error', reject);
				});
			expect(endpointServerVerificationProblems(await verifyAt(inputs.endpointAddress))).toEqual(
				[]
			);
			const squat =
				endpointTransportOf(platform) === 'named-pipe'
					? `\\\\.\\pipe\\maestro-qual-squat-${process.pid}`
					: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qual-')), 's.sock');
			const server = net.createServer((s) => s.end());
			await new Promise<void>((resolve) => server.listen(squat, resolve));
			try {
				expect(endpointServerVerificationProblems(await verifyAt(squat))).not.toEqual([]);
			} finally {
				server.close();
			}
		});
	});
}
