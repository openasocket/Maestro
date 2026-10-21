import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	embedSystemPromptInPrompt,
	stripEmbeddedSystemPrompt,
	hasEmbeddedSystemPrompt,
	EMBEDDED_SYSTEM_PROMPT_SEPARATOR,
} from '../../embeddedSystemPrompt';
import { translationHash } from './identity';

export const TRANSLATION_KNOWLEDGE_ENV_VAR = 'MAESTRO_TRANSLATION_KNOWLEDGE';
/** The knowledge index a migration staged. */
export const KNOWLEDGE_INDEX_FILE = 'knowledge-index.md';
/**
 * The index's SHA-256, written beside it by the migration that staged it.
 * Present, the index is bound to it: an index that no longer matches (edited,
 * replaced, truncated) is refused rather than injected into a prompt. Absent
 * (an index staged before this binding existed), the index is read as is.
 */
export const KNOWLEDGE_INDEX_HASH_FILE = 'knowledge-index.sha256';

/** Read the staged index, refusing one that does not match its bound hash. */
export function readBoundKnowledgeIndex(directory: string): string {
	const index = fs.readFileSync(path.join(directory, KNOWLEDGE_INDEX_FILE), 'utf8');
	let bound: string | undefined;
	try {
		bound = fs.readFileSync(path.join(directory, KNOWLEDGE_INDEX_HASH_FILE), 'utf8').trim();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
	}
	if (bound !== undefined && !/^[a-f0-9]{64}$/.test(bound)) {
		throw new Error('Provider knowledge index hash is malformed');
	}
	if (bound !== undefined && translationHash(index) !== bound) {
		throw new Error('Provider knowledge index does not match its bound hash');
	}
	return index;
}

/** Deliver on every continuation too; a resume may skip provider system-prompt flags. */
export function bindTranslationKnowledge(
	prompt: string | undefined,
	directory: string | undefined
): string | undefined {
	if (!prompt || !directory) return prompt;
	const normalized = path.resolve(directory).replace(/\\/g, '/');
	if (!/\/\.maestro\/provider-knowledge\/[a-f0-9]{64}\/[a-f0-9-]{36}$/.test(normalized))
		throw new Error('Unsafe provider knowledge binding');
	const index = readBoundKnowledgeIndex(directory);
	if (!index.trim()) return prompt;
	const userPrompt = stripEmbeddedSystemPrompt(prompt);
	const existing = hasEmbeddedSystemPrompt(prompt)
		? prompt.slice(0, prompt.indexOf(EMBEDDED_SYSTEM_PROMPT_SEPARATOR))
		: '';
	return embedSystemPromptInPrompt([existing, index].filter(Boolean).join('\n\n'), userPrompt);
}
