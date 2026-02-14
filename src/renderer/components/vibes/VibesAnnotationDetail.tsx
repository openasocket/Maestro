import React, { useState, useCallback } from 'react';
import {
	Terminal,
	MessageSquare,
	Brain,
	FileCode,
	Copy,
	CheckCircle2,
	Loader2,
} from 'lucide-react';
import type { Theme } from '../../types';
import type {
	VibesAnnotation,
	VibesManifest,
	VibesEnvironmentEntry,
	VibesCommandEntry,
	VibesPromptEntry,
	VibesReasoningEntry,
} from '../../../shared/vibes-types';

// ============================================================================
// Props
// ============================================================================

interface VibesAnnotationDetailProps {
	theme: Theme;
	annotation: Exclude<VibesAnnotation, { type: 'session' }>;
	manifest: VibesManifest | null;
	isLoadingManifest: boolean;
	onClose: () => void;
}

// ============================================================================
// Component
// ============================================================================

export const VibesAnnotationDetail: React.FC<VibesAnnotationDetailProps> = ({
	theme,
	annotation,
	manifest,
	isLoadingManifest,
	onClose,
}) => {
	const [copiedField, setCopiedField] = useState<string | null>(null);

	const handleCopy = useCallback(async (text: string, field: string) => {
		try {
			await navigator.clipboard.writeText(text);
			setCopiedField(field);
			setTimeout(() => setCopiedField(null), 1500);
		} catch {
			// Silent fail
		}
	}, []);

	const env = manifest?.entries[annotation.environment_hash] as VibesEnvironmentEntry | undefined;
	const cmd = annotation.command_hash
		? (manifest?.entries[annotation.command_hash] as VibesCommandEntry | undefined)
		: undefined;
	const prompt = annotation.prompt_hash
		? (manifest?.entries[annotation.prompt_hash] as VibesPromptEntry | undefined)
		: undefined;
	const reasoning = annotation.reasoning_hash
		? (manifest?.entries[annotation.reasoning_hash] as VibesReasoningEntry | undefined)
		: undefined;

	return (
		<div
			className="flex flex-col gap-3 px-4 py-3 text-xs"
			style={{
				backgroundColor: theme.colors.bgActivity,
				borderTop: `1px solid ${theme.colors.border}`,
			}}
			data-testid="annotation-detail-panel"
		>
			{/* Header */}
			<div className="flex items-center justify-between">
				<span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: theme.colors.textDim }}>
					Provenance Details
				</span>
				<button
					onClick={onClose}
					className="text-[10px] px-1.5 py-0.5 rounded transition-opacity hover:opacity-80"
					style={{ color: theme.colors.accent }}
				>
					Close
				</button>
			</div>

			{isLoadingManifest && (
				<div className="flex items-center gap-2 py-2">
					<Loader2 className="w-3.5 h-3.5 animate-spin" style={{ color: theme.colors.textDim }} />
					<span style={{ color: theme.colors.textDim }}>Loading manifest...</span>
				</div>
			)}

			{/* Resolved Environment */}
			<Section theme={theme} icon={<Terminal className="w-3 h-3" />} label="Environment">
				{env ? (
					<>
						<DataRow theme={theme} label="Tool" value={`${env.tool_name} ${env.tool_version}`} />
						<DataRow theme={theme} label="Model" value={`${env.model_name} ${env.model_version}`} />
						<HashRow theme={theme} label="Hash" value={annotation.environment_hash} onCopy={handleCopy} copiedField={copiedField} />
					</>
				) : (
					<HashRow theme={theme} label="Hash" value={annotation.environment_hash} onCopy={handleCopy} copiedField={copiedField} />
				)}
				{annotation.session_id && (
					<DataRow theme={theme} label="Session" value={annotation.session_id.slice(0, 12)} mono />
				)}
				{annotation.commit_hash && (
					<DataRow theme={theme} label="Commit" value={annotation.commit_hash.slice(0, 8)} mono />
				)}
				<DataRow theme={theme} label="Assurance" value={annotation.assurance_level} />
				<DataRow theme={theme} label="Timestamp" value={new Date(annotation.timestamp).toLocaleString()} />
			</Section>

			{/* Resolved Command */}
			{annotation.command_hash && (
				<Section theme={theme} icon={<Terminal className="w-3 h-3" />} label="Command" copyText={cmd?.command_text}>
					{cmd ? (
						<>
							<DataRow theme={theme} label="Type" value={cmd.command_type} />
							<DataRow theme={theme} label="Text" value={cmd.command_text} mono />
							{cmd.command_exit_code !== undefined && (
								<DataRow theme={theme} label="Exit Code" value={String(cmd.command_exit_code)} />
							)}
						</>
					) : (
						<HashRow theme={theme} label="Hash" value={annotation.command_hash} onCopy={handleCopy} copiedField={copiedField} />
					)}
				</Section>
			)}

			{/* Resolved Prompt */}
			{annotation.prompt_hash && (
				<Section theme={theme} icon={<MessageSquare className="w-3 h-3" />} label="Prompt" copyText={prompt?.prompt_text}>
					{prompt ? (
						<>
							{prompt.prompt_type && <DataRow theme={theme} label="Type" value={prompt.prompt_type} />}
							<DataRow theme={theme} label="Text" value={prompt.prompt_text} mono />
							{prompt.prompt_context_files && prompt.prompt_context_files.length > 0 && (
								<DataRow theme={theme} label="Context" value={prompt.prompt_context_files.join(', ')} />
							)}
						</>
					) : (
						<HashRow theme={theme} label="Hash" value={annotation.prompt_hash} onCopy={handleCopy} copiedField={copiedField} />
					)}
				</Section>
			)}

			{/* Resolved Reasoning */}
			{annotation.reasoning_hash && (
				<Section theme={theme} icon={<Brain className="w-3 h-3" />} label="Reasoning" copyText={reasoning?.reasoning_text}>
					{reasoning ? (
						<>
							{reasoning.compressed && (
								<DataRow theme={theme} label="Status" value="Compressed" />
							)}
							{reasoning.reasoning_text && (
								<DataRow theme={theme} label="Text" value={reasoning.reasoning_text} mono />
							)}
							{reasoning.reasoning_token_count !== undefined && (
								<DataRow theme={theme} label="Tokens" value={String(reasoning.reasoning_token_count)} />
							)}
						</>
					) : (
						<HashRow theme={theme} label="Hash" value={annotation.reasoning_hash} onCopy={handleCopy} copiedField={copiedField} />
					)}
				</Section>
			)}

			{/* Annotation type-specific */}
			{annotation.type === 'line' && (
				<Section theme={theme} icon={<FileCode className="w-3 h-3" />} label="Line Range">
					<DataRow theme={theme} label="File" value={annotation.file_path} mono />
					<DataRow theme={theme} label="Lines" value={`${annotation.line_start} – ${annotation.line_end}`} />
					<DataRow theme={theme} label="Action" value={annotation.action} />
				</Section>
			)}
			{annotation.type === 'function' && (
				<Section theme={theme} icon={<FileCode className="w-3 h-3" />} label="Function">
					<DataRow theme={theme} label="File" value={annotation.file_path} mono />
					<DataRow theme={theme} label="Name" value={annotation.function_name} mono />
					{annotation.function_signature && (
						<DataRow theme={theme} label="Signature" value={annotation.function_signature} mono />
					)}
					<DataRow theme={theme} label="Action" value={annotation.action} />
				</Section>
			)}
		</div>
	);
};

// ============================================================================
// Sub-components
// ============================================================================

const Section: React.FC<{
	theme: Theme;
	icon: React.ReactNode;
	label: string;
	copyText?: string;
	children: React.ReactNode;
}> = ({ theme, icon, label, copyText, children }) => {
	const [copied, setCopied] = useState(false);

	const handleCopySection = useCallback(async () => {
		if (!copyText) return;
		try {
			await navigator.clipboard.writeText(copyText);
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		} catch {
			// Silent fail
		}
	}, [copyText]);

	return (
		<div className="flex flex-col gap-1">
			<div className="flex items-center gap-1.5">
				<span style={{ color: theme.colors.textDim }}>{icon}</span>
				<span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: theme.colors.textDim }}>
					{label}
				</span>
				{copyText && (
					<button
						onClick={handleCopySection}
						className="shrink-0 p-0.5 rounded transition-opacity hover:opacity-80"
						style={{ color: copied ? theme.colors.success : theme.colors.textDim }}
					>
						{copied ? (
							<CheckCircle2 className="w-3 h-3" />
						) : (
							<Copy className="w-3 h-3" />
						)}
					</button>
				)}
			</div>
			<div className="flex flex-col gap-0.5 pl-5">{children}</div>
		</div>
	);
};

const TRUNCATE_LIMIT = 200;
const SCROLL_THRESHOLD = 50_000;

const DataRow: React.FC<{
	theme: Theme;
	label: string;
	value: string | undefined;
	mono?: boolean;
}> = ({ theme, label, value, mono }) => {
	const [expanded, setExpanded] = useState(false);

	if (!value) return null;

	const isLong = value.length > TRUNCATE_LIMIT;
	const sizeKB = (value.length / 1024).toFixed(1);
	const displayText = isLong && !expanded
		? value.slice(0, TRUNCATE_LIMIT) + '...'
		: value;
	const needsScroll = expanded && value.length > SCROLL_THRESHOLD;

	return (
		<div className="flex items-baseline gap-2 text-[11px]">
			<span className="shrink-0 w-20" style={{ color: theme.colors.textDim }}>{label}:</span>
			<div className="min-w-0 flex-1">
				{needsScroll ? (
					<div
						className={`whitespace-pre-wrap break-all ${mono ? 'font-mono' : ''}`}
						style={{
							color: theme.colors.textMain,
							maxHeight: 300,
							overflowY: 'auto',
						}}
					>
						{displayText}
					</div>
				) : (
					<span
						className={`whitespace-pre-wrap break-all ${mono ? 'font-mono' : ''}`}
						style={{ color: theme.colors.textMain }}
						title={isLong ? undefined : value}
					>
						{displayText}
					</span>
				)}
				{isLong && (
					<button
						onClick={() => setExpanded(!expanded)}
						className="text-[10px] ml-1 transition-opacity hover:opacity-80"
						style={{ color: theme.colors.accent }}
					>
						{expanded ? 'Show less' : `Show all (${sizeKB} KB)`}
					</button>
				)}
			</div>
		</div>
	);
};

const HashRow: React.FC<{
	theme: Theme;
	label: string;
	value: string;
	onCopy: (text: string, field: string) => void;
	copiedField: string | null;
}> = ({ theme, label, value, onCopy, copiedField }) => (
	<div className="flex items-center gap-2 text-[11px]">
		<span className="shrink-0 w-20" style={{ color: theme.colors.textDim }}>{label}:</span>
		<span className="font-mono truncate" style={{ color: theme.colors.textMain }} title={value}>
			{value.slice(0, 16)}...
		</span>
		<button
			onClick={() => onCopy(value, `${label}-${value}`)}
			className="shrink-0 p-0.5 rounded transition-opacity hover:opacity-80"
			style={{ color: copiedField === `${label}-${value}` ? theme.colors.success : theme.colors.textDim }}
		>
			{copiedField === `${label}-${value}` ? (
				<CheckCircle2 className="w-3 h-3" />
			) : (
				<Copy className="w-3 h-3" />
			)}
		</button>
	</div>
);
