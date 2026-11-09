/**
 * E2E: provider routes on a managed desktop (MCOMP-31-05).
 *
 * Drives the built Electron app from the composer, through the real
 * `process:spawn` sink and its admission, per provider route.
 *
 * `fixture` mode (default) enrolls against the contract-fixture endpoint
 * daemon (labeled double, see `e2e/fixtures/managed-host.ts`). No route is
 * qualified there, so the journey proves the no-fallback half: a refused
 * route is never replaced by an unmanaged spawn or by another provider, and
 * the agent's provider is never swapped behind the person's back.
 *
 * `endpoint` mode holds the mandatory per-provider cases MCOMP-32 executes and
 * records against a real endpoint and real provider executables: allowed
 * output under a lease; a denied file write, network connection and
 * descendant escape observed from outside the provider; a credential that
 * belongs to nobody else on this host never reaching the reply; and a policy
 * tightened in the middle of a run revoking it. It needs
 * MAESTRO_E2E_ENDPOINT_INPUTS (as the run journeys) plus
 * MAESTRO_E2E_PROVIDER_INPUTS; a missing input fails by name.
 */
import fs from 'node:fs';
import net from 'node:net';
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
	expectStubProvider,
	hostRecords,
	managedTest as test,
	readRunEndpointInputs,
	runOperator,
	runState,
	sendTurn,
} from './fixtures/managed-host';

/** One provider route MCOMP-32 qualifies; prompts may use {{PORT}} and {{MARKER}}. */
interface ProviderCase {
	/** The provider row (display name) and the transport its turns run on. */
	provider: string;
	transport: 'cli-process' | 'persistent-sdk' | 'pty' | 'ssh';
	allowedPrompt: string;
	expectOutput: string;
	/** Reaches for a file write the policy refuses, at `deniedPath` under the working directory. */
	deniedWritePrompt: string;
	deniedPath: string;
	/** Reaches for a TCP connection to 127.0.0.1:{{PORT}}, which the policy refuses. */
	deniedNetPrompt: string;
	/** Starts a detached child that writes {{MARKER}} after the turn ends. */
	descendantPrompt: string;
	/** Asks the provider to print every credential it can read. */
	credentialPrompt: string;
	/** A secret the operator placed on this host for another actor; it must never appear. */
	foreignSecret: string;
}

function readProviderInputs(): ProviderCase[] {
	const file = process.env.MAESTRO_E2E_PROVIDER_INPUTS;
	if (!file) {
		throw new Error(
			'Endpoint mode needs MAESTRO_E2E_PROVIDER_INPUTS (a JSON file: providers[] with provider, transport, allowedPrompt, expectOutput, deniedWritePrompt, deniedPath, deniedNetPrompt, descendantPrompt, credentialPrompt, foreignSecret).'
		);
	}
	const { providers = [] } = JSON.parse(fs.readFileSync(file, 'utf8')) as {
		providers?: Array<Partial<ProviderCase>>;
	};
	const fields = [
		'provider',
		'transport',
		'allowedPrompt',
		'expectOutput',
		'deniedWritePrompt',
		'deniedPath',
		'deniedNetPrompt',
		'descendantPrompt',
		'credentialPrompt',
		'foreignSecret',
	] as const;
	const missing = providers.flatMap((p, i) =>
		fields.filter((f) => !p[f]).map((f) => `providers[${i}].${f}`)
	);
	const covered = new Set(providers.map((p) => p.transport));
	for (const t of ['cli-process', 'persistent-sdk', 'pty', 'ssh'])
		if (!covered.has(t as ProviderCase['transport'])) missing.push(`a provider on ${t}`);
	if (missing.length) throw new Error(`Provider inputs in ${file} lack: ${missing.join(', ')}.`);
	return providers as ProviderCase[];
}

test.describe(`managed provider routes through the desktop (${MANAGED_MODE} mode)`, () => {
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

			test('a refused route never falls back to an unmanaged spawn, another provider or a swapped agent', async ({
				window: page,
				projectDir,
				stub,
			}) => {
				await expectStubProvider(page, stub);
				const agent = await createAgent(page, FIXTURE_PROVIDER, 'E2E Provider Route', projectDir);
				await enroll(page, endpoint.socketPath);
				const launchesBefore = stub.launches().length;

				await sendTurn(page, 'E2E Provider Route', 'route turn');
				await dismissErrorDialog(page);
				await expect(runState(page).root).toHaveAttribute(
					'data-run-word',
					/^(denied|offline|unknown)$/
				);

				// The same binary named as every other provider is refused at the same sink.
				for (const toolType of ['codex', 'opencode', 'factory-droid']) {
					const message = await page.evaluate(
						({ id, cwd, binary, toolType }) =>
							window.maestro.process
								.spawn({
									sessionId: `${id}-ai-${toolType}`,
									toolType,
									cwd,
									command: binary,
									args: [],
									prompt: `fallback via ${toolType}`,
								} as Parameters<typeof window.maestro.process.spawn>[0])
								.then(
									() => null,
									(error: Error) => error.message
								),
						{ id: agent.id, cwd: projectDir, binary: stub.binary, toolType }
					);
					expect(parseManagedSpawnRefusal(message ?? ''), toolType).toMatchObject({
						state: expect.stringMatching(/^(denied|unavailable|unknown)$/),
					});
				}
				expect(stub.launches()).toHaveLength(launchesBefore);
				expect(stub.sawPrompt('fallback via')).toBe(false);

				// The agent still names the provider the person chose, and the tab holds no lease.
				const record = (await hostRecords(page)).find((r) => r.id === agent.id);
				expect(record?.toolType).toBe('claude-code');
				expect((await activeTabManaged(page, agent.id)).managedRun).toBeNull();
			});
		});
	}

	if (MANAGED_MODE === 'endpoint') {
		test('every provider route: allowed output, denied write, network and descendant, credential isolation, mid-run policy change', async ({
			window: page,
			projectDir,
		}) => {
			test.setTimeout(30 * 60_000);
			const inputs = readRunEndpointInputs();
			const providers = readProviderInputs();
			await enroll(page, inputs.socketPath, inputs);
			const run = runState(page);

			// An outside observer of the network: any connection is a denied effect that happened.
			let connections = 0;
			const probe = net.createServer((s) => {
				connections++;
				s.destroy();
			});
			await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
			const port = String((probe.address() as net.AddressInfo).port);
			try {
				for (const [i, p] of providers.entries()) {
					const name = `E2E Provider ${i}`;
					const agent = await createAgent(page, p.provider, name, projectDir);
					const marker = path.join(projectDir, `descendant-${i}.marker`);
					const fill = (prompt: string) =>
						prompt.split('{{PORT}}').join(port).split('{{MARKER}}').join(marker);
					const settle = async () => {
						await dismissErrorDialog(page);
						await expect(run.root).not.toHaveAttribute('data-run-word', /^(admitted|running)$/, {
							timeout: 180_000,
						});
					};

					await sendTurn(page, name, p.allowedPrompt);
					await expect(page.getByText(p.expectOutput).first()).toBeVisible({ timeout: 120_000 });
					await expect(run.root).toHaveAttribute('data-run-word', 'completed', {
						timeout: 120_000,
					});
					expect(
						(await activeTabManaged(page, agent.id)).managedRun?.leaseId,
						p.provider
					).toBeTruthy();

					await sendTurn(page, name, fill(p.deniedWritePrompt));
					await settle();
					expect(fs.existsSync(path.join(projectDir, p.deniedPath)), p.provider).toBe(false);

					await sendTurn(page, name, fill(p.deniedNetPrompt));
					await settle();
					expect(connections, p.provider).toBe(0);

					await sendTurn(page, name, fill(p.descendantPrompt));
					await settle();
					await new Promise((resolve) => setTimeout(resolve, 5_000));
					expect(fs.existsSync(marker), p.provider).toBe(false);

					await sendTurn(page, name, p.credentialPrompt);
					await settle();
					await expect(page.getByText(p.foreignSecret)).toHaveCount(0);

					// Mid-run policy change: the live run is revoked, never left running.
					await sendTurn(page, name, inputs.longPrompt);
					await expect(run.root).toHaveAttribute('data-run-word', 'running', { timeout: 60_000 });
					runOperator(inputs.tightenPolicy);
					try {
						await page.evaluate(() => window.maestro.enterprise.refreshPolicy());
						await expect(run.root).toHaveAttribute('data-run-word', /^(revoked|denied)$/, {
							timeout: 60_000,
						});
						await expect(run.action(RUN_ACTION.stop)).toHaveCount(0);
					} finally {
						runOperator(inputs.restorePolicy);
						await page.evaluate(() => window.maestro.enterprise.refreshPolicy());
					}
				}
			} finally {
				probe.close();
			}
		});
	}
});
