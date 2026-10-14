/**
 * IS MIGRATION 0181 ON THIS DATABASE? (CLAUDE.md rule 2: every new read of a
 * new table or column tolerates its absence; USD design §10 "Deploy-ahead".)
 *
 * A Worker carrying the engine core can run against a 0179 database — a
 * manual redeploy of an older migration state, Workers Builds re-opened in an
 * emergency — so every caller asks here first and keeps today's behaviour
 * when the answer is no:
 *   - pricing routes answer 503 PRICING_NOT_INSTALLED;
 *   - a purchase save leaves `purchase_charges.pricing_role` out of its INSERT,
 *     which is then byte-identical to today's;
 *   - checkout keeps the identical `order_items` INSERT (the decision-6
 *     snapshot columns are named only when present).
 *
 * The answer is remembered per database binding and ONLY when it is "present":
 * a migration lands while the isolate lives, never un-lands, so a "no" is
 * asked again next time and a "yes" is never asked twice. A failure to ask is
 * a "no" — the old statement is always the safe one.
 *
 * It lives beside the accounting code, not in `pricingEngine/`, because it
 * names `order_items`: the engine module never does (tests/pricingCurrencyRoles).
 */
import { serverMessage } from '@levonis/contracts/costRefusals';
import { HttpError } from './http';

const PRESENT = new WeakMap<object, Set<string>>();

function remembered(db: object, key: string): boolean {
  return PRESENT.get(db)?.has(key) === true;
}

function remember(db: object, key: string): void {
  let set = PRESENT.get(db);
  if (!set) PRESENT.set(db, (set = new Set()));
  set.add(key);
}

/** The engine core's tables (0181): its control row is seeded by the migration itself. */
export async function engineCoreInstalled(db: D1Database): Promise<boolean> {
  if (remembered(db, 'core')) return true;
  try {
    const row = await db.prepare('SELECT id FROM pricing_engine_control WHERE id = 1').first<{ id: number }>();
    if (!row) return false;
    remember(db, 'core');
    return true;
  } catch {
    return false;
  }
}

/**
 * The per-SKU price rung (0183, FX-7). Without it the engine prices per model
 * exactly as before: a colour or variant level, or a second option group, is
 * refused as it always was (PRICE_SHAPE_UNSUPPORTED), and the cart's resolver
 * reads no SKU row (the overlay's read of the table answers "absent").
 */
export async function skuPricesInstalled(db: D1Database): Promise<boolean> {
  if (remembered(db, 'sku_prices')) return true;
  try {
    await db.prepare('SELECT 1 AS x FROM product_sku_prices LIMIT 1').first<{ x: number }>();
    remember(db, 'sku_prices');
    return true;
  } catch {
    return false;
  }
}

/**
 * Pricing V2 (0189): the method column on the engine state and the four V2
 * stores (price points, the pre-order discount, the private V2 results, the
 * legacy snapshot). One statement names them all, so a database that lacks
 * any one of them answers "no" and every V2 path keeps today's behaviour: no
 * product is V2, nothing reads or writes the V2 tables. Remembered only when
 * present, like the checks above.
 */
export async function pricingV2Installed(db: D1Database): Promise<boolean> {
  if (remembered(db, 'pricing_v2')) return true;
  try {
    await db
      .prepare(
        `SELECT (SELECT pricing_method FROM product_pricing_state LIMIT 1) AS m,
                (SELECT 1 FROM pricing_price_points LIMIT 1) AS p,
                (SELECT 1 FROM pricing_preorder_discounts LIMIT 1) AS d,
                (SELECT 1 FROM pricing_v2_sku_results LIMIT 1) AS r,
                (SELECT 1 FROM pricing_legacy_snapshots LIMIT 1) AS s`
      )
      .first<{ m: string | null }>();
    remember(db, 'pricing_v2');
    return true;
  } catch {
    return false;
  }
}

/**
 * The clean start (0190, DECISIONS row 222): the purchase price reviews (D1),
 * the order lines' frozen cost estimate and the allocations' link kind (V2-6).
 * One statement names them all; a database without 0190 answers "no" and the
 * writes that need them refuse with PRICING_NOT_INSTALLED (the listing
 * predicate and the needs-pricing queue need only 0189). Remembered only when
 * present.
 */
export async function cleanStartInstalled(db: D1Database): Promise<boolean> {
  if (remembered(db, 'clean_start')) return true;
  try {
    await db
      .prepare(
        `SELECT (SELECT 1 FROM pricing_v2_purchase_reviews LIMIT 1) AS r,
                (SELECT estimated_cost_iqd FROM order_items LIMIT 1) AS e,
                (SELECT link_kind FROM order_item_inventory_allocations LIMIT 1) AS l`
      )
      .first<{ r: number | null }>();
    remember(db, 'clean_start');
    return true;
  } catch {
    return false;
  }
}

/**
 * The columns the engine migrations add to live tables, the only ones this
 * helper answers for: 0181's, plus 0189's method and first-V2-write stamp on
 * `product_pricing_state`.
 */
export const ENGINE_CORE_COLUMNS = {
  purchase_charges: ['pricing_role'],
  order_items: ['price_basis', 'engine_combo_key', 'engine_channel', 'engine_regular_iqd', 'usd_iqd_at_purchase', 'base_usd_at_purchase'],
  price_history: ['usd_iqd_rate', 'price_source'],
  price_protection_claims: ['eligible_unit_iqd', 'basis', 'usd_iqd_at_purchase', 'base_usd_at_purchase', 'base_usd_observed'],
  product_pricing_state: ['pricing_method', 'v2_since'],
} as const;

export type EngineCoreTable = keyof typeof ENGINE_CORE_COLUMNS;

/** True when `table.column` (one of ENGINE_CORE_COLUMNS) exists on this database. */
export async function engineColumnInstalled<T extends EngineCoreTable>(
  db: D1Database,
  table: T,
  column: (typeof ENGINE_CORE_COLUMNS)[T][number]
): Promise<boolean> {
  if (!(ENGINE_CORE_COLUMNS[table] as readonly string[]).includes(column)) throw new Error(`PRICING_INVARIANT: ${table}.${column} is not a 0181 column`);
  const key = `${table}.${column}`;
  if (remembered(db, key)) return true;
  try {
    // The table name comes from the fixed list above, never from a caller's text.
    const { results } = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
    const names = new Set((results ?? []).map((r) => String(r.name)));
    for (const c of ENGINE_CORE_COLUMNS[table] as readonly string[]) if (names.has(c)) remember(db, `${table}.${c}`);
    return names.has(column);
  } catch {
    return false;
  }
}

/**
 * Is this product's price the engine's? (`product_pricing_state.mode =
 * 'engine'`; owner decision 8 adopts a product at its completing save.) A
 * database without 0181 has no engine product: false. Not a cost — every
 * admin may know it (the form says so, and the old price writers refuse).
 */
export async function productEngineManaged(db: D1Database, productId: string): Promise<boolean> {
  try {
    const row = await db.prepare("SELECT 1 AS x FROM product_pricing_state WHERE product_id = ? AND mode = 'engine'").bind(productId).first<{ x: number }>();
    return !!row;
  } catch {
    return false;
  }
}

/**
 * The old dinar price writers (the quick-price grid, the selection price)
 * refuse an engine-priced product up front with ENGINE_MANAGED, in the
 * viewer's language, before planning anything. The database's value-compared
 * locks (migration 0181 §10) stay the backstop for every other path — the
 * product form, the relations and fulfilment saves, the TXT and CSV imports —
 * where an unchanged price still saves.
 */
export async function refuseEngineManaged(db: D1Database, productId: string, section: 3 | 5 = 3): Promise<void> {
  // Pricing V2 (spec §3.4, §3.5): a V2 product's prices are edited in the form's section ٣ (or ٥) only.
  if (await productEngineV2(db, productId)) throw v2Managed(section);
  if (await productEngineManaged(db, productId) && !(await productEngineDirectOnly(db, productId)))
    throw new HttpError(409, serverMessage('ENGINE_MANAGED'), 'ENGINE_MANAGED');
}

/** 409 PRICING_V2_MANAGED, naming the form section (spec §3.10: every refusal carries `details.section`, never a value). */
export const v2Managed = (section: 3 | 5 = 3): HttpError =>
  new HttpError(409, serverMessage('PRICING_V2_MANAGED'), 'PRICING_V2_MANAGED', { section, v2: true });

/**
 * Is this product priced by the V2 writer? (spec C-1: `mode = 'engine'` with a
 * `pricing_method`.) A database without 0189 has no V2 product: false. Not a
 * cost — every admin may know it.
 */
export async function productEngineV2(db: D1Database, productId: string): Promise<boolean> {
  try {
    const row = await db
      .prepare("SELECT 1 AS x FROM product_pricing_state WHERE product_id = ? AND mode = 'engine' AND pricing_method IS NOT NULL")
      .bind(productId)
      .first<{ x: number }>();
    return !!row;
  } catch {
    return false;
  }
}

/**
 * The product form's pricing flag (spec §5.1 as amended by addendum A.7): is
 * the product V2 (a method), which method, and does it still NEED PRICING —
 * no complete V2 write yet, so no customer sees it (the clean start's
 * predicate, A.4). A flag, never a figure: every admin may know it. A
 * database without 0189 has no V2 product: every product needs pricing.
 */
export async function productV2Flag(db: D1Database, productId: string): Promise<{ v2: boolean; method: 'cost' | 'usd' | null; needs_pricing: boolean }> {
  try {
    const row = await db
      .prepare(
        `SELECT s.pricing_method AS method,
                EXISTS (SELECT 1 FROM pricing_v2_sku_results r WHERE r.product_id = s.product_id) AS priced
           FROM product_pricing_state s WHERE s.product_id = ? AND s.mode = 'engine' AND s.pricing_method IS NOT NULL`
      )
      .bind(productId)
      .first<{ method: string; priced: number }>();
    const method = row?.method === 'cost' || row?.method === 'usd' ? row.method : null;
    return { v2: method !== null, method, needs_pricing: !(method !== null && Number(row?.priced) === 1) };
  } catch {
    return { v2: false, method: null, needs_pricing: true };
  }
}

/**
 * Does the engine price this product's DIRECT SALE only? A stock purchase
 * applied to a manual product adopts it that way (pricing_direct_purchase
 * .direct_only); its model, colour, route and pre-order prices stay the
 * owner's (review 2026-10-13, DI-2). The old price writers then let the
 * database's locks decide cell by cell (migration 0188): the direct-sale
 * cells, the product row, variants and SKU prices refuse ENGINE_MANAGED, the
 * rest saves. Without 0186 there is no direct-only product: false.
 */
export async function productEngineDirectOnly(db: D1Database, productId: string): Promise<boolean> {
  try {
    const row = await db.prepare(`SELECT 1 AS x FROM pricing_direct_purchase d JOIN product_pricing_state s ON s.product_id = d.product_id
      WHERE d.product_id = ? AND s.mode = 'engine' AND json_valid(d.payload_json) AND json_extract(d.payload_json, '$.direct_only') = 1`).bind(productId).first<{ x: number }>();
    return !!row;
  } catch {
    return false;
  }
}
