/**
 * useMegaServerSettings - the Mega-Maestro server this desktop is saved to, for
 * a status indicator that names it without contacting it.
 *
 * Reads `window.maestro.enterprise.megaServerGet()` (the saved choice, never a
 * lookup) and re-reads on the standing's own cadence, so a server saved in the
 * Mega-Maestro window reaches the header without a restart. `undefined` is the
 * first read, `null` is a desktop with no enterprise bridge or a failed read.
 */

import { useEffect, useState } from 'react';
import type { MegaServerSettings } from '../../../shared/megaServer';
import { MANAGED_STATE_POLL_MS } from './useManagedStatus';

export function useMegaServerSettings(): MegaServerSettings | null | undefined {
	const [settings, setSettings] = useState<MegaServerSettings | null | undefined>(undefined);

	useEffect(() => {
		let live = true;
		const read = () => {
			const api = typeof window !== 'undefined' ? window.maestro?.enterprise : undefined;
			if (typeof api?.megaServerGet !== 'function') {
				setSettings(null);
				return;
			}
			api.megaServerGet().then(
				(saved) => {
					if (live) setSettings(saved);
				},
				() => {
					if (live) setSettings(null);
				}
			);
		};
		read();
		const timer = setInterval(read, MANAGED_STATE_POLL_MS);
		return () => {
			live = false;
			clearInterval(timer);
		};
	}, []);

	return settings;
}
