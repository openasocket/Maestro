/**
 * Encore feature lifecycle: the ONE place a feature's background services
 * follow its Encore flag.
 *
 * A flag reaches the settings store by two routes. The Extensions toggle goes
 * through `FirstPartyPluginBridge.setEnabled`, which stops or reconciles the
 * feature's supervised work itself. `maestro-cli encore enable|disable` (and an
 * external edit of the settings file) is a plain `settings.set('encoreFeatures')`
 * that never touches the bridge, so a feature switched off from the CLI kept its
 * watchers, timers, and child processes running until the next launch.
 *
 * The `encoreFeatures` store change is the one signal every route produces.
 * `apply()` runs on it and, for every flag that changed, calls the SAME hooks
 * the bridge holds: `reconcile()` when the flag turned on, `stopAll()` when it
 * turned off. The bridge calling them too is harmless; every hook is idempotent.
 *
 * A managed policy may pin a flag on or off (MRC2-07-06). The pins are the
 * third input: `setPins()` records the policy's pins and settles every feature
 * they change through the same `apply` path a user change takes, against the
 * last store value seen, so a pin of `plugins: false` stops the plugin host the
 * moment the policy lands, and a later user write cannot start it (the pin
 * wins in `resolveEncoreFeatures`, and the store guard refuses the write anyway).
 *
 * Deliberately NOT `FirstPartyPluginBridge.reconcileBackgroundService()`: that
 * forces a feature OFF when its first-party grants were never minted, which is
 * every default-on feature (Cue, Usage & Stats, ...) on an install that never
 * toggled it in the Extensions tile. Following the flag is this module's job;
 * grant enforcement stays with the bridge and the broker.
 */

import {
	resolveEncoreFeatures,
	type EncoreFeatureDefaults,
	type EncoreFlagPins,
} from '../shared/encoreFeatureDefaults';
import type { FirstPartySupervisorHooks } from './plugins/first-party-bridge';

/** One Encore Feature flag (first-party features plus the community `plugins` switch). */
export type EncoreFlag = keyof EncoreFeatureDefaults;

/** The background-service hooks per feature, shared with the first-party bridges. */
export type EncoreServiceHooks = Partial<Record<EncoreFlag, FirstPartySupervisorHooks>>;

export interface EncoreFeatureLifecycleDeps {
	/** Report a hook that threw. The other features still settle. */
	onError: (flag: EncoreFlag, phase: 'reconcile' | 'stopAll', error: unknown) => void;
}

export interface EncoreFeatureLifecycle {
	/**
	 * Bind the live hooks and record `raw` as the state already applied. Called
	 * once the services exist; flag changes before that have nothing to settle.
	 */
	attach(hooks: EncoreServiceHooks, raw: unknown): void;
	/** Start `flag`'s background services when its flag is on (boot), the pins applied. */
	startIfEnabled(flag: EncoreFlag, raw: unknown): void;
	/** Settle every feature whose flag changed since the last call. */
	apply(raw: unknown): void;
	/**
	 * Record the managed policy's pins (none standalone) and settle every
	 * feature they change, against the last store value, through `apply`.
	 */
	setPins(pins: EncoreFlagPins | null | undefined): void;
}

export function createEncoreFeatureLifecycle(
	deps: EncoreFeatureLifecycleDeps
): EncoreFeatureLifecycle {
	let hooks: EncoreServiceHooks = {};
	let applied: EncoreFeatureDefaults | null = null;
	let lastRaw: unknown;
	let pins: EncoreFlagPins | null = null;

	const run = (flag: EncoreFlag, phase: 'reconcile' | 'stopAll'): void => {
		const hook = hooks[flag];
		if (!hook) return;
		try {
			hook[phase]();
		} catch (error) {
			deps.onError(flag, phase, error);
		}
	};

	const apply = (raw: unknown): void => {
		lastRaw = raw;
		if (!applied) return;
		const next = resolveEncoreFeatures(raw, pins);
		const previous = applied;
		applied = next;
		for (const flag of Object.keys(hooks) as EncoreFlag[]) {
			if (next[flag] === previous[flag]) continue;
			run(flag, next[flag] ? 'reconcile' : 'stopAll');
		}
	};

	return {
		attach(nextHooks, raw) {
			hooks = nextHooks;
			lastRaw = raw;
			applied = resolveEncoreFeatures(raw, pins);
		},
		startIfEnabled(flag, raw) {
			if (resolveEncoreFeatures(raw, pins)[flag]) run(flag, 'reconcile');
		},
		apply,
		setPins(nextPins) {
			pins = nextPins ?? null;
			apply(lastRaw);
		},
	};
}
