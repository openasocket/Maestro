/**
 * Experience Bundle types — cryptographically signed, distributable packages
 * of curated experiences and hierarchy definitions.
 *
 * Two distribution flows:
 * 1. Download — Fetch signed bundles from the Maestro Experience Repository
 * 2. Submit — Package local experiences for review and inclusion in the repository
 *
 * Client-side types are complete; server-side API is deferred (stubs return
 * "not yet available" until the API is live).
 */

import type { MemoryScope } from './memory-types';

// ─── Bundle Manifest ──────────────────────────────────────────────────────

/** A curated, distributable package of experiences and optionally hierarchy definitions */
export interface ExperienceBundle {
	/** Bundle format version — bump on breaking changes */
	version: 1;
	/** Unique bundle identifier (UUID v4) */
	bundleId: string;
	/** Human-readable name (e.g., "React Best Practices", "Rust Safety Patterns") */
	name: string;
	/** Short description for catalog display */
	description: string;
	/** Category for filtering (e.g., "frontend", "devops", "security") */
	category: string;
	/** Searchable tags */
	tags: string[];

	// ── Authorship ──
	/** Author display name */
	author: string;
	/** Author URL (GitHub profile, website) */
	authorUrl?: string;
	/** Author's Ed25519 public key (hex-encoded) */
	authorPublicKey?: string;

	// ── Content ──
	/** Experience entries to import */
	memories: BundleMemoryEntry[];
	/** Optional hierarchy definitions (roles, personas, skill areas) to create/merge */
	hierarchy?: {
		roles: BundleRole[];
		personas: BundlePersona[];
		skillAreas: BundleSkillArea[];
	};

	// ── Metadata ──
	/** Minimum Maestro version required (semver) */
	minMaestroVersion?: string;
	/** When this bundle was created */
	createdAt: number;
	/** When this bundle was last updated */
	updatedAt: number;
	/** SHA-256 hash of JSON.stringify(memories) — content integrity */
	contentHash: string;
	/** Number of users who have imported this bundle (populated by server) */
	importCount?: number;
	/** Average rating (populated by server) */
	rating?: number;
}

/** A memory entry within a bundle — subset of MemoryEntry, no local-only fields */
export interface BundleMemoryEntry {
	/** Stable ID within the bundle (not the local ID after import) */
	bundleEntryId: string;
	content: string;
	type: 'rule' | 'experience';
	tags: string[];
	confidence: number;
	/** Which skill area in the bundle hierarchy this belongs to (by bundleSkillAreaId) */
	skillAreaRef?: string;
	/** Experience context (stripped of local paths/session refs) */
	experienceContext?: {
		situation: string;
		learning: string;
		category?: string;
	};
}

/** Role definition within a bundle */
export interface BundleRole {
	bundleRoleId: string;
	name: string;
	description: string;
	systemPrompt: string;
}

/** Persona definition within a bundle */
export interface BundlePersona {
	bundlePersonaId: string;
	bundleRoleId: string;
	name: string;
	description: string;
	systemPrompt: string;
	assignedAgents: string[];
}

/** Skill area definition within a bundle */
export interface BundleSkillArea {
	bundleSkillAreaId: string;
	bundlePersonaId: string;
	name: string;
	description: string;
}

// ─── Cryptographic Signing ────────────────────────────────────────────────

/** Signed envelope wrapping a bundle for distribution */
export interface SignedExperienceBundle {
	/** The bundle payload (JSON-serializable) */
	bundle: ExperienceBundle;
	/** Ed25519 signature over canonical JSON of bundle (hex-encoded) */
	signature: string;
	/** The public key that produced this signature (hex-encoded, 32 bytes) */
	signingKey: string;
	/** Signature algorithm identifier */
	algorithm: 'ed25519';
}

/** Known trusted public keys (shipped with Maestro, updatable via API) */
export interface TrustedKeyEntry {
	/** Hex-encoded Ed25519 public key */
	publicKey: string;
	/** Display name of the key holder */
	name: string;
	/** When this key was added to the trust store */
	addedAt: number;
	/** When this key expires (0 = never) */
	expiresAt: number;
	/** Key fingerprint (SHA-256 of public key, first 16 hex chars) */
	fingerprint: string;
}

// ─── Repository API Contract ──────────────────────────────────────────────

/** Catalog entry returned by the repository API (lightweight, no full content) */
export interface RepositoryCatalogEntry {
	bundleId: string;
	name: string;
	description: string;
	category: string;
	tags: string[];
	author: string;
	authorUrl?: string;
	memoryCount: number;
	hierarchyIncluded: boolean;
	createdAt: number;
	updatedAt: number;
	importCount: number;
	rating: number;
	minMaestroVersion?: string;
	/** Whether the bundle is signed by a trusted Maestro key */
	isTrusted: boolean;
	/** SHA-256 content hash for cache invalidation */
	contentHash: string;
}

/** Response shape from the repository API catalog endpoint */
export interface RepositoryCatalogResponse {
	entries: RepositoryCatalogEntry[];
	totalCount: number;
	page: number;
	pageSize: number;
}

/** Response shape from the repository API download endpoint */
export interface RepositoryDownloadResponse {
	signedBundle: SignedExperienceBundle;
}

// ─── Submission ───────────────────────────────────────────────────────────

/** What the client sends when submitting experiences to the central repository */
export interface ExperienceSubmission {
	/** Submission format version */
	version: 1;
	/** Proposed bundle name */
	name: string;
	/** Proposed description */
	description: string;
	/** Proposed category */
	category: string;
	/** Proposed tags */
	tags: string[];
	/** Submitter display name */
	submitterName: string;
	/** Submitter email (for review correspondence) */
	submitterEmail: string;
	/** The experiences being submitted (sanitized — no local paths, session IDs, or git diffs) */
	memories: BundleMemoryEntry[];
	/** Optional hierarchy to include */
	hierarchy?: ExperienceBundle['hierarchy'];
	/** Client-generated SHA-256 of JSON.stringify(memories) */
	contentHash: string;
	/** Submitter's agreement to the contribution license */
	licenseAgreed: boolean;
	/** Maestro version that generated this submission */
	maestroVersion: string;
}

/** Server response after submission */
export interface SubmissionResponse {
	/** Whether the submission was accepted for review */
	accepted: boolean;
	/** Submission tracking ID */
	submissionId?: string;
	/** Human-readable message */
	message: string;
}

// ─── Import Result ────────────────────────────────────────────────────────

/** Result of importing a bundle into the local memory store */
export interface BundleImportResult {
	/** Number of memories imported */
	memoriesImported: number;
	/** Number of memories skipped (duplicate) */
	memoriesSkipped: number;
	/** Roles created */
	rolesCreated: number;
	/** Personas created */
	personasCreated: number;
	/** Skill areas created */
	skillAreasCreated: number;
	/** Whether the bundle signature was verified */
	signatureVerified: boolean;
	/** Whether the signing key is trusted */
	signerTrusted: boolean;
	/** Bundle ID for tracking */
	bundleId: string;
}

// ─── Local State ──────────────────────────────────────────────────────────

/** Tracks which bundles have been imported locally */
export interface ImportedBundleRecord {
	bundleId: string;
	name: string;
	importedAt: number;
	contentHash: string;
	memoriesImported: number;
	signatureVerified: boolean;
	signerTrusted: boolean;
	/** Local memory IDs created from this bundle (for uninstall) */
	localMemoryIds: string[];
}

// ─── Re-exports for convenience ───────────────────────────────────────────

export type { MemoryScope };
