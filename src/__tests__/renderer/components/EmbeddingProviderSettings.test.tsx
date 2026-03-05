/**
 * Tests for EmbeddingProviderSettings component — progress indicator behavior
 *
 * Covers:
 * - Progress bar rendering during download
 * - Spinner during model loading
 * - Success/error toasts
 * - Card disabling during initialization
 * - Progress subscription lifecycle
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, cleanup } from '@testing-library/react';
import { EmbeddingProviderSettings } from '../../../renderer/components/Settings/EmbeddingProviderSettings';
import type { Theme } from '../../../renderer/types';
import type { MemoryConfig } from '../../../shared/memory-types';
import { DEFAULT_EMBEDDING_CONFIG } from '../../../shared/memory-types';

// Track onProgress callbacks for simulating IPC events
let progressCallback: ((event: Record<string, unknown>) => void) | null = null;
const mockUnsubscribe = vi.fn();

// Mock notifyToast
const mockNotifyToast = vi.fn();
vi.mock('../../../renderer/stores/notificationStore', () => ({
	notifyToast: (...args: unknown[]) => mockNotifyToast(...args),
}));

const testTheme: Theme = {
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#1e1e1e',
		bgSidebar: '#252526',
		bgActivity: '#333333',
		textMain: '#d4d4d4',
		textDim: '#808080',
		accent: '#007acc',
		border: '#404040',
		error: '#f14c4c',
		warning: '#cca700',
		success: '#89d185',
		info: '#3794ff',
		textInverse: '#000000',
	},
};

function createMockEmbeddingApi() {
	return {
		getStatus: vi.fn().mockResolvedValue({
			success: true,
			data: { activeProviderId: 'transformers-js', statuses: {} },
		}),
		switchProvider: vi.fn().mockResolvedValue({
			success: true,
			data: { activeProviderId: 'transformers-js' },
		}),
		detectAvailable: vi.fn().mockResolvedValue({
			success: true,
			data: { available: ['transformers-js', 'xenova-onnx'] },
		}),
		getOllamaModels: vi.fn().mockResolvedValue({
			success: true,
			data: { models: [] },
		}),
		checkOllamaConnection: vi.fn().mockResolvedValue({
			success: true,
			data: { connected: false, modelCount: 0 },
		}),
		pullOllamaModel: vi.fn().mockResolvedValue({
			success: true,
			data: { success: true },
		}),
		onProgress: vi.fn().mockImplementation((callback: (event: Record<string, unknown>) => void) => {
			progressCallback = callback;
			return mockUnsubscribe;
		}),
		getUsageSummary: vi.fn().mockResolvedValue({ success: true, data: {} }),
		getUsageTimeline: vi.fn().mockResolvedValue({ success: true, data: [] }),
		hasOpenAIKey: vi.fn().mockResolvedValue({ success: true, data: false }),
		setOpenAIKey: vi.fn().mockResolvedValue({ success: true }),
		clearOpenAIKey: vi.fn().mockResolvedValue({ success: true }),
	};
}

describe('EmbeddingProviderSettings — progress indicator', () => {
	let mockEmbeddingApi: ReturnType<typeof createMockEmbeddingApi>;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers({ shouldAdvanceTime: true });
		progressCallback = null;
		mockEmbeddingApi = createMockEmbeddingApi();

		// Add embedding to the existing window.maestro mock
		(window.maestro as Record<string, unknown>).embedding = mockEmbeddingApi;
	});

	afterEach(() => {
		cleanup();
		vi.useRealTimers();
		delete (window.maestro as Record<string, unknown>).embedding;
	});

	const defaultConfig: MemoryConfig = {
		embeddingProvider: {
			...DEFAULT_EMBEDDING_CONFIG,
			enabled: true,
			providerId: 'transformers-js',
		},
	} as MemoryConfig;

	async function renderComponent(config?: Partial<MemoryConfig>) {
		let result: ReturnType<typeof render>;
		await act(async () => {
			result = render(
				<EmbeddingProviderSettings
					theme={testTheme}
					config={{ ...defaultConfig, ...config }}
					onUpdateConfig={vi.fn()}
				/>
			);
		});
		return result!;
	}

	it('subscribes to onProgress on mount and unsubscribes on unmount', async () => {
		const { unmount } = await renderComponent();

		expect(mockEmbeddingApi.onProgress).toHaveBeenCalledOnce();
		expect(typeof progressCallback).toBe('function');

		unmount();
		expect(mockUnsubscribe).toHaveBeenCalledOnce();
	});

	it('shows progress bar during download', async () => {
		await renderComponent();

		await act(async () => {
			progressCallback!({
				providerId: 'transformers-js',
				modelId: 'Xenova/gte-small',
				progress: 0.45,
				status: 'downloading',
			});
		});

		expect(screen.getByText(/Downloading model.*45%/)).toBeTruthy();
	});

	it('shows spinner during model loading', async () => {
		await renderComponent();

		await act(async () => {
			progressCallback!({
				providerId: 'transformers-js',
				modelId: 'Xenova/gte-small',
				progress: 1.0,
				status: 'loading',
			});
		});

		expect(screen.getByText('Loading model...')).toBeTruthy();
	});

	it('shows success toast when model is ready', async () => {
		await renderComponent();

		await act(async () => {
			progressCallback!({
				providerId: 'transformers-js',
				modelId: 'Xenova/gte-small',
				progress: 1.0,
				status: 'ready',
			});
		});

		expect(mockNotifyToast).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'success',
				title: 'Embedding Provider Ready',
			})
		);
	});

	it('shows error toast on initialization failure', async () => {
		await renderComponent();

		await act(async () => {
			progressCallback!({
				providerId: 'transformers-js',
				modelId: 'Xenova/gte-small',
				progress: 0,
				status: 'error',
				message: 'Download failed: network error',
			});
		});

		expect(mockNotifyToast).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'error',
				title: 'Embedding Provider Error',
				message: 'Download failed: network error',
			})
		);
	});

	it('disables provider cards during downloading progress', async () => {
		await renderComponent();

		await act(async () => {
			progressCallback!({
				providerId: 'transformers-js',
				modelId: 'Xenova/gte-small',
				progress: 0.3,
				status: 'downloading',
			});
		});

		const buttons = screen.getAllByRole('button');
		// The 4 provider card buttons should all be disabled
		const providerButtons = buttons.filter(
			(btn) => btn.textContent?.includes('Local') || btn.textContent?.includes('Cloud')
		);
		expect(providerButtons.length).toBe(4);
		for (const btn of providerButtons) {
			expect(btn).toBeDisabled();
		}
	});

	it('re-enables provider cards after ready', async () => {
		await renderComponent();

		// First, start downloading (disables cards)
		await act(async () => {
			progressCallback!({
				providerId: 'transformers-js',
				modelId: 'Xenova/gte-small',
				progress: 0.5,
				status: 'downloading',
			});
		});

		// Then, mark ready (re-enables cards)
		await act(async () => {
			progressCallback!({
				providerId: 'transformers-js',
				modelId: 'Xenova/gte-small',
				progress: 1.0,
				status: 'ready',
			});
		});

		const buttons = screen.getAllByRole('button');
		const providerButtons = buttons.filter(
			(btn) => btn.textContent?.includes('Local') || btn.textContent?.includes('Cloud')
		);
		for (const btn of providerButtons) {
			expect(btn).not.toBeDisabled();
		}
	});

	it('shows check-circle icon when status is ready', async () => {
		await renderComponent();

		await act(async () => {
			progressCallback!({
				providerId: 'transformers-js',
				modelId: 'Xenova/gte-small',
				progress: 1.0,
				status: 'ready',
			});
		});

		expect(screen.getByText('Model ready')).toBeTruthy();
	});

	it('shows error state in progress area', async () => {
		await renderComponent();

		await act(async () => {
			progressCallback!({
				providerId: 'transformers-js',
				modelId: 'Xenova/gte-small',
				progress: 0,
				status: 'error',
				message: 'Model not found',
			});
		});

		expect(screen.getByText('Model not found')).toBeTruthy();
	});
});
