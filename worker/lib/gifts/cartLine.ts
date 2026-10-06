/**
 * THE GIFT CART LINE (docs/REVIEWS_GIFTS.md §Cart). Owner: lane S3.
 *
 * Identity: a `cart_items` row with `gift_entitlement_id` set, `qty` 1 and
 * `shipping_method_id = 'gift:<entitlement id>'` (the discriminator that keeps
 * it out of idx_cart_levonis_line and out of every `shipping_method_id = ''`
 * lookup). UNIQUE per entitlement (idx_cart_items_gift_line); the 0165
 * trigger refuses any gift line whose entitlement is not this user's,
 * ready to order and of this product.
 *
 * Price rule: the PRODUCT is 0 IQD — only because the server re-verifies the
 * entitlement on every read (cart, quote, checkout). A client price, flag or
 * id is never read. Delivery follows the order's normal rules; line-level
 * fees (pre-order route commission, direct premium, warranty) are 0 on a gift
 * line; `regular_iqd` stays visible as the gift's value.
 *
 * WHO WRITES WHAT. The add door (POST /api/cart/gift-items, worker/routes/
 * cart.ts) writes the line with a plain INSERT; DELETE /items/:id, DELETE /,
 * a confirmed «empty the cart» and the checkout remove it — and because
 * «in cart» is DERIVED from this row, every removal returns the gift to
 * «ready to order» with no state write to forget. The checkout
 * (worker/routes/orders.ts) turns the line into an ordinary `order_items` row
 * at 0 IQD and flips the entitlement to `ordered` in the SAME batch; the 0165
 * triggers give it back on cancellation and fulfil it on delivery.
 */
import { safeParse } from '../types';
import { canonicalOptionValueIds } from '../cartSelectionIdentity';
import type { ResolvedPrice } from '../pricing';

export const GIFT_LINE_PREFIX = 'gift:';

export function giftLineDiscriminator(entitlementId: string): string {
  return `${GIFT_LINE_PREFIX}${entitlementId}`;
}

/**
 * The entitlement a cart (or order) row was produced from, or '' for an
 * ordinary line. A database behind 0165 reads the column through its
 * `CART_LINE_COLUMNS` default (NULL), so every row there is ordinary and no
 * gift branch is ever entered.
 */
export function giftEntitlementIdOf(row: Record<string, unknown> | null | undefined): string {
  const v = row?.gift_entitlement_id;
  return typeof v === 'string' ? v : '';
}

export type GiftSaleType = 'direct_sale' | 'pre_order';

/** The one product, model, colour, sale type and route an entitlement grants. */
export interface FrozenGiftLine {
  productId: string;
  /** Canonical (sorted, de-duplicated) — the cart's own identity order. */
  optionValueIds: string[];
  colorId: string;
  saleType: GiftSaleType;
  /** '' on a direct sale; the admin's pinned route on a pre-order ('' = none was pinned). */
  transportMethod: string;
}

/**
 * The frozen line of an entitlement row, or null when no item is chosen yet
 * (a level gift whose customer has not picked one of the alternatives). Read
 * from the `gift_*` columns ONLY — the snapshot is display, never authority.
 */
export function frozenGiftLine(ent: Record<string, unknown> | null | undefined): FrozenGiftLine | null {
  if (!ent) return null;
  const productId = typeof ent.gift_product_id === 'string' ? ent.gift_product_id : '';
  const saleType = ent.gift_sale_type;
  if (!productId || (saleType !== 'direct_sale' && saleType !== 'pre_order')) return null;
  return {
    productId,
    optionValueIds: canonicalOptionValueIds(safeParse<unknown[]>(String(ent.gift_option_value_ids ?? '[]'), [])),
    colorId: typeof ent.gift_color_id === 'string' ? ent.gift_color_id : '',
    saleType,
    // A direct sale has no route, whatever a column says: the cart types a
    // line by its transport, and a direct gift must never read as a pre-order.
    transportMethod: saleType === 'pre_order' && typeof ent.gift_transport_method === 'string' ? ent.gift_transport_method : '',
  };
}

export type GiftLineVerdictCode = 'GIFT_NOT_ORDERABLE' | 'GIFT_ALREADY_ORDERED' | 'GIFT_NOT_REDEEMED' | 'GIFT_LINE_MISMATCH';

export interface GiftLineVerdict {
  ok: boolean;
  code: GiftLineVerdictCode | null;
  entitlementId: string;
  rewardId: string;
  level: number;
  /** The order attempt this checkout would write (gift_entitlements.order_seq + 1). */
  nextOrderSeq: number;
  /** The frozen selection — pricing and stock use THIS, never the row's columns. */
  selection: {
    productId: string;
    optionValueIds: string[];
    colorId: string;
    saleType: 'direct_sale' | 'pre_order';
    transportMethod: string;
  };
}

/** The entitlement columns every gift reader of the cart and the checkout names. */
export const GIFT_LINE_ENTITLEMENT_COLUMNS =
  'id, user_id, reward_id, state, grant_mode, max_level, chosen_level, order_seq, order_id, ' +
  'gift_product_id, gift_option_value_ids, gift_color_id, gift_sale_type, gift_transport_method';

/** The level a gift was granted at: the chosen one, else the ceiling (equal for every new-flow gift). */
export function giftLevelOf(ent: Record<string, unknown>): number {
  const n = Number(ent.chosen_level ?? ent.max_level);
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : 0;
}

const NO_SELECTION: GiftLineVerdict['selection'] = {
  productId: '',
  optionValueIds: [],
  colorId: '',
  saleType: 'direct_sale',
  transportMethod: '',
};

/**
 * Verify every gift row of a cart in ONE read (`json_each` of the entitlement
 * ids; no query when there are none). ok ⇔ owner = user, state
 * 'redeemed_ready_to_order', and the row's product / option_value_ids /
 * color_id / fulfillment_type / transport_method / qty 1 / warranty '' /
 * discriminator equal the entitlement's frozen line.
 *
 * Keyed by the CART LINE id: `cart_item_id` on the cart and checkout reads
 * (whose `p.*` makes `id` the product's), else `id` on a bare `cart_items` row.
 * The product is `product_id` on a bare row, else `id` (`products` has no
 * `product_id` column, so the two readings cannot collide).
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
    .prepare(`SELECT ${GIFT_LINE_ENTITLEMENT_COLUMNS} FROM gift_entitlements WHERE id IN (SELECT value FROM json_each(?))`)
    .bind(JSON.stringify(ids))
    .all<Record<string, unknown>>();
  const byId = new Map((results ?? []).map((r) => [String(r.id), r]));

  for (const row of giftRows) {
    const lineId = String(row.cart_item_id ?? row.id ?? '');
    const entitlementId = giftEntitlementIdOf(row);
    const ent = byId.get(entitlementId);
    // A row naming another account's gift (or one that no longer exists) is
    // answered exactly like a gift that cannot be ordered: nothing about the
    // other account is disclosed, and the line is never priced at 0.
    if (!ent || String(ent.user_id) !== userId) {
      out.set(lineId, { ok: false, code: 'GIFT_NOT_ORDERABLE', entitlementId, rewardId: '', level: 0, nextOrderSeq: 0, selection: NO_SELECTION });
      continue;
    }
    const frozen = frozenGiftLine(ent);
    const verdict: GiftLineVerdict = {
      ok: false,
      code: null,
      entitlementId,
      rewardId: String(ent.reward_id ?? ''),
      level: giftLevelOf(ent),
      nextOrderSeq: (Number(ent.order_seq) || 0) + 1,
      selection: frozen ?? NO_SELECTION,
    };
    const state = String(ent.state ?? '');
    if (state === 'ordered' || state === 'fulfilled') verdict.code = 'GIFT_ALREADY_ORDERED';
    else if (state === 'code_issued') verdict.code = 'GIFT_NOT_REDEEMED';
    else if (state !== 'redeemed_ready_to_order' || !frozen) verdict.code = 'GIFT_NOT_ORDERABLE';
    else {
      const rowIds = canonicalOptionValueIds(safeParse<unknown[]>(String(row.option_value_ids ?? '[]'), []));
      const sameLine =
        String(row.product_id ?? row.id ?? '') === frozen.productId &&
        rowIds.length === frozen.optionValueIds.length &&
        rowIds.every((v, i) => v === frozen.optionValueIds[i]) &&
        String(row.color_id ?? '') === frozen.colorId &&
        String(row.fulfillment_type ?? '') === frozen.saleType &&
        String(row.transport_method ?? '') === frozen.transportMethod &&
        Number(row.qty) === 1 &&
        String(row.warranty_plan_id ?? '') === '' &&
        String(row.shipping_method_id ?? '') === giftLineDiscriminator(entitlementId);
      if (sameLine) {
        verdict.ok = true;
      } else verdict.code = 'GIFT_LINE_MISMATCH';
    }
    out.set(lineId, verdict);
  }
  return out;
}

/**
 * The customer-facing code for a gift line that cannot be ordered — the two
 * the checkout answers with (docs/REVIEWS_GIFTS.md §6.3). A mismatch, a
 * foreign or unknown entitlement and an unredeemed one are all «cannot be
 * ordered right now»; only a gift another order consumed says so.
 */
export function giftVerdictRefusal(v: GiftLineVerdict | undefined): 'GIFT_ALREADY_ORDERED' | 'GIFT_NOT_ORDERABLE' {
  return v?.code === 'GIFT_ALREADY_ORDERED' ? 'GIFT_ALREADY_ORDERED' : 'GIFT_NOT_ORDERABLE';
}

/** The pricing block a gift line carries in `pricing_snapshot.gift` and in the cart/quote answers. */
export interface GiftPricingBlock {
  entitlement_id: string;
  reward_id: string;
  level: number;
  /** The product's regular price at order time — shown as the gift's value, never charged. */
  value_iqd: number;
}

export function giftPricingBlock(v: GiftLineVerdict, regularIqd: number): GiftPricingBlock {
  return {
    entitlement_id: v.entitlementId,
    reward_id: v.rewardId,
    level: v.level,
    value_iqd: Math.max(0, Math.round(Number(regularIqd) || 0)),
  };
}

/**
 * THE RESOLVER'S ANSWER WITH ONLY THE PRODUCT MADE FREE (S7).
 *
 * The product (`applied_iqd`), the membership rungs and every line-level fee —
 * the pre-order route commission, the direct-sale premium, the extended
 * warranty — are 0. What the line IS stays exactly as resolved: the regular
 * price (the gift's value), the order type and its lead time
 * (`fulfillment`), the route (`transport.method`, so the order stays
 * `preorder_<route>`) and the pricing basis. `transport.waived` with
 * `waived_by: 'gift'` is what keeps the commission off the invoice, the same
 * flag a PRO waiver sets. `cost_iqd` is kept for the caller to strip into the
 * cost columns: a gift is a promotional cost, never pure margin.
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
    // 'cod_direct_pricing', and the pricing package's union is not widened
    // for a value only this file writes.
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
 * Which of these entitlements another order has consumed — read after a
 * checkout batch was refused by the 0165 guard, so the customer is told the
 * true reason: «already ordered» when one of their gifts is now `ordered` or
 * `fulfilled`, «cannot be ordered right now» otherwise (an admin cancelled it,
 * or the line went stale). Never throws: a failed read is the generic answer.
 */
export async function giftCheckoutRefusalCode(
  db: D1Database,
  userId: string,
  entitlementIds: readonly string[]
): Promise<'GIFT_ALREADY_ORDERED' | 'GIFT_NOT_ORDERABLE'> {
  if (entitlementIds.length === 0) return 'GIFT_NOT_ORDERABLE';
  try {
    const hit = await db
      .prepare(
        `SELECT 1 AS x FROM gift_entitlements
          WHERE id IN (SELECT value FROM json_each(?1)) AND user_id = ?2 AND state IN ('ordered', 'fulfilled')
          LIMIT 1`
      )
      .bind(JSON.stringify([...entitlementIds]), userId)
      .first();
    return hit ? 'GIFT_ALREADY_ORDERED' : 'GIFT_NOT_ORDERABLE';
  } catch {
    return 'GIFT_NOT_ORDERABLE';
  }
}
