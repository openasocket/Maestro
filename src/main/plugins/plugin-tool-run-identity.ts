/** Ephemeral, main-process proof of the agent that owns a local MCP bridge. */
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { logger } from '../utils/logger';

const DEFAULT_TTL_MS = 60 * 60 * 1000;
// Cue permits a 24-hour run; keep its caller proof valid for that full budget
// plus the one-minute teardown margin requested by the spawn builder.
const MAX_TTL_MS = 24 * DEFAULT_TTL_MS + 60_000;
const MAX_RUN_RECEIPTS = 16;
const MAX_MESSAGE_IDS = 20;
const MAX_ADVERTISED_TOOL_IDS = 256;
const MAX_TOOL_ID_LENGTH = 200;

/** Only host-observed IDs from a successful call to the requested tool. */
export interface PluginToolReceipt {
	runId: string;
	agentId: string;
	toolId: string;
	messageIds: string[];
}

/**
 * What the host itself observed of one run's MCP bridge (GT1-07-06): how many
 * times a bridge holding this run's proof listed tools (a reconnect, a
 * restarted bridge, a native child agent's own MCP client or a discovery
 * meta-tool listing again each count once), the declared tool ids those
 * listings returned, and the receipts of executed calls. A provider's own
 * report of which tools it loaded is never part of this record.
 */
export interface PluginToolRunEvidence {
	advertisements: number;
	advertisedToolIds: string[];
	receipts: PluginToolReceipt[];
	receiptsOverflowed: boolean;
}

/** Why a run that required plugin tools has no execution evidence for them. */
export type PluginToolEvidenceProblem =
	| 'tools-not-advertised'
	| 'required-tool-not-advertised'
	| 'receipt-limit-exceeded'
	| 'receipt-missing';

interface PluginToolRun {
	agentId: string;
	runId: string;
	expiresAt: number;
	receiptToolId?: string;
	receipts: PluginToolReceipt[];
	receiptsOverflowed: boolean;
	advertisements: number;
	advertisedToolIds: Set<string>;
}

/**
 * The one rule for whether a run that required plugin tools proved them
 * (GT1-07-06). Required tools need a host-observed listing that returned at
 * least one declared tool to this run's bridge. A required receipt needs that
 * tool among the listed ones AND a host receipt of an executed call to it for
 * this agent: advertisement alone is never execution evidence, and a receipt
 * for a tool the bridge never listed to this run is not accepted either. A
 * receipt limit overflow fails rather than guessing which call succeeded.
 * Pure: the caller decides what to do with the problem (the headless runner
 * fails the turn; nothing falls back to a run without the bridge).
 */
export function pluginToolEvidenceProblem(input: {
	requirePluginTools: boolean;
	receiptToolId?: string;
	agentId: string;
	evidence: PluginToolRunEvidence;
}): PluginToolEvidenceProblem | null {
	const { evidence, receiptToolId } = input;
	if (!input.requirePluginTools && !receiptToolId) return null;
	if (evidence.advertisements === 0 || evidence.advertisedToolIds.length === 0) {
		return 'tools-not-advertised';
	}
	if (!receiptToolId) return null;
	if (!evidence.advertisedToolIds.includes(receiptToolId)) return 'required-tool-not-advertised';
	if (evidence.receiptsOverflowed) return 'receipt-limit-exceeded';
	const executed = evidence.receipts.some(
		(receipt) =>
			receipt.toolId === receiptToolId &&
			receipt.agentId === input.agentId &&
			receipt.messageIds.length > 0
	);
	return executed ? null : 'receipt-missing';
}

/** The user-facing line for a {@link PluginToolEvidenceProblem}. */
export function pluginToolEvidenceMessage(
	problem: PluginToolEvidenceProblem,
	receiptToolId?: string
): string {
	switch (problem) {
		case 'tools-not-advertised':
			return 'The provider never listed Maestro plugin tools from its MCP bridge during this run';
		case 'required-tool-not-advertised':
			return `The provider never listed the required plugin tool "${receiptToolId ?? ''}" during this run`;
		case 'receipt-limit-exceeded':
			return 'Plugin tool receipt limit exceeded; inspect recorded receipts before retrying';
		case 'receipt-missing':
			return 'Required plugin tool returned no delivery receipt';
	}
}

export interface PluginToolCallerContext {
	/** Verified against a stored Maestro agent when the run proof was issued. */
	readonly callerAgentId: string | null;
}

export class PluginToolRunIdentity {
	private readonly runs = new Map<string, PluginToolRun>();

	issue(agentId: string, ttlMs = DEFAULT_TTL_MS, receiptToolId?: string): string {
		if (!agentId || !Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error('InvalidPluginRun');
		if (receiptToolId !== undefined && (!receiptToolId || receiptToolId.length > 200)) {
			throw new Error('InvalidPluginReceiptTool');
		}
		const now = Date.now();
		for (const [token, run] of this.runs) {
			if (run.expiresAt <= now) this.runs.delete(token);
		}
		const token = randomBytes(32).toString('hex');
		this.runs.set(token, {
			agentId,
			runId: randomBytes(16).toString('hex'),
			expiresAt: now + Math.min(ttlMs, MAX_TTL_MS),
			receiptToolId,
			receipts: [],
			receiptsOverflowed: false,
			advertisements: 0,
			advertisedToolIds: new Set(),
		});
		return token;
	}

	resolve(token: unknown): PluginToolCallerContext {
		if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) {
			return { callerAgentId: null };
		}
		const run = this.runs.get(token);
		if (!run) return { callerAgentId: null };
		if (run.expiresAt <= Date.now()) {
			this.runs.delete(token);
			return { callerAgentId: null };
		}
		return { callerAgentId: run.agentId };
	}

	/** The caller's tool JSON cannot supply any part of this receipt. */
	recordReceipt(token: unknown, toolId: string, result: unknown): void {
		if (this.resolve(token).callerAgentId === null) return;
		const run = this.runs.get(token as string);
		if (!run?.receiptToolId || run.receiptToolId !== toolId || run.receiptsOverflowed) return;
		if (!result || typeof result !== 'object' || Array.isArray(result)) return;
		const toolResult = result as Record<string, unknown>;
		if (
			toolResult.success === false ||
			toolResult.ok === false ||
			(toolResult.error !== undefined && toolResult.error !== null)
		) {
			return;
		}
		const ids = toolResult.messageIds;
		if (
			!Array.isArray(ids) ||
			ids.length === 0 ||
			ids.length > MAX_MESSAGE_IDS ||
			!ids.every((id) => typeof id === 'string' && /^[1-9][0-9]{0,19}$/.test(id))
		) {
			return;
		}
		if (run.receipts.length >= MAX_RUN_RECEIPTS) {
			run.receiptsOverflowed = true;
			return;
		}
		run.receipts.push({
			runId: run.runId,
			agentId: run.agentId,
			toolId,
			messageIds: [...ids],
		});
	}

	getReceipts(token: unknown): PluginToolReceipt[] {
		if (this.resolve(token).callerAgentId === null) return [];
		const run = this.runs.get(token as string);
		return run
			? run.receipts.map((receipt) => ({ ...receipt, messageIds: [...receipt.messageIds] }))
			: [];
	}

	/**
	 * Record a listing the host answered for a bridge holding this run's proof.
	 * The ids are the host's own projection of declared tools, never the
	 * caller's JSON; an empty listing still counts as a listing that advertised
	 * nothing. Ids accumulate across listings, so a reconnect that re-lists
	 * keeps what the run was already shown; the set is bounded.
	 */
	recordAdvertisement(token: unknown, toolIds: readonly string[]): void {
		if (this.resolve(token).callerAgentId === null) return;
		const run = this.runs.get(token as string);
		if (!run) return;
		run.advertisements = Math.min(run.advertisements + 1, Number.MAX_SAFE_INTEGER);
		for (const id of toolIds) {
			if (run.advertisedToolIds.size >= MAX_ADVERTISED_TOOL_IDS) break;
			if (typeof id === 'string' && id.length > 0 && id.length <= MAX_TOOL_ID_LENGTH) {
				run.advertisedToolIds.add(id);
			}
		}
	}

	/** The host-observed record of one live run; empty for an unknown or expired proof. */
	getEvidence(token: unknown): PluginToolRunEvidence {
		const run =
			this.resolve(token).callerAgentId === null ? undefined : this.runs.get(token as string);
		if (!run) {
			return { advertisements: 0, advertisedToolIds: [], receipts: [], receiptsOverflowed: false };
		}
		return {
			advertisements: run.advertisements,
			advertisedToolIds: [...run.advertisedToolIds],
			receipts: this.getReceipts(token),
			receiptsOverflowed: run.receiptsOverflowed,
		};
	}

	hasReceiptOverflowed(token: unknown): boolean {
		if (this.resolve(token).callerAgentId === null) return false;
		return this.runs.get(token as string)?.receiptsOverflowed === true;
	}

	revoke(token: string): void {
		this.runs.delete(token);
	}
}

/** The desktop, Cue executor and WebSocket handlers share one main process. */
export const pluginToolRunIdentity = new PluginToolRunIdentity();

/** A local MCP client may filter inherited environment variables. Put the
 * proof in a 0600 file and pass only its path through the MCP server spec. */
export function createPluginRunProofFile(token: string, ttlMs = DEFAULT_TTL_MS): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-plugin-run-'));
	if (process.platform !== 'win32') fs.chmodSync(dir, 0o700);
	const file = path.join(dir, 'proof');
	try {
		fs.writeFileSync(file, token, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
		if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
	} catch (error) {
		fs.rmSync(dir, { recursive: true, force: true });
		throw error;
	}
	const cleanup = setTimeout(
		() => {
			try {
				removePluginRunProofFile(file);
			} catch (error) {
				logger.warn('Could not remove expired plugin run proof file', '[PluginRunIdentity]', {
					error: String(error),
				});
			}
		},
		Math.min(ttlMs, MAX_TTL_MS)
	);
	cleanup.unref?.();
	return file;
}

export function removePluginRunProofFile(file: string): void {
	const dir = path.dirname(file);
	if (path.basename(file) !== 'proof' || !path.basename(dir).startsWith('maestro-plugin-run-')) {
		throw new Error('InvalidPluginRunProofPath');
	}
	fs.rmSync(dir, { recursive: true, force: true });
}
