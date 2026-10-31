import {
	analyzeMemoryLinks,
	resolveMemoryRepositoryRoot,
} from '../../shared/maestro-lib/translation/memory';
import { getAgentCapabilities } from '../../shared/maestro-lib/providers/capabilities';
/**
 * Tests for memory-manager.ts - project memory CRUD operations.
 *
 * Uses a per-test temporary directory passed explicitly as homeDir so we
 * never touch the user's real ~/.claude/projects/<encoded>/memory/.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import {
	getMemoryDirectoryPath,
	listMemoryEntries,
	readMemoryEntry,
	writeMemoryEntry,
	createMemoryEntry,
	deleteMemoryEntry,
	searchMemoryEntries,
	findOrphanMemories,
} from '../../main/memory-manager';

let tempHome: string;

describe('memory-manager', () => {
	beforeEach(() => {
		tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-memory-test-'));
	});

	afterEach(() => {
		try {
			fs.rmSync(tempHome, { recursive: true, force: true });
		} catch {
			// ignore
		}
	});

	it('resolves repository memory identity separately from worktree session cwd', async () => {
		const repositoryRoot = path.join(tempHome, 'repo');
		const worktree = path.join(tempHome, 'repo-worktrees', 'branch');
		expect(
			await resolveMemoryRepositoryRoot(worktree, async () => path.join(repositoryRoot, '.git'))
		).toBe(repositoryRoot);
		const plain = path.join(tempHome, 'plain');
		expect(await resolveMemoryRepositoryRoot(plain, async () => undefined)).toBe(plain);
	});
	it.each(['codex', 'grok', 'antigravity'])(
		'reads and edits explicitly bound %s knowledge without touching a native home',
		async (provider) => {
			const managed = path.join(tempHome, 'managed/memory');
			await writeMemoryEntry(
				'/project',
				'MEMORY.md',
				'Managed knowledge',
				provider,
				undefined,
				managed
			);
			expect(await readMemoryEntry('/project', 'MEMORY.md', provider, undefined, managed)).toBe(
				'Managed knowledge'
			);
			expect(
				(await listMemoryEntries('/project', provider, undefined, managed)).directoryPath
			).toBe(managed);
			expect(fs.existsSync(path.join(tempHome, '.claude'))).toBe(false);
		}
	);
	it('resolves the memory directory using the Claude project-path encoding', () => {
		const projectPath = '/Users/me/Projects/My App';
		const dir = getMemoryDirectoryPath(projectPath, 'claude-code', tempHome);
		expect(dir).toBe(
			path.join(tempHome, '.claude', 'projects', '-Users-me-Projects-My-App', 'memory')
		);
	});

	it('refuses non-claude-code agents', () => {
		expect(() => getMemoryDirectoryPath('/p', 'codex', tempHome)).toThrow(/not supported/);
	});

	it.each(['account-a', 'account-b'])(
		'does not certify native Grok memory from rules in %s',
		async (account) => {
			const project = path.join(tempHome, 'project');
			const home = path.join(tempHome, account);
			fs.mkdirSync(project, { recursive: true });
			fs.mkdirSync(home, { recursive: true });
			const rules = path.join(project, 'AGENTS.md');
			fs.writeFileSync(rules, 'Ordinary project instructions, not a memory binding.');
			expect(getAgentCapabilities('grok').supportsProjectMemory).toBe(false);
			const refusal = /Grok native project memory is not supported.*Project rules do not establish/;
			expect(() => getMemoryDirectoryPath(project, 'grok', home)).toThrow(refusal);
			for (const operation of [
				() => listMemoryEntries(project, 'grok', home),
				() => readMemoryEntry(project, 'note.md', 'grok', home),
				() => writeMemoryEntry(project, 'note.md', 'new', 'grok', home),
				() => createMemoryEntry(project, 'note.md', 'new', 'grok', home),
				() => deleteMemoryEntry(project, 'note.md', 'grok', home),
				() => searchMemoryEntries(project, 'note', 'grok', home),
				() => findOrphanMemories(project, 'grok', home),
			])
				await expect(operation()).rejects.toThrow(refusal);
			expect(fs.readdirSync(home)).toEqual([]);
			expect(fs.readdirSync(project)).toEqual(['AGENTS.md']);
			expect(fs.readFileSync(rules, 'utf8')).toBe(
				'Ordinary project instructions, not a memory binding.'
			);
		}
	);

	describe('bound Grok project knowledge', () => {
		let project: string;
		let bound: string;
		let other: string;
		beforeEach(() => {
			project = path.join(tempHome, 'project');
			bound = path.join(project, '.maestro', 'provider-knowledge', 'account-a', 'memory');
			other = path.join(tempHome, 'account-b', 'global.md');
			fs.mkdirSync(path.dirname(other), { recursive: true });
			fs.writeFileSync(other, 'Other account knowledge [[lonely]]');
		});

		afterEach(() => {
			expect(fs.readFileSync(other, 'utf8')).toBe('Other account knowledge [[lonely]]');
			expect(fs.readdirSync(path.dirname(other))).toEqual(['global.md']);
			expect(fs.existsSync(path.join(tempHome, '.grok'))).toBe(false);
			expect(fs.existsSync(path.join(tempHome, '.claude'))).toBe(false);
		});

		it('creates a missing bound directory and preserves exclusive create and index protection', async () => {
			expect(await listMemoryEntries(project, 'grok', tempHome, bound)).toMatchObject({
				directoryPath: bound,
				exists: false,
				entries: [],
				stats: { fileCount: 0, totalBytes: 0 },
			});
			expect(fs.existsSync(bound)).toBe(false);
			await createMemoryEntry(project, 'note.md', 'first', 'grok', tempHome, bound);
			await expect(
				createMemoryEntry(project, 'note.md', 'overwrite', 'grok', tempHome, bound)
			).rejects.toThrow(/already exists/);
			expect(await readMemoryEntry(project, 'note.md', 'grok', tempHome, bound)).toBe('first');
			await writeMemoryEntry(project, 'note.md', 'changed', 'grok', tempHome, bound);
			expect(await readMemoryEntry(project, 'note.md', 'grok', tempHome, bound)).toBe('changed');
			await writeMemoryEntry(project, 'MEMORY.md', '[[note]]', 'grok', tempHome, bound);
			await expect(
				deleteMemoryEntry(project, 'MEMORY.md', 'grok', tempHome, bound)
			).rejects.toThrow(/cannot be deleted/);
			await deleteMemoryEntry(project, 'note.md', 'grok', tempHome, bound);
			expect(
				(await listMemoryEntries(project, 'grok', tempHome, bound)).entries.map(
					(entry) => entry.name
				)
			).toEqual(['MEMORY.md']);
		});

		it.each(['../global.md', '..\\global.md', 'nested/global.md', '', 'note.txt'])(
			'rejects unsafe bound filename %j before creating directories',
			async (filename) => {
				for (const operation of [
					() => readMemoryEntry(project, filename, 'grok', tempHome, bound),
					() => writeMemoryEntry(project, filename, 'changed', 'grok', tempHome, bound),
					() => createMemoryEntry(project, filename, 'changed', 'grok', tempHome, bound),
					() => deleteMemoryEntry(project, filename, 'grok', tempHome, bound),
				])
					await expect(operation()).rejects.toThrow(/Unsafe memory filename|must end with/);
				expect(fs.existsSync(bound)).toBe(false);
			}
		);

		it('excludes another account symlink from list, search, orphan analysis and direct operations', async () => {
			await writeMemoryEntry(project, 'MEMORY.md', '[[escape]]', 'grok', tempHome, bound);
			await writeMemoryEntry(
				project,
				'lonely.md',
				'Selected project knowledge',
				'grok',
				tempHome,
				bound
			);
			const link = path.join(bound, 'escape.md');
			fs.symlinkSync(other, link, 'file');
			const list = await listMemoryEntries(project, 'grok', tempHome, bound);
			expect(list.entries.map((entry) => entry.name)).toEqual(['MEMORY.md', 'lonely.md']);
			expect(list.stats.totalBytes).toBe(Buffer.byteLength('[[escape]]Selected project knowledge'));
			expect(await searchMemoryEntries(project, 'Other account', 'grok', tempHome, bound)).toEqual(
				[]
			);
			expect(
				await searchMemoryEntries(project, 'Selected project', 'grok', tempHome, bound)
			).toEqual([{ name: 'lonely.md', matchedName: false, snippet: 'Selected project knowledge' }]);
			expect(await findOrphanMemories(project, 'grok', tempHome, bound)).toEqual({
				orphans: ['lonely.md'],
				brokenLinks: [{ source: 'MEMORY.md', target: 'escape' }],
			});
			for (const operation of [
				() => readMemoryEntry(project, 'escape.md', 'grok', tempHome, bound),
				() => createMemoryEntry(project, 'escape.md', 'changed', 'grok', tempHome, bound),
				() => deleteMemoryEntry(project, 'escape.md', 'grok', tempHome, bound),
			])
				await expect(operation()).rejects.toThrow(/escapes its selected root/);
			await expect(
				writeMemoryEntry(project, 'escape.md', 'changed', 'grok', tempHome, bound)
			).rejects.toThrow(/symbolic link/);
			expect(fs.readlinkSync(link)).toBe(other);
		});

		it('cannot create an outside target through a dangling entry link', async () => {
			fs.mkdirSync(bound, { recursive: true });
			const absent = path.join(path.dirname(other), 'absent.md');
			const link = path.join(bound, 'dangling.md');
			fs.symlinkSync(absent, link, 'file');
			expect((await listMemoryEntries(project, 'grok', tempHome, bound)).entries).toEqual([]);
			await expect(
				readMemoryEntry(project, 'dangling.md', 'grok', tempHome, bound)
			).rejects.toMatchObject({ code: 'ENOENT' });
			await expect(
				writeMemoryEntry(project, 'dangling.md', 'changed', 'grok', tempHome, bound)
			).rejects.toThrow(/symbolic link/);
			await expect(
				createMemoryEntry(project, 'dangling.md', 'changed', 'grok', tempHome, bound)
			).rejects.toThrow(/already exists/);
			expect(fs.readlinkSync(link)).toBe(absent);
			await deleteMemoryEntry(project, 'dangling.md', 'grok', tempHome, bound);
			expect(fs.readdirSync(bound)).toEqual([]);
			expect(fs.existsSync(absent)).toBe(false);
		});

		it('reads an internal alias but refuses to write through it or replace it', async () => {
			await createMemoryEntry(project, 'note.md', 'original', 'grok', tempHome, bound);
			const link = path.join(bound, 'alias.md');
			fs.symlinkSync('note.md', link, 'file');
			expect(await readMemoryEntry(project, 'alias.md', 'grok', tempHome, bound)).toBe('original');
			await expect(
				writeMemoryEntry(project, 'alias.md', 'changed', 'grok', tempHome, bound)
			).rejects.toThrow(/symbolic link/);
			await expect(
				createMemoryEntry(project, 'alias.md', 'changed', 'grok', tempHome, bound)
			).rejects.toThrow(/already exists/);
			expect(fs.readlinkSync(link)).toBe('note.md');
			await deleteMemoryEntry(project, 'alias.md', 'grok', tempHome, bound);
			expect(await readMemoryEntry(project, 'note.md', 'grok', tempHome, bound)).toBe('original');
		});
	});

	it('returns exists:false with empty entries when the directory is missing', async () => {
		const result = await listMemoryEntries('/Users/me/Projects/Empty', 'claude-code', tempHome);
		expect(result.exists).toBe(false);
		expect(result.entries).toEqual([]);
		expect(result.stats.fileCount).toBe(0);
		expect(result.stats.totalBytes).toBe(0);
	});

	it('pins MEMORY.md to the top and sorts the rest alphabetically', async () => {
		const projectPath = '/Users/me/Projects/Pinning';
		await writeMemoryEntry(projectPath, 'zebra.md', 'z', 'claude-code', tempHome);
		await writeMemoryEntry(projectPath, 'alpha.md', 'a', 'claude-code', tempHome);
		await writeMemoryEntry(projectPath, 'MEMORY.md', '- index', 'claude-code', tempHome);
		const result = await listMemoryEntries(projectPath, 'claude-code', tempHome);
		expect(result.entries.map((e) => e.name)).toEqual(['MEMORY.md', 'alpha.md', 'zebra.md']);
	});

	it('round-trips write/read/delete for a single entry', async () => {
		const projectPath = '/Users/me/Projects/Rw';
		await writeMemoryEntry(projectPath, 'note.md', 'hello', 'claude-code', tempHome);
		expect(await readMemoryEntry(projectPath, 'note.md', 'claude-code', tempHome)).toBe('hello');
		await deleteMemoryEntry(projectPath, 'note.md', 'claude-code', tempHome);
		const after = await listMemoryEntries(projectPath, 'claude-code', tempHome);
		expect(after.entries.find((e) => e.name === 'note.md')).toBeUndefined();
	});

	it('createMemoryEntry fails if the file already exists', async () => {
		const projectPath = '/Users/me/Projects/Create';
		await createMemoryEntry(projectPath, 'dup.md', 'first', 'claude-code', tempHome);
		await expect(
			createMemoryEntry(projectPath, 'dup.md', 'second', 'claude-code', tempHome)
		).rejects.toThrow(/already exists/);
	});

	it('refuses filenames that would escape the memory directory', async () => {
		const projectPath = '/Users/me/Projects/Safety';
		await expect(
			writeMemoryEntry(projectPath, '../evil.md', 'x', 'claude-code', tempHome)
		).rejects.toThrow(/Unsafe/);
		await expect(
			writeMemoryEntry(projectPath, 'sub/evil.md', 'x', 'claude-code', tempHome)
		).rejects.toThrow(/Unsafe/);
		await expect(
			writeMemoryEntry(projectPath, 'no-extension', 'x', 'claude-code', tempHome)
		).rejects.toThrow(/must end with \.md/);
	});

	it('refuses to delete MEMORY.md via the viewer', async () => {
		const projectPath = '/Users/me/Projects/Protect';
		await writeMemoryEntry(projectPath, 'MEMORY.md', 'index', 'claude-code', tempHome);
		await expect(
			deleteMemoryEntry(projectPath, 'MEMORY.md', 'claude-code', tempHome)
		).rejects.toThrow(/cannot be deleted/);
	});

	it('reports aggregate stats across all entries', async () => {
		const projectPath = '/Users/me/Projects/Stats';
		await writeMemoryEntry(projectPath, 'a.md', 'a'.repeat(100), 'claude-code', tempHome);
		await writeMemoryEntry(projectPath, 'b.md', 'b'.repeat(250), 'claude-code', tempHome);
		const result = await listMemoryEntries(projectPath, 'claude-code', tempHome);
		expect(result.stats.fileCount).toBe(2);
		expect(result.stats.totalBytes).toBe(350);
		expect(result.stats.firstCreatedAt).toBeTruthy();
		expect(result.stats.lastModifiedAt).toBeTruthy();
	});
	describe('searchMemoryEntries', () => {
		const projectPath = '/Users/me/Projects/Search';

		beforeEach(async () => {
			await writeMemoryEntry(projectPath, 'MEMORY.md', '- index line', 'claude-code', tempHome);
			await writeMemoryEntry(
				projectPath,
				'project_widgets.md',
				'The widget pipeline runs nightly.',
				'claude-code',
				tempHome
			);
			await writeMemoryEntry(
				projectPath,
				'user_prefs.md',
				'Prefers tabs over spaces.',
				'claude-code',
				tempHome
			);
		});

		it('returns every entry for an empty query', async () => {
			const matches = await searchMemoryEntries(projectPath, '   ', 'claude-code', tempHome);
			expect(matches.map((m) => m.name)).toEqual([
				'MEMORY.md',
				'project_widgets.md',
				'user_prefs.md',
			]);
		});

		it('matches on the filename', async () => {
			const matches = await searchMemoryEntries(projectPath, 'PREFS', 'claude-code', tempHome);
			expect(matches.map((m) => m.name)).toEqual(['user_prefs.md']);
			expect(matches[0].matchedName).toBe(true);
		});

		it('matches on the body and reports the matching line', async () => {
			const matches = await searchMemoryEntries(projectPath, 'nightly', 'claude-code', tempHome);
			expect(matches.map((m) => m.name)).toEqual(['project_widgets.md']);
			expect(matches[0].matchedName).toBe(false);
			expect(matches[0].snippet).toBe('The widget pipeline runs nightly.');
		});

		it('returns nothing when neither name nor body matches', async () => {
			const matches = await searchMemoryEntries(projectPath, 'zzzznope', 'claude-code', tempHome);
			expect(matches).toEqual([]);
		});

		it('caps the snippet and keeps the pinned/alphabetical order', async () => {
			await writeMemoryEntry(
				projectPath,
				'aaa_long.md',
				`prefix ${'x'.repeat(400)}`,
				'claude-code',
				tempHome
			);
			await writeMemoryEntry(
				projectPath,
				'MEMORY.md',
				'prefix in the index',
				'claude-code',
				tempHome
			);
			const matches = await searchMemoryEntries(projectPath, 'prefix', 'claude-code', tempHome);
			expect(matches.map((m) => m.name)).toEqual(['MEMORY.md', 'aaa_long.md']);
			const long = matches.find((m) => m.name === 'aaa_long.md');
			expect(long?.snippet?.length).toBeLessThanOrEqual(121);
			expect(long?.snippet?.endsWith('\u2026')).toBe(true);
		});
	});
	describe('findOrphanMemories', () => {
		const projectPath = '/Users/me/Projects/Orphans';

		it('reports entries that nothing references', async () => {
			await writeMemoryEntry(
				projectPath,
				'MEMORY.md',
				'- [Indexed](project_indexed.md) - hook',
				'claude-code',
				tempHome
			);
			await writeMemoryEntry(projectPath, 'project_indexed.md', 'body', 'claude-code', tempHome);
			await writeMemoryEntry(projectPath, 'project_lonely.md', 'body', 'claude-code', tempHome);

			const { orphans } = await findOrphanMemories(projectPath, 'claude-code', tempHome);
			expect(orphans).toEqual(['project_lonely.md']);
		});

		it('never reports MEMORY.md, which nothing is expected to point at', async () => {
			await writeMemoryEntry(projectPath, 'MEMORY.md', '# index', 'claude-code', tempHome);
			const { orphans } = await findOrphanMemories(projectPath, 'claude-code', tempHome);
			expect(orphans).toEqual([]);
		});

		it('counts a wiki link by filename stem as a reference', async () => {
			await writeMemoryEntry(projectPath, 'MEMORY.md', 'see [[a_note]]', 'claude-code', tempHome);
			await writeMemoryEntry(projectPath, 'a_note.md', 'body', 'claude-code', tempHome);
			const { orphans } = await findOrphanMemories(projectPath, 'claude-code', tempHome);
			expect(orphans).toEqual([]);
		});

		it('counts a wiki link by frontmatter name as a reference', async () => {
			// The memory instructions tell the agent to link by the `name:` slug,
			// which is often NOT the filename. A checker that only knew filenames
			// would report almost every entry as an orphan.
			await writeMemoryEntry(projectPath, 'MEMORY.md', 'see [[the-slug]]', 'claude-code', tempHome);
			await writeMemoryEntry(
				projectPath,
				'a_note.md',
				'---\nname: the-slug\n---\n\nbody',
				'claude-code',
				tempHome
			);
			const { orphans } = await findOrphanMemories(projectPath, 'claude-code', tempHome);
			expect(orphans).toEqual([]);
		});

		it('treats hyphen and underscore spellings as the same target', async () => {
			// One character apart, invisible in rendered markdown, and the single
			// biggest source of silently-dead pointers in a real memory dir.
			await writeMemoryEntry(
				projectPath,
				'MEMORY.md',
				'see [[project-my-note]]',
				'claude-code',
				tempHome
			);
			await writeMemoryEntry(projectPath, 'project_my_note.md', 'body', 'claude-code', tempHome);
			const { orphans, brokenLinks } = await findOrphanMemories(
				projectPath,
				'claude-code',
				tempHome
			);
			expect(orphans).toEqual([]);
			expect(brokenLinks).toEqual([]);
		});

		it('reports a link whose target does not exist', async () => {
			await writeMemoryEntry(projectPath, 'MEMORY.md', 'see [[nope]]', 'claude-code', tempHome);
			const { brokenLinks } = await findOrphanMemories(projectPath, 'claude-code', tempHome);
			expect(brokenLinks).toEqual([{ source: 'MEMORY.md', target: 'nope' }]);
		});

		it('does not let a self-link rescue an entry from being an orphan', async () => {
			await writeMemoryEntry(projectPath, 'MEMORY.md', '# index', 'claude-code', tempHome);
			await writeMemoryEntry(
				projectPath,
				'a_note.md',
				'I link to [[a_note]] only',
				'claude-code',
				tempHome
			);
			const { orphans } = await findOrphanMemories(projectPath, 'claude-code', tempHome);
			expect(orphans).toEqual(['a_note.md']);
		});
	});
});

describe('shared memory link discovery', () => {
	it('resolves nested relative topics, skips web links, and retains missing-link evidence', () => {
		const result = analyzeMemoryLinks(
			new Map([
				[
					'memory/MEMORY.md',
					'[topic](nested/topic.md) [web](https://example.test/docs.md) [missing](absent.md)',
				],
				['memory/nested/topic.md', 'synthetic fact'],
			])
		);
		expect(result.referenced.has('memory/nested/topic.md')).toBe(true);
		expect(result.brokenLinks).toEqual([{ source: 'memory/MEMORY.md', target: 'absent.md' }]);
	});
});
