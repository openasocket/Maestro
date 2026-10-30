import path from 'node:path';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import {
	buildPromptArgv,
	resolvePromptDelivery,
	resolveSystemPromptDelivery,
	type PromptDeliveryAgent,
	type ResolvePromptDeliveryInput,
} from '../../../../shared/maestro-lib/launch/prompt-delivery';
import type { AcpPromptBlock } from '../../../../shared/maestro-lib/launch/image-refs';
import { getAgentDefinition } from '../../../../shared/maestro-lib/providers/definitions';
import { getAgentCapabilities } from '../../../../shared/maestro-lib/providers/capabilities';
import { applySystemPromptDelivery } from '../../../../shared/maestro-lib/turns/args';
import {
	embedSystemPromptInPrompt,
	EMBEDDED_SYSTEM_PROMPT_SEPARATOR,
	stripEmbeddedSystemPrompt,
} from '../../../../shared/embeddedSystemPrompt';

/** A real provider, as the spawners see it: definition plus capabilities. */
function provider(id: string): PromptDeliveryAgent {
	return { ...getAgentDefinition(id), capabilities: getAgentCapabilities(id) };
}

describe('buildPromptArgv', () => {
	it('uses the provider flag when it has one (Copilot: -p)', () => {
		expect(buildPromptArgv(provider('copilot-cli'), 'hi')).toEqual(['-p', 'hi']);
	});

	it('uses Hermes -q', () => {
		expect(buildPromptArgv(provider('hermes'), 'hi')).toEqual(['-q', 'hi']);
	});

	it('puts a bare positional for a CLI that rejects -- (Pi, Factory Droid)', () => {
		expect(buildPromptArgv(provider('pi'), 'hi')).toEqual(['hi']);
		expect(buildPromptArgv(provider('factory-droid'), 'hi')).toEqual(['hi']);
	});

	it('defaults to -- then the prompt (Claude Code)', () => {
		expect(buildPromptArgv(provider('claude-code'), '---frontmatter')).toEqual([
			'--',
			'---frontmatter',
		]);
	});
});

describe('resolvePromptDelivery', () => {
	const linux = { isWindowsHost: false, sshRemote: false };
	const windows = { isWindowsHost: true, sshRemote: false };

	it('delivers nothing when there is no prompt', () => {
		expect(resolvePromptDelivery({ agent: provider('codex'), prompt: '', ...linux })).toEqual({
			via: 'none',
		});
	});

	it('puts the prompt on the command line off Windows', () => {
		expect(resolvePromptDelivery({ agent: provider('codex'), prompt: 'hi', ...linux })).toEqual({
			via: 'argv',
			args: ['--', 'hi'],
		});
	});

	it('moves it to raw stdin on a Windows host for an agent that reads stdin', () => {
		expect(resolvePromptDelivery({ agent: provider('codex'), prompt: 'hi', ...windows })).toEqual({
			via: 'stdin',
			format: 'raw',
			args: [],
		});
	});

	it('adds the provider stdin flags on Windows (Hermes: --query-file -)', () => {
		expect(resolvePromptDelivery({ agent: provider('hermes'), prompt: 'hi', ...windows })).toEqual({
			via: 'stdin',
			format: 'raw',
			args: ['--query-file', '-'],
		});
	});

	it('keeps argv on Windows for an agent that does not read stdin (omp)', () => {
		expect(resolvePromptDelivery({ agent: provider('omp'), prompt: 'hi', ...windows }).via).toBe(
			'argv'
		);
	});

	it('uses stream-json stdin on Windows when images ride with the prompt', () => {
		expect(
			resolvePromptDelivery({
				agent: provider('claude-code'),
				prompt: 'hi',
				hasImages: true,
				...windows,
			})
		).toEqual({ via: 'stdin', format: 'stream-json', args: [] });
	});

	it('leaves the prompt to the SSH script on a remote, whatever the host OS', () => {
		for (const isWindowsHost of [true, false]) {
			expect(
				resolvePromptDelivery({
					agent: provider('codex'),
					prompt: 'hi',
					isWindowsHost,
					sshRemote: true,
				})
			).toEqual({ via: 'ssh' });
		}
	});
});

describe('resolvePromptDelivery ACP JSON artifacts', () => {
	// Observe the registered builders without replacing their behavior or route declaration.
	const registered = provider('grok');
	const promptArgs = vi.fn(registered.promptArgs);
	const promptFileArgs = vi.fn(registered.promptFileArgs);
	const grok: PromptDeliveryAgent = {
		...registered,
		promptArgs,
		promptFileArgs,
	};
	const base: ResolvePromptDeliveryInput = {
		agent: grok,
		prompt: undefined,
		isWindowsHost: false,
		sshRemote: false,
		promptFileDestination: { path: path.resolve('owned prompt-é.json'), owner: 'local' },
	};
	const image = { type: 'image', mimeType: 'image/png', data: 'AQID' } as const;
	const embeddedImageSupport = {
		mimeTypes: ['image/png'],
		maxCount: 1,
		maxBytesPerImage: 3,
		maxTotalBytes: 3,
	};
	const privateText =
		'  private prompt "雪"\nsecond line\t$(touch sentinel) `id` & | ; < > %PATH% \' ';

	beforeEach(() => vi.clearAllMocks());

	it.each([
		{ name: 'empty', prompt: '' },
		{ name: 'whitespace', prompt: ' \t\r\n ' },
		{ name: 'Unicode and shell metacharacters', prompt: privateText },
		{ name: 'above Windows argv limits', prompt: privateText.repeat(2048) },
	])('preserves exact $name bytes in the native envelope', ({ prompt }) => {
		for (const isWindowsHost of [false, true]) {
			const result = resolvePromptDelivery({ ...base, prompt, isWindowsHost });
			expect(result.via).toBe('file');
			if (result.via !== 'file') throw new Error('Expected prompt artifact');
			expect(JSON.parse(result.artifact.content)).toEqual({
				type: 'acp',
				content: [{ type: 'text', text: prompt }],
			});
			expect(Buffer.from(result.artifact.content, 'utf8')).toEqual(
				Buffer.from(
					JSON.stringify({ type: 'acp', content: [{ type: 'text', text: prompt }] }),
					'utf8'
				)
			);
			expect(result.args).toEqual(['--prompt-file', base.promptFileDestination!.path]);
			expect(promptArgs).not.toHaveBeenCalled();
			if (prompt.length > 32768) {
				expect(result.args.join(' ').length).toBeLessThan(8192);
			}
		}
	});

	it('distinguishes an absent prompt from an explicitly empty file turn', () => {
		expect(resolvePromptDelivery(base)).toEqual({ via: 'none' });
		expect(promptFileArgs).not.toHaveBeenCalled();
		expect(resolvePromptDelivery({ ...base, prompt: '' }).via).toBe('file');
		expect(promptArgs).not.toHaveBeenCalled();
	});

	it.each([false, true])(
		'composes one system envelope and skips it on resume (Windows=%s)',
		(isWindowsHost) => {
			for (const sshRemote of [false, true]) {
				for (const isResume of [false, true]) {
					const definition = getAgentDefinition('grok')!;
					const systemPrompt = 'Private Maestro system context\n  preserve spacing 雪';
					const args = isResume ? definition.resumeArgs!('synthetic-session') : [];
					const originalArgs = [...args];
					const placed = applySystemPromptDelivery({
						args,
						prompt: privateText,
						systemPrompt,
						supportsAppendSystemPrompt: getAgentCapabilities('grok').supportsAppendSystemPrompt,
						isResume,
						isWindowsHost,
						sshRemote,
					});
					expect(placed.delivery).toEqual({ via: isResume ? 'skip-on-resume' : 'embed' });
					expect(placed.args).toEqual(originalArgs);
					expect(args).toEqual(originalArgs);
					const expected = isResume
						? privateText
						: embedSystemPromptInPrompt(systemPrompt, privateText);
					expect(placed.prompt).toBe(expected);
					expect(placed.prompt!.split(EMBEDDED_SYSTEM_PROMPT_SEPARATOR)).toHaveLength(
						isResume ? 1 : 2
					);
					expect(stripEmbeddedSystemPrompt(placed.prompt!)).toBe(privateText);
					const destination = sshRemote
						? {
								owner: 'remote' as const,
								path: '/remote/scratch/system.json',
								sshRemoteId: 'selected-host',
							}
						: base.promptFileDestination!;
					const delivered = resolvePromptDelivery({
						...base,
						prompt: placed.prompt,
						args: placed.args,
						isWindowsHost,
						sshRemote,
						sshRemoteId: sshRemote ? 'selected-host' : undefined,
						promptFileDestination: destination,
					});
					if (delivered.via !== 'file') throw new Error('Expected registered Grok file route');
					expect(delivered.args).toEqual(['--prompt-file', destination.path]);
					expect(delivered.artifact.content).toBe(
						JSON.stringify({ type: 'acp', content: [{ type: 'text', text: expected }] })
					);
					expect(promptArgs).not.toHaveBeenCalled();
				}
			}
		}
	);

	describe.each([
		{ name: 'local', isWindowsHost: false, sshRemote: false, owner: 'local' as const },
		{ name: 'Windows', isWindowsHost: true, sshRemote: false, owner: 'local' as const },
		{ name: 'SSH', isWindowsHost: true, sshRemote: true, owner: 'remote' as const },
	])('$name executing host', ({ isWindowsHost, sshRemote, owner }) => {
		it.each([false, true])(
			'keeps content, resume identity and read-only args (resume=%s)',
			(resume) => {
				const definition = getAgentDefinition('grok')!;
				const sessionId = '019aa4fe-0000-7000-8000-000000000001';
				const args = Object.freeze([
					...(definition.readOnlyArgs ?? []),
					...(resume ? definition.resumeArgs!(sessionId) : []),
				]);
				const originalArgs = [...args];
				const promptBlocks: AcpPromptBlock[] = [
					{ type: 'text', text: privateText },
					image,
					{ type: 'text', text: '\n  after image 🧪  ' },
				];
				// Supplied destinations stand in for the host allocator; no files are created.
				const destination = {
					owner,
					path: sshRemote
						? path.posix.join('/remote/scratch', `attempt-${resume}.json`)
						: isWindowsHost
							? path.win32.join('C:\\scratch', `attempt-${resume}.json`)
							: path.resolve(`attempt-${resume}.json`),
				};
				const result = resolvePromptDelivery({
					...base,
					isWindowsHost,
					sshRemote,
					args,
					promptBlocks,
					hasImages: true,
					embeddedImageSupport,
					promptFileDestination: destination,
				});
				expect(result).toEqual({
					via: 'file',
					args: ['--prompt-file', destination.path],
					artifact: {
						...destination,
						content: expect.any(String),
						encoding: 'utf8',
						mode: 0o600,
						flag: 'wx',
						cleanup: 'turn',
					},
				});
				expect(args).toEqual(originalArgs);
				expect(promptArgs).not.toHaveBeenCalled();
				expect(promptFileArgs).toHaveBeenCalledExactlyOnceWith(destination.path);
				if (result.via !== 'file') throw new Error('Expected prompt artifact');
				expect(JSON.parse(result.artifact.content)).toEqual({ type: 'acp', content: promptBlocks });
				expect(result.artifact.content).not.toContain(sessionId);
				expect(result.args).not.toContain(privateText);
			}
		);
	});

	it.each([false, true])(
		'requires image admission for each fresh/resumed turn (resume=%s)',
		(resume) => {
			const args = resume ? getAgentDefinition('grok')!.resumeArgs!('synthetic-session') : [];
			const input = { ...base, args, promptBlocks: [image] };
			expect(resolvePromptDelivery({ ...input, embeddedImageSupport }).via).toBe('file');
			promptFileArgs.mockClear();
			const result = resolvePromptDelivery(input);
			expect(result).toEqual({
				via: 'refused',
				error: 'Embedded images require explicit support and bounded image limits.',
			});
			expect(promptFileArgs).not.toHaveBeenCalled();
			expect(promptArgs).not.toHaveBeenCalled();
		}
	);

	it.each([
		{ prompt: privateText, hasImages: true },
		{ hasImages: true },
		{ hasImages: true, promptBlocks: [{ type: 'text', text: privateText }] as AcpPromptBlock[] },
	])('refuses missing embedded bytes instead of retrying text: %j', (input) => {
		expect(resolvePromptDelivery({ ...base, ...input, embeddedImageSupport })).toEqual({
			via: 'refused',
			error: 'Image content is missing from the ACP prompt file.',
		});
		expect(promptFileArgs).not.toHaveBeenCalled();
		expect(promptArgs).not.toHaveBeenCalled();
	});

	it.each([
		{
			images: [{ ...image, mimeType: 'image/webp' }],
			limits: embeddedImageSupport,
			error: 'The embedded image MIME type is not supported for this turn.',
		},
		{
			images: [image, image],
			limits: embeddedImageSupport,
			error: 'The prompt exceeds the admitted image count.',
		},
		{
			images: [{ ...image, data: 'AQIDBA==' }],
			limits: embeddedImageSupport,
			error: 'The prompt exceeds the admitted image byte limits.',
		},
		{
			images: [image, image],
			limits: { ...embeddedImageSupport, maxCount: 2 },
			error: 'The prompt exceeds the admitted image byte limits.',
		},
	])(
		'propagates image refusal $error without Windows stdin or text-only retry',
		({ images, limits, error }) => {
			expect(
				resolvePromptDelivery({
					...base,
					isWindowsHost: true,
					promptBlocks: [{ type: 'text', text: privateText }, ...images],
					embeddedImageSupport: limits,
				})
			).toEqual({ via: 'refused', error });
			expect(promptFileArgs).not.toHaveBeenCalled();
			expect(promptArgs).not.toHaveBeenCalled();
		}
	);

	it.each(['', privateText])('rejects simultaneous text and blocks even for text %j', (prompt) => {
		expect(resolvePromptDelivery({ ...base, prompt, promptBlocks: [image] })).toEqual({
			via: 'refused',
			error: 'Supply either prompt text or ordered content blocks, not both.',
		});
		expect(promptFileArgs).not.toHaveBeenCalled();
		expect(promptArgs).not.toHaveBeenCalled();
	});

	it.each([{ promptBlocks: null }, { promptBlocks: [] }])(
		'never replaces invalid blocks $promptBlocks with empty text',
		({ promptBlocks }) => {
			expect(
				resolvePromptDelivery({
					...base,
					promptBlocks: promptBlocks as unknown as AcpPromptBlock[],
				})
			).toEqual({
				via: 'refused',
				error: 'An ACP prompt file requires at least one content block.',
			});
			expect(promptFileArgs).not.toHaveBeenCalled();
		}
	);

	it.each(['claude-code', 'codex', 'omp'])(
		'refuses ordered blocks on unselected %s routes',
		(id) => {
			expect(
				resolvePromptDelivery({ ...base, agent: provider(id), promptBlocks: [image] })
			).toEqual({
				via: 'refused',
				error: 'Ordered content requires an ACP JSON prompt-file route.',
			});
		}
	);

	it.each([
		['-p', privateText],
		['--single', privateText],
		['--single=' + privateText],
		['--prompt-json', privateText],
		['--prompt-json=' + privateText],
		['--prompt-file', 'private-other.json'],
		['--prompt-file=private-other.json'],
		['-p=' + privateText],
		['-p' + privateText],
		['--', privateText],
	])('refuses competing prompt source %s without disclosing its value', (...args) => {
		expect(resolvePromptDelivery({ ...base, prompt: privateText, args })).toEqual({
			via: 'refused',
			error: 'Prompt-file delivery conflicts with another prompt source in the launch arguments.',
		});
		expect(promptFileArgs).not.toHaveBeenCalled();
		expect(promptArgs).not.toHaveBeenCalled();
	});

	it.each([
		undefined,
		{ owner: 'remote' as const, path: path.posix.join('/remote', 'private.json') },
		{ owner: 'local' as const, path: 'relative-private.json' },
		{ owner: 'local' as const, path: path.resolve('private.txt') },
		{ owner: 'local' as const, path: path.resolve('private.JSON') },
		{ owner: 'local' as const, path: path.resolve('private\0.json') },
	])('refuses invalid destination %j without prompt/path disclosure', (promptFileDestination) => {
		expect(resolvePromptDelivery({ ...base, prompt: privateText, promptFileDestination })).toEqual({
			via: 'refused',
			error:
				'Prompt-file delivery requires a fresh owned .json destination on the executing host and a provider file-argument builder.',
		});
		expect(promptFileArgs).not.toHaveBeenCalled();
		expect(promptArgs).not.toHaveBeenCalled();
	});
});

describe('resolveSystemPromptDelivery', () => {
	const base = {
		systemPrompt: 'You are Maestro.',
		isWindowsHost: false,
		sshRemote: false,
		isResume: false,
		hasUserPrompt: true,
	};

	it('passes nothing without a system prompt', () => {
		expect(
			resolveSystemPromptDelivery({ ...base, systemPrompt: '', supportsAppendSystemPrompt: true })
		).toEqual({ via: 'none' });
	});

	it('uses the flag for a provider that has it, every turn including resume', () => {
		expect(
			resolveSystemPromptDelivery({ ...base, supportsAppendSystemPrompt: true, isResume: true })
		).toEqual({ via: 'flag' });
	});

	it('uses a temp file on a Windows host', () => {
		expect(
			resolveSystemPromptDelivery({
				...base,
				supportsAppendSystemPrompt: true,
				isWindowsHost: true,
			})
		).toEqual({ via: 'file' });
	});

	it('keeps the inline flag on an SSH remote from a Windows host', () => {
		expect(
			resolveSystemPromptDelivery({
				...base,
				supportsAppendSystemPrompt: true,
				isWindowsHost: true,
				sshRemote: true,
			})
		).toEqual({ via: 'flag' });
	});

	it('embeds it in the first turn for a provider without the flag', () => {
		expect(resolveSystemPromptDelivery({ ...base, supportsAppendSystemPrompt: false })).toEqual({
			via: 'embed',
		});
	});

	it('skips it on resume for a provider without the flag', () => {
		expect(
			resolveSystemPromptDelivery({ ...base, supportsAppendSystemPrompt: false, isResume: true })
		).toEqual({ via: 'skip-on-resume' });
	});

	it('sends it as the prompt when there is no user prompt', () => {
		expect(
			resolveSystemPromptDelivery({
				...base,
				supportsAppendSystemPrompt: false,
				hasUserPrompt: false,
			})
		).toEqual({ via: 'as-prompt' });
	});
});
