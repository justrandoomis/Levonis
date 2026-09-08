/**
 * The signing half of `packages/platform-kit/src/keys.ts`, in plain ESM.
 *
 * WHY A SECOND COPY EXISTS. `scripts/e2e-dark.mjs` runs under plain `node`
 * (that is how `verify-dark.yml` invokes it), and `@levonis/contracts` and
 * `@levonis/platform-kit` publish TypeScript sources — `node` cannot import
 * them. The end-to-end run has to mint a REAL Ed25519 principal, because the
 * only honest way to read Audit's and Analytics' admin surfaces is through the
 * authorisation path those services actually run (`verifyPrincipal` against a
 * key ring built from `ALLOWED_CALLER_KIDS`). Signing it here is the one
 * remaining option.
 *
 * A COPY IS A LIABILITY, so it is pinned: `tests/e2eSigning.test.ts` signs the
 * same payload with this module and with `@levonis/platform-kit/keys` and
 * fails on any byte of difference, and hands what this mints to
 * `verifyPrincipal` itself. If the canonical form or the token layout ever
 * changes, that test goes red before this file can lie.
 *
 * NOTHING HERE READS OR PRINTS A REPOSITORY SECRET. The key pair is generated
 * per run, lives in the local `--persist-to` directory (git-ignored) and is
 * handed to the local `wrangler dev` as a var. It never leaves the machine.
 */

const ALG = { name: 'Ed25519' };

/** `packages/contracts/src/canonical.ts` — sorted keys, dropped `undefined`, no non-finite numbers. */
export function canonicalJson(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite number');
    if (typeof value === 'bigint') throw new TypeError('canonicalJson: bigint is not JSON');
    return value;
  }
  if (Array.isArray(value)) return value.map(sortValue);
  const out = {};
  for (const key of Object.keys(value).sort()) {
    const v = value[key];
    if (v !== undefined) out[key] = sortValue(v);
  }
  return out;
}

export function b64url(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (const b of arr) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(s) {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const utf8 = (s) => new TextEncoder().encode(s);

function bytesToHex(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = '';
  for (const b of arr) out += b.toString(16).padStart(2, '0');
  return out;
}

/** `kid` = the first 16 hex characters of sha256(raw public key) — the kit's rule. */
export async function kidOf(rawPublicKey) {
  return bytesToHex(await crypto.subtle.digest('SHA-256', rawPublicKey)).slice(0, 16);
}

/** A fresh pair: `{ kid, privateKeyB64 (PKCS#8), publicKeyB64 (raw 32 bytes) }`. */
export async function generateKeyPair() {
  const pair = await crypto.subtle.generateKey(ALG, true, ['sign', 'verify']);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  return { kid: await kidOf(raw), privateKeyB64: b64url(pkcs8), publicKeyB64: b64url(raw) };
}

export async function importSigningKey(privateKeyB64, publicKeyB64) {
  const privateKey = await crypto.subtle.importKey('pkcs8', b64urlDecode(privateKeyB64), ALG, false, ['sign']);
  const raw = b64urlDecode(publicKeyB64);
  return { kid: await kidOf(raw), privateKey, publicKeyB64 };
}

/** `b64url(header).b64url(payload).b64url(sig)` with `alg:'EdDSA'` — the kit's `signCompact`. */
export async function signCompact(key, payload) {
  const h = b64url(utf8(canonicalJson({ alg: 'EdDSA', kid: key.kid })));
  const p = b64url(utf8(canonicalJson(payload)));
  const sig = b64url(await crypto.subtle.sign(ALG, key.privateKey, utf8(`${h}.${p}`)));
  return `${h}.${p}.${sig}`;
}

/**
 * A principal exactly as `IdentityEntrypoint.resolveSession` mints one
 * (`packages/platform-kit/src/principal.ts` — `principalCheck` refuses any
 * other shape, so this is the whole claim set, not a subset).
 */
export function buildPrincipal(input, nowSeconds, ttlSeconds = 120) {
  return {
    v: 1,
    sub: input.sub,
    sid_hash: input.sid_hash ?? null,
    role: input.role,
    scope: input.scope ?? null,
    investor: input.investor ?? false,
    tier: input.tier ?? null,
    locale: input.locale ?? null,
    host_kind: input.host_kind ?? 'main',
    iat: nowSeconds,
    exp: nowSeconds + ttlSeconds,
    cid: input.cid,
  };
}
