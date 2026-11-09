// Persistence deltas are based on the snapshot this client actually observed.
// A stale full-session flush must not erase a peer's tabs, transcript or queue.
type RecordData = Record<string, any>;
const same = (a: unknown, b: unknown): boolean =>
	a === b || JSON.stringify(a) === JSON.stringify(b);

const clientFields: Record<string, true> = {
	activeTabId: true,
	activeFileTabId: true,
	activeBrowserTabId: true,
	activeTerminalTabId: true,
	activeGroupId: true,
	inputMode: true,
	inputValue: true,
	commandMode: true,
	stagedImages: true,
	terminalDraftInput: true,
	ptyInitialized: true,
};
const liveFields: Record<string, true> = {
	state: true,
	busySource: true,
	thinkingStartTime: true,
	thinking: true,
	thinkingLogId: true,
	currentCycleTokens: true,
	currentCycleBytes: true,
	pid: true,
	agentError: true,
	agentErrorPaused: true,
	agentErrorTabId: true,
	ptyInitialized: true,
};
const rows: Record<string, true> = {
	aiTabs: true,
	logs: true,
	aiLogs: true,
	shellLogs: true,
	executionQueue: true,
	filePreviewTabs: true,
	browserTabs: true,
	terminalTabs: true,
	snoozedTabs: true,
	members: true,
	unifiedTabOrder: true,
};

function mergeRows(
	incoming: RecordData[],
	stored: RecordData[],
	baseline: RecordData[],
	preserveClient: boolean,
	preserveLive: boolean
): RecordData[] {
	const key = (row: RecordData): string => (row.type ? `${row.type}:${row.id}` : row.id);
	if ([...incoming, ...stored, ...baseline].some((row) => !row || typeof row.id !== 'string')) {
		return same(stored, baseline) ? incoming : stored;
	}
	const before = new Map(baseline.map((row) => [key(row), row]));
	const next = new Map(incoming.map((row) => [key(row), row]));
	const result: RecordData[] = [];
	for (const current of stored) {
		const id = key(current);
		const change = next.get(id);
		const base = before.get(id);
		if (change) {
			result.push(mergeRecord(change, current, base ?? current, preserveClient, preserveLive));
			next.delete(id);
		} else if (!base || !same(current, base)) {
			// A peer added/edited this row after the caller's snapshot.
			result.push(current);
		}
	}
	for (const [id, change] of next) {
		// A row missing from stored but present in baseline was removed by a peer.
		if (before.has(id)) continue;
		if (
			preserveClient &&
			('inputValue' in change || (!preserveLive && 'ptyInitialized' in change))
		) {
			const addition = { ...change };
			if ('inputValue' in change) {
				addition.inputValue = '';
				addition.commandMode = undefined;
				addition.stagedImages = [];
			}
			// A persisted client-created terminal is not proof of a host PTY.
			if (!preserveLive) delete addition.ptyInitialized;
			result.push(addition);
		} else result.push(change);
	}
	// Respect this client's drag order/insertion positions only if the host has
	// not independently reordered the observed rows. Peer-only rows keep their
	// existing slots; removed rows are never revived by a stale drag operation.
	const storedIds = new Set(stored.map(key));
	const baselineOrder = baseline.filter((row) => storedIds.has(key(row))).map(key);
	const storedOrder = stored.filter((row) => before.has(key(row))).map(key);
	if (same(storedOrder, baselineOrder)) {
		const merged = new Map(result.map((row) => [key(row), row]));
		const incomingIds = new Set(incoming.map(key));
		const ordered = incoming
			.map((row) => merged.get(key(row)))
			.filter((row): row is RecordData => row !== undefined);
		let index = 0;
		return result.map((row) => (incomingIds.has(key(row)) ? ordered[index++] : row));
	}
	return result;
}

function mergeRecord(
	incoming: RecordData,
	stored: RecordData,
	baseline: RecordData,
	preserveClient: boolean,
	preserveLive: boolean
): RecordData {
	const result = { ...stored };
	for (const field of new Set([...Object.keys(incoming), ...Object.keys(baseline)])) {
		if (
			field === 'deferredContent' ||
			(preserveClient && clientFields[field]) ||
			(preserveLive && liveFields[field])
		)
			continue;
		const change = incoming[field];
		const current = stored[field];
		const before = baseline[field];
		if (same(change, before)) continue;
		if (rows[field] && Array.isArray(change)) {
			result[field] = mergeRows(
				change,
				Array.isArray(current) ? current : [],
				Array.isArray(before) ? before : [],
				preserveClient,
				preserveLive
			);
		} else if (field === 'tab' && change && current && before) {
			result[field] = mergeRecord(change, current, before, preserveClient, preserveLive);
		} else if (same(current, before)) {
			if (change === undefined) delete result[field];
			else result[field] = change;
		}
	}
	return result;
}

/** Apply only observed session changes; conflicts retain the newer stored value. */
export function mergeSessionPersistenceChanges<T extends RecordData>(
	incoming: T,
	stored: T | undefined,
	baseline: T | undefined,
	preserveClient = false,
	preserveLive = false
): T {
	if (!stored || !baseline) return incoming;
	return mergeRecord(incoming, stored, baseline, preserveClient, preserveLive) as T;
}

/**
 * The stored record fields a governed agent value is read from (MCOMP-23-02):
 * provider (`toolType`), model (`customModel`), working directory (`cwd`, with
 * the `projectRoot` / `fullPath` it travels with) and the account the agent runs
 * as (its env vars and SSH setting decide the account directory). A refused
 * whole-record write puts exactly these back; every other change is kept.
 */
export const GOVERNED_AGENT_RECORD_FIELDS = [
	'toolType',
	'customModel',
	'cwd',
	'projectRoot',
	'fullPath',
	'customEnvVars',
	'sessionSshRemoteConfig',
] as const;

/** `next` with every governed field put back to what `stored` holds (removed where it held none). */
export function restoreGovernedAgentFields<T extends RecordData>(stored: T, next: T): T {
	const result: RecordData = { ...next };
	for (const field of GOVERNED_AGENT_RECORD_FIELDS) {
		if (field in stored) result[field] = stored[field];
		else delete result[field];
	}
	return result as T;
}

/**
 * An edit command's record applied to the stored one (MCOMP-23-02): only the
 * agent's configuration moves. Transcript, tab and queue rows, live process
 * state and the per-client view stay as stored, so a form save never rewrites
 * history a turn appended meanwhile; those persist through their own flush.
 */
export function applyAgentConfigEdit<T extends RecordData>(stored: T, edit: RecordData): T {
	const result: RecordData = { ...stored };
	for (const [field, value] of Object.entries(edit)) {
		if (
			field === 'id' ||
			field === 'deferredContent' ||
			rows[field] ||
			liveFields[field] ||
			clientFields[field]
		)
			continue;
		if (value === undefined) delete result[field];
		else result[field] = value;
	}
	return result as T;
}
