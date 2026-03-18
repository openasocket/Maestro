/**
 * Tests for vibes:activity-feed IPC event emission.
 * Validates that the VibesCoordinator emits rich activity feed events to the
 * renderer via safeSend for tool executions, thinking chunks, prompts,
 * delegation, and session lifecycle — with correct debouncing and subagent detection.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

import { VibesCoordinator } from '../../../main/vibes/vibes-coordinator';
import type { VibesSettingsStore } from '../../../main/vibes/vibes-coordinator';
import { ensureAuditDir, flushAll, resetAllBuffers } from '../../../main/vibes/vibes-io';
import type { VibesActivityFeedEvent } from '../../../shared/vibes-types';
import type { ProcessConfig } from '../../../main/process-manager/types';

// ============================================================================
// Helpers
// ============================================================================

function createMockSettingsStore(overrides: Record<string, unknown> = {}): VibesSettingsStore {
	const settings: Record<string, unknown> = {
		vibesEnabled: true,
		vibesAssuranceLevel: 'medium',
		vibesInsightsEnabled: true,
		vibesPerAgentConfig: {
			'claude-code': { enabled: true },
			codex: { enabled: true },
		},
		...overrides,
	};

	return {
		get<T>(key: string, defaultValue?: T): T {
			const value = settings[key];
			return (value !== undefined ? value : defaultValue) as T;
		},
	};
}

function createProcessConfig(overrides: Partial<ProcessConfig> = {}): ProcessConfig {
	return {
		sessionId: 'sess-1',
		toolType: 'claude-code',
		cwd: '/tmp/test-project',
		command: 'claude',
		args: ['--print'],
		projectPath: '/tmp/test-project',
		...overrides,
	};
}

/** Extract all vibes:activity-feed calls from a mock safeSend. */
function getActivityFeedCalls(mockSafeSend: ReturnType<typeof vi.fn>): VibesActivityFeedEvent[] {
	return mockSafeSend.mock.calls
		.filter((call: unknown[]) => call[0] === 'vibes:activity-feed')
		.map((call: unknown[]) => call[1] as VibesActivityFeedEvent);
}

// ============================================================================
// Test Suite
// ============================================================================

describe('vibes:activity-feed emission', () => {
	const FIXED_ISO = '2026-03-17T12:00:00.000Z';
	let tmpDir: string;

	beforeEach(async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(FIXED_ISO));
		tmpDir = await mkdtemp(path.join(os.tmpdir(), 'vibes-activity-feed-test-'));
		await ensureAuditDir(tmpDir);
	});

	afterEach(async () => {
		// Flush pending debounced writes before resetting buffers
		vi.useRealTimers();
		await flushAll();
		resetAllBuffers();
		await rm(tmpDir, { recursive: true, force: true });
	});

	// ========================================================================
	// Tool Events
	// ========================================================================

	it('should emit tool activity feed event with correct category and detail', async () => {
		const mockSafeSend = vi.fn();
		const coordinator = new VibesCoordinator({
			settingsStore: createMockSettingsStore(),
			safeSend: mockSafeSend,
		});

		const config = createProcessConfig({ projectPath: tmpDir });
		await coordinator.handleProcessSpawn('sess-1', config);
		mockSafeSend.mockClear();

		await coordinator.handleToolExecution('sess-1', {
			toolName: 'Write',
			state: { file_path: 'src/main/index.ts', content: 'test' },
			timestamp: Date.now(),
		});

		const feedEvents = getActivityFeedCalls(mockSafeSend);
		expect(feedEvents.length).toBeGreaterThanOrEqual(1);

		const toolEvent = feedEvents.find((e) => e.category === 'tool');
		expect(toolEvent).toBeDefined();
		expect(toolEvent!.sessionId).toBe('sess-1');
		expect(toolEvent!.summary).toContain('Tool: Write');
		expect(toolEvent!.summary).toContain('src/main/index.ts');
		expect(toolEvent!.detail?.toolName).toBe('Write');
		expect(toolEvent!.detail?.filePath).toBe('src/main/index.ts');
		expect(toolEvent!.isSubagent).toBe(false);
		expect(toolEvent!.depth).toBe(0);
	});

	it('should emit tool event without filePath when state has no path', async () => {
		const mockSafeSend = vi.fn();
		const coordinator = new VibesCoordinator({
			settingsStore: createMockSettingsStore(),
			safeSend: mockSafeSend,
		});

		const config = createProcessConfig({ projectPath: tmpDir });
		await coordinator.handleProcessSpawn('sess-1', config);
		mockSafeSend.mockClear();

		await coordinator.handleToolExecution('sess-1', {
			toolName: 'Bash',
			state: { command: 'npm test' },
			timestamp: Date.now(),
		});

		const feedEvents = getActivityFeedCalls(mockSafeSend);
		const toolEvent = feedEvents.find((e) => e.category === 'tool');
		expect(toolEvent).toBeDefined();
		expect(toolEvent!.summary).toBe('Tool: Bash');
		expect(toolEvent!.detail?.filePath).toBeUndefined();
	});

	// ========================================================================
	// Thinking Events (Debounced)
	// ========================================================================

	it('should debounce thinking events — only 1 event per 2-second window', async () => {
		const mockSafeSend = vi.fn();
		const coordinator = new VibesCoordinator({
			settingsStore: createMockSettingsStore(),
			safeSend: mockSafeSend,
		});

		const config = createProcessConfig({ projectPath: tmpDir });
		await coordinator.handleProcessSpawn('sess-1', config);
		mockSafeSend.mockClear();

		// Send multiple rapid thinking chunks
		coordinator.handleThinkingChunk('sess-1', 'I need to ');
		coordinator.handleThinkingChunk('sess-1', 'implement the ');
		coordinator.handleThinkingChunk('sess-1', 'activity feed.');

		// No thinking events should be emitted yet (debounce pending)
		let thinkingEvents = getActivityFeedCalls(mockSafeSend).filter(
			(e) => e.category === 'thinking'
		);
		expect(thinkingEvents.length).toBe(0);

		// Advance timer past the 2-second debounce window
		vi.advanceTimersByTime(2100);

		thinkingEvents = getActivityFeedCalls(mockSafeSend).filter((e) => e.category === 'thinking');
		expect(thinkingEvents.length).toBe(1);

		// The buffered text should be concatenated
		expect(thinkingEvents[0].summary).toContain('I need to implement the activity feed.');
		expect(thinkingEvents[0].detail?.thinkingPreview).toContain(
			'I need to implement the activity feed.'
		);
	});

	it('should truncate thinking summary to 100 chars and preview to 200 chars', async () => {
		const mockSafeSend = vi.fn();
		const coordinator = new VibesCoordinator({
			settingsStore: createMockSettingsStore(),
			safeSend: mockSafeSend,
		});

		const config = createProcessConfig({ projectPath: tmpDir });
		await coordinator.handleProcessSpawn('sess-1', config);
		mockSafeSend.mockClear();

		const longText = 'A'.repeat(300);
		coordinator.handleThinkingChunk('sess-1', longText);

		vi.advanceTimersByTime(2100);

		const thinkingEvents = getActivityFeedCalls(mockSafeSend).filter(
			(e) => e.category === 'thinking'
		);
		expect(thinkingEvents.length).toBe(1);
		expect(thinkingEvents[0].summary.length).toBeLessThanOrEqual(103); // 100 + '...'
		expect(thinkingEvents[0].detail?.thinkingPreview?.length).toBeLessThanOrEqual(200);
	});

	// ========================================================================
	// Prompt Events
	// ========================================================================

	it('should emit prompt activity feed event', async () => {
		const mockSafeSend = vi.fn();
		const coordinator = new VibesCoordinator({
			settingsStore: createMockSettingsStore(),
			safeSend: mockSafeSend,
		});

		const config = createProcessConfig({ projectPath: tmpDir });
		await coordinator.handleProcessSpawn('sess-1', config);
		mockSafeSend.mockClear();

		await coordinator.handlePromptSent('sess-1', 'Please fix the login bug in auth.ts');

		const feedEvents = getActivityFeedCalls(mockSafeSend);
		const promptEvent = feedEvents.find((e) => e.category === 'prompt');
		expect(promptEvent).toBeDefined();
		expect(promptEvent!.summary).toContain('Please fix the login bug');
		expect(promptEvent!.isSubagent).toBe(false);
		expect(promptEvent!.depth).toBe(0);
	});

	// ========================================================================
	// Delegation Events
	// ========================================================================

	it('should emit delegation activity feed event for subagent sessions', async () => {
		const mockSafeSend = vi.fn();
		const coordinator = new VibesCoordinator({
			settingsStore: createMockSettingsStore(),
			safeSend: mockSafeSend,
		});

		// Start parent session
		const parentConfig = createProcessConfig({ projectPath: tmpDir });
		await coordinator.handleProcessSpawn('parent-sess', parentConfig);

		// Register delegation
		coordinator.registerDelegation('parent-sess', 'child-sess');

		mockSafeSend.mockClear();

		// Start child session
		const childConfig = createProcessConfig({
			projectPath: tmpDir,
			sessionId: 'child-sess',
		});
		await coordinator.handleProcessSpawn('child-sess', childConfig);

		const feedEvents = getActivityFeedCalls(mockSafeSend);
		const delegationEvent = feedEvents.find((e) => e.category === 'delegation');
		expect(delegationEvent).toBeDefined();
		expect(delegationEvent!.sessionId).toBe('parent-sess');
		expect(delegationEvent!.detail?.parentSessionId).toBe('parent-sess');
		expect(delegationEvent!.detail?.childSessionId).toBe('child-sess');
		expect(delegationEvent!.detail?.agentName).toBe('claude-code');
	});

	it('should detect subagent status and set isSubagent on tool events', async () => {
		const mockSafeSend = vi.fn();
		const coordinator = new VibesCoordinator({
			settingsStore: createMockSettingsStore(),
			safeSend: mockSafeSend,
		});

		// Start parent session
		const parentConfig = createProcessConfig({ projectPath: tmpDir });
		await coordinator.handleProcessSpawn('parent-sess', parentConfig);

		// Register delegation and start child
		coordinator.registerDelegation('parent-sess', 'child-sess');
		const childConfig = createProcessConfig({
			projectPath: tmpDir,
			sessionId: 'child-sess',
		});
		await coordinator.handleProcessSpawn('child-sess', childConfig);
		mockSafeSend.mockClear();

		// Tool event from child session
		await coordinator.handleToolExecution('child-sess', {
			toolName: 'Read',
			state: { file_path: 'README.md' },
			timestamp: Date.now(),
		});

		const feedEvents = getActivityFeedCalls(mockSafeSend);
		const toolEvent = feedEvents.find((e) => e.category === 'tool');
		expect(toolEvent).toBeDefined();
		expect(toolEvent!.isSubagent).toBe(true);
		expect(toolEvent!.depth).toBe(1);
	});

	// ========================================================================
	// Session Depth
	// ========================================================================

	it('should return correct depth for nested delegation chains', async () => {
		const mockSafeSend = vi.fn();
		const coordinator = new VibesCoordinator({
			settingsStore: createMockSettingsStore(),
			safeSend: mockSafeSend,
		});

		// Create 3-level chain: grandparent → parent → child
		const gpConfig = createProcessConfig({ projectPath: tmpDir });
		await coordinator.handleProcessSpawn('gp-sess', gpConfig);

		coordinator.registerDelegation('gp-sess', 'parent-sess');
		const parentConfig = createProcessConfig({
			projectPath: tmpDir,
			sessionId: 'parent-sess',
		});
		await coordinator.handleProcessSpawn('parent-sess', parentConfig);

		coordinator.registerDelegation('parent-sess', 'child-sess');
		const childConfig = createProcessConfig({
			projectPath: tmpDir,
			sessionId: 'child-sess',
		});
		await coordinator.handleProcessSpawn('child-sess', childConfig);
		mockSafeSend.mockClear();

		// Tool event from grandchild (depth=2)
		await coordinator.handleToolExecution('child-sess', {
			toolName: 'Grep',
			state: { pattern: 'test' },
			timestamp: Date.now(),
		});

		const feedEvents = getActivityFeedCalls(mockSafeSend);
		const toolEvent = feedEvents.find((e) => e.category === 'tool');
		expect(toolEvent).toBeDefined();
		expect(toolEvent!.depth).toBe(2);
		expect(toolEvent!.isSubagent).toBe(true);
	});

	// ========================================================================
	// Session Lifecycle Events
	// ========================================================================

	it('should emit session-start event for top-level sessions', async () => {
		const mockSafeSend = vi.fn();
		const coordinator = new VibesCoordinator({
			settingsStore: createMockSettingsStore(),
			safeSend: mockSafeSend,
		});

		const config = createProcessConfig({ projectPath: tmpDir });
		await coordinator.handleProcessSpawn('sess-1', config);

		const feedEvents = getActivityFeedCalls(mockSafeSend);
		const sessionEvent = feedEvents.find((e) => e.category === 'session');
		expect(sessionEvent).toBeDefined();
		expect(sessionEvent!.summary).toContain('Session started');
		expect(sessionEvent!.summary).toContain('claude-code');
	});

	it('should emit session-end event with annotation count', async () => {
		const mockSafeSend = vi.fn();
		const coordinator = new VibesCoordinator({
			settingsStore: createMockSettingsStore(),
			safeSend: mockSafeSend,
		});

		const config = createProcessConfig({ projectPath: tmpDir });
		await coordinator.handleProcessSpawn('sess-1', config);
		mockSafeSend.mockClear();

		await coordinator.handleProcessExit('sess-1', 0);

		const feedEvents = getActivityFeedCalls(mockSafeSend);
		const sessionEndEvent = feedEvents.find(
			(e) => e.category === 'session' && e.summary.includes('ended')
		);
		expect(sessionEndEvent).toBeDefined();
		expect(sessionEndEvent!.summary).toMatch(/Session ended \(\d+ annotations\)/);
	});

	// ========================================================================
	// Settings Gate
	// ========================================================================

	it('should NOT emit activity feed events when vibesInsightsEnabled is false', async () => {
		const mockSafeSend = vi.fn();
		const coordinator = new VibesCoordinator({
			settingsStore: createMockSettingsStore({ vibesInsightsEnabled: false }),
			safeSend: mockSafeSend,
		});

		const config = createProcessConfig({ projectPath: tmpDir });
		await coordinator.handleProcessSpawn('sess-1', config);

		await coordinator.handleToolExecution('sess-1', {
			toolName: 'Write',
			state: { file_path: 'test.ts' },
			timestamp: Date.now(),
		});

		coordinator.handleThinkingChunk('sess-1', 'Some thinking text');
		vi.advanceTimersByTime(2100);

		await coordinator.handlePromptSent('sess-1', 'Fix this bug');

		// No activity-feed events should be emitted (annotation-update events are fine)
		const feedEvents = getActivityFeedCalls(mockSafeSend);
		expect(feedEvents.length).toBe(0);
	});

	it('should NOT emit activity feed events when safeSend is not provided', async () => {
		const coordinator = new VibesCoordinator({
			settingsStore: createMockSettingsStore(),
		});

		const config = createProcessConfig({ projectPath: tmpDir });
		// Should not throw
		await coordinator.handleProcessSpawn('sess-1', config);

		await coordinator.handleToolExecution('sess-1', {
			toolName: 'Write',
			state: { file_path: 'test.ts' },
			timestamp: Date.now(),
		});

		// No way to verify no events were emitted without safeSend,
		// but this verifies no crashes occur
		const stats = coordinator.getSessionStats('sess-1');
		expect(stats).not.toBeNull();
	});

	// ========================================================================
	// Decision Events
	// ========================================================================

	it('should emit decision activity feed event with selected option and confidence', async () => {
		const mockSafeSend = vi.fn();
		const coordinator = new VibesCoordinator({
			settingsStore: createMockSettingsStore(),
			safeSend: mockSafeSend,
		});

		const config = createProcessConfig({ projectPath: tmpDir });
		await coordinator.handleProcessSpawn('sess-1', config);
		mockSafeSend.mockClear();

		await coordinator.handleDecision('sess-1', {
			decisionPoint: 'Database technology',
			options: [
				{ id: 'postgres', description: 'PostgreSQL' },
				{ id: 'sqlite', description: 'SQLite' },
			],
			selected: 'sqlite',
			rationale: 'Local-only app, no server needed',
			confidence: 'high',
		});

		const feedEvents = getActivityFeedCalls(mockSafeSend);
		const decisionEvent = feedEvents.find((e) => e.category === 'decision');
		expect(decisionEvent).toBeDefined();
		expect(decisionEvent!.sessionId).toBe('sess-1');
		expect(decisionEvent!.summary).toBe('Decision: Database technology → sqlite');
		expect(decisionEvent!.detail?.decisionPoint).toBe('Database technology');
		expect(decisionEvent!.detail?.selectedOption).toBe('sqlite');
		expect(decisionEvent!.detail?.confidence).toBe('high');
		expect(decisionEvent!.isSubagent).toBe(false);
		expect(decisionEvent!.depth).toBe(0);
	});

	it('should emit decision event without confidence when not provided', async () => {
		const mockSafeSend = vi.fn();
		const coordinator = new VibesCoordinator({
			settingsStore: createMockSettingsStore(),
			safeSend: mockSafeSend,
		});

		const config = createProcessConfig({ projectPath: tmpDir });
		await coordinator.handleProcessSpawn('sess-1', config);
		mockSafeSend.mockClear();

		await coordinator.handleDecision('sess-1', {
			decisionPoint: 'API style',
			options: [
				{ id: 'rest', description: 'REST' },
				{ id: 'graphql', description: 'GraphQL' },
			],
			selected: 'rest',
			rationale: 'Simpler for CRUD operations',
		});

		const feedEvents = getActivityFeedCalls(mockSafeSend);
		const decisionEvent = feedEvents.find((e) => e.category === 'decision');
		expect(decisionEvent).toBeDefined();
		expect(decisionEvent!.detail?.confidence).toBeUndefined();
		expect(decisionEvent!.detail?.selectedOption).toBe('rest');
	});

	it('should emit decision event with correct depth for subagent decisions', async () => {
		const mockSafeSend = vi.fn();
		const coordinator = new VibesCoordinator({
			settingsStore: createMockSettingsStore(),
			safeSend: mockSafeSend,
		});

		// Parent session
		const parentConfig = createProcessConfig({ projectPath: tmpDir });
		await coordinator.handleProcessSpawn('parent-sess', parentConfig);

		// Register delegation + start child
		coordinator.registerDelegation('parent-sess', 'child-sess');
		const childConfig = createProcessConfig({
			projectPath: tmpDir,
			sessionId: 'child-sess',
		});
		await coordinator.handleProcessSpawn('child-sess', childConfig);
		mockSafeSend.mockClear();

		await coordinator.handleDecision('child-sess', {
			decisionPoint: 'File format',
			options: [
				{ id: 'json', description: 'JSON' },
				{ id: 'yaml', description: 'YAML' },
			],
			selected: 'json',
			rationale: 'Better tooling support',
			confidence: 'medium',
		});

		const feedEvents = getActivityFeedCalls(mockSafeSend);
		const decisionEvent = feedEvents.find((e) => e.category === 'decision');
		expect(decisionEvent).toBeDefined();
		expect(decisionEvent!.isSubagent).toBe(true);
		expect(decisionEvent!.depth).toBe(1);
		expect(decisionEvent!.detail?.confidence).toBe('medium');
	});

	it('should NOT emit decision feed event when vibesInsightsEnabled is false', async () => {
		const mockSafeSend = vi.fn();
		const coordinator = new VibesCoordinator({
			settingsStore: createMockSettingsStore({ vibesInsightsEnabled: false }),
			safeSend: mockSafeSend,
		});

		const config = createProcessConfig({ projectPath: tmpDir });
		await coordinator.handleProcessSpawn('sess-1', config);
		mockSafeSend.mockClear();

		await coordinator.handleDecision('sess-1', {
			decisionPoint: 'Test framework',
			options: [
				{ id: 'vitest', description: 'Vitest' },
				{ id: 'jest', description: 'Jest' },
			],
			selected: 'vitest',
			rationale: 'Faster, native ESM',
			confidence: 'high',
		});

		const feedEvents = getActivityFeedCalls(mockSafeSend);
		expect(feedEvents.length).toBe(0);
	});

	// ========================================================================
	// Cleanup
	// ========================================================================

	it('should flush pending thinking on session exit', async () => {
		const mockSafeSend = vi.fn();
		const coordinator = new VibesCoordinator({
			settingsStore: createMockSettingsStore(),
			safeSend: mockSafeSend,
		});

		const config = createProcessConfig({ projectPath: tmpDir });
		await coordinator.handleProcessSpawn('sess-1', config);
		mockSafeSend.mockClear();

		// Send thinking but don't wait for debounce
		coordinator.handleThinkingChunk('sess-1', 'Pending thinking text');

		// Exit flushes pending thinking
		await coordinator.handleProcessExit('sess-1', 0);

		const thinkingEvents = getActivityFeedCalls(mockSafeSend).filter(
			(e) => e.category === 'thinking'
		);
		expect(thinkingEvents.length).toBe(1);
		expect(thinkingEvents[0].summary).toContain('Pending thinking text');
	});
});
