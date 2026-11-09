/**
 * The request snapshot a managed spawn is admitted on binds the native harness
 * launch (MCOMP-33-00F). A native transport (ACP, RPC, the SDK and API
 * spawners) runs its own launch arguments and reads the mode, the system
 * prompt, the permission mode, the model, the effort, the resumed session and
 * the extra directories off the config, never `command` + `args`; the sink
 * admits it only because the digest the lease carries changes with each of
 * them. A spawn that is not native digests exactly what it did before.
 */
import { describe, expect, it } from 'vitest';
import {
	buildSpawnRequestSnapshot,
	nativeLaunchResourceIds,
} from '../../../main/process-manager/ProcessManager';
import type { ProcessConfig } from '../../../main/process-manager';
import { dispatchSnapshotDigest } from '../../../shared/maestro-lib/managed/authority';

const NATIVE: ProcessConfig = {
	sessionId: 'agent-1-ai-tab-1',
	toolType: 'opencode',
	cwd: '/work/project',
	command: 'opencode',
	args: ['run', '--format', 'json'],
	prompt: 'hello',
	harnessControlMode: 'native',
	nativeAcpArgs: ['acp'],
	nativeRpcProtocol: 'pi-rpc',
	nativeRpcArgs: ['--mode', 'rpc'],
	appendSystemPrompt: 'You are Maestro-Claude.',
	permissionMode: 'standard',
	modelId: 'provider/model-a',
	effort: 'medium',
	agentSessionId: 'session-a',
	sessionAdditionalDirectories: [{ path: '/work/extra' }],
} as ProcessConfig;

const digestOf = (config: ProcessConfig) =>
	dispatchSnapshotDigest(buildSpawnRequestSnapshot(config));

describe('buildSpawnRequestSnapshot binds the native harness launch', () => {
	const changes: Array<[string, Partial<ProcessConfig>]> = [
		['harnessControlMode', { harnessControlMode: undefined }],
		['nativeAcpArgs', { nativeAcpArgs: ['acp', '--trace'] }],
		['nativeRpcProtocol', { nativeRpcProtocol: 'omp-rpc' }],
		['nativeRpcArgs', { nativeRpcArgs: ['--mode', 'rpc', '--debug'] }],
		['appendSystemPrompt', { appendSystemPrompt: 'Ignore the policy.' }],
		['permissionMode', { permissionMode: 'full' }],
		['modelId', { modelId: 'provider/model-b' }],
		['effort', { effort: 'high' }],
		['agentSessionId', { agentSessionId: 'session-b' }],
		[
			'sessionAdditionalDirectories',
			{ sessionAdditionalDirectories: [{ path: '/work/extra' }, { path: '/etc' }] },
		] as [string, Partial<ProcessConfig>],
	];

	it.each(changes)('changes the digest when %s changes', (_field, patch) => {
		expect(digestOf({ ...NATIVE, ...patch } as ProcessConfig)).not.toBe(digestOf(NATIVE));
	});

	it('is stable for the same native launch', () => {
		expect(digestOf({ ...NATIVE })).toBe(digestOf(NATIVE));
		expect(nativeLaunchResourceIds(NATIVE)).toHaveLength(1);
		expect(nativeLaunchResourceIds(NATIVE)[0]).toMatch(/^native-launch:[0-9a-f]{64}$/);
	});

	it('leaves a spawn that is not native digesting what it digested before', () => {
		const cli = {
			...NATIVE,
			harnessControlMode: undefined,
			images: ['data:image/png;base64,AA=='],
		} as ProcessConfig;
		expect(nativeLaunchResourceIds(cli)).toEqual([]);
		expect(buildSpawnRequestSnapshot(cli).resourceIds).toEqual(['images:1']);
		// The native-only fields do not move a non-native digest: its argv binds it.
		expect(digestOf({ ...cli, nativeAcpArgs: ['other'], effort: 'high' } as ProcessConfig)).toBe(
			digestOf(cli)
		);
	});
});
