// @vitest-environment node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { MessageChannel } from 'node:worker_threads';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryDatabase } from '../../../main/pianola/memory-database';
import {
	MemoryTransportScope,
	PIANOLA_MEMORY_SERVICE,
	MEMORY_EGRESS_CLASS,
	memoryCliAdmissionClient,
	memoryEgressClient,
	serveMemoryCliAdmission,
	setMemoryCliAdmitter,
	setMemoryEgressHolder,
} from '../../../main/pianola/memory-transport';
import { heldEgress, setEgressAuthority } from '../../../main/utils/fetchWithTimeout';
import { denyingEgressAuthority, managedEgressAuthority } from '../../helpers/egressAuthority';
import { fakeSpawnPort, type FakeSpawnPort } from '../../helpers/managedSpawnPort';
import { execFileNoThrow } from '../../../shared/maestro-lib/launch/exec-file';
import type { MemoryTransportActivation } from '../../../shared/pianola/memory';

vi.mock('../../../shared/maestro-lib/launch/exec-file', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('../../../shared/maestro-lib/launch/exec-file')>();
	return { ...actual, execFileNoThrow: vi.fn() };
});

const databases: MemoryDatabase[] = [];
const directories: string[] = [];
const sha = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const proof = {
	reference: 'synthetic:positive-supervisor-witness',
	sha256: sha('synthetic-witness'),
};
afterEach(async () => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.mocked(execFileNoThrow).mockClear();
	for (const db of databases.splice(0)) if (db.db.open) db.close();
	await Promise.all(
		directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
	);
});
async function fixture(count = 8) {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pianola-transport-'));
	directories.push(directory);
	const file = path.join(directory, 'bank.sqlite');
	const db = new MemoryDatabase(file);
	databases.push(db);
	const config = {
		...db.config(),
		enabled: true,
		ongoing: false,
		tokenBudget: 1_000_000,
		dollarBudget: 100,
		roots: [
			{
				path: directory,
				provider: 'omp',
				userId: db.config().userId,
				enabled: true,
				authorship: 'human' as const,
			},
		],
	};
	db.set('config', config);
	db.set('paused', false);
	db.upsertSource({
		id: 'source',
		provider: 'omp',
		root: directory,
		host: 'local',
		sessionId: 'synthetic',
		projectId: 'project',
		projectPath: directory,
		filePath: path.join(directory, 'never-read.jsonl'),
		revision: 'synthetic',
		size: 1,
		modifiedAt: 1,
		userId: config.userId,
		authorship: 'human',
		cursor: 0,
		state: 'pending',
	});
	for (let i = 0; i < count; i++)
		db.enqueue(
			'job-' + i,
			'source',
			JSON.stringify({ id: 'job-' + i, evidence: [{ id: 'evidence-' + i }] })
		);
	const runtime = db.transport.registerOwner();
	const ownerBuild = () => (db.transport.status().owners[0] as { build_sha: string }).build_sha;
	const activate = (policy: MemoryTransportActivation['cohort']['policy'] = 'complete-lineage') => {
		const status = db.transport.status();
		db.transport.activate({
			bankId: status.bankId,
			fence: status.fence,
			configSha256: status.configSha256,
			legacySha256: status.legacySha256,
			releaseSha256: ownerBuild(),
			localDrain: proof,
			writerBoundary: proof,
			backup: proof,
			cohort: { policy, decision: proof },
		});
	};
	return { db, file, directory, runtime, activate };
}
function stage(
	db: MemoryDatabase,
	runtime: string,
	claim: string,
	kind: 'extract' | 'verify' = 'extract',
	authority = () => true
) {
	const job = db.claimQueued(claim, runtime);
	if (!job) return undefined;
	return db.db
		.transaction(() => {
			const reservation = 'reservation-' + claim;
			const scope = db.transport.begin(runtime, job.id, claim, kind, reservation, authority);
			if (!scope) throw new Error('Missing fixture capacity');
			db.reserve(reservation, 10, 1, db.config());
			return { scope, job, claim, reservation };
		})
		.immediate();
}
function release(db: MemoryDatabase, item: NonNullable<ReturnType<typeof stage>>) {
	item.scope.finish();
	db.releaseWork(item.job.id, item.claim);
	db.transport.endClaim(item.claim);
}

it.each([
	'server-error',
	'network-error',
	'truncated-429',
	'truncated-502',
	'truncated-524',
	'local-429',
	'local-502',
	'local-524',
])('does not retry %s', async (kind) => {
	const f = await fixture(1);
	const item = stage(f.db, f.runtime, 'not-retryable')!;
	vi.useFakeTimers();
	const send = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
		if (kind === 'network-error') throw new Error('connection lost');
		if (kind.startsWith('truncated-'))
			return new Response(
				new ReadableStream({
					start(controller) {
						controller.error(new Error('truncated'));
					},
				}),
				{ status: Number(kind.slice(-3)) }
			);
		return new Response('{}', {
			status: kind === 'server-error' ? 503 : Number(kind.slice(-3)),
		});
	});
	const url = kind.startsWith('local-')
		? 'http://localhost/api/chat'
		: 'https://api.nan.builders/v1/chat/completions';
	const outcome = item.scope.json(url, {}, 180000, 'hosted-chat').catch((error) => error);
	await vi.advanceTimersByTimeAsync(12500);
	expect(await outcome).toBeInstanceOf(Error);
	expect(send).toHaveBeenCalledTimes(1);
	if (kind === 'network-error' || kind.startsWith('truncated-')) {
		item.scope.finish();
		expect(f.db.transport.status().activePermits).toBe(1);
	} else release(f.db, item);
});

it('backs off received NaN 429, 502 and 524 errors without releasing any of the five transport slots', async () => {
	const f = await fixture(6);
	const items = Array.from({ length: 5 }, (_, i) => stage(f.db, f.runtime, 'backoff-' + i)!);
	const usage = f.db.db.prepare('SELECT * FROM usage ORDER BY id').all();
	vi.useFakeTimers();
	const statuses = [429, 502, 524];
	const send = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
		send.mock.calls.length <= 7
			? new Response('<html>Temporary gateway error</html>', {
					status: statuses[(send.mock.calls.length - 1) % statuses.length],
					headers: { 'content-type': 'text/html' },
				})
			: new Response('{"accepted":true}', { headers: { 'content-type': 'application/json' } })
	);
	const result = items[0].scope.json(
		'https://api.nan.builders/v1/chat/completions',
		{},
		180000,
		'hosted-chat'
	);
	const outcome = result.then(
		(value) => ({ value }),
		(error) => ({ error })
	);
	await vi.advanceTimersByTimeAsync(0);
	for (const [index, delay] of [500, 1000, 2000, 4000, 8000, 16000, 30000].entries()) {
		await vi.advanceTimersByTimeAsync(delay - 1);
		expect(send).toHaveBeenCalledTimes(index + 1);
		expect(f.db.transport.status().activePermits).toBe(5);
		expect(f.db.claimQueued('sixth-during-backoff', f.runtime)).toBeUndefined();
		await vi.advanceTimersByTimeAsync(1);
	}
	expect(await outcome).toEqual({ value: { status: 200, ok: true, data: { accepted: true } } });
	expect(f.db.db.prepare('SELECT * FROM usage ORDER BY id').all()).toEqual(usage);
	expect(
		f.db.db.prepare('SELECT status,terminal FROM memory_transport_requests ORDER BY rowid').all()
	).toEqual([
		...Array.from({ length: 7 }, (_, i) => ({
			status: statuses[i % statuses.length],
			terminal: 'body-eof',
		})),
		{ status: 200, terminal: 'body-eof' },
	]);
	for (const item of items) release(f.db, item);
});

it('stops after thirty shared NaN rate-limit and gateway retries', async () => {
	const f = await fixture(1);
	const item = stage(f.db, f.runtime, 'exhausted')!;
	vi.useFakeTimers();
	const send = vi
		.spyOn(globalThis, 'fetch')
		.mockImplementation(
			async () => new Response('{}', { status: [429, 502, 524][(send.mock.calls.length - 1) % 3] })
		);
	const outcome = item.scope
		.json('https://api.nan.builders/v1/chat/completions', {}, 180000, 'hosted-chat')
		.catch((error) => error);
	await vi.advanceTimersByTimeAsync(751500);
	expect(await outcome).toMatchObject({ status: 429, terminal: 'body-eof' });
	expect(send).toHaveBeenCalledTimes(31);
	release(f.db, item);
});

it.each(['fence', 'abort'])('does not send a retry after %s during backoff', async (reason) => {
	const f = await fixture(1);
	const item = stage(f.db, f.runtime, 'cancelled')!;
	const abort = new AbortController();
	vi.useFakeTimers();
	const send = vi
		.spyOn(globalThis, 'fetch')
		.mockImplementation(async () => new Response('<html>Gateway timeout</html>', { status: 524 }));
	const outcome = item.scope
		.json(
			'https://api.nan.builders/v1/chat/completions',
			{ signal: abort.signal },
			180000,
			'hosted-chat'
		)
		.catch((error) => error);
	await vi.advanceTimersByTimeAsync(0);
	if (reason === 'fence') f.db.transport.fence();
	else abort.abort();
	await vi.advanceTimersByTimeAsync(500);
	expect(await outcome).toBeInstanceOf(Error);
	expect(send).toHaveBeenCalledTimes(1);
	release(f.db, item);
});

it('lets newly registered idle owners resume a fully drained bank immediately', async () => {
	const f = await fixture(0);
	expect(f.db.transport.ready(f.runtime)).toBe(true);
	f.db.transport.fence();
	expect(f.db.transport.ready(f.runtime)).toBe(false);
	f.db.transport.drainOwner(f.runtime);
	const second = f.db.transport.registerOwner();
	expect(f.db.transport.ready(second)).toBe(true);
	f.db.transport.fence();
	f.db.transport.drainOwner(second);
	const third = f.db.transport.registerOwner();
	expect(f.db.transport.ready(third)).toBe(true);
});

it('shares five owned extraction/verification permits across connections and keeps the permit until body EOF', async () => {
	const f = await fixture();
	const other = new MemoryDatabase(f.file);
	databases.push(other);
	const otherRuntime = other.transport.registerOwner();
	const stages = Array.from(
		{ length: 5 },
		(_, i) =>
			stage(
				i % 2 ? other : f.db,
				i % 2 ? otherRuntime : f.runtime,
				'claim-' + i,
				i % 2 ? 'verify' : 'extract'
			)!
	);
	let finishBody!: () => void;
	vi.spyOn(globalThis, 'fetch').mockResolvedValue(
		new Response(
			new ReadableStream({
				start(controller) {
					finishBody = () => {
						controller.enqueue(new TextEncoder().encode('{}'));
						controller.close();
					};
				},
			}),
			{ headers: { 'content-type': 'application/json' } }
		)
	);
	const body = stages[0].scope.json('http://synthetic.invalid', {}, 1000, 'hosted-chat');
	await vi.waitFor(() =>
		expect(
			f.db.db
				.prepare('SELECT state FROM memory_transport_permits WHERE id=?')
				.get(stages[0].scope.id)
		).toEqual({ state: 'body' })
	);
	expect(other.claimQueued('sixth', otherRuntime)).toBeUndefined();
	expect(() => stages[0].scope.finish()).toThrow('cannot be ended');
	finishBody();
	await body;
	release(f.db, stages[0]);
	const next = stage(other, otherRuntime, 'after-eof', 'verify')!;
	expect(f.db.transport.status().activePermits).toBe(5);
	expect(next.scope.id).not.toBe(stages[0].scope.id);
	release(other, next);
	for (let i = 1; i < stages.length; i++) release(i % 2 ? other : f.db, stages[i]);
});

it('rejects late sends after a fence, lost claim, changed settings or revoked source authority before fetch', async () => {
	for (const reason of ['fence', 'claim', 'config', 'source']) {
		const f = await fixture(1);
		let permitted = true;
		const item = stage(f.db, f.runtime, 'late-' + reason, 'extract', () => permitted)!;
		const send = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Forbidden network'));
		if (reason === 'fence') f.db.transport.fence();
		if (reason === 'claim')
			f.db.db.prepare('UPDATE ingestion_work SET owner=? WHERE id=?').run('intruder', item.job.id);
		if (reason === 'config')
			f.db.set('config', { ...f.db.config(), model: 'changed-synthetic-model' });
		if (reason === 'source') permitted = false;
		await expect(
			item.scope.json('http://synthetic.invalid', {}, 1000, 'hosted-chat')
		).rejects.toThrow(/admission closed|Late send rejected/);
		expect(send).not.toHaveBeenCalled();
		item.scope.finish();
		send.mockRestore();
	}
});

it('retains unknown physical transports through restart and does not steal capacity by age or a new owner', async () => {
	const f = await fixture(6);
	vi.spyOn(globalThis, 'fetch').mockRejectedValue(
		new Error('private transport details must not escape')
	);
	for (let i = 0; i < 5; i++) {
		const item = stage(f.db, f.runtime, 'unknown-' + i)!;
		await expect(
			item.scope.json('http://synthetic.invalid', {}, 1000, 'hosted-chat')
		).rejects.toThrow('terminal=unproven-close');
		item.scope.finish();
		f.db.transport.endClaim(item.claim, true);
	}
	const rows = f.db.db.prepare('SELECT * FROM memory_transport_permits ORDER BY id').all();
	const usage = f.db.db.prepare('SELECT * FROM usage ORDER BY id').all();
	f.db.close();
	const restart = new MemoryDatabase(f.file);
	databases.push(restart);
	const runtime = restart.transport.registerOwner();
	expect(restart.claimQueued('new-epoch-worker', runtime)).toBeUndefined();
	expect(restart.db.prepare('SELECT * FROM memory_transport_permits ORDER BY id').all()).toEqual(
		rows
	);
	expect(restart.db.prepare('SELECT * FROM usage ORDER BY id').all()).toEqual(usage);
	restart.transport.fence();
	expect(() => restart.transport.drainOwner(runtime)).not.toThrow();
	expect(() => restart.transport.drainOwner(f.runtime)).toThrow('no positive terminal evidence');
	expect(restart.transport.status().activePermits).toBe(5);
});

it('separates immutable historical debt from five new permits only after positive drain and exact per-job lineage', async () => {
	const f = await fixture(0);
	const raw = JSON.stringify({ id: 'legacy-eligible', evidence: [{ id: 'legacy-span' }] });
	f.db.db
		.prepare('INSERT INTO ingestion_queue(id,source_id,data) VALUES(?,?,?)')
		.run('legacy-eligible', 'source', raw);
	const historicalTokens = [17103, 22695, 25000, 25000, 25000, 25000, 23487];
	for (let i = 0; i < historicalTokens.length; i++)
		f.db.db
			.prepare('INSERT INTO usage VALUES(?,?,?,?,?,?,?)')
			.run('historical-' + i, 0, 0, 0, historicalTokens[i], 0, 'uncertain');
	const before = f.db.db.prepare('SELECT * FROM usage ORDER BY id').all();
	expect(f.db.totals().reservedTokens).toBe(163285);
	f.db.transport.fence();
	expect(() => f.activate()).toThrow('positively drain');
	f.db.transport.drainOwner(f.runtime);
	f.activate();
	expect(f.db.claimQueued('no-proof', f.runtime)).toBeUndefined();
	expect(() =>
		f.db.transport.admit({
			jobId: 'legacy-eligible',
			payloadSha256: sha(raw + 'changed'),
			kind: 'never-submitted',
			evidence: proof,
		})
	).toThrow('exact original');
	f.db.transport.admit({
		jobId: 'legacy-eligible',
		payloadSha256: sha(raw),
		kind: 'never-submitted',
		evidence: proof,
	});
	const item = stage(f.db, f.runtime, 'approved-new-stage')!;
	expect(item.job.id).toBe('legacy-eligible');
	expect(f.db.totals().reservedTokens).toBe(
		before.reduce((sum, row: any) => sum + row.reserved_tokens, 0) + 11
	);
	expect(() =>
		f.db.db.prepare("UPDATE usage SET state='settled' WHERE id='historical-0'").run()
	).toThrow('immutable');
	expect(() => f.db.db.prepare('DELETE FROM usage WHERE id=?').run('historical-0')).toThrow(
		'immutable'
	);
	expect(() =>
		f.db.db.prepare('UPDATE ingestion_queue SET data=? WHERE id=?').run('{}', 'legacy-eligible')
	).toThrow('immutable');
	expect(
		f.db.db.prepare("SELECT * FROM usage WHERE id LIKE 'historical-%' ORDER BY id").all()
	).toEqual(before);
	release(f.db, item);
});

it('does not use an implicit old-cohort hold decision or admit known sent, completed, quarantined or relabeled evidence', async () => {
	const f = await fixture(0);
	const add = (id: string, extra = {}) => {
		const raw = JSON.stringify({ id, evidence: [{ id: 'span-' + id }], ...extra });
		f.db.db
			.prepare('INSERT INTO ingestion_queue(id,source_id,data) VALUES(?,?,?)')
			.run(id, 'source', raw);
		return raw;
	};
	const sent = add('sent', { sent: true, reservation: 'old-charge' });
	const held = add('held');
	const quarantined = add('quarantined');
	f.db.quarantineExtraction('quarantined', 'Synthetic quarantine');
	f.db.transport.fence();
	f.db.transport.drainOwner(f.runtime);
	f.activate('hold-ambiguous-legacy');
	expect(() =>
		f.db.transport.admit({
			jobId: 'held',
			payloadSha256: sha(held),
			kind: 'never-submitted',
			evidence: proof,
		})
	).toThrow('activation');
	const copied = JSON.stringify({ id: 'new-id', evidence: [{ id: 'span-held' }] });
	f.db.enqueue('new-id', 'source', copied);
	expect(f.db.transport.ready(f.runtime)).toBe(false);
	f.db.transport.fence();
	f.db.transport.drainOwner(f.runtime);
	f.activate();
	expect(() =>
		f.db.transport.admit({
			jobId: 'sent',
			payloadSha256: sha(sent),
			kind: 'never-submitted',
			evidence: proof,
		})
	).toThrow('uncertain');
	expect(() =>
		f.db.transport.admit({
			jobId: 'quarantined',
			payloadSha256: sha(quarantined),
			kind: 'never-submitted',
			evidence: proof,
		})
	).toThrow('quarantined');
	expect(() =>
		f.db.transport.admit({
			jobId: 'new-id',
			payloadSha256: sha(copied),
			kind: 'never-submitted',
			evidence: proof,
		})
	).toThrow('uncertain');
});

it('rolls back new permit admission when immutable old debt exhausts the unchanged token budget', async () => {
	const f = await fixture(1);
	f.db.db
		.prepare('INSERT INTO usage VALUES(?,?,?,?,?,?,?)')
		.run('old-budget-charge', 0, 0, 0, 17103, 0, 'uncertain');
	f.db.set('config', { ...f.db.config(), tokenBudget: 17110 });
	f.db.transport.fence();
	f.db.transport.drainOwner(f.runtime);
	f.activate();
	const before = f.db.db.prepare('SELECT * FROM usage').all();
	expect(() => stage(f.db, f.runtime, 'over-budget')).toThrow('budget reached');
	expect(f.db.db.prepare('SELECT * FROM usage').all()).toEqual(before);
	expect(f.db.transport.status().activePermits).toBe(0);
});

it('records sanitized HTML HTTP failure only after body EOF, without a model usage receipt', async () => {
	const f = await fixture(1);
	const item = stage(f.db, f.runtime, 'html-response')!;
	vi.spyOn(globalThis, 'fetch').mockResolvedValue(
		new Response('<!DOCTYPE html> private proxy body credential=secret', {
			status: 502,
			headers: { 'content-type': 'text/html; private=secret' },
		})
	);
	await expect(
		item.scope.json('http://synthetic.invalid/private', {}, 1000, 'hosted-chat')
	).rejects.toThrow('status=502, type=text/html, terminal=body-eof');
	item.scope.finish();
	expect(
		f.db.db
			.prepare('SELECT state,status,content_type,terminal FROM memory_transport_requests')
			.get()
	).toEqual({ state: 'ended', status: 502, content_type: 'text/html', terminal: 'body-eof' });
	expect(f.db.db.prepare('SELECT state,reserved_tokens FROM usage').get()).toEqual({
		state: 'reserved',
		reserved_tokens: 11,
	});
	expect(f.db.transport.status().activePermits).toBe(0);
});

it('restores a verified SQLite backup including committed WAL state and all immutable transport/debt records', async () => {
	const f = await fixture(1);
	const item = stage(f.db, f.runtime, 'backup-stage')!;
	const snapshot = f.db.db.prepare('SELECT * FROM ingestion_queue').all();
	const permits = f.db.db.prepare('SELECT * FROM memory_transport_permits').all();
	const backup = path.join(f.directory, 'verified-backup.sqlite');
	await f.db.db.backup(backup);
	const restored = new MemoryDatabase(backup);
	databases.push(restored);
	expect(restored.db.pragma('integrity_check', { simple: true })).toBe('ok');
	expect(restored.db.prepare('SELECT * FROM ingestion_queue').all()).toEqual(snapshot);
	expect(restored.db.prepare('SELECT * FROM memory_transport_permits').all()).toEqual(permits);
	expect(restored.totals()).toEqual(f.db.totals());
	expect(restored.transport.status().activePermits).toBe(1);
	item.scope.finish();
});

it('requires the current runtime to own its claim and isolates unexpected sent pending metadata without rewriting it', async () => {
	const f = await fixture(1);
	const other = f.db.transport.registerOwner();
	const claimed = f.db.claimQueued('runtime-claim', f.runtime)!;
	expect(() =>
		f.db.db
			.transaction(() =>
				f.db.transport.begin(
					other,
					claimed.id,
					'runtime-claim',
					'extract',
					'foreign-charge',
					() => true
				)
			)
			.immediate()
	).toThrow('authority lost');
	f.db.releaseWork(claimed.id, 'runtime-claim');
	f.db.transport.endClaim('runtime-claim');
	const pending = { id: claimed.id, sent: true, reservation: 'older-unknown-charge' };
	f.db.set('pendingExtraction', pending);
	expect(f.db.transport.ready(f.runtime)).toBe(false);
	f.db.transport.fence();
	f.db.transport.drainOwner(f.runtime);
	f.db.transport.drainOwner(other);
	f.activate();
	expect(f.db.claimQueued('cannot-replay', f.runtime)).toBeUndefined();
	expect(f.db.get('pendingExtraction')).toEqual(pending);
	expect(() => f.db.set('pendingExtraction', null)).toThrow('immutable');
});

it('does not fabricate API charges for CLI extraction', async () => {
	const f = await fixture(1);
	const config = {
		...f.db.config(),
		mode: 'cli' as const,
		cliProvider: 'codex' as const,
		cliPath: 'C:\\tools\\codex.cmd',
		inputPrice: 100,
		outputPrice: 100,
	};
	f.db.reserve('cli-zero-price', 100, 50, config);
	expect(f.db.totals().reservedDollars).toBe(0);
	f.db.settle('cli-zero-price', 100, 50, config);
	expect(f.db.totals().dollars).toBe(0);
});

it('records a completed CLI process as terminal transport evidence', async () => {
	const f = await fixture(1);
	const item = stage(f.db, f.runtime, 'cli-complete')!;
	vi.mocked(execFileNoThrow).mockResolvedValue({ stdout: '{}', stderr: '', exitCode: 0 });
	await expect(
		item.scope.cli(
			{ command: 'C:\\tools\\claude.exe', args: [], input: '{}', contentType: 'application/json' },
			1000,
			'cli-extract'
		)
	).resolves.toBe('{}');
	expect(
		f.db.db
			.prepare('SELECT state,status,terminal FROM memory_transport_requests WHERE operation=?')
			.get('cli-extract')
	).toEqual({ state: 'ended', status: 0, terminal: 'process-exit' });
	const [, , workspace] = vi.mocked(execFileNoThrow).mock.calls[0];
	expect(workspace).toMatch(/maestro-memory-cli-/);
	await expect(fs.stat(workspace!)).rejects.toThrow();
	release(f.db, item);
});

it.skipIf(process.platform !== 'win32')(
	'quotes a Windows shim and escapes fixed arguments without touching stdin',
	async () => {
		const f = await fixture(1);
		const item = stage(f.db, f.runtime, 'cli-windows-shim')!;
		vi.mocked(execFileNoThrow).mockResolvedValue({ stdout: '{}', stderr: '', exitCode: 0 });
		await item.scope.cli(
			{
				command: 'C:\\Program Files\\Codex\\codex.cmd',
				args: ['--flag', 'fixed value'],
				input: '{"memories":[]}',
				contentType: 'application/jsonl',
			},
			1000,
			'cli-extract'
		);
		const [command, args, , options] = vi.mocked(execFileNoThrow).mock.calls[0];
		expect(command).toBe('"C:\\Program Files\\Codex\\codex.cmd"');
		expect(args).toEqual(['--flag', '"fixed value"']);
		expect(options).toMatchObject({ input: '{"memories":[]}' });
		expect(options.env?.PATH).toContain('C:\\Program Files\\Codex');
		release(f.db, item);
	}
);

it.skipIf(process.platform !== 'win32')(
	'refuses prompt argv that cmd.exe cannot preserve',
	async () => {
		const f = await fixture(1);
		const item = stage(f.db, f.runtime, 'cli-unsafe-argv')!;
		const prompt = 'first line\nsecond line';
		await expect(
			item.scope.cli(
				{
					command: 'C:\\tools\\agy.cmd',
					args: ['-p', prompt],
					promptArgs: [prompt],
					input: '',
					contentType: 'application/jsonl',
				},
				1000,
				'cli-extract'
			)
		).rejects.toThrow('line break');
		expect(execFileNoThrow).not.toHaveBeenCalled();
		item.scope.finish();
	}
);

it.skipIf(process.platform !== 'win32')(
	'rejects an oversized positional prompt before submission',
	async () => {
		const f = await fixture(1);
		const item = stage(f.db, f.runtime, 'cli-oversized-argv')!;
		const prompt = 'x'.repeat(32_768);
		await expect(
			item.scope.cli(
				{
					command: 'C:\\tools\\omp.exe',
					args: ['--', prompt],
					promptArgs: [prompt],
					input: '',
					contentType: 'application/jsonl',
				},
				1000,
				'cli-extract'
			)
		).rejects.toThrow('operating system command-line limit');
		expect(execFileNoThrow).not.toHaveBeenCalled();
		item.scope.finish();
	}
);

it.skipIf(process.platform === 'win32')(
	'rejects an oversized POSIX prompt before submission',
	async () => {
		const f = await fixture(1);
		const item = stage(f.db, f.runtime, 'cli-oversized-posix')!;
		const prompt = 'x'.repeat(100_001);
		await expect(
			item.scope.cli(
				{
					command: '/usr/bin/omp',
					args: ['--', prompt],
					promptArgs: [prompt],
					input: '',
					contentType: 'application/jsonl',
				},
				1000,
				'cli-extract'
			)
		).rejects.toThrow('operating system command-line limit');
		expect(execFileNoThrow).not.toHaveBeenCalled();
		item.scope.finish();
	}
);

it('does not launch after authority is revoked during workspace creation', async () => {
	const f = await fixture(1);
	let permitted = true;
	const item = stage(f.db, f.runtime, 'cli-admission-race', 'extract', () => permitted)!;
	const realMkdtemp = fs.mkdtemp;
	let finishWorkspace!: () => void;
	const created = vi.spyOn(fs, 'mkdtemp').mockImplementation(
		(...args: Parameters<typeof fs.mkdtemp>) =>
			new Promise((resolve) => {
				finishWorkspace = () => resolve(realMkdtemp(...args));
			}) as ReturnType<typeof fs.mkdtemp>
	);
	const outcome = item.scope.cli(
		{ command: 'C:\\tools\\claude.exe', args: [], input: '{}', contentType: 'application/json' },
		1000,
		'cli-extract'
	);
	await vi.waitFor(() => expect(created).toHaveBeenCalled());
	permitted = false;
	finishWorkspace();
	await expect(outcome).rejects.toThrow('unproven-close');
	expect(execFileNoThrow).not.toHaveBeenCalled();
	release(f.db, item);
});

it('keeps a timed-out CLI submission uncertain instead of releasing it for replay', async () => {
	const f = await fixture(1);
	const item = stage(f.db, f.runtime, 'cli-timeout')!;
	vi.mocked(execFileNoThrow).mockResolvedValue({
		stdout: '',
		stderr: 'ETIMEDOUT',
		exitCode: 'ETIMEDOUT',
	});
	await expect(
		item.scope.cli(
			{ command: 'C:\\tools\\omp.exe', args: [], input: '{}', contentType: 'application/jsonl' },
			1000,
			'cli-extract'
		)
	).rejects.toThrow('unproven-close');
	item.scope.finish();
	expect(f.db.transport.status().activePermits).toBe(1);
	expect(
		f.db.db
			.prepare('SELECT state,terminal FROM memory_transport_requests WHERE operation=?')
			.get('cli-extract')
	).toEqual({ state: 'unknown', terminal: 'unproven-close' });
});

// The memory CLI child under management (MCOMP-33-00H). The worker asks the
// main thread over a real MessageChannel; the main end admits through the REAL
// lease authority behind `fakeSpawnPort` (only the policy answer is a table).
describe('memory CLI admission on a managed host', () => {
	const channels: MessageChannel[] = [];
	afterEach(() => {
		setMemoryCliAdmitter(null);
		for (const channel of channels.splice(0)) {
			channel.port1.close();
			channel.port2.close();
		}
	});
	function admitThrough(port: FakeSpawnPort | null) {
		const channel = new MessageChannel();
		channels.push(channel);
		serveMemoryCliAdmission(channel.port1, () => port);
		setMemoryCliAdmitter(memoryCliAdmissionClient(channel.port2));
	}
	const invocation = {
		command: '/usr/bin/omp',
		args: ['--json'],
		input: '{}',
		contentType: 'application/jsonl',
	};

	it('refuses a launch the managed host does not admit, before the permit opens, and starts nothing', async () => {
		const f = await fixture(1);
		const item = stage(f.db, f.runtime, 'cli-managed-denied')!;
		const port = fakeSpawnPort({
			decide: () => ({ decision: 'deny', reason: 'no backfill here', policyRevision: 3 }),
		});
		admitThrough(port);
		await expect(item.scope.cli(invocation, 1000, 'cli-extract')).rejects.toThrow('managed-denied');
		expect(execFileNoThrow).not.toHaveBeenCalled();
		expect(port.asked).toHaveLength(1);
		expect(port.asked[0].snapshot).toMatchObject({
			provider: `maestro-supervisor:${PIANOLA_MEMORY_SERVICE}`,
			purpose: 'supervisor',
			operation: 'start',
		});
		expect(port.authority.live()).toHaveLength(0);
		// Nothing was sent, so nothing is uncertain and the permit is released normally.
		expect(f.db.db.prepare('SELECT COUNT(*) n FROM memory_transport_requests').get()).toEqual({
			n: 0,
		});
		release(f.db, item);
	});

	it('admits the exact launch, binds the lease before the spawn and releases it with the exit', async () => {
		const f = await fixture(1);
		const item = stage(f.db, f.runtime, 'cli-managed-admitted')!;
		const port = fakeSpawnPort();
		admitThrough(port);
		let leaseAtSpawn: string | undefined;
		vi.mocked(execFileNoThrow).mockImplementation(async () => {
			leaseAtSpawn = port.authority.live()[0]?.state();
			return { stdout: '{}', stderr: '', exitCode: 0 };
		});
		await expect(item.scope.cli(invocation, 1000, 'cli-extract')).resolves.toBe('{}');
		expect(leaseAtSpawn).toBe('bound');
		const [command, args, workspace, options] = vi.mocked(execFileNoThrow).mock.calls[0];
		expect(port.asked).toHaveLength(1);
		expect(port.asked[0].snapshot.executable).toBe(command);
		expect(port.asked[0].snapshot.cwd).toBe(workspace);
		expect(args).toEqual(['--json']);
		expect(options).toMatchObject({ input: '{}' });
		await vi.waitFor(() => expect(port.authority.live()).toHaveLength(0));
		release(f.db, item);
	});

	it('withdraws an admitted lease when the permit cannot open, and launches nothing', async () => {
		const f = await fixture(1);
		let permitted = true;
		const item = stage(f.db, f.runtime, 'cli-managed-withdrawn', 'extract', () => permitted)!;
		permitted = false;
		const port = fakeSpawnPort();
		admitThrough(port);
		await expect(item.scope.cli(invocation, 1000, 'cli-extract')).rejects.toThrow('unproven-close');
		expect(execFileNoThrow).not.toHaveBeenCalled();
		expect(port.asked).toHaveLength(1);
		await vi.waitFor(() => expect(port.authority.live()).toHaveLength(0));
		release(f.db, item);
	});

	it('asks nobody on a standalone host and launches as before', async () => {
		const f = await fixture(1);
		const item = stage(f.db, f.runtime, 'cli-standalone')!;
		const port = fakeSpawnPort({ standing: 'standalone' });
		admitThrough(port);
		vi.mocked(execFileNoThrow).mockResolvedValue({ stdout: '{}', stderr: '', exitCode: 0 });
		await expect(item.scope.cli(invocation, 1000, 'cli-extract')).resolves.toBe('{}');
		expect(port.asked).toHaveLength(0);
		expect(execFileNoThrow).toHaveBeenCalledTimes(1);
		release(f.db, item);
	});
});

// The hosted memory providers under management (MCOMP-33-00L2). The worker asks
// the main thread over a real MessageChannel; the main end holds the URL on the
// REAL fetch chokepoint behind an installed egress authority.
describe('hosted memory egress on a managed host', () => {
	const channels: MessageChannel[] = [];
	const nan = 'https://api.nan.builders/v1/chat/completions';
	afterEach(() => {
		setEgressAuthority(null);
		setMemoryEgressHolder(null);
		for (const channel of channels.splice(0)) {
			channel.port1.close();
			channel.port2.close();
		}
	});
	function holdThroughChannel() {
		const channel = new MessageChannel();
		channels.push(channel);
		serveMemoryCliAdmission(channel.port1, () => null);
		setMemoryEgressHolder(memoryEgressClient(channel.port2));
	}

	it('refuses a hosted request by name before the permit opens, and sends nothing', async () => {
		const f = await fixture(1);
		const item = stage(f.db, f.runtime, 'egress-denied')!;
		const ceiling = denyingEgressAuthority('unavailable');
		setEgressAuthority(ceiling.authority);
		holdThroughChannel();
		const send = vi.spyOn(globalThis, 'fetch');
		await expect(item.scope.json(nan, {}, 1000, 'hosted-chat')).rejects.toThrow(
			'managed-unavailable'
		);
		expect(send).not.toHaveBeenCalled();
		expect(ceiling.requests).toEqual([{ url: nan, class: MEMORY_EGRESS_CLASS }]);
		expect(heldEgress()).toEqual([
			expect.objectContaining({ class: 'content', code: 'unavailable' }),
		]);
		// Nothing was sent, so nothing is uncertain and the permit is released normally.
		expect(f.db.db.prepare('SELECT COUNT(*) n FROM memory_transport_requests').get()).toEqual({
			n: 0,
		});
		release(f.db, item);
	});

	it('holds every physical retry, and a destination the ceiling lists leaves', async () => {
		const f = await fixture(1);
		const item = stage(f.db, f.runtime, 'egress-admitted')!;
		const ceiling = managedEgressAuthority([
			{ class: 'content', destinations: ['api.nan.builders'] },
		]);
		setEgressAuthority(ceiling.authority);
		holdThroughChannel();
		const send = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(new Response('{}', { status: 429 }))
			.mockResolvedValueOnce(
				new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } })
			);
		// One real 500ms backoff: the hold answers cross a real MessageChannel.
		await expect(item.scope.json(nan, {}, 1000, 'hosted-chat')).resolves.toMatchObject({
			status: 200,
			data: { ok: true },
		});
		expect(send).toHaveBeenCalledTimes(2);
		expect(ceiling.requests).toHaveLength(2);
		release(f.db, item);
	});

	it('refuses a destination the ceiling does not list', async () => {
		const f = await fixture(1);
		const item = stage(f.db, f.runtime, 'egress-elsewhere')!;
		setEgressAuthority(
			managedEgressAuthority([{ class: 'content', destinations: ['api.openai.com'] }]).authority
		);
		holdThroughChannel();
		const send = vi.spyOn(globalThis, 'fetch');
		await expect(item.scope.json(nan, {}, 1000, 'hosted-chat')).rejects.toThrow(
			'managed-destination-denied'
		);
		expect(send).not.toHaveBeenCalled();
		release(f.db, item);
	});

	it('holds on the local chokepoint when no channel was handed over', async () => {
		const f = await fixture(1);
		const item = stage(f.db, f.runtime, 'egress-local')!;
		setEgressAuthority(denyingEgressAuthority().authority);
		const send = vi.spyOn(globalThis, 'fetch');
		await expect(item.scope.json(nan, {}, 1000, 'hosted-chat')).rejects.toThrow(
			'managed-class-denied'
		);
		expect(send).not.toHaveBeenCalled();
		release(f.db, item);
	});

	it('asks nothing of a standalone host and sends as before', async () => {
		const f = await fixture(1);
		const item = stage(f.db, f.runtime, 'egress-standalone')!;
		holdThroughChannel();
		const send = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(new Response('{}', { headers: { 'content-type': 'application/json' } }));
		await expect(item.scope.json(nan, {}, 1000, 'hosted-chat')).resolves.toMatchObject({
			status: 200,
		});
		expect(send).toHaveBeenCalledTimes(1);
		release(f.db, item);
	});
});
