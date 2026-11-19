/**
 * The relayed enrollment phase text (decision D1), as the CLI file and the
 * Mega-Maestro pane both read it: a phase's fields are named when missing, a
 * `phase` field must agree with the card that sent it, and the parsed input
 * carries the phase the caller asked for.
 */

import { describe, expect, it } from 'vitest';
import { ENROLLMENT_PHASE_FIELDS, parseEnrollmentPhase } from '../../shared/enrollmentPhases';

const MANAGEMENT = {
	origin: 'https://mega.example',
	tenantId: 't-1',
	issuerSha256: 'a'.repeat(64),
};

describe('parseEnrollmentPhase', () => {
	it('names every field a phase needs', () => {
		expect(ENROLLMENT_PHASE_FIELDS.request).toEqual([
			'socketPath',
			'management',
			'orgId',
			'serverCaPem',
		]);
		expect(ENROLLMENT_PHASE_FIELDS.prove).toEqual(['socketPath', 'management', 'challenge']);
		expect(ENROLLMENT_PHASE_FIELDS.activate).toEqual(['socketPath', 'management', 'activation']);
	});

	it('parses a complete request and stamps the phase the card asked for', () => {
		const text = JSON.stringify({
			socketPath: '/tmp/ipc.sock',
			management: MANAGEMENT,
			orgId: 'org-1',
			serverCaPem: 'pem',
		});
		const parsed = parseEnrollmentPhase('request', text);
		expect(parsed).toEqual({
			ok: true,
			input: {
				phase: 'request',
				socketPath: '/tmp/ipc.sock',
				management: MANAGEMENT,
				orgId: 'org-1',
				serverCaPem: 'pem',
			},
		});
	});

	it('refuses text that is not JSON, and text that is not an object', () => {
		expect(parseEnrollmentPhase('request', '{nope')).toMatchObject({ ok: false });
		expect(parseEnrollmentPhase('request', '[1,2]')).toMatchObject({ ok: false });
		expect(parseEnrollmentPhase('request', 'null')).toMatchObject({ ok: false });
	});

	it('names the missing fields, all of them', () => {
		const parsed = parseEnrollmentPhase('prove', JSON.stringify({ socketPath: '/s' }));
		expect(parsed).toEqual({
			ok: false,
			message: 'Missing fields: management, challenge.',
		});
	});

	it('refuses a phase field that disagrees with its card, and accepts one that agrees', () => {
		const body = { socketPath: '/s', management: MANAGEMENT, challenge: { id: 'c-1' } };
		expect(parseEnrollmentPhase('prove', JSON.stringify({ ...body, phase: 'activate' }))).toEqual({
			ok: false,
			message: 'This card sends the prove phase, not activate.',
		});
		expect(
			parseEnrollmentPhase('prove', JSON.stringify({ ...body, phase: 'prove' }))
		).toMatchObject({
			ok: true,
			input: { phase: 'prove' },
		});
	});
});
