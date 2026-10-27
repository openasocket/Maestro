import { ipcMain } from 'electron';
import { withIpcErrorLogging, CreateHandlerOptions } from '../../utils/ipcHandler';
import { MaestroCliManager } from '../../maestro-cli-manager';
import { getActingTransport, transportSpawnActor } from '../../web-server/auth/transport-actor';

const LOG_CONTEXT = '[MaestroCLI]';

const handlerOpts = (operation: string): Pick<CreateHandlerOptions, 'context' | 'operation'> => ({
	context: LOG_CONTEXT,
	operation,
});

export function registerMaestroCliHandlers(maestroCliManager: MaestroCliManager): void {
	ipcMain.handle(
		'maestroCli:checkStatus',
		withIpcErrorLogging(handlerOpts('checkStatus'), async () => maestroCliManager.checkStatus())
	);

	ipcMain.handle(
		'maestroCli:installOrUpdate',
		withIpcErrorLogging(handlerOpts('installOrUpdate'), async () =>
			// The transport the call was admitted over is read here, at the boundary.
			maestroCliManager.installOrUpdate({
				actor: { kind: 'transport', actor: transportSpawnActor(getActingTransport()) },
			})
		)
	);
}
