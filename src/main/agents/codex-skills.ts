import { startTurn } from '../../shared/maestro-lib/run/start-turn';
import { CodexAppServerRpc } from '../codex-app-server/rpc-client';
import { isCodexResponse } from '../codex-app-server/protocol';
import {
	admitProviderProbe,
	clearProviderProbeRefusals,
	providerProbeSpec,
	type ProviderProbeManaged,
	type ProviderProbeRequest,
} from './provider-probe';

/** The route the probe takes: Codex's own app-server, driven over JSON-RPC for `skills/list`. */
export const CODEX_SKILL_PROBE_ROUTE = 'codex-app-server' as const;

/**
 * What a caller on a host with a spawn authority hands the probe (MRC2-02-04):
 * the port the process manager admits with (`ProcessManager.managedPort()`)
 * and the actor the transport resolved for the request (`currentSpawnActor`),
 * the same half every provider probe takes (`providerProbeManaged`). A caller
 * with no port (a standalone double, a legacy boot path) passes nothing and
 * the probe runs as it always did.
 */
export type CodexSkillProbeManaged = ProviderProbeManaged;

/**
 * Forget every remembered probe refusal (a test, or a host whose policy was
 * replaced). The skill probe remembers its refusals in the one cache every
 * provider probe shares (MRC2-03-04A), so this clears that cache.
 */
export function clearCodexSkillProbeRefusals(): void {
	clearProviderProbeRefusals();
}

/** Skills reported by Codex itself, including enabled plugins and system skills.
 * This only reads metadata: no thread or model turn is started.
 *
 * Under management the probe is admitted before it starts (`managed`,
 * MRC2-02-04) through the admission every provider probe shares
 * (`admitProviderProbe`: a remembered refusal, the app-server route held to
 * its managed standing, the policy's route ceiling on the probe's arguments
 * and environment, the actor bound by the port, a lease on the final spec):
 * a refusal is thrown as a `DispatchRefusedError` naming the authority's state
 * and code, and the caller decides what to offer instead; it never spawns
 * unmanaged. A standalone host, and a caller that passes no `managed`, probe
 * exactly as before.
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
	const request: ProviderProbeRequest = {
		providerId: 'codex',
		kind: 'skill',
		route: CODEX_SKILL_PROBE_ROUTE,
		command,
		args: ['app-server'],
		cwd,
		env,
	};
	// The one spec: admitted on its snapshot there and spawned from it by
	// `startTurn`, which checks the lease against the same spec at the sink.
	// A caller with no managed half starts in this same tick, as it always did.
	const { spec, admission } = managed
		? await admitProviderProbe(request, managed)
		: { spec: providerProbeSpec(request), admission: undefined };
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
