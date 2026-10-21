/**
 * Injected custody for the enterprise identity tests: a reversible "seal"
 * that refuses foreign bytes, and an in-memory anchor held OUTSIDE the file
 * so a test can roll the file back while the anchor, like a real credential
 * store, keeps the newest epoch. Nothing here touches the developer's
 * keyring or Electron's `safeStorage`.
 */

import type { Anchor, AnchorStore } from '../../../main/utils/keyring-anchor';
import type { SealCustody, SealProvider } from '../../../main/utils/safe-storage-seal';

const MARK = 'SEALED\u0000';

export function fakeSeal(
	options: { available?: boolean; custody?: SealCustody | null; mark?: string } = {}
): SealProvider {
	const mark = options.mark ?? MARK;
	const seal: SealProvider = {
		available: () => options.available ?? true,
		seal: (plaintext) => Buffer.from(mark + plaintext, 'utf8'),
		unseal: (blob) => {
			const text = blob.toString('utf8');
			if (!text.startsWith(mark)) throw new Error('not sealed by this key');
			return text.slice(mark.length);
		},
	};
	if (options.custody !== null) {
		seal.custody = () => options.custody ?? { kind: 'os-keystore', backend: 'keychain' };
	}
	return seal;
}

export function fakeAnchor(
	holder: { value: Anchor | null },
	options: { available?: boolean; writeThrows?: boolean } = {}
): AnchorStore {
	return {
		available: () => options.available ?? true,
		read: () => (holder.value ? { ...holder.value } : null),
		write: (anchor) => {
			if (options.writeThrows) throw new Error('credential store is locked');
			holder.value = { ...anchor };
		},
		clear: () => {
			holder.value = null;
		},
	};
}
