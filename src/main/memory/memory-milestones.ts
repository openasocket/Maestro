/**
 * memory-milestones.ts — Milestone detection and notification for memory system (MEM-EVOLVE-08).
 *
 * Checks memory stats against predefined thresholds and emits IPC events
 * to the renderer so toast notifications can be shown. Each milestone
 * fires exactly once (tracked via memoryMilestonesShown in MemoryConfig).
 *
 * Milestone IDs:
 *   10  — 10 experiences extracted
 *   50  — 50 total memories
 *  100  — first experience promoted to rule
 *  200  — first cross-project evidence detected
 */

import { BrowserWindow } from 'electron';

/** Milestone definition */
interface Milestone {
	id: number;
	check: (ctx: MilestoneContext) => boolean;
	title: string;
	message: string;
	type: 'success' | 'info';
	duration: number;
}

interface MilestoneContext {
	experienceCount: number;
	totalMemories: number;
	trigger: MilestoneTrigger;
}

export type MilestoneTrigger = 'experience-count' | 'promotion' | 'cross-project-evidence';

const MILESTONES: Milestone[] = [
	{
		id: 10,
		check: (ctx) => ctx.experienceCount >= 10,
		title: 'Learning Milestone',
		message:
			'Your agents have learned 10 experiences from your coding sessions. Visit the Experiences tab to review and curate them.',
		type: 'success',
		duration: 15000,
	},
	{
		id: 50,
		check: (ctx) => ctx.totalMemories >= 50,
		title: 'Knowledge Base Growing',
		message:
			'Your memory system now contains 50 memories. Your agents are building a rich understanding of your codebase.',
		type: 'success',
		duration: 15000,
	},
	{
		id: 100,
		check: (ctx) => ctx.trigger === 'promotion',
		title: 'First Rule Created',
		message:
			'You promoted your first experience to a permanent rule. Rules are always injected and guide your agents consistently.',
		type: 'success',
		duration: 15000,
	},
	{
		id: 200,
		check: (ctx) => ctx.trigger === 'cross-project-evidence',
		title: 'Cross-Project Pattern Detected',
		message:
			'An experience was confirmed across multiple projects. Cross-project patterns indicate broadly useful knowledge.',
		type: 'info',
		duration: 15000,
	},
];

interface MemoryStoreForMilestones {
	getConfig(): Promise<import('../../shared/memory-types').MemoryConfig>;
	setConfig(
		config: Partial<import('../../shared/memory-types').MemoryConfig>
	): Promise<import('../../shared/memory-types').MemoryConfig>;
	getAnalytics(): Promise<import('../../shared/memory-types').MemoryStats>;
}

/**
 * Check if any milestones should fire and emit IPC events for them.
 * Safe to call from any context — failures are swallowed.
 */
export async function checkMemoryMilestones(
	store: MemoryStoreForMilestones,
	trigger: MilestoneTrigger
): Promise<void> {
	const config = await store.getConfig();
	const shown = config.memoryMilestonesShown ?? [];

	// Quick exit: all milestones already shown
	if (shown.length >= MILESTONES.length) return;

	// Filter to milestones not yet shown
	const pending = MILESTONES.filter((m) => !shown.includes(m.id));
	if (pending.length === 0) return;

	// Fetch stats only if we have pending milestones
	const stats = await store.getAnalytics();
	const ctx: MilestoneContext = {
		experienceCount: stats.byType?.experience ?? 0,
		totalMemories: stats.totalMemories,
		trigger,
	};

	const newlyTriggered = pending.filter((m) => m.check(ctx));
	if (newlyTriggered.length === 0) return;

	// Persist shown milestones
	const updatedShown = [...shown, ...newlyTriggered.map((m) => m.id)];
	await store.setConfig({ memoryMilestonesShown: updatedShown });

	// Emit to all windows
	for (const milestone of newlyTriggered) {
		for (const win of BrowserWindow.getAllWindows()) {
			if (!win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
				win.webContents.send('memory:milestone', {
					id: milestone.id,
					title: milestone.title,
					message: milestone.message,
					type: milestone.type,
					duration: milestone.duration,
				});
			}
		}
	}
}
