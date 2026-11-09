/**
 * ManagedRunState - how the managed run a composer turn started stands, with
 * the host's own reason, the policy revision it ran under and the recovery
 * the host allows (MCOMP-25-02).
 *
 * Drawn from `describeManagedRun()` over the tab's `managedRun` (the spawn's
 * view, MCOMP-25-01A), the dispatch ledger's read of the same lease once the
 * turn is no longer live (`useManagedRun()`, MCOMP-25-01B), the host standing
 * (`useManagedStatus()`) and the last send's refusal. A standalone host binds
 * no lease and refuses nothing, so an unmanaged Maestro draws nothing here.
 *
 * A display, never authority: every action asks the host again. `refresh`
 * re-reads the ledger here; `stop`, `retry` and `refreshPolicy` go to the
 * caller's `onAction`, which owns the process, the composer and the policy
 * verbs. An action the caller does not handle is not drawn, so a button never
 * promises what nothing behind it does. Every string a person reads lives in
 * `RUN_STATE_COPY` or `MANAGED_RUN_COPY`.
 */

import { useState } from 'react';
import type { ManagedRunView } from '../../../main/enterprise/dispatch';
import type { ManagedStateView } from '../../../main/enterprise/managed-state';
import {
	describeManagedRun,
	useManagedRun,
	type ManagedRunAction,
	type ManagedRunRefusal,
} from '../../hooks/enterprise/useManagedStatus';
import type { Theme } from '../../types';
import { MiniBadge } from '../ui/MiniBadge';

export const RUN_STATE_COPY = {
	title: 'Managed run',
	revision: (revision: number) => `Policy revision ${revision}`,
	revisionNow: (revision: number, now: number) =>
		`Policy revision ${revision} (the host now applies ${now})`,
	lease: (leaseId: string) => `Lease ${leaseId}`,
	working: 'Working...',
	actions: {
		stop: 'Stop',
		retry: 'Send again',
		refresh: 'Check again',
		refreshPolicy: 'Refresh policy',
	} satisfies Record<ManagedRunAction, string>,
	/** The accessible name of each action, which says what the host is asked. */
	actionHints: {
		stop: 'Stop this turn; its lease is released as stopped.',
		retry: 'Send this turn again; the host admits it under the policy in force now.',
		refresh: 'Read this run back from the dispatch ledger.',
		refreshPolicy: 'Ask the endpoint for the current policy.',
	} satisfies Record<ManagedRunAction, string>,
} as const;

export interface ManagedRunStateProps {
	theme: Theme;
	/** The tab's `managedRun`: the run its last send started. */
	run: ManagedRunView | null | undefined;
	/** Whether the tab's turn is live. */
	busy: boolean;
	/** `useManagedStatus().state`. */
	standing: ManagedStateView | null | undefined;
	/** The last send's managed refusal, when no run started. */
	refusal?: ManagedRunRefusal | null;
	/** Performs `stop`, `retry` and `refreshPolicy`; an action left unhandled is not drawn. */
	onAction?: (action: Exclude<ManagedRunAction, 'refresh'>) => void | Promise<void>;
	/** Which of those `onAction` handles; defaults to all three when `onAction` is given. */
	handles?: readonly Exclude<ManagedRunAction, 'refresh'>[];
	testId?: string;
}

const ALL_HANDLED: readonly Exclude<ManagedRunAction, 'refresh'>[] = [
	'stop',
	'retry',
	'refreshPolicy',
];

export function ManagedRunState({
	theme,
	run,
	busy,
	standing,
	refusal = null,
	onAction,
	handles,
	testId = 'managed-run-state',
}: ManagedRunStateProps) {
	const [working, setWorking] = useState<ManagedRunAction | null>(null);
	// While the turn is live the spawn's view is the newest; after it, the ledger's.
	const ledger = useManagedRun(run?.leaseId, { enabled: !busy });
	const current =
		ledger.run && run && ledger.run.leaseId === run.leaseId ? ledger.run : (run ?? null);
	const view = describeManagedRun({ run: current, busy, standing, refusal });
	if (!view) return null;

	const handled = onAction ? (handles ?? ALL_HANDLED) : [];
	const actions = view.actions.filter(
		(action) => action === 'refresh' || (handled as readonly string[]).includes(action)
	);
	const perform = async (action: ManagedRunAction) => {
		setWorking(action);
		try {
			if (action === 'refresh') await ledger.refresh();
			else await onAction?.(action);
		} finally {
			setWorking(null);
		}
	};

	const revision =
		view.revision === null
			? null
			: view.currentRevision === null
				? RUN_STATE_COPY.revision(view.revision)
				: RUN_STATE_COPY.revisionNow(view.revision, view.currentRevision);

	return (
		<section
			aria-label={RUN_STATE_COPY.title}
			className="flex flex-col gap-1 text-xs"
			data-testid={testId}
			data-run-word={view.word}
		>
			<div role="status" aria-live="polite" className="flex items-center gap-2">
				<span className="font-medium">{RUN_STATE_COPY.title}</span>
				<MiniBadge
					label={view.label}
					theme={theme}
					color={theme.colors[view.tint]}
					testId={`${testId}-word`}
				/>
				<span className="sr-only">{view.detail}</span>
			</div>
			<p className="opacity-70" aria-hidden="true">
				{view.detail}
			</p>
			{view.reason ? (
				<p className="select-text" data-testid={`${testId}-reason`}>
					{view.reason}
				</p>
			) : null}
			{revision || view.leaseId ? (
				<p className="opacity-70 select-text" data-testid={`${testId}-ids`}>
					{[revision, view.leaseId ? RUN_STATE_COPY.lease(view.leaseId) : null]
						.filter(Boolean)
						.join(' · ')}
				</p>
			) : null}
			{actions.length > 0 ? (
				<div className="flex gap-1.5 mt-0.5">
					{actions.map((action) => (
						<button
							key={action}
							type="button"
							disabled={working !== null}
							aria-busy={working === action}
							aria-label={RUN_STATE_COPY.actionHints[action]}
							title={RUN_STATE_COPY.actionHints[action]}
							onClick={() => void perform(action)}
							className="px-2.5 py-1 rounded border text-xs disabled:opacity-55"
							style={{
								borderColor: theme.colors.border,
								backgroundColor: theme.colors.bgActivity,
							}}
						>
							{working === action ? RUN_STATE_COPY.working : RUN_STATE_COPY.actions[action]}
						</button>
					))}
				</div>
			) : null}
		</section>
	);
}
