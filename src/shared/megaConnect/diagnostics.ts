/**
 * The one redactor every diagnostic bundle passes through, transcribed from
 * the contracts 0.5.1 diagnostics module (`redact()`, SIMPLE-06-03, AR-23).
 * It is transcribed, not imported, because no product code loads the vendored
 * contracts (the house style of `input.ts` and `endpoint-port.ts`); a test runs
 * the vendored `redact()` on the same fixtures and holds the two deep-equal.
 *
 * A bundle is built from an allowlisted schema first; this is the second line,
 * for a secret that lands in a field it should not. By key: a name that says
 * token, secret, cookie, csrf, password, private, nonce, signature,
 * authorization, content or prompt is dropped. By value, in any string:
 * private keys are dropped and other PEM blocks become their SHA-256; JWTs,
 * bearer values, 43-character tokens (base64url of 32 bytes), 64-byte values
 * (Ed25519 and P-256 signatures, base64url or padded base64), URL credentials,
 * queries and fragments and join-link codes are removed; text over 512
 * characters is cut. Digests (64 hex characters) stay: they are not secrets
 * and a diagnosis needs them. So do diagnostic IDs: a bundle that must not
 * carry an ID or a matching number leaves it out at the allowlist.
 */

export type Redacted = null | boolean | number | string | Redacted[] | { [key: string]: Redacted };

const sensitiveKey =
	/token|secret|cookie|csrf|password|private|nonce|signature|authorization|content|prompt/i;
const maxString = 512;
const cutMarker = '[truncated]';
const maxDepth = 16;
const pem = /-----BEGIN ([A-Z0-9 ]+)-----[\s\S]*?-----END \1-----/g;
// A private key cut short still ends the string: nothing after its header is safe to show.
const cutPrivateKey = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*/g;
const jwt = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g;
const bearer = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
// Keep the scheme, host and path; drop `user:password@`, `?query` and `#fragment`.
const url = /\b([a-z][a-z0-9+.-]*:\/\/)(?:[^\s/?#@]*@)?([^\s?#]*)(?:\?[^\s#]*)?(?:#\S*)?/gi;
const joinCode = /\/join\/[A-Za-z0-9_-]+/g;
const token43 = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g;
// 86 characters, or 86 and `==`: a run may follow a `/`, so one in a URL path goes too.
const value64 = /(?<![A-Za-z0-9_+-])[A-Za-z0-9_+/-]{86}(?:==)?(?![A-Za-z0-9_+/=-])/g;

async function sha256(text: string): Promise<string> {
	const hash = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// Secrets go before the length cut, or a long string could be cut inside a key and leave half of it.
async function scrub(text: string): Promise<string> {
	const digests = new Map<string, string>();
	for (const match of text.matchAll(pem)) {
		if (!/PRIVATE KEY/.test(match[1] ?? '')) digests.set(match[0], await sha256(match[0]));
	}
	const clean = text
		.replace(pem, (block: string, label: string) =>
			/PRIVATE KEY/.test(label) ? '[private key removed]' : `[pem sha256:${digests.get(block)}]`
		)
		.replace(cutPrivateKey, '[private key removed]')
		.replace(jwt, '[token removed]')
		.replace(url, '$1$2')
		.replace(joinCode, '/join/[removed]')
		.replace(bearer, 'Bearer [removed]')
		.replace(value64, '[signature removed]')
		.replace(token43, '[token removed]');
	return clean.length > maxString
		? clean.slice(0, maxString - cutMarker.length) + cutMarker
		: clean;
}

// Siblings are walked one after another, so `seen` holds exactly the ancestors of the value in hand.
async function walk(value: unknown, depth: number, seen: WeakSet<object>): Promise<Redacted> {
	switch (typeof value) {
		case 'string':
			return scrub(value);
		case 'boolean':
			return value;
		case 'number':
			return Number.isFinite(value) ? value : null;
		case 'bigint':
			return value.toString();
		case 'object':
			break;
		default:
			return null;
	}
	if (value === null) return null;
	if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
	if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return '[binary removed]';
	if (depth >= maxDepth) return '[depth limit]';
	if (seen.has(value)) return '[circular]';
	seen.add(value);
	try {
		// An error is its name, code and message: never a stack.
		const source: unknown =
			value instanceof Error
				? {
						name: value.name,
						message: value.message,
						code: (value as Error & { code?: unknown }).code,
					}
				: value;
		if (Array.isArray(source)) {
			const items: Redacted[] = [];
			for (const item of source) items.push(await walk(item, depth + 1, seen));
			return items;
		}
		const entries: Array<[string, Redacted]> = [];
		for (const [key, item] of Object.entries(source as Record<string, unknown>)) {
			if (
				sensitiveKey.test(key) ||
				item === undefined ||
				typeof item === 'function' ||
				typeof item === 'symbol'
			)
				continue;
			entries.push([key, await walk(item, depth + 1, seen)]);
		}
		return Object.fromEntries(entries);
	} finally {
		seen.delete(value);
	}
}

/** A copy of `value` that is safe to show or send: see the rules above. Never mutates its input. */
export async function redact(value: unknown): Promise<Redacted> {
	return walk(value, 0, new WeakSet());
}
