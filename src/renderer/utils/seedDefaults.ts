/**
 * Seed Defaults Utility
 *
 * Helpers for checking whether a role or persona matches a SEED_ROLES entry
 * and for retrieving the original default values for reset operations.
 */

import { SEED_ROLES } from '../../shared/memory-types';

/** Find a seed role by name (case-insensitive). */
export function getSeedRole(name: string) {
	return SEED_ROLES.find((sr) => sr.name.toLowerCase() === name.toLowerCase()) ?? null;
}

/** Check if a role name matches any seed default. */
export function isSeedRole(name: string): boolean {
	return !!getSeedRole(name);
}

/** Find a seed persona by role name + persona name (case-insensitive). */
export function getSeedPersona(roleName: string, personaName: string) {
	const seedRole = getSeedRole(roleName);
	if (!seedRole) return null;
	return (
		seedRole.personas.find((sp) => sp.name.toLowerCase() === personaName.toLowerCase()) ?? null
	);
}

/** Check if a persona name matches any seed default within its parent role. */
export function isSeedPersona(roleName: string, personaName: string): boolean {
	return !!getSeedPersona(roleName, personaName);
}
