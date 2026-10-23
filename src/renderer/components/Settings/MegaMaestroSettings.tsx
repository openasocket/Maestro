/**
 * MegaMaestroSettings - the Mega-Maestro management section of the Environment
 * tab (MRC-11-03).
 *
 * A diagnostics pane, not a setting: it shows the standing the main process
 * projects (`src/main/enterprise/managed-state.ts`) and offers the three narrow
 * verbs that can make it fresher (refresh the policy, recover the standing,
 * complete a registration). There is no control here that switches management
 * off: a record the endpoint still manages is released by the endpoint
 * administrator, and the main process refuses a local retire, revoke or forget
 * by name, so the pane says so instead of offering it.
 *
 * Every string a person reads lives in `COPY`, so a translation replaces the
 * table; the facts are a `<dl>` so a screen reader pairs each term with its
 * value; the outcome of an action is announced through a polite live region;
 * the approval code a recovery hands back is shown once and kept nowhere.
 *
 * The standing itself is `<ManagedStatus>` (`src/renderer/components/Enterprise/`,
 * MRC-11-04), so a header slot and this pane never spell the word twice; the
 * notices addressed to the actor join it as `<ManagedInbox>` (MRC-11-04A).
 */

import { useState, type ReactNode } from 'react';
import { AlertTriangle, ShieldCheck } from 'lucide-react';
import { formatRelativeTime } from '../../../shared/formatters';
import type { ManagedStateView } from '../../../main/enterprise/managed-state';
import {
	useManagedStatus,
	type ManagedActionResult,
	type ManagedActionVerb,
} from '../../hooks/enterprise/useManagedStatus';
import type { Theme } from '../../types';
import { ManagedInbox } from '../Enterprise/ManagedInbox';
import { ManagedStatus, STATUS_COPY } from '../Enterprise/ManagedStatus';
import { SettingsSectionHeading } from './SettingsSectionHeading';
import { SectionCard } from './tabs/DisplayTab/components/SectionCard';

export const COPY = {
	heading: 'Mega-Maestro management',
	intro:
		'Enrollment of this desktop with a Mega-Maestro endpoint. The endpoint applies management; this pane reports it and cannot switch it off.',
	desktopOnly: STATUS_COPY.desktopOnly,
	noService: STATUS_COPY.noService,
	reading: STATUS_COPY.reading,
	readFailed: STATUS_COPY.readFailed,
	standing: STATUS_COPY.standing,
	organization: 'Organization',
	enrollment: 'Enrollment',
	installation: 'Installation',
	endpoint: 'Endpoint',
	lastDenial: 'Last denial',
	actor: 'Actor',
	policy: 'Policy',
	capabilities: 'Capabilities',
	missing: 'Not negotiated',
	admission: 'Admission',
	possible: 'Possible: a fresh decision can be asked for.',
	leaving: 'Leaving management',
	notEnrolled: 'Not enrolled',
	notReported: 'Not reported by the endpoint',
	notNamed: 'Not named by the endpoint',
	detached: 'Detached',
	attached: 'Attached',
	none: 'None',
	refresh: 'Refresh policy',
	recover: 'Recover standing',
	complete: 'Complete registration',
	working: 'Working...',
	approvalCode: 'Approval code, shown once',
	phase: { none: 'Not registered', challenged: 'Approval pending', registered: 'Registered' },
	release: {
		'no-record': 'Nothing to leave: this desktop holds no record.',
		final: 'The record is final; it may be forgotten.',
		released: 'The endpoint has released this installation; the record may be forgotten.',
	},
} as const;

const FAILED: ReadonlySet<ManagedActionResult['status']> = new Set([
	'refused',
	'denied',
	'unsupported',
	'unavailable',
	'unknown',
]);

function Row({ term, children }: { term: string; children: ReactNode }) {
	return (
		<>
			<dt className="opacity-70">{term}</dt>
			<dd>{children}</dd>
		</>
	);
}

function at(iso: string | null): string {
	return iso ? formatRelativeTime(iso) : COPY.none;
}

function revision(value: number | null): string {
	return value === null ? COPY.none : String(value);
}

function Facts({ state }: { state: ManagedStateView }) {
	const { enrollment, endpoint, actor, policy, capabilities } = state;
	return (
		<dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs select-text">
			<Row term={COPY.organization}>
				{enrollment ? `${enrollment.orgId} (tenant ${enrollment.tenantId})` : COPY.notEnrolled}
			</Row>
			{enrollment ? (
				<>
					<Row term={COPY.enrollment}>
						{`${enrollment.enrollmentId ?? COPY.notReported}; record ${enrollment.management}, enrolled ${at(enrollment.enrolledAt)}, updated ${at(enrollment.updatedAt)}`}
					</Row>
					<Row term={COPY.installation}>{enrollment.installationId}</Row>
				</>
			) : null}
			<Row term={COPY.endpoint}>
				{endpoint.attached
					? `${COPY.attached}: ${endpoint.management ?? COPY.none}, ${endpoint.connectivity}, collection ${endpoint.collectionProfile ?? COPY.none}`
					: COPY.detached}
			</Row>
			{endpoint.lastDenial ? (
				<Row term={COPY.lastDenial}>
					{`${endpoint.lastDenial.reason} on ${endpoint.lastDenial.operation}, ${at(endpoint.lastDenial.at)}`}
				</Row>
			) : null}
			<Row term={COPY.actor}>
				{`${COPY.phase[actor.phase]}; ${actor.actorId ?? COPY.notNamed}; registration ${actor.registration.state}${actor.registration.expiresAt ? `, lapses ${at(actor.registration.expiresAt)}` : ''}; approval ${actor.approval.state}`}
			</Row>
			<Row term={COPY.policy}>
				{`applied ${revision(policy.appliedRevision)}, desired ${revision(policy.desiredRevision)}, installed ${revision(policy.installedRevision)}; ${policy.source}, ${policy.freshness}, observed ${at(policy.observedAt)}; offline mode ${policy.offline.mode}`}
			</Row>
			<Row term={COPY.capabilities}>{capabilities.negotiated.join(', ') || COPY.none}</Row>
			<Row term={COPY.missing}>{capabilities.missing.join(', ') || COPY.none}</Row>
			<Row term={COPY.admission}>
				{policy.admission.possible ? (
					COPY.possible
				) : (
					<ul className="list-disc pl-4">
						{policy.admission.reasons.map((reason) => (
							<li key={reason}>{reason}</li>
						))}
					</ul>
				)}
			</Row>
		</dl>
	);
}

function ActionButton({
	theme,
	label,
	busy,
	disabled,
	onClick,
}: {
	theme: Theme;
	label: string;
	busy: boolean;
	disabled: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			disabled={disabled}
			aria-busy={busy}
			onClick={onClick}
			className="w-full px-3 py-2 rounded border text-sm disabled:opacity-55"
			style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgActivity }}
		>
			{busy ? COPY.working : label}
		</button>
	);
}

export function MegaMaestroSettings({ theme }: { theme: Theme }) {
	const managed = useManagedStatus();
	const [outcome, setOutcome] = useState<ManagedActionResult | null>(null);
	const [busy, setBusy] = useState<ManagedActionVerb | null>(null);
	const state = managed.state;

	const act = async (verb: ManagedActionVerb) => {
		if (busy) return;
		setBusy(verb);
		try {
			setOutcome(await managed.run(verb));
		} finally {
			setBusy(null);
		}
	};

	// A browser, no service, the first read and a failed read are the standing's own sentences.
	const standing = <ManagedStatus theme={theme} status={managed} />;
	let body: ReactNode;
	if (!state) body = standing;
	else {
		const completeOffered =
			outcome?.handoff !== null && outcome?.handoff !== undefined
				? true
				: state.actor.approval.state === 'pending';
		body = (
			<>
				{standing}
				<Facts state={state} />
				<div>
					<span className="font-medium">{COPY.leaving}</span>
					{state.localRelease.allowed ? (
						<p className="text-xs opacity-70 mt-0.5">{COPY.release[state.localRelease.reason]}</p>
					) : (
						<div
							className="flex items-start gap-1.5 text-xs mt-0.5"
							style={{ color: theme.colors.warning }}
						>
							<AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
							<span>{state.localRelease.message}</span>
						</div>
					)}
				</div>
				<div role="status" aria-live="polite" className="text-xs space-y-1">
					{outcome ? (
						<p style={FAILED.has(outcome.status) ? { color: theme.colors.error } : undefined}>
							{outcome.message}
						</p>
					) : null}
					{outcome?.handoff ? (
						<p className="select-text">
							{`${COPY.approvalCode} (${outcome.handoff.challengeId}, lapses ${at(outcome.handoff.expiresAt)}): `}
							<code className="font-mono">{outcome.handoff.nonce}</code>
						</p>
					) : null}
				</div>
				<ActionButton
					theme={theme}
					label={COPY.refresh}
					busy={busy === 'refreshPolicy'}
					disabled={busy !== null}
					onClick={() => void act('refreshPolicy')}
				/>
				<ActionButton
					theme={theme}
					label={COPY.recover}
					busy={busy === 'recoverPolicy'}
					disabled={busy !== null}
					onClick={() => void act('recoverPolicy')}
				/>
				{completeOffered ? (
					<ActionButton
						theme={theme}
						label={COPY.complete}
						busy={busy === 'completeRegistration'}
						disabled={busy !== null}
						onClick={() => void act('completeRegistration')}
					/>
				) : null}
				<ManagedInbox theme={theme} />
			</>
		);
	}

	return (
		<div data-setting-id="environment-mega-maestro">
			<SettingsSectionHeading icon={ShieldCheck} description={COPY.intro}>
				{COPY.heading}
			</SettingsSectionHeading>
			<SectionCard theme={theme}>{body}</SectionCard>
		</div>
	);
}
