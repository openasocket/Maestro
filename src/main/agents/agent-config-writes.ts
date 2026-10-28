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
