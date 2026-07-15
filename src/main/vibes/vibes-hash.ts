// VIBES v1.0 Hash Utility — Content-addressed hashing for manifest entries.
// Implements the VIBES SHA-256 hash specification for creating deterministic
// content identifiers used as manifest entry keys.

import { createHash } from 'crypto';

/**
 * Recursively sort all object keys in a JSON-compatible value.
 * Objects get their keys sorted (UTF-16 code-unit order, matching the
 * VERIFY attestation canonicalization) at EVERY nesting level; arrays
 * preserve order; primitives pass through unchanged.
 *
 * This is the single canonical-ordering primitive for the whole VIBES/VERIFY
 * pipeline: manifest entry hashes, annotation IDs, and the DSSE attestation
 * payload/ID all serialize through it, so a Maestro-written hash matches what
 * a spec-conformant verifier (the vibecheck binary / itsavibe.ai registry)
 * recomputes from the same entry body.
 */
export function sortKeysRecursively(value: unknown): unknown {
	if (value === null || value === undefined) return value;
	if (Array.isArray(value)) return value.map(sortKeysRecursively);
	if (typeof value === 'object') {
		const sorted: Record<string, unknown> = {};
		for (const key of Object.keys(value as Record<string, unknown>).sort()) {
			sorted[key] = sortKeysRecursively((value as Record<string, unknown>)[key]);
		}
		return sorted;
	}
	return value;
}

/**
 * Canonical JSON serialization: recursively key-sorted, no whitespace.
 * The one serializer used everywhere content is hashed so the bytes are
 * deterministic and match cross-implementation.
 *
 * NOTE: this is a recursive-key-sort canonicalization, NOT full RFC 8785 JCS
 * (no number re-formatting). VIBES entry values are strings/small integers/
 * booleans, for which `JSON.stringify` output is stable, but any future field
 * carrying a float MUST be validated against the vibecheck reference tool.
 */
export function canonicalStringify(value: unknown): string {
	return JSON.stringify(sortKeysRecursively(value));
}

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

	// Serialize with recursively sorted keys and no whitespace
	const serialized = canonicalStringify(rest);

	// SHA-256 → lowercase hex
	return createHash('sha256').update(serialized, 'utf8').digest('hex');
}

/**
 * Compute a VIBES-compliant SHA-256 hash for a manifest entry context object.
 *
 * Algorithm (per VIBES v1.0 spec section 6.2):
 * 1. Remove `created_at` field from the context object (the only excluded field)
 * 2. Serialize to JSON with keys sorted recursively and no whitespace
 * 3. Encode as UTF-8
 * 4. Compute SHA-256
 * 5. Return lowercase hex string (64 characters)
 *
 * Unlike the deprecated V1 hash, this INCLUDES the `type` field per spec.
 */
export function computeVibesHashV2(context: Record<string, unknown>): string {
	// Remove only created_at from a shallow copy
	const { created_at: _, ...rest } = context;

	// Serialize with recursively sorted keys and no whitespace. A recursive sort
	// (not JSON.stringify's replacer-array form, which is a top-level property
	// allow-list applied at every depth and silently DROPS nested object content)
	// is required so nested fields like `model_parameters` and decision `options`
	// contribute to the hash and cannot collide.
	const serialized = canonicalStringify(rest);

	// SHA-256 → lowercase hex
	return createHash('sha256').update(serialized, 'utf8').digest('hex');
}

/**
 * Compute a VIBES annotation ID per spec section 6.4.
 * SHA-256 of canonical JSON (keys sorted recursively, no whitespace, excluding annotation_id).
 */
export function computeAnnotationId(record: Record<string, unknown>): string {
	const { annotation_id: _, ...hashable } = record;
	const canonical = canonicalStringify(hashable);
	return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Return the first 16 hex characters of a hash for display purposes.
 */
export function shortHash(hash: string): string {
	return hash.slice(0, 16);
}
