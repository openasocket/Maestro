import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseStats } from '../../../renderer/hooks/useVibesData';

describe('parseStats', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it('returns null for undefined input', () => {
		expect(parseStats(undefined)).toBeNull();
	});

	it('returns null for empty string', () => {
		expect(parseStats('')).toBeNull();
	});

	it('parses snake_case fields from JSON string', () => {
		const raw = JSON.stringify({
			total_annotations: 42,
			files_covered: 10,
			total_tracked_files: 25,
			coverage_percent: 40,
			active_sessions: 3,
			contributing_models: 2,
			assurance_level: 'medium',
		});
		const result = parseStats(raw);
		expect(result).toEqual({
			totalAnnotations: 42,
			filesCovered: 10,
			totalTrackedFiles: 25,
			coveragePercent: 40,
			activeSessions: 3,
			contributingModels: 2,
			assuranceLevel: 'medium',
		});
	});

	it('parses camelCase fields from JSON string', () => {
		const raw = JSON.stringify({
			totalAnnotations: 15,
			filesCovered: 5,
			totalTrackedFiles: 20,
			coveragePercent: 25,
			activeSessions: 1,
			contributingModels: 1,
			assuranceLevel: 'high',
		});
		const result = parseStats(raw);
		expect(result).toEqual({
			totalAnnotations: 15,
			filesCovered: 5,
			totalTrackedFiles: 20,
			coveragePercent: 25,
			activeSessions: 1,
			contributingModels: 1,
			assuranceLevel: 'high',
		});
	});

	it('handles pre-parsed object (skips JSON.parse)', () => {
		const raw = {
			total_annotations: 7,
			files_covered: 3,
			total_tracked_files: 10,
			coverage_percent: 30,
			active_sessions: 1,
			contributing_models: 1,
			assurance_level: 'low',
		};
		const result = parseStats(raw);
		expect(result).toEqual({
			totalAnnotations: 7,
			filesCovered: 3,
			totalTrackedFiles: 10,
			coveragePercent: 30,
			activeSessions: 1,
			contributingModels: 1,
			assuranceLevel: 'low',
		});
	});

	it('defaults missing fields to 0 or null', () => {
		const raw = JSON.stringify({});
		const result = parseStats(raw);
		expect(result).toEqual({
			totalAnnotations: 0,
			filesCovered: 0,
			totalTrackedFiles: 0,
			coveragePercent: 0,
			activeSessions: 0,
			contributingModels: 0,
			assuranceLevel: null,
		});
	});

	it('prefers snake_case over camelCase when both present', () => {
		const raw = JSON.stringify({
			total_annotations: 100,
			totalAnnotations: 50,
		});
		const result = parseStats(raw);
		expect(result?.totalAnnotations).toBe(100);
	});

	it('warns on invalid JSON and returns null', () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const result = parseStats('not valid json');
		expect(result).toBeNull();
		expect(warnSpy).toHaveBeenCalledWith(
			'useVibesData: parseStats failed',
			expect.any(SyntaxError),
			'not valid json',
		);
	});
});
