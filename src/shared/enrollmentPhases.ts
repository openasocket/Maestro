/**
 * The relayed enrollment phases (decision D1) as the CLI file and the desktop
 * pane both name them: the fields each phase carries, and how one phase's
 * JSON text becomes the input `requestEnrollment` takes. Shared so the CLI
 * (`maestro-cli managed enroll request`) and the Mega-Maestro pane cannot drift.
 */

import type {
	EndpointEnrollmentActivation,
	EndpointEnrollmentManagement,
	EndpointPossessionChallenge,
} from './maestro-lib/managed/endpoint-port';

/** What every relayed phase carries besides its own body. */
interface EnrollmentPhaseCommon {
	socketPath: string;
	management: EndpointEnrollmentManagement;
}

/**
 * One relayed enrollment phase (decision D1). `request` also carries the
 * organization the operator asserts from the central console (the tenant is
 * the management's); the endpoint does not report it over the socket.
 */
export type EnrollmentRequestInput =
	| (EnrollmentPhaseCommon & {
			phase: 'request';
			orgId: string;
			serverCaPem: string;
	  })
	| (EnrollmentPhaseCommon & { phase: 'prove'; challenge: EndpointPossessionChallenge })
	| (EnrollmentPhaseCommon & { phase: 'activate'; activation: EndpointEnrollmentActivation });

export type EnrollmentPhase = EnrollmentRequestInput['phase'];

/** The fields each relayed enrollment phase names; the desktop validates their values. */
export const ENROLLMENT_PHASE_FIELDS: Readonly<Record<EnrollmentPhase, readonly string[]>> = {
	request: ['socketPath', 'management', 'orgId', 'serverCaPem'],
	prove: ['socketPath', 'management', 'challenge'],
	activate: ['socketPath', 'management', 'activation'],
};

/** A field the operator has not filled: absent, empty text, or an empty object. */
function isBlank(value: unknown): boolean {
	return (
		value === undefined ||
		value === null ||
		value === '' ||
		(typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0)
	);
}

export type EnrollmentPhaseParse =
	| { ok: true; input: EnrollmentRequestInput }
	| { ok: false; message: string };

/**
 * Parse one phase's JSON object. The phase is the one the caller asked for:
 * a `phase` field in the text is accepted only when it agrees. Missing fields
 * are named; their values are checked by the desktop, not here.
 */
export function parseEnrollmentPhase(phase: EnrollmentPhase, text: string): EnrollmentPhaseParse {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return { ok: false, message: 'The text is not valid JSON.' };
	}
	if (typeof value !== 'object' || value === null || Array.isArray(value))
		return { ok: false, message: 'The enrollment phase must be a JSON object.' };
	const record = value as Record<string, unknown>;
	if (record.phase !== undefined && record.phase !== phase)
		return {
			ok: false,
			message: `This card sends the ${phase} phase, not ${String(record.phase)}.`,
		};
	const missing = ENROLLMENT_PHASE_FIELDS[phase].filter((field) => isBlank(record[field]));
	if (missing.length > 0)
		return {
			ok: false,
			message: `Missing field${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}.`,
		};
	return { ok: true, input: { ...record, phase } as EnrollmentRequestInput };
}
