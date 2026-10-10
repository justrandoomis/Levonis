/**
 * THE PREVIEW BEFORE AN OWNER RATE ACT (FX programme plan §7.8, §8 FX-5 routes;
 * owner decisions 8 and 11).
 *
 * Approving a held rate, setting a manual rate or the adjustment, and changing
 * a central shipping rate each reprice the engine products that rate prices
 * (FX-5, autoReprice.ts). Before the owner makes such an act, this module
 * answers what it would do — WITHOUT WRITING ANYTHING:
 *   - every engine product the new rate would leave stale (the same stale
 *     rule as the automatic run, at the rates the act would commit);
 *   - per model × channel: today's customer price → the new one, the change,
 *     and the deficit (the new replacement cost + minimum profit − today's
 *     price, the order the run writes in), with the 15% and 30% flags;
 *   - the products the engine could not reprice (a code, never a figure);
 *   - how many would follow on the quarter-hour sweep «خلال 15 دقيقة» because
 *     the request's own statement budget ends first;
 *   - `preview_hash`, which the act must carry once any product is
 *     engine-priced (409 PRICING_PREVIEW_REQUIRED / PRICING_PREVIEW_STALE
 *     return this preview, worker/routes/adminPricing.ts).
 *
 * HOW. The writer's own evaluation (evaluateEngineWrite: E1 at the given
 * rates → planWrites → verifyPlan against the cart's resolver) over the
 * CURRENT rates with the act's move laid on top (`ratesAfter`) — the derived
 * IQD rates composed exactly as the FX commit composes them (U, E × U, C × U),
 * a rate written only where its value changes. Reads: a constant number of
 * statements (the engine states, the stored figures and the rates, the control
 * row, every price image in one statement, the documents in chunks of 50,
 * the stores and the guest pricing context), charged by the caller.
 *
 * THE HASH binds the act (its kind, pair or profile, the rate before and
 * after, the pair's owner version or the profile's version), the rates read
 * (every version and value) and, per affected product, the writer's own
 * evaluation hash (its state, config version, inputs, rules, price image and
 * the planned prices) or its refusal code. Anything that moves between the
 * preview and the act changes it.
 *
 * PRIVATE. Every figure here is the owner's: the routes are behind
 * requireCostRead, and every amount key of the answer is in FINANCIAL_FIELDS.
 */
import type { CentralRate } from '@levonis/pricing/costToPrice';
import { composeIqdRates, sameRate } from '@levonis/pricing/fxChain';
import type { ShippingProfile } from '@levonis/pricing/skuChannel';
import { sha256Hex } from '../crypto';
import { isMissingTable, type FxPairId } from '../fx/pairs';
import { loadPreviewContext, loadProducts } from './load';
import { loadProductsPricing } from './store';
import type { PricingRates } from './rates';
import { canonical } from './procurementPreview';
import { blockCodeOf, deficitOf, loadEngineStates, pricesUnchanged, priceSourceOf, staleEngineProducts, AUTO_REPRICE_SOURCE, type EngineStateRow } from './autoReprice';
import { engineWriteStatements, evaluateEngineWrite, loadEngineControl, loadStoredSkuCosts, priceImagesOf, type EngineEvaluation } from './engineWrite';

/** What an owner act moves. */
export type RateMove =
  | {
      kind: 'fx';
      /** review = approve a held rate; manual = a manual rate; adjustment = market_adjustment_iqd. */
      act: 'review' | 'manual' | 'adjustment';
      pair: FxPairId;
      /** The pair's owner version as read: the act is fenced on it. */
      owner_version: number;
      /** The effective rate of the pair before and after the act. */
      before: string | null;
      after: string | null;
      /** Pairs whose held candidate the act clears (an approval, a manual rate). */
      clears_pending: boolean;
    }
  | {
      kind: 'shipping';
      profile: ShippingProfile;
      /** The profile's version as read: the act is fenced on it. */
      version: number;
      before: string | null;
      after: string;
    };

/**
 * The rates the act would leave, laid over today's: the pair's effective rate,
 * the derived IQD rates composed as the FX commit composes them (written only
 * where the value changes, its version + 1), or one shipping rate.
 */
export function ratesAfter(rates: PricingRates, move: RateMove): PricingRates {
  const fx: Partial<Record<'USD' | 'EUR' | 'CNY', CentralRate>> = { ...rates.central.fx };
  const shipping: Partial<Record<ShippingProfile, CentralRate>> = { ...rates.central.shipping };
  const next: PricingRates = {
    ...rates,
    central: { fx, shipping },
    pair_versions: { ...rates.pair_versions },
    fx_versions: { ...rates.fx_versions },
    shipping_versions: { ...rates.shipping_versions },
    review_pending: { ...rates.review_pending },
  };
  if (move.kind === 'shipping') {
    const now = rates.central.shipping[move.profile];
    shipping[move.profile] = { rate: move.after, version: (now?.version ?? 0) + 1, confirmed: true };
    next.shipping_versions[move.profile] = (rates.shipping_versions[move.profile] ?? 0) + 1;
    return next;
  }
  if (move.clears_pending) next.review_pending[move.pair] = false;
  const moved = move.after !== null && (move.before === null || !sameRate(move.before, move.after));
  if (!moved) return next;
  const effective = { USD_IQD: rates.usd_iqd, EUR_USD: rates.eur_usd, CNY_USD: rates.cny_usd } as Record<FxPairId, string | null>;
  effective[move.pair] = move.after;
  next.pair_versions[move.pair] = (rates.pair_versions[move.pair] ?? 0) + 1;
  next.usd_iqd = effective.USD_IQD;
  next.eur_usd = effective.EUR_USD;
  next.cny_usd = effective.CNY_USD;
  const composed = composeIqdRates(effective.USD_IQD, effective.EUR_USD, effective.CNY_USD);
  for (const c of ['USD', 'EUR', 'CNY'] as const) {
    const rate = composed[c];
    if (rate === null) continue;
    const stored = rates.central.fx[c]?.rate ?? null;
    if (stored !== null && sameRate(stored, rate)) continue;
    fx[c] = { rate, version: (rates.fx_versions[c] ?? 0) + 1, confirmed: true };
    next.fx_versions[c] = (rates.fx_versions[c] ?? 0) + 1;
  }
  return next;
}

/** One model × channel of the preview: today's customer price → the new one (owner-only figures). */
export interface RatePreviewRow {
  product_id: string;
  name_ar: string;
  name_en: string;
  name_ckb: string;
  option_id: string;
  model_ar: string;
  model_en: string;
  model_ckb: string;
  channel: string;
  today_prepaid_iqd: number | null;
  computed_price_iqd: number;
  change_iqd: number | null;
  change_pct: string | null;
  /** The new replacement cost + minimum profit − today's price: how far today's price lies below the new floor (negative: above it). */
  deficit_iqd: number;
  large: boolean;
  drop_flag: boolean;
}

export interface RatePreviewBlocked {
  product_id: string;
  name_ar: string;
  name_en: string;
  name_ckb: string;
  code: string;
}

export interface RatePreview {
  act: { kind: 'review' | 'manual' | 'adjustment' | 'shipping'; pair: FxPairId | null; profile: ShippingProfile | null; effective_before: string | null; effective_after: string | null };
  /** Engine-priced products today. */
  engine_products: number;
  /** Products (and their model × channel rows) the act would reprice. */
  affected: { products: number; models: number };
  /** Of those, the products whose customer price would move. */
  changed_products: number;
  rows: RatePreviewRow[];
  blocked: RatePreviewBlocked[];
  /** Products the request's own statement budget would leave to the quarter-hour sweep («خلال 15 دقيقة»). */
  follows: number;
  large_change: boolean;
  drop_flag: boolean;
  preview_hash: string;
}

export interface RatePreviewResult {
  preview: RatePreview;
  /** Statements the preview's reads cost (the caller charges them to its invocation budget). */
  statements: number;
}

/** loadProducts reads in chunks of 50: one product read and eight relation reads per chunk. */
const PRODUCT_CHUNK = 50;
const READS_PER_CHUNK = 9;
/** The automatic run's own reads before it writes (autoReprice.ts steps 1-2), with the run record and the bell. */
const RUN_READS = (n: number) => 1 + 3 + 1 + 1 + READS_PER_CHUNK * Math.ceil(n / PRODUCT_CHUNK) + 4 + 1 + 2;
/** A blocked product's record and its bell (autoReprice.ts `block`). */
const BLOCK_COST = 8;

const names = (doc: { name_ar?: unknown; name_en?: unknown; name_ckb?: unknown }) => ({
  name_ar: String(doc.name_ar ?? ''),
  name_en: String(doc.name_en ?? ''),
  name_ckb: String(doc.name_ckb ?? ''),
});

/**
 * The preview of one act (see the file header). `budgetLeft` is what the act's
 * request has left after its own batch; the preview's reads come out of it
 * too, and `follows` is counted against the rest. Throws on a database without the engine
 * or the rates (the caller answers 503); never writes.
 */
export async function previewRateAct(db: D1Database, move: RateMove, rates: PricingRates, budgetLeft: number): Promise<RatePreviewResult> {
  const after = ratesAfter(rates, move);
  let states: EngineStateRow[];
  try {
    states = await loadEngineStates(db);
  } catch (e) {
    if (isMissingTable(e)) states = [];
    else throw e;
  }
  let statements = 1;
  const costs = states.length ? await loadStoredSkuCosts(db, states.map((s) => s.product_id)) : [];
  if (states.length) statements += 1;
  const stale = staleEngineProducts(states, costs, after);
  const ids = stale.map((p) => p.state.product_id);
  const rows: RatePreviewRow[] = [];
  const blocked: RatePreviewBlocked[] = [];
  const evaluated: Array<{ pid: string; hash: string | null; code: string | null }> = [];
  const ready: Array<{ ev: EngineEvaluation; deficit: number; cost: number }> = [];
  if (ids.length) {
    const control = await loadEngineControl(db);
    const images = await priceImagesOf(db, ids);
    const [loaded, stores, ctx] = await Promise.all([loadProducts(db, ids), loadProductsPricing(db, ids), loadPreviewContext(db)]);
    statements += 1 + 1 + READS_PER_CHUNK * Math.ceil(ids.length / PRODUCT_CHUNK) + 4 + 1;
    for (const p of stale) {
      const pid = p.state.product_id;
      const product = loaded.get(pid);
      const stored = stores.get(pid);
      if (!product || !stored || stored.state?.mode !== 'engine') continue;
      const productNames = names(product.doc);
      let ev: EngineEvaluation;
      try {
        ev = await evaluateEngineWrite({
          loaded: product,
          stored,
          ctx,
          rates: after,
          control,
          inputs: stored.inputs,
          inputWrites: [],
          ruleWrites: [],
          image: images.get(pid) ?? '',
          storedCosts: p.rows,
        });
      } catch {
        blocked.push({ product_id: pid, ...productNames, code: 'REPRICE_BLOCKED' });
        evaluated.push({ pid, hash: null, code: 'REPRICE_BLOCKED' });
        continue;
      }
      if (ev.kind !== 'reprice' || !ev.complete || !ev.hash || !ev.needs_write) {
        const code = blockCodeOf(ev.codes);
        blocked.push({ product_id: pid, ...productNames, code });
        evaluated.push({ pid, hash: null, code });
        continue;
      }
      evaluated.push({ pid, hash: ev.hash, code: null });
      // The batch the automatic run would send for it: its exact size, for `follows`.
      const batch = await engineWriteStatements(db, ev, [], [], {
        actor: 'preview',
        now: new Date(0).toISOString(),
        source: AUTO_REPRICE_SOURCE,
        idempotencyKey: `preview:${pid}`,
        auto: { priceSource: priceSourceOf(p.reasons), pricesUnchanged: pricesUnchanged(ev), trigger: 'owner_rate', reasons: p.reasons },
      });
      ready.push({ ev, deficit: deficitOf(ev), cost: batch.length });
      for (const r of ev.rows) {
        rows.push({
          product_id: pid,
          ...productNames,
          option_id: r.option_id,
          model_ar: r.name_ar,
          model_en: r.name_en,
          model_ckb: r.name_ckb,
          channel: r.channel,
          today_prepaid_iqd: r.old_iqd,
          computed_price_iqd: r.new_iqd,
          change_iqd: r.change_iqd,
          change_pct: r.change_pct,
          deficit_iqd: r.replacement_cost_iqd + r.target_profit_iqd - (r.old_iqd ?? 0),
          large: r.large,
          drop_flag: r.drop_flag,
        });
      }
    }
  }

  // Deficit first, as the run writes them; what the request's budget cannot cover follows on the sweep.
  ready.sort((a, b) => b.deficit - a.deficit || (a.ev.product_id < b.ev.product_id ? -1 : a.ev.product_id > b.ev.product_id ? 1 : 0));
  // The act's request spends the preview's reads again before it commits: they come out of the run's room too.
  let left = budgetLeft - statements - RUN_READS(ready.length + blocked.length) - BLOCK_COST * blocked.length;
  let follows = 0;
  for (const r of ready) {
    if (follows === 0 && r.cost <= left) left -= r.cost;
    else follows += 1;
  }
  const order = new Map(ready.map((r, i) => [r.ev.product_id, i]));
  rows.sort((a, b) => (order.get(a.product_id) ?? 0) - (order.get(b.product_id) ?? 0));

  const act: RatePreview['act'] =
    move.kind === 'shipping'
      ? { kind: 'shipping', pair: null, profile: move.profile, effective_before: move.before, effective_after: move.after }
      : { kind: move.act, pair: move.pair, profile: null, effective_before: move.before, effective_after: move.after };
  const preview_hash = await sha256Hex(
    canonical({
      v: 1,
      act,
      fence: move.kind === 'shipping' ? { version: move.version } : { owner_version: move.owner_version },
      rates: {
        u: rates.usd_iqd,
        e: rates.eur_usd,
        c: rates.cny_usd,
        fx: rates.fx_versions,
        fx_rates: [rates.central.fx.USD?.rate ?? null, rates.central.fx.EUR?.rate ?? null, rates.central.fx.CNY?.rate ?? null],
        pairs: rates.pair_versions,
        shipping: rates.shipping_versions,
        shipping_rates: [rates.central.shipping.GERMANY_LAND?.rate ?? null, rates.central.shipping.CHINA_AIR?.rate ?? null, rates.central.shipping.CHINA_SEA?.rate ?? null],
      },
      engine_products: states.length,
      products: evaluated.sort((a, b) => (a.pid < b.pid ? -1 : a.pid > b.pid ? 1 : 0)).map((e) => [e.pid, e.hash, e.code]),
    })
  );
  const changed = new Set(ready.filter((r) => r.ev.rows.some((x) => x.old_iqd !== x.new_iqd)).map((r) => r.ev.product_id));
  return {
    preview: {
      act,
      engine_products: states.length,
      affected: { products: ready.length + blocked.length, models: rows.length },
      changed_products: changed.size,
      rows,
      blocked,
      follows,
      large_change: rows.some((r) => r.large),
      drop_flag: rows.some((r) => r.drop_flag),
      preview_hash,
    },
    statements,
  };
}
