/**
 * PRICE PROTECTION «حماية السعر» — THE CLAIM'S COMPARISON, ITS PROJECTIONS AND
 * ITS NOTICES (Services V2 S-P0a; price-protection design B.13 P0).
 *
 * Like with like (design B.1 principle 2), read from the line's own checkout
 * snapshot rather than guessed:
 *
 *   - THE RUNG (PP-B2). `price_history` records the raw field of each row
 *     that changed — the product's base price under '', a model's own price
 *     under `option:<id>`, a colour's under `color:<id>`. Only the row that
 *     prices the line is an observation of the line's price: a model that
 *     carries its own price is never compared with the base price (nor the
 *     base with a model's). When the rung that prices the line today is not
 *     the rung that priced it at checkout, the raw rows no longer say what the
 *     line cost at any moment, so only today's live price (and the engine's
 *     own observations) count. The observation ledger of S-P8 replaces this.
 *   - THE CHANNEL (PP-B3). A pre-order line is priced today on its own
 *     pre-order route — and a pre-order paid cash on delivery on the direct
 *     schedule it was charged on (plan correction 8) — never on the direct
 *     sale the resolver infers when no channel is given. A channel the shop
 *     has since closed has no price today; the history window still counts.
 *   - THE CLASS (PP-B4). A PRIME buyer is compared with today's PRIME price,
 *     a PRO buyer with PRO, through the cart's own membership rules (policy
 *     §10.4: «a buyer of the same price class»).
 *
 * The customer reads their own claim — amounts, state, the decision reason —
 * and never the staff's comparison inputs (PP-B7). The decision is told to the
 * customer in the same batch as the decision itself (PP-B6).
 */
import type { Tier } from '../../packages/pricing/src/pricing';
import { notifyStatement } from './notifications';
import { safeParse } from './types';
import {
  PRICE_PROTECTION_NOTICES,
  priceProtectionReasonAll,
  type PriceProtectionText,
} from '../../packages/contracts/src/priceProtection';

export type BuyerClass = 'regular' | 'prime' | 'pro';

/** The class the buyer was charged at checkout (the resolver's `applied_tier`). */
export function buyerClassOf(pricing: { applied_tier?: unknown } | null | undefined): BuyerClass {
  const tier = pricing?.applied_tier;
  return tier === 'pro' ? 'pro' : tier === 'prime' ? 'prime' : 'regular';
}

/** The resolver's tier for a class. */
export const tierOfClass = (cls: BuyerClass): Tier => (cls === 'regular' ? 'free' : cls);

/**
 * The history fields that observe a class's price. A member's own field, and
 * the regular field beside it: the member ladder is clamped to the regular
 * price, so a regular row is never below the member price of its moment and
 * can only bound the comparison from above.
 */
export function historyFieldsOf(cls: BuyerClass): string[] {
  return cls === 'regular' ? ['regular'] : [cls, 'regular'];
}

export interface LineChannel {
  /** Stated only for a pre-order line; a direct line keeps the resolver's own inference. */
  fulfillmentType: 'pre_order' | null;
  transportMethod: string | null;
  preorderPricing: 'prepaid' | 'cod';
}

/**
 * The channel the line was priced on, from its snapshots. A direct line (and
 * any line whose snapshot does not say) is resolved exactly as before: no
 * stated type, no route.
 */
export function lineChannelOf(
  pricing: { pricing_basis?: unknown; fulfillment?: { type?: unknown } | null } | null | undefined,
  transport: { method?: unknown; waived_by?: unknown } | null | undefined
): LineChannel {
  const method = typeof transport?.method === 'string' ? transport.method.trim() : '';
  const preOrder = pricing?.fulfillment?.type === 'pre_order' || pricing?.pricing_basis === 'preorder' || transport?.waived_by === 'cod_direct_pricing';
  if (!preOrder || !method) return { fulfillmentType: null, transportMethod: null, preorderPricing: 'prepaid' };
  return { fulfillmentType: 'pre_order', transportMethod: method, preorderPricing: transport?.waived_by === 'cod_direct_pricing' ? 'cod' : 'prepaid' };
}

/** The resolver's answers that mean «this channel is not sold today», not «this variant is gone». */
export const CHANNEL_CLOSED_ERRORS: ReadonlySet<string> = new Set([
  'FULFILLMENT_NOT_OFFERED',
  'FULFILLMENT_DISABLED',
  'TRANSPORT_DISABLED',
  'TRANSPORT_NOT_OFFERED',
]);

const SOURCES = new Set(['base', 'option', 'fulfillment', 'transport', 'color', 'sku']);

/**
 * The `price_history` keys whose rows ARE the line's price (PP-B2): the key of
 * the rung that prices the line today, provided it is the rung that priced it
 * at checkout (when the snapshot says). The route and order-type cells have no
 * manual history writer, and the SKU rung's history is the engine's own
 * (`sku:` keys, read beside), so those rungs read no manual rows.
 */
export function historyKeysOf(a: { todaySource: string; purchaseSource?: unknown; optionId: string; colorId: string }): string[] {
  const purchase = typeof a.purchaseSource === 'string' && SOURCES.has(a.purchaseSource) ? a.purchaseSource : null;
  if (purchase !== null && purchase !== a.todaySource) return [];
  if (a.todaySource === 'base') return [''];
  if (a.todaySource === 'option') return a.optionId ? [`option:${a.optionId}`] : [];
  if (a.todaySource === 'color') return a.colorId ? [`color:${a.colorId}`] : [];
  return [];
}

// ------------------------------------------------------------- projections

export interface ClaimRowLike extends Record<string, unknown> {
  id: string;
  order_id: string;
  order_item_id: string;
  original_unit_iqd: number;
  observed_unit_iqd: number;
  qty: number;
  credited_iqd: number;
  state: string;
  policy_snapshot: string;
  requested_at: string;
  decided_at: string | null;
  eligible_unit_iqd?: number | null;
}

/** The decision reason the customer reads (a declined claim only): the code and the note. */
export function decisionReasonOf(r: Pick<ClaimRowLike, 'state' | 'policy_snapshot'>): { code: string | null; note: string } | null {
  if (r.state !== 'rejected') return null;
  const p = safeParse<{ decision_reason?: unknown; decision_reason_code?: unknown }>(r.policy_snapshot, {});
  return {
    code: typeof p.decision_reason_code === 'string' ? p.decision_reason_code : null,
    note: typeof p.decision_reason === 'string' ? p.decision_reason.slice(0, 1000) : '',
  };
}

/**
 * THE CUSTOMER'S CLAIM (PP-B7): what was paid, the price compared, the units,
 * what was credited, the state and — once declined — the reason. Never the
 * policy snapshot: it is the staff's comparison material, and older rows carry
 * an internal note.
 */
export function claimForCustomer(r: ClaimRowLike, extra: Record<string, unknown> = {}) {
  return {
    id: r.id,
    order_id: r.order_id,
    order_item_id: r.order_item_id,
    original_unit_iqd: r.original_unit_iqd,
    observed_unit_iqd: r.observed_unit_iqd,
    qty: r.qty,
    credited_iqd: r.credited_iqd,
    state: r.state,
    // Owner decision 6: the dinars a claim covers per unit when part of the fall came from the exchange
    // rate (the customer's «المشمول» line); never a USD figure, a rate or a supplier value.
    eligible_unit_iqd: r.eligible_unit_iqd ?? null,
    decision_reason: decisionReasonOf(r),
    requested_at: r.requested_at,
    decided_at: r.decided_at,
    ...extra,
  };
}

/** The staff's claim: the customer's, plus the comparison snapshot (evidence; it carries no cost). */
export function claimForStaff(r: ClaimRowLike, extra: Record<string, unknown> = {}) {
  return { ...claimForCustomer(r), policy: safeParse(r.policy_snapshot, {}), ...extra };
}

// ------------------------------------------------------------- notices

/** «1,234 د.ع» / «1,234 IQD» — the figure the wallet entry carries. */
export function iqdWords(n: number, lang: keyof PriceProtectionText): string {
  const v = Math.trunc(n).toLocaleString('en-US');
  return lang === 'en' ? `${v} IQD` : `${v} د.ع`;
}

/** The item as the customer named it at checkout, short and single-line. */
export function itemLabel(name: unknown): string {
  const s = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  return s || '—';
}

const orderLink = (orderId: string) => `/orders/${encodeURIComponent(orderId)}`;

/** The bell row for a credited claim, for the approval batch. */
export function creditedNotice(db: D1Database, a: { userId: string; claimId: string; orderId: string; item: string; creditIqd: number }) {
  const t = PRICE_PROTECTION_NOTICES.credited;
  const title = {
    ar: t.title(iqdWords(a.creditIqd, 'ar')).ar,
    en: t.title(iqdWords(a.creditIqd, 'en')).en,
    ckb: t.title(iqdWords(a.creditIqd, 'ckb')).ckb,
  };
  const body = t.body(a.item);
  return notifyStatement(db, {
    userId: a.userId,
    kind: 'price_protection',
    title_ar: title.ar,
    title_en: title.en,
    body_ar: body.ar,
    body_en: body.en,
    meta: { title_ckb: title.ckb, body_ckb: body.ckb, state: 'credited' },
    link: orderLink(a.orderId),
    entity_type: 'price_protection',
    entity_id: a.claimId,
    eventKey: `pp:${a.claimId}:credited`,
  }).stmt;
}

/** The bell row for a declined claim, carrying the reason in the three languages. */
export function rejectedNotice(db: D1Database, a: { userId: string; claimId: string; orderId: string; item: string; reasonCode: string | null; note: string }) {
  const t = PRICE_PROTECTION_NOTICES.rejected;
  const title = t.title();
  const body = t.body(a.item, priceProtectionReasonAll(a.reasonCode, a.note));
  return notifyStatement(db, {
    userId: a.userId,
    kind: 'price_protection',
    title_ar: title.ar,
    title_en: title.en,
    body_ar: body.ar,
    body_en: body.en,
    meta: { title_ckb: title.ckb, body_ckb: body.ckb, state: 'rejected' },
    link: orderLink(a.orderId),
    entity_type: 'price_protection',
    entity_id: a.claimId,
    eventKey: `pp:${a.claimId}:rejected`,
  }).stmt;
}
