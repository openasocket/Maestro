/**
 * Tests for embedding IPC handler utilities — sanitizeConfig and API key security.
 */

import { describe, it, expect } from 'vitest';
import { sanitizeConfig } from '../../../../main/ipc/handlers/embedding';
import type { EmbeddingProviderConfig } from '../../../../shared/memory-types';
import { DEFAULT_EMBEDDING_CONFIG } from '../../../../shared/memory-types';

describe('sanitizeConfig', () => {
	it('should mask apiKey with *** when present', () => {
		const config: EmbeddingProviderConfig = {
			...DEFAULT_EMBEDDING_CONFIG,
			providerId: 'openai',
			enabled: true,
			openai: {
				apiKey: 'sk-secret-key-12345',
				model: 'text-embedding-3-small',
				dimensions: 384,
				baseUrl: 'https://api.openai.com/v1',
			},
		};

		const sanitized = sanitizeConfig(config);
		expect(sanitized.openai?.apiKey).toBe('***');
		// Other fields preserved
		expect(sanitized.openai?.model).toBe('text-embedding-3-small');
		expect(sanitized.openai?.dimensions).toBe(384);
		expect(sanitized.openai?.baseUrl).toBe('https://api.openai.com/v1');
		expect(sanitized.providerId).toBe('openai');
	});

	it('should return config unchanged when no apiKey present', () => {
		const config: EmbeddingProviderConfig = {
			...DEFAULT_EMBEDDING_CONFIG,
			providerId: 'ollama',
			enabled: true,
		};
		// Remove openai to test the no-apiKey path
		delete (config as any).openai;

		const sanitized = sanitizeConfig(config);
		expect(sanitized).toBe(config); // Same reference — no copy made
	});

	it('should return config unchanged when apiKey is empty string', () => {
		const config: EmbeddingProviderConfig = {
			...DEFAULT_EMBEDDING_CONFIG,
			providerId: 'openai',
			enabled: true,
			openai: {
				apiKey: '',
				model: 'text-embedding-3-small',
				dimensions: 384,
				baseUrl: 'https://api.openai.com/v1',
			},
		};

		const sanitized = sanitizeConfig(config);
		expect(sanitized).toBe(config); // Same reference — empty key is falsy
	});

	it('should not mutate the original config object', () => {
		const config: EmbeddingProviderConfig = {
			...DEFAULT_EMBEDDING_CONFIG,
			providerId: 'openai',
			enabled: true,
			openai: {
				apiKey: 'sk-real-key',
				model: 'text-embedding-3-small',
				dimensions: 384,
				baseUrl: 'https://api.openai.com/v1',
			},
		};

		sanitizeConfig(config);
		expect(config.openai?.apiKey).toBe('sk-real-key'); // Original unchanged
	});

	it('should preserve non-openai provider settings', () => {
		const config: EmbeddingProviderConfig = {
			...DEFAULT_EMBEDDING_CONFIG,
			providerId: 'openai',
			enabled: true,
			openai: {
				apiKey: 'sk-test',
				model: 'text-embedding-3-small',
				dimensions: 384,
				baseUrl: 'https://api.openai.com/v1',
			},
			ollama: {
				baseUrl: 'http://localhost:11434',
				model: 'nomic-embed-text',
			},
		};

		const sanitized = sanitizeConfig(config);
		expect(sanitized.ollama?.baseUrl).toBe('http://localhost:11434');
		expect(sanitized.ollama?.model).toBe('nomic-embed-text');
	});
});

describe('API key security contract', () => {
	it('preload API should not expose getApiKey or getOpenAIKey methods', async () => {
		// Import the preload module to verify interface shape
		const preloadModule = await import('../../../../main/preload/embedding');
		const api = preloadModule.createEmbeddingApi();
		// Verify no method exposes the raw key
		expect(api).not.toHaveProperty('getApiKey');
		expect(api).not.toHaveProperty('getOpenAIKey');
		// Verify safe methods exist
		expect(api).toHaveProperty('hasOpenAIKey');
		expect(api).toHaveProperty('setOpenAIKey');
		expect(api).toHaveProperty('clearOpenAIKey');
	});
});
