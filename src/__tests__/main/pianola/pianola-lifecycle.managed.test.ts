/**
 * The Pianola lifecycle under management (MCOMP-33-00H1).
 *
 * MCOMP-33-00H made the memory host admit every memory CLI launch (the
 * backfill child) through the port handed to `initializePianolaMemory` as its
 * fourth argument. That only governs the desktop when the lifecycle passes the
 * host's spawn authority there: built with three arguments the port reads null
 * and the backfill launches standalone on a managed host. These cases pin that
 * the memory host gets the SAME authority the supervisor gets as `managedPort`,
 * read lazily so an enrollment that appears after construction still governs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const initializePianolaMemory = vi.fn((..._args: unknown[]) => ({ memoryHost: true }));
const supervisorOptions: Array<Record<string, unknown>> = [];

vi.mock('../../../main/pianola/memory-host', () => ({
	initializePianolaMemory: (...args: unknown[]) => initializePianolaMemory(...args),
}));
vi.mock('../../../main/pianola/pianola-supervisor', () => ({
	PianolaSupervisor: class {
		constructor(opts: Record<string, unknown>) {
			supervisorOptions.push(opts);
		}
	},
}));
vi.mock('../../../main/pianola/pianola-relearn-scheduler', () => ({
	PianolaRelearnScheduler: class {},
}));
vi.mock('../../../main/pianola/pianola-relearn', () => ({ runRelearnJob: vi.fn() }));
vi.mock('../../../main/pianola/memory-provider-discovery', () => ({
	discoverMemoryCliProviders: vi.fn(async () => []),
	readMemoryCliEnvironments: vi.fn(() => ({})),
}));
vi.mock('../../../main/pianola/pianola-store-main', () => ({
	readRules: vi.fn(() => []),
	writeSuggestions: vi.fn(),
	readSuggestions: vi.fn(),
	getProfile: vi.fn(() => ({})),
	readDecisions: vi.fn(() => []),
	onHumanDecisionSettled: vi.fn(),
}));
vi.mock('../../../main/cue/cue-cli-executor', () => ({
	resolveMaestroCliScriptPath: () => '/fake/maestro-cli.js',
}));

import { createPianolaLifecycle } from '../../../main/pianola/pianola-lifecycle';

function deps(spawnAuthority?: () => unknown) {
	const store = { get: vi.fn(() => undefined) };
	return {
		settingsStore: store,
		sessionsStore: { get: vi.fn(() => []) },
		agentConfigsStore: store,
		agentDetector: {},
		logger: { info: vi.fn() },
		spawnAuthority,
	} as unknown as Parameters<typeof createPianolaLifecycle>[0];
}

describe('Pianola lifecycle: the memory host gets the host spawn authority', () => {
	beforeEach(() => {
		initializePianolaMemory.mockClear();
		supervisorOptions.length = 0;
	});

	it('passes the same authority to the memory host and the supervisor', () => {
		const authority = { kind: 'authority' };
		const spawnAuthority = vi.fn(() => authority);
		const lifecycle = createPianolaLifecycle(deps(spawnAuthority));

		expect(lifecycle.memoryHost).toEqual({ memoryHost: true });
		expect(initializePianolaMemory).toHaveBeenCalledTimes(1);
		const managedPort = initializePianolaMemory.mock.calls[0][3];
		expect(managedPort).toBe(spawnAuthority);
		expect(supervisorOptions[0].managedPort).toBe(spawnAuthority);
	});

	it('reads the authority lazily, so a later enrollment governs the backfill', () => {
		let current: unknown = null;
		const spawnAuthority = vi.fn(() => current);
		createPianolaLifecycle(deps(spawnAuthority));
		const managedPort = initializePianolaMemory.mock.calls[0][3] as () => unknown;

		expect(spawnAuthority).not.toHaveBeenCalled();
		expect(managedPort()).toBeNull();
		current = { kind: 'enrolled' };
		expect(managedPort()).toEqual({ kind: 'enrolled' });
	});

	it('leaves a standalone host (no authority) without a port', () => {
		createPianolaLifecycle(deps(undefined));
		expect(initializePianolaMemory.mock.calls[0][3]).toBeUndefined();
	});
});
