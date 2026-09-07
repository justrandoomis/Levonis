/**
 * Ed25519 via WebCrypto — the one signing primitive behind principals, hop
 * envelopes and event signatures. Runs unchanged on Workers and Node >= 20.
 *
 * Secret format (`<SVC>_SIGNING_KEY`, `IDENTITY_SIGNING_KEY`): base64url of the
 * PKCS#8 DER private key. Public keys travel as base64url raw 32 bytes and are
 * identified by `kid` = first 16 hex chars of sha256(raw public key).
 */
import { b64url, b64urlDecode, bytesToHex, utf8, canonicalJson } from '@levonis/contracts/canonical';

const ALG = { name: 'Ed25519' } as const;

export interface SigningKey {
  kid: string;
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  publicKeyB64: string;
}

export interface VerifyKey {
  kid: string;
  publicKey: CryptoKey;
}

export interface KeyPairMaterial {
  kid: string;
  /** base64url(PKCS#8) — a SECRET; hand it to `wrangler secret put`, never log it */
  privateKeyB64: string;
  /** base64url(raw 32 bytes) — registered in `service_keys` / `ALLOWED_CALLER_KIDS` */
  publicKeyB64: string;
}

export async function kidOf(rawPublicKey: Uint8Array): Promise<string> {
  return bytesToHex(await crypto.subtle.digest('SHA-256', rawPublicKey as BufferSource)).slice(0, 16);
}

/** Generates a fresh pair. Used by the deploy tooling and by tests; the private half must never be printed. */
export async function generateKeyPair(): Promise<KeyPairMaterial> {
  const pair = (await crypto.subtle.generateKey(ALG, true, ['sign', 'verify'])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer);
  const pkcs8 = new Uint8Array((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer);
  return { kid: await kidOf(raw), privateKeyB64: b64url(pkcs8), publicKeyB64: b64url(raw) };
}

export async function importSigningKey(privateKeyB64: string, publicKeyB64: string): Promise<SigningKey> {
  const privateKey = await crypto.subtle.importKey('pkcs8', b64urlDecode(privateKeyB64) as BufferSource, ALG, false, ['sign']);
  const raw = b64urlDecode(publicKeyB64);
  const publicKey = await crypto.subtle.importKey('raw', raw as BufferSource, ALG, true, ['verify']);
  return { kid: await kidOf(raw), privateKey, publicKey, publicKeyB64 };
}

export async function importVerifyKey(publicKeyB64: string): Promise<VerifyKey> {
  const raw = b64urlDecode(publicKeyB64);
  return { kid: await kidOf(raw), publicKey: await crypto.subtle.importKey('raw', raw as BufferSource, ALG, true, ['verify']) };
}

export async function signBytes(key: SigningKey, bytes: Uint8Array): Promise<string> {
  return b64url(await crypto.subtle.sign(ALG, key.privateKey, bytes as BufferSource));
}

export async function verifyBytes(key: VerifyKey, bytes: Uint8Array, sigB64: string): Promise<boolean> {
  try {
    return await crypto.subtle.verify(ALG, key.publicKey, b64urlDecode(sigB64) as BufferSource, bytes as BufferSource);
  } catch {
    return false;
  }
}

/** Compact JWS-like token: `b64url(header).b64url(payload).b64url(sig)` with `alg: 'EdDSA'`. */
export async function signCompact(key: SigningKey, payload: unknown): Promise<string> {
  const h = b64url(utf8(canonicalJson({ alg: 'EdDSA', kid: key.kid })));
  const p = b64url(utf8(canonicalJson(payload)));
  const sig = await signBytes(key, utf8(`${h}.${p}`));
  return `${h}.${p}.${sig}`;
}

export interface CompactParts {
  header: { alg: string; kid: string };
  payload: unknown;
  signingInput: string;
  sig: string;
}

export function parseCompact(token: string): CompactParts | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[0]))) as { alg?: unknown; kid?: unknown };
    if (header.alg !== 'EdDSA' || typeof header.kid !== 'string') return null;
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1]))) as unknown;
    return { header: { alg: 'EdDSA', kid: header.kid }, payload, signingInput: `${parts[0]}.${parts[1]}`, sig: parts[2] };
  } catch {
    return null;
  }
}

/** A registry of verify keys by kid — Identity's published keys or the `ALLOWED_CALLER_KIDS` bootstrap list. */
export class KeyRing {
  private readonly keys = new Map<string, VerifyKey & { service: string }>();

  async add(service: string, publicKeyB64: string): Promise<string> {
    const k = await importVerifyKey(publicKeyB64);
    this.keys.set(k.kid, { ...k, service });
    return k.kid;
  }

  get(kid: string): (VerifyKey & { service: string }) | undefined {
    return this.keys.get(kid);
  }

  has(kid: string): boolean {
    return this.keys.has(kid);
  }

  kids(): string[] {
    return [...this.keys.keys()];
  }

  /**
   * Parses the bootstrap var `ALLOWED_CALLER_KIDS` — `service:kid:publicKeyB64,...`
   * — used before Identity's `service_keys` registry exists.
   */
  static async fromAllowlist(value: string | undefined): Promise<KeyRing> {
    const ring = new KeyRing();
    for (const entry of (value ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
      const [service, kid, pub] = entry.split(':');
      if (!service || !kid || !pub) throw new Error('ALLOWED_CALLER_KIDS: expected service:kid:publicKey entries');
      const actual = await ring.add(service, pub);
      if (actual !== kid) throw new Error(`ALLOWED_CALLER_KIDS: kid ${kid} does not match the key for ${service}`);
    }
    return ring;
  }
}

/** Constant-time string comparison (health probe tokens, nonces). */
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = utf8(a);
  const bb = utf8(b);
  let diff = ab.length ^ bb.length;
  const n = Math.max(ab.length, bb.length, 1);
  for (let i = 0; i < n; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}
