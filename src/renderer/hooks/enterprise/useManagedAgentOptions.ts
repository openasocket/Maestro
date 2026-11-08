import { useEffect, useState } from 'react';
import type { ManagedAgentOptions } from '../../../shared/maestro-lib/managed/agent-policy';
import { useManagedStatus } from './useManagedStatus';

/** Read the same host projection as `maestro-cli managed status --json`.
 * Drafts remain the caller's; refresh never selects a replacement on their behalf.
 */
export function useManagedAgentOptions() {
	const resource = useManagedStatus();
	const options = resource.state?.agentOptions;
	const [, tick] = useState(0);
	const expires = options?.outcome === 'available' ? Date.parse(options.expiresAt) : NaN;
	useEffect(() => {
		if (!Number.isFinite(expires)) return;
		const timer = setTimeout(() => tick((value) => value + 1), Math.max(0, expires - Date.now()));
		return () => clearTimeout(timer);
	}, [expires]);
	const usable =
		resource.supported &&
		!resource.error &&
		options?.outcome === 'available' &&
		Number.isFinite(expires) &&
		Date.now() < expires;
	const result: ManagedAgentOptions = usable
		? options
		: {
				outcome: 'unavailable',
				authority: 'none',
				policyRevision: options?.policyRevision ?? null,
				freshness: options?.freshness === 'fresh' ? 'stale' : (options?.freshness ?? 'unknown'),
				reason:
					options?.outcome === 'unavailable'
						? options.reason
						: 'Refresh policy to load current approved choices.',
			};
	return {
		options: result,
		loading: resource.loading,
		refreshing: resource.refreshing,
		error: resource.error,
		refresh: resource.refresh,
	};
}
