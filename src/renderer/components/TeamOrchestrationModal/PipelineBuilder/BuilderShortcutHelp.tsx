/**
 * BuilderShortcutHelp — Floating panel listing all Pipeline Builder keyboard shortcuts.
 *
 * Shown when user presses '?'. Dismissable with Escape or clicking outside.
 */

import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import type { Theme } from '../../../types';

interface BuilderShortcutHelpProps {
	theme: Theme;
	onClose: () => void;
}

const isMac = typeof navigator !== 'undefined' && navigator.platform.toUpperCase().includes('MAC');
const MOD = isMac ? '\u2318' : 'Ctrl';

const SHORTCUT_GROUPS = [
	{
		title: 'Canvas',
		shortcuts: [
			{ keys: ['\u2190 \u2191 \u2192 \u2193'], description: 'Pan canvas' },
			{ keys: ['+ / ='], description: 'Zoom in' },
			{ keys: ['-'], description: 'Zoom out' },
			{ keys: ['0'], description: 'Reset zoom 100%' },
			{ keys: [MOD, '0'], description: 'Fit to view' },
		],
	},
	{
		title: 'Nodes & Edges',
		shortcuts: [
			{ keys: ['Del / \u232b'], description: 'Delete selected' },
			{ keys: ['Tab'], description: 'Next node' },
			{ keys: ['Shift', 'Tab'], description: 'Previous node' },
			{ keys: ['Esc'], description: 'Deselect / Back' },
			{ keys: [MOD, 'D'], description: 'Duplicate node' },
			{ keys: [MOD, 'A'], description: 'Highlight all nodes' },
		],
	},
	{
		title: 'Builder',
		shortcuts: [
			{ keys: [MOD, 'S'], description: 'Save template' },
			{ keys: [MOD, 'Z'], description: 'Undo' },
			{ keys: [MOD, 'Shift', 'Z'], description: 'Redo' },
			{ keys: [MOD, 'L'], description: 'Auto-layout' },
			{ keys: ['?'], description: 'Toggle this help' },
		],
	},
];

export function BuilderShortcutHelp({ theme, onClose }: BuilderShortcutHelpProps): JSX.Element {
	const panelRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const handleClick = (e: MouseEvent) => {
			if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
				onClose();
			}
		};
		const timer = setTimeout(() => {
			document.addEventListener('mousedown', handleClick);
		}, 0);
		return () => {
			clearTimeout(timer);
			document.removeEventListener('mousedown', handleClick);
		};
	}, [onClose]);

	return (
		<div
			ref={panelRef}
			role="dialog"
			aria-label="Keyboard shortcuts"
			aria-modal="false"
			className="absolute bottom-4 right-4 z-50 rounded-lg border shadow-xl overflow-hidden"
			style={{
				backgroundColor: theme.colors.bgSidebar,
				borderColor: theme.colors.border,
				width: 260,
			}}
		>
			<div
				className="flex items-center justify-between px-3 py-2 border-b"
				style={{ borderColor: theme.colors.border }}
			>
				<span className="text-xs font-semibold" style={{ color: theme.colors.textMain }}>
					Keyboard Shortcuts
				</span>
				<button
					onClick={onClose}
					className="flex items-center justify-center w-5 h-5 rounded hover:opacity-70"
					style={{ color: theme.colors.textDim }}
					aria-label="Close shortcuts help"
				>
					<X className="w-3 h-3" />
				</button>
			</div>
			<div className="p-2 overflow-y-auto" style={{ maxHeight: 350 }}>
				{SHORTCUT_GROUPS.map((group) => (
					<div key={group.title} className="mb-3 last:mb-0">
						<p
							className="text-[10px] font-semibold uppercase tracking-wider px-1 mb-1"
							style={{ color: theme.colors.textDim }}
						>
							{group.title}
						</p>
						{group.shortcuts.map((s) => (
							<div key={s.description} className="flex items-center justify-between px-1 py-0.5">
								<span className="text-xs" style={{ color: theme.colors.textMain }}>
									{s.description}
								</span>
								<span className="flex items-center gap-0.5">
									{s.keys.map((k, i) => (
										<kbd
											key={i}
											className="inline-block px-1.5 py-0.5 text-[10px] rounded border font-mono"
											style={{
												backgroundColor: theme.colors.bgMain,
												borderColor: theme.colors.border,
												color: theme.colors.textDim,
											}}
										>
											{k}
										</kbd>
									))}
								</span>
							</div>
						))}
					</div>
				))}
			</div>
		</div>
	);
}
