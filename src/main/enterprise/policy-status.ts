/**
 * Policy status for the desktop and the CLI: what policy this installation is
 * under, how fresh that knowledge is, and the two authenticated ways to make
 * it fresher.
 *
 * The projection itself (`projectPolicyStatus`) is the library's, so a
 * headless host reads the same answer; this module binds it to the
 * enrollment lifecycle and names the only update and recovery paths Maestro
 * has:
 *
 *   - `refresh()` re-attaches over the registered socket. The attachment
 *     answer is where the endpoint states its desired and applied revisions,
 *     so a successful attach is an authenticated status update, and the
 *     lifecycle writes what it heard into the sealed record.
 *   - `recover()` is for a standing the refresh cannot repair: no actor
 *     registration in this process (a restart), or an endpoint that refused
 *     the attachment as unauthenticated (a revoked or expired registration).
 *     It opens a new registration challenge, which the actor must approve in
 *     the browser; the handoff goes back to the caller. Nothing here approves
 *     anything on the actor's behalf, and nothing here provisions, installs
 *     or recovers policy on the endpoint: those are the endpoint
 *     administrator's verbs on the endpoint's own tooling.
 *
 * Offline, the record's last applied revision stays the installed policy and
 * the projection says so (`installed-policy-only`); it never bootstraps a
 * standalone answer. A stale observation, a lapsed registration or a lapsed
 * approval is projected as a reason admission is not possible, which is also
 * exactly what the host adapter refuses on.
 */

import { z } from 'zod';
import { canonicalJson } from '../../shared/canonicalJson';
import type { ManagedRouteCeiling } from '../../shared/maestro-lib/launch/env';
import {
	parseManagedSettingsPolicy,
	type ManagedSettingsPolicy,
	type ManagedSettingsPolicyPort,
} from '../../shared/managedSettingsLock';
import type {
	DesktopPolicyProjection,
	DesktopPolicySchemaPort,
} from '../../shared/maestro-lib/managed/desktop-contract';
import {
	isEndpointDigest,
	isEndpointIdentifier,
	type EndpointStatus,
	type ManagedIdentityRecord,
} from '../../shared/maestro-lib/managed/endpoint-port';
import { isPlainObject, unknownKeys, parseBrowserPolicyCeiling } from './browser-policy';
import { parseShellPolicyCeiling } from './shell-policy';
import { parsePluginPolicyCeiling } from './plugin-policy';
import { parseInstallPolicyCeiling } from './install-policy';
import { parseEgressPolicyCeiling } from './egress-policy';
import { parseListenerPolicyCeiling } from './listener-policy';
import { parseLocalEffectsPolicyCeiling } from './local-effects-policy';
import { parseRepositoryPolicyCeiling } from './repository-policy';
import { parseUpdatePolicyCeiling } from './update-policy';
import {
	POLICY_FRESHNESS_MS,
	projectPolicyStatus,
	type ManagedPolicyStatus,
} from '../../shared/maestro-lib/managed/host-adapter';
import type {
	EnrollmentLifecycle,
	LifecycleOutcome,
	RegistrationApprovalHandoff,
} from './enrollment';

export interface PolicyStatusServiceDeps {
	lifecycle: Pick<EnrollmentLifecycle, 'status' | 'connect' | 'beginRegistration'>;
	/** Trusted host injection after authenticated negotiation; never renderer JSON. */
	projections?: () => NativePolicyProjectionPort | null;
	now?: () => number;
	/** How long an attachment answer counts as fresh. Default `POLICY_FRESHNESS_MS`. */
	freshnessMs?: number;
}

const ceilingParsers = {
	browser: parseBrowserPolicyCeiling,
	shell: parseShellPolicyCeiling,
	plugins: parsePluginPolicyCeiling,
	install: parseInstallPolicyCeiling,
	egress: parseEgressPolicyCeiling,
	listeners: parseListenerPolicyCeiling,
	localEffects: parseLocalEffectsPolicyCeiling,
	repository: parseRepositoryPolicyCeiling,
	updates: parseUpdatePolicyCeiling,
};
const routeSchema = z.strictObject({
	providerId: z.string().refine(isEndpointIdentifier),
	model: z.string().min(1).max(256).nullable(),
	baseUrl: z
		.url()
		.refine((value) => {
			const url = new URL(value);
			return (
				['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.hash
			);
		})
		.nullable(),
	accountDir: z.string().min(1).max(4096).nullable(),
	login: z.enum(['approved-credential', 'provider-login']),
	permissionMode: z.enum(['readonly', 'standard', 'full']).nullable(),
});

/** One host-only batch. References are metadata; this object grants no execution. */
export interface NativePolicyProjection {
	desktop: DesktopPolicyProjection;
	settings: ManagedSettingsPolicy;
	routes: ManagedRouteCeiling[];
	ceilings: {
		[K in keyof typeof ceilingParsers]: Extract<
			ReturnType<(typeof ceilingParsers)[K]>,
			{ ok: true }
		>['ceiling'];
	};
}

/**
 * Local DESKTOP-LOCAL/1 seam, not a published endpoint operation. The producer
 * MUST verify the signature over the ENTIRE batch, including native ceilings,
 * against this identity's trust root, registration and applied revision before
 * returning. The schema alone proves no authenticity. No production producer is
 * supplied until the public delivery/signature mapping is negotiated.
 */
export interface NativePolicyProjectionPort {
	readonly version: 1;
	readonly schema: DesktopPolicySchemaPort;
	readVerified(input: { identity: ManagedIdentityRecord; connection: number }): Promise<unknown>;
}

export type PolicyProjectionInstall =
	| { installed: true; policyRevision: number }
	| { installed: false; reason: 'unavailable' | 'invalid' | 'changed' };

export type PolicyRecovery =
	| { status: 'refreshed'; value: EndpointStatus }
	| { status: 'approval-required'; handoff: RegistrationApprovalHandoff }
	| { status: 'not-needed' }
	| Exclude<LifecycleOutcome<never>, { status: 'ok' }>;

export interface PolicyStatusService {
	status(): ManagedPolicyStatus;
	/** Host-only settings consumer port; never a renderer authority. */
	readonly settings: ManagedSettingsPolicyPort;
	refreshProjection(): Promise<PolicyProjectionInstall>;
	/** Last verified restrictions, including offline. Never a grant or fresh choice list. */
	installedProjection(): NativePolicyProjection | null;
	/** An authenticated status update: re-attach over the registered socket. */
	refresh(): Promise<LifecycleOutcome<EndpointStatus>>;
	/**
	 * Repair a standing a refresh cannot: open a new actor registration when
	 * this process holds none or the endpoint refused the last one; otherwise
	 * refresh. The approval handoff, when one is returned, is the actor's to
	 * complete through `completeRegistration` on the lifecycle.
	 */
	recover(): Promise<PolicyRecovery>;
}

export function createPolicyStatusService(deps: PolicyStatusServiceDeps): PolicyStatusService {
	const now = deps.now ?? (() => Date.now());
	const freshnessMs = deps.freshnessMs ?? POLICY_FRESHNESS_MS;
	let installed: { scope: string; value: NativePolicyProjection; content: string } | null = null;
	let request = 0;
	const settingsListeners = new Set<() => void>();
	const scope = () => {
		const identity = deps.lifecycle.status().identity;
		const record = identity.status === 'ok' ? identity.record : null;
		return record
			? canonicalJson({
					tenant: record.tenantId,
					org: record.orgId,
					enrollment: record.enrollmentId,
					installation: record.installationId,
					actor: record.registration?.actorId,
					endpoint: record.endpoint,
				})
			: null;
	};
	const generation = () => canonicalJson(deps.lifecycle.status());
	const installProjection = async (): Promise<PolicyProjectionInstall> => {
		const attempt = ++request;
		try {
			const port = deps.projections?.();
			const standing = deps.lifecycle.status();
			const record = standing.identity.status === 'ok' ? standing.identity.record : null;
			const registration = record?.registration;
			const policy = projectPolicyStatus({ standing, now: now(), freshnessMs });
			if (
				!port ||
				port.version !== 1 ||
				!record ||
				!registration?.actorId ||
				record.management !== 'enrolled' ||
				!record.enrollmentId ||
				!isEndpointDigest(record.endpoint.trustRootDigest) ||
				registration.bindingDigest !== record.endpoint.bindingDigest ||
				!Number.isFinite(Date.parse(registration.expiresAt)) ||
				Date.parse(registration.expiresAt) <= now() ||
				!policy.admission.possible ||
				policy.connectivity !== 'online' ||
				policy.management !== 'managed' ||
				standing.connection?.registration !== 'registered' ||
				!standing.connection.attached ||
				standing.connection.closed ||
				policy.appliedRevision !== record.policy.appliedRevision
			)
				return { installed: false, reason: 'unavailable' };
			const before = generation(),
				source = scope()!;
			const raw = structuredClone(
				await port.readVerified({
					identity: structuredClone(record),
					connection: standing.connection.connection,
				})
			);
			if (attempt !== request || port !== deps.projections?.() || before !== generation())
				return { installed: false, reason: 'changed' };
			if (
				!isPlainObject(raw) ||
				unknownKeys(raw, ['desktop', 'settings', 'routes', 'ceilings'], '').length ||
				!isPlainObject(raw.ceilings) ||
				unknownKeys(raw.ceilings, Object.keys(ceilingParsers), '').length
			)
				return { installed: false, reason: 'invalid' };
			const desktop = port.schema.safeParse({ outcome: 'available', projection: raw.desktop });
			const settings = parseManagedSettingsPolicy(raw.settings);
			const routes = z.array(routeSchema).max(128).safeParse(raw.routes);
			if (
				!desktop.success ||
				desktop.data.outcome !== 'available' ||
				!settings.ok ||
				!routes.success
			)
				return { installed: false, reason: 'invalid' };
			const projection = desktop.data.projection,
				binding = projection.binding;
			const current = projectPolicyStatus({
				standing: deps.lifecycle.status(),
				now: now(),
				freshnessMs,
			});
			if (
				!current.admission.possible ||
				now() < Date.parse(projection.issuedAt) ||
				now() >= Date.parse(projection.expiresAt) ||
				binding.tenantId !== record.tenantId ||
				binding.orgId !== record.orgId ||
				binding.enrollmentId !== record.enrollmentId ||
				binding.installationId !== record.installationId ||
				binding.runtimeId !== registration.runtimeId ||
				binding.processEpoch !== registration.processEpoch ||
				binding.principal.id !== registration.actorId ||
				binding.principal.kind !== 'user' ||
				binding.policyRevision !== current.appliedRevision ||
				settings.policy.policyRevision !== binding.policyRevision ||
				new Set(routes.data.map((route) => route.providerId)).size !== routes.data.length
			)
				return { installed: false, reason: 'invalid' };
			const ceilings = {} as NativePolicyProjection['ceilings'];
			for (const key of Object.keys(ceilingParsers) as (keyof typeof ceilingParsers)[]) {
				const parsed = ceilingParsers[key](raw.ceilings[key]);
				if (!parsed.ok || parsed.ceiling.policyRevision !== binding.policyRevision)
					return { installed: false, reason: 'invalid' };
				Object.assign(ceilings, { [key]: parsed.ceiling });
			}
			const value: NativePolicyProjection = {
				desktop: projection,
				settings: settings.policy,
				routes: routes.data,
				ceilings,
			};
			const { issuedAt: _issued, expiresAt: _expires, ...stable } = projection;
			const content = canonicalJson({ ...value, desktop: stable });
			if (
				installed?.scope === source &&
				(binding.policyRevision < installed.value.desktop.binding.policyRevision ||
					(binding.policyRevision === installed.value.desktop.binding.policyRevision &&
						(content !== installed.content ||
							Date.parse(projection.issuedAt) < Date.parse(installed.value.desktop.issuedAt))))
			)
				return { installed: false, reason: 'invalid' };
			// One assignment after every validation. No listener can observe a partial batch.
			installed = { scope: source, value: structuredClone(value), content };
			return { installed: true, policyRevision: binding.policyRevision };
		} catch {
			// A producer may throw with signed/private input in its error; expose no payload.
			return { installed: false, reason: 'unavailable' };
		}
	};
	const refreshProjection = async (): Promise<PolicyProjectionInstall> => {
		const result = await installProjection();
		if (result.installed) {
			// All sinks see the complete batch. A failed restorer must neither
			// prevent the others running nor be mistaken for a transport failure.
			const errors: unknown[] = [];
			for (const listener of [...settingsListeners]) {
				try {
					listener();
				} catch (error) {
					errors.push(error);
				}
			}
			if (errors.length) throw errors[0];
		}
		return result;
	};
	const refresh = async () => {
		const result = await deps.lifecycle.connect();
		if (result.status === 'ok') await refreshProjection();
		return result;
	};

	return {
		settings: {
			read: () =>
				installed && installed.scope === scope() ? structuredClone(installed.value.settings) : null,
			onChange(listener) {
				settingsListeners.add(listener);
				return () => settingsListeners.delete(listener);
			},
		},
		refreshProjection,
		installedProjection: () =>
			installed && installed.scope === scope() ? structuredClone(installed.value) : null,
		status: () =>
			projectPolicyStatus({ standing: deps.lifecycle.status(), now: now(), freshnessMs }),

		refresh,

		async recover() {
			const before = deps.lifecycle.status();
			if (before.identity.status !== 'ok') {
				return {
					status: 'refused',
					reason: before.identity.status === 'none' ? 'not-enrolled' : 'custody-untrusted',
					message: before.identity.message ?? 'This installation holds no enrollment.',
				};
			}
			const registrationMissing =
				!before.connection ||
				before.connection.registration !== 'registered' ||
				before.lastDenial?.reason === 'unauthenticated';
			if (!registrationMissing) {
				const refreshed = await refresh();
				return refreshed.status === 'ok'
					? { status: 'refreshed', value: refreshed.value }
					: refreshed;
			}
			const begun = await deps.lifecycle.beginRegistration();
			if (begun.status !== 'ok') return begun;
			return { status: 'approval-required', handoff: begun.value };
		},
	};
}
