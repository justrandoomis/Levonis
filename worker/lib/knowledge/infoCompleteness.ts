/**
 * «اكتمال المعلومات» — THE STAFF COLUMN AND CARD (the Bambu import spec §H.2
 * «Information completeness in the product list and form»; the brief's §18A).
 *
 * How well a product is DESCRIBED, read from the knowledge model (0194
 * `product_spec_values`) for the expected keys of its type
 * (worker/lib/knowledge/completeness.ts). It is NOT the commercial
 * `product_completeness` (0184: what holds a product back from sale), and
 * neither reads nor writes it.
 *
 * ONE STATEMENT FOR A PAGE OF THE LIST: the page's ids (≤ 100, the list's own
 * cap) in one `GROUP BY product_id, canonical_key, status` over the registry's
 * expected keys, with the product's source route (its type) joined in — sent
 * beside the list's pictures, so the list gains no wave. The form's card reads
 * the same statement for one id.
 *
 * STAFF ONLY: the admin product router (requireAdmin) is its only reader, and
 * the answer holds key names, statuses and counts — never a value, a source or
 * a price. Every row counts, owner-visibility rows included: staff see what
 * the shop knows, not what a customer is shown.
 *
 * Without 0194: null for every product (`knowledgeRead`), never a failure.
 */
import { knowledgeRead } from './schema';
import { completenessOf, EXPECTED_KEY_UNION, type CompletenessDetail } from './completeness';
import type { Tri } from './labels';

/** The list column: the counts and the ratio, without the per-key list. */
export interface InfoCompletenessSummary {
  /** (verified + unverified) / applicable, 0..1; null when nothing applies. */
  ratio: number | null;
  applicable: number;
  verified: number;
  unverified: number;
  /** not_found + not_published («ناقص» / Missing / «کەم»). */
  missing: number;
  /** «غير معروف» / Unknown / «نەزانراو». */
  unknown: number;
}

/** The form card: the summary, and the keys that are not stated, by name. */
export interface InfoCompletenessCard extends InfoCompletenessSummary {
  type: CompletenessDetail['type'];
  not_found: number;
  not_published: number;
  /** Every applicable expected key that is not verified, with its label and status, in registry order. */
  gaps: Array<{ key: string; label: Tri; status: CompletenessDetail['keys'][number]['status'] }>;
}

interface Row {
  product_id: string;
  canonical_key: string;
  status: string;
  n: number;
  source_route: string | null;
}

/** The page's rows: one per product, key and status, with the product's source route. */
async function readRows(db: D1Database, ids: readonly string[]): Promise<Row[] | null> {
  const page = [...new Set(ids.filter((id) => typeof id === 'string' && id !== ''))].slice(0, 100);
  if (page.length === 0 || EXPECTED_KEY_UNION.length === 0) return [];
  return knowledgeRead(db, async () =>
    (
      await db
        .prepare(
          `SELECT v.product_id, v.canonical_key, v.status, COUNT(*) AS n,
                  (SELECT r.source_route FROM product_source_refs r WHERE r.product_id = v.product_id
                    ORDER BY r.source, r.source_product_id LIMIT 1) AS source_route
             FROM product_spec_values v
            WHERE v.product_id IN (SELECT value FROM json_each(?))
              AND v.canonical_key IN (SELECT value FROM json_each(?))
            GROUP BY v.product_id, v.canonical_key, v.status`
        )
        .bind(JSON.stringify(page), JSON.stringify(EXPECTED_KEY_UNION))
        .all<Row>()
    ).results ?? []
  );
}

function detailsOf(rows: readonly Row[]): Map<string, CompletenessDetail> {
  const byProduct = new Map<string, { route: string | null; rows: Array<{ key: string; status: string }> }>();
  for (const r of rows) {
    const at = byProduct.get(r.product_id) ?? { route: null, rows: [] };
    if (typeof r.source_route === 'string' && r.source_route) at.route = r.source_route;
    at.rows.push({ key: r.canonical_key, status: r.status });
    byProduct.set(r.product_id, at);
  }
  const out = new Map<string, CompletenessDetail>();
  for (const [id, { route, rows: list }] of byProduct) out.set(id, completenessOf(list, route));
  return out;
}

const summaryOf = (d: CompletenessDetail): InfoCompletenessSummary => ({
  ratio: d.ratio === null ? null : Math.round(d.ratio * 1000) / 1000,
  applicable: d.applicable,
  verified: d.verified,
  unverified: d.unverified,
  missing: d.missing,
  unknown: d.unknown,
});

/**
 * The list column for a page of products: a summary per product that has
 * knowledge rows; a product with none is absent (the column shows nothing).
 * Null without 0194.
 */
export async function loadInfoCompleteness(db: D1Database, ids: readonly string[]): Promise<Map<string, InfoCompletenessSummary> | null> {
  const rows = await readRows(db, ids);
  if (!rows) return null;
  const out = new Map<string, InfoCompletenessSummary>();
  for (const [id, d] of detailsOf(rows)) if (d.type) out.set(id, summaryOf(d));
  return out;
}

/** The form card of one product; null when it has no knowledge row (or without 0194). */
export async function loadInfoCompletenessCard(db: D1Database, productId: string): Promise<InfoCompletenessCard | null> {
  const rows = await readRows(db, [productId]);
  if (!rows) return null;
  const d = detailsOf(rows).get(productId);
  if (!d || !d.type) return null;
  return {
    ...summaryOf(d),
    type: d.type,
    not_found: d.not_found,
    not_published: d.not_published,
    gaps: d.keys.filter((k) => k.status !== 'verified' && k.status !== 'not_applicable').map((k) => ({ key: k.key, label: k.label, status: k.status })),
  };
}
