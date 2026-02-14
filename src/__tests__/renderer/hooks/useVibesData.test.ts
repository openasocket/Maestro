import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseStats, parseSessions, parseModels } from '../../../renderer/hooks/useVibesData';

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

describe('parseSessions', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it('returns empty array for undefined input', () => {
		expect(parseSessions(undefined)).toEqual([]);
	});

	it('returns empty array for empty string', () => {
		expect(parseSessions('')).toEqual([]);
	});

	it('parses backend snake_case session fields from JSON string', () => {
		const raw = JSON.stringify([
			{
				session_id: 'sess-001',
				event: 'start',
				timestamp: '2026-02-13T10:00:00Z',
				agent_type: 'claude-code',
				annotation_count: 5,
			},
		]);
		const result = parseSessions(raw);
		expect(result).toEqual([
			{
				sessionId: 'sess-001',
				startTime: '2026-02-13T10:00:00Z',
				endTime: undefined,
				annotationCount: 5,
				toolName: 'claude-code',
				modelName: undefined,
			},
		]);
	});

	it('maps agent_type to toolName as fallback', () => {
		const raw = JSON.stringify([
			{
				session_id: 'sess-002',
				event: 'start',
				timestamp: '2026-02-13T11:00:00Z',
				agent_type: 'codex',
				annotation_count: 3,
			},
		]);
		const result = parseSessions(raw);
		expect(result[0].toolName).toBe('codex');
	});

	it('prefers tool_name over agent_type when both present', () => {
		const raw = JSON.stringify([
			{
				session_id: 'sess-003',
				event: 'start',
				timestamp: '2026-02-13T12:00:00Z',
				tool_name: 'preferred-tool',
				agent_type: 'fallback-agent',
				annotation_count: 1,
			},
		]);
		const result = parseSessions(raw);
		expect(result[0].toolName).toBe('preferred-tool');
	});

	it('filters out end events so sessions appear once', () => {
		const raw = JSON.stringify([
			{
				session_id: 'sess-004',
				event: 'start',
				timestamp: '2026-02-13T10:00:00Z',
				agent_type: 'claude-code',
				annotation_count: 10,
			},
			{
				session_id: 'sess-004',
				event: 'end',
				timestamp: '2026-02-13T10:30:00Z',
				agent_type: 'claude-code',
				annotation_count: 10,
			},
		]);
		const result = parseSessions(raw);
		expect(result).toHaveLength(1);
		expect(result[0].sessionId).toBe('sess-004');
	});

	it('filters out entries with empty sessionId', () => {
		const raw = JSON.stringify([
			{
				session_id: '',
				event: 'start',
				timestamp: '2026-02-13T10:00:00Z',
				annotation_count: 0,
			},
			{
				session_id: 'sess-005',
				event: 'start',
				timestamp: '2026-02-13T11:00:00Z',
				annotation_count: 2,
			},
		]);
		const result = parseSessions(raw);
		expect(result).toHaveLength(1);
		expect(result[0].sessionId).toBe('sess-005');
	});

	it('handles pre-parsed object array (skips JSON.parse)', () => {
		const raw = [
			{
				session_id: 'sess-006',
				event: 'start',
				timestamp: '2026-02-13T14:00:00Z',
				agent_type: 'opencode',
				annotation_count: 7,
			},
		];
		const result = parseSessions(raw);
		expect(result).toEqual([
			{
				sessionId: 'sess-006',
				startTime: '2026-02-13T14:00:00Z',
				endTime: undefined,
				annotationCount: 7,
				toolName: 'opencode',
				modelName: undefined,
			},
		]);
	});

	it('handles wrapped { sessions: [...] } format', () => {
		const raw = JSON.stringify({
			sessions: [
				{
					sessionId: 'sess-007',
					startTime: '2026-02-13T15:00:00Z',
					annotationCount: 4,
					toolName: 'factory-droid',
				},
			],
		});
		const result = parseSessions(raw);
		expect(result).toHaveLength(1);
		expect(result[0].sessionId).toBe('sess-007');
		expect(result[0].toolName).toBe('factory-droid');
	});

	it('defaults missing fields correctly', () => {
		const raw = JSON.stringify([
			{
				session_id: 'sess-008',
				event: 'start',
			},
		]);
		const result = parseSessions(raw);
		expect(result[0]).toEqual({
			sessionId: 'sess-008',
			startTime: '',
			endTime: undefined,
			annotationCount: 0,
			toolName: undefined,
			modelName: undefined,
		});
	});

	it('warns on invalid JSON and returns empty array', () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const result = parseSessions('not valid json');
		expect(result).toEqual([]);
		expect(warnSpy).toHaveBeenCalledWith(
			'useVibesData: parseSessions failed',
			expect.any(SyntaxError),
			'not valid json',
		);
	});
});

describe('parseModels', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it('returns empty array for undefined input', () => {
		expect(parseModels(undefined)).toEqual([]);
	});

	it('returns empty array for empty string', () => {
		expect(parseModels('')).toEqual([]);
	});

	it('parses snake_case fields from a direct JSON array', () => {
		const raw = JSON.stringify([
			{
				model_name: 'claude-3.5-sonnet',
				model_version: '20250101',
				tool_name: 'claude-code',
				annotation_count: 15,
				percentage: 75,
			},
		]);
		const result = parseModels(raw);
		expect(result).toEqual([
			{
				modelName: 'claude-3.5-sonnet',
				modelVersion: '20250101',
				toolName: 'claude-code',
				annotationCount: 15,
				percentage: 75,
			},
		]);
	});

	it('parses camelCase fields', () => {
		const raw = JSON.stringify([
			{
				modelName: 'gpt-4',
				modelVersion: 'v1',
				toolName: 'codex',
				annotationCount: 10,
				percentage: 50,
			},
		]);
		const result = parseModels(raw);
		expect(result[0].modelName).toBe('gpt-4');
		expect(result[0].toolName).toBe('codex');
	});

	it('handles wrapped { models: [...] } format', () => {
		const raw = JSON.stringify({
			models: [
				{ model_name: 'llama-3', annotation_count: 5 },
			],
		});
		const result = parseModels(raw);
		expect(result).toHaveLength(1);
		expect(result[0].modelName).toBe('llama-3');
	});

	it('handles pre-parsed object array (skips JSON.parse)', () => {
		const raw = [
			{
				model_name: 'claude-opus',
				model_version: '4.0',
				tool_name: 'claude-code',
				annotation_count: 20,
				percentage: 100,
			},
		];
		const result = parseModels(raw);
		expect(result).toHaveLength(1);
		expect(result[0].modelName).toBe('claude-opus');
		expect(result[0].percentage).toBe(100);
	});

	it('computes percentages when not provided by backend', () => {
		const raw = JSON.stringify([
			{ model_name: 'model-a', annotation_count: 3 },
			{ model_name: 'model-b', annotation_count: 7 },
		]);
		const result = parseModels(raw);
		expect(result[0].percentage).toBe(30);
		expect(result[1].percentage).toBe(70);
	});

	it('does not overwrite existing non-zero percentages', () => {
		const raw = JSON.stringify([
			{ model_name: 'model-a', annotation_count: 5, percentage: 42 },
		]);
		const result = parseModels(raw);
		expect(result[0].percentage).toBe(42);
	});

	it('defaults missing fields correctly', () => {
		const raw = JSON.stringify([{}]);
		const result = parseModels(raw);
		expect(result[0]).toEqual({
			modelName: 'Unknown',
			modelVersion: undefined,
			toolName: undefined,
			annotationCount: 0,
			percentage: 0,
		});
	});

	it('returns empty array for empty data array', () => {
		const raw = JSON.stringify([]);
		const result = parseModels(raw);
		expect(result).toEqual([]);
	});

	it('warns on invalid JSON and returns empty array', () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const result = parseModels('not valid json');
		expect(result).toEqual([]);
		expect(warnSpy).toHaveBeenCalledWith(
			'useVibesData: parseModels failed',
			expect.any(SyntaxError),
			'not valid json',
		);
	});
});
