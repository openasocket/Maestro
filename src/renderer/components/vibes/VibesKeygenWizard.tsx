/**
 * VibesKeygenWizard — 3-step modal for VIBES signing key generation.
 *
 * Per VERIFY spec section 5:
 *   Step 1: What and Why (explanation of attestation)
 *   Step 2: Key Generated + Security Rules
 *   Step 3: Backup Reminder
 */

import React, { useState, useCallback, useRef } from 'react';
import { Key, Shield, Copy, CheckCircle2, AlertTriangle, Loader2 } from 'lucide-react';
import type { Theme } from '../../types';
import { Modal, ModalFooter } from '../ui/Modal';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';

// ============================================================================
// Types
// ============================================================================

interface VibesKeygenWizardProps {
	theme: Theme;
	onClose: () => void;
	onComplete?: (keyId: string) => void;
}

interface KeygenResult {
	publicKey: string;
	keyId: string;
}

type WizardStep = 1 | 2 | 3;

// ============================================================================
// Constants
// ============================================================================

const KEY_DIR = '~/.vibescheck/keys';
const PRIVATE_KEY_PATH = `${KEY_DIR}/vibescheck.key`;
const PUBLIC_KEY_PATH = `${KEY_DIR}/vibescheck.pub`;

// ============================================================================
// Component
// ============================================================================

export const VibesKeygenWizard: React.FC<VibesKeygenWizardProps> = ({
	theme,
	onClose,
	onComplete,
}) => {
	const [step, setStep] = useState<WizardStep>(1);
	const [isGenerating, setIsGenerating] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [keyResult, setKeyResult] = useState<KeygenResult | null>(null);
	const [copiedField, setCopiedField] = useState<string | null>(null);
	const [backupAcknowledged, setBackupAcknowledged] = useState(false);
	const generateBtnRef = useRef<HTMLButtonElement>(null);

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
	// Key Generation
	// ========================================================================

	const handleGenerate = useCallback(async () => {
		setIsGenerating(true);
		setError(null);
		try {
			const result = await window.maestro.vibes.attestation.keygen();
			if (result.success && result.data) {
				const data = result.data as { publicKey: string; keyId: string };
				setKeyResult({ publicKey: data.publicKey, keyId: data.keyId });
				setStep(2);
			} else {
				setError(result.error ?? 'Key generation failed');
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Key generation failed');
		} finally {
			setIsGenerating(false);
		}
	}, []);

	// ========================================================================
	// Export Public Key for Copy
	// ========================================================================

	const handleCopyPublicKey = useCallback(async () => {
		try {
			const result = await window.maestro.vibes.attestation.exportPublicKey('pem');
			if (result.success && result.data) {
				await copyToClipboard(result.data as string, 'publicKey');
			}
		} catch {
			// Fall back to stored key
			if (keyResult?.publicKey) {
				await copyToClipboard(keyResult.publicKey, 'publicKey');
			}
		}
	}, [copyToClipboard, keyResult]);

	// ========================================================================
	// Done
	// ========================================================================

	const handleDone = useCallback(() => {
		if (keyResult) {
			onComplete?.(keyResult.keyId);
		}
		onClose();
	}, [keyResult, onComplete, onClose]);

	// ========================================================================
	// Step Renderers
	// ========================================================================

	const renderStep1 = () => (
		<div className="flex flex-col gap-4" data-testid="keygen-step-1">
			<div className="flex items-center gap-2">
				<Key className="w-5 h-5" style={{ color: theme.colors.accent }} />
				<span className="text-sm font-semibold" style={{ color: theme.colors.textMain }}>
					Generate Your VIBES Signing Key
				</span>
			</div>

			<p className="text-xs leading-relaxed" style={{ color: theme.colors.textDim }}>
				VIBES attestation wraps your audit data in cryptographic envelopes so that any modification
				after signing is detectable.
			</p>

			<div className="flex flex-col gap-2">
				<span className="text-xs font-medium" style={{ color: theme.colors.textMain }}>
					This key enables:
				</span>
				{[
					{ label: 'Integrity', desc: "prove audit files haven't been modified since signing" },
					{ label: 'Authenticity', desc: 'your identity is bound to the attestation' },
					{
						label: 'Trust',
						desc: 'tool-corroborated attestations prove Maestro generated the data',
					},
				].map((item) => (
					<div key={item.label} className="flex items-start gap-2 text-xs">
						<CheckCircle2
							className="w-3.5 h-3.5 shrink-0 mt-0.5"
							style={{ color: theme.colors.success }}
						/>
						<span style={{ color: theme.colors.textMain }}>
							<strong>{item.label}</strong> — {item.desc}
						</span>
					</div>
				))}
			</div>

			<div
				className="px-3 py-2 rounded text-xs"
				style={{
					backgroundColor: `${theme.colors.accent}15`,
					border: `1px solid ${theme.colors.accent}30`,
					color: theme.colors.textDim,
				}}
			>
				Your <strong style={{ color: theme.colors.textMain }}>PRIVATE</strong> key never leaves this
				machine.
				<br />
				Your <strong style={{ color: theme.colors.textMain }}>PUBLIC</strong> key is registered with
				the VIBES attestation registry.
			</div>

			{error && (
				<div
					className="flex items-center gap-2 px-3 py-2 rounded text-xs"
					style={{
						backgroundColor: `${theme.colors.error}15`,
						border: `1px solid ${theme.colors.error}30`,
					}}
				>
					<AlertTriangle className="w-3.5 h-3.5 shrink-0" style={{ color: theme.colors.error }} />
					<span style={{ color: theme.colors.error }}>{error}</span>
				</div>
			)}
		</div>
	);

	const renderStep2 = () => (
		<div className="flex flex-col gap-4" data-testid="keygen-step-2">
			<div className="flex items-center gap-2">
				<CheckCircle2 className="w-5 h-5" style={{ color: theme.colors.success }} />
				<span className="text-sm font-semibold" style={{ color: theme.colors.textMain }}>
					Signing Key Generated
				</span>
			</div>

			{/* Key Info */}
			<div
				className="flex flex-col gap-1.5 px-3 py-2.5 rounded text-xs font-mono"
				style={{
					backgroundColor: theme.colors.bgActivity,
					border: `1px solid ${theme.colors.border}`,
				}}
			>
				<div className="flex items-center justify-between">
					<span style={{ color: theme.colors.textDim }}>Key ID:</span>
					<span style={{ color: theme.colors.accent }}>{keyResult?.keyId}</span>
				</div>
				<div className="flex items-center justify-between">
					<span style={{ color: theme.colors.textDim }}>Algorithm:</span>
					<span style={{ color: theme.colors.textMain }}>Ed25519</span>
				</div>
				<div className="flex items-center justify-between">
					<span style={{ color: theme.colors.textDim }}>Location:</span>
					<span style={{ color: theme.colors.textMain }}>{KEY_DIR}/</span>
				</div>
			</div>

			{/* Security Rules */}
			<div className="flex flex-col gap-2">
				<div className="flex items-center gap-1.5">
					<AlertTriangle className="w-3.5 h-3.5" style={{ color: theme.colors.warning }} />
					<span
						className="text-xs font-semibold uppercase tracking-wider"
						style={{ color: theme.colors.warning }}
					>
						Security Rules (from VERIFY spec)
					</span>
				</div>
				{[
					'You MUST NOT transmit the private key over any network',
					'Private key file MUST have 0600 permissions (owner read/write only)',
					'Key material MUST NOT appear in VIBES audit data',
					'Back up your private key to a secure offline location',
				].map((rule) => (
					<div key={rule} className="flex items-start gap-2 text-xs">
						<Shield className="w-3 h-3 shrink-0 mt-0.5" style={{ color: theme.colors.warning }} />
						<span style={{ color: theme.colors.textMain }}>{rule}</span>
					</div>
				))}
			</div>

			{/* Files Created */}
			<div className="flex flex-col gap-1 text-xs">
				<span className="font-medium" style={{ color: theme.colors.textDim }}>
					Files created:
				</span>
				<code
					className="px-2 py-1 rounded"
					style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textMain }}
				>
					{PRIVATE_KEY_PATH}{' '}
					<span style={{ color: theme.colors.error }}>(PRIVATE — never share)</span>
				</code>
				<code
					className="px-2 py-1 rounded"
					style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textMain }}
				>
					{PUBLIC_KEY_PATH}{' '}
					<span style={{ color: theme.colors.success }}>(PUBLIC — safe to share)</span>
				</code>
			</div>

			{/* Copy Buttons */}
			<div className="flex gap-2">
				<CopyButton
					theme={theme}
					label="Copy Public Key"
					onClick={handleCopyPublicKey}
					copied={copiedField === 'publicKey'}
				/>
				<CopyButton
					theme={theme}
					label="Copy Key ID"
					onClick={() => keyResult && copyToClipboard(keyResult.keyId, 'keyId')}
					copied={copiedField === 'keyId'}
				/>
			</div>
		</div>
	);

	const renderStep3 = () => (
		<div className="flex flex-col gap-4" data-testid="keygen-step-3">
			<div className="flex items-center gap-2">
				<Shield className="w-5 h-5" style={{ color: theme.colors.accent }} />
				<span className="text-sm font-semibold" style={{ color: theme.colors.textMain }}>
					Secure Your Private Key
				</span>
			</div>

			<p className="text-xs leading-relaxed" style={{ color: theme.colors.textDim }}>
				If you lose your private key, you cannot create new attestations or prove authorship of past
				ones.
			</p>

			<div className="flex flex-col gap-2">
				<span className="text-xs font-medium" style={{ color: theme.colors.textMain }}>
					Recommended backup:
				</span>
				{[
					'Encrypted USB drive stored securely',
					"Organization's key management system",
					"Password manager's secure notes",
				].map((item, i) => (
					<div key={item} className="flex items-start gap-2 text-xs">
						<span
							className="shrink-0 w-4 h-4 flex items-center justify-center rounded-full text-[10px] font-bold"
							style={{
								backgroundColor: `${theme.colors.accent}20`,
								color: theme.colors.accent,
							}}
						>
							{i + 1}
						</span>
						<span style={{ color: theme.colors.textMain }}>{item}</span>
					</div>
				))}
			</div>

			{/* File to back up */}
			<div className="flex flex-col gap-1 text-xs">
				<span style={{ color: theme.colors.textDim }}>File to back up:</span>
				<div className="flex items-center gap-2">
					<code
						className="flex-1 px-2 py-1 rounded"
						style={{
							backgroundColor: theme.colors.bgActivity,
							color: theme.colors.accent,
						}}
					>
						{PRIVATE_KEY_PATH}
					</code>
					<CopyButton
						theme={theme}
						label="Copy Path"
						onClick={() => copyToClipboard(PRIVATE_KEY_PATH, 'path')}
						copied={copiedField === 'path'}
						compact
					/>
				</div>
			</div>

			{/* Acknowledgment checkbox */}
			<label
				className="flex items-center gap-2 text-xs cursor-pointer select-none"
				data-testid="backup-acknowledgment"
			>
				<input
					type="checkbox"
					checked={backupAcknowledged}
					onChange={(e) => setBackupAcknowledged(e.target.checked)}
					className="rounded"
					style={{ accentColor: theme.colors.accent }}
				/>
				<span style={{ color: theme.colors.textMain }}>
					I understand — I am responsible for my private key
				</span>
			</label>
		</div>
	);

	// ========================================================================
	// Footer
	// ========================================================================

	const renderFooter = () => {
		if (step === 1) {
			return (
				<ModalFooter
					theme={theme}
					onCancel={onClose}
					onConfirm={handleGenerate}
					cancelLabel="Cancel"
					confirmLabel={isGenerating ? 'Generating...' : 'Generate Key'}
					confirmDisabled={isGenerating}
					confirmButtonRef={generateBtnRef}
				/>
			);
		}

		if (step === 2) {
			return (
				<ModalFooter
					theme={theme}
					onCancel={onClose}
					onConfirm={() => setStep(3)}
					cancelLabel="Cancel"
					confirmLabel="Next"
					showCancel={true}
				/>
			);
		}

		return (
			<>
				<button
					type="button"
					onClick={handleDone}
					className="px-4 py-2 rounded border hover:bg-white/5 transition-colors outline-none"
					style={{
						borderColor: theme.colors.border,
						color: theme.colors.textMain,
					}}
				>
					Skip
				</button>
				<button
					type="button"
					onClick={handleDone}
					className="px-4 py-2 rounded transition-colors outline-none"
					style={{
						backgroundColor: theme.colors.accent,
						color: theme.colors.accentForeground,
					}}
				>
					Done
				</button>
			</>
		);
	};

	// ========================================================================
	// Render
	// ========================================================================

	const stepTitles: Record<WizardStep, string> = {
		1: 'Generate Signing Key',
		2: 'Key Generated',
		3: 'Backup Reminder',
	};

	return (
		<Modal
			theme={theme}
			title={stepTitles[step]}
			priority={MODAL_PRIORITIES.KEYGEN_WIZARD}
			onClose={onClose}
			width={480}
			footer={renderFooter()}
			headerIcon={
				isGenerating ? (
					<Loader2 className="w-4 h-4 animate-spin" style={{ color: theme.colors.accent }} />
				) : (
					<Key className="w-4 h-4" style={{ color: theme.colors.accent }} />
				)
			}
			initialFocusRef={generateBtnRef}
			testId="vibes-keygen-wizard"
		>
			{/* Step indicator */}
			<div className="flex items-center gap-1.5 mb-4">
				{([1, 2, 3] as WizardStep[]).map((s) => (
					<div
						key={s}
						className="h-1 flex-1 rounded-full transition-colors"
						style={{
							backgroundColor: s <= step ? theme.colors.accent : theme.colors.bgActivity,
						}}
						data-testid={`step-indicator-${s}`}
					/>
				))}
			</div>

			{step === 1 && renderStep1()}
			{step === 2 && renderStep2()}
			{step === 3 && renderStep3()}
		</Modal>
	);
};

// ============================================================================
// Copy Button Sub-component
// ============================================================================

interface CopyButtonProps {
	theme: Theme;
	label: string;
	onClick: () => void;
	copied: boolean;
	compact?: boolean;
}

const CopyButton: React.FC<CopyButtonProps> = ({ theme, label, onClick, copied, compact }) => (
	<button
		type="button"
		onClick={onClick}
		className={`flex items-center gap-1.5 rounded text-xs font-medium transition-colors hover:opacity-80 ${
			compact ? 'px-2 py-1' : 'px-3 py-1.5'
		}`}
		style={{
			backgroundColor: theme.colors.bgActivity,
			border: `1px solid ${theme.colors.border}`,
			color: copied ? theme.colors.success : theme.colors.textMain,
		}}
		data-testid={`copy-btn-${label.toLowerCase().replace(/\s+/g, '-')}`}
	>
		{copied ? <CheckCircle2 className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
		{copied ? 'Copied!' : label}
	</button>
);
