import React, { useState, useCallback } from 'react';
import { Copy, CheckCircle2, RefreshCw, X } from 'lucide-react';
import type { Theme } from '../../types';

// ============================================================================
// Types
// ============================================================================

interface VibesInstallGuideProps {
	theme: Theme;
	onCheckAgain: () => void;
	onClose: () => void;
	onOpenSettings: () => void;
}

// ============================================================================
// Install options
// ============================================================================

const INSTALL_OPTIONS = [
	{
		label: 'Install from source (Rust)',
		command: 'git clone https://github.com/openasocket/VibeCheck.git && cd VibeCheck && cargo install --path .',
		description: 'Preferred method — requires Rust toolchain (1.91.0+)',
	},
	{
		label: 'Build manually',
		command: 'git clone https://github.com/openasocket/VibeCheck.git && cd VibeCheck && cargo build --release',
		description: 'Binary at target/release/vibecheck — copy to a directory in PATH (e.g. /usr/local/bin/)',
	},
];

// ============================================================================
// Component
// ============================================================================

/**
 * Installation guide for the vibecheck CLI binary.
 * Shows installation methods with copy-to-clipboard buttons.
 */
export const VibesInstallGuide: React.FC<VibesInstallGuideProps> = ({
	theme,
	onCheckAgain,
	onClose,
	onOpenSettings,
}) => {
	const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

	const handleCopy = useCallback(async (command: string, index: number) => {
		try {
			await navigator.clipboard.writeText(command);
		} catch {
			const textarea = document.createElement('textarea');
			textarea.value = command;
			textarea.style.position = 'fixed';
			textarea.style.opacity = '0';
			document.body.appendChild(textarea);
			textarea.select();
			document.execCommand('copy');
			document.body.removeChild(textarea);
		}
		setCopiedIndex(index);
		setTimeout(() => setCopiedIndex(null), 2000);
	}, []);

	return (
		<div
			className="flex flex-col gap-3 mx-3 my-2 px-3 py-3 rounded"
			style={{
				backgroundColor: theme.colors.bgActivity,
				border: `1px solid ${theme.colors.border}`,
			}}
			data-testid="vibes-install-guide"
		>
			{/* Header */}
			<div className="flex items-center justify-between">
				<span
					className="text-xs font-semibold"
					style={{ color: theme.colors.textMain }}
				>
					Install vibecheck
				</span>
				<button
					onClick={onClose}
					className="p-0.5 rounded hover:opacity-80 transition-opacity"
					style={{ color: theme.colors.textDim }}
					data-testid="install-guide-close"
				>
					<X className="w-3.5 h-3.5" />
				</button>
			</div>

			{/* Install options */}
			{INSTALL_OPTIONS.map((option, idx) => (
				<div key={option.label} className="flex flex-col gap-1">
					<span
						className="text-[11px] font-medium"
						style={{ color: theme.colors.textMain }}
					>
						{option.label}
					</span>
					<span
						className="text-[10px]"
						style={{ color: theme.colors.textDim }}
					>
						{option.description}
					</span>
					{option.command && (
						<div className="flex items-center gap-2 mt-0.5">
							<code
								className="flex-1 px-2 py-1 rounded text-[11px] font-mono"
								style={{
									backgroundColor: theme.colors.bgMain,
									color: theme.colors.accent,
								}}
							>
								{option.command}
							</code>
							<button
								onClick={() => handleCopy(option.command!, idx)}
								className="shrink-0 p-1 rounded hover:opacity-80 transition-opacity"
								style={{
									color: copiedIndex === idx ? theme.colors.success : theme.colors.textDim,
								}}
								data-testid={`copy-btn-${idx}`}
							>
								{copiedIndex === idx ? (
									<CheckCircle2 className="w-3.5 h-3.5" />
								) : (
									<Copy className="w-3.5 h-3.5" />
								)}
							</button>
						</div>
					)}
				</div>
			))}

			{/* Custom path hint */}
			<div className="flex flex-col gap-1 pt-1 border-t" style={{ borderColor: theme.colors.border }}>
				<span
					className="text-[10px]"
					style={{ color: theme.colors.textDim }}
				>
					Already installed? Set the path in Settings &gt; VIBES
				</span>
				<button
					onClick={onOpenSettings}
					className="self-start text-[11px] font-medium hover:underline"
					style={{ color: theme.colors.accent }}
					data-testid="install-guide-open-settings"
				>
					Open Settings
				</button>
			</div>

			{/* Check Again */}
			<button
				onClick={onCheckAgain}
				className="flex items-center justify-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-opacity hover:opacity-80"
				style={{
					backgroundColor: theme.colors.accent,
					color: theme.colors.accentForeground,
				}}
				data-testid="install-guide-check-again"
			>
				<RefreshCw className="w-3 h-3" />
				Check Again
			</button>
		</div>
	);
};
