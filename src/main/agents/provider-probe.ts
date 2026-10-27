/**
 * A provider probe under admission (MRC2-03-04).
 *
 * A probe starts a provider's own executable to read what it knows (the
 * slash commands Claude offers in a folder, the models a CLI lists, the
 * effort levels its flag validator names) and sends it no prompt of the
 * person's. The desktop ran these through `execFileNoThrow` directly, outside
 * every admission chokepoint, and the slash-command probe even asked for
 * `--dangerously-skip-permissions`: on a managed host that was a provider
 * started with full access that no authority had seen.
 *
 * This is the one runner such a probe goes through, and `admitProviderProbe`
 * is its admission half for a probe that drives its own `startTurn` (the Codex
 * skill probe speaks JSON-RPC to `codex app-server`, MRC2-02-04 / MRC2-03-04A).
 * A standalone host (no `managed`, or a port whose standing is `standalone`)
 * runs `execFileNoThrow` exactly as before. A managed host admits the probe
 * before any process:
 *
 *   1. a refusal remembered for this authority, policy revision, provider,
 *      actor, probe and directory is answered without asking again;
 *   2. the child-process route is held to its managed standing
 *      (`probeRouteRefusal`): a provider with no admitted launch on it refuses
 *      `unavailable` by name;
 *   3. the arguments and the environment are measured against the policy's
 *      route ceiling (`boundUtilityRoute`, the same `ManagedRouteCeiling` a
 *      person's turn is held to): a full-access flag under a `standard` or
 *      `readonly` pin, a model other than the pinned one, a route the probe
 *      cannot satisfy, each a `denied` by name, never rewritten to fit;
 *   4. the port binds the actor into a verified context and the authority is
 *      asked for a lease on the snapshot of exactly the spec `startTurn` will
 *      spawn (`admitProbeTurn`, `purpose: probe`), re-checked at the sink,
 *      bound to the pid and released with the exit.
 *
 * Every refusal is remembered (`createProbeRefusalCache`) so a surface that
 * probes on every agent start does not ask the authority again for the same
 * answer, and thrown as a `DispatchRefusedError` with the authority's state
 * and code. Nothing falls back to an unmanaged spawn.
 */

import { execFileNoThrow, type ExecResult } from '../utils/execFile';
import {
	DispatchRefusedError,
	startTurn,
	type StartTurnOptions,
	type TurnExit,
	type TurnProcessSpec,
} from '../../shared/maestro-lib/run/start-turn';
import type { ManagedRoute } from '../../shared/maestro-lib/providers/capabilities';
import {
	admitProbeTurn,
	createProbeRefusalCache,
	probeRouteRefusal,
	probeTurnIdentity,
	type ProbeRefusalKey,
	type ProbeTurnRefusal,
} from '../../shared/maestro-lib/managed/host-adapter';
import { planSpawnShell } from '../process-manager/utils/windowsSpawnShell';
import {
	boundUtilityRoute,
	spawnOriginOf,
	type ProcessSpawnActor,
	type ProcessSpawnAuthorityPort,
} from '../process-manager/types';
import { currentSpawnActor } from '../web-server/auth/transport-actor';

/** The route every exec-style probe takes: the provider's own executable as a child process. */
export const PROVIDER_PROBE_ROUTE = 'child-process' as const;

/**
 * What a caller on a host with a spawn authority hands a probe: the port the
 * process manager admits with (`ProcessManager.managedPort()`, with the route
 * ceiling it may lend) and the actor the transport resolved for the request.
 * A caller with no port passes nothing and the probe runs as it always did.
 */
export interface ProviderProbeManaged {
	port: Pick<
		ProcessSpawnAuthorityPort,
		'standing' | 'policy' | 'verify' | 'authority' | 'routeCeiling'
	>;
	actor: ProcessSpawnActor;
}

/**
 * The managed half for a probe raised by the current request, or undefined
 * on a host with no port (standalone by construction). The actor is the
 * transport's answer for THIS request, so call it at the boundary where the
 * request is handled, not later.
 */
export function providerProbeManaged(
	port: ProcessSpawnAuthorityPort | null | undefined
): ProviderProbeManaged | undefined {
	return port ? { port, actor: currentSpawnActor() } : undefined;
}

/** One probe: which provider, what it reads, and exactly what to run. */
export interface ProviderProbeRequest {
	providerId: string;
	/**
	 * What the probe reads (`slash-commands`, `models`, `effort-levels`,
	 * `skill`): the trace (`<provider>-<kind>-probe:<cwd>`) and the refusal
	 * scope.
	 */
	kind: string;
	/**
	 * The route the probe takes, held to its managed standing; `child-process`
	 * when absent. `runProviderProbe` runs the executable itself and so takes
	 * only that route; a probe on another one (the Codex app-server) takes
	 * `admitProviderProbe` and drives its own `startTurn`.
	 */
	route?: ManagedRoute;
	command: string;
	args: string[];
	/** Where to run; the process's own directory when absent. */
	cwd?: string;
	/** The full environment for the probe; the process's own when absent. */
	env?: NodeJS.ProcessEnv;
}

/**
 * What a probe hands `startTurn`: the spec, and under management the
 * admission minted on exactly that spec (absent on a standalone host).
 */
export interface ProviderProbePlan {
	spec: TurnProcessSpec;
	admission?: StartTurnOptions['admission'];
}

/**
 * Probe refusals remembered across detections, keyed on the authority, its
 * policy revision, the provider, the route and the actor, probe and
 * directory, so a denying policy is not asked again on every agent start; a
 * new revision or the TTL asks again. Admissions are never cached.
 */
const probeRefusals = createProbeRefusalCache();

/** Forget every remembered probe refusal (a test, or a host whose policy was replaced). */
export function clearProviderProbeRefusals(): void {
	probeRefusals.clear();
}

/** The part of a refusal key that names who asked: the transport and its account or device. */
export function probeActorScope(actor: ProcessSpawnActor): string {
	switch (actor.peer) {
		case 'web-login':
			return `web-login:${actor.username}`;
		case 'device-pairing':
			return `device-pairing:${actor.deviceId}`;
		default:
			return actor.peer;
	}
}

/** The environment as a record, the shape the route ceiling is applied to. */
function definedEntries(env: NodeJS.ProcessEnv): Record<string, string> {
	const record: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) if (value !== undefined) record[key] = value;
	return record;
}

/** The `ExecResult` shape callers read, from what `startTurn` reported. */
function execResultOf(exit: TurnExit, stdout: string, stderr: string): ExecResult {
	if (exit.spawnError) {
		return {
			stdout,
			stderr: stderr || exit.spawnError.message,
			exitCode: (exit.spawnError as NodeJS.ErrnoException).code ?? 1,
		};
	}
	return { stdout, stderr, exitCode: exit.exitCode ?? exit.signal ?? 1 };
}

/** The spec `startTurn` is handed: the command planned for this platform's shell, in `cwd`, with `env`. */
function probeSpec(
	command: string,
	args: string[],
	cwd: string,
	env: NodeJS.ProcessEnv
): TurnProcessSpec {
	const shellPlan = planSpawnShell(command, args, {});
	return { command: shellPlan.command, args: shellPlan.args, shell: shellPlan.shell, cwd, env };
}

/**
 * The spec an unadmitted probe starts from: the request as asked, with no
 * ceiling applied and no admission, exactly what a standalone host spawns.
 * Synchronous, so a caller with no `managed` half reaches `startTurn` in the
 * same tick it always did; `admitProviderProbe` answers the same spec for a
 * standalone standing.
 */
export function providerProbeSpec(
	request: Pick<ProviderProbeRequest, 'command' | 'args' | 'cwd' | 'env'>
): TurnProcessSpec {
	return probeSpec(
		request.command,
		request.args,
		request.cwd ?? process.cwd(),
		request.env ?? process.env
	);
}

/**
 * The admission half of a probe: the spec to start and, on a managed host,
 * the admission `startTurn` takes as `options.admission`, decided before any
 * side effect in the order the module comment gives (a remembered refusal,
 * the route's managed standing, the policy's route ceiling applied to the
 * probe's own arguments and environment, the actor bound by the port, the
 * lease minted on the final spec). The spec returned is the one the lease
 * covers: hand that object, and no other, to `startTurn`. A standalone host
 * (no `managed`, or a `standalone` standing) returns the spec alone and asks
 * nobody. Every refusal is remembered and thrown as a `DispatchRefusedError`
 * with the authority's state and code; nothing falls back to an unmanaged
 * spawn.
 */
export async function admitProviderProbe(
	request: ProviderProbeRequest,
	managed?: ProviderProbeManaged
): Promise<ProviderProbePlan> {
	if (!managed || managed.port.standing() === 'standalone') {
		return { spec: providerProbeSpec(request) };
	}
	const cwd = request.cwd ?? process.cwd();
	const { port, actor } = managed;
	const { providerId, kind } = request;
	const route = request.route ?? PROVIDER_PROBE_ROUTE;
	const policy = port.policy();
	const key: ProbeRefusalKey = {
		authorityId: port.authority.authorityId,
		policyRevision: policy.policyRevision,
		providerId,
		route,
		scope: `${probeActorScope(actor)}|${kind}|${cwd}`,
	};
	const refuse = (refusal: ProbeTurnRefusal): never => {
		probeRefusals.remember(key, refusal);
		throw new DispatchRefusedError(refusal.state, refusal.code, refusal.message);
	};
	const remembered = probeRefusals.recall(key);
	if (remembered) {
		throw new DispatchRefusedError(remembered.state, remembered.code, remembered.message);
	}
	const routeRefusal = probeRouteRefusal(providerId, route);
	if (routeRefusal) return refuse(routeRefusal);

	// The policy's route, applied to the probe's own command line and
	// environment: a flag that asks for more than the pinned mode (the slash
	// probe's skip-permissions under `standard`), a model other than the
	// pinned one, or a route with no credential to run on is refused by name.
	const bounded = boundUtilityRoute(
		{
			providerId,
			args: request.args,
			customEnvVars: definedEntries(request.env ?? process.env),
			target: 'local',
		},
		port.routeCeiling?.(providerId) ?? null,
		'managed'
	);
	if (!bounded.ok) {
		return refuse({ state: 'denied', code: 'policy-denied', message: bounded.reason });
	}

	const verified = port.verify({
		actor,
		identity: probeTurnIdentity(),
		traceId: `${providerId}-${kind}-probe:${cwd}`,
		policyRevision: policy.policyRevision,
		workflow: null,
	});
	if (!verified.ok) {
		return refuse({
			state: 'denied',
			code: verified.code,
			message: `The probe's actor could not be bound: ${verified.problems.join('; ')}. Nothing was started.`,
		});
	}

	// The one spec: admitted on its snapshot here and spawned from it by
	// `startTurn`, which checks the lease against the same spec at the sink.
	const spec = probeSpec(request.command, bounded.args, cwd, bounded.customEnvVars ?? {});
	const admitted = await admitProbeTurn({
		authority: port.authority,
		policy,
		context: verified.context,
		spec,
		attribution: { provider: providerId, origin: spawnOriginOf(actor), target: { kind: 'local' } },
	});
	if (!admitted.ok) return refuse(admitted);
	return { spec, admission: admitted.admission };
}

async function admittedProbe(
	request: ProviderProbeRequest,
	managed: ProviderProbeManaged
): Promise<ExecResult> {
	const { spec, admission } = await admitProviderProbe(request, managed);
	let stdout = '';
	let stderr = '';
	const turn = startTurn(
		spec,
		{
			onStdout: (text) => {
				stdout += text;
			},
			onStderr: (text) => {
				stderr += text;
			},
		},
		{
			admission,
			stopGraceMs: 250,
			stdoutTailLimit: 0,
			stderrTailLimit: 0,
			label: `${request.providerId}-probe:${request.kind}`,
		}
	);
	return execResultOf(await turn.done, stdout, stderr);
}

/**
 * Run one probe and hand back what it printed, in the `ExecResult` shape the
 * callers already read. Standalone: `execFileNoThrow` with the same arguments
 * as before (the environment passed as `{ env }` when one is given, so a
 * caller that inherits the process environment still inherits it). Managed:
 * admitted as described above and run through `startTurn` under the lease; a
 * refusal is thrown as a `DispatchRefusedError` naming the authority's state
 * and code, nothing was started, and the caller decides what to answer in
 * its place. It never spawns unmanaged.
 */
export async function runProviderProbe(
	request: ProviderProbeRequest,
	managed?: ProviderProbeManaged
): Promise<ExecResult> {
	if (managed && managed.port.standing() !== 'standalone') {
		return admittedProbe(request, managed);
	}
	return request.env === undefined
		? execFileNoThrow(request.command, request.args, request.cwd)
		: execFileNoThrow(request.command, request.args, request.cwd, { env: request.env });
}
