// Set a single setting value
// Supports dot-notation, auto type coercion, --raw for explicit JSON.
// A key the managed settings policy can hold is written through the running
// desktop, which holds it (MRC2-06-03B); the file directly only for any other
// key, or with no desktop and no managed binding.

import { readSettingValue, writeSettingValue, settingTopLevelValue } from '../services/storage';
import {
	reportDesktopWriteFailure,
	setSettingThroughDesktop,
} from '../services/managed-desktop-write';
import { formatSuccess, formatWarning } from '../output/formatter';
import { emitJsonl } from '../output/jsonl';
import { SETTINGS_METADATA } from '../../shared/settingsMetadata';
import { LOCKABLE_SETTING_KEYS } from '../../shared/managedSettingsLock';
import { resolveMediaModelDirectory } from '../../main/plugins/plugin-media-tools';

interface SettingsSetOptions {
	json?: boolean;
	raw?: string;
}

/**
 * Parse a CLI value string into the appropriate JS type.
 * - "true"/"false" → boolean
 * - numeric strings → number
 * - "null" → null
 * - JSON arrays/objects → parsed
 * - everything else → string
 */
function parseValue(input: string): unknown {
	if (input === 'true') return true;
	if (input === 'false') return false;
	if (input === 'null') return null;

	// Try number (but not empty string or strings with leading zeros like "007")
	if (input !== '' && !/^0\d/.test(input)) {
		const num = Number(input);
		if (!isNaN(num) && isFinite(num)) return num;
	}

	// Try JSON for arrays/objects
	if (input.startsWith('[') || input.startsWith('{')) {
		try {
			return JSON.parse(input);
		} catch {
			// Fall through to string
		}
	}

	return input;
}

export async function settingsSet(
	key: string,
	value: string,
	options: SettingsSetOptions
): Promise<void> {
	try {
		const oldValue = readSettingValue(key);
		const topKey = key.split('.')[0];
		const meta = SETTINGS_METADATA[topKey];

		// Warn on unknown keys but allow (schema uses [key: string]: any)
		if (!meta && !options.json) {
			console.error(formatWarning(`"${key}" is not a known setting. Writing anyway.`));
		}

		// Parse the value
		let parsedValue: unknown;
		if (options.raw !== undefined) {
			try {
				parsedValue = JSON.parse(options.raw);
			} catch (e) {
				throw new Error(`Invalid JSON in --raw: ${e instanceof Error ? e.message : String(e)}`);
			}
		} else {
			parsedValue = parseValue(value);
		}

		if (topKey === 'mediaModelDirectory') {
			if (key !== topKey) throw new Error('mediaModelDirectory does not accept nested keys');
			parsedValue = await resolveMediaModelDirectory(parsedValue);
		}
		// A nested path is folded into its top-level value, the shape the
		// desktop's set_setting takes; the desktop holds the key to the managed
		// settings authority. A refusal is thrown as the policy's line.
		const written =
			LOCKABLE_SETTING_KEYS.includes(topKey) &&
			(await setSettingThroughDesktop(
				topKey,
				settingTopLevelValue(key, readSettingValue(topKey), parsedValue),
				options.json
			));
		if (!written && !writeSettingValue(key, parsedValue))
			throw new Error('Could not persist setting');

		if (options.json) {
			emitJsonl({
				type: 'setting_set',
				key,
				oldValue,
				newValue: parsedValue,
			});
		} else {
			console.log(formatSuccess(`${key} = ${JSON.stringify(parsedValue)}`));
		}
	} catch (error) {
		reportDesktopWriteFailure(error, options.json, `set "${key}"`);
	}
}
