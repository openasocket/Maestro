// VIBES v1.0 Query Database Stub — audit.db generation (spec section 4/7.6).
//
// The query database (audit.db) is a derived artifact generated from annotations.jsonl
// by compliant tooling. It provides indexed SQL queries for analysis and reporting.
//
// Since Maestro reads annotations.jsonl directly for the UI, audit.db is primarily
// for external tooling (DuckDB CLI, data analysis). The vibecheck CLI already
// generates audit.db via `vibecheck build`. Maestro defers to that tool.

/**
 * Generate the audit.db query database from annotations.jsonl.
 *
 * This is a derived artifact — it is NOT the source of truth.
 * The canonical audit trail is always annotations.jsonl.
 *
 * Currently deferred: use `vibecheck build` for query database generation.
 * When implemented, this will create a DuckDB/SQLite database with indexed
 * tables for annotations, sessions, edges, and delegation records.
 */
export async function generateAuditDb(_projectPath: string): Promise<void> {
	console.info(
		'[vibes-query-db] audit.db generation not yet implemented — use `vibecheck build` for query database generation.'
	);
}
