/**
 * E2E: creating and editing agents through the real desktop host (MCOMP-23-06).
 *
 * Every journey drives the built Electron app: the New Agent and Edit Agent
 * forms, the real `sessions:*` and `enterprise:*` IPC handlers, and the
 * sessions store on disk. Nothing here replaces a handler with a double.
 *
 * Two modes, chosen with MAESTRO_E2E_MANAGED_MODE:
 *
 * - `fixture` (default). The desktop enrolls, through its own enrollment
 *   lifecycle, against the contract-fixture endpoint daemon
 *   (`src/__tests__/main/enterprise/fakeEndpoint.ts`). That daemon delivers no
 *   approved-choice projection and the desktop installs no reference resolver
 *   (DESKTOP-LOCAL/1 in Plans/integration-completion/contract-coverage.json),
 *   so the journeys prove the fail-closed half: refused create and edit by
 *   name, the draft kept, no host record written, a policy refresh while the
 *   form is open, forged IPC fields and whole-record bypass.
 *
 * - `endpoint`. The desktop enrolls against an actual endpoint socket named by
 *   the JSON file at MAESTRO_E2E_ENDPOINT_INPUTS (shape: `EndpointInputs`).
 *   These are the mandatory positive cases MCOMP-24 runs and records: approved
 *   create and edit persist the host's canonical record, a held choice is
 *   disabled with the policy's reason, and a revision moved under an open form
 *   is refused stale, refreshed and then committed. A missing input FAILS the
 *   run by name; it is never skipped or passed.
 *
 * The standalone journey runs in both modes: an unenrolled desktop keeps
 * creating and editing exactly as before.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { test as base, expect } from './fixtures/electron-app';
import {
	startFakeEndpoint,
	type FakeEndpoint,
} from '../src/__tests__/main/enterprise/fakeEndpoint';

type Mode = 'fixture' | 'endpoint';
type HeldField = 'customPath' | 'customArgs' | 'customEnvVars' | 'model' | 'reasoningEffort';

/** What the endpoint mode needs from the environment that runs it (MCOMP-24). */
interface EndpointInputs {
	socketPath: string;
	enrollment: {
		tenantId: string;
		orgId: string;
		mode: 'attended' | 'managed';
		invitation: string;
		collectionProfile: 'metadata' | 'redacted' | 'full' | 'full_vibes';
		trustRootDigest: string;
		keyPossessionProof: string;
	};
	/** argv the operator's tooling runs to approve a registration; the challenge id is appended. */
	approveRegistration?: string[];
	/** argv that moves the endpoint's applied policy revision forward. */
	bumpPolicy: string[];
	/** The provider row (display name) the policy approves. */
	approvedProvider: string;
	/** A per-provider choice the policy holds for that provider. */
	heldField: HeldField;
}

const MODE = resolveMode(process.env.MAESTRO_E2E_MANAGED_MODE);
const FIXTURE_PROVIDER = 'Claude Code';

function resolveMode(raw: string | undefined): Mode {
	if (raw === undefined || raw === '' || raw === 'fixture') return 'fixture';
	if (raw === 'endpoint') return 'endpoint';
	throw new Error(`MAESTRO_E2E_MANAGED_MODE must be "fixture" or "endpoint", not "${raw}".`);
}

/** Read and check the endpoint inputs; every missing one is named in the failure. */
function readEndpointInputs(): EndpointInputs {
	const file = process.env.MAESTRO_E2E_ENDPOINT_INPUTS;
	if (!file) {
		throw new Error(
			'Endpoint mode needs MAESTRO_E2E_ENDPOINT_INPUTS (a JSON file: socketPath, enrollment, bumpPolicy, approvedProvider, heldField).'
		);
	}
	const inputs = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<EndpointInputs>;
	const missing = [
		!inputs.socketPath && 'socketPath',
		!inputs.enrollment?.invitation && 'enrollment.invitation',
		!inputs.enrollment?.tenantId && 'enrollment.tenantId',
		!inputs.enrollment?.orgId && 'enrollment.orgId',
		!inputs.enrollment?.trustRootDigest && 'enrollment.trustRootDigest',
		!inputs.enrollment?.keyPossessionProof && 'enrollment.keyPossessionProof',
		!inputs.bumpPolicy?.length && 'bumpPolicy',
		!inputs.approvedProvider && 'approvedProvider',
		!inputs.heldField && 'heldField',
	].filter(Boolean);
	if (missing.length) throw new Error(`Endpoint inputs in ${file} lack: ${missing.join(', ')}.`);
	return inputs as EndpointInputs;
}

const test = base.extend<{ projectDir: string }>({
	electronLaunchEnv: async ({ testDataDir }, use) => {
		// Keep first-run pickers out of the way of the forms under test.
		fs.writeFileSync(
			path.join(testDataDir, 'maestro-settings.json'),
			JSON.stringify({
				typographyPromptSeen: true,
				themePromptSeen: true,
				updatesPromptSeen: true,
				agentPowersPromptSeen: true,
			})
		);
		// Fixture mode only: the unpackaged app's labeled fixture native endpoint port
		// (MCOMP-31-05A); endpoint mode clears it.
		await use({
			MAESTRO_USER_DATA: testDataDir,
			MAESTRO_E2E_ENDPOINT_NATIVE: MODE === 'fixture' ? 'fixture' : '',
		});
	},
	// eslint-disable-next-line no-empty-pattern
	projectDir: async ({}, use) => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-e2e-managed-agents-'));
		await use(dir);
		fs.rmSync(dir, { recursive: true, force: true });
	},
});

type HostRecord = { id: string; name: string; toolType: string; cwd: string; customPath?: string };

const hostRecords = (page: Page) =>
	page.evaluate(() => window.maestro.sessions.getAll()) as Promise<HostRecord[]>;

/** The records the sessions store has written to disk (not the renderer's copy). */
function diskRecords(dataDir: string): HostRecord[] {
	const file = path.join(dataDir, 'maestro-sessions.json');
	if (!fs.existsSync(file)) return [];
	return (JSON.parse(fs.readFileSync(file, 'utf8')).sessions ?? []) as HostRecord[];
}

async function openNewAgent(page: Page): Promise<Locator> {
	await page.keyboard.press('Meta+n');
	const dialog = page.getByRole('dialog', { name: 'Create New Agent' });
	await expect(dialog).toBeVisible();
	return dialog;
}

/** Fill the New Agent form with a provider this machine detected. */
async function fillNewAgent(dialog: Locator, provider: string, name: string, dir: string) {
	const row = dialog.getByRole('option', { name: new RegExp(provider) });
	await expect(row, `${provider} must be detected on this machine`).toContainText('Available');
	await row.click();
	await dialog.getByLabel('Agent Name').fill(name);
	await dialog.getByPlaceholder('Select directory...').fill(dir);
	await expect(dialog.getByRole('button', { name: 'Create Agent' })).toBeEnabled();
}

async function openEditAgent(page: Page, name: string): Promise<Locator> {
	// The agent's Left Bar row (the window title and the main header carry the name too).
	await page.locator('[data-nav-key]').filter({ hasText: name }).first().click({ button: 'right' });
	await page.getByRole('button', { name: 'Edit Agent...' }).click();
	const dialog = page.getByRole('dialog', { name: `Edit Agent: ${name}` });
	await expect(dialog).toBeVisible();
	return dialog;
}

/** Create one agent through the form and return the host's canonical record. */
async function createThroughForm(page: Page, provider: string, name: string, dir: string) {
	const dialog = await openNewAgent(page);
	await fillNewAgent(dialog, provider, name, dir);
	await dialog.getByRole('button', { name: 'Create Agent' }).click();
	await expect(dialog).toBeHidden();
	await expect.poll(async () => (await hostRecords(page)).map((r) => r.name)).toContain(name);
	return (await hostRecords(page)).find((r) => r.name === name)!;
}

/** Enroll and register through the desktop's own lifecycle (the real enterprise IPC). */
async function enroll(page: Page, socketPath: string, inputs?: EndpointInputs) {
	const request = {
		socketPath,
		...(inputs?.enrollment ?? {
			tenantId: 'tenant-e2e',
			orgId: 'org-e2e',
			mode: 'managed' as const,
			invitation: 'invitation-e2e',
			collectionProfile: 'metadata' as const,
			trustRootDigest: 'a'.repeat(64),
			keyPossessionProof: 'proof-e2e',
		}),
	};
	const enrolled = await page.evaluate(
		(r) => window.maestro.enterprise.requestEnrollment(r),
		request
	);
	expect(enrolled.status, JSON.stringify(enrolled)).toBe('ok');
	const challenge = await page.evaluate(() => window.maestro.enterprise.beginRegistration());
	expect(challenge.status, JSON.stringify(challenge)).toBe('ok');
	if (inputs?.approveRegistration && challenge.status === 'ok') {
		const [cmd, ...args] = inputs.approveRegistration;
		execFileSync(cmd, [...args, challenge.value.challengeId], { stdio: 'pipe' });
	}
	const registered = await page.evaluate(() => window.maestro.enterprise.completeRegistration());
	expect(registered.status, JSON.stringify(registered)).toBe('ok');
	await expect
		.poll(
			async () => (await page.evaluate(() => window.maestro.enterprise.managedState()))?.standing
		)
		.toBe('managed');
}

test.describe(`agent authoring through the desktop host (${MODE} mode)`, () => {
	test('standalone: New Agent and Edit Agent commit the canonical host record', async ({
		window: page,
		testDataDir,
		projectDir,
	}) => {
		const provider = MODE === 'endpoint' ? readEndpointInputs().approvedProvider : FIXTURE_PROVIDER;
		expect((await page.evaluate(() => window.maestro.enterprise.managedState()))?.standing).toBe(
			'unenrolled'
		);
		const created = await createThroughForm(page, provider, 'E2E Standalone', projectDir);
		expect(created).toMatchObject({ name: 'E2E Standalone', cwd: projectDir });
		await expect.poll(() => diskRecords(testDataDir).map((r) => r.id)).toContain(created.id);

		const dialog = await openEditAgent(page, 'E2E Standalone');
		await expect(dialog.getByTestId('managed-choices-notice')).toHaveCount(0);
		await dialog.getByLabel('Agent Name').fill('E2E Standalone Renamed');
		await dialog.getByRole('button', { name: 'Save Changes' }).click();
		await expect(dialog).toBeHidden();
		await expect
			.poll(async () => (await hostRecords(page)).find((r) => r.id === created.id)?.name)
			.toBe('E2E Standalone Renamed');
		await expect
			.poll(() => diskRecords(testDataDir).find((r) => r.id === created.id)?.name)
			.toBe('E2E Standalone Renamed');
	});

	if (MODE === 'fixture') {
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

			test('no approved choices: create is refused by name, the draft survives a policy refresh', async ({
				window: page,
				testDataDir,
				projectDir,
			}) => {
				await enroll(page, endpoint.socketPath);
				const before = await hostRecords(page);

				const dialog = await openNewAgent(page);
				const notice = dialog.getByTestId('managed-choices-notice');
				await expect(notice.getByTestId('managed-policy-revision')).toContainText('revision 3');
				await expect(notice.getByTestId('managed-choices-unavailable')).toBeVisible();
				await fillNewAgent(dialog, FIXTURE_PROVIDER, 'E2E Refused', projectDir);
				await dialog.getByRole('button', { name: 'Create Agent' }).click();

				const refusal = dialog.getByTestId('managed-refusal');
				await expect(refusal).toContainText('Not created:');
				await expect(refusal).toHaveAttribute('role', 'alert');
				await expect(dialog.getByLabel('Agent Name')).toHaveValue('E2E Refused');
				expect(await hostRecords(page)).toEqual(before);
				expect(diskRecords(testDataDir).map((r) => r.name)).not.toContain('E2E Refused');

				// The endpoint moves its policy while the form is open and the host
				// refreshes (the Managed Status verb); the form's Refresh policy re-reads
				// the host's projection and leaves the draft alone.
				endpoint.options.status = { desiredPolicyRevision: 4, appliedPolicyRevision: 4 };
				const refreshed = await page.evaluate(() => window.maestro.enterprise.refreshPolicy());
				expect(refreshed.status, JSON.stringify(refreshed)).toBe('ok');
				await notice.getByRole('button', { name: 'Refresh policy' }).click();
				await expect(notice.getByTestId('managed-policy-revision')).toContainText('revision 4');
				await expect(dialog.getByLabel('Agent Name')).toHaveValue('E2E Refused');
				await expect(dialog.getByPlaceholder('Select directory...')).toHaveValue(projectDir);
				expect(await hostRecords(page)).toEqual(before);
			});

			test('an existing agent: an ungoverned edit saves, a governed edit is refused and changes nothing', async ({
				window: page,
				testDataDir,
				projectDir,
			}) => {
				const original = await createThroughForm(page, FIXTURE_PROVIDER, 'E2E Held', projectDir);
				await enroll(page, endpoint.socketPath);

				const stored = () => hostRecords(page).then((all) => all.find((r) => r.id === original.id));

				// A name is not a governed choice: the managed host saves it.
				let dialog = await openEditAgent(page, 'E2E Held');
				await expect(dialog.getByTestId('managed-choices-unavailable')).toBeVisible();
				await dialog.getByLabel('Agent Name').fill('E2E Held Renamed');
				await dialog.getByRole('button', { name: 'Save Changes' }).click();
				await expect(dialog).toBeHidden();
				await expect.poll(async () => (await stored())?.name).toBe('E2E Held Renamed');

				// The working directory is: refused by name, the draft stays open.
				const elsewhere = path.join(projectDir, 'elsewhere');
				fs.mkdirSync(elsewhere);
				dialog = await openEditAgent(page, 'E2E Held Renamed');
				await dialog.locator('#edit-agent-working-dir-input').fill(elsewhere);
				await dialog.getByRole('button', { name: 'Save Changes' }).click();
				const refusal = dialog.getByTestId('managed-refusal');
				await expect(refusal).toContainText('Not saved:');
				await expect(refusal).toHaveAttribute('role', 'alert');
				await expect(dialog.locator('#edit-agent-working-dir-input')).toHaveValue(elsewhere);
				expect((await stored())?.cwd).toBe(projectDir);
				await dialog.getByRole('button', { name: 'Cancel' }).click();

				// A renderer that skips the form: verdict-shaped request fields are
				// ignored and the host answers from its own standing.
				const forged = await page.evaluate(
					(record) =>
						window.maestro.sessions.commitAgent({
							operation: 'create',
							record: { ...record, id: 'e2e-forged', name: 'E2E Forged' },
							expectedPolicyRevision: 3,
							...{ ok: true, allowed: true, managed: false, fields: [] },
						} as Parameters<typeof window.maestro.sessions.commitAgent>[0]),
					original as unknown as Record<string, unknown>
				);
				expect(forged).toMatchObject({ ok: false, code: 'unavailable' });

				// Whole-record bypass: a raw store write cannot carry a governed field in.
				const full = (await page.evaluate(() => window.maestro.sessions.getAll())).find(
					(r: { id: string }) => r.id === original.id
				);
				await page.evaluate(
					(record) =>
						window.maestro.sessions.setMany([
							{ ...record, customPath: '/tmp/e2e-unapproved-binary' },
						] as Parameters<typeof window.maestro.sessions.setMany>[0]),
					full
				);
				expect((await stored())?.customPath).toBe(original.customPath);
				const all = await hostRecords(page);
				expect(all.map((r) => r.id)).not.toContain('e2e-forged');
				await expect
					.poll(() => diskRecords(testDataDir).find((r) => r.id === original.id)?.customPath)
					.toBe(original.customPath);
			});
		});
	}

	if (MODE === 'endpoint') {
		test('approved create and edit persist, a held choice says why, a stale form recovers', async ({
			window: page,
			testDataDir,
			projectDir,
		}) => {
			const inputs = readEndpointInputs();
			await enroll(page, inputs.socketPath, inputs);

			// Approved create, with the held choice disabled and explained.
			let dialog = await openNewAgent(page);
			await fillNewAgent(dialog, inputs.approvedProvider, 'E2E Approved', projectDir);
			await expect(dialog.getByTestId('managed-choices-unavailable')).toHaveCount(0);
			const held = dialog.getByTestId(`held-by-policy-${inputs.heldField}`);
			await expect(held).toContainText('Held by policy:');
			await expect(dialog.locator('fieldset[disabled]').filter({ has: held })).toHaveCount(1);
			await dialog.getByRole('button', { name: 'Create Agent' }).click();
			await expect(dialog).toBeHidden();
			const approved = (await hostRecords(page)).find((r) => r.name === 'E2E Approved');
			expect(approved).toMatchObject({ cwd: projectDir });
			await expect.poll(() => diskRecords(testDataDir).map((r) => r.id)).toContain(approved!.id);

			// The policy moves under an open form: stale, refreshed, then committed.
			dialog = await openNewAgent(page);
			await fillNewAgent(dialog, inputs.approvedProvider, 'E2E After Refresh', projectDir);
			const [cmd, ...args] = inputs.bumpPolicy;
			execFileSync(cmd, args, { stdio: 'pipe' });
			await dialog.getByRole('button', { name: 'Create Agent' }).click();
			await expect(dialog.getByTestId('managed-refusal')).toContainText(
				'The policy changed while this form was open'
			);
			await expect(dialog.getByLabel('Agent Name')).toHaveValue('E2E After Refresh');
			expect((await hostRecords(page)).map((r) => r.name)).not.toContain('E2E After Refresh');
			await dialog.getByRole('button', { name: 'Create Agent' }).click();
			await expect(dialog).toBeHidden();
			await expect
				.poll(async () => (await hostRecords(page)).map((r) => r.name))
				.toContain('E2E After Refresh');

			// Approved edit of an ungoverned field persists on the host.
			dialog = await openEditAgent(page, 'E2E Approved');
			await dialog.getByLabel('Agent Name').fill('E2E Approved Renamed');
			await dialog.getByRole('button', { name: 'Save Changes' }).click();
			await expect(dialog).toBeHidden();
			await expect
				.poll(() => diskRecords(testDataDir).find((r) => r.id === approved!.id)?.name)
				.toBe('E2E Approved Renamed');
		});
	}
});
