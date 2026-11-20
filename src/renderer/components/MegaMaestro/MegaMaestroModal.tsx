/**
 * The Mega-Maestro window: its own modal, separate from Settings. It holds only
 * what is about Mega-Maestro: the server address this desktop talks to, a lookup
 * of that server and of the local endpoint, the approval request that registers
 * this desktop with the server, and the enrollment and standing that follow.
 *
 * The default view (Overview) shows the Connect to your organization card
 * (ConnectCard, MSX-03-01) above the standing summary. Every technical
 * field (the connect status rows, the server host and port, the endpoint
 * socket, the lookup, the approval request, the enrollment cards and the last
 * refusal) lives on the Troubleshoot tab (TroubleshootPanel, MSX-01-04 and
 * MSX-03-03). The enrollment cards are the same EnrollmentPhases Settings >
 * Environment renders.
 */

import { useState } from 'react';
import type { Theme } from '../../types';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { Modal } from '../ui/Modal';
import { SegmentedControl } from '../ui/SegmentedControl';
import { MEGA_CONNECT_COPY } from '../../../shared/megaConnect/copy';
import { MegaMaestroSettings } from '../Settings/MegaMaestroSettings';
import { ConnectCard } from './ConnectCard';
import { MEGA_MAESTRO_COPY, PanelButton, TroubleshootPanel } from './TroubleshootPanel';

type MegaMaestroTab = 'overview' | 'troubleshoot';

const TAB_OPTIONS = [
	{ value: 'overview', label: MEGA_CONNECT_COPY.panelTabOverview },
	{ value: 'troubleshoot', label: MEGA_CONNECT_COPY.panelTabTroubleshoot },
] as const;

export function MegaMaestroModal({ theme, onClose }: { theme: Theme; onClose: () => void }) {
	const api = typeof window !== 'undefined' ? window.maestro?.enterprise : undefined;
	const supported = typeof api?.megaServerGet === 'function';
	const [tab, setTab] = useState<MegaMaestroTab>('overview');

	return (
		<Modal
			theme={theme}
			title={MEGA_MAESTRO_COPY.title}
			priority={MODAL_PRIORITIES.CONFIRM}
			onClose={onClose}
			resizeKey="mega-maestro"
			defaultSize={{ width: 760, height: 820 }}
			minSize={{ width: 520, height: 480 }}
			closeOnBackdropClick
			footer={<PanelButton label="Close" onClick={onClose} disabled={false} theme={theme} />}
		>
			<div className="space-y-6 p-4 select-text">
				<p className="text-sm opacity-80">{MEGA_MAESTRO_COPY.intro}</p>
				{!supported ? <p className="text-sm">{MEGA_MAESTRO_COPY.unsupported}</p> : null}
				<SegmentedControl
					value={tab}
					onChange={setTab}
					options={TAB_OPTIONS}
					theme={theme}
					ariaLabel={MEGA_CONNECT_COPY.panelTabsLabel}
					testId="mega-maestro-tab"
				/>

				{tab === 'overview' ? (
					<>
						<ConnectCard theme={theme} />
						{supported ? <MegaMaestroSettings theme={theme} enrollment={false} /> : null}
					</>
				) : (
					<TroubleshootPanel theme={theme} />
				)}
			</div>
		</Modal>
	);
}
