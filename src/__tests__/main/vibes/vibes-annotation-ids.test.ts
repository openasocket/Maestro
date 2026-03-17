/**
 * Tests for VIBES annotation IDs, decision entry hashing, edge records,
 * and hash algorithm spec compliance (sections 5.6, 6.2, 6.4, 7.6).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'crypto';
import {
	computeAnnotationId,
	computeVibesHash,
	computeVibesHashV2,
} from '../../../main/vibes/vibes-hash';
import {
	createLineAnnotation,
	createFunctionAnnotation,
	createSessionRecord,
	createDecisionEntry,
	createEdgeRecord,
	createPromptEntry,
} from '../../../main/vibes/vibes-annotations';

const FIXED_ISO = '2026-03-15T12:00:00.000Z';

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date(FIXED_ISO));
});

afterEach(() => {
	vi.useRealTimers();
});

describe('vibes-annotation-ids', () => {
	// ========================================================================
	// 1. computeAnnotationId() produces 64-char hex string
	// ========================================================================
	it('computeAnnotationId() produces 64-char hex string', () => {
		const record = {
			type: 'line',
			file_path: 'src/index.ts',
			line_start: 1,
			line_end: 10,
			action: 'create',
		};
		const id = computeAnnotationId(record);
		expect(id).toMatch(/^[0-9a-f]{64}$/);
	});

	// ========================================================================
	// 2. computeAnnotationId() is deterministic for same record
	// ========================================================================
	it('computeAnnotationId() is deterministic for same record', () => {
		const record = {
			type: 'line',
			file_path: 'src/app.ts',
			line_start: 5,
			line_end: 20,
			action: 'modify',
			environment_hash: 'a'.repeat(64),
		};
		const id1 = computeAnnotationId(record);
		const id2 = computeAnnotationId(record);
		const id3 = computeAnnotationId(record);
		expect(id1).toBe(id2);
		expect(id2).toBe(id3);
	});

	// ========================================================================
	// 3. computeAnnotationId() excludes annotation_id field from hash
	// ========================================================================
	it('computeAnnotationId() excludes annotation_id field from hash', () => {
		const base = {
			type: 'line',
			file_path: 'src/util.ts',
			line_start: 1,
			line_end: 5,
			action: 'create',
		};
		const withId = {
			...base,
			annotation_id: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
		};
		const withDifferentId = {
			...base,
			annotation_id: '0000000000000000000000000000000000000000000000000000000000000000',
		};
		expect(computeAnnotationId(base)).toBe(computeAnnotationId(withId));
		expect(computeAnnotationId(base)).toBe(computeAnnotationId(withDifferentId));
	});

	// ========================================================================
	// 4. computeAnnotationId() changes when any field changes
	// ========================================================================
	it('computeAnnotationId() changes when any field changes', () => {
		const base = {
			type: 'line',
			file_path: 'src/test.ts',
			line_start: 1,
			line_end: 10,
			action: 'create',
		};

		// Change file_path
		expect(computeAnnotationId(base)).not.toBe(
			computeAnnotationId({ ...base, file_path: 'src/other.ts' })
		);
		// Change line_start
		expect(computeAnnotationId(base)).not.toBe(computeAnnotationId({ ...base, line_start: 2 }));
		// Change line_end
		expect(computeAnnotationId(base)).not.toBe(computeAnnotationId({ ...base, line_end: 11 }));
		// Change action
		expect(computeAnnotationId(base)).not.toBe(computeAnnotationId({ ...base, action: 'modify' }));
		// Change type
		expect(computeAnnotationId(base)).not.toBe(computeAnnotationId({ ...base, type: 'function' }));
	});

	// ========================================================================
	// 5. Line annotations include annotation_id after creation
	// ========================================================================
	it('line annotations include annotation_id after creation', () => {
		const envHash = 'e'.repeat(64);
		const annotation = createLineAnnotation({
			filePath: 'src/main.ts',
			lineStart: 10,
			lineEnd: 25,
			environmentHash: envHash,
			action: 'create',
			assuranceLevel: 'medium',
		});

		expect(annotation.annotation_id).toBeDefined();
		expect(annotation.annotation_id).toMatch(/^[0-9a-f]{64}$/);
		expect(annotation.annotation_id).not.toBe('');

		// Verify it matches recomputation from the record itself
		const recomputed = computeAnnotationId(annotation as unknown as Record<string, unknown>);
		expect(annotation.annotation_id).toBe(recomputed);
	});

	// ========================================================================
	// 6. Session records include annotation_id after creation
	// ========================================================================
	it('session records include annotation_id after creation', () => {
		const record = createSessionRecord({
			event: 'start',
			sessionId: 'sess-001',
			environmentHash: 'e'.repeat(64),
			assuranceLevel: 'low',
			description: 'Test session',
		});

		expect(record.annotation_id).toBeDefined();
		expect(record.annotation_id).toMatch(/^[0-9a-f]{64}$/);
		expect(record.annotation_id).not.toBe('');

		// Verify consistency with recomputation
		const recomputed = computeAnnotationId(record as unknown as Record<string, unknown>);
		expect(record.annotation_id).toBe(recomputed);
	});

	// ========================================================================
	// 7. Decision entries hash correctly (includes type field per spec)
	// ========================================================================
	it('decision entries hash correctly (includes type field per spec)', () => {
		const { entry, hash } = createDecisionEntry({
			decisionPoint: 'Choose database engine',
			options: [
				{ id: 'sqlite', description: 'SQLite', pros: ['simple'], cons: ['single writer'] },
				{ id: 'duckdb', description: 'DuckDB', pros: ['fast analytics'], cons: ['newer'] },
			],
			selected: 'duckdb',
			rationale: 'Better analytical performance',
			confidence: 'high',
		});

		// Hash should be valid 64-char hex
		expect(hash).toMatch(/^[0-9a-f]{64}$/);

		// Entry should have type 'decision'
		expect(entry.type).toBe('decision');

		// V2 hash should include the type field — verify by manual computation
		const { created_at: _, ...rest } = entry as unknown as Record<string, unknown>;
		const serialized = JSON.stringify(rest, Object.keys(rest).sort());
		const expected = createHash('sha256').update(serialized, 'utf8').digest('hex');
		expect(hash).toBe(expected);

		// Stripping type should produce a different hash (proves type is included)
		const { type: __, ...noType } = rest;
		const noTypeSerialized = JSON.stringify(noType, Object.keys(noType).sort());
		const noTypeHash = createHash('sha256').update(noTypeSerialized, 'utf8').digest('hex');
		expect(hash).not.toBe(noTypeHash);
	});

	// ========================================================================
	// 8. Edge records reference valid annotation_id values
	// ========================================================================
	it('edge records reference valid annotation_id values', () => {
		const envHash = 'e'.repeat(64);

		// Create a line annotation to get a real annotation_id
		const annotation = createLineAnnotation({
			filePath: 'src/handler.ts',
			lineStart: 1,
			lineEnd: 15,
			environmentHash: envHash,
			action: 'create',
			assuranceLevel: 'medium',
			sessionId: 'sess-edge-test',
		});

		// Create a prompt to get a real prompt hash
		const { hash: promptHash } = createPromptEntry({
			promptText: 'Implement the handler',
			promptType: 'user_instruction',
		});

		// Create an edge linking the annotation to the prompt
		const edge = createEdgeRecord({
			edgeType: 'caused_by',
			sourceRef: annotation.annotation_id,
			sourceType: 'annotation',
			targetRef: promptHash,
			targetType: 'context',
			sessionId: 'sess-edge-test',
		});

		// source_ref should be a valid annotation_id (64-char hex)
		expect(edge.source_ref).toMatch(/^[0-9a-f]{64}$/);
		expect(edge.source_ref).toBe(annotation.annotation_id);

		// target_ref should be a valid hash (64-char hex)
		expect(edge.target_ref).toMatch(/^[0-9a-f]{64}$/);
		expect(edge.target_ref).toBe(promptHash);

		// Edge metadata
		expect(edge.type).toBe('edge');
		expect(edge.edge_type).toBe('caused_by');
		expect(edge.source_type).toBe('annotation');
		expect(edge.target_type).toBe('context');
		expect(edge.session_id).toBe('sess-edge-test');
	});

	// ========================================================================
	// 9. caused_by edge correctly links annotation to prompt
	// ========================================================================
	it('caused_by edge correctly links annotation to prompt', () => {
		const envHash = 'e'.repeat(64);

		// Simulate the instrumenter flow: prompt → annotation → edge
		const { hash: promptHash } = createPromptEntry({
			promptText: 'Fix the authentication bug',
			promptType: 'chat_message',
		});

		const annotation = createLineAnnotation({
			filePath: 'src/auth.ts',
			lineStart: 42,
			lineEnd: 55,
			environmentHash: envHash,
			promptHash,
			action: 'modify',
			assuranceLevel: 'medium',
			sessionId: 'sess-causal',
		});

		// The annotation itself should reference the prompt hash
		expect(annotation.prompt_hash).toBe(promptHash);

		// Create the caused_by edge
		const edge = createEdgeRecord({
			edgeType: 'caused_by',
			sourceRef: annotation.annotation_id,
			sourceType: 'annotation',
			targetRef: promptHash,
			targetType: 'context',
			sessionId: 'sess-causal',
		});

		// Per spec: "Edges read as 'source [edge_type] target'"
		// This reads as: annotation caused_by prompt
		expect(edge.source_ref).toBe(annotation.annotation_id);
		expect(edge.target_ref).toBe(promptHash);
		expect(edge.edge_type).toBe('caused_by');

		// Verify edge timestamp is set
		expect(edge.timestamp).toBe(FIXED_ISO);

		// Both refs should be valid 64-char hex hashes
		expect(edge.source_ref).toMatch(/^[0-9a-f]{64}$/);
		expect(edge.target_ref).toMatch(/^[0-9a-f]{64}$/);
	});

	// ========================================================================
	// 10. Hash v2 includes type field (spec compliance)
	// ========================================================================
	it('hash v2 includes type field (spec compliance)', () => {
		const context = {
			type: 'environment',
			tool_name: 'maestro',
			tool_version: '2.0',
			created_at: '2026-01-01T00:00:00Z',
		};

		const hash = computeVibesHashV2(context);

		// Manually compute with type included
		const serialized = '{"tool_name":"maestro","tool_version":"2.0","type":"environment"}';
		const expected = createHash('sha256').update(serialized, 'utf8').digest('hex');
		expect(hash).toBe(expected);

		// Changing type should change the hash
		const differentType = { ...context, type: 'command' };
		expect(computeVibesHashV2(differentType)).not.toBe(hash);

		// Removing type should change the hash
		const { type: _, ...noType } = context;
		expect(computeVibesHashV2(noType)).not.toBe(hash);
	});

	// ========================================================================
	// 11. Hash v1 vs v2 produce different results for same input
	// ========================================================================
	it('hash v1 vs v2 produce different results for same input', () => {
		const context = {
			type: 'environment',
			tool_name: 'maestro',
			tool_version: '2.0',
			model_name: 'claude-4',
			model_version: 'opus',
			created_at: '2026-02-10T12:00:00Z',
		};

		const v1Hash = computeVibesHash(context);
		const v2Hash = computeVibesHashV2(context);

		// Both should be valid 64-char hex
		expect(v1Hash).toMatch(/^[0-9a-f]{64}$/);
		expect(v2Hash).toMatch(/^[0-9a-f]{64}$/);

		// They MUST differ because V1 strips type but V2 keeps it
		expect(v1Hash).not.toBe(v2Hash);

		// V1 should equal V2 when type is absent (confirming the only difference is type handling)
		const { type: _, created_at: __, ...rest } = context;
		const v1NoType = computeVibesHash(rest);
		const v2NoType = computeVibesHashV2(rest);
		expect(v1NoType).toBe(v2NoType);
	});

	// ========================================================================
	// Additional: function annotations include annotation_id
	// ========================================================================
	it('function annotations include annotation_id after creation', () => {
		const envHash = 'e'.repeat(64);
		const annotation = createFunctionAnnotation({
			filePath: 'src/service.ts',
			functionName: 'authenticate',
			functionSignature: 'authenticate(user: string): Promise<boolean>',
			environmentHash: envHash,
			action: 'create',
			assuranceLevel: 'high',
		});

		expect(annotation.annotation_id).toBeDefined();
		expect(annotation.annotation_id).toMatch(/^[0-9a-f]{64}$/);
		expect(annotation.annotation_id).not.toBe('');

		// Verify consistency
		const recomputed = computeAnnotationId(annotation as unknown as Record<string, unknown>);
		expect(annotation.annotation_id).toBe(recomputed);
	});

	// ========================================================================
	// Additional: different annotations produce different annotation_ids
	// ========================================================================
	it('different annotations produce different annotation_ids', () => {
		const envHash = 'e'.repeat(64);

		const ann1 = createLineAnnotation({
			filePath: 'src/a.ts',
			lineStart: 1,
			lineEnd: 10,
			environmentHash: envHash,
			action: 'create',
			assuranceLevel: 'low',
		});

		const ann2 = createLineAnnotation({
			filePath: 'src/b.ts',
			lineStart: 1,
			lineEnd: 10,
			environmentHash: envHash,
			action: 'create',
			assuranceLevel: 'low',
		});

		expect(ann1.annotation_id).not.toBe(ann2.annotation_id);
	});
});
