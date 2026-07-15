/**
 * Display-only strings for the VIBES spec key paths (~/.vibescheck/keys).
 *
 * The REAL paths are resolved in the main process (vibes-key-manager.ts);
 * these helpers only shape UI copy so Windows users see a
 * %USERPROFILE%\.vibescheck\keys style path instead of a POSIX one. Never
 * use them for file access. Platform comes from the shared detection helper,
 * which reads window.maestro.platform in the renderer.
 */

import { isWindows } from '../../shared/platformDetection';

/** Spec key directory for display, e.g. "~/.vibescheck/keys". */
export function vibesKeyDirDisplay(): string {
	return isWindows() ? '%USERPROFILE%\\.vibescheck\\keys' : '~/.vibescheck/keys';
}

/** Private key path for display, e.g. "~/.vibescheck/keys/vibescheck.key". */
export function vibesPrivateKeyPathDisplay(): string {
	const sep = isWindows() ? '\\' : '/';
	return `${vibesKeyDirDisplay()}${sep}vibescheck.key`;
}

/** Public key path for display, e.g. "~/.vibescheck/keys/vibescheck.pub". */
export function vibesPublicKeyPathDisplay(): string {
	const sep = isWindows() ? '\\' : '/';
	return `${vibesKeyDirDisplay()}${sep}vibescheck.pub`;
}
