/**
 * Phase 01 contracts: the artifact importer, the managed-operation context
 * validator, compatibility negotiation and the provider route matrix.
 *
 * The importer is driven through its exported functions on synthetic
 * artifacts built here (a tiny ustar writer, gzip, sha256), one deliberate
 * fault per test, so every refusal is reached by the real check rather than
 * a mocked one. One test runs the command line end to end in a scratch
 * folder under the repository (the importer refuses a destination outside it).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

import * as importer from '../../../../../scripts/import-mega-maestro.mjs';
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
			required: ['capabilities.negotiate', 'runs.submit'],
		});
		expect(outcome.outcome).toBe('denied');
		if (outcome.outcome !== 'denied') return;
		expect(outcome.reasons).toEqual([
			{
				reason: 'missing-required-capability',
				detail: expect.stringContaining('runs.submit is unsupported'),
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

	it('reports managed enforcement as unsupported on every provider route', () => {
		for (const definition of getVisibleAgentDefinitions()) {
			const rows = providerRouteSupport(definition.id);
			expect(rows.map((row) => row.route)).toEqual([...MANAGED_ROUTES]);
			for (const row of rows)
				expect(row.managed, `${definition.id} ${row.route}`).toBe('unsupported');
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
