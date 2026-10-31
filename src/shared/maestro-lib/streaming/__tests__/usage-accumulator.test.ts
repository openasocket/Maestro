import { describe, it, expect, beforeEach, vi } from 'vitest';

// Hoisted before parser imports: config/cache reads never reach operator storage.
const codexStorage = vi.hoisted(() => ({
	existsSync: vi.fn(() => true),
	readFileSync: vi.fn((file: unknown) => {
		if (String(file).endsWith('config.toml')) return 'model = "synthetic-codex"';
		if (String(file).endsWith('models_cache.json')) {
			return JSON.stringify({
				models: [{ slug: 'synthetic-codex', context_window: 262144 }],
			});
		}
		throw new Error('Unexpected synthetic storage read');
	}),
}));
vi.mock('fs', () => codexStorage);

beforeEach(() => vi.clearAllMocks());
import {
	describeUsageProvenance,
	USAGE_PROVENANCE_FIELDS,
	USAGE_PROVENANCES,
	UsageAccumulator,
	usagePriceRevision,
	usageProvenanceOf,
	UsageProvenanceTracker,
} from '../usage-accumulator';
import { CodexOutputParser } from '../../parsers/codex-output-parser';
import type { UsageAccounting, UsageCost, UsageStats } from '../../../types';
import { parsedUsageToStats } from '../usage-totals';

function usage(overrides: Partial<UsageStats> = {}, fact?: Partial<UsageAccounting>): UsageStats {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadInputTokens: 0,
		cacheCreationInputTokens: 0,
		totalCostUsd: 0,
		contextWindow: 200_000,
		...(fact && {
			accounting: {
				source: 'runtime-stream' as const,
				route: 'acp',
				scopeId: 'fixture-account-host',
				providerSessionId: 'native-session',
				processGeneration: 'process-1',
				turnId: 'turn-1',
				scope: 'response' as const,
				reporting: 'snapshot' as const,
				cacheReadCounting: 'beside-input' as const,
				cacheCreationCounting: 'beside-input' as const,
				completeness: 'complete' as const,
				childInclusion: 'unknown' as const,
				childCompleteness: 'unknown' as const,
				cost: { status: 'unknown' as const },
				...fact,
			},
		}),
		...overrides,
	};
}

describe('Grok scoped usage reconciliation', () => {
	it.each(['snapshot', 'delta'] as const)(
		'counts only new %s spend after a covering turn snapshot',
		(reporting) => {
			const acc = new UsageAccumulator({ attachesAbsoluteUsage: false });
			acc.accumulate(usage({ inputTokens: 10 }, { responseId: 'call' }));
			acc.accumulate(usage({ inputTokens: 20 }, { scope: 'turn' }));
			const update = usage(
				{ inputTokens: reporting === 'snapshot' ? 15 : 5 },
				{ responseId: 'call', reporting }
			);
			expect(acc.accumulate(update)?.inputTokens).toBe(25);
			const ended = usage({ inputTokens: 18 }, { responseId: 'call', final: true });
			expect(acc.accumulate(ended)?.inputTokens).toBe(28);
			acc.accumulate(usage({ inputTokens: 30 }, { scope: 'turn' }));
			expect(acc.accumulate(usage({ inputTokens: 999 }, ended.accounting))?.inputTokens).toBe(30);
		}
	);

	it('accepts equal deltas as distinct observations and snapshots as replacements', () => {
		const acc = new UsageAccumulator({ attachesAbsoluteUsage: false });
		const delta = usage({ inputTokens: 3 }, { responseId: 'call', reporting: 'delta' });
		acc.accumulate(delta);
		expect(acc.accumulate(delta)?.inputTokens).toBe(6);
		expect(acc.accumulate(usage({ inputTokens: 8 }, { responseId: 'call' }))?.inputTokens).toBe(8);
	});

	it('deduplicates raw cost-omitting snapshots and retains stronger partial cost bounds', () => {
		const acc = new UsageAccumulator({ attachesAbsoluteUsage: false });
		acc.accumulate(
			usage({ inputTokens: 10 }, { cost: { status: 'exact', costUsdTicks: '9007199254740993' } })
		);
		const omitted = usage({ inputTokens: 12 }, {});
		const total = acc.accumulate(omitted);
		const reports = acc.scopedReports;
		expect(acc.accumulate(omitted)).toEqual(total);
		expect(acc.scopedReports).toEqual(reports);
		expect(total?.accounting?.cost).toMatchObject({
			status: 'partial',
			costUsdTicks: '9007199254740993',
		});
		for (const cost of [
			{ status: 'partial', costUsdTicks: '9007199254740992' },
			{ status: 'exact', costUsdTicks: '9007199254740992' },
		] satisfies UsageCost[]) {
			const weaker = usage({ inputTokens: 13 }, { cost });
			expect(acc.accumulate(weaker)?.accounting?.cost).toMatchObject({
				status: 'partial',
				costUsdTicks: '9007199254740993',
			});
		}
	});

	it('does not advance an accepted process watermark on regressed or still-stale reports', () => {
		const baseline = usage({ inputTokens: 100 }, { scope: 'process-session' });
		const acc = new UsageAccumulator({
			attachesAbsoluteUsage: false,
			processSessionBaseline: baseline,
		});
		for (const [inputTokens, expected] of [
			[110, 10],
			[105, 10],
			[108, 10],
			[112, 12],
		]) {
			const total = acc.accumulate(usage({ inputTokens }, { scope: 'process-session' }));
			expect(total).toMatchObject({
				inputTokens: expected,
				accounting: { final: false, cost: { status: 'unknown' } },
			});
		}
	});

	it.each([
		'route',
		'scopeId',
		'providerSessionId',
		'processGeneration',
		'turnId',
		'requestId',
	] as const)(
		'rejects conflicting %s while binding omitted event identity to this capture',
		(field) => {
			const identity = {
				route: 'acp',
				scopeId: 'fixture-account-host',
				providerSessionId: 'native-session',
				processGeneration: 'process-1',
				turnId: 'turn-1',
				requestId: 'prompt-request',
			};
			const acc = new UsageAccumulator({ attachesAbsoluteUsage: false, identity });
			const anonymous = usage(
				{ inputTokens: 7 },
				{
					route: undefined,
					scopeId: undefined,
					providerSessionId: undefined,
					processGeneration: undefined,
					turnId: undefined,
					requestId: 'internal-call',
				}
			);
			const total = acc.accumulate(anonymous);
			expect(total?.accounting).toMatchObject({ turnId: 'turn-1', requestId: 'prompt-request' });
			expect(
				acc.accumulate(usage({ inputTokens: 999 }, { scope: 'turn', [field]: 'foreign' }))
			).toEqual(total);
		}
	);

	it.each([
		{ scopeId: undefined },
		{ route: '' },
		{ completeness: 'partial' },
		{ reporting: 'delta' },
		{ scope: 'native-session' },
		{ processGeneration: 'foreign' },
	] satisfies Partial<UsageAccounting>[])(
		'refuses an unproven or mismatched baseline %j',
		(accounting) => {
			expect(
				() =>
					new UsageAccumulator({
						attachesAbsoluteUsage: false,
						identity: { processGeneration: 'process-1' },
						processSessionBaseline: usage({}, { scope: 'process-session', ...accounting }),
					})
			).toThrow('Process usage baseline requires complete, matching scoped identity');
		}
	);

	it('retains running/completed child and lifetime facts without adding them to parent spend', () => {
		const acc = new UsageAccumulator({ attachesAbsoluteUsage: false });
		const parent = acc.accumulate(usage({ inputTokens: 20 }, { childInclusion: 'completed' }));
		for (const status of ['running', 'completed'] as const) {
			const child = usage(
				{ inputTokens: 8 },
				{
					scope: 'child',
					providerSessionId: 'child-session',
					final: status === 'completed',
					children: [
						{
							providerSessionId: 'child-session',
							status,
							includedInParent: status === 'completed',
							completeness: 'partial',
							cost: { status: 'unknown' },
						},
					],
				}
			);
			expect(acc.accumulate(child)).toEqual(parent);
		}
		expect(acc.accumulate(usage({ inputTokens: 5000 }, { scope: 'native-session' }))).toEqual(
			parent
		);
		expect(acc.scopedReports.map((report) => report.accounting?.scope)).toEqual([
			'response',
			'child',
			'native-session',
		]);
		expect(acc.scopedReports[1].accounting?.children?.[0].status).toBe('completed');
	});
});

describe('UsageAccumulator', () => {
	it('returns the first event verbatim - nothing to delta against yet', () => {
		const acc = new UsageAccumulator({ attachesAbsoluteUsage: false });
		const first = usage({ inputTokens: 500, outputTokens: 100 });

		expect(acc.normalize(first)).toEqual(first);
	});

	it('computes a per-turn delta from cumulative, monotonically increasing totals', () => {
		const acc = new UsageAccumulator({ attachesAbsoluteUsage: false });
		acc.normalize(usage({ inputTokens: 500, outputTokens: 100, cacheReadInputTokens: 50 }));

		const second = acc.normalize(
			usage({ inputTokens: 800, outputTokens: 150, cacheReadInputTokens: 90 })
		);

		expect(second.inputTokens).toBe(300);
		expect(second.outputTokens).toBe(50);
		expect(second.cacheReadInputTokens).toBe(40);
	});

	it('re-attaches absoluteUsage with the pre-normalization cumulative totals when attachesAbsoluteUsage is true', () => {
		const acc = new UsageAccumulator({ attachesAbsoluteUsage: true });
		acc.normalize(usage({ inputTokens: 500, outputTokens: 100 }));

		const second = acc.normalize(usage({ inputTokens: 800, outputTokens: 150 }));

		expect(second.absoluteUsage).toEqual({
			inputTokens: 800,
			outputTokens: 150,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
			reasoningTokens: 0,
		});
	});

	it('does not attach absoluteUsage when attachesAbsoluteUsage is false, but preserves an incoming one untouched', () => {
		const acc = new UsageAccumulator({ attachesAbsoluteUsage: false });
		acc.normalize(usage({ inputTokens: 500, outputTokens: 100 }));

		const incomingAbsolute = {
			inputTokens: 42,
			outputTokens: 7,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
			reasoningTokens: 0,
		};
		const second = acc.normalize(
			usage({ inputTokens: 800, outputTokens: 150, absoluteUsage: incomingAbsolute })
		);

		// This provider doesn't get a computed absoluteUsage, but the one its
		// own parser already attached (e.g. Claude Code's last-call snapshot)
		// must survive the delta computation unmodified.
		expect(second.absoluteUsage).toEqual(incomingAbsolute);
	});

	it('detects a non-cumulative (already per-turn) stream and passes every event through unmodified', () => {
		const acc = new UsageAccumulator({ attachesAbsoluteUsage: false });
		acc.normalize(usage({ inputTokens: 500, outputTokens: 100 }));

		// A decrease means this provider reports per-turn, not cumulative.
		const second = usage({ inputTokens: 300, outputTokens: 80 });
		expect(acc.normalize(second)).toEqual(second);

		// Once flagged non-cumulative, every subsequent event passes through
		// verbatim too, even one that would otherwise look monotonic.
		const third = usage({ inputTokens: 900, outputTokens: 200 });
		expect(acc.normalize(third)).toEqual(third);
	});

	it('defaults reasoningTokens to 0 when absent and includes it in the delta', () => {
		const acc = new UsageAccumulator({ attachesAbsoluteUsage: false });
		acc.normalize(usage({ inputTokens: 100, reasoningTokens: 10 }));

		const second = acc.normalize(usage({ inputTokens: 200, reasoningTokens: 25 }));

		expect(second.reasoningTokens).toBe(15);
	});

	it('keeps separate instances fully independent (matches one-accumulator-per-process scoping)', () => {
		const accA = new UsageAccumulator({ attachesAbsoluteUsage: false });
		const accB = new UsageAccumulator({ attachesAbsoluteUsage: false });

		accA.normalize(usage({ inputTokens: 1000, outputTokens: 500 }));
		// B has seen nothing yet, so its first event is still verbatim even
		// though A has already established a baseline.
		const firstForB = usage({ inputTokens: 10, outputTokens: 5 });
		expect(accB.normalize(firstForB)).toEqual(firstForB);
	});

	describe('lastTotals / isCumulative getters', () => {
		it('start undefined before any event is seen', () => {
			const acc = new UsageAccumulator({ attachesAbsoluteUsage: false });
			expect(acc.lastTotals).toBeUndefined();
			expect(acc.isCumulative).toBeUndefined();
		});

		it('expose the raw totals and cumulative flag after a monotonic second event, for a caller mirroring state externally (e.g. ManagedProcess.lastUsageTotals / usageIsCumulative)', () => {
			const acc = new UsageAccumulator({ attachesAbsoluteUsage: false });
			acc.normalize(usage({ inputTokens: 500, outputTokens: 100 }));
			acc.normalize(usage({ inputTokens: 800, outputTokens: 150 }));

			expect(acc.isCumulative).toBe(true);
			expect(acc.lastTotals).toEqual({
				inputTokens: 800,
				outputTokens: 150,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 0,
				reasoningTokens: 0,
			});
		});

		it('returns a defensive copy from lastTotals - mutating the getter result does not affect internal state', () => {
			const acc = new UsageAccumulator({ attachesAbsoluteUsage: false });
			acc.normalize(usage({ inputTokens: 500, outputTokens: 100 }));

			const snapshot = acc.lastTotals;
			expect(snapshot).toBeDefined();
			if (snapshot) {
				snapshot.inputTokens = 999999;
			}

			expect(acc.lastTotals?.inputTokens).toBe(500);
		});
	});
});

// The accumulator is scoped per PROCESS, so it can only be right about a resumed
// Codex turn if the parser hands it totals that start at this process: Codex's
// `total_token_usage` is a running SESSION total, and a resumed run's first
// token_count already carries every earlier turn.
describe('UsageAccumulator over a resumed Codex process', () => {
	function tokenCount(total: Record<string, number>, last: Record<string, number>): string {
		return JSON.stringify({
			type: 'event_msg',
			payload: {
				type: 'token_count',
				info: { total_token_usage: total, last_token_usage: last },
			},
		});
	}

	function runProcess(lines: string[]): UsageStats {
		const parser = new CodexOutputParser();
		const acc = new UsageAccumulator({ attachesAbsoluteUsage: true });
		const summed = usage();
		for (const line of lines) {
			const parsed = parser.parseJsonLine(line)?.usage;
			if (!parsed) continue;
			const step = acc.normalize(
				usage({
					inputTokens: parsed.inputTokens,
					outputTokens: parsed.outputTokens,
					cacheReadInputTokens: parsed.cacheReadTokens ?? 0,
					reasoningTokens: parsed.reasoningTokens,
				})
			);
			summed.inputTokens += step.inputTokens;
			summed.outputTokens += step.outputTokens;
			summed.cacheReadInputTokens += step.cacheReadInputTokens;
		}
		return summed;
	}

	it('sums a resumed turn to what that turn spent, not the conversation so far', () => {
		// Turn 1 (an earlier process) spent 12000 in / 550 out. This process makes
		// two API calls: 13000 in / 120 out, then 13500 in / 60 out.
		const turn2 = runProcess([
			tokenCount(
				{
					input_tokens: 25000,
					cached_input_tokens: 21000,
					output_tokens: 490,
					reasoning_output_tokens: 180,
				},
				{
					input_tokens: 13000,
					cached_input_tokens: 12000,
					output_tokens: 90,
					reasoning_output_tokens: 30,
				}
			),
			tokenCount(
				{
					input_tokens: 38500,
					cached_input_tokens: 34000,
					output_tokens: 550,
					reasoning_output_tokens: 180,
				},
				{
					input_tokens: 13500,
					cached_input_tokens: 13000,
					output_tokens: 60,
					reasoning_output_tokens: 0,
				}
			),
		]);

		expect(turn2.inputTokens).toBe(26500);
		expect(turn2.outputTokens).toBe(180);
		expect(turn2.cacheReadInputTokens).toBe(25000);
	});
});

// MRC-10-04: the provenance of a usage total, read off the parsed reports the
// totals lose: where the tokens and the cost came from, the rate table a price
// was read from, how the provider reported, what was replayed, the cache
// convention, and an honest `unavailable` for a stream that carried nothing.
describe('usage provenance', () => {
	it.each([undefined, 98_304])(
		'preserves native window provenance (%s) across deferred config, completion and normalization',
		(nativeWindow) => {
			const parser = new CodexOutputParser();
			const acc = new UsageAccumulator({ attachesAbsoluteUsage: true });
			const tracker = new UsageProvenanceTracker({ accumulator: acc });
			expect(codexStorage.existsSync).not.toHaveBeenCalled();
			expect(codexStorage.readFileSync).not.toHaveBeenCalled();
			const first = parser.parseJsonObject({
				type: 'event_msg',
				payload: {
					type: 'token_count',
					info: {
						model_context_window: nativeWindow,
						total_token_usage: { input_tokens: 100, output_tokens: 10 },
					},
				},
			})!.usage!;
			expect(codexStorage.existsSync).toHaveBeenCalledOnce();
			expect(codexStorage.readFileSync).toHaveBeenCalledTimes(2);
			const completed = parser.parseJsonLine(
				JSON.stringify({
					type: 'turn.completed',
					usage: { input_tokens: 180, output_tokens: 25 },
				})
			)!.usage!;
			const expectedWindow = nativeWindow ?? 262144;
			for (const report of [first, completed]) {
				expect(report).toMatchObject({
					contextWindow: expectedWindow,
					contextWindowReported: nativeWindow !== undefined,
				});
				tracker.observe(report);
				const normalized = acc.normalize(parsedUsageToStats(report));
				expect(normalized.contextWindow).toBe(expectedWindow);
				expect(normalized.contextWindowResolved).toBe(nativeWindow ? true : undefined);
				if (report === completed) {
					expect(normalized).toMatchObject({ inputTokens: 80, outputTokens: 15 });
					expect(normalized.absoluteUsage).toMatchObject({
						inputTokens: 180,
						outputTokens: 25,
					});
					expect(describeUsageProvenance(tracker.summary(), normalized, null).contextWindow).toBe(
						nativeWindow ?? null
					);
				}
			}
			expect(codexStorage.existsSync).toHaveBeenCalledOnce();
			expect(codexStorage.readFileSync).toHaveBeenCalledTimes(2);
		}
	);

	it('maps every source onto the contract word, and a runtime only ever says estimated or unavailable', () => {
		expect(usageProvenanceOf('gateway')).toBe('gateway_metered');
		expect(usageProvenanceOf('provider-billing')).toBe('provider_reported');
		expect(usageProvenanceOf('runtime-stream')).toBe('estimated');
		expect(usageProvenanceOf('none')).toBe('unavailable');
		expect(USAGE_PROVENANCES).toEqual([
			'gateway_metered',
			'provider_reported',
			'estimated',
			'unavailable',
		]);
	});

	it('tells a field the stream never carried from a zero, skips correction replays, and names the reporting', () => {
		const acc = new UsageAccumulator({ attachesAbsoluteUsage: true });
		const tracker = new UsageProvenanceTracker({ accumulator: acc });
		expect(tracker.summary()).toMatchObject({ events: 0, reporting: 'none', models: [] });
		// Codex: running totals, no cost, cached input reported, no cache creation.
		for (const [input, cached] of [
			[1_000, 800],
			[1_600, 1_300],
		]) {
			const report = { inputTokens: input, outputTokens: 50, cacheReadTokens: cached };
			acc.normalize(usage({ inputTokens: input, outputTokens: 50, cacheReadInputTokens: cached }));
			tracker.observe({ ...report, model: 'gpt-5-codex' });
		}
		tracker.observe({ inputTokens: 0, outputTokens: 0, correctionOnly: true });
		expect(tracker.summary()).toEqual({
			events: 2,
			corrections: 1,
			costReports: 0,
			cacheReadReports: 2,
			cacheCreationReports: 0,
			reasoningReports: 0,
			contextWindowReported: false,
			models: ['gpt-5-codex'],
			reporting: 'running-total',
		});
		expect(new UsageProvenanceTracker({ reporting: 'turn-total' }).summary().reporting).toBe(
			'none'
		);
		const single = new UsageProvenanceTracker();
		single.observe({ inputTokens: 1, outputTokens: 1 });
		expect(single.summary().reporting).toBe('single-event');
		single.observe({ inputTokens: 1, outputTokens: 1 });
		expect(single.summary().reporting).toBe('per-step');
	});

	it('prices tokens nobody priced from the rate table and names its revision; a reported cost stands as reported', () => {
		const codex = new UsageProvenanceTracker({ reporting: 'running-total' });
		codex.observe({ inputTokens: 1_000, outputTokens: 50, cacheReadTokens: 800 });
		codex.observe({ inputTokens: 1_600, outputTokens: 80, cacheReadTokens: 1_300 });
		const total = usage({
			inputTokens: 1_600,
			outputTokens: 80,
			cacheReadInputTokens: 1_300,
			totalCostUsd: 0,
		});
		const priced = describeUsageProvenance(codex.summary(), total, 'gpt-5-codex');
		expect(priced).toMatchObject({
			provenance: 'estimated',
			tokens: 'provider-stream',
			cost: 'priced',
			reporting: 'running-total',
			events: 2,
			cacheReadCounting: 'inside-input',
			counts: {
				inputTokens: 1_600,
				outputTokens: 80,
				cacheReadInputTokens: 1_300,
				cacheCreationInputTokens: null,
				reasoningTokens: null,
			},
			contextWindow: null,
		});
		// OpenAI counts cached input INSIDE input: 300 uncached at $1.25, 1300 cached at $0.125, 80 out at $10.
		expect(priced.costUsd).toBeCloseTo((300 * 1.25 + 1_300 * 0.125 + 80 * 10) / 1_000_000, 10);
		expect(priced.priceRevision).toBe(usagePriceRevision('gpt-5-codex'));
		expect(priced.priceRevision).toMatch(/^price-[0-9a-f]{16}$/);
		// The revision names the rate table entry: a sibling on the same tier shares it, another tier does not.
		expect(usagePriceRevision('gpt-5-codex')).toBe(usagePriceRevision('gpt-5'));
		expect(usagePriceRevision('gpt-5-mini')).not.toBe(usagePriceRevision('gpt-5'));

		const claude = new UsageProvenanceTracker({ reporting: 'turn-total' });
		claude.observe({
			inputTokens: 10,
			outputTokens: 5,
			cacheReadTokens: 900,
			cacheCreationTokens: 100,
			costUsd: 0.0123,
			contextWindowReported: true,
		});
		const reported = describeUsageProvenance(
			claude.summary(),
			usage({
				inputTokens: 10,
				outputTokens: 5,
				cacheReadInputTokens: 900,
				cacheCreationInputTokens: 100,
				totalCostUsd: 0.0123,
			}),
			'claude-opus-4-8'
		);
		expect(reported).toMatchObject({
			provenance: 'estimated',
			cost: 'reported',
			costUsd: 0.0123,
			priceRevision: null,
			cacheReadCounting: 'beside-input',
			contextWindow: 200_000,
			counts: { cacheCreationInputTokens: 100, reasoningTokens: null },
		});
	});

	it('falls back to the model the stream named, prices nothing for an unknown model, and says unavailable for a silent stream', () => {
		const named = new UsageProvenanceTracker();
		named.observe({ inputTokens: 100, outputTokens: 10, model: 'claude-haiku-4-5' });
		const fromStream = describeUsageProvenance(
			named.summary(),
			usage({ inputTokens: 100, outputTokens: 10 }),
			null
		);
		expect(fromStream).toMatchObject({
			cost: 'priced',
			priceRevision: usagePriceRevision('claude-haiku-4-5'),
		});
		expect(fromStream.costUsd).toBeCloseTo((100 * 1 + 10 * 5) / 1_000_000, 10);

		const anonymous = new UsageProvenanceTracker();
		anonymous.observe({ inputTokens: 100, outputTokens: 10 });
		expect(
			describeUsageProvenance(anonymous.summary(), usage({ inputTokens: 100 }), null)
		).toMatchObject({
			provenance: 'estimated',
			tokens: 'provider-stream',
			cost: 'none',
			costUsd: null,
			priceRevision: null,
			cacheReadCounting: 'unknown',
		});

		expect(
			describeUsageProvenance(
				anonymous.summary(),
				usage({ inputTokens: 100 }),
				'grok-fixture-unknown'
			)
		).toMatchObject({
			cost: 'none',
			costUsd: null,
			priceRevision: null,
			cacheReadCounting: 'unknown',
		});

		const silent = new UsageProvenanceTracker().summary();
		expect(describeUsageProvenance(silent, usage({ inputTokens: 100 }), 'opus')).toEqual({
			provenance: 'unavailable',
			tokens: 'none',
			cost: 'none',
			costUsd: null,
			priceRevision: null,
			reporting: 'none',
			events: 0,
			corrections: 0,
			cacheReadCounting: 'unknown',
			counts: null,
			contextWindow: null,
		});
		// A total the host never summed is unavailable too, whatever was observed.
		expect(describeUsageProvenance(named.summary(), undefined, 'opus').provenance).toBe(
			'unavailable'
		);
		expect(USAGE_PROVENANCE_FIELDS).toHaveLength(11);
	});
});
