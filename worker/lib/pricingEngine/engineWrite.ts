/**
 * THE ENGINE'S WRITE: ADOPTION AT THE OWNER'S COMPLETING SAVE, AND EVERY LATER
 * OWNER SAVE OF AN ENGINE-PRICED PRODUCT (owner decision 8; USD design §6.1-§6.5;
 * MVP plan §5 "Writer order inside the batch").
 *
 * `evaluateEngineWrite` answers, for one product with the owner's drafts laid
 * over its store (inputs, rules — and, at adoption, its migrated dinar minimum
 * profit converted to USD at today's U, owner question Q2's default):
 *   - complete or not (every model × channel sold today priced by E1 at the
 *     LAST CONFIRMED central rates of the versioned reader, the shape writable,
 *     and the cart's resolver reading the planned rows back exactly — writer.ts);
 *   - the six figures per model × channel (current replacement cost, minimum
 *     profit, new pre-order price, Direct Sale Extra, new direct price, old →
 *     new), PRO/PRIME before → after, "route fee removed", the 15% / 30% flags;
 *   - the preview hash every price write must carry.
 * A manual product that the drafts leave complete is ADOPTED by the same batch
 * that stores the drafts (no separate activation step); an incomplete one
 * stores its data and keeps its manual price; an engine product's save always
 * reprices in the same batch (its inputs move only under the engine token).
 *
 * THE BATCH (`engineWriteStatements`), atomic, in order:
 *   1. fences: the product's pricing state (inputs_seq, write_seq, mode) and
 *      config_version as read (store.batchHead), the control row not paused,
 *      and the product's PRICE IMAGE (one SQL expression over every price,
 *      member, adjustment, fee and enabled column of the product and its four
 *      relation tables) equal to the one the preview hashed;
 *   2. tokens: the owner-input token (store.batchHead), `engine-price:<id>`, and
 *      `pricing-mode:<id>` at adoption;
 *   3. the drafts (inputs, rules) and the migrated minimum's conversion;
 *   4. the price rows (writer.ts), one UPDATE per table through json_each;
 *   5. `price_history` under `sku:<combo>@<channel>`, field `regular`, with the
 *      U the price was computed at and `price_source = 'engine_owner'` (owner
 *      decision 6's observations; `engine_fx` for FX-5's automatic repricing
 *      when only exchange rates moved);
 *   6. `pricing_sku_costs`: the product's rows replaced (Final Price USD stored
 *      privately beside the dinar price);
 *   7. `product_pricing_state`: mode engine, write_seq + 1, priced_*;
 *   8. `pricing_audit` (values, owner-only, idempotency key) and `audit_log`
 *      (ids and counts only);
 *   9. the tokens deleted.
 * Bounded: a product's writes are a handful of statements plus one per draft;
 * the caller asserts the cap.
 *
 * PRIVATE: every value here is the owner's. This module never names an
 * accounting table (orders, order lines, lots, the wallet) and never writes a
 * purchase row.
 */
import { resolveSkuInputs, type ChannelPrice } from '@levonis/pricing/costToPrice';
import { currentUsdCost } from '@levonis/pricing/fxChain';
import { skuPriceHistoryKey, type SkuChannel } from '@levonis/pricing/skuChannel';
import { ceilToPlaces, compareProcurementExact, procurementExact, procurementExactText, quotientProcurementExact } from '@levonis/contracts/procurementCost';
import type { PricingContext } from '../../routes/cart';
import { newId, sha256Hex } from '../crypto';
import { fence } from '../operations';
import { auditStatements } from '../audit';
import { evaluateLegacy, type LegacyEvaluation } from './legacy';
import type { LoadedProduct } from './load';
import type { PricingRates } from './rates';
import { canonical, priceModels, type PricedModel } from './procurementPreview';
import { mergedRules } from './fromPurchase';
import {
  INPUT_FIELD_NAMES,
  batchHead,
  batchTail,
  chainOf,
  inputStatements,
  pricingAuditStatement,
  ruleStatements,
  type InputFields,
  type InputWrite,
  type ProductPricingData,
  type RuleWrite,
  type StoredInputRow,
  type StoredRuleRow,
} from './store';
import { planWrites, verifyPlan, type PricePlan, type Verification } from './writer';

// ------------------------------------------------------------ the price image

/**
 * The product's price image, as ONE SQL expression the preview reads and the
 * batch fences on (MVP §5: no JavaScript re-implementation can drift from it).
 * Every price, member price, adjustment, fee and enabled column of the product
 * and its five relation tables, in id order. Binds the product id 6 times.
 */
export const PRICE_IMAGE_SQL = `SELECT
  COALESCE((SELECT json_array(price_iqd, prime_price_iqd, pro_price_iqd, direct_surcharge_iqd, preorder_transports) FROM products WHERE id = ?), '-')
  || '|' || COALESCE((SELECT group_concat(x, ';') FROM (SELECT json_array(id, active, regular_price_iqd, prime_price_iqd, pro_price_iqd, regular_adjust_iqd, prime_adjust_iqd, pro_adjust_iqd) AS x
                       FROM product_option_values WHERE product_id = ? ORDER BY id)), '')
  || '|' || COALESCE((SELECT group_concat(x, ';') FROM (SELECT json_array(id, option_id, fulfillment_type, enabled, regular_price_iqd, prime_price_iqd, pro_price_iqd, regular_adjust_iqd, prime_adjust_iqd, pro_adjust_iqd) AS x
                       FROM product_option_fulfillment WHERE product_id = ? ORDER BY id)), '')
  || '|' || COALESCE((SELECT group_concat(x, ';') FROM (SELECT json_array(id, fulfillment_id, method, enabled, surcharge_iqd, regular_price_iqd, prime_price_iqd, pro_price_iqd, regular_adjust_iqd, prime_adjust_iqd, pro_adjust_iqd) AS x
                       FROM product_option_transports WHERE product_id = ? ORDER BY id)), '')
  || '|' || COALESCE((SELECT group_concat(x, ';') FROM (SELECT json_array(id, active, regular_price_iqd, prime_price_iqd, pro_price_iqd, regular_adjust_iqd, prime_adjust_iqd, pro_adjust_iqd) AS x
                       FROM product_colors WHERE product_id = ? ORDER BY id)), '')
  || '|' || COALESCE((SELECT group_concat(x, ';') FROM (SELECT json_array(id, active, regular_price_iqd, prime_price_iqd, pro_price_iqd) AS x
                       FROM product_variants WHERE product_id = ? ORDER BY id)), '')`;

const imageBinds = (pid: string) => [pid, pid, pid, pid, pid, pid];

/**
 * THE RATES A PRICE WAS COMPUTED AT, as one SQL condition the batch fences on
 * (USD design §6.4: every write is fenced on the rates it read). The
 * `config_version` fence alone is not enough: a route reads the rates FIRST and
 * the product's store (with its `config_version`) after, so a rate committed in
 * between — or during a bulk save's loop, which reads the rates once — would
 * leave a fresh `config_version` beside a price computed at the superseded
 * rate. Every central rate is compared by VALUE (`IS`, so a missing rate stays
 * missing): only the last confirmed rates ever reach a stored price.
 */
export const RATES_FENCE_SQL = `(SELECT rate_iqd FROM pricing_fx_rates WHERE currency = 'USD') IS ?
  AND (SELECT rate_iqd FROM pricing_fx_rates WHERE currency = 'EUR') IS ?
  AND (SELECT rate_iqd FROM pricing_fx_rates WHERE currency = 'CNY') IS ?
  AND (SELECT effective_rate FROM fx_rate_pairs WHERE pair = 'USD_IQD') IS ?
  AND (SELECT rate_iqd FROM pricing_shipping_rates WHERE profile = 'GERMANY_LAND') IS ?
  AND (SELECT rate_iqd FROM pricing_shipping_rates WHERE profile = 'CHINA_AIR') IS ?
  AND (SELECT rate_iqd FROM pricing_shipping_rates WHERE profile = 'CHINA_SEA') IS ?`;

export const rateFenceBinds = (r: PricingRates): Array<string | null> => [
  r.central.fx.USD?.rate ?? null,
  r.central.fx.EUR?.rate ?? null,
  r.central.fx.CNY?.rate ?? null,
  r.usd_iqd,
  r.central.shipping.GERMANY_LAND?.rate ?? null,
  r.central.shipping.CHINA_AIR?.rate ?? null,
  r.central.shipping.CHINA_SEA?.rate ?? null,
];

export async function priceImageOf(db: D1Database, productId: string): Promise<string> {
  const r = await db.prepare(`${PRICE_IMAGE_SQL} AS image`).bind(...imageBinds(productId)).first<{ image: string }>();
  return String(r?.image ?? '');
}

/**
 * The price images of several products in ONE statement (FX-5's sweep reads
 * every candidate's image before its documents). The SAME expression as
 * PRICE_IMAGE_SQL, each product id taken from the one JSON list parameter
 * (D1's 100-parameter cap never binds), so a write fenced on
 * PRICE_IMAGE_SQL compares exactly what was read here
 * (tests/fxRepricing.test.ts holds the two equal over the whole census).
 */
export const PRICE_IMAGES_SQL = `SELECT j.value AS product_id, (${PRICE_IMAGE_SQL.replace(/\?/g, 'j.value')}) AS image FROM json_each(?) j`;

export async function priceImagesOf(db: D1Database, ids: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!ids.length) return out;
  const { results } = await db.prepare(PRICE_IMAGES_SQL).bind(JSON.stringify([...new Set(ids)])).all<{ product_id: string; image: string }>();
  for (const r of results ?? []) out.set(String(r.product_id), String(r.image ?? ''));
  return out;
}

/**
 * The same images, one PRICE_IMAGE_SQL statement per product in one batch (one
 * snapshot): the fallback for an engine that refuses the correlated form
 * above. Costs one statement per product.
 */
export async function priceImagesEach(db: D1Database, ids: readonly string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  const out = new Map<string, string>();
  if (!unique.length) return out;
  const answers = await db.batch(unique.map((id) => db.prepare(`${PRICE_IMAGE_SQL} AS image`).bind(...imageBinds(id))));
  unique.forEach((id, i) => {
    const r = ((answers[i] as D1Result<{ image: string }> | undefined)?.results ?? [])[0];
    out.set(id, String(r?.image ?? ''));
  });
  return out;
}

// ------------------------------------------------------------ the engine's control row and stored results

export interface EngineControl {
  paused: boolean;
  large_change_pct: number;
  max_drop_pct: number;
}

export async function loadEngineControl(db: D1Database): Promise<EngineControl> {
  const r = await db.prepare('SELECT paused, large_change_pct, max_drop_pct FROM pricing_engine_control WHERE id = 1').first<{ paused: number; large_change_pct: number; max_drop_pct: number }>();
  return { paused: Number(r?.paused ?? 0) === 1, large_change_pct: Number(r?.large_change_pct ?? 15), max_drop_pct: Number(r?.max_drop_pct ?? 30) };
}

/** What a stored engine price was computed from (the stale list compares it with today's confirmed rates). */
export interface StoredSkuCost {
  product_id: string;
  combo_key: string;
  channel: SkuChannel;
  supplier_currency: string;
  fx_rate: string;
  usd_iqd_rate: string;
  shipping_profile: string;
  shipping_rate: string;
  computed_price_iqd: number;
  final_price_usd: string;
}

export async function loadStoredSkuCosts(db: D1Database, ids: readonly string[]): Promise<StoredSkuCost[]> {
  if (!ids.length) return [];
  const { results } = await db
    .prepare(
      `SELECT product_id, combo_key, channel, supplier_currency, fx_rate, usd_iqd_rate, shipping_profile, shipping_rate, computed_price_iqd, final_price_usd
         FROM pricing_sku_costs WHERE product_id IN (SELECT value FROM json_each(?)) ORDER BY product_id, combo_key, channel`
    )
    .bind(JSON.stringify([...new Set(ids)]))
    .all<StoredSkuCost>();
  return results ?? [];
}

const same = (a: string | null | undefined, b: string | null | undefined) => {
  if (a === null || a === undefined || b === null || b === undefined) return (a ?? null) === (b ?? null);
  try {
    return compareProcurementExact(procurementExact(a), procurementExact(b)) === 0;
  } catch {
    return a === b;
  }
};

/**
 * A stored engine price whose confirmed rate moved since it was computed: the
 * supplier currency's IQD rate, U (the minimum profit's T × U), or the route's
 * central shipping rate. The automatic repricing (FX-5, autoReprice.ts) works
 * through exactly this list, deficit first, within the invocation's statement
 * budget; the owner can still preview and re-save them (the stale list).
 */
export function staleReasons(rows: readonly StoredSkuCost[], rates: PricingRates): string[] {
  const out = new Set<string>();
  for (const r of rows) {
    const fx = rates.central.fx[r.supplier_currency as 'USD' | 'EUR' | 'CNY']?.rate ?? null;
    if (!same(r.fx_rate, fx)) out.add(r.supplier_currency);
    if (!same(r.usd_iqd_rate, rates.usd_iqd)) out.add('USD');
    const ship = rates.central.shipping[r.shipping_profile as 'GERMANY_LAND' | 'CHINA_AIR' | 'CHINA_SEA']?.rate ?? null;
    if (!same(r.shipping_rate, ship)) out.add(r.shipping_profile);
  }
  return [...out].sort();
}

// ------------------------------------------------------------ the migrated minimum (owner question Q2)

export interface LegacyConversion {
  rule: StoredRuleRow;
  amount_usd: string;
  legacy_amount_iqd: number;
  usd_iqd_rate: string;
}

/**
 * The product's migrated dinar minimum profits, converted to USD at U, rounded
 * UP to the cent (USD design §4.3): amount_usd × U ≥ the old dinars, so the
 * price on the adopting day is never below the old margin.
 */
export function legacyConversions(productId: string, rules: readonly StoredRuleRow[], u: string | null): LegacyConversion[] {
  if (!u) return [];
  return rules
    .filter((r) => r.product_id === productId && r.kind === 'target_profit' && r.source === 'LEGACY_MIGRATION' && r.state === 'ACTIVE' && r.amount_usd === null && r.amount_iqd !== null && r.amount_iqd > 0)
    .map((r) => ({
      rule: r,
      amount_usd: procurementExactText(ceilToPlaces(quotientProcurementExact(procurementExact(r.amount_iqd!), procurementExact(u)), 2)),
      legacy_amount_iqd: r.amount_iqd!,
      usd_iqd_rate: u,
    }));
}

const applyConversions = (rules: readonly StoredRuleRow[], conversions: readonly LegacyConversion[]): StoredRuleRow[] =>
  rules.map((r) => {
    const c = conversions.find((x) => x.rule.id === r.id);
    return c ? { ...r, amount_usd: c.amount_usd, amount_iqd: null, legacy_amount_iqd: c.legacy_amount_iqd, legacy_usd_iqd_rate: c.usd_iqd_rate, version: r.version + 1 } : r;
  });

// ------------------------------------------------------------ the evaluation

/** One model × channel of the owner's preview (owner decision 8's six figures and the flags). */
export interface EngineRow {
  option_id: string;
  name_ar: string;
  name_en: string;
  name_ckb: string;
  channel: SkuChannel;
  old_iqd: number | null;
  new_iqd: number;
  change_iqd: number | null;
  /** (new − old) ÷ old × 100, signed, 2 places — display. */
  change_pct: string | null;
  large: boolean;
  drop_flag: boolean;
  replacement_cost_iqd: number;
  target_profit_usd: string | null;
  target_profit_iqd: number;
  preorder_base_iqd: number;
  direct_sale_extra_iqd: number | null;
  final_price_usd: string | null;
  route_fee_removed: boolean;
  pro_before_iqd: number | null;
  pro_after_iqd: number | null;
  prime_before_iqd: number | null;
  prime_after_iqd: number | null;
}

export interface EngineEvaluation {
  product_id: string;
  mode: 'manual' | 'engine';
  /** adopt: a manual product the save leaves complete; reprice: an engine product; null: incomplete, data only. */
  kind: 'adopt' | 'reprice' | null;
  complete: boolean;
  /** Why the product is not complete (pricing issue codes), sorted. */
  codes: string[];
  rows: EngineRow[];
  large_change: boolean;
  drop_flag: boolean;
  /** A migrated dinar minimum rounds up to the cent and moves a price one step. */
  legacy_step: boolean;
  cod_priced_as_direct: boolean;
  review_pending: boolean;
  /** The save would write a price (or the stored engine figures are stale). */
  needs_write: boolean;
  /** Hash of everything the write depends on; null when nothing can be written. */
  hash: string | null;
  // internal
  plan: PricePlan;
  verification: Verification;
  conversions: LegacyConversion[];
  rules: StoredRuleRow[];
  inputs: Array<Partial<StoredInputRow>>;
  models: PricedModel[];
  legacy: LegacyEvaluation;
  image: string;
  rates: PricingRates | null;
  stored: ProductPricingData;
}

export interface EngineEvaluationInput {
  loaded: LoadedProduct;
  stored: ProductPricingData;
  ctx: PricingContext;
  rates: PricingRates | null;
  control: EngineControl;
  /** The store's owner rows as the drafts leave them. */
  inputs: ReadonlyArray<Partial<StoredInputRow>>;
  inputWrites: readonly InputWrite[];
  ruleWrites: readonly RuleWrite[];
  /** The typed dinars of the drafts ([scope, scope_id, amount, reconvert]); their snapshot time is not hashed. */
  iqd?: ReadonlyArray<readonly [string, string, string, boolean]>;
  image: string;
  storedCosts: readonly StoredSkuCost[];
  /** A product the owner took back to manual adopts only when the save asks for it (`adopt: true`). */
  allowAdopt?: boolean;
}

const setImage = (set: Partial<InputFields>) => Object.fromEntries(INPUT_FIELD_NAMES.filter((k) => k in set).map((k) => [k, set[k] ?? null]));

const pctText = (oldIqd: number, newIqd: number): string => {
  const q = ((newIqd - oldIqd) * 10_000) / oldIqd;
  const r = Math.round(Math.abs(q)) * Math.sign(q);
  return (r / 100).toFixed(2);
};

/** Assign the ids of new rule rows up front, so the stored results name the rule that decided them. */
export function withRuleIds(writes: readonly RuleWrite[]): RuleWrite[] {
  return writes.map((w) => (w.existing || w.new_id ? w : { ...w, new_id: newId('prule') }));
}

export async function evaluateEngineWrite(a: EngineEvaluationInput): Promise<EngineEvaluation> {
  const pid = a.loaded.id;
  const mode = a.stored.state?.mode === 'engine' ? 'engine' : 'manual';
  const rates = a.rates;
  const u = rates?.usd_iqd ?? null;
  const drafted = mergedRules(a.stored, a.ruleWrites) as StoredRuleRow[];
  const conversions = legacyConversions(pid, drafted, u);
  const rules = applyConversions(drafted, conversions);
  const legacy = evaluateLegacy(pid, a.loaded.doc, a.loaded.view, a.ctx);
  const models = priceModels(pid, legacy.models, a.inputs, rules, rates);
  const codes = new Set<string>();
  if (!rates || !u) codes.add('FX_RATE_MISSING');
  if (rates?.derived_stale) codes.add('FX_DERIVED_STALE');
  if (a.control.paused) codes.add('PRICING_ENGINE_PAUSED');
  for (const m of models) {
    const sold = m.channels.filter((c) => c.ok).map((c) => c.channel);
    for (const i of m.result?.issues ?? []) if (i.severity === 'error' && (!i.channel || sold.includes(i.channel))) codes.add(i.code);
  }
  const plan = planWrites(a.loaded, legacy, models);
  for (const c of plan.codes) codes.add(c);
  const verification = codes.size ? { ok: false, mismatches: [], rows: [] } : verifyPlan(a.loaded, legacy, plan, a.ctx);
  if (!codes.size && !verification.ok) codes.add('RESOLVER_MISMATCH');
  const complete = codes.size === 0;
  const kind: EngineEvaluation['kind'] = mode === 'engine' ? 'reprice' : complete && a.allowAdopt !== false ? 'adopt' : null;

  // The six figures and the flags, per model × channel.
  const rows: EngineRow[] = [];
  if (complete) {
    for (const p of plan.prices) {
      const model = legacy.models.find((m) => m.option_id === p.option_id)!;
      const today = model.channels.find((c) => c.channel === p.channel) ?? null;
      const oldIqd = today?.ok ? today.prepaid_iqd : null;
      const newIqd = p.price.computed_price_iqd;
      const tiers = verification.rows.find((r) => r.option_id === p.option_id && r.channel === p.channel) ?? null;
      rows.push({
        option_id: p.option_id,
        name_ar: model.option?.name_ar ?? '',
        name_en: model.option?.name_en ?? '',
        name_ckb: model.option?.name_ckb ?? '',
        channel: p.channel,
        old_iqd: oldIqd,
        new_iqd: newIqd,
        change_iqd: oldIqd === null ? null : newIqd - oldIqd,
        change_pct: oldIqd ? pctText(oldIqd, newIqd) : null,
        large: oldIqd ? Math.abs(newIqd - oldIqd) * 100 > a.control.large_change_pct * oldIqd : false,
        drop_flag: oldIqd ? (oldIqd - newIqd) * 100 > a.control.max_drop_pct * oldIqd : false,
        replacement_cost_iqd: p.price.replacement_cost_iqd,
        target_profit_usd: p.price.target_profit_usd,
        target_profit_iqd: p.price.target_profit_iqd,
        preorder_base_iqd: p.price.preorder_base_iqd,
        direct_sale_extra_iqd: p.price.direct_sale_extra_iqd,
        final_price_usd: p.price.final_price_usd,
        route_fee_removed: !!today?.ok && (today.fee_iqd ?? 0) > 0,
        pro_before_iqd: tiers?.pro_before_iqd ?? null,
        pro_after_iqd: tiers?.pro_after_iqd ?? null,
        prime_before_iqd: tiers?.prime_before_iqd ?? null,
        prime_after_iqd: tiers?.prime_after_iqd ?? null,
      });
    }
  }

  // A migrated minimum that rounds up a price step is flagged (L4).
  let legacyStep = false;
  if (complete && conversions.length) {
    const before = priceModels(pid, legacy.models, a.inputs, drafted, rates);
    legacyStep = plan.prices.some((p) => {
      const m = before.find((x) => x.option_id === p.option_id);
      const c = m?.result?.channels.find((x) => x.channel === p.channel);
      return !!c && c.computed_price_iqd !== p.price.computed_price_iqd;
    });
  }

  // Would the save write a price? Adoption always; an engine product when a draft moves an input or a
  // rule, a price differs from today's, or its stored figures were computed at rates that moved since.
  const pricesDiffer = rows.some((r) => r.old_iqd !== r.new_iqd);
  const storedKeys = new Set(a.storedCosts.map((s) => `${s.combo_key}@${s.channel}`));
  const costsStale =
    mode === 'engine' &&
    (!!(rates && staleReasons(a.storedCosts, rates).length) ||
      storedKeys.size !== plan.prices.length ||
      plan.prices.some((p) => {
        const s = a.storedCosts.find((x) => x.combo_key === p.combo_key && x.channel === p.channel);
        return !s || s.computed_price_iqd !== p.price.computed_price_iqd;
      }));
  const drafts = a.inputWrites.length > 0 || a.ruleWrites.length > 0;
  const needsWrite = kind === 'adopt' || (kind === 'reprice' && (drafts || pricesDiffer || costsStale || conversions.length > 0));

  const hash =
    kind && complete
      ? await sha256Hex(
          canonical({
            v: 1,
            product_id: pid,
            kind,
            state: a.stored.state ? { mode: a.stored.state.mode, inputs_seq: a.stored.state.inputs_seq, write_seq: a.stored.state.write_seq } : null,
            config_version: a.stored.config_version,
            inputs: a.stored.inputs.map((r) => [r.scope, r.scope_id, r.origin, r.version]),
            rule_versions: a.stored.rules.filter((r) => r.product_id === pid).map((r) => [r.id, r.version]),
            input_writes: a.inputWrites.map((w) => ({ scope: w.scope, scope_id: w.scope_id, set: setImage(w.set) })),
            iqd: a.iqd ?? [],
            rule_writes: a.ruleWrites.map((w) => ({ kind: w.kind, scope: w.scope, scope_id: w.scope_id, next: w.next })),
            conversions: conversions.map((c) => [c.rule.id, c.amount_usd]),
            rates: rates ? { u: rates.usd_iqd, fx: rates.fx_versions, shipping: rates.shipping_versions, pairs: rates.pair_versions } : null,
            image: a.image,
            prices: plan.prices.map((p) => [p.option_id, p.channel, p.price.computed_price_iqd]),
          })
        )
      : null;

  return {
    product_id: pid,
    mode,
    kind,
    complete,
    codes: [...codes].sort(),
    rows,
    large_change: rows.some((r) => r.large),
    drop_flag: rows.some((r) => r.drop_flag),
    legacy_step: legacyStep,
    cod_priced_as_direct: legacy.models.some((m) => m.channels.some((c) => c.ok && c.cod_as_direct)),
    review_pending: rates ? Object.values(rates.review_pending).some(Boolean) : false,
    needs_write: needsWrite,
    hash,
    plan,
    verification,
    conversions,
    rules,
    inputs: [...a.inputs],
    models,
    legacy,
    image: a.image,
    rates,
    stored: a.stored,
  };
}

/** The preview the owner reads before a price write (allowlisted, field by field). */
export function engineEvaluationDto(ev: EngineEvaluation) {
  return {
    kind: ev.kind,
    mode: ev.mode,
    complete: ev.complete,
    missing_codes: [...ev.codes],
    needs_write: ev.needs_write,
    preview_hash: ev.hash,
    large_change: ev.large_change,
    drop_flag: ev.drop_flag,
    legacy_step: ev.legacy_step,
    cod_priced_as_direct: ev.cod_priced_as_direct,
    review_pending: ev.review_pending,
    usd_iqd_rate: ev.rates?.usd_iqd ?? null,
    rows: ev.rows.map((r) => ({
      option_id: r.option_id,
      name_ar: r.name_ar,
      name_en: r.name_en,
      name_ckb: r.name_ckb,
      channel: r.channel,
      today_prepaid_iqd: r.old_iqd,
      computed_price_iqd: r.new_iqd,
      change_iqd: r.change_iqd,
      change_pct: r.change_pct,
      large: r.large,
      drop_flag: r.drop_flag,
      replacement_cost_iqd: r.replacement_cost_iqd,
      target_profit_usd: r.target_profit_usd,
      target_profit_iqd: r.target_profit_iqd,
      preorder_base_iqd: r.preorder_base_iqd,
      direct_sale_extra_iqd: r.direct_sale_extra_iqd,
      final_price_usd: r.final_price_usd,
      route_fee_removed: r.route_fee_removed,
      pro_before_iqd: r.pro_before_iqd,
      pro_after_iqd: r.pro_after_iqd,
      prime_before_iqd: r.prime_before_iqd,
      prime_after_iqd: r.prime_after_iqd,
    })),
  };
}

// ------------------------------------------------------------ the batch

/** The level a channel's supplier cost came from, and how it was entered there. */
function supplierModeOf(inputs: ReadonlyArray<Partial<StoredInputRow>>, optionId: string): 'SOURCE_CURRENCY' | 'IQD_CONVERTED' {
  const resolved = resolveSkuInputs(chainOf(inputs, optionId)).inputs.supplier;
  if (!resolved) return 'SOURCE_CURRENCY';
  const level = resolved.amount_level === 'option' ? 'option' : 'base';
  const row = inputs.find((r) => r.scope === level && r.origin === 'MANUAL_OVERRIDE' && (level === 'base' || r.scope_id === optionId));
  return row?.supplier_input_mode === 'IQD_CONVERTED' ? 'IQD_CONVERTED' : 'SOURCE_CURRENCY';
}

/** One `pricing_sku_costs` row of a planned price (0181 §6; the USD figures display and audit only). */
function skuCostRow(ev: EngineEvaluation, p: { option_id: string; combo_key: string; channel: SkuChannel; price: ChannelPrice }, now: string) {
  const rates = ev.rates!;
  const c = p.price;
  const currency = c.supplier_currency;
  const cross = currency === 'EUR' ? rates.eur_usd : currency === 'CNY' ? rates.cny_usd : null;
  const crossVersion = currency === 'EUR' ? rates.pair_versions.EUR_USD : currency === 'CNY' ? rates.pair_versions.CNY_USD : null;
  return {
    product_id: ev.product_id,
    combo_key: p.combo_key,
    channel: p.channel,
    shipping_profile: c.shipping_profile,
    supplier_amount: c.supplier_amount,
    supplier_currency: currency,
    supplier_input_mode: supplierModeOf(ev.inputs, p.option_id),
    current_supplier_cost_usd_exact: currentUsdCost({ amount: c.supplier_amount, currency }, rates.eur_usd, rates.cny_usd),
    usd_iqd_rate: rates.usd_iqd,
    usd_fx_version: rates.pair_versions.USD_IQD,
    cross_rate: cross,
    cross_fx_version: cross === null ? null : crossVersion,
    fx_rate: c.fx_rate,
    fx_version: c.fx_version,
    supplier_cost_iqd: c.supplier_cost_iqd,
    shipping_basis: c.shipping_basis,
    shipping_rate: c.shipping_rate,
    shipping_version: c.shipping_version,
    effective_weight_g: c.effective_weight_g,
    shipping_cbm: c.shipping_cbm,
    manual_cbm: c.manual_cbm,
    effective_cbm: c.effective_cbm,
    shipping_cost_iqd: c.shipping_cost_iqd,
    additional_cost_iqd: c.additional_cost_iqd,
    replacement_exact: c.replacement_exact,
    replacement_cost_iqd: c.replacement_cost_iqd,
    target_profit_iqd: c.target_profit_iqd,
    target_profit_usd: c.target_profit_usd,
    target_profit_iqd_exact: c.target_profit_iqd_exact,
    shipping_cost_usd: c.shipping_cost_usd,
    additional_cost_usd: c.additional_cost_usd,
    current_total_cost_usd: c.current_total_cost_usd,
    final_price_usd: c.final_price_usd,
    target_rule_id: c.target_rule_id,
    target_rule_version: c.target_rule_version,
    direct_sale_extra_iqd: p.channel === 'direct_sale' ? c.direct_sale_extra_iqd : null,
    extra_rule_id: p.channel === 'direct_sale' ? c.extra_rule_id : null,
    extra_rule_version: p.channel === 'direct_sale' ? c.extra_rule_version : null,
    config_version: ev.stored.config_version,
    rounding_step_iqd: c.rounding_step_iqd,
    preorder_base_iqd: c.preorder_base_iqd,
    computed_price_iqd: c.computed_price_iqd,
    computed_at: now,
  };
}

const SKU_COST_COLUMNS = [
  'product_id', 'combo_key', 'channel', 'shipping_profile', 'supplier_amount', 'supplier_currency', 'supplier_input_mode',
  'current_supplier_cost_usd_exact', 'usd_iqd_rate', 'usd_fx_version', 'cross_rate', 'cross_fx_version', 'fx_rate', 'fx_version',
  'supplier_cost_iqd', 'shipping_basis', 'shipping_rate', 'shipping_version', 'effective_weight_g', 'shipping_cbm', 'manual_cbm',
  'effective_cbm', 'shipping_cost_iqd', 'additional_cost_iqd', 'replacement_exact', 'replacement_cost_iqd', 'target_profit_iqd',
  'target_profit_usd', 'target_profit_iqd_exact', 'shipping_cost_usd', 'additional_cost_usd', 'current_total_cost_usd', 'final_price_usd',
  'target_rule_id', 'target_rule_version', 'direct_sale_extra_iqd', 'extra_rule_id', 'extra_rule_version', 'config_version',
  'rounding_step_iqd', 'preorder_base_iqd', 'computed_price_iqd', 'computed_at',
] as const;

const MEMBER_NULLS = 'prime_price_iqd = NULL, pro_price_iqd = NULL, regular_adjust_iqd = NULL, prime_adjust_iqd = NULL, pro_adjust_iqd = NULL';
const priceFrom = (table: string) => `(SELECT json_extract(j.value, '$.p') FROM json_each(?) j WHERE json_extract(j.value, '$.id') = ${table}.id)`;

/**
 * FX-5: an AUTOMATIC repricing of an engine product after a confirmed rate
 * moved (autoReprice.ts). The same plan, verification and batch as an owner
 * save — only the labels differ: `price_history.price_source` (`engine_fx`
 * when only exchange rates moved, `engine_owner` when the owner's shipping
 * rate did), the `pricing_audit` action `reprice_auto`, the `audit_log`
 * action `pricing.engine.repriced_auto`. When no customer price moves (the
 * new figures round to today's), the price rows and the history are left
 * untouched and only the stored engine figures are re-stamped.
 */
export interface AutoWrite {
  priceSource: 'engine_fx' | 'engine_owner';
  pricesUnchanged: boolean;
  trigger: string;
  /** What moved (currency or shipping profile codes) — codes only, never a rate. */
  reasons: readonly string[];
}

export interface EngineWriteOptions {
  actor: string;
  /** The audit_log actor when it differs from `actor` (null: the system, for the cron). */
  auditActor?: string | null;
  now: string;
  /** product_form | purchase | bulk | fx_auto — the audit's source. */
  source: string;
  idempotencyKey: string;
  /** The drafts' own audit rows (inputs, rules), built by the caller. */
  extraAudits?: D1PreparedStatement[];
  auditDetail?: Record<string, unknown>;
  auto?: AutoWrite;
}

export async function engineWriteStatements(db: D1Database, ev: EngineEvaluation, inputWrites: readonly InputWrite[], ruleWrites: readonly RuleWrite[], o: EngineWriteOptions): Promise<D1PreparedStatement[]> {
  if (!ev.kind || !ev.complete || !ev.rates?.usd_iqd) throw new Error('engineWriteStatements: not a complete engine write');
  const pid = ev.product_id;
  const u = ev.rates.usd_iqd;
  const adopt = ev.kind === 'adopt';
  const auto = o.auto ?? null;
  // An automatic repricing never adopts and never carries drafts: only the owner's save does.
  if (auto && (adopt || inputWrites.length || ruleWrites.length)) throw new Error('engineWriteStatements: an automatic repricing writes prices only');
  const writePrices = !auto?.pricesUnchanged;
  const auditId = newId('paud');
  const batchId = `${auto ? 'fx' : 'pe'}_${newId()}`;
  const plan = ev.plan;
  const json = (list: ReadonlyArray<{ id: string; price: number }>) => JSON.stringify(list.map((x) => ({ id: x.id, p: x.price })));
  const today = (optionId: string, channel: SkuChannel) => ev.rows.find((r) => r.option_id === optionId && r.channel === channel)?.old_iqd ?? null;
  const history = writePrices
    ? plan.prices
        .filter((p) => adopt || today(p.option_id, p.channel) !== p.price.computed_price_iqd)
        .map((p) => ({ k: skuPriceHistoryKey(p.combo_key, p.channel), o: today(p.option_id, p.channel), n: p.price.computed_price_iqd }))
    : [];
  const skuRows = plan.prices.map((p) => skuCostRow(ev, p, o.now));
  const auditActor = o.auditActor === undefined ? o.actor : o.auditActor;
  const statements: D1PreparedStatement[] = [
    ...batchHead(db, ev.stored, o.now),
    ...fence(db, 'EXISTS(SELECT 1 FROM pricing_engine_control WHERE id = 1 AND paused = 0)'),
    ...fence(db, `(${PRICE_IMAGE_SQL}) = ?`, [...imageBinds(pid), ev.image]),
    // The central rates exactly as this evaluation read them: never a rate superseded since.
    ...fence(db, RATES_FENCE_SQL, rateFenceBinds(ev.rates)),
    db.prepare('INSERT INTO ops_guards (id, ok) VALUES (?, 1)').bind(`engine-price:${pid}`),
    ...(adopt ? [db.prepare('INSERT INTO ops_guards (id, ok) VALUES (?, 1)').bind(`pricing-mode:${pid}`)] : []),
    ...inputStatements(db, pid, inputWrites, o.actor, o.now),
    ...ruleStatements(db, pid, ruleWrites, o.actor, o.now),
    ...ev.conversions.map((c) =>
      db
        .prepare(
          `UPDATE pricing_rules SET amount_usd = ?, amount_iqd = NULL, legacy_amount_iqd = ?, legacy_usd_iqd_rate = ?, version = version + 1, updated_by = ?, updated_at = ?
            WHERE id = ? AND version = ? AND source = 'LEGACY_MIGRATION' AND amount_usd IS NULL`
        )
        .bind(c.amount_usd, c.legacy_amount_iqd, c.usd_iqd_rate, o.actor, o.now, c.rule.id, c.rule.version)
    ),
    // The price rows (writer.ts), one statement per table — none when an automatic repricing moves no customer price.
    ...(writePrices
      ? [
          db
            .prepare(
              `UPDATE products SET price_iqd = ?, prime_price_iqd = NULL, pro_price_iqd = NULL, direct_surcharge_iqd = NULL,
                      preorder_transports = COALESCE(?, preorder_transports), updated_at = ? WHERE id = ?`
            )
            .bind(plan.product!.price_iqd, plan.product!.preorder_transports, o.now, pid),
        ]
      : []),
    ...(writePrices && plan.values.length
      ? [db.prepare(`UPDATE product_option_values SET regular_price_iqd = ${priceFrom('product_option_values')}, ${MEMBER_NULLS} WHERE product_id = ? AND id IN (SELECT json_extract(value, '$.id') FROM json_each(?))`).bind(json(plan.values), pid, json(plan.values))]
      : []),
    ...(writePrices && plan.cells.length
      ? [db.prepare(`UPDATE product_option_fulfillment SET regular_price_iqd = ${priceFrom('product_option_fulfillment')}, ${MEMBER_NULLS} WHERE product_id = ? AND id IN (SELECT json_extract(value, '$.id') FROM json_each(?))`).bind(json(plan.cells), pid, json(plan.cells))]
      : []),
    ...(writePrices && plan.routes.length
      ? [db.prepare(`UPDATE product_option_transports SET regular_price_iqd = ${priceFrom('product_option_transports')}, surcharge_iqd = 0, ${MEMBER_NULLS} WHERE product_id = ? AND id IN (SELECT json_extract(value, '$.id') FROM json_each(?))`).bind(json(plan.routes), pid, json(plan.routes))]
      : []),
    // Owner decision 6's observations: the engine price and the U it was computed at
    // (`engine_fx` for an automatic repricing that only exchange rates moved).
    ...(history.length
      ? [
          db
            .prepare(
              `INSERT INTO price_history (product_id, variant_key, field, old_iqd, new_iqd, changed_by, batch_id, usd_iqd_rate, price_source)
               SELECT ?, json_extract(value, '$.k'), 'regular', json_extract(value, '$.o'), json_extract(value, '$.n'), ?, ?, ?, ? FROM json_each(?)`
            )
            .bind(pid, o.actor, batchId, u, auto?.priceSource ?? 'engine_owner', JSON.stringify(history)),
        ]
      : []),
    db.prepare('DELETE FROM pricing_sku_costs WHERE product_id = ?').bind(pid),
    db
      .prepare(
        `INSERT INTO pricing_sku_costs (${SKU_COST_COLUMNS.join(', ')}, inputs_seq)
         SELECT ${SKU_COST_COLUMNS.map((k) => `json_extract(value, '$.${k}')`).join(', ')},
                (SELECT inputs_seq FROM product_pricing_state WHERE product_id = ?)
           FROM json_each(?)`
      )
      .bind(pid, JSON.stringify(skuRows)),
    db
      .prepare(
        `UPDATE product_pricing_state
            SET mode = 'engine', write_seq = write_seq + 1, priced_config_version = ?, priced_inputs_seq = inputs_seq, priced_at = ?,
                opted_in_at = CASE WHEN mode = 'manual' THEN ? ELSE opted_in_at END,
                opted_in_by = CASE WHEN mode = 'manual' THEN ? ELSE opted_in_by END,
                activation_audit_id = CASE WHEN mode = 'manual' THEN ? ELSE activation_audit_id END,
                reprice_blocked_code = NULL, reprice_blocked_at = NULL, updated_at = ?
          WHERE product_id = ?`
      )
      .bind(ev.stored.config_version, o.now, o.now, o.actor, auditId, o.now, pid),
    ...ev.conversions.map((c) =>
      pricingAuditStatement(db, {
        entity: 'rule',
        entity_key: `target_profit:${c.rule.scope}:${c.rule.scope_id}`,
        product_id: pid,
        action: 'rule_convert',
        before: { amount_iqd: c.legacy_amount_iqd, source: c.rule.source },
        after: { amount_usd: c.amount_usd, legacy_amount_iqd: c.legacy_amount_iqd, legacy_usd_iqd_rate: c.usd_iqd_rate },
        actor: o.actor,
        now: o.now,
      })
    ),
    ...(o.extraAudits ?? []),
    pricingAuditStatement(db, {
      id: auditId,
      entity: 'sku_price',
      entity_key: pid,
      product_id: pid,
      action: auto ? 'reprice_auto' : adopt ? 'engine_entry' : 'reprice_owner',
      before: ev.rows.map((r) => ({ option_id: r.option_id, channel: r.channel, price_iqd: r.old_iqd })),
      after: plan.prices.map((p) => ({
        option_id: p.option_id,
        channel: p.channel,
        price_iqd: p.price.computed_price_iqd,
        final_price_usd: p.price.final_price_usd,
        usd_iqd_rate: p.price.usd_iqd_rate,
      })),
      summary: {
        kind: ev.kind,
        source: o.source,
        rows: plan.prices.length,
        history_batch: batchId,
        conversions: ev.conversions.length,
        ...(auto ? { trigger: auto.trigger, reasons: [...auto.reasons], prices_unchanged: auto.pricesUnchanged } : {}),
      },
      idempotency_key: o.idempotencyKey,
      actor: o.actor,
      now: o.now,
    }),
    ...(
      await auditStatements(db, auditActor, auto ? 'pricing.engine.repriced_auto' : adopt ? 'pricing.engine.adopted' : 'pricing.engine.repriced', pid, {
        product_id: pid,
        rows_changed: history.length,
        entered: adopt,
        source: o.source,
        ...(auto ? { trigger: auto.trigger, reasons: [...auto.reasons] } : {}),
        ...(o.auditDetail ?? {}),
      })
    ).statements,
    ...(adopt ? [db.prepare('DELETE FROM ops_guards WHERE id = ?').bind(`pricing-mode:${pid}`)] : []),
    db.prepare('DELETE FROM ops_guards WHERE id = ?').bind(`engine-price:${pid}`),
    ...batchTail(db, pid),
  ];
  return statements;
}
