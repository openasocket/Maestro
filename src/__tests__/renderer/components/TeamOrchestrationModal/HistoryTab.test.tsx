/**
 * Tests for HistoryTab component
 *
 * Verifies:
 * - Renders search bar, filter dropdowns, table, and pagination
 * - Loading state shows skeleton rows
 * - Empty state with contextual messages (no data vs no filter match)
 * - Table rows display formatted data correctly
 * - Alternating row backgrounds
 * - Pagination controls with correct state
 * - Row click toggles expanded detail
 * - Filter dropdowns call hook setters
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import type { Theme } from '../../../../renderer/types';
import type { TeamOrchEvent } from '../../../../shared/team-orch-stats-types';

// Mock return value — mutable so tests can override
const mockHistoryReturn = {
	events: [] as TeamOrchEvent[],
	total: 0,
	loading: false,
	error: null as Error | null,
	page: 0,
	pageSize: 20,
	setPage: vi.fn(),
	totalPages: 0,
	topologyFilter: undefined as string | undefined,
	setTopologyFilter: vi.fn(),
	statusFilter: undefined as string | undefined,
	setStatusFilter: vi.fn(),
	searchQuery: '',
	setSearchQuery: vi.fn(),
	refresh: vi.fn(),
};

vi.mock('../../../../renderer/hooks/teamOrch/useTeamOrchHistory', () => ({
	useTeamOrchHistory: () => mockHistoryReturn,
}));

// Mock window.maestro APIs
const mockGroupChatList = vi.fn().mockResolvedValue([]);
const mockGroupChatGetHistory = vi.fn().mockResolvedValue([]);
const mockExportJson = vi.fn().mockResolvedValue({ saved: true, path: '/tmp/export.json' });
const mockExportCsv = vi.fn().mockResolvedValue({ saved: true, path: '/tmp/export.csv' });

Object.defineProperty(window, 'maestro', {
	value: {
		groupChat: {
			list: mockGroupChatList,
			getHistory: mockGroupChatGetHistory,
		},
		teamOrchStats: {
			exportJson: mockExportJson,
			exportCsv: mockExportCsv,
		},
	},
	writable: true,
});

// Import after mock
import { HistoryTab } from '../../../../renderer/components/TeamOrchestrationModal/HistoryTab';

const createTheme = (): Theme => ({
	id: 'test-dark',
	name: 'Test Dark',
	mode: 'dark',
	colors: {
		bgMain: '#1a1a2e',
		bgSidebar: '#16213e',
		bgActivity: '#0f3460',
		textMain: '#e8e8e8',
		textDim: '#888888',
		accent: '#7b2cbf',
		border: '#333355',
		success: '#22c55e',
		warning: '#f59e0b',
		error: '#ef4444',
		info: '#3b82f6',
		bgAccentHover: '#9333ea',
	},
});

function createEvent(overrides: Partial<TeamOrchEvent> = {}): TeamOrchEvent {
	return {
		id: 'evt-1',
		groupChatId: 'gc-1',
		groupChatName: 'Test Chat',
		topologyPattern: 'hub-spoke',
		terminationMode: 'max-iterations',
		status: 'completed',
		iterationCount: 3,
		maxIterations: 10,
		startTime: new Date('2026-03-21T14:30:00Z').getTime(),
		endTime: new Date('2026-03-21T14:45:00Z').getTime(),
		duration: 900000,
		participantCount: 3,
		participantBreakdown: [],
		totalTokens: 15000,
		totalCost: 0.45,
		moderatorAgentId: 'claude-code',
		...overrides,
	};
}

describe('HistoryTab', () => {
	const theme = createTheme();

	beforeEach(() => {
		// Reset to defaults
		mockHistoryReturn.events = [];
		mockHistoryReturn.total = 0;
		mockHistoryReturn.loading = false;
		mockHistoryReturn.error = null;
		mockHistoryReturn.page = 0;
		mockHistoryReturn.totalPages = 0;
		mockHistoryReturn.topologyFilter = undefined;
		mockHistoryReturn.statusFilter = undefined;
		mockHistoryReturn.searchQuery = '';
		vi.clearAllMocks();
	});

	describe('Rendering', () => {
		it('renders the history tab container', () => {
			render(<HistoryTab theme={theme} />);
			expect(screen.getByTestId('history-tab')).toBeInTheDocument();
		});

		it('renders the search bar', () => {
			render(<HistoryTab theme={theme} />);
			expect(screen.getByTestId('history-search')).toBeInTheDocument();
			expect(screen.getByPlaceholderText('Search past workflows...')).toBeInTheDocument();
		});

		it('renders topology and status filter dropdowns', () => {
			render(<HistoryTab theme={theme} />);
			expect(screen.getByTestId('topology-filter')).toBeInTheDocument();
			expect(screen.getByTestId('status-filter')).toBeInTheDocument();
		});
	});

	describe('Loading State', () => {
		it('shows skeleton rows when loading', () => {
			mockHistoryReturn.loading = true;
			render(<HistoryTab theme={theme} />);
			expect(screen.getByTestId('history-skeleton')).toBeInTheDocument();
		});

		it('does not show table or empty state when loading', () => {
			mockHistoryReturn.loading = true;
			render(<HistoryTab theme={theme} />);
			expect(screen.queryByTestId('history-table')).not.toBeInTheDocument();
			expect(screen.queryByTestId('team-orch-empty')).not.toBeInTheDocument();
		});
	});

	describe('Empty State', () => {
		it('shows "No workflow history yet" when no events and no filters', () => {
			render(<HistoryTab theme={theme} />);
			expect(screen.getByText('No workflow history yet')).toBeInTheDocument();
		});

		it('shows "No results match your filters" when filters active', () => {
			mockHistoryReturn.topologyFilter = 'hub-spoke';
			render(<HistoryTab theme={theme} />);
			expect(screen.getByText('No results match your filters')).toBeInTheDocument();
		});

		it('shows filter message when search query is active', () => {
			mockHistoryReturn.searchQuery = 'test search';
			render(<HistoryTab theme={theme} />);
			expect(screen.getByText('No results match your filters')).toBeInTheDocument();
		});

		it('shows filter message when status filter is active', () => {
			mockHistoryReturn.statusFilter = 'failed';
			render(<HistoryTab theme={theme} />);
			expect(screen.getByText('No results match your filters')).toBeInTheDocument();
		});
	});

	describe('Table Rendering', () => {
		it('renders table with events', () => {
			const event = createEvent();
			mockHistoryReturn.events = [event];
			mockHistoryReturn.total = 1;
			mockHistoryReturn.totalPages = 1;

			render(<HistoryTab theme={theme} />);
			expect(screen.getByTestId('history-table')).toBeInTheDocument();
		});

		it('renders all column headers', () => {
			mockHistoryReturn.events = [createEvent()];
			mockHistoryReturn.total = 1;
			mockHistoryReturn.totalPages = 1;

			render(<HistoryTab theme={theme} />);
			expect(screen.getByText('Date')).toBeInTheDocument();
			expect(screen.getByText('Group Chat')).toBeInTheDocument();
			expect(screen.getByText('Topology')).toBeInTheDocument();
			expect(screen.getByText('Iterations')).toBeInTheDocument();
			expect(screen.getByText('Duration')).toBeInTheDocument();
			expect(screen.getByText('Tokens')).toBeInTheDocument();
			expect(screen.getByText('Status')).toBeInTheDocument();
		});

		it('displays group chat name', () => {
			mockHistoryReturn.events = [createEvent({ groupChatName: 'My Team Chat' })];
			mockHistoryReturn.total = 1;
			mockHistoryReturn.totalPages = 1;

			render(<HistoryTab theme={theme} />);
			expect(screen.getByText('My Team Chat')).toBeInTheDocument();
		});

		it('displays topology badge', () => {
			mockHistoryReturn.events = [createEvent({ topologyPattern: 'pipeline' })];
			mockHistoryReturn.total = 1;
			mockHistoryReturn.totalPages = 1;

			render(<HistoryTab theme={theme} />);
			// "Pipeline" appears in both the filter dropdown option and the table badge
			const badges = screen.getAllByText('Pipeline');
			expect(badges.length).toBeGreaterThanOrEqual(2); // option + badge
		});

		it('displays iterations as count / max', () => {
			mockHistoryReturn.events = [createEvent({ iterationCount: 5, maxIterations: 10 })];
			mockHistoryReturn.total = 1;
			mockHistoryReturn.totalPages = 1;

			render(<HistoryTab theme={theme} />);
			expect(screen.getByText('5 / 10')).toBeInTheDocument();
		});

		it('displays formatted duration', () => {
			mockHistoryReturn.events = [createEvent({ duration: 900000 })];
			mockHistoryReturn.total = 1;
			mockHistoryReturn.totalPages = 1;

			render(<HistoryTab theme={theme} />);
			expect(screen.getByText('15m 0s')).toBeInTheDocument();
		});

		it('displays formatted token count', () => {
			mockHistoryReturn.events = [createEvent({ totalTokens: 15000 })];
			mockHistoryReturn.total = 1;
			mockHistoryReturn.totalPages = 1;

			render(<HistoryTab theme={theme} />);
			expect(screen.getByText('15.0K')).toBeInTheDocument();
		});

		it('displays status badge with capitalized label', () => {
			mockHistoryReturn.events = [createEvent({ status: 'completed' })];
			mockHistoryReturn.total = 1;
			mockHistoryReturn.totalPages = 1;

			render(<HistoryTab theme={theme} />);
			// "Completed" appears in both the filter dropdown and the table badge
			const matches = screen.getAllByText('Completed');
			// The badge is a <span> with specific class
			const badge = matches.find((el) => el.tagName === 'SPAN');
			expect(badge).toBeTruthy();
		});

		it('renders status badge with correct color for failed', () => {
			mockHistoryReturn.events = [createEvent({ status: 'failed' })];
			mockHistoryReturn.total = 1;
			mockHistoryReturn.totalPages = 1;

			render(<HistoryTab theme={theme} />);
			// "Failed" appears in both the filter dropdown and the table badge
			const matches = screen.getAllByText('Failed');
			const badge = matches.find((el) => el.tagName === 'SPAN');
			expect(badge).toBeTruthy();
			expect(badge).toHaveStyle({ color: theme.colors.error });
		});

		it('renders alternating row backgrounds for multiple events', () => {
			mockHistoryReturn.events = [
				createEvent({ id: 'evt-1' }),
				createEvent({ id: 'evt-2', groupChatName: 'Chat 2' }),
			];
			mockHistoryReturn.total = 2;
			mockHistoryReturn.totalPages = 1;

			render(<HistoryTab theme={theme} />);
			const row0 = screen.getByTestId('history-row-evt-1');
			const row1 = screen.getByTestId('history-row-evt-2');
			expect(row0).toHaveStyle({ backgroundColor: theme.colors.bgMain });
			expect(row1).toHaveStyle({ backgroundColor: theme.colors.bgActivity });
		});
	});

	describe('Row Expansion', () => {
		it('shows expanded detail on row click', () => {
			const event = createEvent({ id: 'evt-1' });
			mockHistoryReturn.events = [event];
			mockHistoryReturn.total = 1;
			mockHistoryReturn.totalPages = 1;

			render(<HistoryTab theme={theme} />);
			expect(screen.queryByTestId('history-detail-evt-1')).not.toBeInTheDocument();

			fireEvent.click(screen.getByTestId('history-row-evt-1'));
			expect(screen.getByTestId('history-detail-evt-1')).toBeInTheDocument();
		});

		it('collapses expanded row on second click', () => {
			const event = createEvent({ id: 'evt-1' });
			mockHistoryReturn.events = [event];
			mockHistoryReturn.total = 1;
			mockHistoryReturn.totalPages = 1;

			render(<HistoryTab theme={theme} />);
			fireEvent.click(screen.getByTestId('history-row-evt-1'));
			expect(screen.getByTestId('history-detail-evt-1')).toBeInTheDocument();

			fireEvent.click(screen.getByTestId('history-row-evt-1'));
			expect(screen.queryByTestId('history-detail-evt-1')).not.toBeInTheDocument();
		});
	});

	describe('Pagination', () => {
		it('shows pagination when events exist', () => {
			mockHistoryReturn.events = [createEvent()];
			mockHistoryReturn.total = 25;
			mockHistoryReturn.totalPages = 2;

			render(<HistoryTab theme={theme} />);
			expect(screen.getByTestId('history-pagination')).toBeInTheDocument();
		});

		it('shows correct "Showing X-Y of Z" text', () => {
			mockHistoryReturn.events = [createEvent()];
			mockHistoryReturn.total = 45;
			mockHistoryReturn.totalPages = 3;
			mockHistoryReturn.page = 0;

			render(<HistoryTab theme={theme} />);
			expect(screen.getByText(/Showing 1–20 of 45/)).toBeInTheDocument();
		});

		it('calls setPage when Previous is clicked', () => {
			mockHistoryReturn.events = [createEvent()];
			mockHistoryReturn.total = 45;
			mockHistoryReturn.totalPages = 3;
			mockHistoryReturn.page = 1;

			render(<HistoryTab theme={theme} />);
			fireEvent.click(screen.getByText('Previous'));
			expect(mockHistoryReturn.setPage).toHaveBeenCalledWith(0);
		});

		it('calls setPage when Next is clicked', () => {
			mockHistoryReturn.events = [createEvent()];
			mockHistoryReturn.total = 45;
			mockHistoryReturn.totalPages = 3;
			mockHistoryReturn.page = 0;

			render(<HistoryTab theme={theme} />);
			fireEvent.click(screen.getByText('Next'));
			expect(mockHistoryReturn.setPage).toHaveBeenCalledWith(1);
		});

		it('disables Previous on first page', () => {
			mockHistoryReturn.events = [createEvent()];
			mockHistoryReturn.total = 45;
			mockHistoryReturn.totalPages = 3;
			mockHistoryReturn.page = 0;

			render(<HistoryTab theme={theme} />);
			expect(screen.getByText('Previous')).toBeDisabled();
		});

		it('disables Next on last page', () => {
			mockHistoryReturn.events = [createEvent()];
			mockHistoryReturn.total = 45;
			mockHistoryReturn.totalPages = 3;
			mockHistoryReturn.page = 2;

			render(<HistoryTab theme={theme} />);
			expect(screen.getByText('Next')).toBeDisabled();
		});

		it('renders page number buttons', () => {
			mockHistoryReturn.events = [createEvent()];
			mockHistoryReturn.total = 45;
			mockHistoryReturn.totalPages = 3;
			mockHistoryReturn.page = 0;

			render(<HistoryTab theme={theme} />);
			expect(screen.getByText('1')).toBeInTheDocument();
			expect(screen.getByText('2')).toBeInTheDocument();
			expect(screen.getByText('3')).toBeInTheDocument();
		});
	});

	describe('Filter Interactions', () => {
		it('calls setSearchQuery on search input change', () => {
			render(<HistoryTab theme={theme} />);
			fireEvent.change(screen.getByTestId('history-search'), {
				target: { value: 'my query' },
			});
			expect(mockHistoryReturn.setSearchQuery).toHaveBeenCalledWith('my query');
		});

		it('calls setTopologyFilter on topology dropdown change', () => {
			render(<HistoryTab theme={theme} />);
			fireEvent.change(screen.getByTestId('topology-filter'), {
				target: { value: 'pipeline' },
			});
			expect(mockHistoryReturn.setTopologyFilter).toHaveBeenCalledWith('pipeline');
		});

		it('calls setStatusFilter on status dropdown change', () => {
			render(<HistoryTab theme={theme} />);
			fireEvent.change(screen.getByTestId('status-filter'), {
				target: { value: 'failed' },
			});
			expect(mockHistoryReturn.setStatusFilter).toHaveBeenCalledWith('failed');
		});

		it('clears topology filter when "All Topologies" selected', () => {
			mockHistoryReturn.topologyFilter = 'hub-spoke';
			render(<HistoryTab theme={theme} />);
			fireEvent.change(screen.getByTestId('topology-filter'), {
				target: { value: '' },
			});
			expect(mockHistoryReturn.setTopologyFilter).toHaveBeenCalledWith(undefined);
		});
	});

	describe('Theme Styling', () => {
		it('applies theme colors to search bar', () => {
			render(<HistoryTab theme={theme} />);
			const search = screen.getByTestId('history-search');
			expect(search).toHaveStyle({
				backgroundColor: theme.colors.bgActivity,
				borderColor: theme.colors.border,
				color: theme.colors.textMain,
			});
		});

		it('applies theme colors to filter dropdowns', () => {
			render(<HistoryTab theme={theme} />);
			const topology = screen.getByTestId('topology-filter');
			expect(topology).toHaveStyle({
				backgroundColor: theme.colors.bgActivity,
				borderColor: theme.colors.border,
			});
		});
	});

	describe('Export Buttons', () => {
		it('renders export JSON and CSV buttons', () => {
			render(<HistoryTab theme={theme} />);
			expect(screen.getByTestId('export-json-btn')).toBeInTheDocument();
			expect(screen.getByTestId('export-csv-btn')).toBeInTheDocument();
		});

		it('calls exportJson IPC when JSON button clicked', async () => {
			render(<HistoryTab theme={theme} />);
			fireEvent.click(screen.getByTestId('export-json-btn'));
			expect(mockExportJson).toHaveBeenCalledWith('all');
		});

		it('calls exportCsv IPC when CSV button clicked', async () => {
			render(<HistoryTab theme={theme} />);
			fireEvent.click(screen.getByTestId('export-csv-btn'));
			expect(mockExportCsv).toHaveBeenCalledWith('all');
		});
	});

	describe('Expanded Detail', () => {
		it('shows participant breakdown when row is expanded', async () => {
			const event = createEvent({
				id: 'evt-detail',
				participantBreakdown: [
					{
						name: 'Agent Alpha',
						agentId: 'claude-code',
						tokenCount: 5000,
						messageCount: 10,
						processingTimeMs: 30000,
						cost: 0.15,
					},
					{
						name: 'Agent Beta',
						agentId: 'codex',
						tokenCount: 3000,
						messageCount: 5,
						processingTimeMs: 20000,
						cost: 0.1,
					},
				],
			});
			mockHistoryReturn.events = [event];
			mockHistoryReturn.total = 1;
			mockHistoryReturn.totalPages = 1;
			mockGroupChatList.mockResolvedValue([]);

			render(<HistoryTab theme={theme} />);
			fireEvent.click(screen.getByTestId('history-row-evt-detail'));

			expect(screen.getByText('Participant Breakdown')).toBeInTheDocument();
			expect(screen.getByText('Agent Alpha')).toBeInTheDocument();
			expect(screen.getByText('Agent Beta')).toBeInTheDocument();
		});

		it('shows execution summary with moderator and topology', async () => {
			const event = createEvent({
				id: 'evt-summary',
				moderatorAgentId: 'claude-code',
				topologyPattern: 'pipeline',
				terminationMode: 'max-iterations',
			});
			mockHistoryReturn.events = [event];
			mockHistoryReturn.total = 1;
			mockHistoryReturn.totalPages = 1;
			mockGroupChatList.mockResolvedValue([]);

			render(<HistoryTab theme={theme} />);
			fireEvent.click(screen.getByTestId('history-row-evt-summary'));

			expect(screen.getByText('Execution Summary')).toBeInTheDocument();
			expect(screen.getByText('claude-code')).toBeInTheDocument();
			expect(screen.getByText('max-iterations')).toBeInTheDocument();
		});

		it('sorts participants by tokens descending', async () => {
			const event = createEvent({
				id: 'evt-sort',
				participantBreakdown: [
					{
						name: 'Low Tokens',
						agentId: 'codex',
						tokenCount: 1000,
						messageCount: 2,
						processingTimeMs: 5000,
						cost: 0.05,
					},
					{
						name: 'High Tokens',
						agentId: 'claude-code',
						tokenCount: 9000,
						messageCount: 15,
						processingTimeMs: 45000,
						cost: 0.3,
					},
				],
			});
			mockHistoryReturn.events = [event];
			mockHistoryReturn.total = 1;
			mockHistoryReturn.totalPages = 1;
			mockGroupChatList.mockResolvedValue([]);

			render(<HistoryTab theme={theme} />);
			fireEvent.click(screen.getByTestId('history-row-evt-sort'));

			// "High Tokens" should appear before "Low Tokens" in the DOM
			// The participant breakdown has a thead + tbody; select only tbody rows
			const detailEl = screen.getByTestId('history-detail-evt-sort');
			const tbody = detailEl.querySelector('tbody');
			const rows = tbody!.querySelectorAll('tr');
			expect(rows[0]).toHaveTextContent('High Tokens');
			expect(rows[1]).toHaveTextContent('Low Tokens');
		});

		it('shows execution log unavailable when chat does not exist', async () => {
			const event = createEvent({ id: 'evt-nolog', groupChatId: 'gc-gone' });
			mockHistoryReturn.events = [event];
			mockHistoryReturn.total = 1;
			mockHistoryReturn.totalPages = 1;
			mockGroupChatList.mockResolvedValue([{ id: 'gc-other' }]);

			render(<HistoryTab theme={theme} />);
			fireEvent.click(screen.getByTestId('history-row-evt-nolog'));

			// Wait for the async effect to complete
			const unavailable = await screen.findByText('Execution log unavailable');
			expect(unavailable).toBeInTheDocument();
		});

		it('accordion behavior — expanding one row collapses another', () => {
			const event1 = createEvent({ id: 'evt-a', groupChatName: 'Chat A' });
			const event2 = createEvent({ id: 'evt-b', groupChatName: 'Chat B' });
			mockHistoryReturn.events = [event1, event2];
			mockHistoryReturn.total = 2;
			mockHistoryReturn.totalPages = 1;
			mockGroupChatList.mockResolvedValue([]);

			render(<HistoryTab theme={theme} />);

			// Expand first row
			fireEvent.click(screen.getByTestId('history-row-evt-a'));
			expect(screen.getByTestId('history-detail-evt-a')).toBeInTheDocument();

			// Expand second row — first should collapse
			fireEvent.click(screen.getByTestId('history-row-evt-b'));
			expect(screen.queryByTestId('history-detail-evt-a')).not.toBeInTheDocument();
			expect(screen.getByTestId('history-detail-evt-b')).toBeInTheDocument();
		});
	});
});
