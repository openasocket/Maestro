import type { WebServer } from '../WebServer';
import type { WebServerFactoryDependencies } from '../web-server-factory';
import type { StoredSession } from '../../stores/types';
import { logger } from '../../utils/logger';
import { getDefaultShell } from '../../stores/defaults';
import { currentSpawnActor } from '../../ipc/handlers/process/handle-spawn';
import { describeTransportAdmission, getActingTransport } from '../auth/transport-actor';

export function registerTerminalCallbacks(
	server: WebServer,
	deps: Pick<WebServerFactoryDependencies, 'getProcessManager' | 'sessionsStore' | 'settingsStore'>
): void {
	const { getProcessManager, sessionsStore, settingsStore } = deps;

	// Set up callback for web server to write commands to sessions
	// Note: Process IDs have -ai or -terminal suffix based on session's inputMode
	server.setWriteToSessionCallback((sessionId: string, data: string) => {
		const processManager = getProcessManager();
		if (!processManager) {
			logger.warn('processManager is null for writeToSession', 'WebServer');
			return false;
		}

		// Get the session's current inputMode to determine which process to write to
		const sessions = sessionsStore.get<StoredSession[]>('sessions', []);
		const session = sessions.find((s) => s.id === sessionId);
		if (!session) {
			logger.warn(`Session ${sessionId} not found for writeToSession`, 'WebServer');
			return false;
		}

		// Append -ai or -terminal suffix based on inputMode
		const targetSessionId =
			session.inputMode === 'ai' ? `${sessionId}-ai` : `${sessionId}-terminal`;
		logger.debug(`Writing to ${targetSessionId} (inputMode=${session.inputMode})`, 'WebServer');

		const result = processManager.write(targetSessionId, data);
		logger.debug(`Write result: ${result}`, 'WebServer');
		return result;
	});

	// Set up callbacks for raw terminal PTY write and resize (for xterm.js in web client)
	server.setWriteToTerminalCallback((sessionId: string, data: string) => {
		const processManager = getProcessManager();
		if (!processManager) {
			logger.warn('processManager is null for writeToTerminal', 'WebServer');
			return false;
		}
		return processManager.write(`${sessionId}-terminal`, data);
	});

	server.setResizeTerminalCallback((sessionId: string, cols: number, rows: number) => {
		const processManager = getProcessManager();
		if (!processManager) {
			logger.warn('processManager is null for resizeTerminal', 'WebServer');
			return false;
		}
		return processManager.resize(`${sessionId}-terminal`, cols, rows);
	});

	// Ensure the host terminal exists; reconnecting clients attach to its live handle.
	// Uses session ID format {sessionId}-terminal so data-listener broadcasts terminal_data
	//
	// This is a host sink: the PTY is spawned HERE, in the main process, not by
	// the renderer, so the admission a managed host requires is asked for here
	// too (MRC-08-01), for the actor the transport resolved. The WebSocket
	// handler runs this callback inside the client's context, so the actor is
	// the socket's: a Web Login account, the CLI secret, a Lite pairing or the
	// path token, each attribution the authority binds and none of them an
	// enterprise principal. Before this, a managed host refused the spawn at the
	// sink for carrying no admission at all, and the client was told only that
	// the spawn failed. Standalone hosts spawn exactly as before.
	server.setSpawnTerminalForWebCallback(
		async (sessionId: string, config: { cwd: string; cols?: number; rows?: number }) => {
			const processManager = getProcessManager();
			if (!processManager) {
				logger.warn('processManager is null for spawnTerminalForWeb', 'WebServer');
				return { success: false, pid: 0 };
			}
			const terminalSessionId = `${sessionId}-terminal`;
			// Resolve shell: custom path > default from settings > system default
			const customShellPath = settingsStore.get<string>('customShellPath', '');
			const defaultShell = settingsStore.get<string>('defaultShell', getDefaultShell());
			const shell = (customShellPath && customShellPath.trim()) || defaultShell;
			const shellArgs = settingsStore.get<string>('shellArgs', '');
			const shellEnvVars = settingsStore.get<Record<string, string>>('shellEnvVars', {});
			const terminalConfig = {
				sessionId: terminalSessionId,
				cwd: config.cwd,
				shell,
				shellArgs,
				shellEnvVars,
				cols: config.cols,
				rows: config.rows,
			};

			const transport = describeTransportAdmission(getActingTransport());
			logger.info(`Spawning terminal PTY for web client: ${terminalSessionId}`, 'WebServer', {
				shell,
				cwd: config.cwd,
				transport,
			});
			// The exact request `spawnTerminalTab` will build is admitted first, as
			// the renderer's `process:spawnTerminalTab` handler does.
			const admitted = await processManager.admitSpawn(
				processManager.terminalTabConfig(terminalConfig),
				currentSpawnActor()
			);
			if (admitted.state !== 'standalone' && admitted.state !== 'admitted') {
				logger.warn(`Web terminal PTY not admitted for ${terminalSessionId}`, 'WebServer', {
					transport,
					state: admitted.state,
					code: admitted.code,
					message: admitted.message,
				});
				return {
					pid: -1,
					success: false,
					error: admitted.message,
					managed: { state: admitted.state, code: admitted.code },
				};
			}
			return processManager.spawnTerminalTab(
				admitted.state === 'admitted'
					? { ...terminalConfig, admission: admitted.admission }
					: terminalConfig
			);
		}
	);

	// Kill the web client's dedicated terminal PTY
	server.setKillTerminalForWebCallback((sessionId: string) => {
		const processManager = getProcessManager();
		if (!processManager) {
			logger.warn('processManager is null for killTerminalForWeb', 'WebServer');
			return false;
		}
		const terminalSessionId = `${sessionId}-terminal`;
		if (!processManager.get(terminalSessionId)) {
			return true; // Already gone
		}
		logger.info(`Killing terminal PTY for web client: ${terminalSessionId}`, 'WebServer');
		return processManager.kill(terminalSessionId);
	});
}
