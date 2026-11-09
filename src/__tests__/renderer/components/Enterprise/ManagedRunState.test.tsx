/**
 * The managed run a composer turn started (MCOMP-25-02): `describeManagedRun()`
 * names each of the seven words from the run, the live turn, the host standing
 * and a refusal, never with a success tint the ledger did not record, and
 * offers only the recovery the host allows; `<ManagedRunState>` draws it as a
 * labelled section with one polite status line, reads the ledger back once the
 * turn ends, and draws only the actions its caller performs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
	ManagedRunState,
	RUN_STATE_COPY,
} from '../../../../renderer/components/Enterprise/ManagedRunState';
import {
	MANAGED_RUN_COPY,
	describeManagedRun,
	type ManagedRunStateInput,
} from '../../../../renderer/hooks/enterprise/useManagedStatus';
import { clearCachedResources } from '../../../../renderer/hooks/utils/useCachedResource';
import type { ManagedRunView } from '../../../../main/enterprise/dispatch';
import type { ManagedStanding, ManagedStateView } from '../../../../main/enterprise/managed-state';
import { mockTheme } from '../../../helpers/mockTheme';

function runOf(over: Partial<ManagedRunView> = {}): ManagedRunView {
	return {
		leaseId: 'lease-1',
		authorityId: 'auth-1',
		requestId: 'req-1',
		attemptId: 'att-1',
		runId: null,
		requestDigest: 'sha256:abc',
		provider: 'claude-code',
		operation: 'start',
		actor: { kind: 'user', id: 'u-1' } as ManagedRunView['actor'],
		policyRevision: 4,
		decision: null,
		effect: { state: 'bound', release: null, reason: null },
		...over,
	};
}

function standingOf(standing: ManagedStanding, applied = 4, reason: string | null = null) {
	return { standing, reason, policy: { appliedRevision: applied } } as unknown as ManagedStateView;
}

const managed = standingOf('managed');

function describe_(input: Partial<ManagedRunStateInput>) {
	return describeManagedRun({ run: null, busy: false, standing: managed, ...input });
}

describe('describeManagedRun', () => {
	it('draws nothing for a standalone host: no run and no refusal', () => {
		expect(describe_({ run: null, busy: true })).toBeNull();
		expect(describe_({ run: undefined, standing: null })).toBeNull();
	});

	it('a live bound lease is running with stop as its only action', () => {
		const view = describe_({ run: runOf(), busy: true });
		expect(view).toMatchObject({
			word: 'running',
			tint: 'accent',
			actions: ['stop'],
			revision: 4,
			currentRevision: null,
			leaseId: 'lease-1',
		});
	});

	it('an admitted lease not yet bound is admitted', () => {
		const view = describe_({
			run: runOf({ effect: { state: 'admitted', release: null, reason: null } }),
			busy: true,
		});
		expect(view?.word).toBe('admitted');
	});

	it('a live run with no readable standing is offline, never a success word', () => {
		for (const standing of [null, undefined, standingOf('offline', 4, 'No endpoint.')]) {
			const view = describe_({ run: runOf(), busy: true, standing });
			expect(view?.word).toBe('offline');
			expect(view?.tint).toBe('warning');
			expect(view?.actions).toEqual(['stop']);
		}
	});

	it('policy loss mid-run reads revoked with the host reason, and stop stays available', () => {
		const view = describe_({
			run: runOf(),
			busy: true,
			standing: standingOf('suspended', 5, 'The endpoint suspended this installation.'),
		});
		expect(view).toMatchObject({
			word: 'revoked',
			reason: 'The endpoint suspended this installation.',
			actions: ['stop'],
			currentRevision: 5,
		});
	});

	it('a bound lease whose turn ended is unknown until the ledger is read back', () => {
		const view = describe_({ run: runOf(), busy: false });
		expect(view).toMatchObject({ word: 'unknown', tint: 'warning', actions: ['refresh'] });
	});

	it('a released lease is completed; success tint only for a clean exit or a stop', () => {
		const clean = describe_({
			run: runOf({
				effect: {
					state: 'released',
					release: { outcome: 'exited', exitCode: 0, signal: null },
					reason: null,
				},
			}),
		});
		expect(clean).toMatchObject({ word: 'completed', tint: 'success', actions: ['retry'] });
		expect(clean?.reason).toBe('The process exited with code 0.');

		const stopped = describe_({
			run: runOf({
				effect: { state: 'released', release: { outcome: 'stopped', by: 'caller' }, reason: null },
			}),
		});
		expect(stopped).toMatchObject({ word: 'completed', tint: 'success' });
		expect(stopped?.reason).toBe('Stopped from Maestro.');

		const failed = describe_({
			run: runOf({
				effect: {
					state: 'released',
					release: { outcome: 'exited', exitCode: 2, signal: null },
					reason: null,
				},
			}),
		});
		expect(failed).toMatchObject({ word: 'completed', tint: 'warning' });
	});

	it('a revoked or expired lease reads revoked with policy refresh and a fresh send', () => {
		for (const state of ['revoked', 'expired'] as const) {
			const view = describe_({
				run: runOf({ effect: { state, release: null, reason: null } }),
			});
			expect(view).toMatchObject({
				word: 'revoked',
				tint: 'error',
				actions: ['refreshPolicy', 'retry'],
			});
			expect(view?.reason).toBeTruthy();
		}
	});

	it('a restart-unknown lease reads unknown with the ledger sentence and no blind resend', () => {
		const view = describe_({
			run: runOf({
				effect: {
					state: 'unknown',
					release: null,
					reason: 'The host restarted while this lease was live.',
				},
			}),
		});
		expect(view).toMatchObject({
			word: 'unknown',
			reason: 'The host restarted while this lease was live.',
		});
		// Retry is offered as a choice, never taken on its own; check again reads the ledger.
		expect(view?.actions).toEqual(['refresh', 'retry']);
	});

	it('a refusal names the host code and reads denied, offline or unknown', () => {
		const denied = describe_({
			refusal: { state: 'denied', code: 'policy-denied', message: 'Codex is not allowed.' },
		});
		expect(denied).toMatchObject({
			word: 'denied',
			tint: 'error',
			reason: '[managed-policy-denied] Codex is not allowed.',
			revision: null,
			leaseId: null,
		});
		expect(
			describe_({
				refusal: { state: 'unavailable', code: 'runtime-unavailable', message: 'Down.' },
			})?.word
		).toBe('offline');
		expect(
			describe_({ refusal: { state: 'unknown', code: 'outcome-unknown', message: 'Lost.' } })?.word
		).toBe('unknown');
	});

	it('never offers a resend while the host refuses managed execution', () => {
		const view = describe_({
			run: runOf({ effect: { state: 'revoked', release: null, reason: 'Revoked.' } }),
			standing: standingOf('revoked'),
		});
		expect(view?.actions).toEqual(['refreshPolicy']);
	});

	it('names the decision revision and the revision the host applies now when they differ', () => {
		const view = describe_({
			run: runOf({
				policyRevision: 3,
				decision: { decisionId: 'd-1', brokerId: 'b-1', policyRevision: 3 },
			}),
			busy: true,
			standing: standingOf('managed', 6),
		});
		expect(view).toMatchObject({ revision: 3, currentRevision: 6 });
	});

	it('every word has its own label and sentence', () => {
		const labels = Object.values(MANAGED_RUN_COPY).map((copy) => copy.label);
		expect(new Set(labels).size).toBe(7);
	});
});

const managedRun = vi.fn();
const maestro = window.maestro as unknown as Record<string, unknown>;
const originalEnterprise = maestro.enterprise;

beforeEach(() => {
	clearCachedResources();
	managedRun.mockReset().mockResolvedValue(null);
	maestro.enterprise = { managedRun };
});

afterEach(() => {
	maestro.enterprise = originalEnterprise;
});

describe('<ManagedRunState>', () => {
	it('draws nothing on a standalone host', () => {
		const { container } = render(
			<ManagedRunState theme={mockTheme} run={undefined} busy={false} standing={null} />
		);
		expect(container).toBeEmptyDOMElement();
	});

	it('a live run is a labelled section with a polite status and does not read the ledger', () => {
		const onAction = vi.fn();
		render(
			<ManagedRunState
				theme={mockTheme}
				run={runOf()}
				busy
				standing={managed}
				onAction={onAction}
			/>
		);
		const section = screen.getByRole('region', { name: RUN_STATE_COPY.title });
		expect(section).toHaveAttribute('data-run-word', 'running');
		expect(screen.getByRole('status')).toHaveTextContent(MANAGED_RUN_COPY.running.label);
		expect(screen.getByTestId('managed-run-state-ids')).toHaveTextContent('Policy revision 4');
		expect(screen.getByTestId('managed-run-state-ids')).toHaveTextContent('Lease lease-1');
		fireEvent.click(screen.getByRole('button', { name: RUN_STATE_COPY.actionHints.stop }));
		expect(onAction).toHaveBeenCalledWith('stop');
		expect(managedRun).not.toHaveBeenCalled();
	});

	it('after the turn ends, the ledger read replaces the spawn view', async () => {
		managedRun.mockResolvedValue(
			runOf({
				runId: 'run-9',
				effect: { state: 'released', release: { outcome: 'stopped', by: 'caller' }, reason: null },
			})
		);
		render(<ManagedRunState theme={mockTheme} run={runOf()} busy={false} standing={managed} />);
		await waitFor(() =>
			expect(screen.getByTestId('managed-run-state')).toHaveAttribute('data-run-word', 'completed')
		);
		expect(managedRun).toHaveBeenCalledWith('lease-1');
		expect(screen.getByTestId('managed-run-state-reason')).toHaveTextContent(
			'Stopped from Maestro.'
		);
	});

	it('a ledger answer for another lease is never joined', async () => {
		managedRun.mockResolvedValue(
			runOf({ leaseId: 'lease-other', effect: { state: 'revoked', release: null, reason: 'x' } })
		);
		render(<ManagedRunState theme={mockTheme} run={runOf()} busy={false} standing={managed} />);
		await waitFor(() => expect(managedRun).toHaveBeenCalled());
		expect(screen.getByTestId('managed-run-state')).toHaveAttribute('data-run-word', 'unknown');
	});

	it('check again re-reads the ledger itself', async () => {
		render(<ManagedRunState theme={mockTheme} run={runOf()} busy={false} standing={managed} />);
		await waitFor(() => expect(managedRun).toHaveBeenCalledTimes(1));
		fireEvent.click(screen.getByRole('button', { name: RUN_STATE_COPY.actionHints.refresh }));
		await waitFor(() => expect(managedRun).toHaveBeenCalledTimes(2));
	});

	it('draws only the actions the caller performs', async () => {
		const run = runOf({ effect: { state: 'revoked', release: null, reason: 'Revoked.' } });
		managedRun.mockResolvedValue(run);
		const { rerender } = render(
			<ManagedRunState theme={mockTheme} run={run} busy={false} standing={managed} />
		);
		await waitFor(() => expect(managedRun).toHaveBeenCalled());
		expect(screen.queryAllByRole('button')).toHaveLength(0);

		const onAction = vi.fn().mockResolvedValue(undefined);
		rerender(
			<ManagedRunState
				theme={mockTheme}
				run={run}
				busy={false}
				standing={managed}
				onAction={onAction}
				handles={['retry']}
			/>
		);
		expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual([
			RUN_STATE_COPY.actions.retry,
		]);
		fireEvent.click(screen.getByRole('button', { name: RUN_STATE_COPY.actionHints.retry }));
		await waitFor(() => expect(onAction).toHaveBeenCalledWith('retry'));
	});

	it('a refusal shows the host code with no lease', () => {
		render(
			<ManagedRunState
				theme={mockTheme}
				run={undefined}
				busy={false}
				standing={managed}
				refusal={{ state: 'denied', code: 'policy-denied', message: 'Not allowed.' }}
			/>
		);
		expect(screen.getByTestId('managed-run-state')).toHaveAttribute('data-run-word', 'denied');
		expect(screen.getByTestId('managed-run-state-reason')).toHaveTextContent(
			'[managed-policy-denied] Not allowed.'
		);
		expect(screen.queryByTestId('managed-run-state-ids')).toBeNull();
		expect(managedRun).not.toHaveBeenCalled();
	});
});
