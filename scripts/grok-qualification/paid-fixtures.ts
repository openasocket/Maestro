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
 *
 * E04 and E05 (GT1-11-11C1) also name session legs (`SessionLegSpec`): bounded
 * synthetic turns for cancellation, invalid resume, steering refusal and
 * compaction retry (E04), and the turnless refused-mutation and export legs
 * plus one continuation turn (E05). The harness runs them after the fixture
 * turns on the same reservation, each within its own `maxTurns`.
 *
 * E09 (GT1-11-11D1) also names utility legs (`UtilityLegSpec`): the user
 * messages the production onboarding and inline wizard services and the
 * feedback interview send over Grok, after the fixture turn, on the same
 * reservation and the owned account home and project only.
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
	/** Session legs the harness runs after the fixture turns, on the same reservation (E04, E05). */
	sessionLegs?: SessionLegSpec[];
	/** Utility consumer legs the harness runs after the fixture turns, on the same reservation (E09). */
	utilityLegs?: UtilityLegSpec[];
	/** Workflow legs the harness runs after the leg settled, each on a workflow reservation of its own (E09). */
	workflowLegs?: WorkflowLegSpec[];
	unevaluated: Array<{ id: string; detail: string; owner: string }>;
}

/**
 * Session legs (GT1-11-11C1). Each runs after a family's fixture turns passed,
 * against the leg's owned account home and project only, on the same
 * reservation; every turn it sends is counted before it is sent.
 *
 * - `cancellation`: turn 1 is stopped mid-stream through the production
 *   `stopProcess`; exactly one terminal outcome, no surviving descendant and no
 *   write to the owned home after the close; turn 2 resumes the same native id
 *   and replies with its token.
 * - `invalid-resume`: resuming a native id nobody created is an honest refusal
 *   or error, with no reply token, no other id substituted and no new session
 *   in the owned home.
 * - `steering-refused`: a steering input during a running turn goes through the
 *   production Grok steering decision; refused, it is held by the caller, the
 *   running turn ends as exactly one turn, and only then is the held input sent
 *   as the next resumed turn.
 * - `compaction-retry`: a context-limit refusal is handed to the production
 *   compaction rule: a provider command is sent once and the turn retried once
 *   (each drawn as a `compaction` / `retry` call first), a second refusal stops;
 *   a provider with no command declines with its recorded blocker and sends
 *   nothing more.
 * - `native-mutation-refused`: fork, delete and title change of the owned
 *   session through the production consumers are refused, owned home unchanged.
 * - `export-payload`: the production export view of the owned session carries
 *   every fixture turn's exact prompt and its reply token, in order.
 * - `exact-continuation`: the session reloaded from disk through the production
 *   storage is resumed, and the turn continues that same native id.
 */
export type SessionLegId =
	| 'cancellation'
	| 'invalid-resume'
	| 'steering-refused'
	| 'compaction-retry'
	| 'native-mutation-refused'
	| 'export-payload'
	| 'exact-continuation';

export interface SessionLegSpec {
	id: SessionLegId;
	/** The prompts the leg sends in order (a retry resends the first; a compaction sends the provider command). */
	turns: PaidFixtureTurn[];
	/** The most user turns the leg may send; the leg refuses unsent when the reservation cannot cover them. */
	maxTurns: number;
	/** True when the leg sends turns (and so needs a local native-headless launch). */
	sends: boolean;
}

/** A turn long enough to be stopped mid-stream before its token. */
const longTurn = (label: string): PaidFixtureTurn => {
	const token = `QUALIFY-${label}-OK`;
	return {
		prompt:
			'Do not use any tool. Write the numbers from 1 to 400, one per line, ' +
			`and only after the last number reply with this token: ${token}`,
		expect: token,
	};
};

const sessionTurn = (label: string): PaidFixtureTurn => {
	const token = `QUALIFY-${label}-OK`;
	return {
		prompt: `Do not use any tool. Reply with exactly this token and nothing else: ${token}`,
		expect: token,
	};
};

const CANCELLATION_LEG: SessionLegSpec = {
	id: 'cancellation',
	turns: [longTurn('E04-CANCEL-T1'), sessionTurn('E04-CANCEL-T2')],
	maxTurns: 2,
	sends: true,
};
const INVALID_RESUME_LEG: SessionLegSpec = {
	id: 'invalid-resume',
	turns: [sessionTurn('E04-INVALID-T1')],
	maxTurns: 1,
	sends: true,
};
const STEERING_LEG: SessionLegSpec = {
	id: 'steering-refused',
	turns: [longTurn('E04-STEER-T1'), sessionTurn('E04-STEER-T2')],
	maxTurns: 2,
	sends: true,
};
/** The first attempt, then at most the compaction command and one retry. */
const COMPACTION_LEG: SessionLegSpec = {
	id: 'compaction-retry',
	turns: [sessionTurn('E04-COMPACT-T1')],
	maxTurns: 3,
	sends: true,
};
const MUTATION_REFUSED_LEG: SessionLegSpec = {
	id: 'native-mutation-refused',
	turns: [],
	maxTurns: 0,
	sends: false,
};
const EXPORT_PAYLOAD_LEG: SessionLegSpec = {
	id: 'export-payload',
	turns: [],
	maxTurns: 0,
	sends: false,
};
const CONTINUATION_LEG: SessionLegSpec = {
	id: 'exact-continuation',
	turns: [sessionTurn('E05-RELOAD-T1')],
	maxTurns: 1,
	sends: true,
};

/**
 * Utility consumer legs (GT1-11-11D1). Each drives a production renderer
 * consumer over Grok through a desktop-shaped process bridge, after E09's
 * fixture turn passed, on the same reservation; every turn is counted first.
 *
 * - `wizard-structured`: `messages[0]` through the onboarding conversation
 *   manager and the inline wizard service (each answer validated by the
 *   production parser); `messages[1]` through the inline service with its
 *   delivered answer forced malformed, then resent once as the inline retry
 *   resends it (drawn as a `retry` call); then the onboarding conversation is
 *   reset and `messages[0]` sent again on a fresh native session with the
 *   wizard instructions delivered again.
 * - `feedback-interview`: an account chosen by the production feedback
 *   account rules, a required no-tools request refused before any spawn, then
 *   `messages[0]` as one read-only interview turn on that account.
 */
export type UtilityLegId = 'wizard-structured' | 'feedback-interview';

export interface UtilityLegSpec {
	id: UtilityLegId;
	/** The user messages the leg's production consumers send, in the order described above. */
	messages: string[];
	/** The most user turns the leg may send; it refuses unsent when the reservation cannot cover them. */
	maxTurns: number;
}

const WIZARD_STRUCTURED_LEG: UtilityLegSpec = {
	id: 'wizard-structured',
	messages: [
		'I want to plan a tiny synthetic checklist with three items. Do not read, write or run anything; ' +
			'answer from this message alone.',
		'The three items are alpha, beta and gamma, in that order. Do not read, write or run anything.',
	],
	maxTurns: 5,
};

const FEEDBACK_INTERVIEW_LEG: UtilityLegSpec = {
	id: 'feedback-interview',
	messages: [
		'Synthetic qualification report: a settings toggle did not stay switched on after a restart. ' +
			'Do not run any command or read any file; answer from this message alone.',
	],
	maxTurns: 1,
};

/**
 * Workflow legs (GT1-11-11E1): the production Auto Run engine over Grok, after
 * E09's leg settled, each on a workflow reservation of its own (its own turn
 * allowance under the per-leg ceiling, spend and calls shared with the case),
 * against an owned project, account home and Maestro data dir only.
 *
 * - `autorun-document`: a synthetic document with `tasks` unchecked tasks run
 *   through the library `runPlaybook`; each task ticked only by a turn that
 *   succeeded, the selected account, model and effort in every planned launch,
 *   the `auto` query source, progress counts, a History entry, children reaped.
 * - `autorun-failed-turn`: one task whose only turn is forced to fail (a resume
 *   of a native id nobody created); the document is left byte-identical to its
 *   dispatch content, the completed count is 0 and nothing is dispatched again.
 * - `autorun-cancel`: one task stopped mid-turn through the production run
 *   control; the child is gone, the document unchanged, no retry.
 * - `autorun-goal`: one bounded goal iteration through the library `runGoal`;
 *   the run completes only on the goal verdict.
 */
export type WorkflowLegId =
	| 'autorun-document'
	| 'autorun-failed-turn'
	| 'autorun-cancel'
	| 'autorun-goal';

export interface WorkflowLegSpec {
	id: WorkflowLegId;
	/** The unchecked tasks of the leg's synthetic document (none for the goal leg). */
	tasks: string[];
	/** The goal and exit criteria of a goal leg; null otherwise. */
	goal: { goal: string; exitCriteria: string } | null;
	/** The most turns the leg may dispatch: its workflow reservation's turn allowance. */
	maxTurns: number;
}

const AUTORUN_DOCUMENT_LEG: WorkflowLegSpec = {
	id: 'autorun-document',
	tasks: [
		'Append the line QUALIFY-E09-AUTORUN-T1-OK to the file qualify-autorun.txt in the working directory (create it if absent), then mark this task complete.',
		'Append the line QUALIFY-E09-AUTORUN-T2-OK to the file qualify-autorun.txt in the working directory, then mark this task complete.',
	],
	goal: null,
	maxTurns: 2,
};

const AUTORUN_FAILED_TURN_LEG: WorkflowLegSpec = {
	id: 'autorun-failed-turn',
	tasks: [
		'Append the line QUALIFY-E09-FAILED-OK to the file qualify-failed.txt in the working directory, then mark this task complete.',
	],
	goal: null,
	maxTurns: 1,
};

const AUTORUN_CANCEL_LEG: WorkflowLegSpec = {
	id: 'autorun-cancel',
	tasks: [
		'Do not use any tool. Write the numbers from 1 to 400, one per line, and only after the last number mark this task complete.',
	],
	goal: null,
	maxTurns: 1,
};

const AUTORUN_GOAL_LEG: WorkflowLegSpec = {
	id: 'autorun-goal',
	tasks: [],
	goal: {
		goal: 'Confirm that the synthetic qualification goal QUALIFY-E09-GOAL is reached. Do not read, write or run anything.',
		exitCriteria:
			'The goal is reached as soon as you have read this sentence: report progress 100 and mark the goal complete.',
	},
	maxTurns: 1,
};

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
		sessionLegs?: SessionLegSpec[];
		utilityLegs?: UtilityLegSpec[];
		workflowLegs?: WorkflowLegSpec[];
	} = {}
): PaidFixture => ({
	schema: PAID_FIXTURE_SCHEMA,
	family,
	turns,
	...(extra.accountTurns ? { accountTurns: extra.accountTurns } : {}),
	assertions: [...(turns.length > 1 ? RESUMED : BASE), ...(extra.assertions ?? [])],
	...(extra.resources ? { resources: extra.resources } : {}),
	...(extra.sessionLegs ? { sessionLegs: extra.sessionLegs } : {}),
	...(extra.utilityLegs ? { utilityLegs: extra.utilityLegs } : {}),
	...(extra.workflowLegs ? { workflowLegs: extra.workflowLegs } : {}),
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
	E04: fixture('E04', [turn('E04', 1), turn('E04', 2)], [], {
		sessionLegs: [CANCELLATION_LEG, INVALID_RESUME_LEG, STEERING_LEG, COMPACTION_LEG],
	}),
	E05: fixture(
		'E05',
		[turn('E05', 1), turn('E05', 2)],
		[
			{
				id: 'native-title-change',
				detail:
					'the native title-change refusal lives in the Electron agentSessions IPC handler, which a script cannot register',
				owner: 'unassigned-grok-title-ipc-leg',
			},
		],
		{ sessionLegs: [MUTATION_REFUSED_LEG, EXPORT_PAYLOAD_LEG, CONTINUATION_LEG] }
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
		[{ id: 'consumers', detail: 'desktop/library/CLI/workflow consumers', owner: 'GT1-11-11E' }],
		{
			utilityLegs: [WIZARD_STRUCTURED_LEG, FEEDBACK_INTERVIEW_LEG],
			workflowLegs: [
				AUTORUN_DOCUMENT_LEG,
				AUTORUN_FAILED_TURN_LEG,
				AUTORUN_CANCEL_LEG,
				AUTORUN_GOAL_LEG,
			],
		}
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
