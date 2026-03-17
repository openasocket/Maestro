// VIBES v1.0 PRISM Risk Scoring Stub — Placeholder for future PRISM extension.
// When implemented, this will compute risk_score and risk_factors for each annotation.

import type { VibesLineAnnotation, VibeFunctionAnnotation } from '../../shared/vibes-types';

/**
 * PRISM risk scoring stub.
 * Returns null — actual implementation per the PRISM spec is a future feature.
 * When implemented, this will compute risk_score and risk_factors for each annotation.
 */
export function computeRiskScore(_annotation: VibesLineAnnotation | VibeFunctionAnnotation): {
	risk_score: number;
	risk_factors: Array<{ signal: string; value: number; weight: number }>;
} | null {
	return null; // PRISM not yet implemented
}
