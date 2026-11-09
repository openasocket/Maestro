/**
 * @file applyLocalInteractiveSpawn.steering.test.ts
 * @description Covers the seam between the two halves of chat steering: the spawn
 * decision is the ONE place that knows a turn resolved to a local maestro-p, so it
 * is where the steering socket is named. If it stops naming one, steering goes
 * silently unavailable - the client would find nothing listening and correctly
 * report "not steerable" for every turn, with nothing anywhere saying why.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { STEERING_SOCKET_ENV_VAR } from '../../../shared/chatSteering';
import { applyLocalInteractiveSpawnDecision } from '../../../main/ipc/handlers/process/apply-local-interactive-spawn';
import { steeringSocketPathFor } from '../../../main/process-manager/steering-client';
import type { ClaudeSpawnContext } from '../../../main/ipc/handlers/process/resolve-claude-spawn-context';
import type { SpawnProcessConfig } from '../../../main/ipc/handlers/process/spawn-types';

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('../../../main/utils/logger', () => ({
	logger: { warn, error: vi.fn(), debug: vi.fn(), info: vi.fn() },
}));

import { heldListeners, setListenerAuthority } from '../../../main/enterprise/listener-gate';
import {
	listenerVerdict,
	type ListenerCeilingEntry,
	type ListenerRequest,
} from '../../../main/enterprise/listener-policy';

const PROCESS_KEY = 'agent-abc-ai-tab-1';

function config(overrides: Partial<SpawnProcessConfig> = {}): SpawnProcessConfig {
	return {
		sessionId: PROCESS_KEY,
		command: 'claude',
		cwd: '/tmp/project',
		toolType: 'claude-code',
		...overrides,
	} as SpawnProcessConfig;
}

function interactiveContext(overrides: Partial<ClaudeSpawnContext> = {}): ClaudeSpawnContext {
	return {
		claudeResolvedMode: 'interactive',
		claudeResolvedReason: 'auto',
		resolvedMaestroPBinPath: '/usr/local/bin/maestro-p',
		resolvedConfigDirKey: 'default',
		claudeDecisionRealBinPath: '/usr/local/bin/claude',
		claudeResolvedRemote: false,
		...overrides,
	} as ClaudeSpawnContext;
}

function run(cfg: SpawnProcessConfig, ctx: ClaudeSpawnContext) {
	return applyLocalInteractiveSpawnDecision({
		config: cfg,
		agent: null,
		claudeContext: ctx,
		commandToSpawn: 'claude',
		argsToSpawn: ['-p', 'hello'],
		customEnvVarsToPass: undefined,
	});
}

describe('applyLocalInteractiveSpawnDecision - steering channel', () => {
	it('names the steering socket for a local interactive turn', () => {
		const result = run(config(), interactiveContext());

		expect(result.customEnvVarsToPass?.[STEERING_SOCKET_ENV_VAR]).toBe(
			steeringSocketPathFor(PROCESS_KEY)
		);
	});

	it('derives the path from the process key, so the client finds it without being told', () => {
		// The client runs later, from an IPC call holding only the key. Nothing carries
		// the path between them, which is the entire reason it is derived.
		const a = run(config({ sessionId: 'agent-abc-ai-tab-1' }), interactiveContext());
		const b = run(config({ sessionId: 'agent-abc-ai-tab-2' }), interactiveContext());

		expect(a.customEnvVarsToPass?.[STEERING_SOCKET_ENV_VAR]).not.toBe(
			b.customEnvVarsToPass?.[STEERING_SOCKET_ENV_VAR]
		);
	});

	it('keeps the caller env vars it was given', () => {
		const result = applyLocalInteractiveSpawnDecision({
			config: config(),
			agent: null,
			claudeContext: interactiveContext(),
			commandToSpawn: 'claude',
			argsToSpawn: [],
			customEnvVarsToPass: { ANTHROPIC_BASE_URL: 'https://gateway.example' },
		});

		expect(result.customEnvVarsToPass).toMatchObject({
			ANTHROPIC_BASE_URL: 'https://gateway.example',
			[STEERING_SOCKET_ENV_VAR]: steeringSocketPathFor(PROCESS_KEY),
		});
	});

	it('opens NO channel for an API-mode turn', () => {
		// `claude --print` closes stdin and holds no writable PTY for the turn, so
		// there is nothing to steer. A socket here would advertise a capability that
		// cannot work.
		const result = run(config(), interactiveContext({ claudeResolvedMode: 'api' }));

		expect(result.customEnvVarsToPass?.[STEERING_SOCKET_ENV_VAR]).toBeUndefined();
	});

	it('opens NO channel for an SSH-remote turn', () => {
		// The socket path is local; the TUI is on another host, where that path means
		// nothing. Remote steering would need the channel carried over the SSH
		// connection, which this does not do.
		const result = run(
			config({
				sessionSshRemoteConfig: { enabled: true, remoteId: 'box' },
			} as Partial<SpawnProcessConfig>),
			interactiveContext()
		);

		expect(result.customEnvVarsToPass?.[STEERING_SOCKET_ENV_VAR]).toBeUndefined();
	});

	it('opens NO channel when no maestro-p binary was resolved', () => {
		const result = run(config(), interactiveContext({ resolvedMaestroPBinPath: undefined }));

		expect(result.customEnvVarsToPass?.[STEERING_SOCKET_ENV_VAR]).toBeUndefined();
	});
});

/** Install a managed ceiling listing `listeners` over the real verdict; returns every request it was asked. */
function installCeiling(listeners: ListenerCeilingEntry[]): ListenerRequest[] {
	const asked: ListenerRequest[] = [];
	setListenerAuthority({
		evaluateListener(request) {
			asked.push(request);
			return listenerVerdict(
				{ standing: 'managed', ceiling: { policyRevision: 3, listeners }, policyRevision: 3 },
				request
			);
		},
	});
	return asked;
}

describe('applyLocalInteractiveSpawnDecision - steering listener ceiling (MCOMP-19-01D)', () => {
	afterEach(() => {
		setListenerAuthority(null);
		warn.mockClear();
	});

	it('refused: spawns maestro-p WITHOUT a steering socket and reports the hold by name', () => {
		const asked = installCeiling([{ kind: 'web', reach: 'loopback' }]);
		const result = applyLocalInteractiveSpawnDecision({
			config: config(),
			agent: null,
			claudeContext: interactiveContext(),
			commandToSpawn: 'claude',
			argsToSpawn: [],
			customEnvVarsToPass: { ANTHROPIC_BASE_URL: 'https://gateway.example' },
		});

		const socketPath = steeringSocketPathFor(PROCESS_KEY);
		expect(asked).toEqual([{ kind: 'steering', bind: socketPath, port: 0 }]);
		expect(result.customEnvVarsToPass?.[STEERING_SOCKET_ENV_VAR]).toBeUndefined();
		expect(result.customEnvVarsToPass?.ANTHROPIC_BASE_URL).toBe('https://gateway.example');
		expect(result.steeringHold).toMatchObject({
			kind: 'steering',
			bind: socketPath,
			port: 0,
			reach: 'loopback',
			code: 'kind-denied',
		});
		expect(result.steeringHold?.message).toMatch(/^\[managed-kind-denied\]/);
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining('[managed-kind-denied]'),
			expect.any(String),
			expect.objectContaining({ sessionId: PROCESS_KEY, code: 'kind-denied' })
		);
		expect(heldListeners()).toEqual([
			expect.objectContaining({
				kind: 'steering',
				bind: socketPath,
				code: 'kind-denied',
				count: 1,
			}),
		]);

		// The turn still runs through maestro-p (the same command, args and real
		// claude as an unheld launch), only unsteerable.
		setListenerAuthority(null);
		const unheld = applyLocalInteractiveSpawnDecision({
			config: config(),
			agent: null,
			claudeContext: interactiveContext(),
			commandToSpawn: 'claude',
			argsToSpawn: [],
			customEnvVarsToPass: { ANTHROPIC_BASE_URL: 'https://gateway.example' },
		});
		expect(result.commandToSpawn).toBe(unheld.commandToSpawn);
		expect(result.argsToSpawn).toEqual(unheld.argsToSpawn);
		expect(result.claudeBinPath).toBe(unheld.claudeBinPath);
		const { [STEERING_SOCKET_ENV_VAR]: _socket, ...unheldEnv } = unheld.customEnvVarsToPass ?? {};
		expect(result.customEnvVarsToPass).toEqual(unheldEnv);
	});

	it('admitted: names the socket exactly as before and records nothing', () => {
		const asked = installCeiling([{ kind: 'steering', reach: 'loopback' }]);
		const result = run(config(), interactiveContext());

		expect(asked).toHaveLength(1);
		expect(result.customEnvVarsToPass?.[STEERING_SOCKET_ENV_VAR]).toBe(
			steeringSocketPathFor(PROCESS_KEY)
		);
		expect(result.steeringHold).toBeUndefined();
		expect(heldListeners()).toEqual([]);
		expect(warn).not.toHaveBeenCalled();
	});

	it('standalone: no authority is consulted and the socket is named', () => {
		const result = run(config(), interactiveContext());

		expect(result.customEnvVarsToPass?.[STEERING_SOCKET_ENV_VAR]).toBe(
			steeringSocketPathFor(PROCESS_KEY)
		);
		expect(result.steeringHold).toBeUndefined();
		expect(heldListeners()).toEqual([]);
	});

	it('does not ask the ceiling for a turn that opens no channel (API mode, SSH)', () => {
		const asked = installCeiling([]);
		run(config(), interactiveContext({ claudeResolvedMode: 'api' }));
		run(
			config({
				sessionSshRemoteConfig: { enabled: true, remoteId: 'box' },
			} as Partial<SpawnProcessConfig>),
			interactiveContext()
		);

		expect(asked).toEqual([]);
		expect(heldListeners()).toEqual([]);
	});
});
