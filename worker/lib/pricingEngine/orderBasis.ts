/**
 * OWNER DECISION 6 AT CHECKOUT: THE ENGINE PRICE AND THE RATE A LINE IS BOUGHT
 * AT (ODP §5.1 items 8-10; USD design §6.6).
 *
 * One query per checkout over the engine's private results. A line gets the
 * snapshot only when its product is engine-priced AND the regular price the
 * resolver charged it is exactly the stored engine price of its SKU × channel
 * (its exact selection when the product is priced per colour or variant —
 * FX-7 — else its model); every other line keeps the exact INSERT it always had (all six
 * columns NULL, migration 0181's shape trigger). The snapshot is written once,
 * with the line, and frozen by 0181's trigger; accounting never reads it.
 *
 * The line's channel is the one the engine priced it on: a line priced from
 * the direct ladder (a direct sale, or a pre-order paid cash on delivery) is
 * `direct_sale`; a prepaid pre-order is `pre_order_<route>`.
 *
 * Base USD at purchase = the engine price ÷ the U it was computed at (policy
 * `price_protection` v5's definition), rounded up at 6 places — a record for
 * the claim screen, never re-priced from.
 *
 * Feature-detected: on a database without migration 0181 the engine tables do
 * not exist, no line is engine-priced, and the INSERT is byte-identical. This
 * module returns column values only; it names no accounting table.
 */
import { ceilToPlaces, procurementExact, procurementExactText, quotientProcurementExact } from '@levonis/contracts/procurementCost';
import { channelOfRoute, skuComboKey, type PreorderRoute, type SkuChannel } from '@levonis/pricing/skuChannel';
import { isMissingTable } from '../fx/pairs';
import { isMissingV2Schema } from '../productOverlay';

export interface LineForBasis {
  /** The caller's line id. */
  key: string;
  product_id: string;
  /** The model (the option value the line was priced from); '' = the product itself. */
  option_id: string;
  /** FX-7: the line's whole selection (every option value) and its colour — the SKU a per-SKU price (0183) is stored under. */
  option_value_ids?: readonly string[];
  color_id?: string | null;
  /** 'direct' when the line was priced from the direct ladder, else 'preorder'. */
  pricing_basis: 'direct' | 'preorder';
  /** The pre-order route the line travels, when priced as a pre-order. */
  route: string | null;
  /** The regular price the resolver charged (before membership). */
  regular_iqd: number;
}

/** The six columns of an engine-priced line (migration 0181 §12). */
export interface EngineLineBasis {
  price_basis: 'engine';
  engine_combo_key: string;
  engine_channel: SkuChannel;
  engine_regular_iqd: number;
  usd_iqd_at_purchase: string;
  base_usd_at_purchase: string;
}

const ROUTES: readonly string[] = ['air', 'sea', 'land'];

export function channelOfLine(line: Pick<LineForBasis, 'pricing_basis' | 'route'>): SkuChannel | null {
  if (line.pricing_basis === 'direct') return 'direct_sale';
  return line.route && ROUTES.includes(line.route) ? channelOfRoute(line.route as PreorderRoute) : null;
}

/** Base USD = price ÷ U, rounded up at 6 places (decimal text). */
export function baseUsdOf(priceIqd: number, usdIqd: string): string {
  return procurementExactText(ceilToPlaces(quotientProcurementExact(procurementExact(priceIqd), procurementExact(usdIqd)), 6));
}

const V1_BASIS_SQL = `SELECT c.product_id, c.combo_key, c.channel, c.computed_price_iqd, c.usd_iqd_rate
           FROM pricing_sku_costs c
           JOIN product_pricing_state s ON s.product_id = c.product_id AND s.mode = 'engine'
          WHERE c.product_id IN (SELECT value FROM json_each(?))`;

/** Pricing V2: the V2 results of V2 products (canonical keys, '' = the product itself). */
const V2_BASIS_SQL = `SELECT r.product_id, r.combo_key, r.channel, r.final_price_iqd AS computed_price_iqd, r.usd_iqd_rate
           FROM pricing_v2_sku_results r
           JOIN product_pricing_state s ON s.product_id = r.product_id AND s.mode = 'engine' AND s.pricing_method IS NOT NULL
          WHERE r.product_id IN (SELECT value FROM json_each(?))`;

/** The engine snapshot of each line that was bought at an engine price (see the file header). */
export async function engineBasisOf(db: D1Database, lines: readonly LineForBasis[]): Promise<Map<string, EngineLineBasis>> {
  const out = new Map<string, EngineLineBasis>();
  const wanted = lines.filter((l) => l.product_id && Number.isSafeInteger(l.regular_iqd) && l.regular_iqd > 0 && channelOfLine(l) !== null);
  if (!wanted.length) return out;
  type BasisRow = { product_id: string; combo_key: string; channel: string; computed_price_iqd: number; usd_iqd_rate: string };
  let rows: BasisRow[];
  const list = JSON.stringify([...new Set(wanted.map((l) => l.product_id))]);
  try {
    // Pricing V2 (spec §3.6): a V2 line's engine price is its V2 result's final price, at the U it was
    // computed at — the same §12 snapshot; base USD keeps today's definition (C-10).
    const res = await db.prepare(`${V1_BASIS_SQL} UNION ALL ${V2_BASIS_SQL}`).bind(list, list).all<BasisRow>();
    rows = res.results ?? [];
  } catch (e) {
    // A database without 0189: V1's read alone, exactly as before (no product is V2 there).
    if (!isMissingV2Schema(e)) {
      if (isMissingTable(e)) return out;
      throw e;
    }
    try {
      rows = (await db.prepare(V1_BASIS_SQL).bind(list).all<BasisRow>()).results ?? [];
    } catch (e1) {
      if (isMissingTable(e1)) return out;
      throw e1;
    }
  }
  for (const l of wanted) {
    const channel = channelOfLine(l)!;
    // The exact SKU first (a product priced per colour or variant, FX-7), then the model (priced per model).
    const ids = l.option_value_ids && l.option_value_ids.length ? l.option_value_ids : l.option_id ? [l.option_id] : [];
    const candidates = [...new Set([skuComboKey({ option_value_ids: ids, color_id: l.color_id || null }), skuComboKey({ option_value_ids: l.option_id ? [l.option_id] : [], color_id: null })])];
    const found = candidates
      .map((combo) => ({ combo, r: rows.find((x) => x.product_id === l.product_id && x.combo_key === combo && x.channel === channel) }))
      .find((x) => !!x.r);
    const r = found?.r;
    const combo = found?.combo ?? '';
    if (!r || Number(r.computed_price_iqd) !== l.regular_iqd) continue;
    out.set(l.key, {
      price_basis: 'engine',
      engine_combo_key: combo,
      engine_channel: channel,
      engine_regular_iqd: l.regular_iqd,
      usd_iqd_at_purchase: r.usd_iqd_rate,
      base_usd_at_purchase: baseUsdOf(l.regular_iqd, r.usd_iqd_rate),
    });
  }
  return out;
}

/* ------------------------------------------------- V2-6: the frozen estimate -- */

/**
 * The four 0190 columns of a V2 line (addendum A.9 step 1): the replacement
 * cost of THAT channel's V2 result (direct: R_stock; a route: R_route) at the
 * U it was computed at — the line's estimated cost until FIFO or a linked
 * batch gives the actual one. A price-first product without a complete cost
 * has no replacement cost: nothing is written (`unknown`). Never a legacy
 * number (a V2 line's `cost_iqd` is NULL, `cost_basis` 'unpriced').
 *
 * Owner-only figures (FINANCIAL_FIELDS); written once with the line.
 */
export interface V2LineEstimate {
  estimated_cost_iqd: number;
  estimated_cost_usd: string;
  estimated_usd_iqd_rate: string;
  estimated_fx_version: number;
}

const V2_ESTIMATE_SQL = `SELECT r.product_id, r.combo_key, r.channel, r.replacement_cost_iqd, r.replacement_exact, r.usd_iqd_rate, r.usd_fx_version
           FROM pricing_v2_sku_results r
           JOIN product_pricing_state s ON s.product_id = r.product_id AND s.mode = 'engine' AND s.pricing_method IS NOT NULL
          WHERE r.product_id IN (SELECT value FROM json_each(?)) AND r.replacement_cost_iqd IS NOT NULL`;

/** `cleanStart`: the 0190 columns exist (the caller's `cleanStartInstalled`); without them nothing is written. */
export async function v2EstimateOf(db: D1Database, lines: readonly Omit<LineForBasis, 'regular_iqd'>[], cleanStart: boolean): Promise<Map<string, V2LineEstimate>> {
  const out = new Map<string, V2LineEstimate>();
  if (!cleanStart) return out;
  const wanted = lines.filter((l) => l.product_id && channelOfLine(l) !== null);
  if (!wanted.length) return out;
  type Row = { product_id: string; combo_key: string; channel: string; replacement_cost_iqd: number; replacement_exact: string; usd_iqd_rate: string; usd_fx_version: number };
  let rows: Row[];
  try {
    rows = (await db.prepare(V2_ESTIMATE_SQL).bind(JSON.stringify([...new Set(wanted.map((l) => l.product_id))])).all<Row>()).results ?? [];
  } catch (e) {
    if (isMissingV2Schema(e) || isMissingTable(e)) return out;
    throw e;
  }
  for (const l of wanted) {
    const channel = channelOfLine(l)!;
    const ids = l.option_value_ids && l.option_value_ids.length ? l.option_value_ids : l.option_id ? [l.option_id] : [];
    const candidates = [...new Set([skuComboKey({ option_value_ids: ids, color_id: l.color_id || null }), skuComboKey({ option_value_ids: l.option_id ? [l.option_id] : [], color_id: null })])];
    const r = candidates.map((combo) => rows.find((x) => x.product_id === l.product_id && x.combo_key === combo && x.channel === channel)).find((x) => !!x);
    if (!r || !Number.isSafeInteger(Number(r.replacement_cost_iqd)) || !(Number(r.usd_fx_version) > 0)) continue;
    out.set(l.key, {
      estimated_cost_iqd: Number(r.replacement_cost_iqd),
      estimated_cost_usd: procurementExactText(ceilToPlaces(quotientProcurementExact(procurementExact(r.replacement_exact), procurementExact(r.usd_iqd_rate)), 6)),
      estimated_usd_iqd_rate: r.usd_iqd_rate,
      estimated_fx_version: Number(r.usd_fx_version),
    });
  }
  return out;
}
