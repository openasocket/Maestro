/**
 * CueTeamsTab — Team template management within the CueModal.
 *
 * Provides CRUD for team templates inline in the Cue workflow.
 * Full implementation pending — this is a structural placeholder.
 */

import type { Theme } from '../../types';

export interface CueTeamsTabProps {
	theme: Theme;
}

export function CueTeamsTab({ theme }: CueTeamsTabProps) {
	return (
		<div
			className="flex-1 flex items-center justify-center"
			style={{ color: theme.colors.textDim }}
		>
			<p className="text-sm">Teams tab — implementation pending</p>
		</div>
	);
}
