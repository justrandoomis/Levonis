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
 *
 * ─── SMART VALUE (owner, 2026-11-18; DECISIONS row 353) ──────────────────────
 *
 *   resale_bp   per MODEL: the owner's figure for the model, else the family's
 *               blended with what traded-in units of the model really resold for
 *               (`learnedResaleBp`: k phantom sales at the family's share, so a
 *               few sales move it a little); a newer generation on sale lowers it
 *               by `superseded_bp`.
 *   age         the age line is reduced by the share today's new price already
 *               fell below what was paid — the fall IS the age, not twice.
 *   hours       only the hours beyond `hours_allowance_per_month × months` count.
 * The margin (15%, at least 50,000 for a printer) and every cap are unchanged.
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

/**
 * THE FAMILY'S SMART-VALUE KNOBS (owner-only; 0238 `trade_in_smart_params`, NULL = this default).
 *   hours_allowance_per_month  hours a normal owner prints a month (only the hours beyond count)
 *   last_price_decay_bp        a model off sale today: what was paid, less this per month since delivery …
 *   last_price_max_decay_bp    … at most this much
 *   superseded_bp              a newer generation of the model is on sale: the resale share less this
 *   learn_weight               phantom sales at the family's share (how gently real resales move a model)
 */
export interface SmartParams {
  hours_allowance_per_month: number;
  last_price_decay_bp: number;
  last_price_max_decay_bp: number;
  superseded_bp: number;
  learn_weight: number;
}
export const SMART_PARAM_COLUMNS = ['hours_allowance_per_month', 'last_price_decay_bp', 'last_price_max_decay_bp', 'superseded_bp', 'learn_weight'] as const;
export type SmartParamColumn = (typeof SMART_PARAM_COLUMNS)[number];
export const SMART_PARAM_RANGES: Readonly<Record<SmartParamColumn, readonly [number, number]>> = {
  hours_allowance_per_month: [0, 720],
  last_price_decay_bp: [0, 1_000],
  last_price_max_decay_bp: [0, 9_000],
  superseded_bp: [0, 5_000],
  learn_weight: [1, 50],
};
const S = (hours_allowance_per_month: number, last_price_decay_bp: number): SmartParams => ({
  hours_allowance_per_month,
  last_price_decay_bp,
  last_price_max_decay_bp: 6_000,
  superseded_bp: 1_000,
  learn_weight: 3,
});
export const DEFAULT_SMART_PARAMS: Readonly<Record<TradeInFamily, SmartParams>> = {
  fdm: S(40, 200),
  resin: S(30, 250),
  laser: S(20, 200),
  ams: S(0, 200),
  accessory: S(0, 300),
};

export function smartParamsOf(family: TradeInFamily, stored?: Partial<Record<SmartParamColumn, number | null>> | null): SmartParams {
  const out = { ...DEFAULT_SMART_PARAMS[family] };
  for (const k of SMART_PARAM_COLUMNS) {
    const v = stored?.[k];
    const [lo, hi] = SMART_PARAM_RANGES[k];
    if (isInt(v) && v >= lo && v <= hi) out[k] = v;
  }
  return out;
}

export function validateSmartParams(raw: unknown): { ok: true; value: Partial<Record<SmartParamColumn, number | null>> } | { ok: false; errors: string[] } {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const errors: string[] = [];
  const value: Partial<Record<SmartParamColumn, number | null>> = {};
  for (const k of SMART_PARAM_COLUMNS) {
    if (!(k in o)) continue;
    const v = o[k];
    if (v === null) {
      value[k] = null;
      continue;
    }
    const [lo, hi] = SMART_PARAM_RANGES[k];
    if (!isInt(v) || v < lo || v > hi) errors.push(`smart.${k}`);
    else value[k] = v;
  }
  return errors.length ? { ok: false, errors } : { ok: true, value };
}

/** A model's own resale share, as the owner may set it (0238 CHECK). */
export const MODEL_RESALE_RANGE = [1_000, 9_500] as const;
/** One real resale is read as at most / at least this share of new (an outlier moves nothing past it). */
export const LEARN_SAMPLE_RANGE = [3_000, 9_500] as const;
/** Only a model's newest resales teach; from this many on, the highest and the lowest are dropped. */
export const LEARN_MAX_SAMPLES = 20;
export const LEARN_TRIM_FROM = 5;

/** The samples that teach, newest first in: at most LEARN_MAX_SAMPLES, the extremes trimmed from LEARN_TRIM_FROM on. */
export function teachingSamples(newestFirst: readonly number[]): number[] {
  const kept = newestFirst.filter((x) => Number.isSafeInteger(x) && x > 0).slice(0, LEARN_MAX_SAMPLES);
  if (kept.length < LEARN_TRIM_FROM) return kept;
  const sorted = [...kept].sort((a, b) => a - b);
  return sorted.slice(1, -1);
}

/**
 * WHAT ONE TRADED-IN UNIT REALLY RESOLD FOR, as a resale share at a perfect condition:
 * sold ÷ (today's new price at intake × the condition share). null when it cannot be read.
 */
export function resaleSampleBp(soldIqd: number, nowAtIntakeIqd: number, qBp: number): number | null {
  const sold = Math.trunc(soldIqd);
  const now = Math.trunc(nowAtIntakeIqd);
  const q = Math.trunc(qBp);
  if (!(sold > 0) || !(now > 0) || !(q > 0)) return null;
  const bp = Number((big(sold) * 100_000_000n) / (big(now) * big(q)));
  return Math.min(LEARN_SAMPLE_RANGE[1], Math.max(LEARN_SAMPLE_RANGE[0], bp));
}

/**
 * THE MODEL'S LEARNED SHARE — gently: `weight` phantom sales at the family's share plus the real
 * ones, averaged (rounded DOWN). No sale → the family's share exactly.
 */
export function learnedResaleBp(familyBp: number, samples: readonly number[], weight: number): number {
  const k = Math.max(1, Math.trunc(weight));
  const fam = Math.max(0, Math.trunc(familyBp));
  const ok = samples.filter((x) => Number.isSafeInteger(x) && x > 0);
  if (ok.length === 0) return fam;
  return Math.floor((fam * k + ok.reduce((n, x) => n + x, 0)) / (k + ok.length));
}

export type ResaleSource = 'family' | 'learned' | 'owner';

/** The resale share in force for a model, and where it came from. */
export function modelResaleBp(
  familyBp: number,
  o: { ownerBp: number | null; samples: readonly number[]; weight: number; superseded: boolean; supersededBp: number }
): { resale_bp: number; source: ResaleSource; learned_bp: number; samples: number } {
  const valid = o.samples.filter((x) => Number.isSafeInteger(x) && x > 0);
  const learned = learnedResaleBp(familyBp, valid, o.weight);
  const owner = isInt(o.ownerBp) && o.ownerBp >= MODEL_RESALE_RANGE[0] && o.ownerBp <= MODEL_RESALE_RANGE[1] ? o.ownerBp : null;
  const source: ResaleSource = owner !== null ? 'owner' : valid.length > 0 ? 'learned' : 'family';
  const base = owner ?? learned;
  // A newer model on sale lowers the owner's or the type's share. A LEARNED share already carries it
  // (the old model's real resales sell lower once the new one is out) — not taken twice.
  const less = o.superseded && source !== 'learned' ? Math.max(0, Math.min(5_000, Math.trunc(o.supersededBp))) : 0;
  return {
    resale_bp: Math.max(0, base - Math.floor((base * less) / 10_000)),
    source,
    learned_bp: learned,
    samples: valid.length,
  };
}

/** A model with no price today: what was paid, less `decay_bp` per month since delivery, at most `max_bp`. */
export function lastPaidNowIqd(paidIqd: number, months: number, p: Pick<SmartParams, 'last_price_decay_bp' | 'last_price_max_decay_bp'>): number {
  const paid = Math.max(0, Math.trunc(paidIqd));
  const off = Math.min(Math.max(0, p.last_price_max_decay_bp), Math.max(0, Math.trunc(months)) * Math.max(0, p.last_price_decay_bp));
  return paid - mulDiv(paid, Math.min(10_000, off), 1, 10_000);
}

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
  /** Smart value: the model's resale share in force (`modelResaleBp`); absent → the family's `resale_bp`. */
  resale_bp?: number;
  /** Smart value: the family's knobs; absent → no age credit and no hours allowance (the 0192 formula). */
  smart?: Pick<SmartParams, 'hours_allowance_per_month'>;
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
  /** Smart value (owner only): the resale share used, the age already priced, the hours allowed. */
  resale_bp: number;
  age_credit_bp: number;
  hours_allowance: number;
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
  const used = Math.max(0, Math.trunc(f.usage_months));
  // The fall of today's new price below what was paid, as a share of WHAT WAS PAID (not of the base:
  // the smaller credit of the two, for the store) — the age deduction already taken by the market.
  const ageCredit = f.smart && paid > now && paid > 0 ? Number((big(paid - now) * 10_000n) / big(paid)) : 0;
  const allowance = f.smart ? used * Math.max(0, Math.trunc(f.smart.hours_allowance_per_month)) : 0;
  const v = valuateComponent(
    conditionRules(rules, p),
    {
      base_iqd: base,
      usage_months: used,
      warranty_remaining_months: months,
      product_id: f.product_id,
      ...(f.smart ? { age_credit_bp: ageCredit, hours_allowance: allowance } : {}),
    },
    f.inputs ?? blankInputs(f.family)
  );
  const raw = v.lines.filter((l) => l.factor !== 'clamp' && l.factor !== 'rounding').reduce((n, l) => n + l.amount_iqd, 0);
  const q_bp = base > 0 ? Math.max(0, Math.min(10_000, raw <= 0 ? 0 : Number((big(raw) * 10_000n) / big(base)))) : 0;
  const cond = Math.max(0, v.value_iqd);
  const resaleBp = isInt(f.resale_bp) && f.resale_bp >= 0 && f.resale_bp <= 10_000 ? f.resale_bp : p.resale_bp;
  const E = mulDiv(now, resaleBp, q_bp, 100_000_000);
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
    resale_bp: resaleBp,
    age_credit_bp: ageCredit,
    hours_allowance: allowance,
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
