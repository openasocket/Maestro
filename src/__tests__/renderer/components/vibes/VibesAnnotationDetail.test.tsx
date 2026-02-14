import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { VibesAnnotationDetail } from '../../../../renderer/components/vibes/VibesAnnotationDetail';
import type { Theme } from '../../../../renderer/types';
import type { VibesAnnotation, VibesManifest } from '../../../../shared/vibes-types';

// Mock lucide-react
vi.mock('lucide-react', () => ({
	Terminal: () => <span data-testid="icon-terminal">Terminal</span>,
	MessageSquare: () => <span data-testid="icon-message">Message</span>,
	Brain: () => <span data-testid="icon-brain">Brain</span>,
	FileCode: () => <span data-testid="icon-file-code">FileCode</span>,
	Copy: () => <span data-testid="icon-copy">Copy</span>,
	CheckCircle2: () => <span data-testid="icon-check">Check</span>,
	Loader2: () => <span data-testid="icon-loader">Loader</span>,
}));

const mockTheme: Theme = {
	id: 'dracula',
	name: 'Dracula',
	mode: 'dark',
	colors: {
		bgMain: '#282a36',
		bgSidebar: '#21222c',
		bgActivity: '#1e1f29',
		border: '#44475a',
		textMain: '#f8f8f2',
		textDim: '#6272a4',
		accent: '#bd93f9',
		accentDim: 'rgba(189, 147, 249, 0.2)',
		accentText: '#bd93f9',
		accentForeground: '#f8f8f2',
		success: '#50fa7b',
		warning: '#f1fa8c',
		error: '#ff5555',
	},
};

const validAnnotation: Exclude<VibesAnnotation, { type: 'session' }> = {
	type: 'line',
	file_path: 'src/utils/helpers.ts',
	line_start: 10,
	line_end: 25,
	environment_hash: 'abc123def456ghi789jkl012',
	command_hash: 'cmd-def456',
	prompt_hash: 'prm-ghi789',
	action: 'create',
	timestamp: new Date().toISOString(),
	session_id: 'session-001',
	assurance_level: 'medium',
};

describe('VibesAnnotationDetail', () => {
	it('renders detail panel for valid annotation', () => {
		render(
			<VibesAnnotationDetail
				theme={mockTheme}
				annotation={validAnnotation}
				manifest={null}
				isLoadingManifest={false}
				onClose={vi.fn()}
			/>,
		);

		expect(screen.getByTestId('annotation-detail-panel')).toBeTruthy();
		expect(screen.getByText('Provenance Details')).toBeTruthy();
	});

	it('renders incomplete data message when environment_hash is missing', () => {
		const incomplete = {
			...validAnnotation,
			environment_hash: undefined,
		} as unknown as Exclude<VibesAnnotation, { type: 'session' }>;

		render(
			<VibesAnnotationDetail
				theme={mockTheme}
				annotation={incomplete}
				manifest={null}
				isLoadingManifest={false}
				onClose={vi.fn()}
			/>,
		);

		expect(screen.getByText(/Annotation data is incomplete/)).toBeTruthy();
		expect(screen.queryByTestId('annotation-detail-panel')).toBeNull();
	});

	it('renders incomplete data message when timestamp is missing', () => {
		const incomplete = {
			...validAnnotation,
			timestamp: undefined,
		} as unknown as Exclude<VibesAnnotation, { type: 'session' }>;

		render(
			<VibesAnnotationDetail
				theme={mockTheme}
				annotation={incomplete}
				manifest={null}
				isLoadingManifest={false}
				onClose={vi.fn()}
			/>,
		);

		expect(screen.getByText(/Annotation data is incomplete/)).toBeTruthy();
	});

	it('renders environment data from manifest when available', () => {
		const manifest: VibesManifest = {
			entries: {
				[validAnnotation.environment_hash]: {
					type: 'environment',
					created_at: new Date().toISOString(),
					tool_name: 'claude-code',
					tool_version: '1.0.0',
					model_name: 'claude-3',
					model_version: 'opus',
				},
			},
		};

		render(
			<VibesAnnotationDetail
				theme={mockTheme}
				annotation={validAnnotation}
				manifest={manifest}
				isLoadingManifest={false}
				onClose={vi.fn()}
			/>,
		);

		expect(screen.getByText('claude-code 1.0.0')).toBeTruthy();
		expect(screen.getByText('claude-3 opus')).toBeTruthy();
	});

	it('handles environment entries with missing tool_version gracefully', () => {
		const manifest: VibesManifest = {
			entries: {
				[validAnnotation.environment_hash]: {
					type: 'environment',
					created_at: new Date().toISOString(),
					tool_name: 'claude-code',
					tool_version: undefined as unknown as string,
					model_name: 'claude-3',
					model_version: undefined as unknown as string,
				},
			},
		};

		render(
			<VibesAnnotationDetail
				theme={mockTheme}
				annotation={validAnnotation}
				manifest={manifest}
				isLoadingManifest={false}
				onClose={vi.fn()}
			/>,
		);

		// Should render tool_name without trailing space (trimmed)
		expect(screen.getByText('claude-code')).toBeTruthy();
		expect(screen.getByText('claude-3')).toBeTruthy();
	});

	it('shows loading state when manifest is loading', () => {
		render(
			<VibesAnnotationDetail
				theme={mockTheme}
				annotation={validAnnotation}
				manifest={null}
				isLoadingManifest={true}
				onClose={vi.fn()}
			/>,
		);

		expect(screen.getByText('Loading manifest...')).toBeTruthy();
	});

	it('renders hash row with truncated hash value', () => {
		render(
			<VibesAnnotationDetail
				theme={mockTheme}
				annotation={validAnnotation}
				manifest={null}
				isLoadingManifest={false}
				onClose={vi.fn()}
			/>,
		);

		// environment_hash 'abc123def456ghi789jkl012' sliced to 16 chars = 'abc123def456ghi7'
		expect(screen.getByText('abc123def456ghi7...')).toBeTruthy();
	});
});
