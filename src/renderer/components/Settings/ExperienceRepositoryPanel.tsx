/**
 * ExperienceRepositoryPanel — Browse, import/export, and manage experience bundles.
 *
 * Local operations (import from file, export, manage imported bundles) are fully functional.
 * Repository browsing and submission show "Coming Soon" placeholders until the API is live.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
	Download,
	Upload,
	Package,
	Globe,
	Trash2,
	ShieldCheck,
	ShieldAlert,
	Loader2,
} from 'lucide-react';
import type { Theme } from '../../types';
import type { ImportedBundleRecord } from '../../../shared/experience-bundle-types';

interface ExperienceRepositoryPanelProps {
	theme: Theme;
}

export function ExperienceRepositoryPanel({
	theme,
}: ExperienceRepositoryPanelProps): React.ReactElement {
	const [importedBundles, setImportedBundles] = useState<ImportedBundleRecord[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [successMessage, setSuccessMessage] = useState<string | null>(null);

	const loadImportedBundles = useCallback(async () => {
		try {
			const result = await window.maestro.experienceRepository.getImported();
			if (result.success) {
				setImportedBundles(result.data);
			}
		} catch {
			// Non-critical
		}
	}, []);

	useEffect(() => {
		loadImportedBundles();
	}, [loadImportedBundles]);

	const handleImportFromFile = useCallback(async () => {
		setLoading(true);
		setError(null);
		setSuccessMessage(null);
		try {
			const result = await window.maestro.experienceRepository.importFromFile();
			if (result.success) {
				const r = result.data;
				setSuccessMessage(
					`Imported ${r.memoriesImported} memories` +
						(r.memoriesSkipped > 0 ? ` (${r.memoriesSkipped} skipped)` : '') +
						(r.rolesCreated > 0 ? `, ${r.rolesCreated} roles` : '') +
						(r.personasCreated > 0 ? `, ${r.personasCreated} personas` : '') +
						(r.skillAreasCreated > 0 ? `, ${r.skillAreasCreated} skill areas` : '') +
						(r.signatureVerified ? ' (signature verified)' : '')
				);
				await loadImportedBundles();
			} else {
				if (!result.error.includes('cancelled')) {
					setError(result.error);
				}
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Import failed');
		} finally {
			setLoading(false);
		}
	}, [loadImportedBundles]);

	const handleUninstall = useCallback(
		async (bundleId: string) => {
			setLoading(true);
			setError(null);
			try {
				const result = await window.maestro.experienceRepository.uninstall(bundleId);
				if (result.success) {
					setSuccessMessage(`Removed ${result.data.removed} memories`);
					await loadImportedBundles();
				} else {
					setError(result.error);
				}
			} catch (err) {
				setError(err instanceof Error ? err.message : 'Uninstall failed');
			} finally {
				setLoading(false);
			}
		},
		[loadImportedBundles]
	);

	return (
		<div className="space-y-4">
			{/* Header */}
			<div className="flex items-center gap-2">
				<Package className="w-4 h-4" style={{ color: theme.colors.accent }} />
				<div className="text-sm font-bold" style={{ color: theme.colors.textMain }}>
					Experience Repository
				</div>
			</div>

			{/* Status messages */}
			{error && (
				<div
					className="text-xs p-2 rounded border"
					style={{
						color: theme.colors.error ?? '#ef4444',
						borderColor: theme.colors.error ?? '#ef4444',
						backgroundColor: `${theme.colors.error ?? '#ef4444'}10`,
					}}
				>
					{error}
				</div>
			)}
			{successMessage && (
				<div
					className="text-xs p-2 rounded border"
					style={{
						color: theme.colors.accent,
						borderColor: theme.colors.accent,
						backgroundColor: `${theme.colors.accent}10`,
					}}
				>
					{successMessage}
				</div>
			)}

			{/* Import from file */}
			<div className="rounded-lg border p-3" style={{ borderColor: theme.colors.border }}>
				<div className="flex items-center justify-between">
					<div>
						<div className="text-xs font-semibold" style={{ color: theme.colors.textMain }}>
							Import from File
						</div>
						<div className="text-xs mt-0.5" style={{ color: theme.colors.textDim }}>
							Import a .maestro-bundle.json file with experiences and hierarchy definitions
						</div>
					</div>
					<button
						className="px-3 py-1.5 rounded text-xs font-medium border flex items-center gap-1.5"
						style={{
							borderColor: theme.colors.accent,
							color: theme.colors.accent,
							backgroundColor: `${theme.colors.accent}10`,
						}}
						onClick={handleImportFromFile}
						disabled={loading}
					>
						{loading ? (
							<Loader2 className="w-3 h-3 animate-spin" />
						) : (
							<Download className="w-3 h-3" />
						)}
						Import
					</button>
				</div>
			</div>

			{/* Imported bundles list */}
			{importedBundles.length > 0 && (
				<div
					className="rounded-lg border p-3 space-y-2"
					style={{ borderColor: theme.colors.border }}
				>
					<div className="text-xs font-semibold" style={{ color: theme.colors.textMain }}>
						Imported Bundles ({importedBundles.length})
					</div>
					{importedBundles.map((bundle) => (
						<div
							key={bundle.bundleId}
							className="flex items-center justify-between p-2 rounded border"
							style={{ borderColor: theme.colors.border }}
						>
							<div className="flex items-center gap-2 min-w-0">
								{bundle.signerTrusted ? (
									<ShieldCheck
										className="w-3.5 h-3.5 flex-shrink-0"
										style={{ color: theme.colors.accent }}
									/>
								) : bundle.signatureVerified ? (
									<ShieldAlert className="w-3.5 h-3.5 flex-shrink-0" style={{ color: '#f59e0b' }} />
								) : (
									<Package
										className="w-3.5 h-3.5 flex-shrink-0"
										style={{ color: theme.colors.textDim }}
									/>
								)}
								<div className="min-w-0">
									<div
										className="text-xs font-medium truncate"
										style={{ color: theme.colors.textMain }}
									>
										{bundle.name}
									</div>
									<div className="text-xs" style={{ color: theme.colors.textDim }}>
										{bundle.memoriesImported} memories
										{' \u00b7 '}
										{new Date(bundle.importedAt).toLocaleDateString()}
									</div>
								</div>
							</div>
							<button
								className="p-1 rounded hover:opacity-80"
								style={{ color: theme.colors.textDim }}
								onClick={() => handleUninstall(bundle.bundleId)}
								title="Uninstall bundle"
							>
								<Trash2 className="w-3.5 h-3.5" />
							</button>
						</div>
					))}
				</div>
			)}

			{/* Browse Repository — Coming Soon */}
			<div
				className="rounded-lg border p-4"
				style={{
					borderColor: theme.colors.border,
					borderStyle: 'dashed',
				}}
			>
				<div className="flex items-center gap-2 mb-2">
					<Globe className="w-4 h-4" style={{ color: theme.colors.textDim }} />
					<div className="text-xs font-semibold" style={{ color: theme.colors.textMain }}>
						Browse Repository
					</div>
					<span
						className="text-xs px-1.5 py-0.5 rounded"
						style={{
							backgroundColor: `${theme.colors.textDim}15`,
							color: theme.colors.textDim,
						}}
					>
						Coming Soon
					</span>
				</div>
				<div className="text-xs" style={{ color: theme.colors.textDim }}>
					Browse and download curated experience bundles from the Maestro community. Bundles are
					cryptographically signed for trust verification.
				</div>
			</div>

			{/* Submit Experiences — Coming Soon */}
			<div
				className="rounded-lg border p-4"
				style={{
					borderColor: theme.colors.border,
					borderStyle: 'dashed',
				}}
			>
				<div className="flex items-center gap-2 mb-2">
					<Upload className="w-4 h-4" style={{ color: theme.colors.textDim }} />
					<div className="text-xs font-semibold" style={{ color: theme.colors.textMain }}>
						Submit Experiences
					</div>
					<span
						className="text-xs px-1.5 py-0.5 rounded"
						style={{
							backgroundColor: `${theme.colors.textDim}15`,
							color: theme.colors.textDim,
						}}
					>
						Coming Soon
					</span>
				</div>
				<div className="text-xs" style={{ color: theme.colors.textDim }}>
					Contribute your curated experiences to the global repository for others to benefit from.
					Submissions are reviewed before inclusion.
				</div>
			</div>
		</div>
	);
}
