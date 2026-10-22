/**
 * The shape of a Maestro Lite pairing credential, and the two files that
 * hold it (MRC-08-03).
 *
 * A pairing credential is `<device id>.<proof>`: two 43-character base64url
 * halves, 32 random bytes the host minted as the grant id and an HMAC the
 * pairing session key produced over the grant (`lite/pairing/protocol.ts`).
 * The first half is the DEVICE ID the host's registry is keyed on and the
 * name a paired device is known by everywhere else: `lite-device:<id>` on a
 * delegation chain, `paired-device:<id>` as the acting user History sees.
 * It is public. The second half is the secret: the host keeps only its
 * SHA-256 verifier (`lite-paired-devices.json`), the device keeps the whole
 * credential OS-encrypted and bound to the host's instance id, origin and,
 * over Tailscale, the verified peer (`lite-device-credentials.json`).
 *
 * The credential admits a transport, and that is all it is:
 *
 *   - never a Mega-Maestro device identity: the endpoint owns the device key,
 *     and the enterprise identity store never reads either file;
 *   - never an enterprise actor: a managed action over a paired device is
 *     bound to the enrollment's registered actor, separately, and refused
 *     until one is registered (`pairedDeviceActorProblems()` in
 *     `src/main/enterprise/spawn-authority.ts`);
 *   - never a central upload: both files are refused by the Cue bundle
 *     exporter, and `redactSecrets()` scrubs the credential shape from any
 *     text that is persisted, shown or sent.
 *
 * One home for the shape, so the copies the two stores, the relay and the
 * exporter carried cannot drift apart. Pure and renderer-safe.
 */

const HALF = '[A-Za-z0-9_-]{43}';

/** The whole credential, anchored: `<device id>.<proof>`. */
export const LITE_PAIRING_CREDENTIAL_PATTERN = new RegExp(`^${HALF}\\.${HALF}$`);

/**
 * The credential inside running text, for a redactor: the same two halves,
 * not glued to another base64url run on either side. Fixed length, so it is
 * linear on any input. `-` and `_` are in the class, which is why the
 * guards are lookarounds and not `\b`.
 */
export const LITE_PAIRING_CREDENTIAL_SOURCE = `(?<![A-Za-z0-9_-])${HALF}\\.${HALF}(?![A-Za-z0-9_-])`;

/** Whether `value` has the shape of a pairing credential. Shape only: the host's verifier decides validity. */
export function isLitePairingCredential(value: unknown): value is string {
	return typeof value === 'string' && LITE_PAIRING_CREDENTIAL_PATTERN.test(value);
}

/** The public half, the device id the registry keys on; undefined for anything that is not a credential. */
export function litePairingDeviceId(credential: unknown): string | undefined {
	return isLitePairingCredential(credential) ? credential.slice(0, 43) : undefined;
}

/** The device's own copy: whole credentials, OS-encrypted, bound to instance, origin and Tailscale peer. */
export const LITE_DEVICE_CREDENTIALS_FILE_NAME = 'lite-device-credentials.json';
/** The host's registry: device ids, names, origins and SHA-256 verifiers, never a credential. */
export const LITE_PAIRED_DEVICES_FILE_NAME = 'lite-paired-devices.json';

/** The base name of either pairing store, with any extension, temp or backup suffix. */
export const LITE_PAIRING_STORE_FILE_PATTERN = /^lite-(device-credentials|paired-devices)(\..*)?$/i;

/** Whether a file base name is one of the pairing stores (never bundled, uploaded or synced). */
export function isLitePairingStoreFile(baseName: string): boolean {
	return LITE_PAIRING_STORE_FILE_PATTERN.test(baseName);
}
