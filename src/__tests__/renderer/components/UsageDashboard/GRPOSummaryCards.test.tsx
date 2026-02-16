/**
 * Tests for GRPOSummaryCards component
 *
 * Verifies:
 * - Renders all 4 summary cards
 * - Trend arrow shows correct direction
 * - Loading state shows skeleton (parent responsibility, but we test empty data)
 * - Empty state when GRPO not enabled (zero values)
 * - Theme-aware styling for all elements
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { GRPOSummaryCards } from '../../../../renderer/components/UsageDashboard/GRPOSummaryCards';
import { THEMES } from '../../../../shared/themes';
import type { GRPOStats, GRPOConfig } from '../../../../shared/grpo-types';
import { GRPO_CONFIG_DEFAULTS } from '../../../../shared/grpo-types';

const darkTheme = THEMES['dracula'];
const lightTheme = THEMES['solarized-light'];

function makeStats(overrides: Partial<GRPOStats> = {}): GRPOStats {
	return {
		totalRolloutGroups: 5,
		totalRollouts: 15,
		librarySize: 12,
		currentEpoch: 3,
		overallMeanReward: 0.78,
		latestEpochMeanReward: 0.82,
		rewardTrend: 0.12,
		totalOperations: { add: 8, modify: 3, delete: 1 },
		totalGRPOTokens: 800000,
		epochs: [],
		recentRolloutGroups: [],
		...overrides,
	};
}

describe('GRPOSummaryCards', () => {
	describe('Rendering', () => {
		it('renders the summary cards container with correct test ID', () => {
			render(<GRPOSummaryCards data={makeStats()} theme={darkTheme} />);
			expect(screen.getByTestId('grpo-summary-cards')).toBeInTheDocument();
		});

		it('renders all 4 metric cards', () => {
			render(<GRPOSummaryCards data={makeStats()} theme={darkTheme} />);
			const cards = screen.getAllByTestId('grpo-metric-card');
			expect(cards).toHaveLength(4);
		});

		it('displays library size value', () => {
			render(<GRPOSummaryCards data={makeStats({ librarySize: 12 })} theme={darkTheme} />);
			expect(screen.getByText('12')).toBeInTheDocument();
			expect(screen.getByText('Library Size')).toBeInTheDocument();
		});

		it('displays mean reward value', () => {
			render(<GRPOSummaryCards data={makeStats({ overallMeanReward: 0.78 })} theme={darkTheme} />);
			expect(screen.getByText('0.78')).toBeInTheDocument();
			expect(screen.getByText('Mean Reward')).toBeInTheDocument();
		});

		it('displays total rollouts value', () => {
			render(<GRPOSummaryCards data={makeStats({ totalRollouts: 45 })} theme={darkTheme} />);
			expect(screen.getByText('45')).toBeInTheDocument();
			expect(screen.getByText('Total Rollouts')).toBeInTheDocument();
		});

		it('displays token cost estimate', () => {
			render(<GRPOSummaryCards data={makeStats({ totalGRPOTokens: 800000 })} theme={darkTheme} />);
			expect(screen.getByText('~$2.40')).toBeInTheDocument();
			expect(screen.getByText('Token Cost')).toBeInTheDocument();
		});
	});

	describe('Trend Arrow', () => {
		it('shows upward trend arrow for positive reward trend', () => {
			render(<GRPOSummaryCards data={makeStats({ rewardTrend: 0.12 })} theme={darkTheme} />);
			expect(screen.getByText('↑ 12%')).toBeInTheDocument();
		});

		it('shows downward trend arrow for negative reward trend', () => {
			render(<GRPOSummaryCards data={makeStats({ rewardTrend: -0.05 })} theme={darkTheme} />);
			expect(screen.getByText('↓ 5%')).toBeInTheDocument();
		});

		it('shows no trend when reward trend is zero', () => {
			render(<GRPOSummaryCards data={makeStats({ rewardTrend: 0 })} theme={darkTheme} />);
			expect(screen.queryByText(/[↑↓]/)).not.toBeInTheDocument();
		});
	});

	describe('Empty / Zero State', () => {
		it('shows dash for mean reward when zero', () => {
			render(
				<GRPOSummaryCards
					data={makeStats({ overallMeanReward: 0, totalRollouts: 0, librarySize: 0, totalGRPOTokens: 0 })}
					theme={darkTheme}
				/>
			);
			// Mean reward should show em-dash
			expect(screen.getByText('—')).toBeInTheDocument();
		});

		it('shows zero token cost as $0.00', () => {
			render(
				<GRPOSummaryCards
					data={makeStats({ totalGRPOTokens: 0 })}
					theme={darkTheme}
				/>
			);
			expect(screen.getByText('$0.00')).toBeInTheDocument();
		});
	});

	describe('Config Integration', () => {
		it('shows max library size from config', () => {
			const config: GRPOConfig = { ...GRPO_CONFIG_DEFAULTS, maxLibrarySize: 100 };
			render(
				<GRPOSummaryCards
					data={makeStats({ librarySize: 12 })}
					theme={darkTheme}
					config={config}
				/>
			);
			expect(screen.getByText('/ 100 max')).toBeInTheDocument();
		});

		it('uses default max library size when no config', () => {
			render(
				<GRPOSummaryCards data={makeStats({ librarySize: 12 })} theme={darkTheme} />
			);
			expect(screen.getByText('/ 50 max')).toBeInTheDocument();
		});
	});

	describe('Theme Styling', () => {
		it('applies theme background color to cards', () => {
			render(<GRPOSummaryCards data={makeStats()} theme={darkTheme} />);
			const cards = screen.getAllByTestId('grpo-metric-card');
			cards.forEach((card) => {
				expect(card).toHaveStyle({ backgroundColor: darkTheme.colors.bgMain });
			});
		});

		it('works with light theme', () => {
			render(<GRPOSummaryCards data={makeStats()} theme={lightTheme} />);
			const cards = screen.getAllByTestId('grpo-metric-card');
			cards.forEach((card) => {
				expect(card).toHaveStyle({ backgroundColor: lightTheme.colors.bgMain });
			});
		});
	});

	describe('Layout', () => {
		it('uses grid layout with 4 columns by default', () => {
			render(<GRPOSummaryCards data={makeStats()} theme={darkTheme} />);
			const container = screen.getByTestId('grpo-summary-cards');
			expect(container).toHaveClass('grid');
			expect(container).toHaveStyle({ gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' });
		});

		it('supports custom column count', () => {
			render(<GRPOSummaryCards data={makeStats()} theme={darkTheme} columns={2} />);
			const container = screen.getByTestId('grpo-summary-cards');
			expect(container).toHaveStyle({ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' });
		});
	});

	describe('Accessibility', () => {
		it('has region role and label', () => {
			render(<GRPOSummaryCards data={makeStats()} theme={darkTheme} />);
			const region = screen.getByRole('region', { name: 'GRPO summary metrics' });
			expect(region).toBeInTheDocument();
		});

		it('each card has group role with descriptive label', () => {
			render(<GRPOSummaryCards data={makeStats({ librarySize: 12 })} theme={darkTheme} />);
			const groups = screen.getAllByRole('group');
			expect(groups.length).toBe(4);
			// Check that library size card has the correct aria-label
			expect(groups[0]).toHaveAttribute('aria-label', 'Library Size: 12');
		});
	});
});
