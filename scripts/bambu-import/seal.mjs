#!/usr/bin/env node
/**
 * SEALED FILES FOR THE ONE-TIME BAMBU LAB IMPORT (import spec §A.8, §D.1;
 * docs/DECISIONS.md row 239).
 *
 * The repository is public, and so are its Actions logs and artifacts.
 * Workflow 60 reads the live catalogue — draft and hidden products, inactive
 * sections, owner-only image provenance — so nothing it produces may leave the
 * job in clear. Every dispatch carries a ONE-TIME X25519 public key that the
 * agent generated in its own sandbox. Each file is sealed to that key in the
 * step that produced it, the plaintext is deleted, and only `*.sealed` files
 * are uploaded. The private key never leaves the sandbox.
 *
 * A sealed box from node:crypto alone (no npm dependency):
 *
 *   a fresh ephemeral X25519 key per file
 *   → ECDH with the recipient's public key
 *   → HKDF-SHA-256 (salt = ephemeral public ‖ recipient public, info = the label below)
 *   → AES-256-GCM with a random 96-bit nonce, the whole header as associated data.
 *
 * FORMAT, VERSION 1 — every header byte is authenticated:
 *
 *   offset  bytes
 *        0      6  magic "LVSEAL"
 *        6      1  version (1)
 *        7      8  key id: the first 8 bytes of SHA-256(recipient public key)
 *       15     32  the ephemeral X25519 public key (raw)
 *       47     12  the AES-GCM nonce
 *       59      …  ciphertext
 *     end-16   16  the GCM tag
 *
 * The key id lets `unseal` say "sealed to another key" instead of a bare
 * authentication failure; it identifies a public key and reveals nothing.
 *
 *   node scripts/bambu-import/seal.mjs --keygen <dir>
 *       writes <dir>/bambu-seal-<key id>.pem (mode 0600) and prints the public
 *       key: 43 base64url characters, the `seal_pubkey` input of workflow 60.
 *       Refuses a directory inside a git checkout.
 *   node scripts/bambu-import/seal.mjs --pub <public key> <in> <out.sealed> [--keep]
 *       seals <in> into <out.sealed>, then deletes <in> (--keep keeps it).
 *   node scripts/bambu-import/unseal.mjs --key <private key file> <in> <out>
 *       the reverse, in the sandbox only.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  KeyObject,
  randomBytes,
} from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const MAGIC = Buffer.from('LVSEAL', 'ascii');
export const VERSION = 1;
const KID_BYTES = 8;
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
export const TAG_BYTES = 16;
export const HEADER_BYTES = MAGIC.length + 1 + KID_BYTES + KEY_BYTES + NONCE_BYTES;
const INFO = Buffer.from('levonis/bambu-import/sealed-box/v1', 'ascii');

/** The dispatch input's shape, the same pattern workflow 60 validates. */
export const PUBLIC_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const SEALED_SUFFIX = '.sealed';

export class SealError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'SealError';
    this.code = code;
  }
}

const rawPublicKey = (key) => Buffer.from(key.export({ format: 'jwk' }).x, 'base64url');
const x25519PublicKey = (raw) => createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: raw.toString('base64url') }, format: 'jwk' });
export const keyId = (rawPublic) => createHash('sha256').update(rawPublic).digest().subarray(0, KID_BYTES);

/** The `seal_pubkey` input: 43 base64url characters that are exactly one canonical 32-byte X25519 key. */
export function parsePublicKey(text) {
  if (typeof text !== 'string' || !PUBLIC_KEY_PATTERN.test(text)) {
    throw new SealError('SEAL_KEY', 'the public key must be 43 base64url characters (a raw X25519 key)');
  }
  const raw = Buffer.from(text, 'base64url');
  if (raw.length !== KEY_BYTES || raw.toString('base64url') !== text) {
    throw new SealError('SEAL_KEY', 'the public key is not a canonical 32-byte X25519 key');
  }
  return { raw, key: x25519PublicKey(raw) };
}

/** ECDH then HKDF. A low-order public key makes the derivation fail or yield zeros: refused either way. */
function boxKey(privateKey, publicKey, ephemeralRaw, recipientRaw, code) {
  let shared;
  try {
    shared = diffieHellman({ privateKey, publicKey });
  } catch {
    throw new SealError(code, 'the X25519 key agreement failed (a low-order or damaged key)');
  }
  if (shared.every((byte) => byte === 0)) throw new SealError(code, 'the X25519 key agreement produced no secret');
  const key = Buffer.from(hkdfSync('sha256', shared, Buffer.concat([ephemeralRaw, recipientRaw]), INFO, 32));
  shared.fill(0);
  return key;
}

/** Seal `plaintext` to the recipient's public key (base64url text). Returns the sealed bytes. */
export function sealBuffer(publicKeyText, plaintext) {
  const recipient = parsePublicKey(publicKeyText);
  const ephemeral = generateKeyPairSync('x25519');
  const ephemeralRaw = rawPublicKey(ephemeral.publicKey);
  const key = boxKey(ephemeral.privateKey, recipient.key, ephemeralRaw, recipient.raw, 'SEAL_KEY');
  const nonce = randomBytes(NONCE_BYTES);
  const header = Buffer.concat([MAGIC, Buffer.from([VERSION]), keyId(recipient.raw), ephemeralRaw, nonce]);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(header);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  key.fill(0);
  return Buffer.concat([header, body, cipher.getAuthTag()]);
}

/** Magic, length and version, checked before any key is used. */
export function readSealedHeader(sealed) {
  if (!Buffer.isBuffer(sealed) || sealed.length < MAGIC.length || !sealed.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new SealError('SEAL_FORMAT', 'not a sealed file (no LVSEAL header)');
  }
  if (sealed.length < HEADER_BYTES + TAG_BYTES) throw new SealError('SEAL_FORMAT', 'the sealed file is truncated');
  const version = sealed[MAGIC.length];
  if (version !== VERSION) {
    throw new SealError('SEAL_VERSION', `unsupported seal version ${version}; this tool reads version ${VERSION}`);
  }
  let at = MAGIC.length + 1;
  const kid = sealed.subarray(at, (at += KID_BYTES));
  const ephemeralRaw = sealed.subarray(at, (at += KEY_BYTES));
  const nonce = sealed.subarray(at, (at += NONCE_BYTES));
  return { version, kid: kid.toString('hex'), ephemeralRaw, nonce, header: sealed.subarray(0, HEADER_BYTES) };
}

/** Open a sealed buffer with the recipient's private key (PEM text or a KeyObject). */
export function unsealBuffer(privateKeyInput, sealed) {
  const privateKey = privateKeyInput instanceof KeyObject ? privateKeyInput : createPrivateKey(privateKeyInput);
  if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'x25519') {
    throw new SealError('SEAL_KEY', 'the private key is not an X25519 private key');
  }
  const head = readSealedHeader(sealed);
  const recipientRaw = rawPublicKey(createPublicKey(privateKey));
  const mine = keyId(recipientRaw).toString('hex');
  if (mine !== head.kid) {
    throw new SealError('SEAL_WRONG_KEY', `this file is sealed to key ${head.kid}, and the private key given is ${mine}`);
  }
  const key = boxKey(privateKey, x25519PublicKey(head.ephemeralRaw), head.ephemeralRaw, recipientRaw, 'SEAL_TAMPERED');
  const decipher = createDecipheriv('aes-256-gcm', key, head.nonce, { authTagLength: TAG_BYTES });
  decipher.setAAD(head.header);
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
  try {
    return Buffer.concat([decipher.update(sealed.subarray(HEADER_BYTES, sealed.length - TAG_BYTES)), decipher.final()]);
  } catch {
    throw new SealError('SEAL_TAMPERED', 'the sealed file failed authentication: it was altered or damaged');
  } finally {
    key.fill(0);
  }
}

/** A fresh one-time key pair: the public key as dispatch text, the private key as PKCS#8 PEM. */
export function generateSealKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  const raw = rawPublicKey(publicKey);
  return {
    publicKey: raw.toString('base64url'),
    kid: keyId(raw).toString('hex'),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

/** A private key inside a git checkout is one `git add -A` away from a public repository. */
function refuseGitCheckout(dir) {
  for (let at = dir; ; at = dirname(at)) {
    if (existsSync(join(at, '.git'))) {
      throw new SealError('SEAL_USAGE', `refusing to write a private key inside the git checkout at ${at}`);
    }
    if (dirname(at) === at) return;
  }
}

/** Writes `<dir>/bambu-seal-<kid>.pem` with mode 0600 (never over an existing file). */
export function writeKeyPair(dir) {
  const target = resolve(dir);
  refuseGitCheckout(target);
  mkdirSync(target, { recursive: true, mode: 0o700 });
  const keys = generateSealKeys();
  const file = join(target, `bambu-seal-${keys.kid}.pem`);
  writeFileSync(file, keys.privateKeyPem, { mode: 0o600, flag: 'wx' });
  chmodSync(file, 0o600);
  return { file, publicKey: keys.publicKey, kid: keys.kid };
}

/**
 * Seal one file. The output must end in `.sealed` and must not exist; it
 * appears only complete (written beside it, then renamed). The plaintext is
 * deleted afterwards unless `keep`.
 */
export function sealFile(publicKeyText, input, output, { keep = false } = {}) {
  if (!output.endsWith(SEALED_SUFFIX)) throw new SealError('SEAL_USAGE', `a sealed file's name ends in ${SEALED_SUFFIX}`);
  if (existsSync(output)) throw new SealError('SEAL_USAGE', `${output} already exists`);
  const plaintext = readFileSync(input);
  const sealed = sealBuffer(publicKeyText, plaintext);
  plaintext.fill(0);
  const partial = `${output}.partial`;
  writeFileSync(partial, sealed, { flag: 'wx', mode: 0o600 });
  renameSync(partial, output);
  if (!keep) rmSync(input);
  return { bytes: sealed.length, sha256: createHash('sha256').update(sealed).digest('hex') };
}

const USAGE = [
  'usage: node scripts/bambu-import/seal.mjs --keygen <dir>',
  '       node scripts/bambu-import/seal.mjs --pub <public key> <in> <out.sealed> [--keep]',
].join('\n');

export function main(argv, { log = console.log, error = console.error } = {}) {
  try {
    if (argv[0] === '--keygen' && argv.length === 2) {
      const pair = writeKeyPair(argv[1]);
      error(`seal: private key ${pair.file} (mode 0600, key id ${pair.kid}); it must never leave this machine`);
      log(pair.publicKey);
      return 0;
    }
    const keep = argv.at(-1) === '--keep';
    const args = keep ? argv.slice(0, -1) : argv;
    if (args[0] === '--pub' && args.length === 4) {
      const sealed = sealFile(args[1], args[2], args[3], { keep });
      error(`seal: ${args[3]} (${sealed.bytes} bytes, sha256 ${sealed.sha256})${keep ? '' : '; plaintext deleted'}`);
      return 0;
    }
    error(USAGE);
    return 2;
  } catch (failure) {
    error(`seal: ${failure instanceof Error ? failure.message : String(failure)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
