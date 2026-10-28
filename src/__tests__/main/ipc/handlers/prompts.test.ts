/**
 * The prompts IPC handlers under the managed settings lock (MRC2-06-04): a held
 * save or reset answers the policy's line and touches nothing, standalone is
 * unchanged, and `restoreManagedPromptPins()` brings the set to the pin.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setSettingsWriteAuthority } from '../../../../main/enterprise/settings-policy';
import { installManagedSettingsPolicy } from '../../../helpers/managedSettingsPolicy';

const handlers = new Map<string, (...args: unknown[]) => unknown>();
vi.mock('electron', () => ({
	app: { getPath: () => '/tmp' },
	ipcMain: {
		handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
	},
}));
vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
const pm = vi.hoisted(() => ({
	arePromptsInitialized: vi.fn(() => true),
	savePrompt: vi.fn(async () => {}),
	resetPrompt: vi.fn(async () => 'bundled'),
	getAllPrompts: vi.fn((): { id: string; content: string; isModified: boolean }[] => []),
}));
vi.mock('../../../../main/prompt-manager', () => ({ ...pm }));

import {
	registerPromptsHandlers,
	restoreManagedPromptPins,
} from '../../../../main/ipc/handlers/prompts';

const PROMPTS = 'prompts.customizations';

beforeEach(() => {
	handlers.clear();
	vi.clearAllMocks();
	registerPromptsHandlers();
});
afterEach(() => setSettingsWriteAuthority(null));

it('save writes standalone; a held set answers the policy line with its code and writes nothing', async () => {
	const save = handlers.get('prompts:save')!;
	await expect(save({}, 'wizard-system', 'x')).resolves.toEqual({ success: true });
	expect(pm.savePrompt).toHaveBeenCalledWith('wizard-system', 'x');
	installManagedSettingsPolicy([{ key: PROMPTS }]);
	const refused = {
		success: false,
		error: `the "${PROMPTS}" setting is locked by managed policy revision 3`,
		managed: { code: 'locked', policyRevision: 3 },
	};
	await expect(save({}, 'wizard-system', 'y')).resolves.toEqual(refused);
	await expect(handlers.get('prompts:reset')!({}, 'wizard-system')).resolves.toEqual(refused);
	expect(pm.savePrompt).toHaveBeenCalledTimes(1);
	expect(pm.resetPrompt).not.toHaveBeenCalled();
});

describe('restoreManagedPromptPins', () => {
	it('saves each pinned prompt that differs, resets each other customization, then holds still', async () => {
		pm.getAllPrompts.mockReturnValue([
			{ id: 'wizard-system', content: 'old', isModified: true },
			{ id: 'wizard-system-continuation', content: 'custom', isModified: true },
			{ id: 'wizard-document-generation', content: 'bundled', isModified: false },
		]);
		const unpinned = installManagedSettingsPolicy([{ key: PROMPTS }]);
		await expect(restoreManagedPromptPins(unpinned.pins())).resolves.toEqual([]);
		await expect(restoreManagedPromptPins(null)).resolves.toEqual([]);
		const pinned = installManagedSettingsPolicy([
			{ key: PROMPTS, pin: { value: { 'wizard-system': 'pinned' } } },
		]);
		await expect(restoreManagedPromptPins(pinned.pins())).resolves.toEqual([
			'wizard-system',
			'wizard-system-continuation',
		]);
		expect(pm.savePrompt.mock.calls).toEqual([['wizard-system', 'pinned']]);
		expect(pm.resetPrompt.mock.calls).toEqual([['wizard-system-continuation']]);
		pm.getAllPrompts.mockReturnValue([
			{ id: 'wizard-system', content: 'pinned', isModified: true },
		]);
		await expect(restoreManagedPromptPins(pinned.pins())).resolves.toEqual([]);
		expect(pm.savePrompt).toHaveBeenCalledTimes(1);
	});
});
