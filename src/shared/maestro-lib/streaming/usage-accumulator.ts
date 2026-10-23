/**
 * Usage delta accumulation - maestro-lib Part Two.
 *
 * Ports `normalizeUsageToDelta` (`StdoutHandler.ts:39-132`) into a
 * standalone, instance-scoped primitive so every call site (not just
 * desktop) can delta-normalize cumulative usage reporting the same way.
 * Behavior is a faithful port, not a redesign: same monotonic-delta
 * detection, same cumulative-flag latching once a stream is found to be
 * non-cumulative, same conditional `absoluteUsage` re-attachment.
 *
 * Claude Code and Codex both report CUMULATIVE session totals rather than
 * per-turn values. Used directly, context occupancy would exceed 100% after
 * a few turns. This class detects cumulative reporting (values only ever
 * increase) and converts it to per-turn deltas; a provider whose values
 * don't increase monotonically is assumed to already report per-turn and is
 * passed through unmodified from then on.
 *
 * Scoping is deliberately left to the caller and NOT resolved by this
 * module: one instance per PROCESS reproduces today's desktop behavior
 * exactly (`managedProcess.lastUsageTotals`'s lifetime is the process's).
 * Re-scoping an instance to span a resume boundary (one process per turn,
 * one accumulator per session) is Open Question 5 in
 * `Plans/maestro-lib-turn-contract.md` and needs checking against every
 * provider's first-usage-event shape before it's safe - this class does not
 * make that decision.
 */

import { createHash } from 'node:crypto';
import { canonicalJson } from '../../canonicalJson';
import { calculateWithPricing, resolveModelPricing } from '../../modelPricing';
import type { UsageStats } from '../../types';

interface UsageTotals {
	inputTokens: number;
	outputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	reasoningTokens: number;
}

export interface UsageAccumulatorOptions {
	/**
	 * Whether this provider's delta-normalized totals should also be
	 * re-attached as `absoluteUsage` (real context-window occupancy) -
	 * true for combined-context providers (today: Codex only).
	 *
	 * Per the turn contract §3: the canonical source for this is the
	 * `usesCombinedContextWindow` capability flag in
	 * `src/shared/maestro-lib/providers/capabilities.ts`, not the separate
	 * `COMBINED_CONTEXT_AGENTS` static set in `src/shared/agentConstants.ts`
	 * - that module's own comment already says the flag is canonical and
	 * the set exists only "for cross-process use." Pass the resolved
	 * capability value here; this class does not read either source itself.
	 */
	attachesAbsoluteUsage: boolean;
}

export class UsageAccumulator {
	private _lastTotals: UsageTotals | undefined;
	private _isCumulative: boolean | undefined;
	private readonly attachesAbsoluteUsage: boolean;

	constructor(options: UsageAccumulatorOptions) {
		this.attachesAbsoluteUsage = options.attachesAbsoluteUsage;
	}

	/**
	 * The most recent raw totals seen, before delta normalization. Exposed
	 * (as a defensive copy) so a caller that needs to mirror this instance's
	 * state onto its own external record - e.g. `ManagedProcess.
	 * lastUsageTotals`, read directly by `plugin-event-listener.ts` - can do
	 * so without this class knowing anything about that consumer.
	 */
	get lastTotals(): UsageTotals | undefined {
		return this._lastTotals ? { ...this._lastTotals } : undefined;
	}

	/** Whether this stream has been determined to report cumulative totals. `undefined` until the second event arrives. */
	get isCumulative(): boolean | undefined {
		return this._isCumulative;
	}

	/**
	 * Normalize one usage event against everything seen so far on this
	 * instance. The first call always returns its input verbatim (there is
	 * nothing to delta against yet, and it is already an absolute snapshot).
	 */
	normalize(usageStats: UsageStats): UsageStats {
		const totals: UsageTotals = {
			inputTokens: usageStats.inputTokens,
			outputTokens: usageStats.outputTokens,
			cacheReadInputTokens: usageStats.cacheReadInputTokens,
			cacheCreationInputTokens: usageStats.cacheCreationInputTokens,
			reasoningTokens: usageStats.reasoningTokens || 0,
		};

		// Once a stream has been found non-cumulative, stop trying to
		// delta-normalize it - a provider does not switch reporting styles
		// mid-stream, and re-attempting would misclassify a legitimate
		// decrease (e.g. a cache eviction) as the reporting style changing.
		if (this._isCumulative === false) {
			this._lastTotals = totals;
			return usageStats;
		}

		const last = this._lastTotals;
		if (!last) {
			this._lastTotals = totals;
			return usageStats;
		}

		const delta: UsageTotals = {
			inputTokens: totals.inputTokens - last.inputTokens,
			outputTokens: totals.outputTokens - last.outputTokens,
			cacheReadInputTokens: totals.cacheReadInputTokens - last.cacheReadInputTokens,
			cacheCreationInputTokens: totals.cacheCreationInputTokens - last.cacheCreationInputTokens,
			reasoningTokens: totals.reasoningTokens - last.reasoningTokens,
		};

		const isMonotonic =
			delta.inputTokens >= 0 &&
			delta.outputTokens >= 0 &&
			delta.cacheReadInputTokens >= 0 &&
			delta.cacheCreationInputTokens >= 0 &&
			delta.reasoningTokens >= 0;

		if (!isMonotonic) {
			this._isCumulative = false;
			this._lastTotals = totals;
			return usageStats;
		}

		this._isCumulative = true;
		this._lastTotals = totals;

		// `...usageStats` first, so an incoming `absoluteUsage` (e.g.
		// Claude Code's parser-attached last-internal-call snapshot, which is
		// NOT this class's business to compute) survives untouched when this
		// provider doesn't attach one of its own below.
		return {
			...usageStats,
			inputTokens: delta.inputTokens,
			outputTokens: delta.outputTokens,
			cacheReadInputTokens: delta.cacheReadInputTokens,
			cacheCreationInputTokens: delta.cacheCreationInputTokens,
			reasoningTokens: delta.reasoningTokens,
			...(this.attachesAbsoluteUsage
				? {
						absoluteUsage: {
							inputTokens: totals.inputTokens,
							outputTokens: totals.outputTokens,
							cacheReadInputTokens: totals.cacheReadInputTokens,
							cacheCreationInputTokens: totals.cacheCreationInputTokens,
							reasoningTokens: totals.reasoningTokens,
						},
					}
				: {}),
		};
	}
}

// ---------------------------------------------------------------------------
// Usage provenance (MRC-10-04): what a usage total is made of, said plainly.
//
// The counts above are faithful to the provider's stream and the totals
// (`usage-totals.ts`) sum them, but neither says WHERE a figure came from: a
// `totalCostUsd` of 0 is a free turn, a provider that never prices (Codex) or a
// field a parser filled with `|| 0`. The tracker below watches the parsed
// reports BEFORE that conversion, where an absent field is still absent, and
// `describeUsageProvenance()` turns what it saw plus the host's total into one
// `UsageProvenanceFact`: the contract's provenance word, where the tokens and
// the cost came from, the rate table a price was read from, how the provider
// reported, what was replayed and skipped, and the cache convention. A fleet
// joins on it; a Usage Dashboard bucket is a display, never billing authority,
// and nothing here promises a figure the stream did not carry.
// ---------------------------------------------------------------------------

/**
 * The managed contract's provenance of a usage figure. A Maestro host produces
 * only the last two: `gateway_metered` is the gateway's word about traffic it
 * carried and `provider_reported` the provider's billing record, and a runtime
 * that reads its own stream can claim neither (the endpoint refuses both on a
 * runtime report). They are here so a reader maps every source onto one scale.
 */
export const USAGE_PROVENANCES = [
	'gateway_metered',
	'provider_reported',
	'estimated',
	'unavailable',
] as const;
export type UsageProvenance = (typeof USAGE_PROVENANCES)[number];

/** Where a usage figure was read: the gateway's meter, the provider's billing record, this host's own stream, nowhere. */
export type UsageSourceKind = 'gateway' | 'provider-billing' | 'runtime-stream' | 'none';

/** The contract word for a source. The two a runtime may use are the two the endpoint takes from one. */
export function usageProvenanceOf(source: UsageSourceKind): UsageProvenance {
	switch (source) {
		case 'gateway':
			return 'gateway_metered';
		case 'provider-billing':
			return 'provider_reported';
		case 'runtime-stream':
			return 'estimated';
		case 'none':
			return 'unavailable';
	}
}

/** How the provider's stream reported: a running session total, the turn in its last event, one value per step, one event only, or nothing. */
export const USAGE_REPORTINGS = [
	'running-total',
	'turn-total',
	'per-step',
	'single-event',
	'none',
] as const;
export type UsageReportingKind = (typeof USAGE_REPORTINGS)[number];

/** Where the cost figure came from: the stream carried one, this host priced the tokens, or nothing. */
export const USAGE_COST_SOURCES = ['reported', 'priced', 'none'] as const;
export type UsageCostSource = (typeof USAGE_COST_SOURCES)[number];

/** Whether cached input tokens were counted inside `inputTokens` (OpenAI) or beside it (Anthropic). */
export const CACHE_READ_COUNTINGS = ['beside-input', 'inside-input', 'unknown'] as const;
export type CacheReadCounting = (typeof CACHE_READ_COUNTINGS)[number];

/**
 * One usage report as a parser extracted it (`ParsedEvent['usage']`), before
 * `parsedUsageToStats` fills the gaps: a field the stream did not carry is
 * absent here, never zero. `correctionOnly` marks a replay of counts already
 * reported that carries only a context-window correction.
 */
export interface UsageReport {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens?: number;
	cacheCreationTokens?: number;
	reasoningTokens?: number;
	costUsd?: number;
	model?: string;
	contextWindowReported?: boolean;
	correctionOnly?: boolean;
}

/** What one process's stream said about itself, as the tracker saw it. */
export interface UsageObservation {
	/** Reports folded in. A correction-only replay is not one. */
	events: number;
	/** Replays skipped: counts already reported, carrying only a window correction. */
	corrections: number;
	/** Reports that carried a cost figure. */
	costReports: number;
	/** Reports that carried each optional count, so a missing field is told from a zero. */
	cacheReadReports: number;
	cacheCreationReports: number;
	reasoningReports: number;
	/** Whether any report named the provider's own context window. */
	contextWindowReported: boolean;
	/** The models the stream named, in order of first sight; at most `MAX_TRACKED_MODELS`. */
	models: readonly string[];
	/** The reporting style the counts followed, as the delta detection found it. */
	reporting: UsageReportingKind;
}

const MAX_TRACKED_MODELS = 8;

/**
 * Observes one process's parsed usage reports and keeps the provenance facts
 * the totals lose. Instance-scoped like `UsageAccumulator` (one per process);
 * it sums nothing and changes nothing, so a caller keeps its own totals path.
 * `reporting` is read from the same monotonic test the accumulator applies
 * (`cumulative` when the caller's accumulator said so, else per step), or
 * named by the caller for a provider whose terminal event carries the turn.
 */
export class UsageProvenanceTracker {
	private events = 0;
	private corrections = 0;
	private costReports = 0;
	private cacheReadReports = 0;
	private cacheCreationReports = 0;
	private reasoningReports = 0;
	private contextWindowReported = false;
	private readonly models: string[] = [];

	constructor(
		private readonly options: {
			/** The caller's delta accumulator, when it runs one; its `isCumulative` names the reporting. */
			accumulator?: Pick<UsageAccumulator, 'isCumulative'>;
			/** The reporting the caller already knows (a `turn-total` provider). Wins over the accumulator. */
			reporting?: Exclude<UsageReportingKind, 'none' | 'single-event'>;
		} = {}
	) {}

	observe(report: UsageReport): void {
		if (report.correctionOnly) {
			this.corrections += 1;
			return;
		}
		this.events += 1;
		if (typeof report.costUsd === 'number' && Number.isFinite(report.costUsd))
			this.costReports += 1;
		if (report.cacheReadTokens !== undefined) this.cacheReadReports += 1;
		if (report.cacheCreationTokens !== undefined) this.cacheCreationReports += 1;
		if (report.reasoningTokens !== undefined) this.reasoningReports += 1;
		if (report.contextWindowReported) this.contextWindowReported = true;
		if (
			report.model &&
			!this.models.includes(report.model) &&
			this.models.length < MAX_TRACKED_MODELS
		) {
			this.models.push(report.model);
		}
	}

	summary(): UsageObservation {
		let reporting: UsageReportingKind;
		if (this.events === 0) reporting = 'none';
		else if (this.options.reporting) reporting = this.options.reporting;
		else if (this.events === 1) reporting = 'single-event';
		else if (this.options.accumulator?.isCumulative === true) reporting = 'running-total';
		else reporting = 'per-step';
		return {
			events: this.events,
			corrections: this.corrections,
			costReports: this.costReports,
			cacheReadReports: this.cacheReadReports,
			cacheCreationReports: this.cacheCreationReports,
			reasoningReports: this.reasoningReports,
			contextWindowReported: this.contextWindowReported,
			models: [...this.models],
			reporting,
		};
	}
}

/** A cost this host priced from its rate table, and the table it read. */
export interface UsagePriceEstimate {
	costUsd: number;
	/** `price-` plus a digest of the rate table entry the model resolved to: the same rates are the same revision. */
	priceRevision: string;
	cacheReadCounting: Exclude<CacheReadCounting, 'unknown'>;
}

/** The revision of the rate table entry a model resolves to today. Two models on one tier share it; a rate change moves it. */
export function usagePriceRevision(model: string | null | undefined): string {
	const pricing = resolveModelPricing(model);
	return `price-${createHash('sha256')
		.update(canonicalJson({ pricing }), 'utf8')
		.digest('hex')
		.slice(0, 16)}`;
}

/** Price provider-reported tokens from the rate table. Never a figure for tokens nobody reported: the caller checks that first. */
export function priceUsageEstimate(
	tokens: Pick<
		UsageStats,
		'inputTokens' | 'outputTokens' | 'cacheReadInputTokens' | 'cacheCreationInputTokens'
	>,
	model: string | null | undefined
): UsagePriceEstimate {
	const pricing = resolveModelPricing(model);
	return {
		costUsd: calculateWithPricing(
			{
				inputTokens: tokens.inputTokens,
				outputTokens: tokens.outputTokens,
				cacheReadTokens: tokens.cacheReadInputTokens,
				cacheCreationTokens: tokens.cacheCreationInputTokens,
			},
			pricing
		),
		priceRevision: usagePriceRevision(model),
		cacheReadCounting: pricing.CACHE_READ_SUBSET_OF_INPUT ? 'inside-input' : 'beside-input',
	};
}

/** The cache convention of the rate table a model resolves to; `unknown` with no model to resolve. */
export function cacheReadCountingFor(model: string | null | undefined): CacheReadCounting {
	if (!model) return 'unknown';
	return resolveModelPricing(model).CACHE_READ_SUBSET_OF_INPUT ? 'inside-input' : 'beside-input';
}

/** The counts a usage fact carries: the provider's, summed by the host; a count the stream never carried is null, not zero. */
export interface UsageCounts {
	inputTokens: number;
	outputTokens: number;
	cacheReadInputTokens: number | null;
	cacheCreationInputTokens: number | null;
	reasoningTokens: number | null;
}

/**
 * What a usage total is made of. `provenance` is the contract word a fleet
 * reads (`estimated` for anything this host read off its own stream,
 * `unavailable` when the stream carried no usage); `tokens` and `cost` say
 * where each figure came from; `priceRevision` names the rate table when this
 * host priced the tokens and is null when it did not; `costUsd` is the figure
 * the fact carries under that rule, null when there is none. Nothing here is
 * billing authority: a reported cost is the stream's own estimate and a priced
 * one is this host's.
 */
export interface UsageProvenanceFact {
	provenance: UsageProvenance;
	tokens: 'provider-stream' | 'none';
	cost: UsageCostSource;
	costUsd: number | null;
	priceRevision: string | null;
	reporting: UsageReportingKind;
	events: number;
	corrections: number;
	cacheReadCounting: CacheReadCounting;
	counts: UsageCounts | null;
	/** The provider's own context window, when a report named it; null when every window was a fallback. */
	contextWindow: number | null;
}

/** Every field a `UsageProvenanceFact` may carry; a reader refuses any other key. */
export const USAGE_PROVENANCE_FIELDS: readonly (keyof UsageProvenanceFact)[] = [
	'provenance',
	'tokens',
	'cost',
	'costUsd',
	'priceRevision',
	'reporting',
	'events',
	'corrections',
	'cacheReadCounting',
	'counts',
	'contextWindow',
];

const countOrNull = (value: number | undefined, reported: boolean): number | null =>
	reported ? (value ?? 0) : null;

/**
 * The provenance of one process's usage total: what the tracker observed, the
 * total the host summed (`TurnCapture.usage`, a drained turn ledger) and the
 * model the host ran, which decides the rate table. A total with no observed
 * report is `unavailable` with no counts (a zero is never invented); a cost the
 * stream carried is `reported` as it stands; tokens nobody priced are priced
 * here as `priced` with the table's revision, and only when a model is known.
 */
export function describeUsageProvenance(
	observed: UsageObservation,
	total: UsageStats | undefined,
	model: string | null
): UsageProvenanceFact {
	const effectiveModel = model ?? observed.models[0] ?? null;
	const nothing: UsageProvenanceFact = {
		provenance: 'unavailable',
		tokens: 'none',
		cost: 'none',
		costUsd: null,
		priceRevision: null,
		reporting: observed.reporting,
		events: observed.events,
		corrections: observed.corrections,
		cacheReadCounting: 'unknown',
		counts: null,
		contextWindow: null,
	};
	if (observed.events === 0 || !total) return nothing;
	const counts: UsageCounts = {
		inputTokens: total.inputTokens,
		outputTokens: total.outputTokens,
		cacheReadInputTokens: countOrNull(total.cacheReadInputTokens, observed.cacheReadReports > 0),
		cacheCreationInputTokens: countOrNull(
			total.cacheCreationInputTokens,
			observed.cacheCreationReports > 0
		),
		reasoningTokens: countOrNull(total.reasoningTokens, observed.reasoningReports > 0),
	};
	const base = {
		...nothing,
		provenance: usageProvenanceOf('runtime-stream'),
		tokens: 'provider-stream' as const,
		counts,
		contextWindow:
			observed.contextWindowReported && total.contextWindow > 0 ? total.contextWindow : null,
		cacheReadCounting: cacheReadCountingFor(effectiveModel),
	};
	if (observed.costReports > 0) {
		return { ...base, cost: 'reported', costUsd: total.totalCostUsd };
	}
	if (!effectiveModel) return base;
	const priced = priceUsageEstimate(
		{
			inputTokens: counts.inputTokens,
			outputTokens: counts.outputTokens,
			cacheReadInputTokens: counts.cacheReadInputTokens ?? 0,
			cacheCreationInputTokens: counts.cacheCreationInputTokens ?? 0,
		},
		effectiveModel
	);
	return { ...base, cost: 'priced', costUsd: priced.costUsd, priceRevision: priced.priceRevision };
}
