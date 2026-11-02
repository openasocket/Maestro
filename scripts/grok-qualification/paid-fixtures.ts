/**
 * Synthetic paid-case fixtures of the Grok qualification harness (GT1-11-11P1).
 *
 * One entry per paid family (E02 has no paid leg). Each turn is a bounded
 * synthetic prompt that asks for one fixed token and touches no file, tool,
 * account or network resource beyond the model call itself. The executor
 * hashes the canonical JSON of the entry it runs and records that digest with
 * every assertion it evaluated. Behaviour a turn cannot observe on its own
 * (images, tools, children, consumers, other providers, hosts) is listed under
 * `unevaluated` with the task that owns it, so a passed leg never reads as
 * proof of more than the turn mechanics it exercised.
 */

export const PAID_FIXTURE_SCHEMA = 'grok-paid-fixture/v1';

/** Assertions the paid executor evaluates itself, from what it observed. */
export type PaidAssertionId =
	/** Every turn's child (native) or channel (ACP) ended cleanly within its deadline. */
	| 'exit-clean'
	/** Every turn reached a successful terminal (native result / ACP end_turn). */
	| 'terminal-success'
	/** Every turn named a native session id. */
	| 'session-id'
	/** A later turn continued the first turn's native session, never a fresh one. */
	| 'session-continuity'
	/** Every turn's reply carried the fixture's expected token. */
	| 'reply-token'
	/** The selected model was acknowledged (ACP) or reported (native usage). */
	| 'model-acknowledged'
	/** Every turn reported usage the ledger could settle against. */
	| 'usage-reported'
	/** The pinned binary was byte-identical after the leg as before it. */
	| 'binary-unchanged';

export interface PaidFixtureTurn {
	prompt: string;
	/** The token the reply must contain. */
	expect: string;
}

export interface PaidFixture {
	schema: typeof PAID_FIXTURE_SCHEMA;
	family: string;
	turns: PaidFixtureTurn[];
	assertions: PaidAssertionId[];
	unevaluated: Array<{ id: string; detail: string; owner: string }>;
}

const turn = (family: string, n: number, extra = ''): PaidFixtureTurn => {
	const token = `QUALIFY-${family}-T${n}-OK`;
	return {
		prompt: `${extra}Do not use any tool. Reply with exactly this token and nothing else: ${token}`,
		expect: token,
	};
};

const BASE: PaidAssertionId[] = [
	'exit-clean',
	'terminal-success',
	'session-id',
	'reply-token',
	'model-acknowledged',
	'usage-reported',
	'binary-unchanged',
];
const RESUMED: PaidAssertionId[] = [...BASE, 'session-continuity'];

/** Multiline, non-ASCII and astral-plane text, written as escapes so the source stays ASCII. */
const UNICODE_PREAMBLE =
	'Ignore this synthetic text:\n' +
	'\u00e9\u00e8\u00fc \u4e16\u754c \u0645\u0631\u062d\u0628\u0627 \u{1F600}\u{1F680}\n' +
	'line three\n\n';

const fixture = (
	family: string,
	turns: PaidFixtureTurn[],
	unevaluated: PaidFixture['unevaluated']
): PaidFixture => ({
	schema: PAID_FIXTURE_SCHEMA,
	family,
	turns,
	assertions: turns.length > 1 ? RESUMED : BASE,
	unevaluated,
});

export const PAID_FIXTURES: Readonly<Record<string, PaidFixture>> = Object.freeze({
	E01: fixture(
		'E01',
		[turn('E01', 1)],
		[
			{
				id: 'colliding-native-ids',
				detail: 'two accounts run one leg each; cross-account leakage is not inspected here',
				owner: 'GT1-11-11A',
			},
		]
	),
	E03: fixture(
		'E03',
		[turn('E03', 1, UNICODE_PREAMBLE), turn('E03', 2)],
		[
			{ id: 'images', detail: 'fresh and resumed images', owner: 'GT1-11-11B' },
			{ id: 'large-prompt', detail: 'prompt above the argv size', owner: 'GT1-11-11B' },
		]
	),
	E04: fixture(
		'E04',
		[turn('E04', 1), turn('E04', 2)],
		[
			{ id: 'cancellation', detail: 'mid-turn cancel and restart', owner: 'GT1-11-11C' },
			{ id: 'invalid-resume', detail: 'resume of an unknown session', owner: 'GT1-11-11C' },
		]
	),
	E05: fixture(
		'E05',
		[turn('E05', 1), turn('E05', 2)],
		[{ id: 'reload-fork-export', detail: 'native reload, fork, export', owner: 'GT1-11-11C' }]
	),
	E06: fixture(
		'E06',
		[turn('E06', 1)],
		[{ id: 'child-usage', detail: 'child and cache-bucket usage', owner: 'GT1-11-11F' }]
	),
	E07: fixture(
		'E07',
		[turn('E07', 1)],
		[{ id: 'effort-and-gateway', detail: 'effort levels and gateways', owner: 'GT1-11-11A' }]
	),
	E08: fixture(
		'E08',
		[turn('E08', 1)],
		[{ id: 'synthetic-resources', detail: 'skills, MCP, plugins, hooks', owner: 'GT1-11-11B' }]
	),
	E09: fixture(
		'E09',
		[turn('E09', 1)],
		[{ id: 'consumers', detail: 'desktop/library/CLI/workflow consumers', owner: 'GT1-11-11E' }]
	),
	E10: fixture(
		'E10',
		[turn('E10', 1)],
		[{ id: 'negative-policy', detail: 'denied effects', owner: 'GT1-11-12' }]
	),
	E11: fixture(
		'E11',
		[turn('E11', 1), turn('E11', 2)],
		[{ id: 'cross-provider', detail: 'Claude and Codex legs', owner: 'GT1-11-13' }]
	),
	E12: fixture(
		'E12',
		[turn('E12', 1)],
		[{ id: 'hosts', detail: 'other OS/arch and SSH hosts', owner: 'GT1-11-11A' }]
	),
});
