/**
 * Tests for src/main/vibes/vibes-hash.ts
 * Validates both legacy V1 hash (strips type + created_at) and spec-compliant
 * V2 hash (strips only created_at, includes type per spec section 6.2).
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import {
	computeVibesHash,
	computeVibesHashV2,
	computeAnnotationId,
	shortHash,
} from '../../../main/vibes/vibes-hash';

describe('vibes-hash', () => {
	// ========================================================================
	// computeVibesHash (V1 — legacy, strips type + created_at)
	// ========================================================================
	describe('computeVibesHash (V1 legacy)', () => {
		it('should return a 64-character lowercase hex string', () => {
			const hash = computeVibesHash({ type: 'environment', tool_name: 'test' });
			expect(hash).toMatch(/^[0-9a-f]{64}$/);
		});

		it('should exclude created_at from the hash', () => {
			const context = {
				type: 'environment',
				tool_name: 'maestro',
				created_at: '2026-01-01T00:00:00Z',
			};
			const hashWithDate = computeVibesHash(context);

			const contextDifferentDate = {
				...context,
				created_at: '2026-12-31T23:59:59Z',
			};
			const hashWithDifferentDate = computeVibesHash(contextDifferentDate);

			expect(hashWithDate).toBe(hashWithDifferentDate);
		});

		it('should exclude type from the hash (V1 behavior)', () => {
			const contextA = { type: 'environment', tool_name: 'maestro' };
			const contextB = { type: 'command', tool_name: 'maestro' };
			const contextC = { tool_name: 'maestro' };

			// All three should produce the same hash since type is stripped
			expect(computeVibesHash(contextA)).toBe(computeVibesHash(contextB));
			expect(computeVibesHash(contextA)).toBe(computeVibesHash(contextC));
		});

		it('should produce the same hash regardless of key order', () => {
			const contextA = {
				tool_name: 'maestro',
				tool_version: '1.0',
				model_name: 'claude',
			};
			const contextB = {
				model_name: 'claude',
				tool_version: '1.0',
				tool_name: 'maestro',
			};

			expect(computeVibesHash(contextA)).toBe(computeVibesHash(contextB));
		});

		it('should produce different hashes for different content', () => {
			const hashA = computeVibesHash({ type: 'environment', tool_name: 'maestro' });
			const hashB = computeVibesHash({ type: 'environment', tool_name: 'codex' });

			expect(hashA).not.toBe(hashB);
		});

		it('should handle empty objects', () => {
			const hash = computeVibesHash({});
			expect(hash).toMatch(/^[0-9a-f]{64}$/);
			// SHA-256 of "{}" should be deterministic
			const expected = createHash('sha256').update('{}', 'utf8').digest('hex');
			expect(hash).toBe(expected);
		});

		it('should handle objects with only created_at', () => {
			const hash = computeVibesHash({ created_at: '2026-01-01T00:00:00Z' });
			const emptyHash = computeVibesHash({});
			expect(hash).toBe(emptyHash);
		});

		it('should produce a valid SHA-256 for a known input', () => {
			// type is stripped, so only model_name remains
			const context = { model_name: 'claude', type: 'environment' };
			const serialized = '{"model_name":"claude"}';
			const expected = createHash('sha256').update(serialized, 'utf8').digest('hex');

			expect(computeVibesHash(context)).toBe(expected);
		});

		it('should be deterministic across multiple calls', () => {
			const context = {
				type: 'environment',
				tool_name: 'maestro',
				tool_version: '2.0',
				model_name: 'claude-4',
				model_version: 'opus',
				created_at: '2026-02-10T12:00:00Z',
			};

			const hash1 = computeVibesHash(context);
			const hash2 = computeVibesHash(context);
			const hash3 = computeVibesHash(context);

			expect(hash1).toBe(hash2);
			expect(hash2).toBe(hash3);
		});
	});

	// ========================================================================
	// computeVibesHashV2 (spec-compliant — strips only created_at, keeps type)
	// ========================================================================
	describe('computeVibesHashV2 (spec section 6.2)', () => {
		it('should return a 64-character lowercase hex string', () => {
			const hash = computeVibesHashV2({ type: 'environment', tool_name: 'test' });
			expect(hash).toMatch(/^[0-9a-f]{64}$/);
		});

		it('should exclude created_at from the hash', () => {
			const context = {
				type: 'environment',
				tool_name: 'maestro',
				created_at: '2026-01-01T00:00:00Z',
			};
			const hashWithDate = computeVibesHashV2(context);

			const contextDifferentDate = {
				...context,
				created_at: '2026-12-31T23:59:59Z',
			};
			const hashWithDifferentDate = computeVibesHashV2(contextDifferentDate);

			expect(hashWithDate).toBe(hashWithDifferentDate);
		});

		it('should INCLUDE type in the hash (spec compliance)', () => {
			const contextA = { type: 'environment', tool_name: 'maestro' };
			const contextB = { type: 'command', tool_name: 'maestro' };
			const contextC = { tool_name: 'maestro' };

			// V2 includes type, so different types produce different hashes
			expect(computeVibesHashV2(contextA)).not.toBe(computeVibesHashV2(contextB));
			// With type omitted entirely, should differ from one with type present
			expect(computeVibesHashV2(contextA)).not.toBe(computeVibesHashV2(contextC));
		});

		it('should produce the same hash regardless of key order', () => {
			const contextA = {
				type: 'environment',
				tool_name: 'maestro',
				tool_version: '1.0',
				model_name: 'claude',
			};
			const contextB = {
				model_name: 'claude',
				tool_version: '1.0',
				tool_name: 'maestro',
				type: 'environment',
			};

			expect(computeVibesHashV2(contextA)).toBe(computeVibesHashV2(contextB));
		});

		it('should produce different hashes for different content', () => {
			const hashA = computeVibesHashV2({ type: 'environment', tool_name: 'maestro' });
			const hashB = computeVibesHashV2({ type: 'environment', tool_name: 'codex' });

			expect(hashA).not.toBe(hashB);
		});

		it('should handle empty objects', () => {
			const hash = computeVibesHashV2({});
			expect(hash).toMatch(/^[0-9a-f]{64}$/);
			const expected = createHash('sha256').update('{}', 'utf8').digest('hex');
			expect(hash).toBe(expected);
		});

		it('should produce a valid SHA-256 for a known input including type', () => {
			// V2 keeps type, so sorted keys: model_name, type
			const context = { model_name: 'claude', type: 'environment' };
			const serialized = '{"model_name":"claude","type":"environment"}';
			const expected = createHash('sha256').update(serialized, 'utf8').digest('hex');

			expect(computeVibesHashV2(context)).toBe(expected);
		});

		it('should handle nested objects', () => {
			const context = {
				type: 'environment',
				model_parameters: { temperature: 0.7, top_p: 0.9 },
				created_at: '2026-01-01T00:00:00Z',
			};
			const hash = computeVibesHashV2(context);
			expect(hash).toMatch(/^[0-9a-f]{64}$/);
		});

		it('should handle arrays in values', () => {
			const context = {
				type: 'environment',
				tool_extensions: ['ext1', 'ext2'],
			};
			const hash = computeVibesHashV2(context);
			expect(hash).toMatch(/^[0-9a-f]{64}$/);
		});

		it('should handle unicode strings', () => {
			const context = {
				type: 'prompt',
				prompt_text: 'Hello \u4e16\u754c \ud83c\udf0d',
			};
			const hash = computeVibesHashV2(context);
			expect(hash).toMatch(/^[0-9a-f]{64}$/);
		});

		it('should handle null and undefined values', () => {
			const contextA = { type: 'command', value: null };
			const contextB = { type: 'command', value: undefined };

			const hashA = computeVibesHashV2(contextA);
			const hashB = computeVibesHashV2(contextB);
			expect(hashA).not.toBe(hashB);
		});

		it('should handle numeric values', () => {
			const context = {
				type: 'command',
				command_exit_code: 0,
				created_at: '2026-01-01T00:00:00Z',
			};
			const hash = computeVibesHashV2(context);
			expect(hash).toMatch(/^[0-9a-f]{64}$/);
		});

		it('should be deterministic across multiple calls', () => {
			const context = {
				type: 'environment',
				tool_name: 'maestro',
				tool_version: '2.0',
				model_name: 'claude-4',
				model_version: 'opus',
				created_at: '2026-02-10T12:00:00Z',
			};

			const hash1 = computeVibesHashV2(context);
			const hash2 = computeVibesHashV2(context);
			const hash3 = computeVibesHashV2(context);

			expect(hash1).toBe(hash2);
			expect(hash2).toBe(hash3);
		});

		it('should include decision type in hash (spec section 5.6)', () => {
			const decision = {
				type: 'decision',
				decision_point: 'choose approach',
				selected: 'optionA',
				rationale: 'better performance',
			};
			const hash = computeVibesHashV2(decision);
			expect(hash).toMatch(/^[0-9a-f]{64}$/);

			// Without type should produce different hash
			const { type: _, ...noType } = decision;
			expect(computeVibesHashV2(noType)).not.toBe(hash);
		});
	});

	// ========================================================================
	// V1 vs V2 comparison
	// ========================================================================
	describe('V1 vs V2 comparison', () => {
		it('should produce different hashes for same input with type field', () => {
			const context = {
				type: 'environment',
				tool_name: 'maestro',
				tool_version: '1.0',
			};

			const v1 = computeVibesHash(context);
			const v2 = computeVibesHashV2(context);

			// V1 strips type, V2 keeps it — must differ
			expect(v1).not.toBe(v2);
		});

		it('should produce same hash when no type field present', () => {
			const context = {
				tool_name: 'maestro',
				tool_version: '1.0',
			};

			const v1 = computeVibesHash(context);
			const v2 = computeVibesHashV2(context);

			// No type to strip — identical behavior
			expect(v1).toBe(v2);
		});

		it('V1 hash of type-A equals V1 hash of type-B (type discarded)', () => {
			const envContext = { type: 'environment', tool_name: 'x' };
			const cmdContext = { type: 'command', tool_name: 'x' };

			expect(computeVibesHash(envContext)).toBe(computeVibesHash(cmdContext));
		});

		it('V2 hash of type-A differs from V2 hash of type-B (type retained)', () => {
			const envContext = { type: 'environment', tool_name: 'x' };
			const cmdContext = { type: 'command', tool_name: 'x' };

			expect(computeVibesHashV2(envContext)).not.toBe(computeVibesHashV2(cmdContext));
		});
	});

	// ========================================================================
	// computeAnnotationId
	// ========================================================================
	describe('computeAnnotationId', () => {
		it('should produce a 64-char hex string', () => {
			const record = {
				type: 'line',
				file_path: 'src/foo.ts',
				line_start: 1,
				line_end: 10,
			};
			expect(computeAnnotationId(record)).toMatch(/^[0-9a-f]{64}$/);
		});

		it('should be deterministic for same record', () => {
			const record = {
				type: 'line',
				file_path: 'src/bar.ts',
				line_start: 5,
				line_end: 15,
				action: 'create',
			};
			expect(computeAnnotationId(record)).toBe(computeAnnotationId(record));
		});

		it('should exclude annotation_id field from hash', () => {
			const record = {
				type: 'line',
				file_path: 'src/baz.ts',
				line_start: 1,
				line_end: 5,
			};
			const recordWithId = {
				...record,
				annotation_id: 'some-existing-id-that-should-be-ignored',
			};
			expect(computeAnnotationId(record)).toBe(computeAnnotationId(recordWithId));
		});

		it('should change when any field changes', () => {
			const base = {
				type: 'line',
				file_path: 'src/test.ts',
				line_start: 1,
				line_end: 10,
			};
			const modified = { ...base, line_end: 11 };
			expect(computeAnnotationId(base)).not.toBe(computeAnnotationId(modified));
		});
	});

	// ========================================================================
	// shortHash
	// ========================================================================
	describe('shortHash', () => {
		it('should return the first 16 characters of a hash', () => {
			const fullHash = 'a1b2c3d4e5f67890abcdef1234567890abcdef1234567890abcdef1234567890';
			expect(shortHash(fullHash)).toBe('a1b2c3d4e5f67890');
		});

		it('should handle hashes shorter than 16 characters', () => {
			expect(shortHash('abcdef')).toBe('abcdef');
		});

		it('should handle empty string', () => {
			expect(shortHash('')).toBe('');
		});

		it('should return exactly 16 characters for a 64-char hash', () => {
			const hash = computeVibesHashV2({ type: 'test' });
			const short = shortHash(hash);
			expect(short).toHaveLength(16);
			expect(hash.startsWith(short)).toBe(true);
		});

		it('should work with computeVibesHashV2 output', () => {
			const context = {
				type: 'environment',
				tool_name: 'maestro',
				created_at: '2026-01-01T00:00:00Z',
			};
			const hash = computeVibesHashV2(context);
			const short = shortHash(hash);

			expect(short).toHaveLength(16);
			expect(short).toMatch(/^[0-9a-f]{16}$/);
		});
	});
});
