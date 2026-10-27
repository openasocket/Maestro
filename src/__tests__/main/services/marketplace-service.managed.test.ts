/**
 * The marketplace import under the install ceiling (MRC2-04-08A), over the
 * real service and the real policy source with a mocked network and
 * filesystem: standalone an import fetches and writes as before, digesting
 * nothing; enrolled with no ceiling it is refused `unavailable` before a
 * request, a directory or a write; a ceiling that pins only some files refuses
 * the rest `unpinned` with no request; other bytes refuse `digest-mismatch`
 * after the fetch with no write; a fully pinned import fetches every file from
 * its exact URL and writes everything; a local playbook's files are read in
 * place and held by digest. A refused import changes no file.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import path from 'path';
import type { App } from 'electron';

vi.mock('fs/promises', () => {
	const api = {
		readFile: vi.fn(),
		writeFile: vi.fn(),
		mkdir: vi.fn(),
		readdir: vi.fn(),
		stat: vi.fn(),
	};
	return { default: api, ...api };
});
vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../../../main/utils/fetchWithTimeout', () => ({ fetchWithTimeout: vi.fn() }));
vi.mock('../../../main/utils/remote-fs', () => ({
	writeFileRemote: vi.fn(),
	mkdirRemote: vi.fn(),
}));

import fs from 'fs/promises';
import { fetchWithTimeout } from '../../../main/utils/fetchWithTimeout';
import { createInstallPolicySource } from '../../../main/enterprise/install-policy';
import type { IdentityRead } from '../../../main/enterprise/identity-store';
import {
	importMarketplacePlaybook,
	setMarketplaceInstallAuthority,
} from '../../../main/services/marketplace-service';

const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const none: IdentityRead = { status: 'none' };
const enrolled: IdentityRead = { status: 'ok', record: {} as never, epoch: 1 };
const RAW = 'https://raw.githubusercontent.com/RunMaestro/Maestro-Playbooks/main';
const USER_DATA = '/mock/userData';
const AUTO_RUN = '/auto-run';
const TARGET = path.join(AUTO_RUN, 'Imported');

const DOC_1 = '# Phase 1\n\n- [ ] first task\n';
const DOC_2 = '# Phase 2\n\n- [ ] second task\n';
const ASSET = Buffer.from('PNG bytes of a diagram');
const LOCAL_DOC = '# Local\n\n- [ ] local task\n';

const playbook = {
	id: 'pb-1',
	title: 'Release Checklist',
	description: 'd',
	category: 'Development',
	author: 'a',
	lastUpdated: '2026-01-01',
	path: 'playbooks/release-checklist',
	documents: [
		{ filename: 'phase-1', resetOnCompletion: false },
		{ filename: 'phase-2', resetOnCompletion: true },
	],
	assets: ['diagram.png'],
	loopEnabled: false,
	prompt: 'Go',
};
const localPlaybook = {
	...playbook,
	id: 'local-1',
	title: 'Local Playbook',
	path: '/playbooks/local',
	documents: [{ filename: 'local', resetOnCompletion: false }],
	assets: [],
};
const DOC_1_URL = `${RAW}/${playbook.path}/phase-1.md`;
const DOC_2_URL = `${RAW}/${playbook.path}/phase-2.md`;
const ASSET_URL = `${RAW}/${playbook.path}/assets/diagram.png`;

const app = { getPath: () => USER_DATA, getVersion: () => '1.0.0' } as unknown as App;
const enoent = () => Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });

/** The filesystem by path: the cache, the local manifest, the local playbook's document; the rest is absent. */
function disk(files: Record<string, string>): void {
	vi.mocked(fs.readFile).mockImplementation(async (file) => {
		const body = files[String(file)];
		if (body === undefined) throw enoent();
		return body;
	});
	vi.mocked(fs.readdir).mockRejectedValue(enoent());
}

/** `fetchWithTimeout` answering by URL: a text body, bytes, or a 404. */
function serve(routes: Record<string, string | Buffer>): string[] {
	const urls: string[] = [];
	vi.mocked(fetchWithTimeout).mockImplementation(async (url) => {
		urls.push(String(url));
		const body = routes[String(url)];
		if (body === undefined)
			return { ok: false, status: 404, statusText: 'Not Found' } as unknown as Response;
		return {
			ok: true,
			status: 200,
			statusText: 'OK',
			text: async () => String(body),
			arrayBuffer: async () => {
				const bytes = Buffer.from(body);
				return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
			},
		} as unknown as Response;
	});
	return urls;
}

const written = () => vi.mocked(fs.writeFile).mock.calls.map((call) => String(call[0]));
const pin = (file: string, bytes: string | Buffer, source: string | null) => ({
	artifact: 'marketplace-playbooks',
	file,
	sha256: sha(bytes),
	source,
});
const allPins = (doc1 = DOC_1) => [
	pin('phase-1.md', doc1, DOC_1_URL),
	pin('phase-2.md', DOC_2, DOC_2_URL),
	pin('diagram.png', ASSET, ASSET_URL),
];
const routes = () => ({ [DOC_1_URL]: DOC_1, [DOC_2_URL]: DOC_2, [ASSET_URL]: ASSET });
const cache = () =>
	JSON.stringify({
		fetchedAt: Date.now(),
		manifest: { lastUpdated: '2026-01-01', playbooks: [playbook] },
	});
const localManifest = () =>
	JSON.stringify({ lastUpdated: '2026-01-01', playbooks: [localPlaybook] });

const importOf = (playbookId = 'pb-1') =>
	importMarketplacePlaybook({
		app,
		playbookId,
		targetFolderName: 'Imported',
		autoRunFolderPath: AUTO_RUN,
		sessionId: 'session-1',
	});

describe('marketplace import under the install ceiling', () => {
	let read: IdentityRead;
	let source: ReturnType<typeof createInstallPolicySource>;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(fetchWithTimeout).mockReset();
		vi.mocked(fs.mkdir).mockResolvedValue(undefined);
		vi.mocked(fs.writeFile).mockResolvedValue(undefined);
		disk({ [path.join(USER_DATA, 'marketplace-cache.json')]: cache() });
		read = none;
		source = createInstallPolicySource({
			identity: { read: () => read },
			policy: () => ({ appliedRevision: 3 }),
		});
		setMarketplaceInstallAuthority(source);
	});

	it('standalone: fetches every file and writes the documents, the asset and the playbook', async () => {
		const urls = serve(routes());

		const result = await importOf();

		expect(urls).toEqual([DOC_1_URL, DOC_2_URL, ASSET_URL]);
		expect(fs.mkdir).toHaveBeenCalledWith(TARGET, { recursive: true });
		expect(written()).toEqual([
			path.join(TARGET, 'phase-1.md'),
			path.join(TARGET, 'phase-2.md'),
			path.join(TARGET, 'assets', 'diagram.png'),
			path.join(USER_DATA, 'playbooks', 'session-1.json'),
		]);
		expect(result.importedDocs).toEqual(['phase-1', 'phase-2']);
		expect(result.importedAssets).toEqual(['diagram.png']);
		expect(result.playbook.documents.map((d) => d.filename)).toEqual([
			'Imported/phase-1',
			'Imported/phase-2',
		]);
	});

	it('standalone: one unreachable document is still skipped, not fatal', async () => {
		const urls = serve({ [DOC_2_URL]: DOC_2, [ASSET_URL]: ASSET });

		const result = await importOf();

		expect(urls).toEqual([DOC_1_URL, DOC_2_URL, ASSET_URL]);
		expect(result.importedDocs).toEqual(['phase-2']);
		expect(written()).not.toContain(path.join(TARGET, 'phase-1.md'));
	});

	it('enrolled with no ceiling: refused unavailable before any request, directory or write', async () => {
		read = enrolled;
		const urls = serve(routes());

		await expect(importOf()).rejects.toThrow(
			/^\[managed-unavailable\] the managed install ceiling is unavailable \(no install ceiling is installed for policy revision 3\)$/
		);

		expect(urls).toEqual([]);
		expect(fs.mkdir).not.toHaveBeenCalled();
		expect(fs.writeFile).not.toHaveBeenCalled();
	});

	it('a ceiling that pins the documents but not the asset: refused unpinned with no request', async () => {
		read = enrolled;
		source.install({ policyRevision: 3, pins: allPins().slice(0, 2) });
		const urls = serve(routes());

		await expect(importOf()).rejects.toThrow(
			/^\[managed-unpinned\] the install ceiling pins no marketplace-playbooks diagram\.png from https:\/\/raw\.githubusercontent\.com\/RunMaestro\/Maestro-Playbooks\/main\/playbooks\/release-checklist\/assets\/diagram\.png; for the operator only/
		);

		expect(urls).toEqual([]);
		expect(fs.mkdir).not.toHaveBeenCalled();
		expect(fs.writeFile).not.toHaveBeenCalled();
	});

	it('other bytes than pinned: refused digest-mismatch after the fetch, nothing written', async () => {
		read = enrolled;
		source.install({ policyRevision: 3, pins: allPins(`${DOC_1}changed\n`) });
		const urls = serve(routes());

		await expect(importOf()).rejects.toThrow(
			/^\[managed-digest-mismatch\] the bytes of marketplace-playbooks phase-1\.md \(sha256 [a-f0-9]{64}\) are not the pinned ones/
		);

		expect(urls).toEqual([DOC_1_URL]);
		expect(fs.mkdir).not.toHaveBeenCalled();
		expect(fs.writeFile).not.toHaveBeenCalled();
	});

	it('every file pinned: fetched from the exact URLs and written, as the transport named', async () => {
		read = enrolled;
		source.install({ policyRevision: 3, pins: allPins() });
		const urls = serve(routes());

		const result = await importMarketplacePlaybook({
			app,
			playbookId: 'pb-1',
			targetFolderName: 'Imported',
			autoRunFolderPath: AUTO_RUN,
			sessionId: 'session-1',
			actor: { kind: 'transport', actor: { peer: 'host-secret' } },
		});

		expect(urls).toEqual([DOC_1_URL, DOC_2_URL, ASSET_URL]);
		expect(written()).toEqual([
			path.join(TARGET, 'phase-1.md'),
			path.join(TARGET, 'phase-2.md'),
			path.join(TARGET, 'assets', 'diagram.png'),
			path.join(USER_DATA, 'playbooks', 'session-1.json'),
		]);
		expect(result.importedAssets).toEqual(['diagram.png']);
	});

	it('a local playbook: read in place, held by digest, refused unpinned with no write', async () => {
		read = enrolled;
		disk({
			[path.join(USER_DATA, 'marketplace-cache.json')]: cache(),
			[path.join(USER_DATA, 'local-manifest.json')]: localManifest(),
			[path.join('/playbooks/local', 'local.md')]: LOCAL_DOC,
		});
		const urls = serve({});
		source.install({ policyRevision: 3, pins: allPins() });

		await expect(importOf('local-1')).rejects.toThrow(
			/^\[managed-unpinned\] the install ceiling pins no marketplace-playbooks local\.md; for the operator only/
		);
		expect(urls).toEqual([]);
		expect(fs.mkdir).not.toHaveBeenCalled();
		expect(fs.writeFile).not.toHaveBeenCalled();

		source.install({ policyRevision: 3, pins: [pin('local.md', LOCAL_DOC, null)] });
		const result = await importOf('local-1');

		expect(urls).toEqual([]);
		expect(written()).toEqual([
			path.join(TARGET, 'local.md'),
			path.join(USER_DATA, 'playbooks', 'session-1.json'),
		]);
		expect(result.importedDocs).toEqual(['local']);
	});
});
