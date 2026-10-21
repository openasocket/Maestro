import * as path from 'node:path';
import {
	bindTranslationKnowledge,
	TRANSLATION_KNOWLEDGE_ENV_VAR,
} from '../translation/knowledge-binding';
/**
 * The launch plan: one answer to "what exactly do we start for this agent?",
 * shared by desktop chat, Cue and the CLI.
 *
 * Each surface still builds its own argument list (desktop's interactive
 * Claude modes, Cue's forced batch mode and the CLI's per-provider shapes are
 * genuinely different), but everything AFTER the arguments is decided here,
 * once: where the process runs, which command it execs, what environment it
 * gets, and how the prompt reaches it.
 *
 * One place does not mean one behavior. Desktop, the CLI and Cue layer an
 * agent's environment differently and deliver its prompt differently, and have
 * since before this module existed. The plan reproduces each surface as it was
 * (`surface`); it does not make them agree. The one thing it does change is an
 * SSH remote that cannot be resolved: that fails on every surface, where
 * desktop and Cue used to run the agent LOCALLY against the remote's path.
 *
 * No spawning. Its only reads are `process.env` (through
 * `buildAgentEnvironment`) and, for a CLI or Cue launch of an agent that
 * declares `requiredSecrets`, those secrets' files (`serverSecrets.ts`). A
 * plan for an SSH remote describes the remote invocation; the caller hands it
 * to the SSH wrapper, which owns building the ssh command.
 */

import { isWindows } from '../../platformDetection';
import type { QuerySource } from '../../querySource';
import type { AgentSshRemoteConfig, SshRemoteConfig } from '../../types';
import {
	describeSecretProblem,
	describeStrictSecretProblems,
	resolveSecrets,
	resolveSecretsStrict,
	type SecretLookupOptions,
	type SecretProblem,
	type SecretSource,
} from '../../serverSecrets';
import {
	describeCredentialRefusals,
	isApprovedCredentialSet,
	type ApprovedCredentialSet,
} from '../managed/credentials';
import {
	buildAgentEnvironment,
	managedArgsProblems,
	resolveAgentEnvVars,
	type AgentEnvSurface,
	type ManagedEnvCeilingReport,
	type ManagedRouteCeiling,
} from './env';
import {
	resolvePromptDelivery,
	type PromptDelivery,
	type PromptDeliveryAgent,
} from './prompt-delivery';
import {
	resolveSshLaunchTarget,
	type SshLaunchTarget,
	type SshRemoteSettingsStore,
} from './ssh-remote-resolver';

/** The parts of a provider definition a launch plan reads. */
export interface LaunchPlanAgent extends PromptDeliveryAgent {
	id?: string;
	/** Bare binary name, run on an SSH remote where local paths mean nothing. */
	binaryName?: string;
	defaultEnvVars?: Record<string, string>;
	batchModeEnvVars?: Record<string, string>;
	readOnlyEnvOverrides?: Record<string, string>;
	/** How this provider is told which model to use; a managed launch appends the pinned model with it. */
	modelArgs?: (modelId: string) => string[];
}

export interface AgentLaunchInput {
	/**
	 * Who is launching. Decides the environment order (see `AgentEnvSurface`)
	 * and whether a Windows host moves the prompt to stdin: desktop does, for an
	 * agent that reads it there; the CLI and Cue keep it on the command line.
	 */
	surface: AgentEnvSurface;
	agent: LaunchPlanAgent | null | undefined;
	/** The command to exec locally (a resolved path, ideally). */
	command: string;
	/**
	 * The command to run on an SSH remote. Defaults to the agent's `binaryName`,
	 * then `command`; a path resolved on THIS machine names nothing over there.
	 */
	remoteCommand?: string;
	/** Every argument except the prompt. */
	args: string[];
	cwd: string;
	/** The user prompt, already final (system prompt embedded if that applies). */
	prompt?: string;
	hasImages?: boolean;

	/** Settings -> Environment. Applied on desktop only. */
	globalShellEnvVars?: Record<string, string>;
	/** Settings -> Agents, per provider. */
	agentCustomEnvVars?: Record<string, string>;
	/** The agent's own vars; replaces `agentCustomEnvVars` when present. */
	sessionCustomEnvVars?: Record<string, string>;
	/** Applies the provider's `readOnlyEnvOverrides` on top of every user layer. */
	readOnlyMode?: boolean;
	/** Adds the provider's `batchModeEnvVars` (CLI batch spawns only). */
	batchMode?: boolean;
	/** Vars Maestro states about this spawn (caller identity and the like). */
	maestroEnvVars?: Record<string, string>;
	isResuming?: boolean;
	querySource?: QuerySource;
	/** Local only: directories to put in front of PATH. */
	extraPathDirs?: string[];
	/** Cue only: inherit just the server-mode allowlist (see `filterServerProcessEnv`). */
	isServerMode?: boolean;
	/**
	 * Secret names this agent needs (the agent record's `requiredSecrets`,
	 * written by bundle import). CLI and Cue resolve them from systemd
	 * credentials, `/run/secrets` or the environment and put the values in this
	 * launch's environment only; desktop never reads them. Local launches only:
	 * a value is never sent to an SSH remote.
	 */
	requiredSecrets?: readonly string[];
	/** Where secrets are looked up. Defaults to the real paths and `process.env`; tests inject. */
	secretLookup?: SecretLookupOptions;
	/**
	 * A managed launch: what the host's policy bound for it. Absent for an
	 * unmanaged launch, which is planned exactly as before. Present, the plan
	 * fails closed: credentials come only from the approved set (never from
	 * `requiredSecrets`, a user variable or a provider login the policy did not
	 * allow), and a reference the binding refused stops the launch.
	 */
	managed?: ManagedLaunchInput;

	/** The agent's SSH setting, and where to look its remote up. */
	sshRemoteConfig?: AgentSshRemoteConfig | null;
	sshStore?: SshRemoteSettingsStore;

	/** Defaults to the real host. Injected by tests. */
	isWindowsHost?: boolean;
	/**
	 * The command will run through cmd.exe (a Windows `.cmd` shim, see
	 * `windowsShellReason`), which cannot carry a multi-line prompt. The prompt
	 * then goes over stdin on every surface, for a provider that reads it there.
	 */
	cmdShellLaunch?: boolean;
}

/** What a managed launch is planned under. Produced by the host, never by a bundle or a label. */
export interface ManagedLaunchInput {
	/**
	 * The policy's route: provider, pinned model, gateway origin, account home
	 * and whether the provider's own login may bill. Applied as the final
	 * environment ceiling on every surface (`applyManagedEnvCeiling`) and
	 * checked against the arguments (`managedArgsProblems`).
	 */
	route: ManagedRouteCeiling;
	/**
	 * The credential references the policy bound to this launch, as
	 * `bindApprovedCredentials()` returned them. Anything else (a copy, a
	 * literal, a cast) is refused as unbound.
	 */
	credentials?: ApprovedCredentialSet;
	/** The launch instant, epoch milliseconds, for the expiry re-check. Defaults to `Date.now()`. */
	now?: number;
}

/** Why a managed launch was not planned. Nothing was resolved and nothing is spawned. */
export type ManagedLaunchRefusal =
	/** `managed.credentials` is not a set `bindApprovedCredentials()` produced. */
	| 'managed-credentials-unbound'
	/** The binding refused at least one reference (revoked, expired, mismatched), or one expired since. */
	| 'managed-credential-refused'
	/** An approved reference's value is missing or unusable on this host. The ordinary warn-and-start does not apply. */
	| 'managed-credential-unavailable'
	/** The launch runs on an SSH remote: a local secret value is never forwarded there. */
	| 'managed-credential-remote'
	/** The arguments, the provider or the resulting environment route around the policy's ceiling. */
	| 'managed-route-refused';

/**
 * What happened to the approved credential references, by reference id and
 * variable NAME only (safe to log). Absent for an unmanaged launch.
 */
export interface ManagedCredentialReport {
	/** Approved references, with the variable each one is delivered as. */
	approved: { refId: string; envVar: string }[];
	/** What was placed in this launch's environment, and where each value came from. */
	delivered: { refId: string; envVar: string; source: SecretSource }[];
	/** The binding's digest, so a journal can join the launch to the decision. */
	bindingDigest: string;
	/** What the final ceiling did to the environment: names only. */
	ceiling?: { removed: string[]; pinned: string[] };
}

interface LaunchPlanCommon {
	/** Command and args to hand the process launcher (or the SSH wrapper, for a remote). */
	command: string;
	args: string[];
	cwd: string;
	prompt: PromptDelivery;
	/**
	 * Text to write to the child's stdin and then close it, for a stdin
	 * delivery. Undefined when the prompt travels any other way.
	 */
	stdin: string | undefined;
	/**
	 * The vars Maestro sets on top of the inherited environment, merged in tier
	 * order (see `resolveAgentEnvVars`). What crosses to an SSH remote, and what
	 * Process Details shows as "set by Maestro".
	 */
	envVars: Record<string, string> | undefined;
	/**
	 * What happened to `requiredSecrets`, by NAME only (safe to log). Absent
	 * when the agent declares none or the surface does not deliver them.
	 */
	secrets?: LaunchSecretsReport;
	/** The approved credential references a managed launch was planned with. Names only. */
	managedCredentials?: ManagedCredentialReport;
}

export interface LaunchSecretsReport {
	/** Names placed in the environment, with where each value came from. */
	injected: { name: string; source: SecretSource }[];
	/** Names set nowhere. */
	missing: string[];
	/** Names whose file exists but cannot be used. */
	unusable: { name: string; problem: SecretProblem; path?: string }[];
	/** Names not delivered because the agent runs on an SSH remote. */
	notDeliveredToRemote: string[];
}

export type AgentLaunchPlan =
	| (LaunchPlanCommon & {
			target: { kind: 'local' };
			/** The complete local process environment. */
			env: NodeJS.ProcessEnv;
	  })
	| (LaunchPlanCommon & {
			target: { kind: 'remote'; remote: SshRemoteConfig };
			/** No local environment: the remote host has its own, plus `envVars`. */
			env: undefined;
	  });

export type AgentLaunchPlanResult =
	| { ok: true; plan: AgentLaunchPlan }
	| {
			ok: false;
			reason: Extract<SshLaunchTarget, { kind: 'unresolved' }>['reason'] | ManagedLaunchRefusal;
			error: string;
	  };

/** True for a refusal the managed binding raised (as opposed to an unresolved SSH remote). */
export function isManagedLaunchRefusal(reason: string): reason is ManagedLaunchRefusal {
	return reason.startsWith('managed-');
}

/**
 * The approved credentials of a managed launch, or the refusal that stops it.
 * Checked before anything else is resolved: a set this module does not
 * recognize, or one with a refused reference, plans nothing.
 */
function managedCredentialsFor(
	managed: ManagedLaunchInput | undefined
):
	| { ok: true; set: ApprovedCredentialSet | undefined }
	| Extract<AgentLaunchPlanResult, { ok: false }> {
	if (!managed || managed.credentials === undefined) return { ok: true, set: undefined };
	const set = managed.credentials;
	if (!isApprovedCredentialSet(set)) {
		return {
			ok: false,
			reason: 'managed-credentials-unbound',
			error: 'The managed credentials were not bound by bindApprovedCredentials() on this host.',
		};
	}
	if (set.refused.length > 0) {
		return {
			ok: false,
			reason: 'managed-credential-refused',
			error: `The policy binding refused a credential reference for this launch - ${describeCredentialRefusals(set.refused)}`,
		};
	}
	// Bound earlier, launched now: a reference that lapsed in between is as refused as one that never bound.
	const now = managed.now ?? Date.now();
	const lapsed = set.approved.filter((entry) => now >= Date.parse(entry.expiresAt));
	if (lapsed.length > 0) {
		return {
			ok: false,
			reason: 'managed-credential-refused',
			error: `A credential reference for this launch expired before it started - ${lapsed.map((entry) => `${entry.refId} (${entry.expiresAt})`).join(', ')}`,
		};
	}
	return { ok: true, set };
}

/**
 * The approved values, read once at this launch boundary and keyed by the
 * variable the consumer reads. Every reference or nothing: a missing or
 * unusable value refuses the launch; no partial delivery is built.
 */
function deliverManagedCredentials(
	set: ApprovedCredentialSet,
	lookup: SecretLookupOptions | undefined
):
	| { ok: true; values: Record<string, string>; delivered: ManagedCredentialReport['delivered'] }
	| Extract<AgentLaunchPlanResult, { ok: false }> {
	const resolved = resolveSecretsStrict(
		set.approved.map((entry) => entry.secretName),
		lookup
	);
	if (!resolved.ok) {
		return {
			ok: false,
			reason: 'managed-credential-unavailable',
			error: `An approved credential for this launch is not available on this host - ${describeStrictSecretProblems(resolved.problems)}`,
		};
	}
	const values: Record<string, string> = {};
	const delivered: ManagedCredentialReport['delivered'] = [];
	for (const entry of set.approved) {
		values[entry.envVar] = resolved.values[entry.secretName];
		const source = resolved.found.find((found) => found.name === entry.secretName)?.source ?? 'env';
		delivered.push({ refId: entry.refId, envVar: entry.envVar, source });
	}
	return { ok: true, values, delivered };
}

/**
 * Plan an agent launch. Fails, before anything is spawned, when SSH is on and
 * no usable remote is configured; never falls back to running locally.
 */
export function buildAgentLaunchPlan(input: AgentLaunchInput): AgentLaunchPlanResult {
	const target = resolveSshLaunchTarget(input.sshStore, input.sshRemoteConfig);
	if (target.kind === 'unresolved') {
		return { ok: false, reason: target.reason, error: target.message };
	}
	const managedCredentials = managedCredentialsFor(input.managed);
	if (!managedCredentials.ok) return managedCredentials;
	const approvedCredentials = managedCredentials.set;
	const managedReport: ManagedCredentialReport | undefined = approvedCredentials
		? {
				approved: approvedCredentials.approved.map(({ refId, envVar }) => ({ refId, envVar })),
				delivered: [],
				bindingDigest: approvedCredentials.digest,
			}
		: undefined;

	const agent = input.agent;
	const route = input.managed?.route;
	if (route) {
		if (agent?.id !== undefined && agent.id !== route.providerId) {
			return {
				ok: false,
				reason: 'managed-route-refused',
				error: `The policy routes this launch to ${route.providerId}, not ${agent.id}.`,
			};
		}
		const argProblems = managedArgsProblems(input.args, route);
		if (argProblems.length > 0) {
			return {
				ok: false,
				reason: 'managed-route-refused',
				error: `The launch arguments route around the policy - ${argProblems.join('; ')}`,
			};
		}
	}
	const layers = {
		defaultEnvVars: agent?.defaultEnvVars,
		batchModeEnvVars: input.batchMode ? agent?.batchModeEnvVars : undefined,
		globalShellEnvVars: input.globalShellEnvVars,
		agentCustomEnvVars: input.agentCustomEnvVars,
		sessionCustomEnvVars: input.sessionCustomEnvVars,
		readOnlyEnvOverrides: input.readOnlyMode ? agent?.readOnlyEnvOverrides : undefined,
	};
	const layered = resolveAgentEnvVars(layers);
	const envVars =
		layered || input.maestroEnvVars
			? { ...(layered ?? {}), ...(input.maestroEnvVars ?? {}) }
			: undefined;

	// Declared secrets: CLI and Cue only, so the desktop never reads a secret
	// file, and never into `envVars`, which crosses to an SSH remote and is
	// shown in Process Details. Not under management at all: a declared NAME
	// is a dependency statement, and the only credentials a managed launch
	// receives are the ones its approved references deliver.
	const declaredSecrets =
		!input.managed &&
		input.surface !== 'desktop' &&
		input.requiredSecrets &&
		input.requiredSecrets.length > 0
			? [...new Set(input.requiredSecrets)].sort()
			: undefined;

	const knowledgeDirectory = envVars?.[TRANSLATION_KNOWLEDGE_ENV_VAR];
	const pinnedModelArgs =
		route?.model && agent?.modelArgs && !input.args.some((arg) => arg === '--model' || arg === '-m')
			? agent.modelArgs(route.model)
			: [];
	const launchArgs =
		target.kind === 'local' && agent?.id === 'claude-code' && knowledgeDirectory
			? [
					...input.args,
					...pinnedModelArgs,
					'--settings',
					JSON.stringify({ autoMemoryDirectory: path.join(knowledgeDirectory, 'memory') }),
				]
			: [...input.args, ...pinnedModelArgs];
	const effectivePrompt =
		target.kind === 'local'
			? bindTranslationKnowledge(input.prompt, envVars?.[TRANSLATION_KNOWLEDGE_ENV_VAR])
			: input.prompt;
	const prompt = resolvePromptDelivery({
		agent,
		prompt: effectivePrompt,
		// Only desktop moves a Windows prompt to stdin. The CLI and Cue have
		// always put it on the command line, on every host, unless the caller
		// says the launch goes through cmd.exe.
		isWindowsHost:
			(input.surface === 'desktop' && (input.isWindowsHost ?? isWindows())) ||
			input.cmdShellLaunch === true,
		sshRemote: target.kind === 'remote',
		hasImages: input.hasImages,
	});

	if (target.kind === 'remote') {
		// A value read here belongs to this host. It is never sent over SSH, so a
		// launch that needs one on a remote is refused rather than run without it.
		if (approvedCredentials && approvedCredentials.approved.length > 0) {
			return {
				ok: false,
				reason: 'managed-credential-remote',
				error: `This launch runs on an SSH remote and its approved credentials (${approvedCredentials.approved.map((entry) => entry.envVar).join(', ')}) are local to this host; they are not forwarded.`,
			};
		}
		if (route) {
			// The remote host's inherited environment is not this host's to bound,
			// so the ceiling cannot be applied there. Unsupported, and said so.
			return {
				ok: false,
				reason: 'managed-route-refused',
				error:
					'A managed route is not supported on an SSH remote: the remote environment cannot be bounded from this host.',
			};
		}
		return {
			ok: true,
			plan: {
				target,
				command: input.remoteCommand || agent?.binaryName || input.command,
				// The SSH wrapper places the prompt itself (inline or via its script).
				args: [...input.args],
				cwd: input.cwd,
				prompt,
				stdin: undefined,
				envVars,
				...(declaredSecrets
					? {
							secrets: {
								injected: [],
								missing: [],
								unusable: [],
								notDeliveredToRemote: declaredSecrets,
							},
						}
					: {}),
				...(managedReport ? { managedCredentials: managedReport } : {}),
				env: undefined,
			},
		};
	}

	const resolved = declaredSecrets
		? resolveSecrets(declaredSecrets, input.secretLookup)
		: undefined;
	// Approved credentials: read once, here, for this child alone. Every
	// reference or nothing.
	const credentials = approvedCredentials
		? deliverManagedCredentials(approvedCredentials, input.secretLookup)
		: undefined;
	if (credentials && !credentials.ok) return credentials;
	if (managedReport && credentials?.ok) managedReport.delivered = credentials.delivered;

	const args =
		prompt.via === 'argv' || prompt.via === 'stdin'
			? [...launchArgs, ...prompt.args]
			: [...launchArgs];

	// The final ceiling: applied inside the surface's builder, after its user
	// layers and before Maestro's own facts. Its report decides the launch.
	let ceilingReport: ManagedEnvCeilingReport | undefined;
	const env = buildAgentEnvironment({
		...layers,
		secretEnvVars: resolved?.values,
		surface: input.surface,
		maestroEnvVars: input.maestroEnvVars,
		isResuming: input.isResuming,
		querySource: input.querySource,
		extraPathDirs: input.extraPathDirs,
		isServerMode: input.isServerMode,
		...(route
			? {
					managed: {
						ceiling: route,
						credentialEnvVars: credentials?.ok ? credentials.values : {},
						report: (report) => {
							ceilingReport = report;
						},
					},
				}
			: {}),
	});
	if (ceilingReport?.problems.length) {
		return {
			ok: false,
			reason: 'managed-route-refused',
			error: `The environment does not satisfy the policy's route - ${ceilingReport.problems.join('; ')}`,
		};
	}
	if (managedReport && ceilingReport) {
		managedReport.ceiling = { removed: ceilingReport.removed, pinned: ceilingReport.pinned };
	}
	const planReport: ManagedCredentialReport | undefined =
		managedReport ??
		(ceilingReport
			? {
					approved: [],
					delivered: [],
					bindingDigest: '',
					ceiling: { removed: ceilingReport.removed, pinned: ceilingReport.pinned },
				}
			: undefined);
	return {
		ok: true,
		plan: {
			target,
			command: input.command,
			args,
			cwd: input.cwd,
			prompt,
			stdin: prompt.via === 'stdin' && prompt.format === 'raw' ? effectivePrompt : undefined,
			envVars,
			...(resolved
				? {
						secrets: {
							injected: resolved.found,
							missing: resolved.missing,
							unusable: resolved.unusable,
							notDeliveredToRemote: [],
						},
					}
				: {}),
			...(planReport ? { managedCredentials: planReport } : {}),
			env,
		},
	};
}

/**
 * One warning line for the secrets an agent declared but did not get, or
 * `undefined` when every one was delivered. Names, sources and paths only:
 * never a value, so it is safe in any log.
 */
export function describeUndeliveredSecrets(
	agentName: string,
	report: LaunchSecretsReport | undefined
): string | undefined {
	if (!report) return undefined;
	const parts: string[] = [];
	if (report.missing.length > 0) {
		parts.push(
			`not set: ${report.missing.join(', ')} (looked in $CREDENTIALS_DIRECTORY, /run/secrets and the environment)`
		);
	}
	if (report.unusable.length > 0) {
		parts.push(`unusable: ${report.unusable.map(describeSecretProblem).join('; ')}`);
	}
	if (report.notDeliveredToRemote.length > 0) {
		parts.push(
			`not sent to the SSH remote: ${report.notDeliveredToRemote.join(', ')} (set them on the remote host)`
		);
	}
	if (parts.length === 0) return undefined;
	return `Agent "${agentName}" requires secrets it did not receive - ${parts.join('; ')}`;
}
