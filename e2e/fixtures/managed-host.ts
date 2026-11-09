/**
 * Shared harness for the managed-run e2e journeys (MCOMP-25-04):
 * `managed-agent-run.spec.ts` and `managed-recovery.spec.ts`.
 *
 * Everything here drives the built Electron app through its own surfaces: the
 * New Agent form, the composer, the real `sessions:*`, `process:*` and
 * `enterprise:*` IPC handlers, and the stores on disk.
 *
 * The one double is the ENDPOINT, and it is labeled: in `fixture` mode the
 * desktop enrolls against the contract-fixture daemon
 * `src/__tests__/main/enterprise/fakeEndpoint.ts`, which speaks the socket
 * protocol and holds no policy, no device key and no prepared-execution
 * grant, so it proves the fail-closed half only. In `endpoint` mode the
 * desktop enrolls against an actual endpoint socket named by the JSON file at
 * MAESTRO_E2E_ENDPOINT_INPUTS; those are the mandatory paired cases MCOMP-26
 * executes and records. A missing input fails the run by name; nothing here
 * skips or passes a case the infrastructure cannot run.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, type Locator, type Page } from '@playwright/test';
import { test as base, expect } from './electron-app';

export type ManagedMode = 'fixture' | 'endpoint';

/** What endpoint mode needs from the environment that runs it (MCOMP-26). */
export interface ManagedRunEndpointInputs {
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
	/** The provider row (display name) the policy approves for a run. */
	approvedProvider: string;
	/** A prompt whose turn the policy admits and whose reply contains `expectOutput`. */
	approvedPrompt: string;
	expectOutput: string;
	/** A prompt whose turn reaches for an effect (a command, a file write) the policy refuses. */
	deniedEffectPrompt: string;
	/** A file the denied effect would have written, relative to the agent's working directory. */
	deniedEffectPath: string;
	/** A prompt that keeps the turn running long enough to tighten or revoke under it. */
	longPrompt: string;
	/** argv that moves the applied policy to a revision that no longer admits the approved provider. */
	tightenPolicy: string[];
	/** argv that restores the approving policy. */
	restorePolicy: string[];
	/** argv that revokes this installation's registration on the endpoint. */
	revokeRegistration: string[];
	/**
	 * argv that takes the endpoint offline and brings it back (the offline and
	 * restart case only; that case fails by name when either is missing).
	 */
	takeOffline?: string[];
	restoreOnline?: string[];
	/**
	 * The secondary-effects case only: a repository origin the signed repository
	 * ceiling admits, and one it does not name.
	 */
	inScopeRepository?: string;
	outOfScopeRepository?: string;
	/**
	 * The commands and notices case only: argv that publishes a notice to this
	 * installation and prints `{"messageId","body"}`, and argv that takes the
	 * messageId and prints the endpoint's receipt custody `[{"state","idempotencyKey"}]`.
	 */
	publishNotice?: string[];
	readNoticeReceipts?: string[];
}

export const MANAGED_MODE = resolveManagedMode(process.env.MAESTRO_E2E_MANAGED_MODE);

/** The provider row the fixture journeys pick; its binary is replaced by a recording stub. */
export const FIXTURE_PROVIDER = 'Claude Code';

export function resolveManagedMode(raw: string | undefined): ManagedMode {
	if (raw === undefined || raw === '' || raw === 'fixture') return 'fixture';
	if (raw === 'endpoint') return 'endpoint';
	throw new Error(`MAESTRO_E2E_MANAGED_MODE must be "fixture" or "endpoint", not "${raw}".`);
}

/** Read and check the endpoint inputs; every missing one is named in the failure. */
export function readRunEndpointInputs(): ManagedRunEndpointInputs {
	const file = process.env.MAESTRO_E2E_ENDPOINT_INPUTS;
	if (!file) {
		throw new Error(
			'Endpoint mode needs MAESTRO_E2E_ENDPOINT_INPUTS (a JSON file: socketPath, enrollment, approvedProvider, approvedPrompt, expectOutput, deniedEffectPrompt, deniedEffectPath, longPrompt, tightenPolicy, restorePolicy, revokeRegistration).'
		);
	}
	const inputs = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<ManagedRunEndpointInputs>;
	const missing = [
		!inputs.socketPath && 'socketPath',
		!inputs.enrollment?.invitation && 'enrollment.invitation',
		!inputs.enrollment?.tenantId && 'enrollment.tenantId',
		!inputs.enrollment?.orgId && 'enrollment.orgId',
		!inputs.enrollment?.trustRootDigest && 'enrollment.trustRootDigest',
		!inputs.enrollment?.keyPossessionProof && 'enrollment.keyPossessionProof',
		!inputs.approvedProvider && 'approvedProvider',
		!inputs.approvedPrompt && 'approvedPrompt',
		!inputs.expectOutput && 'expectOutput',
		!inputs.deniedEffectPrompt && 'deniedEffectPrompt',
		!inputs.deniedEffectPath && 'deniedEffectPath',
		!inputs.longPrompt && 'longPrompt',
		!inputs.tightenPolicy?.length && 'tightenPolicy',
		!inputs.restorePolicy?.length && 'restorePolicy',
		!inputs.revokeRegistration?.length && 'revokeRegistration',
	].filter(Boolean);
	if (missing.length) throw new Error(`Endpoint inputs in ${file} lack: ${missing.join(', ')}.`);
	return inputs as ManagedRunEndpointInputs;
}

/** Run one operator argv from the endpoint inputs. */
export function runOperator(argv: string[], extra: string[] = []): void {
	const [cmd, ...args] = argv;
	execFileSync(cmd, [...args, ...extra], { stdio: 'pipe' });
}

/** First-run pickers stay out of the way of the surfaces under test. */
export function seedQuietSettings(dataDir: string): void {
	fs.writeFileSync(
		path.join(dataDir, 'maestro-settings.json'),
		JSON.stringify({
			typographyPromptSeen: true,
			themePromptSeen: true,
			updatesPromptSeen: true,
			agentPowersPromptSeen: true,
		})
	);
}

/**
 * A provider binary that records every launch and answers one turn in Claude
 * Code's stream-json shape. A launch the host refused at the sink never
 * reaches it, so `launches()` is the ground truth for "nothing ran".
 */
export interface StubProvider {
	binary: string;
	reply: string;
	/** Every launch's argv (detection probes excluded): turns, slash-command probes, tab naming. */
	launches(): string[];
	/** Whether a prompt containing `text` reached the provider (`--print` takes it in argv). */
	sawPrompt(text: string): boolean;
}

function writeStubProvider(dir: string): StubProvider {
	const binary = path.join(dir, 'stub-claude');
	const log = path.join(dir, 'launches.log');
	const reply = 'stub provider reply';
	const lines = [
		JSON.stringify({ type: 'system', subtype: 'init', session_id: 'stub-session' }),
		JSON.stringify({
			type: 'assistant',
			session_id: 'stub-session',
			message: { role: 'assistant', content: [{ type: 'text', text: reply }] },
		}),
		JSON.stringify({
			type: 'result',
			subtype: 'success',
			is_error: false,
			result: reply,
			session_id: 'stub-session',
		}),
	];
	fs.writeFileSync(
		binary,
		[
			'#!/bin/sh',
			`echo "$*" >> '${log}'`,
			...lines.map((line) => `printf '%s\\n' '${line}'`),
			'exit 0',
			'',
		].join('\n'),
		{ mode: 0o755 }
	);
	return {
		binary,
		reply,
		// A turn launch, not a detection probe (`--version` and the like).
		launches: () =>
			fs.existsSync(log)
				? fs
						.readFileSync(log, 'utf8')
						.split('\n')
						.filter((line) => line.includes('stream-json'))
				: [],
		sawPrompt: (text) => fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes(text),
	};
}

/**
 * Seed the recording stub as the fixture provider's binary in the isolated
 * data dir BEFORE the app starts, so detection and every spawn resolve to it
 * and no fixture journey can ever reach the real provider. (A whole-record
 * `customPath` written over IPC does not reach the renderer's copy of the
 * agent, so it is not a safe way to swap the binary.)
 */
export function seedStubProvider(dataDir: string, stub: StubProvider): void {
	fs.writeFileSync(
		path.join(dataDir, 'maestro-agent-configs.json'),
		JSON.stringify({ configs: { 'claude-code': { customPath: stub.binary } } })
	);
}

export const managedTest = base.extend<{ projectDir: string; stub: StubProvider }>({
	electronLaunchEnv: async ({ testDataDir, stub }, use) => {
		seedQuietSettings(testDataDir);
		if (MANAGED_MODE === 'fixture') seedStubProvider(testDataDir, stub);
		// Fixture mode only: the unpackaged app installs its labeled fixture native
		// endpoint port so macOS/Windows can enroll against the fixture daemon.
		// Endpoint mode clears it (even if the shell exported it): a real endpoint
		// needs a real native port.
		await use({
			MAESTRO_USER_DATA: testDataDir,
			MAESTRO_E2E_ENDPOINT_NATIVE: MANAGED_MODE === 'fixture' ? 'fixture' : '',
		});
	},
	// eslint-disable-next-line no-empty-pattern
	projectDir: async ({}, use) => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-e2e-managed-run-'));
		await use(dir);
		fs.rmSync(dir, { recursive: true, force: true });
	},
	// eslint-disable-next-line no-empty-pattern
	stub: async ({}, use) => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-e2e-stub-provider-'));
		await use(writeStubProvider(dir));
		fs.rmSync(dir, { recursive: true, force: true });
	},
});

export type HostRecord = {
	id: string;
	name: string;
	toolType: string;
	cwd: string;
	customPath?: string;
};

export const hostRecords = (page: Page) =>
	page.evaluate(() => window.maestro.sessions.getAll()) as Promise<HostRecord[]>;

export const managedState = (page: Page) =>
	page.evaluate(() => window.maestro.enterprise.managedState());

/** Create one agent through the New Agent form and return the host's canonical record. */
export async function createAgent(page: Page, provider: string, name: string, dir: string) {
	await page.keyboard.press('Meta+n');
	const dialog = page.getByRole('dialog', { name: 'Create New Agent' });
	await expect(dialog).toBeVisible();
	const row = dialog.getByRole('option', { name: new RegExp(provider) });
	await expect(row, `${provider} must be detected on this machine`).toContainText('Available');
	await row.click();
	await dialog.getByLabel('Agent Name').fill(name);
	await dialog.getByPlaceholder('Select directory...').fill(dir);
	await dialog.getByRole('button', { name: 'Create Agent' }).click();
	await expect(dialog).toBeHidden();
	await expect.poll(async () => (await hostRecords(page)).map((r) => r.name)).toContain(name);
	return (await hostRecords(page)).find((r) => r.name === name)!;
}

/** Fail before any send unless the fixture provider resolves to the recording stub. */
export async function expectStubProvider(page: Page, stub: StubProvider) {
	expect(await page.evaluate(() => window.maestro.agents.getCustomPath('claude-code'))).toBe(
		stub.binary
	);
}

/** The composer of the agent the Main Window shows. */
export function composer(page: Page, agentName: string): Locator {
	return page.getByPlaceholder(new RegExp(`^Talking to ${agentName} powered by`));
}

/** Send one turn from the composer, the way a person does. */
export async function sendTurn(page: Page, agentName: string, text: string) {
	const box = composer(page, agentName);
	await expect(box).toBeVisible();
	await box.fill(text);
	await box.press('Enter');
}

/** The managed run state above the composer, and its parts. */
export function runState(page: Page) {
	const root = page.getByTestId('ai-tab-managed-run').getByTestId('managed-run-state');
	return {
		root,
		word: root.getByTestId('managed-run-state-word'),
		reason: root.getByTestId('managed-run-state-reason'),
		ids: root.getByTestId('managed-run-state-ids'),
		action: (hint: RegExp) => root.getByRole('button', { name: hint }),
	};
}

export const RUN_ACTION = {
	stop: /^Stop this turn/,
	retry: /^Send this turn again/,
	refresh: /^Read this run back/,
	refreshPolicy: /^Ask the endpoint for the current policy/,
} as const;

/** The active AI tab's persisted `managedRun` / `managedRefusal`, read from the host store. */
export async function activeTabManaged(page: Page, agentId: string) {
	return page.evaluate(async (id) => {
		const all = await window.maestro.sessions.getAll();
		const record = all.find((r: { id: string }) => r.id === id) as
			| {
					activeTabId?: string;
					aiTabs?: Array<{ id: string; managedRun?: unknown; managedRefusal?: unknown }>;
			  }
			| undefined;
		const tab = record?.aiTabs?.find((t) => t.id === record.activeTabId) ?? record?.aiTabs?.[0];
		return {
			managedRun: (tab?.managedRun ?? null) as { leaseId: string; policyRevision: number } | null,
			managedRefusal: (tab?.managedRefusal ?? null) as {
				state: string;
				code: string;
				message: string;
			} | null,
		};
	}, agentId);
}

/** What fixture mode enrolls with; none of it may be stored in the clear. */
export const FIXTURE_ENROLLMENT: ManagedRunEndpointInputs['enrollment'] = {
	tenantId: 'tenant-e2e',
	orgId: 'org-e2e',
	mode: 'managed',
	invitation: 'invitation-e2e',
	collectionProfile: 'metadata',
	trustRootDigest: 'a'.repeat(64),
	keyPossessionProof: 'proof-e2e',
};

/** Enroll and register through the desktop's own lifecycle (the real enterprise IPC). */
export async function enroll(page: Page, socketPath: string, inputs?: ManagedRunEndpointInputs) {
	const request = { socketPath, ...(inputs?.enrollment ?? FIXTURE_ENROLLMENT) };
	const enrolled = await page.evaluate(
		(r) => window.maestro.enterprise.requestEnrollment(r),
		request
	);
	expect(enrolled.status, JSON.stringify(enrolled)).toBe('ok');
	await register(page, inputs);
}

/**
 * Register this process with the endpoint through the desktop's own lifecycle.
 * A registration belongs to the process that made it, so a restarted desktop
 * registers again before it is managed.
 */
export async function register(page: Page, inputs?: ManagedRunEndpointInputs) {
	const challenge = await page.evaluate(() => window.maestro.enterprise.beginRegistration());
	expect(challenge.status, JSON.stringify(challenge)).toBe('ok');
	if (inputs?.approveRegistration && challenge.status === 'ok') {
		runOperator(inputs.approveRegistration, [challenge.value.challengeId]);
	}
	const registered = await page.evaluate(() => window.maestro.enterprise.completeRegistration());
	expect(registered.status, JSON.stringify(registered)).toBe('ok');
	await expect.poll(async () => (await managedState(page))?.standing).toBe('managed');
}

export { expect };

/** Close the app's agent-error dialog when a failed send raised one. */
export async function dismissErrorDialog(page: Page) {
	const dialog = page.getByRole('dialog', { name: 'Error' });
	await dialog.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined);
	if (await dialog.isVisible()) {
		await page.keyboard.press('Escape');
		await expect(dialog).toBeHidden();
	}
}

/** Launch the built app again over the same data directory, as the fixture launches it. */
export async function relaunch(appPath: string, env: Record<string, string>, dataDir: string) {
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
