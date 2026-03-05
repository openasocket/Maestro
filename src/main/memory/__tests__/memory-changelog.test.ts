/**
 * Tests for MemoryChangeLog — ring buffer, persistence, filtering.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MemoryChangeEvent } from '../memory-changelog';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const fsState = new Map<string, string>();

vi.mock('fs/promises', () => ({
	readFile: vi.fn(async (filePath: string) => {
		const content = fsState.get(filePath);
		if (content === undefined) {
			const err = new Error(`ENOENT`) as NodeJS.ErrnoException;
			err.code = 'ENOENT';
			throw err;
		}
		return content;
	}),
	writeFile: vi.fn(async (filePath: string, content: string) => {
		fsState.set(filePath, content);
	}),
	mkdir: vi.fn(async () => {}),
}));

// Import after mocks
const { MemoryChangeLog } = await import('../memory-changelog');

function makeEvent(overrides: Partial<MemoryChangeEvent> = {}): MemoryChangeEvent {
	return {
		timestamp: Date.now(),
		type: 'created',
		memoryId: 'mem-1',
		memoryContent: 'Test memory content',
		memoryType: 'rule',
		scope: 'global',
		triggeredBy: 'user',
		...overrides,
	};
}

describe('MemoryChangeLog', () => {
	beforeEach(() => {
		fsState.clear();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('emits and retrieves events', () => {
		const log = new MemoryChangeLog('/tmp/memories');
		log.emit(makeEvent({ timestamp: 1000 }));
		log.emit(makeEvent({ timestamp: 2000, type: 'deleted' }));

		const events = log.getChangeLog();
		expect(events).toHaveLength(2);
		// Newest first
		expect(events[0].timestamp).toBe(2000);
		expect(events[1].timestamp).toBe(1000);
	});

	it('respects ring buffer max size of 500', () => {
		const log = new MemoryChangeLog('/tmp/memories');
		for (let i = 0; i < 600; i++) {
			log.emit(makeEvent({ timestamp: i, memoryId: `mem-${i}` }));
		}

		expect(log.size).toBe(500);
		// Oldest events should be trimmed — first surviving event is #100
		const events = log.getChangeLog();
		expect(events[events.length - 1].memoryId).toBe('mem-100');
		expect(events[0].memoryId).toBe('mem-599');
	});

	it('filters by since timestamp', () => {
		const log = new MemoryChangeLog('/tmp/memories');
		log.emit(makeEvent({ timestamp: 1000 }));
		log.emit(makeEvent({ timestamp: 2000 }));
		log.emit(makeEvent({ timestamp: 3000 }));

		const events = log.getChangeLog(2000);
		expect(events).toHaveLength(2);
		expect(events[0].timestamp).toBe(3000);
		expect(events[1].timestamp).toBe(2000);
	});

	it('respects limit parameter', () => {
		const log = new MemoryChangeLog('/tmp/memories');
		for (let i = 0; i < 10; i++) {
			log.emit(makeEvent({ timestamp: i }));
		}

		const events = log.getChangeLog(undefined, 3);
		expect(events).toHaveLength(3);
		// Newest first
		expect(events[0].timestamp).toBe(9);
	});

	it('combines since and limit', () => {
		const log = new MemoryChangeLog('/tmp/memories');
		for (let i = 0; i < 10; i++) {
			log.emit(makeEvent({ timestamp: i }));
		}

		const events = log.getChangeLog(5, 2);
		expect(events).toHaveLength(2);
		expect(events[0].timestamp).toBe(9);
		expect(events[1].timestamp).toBe(8);
	});

	it('loads persisted events from disk', async () => {
		const existing: MemoryChangeEvent[] = [
			makeEvent({ timestamp: 100, memoryId: 'old-1' }),
			makeEvent({ timestamp: 200, memoryId: 'old-2' }),
		];
		fsState.set('/tmp/memories/changelog.json', JSON.stringify(existing));

		const log = new MemoryChangeLog('/tmp/memories');
		await log.load();

		expect(log.size).toBe(2);
		const events = log.getChangeLog();
		expect(events[0].memoryId).toBe('old-2');
	});

	it('merges pre-load emitted events with loaded events', async () => {
		const existing: MemoryChangeEvent[] = [makeEvent({ timestamp: 100, memoryId: 'old-1' })];
		fsState.set('/tmp/memories/changelog.json', JSON.stringify(existing));

		const log = new MemoryChangeLog('/tmp/memories');
		// Emit before load completes
		log.emit(makeEvent({ timestamp: 500, memoryId: 'new-1' }));
		await log.load();

		expect(log.size).toBe(2);
		const events = log.getChangeLog();
		expect(events[0].memoryId).toBe('new-1');
		expect(events[1].memoryId).toBe('old-1');
	});

	it('handles corrupt/missing file gracefully on load', async () => {
		fsState.set('/tmp/memories/changelog.json', 'not-valid-json');

		const log = new MemoryChangeLog('/tmp/memories');
		await log.load(); // Should not throw

		expect(log.size).toBe(0);
	});

	it('flushes events to disk with debounce', async () => {
		const log = new MemoryChangeLog('/tmp/memories');
		log.emit(makeEvent({ timestamp: 1000, memoryId: 'flush-1' }));

		// Before debounce fires, nothing on disk yet
		expect(fsState.has('/tmp/memories/changelog.json')).toBe(false);

		// Advance past debounce (2000ms)
		await vi.advanceTimersByTimeAsync(2500);

		const persisted = fsState.get('/tmp/memories/changelog.json');
		expect(persisted).toBeDefined();
		const parsed = JSON.parse(persisted!);
		expect(parsed).toHaveLength(1);
		expect(parsed[0].memoryId).toBe('flush-1');
	});

	it('flush() writes immediately and clears dirty flag', async () => {
		const log = new MemoryChangeLog('/tmp/memories');
		log.emit(makeEvent({ timestamp: 1000 }));

		await log.flush();

		const persisted = fsState.get('/tmp/memories/changelog.json');
		expect(persisted).toBeDefined();

		// Second flush should be a no-op (not dirty)
		fsState.delete('/tmp/memories/changelog.json');
		await log.flush();
		expect(fsState.has('/tmp/memories/changelog.json')).toBe(false);
	});

	it('returns empty array when no events match filter', () => {
		const log = new MemoryChangeLog('/tmp/memories');
		log.emit(makeEvent({ timestamp: 1000 }));

		const events = log.getChangeLog(5000);
		expect(events).toHaveLength(0);
	});
});
