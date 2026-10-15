/**
 * «عرض آمن للمتجر» — THE STORE-SAFE TRADE-IN OFFER (owner decision 1, DECISIONS
 * rows 223 and 238; Services V2 S-P2 spec §4).
 *
 * PURE, INTEGERS ONLY. No I/O, no clock, no float: every product of two large
 * figures is a BigInt, every division rounds DOWN (against the store never, for
 * the store always — an offer that rounds up promises a dinar the rules did not
 * give). The Worker (worker/lib/tradeInOffer.ts) gathers the facts — today's
 * public price, what was paid, the condition answers — and this module turns
 * them into ONE figure.
 *
 * PRIVATE. The parameters below (resale share, handling, warranty reserve,
 * margin, the store's cap) are the owner's: this module is imported by the
 * Worker and the tests only, never by a client file (the customer's chunk must
 * not download them — the tradeInDefaults.ts rule, DECISIONS row 219).
 *
 * ─── ONE COMPONENT ─────────────────────────────────────────────────────────
 *
 *   base   = min(paid_c, now_c)                       never more than what was paid, nor than new today
 *   v      = the condition engine (valuateComponent) on that base, with no
 *            floor and no «market» factor, clamped to cap_bp
 *   q_bp   = (base + Σ factor amounts) / base         the condition as a share of new
 *   cond   = v.value_iqd                              the condition value
 *   E      = now × resale_bp × q_bp / 10^8            what the shop expects to resell it for
 *   K      = handling + now × warranty_reserve_bp × warranty months left / 10^4
 *   M      = max(E × margin_bp / 10^4, margin_min)    the store's margin
 *   cap    = E − K − M                                the most the shop can pay without a loss
 *   maxo   = now × max_offer_bp / 10^4                never more than this share of new
 *   offer  = max(0, min(cond, cap, maxo))
 *
 * ─── THE REQUEST ───────────────────────────────────────────────────────────
 *
 *   raw    = Σ offer_c   (a whole Combo also ≤ combo_now × max_offer_bp)
 *   offer  = raw rounded DOWN to `offer_rounding_iqd`; below `min_offer_iqd` → no offer.
 */
import {
  blankInputs,
  valuateComponent,
  type ComponentInputs,
  type ComponentRole,
  type TradeInFamily,
  type TradeInRuleSet,
  type TradeInSettlement,
} from './tradeIn';

export interface OfferParams {
  /** Expected used resale price as a share of new, in basis points (at a perfect condition). */
  resale_bp: number;
  /** Cleaning, checking and listing one device, dinars. */
  handling_iqd: number;
  /** Reserve per month of warranty the device still carries, basis points of new. */
  warranty_reserve_bp: number;
  /** The store's margin on the expected resale, basis points … */
  margin_bp: number;
  /** … and never less than this, dinars. */
  margin_min_iqd: number;
  /** The offer never exceeds this share of today's new price (≤ 9,500 by CHECK). */
  max_offer_bp: number;
  /** The condition engine's ceiling (the rule set's existing `cap_bp`). */
  cap_bp: number;
  /** The offer is rounded DOWN to a multiple of this. */
  offer_rounding_iqd: number;
  /** Below this, no offer. */
  min_offer_iqd: number;
}

/** The columns a rule set may override (0192); `cap_bp` is the rule set's own. */
export const OFFER_PARAM_COLUMNS = [
  'resale_bp',
  'handling_iqd',
  'warranty_reserve_bp',
  'margin_bp',
  'margin_min_iqd',
  'max_offer_bp',
  'offer_rounding_iqd',
  'min_offer_iqd',
] as const;
export type OfferParamColumn = (typeof OFFER_PARAM_COLUMNS)[number];

/** The CHECK ranges of migration 0192, so a save is refused before the database does. */
export const OFFER_PARAM_RANGES: Readonly<Record<OfferParamColumn, readonly [number, number]>> = {
  resale_bp: [0, 10_000],
  handling_iqd: [0, 10_000_000],
  warranty_reserve_bp: [0, 1_000],
  margin_bp: [0, 10_000],
  margin_min_iqd: [0, 100_000_000],
  max_offer_bp: [0, 9_500],
  offer_rounding_iqd: [1, 1_000_000],
  min_offer_iqd: [0, 100_000_000],
};

const P = (
  resale_bp: number,
  handling_iqd: number,
  warranty_reserve_bp: number,
  margin_bp: number,
  margin_min_iqd: number,
  max_offer_bp: number,
  cap_bp: number,
  min_offer_iqd: number
): OfferParams => ({ resale_bp, handling_iqd, warranty_reserve_bp, margin_bp, margin_min_iqd, max_offer_bp, cap_bp, offer_rounding_iqd: 5_000, min_offer_iqd });

/** Spec §4.4 — the defaults until the owner saves a version of a family. */
export const DEFAULT_OFFER_PARAMS: Readonly<Record<TradeInFamily, OfferParams>> = {
  fdm: P(8_000, 25_000, 25, 1_500, 50_000, 7_000, 8_500, 50_000),
  resin: P(7_000, 25_000, 25, 1_500, 50_000, 6_000, 8_000, 50_000),
  laser: P(7_500, 30_000, 25, 1_500, 50_000, 6_500, 8_000, 50_000),
  ams: P(8_000, 10_000, 25, 1_500, 20_000, 7_000, 8_000, 20_000),
  accessory: P(6_000, 5_000, 0, 2_000, 10_000, 5_000, 7_000, 10_000),
};

/** A stored rule set as far as the offer reads it: each 0192 column may be NULL (= the default). */
export type StoredRuleSetLike = Pick<TradeInRuleSet, 'family' | 'cap_bp'> & Partial<Record<OfferParamColumn, number | null>>;

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);

/** The parameters in force: each stored column, or the family's default; `cap_bp` from the rule set. */
export function paramsOf(rules: StoredRuleSetLike): OfferParams {
  const d = DEFAULT_OFFER_PARAMS[rules.family];
  const out = { ...d, cap_bp: isInt(rules.cap_bp) ? rules.cap_bp : d.cap_bp };
  for (const k of OFFER_PARAM_COLUMNS) {
    const v = rules[k];
    const [lo, hi] = OFFER_PARAM_RANGES[k];
    if (isInt(v) && v >= lo && v <= hi) out[k] = v;
  }
  return out;
}

/** An owner's parameter edit: every key present must be an integer inside its CHECK range, or null (= default). */
export function validateOfferParams(raw: unknown): { ok: true; value: Partial<Record<OfferParamColumn, number | null>> } | { ok: false; errors: string[] } {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const errors: string[] = [];
  const value: Partial<Record<OfferParamColumn, number | null>> = {};
  for (const k of OFFER_PARAM_COLUMNS) {
    if (!(k in o)) continue;
    const v = o[k];
    if (v === null) {
      value[k] = null;
      continue;
    }
    const [lo, hi] = OFFER_PARAM_RANGES[k];
    if (!isInt(v) || v < lo || v > hi) errors.push(`params.${k}`);
    else value[k] = v;
  }
  return errors.length ? { ok: false, errors } : { ok: true, value };
}

// ============================================================ integer helpers

const big = (n: number) => BigInt(Math.trunc(n));
/** floor(a × b × c / d) for non-negative integers, exact (BigInt). */
const mulDiv = (a: number, b: number, c: number, d: number): number => {
  if (a <= 0 || b <= 0 || c <= 0) return 0;
  return Number((big(a) * big(b) * big(c)) / big(d));
};
const floorTo = (n: number, step: number) => {
  const s = Math.max(1, Math.trunc(step) || 1);
  return n <= 0 ? 0 : Math.floor(n / s) * s;
};

// ============================================================ one component

export interface ComponentFacts {
  role: ComponentRole;
  family: TradeInFamily;
  /** Today's lowest public new price of the same SKU (worker/lib/tradeInToday.ts). */
  now_iqd: number;
  /** What was paid for this part (paid net, split by today's prices). */
  paid_iqd: number;
  usage_months: number;
  warranty_left_months: number;
  product_id: string;
  inputs: ComponentInputs;
}

export interface ComponentOffer {
  role: ComponentRole;
  family: TradeInFamily;
  now_iqd: number;
  paid_iqd: number;
  base_iqd: number;
  q_bp: number;
  cond_iqd: number;
  resale_iqd: number;
  costs_iqd: number;
  margin_iqd: number;
  store_cap_iqd: number;
  max_offer_iqd: number;
  offer_iqd: number;
}

/** The condition engine with no floor and no «market» factor (the resale view is E's own business now). */
export function conditionRules(rules: TradeInRuleSet, p: OfferParams): TradeInRuleSet {
  return {
    ...rules,
    floor_bp: 0,
    cap_bp: p.cap_bp,
    factors: rules.factors.map((f) => (f.factor === 'market' ? { ...f, enabled: false } : f)),
  };
}

export function componentOffer(rules: TradeInRuleSet, p: OfferParams, f: ComponentFacts): ComponentOffer {
  const now = Math.max(0, Math.trunc(f.now_iqd));
  const paid = Math.max(0, Math.trunc(f.paid_iqd));
  const base = Math.min(paid, now);
  const months = Math.max(0, Math.trunc(f.warranty_left_months));
  const v = valuateComponent(
    conditionRules(rules, p),
    { base_iqd: base, usage_months: Math.max(0, Math.trunc(f.usage_months)), warranty_remaining_months: months, product_id: f.product_id },
    f.inputs ?? blankInputs(f.family)
  );
  const raw = v.lines.filter((l) => l.factor !== 'clamp' && l.factor !== 'rounding').reduce((n, l) => n + l.amount_iqd, 0);
  const q_bp = base > 0 ? Math.max(0, Math.min(10_000, raw <= 0 ? 0 : Number((big(raw) * 10_000n) / big(base)))) : 0;
  const cond = Math.max(0, v.value_iqd);
  const E = mulDiv(now, p.resale_bp, q_bp, 100_000_000);
  const K = p.handling_iqd + mulDiv(now, p.warranty_reserve_bp, months, 10_000);
  const M = Math.max(mulDiv(E, p.margin_bp, 1, 10_000), p.margin_min_iqd);
  const cap = E - K - M;
  const maxo = mulDiv(now, p.max_offer_bp, 1, 10_000);
  const offer = Math.max(0, Math.min(cond, cap, maxo));
  return {
    role: f.role,
    family: f.family,
    now_iqd: now,
    paid_iqd: paid,
    base_iqd: base,
    q_bp,
    cond_iqd: cond,
    resale_iqd: E,
    costs_iqd: K,
    margin_iqd: M,
    store_cap_iqd: cap,
    max_offer_iqd: maxo,
    offer_iqd: offer,
  };
}

// ============================================================ the request

export interface RequestOffer {
  /** The one figure the customer reads, or null: «no offer» (below the minimum). */
  offer_iqd: number | null;
  /** Σ component offers (after the whole-Combo cap), before rounding. */
  raw_iqd: number;
  /** Σ (E − K) − offer: what the store expects to keep (owner only). */
  expected_margin_iqd: number;
  /** Σ store caps (owner only). */
  store_cap_iqd: number;
}

export function requestOffer(
  parts: readonly ComponentOffer[],
  o: { wholeComboNowIqd: number | null; fdmParams: Pick<OfferParams, 'max_offer_bp'>; rounding: number; minOffer: number }
): RequestOffer {
  let raw = parts.reduce((n, c) => n + c.offer_iqd, 0);
  if (o.wholeComboNowIqd !== null && o.wholeComboNowIqd > 0) raw = Math.min(raw, mulDiv(o.wholeComboNowIqd, o.fdmParams.max_offer_bp, 1, 10_000));
  const rounded = floorTo(raw, o.rounding);
  const offer = rounded > 0 && rounded >= Math.max(0, o.minOffer) ? rounded : null;
  const kept = parts.reduce((n, c) => n + (c.resale_iqd - c.costs_iqd), 0) - (offer ?? 0);
  return { offer_iqd: offer, raw_iqd: raw, expected_margin_iqd: kept, store_cap_iqd: parts.reduce((n, c) => n + c.store_cap_iqd, 0) };
}

/**
 * WHAT WAS PAID FOR EACH PART: floor(paid × now_c / Σ now), the LAST part the
 * rest — so the parts always sum to exactly what was paid. AMS first, printer last.
 */
export function splitPaid(paidNet: number, nows: readonly number[]): number[] {
  const paid = Math.max(0, Math.trunc(paidNet));
  const total = nows.reduce((n, x) => n + Math.max(0, Math.trunc(x)), 0);
  if (nows.length === 0) return [];
  if (total <= 0) return nows.map((_, i) => (i === nows.length - 1 ? paid : 0));
  const out: number[] = [];
  let used = 0;
  nows.forEach((x, i) => {
    if (i === nows.length - 1) out.push(paid - used);
    else {
      const share = mulDiv(paid, Math.max(0, Math.trunc(x)), 1, total);
      out.push(share);
      used += share;
    }
  });
  return out;
}

/**
 * THE CREDIT (decision 2): the final value less the collection fee when the
 * customer asked us to collect, never below 0, never above the new device's
 * price; the excess is never paid out. `trade_in_value_iqd` stays the value.
 */
export function settlement(target: number, finalValue: number, pickupFee: number): TradeInSettlement & { pickup_fee_iqd: number } {
  const t = Math.max(0, Math.trunc(target));
  const value = Math.max(0, Math.trunc(finalValue));
  const fee = Math.max(0, Math.trunc(pickupFee));
  const net = Math.max(0, value - fee);
  const credit = Math.min(net, t);
  return { target_price_iqd: t, trade_in_value_iqd: value, credit_iqd: credit, difference_iqd: t - credit, excess_iqd: net - credit, pickup_fee_iqd: fee };
}
