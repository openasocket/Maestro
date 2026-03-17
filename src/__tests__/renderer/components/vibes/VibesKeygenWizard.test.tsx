/**
 * Tests for VibesKeygenWizard component
 *
 * Validates the 3-step key generation wizard:
 * 1. Step 1 renders explanation and Generate button
 * 2. Generate button calls IPC keygen
 * 3. Step 2 shows key info and security rules after generation
 * 4. Step 3 shows backup reminder with acknowledgment checkbox
 * 5. Copy buttons work for public key and key ID
 * 6. Error state displays when keygen fails
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { VibesKeygenWizard } from '../../../../renderer/components/vibes/VibesKeygenWizard';
import type { Theme } from '../../../../shared/theme-types';

// ============================================================================
// Mocks
// ============================================================================

vi.mock('lucide-react', () => ({
	Key: () => <svg data-testid="key-icon" />,
	Shield: () => <svg data-testid="shield-icon" />,
	Copy: () => <svg data-testid="copy-icon" />,
	CheckCircle2: () => <svg data-testid="check-circle-icon" />,
	AlertTriangle: () => <svg data-testid="alert-triangle-icon" />,
	Loader2: ({ className }: { className?: string }) => (
		<svg data-testid="loader-icon" className={className} />
	),
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
const mockKeygen = vi.fn();
const mockExportPublicKey = vi.fn();

beforeEach(() => {
	vi.clearAllMocks();

	// Default successful keygen response
	mockKeygen.mockResolvedValue({
		success: true,
		data: {
			publicKey: 'mock-public-key-pem',
			keyId: 'a1b2c3d4e5f6a7b8',
		},
	});

	mockExportPublicKey.mockResolvedValue({
		success: true,
		data: '-----BEGIN PUBLIC KEY-----\nmock-pem-data\n-----END PUBLIC KEY-----',
	});

	(window as any).maestro = {
		vibes: {
			attestation: {
				keygen: mockKeygen,
				exportPublicKey: mockExportPublicKey,
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

describe('VibesKeygenWizard', () => {
	// ========================================================================
	// Step 1 — What and Why
	// ========================================================================

	it('renders step 1 with explanation and Generate button', () => {
		render(<VibesKeygenWizard theme={testTheme} onClose={vi.fn()} />);

		expect(screen.getByTestId('keygen-step-1')).toBeTruthy();
		expect(screen.getByText('Generate Your VIBES Signing Key')).toBeTruthy();
		expect(screen.getByText(/cryptographic envelopes/)).toBeTruthy();
		expect(screen.getByText('Generate Key')).toBeTruthy();
	});

	it('shows step indicators with step 1 active', () => {
		render(<VibesKeygenWizard theme={testTheme} onClose={vi.fn()} />);

		const indicator1 = screen.getByTestId('step-indicator-1');
		const indicator2 = screen.getByTestId('step-indicator-2');
		const indicator3 = screen.getByTestId('step-indicator-3');

		// Step 1 should be active (accent color), steps 2-3 should be inactive
		// Browser may render hex as rgb(), so compare against both
		expect(indicator1.style.backgroundColor).not.toBe(indicator2.style.backgroundColor);
		expect(indicator2.style.backgroundColor).toBe(indicator3.style.backgroundColor);
	});

	it('shows three key benefits: Integrity, Authenticity, Trust', () => {
		render(<VibesKeygenWizard theme={testTheme} onClose={vi.fn()} />);

		expect(screen.getByText('Integrity')).toBeTruthy();
		expect(screen.getByText('Authenticity')).toBeTruthy();
		expect(screen.getByText('Trust')).toBeTruthy();
	});

	it('calls IPC keygen when Generate button is clicked', async () => {
		render(<VibesKeygenWizard theme={testTheme} onClose={vi.fn()} />);

		await act(async () => {
			fireEvent.click(screen.getByText('Generate Key'));
		});

		expect(mockKeygen).toHaveBeenCalledTimes(1);
	});

	it('shows error when keygen fails', async () => {
		mockKeygen.mockResolvedValue({
			success: false,
			error: 'Permission denied',
		});

		render(<VibesKeygenWizard theme={testTheme} onClose={vi.fn()} />);

		await act(async () => {
			fireEvent.click(screen.getByText('Generate Key'));
		});

		await waitFor(() => {
			expect(screen.getByText('Permission denied')).toBeTruthy();
		});

		// Should stay on step 1
		expect(screen.getByTestId('keygen-step-1')).toBeTruthy();
	});

	it('shows error when keygen throws', async () => {
		mockKeygen.mockRejectedValue(new Error('Network error'));

		render(<VibesKeygenWizard theme={testTheme} onClose={vi.fn()} />);

		await act(async () => {
			fireEvent.click(screen.getByText('Generate Key'));
		});

		await waitFor(() => {
			expect(screen.getByText('Network error')).toBeTruthy();
		});
	});

	// ========================================================================
	// Step 2 — Key Generated
	// ========================================================================

	it('advances to step 2 after successful keygen', async () => {
		render(<VibesKeygenWizard theme={testTheme} onClose={vi.fn()} />);

		await act(async () => {
			fireEvent.click(screen.getByText('Generate Key'));
		});

		await waitFor(() => {
			expect(screen.getByTestId('keygen-step-2')).toBeTruthy();
		});

		expect(screen.getByText('Signing Key Generated')).toBeTruthy();
		expect(screen.getByText('a1b2c3d4e5f6a7b8')).toBeTruthy();
		expect(screen.getByText('Ed25519')).toBeTruthy();
	});

	it('shows security rules on step 2', async () => {
		render(<VibesKeygenWizard theme={testTheme} onClose={vi.fn()} />);

		await act(async () => {
			fireEvent.click(screen.getByText('Generate Key'));
		});

		await waitFor(() => {
			expect(screen.getByText(/Security Rules/)).toBeTruthy();
		});

		expect(screen.getByText(/MUST NOT transmit the private key/)).toBeTruthy();
		expect(screen.getByText(/MUST have 0600 permissions/)).toBeTruthy();
		expect(screen.getByText(/MUST NOT appear in VIBES audit data/)).toBeTruthy();
	});

	it('shows file paths on step 2', async () => {
		render(<VibesKeygenWizard theme={testTheme} onClose={vi.fn()} />);

		await act(async () => {
			fireEvent.click(screen.getByText('Generate Key'));
		});

		await waitFor(() => {
			expect(screen.getByText(/vibescheck\.key/)).toBeTruthy();
			expect(screen.getByText(/vibescheck\.pub/)).toBeTruthy();
		});
	});

	it('Copy Public Key button calls exportPublicKey IPC', async () => {
		render(<VibesKeygenWizard theme={testTheme} onClose={vi.fn()} />);

		await act(async () => {
			fireEvent.click(screen.getByText('Generate Key'));
		});

		await waitFor(() => {
			expect(screen.getByTestId('copy-btn-copy-public-key')).toBeTruthy();
		});

		await act(async () => {
			fireEvent.click(screen.getByTestId('copy-btn-copy-public-key'));
		});

		expect(mockExportPublicKey).toHaveBeenCalledWith('pem');
	});

	it('Copy Key ID button copies key ID to clipboard', async () => {
		render(<VibesKeygenWizard theme={testTheme} onClose={vi.fn()} />);

		await act(async () => {
			fireEvent.click(screen.getByText('Generate Key'));
		});

		await waitFor(() => {
			expect(screen.getByTestId('copy-btn-copy-key-id')).toBeTruthy();
		});

		await act(async () => {
			fireEvent.click(screen.getByTestId('copy-btn-copy-key-id'));
		});

		expect(navigator.clipboard.writeText).toHaveBeenCalledWith('a1b2c3d4e5f6a7b8');
	});

	it('shows Next button on step 2 to advance to step 3', async () => {
		render(<VibesKeygenWizard theme={testTheme} onClose={vi.fn()} />);

		await act(async () => {
			fireEvent.click(screen.getByText('Generate Key'));
		});

		await waitFor(() => {
			expect(screen.getByText('Next')).toBeTruthy();
		});

		await act(async () => {
			fireEvent.click(screen.getByText('Next'));
		});

		expect(screen.getByTestId('keygen-step-3')).toBeTruthy();
	});

	// ========================================================================
	// Step 3 — Backup Reminder
	// ========================================================================

	it('renders step 3 with backup instructions', async () => {
		render(<VibesKeygenWizard theme={testTheme} onClose={vi.fn()} />);

		// Navigate to step 3
		await act(async () => {
			fireEvent.click(screen.getByText('Generate Key'));
		});
		await waitFor(() => {
			expect(screen.getByText('Next')).toBeTruthy();
		});
		await act(async () => {
			fireEvent.click(screen.getByText('Next'));
		});

		expect(screen.getByText('Secure Your Private Key')).toBeTruthy();
		expect(screen.getByText(/Encrypted USB drive/)).toBeTruthy();
		expect(screen.getByText(/key management system/)).toBeTruthy();
		expect(screen.getByText(/Password manager/)).toBeTruthy();
	});

	it('shows advisory checkbox on step 3', async () => {
		render(<VibesKeygenWizard theme={testTheme} onClose={vi.fn()} />);

		// Navigate to step 3
		await act(async () => {
			fireEvent.click(screen.getByText('Generate Key'));
		});
		await waitFor(() => {
			expect(screen.getByText('Next')).toBeTruthy();
		});
		await act(async () => {
			fireEvent.click(screen.getByText('Next'));
		});

		const acknowledgment = screen.getByTestId('backup-acknowledgment');
		expect(acknowledgment).toBeTruthy();
		expect(screen.getByText(/I understand — I am responsible for my private key/)).toBeTruthy();
	});

	it('shows Skip and Done buttons on step 3', async () => {
		render(<VibesKeygenWizard theme={testTheme} onClose={vi.fn()} />);

		// Navigate to step 3
		await act(async () => {
			fireEvent.click(screen.getByText('Generate Key'));
		});
		await waitFor(() => {
			expect(screen.getByText('Next')).toBeTruthy();
		});
		await act(async () => {
			fireEvent.click(screen.getByText('Next'));
		});

		expect(screen.getByText('Skip')).toBeTruthy();
		expect(screen.getByText('Done')).toBeTruthy();
	});

	it('calls onComplete with keyId when Done is clicked', async () => {
		const onComplete = vi.fn();
		const onClose = vi.fn();

		render(<VibesKeygenWizard theme={testTheme} onClose={onClose} onComplete={onComplete} />);

		// Navigate to step 3
		await act(async () => {
			fireEvent.click(screen.getByText('Generate Key'));
		});
		await waitFor(() => {
			expect(screen.getByText('Next')).toBeTruthy();
		});
		await act(async () => {
			fireEvent.click(screen.getByText('Next'));
		});

		fireEvent.click(screen.getByText('Done'));

		expect(onComplete).toHaveBeenCalledWith('a1b2c3d4e5f6a7b8');
		expect(onClose).toHaveBeenCalled();
	});

	it('calls onClose when Skip is clicked on step 3', async () => {
		const onClose = vi.fn();
		const onComplete = vi.fn();

		render(<VibesKeygenWizard theme={testTheme} onClose={onClose} onComplete={onComplete} />);

		// Navigate to step 3
		await act(async () => {
			fireEvent.click(screen.getByText('Generate Key'));
		});
		await waitFor(() => {
			expect(screen.getByText('Next')).toBeTruthy();
		});
		await act(async () => {
			fireEvent.click(screen.getByText('Next'));
		});

		fireEvent.click(screen.getByText('Skip'));

		expect(onComplete).toHaveBeenCalledWith('a1b2c3d4e5f6a7b8');
		expect(onClose).toHaveBeenCalled();
	});

	// ========================================================================
	// General
	// ========================================================================

	it('calls onClose when Cancel is clicked on step 1', () => {
		const onClose = vi.fn();

		render(<VibesKeygenWizard theme={testTheme} onClose={onClose} />);

		fireEvent.click(screen.getByText('Cancel'));

		expect(onClose).toHaveBeenCalled();
	});

	it('updates step indicators as steps progress', async () => {
		render(<VibesKeygenWizard theme={testTheme} onClose={vi.fn()} />);

		const getIndicatorBg = (n: number) =>
			screen.getByTestId(`step-indicator-${n}`).style.backgroundColor;

		// Step 1: only indicator 1 active (different from inactive indicators)
		const inactiveBg = getIndicatorBg(2);
		expect(getIndicatorBg(1)).not.toBe(inactiveBg);
		expect(getIndicatorBg(3)).toBe(inactiveBg);

		// Advance to step 2
		await act(async () => {
			fireEvent.click(screen.getByText('Generate Key'));
		});

		await waitFor(() => {
			// Steps 1 and 2 active, step 3 still inactive
			expect(getIndicatorBg(1)).not.toBe(inactiveBg);
			expect(getIndicatorBg(2)).not.toBe(inactiveBg);
			expect(getIndicatorBg(3)).toBe(inactiveBg);
		});

		// Advance to step 3
		await act(async () => {
			fireEvent.click(screen.getByText('Next'));
		});

		// All three indicators active (none should be inactive bg)
		expect(getIndicatorBg(1)).not.toBe(inactiveBg);
		expect(getIndicatorBg(2)).not.toBe(inactiveBg);
		expect(getIndicatorBg(3)).not.toBe(inactiveBg);
	});

	it('has correct test ID on modal container', () => {
		render(<VibesKeygenWizard theme={testTheme} onClose={vi.fn()} />);

		expect(screen.getByTestId('vibes-keygen-wizard')).toBeTruthy();
	});
});
