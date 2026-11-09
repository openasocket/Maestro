/**
 * E2E: running a turn on a managed desktop (MCOMP-25-04).
 *
 * Drives the built Electron app from the composer: the New Agent form, the
 * real `process:spawn` sink with its admission, the AI tab's managed run
 * state (`AiTabManagedRun`), the dispatch ledger read back over
 * `enterprise:managedRun`, and the sessions store on disk.
 *
 * `fixture` mode (default) enrolls against the contract-fixture endpoint
 * daemon (labeled double, see `e2e/fixtures/managed-host.ts`). It grants no
 * prepared execution, so the journeys prove the fail-closed half: a turn the
 * host cannot admit never reaches the provider, the tab says why by the
 * host's own words, no lease is shown, and "Send again" asks the host again.
 * The provider binary is a recording stub, so "nothing ran" is a fact read
 * off disk, not an inference.
 *
 * `endpoint` mode runs against an actual endpoint and a real provider; those
 * are the mandatory positive cases MCOMP-26 executes and records: an approved
 * run's live output and lease, its exact ledger receipt, and a denied effect
 * that writes nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
	startFakeEndpoint,
	type FakeEndpoint,
} from '../src/__tests__/main/enterprise/fakeEndpoint';
import { parseManagedSpawnRefusal } from '../src/shared/processErrors';
import {
	FIXTURE_PROVIDER,
	MANAGED_MODE,
	RUN_ACTION,
	activeTabManaged,
	createAgent,
	dismissErrorDialog,
	enroll,
	expect,
	managedState,
	managedTest as test,
	readRunEndpointInputs,
	runState,
	sendTurn,
	expectStubProvider,
} from './fixtures/managed-host';

test.describe(`managed agent runs through the desktop (${MANAGED_MODE} mode)`, () => {
	if (MANAGED_MODE === 'fixture') {
		test('standalone: the sink spawns with no admission and the tab draws no managed run state', async ({
			window: page,
			projectDir,
			stub,
		}) => {
			expect((await managedState(page))?.standing).toBe('unenrolled');
			await expectStubProvider(page, stub);
			const agent = await createAgent(page, FIXTURE_PROVIDER, 'E2E Run Standalone', projectDir);
			await expect(page.getByTestId('ai-tab-managed-run')).toHaveCount(0);

			// The same process:spawn the composer uses: a standalone host binds no lease.
			const processId = `${agent.id}-ai-standalone-probe`;
			const spawned = await page.evaluate(
				({ id, cwd, binary }) =>
					window.maestro.process.spawn({
						sessionId: id,
						toolType: 'claude-code',
						cwd,
						command: binary,
						args: [],
						prompt: 'standalone turn',
					} as Parameters<typeof window.maestro.process.spawn>[0]),
				{ id: processId, cwd: projectDir, binary: stub.binary }
			);
			expect(spawned).toMatchObject({ success: true });
			expect((spawned as { managedRun?: unknown }).managedRun).toBeUndefined();
			await expect.poll(() => stub.sawPrompt('standalone turn')).toBe(true);
			await page.evaluate((id) => window.maestro.process.kill(id).catch(() => false), processId);

			await expect(page.getByTestId('ai-tab-managed-run')).toHaveCount(0);
			expect(await activeTabManaged(page, agent.id)).toEqual({
				managedRun: null,
				managedRefusal: null,
			});
		});

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

			test('a turn the host cannot admit never runs; the tab says why and offers only safe recovery', async ({
				window: page,
				testDataDir,
				projectDir,
				stub,
			}) => {
				await expectStubProvider(page, stub);
				const agent = await createAgent(page, FIXTURE_PROVIDER, 'E2E Run Refused', projectDir);
				await enroll(page, endpoint.socketPath);
				const launchesBefore = stub.launches().length;
				const filesBefore = fs.readdirSync(projectDir).sort();

				await sendTurn(page, 'E2E Run Refused', 'write a file');
				// The app's own agent-error dialog reports the failed send; dismiss it.
				await dismissErrorDialog(page);
				const run = runState(page);
				await expect(run.root).toBeVisible();
				// Never a success word: the fixture grants no prepared execution.
				await expect(run.root).toHaveAttribute('data-run-word', /^(denied|offline|unknown)$/);
				await expect(run.reason).not.toBeEmpty();
				await expect(run.ids).toHaveCount(0);
				await expect(run.action(RUN_ACTION.stop)).toHaveCount(0);
				await expect(run.action(RUN_ACTION.refreshPolicy)).toBeVisible();

				// Bounded effects: the provider was never launched, nothing was written.
				expect(stub.sawPrompt('write a file')).toBe(false);
				expect(stub.launches()).toHaveLength(launchesBefore);
				expect(fs.readdirSync(projectDir).sort()).toEqual(filesBefore);

				// The refusal is the host's and is persisted on the tab, with no lease.
				await expect
					.poll(async () => (await activeTabManaged(page, agent.id)).managedRefusal)
					.toMatchObject({ state: expect.stringMatching(/^(denied|unavailable|unknown)$/) });
				expect((await activeTabManaged(page, agent.id)).managedRun).toBeNull();
				// The ledger names no lease for a turn that was never admitted.
				const ledger = path.join(testDataDir, 'maestro-managed-dispatch-receipts.json');
				const receipts = fs.existsSync(ledger) ? fs.readFileSync(ledger, 'utf8') : '';
				expect(receipts).not.toContain('"released"');

				// "Send again" is an ordinary send: the host is asked again and refuses again.
				const word = await run.root.getAttribute('data-run-word');
				if (word !== 'unknown') {
					await run.action(RUN_ACTION.retry).click();
					await dismissErrorDialog(page);
					await expect(run.root).toHaveAttribute('data-run-word', word!);
					expect(stub.sawPrompt('write a file')).toBe(false);
					expect(stub.launches()).toHaveLength(launchesBefore);
				}
			});

			test('a forged spawn over IPC is admitted by the same sink and refused the same way', async ({
				window: page,
				projectDir,
				stub,
			}) => {
				await expectStubProvider(page, stub);
				const agent = await createAgent(page, FIXTURE_PROVIDER, 'E2E Run Forged', projectDir);
				await enroll(page, endpoint.socketPath);
				const launchesBefore = stub.launches().length;

				// The sink rejects the spawn and the rejection names the host's refusal.
				const rejected = await page.evaluate(
					({ id, cwd, binary }) =>
						window.maestro.process
							.spawn({
								sessionId: `${id}-ai-forged`,
								toolType: 'claude-code',
								cwd,
								command: binary,
								args: [],
								prompt: 'forged turn',
							} as Parameters<typeof window.maestro.process.spawn>[0])
							.then(
								(result) => ({ resolved: result as unknown, message: null }),
								(error: Error) => ({ resolved: null, message: error.message })
							),
					{ id: agent.id, cwd: projectDir, binary: stub.binary }
				);
				expect(rejected.resolved).toBeNull();
				expect(parseManagedSpawnRefusal(rejected.message)).toMatchObject({
					state: expect.stringMatching(/^(denied|unavailable|unknown)$/),
				});
				expect(stub.sawPrompt('forged turn')).toBe(false);
				expect(stub.launches()).toHaveLength(launchesBefore);
			});
		});
	}

	if (MANAGED_MODE === 'endpoint') {
		test('approved run: live output under a lease, an exact ledger receipt, a denied effect writes nothing', async ({
			window: page,
			projectDir,
		}) => {
			const inputs = readRunEndpointInputs();
			await enroll(page, inputs.socketPath, inputs);
			const agent = await createAgent(
				page,
				inputs.approvedProvider,
				'E2E Run Approved',
				projectDir
			);

			// Approved: the run is drawn live under its lease, then completes.
			await sendTurn(page, 'E2E Run Approved', inputs.approvedPrompt);
			const run = runState(page);
			await expect(run.root).toHaveAttribute('data-run-word', /^(admitted|running)$/);
			await expect(run.action(RUN_ACTION.stop)).toBeVisible();
			await expect(page.getByText(inputs.expectOutput).first()).toBeVisible({ timeout: 120_000 });
			await expect(run.root).toHaveAttribute('data-run-word', 'completed', { timeout: 120_000 });

			const { managedRun } = await activeTabManaged(page, agent.id);
			expect(managedRun?.leaseId).toBeTruthy();
			await expect(run.ids).toContainText(`Lease ${managedRun!.leaseId}`);
			await expect(run.ids).toContainText(`Policy revision ${managedRun!.policyRevision}`);

			// The exact receipt: the ledger's read of the same lease, released after exit.
			const receipt = await page.evaluate(
				(lease) => window.maestro.enterprise.managedRun(lease),
				managedRun!.leaseId
			);
			expect(receipt).toMatchObject({
				leaseId: managedRun!.leaseId,
				policyRevision: managedRun!.policyRevision,
				effect: { state: 'released', release: { outcome: 'exited', exitCode: 0 } },
			});

			// A denied effect: the turn may run, the refused write never lands.
			await sendTurn(page, 'E2E Run Approved', inputs.deniedEffectPrompt);
			await expect(run.root).not.toHaveAttribute('data-run-word', /^(admitted|running)$/, {
				timeout: 180_000,
			});
			expect(fs.existsSync(path.join(projectDir, inputs.deniedEffectPath))).toBe(false);
		});
	}
});
