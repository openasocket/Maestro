/**
 * E2E: the standalone agent journey through the actual desktop (MCOMP-33-03).
 *
 * A desktop that was never enrolled must keep creating, editing and running
 * agents exactly as it did before management existed, and across a restart.
 * Every step drives the built Electron app through its own surfaces: the New
 * Agent form, the Left Bar's Edit Agent, the composer, the real `sessions:*`,
 * `process:*` and `enterprise:*` IPC handlers, and the stores on disk. The
 * shared harness is `e2e/fixtures/managed-host.ts`; nothing here replaces a
 * handler with a double.
 *
 * The evidence is labeled on every run (a `standalone-evidence` annotation and
 * attachment): `fixture` mode (default) runs the turns against the recording
 * stub provider the harness seeds, so it proves the desktop path, never a real
 * provider. `endpoint` mode runs them against the approved provider named by
 * MAESTRO_E2E_ENDPOINT_INPUTS (no endpoint is enrolled; the provider is the
 * only input it reads), and a missing input fails the case by name.
 *
 * The facts are read off disk and from the host, never from what the UI
 * printed: the sessions store, the dispatch ledger and the data directory's
 * managed files (binding, enterprise identity, event journal, command ledger,
 * inbox receipts, workflow fences, dispatch receipts) none of which a
 * standalone host may write. `electron.standalone` in
 * `managed-full-journey.spec.ts` is the acceptance row's one-turn case; this
 * file holds the longer regression journey around it.
 */
import path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { ENTERPRISE_IDENTITY_FILE_NAME } from '../src/main/enterprise/identity-store';
import { MANAGED_INBOX_RECEIPTS_FILE_NAME } from '../src/main/enterprise/inbox';
import { MANAGED_COMMAND_LEDGER_FILE_NAME } from '../src/shared/maestro-lib/managed/commands';
import { MANAGED_EVENT_JOURNAL_FILE_NAME } from '../src/shared/maestro-lib/managed/event-journal';
import { MANAGED_WORKFLOWS_FILE_NAME } from '../src/shared/maestro-lib/managed/workflows';
import { MANAGED_BINDING_FILE_NAME } from '../src/shared/maestro-lib/runtime/data-dir-lock';
import { diskAgents, ledgerFile, ledgerLeases, listDir } from './fixtures/acceptance-evidence';
import {
	FIXTURE_PROVIDER,
	MANAGED_MODE,
	activeTabManaged,
	createAgent,
	expect,
	expectStubProvider,
	hostRecords,
	managedState,
	managedTest as test,
	readRunEndpointInputs,
	relaunch,
	sendTurn,
	type StubProvider,
} from './fixtures/managed-host';

/** Every file a managed host writes into its data directory; a standalone host writes none. */
const MANAGED_FILES = new Set([
	MANAGED_BINDING_FILE_NAME,
	ENTERPRISE_IDENTITY_FILE_NAME,
	MANAGED_EVENT_JOURNAL_FILE_NAME,
	MANAGED_COMMAND_LEDGER_FILE_NAME,
	MANAGED_INBOX_RECEIPTS_FILE_NAME,
	MANAGED_WORKFLOWS_FILE_NAME,
	path.basename(ledgerFile('.')),
]);

/** The managed files present in the data directory (by name, or the `maestro-managed-` family). */
function managedArtifacts(dataDir: string): string[] {
	return listDir(dataDir).filter(
		(name) => MANAGED_FILES.has(name) || /^maestro-managed-/.test(name)
	);
}

/** What the evidence of this run is: the stub (fixture) or an approved provider (endpoint). */
const EVIDENCE_LABEL =
	MANAGED_MODE === 'endpoint'
		? 'endpoint: approved provider, standalone host (no endpoint enrolled)'
		: 'fixture: recording stub provider, standalone host';

/** The provider, prompts and the proof that a turn reached it, for this mode. */
function turnPlan(stub: StubProvider) {
	if (MANAGED_MODE === 'endpoint') {
		const inputs = readRunEndpointInputs();
		return {
			provider: inputs.approvedProvider,
			prompts: [inputs.approvedPrompt, inputs.approvedPrompt],
			reached: async (page: Page) => {
				await expect(page.getByText(inputs.expectOutput).first()).toBeVisible({
					timeout: 120_000,
				});
				return true;
			},
		};
	}
	return {
		provider: FIXTURE_PROVIDER,
		prompts: ['standalone journey first turn', 'standalone journey turn after restart'],
		reached: async (_page: Page, prompt: string) => {
			await expect.poll(() => stub.sawPrompt(prompt)).toBe(true);
			return stub.sawPrompt(prompt);
		},
	};
}

/** The Edit Agent dialog, opened from the agent's Left Bar row. */
async function openEditAgent(page: Page, name: string) {
	await page.locator('[data-nav-key]').filter({ hasText: name }).first().click({ button: 'right' });
	await page.getByRole('button', { name: 'Edit Agent...' }).click();
	const dialog = page.getByRole('dialog', { name: `Edit Agent: ${name}` });
	await expect(dialog).toBeVisible();
	return dialog;
}

test.describe(`standalone agent journey through the desktop (${MANAGED_MODE} mode)`, () => {
	test('create, edit and run an agent, restart, and run it again: no managed state anywhere', async ({
		electronApp,
		window: firstPage,
		appPath,
		electronLaunchEnv,
		testDataDir,
		projectDir,
		stub,
	}) => {
		test.info().annotations.push({ type: 'standalone-evidence', description: EVIDENCE_LABEL });
		const plan = turnPlan(stub);
		let page = firstPage;
		let relaunched: ElectronApplication | null = null;
		const checks: Record<string, boolean> = {};
		try {
			expect((await managedState(page))?.standing).toBe('unenrolled');
			if (MANAGED_MODE === 'fixture') await expectStubProvider(page, stub);

			// Create through the New Agent form: the host's canonical record lands on disk.
			const agent = await createAgent(page, plan.provider, 'E2E Standalone Journey', projectDir);
			await expect.poll(() => diskAgents(testDataDir).map((r) => r.id)).toContain(agent.id);
			checks['created record on disk'] = diskAgents(testDataDir).some(
				(r) => r.id === agent.id && r.cwd === projectDir
			);

			// Edit through the Left Bar: no managed notice on a standalone host.
			const name = 'E2E Standalone Journey Edited';
			const dialog = await openEditAgent(page, agent.name);
			await expect(dialog.getByTestId('managed-choices-notice')).toHaveCount(0);
			await dialog.getByLabel('Agent Name').fill(name);
			await dialog.getByRole('button', { name: 'Save Changes' }).click();
			await expect(dialog).toBeHidden();
			await expect
				.poll(() => diskAgents(testDataDir).find((r) => r.id === agent.id)?.name)
				.toBe(name);
			checks['edited record on disk'] = true;

			// A forged policy revision over IPC does not make a standalone commit managed.
			const forged = await page.evaluate(async (id) => {
				const record = (await window.maestro.sessions.getAll()).find(
					(r: { id: string }) => r.id === id
				);
				return window.maestro.sessions.commitAgent({
					operation: 'clone',
					record: { ...record, id: `${id}-standalone-clone`, name: 'E2E Standalone Clone' },
					expectedPolicyRevision: 7,
				} as Parameters<typeof window.maestro.sessions.commitAgent>[0]);
			}, agent.id);
			expect(forged, JSON.stringify(forged)).toMatchObject({
				ok: true,
				managed: false,
				policyRevision: null,
			});
			checks['a forged policy revision commits unmanaged'] = forged.ok && !forged.managed;

			// Run: the turn reaches the provider with no lease and no managed run state.
			await sendTurn(page, name, plan.prompts[0]);
			checks['the first turn reached the provider'] = await plan.reached(page, plan.prompts[0]);
			await expect(page.getByTestId('ai-tab-managed-run')).toHaveCount(0);
			expect(await activeTabManaged(page, agent.id)).toEqual({
				managedRun: null,
				managedRefusal: null,
			});

			// Restart over the same data directory: the edited agent is still there and still runs.
			await electronApp.close();
			const again = await relaunch(appPath, electronLaunchEnv, testDataDir);
			relaunched = again.app;
			page = again.page;
			expect((await managedState(page))?.standing).toBe('unenrolled');
			await expect
				.poll(async () => (await hostRecords(page)).find((r) => r.id === agent.id)?.name)
				.toBe(name);
			checks['the edit survived the restart'] = true;
			await page.locator('[data-nav-key]').filter({ hasText: name }).first().click();
			await sendTurn(page, name, plan.prompts[1]);
			checks['the turn after restart reached the provider'] = await plan.reached(
				page,
				plan.prompts[1]
			);
			await expect(page.getByTestId('ai-tab-managed-run')).toHaveCount(0);

			checks['no lease in the ledger'] = ledgerLeases(testDataDir).length === 0;
			checks['no managed file in the data directory'] = managedArtifacts(testDataDir).length === 0;
			expect(managedArtifacts(testDataDir)).toEqual([]);
			expect(checks).toEqual(Object.fromEntries(Object.keys(checks).map((k) => [k, true])));
		} finally {
			await test.info().attach('standalone-evidence', {
				body: JSON.stringify(
					{ label: EVIDENCE_LABEL, checks, managedFiles: managedArtifacts(testDataDir) },
					null,
					2
				),
				contentType: 'application/json',
			});
			await (relaunched as ElectronApplication | null)?.close();
		}
	});
});
