/** IDs, tokens and password hashing built on WebCrypto (native on Workers). */

const enc = new TextEncoder();

export function newId(prefix = ''): string {
  const id = crypto.randomUUID().replace(/-/g, '').slice(0, 20);
  return prefix ? `${prefix}_${id}` : id;
}

export function newOrderId(): string {
  const bytes = new Uint8Array(5);
  crypto.getRandomValues(bytes);
  const s = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  return `ORD-${s}`;
}

export function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return b64url(buf);
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(input));
  return hex(new Uint8Array(digest));
}

function hex(buf: Uint8Array): string {
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function b64url(buf: Uint8Array): string {
  let s = '';
  for (const b of buf) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(s: string): Uint8Array {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Password hashing: PBKDF2-SHA256. Stored as pbkdf2$<iterations>$<salt_b64url>$<hash_b64url>.
// Iterations chosen to stay within Workers CPU limits; see docs/SECURITY.md.
const PBKDF2_ITERATIONS = 100_000;

export async function hashPassword(password: string): Promise<string> {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const derived = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${b64url(salt)}$${b64url(derived)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (!stored) return false;
  if (stored.startsWith('pbkdf2$')) {
    const [, iterStr, saltB64, hashB64] = stored.split('$');
    const iterations = parseInt(iterStr, 10);
    if (!iterations || iterations > 1_000_000) return false;
    const derived = await pbkdf2(password, b64urlDecode(saltB64), iterations);
    return timingSafeEqual(derived, b64urlDecode(hashB64));
  }
  if (stored.startsWith('$2a$') || stored.startsWith('$2b$') || stored.startsWith('$2y$')) {
    // Legacy bcrypt hash from the previous Express server. Verified with
    // bcryptjs (pure JS); callers re-hash to PBKDF2 on successful login.
    const { default: bcrypt } = await import('bcryptjs');
    return bcrypt.compare(password, stored);
  }
  return false;
}

export function isLegacyHash(stored: string): boolean {
  return !stored.startsWith('pbkdf2$');
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    key,
    256
  );
  return new Uint8Array(bits);
}

export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
