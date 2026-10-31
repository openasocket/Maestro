/**
 * Usage totalling - maestro-lib Part Two.
 *
 * Summing a turn's usage events into one total, shared by the CLI spawner and
 * Cue's process lifecycle. Pairs with `UsageAccumulator`, which normalizes a
 * cumulative reporter's events to deltas BEFORE they are summed here.
 *
 * Token counts and cost are totals, but the context-window fields and the
 * `absoluteUsage` occupancy snapshot are METADATA about the latest state of the
 * conversation, so they are carried forward rather than summed: a later event
 * that omits them must not erase the last snapshot a provider reported.
 */

import type { ParsedEvent } from '../parsers/agent-output-parser';
import { canonicalJson } from '../../canonicalJson';
import type { UsageAccounting, UsageBreakdown, UsageCost, UsageStats } from '../../types';

/** The non-summing half of a `UsageStats`: the window and occupancy snapshot. */
type UsageMetadata = Pick<
	UsageStats,
	'contextWindow' | 'contextWindowResolved' | 'contextWindowModel' | 'absoluteUsage'
>;

/** Convert a parser's usage event into the shared `UsageStats` shape. */
export function parsedUsageToStats(usage: NonNullable<ParsedEvent['usage']>): UsageStats {
	const accounting: UsageAccounting = structuredClone(
		usage.accounting ?? {
			source: 'runtime-stream',
			scope: 'response',
			reporting: 'delta',
			cacheReadCounting: 'unknown',
			cacheCreationCounting: 'unknown',
			completeness: 'unknown',
			childInclusion: 'unknown',
			childCompleteness: 'unknown',
			cost: Number.isFinite(usage.costUsd)
				? { status: 'partial', costUsd: usage.costUsd! }
				: { status: 'unknown' },
		}
	);
	const tokenCount = (value: number | undefined) =>
		Number.isFinite(value) && value! >= 0 ? value! : 0;
	const invalidTokens = [
		usage.inputTokens,
		usage.outputTokens,
		usage.cacheReadTokens,
		usage.cacheCreationTokens,
		usage.reasoningTokens,
	].some((value) => value !== undefined && (!Number.isFinite(value) || value < 0));
	let inputTokens = tokenCount(usage.inputTokens);
	if (accounting.cacheReadCounting === 'inside-input')
		inputTokens -= tokenCount(usage.cacheReadTokens);
	if (accounting.cacheCreationCounting === 'inside-input')
		inputTokens -= tokenCount(usage.cacheCreationTokens);
	if (inputTokens < 0 || invalidTokens) {
		accounting.completeness = 'partial';
		accounting.cost = { status: 'unknown', reason: 'Inconsistent cache buckets' };
	}
	if (accounting.cacheReadCounting === 'inside-input')
		accounting.cacheReadCounting = 'beside-input';
	if (accounting.cacheCreationCounting === 'inside-input')
		accounting.cacheCreationCounting = 'beside-input';
	if (usage.model && accounting.scope === 'response' && !accounting.models) {
		accounting.models = [
			{
				model: usage.model,
				inputTokens: Math.max(0, inputTokens),
				outputTokens: tokenCount(usage.outputTokens),
				cacheReadInputTokens: tokenCount(usage.cacheReadTokens),
				cacheCreationInputTokens: tokenCount(usage.cacheCreationTokens),
				reasoningTokens: tokenCount(usage.reasoningTokens),
				completeness: accounting.completeness,
				cost: structuredClone(accounting.cost),
			},
		];
	}
	return {
		accounting,
		inputTokens: Math.max(0, inputTokens),
		outputTokens: tokenCount(usage.outputTokens),
		cacheReadInputTokens: tokenCount(usage.cacheReadTokens),
		cacheCreationInputTokens: tokenCount(usage.cacheCreationTokens),
		totalCostUsd: usageCostUsd(accounting.cost) ?? 0,
		contextWindow: usage.contextWindow || 0,
		reasoningTokens: tokenCount(usage.reasoningTokens),
		// Same rule as StdoutHandler.buildUsageStats: parsers seed `contextWindow`
		// with fallbacks, so only the provider-reported flag makes it authoritative.
		...(usage.contextWindowReported && (usage.contextWindow || 0) > 0
			? { contextWindowResolved: true }
			: {}),
		...(usage.model ? { contextWindowModel: usage.model } : {}),
		...(usage.absoluteUsage ? { absoluteUsage: { ...usage.absoluteUsage } } : {}),
	};
}

/**
 * Combine the metadata of a running total with a newer step's.
 *
 * The context window is a property of the model, so the largest value wins, as
 * it always has. Its resolved flag and model describe THAT window, so they travel
 * with whichever side supplied it rather than being mixed: a resolved 128k window
 * followed by a larger unresolved fallback must not come out as a "resolved"
 * fallback. On a tie, and for the occupancy snapshot, the latest value a
 * provider actually reported wins, so an event without one keeps the last.
 */
function carryUsageMetadata(
	current: UsageMetadata | undefined,
	next: UsageMetadata
): UsageMetadata {
	const currentWindow = current?.contextWindow || 0;
	const nextWindow = next.contextWindow || 0;

	let contextWindowResolved: boolean | undefined;
	let contextWindowModel: string | undefined;
	if (currentWindow > nextWindow) {
		contextWindowResolved = current?.contextWindowResolved;
		contextWindowModel = current?.contextWindowModel;
	} else if (nextWindow > currentWindow) {
		contextWindowResolved = next.contextWindowResolved;
		contextWindowModel = next.contextWindowModel;
	} else {
		contextWindowResolved = next.contextWindowResolved ?? current?.contextWindowResolved;
		contextWindowModel = next.contextWindowModel ?? current?.contextWindowModel;
	}
	const absoluteUsage = next.absoluteUsage ?? current?.absoluteUsage;

	return {
		contextWindow: Math.max(currentWindow, nextWindow),
		...(contextWindowResolved !== undefined ? { contextWindowResolved } : {}),
		...(contextWindowModel !== undefined ? { contextWindowModel } : {}),
		...(absoluteUsage ? { absoluteUsage: { ...absoluteUsage } } : {}),
	};
}

/**
 * Add one usage step to a running total. Token counts and cost sum; the context
 * window and occupancy metadata carry forward (see `carryUsageMetadata`).
 */
export function mergeUsageStats(
	current: UsageStats | undefined,
	next: {
		inputTokens: number;
		outputTokens: number;
		cacheReadTokens?: number;
		cacheCreationTokens?: number;
		costUsd?: number;
		contextWindow?: number;
		reasoningTokens?: number;
		contextWindowResolved?: boolean;
		contextWindowModel?: string;
		absoluteUsage?: UsageStats['absoluteUsage'];
		accounting?: UsageAccounting;
	}
): UsageStats {
	const accounting = mergeUsageAccounting(current?.accounting, next.accounting, !!current);
	const merged: UsageStats = {
		...(accounting ? { accounting } : {}),
		inputTokens: (current?.inputTokens || 0) + (next.inputTokens || 0),
		outputTokens: (current?.outputTokens || 0) + (next.outputTokens || 0),
		cacheReadInputTokens: (current?.cacheReadInputTokens || 0) + (next.cacheReadTokens || 0),
		cacheCreationInputTokens:
			(current?.cacheCreationInputTokens || 0) + (next.cacheCreationTokens || 0),
		totalCostUsd: (current?.totalCostUsd || 0) + (next.costUsd || 0),
		reasoningTokens: (current?.reasoningTokens || 0) + (next.reasoningTokens || 0),
		...carryUsageMetadata(current, {
			contextWindow: next.contextWindow || 0,
			contextWindowResolved: next.contextWindowResolved,
			contextWindowModel: next.contextWindowModel,
			absoluteUsage: next.absoluteUsage,
		}),
	};

	if (accounting && next.accounting && (!current || current.accounting))
		merged.totalCostUsd = usageCostUsd(accounting.cost) ?? 0;

	if (!next.reasoningTokens && !current?.reasoningTokens) {
		delete merged.reasoningTokens;
	}

	return merged;
}

/** Sum a `UsageStats` step into a running total. */
export function addUsageStats(current: UsageStats | undefined, step: UsageStats): UsageStats {
	return mergeUsageStats(current, {
		inputTokens: step.inputTokens,
		outputTokens: step.outputTokens,
		cacheReadTokens: step.cacheReadInputTokens,
		cacheCreationTokens: step.cacheCreationInputTokens,
		costUsd: step.totalCostUsd,
		contextWindow: step.contextWindow,
		reasoningTokens: step.reasoningTokens,
		contextWindowResolved: step.contextWindowResolved,
		contextWindowModel: step.contextWindowModel,
		absoluteUsage: step.absoluteUsage,
		accounting: step.accounting,
	});
}

/**
 * Take a later usage report as the whole total, for a provider whose last event
 * already carries the turn's totals (Claude Code's `result`). Token counts and
 * cost come from `next` alone; the metadata carries forward exactly as in
 * `mergeUsageStats`, so a trailing event without an occupancy snapshot does not
 * erase the one the turn's last call reported.
 */
export function replaceUsageStats(current: UsageStats | undefined, next: UsageStats): UsageStats {
	const {
		contextWindowResolved: _resolved,
		contextWindowModel: _model,
		absoluteUsage: _absolute,
		...totals
	} = next;
	const replaced = { ...totals, ...carryUsageMetadata(current, next) };
	if (next.accounting) {
		replaced.accounting = structuredClone(next.accounting);
		if (usageCostUsd(next.accounting.cost) === undefined && current?.accounting) {
			replaced.accounting.cost = mergeUsageCost(current.accounting.cost, next.accounting.cost);
			replaced.totalCostUsd = usageCostUsd(replaced.accounting.cost) ?? 0;
		}
		if (!next.accounting.models && current?.accounting?.models) {
			replaced.accounting.models = current.accounting.models.map((model) => ({
				...structuredClone(model),
				completeness: 'partial',
			}));
		}
		if (!next.accounting.children && current?.accounting?.children) {
			replaced.accounting.children = structuredClone(current.accounting.children);
		}
	}
	return replaced;
}

/** Numeric display projection only; exact decimal ticks stay on the accounting fact. */
export function usageCostUsd(cost: UsageCost): number | undefined {
	if (cost.status === 'unknown') return undefined;
	if ('costUsdTicks' in cost && cost.costUsdTicks !== undefined)
		return Number(cost.costUsdTicks) / 1e10;
	return cost.costUsd;
}

/** Convert an explicit USD decimal only when it is exactly representable in ticks. */
function costTicks(cost: UsageCost): string | undefined {
	if ('costUsdTicks' in cost && cost.costUsdTicks !== undefined) return cost.costUsdTicks;
	if (
		cost.status === 'unknown' ||
		cost.costUsd === undefined ||
		!Number.isFinite(cost.costUsd) ||
		cost.costUsd < 0
	)
		return undefined;
	const [coefficient, exponent = '0'] = String(cost.costUsd).split('e');
	const [whole, fraction = ''] = coefficient.split('.');
	const scale = 10 + Number(exponent) - fraction.length;
	const digits = BigInt(whole + fraction);
	if (scale >= 0) return (digits * 10n ** BigInt(scale)).toString();
	const divisor = 10n ** BigInt(-scale);
	return digits % divisor === 0n ? (digits / divisor).toString() : undefined;
}

/** Combine independent costs. Missing evidence cannot make a complete/free total. */
export function mergeUsageCost(left: UsageCost, right: UsageCost): UsageCost {
	const a = usageCostUsd(left),
		b = usageCostUsd(right);
	const hasTicks = 'costUsdTicks' in left || 'costUsdTicks' in right;
	const ticksA = hasTicks ? costTicks(left) : undefined;
	const ticksB = hasTicks ? costTicks(right) : undefined;
	const costUsdTicks =
		ticksA !== undefined && ticksB !== undefined
			? (BigInt(ticksA) + BigInt(ticksB)).toString()
			: undefined;
	if (left.status === 'estimated' || right.status === 'estimated') {
		if (
			left.status === 'estimated' &&
			right.status === 'estimated' &&
			left.model === right.model &&
			left.pricingRevision === right.pricingRevision
		) {
			return {
				...right,
				costUsd: left.costUsd + right.costUsd,
				completeness:
					left.completeness === 'complete' && right.completeness === 'complete'
						? 'complete'
						: 'partial',
			};
		}
		// Keep reported partial amounts separate from any estimate.
		const reported = left.status === 'estimated' ? right : left;
		return mergeUsageCost(reported.status === 'estimated' ? { status: 'unknown' } : reported, {
			status: 'unknown',
		});
	}
	if (a === undefined && b === undefined) {
		if (left.status === 'partial') return { ...left };
		if (right.status === 'partial') return { ...right };
		return { status: 'unknown' };
	}
	if (a !== undefined && b !== undefined && (ticksA === undefined) !== (ticksB === undefined)) {
		const ticks = (ticksA ?? ticksB)!;
		return {
			status: 'partial',
			costUsdTicks: ticks,
			costUsd: Number(ticks) / 1e10,
			reason: 'Only the tick-representable subtotal is retained',
		};
	}
	const amount = {
		costUsd: (a ?? 0) + (b ?? 0),
		...(costUsdTicks !== undefined
			? { costUsdTicks }
			: a === undefined && ticksB !== undefined
				? { costUsdTicks: ticksB }
				: b === undefined && ticksA !== undefined
					? { costUsdTicks: ticksA }
					: {}),
	};
	return {
		status: left.status === 'exact' && right.status === 'exact' ? 'exact' : 'partial',
		...amount,
	};
}

function mergeUsageAccounting(
	left: UsageAccounting | undefined,
	right: UsageAccounting | undefined,
	hasLeft: boolean
): UsageAccounting | undefined {
	if (!left && !right) return undefined;
	if (!hasLeft) return structuredClone(right);
	const result = structuredClone((right ?? left)!);
	result.cost = mergeUsageCost(
		left?.cost ?? { status: 'unknown' },
		right?.cost ?? { status: 'unknown' }
	);
	result.completeness =
		left?.completeness === 'complete' && right?.completeness === 'complete'
			? 'complete'
			: 'partial';
	result.childCompleteness =
		left?.childCompleteness === 'complete' && right?.childCompleteness === 'complete'
			? 'complete'
			: 'unknown';
	result.final = left?.final === true && right?.final === true;
	if (left?.source !== right?.source) result.source = 'runtime-stream';
	for (const key of [
		'scopeId',
		'route',
		'providerSessionId',
		'processGeneration',
		'turnId',
		'requestId',
		'responseId',
	] as const) {
		if (left?.[key] !== right?.[key]) delete result[key];
	}
	const leftEstimate =
		left?.estimatedCost ?? (left?.cost.status === 'estimated' ? left.cost : undefined);
	const rightEstimate =
		right?.estimatedCost ?? (right?.cost.status === 'estimated' ? right.cost : undefined);
	if (leftEstimate || rightEstimate) {
		const estimate =
			leftEstimate && rightEstimate
				? mergeUsageCost(leftEstimate, rightEstimate)
				: { ...(leftEstimate ?? rightEstimate)!, completeness: 'partial' as const };
		if (estimate.status === 'estimated') result.estimatedCost = estimate;
		else delete result.estimatedCost;
	}
	for (const key of ['cacheReadCounting', 'cacheCreationCounting', 'childInclusion'] as const) {
		if (left?.[key] !== right?.[key]) result[key] = 'unknown';
	}
	for (const key of ['callCount', 'mainAgentRounds'] as const) {
		if (left?.[key] !== undefined && right?.[key] !== undefined)
			result[key] = left[key]! + right[key]!;
		else delete result[key];
	}
	const models = new Map<string, UsageBreakdown & { model: string }>();
	for (const entry of [...(left?.models ?? []), ...(right?.models ?? [])]) {
		const previous = models.get(entry.model);
		const merged = structuredClone(entry);
		if (previous) {
			for (const key of [
				'inputTokens',
				'outputTokens',
				'cacheReadInputTokens',
				'cacheCreationInputTokens',
				'reasoningTokens',
				'callCount',
				'mainAgentRounds',
			] as const) {
				if (previous[key] !== undefined && entry[key] !== undefined)
					merged[key] = previous[key]! + entry[key]!;
				else delete merged[key];
			}
			merged.cost = mergeUsageCost(previous.cost, entry.cost);
			merged.completeness =
				previous.completeness === 'complete' && entry.completeness === 'complete'
					? 'complete'
					: 'partial';
		}
		models.set(entry.model, merged);
	}
	if (models.size) result.models = [...models.values()];
	// Stable child IDs describe snapshots, including running -> completed.
	// Anonymous children stay distinct. Neither is additional parent spend.
	if (left?.children || right?.children) {
		const children = new Map<string, NonNullable<UsageAccounting['children']>[number]>();
		for (const child of [...(left?.children ?? []), ...(right?.children ?? [])]) {
			const key =
				child.providerSessionId || child.parentToolUseId
					? canonicalJson([child.providerSessionId ?? null, child.parentToolUseId ?? null])
					: `anonymous:${children.size}`;
			children.set(key, structuredClone(child));
		}
		result.children = [...children.values()];
	}
	return result;
}
