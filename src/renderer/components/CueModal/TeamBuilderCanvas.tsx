/**
 * TeamBuilderCanvas — Visual team builder using ReactFlow.
 *
 * Provides a drag-and-drop canvas for constructing team org structures
 * visually, using the same ReactFlow technology as the Cue pipeline editor.
 *
 * Stub: will be fully implemented in CUE-TEAMS-TAB-04 task 2.
 */

import type { Theme } from '../../types';
import type { TeamTemplate } from '../../../shared/group-chat-types';

export interface TeamBuilderCanvasProps {
	theme: Theme;
	editingTemplate?: TeamTemplate;
	onSave: (template: TeamTemplate) => Promise<void>;
	onCancel: () => void;
}

export function TeamBuilderCanvas({ theme, onCancel }: TeamBuilderCanvasProps) {
	return (
		<div
			style={{
				flex: 1,
				display: 'flex',
				flexDirection: 'column',
				alignItems: 'center',
				justifyContent: 'center',
				gap: 12,
				padding: 20,
			}}
		>
			<div className="text-sm" style={{ color: theme.colors.textDim }}>
				Team Builder canvas — coming soon
			</div>
			<button
				onClick={onCancel}
				className="px-3 py-1.5 rounded text-xs font-medium transition-colors"
				style={{
					backgroundColor: theme.colors.bgActivity,
					color: theme.colors.textDim,
				}}
			>
				Back to Library
			</button>
		</div>
	);
}
