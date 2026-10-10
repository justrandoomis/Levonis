/**
 * CANARY TOKENS — the trap data a decoy answer carries (owner brief
 * 2026-10-10; design: scratchpad deception/design.md §2.3 and §F1, DECISIONS
 * row 206).
 *
 * THE KEY. Every MAC here (canaries, the device tag, the network keys of
 * ./actors.ts) uses ONE secret: `SECURITY_CANARY_KEY` when it is set, else a
 * key DERIVED from one of the Worker's own secrets (`TELEGRAM_WEBHOOK_SECRET`,
 * `STUDIO_HANDOFF_SECRET`, `TELEGRAM_ADMIN_WEBHOOK_SECRET` — an HMAC of it, so
 * the source never leaves this file). With none of them the layer FAILS CLOSED
 * for canaries and tags: a decoy still answers its fake data, but carries no
 * verifiable token and no tag is minted — there is no built-in key anyone with
 * the source could use to recognise or forge one.
 *
 * THE SHAPE. A token's visible body is the answer's BATCH (40 random bits) and
 * the token's index, ENCRYPTED per kind (a 3-round Feistel over 48 bits whose
 * round function is the HMAC — a pseudo-random permutation), followed by a
 * truncated HMAC over that visible body:
 *
 *   v = E_K,kind(batch ‖ idx)            12 hex, unrelated across kinds and indexes
 *   t = HMAC(K, "lv-canary|v2|t|" + kind + "|" + v)[0:n]
 *
 *   p  product id   prd_ + v + t(8)              = prd_ + 20 hex, the shape of a
 *                   real `newId('prd')`, and no visible counter
 *   k  api key      lvk_live_ + v + t(12) + noise(8)
 *   e  admin e-mail ops. + v + t(6) + @<root domain>
 *   w  password     Lv- + v + t(10)               (idx 0 and 1: two unrelated passwords)
 *   s  session      lvs_ + v + t(18)
 *
 * So no two tokens of one answer share a visible substring; a cheap regex and
 * ONE HMAC reject anything that is not a canary (a real product id costs one
 * HMAC), and three more recover the batch of one that is. No database read to
 * recognise one; a product-shaped one also needs its batch row to block.
 *
 * NEVER A THIRD PARTY'S FORMAT (no AKIA…, ghp_…, sk_live_…, xox…): those trip
 * external secret scanners and could pass for a real leak. NEVER STORED OR
 * LOGGED: a password canary is compared in memory; the batch row keeps the
 * batch id only, and the tokens are recomputed from it.
 */
import type { Env } from '../types';

export type CanaryKind = 'p' | 'k' | 'e' | 'w' | 's';
export type KeyEnv = Partial<Pick<Env, 'SECURITY_CANARY_KEY' | 'TELEGRAM_WEBHOOK_SECRET' | 'STUDIO_HANDOFF_SECRET' | 'TELEGRAM_ADMIN_WEBHOOK_SECRET'>>;

const enc = new TextEncoder();
const keys = new Map<string, Promise<CryptoKey>>();
const DERIVE_SOURCES = ['TELEGRAM_WEBHOOK_SECRET', 'STUDIO_HANDOFF_SECRET', 'TELEGRAM_ADMIN_WEBHOOK_SECRET'] as const;

/** Where this environment's key comes from: its own secret, one derived from another secret, or none (fail closed). */
export function keySource(env: KeyEnv | undefined): 'own' | 'derived' | null {
  if ((env?.SECURITY_CANARY_KEY ?? '').trim()) return 'own';
  return DERIVE_SOURCES.some((n) => (env?.[n] ?? '').trim()) ? 'derived' : null;
}

const hex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');

/** The HMAC key for this environment, imported once per isolate; null when there is none. */
function keyFor(env: KeyEnv | undefined): Promise<CryptoKey> | null {
  const own = (env?.SECURITY_CANARY_KEY ?? '').trim();
  const derivedFrom = own ? '' : (DERIVE_SOURCES.map((n) => (env?.[n] ?? '').trim()).find(Boolean) ?? '');
  if (!own && !derivedFrom) return null;
  const id = own ? `own|${own}` : `derived|${derivedFrom}`;
  let k = keys.get(id);
  if (!k) {
    k = (async () => {
      let raw: Uint8Array = enc.encode(own);
      if (!own) {
        const base = await crypto.subtle.importKey('raw', enc.encode(derivedFrom), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
        raw = new Uint8Array(await crypto.subtle.sign('HMAC', base, enc.encode('levonis-deception-key|v2')));
      }
      return crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    })();
    if (keys.size > 16) keys.clear();
    keys.set(id, k);
  }
  return k;
}

/** HMAC-SHA256(K, message) as 64 hex, or null when the environment has no key. */
export async function hmacHex(env: KeyEnv | undefined, message: string): Promise<string | null> {
  const k = keyFor(env);
  if (!k) return null;
  return hex(await crypto.subtle.sign('HMAC', await k, enc.encode(message)));
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

// ------------------------------------------------------------- the visible body

const H24 = 0xffffff;
const ROUNDS = 3;
const h6 = (n: number) => n.toString(16).padStart(6, '0');

async function feistelRound(env: KeyEnv, kind: CanaryKind, i: number, half: number): Promise<number> {
  const mac = await hmacHex(env, `lv-fe|v2|${kind}|${i}|${h6(half)}`);
  return parseInt((mac ?? '000000').slice(0, 6), 16);
}

/** (batch 10 hex, idx 0..255) → 12 hex: a permutation per (key, kind). */
async function encryptBody(env: KeyEnv, kind: CanaryKind, batch: string, idx: number): Promise<string> {
  const plain = `${batch}${(idx & 0xff).toString(16).padStart(2, '0')}`;
  let l = parseInt(plain.slice(0, 6), 16);
  let r = parseInt(plain.slice(6, 12), 16);
  for (let i = 0; i < ROUNDS; i++) [l, r] = [r, (l ^ (await feistelRound(env, kind, i, r))) & H24];
  return `${h6(l)}${h6(r)}`;
}

/** 12 hex → (batch, idx). */
async function decryptBody(env: KeyEnv, kind: CanaryKind, body: string): Promise<{ batch: string; idx: number }> {
  let l = parseInt(body.slice(0, 6), 16);
  let r = parseInt(body.slice(6, 12), 16);
  for (let i = ROUNDS - 1; i >= 0; i--) [l, r] = [(r ^ (await feistelRound(env, kind, i, l))) & H24, l];
  const plain = `${h6(l)}${h6(r)}`;
  return { batch: plain.slice(0, 10), idx: parseInt(plain.slice(10, 12), 16) };
}

const TAG_LEN: Record<CanaryKind, number> = { p: 8, k: 12, e: 6, w: 10, s: 18 };

async function tagOf(env: KeyEnv, kind: CanaryKind, body: string): Promise<string> {
  return ((await hmacHex(env, `lv-canary|v2|t|${kind}|${body}`)) ?? '').slice(0, TAG_LEN[kind]);
}

async function token(env: KeyEnv, kind: CanaryKind, batch: string, idx: number): Promise<string> {
  const body = await encryptBody(env, kind, batch, idx);
  return `${body}${await tagOf(env, kind, body)}`;
}

// ------------------------------------------------------------- a batch

export interface CanaryBatch {
  batch: string;
  /** False when the environment has no key: the strings are filler, nothing in them verifies. */
  armed: boolean;
  apiKey: string;
  email: string;
  password: string;
  dbPassword: string;
  session: string;
  productIds: string[];
}

/** At most this many product rows a batch carries (idx 0..MAX_PRODUCTS-1). */
export const MAX_PRODUCTS = 16;

/** Deterministic filler hex for an unarmed batch (mulberry32 seeded by the batch and a label). */
function fillerHex(batch: string, label: string, n: number): string {
  let a = (parseInt(batch.slice(0, 8), 16) ^ [...label].reduce((h, ch) => Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0, 2166136261)) >>> 0;
  let out = '';
  while (out.length < n) {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    out += (((t ^ (t >>> 14)) >>> 0) % 16).toString(16);
  }
  return out;
}

/**
 * Every token of one batch. Deterministic for (key, batch, root, count,
 * noise): the owner console regenerates exactly what was served. Without a key
 * the same shapes are filled with filler — the answer looks the same and
 * nothing in it is a canary.
 */
export async function mintBatch(env: KeyEnv | undefined, batch: string, rootDomain: string, productCount: number, keyNoise: string): Promise<CanaryBatch> {
  const count = Math.max(0, Math.min(MAX_PRODUCTS, productCount));
  const noise = keyNoise.slice(0, 8).padEnd(8, '0');
  if (!keySource(env)) {
    const f = (label: string, n: number) => fillerHex(batch, label, n);
    return {
      batch,
      armed: false,
      apiKey: `lvk_live_${f('k', 24)}${noise}`,
      email: `ops.${f('e', 18)}@${rootDomain}`,
      password: `Lv-${f('w0', 22)}`,
      dbPassword: `Lv-${f('w1', 22)}`,
      session: `lvs_${f('s', 30)}`,
      productIds: Array.from({ length: count }, (_, i) => `prd_${f(`p${i}`, 20)}`),
    };
  }
  const e0 = env!;
  const [k, e, w0, w1, s, ...products] = await Promise.all([
    token(e0, 'k', batch, 0),
    token(e0, 'e', batch, 0),
    token(e0, 'w', batch, 0),
    token(e0, 'w', batch, 1),
    token(e0, 's', batch, 0),
    ...Array.from({ length: count }, (_, i) => token(e0, 'p', batch, i)),
  ]);
  const productIds = products.map((p) => `prd_${p}`);
  return {
    batch,
    armed: true,
    apiKey: `lvk_live_${k}${noise}`,
    email: `ops.${e}@${rootDomain}`,
    password: `Lv-${w0}`,
    dbPassword: `Lv-${w1}`,
    session: `lvs_${s}`,
    productIds,
  };
}

// ------------------------------------------------------------- detection

const PATTERNS: ReadonlyArray<{ kind: CanaryKind; re: RegExp }> = [
  { kind: 'k', re: /lvk_live_([0-9a-f]{12})([0-9a-f]{12})[0-9a-f]{8}/g },
  { kind: 's', re: /lvs_([0-9a-f]{12})([0-9a-f]{18})/g },
  { kind: 'w', re: /Lv-([0-9a-f]{12})([0-9a-f]{10})/g },
  { kind: 'e', re: /ops\.([0-9a-f]{12})([0-9a-f]{6})@/gi },
  { kind: 'p', re: /(?<![A-Za-z0-9])prd_([0-9a-f]{12})([0-9a-f]{8})(?![0-9a-f])/g },
];

/** The cheap prefilter: does this text hold anything shaped like a canary? */
const ANY = /lvk_live_|lvs_|Lv-[0-9a-f]|ops\.[0-9a-f]|prd_[0-9a-f]/i;
export const mayHoldCanary = (text: string) => ANY.test(text);

/**
 * Where a canary was presented, strongest first — what a page or a link can
 * never make a visitor's browser send comes first:
 *   credentials  the sign-in doors' body, whatever its content type
 *   header       any request header but Cookie, Referer and Origin
 *   cookie       any cookie (nothing on this site sets one from a URL)
 *   body         a cart / checkout body
 *   url          the path and query — anyone can plant those in a link
 */
export type CanaryWhere = 'credentials' | 'header' | 'cookie' | 'body' | 'url';
export const WHERE_ORDER: readonly CanaryWhere[] = ['credentials', 'header', 'cookie', 'body', 'url'];

export interface FoundCanary {
  kind: CanaryKind;
  batch: string;
  where: CanaryWhere;
}

/**
 * How many candidates are verified (one HMAC each to reject, five to confirm).
 * A product-shaped one is the shape of every real product id, so at most
 * MAX_PRODUCT_CANDIDATES_PER_PLACE of those per place. The other shapes never
 * occur in honest traffic, so up to MAX_STRONG_CANDIDATES of them are checked
 * whatever place they are in — strongest place first — and a request carrying
 * MORE is itself a probe (`flood`): canary-shaped junk to hide a real one.
 */
export const MAX_PRODUCT_CANDIDATES_PER_PLACE = 3;
export const MAX_STRONG_CANDIDATES = 16;

interface Candidate {
  kind: CanaryKind;
  body: string;
  tag: string;
  where: CanaryWhere;
}

interface Budget {
  strong: number;
  product: number;
  /** The place where canary-shaped strings ran past the budget, if any. */
  flood: CanaryWhere | null;
}

function candidatesIn(text: string, where: CanaryWhere, out: Candidate[], budget: Budget): void {
  if (!text || !mayHoldCanary(text)) return;
  for (const { kind, re } of PATTERNS) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const body = m[1]!.toLowerCase();
      const tag = m[2]!.toLowerCase();
      if (out.some((c) => c.kind === kind && c.body === body && c.tag === tag && c.where === where)) continue;
      if (kind === 'p') {
        if (budget.product <= 0) break;
        budget.product -= 1;
      } else {
        if (budget.strong <= 0) {
          budget.flood ??= where;
          return;
        }
        budget.strong -= 1;
      }
      out.push({ kind, body, tag, where });
    }
  }
}

const IDX_OK: Record<CanaryKind, (i: number) => boolean> = {
  p: (i) => i < MAX_PRODUCTS,
  k: (i) => i === 0,
  e: (i) => i === 0,
  s: (i) => i === 0,
  w: (i) => i === 0 || i === 1,
};

/** The verified canaries among these texts, strongest place first, and whether junk flooded the check. Never throws. */
export async function canaryScan(
  env: KeyEnv | undefined,
  texts: ReadonlyArray<readonly [string, CanaryWhere]>
): Promise<{ found: FoundCanary[]; flood: CanaryWhere | null }> {
  try {
    if (!keySource(env)) return { found: [], flood: null };
    const e0 = env!;
    const cands: Candidate[] = [];
    const budget: Budget = { strong: MAX_STRONG_CANDIDATES, product: 0, flood: null };
    for (const where of WHERE_ORDER) {
      budget.product = MAX_PRODUCT_CANDIDATES_PER_PLACE;
      for (const [text, w] of texts) {
        if (w !== where) continue;
        candidatesIn(typeof text === 'string' ? text.slice(0, 65_536) : '', where, cands, budget);
      }
    }
    const found: FoundCanary[] = [];
    for (const c of cands) {
      if ((await tagOf(e0, c.kind, c.body)) !== c.tag) continue;
      const { batch, idx } = await decryptBody(e0, c.kind, c.body);
      if (!IDX_OK[c.kind](idx)) continue;
      if (found.some((f) => f.kind === c.kind && f.batch === batch && f.where === c.where)) continue;
      found.push({ kind: c.kind, batch, where: c.where });
    }
    return { found, flood: budget.flood };
  } catch {
    return { found: [], flood: null };
  }
}

/**
 * The canaries among these texts, verified, strongest place first. A text
 * without a canary-shaped substring costs one regex. Never throws; with no key
 * it finds nothing.
 */
export async function findCanaries(env: KeyEnv | undefined, texts: ReadonlyArray<readonly [string, CanaryWhere]>): Promise<FoundCanary[]> {
  return (await canaryScan(env, texts)).found;
}
