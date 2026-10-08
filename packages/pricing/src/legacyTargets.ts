/**
 * THE OWNER'S ANSWER B, APPLIED: the minimum profit and the direct-sale premium
 * each existing model carried in the old prices (master plan v2 §2.5, C38, C39;
 * owner answer of 2026-10-07; MVP plan §6 P1).
 *
 *     T_r  = (item_r + fee_r) − C_r      per offered pre-order route r
 *     P    = P_dir − paid_base           P_dir = direct item + direct fee
 *
 * - `C_r` is the resolver's landed cost for the route (the old cost already
 *   carried shipping, so shipping is NEVER added to it again); `fee_r` is the
 *   resolver's `transport.commission_iqd`, whatever its source (the route row,
 *   the product's commission, the settings default) — answer B: the fee was
 *   part of what the customer paid.
 * - Routes whose `T_r` differ are a CONFLICT with one candidate per route —
 *   never averaged.
 * - A direct-only product (no pre-order anywhere) has premium 0 and target
 *   `P_dir − C_dir` (C39). A pre-order-only model has no premium.
 * - Nothing is clamped or guessed (§2.1 rule 6): no cost → UNRESOLVED; a paid
 *   price at or below the cost, a zero cost, a zero price, a price set more
 *   specifically than its cost, a negative or off-step premium → REVIEW, with
 *   the floor and the ceiling as candidates for an off-step premium.
 *
 * PLACEMENT. A value goes at product scope when every model that has one agrees
 * — otherwise each model gets its own option-scope value. A model whose value
 * is held for review, unresolved or in conflict gets a BLOCKED option-scope
 * marker, so it never silently inherits a value it has no evidence for.
 *
 * ROUND TRIP (check (1)6). With the replacement cost set to the old cost, the
 * placed values must give back the old prices through E1's own maths —
 * `ceilStep(C_r + T_eff) ∈ [paid_r, paid_r + 999]` on every route and
 * `ceilStep(C_base + T_eff) + P_eff ∈ [P_dir, P_dir + 999]` — with `T_eff` and
 * `P_eff` read back through `resolveRuleAt`. A model that fails goes to review
 * (PLACEMENT_INVARIANT_FAILED) and is blocked; the others are unaffected.
 *
 * Every amount is a whole IQD and every check is exact: the rounding is E1's
 * `ceilStep` (BigInt rationals), and an amount that is not a safe integer is
 * refused as a price, never rounded. Pure and deterministic: the same input in
 * any model order gives the same values per model.
 *
 * Reason codes are labelled in all three languages by
 * `packages/contracts/src/pricingMigrationLabels.ts` (`LEGACY_REASONS`);
 * tests/pricingMigrationLabels.test.ts holds the two lists equal.
 *
 * CONFIDENTIAL like costToPrice: `src/` never imports this file.
 */
import { ROUNDING_STEP_IQD, ceilStep, isOnStep } from './costToPrice';
import { resolveRuleAt, type PricingRuleRow, type PricingRuleKind } from './ruleResolution';
import { PREORDER_ROUTES, type PreorderRoute } from './skuChannel';

export const LEGACY_TARGETS_ALGORITHM = 'legacy-targets/answer-B/1' as const;

/** The resolver rung that set a price or a cost (`pricing.ts` RUNGS, plus the product base). */
export type LegacyRung = 'base' | 'option' | 'fulfillment' | 'transport' | 'color';
const RUNG_SET: ReadonlySet<string> = new Set<LegacyRung>(['base', 'option', 'fulfillment', 'transport', 'color']);

/** What one resolver call on one channel answered (free tier, prepaid, no warranty, no offer). */
export interface LegacyChannelObservation {
  /** `regular_iqd`: the item price on this channel. */
  item_iqd: number;
  /** The fee on top: the route commission (pre-order) or the product's direct scalar (direct). */
  fee_iqd: number;
  /** `cost_iqd`, the landed cost; null = no cost anywhere on the ladder. */
  cost_iqd: number | null;
  /** The rung that set the price (`price_source`). */
  price_rung: LegacyRung;
  /** The rung that set the cost; null when there is no cost. */
  cost_rung: LegacyRung | null;
}

export interface LegacyRouteObservation extends LegacyChannelObservation {
  route: PreorderRoute;
}

/** One model (an option value of the product's option group), as the store sells it today. */
export interface LegacyModelInput {
  /** The option value id; '' for a product with no models (the product itself). */
  option_id: string;
  /** The direct-sale call, when direct sale is offered AND the resolver priced it. */
  direct: LegacyChannelObservation | null;
  /** One entry per offered route the resolver priced. */
  routes: readonly LegacyRouteObservation[];
  /** `product_variants.cost_iqd` of this model's SKUs that state one. */
  variant_costs?: readonly number[];
}

export interface LegacyProductInput {
  product_id: string;
  /** Authored order. */
  models: readonly LegacyModelInput[];
  /** The owner's base route per model (`'*'` for every model); none in P1. */
  base_route?: Readonly<Record<string, PreorderRoute>>;
}

export type LegacySaleMix = 'BOTH' | 'DIRECT_ONLY' | 'PREORDER_ONLY' | 'NOT_SELLABLE';
export type LegacyTargetState = 'MIGRATED' | 'TARGET_PROFIT_UNRESOLVED' | 'TARGET_PROFIT_REVIEW_REQUIRED' | 'CONFLICT';
export type LegacyPremiumState = 'MIGRATED' | 'DIRECT_PREMIUM_REVIEW_REQUIRED' | 'NOT_APPLICABLE' | 'CONFLICT';

/** Every reason this module raises (labels: contracts `LEGACY_REASONS`). */
export const LEGACY_TARGET_REASON_CODES = [
  'LEGACY_PRICE_ZERO',
  'MISSING_LEGACY_COST',
  'LEGACY_COST_ZERO',
  'LEGACY_SALE_NOT_ABOVE_COST',
  'COST_LESS_SPECIFIC_THAN_PRICE',
  'TARGET_ROUTE_CONFLICT',
  'VARIANT_COST_CONFLICT',
  'LEGACY_DIRECT_BELOW_PREORDER',
  'LEGACY_PREMIUM_NOT_ON_STEP',
  'NO_BASE_ROUTE',
  'DIRECT_ONLY_PREMIUM_UNKNOWN',
  'PLACEMENT_INVARIANT_FAILED',
  'MODEL_NOT_SELLABLE',
  'ROUTE_FEE_INCLUDED',
  'PREMIUM_ZERO_DIRECT_ONLY',
] as const;
export type LegacyTargetReasonCode = (typeof LEGACY_TARGET_REASON_CODES)[number];

/** `ROUTE_FEE_INCLUDED` names its route and fee; `LEGACY_PREMIUM_NOT_ON_STEP` its premium. */
export interface LegacyReason {
  code: LegacyTargetReasonCode;
  route?: PreorderRoute;
  iqd?: number;
}

export interface LegacyRouteResult {
  route: PreorderRoute;
  /** item + fee: what a prepaid, non-member customer paid on this route. */
  paid_iqd: number;
  fee_iqd: number;
  cost_iqd: number | null;
  /** `T_r`, when the route has a usable cost. */
  target_iqd: number | null;
}

export interface LegacyCandidate {
  kind: 'route' | 'floor' | 'ceiling';
  route: PreorderRoute | null;
  value_iqd: number;
}

export interface LegacyModelResult {
  option_id: string;
  mix: LegacySaleMix;
  routes: LegacyRouteResult[];
  direct: { paid_iqd: number; cost_iqd: number | null } | null;
  /** The route the premium is measured from (null when none decides it). */
  base_route: PreorderRoute | null;
  target: { state: LegacyTargetState; value_iqd: number | null; reasons: LegacyReason[]; candidates: LegacyCandidate[] };
  premium: { state: LegacyPremiumState; value_iqd: number | null; reasons: LegacyReason[]; candidates: LegacyCandidate[] };
  /** null: nothing to check (no migrated value); otherwise whether the old prices come back. */
  roundtrip_ok: boolean | null;
}

export interface LegacyProductResult {
  algorithm: typeof LEGACY_TARGETS_ALGORITHM;
  product_id: string;
  models: LegacyModelResult[];
  /**
   * The placement, as E1 rule rows (`source: 'LEGACY_MIGRATION'`): what P3's
   * adopt would write. ACTIVE rows carry the amount; BLOCKED rows carry none.
   */
  rules: PricingRuleRow[];
}

// ------------------------------------------------------------------ helpers

const STATE_RANK_TARGET: Record<LegacyTargetState, number> = {
  CONFLICT: 0,
  TARGET_PROFIT_REVIEW_REQUIRED: 1,
  TARGET_PROFIT_UNRESOLVED: 2,
  MIGRATED: 3,
};

const isWhole = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n);

/** The goods a rung prices: the product, one model, or one colour. Order types and
 * routes are channels of the same model, so they rank with the model. With one
 * model only, the model IS the product. */
function goodsLevel(rung: LegacyRung, singleModel: boolean): number {
  if (rung === 'base') return 0;
  if (rung === 'color') return 2;
  return singleModel ? 0 : 1;
}

function sortReasons(reasons: LegacyReason[]): LegacyReason[] {
  const seen = new Set<string>();
  const out: LegacyReason[] = [];
  for (const r of reasons) {
    const key = `${r.code}|${r.route ?? ''}|${r.iqd ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  const order = (c: LegacyTargetReasonCode) => LEGACY_TARGET_REASON_CODES.indexOf(c);
  const routeOrder = (r?: PreorderRoute) => (r ? PREORDER_ROUTES.indexOf(r) : -1);
  return out.sort((a, b) => order(a.code) - order(b.code) || routeOrder(a.route) - routeOrder(b.route) || (a.iqd ?? 0) - (b.iqd ?? 0));
}

/** Guards on one (paid, cost) pair. Returns the reasons that hold the value; [] when it stands. */
function pairGuards(paid: number, obs: LegacyChannelObservation, singleModel: boolean): { reasons: LegacyReason[]; unresolved: boolean } {
  const reasons: LegacyReason[] = [];
  let unresolved = false;
  if (!isWhole(paid) || paid <= 0) reasons.push({ code: 'LEGACY_PRICE_ZERO' });
  if (obs.cost_iqd === null || obs.cost_iqd === undefined) {
    reasons.push({ code: 'MISSING_LEGACY_COST' });
    unresolved = true;
  } else if (!isWhole(obs.cost_iqd) || obs.cost_iqd < 0) {
    reasons.push({ code: 'MISSING_LEGACY_COST' });
    unresolved = true;
  } else {
    if (obs.cost_iqd === 0) reasons.push({ code: 'LEGACY_COST_ZERO' });
    else if (isWhole(paid) && paid <= obs.cost_iqd) reasons.push({ code: 'LEGACY_SALE_NOT_ABOVE_COST' });
    if (obs.cost_rung && goodsLevel(obs.price_rung, singleModel) > goodsLevel(obs.cost_rung, singleModel)) {
      reasons.push({ code: 'COST_LESS_SPECIFIC_THAN_PRICE' });
    }
  }
  return { reasons, unresolved };
}

function validateObservation(obs: LegacyChannelObservation, what: string): void {
  // A programming error, never a data problem: the worker builds these from the resolver.
  if (!isWhole(obs.item_iqd) || !isWhole(obs.fee_iqd) || obs.fee_iqd < 0 || !RUNG_SET.has(obs.price_rung)) {
    throw new Error(`PRICING_INVARIANT: ${what} is not a resolver observation`);
  }
  if (obs.cost_rung !== null && !RUNG_SET.has(obs.cost_rung)) throw new Error(`PRICING_INVARIANT: ${what} cost rung`);
}

const paidOf = (obs: LegacyChannelObservation): number => obs.item_iqd + obs.fee_iqd;

// --------------------------------------------------------------- one model

interface Working extends LegacyModelResult {
  /** The cost the direct price is rebuilt from in the round trip (C_base, or C_dir). */
  direct_cost_for_roundtrip: number | null;
}

function deriveModel(model: LegacyModelInput, singleModel: boolean, baseChoice: PreorderRoute | undefined): Working {
  if (model.direct) validateObservation(model.direct, `${model.option_id} direct`);
  const seenRoutes = new Set<PreorderRoute>();
  for (const r of model.routes) {
    if (!PREORDER_ROUTES.includes(r.route) || seenRoutes.has(r.route)) throw new Error(`PRICING_INVARIANT: ${model.option_id} route ${r.route}`);
    seenRoutes.add(r.route);
    validateObservation(r, `${model.option_id} ${r.route}`);
  }
  const routes = [...model.routes].sort((a, b) => PREORDER_ROUTES.indexOf(a.route) - PREORDER_ROUTES.indexOf(b.route));
  const mix: LegacySaleMix = model.direct && routes.length ? 'BOTH' : model.direct ? 'DIRECT_ONLY' : routes.length ? 'PREORDER_ONLY' : 'NOT_SELLABLE';

  const routeResults: LegacyRouteResult[] = routes.map((r) => {
    const paid = paidOf(r);
    const cost = r.cost_iqd;
    const usable = isWhole(cost) && cost > 0 && isWhole(paid) && paid > cost;
    return { route: r.route, paid_iqd: paid, fee_iqd: r.fee_iqd, cost_iqd: cost, target_iqd: usable ? paid - (cost as number) : null };
  });
  const direct = model.direct ? { paid_iqd: paidOf(model.direct), cost_iqd: model.direct.cost_iqd } : null;

  const result: Working = {
    option_id: model.option_id,
    mix,
    routes: routeResults,
    direct,
    base_route: null,
    target: { state: 'TARGET_PROFIT_UNRESOLVED', value_iqd: null, reasons: [], candidates: [] },
    premium: { state: 'NOT_APPLICABLE', value_iqd: null, reasons: [], candidates: [] },
    roundtrip_ok: null,
    direct_cost_for_roundtrip: null,
  };

  if (mix === 'NOT_SELLABLE') {
    result.target.reasons = [{ code: 'MODEL_NOT_SELLABLE' }];
    return result;
  }

  // ---- the target from the pre-order routes (BOTH, PREORDER_ONLY)
  if (routes.length) {
    const reasons: LegacyReason[] = [];
    let unresolved = false;
    for (const r of routes) {
      const g = pairGuards(paidOf(r), r, singleModel);
      reasons.push(...g.reasons);
      unresolved ||= g.unresolved;
      if (r.fee_iqd > 0) reasons.push({ code: 'ROUTE_FEE_INCLUDED', route: r.route, iqd: r.fee_iqd });
    }
    const variantConflict = (model.variant_costs ?? []).some((v) => routes.some((r) => r.cost_iqd !== v));
    if (variantConflict) reasons.push({ code: 'VARIANT_COST_CONFLICT' });
    const candidates = routeResults
      .filter((r) => r.target_iqd !== null)
      .map((r): LegacyCandidate => ({ kind: 'route', route: r.route, value_iqd: r.target_iqd as number }));
    const values = new Set(candidates.map((c) => c.value_iqd));
    const holding = reasons.filter((r) => r.code !== 'ROUTE_FEE_INCLUDED');
    if (variantConflict) {
      result.target.state = 'CONFLICT';
    } else if (holding.length) {
      result.target.state = unresolved && holding.every((r) => r.code === 'MISSING_LEGACY_COST') ? 'TARGET_PROFIT_UNRESOLVED' : 'TARGET_PROFIT_REVIEW_REQUIRED';
    } else if (values.size > 1) {
      result.target.state = 'CONFLICT';
      reasons.push({ code: 'TARGET_ROUTE_CONFLICT' });
    } else {
      result.target.state = 'MIGRATED';
      result.target.value_iqd = candidates[0]!.value_iqd;
    }
    result.target.reasons = sortReasons(reasons);
    // Candidates are shown when routes disagree or a value is held; one agreed value needs none.
    result.target.candidates = result.target.state === 'MIGRATED' ? [] : candidates;
  }

  // ---- the premium (BOTH)
  if (mix === 'BOTH') {
    const d = model.direct!;
    const pDir = paidOf(d);
    const reasons: LegacyReason[] = [];
    // The base route: the owner's choice, the only route, or any route when every route charged the same.
    const chosen = baseChoice && routes.some((r) => r.route === baseChoice) ? baseChoice : undefined;
    const paids = new Set(routeResults.map((r) => r.paid_iqd));
    const base = chosen ?? (routes.length === 1 || paids.size === 1 ? routes[0]!.route : null);
    result.base_route = base;
    const premiumCandidates = routeResults.map((r): LegacyCandidate => ({ kind: 'route', route: r.route, value_iqd: pDir - r.paid_iqd }));
    if (!isWhole(pDir) || pDir <= 0) {
      reasons.push({ code: 'LEGACY_PRICE_ZERO' });
      result.premium = { state: 'DIRECT_PREMIUM_REVIEW_REQUIRED', value_iqd: null, reasons, candidates: [] };
    } else if (result.target.state === 'CONFLICT') {
      result.premium = { state: 'CONFLICT', value_iqd: null, reasons: [], candidates: premiumCandidates };
    } else if (base === null) {
      reasons.push({ code: 'NO_BASE_ROUTE' });
      result.premium = { state: 'DIRECT_PREMIUM_REVIEW_REQUIRED', value_iqd: null, reasons, candidates: premiumCandidates };
    } else {
      const baseRow = routeResults.find((r) => r.route === base)!;
      const p = pDir - baseRow.paid_iqd;
      result.direct_cost_for_roundtrip = baseRow.cost_iqd;
      if (p < 0) {
        reasons.push({ code: 'LEGACY_DIRECT_BELOW_PREORDER' });
        result.premium = { state: 'DIRECT_PREMIUM_REVIEW_REQUIRED', value_iqd: null, reasons, candidates: [] };
      } else if (!isOnStep(p, ROUNDING_STEP_IQD)) {
        reasons.push({ code: 'LEGACY_PREMIUM_NOT_ON_STEP', iqd: p });
        const floor = p - (p % ROUNDING_STEP_IQD);
        result.premium = {
          state: 'DIRECT_PREMIUM_REVIEW_REQUIRED',
          value_iqd: null,
          reasons,
          candidates: [
            { kind: 'floor', route: null, value_iqd: floor },
            { kind: 'ceiling', route: null, value_iqd: floor + ROUNDING_STEP_IQD },
          ],
        };
      } else {
        result.premium = { state: 'MIGRATED', value_iqd: p, reasons: [], candidates: [] };
      }
    }
    result.premium.reasons = sortReasons(result.premium.reasons);
  }
  return result;
}

/** Direct-only models: target = P_dir − C_dir − P_eff (C39 for a direct-only product, where P_eff = 0). */
function deriveDirectOnlyTarget(w: Working, model: LegacyModelInput, singleModel: boolean, premiumEff: number | null, directOnlyProduct: boolean): void {
  const d = model.direct!;
  const pDir = paidOf(d);
  const reasons: LegacyReason[] = [];
  if (directOnlyProduct) {
    w.premium = { state: 'MIGRATED', value_iqd: 0, reasons: [{ code: 'PREMIUM_ZERO_DIRECT_ONLY' }], candidates: [] };
  } else if (premiumEff === null) {
    w.target = { state: 'TARGET_PROFIT_REVIEW_REQUIRED', value_iqd: null, reasons: [{ code: 'DIRECT_ONLY_PREMIUM_UNKNOWN' }], candidates: [] };
    w.premium = { state: 'DIRECT_PREMIUM_REVIEW_REQUIRED', value_iqd: null, reasons: [{ code: 'DIRECT_ONLY_PREMIUM_UNKNOWN' }], candidates: [] };
    return;
  } else {
    w.premium = { state: 'MIGRATED', value_iqd: premiumEff, reasons: [], candidates: [] };
  }
  // A direct fee (the product's scalar premium) is part of P_dir, so under C39
  // it is part of the old profit and stays in the target.
  const p = directOnlyProduct ? 0 : (premiumEff as number);
  const g = pairGuards(pDir - p, d, singleModel);
  reasons.push(...g.reasons);
  const variantConflict = (model.variant_costs ?? []).some((v) => v !== d.cost_iqd);
  w.direct_cost_for_roundtrip = d.cost_iqd;
  if (variantConflict) {
    w.target = { state: 'CONFLICT', value_iqd: null, reasons: sortReasons([...reasons, { code: 'VARIANT_COST_CONFLICT' }]), candidates: [] };
  } else if (reasons.length) {
    const unresolved = g.unresolved && reasons.every((r) => r.code === 'MISSING_LEGACY_COST');
    w.target = { state: unresolved ? 'TARGET_PROFIT_UNRESOLVED' : 'TARGET_PROFIT_REVIEW_REQUIRED', value_iqd: null, reasons: sortReasons(reasons), candidates: [] };
  } else {
    w.target = { state: 'MIGRATED', value_iqd: pDir - p - (d.cost_iqd as number), reasons: [], candidates: [] };
  }
}

// ---------------------------------------------------------------- placement

function place(
  productId: string,
  kind: PricingRuleKind,
  models: readonly { option_id: string; value: number | null; blocked: boolean }[]
): PricingRuleRow[] {
  const rows: PricingRuleRow[] = [];
  const productScope = (option: string) => (option === '' ? 'product' : 'option');
  const row = (scopeId: string, value: number | null, blocked: boolean): PricingRuleRow => ({
    id: `legacy:${kind}:${scopeId === '' ? 'product' : `o:${scopeId}`}`,
    kind,
    scope: productScope(scopeId),
    catalog_id: null,
    product_id: productId,
    scope_id: scopeId,
    state: blocked ? 'BLOCKED' : 'ACTIVE',
    amount_iqd: blocked ? null : value,
    version: 0,
    source: 'LEGACY_MIGRATION',
  });
  const known = models.filter((m) => !m.blocked && m.value !== null);
  const blocked = models.filter((m) => m.blocked);
  const values = new Set(known.map((m) => m.value));
  if (known.length && values.size === 1) {
    rows.push(row('', known[0]!.value, false));
    for (const m of blocked) rows.push(row(m.option_id, null, true));
  } else {
    for (const m of known) rows.push(row(m.option_id, m.value, false));
    for (const m of blocked) rows.push(row(m.option_id, null, true));
  }
  return rows;
}

// --------------------------------------------------------------------- run

/**
 * Derive the minimum profit and the direct-sale premium of every model of one
 * product from what the store charges today (see the file header).
 */
export function deriveLegacyTargets(input: LegacyProductInput): LegacyProductResult {
  const ids = input.models.map((m) => m.option_id);
  if (new Set(ids).size !== ids.length) throw new Error('PRICING_INVARIANT: a model is listed twice');
  if (ids.includes('') && ids.length > 1) throw new Error('PRICING_INVARIANT: a product with models has no model ""');
  const singleModel = input.models.length <= 1;
  const choice = (id: string) => input.base_route?.[id] ?? input.base_route?.['*'];

  const work = input.models.map((m) => deriveModel(m, singleModel, choice(m.option_id)));
  const directOnlyProduct = work.every((w) => w.mix === 'DIRECT_ONLY' || w.mix === 'NOT_SELLABLE') && work.some((w) => w.mix === 'DIRECT_ONLY');

  const blockedFlags = new Set<string>();
  let rules: PricingRuleRow[] = [];
  // At most one pass per model: each failing round trip blocks one more model.
  for (let pass = 0; pass <= work.length; pass += 1) {
    // Premium plan from the BOTH models first (LEG pass 2 reads it for mixed products).
    const premiumModels = work
      .filter((w) => w.mix === 'BOTH')
      .map((w) => ({
        option_id: w.option_id,
        value: w.premium.state === 'MIGRATED' ? w.premium.value_iqd : null,
        blocked: w.premium.state !== 'MIGRATED' || blockedFlags.has(w.option_id),
      }));
    const known = premiumModels.filter((m) => !m.blocked);
    const productPremium = premiumModels.length && !premiumModels.some((m) => m.blocked) && new Set(known.map((m) => m.value)).size === 1 ? known[0]!.value : null;

    for (const [i, w] of work.entries()) {
      if (w.mix === 'DIRECT_ONLY' && !blockedFlags.has(w.option_id)) {
        deriveDirectOnlyTarget(w, input.models[i]!, singleModel, productPremium, directOnlyProduct);
      }
    }

    const directOnly = work.filter((w) => w.mix === 'DIRECT_ONLY');
    const premiumRows = directOnlyProduct
      ? place(input.product_id, 'direct_premium', directOnly.length ? [{ option_id: '', value: 0, blocked: false }] : [])
      : place(input.product_id, 'direct_premium', [
          ...premiumModels,
          // A mixed product's direct-only model inherits the product premium, or is held.
          ...directOnly.filter((w) => w.premium.state !== 'MIGRATED' || blockedFlags.has(w.option_id)).map((w) => ({ option_id: w.option_id, value: null, blocked: true })),
        ]);
    const targetRows = place(
      input.product_id,
      'target_profit',
      work
        .filter((w) => w.mix !== 'NOT_SELLABLE')
        .map((w) => ({
          option_id: w.option_id,
          value: w.target.state === 'MIGRATED' ? w.target.value_iqd : null,
          blocked: w.target.state !== 'MIGRATED' || blockedFlags.has(w.option_id),
        }))
    );
    rules = [...targetRows, ...premiumRows];

    // The round trip, through E1's own rule resolution and rounding.
    let failed: Working | null = null;
    for (const w of work) {
      w.roundtrip_ok = roundTrip(input.product_id, w, rules);
      if (w.roundtrip_ok === false && !blockedFlags.has(w.option_id)) {
        failed = w;
        break;
      }
    }
    if (!failed) break;
    blockedFlags.add(failed.option_id);
    failed.target = {
      state: 'TARGET_PROFIT_REVIEW_REQUIRED',
      value_iqd: null,
      reasons: sortReasons([...failed.target.reasons, { code: 'PLACEMENT_INVARIANT_FAILED' }]),
      candidates: failed.target.value_iqd !== null ? [] : failed.target.candidates,
    };
    if (failed.premium.state === 'MIGRATED' && failed.mix === 'BOTH') {
      failed.premium = { state: 'DIRECT_PREMIUM_REVIEW_REQUIRED', value_iqd: null, reasons: [{ code: 'PLACEMENT_INVARIANT_FAILED' }], candidates: [] };
    }
  }

  return {
    algorithm: LEGACY_TARGETS_ALGORITHM,
    product_id: input.product_id,
    models: work.map((w) => {
      const { direct_cost_for_roundtrip, ...out } = w;
      void direct_cost_for_roundtrip;
      return out;
    }),
    rules,
  };
}

/** The old prices back from the placed values, with R := the old cost (see the header). */
function roundTrip(productId: string, w: Working, rules: readonly PricingRuleRow[]): boolean | null {
  if (w.target.state !== 'MIGRATED') return null;
  const at = { product_id: productId, option_value_ids: w.option_id ? [w.option_id] : [], color_id: null, ancestry: [] };
  const t = resolveRuleAt(rules, 'target_profit', at);
  if (t.status !== 'active' || t.amount_iqd !== w.target.value_iqd) return false;
  const within = (price: number, paid: number) => price >= paid && price <= paid + ROUNDING_STEP_IQD - 1;
  for (const r of w.routes) {
    if (r.cost_iqd === null) return false;
    if (!within(ceilStep(r.cost_iqd + t.amount_iqd), r.paid_iqd)) return false;
  }
  if (w.direct && w.premium.state === 'MIGRATED') {
    const p = resolveRuleAt(rules, 'direct_premium', at);
    if (p.status !== 'active' || p.amount_iqd !== w.premium.value_iqd) return false;
    if (w.direct_cost_for_roundtrip === null) return false;
    if (!within(ceilStep(w.direct_cost_for_roundtrip + t.amount_iqd) + p.amount_iqd, w.direct.paid_iqd)) return false;
  }
  return true;
}

/** The worst target state of a product's models (CONFLICT first). */
export function worstTargetState(states: Iterable<LegacyTargetState>): LegacyTargetState {
  let worst: LegacyTargetState = 'MIGRATED';
  for (const s of states) if (STATE_RANK_TARGET[s] < STATE_RANK_TARGET[worst]) worst = s;
  return worst;
}
