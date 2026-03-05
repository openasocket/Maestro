/**
 * memoryTourSteps.tsx
 *
 * Defines the 4-step inline walkthrough for the Memory system.
 * Scoped to the memory sub-tabs within the Settings modal.
 */

import type { TourStepConfig } from './useTour';

/**
 * Memory Quick Tour steps
 *
 * A lightweight 4-step walkthrough explaining each memory sub-tab:
 * 1) Personas - how agents think
 * 2) Experiences - auto-learned from sessions
 * 3) Memories - all knowledge entries
 * 4) Status - system health and injection activity
 */
export const memoryTourSteps: TourStepConfig[] = [
	{
		id: 'memory-personas',
		title: 'Personas',
		description:
			'Personas define how your agents think. Each persona represents an expert profile that shapes how memories are matched and injected into agent sessions.',
		selector: '[data-tour="memory-tab-personas"]',
		position: 'bottom',
		uiActions: [],
	},
	{
		id: 'memory-experiences',
		title: 'Experiences',
		description:
			'Experiences are automatically learned from your coding sessions. The system extracts lessons, patterns, and insights as you work. Promote valuable experiences to permanent rules.',
		selector: '[data-tour="memory-tab-experiences"]',
		position: 'bottom',
		uiActions: [],
	},
	{
		id: 'memory-memories',
		title: 'Memories',
		description:
			'All your knowledge entries live here. Browse, search, and manage the memories that get injected into agent sessions. Memories come from experiences, manual entries, and promotions.',
		selector: '[data-tour="memory-tab-memories"]',
		position: 'bottom',
		uiActions: [],
	},
	{
		id: 'memory-status',
		title: 'Status',
		description:
			'Monitor system health and injection activity. See which memories are being injected, track embedding status, and diagnose any issues with the memory pipeline.',
		selector: '[data-tour="memory-tab-status"]',
		position: 'bottom',
		uiActions: [],
	},
];
