/**
 * @file desktop-room-autorun-lineage.test.ts
 * @description A desktop room `!autorun` must never start an Auto Run outside the room's
 * lineage (MCOMP-17-03).
 *
 * The router hands a room `!autorun` to the client as `groupChat:autoRunTriggered`. On the
 * desktop nothing subscribes to that event, so no batch starts and the participant is closed
 * out by its response timeout. These cases pin that: a client surface that subscribes to the
 * trigger, or registers a room Auto Run with the batch handlers, fails here until the run it
 * starts carries the room's lineage (the shared runtime does it through `launchNested`).
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '../../../..');

/** Every TypeScript source under `dir`, relative to the repository root. */
function sourcesUnder(dir: string): string[] {
	const out: string[] = [];
	const walk = (abs: string) => {
		for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
			const child = path.join(abs, entry.name);
			if (entry.isDirectory()) {
				if (entry.name !== 'node_modules' && entry.name !== '__tests__') walk(child);
			} else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
				out.push(path.relative(repoRoot, child).split(path.sep).join('/'));
			}
		}
	};
	walk(path.join(repoRoot, dir));
	return out.sort();
}

/** Lines of the client sources that match `pattern`, as `file:line: text`. */
function clientLinesMatching(pattern: RegExp): string[] {
	const hits: string[] = [];
	for (const file of [...sourcesUnder('src/renderer'), ...sourcesUnder('src/web-desktop')]) {
		const lines = fs.readFileSync(path.join(repoRoot, file), 'utf8').split('\n');
		lines.forEach((line, index) => {
			if (pattern.test(line)) hits.push(`${file}:${index + 1}: ${line.trim()}`);
		});
	}
	return hits;
}

describe('desktop room !autorun lineage (MCOMP-17-03)', () => {
	it('scans the client sources it guards', () => {
		const renderer = sourcesUnder('src/renderer');
		expect(renderer).toContain('src/renderer/utils/groupChatAutoRunRegistry.ts');
		expect(renderer).toContain('src/renderer/hooks/batch/useBatchHandlers.ts');
		expect(renderer.length).toBeGreaterThan(100);
	});

	it('main still hands a room !autorun to the client as groupChat:autoRunTriggered', () => {
		const handler = fs.readFileSync(
			path.join(repoRoot, 'src/main/ipc/handlers/groupChat.ts'),
			'utf8'
		);
		expect(handler).toMatch(/safeSend\('groupChat:autoRunTriggered'/);
		const preload = fs.readFileSync(path.join(repoRoot, 'src/main/preload/groupChat.ts'), 'utf8');
		expect(preload).toMatch(/ipcRenderer\.on\('groupChat:autoRunTriggered'/);
	});

	it('no client surface subscribes to the room !autorun trigger', () => {
		// A call, `onAutoRunTriggered(` or `onAutoRunTriggered?.(`; a stub's `onAutoRunTriggered: () =>` is not one.
		expect(clientLinesMatching(/\bonAutoRunTriggered\s*(\?\.)?\s*\(/)).toEqual([]);
		// Nor through the event name directly.
		expect(clientLinesMatching(/['"`]groupChat:autoRunTriggered['"`]/)).toEqual([]);
	});

	it('no client surface registers a room Auto Run with the batch handlers', () => {
		const calls = clientLinesMatching(/\bregisterGroupChatAutoRun\s*\(/).filter(
			(hit) => !/export function registerGroupChatAutoRun\s*\(/.test(hit)
		);
		expect(calls).toEqual([]);
	});
});
