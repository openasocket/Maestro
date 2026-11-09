/**
 * E2E: endpoint communications on the desktop (MCOMP-29-04).
 *
 * Drives the built Electron app's notice inbox (Settings > Environment >
 * Mega-Maestro management) the way a person does, over the real
 * `enterprise:inbox*` IPC, the inbox client and its durable receipt ledger,
 * and reads the desktop command service's own status.
 *
 * `fixture` mode (default) enrolls against the contract-fixture endpoint
 * daemon (`src/__tests__/main/enterprise/fakeEndpoint.ts`, a labeled double):
 * it lists one notice and answers each inbox act, so the journeys prove the
 * Maestro half: delivered, read, acknowledged and a private reply are four
 * distinct receipts with exact keys, an answer the host did not see is
 * resent under the same key, a restart keeps the receipts and resends nothing,
 * the notice body never reaches a provider and the reply text is kept nowhere
 * on disk, and the desktop names pause/resume unsupported rather than
 * approximating them.
 *
 * `endpoint` mode is the paired half MCOMP-30 executes and records against a
 * real endpoint: the operator publishes a notice, the person acts on it here,
 * and the endpoint's own receipt custody is read back. It needs
 * MAESTRO_E2E_ENDPOINT_INPUTS (as the run journeys) plus
 * MAESTRO_E2E_COMMUNICATIONS_INPUTS; a missing input fails by name.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Page } from '@playwright/test';
import {
	startFakeEndpoint,
	type FakeEndpoint,
} from '../src/__tests__/main/enterprise/fakeEndpoint';
import {
	FIXTURE_PROVIDER,
	MANAGED_MODE,
	createAgent,
	enroll,
	expect,
	expectStubProvider,
	managedTest as test,
	readRunEndpointInputs,
	register,
	relaunch,
} from './fixtures/managed-host';

const CAMPAIGN = '11111111-1111-4111-8111-111111111111';
const MESSAGE = '22222222-2222-4222-8222-222222222222';
const BODY = 'Planned maintenance on Friday; please save your work.';
const REPLY = 'Thanks, I will be offline that afternoon.';

type InboxAct = {
	campaignId: string;
	messageId: string;
	idempotencyKey: string;
	action: { kind: string; text?: string };
};

const recorded = (act: InboxAct) => ({
	outcome: 'recorded',
	messageId: act.messageId,
	receiptId: `rcpt-${act.action.kind}`,
	state: act.action.kind === 'reply' ? 'replied' : act.action.kind,
});

/** Open Settings on Environment, where the managed pane and its notice inbox live. */
async function openInbox(page: Page) {
	await page.keyboard.press('Meta+,');
	await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
	await page.locator('button[title="Environment"]').click();
	const inbox = page.getByRole('list', { name: 'Notices' });
	await page.getByRole('button', { name: 'Refresh notices' }).click();
	await expect(inbox).toBeVisible();
	return inbox;
}

/** One receipt line of the notice's receipt group, e.g. "Read: recorded". */
const receipt = (page: Page, kind: string) =>
	page
		.getByRole('group', { name: 'Receipts recorded on this desktop' })
		.getByText(new RegExp(`^${kind}: `));

/** Every file under the data directory that mentions `text`. */
function filesMentioning(dir: string, text: string): string[] {
	const hits: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
		if (!entry.isFile()) continue;
		const file = path.join(entry.parentPath, entry.name);
		if (fs.statSync(file).size > 8 * 1024 * 1024) continue;
		if (fs.readFileSync(file).includes(text)) hits.push(file);
	}
	return hits;
}

test.describe(`managed communications on the desktop (${MANAGED_MODE} mode)`, () => {
	if (MANAGED_MODE === 'fixture') {
		test.describe('enrolled against the contract-fixture endpoint', () => {
			let endpoint: FakeEndpoint;
			let acts: InboxAct[];
			let answer: (act: InboxAct) => unknown;
			test.beforeEach(async () => {
				acts = [];
				answer = recorded;
				endpoint = await startFakeEndpoint({
					capabilities: ['telemetry', 'execution', 'inbox', 'noticeList', 'enrollment'],
					operations: {
						enrollment: () => ({ outcome: 'enrollment_pending', enrollmentId: 'enrollment-e2e' }),
						noticeList: () => ({
							outcome: 'notices',
							items: [
								{
									campaignId: CAMPAIGN,
									messageId: MESSAGE,
									body: BODY,
									expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
									kind: 'notice',
									agentInput: false,
								},
							],
							nextOffset: null,
						}),
						inbox: (payload) => {
							acts.push(payload as InboxAct);
							return answer(payload as InboxAct);
						},
					},
				});
			});
			test.afterEach(async () => {
				await endpoint.close();
			});

			test('read, acknowledge and a private reply are distinct exact receipts; nothing reaches an agent', async ({
				window: page,
				projectDir,
				stub,
				testDataDir,
			}) => {
				await expectStubProvider(page, stub);
				await createAgent(page, FIXTURE_PROVIDER, 'E2E Notices', projectDir);
				await enroll(page, endpoint.socketPath);
				const launches = stub.launches().length;

				const inbox = await openInbox(page);
				await expect(inbox.getByText(BODY)).toBeVisible();
				await expect(receipt(page, 'Delivered')).toHaveText('Delivered: recorded');

				await page.getByRole('button', { name: 'Mark read' }).click();
				await expect(receipt(page, 'Read')).toHaveText('Read: recorded');

				// The endpoint's answer is lost: the host says so and keeps the act resendable.
				answer = () => ({ outcome: 'echo' });
				await page.getByRole('button', { name: 'Acknowledge' }).click();
				await expect(receipt(page, 'Acknowledged')).toHaveText(
					'Acknowledged: answer not seen; act again to resend'
				);
				answer = recorded;
				await page.getByRole('button', { name: 'Acknowledge' }).click();
				await expect(receipt(page, 'Acknowledged')).toHaveText('Acknowledged: recorded');

				await page.getByRole('button', { name: 'Reply privately' }).click();
				await page.getByLabel('Private reply to the endpoint administrator').fill(REPLY);
				await page.getByRole('button', { name: 'Send reply' }).click();
				await expect(receipt(page, 'Reply')).toHaveText('Reply: recorded');

				// Exactly one wire act per receipt, the lost one resent under its first key.
				expect(acts.map((a) => a.action.kind)).toEqual([
					'delivered',
					'read',
					'acknowledged',
					'acknowledged',
					'reply',
				]);
				expect(acts[2].idempotencyKey).toBe(acts[3].idempotencyKey);
				expect(new Set(acts.map((a) => a.idempotencyKey)).size).toBe(4);
				expect(acts[4].action.text).toBe(REPLY);
				const ledger = await page.evaluate(() => window.maestro.enterprise.inboxState());
				expect(ledger?.status.receipts).toMatchObject({
					total: 4,
					byState: { recorded: 4, uncertain: 0 },
				});

				// Private: no provider launched or saw the notice, and the reply is kept nowhere.
				expect(stub.launches()).toHaveLength(launches);
				expect(stub.sawPrompt(BODY)).toBe(false);
				expect(filesMentioning(testDataDir, REPLY)).toEqual([]);
			});

			test('a restart keeps every receipt and resends nothing on its own', async ({
				electronApp,
				window: page,
				appPath,
				electronLaunchEnv,
				testDataDir,
			}) => {
				await enroll(page, endpoint.socketPath);
				await openInbox(page);
				await page.getByRole('button', { name: 'Mark read' }).click();
				await expect(receipt(page, 'Read')).toHaveText('Read: recorded');
				await electronApp.close();

				const again = await relaunch(appPath, electronLaunchEnv, testDataDir);
				try {
					await register(again.page);
					await openInbox(again.page);
					await expect(receipt(again.page, 'Delivered')).toHaveText('Delivered: recorded');
					await expect(receipt(again.page, 'Read')).toHaveText('Read: recorded');
					expect(acts.map((a) => a.action.kind)).toEqual(['delivered', 'read']);
				} finally {
					await again.app.close();
				}
			});

			test('the desktop names cooperative pause and resume unsupported instead of approximating them', async ({
				window: page,
			}) => {
				await enroll(page, endpoint.socketPath);
				const status = await page.evaluate(() => window.maestro.enterprise.commandStatus());
				expect(status?.capabilities).toEqual(
					expect.arrayContaining(['command-cancel_run', 'command-report_status'])
				);
				expect(status?.capabilities).not.toContain('command-pause_run');
				expect(status?.unsupported.map((u) => u.kind)).toEqual(
					expect.arrayContaining(['pause-run', 'resume-run'])
				);
				expect(status?.commands.total).toBe(0);
			});
		});
	}

	if (MANAGED_MODE === 'endpoint') {
		test('a real notice is read, acknowledged and answered privately; the endpoint custody holds the exact receipts', async ({
			window: page,
			testDataDir,
		}) => {
			const run = readRunEndpointInputs();
			const file = process.env.MAESTRO_E2E_COMMUNICATIONS_INPUTS;
			if (!file) {
				throw new Error(
					'Endpoint mode needs MAESTRO_E2E_COMMUNICATIONS_INPUTS (a JSON file: publishNotice, readReceipts argv; publishNotice prints {"messageId","body"}, readReceipts takes the messageId and prints [{"state","idempotencyKey"}]).'
				);
			}
			const inputs = JSON.parse(fs.readFileSync(file, 'utf8')) as {
				publishNotice?: string[];
				readReceipts?: string[];
			};
			const missing = [
				!inputs.publishNotice?.length && 'publishNotice',
				!inputs.readReceipts?.length && 'readReceipts',
			].filter(Boolean);
			if (missing.length) throw new Error(`Inputs in ${file} lack: ${missing.join(', ')}.`);

			await enroll(page, run.socketPath, run);
			const [cmd, ...args] = inputs.publishNotice!;
			const published = JSON.parse(execFileSync(cmd, args, { encoding: 'utf8' })) as {
				messageId: string;
				body: string;
			};
			const inbox = await openInbox(page);
			await expect(inbox.getByText(published.body)).toBeVisible();
			await page.getByRole('button', { name: 'Mark read' }).click();
			await page.getByRole('button', { name: 'Acknowledge' }).click();
			await page.getByRole('button', { name: 'Reply privately' }).click();
			await page.getByLabel('Private reply to the endpoint administrator').fill(REPLY);
			await page.getByRole('button', { name: 'Send reply' }).click();
			for (const kind of ['Delivered', 'Read', 'Acknowledged', 'Reply']) {
				await expect(receipt(page, kind)).toHaveText(`${kind}: recorded`, { timeout: 30_000 });
			}

			const local = await page.evaluate(() => window.maestro.enterprise.inboxState());
			expect(local?.status.receipts).toMatchObject({ total: 4, byState: { recorded: 4 } });
			const [rcmd, ...rargs] = inputs.readReceipts!;
			const custody = JSON.parse(
				execFileSync(rcmd, [...rargs, published.messageId], { encoding: 'utf8' })
			) as { state: string; idempotencyKey: string }[];
			expect(custody.map((r) => r.state).sort()).toEqual(
				['acknowledged', 'delivered', 'read', 'replied'].sort()
			);
			// One custody receipt per act: four distinct keys, none resent under another.
			expect(new Set(custody.map((r) => r.idempotencyKey)).size).toBe(4);
			expect(filesMentioning(testDataDir, REPLY)).toEqual([]);
		});
	}
});
