// VIBES v1.0 Decision Detector — Heuristic detection of decision patterns
// in agent reasoning text. Produces VibesDecisionEntry structures from
// free-form thinking text at High assurance level.
//
// This is best-effort: it uses simple regex patterns to detect when an agent
// is choosing between alternatives. False negatives are acceptable; false
// positives should be minimized by requiring both alternatives AND a selection.

import type { VibesDecisionEntry } from '../../shared/vibes-types';

// ============================================================================
// Pattern Definitions
// ============================================================================

/**
 * Patterns that indicate the agent is considering alternatives.
 * Each pattern captures relevant groups for option extraction.
 */
const OPTION_PATTERNS: RegExp[] = [
	// "Option A: ... Option B: ..."
	/Option\s+([A-Z\d]):\s*(.+?)(?=Option\s+[A-Z\d]:|$)/gis,
	// "Approach 1: ... Approach 2: ..."
	/Approach\s+(\d+):\s*(.+?)(?=Approach\s+\d+:|$)/gis,
	// "Alternative 1: ... Alternative 2: ..."
	/Alternative\s+(\d+):\s*(.+?)(?=Alternative\s+\d+:|$)/gis,
];

/**
 * Patterns that indicate a choice was made between alternatives.
 * These must match AFTER option patterns to confirm a decision was made.
 */
const SELECTION_PATTERNS: RegExp[] = [
	// "Choosing X over Y because ..."
	/[Cc]hoosing\s+(.+?)\s+over\s+(.+?)\s+because\s+(.+?)(?:\.|$)/s,
	// "I'll go with X because ..."
	/I(?:'ll| will)\s+go\s+with\s+(.+?)\s+because\s+(.+?)(?:\.|$)/s,
	// "I'll use X because/since ..."
	/I(?:'ll| will)\s+use\s+(.+?)\s+(?:because|since)\s+(.+?)(?:\.|$)/s,
	// "The best approach is X because ..."
	/[Tt]he\s+(?:best|better|preferred)\s+(?:approach|option|choice|solution)\s+is\s+(.+?)\s+because\s+(.+?)(?:\.|$)/s,
];

/**
 * Patterns that indicate a binary choice (either/or).
 */
const BINARY_PATTERNS: RegExp[] = [
	// "I could either X or Y"
	/I\s+could\s+either\s+(.+?)\s+or\s+(.+?)(?:\.|,|$)/s,
	// "We can either X or Y"
	/[Ww]e\s+can\s+either\s+(.+?)\s+or\s+(.+?)(?:\.|,|$)/s,
	// "The choice is between X and Y"
	/[Tt]he\s+choice\s+is\s+between\s+(.+?)\s+and\s+(.+?)(?:\.|,|$)/s,
];

/**
 * Confidence indicators in reasoning text.
 */
const HIGH_CONFIDENCE_WORDS = /\b(?:clearly|definitely|obviously|certainly|undoubtedly|must)\b/i;
const LOW_CONFIDENCE_WORDS = /\b(?:might|maybe|perhaps|possibly|unsure|not sure|uncertain)\b/i;

// ============================================================================
// Decision Detection
// ============================================================================

/**
 * Detect a decision pattern in agent reasoning text.
 *
 * Returns null if no decision pattern is detected. Returns a structured
 * VibesDecisionEntry if reasoning text contains identifiable alternatives
 * and a selection between them.
 *
 * Only intended for use at High assurance level where reasoning text
 * is captured. At Medium/Low, callers should not invoke this function.
 *
 * @param reasoningText - The accumulated reasoning/thinking text from the agent
 * @returns A VibesDecisionEntry (without created_at) or null
 */
export function detectDecision(
	reasoningText: string
): Omit<VibesDecisionEntry, 'type' | 'created_at'> | null {
	if (!reasoningText || reasoningText.length < 50) {
		return null;
	}

	// Try structured option patterns first (Option A/B, Approach 1/2)
	const structuredResult = tryStructuredOptions(reasoningText);
	if (structuredResult) {
		return structuredResult;
	}

	// Try binary choice patterns (either/or)
	const binaryResult = tryBinaryChoice(reasoningText);
	if (binaryResult) {
		return binaryResult;
	}

	// Try "choosing X over Y" pattern (standalone, no option listing needed)
	const choosingResult = tryChoosingPattern(reasoningText);
	if (choosingResult) {
		return choosingResult;
	}

	return null;
}

// ============================================================================
// Detection Strategies
// ============================================================================

/**
 * Try to detect structured option listings (Option A: ..., Approach 1: ...).
 */
function tryStructuredOptions(
	text: string
): Omit<VibesDecisionEntry, 'type' | 'created_at'> | null {
	for (const pattern of OPTION_PATTERNS) {
		// Reset lastIndex for global patterns
		pattern.lastIndex = 0;

		const options: Array<{ id: string; description: string }> = [];
		let match: RegExpExecArray | null;

		while ((match = pattern.exec(text)) !== null) {
			options.push({
				id: match[1].trim().toLowerCase(),
				description: truncate(match[2].trim(), 200),
			});
		}

		if (options.length < 2) {
			continue;
		}

		// Look for a selection among these options
		const selection = findSelection(text, options);
		if (!selection) {
			continue;
		}

		return {
			decision_point: extractDecisionPoint(text),
			options,
			selected: selection.selected,
			rationale: truncate(selection.rationale, 300),
			confidence: detectConfidence(text),
		};
	}

	return null;
}

/**
 * Try to detect binary choices (either/or patterns).
 */
function tryBinaryChoice(text: string): Omit<VibesDecisionEntry, 'type' | 'created_at'> | null {
	for (const pattern of BINARY_PATTERNS) {
		const match = pattern.exec(text);
		if (!match) {
			continue;
		}

		const optionA = truncate(match[1].trim(), 200);
		const optionB = truncate(match[2].trim(), 200);

		const options = [
			{ id: 'a', description: optionA },
			{ id: 'b', description: optionB },
		];

		// Need a selection to confirm this is a completed decision
		const selection = findSelection(text, options);
		if (!selection) {
			continue;
		}

		return {
			decision_point: extractDecisionPoint(text),
			options,
			selected: selection.selected,
			rationale: truncate(selection.rationale, 300),
			confidence: detectConfidence(text),
		};
	}

	return null;
}

/**
 * Try to detect "choosing X over Y because Z" patterns.
 * These are self-contained decisions that don't need a separate option listing.
 */
function tryChoosingPattern(text: string): Omit<VibesDecisionEntry, 'type' | 'created_at'> | null {
	// "Choosing X over Y because Z"
	const choosingMatch = /[Cc]hoosing\s+(.+?)\s+over\s+(.+?)\s+because\s+(.+?)(?:\.|$)/s.exec(text);
	if (choosingMatch) {
		const chosen = truncate(choosingMatch[1].trim(), 200);
		const rejected = truncate(choosingMatch[2].trim(), 200);
		const rationale = truncate(choosingMatch[3].trim(), 300);

		return {
			decision_point: extractDecisionPoint(text),
			options: [
				{ id: 'selected', description: chosen },
				{ id: 'rejected', description: rejected },
			],
			selected: 'selected',
			rationale,
			confidence: detectConfidence(text),
		};
	}

	return null;
}

// ============================================================================
// Extraction Helpers
// ============================================================================

/**
 * Find which option was selected based on selection patterns in the text.
 */
function findSelection(
	text: string,
	options: Array<{ id: string; description: string }>
): { selected: string; rationale: string } | null {
	for (const pattern of SELECTION_PATTERNS) {
		const match = pattern.exec(text);
		if (!match) {
			continue;
		}

		const selectedText = match[1].trim().toLowerCase();
		const rationale = match[match.length - 1].trim();

		// Try to match selected text against option IDs or descriptions
		for (const option of options) {
			if (
				option.id === selectedText ||
				option.description.toLowerCase().includes(selectedText) ||
				selectedText.includes(option.id)
			) {
				return { selected: option.id, rationale };
			}
		}

		// If no exact match, default to first option with the rationale
		return { selected: options[0].id, rationale };
	}

	return null;
}

/**
 * Extract a concise decision point description from the reasoning text.
 * Looks for lines that frame the question/decision context.
 */
function extractDecisionPoint(text: string): string {
	// Look for question-like patterns
	const questionMatch =
		/(?:The question is|I need to decide|The decision is|Should I)\s+(.+?)(?:\?|\.)/i.exec(text);
	if (questionMatch) {
		return truncate(questionMatch[1].trim(), 150);
	}

	// Look for "how to" or "whether to" patterns
	const howMatch = /(?:how to|whether to|which)\s+(.+?)(?:\.|,|\?)/i.exec(text);
	if (howMatch) {
		return truncate(howMatch[1].trim(), 150);
	}

	// Fallback: use the first sentence as context
	const firstSentence = text.match(/^[^.!?\n]+[.!?]?/);
	if (firstSentence) {
		return truncate(firstSentence[0].trim(), 150);
	}

	return 'Implementation approach';
}

/**
 * Detect confidence level from language used in reasoning.
 */
function detectConfidence(text: string): 'high' | 'medium' | 'low' {
	if (HIGH_CONFIDENCE_WORDS.test(text)) {
		return 'high';
	}
	if (LOW_CONFIDENCE_WORDS.test(text)) {
		return 'low';
	}
	return 'medium';
}

/**
 * Truncate a string to a maximum length, appending ellipsis if truncated.
 */
function truncate(text: string, maxLength: number): string {
	if (text.length <= maxLength) {
		return text;
	}
	return text.slice(0, maxLength - 3) + '...';
}
