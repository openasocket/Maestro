// Reset a setting to its default value
// Removes the key from the store so the default takes effect. A key the
// managed settings policy can hold is reset through the running desktop,
// which holds it (MRC2-06-03B): the bridge carries no delete, so the desktop
// is sent the default (a nested path: its top-level value with the path
// removed). The file directly only for any other key, or with no desktop and
// no managed binding.

import { readSettingValue, deleteSettingValue, settingTopLevelValue } from '../services/storage';
import {
	reportDesktopWriteFailure,
	setSettingThroughDesktop,
} from '../services/managed-desktop-write';
import { formatSuccess } from '../output/formatter';
import { emitJsonl } from '../output/jsonl';
import { SETTINGS_METADATA, getSettingDefault } from '../../shared/settingsMetadata';
import { LOCKABLE_SETTING_KEYS } from '../../shared/managedSettingsLock';

interface SettingsResetOptions {
	json?: boolean;
}

export async function settingsReset(key: string, options: SettingsResetOptions): Promise<void> {
	try {
		const topKey = key.split('.')[0];
		const meta = SETTINGS_METADATA[topKey];

		if (!meta) {
			throw new Error(
				`Unknown setting: "${key}". Use "maestro-cli settings list --keys-only" to see all available keys.`
			);
		}

		const oldValue = readSettingValue(key);
		const defaultValue = getSettingDefault(topKey);

		const reset =
			LOCKABLE_SETTING_KEYS.includes(topKey) &&
			(await setSettingThroughDesktop(
				topKey,
				key === topKey
					? (defaultValue ?? null)
					: settingTopLevelValue(key, readSettingValue(topKey), undefined),
				options.json
			));
		if (!reset) deleteSettingValue(key);

		if (options.json) {
			emitJsonl({
				type: 'setting_reset',
				key,
				oldValue,
				defaultValue,
			});
		} else {
			console.log(formatSuccess(`${key} reset to default (${JSON.stringify(defaultValue)})`));
		}
	} catch (error) {
		reportDesktopWriteFailure(error, options.json, `reset "${key}"`);
	}
}
