/**
 * CANARY TOKENS — the trap data a decoy answer carries (owner brief
 * 2026-10-10; design: scratchpad deception/design.md §2.3, DECISIONS row 206).
 *
 * Every token of one decoy answer embeds that answer's BATCH id (10 hex, 40
 * random bits) and a truncated HMAC over its kind, the batch and an index:
 *
 *   mac(kind, batch, idx) = HMAC-SHA256(K, "lv-canary|v1|" + kind + "|" + batch + "|" + idx)
 *
 * K is the optional Worker secret `SECURITY_CANARY_KEY`, else the built-in
 * pepper. So a token is SELF-VERIFYING: a cheap regex finds a candidate and
 * one HMAC confirms it — no database read to recognise a canary.
 *
 *   p  product id   prd_ + batch(10) + idx(2) + mac(8)       = prd_ + 20 hex, the
 *                   shape of a real `newId('prd')` — the one kind that can
 *                   collide with a real id, so it blocks only once its batch
 *                   row is found (one indexed read, only on a MAC hit)
 *   k  api key      lvk_live_ + batch(10) + mac(14) + noise(8)
 *   e  admin e-mail ops. + batch(10) + mac(6) + @<root domain>
 *   w  password     Lv- + batch(10) + - + mac(10)            (idx 0 and 1)
 *   s  session      lvs_ + batch(10) + mac(20)
 *
 * NEVER A THIRD PARTY'S FORMAT (no AKIA…, ghp_…, sk_live_…, xox…): those trip
 * external secret scanners and could pass for a real leak. NEVER STORED OR
 * LOGGED: a password canary is compared in memory; the batch row keeps the
 * batch id only, and the tokens are recomputed from it.
 *
 * FORGING buys nothing: with the pepper known anyone can mint a valid canary,
 * and a forged canary only gets its own sender blocked — which a decoy hit
 * already does. Setting the secret is recommended, not required.
 */
import type { Env } from '../types';

export const CANARY_PEPPER = 'levonis-deception-v1';
export type CanaryKind = 'p' | 'k' | 'e' | 'w' | 's';

const enc = new TextEncoder();
const keys = new Map<string, Promise<CryptoKey>>();

/** The HMAC key for this environment, imported once per isolate. */
function keyFor(env: Pick<Env, 'SECURITY_CANARY_KEY'> | undefined): Promise<CryptoKey> {
  const secret = (env?.SECURITY_CANARY_KEY ?? '').trim() || CANARY_PEPPER;
  let k = keys.get(secret);
  if (!k) {
    k = crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    keys.set(secret, k);
  }
  return k;
}

const hex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');

/** HMAC-SHA256(K, message) as 64 hex. */
export async function hmacHex(env: Pick<Env, 'SECURITY_CANARY_KEY'> | undefined, message: string): Promise<string> {
  return hex(await crypto.subtle.sign('HMAC', await keyFor(env), enc.encode(message)));
}

async function canaryMac(env: Pick<Env, 'SECURITY_CANARY_KEY'> | undefined, kind: CanaryKind, batch: string, idx: string): Promise<string> {
  return hmacHex(env, `lv-canary|v1|${kind}|${batch}|${idx}`);
}

/** `n` random bytes as hex. */
export function randomHex(bytes: number): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/** A new batch id: 10 hex, 40 random bits per decoy answer. */
export const newBatchId = () => randomHex(5);
export const isBatchId = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{10}$/.test(v);

export interface CanaryBatch {
  batch: string;
  apiKey: string;
  email: string;
  password: string;
  dbPassword: string;
  session: string;
  productIds: string[];
}

/**
 * Every token of one batch. Deterministic for (key, batch, root, count,
 * noise): the owner console regenerates exactly what was served.
 */
export async function mintBatch(
  env: Pick<Env, 'SECURITY_CANARY_KEY'> | undefined,
  batch: string,
  rootDomain: string,
  productCount: number,
  keyNoise: string
): Promise<CanaryBatch> {
  const [k, e, w0, w1, s] = await Promise.all([
    canaryMac(env, 'k', batch, '0'),
    canaryMac(env, 'e', batch, '0'),
    canaryMac(env, 'w', batch, '0'),
    canaryMac(env, 'w', batch, '1'),
    canaryMac(env, 's', batch, '0'),
  ]);
  const productIds: string[] = [];
  for (let i = 0; i < productCount; i++) {
    const idx = i.toString(16).padStart(2, '0');
    productIds.push(`prd_${batch}${idx}${(await canaryMac(env, 'p', batch, idx)).slice(0, 8)}`);
  }
  return {
    batch,
    apiKey: `lvk_live_${batch}${k.slice(0, 14)}${keyNoise.slice(0, 8).padEnd(8, '0')}`,
    email: `ops.${batch}${e.slice(0, 6)}@${rootDomain}`,
    password: `Lv-${batch}-${w0.slice(0, 10)}`,
    dbPassword: `Lv-${batch}-${w1.slice(0, 10)}`,
    session: `lvs_${batch}${s.slice(0, 20)}`,
    productIds,
  };
}

// ------------------------------------------------------------- detection

const PATTERNS: ReadonlyArray<{ kind: CanaryKind; re: RegExp }> = [
  { kind: 'k', re: /lvk_live_([0-9a-f]{10})([0-9a-f]{14})[0-9a-f]{8}/g },
  { kind: 's', re: /lvs_([0-9a-f]{10})([0-9a-f]{20})/g },
  { kind: 'w', re: /Lv-([0-9a-f]{10})-([0-9a-f]{10})/g },
  { kind: 'e', re: /ops\.([0-9a-f]{10})([0-9a-f]{6})@/gi },
  { kind: 'p', re: /(?<![A-Za-z0-9])prd_([0-9a-f]{10})([0-9a-f]{2})([0-9a-f]{8})(?![0-9a-f])/g },
];

/** The cheap prefilter: does this text hold anything shaped like a canary? */
const ANY = /lvk_live_|lvs_|Lv-[0-9a-f]|ops\.[0-9a-f]|prd_[0-9a-f]/i;
export const mayHoldCanary = (text: string) => ANY.test(text);

export interface FoundCanary {
  kind: CanaryKind;
  batch: string;
  /** Where it was presented: url | header | cookie | credentials | body. */
  where: CanaryWhere;
}
export type CanaryWhere = 'url' | 'header' | 'cookie' | 'credentials' | 'body';

/** At most this many candidates are verified per request — one HMAC each (two for a password). */
export const MAX_CANDIDATES = 3;

interface Candidate {
  kind: CanaryKind;
  batch: string;
  tag: string;
  idx: string;
  where: CanaryWhere;
}

function candidatesIn(text: string, where: CanaryWhere, out: Candidate[]): void {
  if (!text || !mayHoldCanary(text)) return;
  for (const { kind, re } of PATTERNS) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      if (out.length >= MAX_CANDIDATES) return;
      const batch = m[1]!.toLowerCase();
      if (kind === 'p') out.push({ kind, batch, idx: m[2]!, tag: m[3]!, where });
      else out.push({ kind, batch, idx: '0', tag: m[2]!.toLowerCase(), where });
    }
  }
}

const TAG_LEN: Record<CanaryKind, number> = { p: 8, k: 14, e: 6, w: 10, s: 20 };

async function verify(env: Pick<Env, 'SECURITY_CANARY_KEY'> | undefined, c: Candidate): Promise<boolean> {
  const n = TAG_LEN[c.kind];
  if (c.kind === 'w') {
    for (const idx of ['0', '1']) if ((await canaryMac(env, 'w', c.batch, idx)).slice(0, n) === c.tag) return true;
    return false;
  }
  return (await canaryMac(env, c.kind, c.batch, c.idx)).slice(0, n) === c.tag;
}

/**
 * The canaries among these texts, verified. A text without a canary-shaped
 * substring costs one regex; at most MAX_CANDIDATES candidates are checked.
 * Never throws.
 */
export async function findCanaries(
  env: Pick<Env, 'SECURITY_CANARY_KEY'> | undefined,
  texts: ReadonlyArray<readonly [string, CanaryWhere]>
): Promise<FoundCanary[]> {
  try {
    const cands: Candidate[] = [];
    for (const [text, where] of texts) {
      if (cands.length >= MAX_CANDIDATES) break;
      candidatesIn(typeof text === 'string' ? text.slice(0, 4096) : '', where, cands);
    }
    const out: FoundCanary[] = [];
    for (const c of cands) {
      if (out.some((f) => f.kind === c.kind && f.batch === c.batch)) continue;
      if (await verify(env, c)) out.push({ kind: c.kind, batch: c.batch, where: c.where });
    }
    return out;
  } catch {
    return [];
  }
}
