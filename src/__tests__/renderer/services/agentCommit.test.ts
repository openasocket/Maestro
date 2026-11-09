/**
 * sessionFromCommittedRecord registers the host record as the persistence baseline
 * in the shape the persistence hook reads (`{ sessions }`), not a bare array.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { sessionFromCommittedRecord } from '../../../renderer/services/agentCommit';
import {
	SESSION_PERSISTENCE_BASELINE_EVENT,
	useDebouncedPersistence,
	type SessionPersistenceBaseline,
} from '../../../renderer/hooks/utils/useDebouncedPersistence';
import type { MutableRefObject } from 'react';
import type { Session } from '../../../renderer/types';

const record = { id: 'agent-1', name: 'Agent', toolType: 'claude-code', cwd: '/tmp/a' };

describe('sessionFromCommittedRecord', () => {
	let seen: CustomEvent<SessionPersistenceBaseline>[] = [];
	const listener = (event: Event) => seen.push(event as CustomEvent<SessionPersistenceBaseline>);

	afterEach(() => {
		window.removeEventListener(SESSION_PERSISTENCE_BASELINE_EVENT, listener);
		seen = [];
	});

	it('dispatches the record as the baseline under `sessions`, as a copy', () => {
		window.addEventListener(SESSION_PERSISTENCE_BASELINE_EVENT, listener);
		const draft = { id: 'agent-1' } as unknown as Session;
		const session = sessionFromCommittedRecord(draft, record);
		expect(seen).toHaveLength(1);
		const detail = seen[0].detail;
		expect(Array.isArray(detail)).toBe(false);
		expect(detail.sessions).toEqual([record]);
		expect(detail.sessions[0]).not.toBe(record);
		expect(detail.recovered).toBeUndefined();
		expect(session).toMatchObject(record);
	});

	it('is read by a mounted persistence hook without throwing', () => {
		const errors: unknown[] = [];
		const onError = (event: ErrorEvent) => {
			errors.push(event.error);
			event.preventDefault();
		};
		window.addEventListener('error', onError);
		const { unmount } = renderHook(() =>
			useDebouncedPersistence({ current: false } as MutableRefObject<boolean>)
		);
		try {
			sessionFromCommittedRecord({ id: 'agent-1' } as unknown as Session, record);
			expect(errors).toEqual([]);
		} finally {
			unmount();
			window.removeEventListener('error', onError);
		}
	});
});
