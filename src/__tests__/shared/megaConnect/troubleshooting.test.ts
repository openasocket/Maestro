/**
 * `megaConnect/troubleshooting.ts` is a transcription of the contracts 0.5.1
 * error catalog; this test holds it equal to the vendored module: the same
 * codes, a deep-equal `explain()` for every one, and the same generic entry
 * for a code neither knows.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
	explain,
	hasTroubleshootingEntry,
	troubleshootingCatalog,
} from '../../../shared/megaConnect/troubleshooting';

let vendored: typeof import('../../../../vendor/mega-maestro/contracts/dist/troubleshooting.js');
beforeAll(async () => {
	vendored = await import('../../../../vendor/mega-maestro/contracts/dist/troubleshooting.js');
});

describe('troubleshooting catalog (transcription of contracts 0.5.1)', () => {
	it('has exactly the vendored codes', () => {
		expect(Object.keys(troubleshootingCatalog).sort()).toEqual(
			Object.keys(vendored.troubleshootingCatalog).sort()
		);
		expect(Object.keys(troubleshootingCatalog).length).toBeGreaterThan(200);
	});

	it('explains every vendored code exactly as the contracts do', () => {
		for (const code of Object.keys(vendored.troubleshootingCatalog)) {
			expect({ code, entry: explain(code) }).toEqual({ code, entry: vendored.explain(code) });
			expect(hasTroubleshootingEntry(code)).toBe(true);
		}
	});

	it.each([
		'NOT_A_REAL_CODE',
		'endpoint_connect_unavailable',
		'invalid_input',
		'a',
		'A'.repeat(64),
		'A'.repeat(65),
		'',
		'9starts_with_digit',
		'has space',
		'line\nbreak',
		'\u0000nul',
		'emoji\u{1F600}',
		'../../etc/passwd',
		'__proto__',
		'constructor',
		'toString',
		'hasOwnProperty',
	])('answers the vendored generic entry for unknown code %j', (code) => {
		expect(explain(code)).toEqual(vendored.explain(code));
		expect(hasTroubleshootingEntry(code)).toBe(false);
	});

	it('never echoes a non-printable unknown code', () => {
		expect(explain('line\nbreak').advancedHint).toBe('Unknown code.');
		expect(explain('NOT_A_REAL_CODE').advancedHint).toBe('Unknown code NOT_A_REAL_CODE.');
	});

	it('knows the one connect refusal the endpoint shares with Maestro', () => {
		expect(hasTroubleshootingEntry('pin_mismatch')).toBe(true);
		expect(explain('pin_mismatch').title).toBe('Server identity does not match');
	});
});
