/**
 * useAgentModelEffortOptions
 *
 * The one place that answers "what models and effort levels can this agent be
 * set to, and what does it fall back to when a tab overrides nothing?".
 *
 * Both the composer's model/effort pills and the keyboard-only Model & Effort
 * modal need the same three answers, and getting them wrong in one surface but
 * not the other would show two different truths for the same tab. The fetch
 * lives here so there is a single request shape, a single stale-guard, and a
 * single fallback story.
 *
 * Effort options use the selected discovery context when supplied: agents expose the list
 * under either `effort` (Claude Code) or `reasoningEffort` (Codex, Copilot-CLI,
 * Factory Droid, Grok), so both keys are probed and whichever the agent defines
 * wins. That keeps this correct as agents are added without touching callers.
 */

import { useEffect, useState } from 'react';
import type { AgentDiscoveryRequest, AgentDiscoveryResult } from '../../../shared/types';
import { readEffortFromConfig } from '../../utils/agentEffort';
import { useDebouncedValue } from '../utils/useThrottle';

export interface AgentModelEffortOptions {
	/** Model ids the agent offers. Empty when the agent has no model selection. */
	models: string[];
	/** Effort levels the agent offers. Empty when the agent has no effort knob. */
	efforts: string[];
	/** Agent-level default model, used when neither tab nor session overrides it. */
	defaultModel: string;
	/** Agent-level default effort, used when neither tab nor session overrides it. */
	defaultEffort: string;
	/**
	 * False until every lookup for this agent has settled. Empty lists mean
	 * "still loading" and "this agent has neither knob" alike, so any surface
	 * that renders an empty state has to wait for this before claiming there is
	 * nothing to show.
	 */
	loaded: boolean;
	modelStatus: AgentDiscoveryResult['status'];
	effortStatus: AgentDiscoveryResult['status'];
}

/**
 * Fetch available models, effort levels, and agent-level defaults for an agent.
 *
 * Uses a stale flag so switching agents can't let a slow response (e.g. the
 * `opencode models` subprocess) from the previous agent overwrite the current
 * agent's list.
 *
 * @param agentId - The agent's tool type, or undefined when no agent is active.
 */
export function useAgentModelEffortOptions(
	agentId?: string,
	/** Memoized selected context. Grok never discovers from a provider ID alone. */
	context?: AgentDiscoveryRequest['context']
): AgentModelEffortOptions {
	const scopedContext = agentId === 'grok' ? context : undefined;
	const discoveryContext = useDebouncedValue(scopedContext, 300);
	const [models, setModels] = useState<string[]>([]);
	const [efforts, setEfforts] = useState<string[]>([]);
	const [defaultModel, setDefaultModel] = useState('');
	const [defaultEffort, setDefaultEffort] = useState('');
	const [loaded, setLoaded] = useState(false);
	const [modelStatus, setModelStatus] = useState<AgentDiscoveryResult['status']>('unavailable');
	const [effortStatus, setEffortStatus] = useState<AgentDiscoveryResult['status']>('unavailable');
	const [resolvedFor, setResolvedFor] = useState<{
		agentId: string;
		context: typeof context;
	}>();

	useEffect(() => {
		let stale = false;
		setLoaded(false);
		setResolvedFor(undefined);
		setModels([]);
		setEfforts([]);
		setDefaultModel('');
		setDefaultEffort('');
		setModelStatus('unavailable');
		setEffortStatus('unavailable');
		if (!agentId || (agentId === 'grok' && discoveryContext !== scopedContext)) return;

		const modelsDone = (
			agentId === 'grok'
				? discoveryContext
					? window.maestro.agents.getModels({ providerId: agentId, context: discoveryContext })
					: Promise.resolve<AgentDiscoveryResult>({ status: 'unavailable', options: [] })
				: window.maestro.agents.getModels(agentId).then((options) => ({
						status: options.length ? ('discovered' as const) : ('unavailable' as const),
						options,
					}))
		)
			.then((fetched) => {
				if (stale) return;
				setModels(fetched.options);
				setModelStatus(fetched.status);
			})
			.catch(() => {
				if (!stale) setModels([]);
			});

		const effortsDone = Promise.all(
			['effort', 'reasoningEffort'].map((key) =>
				(agentId === 'grok'
					? discoveryContext
						? window.maestro.agents.getConfigOptions(
								{ providerId: agentId, context: discoveryContext },
								key
							)
						: Promise.resolve<AgentDiscoveryResult>({ status: 'unavailable', options: [] })
					: window.maestro.agents.getConfigOptions(agentId, key).then((options) => ({
							status: options.length ? ('discovered' as const) : ('unavailable' as const),
							options,
						}))
				).catch((): AgentDiscoveryResult => ({ status: 'unavailable', options: [] }))
			)
		)
			.then(([effortOpts, reasoningOpts]) => {
				if (stale) return;
				const selected =
					effortOpts.status === 'discovered' && effortOpts.options.length > 0
						? effortOpts
						: reasoningOpts.status === 'discovered' || effortOpts.options.length === 0
							? reasoningOpts
							: effortOpts;
				setEfforts(selected.options);
				setEffortStatus(selected.status);
			})
			.catch(() => {
				if (!stale) setEfforts([]);
			});

		const defaultsDone = window.maestro.agents
			.getConfig(agentId)
			.then((config) => {
				if (stale) return;
				setDefaultModel(config?.model || '');
				setDefaultEffort(readEffortFromConfig(config) ?? '');
			})
			.catch(() => {
				if (stale) return;
				setDefaultModel('');
				setDefaultEffort('');
			});

		Promise.all([modelsDone, effortsDone, defaultsDone]).then(() => {
			if (stale) return;
			setResolvedFor({ agentId, context: discoveryContext });
			setLoaded(true);
		});

		return () => {
			stale = true;
		};
	}, [agentId, discoveryContext, scopedContext]);

	// Hide the previous account's lists on the render that changes context,
	// before the effect has a chance to clear them or a consumer validates a pick.
	const current = resolvedFor?.agentId === agentId && resolvedFor?.context === scopedContext;
	return {
		models: current ? models : [],
		efforts: current ? efforts : [],
		defaultModel: current ? defaultModel : '',
		defaultEffort: current ? defaultEffort : '',
		loaded: current && loaded,
		modelStatus: current ? modelStatus : 'unavailable',
		effortStatus: current ? effortStatus : 'unavailable',
	};
}

/**
 * Resolve the model and effort a tab is actually running with.
 *
 * Precedence is tab override > session override > agent default > empty. Every
 * surface that displays or edits these values has to apply the same ladder, so
 * it lives next to the fetch that supplies the last rung.
 */
export function resolveModelEffort(
	tab: { customModel?: string; customEffort?: string } | null | undefined,
	session: { customModel?: string; customEffort?: string } | null | undefined,
	defaults: { defaultModel: string; defaultEffort: string }
): { model: string; effort: string } {
	return {
		model: tab?.customModel || session?.customModel || defaults.defaultModel,
		effort: tab?.customEffort || session?.customEffort || defaults.defaultEffort,
	};
}
