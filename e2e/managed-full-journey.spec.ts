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
 * This file holds the first group (enrollment, runs, standalone, create); the remaining Electron cases are authored by the inserted
 * continuations MCOMP-33-02C..02F.
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
		await page
			.locator('[data-nav-key]')
			.filter({ hasText: agent.name })
			.first()
			.click({ button: 'right' });
		await page.getByRole('button', { name: 'Edit Agent...' }).click();
		const dialog = page.getByRole('dialog', { name: `Edit Agent: ${agent.name}` });
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
});
