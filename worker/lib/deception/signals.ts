/**
 * MANIPULATION SIGNALS AND SCORES (design §3.3, §F1).
 *
 * Each actor key (`u:`, `d:`, `n:` — ./actors.ts) has a score that HALVES
 * EVERY SIX HOURS; 100 opens an incident. Weights are integers:
 *
 *   CANARY_USED          instant block (./canary.ts) — from a place no link reaches
 *   DECOY_HIT            instant block from a tool; 60 LINKABLE from a browser
 *   CANARY_LINKED         60  LINKABLE: a canary in a URL a browser opened or echoed
 *   CLIENT_PRICE_FIELDS   50  a price, cost, total, discount, profit, margin or
 *                             amount key sent to cart / checkout / quote — no
 *                             route reads one; the server keeps ignoring it
 *   CANARY_FLOOD          50  more canary-shaped strings than are verified
 *   CANARY_UNCONFIRMED    30  a valid-MAC product id with no batch row
 *   INJECTION_PATTERN     25  SQL / script / traversal shapes in the URL
 *   TAMPER_PARAMS         20  role / admin / debug / cost-revealing switches on a non-admin API route
 *   AUTH_BRUTE_FORCE      15  ALWAYS LINKABLE, never on a network key: a 429 on a
 *                             sign-in bucket (a CGNAT address shares that bucket)
 *   ADMIN_ROUTE_GUESS     10  ALWAYS LINKABLE: a non-admin at an /api/admin path no route serves
 *   IDOR_PROBE             5  a signed-in non-admin refused on another's record
 *   ADMIN_REFUSED          3  ALWAYS LINKABLE: a non-admin refused at a real /api/admin route
 *
 * LINKABLE evidence — what a link, a shared address or the deploy's own probes
 * can produce without the actor meaning it — raises a score at most to
 * LINKABLE_CAP (99): it is recorded and it counts, but it never opens an
 * incident on its own. Only hard evidence (a tool's request, a price field, a
 * canary where no link reaches) can carry a score over the threshold. So two
 * planted links clicked, a carrier's shared address, or workflow 7's probes
 * from a runner reused across deploys and isolates never block anyone.
 */
export const THRESHOLD = 100;
export const LINKABLE_CAP = THRESHOLD - 1;
export const HALF_LIFE_HOURS = 6;

export const WEIGHTS = {
  DECOY_HIT: 100,
  DECOY_LINKED: 60,
  CANARY_LINKED: 60,
  CANARY_FLOOD: 50,
  CLIENT_PRICE_FIELDS: 50,
  CANARY_UNCONFIRMED: 30,
  INJECTION_PATTERN: 25,
  TAMPER_PARAMS: 20,
  AUTH_BRUTE_FORCE: 15,
  ADMIN_ROUTE_GUESS: 10,
  IDOR_PROBE: 5,
  ADMIN_REFUSED: 3,
} as const;
export type SignalCode = keyof typeof WEIGHTS;

/** The decayed score: one halving per whole six-hour step. The SQL upsert computes the same. */
export function decayed(score: number, updatedAtMs: number, nowMs: number): number {
  const steps = Math.max(0, Math.min(30, Math.floor(((nowMs - updatedAtMs) / 3_600_000) / HALF_LIFE_HOURS)));
  return Math.floor(score / 2 ** steps);
}

// ------------------------------------------------------------- client price fields

/** A key no watched body may carry (camelCase and snake_case alike). */
export const PRICE_KEY = /^(unit_?|line_?|final_?|sub_?)?(price|cost|total|subtotal|discount|profit|margin|amount)(_?(iqd|usd|value|amount))?$/i;

/**
 * The cart, checkout and quote doors (design §1.8): POST/PATCH bodies whose
 * money is decided on the server. Path patterns, matched on the request path.
 */
const WATCHED_BODIES: ReadonlyArray<RegExp> = [
  /^\/api\/cart\/items(?:\/[^/]+)?$/,
  /^\/api\/cart\/merchant-items(?:\/[^/]+)?$/,
  /^\/api\/cart\/gift-items$/,
  /^\/api\/cart\/coupon-check$/,
  /^\/api\/orders\/?$/,
  /^\/api\/orders\/quote$/,
  /^\/api\/quick-buy\/items(?:\/[^/]+)?$/,
  /^\/api\/store-orders(?:\/quote)?\/?$/,
];
export function watchedBody(method: string, path: string): boolean {
  return (method === 'POST' || method === 'PATCH') && WATCHED_BODIES.some((re) => re.test(path));
}

/** The NAMES of price-like keys with a non-null value, at depth ≤ 3. */
export function priceFieldsIn(body: unknown): string[] {
  const out = new Set<string>();
  const walk = (v: unknown, depth: number) => {
    if (depth > 3 || out.size >= 12 || v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      for (const x of v.slice(0, 50)) walk(x, depth + 1);
      return;
    }
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (x !== null && x !== undefined && PRICE_KEY.test(k)) out.add(k.slice(0, 64));
      walk(x, depth + 1);
    }
  };
  walk(body, 1);
  return [...out];
}

// ------------------------------------------------------------- injection, tamper

/** Injection shapes. Arabic and Sorani search text cannot match any of them. */
export const INJECTION_RE =
  /union\s+(?:all\s+)?select|select\s.+\sfrom\s.+\swhere\s|'\s*or\s+'?\d|\bor\s+1\s*=\s*1|;\s*drop\s+table|sleep\s*\(\s*\d|benchmark\s*\(|waitfor\s+delay|<\s*script\b|javascript:|onerror\s*=|\.\.\/|%2e%2e|%00|\$\{jndi:|\/etc\/passwd/i;

/** The URL as it may carry an injection: path and query, decoded once, at most 2 KB. */
export function injectionIn(rawUrl: string): boolean {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  const raw = `${u.pathname}${u.search}`.slice(0, 2048);
  if (INJECTION_RE.test(raw)) return true;
  try {
    return INJECTION_RE.test(decodeURIComponent(raw.replace(/\+/g, ' ')));
  } catch {
    return false;
  }
}

const TAMPER_KEYS = new Set(['role', 'is_admin', 'isadmin', 'admin', 'admin_scope', 'debug']);
const REVEAL_KEYS = new Set(['include', 'fields', 'expand']);
const COSTISH = /cost|margin|profit|supplier|landed|internal|private/i;

/** Query switches no customer route reads — on a non-admin API route only. */
export function tamperParams(path: string, search: URLSearchParams): string[] {
  if (!path.startsWith('/api/') || path.startsWith('/api/admin')) return [];
  const out: string[] = [];
  for (const [k, v] of search) {
    const key = k.toLowerCase();
    if (TAMPER_KEYS.has(key) || (REVEAL_KEYS.has(key) && COSTISH.test(v))) out.push(key.slice(0, 32));
    if (out.length >= 6) break;
  }
  return [...new Set(out)];
}

// ------------------------------------------------------------- refusals

/** The sign-in buckets whose 429 is brute force (worker/routes/auth.ts). */
export const AUTH_BUCKETS: readonly string[] = [
  'login',
  'login-id',
  'otp-start',
  'otp-verify',
  'forgot',
  'forgot-id',
  'reset',
  'verify-email-confirm',
  'change-password',
  'register-id',
  'otp-signup-complete',
];
export function authBucket(bucket: string | null): boolean {
  return !!bucket && (AUTH_BUCKETS.includes(bucket) || bucket.startsWith('tg-auth') || bucket.startsWith('otp-start-'));
}

/** The prefixes where a signed-in non-admin's 403/404 on a `:param` route is someone else's record. */
export const IDOR_PREFIXES: readonly string[] = [
  '/api/orders/',
  '/api/invoices/',
  '/api/devices/',
  '/api/returns/',
  '/api/gifts/',
  '/api/chats/',
  '/api/addresses/',
  '/api/trade-in/',
  '/api/store-orders/',
  '/api/marketplace/orders/',
];
export const idorPath = (path: string) => IDOR_PREFIXES.some((p) => path.startsWith(p));

// ------------------------------------------------------------- the score row

const isMissingTable = (e: unknown) => /no such table/i.test(e instanceof Error ? e.message : String(e));

/** The signals that are linkable whatever the request looked like (see the table above). */
export const ALWAYS_LINKABLE: ReadonlySet<SignalCode> = new Set<SignalCode>(['AUTH_BRUTE_FORCE', 'ADMIN_ROUTE_GUESS', 'ADMIN_REFUSED']);

/**
 * One atomic upsert per signal per actor key: step decay (one halving per six
 * hours), the weight added, the signal's counter raised. A LINKABLE signal
 * (`cap` = LINKABLE_CAP) raises the score at most to the cap and never lowers
 * one hard evidence already put above it. Returns the new score, or null when
 * the table is absent or the write failed. Never throws.
 */
export async function bumpScore(db: D1Database, actorKey: string, signal: string, weight: number, now: Date, cap: number | null = null): Promise<number | null> {
  try {
    const row = await db
      .prepare(
        `INSERT INTO security_scores (actor_key, score, updated_at, signals)
           VALUES (?1, CASE WHEN ?5 IS NULL THEN ?2 ELSE MIN(?2, ?5) END, ?3, json_object(?4, 1))
         ON CONFLICT(actor_key) DO UPDATE SET
           score = MIN(100000, CASE WHEN ?5 IS NULL
             THEN (score >> MIN(30, MAX(0, CAST((julianday(?3) - julianday(updated_at)) * 4 AS INTEGER)))) + ?2
             ELSE MAX(score >> MIN(30, MAX(0, CAST((julianday(?3) - julianday(updated_at)) * 4 AS INTEGER))),
                      MIN(?5, (score >> MIN(30, MAX(0, CAST((julianday(?3) - julianday(updated_at)) * 4 AS INTEGER)))) + ?2))
           END),
           updated_at = ?3,
           signals = json_set(signals, '$.' || ?4, COALESCE(json_extract(signals, '$.' || ?4), 0) + 1)
         RETURNING score`
      )
      .bind(actorKey.slice(0, 70), Math.max(0, Math.floor(weight)), now.toISOString(), signal, cap === null ? null : Math.max(0, Math.floor(cap)))
      .first<{ score: number }>();
    return row ? Number(row.score) : null;
  } catch (e) {
    if (!isMissingTable(e)) console.error('security score not written:', e instanceof Error ? e.name : 'unknown');
    return null;
  }
}

/** Sets the actor keys' scores back to zero (a lift). Never throws. */
export async function resetScores(db: D1Database, actorKeys: readonly string[], now: Date): Promise<void> {
  if (actorKeys.length === 0) return;
  try {
    await db.batch(
      actorKeys.map((k) => db.prepare('UPDATE security_scores SET score = 0, updated_at = ? WHERE actor_key = ?').bind(now.toISOString(), k))
    );
  } catch {
    /* never in the way */
  }
}
