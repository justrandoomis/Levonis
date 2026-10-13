/**
 * PRICING V2 — REPRODUCING TODAY'S PRICES AT MIGRATION (docs/PRICING-V2.md §3;
 * implementation spec V2-1 §1.4, used by V2-5 §6.2). Pure; nothing is written.
 *
 * THE REPRODUCE RULE. For a whole price I ≥ 1 and a rate 0 < U < 100 × step
 * (100,000 at the 1,000 step: a cent × U is then less than one step):
 *
 *     usdReproducing(I) = floor_cents(ceil_step(I) ÷ U)
 *     ⇒ ceil_step(usdReproducing(I) × U) = ceil_step(I)
 *
 * because ceil_step(I) − 0.01 × U < usdReproducing(I) × U ≤ ceil_step(I). The step
 * is taken BEFORE dividing: without it an off-step price such as 1,000,500 could
 * round DOWN to 1,000,000; the doc requires it to move UP (to 1,001,000).
 *
 * A pre-order price P_I ≤ D_I is reproduced under the direct price by the discount
 * Δ = D_usd − usdReproducing(P_I) ≥ 0, since D_usd − Δ = usdReproducing(P_I). A
 * pre-order above direct gets Δ = 0 and sells at D (flagged).
 *
 * An engine product keeps its prices by folding the Direct Sale Extra into the
 * minimum profit: T_new = T + ceil_cents(DSE ÷ U) and Δ = T_new − T. Its D is
 * today's or today's + 1,000 (the cents added are worth less than one step), and
 * its base route's pre-order price is exactly today's.
 *
 * `proposeKeepUsd` builds the fewest price-first points and discounts that
 * reproduce today's grid, then prices them with `priceProductV2` and diffs the
 * result against today (prepaid AND cash on delivery), with the owner's flags.
 * The proposal is the engine's result, never this module's own claim.
 *
 * CONFIDENTIAL, like costToPrice.ts: `src/` must not import this file.
 */
import {
  addProcurementExact,
  ceilToPlaces,
  compareProcurementExact,
  floorToPlaces,
  mulProcurementExact,
  parseProcurementDecimal,
  procurementExact,
  procurementExactText,
  quotientProcurementExact,
  type ProcurementExact,
} from '@levonis/contracts/procurementCost';
import { ROUNDING_STEP_IQD, ceilStep } from './costToPrice';
import { parseUsdRuleAmount } from './ruleResolution';
import { priceProductV2, type V2Discount, type V2PricePoint, type V2Result, type V2Sku } from './priceV2';
import { PREORDER_ROUTES, SKU_CHANNELS, parseSkuComboKey, routeOfChannel, type PreorderRoute, type SkuChannel } from './skuChannel';

const text = procurementExactText;
const cmp = compareProcurementExact;
const sub = (a: ProcurementExact, b: ProcurementExact): ProcurementExact => addProcurementExact(a, { num: -b.num, den: b.den });
const exactIqd = (n: number): ProcurementExact => procurementExact(n);

function wholeStep(step: number): number {
  if (!Number.isSafeInteger(step) || step < 1) throw new RangeError('The rounding step must be a positive whole number of IQD');
  return step;
}

function wholeIqd(iqd: unknown, what: string, min = 1): number {
  if (typeof iqd !== 'number' || !Number.isSafeInteger(iqd) || iqd < min) throw new RangeError(`${what} must be a whole number of IQD ≥ ${min}, never a binary float`);
  return iqd;
}

/** U as an exact positive rational with a cent × U below one step (U < 100,000 at the 1,000 step). */
function usdRateOf(u: unknown, step: number): ProcurementExact {
  if (typeof u === 'number' && !Number.isSafeInteger(u)) throw new RangeError('The USD/IQD rate must be decimal text, never a binary float');
  let exact: ProcurementExact;
  try {
    exact = procurementExact(parseProcurementDecimal(u, { maxIntDigits: 12, maxFractionDigits: 12, min: 'positive' }));
  } catch {
    throw new RangeError('The USD/IQD rate must be a positive decimal');
  }
  if (cmp(exact, procurementExact(100 * step)) >= 0) throw new RangeError('A cent × U must stay below one rounding step (U < 100,000 at the 1,000 step)');
  return exact;
}

/** A dollar price with at most two decimals, > 0. */
function usdPriceOf(usd: unknown): ProcurementExact {
  if (typeof usd === 'number' && !Number.isSafeInteger(usd)) throw new RangeError('A dollar price must be decimal text, never a binary float');
  try {
    return procurementExact(parseProcurementDecimal(usd, { maxIntDigits: 12, maxFractionDigits: 2, min: 'positive' }));
  } catch {
    throw new RangeError('A dollar price must be a positive decimal with at most two decimals');
  }
}

function usdReproducingExact(iqd: number, u: ProcurementExact, step: number): ProcurementExact {
  return floorToPlaces(quotientProcurementExact(exactIqd(ceilStep(iqd, step)), u), 2);
}

/**
 * The cents that reproduce a dinar price: floor_cents(ceil_step(I) ÷ U). For every
 * whole I ≥ 1 and 0 < U < 100 × step, ceil_step(result × U) === ceil_step(I). An
 * off-step I (1,004,500) reproduces the NEXT step (1,005,000), never the lower one.
 */
export function usdReproducing(iqd: number, u: string, step: number = ROUNDING_STEP_IQD): string {
  const s = wholeStep(step);
  return text(usdReproducingExact(wholeIqd(iqd, 'The price'), usdRateOf(u, s), s));
}

/**
 * The discount that reproduces a pre-order price under the direct price D:
 * max(0, D − usdReproducing(P)). It is 0 when the pre-order is at or above D,
 * which then sells at D.
 */
export function discountReproducing(directUsd: string, preorderIqd: number, u: string, step: number = ROUNDING_STEP_IQD): string {
  const s = wholeStep(step);
  const diff = sub(usdPriceOf(directUsd), usdReproducingExact(wholeIqd(preorderIqd, 'The pre-order price'), usdRateOf(u, s), s));
  return diff.num > 0n ? text(diff) : '0';
}

/**
 * Engine products (PRICING-V2.md §3 step 2): the Direct Sale Extra moves into the
 * minimum profit, T_new = T + ceil_cents(DSE ÷ U), and the same cents become the
 * pre-order discount, so the base route keeps today's pre-order price and D
 * moves by at most one step. The caller checks T_new against the rule's bounds.
 */
export function engineKeepTerms(tUsd: string, dseIqd: number, u: string): { t_new: string; discount: string } {
  const t = parseUsdRuleAmount(tUsd);
  if (!t) throw new RangeError('The minimum profit must be a stored USD amount (≤ 2 decimals, 0 < T ≤ 100,000)');
  const added = ceilToPlaces(quotientProcurementExact(exactIqd(wholeIqd(dseIqd, 'The Direct Sale Extra', 0)), usdRateOf(u, ROUNDING_STEP_IQD)), 2);
  return { t_new: text(addProcurementExact(t, added)), discount: text(added) };
}

/* ------------------------------------------------------------ keep_usd -- */

/** One SKU × channel as customers pay today, fees included (`evaluateLegacy(…, { perSku: true })`). */
export interface TodayChannel {
  channel: SkuChannel;
  prepaid_iqd: number;
  cod_iqd: number;
}
export interface TodaySku {
  /** Canonical combo key; '' = the product itself. */
  combo_key: string;
  model_id: string | null;
  color_id: string | null;
  /** The channels sold today. */
  channels: readonly TodayChannel[];
}
export type TodayGrid = readonly TodaySku[];

export interface KeepRow {
  combo_key: string;
  model_id: string | null;
  color_id: string | null;
  channel: SkuChannel;
  old_prepaid_iqd: number;
  old_cod_iqd: number;
  /** Null when the proposal cannot price this channel (see `result.issues`). */
  new_iqd: number | null;
  /** A cash-on-delivery pre-order pays the direct price (§7 default 2). */
  new_cod_iqd: number | null;
  changed: boolean;
}

export type KeepFlag =
  | {
      code: 'ROUTES_NOT_REPRODUCIBLE';
      model_id: string | null;
      kept_route: PreorderRoute;
      moved: Array<{ combo_key: string; route: PreorderRoute; old_iqd: number; new_iqd: number | null }>;
    }
  | { code: 'PREORDER_ABOVE_DIRECT'; model_id: string | null; combo_key: string; route: PreorderRoute; old_iqd: number; new_iqd: number | null }
  | { code: 'LEGACY_COLOUR_PRICE'; color_id: string; became: 'colour_delta' | 'sku_fixed' }
  | { code: 'OFF_STEP_PRICE'; rows: Array<{ combo_key: string; channel: SkuChannel; old_iqd: number; new_iqd: number | null }> }
  | { code: 'COD_CHANGES'; rows: Array<{ combo_key: string; channel: SkuChannel; old_cod_iqd: number; new_cod_iqd: number | null }> }
  | { code: 'FX_LINKED' };

export interface KeepProposal {
  method: 'usd';
  points: V2PricePoint[];
  discounts: V2Discount[];
  /** The route whose pre-order price each SKU keeps (absent on a SKU without a route). */
  kept_routes: Record<string, PreorderRoute>;
  result: V2Result;
  rows: KeepRow[];
  flags: KeepFlag[];
  /** Every prepaid and COD figure equal, the proposal complete, and no flag but FX_LINKED. */
  unchanged: boolean;
}

interface Unit {
  row: TodaySku;
  options: string[];
  direct: TodayChannel | null;
  routes: TodayChannel[];
  keep: TodayChannel | null;
  /** ceil_step of the price the anchor reproduces: direct, or the kept route on a pre-order-only SKU. */
  anchorStep: number;
  /** usdReproducing of that price. */
  dUsd: ProcurementExact;
  /** The D_usd the proposal gives it. */
  eff: ProcurementExact;
  skuFixed: boolean;
}

/** The value that occurs most often, the first one on a tie (grid order: deterministic). */
function modeOf(values: readonly ProcurementExact[]): ProcurementExact {
  const counts = new Map<string, { value: ProcurementExact; n: number }>();
  for (const v of values) {
    const key = text(v);
    const hit = counts.get(key);
    if (hit) hit.n++;
    else counts.set(key, { value: v, n: 1 });
  }
  let best: { value: ProcurementExact; n: number } | null = null;
  for (const c of counts.values()) if (!best || c.n > best.n) best = c;
  return best!.value;
}

function validateGrid(grid: TodayGrid): void {
  const keys = new Set<string>();
  for (const row of grid) {
    const sel = parseSkuComboKey(row.combo_key);
    if (!sel) throw new RangeError(`${JSON.stringify(row.combo_key)} is not a canonical combo key`);
    if (keys.has(row.combo_key)) throw new RangeError(`${JSON.stringify(row.combo_key)} is listed twice`);
    keys.add(row.combo_key);
    if ((sel.color_id ?? null) !== (row.color_id ?? null)) throw new RangeError(`${row.combo_key}: the colour is not the key's`);
    if (row.model_id !== null && !sel.option_value_ids.includes(row.model_id)) throw new RangeError(`${row.combo_key}: the model is not one of its options`);
    const seen = new Set<SkuChannel>();
    for (const c of row.channels) {
      if (!SKU_CHANNELS.includes(c.channel) || seen.has(c.channel)) throw new RangeError(`${row.combo_key}: channel ${String(c.channel)} is unknown or repeated`);
      seen.add(c.channel);
      wholeIqd(c.prepaid_iqd, `${row.combo_key} ${c.channel} prepaid`);
      wholeIqd(c.cod_iqd, `${row.combo_key} ${c.channel} COD`);
    }
  }
}

/**
 * «احتفظ بالأسعار الحالية» (keep_usd, the default for manual products): the
 * fewest price-first points and discounts that reproduce today's grid at U, then
 * priced by `priceProductV2` and diffed against today (§6.2).
 *
 * - D per SKU reproduces today's direct price (a pre-order-only SKU: its kept route).
 * - The most common model D becomes the product's price; the other models get a
 *   fixed model price. A colour that moves every model by the same amount becomes
 *   one colour difference (verified on every model); otherwise its SKUs that are
 *   not reproduced get a SKU price.
 * - Δ per SKU reproduces the kept route (`keepRoute(model)` when that SKU sells it,
 *   else the cheapest); the most common Δ is the product's, then model and SKU
 *   exceptions.
 */
export function proposeKeepUsd(
  grid: TodayGrid,
  u: string,
  opts: { keepRoute?: (modelId: string | null) => PreorderRoute | null; step?: number } = {}
): KeepProposal {
  const step = wholeStep(opts.step ?? ROUNDING_STEP_IQD);
  const U = usdRateOf(u, step);
  validateGrid(grid);
  const stepUp = (n: number) => ceilStep(n, step);
  const stepOf = (usd: ProcurementExact) => ceilStep(mulProcurementExact(usd, U), step);

  /* 1. The anchor each SKU reproduces. */
  const units: Unit[] = [];
  for (const row of grid) {
    if (!row.channels.length) continue;
    const direct = row.channels.find((c) => c.channel === 'direct_sale') ?? null;
    const routes = row.channels.filter((c) => routeOfChannel(c.channel) !== null);
    const preferred = opts.keepRoute?.(row.model_id) ?? null;
    const cheapest = [...routes].sort(
      (a, b) => a.prepaid_iqd - b.prepaid_iqd || PREORDER_ROUTES.indexOf(routeOfChannel(a.channel)!) - PREORDER_ROUTES.indexOf(routeOfChannel(b.channel)!)
    )[0];
    const keep = routes.find((c) => routeOfChannel(c.channel) === preferred) ?? cheapest ?? null;
    const anchorStep = stepUp((direct ?? keep!).prepaid_iqd);
    const dUsd = usdReproducingExact(anchorStep, U, step);
    units.push({ row, options: parseSkuComboKey(row.combo_key)!.option_value_ids, direct, routes, keep, anchorStep, dUsd, eff: dUsd, skuFixed: false });
  }

  /* 2. Product and model prices. */
  const models = new Map<string, Unit[]>();
  const modelKey = (id: string | null) => (id === null ? '\u0000' : `m:${id}`);
  for (const unit of units) {
    const k = modelKey(unit.row.model_id);
    models.set(k, [...(models.get(k) ?? []), unit]);
  }
  const modelBase = new Map<string, ProcurementExact>();
  for (const [k, list] of models) modelBase.set(k, modeOf(list.map((x) => x.dUsd)));
  const productUnit = units.find((x) => x.row.combo_key === '');
  const productUsd = units.length ? (productUnit ? productUnit.dUsd : modeOf([...modelBase.values()])) : null;
  const baseOf = (unit: Unit): ProcurementExact => (unit.row.model_id === null ? productUsd! : modelBase.get(modelKey(unit.row.model_id))!);

  const points: V2PricePoint[] = [];
  if (productUsd) points.push({ scope: 'product', scope_id: '', kind: 'fixed', usd: text(productUsd) });
  for (const [k, base] of modelBase) {
    const modelId = models.get(k)![0].row.model_id;
    if (modelId !== null && cmp(base, productUsd!) !== 0) points.push({ scope: 'option', scope_id: modelId, kind: 'fixed', usd: text(base) });
  }

  /* 3. Colours: one difference that reproduces every model, or none. */
  const colourDelta = new Map<string, ProcurementExact>();
  const colours = [...new Set(units.map((x) => x.row.color_id).filter((c): c is string => c !== null))];
  for (const colour of colours) {
    let lo: ProcurementExact | null = null;
    let hi: ProcurementExact | null = null;
    for (const unit of units.filter((x) => x.row.color_id === colour)) {
      const base = baseOf(unit);
      const low = sub(quotientProcurementExact(exactIqd(unit.anchorStep - step), U), base); // exclusive
      const up = sub(quotientProcurementExact(exactIqd(unit.anchorStep), U), base); // inclusive
      if (!lo || cmp(low, lo) > 0) lo = low;
      if (!hi || cmp(up, hi) < 0) hi = up;
    }
    if (cmp(lo!, { num: 0n, den: 1n }) < 0 && hi!.num >= 0n) continue; // the colour follows its model
    const gamma = floorToPlaces(hi!, 2);
    const magnitude = gamma.num < 0n ? { num: -gamma.num, den: gamma.den } : gamma;
    if (cmp(gamma, lo!) > 0 && gamma.num !== 0n && cmp(magnitude, procurementExact(100_000)) <= 0) {
      colourDelta.set(colour, gamma);
      points.push({ scope: 'color', scope_id: colour, kind: 'delta', usd: text(gamma) });
    }
  }

  /* 4. Each SKU: inherited D, or its own price where that does not reproduce today. */
  for (const unit of units) {
    const gamma = unit.row.color_id !== null ? (colourDelta.get(unit.row.color_id) ?? null) : null;
    const inherited = gamma ? addProcurementExact(baseOf(unit), gamma) : baseOf(unit);
    if (stepOf(inherited) === unit.anchorStep || unit.row.combo_key === '') unit.eff = inherited;
    else {
      unit.eff = unit.dUsd;
      unit.skuFixed = true;
      points.push({ scope: 'sku', scope_id: unit.row.combo_key, kind: 'fixed', usd: text(unit.dUsd) });
    }
  }

  /* 5. Discounts: the kept route of every SKU that sells direct and pre-order. */
  const discounted = units.filter((x) => x.direct && x.keep);
  const ownDelta = new Map<Unit, ProcurementExact>();
  const target = new Map<Unit, number>();
  for (const unit of discounted) {
    const d = sub(unit.eff, usdReproducingExact(unit.keep!.prepaid_iqd, U, step));
    const delta = d.num > 0n ? d : { num: 0n, den: 1n };
    ownDelta.set(unit, delta);
    target.set(unit, stepOf(sub(unit.eff, delta)));
  }
  const reproduces = (unit: Unit, delta: ProcurementExact) => {
    const left = sub(unit.eff, delta);
    return left.num > 0n && stepOf(left) === target.get(unit);
  };
  const discounts: V2Discount[] = [];
  if (discounted.length) {
    const productDelta = modeOf(discounted.map((x) => ownDelta.get(x)!));
    if (productDelta.num > 0n) discounts.push({ scope: 'product', scope_id: '', usd: text(productDelta) });
    const modelDelta = new Map<string, ProcurementExact>();
    for (const [k, list] of models) {
      const mine = list.filter((x) => ownDelta.has(x));
      const modelId = list[0].row.model_id;
      if (!mine.length || modelId === null) continue;
      const candidate = modeOf(mine.map((x) => ownDelta.get(x)!));
      if (cmp(candidate, productDelta) === 0) continue;
      const count = (delta: ProcurementExact) => mine.filter((x) => reproduces(x, delta)).length;
      if (count(candidate) > count(productDelta)) {
        modelDelta.set(k, candidate);
        discounts.push({ scope: 'option', scope_id: modelId, usd: text(candidate) });
      }
    }
    for (const unit of discounted) {
      const inherited = modelDelta.get(modelKey(unit.row.model_id)) ?? productDelta;
      if (!reproduces(unit, inherited) && unit.row.combo_key !== '') discounts.push({ scope: 'sku', scope_id: unit.row.combo_key, usd: text(ownDelta.get(unit)!) });
    }
  }

  /* 6. Price the proposal with the engine, then diff it against today. */
  const skus: V2Sku[] = units.map((x) => ({
    combo_key: x.row.combo_key,
    model_id: x.row.model_id,
    option_value_ids: x.options,
    color_id: x.row.color_id,
    channels: x.row.channels.map((c) => c.channel),
  }));
  const result = priceProductV2({
    method: 'usd',
    rates: { fx: { USD: { rate: text(U), version: 0, confirmed: true } }, shipping: {} },
    points,
    discounts,
    skus,
    step,
  });

  const rows: KeepRow[] = [];
  const kept_routes: Record<string, PreorderRoute> = {};
  const flags: KeepFlag[] = [];
  const offStep: Extract<KeepFlag, { code: 'OFF_STEP_PRICE' }>['rows'] = [];
  const cod: Extract<KeepFlag, { code: 'COD_CHANGES' }>['rows'] = [];
  const moved = new Map<string, Extract<KeepFlag, { code: 'ROUTES_NOT_REPRODUCIBLE' }>>();
  units.forEach((unit, i) => {
    const priced = result.skus[i];
    if (unit.keep) kept_routes[unit.row.combo_key] = routeOfChannel(unit.keep.channel)!;
    for (const c of unit.row.channels) {
      const now = priced.channels.find((x) => x.channel === c.channel) ?? null;
      const row: KeepRow = {
        combo_key: unit.row.combo_key,
        model_id: unit.row.model_id,
        color_id: unit.row.color_id,
        channel: c.channel,
        old_prepaid_iqd: c.prepaid_iqd,
        old_cod_iqd: c.cod_iqd,
        new_iqd: now?.price_iqd ?? null,
        new_cod_iqd: now?.direct_iqd ?? null,
        changed: now === null || now.price_iqd !== c.prepaid_iqd || now.direct_iqd !== c.cod_iqd,
      };
      rows.push(row);
      if (c.prepaid_iqd % step !== 0) offStep.push({ combo_key: row.combo_key, channel: c.channel, old_iqd: c.prepaid_iqd, new_iqd: row.new_iqd });
      if (row.new_cod_iqd !== c.cod_iqd) cod.push({ combo_key: row.combo_key, channel: c.channel, old_cod_iqd: c.cod_iqd, new_cod_iqd: row.new_cod_iqd });
      const route = routeOfChannel(c.channel);
      if (!route) continue;
      if (unit.direct && stepUp(c.prepaid_iqd) > unit.anchorStep) {
        flags.push({ code: 'PREORDER_ABOVE_DIRECT', model_id: unit.row.model_id, combo_key: unit.row.combo_key, route, old_iqd: c.prepaid_iqd, new_iqd: row.new_iqd });
      } else if (c !== unit.keep && row.new_iqd !== stepUp(c.prepaid_iqd)) {
        const k = modelKey(unit.row.model_id);
        const flag: Extract<KeepFlag, { code: 'ROUTES_NOT_REPRODUCIBLE' }> = moved.get(k) ?? {
          code: 'ROUTES_NOT_REPRODUCIBLE',
          model_id: unit.row.model_id,
          kept_route: routeOfChannel(unit.keep!.channel)!,
          moved: [],
        };
        flag.moved.push({ combo_key: unit.row.combo_key, route, old_iqd: c.prepaid_iqd, new_iqd: row.new_iqd });
        moved.set(k, flag);
      }
    }
  });
  flags.push(...moved.values());
  for (const colour of colours) {
    if (colourDelta.has(colour)) flags.push({ code: 'LEGACY_COLOUR_PRICE', color_id: colour, became: 'colour_delta' });
    else if (units.some((x) => x.row.color_id === colour && x.skuFixed)) flags.push({ code: 'LEGACY_COLOUR_PRICE', color_id: colour, became: 'sku_fixed' });
  }
  if (offStep.length) flags.push({ code: 'OFF_STEP_PRICE', rows: offStep });
  if (cod.length) flags.push({ code: 'COD_CHANGES', rows: cod });
  flags.push({ code: 'FX_LINKED' });

  return {
    method: 'usd',
    points,
    discounts,
    kept_routes,
    result,
    rows,
    flags,
    unchanged: result.ok && rows.every((r) => !r.changed) && flags.every((f) => f.code === 'FX_LINKED'),
  };
}
