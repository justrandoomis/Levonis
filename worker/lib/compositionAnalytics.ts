/**
 * COMPOSITION AND MYSTERY ANALYTICS (docs/BUNDLES_MYSTERY.md §12).
 *
 * DERIVED WHEREVER POSSIBLE; COUNTED ONLY WHERE NOTHING RECORDS THE FACT.
 *
 * Purchases, units, revenue, savings delivered, best bundles and every mystery
 * allocation figure are QUERIES over rows the checkout already writes — the
 * parent `order_items` row, its frozen `pricing_snapshot.composition` block,
 * and `mystery_allocations`. None of them is counted a second time, so none of
 * them can drift from what was actually sold, and none of them joins `users`.
 *
 * Exactly three facts have no row anywhere: a detail-page view, a successful
 * add-to-cart, and a purchase availability refused. Those are the three
 * columns of `composition_daily_metrics`, written with ONE aggregate upsert
 * carrying NO user id, NO order id and NO address.
 *
 * `views` counts SIGNED-IN views only and is best-effort. It is the
 * denominator of a conversion figure and nothing else — never an input to a
 * price, a limit or an eligibility decision (§10, §12).
 */

export type MetricField = 'views' | 'adds' | 'oos_blocks';

const FIELDS: MetricField[] = ['views', 'adds', 'oos_blocks'];

export const utcDay = (nowMs = Date.now()): string => new Date(nowMs).toISOString().slice(0, 10);

/**
 * ONE UPSERT. `INSERT … ON CONFLICT(day, subject_id) DO UPDATE` is idempotent
 * per row and additive per tap, which is what makes the counter safe to fire
 * from a hot path without turning one add-to-cart into five D1 writes.
 *
 * The field name is chosen from a fixed list rather than interpolated from a
 * caller's string — the column name is the one part of this statement that
 * cannot be bound.
 */
export function metricStatement(
  db: D1Database,
  subjectId: string,
  field: MetricField,
  nowMs = Date.now()
): D1PreparedStatement | null {
  if (!subjectId || !FIELDS.includes(field)) return null;
  return db
    .prepare(
      `INSERT INTO composition_daily_metrics (day, subject_id, ${field})
       VALUES (?, ?, 1)
       ON CONFLICT(day, subject_id) DO UPDATE SET ${field} = ${field} + 1`
    )
    .bind(utcDay(nowMs), subjectId);
}

/**
 * Fire-and-forget. A counter that failed must never fail the purchase it was
 * counting — the whole point of it being best-effort — so the error is
 * swallowed deliberately rather than propagated.
 */
export async function bumpMetric(
  db: D1Database,
  subjectId: string,
  field: MetricField,
  nowMs = Date.now()
): Promise<void> {
  const stmt = metricStatement(db, subjectId, field, nowMs);
  if (!stmt) return;
  try {
    await stmt.run();
  } catch {
    /* analytics never break a sale */
  }
}

/** The order states in which stock has actually moved — the same set the
 *  inventory lifecycle uses, so revenue here matches revenue there. */
const SOLD_STATES = "('confirmed','processing','shipped','delivered')";

export interface BundleAnalyticsRow {
  product_id: string;
  name: string;
  composition: string;
  orders: number;
  units: number;
  revenue_iqd: number;
  savings_iqd: number;
  views: number;
  adds: number;
  oos_blocks: number;
  conversion_percent: number | null;
}

/**
 * §12's table, as ONE query over the parent rows plus one over the counters.
 *
 * `bundle_parent_item_id IS NULL` selects the parent of a bundle and the
 * mystery offer's own line, and never a component — a component's
 * `line_total_iqd` is 0 by design, so including them would add nothing to
 * revenue but would double every unit count.
 */
export async function bundleAnalytics(
  db: D1Database,
  range: { from?: string; to?: string } = {}
): Promise<{ rows: BundleAnalyticsRow[]; totals: Omit<BundleAnalyticsRow, 'product_id' | 'name' | 'composition'> }> {
  const from = range.from ?? '0000-01-01';
  const to = range.to ?? '9999-12-31';
  const { results: sold } = await db
    .prepare(
      `SELECT oi.product_id AS product_id,
              MAX(oi.name_snapshot) AS name,
              MAX(p.composition) AS composition,
              COUNT(DISTINCT oi.order_id) AS orders,
              SUM(oi.qty) AS units,
              SUM(oi.line_total_iqd) AS revenue_iqd,
              SUM(COALESCE(json_extract(oi.pricing_snapshot, '$.composition.bundle_discount_iqd'), 0) * oi.qty)
                AS savings_iqd
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         JOIN products p ON p.id = oi.product_id
        WHERE oi.bundle_parent_item_id IS NULL
          AND p.composition <> ''
          AND o.status IN ${SOLD_STATES}
          AND substr(o.created_at, 1, 10) BETWEEN ? AND ?
        GROUP BY oi.product_id
        ORDER BY revenue_iqd DESC
        LIMIT 200`
    )
    .bind(from, to)
    .all<Record<string, unknown>>();

  const { results: counters } = await db
    .prepare(
      `SELECT subject_id, SUM(views) AS views, SUM(adds) AS adds, SUM(oos_blocks) AS oos_blocks
         FROM composition_daily_metrics
        WHERE day BETWEEN ? AND ?
        GROUP BY subject_id`
    )
    .bind(from, to)
    .all<{ subject_id: string; views: number; adds: number; oos_blocks: number }>();
  const byId = new Map((counters ?? []).map((r) => [String(r.subject_id), r]));

  const rows: BundleAnalyticsRow[] = (sold ?? []).map((r) => {
    const id = String(r.product_id);
    const c = byId.get(id);
    const views = Number(c?.views ?? 0);
    const orders = Number(r.orders ?? 0);
    byId.delete(id);
    return {
      product_id: id,
      name: String(r.name ?? ''),
      composition: String(r.composition ?? ''),
      orders,
      units: Number(r.units ?? 0),
      revenue_iqd: Number(r.revenue_iqd ?? 0),
      savings_iqd: Number(r.savings_iqd ?? 0),
      views,
      adds: Number(c?.adds ?? 0),
      oos_blocks: Number(c?.oos_blocks ?? 0),
      // Labelled at the API boundary as being over SIGNED-IN views, because
      // that is the only thing `views` counts (§12).
      conversion_percent: views > 0 ? Math.round((orders * 1000) / views) / 10 : null,
    };
  });
  // An offer that was viewed and blocked but never bought is the row an owner
  // most needs to see; dropping it because it has no revenue would hide
  // exactly the problem the counters exist to surface.
  for (const [id, c] of byId) {
    rows.push({
      product_id: id,
      name: '',
      composition: '',
      orders: 0,
      units: 0,
      revenue_iqd: 0,
      savings_iqd: 0,
      views: Number(c.views ?? 0),
      adds: Number(c.adds ?? 0),
      oos_blocks: Number(c.oos_blocks ?? 0),
      conversion_percent: Number(c.views ?? 0) > 0 ? 0 : null,
    });
  }

  type Totals = Omit<BundleAnalyticsRow, 'product_id' | 'name' | 'composition'>;
  const totals: Totals = rows.reduce<Totals>(
    (acc, r) => ({
      orders: acc.orders + r.orders,
      units: acc.units + r.units,
      revenue_iqd: acc.revenue_iqd + r.revenue_iqd,
      savings_iqd: acc.savings_iqd + r.savings_iqd,
      views: acc.views + r.views,
      adds: acc.adds + r.adds,
      oos_blocks: acc.oos_blocks + r.oos_blocks,
      conversion_percent: null,
    }),
    { orders: 0, units: 0, revenue_iqd: 0, savings_iqd: 0, views: 0, adds: 0, oos_blocks: 0, conversion_percent: null }
  );
  totals.conversion_percent = totals.views > 0 ? Math.round((totals.orders * 1000) / totals.views) / 10 : null;
  return { rows, totals };
}

/**
 * §12's mystery figures, read ENTIRELY through `mystery_allocation_stats` —
 * the view whose projection is `(day, pool_id, pool_entry_id, product_id,
 * color_id, sale_mode, n)` and carries no order id and no user id at all.
 *
 * Reading the base table here would work and would be wrong: the guarantee an
 * owner is given is that this screen cannot reach customer data, and a
 * guarantee that depends on every future reader remembering which columns to
 * omit is not one.
 */
export async function mysteryAnalytics(
  db: D1Database,
  range: { from?: string; to?: string } = {}
): Promise<{
  by_mode: Array<{ sale_mode: string; n: number }>;
  by_pool: Array<{ pool_id: string; pool_name: string; n: number }>;
  by_product: Array<{ product_id: string; product_name: string; color_id: string; n: number }>;
  by_entry: Array<{ pool_id: string; pool_entry_id: string; weight: number; n: number }>;
}> {
  const from = range.from ?? '0000-01-01';
  const to = range.to ?? '9999-12-31';
  const [mode, pool, product, entry] = await Promise.all([
    db
      .prepare(
        `SELECT sale_mode, SUM(n) AS n FROM mystery_allocation_stats
          WHERE day BETWEEN ? AND ? GROUP BY sale_mode ORDER BY n DESC`
      )
      .bind(from, to)
      .all<{ sale_mode: string; n: number }>(),
    db
      .prepare(
        `SELECT s.pool_id AS pool_id, COALESCE(mp.name, '') AS pool_name, SUM(s.n) AS n
           FROM mystery_allocation_stats s
           LEFT JOIN mystery_pools mp ON mp.id = s.pool_id
          WHERE s.day BETWEEN ? AND ? GROUP BY s.pool_id ORDER BY n DESC LIMIT 100`
      )
      .bind(from, to)
      .all<{ pool_id: string; pool_name: string; n: number }>(),
    db
      .prepare(
        `SELECT s.product_id AS product_id, COALESCE(p.name, '') AS product_name, s.color_id AS color_id,
                SUM(s.n) AS n
           FROM mystery_allocation_stats s
           LEFT JOIN products p ON p.id = s.product_id
          WHERE s.day BETWEEN ? AND ? GROUP BY s.product_id, s.color_id ORDER BY n DESC LIMIT 200`
      )
      .bind(from, to)
      .all<{ product_id: string; product_name: string; color_id: string; n: number }>(),
    // A pool entry with weight 10 and ZERO allocations is a stock problem the
    // owner can see at a glance — which is why this is a LEFT JOIN from the
    // entries, not a group of the allocations.
    db
      .prepare(
        `SELECT e.pool_id AS pool_id, e.id AS pool_entry_id, e.weight AS weight,
                COALESCE((SELECT SUM(s.n) FROM mystery_allocation_stats s
                           WHERE s.pool_entry_id = e.id AND s.day BETWEEN ?1 AND ?2), 0) AS n
           FROM mystery_pool_entries e
          WHERE e.active = 1
          ORDER BY n ASC, e.weight DESC
          LIMIT 200`
      )
      .bind(from, to)
      .all<{ pool_id: string; pool_entry_id: string; weight: number; n: number }>(),
  ]);
  return {
    by_mode: mode.results ?? [],
    by_pool: pool.results ?? [],
    by_product: product.results ?? [],
    by_entry: entry.results ?? [],
  };
}
