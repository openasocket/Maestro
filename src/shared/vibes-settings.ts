// VIBES Settings — Maestro-specific configuration for VIBES metadata tracking.
// Persisted via electron-store. Types and defaults for the Settings UI.

import type { VibesAssuranceLevel } from './vibes-types';

// ============================================================================
// Settings Interface
// ============================================================================

/** Maestro-specific VIBES configuration stored in electron-store. */
export interface VibesSettingsConfig {
	/** Master toggle for VIBES metadata capture. */
	vibesEnabled: boolean;

	/** Default assurance level for new annotations. */
	vibesAssuranceLevel: VibesAssuranceLevel;

	/** File extensions to track for VIBES annotations. */
	vibesTrackedExtensions: string[];

	/** Glob patterns to exclude from VIBES tracking. */
	vibesExcludePatterns: string[];

	/** Per-agent enable/disable configuration. */
	vibesPerAgentConfig: Record<string, { enabled: boolean }>;

	/** Capture Maestro's own orchestration data (session management, batch runs). */
	vibesMaestroOrchestrationEnabled: boolean;

	/** Automatically run `vibecheck init` on new projects. */
	vibesAutoInit: boolean;

	/** Path to the vibecheck binary. Empty string means auto-detect from $PATH. */
	vibesCheckBinaryPath: string;

	/** Byte threshold above which reasoning text is compressed. */
	vibesCompressReasoningThreshold: number;

	/** Byte threshold above which data is stored as an external blob. */
	vibesExternalBlobThreshold: number;
}

// ============================================================================
// Defaults
// ============================================================================

/** Default values for all VIBES settings. */
export const VIBES_SETTINGS_DEFAULTS: VibesSettingsConfig = {
	vibesEnabled: false,
	vibesAssuranceLevel: 'medium',
	vibesTrackedExtensions: [
		// JavaScript & TypeScript
		'.js', '.jsx', '.mjs', '.cjs',
		'.ts', '.tsx', '.mts', '.cts',
		// Frontend frameworks
		'.vue', '.svelte', '.astro',
		// Web fundamentals
		'.html', '.css', '.scss', '.sass', '.less',
		// Systems programming
		'.rs', '.go', '.c', '.cpp', '.h', '.hpp', '.zig',
		// JVM ecosystem
		'.java', '.kt', '.scala',
		// .NET
		'.cs',
		// Mobile
		'.swift', '.dart', '.m',
		// Scripting & dynamic
		'.py', '.rb', '.php', '.lua', '.sh',
		// Elixir / Erlang
		'.ex', '.exs',
		// Data & query
		'.sql', '.graphql', '.proto',
		// Config as code
		'.tf', '.yaml', '.yml', '.toml',
	],
	vibesExcludePatterns: [
		'**/node_modules/**',
		'**/vendor/**',
		'**/.venv/**',
		'**/dist/**',
		'**/target/**',
		'**/.git/**',
		'**/build/**',
		'**/out/**',
		'**/__pycache__/**',
		'**/.next/**',
		'**/.nuxt/**',
		'**/.svelte-kit/**',
		'**/coverage/**',
		'**/.dart_tool/**',
		'**/Pods/**',
		'**/.build/**',
		'**/obj/**',
		'**/.gradle/**',
		'**/.terraform/**',
		'**/deps/**',
		'**/_build/**',
		'**/zig-out/**',
		'**/zig-cache/**',
	],
	vibesPerAgentConfig: {
		'claude-code': { enabled: true },
		'codex': { enabled: true },
	},
	vibesMaestroOrchestrationEnabled: true,
	vibesAutoInit: true,
	vibesCheckBinaryPath: '',
	vibesCompressReasoningThreshold: 10240,
	vibesExternalBlobThreshold: 102400,
};

// ============================================================================
// Helpers
// ============================================================================

/**
 * Returns the provided value if defined, otherwise falls back to the default
 * for the given VIBES settings key.
 */
export function getVibesSettingWithDefault<K extends keyof VibesSettingsConfig>(
	key: K,
	value: VibesSettingsConfig[K] | undefined,
): VibesSettingsConfig[K] {
	return value !== undefined ? value : VIBES_SETTINGS_DEFAULTS[key];
}
