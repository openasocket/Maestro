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
 *
 * E08 (GT1-11-11B1) is the one resource fixture: two resumed turns that each
 * invoke the synthetic user skill with an argument, under a selected project
 * rule that names a reply token, beside synthetic MCP entries (an enabled
 * stdio stand-in tool, a disabled one, a failing handshake and an OAuth entry
 * with no credential). The resources themselves are named here
 * (`SYNTHETIC_RESOURCES`) and materialized by the harness inside the case's
 * owned roots only; their five assertions are evaluated from what the leg
 * observed (catalog, reply, the stand-in's own logs, the reaped children).
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
	| 'binary-unchanged'
	/**
	 * Two-account cases (GT1-11-11A2): after both legs, each owned home lists
	 * only the session ids its own leg created, carries no record of the other
	 * leg, and each leg ran on its own account's credential reference and home.
	 * Evaluated across both legs by the executor, never by one leg alone.
	 */
	| 'colliding-native-ids'
	/**
	 * Effort and gateway (GT1-11-11A2): the acknowledged effort equals the
	 * selected one on every turn, every gateway variable the child received
	 * names an approved origin, and a rejected choice stops the leg unsent
	 * (never a downgrade to another effort or model).
	 */
	| 'effort-and-gateway'
	/**
	 * Resources (GT1-11-11B1): every invoked command or skill appears in the
	 * catalog the leg observed with the same argument semantics (an input entry
	 * for an invocation with an argument) and produced exactly its sentinel
	 * (one record, from the enabled stand-in, carrying the argument).
	 */
	| 'advertised-matches-executed'
	/** Every turn's reply carried the selected project rule's token; the rule's path and digest are its provenance. */
	| 'rule-applied'
	/**
	 * The enabled stand-in tool was called with lineage (its own start record,
	 * started by the agent and not the harness); the disabled entry never
	 * started; the failing and OAuth entries were refused visibly (named in the
	 * output) with no retry, no call and no credential; every MCP child that
	 * started was reaped by the end of the leg.
	 */
	| 'mcp-paths'
	/**
	 * No sentinel outside the declared ones, no resource the case did not
	 * select ran, no server outside the manifest started, no file appeared in
	 * the project or sentinel directories, and no materialized resource changed.
	 */
	| 'no-implicit-effect'
	/** A resource disabled or untrusted on turn 1 is still disabled/untrusted on every resumed turn. */
	| 'resume-trust-state';

export interface PaidFixtureTurn {
	prompt: string;
	/** The token the reply must contain. */
	expect: string;
	/** Further tokens the reply must also carry (the selected rule's token); recorded per token. */
	alsoExpect?: string[];
	/** The command or skill the turn invokes, with the argument its sentinel must carry. */
	invoke?: { command: string; argument: string };
}

/**
 * The synthetic resources a resource fixture runs against. Names only: the
 * harness writes them inside the case's owned roots and hashes each one.
 */
export interface SyntheticResourceSet {
	/** The selected user skill: takes one argument and records it through the enabled stand-in tool. */
	skill: { name: string; argumentHint: string };
	/** A user skill nothing selects; any sentinel it records is an implicit effect. */
	unselectedSkill: string;
	/** A user skill listed in `[skills] disabled`; it must never run, before or after the resume. */
	disabledSkill: string;
	/** The selected project rule (`.grok/rules/<file>`) and the token it tells every reply to carry. */
	rule: { file: string; token: string };
	mcp: {
		/** The enabled local stdio stand-in server and its one tool. */
		enabled: string;
		tool: string;
		/** `enabled = false`: must never start. */
		disabled: string;
		/** Starts and exits before the handshake. */
		failing: string;
		/** Carries an OAuth client and no credential; answers initialize with an authorization error. */
		oauth: string;
	};
}

export const SYNTHETIC_RESOURCES: Readonly<SyntheticResourceSet> = Object.freeze({
	skill: { name: 'qualify-sentinel', argumentHint: '<token>' },
	unselectedSkill: 'qualify-unselected',
	disabledSkill: 'qualify-disabled-skill',
	rule: { file: 'qualify-rule.md', token: 'QUALIFY-E08-RULE-OK' },
	mcp: {
		enabled: 'qualify-tool',
		tool: 'record_sentinel',
		disabled: 'qualify-disabled',
		failing: 'qualify-failing',
		oauth: 'qualify-oauth',
	},
});

export interface PaidFixture {
	schema: typeof PAID_FIXTURE_SCHEMA;
	family: string;
	turns: PaidFixtureTurn[];
	/**
	 * Per-account turns of a two-account case: each leg asks for its own token,
	 * so a record of one leg found under the other leg's home is attributable.
	 */
	accountTurns?: Partial<Record<'A' | 'B', PaidFixtureTurn[]>>;
	assertions: PaidAssertionId[];
	/** The synthetic resources the harness must materialize before the leg (resource fixtures only). */
	resources?: SyntheticResourceSet;
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
const RESOURCE_ASSERTIONS: PaidAssertionId[] = [
	'advertised-matches-executed',
	'rule-applied',
	'mcp-paths',
	'no-implicit-effect',
	'resume-trust-state',
];

/** One resource turn: invoke the selected skill with an argument, then reply with the turn token. */
const resourceTurn = (n: number): PaidFixtureTurn => {
	const token = `QUALIFY-E08-T${n}-OK`;
	const argument = `QUALIFY-E08-ARG-T${n}`;
	const r = SYNTHETIC_RESOURCES;
	return {
		prompt:
			`/${r.skill.name} ${argument}\n` +
			// Never names the other resources: an echoed prompt must not read as an observation of them.
			'Follow that skill exactly once and use no other skill or tool. ' +
			`Then reply with this token: ${token}`,
		expect: token,
		alsoExpect: [r.rule.token],
		invoke: { command: r.skill.name, argument },
	};
};

/** Multiline, non-ASCII and astral-plane text, written as escapes so the source stays ASCII. */
const UNICODE_PREAMBLE =
	'Ignore this synthetic text:\n' +
	'\u00e9\u00e8\u00fc \u4e16\u754c \u0645\u0631\u062d\u0628\u0627 \u{1F600}\u{1F680}\n' +
	'line three\n\n';

const fixture = (
	family: string,
	turns: PaidFixtureTurn[],
	unevaluated: PaidFixture['unevaluated'],
	extra: {
		assertions?: PaidAssertionId[];
		accountTurns?: PaidFixture['accountTurns'];
		resources?: SyntheticResourceSet;
	} = {}
): PaidFixture => ({
	schema: PAID_FIXTURE_SCHEMA,
	family,
	turns,
	...(extra.accountTurns ? { accountTurns: extra.accountTurns } : {}),
	assertions: [...(turns.length > 1 ? RESUMED : BASE), ...(extra.assertions ?? [])],
	...(extra.resources ? { resources: extra.resources } : {}),
	unevaluated,
});

/** The turns one account's leg runs: its own when the fixture names per-account turns. */
export function fixtureTurnsFor(fixture: PaidFixture, account: 'A' | 'B'): PaidFixtureTurn[] {
	return fixture.accountTurns?.[account] ?? fixture.turns;
}

export const PAID_FIXTURES: Readonly<Record<string, PaidFixture>> = Object.freeze({
	E01: fixture('E01', [turn('E01A', 1)], [], {
		assertions: ['colliding-native-ids'],
		accountTurns: { A: [turn('E01A', 1)], B: [turn('E01B', 1)] },
	}),
	E03: fixture(
		'E03',
		[turn('E03', 1, UNICODE_PREAMBLE), turn('E03', 2)],
		[
			{
				id: 'images',
				detail: 'fresh and resumed images',
				owner: 'unassigned-image-large-prompt-legs',
			},
			{
				id: 'large-prompt',
				detail: 'prompt above the argv size',
				owner: 'unassigned-image-large-prompt-legs',
			},
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
	E07: fixture('E07', [turn('E07', 1)], [], { assertions: ['effort-and-gateway'] }),
	E08: fixture(
		'E08',
		[resourceTurn(1), resourceTurn(2)],
		[
			{
				id: 'plugin-broker',
				detail: 'Maestro plugin broker dispatch of a native tool',
				owner: 'unassigned-plugin-broker-native-leg',
			},
		],
		{ assertions: RESOURCE_ASSERTIONS, resources: SYNTHETIC_RESOURCES }
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
