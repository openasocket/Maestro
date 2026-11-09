// src/main/codex-app-server/server-requests.ts

/**
 * Answers for the REQUESTS `codex app-server` sends the client.
 *
 * A server request the client never answers stalls the turn forever, so every
 * one gets an answer the moment it arrives: a policy result for the methods
 * below, and a JSON-RPC error for anything else. The policy is the table in
 * `docs/agent-guides/CODEX-APP-SERVER.md` ("Server-to-client requests"):
 *
 * - With full access (exec's `--dangerously-bypass-approvals-and-sandbox`)
 *   every approval is granted, because exec never asks.
 * - Otherwise every approval is declined, the way `--sandbox read-only`
 *   refuses: the model is told and carries on.
 * - Questions for a human (`requestUserInput`, MCP elicitations) get an empty
 *   answer either way. Nobody is being shown them, so declining lets the turn
 *   continue instead of waiting on a prompt no one can see.
 *
 * Pure, so the whole table is unit-testable without a process.
 */

import type { CodexAppServerRequest, CodexRpcError } from './protocol';
import { effectGranted, type ManagedEffect, type ManagedEffectDecision } from '../managed/effects';

/** JSON-RPC "method not found". */
export const CODEX_RPC_METHOD_NOT_FOUND = -32601;

export type CodexServerRequestAnswer = { result: unknown } | { error: CodexRpcError };

export interface CodexServerRequestPolicy {
	/** True when the turn runs with `danger-full-access`: grant every approval. */
	grantApprovals: boolean;
	/**
	 * Under management: the authority's decision for THIS request's effect
	 * (`codexRequestEffect`), obtained live and bound to the thread, turn and
	 * actor. When present it is the only thing that can grant: full access
	 * grants nothing, and anything but `allow` declines.
	 */
	managed?: ManagedEffectDecision;
}

/** Whether the policy grants this request: the live managed decision when there is one, else the full-access default. */
export function codexRequestGranted(policy: CodexServerRequestPolicy): boolean {
	return policy.managed ? effectGranted(policy.managed) : policy.grantApprovals;
}

/**
 * The exact effect a server request asks for, as the request states it.
 * `item/commandExecution/requestApproval` carries the command line and its
 * cwd (and the argv the server proposes to allow); a file change its paths;
 * a permissions request the profile; a dynamic tool call the tool and its
 * input. A method this table does not know is `other` by name, which an
 * authority refuses on sight. Pure: no interpretation of `reason`, which is
 * the model's prose and never an input to a decision.
 */
export function codexRequestEffect(request: CodexAppServerRequest): ManagedEffect {
	const params = (request.params ?? {}) as Record<string, unknown>;
	const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
	const strings = (value: unknown): string[] =>
		Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
	const projected: ManagedEffect = (() => {
		switch (request.method) {
			case 'item/commandExecution/requestApproval':
			case 'execCommandApproval': {
				const argv = strings(params.proposedExecpolicyAmendment ?? params.command);
				return {
					kind: 'command',
					command: text(params.command) ?? argv.join(' '),
					cwd: text(params.cwd),
					argv: argv.length > 0 ? argv : null,
				};
			}
			case 'item/fileChange/requestApproval':
			case 'applyPatchApproval': {
				const changes = Array.isArray(params.changes) ? params.changes : [];
				const paths = [
					...strings(params.paths),
					...(text(params.path) ? [text(params.path) as string] : []),
					...changes
						.map((change) => text((change as Record<string, unknown> | null)?.path))
						.filter((path): path is string => path !== null),
				];
				return { kind: 'file-change', paths: [...new Set(paths)].sort(), cwd: text(params.cwd) };
			}
			case 'item/permissions/requestApproval':
				return {
					kind: 'permissions',
					permissions:
						params.permissions && typeof params.permissions === 'object'
							? (params.permissions as Record<string, unknown>)
							: {},
				};
			case 'item/tool/call':
				return {
					kind: 'tool-call',
					tool: text(params.tool) ?? text(params.name) ?? 'unknown',
					input: params.arguments ?? params.input ?? null,
				};
			case 'item/tool/requestUserInput':
				return { kind: 'user-input', prompt: text(params.prompt) ?? text(params.message) };
			case 'mcpServer/elicitation/request':
				return { kind: 'elicitation', server: text(params.serverName) ?? text(params.server) };
			default:
				return { kind: 'other', method: request.method };
		}
	})();
	return {
		...projected,
		request: structuredClone({ method: request.method, input: request.params ?? null }),
	};
}

/** The thread, turn and item ids a server request names, for the effect binding. */
export function codexRequestIds(request: CodexAppServerRequest): {
	threadId: string | null;
	turnId: string | null;
	itemId: string | null;
} {
	const params = (request.params ?? {}) as Record<string, unknown>;
	const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
	return {
		threadId: text(params.threadId),
		turnId: text(params.turnId),
		itemId: text(params.itemId),
	};
}

/** The Codex thread and turn a managed spawn is running, as the client itself observed them. */
export interface CodexManagedSession {
	threadId: string | null;
	turnId: string | null;
}

/**
 * The session identity a managed server request is decided under, or why it
 * cannot be decided under this turn at all. A lease covers ONE thread and its
 * one turn; a request is joined to them, never to identifiers it merely
 * claims:
 *
 * - No thread observed yet: nothing to bind the effect to, refused.
 * - A request naming a different thread, or a turn other than the one this
 *   client started, is refused without asking the authority (it would be a
 *   decision under this lease for someone else's effect).
 * - A request that names no thread or turn takes the observed ones; a turn
 *   the request names before the client saw `turn/start` answered is taken
 *   as stated (it is the only turn of this thread) and still bound exactly.
 *
 * Pure; the request id is always the server's own id for this request.
 */
export function codexManagedRequestSession(
	request: CodexAppServerRequest,
	session: CodexManagedSession
): { threadId: string; turnId: string | null; requestId: string } | { problem: string } {
	const ids = codexRequestIds(request);
	if (!session.threadId)
		return { problem: 'The managed turn has no Codex thread to bind this request to.' };
	if (ids.threadId !== null && ids.threadId !== session.threadId)
		return { problem: 'The request names a Codex thread this managed turn does not own.' };
	if (ids.turnId !== null && session.turnId !== null && ids.turnId !== session.turnId)
		return { problem: 'The request names a Codex turn this managed turn did not start.' };
	return {
		threadId: session.threadId,
		turnId: session.turnId ?? ids.turnId,
		requestId: String(request.id),
	};
}

export function answerCodexServerRequest(
	request: CodexAppServerRequest,
	policy: CodexServerRequestPolicy
): CodexServerRequestAnswer {
	const grant = codexRequestGranted(policy);
	switch (request.method) {
		case 'item/commandExecution/requestApproval':
		case 'item/fileChange/requestApproval':
			return { result: { decision: grant ? 'accept' : 'decline' } };

		case 'item/permissions/requestApproval': {
			if (!grant) return { result: { permissions: {} } };
			const requested = (request.params as { permissions?: unknown } | undefined)?.permissions;
			return { result: { permissions: requested ?? {}, scope: 'turn' } };
		}

		case 'execCommandApproval':
		case 'applyPatchApproval':
			return { result: { decision: grant ? 'approved' : 'denied' } };

		case 'item/tool/requestUserInput':
			return { result: { answers: {} } };

		case 'mcpServer/elicitation/request':
			return { result: { action: 'decline' } };

		case 'item/tool/call':
			return { result: { success: false, contentItems: [] } };

		default:
			// Includes `account/chatgptAuthTokens/refresh` and
			// `attestation/generate`, which Maestro cannot satisfy.
			return {
				error: {
					code: CODEX_RPC_METHOD_NOT_FOUND,
					message: `Maestro does not handle ${request.method}`,
				},
			};
	}
}
