import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useManagedAgentOptions } from '../../../renderer/hooks/enterprise/useManagedAgentOptions';
import { clearCachedResources } from '../../../renderer/hooks/utils/useCachedResource';

describe('managed agent options hook', () => {
	const now = Date.parse('2026-11-08T12:00:00Z');
	const read = vi.fn();
	const original = window.maestro;
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(now);
		clearCachedResources();
		window.maestro = { ...original, enterprise: { ...original.enterprise, managedState: read } };
		read.mockResolvedValue({
			agentOptions: {
				outcome: 'available',
				authority: 'none',
				policyRevision: 7,
				freshness: 'fresh',
				expiresAt: new Date(now + 1000).toISOString(),
				operations: ['create'],
				fields: {},
			},
		});
	});
	afterEach(() => {
		clearCachedResources();
		vi.useRealTimers();
		vi.restoreAllMocks();
		window.maestro = original;
	});

	it('withdraws cached choices at expiry before the next poll', async () => {
		const { result, unmount } = renderHook(() => useManagedAgentOptions());
		await act(async () => {});
		expect(result.current.options.outcome).toBe('available');
		await act(async () => {
			vi.advanceTimersByTime(1000);
		});
		expect(result.current.options).toMatchObject({ outcome: 'unavailable', freshness: 'stale' });
		expect(result.current.options).not.toHaveProperty('fields');
		unmount();
	});

	it('hides cached choices when a refresh fails and restores them after recovery', async () => {
		const { result } = renderHook(() => useManagedAgentOptions());
		await act(async () => {});
		read.mockRejectedValueOnce(new Error('offline'));
		await act(async () => {
			await result.current.refresh();
		});
		expect(result.current.options.outcome).toBe('unavailable');
		await act(async () => {
			await result.current.refresh();
		});
		expect(result.current.options.outcome).toBe('available');
	});

	it.each([
		null,
		{},
		{
			agentOptions: {
				outcome: 'unavailable',
				authority: 'none',
				policyRevision: null,
				freshness: 'unknown',
				reason: 'No policy',
			},
		},
	])('keeps absent and older hosts unavailable: %j', async (state) => {
		read.mockResolvedValue(state);
		const { result } = renderHook(() => useManagedAgentOptions());
		await act(async () => {});
		expect(result.current.options.outcome).toBe('unavailable');
	});
});
