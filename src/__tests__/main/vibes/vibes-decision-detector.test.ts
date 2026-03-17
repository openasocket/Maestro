/**
 * Tests for src/main/vibes/vibes-decision-detector.ts
 * Validates heuristic detection of decision patterns in agent reasoning text.
 */

import { describe, it, expect } from 'vitest';
import { detectDecision } from '../../../main/vibes/vibes-decision-detector';

describe('vibes-decision-detector', () => {
	// ========================================================================
	// Null cases — no decision detected
	// ========================================================================

	describe('returns null for non-decision text', () => {
		it('should return null for empty string', () => {
			expect(detectDecision('')).toBeNull();
		});

		it('should return null for short text', () => {
			expect(detectDecision('I will edit the file.')).toBeNull();
		});

		it('should return null for text without decision patterns', () => {
			const text = `
				I need to read the file first to understand its structure.
				The file contains a React component with several hooks.
				Let me check the imports and see what dependencies are used.
			`;
			expect(detectDecision(text)).toBeNull();
		});

		it('should return null for text with options but no selection', () => {
			const text = `
				Option A: Use a Map for O(1) lookups
				Option B: Use an array with linear search
				I need to think about this more carefully before deciding.
			`;
			expect(detectDecision(text)).toBeNull();
		});
	});

	// ========================================================================
	// Structured options (Option A/B, Approach 1/2)
	// ========================================================================

	describe('structured option detection', () => {
		it('should detect Option A/B pattern with selection', () => {
			const text = `
				I need to decide how to implement the cache.
				Option A: Use a Map for O(1) lookups with memory overhead
				Option B: Use an array with linear search but lower memory
				I'll go with a Map because it provides constant-time lookups.
			`;
			const result = detectDecision(text);
			expect(result).not.toBeNull();
			expect(result!.options).toHaveLength(2);
			expect(result!.options[0].id).toBe('a');
			expect(result!.options[1].id).toBe('b');
			expect(result!.rationale).toContain('constant-time lookups');
		});

		it('should detect Approach 1/2 pattern with selection', () => {
			const text = `
				The question is how to handle concurrent requests.
				Approach 1: Use a mutex to serialize access to shared state
				Approach 2: Use immutable data with copy-on-write semantics
				Choosing immutable data over mutex because it avoids deadlock risks.
			`;
			const result = detectDecision(text);
			expect(result).not.toBeNull();
			expect(result!.options).toHaveLength(2);
			expect(result!.options[0].id).toBe('1');
			expect(result!.options[1].id).toBe('2');
		});

		it('should detect Alternative 1/2 pattern', () => {
			const text = `
				I need to decide whether to use inline styles or CSS modules.
				Alternative 1: Inline styles for simplicity and component co-location
				Alternative 2: CSS modules for better separation and caching
				The best approach is CSS modules because they enable browser caching.
			`;
			const result = detectDecision(text);
			expect(result).not.toBeNull();
			expect(result!.options).toHaveLength(2);
		});
	});

	// ========================================================================
	// Binary choice patterns (either/or)
	// ========================================================================

	describe('binary choice detection', () => {
		it('should detect "I could either X or Y" with selection', () => {
			const text = `
				I could either refactor the existing function or create a new utility.
				I'll go with refactoring because it avoids code duplication.
			`;
			const result = detectDecision(text);
			expect(result).not.toBeNull();
			expect(result!.options).toHaveLength(2);
			expect(result!.options[0].id).toBe('a');
			expect(result!.options[1].id).toBe('b');
		});

		it('should detect "the choice is between X and Y" with selection', () => {
			const text = `
				The choice is between a synchronous API and an async streaming approach.
				I'll use a synchronous API because the data volume is small.
			`;
			const result = detectDecision(text);
			expect(result).not.toBeNull();
			expect(result!.options).toHaveLength(2);
		});
	});

	// ========================================================================
	// "Choosing X over Y" standalone pattern
	// ========================================================================

	describe('choosing pattern detection', () => {
		it('should detect "Choosing X over Y because Z"', () => {
			const text = `
				After reviewing the codebase patterns, I see two approaches are possible.
				Choosing TypeScript enums over string unions because they provide runtime validation.
			`;
			const result = detectDecision(text);
			expect(result).not.toBeNull();
			expect(result!.options).toHaveLength(2);
			expect(result!.selected).toBe('selected');
			expect(result!.options[0].description).toContain('TypeScript enums');
			expect(result!.options[1].description).toContain('string unions');
			expect(result!.rationale).toContain('runtime validation');
		});
	});

	// ========================================================================
	// Confidence detection
	// ========================================================================

	describe('confidence detection', () => {
		it('should detect high confidence from "clearly"', () => {
			const text = `
				Option A: Use recursion for tree traversal
				Option B: Use iteration with an explicit stack
				Clearly the best approach is iteration because it avoids stack overflow.
			`;
			const result = detectDecision(text);
			expect(result).not.toBeNull();
			expect(result!.confidence).toBe('high');
		});

		it('should detect low confidence from "might"', () => {
			const text = `
				Option A: Inline the helper function
				Option B: Keep it separate for testability
				This might be better with the inline approach. I'll go with inlining because it reduces indirection.
			`;
			const result = detectDecision(text);
			expect(result).not.toBeNull();
			expect(result!.confidence).toBe('low');
		});

		it('should default to medium confidence', () => {
			const text = `
				Option A: Use a hash map for lookups
				Option B: Use a sorted array with binary search
				I'll go with a hash map because it has better average-case performance.
			`;
			const result = detectDecision(text);
			expect(result).not.toBeNull();
			expect(result!.confidence).toBe('medium');
		});
	});

	// ========================================================================
	// Decision point extraction
	// ========================================================================

	describe('decision point extraction', () => {
		it('should extract decision point from "I need to decide" pattern', () => {
			const text = `
				I need to decide whether to use a class or a plain object.
				Option A: Class with methods for encapsulation
				Option B: Plain object with utility functions
				I'll go with a class because it groups state and behavior together.
			`;
			const result = detectDecision(text);
			expect(result).not.toBeNull();
			expect(result!.decision_point).toBeTruthy();
		});

		it('should extract decision point from "The question is" pattern', () => {
			const text = `
				The question is how to handle the error boundary.
				Option A: Use a global error boundary component
				Option B: Use per-route error boundaries
				The best option is per-route boundaries because they isolate failures.
			`;
			const result = detectDecision(text);
			expect(result).not.toBeNull();
			expect(result!.decision_point).toContain('handle the error boundary');
		});
	});

	// ========================================================================
	// Edge cases
	// ========================================================================

	describe('edge cases', () => {
		it('should handle three or more options', () => {
			const text = `
				Option A: Use REST API
				Option B: Use GraphQL
				Option C: Use gRPC
				I'll go with GraphQL because it reduces over-fetching.
			`;
			const result = detectDecision(text);
			expect(result).not.toBeNull();
			expect(result!.options).toHaveLength(3);
		});

		it('should truncate long descriptions', () => {
			const longDesc = 'x'.repeat(300);
			const text = `
				Option A: ${longDesc}
				Option B: Short option
				I'll go with short option because it is simpler.
			`;
			const result = detectDecision(text);
			expect(result).not.toBeNull();
			// Descriptions are truncated to 200 chars
			expect(result!.options[0].description.length).toBeLessThanOrEqual(200);
		});

		it('should return structured entry with all required fields', () => {
			const text = `
				Choosing a worker pool over a single-threaded approach because it enables parallel processing.
			`;
			const result = detectDecision(text);
			expect(result).not.toBeNull();
			expect(result).toHaveProperty('decision_point');
			expect(result).toHaveProperty('options');
			expect(result).toHaveProperty('selected');
			expect(result).toHaveProperty('rationale');
			expect(result).toHaveProperty('confidence');
			// Should NOT have type or created_at (those are added by createDecisionEntry)
			expect(result).not.toHaveProperty('type');
			expect(result).not.toHaveProperty('created_at');
		});
	});
});
