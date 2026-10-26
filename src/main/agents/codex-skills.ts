import {
	DispatchRefusedError,
	startTurn,
	type StartTurnOptions,
	type TurnProcessSpec,
} from '../../shared/maestro-lib/run/start-turn';
import {
	admitProbeTurn,
	createProbeRefusalCache,
	probeRouteRefusal,
	probeTurnIdentity,
	type ProbeTurnRefusal,
} from '../../shared/maestro-lib/managed/host-adapter';
import { CodexAppServerRpc } from '../codex-app-server/rpc-client';
import { isCodexResponse } from '../codex-app-server/protocol';
import { planSpawnShell } from '../process-manager/utils/windowsSpawnShell';
import {
	spawnOriginOf,
	type ProcessSpawnActor,
	type ProcessSpawnAuthorityPort,
} from '../process-manager/types';

/** The route the probe takes: Codex's own app-server, driven over JSON-RPC for `skills/list`. */
export const CODEX_SKILL_PROBE_ROUTE = 'codex-app-server' as const;

/**
 * What a caller on a host with a spawn authority hands the probe (MRC2-02-04):
 * the port the process manager admits with (`ProcessManager.managedPort()`)
 * and the actor the transport resolved for the request (`currentSpawnActor`).
 * A caller with no port (a standalone double, a legacy boot path) passes
 * nothing and the probe runs as it always did.
 */
export interface CodexSkillProbeManaged {
	port: Pick<ProcessSpawnAuthorityPort, 'standing' | 'policy' | 'verify' | 'authority'>;
	actor: ProcessSpawnActor;
}

/**
 * Probe refusals remembered across detections, keyed on the authority, its
 * policy revision, the route, the actor's transport and the directory, so
 * a denying policy is not asked again on every agent start; a new revision
 * or the TTL asks again. Admissions are never cached.
 */
const probeRefusals = createProbeRefusalCache();

/** Forget every remembered probe refusal (a test, or a host whose policy was replaced). */
export function clearCodexSkillProbeRefusals(): void {
	probeRefusals.clear();
}

function actorScope(actor: ProcessSpawnActor): string {
	switch (actor.peer) {
		case 'web-login':
			return `web-login:${actor.username}`;
		case 'device-pairing':
			return `device-pairing:${actor.deviceId}`;
		default:
			return actor.peer;
	}
}

/**
 * The admission the probe starts under on a managed host, or undefined on a
 * standalone one. Decided before any side effect, in this order: a refusal
 * remembered for this policy revision is answered without asking; the route
 * is held to its managed standing (`probeRouteRefusal`: the app-server route
 * has no enforcement producer in this build, so a managed host refuses it
 * `unavailable` by name); the actor is bound into a verified context by the
 * port; and the authority is asked for a lease on the snapshot of exactly
 * `spec`. Every refusal is remembered and thrown as a `DispatchRefusedError`
 * with the authority's state and code; nothing is started and nothing falls
 * back to an unmanaged spawn.
 */
async function codexSkillProbeAdmission(
	spec: TurnProcessSpec,
	cwd: string,
	managed: CodexSkillProbeManaged
): Promise<StartTurnOptions['admission'] | undefined> {
	const { port, actor } = managed;
	if (port.standing() === 'standalone') return undefined;
	const policy = port.policy();
	const key = {
		authorityId: port.authority.authorityId,
		policyRevision: policy.policyRevision,
		providerId: 'codex',
		route: CODEX_SKILL_PROBE_ROUTE,
		scope: `${actorScope(actor)}|${cwd}`,
	};
	const refuse = (refusal: ProbeTurnRefusal): never => {
		probeRefusals.remember(key, refusal);
		throw new DispatchRefusedError(refusal.state, refusal.code, refusal.message);
	};
	const remembered = probeRefusals.recall(key);
	if (remembered) {
		throw new DispatchRefusedError(remembered.state, remembered.code, remembered.message);
	}
	const route = probeRouteRefusal('codex', CODEX_SKILL_PROBE_ROUTE);
	if (route) return refuse(route);
	const verified = port.verify({
		actor,
		identity: probeTurnIdentity(),
		traceId: `codex-skill-probe:${cwd}`,
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
	const admitted = await admitProbeTurn({
		authority: port.authority,
		policy,
		context: verified.context,
		spec,
		attribution: { provider: 'codex', origin: spawnOriginOf(actor), target: { kind: 'local' } },
	});
	if (!admitted.ok) return refuse(admitted);
	return admitted.admission;
}

/** Skills reported by Codex itself, including enabled plugins and system skills.
 * This only reads metadata: no thread or model turn is started.
 *
 * Under management the probe is admitted before it starts (`managed`,
 * MRC2-02-04): a refusal is thrown as a `DispatchRefusedError` naming the
 * authority's state and code, and the caller decides what to offer instead;
 * it never spawns unmanaged. A standalone host, and a caller that passes no
 * `managed`, probe exactly as before.
 */
export async function discoverCodexSkills(
	command: string,
	cwd: string,
	env: NodeJS.ProcessEnv,
	managed?: CodexSkillProbeManaged
): Promise<Array<{ name: string; description?: string; prompt: string }>> {
	const rpc = new CodexAppServerRpc((line) => {
		if (!turn.child.stdin?.writable) throw new Error('Codex stdin is closed');
		turn.child.stdin.write(`${line}\n`);
	});
	const shellPlan = planSpawnShell(command, ['app-server'], {});
	// The one spec: admitted on its snapshot here and spawned from it by
	// `startTurn`, which checks the lease against the same spec at the sink.
	const spec: TurnProcessSpec = { ...shellPlan, cwd, env };
	const admission = managed ? await codexSkillProbeAdmission(spec, cwd, managed) : undefined;
	const turn = startTurn(
		spec,
		{
			onLine: (line) => {
				try {
					const message = JSON.parse(line);
					if (isCodexResponse(message)) rpc.handleResponse(message);
				} catch {
					// Older CLIs may print diagnostic lines alongside JSON.
				}
			},
			onStdinError: (error) => rpc.close(error.message),
		},
		{
			...(admission ? { admission } : {}),
			keepStdinOpen: true,
			stopGraceMs: 250,
			stdoutTailLimit: 0,
			stderrTailLimit: 0,
			maxLineLength: 4 * 1024 * 1024,
			label: 'codex-skill-discovery',
		}
	);
	void turn.done.then(() => rpc.close('Codex skill discovery exited'));
	try {
		await rpc.request(
			'initialize',
			{
				clientInfo: { name: 'maestro', version: '1.0.0' },
			},
			{ timeoutMs: 5000 }
		);
		rpc.notify('initialized');
		const result = await rpc.request<{
			data: Array<{
				cwd: string;
				skills: Array<{
					name: string;
					description?: string;
					path: string;
					enabled: boolean;
					interface?: { shortDescription?: string } | null;
				}>;
			}>;
		}>('skills/list', { cwds: [cwd], forceReload: true }, { timeoutMs: 5000 });
		const commands = new Map<string, { name: string; description?: string; prompt: string }>();
		for (const entry of result.data) {
			if (entry.cwd !== cwd) continue;
			for (const skill of entry.skills) {
				if (!skill.enabled || !skill.name || !skill.path || commands.has(skill.name)) continue;
				commands.set(skill.name, {
					name: skill.name,
					description: skill.interface?.shortDescription || skill.description,
					// Preserve native skill loading and the location of relative resources.
					prompt: `$${skill.name}\n\nUse the skill at ${JSON.stringify(skill.path)}.`,
				});
			}
		}
		return [...commands.values()];
	} finally {
		rpc.close('Codex skill discovery finished');
		turn.terminate();
		await turn.done;
	}
}
