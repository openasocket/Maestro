/**
 * Native residual effect boundaries (MCOMP-19-06). One managed host composes
 * the REAL egress, listener, repository, local-effects and update policy
 * sources over one identity and one applied revision, installed into the REAL
 * chokepoints (`fetchWithTimeout`, the listener gate, the shared git
 * executor, `holdDeleteEffect`, `updateHoldFor`). Every effect lands on an
 * independent recording sink (a stubbed `fetch`, a bind recorder, the mocked
 * `execFileNoThrow`, a real temp directory, an installer recorder), so each
 * case asserts what actually happened, not what a gate answered. Covered per
 * effect: admitted, refused, the decision settled before the effect starts,
 * and a revocation landing between validation and dispatch.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../main/utils/execFile', () => ({ execFileNoThrow: vi.fn() }));
vi.mock('../../../main/utils/ssh-command-builder', () => ({ buildSshCommand: vi.fn() }));
vi.mock('../../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { createEgressPolicySource } from '../../../main/enterprise/egress-policy';
import type { IdentityRead } from '../../../main/enterprise/identity-store';
import {
	heldListeners,
	holdListener,
	isListenerDeniedError,
	setListenerAuthority,
} from '../../../main/enterprise/listener-gate';
import {
	createListenerPolicySource,
	type ListenerRequest,
} from '../../../main/enterprise/listener-policy';
import {
	createLocalEffectsPolicySource,
	holdDeleteEffect,
	LocalEffectRefusedError,
	type LocalEffectConfirmation,
} from '../../../main/enterprise/local-effects-policy';
import {
	createGitExecutionGate,
	createRepositoryPolicySource,
	type RepositoryEffectActor,
} from '../../../main/enterprise/repository-policy';
import { createUpdatePolicySource } from '../../../main/enterprise/update-policy';
import { setUpdateAuthority, updateHoldFor } from '../../../main/update-checker';
import { execFileNoThrow } from '../../../main/utils/execFile';
import {
	fetchWithTimeout,
	heldEgress,
	isEgressDeniedError,
	setEgressAuthority,
} from '../../../main/utils/fetchWithTimeout';
import { execGit, isGitRefusal, setGitExecutionGate } from '../../../main/utils/remote-git';
import { buildSshCommand } from '../../../main/utils/ssh-command-builder';
import { permissionModeWithinCeiling } from '../../../shared/maestro-lib/launch/env';
import { tempDirs } from './fakeManaged';

// ---------------------------------------------------------------------------
// One managed host: one identity, one applied revision, five real sources.
// ---------------------------------------------------------------------------

const ENROLLED = {
	status: 'ok',
	epoch: 1,
	fileExists: true,
	record: { registration: { actorId: 'actor-1' }, policy: { appliedRevision: 3 } },
} as unknown as IdentityRead;
let read: IdentityRead = ENROLLED;
let revision: number | null = 3;
const deps = {
	identity: { read: () => read },
	policy: () => (revision === null ? null : { appliedRevision: revision }),
};

const APPROVED = { providerId: 'codex', accountRef: 'a'.repeat(64) };
const PERSONAL = { providerId: 'codex', accountRef: 'p'.repeat(64) };
const EGRESS = {
	policyRevision: 3,
	classes: [
		{ class: 'updates', destinations: ['github.com'] },
		{ class: 'content', destinations: ['docs.example.com', 'cdn.example.com'] },
		{ class: 'provider-account', destinations: ['chatgpt.com'], accounts: [APPROVED.accountRef] },
	],
};
const LISTENERS = { policyRevision: 3, listeners: [{ kind: 'web', reach: 'loopback' }] };
const REPOSITORY = {
	policyRevision: 3,
	actors: [
		{ actor: 'operator', effects: ['commit', 'branch', 'push'] },
		{ actor: 'agent', effects: ['clone'] },
	],
	repositories: { allow: ['acme/*'] },
	remotes: { allow: ['github.com'] },
};
const UPDATES = { policyRevision: 3, hold: false, channel: 'stable', pin: '2.0.0' };

const egress = createEgressPolicySource(deps);
const listeners = createListenerPolicySource(deps);
const repository = createRepositoryPolicySource(deps);
const updates = createUpdatePolicySource(deps);
let confirmAnswer: () => Promise<LocalEffectConfirmation> = async () => 'confirmed';
const localEffects = createLocalEffectsPolicySource({ ...deps, confirm: () => confirmAnswer() });

function install(source: { install(raw: unknown): { installed: boolean } }, raw: unknown): void {
	expect(source.install(raw)).toMatchObject({ installed: true });
}

const OPERATOR: RepositoryEffectActor = { kind: 'transport', actor: { peer: 'in-process' } };
let gitActor: RepositoryEffectActor = OPERATOR;

// ---------------------------------------------------------------------------
// Independent recording sinks.
// ---------------------------------------------------------------------------

/** Every URL a socket was opened to, in order. */
const sent: string[] = [];
/** Per-URL answer of the stubbed network; default 200. */
let network: (url: string) => Promise<Response> = async () => new Response('ok');
/** Every listener that actually bound. */
const bound: ListenerRequest[] = [];
/** Every git argv that actually ran (reads included), with where. */
const ran: Array<{ args: string[]; cwd: string | undefined }> = [];
/** Answers the mocked git process gives, keyed by argv. */
let gitAnswer: (args: string[]) => Promise<string> = async (args) =>
	args.join(' ') === 'remote get-url origin' ? 'https://github.com/acme/widgets.git' : '';
/** Every roll-forward that actually installed. */
const installedUpdates: string[] = [];

/** A listener sink as the real ones are written: hold first, then bind. */
function bind(request: ListenerRequest): void {
	holdListener(request);
	bound.push(request);
}

/** An installer as the auto-updater is written: hold the candidate, then install. */
function installUpdate(candidate: string): string | null {
	const hold = updateHoldFor({ current: '1.0.0', candidate });
	if (hold) return hold.code;
	installedUpdates.push(candidate);
	return null;
}

const newDir = tempDirs('mcomp-19-06-');

beforeEach(() => {
	vi.clearAllMocks();
	read = ENROLLED;
	revision = 3;
	gitActor = OPERATOR;
	confirmAnswer = async () => 'confirmed';
	network = async () => new Response('ok');
	for (const list of [sent, bound, ran, installedUpdates] as unknown[][]) list.length = 0;
	install(egress, EGRESS);
	install(listeners, LISTENERS);
	install(repository, REPOSITORY);
	install(updates, UPDATES);
	localEffects.clear();
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: string) => {
			sent.push(input);
			return network(input);
		})
	);
	vi.mocked(execFileNoThrow).mockImplementation(async (_cmd, args, cwd) => {
		ran.push({ args: [...(args as string[])], cwd: cwd as string | undefined });
		return { stdout: await gitAnswer(args as string[]), stderr: '', exitCode: 0 };
	});
	setEgressAuthority(egress);
	setListenerAuthority(listeners);
	setUpdateAuthority(updates);
	setGitExecutionGate(createGitExecutionGate({ repository, actor: () => gitActor }));
});

afterEach(() => {
	setEgressAuthority(null);
	setListenerAuthority(null);
	setUpdateAuthority(null);
	setGitExecutionGate(null);
	vi.unstubAllGlobals();
});

const refusalOf = async (work: Promise<unknown>) => work.then(() => null).catch((e: unknown) => e);

describe('egress and redirects', () => {
	it('sends an admitted request once and refuses an unlisted destination before any socket opens', async () => {
		expect((await fetchWithTimeout('https://github.com/x', {}, 1_000, 'updates')).ok).toBe(true);
		const refused = await refusalOf(fetchWithTimeout('https://evil.example/x', {}, 1_000));
		expect(isEgressDeniedError(refused) && refused.code).toBe('destination-denied');
		expect(sent).toEqual(['https://github.com/x']);
		expect(heldEgress()).toMatchObject([
			{ code: 'destination-denied', origin: 'https://evil.example' },
		]);
	});

	it('holds a redirect hop to an unlisted origin: the first hop is sent, the bounce never is', async () => {
		network = async (url) =>
			url.startsWith('https://docs.example.com')
				? new Response(null, { status: 302, headers: { location: 'https://evil.example/drop' } })
				: new Response('ok');
		const refused = await refusalOf(fetchWithTimeout('https://docs.example.com/a', {}, 1_000));
		expect(isEgressDeniedError(refused) && refused.url).toBe('https://evil.example/drop');
		expect(sent).toEqual(['https://docs.example.com/a']);
	});

	it('re-reads the ceiling per hop, so a revocation between two hops stops the next one', async () => {
		network = async (url) => {
			if (!url.startsWith('https://docs.example.com')) return new Response('ok');
			egress.clear(); // revoked while the first hop was in flight
			return new Response(null, {
				status: 307,
				headers: { location: 'https://cdn.example.com/b' },
			});
		};
		const refused = await refusalOf(fetchWithTimeout('https://docs.example.com/a', {}, 1_000));
		expect(isEgressDeniedError(refused) && refused.code).toBe('unavailable');
		expect(sent).toEqual(['https://docs.example.com/a']);
	});

	it('never polls a provider account the ceiling does not approve: no account and a personal one are refused, only the approved one is sent', async () => {
		const poll = (account?: typeof APPROVED) =>
			refusalOf(
				fetchWithTimeout('https://chatgpt.com/usage', {}, 1_000, {
					class: 'provider-account',
					...(account ? { account } : {}),
				})
			);
		for (const account of [undefined, PERSONAL]) {
			const refused = await poll(account);
			expect(isEgressDeniedError(refused) && refused.code).toBe('account-denied');
		}
		expect(await poll(APPROVED)).toBeNull();
		expect(sent).toEqual(['https://chatgpt.com/usage']);
	});
});

describe('listeners', () => {
	it('binds within reach, refuses a wider reach and an unlisted kind before the bind, and records each once', () => {
		bind({ kind: 'web', bind: '127.0.0.1', port: 0 });
		for (const request of [
			{ kind: 'web', bind: '0.0.0.0', port: 4000 },
			{ kind: 'tunnel', bind: '127.0.0.1', port: 4000 },
		] as ListenerRequest[]) {
			expect(() => bind(request)).toThrow(/^\[managed-(reach|kind)-denied\]/);
		}
		expect(bound).toEqual([{ kind: 'web', bind: '127.0.0.1', port: 0 }]);
		expect(heldListeners().map((hold) => hold.code)).toEqual(['reach-denied', 'kind-denied']);
	});

	it('refuses the next bind once the applied revision moves past the installed ceiling', () => {
		bind({ kind: 'web', bind: '127.0.0.1', port: 0 });
		revision = 4;
		let refused: unknown = null;
		try {
			bind({ kind: 'web', bind: '127.0.0.1', port: 0 });
		} catch (error) {
			refused = error;
		}
		expect(isListenerDeniedError(refused) && refused.code).toBe('unavailable');
		expect(bound).toHaveLength(1);
	});
});

describe('the shared git executor', () => {
	const writes = () =>
		ran.filter(({ args }) => !['remote', 'config', 'rev-parse'].includes(args[0]));

	it('names the repository with an unheld read, then runs an admitted commit: the decision precedes the write', async () => {
		const result = await execGit(['commit', '-m', 'x'], '/repo');
		expect(isGitRefusal(result)).toBe(false);
		expect(ran.map(({ args }) => args.join(' '))).toEqual(['remote get-url origin', 'commit -m x']);
	});

	it('refuses a push to an unlisted remote: nothing but the gate reads ran', async () => {
		const result = await execGit(
			['push', 'https://evil.example/acme/widgets.git', 'main'],
			'/repo'
		);
		expect(isGitRefusal(result)).toBe(true);
		expect(result.stderr).toMatch(/^\[managed-[a-z-]+\] /);
		expect(writes()).toEqual([]);
	});

	it('holds against the ceiling current at dispatch: a revocation during the gate read refuses the write', async () => {
		gitAnswer = async (args) => {
			repository.clear(); // revoked between classification and the verdict
			return args[0] === 'remote' ? 'https://github.com/acme/widgets.git' : '';
		};
		const result = await execGit(['commit', '-m', 'x'], '/repo');
		expect(result.stderr).toMatch(/^\[managed-unavailable\] /);
		expect(writes()).toEqual([]);
	});

	it('never holds a read, so status still runs while every write is refused', async () => {
		repository.clear();
		expect(isGitRefusal(await execGit(['status', '--porcelain'], '/repo'))).toBe(false);
		expect(isGitRefusal(await execGit(['commit', '-m', 'x'], '/repo'))).toBe(true);
		expect(ran.map(({ args }) => args[0])).toEqual(['status']);
	});

	it('refuses a write over SSH with no remote endpoint identity, running nothing there or here', async () => {
		const remote = { id: 'r1', name: 'Box', host: 'box', port: 22, username: 'u', enabled: true };
		const result = await execGit(['commit', '-m', 'x'], '/repo', remote as never, '/srv/repo');
		expect(result.stderr).toMatch(/^\[managed-remote-unqualified\] /);
		expect(buildSshCommand).not.toHaveBeenCalled();
		expect(ran).toEqual([]);
	});

	it('gives an agent in standard permission mode no wider repository reach than its own grant', async () => {
		expect(permissionModeWithinCeiling('standard', 'standard')).toBe(true);
		expect(permissionModeWithinCeiling('full', 'standard')).toBe(false);
		gitActor = { kind: 'agent', sessionId: 's1', agentType: 'codex' };
		const result = await execGit(['push', 'origin', 'main'], '/repo');
		expect(isGitRefusal(result)).toBe(true);
		expect(writes()).toEqual([]);
	});
});

describe('deletes over a real directory', () => {
	const file = () => {
		const target = path.join(newDir(), 'doomed.md');
		fs.writeFileSync(target, 'x');
		return target;
	};
	/** A delete sink as the real ones are written: hold, then remove. */
	const remove = async (target: string) => {
		await holdDeleteEffect(localEffects, [target], OPERATOR, '[test]');
		fs.rmSync(target);
	};

	it('refuses unavailable with no ceiling and denied by verdict, leaving the file; removes it when allowed', async () => {
		const target = file();
		expect((await refusalOf(remove(target))) as LocalEffectRefusedError).toMatchObject({
			code: 'unavailable',
		});
		install(localEffects, {
			policyRevision: 3,
			classes: [{ class: 'destructive', verdict: 'deny' }],
		});
		expect((await refusalOf(remove(target))) as LocalEffectRefusedError).toMatchObject({
			code: 'denied',
		});
		expect(fs.existsSync(target)).toBe(true);
		install(localEffects, {
			policyRevision: 3,
			classes: [{ class: 'destructive', verdict: 'allow' }],
		});
		await remove(target);
		expect(fs.existsSync(target)).toBe(false);
	});

	it('removes nothing while a confirmation is pending, and nothing when the operator declines', async () => {
		install(localEffects, {
			policyRevision: 3,
			classes: [{ class: 'destructive', verdict: 'confirm' }],
		});
		const target = file();
		let answer: (value: LocalEffectConfirmation) => void = () => {};
		confirmAnswer = () => new Promise((resolve) => (answer = resolve));
		const pending = refusalOf(remove(target));
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(fs.existsSync(target)).toBe(true);
		answer('declined');
		expect(((await pending) as LocalEffectRefusedError).code).toBe('declined');
		expect(fs.existsSync(target)).toBe(true);
	});
});

describe('updates', () => {
	it('admits the feed and the pinned stable release; refuses another version and a prerelease before install', () => {
		expect(updateHoldFor({ current: '1.0.0', candidate: null })).toBeNull();
		expect(installUpdate('2.1.0')).toBe('pin-denied');
		expect(installUpdate('2.0.0-rc.1')).toBe('channel-denied');
		expect(installUpdate('v2.0.0')).toBeNull();
		expect(installedUpdates).toEqual(['v2.0.0']);
	});

	it('re-holds at install, so a hold installed after the check refuses the download it admitted', () => {
		expect(updateHoldFor({ current: '1.0.0', candidate: '2.0.0' })).toBeNull();
		install(updates, { ...UPDATES, hold: true });
		expect(installUpdate('2.0.0')).toBe('held');
		expect(installedUpdates).toEqual([]);
	});

	it('consults nothing standalone: every effect proceeds unheld', async () => {
		read = { status: 'none' } as IdentityRead;
		expect(installUpdate('3.0.0-beta')).toBeNull();
		bind({ kind: 'tunnel', bind: '127.0.0.1', port: 1 });
		await fetchWithTimeout('https://anything.example/', {}, 1_000);
		expect(isGitRefusal(await execGit(['push', 'origin', 'main'], '/repo'))).toBe(false);
		expect([installedUpdates.length, bound.length, sent.length]).toEqual([1, 1, 1]);
	});
});
