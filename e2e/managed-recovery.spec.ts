/**
 * E2E: recovering a managed run on the desktop (MCOMP-25-04).
 *
 * Drives the built Electron app through policy tightening, a dropped and a
 * revoked endpoint connection, and an application restart, reading the host
 * state the person sees: the AI tab's managed run state, the host standing
 * over `enterprise:managedState`, and the persisted tab on disk.
 *
 * `fixture` mode (default) enrolls against the contract-fixture endpoint
 * daemon (labeled double, see `e2e/fixtures/managed-host.ts`): it grants no
 * prepared execution, so every send is refused, and the journeys prove that
 * recovery never runs anything on its own: a policy refresh shows the new
 * revision and resends nothing, a dropped socket reattaches, a revoked
 * registration withdraws the managed standing, and a restart brings back the
 * host's last word for the tab.
 *
 * `endpoint` mode is the paired half MCOMP-26 executes and records: a live
 * run revoked when the registration is withdrawn under it, a tightened policy
 * refusing the next send, and the ledger read back after a restart.
 */
import fs from 'node:fs';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import path from 'node:path';
import {
	startFakeEndpoint,
	type FakeEndpoint,
} from '../src/__tests__/main/enterprise/fakeEndpoint';
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
	managedState,
	managedTest as test,
	readRunEndpointInputs,
	register,
	runOperator,
	runState,
	sendTurn,
} from './fixtures/managed-host';

/** Launch the built app again over the same data directory, as the fixture launches it. */
async function relaunch(appPath: string, env: Record<string, string>, dataDir: string) {
	const app = await electron.launch({
		args: [appPath],
		env: {
			...process.env,
			MAESTRO_DEMO_DIR: dataDir,
			MAESTRO_DATA_DIR: dataDir,
			ELECTRON_DISABLE_GPU: '1',
			NODE_ENV: 'test',
			MAESTRO_E2E_TEST: 'true',
			...env,
		} as Record<string, string>,
		timeout: 30_000,
	});
	const page = await app.firstWindow();
	await page.waitForLoadState('domcontentloaded');
	return { app, page };
}

/** Bring the agent's AI tab into view after a restart. */
async function openAgent(page: Page, name: string) {
	await page.locator('[data-nav-key]').filter({ hasText: name }).first().click();
}

test.describe(`managed run recovery on the desktop (${MANAGED_MODE} mode)`, () => {
	if (MANAGED_MODE === 'fixture') {
		test.describe('enrolled against the contract-fixture endpoint', () => {
			let endpoint: FakeEndpoint;
			test.beforeEach(async () => {
				endpoint = await startFakeEndpoint({
					capabilities: ['telemetry', 'execution', 'inbox', 'noticeList', 'enrollment'],
					operations: {
						enrollment: () => ({ outcome: 'enrollment_pending', enrollmentId: 'enrollment-e2e' }),
					},
				});
			});
			test.afterEach(async () => {
				await endpoint.close();
			});

			test('a tightened policy is shown on refresh and resends nothing', async ({
				window: page,
				projectDir,
				stub,
			}) => {
				await expectStubProvider(page, stub);
				const agent = await createAgent(page, FIXTURE_PROVIDER, 'E2E Tighten', projectDir);
				await enroll(page, endpoint.socketPath);
				expect((await managedState(page))?.policy?.appliedRevision).toBe(3);
				const launches = stub.launches().length;

				await sendTurn(page, 'E2E Tighten', 'tighten turn');
				await dismissErrorDialog(page);
				const run = runState(page);
				await expect(run.root).toHaveAttribute('data-run-word', /^(denied|offline|unknown)$/);
				const refusal = (await activeTabManaged(page, agent.id)).managedRefusal;

				// The endpoint moves its policy; the run state's own control asks for it.
				endpoint.options.status = { desiredPolicyRevision: 4, appliedPolicyRevision: 4 };
				await run.action(RUN_ACTION.refreshPolicy).click();
				await expect(page.getByText('Managed policy').first()).toBeVisible();
				await expect.poll(async () => (await managedState(page))?.policy?.appliedRevision).toBe(4);

				// Asking for the policy is not a send: the refusal stands and nothing ran.
				expect((await activeTabManaged(page, agent.id)).managedRefusal).toEqual(refusal);
				expect(stub.sawPrompt('tighten turn')).toBe(false);
				expect(stub.launches()).toHaveLength(launches);
			});

			test('a dropped connection reattaches; a revoked registration withdraws the managed standing', async ({
				window: page,
				projectDir,
				stub,
			}) => {
				await expectStubProvider(page, stub);
				const agent = await createAgent(page, FIXTURE_PROVIDER, 'E2E Revoke', projectDir);
				await enroll(page, endpoint.socketPath);
				const launches = stub.launches().length;

				// The daemon restarts under the desktop: the next policy read reattaches.
				endpoint.dropConnections();
				const reattached = await page.evaluate(() => window.maestro.enterprise.refreshPolicy());
				expect(reattached.status, JSON.stringify(reattached)).toBe('ok');
				await expect.poll(async () => (await managedState(page))?.standing).toBe('managed');

				// The endpoint withdraws the registration: the host stops answering for it.
				endpoint.options.registrationRequired = true;
				endpoint.revokeRegistration();
				endpoint.dropConnections();
				await page.evaluate(() => window.maestro.enterprise.refreshPolicy());
				await expect
					.poll(async () => (await managedState(page))?.standing, { timeout: 30_000 })
					.not.toBe('managed');

				// A send under the withdrawn standing is refused at the sink and runs nothing.
				await sendTurn(page, 'E2E Revoke', 'revoked turn');
				await dismissErrorDialog(page);
				const run = runState(page);
				await expect(run.root).toBeVisible();
				await expect(run.root).not.toHaveAttribute(
					'data-run-word',
					/^(admitted|running|completed)$/
				);
				await expect
					.poll(async () => (await activeTabManaged(page, agent.id)).managedRefusal)
					.not.toBeNull();
				expect(stub.sawPrompt('revoked turn')).toBe(false);
				expect(stub.launches()).toHaveLength(launches);
			});

			test('a restart shows the standing it lost, keeps the tab’s last refusal and registers again', async ({
				electronApp,
				window: page,
				appPath,
				electronLaunchEnv,
				testDataDir,
				projectDir,
				stub,
			}) => {
				await expectStubProvider(page, stub);
				const agent = await createAgent(page, FIXTURE_PROVIDER, 'E2E Restart', projectDir);
				await enroll(page, endpoint.socketPath);
				await sendTurn(page, 'E2E Restart', 'restart turn');
				await dismissErrorDialog(page);
				await expect(runState(page).root).toBeVisible();
				const word = await runState(page).root.getAttribute('data-run-word');
				await expect
					.poll(async () => (await activeTabManaged(page, agent.id)).managedRefusal)
					.not.toBeNull();
				const refusal = (await activeTabManaged(page, agent.id)).managedRefusal;
				// Let the debounced session write land before the app goes away.
				await expect
					.poll(() =>
						fs
							.readFileSync(path.join(testDataDir, 'maestro-sessions.json'), 'utf8')
							.includes(refusal!.code)
					)
					.toBe(true);
				await electronApp.close();

				const again = await relaunch(appPath, electronLaunchEnv, testDataDir);
				let app: ElectronApplication | null = again.app;
				try {
					const restarted = again.page;
					// A registration belongs to the process that made it: the new process
					// is not managed until it registers again, and the host says why.
					await expect
						.poll(async () => (await managedState(restarted))?.standing, { timeout: 30_000 })
						.not.toBe('unenrolled');
					const standing = await managedState(restarted);
					expect(standing?.standing).not.toBe('managed');
					expect(standing?.reason).toBeTruthy();

					// The tab keeps the host's last word across the restart.
					await openAgent(restarted, 'E2E Restart');
					const run = runState(restarted);
					await expect(run.root).toHaveAttribute('data-run-word', word!);
					expect((await activeTabManaged(restarted, agent.id)).managedRefusal).toEqual(refusal);

					// Registering through the desktop's own lifecycle restores the standing.
					await register(restarted);
					// Nothing resends on its own after a restart.
					expect(stub.sawPrompt('restart turn')).toBe(false);
					await app.close();
					app = null;
				} finally {
					await app?.close();
				}
			});
		});
	}

	if (MANAGED_MODE === 'endpoint') {
		test('a live run is revoked with its registration; a tightened policy refuses the next send; a restart reads the ledger back', async ({
			electronApp,
			window: page,
			appPath,
			electronLaunchEnv,
			testDataDir,
			projectDir,
		}) => {
			const inputs = readRunEndpointInputs();
			await enroll(page, inputs.socketPath, inputs);
			const agent = await createAgent(page, inputs.approvedProvider, 'E2E Recover', projectDir);
			const run = runState(page);

			// Revoked under a live run: the host stops it and says so.
			await sendTurn(page, 'E2E Recover', inputs.longPrompt);
			await expect(run.root).toHaveAttribute('data-run-word', 'running', { timeout: 60_000 });
			runOperator(inputs.revokeRegistration);
			await expect(run.root).toHaveAttribute('data-run-word', 'revoked', { timeout: 60_000 });
			await expect(run.reason).not.toBeEmpty();
			await expect(run.action(RUN_ACTION.retry)).toHaveCount(0);
			const revokedLease = (await activeTabManaged(page, agent.id)).managedRun!.leaseId;

			// Register again, then tighten: the next send is refused under the new revision.
			await register(page, inputs);
			runOperator(inputs.tightenPolicy);
			await page.evaluate(() => window.maestro.enterprise.refreshPolicy());
			await sendTurn(page, 'E2E Recover', inputs.approvedPrompt);
			await dismissErrorDialog(page);
			await expect(run.root).toHaveAttribute('data-run-word', /^(denied|offline)$/);
			runOperator(inputs.restorePolicy);

			// Restart: the revoked run is read back from the ledger by its lease.
			await electronApp.close();
			const again = await relaunch(appPath, electronLaunchEnv, testDataDir);
			try {
				await register(again.page, inputs);
				const receipt = await again.page.evaluate(
					(lease) => window.maestro.enterprise.managedRun(lease),
					revokedLease
				);
				expect(receipt).toMatchObject({
					leaseId: revokedLease,
					effect: { state: expect.stringMatching(/^(revoked|released)$/) },
				});
			} finally {
				await again.app.close();
			}
		});
	}
});
