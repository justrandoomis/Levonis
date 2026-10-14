/**
 * THE CLEAN START IN ROUTE TESTS (addendum A.12.1, DECISIONS row 222).
 *
 * Every product a test seeds as raw rows is legacy-priced, so the listing
 * predicate hides it until its first complete V2 write. `stubApp` calls
 * `autoPublishV2` before every customer-facing request (never on
 * /api/admin/*, where a V2 product changes the save's contract): each
 * ordinary product not yet V2-published is published through the REAL writer
 * (`publishV2`, price-first, reproducing its current direct price at the
 * fixture U = 1,500), so a seeded catalogue stays sellable and every price on
 * a rounding step stays exact. A product with no dinar price, or one the writer
 * cannot publish (an incomplete structure), stays hidden, as on the live site. Compositions
 * wait for Q7 and are never published.
 *
 * Opt out with `stubApp(…, { publishV2: false })` — the cut-over tests that
 * prove the hiding itself do.
 */
import { DatabaseSync } from 'node:sqlite';
import { publishV2 } from './v2Publish';

const failed = new WeakMap<DatabaseSync, Set<string>>();
const ready = new WeakMap<DatabaseSync, boolean>();

/** The node:sqlite database behind a SqliteD1 — through any test wrapper (FailingD1, LimitD1, WavesD1…) that keeps it as `inner`. */
const rawOf = (db: unknown, depth = 0): DatabaseSync | null => {
  if (!db || typeof db !== 'object' || depth > 4) return null;
  const o = db as { db?: unknown; inner?: unknown };
  if (o.db instanceof DatabaseSync) return o.db;
  return rawOf(o.inner, depth + 1) ?? (o.db && o.db !== db ? rawOf(o.db, depth + 1) : null);
};

function installed(raw: DatabaseSync): boolean {
  const known = ready.get(raw);
  if (known) return true;
  const n = raw
    .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('pricing_v2_sku_results', 'product_pricing_state')")
    .get() as { n: number };
  const ok = Number(n.n) === 2;
  if (ok) ready.set(raw, true);
  return ok;
}

/** Publish every unpublished ordinary product of the test database (the raw rows behind a SqliteD1). */
export async function autoPublishV2(db: unknown): Promise<void> {
  const raw = rawOf(db);
  if (raw) await publishSeededV2(raw);
}

/**
 * The one call a test that seeds its own rows and then reads them through a
 * library (not a stubApp route) adds (A.12.1): every unpublished ordinary
 * product is published through the real writer. Idempotent and cheap once done.
 */
export async function publishSeededV2(raw: DatabaseSync): Promise<void> {
  if (!installed(raw)) return;
  const rows = raw
    .prepare(
      `SELECT p.id FROM products p
        WHERE COALESCE(p.composition, '') = ''
          -- A product with no dinar price anywhere has nothing to reproduce: it waits for the owner's dollar
          -- price, hidden, as on the live site (never published at an invented number).
          AND (COALESCE(p.price_iqd, 0) > 0
               OR EXISTS (SELECT 1 FROM product_option_values v WHERE v.product_id = p.id AND COALESCE(v.regular_price_iqd, 0) > 0)
               OR EXISTS (SELECT 1 FROM product_variants pv WHERE pv.product_id = p.id AND COALESCE(pv.regular_price_iqd, 0) > 0))
          AND NOT EXISTS (SELECT 1 FROM product_pricing_state s WHERE s.product_id = p.id AND s.mode = 'engine' AND s.pricing_method IS NOT NULL
                            AND EXISTS (SELECT 1 FROM pricing_v2_sku_results r WHERE r.product_id = p.id))
        ORDER BY p.id`
    )
    .all() as Array<{ id: string }>;
  if (!rows.length) return;
  const skip = failed.get(raw) ?? new Set<string>();
  failed.set(raw, skip);
  for (const { id } of rows) {
    if (skip.has(id)) continue;
    try {
      await publishV2(raw, id);
    } catch (e) {
      if (process.env.AUTOPUBLISH_DEBUG) console.error(`autoPublishV2 ${id}: ${(e as Error).message}`);
      skip.add(id);
    }
  }
}

/** The same, as a Hono middleware for a test that builds its own app instead of a stubApp. */
export const autoPublishMiddleware =
  (db: unknown) =>
  async (_c: unknown, next: () => Promise<void>): Promise<void> => {
    await autoPublishV2(db);
    await next();
  };

/**
 * The same, reading the database the app's own env middleware set — mounted
 * right after it in a test that builds its own Hono app. A customer-facing
 * path only (an admin path changes the save's contract, as in stubApp).
 */
export async function autoPublishFromEnv(c: { env?: unknown; req: { path: string } }, next: () => Promise<void>): Promise<void> {
  if (!c.req.path.startsWith('/api/admin')) await autoPublishV2((c.env as { DB?: unknown } | undefined)?.DB);
  await next();
}

/**
 * `worker.fetch` for a test that drives the real Worker: on a customer path
 * the seeded products are V2-published first, as stubApp does for a route.
 */
export async function fetchPublished(worker: { fetch?: unknown }, req: Request, env: unknown, ctx: unknown): Promise<Response> {
  if (!new URL(req.url).pathname.startsWith('/api/admin')) await autoPublishV2((env as { DB?: unknown } | null)?.DB);
  return (worker.fetch as (r: Request, e: unknown, c: unknown) => Promise<Response>)(req, env, ctx);
}
