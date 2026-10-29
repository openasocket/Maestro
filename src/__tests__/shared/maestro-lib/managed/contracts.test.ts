/**
 * Phase 01 contracts: the artifact importer, the managed-operation context
 * validator, compatibility negotiation and the provider route matrix.
 *
 * The importer is driven through its exported functions on synthetic
 * artifacts built here (a tiny ustar writer, gzip, sha256), one deliberate
 * fault per test, so every refusal is reached by the real check rather than
 * a mocked one. One test runs the command line end to end in a scratch
 * folder under the repository (the importer refuses a destination outside it).
 *
 * The last section reads the OTHER direction the same way: a packaged Maestro
 * runtime artifact (format 2, the bootstrap a counterpart adapter is built
 * against) as the pinned input of a pair, one fault per synthetic directory,
 * and the committed runtime pin against the versions this source declares.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

import * as importer from '../../../../../scripts/import-mega-maestro.mjs';
import { inspectRuntimeArtifact } from '../../../../../scripts/mega-maestro-pair.mjs';
import {
	ARTIFACT_FORMAT_VERSION,
	ARTIFACT_KIND,
	DEFAULT_OUT_DIR,
	RUNTIME_PIN_ARTIFACT_ID,
	RUNTIME_PIN_FILE,
	readRuntimePin,
	verifyRuntimeInput,
	writeRuntimePin,
} from '../../../../../scripts/package-mega-maestro-runtime.mjs';
import { SOURCE_TREE_RULES, digestOf } from '../../../../../scripts/write-mega-maestro-handoff.mjs';
import {
	MANAGED_CAPABILITIES,
	MANAGED_CONTRACT_VERSION,
	managedContextProblems,
	isManagedOperationContext,
	type ManagedOperationContext,
} from '../../../../shared/maestro-lib/managed/types';
import {
	MANAGED_CAPABILITY_SUPPORT,
	hostCompatibilityProfile,
	negotiateCompatibility,
	supportAtLeast,
	type CompatibilityRequest,
} from '../../../../shared/maestro-lib/managed/compatibility';
import {
	MANAGED_ROUTES,
	providerRouteSupport,
} from '../../../../shared/maestro-lib/providers/capabilities';
import { getVisibleAgentDefinitions } from '../../../../shared/maestro-lib/providers/definitions';
import {
	MAESTRO_LIB_VERSION,
	MAESTRO_LIB_VERSION_INFO,
} from '../../../../shared/maestro-lib/version';

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');

// ---------------------------------------------------------------------------
// A ustar writer, just enough to build fixtures (and faults) for the reader
// ---------------------------------------------------------------------------

interface TarInput {
	name: string;
	data?: Buffer;
	type?: string;
	linkname?: string;
}

function tarEntry({ name, data = Buffer.alloc(0), type = '0', linkname }: TarInput): Buffer {
	const header = Buffer.alloc(512);
	header.write(name, 0, 100, 'utf8');
	header.write('0000644\0', 100, 8);
	header.write('0000000\0', 108, 8);
	header.write('0000000\0', 116, 8);
	header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 12);
	header.write('00000000000\0', 136, 12);
	header.write('        ', 148, 8);
	header.write(type, 156, 1);
	if (linkname) header.write(linkname, 157, 100, 'utf8');
	header.write('ustar\0', 257, 6);
	header.write('00', 263, 2);
	let sum = 0;
	for (const byte of header) sum += byte;
	header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
	const padded = Math.ceil(data.length / 512) * 512;
	return Buffer.concat([header, data, Buffer.alloc(padded - data.length)]);
}

const tarGz = (entries: TarInput[]): Buffer =>
	gzipSync(Buffer.concat([...entries.map(tarEntry), Buffer.alloc(1024)]));

// ---------------------------------------------------------------------------
// A synthetic contracts artifact, consistent unless a test breaks one thing
// ---------------------------------------------------------------------------

const ENDPOINT_DTS = (protocol: number) =>
	`import { z } from "zod";\nexport declare const attachmentRequest: z.ZodObject<{\n    supportedProtocols: z.ZodArray<z.ZodLiteral<${protocol}>>;\n}>;\n`;

interface ArtifactParts {
	payload: Record<string, string>;
	pkg: Record<string, unknown>;
	provenance: Record<string, unknown>;
	extraEntries: TarInput[];
	manifestPatch: Record<string, unknown>;
	sidecar?: string;
}

function makeArtifact(dir: string, mutate?: (parts: ArtifactParts) => void) {
	const payload: Record<string, string> = {
		'dist/identity.d.ts': 'export declare const identifier: string;\n',
		'dist/identity.js': 'export const identifier = "id";\n',
		'dist/local-endpoint.d.ts': ENDPOINT_DTS(1),
		'dist/local-endpoint.js': 'export const attachmentRequest = {};\n',
	};
	const parts: ArtifactParts = {
		payload,
		pkg: {
			name: '@mega-maestro/contracts',
			version: '0.1.0',
			private: true,
			type: 'module',
			files: ['dist', 'provenance.json'],
			exports: {
				'./identity': { types: './dist/identity.d.ts', import: './dist/identity.js' },
				'./local-endpoint': {
					types: './dist/local-endpoint.d.ts',
					import: './dist/local-endpoint.js',
				},
				'./provenance': './provenance.json',
			},
			dependencies: { zod: '4.6.5' },
		},
		provenance: {
			formatVersion: 1,
			name: '@mega-maestro/contracts',
			version: '0.1.0',
			sourceRevision: 'a'.repeat(40),
			sourceDirty: false,
			inputSha256: { 'package.json': sha256('workspace') },
			payloadSha256: Object.fromEntries(
				Object.entries(payload).map(([file, text]) => [file, sha256(text)])
			),
			tooling: { node: '24.21.0', pnpm: '12.4.2' },
		},
		extraEntries: [],
		manifestPatch: {},
	};
	mutate?.(parts);
	const entries: TarInput[] = [
		...Object.entries(parts.payload).map(([file, text]) => ({
			name: `package/${file}`,
			data: Buffer.from(text),
		})),
		{ name: 'package/package.json', data: Buffer.from(JSON.stringify(parts.pkg)) },
		{ name: 'package/provenance.json', data: Buffer.from(JSON.stringify(parts.provenance)) },
		...parts.extraEntries,
	];
	const archive = tarGz(entries);
	const digest = sha256(archive);
	const manifest = {
		...parts.provenance,
		archive: 'contracts.tgz',
		sha256: digest,
		integrity: `sha512-${createHash('sha512').update(archive).digest('base64')}`,
		...parts.manifestPatch,
	};
	fs.mkdirSync(dir, { recursive: true });
	const manifestPath = path.join(dir, 'artifact.json');
	const archivePath = path.join(dir, 'contracts.tgz');
	fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
	fs.writeFileSync(archivePath, archive);
	fs.writeFileSync(`${archivePath}.sha256`, `${parts.sidecar ?? digest}  contracts.tgz\n`);
	return { manifestPath, archivePath, sha256: digest, manifest };
}

/** Change one payload file and its manifest digest together, so only the intended fault remains. */
function setPayload(parts: ArtifactParts, file: string, text: string): void {
	parts.payload[file] = text;
	(parts.provenance.payloadSha256 as Record<string, string>)[file] = sha256(text);
}

let scratch: string;
let fixtureCount = 0;
const fixture = (mutate?: (parts: ArtifactParts) => void) =>
	makeArtifact(path.join(scratch, `artifact-${fixtureCount++}`), mutate);

/** Run `verifyArtifact` and return the ImportError code it refused with. */
function refusal(
	artifact: ReturnType<typeof makeArtifact>,
	options: { sha256?: string; allowDirtySource?: boolean } = {}
): string {
	try {
		importer.verifyArtifact({
			manifestPath: artifact.manifestPath,
			archivePath: artifact.archivePath,
			expectedSha256: options.sha256 ?? artifact.sha256,
			allowDirtySource: options.allowDirtySource,
		});
	} catch (error) {
		if (error instanceof importer.ImportError) return error.code;
		throw error;
	}
	return 'accepted';
}

beforeAll(() => {
	scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mega-contracts-'));
});

afterAll(() => {
	fs.rmSync(scratch, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Importer
// ---------------------------------------------------------------------------

describe('import-mega-maestro verifyArtifact', () => {
	it('accepts a consistent artifact and records what was verified', () => {
		const artifact = fixture();
		const record = importer.verifyArtifact({
			manifestPath: artifact.manifestPath,
			archivePath: artifact.archivePath,
			expectedSha256: artifact.sha256,
		});
		expect(record).toMatchObject({
			name: '@mega-maestro/contracts',
			version: '0.1.0',
			sha256: artifact.sha256,
			sourceDirty: false,
			endpointProtocols: [1],
			acceptedEndpointProtocols: [1],
			dependencies: { zod: '4.6.5' },
			payloadFiles: 4,
			exports: ['./identity', './local-endpoint', './provenance'],
		});
		expect(record.entries.map((e: { path: string }) => e.path)).toContain(
			'package/dist/identity.js'
		);
		expect(importer.pinFromRecord(record)).not.toHaveProperty('entries');
	});

	it('refuses a digest that is not the archive, in either direction', () => {
		expect(refusal(fixture(), { sha256: '0'.repeat(64) })).toBe('archive-digest');
		expect(refusal(fixture(), { sha256: 'not-hex' })).toBe('usage');
		// The manifest and digest agree with each other, the bytes do not.
		const tampered = fixture();
		fs.appendFileSync(tampered.archivePath, Buffer.from([0]));
		expect(refusal(tampered)).toBe('archive-digest');
	});

	it('refuses an integrity or sidecar that disagrees', () => {
		expect(refusal(fixture((p) => (p.manifestPatch.integrity = 'sha512-AAAA')))).toBe(
			'archive-integrity'
		);
		expect(refusal(fixture((p) => (p.sidecar = 'f'.repeat(64))))).toBe('sidecar-digest');
	});

	it('refuses traversal, absolute and out-of-package entries', () => {
		const traversal = fixture((p) =>
			p.extraEntries.push({ name: 'package/../evil.js', data: Buffer.from('x') })
		);
		expect(refusal(traversal)).toBe('tar-path');
		const absolute = fixture((p) => p.extraEntries.push({ name: '/tmp/evil.js' }));
		expect(refusal(absolute)).toBe('tar-path');
		const outside = fixture((p) => p.extraEntries.push({ name: 'other/evil.js' }));
		expect(refusal(outside)).toBe('tar-path');
	});

	it('refuses links and other non-file entries rather than skipping them', () => {
		const symlink = fixture((p) =>
			p.extraEntries.push({ name: 'package/dist/link.js', type: '2', linkname: '/etc/passwd' })
		);
		expect(refusal(symlink)).toBe('tar-entry-type');
		const hardlink = fixture((p) =>
			p.extraEntries.push({ name: 'package/dist/hard.js', type: '1', linkname: 'package/x' })
		);
		expect(refusal(hardlink)).toBe('tar-entry-type');
	});

	it('bounds the archive it will read', () => {
		const many: TarInput[] = [];
		for (let i = 0; i <= importer.LIMITS.entries; i++) {
			many.push({ name: `package/dist/f${i}.js`, data: Buffer.from('x') });
		}
		expect(() => importer.readTarGz(tarGz(many))).toThrow(/too many entries/);
		expect(() => importer.readTarGz(Buffer.from('not gzip at all'))).toThrow(importer.ImportError);
		expect(() => importer.readTarGz(Buffer.alloc(importer.LIMITS.archiveBytes + 1))).toThrow(
			/size bound/
		);
	});

	it('refuses a payload that differs from the manifest in any way', () => {
		expect(refusal(fixture((p) => setPayload(p, 'dist/extra.js', 'x')))).toBe('accepted');
		const extra = fixture((p) =>
			p.extraEntries.push({ name: 'package/dist/extra.js', data: Buffer.from('x') })
		);
		expect(refusal(extra)).toBe('payload-extra');
		const missing = fixture((p) => {
			(p.provenance.payloadSha256 as Record<string, string>)['dist/gone.js'] = sha256('gone');
		});
		expect(refusal(missing)).toBe('payload-missing');
		const altered = fixture((p) => {
			(p.provenance.payloadSha256 as Record<string, string>)['dist/identity.js'] = 'e'.repeat(64);
		});
		expect(refusal(altered)).toBe('payload-digest');
	});

	it('refuses package versions, names and formats Maestro was not written against', () => {
		const versionOut = fixture((p) => {
			p.provenance.version = '0.2.0';
			p.pkg.version = '0.2.0';
		});
		expect(refusal(versionOut)).toBe('manifest-version');
		expect(refusal(fixture((p) => (p.provenance.name = '@other/contracts')))).toBe('manifest-name');
		expect(refusal(fixture((p) => (p.provenance.formatVersion = 2)))).toBe('manifest-format');
		expect(refusal(fixture((p) => (p.provenance.sourceRevision = 'HEAD')))).toBe(
			'manifest-revision'
		);
	});

	it('refuses an in-archive provenance or package that disagrees with the manifest', () => {
		expect(refusal(fixture((p) => (p.manifestPatch.sourceRevision = 'b'.repeat(40))))).toBe(
			'provenance-mismatch'
		);
		expect(refusal(fixture((p) => (p.pkg.version = '0.1.1')))).toBe('package-mismatch');
		const looseDependency = fixture((p) => (p.pkg.dependencies = { zod: '^4.6.5' }));
		expect(refusal(looseDependency)).toBe('dependency-version');
		const escapingExport = fixture((p) => {
			(p.pkg.exports as Record<string, unknown>)['./escape'] = {
				types: './dist/identity.d.ts',
				import: '../../outside.js',
			};
		});
		expect(refusal(escapingExport)).toBe('export-shape');
	});

	it('refuses an endpoint protocol it does not speak, read from declarations only', () => {
		expect(importer.declaredEndpointProtocols(ENDPOINT_DTS(1))).toEqual([1]);
		expect(importer.declaredEndpointProtocols('nothing here')).toEqual([]);
		const protocol2 = fixture((p) => setPayload(p, 'dist/local-endpoint.d.ts', ENDPOINT_DTS(2)));
		expect(refusal(protocol2)).toBe('protocol');
	});

	it('refuses a dirty-source build unless told to, and keeps the flag either way', () => {
		const dirty = fixture((p) => (p.provenance.sourceDirty = true));
		expect(refusal(dirty)).toBe('dirty-source');
		expect(refusal(dirty, { allowDirtySource: true })).toBe('accepted');
		const record = importer.verifyArtifact({
			manifestPath: dirty.manifestPath,
			archivePath: dirty.archivePath,
			expectedSha256: dirty.sha256,
			allowDirtySource: true,
		});
		expect(record.sourceDirty).toBe(true);
	});

	it('pins the digest: no pin or another digest refuses, --write-pin is the only override', () => {
		const artifact = fixture();
		const record = importer.verifyArtifact({
			manifestPath: artifact.manifestPath,
			archivePath: artifact.archivePath,
			expectedSha256: artifact.sha256,
		});
		const code = (fn: () => void) => {
			try {
				fn();
			} catch (error) {
				return error instanceof importer.ImportError ? error.code : 'other';
			}
			return 'accepted';
		};
		expect(code(() => importer.enforcePin(null, record, false))).toBe('pin-missing');
		expect(code(() => importer.enforcePin({ sha256: 'c'.repeat(64) }, record, false))).toBe(
			'pin-mismatch'
		);
		expect(code(() => importer.enforcePin({ sha256: record.sha256 }, record, false))).toBe(
			'accepted'
		);
		expect(code(() => importer.enforcePin(null, record, true))).toBe('accepted');
	});

	it('imports end to end through main(): extracts, writes the pin, then holds it', () => {
		const inside = path.join('tmp', `contracts-import-${process.pid}`);
		const out = path.join(inside, 'contracts');
		const pinFile = path.join(inside, 'contracts.pin.json');
		const first = fixture();
		const second = fixture((p) =>
			setPayload(p, 'dist/identity.js', 'export const identifier = 2;\n')
		);
		const args = (artifact: ReturnType<typeof makeArtifact>, ...extra: string[]) => [
			'--manifest',
			artifact.manifestPath,
			'--archive',
			artifact.archivePath,
			'--sha256',
			artifact.sha256,
			'--out',
			out,
			'--pin-file',
			pinFile,
			...extra,
		];
		try {
			expect(() => importer.main(args(first))).toThrow(/no pin exists/);
			const written = importer.main(args(first, '--write-pin'));
			expect(written.pinned).toBe(first.sha256);
			const dest = path.join(REPO_ROOT, out);
			expect(fs.readFileSync(path.join(dest, 'dist/identity.js'), 'utf8')).toContain('"id"');
			expect(JSON.parse(fs.readFileSync(path.join(dest, 'IMPORT.json'), 'utf8')).sha256).toBe(
				first.sha256
			);
			expect(JSON.parse(fs.readFileSync(path.join(REPO_ROOT, pinFile), 'utf8')).sha256).toBe(
				first.sha256
			);
			expect(importer.main(args(first, '--verify-only'))).toMatchObject({
				pinMatches: true,
				imported: null,
			});
			expect(() => importer.main(args(second))).toThrow(/pinned/);
			// The refused import left the first one in place.
			expect(fs.readFileSync(path.join(dest, 'dist/identity.js'), 'utf8')).toContain('"id"');
			expect(() => importer.main(args(first, '--out', '/tmp/elsewhere'))).toThrow(
				/outside the repository/
			);
		} finally {
			fs.rmSync(path.join(REPO_ROOT, inside), { recursive: true, force: true });
		}
	});

	it('runs as a command that refuses with exit 2 and names the reason', () => {
		const result = spawnSync(process.execPath, ['scripts/import-mega-maestro.mjs'], {
			cwd: REPO_ROOT,
			encoding: 'utf8',
		});
		expect(result.status).toBe(2);
		expect(result.stderr).toContain('refused (usage)');
	});
});

// ---------------------------------------------------------------------------
// Managed operation context
// ---------------------------------------------------------------------------

const validContext = (): ManagedOperationContext => ({
	contractVersion: MANAGED_CONTRACT_VERSION,
	installation: { installationId: 'inst-1', runtimeId: 'rt-1', processEpoch: 'epoch-1' },
	origin: 'headless',
	actor: { kind: 'service', id: 'controller' },
	delegation: { chain: [{ kind: 'human', id: 'operator' }], grantRef: 'grant-1' },
	identity: {
		requestId: 'req-1',
		idempotencyKey: 'key-1',
		attemptId: 'attempt-1',
		runId: 'run-1',
		rootRunId: 'run-1',
		parentRunId: null,
	},
	policyRevision: 7,
	workflow: null,
	traceId: 'trace-1',
	requestedCapabilities: ['runs.submit'],
});

describe('managedContextProblems', () => {
	it('accepts a complete context', () => {
		expect(managedContextProblems(validContext())).toEqual([]);
		expect(isManagedOperationContext(validContext())).toBe(true);
	});

	it('names every structural fault, and never treats a field as authority', () => {
		const broken = {
			...validContext(),
			contractVersion: 'maestro-managed/2',
			installation: { installationId: 'inst-1', runtimeId: '', processEpoch: 'e' },
			origin: 'root',
			identity: { ...validContext().identity, runId: null },
			policyRevision: 1.5,
			requestedCapabilities: ['runs.submit', 'shell.exec'],
			trusted: true,
		};
		const problems = managedContextProblems(broken);
		expect(problems).toEqual(
			expect.arrayContaining([
				expect.stringContaining('contractVersion'),
				expect.stringContaining('installation.runtimeId'),
				expect.stringContaining('origin'),
				expect.stringContaining('names a root or parent run but no run'),
				expect.stringContaining('policyRevision'),
				expect.stringContaining('shell.exec'),
			])
		);
		expect(isManagedOperationContext(broken)).toBe(false);
		expect(managedContextProblems(null)).toEqual(['context is not an object']);
		expect(managedContextProblems({ ...validContext(), workflow: { workflowId: 'w' } })).toEqual(
			expect.arrayContaining([expect.stringContaining('workflow.fencingToken')])
		);
	});
});

// ---------------------------------------------------------------------------
// Compatibility negotiation
// ---------------------------------------------------------------------------

const profile = hostCompatibilityProfile({ providers: ['claude-code', 'codex'] });
const baseRequest: CompatibilityRequest = {
	contractVersions: [MANAGED_CONTRACT_VERSION],
	endpointProtocols: [1],
	transport: 'in-process',
	required: ['capabilities.negotiate'],
};

describe('negotiateCompatibility', () => {
	it('activates on exactly what both sides share', () => {
		const outcome = negotiateCompatibility(profile, {
			...baseRequest,
			library: `^${MAESTRO_LIB_VERSION}`,
			providers: ['codex'],
			optional: ['runs.submit', 'events.resume'],
		});
		expect(outcome).toEqual({
			outcome: 'activated',
			library: MAESTRO_LIB_VERSION,
			contractVersion: MANAGED_CONTRACT_VERSION,
			endpointProtocol: 1,
			transport: 'in-process',
			capabilities: ['capabilities.negotiate'],
			support: [expect.objectContaining({ key: 'capabilities.negotiate' })],
		});
	});

	it('denies a missing required capability instead of downgrading', () => {
		const outcome = negotiateCompatibility(profile, {
			...baseRequest,
			required: ['capabilities.negotiate', 'events.resume'],
		});
		expect(outcome.outcome).toBe('denied');
		if (outcome.outcome !== 'denied') return;
		expect(outcome.reasons).toEqual([
			{
				reason: 'missing-required-capability',
				detail: expect.stringContaining('events.resume is unsupported'),
			},
		]);
		expect(outcome).not.toHaveProperty('capabilities');
	});

	it('reports every mismatch at once', () => {
		const outcome = negotiateCompatibility(profile, {
			library: '>=9.0.0',
			contractVersions: ['maestro-managed/0'],
			endpointProtocols: [2, 3],
			transport: 'os-peer',
			providers: ['grok'],
			required: ['capabilities.negotiate', 'nope' as never],
		});
		expect(outcome.outcome).toBe('denied');
		if (outcome.outcome !== 'denied') return;
		expect(outcome.reasons.map((r) => r.reason).sort()).toEqual([
			'contract-version',
			'endpoint-protocol',
			'library-version',
			'provider',
			'transport',
			'unknown-capability',
		]);
	});

	it('takes the minimum status from the peer, and the matrix from the host', () => {
		const claimed = hostCompatibilityProfile({
			providers: [],
			capabilities: [
				...MANAGED_CAPABILITY_SUPPORT.filter((entry) => entry.key !== 'runs.submit'),
				{ key: 'runs.submit', status: 'implemented', evidence: 'x.test.ts' },
			],
		});
		const request = { ...baseRequest, required: ['runs.submit'] as const };
		expect(negotiateCompatibility(claimed, request).outcome).toBe('denied');
		const relaxed = negotiateCompatibility(claimed, { ...request, minimumStatus: 'implemented' });
		expect(relaxed).toMatchObject({ outcome: 'activated', capabilities: ['runs.submit'] });
		expect(supportAtLeast('unverified', 'implemented')).toBe(false);
		expect(supportAtLeast('locally-verified', 'implemented')).toBe(true);
	});

	it('picks the highest common endpoint protocol and the peer-preferred contract', () => {
		const wide = { ...profile, endpointProtocols: [1, 2, 3] };
		const outcome = negotiateCompatibility(wide, { ...baseRequest, endpointProtocols: [3, 1] });
		expect(outcome).toMatchObject({ outcome: 'activated', endpointProtocol: 3 });
	});
});

// ---------------------------------------------------------------------------
// The support matrices only say what this build can prove
// ---------------------------------------------------------------------------

describe('support matrices', () => {
	it('covers every managed capability once, with evidence for anything implemented', () => {
		expect(MANAGED_CAPABILITY_SUPPORT.map((entry) => entry.key).sort()).toEqual(
			[...MANAGED_CAPABILITIES].sort()
		);
		for (const entry of MANAGED_CAPABILITY_SUPPORT) {
			if (supportAtLeast(entry.status, 'implemented')) {
				expect(entry.evidence, entry.key).not.toBeNull();
				expect(fs.existsSync(path.join(REPO_ROOT, entry.evidence as string)), entry.key).toBe(true);
			} else {
				expect(entry.evidence, entry.key).toBeNull();
			}
		}
	});

	it('reports managed enforcement on the child-process launch only, unsupported elsewhere', () => {
		for (const definition of getVisibleAgentDefinitions()) {
			const rows = providerRouteSupport(definition.id);
			expect(rows.map((row) => row.route)).toEqual([...MANAGED_ROUTES]);
			for (const row of rows) {
				const expected =
					row.route === 'child-process' && row.standalone !== 'unsupported'
						? 'implemented'
						: 'unsupported';
				expect(row.managed, `${definition.id} ${row.route}`).toBe(expected);
				if (row.managed === 'implemented') expect(row.note).toContain('CP-03');
			}
		}
		const codex = Object.fromEntries(providerRouteSupport('codex').map((r) => [r.route, r]));
		const claude = Object.fromEntries(providerRouteSupport('claude-code').map((r) => [r.route, r]));
		expect(codex['codex-app-server'].standalone).toBe('implemented');
		expect(claude['codex-app-server'].standalone).toBe('unsupported');
		expect(claude['child-process'].standalone).toBe('implemented');
		expect(claude['ssh'].standalone).toBe('unverified');
		expect(providerRouteSupport('not-a-provider')['0'].standalone).toBe('unsupported');
	});

	it('versions the library, the managed contract and Node independently', () => {
		expect(MAESTRO_LIB_VERSION_INFO).toEqual({
			library: MAESTRO_LIB_VERSION,
			managedContract: MANAGED_CONTRACT_VERSION,
			node: '>=20',
		});
		expect(MAESTRO_LIB_VERSION_INFO).not.toHaveProperty('app');
	});
});

// ---------------------------------------------------------------------------
// The packaged runtime artifact, read back as the bootstrap input of a pair
// ---------------------------------------------------------------------------

interface RuntimeParts {
	payload: Record<string, string>;
	map: { rules: string; files: Record<string, string> };
	mapDigest?: string;
	manifestPatch: Record<string, unknown>;
	besidePatch: Record<string, unknown>;
	extraEntries: TarInput[];
	sidecar?: string;
	dirName?: string;
}

const RUNTIME_VERSIONS = {
	app: '1.1.0-RC',
	library: MAESTRO_LIB_VERSION,
	managedContract: MANAGED_CONTRACT_VERSION,
	endpointProtocol: 1,
};

/**
 * A format-2 runtime artifact directory as the packager lands it (archive,
 * sidecar, `artifact.json` with its observations, the directory named by the
 * digest), consistent unless `mutate` breaks one thing.
 */
function makeRuntimeArtifact(parent: string, mutate?: (parts: RuntimeParts) => void) {
	const parts: RuntimeParts = {
		payload: {
			'library/index.js': 'module.exports = { MAESTRO_LIB_VERSION: "synthetic" };\n',
			'conformance/capabilities.json': '{"routes":[]}\n',
			'source/library-inputs.json': `{"inputSha256":"${'b'.repeat(64)}","inputs":{}}\n`,
		},
		map: {
			rules: SOURCE_TREE_RULES.id,
			files: { 'src/a.ts': 'a'.repeat(64), 'src/b.ts': 'c'.repeat(64) },
		},
		manifestPatch: {},
		besidePatch: {},
		extraEntries: [],
	};
	mutate?.(parts);
	const payload: Record<string, string> = {
		...parts.payload,
		'source/implementation.json': JSON.stringify(parts.map),
	};
	const manifest = {
		formatVersion: ARTIFACT_FORMAT_VERSION,
		kind: ARTIFACT_KIND,
		versions: RUNTIME_VERSIONS,
		source: {
			library: { inputSha256: 'b'.repeat(64), inputs: 'source/library-inputs.json' },
			implementation: {
				rules: { id: parts.map.rules },
				digest: parts.mapDigest ?? digestOf(parts.map),
				commit: 'd'.repeat(40),
				fileCount: Object.keys(parts.map.files).length,
				map: 'source/implementation.json',
				dirty: false,
			},
		},
		managedPort: {
			entry: { path: 'library/index.js', sha256: sha256(payload['library/index.js']) },
		},
		payloadSha256: Object.fromEntries(Object.entries(payload).map(([f, t]) => [f, sha256(t)])),
		certifiable: true,
		...parts.manifestPatch,
	};
	const archive = tarGz([
		...Object.entries(payload).map(([file, text]) => ({
			name: `package/${file}`,
			data: Buffer.from(text),
		})),
		{ name: 'package/manifest.json', data: Buffer.from(JSON.stringify(manifest)) },
		...parts.extraEntries,
	]);
	const digest = sha256(archive);
	const dir = path.join(parent, parts.dirName ?? digest);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, 'runtime.tgz'), archive);
	const sidecar = parts.sidecar ?? digest;
	fs.writeFileSync(path.join(dir, 'runtime.tgz.sha256'), `${sidecar}  runtime.tgz\n`);
	fs.writeFileSync(
		path.join(dir, 'artifact.json'),
		JSON.stringify({
			...manifest,
			observed: { head: 'e'.repeat(40) },
			packagedAt: '2026-10-29T00:00:00.000Z',
			archive: {
				file: 'runtime.tgz',
				sha256: digest,
				sha512: createHash('sha512').update(archive).digest('hex'),
				bytes: archive.length,
			},
			...parts.besidePatch,
		})
	);
	const tree = { digest: manifest.source.implementation.digest, files: parts.map.files };
	return { dir, digest, archive, manifest, tree };
}

describe('the packaged runtime artifact as a bootstrap input', () => {
	let runtimeN = 0;
	const runtime = (mutate?: (parts: RuntimeParts) => void) =>
		makeRuntimeArtifact(path.join(scratch, `runtime-${runtimeN++}`), mutate);
	const status = (dir: string) => inspectRuntimeArtifact(dir, null).status;
	let pinFile: string;

	beforeAll(() => {
		pinFile = path.join(scratch, 'runtime-pin.json');
	});

	it('binds a consistent artifact by name, sidecar and both digests, and pins it by identity alone', () => {
		const good = runtime();
		expect(inspectRuntimeArtifact(good.dir, 'e'.repeat(40))).toMatchObject({
			status: 'bound',
			archiveSha256: good.digest,
			implementationDigest: good.tree.digest,
		});
		// The public reader walks it: every entry under package/, every payload file as hashed.
		const entries = importer.readTarGz(good.archive);
		for (const entry of entries) expect(entry.path.startsWith('package/')).toBe(true);
		for (const [file, digest] of Object.entries(good.manifest.payloadSha256)) {
			const entry = entries.find((e: { path: string }) => e.path === `package/${file}`);
			expect(sha256(entry!.data), file).toBe(digest);
		}

		// Current against the (injected) tree, HEAD moved since: a coordination commit alone.
		const unpinned = verifyRuntimeInput({ runtime: good.dir, pin: pinFile, sourceTree: good.tree });
		expect(unpinned).toMatchObject({
			status: 'unpinned',
			drift: { count: 0, files: [] },
			libraryInputs: [],
			coordinationOnly: true,
			pin: { status: 'absent', committed: false },
		});

		const written = writeRuntimePin({ runtime: good.dir, pin: pinFile, sourceTree: good.tree });
		expect(written).toMatchObject({ status: 'ready', pin: { status: 'pinned', committed: false } });
		const pin = JSON.parse(fs.readFileSync(pinFile, 'utf8'));
		expect(pin.runtime).toMatchObject({
			artifactId: RUNTIME_PIN_ARTIFACT_ID,
			kind: ARTIFACT_KIND,
			archiveFormatVersion: ARTIFACT_FORMAT_VERSION,
			archive: { sha256: good.digest, bytes: good.archive.length },
			versions: RUNTIME_VERSIONS,
			implementation: { digest: good.tree.digest, commit: 'd'.repeat(40) },
			location: { directory: `${DEFAULT_OUT_DIR}/${MAESTRO_LIB_VERSION}/${good.digest}` },
		});
		expect(JSON.stringify(pin)).not.toMatch(/"(qualifiedAgainst|adapter|qualification|passed)"/);
	});

	it('refuses traversal, absolute and out-of-package entries, and never loads a forged archive as the pinned input', () => {
		const forged = {
			traversal: runtime((p) =>
				p.extraEntries.push({ name: 'package/../escape.js', data: Buffer.from('x') })
			),
			absolute: runtime((p) => p.extraEntries.push({ name: '/tmp/escape.js' })),
			outside: runtime((p) => p.extraEntries.push({ name: 'other/escape.js' })),
		};
		for (const [fault, artifact] of Object.entries(forged)) {
			expect(() => importer.readTarGz(artifact.archive), fault).toThrow(importer.ImportError);
			expect(() => importer.readTarGz(artifact.archive), fault).toThrow(/escape\.js/);
			// Consistent with itself by digest alone, so bound; but not the archive the pin names.
			expect(status(artifact.dir), fault).toBe('bound');
			const verified = verifyRuntimeInput({
				runtime: artifact.dir,
				pin: pinFile,
				sourceTree: artifact.tree,
			});
			expect(verified.status, fault).toBe('pin-mismatch');
			expect(verified.problems.join(), fault).toContain('archive.sha256');
		}
	});

	it('refuses a digest that is not the archive: a moved byte, a renamed directory, a sidecar or a manifest that disagrees', () => {
		const tampered = runtime();
		fs.appendFileSync(path.join(tampered.dir, 'runtime.tgz'), Buffer.from([0]));
		expect(status(tampered.dir)).toBe('digest-mismatch');
		expect(status(runtime((p) => (p.dirName = 'not-the-digest')).dir)).toBe('digest-mismatch');
		expect(status(runtime((p) => (p.sidecar = '0'.repeat(64))).dir)).toBe('digest-mismatch');
		const sha512 = runtime();
		const beside = JSON.parse(fs.readFileSync(path.join(sha512.dir, 'artifact.json'), 'utf8'));
		beside.archive.sha512 = 'f'.repeat(128);
		fs.writeFileSync(path.join(sha512.dir, 'artifact.json'), JSON.stringify(beside));
		expect(status(sha512.dir)).toBe('digest-mismatch');
		const empty = path.join(scratch, 'runtime-empty');
		fs.mkdirSync(empty);
		expect(status(empty)).toBe('no-manifest');
		// A verification stops at the binding: nothing past it is compared.
		expect(verifyRuntimeInput({ runtime: tampered.dir, pin: pinFile })).toMatchObject({
			status: 'digest-mismatch',
			implementation: null,
			drift: null,
			problems: ['the artifact directory is digest-mismatch'],
		});
	});

	it('refuses a format, kind or certification it was not written against, and a manifest, map or input that drifted', () => {
		expect(status(runtime((p) => (p.manifestPatch.formatVersion = 1)).dir)).toBe(
			'unsupported-format'
		);
		expect(status(runtime((p) => (p.manifestPatch.kind = 'maestro-contracts')).dir)).toBe(
			'wrong-kind'
		);
		expect(status(runtime((p) => (p.manifestPatch.certifiable = false)).dir)).toBe(
			'not-certifiable'
		);
		// The versions beside the archive are not the versions in it.
		const bumped = runtime(
			(p) => (p.besidePatch.versions = { ...RUNTIME_VERSIONS, library: '9.9.9' })
		);
		expect(status(bumped.dir)).toBe('bound');
		expect(
			verifyRuntimeInput({ runtime: bumped.dir, pin: pinFile, sourceTree: bumped.tree })
		).toMatchObject({
			status: 'archive-manifest-mismatch',
			problems: [expect.stringContaining('not the manifest')],
		});
		// The archived map does not reproduce the digest the manifest claims for it.
		const unproven = runtime((p) => (p.mapDigest = '9'.repeat(64)));
		expect(
			verifyRuntimeInput({ runtime: unproven.dir, pin: pinFile, sourceTree: unproven.tree }).status
		).toBe('implementation-digest');
		// The tree moved since the archive: named file by file, and no pin cures it.
		const current = runtime();
		fs.writeFileSync(pinFile, JSON.stringify({ runtime: { archive: { sha256: current.digest } } }));
		const drifted = verifyRuntimeInput({
			runtime: current.dir,
			pin: pinFile,
			sourceTree: {
				digest: 'moved',
				files: {
					'src/a.ts': 'a'.repeat(64),
					'src/b.ts': 'f'.repeat(64),
					'src/c.ts': '1'.repeat(64),
				},
			},
		});
		expect(drifted).toMatchObject({
			status: 'drift',
			drift: { count: 2, files: ['added src/c.ts', 'changed src/b.ts'] },
			coordinationOnly: false,
		});
		// A recorded library input that moved refuses the archive even with the implementation map current.
		const inputs = runtime((p) => {
			p.payload['source/library-inputs.json'] =
				`{"inputSha256":"${'b'.repeat(64)}","inputs":{"package.json":"${'0'.repeat(64)}"}}\n`;
		});
		const moved = verifyRuntimeInput({
			runtime: inputs.dir,
			pin: pinFile,
			sourceTree: inputs.tree,
		});
		expect(moved).toMatchObject({ status: 'drift', libraryInputs: ['package.json'] });
		expect(moved.problems.join()).toContain('library inputs moved');
	});

	it('the committed runtime pin names this source: its library, contract and app versions, an ancestor commit, and no receipt', () => {
		const pin = readRuntimePin(path.resolve(REPO_ROOT, RUNTIME_PIN_FILE));
		expect(pin.status).toBe('pinned');
		const record = pin.record;
		const appVersion = JSON.parse(
			fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')
		).version;
		expect(record).toMatchObject({
			artifactId: RUNTIME_PIN_ARTIFACT_ID,
			kind: ARTIFACT_KIND,
			archiveFormatVersion: ARTIFACT_FORMAT_VERSION,
			archive: {
				file: 'runtime.tgz',
				sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
				sha512: expect.stringMatching(/^[a-f0-9]{128}$/),
			},
			versions: {
				app: appVersion,
				library: MAESTRO_LIB_VERSION,
				managedContract: MANAGED_CONTRACT_VERSION,
				endpointProtocol: 1,
			},
			implementation: {
				rules: SOURCE_TREE_RULES.id,
				digest: expect.stringMatching(/^[a-f0-9]{64}$/),
				commit: expect.stringMatching(/^[a-f0-9]{40}$/),
			},
			location: { directory: `${DEFAULT_OUT_DIR}/${MAESTRO_LIB_VERSION}/${record.archive.sha256}` },
		});
		const text = JSON.stringify(record);
		expect(text).not.toMatch(/"(qualifiedAgainst|adapter|qualification|passed)"/);
		expect(text).not.toContain(os.homedir());
		// The implementation commit the pin names is in this history.
		const ancestor = spawnSync(
			'git',
			['-C', REPO_ROOT, 'merge-base', '--is-ancestor', record.implementation.commit, 'HEAD'],
			{ encoding: 'utf8' }
		);
		expect(ancestor.status, 'the pinned implementation commit is not an ancestor of HEAD').toBe(0);
	});
});
