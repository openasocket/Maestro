/**
 * Settings domain WebSocket message handlers.
 *
 * Extracted from WebSocketMessageHandler.ts. Handles: get_settings, set_setting,
 * set_agent_config_value, reset_agent_config_value.
 */

import type { SettingValue } from '../../types';
import type { WebClient, WebClientMessage, MessageHandlerContext } from './types';
import { isRemoteSettingWritable } from '../bridgeDenyList';
import { holdSettingWrite } from '../../../enterprise/settings-policy';
import type { AgentConfigWriteRequest } from '../../../agents/agent-config-writes';
import { LOCKABLE_SETTING_KEYS } from '../../../../shared/managedSettingsLock';

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

	// Only the CLI-secret-authenticated connection (the owner's shell on this
	// machine, which wrote the file directly before) may write a top-level key
	// the managed settings policy can hold, Encore features among them: that is
	// how `settings set|reset` reaches the hold below (MRC2-06-03B). A browser
	// keeps the allowlist.
	const cliHeldKey = client.cli === true && LOCKABLE_SETTING_KEYS.includes(key);
	if (
		!cliHeldKey &&
		(!Object.prototype.hasOwnProperty.call(ALLOWED_SETTING_KEYS, key) ||
			!isRemoteSettingWritable(key))
	) {
		ctx.sendError(client, `Setting key '${key}' is not modifiable from the web interface`, {
			requestId: message.requestId,
		});
		return;
	}

	if (value === undefined) {
		ctx.sendError(client, 'Missing setting value');
		return;
	}

	// A key the managed settings policy holds is refused here by name (MRC2-06-02),
	// before the renderer round trip would answer a bare `false`; the refusal
	// carries state and code like every other managed refusal on this bridge,
	// and the request id so the CLI's pending call settles on it.
	const hold = holdSettingWrite(key, { value });
	if (!hold.allowed) {
		ctx.sendError(client, hold.message, {
			key,
			managed: { state: hold.code === 'unavailable' ? 'unavailable' : 'denied', code: hold.code },
			requestId: message.requestId,
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

/**
 * Handle set_agent_config_value / reset_agent_config_value - one per-provider
 * configuration value (MRC2-06-03A) by the service agents:setConfigValue calls,
 * which holds the field to the managed settings authority once; a refusal is
 * the typed result. CLI only: a provider's binary path or environment is a
 * launch, so no signed-in browser, local or through the tunnel, writes it.
 */
export function handleAgentConfigValueWrite(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage,
	op: 'set' | 'reset'
): void {
	const providerId = message.providerId as string;
	const key = message.key as string;
	const value = message.value;
	if (client.cli !== true) {
		ctx.sendError(client, 'Provider configuration is written from maestro-cli only');
		return;
	}
	if (!providerId || !key || (op === 'set' && value === undefined)) {
		ctx.sendError(client, 'Missing providerId, key or value');
		return;
	}
	if (!ctx.callbacks.writeAgentConfigValue) {
		ctx.sendError(client, 'Provider configuration writes not configured');
		return;
	}
	const request: AgentConfigWriteRequest =
		op === 'set' ? { op, providerId, key, value } : { op, providerId, key };
	ctx.callbacks
		.writeAgentConfigValue(request)
		.then((outcome) => {
			ctx.send(client, {
				type: `${op}_agent_config_value_result`,
				providerId,
				key,
				requestId: message.requestId,
				...outcome,
			});
		})
		.catch((error) => {
			ctx.sendError(client, `Failed to write provider configuration: ${error.message}`);
		});
}
