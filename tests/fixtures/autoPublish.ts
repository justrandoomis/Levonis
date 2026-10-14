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
 * a rounding step stays exact. A product the writer cannot publish (no price,
 * an incomplete structure) stays hidden, as on the live site. Compositions
 * wait for Q7 and are never published.
 *
 * Opt out with `stubApp(…, { publishV2: false })` — the cut-over tests that
 * prove the hiding itself do.
 */
import type { DatabaseSync } from 'node:sqlite';
import { publishV2 } from './v2Publish';

const failed = new WeakMap<DatabaseSync, Set<string>>();
const ready = new WeakMap<DatabaseSync, boolean>();

const rawOf = (db: unknown): DatabaseSync | null => {
  const inner = (db as { db?: unknown } | null)?.db;
  return inner && typeof (inner as DatabaseSync).prepare === 'function' ? (inner as DatabaseSync) : null;
};

function installed(raw: DatabaseSync): boolean {
  const known = ready.get(raw);
  if (known) return true;
  const n = raw
    .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('pricing_v2_sku_results', 'product_pricing_state', 'pricing_v2_price_points')")
    .get() as { n: number };
  const ok = Number(n.n) === 3;
  if (ok) ready.set(raw, true);
  return ok;
}

/** Publish every unpublished ordinary product of the test database (the raw rows behind a SqliteD1). */
export async function autoPublishV2(db: unknown): Promise<void> {
  const raw = rawOf(db);
  if (!raw || !installed(raw)) return;
  const rows = raw
    .prepare(
      `SELECT p.id FROM products p
        WHERE COALESCE(p.composition, '') = ''
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
    } catch {
      skip.add(id);
    }
  }
}
