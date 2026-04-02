/**
 * MemoryConfigWidgets - Shared UI primitives for memory settings tabs.
 *
 * Extracted to avoid circular imports between MemorySettings and sub-tab components.
 */

import { useState } from 'react';
import { HelpCircle } from 'lucide-react';
import type { Theme } from '../../types';

/**
 * Inline info tooltip icon that shows a plain-English explanation on click.
 */
export function InfoTooltip({ text, theme }: { text: string; theme: Theme }) {
	const [open, setOpen] = useState(false);
	return (
		<div className="relative inline-block ml-1">
			<button
				onClick={(e) => {
					e.stopPropagation();
					setOpen((v) => !v);
				}}
				onBlur={() => setTimeout(() => setOpen(false), 150)}
				className="p-0.5 rounded hover:bg-white/10 transition-colors"
				title="More info"
				style={{ color: theme.colors.textDim }}
			>
				<HelpCircle className="w-3 h-3" />
			</button>
			{open && (
				<div
					className="absolute left-1/2 bottom-full mb-1 z-50 p-3 rounded shadow-lg text-xs whitespace-normal leading-relaxed"
					style={{
						backgroundColor: theme.colors.bgMain,
						border: `1px solid ${theme.colors.border}`,
						color: theme.colors.textMain,
						width: '280px',
						transform: 'translateX(-50%)',
					}}
				>
					{text}
				</div>
			)}
		</div>
	);
}

/**
 * Reusable slider row for numeric config values.
 */
export function ConfigSlider({
	label,
	description,
	value,
	min,
	max,
	step,
	onChange,
	theme,
	formatValue,
	tooltip,
}: {
	label: string;
	description: string;
	value: number;
	min: number;
	max: number;
	step: number;
	onChange: (value: number) => void;
	theme: Theme;
	formatValue?: (v: number) => string;
	tooltip?: string;
}) {
	return (
		<div className="flex items-center justify-between gap-4">
			<div className="flex-1 min-w-0">
				<div
					className="text-xs font-medium flex items-center"
					style={{ color: theme.colors.textMain }}
				>
					{label}
					{tooltip && <InfoTooltip text={tooltip} theme={theme} />}
				</div>
				<div className="text-xs mt-0.5" style={{ color: theme.colors.textDim }}>
					{description}
				</div>
			</div>
			<div className="flex items-center gap-2 shrink-0">
				<input
					type="range"
					min={min}
					max={max}
					step={step}
					value={value}
					onChange={(e) => onChange(Number(e.target.value))}
					className="w-24 h-1 rounded-full appearance-none cursor-pointer"
					style={{ accentColor: theme.colors.accent }}
				/>
				<span
					className="text-xs font-mono w-12 text-right"
					style={{ color: theme.colors.textMain }}
				>
					{formatValue ? formatValue(value) : value}
				</span>
			</div>
		</div>
	);
}

/**
 * Toggle row for boolean config values.
 */
/**
 * Select row for enum config values with option descriptions.
 */
export function ConfigSelect<T extends string>({
	label,
	description,
	value,
	options,
	onChange,
	theme,
	warning,
}: {
	label: string;
	description: string;
	value: T;
	options: Array<{ value: T; label: string; description: string }>;
	onChange: (value: T) => void;
	theme: Theme;
	warning?: string;
}) {
	return (
		<div className="space-y-2">
			<div className="flex items-center justify-between gap-4">
				<div className="flex-1 min-w-0">
					<div className="text-xs font-medium" style={{ color: theme.colors.textMain }}>
						{label}
					</div>
					<div className="text-xs mt-0.5" style={{ color: theme.colors.textDim }}>
						{description}
					</div>
				</div>
			</div>
			<div className="flex gap-1.5">
				{options.map((opt) => (
					<button
						key={opt.value}
						className="flex-1 rounded-md border px-2 py-1.5 text-left transition-colors"
						style={{
							borderColor: value === opt.value ? theme.colors.accent : theme.colors.border,
							backgroundColor: value === opt.value ? `${theme.colors.accent}12` : 'transparent',
							boxShadow: value === opt.value ? `0 0 0 1px ${theme.colors.accent}` : undefined,
						}}
						onClick={() => onChange(opt.value)}
					>
						<div
							className="text-[11px] font-medium"
							style={{ color: value === opt.value ? theme.colors.accent : theme.colors.textMain }}
						>
							{opt.label}
						</div>
						<div className="text-[10px] mt-0.5" style={{ color: theme.colors.textDim }}>
							{opt.description}
						</div>
					</button>
				))}
			</div>
			{warning && value === options[options.length - 1]?.value && (
				<div
					className="text-[10px] rounded px-2 py-1.5"
					style={{ backgroundColor: `${theme.colors.warning}15`, color: theme.colors.warning }}
				>
					{warning}
				</div>
			)}
		</div>
	);
}

/**
 * Toggle row for boolean config values.
 */
export function ConfigToggle({
	label,
	description,
	checked,
	onChange,
	theme,
	tooltip,
}: {
	label: string;
	description: string;
	checked: boolean;
	onChange: (value: boolean) => void;
	theme: Theme;
	tooltip?: string;
}) {
	return (
		<button
			className="w-full flex items-center justify-between py-2 text-left"
			onClick={() => onChange(!checked)}
		>
			<div className="flex-1 min-w-0">
				<div
					className="text-xs font-medium flex items-center"
					style={{ color: theme.colors.textMain }}
				>
					{label}
					{tooltip && <InfoTooltip text={tooltip} theme={theme} />}
				</div>
				<div className="text-xs mt-0.5" style={{ color: theme.colors.textDim }}>
					{description}
				</div>
			</div>
			<div
				className={`relative w-8 h-4 rounded-full transition-colors shrink-0 ml-3 ${checked ? '' : 'opacity-50'}`}
				style={{ backgroundColor: checked ? theme.colors.accent : theme.colors.border }}
			>
				<div
					className="absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform"
					style={{ transform: checked ? 'translateX(17px)' : 'translateX(2px)' }}
				/>
			</div>
		</button>
	);
}
