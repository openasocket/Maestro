// VIBES v1.0 Hash Utility — Content-addressed hashing for manifest entries.
// Implements the VIBES SHA-256 hash specification for creating deterministic
// content identifiers used as manifest entry keys.

import { createHash } from 'crypto';

/**
 * Compute a VIBES hash for a manifest entry (V1 — DEPRECATED).
 *
 * This legacy algorithm strips both `created_at` AND `type` from the input.
 * Kept for backward compatibility with existing .ai-audit/ directories.
 * New code should use `computeVibesHashV2()` instead.
 *
 * @deprecated Use computeVibesHashV2() for spec-compliant hashing.
 */
export function computeVibesHash(context: Record<string, unknown>): string {
	// Remove created_at and type from a shallow copy
	const { created_at: _, type: __, ...rest } = context;

	// Serialize with sorted keys and no whitespace
	const serialized = JSON.stringify(rest, Object.keys(rest).sort());

	// SHA-256 → lowercase hex
	return createHash('sha256').update(serialized, 'utf8').digest('hex');
}

/**
 * Compute a VIBES-compliant SHA-256 hash for a manifest entry context object.
 *
 * Algorithm (per VIBES v1.0 spec section 6.2):
 * 1. Remove `created_at` field from the context object (the only excluded field)
 * 2. Serialize to JSON with sorted keys and no whitespace
 * 3. Encode as UTF-8
 * 4. Compute SHA-256
 * 5. Return lowercase hex string (64 characters)
 *
 * Unlike the deprecated V1 hash, this INCLUDES the `type` field per spec.
 */
export function computeVibesHashV2(context: Record<string, unknown>): string {
	// Remove only created_at from a shallow copy
	const { created_at: _, ...rest } = context;

	// Serialize with sorted keys and no whitespace
	const serialized = JSON.stringify(rest, Object.keys(rest).sort());

	// SHA-256 → lowercase hex
	return createHash('sha256').update(serialized, 'utf8').digest('hex');
}

/**
 * Compute a VIBES annotation ID per spec section 6.4.
 * SHA-256 of canonical JSON (sorted keys, no whitespace, excluding annotation_id).
 */
export function computeAnnotationId(record: Record<string, unknown>): string {
	const { annotation_id: _, ...hashable } = record;
	const canonical = JSON.stringify(hashable, Object.keys(hashable).sort());
	return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Return the first 16 hex characters of a hash for display purposes.
 */
export function shortHash(hash: string): string {
	return hash.slice(0, 16);
}
