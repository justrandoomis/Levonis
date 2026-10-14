/**
 * THE COUPON'S TARGETING, READ FROM THE ROW AND FED TO THE ONE RESOLVER.
 *
 * Migration 0077 stored who a coupon is for, which lines it names, what it
 * reduces (the goods, the delivery or both), how many units qualify and what
 * its cap is a cap ON. `packages/pricing/src/coupons.ts` (`allocateCoupon`)
 * decides all of it and is tested; until Services V2 S-P0a nothing called it,
 * and the checkout took `value% × (goods + fees + delivery)` from every code
 * (offers B2/B3). This file is the glue only:
 *
 *   `couponRuleOf`     the stored row → the resolver's rule, every 0077 column
 *                      read with its migration's own default, so a row written
 *                      before 0077 (or a database without it) behaves exactly
 *                      as an unscoped, merchandise-only coupon;
 *   `couponLinesOf`    the priced lines → the resolver's lines: GOODS PER UNIT
 *                      only (the applied price, never the warranty fee, the
 *                      transport commission or the delivery), after the
 *                      membership saving the line already carries;
 *   `productCouponFacts` the brand and sections the scope may name, read from
 *                      the product rows.
 *
 * What the resolver returns per line is frozen on `order_items.coupon_discount_iqd`
 * by the checkout. Every reader that splits an order's coupon (finance,
 * refunds, price protection, trade-in) subtracts that line figure and only the
 * RESIDUAL of the order-level figure, so a discount is never taken twice
 * (Services V2 plan, correction 2).
 */
import type { AppliesTo, CapScope, CouponContext, CouponKind, CouponLine, CouponRule, CouponScope } from '@levonis/pricing/coupons';
import { ancestryFor } from './membershipBenefits';
import { safeParse } from './types';

type Row = Record<string, unknown>;

const SCOPES: readonly CouponScope[] = ['global', 'category', 'sub_category', 'product', 'brand', 'bundle'];
const APPLIES: readonly AppliesTo[] = ['merchandise', 'delivery', 'both'];

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const whole = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
};
const wholeOrNull = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : whole(v));
const list = (v: unknown): string[] => {
  const parsed = typeof v === 'string' ? safeParse<unknown>(v, []) : v;
  return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string' && x !== '') : [];
};

/**
 * The stored row as the resolver's rule. An unknown scope stays unknown — the
 * resolver then names no line and the code is refused, which is the safe way
 * for a row no screen can write to fail. A percentage is held to 0–100.
 */
export function couponRuleOf(row: Row): CouponRule {
  const scope = SCOPES.includes(row.scope as CouponScope) ? (row.scope as CouponScope) : row.scope === undefined || row.scope === null ? 'global' : (String(row.scope) as CouponScope);
  const kind: CouponKind = row.kind === 'percent' ? 'percent' : 'fixed_iqd';
  const cap: CapScope = row.cap_scope === 'per_unit' ? 'per_unit' : 'per_order';
  const applies: AppliesTo = APPLIES.includes(row.applies_to as AppliesTo) ? (row.applies_to as AppliesTo) : 'merchandise';
  return {
    scope,
    category_id: text(row.category_id),
    sub_category_id: text(row.sub_category_id),
    product_id: text(row.product_id),
    brand_id: text(row.brand_id),
    bundle_product_id: text(row.bundle_product_id),
    option_value_id: text(row.option_value_id),
    color_id: text(row.color_id),
    fulfillment_types: list(row.fulfillment_types),
    transport_methods: list(row.transport_methods),
    delivery_methods: list(row.delivery_methods),
    kind,
    value: kind === 'percent' ? Math.min(100, whole(row.value)) : whole(row.value),
    max_discount_iqd: wholeOrNull(row.max_discount_iqd),
    cap_scope: cap,
    max_quantity: wholeOrNull(row.max_quantity),
    applies_to: applies,
    // 0077's default is 1 (stacks), which is what every older coupon did.
    stacks: row.stacks === undefined || row.stacks === null ? true : Number(row.stacks) !== 0,
  };
}

/** True when the coupon reduces the delivery fee, alone or with the goods. */
export const couponNamesDelivery = (rule: CouponRule): boolean => rule.applies_to === 'delivery' || rule.applies_to === 'both';

/** The last mile the resolver's `delivery_methods` filter understands. */
export const couponDeliveryMethod = (methodId: string): string | null =>
  methodId === 'standard' || methodId === 'personal' ? methodId : null;

export interface ProductCouponFacts {
  brand_id: string | null;
  category_id: string | null;
  sub_category_id: string | null;
}

/** Brand and sections per product, from rows that already hold them (checkout's `p.*`). */
export function productCouponFactsFromRows(rows: readonly Row[]): Map<string, ProductCouponFacts> {
  const out = new Map<string, ProductCouponFacts>();
  for (const r of rows) {
    const id = text(r.id);
    if (!id || out.has(id)) continue;
    out.set(id, { brand_id: text(r.brand_id), category_id: text(r.category_id), sub_category_id: text(r.sub_category_id) });
  }
  return out;
}

/** The same facts read for a set of products in one statement (the ids travel as one JSON parameter). */
export async function productCouponFacts(db: D1Database, productIds: readonly string[]): Promise<Map<string, ProductCouponFacts>> {
  const ids = [...new Set(productIds.filter((x) => typeof x === 'string' && x !== ''))];
  if (!ids.length) return new Map();
  const { results } = await db
    .prepare('SELECT id, brand_id, category_id, sub_category_id FROM products WHERE id IN (SELECT value FROM json_each(?1))')
    .bind(JSON.stringify(ids))
    .all<Row>();
  return productCouponFactsFromRows(results ?? []);
}

/** One priced line as the coupon sees it. */
export interface CouponLineSource {
  id: string;
  product_id: string;
  option_value_ids: readonly string[];
  color_id: string;
  qty: number;
  /** The goods price of one unit — the applied price, never a fee. */
  applied_iqd: number;
  /** The import route, when the line has one ('air' | 'sea' | 'land'). */
  transport_method: string;
  /** A composition parent (bundle or mystery offer): the line carrying the money. */
  is_parent: boolean;
  /** A bundle component or a mystery spool: its money is on the parent. */
  is_component: boolean;
  /** A gift line pays nothing and takes no promotion. */
  is_gift: boolean;
  /** The membership saving still to come off this whole line (applied at the line). */
  member_line_discount_iqd: number;
  /** A membership price, an offer window or a bundle saving already discounted it. */
  already_discounted: boolean;
}

/**
 * The priced lines as the resolver's lines. Only lines that carry money and
 * are not gifts; a bundle or mystery offer is one line (its parent), and its
 * own product id is what a `bundle` scope names.
 *
 * GOODS AFTER THE MEMBERSHIP. A saving the membership applies at the LINE
 * (a quantity limit or a per-order ceiling) is taken off each unit, rounded
 * up, so the coupon never draws on more than the customer is paying for the
 * goods.
 */
export function couponLinesOf(
  lines: readonly CouponLineSource[],
  facts: ReadonlyMap<string, ProductCouponFacts>,
  ancestry: Map<string, string[]> | null,
  fulfillmentType: 'direct_sale' | 'pre_order'
): CouponLine[] {
  const out: CouponLine[] = [];
  for (const l of lines) {
    if (l.is_gift || l.is_component) continue;
    const qty = whole(l.qty);
    const applied = whole(l.applied_iqd);
    if (qty <= 0 || applied <= 0) continue;
    const memberPerUnit = Math.ceil(whole(l.member_line_discount_iqd) / qty);
    const f = facts.get(l.product_id) ?? { brand_id: null, category_id: null, sub_category_id: null };
    out.push({
      line_id: l.id,
      product_id: l.product_id,
      option_value_ids: l.option_value_ids,
      color_id: l.color_id || '',
      brand_id: f.brand_id,
      category_id: f.category_id,
      sub_category_id: f.sub_category_id,
      ancestry: ancestryFor(ancestry, f.category_id, f.sub_category_id),
      bundle_product_id: l.is_parent ? l.product_id : null,
      fulfillment_type: fulfillmentType,
      transport_method: l.transport_method || '',
      qty,
      unit_goods_iqd: Math.max(0, applied - memberPerUnit),
      already_discounted: l.already_discounted || l.member_line_discount_iqd > 0,
    });
  }
  return out;
}

/** The route a line's stored transport snapshot names, or ''. */
export const transportOf = (snapshot: string | null | undefined): string => {
  const t = safeParse<{ method?: unknown } | null>(snapshot ?? null, null);
  return t && typeof t.method === 'string' ? t.method : '';
};

/**
 * A stand-in for a caller with no lines (an old call site, a test): the whole
 * amount as ONE unscoped goods line, no delivery. An unscoped merchandise
 * coupon then takes exactly what it always took; a scoped or delivery coupon
 * names nothing and is refused rather than guessed.
 */
export function wholeOrderTarget(totalIqd: number): { lines: CouponLine[]; ctx: CouponContext } {
  return {
    lines: [
      {
        line_id: 'order',
        product_id: '',
        option_value_ids: [],
        color_id: '',
        brand_id: null,
        category_id: null,
        sub_category_id: null,
        ancestry: null,
        bundle_product_id: null,
        fulfillment_type: '',
        transport_method: '',
        qty: 1,
        unit_goods_iqd: whole(totalIqd),
        already_discounted: false,
      },
    ],
    ctx: { delivery_method: null, delivery_iqd: 0 },
  };
}
