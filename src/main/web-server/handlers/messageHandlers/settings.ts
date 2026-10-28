/**
 * Settings domain WebSocket message handlers.
 *
 * Extracted from WebSocketMessageHandler.ts. Handles: get_settings, set_setting.
 */

import type { SettingValue } from '../../types';
import type { WebClient, WebClientMessage, MessageHandlerContext } from './types';
import { isRemoteSettingWritable } from '../bridgeDenyList';
import { holdSettingWrite } from '../../../enterprise/settings-policy';

/**
 * Allowlist of setting keys modifiable from the web interface.
 */
const ALLOWED_SETTING_KEYS: Record<string, true> = {
	activeThemeId: true,
	customThemeColors: true,
	customThemeBaseId: true,
	themeGloss: true,
	fontSize: true,
	enterToSendAI: true,
	defaultSaveToHistory: true,
	defaultShowThinking: true,
	notificationsEnabled: true,
	audioFeedbackEnabled: true,
	colorBlindMode: true,
	conductorProfile: true,
	maxOutputLines: true,
};

/**
 * Handle get_settings message - return current settings
 */
export function handleGetSettings(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	if (!ctx.callbacks.getSettings) {
		ctx.sendError(client, 'Settings not configured');
		return;
	}

	const settings = ctx.callbacks.getSettings();
	ctx.send(client, {
		type: 'settings',
		settings,
		requestId: message.requestId,
	});
}

/**
 * Handle set_setting message - modify a single setting
 */
export function handleSetSetting(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const key = message.key as string;
	const value = message.value as SettingValue;

	if (!key || typeof key !== 'string') {
		ctx.sendError(client, 'Missing or invalid setting key');
		return;
	}

	// Only the CLI-secret-authenticated connection may control Encore features.
	const cliEncoreControl = client.cli === true && key === 'encoreFeatures';
	if (
		!cliEncoreControl &&
		(!Object.prototype.hasOwnProperty.call(ALLOWED_SETTING_KEYS, key) ||
			!isRemoteSettingWritable(key))
	) {
		ctx.sendError(client, `Setting key '${key}' is not modifiable from the web interface`);
		return;
	}

	if (value === undefined) {
		ctx.sendError(client, 'Missing setting value');
		return;
	}

	// A key the managed settings policy holds is refused here by name (MRC2-06-02),
	// before the renderer round trip would answer a bare `false`; the refusal
	// carries state and code like every other managed refusal on this bridge.
	const hold = holdSettingWrite(key);
	if (!hold.allowed) {
		ctx.sendError(client, hold.message, {
			key,
			managed: { state: hold.code === 'locked' ? 'denied' : 'unavailable', code: hold.code },
		});
		return;
	}

	if (!ctx.callbacks.setSetting) {
		ctx.sendError(client, 'Setting modification not configured');
		return;
	}

	ctx.callbacks
		.setSetting(key, value)
		.then((success) => {
			ctx.send(client, {
				type: 'set_setting_result',
				success,
				key,
				requestId: message.requestId,
			});
		})
		.catch((error) => {
			ctx.sendError(client, `Failed to set setting: ${error.message}`);
		});
}
