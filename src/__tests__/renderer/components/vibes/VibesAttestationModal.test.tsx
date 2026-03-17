/**
 * Tests for VibesAttestationModal component
 *
 * Validates the 7-step attestation progress modal:
 * 1. Shows all 7 pipeline steps with correct labels
 * 2. Calls IPC attest on mount and transitions to completed state
 * 3. Shows trust tier and attestation result on success
 * 4. Shows error state when attestation fails
 * 5. Maps per-step status correctly (pass/fail/skipped)
 * 6. Copy Attestation ID button works
 * 7. Cancel and Done buttons call correct callbacks
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { VibesAttestationModal } from '../../../../renderer/components/vibes/VibesAttestationModal';
import type { Theme } from '../../../../shared/theme-types';

// ============================================================================
// Mocks
// ============================================================================

vi.mock('lucide-react', () => ({
	ShieldCheck: () => <svg data-testid="shield-check-icon" />,
	CheckCircle2: () => <svg data-testid="check-circle-icon" />,
	AlertCircle: () => <svg data-testid="alert-circle-icon" />,
	Loader2: ({ className }: { className?: string }) => (
		<svg data-testid="loader-icon" className={className} />
	),
	Copy: () => <svg data-testid="copy-icon" />,
	MinusCircle: () => <svg data-testid="minus-circle-icon" />,
	X: () => <svg data-testid="x-icon" />,
}));

// Mock the useModalLayer hook used by Modal
vi.mock('../../../../renderer/hooks', () => ({
	useModalLayer: vi.fn(),
}));

// ============================================================================
// Test Theme & Helpers
// ============================================================================

const testTheme: Theme = {
	id: 'dracula',
	name: 'Dracula',
	mode: 'dark',
	colors: {
		bgMain: '#282a36',
		bgSidebar: '#21222c',
		bgActivity: '#343746',
		border: '#44475a',
		textMain: '#f8f8f2',
		textDim: '#6272a4',
		accent: '#bd93f9',
		accentDim: '#bd93f940',
		accentText: '#bd93f9',
		accentForeground: '#282a36',
		success: '#50fa7b',
		warning: '#f1fa8c',
		error: '#ff5555',
	},
};

// IPC mocks
const mockAttest = vi.fn();

beforeEach(() => {
	vi.clearAllMocks();

	// Default successful attestation response
	mockAttest.mockResolvedValue({
		success: true,
		data: {
			attestationId: '7f3a2b1cabcd1234abcdef9876543210',
			trustTier: 'tool-corroborated',
			envelope: {
				signatures: [
					{ keyid: 'a1b2c3d4e5f6a7b8', sig: 'user-sig', keytype: 'user' },
					{ keyid: 'maestro12345678', sig: 'tool-sig', keytype: 'tool_provider' },
				],
			},
			steps: {
				audit: 'pass',
				hash: 'pass',
				toolSign: 'pass',
				userSign: 'pass',
				timestamp: 'skipped',
				submit: 'pass',
			},
		},
	});

	(window as any).maestro = {
		vibes: {
			attestation: {
				attest: mockAttest,
			},
		},
	};

	// Mock clipboard
	Object.assign(navigator, {
		clipboard: {
			writeText: vi.fn().mockResolvedValue(undefined),
		},
	});
});

afterEach(() => {
	vi.restoreAllMocks();
});

// ============================================================================
// Tests
// ============================================================================

describe('VibesAttestationModal', () => {
	// ========================================================================
	// Step Display
	// ========================================================================

	it('renders all 7 pipeline steps', async () => {
		render(
			<VibesAttestationModal theme={testTheme} projectPath="/test/project" onClose={vi.fn()} />
		);

		expect(screen.getByTestId('attestation-steps')).toBeTruthy();
		expect(screen.getByTestId('step-audit')).toBeTruthy();
		expect(screen.getByTestId('step-hash')).toBeTruthy();
		expect(screen.getByTestId('step-toolSign')).toBeTruthy();
		expect(screen.getByTestId('step-userSign')).toBeTruthy();
		expect(screen.getByTestId('step-timestamp')).toBeTruthy();
		expect(screen.getByTestId('step-submit')).toBeTruthy();
		expect(screen.getByTestId('step-verify')).toBeTruthy();
	});

	it('shows correct step labels', async () => {
		render(
			<VibesAttestationModal theme={testTheme} projectPath="/test/project" onClose={vi.fn()} />
		);

		expect(screen.getByText(/Audit validation/)).toBeTruthy();
		expect(screen.getByText(/Compute file hashes/)).toBeTruthy();
		expect(screen.getByText(/Tool cosignature/)).toBeTruthy();
		expect(screen.getByText(/User signature/)).toBeTruthy();
		expect(screen.getByText(/Timestamp/)).toBeTruthy();
		expect(screen.getByText(/Submit to registry/)).toBeTruthy();
		expect(screen.getByText(/Verify/)).toBeTruthy();
	});

	it('has correct test ID on modal container', () => {
		render(
			<VibesAttestationModal theme={testTheme} projectPath="/test/project" onClose={vi.fn()} />
		);

		expect(screen.getByTestId('vibes-attestation-modal')).toBeTruthy();
	});

	// ========================================================================
	// Attestation Call
	// ========================================================================

	it('calls IPC attest on mount with projectPath and cosign option', async () => {
		render(
			<VibesAttestationModal
				theme={testTheme}
				projectPath="/test/project"
				cosign={true}
				onClose={vi.fn()}
			/>
		);

		await waitFor(() => {
			expect(mockAttest).toHaveBeenCalledWith('/test/project', { cosign: true });
		});
	});

	it('calls IPC attest with cosign=false when disabled', async () => {
		render(
			<VibesAttestationModal
				theme={testTheme}
				projectPath="/test/project"
				cosign={false}
				onClose={vi.fn()}
			/>
		);

		await waitFor(() => {
			expect(mockAttest).toHaveBeenCalledWith('/test/project', { cosign: false });
		});
	});

	// ========================================================================
	// Success State
	// ========================================================================

	it('shows completion result after successful attestation', async () => {
		render(
			<VibesAttestationModal theme={testTheme} projectPath="/test/project" onClose={vi.fn()} />
		);

		await waitFor(() => {
			expect(screen.getByTestId('attestation-result')).toBeTruthy();
		});

		expect(screen.getByText('All steps completed')).toBeTruthy();
		expect(screen.getByText(/7f3a2b1cabcd1234/)).toBeTruthy();
	});

	it('shows trust tier on successful attestation', async () => {
		render(
			<VibesAttestationModal theme={testTheme} projectPath="/test/project" onClose={vi.fn()} />
		);

		await waitFor(() => {
			expect(screen.getByTestId('trust-tier-display')).toBeTruthy();
		});

		// Trust tier appears in both the progress area and the result section
		expect(screen.getAllByText(/Tool-Corroborated/).length).toBeGreaterThanOrEqual(1);
	});

	it('shows signature count on successful attestation', async () => {
		render(
			<VibesAttestationModal theme={testTheme} projectPath="/test/project" onClose={vi.fn()} />
		);

		await waitFor(() => {
			expect(screen.getByTestId('attestation-result')).toBeTruthy();
		});

		expect(screen.getByText('2 (user + tool provider)')).toBeTruthy();
	});

	it('shows saved-to path on successful attestation', async () => {
		render(
			<VibesAttestationModal theme={testTheme} projectPath="/test/project" onClose={vi.fn()} />
		);

		await waitFor(() => {
			expect(screen.getByTestId('attestation-result')).toBeTruthy();
		});

		expect(screen.getByText('.ai-audit/attestation.json')).toBeTruthy();
	});

	// ========================================================================
	// Step Status Mapping
	// ========================================================================

	it('maps step statuses correctly for pass/fail/skipped', async () => {
		mockAttest.mockResolvedValue({
			success: true,
			data: {
				attestationId: 'abc123',
				trustTier: 'self-attested',
				envelope: { signatures: [{ keyid: 'a1b2', sig: 's', keytype: 'user' }] },
				steps: {
					audit: 'pass',
					hash: 'pass',
					toolSign: 'fail',
					userSign: 'pass',
					timestamp: 'skipped',
					submit: 'skipped',
				},
			},
		});

		render(
			<VibesAttestationModal theme={testTheme} projectPath="/test/project" onClose={vi.fn()} />
		);

		await waitFor(() => {
			expect(screen.getByTestId('attestation-result')).toBeTruthy();
		});

		// Check step details
		const auditStep = screen.getByTestId('step-audit');
		expect(auditStep.textContent).toContain('passed');

		const toolSignStep = screen.getByTestId('step-toolSign');
		expect(toolSignStep.textContent).toContain('unavailable');

		const timestampStep = screen.getByTestId('step-timestamp');
		expect(timestampStep.textContent).toContain('optional');

		const submitStep = screen.getByTestId('step-submit');
		expect(submitStep.textContent).toContain('skipped');
	});

	it('shows self-attested trust tier for user-only signatures', async () => {
		mockAttest.mockResolvedValue({
			success: true,
			data: {
				attestationId: 'abc123',
				trustTier: 'self-attested',
				envelope: { signatures: [{ keyid: 'a1b2', sig: 's', keytype: 'user' }] },
				steps: {
					audit: 'pass',
					hash: 'pass',
					toolSign: 'fail',
					userSign: 'pass',
					timestamp: 'skipped',
					submit: 'pass',
				},
			},
		});

		render(
			<VibesAttestationModal theme={testTheme} projectPath="/test/project" onClose={vi.fn()} />
		);

		await waitFor(() => {
			// Self-Attested appears in both progress area and result section
			expect(screen.getAllByText(/Self-Attested/).length).toBeGreaterThanOrEqual(1);
		});
	});

	// ========================================================================
	// Failure State
	// ========================================================================

	it('shows error when attestation returns failure', async () => {
		mockAttest.mockResolvedValue({
			success: false,
			error: 'No signing key found. Run keygen first.',
		});

		render(
			<VibesAttestationModal theme={testTheme} projectPath="/test/project" onClose={vi.fn()} />
		);

		await waitFor(() => {
			expect(screen.getByTestId('attestation-error')).toBeTruthy();
		});

		expect(screen.getByText('No signing key found. Run keygen first.')).toBeTruthy();
	});

	it('shows error when attestation IPC throws', async () => {
		mockAttest.mockRejectedValue(new Error('IPC communication failed'));

		render(
			<VibesAttestationModal theme={testTheme} projectPath="/test/project" onClose={vi.fn()} />
		);

		await waitFor(() => {
			expect(screen.getByTestId('attestation-error')).toBeTruthy();
		});

		expect(screen.getByText('IPC communication failed')).toBeTruthy();
	});

	// ========================================================================
	// Copy Attestation ID
	// ========================================================================

	it('copies attestation ID to clipboard when button clicked', async () => {
		render(
			<VibesAttestationModal theme={testTheme} projectPath="/test/project" onClose={vi.fn()} />
		);

		await waitFor(() => {
			expect(screen.getByTestId('copy-attestation-id')).toBeTruthy();
		});

		await act(async () => {
			fireEvent.click(screen.getByTestId('copy-attestation-id'));
		});

		expect(navigator.clipboard.writeText).toHaveBeenCalledWith('7f3a2b1cabcd1234abcdef9876543210');
	});

	it('shows "Copied!" after copying attestation ID', async () => {
		render(
			<VibesAttestationModal theme={testTheme} projectPath="/test/project" onClose={vi.fn()} />
		);

		await waitFor(() => {
			expect(screen.getByTestId('copy-attestation-id')).toBeTruthy();
		});

		await act(async () => {
			fireEvent.click(screen.getByTestId('copy-attestation-id'));
		});

		expect(screen.getByText('Copied!')).toBeTruthy();
	});

	// ========================================================================
	// Callbacks
	// ========================================================================

	it('calls onComplete and onClose when Done is clicked after success', async () => {
		const onClose = vi.fn();
		const onComplete = vi.fn();

		render(
			<VibesAttestationModal
				theme={testTheme}
				projectPath="/test/project"
				onClose={onClose}
				onComplete={onComplete}
			/>
		);

		await waitFor(() => {
			expect(screen.getByTestId('attestation-result')).toBeTruthy();
		});

		fireEvent.click(screen.getByText('Done'));

		expect(onComplete).toHaveBeenCalledOnce();
		expect(onClose).toHaveBeenCalledOnce();
	});

	it('calls onClose without onComplete when Cancel is clicked during progress', async () => {
		// Make attest never resolve to keep the modal in running state
		mockAttest.mockReturnValue(new Promise(() => {}));

		const onClose = vi.fn();
		const onComplete = vi.fn();

		render(
			<VibesAttestationModal
				theme={testTheme}
				projectPath="/test/project"
				onClose={onClose}
				onComplete={onComplete}
			/>
		);

		// Wait for the step to start running
		await waitFor(() => {
			const auditStep = screen.getByTestId('step-audit');
			expect(auditStep.textContent).toContain('validating...');
		});

		fireEvent.click(screen.getByText('Cancel'));

		expect(onClose).toHaveBeenCalledOnce();
		expect(onComplete).not.toHaveBeenCalled();
	});

	it('does not call attest more than once', async () => {
		render(
			<VibesAttestationModal theme={testTheme} projectPath="/test/project" onClose={vi.fn()} />
		);

		await waitFor(() => {
			expect(screen.getByTestId('attestation-result')).toBeTruthy();
		});

		expect(mockAttest).toHaveBeenCalledTimes(1);
	});

	// ========================================================================
	// Single signature display
	// ========================================================================

	it('shows "(user)" for single-signature attestation', async () => {
		mockAttest.mockResolvedValue({
			success: true,
			data: {
				attestationId: 'abc123',
				trustTier: 'self-attested',
				envelope: { signatures: [{ keyid: 'a1b2', sig: 's', keytype: 'user' }] },
				steps: {
					audit: 'pass',
					hash: 'pass',
					toolSign: 'fail',
					userSign: 'pass',
					timestamp: 'skipped',
					submit: 'pass',
				},
			},
		});

		render(
			<VibesAttestationModal theme={testTheme} projectPath="/test/project" onClose={vi.fn()} />
		);

		await waitFor(() => {
			expect(screen.getByTestId('attestation-result')).toBeTruthy();
		});

		expect(screen.getByText('1 (user)')).toBeTruthy();
	});
});
