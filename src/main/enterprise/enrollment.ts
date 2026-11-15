/**
 * The enrollment lifecycle: what this installation does with its identity
 * custody and the endpoint socket, one serialized step at a time.
 *
 * The endpoint owns enrollment. Its administrator enrolls, rotates and
 * retires the device through the endpoint's own tooling, holding the device
 * key Maestro never sees. What Maestro does is REQUEST and OBSERVE:
 *
 *   - `requestEnrollment` relays ONE enrollment phase (decision D1, contracts
 *     0.3.0): `request`, then `prove`, then `activate`, with the operator's
 *     central begin, prove and activate between them. It sends the phase only
 *     when the v2 `compatibility` probe offers `enrollment`, checks the answer
 *     is the phase's own outcome echoing the management it named, and only
 *     then writes: `request` an `enrolling` record, `prove` its enrollment
 *     id, `activate` `enrolled`. A denied or malformed answer writes nothing.
 *   - `beginRegistration` / `completeRegistration` run the runtime_use
 *     registration the endpoint consumes: `registration_challenge` on one
 *     connection, a browser approval by the actor, `registration_redeem` on
 *     the same connection, both v2 envelopes. The approval code is handed to
 *     the caller once and is neither persisted nor logged. A redeem whose
 *     answer was lost is recovered by reattaching with the existing claim and
 *     asking `registration_use`, never by registering again.
 *   - `connect` attaches (after a registration, when the endpoint requires
 *     one) and projects what the endpoint answered onto the record: the
 *     management state it reports and the policy revisions it holds. With
 *     the attachment on the one connection, followed by `registration_use`
 *     when it negotiated it.
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

import { canonicalJson } from '../../shared/canonicalJson';
import {
	ENDPOINT_ENROLLMENT_PHASE_OUTCOMES,
	ENROLLMENT_IDENTITY_PROTOCOL,
	LOCAL_ENDPOINT_PROTOCOL,
	LOCAL_ENDPOINT_REGISTRATION_USE_OPERATION,
	isEndpointDigest,
	type EndpointAttachmentRequest,
	type EndpointComponent,
	type EndpointEnrollmentActivation,
	type EndpointEnrollmentManagement,
	type EndpointEnrollmentPhaseRequest,
	type EndpointEnrollmentPhaseResult,
	type EndpointInvokeOutcome,
	type EndpointPossessionChallenge,
	type EndpointRuntimeUseReference,
	type EndpointPort,
	type EndpointRegistrationApproval,
	type EndpointUnavailableReason,
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
	/**
	 * Hears every attachment the endpoint accepted (a connect, a completed
	 * registration, a policy refresh), after the record observed it. Fired
	 * inside the serialized verb, so it must not call a lifecycle verb; a
	 * composer uses it to start work that follows an attach (MRC-11-05).
	 */
	onAttached?(status: EndpointStatus): void;
}

/** What every relayed phase carries besides its own body. */
interface EnrollmentPhaseCommon {
	socketPath: string;
	management: EndpointEnrollmentManagement;
}

/**
 * One relayed enrollment phase (decision D1). `request` also carries the
 * organization the operator asserts from the central console (the tenant is
 * the management's); the endpoint does not report it over the socket.
 */
export type EnrollmentRequestInput =
	| (EnrollmentPhaseCommon & {
			phase: 'request';
			orgId: string;
			serverCaPem: string;
	  })
	| (EnrollmentPhaseCommon & { phase: 'prove'; challenge: EndpointPossessionChallenge })
	| (EnrollmentPhaseCommon & { phase: 'activate'; activation: EndpointEnrollmentActivation });

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
	/** `reason` is the port's, when the port said why (`not-negotiated`, `malformed`, ...). */
	| { status: 'unavailable'; message: string; reason?: EndpointUnavailableReason }
	| { status: 'unknown'; message: string };

/**
 * What `useRegistration` did: the reference it wrote, or the endpoint's own
 * `registration_use` denial (nothing written).
 */
export type RegistrationUseResult =
	| { outcome: 'projected'; enrollmentId: string; processBirthDigest: string; expiresAt: string }
	| { outcome: 'denied'; reason: string };

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
	): Promise<LifecycleOutcome<EndpointEnrollmentPhaseResult>>;
	/** Dial the recorded endpoint and attach; after a restart the endpoint will want a registration first. */
	connect(): Promise<LifecycleOutcome<EndpointStatus>>;
	beginRegistration(): Promise<LifecycleOutcome<RegistrationApprovalHandoff>>;
	completeRegistration(): Promise<LifecycleOutcome<EndpointStatus>>;
	/**
	 * The v2 `registration_use` bootstrap: asks the endpoint for this process's
	 * enrollment reference and, on `projected`, writes `enrollmentId` onto the
	 * record and `processBirthDigest` onto its registration, keeping every
	 * other field. Sends nothing unless the v2 attachment negotiated it.
	 */
	useRegistration(): Promise<LifecycleOutcome<RegistrationUseResult>>;
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
	'the local endpoint protocol has no operation for this; the endpoint administrator performs it with the endpoint tooling (owner: mega-maestro, CP-04).';

export function createEnrollmentLifecycle(deps: EnrollmentLifecycleDeps): EnrollmentLifecycle {
	const now = deps.now ?? (() => Date.now());
	let port: EndpointPort | null = null;
	let endpoint: EndpointStatus | null = null;
	/** The `registration_use` reference projected on one connection (by its count), and its expiry. */
	let registrationUse: {
		connection: number;
		reference: EndpointRuntimeUseReference;
		expiresAt: string;
	} | null = null;
	/**
	 * The open challenge: its id, the digest the actor approves, and when it lapses.
	 * The digest is kept for the registration record only; `status()` projects the
	 * id and expiry, never the digest.
	 */
	let pendingApproval: { challengeId: string; challengeDigest: string; expiresAt: string } | null =
		null;
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
				return {
					status: 'unavailable',
					message: `${operation}: ${outcome.message}`,
					reason: outcome.reason,
				};
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
			registrationUse = null;
		}
		port ??= deps.openPort(socketPath);
		return port;
	}

	/** The attachment on `p`, the one connection every caller reads. */
	async function attachOn(p: EndpointPort): Promise<LifecycleOutcome<EndpointStatus>> {
		return relay('attachment', await p.attach(attachmentRequest()));
	}

	/**
	 * `registration_use` on `p`: on `projected`, the reference is kept for this
	 * connection and its `enrollmentId` and `processBirthDigest` are written onto
	 * the record (every other field kept). Never computed here; a denial writes
	 * nothing. Sends nothing unless the attachment on `p` negotiated it.
	 */
	async function projectRegistrationUse(
		p: EndpointPort
	): Promise<LifecycleOutcome<RegistrationUseResult>> {
		const outcome = relay(LOCAL_ENDPOINT_REGISTRATION_USE_OPERATION, await p.registration.use());
		if (outcome.status !== 'ok') return outcome;
		const reply = outcome.value;
		if (reply.outcome === 'denied') {
			registrationUse = null;
			return { status: 'ok', value: { outcome: 'denied', reason: reply.reason } };
		}
		const { enrollmentId, processBirthDigest } = reply.reference;
		registrationUse = {
			connection: p.state().connection,
			reference: structuredClone(reply.reference),
			expiresAt: reply.expiresAt,
		};
		// Re-read inside the step: the write keeps whatever the record holds now.
		const latest = deps.identity.read();
		if (latest.status === 'ok' && latest.record.registration) {
			await deps.identity.write({
				...latest.record,
				enrollmentId,
				registration: { ...latest.record.registration, processBirthDigest },
			});
		}
		return {
			status: 'ok',
			value: { outcome: 'projected', enrollmentId, processBirthDigest, expiresAt: reply.expiresAt },
		};
	}

	/** The projected reference while it is this connection's and has not lapsed. */
	function currentRegistrationUse(): typeof registrationUse {
		if (!registrationUse || !port) return null;
		const state = port.state();
		if (state.closed || !state.attached || state.connection !== registrationUse.connection)
			return null;
		return Date.parse(registrationUse.expiresAt) > now() ? registrationUse : null;
	}

	/** Attach on `p` and fold what the endpoint said into the record, when there is one. */
	async function attach(p: EndpointPort): Promise<LifecycleOutcome<EndpointStatus>> {
		registrationUse = null;
		const outcome = await attachOn(p);
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
		// The production caller of `registration_use`: every v2 attachment that
		// negotiated it asks for the reference the workflow and command contexts carry.
		if (p.negotiated(LOCAL_ENDPOINT_REGISTRATION_USE_OPERATION)) {
			await projectRegistrationUse(p);
		}
		deps.onAttached?.(endpoint);
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
			else if (connection.registration !== 'registered' && !currentRegistrationUse()) {
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
				pendingApproval: pendingApproval
					? { challengeId: pendingApproval.challengeId, expiresAt: pendingApproval.expiresAt }
					: null,
				lastDenial,
				registrationUse: (() => {
					const use = currentRegistrationUse();
					return use
						? { reference: structuredClone(use.reference), expiresAt: use.expiresAt }
						: null;
				})(),
			};
		},

		requestEnrollment: (input) =>
			serialized(async (): Promise<LifecycleOutcome<EndpointEnrollmentPhaseResult>> => {
				const custody = custodyRefusal<EndpointEnrollmentPhaseResult>();
				if (custody) return custody;
				const current = deps.identity.read();
				if (input.phase === 'request') {
					if (current.status === 'ok') {
						return refuse(
							'already-enrolled',
							`This installation already holds a record (${current.record.management}) for ${current.record.endpoint.socketPath}.`
						);
					}
				} else {
					// `prove` and `activate` continue an enrollment this installation requested.
					if (current.status !== 'ok' || current.record.management !== 'enrolling') {
						return refuse(
							'not-enrolled',
							`No requested enrollment is open; ${input.phase} follows the request phase.`
						);
					}
					if (
						current.record.tenantId !== input.management.tenantId ||
						current.record.endpoint.socketPath !== input.socketPath
					) {
						return refuse(
							'installation-mismatch',
							`The requested enrollment names tenant ${current.record.tenantId} at ${current.record.endpoint.socketPath}.`
						);
					}
					if (input.phase === 'activate' && current.record.enrollmentId === null) {
						return refuse('not-enrolled', 'Activation follows a signed possession proof (prove).');
					}
				}
				let p: EndpointPort;
				try {
					p = portFor(input.socketPath);
				} catch (error) {
					return refuse('no-endpoint', error instanceof Error ? error.message : String(error));
				}
				// Availability first: an endpoint that does not offer enrollment to this
				// peer is answered `unsupported` and nothing is relayed.
				const probe = relay(
					'compatibility',
					await p.compatibility({
						supportedProtocols: [LOCAL_ENDPOINT_PROTOCOL],
						supportedCapabilities: ['enrollment'],
						requiredCapabilities: [],
					})
				);
				if (probe.status === 'denied' && probe.reason === 'unsupported_capability') {
					return {
						status: 'unsupported',
						owner: 'mega-maestro',
						message: `The endpoint at ${input.socketPath} does not offer relayed enrollment to this peer.`,
					};
				}
				if (probe.status !== 'ok') return probe;
				if (!probe.value.capabilities.includes('enrollment')) {
					return {
						status: 'unsupported',
						owner: 'mega-maestro',
						message: `The endpoint at ${input.socketPath} does not offer relayed enrollment to this peer.`,
					};
				}
				const request: EndpointEnrollmentPhaseRequest =
					input.phase === 'request'
						? {
								phase: 'request',
								management: { ...input.management },
								serverCaPem: input.serverCaPem,
								identity: {
									...attachmentRequest(),
									supportedProtocols: [ENROLLMENT_IDENTITY_PROTOCOL],
								},
							}
						: input.phase === 'prove'
							? {
									phase: 'prove',
									management: { ...input.management },
									challenge: { ...input.challenge },
								}
							: {
									phase: 'activate',
									management: { ...input.management },
									activation: structuredClone(input.activation),
								};
				const answered = relay('enrollment', await p.invoke('enrollment', request));
				if (answered.status !== 'ok') return answered;
				const problems = enrollmentPhaseResultProblems(
					input.phase,
					request.management,
					answered.value
				);
				if (problems.length > 0) {
					return {
						status: 'unavailable',
						reason: 'malformed',
						message: `enrollment: the ${input.phase} answer is not the phase's own: ${problems.join('; ')}`,
					};
				}
				const result = answered.value as EndpointEnrollmentPhaseResult;
				const at = new Date(now()).toISOString();
				if (result.outcome === 'enrollment_requested' && input.phase === 'request') {
					await deps.identity.write({
						installationId: deps.installation.installationId,
						tenantId: input.management.tenantId,
						orgId: input.orgId,
						enrollmentId: null,
						endpoint: {
							socketPath: input.socketPath,
							bindingDigest: input.management.issuerSha256,
							trustRootDigest: input.management.issuerSha256,
						},
						management: 'enrolling',
						registration: null,
						policy: { desiredRevision: null, appliedRevision: null, observedAt: at },
						enrolledAt: at,
					});
				} else {
					const latest = deps.identity.read();
					if (latest.status !== 'ok') {
						return refuse('not-enrolled', 'The record changed before the phase could be written.');
					}
					const enrollmentId =
						result.outcome === 'possession_signed' || result.outcome === 'enrolled'
							? result.enrollmentId
							: latest.record.enrollmentId;
					await deps.identity.write({
						...latest.record,
						enrollmentId,
						...(result.outcome === 'enrolled' ? { management: 'enrolled' as const } : {}),
					});
				}
				return { status: 'ok', value: structuredClone(result) };
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
				pendingApproval = {
					challengeId: approval.challengeId,
					challengeDigest: approval.challengeDigest,
					expiresAt: approval.expiresAt,
				};
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
				const p = port;
				const redeemed = relay('registration.redeem', await p.registration.redeem());
				pendingApproval = null;
				const record = () => ({
					...current.record,
					registration: {
						challengeId: challenge.challengeId,
						actorId: null,
						runtimeId: deps.installation.runtimeId,
						processEpoch: deps.installation.processEpoch,
						bindingDigest: current.record.endpoint.bindingDigest,
						processBirthDigest: null,
						challengeDigest: challenge.challengeDigest,
						expiresAt: challenge.expiresAt,
						registeredAt: new Date(now()).toISOString(),
					},
				});
				if (redeemed.status === 'unknown') {
					// The redeem may have published the registration before its answer was
					// lost. Reattach with the existing claim and ask registration_use; never
					// register again. Only a projected reference proves it.
					p.redial();
					const reattached = await attach(p);
					if (reattached.status !== 'ok' || !currentRegistrationUse()) return redeemed;
					await deps.identity.write(record());
					await projectRegistrationUse(p);
					return reattached;
				}
				if (redeemed.status !== 'ok') return redeemed;
				await deps.identity.write(record());
				return attach(p);
			}),

		useRegistration: () =>
			serialized(async (): Promise<LifecycleOutcome<RegistrationUseResult>> => {
				const custody = custodyRefusal<RegistrationUseResult>();
				if (custody) return custody;
				const current = deps.identity.read();
				if (current.status !== 'ok')
					return refuse('not-enrolled', 'This installation holds no enrollment.');
				if (!current.record.registration) {
					return refuse('no-challenge', 'This installation holds no completed registration.');
				}
				if (!port) {
					return {
						status: 'unavailable',
						reason: 'not-negotiated',
						message: 'registration_use: no connection is open; nothing was sent.',
					};
				}
				return projectRegistrationUse(port);
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
				registrationUse = null;
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

/**
 * Why an `enrollment` answer is not the outcome `phase` must answer, echoing
 * `management` exactly, or []. Structural; the endpoint is the authority on
 * its own schema.
 */
export function enrollmentPhaseResultProblems(
	phase: EndpointEnrollmentPhaseRequest['phase'],
	management: EndpointEnrollmentManagement,
	value: unknown
): string[] {
	if (typeof value !== 'object' || value === null || Array.isArray(value))
		return ['the answer is not an object'];
	const answer = value as Record<string, unknown>;
	const problems: string[] = [];
	const id = (key: string) =>
		typeof answer[key] === 'string' && (answer[key] as string).length > 0
			? null
			: `${key} is not an id`;
	if (answer.outcome !== ENDPOINT_ENROLLMENT_PHASE_OUTCOMES[phase]) {
		problems.push(`outcome is not ${ENDPOINT_ENROLLMENT_PHASE_OUTCOMES[phase]}`);
	}
	if (canonicalJson(answer.management) !== canonicalJson(management)) {
		problems.push('management is not the one this phase named');
	}
	const keyStorage = (v: unknown) => v === 'software' || v === 'platform_non_exportable';
	if (phase === 'request') {
		const requestId = id('requestId');
		if (requestId) problems.push(requestId);
		const identity = answer.identity as Record<string, unknown> | undefined;
		if (
			!identity ||
			typeof identity.publicKeyPem !== 'string' ||
			!/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\r?\n?$/.test(
				identity.publicKeyPem
			)
		) {
			problems.push('identity does not carry exactly a public key');
		} else if (!keyStorage(identity.keyStorage)) problems.push('identity.keyStorage is unknown');
	} else if (phase === 'prove') {
		for (const key of ['enrollmentId', 'challengeId']) {
			const problem = id(key);
			if (problem) problems.push(problem);
		}
		if (typeof answer.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(answer.signature))
			problems.push('signature is not a possession signature');
	} else {
		const enrollmentId = id('enrollmentId');
		if (enrollmentId) problems.push(enrollmentId);
		if (!keyStorage(answer.keyStorage)) problems.push('keyStorage is unknown');
	}
	if (!isEndpointDigest(management.issuerSha256))
		problems.push('management.issuerSha256 is not a digest');
	return problems;
}
