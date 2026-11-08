/**
 * Desktop authoring schema 1 mapped to Maestro's existing host vocabulary.
 * The host supplies the verified public schema and current binding. Parsing and
 * mapping describe choices only; neither authenticates a caller nor permits a
 * mutation. Revalidate policy, custody and selections at the mutation sink.
 * DESKTOP-LOCAL/1 in contract-coverage.json records the missing endpoint delivery.
 * No operation or capability is advertised by this module.
 */
import { canonicalJson } from '../../canonicalJson';
import {
	agentConfigLockKey,
	isSettingLockable,
	type ManagedSettingLockView,
	type ManagedSettingLocksView,
} from '../../managedSettingsLock';
import { SETTINGS_METADATA } from '../../settingsMetadata';
import type { AgentCreateInput, AgentPatch } from '../client/types';
import type { CredentialLaunchBinding, ManagedCredentialRef } from './credentials';

export type DesktopAuthoringOperation = 'create' | 'edit' | 'clone' | 'import';
export type DesktopChoiceKind =
	| 'provider'
	| 'model'
	| 'account'
	| 'workspace'
	| 'tool'
	| 'automation'
	| 'credential';
export type DesktopChoice =
	| { kind: 'provider' | 'workspace' | 'tool' | 'automation'; ref: string }
	| { kind: 'model' | 'account'; ref: string; providerRef: string }
	| { kind: 'credential'; ref: string; accountRef: string };
export type DesktopFieldPolicy =
	| { state: 'locked'; values: readonly string[] }
	| { state: 'constrained'; allowed: readonly string[]; minimum: number; maximum: number }
	| { state: 'user_editable'; allowed: readonly string[] };

/** Public verifier-output shape, never caller-supplied identity authority. */
export interface DesktopPolicyBinding {
	tenantId: string;
	orgId: string;
	principal: { id: string; kind: 'user' | 'service' };
	enrollmentId: string;
	installationId: string;
	runtimeId: string;
	processEpoch: string;
	policyId: string;
	policyRevision: number;
	policyDigest: string;
}

export interface DesktopPolicyProjection {
	schemaVersion: 1;
	binding: DesktopPolicyBinding;
	issuedAt: string;
	expiresAt: string;
	operations: readonly DesktopAuthoringOperation[];
	choices: readonly DesktopChoice[];
	fields: Record<DesktopChoiceKind, DesktopFieldPolicy>;
}

export type DesktopPolicyResult =
	| { outcome: 'available'; projection: DesktopPolicyProjection }
	| {
			outcome: 'denied';
			reason: 'unauthenticated' | 'binding_mismatch' | 'policy_denied' | 'unsupported_version';
	  }
	| {
			outcome: 'unavailable';
			reason: 'policy_missing' | 'policy_expired' | 'runtime_unavailable' | 'mapping_unavailable';
	  };

/** Inject the pinned desktopPolicyResult schema after archive verification. */
export interface DesktopPolicySchemaPort {
	safeParse(raw: unknown): { success: false } | { success: true; data: DesktopPolicyResult };
}

/** Destinations describe host resolution, never assignment of an opaque ref as a value/path. */
export type DesktopHostOption =
	| {
			kind: 'agent-option';
			field: keyof Pick<AgentCreateInput & AgentPatch, 'provider' | 'model' | 'cwd'>;
	  }
	| { kind: 'credential-binding'; field: keyof Pick<CredentialLaunchBinding, 'accountRef'> }
	| { kind: 'credential-reference'; field: keyof Pick<ManagedCredentialRef, 'refId'> }
	| { kind: 'unavailable'; reason: 'mapping_unavailable' };

export interface DesktopAuthoringField {
	policy: DesktopFieldPolicy;
	choices: readonly DesktopChoice[];
	host: DesktopHostOption;
	/** UI feedback only; the host still decides every write. */
	editable: boolean;
	minimum: number;
	maximum: number;
	/** The existing settings write authority's refusal, preserved independently of selection bounds. */
	localLock?: ManagedSettingLockView;
}

export type DesktopAuthoringView =
	| Exclude<DesktopPolicyResult, { outcome: 'available' }>
	| {
			outcome: 'available';
			authority: 'none';
			projection: DesktopPolicyProjection;
			fields: Record<DesktopChoiceKind, DesktopAuthoringField>;
			settings: ManagedSettingLocksView;
			/** Preferences outside the security projection; no preference values are copied. */
			personalSettingKeys: readonly string[];
	  };

const HOST_OPTIONS: Record<DesktopChoiceKind, DesktopHostOption> = {
	provider: { kind: 'agent-option', field: 'provider' },
	model: { kind: 'agent-option', field: 'model' },
	workspace: { kind: 'agent-option', field: 'cwd' },
	account: { kind: 'credential-binding', field: 'accountRef' },
	credential: { kind: 'credential-reference', field: 'refId' },
	// There is no generic tool/automation selection field on AgentCreateInput.
	tool: { kind: 'unavailable', reason: 'mapping_unavailable' },
	automation: { kind: 'unavailable', reason: 'mapping_unavailable' },
};

/**
 * Pure display mapping. Absent schema/binding, malformed data, stale policy and
 * mismatched settings never fall back to unrestricted choices. The schema port
 * owns wire validation; keep its bounded catalog and strict shapes in one place.
 */
export function mapDesktopPolicy(
	raw: unknown,
	input: {
		schema: DesktopPolicySchemaPort | null;
		binding: DesktopPolicyBinding | null;
		settings: ManagedSettingLocksView;
		now: number;
	}
): DesktopAuthoringView {
	const unavailable = { outcome: 'unavailable', reason: 'mapping_unavailable' } as const;
	try {
		if (!input.schema) return unavailable;
		const parsed = input.schema.safeParse(raw);
		if (!parsed.success) return unavailable;
		if (parsed.data.outcome !== 'available') return parsed.data;
		if (!input.binding) return { outcome: 'denied', reason: 'unauthenticated' };
		const projection = parsed.data.projection;
		if (canonicalJson(projection.binding) !== canonicalJson(input.binding))
			return { outcome: 'denied', reason: 'binding_mismatch' };
		if (
			!Number.isFinite(input.now) ||
			input.now < Date.parse(projection.issuedAt) ||
			input.now >= Date.parse(projection.expiresAt)
		)
			return { outcome: 'unavailable', reason: 'policy_expired' };
		if (input.settings.policyRevision !== projection.binding.policyRevision) return unavailable;
		const fields = {} as Record<DesktopChoiceKind, DesktopAuthoringField>;
		for (const kind of Object.keys(HOST_OPTIONS) as DesktopChoiceKind[]) {
			const policy = projection.fields[kind];
			const refs = policy.state === 'locked' ? policy.values : policy.allowed;
			const localLock =
				kind === 'model' ? input.settings.locks[agentConfigLockKey('model')!] : undefined;
			const singleton = ['provider', 'model', 'account', 'workspace'].includes(kind);
			fields[kind] = {
				policy,
				choices: projection.choices.filter(
					(choice) => choice.kind === kind && refs.includes(choice.ref)
				),
				host: { ...HOST_OPTIONS[kind] },
				editable:
					policy.state !== 'locked' && !localLock && HOST_OPTIONS[kind].kind !== 'unavailable',
				minimum:
					policy.state === 'locked'
						? refs.length
						: policy.state === 'constrained'
							? policy.minimum
							: 0,
				maximum:
					policy.state === 'constrained'
						? policy.maximum
						: Math.min(refs.length, singleton ? 1 : 128),
				...(localLock ? { localLock } : {}),
			};
		}
		return {
			outcome: 'available',
			authority: 'none',
			projection,
			fields,
			settings: input.settings,
			personalSettingKeys: Object.keys(SETTINGS_METADATA).filter(
				(key) => !isSettingLockable(key) && !SETTINGS_METADATA[key].sensitive
			),
		};
	} catch {
		// Schema failures may include the input: never expose their messages.
		return unavailable;
	}
}
