/**
 * The Spec Kit, OpenSpec and BMAD prompt refreshers under the install ceiling
 * (MRC2-04-08), over the real policy source with a mocked network and
 * filesystem: standalone each refresh looks up the latest release, fetches
 * from it and writes as before, digesting nothing; enrolled with no ceiling
 * every refresh is refused `unavailable` before a request is made, a
 * directory made or a file written; a ceiling that pins only some files
 * refuses the rest `unpinned` with no write; a pinned refresh fetches from
 * the pin's source (never the release lookup), refuses other bytes
 * `digest-mismatch` with no write, and writes every prompt only when every
 * file carries its pinned digest, recording the pinned ref as the version.
 * BMAD's files share the bare name `workflow.md`, so its pins are matched by
 * source, and a referenced asset the ceiling does not pin fails the refresh
 * instead of being skipped like a missing one.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import path from 'path';

vi.mock('electron', () => ({
	app: { getPath: vi.fn(() => '/mock/userData'), isPackaged: false },
}));
vi.mock('fs/promises', () => {
	const api = {
		readFile: vi.fn(),
		writeFile: vi.fn(),
		mkdir: vi.fn(),
	};
	return { default: api, ...api };
});
vi.mock('../../main/utils/logger', () => ({
	logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../main/utils/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../../main/utils/fetchWithTimeout', () => ({ fetchWithTimeout: vi.fn() }));
vi.mock('../../prompts/bmad/catalog', () => ({
	bmadCatalog: [
		{
			id: 'help',
			command: '/bmad-help',
			description: 'help',
			name: 'bmad-help',
			sourcePath: 'src/core/skills/bmad-help/workflow.md',
			isCustom: false,
		},
		{
			id: 'create-prd',
			command: '/bmad-create-prd',
			description: 'prd',
			name: 'Create PRD',
			sourcePath: 'src/core/tasks/bmad-create-prd/workflow.md',
			isCustom: false,
		},
	],
}));

import fs from 'fs/promises';
import { fetchWithTimeout } from '../../main/utils/fetchWithTimeout';
import { logger } from '../../main/utils/logger';
import { createInstallPolicySource } from '../../main/enterprise/install-policy';
import type { IdentityRead } from '../../main/enterprise/identity-store';
import { setSpecPromptInstallAuthority } from '../../main/spec-prompt-install';
import { refreshSpeckitPrompts } from '../../main/speckit-manager';
import { refreshOpenSpecPrompts } from '../../main/openspec-manager';
import { refreshBmadPrompts } from '../../main/bmad-manager';

const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const none: IdentityRead = { status: 'none' };
const enrolled: IdentityRead = { status: 'ok', record: {} as never, epoch: 1 };

const SPECKIT_COMMANDS = [
	'constitution',
	'specify',
	'clarify',
	'plan',
	'tasks',
	'analyze',
	'checklist',
	'taskstoissues',
];
const SPECKIT_RAW = 'https://raw.githubusercontent.com/github/spec-kit';
const OPENSPEC_FILES = ['propose.ts', 'apply-change.ts', 'archive-change.ts'];
const OPENSPEC_RAW = 'https://raw.githubusercontent.com/Fission-AI/OpenSpec';
const BMAD_RAW = 'https://raw.githubusercontent.com/bmad-code-org/BMAD-METHOD/v6.2.0';
const BMAD_HELP = 'src/core/skills/bmad-help/workflow.md';
const BMAD_PRD = 'src/core/tasks/bmad-create-prd/workflow.md';
const BMAD_ASSET = 'src/core/tasks/bmad-create-prd/checklist.md';

const speckitTemplate = (cmd: string) => `---\ndescription: ${cmd}\n---\n\nDo ${cmd}.\n`;
const openspecModule = (file: string) =>
	`export const workflow = {\n  instructions: \`Instructions for ${file}\`,\n};\n`;
const bmadWorkflow = (id: string, reference?: string) =>
	`# ${id}\n\n${reference ? `Load \`${reference}\`.` : 'No references.'}\n`;

/** `fetchWithTimeout` answering by URL: a text body, a JSON body, or a 404. */
function serve(routes: Record<string, string | { json: unknown }>): string[] {
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
			text: async () => (typeof body === 'string' ? body : JSON.stringify(body.json)),
			json: async () => (typeof body === 'string' ? JSON.parse(body) : body.json),
		} as unknown as Response;
	});
	return urls;
}

const written = () =>
	vi.mocked(fs.writeFile).mock.calls.map((call) => [String(call[0]), String(call[1])] as const);
const writtenNames = () => written().map(([file]) => path.basename(file));
const pin = (artifact: string, file: string, bytes: string, source: string) => ({
	artifact,
	file,
	sha256: sha(bytes),
	source,
});

describe('spec prompt refreshers under the install ceiling', () => {
	let read: IdentityRead;
	let source: ReturnType<typeof createInstallPolicySource>;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(fetchWithTimeout).mockReset();
		// No customizations file on disk.
		vi.mocked(fs.readFile).mockRejectedValue(
			Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' })
		);
		read = none;
		source = createInstallPolicySource({
			identity: { read: () => read },
			policy: () => ({ appliedRevision: 3 }),
		});
		setSpecPromptInstallAuthority(source);
	});

	describe('Spec Kit', () => {
		const latestRoutes = () => ({
			'https://api.github.com/repos/github/spec-kit/releases/latest': {
				json: { tag_name: 'v0.0.99' },
			},
			...Object.fromEntries(
				SPECKIT_COMMANDS.map((cmd) => [
					`${SPECKIT_RAW}/v0.0.99/templates/commands/${cmd}.md`,
					speckitTemplate(cmd),
				])
			),
		});
		const pinnedRoutes = () =>
			Object.fromEntries(
				SPECKIT_COMMANDS.map((cmd) => [
					`${SPECKIT_RAW}/v0.0.90/templates/commands/${cmd}.md`,
					speckitTemplate(cmd),
				])
			);
		const pins = (bytes: (cmd: string) => string = speckitTemplate) =>
			SPECKIT_COMMANDS.map((cmd) =>
				pin(
					'speckit-prompts',
					`${cmd}.md`,
					bytes(cmd),
					`${SPECKIT_RAW}/v0.0.90/templates/commands/${cmd}.md`
				)
			);

		it('standalone: looks up the latest release, fetches from it and writes every prompt', async () => {
			const urls = serve(latestRoutes());

			const metadata = await refreshSpeckitPrompts();

			expect(urls[0]).toBe('https://api.github.com/repos/github/spec-kit/releases/latest');
			expect(urls).toHaveLength(1 + SPECKIT_COMMANDS.length);
			expect(fs.mkdir).toHaveBeenCalledWith('/mock/userData/speckit-prompts', {
				recursive: true,
			});
			expect(writtenNames()).toEqual([
				...SPECKIT_COMMANDS.map((cmd) => `speckit.${cmd}.md`),
				'metadata.json',
				'speckit-customizations.json',
			]);
			expect(metadata).toMatchObject({ commitSha: 'v0.0.99', sourceVersion: '0.0.99' });
		});

		it('enrolled with no ceiling: refused unavailable before any request, directory or write', async () => {
			read = enrolled;
			const urls = serve(latestRoutes());

			await expect(refreshSpeckitPrompts()).rejects.toThrow(
				/^\[managed-unavailable\] the managed install ceiling is unavailable \(no install ceiling is installed for policy revision 3\)$/
			);

			expect(urls).toEqual([]);
			expect(fs.mkdir).not.toHaveBeenCalled();
			expect(fs.writeFile).not.toHaveBeenCalled();
		});

		it('enrolled with a ceiling that pins some templates: refused unpinned by name, nothing fetched or written', async () => {
			read = enrolled;
			source.install({ policyRevision: 3, pins: pins().slice(0, 3) });
			const urls = serve(pinnedRoutes());

			await expect(refreshSpeckitPrompts()).rejects.toThrow(
				/^\[managed-unpinned\] the install ceiling pins no speckit-prompts plan\.md; for the operator only/
			);

			expect(urls).toEqual([]);
			expect(fs.writeFile).not.toHaveBeenCalled();
		});

		it('enrolled with every template pinned: fetches the pins, never the release lookup, and refuses other bytes with no write', async () => {
			read = enrolled;
			source.install({
				policyRevision: 3,
				pins: pins((cmd) => `${speckitTemplate(cmd)}changed\n`),
			});
			const urls = serve(pinnedRoutes());

			await expect(refreshSpeckitPrompts()).rejects.toThrow(
				/^\[managed-digest-mismatch\] the bytes of speckit-prompts constitution\.md \(sha256 [a-f0-9]{64}\) are not the pinned ones/
			);

			expect(urls).toEqual([`${SPECKIT_RAW}/v0.0.90/templates/commands/constitution.md`]);
			expect(fs.mkdir).not.toHaveBeenCalled();
			expect(fs.writeFile).not.toHaveBeenCalled();
		});

		it('enrolled with every template pinned and the pinned bytes served: writes every prompt as the transport, recording the pinned ref', async () => {
			read = enrolled;
			source.install({ policyRevision: 3, pins: pins() });
			const urls = serve({ ...latestRoutes(), ...pinnedRoutes() });

			const metadata = await refreshSpeckitPrompts({
				actor: { kind: 'transport', actor: { peer: 'host-secret' } },
			});

			expect(urls).toEqual(
				SPECKIT_COMMANDS.map((cmd) => `${SPECKIT_RAW}/v0.0.90/templates/commands/${cmd}.md`)
			);
			expect(writtenNames()).toEqual([
				...SPECKIT_COMMANDS.map((cmd) => `speckit.${cmd}.md`),
				'metadata.json',
				'speckit-customizations.json',
			]);
			expect(written()[0][1]).toContain('Do constitution.');
			expect(metadata).toMatchObject({ commitSha: 'v0.0.90', sourceVersion: '0.0.90' });
		});
	});

	describe('OpenSpec', () => {
		const base = 'src/core/templates/workflows';
		const routes = (ref: string) =>
			Object.fromEntries(
				OPENSPEC_FILES.map((file) => [
					`${OPENSPEC_RAW}/${ref}/${base}/${file}`,
					openspecModule(file),
				])
			);
		const pins = () =>
			OPENSPEC_FILES.map((file) =>
				pin(
					'openspec-prompts',
					file,
					openspecModule(file),
					`${OPENSPEC_RAW}/v1.2.0/${base}/${file}`
				)
			);

		it('standalone: looks up the latest release and writes the extracted workflows', async () => {
			const urls = serve({
				'https://api.github.com/repos/Fission-AI/OpenSpec/releases/latest': {
					json: { tag_name: 'v1.3.0' },
				},
				...routes('v1.3.0'),
			});

			const metadata = await refreshOpenSpecPrompts();

			expect(urls[0]).toBe('https://api.github.com/repos/Fission-AI/OpenSpec/releases/latest');
			expect(writtenNames()).toEqual([
				'openspec.proposal.md',
				'openspec.apply.md',
				'openspec.archive.md',
				'metadata.json',
				'openspec-customizations.json',
			]);
			expect(written()[0][1]).toBe('Instructions for propose.ts');
			expect(metadata).toMatchObject({ commitSha: 'v1.3.0', sourceVersion: '1.3.0' });
		});

		it('enrolled with no ceiling: refused unavailable with no request and no write', async () => {
			read = enrolled;
			const urls = serve(routes('main'));

			await expect(refreshOpenSpecPrompts()).rejects.toThrow(/^\[managed-unavailable\]/);

			expect(urls).toEqual([]);
			expect(fs.mkdir).not.toHaveBeenCalled();
			expect(fs.writeFile).not.toHaveBeenCalled();
		});

		it('enrolled with every module pinned: fetches the pins without the release lookup and writes all', async () => {
			read = enrolled;
			source.install({ policyRevision: 3, pins: pins() });
			const urls = serve(routes('v1.2.0'));

			const metadata = await refreshOpenSpecPrompts();

			expect(urls).toEqual(OPENSPEC_FILES.map((file) => `${OPENSPEC_RAW}/v1.2.0/${base}/${file}`));
			expect(writtenNames()).toHaveLength(5);
			expect(metadata).toMatchObject({ commitSha: 'v1.2.0', sourceVersion: '1.2.0' });
		});

		it('enrolled with a module whose bytes moved: refused digest-mismatch with no write', async () => {
			read = enrolled;
			source.install({ policyRevision: 3, pins: pins() });
			serve({ ...routes('v1.2.0'), [`${OPENSPEC_RAW}/v1.2.0/${base}/apply-change.ts`]: 'moved' });

			await expect(refreshOpenSpecPrompts()).rejects.toThrow(
				/^\[managed-digest-mismatch\] the bytes of openspec-prompts apply-change\.ts/
			);

			expect(fs.writeFile).not.toHaveBeenCalled();
		});
	});

	describe('BMAD', () => {
		const help = bmadWorkflow('help');
		const prd = bmadWorkflow('create-prd', '{installed_path}/checklist.md');
		const asset = '# Checklist\n';
		const routes = () => ({
			[`${BMAD_RAW}/${BMAD_HELP}`]: help,
			[`${BMAD_RAW}/${BMAD_PRD}`]: prd,
			[`${BMAD_RAW}/${BMAD_ASSET}`]: asset,
			'https://api.github.com/repos/bmad-code-org/BMAD-METHOD/commits/v6.2.0': {
				json: { sha: 'abcdef1234567' },
			},
			[`${BMAD_RAW}/package.json`]: { json: { version: '6.2.0' } },
		});
		const workflowPins = () => [
			pin('bmad-prompts', 'workflow.md', help, `${BMAD_RAW}/${BMAD_HELP}`),
			pin('bmad-prompts', 'workflow.md', prd, `${BMAD_RAW}/${BMAD_PRD}`),
		];
		const assetPin = () => pin('bmad-prompts', 'checklist.md', asset, `${BMAD_RAW}/${BMAD_ASSET}`);

		it('standalone: fetches every workflow and asset at the pinned ref, looks up commit and version, writes all', async () => {
			const urls = serve(routes());

			const metadata = await refreshBmadPrompts();

			expect(urls.slice(0, 3)).toEqual([
				`${BMAD_RAW}/${BMAD_HELP}`,
				`${BMAD_RAW}/${BMAD_PRD}`,
				`${BMAD_RAW}/${BMAD_ASSET}`,
			]);
			expect(urls).toHaveLength(5);
			expect(writtenNames()).toEqual([
				'bmad.help.md',
				'bmad.create-prd.md',
				'metadata.json',
				'bmad-customizations.json',
			]);
			expect(written()[1][1]).toContain('## src/core/tasks/bmad-create-prd/checklist.md');
			expect(metadata).toMatchObject({ commitSha: 'abcdef1', sourceVersion: '6.2.0' });
		});

		it('enrolled with no ceiling: refused unavailable with no request and no write', async () => {
			read = enrolled;
			const urls = serve(routes());

			await expect(refreshBmadPrompts()).rejects.toThrow(/^\[managed-unavailable\]/);

			expect(urls).toEqual([]);
			expect(fs.writeFile).not.toHaveBeenCalled();
		});

		it('enrolled with the workflows pinned by source but not the referenced asset: the refresh fails, the asset is not skipped', async () => {
			read = enrolled;
			source.install({ policyRevision: 3, pins: workflowPins() });
			const urls = serve(routes());

			await expect(refreshBmadPrompts()).rejects.toThrow(
				new RegExp(
					`^\\[managed-unpinned\\] the install ceiling pins no bmad-prompts checklist\\.md from ${BMAD_RAW}/${BMAD_ASSET};`
				)
			);

			expect(urls).toEqual([`${BMAD_RAW}/${BMAD_HELP}`, `${BMAD_RAW}/${BMAD_PRD}`]);
			expect(fs.mkdir).not.toHaveBeenCalled();
			expect(fs.writeFile).not.toHaveBeenCalled();
			expect(vi.mocked(logger.warn).mock.calls).toEqual([]);
		});

		it('enrolled with everything pinned: each workflow.md is held by its own source, no commit or version lookup, every prompt written', async () => {
			read = enrolled;
			source.install({ policyRevision: 3, pins: [...workflowPins(), assetPin()] });
			const urls = serve(routes());

			const metadata = await refreshBmadPrompts();

			expect(urls).toEqual([
				`${BMAD_RAW}/${BMAD_HELP}`,
				`${BMAD_RAW}/${BMAD_PRD}`,
				`${BMAD_RAW}/${BMAD_ASSET}`,
			]);
			expect(writtenNames()).toEqual([
				'bmad.help.md',
				'bmad.create-prd.md',
				'metadata.json',
				'bmad-customizations.json',
			]);
			expect(metadata).toMatchObject({ commitSha: 'v6.2.0', sourceVersion: '6.2.0' });
		});

		it('enrolled with a workflow whose bytes moved: refused digest-mismatch against its own pin, no write', async () => {
			read = enrolled;
			source.install({ policyRevision: 3, pins: [...workflowPins(), assetPin()] });
			serve({ ...routes(), [`${BMAD_RAW}/${BMAD_PRD}`]: bmadWorkflow('create-prd', 'other.md') });

			await expect(refreshBmadPrompts()).rejects.toThrow(
				new RegExp(
					`^\\[managed-digest-mismatch\\] the bytes of bmad-prompts workflow\\.md \\(sha256 [a-f0-9]{64}\\) are not the pinned ones \\(${sha(prd)}\\)`
				)
			);

			expect(fs.writeFile).not.toHaveBeenCalled();
		});
	});
});
