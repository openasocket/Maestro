// VIBES v1.0 Standard - Type Definitions
// Mirrors the VIBES specification for AI code audit metadata tracking.

// ============================================================================
// Core Enums / Union Types
// ============================================================================

/** Assurance level controls how much metadata is captured per annotation. */
export type VibesAssuranceLevel = 'low' | 'medium' | 'high';

/** The granularity of an annotation entry. */
export type VibesAnnotationType = 'line' | 'function' | 'session';

/** The action that was performed on the code. */
export type VibesAction = 'create' | 'modify' | 'delete' | 'review';

/** Classification of commands executed by the AI agent. */
export type VibesCommandType =
	| 'shell'
	| 'file_write'
	| 'file_read'
	| 'file_delete'
	| 'api_call'
	| 'tool_use'
	| 'other';

/** Classification of prompts that triggered agent activity. */
export type VibesPromptType =
	| 'user_instruction'
	| 'edit_command'
	| 'chat_message'
	| 'inline_completion'
	| 'review_request'
	| 'refactor_request'
	| 'other';

// ============================================================================
// Configuration
// ============================================================================

/** Project-level VIBES configuration stored in .ai-audit/config.json. */
export interface VibesConfig {
	standard: 'VIBES';
	standard_version: '1.0' | '1.1';
	assurance_level: VibesAssuranceLevel;
	project_name: string;
	tracked_extensions: string[];
	exclude_patterns: string[];
	compress_reasoning_threshold_bytes: number;
	external_blob_threshold_bytes: number;
}

// ============================================================================
// Manifest
// ============================================================================

/** Top-level manifest stored in .ai-audit/manifest.json. */
export interface VibesManifest {
	standard: 'VIBES';
	version: '1.0';
	entries: Record<string, VibesManifestEntry>;
}

/** Discriminated union of all manifest entry types, keyed by `type`. */
export type VibesManifestEntry =
	| VibesEnvironmentEntry
	| VibesCommandEntry
	| VibesPromptEntry
	| VibesReasoningEntry
	| VibesDecisionEntry;

/** Records the tool/model environment that produced annotations. */
export interface VibesEnvironmentEntry {
	type: 'environment';
	tool_name: string;
	tool_version: string;
	model_name: string;
	model_version: string;
	model_parameters: Record<string, unknown> | null;
	tool_extensions: string[] | null;
	created_at: string;
}

/** Records a command executed by the agent. */
export interface VibesCommandEntry {
	type: 'command';
	command_text: string;
	command_type: VibesCommandType;
	command_exit_code: number | null;
	command_output_summary: string | null;
	working_directory: string | null;
	created_at: string;
}

/** Records a prompt that triggered agent activity. */
export interface VibesPromptEntry {
	type: 'prompt';
	prompt_text: string;
	prompt_type: VibesPromptType | null;
	prompt_context_files: string[] | null;
	created_at: string;
}

/** Records reasoning / chain-of-thought output from the model. */
export interface VibesReasoningEntry {
	type: 'reasoning';
	reasoning_text: string | null;
	reasoning_text_compressed: string | null;
	compressed: boolean | null;
	external: boolean | null;
	blob_path: string | null;
	reasoning_token_count: number | null;
	reasoning_model: string | null;
	created_at: string;
}

/** Records a structured decision point. Present at all assurance levels. */
export interface VibesDecisionEntry {
	type: 'decision';
	decision_point: string; // Description of the decision being made
	options: Array<{
		id: string; // Short identifier
		description: string; // Description of the option
		pros?: string[]; // Advantages
		cons?: string[]; // Disadvantages
	}>;
	selected: string; // The id of the chosen option
	rationale: string; // Why this option was selected
	confidence?: 'high' | 'medium' | 'low';
	created_at: string; // ISO-8601
}

// ============================================================================
// Annotations
// ============================================================================

/** Line-level annotation linking code ranges to provenance metadata. */
export interface VibesLineAnnotation {
	type: 'line';
	annotation_id: string; // SHA-256 content-derived ID (spec section 6.4)
	file_path: string;
	line_start: number;
	line_end: number;
	environment_hash: string;
	command_hash: string | null;
	prompt_hash: string | null;
	reasoning_hash: string | null;
	decision_hash?: string | null; // References a decision entry in the manifest (spec section 7.3)
	action: VibesAction;
	timestamp: string;
	commit_hash: string | null;
	session_id: string | null;
	assurance_level: VibesAssuranceLevel;
	// Content anchoring fields (spec section 7.3 — RECOMMENDED)
	/** First 3 lines of the annotated range at annotation time, truncated to 256 bytes.
	 *  Enables fuzzy re-matching after line shifts. */
	anchor_context?: string;
	/** SHA-256 of the full content at line_start through line_end at annotation time.
	 *  Enables exact-match detection for drift. */
	anchor_hash?: string;
	/** SHA-256 of the entire file at annotation time. If this matches the current file,
	 *  line numbers are still valid — no anchor search needed. */
	file_content_hash?: string;
	// PRISM risk score fields (spec section 10.5 — Optional)
	/** Aggregate PRISM score, 0.0–1.0. See PRISM spec. */
	risk_score?: number;
	/** Array of signal assessments. */
	risk_factors?: Array<{
		signal: string; // e.g., "action_type", "scope_lines", "human_review_present"
		value: number; // 0.0–1.0
		weight: number; // 0.0–1.0
		reason?: string; // Optional explanation
	}>;
}

/** Function-level annotation linking named functions to provenance metadata. */
export interface VibeFunctionAnnotation {
	type: 'function';
	annotation_id: string; // SHA-256 content-derived ID (spec section 6.4)
	file_path: string;
	function_name: string;
	function_signature?: string;
	environment_hash: string;
	command_hash?: string;
	prompt_hash?: string;
	reasoning_hash?: string;
	decision_hash?: string | null; // References a decision entry in the manifest (spec section 7.3)
	action: VibesAction;
	timestamp: string;
	commit_hash?: string;
	session_id?: string;
	assurance_level: VibesAssuranceLevel;
	// Content anchoring fields (spec section 7.3/7.4 — RECOMMENDED)
	/** First 3 lines of function body at annotation time, truncated to 256 bytes. */
	anchor_context?: string;
	/** SHA-256 of full function body at annotation time. */
	anchor_hash?: string;
	/** SHA-256 of entire file at annotation time. */
	file_content_hash?: string;
	// PRISM risk score fields (spec section 10.5 — Optional)
	/** Aggregate PRISM score, 0.0–1.0. See PRISM spec. */
	risk_score?: number;
	/** Array of signal assessments. */
	risk_factors?: Array<{
		signal: string; // e.g., "action_type", "scope_lines", "human_review_present"
		value: number; // 0.0–1.0
		weight: number; // 0.0–1.0
		reason?: string; // Optional explanation
	}>;
}

/** Session-level record marking the start or end of an agent session. */
export interface VibesSessionRecord {
	type: 'session';
	annotation_id: string; // SHA-256 content-derived ID (spec section 6.4)
	event: 'start' | 'end';
	session_id: string;
	timestamp: string;
	environment_hash: string | null;
	assurance_level: VibesAssuranceLevel | null;
	description: string | null;
	// EVOLVE extensions (spec section 3):
	parent_session_id?: string | null; // UUID of parent/orchestrator session
	agent_name?: string; // Human-readable: "maestro", "worker-auth", etc.
	agent_type?: string; // Role: "orchestrator", "worker", "reviewer", "other"
}

/** Directed relationship between audit events/context entries (spec section 7.6). */
export interface VibesEdgeRecord {
	type: 'edge';
	edge_type: VibesEdgeType;
	source_ref: string; // annotation_id, context hash, or session_id
	source_type: 'annotation' | 'context' | 'session';
	target_ref: string; // annotation_id, context hash, or session_id
	target_type: 'annotation' | 'context' | 'session';
	timestamp: string; // ISO-8601
	session_id?: string; // Session that recorded this edge
	metadata?: Record<string, unknown>; // Arbitrary key-value metadata
}

export type VibesEdgeType =
	| 'caused_by' // Source was directly caused by target
	| 'depends_on' // Source depends on target
	| 'informed_by' // Source was informed by target context
	| 'delegated_to' // Source session delegated to target session
	| 'supersedes' // Source replaces target
	| 'reviewed_by'; // Source was reviewed in context of target

/** Records a multi-agent orchestration event (EVOLVE spec section 3). */
export interface VibesDelegationRecord {
	type: 'delegation';
	parent_session_id: string; // UUID of orchestrator session
	child_session_id: string; // UUID of delegated sub-agent session
	timestamp: string; // ISO-8601
	task_description?: string; // Human-readable task description
	delegated_files?: string[]; // Relative file paths assigned to sub-agent
	delegation_type?: 'task' | 'review' | 'research' | 'other';
	parent_environment_hash?: string; // References parent's environment entry
	child_environment_hash?: string; // References child's environment entry
}

/** Union of all annotation types written to .ai-audit/annotations.jsonl. */
export type VibesAnnotation =
	| VibesLineAnnotation
	| VibeFunctionAnnotation
	| VibesSessionRecord
	| VibesEdgeRecord
	| VibesDelegationRecord;

// ============================================================================
// VERIFY Spec Types — DSSE Envelope & in-toto v1 Statement
// ============================================================================

/** DSSE envelope wrapping an in-toto attestation statement (VERIFY spec section 3). */
export interface DSSEEnvelope {
	payloadType: 'application/vnd.in-toto+json';
	payload: string; // Base64url-encoded in-toto statement
	signatures: DSSESignature[];
}

/** A single signature entry within a DSSE envelope. */
export interface DSSESignature {
	keyid: string; // SHA-256(DER public key)[0:16] — 16 hex chars
	sig: string; // Base64url-encoded Ed25519 signature over PAE bytes
	keytype?: 'user' | 'tool_provider';
}

/** in-toto v1 attestation statement (VERIFY spec section 4). */
export interface InTotoStatement {
	_type: 'https://in-toto.io/Statement/v1';
	subject: Array<{
		name: string; // e.g., '.ai-audit/manifest.json'
		digest: { sha256: string };
	}>;
	predicateType: 'https://itsavibe.ai/vibes/attestation/v1';
	predicate: {
		validation: { result: 'PASS' | 'FAIL'; version: string };
		project: { name: string; assurance_level: string };
		stats: { total_annotations: number; unique_models: number };
	};
}

// ============================================================================
// Activity Feed — Real-Time VIBES Insights
// ============================================================================

/** Event category for rendering activity feed entries. */
export type VibesActivityFeedCategory =
	| 'tool'
	| 'thinking'
	| 'prompt'
	| 'decision'
	| 'delegation'
	| 'session'
	| 'error';

/** Activity feed event emitted in real-time for the renderer's inline display. */
export interface VibesActivityFeedEvent {
	/** Maestro session ID (maps to a tab) */
	sessionId: string;
	/** VIBES session ID (for delegation chain tracking) */
	vibesSessionId: string;
	/** Event category for rendering */
	category: VibesActivityFeedCategory;
	/** Human-readable summary line */
	summary: string;
	/** ISO-8601 timestamp */
	timestamp: string;
	/** Additional structured data per category */
	detail?: {
		// Tool events
		toolName?: string;
		filePath?: string;
		lineStart?: number;
		lineEnd?: number;
		action?: string; // create, modify, delete, review
		// Thinking events
		thinkingPreview?: string; // First ~200 chars of reasoning
		// Delegation events
		parentSessionId?: string;
		childSessionId?: string;
		taskDescription?: string;
		agentName?: string;
		agentType?: string;
		// Decision events
		decisionPoint?: string;
		selectedOption?: string;
		confidence?: string;
	};
	/** Whether this event is from a subagent (child session) */
	isSubagent: boolean;
	/** Nesting depth (0 = top-level, 1 = first subagent, 2 = sub-subagent) */
	depth: number;
}
