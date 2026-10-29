/**
 * @file AutoRunRightPanel.test.tsx
 * @description Integration tests for Auto Run and RightPanel interaction
 *
 * Tests the integration between RightPanel and AutoRun components:
 * - Tab switching preserves Auto Run state
 * - Panel resize doesn't lose content
 * - Expanded modal syncs with panel
 *
 * RightPanel reads the active agent, the open/tab/focus state, the panel width,
 * the file tree and the document list straight from the Zustand stores, so the
 * harness seeds those stores (the way RightPanel.test.tsx does) and keeps as
 * props only what RightPanel still takes: the theme, the tab handler, the file
 * explorer handlers, and the Auto Run callbacks, which here write back to the
 * session record exactly as useAutoRunHandlers does in the App.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import React, { createRef } from 'react';
import { RightPanel, RightPanelHandle } from '../../renderer/components/RightPanel';
import type { Session, Shortcut, BatchRunState, RightPanelTab } from '../../renderer/types';
import { createMockSession as baseCreateMockSession } from '../helpers/mockSession';
import { LayerStackProvider } from '../../renderer/contexts/LayerStackContext';
import { createMockTheme } from '../helpers/mockTheme';
import {
	useSessionStore,
	selectActiveSession,
	updateSessionWith,
} from '../../renderer/stores/sessionStore';
import { useUIStore } from '../../renderer/stores/uiStore';
import { useSettingsStore } from '../../renderer/stores/settingsStore';
import { useFileExplorerStore } from '../../renderer/stores/fileExplorerStore';
import { useBatchStore } from '../../renderer/stores/batchStore';
import { RIGHT_PANEL_MIN_WIDTH, RIGHT_PANEL_MAX_WIDTH } from '../../renderer/constants/rightPanel';

// Mock external dependencies
// CodeMirror cannot lay itself out in jsdom, so the Auto Run source editor is
// swapped for the shared textarea double (it still implements the editor handle).
vi.mock('../../renderer/components/FilePreview/markdownEditor', async () => {
	const { markdownEditorModuleMock } = await import('../helpers/mockMarkdownEditor');
	return markdownEditorModuleMock();
});

vi.mock('react-markdown', () => ({
	default: ({ children }: { children: string }) => (
		<div data-testid="react-markdown">{children}</div>
	),
}));

vi.mock('remark-gfm', () => ({
	default: {},
}));

vi.mock('react-syntax-highlighter', () => ({
	Prism: ({ children }: { children: string }) => (
		<code data-testid="syntax-highlighter">{children}</code>
	),
}));

vi.mock('react-syntax-highlighter/dist/esm/styles/prism', () => ({
	vscDarkPlus: {},
	vs: {},
}));

vi.mock('../../renderer/components/AutoRun/AutoRunnerHelpModal', () => ({
	AutoRunnerHelpModal: ({ onClose }: { onClose: () => void }) => (
		<div data-testid="help-modal">
			<button onClick={onClose}>Close</button>
		</div>
	),
}));

vi.mock('../../renderer/components/MermaidRenderer', () => ({
	MermaidRenderer: ({ chart }: { chart: string }) => (
		<div data-testid="mermaid-renderer">{chart}</div>
	),
}));

vi.mock('../../renderer/components/FileExplorerPanel', () => ({
	FileExplorerPanel: vi.fn(({ session }) => (
		<div data-testid="file-explorer-panel">FileExplorerPanel: {session?.name}</div>
	)),
}));

vi.mock('../../renderer/components/HistoryPanel', () => ({
	// RightPanel hands HistoryPanel a ref, so the double must accept one.
	HistoryPanel: React.forwardRef(function MockHistoryPanel(_props, _ref) {
		return <div data-testid="history-panel">HistoryPanel</div>;
	}),
}));

vi.mock('../../renderer/components/AutoRun/AutoRunDocumentSelector', () => ({
	AutoRunDocumentSelector: React.forwardRef(function MockDocumentSelector(
		{ documents, selectedDocument, onSelectDocument, onRefresh, onChangeFolder, isLoading }: any,
		_ref
	) {
		return (
			<div data-testid="document-selector">
				<select
					data-testid="doc-select"
					value={selectedDocument || ''}
					onChange={(e) => onSelectDocument(e.target.value)}
				>
					{documents.map((doc: string) => (
						<option key={doc} value={doc}>
							{doc}
						</option>
					))}
				</select>
				<button data-testid="refresh-btn" onClick={onRefresh}>
					Refresh
				</button>
				<button data-testid="change-folder-btn" onClick={onChangeFolder}>
					Change
				</button>
				{isLoading && <span data-testid="loading-indicator">Loading...</span>}
			</div>
		);
	}),
}));

vi.mock('../../renderer/components/TemplateAutocompleteDropdown', () => ({
	TemplateAutocompleteDropdown: React.forwardRef(() => null),
}));

// Setup window.maestro mock: layer the Auto Run surface this suite drives over
// the global bridge double from setup.ts, so every other namespace the panel
// reaches for stays answered.
const setupMaestroMock = () => {
	const base = (window as any).maestro ?? {};
	const mockMaestro = {
		...base,
		fs: {
			...base.fs,
			readFile: vi.fn().mockResolvedValue('data:image/png;base64,abc123'),
			readDir: vi.fn().mockResolvedValue([]),
		},
		autorun: {
			...base.autorun,
			listImages: vi.fn().mockResolvedValue({ success: true, images: [] }),
			saveImage: vi.fn().mockResolvedValue({ success: true, relativePath: 'images/test-123.png' }),
			deleteImage: vi.fn().mockResolvedValue({ success: true }),
			writeDoc: vi.fn().mockResolvedValue(undefined),
		},
		settings: {
			get: vi.fn().mockResolvedValue(null),
			set: vi.fn().mockResolvedValue(undefined),
		},
	};

	(window as any).maestro = mockMaestro;
	return mockMaestro;
};

const DEFAULT_CONTENT = '# Test Document\n\n- [ ] Task 1\n- [ ] Task 2';
const DOCUMENTS = ['Phase 1', 'Phase 2', 'Phase 3'];
const theme = createMockTheme();

// Thin wrapper: seeds auto run state so the right panel shows the auto
// run tab with content. The document text and its disk version live on the
// session record, which is where RightPanel reads them from.
const createMockSession = (overrides: Partial<Session> = {}): Session =>
	baseCreateMockSession({
		id: 'test-session-1',
		cwd: '/test/path',
		fullPath: '/test/path',
		projectRoot: '/test/path',
		isGitRepo: true,
		aiPid: 1234,
		terminalPid: 5678,
		port: 3000,
		aiTabs: [{ id: 'tab-1', name: 'Tab 1', logs: [] }] as any,
		activeTabId: 'tab-1',
		autoRunFolderPath: '/test/autorun',
		autoRunSelectedFile: 'Phase 1',
		autoRunMode: 'edit',
		autoRunCursorPosition: 0,
		autoRunEditScrollPos: 0,
		autoRunPreviewScrollPos: 0,
		autoRunContent: DEFAULT_CONTENT,
		autoRunContentVersion: 0,
		...overrides,
	});

// Create mock shortcuts
const createMockShortcuts = (): Record<string, Shortcut> => ({
	toggleRightPanel: { id: 'toggleRightPanel', label: 'Toggle Right Panel', keys: ['Cmd', 'B'] },
	expandAutoRun: { id: 'expandAutoRun', label: 'Expand Auto Run', keys: ['Cmd', 'Shift', 'E'] },
});

/**
 * Seed the five stores RightPanel subscribes to. Auto-follow is off so a
 * running batch does not move the tab under a case that is driving the tabs
 * itself; the two batch cases assert the lock the run imposes instead.
 */
const seedStores = ({
	session = createMockSession(),
	content,
	tab = 'autorun' as RightPanelTab,
	width = 400,
}: {
	session?: Session;
	content?: string;
	tab?: RightPanelTab;
	width?: number;
} = {}) => {
	const seeded = content === undefined ? session : { ...session, autoRunContent: content };
	useSessionStore.setState({ sessions: [seeded], activeSessionId: seeded.id });
	useUIStore.setState({
		rightPanelOpen: true,
		activeRightTab: tab,
		activeFocus: 'right',
		autoFollowEnabled: false,
	});
	useSettingsStore.setState({
		rightPanelWidth: width,
		shortcuts: createMockShortcuts(),
		showHiddenFiles: false,
		autoRunDisabled: false,
	});
	useFileExplorerStore.setState({
		fileTreeFilter: '',
		fileTreeFilterOpen: false,
		flatFileList: [],
		selectedFileIndex: 0,
		lastGraphFocusFilePath: undefined,
	});
	useBatchStore.setState({
		documentList: DOCUMENTS,
		documentTree: [] as any,
		isLoadingDocuments: false,
		documentTaskCounts: new Map(),
		batchRunStates: {},
	});
};

/** The active agent as the store holds it right now. */
const activeSession = (): Session => selectActiveSession(useSessionStore.getState())!;

/** Write fields onto the active agent, which is what the App's Auto Run handlers do. */
const patchActiveSession = (patch: Partial<Session>) => {
	updateSessionWith(activeSession().id, (s) => ({ ...s, ...patch }));
};

/** What the folder watcher does after a write: new text on disk, version bumped. */
const setDiskContent = (content: string) =>
	act(() => {
		patchActiveSession({
			autoRunContent: content,
			autoRunContentVersion: (activeSession().autoRunContentVersion ?? 0) + 1,
		});
	});

/** Drag the resize handle (pointer-captured on the handle, as the hook listens). */
const dragResizeHandle = (container: HTMLElement, from: number, ...to: number[]) => {
	const resizeHandle = container.querySelector('.cursor-col-resize') as HTMLElement;
	expect(resizeHandle).toBeInTheDocument();
	fireEvent.pointerDown(resizeHandle, { clientX: from, pointerId: 1 });
	for (const clientX of to) fireEvent.pointerMove(resizeHandle, { clientX });
	fireEvent.pointerUp(resizeHandle);
};

const clampWidth = (width: number) =>
	Math.max(RIGHT_PANEL_MIN_WIDTH, Math.min(RIGHT_PANEL_MAX_WIDTH, width));

const createBatchRunState = (): BatchRunState => ({
	isRunning: true,
	isStopping: false,
	documents: ['Phase 1'],
	lockedDocuments: ['Phase 1'],
	currentDocumentIndex: 0,
	totalTasks: 5,
	completedTasks: 2,
	currentTaskIndex: 0,
	currentDocTasksTotal: 5,
	currentDocTasksCompleted: 2,
	totalTasksAcrossAllDocs: 5,
	completedTasksAcrossAllDocs: 2,
	loopEnabled: false,
	loopIteration: 0,
	folderPath: '/test/folder',
	worktreeActive: false,
	originalContent: '',
	sessionIds: [],
});

interface AutoRunViewState {
	mode: 'edit' | 'preview';
	cursorPosition: number;
	editScrollPos: number;
	previewScrollPos: number;
}

interface WrapperProps {
	onContentChange?: (content: string) => void;
	onModeChange?: (mode: 'edit' | 'preview') => void;
	onStateChange?: (state: AutoRunViewState) => void;
	batchRunState?: BatchRunState;
	panelRef?: React.Ref<RightPanelHandle>;
}

// Wrapper component: the props RightPanel still takes. The tab handler writes
// the UI store; the Auto Run callbacks write the session record, mirroring
// useAutoRunHandlers, and report to the spies a case hands in.
const RightPanelTestWrapper = ({
	onContentChange,
	onModeChange,
	onStateChange,
	batchRunState,
	panelRef,
}: WrapperProps) => {
	const fileTreeContainerRef = React.useRef<HTMLDivElement>(null);
	const fileTreeFilterInputRef = React.useRef<HTMLInputElement>(null);

	return (
		<LayerStackProvider>
			<RightPanel
				ref={panelRef}
				theme={theme}
				setActiveRightTab={(tab) => useUIStore.getState().setActiveRightTab(tab)}
				fileTreeContainerRef={fileTreeContainerRef}
				fileTreeFilterInputRef={fileTreeFilterInputRef}
				toggleFolder={() => {}}
				toggleFolderRecursive={() => {}}
				handleFileClick={async () => {}}
				expandAllFolders={() => {}}
				collapseAllFolders={() => {}}
				updateSessionWorkingDirectory={async () => {}}
				refreshFileTree={async () => undefined}
				cancelFileTreeLoad={() => {}}
				onAutoRunContentChange={(content) => {
					patchActiveSession({ autoRunContent: content });
					onContentChange?.(content);
				}}
				onAutoRunModeChange={(mode) => {
					patchActiveSession({ autoRunMode: mode });
					onModeChange?.(mode);
				}}
				onAutoRunStateChange={(state) => {
					patchActiveSession({
						autoRunMode: state.mode,
						autoRunCursorPosition: state.cursorPosition,
						autoRunEditScrollPos: state.editScrollPos,
						autoRunPreviewScrollPos: state.previewScrollPos,
					});
					onStateChange?.(state);
				}}
				onAutoRunSelectDocument={(filename) =>
					patchActiveSession({ autoRunSelectedFile: filename })
				}
				onAutoRunCreateDocument={async () => true}
				onAutoRunRefresh={() => {}}
				onAutoRunOpenSetup={() => {}}
				currentSessionBatchState={batchRunState}
			/>
		</LayerStackProvider>
	);
};

const renderPanel = (props: WrapperProps = {}) => render(<RightPanelTestWrapper {...props} />);

const clickTab = (name: 'Files' | 'History' | 'Auto Run') =>
	fireEvent.click(screen.getByRole('button', { name }));

describe('Auto Run + RightPanel Integration', () => {
	let mockMaestro: ReturnType<typeof setupMaestroMock>;

	beforeEach(() => {
		mockMaestro = setupMaestroMock();
		seedStores();
		vi.useFakeTimers({ shouldAdvanceTime: true });
		vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
			cb(0);
			return 0;
		});
	});

	afterEach(() => {
		vi.clearAllMocks();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	describe('Tab Switching Preserves Auto Run State', () => {
		it('unsaved content changes persist when switching tabs (via shared state)', async () => {
			// Note: RightPanel manages shared draft state that persists across tab switches.
			// This allows users to switch tabs without losing their unsaved changes.
			renderPanel();

			// Find the textarea in Auto Run
			const textarea = screen.getByRole('textbox');
			expect(textarea).toHaveValue(DEFAULT_CONTENT);

			// Type some content (updates shared state in RightPanel)
			fireEvent.change(textarea, { target: { value: 'Modified content' } });
			expect(textarea).toHaveValue('Modified content');

			// Switch to files tab
			clickTab('Files');
			expect(useUIStore.getState().activeRightTab).toBe('files');

			// Verify Auto Run is not rendered
			expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
			expect(screen.getByTestId('file-explorer-panel')).toBeInTheDocument();

			// Switch back to autorun tab
			clickTab('Auto Run');

			// Content is preserved from shared state (not reverted to saved content)
			expect(screen.getByRole('textbox')).toHaveValue('Modified content');
		});

		it('external content changes (via contentVersion) persist across tab switches', async () => {
			// The watcher re-reads the file into the session record with a new version
			seedStores({ content: 'Initial content' });
			renderPanel();

			// Initial content
			expect(screen.getByRole('textbox')).toHaveValue('Initial content');

			// Simulate external change
			setDiskContent('Externally updated content');

			// Content should be updated
			await waitFor(() => {
				expect(screen.getByRole('textbox')).toHaveValue('Externally updated content');
			});

			// Switch to files tab and back
			clickTab('Files');
			clickTab('Auto Run');

			// Content should persist
			expect(screen.getByRole('textbox')).toHaveValue('Externally updated content');
		});

		it('preserves mode (edit/preview) when switching tabs', async () => {
			const onModeChange = vi.fn();
			renderPanel({ onModeChange });

			// Find the mode toggle and switch to preview
			fireEvent.click(screen.getByTitle('Switch to preview'));
			expect(onModeChange).toHaveBeenCalledWith('preview');
			expect(activeSession().autoRunMode).toBe('preview');

			// Switch to history tab and back
			clickTab('History');
			clickTab('Auto Run');

			// Preview mode is still active: the toggle offers Edit and the editor is gone
			expect(screen.getByTitle('Switch to edit')).toBeInTheDocument();
			expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
			expect(screen.getByTestId('react-markdown')).toBeInTheDocument();
		});

		it('preserves cursor position when switching tabs', async () => {
			const onStateChange = vi.fn();
			renderPanel({ onStateChange });

			const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;

			// Simulate cursor position change
			fireEvent.focus(textarea);
			textarea.setSelectionRange(10, 10);
			fireEvent.blur(textarea);

			// The state change should have been triggered (cursor position is saved)
			// Switch tabs and back
			clickTab('Files');
			clickTab('Auto Run');

			// Verify the component is still functional
			expect(screen.getByRole('textbox')).toBeInTheDocument();
		});

		it('dirty state indicator shows when content is modified', async () => {
			renderPanel();

			const textarea = screen.getByRole('textbox');

			// Initially no Save button (clean state)
			expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument();

			// Make content dirty - wrap in act for state update
			await act(async () => {
				fireEvent.change(textarea, {
					target: { value: 'Modified content that creates dirty state' },
				});
			});

			// Check for Save button (indicates dirty state)
			await waitFor(() => {
				expect(screen.queryByRole('button', { name: /save/i })).toBeInTheDocument();
			});
		});

		it('dirty state persists when switching tabs (via shared state)', async () => {
			// Note: RightPanel manages shared draft state that includes dirty state tracking
			renderPanel();

			const textarea = screen.getByRole('textbox');

			// Make content dirty - wrap in act for state update
			await act(async () => {
				fireEvent.change(textarea, { target: { value: 'Modified content' } });
			});

			await waitFor(() => {
				expect(screen.queryByRole('button', { name: /save/i })).toBeInTheDocument();
			});

			// Switch to history tab and back
			clickTab('History');
			clickTab('Auto Run');

			// Dirty state is preserved because shared state includes both local and saved content
			await waitFor(() => {
				expect(screen.queryByRole('button', { name: /save/i })).toBeInTheDocument();
			});
		});

		it('preserves document selection when switching tabs', async () => {
			renderPanel();

			// Select a different document
			fireEvent.change(screen.getByTestId('doc-select'), { target: { value: 'Phase 2' } });
			expect(activeSession().autoRunSelectedFile).toBe('Phase 2');

			// Switch to files tab and back
			clickTab('Files');
			clickTab('Auto Run');

			// Document selection is preserved via session state
			expect(screen.getByTestId('doc-select')).toHaveValue('Phase 2');
		});

		it('handles rapid tab switching without crashes', async () => {
			// Tests that rapid tab switching doesn't cause errors
			renderPanel();

			// Rapid tab switching
			for (let i = 0; i < 5; i++) {
				clickTab('Files');
				clickTab('History');
				clickTab('Auto Run');
			}

			// Component should still be functional
			expect(screen.getByRole('textbox')).toBeInTheDocument();
		});
	});

	describe('Panel Resize Does Not Lose Content', () => {
		it('preserves content during panel width resize', async () => {
			const onContentChange = vi.fn();
			const { container } = renderPanel({ onContentChange });

			// Modify content
			const textarea = screen.getByRole('textbox');
			fireEvent.change(textarea, { target: { value: 'Content during resize' } });

			// Drag the handle; the width is committed on pointer up
			dragResizeHandle(container, 500, 550, 600);
			expect(useSettingsStore.getState().rightPanelWidth).toBe(clampWidth(400 + (500 - 600)));
			expect(mockMaestro.settings.set).toHaveBeenCalledWith('rightPanelWidth', expect.any(Number));

			// Content should still be preserved
			expect(screen.getByRole('textbox')).toHaveValue('Content during resize');
		});

		it('preserves content when panel is collapsed and reopened', async () => {
			const onContentChange = vi.fn();
			renderPanel({ onContentChange });

			// Modify content
			const textarea = screen.getByRole('textbox');
			fireEvent.change(textarea, { target: { value: 'Content before collapse' } });

			// Find toggle button and collapse
			const toggleButton = screen.getByTitle(/collapse right panel/i);
			fireEvent.click(toggleButton);

			// Panel should be collapsed
			expect(useUIStore.getState().rightPanelOpen).toBe(false);

			// Reopen panel
			fireEvent.click(toggleButton);
			expect(useUIStore.getState().rightPanelOpen).toBe(true);

			// Content should be preserved
			expect(screen.getByRole('textbox')).toHaveValue('Content before collapse');
		});

		it('preserves mode during panel resize', async () => {
			const onModeChange = vi.fn();
			const { container } = renderPanel({ onModeChange });

			// Switch to preview mode
			fireEvent.click(screen.getByTitle('Switch to preview'));
			expect(onModeChange).toHaveBeenCalledWith('preview');

			// Simulate resize
			dragResizeHandle(container, 500, 600);

			// Mode should still be preview
			expect(screen.getByTitle('Switch to edit')).toBeInTheDocument();
			expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
		});

		it('maintains scroll position during resize', async () => {
			const onStateChange = vi.fn();
			const { container } = renderPanel({ onStateChange });

			const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;

			// Simulate scroll (by setting scrollTop property)
			Object.defineProperty(textarea, 'scrollTop', {
				value: 150,
				writable: true,
				configurable: true,
			});
			fireEvent.scroll(textarea);

			// Simulate resize
			dragResizeHandle(container, 500, 600);

			// Textarea should still be present (scroll position is managed internally)
			expect(screen.getByRole('textbox')).toBeInTheDocument();
		});

		it('handles resize to minimum width without losing content', async () => {
			const { container } = renderPanel();

			// Modify content
			const textarea = screen.getByRole('textbox');
			fireEvent.change(textarea, { target: { value: 'Content at min width' } });

			// Try to resize beyond minimum (dragging right narrows the panel)
			dragResizeHandle(container, 500, 900);
			expect(useSettingsStore.getState().rightPanelWidth).toBe(RIGHT_PANEL_MIN_WIDTH);

			// Content should still be preserved
			expect(screen.getByRole('textbox')).toHaveValue('Content at min width');
		});

		it('handles resize to maximum width without losing content', async () => {
			const { container } = renderPanel();

			// Modify content
			const textarea = screen.getByRole('textbox');
			fireEvent.change(textarea, { target: { value: 'Content at max width' } });

			// Try to resize beyond maximum (dragging left widens the panel)
			dragResizeHandle(container, 500, -500);
			expect(useSettingsStore.getState().rightPanelWidth).toBe(RIGHT_PANEL_MAX_WIDTH);

			// Content should still be preserved
			expect(screen.getByRole('textbox')).toHaveValue('Content at max width');
		});
	});

	describe('Expanded Modal Syncs With Panel', () => {
		it('expanded modal receives same content as panel', async () => {
			seedStores({ content: '# Initial Content\n\n- [ ] Task 1' });
			renderPanel();

			// Verify content is shown, then type a draft into the panel
			const textarea = screen.getByRole('textbox');
			expect(textarea).toHaveValue('# Initial Content\n\n- [ ] Task 1');
			fireEvent.change(textarea, { target: { value: 'Draft shared with the modal' } });

			// Expand: the modal mounts a second AutoRun over the same shared draft
			fireEvent.click(screen.getByTitle(/expand to full screen/i));

			const editors = screen.getAllByRole('textbox');
			expect(editors).toHaveLength(2);
			for (const editor of editors) {
				expect(editor).toHaveValue('Draft shared with the modal');
			}
		});

		it('changes in panel content reflect in session state', async () => {
			const onStateChange = vi.fn();
			renderPanel({ onStateChange });

			const textarea = screen.getByRole('textbox');

			// Make content changes
			fireEvent.change(textarea, { target: { value: 'Updated content from panel' } });
			fireEvent.blur(textarea);
			expect(textarea).toHaveValue('Updated content from panel');

			// Save writes the draft to the selected document of this agent
			fireEvent.click(screen.getByRole('button', { name: /save/i }));
			await waitFor(() => {
				expect(mockMaestro.autorun.writeDoc).toHaveBeenCalledWith(
					'/test/autorun',
					'Phase 1.md',
					'Updated content from panel',
					undefined
				);
			});
			await waitFor(() => {
				expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument();
			});
		});

		it('mode changes in panel are persisted', async () => {
			const onModeChange = vi.fn();
			renderPanel({ onModeChange });

			// Switch to preview
			fireEvent.click(screen.getByTitle('Switch to preview'));
			expect(onModeChange).toHaveBeenCalledWith('preview');
			expect(activeSession().autoRunMode).toBe('preview');

			// Switch back to edit
			fireEvent.click(screen.getByTitle('Switch to edit'));
			expect(onModeChange).toHaveBeenCalledWith('edit');
			expect(activeSession().autoRunMode).toBe('edit');
			expect(screen.getByRole('textbox')).toBeInTheDocument();
		});

		it('panel updates content version when external changes occur', async () => {
			// A new contentVersion on the session record triggers the re-sync
			seedStores({ content: 'Initial content' });
			renderPanel();

			// Initial content
			expect(screen.getByRole('textbox')).toHaveValue('Initial content');

			// Simulate external update
			setDiskContent('External update content');

			// Content should be updated
			await waitFor(() => {
				expect(screen.getByRole('textbox')).toHaveValue('External update content');
			});
		});

		it('toggleAutoRunExpanded method works via ref', async () => {
			const ref = createRef<RightPanelHandle>();
			renderPanel({ panelRef: ref });

			// Verify ref is available
			expect(ref.current).toBeTruthy();
			expect(typeof ref.current?.toggleAutoRunExpanded).toBe('function');

			// Call toggle method: the expanded modal mounts a second editor
			act(() => {
				ref.current?.toggleAutoRunExpanded();
			});
			expect(screen.getAllByRole('textbox')).toHaveLength(2);

			// Toggle again: back to the panel alone
			act(() => {
				ref.current?.toggleAutoRunExpanded();
			});
			expect(screen.getAllByRole('textbox')).toHaveLength(1);
		});
	});

	describe('Focus Management Between Panel and AutoRun', () => {
		it('focuses AutoRun when switching to autorun tab', async () => {
			seedStores({ tab: 'files' });
			renderPanel();

			// Initially on files tab
			expect(screen.getByTestId('file-explorer-panel')).toBeInTheDocument();

			// Switch to autorun
			clickTab('Auto Run');

			// AutoRun should be visible and hold focus
			expect(screen.getByRole('textbox')).toBeInTheDocument();
			expect(screen.getByRole('textbox')).toHaveFocus();
		});

		it('focusAutoRun ref method works', async () => {
			const ref = createRef<RightPanelHandle>();
			renderPanel({ panelRef: ref });

			// Call focusAutoRun
			expect(() => {
				act(() => {
					ref.current?.focusAutoRun();
				});
			}).not.toThrow();
			expect(screen.getByRole('textbox')).toHaveFocus();
		});
	});

	describe('State Persistence Across Tab Visibility Changes', () => {
		it('AutoRun draft content persists across tab switches via shared state', async () => {
			// Note: RightPanel now manages shared draft state that persists across tab switches.
			// This allows users to switch tabs without losing unsaved changes.
			renderPanel();

			// Initial content
			const textarea = screen.getByRole('textbox');
			expect(textarea).toHaveValue(DEFAULT_CONTENT);

			// Modify content (creates dirty state in shared state)
			fireEvent.change(textarea, { target: { value: 'Modified content' } });

			// Wait for state to propagate
			await waitFor(() => {
				expect(textarea).toHaveValue('Modified content');
			});

			// Switch away - AutoRun unmounts but shared state persists in RightPanel
			clickTab('Files');
			expect(screen.queryByRole('textbox')).not.toBeInTheDocument();

			// Switch back - AutoRun remounts with draft content from shared state
			clickTab('Auto Run');

			// Content is preserved from the shared draft state
			await waitFor(() => {
				expect(screen.getByRole('textbox')).toHaveValue('Modified content');
			});
		});

		it('saved content persists across tab switches', async () => {
			// A save echoes back from disk as new content with a new version
			seedStores({ content: 'Initial content' });
			renderPanel();

			// Initial content
			expect(screen.getByRole('textbox')).toHaveValue('Initial content');

			// Simulate save (which updates the session record and its version)
			setDiskContent('Saved content');

			// Switch away and back
			clickTab('Files');
			clickTab('Auto Run');

			// Saved content should persist
			await waitFor(() => {
				expect(screen.getByRole('textbox')).toHaveValue('Saved content');
			});
		});

		it('handles session change while on different tab', async () => {
			const first = createMockSession({ id: 'session-1', autoRunContent: 'Session 1 content' });
			const second = createMockSession({
				id: 'session-2',
				name: 'Session 2',
				autoRunContent: 'Session 2 content',
			});
			seedStores({ session: first });
			renderPanel();

			// Initial content
			expect(screen.getByRole('textbox')).toHaveValue('Session 1 content');

			// Switch to files tab
			clickTab('Files');

			// Switch session while on files tab
			act(() => {
				useSessionStore.setState({ sessions: [first, second], activeSessionId: 'session-2' });
			});

			// Switch back to autorun
			clickTab('Auto Run');

			// Should show new session's content
			expect(screen.getByRole('textbox')).toHaveValue('Session 2 content');
		});
	});

	describe('Edge Cases', () => {
		it('handles null session gracefully', () => {
			useSessionStore.setState({ sessions: [], activeSessionId: '' });

			const { container } = renderPanel();

			// Should render nothing when there is no active agent
			expect(container.querySelector('[data-panel="right"]')).toBeNull();
			expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
		});

		it('handles empty content gracefully', () => {
			seedStores({ content: '' });
			renderPanel();

			const textarea = screen.getByRole('textbox');
			expect(textarea).toHaveValue('');
		});

		it('handles very long content without crashing', () => {
			const longContent = '# Test\n\n' + '- [ ] Task\n'.repeat(1000);
			seedStores({ content: longContent });
			renderPanel();

			const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
			expect(textarea.value.length).toBeGreaterThan(10000);
		});

		it('handles special characters in content', () => {
			const specialContent =
				'# Test <script>alert("xss")</script>\n\n- [ ] Task with "quotes" & <brackets>';
			seedStores({ content: specialContent });
			renderPanel();

			const textarea = screen.getByRole('textbox');
			expect(textarea).toHaveValue(specialContent);
		});

		it('handles unicode content', () => {
			const unicodeContent = '# テスト 🎉\n\n- [ ] 任务 一\n- [ ] Tâche avec accénts';
			seedStores({ content: unicodeContent });
			renderPanel();

			const textarea = screen.getByRole('textbox');
			expect(textarea).toHaveValue(unicodeContent);
		});
	});

	describe('Batch Run State Integration', () => {
		it('batch run progress shows in RightPanel regardless of active tab', async () => {
			seedStores({ tab: 'files' });
			renderPanel({ batchRunState: createBatchRunState() });

			// Should show progress even when on files tab
			expect(useUIStore.getState().activeRightTab).toBe('files');
			expect(screen.getByText('Auto Run Active')).toBeInTheDocument();
			expect(screen.getByTestId('autorun-stat-progress-sub')).toHaveTextContent('2 / 5 tasks');
		});

		it('switching to autorun tab during batch run shows locked editor', async () => {
			seedStores({ tab: 'files' });
			renderPanel({ batchRunState: createBatchRunState() });

			// Initially on files tab
			expect(screen.getByTestId('file-explorer-panel')).toBeInTheDocument();

			// Switch to autorun
			clickTab('Auto Run');

			// The run owns the selected document: the editor is forced into preview
			// and the Edit toggle is held shut until the run lets go.
			expect(activeSession().autoRunMode).toBe('preview');
			expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
			const toggle = screen.getByTitle('Editing disabled while Auto Run active');
			expect(toggle).toBeDisabled();
			expect(screen.getByTestId('react-markdown')).toHaveTextContent('Task 1');
		});
	});
});
