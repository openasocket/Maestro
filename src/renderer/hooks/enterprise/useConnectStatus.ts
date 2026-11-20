/**
 * useConnectStatus - Maestro's connect status (MSX-02-02), read once and then
 * followed through `connect.onStatus`, for a surface that only shows it.
 *
 * Answers `undefined` until main answers, and stays `undefined` where there is
 * no connect bridge (a browser, an older preload) or the first read fails: a
 * caller then draws what it drew before the connect service existed. The
 * Connect card keeps its own subscription because it also owns the form.
 */

import { useEffect, useState } from 'react';
import type { MegaConnectStatus } from '../../../shared/megaConnect/view';

export function useConnectStatus(): MegaConnectStatus | undefined {
	const [status, setStatus] = useState<MegaConnectStatus | undefined>(undefined);
	useEffect(() => {
		const api = typeof window !== 'undefined' ? window.maestro?.enterprise?.connect : undefined;
		if (!api || typeof api.status !== 'function' || typeof api.onStatus !== 'function') return;
		let cancelled = false;
		const take = (view: { status: MegaConnectStatus } | null | undefined) => {
			if (!cancelled && view?.status) setStatus(view.status);
		};
		// A failed first read leaves the answer undefined; the next push fills it.
		void api.status().then(take, () => undefined);
		const off = api.onStatus(take);
		return () => {
			cancelled = true;
			off();
		};
	}, []);
	return status;
}
