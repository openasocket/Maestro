/**
 * The enrollment lifecycle: what this installation does with its identity
 * custody and the endpoint socket, one serialized step at a time.
 *
 * The endpoint owns enrollment. Its administrator enrolls, rotates and
 * retires the device through the endpoint's own tooling, holding the device
 * key Maestro never sees. What Maestro does is REQUEST and OBSERVE:
 *
 *   - `requestEnrollment` sends the protocol's `enrollment` operation when the
 *     endpoint advertises it, and writes a record in `enrolling` when the
 *     endpoint answers `enrollment_pending`. The endpoint in the sibling
 *     checkout advertises no such capability (CP-04, owner mega-maestro); the
 *     request is then answered `unsupported` and nothing is written.
 *   - `beginRegistration` / `completeRegistration` run the actor registration
 *     the endpoint consumes: a challenge on one connection, a browser approval
 *     by the actor, a redeem on the same connection. The approval code is
 *     handed to the caller once and is neither persisted nor logged.
 *   - `connect` attaches (after a registration, when the endpoint requires
 *     one) and projects what the endpoint answered onto the record: the
 *     management state it reports and the policy revisions it holds.
 *   - `requestRotation`, `requestRevocation`, `requestRetirement` name what the
 *     protocol has no operation for; they answer `unsupported` with the owner
 *     named, and `acknowledgeRevocation` / `retire` are the explicit local
 *     transitions an operator makes once the endpoint's side is done.
 *
 * What never happens here: a record is not removed because the endpoint is
 * unreachable, says `unenrolled`, or refuses a connection; custody that is
 * `unprotected` or `untrusted` is never written over; and `authority` is
 * `registered` only when custody, record, this process's registration, the
 * attachment and the endpoint's own `managed` answer all agree. An offline
 * endpoint leaves the record as it was and the authority at `none`.
 *
 * No Electron import, so a headless host runs the same lifecycle.
 */

import {
	LOCAL_ENDPOINT_PROTOCOL,
	type EndpointAttachmentRequest,
	type EndpointComponent,
	type EndpointEnrollmentRequest,
	type EndpointEnrollmentResult,
	type EndpointInvokeOutcome,
	type EndpointPort,
	type EndpointRegistrationApproval,
	type EndpointStatus,
	type LocalEndpointDenialReason,
	type ManagedEnrollmentStatus,
	type ManagedIdentityManagement,
} from '../../shared/maestro-lib/managed/endpoint-port';
import type { ManagedInstallationIdentity } from '../../shared/maestro-lib/managed/types';
import { type EnterpriseIdentityStore, publicEnterpriseIdentity } from './identity-store';

export interface EnrollmentLifecycleDeps {
	identity: EnterpriseIdentityStore;
	/** Opens a port on a socket path; the lifecycle owns the port it gets back. Throws on a refused path. */
	openPort(socketPath: string): EndpointPort;
	installation: ManagedInstallationIdentity;
	components: readonly EndpointComponent[];
	/** What this host can do over the socket, and what it cannot run without. */
	capabilities: { supported: readonly string[]; required: readonly string[] };
	now?: () => number;
}

export interface EnrollmentRequestInput extends EndpointEnrollmentRequest {
	socketPath: string;
	/** Asserted by the enrolling operator from the invitation; the endpoint does not report them over the socket. */
	tenantId: string;
	orgId: string;
}

export type LifecycleRefusal =
	| 'custody-unprotected'
	| 'custody-untrusted'
	| 'already-enrolled'
	| 'not-enrolled'
	| 'installation-mismatch'
	| 'no-endpoint'
	| 'no-challenge'
	/** A local transition refused because the endpoint still manages this installation (`managed-state.ts`). */
	| 'management-required';

export type LifecycleOutcome<T> =
	| { status: 'ok'; value: T }
	| { status: 'refused'; reason: LifecycleRefusal; message: string }
	| { status: 'unsupported'; message: string; owner: 'mega-maestro' }
	| { status: 'denied'; reason: LocalEndpointDenialReason; operation: string }
	| { status: 'unavailable'; message: string }
	| { status: 'unknown'; message: string };

/** What the caller shows the actor: the approval they type into the console, and when it lapses. */
export interface RegistrationApprovalHandoff {
	challengeId: string;
	nonce: string;
	challengeDigest: string;
	expiresAt: string;
}

export interface EnrollmentLifecycle {
	status(): ManagedEnrollmentStatus;
	requestEnrollment(
		input: EnrollmentRequestInput
	): Promise<LifecycleOutcome<EndpointEnrollmentResult>>;
	/** Dial the recorded endpoint and attach; after a restart the endpoint will want a registration first. */
	connect(): Promise<LifecycleOutcome<EndpointStatus>>;
	beginRegistration(): Promise<LifecycleOutcome<RegistrationApprovalHandoff>>;
	completeRegistration(): Promise<LifecycleOutcome<EndpointStatus>>;
	requestRotation(): Promise<LifecycleOutcome<never>>;
	requestRevocation(): Promise<LifecycleOutcome<never>>;
	requestRetirement(): Promise<LifecycleOutcome<never>>;
	acknowledgeRevocation(input: {
		installationId: string;
	}): Promise<LifecycleOutcome<ManagedIdentityManagement>>;
	retire(input: { installationId: string }): Promise<LifecycleOutcome<ManagedIdentityManagement>>;
	close(): Promise<void>;
}

const NO_OPERATION =
	'local-endpoint protocol 1 has no operation for this; the endpoint administrator performs it with the endpoint tooling (owner: mega-maestro, CP-04).';

export function createEnrollmentLifecycle(deps: EnrollmentLifecycleDeps): EnrollmentLifecycle {
	const now = deps.now ?? (() => Date.now());
	let port: EndpointPort | null = null;
	let endpoint: EndpointStatus | null = null;
	let pendingApproval: { challengeId: string; expiresAt: string } | null = null;
	let lastDenial: ManagedEnrollmentStatus['lastDenial'] = null;
	let chain: Promise<unknown> = Promise.resolve();

	const serialized = <T>(work: () => Promise<T>): Promise<T> => {
		const next = chain.then(work, work);
		chain = next.then(
			() => undefined,
			() => undefined
		);
		return next;
	};

	const refuse = <T>(reason: LifecycleRefusal, message: string): LifecycleOutcome<T> => ({
		status: 'refused',
		reason,
		message,
	});

	/** Map a port answer onto a lifecycle answer, remembering a denial for the status pane. */
	function relay<T>(operation: string, outcome: EndpointInvokeOutcome<T>): LifecycleOutcome<T> {
		switch (outcome.status) {
			case 'ok':
				return { status: 'ok', value: outcome.payload };
			case 'denied':
				lastDenial = { at: new Date(now()).toISOString(), operation, reason: outcome.reason };
				return { status: 'denied', reason: outcome.reason, operation };
			case 'unavailable':
				return { status: 'unavailable', message: `${operation}: ${outcome.message}` };
			case 'unknown':
				return { status: 'unknown', message: `${operation}: ${outcome.message}` };
		}
	}

	function attachmentRequest(): EndpointAttachmentRequest {
		return {
			installationId: deps.installation.installationId,
			runtimeId: deps.installation.runtimeId,
			processEpoch: deps.installation.processEpoch,
			components: deps.components,
			supportedProtocols: [LOCAL_ENDPOINT_PROTOCOL],
			supportedCapabilities: deps.capabilities.supported,
			requiredCapabilities: deps.capabilities.required,
		};
	}

	/** The port for `socketPath`, reusing the open one when it is the same socket. */
	function portFor(socketPath: string): EndpointPort {
		if (port && (port.socketPath !== socketPath || port.state().closed)) {
			void port.close();
			port = null;
			endpoint = null;
		}
		port ??= deps.openPort(socketPath);
		return port;
	}

	/** Attach on `p` and fold what the endpoint said into the record, when there is one. */
	async function attach(p: EndpointPort): Promise<LifecycleOutcome<EndpointStatus>> {
		const outcome = relay('attachment', await p.attach(attachmentRequest()));
		if (outcome.status !== 'ok') {
			endpoint = null;
			return outcome;
		}
		endpoint = outcome.value;
		const current = deps.identity.read();
		if (current.status === 'ok') {
			const reported = managementFromEndpoint(endpoint.management, current.record.management);
			await deps.identity.write({
				...current.record,
				management: reported,
				policy: {
					desiredRevision: endpoint.desiredPolicyRevision,
					appliedRevision: endpoint.appliedPolicyRevision,
					observedAt: new Date(now()).toISOString(),
				},
			});
		}
		return outcome;
	}

	function custodyRefusal<T>(): LifecycleOutcome<T> | null {
		const read = deps.identity.read();
		if (read.status === 'unprotected') return refuse('custody-unprotected', read.message);
		if (read.status === 'untrusted') return refuse('custody-untrusted', read.message);
		return null;
	}

	const lifecycle: EnrollmentLifecycle = {
		status() {
			const identity = publicEnterpriseIdentity(deps.identity.read());
			const connection = port?.state() ?? null;
			let reason: string | null = null;
			if (identity.status !== 'ok')
				reason = identity.message ?? 'This installation holds no enrollment.';
			else if (identity.record?.management !== 'enrolled') {
				reason = `The record is ${identity.record?.management ?? 'absent'}, not enrolled.`;
			} else if (!connection || connection.closed) reason = 'No endpoint connection is open.';
			else if (connection.registration !== 'registered') {
				reason = 'This process has not redeemed an actor registration.';
			} else if (!connection.attached || !endpoint) reason = 'The connection is not attached.';
			else if (endpoint.management !== 'managed')
				reason = `The endpoint reports ${endpoint.management}.`;
			return {
				identity,
				connection,
				endpoint,
				authority: reason === null ? 'registered' : 'none',
				reason,
				pendingApproval,
				lastDenial,
			};
		},

		requestEnrollment: (input) =>
			serialized(async () => {
				const custody = custodyRefusal<EndpointEnrollmentResult>();
				if (custody) return custody;
				const current = deps.identity.read();
				if (current.status === 'ok') {
					return refuse(
						'already-enrolled',
						`This installation already holds a record (${current.record.management}) for ${current.record.endpoint.socketPath}.`
					);
				}
				let p: EndpointPort;
				try {
					p = portFor(input.socketPath);
				} catch (error) {
					return refuse('no-endpoint', error instanceof Error ? error.message : String(error));
				}
				const compat = relay(
					'compatibility',
					await p.compatibility({
						protocol: LOCAL_ENDPOINT_PROTOCOL,
						components: deps.components,
						requiredCapabilities: ['attachment'],
					})
				);
				if (compat.status !== 'ok') return compat;
				if (!compat.value.capabilities.includes('enrollment')) {
					return {
						status: 'unsupported',
						owner: 'mega-maestro',
						message: `The endpoint at ${input.socketPath} does not serve the enrollment operation; ${NO_OPERATION}`,
					};
				}
				const attached = await attach(p);
				if (attached.status !== 'ok') return attached;
				const request: EndpointEnrollmentRequest = {
					mode: input.mode,
					invitation: input.invitation,
					collectionProfile: input.collectionProfile,
					trustRootDigest: input.trustRootDigest,
					keyPossessionProof: input.keyPossessionProof,
				};
				const answered = relay('enrollment', await p.invoke('enrollment', request));
				if (answered.status !== 'ok') return answered;
				const result = answered.value as Partial<EndpointEnrollmentResult> | null;
				if (result?.outcome !== 'enrollment_pending' || typeof result.enrollmentId !== 'string') {
					return {
						status: 'unavailable',
						message: 'The enrollment answer is not an enrollment receipt.',
					};
				}
				await deps.identity.write({
					installationId: deps.installation.installationId,
					tenantId: input.tenantId,
					orgId: input.orgId,
					enrollmentId: result.enrollmentId,
					endpoint: {
						socketPath: input.socketPath,
						bindingDigest: input.trustRootDigest,
						trustRootDigest: input.trustRootDigest,
					},
					management: 'enrolling',
					registration: null,
					policy: {
						desiredRevision: endpoint?.desiredPolicyRevision ?? null,
						appliedRevision: endpoint?.appliedPolicyRevision ?? null,
						observedAt: new Date(now()).toISOString(),
					},
					enrolledAt: new Date(now()).toISOString(),
				});
				return {
					status: 'ok',
					value: { outcome: 'enrollment_pending', enrollmentId: result.enrollmentId },
				};
			}),

		connect: () =>
			serialized(async () => {
				const custody = custodyRefusal<EndpointStatus>();
				if (custody) return custody;
				const current = deps.identity.read();
				if (current.status !== 'ok')
					return refuse('not-enrolled', 'This installation holds no enrollment.');
				let p: EndpointPort;
				try {
					p = portFor(current.record.endpoint.socketPath);
				} catch (error) {
					return refuse('no-endpoint', error instanceof Error ? error.message : String(error));
				}
				if (p.state().attached) p.redial();
				return attach(p);
			}),

		beginRegistration: () =>
			serialized(async () => {
				const custody = custodyRefusal<RegistrationApprovalHandoff>();
				if (custody) return custody;
				const current = deps.identity.read();
				if (current.status !== 'ok')
					return refuse('not-enrolled', 'This installation holds no enrollment.');
				let p: EndpointPort;
				try {
					p = portFor(current.record.endpoint.socketPath);
				} catch (error) {
					return refuse('no-endpoint', error instanceof Error ? error.message : String(error));
				}
				const outcome = relay(
					'registration.challenge',
					await p.registration.challenge({
						runtimeId: deps.installation.runtimeId,
						processEpoch: deps.installation.processEpoch,
					})
				);
				if (outcome.status !== 'ok') {
					pendingApproval = null;
					return outcome;
				}
				const approval: EndpointRegistrationApproval = outcome.value;
				pendingApproval = { challengeId: approval.challengeId, expiresAt: approval.expiresAt };
				return { status: 'ok', value: { ...approval } };
			}),

		completeRegistration: () =>
			serialized(async () => {
				const custody = custodyRefusal<EndpointStatus>();
				if (custody) return custody;
				const current = deps.identity.read();
				if (current.status !== 'ok')
					return refuse('not-enrolled', 'This installation holds no enrollment.');
				if (!port || !pendingApproval || port.state().registration !== 'challenged') {
					pendingApproval = null;
					return refuse(
						'no-challenge',
						'No registration challenge is open on the current connection.'
					);
				}
				const challenge = pendingApproval;
				const redeemed = relay('registration.redeem', await port.registration.redeem());
				pendingApproval = null;
				if (redeemed.status !== 'ok') return redeemed;
				const at = new Date(now()).toISOString();
				await deps.identity.write({
					...current.record,
					registration: {
						challengeId: challenge.challengeId,
						actorId: null,
						runtimeId: deps.installation.runtimeId,
						processEpoch: deps.installation.processEpoch,
						bindingDigest: current.record.endpoint.bindingDigest,
						processBirthDigest: null,
						challengeDigest: challenge.challengeId,
						expiresAt: challenge.expiresAt,
						registeredAt: at,
					},
				});
				return attach(port);
			}),

		requestRotation: async () => ({
			status: 'unsupported',
			owner: 'mega-maestro',
			message: `Rotation: ${NO_OPERATION}`,
		}),
		requestRevocation: async () => ({
			status: 'unsupported',
			owner: 'mega-maestro',
			message: `Revocation: ${NO_OPERATION}`,
		}),
		requestRetirement: async () => ({
			status: 'unsupported',
			owner: 'mega-maestro',
			message: `Retirement: ${NO_OPERATION}`,
		}),

		acknowledgeRevocation: (input) => transition(input, 'revoked'),
		retire: (input) => transition(input, 'retired'),

		close: () =>
			serialized(async () => {
				pendingApproval = null;
				endpoint = null;
				const open = port;
				port = null;
				if (open) await open.close();
			}),
	};

	/** An explicit local transition; the record stays, as evidence of what this installation was. */
	function transition(
		input: { installationId: string },
		to: 'revoked' | 'retired'
	): Promise<LifecycleOutcome<ManagedIdentityManagement>> {
		return serialized(async () => {
			const custody = custodyRefusal<ManagedIdentityManagement>();
			if (custody) return custody;
			const current = deps.identity.read();
			if (current.status !== 'ok')
				return refuse('not-enrolled', 'This installation holds no enrollment.');
			if (current.record.installationId !== input.installationId) {
				return refuse(
					'installation-mismatch',
					`The record enrolls ${current.record.installationId}, not ${input.installationId}.`
				);
			}
			await deps.identity.write({ ...current.record, management: to, registration: null });
			if (port) port.redial();
			endpoint = null;
			return { status: 'ok', value: to };
		});
	}

	return lifecycle;
}

/**
 * The record's management state after the endpoint answered `reported`. The
 * endpoint's `managed` confirms an enrollment and completes an `enrolling`
 * one; `suspended` is recorded as such; `unenrolled` and `enrolling` from an
 * endpoint that we hold a completed record for are NOT a reason to forget it
 * (a reinstalled or rolled-back daemon is the endpoint's incident to resolve),
 * so the record keeps its state and the authority answers `none` from the
 * mismatch. A `revoked` or `retired` record is final here.
 */
export function managementFromEndpoint(
	reported: EndpointStatus['management'],
	current: ManagedIdentityManagement
): ManagedIdentityManagement {
	if (current === 'revoked' || current === 'retired') return current;
	switch (reported) {
		case 'managed':
			return 'enrolled';
		case 'suspended':
			return 'suspended';
		case 'enrolling':
			return current === 'enrolling' ? 'enrolling' : current;
		case 'unenrolled':
			return current;
	}
}
