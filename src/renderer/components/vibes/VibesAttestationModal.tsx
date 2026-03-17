/**
 * VibesAttestationModal — Shows the 7-step attestation pipeline with live status.
 *
 * Per VERIFY spec: attestation is a point-in-time operation. This modal shows
 * progress through: audit validation → hash computation → tool cosignature →
 * user signature → timestamp → submit → verify, then displays the result.
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { ShieldCheck, CheckCircle2, AlertCircle, Loader2, Copy, MinusCircle } from 'lucide-react';
import type { Theme } from '../../types';
import { Modal, ModalFooter } from '../ui/Modal';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';

// ============================================================================
// Types
// ============================================================================

interface VibesAttestationModalProps {
	theme: Theme;
	projectPath: string;
	cosign?: boolean;
	onClose: () => void;
	onComplete?: () => void;
}

type StepStatus = 'waiting' | 'running' | 'pass' | 'fail' | 'skipped';

type PipelinePhase = 'running' | 'completed' | 'failed';

interface PipelineStep {
	key: string;
	label: string;
	status: StepStatus;
	detail: string;
}

interface AttestationResultData {
	attestationId?: string;
	trustTier?: string;
	signatures?: number;
	savedTo?: string;
}

// ============================================================================
// Constants
// ============================================================================

/** Trust tier display configuration. */
const TRUST_TIER_DISPLAY: Record<string, { label: string; color: string; icon: string }> = {
	'self-attested': { label: 'Self-Attested', color: '#eab308', icon: '🟡' },
	'tool-corroborated': { label: 'Tool-Corroborated', color: '#22c55e', icon: '🟢' },
	'tool-only': { label: 'Tool-Only', color: '#3b82f6', icon: '🔵' },
};

/** Step key → result steps key mapping. */
const STEP_RESULT_KEYS: Record<string, string> = {
	audit: 'audit',
	hash: 'hash',
	toolSign: 'toolSign',
	userSign: 'userSign',
	timestamp: 'timestamp',
	submit: 'submit',
};

/** Initial pipeline steps. */
function createInitialSteps(): PipelineStep[] {
	return [
		{ key: 'audit', label: 'Audit validation', status: 'waiting', detail: '' },
		{ key: 'hash', label: 'Compute file hashes', status: 'waiting', detail: '' },
		{ key: 'toolSign', label: 'Tool cosignature', status: 'waiting', detail: '' },
		{ key: 'userSign', label: 'User signature', status: 'waiting', detail: '' },
		{ key: 'timestamp', label: 'Timestamp', status: 'waiting', detail: '' },
		{ key: 'submit', label: 'Submit to registry', status: 'waiting', detail: '' },
		{ key: 'verify', label: 'Verify', status: 'waiting', detail: '' },
	];
}

// ============================================================================
// Step status icons
// ============================================================================

function StepIcon({ status, theme }: { status: StepStatus; theme: Theme }) {
	switch (status) {
		case 'pass':
			return <CheckCircle2 className="w-3.5 h-3.5 shrink-0" style={{ color: '#22c55e' }} />;
		case 'fail':
			return <AlertCircle className="w-3.5 h-3.5 shrink-0" style={{ color: '#ef4444' }} />;
		case 'running':
			return (
				<Loader2
					className="w-3.5 h-3.5 shrink-0 animate-spin"
					style={{ color: theme.colors.accent }}
				/>
			);
		case 'skipped':
			return (
				<MinusCircle className="w-3.5 h-3.5 shrink-0" style={{ color: theme.colors.textDim }} />
			);
		default:
			return (
				<div
					className="w-3.5 h-3.5 shrink-0 rounded-full border-2"
					style={{ borderColor: theme.colors.textDim }}
				/>
			);
	}
}

// ============================================================================
// Component
// ============================================================================

export const VibesAttestationModal: React.FC<VibesAttestationModalProps> = ({
	theme,
	projectPath,
	cosign = true,
	onClose,
	onComplete,
}) => {
	const [steps, setSteps] = useState<PipelineStep[]>(createInitialSteps);
	const [phase, setPhase] = useState<PipelinePhase>('running');
	const [result, setResult] = useState<AttestationResultData | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [copiedField, setCopiedField] = useState<string | null>(null);
	const hasStarted = useRef(false);

	// ========================================================================
	// Clipboard
	// ========================================================================

	const copyToClipboard = useCallback(async (text: string, field: string) => {
		try {
			await navigator.clipboard.writeText(text);
		} catch {
			const textarea = document.createElement('textarea');
			textarea.value = text;
			textarea.style.position = 'fixed';
			textarea.style.opacity = '0';
			document.body.appendChild(textarea);
			textarea.select();
			document.execCommand('copy');
			document.body.removeChild(textarea);
		}
		setCopiedField(field);
		setTimeout(() => setCopiedField(null), 2000);
	}, []);

	// ========================================================================
	// Run Attestation Pipeline
	// ========================================================================

	useEffect(() => {
		if (hasStarted.current) return;
		hasStarted.current = true;

		(async () => {
			// Animate first step as running
			setSteps((prev) =>
				prev.map((s, i) => (i === 0 ? { ...s, status: 'running', detail: 'validating...' } : s))
			);

			try {
				const ipcResult = await window.maestro.vibes.attestation.attest(projectPath, {
					cosign,
				});

				if (!ipcResult.success) {
					// Map returned step statuses to the UI
					const resultSteps = (ipcResult as any).data?.steps ?? {};
					setSteps((prev) =>
						prev.map((s) => {
							const resultKey = STEP_RESULT_KEYS[s.key];
							const stepResult = resultKey ? resultSteps[resultKey] : undefined;
							if (stepResult === 'pass') return { ...s, status: 'pass', detail: 'passed' };
							if (stepResult === 'fail') return { ...s, status: 'fail', detail: 'failed' };
							if (stepResult === 'skipped') return { ...s, status: 'skipped', detail: 'skipped' };
							// Steps not reached stay waiting
							return s;
						})
					);
					setError(ipcResult.error ?? 'Attestation failed');
					setPhase('failed');
					return;
				}

				const data = ipcResult.data as {
					attestationId?: string;
					trustTier?: string;
					envelope?: { signatures?: unknown[] };
					steps?: Record<string, string>;
				};

				// Map step results from the pipeline
				const resultSteps = data.steps ?? {};
				setSteps((prev) =>
					prev.map((s) => {
						const resultKey = STEP_RESULT_KEYS[s.key];
						const stepResult = resultKey ? resultSteps[resultKey] : undefined;

						if (stepResult === 'pass') {
							if (s.key === 'audit') return { ...s, status: 'pass', detail: 'passed' };
							if (s.key === 'hash') return { ...s, status: 'pass', detail: 'files hashed' };
							if (s.key === 'toolSign') return { ...s, status: 'pass', detail: 'received' };
							if (s.key === 'userSign') return { ...s, status: 'pass', detail: 'signed' };
							if (s.key === 'submit') return { ...s, status: 'pass', detail: 'submitted' };
							return { ...s, status: 'pass', detail: 'passed' };
						}
						if (stepResult === 'fail') {
							if (s.key === 'toolSign') return { ...s, status: 'fail', detail: 'unavailable' };
							return { ...s, status: 'fail', detail: 'failed' };
						}
						if (stepResult === 'skipped') {
							if (s.key === 'timestamp') return { ...s, status: 'skipped', detail: 'optional' };
							return { ...s, status: 'skipped', detail: 'skipped' };
						}
						// Verify step — mark as pass on successful attestation
						if (s.key === 'verify') {
							return { ...s, status: 'pass', detail: 'verified' };
						}
						return s;
					})
				);

				setResult({
					attestationId: data.attestationId,
					trustTier: data.trustTier,
					signatures: Array.isArray(data.envelope?.signatures)
						? data.envelope!.signatures.length
						: undefined,
					savedTo: '.ai-audit/attestation.json',
				});
				setPhase('completed');
			} catch (err) {
				setError(err instanceof Error ? err.message : 'Attestation failed unexpectedly');
				setPhase('failed');
			}
		})();
	}, [projectPath, cosign]);

	// ========================================================================
	// Close handler
	// ========================================================================

	const handleDone = useCallback(() => {
		if (phase === 'completed') {
			onComplete?.();
		}
		onClose();
	}, [phase, onComplete, onClose]);

	// ========================================================================
	// Render
	// ========================================================================

	const trustDisplay = result?.trustTier ? TRUST_TIER_DISPLAY[result.trustTier] : null;

	const title =
		phase === 'completed'
			? 'Attestation Created'
			: phase === 'failed'
				? 'Attestation Failed'
				: 'Creating Attestation';

	const headerIcon =
		phase === 'completed' ? (
			<ShieldCheck className="w-4 h-4" style={{ color: '#22c55e' }} />
		) : phase === 'failed' ? (
			<AlertCircle className="w-4 h-4" style={{ color: '#ef4444' }} />
		) : (
			<Loader2 className="w-4 h-4 animate-spin" style={{ color: theme.colors.accent }} />
		);

	return (
		<Modal
			theme={theme}
			title={title}
			priority={MODAL_PRIORITIES.ATTESTATION_PROGRESS}
			onClose={handleDone}
			width={480}
			footer={
				phase === 'running' ? (
					<ModalFooter
						theme={theme}
						onCancel={handleDone}
						cancelLabel="Cancel"
						onConfirm={() => {}}
						confirmLabel=""
						showCancel={true}
					/>
				) : (
					<ModalFooter
						theme={theme}
						onCancel={onClose}
						onConfirm={handleDone}
						cancelLabel="Close"
						confirmLabel="Done"
						showCancel={false}
					/>
				)
			}
			headerIcon={headerIcon}
			testId="vibes-attestation-modal"
		>
			<div className="flex flex-col gap-3">
				{/* Pipeline Steps */}
				<div
					className="flex flex-col gap-1.5 px-3 py-2.5 rounded"
					style={{
						backgroundColor: theme.colors.bgActivity,
						border: `1px solid ${theme.colors.border}`,
					}}
					data-testid="attestation-steps"
				>
					{steps.map((step, i) => (
						<div
							key={step.key}
							className="flex items-center gap-2 text-xs"
							data-testid={`step-${step.key}`}
						>
							<StepIcon status={step.status} theme={theme} />
							<span
								className="font-medium"
								style={{
									color: step.status === 'waiting' ? theme.colors.textDim : theme.colors.textMain,
								}}
							>
								Step {i + 1}: {step.label}
							</span>
							{step.detail && (
								<span
									className="ml-auto text-[10px]"
									style={{
										color:
											step.status === 'pass'
												? '#22c55e'
												: step.status === 'fail'
													? '#ef4444'
													: theme.colors.textDim,
									}}
								>
									{step.detail}
								</span>
							)}
						</div>
					))}
				</div>

				{/* Trust Tier (during progress or after completion) */}
				{trustDisplay && (
					<div className="flex items-center gap-2 text-xs" data-testid="trust-tier-display">
						<span style={{ color: theme.colors.textDim }}>Trust tier:</span>
						<span className="font-medium" style={{ color: trustDisplay.color }}>
							{trustDisplay.label} {trustDisplay.icon}
						</span>
					</div>
				)}

				{/* Error message */}
				{error && (
					<div
						className="flex items-center gap-2 px-3 py-2 rounded text-xs"
						style={{
							backgroundColor: 'rgba(239, 68, 68, 0.1)',
							border: '1px solid rgba(239, 68, 68, 0.3)',
						}}
						data-testid="attestation-error"
					>
						<AlertCircle className="w-3.5 h-3.5 shrink-0" style={{ color: '#ef4444' }} />
						<span style={{ color: '#ef4444' }}>{error}</span>
					</div>
				)}

				{/* Completion Details */}
				{phase === 'completed' && result && (
					<div
						className="flex flex-col gap-2 px-3 py-2.5 rounded text-xs"
						style={{
							backgroundColor: theme.colors.bgMain,
							border: `1px solid ${theme.colors.border}`,
						}}
						data-testid="attestation-result"
					>
						<div className="flex items-center gap-2">
							<CheckCircle2 className="w-3.5 h-3.5" style={{ color: '#22c55e' }} />
							<span className="font-medium" style={{ color: '#22c55e' }}>
								All steps completed
							</span>
						</div>

						{result.attestationId && (
							<div className="flex items-center gap-2">
								<span style={{ color: theme.colors.textDim }}>Attestation ID:</span>
								<span className="font-mono text-[10px]" style={{ color: theme.colors.textMain }}>
									{result.attestationId.slice(0, 16)}...
								</span>
							</div>
						)}

						{trustDisplay && (
							<div className="flex items-center gap-2">
								<span style={{ color: theme.colors.textDim }}>Trust Tier:</span>
								<span className="font-medium" style={{ color: trustDisplay.color }}>
									{trustDisplay.label} {trustDisplay.icon}
								</span>
							</div>
						)}

						{result.signatures != null && (
							<div className="flex items-center gap-2">
								<span style={{ color: theme.colors.textDim }}>Signatures:</span>
								<span style={{ color: theme.colors.textMain }}>
									{result.signatures}
									{result.signatures === 2 ? ' (user + tool provider)' : ' (user)'}
								</span>
							</div>
						)}

						{result.savedTo && (
							<div className="flex items-center gap-2">
								<span style={{ color: theme.colors.textDim }}>Saved to:</span>
								<span className="font-mono text-[10px]" style={{ color: theme.colors.textMain }}>
									{result.savedTo}
								</span>
							</div>
						)}

						{/* Action Buttons */}
						<div className="flex gap-2 mt-1">
							{result.attestationId && (
								<button
									type="button"
									onClick={() => copyToClipboard(result.attestationId!, 'attestationId')}
									className="flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium transition-colors hover:opacity-80"
									style={{
										backgroundColor: theme.colors.bgActivity,
										border: `1px solid ${theme.colors.border}`,
										color: copiedField === 'attestationId' ? '#22c55e' : theme.colors.textMain,
									}}
									data-testid="copy-attestation-id"
								>
									{copiedField === 'attestationId' ? (
										<CheckCircle2 className="w-3 h-3" />
									) : (
										<Copy className="w-3 h-3" />
									)}
									{copiedField === 'attestationId' ? 'Copied!' : 'Copy Attestation ID'}
								</button>
							)}
						</div>
					</div>
				)}
			</div>
		</Modal>
	);
};
