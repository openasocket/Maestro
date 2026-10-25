/**
 * Standalone and package boundary regressions (MRC-12-03B). The built library
 * is loaded in a child Node with no Electron resolvable; the capability matrix
 * the bundle reports is compared with what the packager writes and with the
 * source; the unmanaged paths (an unenrolled desktop service, a headless
 * authority over a standalone binding, a turn started with no admission, the
 * ordinary secret lookup) keep their behavior; and the declaration entry the
 * build emits names exactly the exports of the source entry, both directions.
 * Every case runs; none is skipped.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLocalEndpointClient } from '../../../main/enterprise/endpoint-client';
import { ENTERPRISE_IDENTITY_FILE_NAME } from '../../../main/enterprise/identity-store';
import { projectManagedState } from '../../../main/enterprise/managed-state';
import {
	createEnterpriseService,
	ENTERPRISE_SUPPORTED_CAPABILITIES,
} from '../../../main/enterprise/service';
import { createProcessSpawnAuthority } from '../../../main/enterprise/spawn-authority';
import { PICKABLE_AGENT_IDS } from '../../../shared/agentMetadata';
import { buildDispatchSnapshot } from '../../../shared/maestro-lib/managed/authority';
import {
	createHeadlessSpawnAuthority,
	installationIdentity,
} from '../../../shared/maestro-lib/managed/host-adapter';
import {
	buildHarnessLaunchSpec,
	harnessRouteProblems,
	SYNTHETIC_HARNESS_MODEL,
	SYNTHETIC_HARNESS_ROUTE_ID,
	syntheticHarnessRouteSupport,
} from '../../../shared/maestro-lib/managed/provider-route';
import { MANAGED_CONTRACT_VERSION } from '../../../shared/maestro-lib/managed/types';
import {
	MANAGED_ROUTES,
	providerRouteSupport,
	type ProviderRouteSupport,
} from '../../../shared/maestro-lib/providers/capabilities';
import { getAgentIds } from '../../../shared/maestro-lib/providers/definitions';
import { startTurn } from '../../../shared/maestro-lib/run/start-turn';
import { MAESTRO_LIB_VERSION } from '../../../shared/maestro-lib/version';
import { resolveSecrets, resolveSecretsStrict } from '../../../shared/serverSecrets';
import { capabilityMatrix } from '../../../../scripts/package-mega-maestro-runtime.mjs';
import { fakeAnchor, fakeSeal } from '../../main/enterprise/fakeCustody';
import {
	readSyntheticEffects,
	SYNTHETIC_EFFECTS_FILE,
	SYNTHETIC_PROVIDER_ID,
	SYNTHETIC_PROVIDER_SOURCE,
} from './fixtures';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const BUILD = path.join(REPO_ROOT, 'scripts/build-maestro-lib.mjs');
const SOURCE_ENTRY = path.join(REPO_ROOT, 'src/shared/maestro-lib/index.ts');

/** The exports the build script itself insists on (scripts/build-maestro-lib.mjs). */
const MANAGED_EXPORTS = [
	'managedContextProblems',
	'isManagedOperationContext',
	'childDelegationContext',
	'readDelegationContextEnv',
	'groupChatTurnContext',
	'createWorkflowOwnership',
	'createHeadlessSpawnAuthority',
	'createLocalHostAuthority',
	'createManagedBinding',
	'negotiateCompatibility',
	'providerRouteSupport',
	'syntheticHarnessRouteSupport',
	'startTurn',
];

/**
 * Run in a child Node from the sandbox: nothing of this repository on the
 * resolution path, no Electron, and the bundle's own report of itself.
 */
const PROBE_SOURCE = `
'use strict';
let electron;
try { require.resolve('electron'); electron = 'resolvable'; } catch (error) { electron = error.code; }
const lib = require(process.argv[2]);
const managed = {};
for (const name of ${JSON.stringify(MANAGED_EXPORTS)}) managed[name] = typeof lib[name];
process.stdout.write(JSON.stringify({
	node: process.version,
	electron,
	versions: {
		library: lib.MAESTRO_LIB_VERSION,
		managedContract: lib.MANAGED_CONTRACT_VERSION,
		node: lib.MAESTRO_LIB_VERSION_INFO.node,
	},
	managed,
	visible: lib.getVisibleAgentDefinitions().map((definition) => definition.id).sort(),
	routes: lib.getVisibleAgentDefinitions().map((definition) => definition.id).flatMap((id) => lib.providerRouteSupport(id)),
	harness: lib.syntheticHarnessRouteSupport(),
	keys: Object.keys(lib).sort(),
}));
`;

interface Probe {
	node: string;
	electron: string;
	versions: { library: string; managedContract: string; node: string };
	managed: Record<string, string>;
	visible: string[];
	routes: ProviderRouteSupport[];
	harness: ReturnType<typeof syntheticHarnessRouteSupport>;
	keys: string[];
}

const routeKey = (row: ProviderRouteSupport) => `${row.agentId}\u0000${row.route}`;
const byRoute = (rows: readonly ProviderRouteSupport[]) =>
	[...rows].sort((a, b) => (routeKey(a) < routeKey(b) ? -1 : 1));

let sandbox: string;
let libDir: string;
let probe: Probe;

beforeAll(() => {
	sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-standalone-')));
	libDir = path.join(sandbox, 'lib');
	const built = spawnSync(process.execPath, [BUILD, '--out-dir', libDir], {
		cwd: REPO_ROOT,
		encoding: 'utf8',
		timeout: 240_000,
	});
	if (built.status !== 0) throw new Error(`build:maestro-lib failed: ${built.stderr}`);
	const probeFile = path.join(sandbox, 'probe.cjs');
	fs.writeFileSync(probeFile, PROBE_SOURCE);
	const loaded = spawnSync(process.execPath, [probeFile, path.join(libDir, 'index.js')], {
		cwd: sandbox,
		env: { PATH: process.env.PATH ?? '' },
		encoding: 'utf8',
		timeout: 60_000,
	});
	if (loaded.status !== 0)
		throw new Error(`the bundle did not load in plain Node: ${loaded.stderr}`);
	probe = JSON.parse(loaded.stdout);
}, 300_000);

afterAll(() => {
	fs.rmSync(sandbox, { recursive: true, force: true });
});

describe('standalone: the built library in plain Node', () => {
	it('loads with no Electron resolvable and exports its versions and the managed extension', () => {
		expect(probe.electron).toBe('MODULE_NOT_FOUND');
		expect(probe.node).toBe(process.version);
		expect(probe.versions).toEqual({
			library: MAESTRO_LIB_VERSION,
			managedContract: MANAGED_CONTRACT_VERSION,
			node: expect.stringMatching(/^>=/),
		});
		for (const name of MANAGED_EXPORTS) expect(probe.managed[name], name).toBe('function');
		expect(JSON.parse(fs.readFileSync(path.join(libDir, 'package.json'), 'utf8'))).toMatchObject({
			name: 'maestro-lib',
			version: MAESTRO_LIB_VERSION,
			maestroManagedContract: MANAGED_CONTRACT_VERSION,
			peerDependenciesMeta: { 'node-pty': { optional: true } },
		});
	});

	it('names no electron require and bundles nothing from the desktop main process', () => {
		const bundle = fs.readFileSync(path.join(libDir, 'index.js'), 'utf8');
		expect(bundle).not.toMatch(/require\(\s*["']electron["']\s*\)/);
		expect(bundle).not.toMatch(/from\s+["']electron["']/);
		const map = JSON.parse(fs.readFileSync(path.join(libDir, 'index.js.map'), 'utf8')) as {
			sources: string[];
		};
		const desktop = map.sources.filter(
			(source) => /(^|\/)src\/main\//.test(source) || /node_modules\/electron\//.test(source)
		);
		expect(desktop).toEqual([]);
		expect(map.sources.some((source) => /src\/shared\/maestro-lib\/index\.ts$/.test(source))).toBe(
			true
		);
	});
});

describe('standalone: the capability matrix the bundle reports', () => {
	it('equals what the packager writes and what the source computes for every pickable provider', () => {
		const packaged = capabilityMatrix(libDir) as {
			routes: ProviderRouteSupport[];
			harness: ReturnType<typeof syntheticHarnessRouteSupport>;
			versions: Record<string, unknown>;
		};
		expect(byRoute(packaged.routes)).toEqual(byRoute(probe.routes));
		expect(packaged.harness).toEqual(probe.harness);
		expect(packaged.versions).toMatchObject({
			library: MAESTRO_LIB_VERSION,
			managedContract: MANAGED_CONTRACT_VERSION,
		});

		const pickable: string[] = [...PICKABLE_AGENT_IDS].sort();
		// The hidden definitions (terminal, gemini-cli) are not offered and not reported.
		expect(probe.visible).toEqual(pickable);
		expect(
			getAgentIds()
				.filter((id) => !pickable.includes(id))
				.sort()
		).toEqual(['gemini-cli', 'terminal']);
		const fromSource = PICKABLE_AGENT_IDS.flatMap((id) => providerRouteSupport(id));
		expect(byRoute(probe.routes)).toEqual(byRoute(fromSource));
		expect(probe.routes).toHaveLength(PICKABLE_AGENT_IDS.length * MANAGED_ROUTES.length);
		expect(probe.harness).toEqual(syntheticHarnessRouteSupport());
	});

	it('enforces no real provider route beyond launch admission, and the synthetic harness route is supported on this Node', () => {
		for (const row of probe.routes) {
			const label = routeKey(row).replace('\u0000', '/');
			expect(row.agentId, label).not.toBe(SYNTHETIC_PROVIDER_ID);
			expect(row.managed, label).not.toBe('locally-verified');
			if (row.route !== 'child-process' || row.standalone === 'unsupported') {
				expect(row.managed, label).toBe('unsupported');
			} else {
				// The launch is admitted at the real spawn (phase 2); the note names
				// the producer the route still lacks, and nothing past the launch.
				expect(row.managed, label).toBe('implemented');
				expect(row.note, label).toContain('CP-03');
				expect(row.note, label).toContain('unqualified');
			}
		}
		expect(probe.routes.filter((row) => row.managed === 'implemented').map((r) => r.route)).toEqual(
			expect.arrayContaining(['child-process'])
		);
		expect(
			new Set(probe.routes.filter((row) => row.managed === 'implemented').map((r) => r.route))
		).toEqual(new Set(['child-process']));

		expect(probe.harness).toMatchObject({
			agentId: SYNTHETIC_PROVIDER_ID,
			route: 'child-process',
			routeId: SYNTHETIC_HARNESS_ROUTE_ID,
			standalone: 'implemented',
			managed: 'implemented',
			enforcement: { enforcedBy: 'node-permission-model' },
		});
	});
});

describe('standalone: unmanaged behavior preserved', () => {
	let dir: string;
	let workDir: string;

	beforeAll(() => {
		dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-unmanaged-')));
		workDir = path.join(dir, 'work');
		fs.mkdirSync(workDir);
	});
	afterAll(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('an unenrolled desktop service reports standalone standing, opens no port and touches no anchor', async () => {
		const holder: { value: null } = { value: null };
		const opened: string[] = [];
		const seal = fakeSeal();
		const service = createEnterpriseService({
			userDataDir: path.join(dir, 'data'),
			productionDataDir: path.join(dir, 'data'),
			hostname: 'standalone-host',
			pid: 4343,
			startedAt: '2026-10-25T12:00:00.000Z',
			appVersion: '1.1.0-RC',
			safeStorage: {
				isEncryptionAvailable: () => true,
				encryptString: (text) => seal.seal(text),
				decryptString: (blob) => seal.unseal(blob),
				getSelectedStorageBackend: () => 'keychain',
			},
			anchor: fakeAnchor(holder),
			platform: 'darwin',
			openPort: (socketPath) => {
				opened.push(socketPath);
				return createLocalEndpointClient({ socketPath, timeoutMs: 500 });
			},
		});
		fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
		await service.start();
		try {
			expect(service.identity.read().status).toBe('none');
			expect(service.lifecycle.status()).toMatchObject({ authority: 'none', connection: null });
			expect(service.spawnAuthority.standing()).toBe('standalone');
			expect(service.cueSpawnAuthority.standing()).toBe('standalone');
			expect(service.policy.status().admission).toMatchObject({ possible: false });
			const view = projectManagedState({
				status: service.lifecycle.status(),
				policy: service.policy.status(),
				custody: service.identity.custody(),
				supported: ENTERPRISE_SUPPORTED_CAPABILITIES,
			});
			expect(view).toMatchObject({
				standing: 'unenrolled',
				enrollment: null,
				endpoint: { attached: false, connectivity: 'detached' },
			});
			// The same port the process manager composes, built over the service's own parts.
			const desktop = createProcessSpawnAuthority({
				installation: service.installation,
				identity: service.identity,
				host: service.host,
				dispatch: service.dispatch,
			});
			expect(desktop.standing()).toBe('standalone');
			expect(desktop.policy()).toEqual({ sources: [], policyRevision: null });
			expect(await service.telemetry.pump()).toMatchObject({ outcome: 'no-standing' });
			expect(service.dispatch.receipts()).toEqual([]);
			expect(service.host.authority.live()).toEqual([]);
		} finally {
			await service.close();
		}
		expect(opened).toEqual([]);
		expect(holder.value).toBeNull();
		expect(fs.existsSync(path.join(dir, 'data', ENTERPRISE_IDENTITY_FILE_NAME))).toBe(false);
	});

	it('a headless authority over a standalone binding needs no lease: the sink starts the turn with no admission and the program leaves its effects', async () => {
		const installation = installationIdentity({
			hostname: 'standalone-host',
			productionDataDir: path.join(dir, 'data'),
			mode: 'cli',
			pid: process.pid,
			startedAt: '2026-10-25T12:00:00.000Z',
		});
		const headless = createHeadlessSpawnAuthority({
			installation,
			binding: { state: 'standalone', files: [path.join(dir, 'data', 'managed-binding.json')] },
			host: null,
			origin: 'cli',
			actor: { kind: 'service', id: 'maestro-cli:test' },
		});
		expect(headless.standing()).toBe('standalone');
		expect(headless.unavailableReason).toBeNull();
		expect(headless.policy()).toEqual({ sources: [], policyRevision: null });
		expect(headless.authority.live()).toEqual([]);

		const request = {
			script: SYNTHETIC_PROVIDER_SOURCE,
			inputs: [],
			workDir,
			timeoutMs: 10_000,
			stdin: JSON.stringify({ prompt: 'standalone turn' }),
		};
		expect(harnessRouteProblems(request)).toEqual([]);
		const spec = buildHarnessLaunchSpec(request);
		// A managed sink would ask; the standalone rule (agent-spawner's
		// admitCliLaunch, runAgentTurn without `managed`) asks nobody. Asked
		// anyway, the authority of a standalone binding issues no lease.
		const asked = await headless.authority.admit({
			context: {} as never,
			snapshot: buildDispatchSnapshot(spec, {
				provider: SYNTHETIC_PROVIDER_ID,
				model: SYNTHETIC_HARNESS_MODEL,
				resourceIds: [],
			}),
			policy: headless.policy(),
		});
		if (asked.state === 'admitted') throw new Error('a standalone binding issued a lease');
		expect(asked).toMatchObject({ state: 'unavailable', code: 'runtime-unavailable' });
		expect(asked.message).toContain('holds no enrollment');

		const exit = await startTurn(
			spec,
			{},
			{ stopGraceMs: 1_000, stdoutTailLimit: 4_096, stderrTailLimit: 4_096 }
		).done;
		expect(exit).toMatchObject({ exitCode: 0, signal: null, interrupted: false });
		expect(exit.stdoutText).toContain('"type":"synthetic-provider"');
		const effects = readSyntheticEffects(workDir);
		expect(effects).toMatchObject({
			wroteFile: path.join(workDir, SYNTHETIC_EFFECTS_FILE),
			cwd: workDir,
			connected: false,
			// The route's own permission model holds with or without management.
			spawnedChild: 'ERR_ACCESS_DENIED',
		});
		expect(effects?.stdinBytes).toBeGreaterThan(0);
		expect(headless.authority.live()).toEqual([]);
	});

	it('resolveSecrets reports and continues where resolveSecretsStrict fails closed with no value', () => {
		const credentials = path.join(dir, 'credentials');
		fs.mkdirSync(credentials, { recursive: true });
		fs.writeFileSync(path.join(credentials, 'FOUND'), 'secret-value\n');
		fs.writeFileSync(path.join(credentials, 'EMPTY'), '');
		const options = { env: { CREDENTIALS_DIRECTORY: credentials }, runSecretsDir: null };
		const names = ['MISSING', 'FOUND', 'EMPTY', 'FOUND'];

		expect(resolveSecrets(names, options)).toEqual({
			values: { FOUND: 'secret-value' },
			found: [{ name: 'FOUND', source: 'credentials' }],
			missing: ['MISSING'],
			unusable: [{ name: 'EMPTY', problem: 'empty', path: path.join(credentials, 'EMPTY') }],
		});

		const strict = resolveSecretsStrict(names, options);
		expect(strict).toEqual({
			ok: false,
			problems: [
				{
					name: 'EMPTY',
					status: 'unusable',
					problem: 'empty',
					path: path.join(credentials, 'EMPTY'),
				},
				{ name: 'MISSING', status: 'missing' },
			],
		});
		expect(JSON.stringify(strict)).not.toContain('secret-value');
		expect(resolveSecretsStrict(['FOUND'], options)).toEqual({
			ok: true,
			values: { FOUND: 'secret-value' },
			found: [{ name: 'FOUND', source: 'credentials' }],
		});
	});
});

/** The export names of one module file, and which of them are values at runtime. */
function moduleExports(program: ts.Program, file: string) {
	const checker = program.getTypeChecker();
	const source = program.getSourceFile(file);
	if (!source) throw new Error(`not in the program: ${file}`);
	const moduleSymbol = checker.getSymbolAtLocation(source);
	if (!moduleSymbol) throw new Error(`no module symbol: ${file}`);
	const names = new Set<string>();
	const values = new Set<string>();
	for (const symbol of checker.getExportsOfModule(moduleSymbol)) {
		names.add(symbol.name);
		const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
		if (target.flags & ts.SymbolFlags.Value) values.add(symbol.name);
	}
	return { names, values };
}

describe('standalone: the declaration entry names the source entry, both directions', () => {
	it('dist index.d.ts exports exactly what src/shared/maestro-lib/index.ts exports, and the bundle the values among them', () => {
		const parsed = ts.getParsedCommandLineOfConfigFile(
			path.join(REPO_ROOT, 'tsconfig.cli.json'),
			{},
			{
				...ts.sys,
				onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
					throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
				},
			}
		);
		if (!parsed) throw new Error('tsconfig.cli.json did not parse');
		const options = { ...parsed.options, noEmit: true, types: parsed.options.types ?? ['node'] };
		const source = moduleExports(ts.createProgram([SOURCE_ENTRY], options), SOURCE_ENTRY);

		const declaration = path.join(libDir, 'index.d.ts');
		expect(fs.readFileSync(declaration, 'utf8')).toBe(
			"export * from './types/shared/maestro-lib/index';\n"
		);
		const built = moduleExports(
			ts.createProgram([declaration], {
				...options,
				skipLibCheck: true,
				rootDir: undefined,
				paths: undefined,
			}),
			declaration
		);

		expect(source.names.size).toBeGreaterThan(400);
		expect([...built.names].filter((n) => !source.names.has(n)).sort()).toEqual([]);
		expect([...source.names].filter((n) => !built.names.has(n)).sort()).toEqual([]);
		expect([...built.values].sort()).toEqual([...source.values].sort());

		const runtime = new Set(probe.keys.filter((key) => !key.startsWith('__')));
		expect([...runtime].filter((n) => !built.values.has(n)).sort()).toEqual([]);
		expect([...built.values].filter((n) => !runtime.has(n)).sort()).toEqual([]);
	}, 120_000);
});
