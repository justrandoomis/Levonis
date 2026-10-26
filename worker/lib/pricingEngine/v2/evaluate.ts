/**
 * PRICING V2 — ONE PRODUCT'S V2 PRICES, EVALUATED BEFORE ANY WRITE (spec §3.2;
 * docs/PRICING-V2.md §1; owner decisions A1, B1, C1, D1 and the §7 defaults,
 * DECISIONS row 221).
 *
 * `evaluateV2Write` answers, for one product with the desired V2 set laid over
 * its store (the method, the dollar price points, the pre-order discounts and,
 * cost-first, the cost inputs and the minimum profit):
 *   - every structurally sellable SKU × channel (V2 is always per SKU), priced
 *     by `priceProductV2` at the LAST CONFIRMED central rates of the versioned
 *     reader — or blocked (V2_ROUTE_BELOW_COST: the route's cost is above D);
 *   - the plan of price rows (writer.ts `planWritesFromUnits`, `v2`) and the
 *     cart's own resolver reading them back exactly (`verifyPlan`: prepaid,
 *     cash on delivery, fees 0, P ≤ D, never below for an older Worker);
 *   - old → new per SKU × channel and the 15% / 30% flags;
 *   - complete or not, and the codes and field NAMES of what is missing
 *     (grouped, never a value);
 *   - the preview hash every V2 write must carry (C-14: versions and final
 *     prices, never U, a cost or a profit — a non-owner may request a preview).
 * Writes nothing.
 *
 * PRIVATE: the rows' owner figures (R, T, the exact IQD, the floor and its
 * flags, `below_cost`) are the owner's; `dto.ts` (V2-3b) projects per role.
 */
import { priceProductV2, type V2Channel, type V2Discount, type V2Method, type V2PricePoint, type V2Result, type V2Sku } from '@levonis/pricing/priceV2';
import { resolveRuleAt } from '@levonis/pricing/ruleResolution';
import type { PricingIssue } from '@levonis/pricing/costToPrice';
import type { SkuChannel } from '@levonis/pricing/skuChannel';
import type { PricingContext } from '../../../routes/cart';
import { sha256Hex } from '../../crypto';
import { mergedInputs, mergedRules } from '../fromPurchase';
import { evaluateLegacy, unitColorId, unitComboKey, unitOptionIds, type LegacyEvaluation, type ModelToday } from '../legacy';
import { pricedAsProduct, type LoadedProduct } from '../load';
import { canonical, unitRuleTarget } from '../procurementPreview';
import type { PricingRates } from '../rates';
import { chainOfUnit, packagesOf, type InputWrite, type ProductPricingData, type RuleWrite, type StoredInputRow } from '../store';
import { planWritesFromUnits, structuralChannel, verifyPlan, type BlockedChannel, type PlannedPrice, type PricePlan, type Verification } from '../writer';
import { refuseUnreadSkus, skuTableOf, type EngineControl } from '../engineWrite';
import { discountsOf, pointsOf, type StoredV2Result, type V2Store } from './store';
import { staleReasonsV2 } from './stale';
import { shelfOfSku, shelfSignature, type ProductShelf } from './shelf';
import { emptyDirectStock } from '../stockEligibility';

/** One planned V2 price: the dinar figure every engine plan carries, and the V2 maths behind it. */
export interface V2PlanPrice {
  computed_price_iqd: number;
  v2: V2Channel;
}

export interface V2EvaluationInput {
  /** May be a DRAFT document (V2-3b: the doc and view the request would save). */
  loaded: LoadedProduct;
  stored: ProductPricingData;
  /** The stored V2 rows (`loadV2Store`); null when 0189 is not installed. */
  v2: V2Store | null;
  ctx: PricingContext;
  rates: PricingRates | null;
  control: EngineControl;
  method: V2Method;
  /** The desired sets (drafts laid over the store; the full set — absent = removed). */
  points: readonly V2PricePoint[];
  discounts: readonly V2Discount[];
  /** Cost-first only; kind `target_profit` only. */
  inputWrites: readonly InputWrite[];
  ruleWrites: readonly RuleWrite[];
  image: string;
  /** The owner's preview listed the blocked routes («متوقف: أقل من التكلفة»): they may be written as off. */
  acceptBlocked?: boolean;
  /** A digest of a draft's structure (V2-3b's product save); bound into the hash. */
  structureDigest?: string | null;
  /** FX-5: an automatic repricing (never adopts, never carries drafts). */
  auto?: true;
  /**
   * The product's shelf (`loadShelves`, DECISIONS row 244): cost-first, a SKU with units on the shelf is
   * priced from its costliest batch there. Every production caller reads it; left out (an older test
   * harness), nothing is priced from the shelf and the evaluation carries no shelf signature.
   */
  shelf?: ProductShelf | null;
  /**
   * C-14: the reader may not see a cost (a price editor). The hash then binds the cost writes laid over the
   * store (the purchase overlay's fold) by their scopes and field NAMES only — never a value — so the hash a
   * price editor receives never moves with a supplier cost alone (the prices it binds still do).
   */
  opaqueCost?: boolean;
}

/** One SKU × channel of the review sheet (the owner extras are private: `dto.ts` projects them). */
export interface V2Row {
  option_id: string;
  combo_key: string;
  option_value_ids: string[];
  color_id: string | null;
  name_ar: string;
  name_en: string;
  name_ckb: string;
  channel: SkuChannel;
  old_iqd: number | null;
  /** Null when the channel is blocked or not priced. */
  new_iqd: number | null;
  change_iqd: number | null;
  change_pct: string | null;
  large: boolean;
  drop_flag: boolean;
  blocked: boolean;
  /** Why the channel is not sold: V2_ROUTE_BELOW_COST, or the shelf's (row 244); null when it is. */
  blocked_code: BlockCode | null;
  /**
   * Price-first only: this channel's exact dollars (D_usd ± differences − Δ),
   * every term a figure the price editor typed (owner answer Q2) — never a
   * cost. Null from cost, and on a channel not priced.
   */
  usd_exact: string | null;
  owner: {
    anchor: V2Channel['anchor'];
    floor: V2Channel['floor'];
    exact_iqd: string;
    usd_ceil6: string;
    deltas_usd: string;
    discount_usd: string | null;
    discount_from: V2Channel['discount_from'];
    replacement_cost_iqd: number | null;
    target_profit_usd: string | null;
    below_cost: boolean;
    /** Q3: price-first, the direct price is below cost + minimum profit (owner-only). */
    below_min_profit: boolean;
    /** Row 244: the direct price is priced from the shelf — its costliest batch (dinars) and the units on it. */
    shelf: { cost_iqd: number; units: number } | null;
  } | null;
}

/** A channel the maths leaves unsold rather than missing (written as off): its reason. */
export type BlockCode = 'V2_ROUTE_BELOW_COST' | 'V2_ROUTE_NO_SUPPLIER' | 'V2_ROUTE_SHELF_CHEAPER' | 'V2_STOCK_SOLD_OUT';
const BLOCK_CODES: ReadonlySet<string> = new Set<BlockCode>(['V2_ROUTE_BELOW_COST', 'V2_ROUTE_NO_SUPPLIER', 'V2_ROUTE_SHELF_CHEAPER', 'V2_STOCK_SOLD_OUT']);
const EMPTY_STOCK_GAPS = new Set(['SUPPLIER_COST_MISSING', 'SUPPLIER_CURRENCY_MISSING', 'SHIPPING_PROFILE_MISSING', 'WEIGHT_MISSING', 'CBM_MISSING', 'TARGET_PROFIT_MISSING', 'V2_PRICE_MISSING']);

/** Spec §5.4: what is missing, grouped — a code, the field's NAME, the level, how many SKUs, and the first SKU's name. */
export interface GroupedMissing {
  code: string;
  field: string | null;
  level: 'product' | 'model' | 'colour' | 'sku' | null;
  count: number;
  first_name: { ar: string; en: string; ckb: string } | null;
}

export interface V2Evaluation {
  product_id: string;
  /** v2_create: the product's first V2 write (a new product, or the migration); v2_reprice: a V2 product's. */
  kind: 'v2_create' | 'v2_reprice';
  method: V2Method;
  complete: boolean;
  codes: string[];
  rows: V2Row[];
  /** The rows whose price moves (the review sheet lists ONLY these). */
  changes: V2Row[];
  large_change: boolean;
  drop_flag: boolean;
  needs_write: boolean;
  /**
   * The desired set differs from the stored one: the method, a price point, a discount, a cost input or a
   * minimum-profit rule moves. A V2-PUBLISHED product never stores such a change without a reviewed,
   * complete write (`gateV2`): an unreviewed set must not wait for FX-5 to publish it.
   */
  drafts: boolean;
  /** The SKU × channels left unsold: the floor (V2_ROUTE_BELOW_COST) and the shelf's (row 244), each with its code. */
  blocked: BlockedChannel[];
  /** Row 244: the SKUs (combo keys) a sold-out shelf with no supplier price leaves unsold («يحتاج تسعيرًا»). */
  stock_unpriced: string[];
  /**
   * Row 244: the shelf signature this evaluation priced at (`shelfSignature`; null: no batch, or price-first),
   * written with its prices; undefined when the caller read no shelf.
   */
  shelf_sig: string | null | undefined;
  /** What moved since the stored results (FX-5 reasons, codes only). */
  stale: string[];
  missing: GroupedMissing[];
  hash: string | null;
  // internal
  plan: PricePlan<V2PlanPrice>;
  verification: Verification;
  result: V2Result | null;
  legacy: LegacyEvaluation;
  image: string;
  rates: PricingRates | null;
  stored: ProductPricingData;
  v2: V2Store | null;
  points: V2PricePoint[];
  discounts: V2Discount[];
  inputs: Array<Partial<StoredInputRow>>;
  inputWrites: InputWrite[];
  ruleWrites: RuleWrite[];
  auto: boolean;
}

const pctText = (oldIqd: number, newIqd: number): string => {
  const q = ((newIqd - oldIqd) * 10_000) / oldIqd;
  const r = Math.round(Math.abs(q)) * Math.sign(q);
  return (r / 100).toFixed(2);
};

const LEVEL: Readonly<Record<string, GroupedMissing['level']>> = { base: 'product', option: 'model', color: 'colour', sku: 'sku' };

/** Spec §5.4: one entry per (code, field, level), counted over SKUs, with the first SKU's name. Codes and names only. */
function groupMissing(units: readonly ModelToday[], result: V2Result | null, extra: readonly string[]): GroupedMissing[] {
  const out = new Map<string, GroupedMissing>();
  const add = (i: Pick<PricingIssue, 'code' | 'field' | 'level'>, unit: ModelToday | null) => {
    const level = i.level ? (LEVEL[i.level] ?? null) : null;
    const field = i.field ?? null;
    const key = `${i.code}\u0000${field ?? ''}\u0000${level ?? ''}`;
    const at = out.get(key);
    const name = unit ? { ar: unit.names?.name_ar ?? '', en: unit.names?.name_en ?? '', ckb: unit.names?.name_ckb ?? '' } : null;
    if (at) at.count += unit ? 1 : 0;
    else out.set(key, { code: i.code, field, level, count: unit ? 1 : 0, first_name: name });
  };
  if (result) {
    for (const i of result.issues) if (i.severity === 'error') add(i, null);
    result.skus.forEach((s, n) => {
      const unit = units[n] ?? null;
      const seen = new Set<string>();
      for (const i of s.issues) {
        if (i.severity !== 'error' || BLOCK_CODES.has(i.code)) continue;
        const k = `${i.code}\u0000${i.field ?? ''}\u0000${i.level ?? ''}`;
        if (seen.has(k)) continue;
        seen.add(k);
        add(i, unit);
      }
    });
  }
  for (const code of extra) if (![...out.values()].some((m) => m.code === code)) add({ code: code as PricingIssue['code'] }, null);
  // A consequence is not a separate gap (review 2026-10-14): «السعر المحسوب غير صالح» (PRICE_INVALID) only says
  // some channel has no price — the inputs named beside it say why. It stands alone only when nothing else does.
  const all = [...out.values()];
  const causes = all.filter((m) => !CONSEQUENCE_CODES.has(m.code));
  return causes.length ? causes : all;
}

/** Plan codes that only restate that a price is missing (the missing input beside them is the gap). */
const CONSEQUENCE_CODES: ReadonlySet<string> = new Set(['PRICE_INVALID']);

/** The desired set equals the stored rows (ignoring order and versions). */
const sameSet = (a: ReadonlyArray<Record<string, string>>, b: ReadonlyArray<Record<string, string>>): boolean =>
  canonical([...a].map((x) => canonical(x)).sort()) === canonical([...b].map((x) => canonical(x)).sort());

export async function evaluateV2Write(a: V2EvaluationInput): Promise<V2Evaluation> {
  // 1. Never on a failed read of the SKU rung (FX-7 gaps): the writer replaces those rows.
  // A bundle or a mystery box is priced as an ordinary product (DECISIONS row 251): one SKU, sold direct.
  const loaded = pricedAsProduct(a.loaded);
  refuseUnreadSkus(loaded);
  const pid = loaded.id;
  const rates = a.rates;
  const u = rates?.usd_iqd ?? null;
  const storedMethod = a.stored.state?.mode === 'engine' ? (a.stored.state.pricing_method ?? null) : null;
  const kind: V2Evaluation['kind'] = storedMethod ? 'v2_reprice' : 'v2_create';
  const inputs = mergedInputs(a.stored.inputs, a.inputWrites);
  const rules = mergedRules(a.stored, a.ruleWrites);
  const codes = new Set<string>();
  if (!rates || !u) codes.add('FX_RATE_MISSING');
  if (rates?.derived_stale) codes.add('FX_DERIVED_STALE');
  if (a.control.paused) codes.add('PRICING_ENGINE_PAUSED');
  if (a.v2 === null) codes.add('PRICING_NOT_INSTALLED');
  const skuTable = skuTableOf(loaded);
  if (!skuTable) codes.add('PRICE_SHAPE_UNSUPPORTED');

  // 2. The units: every sellable SKU (V2 is always per SKU), and its structural channels.
  const legacy = evaluateLegacy(pid, loaded.doc, loaded.view, a.ctx, { perSku: true });
  const units = legacy.units;
  // 3. The SKUs of the V2 maths: their chain (cost inputs, optional price-first) and T (required
  //    cost-first; price-first only for the owner's below-minimum-profit warning, Q3).
  // The model's and the colour's own packaged weight and box are their freight measure in every mode (row 247,
  // the owner 2026-10-18) — read from the document priced (the draft's on a preview), never a second store.
  const packagesOfUnit = packagesOf(a.loaded.doc);
  const skus: V2Sku[] = units.map((unit) => {
    const ids = unitOptionIds(unit);
    const colorId = unitColorId(unit);
    const combo = unitComboKey(unit);
    const packaged = packagesOfUnit(ids, colorId);
    return {
      combo_key: combo,
      model_id: ids[0] ?? null,
      option_value_ids: ids,
      color_id: colorId,
      channels: unit.channels.filter(structuralChannel).map((c) => c.channel),
      chain: chainOfUnit(inputs, { option_value_ids: ids, color_id: colorId, combo_key: combo || null, packaged }),
      target: resolveRuleAt(rules, 'target_profit', unitRuleTarget(pid, { option_value_ids: ids, color_id: colorId }), { usdIqdRate: u }),
      // Row 244: cost-first, the direct sale of a SKU with stock is priced from its costliest batch on the shelf —
      // in dollars at today's U (row 249; a batch with no purchase rate in dinars as paid).
      shelf: a.method === 'cost' ? shelfOfSku(a.shelf, { option_value_ids: ids, color_id: colorId, combo_key: combo }, u) : null,
    };
  });

  // 4. The maths (exact; codes for what is missing, never a guess).
  let result: V2Result | null = null;
  if (rates && u && units.length) {
    result = priceProductV2({ method: a.method, rates: rates.central, points: a.points, discounts: a.discounts, skus });
  }

  // 5. The planned prices, and the blocked channels.
  const prices: PlannedPrice<V2PlanPrice>[] = [];
  const blocked: BlockedChannel[] = [];
  if (result) {
    for (const i of result.issues) if (i.severity === 'error') codes.add(i.code);
    result.skus.forEach((s, n) => {
      const unit = units[n]!;
      const sku = skus[n]!;
      // Received, priced choices can publish while another direct-only choice
      // has zero physical stock and no pricing inputs. Its channel is explicitly
      // written OFF, so neither the cart nor a legacy fallback can sell it.
      const missing = s.issues.filter((i) => i.severity === 'error');
      if (!s.channels.length && missing.length && missing.every((i) => EMPTY_STOCK_GAPS.has(i.code)) &&
        emptyDirectStock(loaded.doc, loaded.view, { option_value_ids: sku.option_value_ids, color_id: sku.color_id }, sku.channels)) {
        blocked.push({ option_id: unit.option_id, combo_key: sku.combo_key, channel: 'direct_sale', code: 'V2_STOCK_SOLD_OUT' });
        return;
      }
      for (const channel of sku.channels) {
        const priced = s.channels.find((c) => c.channel === channel);
        if (priced) {
          prices.push({ option_id: unit.option_id, combo_key: sku.combo_key, channel, price: { computed_price_iqd: priced.price_iqd, v2: priced }, option_value_ids: [...sku.option_value_ids], color_id: sku.color_id });
          continue;
        }
        const errors = s.issues.filter((i) => i.severity === 'error' && (!i.channel || i.channel === channel));
        if (errors.length && errors.every((i) => BLOCK_CODES.has(i.code))) blocked.push({ option_id: unit.option_id, combo_key: sku.combo_key, channel, code: errors[0]!.code as BlockCode });
        else for (const i of errors.length ? errors : [{ code: 'V2_PRICE_MISSING' } as const]) codes.add(i.code);
      }
    });
  }

  // 6. The plan and the cart's own resolver reading it back. A blocked channel is written only when the
  //    owner's preview listed it — or when it was already blocked at the last write (no stored result: the
  //    owner accepted it then), so a product with a route blocked for some SKUs still follows the rates.
  //    A channel the last write PRICED and the maths now blocks is never written silently (FX-5 holds it).
  const stored = a.v2;
  const storedResults: readonly StoredV2Result[] = stored?.results ?? [];
  const storedKeys = new Set(storedResults.map((r) => `${r.combo_key}@${r.channel}`));
  // Row 244: a channel the shelf leaves unsold (a route with no supplier price, or one the shelf undersells, while
  // the shelf sells; a sold-out SKU with nothing to price it from) is the owner's standing decision — written as
  // off without a preview, its route row left on (it comes back by itself when the shelf moves).
  const costBlocked = blocked.filter((b) => b.code === 'V2_ROUTE_BELOW_COST');
  const alreadyBlocked = kind === 'v2_reprice' && costBlocked.every((b) => !storedKeys.has(`${b.combo_key}@${b.channel}`));
  const stockUnpriced = [...new Set(blocked.filter((b) => b.code === 'V2_STOCK_SOLD_OUT').map((b) => b.combo_key))];
  // Nothing left to sell because every SKU is sold out without a supplier price: the product needs pricing.
  if (!prices.length && stockUnpriced.length) codes.add('V2_STOCK_SOLD_OUT');
  const plan = planWritesFromUnits(
    loaded,
    legacy,
    prices,
    { skuTable, v2: { blocked, acceptBlocked: a.acceptBlocked === true || alreadyBlocked || costBlocked.length === 0 } },
    codes
  );
  for (const c of plan.codes) codes.add(c);
  const verification: Verification = codes.size ? { ok: false, mismatches: [], rows: [] } : verifyPlan(loaded, legacy, plan, a.ctx);
  if (!codes.size && !verification.ok) codes.add('RESOLVER_MISMATCH');
  const complete = codes.size === 0;

  // 7. Old → new per SKU × channel (every structural channel; a blocked one has no new price).
  const rows: V2Row[] = [];
  const large = (o: number | null, n: number | null) => (o && n !== null ? Math.abs(n - o) * 100 > a.control.large_change_pct * o : false);
  const drop = (o: number | null, n: number | null) => (o && n !== null ? (o - n) * 100 > a.control.max_drop_pct * o : false);
  units.forEach((unit, n) => {
    const sku = skus[n]!;
    for (const channel of sku.channels) {
      const today = unit.channels.find((c) => c.channel === channel) ?? null;
      // The clean start (DECISIONS row 222, addendum A.7): a product's FIRST V2 write starts from nothing.
      // An old dinar price is never shown beside it, never moves a 15% / 30% gate and never seeds a row.
      const oldIqd = kind === 'v2_create' || !storedResults.length ? null : today?.ok ? today.prepaid_iqd : null;
      const p = prices.find((x) => x.combo_key === sku.combo_key && x.channel === channel) ?? null;
      const newIqd = p ? p.price.computed_price_iqd : null;
      const c = p?.price.v2 ?? null;
      rows.push({
        option_id: unit.option_id,
        combo_key: sku.combo_key,
        option_value_ids: [...sku.option_value_ids],
        color_id: sku.color_id,
        name_ar: unit.names?.name_ar ?? unit.option?.name_ar ?? '',
        name_en: unit.names?.name_en ?? unit.option?.name_en ?? '',
        name_ckb: unit.names?.name_ckb ?? unit.option?.name_ckb ?? '',
        channel,
        old_iqd: oldIqd,
        new_iqd: newIqd,
        change_iqd: oldIqd === null || newIqd === null ? null : newIqd - oldIqd,
        change_pct: oldIqd && newIqd !== null ? pctText(oldIqd, newIqd) : null,
        large: large(oldIqd, newIqd),
        drop_flag: drop(oldIqd, newIqd),
        blocked: blocked.some((b) => b.combo_key === sku.combo_key && b.channel === channel),
        blocked_code: (blocked.find((b) => b.combo_key === sku.combo_key && b.channel === channel)?.code as BlockCode | undefined) ?? null,
        usd_exact: a.method === 'usd' ? (c?.usd_exact ?? null) : null,
        owner: c
          ? {
              anchor: c.anchor,
              floor: c.floor,
              exact_iqd: c.exact_iqd,
              usd_ceil6: c.usd_ceil6,
              deltas_usd: c.deltas_usd,
              discount_usd: c.discount_usd,
              discount_from: c.discount_from,
              replacement_cost_iqd: c.replacement?.replacement_cost_iqd ?? c.shelf?.cost_iqd ?? null,
              target_profit_usd: c.target_profit_usd,
              below_cost: c.below_cost,
              below_min_profit: c.below_min_profit,
              shelf: c.shelf ? { cost_iqd: c.shelf.cost_iqd, units: c.shelf.units } : null,
            }
          : null,
      });
    }
  });
  const changes = rows.filter((r) => r.old_iqd !== r.new_iqd);

  // 8. Would a write change anything? A create always; else a draft, a moved price, a stale or missing stored result.
  const stale = rates && kind === 'v2_reprice' ? staleReasonsV2(storedResults, rates) : [];
  const drafts =
    a.method !== storedMethod ||
    a.inputWrites.length > 0 ||
    a.ruleWrites.length > 0 ||
    !sameSet(pointsOf(stored?.points ?? []).map((p) => ({ ...p })), a.points.map((p) => ({ scope: p.scope, scope_id: p.scope_id, kind: p.kind, usd: p.usd }))) ||
    !sameSet(discountsOf(stored?.discounts ?? []).map((d) => ({ ...d })), a.discounts.map((d) => ({ scope: d.scope, scope_id: d.scope_id, usd: d.usd })));
  const resultsDiffer =
    storedKeys.size !== plan.prices.length ||
    plan.prices.some((p) => {
      const s = storedResults.find((x) => x.combo_key === p.combo_key && x.channel === p.channel);
      return !s || s.final_price_iqd !== p.price.computed_price_iqd || s.exact_iqd !== p.price.v2.exact_iqd;
    });
  const pricesDiffer = changes.length > 0;
  const needsWrite = kind === 'v2_create' || drafts || pricesDiffer || stale.length > 0 || resultsDiffer;

  // 9. The hash (C-14): versions, the image, the structure, the desired set and the planned FINAL prices — never U, R or T.
  const hash = complete
    ? await sha256Hex(
        canonical({
          v: 'v2',
          product_id: pid,
          kind,
          state: a.stored.state ? { inputs_seq: a.stored.state.inputs_seq, write_seq: a.stored.state.write_seq, method: storedMethod } : null,
          config_version: a.stored.config_version,
          rate_versions: rates ? { pairs: rates.pair_versions, fx: rates.fx_versions, shipping: rates.shipping_versions } : null,
          image: await sha256Hex(a.image),
          structure: a.structureDigest ?? null,
          method: a.method,
          points: [...a.points].map((p) => [p.scope, p.scope_id, p.kind, p.usd]).sort(),
          discounts: [...a.discounts].map((d) => [d.scope, d.scope_id, d.usd]).sort(),
          input_writes: a.opaqueCost
            ? a.inputWrites.map((w) => ({ scope: w.scope, scope_id: w.scope_id, fields: Object.keys(w.set).sort() }))
            : a.inputWrites.map((w) => ({ scope: w.scope, scope_id: w.scope_id, set: w.set })),
          rule_writes: a.ruleWrites.map((w) => ({ kind: w.kind, scope: w.scope, scope_id: w.scope_id, next: w.next })),
          blocked: blocked.map((b) => [b.combo_key, b.channel]),
          accept_blocked: a.acceptBlocked === true,
          prices: plan.prices.map((p) => [p.combo_key, p.channel, p.price.computed_price_iqd]),
        })
      )
    : null;

  const extra = [...codes].filter((c) => !result || ![...result.issues, ...result.skus.flatMap((s) => s.issues)].some((i) => i.code === c));
  return {
    product_id: pid,
    kind,
    method: a.method,
    complete,
    codes: [...codes].sort(),
    rows,
    changes,
    large_change: rows.some((r) => r.large),
    drop_flag: rows.some((r) => r.drop_flag),
    needs_write: needsWrite,
    drafts,
    blocked,
    stock_unpriced: stockUnpriced,
    shelf_sig: a.shelf === undefined ? undefined : a.method === 'cost' ? await shelfSignature(a.shelf) : null,
    stale,
    missing: complete ? [] : groupMissing(units, result, extra),
    hash,
    plan,
    verification,
    result,
    legacy,
    image: a.image,
    rates,
    stored: a.stored,
    v2: a.v2,
    points: [...a.points],
    discounts: [...a.discounts],
    inputs,
    inputWrites: [...a.inputWrites],
    ruleWrites: [...a.ruleWrites],
    auto: a.auto === true,
  };
}

/** The stored V2 set of a product, as the desired set of an evaluation that changes nothing (FX-5, the stale list). */
export function storedDesired(v2: V2Store | null): { points: V2PricePoint[]; discounts: V2Discount[] } {
  return { points: pointsOf(v2?.points ?? []), discounts: discountsOf(v2?.discounts ?? []) };
}
