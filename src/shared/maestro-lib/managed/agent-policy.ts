/** Host-resolved affordances only. Every commit and run must revalidate independently. */
import type {
	DesktopAuthoringOperation,
	DesktopAuthoringView,
	DesktopChoice,
	DesktopChoiceKind,
} from './desktop-contract';

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

/** The governed agent fields a host mutation revalidates. Tool and automation have no record mapping. */
export const GOVERNED_AGENT_KINDS = [
	'provider',
	'model',
	'account',
	'workspace',
	'credential',
	'permission',
	'transport',
] as const;
export type GovernedAgentKind = (typeof GOVERNED_AGENT_KINDS)[number];

/**
 * Host-only resolution of an approved opaque reference to the value an agent
 * record carries (provider id, model name, working directory, account ref,
 * credential ref id, permission mode, transport ref). DESKTOP-LOCAL/1: no
 * published operation delivers it; absent, a managed mutation is unavailable.
 */
export interface ManagedAgentRefResolver {
	readonly version: 1;
	resolve(kind: GovernedAgentKind, ref: string): string | null;
}

/** What the record will hold after the mutation, in host vocabulary. Absent = not set. */
export type ManagedAgentValues = { [K in GovernedAgentKind]?: readonly string[] };

export interface ManagedAgentMutation {
	operation: DesktopAuthoringOperation;
	/** The revision the form was built from; null for a write that carries none. */
	expectedPolicyRevision: number | null;
	values: ManagedAgentValues;
	/** Edit only: the kinds whose value changes. Absent = every kind is checked. */
	changed?: ReadonlySet<GovernedAgentKind>;
}

export interface ManagedAgentFieldRefusal {
	field: GovernedAgentKind;
	reason: string;
}

export type ManagedAgentMutationVerdict =
	| { allowed: true; policyRevision: number }
	| {
			allowed: false;
			code: 'unavailable' | 'stale' | 'operation' | 'field';
			reason: string;
			policyRevision: number | null;
			fields: ManagedAgentFieldRefusal[];
	  };

const FIELD_LABELS: Record<GovernedAgentKind, string> = {
	provider: 'provider',
	model: 'model',
	account: 'account',
	workspace: 'working directory',
	credential: 'credential',
	permission: 'permission mode',
	transport: 'transport',
};

/** The parent a dependent choice must name, and which kind that parent is. */
function parentOf(choice: ManagedAgentOptionField['choices'][number]): {
	kind: GovernedAgentKind;
	ref: string;
} | null {
	if ('providerRef' in choice) return { kind: 'provider', ref: choice.providerRef };
	if ('accountRef' in choice) return { kind: 'account', ref: choice.accountRef };
	return null;
}

/**
 * Validate a create/edit against the host's CURRENT approved options, by value.
 * Pure: the caller re-reads options from live authority immediately before its
 * commit. Each requested value must resolve from an approved reference whose
 * parent (provider for model/account/permission/transport, account for a
 * credential) is itself among the matched approved references. A field the
 * policy does not let the person change is accepted only at an approved value.
 * Every refusal names its field so a form can keep the draft and point at it.
 */
export function checkManagedAgentMutation(
	options: ManagedAgentOptions,
	resolver: ManagedAgentRefResolver | null,
	mutation: ManagedAgentMutation
): ManagedAgentMutationVerdict {
	const refuse = (
		code: 'unavailable' | 'stale' | 'operation' | 'field',
		reason: string,
		fields: ManagedAgentFieldRefusal[] = []
	): ManagedAgentMutationVerdict => ({
		allowed: false,
		code,
		reason,
		policyRevision: options.policyRevision,
		fields,
	});
	if (options.outcome !== 'available') return refuse('unavailable', options.reason);
	if (options.policyRevision === null)
		return refuse('unavailable', 'No applied policy revision is available.');
	if (!resolver || resolver.version !== 1)
		return refuse('unavailable', 'Approved choices have no host resolution.');
	if (
		mutation.expectedPolicyRevision !== null &&
		mutation.expectedPolicyRevision !== options.policyRevision
	)
		return refuse('stale', 'The policy changed. Refresh to load the current approved choices.');
	if (!options.operations.includes(mutation.operation))
		return refuse('operation', `Policy does not allow this ${mutation.operation} operation.`);

	const matched = new Map<GovernedAgentKind, Set<string>>();
	const refusals: ManagedAgentFieldRefusal[] = [];
	const resolve = (kind: GovernedAgentKind, ref: string): string | null => {
		try {
			return resolver.resolve(kind, ref);
		} catch {
			return null;
		}
	};
	// Parents before dependents: the order of GOVERNED_AGENT_KINDS guarantees it.
	for (const kind of GOVERNED_AGENT_KINDS) {
		const field = options.fields[kind];
		const requested = mutation.values[kind] ?? [];
		const refs = new Set<string>();
		matched.set(kind, refs);
		const label = FIELD_LABELS[kind];
		const report = !mutation.changed || mutation.changed.has(kind);
		const problems: string[] = [];
		if (new Set(requested).size !== requested.length) problems.push(`Choose each ${label} once.`);
		for (const value of requested) {
			const hit = field.choices.find((choice) => {
				const parent = parentOf(choice);
				if (parent && !matched.get(parent.kind)?.has(parent.ref)) return false;
				return resolve(kind, choice.ref) === value;
			});
			if (hit) refs.add(hit.ref);
			else
				problems.push(
					field.choices.length === 0 && field.lockedReason
						? field.lockedReason
						: `This ${label} is not an approved choice${
								kind === 'provider' || kind === 'workspace' ? '' : ' for the selected parent'
							}.`
				);
		}
		if (requested.length > field.maximum)
			problems.push(`Choose at most ${field.maximum} ${label}${field.maximum === 1 ? '' : 's'}.`);
		if (requested.length < field.minimum)
			problems.push(field.lockedReason ?? `Choose an approved ${label}.`);
		if (report && problems.length) refusals.push({ field: kind, reason: problems[0] });
	}
	if (refusals.length)
		return refuse(
			'field',
			refusals.length === 1 ? refusals[0].reason : 'Some choices are not approved by policy.',
			refusals
		);
	return { allowed: true, policyRevision: options.policyRevision };
}
