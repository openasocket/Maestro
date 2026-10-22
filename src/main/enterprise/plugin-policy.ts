/**
 * The plugin ceiling a managed desktop holds its plugins to (MRC-09-03).
 *
 * `src/main/plugins/permission-broker.ts` intersects every plugin call, and
 * every live hold on a resource a plugin keeps (a retained service call, a
 * delegated media lease, an open socket, a resolved path), with the signed
 * ceiling of the policy revision this host is under. This module is where
 * that ceiling comes from and how it is bound to the revision:
 *
 *   - `parsePluginPolicyCeiling()` validates a ceiling DOCUMENT in full. The
 *     schema is closed and bounded in every dimension: one unknown key, one
 *     unknown capability, one malformed entry or one duplicate plugin refuses
 *     the whole document by name. Nothing is coerced and nothing is dropped
 *     silently; a ceiling the broker holds a call against is exactly the one
 *     the endpoint issued, or none.
 *   - `createPluginPolicySource()` holds at most one installed ceiling and
 *     projects the standing the broker reads on every call: standalone for
 *     an installation that was never enrolled, and from then on managed, with
 *     the installed ceiling when it was issued for the applied revision and a
 *     reason instead when none is installed, the applied revision is unknown
 *     or the installation is for another revision (`managedPluginStanding`).
 *     A refused document keeps the previous installation; a cleared source
 *     holds nothing. The ceiling lives in memory only: a restart holds none
 *     until the endpoint hands it over again, which is the fail-closed answer
 *     (the broker refuses by name until then) and never a bootstrap to consent
 *     alone.
 *
 * Who may install is the caller's proof, not this module's: `install()` is
 * for a document read over the registered, attached endpoint connection, the
 * same connection the policy status itself is heard on. Honest state: no
 * endpoint operation of this build carries a plugin ceiling
 * (`LOCAL_ENDPOINT_OPERATIONS` names none; CP-01), so the desktop composes the
 * source and nothing calls `install()` yet, and an enrolled desktop refuses
 * every plugin call as `unavailable`, by name, exactly as before.
 */

import type { ManagedPolicyStatus } from '../../shared/maestro-lib/managed/host-adapter';
import { PLUGIN_CAPABILITIES, type PluginCapability } from '../../shared/plugins/permissions';
import type { SignatureStatus } from '../../shared/plugins/signing';
import {
	managedPluginStanding,
	type ManagedPluginStanding,
	type PluginCeilingCapability,
	type PluginCeilingEntry,
	type PluginPolicyCeiling,
} from '../plugins/permission-broker';

/** Bounds a ceiling document may not exceed; past any of them it is refused, never truncated. */
export const PLUGIN_CEILING_LIMITS = {
	plugins: 256,
	capabilitiesPerPlugin: 64,
	scopesPerCapability: 64,
	revokedPublishers: 256,
	idLength: 256,
	scopeLength: 1024,
} as const;

const SIGNATURE_STATUSES: readonly SignatureStatus[] = [
	'unsigned',
	'invalid',
	'untrusted',
	'trusted',
];
const CEILING_KEYS = ['policyRevision', 'plugins', 'revokedPublishers'] as const;
const ENTRY_KEYS = [
	'pluginId',
	'contentHash',
	'signerKey',
	'signatureStatus',
	'capabilities',
	'revoked',
] as const;
const CAPABILITY_KEYS = ['capability', 'scopes'] as const;

export type PluginCeilingParse =
	| { ok: true; ceiling: PluginPolicyCeiling }
	| { ok: false; problems: readonly string[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unknownKeys(value: Record<string, unknown>, known: readonly string[]): string[] {
	return Object.keys(value).filter((key) => !known.includes(key));
}

function boundedString(value: unknown, max: number): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function parseCapability(
	raw: unknown,
	at: string,
	problems: string[]
): PluginCeilingCapability | null {
	if (!isPlainObject(raw)) {
		problems.push(`${at} is not an object`);
		return null;
	}
	for (const key of unknownKeys(raw, CAPABILITY_KEYS))
		problems.push(`${at}.${key} is not a known key`);
	const capability = raw.capability;
	if (!(PLUGIN_CAPABILITIES as readonly unknown[]).includes(capability)) {
		problems.push(`${at}.capability is not a plugin capability`);
		return null;
	}
	const out: PluginCeilingCapability = { capability: capability as PluginCapability };
	if (raw.scopes !== undefined) {
		if (!Array.isArray(raw.scopes)) {
			problems.push(`${at}.scopes is not an array`);
			return null;
		}
		if (raw.scopes.length > PLUGIN_CEILING_LIMITS.scopesPerCapability) {
			problems.push(`${at}.scopes exceeds ${PLUGIN_CEILING_LIMITS.scopesPerCapability} entries`);
			return null;
		}
		const scopes: string[] = [];
		raw.scopes.forEach((scope, index) => {
			if (boundedString(scope, PLUGIN_CEILING_LIMITS.scopeLength)) scopes.push(scope);
			else problems.push(`${at}.scopes[${index}] is not a scope string`);
		});
		out.scopes = scopes;
	}
	return out;
}

function parseEntry(raw: unknown, at: string, problems: string[]): PluginCeilingEntry | null {
	if (!isPlainObject(raw)) {
		problems.push(`${at} is not an object`);
		return null;
	}
	for (const key of unknownKeys(raw, ENTRY_KEYS)) problems.push(`${at}.${key} is not a known key`);
	const before = problems.length;
	if (!boundedString(raw.pluginId, PLUGIN_CEILING_LIMITS.idLength)) {
		problems.push(`${at}.pluginId is not a plugin id`);
	}
	if (!boundedString(raw.contentHash, PLUGIN_CEILING_LIMITS.idLength)) {
		problems.push(`${at}.contentHash is not a content digest`);
	}
	if (raw.signerKey !== null && !boundedString(raw.signerKey, PLUGIN_CEILING_LIMITS.idLength)) {
		problems.push(`${at}.signerKey is neither a publisher key nor null`);
	}
	if (
		raw.signatureStatus !== undefined &&
		!(SIGNATURE_STATUSES as readonly unknown[]).includes(raw.signatureStatus)
	) {
		problems.push(`${at}.signatureStatus is not a signature status`);
	}
	if (raw.revoked !== undefined && typeof raw.revoked !== 'boolean') {
		problems.push(`${at}.revoked is not a boolean`);
	}
	const capabilities: PluginCeilingCapability[] = [];
	if (!Array.isArray(raw.capabilities)) {
		problems.push(`${at}.capabilities is not an array`);
	} else if (raw.capabilities.length > PLUGIN_CEILING_LIMITS.capabilitiesPerPlugin) {
		problems.push(
			`${at}.capabilities exceeds ${PLUGIN_CEILING_LIMITS.capabilitiesPerPlugin} entries`
		);
	} else {
		raw.capabilities.forEach((capability, index) => {
			const parsed = parseCapability(capability, `${at}.capabilities[${index}]`, problems);
			if (parsed) capabilities.push(parsed);
		});
	}
	if (problems.length !== before) return null;
	return {
		pluginId: raw.pluginId as string,
		contentHash: raw.contentHash as string,
		signerKey: raw.signerKey as string | null,
		...(raw.signatureStatus !== undefined
			? { signatureStatus: raw.signatureStatus as SignatureStatus }
			: {}),
		capabilities,
		...(raw.revoked !== undefined ? { revoked: raw.revoked as boolean } : {}),
	};
}

/**
 * Validate a plugin ceiling document. The result is a fresh value the caller's
 * input can no longer reach; every problem found is named by its path, and
 * one problem refuses the whole document.
 */
export function parsePluginPolicyCeiling(raw: unknown): PluginCeilingParse {
	const problems: string[] = [];
	if (!isPlainObject(raw)) {
		return { ok: false, problems: ['the plugin ceiling is not an object'] };
	}
	for (const key of unknownKeys(raw, CEILING_KEYS)) problems.push(`${key} is not a known key`);
	if (!Number.isSafeInteger(raw.policyRevision) || (raw.policyRevision as number) < 0) {
		problems.push('policyRevision is not a policy revision');
	}
	const plugins: PluginCeilingEntry[] = [];
	if (!Array.isArray(raw.plugins)) {
		problems.push('plugins is not an array');
	} else if (raw.plugins.length > PLUGIN_CEILING_LIMITS.plugins) {
		problems.push(`plugins exceeds ${PLUGIN_CEILING_LIMITS.plugins} entries`);
	} else {
		const seen = new Set<string>();
		raw.plugins.forEach((entry, index) => {
			const parsed = parseEntry(entry, `plugins[${index}]`, problems);
			if (!parsed) return;
			if (seen.has(parsed.pluginId)) {
				problems.push(`plugins[${index}].pluginId "${parsed.pluginId}" is named twice`);
				return;
			}
			seen.add(parsed.pluginId);
			plugins.push(parsed);
		});
	}
	let revokedPublishers: string[] | undefined;
	if (raw.revokedPublishers !== undefined) {
		if (!Array.isArray(raw.revokedPublishers)) {
			problems.push('revokedPublishers is not an array');
		} else if (raw.revokedPublishers.length > PLUGIN_CEILING_LIMITS.revokedPublishers) {
			problems.push(`revokedPublishers exceeds ${PLUGIN_CEILING_LIMITS.revokedPublishers} entries`);
		} else {
			revokedPublishers = [];
			raw.revokedPublishers.forEach((key, index) => {
				if (boundedString(key, PLUGIN_CEILING_LIMITS.idLength)) revokedPublishers!.push(key);
				else problems.push(`revokedPublishers[${index}] is not a publisher key`);
			});
		}
	}
	if (problems.length > 0) return { ok: false, problems };
	return {
		ok: true,
		ceiling: {
			policyRevision: raw.policyRevision as number,
			plugins,
			...(revokedPublishers !== undefined ? { revokedPublishers } : {}),
		},
	};
}

export interface PluginCeilingInstallation {
	ceiling: PluginPolicyCeiling;
	/** When this host accepted the document (ISO 8601). */
	installedAt: string;
}

export type PluginCeilingInstallOutcome =
	| { installed: true; policyRevision: number; pluginCount: number }
	| { installed: false; problems: readonly string[] };

export interface PluginPolicySourceDeps {
	/** The enrollment rule the spawn authority uses: an identity record exists. Re-read per call. */
	enrolled(): boolean;
	/** The host's policy status; its applied revision is what a ceiling binds to. Re-read per call. */
	policy(): Pick<ManagedPolicyStatus, 'appliedRevision'> | null;
	now?: () => number;
}

export interface PluginPolicySource {
	/** The standing the broker reads on every call and every live hold. */
	standing(): ManagedPluginStanding;
	/** The ceiling this host holds, whatever revision it was issued for; null when none. */
	installed(): PluginCeilingInstallation | null;
	/**
	 * Install the ceiling an authenticated endpoint path handed over, after
	 * validating it in full. A refused document names every problem and keeps
	 * the previous installation; an accepted one replaces it, for whatever
	 * revision it was issued (the standing decides whether that is the one
	 * this host is under).
	 */
	install(raw: unknown): PluginCeilingInstallOutcome;
	/** Forget the installed ceiling (a revoked enrollment, a policy reset). */
	clear(): void;
}

export function createPluginPolicySource(deps: PluginPolicySourceDeps): PluginPolicySource {
	const now = deps.now ?? (() => Date.now());
	let installation: PluginCeilingInstallation | null = null;
	return {
		standing: () =>
			managedPluginStanding({
				enrolled: deps.enrolled(),
				policy: deps.policy(),
				ceiling: installation?.ceiling ?? null,
			}),
		installed: () => installation,
		install(raw) {
			const parsed = parsePluginPolicyCeiling(raw);
			if (!parsed.ok) return { installed: false, problems: parsed.problems };
			installation = { ceiling: parsed.ceiling, installedAt: new Date(now()).toISOString() };
			return {
				installed: true,
				policyRevision: parsed.ceiling.policyRevision,
				pluginCount: parsed.ceiling.plugins.length,
			};
		},
		clear() {
			installation = null;
		},
	};
}
