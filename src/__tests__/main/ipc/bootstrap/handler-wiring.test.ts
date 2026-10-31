/**
 * Wiring parity between the two IPC registration lists (MAESTRO-YV).
 *
 * `src/main/ipc/handlers/index.ts` exports `registerAllHandlers()`, which reads
 * like the authoritative registration list but is dead: nothing calls it. The
 * live path is `setupIpcHandlers()` in `src/main/ipc/bootstrap/index.ts`, which
 * `main/index.ts` invokes at app-ready.
 *
 * The Context Timeline handlers were added to the dead list only, so
 * `contextTimeline:getCaptures` / `contextTimeline:clearCaptures` were never
 * registered in a shipped build. The renderer fires `clearCaptures` as a
 * floating promise, so it surfaced as an unhandled rejection
 * ("No handler registered for 'contextTimeline:clearCaptures'") and the panel
 * silently hydrated empty on every reload.
 *
 * The per-handler unit test could not catch this: it calls
 * `registerContextTimelineHandlers()` directly, so it stayed green while
 * production was broken. This test reads the two sources instead and asserts
 * the invariant that actually held wrong - a registrar in the dead list must
 * also be invoked by the live one.
 */

import { beforeEach, describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { canonicalJson } from '../../../../shared/canonicalJson';
import type { ManagedSshEndpointRef } from '../../../../shared/maestro-lib/managed/types';
import type { AgentSessionsHandlerDependencies } from '../../../../main/ipc/handlers/agentSessions';
import type { IpcBootstrapDependencies } from '../../../../main/ipc/bootstrap/types';

const SRC = path.resolve(__dirname, '../../../../main/ipc');
const HANDLERS_INDEX = path.join(SRC, 'handlers/index.ts');
const BOOTSTRAP_INDEX = path.join(SRC, 'bootstrap/index.ts');

/** Strip line and block comments so prose cannot be mistaken for a call. */
function stripComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
}

/**
 * Registrar names that are *invoked* in a file. Requiring the open paren keeps
 * import/export list entries (`registerFooHandlers,` / `export { ... };`) out,
 * and matching anywhere on the line keeps assignment-form calls
 * (`const h = registerPersistenceHandlers({...})`) in.
 *
 * Comments are stripped first and declarations are excluded, because both look
 * exactly like calls to a regex. Without that this test passes for the wrong
 * reason: `registerAllHandlers(` matches its own `function` declaration in the
 * handlers file, and a comment in the bootstrap file mentioning
 * `registerAllHandlers()` matches there, so the two cancel out. Editing that
 * comment would then fail the test, and a registrar-shaped comment could hide a
 * genuinely missing live registration.
 */
function invokedRegistrars(filePath: string): Set<string> {
	const source = stripComments(readFileSync(filePath, 'utf-8'));
	const names = source.match(/(?<!function\s)register[A-Za-z]+Handlers\(/g) ?? [];
	return new Set(names.map((n) => n.slice(0, -1)));
}

describe('IPC handler wiring parity', () => {
	it('registers every handler from the dead registerAllHandlers list in the live setupIpcHandlers', () => {
		// The wrapper is the dead list itself, not a member of it. Nothing is
		// expected to call it - that is the whole premise of this test.
		const dead = invokedRegistrars(HANDLERS_INDEX);
		dead.delete('registerAllHandlers');
		const live = invokedRegistrars(BOOTSTRAP_INDEX);

		// Sanity: the extraction found a realistic number of registrars, so a
		// regex that silently stops matching fails loudly instead of passing.
		expect(dead.size).toBeGreaterThan(30);
		expect(live.size).toBeGreaterThan(30);

		const missing = [...dead].filter((name) => !live.has(name)).sort();
		expect(missing).toEqual([]);
	});

	it('wires the Context Timeline handlers into the live bootstrap path', () => {
		expect(invokedRegistrars(BOOTSTRAP_INDEX)).toContain('registerContextTimelineHandlers');
	});
});

describe('Grok history qualifier bootstrap wiring (GT1-04-07C1RT)', () => {
	let historyDeps: AgentSessionsHandlerDependencies;
	let getEnterpriseService: ReturnType<typeof vi.fn>;
	let qualifyResolved: ReturnType<typeof vi.fn>;
	let qualifyHistoryEndpoint: () => Promise<string | undefined>;
	const remote = {
		id: 'configured-alias',
		name: 'Fixture SSH',
		host: 'fixture.invalid',
		port: 22,
		username: 'fixture',
		enabled: true,
	};

	beforeEach(() => {
		vi.clearAllMocks();
		getEnterpriseService = vi.fn().mockReturnValue(null);
		qualifyResolved = vi.fn();
		// Execute the complete live bootstrap with inert imports. This follows the
		// source-execution pattern in plugin-host-deps-wiring.test.ts without
		// loading Electron, initializing stores or starting background services.
		const source = readFileSync(BOOTSTRAP_INDEX, 'utf-8');
		const ast = ts.createSourceFile(BOOTSTRAP_INDEX, source, ts.ScriptTarget.ES2022, true);
		const modules: Record<string, Record<string, ReturnType<typeof vi.fn>>> = {};
		for (const statement of ast.statements) {
			if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly) continue;
			const bindings = statement.importClause?.namedBindings;
			if (!bindings || !ts.isNamedImports(bindings)) {
				throw new Error('Update the inert bootstrap fixture for the new import shape.');
			}
			const moduleName = (statement.moduleSpecifier as ts.StringLiteral).text;
			modules[moduleName] = Object.fromEntries(
				bindings.elements
					.filter((element) => !element.isTypeOnly)
					.map((element) => [(element.propertyName ?? element.name).text, vi.fn()])
			);
		}
		const handlers = modules['../handlers'];
		handlers.registerPersistenceHandlers.mockReturnValue({ noteSessionActivated: vi.fn() });
		const exports: { setupIpcHandlers?: (deps: IpcBootstrapDependencies) => void } = {};
		const compiled = ts.transpileModule(source, {
			compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
		}).outputText;
		new Function('require', 'exports', compiled)((name: string) => {
			if (!Object.hasOwn(modules, name)) throw new Error(`Unexpected bootstrap import: ${name}`);
			return modules[name];
		}, exports);
		const deps = {
			getEnterpriseService,
			getMainWindow: vi.fn().mockReturnValue(null),
			getInteractiveReplayController: vi.fn().mockReturnValue(null),
			getPianolaSupervisor: vi.fn().mockReturnValue(null),
			getPluginManager: vi.fn().mockReturnValue(null),
			getPluginAuthStore: vi.fn().mockReturnValue(null),
			setNoteSessionActivated: vi.fn(),
			windowRegistry: { onChange: vi.fn() },
			agentSessionOriginsStore: { get: vi.fn(), set: vi.fn() },
		} as unknown as IpcBootstrapDependencies;
		expect(exports.setupIpcHandlers).toBeTypeOf('function');
		exports.setupIpcHandlers!(deps);
		expect(handlers.registerAgentSessionsHandlers).toHaveBeenCalledExactlyOnceWith({
			getMainWindow: deps.getMainWindow,
			agentSessionOriginsStore: deps.agentSessionOriginsStore,
			remoteQualifier: expect.any(Function),
		});
		expect(getEnterpriseService).not.toHaveBeenCalled();
		expect(
			modules['../../storage'].initializeSessionStorages.mock.invocationCallOrder[0]
		).toBeLessThan(handlers.registerAgentSessionsHandlers.mock.invocationCallOrder[0]);
		historyDeps = handlers.registerAgentSessionsHandlers.mock.calls[0][0];

		// Execute only the production endpoint selector with the getter supplied by
		// bootstrap. The full retained-binding/read race matrix belongs to 07C1T.
		const historyPath = path.join(SRC, 'handlers/agentSessions.ts');
		const historyAst = ts.createSourceFile(
			historyPath,
			readFileSync(historyPath, 'utf-8'),
			ts.ScriptTarget.ES2022,
			true
		);
		const observer = historyAst.statements.find(
			(node) => ts.isFunctionDeclaration(node) && node.name?.text === 'observeGrokHistoryScope'
		);
		expect(observer).toBeDefined();
		const selectors: ts.ArrowFunction[] = [];
		const visit = (node: ts.Node): void => {
			if (
				ts.isVariableDeclaration(node) &&
				ts.isIdentifier(node.name) &&
				node.name.text === 'qualify' &&
				node.initializer &&
				ts.isArrowFunction(node.initializer)
			) {
				selectors.push(node.initializer);
			}
			ts.forEachChild(node, visit);
		};
		visit(observer!);
		expect(selectors).toHaveLength(1);
		const selector = ts.transpileModule(`const qualify = ${selectors[0].getText(historyAst)};`, {
			compilerOptions: { target: ts.ScriptTarget.ES2022 },
		}).outputText;
		qualifyHistoryEndpoint = new Function(
			'remoteQualifier',
			'remote',
			'canonicalJson',
			'structuredClone',
			`${selector}\nreturn qualify;`
		)(historyDeps.remoteQualifier, remote, canonicalJson, structuredClone);
	});

	it('reads a service initialized after handler registration and drops it when unavailable', () => {
		expect(historyDeps.remoteQualifier!()).toBeNull();
		const qualifier = { qualifyResolved };
		getEnterpriseService.mockReturnValue({ remote: qualifier });
		expect(historyDeps.remoteQualifier!()).toBe(qualifier);
		getEnterpriseService.mockReturnValue(null);
		expect(historyDeps.remoteQualifier!()).toBeNull();
		getEnterpriseService.mockReturnValue({});
		expect(historyDeps.remoteQualifier!()).toBeNull();
		expect(qualifyResolved).not.toHaveBeenCalled();
	});

	it('uses a replacement qualifier without registering handlers again', async () => {
		const previous = { qualifyResolved };
		getEnterpriseService.mockReturnValue({ remote: previous });
		expect(historyDeps.remoteQualifier!()).toBe(previous);
		const replacement = { qualifyResolved: vi.fn().mockResolvedValue({ kind: 'local' }) };
		getEnterpriseService.mockReturnValue({ remote: replacement });
		await expect(qualifyHistoryEndpoint()).resolves.toBeUndefined();
		expect(replacement.qualifyResolved).toHaveBeenCalledExactlyOnceWith(remote);
		expect(qualifyResolved).not.toHaveBeenCalled();
	});

	it('keeps the executing installation identity stable across runtime epochs', async () => {
		getEnterpriseService.mockReturnValue({ remote: { qualifyResolved } });
		for (const processEpoch of ['process-before', 'process-after']) {
			qualifyResolved.mockResolvedValue({
				kind: 'remote',
				remote: structuredClone(remote),
				endpoint: {
					installationId: 'executing-installation',
					runtimeId: `runtime-${processEpoch}`,
					processEpoch,
					authorityId: 'fixture-authority',
					policyRevision: 1,
				} satisfies ManagedSshEndpointRef,
			});
			await expect(qualifyHistoryEndpoint()).resolves.toBe('executing-installation');
		}
		expect(qualifyResolved).toHaveBeenCalledTimes(2);
		for (const [observedRemote] of qualifyResolved.mock.calls) {
			expect(observedRemote).toEqual(remote);
			expect(observedRemote).not.toBe(remote);
		}
	});

	it.each([
		['missing service', null],
		['missing qualifier', {}],
	])(
		'leaves %s unqualified without substituting the local installation',
		async (_label, service) => {
			getEnterpriseService.mockReturnValue(service);
			await expect(qualifyHistoryEndpoint()).resolves.toBeUndefined();
			expect(qualifyResolved).not.toHaveBeenCalled();
		}
	);

	it.each([
		['unavailable', { kind: 'unresolved', reason: 'remote-endpoint-unqualified' }],
		['local', { kind: 'local' }],
		['unattested', { kind: 'remote', remote }],
		['empty identity', { kind: 'remote', remote, endpoint: { installationId: ' ' } }],
		['control identity', { kind: 'remote', remote, endpoint: { installationId: 'bad\nidentity' } }],
		['epoch only', { kind: 'remote', remote, endpoint: { processEpoch: 'process-only' } }],
		[
			'different target',
			{
				kind: 'remote',
				remote: { ...remote, host: 'other.invalid' },
				endpoint: { installationId: 'other-installation' },
			},
		],
	])('rejects a %s endpoint returned through bootstrap', async (_label, target) => {
		getEnterpriseService.mockReturnValue({ remote: { qualifyResolved } });
		qualifyResolved.mockResolvedValue(target);
		await expect(qualifyHistoryEndpoint()).resolves.toBeUndefined();
		expect(qualifyResolved).toHaveBeenCalledExactlyOnceWith(remote);
	});

	it('preserves an unexpected qualifier failure for the handler error boundary', async () => {
		getEnterpriseService.mockReturnValue({ remote: { qualifyResolved } });
		const failure = new Error('inert qualifier failure');
		qualifyResolved.mockRejectedValue(failure);
		await expect(qualifyHistoryEndpoint()).rejects.toBe(failure);
	});
});
