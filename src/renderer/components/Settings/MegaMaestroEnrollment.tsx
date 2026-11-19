/**
 * The enrollment section of the Mega-Maestro pane (decision D1): one card per
 * relayed phase (request, prove, activate). Each card holds the phase's JSON,
 * the same object `maestro-cli managed enroll request --file` reads, and sends
 * it through `window.maestro.enterprise.requestEnrollment`. The desktop
 * validates the values and writes nothing unless the endpoint answered.
 */

import { useState } from 'react';
import type { LifecycleOutcome } from '../../../main/enterprise/enrollment';
import { parseEnrollmentPhase, type EnrollmentPhase } from '../../../shared/enrollmentPhases';
import type { Theme } from '../../types';

export const ENROLLMENT_COPY = {
	heading: 'Enroll this desktop',
	intro:
		'Enrollment runs in three steps with the Mega-Maestro console: send the request, then the possession challenge the console issues, then the activation it returns. Paste each step’s JSON here. Nothing is written unless the endpoint answers.',
	send: 'Send',
	working: 'Sending...',
	invalid: 'Not sent.',
	accepted: 'Accepted by the endpoint',
	noSurface: 'This surface cannot send enrollment steps.',
	titles: {
		request: '1. Request',
		prove: '2. Prove possession',
		activate: '3. Activate',
	} satisfies Record<EnrollmentPhase, string>,
} as const;

const PHASES: readonly EnrollmentPhase[] = ['request', 'prove', 'activate'];

/** The starting text of each card: the fields the phase names, empty for the operator to fill. */
const TEMPLATES: Record<EnrollmentPhase, string> = {
	request: JSON.stringify(
		{
			socketPath: '',
			management: { origin: '', tenantId: '', issuerSha256: '' },
			orgId: '',
			serverCaPem: '',
		},
		null,
		2
	),
	prove: JSON.stringify(
		{ socketPath: '', management: { origin: '', tenantId: '', issuerSha256: '' }, challenge: {} },
		null,
		2
	),
	activate: JSON.stringify(
		{ socketPath: '', management: { origin: '', tenantId: '', issuerSha256: '' }, activation: {} },
		null,
		2
	),
};

/** A plain sentence for what the endpoint (or the desktop) answered. */
export function describeEnrollmentOutcome(outcome: LifecycleOutcome<unknown>): string {
	switch (outcome.status) {
		case 'ok': {
			const value = outcome.value as { outcome?: unknown } | null;
			return typeof value?.outcome === 'string'
				? `${ENROLLMENT_COPY.accepted} (${value.outcome.replace(/_/g, ' ')}).`
				: `${ENROLLMENT_COPY.accepted}.`;
		}
		case 'denied':
			return `The endpoint denied ${outcome.operation}: ${outcome.reason.replace(/_/g, ' ')}.`;
		case 'refused':
		case 'unsupported':
		case 'unavailable':
		case 'unknown':
			return outcome.message;
	}
}

export function EnrollmentPhases({
	theme,
	onAnswered,
}: {
	theme: Theme;
	/** Called after every answer, so the standing above the cards is read again. */
	onAnswered: () => void;
}) {
	const [texts, setTexts] = useState<Record<EnrollmentPhase, string>>(TEMPLATES);
	const [busy, setBusy] = useState<EnrollmentPhase | null>(null);
	const [messages, setMessages] = useState<Partial<Record<EnrollmentPhase, string>>>({});

	const send = async (phase: EnrollmentPhase) => {
		if (busy) return;
		const parsed = parseEnrollmentPhase(phase, texts[phase]);
		if (!parsed.ok) {
			setMessages((m) => ({ ...m, [phase]: `${ENROLLMENT_COPY.invalid} ${parsed.message}` }));
			return;
		}
		const api = window.maestro?.enterprise;
		if (typeof api?.requestEnrollment !== 'function') {
			setMessages((m) => ({ ...m, [phase]: ENROLLMENT_COPY.noSurface }));
			return;
		}
		setBusy(phase);
		try {
			const outcome = await api.requestEnrollment(parsed.input);
			setMessages((m) => ({ ...m, [phase]: describeEnrollmentOutcome(outcome) }));
		} finally {
			setBusy(null);
			onAnswered();
		}
	};

	return (
		<section aria-labelledby="mega-enroll-heading" className="space-y-3">
			<div>
				<h4 id="mega-enroll-heading" className="font-medium">
					{ENROLLMENT_COPY.heading}
				</h4>
				<p className="text-xs opacity-70 mt-0.5">{ENROLLMENT_COPY.intro}</p>
			</div>
			{PHASES.map((phase) => (
				<div key={phase} className="space-y-1">
					<label htmlFor={`mega-enroll-${phase}`} className="text-sm font-medium">
						{ENROLLMENT_COPY.titles[phase]}
					</label>
					<textarea
						id={`mega-enroll-${phase}`}
						value={texts[phase]}
						spellCheck={false}
						rows={8}
						onChange={(event) => {
							const value = event.target.value;
							setTexts((t) => ({ ...t, [phase]: value }));
						}}
						className="w-full px-2 py-1 rounded border font-mono text-xs"
						style={{
							borderColor: theme.colors.border,
							backgroundColor: theme.colors.bgActivity,
							color: theme.colors.textMain,
						}}
					/>
					<button
						type="button"
						disabled={busy !== null}
						aria-busy={busy === phase}
						onClick={() => void send(phase)}
						className="w-full px-3 py-2 rounded border text-sm disabled:opacity-55"
						style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgActivity }}
					>
						{busy === phase ? ENROLLMENT_COPY.working : ENROLLMENT_COPY.send}
					</button>
					{messages[phase] ? (
						<p role="status" aria-live="polite" className="text-xs select-text">
							{messages[phase]}
						</p>
					) : null}
				</div>
			))}
		</section>
	);
}
