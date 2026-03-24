/**
 * BuilderToolbar — Horizontal toolbar above the builder canvas.
 *
 * Three groups:
 * - Left: back arrow + editable template name
 * - Center: undo/redo, auto-layout, zoom controls
 * - Right: preview toggle + save button
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import {
	ArrowLeft,
	Undo2,
	Redo2,
	LayoutGrid,
	ZoomIn,
	ZoomOut,
	Maximize2,
	Eye,
	EyeOff,
	Save,
} from 'lucide-react';
import type { Theme } from '../../../types';

// ============================================================================
// Types
// ============================================================================

export interface BuilderToolbarProps {
	theme: Theme;
	templateName: string;
	onNameChange: (name: string) => void;
	onCancel: () => void;
	onSave: () => void;
	canSave: boolean;
	saving: boolean;
	canUndo: boolean;
	canRedo: boolean;
	onUndo: () => void;
	onRedo: () => void;
	onAutoLayout: () => void;
	zoom: number;
	onZoomIn: () => void;
	onZoomOut: () => void;
	onFitToView: () => void;
	showPreview: boolean;
	onTogglePreview: () => void;
	hasNodes: boolean;
}

// ============================================================================
// Constants
// ============================================================================

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2.0;
const ZOOM_STEP = 0.25;

// ============================================================================
// Component
// ============================================================================

export function BuilderToolbar({
	theme,
	templateName,
	onNameChange,
	onCancel,
	onSave,
	canSave,
	saving,
	canUndo,
	canRedo,
	onUndo,
	onRedo,
	onAutoLayout,
	zoom,
	onZoomIn,
	onZoomOut,
	onFitToView,
	showPreview,
	onTogglePreview,
	hasNodes,
}: BuilderToolbarProps): JSX.Element {
	const [editingName, setEditingName] = useState(false);
	const [nameDraft, setNameDraft] = useState(templateName);
	const nameInputRef = useRef<HTMLInputElement>(null);

	// Sync draft when templateName changes externally
	useEffect(() => {
		if (!editingName) setNameDraft(templateName);
	}, [templateName, editingName]);

	// Focus input when entering edit mode
	useEffect(() => {
		if (editingName) {
			nameInputRef.current?.focus();
			nameInputRef.current?.select();
		}
	}, [editingName]);

	const commitName = useCallback(() => {
		const trimmed = nameDraft.trim();
		if (trimmed) {
			onNameChange(trimmed);
		} else {
			setNameDraft(templateName);
		}
		setEditingName(false);
	}, [nameDraft, templateName, onNameChange]);

	const handleNameKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				commitName();
			} else if (e.key === 'Escape') {
				setNameDraft(templateName);
				setEditingName(false);
			}
		},
		[commitName, templateName]
	);

	const isMac = navigator.platform.toUpperCase().includes('MAC');
	const modKey = isMac ? '\u2318' : 'Ctrl+';

	const zoomPct = Math.round(zoom * 100);
	const canZoomIn = zoom + ZOOM_STEP <= MAX_ZOOM + 0.01;
	const canZoomOut = zoom - ZOOM_STEP >= MIN_ZOOM - 0.01;

	return (
		<div
			className="flex items-center justify-between px-3 border-b flex-shrink-0"
			style={{
				height: 48,
				borderColor: theme.colors.border,
				backgroundColor: theme.colors.bgSidebar,
			}}
		>
			{/* ── Left group: back + name ── */}
			<div className="flex items-center gap-2 min-w-0" style={{ maxWidth: '30%' }}>
				<ToolbarButton
					theme={theme}
					onClick={onCancel}
					tooltip="Back"
					icon={<ArrowLeft className="w-4 h-4" />}
				/>
				{editingName ? (
					<input
						ref={nameInputRef}
						type="text"
						value={nameDraft}
						onChange={(e) => setNameDraft(e.target.value)}
						onBlur={commitName}
						onKeyDown={handleNameKeyDown}
						className="px-2 py-0.5 text-sm font-semibold rounded border outline-none min-w-0"
						style={{
							backgroundColor: theme.colors.bgMain,
							borderColor: theme.colors.accent,
							color: theme.colors.textMain,
							maxWidth: 220,
						}}
					/>
				) : (
					<button
						onClick={() => setEditingName(true)}
						className="px-2 py-0.5 text-sm font-semibold rounded truncate cursor-text hover:opacity-80 transition-opacity"
						style={{ color: theme.colors.textMain, maxWidth: 220 }}
						title="Click to edit template name"
					>
						{templateName || 'Untitled'}
					</button>
				)}
			</div>

			{/* ── Center group: undo/redo, layout, zoom ── */}
			<div className="flex items-center gap-1">
				<ToolbarButton
					theme={theme}
					onClick={onUndo}
					disabled={!canUndo}
					tooltip={`Undo (${modKey}Z)`}
					icon={<Undo2 className="w-3.5 h-3.5" />}
				/>
				<ToolbarButton
					theme={theme}
					onClick={onRedo}
					disabled={!canRedo}
					tooltip={`Redo (${modKey}Shift+Z)`}
					icon={<Redo2 className="w-3.5 h-3.5" />}
				/>

				<ToolbarDivider theme={theme} />

				<ToolbarButton
					theme={theme}
					onClick={onAutoLayout}
					disabled={!hasNodes}
					tooltip="Auto-Layout"
					icon={<LayoutGrid className="w-3.5 h-3.5" />}
				/>

				<ToolbarDivider theme={theme} />

				<ToolbarButton
					theme={theme}
					onClick={onZoomOut}
					disabled={!canZoomOut}
					tooltip="Zoom Out (-)"
					icon={<ZoomOut className="w-3.5 h-3.5" />}
				/>
				<span
					className="text-[10px] font-mono w-8 text-center select-none"
					style={{ color: theme.colors.textDim }}
				>
					{zoomPct}%
				</span>
				<ToolbarButton
					theme={theme}
					onClick={onZoomIn}
					disabled={!canZoomIn}
					tooltip="Zoom In (+)"
					icon={<ZoomIn className="w-3.5 h-3.5" />}
				/>
				<ToolbarButton
					theme={theme}
					onClick={onFitToView}
					disabled={!hasNodes}
					tooltip="Fit to View"
					icon={<Maximize2 className="w-3.5 h-3.5" />}
				/>
			</div>

			{/* ── Right group: preview + save ── */}
			<div className="flex items-center gap-2">
				<ToolbarButton
					theme={theme}
					onClick={onTogglePreview}
					disabled={!hasNodes}
					tooltip={showPreview ? 'Back to Editor' : 'Preview Template'}
					icon={showPreview ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
					active={showPreview}
				/>
				<button
					onClick={onSave}
					disabled={!canSave || saving}
					className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-colors"
					title={`Save Template (${modKey}S)`}
					style={{
						backgroundColor: canSave && !saving ? theme.colors.accent : theme.colors.border,
						color: '#fff',
						opacity: canSave && !saving ? 1 : 0.5,
						cursor: canSave && !saving ? 'pointer' : 'default',
					}}
				>
					<Save className="w-3.5 h-3.5" />
					{saving ? 'Saving...' : 'Save'}
				</button>
			</div>
		</div>
	);
}

// ============================================================================
// Sub-components
// ============================================================================

interface ToolbarButtonProps {
	theme: Theme;
	onClick: () => void;
	icon: React.ReactNode;
	tooltip: string;
	disabled?: boolean;
	active?: boolean;
}

function ToolbarButton({ theme, onClick, icon, tooltip, disabled, active }: ToolbarButtonProps) {
	return (
		<button
			onClick={onClick}
			disabled={disabled}
			title={tooltip}
			className="flex items-center justify-center w-7 h-7 rounded transition-colors"
			style={{
				color: active
					? theme.colors.accent
					: disabled
						? theme.colors.textDim
						: theme.colors.textMain,
				backgroundColor: active ? `${theme.colors.accent}20` : 'transparent',
				opacity: disabled ? 0.4 : 1,
				cursor: disabled ? 'default' : 'pointer',
			}}
			onMouseEnter={(e) => {
				if (!disabled) {
					(e.currentTarget as HTMLButtonElement).style.backgroundColor = active
						? `${theme.colors.accent}30`
						: `${theme.colors.textMain}10`;
				}
			}}
			onMouseLeave={(e) => {
				(e.currentTarget as HTMLButtonElement).style.backgroundColor = active
					? `${theme.colors.accent}20`
					: 'transparent';
			}}
		>
			{icon}
		</button>
	);
}

function ToolbarDivider({ theme }: { theme: Theme }) {
	return (
		<div className="w-px mx-1 self-stretch my-2" style={{ backgroundColor: theme.colors.border }} />
	);
}
