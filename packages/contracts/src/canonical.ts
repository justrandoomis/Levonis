/**
 * Canonical JSON — the byte form every signature in the platform is computed
 * over (event envelopes, hop envelopes, principals). Object keys are sorted
 * recursively, arrays keep their order, `undefined` members are dropped (as
 * JSON.stringify does), and non-finite numbers are refused because they would
 * serialise to `null` and silently change what was signed.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite number');
    if (typeof value === 'bigint') throw new TypeError('canonicalJson: bigint is not JSON');
    return value;
  }
  if (Array.isArray(value)) return value.map(sortValue);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const v = (value as Record<string, unknown>)[key];
    if (v !== undefined) out[key] = sortValue(v);
  }
  return out;
}

const encoder = new TextEncoder();

export function utf8(s: string): Uint8Array {
  return encoder.encode(s);
}

export function bytesToHex(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = '';
  for (const b of arr) out += b.toString(16).padStart(2, '0');
  return out;
}

/** SHA-256 of a string, hex. WebCrypto, so it runs unchanged on Workers and Node. */
export async function sha256Hex(input: string): Promise<string> {
  return bytesToHex(await crypto.subtle.digest('SHA-256', utf8(input)));
}

/** `sha256(canonical(value))` — the `args_hash` / `payload_hash` form used by every contract. */
export async function canonicalHash(value: unknown): Promise<string> {
  return sha256Hex(canonicalJson(value));
}

export function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (const b of arr) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function b64urlJson(value: unknown): string {
  return b64url(utf8(canonicalJson(value)));
}

export function parseB64urlJson(s: string): unknown {
  return JSON.parse(new TextDecoder().decode(b64urlDecode(s)));
}
