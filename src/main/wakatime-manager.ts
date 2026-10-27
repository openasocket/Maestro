/**
 * WakaTime heartbeat manager.
 * Detects wakatime-cli on the user's PATH and sends heartbeats
 * when AI agent activity (query-complete events) occurs.
 *
 * Heartbeats are debounced per session (max 1 per 2 minutes) to match
 * WakaTime's own deduplication window.
 *
 * If the CLI is not found, it is automatically downloaded and installed
 * from GitHub releases to ~/.wakatime/.
 * Under management (MRC2-04-07) every fetch, extraction and run is held to the
 * install ceiling (pinned source and digest; a PATH name never runs; no "latest"),
 * and (MRC2-05-02) both GitHub requests leave through the fetch chokepoint as
 * `updates`, so the egress ceiling can refuse them before a socket opens.
 */

import { execFileNoThrow } from './utils/execFile';
import { logger } from './utils/logger';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import type { ReadableStream as NodeReadableStream } from 'stream/web';
import { isWindows } from '../shared/platformDetection';
import { captureException } from './utils/sentry';
import {
	DEFAULT_FETCH_TIMEOUT_MS,
	fetchWithTimeout,
	isEgressDeniedError,
} from './utils/fetchWithTimeout';
import { createFileDigestCache } from '../shared/maestro-lib/managed/tui-handshake';
import {
	formatInstallRefusal,
	INSTALL_OPERATOR,
	type InstallAuthority,
	type InstallDecision,
	type InstallRequest,
} from './enterprise/install-policy';

const LOG_CONTEXT = '[WakaTime]';
const HEARTBEAT_DEBOUNCE_MS = 120_000; // 2 minutes - WakaTime deduplicates within this window
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // Check for CLI updates once per day
/**
 * The egress class both GitHub requests name (MRC2-05-02): the release feed and
 * the zip each fetch or roll forward a binary Maestro did not ship, so a managed
 * host holds them as `updates`. Standalone nothing is consulted.
 */
const WAKATIME_EGRESS_CLASS = 'updates' as const;
/** GitHub refuses an API request that names no User-Agent. */
const REQUEST_HEADERS = { 'User-Agent': 'maestro-wakatime' };

/** Map file extensions (without dot, lowercase) to WakaTime language names */
const EXTENSION_LANGUAGE_MAP = new Map<string, string>([
	['ts', 'TypeScript'],
	['tsx', 'TypeScript'],
	['js', 'JavaScript'],
	['jsx', 'JavaScript'],
	['mjs', 'JavaScript'],
	['cjs', 'JavaScript'],
	['py', 'Python'],
	['rb', 'Ruby'],
	['rs', 'Rust'],
	['go', 'Go'],
	['java', 'Java'],
	['kt', 'Kotlin'],
	['swift', 'Swift'],
	['c', 'C'],
	['cpp', 'C++'],
	['h', 'C'],
	['hpp', 'C++'],
	['cs', 'C#'],
	['php', 'PHP'],
	['ex', 'Elixir'],
	['exs', 'Elixir'],
	['dart', 'Dart'],
	['json', 'JSON'],
	['yaml', 'YAML'],
	['yml', 'YAML'],
	['toml', 'TOML'],
	['md', 'Markdown'],
	['html', 'HTML'],
	['css', 'CSS'],
	['scss', 'SCSS'],
	['less', 'LESS'],
	['sql', 'SQL'],
	['sh', 'Shell Script'],
	['bash', 'Shell Script'],
	['zsh', 'Shell Script'],
	['vue', 'Vue.js'],
	['svelte', 'Svelte'],
	['lua', 'Lua'],
	['zig', 'Zig'],
	['r', 'R'],
	['scala', 'Scala'],
	['clj', 'Clojure'],
	['erl', 'Erlang'],
	['hs', 'Haskell'],
	['ml', 'OCaml'],
	['nim', 'Nim'],
	['cr', 'Crystal'],
	['tf', 'HCL'],
	['proto', 'Protocol Buffer'],
]);

/**
 * Detect the WakaTime language name from a file path's extension.
 * Returns undefined if the extension is not recognized.
 */
export function detectLanguageFromPath(filePath: string): string | undefined {
	const ext = path.extname(filePath).replace(/^\./, '').toLowerCase();
	if (!ext) return undefined;
	return EXTENSION_LANGUAGE_MAP.get(ext);
}

/** Tool names that represent file write operations across supported agents */
export const WRITE_TOOL_NAMES = new Set<string>([
	'Write',
	'Edit',
	'write_to_file',
	'str_replace_based_edit_tool',
	'create_file',
	'write',
	'patch',
	'NotebookEdit',
]);

/**
 * Extract a file path from a tool-execution event if the tool is a write operation.
 * Returns null if the tool is not a write operation or no file path is found.
 */
export function extractFilePathFromToolExecution(toolExecution: {
	toolName: string;
	state: unknown;
	timestamp: number;
}): string | null {
	if (!WRITE_TOOL_NAMES.has(toolExecution.toolName)) return null;

	const input = (toolExecution.state as any)?.input;
	if (!input || typeof input !== 'object') return null;

	const filePath = input.file_path ?? input.path;
	if (typeof filePath === 'string' && filePath.length > 0) return filePath;

	return null;
}

/** Map Node.js platform to WakaTime release naming */
function getWakaTimePlatform(): string | null {
	switch (process.platform) {
		case 'darwin':
			return 'darwin';
		case 'win32':
			return 'windows';
		case 'linux':
			return 'linux';
		default:
			return null;
	}
}

/** Map Node.js arch to WakaTime release naming */
function getWakaTimeArch(): string | null {
	switch (process.arch) {
		case 'arm64':
			return 'arm64';
		case 'x64':
			return 'amd64';
		case 'ia32':
			return '386';
		default:
			return null;
	}
}

/**
 * Download a URL to a file through the fetch chokepoint. `fetch` follows the
 * GitHub -> S3 redirect itself; the budget covers the response headers and the
 * body streams straight to disk. A partial file is the caller's to unlink.
 */
async function downloadFile(url: string, destPath: string): Promise<void> {
	const response = await fetchWithTimeout(
		url,
		{ headers: REQUEST_HEADERS },
		DEFAULT_FETCH_TIMEOUT_MS,
		WAKATIME_EGRESS_CLASS
	);
	if (!response.ok || !response.body) {
		await response.body?.cancel();
		throw new Error(`Download failed with status ${response.status}`);
	}
	await pipeline(
		Readable.fromWeb(response.body as unknown as NodeReadableStream),
		fs.createWriteStream(destPath)
	);
}

/** Fetch JSON from a URL through the fetch chokepoint (redirects followed by `fetch`). */
async function fetchJson(url: string): Promise<unknown> {
	const response = await fetchWithTimeout(
		url,
		{ headers: REQUEST_HEADERS },
		DEFAULT_FETCH_TIMEOUT_MS,
		WAKATIME_EGRESS_CLASS
	);
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(`HTTP ${response.status}`);
	}
	try {
		return await response.json();
	} catch (err) {
		void captureException(err);
		throw err;
	}
}

/** How long a successfully-detected branch is cached before re-checking (5 min). */
const BRANCH_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Minimal read surface this manager needs from the settings store.
 *
 * Declared structurally rather than as `Store<MaestroSettings>` so the same
 * manager runs in three places: the Electron main process (electron-store
 * satisfies this shape as-is), the `maestro-cli` esbuild bundle (which has no
 * native modules and reads `maestro-settings.json` directly), and tests.
 */
export interface WakaTimeSettingsSource {
	get(key: 'wakatimeEnabled', defaultValue: boolean): boolean;
	get(key: 'wakatimeDetailedTracking', defaultValue: boolean): boolean;
	get(key: 'wakatimeApiKey', defaultValue: string): string;
}

/**
 * Identifies the surface that produced a heartbeat. WakaTime shows this as the
 * "editor", which is how Maestro-driven time is told apart from the time
 * Anthropic's own Claude Code plugin reports for the same `claude` process.
 */
export type WakaTimeOrigin = 'desktop' | 'cue' | 'cli';

/** Per-heartbeat context that is not derivable from the session id alone. */
export interface HeartbeatContext {
	source?: 'user' | 'auto';
	/**
	 * True when the agent runs on an SSH remote. Local git/manifest probing is
	 * skipped in that case: `projectCwd` is a path on the REMOTE host, and a
	 * path of the same name usually also exists locally (both machines check
	 * out `~/Projects/Maestro`), so probing it would silently report the local
	 * machine's branch and language for a remote session.
	 */
	isRemote?: boolean;
	/** Which Maestro surface drove this heartbeat. Defaults to `desktop`. */
	origin?: WakaTimeOrigin;
}

export class WakaTimeManager {
	private settingsStore: WakaTimeSettingsSource;
	private appVersion: string;
	private lastHeartbeatPerSession: Map<string, number> = new Map();
	private branchCache: Map<string, { branch: string; timestamp: number }> = new Map();
	private languageCache: Map<string, string> = new Map();
	private cliPath: string | null = null;
	private cliDetected = false;
	private detecting: Promise<boolean> | null = null;
	private installing: Promise<boolean> | null = null;
	private lastUpdateCheck = 0;
	private installAuthority: InstallAuthority | null = null;
	/** File digests by identity (read only when a pin asks) and the refusal lines already logged once. */
	private readonly digestOf = createFileDigestCache();
	private readonly reportedRefusals = new Set<string>();

	constructor(settingsStore: WakaTimeSettingsSource, appVersion: string) {
		this.settingsStore = settingsStore;
		this.appVersion = appVersion;
	}

	/**
	 * Build the `--plugin` string WakaTime uses for editor attribution.
	 *
	 * The origin rides in the editor name so a WakaTime `slice_by=editor` query
	 * separates desktop chat from Cue runs from CLI/playbook runs. Without it
	 * every surface collapses into one "Maestro" bucket and there is no way to
	 * tell which one is actually driving the time.
	 */
	private pluginString(origin: WakaTimeOrigin = 'desktop'): string {
		const editor = origin === 'desktop' ? 'maestro' : `maestro-${origin}`;
		return `${editor}/${this.appVersion} maestro-wakatime/${this.appVersion}`;
	}

	/** The install ceiling every fetch, extraction and run is held to; null (the default) holds nothing. */
	setInstallAuthority(authority: InstallAuthority | null): void {
		this.installAuthority = authority;
	}

	/** Hold one install step as the operator who enabled WakaTime; a refusal is logged once per reason. */
	private holdInstall(step: Omit<InstallRequest, 'artifact' | 'actor'>): InstallDecision {
		if (!this.installAuthority) return { allowed: true };
		const decision = this.installAuthority.authorize({
			artifact: 'wakatime-cli',
			actor: INSTALL_OPERATOR,
			...step,
		});
		if (!decision.allowed) {
			const reason = formatInstallRefusal(decision);
			this.warnOnce(reason, `WakaTime CLI ${step.stage} refused: ${reason}`);
		}
		return decision;
	}

	/**
	 * A managed refusal is said once per REASON, whichever stage met it first: a
	 * heartbeat every two minutes must not repeat it, and the probe, the fetch
	 * and the run all meet the same missing ceiling.
	 */
	private warnOnce(reason: string, line: string): void {
		if (this.reportedRefusals.has(reason)) return;
		this.reportedRefusals.add(reason);
		logger.warn(line, LOG_CONTEXT);
	}

	/** Hold running the resolved CLI: a path by its bytes, a bare PATH name with no bytes (never under management). */
	private holdCliExecution(cliPath: string): InstallDecision {
		const onDisk = path.isAbsolute(cliPath);
		return this.holdInstall({
			file: onDisk ? path.basename(cliPath) : cliPath,
			stage: 'execute',
			digest: onDisk ? () => this.digestOf(cliPath) : null,
		});
	}

	/** Get the expected local install path for the WakaTime CLI binary */
	private getLocalBinaryPath(): string | null {
		const plat = getWakaTimePlatform();
		const arch = getWakaTimeArch();
		if (!plat || !arch) return null;
		const binaryName = `wakatime-cli-${plat}-${arch}${isWindows() ? '.exe' : ''}`;
		return path.join(os.homedir(), '.wakatime', binaryName);
	}

	/** Detect wakatime-cli on PATH or in ~/.wakatime/ */
	async detectCli(): Promise<boolean> {
		if (this.cliDetected) return this.cliPath !== null;
		// Concurrent callers share the in-flight probe. Answering them from
		// `cliPath` before the probe settles reported "not installed" for a CLI
		// that was about to be found, and kicked off a redundant download.
		if (!this.detecting) {
			this.detecting = this.probeCli().finally(() => {
				this.cliDetected = true;
				this.detecting = null;
			});
		}
		return this.detecting;
	}

	private async probeCli(): Promise<boolean> {
		// Try common binary names on PATH
		for (const cmd of ['wakatime-cli', 'wakatime']) {
			if (!this.holdCliExecution(cmd).allowed) continue;
			const result = await execFileNoThrow(cmd, ['--version']);
			if (result.exitCode === 0) {
				this.cliPath = cmd;
				logger.info(`Found WakaTime CLI: ${cmd} (${result.stdout.trim()})`, LOG_CONTEXT);
				return true;
			}
		}

		// Check the auto-installed binary in ~/.wakatime/
		const localPath = this.getLocalBinaryPath();
		if (localPath && fs.existsSync(localPath) && this.holdCliExecution(localPath).allowed) {
			const result = await execFileNoThrow(localPath, ['--version']);
			if (result.exitCode === 0) {
				this.cliPath = localPath;
				logger.info(`Found WakaTime CLI: ${localPath} (${result.stdout.trim()})`, LOG_CONTEXT);
				return true;
			}
		}

		logger.debug('WakaTime CLI not found on PATH or in ~/.wakatime/', LOG_CONTEXT);
		return false;
	}

	/**
	 * Ensure the WakaTime CLI is installed.
	 * If already available (on PATH or in ~/.wakatime/), returns true immediately.
	 * Otherwise, downloads and installs it from GitHub releases.
	 * Guards against concurrent installation attempts.
	 */
	async ensureCliInstalled(): Promise<boolean> {
		// If already detected, return early
		if (await this.detectCli()) {
			// Held per call: an enrollment landing after a PATH name was cached stops the next beat.
			const held = this.holdCliExecution(this.cliPath!);
			if (!held.allowed) return false;
			// Daily update check, fire-and-forget; under management the pin decides, never "latest".
			const now = Date.now();
			if (!held.managed && now - this.lastUpdateCheck >= UPDATE_CHECK_INTERVAL_MS) {
				this.lastUpdateCheck = now;
				this.checkForUpdate().catch((err) =>
					logger.debug(`Update check failed: ${err}`, LOG_CONTEXT)
				);
			}
			return true;
		}

		// Guard against concurrent installs
		if (this.installing) return this.installing;

		this.installing = this.doInstall();
		try {
			return await this.installing;
		} finally {
			this.installing = null;
		}
	}

	private async doInstall(): Promise<boolean> {
		const plat = getWakaTimePlatform();
		const arch = getWakaTimeArch();
		if (!plat || !arch) {
			logger.warn(
				`Unsupported platform/arch for WakaTime CLI auto-install: ${process.platform}/${process.arch}`,
				LOG_CONTEXT
			);
			return false;
		}

		const binaryName = `wakatime-cli-${plat}-${arch}${isWindows() ? '.exe' : ''}`;
		const zipName = `wakatime-cli-${plat}-${arch}.zip`;
		// Held before any byte is written; under management the zip comes from the pin's source.
		const fetch = this.holdInstall({ file: zipName, stage: 'fetch' });
		if (!fetch.allowed) return false;
		const downloadUrl =
			fetch.pin?.source ??
			`https://github.com/wakatime/wakatime-cli/releases/latest/download/${zipName}`;
		const installDir = path.join(os.homedir(), '.wakatime');
		const zipPath = path.join(os.tmpdir(), zipName);

		try {
			logger.info(`Downloading WakaTime CLI from ${downloadUrl}`, LOG_CONTEXT);

			// Download the zip (to the temp dir, never the install location)
			await downloadFile(downloadUrl, zipPath);
			logger.info('WakaTime CLI download complete, extracting...', LOG_CONTEXT);

			// Held against the bytes before extraction; other bytes are deleted below, never installed.
			const verified = this.holdInstall({
				file: zipName,
				stage: 'execute',
				digest: () => this.digestOf(zipPath),
			});
			if (!verified.allowed) return false;

			// Ensure install directory exists
			fs.mkdirSync(installDir, { recursive: true });

			// Extract
			if (isWindows()) {
				// Use PowerShell to extract on Windows
				const extractResult = await execFileNoThrow('powershell', [
					'-Command',
					`Expand-Archive -Force -Path '${zipPath}' -DestinationPath '${installDir}'`,
				]);
				if (extractResult.exitCode !== 0) {
					logger.warn(`Failed to extract WakaTime CLI: ${extractResult.stderr}`, LOG_CONTEXT);
					return false;
				}
			} else {
				// Use unzip on macOS/Linux
				const extractResult = await execFileNoThrow('unzip', ['-o', zipPath, '-d', installDir]);
				if (extractResult.exitCode !== 0) {
					logger.warn(`Failed to extract WakaTime CLI: ${extractResult.stderr}`, LOG_CONTEXT);
					return false;
				}
			}

			// Make executable on macOS/Linux
			const binaryPath = path.join(installDir, binaryName);
			if (!isWindows()) {
				fs.chmodSync(binaryPath, 0o755);
			}

			// Update state
			this.cliPath = binaryPath;
			this.cliDetected = false; // Reset so next detectCli() re-checks
			logger.info(`WakaTime CLI installed successfully at ${binaryPath}`, LOG_CONTEXT);

			return true;
		} catch (err) {
			if (isEgressDeniedError(err)) {
				// The egress ceiling held the zip: nothing was sent, so this is a
				// managed refusal said once, not an install failure on every beat.
				this.warnOnce(err.message, `WakaTime CLI download refused: ${err.message}`);
				return false;
			}
			logger.warn(
				`Failed to auto-install WakaTime CLI: ${err instanceof Error ? err.message : String(err)}`,
				LOG_CONTEXT
			);
			return false;
		} finally {
			// Clean up zip file
			try {
				fs.unlinkSync(zipPath);
			} catch {
				/* ignore */
			}
		}
	}

	/**
	 * Check if the installed CLI is outdated and update if needed.
	 * Fetches the latest release tag from GitHub and compares it to the
	 * currently installed version. If they differ, re-downloads the CLI.
	 */
	private async checkForUpdate(): Promise<void> {
		try {
			// Get the latest release tag from GitHub
			const release = (await fetchJson(
				'https://api.github.com/repos/wakatime/wakatime-cli/releases/latest'
			)) as { tag_name?: string };
			const latestTag = release?.tag_name;
			if (!latestTag) {
				logger.debug('Could not determine latest WakaTime CLI version from GitHub', LOG_CONTEXT);
				return;
			}

			// Get the currently installed version
			if (!this.cliPath) return;
			const result = await execFileNoThrow(this.cliPath, ['--version']);
			if (result.exitCode !== 0) return;
			const currentVersion = result.stdout.trim();

			// Compare - latestTag is like "v1.73.1", currentVersion is like "wakatime-cli 1.73.1" or "v1.73.1"
			// Normalize both to just the numeric version
			const normalize = (v: string) => v.replace(/^(wakatime-cli\s+|v)/i, '').trim();
			const latest = normalize(latestTag);
			const current = normalize(currentVersion);

			if (latest === current) {
				logger.debug(`WakaTime CLI is up to date (${current})`, LOG_CONTEXT);
				return;
			}

			logger.info(`WakaTime CLI update available: ${current} → ${latest}`, LOG_CONTEXT);

			// Reset detection state and re-install
			this.cliDetected = false;
			this.cliPath = null;
			await this.doInstall();
		} catch (err) {
			logger.debug(
				`WakaTime CLI update check failed: ${err instanceof Error ? err.message : String(err)}`,
				LOG_CONTEXT
			);
		}
	}

	/**
	 * Read the WakaTime API key from ~/.wakatime.cfg (INI format).
	 * Falls back to empty string if the file doesn't exist or can't be parsed.
	 */
	private readApiKeyFromConfig(): string {
		try {
			const cfgPath = path.join(os.homedir(), '.wakatime.cfg');
			if (!fs.existsSync(cfgPath)) return '';
			const content = fs.readFileSync(cfgPath, 'utf-8');
			const match = content.match(/^api_key\s*=\s*(.+)$/m);
			return match ? match[1].trim() : '';
		} catch {
			return '';
		}
	}

	/**
	 * Detect the primary programming language for a project directory by checking
	 * for well-known config/manifest files. Result is cached per session.
	 */
	private detectLanguage(sessionId: string, cwd: string): string | null {
		const cached = this.languageCache.get(sessionId);
		if (cached !== undefined) return cached || null;

		// Ordered by specificity - first match wins
		const markers: [string, string][] = [
			['tsconfig.json', 'TypeScript'],
			['package.json', 'JavaScript'],
			['Cargo.toml', 'Rust'],
			['go.mod', 'Go'],
			['pyproject.toml', 'Python'],
			['setup.py', 'Python'],
			['requirements.txt', 'Python'],
			['Gemfile', 'Ruby'],
			['pom.xml', 'Java'],
			['build.gradle', 'Java'],
			['build.gradle.kts', 'Kotlin'],
			['*.csproj', 'C#'],
			['Package.swift', 'Swift'],
			['CMakeLists.txt', 'C++'],
			['Makefile', 'C'],
			['composer.json', 'PHP'],
			['mix.exs', 'Elixir'],
			['pubspec.yaml', 'Dart'],
			['deno.json', 'TypeScript'],
		];

		for (const [file, language] of markers) {
			if (file.startsWith('*')) {
				// Glob-style: check if any file matches the extension
				try {
					const ext = file.slice(1); // e.g., '.csproj'
					const entries = fs.readdirSync(cwd);
					if (entries.some((e) => e.endsWith(ext))) {
						this.languageCache.set(sessionId, language);
						return language;
					}
				} catch {
					/* ignore */
				}
			} else {
				if (fs.existsSync(path.join(cwd, file))) {
					this.languageCache.set(sessionId, language);
					return language;
				}
			}
		}

		this.languageCache.set(sessionId, '');
		return null;
	}

	/**
	 * Detect the current git branch for a project directory.
	 * Successful results are cached per session with a TTL so branch switches
	 * are picked up. Failures are never cached - the next heartbeat retries.
	 */
	private async detectBranch(sessionId: string, cwd: string): Promise<string | null> {
		const cached = this.branchCache.get(sessionId);
		if (cached && cached.branch && Date.now() - cached.timestamp < BRANCH_CACHE_TTL_MS) {
			return cached.branch;
		}

		const result = await execFileNoThrow('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
		const branch = result.exitCode === 0 ? result.stdout.trim() : '';
		if (branch) {
			this.branchCache.set(sessionId, { branch, timestamp: Date.now() });
		} else {
			// Don't cache failures - retry on next heartbeat
			this.branchCache.delete(sessionId);
		}
		return branch || null;
	}

	/** Send a heartbeat for a session's activity */
	async sendHeartbeat(
		sessionId: string,
		projectName: string,
		projectCwd?: string,
		sourceOrContext?: 'user' | 'auto' | HeartbeatContext
	): Promise<void> {
		const ctx: HeartbeatContext =
			typeof sourceOrContext === 'string' ? { source: sourceOrContext } : (sourceOrContext ?? {});
		const source = ctx.source;
		// Debounce per session BEFORE touching settings. Callers fire this on every
		// stdout chunk of a running agent, and each settings get() is a synchronous
		// read + parse of the whole settings file on the main thread.
		const now = Date.now();
		const lastBeat = this.lastHeartbeatPerSession.get(sessionId) || 0;
		if (now - lastBeat < HEARTBEAT_DEBOUNCE_MS) return;

		// Check if enabled
		const enabled = this.settingsStore.get('wakatimeEnabled', false);
		if (!enabled) return;

		let apiKey = this.settingsStore.get('wakatimeApiKey', '') as string;
		if (!apiKey) {
			apiKey = this.readApiKeyFromConfig();
		}
		if (!apiKey) return;

		// Ensure CLI is available (auto-installs if needed)
		if (!(await this.ensureCliInstalled())) {
			logger.warn('WakaTime CLI not available - skipping heartbeat', LOG_CONTEXT);
			return;
		}

		this.lastHeartbeatPerSession.set(sessionId, now);

		const args = [
			'--key',
			apiKey,
			'--entity',
			'Maestro',
			'--entity-type',
			'app',
			'--project',
			projectName,
			'--plugin',
			this.pluginString(ctx.origin),
			'--category',
			source === 'auto' ? 'ai coding' : 'building',
		];

		// Probe the project directory only when it is on THIS machine. For an
		// SSH session `projectCwd` names a directory on the remote host, and
		// reading a same-named local directory would report the wrong branch
		// and language rather than none at all.
		if (projectCwd && !ctx.isRemote) {
			const language = this.detectLanguage(sessionId, projectCwd);
			if (language) {
				args.push('--language', language);
			}

			const branch = await this.detectBranch(sessionId, projectCwd);
			if (branch) {
				args.push('--alternate-branch', branch);
			}
		}

		const result = await execFileNoThrow(this.cliPath!, args);
		if (result.exitCode === 0) {
			logger.debug(`Heartbeat sent for session ${sessionId} (${projectName})`, LOG_CONTEXT);
		} else {
			logger.warn(`Heartbeat failed for ${sessionId}: ${result.stderr}`, LOG_CONTEXT);
		}
	}

	/**
	 * Send file-level heartbeats for files modified during a query.
	 * The first file is sent as the primary heartbeat via CLI args;
	 * remaining files are batched via --extra-heartbeats on stdin.
	 */
	async sendFileHeartbeats(
		files: Array<{ filePath: string; timestamp: number }>,
		projectName: string,
		projectCwd?: string,
		sourceOrContext?: 'user' | 'auto' | HeartbeatContext
	): Promise<void> {
		if (files.length === 0) return;

		const ctx: HeartbeatContext =
			typeof sourceOrContext === 'string' ? { source: sourceOrContext } : (sourceOrContext ?? {});
		const source = ctx.source;

		const enabled = this.settingsStore.get('wakatimeEnabled', false);
		if (!enabled) return;

		const detailedTracking = this.settingsStore.get('wakatimeDetailedTracking', false);
		if (!detailedTracking) return;

		let apiKey = this.settingsStore.get('wakatimeApiKey', '') as string;
		if (!apiKey) {
			apiKey = this.readApiKeyFromConfig();
		}
		if (!apiKey) return;

		if (!(await this.ensureCliInstalled())) {
			logger.warn('WakaTime CLI not available - skipping file heartbeats', LOG_CONTEXT);
			return;
		}

		// Same local-probe rule as sendHeartbeat: a remote cwd must not be read
		// off this machine's disk.
		const branch =
			projectCwd && !ctx.isRemote
				? await this.detectBranch(`file:${projectCwd}`, projectCwd)
				: null;

		const primary = files[0];
		const args = [
			'--key',
			apiKey,
			'--entity',
			primary.filePath,
			'--entity-type',
			'file',
			'--write',
			'--project',
			projectName,
			'--plugin',
			this.pluginString(ctx.origin),
			'--category',
			source === 'auto' ? 'ai coding' : 'building',
			'--time',
			String(primary.timestamp / 1000),
		];

		const primaryLanguage = detectLanguageFromPath(primary.filePath);
		if (primaryLanguage) {
			args.push('--language', primaryLanguage);
		}

		if (branch) {
			args.push('--alternate-branch', branch);
		}

		const extraFiles = files.slice(1);
		if (extraFiles.length > 0) {
			args.push('--extra-heartbeats');
		}

		const extraArray = extraFiles.map((f) => {
			const obj: Record<string, unknown> = {
				entity: f.filePath,
				type: 'file',
				is_write: true,
				time: f.timestamp / 1000,
				category: source === 'auto' ? 'ai coding' : 'building',
				project: projectName,
			};
			const lang = detectLanguageFromPath(f.filePath);
			if (lang) obj.language = lang;
			if (branch) obj.branch = branch;
			return obj;
		});

		const result = await execFileNoThrow(
			this.cliPath!,
			args,
			projectCwd,
			extraFiles.length > 0 ? { input: JSON.stringify(extraArray) } : undefined
		);

		if (result.exitCode === 0) {
			logger.info('Sent file heartbeats', LOG_CONTEXT, { count: files.length });
		} else {
			logger.warn(`File heartbeats failed: ${result.stderr}`, LOG_CONTEXT, { count: files.length });
		}
	}

	/** Get the resolved CLI path (null if not yet detected/installed) */
	getCliPath(): string | null {
		return this.cliPath;
	}

	/** Clean up stale session entries */
	removeSession(sessionId: string): void {
		this.lastHeartbeatPerSession.delete(sessionId);
		this.branchCache.delete(sessionId);
		this.languageCache.delete(sessionId);
	}
}
