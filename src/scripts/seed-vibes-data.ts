/**
 * Seed VIBES data for the Maestro project.
 *
 * Creates realistic `.ai-audit/` data representing actual Maestro development
 * activity with multiple models, sessions, and file annotations.
 *
 * Usage: npx tsx src/scripts/seed-vibes-data.ts
 */

import * as path from 'path';
import * as crypto from 'crypto';
import {
	initVibesDirectly,
	appendAnnotationImmediate,
	addManifestEntry,
	flushAll,
	writeVibesManifest,
	readAnnotations,
	readVibesManifest,
} from '../main/vibes/vibes-io';
import { computeVibesHash } from '../main/vibes/vibes-hash';
import type {
	VibesEnvironmentEntry,
	VibesCommandEntry,
	VibesPromptEntry,
	VibesReasoningEntry,
	VibesLineAnnotation,
	VibesSessionRecord,
} from '../shared/vibes-types';

// ============================================================================
// Project path — seed data in the Maestro project itself
// ============================================================================

const PROJECT_PATH = path.resolve(__dirname, '..', '..');

// ============================================================================
// Manifest entries
// ============================================================================

const environments: VibesEnvironmentEntry[] = [
	{
		type: 'environment',
		tool_name: 'claude-code',
		tool_version: '1.0.0',
		model_name: 'claude-sonnet-4-5-20250929',
		model_version: '20250929',
		created_at: '2026-02-10T09:00:00Z',
	},
	{
		type: 'environment',
		tool_name: 'codex-cli',
		tool_version: '0.1.0',
		model_name: 'o3',
		model_version: '2025-04-16',
		created_at: '2026-02-10T14:00:00Z',
	},
	{
		type: 'environment',
		tool_name: 'maestro',
		tool_version: '2.0.0',
		model_name: 'claude-sonnet-4-5-20250929',
		model_version: '20250929',
		created_at: '2026-02-10T09:00:00Z',
	},
];

const prompts: VibesPromptEntry[] = [
	{
		type: 'prompt',
		prompt_text: 'Add VIBES panel to the right sidebar with sub-tab navigation for Overview, Log, Models, Blame, Coverage, and Reports views.',
		prompt_type: 'user_instruction',
		prompt_context_files: ['src/renderer/components/RightPanel.tsx'],
		created_at: '2026-02-10T09:05:00Z',
	},
	{
		type: 'prompt',
		prompt_text: 'Implement annotation write buffering with auto-flush every 2 seconds or 20 annotations, whichever comes first.',
		prompt_type: 'edit_command',
		prompt_context_files: ['src/main/vibes/vibes-io.ts'],
		created_at: '2026-02-10T10:15:00Z',
	},
	{
		type: 'prompt',
		prompt_text: 'Fix the content-addressed hashing to exclude created_at fields and sort keys deterministically.',
		prompt_type: 'edit_command',
		prompt_context_files: ['src/main/vibes/vibes-hash.ts'],
		created_at: '2026-02-10T11:30:00Z',
	},
	{
		type: 'prompt',
		prompt_text: 'Add Claude Code instrumenter that captures prompts, reasoning, and tool executions as VIBES annotations.',
		prompt_type: 'user_instruction',
		prompt_context_files: ['src/main/vibes/instrumenters/claude-code-instrumenter.ts'],
		created_at: '2026-02-10T14:05:00Z',
	},
	{
		type: 'prompt',
		prompt_text: 'Review the VIBES coordinator for potential race conditions in session lifecycle management.',
		prompt_type: 'review_request',
		prompt_context_files: ['src/main/vibes/vibes-coordinator.ts', 'src/main/vibes/vibes-session.ts'],
		created_at: '2026-02-11T08:00:00Z',
	},
];

const reasoning: VibesReasoningEntry[] = [
	{
		type: 'reasoning',
		reasoning_text: 'The VIBES panel needs to be a full-featured sub-application within the right sidebar. I will implement a tab-based navigation system with 6 sub-tabs. The Overview tab will show a dashboard with stats cards and quick actions. Each tab will receive vibesData from a shared hook.',
		reasoning_token_count: 85,
		reasoning_model: 'claude-sonnet-4-5-20250929',
		created_at: '2026-02-10T09:05:30Z',
	},
	{
		type: 'reasoning',
		reasoning_text: 'Write buffering is essential for performance. Appending to JSONL on every annotation would be too many I/O operations. A buffer with both size-based (20 annotations) and time-based (2 seconds) flush triggers ensures data is written promptly without excessive I/O.',
		reasoning_token_count: 62,
		reasoning_model: 'claude-sonnet-4-5-20250929',
		created_at: '2026-02-10T10:15:30Z',
	},
	{
		type: 'reasoning',
		reasoning_text: 'The hashing must be deterministic for content-addressed deduplication. The created_at timestamp varies per call so it must be excluded. Sorting object keys ensures { a: 1, b: 2 } and { b: 2, a: 1 } produce the same hash.',
		reasoning_token_count: 55,
		reasoning_model: 'o3',
		created_at: '2026-02-10T11:30:30Z',
	},
];

const commands: VibesCommandEntry[] = [
	{
		type: 'command',
		command_text: 'Write(src/renderer/components/vibes/VibesPanel.tsx)',
		command_type: 'file_write',
		command_exit_code: 0,
		created_at: '2026-02-10T09:10:00Z',
	},
	{
		type: 'command',
		command_text: 'npx vitest run src/__tests__/main/vibes/ --no-coverage',
		command_type: 'shell',
		command_exit_code: 0,
		command_output_summary: 'Test Files  24 passed (24)\n      Tests  682 passed (682)',
		created_at: '2026-02-10T10:30:00Z',
	},
	{
		type: 'command',
		command_text: 'Edit(src/main/vibes/vibes-hash.ts, line 15-25)',
		command_type: 'file_write',
		command_exit_code: 0,
		created_at: '2026-02-10T11:35:00Z',
	},
];

// ============================================================================
// File annotations
// ============================================================================

interface AnnotationDef {
	file_path: string;
	line_start: number;
	line_end: number;
	action: 'create' | 'modify' | 'review';
	envIndex: number;
	cmdIndex: number;
	promptIndex: number;
	reasoningIndex: number;
	assurance_level: 'low' | 'medium' | 'high';
	timestamp: string;
	sessionIndex: number;
}

const annotationDefs: AnnotationDef[] = [
	// Session 1: Claude Code + Sonnet — VIBES panel creation
	{ file_path: 'src/renderer/components/vibes/VibesPanel.tsx', line_start: 1, line_end: 60, action: 'create', envIndex: 0, cmdIndex: 0, promptIndex: 0, reasoningIndex: 0, assurance_level: 'high', timestamp: '2026-02-10T09:10:00Z', sessionIndex: 0 },
	{ file_path: 'src/renderer/components/vibes/VibesPanel.tsx', line_start: 61, line_end: 120, action: 'create', envIndex: 0, cmdIndex: 0, promptIndex: 0, reasoningIndex: 0, assurance_level: 'high', timestamp: '2026-02-10T09:10:05Z', sessionIndex: 0 },
	{ file_path: 'src/renderer/components/vibes/VibesPanel.tsx', line_start: 121, line_end: 199, action: 'create', envIndex: 0, cmdIndex: 0, promptIndex: 0, reasoningIndex: 0, assurance_level: 'high', timestamp: '2026-02-10T09:10:10Z', sessionIndex: 0 },
	{ file_path: 'src/renderer/components/vibes/VibesDashboard.tsx', line_start: 1, line_end: 80, action: 'create', envIndex: 0, cmdIndex: 0, promptIndex: 0, reasoningIndex: 0, assurance_level: 'high', timestamp: '2026-02-10T09:15:00Z', sessionIndex: 0 },
	{ file_path: 'src/renderer/components/vibes/VibesDashboard.tsx', line_start: 81, line_end: 180, action: 'create', envIndex: 0, cmdIndex: 0, promptIndex: 0, reasoningIndex: 0, assurance_level: 'high', timestamp: '2026-02-10T09:15:05Z', sessionIndex: 0 },
	{ file_path: 'src/renderer/components/vibes/VibesAnnotationLog.tsx', line_start: 1, line_end: 120, action: 'create', envIndex: 0, cmdIndex: 0, promptIndex: 0, reasoningIndex: 0, assurance_level: 'high', timestamp: '2026-02-10T09:20:00Z', sessionIndex: 0 },
	// Session 1: Write buffering
	{ file_path: 'src/main/vibes/vibes-io.ts', line_start: 112, line_end: 192, action: 'create', envIndex: 0, cmdIndex: 0, promptIndex: 1, reasoningIndex: 1, assurance_level: 'high', timestamp: '2026-02-10T10:20:00Z', sessionIndex: 0 },
	{ file_path: 'src/main/vibes/vibes-io.ts', line_start: 402, line_end: 480, action: 'create', envIndex: 0, cmdIndex: 0, promptIndex: 1, reasoningIndex: 1, assurance_level: 'high', timestamp: '2026-02-10T10:20:05Z', sessionIndex: 0 },
	// Session 1: Hash fix
	{ file_path: 'src/main/vibes/vibes-hash.ts', line_start: 15, line_end: 45, action: 'modify', envIndex: 0, cmdIndex: 2, promptIndex: 2, reasoningIndex: -1, assurance_level: 'medium', timestamp: '2026-02-10T11:35:00Z', sessionIndex: 0 },
	// Session 2: Codex + o3 — instrumenter
	{ file_path: 'src/main/vibes/instrumenters/claude-code-instrumenter.ts', line_start: 1, line_end: 50, action: 'create', envIndex: 1, cmdIndex: 0, promptIndex: 3, reasoningIndex: 2, assurance_level: 'high', timestamp: '2026-02-10T14:10:00Z', sessionIndex: 1 },
	{ file_path: 'src/main/vibes/instrumenters/claude-code-instrumenter.ts', line_start: 51, line_end: 120, action: 'create', envIndex: 1, cmdIndex: 0, promptIndex: 3, reasoningIndex: 2, assurance_level: 'high', timestamp: '2026-02-10T14:10:05Z', sessionIndex: 1 },
	{ file_path: 'src/main/vibes/instrumenters/codex-instrumenter.ts', line_start: 1, line_end: 80, action: 'create', envIndex: 1, cmdIndex: 0, promptIndex: 3, reasoningIndex: 2, assurance_level: 'high', timestamp: '2026-02-10T14:15:00Z', sessionIndex: 1 },
	// Session 2: Coordinator + session review
	{ file_path: 'src/main/vibes/vibes-coordinator.ts', line_start: 1, line_end: 40, action: 'review', envIndex: 2, cmdIndex: 1, promptIndex: 4, reasoningIndex: -1, assurance_level: 'medium', timestamp: '2026-02-11T08:05:00Z', sessionIndex: 1 },
	{ file_path: 'src/main/vibes/vibes-session.ts', line_start: 1, line_end: 60, action: 'review', envIndex: 2, cmdIndex: 1, promptIndex: 4, reasoningIndex: -1, assurance_level: 'medium', timestamp: '2026-02-11T08:05:05Z', sessionIndex: 1 },
	// Low assurance annotations
	{ file_path: 'src/shared/vibes-types.ts', line_start: 1, line_end: 170, action: 'create', envIndex: 0, cmdIndex: 0, promptIndex: 0, reasoningIndex: -1, assurance_level: 'low', timestamp: '2026-02-10T09:08:00Z', sessionIndex: 0 },
	{ file_path: 'src/shared/vibes-settings.ts', line_start: 1, line_end: 50, action: 'create', envIndex: 0, cmdIndex: 0, promptIndex: 0, reasoningIndex: -1, assurance_level: 'low', timestamp: '2026-02-10T09:09:00Z', sessionIndex: 0 },
	// Additional annotations for coverage
	{ file_path: 'src/main/vibes/vibes-annotations.ts', line_start: 1, line_end: 100, action: 'create', envIndex: 0, cmdIndex: 0, promptIndex: 1, reasoningIndex: 1, assurance_level: 'high', timestamp: '2026-02-10T10:25:00Z', sessionIndex: 0 },
	{ file_path: 'src/renderer/components/vibes/VibesModelAttribution.tsx', line_start: 1, line_end: 80, action: 'create', envIndex: 0, cmdIndex: 0, promptIndex: 0, reasoningIndex: 0, assurance_level: 'high', timestamp: '2026-02-10T09:25:00Z', sessionIndex: 0 },
];

const sessions = [
	{ id: `sess-${crypto.randomUUID().slice(0, 8)}`, description: 'claude-code' },
	{ id: `sess-${crypto.randomUUID().slice(0, 8)}`, description: 'codex-cli' },
];

// ============================================================================
// Main
// ============================================================================

async function main() {
	console.log(`Seeding VIBES data in: ${PROJECT_PATH}`);

	// 1. Initialize
	const initResult = await initVibesDirectly(PROJECT_PATH, {
		projectName: 'Maestro',
		assuranceLevel: 'high',
		trackedExtensions: ['.ts', '.tsx', '.js', '.jsx'],
		excludePatterns: [
			'**/node_modules/**', '**/dist/**', '**/.git/**',
			'**/build/**', '**/coverage/**',
		],
	});
	if (!initResult.success) {
		console.error('Failed to initialize:', initResult.error);
		process.exit(1);
	}
	console.log('  ✓ Initialized .ai-audit/');

	// 2. Compute hashes and build manifest
	const envHashes: string[] = [];
	const promptHashes: string[] = [];
	const reasoningHashes: string[] = [];
	const cmdHashes: string[] = [];

	const manifest = await readVibesManifest(PROJECT_PATH);

	for (const env of environments) {
		const hash = computeVibesHash(env);
		envHashes.push(hash);
		manifest.entries[hash] = env;
	}
	for (const p of prompts) {
		const hash = computeVibesHash(p);
		promptHashes.push(hash);
		manifest.entries[hash] = p;
	}
	for (const r of reasoning) {
		const hash = computeVibesHash(r);
		reasoningHashes.push(hash);
		manifest.entries[hash] = r;
	}
	for (const c of commands) {
		const hash = computeVibesHash(c);
		cmdHashes.push(hash);
		manifest.entries[hash] = c;
	}

	await writeVibesManifest(PROJECT_PATH, manifest);
	console.log(`  ✓ Manifest: ${Object.keys(manifest.entries).length} entries`);

	// 3. Write session start records
	for (let i = 0; i < sessions.length; i++) {
		const startRecord: VibesSessionRecord = {
			type: 'session',
			event: 'start',
			session_id: sessions[i].id,
			timestamp: i === 0 ? '2026-02-10T09:00:00Z' : '2026-02-10T14:00:00Z',
			environment_hash: envHashes[i],
			assurance_level: 'high',
			description: sessions[i].description,
		};
		await appendAnnotationImmediate(PROJECT_PATH, startRecord);
	}
	console.log(`  ✓ ${sessions.length} session starts`);

	// 4. Write line annotations
	let annotationCount = 0;
	for (const def of annotationDefs) {
		const annotation: VibesLineAnnotation = {
			type: 'line',
			file_path: def.file_path,
			line_start: def.line_start,
			line_end: def.line_end,
			action: def.action,
			environment_hash: envHashes[def.envIndex],
			command_hash: cmdHashes[def.cmdIndex],
			prompt_hash: def.assurance_level !== 'low' ? promptHashes[def.promptIndex] : null,
			reasoning_hash: def.reasoningIndex >= 0 && def.assurance_level === 'high' ? reasoningHashes[def.reasoningIndex] : null,
			assurance_level: def.assurance_level,
			timestamp: def.timestamp,
			commit_hash: null,
			session_id: sessions[def.sessionIndex].id,
		};
		await appendAnnotationImmediate(PROJECT_PATH, annotation);
		annotationCount++;
	}
	console.log(`  ✓ ${annotationCount} line annotations`);

	// 5. Write session end records
	for (let i = 0; i < sessions.length; i++) {
		const endRecord: VibesSessionRecord = {
			type: 'session',
			event: 'end',
			session_id: sessions[i].id,
			timestamp: i === 0 ? '2026-02-10T12:00:00Z' : '2026-02-11T09:00:00Z',
			environment_hash: envHashes[i],
		};
		await appendAnnotationImmediate(PROJECT_PATH, endRecord);
	}
	console.log(`  ✓ ${sessions.length} session ends`);

	// 6. Flush everything
	await flushAll();

	// 7. Verify
	const annotations = await readAnnotations(PROJECT_PATH);
	const finalManifest = await readVibesManifest(PROJECT_PATH);
	console.log('\nVerification:');
	console.log(`  Annotations: ${annotations.length} records`);
	console.log(`  Manifest entries: ${Object.keys(finalManifest.entries).length}`);

	// Verify hash references
	let missingRefs = 0;
	for (const a of annotations) {
		if (a.type === 'line' || a.type === 'function') {
			if ('environment_hash' in a && a.environment_hash && !(a.environment_hash in finalManifest.entries)) {
				missingRefs++;
			}
		}
	}
	if (missingRefs > 0) {
		console.error(`  ⚠ ${missingRefs} annotations reference missing manifest entries!`);
	} else {
		console.log('  ✓ All annotation hash references resolve to manifest entries');
	}

	console.log('\nDone! VIBES data seeded successfully.');
}

main().catch((err) => {
	console.error('Seed failed:', err);
	process.exit(1);
});
