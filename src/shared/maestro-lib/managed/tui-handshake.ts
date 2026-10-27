/**
 * The host-to-TUI admission handshake (MRC2-03-05).
 *
 * maestro-p spawns Claude's TUI in a pty of its own, from the binary in
 * `MAESTRO_CLAUDE_BIN`, outside every Phase 1 chokepoint: the lease covers the
 * maestro-p process, not the claude under it. A managed host hands the TUI a
 * signed statement of what it admitted (the approved binary's path and the
 * digest of its bytes, the flags the TUI may give claude, the permission
 * ceiling, the lease's run identity) in `TUI_HANDSHAKE_ENV_VAR`, a
 * `MAESTRO_MANAGED_` name the environment ceiling strips from every user layer,
 * stamped after the ceiling. The TUI verifies it against the key the host keeps
 * at mode 0600 in its data directory (resolved by the TUI itself) and holds its
 * spawn to it right before `pty.spawn`. The host half (MRC2-03-05A) mints that
 * key (`loadOrCreateTuiHandshakeKey`) and builds the signed payload for one
 * admitted spawn (`buildTuiHandshake`); the desktop sink stamps it after the
 * lease is checked. No handshake is an unmanaged host, unchanged; one that
 * does not verify is a refusal, never an unchecked spawn.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { canonicalJson } from '../../canonicalJson';
import type { LaunchPermissionMode } from '../launch/env';

export const TUI_HANDSHAKE_ENV_VAR = 'MAESTRO_MANAGED_TUI_ADMISSION';
export const TUI_HANDSHAKE_VERSION = 1;
export const TUI_HANDSHAKE_KEY_FILE_NAME = 'maestro-managed-tui-handshake.key';
export const MAX_TUI_HANDSHAKE_LENGTH = 16_384;
const HEX_64 = /^[0-9a-f]{64}$/;
const PERMISSION_MODES: ReadonlyArray<LaunchPermissionMode | null> = [
	null,
	'readonly',
	'standard',
	'full',
];

/** The lease a managed host minted the maestro-p spawn on. */
export interface TuiHandshakeRun {
	leaseId: string;
	authorityId: string;
	attemptId: string;
	requestId: string;
	runId: string | null;
	policyRevision: number | null;
}

export interface TuiHandshakePayload {
	version: typeof TUI_HANDSHAKE_VERSION;
	run: TuiHandshakeRun;
	/** The exact string `MAESTRO_CLAUDE_BIN` must hold (absolute) and the SHA-256 of the file's bytes, hex. */
	binary: { path: string; digest: string };
	/** Flags by name (`--model`, never `--model=x`); a value after an allowed flag is allowed with it, a positional is not. */
	allowedFlags: string[];
	/** The route's permission ceiling, or null for no pin. */
	permissionMode: LaunchPermissionMode | null;
	issuedAt: string;
}

/** The wire shape: the payload and an HMAC-SHA256 over its canonical JSON, hex. */
interface SignedTuiHandshake {
	payload: TuiHandshakePayload;
	signature: string;
}

// ── Key custody ──────────────────────────────────────────────────────────────

export function tuiHandshakeKeyPath(dataDir: string): string {
	return path.join(dataDir, TUI_HANDSHAKE_KEY_FILE_NAME);
}

type KeyFileRead = { kind: 'absent' } | { kind: 'key'; key: string } | { kind: 'not-a-key' };

function readKeyFile(keyPath: string): KeyFileRead {
	let raw: string;
	try {
		raw = fs.readFileSync(keyPath, 'utf8').trim();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' };
		throw error;
	}
	return HEX_64.test(raw) ? { kind: 'key', key: raw } : { kind: 'not-a-key' };
}

/** The key at the data directory, or null when there is none to read. Never mints one. */
export function readTuiHandshakeKey(dataDir: string): string | null {
	const read = readKeyFile(tuiHandshakeKeyPath(dataDir));
	return read.kind === 'key' ? read.key : null;
}

/**
 * The host's key: the one at the data directory, or a fresh one minted there
 * (32 random bytes, hex) at mode 0600 with `wx`, so two hosts racing on the
 * same directory never overwrite each other and the loser reads the winner's.
 * A file that is there and is not a key is an error, never overwritten: a
 * host that cannot tell what its key is must not sign with one it made up.
 */
export function loadOrCreateTuiHandshakeKey(dataDir: string): string {
	const keyPath = tuiHandshakeKeyPath(dataDir);
	const notAKey = () =>
		new Error(`${keyPath} exists but is not a TUI handshake key; refusing to overwrite it`);
	const existing = readKeyFile(keyPath);
	if (existing.kind === 'key') return existing.key;
	if (existing.kind === 'not-a-key') throw notAKey();
	const minted = randomBytes(32).toString('hex');
	try {
		fs.writeFileSync(keyPath, `${minted}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
		const raced = readKeyFile(keyPath);
		if (raced.kind === 'key') return raced.key;
		throw notAKey();
	}
	return minted;
}

// ── Signing and verification ─────────────────────────────────────────────────

function signPayload(payload: TuiHandshakePayload, key: string): string {
	return createHmac('sha256', Buffer.from(key, 'hex')).update(canonicalJson(payload)).digest('hex');
}

export function encodeTuiHandshake(payload: TuiHandshakePayload, key: string): string {
	const signed: SignedTuiHandshake = { payload, signature: signPayload(payload, key) };
	return canonicalJson(signed);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isText(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0;
}

/** What is wrong with a value offered as a signed handshake; empty when it is one. */
export function tuiHandshakeProblems(value: unknown): string[] {
	if (!isRecord(value)) return ['the handshake is not an object'];
	const problems: string[] = [];
	if (!isText(value.signature) || !HEX_64.test(value.signature))
		problems.push('signature is not a hex HMAC-SHA256');
	const p = value.payload;
	if (!isRecord(p)) return [...problems, 'payload is not an object'];
	if (p.version !== TUI_HANDSHAKE_VERSION)
		problems.push(`payload.version is not ${TUI_HANDSHAKE_VERSION}`);
	const run = p.run;
	if (!isRecord(run)) problems.push('payload.run is not an object');
	else {
		for (const field of ['leaseId', 'authorityId', 'attemptId', 'requestId']) {
			if (!isText(run[field])) problems.push(`payload.run.${field} is not a non-empty string`);
		}
		if (run.runId !== null && !isText(run.runId))
			problems.push('payload.run.runId is not a string or null');
		if (run.policyRevision !== null && typeof run.policyRevision !== 'number') {
			problems.push('payload.run.policyRevision is not a number or null');
		}
	}
	const binary = p.binary;
	if (!isRecord(binary)) problems.push('payload.binary is not an object');
	else {
		if (!isText(binary.path) || !path.isAbsolute(binary.path))
			problems.push('payload.binary.path is not an absolute path');
		if (!isText(binary.digest) || !HEX_64.test(binary.digest))
			problems.push('payload.binary.digest is not a hex SHA-256');
	}
	if (
		!Array.isArray(p.allowedFlags) ||
		p.allowedFlags.some((f) => !isText(f) || !f.startsWith('-'))
	) {
		problems.push('payload.allowedFlags is not a list of flag names');
	}
	if (!PERMISSION_MODES.includes(p.permissionMode as LaunchPermissionMode | null)) {
		problems.push('payload.permissionMode is not a launch permission mode or null');
	}
	if (!isText(p.issuedAt)) problems.push('payload.issuedAt is not a string');
	return problems;
}

export type TuiHandshakeVerification =
	| { ok: true; payload: TuiHandshakePayload }
	| { ok: false; reason: string };

/** Decode and verify an encoded handshake against the key. */
export function verifyTuiHandshake(encoded: string, key: string): TuiHandshakeVerification {
	if (encoded.length > MAX_TUI_HANDSHAKE_LENGTH) {
		return { ok: false, reason: `the handshake exceeds ${MAX_TUI_HANDSHAKE_LENGTH} characters` };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(encoded);
	} catch (error) {
		return { ok: false, reason: `the handshake is not JSON: ${(error as Error).message}` };
	}
	const problems = tuiHandshakeProblems(parsed);
	if (problems.length > 0) return { ok: false, reason: problems.join('; ') };
	const signed = parsed as SignedTuiHandshake;
	const expected = Buffer.from(signPayload(signed.payload, key), 'hex');
	const offered = Buffer.from(signed.signature, 'hex');
	if (expected.length !== offered.length || !timingSafeEqual(expected, offered)) {
		return { ok: false, reason: 'the signature does not verify against the host key' };
	}
	return { ok: true, payload: signed.payload };
}

// ── The binary digest ────────────────────────────────────────────────────────────

/** SHA-256 of a file's bytes, hex, read in chunks so a large provider binary is never held whole. */
export function digestFileSha256(filePath: string): string {
	const hash = createHash('sha256');
	const fd = fs.openSync(filePath, 'r');
	try {
		const chunk = Buffer.allocUnsafe(1024 * 1024);
		for (;;) {
			const read = fs.readSync(fd, chunk, 0, chunk.length, null);
			if (read === 0) break;
			hash.update(chunk.subarray(0, read));
		}
	} finally {
		fs.closeSync(fd);
	}
	return hash.digest('hex');
}

/**
 * `digestFileSha256` remembered per file identity (device, inode, size,
 * mtime), for a host that signs the same provider binary on every turn: a
 * replaced file has a new identity and is read again. A stale answer can only
 * approve bytes that are gone, which the TUI's own digest then refuses.
 */
export function createFileDigestCache(): (filePath: string) => string {
	const cache = new Map<string, { identity: string; digest: string }>();
	return (filePath) => {
		const stat = fs.statSync(filePath);
		const identity = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
		const hit = cache.get(filePath);
		if (hit && hit.identity === identity) return hit.digest;
		const digest = digestFileSha256(filePath);
		cache.set(filePath, { identity, digest });
		return digest;
	};
}

// ── The host side ────────────────────────────────────────────────────────────

/** The flags maestro-p adds to claude's command line itself, after signing. */
export const TUI_OWN_FLAGS: readonly string[] = ['--session-id', '--resume'];
/** Claude's own bypass of permission prompts; maestro-p appends it to a run-mode turn. */
export const CLAUDE_BYPASS_FLAG = '--dangerously-skip-permissions';

/**
 * Whether claude's flags mean no tool call can stop on a permission dialog:
 * the bypass flag, or `--permission-mode bypassPermissions` in either
 * spelling. The one rule both halves read (maestro-p's
 * `skipsPermissionPrompts` delegates here).
 */
export function claudeArgsBypassPermissions(claudeArgs: readonly string[]): boolean {
	for (let i = 0; i < claudeArgs.length; i += 1) {
		const arg = claudeArgs[i];
		if (arg === CLAUDE_BYPASS_FLAG) return true;
		if (arg === '--permission-mode=bypassPermissions') return true;
		if (arg === '--permission-mode' && claudeArgs[i + 1] === 'bypassPermissions') return true;
	}
	return false;
}

/**
 * The flag names in a command line, up to `--` (what follows is the prompt
 * positional maestro-p reads itself). `--model=x` names `--model`; a value
 * token names nothing. Each name once, in first-seen order.
 */
export function flagNamesOf(args: readonly string[]): string[] {
	const names = new Set<string>();
	for (const arg of args) {
		if (arg === '--') break;
		if (!arg.startsWith('-')) continue;
		const eq = arg.indexOf('=');
		names.add(eq > 0 ? arg.slice(0, eq) : arg);
	}
	return [...names];
}

export interface BuildTuiHandshakeInput {
	/** The host key (`loadOrCreateTuiHandshakeKey`). */
	key: string;
	/** The lease the spawn was admitted on. */
	run: TuiHandshakeRun;
	/** The exact string the host set as `MAESTRO_CLAUDE_BIN`; must be absolute. */
	binaryPath: string;
	/** The arguments the host handed maestro-p after its script, as passed. */
	args: readonly string[];
	/** The route's permission ceiling, or null for no pin. */
	permissionMode: LaunchPermissionMode | null;
	digestFile?: (filePath: string) => string;
	now?: () => Date;
}

export type TuiHandshakeBuild =
	| { ok: true; encoded: string; payload: TuiHandshakePayload }
	| { ok: false; reason: string };

/**
 * The signed statement of one admitted spawn. The allowlist is the flags the
 * host passed to maestro-p (a superset of what it forwards to claude, since
 * maestro-p keeps its own flags to itself) plus the flags maestro-p adds
 * after signing (`--session-id`, `--resume`), plus claude's bypass flag only
 * when the ceiling is null or `full`; under a lower pin, arguments that
 * already bypass prompts are refused here rather than signed. A relative or
 * unreadable binary is refused: the digest is the approval, and a path the
 * TUI resolves on PATH is not a binary the host looked at.
 */
export function buildTuiHandshake(input: BuildTuiHandshakeInput): TuiHandshakeBuild {
	const refuse = (reason: string): TuiHandshakeBuild => ({ ok: false, reason });
	if (!path.isAbsolute(input.binaryPath)) {
		return refuse(
			`the claude binary ${JSON.stringify(input.binaryPath)} is not an absolute path; the admission names only a binary the host digested`
		);
	}
	let digest: string;
	try {
		digest = (input.digestFile ?? digestFileSha256)(input.binaryPath);
	} catch (error) {
		return refuse(
			`the claude binary at ${input.binaryPath} could not be read: ${(error as Error).message}`
		);
	}
	const bypassAllowed = input.permissionMode === null || input.permissionMode === 'full';
	if (!bypassAllowed && claudeArgsBypassPermissions(input.args)) {
		return refuse(
			`the arguments bypass permission prompts but the route's ceiling is ${input.permissionMode}`
		);
	}
	const allowedFlags = new Set<string>([...flagNamesOf(input.args), ...TUI_OWN_FLAGS]);
	if (bypassAllowed) allowedFlags.add(CLAUDE_BYPASS_FLAG);
	const payload: TuiHandshakePayload = {
		version: TUI_HANDSHAKE_VERSION,
		run: { ...input.run },
		binary: { path: input.binaryPath, digest },
		allowedFlags: [...allowedFlags],
		permissionMode: input.permissionMode,
		issuedAt: (input.now ?? (() => new Date()))().toISOString(),
	};
	return { ok: true, encoded: encodeTuiHandshake(payload, input.key), payload };
}

// ── The TUI side ─────────────────────────────────────────────────────────────

export type TuiHandshakeRead =
	/** No handshake: an unmanaged host. The TUI spawns as it always did. */
	| { status: 'absent' }
	| { status: 'ok'; payload: TuiHandshakePayload }
	/** Something was offered and it is not a verified handshake. The TUI refuses; it does not spawn unchecked. */
	| { status: 'refused'; reason: string };

/**
 * Read the handshake out of the TUI's environment. A blank entry is absent.
 * Anything else must verify against the key `readKey` resolves at the host's
 * data directory; a missing key is a refusal, because a handshake with no key
 * to check it against was not sent by this host.
 */
export function readTuiHandshakeEnv(
	env: Readonly<Record<string, string | undefined>>,
	deps: { readKey: () => string | null }
): TuiHandshakeRead {
	const raw = env[TUI_HANDSHAKE_ENV_VAR]?.trim();
	if (!raw) return { status: 'absent' };
	let key: string | null;
	try {
		key = deps.readKey();
	} catch (error) {
		return {
			status: 'refused',
			reason: `the host key could not be read: ${(error as Error).message}`,
		};
	}
	if (!key)
		return {
			status: 'refused',
			reason: 'a handshake was offered but this host has no key to verify it with',
		};
	const verified = verifyTuiHandshake(raw, key);
	return verified.ok
		? { status: 'ok', payload: verified.payload }
		: { status: 'refused', reason: verified.reason };
}

export interface TuiSpawnCheckInput {
	/** What the TUI resolved as the binary to spawn. */
	binPath: string;
	/** The arguments the TUI is about to hand claude. */
	args: readonly string[];
	/** Whether those arguments bypass permission prompts (`skipsPermissionPrompts`). */
	bypassesPermissions: boolean;
	digestFile?: (filePath: string) => string;
}

export type TuiSpawnRefusalCode =
	| 'handshake-refused'
	| 'binary-path'
	| 'binary-unreadable'
	| 'binary-digest'
	| 'argument-not-allowed'
	| 'permission-above-ceiling';

export type TuiSpawnCheck = { ok: true } | { ok: false; code: TuiSpawnRefusalCode; reason: string };

/**
 * Hold the spawn the TUI is about to make to the handshake: the binary is the
 * approved path and still has the approved bytes, every flag is allowed, no
 * positional is passed, and the flags do not bypass approvals under a ceiling
 * below `full`. Run right before `pty.spawn`; a refusal means nothing is spawned.
 */
export function checkTuiSpawn(
	payload: TuiHandshakePayload,
	input: TuiSpawnCheckInput
): TuiSpawnCheck {
	const refuse = (code: TuiSpawnRefusalCode, reason: string): TuiSpawnCheck => ({
		ok: false,
		code,
		reason,
	});
	if (input.binPath !== payload.binary.path) {
		return refuse(
			'binary-path',
			`MAESTRO_CLAUDE_BIN is ${JSON.stringify(input.binPath)} but the admission approved ${JSON.stringify(payload.binary.path)}`
		);
	}
	let digest: string;
	try {
		digest = (input.digestFile ?? digestFileSha256)(input.binPath);
	} catch (error) {
		return refuse(
			'binary-unreadable',
			`the approved binary at ${input.binPath} could not be read: ${(error as Error).message}`
		);
	}
	if (digest !== payload.binary.digest) {
		return refuse(
			'binary-digest',
			`the binary at ${input.binPath} is not the one the admission approved (digest ${digest.slice(0, 12)}, approved ${payload.binary.digest.slice(0, 12)})`
		);
	}
	const allowed = new Set(payload.allowedFlags);
	for (let i = 0; i < input.args.length; i += 1) {
		const arg = input.args[i];
		if (!arg.startsWith('-'))
			return refuse(
				'argument-not-allowed',
				`positional argument ${JSON.stringify(arg)} is not in the admission`
			);
		const eq = arg.indexOf('=');
		const name = eq > 0 ? arg.slice(0, eq) : arg;
		if (!allowed.has(name))
			return refuse('argument-not-allowed', `flag ${name} is not in the admission's allowed flags`);
		// A bare flag takes the next token as its value when that token is not a flag.
		if (eq < 0 && i + 1 < input.args.length && !input.args[i + 1].startsWith('-')) i += 1;
	}
	if (
		input.bypassesPermissions &&
		payload.permissionMode !== null &&
		payload.permissionMode !== 'full'
	) {
		return refuse(
			'permission-above-ceiling',
			`the arguments bypass permission prompts but the admission's ceiling is ${payload.permissionMode}`
		);
	}
	return { ok: true };
}
