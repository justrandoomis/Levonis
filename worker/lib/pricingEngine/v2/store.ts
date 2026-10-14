/**
 * PRICING V2 — THE PRIVATE STORE OF ONE PRODUCT'S DOLLAR PRICES (spec §3.1;
 * migration 0189): its method, its price points (`pricing_price_points`), its
 * one pre-order discount per scope (`pricing_preorder_discounts`) and the V2
 * writer's private result per SKU × channel (`pricing_v2_sku_results`).
 *
 * Read by explicit column lists, never `SELECT *`. Written like store.ts: a
 * plain INSERT for a new row (packed, `packRows`), a version-fenced UPDATE or
 * DELETE for an existing one — never `ON CONFLICT` / `OR REPLACE` (0189's
 * no-re-insert triggers refuse them). Every point and discount write bumps
 * `product_pricing_state.inputs_seq` by trigger, so the batch head's fence
 * (store.ts `batchHead`) refuses a concurrent edit; the rows move only under
 * the `engine-price:<product_id>` token the V2 writer holds (v2/write.ts).
 *
 * TOLERANT OF ITS ABSENCE (CLAUDE.md rule 2): on a database without 0189 every
 * read answers null — "V2 is not installed" — and nothing here is written.
 *
 * PRIVATE: every value here is the owner's (FINANCIAL_FIELDS `v2_*`). Nothing
 * is logged; refusals carry codes only.
 */
import type { V2Anchor, V2Discount, V2Floor, V2Method, V2PricePoint, V2Scope } from '@levonis/pricing/priceV2';
import type { SkuChannel } from '@levonis/pricing/skuChannel';
import { isMissingV2Schema } from '../../productOverlay';
import { packRows } from '../store';

/** One `pricing_price_points` row, as stored. */
export interface StoredPoint {
  scope: V2Scope;
  scope_id: string;
  kind: 'fixed' | 'delta';
  amount_usd: string;
  version: number;
}

/** One `pricing_preorder_discounts` row, as stored. */
export interface StoredDiscount {
  scope: V2Scope;
  scope_id: string;
  amount_usd: string;
  version: number;
}

/** One `pricing_v2_sku_results` row, as stored (the V2 writer's private figures of one SKU × channel). */
export interface StoredV2Result {
  product_id: string;
  combo_key: string;
  channel: SkuChannel;
  method: V2Method;
  anchor: V2Anchor;
  final_price_iqd: number;
  exact_iqd: string;
  direct_price_iqd: number;
  direct_exact_iqd: string;
  usd_ceil6: string;
  deltas_usd: string;
  discount_usd: string | null;
  discount_scope: V2Scope | null;
  discount_scope_id: string | null;
  floor: V2Floor;
  shipping_profile: string | null;
  supplier_currency: string | null;
  fx_rate: string | null;
  fx_version: number | null;
  cross_rate: string | null;
  cross_fx_version: number | null;
  shipping_rate: string | null;
  shipping_version: number | null;
  replacement_exact: string | null;
  replacement_cost_iqd: number | null;
  target_profit_usd: string | null;
  target_rule_id: string | null;
  target_rule_version: number | null;
  usd_iqd_rate: string;
  usd_fx_version: number;
  inputs_seq: number;
  config_version: number;
  write_seq: number;
  computed_at: string;
}

export const V2_RESULT_COLUMNS = [
  'product_id', 'combo_key', 'channel', 'method', 'anchor', 'final_price_iqd', 'exact_iqd', 'direct_price_iqd', 'direct_exact_iqd',
  'usd_ceil6', 'deltas_usd', 'discount_usd', 'discount_scope', 'discount_scope_id', 'floor', 'shipping_profile', 'supplier_currency',
  'fx_rate', 'fx_version', 'cross_rate', 'cross_fx_version', 'shipping_rate', 'shipping_version', 'replacement_exact',
  'replacement_cost_iqd', 'target_profit_usd', 'target_rule_id', 'target_rule_version', 'usd_iqd_rate', 'usd_fx_version',
  'inputs_seq', 'config_version', 'write_seq', 'computed_at',
] as const satisfies readonly (keyof StoredV2Result)[];

/** Everything V2 stores about one product. */
export interface V2Store {
  /** The state's method ('cost' | 'usd'), or null: the product is not V2 (yet). */
  method: V2Method | null;
  points: StoredPoint[];
  discounts: StoredDiscount[];
  results: StoredV2Result[];
}

const POINT_COLUMNS = 'product_id, scope, scope_id, kind, amount_usd, version';
const DISCOUNT_COLUMNS = 'product_id, scope, scope_id, amount_usd, version';

/**
 * Several products' V2 stores in ONE batch (one snapshot, four statements).
 * Null for each product on a database without 0189 — V2 is not installed.
 */
export async function loadV2Store(db: D1Database, ids: readonly string[]): Promise<Map<string, V2Store | null>> {
  const unique = [...new Set(ids)];
  const out = new Map<string, V2Store | null>();
  if (!unique.length) return out;
  const list = JSON.stringify(unique);
  let batch: D1Result[];
  try {
    batch = await db.batch([
      db.prepare('SELECT product_id, pricing_method FROM product_pricing_state WHERE product_id IN (SELECT value FROM json_each(?))').bind(list),
      db.prepare(`SELECT ${POINT_COLUMNS} FROM pricing_price_points WHERE product_id IN (SELECT value FROM json_each(?)) ORDER BY product_id, scope, scope_id`).bind(list),
      db.prepare(`SELECT ${DISCOUNT_COLUMNS} FROM pricing_preorder_discounts WHERE product_id IN (SELECT value FROM json_each(?)) ORDER BY product_id, scope, scope_id`).bind(list),
      db.prepare(`SELECT ${V2_RESULT_COLUMNS.join(', ')} FROM pricing_v2_sku_results WHERE product_id IN (SELECT value FROM json_each(?)) ORDER BY product_id, combo_key, channel`).bind(list),
    ]);
  } catch (e) {
    if (!isMissingV2Schema(e)) throw e;
    for (const id of unique) out.set(id, null);
    return out;
  }
  const [state, points, discounts, results] = batch.map((r) => (r.results ?? []) as Array<Record<string, unknown>>);
  for (const id of unique) {
    const method = state.find((r) => r.product_id === id)?.pricing_method;
    out.set(id, {
      method: method === 'cost' || method === 'usd' ? method : null,
      points: points.filter((r) => r.product_id === id).map((r) => ({
        scope: r.scope as V2Scope,
        scope_id: String(r.scope_id ?? ''),
        kind: r.kind === 'delta' ? 'delta' : 'fixed',
        amount_usd: String(r.amount_usd),
        version: Number(r.version),
      })),
      discounts: discounts.filter((r) => r.product_id === id).map((r) => ({
        scope: r.scope as V2Scope,
        scope_id: String(r.scope_id ?? ''),
        amount_usd: String(r.amount_usd),
        version: Number(r.version),
      })),
      results: results.filter((r) => r.product_id === id).map(resultOf),
    });
  }
  return out;
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const txt = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

function resultOf(r: Record<string, unknown>): StoredV2Result {
  return {
    product_id: String(r.product_id),
    combo_key: String(r.combo_key ?? ''),
    channel: String(r.channel) as SkuChannel,
    method: r.method === 'usd' ? 'usd' : 'cost',
    anchor: String(r.anchor) as V2Anchor,
    final_price_iqd: Number(r.final_price_iqd),
    exact_iqd: String(r.exact_iqd),
    direct_price_iqd: Number(r.direct_price_iqd),
    direct_exact_iqd: String(r.direct_exact_iqd),
    usd_ceil6: String(r.usd_ceil6),
    deltas_usd: String(r.deltas_usd ?? '0'),
    discount_usd: txt(r.discount_usd),
    discount_scope: txt(r.discount_scope) as V2Scope | null,
    discount_scope_id: txt(r.discount_scope_id),
    floor: String(r.floor ?? 'none') as V2Floor,
    shipping_profile: txt(r.shipping_profile),
    supplier_currency: txt(r.supplier_currency),
    fx_rate: txt(r.fx_rate),
    fx_version: num(r.fx_version),
    cross_rate: txt(r.cross_rate),
    cross_fx_version: num(r.cross_fx_version),
    shipping_rate: txt(r.shipping_rate),
    shipping_version: num(r.shipping_version),
    replacement_exact: txt(r.replacement_exact),
    replacement_cost_iqd: num(r.replacement_cost_iqd),
    target_profit_usd: txt(r.target_profit_usd),
    target_rule_id: txt(r.target_rule_id),
    target_rule_version: num(r.target_rule_version),
    usd_iqd_rate: String(r.usd_iqd_rate),
    usd_fx_version: Number(r.usd_fx_version),
    inputs_seq: Number(r.inputs_seq),
    config_version: Number(r.config_version),
    write_seq: Number(r.write_seq),
    computed_at: String(r.computed_at ?? ''),
  };
}

/** The stored rows as `priceProductV2` reads them. */
export const pointsOf = (rows: readonly StoredPoint[]): V2PricePoint[] => rows.map((r) => ({ scope: r.scope, scope_id: r.scope_id, kind: r.kind, usd: r.amount_usd }));
export const discountsOf = (rows: readonly StoredDiscount[]): V2Discount[] => rows.map((r) => ({ scope: r.scope, scope_id: r.scope_id, usd: r.amount_usd }));

// ------------------------------------------------------------ writes

/** One point write: the row a (scope, scope_id) is left with (null = removed). */
export interface PointWrite {
  scope: V2Scope;
  scope_id: string;
  existing: StoredPoint | null;
  next: { kind: 'fixed' | 'delta'; usd: string } | null;
}

/** One discount write: the row a (scope, scope_id) is left with (null = removed). */
export interface DiscountWrite {
  scope: V2Scope;
  scope_id: string;
  existing: StoredDiscount | null;
  next: { usd: string } | null;
}

const keyOf = (r: { scope: string; scope_id: string }) => `${r.scope}\u0000${r.scope_id}`;

/** The writes that leave `stored` equal to `desired` (a full desired set: absent = removed). No-ops are dropped. */
export function pointWrites(stored: readonly StoredPoint[], desired: readonly V2PricePoint[]): PointWrite[] {
  const want = new Map(desired.map((p) => [keyOf(p), p] as const));
  const have = new Map(stored.map((p) => [keyOf(p), p] as const));
  const out: PointWrite[] = [];
  for (const [k, p] of want) {
    const e = have.get(k) ?? null;
    if (e && e.kind === p.kind && e.amount_usd === p.usd) continue;
    out.push({ scope: p.scope, scope_id: p.scope_id, existing: e, next: { kind: p.kind, usd: p.usd } });
  }
  for (const [k, e] of have) if (!want.has(k)) out.push({ scope: e.scope, scope_id: e.scope_id, existing: e, next: null });
  return out;
}

export function discountWrites(stored: readonly StoredDiscount[], desired: readonly V2Discount[]): DiscountWrite[] {
  const want = new Map(desired.map((d) => [keyOf(d), d] as const));
  const have = new Map(stored.map((d) => [keyOf(d), d] as const));
  const out: DiscountWrite[] = [];
  for (const [k, d] of want) {
    const e = have.get(k) ?? null;
    if (e && e.amount_usd === d.usd) continue;
    out.push({ scope: d.scope, scope_id: d.scope_id, existing: e, next: { usd: d.usd } });
  }
  for (const [k, e] of have) if (!want.has(k)) out.push({ scope: e.scope, scope_id: e.scope_id, existing: e, next: null });
  return out;
}

const POINT_INSERT_HEAD = 'INSERT INTO pricing_price_points (product_id, scope, scope_id, kind, amount_usd, version, updated_by, updated_at)';
const POINT_INSERT_ROW = '(?, ?, ?, ?, ?, 1, ?, ?)';
const DISCOUNT_INSERT_HEAD = 'INSERT INTO pricing_preorder_discounts (product_id, scope, scope_id, amount_usd, version, updated_by, updated_at)';
const DISCOUNT_INSERT_ROW = '(?, ?, ?, ?, 1, ?, ?)';

/** The point rows: plain INSERTs (packed) for new rows, version-fenced UPDATE / DELETE for existing ones. */
export function pointStatements(db: D1Database, productId: string, writes: readonly PointWrite[], actor: string, now: string): D1PreparedStatement[] {
  const out: D1PreparedStatement[] = [];
  const fresh: unknown[][] = [];
  for (const w of writes) {
    const scopeId = w.scope === 'product' ? '' : w.scope_id;
    if (!w.existing) {
      if (w.next) fresh.push([productId, w.scope, scopeId, w.next.kind, w.next.usd, actor, now]);
      continue;
    }
    out.push(
      w.next
        ? db
            .prepare('UPDATE pricing_price_points SET kind = ?, amount_usd = ?, version = version + 1, updated_by = ?, updated_at = ? WHERE product_id = ? AND scope = ? AND scope_id = ? AND version = ?')
            .bind(w.next.kind, w.next.usd, actor, now, productId, w.scope, scopeId, w.existing.version)
        : db.prepare('DELETE FROM pricing_price_points WHERE product_id = ? AND scope = ? AND scope_id = ? AND version = ?').bind(productId, w.scope, scopeId, w.existing.version)
    );
  }
  // Deletes and updates first: a kind change at one scope is never a re-insert.
  return [...out, ...packRows(db, POINT_INSERT_HEAD, POINT_INSERT_ROW, fresh)];
}

export function discountStatements(db: D1Database, productId: string, writes: readonly DiscountWrite[], actor: string, now: string): D1PreparedStatement[] {
  const out: D1PreparedStatement[] = [];
  const fresh: unknown[][] = [];
  for (const w of writes) {
    const scopeId = w.scope === 'product' ? '' : w.scope_id;
    if (!w.existing) {
      if (w.next) fresh.push([productId, w.scope, scopeId, w.next.usd, actor, now]);
      continue;
    }
    out.push(
      w.next
        ? db
            .prepare('UPDATE pricing_preorder_discounts SET amount_usd = ?, version = version + 1, updated_by = ?, updated_at = ? WHERE product_id = ? AND scope = ? AND scope_id = ? AND version = ?')
            .bind(w.next.usd, actor, now, productId, w.scope, scopeId, w.existing.version)
        : db.prepare('DELETE FROM pricing_preorder_discounts WHERE product_id = ? AND scope = ? AND scope_id = ? AND version = ?').bind(productId, w.scope, scopeId, w.existing.version)
    );
  }
  return [...out, ...packRows(db, DISCOUNT_INSERT_HEAD, DISCOUNT_INSERT_ROW, fresh)];
}
