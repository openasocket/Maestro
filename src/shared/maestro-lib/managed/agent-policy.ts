/** Host-resolved affordances only. Every commit and run must revalidate independently. */
import type { DesktopAuthoringView, DesktopChoice, DesktopChoiceKind } from './desktop-contract';

/** DESKTOP-LOCAL/1 host-only extension, covered by the complete batch signature.
 * Transport references resolve in host custody; they are never URLs or argv.
 */
export interface ManagedExecutionChoices {
	providerRef: string;
	permissions: ('readonly' | 'standard' | 'full')[];
	transports: string[];
}

export type ManagedAgentOptionKind = DesktopChoiceKind | 'permission' | 'transport';
export interface ManagedAgentOptionField {
	choices: readonly (
		| DesktopChoice
		| { kind: 'permission' | 'transport'; ref: string; providerRef: string }
	)[];
	editable: boolean;
	minimum: number;
	maximum: number;
	lockedReason: string | null;
}
export type ManagedAgentOptions = {
	authority: 'none';
	policyRevision: number | null;
	freshness: 'fresh' | 'stale' | 'unknown';
} & (
	| { outcome: 'unavailable'; reason: string }
	| {
			outcome: 'available';
			expiresAt: string;
			operations: readonly string[];
			fields: Record<ManagedAgentOptionKind, ManagedAgentOptionField>;
	  }
);

/** Reuse the public desktop mapper; export only approved references and bounds.
 * No identity, paths, route URLs, credentials or settings pin values leave here.
 */
export function projectManagedAgentOptions(
	view: Extract<DesktopAuthoringView, { outcome: 'available' }>,
	execution: readonly ManagedExecutionChoices[] | undefined,
	expiresAt: string
): ManagedAgentOptions {
	const fields = {} as Record<ManagedAgentOptionKind, ManagedAgentOptionField>;
	const providers = new Set(view.fields.provider.choices.map((choice) => choice.ref));
	const accounts = new Set(
		view.fields.account.choices
			.filter((choice) => 'providerRef' in choice && providers.has(choice.providerRef))
			.map((choice) => choice.ref)
	);
	for (const kind of Object.keys(view.fields) as DesktopChoiceKind[]) {
		const field = view.fields[kind];
		const choices = field.choices.filter((choice) =>
			'providerRef' in choice
				? providers.has(choice.providerRef)
				: 'accountRef' in choice
					? accounts.has(choice.accountRef)
					: true
		);
		const reason =
			field.localLock?.message ??
			(field.policy.state === 'locked'
				? 'This choice is fixed by policy.'
				: field.host.kind === 'unavailable'
					? 'This choice has no host mapping.'
					: choices.length < field.minimum || choices.length === 0 || field.maximum === 0
						? 'No approved choices are available.'
						: null);
		fields[kind] = {
			choices: structuredClone(choices),
			editable: field.editable && !reason,
			minimum: field.minimum,
			maximum: field.maximum,
			lockedReason: reason,
		};
	}
	for (const kind of ['permission', 'transport'] as const) {
		const choices = (execution ?? [])
			.filter((entry) => providers.has(entry.providerRef))
			.flatMap((entry) =>
				(kind === 'permission' ? entry.permissions : entry.transports).map((ref) => ({
					kind,
					ref,
					providerRef: entry.providerRef,
				}))
			);
		fields[kind] = {
			choices,
			editable: choices.length > 0,
			minimum: 0,
			maximum: 1,
			lockedReason: !execution
				? 'No verified execution choices are available.'
				: choices.length
					? null
					: 'No approved choices are available.',
		};
	}
	return {
		outcome: 'available',
		authority: 'none',
		policyRevision: view.projection.binding.policyRevision,
		freshness: 'fresh',
		expiresAt,
		operations: [...view.projection.operations],
		fields,
	};
}
