/**
 * The settings write authority a handler suite composes (MRC2-06-04): the REAL
 * settings policy source over an enrolled host under one applied policy
 * revision, with the given locks installed, set as the one authority every
 * `hold*Write()` in `src/main/enterprise/settings-policy.ts` reads. Remove it
 * with `setSettingsWriteAuthority(null)` after the test; a document the parser
 * refuses fails the test by name instead of leaving the host standalone.
 */

import { expect } from 'vitest';
import {
	createSettingsPolicySource,
	setSettingsWriteAuthority,
	type SettingsPolicySource,
} from '../../main/enterprise/settings-policy';

export function installManagedSettingsPolicy(
	locks: unknown[],
	policyRevision = 3
): SettingsPolicySource {
	const source = createSettingsPolicySource({
		identity: { read: () => ({ status: 'ok', record: {}, fileExists: true }) as never },
		policy: () => ({ appliedRevision: policyRevision }),
	});
	expect(source.install({ policyRevision, locks })).toMatchObject({ installed: true });
	setSettingsWriteAuthority(source);
	return source;
}
