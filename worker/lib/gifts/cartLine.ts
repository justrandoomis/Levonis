/**
 * THE GIFT CART LINE (docs/GIFTS_QUICK_BUY.md §1.2, D4, D6; decisions S7, S8).
 *
 * Identity: a `cart_items` row with `gift_entitlement_id` set, `qty` equal to
 * the gift's frozen quantity and `shipping_method_id = 'gift:<gift id>'` — the
 * discriminator that keeps it out of idx_cart_levonis_line and out of every
 * `shipping_method_id = ''` lookup. UNIQUE per gift (idx_cart_items_gift_line).
 *
 * PRICE RULE: only the PRODUCT is 0 IQD, and only because the server
 * re-verifies the gift on every read (cart, quote, checkout) — a client price,
 * flag or id is never read. Its line fees (the pre-order route commission, the
 * direct-sale premium, a warranty) are 0 too; delivery and the cash-on-delivery
 * rules apply to the order as normal (S7). It earns no points, takes no coupon,
 * membership discount or offer, and triggers no other reward (S8).
 *
 * WHO WRITES WHAT. The add door (POST /api/cart/gift-items, worker/routes/
 * cart.ts) writes the line; DELETE /items/:id, DELETE /, a confirmed «empty the
 * cart» and the checkout remove it — and because ADDED_TO_ORDER is DERIVED from
 * this row, every removal returns the gift to REDEEMED with no state write to
 * forget. The checkout (worker/routes/orders.ts) turns the line into an
 * ordinary `order_items` row at 0 IQD and flips the gift to `ordered` in the
 * SAME batch; the 0175 triggers give it back on cancellation and fulfil it on
 * delivery.
 */
import type { ResolvedPrice } from '../pricing';
import { canonicalOptionValueIds } from '../cartSelectionIdentity';
import { safeParse } from '../types';
import { giftSelectionOf, type GiftSelection } from './selection';

export const GIFT_LINE_PREFIX = 'gift:';

export function giftLineDiscriminator(giftId: string): string {
  return `${GIFT_LINE_PREFIX}${giftId}`;
}

/**
 * The gift a cart (or order) row was produced from, or '' for an ordinary
 * line. A database behind 0175 reads the column through its
 * `CART_LINE_COLUMNS` default (NULL), so every row there is ordinary and no
 * gift branch is ever entered.
 */
export function giftEntitlementIdOf(row: Record<string, unknown> | null | undefined): string {
  const v = row?.gift_entitlement_id;
  return typeof v === 'string' ? v : '';
}

export type GiftLineVerdictCode = 'GIFT_NOT_ORDERABLE' | 'GIFT_ALREADY_ORDERED' | 'GIFT_NOT_REDEEMED' | 'GIFT_LINE_MISMATCH';

export interface GiftLineVerdict {
  ok: boolean;
  code: GiftLineVerdictCode | null;
  giftId: string;
  level: number;
  /** The order attempt a checkout of this line writes (gift_entitlements.order_seq + 1). */
  nextOrderSeq: number;
  /** The frozen selection — pricing and stock use THIS, never the row's columns. */
  selection: GiftSelection | null;
}

/** The gift columns every reader of the cart and the checkout names. */
export const GIFT_LINE_COLUMNS =
  'id, user_id, state, grant_mode, level, order_seq, order_id, gift_product_id, gift_option_value_ids, gift_color_id, gift_qty, gift_sale_type, gift_transport_method';

/** Does this cart row hold exactly the gift's frozen line? */
export function sameGiftLine(row: Record<string, unknown>, giftId: string, sel: GiftSelection): boolean {
  const rowIds = canonicalOptionValueIds(safeParse<unknown[]>(String(row.option_value_ids ?? '[]'), []));
  return (
    String(row.product_id ?? row.id ?? '') === sel.productId &&
    rowIds.length === sel.optionValueIds.length &&
    rowIds.every((v, i) => v === sel.optionValueIds[i]) &&
    String(row.color_id ?? '') === sel.colorId &&
    String(row.fulfillment_type ?? '') === sel.saleType &&
    String(row.transport_method ?? '') === sel.transportMethod &&
    Number(row.qty) === sel.qty &&
    String(row.warranty_plan_id ?? '') === '' &&
    String(row.shipping_method_id ?? '') === giftLineDiscriminator(giftId)
  );
}

/**
 * Verify every gift row of a cart in ONE read (no read at all when there is
 * none). ok ⇔ the gift is this user's, `redeemed`, and the row equals its
 * frozen line.
 *
 * Keyed by the CART LINE id: `cart_item_id` on the cart and checkout reads
 * (whose `p.*` makes `id` the product's), else `id` on a bare `cart_items` row.
 */
export async function verifyGiftCartLines(
  db: D1Database,
  userId: string,
  rows: ReadonlyArray<Record<string, unknown>>
): Promise<Map<string, GiftLineVerdict>> {
  const out = new Map<string, GiftLineVerdict>();
  const giftRows = rows.filter((r) => giftEntitlementIdOf(r) !== '');
  if (giftRows.length === 0) return out;
  const ids = [...new Set(giftRows.map((r) => giftEntitlementIdOf(r)))];
  const { results } = await db
    .prepare(`SELECT ${GIFT_LINE_COLUMNS} FROM gift_entitlements WHERE id IN (SELECT value FROM json_each(?))`)
    .bind(JSON.stringify(ids))
    .all<Record<string, unknown>>();
  const byId = new Map((results ?? []).map((r) => [String(r.id), r]));

  for (const row of giftRows) {
    const lineId = String(row.cart_item_id ?? row.id ?? '');
    const giftId = giftEntitlementIdOf(row);
    const g = byId.get(giftId);
    // A row naming another account's gift (or one that no longer exists) is
    // answered exactly like a gift that cannot be ordered: nothing about the
    // other account is disclosed, and the line is never priced at 0.
    if (!g || String(g.user_id) !== userId) {
      out.set(lineId, { ok: false, code: 'GIFT_NOT_ORDERABLE', giftId, level: 0, nextOrderSeq: 0, selection: null });
      continue;
    }
    const sel = giftSelectionOf(g);
    const verdict: GiftLineVerdict = {
      ok: false,
      code: null,
      giftId,
      level: Number(g.level) || 0,
      nextOrderSeq: (Number(g.order_seq) || 0) + 1,
      selection: sel,
    };
    const state = String(g.state ?? '');
    if (state === 'ordered' || state === 'fulfilled') verdict.code = 'GIFT_ALREADY_ORDERED';
    else if (state === 'granted' || state === 'ready_to_redeem') verdict.code = 'GIFT_NOT_REDEEMED';
    else if (state !== 'redeemed' || !sel) verdict.code = 'GIFT_NOT_ORDERABLE';
    else if (sameGiftLine(row, giftId, sel)) verdict.ok = true;
    else verdict.code = 'GIFT_LINE_MISMATCH';
    out.set(lineId, verdict);
  }
  return out;
}

/** The customer-facing refusal for a gift line that cannot be ordered. */
export function giftVerdictRefusal(v: GiftLineVerdict | undefined): 'GIFT_ALREADY_ORDERED' | 'GIFT_NOT_ORDERABLE' {
  return v?.code === 'GIFT_ALREADY_ORDERED' ? 'GIFT_ALREADY_ORDERED' : 'GIFT_NOT_ORDERABLE';
}

/** The block a gift line carries in `pricing_snapshot.gift`, the cart and the quote. */
export interface GiftPricingBlock {
  gift_id: string;
  level: number;
  /** The product's regular price × quantity at order time — shown as the gift's value, never charged. */
  value_iqd: number;
}

export function giftPricingBlock(v: GiftLineVerdict, regularUnitIqd: number, qty: number): GiftPricingBlock {
  return {
    gift_id: v.giftId,
    level: v.level,
    value_iqd: Math.max(0, Math.round(Number(regularUnitIqd) || 0)) * Math.max(1, qty),
  };
}

/**
 * THE RESOLVER'S ANSWER WITH ONLY THE PRODUCT MADE FREE (S7).
 *
 * The product (`applied_iqd`), the membership rungs and every line-level fee —
 * the pre-order route commission, the direct-sale premium, the extended
 * warranty — are 0. What the line IS stays exactly as resolved: the regular
 * price (the gift's value), the order type and its lead time, the route
 * (`transport.method`, so the order stays `preorder_<route>`) and the pricing
 * basis. `transport.waived` with `waived_by: 'gift'` is what keeps the
 * commission off the invoice, the same flag a PRO waiver sets. `cost_iqd` is
 * kept for the caller to move into the cost columns: a gift is a promotional
 * cost, never pure margin.
 */
export function zeroGiftPrice(resolved: ResolvedPrice): ResolvedPrice {
  return {
    ...resolved,
    applied_iqd: 0,
    applied_tier: 'regular',
    pro_iqd: null,
    prime_iqd: null,
    member_rule: { pro: null, prime: null },
    components: {
      ...resolved.components,
      membership_adjustment_iqd: 0,
      transport_fee_iqd: 0,
      direct_fee_iqd: 0,
      warranty_fee_iqd: 0,
    },
    // The snapshot is JSON: 'gift' is one more reason beside 'pro' and
    // 'cod_direct_pricing', and the pricing package's union is not widened for
    // a value only this file writes.
    transport: resolved.transport
      ? ({ method: resolved.transport.method, commission_iqd: 0, waived: true, waived_by: 'gift' } as unknown as ResolvedPrice['transport'])
      : null,
    direct: null,
    warranty: null,
    unit_subtotal_iqd: 0,
  };
}

/** `order_items.transport_snapshot` of a gift line: the route kept, nothing charged. */
export function giftTransportSnapshot(zeroed: ResolvedPrice): string | null {
  return zeroed.transport ? JSON.stringify(zeroed.transport) : null;
}

/**
 * Which of these gifts another order consumed — read after a checkout batch
 * failed, so the customer is told the true reason: «already ordered» when one
 * of their gifts is now `ordered` or `fulfilled`, «cannot be ordered right
 * now» when one is no longer `redeemed` for another reason, null when every
 * gift is still waiting (the failure was something else). Never throws.
 */
export async function giftCheckoutRefusalCode(
  db: D1Database,
  userId: string,
  giftIds: readonly string[],
  expectedSeq: ReadonlyMap<string, number>
): Promise<'GIFT_ALREADY_ORDERED' | 'GIFT_NOT_ORDERABLE' | null> {
  if (giftIds.length === 0) return null;
  try {
    const { results } = await db
      .prepare(`SELECT id, state, order_seq FROM gift_entitlements WHERE id IN (SELECT value FROM json_each(?1)) AND user_id = ?2`)
      .bind(JSON.stringify([...giftIds]), userId)
      .all<{ id: string; state: string; order_seq: number }>();
    const rows = results ?? [];
    if (rows.some((r) => r.state === 'ordered' || r.state === 'fulfilled')) return 'GIFT_ALREADY_ORDERED';
    if (rows.length < giftIds.length || rows.some((r) => r.state !== 'redeemed')) return 'GIFT_NOT_ORDERABLE';
    // Every gift is still redeemed — but an attempt moved on under us (a
    // concurrent order was placed and cancelled): the line must be re-read.
    if (rows.some((r) => expectedSeq.has(r.id) && Number(r.order_seq) + 1 !== expectedSeq.get(r.id))) return 'GIFT_NOT_ORDERABLE';
    return null;
  } catch {
    return 'GIFT_NOT_ORDERABLE';
  }
}
