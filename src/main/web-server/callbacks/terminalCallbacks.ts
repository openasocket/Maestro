import type { WebServer } from '../WebServer';
import type { WebServerFactoryDependencies } from '../web-server-factory';
import type { StoredSession } from '../../stores/types';
import type { ProcessManager } from '../../process-manager';
import type { ProcessSpawnActor } from '../../process-manager/types';
import { logger } from '../../utils/logger';
import { getDefaultShell } from '../../stores/defaults';
import {
	currentSpawnActor,
	describeSpawnActor,
	describeTransportAdmission,
	getActingTransport,
	sameSpawnActor,
} from '../auth/transport-actor';
import type { WebTerminalInputRefusal } from '../handlers/messageHandlers/types';

/** The owner a host-admitted web PTY has when no web spawn recorded one: the operator. */
const OPERATOR: ProcessSpawnActor = Object.freeze({ peer: 'in-process' as const });

export function registerTerminalCallbacks(
	server: WebServer,
	deps: Pick<WebServerFactoryDependencies, 'getProcessManager' | 'sessionsStore' | 'settingsStore'>
): void {
	const { getProcessManager, sessionsStore, settingsStore } = deps;

	// The actor each web PTY was admitted for, by terminal session id
	// (MRC-08-02). The PTY outlives the socket that asked for it (a reconnecting
	// client attaches to the live handle), so the actor is kept here, beside
	// the sink, and compared against the caller of every later attach, write
	// and resize. Recorded on a successful spawn, dropped on kill; a PTY that
	// died and is spawned again records its new owner.
	const webTerminalActors = new Map<string, ProcessSpawnActor>();

	/**
	 * Why input from the current caller may not reach a web PTY, or null when
	 * it may. Only a PTY this host ADMITTED (its admission still bound) is
	 * actor-bound: on a managed host the caller must be the actor the PTY was
	 * admitted for, as the transport context resolves it now (a reconnected
	 * socket was re-resolved at its upgrade and rechecked for this message). A
	 * standalone host's PTY takes input from any subscribed client, as before,
	 * and `ProcessManager.write()` still refuses an unadmitted or released
	 * process under management. Being subscribed to the session is read access
	 * and plays no part here.
	 */
	const inputRefusal = (
		processManager: ProcessManager,
		terminalSessionId: string,
		verb: string
	): WebTerminalInputRefusal | null => {
		if (!processManager.admissionOf(terminalSessionId)) return null;
		const owner = webTerminalActors.get(terminalSessionId) ?? OPERATOR;
		const caller = currentSpawnActor();
		if (sameSpawnActor(owner, caller)) return null;
		return {
			success: false,
			error: `This terminal was admitted for ${describeSpawnActor(owner)} on a managed host; ${verb} by ${describeSpawnActor(caller)} is unavailable.`,
			managed: { state: 'denied', code: 'context-mismatch' },
		};
	};

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
		const terminalSessionId = `${sessionId}-terminal`;
		const refused = inputRefusal(processManager, terminalSessionId, 'input');
		if (refused) {
			logger.warn(`Web terminal write refused for ${terminalSessionId}`, 'WebServer', {
				transport: describeTransportAdmission(getActingTransport()),
				message: refused.error,
			});
			return refused;
		}
		return processManager.write(terminalSessionId, data);
	});

	server.setResizeTerminalCallback((sessionId: string, cols: number, rows: number) => {
		const processManager = getProcessManager();
		if (!processManager) {
			logger.warn('processManager is null for resizeTerminal', 'WebServer');
			return false;
		}
		const terminalSessionId = `${sessionId}-terminal`;
		const refused = inputRefusal(processManager, terminalSessionId, 'a resize');
		if (refused) {
			logger.warn(`Web terminal resize refused for ${terminalSessionId}`, 'WebServer', {
				transport: describeTransportAdmission(getActingTransport()),
				message: refused.error,
			});
			return refused;
		}
		return processManager.resize(terminalSessionId, cols, rows);
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
	//
	// A PTY that is already live is ATTACHED to, not spawned (MRC-08-02): the
	// lease it runs under is the one its admission bound, so no new admission
	// is asked for, and under management only the actor it was admitted for
	// may attach. A client that reconnected as that actor carries on; another
	// actor is refused and the PTY stays its owner's. A standalone host attaches
	// any client, as before.
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
			if (processManager.terminalAttachable(terminalSessionId)) {
				const refused = inputRefusal(processManager, terminalSessionId, 'attaching');
				if (refused) {
					logger.warn(`Web terminal attach refused for ${terminalSessionId}`, 'WebServer', {
						transport,
						message: refused.error,
					});
					return { pid: -1, success: false, error: refused.error, managed: refused.managed };
				}
				logger.info(
					`Attaching web client to live terminal PTY: ${terminalSessionId}`,
					'WebServer',
					{
						transport,
					}
				);
				return processManager.spawnTerminalTab(terminalConfig);
			}

			const actor = currentSpawnActor();
			logger.info(`Spawning terminal PTY for web client: ${terminalSessionId}`, 'WebServer', {
				shell,
				cwd: config.cwd,
				transport,
			});
			// The exact request `spawnTerminalTab` will build is admitted first, as
			// the renderer's `process:spawnTerminalTab` handler does.
			const admitted = await processManager.admitSpawn(
				processManager.terminalTabConfig(terminalConfig),
				actor
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
			const result = processManager.spawnTerminalTab(
				admitted.state === 'admitted'
					? { ...terminalConfig, admission: admitted.admission }
					: terminalConfig
			);
			if (result.success) webTerminalActors.set(terminalSessionId, actor);
			else webTerminalActors.delete(terminalSessionId);
			return result;
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
		webTerminalActors.delete(terminalSessionId);
		if (!processManager.get(terminalSessionId)) {
			return true; // Already gone
		}
		logger.info(`Killing terminal PTY for web client: ${terminalSessionId}`, 'WebServer');
		return processManager.kill(terminalSessionId);
	});
}
