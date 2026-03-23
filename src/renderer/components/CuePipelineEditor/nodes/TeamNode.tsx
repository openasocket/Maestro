import { memo } from 'react';
import { Handle, Position, type NodeProps } from 'reactflow';
import { Users, MessageSquare, GripVertical, Settings } from 'lucide-react';
import { TEAM_NODE_COLOR } from '../../../../shared/cue-pipeline-types';

export interface TeamNodeDataProps {
	compositeId: string;
	templateId: string;
	templateName: string;
	roleCount: number;
	topologyPattern?: string;
	hasPrompt: boolean;
	hasOutgoingEdge: boolean;
	pipelineColor: string;
	pipelineCount: number;
	pipelineColors: string[];
	onConfigure?: (compositeId: string) => void;
}

export const TeamNode = memo(function TeamNode({ data, selected }: NodeProps<TeamNodeDataProps>) {
	const accentColor = data.pipelineColor || TEAM_NODE_COLOR;

	const subtitle = data.topologyPattern
		? `${data.roleCount} role${data.roleCount !== 1 ? 's' : ''} · ${data.topologyPattern}`
		: `${data.roleCount} role${data.roleCount !== 1 ? 's' : ''}`;

	return (
		<div
			style={{
				minWidth: 200,
				maxWidth: 360,
				height: 80,
				borderRadius: 8,
				backgroundColor: '#1e1e2e',
				border: `2px solid ${selected ? accentColor : '#333'}`,
				boxShadow: selected ? `0 4px 16px ${accentColor}30` : '0 2px 8px rgba(0,0,0,0.3)',
				animation: selected ? 'pipeline-node-pulse 2s ease-in-out infinite' : undefined,
				['--node-color-40' as string]: `${accentColor}40`,
				['--node-color-60' as string]: `${accentColor}60`,
				['--node-color-30' as string]: `${accentColor}30`,
				display: 'flex',
				flexDirection: 'row',
				overflow: 'visible',
				cursor: 'default',
				transition: 'border-color 0.15s, box-shadow 0.15s',
				position: 'relative',
			}}
		>
			{/* Drag handle */}
			<div
				className="drag-handle"
				style={{
					width: 32,
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'center',
					cursor: 'grab',
					color: '#555',
					flexShrink: 0,
					backgroundColor: accentColor,
					borderRadius: '6px 0 0 6px',
					transition: 'color 0.15s, filter 0.15s',
				}}
				onMouseEnter={(e) => {
					e.currentTarget.style.color = '#fff';
					e.currentTarget.style.filter = 'brightness(1.3)';
				}}
				onMouseLeave={(e) => {
					e.currentTarget.style.color = '#555';
					e.currentTarget.style.filter = 'brightness(1)';
				}}
				title="Drag to move"
			>
				<GripVertical size={16} />
			</div>

			{/* Content */}
			<div
				style={{
					flex: 1,
					display: 'flex',
					flexDirection: 'column',
					justifyContent: 'center',
					padding: '8px 10px',
					overflow: 'hidden',
				}}
			>
				<div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
					<Users size={14} style={{ color: accentColor, flexShrink: 0 }} />
					<span
						style={{
							color: '#e4e4e7',
							fontSize: 13,
							fontWeight: 600,
							whiteSpace: 'nowrap',
							flex: 1,
							overflow: 'hidden',
							textOverflow: 'ellipsis',
						}}
						title={data.templateName}
					>
						{data.templateName}
					</span>
					{data.hasPrompt && (
						<MessageSquare size={12} style={{ color: '#9ca3af', flexShrink: 0 }} />
					)}
				</div>
				<span
					style={{
						color: '#6b7280',
						fontSize: 11,
						marginTop: 2,
					}}
				>
					{subtitle}
				</span>

				{/* Multi-pipeline color strip */}
				{data.pipelineColors.length > 1 && (
					<div
						style={{
							display: 'flex',
							gap: 3,
							marginTop: 6,
						}}
					>
						{data.pipelineColors.map((c, i) => (
							<div
								key={i}
								style={{
									width: 8,
									height: 8,
									borderRadius: '50%',
									backgroundColor: c,
								}}
							/>
						))}
					</div>
				)}
			</div>

			{/* Gear icon */}
			<div
				onClick={(e) => {
					e.stopPropagation();
					data.onConfigure?.(data.compositeId);
				}}
				style={{
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'center',
					cursor: 'pointer',
					color: selected ? accentColor : '#555',
					flexShrink: 0,
					padding: '0 6px',
					marginRight: 14,
					borderRadius: 4,
					transition: 'color 0.15s',
				}}
				onMouseEnter={(e) => (e.currentTarget.style.color = accentColor)}
				onMouseLeave={(e) => (e.currentTarget.style.color = selected ? accentColor : '#555')}
				title="Configure"
			>
				<Settings size={14} />
			</div>

			{/* Role count badge */}
			{data.roleCount > 0 && (
				<div
					style={{
						position: 'absolute',
						top: -6,
						right: -6,
						width: 20,
						height: 20,
						borderRadius: '50%',
						backgroundColor: accentColor,
						color: '#fff',
						fontSize: 10,
						fontWeight: 700,
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'center',
						border: '2px solid #1e1e2e',
					}}
				>
					{data.roleCount}
				</div>
			)}

			<Handle
				type="target"
				position={Position.Left}
				style={{
					backgroundColor: accentColor,
					border: '3px solid #1e1e2e',
					boxShadow: `0 0 0 2px ${accentColor}`,
					width: 16,
					height: 16,
					zIndex: 10,
					left: -8,
				}}
			/>
			<Handle
				type="source"
				position={Position.Right}
				style={{
					backgroundColor: accentColor,
					border: '3px solid #1e1e2e',
					boxShadow: `0 0 0 2px ${accentColor}`,
					width: 16,
					height: 16,
					zIndex: 10,
					right: -8,
				}}
			/>
		</div>
	);
});
