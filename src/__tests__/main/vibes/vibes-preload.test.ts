/**
 * Tests for src/main/preload/vibes.ts
 * Validates the VIBES preload API factory function creates correct IPC bridges.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoist mock for ipcRenderer
const { mockInvoke, mockOn, mockRemoveListener } = vi.hoisted(() => ({
	mockInvoke: vi.fn(),
	mockOn: vi.fn(),
	mockRemoveListener: vi.fn(),
}));

// Mock electron
vi.mock('electron', () => ({
	ipcRenderer: {
		invoke: mockInvoke,
		on: mockOn,
		removeListener: mockRemoveListener,
	},
}));

import { createVibesApi } from '../../../main/preload/vibes';
import type {
	VibesApi,
	VibesCommandResult,
	VibesInitConfig,
	VibesLogOptions,
	VibesAttestationResult,
} from '../../../main/preload/vibes';

describe('vibes preload API', () => {
	let api: VibesApi;

	beforeEach(() => {
		vi.clearAllMocks();
		api = createVibesApi();
	});

	describe('createVibesApi', () => {
		it('should return an object with all expected methods', () => {
			expect(api).toHaveProperty('isInitialized');
			expect(api).toHaveProperty('init');
			expect(api).toHaveProperty('updateConfig');
			expect(api).toHaveProperty('getStats');
			expect(api).toHaveProperty('getBlame');
			expect(api).toHaveProperty('getLog');
			expect(api).toHaveProperty('getCoverage');
			expect(api).toHaveProperty('getLocCoverage');
			expect(api).toHaveProperty('getReport');
			expect(api).toHaveProperty('getSessions');
			expect(api).toHaveProperty('getModels');
			expect(api).toHaveProperty('build');
			expect(api).toHaveProperty('findBinary');
			expect(api).toHaveProperty('clearBinaryCache');
			expect(api).toHaveProperty('decompressReasoning');
			expect(api).toHaveProperty('onAnnotationUpdate');
			expect(api).toHaveProperty('onActivityFeed');
			expect(api).toHaveProperty('onKeyPermissionsWarning');
			expect(api).toHaveProperty('attestation');
		});

		it('should have exactly 21 top-level properties', () => {
			expect(Object.keys(api)).toHaveLength(21);
		});

		it('should have attestation sub-namespace with 7 methods', () => {
			const attestation = (api as any).attestation;
			expect(attestation).toHaveProperty('keygen');
			expect(attestation).toHaveProperty('getKeyInfo');
			expect(attestation).toHaveProperty('checkKeyPermissions');
			expect(attestation).toHaveProperty('exportPublicKey');
			expect(attestation).toHaveProperty('attest');
			expect(attestation).toHaveProperty('verifyAttestation');
			expect(attestation).toHaveProperty('getProviderKeys');
			expect(Object.keys(attestation)).toHaveLength(7);
		});
	});

	describe('isInitialized', () => {
		it('should invoke vibes:isInitialized with project path', async () => {
			mockInvoke.mockResolvedValue(true);

			const result = await api.isInitialized('/project');

			expect(mockInvoke).toHaveBeenCalledWith('vibes:isInitialized', '/project');
			expect(result).toBe(true);
		});
	});

	describe('init', () => {
		it('should invoke vibes:init with project path and config', async () => {
			const config: VibesInitConfig = {
				projectName: 'test',
				assuranceLevel: 'medium',
				extensions: ['.ts'],
			};
			mockInvoke.mockResolvedValue({ success: true });

			const result = await api.init('/project', config);

			expect(mockInvoke).toHaveBeenCalledWith('vibes:init', '/project', config);
			expect(result).toEqual({ success: true });
		});
	});

	describe('updateConfig', () => {
		it('should invoke vibes:updateConfig with project path and updates', async () => {
			const updates = { assurance_level: 'high' };
			mockInvoke.mockResolvedValue({ success: true });

			const result = await api.updateConfig('/project', updates);

			expect(mockInvoke).toHaveBeenCalledWith('vibes:updateConfig', '/project', updates);
			expect(result).toEqual({ success: true });
		});

		it('should return error when config not found', async () => {
			mockInvoke.mockResolvedValue({
				success: false,
				error: 'No VIBES config found. Initialize VIBES first.',
			});

			const result = await api.updateConfig('/project', { assurance_level: 'high' });

			expect(result).toEqual({
				success: false,
				error: 'No VIBES config found. Initialize VIBES first.',
			});
		});
	});

	describe('getStats', () => {
		it('should invoke vibes:getStats with project path', async () => {
			mockInvoke.mockResolvedValue({ success: true, data: '{}' });

			const result = await api.getStats('/project');

			expect(mockInvoke).toHaveBeenCalledWith('vibes:getStats', '/project', undefined);
			expect(result).toEqual({ success: true, data: '{}' });
		});

		it('should pass optional file argument', async () => {
			mockInvoke.mockResolvedValue({ success: true, data: '{}' });

			await api.getStats('/project', 'src/index.ts');

			expect(mockInvoke).toHaveBeenCalledWith('vibes:getStats', '/project', 'src/index.ts');
		});
	});

	describe('getBlame', () => {
		it('should invoke vibes:getBlame with project path and file', async () => {
			mockInvoke.mockResolvedValue({ success: true, data: '[]' });

			const result = await api.getBlame('/project', 'src/index.ts');

			expect(mockInvoke).toHaveBeenCalledWith('vibes:getBlame', '/project', 'src/index.ts');
			expect(result).toEqual({ success: true, data: '[]' });
		});
	});

	describe('getLog', () => {
		it('should invoke vibes:getLog with project path and options', async () => {
			const options: VibesLogOptions = { file: 'src/index.ts', limit: 10, json: true };
			mockInvoke.mockResolvedValue({ success: true, data: '[]' });

			const result = await api.getLog('/project', options);

			expect(mockInvoke).toHaveBeenCalledWith('vibes:getLog', '/project', options);
			expect(result).toEqual({ success: true, data: '[]' });
		});

		it('should work without options', async () => {
			mockInvoke.mockResolvedValue({ success: true, data: '[]' });

			await api.getLog('/project');

			expect(mockInvoke).toHaveBeenCalledWith('vibes:getLog', '/project', undefined);
		});
	});

	describe('getCoverage', () => {
		it('should invoke vibes:getCoverage with project path', async () => {
			mockInvoke.mockResolvedValue({ success: true, data: '{}' });

			const result = await api.getCoverage('/project');

			expect(mockInvoke).toHaveBeenCalledWith('vibes:getCoverage', '/project');
			expect(result).toEqual({ success: true, data: '{}' });
		});
	});

	describe('getReport', () => {
		it('should invoke vibes:getReport with project path and format', async () => {
			mockInvoke.mockResolvedValue({ success: true, data: '# Report' });

			const result = await api.getReport('/project', 'markdown');

			expect(mockInvoke).toHaveBeenCalledWith('vibes:getReport', '/project', 'markdown');
			expect(result).toEqual({ success: true, data: '# Report' });
		});

		it('should work without format', async () => {
			mockInvoke.mockResolvedValue({ success: true, data: '{}' });

			await api.getReport('/project');

			expect(mockInvoke).toHaveBeenCalledWith('vibes:getReport', '/project', undefined);
		});
	});

	describe('getSessions', () => {
		it('should invoke vibes:getSessions with project path', async () => {
			mockInvoke.mockResolvedValue({ success: true, data: '[]' });

			const result = await api.getSessions('/project');

			expect(mockInvoke).toHaveBeenCalledWith('vibes:getSessions', '/project');
			expect(result).toEqual({ success: true, data: '[]' });
		});
	});

	describe('getModels', () => {
		it('should invoke vibes:getModels with project path', async () => {
			mockInvoke.mockResolvedValue({ success: true, data: '[]' });

			const result = await api.getModels('/project');

			expect(mockInvoke).toHaveBeenCalledWith('vibes:getModels', '/project');
			expect(result).toEqual({ success: true, data: '[]' });
		});
	});

	describe('build', () => {
		it('should invoke vibes:build with project path', async () => {
			mockInvoke.mockResolvedValue({ success: true });

			const result = await api.build('/project');

			expect(mockInvoke).toHaveBeenCalledWith('vibes:build', '/project');
			expect(result).toEqual({ success: true });
		});
	});

	describe('findBinary', () => {
		it('should invoke vibes:findBinary with custom path', async () => {
			mockInvoke.mockResolvedValue({
				path: '/usr/local/bin/vibecheck',
				version: 'vibecheck 0.3.2',
			});

			const result = await api.findBinary('/custom/vibecheck');

			expect(mockInvoke).toHaveBeenCalledWith('vibes:findBinary', '/custom/vibecheck');
			expect(result).toEqual({ path: '/usr/local/bin/vibecheck', version: 'vibecheck 0.3.2' });
		});

		it('should work without custom path', async () => {
			mockInvoke.mockResolvedValue({ path: '/usr/bin/vibecheck', version: null });

			const result = await api.findBinary();

			expect(mockInvoke).toHaveBeenCalledWith('vibes:findBinary', undefined);
			expect(result).toEqual({ path: '/usr/bin/vibecheck', version: null });
		});

		it('should return null path and version when not found', async () => {
			mockInvoke.mockResolvedValue({ path: null, version: null });

			const result = await api.findBinary();

			expect(result).toEqual({ path: null, version: null });
		});
	});

	describe('clearBinaryCache', () => {
		it('should invoke vibes:clearBinaryCache', async () => {
			mockInvoke.mockResolvedValue(undefined);

			await api.clearBinaryCache();

			expect(mockInvoke).toHaveBeenCalledWith('vibes:clearBinaryCache');
		});
	});

	describe('onAnnotationUpdate', () => {
		it('should register a listener on vibes:annotation-update channel', () => {
			const callback = vi.fn();

			api.onAnnotationUpdate(callback);

			expect(mockOn).toHaveBeenCalledWith('vibes:annotation-update', expect.any(Function));
		});

		it('should return a cleanup function that removes the listener', () => {
			const callback = vi.fn();

			const cleanup = api.onAnnotationUpdate(callback);
			cleanup();

			expect(mockRemoveListener).toHaveBeenCalledWith(
				'vibes:annotation-update',
				expect.any(Function)
			);
		});

		it('should forward the payload to the callback (unwrapping the event arg)', () => {
			const callback = vi.fn();
			let registeredHandler: (event: unknown, payload: unknown) => void;

			mockOn.mockImplementation(
				(_channel: string, handler: (event: unknown, payload: unknown) => void) => {
					registeredHandler = handler;
				}
			);

			api.onAnnotationUpdate(callback);

			const payload = {
				sessionId: 'sess-1',
				annotationCount: 5,
				lastAnnotation: {
					type: 'line',
					filePath: '/test.ts',
					action: 'create',
					timestamp: '2026-02-10T12:00:00.000Z',
				},
			};

			// Simulate IPC event (first arg is the IPC event, second is the payload)
			registeredHandler!(null, payload);

			expect(callback).toHaveBeenCalledWith(payload);
		});
	});

	describe('onActivityFeed', () => {
		it('should register a listener on vibes:activity-feed channel', () => {
			const callback = vi.fn();

			api.onActivityFeed(callback);

			expect(mockOn).toHaveBeenCalledWith('vibes:activity-feed', expect.any(Function));
		});

		it('should return a cleanup function that removes the listener', () => {
			const callback = vi.fn();

			const cleanup = api.onActivityFeed(callback);
			cleanup();

			expect(mockRemoveListener).toHaveBeenCalledWith('vibes:activity-feed', expect.any(Function));
		});

		it('should forward the event to the callback (unwrapping the IPC event arg)', () => {
			const callback = vi.fn();
			let registeredHandler: (event: unknown, payload: unknown) => void;

			mockOn.mockImplementation(
				(_channel: string, handler: (event: unknown, payload: unknown) => void) => {
					registeredHandler = handler;
				}
			);

			api.onActivityFeed(callback);

			const feedEvent = {
				sessionId: 'sess-1',
				vibesSessionId: 'vibes-sess-1',
				category: 'tool' as const,
				summary: 'Tool: Write → src/index.ts',
				timestamp: '2026-03-17T12:00:00.000Z',
				detail: {
					toolName: 'Write',
					filePath: 'src/index.ts',
					action: 'create',
				},
				isSubagent: false,
				depth: 0,
			};

			// Simulate IPC event (first arg is the IPC event, second is the payload)
			registeredHandler!(null, feedEvent);

			expect(callback).toHaveBeenCalledWith(feedEvent);
		});
	});

	// ========================================================================
	// Attestation sub-namespace
	// ========================================================================

	describe('attestation.keygen', () => {
		it('should invoke vibes:keygen', async () => {
			mockInvoke.mockResolvedValue({ success: true, data: { keyId: 'abc', exists: true } });

			const result = await (api as any).attestation.keygen();

			expect(mockInvoke).toHaveBeenCalledWith('vibes:keygen');
			expect(result).toEqual({ success: true, data: { keyId: 'abc', exists: true } });
		});
	});

	describe('attestation.getKeyInfo', () => {
		it('should invoke vibes:getKeyInfo', async () => {
			mockInvoke.mockResolvedValue({ success: true, data: { keyId: 'abc', exists: true } });

			const result = await (api as any).attestation.getKeyInfo();

			expect(mockInvoke).toHaveBeenCalledWith('vibes:getKeyInfo');
			expect(result).toEqual({ success: true, data: { keyId: 'abc', exists: true } });
		});
	});

	describe('attestation.checkKeyPermissions', () => {
		it('should invoke vibes:checkKeyPermissions', async () => {
			mockInvoke.mockResolvedValue({ success: true, data: { valid: true } });

			const result = await (api as any).attestation.checkKeyPermissions();

			expect(mockInvoke).toHaveBeenCalledWith('vibes:checkKeyPermissions');
			expect(result).toEqual({ success: true, data: { valid: true } });
		});
	});

	describe('attestation.exportPublicKey', () => {
		it('should invoke vibes:exportPublicKey with format', async () => {
			mockInvoke.mockResolvedValue({ success: true, data: 'ssh-ed25519 AAAA...' });

			const result = await (api as any).attestation.exportPublicKey('ssh');

			expect(mockInvoke).toHaveBeenCalledWith('vibes:exportPublicKey', 'ssh');
			expect(result).toEqual({ success: true, data: 'ssh-ed25519 AAAA...' });
		});
	});

	describe('attestation.attest', () => {
		it('should invoke vibes:attest with project path and options', async () => {
			const options = { cosign: true, validationResult: 'PASS' as const };
			mockInvoke.mockResolvedValue({ success: true, data: { attestationId: 'id' } });

			const result = await (api as any).attestation.attest('/project', options);

			expect(mockInvoke).toHaveBeenCalledWith('vibes:attest', '/project', options);
			expect(result).toEqual({ success: true, data: { attestationId: 'id' } });
		});

		it('should work without options', async () => {
			mockInvoke.mockResolvedValue({ success: true, data: {} });

			await (api as any).attestation.attest('/project');

			expect(mockInvoke).toHaveBeenCalledWith('vibes:attest', '/project', undefined);
		});
	});

	describe('attestation.verifyAttestation', () => {
		it('should invoke vibes:verifyAttestation with project path and envelope', async () => {
			const envelope = { payloadType: 'test', payload: 'data', signatures: [] };
			mockInvoke.mockResolvedValue({ success: true, data: { valid: true } });

			const result = await (api as any).attestation.verifyAttestation('/project', envelope);

			expect(mockInvoke).toHaveBeenCalledWith('vibes:verifyAttestation', '/project', envelope);
			expect(result).toEqual({ success: true, data: { valid: true } });
		});
	});

	describe('attestation.getProviderKeys', () => {
		it('should invoke vibes:getProviderKeys', async () => {
			mockInvoke.mockResolvedValue({ success: true, data: { provider: 'Maestro', keys: [] } });

			const result = await (api as any).attestation.getProviderKeys();

			expect(mockInvoke).toHaveBeenCalledWith('vibes:getProviderKeys');
			expect(result).toEqual({
				success: true,
				data: { provider: 'Maestro', keys: [] },
			});
		});
	});
});
