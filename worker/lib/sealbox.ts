/**
 * Application-layer encryption for sensitive identity fields (KYC name/DOB)
 * — final-phase §1/§9. AES-256-GCM via WebCrypto with a versioned key from
 * the KYC_ENC_KEY worker secret ("v1:<base64 32 bytes>"; rotation adds
 * "v2:<...>" while v1 stays readable). This is server-side protection with
 * managed keys — it is NOT end-to-end encryption and is never described as
 * such. Ciphertext format: sealed:<keyver>:<iv_b64url>:<ct_b64url>.
 */

import { b64url, b64urlDecode } from './crypto';

interface KeyRing {
  current: string;
  keys: Map<string, CryptoKey>;
}

async function importKeys(secret: string): Promise<KeyRing> {
  const keys = new Map<string, CryptoKey>();
  let current = '';
  for (const part of secret.split(',')) {
    const [ver, b64] = part.trim().split(':');
    if (!ver || !b64) continue;
    const rawStr = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
    if (rawStr.length !== 32) continue;
    const raw = new Uint8Array([...rawStr].map((ch) => ch.charCodeAt(0)));
    const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
    keys.set(ver, key);
    current = ver; // last listed key encrypts new data
  }
  return { current, keys };
}

export function sealboxConfigured(secret: string | undefined): boolean {
  return !!secret && secret.includes(':');
}

export async function seal(secret: string | undefined, plaintext: string): Promise<string> {
  if (!sealboxConfigured(secret)) {
    throw new Error('KYC_ENC_KEY is not configured'); // caller shows an honest 503
  }
  const ring = await importKeys(secret as string);
  const key = ring.keys.get(ring.current);
  if (!key) throw new Error('KYC_ENC_KEY invalid');
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    new TextEncoder().encode(plaintext)
  );
  return `sealed:${ring.current}:${b64url(iv)}:${b64url(new Uint8Array(ct))}`;
}

export async function unseal(secret: string | undefined, sealed: string): Promise<string | null> {
  if (!sealed || !sealed.startsWith('sealed:')) return null;
  if (!sealboxConfigured(secret)) return null;
  const [, ver, ivB64, ctB64] = sealed.split(':');
  const ring = await importKeys(secret as string);
  const key = ring.keys.get(ver);
  if (!key) return null; // unknown key version — surfaced as unreadable, never a crash
  try {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64urlDecode(ivB64) as BufferSource },
      key,
      b64urlDecode(ctB64) as BufferSource
    );
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}
