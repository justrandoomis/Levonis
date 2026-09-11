/**
 * THE MYSTERY FIXTURE — one pool, one offer, one secret, added to the buy-path
 * catalogue of `tests/lib/bundles.ts`.
 *
 * It writes rows rather than calling the admin panel for the same reason the
 * bundle builder does: a reveal test must be able to construct states the
 * panel would refuse or would never produce in one call — an offer whose
 * `reveal_stage` is edited AFTER a sale, an order walked backwards through its
 * stages — in order to prove the server holds the line anyway.
 *
 * The pool is deliberately DISTINCT-PRICED: every candidate has a different
 * regular price, so "no number equal to the drawn item's price appears in a
 * pre-reveal payload" is a real assertion rather than one that passes because
 * every price in the fixture is the same.
 */
import type { DatabaseSync } from 'node:sqlite';

export interface MysteryOfferSpec {
  /** The offer product id. */
  id?: string;
  slug?: string;
  priceIqd?: number;
  spoolQty?: number;
  revealStage?: 'paid' | 'confirmed' | 'preparing' | 'shipped' | 'delivered';
  duplicatePolicy?: 'allow' | 'discourage' | 'forbid';
  showOdds?: boolean;
  maxQtyPerOrder?: number;
  /** '' = public. A JSON array string gates it. */
  requiredTiers?: string;
  secret?: string;
  poolId?: string;
  active?: boolean;
}

/**
 * Four filament products, each at its own price, each with its own stock —
 * and one of them with a DIFFERENT SHIPPING SIZE CLASS.
 *
 * A pool that is perfectly homogeneous in `size_class` / `is_spool` cannot
 * notice that the shipping engine was being fed the DRAWN candidate's own
 * `ops_policy`, which published the pick's size class in
 * `quote.shipping.components[].kind` and froze it into
 * `delivery_method_snapshot`. One heterogeneous candidate is what makes that
 * a testable leak rather than a coincidence.
 */
export const POOL_PRODUCTS = [
  { id: 'mp_a', slug: 'fil-a', name: 'Filament Alpha', price: 21000, stock: 9, ops: '{"is_spool":true}' },
  { id: 'mp_b', slug: 'fil-b', name: 'Filament Beta', price: 32000, stock: 9, ops: '{"is_spool":true}' },
  { id: 'mp_c', slug: 'fil-c', name: 'Filament Gamma', price: 43000, stock: 9, ops: '{"is_spool":true}' },
  { id: 'mp_d', slug: 'fil-d', name: 'Filament Delta', price: 54000, stock: 9, ops: '{"size_class":"printer_large"}' },
] as const;

/**
 * A COLOUR-TRACKED CANDIDATE, seeded on request.
 *
 * The base-mode products above cannot catch §8.2 row 18's second half: the
 * coarse projection used to null only the BASE `stock`, while `applyRelations`
 * overlaid the real `product_colors.stock` onto `colors[]`, so two anonymous
 * GETs around a CONFIRMATION identified the drawn colour exactly. A pool whose
 * candidates have no relational rows is structurally unable to notice.
 *
 * It is opt-in so the weight, count and probability fixtures above keep their
 * four-candidate wheel.
 */
export const COLOR_POOL_PRODUCT = {
  id: 'mp_e',
  slug: 'fil-e',
  name: 'Filament Epsilon',
  price: 65000,
  colors: [
    { id: 'pcm_red', name: 'Red', stock: 7 },
    { id: 'pcm_blue', name: 'Blue', stock: 7 },
  ],
} as const;

export function seedMysteryPool(
  raw: DatabaseSync,
  poolId = 'mpl_test',
  opts: { withColorCandidate?: boolean } = {}
): void {
  for (const p of POOL_PRODUCTS) {
    raw
      .prepare(
        `INSERT INTO products (id,slug,name,name_ar,name_ku,price_iqd,status,stock,options,colors,
                               selling_type,sale_types,preorder_transports,images,inventory_mode,ops_policy)
         VALUES (?,?,?,?,?,?,'active',?,'[]','[]','direct_sale','["direct_sale"]','[]',?,'BASE',?)`
      )
      .run(
        p.id,
        p.slug,
        p.name,
        `${p.name} AR`,
        `${p.name} KU`,
        p.price,
        p.stock,
        JSON.stringify([`https://cdn/${p.slug}.png`]),
        p.ops
      );
  }
  raw.prepare("INSERT INTO mystery_pools (id,name,kind) VALUES (?,?,'direct')").run(poolId, 'Filament pool');
  POOL_PRODUCTS.forEach((p, i) => {
    raw
      .prepare(
        "INSERT INTO mystery_pool_entries (id,pool_id,product_id,option_value_ids,color_id,family_id,weight,active) VALUES (?,?,?,'[]','','',?,1)"
      )
      .run(`mpe_${p.id}`, poolId, p.id, i + 1);
  });
  if (!opts.withColorCandidate) return;
  const e = COLOR_POOL_PRODUCT;
  raw
    .prepare(
      `INSERT INTO products (id,slug,name,name_ar,name_ku,price_iqd,status,stock,options,colors,
                             selling_type,sale_types,preorder_transports,images,inventory_mode,ops_policy)
       VALUES (?,?,?,?,?,?,'active',NULL,'[]','[]','direct_sale','["direct_sale"]','[]',?,'COLOR','{"is_spool":true}')`
    )
    .run(e.id, e.slug, e.name, `${e.name} AR`, `${e.name} KU`, e.price, JSON.stringify([`https://cdn/${e.slug}.png`]));
  e.colors.forEach((c, i) => {
    raw
      .prepare('INSERT INTO product_colors (id,product_id,name_en,name_ar,hex,stock,reserved,sort,active) VALUES (?,?,?,?,?,?,0,?,1)')
      .run(c.id, e.id, c.name, c.name, '#000', c.stock, i);
    raw
      .prepare(
        "INSERT INTO mystery_pool_entries (id,pool_id,product_id,option_value_ids,color_id,family_id,weight,active) VALUES (?,?,?,'[]',?,'',?,1)"
      )
      .run(`mpe_${c.id}`, poolId, e.id, c.id, 5);
  });
}

export function addMysteryOffer(raw: DatabaseSync, o: MysteryOfferSpec = {}): string {
  const id = o.id ?? 'p_mystery';
  const poolId = o.poolId ?? 'mpl_test';
  raw
    .prepare(
      `INSERT INTO products (id,slug,name,name_ar,name_ku,price_iqd,status,stock,options,colors,
                             selling_type,sale_types,preorder_transports,images,inventory_mode,composition)
       VALUES (?,?,?,?,?,?,?,NULL,'[]','[]','bundle','["bundle"]','[]','["https://cdn/mystery.png"]','BASE','mystery')`
    )
    .run(
      id,
      o.slug ?? 'mystery-box',
      'Mystery Filament Box',
      'صندوق فتيل عشوائي',
      'سندووقی نهێنی',
      o.priceIqd ?? 60000,
      o.active === false ? 'draft' : 'active'
    );
  raw
    .prepare(
      `INSERT INTO bundle_config (product_id, price_mode, min_price_iqd, max_qty_per_order,
                                  duplicate_policy, reveal_stage, show_odds)
       VALUES (?,'fixed',1,?,?,?,?)`
    )
    .run(id, o.maxQtyPerOrder ?? 5, o.duplicatePolicy ?? 'allow', o.revealStage ?? 'delivered', o.showOdds ? 1 : 0);
  raw
    .prepare(
      `INSERT INTO mystery_offers (product_id,direct_pool_id,preorder_pool_id,spool_qty,allow_direct,allow_preorder,customer_picks_family)
       VALUES (?,?,NULL,?,1,0,0)`
    )
    .run(id, poolId, o.spoolQty ?? 2);
  raw
    .prepare('INSERT INTO mystery_offer_secrets (product_id, secret) VALUES (?, ?)')
    .run(id, o.secret ?? 'c0ffee'.repeat(10) + 'cafe');
  raw
    .prepare(
      `INSERT INTO offer_windows (subject_type,subject_id,id,starts_at,ends_at,required_tiers,active)
       VALUES ('product',?,?,NULL,NULL,?,1)`
    )
    .run(id, `ofw_${id}`, o.requiredTiers ?? '[]');
  return id;
}

/** Every string and number the drawn products carry that must NOT appear in a
 *  pre-reveal customer payload — id, slug, name, image URL and every price. */
export function forbiddenTokens(raw: DatabaseSync, productIds: string[]): string[] {
  const out: string[] = [];
  for (const id of productIds) {
    const p =
      POOL_PRODUCTS.find((x) => x.id === id) ??
      (COLOR_POOL_PRODUCT.id === id ? COLOR_POOL_PRODUCT : null);
    if (!p) continue;
    out.push(p.id, p.slug, p.name, `https://cdn/${p.slug}.png`, String(p.price));
    // The drawn candidate's SHIPPING SIZE CLASS is a partition of the pool,
    // and the shipping quote publishes it verbatim if it is fed the pick's own
    // `ops_policy` — so it is a forbidden token like any other.
    const cls = String(JSON.parse(('ops' in p ? p.ops : '{}') as string).size_class ?? '');
    if (cls) out.push(cls);
  }
  const colours = raw
    .prepare(`SELECT id FROM product_colors WHERE product_id IN (${productIds.map(() => '?').join(',')})`)
    .all(...(productIds as never[])) as Array<{ id: string }>;
  for (const c of colours) out.push(c.id);
  return [...new Set(out)];
}
