/**
 * E2E: the Electron acceptance cases of the mandatory rows (MCOMP-33-02B).
 *
 * One Playwright case per `electron.*` id of `ACCEPTANCE_CASES`
 * (`src/__tests__/integration/mega-maestro/journeys.ts`), driven through the
 * built app's own surfaces with the shared harness `e2e/fixtures/managed-host.ts`.
 * Each case writes one `AcceptanceCaseEvidence` record
 * (`e2e/fixtures/acceptance-evidence.ts`) to MAESTRO_E2E_CASE_EVIDENCE, which
 * `scripts/mega-maestro-pair.mjs run --case-evidence` assesses.
 *
 * `fixture` mode (default) runs the fail-closed half against the labeled
 * contract-fixture endpoint and records `endpoint: 'fixture'`: it never
 * counts. `endpoint` mode runs the positive half against the actual endpoint
 * and the packaged app; a missing input fails the case by name, never skips.
 * MCOMP-34 executes endpoint mode against the exact paired artifacts.
 *
 * This file holds enrollment, runs, standalone and create (MCOMP-33-02B), run
 * controls, edit/clone/import and live policy (MCOMP-33-02C); the remaining
 * Electron cases are authored by the inserted continuations MCOMP-33-02D..02F.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { MANAGED_BINDING_FILE_NAME } from '../src/shared/maestro-lib/runtime/data-dir-lock';
import {
	startFakeEndpoint,
	type FakeEndpoint,
} from '../src/__tests__/main/enterprise/fakeEndpoint';
import type {
	AcceptanceObservation,
	AcceptanceObserver,
} from '../src/__tests__/integration/mega-maestro/journeys';
import {
	caseArtifacts,
	diskAgents,
	electronCase,
	ledgerFile,
	ledgerLeases,
	listDir,
	observeHost,
	observeLedgerReceipt,
	observeOnDisk,
	writeCaseEvidence,
} from './fixtures/acceptance-evidence';
import {
	FIXTURE_PROVIDER,
	MANAGED_MODE,
	RUN_ACTION,
	activeTabManaged,
	createAgent,
	dismissErrorDialog,
	enroll,
	expect,
	expectStubProvider,
	hostRecords,
	managedState,
	managedTest as test,
	readRunEndpointInputs,
	runOperator,
	runState,
	sendTurn,
	type StubProvider,
} from './fixtures/managed-host';

interface CaseContext {
	app: ElectronApplication;
	page: Page;
	dataDir: string;
	projectDir: string;
	stub: StubProvider;
	/** The contract-fixture endpoint, started on first use and closed after the case. */
	fixtureEndpoint: () => Promise<FakeEndpoint>;
	observe: (kind: AcceptanceObserver, observation: AcceptanceObservation) => void;
}

/**
 * One acceptance case: the artifacts are resolved first (endpoint mode fails
 * by name before anything runs), then the body runs and the record is
 * written with what it observed, passed or failed.
 */
function acceptance(id: string, body: (ctx: CaseContext) => Promise<void>) {
	const spec = electronCase(id);
	test(`${id}: ${spec.title}`, async ({
		electronApp,
		window: page,
		testDataDir,
		projectDir,
		stub,
	}) => {
		const artifacts = caseArtifacts(MANAGED_MODE);
		const observations: Partial<Record<AcceptanceObserver, AcceptanceObservation>> = {};
		let endpoint: FakeEndpoint | null = null;
		let status: 'passed' | 'failed' = 'failed';
		try {
			await body({
				app: electronApp,
				page,
				dataDir: testDataDir,
				projectDir,
				stub,
				fixtureEndpoint: async () =>
					(endpoint ??= await startFakeEndpoint({
						capabilities: ['telemetry', 'execution', 'inbox', 'noticeList', 'enrollment'],
						operations: {
							enrollment: () => ({ outcome: 'enrollment_pending', enrollmentId: 'enrollment-e2e' }),
						},
					})),
				observe: (kind, observation) => {
					observations[kind] = observation;
				},
			});
			status = 'passed';
		} finally {
			writeCaseEvidence({
				caseId: id,
				status,
				host: await observeHost(electronApp),
				endpoint: MANAGED_MODE === 'endpoint' ? 'actual' : 'fixture',
				artifacts,
				observations,
			});
			await (endpoint as FakeEndpoint | null)?.close();
		}
	});
}

/** A refused send: the run state says why, the provider never launched, nothing was written. */
async function expectRefusedSend(
	ctx: CaseContext,
	agent: { id: string; name: string },
	prompt: string
) {
	const { page, stub, projectDir } = ctx;
	const launches = stub.launches().length;
	const files = listDir(projectDir);
	await sendTurn(page, agent.name, prompt);
	await dismissErrorDialog(page);
	const run = runState(page);
	await expect(run.root).toHaveAttribute('data-run-word', /^(denied|offline|unknown|revoked)$/);
	await expect(run.ids).toHaveCount(0);
	await expect(run.action(RUN_ACTION.stop)).toHaveCount(0);
	await expect
		.poll(async () => (await activeTabManaged(page, agent.id)).managedRefusal)
		.not.toBeNull();
	const checks = {
		'provider not launched': !stub.sawPrompt(prompt) && stub.launches().length === launches,
		'project directory unchanged': JSON.stringify(listDir(projectDir)) === JSON.stringify(files),
		'no lease in the ledger': ledgerLeases(ctx.dataDir).length === 0,
	};
	ctx.observe('effect', observeOnDisk({ prompt, files: listDir(projectDir) }, checks));
	expect(checks).toEqual(Object.fromEntries(Object.keys(checks).map((k) => [k, true])));
	return run;
}

/** An approved turn in endpoint mode: live under a lease, completed, its ledger receipt read off disk. */
async function approvedTurn(ctx: CaseContext, agent: { id: string; name: string }) {
	const inputs = readRunEndpointInputs();
	await sendTurn(ctx.page, agent.name, inputs.approvedPrompt);
	const run = runState(ctx.page);
	await expect(run.root).toHaveAttribute('data-run-word', /^(admitted|running|completed)$/);
	await expect(ctx.page.getByText(inputs.expectOutput).first()).toBeVisible({ timeout: 120_000 });
	await expect(run.root).toHaveAttribute('data-run-word', 'completed', { timeout: 120_000 });
	const { managedRun } = await activeTabManaged(ctx.page, agent.id);
	expect(managedRun?.leaseId).toBeTruthy();
	const receipt = observeLedgerReceipt(ledgerFile(ctx.dataDir), managedRun!.leaseId);
	ctx.observe('receipt', receipt);
	expect(receipt.problems).toEqual([]);
	return managedRun!;
}

/** The Edit Agent dialog, opened from the agent's Left Bar row. */
async function openEditAgent(page: Page, name: string) {
	await page.locator('[data-nav-key]').filter({ hasText: name }).first().click({ button: 'right' });
	await page.getByRole('button', { name: 'Edit Agent...' }).click();
	const dialog = page.getByRole('dialog', { name: `Edit Agent: ${name}` });
	await expect(dialog).toBeVisible();
	return dialog;
}

/** The New Agent form with a draft filled in, not yet submitted. */
async function draftNewAgent(page: Page, provider: string, name: string, dir: string) {
	await page.keyboard.press('Meta+n');
	const dialog = page.getByRole('dialog', { name: 'Create New Agent' });
	const row = dialog.getByRole('option', { name: new RegExp(provider) });
	await expect(row).toContainText('Available');
	await row.click();
	await dialog.getByLabel('Agent Name').fill(name);
	await dialog.getByPlaceholder('Select directory...').fill(dir);
	return dialog;
}

/**
 * Clone and import go through the same host operation (`sessions:commitAgent`)
 * the Duplicate and import surfaces call: the host's full record, a new id.
 */
async function commitCopy(page: Page, agentId: string, operation: 'clone' | 'import') {
	return page.evaluate(
		async ({ id, op }) => {
			const record = (await window.maestro.sessions.getAll()).find(
				(r: { id: string }) => r.id === id
			);
			const revision = (await window.maestro.enterprise.managedState())?.policy?.appliedRevision;
			return window.maestro.sessions.commitAgent({
				operation: op,
				record: { ...record, id: `e2e-accept-${op}`, name: `E2E Accept ${op}` },
				expectedPolicyRevision: revision ?? null,
			} as Parameters<typeof window.maestro.sessions.commitAgent>[0]);
		},
		{ id: agentId, op: operation }
	);
}

test.describe(`Electron acceptance cases (${MANAGED_MODE} mode)`, () => {
	acceptance('electron.enrollment-revoke', async (ctx) => {
		const { page } = ctx;
		if (MANAGED_MODE === 'fixture') {
			await expectStubProvider(page, ctx.stub);
			const agent = await createAgent(page, FIXTURE_PROVIDER, 'E2E Accept Revoke', ctx.projectDir);
			const endpoint = await ctx.fixtureEndpoint();
			await enroll(page, endpoint.socketPath);
			expect((await managedState(page))?.policy?.appliedRevision).toBe(3);
			endpoint.options.registrationRequired = true;
			endpoint.revokeRegistration();
			endpoint.dropConnections();
			await page.evaluate(() => window.maestro.enterprise.refreshPolicy());
			await expect
				.poll(async () => (await managedState(page))?.standing, { timeout: 30_000 })
				.not.toBe('managed');
			await expectRefusedSend(ctx, agent, 'revoked acceptance turn');
			return;
		}
		const inputs = readRunEndpointInputs();
		await enroll(page, inputs.socketPath, inputs);
		expect((await managedState(page))?.policy?.appliedRevision).toBeGreaterThan(0);
		const agent = await createAgent(
			page,
			inputs.approvedProvider,
			'E2E Accept Revoke',
			ctx.projectDir
		);
		const run = runState(page);
		await sendTurn(page, agent.name, inputs.longPrompt);
		await expect(run.root).toHaveAttribute('data-run-word', 'running', { timeout: 60_000 });
		runOperator(inputs.revokeRegistration);
		await expect(run.root).toHaveAttribute('data-run-word', 'revoked', { timeout: 60_000 });
		await expect.poll(async () => (await managedState(page))?.standing).not.toBe('managed');
		const lease = (await activeTabManaged(page, agent.id)).managedRun!.leaseId;
		const receipt = observeLedgerReceipt(ledgerFile(ctx.dataDir), lease);
		ctx.observe('receipt', receipt);
		expect(receipt.problems).toEqual([]);
		expect(receipt.detail).toMatchObject({ effect: { state: 'revoked' } });
	});

	acceptance('electron.approved-and-denied-run', async (ctx) => {
		const { page } = ctx;
		if (MANAGED_MODE === 'fixture') {
			await expectStubProvider(page, ctx.stub);
			const agent = await createAgent(page, FIXTURE_PROVIDER, 'E2E Accept Run', ctx.projectDir);
			await enroll(page, (await ctx.fixtureEndpoint()).socketPath);
			const run = await expectRefusedSend(ctx, agent, 'write a file');
			await expect(run.action(RUN_ACTION.refreshPolicy)).toBeVisible();
			return;
		}
		const inputs = readRunEndpointInputs();
		await enroll(page, inputs.socketPath, inputs);
		const agent = await createAgent(
			page,
			inputs.approvedProvider,
			'E2E Accept Run',
			ctx.projectDir
		);
		await approvedTurn(ctx, agent);
		await sendTurn(page, agent.name, inputs.deniedEffectPrompt);
		await expect(runState(page).root).not.toHaveAttribute('data-run-word', /^(admitted|running)$/, {
			timeout: 180_000,
		});
		const denied = path.join(ctx.projectDir, inputs.deniedEffectPath);
		const effect = observeOnDisk(
			{ deniedEffectPath: denied },
			{ 'the denied write never landed': !fs.existsSync(denied) }
		);
		ctx.observe('effect', effect);
		expect(effect.problems).toEqual([]);
	});

	acceptance('electron.standalone', async (ctx) => {
		const { page } = ctx;
		const endpointMode = MANAGED_MODE === 'endpoint';
		const provider = endpointMode ? readRunEndpointInputs().approvedProvider : FIXTURE_PROVIDER;
		expect((await managedState(page))?.standing).toBe('unenrolled');
		if (!endpointMode) await expectStubProvider(page, ctx.stub);
		const agent = await createAgent(page, provider, 'E2E Accept Standalone', ctx.projectDir);
		// Edit through the Left Bar's Edit Agent: no managed notice on a standalone host.
		const dialog = await openEditAgent(page, agent.name);
		await expect(dialog.getByTestId('managed-choices-notice')).toHaveCount(0);
		await dialog.getByLabel('Agent Name').fill('E2E Accept Standalone Edited');
		await dialog.getByRole('button', { name: 'Save Changes' }).click();
		await expect(dialog).toBeHidden();
		const name = 'E2E Accept Standalone Edited';
		const prompt = endpointMode
			? readRunEndpointInputs().approvedPrompt
			: 'standalone acceptance turn';
		await sendTurn(page, name, prompt);
		if (endpointMode)
			await expect(page.getByText(readRunEndpointInputs().expectOutput).first()).toBeVisible({
				timeout: 120_000,
			});
		else await expect.poll(() => ctx.stub.sawPrompt(prompt)).toBe(true);
		await expect(page.getByTestId('ai-tab-managed-run')).toHaveCount(0);
		await expect
			.poll(() => diskAgents(ctx.dataDir).find((r) => r.id === agent.id)?.name)
			.toBe(name);
		const checks = {
			'edited record on disk': diskAgents(ctx.dataDir).some(
				(r) => r.id === agent.id && r.name === name
			),
			'no managed binding file': !fs.existsSync(path.join(ctx.dataDir, MANAGED_BINDING_FILE_NAME)),
			'no lease in the ledger': ledgerLeases(ctx.dataDir).length === 0,
			...(endpointMode ? {} : { 'the turn reached the provider': ctx.stub.sawPrompt(prompt) }),
		};
		const effect = observeOnDisk({ agentId: agent.id, name }, checks);
		ctx.observe('effect', effect);
		expect(effect.problems).toEqual([]);
		expect(await activeTabManaged(page, agent.id)).toEqual({
			managedRun: null,
			managedRefusal: null,
		});
	});

	acceptance('electron.agent-create', async (ctx) => {
		const { page } = ctx;
		const endpointMode = MANAGED_MODE === 'endpoint';
		const inputs = endpointMode ? readRunEndpointInputs() : null;
		await enroll(
			page,
			inputs?.socketPath ?? (await ctx.fixtureEndpoint()).socketPath,
			inputs ?? undefined
		);
		const before = await hostRecords(page);
		await page.keyboard.press('Meta+n');
		const dialog = page.getByRole('dialog', { name: 'Create New Agent' });
		const row = dialog.getByRole('option', {
			name: new RegExp(inputs?.approvedProvider ?? FIXTURE_PROVIDER),
		});
		await expect(row).toContainText('Available');
		await row.click();
		await dialog.getByLabel('Agent Name').fill('E2E Accept Create');
		await dialog.getByPlaceholder('Select directory...').fill(ctx.projectDir);
		await dialog.getByRole('button', { name: 'Create Agent' }).click();
		if (endpointMode) {
			await expect(dialog).toBeHidden();
		} else {
			await expect(dialog.getByTestId('managed-refusal')).toContainText('Not created:');
			await expect(dialog.getByLabel('Agent Name')).toHaveValue('E2E Accept Create');
		}
		// A renderer that skips the form: the host answers from its own standing.
		const forged = await page.evaluate(
			(cwd) =>
				window.maestro.sessions.commitAgent({
					operation: 'create',
					record: {
						id: 'e2e-accept-forged',
						name: 'E2E Accept Forged',
						toolType: 'claude-code',
						cwd,
					},
					expectedPolicyRevision: 0,
					...{ ok: true, allowed: true, managed: false, fields: [] },
				} as unknown as Parameters<typeof window.maestro.sessions.commitAgent>[0]),
			ctx.projectDir
		);
		expect(forged).toMatchObject({ ok: false });
		const names = () => diskAgents(ctx.dataDir).map((r) => r.name);
		if (endpointMode) await expect.poll(names).toContain('E2E Accept Create');
		const checks = {
			[endpointMode ? 'the approved create is on disk' : 'the refused create is not on disk']:
				names().includes('E2E Accept Create') === endpointMode,
			'the forged create is not on disk': !names().includes('E2E Accept Forged'),
		};
		const effect = observeOnDisk({ before: before.map((r) => r.name), after: names() }, checks);
		ctx.observe('effect', effect);
		expect(effect.problems).toEqual([]);
	});

	acceptance('electron.interactive-run-controls', async (ctx) => {
		const { page } = ctx;
		if (MANAGED_MODE === 'fixture') {
			await expectStubProvider(page, ctx.stub);
			const agent = await createAgent(
				page,
				FIXTURE_PROVIDER,
				'E2E Accept Controls',
				ctx.projectDir
			);
			await enroll(page, (await ctx.fixtureEndpoint()).socketPath);
			const run = await expectRefusedSend(ctx, agent, 'controls turn');
			const word = await run.root.getAttribute('data-run-word');
			// "Send again" asks the host again and is refused again; nothing launches.
			if (word !== 'unknown') {
				await run.action(RUN_ACTION.retry).click();
				await dismissErrorDialog(page);
				await expect(run.root).toHaveAttribute('data-run-word', word!);
				expect(ctx.stub.sawPrompt('controls turn')).toBe(false);
				expect(ledgerLeases(ctx.dataDir)).toEqual([]);
			}
			return;
		}
		const inputs = readRunEndpointInputs();
		await enroll(page, inputs.socketPath, inputs);
		const agent = await createAgent(
			page,
			inputs.approvedProvider,
			'E2E Accept Controls',
			ctx.projectDir
		);
		await approvedTurn(ctx, agent);
		// Stop: the long turn is stopped under its lease and the ledger names the stop.
		const run = runState(page);
		await sendTurn(page, agent.name, inputs.longPrompt);
		await expect(run.action(RUN_ACTION.stop)).toBeVisible({ timeout: 60_000 });
		await run.action(RUN_ACTION.stop).click();
		await expect(run.root).not.toHaveAttribute('data-run-word', /^(admitted|running)$/, {
			timeout: 60_000,
		});
		const stopped = (await activeTabManaged(page, agent.id)).managedRun!.leaseId;
		const receipt = observeLedgerReceipt(ledgerFile(ctx.dataDir), stopped);
		const effect = observeOnDisk(
			{ leaseId: stopped, effect: (receipt.detail as { effect?: unknown }).effect },
			{ 'the stopped lease ended in the ledger': receipt.observed }
		);
		ctx.observe('effect', effect);
		expect(effect.problems).toEqual([]);
	});

	acceptance('electron.agent-edit-clone-import', async (ctx) => {
		const { page } = ctx;
		const endpointMode = MANAGED_MODE === 'endpoint';
		const inputs = endpointMode ? readRunEndpointInputs() : null;
		if (!endpointMode) await expectStubProvider(page, ctx.stub);
		const agent = await createAgent(
			page,
			inputs?.approvedProvider ?? FIXTURE_PROVIDER,
			'E2E Accept Edit',
			ctx.projectDir
		);
		await enroll(
			page,
			inputs?.socketPath ?? (await ctx.fixtureEndpoint()).socketPath,
			inputs ?? undefined
		);
		const onDisk = () => diskAgents(ctx.dataDir).find((r) => r.id === agent.id);
		const names = () => diskAgents(ctx.dataDir).map((r) => r.name);
		const dialog = await openEditAgent(page, agent.name);
		let checks: Record<string, boolean>;
		if (!endpointMode) {
			// A governed choice (the working directory): refused by name, the draft stays.
			const elsewhere = path.join(ctx.projectDir, 'elsewhere');
			fs.mkdirSync(elsewhere);
			await dialog.locator('#edit-agent-working-dir-input').fill(elsewhere);
			await dialog.getByRole('button', { name: 'Save Changes' }).click();
			await expect(dialog.getByTestId('managed-refusal')).toContainText('Not saved:');
			await expect(dialog.locator('#edit-agent-working-dir-input')).toHaveValue(elsewhere);
			await dialog.getByRole('button', { name: 'Cancel' }).click();
			// Clone and import share the same validation and are refused the same way.
			expect(await commitCopy(page, agent.id, 'clone')).toMatchObject({ ok: false });
			expect(await commitCopy(page, agent.id, 'import')).toMatchObject({ ok: false });
			checks = {
				'the refused edit left the working directory on disk': onDisk()?.cwd === ctx.projectDir,
				'the refused clone is not on disk': !names().includes('E2E Accept clone'),
				'the refused import is not on disk': !names().includes('E2E Accept import'),
				'nothing was written into the new directory': listDir(elsewhere).length === 0,
			};
		} else {
			await dialog.getByLabel('Agent Name').fill('E2E Accept Edited');
			await dialog.getByRole('button', { name: 'Save Changes' }).click();
			await expect(dialog).toBeHidden();
			await expect.poll(() => onDisk()?.name).toBe('E2E Accept Edited');
			expect(await commitCopy(page, agent.id, 'clone')).toMatchObject({ ok: true });
			expect(await commitCopy(page, agent.id, 'import')).toMatchObject({ ok: true });
			await expect.poll(names).toEqual(expect.arrayContaining(['E2E Accept clone']));
			checks = {
				'the approved edit is on disk': onDisk()?.name === 'E2E Accept Edited',
				'the approved clone is on disk': names().includes('E2E Accept clone'),
				'the approved import is on disk': names().includes('E2E Accept import'),
			};
		}
		const effect = observeOnDisk({ agentId: agent.id, after: names() }, checks);
		ctx.observe('effect', effect);
		expect(effect.problems).toEqual([]);
	});

	acceptance('electron.live-policy-revoke', async (ctx) => {
		const { page } = ctx;
		const endpointMode = MANAGED_MODE === 'endpoint';
		const inputs = endpointMode ? readRunEndpointInputs() : null;
		const endpoint = endpointMode ? null : await ctx.fixtureEndpoint();
		await enroll(page, inputs?.socketPath ?? endpoint!.socketPath, inputs ?? undefined);
		const name = 'E2E Accept Live';
		const provider = inputs?.approvedProvider ?? FIXTURE_PROVIDER;
		const dialog = await draftNewAgent(page, provider, name, ctx.projectDir);
		const notice = dialog.getByTestId('managed-choices-notice');
		const refreshPolicy = () => page.evaluate(() => window.maestro.enterprise.refreshPolicy());
		const draftKept = async () => {
			await expect(dialog.getByLabel('Agent Name')).toHaveValue(name);
			await expect(dialog.getByPlaceholder('Select directory...')).toHaveValue(ctx.projectDir);
		};
		// Tightened: the endpoint moves its policy under the open form.
		if (endpoint) {
			endpoint.options.status = { desiredPolicyRevision: 4, appliedPolicyRevision: 4 };
		} else runOperator(inputs!.tightenPolicy);
		expect((await refreshPolicy()).status).toBe('ok');
		await notice.getByRole('button', { name: 'Refresh policy' }).click();
		if (endpoint) await expect(notice.getByTestId('managed-policy-revision')).toContainText('4');
		await dialog.getByRole('button', { name: 'Create Agent' }).click();
		await expect(dialog.getByTestId('managed-refusal')).toContainText('Not created:');
		await expect(dialog.getByTestId('managed-refusal')).toHaveAttribute('role', 'alert');
		await draftKept();
		const tightened = !diskAgents(ctx.dataDir).some((r) => r.name === name);
		if (inputs) {
			// Restored: the same draft commits without being typed again.
			runOperator(inputs.restorePolicy);
			await refreshPolicy();
			await notice.getByRole('button', { name: 'Refresh policy' }).click();
			await dialog.getByRole('button', { name: 'Create Agent' }).click();
			await expect(dialog).toBeHidden();
			await expect.poll(() => diskAgents(ctx.dataDir).some((r) => r.name === name)).toBe(true);
		}
		// Revoked: the host withdraws the managed standing and says why.
		if (endpoint) {
			endpoint.options.registrationRequired = true;
			endpoint.revokeRegistration();
			endpoint.dropConnections();
		} else runOperator(inputs!.revokeRegistration);
		await refreshPolicy();
		await expect
			.poll(async () => (await managedState(page))?.standing, { timeout: 30_000 })
			.not.toBe('managed');
		const standing = await managedState(page);
		expect(standing?.reason).toBeTruthy();
		if (endpoint) await draftKept();
		const restored = diskAgents(ctx.dataDir).some((r) => r.name === name);
		const effect = observeOnDisk(
			{ standing: standing?.standing, reason: standing?.reason, agents: diskAgents(ctx.dataDir) },
			{
				'the tightened create is not on disk': tightened,
				...(inputs ? { 'the restored draft committed on disk': restored } : {}),
				'no lease in the ledger': ledgerLeases(ctx.dataDir).length === 0,
			}
		);
		ctx.observe('effect', effect);
		expect(effect.problems).toEqual([]);
	});
});
