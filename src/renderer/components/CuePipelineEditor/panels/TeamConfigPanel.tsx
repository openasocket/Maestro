/**
 * TeamConfigPanel — Configuration panel for team nodes in the pipeline.
 *
 * Displays template info (name, role count, topology) and provides
 * input/output prompt editing for controlling team workflow behavior.
 */

import { useState, useEffect, useCallback } from 'react';
import { useDebouncedCallback } from '../../../hooks/utils';

export interface TeamConfigPanelProps {
	templateId: string;
	templateName: string;
	roleCount: number;
	topologyPattern?: string;
	inputPrompt: string;
	outputPrompt: string;
	onUpdateInputPrompt: (prompt: string) => void;
	onUpdateOutputPrompt: (prompt: string) => void;
	onSwitchTemplate?: () => void;
	pipelineColor: string;
	/** Navigate to the Teams tab to edit this template */
	onEditTemplate?: (templateId: string) => void;
}

const textareaStyle: React.CSSProperties = {
	backgroundColor: '#2a2a3e',
	border: '1px solid #444',
	borderRadius: 4,
	color: '#e4e4e7',
	padding: '8px',
	fontSize: 12,
	outline: 'none',
	resize: 'vertical',
	width: '100%',
	fontFamily: 'inherit',
	lineHeight: 1.4,
};

export function TeamConfigPanel({
	templateId,
	templateName,
	roleCount,
	topologyPattern,
	inputPrompt,
	outputPrompt,
	onUpdateInputPrompt,
	onUpdateOutputPrompt,
	pipelineColor,
	onEditTemplate,
}: TeamConfigPanelProps) {
	const [localInputPrompt, setLocalInputPrompt] = useState(inputPrompt);
	const [localOutputPrompt, setLocalOutputPrompt] = useState(outputPrompt);

	useEffect(() => {
		setLocalInputPrompt(inputPrompt);
	}, [inputPrompt]);

	useEffect(() => {
		setLocalOutputPrompt(outputPrompt);
	}, [outputPrompt]);

	const { debouncedCallback: debouncedUpdateInput } = useDebouncedCallback((...args: unknown[]) => {
		onUpdateInputPrompt(args[0] as string);
	}, 300);

	const { debouncedCallback: debouncedUpdateOutput } = useDebouncedCallback(
		(...args: unknown[]) => {
			onUpdateOutputPrompt(args[0] as string);
		},
		300
	);

	const handleInputChange = useCallback(
		(e: React.ChangeEvent<HTMLTextAreaElement>) => {
			setLocalInputPrompt(e.target.value);
			debouncedUpdateInput(e.target.value);
		},
		[debouncedUpdateInput]
	);

	const handleOutputChange = useCallback(
		(e: React.ChangeEvent<HTMLTextAreaElement>) => {
			setLocalOutputPrompt(e.target.value);
			debouncedUpdateOutput(e.target.value);
		},
		[debouncedUpdateOutput]
	);

	return (
		<div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
			{/* Header: template info */}
			<div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
				<span style={{ color: '#e4e4e7', fontSize: 13, fontWeight: 700 }}>{templateName}</span>
				<span
					style={{
						fontSize: 10,
						color: '#e4e4e7',
						backgroundColor: pipelineColor + '30',
						border: `1px solid ${pipelineColor}60`,
						padding: '1px 6px',
						borderRadius: 4,
					}}
				>
					{roleCount} role{roleCount !== 1 ? 's' : ''}
				</span>
				{topologyPattern && (
					<span
						style={{
							fontSize: 10,
							color: '#9ca3af',
							backgroundColor: '#2a2a3e',
							padding: '1px 6px',
							borderRadius: 4,
						}}
					>
						{topologyPattern}
					</span>
				)}
				{onEditTemplate && (
					<button
						onClick={() => onEditTemplate(templateId)}
						style={{
							marginLeft: 'auto',
							fontSize: 11,
							fontWeight: 500,
							color: pipelineColor,
							backgroundColor: pipelineColor + '18',
							border: `1px solid ${pipelineColor}40`,
							borderRadius: 4,
							padding: '2px 10px',
							cursor: 'pointer',
							transition: 'filter 0.15s',
						}}
						onMouseEnter={(e) => {
							e.currentTarget.style.filter = 'brightness(1.2)';
						}}
						onMouseLeave={(e) => {
							e.currentTarget.style.filter = 'brightness(1)';
						}}
					>
						Edit Template →
					</button>
				)}
			</div>

			{/* Input/Output prompts side by side */}
			<div style={{ display: 'flex', gap: 12 }}>
				{/* Input Prompt */}
				<div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
					<label
						style={{
							fontSize: 11,
							fontWeight: 600,
							color: pipelineColor,
							marginBottom: 4,
							textTransform: 'uppercase',
							letterSpacing: '0.03em',
						}}
					>
						Input Prompt
					</label>
					<textarea
						value={localInputPrompt}
						onChange={handleInputChange}
						rows={4}
						placeholder="Prompt sent to initiate the team workflow..."
						style={textareaStyle}
					/>
					<div style={{ color: '#6b7280', fontSize: 10, textAlign: 'right', marginTop: 2 }}>
						{localInputPrompt.length} chars
					</div>
				</div>

				{/* Output Prompt */}
				<div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
					<label
						style={{
							fontSize: 11,
							fontWeight: 600,
							color: pipelineColor,
							marginBottom: 4,
							textTransform: 'uppercase',
							letterSpacing: '0.03em',
						}}
					>
						Output Prompt
					</label>
					<textarea
						value={localOutputPrompt}
						onChange={handleOutputChange}
						rows={3}
						placeholder="Prompt to extract results after team completes..."
						style={textareaStyle}
					/>
					<div style={{ color: '#6b7280', fontSize: 10, textAlign: 'right', marginTop: 2 }}>
						{localOutputPrompt.length} chars
					</div>
				</div>
			</div>

			{/* Template Info badges */}
			<div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
				<span style={{ fontSize: 10, color: '#6b7280' }}>Template:</span>
				<span
					style={{
						fontSize: 10,
						color: '#9ca3af',
						backgroundColor: '#2a2a3e',
						padding: '2px 8px',
						borderRadius: 4,
					}}
				>
					{roleCount} role{roleCount !== 1 ? 's' : ''}
				</span>
				{topologyPattern && (
					<span
						style={{
							fontSize: 10,
							color: '#9ca3af',
							backgroundColor: '#2a2a3e',
							padding: '2px 8px',
							borderRadius: 4,
						}}
					>
						{topologyPattern}
					</span>
				)}
			</div>
		</div>
	);
}
