/**
 * The permission-bypass flag vocabulary and the read-only filter, with no
 * imports. The renderer and the managed ceiling both read it, so it must not
 * reach Node-only launch code (child_process, path probing).
 */

/**
 * Boolean flags that ask a provider to bypass every approval, across the
 * providers Maestro drives. The static half of the full-access vocabulary:
 * `filterYoloArgs` strips them from a read-only turn, and a managed ceiling
 * below `full` refuses them. A provider's own `fullAccessArgs` /
 * `yoloModeArgs` (`--yolo`, `--always-approve`) join them per provider in
 * `fullAccessFlagsOf` (env.ts).
 */
export const KNOWN_FULL_ACCESS_FLAGS: readonly string[] = [
	'--dangerously-skip-permissions',
	'--dangerously-bypass-approvals-and-sandbox',
	'--skip-permissions-unsafe',
	'-y',
	'--allow-all',
];

/**
 * Filters YOLO/permission-bypass flags from agent args for read-only mode.
 * Combines agent-specific yoloModeArgs with known static flags.
 */
/**
 * Known YOLO/permission-bypass flags that should be filtered from base args
 * when running in read-only mode. Safety net for agents that embed these
 * flags in their base args without defining yoloModeArgs. The list itself
 * lives beside the managed ceiling (`KNOWN_FULL_ACCESS_FLAGS` in `env.ts`),
 * which refuses the same flags under a ceiling below `full`.
 */
export const KNOWN_YOLO_FLAGS: ReadonlySet<string> = new Set(KNOWN_FULL_ACCESS_FLAGS);

export function filterYoloArgs(args: string[], agent: { yoloModeArgs?: string[] }): string[] {
	const yoloFlags = new Set(KNOWN_YOLO_FLAGS);
	if (agent.yoloModeArgs) {
		for (const flag of agent.yoloModeArgs) {
			yoloFlags.add(flag);
		}
	}
	return args.filter((arg) => !yoloFlags.has(arg));
}
