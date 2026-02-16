/**
 * Minimal BM25 scorer for experience retrieval.
 * Supplements dense embedding similarity with keyword matching.
 *
 * This is ~80 lines of code, not a library dependency.
 * Only needed if pure semantic retrieval misses keyword-exact matches.
 */

const K1 = 1.2;
const B = 0.75;

export interface BM25Index {
	/** Inverted index: term → Set of entry IDs */
	index: Map<string, Set<string>>;
	/** Document lengths: entry ID → token count */
	docLengths: Map<string, number>;
	/** Average document length */
	avgDocLength: number;
	/** Total documents */
	docCount: number;
}

/**
 * Unicode-aware tokenizer for multilingual BM25.
 * Splits on whitespace and punctuation while preserving CJK characters
 * as individual tokens (CJK scripts don't use spaces between words).
 * Also handles Latin, Cyrillic, Arabic, Devanagari, etc.
 */
export function tokenize(text: string): string[] {
	const lower = text.toLowerCase();
	// Split CJK characters into individual tokens (they are word-level in these scripts)
	// \u3000-\u9fff covers CJK unified ideographs + misc CJK
	// \uac00-\ud7af covers Korean Hangul syllables
	// \uf900-\ufaff covers CJK compatibility ideographs
	const tokens: string[] = [];
	// First pass: extract CJK characters as individual tokens
	const withCjkSplit = lower.replace(/[\u3000-\u9fff\uac00-\ud7af\uf900-\ufaff]/g, (ch) => {
		tokens.push(ch);
		return ' ';
	});
	// Second pass: split remaining text on whitespace/punctuation, keep unicode word chars
	const words = withCjkSplit.split(/[\s\p{P}\p{S}]+/u).filter(Boolean);
	tokens.push(...words);
	return tokens;
}

export function buildIndex(entries: { id: string; content: string }[]): BM25Index {
	const index = new Map<string, Set<string>>();
	const docLengths = new Map<string, number>();
	let totalLength = 0;

	for (const entry of entries) {
		const tokens = tokenize(entry.content);
		docLengths.set(entry.id, tokens.length);
		totalLength += tokens.length;
		for (const token of new Set(tokens)) {
			if (!index.has(token)) index.set(token, new Set());
			index.get(token)!.add(entry.id);
		}
	}

	return {
		index,
		docLengths,
		avgDocLength: entries.length > 0 ? totalLength / entries.length : 0,
		docCount: entries.length,
	};
}

export function score(query: string, entryId: string, bm25Index: BM25Index): number {
	const queryTokens = tokenize(query);
	const dl = bm25Index.docLengths.get(entryId) ?? 0;
	let total = 0;

	for (const term of queryTokens) {
		const docsWithTerm = bm25Index.index.get(term);
		if (!docsWithTerm || !docsWithTerm.has(entryId)) continue;

		const df = docsWithTerm.size;
		const idf = Math.log((bm25Index.docCount - df + 0.5) / (df + 0.5) + 1);
		const tf = 1; // Binary TF for 32-word documents — term rarely appears more than once
		const norm = tf * (K1 + 1) / (tf + K1 * (1 - B + B * dl / bm25Index.avgDocLength));
		total += idf * norm;
	}

	return total;
}
