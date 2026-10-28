/**
 * @file settings-set.test.ts
 * @description settings set|reset of a lockable key go through the desktop's
 * set_setting (MRC2-06-03B); an unmarked key keeps the file write; with no
 * desktop the file only when the data dir carries no managed binding.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('../../../cli/services/storage', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../cli/services/storage')>()),
	readSettingValue: vi.fn(),
	writeSettingValue: vi.fn(() => true),
	deleteSettingValue: vi.fn(() => true),
	dataDirHasManagedBinding: vi.fn(() => false),
}));
vi.mock('../../../cli/services/maestro-client', () => ({ withMaestroClient: vi.fn() }));

import { settingsSet } from '../../../cli/commands/settings-set';
import { settingsReset } from '../../../cli/commands/settings-reset';
import {
	readSettingValue,
	writeSettingValue,
	deleteSettingValue,
	dataDirHasManagedBinding,
	settingTopLevelValue,
} from '../../../cli/services/storage';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { MaestroNotRunningError } from '../../../cli/services/maestro-not-running';
import { MANAGED_BINDING_FILE_NAME } from '../../../shared/maestro-lib/runtime/data-dir-lock';

const jsonLines = (spy: ReturnType<typeof vi.spyOn>) =>
	spy.mock.calls.map((call: unknown[]) => JSON.parse(String(call[0])) as Record<string, unknown>);
const encore = { cue: true, pianola: false };
/** `encoreFeatures` is the object; every other key (including a dotted path) reads `true`. */
const readEncore = (key: string) => (key === 'encoreFeatures' ? encore : true);
const sent = (key: string, value: unknown) => [
	{ type: 'set_setting', key, value },
	'set_setting_result',
];

describe('settings set|reset of a lockable key (MRC2-06-03B)', () => {
	let logSpy: ReturnType<typeof vi.spyOn>;
	let errorSpy: ReturnType<typeof vi.spyOn>;

	/** The desktop answers every set_setting with `reply`; records what was sent. */
	const desktop = (reply: Record<string, unknown>) => {
		const sendCommand = vi.fn().mockResolvedValue(reply);
		vi.mocked(withMaestroClient).mockImplementation(async (action) =>
			action({ sendCommand } as never)
		);
		return sendCommand;
	};

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(dataDirHasManagedBinding).mockReturnValue(false);
		vi.mocked(writeSettingValue).mockReturnValue(true);
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
			throw new Error(`process.exit(${code})`);
		});
	});

	afterEach(() => vi.restoreAllMocks());

	it('sets through the desktop, never the file; a nested path is folded into its top-level value', async () => {
		vi.mocked(readSettingValue).mockReturnValue('/usr/bin/gh');
		const sendCommand = desktop({ type: 'set_setting_result', success: true, key: 'ghPath' });
		await settingsSet('ghPath', '/opt/gh', { json: true });
		expect(sendCommand).toHaveBeenCalledWith(...sent('ghPath', '/opt/gh'));
		expect(jsonLines(logSpy)[0]).toMatchObject({
			type: 'setting_set',
			oldValue: '/usr/bin/gh',
			newValue: '/opt/gh',
		});
		vi.mocked(readSettingValue).mockImplementation(readEncore);
		await settingsSet('encoreFeatures.cue', 'false', { json: true });
		expect(sendCommand).toHaveBeenLastCalledWith(
			...sent('encoreFeatures', { cue: false, pianola: false })
		);
		expect(writeSettingValue).not.toHaveBeenCalled();
	});

	it('resets through the desktop as a set of the default (a nested path: the top-level value without it)', async () => {
		vi.mocked(readSettingValue).mockReturnValue('/opt/gh');
		const sendCommand = desktop({ success: true });
		await settingsReset('ghPath', { json: true });
		expect(sendCommand).toHaveBeenCalledWith(...sent('ghPath', ''));
		expect(jsonLines(logSpy)[0]).toMatchObject({
			type: 'setting_reset',
			oldValue: '/opt/gh',
			defaultValue: '',
		});
		vi.mocked(readSettingValue).mockImplementation(readEncore);
		await settingsReset('encoreFeatures.cue', { json: true });
		expect(sendCommand).toHaveBeenLastCalledWith(...sent('encoreFeatures', { pianola: false }));
		expect(deleteSettingValue).not.toHaveBeenCalled();
	});

	it("prints the policy's line, with the managed state in JSON, when the desktop refuses", async () => {
		const message = 'the "ghPath" setting is locked by managed policy revision 3';
		const managed = { state: 'denied', code: 'locked' };
		desktop({ type: 'error', message, key: 'ghPath', managed });
		await expect(settingsSet('ghPath', '/opt/gh', { json: true })).rejects.toThrow(
			'process.exit(1)'
		);
		expect(JSON.parse(String(errorSpy.mock.calls[0][0]))).toEqual({ error: message, managed });
		await expect(settingsReset('ghPath', {})).rejects.toThrow('process.exit(1)');
		expect(String(errorSpy.mock.calls[1][0])).toContain(`Failed to reset "ghPath": ${message}`);
		desktop({ success: false });
		await expect(settingsSet('ghPath', '/opt/gh', { json: true })).rejects.toThrow(
			'process.exit(1)'
		);
		expect(writeSettingValue).not.toHaveBeenCalled();
		expect(deleteSettingValue).not.toHaveBeenCalled();
	});

	it('keeps the direct file write for an unmarked key, with no bridge call', async () => {
		await settingsSet('fontSize', '14', { json: true });
		await settingsReset('fontSize', { json: true });
		expect(withMaestroClient).not.toHaveBeenCalled();
		expect(writeSettingValue).toHaveBeenCalledWith('fontSize', 14);
		expect(deleteSettingValue).toHaveBeenCalledWith('fontSize');
	});

	it('with no desktop writes the file as before only when the data dir carries no managed binding', async () => {
		vi.mocked(withMaestroClient).mockRejectedValue(new MaestroNotRunningError('no-discovery-file'));
		await settingsSet('ghPath', '/opt/gh', { json: true });
		await settingsReset('ghPath', { json: true });
		expect(writeSettingValue).toHaveBeenCalledWith('ghPath', '/opt/gh');
		expect(deleteSettingValue).toHaveBeenCalledWith('ghPath');

		vi.clearAllMocks();
		vi.mocked(dataDirHasManagedBinding).mockReturnValue(true);
		await expect(settingsSet('ghPath', '/opt/gh', { json: true })).rejects.toThrow(
			'process.exit(3)'
		);
		expect(jsonLines(logSpy)[0]).toMatchObject({ success: false, code: 'MAESTRO_NOT_RUNNING' });
		await expect(settingsReset('ghPath', {})).rejects.toThrow('process.exit(3)');
		expect(String(errorSpy.mock.calls[0][0])).toContain('Enrolled with a management peer');
		expect(writeSettingValue).not.toHaveBeenCalled();
		expect(deleteSettingValue).not.toHaveBeenCalled();
	});
});

describe('storage: settingTopLevelValue and dataDirHasManagedBinding', () => {
	it('folds a dotted path into a copy of the current top-level value, or hands a top-level value back', () => {
		const current = { cue: true, nested: { a: 1 } };
		expect(settingTopLevelValue('ghPath', '/old', '/new')).toBe('/new');
		expect(settingTopLevelValue('encoreFeatures.cue', current, false)).toEqual({
			cue: false,
			nested: { a: 1 },
		});
		expect(settingTopLevelValue('encoreFeatures.nested.b', current, 2)).toEqual({
			cue: true,
			nested: { a: 1, b: 2 },
		});
		expect(settingTopLevelValue('encoreFeatures.cue', current, undefined)).toEqual({
			nested: { a: 1 },
		});
		expect(current).toEqual({ cue: true, nested: { a: 1 } });
		expect(settingTopLevelValue('encoreFeatures.cue', 'not-an-object', undefined)).toEqual({});
	});

	it('reads the managed binding file of the data dir, present or not', async () => {
		const actual = await vi.importActual<typeof import('../../../cli/services/storage')>(
			'../../../cli/services/storage'
		);
		const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-settings-set-'));
		vi.stubEnv('MAESTRO_USER_DATA', dataDir);
		expect(actual.dataDirHasManagedBinding()).toBe(false);
		fs.writeFileSync(path.join(dataDir, MANAGED_BINDING_FILE_NAME), '{}');
		expect(actual.dataDirHasManagedBinding()).toBe(true);
		vi.unstubAllEnvs();
	});
});
