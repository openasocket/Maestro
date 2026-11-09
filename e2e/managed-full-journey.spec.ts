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
 * controls, edit/clone/import and live policy (MCOMP-33-02C), offline and
 * restart, isolation and keyboard, and the credential route (MCOMP-33-02D),
 * Auto Run lineage, Cue prompt/shell/CLI and the delegated consult
 * (MCOMP-33-02E); the remaining Electron cases are authored by MCOMP-33-02F.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { ENTERPRISE_IDENTITY_FILE_NAME } from '../src/main/enterprise/identity-store';
import { MANAGED_BINDING_FILE_NAME } from '../src/shared/maestro-lib/runtime/data-dir-lock';
import { parseManagedSpawnRefusal, type ManagedSpawnRefusal } from '../src/shared/processErrors';
import { generateUUID } from '../src/shared/uuid';
import {
	autoRunTriggerEventId,
	autoRunWorkflowVersion,
	newAutoRunTurnRequest,
	nextAutoRunAttempt,
	type AutoRunTurnAttribution,
} from '../src/shared/maestro-lib/autorun/attribution';
import {
	MANAGED_WORKFLOWS_FILE_NAME,
	type HeldWorkflowOwnership,
} from '../src/shared/maestro-lib/managed/workflows';
import { GROUP_CHATS_DIR_NAME } from '../src/shared/maestro-lib/paths/resolve';
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
	FIXTURE_ENROLLMENT,
	FIXTURE_PROVIDER,
	MANAGED_MODE,
	RUN_ACTION,
	activeTabManaged,
	composer,
	createAgent,
	dismissErrorDialog,
	enroll,
	expect,
	expectStubProvider,
	hostRecords,
	managedState,
	managedTest as test,
	readRunEndpointInputs,
	register,
	relaunch,
	runOperator,
	runState,
	sendTurn,
	type ManagedRunEndpointInputs,
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
	/** Close the app and launch it again over the same data dir; `app` and `page` follow. */
	restart: () => Promise<void>;
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
		appPath,
		electronLaunchEnv,
		testDataDir,
		projectDir,
		stub,
	}) => {
		const artifacts = caseArtifacts(MANAGED_MODE);
		const observations: Partial<Record<AcceptanceObserver, AcceptanceObservation>> = {};
		let endpoint: FakeEndpoint | null = null;
		let relaunched: ElectronApplication | null = null;
		let status: 'passed' | 'failed' = 'failed';
		let ctx: CaseContext | null = null;
		try {
			await body(
				(ctx = {
					app: electronApp,
					page,
					dataDir: testDataDir,
					projectDir,
					stub,
					fixtureEndpoint: async () =>
						(endpoint ??= await startFakeEndpoint({
							capabilities: ['telemetry', 'execution', 'inbox', 'noticeList', 'enrollment'],
							operations: {
								enrollment: () => ({
									outcome: 'enrollment_pending',
									enrollmentId: 'enrollment-e2e',
								}),
							},
						})),
					restart: async () => {
						await ctx!.app.close();
						const again = await relaunch(appPath, electronLaunchEnv, testDataDir);
						relaunched = ctx!.app = again.app;
						ctx!.page = again.page;
					},
					observe: (kind, observation) => {
						observations[kind] = observation;
					},
				})
			);
			status = 'passed';
		} finally {
			writeCaseEvidence({
				caseId: id,
				status,
				// A case whose relaunch failed has no app left to ask; it is recorded failed.
				host: await observeHost(ctx?.app ?? electronApp).catch(() => 'browser' as const),
				endpoint: MANAGED_MODE === 'endpoint' ? 'actual' : 'fixture',
				artifacts,
				observations,
			});
			await (endpoint as FakeEndpoint | null)?.close();
			await (relaunched as ElectronApplication | null)?.close();
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

/** Bring an agent's AI tab into view (after a restart). */
async function openAgent(page: Page, name: string) {
	await page.locator('[data-nav-key]').filter({ hasText: name }).first().click();
}

/** The endpoint inputs one case needs beyond the shared ones; a missing one fails by name. */
function requireInputs<K extends keyof ManagedRunEndpointInputs>(
	inputs: ManagedRunEndpointInputs,
	keys: K[]
): ManagedRunEndpointInputs & Required<Pick<ManagedRunEndpointInputs, K>> {
	const missing = keys.filter((k) => {
		const value = inputs[k];
		return !value || (Array.isArray(value) && value.length === 0);
	});
	if (missing.length) throw new Error(`Endpoint inputs lack: ${missing.join(', ')}.`);
	return inputs as ManagedRunEndpointInputs & Required<Pick<ManagedRunEndpointInputs, K>>;
}

/** Press `key` until the focus is inside `target`, as a keyboard user reaches it. */
async function focusByKeyboard(page: Page, target: Locator, key = 'Tab', max = 80) {
	for (let i = 0; i < max; i++) {
		await page.keyboard.press(key);
		const inside = await target
			.evaluate((el) => el.contains(document.activeElement))
			.catch(() => false);
		if (inside) return true;
	}
	return false;
}

/** Files under `dir` (4 MB or less) whose bytes hold any of `needles`, relative to `dir`. */
function filesContaining(dir: string, needles: string[]): string[] {
	const hits: string[] = [];
	const walk = (at: string) => {
		for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
			const file = path.join(at, entry.name);
			if (entry.isDirectory()) walk(file);
			else if (entry.isFile() && fs.statSync(file).size <= 4 * 1024 * 1024) {
				const bytes = fs.readFileSync(file);
				if (needles.some((n) => bytes.includes(n))) hits.push(path.relative(dir, file));
			}
		}
	};
	if (fs.existsSync(dir)) walk(dir);
	return hits;
}

/**
 * A turn on the agent's own provider through the real `process:spawn` sink,
 * carrying a session environment override: the managed refusal, or null when
 * the sink did not refuse it.
 */
async function spawnWithOverride(
	page: Page,
	agent: { id: string; toolType: string },
	cwd: string,
	prompt: string,
	env: Record<string, string>
) {
	return spawnThroughSink(page, agent.toolType, {
		sessionId: `${agent.id}-ai-e2e-override`,
		cwd,
		prompt,
		sessionCustomEnvVars: env,
	});
}

/** The workflow fences the host holds, read off disk; an absent file holds none. */
function heldWorkflows(dataDir: string): HeldWorkflowOwnership[] {
	const file = path.join(dataDir, MANAGED_WORKFLOWS_FILE_NAME);
	if (!fs.existsSync(file)) return [];
	return JSON.parse(fs.readFileSync(file, 'utf8')).workflows ?? [];
}

type LedgerRecord = {
	leaseId: string;
	requestId: string;
	attemptId: string;
	effect?: { state?: string };
};

/** The ledger's records with their lineage ids, read off disk; an absent ledger holds none. */
function ledgerRecords(dataDir: string): LedgerRecord[] {
	const file = ledgerFile(dataDir);
	if (!fs.existsSync(file)) return [];
	return JSON.parse(fs.readFileSync(file, 'utf8')).receipts ?? [];
}

/** Wait until the ledger holds at least `min` leases not in `before`, all ended; their records. */
async function endedLeasesSince(dataDir: string, before: string[], min = 1) {
	const fresh = () => ledgerRecords(dataDir).filter((r) => !before.includes(r.leaseId));
	const ended = (r: LedgerRecord) =>
		['released', 'revoked', 'expired'].includes(r.effect?.state ?? '');
	await expect
		.poll(() => fresh().length >= min && fresh().every(ended), { timeout: 180_000 })
		.toBe(true);
	return fresh();
}

/** One spawn through the real `process:spawn` sink: the managed refusal, or null when it was not refused. */
async function spawnThroughSink(page: Page, toolType: string, config: Record<string, unknown>) {
	const message = await page.evaluate(
		async ({ toolType, config }) => {
			const agent = (await window.maestro.agents.get(toolType)) as {
				path?: string;
				command?: string;
			} | null;
			return window.maestro.process
				.spawn({
					toolType,
					command: agent?.path || agent?.command || toolType,
					args: [],
					...config,
				} as unknown as Parameters<typeof window.maestro.process.spawn>[0])
				.then(
					() => null,
					(error: Error) => error.message
				);
		},
		{ toolType, config }
	);
	return parseManagedSpawnRefusal(message ?? '');
}

/** One attempt of an Auto Run task through the sink, shaped as the Auto Run engine sends it. */
function autoRunAttempt(
	page: Page,
	agent: { id: string; toolType: string },
	cwd: string,
	prompt: string,
	attribution: AutoRunTurnAttribution
) {
	return spawnThroughSink(page, agent.toolType, {
		sessionId: `${agent.id}-batch-${attribution.attemptId}`,
		cwd,
		prompt,
		readOnlyMode: false,
		permissionMode: 'full',
		querySource: 'auto',
		autoRun: { attribution, fence: null },
	});
}

/** The Cue activity of the named subscriptions once none is still running (a wait, not an observation). */
async function settledCueRuns(page: Page, names: string[]) {
	const read = () =>
		page.evaluate(async (wanted) => {
			const log = await window.maestro.cue.getActivityLog(200);
			return log
				.filter((r) => wanted.includes(r.subscriptionName))
				.map((r) => ({ name: r.subscriptionName, status: r.status, stderr: r.stderr }));
		}, names);
	await expect
		.poll(
			async () => {
				const runs = await read();
				return names.every((n) => runs.some((r) => r.name === n && r.status !== 'running'));
			},
			{ timeout: 180_000 }
		)
		.toBe(true);
	return read();
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

	acceptance('electron.offline-restart', async (ctx) => {
		const inputs =
			MANAGED_MODE === 'endpoint'
				? requireInputs(readRunEndpointInputs(), ['takeOffline', 'restoreOnline'])
				: null;
		if (!inputs) await expectStubProvider(ctx.page, ctx.stub);
		const name = 'E2E Accept Offline';
		const provider = inputs?.approvedProvider ?? FIXTURE_PROVIDER;
		const agent = await createAgent(ctx.page, provider, name, ctx.projectDir);
		const endpoint = inputs ? null : await ctx.fixtureEndpoint();
		await enroll(ctx.page, inputs?.socketPath ?? endpoint!.socketPath, inputs ?? undefined);
		const enrolled = await managedState(ctx.page);
		const firstLease = inputs ? (await approvedTurn(ctx, agent)).leaseId : null;
		const leases = ledgerLeases(ctx.dataDir).length;
		const launches = ctx.stub.launches().length;

		// Offline: the endpoint goes away under the desktop; the next send is refused.
		if (endpoint) await endpoint.close();
		else runOperator(inputs!.takeOffline);
		const prompt = inputs?.approvedPrompt ?? 'offline acceptance turn';
		await sendTurn(ctx.page, name, prompt);
		await dismissErrorDialog(ctx.page);
		await expect(runState(ctx.page).root).toHaveAttribute(
			'data-run-word',
			/^(denied|offline|unknown|revoked)$/,
			{ timeout: 60_000 }
		);
		await expect
			.poll(async () => (await activeTabManaged(ctx.page, agent.id)).managedRefusal)
			.not.toBeNull();
		const refusal = (await activeTabManaged(ctx.page, agent.id)).managedRefusal!;
		const offlineTookNoLease = ledgerLeases(ctx.dataDir).length === leases;
		if (inputs) runOperator(inputs.restoreOnline);
		// Let the debounced session write land before the app goes away.
		const sessions = path.join(ctx.dataDir, 'maestro-sessions.json');
		await expect.poll(() => fs.readFileSync(sessions, 'utf8').includes(refusal.code)).toBe(true);

		// Restart: the enrollment survives, the registration does not, the refusal stands.
		await ctx.restart();
		const { page } = ctx;
		await expect
			.poll(async () => (await managedState(page))?.standing, { timeout: 30_000 })
			.not.toBe('unenrolled');
		const restarted = await managedState(page);
		expect(restarted?.standing).not.toBe('managed');
		expect(restarted?.reason).toBeTruthy();
		await openAgent(page, name);
		expect((await activeTabManaged(page, agent.id)).managedRefusal).toEqual(refusal);
		if (inputs) {
			await register(page, inputs);
			const revision = (await managedState(page))?.policy?.appliedRevision;
			expect(revision).toBe(enrolled?.policy?.appliedRevision);
		} else {
			// Still offline after the restart: the constraint holds, nothing runs.
			await expectRefusedSend(ctx, agent, 'offline after restart turn');
		}
		const checks = {
			'the enrollment record is still on disk': fs.existsSync(
				path.join(ctx.dataDir, ENTERPRISE_IDENTITY_FILE_NAME)
			),
			'the restart kept the enrolled org':
				restarted?.enrollment?.orgId === enrolled?.enrollment?.orgId &&
				restarted?.enrollment?.tenantId === enrolled?.enrollment?.tenantId,
			'the offline send took no lease': offlineTookNoLease,
			'nothing ran on its own after the restart': inputs
				? ledgerLeases(ctx.dataDir).length === leases
				: !ctx.stub.sawPrompt(prompt) && ctx.stub.launches().length === launches,
			...(firstLease
				? {
						'the first lease is read back from the ledger': observeLedgerReceipt(
							ledgerFile(ctx.dataDir),
							firstLease
						).observed,
					}
				: {}),
		};
		const effect = observeOnDisk(
			{ refusal, standing: restarted?.standing, reason: restarted?.reason },
			checks
		);
		ctx.observe('effect', effect);
		expect(effect.problems).toEqual([]);
	});

	acceptance('electron.isolation-accessibility', async (ctx) => {
		const { page } = ctx;
		const inputs = MANAGED_MODE === 'endpoint' ? readRunEndpointInputs() : null;
		if (!inputs) await expectStubProvider(page, ctx.stub);
		const name = 'E2E Accept Keyboard';
		const provider = inputs?.approvedProvider ?? FIXTURE_PROVIDER;
		const agent = await createAgent(page, provider, name, ctx.projectDir);
		await enroll(
			page,
			inputs?.socketPath ?? (await ctx.fixtureEndpoint()).socketPath,
			inputs ?? undefined
		);
		const enrollment = inputs?.enrollment ?? FIXTURE_ENROLLMENT;

		// Keyboard: the managed choices of the New Agent form, opened and used from keys alone.
		await page.keyboard.press('Meta+n');
		const dialog = page.getByRole('dialog', { name: 'Create New Agent' });
		await expect(dialog).toBeVisible();
		const notice = dialog.getByTestId('managed-choices-notice');
		const refresh = notice.getByRole('button', { name: 'Refresh policy' });
		const formReached = await focusByKeyboard(page, refresh);
		if (formReached) await page.keyboard.press('Enter');
		await page.keyboard.press('Escape');
		await expect(dialog).toBeHidden();

		// The run state's own controls, reached back from the composer.
		const prompt = inputs?.approvedPrompt ?? 'keyboard acceptance turn';
		if (inputs) await approvedTurn(ctx, agent);
		else await expectRefusedSend(ctx, agent, prompt);
		const controls = runState(page).root.getByRole('button');
		const hasControl = (await controls.count()) > 0;
		await composer(page, name).focus();
		const runReached = hasControl && (await focusByKeyboard(page, controls.first(), 'Shift+Tab'));

		// Isolation: the host is bound to the org it was given and keeps no enrollment secret.
		const state = await managedState(page);
		const leaked = filesContaining(ctx.dataDir, [
			enrollment.invitation,
			enrollment.keyPossessionProof,
		]);
		const checks = {
			'the managed choices of the New Agent form are reachable by keyboard': formReached,
			'the run state control is reachable by keyboard': !hasControl || runReached,
			'the host is enrolled to the tenant and org it was given':
				state?.enrollment?.tenantId === enrollment.tenantId &&
				state?.enrollment?.orgId === enrollment.orgId,
			'no enrollment secret is stored in the data dir': leaked.length === 0,
			...(inputs
				? {}
				: { 'the refused prompt never reached the provider': !ctx.stub.sawPrompt(prompt) }),
		};
		const effect = observeOnDisk({ enrollment: state?.enrollment, leaked, hasControl }, checks);
		ctx.observe('effect', effect);
		expect(effect.problems).toEqual([]);
	});

	acceptance('electron.credential-route', async (ctx) => {
		const { page } = ctx;
		const inputs = MANAGED_MODE === 'endpoint' ? readRunEndpointInputs() : null;
		if (!inputs) await expectStubProvider(page, ctx.stub);
		const provider = inputs?.approvedProvider ?? FIXTURE_PROVIDER;
		const agent = await createAgent(page, provider, 'E2E Accept Credential', ctx.projectDir);
		await enroll(
			page,
			inputs?.socketPath ?? (await ctx.fixtureEndpoint()).socketPath,
			inputs ?? undefined
		);
		if (inputs) await approvedTurn(ctx, agent);
		else await expectRefusedSend(ctx, agent, 'credential route turn');
		const leases = ledgerLeases(ctx.dataDir).length;
		const launches = ctx.stub.launches().length;

		// A credential of no one here and an account directory of no one's, as session overrides.
		const foreignSecret = `e2e-foreign-credential-${process.pid}-${Date.now()}`;
		const foreignAccount = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-e2e-foreign-account-'));
		try {
			const prompt = inputs?.approvedPrompt ?? 'credential override turn';
			const env = await spawnWithOverride(page, agent, ctx.projectDir, prompt, {
				ANTHROPIC_API_KEY: foreignSecret,
				OPENAI_API_KEY: foreignSecret,
			});
			const account = await spawnWithOverride(page, agent, ctx.projectDir, prompt, {
				CLAUDE_CONFIG_DIR: foreignAccount,
				CODEX_HOME: foreignAccount,
			});
			// An admitted override turn runs out of sight: give it time to touch what it would.
			if (inputs && (!env || !account)) await page.waitForTimeout(15_000);
			const record = (await hostRecords(page)).find((r) => r.id === agent.id);
			const checks = {
				...(inputs
					? {}
					: {
							'the env override was refused': env !== null,
							'the account override was refused': account !== null,
							'no fallback spawn reached the provider':
								ctx.stub.launches().length === launches && !ctx.stub.sawPrompt(prompt),
							'the overrides took no lease': ledgerLeases(ctx.dataDir).length === leases,
						}),
				'nothing was written into the foreign account': listDir(foreignAccount).length === 0,
				'the foreign credential is nowhere in the data dir':
					filesContaining(ctx.dataDir, [foreignSecret]).length === 0,
				'the agent keeps its provider': record?.toolType === agent.toolType,
			};
			const effect = observeOnDisk(
				{ refusals: { env, account }, toolType: record?.toolType },
				checks
			);
			ctx.observe('effect', effect);
			expect(effect.problems).toEqual([]);
		} finally {
			fs.rmSync(foreignAccount, { recursive: true, force: true });
		}
	});

	acceptance('electron.autorun-lineage', async (ctx) => {
		const { page } = ctx;
		const inputs = MANAGED_MODE === 'endpoint' ? readRunEndpointInputs() : null;
		if (!inputs) await expectStubProvider(page, ctx.stub);
		const provider = inputs?.approvedProvider ?? FIXTURE_PROVIDER;
		const agent = await createAgent(page, provider, 'E2E Accept Auto Run', ctx.projectDir);
		await enroll(
			page,
			inputs?.socketPath ?? (await ctx.fixtureEndpoint()).socketPath,
			inputs ?? undefined
		);
		// One Auto Run (one workflow, one root run) of two tasks, attributed as the engine does.
		const workflow = {
			workflowId: `e2e-accept-autorun-${Date.now()}`,
			version: autoRunWorkflowVersion(['Phase 1.md']),
			triggerEventId: autoRunTriggerEventId('operator', Date.now()),
			runId: generateUUID(),
		};
		const task = () =>
			newAutoRunTurnRequest(workflow, { purpose: 'task', document: 'Phase 1.md', loopNumber: 1 });
		const tasks = [task(), task()];
		const prompt = inputs?.approvedPrompt ?? 'auto run acceptance task';
		const launches = ctx.stub.launches().length;
		const refusals: (ManagedSpawnRefusal | null)[] = [];
		for (const attempt of tasks) {
			const before = ledgerLeases(ctx.dataDir);
			refusals.push(await autoRunAttempt(page, agent, ctx.projectDir, prompt, attempt));
			if (inputs && !refusals.at(-1)) await endedLeasesSince(ctx.dataDir, before);
		}
		// The second task tried again after the policy moved: the later attempt is refused.
		const retry = nextAutoRunAttempt(tasks[1]);
		let retryRefusal: ManagedSpawnRefusal | null = null;
		if (inputs) {
			runOperator(inputs.tightenPolicy);
			try {
				await page.evaluate(() => window.maestro.enterprise.refreshPolicy());
				retryRefusal = await autoRunAttempt(page, agent, ctx.projectDir, prompt, retry);
			} finally {
				runOperator(inputs.restorePolicy);
			}
		}
		const records = ledgerRecords(ctx.dataDir);
		const fences = heldWorkflows(ctx.dataDir);
		const held = fences.some((w) => w.workflowId === workflow.workflowId && w.state === 'held');
		const checks: Record<string, boolean> = inputs
			? {
					'each task ran once under its own request': tasks.every(
						(t) => records.filter((r) => r.requestId === t.requestId).length === 1
					),
					'the workflow owner fence is held': held,
					'the later attempt under the changed policy was refused': retryRefusal !== null,
					'the refused attempt took no lease': !records.some(
						(r) => r.attemptId === retry.attemptId
					),
				}
			: {
					'every task was refused at the sink': refusals.every((r) => r !== null),
					'no attempt reached the provider':
						ctx.stub.launches().length === launches && !ctx.stub.sawPrompt(prompt),
					'no lease in the ledger': records.length === 0,
					'no workflow owner fence is held': !fences.some((w) => w.state === 'held'),
				};
		const effect = observeOnDisk(
			{
				workflowId: workflow.workflowId,
				refusals,
				retryRefusal,
				fences: fences.map((w) => w.state),
			},
			checks
		);
		ctx.observe('effect', effect);
		if (inputs) {
			const first = records.find((r) => r.requestId === tasks[0].requestId)!;
			const receipt = observeLedgerReceipt(ledgerFile(ctx.dataDir), first.leaseId);
			ctx.observe('receipt', receipt);
			expect(receipt.problems).toEqual([]);
		}
		expect(effect.problems).toEqual([]);
	});

	acceptance('electron.cue-prompt-shell-cli', async (ctx) => {
		const { page } = ctx;
		const inputs = MANAGED_MODE === 'endpoint' ? readRunEndpointInputs() : null;
		if (!inputs) await expectStubProvider(page, ctx.stub);
		const provider = inputs?.approvedProvider ?? FIXTURE_PROVIDER;
		const agent = await createAgent(page, provider, 'E2E Accept Cue', ctx.projectDir);
		await enroll(
			page,
			inputs?.socketPath ?? (await ctx.fixtureEndpoint()).socketPath,
			inputs ?? undefined
		);
		// One pipeline: an agent prompt, a constrained shell command and a nested maestro-cli send.
		const prompt = inputs?.approvedPrompt ?? 'cue acceptance prompt';
		const relayed = inputs?.approvedPrompt ?? 'cue acceptance relay';
		const marker = path.join(ctx.projectDir, 'e2e-cue-shell.marker');
		const names = ['e2e-accept-cue-prompt', 'e2e-accept-cue-shell', 'e2e-accept-cue-cli'];
		const head = (name: string) => [
			`  - name: ${name}`,
			'    pipeline_name: E2E Accept Cue',
			'    event: cli.trigger',
		];
		const yaml = [
			'subscriptions:',
			...head(names[0]),
			`    prompt: ${JSON.stringify(prompt)}`,
			...head(names[1]),
			'    action: command',
			'    command:',
			'      mode: shell',
			`      shell: ${JSON.stringify('touch e2e-cue-shell.marker')}`,
			...head(names[2]),
			'    action: command',
			'    command:',
			'      mode: cli',
			'      cli:',
			'        command: send',
			`        target: ${JSON.stringify(agent.id)}`,
			`        message: ${JSON.stringify(relayed)}`,
			'',
		].join('\n');
		await page.evaluate(
			async ({ root, yaml, id }) => {
				await window.maestro.cue.writeYaml(root, yaml, undefined, id);
				await window.maestro.cue.enable();
				await window.maestro.cue.refreshSession(id, root);
			},
			{ root: ctx.projectDir, yaml, id: agent.id }
		);
		const before = ledgerLeases(ctx.dataDir);
		const launches = ctx.stub.launches().length;
		for (const name of names) {
			const fired = await page.evaluate((n) => window.maestro.cue.triggerSubscription(n), name);
			expect(fired, `${name} fired`).toBe(true);
		}
		const runs = await settledCueRuns(page, names);
		const fresh = inputs ? await endedLeasesSince(ctx.dataDir, before) : [];
		const fences = heldWorkflows(ctx.dataDir);
		const checks: Record<string, boolean> = inputs
			? {
					'the runs took leases that ended in the ledger': fresh.length > 0,
					'the approved shell command ran in the project': fs.existsSync(marker),
					'the pipeline owner fence is held': fences.some((w) => w.state === 'held'),
				}
			: {
					'no Cue run reached the provider':
						ctx.stub.launches().length === launches &&
						!ctx.stub.sawPrompt(prompt) &&
						!ctx.stub.sawPrompt(relayed),
					'the shell command never ran': !fs.existsSync(marker),
					'no lease in the ledger': ledgerLeases(ctx.dataDir).length === 0,
					'no workflow owner fence is held': !fences.some((w) => w.state === 'held'),
				};
		const effect = observeOnDisk(
			{ runs: runs.map((r) => ({ ...r, stderr: r.stderr.slice(0, 400) })), fences },
			checks
		);
		ctx.observe('effect', effect);
		if (inputs) {
			const receipt = observeLedgerReceipt(ledgerFile(ctx.dataDir), fresh[0].leaseId);
			ctx.observe('receipt', receipt);
			expect(receipt.problems).toEqual([]);
		}
		expect(effect.problems).toEqual([]);
		expect(runs.map((r) => r.status)).toEqual(names.map(() => (inputs ? 'completed' : 'failed')));
	});

	acceptance('electron.delegated-consult', async (ctx) => {
		const inputs = MANAGED_MODE === 'endpoint' ? readRunEndpointInputs() : null;
		if (!inputs) await expectStubProvider(ctx.page, ctx.stub);
		const provider = inputs?.approvedProvider ?? FIXTURE_PROVIDER;
		const asker = await createAgent(ctx.page, provider, 'E2E-Accept-Asker', ctx.projectDir);
		const peer = await createAgent(ctx.page, provider, 'E2E-Accept-Peer', ctx.projectDir);
		await enroll(
			ctx.page,
			inputs?.socketPath ?? (await ctx.fixtureEndpoint()).socketPath,
			inputs ?? undefined
		);
		const question = inputs?.approvedPrompt ?? 'consult acceptance question';
		const roomMessage = inputs?.approvedPrompt ?? 'room acceptance message';
		const launches = ctx.stub.launches().length;

		// A consult: a leading mention goes to the peer only, the asker's own turn is suppressed.
		let before = ledgerLeases(ctx.dataDir);
		await openAgent(ctx.page, asker.name);
		await sendTurn(ctx.page, asker.name, `@${peer.name} ${question}`);
		await dismissErrorDialog(ctx.page);
		const consulted = inputs ? await endedLeasesSince(ctx.dataDir, before) : [];

		// A group chat moderated on the same provider: the room's turn is the room's child.
		before = ledgerLeases(ctx.dataDir);
		const room = await ctx.page.evaluate(
			async ({ toolType, message }) => {
				const chat = await window.maestro.groupChat.create('E2E Accept Room', toolType);
				const sent = await window.maestro.groupChat.sendToModerator(chat.id, message).then(
					() => null,
					(error: Error) => error.message
				);
				return { id: chat.id as string, sent };
			},
			{ toolType: asker.toolType, message: roomMessage }
		);
		const moderated = inputs ? await endedLeasesSince(ctx.dataDir, before) : [];
		// A refused turn leaves no lease to wait on: give it time to touch what it would.
		if (!inputs) await ctx.page.waitForTimeout(5_000);
		const leases = ledgerLeases(ctx.dataDir);
		const ranBefore = ctx.stub.launches().length;

		// Restart: the room and the receipts read back, nothing is resent on its own.
		await ctx.restart();
		await ctx.page.waitForTimeout(5_000);
		const roomFile = path.join(ctx.dataDir, GROUP_CHATS_DIR_NAME, room.id, 'metadata.json');
		const checks: Record<string, boolean> = {
			'the room is on disk after the restart': fs.existsSync(roomFile),
			'nothing was resent after the restart':
				ledgerLeases(ctx.dataDir).length === leases.length &&
				ctx.stub.launches().length === ranBefore,
			...(inputs
				? {
						'the consult ran under its own lease': consulted.length > 0,
						'the room turn ran under its own lease': moderated.length > 0,
					}
				: {
						'the consult never reached the provider': !ctx.stub.sawPrompt(question),
						'the room turn never reached the provider': !ctx.stub.sawPrompt(roomMessage),
						'nothing reached the provider': ctx.stub.launches().length === launches,
						'no lease in the ledger': leases.length === 0,
					}),
		};
		const effect = observeOnDisk({ room: room.id, roomRefusal: room.sent, leases }, checks);
		ctx.observe('effect', effect);
		if (inputs) {
			// Read back after the restart: the consult's receipt, and the room turn's.
			const receipt = observeLedgerReceipt(ledgerFile(ctx.dataDir), consulted[0].leaseId);
			ctx.observe('receipt', receipt);
			expect(receipt.problems).toEqual([]);
			const roomReceipt = observeLedgerReceipt(ledgerFile(ctx.dataDir), moderated[0].leaseId);
			expect(roomReceipt.problems).toEqual([]);
		}
		expect(effect.problems).toEqual([]);
	});
});
