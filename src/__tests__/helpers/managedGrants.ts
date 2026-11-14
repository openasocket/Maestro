/**
 * Grant fixtures for managed delegation tests. A grant is named by its id and
 * the SHA-256 digest of its record, as the contract names it. The digest here
 * is a test value derived from the id, not a real grant record.
 */
import { createHash } from 'node:crypto';
import type { ManagedDelegationRef, ManagedGrantRef } from '../../shared/maestro-lib/managed/types';

export const grantDigest = (grantId: string): string =>
	createHash('sha256').update(`grant:${grantId}`).digest('hex');

export const grantRefFixture = (grantId: string): ManagedGrantRef => ({
	grantId,
	digest: grantDigest(grantId),
});

/** A one-hop grant reference: the presented grant is the chain's only, and last, entry. */
export const delegationOfGrant = (
	grantId: string
): NonNullable<ManagedDelegationRef['delegation']> => ({
	grant: grantRefFixture(grantId),
	chain: [grantRefFixture(grantId)],
});
