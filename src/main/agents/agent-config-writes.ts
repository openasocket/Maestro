/**
 * One write of a per-provider configuration value (`maestro-agent-configs.json`),
 * shared by the `agents:setConfigValue` IPC handler and the bridge's
 * `set_agent_config_value` / `reset_agent_config_value`, which `maestro-cli
 * settings agent set|reset` sends (MRC2-06-03A). The field is held to the
 * managed settings authority ONCE, here, before anything is written; a refusal
 * is a typed outcome the IPC path throws by name and the bridge answers as it
 * is. Standalone: every write admitted, the store as before.
 */

import type { getAgentConfigsStore } from '../stores';
import { agentConfigLockKey } from '../../shared/managedSettingsLock';
import {
	ManagedSettingLockedError,
	holdAgentConfigWrite,
	type AgentConfigWriteDenial,
} from '../enterprise/settings-policy';
import {
	checkManagedAgentMutation,
	GOVERNED_AGENT_KINDS,
	type GovernedAgentKind,
	type ManagedAgentFieldRefusal,
	type ManagedAgentOptions,
	type ManagedAgentRefResolver,
	type ManagedAgentValues,
} from '../../shared/maestro-lib/managed/agent-policy';
import type { DesktopAuthoringOperation } from '../../shared/maestro-lib/managed/desktop-contract';
import type {
	AgentMutationAuthorization,
	AgentMutationChange,
} from '../../shared/maestro-lib/agents/repository';
import type { AgentRecord } from '../../shared/maestro-lib/store/records';

/** The store the desktop holds, or any double with its `configs` get and set. */
export type AgentConfigsStore = Pick<ReturnType<typeof getAgentConfigsStore>, 'get' | 'set'>;

export type AgentConfigWriteRequest =
	| { op: 'set'; providerId: string; key: string; value: unknown }
	| { op: 'reset'; providerId: string; key: string };

export type AgentConfigWriteOutcome =
	/** `previous` is what the key held; `removed` (reset only) is false when it held nothing. */
	| { success: true; previous: unknown; removed?: boolean }
	| {
			success: false;
			error: string;
			managed: {
				state: 'denied' | 'unavailable';
				code: AgentConfigWriteDenial;
				policyRevision: number | null;
			};
	  };

/** Apply one write, held first. A reset of a missing key writes nothing; an emptied provider is dropped. */
export function applyAgentConfigWrite(
	store: AgentConfigsStore,
	request: AgentConfigWriteRequest
): AgentConfigWriteOutcome {
	const { providerId, key } = request;
	const hold = holdAgentConfigWrite(
		providerId,
		key,
		request.op === 'set' ? request.value : undefined
	);
	if (!hold.allowed) {
		return {
			success: false,
			error: hold.message,
			managed: {
				state: hold.code === 'unavailable' ? 'unavailable' : 'denied',
				code: hold.code,
				policyRevision: hold.policyRevision,
			},
		};
	}
	const configs = store.get('configs', {});
	const config = configs[providerId] ?? {};
	const previous = config[key];
	if (request.op === 'set') {
		config[key] = request.value;
		configs[providerId] = config;
		store.set('configs', configs);
		return { success: true, previous };
	}
	if (!(key in config)) return { success: true, previous: undefined, removed: false };
	delete config[key];
	if (Object.keys(config).length === 0) delete configs[providerId];
	store.set('configs', configs);
	return { success: true, previous, removed: true };
}

/** The IPC spelling: a refusal thrown by name, so the renderer receives the reason. */
export function applyAgentConfigWriteStrict(
	store: AgentConfigsStore,
	request: AgentConfigWriteRequest
): Extract<AgentConfigWriteOutcome, { success: true }> {
	const outcome = applyAgentConfigWrite(store, request);
	if (outcome.success) return outcome;
	throw new ManagedSettingLockedError(
		agentConfigLockKey(request.key) ?? request.key,
		outcome.managed.code,
		outcome.error
	);
}

// ---------------------------------------------------------------------------
// Governed agent create and edit (MCOMP-23-01)
// ---------------------------------------------------------------------------

/**
 * What the one host create/edit command reads, each per call so a revoked
 * standing, a changed revision or an expired projection is seen at the commit.
 * The host composes these from its installation standing and policy service.
 */
export interface ManagedAgentAuthorityDeps {
	/** False on a standalone installation: nothing is held, the record commits as before. */
	isManaged(): boolean;
	/** The approved options from live authority (`PolicyStatusService.agentOptions`). */
	options(): ManagedAgentOptions;
	/** Host-only reference resolution; null until DESKTOP-LOCAL/1 delivers one. */
	resolver: ManagedAgentRefResolver | null;
	/** The opaque account reference a record runs as (`resolveAgentAccountRef` with host layers). */
	accountRefOf?(record: AgentRecord): string | null;
}

/** One create, edit, clone or import, as the record will be committed. */
export interface ManagedAgentCommand {
	operation: DesktopAuthoringOperation;
	/** The revision the form was built from; null when the caller carries none. */
	expectedPolicyRevision: number | null;
	before: AgentRecord | null;
	after: AgentRecord;
	/** Selections the record does not carry: credential references, permission mode, transport. */
	execution?: { credentials?: readonly string[]; permission?: string; transport?: string };
}

export type ManagedAgentCommandOutcome =
	| { allowed: true; managed: false }
	/** `policyRevision` is null only for an edit that touches no governed field. */
	| { allowed: true; managed: true; policyRevision: number | null }
	| {
			allowed: false;
			code: 'unavailable' | 'stale' | 'operation' | 'field';
			reason: string;
			policyRevision: number | null;
			fields: ManagedAgentFieldRefusal[];
	  };

const one = (value: unknown): string[] =>
	typeof value === 'string' && value.trim() ? [value] : [];

/** The governed values an agent record holds, in host vocabulary. Never reads a secret. */
export function governedAgentValues(
	record: AgentRecord,
	accountRefOf?: (record: AgentRecord) => string | null
): ManagedAgentValues {
	let account: string | null = null;
	try {
		account = accountRefOf?.(record) ?? null;
	} catch {
		account = null;
	}
	return {
		provider: one(record.toolType),
		model: one(record.customModel),
		workspace: one(record.cwd),
		account: one(account),
	};
}

const sameValues = (a: readonly string[] = [], b: readonly string[] = []) =>
	a.length === b.length && a.every((value, index) => value === b[index]);

/**
 * The one authenticated desktop create/edit check, run immediately before the
 * record commits. Standalone admits as before; a managed standing validates the
 * whole governed set on create/clone/import and the changed fields (with their
 * parents) on edit, against options read now. No blanket managed refusal: an
 * approved choice commits. Any failure to read authority is unavailable.
 */
export function authorizeManagedAgentCommand(
	deps: ManagedAgentAuthorityDeps,
	command: ManagedAgentCommand
): ManagedAgentCommandOutcome {
	const unavailable = (reason: string): ManagedAgentCommandOutcome => ({
		allowed: false,
		code: 'unavailable',
		reason,
		policyRevision: null,
		fields: [],
	});
	let managed: boolean;
	try {
		managed = deps.isManaged();
	} catch {
		return unavailable('The installation standing could not be read.');
	}
	if (!managed) return { allowed: true, managed: false };
	let options: ManagedAgentOptions;
	try {
		options = deps.options();
	} catch {
		return unavailable('The approved agent choices could not be read.');
	}
	const execution: ManagedAgentValues = {
		...(command.execution?.credentials ? { credential: [...command.execution.credentials] } : {}),
		...(command.execution?.permission !== undefined
			? { permission: one(command.execution.permission) }
			: {}),
		...(command.execution?.transport !== undefined
			? { transport: one(command.execution.transport) }
			: {}),
	};
	const values = { ...governedAgentValues(command.after, deps.accountRefOf), ...execution };
	let changed: Set<GovernedAgentKind> | undefined;
	if (command.operation === 'edit') {
		if (!command.before) return unavailable('The stored agent record is missing.');
		const previous = governedAgentValues(command.before, deps.accountRefOf);
		changed = new Set(
			GOVERNED_AGENT_KINDS.filter(
				(kind) => kind in execution || !sameValues(previous[kind], values[kind])
			)
		);
		// An edit that touches no governed field is not a policy decision.
		if (changed.size === 0)
			return { allowed: true, managed: true, policyRevision: options.policyRevision };
	}
	const verdict = checkManagedAgentMutation(options, deps.resolver, {
		operation: command.operation,
		expectedPolicyRevision: command.expectedPolicyRevision,
		values,
		...(changed ? { changed } : {}),
	});
	return verdict.allowed
		? { allowed: true, managed: true, policyRevision: verdict.policyRevision }
		: verdict;
}

/**
 * The repository's `authorizeAgentMutation` composed over the same command, so a
 * headless or bridge write meets the rule the desktop form meets. A refusal is
 * `rejected` carrying the field reason; it never commits.
 */
export function managedAgentRepositoryAuthority(
	deps: ManagedAgentAuthorityDeps
): (change: AgentMutationChange) => AgentMutationAuthorization {
	return (change) => {
		const outcome = authorizeManagedAgentCommand(deps, {
			operation: change.operation,
			expectedPolicyRevision: null,
			before: change.before,
			after: change.after,
		});
		return outcome.allowed
			? { ok: true }
			: { ok: false, code: 'rejected', message: outcome.reason };
	};
}
