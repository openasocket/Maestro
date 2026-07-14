#!/usr/bin/env node
/**
 * VIBES provider key ceremony tool.
 *
 * Produces and endorses the key files a tool provider publishes at the
 * VIBES-standard paths:
 *
 *   https://{toolDomain}/vibes/{toolName}.pub        (operational public key)
 *   https://{toolDomain}/vibes/{toolName}.pub.sig    (endorsements JSON)
 *   https://{toolDomain}/vibes/{toolName}.root.pub   (developer root public key)
 *
 * Conventions (must match src/main/vibes/vibes-key-manager.ts and
 * vibes-provider-keystore.ts):
 *   - Ed25519; public = SPKI PEM, private = PKCS8 PEM (mode 0600)
 *   - keyId = first 16 hex chars of SHA-256 over the SPKI DER
 *   - endorsement sig = Ed25519 over the endorsed key's SPKI DER, base64url
 *
 * Zero dependencies; runs on any Node >= 18.
 *
 * Commands:
 *   keygen  --name <basename> [--out-dir <dir>]     Generate a keypair
 *   endorse --key <endorsed.pub> --signer <signer.key> [--out <file.pub.sig>]
 *   keyid   --key <any.pub>                          Print a key's keyId
 *   verify  --key <endorsed.pub> --sig <file.pub.sig> --signer-pub <signer.pub>
 */

import {
	generateKeyPairSync,
	createPublicKey,
	createPrivateKey,
	createHash,
	sign as cryptoSign,
	verify as cryptoVerify,
} from 'crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

function fail(msg) {
	console.error(`error: ${msg}`);
	process.exit(1);
}

function arg(name) {
	const i = process.argv.indexOf(`--${name}`);
	return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

function keyIdOfPem(publicKeyPem) {
	const der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
	return createHash('sha256').update(der).digest('hex').slice(0, 16);
}

const command = process.argv[2];

switch (command) {
	case 'keygen': {
		const name =
			arg('name') ?? fail('--name <basename> is required (e.g. maestro or maestro-root)');
		const outDir = arg('out-dir') ?? '.';
		mkdirSync(outDir, { recursive: true });

		const { publicKey, privateKey } = generateKeyPairSync('ed25519');
		const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
		const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });

		const pubPath = join(outDir, `${name}.pub`);
		const keyPath = join(outDir, `${name}.key`);
		if (existsSync(pubPath) || existsSync(keyPath)) {
			fail(`${pubPath} or ${keyPath} already exists; refusing to overwrite`);
		}
		writeFileSync(keyPath, privPem, { mode: 0o600 });
		writeFileSync(pubPath, pubPem);

		console.log(`written:  ${pubPath}  (public, publish this)`);
		console.log(`written:  ${keyPath}  (PRIVATE, mode 0600, never publish/commit)`);
		console.log(`keyId:    ${keyIdOfPem(pubPem)}`);
		break;
	}

	case 'endorse': {
		const keyPath = arg('key') ?? fail('--key <endorsed.pub> is required');
		const signerPath = arg('signer') ?? fail('--signer <signer.key> is required (PRIVATE key)');
		const outPath = arg('out') ?? `${keyPath}.sig`;

		const endorsedPem = readFileSync(keyPath, 'utf8');
		const signerPriv = createPrivateKey(readFileSync(signerPath, 'utf8'));
		// Derive the signer's public key (and keyId) from the private key
		const signerPubPem = createPublicKey(signerPriv).export({ type: 'spki', format: 'pem' });

		const endorsedDer = createPublicKey(endorsedPem).export({ type: 'spki', format: 'der' });
		const sig = cryptoSign(null, endorsedDer, signerPriv).toString('base64url');

		const endorsement = {
			keyid: keyIdOfPem(endorsedPem),
			signed_by: keyIdOfPem(signerPubPem),
			sig,
			signed_at: new Date().toISOString(),
		};

		// Merge into an existing endorsement file (replacing any same keyid+signed_by pair)
		let doc = { version: 1, endorsements: [] };
		if (existsSync(outPath)) {
			try {
				const existing = JSON.parse(readFileSync(outPath, 'utf8'));
				if (existing && Array.isArray(existing.endorsements)) doc = existing;
			} catch {
				fail(`${outPath} exists but is not valid endorsement JSON; move it aside first`);
			}
		}
		doc.endorsements = doc.endorsements.filter(
			(e) => !(e.keyid === endorsement.keyid && e.signed_by === endorsement.signed_by)
		);
		doc.endorsements.push(endorsement);
		writeFileSync(outPath, JSON.stringify(doc, null, '\t') + '\n');

		console.log(`written:  ${outPath}`);
		console.log(`endorsed: ${endorsement.keyid}  signed_by: ${endorsement.signed_by}`);
		break;
	}

	case 'keyid': {
		const keyPath = arg('key') ?? fail('--key <any.pub> is required');
		console.log(keyIdOfPem(readFileSync(keyPath, 'utf8')));
		break;
	}

	case 'verify': {
		const keyPath = arg('key') ?? fail('--key <endorsed.pub> is required');
		const sigPath = arg('sig') ?? fail('--sig <file.pub.sig> is required');
		const signerPubPath = arg('signer-pub') ?? fail('--signer-pub <signer.pub> is required');

		const endorsedPem = readFileSync(keyPath, 'utf8');
		const signerPem = readFileSync(signerPubPath, 'utf8');
		const doc = JSON.parse(readFileSync(sigPath, 'utf8'));
		const keyid = keyIdOfPem(endorsedPem);
		const signerId = keyIdOfPem(signerPem);

		const match = (doc.endorsements ?? []).find(
			(e) => e.keyid === keyid && e.signed_by === signerId
		);
		if (!match) fail(`no endorsement of ${keyid} by ${signerId} in ${sigPath}`);

		const der = createPublicKey(endorsedPem).export({ type: 'spki', format: 'der' });
		const ok = cryptoVerify(
			null,
			der,
			createPublicKey(signerPem),
			Buffer.from(match.sig, 'base64url')
		);
		if (!ok) fail('endorsement signature FAILED verification');
		console.log(`OK: ${keyid} is endorsed by ${signerId}`);
		break;
	}

	default:
		console.log(`usage:
  node scripts/vibes-key-ceremony.mjs keygen  --name <basename> [--out-dir <dir>]
  node scripts/vibes-key-ceremony.mjs endorse --key <endorsed.pub> --signer <signer.key> [--out <file.pub.sig>]
  node scripts/vibes-key-ceremony.mjs keyid   --key <any.pub>
  node scripts/vibes-key-ceremony.mjs verify  --key <endorsed.pub> --sig <file.pub.sig> --signer-pub <signer.pub>`);
		process.exit(command ? 1 : 0);
}
