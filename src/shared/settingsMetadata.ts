/**
 * Settings Metadata
 *
 * Centralized metadata for all Maestro settings, used by both
 * the CLI (settings commands) and the main process (defaults).
 *
 * Each entry provides:
 *  - description: human-readable explanation for LLM context and CLI --verbose output
 *  - type: the expected JS type or union (for display/validation)
 *  - default: the default value (or a function returning one for platform-dependent defaults)
 *  - sensitive: true for keys that should be masked in list output
 *  - category: logical grouping for organized display
 */

import { APPEARANCE_SETTINGS_METADATA } from './settingsMetadataAppearance';
import { EDITOR_SETTINGS_METADATA } from './settingsMetadataEditor';
import { CORE_SETTINGS_METADATA } from './settingsMetadataCore';
import { CONNECTIVITY_SETTINGS_METADATA } from './settingsMetadataConnectivity';
import { AUTOMATION_SETTINGS_METADATA } from './settingsMetadataAutomation';
import { EXPERIENCE_SETTINGS_METADATA } from './settingsMetadataExperience';
import { FEATURES_SETTINGS_METADATA } from './settingsMetadataFeatures';
// ============================================================================
// Types
// ============================================================================

export type SettingType = 'string' | 'number' | 'boolean' | 'object' | 'array' | 'null';

export interface SettingMetadata {
	description: string;
	type: SettingType;
	default: unknown;
	sensitive?: boolean;
	/**
	 * A managed policy may lock this key (and pin its value). Marked on the keys
	 * whose value reaches a shell, a network or a credential; the lock model
	 * (P2-06) reads this flag, standalone ignores it.
	 */
	lockable?: boolean;
	category: SettingCategory;
}

export type SettingCategory =
	| 'appearance'
	| 'editor'
	| 'shell'
	| 'notifications'
	| 'updates'
	| 'logging'
	| 'web'
	| 'ssh'
	| 'stats'
	| 'accessibility'
	| 'document-graph'
	| 'context'
	| 'file-indexing'
	| 'integrations'
	| 'onboarding'
	| 'advanced'
	| 'internal';

// ============================================================================
// Settings Registry
// ============================================================================

export const SETTINGS_METADATA: Record<string, SettingMetadata> = {
	...APPEARANCE_SETTINGS_METADATA,
	...EDITOR_SETTINGS_METADATA,
	...CORE_SETTINGS_METADATA,
	...CONNECTIVITY_SETTINGS_METADATA,
	...AUTOMATION_SETTINGS_METADATA,
	...EXPERIENCE_SETTINGS_METADATA,
	...FEATURES_SETTINGS_METADATA,
};

// ============================================================================
// Helpers
// ============================================================================

/**
 * Keys that carry managed material in the records Maestro writes or receives
 * (MRC2-06-07): the identity anchor, a registration challenge, an enrollment
 * request, a transport admission, the TUI handshake and a Codex login. No
 * setting is named after any of them, but a key-based masker (the support
 * package's settings collector) treats each as a credential wherever it
 * appears, so a record pasted into a setting by hand still leaves masked.
 * The shape-based rules for the same material live in `redactSecrets()`.
 */
export const MANAGED_SENSITIVE_KEYS: readonly string[] = [
	'installSecret',
	'nonce',
	'challengeDigest',
	'invitation',
	'keyPossessionProof',
	'cliSecret',
	'dispatchTicket',
	'signature',
	'access_token',
	'id_token',
	'refresh_token',
];

/** All known sensitive keys: every setting marked `sensitive`, plus the managed record keys. */
export const SENSITIVE_KEYS = new Set([
	...Object.entries(SETTINGS_METADATA)
		.filter(([, meta]) => meta.sensitive)
		.map(([key]) => key),
	...MANAGED_SENSITIVE_KEYS,
]);

/** All setting categories in display order */
export const CATEGORY_LABELS: Record<SettingCategory, string> = {
	appearance: 'Appearance',
	editor: 'Editor & UI',
	shell: 'Shell & Terminal',
	notifications: 'Notifications',
	updates: 'Updates & Reporting',
	logging: 'Logging',
	web: 'Web Interface',
	ssh: 'SSH Remote',
	stats: 'Stats & Tracking',
	accessibility: 'Accessibility & Performance',
	'document-graph': 'Document Graph',
	context: 'Context Management',
	'file-indexing': 'File Indexing',
	integrations: 'Integrations',
	onboarding: 'Onboarding',
	advanced: 'Advanced',
	internal: 'Internal (auto-managed)',
};

/** Category display order */
export const CATEGORY_ORDER: SettingCategory[] = [
	'appearance',
	'editor',
	'shell',
	'notifications',
	'updates',
	'logging',
	'web',
	'ssh',
	'file-indexing',
	'context',
	'document-graph',
	'stats',
	'accessibility',
	'integrations',
	'onboarding',
	'advanced',
	'internal',
];

/**
 * Get the default value for a setting key.
 * Returns undefined for unknown keys.
 */
export function getSettingDefault(key: string): unknown {
	return SETTINGS_METADATA[key]?.default;
}

/**
 * Get metadata for a setting key.
 * Returns undefined for unknown keys.
 */
export function getSettingMetadata(key: string): SettingMetadata | undefined {
	return SETTINGS_METADATA[key];
}

/**
 * Build a complete defaults object from the metadata registry.
 */
export function getAllDefaults(): Record<string, unknown> {
	const defaults: Record<string, unknown> = {};
	for (const [key, meta] of Object.entries(SETTINGS_METADATA)) {
		defaults[key] = meta.default;
	}
	return defaults;
}
