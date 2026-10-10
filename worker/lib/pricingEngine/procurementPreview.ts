/**
 * THE PROCUREMENT CARD'S PRICING: the 4-cell summary of every line, its
 * «تفاصيل», and the review step's per-product preview (USD design §5, §6.3;
 * owner brief 2026-10-09 §6-§7). Read only.
 *
 * Every figure is E1's (`priceSku`) on the product's stored inputs and rules
 * with this purchase's derived values and the owner's typed minimum profits
 * laid over them, at the CENTRAL rates of the versioned reader (never the
 * document's own rates — note N1). The client formats; it never computes money.
 *
 * The bar's four cells (BRIEF §6):
 *   1. التكلفة النهائية      K = R_exact ÷ U, whole cents half-up;
 *   2. الحد الأدنى للربح     T, the deciding minimum profit (USD; a migrated dinar
 *                            amount is shown at U, half-up);
 *   3. السعر النهائي بالدولار F = cell 1 + cell 2, in cents, exactly;
 *   4. السعر النهائي للزبون   ceil_1000(R_exact + T × U) on the bar's profile.
 * The bar's profile: the product's default shipping profile (the direct-sale
 * base), else the one proposed from this line's route, else the model's first
 * pre-order route, else blocked with E1's missing-profile code.
 * «تفاصيل» rows 4, 7 and 8 (supplier, shipping, extras in USD) are cents
 * allocated by largest remainder so they add up to row 9 (= cell 1).
 *
 * THE PREVIEW HASH covers what an apply would write and what it was computed
 * from: the derived inputs and rules, the toggles, the product's state and
 * stored versions, config_version, the rate and shipping versions, and today's
 * prices. `apply-purchase` recomputes it from the COMMITTED purchase; a
 * mismatch is PRICING_PREVIEW_STALE.
 */
import { directPurchaseStore } from './directPurchase';
import { priceSku, resolveSkuInputs, ROUNDING_STEP_IQD, type ChannelPrice, type PricingIssue } from '@levonis/pricing/costToPrice';
import { resolveRuleAt, type PricingRuleRow, type RuleTarget } from '@levonis/pricing/ruleResolution';
import { channelOfRoute, ROUTE_PROFILE, PREORDER_ROUTES, type PreorderRoute, type ShippingProfile, type SkuChannel } from '@levonis/pricing/skuChannel';
import { procurementExact, quotientProcurementExact, ceilProcurementExact, type ProcurementExact } from '@levonis/contracts/procurementCost';
import { sameRate } from '@levonis/pricing/fxChain';
import { sha256Hex } from '../crypto';
import type { PricingContext } from '../../routes/cart';
import { evaluateLegacy, skuLevelScopeIds, unitColorId, unitComboKey, unitOptionIds, type ModelToday } from './legacy';
import { ruleTargetOf } from './compute';
import type { LoadedProduct } from './load';
import type { PricingRates } from './rates';
import { chainOf, chainOfUnit, INPUT_FIELD_NAMES, type InputFields, type InputScope, type ProductPricingData, type RuleWrite, type StoredInputRow } from './store';
import {
  deriveProductEntries,
  directSaleExtraWrites,
  lineFeeds,
  mergedInputs,
  mergedRules,
  minimumProfitWrites,
  pricingScopeOf,
  purchaseIneligibility,
  skuLevelOf,
  type DerivedProduct,
  type DirectSaleExtraDraft,
  type MinimumProfitDraft,
  type PurchaseForPricing,
  type PurchaseLineForPricing,
  type PurchaseSkuLevels,
} from './fromPurchase';

/**
 * FX-7 gaps: the colour and SKU levels a purchase's colour and variant lines
 * may feed — only with the SKU rung (0183) read for this product; otherwise
 * undefined, and every line feeds its broader scope alone, as before. (A failed
 * read of the rung never gets here: the engine evaluation refuses it first.)
 */
export function purchaseSkuLevels(loaded: LoadedProduct): PurchaseSkuLevels | undefined {
  if (!Array.isArray(loaded.view?.sku_prices)) return undefined;
  const { color, sku, units } = skuLevelScopeIds(loaded.doc, loaded.view);
  return {
    color,
    sku,
    variants: new Map((loaded.view?.variants ?? []).map((v) => [v.id, v.combo_key] as const)),
    units: units.map((u) => ({ option_value_ids: u.option_value_ids, color_id: u.color?.id ?? null, combo_key: u.combo_key })),
  };
}

export interface PreviewOptions {
  /** The owner's typed minimum profits, per product (absent = untouched). */
  minimum_profits: ReadonlyMap<string, readonly MinimumProfitDraft[]>;
  /**
   * The owner's typed Direct Sale Extras, per product (absent = untouched;
   * owner request 2026-10-10: the review of a stock purchase asks for the one
   * input the direct price lacks). They join the rule writes, so the engine
   * evaluation, the bar, the preview hash and the apply's idempotency key all
   * see them — no stale apply can write a different extra.
   */
  direct_sale_extras?: ReadonlyMap<string, readonly DirectSaleExtraDraft[]>;
  /** Selection keys of the manual lines the owner ticked. */
  opt_in: ReadonlySet<string>;
  /** «استعمل هذا الشراء لتسعير هذا المنتج»: false skips the product's purchase values. */
  use_purchase: ReadonlyMap<string, boolean>;
  /** «استعمل قيمة هذا الشراء حتى لو كانت أقل من الحالية». */
  prefer: ReadonlyMap<string, boolean>;
}

const PROFILE_ROUTE: Readonly<Record<ShippingProfile, PreorderRoute>> = { CHINA_AIR: 'air', CHINA_SEA: 'sea', GERMANY_LAND: 'land' };

// ------------------------------------------------------------ cents

/** Whole cents of a non-negative exact USD amount, half-up. */
function halfUpCents(usd: ProcurementExact): number {
  const n = usd.num * 100n;
  return Number((2n * n + usd.den) / (2n * usd.den));
}

/** Largest-remainder cents of parts (in exact cents) that sum to `total` cents. */
function allocateCents(parts: readonly ProcurementExact[], total: number): number[] {
  const floors = parts.map((p) => Number(p.num / p.den));
  const rest = parts.map((p, i) => ({ i, rem: { num: p.num - BigInt(floors[i]!) * p.den, den: p.den } }));
  let left = total - floors.reduce((a, b) => a + b, 0);
  rest.sort((a, b) => {
    const l = a.rem.num * b.rem.den;
    const r = b.rem.num * a.rem.den;
    return l === r ? a.i - b.i : l > r ? -1 : 1;
  });
  const out = [...floors];
  for (const r of rest) {
    if (left <= 0) break;
    out[r.i]! += 1;
    left -= 1;
  }
  return out;
}

const toCents = (iqdExact: ProcurementExact, u: ProcurementExact) => {
  const usd = quotientProcurementExact(iqdExact, u);
  return { num: usd.num * 100n, den: usd.den };
};

// ------------------------------------------------------------ the bar

export interface LineSummary {
  state: 'ok' | 'blocked';
  issue_codes: string[];
  shipping_profile: ShippingProfile | null;
  profile_source: 'default' | 'proposed' | 'first_route' | null;
  engine_priced: boolean;
  /** The bar's model sells direct today (an enabled direct-sale cell): the card leads with its direct price. */
  sells_direct: boolean;
  /** The model the bar prices ('' = the product itself). */
  option_id: string;
  rule_level: string | null;
  minimum_target_profit_usd: string | null;
  target_profit_iqd: number | null;
  target_profit_cents: number | null;
  current_total_cost_cents: number | null;
  final_price_cents: number | null;
  preorder_base_iqd: number | null;
  direct_sale_extra_iqd: number | null;
  direct_sale_price_iqd: number | null;
  rounding_added_iqd: number | null;
  supplier_original_amount: string | null;
  supplier_original_currency: string | null;
  iqd_converted: { original_input_amount: string; conversion_rate_snapshot: string; converted_at: string | null } | null;
  cross_rate: string | null;
  supplier_cost_usd: string | null;
  supplier_cost_cents: number | null;
  basis: 'weight' | 'volume' | null;
  effective_weight_g: number | null;
  effective_cbm: string | null;
  shipping_rate: string | null;
  shipping_cost_iqd: number | null;
  shipping_cost_usd: string | null;
  shipping_cost_cents: number | null;
  additional_cost_iqd: number | null;
  additional_cost_usd: string | null;
  additional_cost_cents: number | null;
  excluded_charges: string[];
  current_total_cost_usd: string | null;
  final_price_usd: string | null;
  usd_iqd_rate: string | null;
  /** The document's own rate when it differs from the central one (N1). */
  document_rate: string | null;
  store_price_iqd: number | null;
}

const emptySummary = (): LineSummary => ({
  state: 'blocked',
  issue_codes: [],
  shipping_profile: null,
  profile_source: null,
  engine_priced: false,
  sells_direct: false,
  option_id: '',
  rule_level: null,
  minimum_target_profit_usd: null,
  target_profit_iqd: null,
  target_profit_cents: null,
  current_total_cost_cents: null,
  final_price_cents: null,
  preorder_base_iqd: null,
  direct_sale_extra_iqd: null,
  direct_sale_price_iqd: null,
  rounding_added_iqd: null,
  supplier_original_amount: null,
  supplier_original_currency: null,
  iqd_converted: null,
  cross_rate: null,
  supplier_cost_usd: null,
  supplier_cost_cents: null,
  basis: null,
  effective_weight_g: null,
  effective_cbm: null,
  shipping_rate: null,
  shipping_cost_iqd: null,
  shipping_cost_usd: null,
  shipping_cost_cents: null,
  additional_cost_iqd: null,
  additional_cost_usd: null,
  additional_cost_cents: null,
  excluded_charges: [],
  current_total_cost_usd: null,
  final_price_usd: null,
  usd_iqd_rate: null,
  document_rate: null,
  store_price_iqd: null,
});

const uniqueCodes = (issues: readonly PricingIssue[]) => [...new Set(issues.filter((i) => i.severity === 'error').map((i) => i.code))].sort();

/** One product, evaluated for the card and the review step. */
export interface ProductPreview {
  product_id: string;
  label: string;
  mode: 'manual' | 'engine';
  feeds: boolean;
  eligible: boolean;
  reason: 'status' | 'estimated' | 'no_lines' | null;
  use_purchase: boolean;
  prefer_purchase_values: boolean;
  preview_hash: string;
  derived_hash: string;
  derived: DerivedProduct;
  rule_writes: RuleWrite[];
  models: Array<{
    option_id: string;
    names: { name_ar: string; name_en: string; name_ckb: string };
    channels: ModelToday['channels'];
    result: ReturnType<typeof priceSku> | null;
    /** FX-7: the unit's key, whole selection and colour (a model: its own key, `[option_id]`, null). */
    combo_key: string;
    option_value_ids: string[];
    color_id: string | null;
  }>;
  missing_codes: string[];
  cod_as_direct: boolean;
  /**
   * Today's Direct Sale Extra per model that sells direct, where the old prices
   * give one clean answer (P1's answer B: `MIGRATED`, on the 1,000 step) — the
   * review's «زيادة البيع المباشر الحالية» button. A suggestion, never written
   * unless the owner presses it.
   */
  extra_suggestions: Array<{ option_id: string; value_iqd: number }>;
}

interface ProductInput {
  loaded: LoadedProduct;
  stored: ProductPricingData;
}

/** Canonical JSON (keys sorted, undefined dropped): the basis of every preview hash. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

const setImage = (set: Partial<InputFields>) => Object.fromEntries(INPUT_FIELD_NAMES.filter((k) => k in set).map((k) => [k, set[k] ?? null]));

/** Evaluate one product of the purchase (derived entries, merged store, E1 per model × channel, the hashes). */
export async function previewProduct(p: PurchaseForPricing, input: ProductInput, ctx: PricingContext, rates: PricingRates | null, opts: PreviewOptions): Promise<ProductPreview> {
  const pid = input.loaded.id;
  const stored = directPurchaseStore(input.stored);
  const usePurchase = opts.use_purchase.get(pid) !== false;
  const prefer = opts.prefer.get(pid) === true;
  const productLines = p.lines.filter((l) => l.product_id === pid);
  const optIn = new Set([...opts.opt_in].filter((k) => productLines.some((l) => l.key === k)));
  const derived = deriveProductEntries(p, pid, stored, { optIn, prefer, usePurchase, rates, levels: purchaseSkuLevels(input.loaded) });
  const ruleWrites = [
    ...minimumProfitWrites(pid, opts.minimum_profits.get(pid) ?? [], stored),
    ...directSaleExtraWrites(pid, opts.direct_sale_extras?.get(pid) ?? [], stored),
  ];
  const inputs = mergedInputs(stored.inputs, derived.entries.map((e) => e.write));
  const rules: PricingRuleRow[] = mergedRules(stored, ruleWrites);
  const legacy = evaluateLegacy(pid, input.loaded.doc, input.loaded.view, ctx);
  const models = priceModels(pid, legacy.models.map((m) => ({ ...m, channels: m.channels.filter((c) => c.channel === 'direct_sale') })), inputs, rules, rates);
  const direct = new Set(legacy.models.filter((m) => m.channels.some((c) => c.ok && c.channel === 'direct_sale')).map((m) => m.option_id));
  const extraSuggestions = legacy.legacy.models
    .filter((m) => direct.has(m.option_id) && m.extra.state === 'MIGRATED' && typeof m.extra.value_iqd === 'number' && m.extra.value_iqd >= 0 && m.extra.value_iqd % ROUNDING_STEP_IQD === 0)
    .map((m) => ({ option_id: m.option_id, value_iqd: m.extra.value_iqd as number }));
  const missing = rates ? [...new Set(models.flatMap((m) => (m.result ? uniqueCodes(m.result.issues) : [])))].sort() : ['FX_RATE_MISSING'];
  const hasDirect = models.some((m) => m.channels.some((c) => c.ok && c.channel === 'direct_sale'));
  const feeds = hasDirect && productLines.some((l) => lineFeeds(p, l, optIn));
  if (!hasDirect) { derived.entries = []; ruleWrites.length = 0; }
  const reason = purchaseIneligibility({ status: p.status, cost_state: p.cost_state, lines: productLines });
  const toggles = { use_purchase: usePurchase, prefer, opt_in: [...optIn].sort() };
  // What this purchase and the owner's choices say, independent of what is stored: a replay of the
  // same apply has the same key even after the first one moved the store (USD design §6.4).
  const derivedBasis = {
    channel: 'direct_sale',
    route: p.profile?.id ?? null,
    currency: p.currency,
    raw: derived.raw,
    rules: ruleWrites.map((w) => ({ kind: w.kind, scope: w.scope, scope_id: w.scope_id, next: w.next })),
    toggles,
  };
  const basis = {
    v: 2,
    direct_purchase_version: input.stored.direct_purchase?.version ?? null,
    product_id: pid,
    ...derivedBasis,
    entries: derived.entries.map((e) => ({ scope: e.write.scope, scope_id: e.write.scope_id, set: setImage(e.write.set), kept: [...e.kept_higher].sort() })),
    state: stored.state ? { mode: stored.state.mode, inputs_seq: stored.state.inputs_seq, write_seq: stored.state.write_seq } : null,
    config_version: stored.config_version,
    inputs: stored.inputs.map((r) => [r.scope, r.scope_id, r.origin, r.version]),
    rule_versions: stored.rules.filter((r) => r.product_id === pid).map((r) => [r.id, r.version]),
    rates: rates ? { fx: rates.fx_versions, shipping: rates.shipping_versions, pairs: rates.pair_versions, stale: rates.derived_stale } : null,
    today: legacy.models.map((m) => m.channels.map((c) => [m.option_id, c.channel, c.ok, c.prepaid_iqd, c.cod_iqd])),
  };
  return {
    product_id: pid,
    label: String(input.loaded.doc.name_ar || input.loaded.doc.name_en || pid),
    mode: stored.state?.mode === 'engine' ? 'engine' : 'manual',
    feeds,
    eligible: reason === null && feeds,
    reason,
    use_purchase: usePurchase,
    prefer_purchase_values: prefer,
    preview_hash: await sha256Hex(canonical(basis)),
    derived_hash: await sha256Hex(canonical(derivedBasis)),
    derived,
    rule_writes: ruleWrites,
    models,
    missing_codes: missing,
    cod_as_direct: legacy.models.some((m) => m.channels.some((c) => c.ok && c.cod_as_direct)),
    extra_suggestions: extraSuggestions,
  };
}

/** One model priced by E1 on every channel it sells today (the six decision-8 figures come from here). */
export type PricedModel = ProductPreview['models'][number];

/**
 * Every model of a product priced by E1 on each channel it sells today, from
 * the inputs and rules given (stored, or with drafts laid over) at the
 * versioned reader's central rates — the procurement review and the product
 * form's «المعاينة والحفظ» alike. Read only.
 */
export function priceModels(
  productId: string,
  models: readonly ModelToday[],
  inputs: ReadonlyArray<Partial<StoredInputRow>>,
  rules: readonly PricingRuleRow[],
  rates: PricingRates | null,
  direct?: Pick<ProductPricingData, 'inputs' | 'rules'>
): PricedModel[] {
  const u = rates?.usd_iqd ?? null;
  return models.map((m) => {
    const channels = m.channels.filter((c) => c.ok).map((c) => c.channel);
    const unit = { combo_key: unitComboKey(m), option_value_ids: unitOptionIds(m), color_id: unitColorId(m) };
    const names = m.names ?? namesOf(m.option);
    if (!rates || !channels.length) return { option_id: m.option_id, names, channels: m.channels, result: null, ...unit };
    // A SKU (FX-7) resolves over every level of its selection; a model over the product and itself.
    const isSku = m.combo_key !== undefined;
    const at = isSku ? unitRuleTarget(productId, unit) : ruleTargetOf(productId, m.option_id);
    const run = (channels: SkuChannel[], inputRows: ReadonlyArray<Partial<StoredInputRow>>, ruleRows: readonly PricingRuleRow[]) => priceSku({
      chain: isSku ? chainOfUnit(inputRows, unit) : chainOf(inputRows, m.option_id),
      rates: rates.central,
      channels,
      target: resolveRuleAt(ruleRows, 'target_profit', at, { usdIqdRate: u }),
      extra: channels.includes('direct_sale') ? resolveRuleAt(ruleRows, 'direct_sale_extra', at) : null,
    });
    const result = run(direct ? channels.filter((c) => c !== 'direct_sale') : channels, inputs, rules);
    if (direct && channels.includes('direct_sale')) {
      const stock = run(['direct_sale'], direct.inputs, direct.rules);
      result.channels.push(...stock.channels);
      result.issues.push(...stock.issues);
      result.ok = result.ok && stock.ok;
      if (channels.length === 1) result.inputs = stock.inputs;
    }
    return { option_id: m.option_id, names, channels: m.channels, result, ...unit };
  });
}

/** Where a SKU's rules are resolved (FX-7): its whole selection and its colour — product → option → colour → SKU. */
export function unitRuleTarget(productId: string, unit: { option_value_ids: readonly string[]; color_id: string | null }): RuleTarget {
  return { product_id: productId, option_value_ids: [...unit.option_value_ids], color_id: unit.color_id, ancestry: [] };
}

function namesOf(option: { name_ar?: string; name_en?: string; name_ckb?: string } | null) {
  return { name_ar: option?.name_ar ?? '', name_en: option?.name_en ?? '', name_ckb: option?.name_ckb ?? '' };
}

/** The bar and «تفاصيل» of one purchase line (see the file header). */
export function lineSummary(p: PurchaseForPricing, line: PurchaseLineForPricing, input: ProductInput, preview: ProductPreview, rates: PricingRates | null): LineSummary {
  const excluded = p.charges.filter((c) => c.pricing_role === 'excluded' && c.shares.some((s) => s.index === line.index)).map((c) => c.title);
  const target = pricingScopeOf(line);
  const found =
    preview.models.find((m) => target.scope === 'option' && m.option_id === target.scope_id) ??
    preview.models.find((m) => m.option_id === (line.option_id ?? '')) ??
    preview.models[0];
  // FX-7 gaps: a colour or variant line with a level of its own shows one of its SKUs — the colour with the
  // line's model (else the first), or the variant itself — over every level of its selection.
  const levels = purchaseSkuLevels(input.loaded);
  const own = skuLevelOf(line, levels);
  const unit = own
    ? (own.scope === 'sku'
        ? levels!.units.find((u) => u.combo_key === own.scope_id)
        : (levels!.units.find((u) => u.color_id === own.scope_id && u.option_value_ids[0] === (line.option_id ?? found?.option_id)) ?? levels!.units.find((u) => u.color_id === own.scope_id))) ?? null
    : null;
  const unitModel = unit ? (preview.models.find((m) => m.option_id === (unit.option_value_ids[0] ?? '')) ?? found) : null;
  const model = unit && unitModel ? { ...unitModel, option_value_ids: [...unit.option_value_ids], color_id: unit.color_id, combo_key: unit.combo_key, sku: true } : found;
  let documentRate: string | null = null;
  if (rates && p.profile && p.currency !== 'IQD' && Number.isFinite(p.exchange_rate) && p.exchange_rate > 0) {
    const central = rates.central.fx[p.currency as 'USD' | 'EUR' | 'CNY']?.rate ?? null;
    try {
      const doc = String(p.exchange_rate);
      if (!central || !sameRate(doc, central)) documentRate = doc;
    } catch {
      documentRate = null;
    }
  }
  return modelSummary({
    productId: input.loaded.id,
    model: model ?? null,
    inputs: mergedInputs(directPurchaseStore(input.stored).inputs, preview.derived.entries.map((e) => e.write)),
    rules: mergedRules(directPurchaseStore(input.stored), preview.rule_writes),
    stored: input.stored,
    rates,
    engine: preview.mode === 'engine',
    proposals: preview.derived.proposals,
    supplierReplacedAt: (level) => preview.derived.entries.some((e) => e.write.scope === level && e.write.set.supplier_cost_amount != null),
    storePrice: line.store_price_iqd,
    excludedCharges: excluded,
    documentRate,
  });
}

/** What one model's bar is computed from: the product's inputs and rules (drafts laid over), the rates. */
export interface ModelSummaryInput {
  productId: string;
  model: (Pick<ProductPreview['models'][number], 'option_id' | 'channels'> & Partial<Pick<ProductPreview['models'][number], 'combo_key' | 'option_value_ids' | 'color_id'>> & { sku?: boolean }) | null;
  /** The store as it would be after the drafts (owner rows replaced or added). */
  inputs: ReadonlyArray<Partial<StoredInputRow>>;
  rules: readonly PricingRuleRow[];
  /** The store as read (the IQD-converted supplier cost's provenance). */
  stored: ProductPricingData;
  rates: PricingRates | null;
  engine: boolean;
  /** Profiles proposed by a purchase (the bar says «مقترح»). */
  proposals: ReadonlyArray<{ scope: string; scope_id: string; shipping_profile: ShippingProfile }>;
  /** A draft replaces the supplier cost at this level (its IQD provenance no longer applies). */
  supplierReplacedAt: (level: InputScope) => boolean;
  storePrice: number | null;
  excludedCharges: string[];
  documentRate: string | null;
}

/**
 * The 4-cell bar and «تفاصيل» of one model (see the file header) — the
 * procurement card's line and the product form's model alike (USD design §5.2).
 */
export function modelSummary(a: ModelSummaryInput): LineSummary {
  const out = emptySummary();
  out.engine_priced = a.engine;
  out.store_price_iqd = a.storePrice;
  out.excluded_charges = [...a.excludedCharges];
  out.document_rate = a.documentRate;
  const rates = a.rates;
  if (!rates) {
    out.issue_codes = ['FX_RATE_MISSING'];
    return out;
  }
  const model = a.model;
  if (!model) {
    out.issue_codes = ['CHANNEL_NOT_PRICED'];
    return out;
  }
  out.option_id = model.option_id;
  out.sells_direct = model.channels.some((c) => c.ok && c.channel === 'direct_sale');
  // A SKU (FX-7: a colour or a variant) resolves over every level of its selection; a model over the product and itself.
  const unit = model.sku
    ? { option_value_ids: model.option_value_ids ?? (model.option_id ? [model.option_id] : []), color_id: model.color_id ?? null, combo_key: model.combo_key ?? null }
    : null;
  const chain = unit ? chainOfUnit(a.inputs, unit) : chainOf(a.inputs, model.option_id);
  const resolved = resolveSkuInputs(chain).inputs;
  const u = rates.usd_iqd;
  const at = unit ? unitRuleTarget(a.productId, unit) : ruleTargetOf(a.productId, model.option_id);
  const targetRule = resolveRuleAt(a.rules, 'target_profit', at, { usdIqdRate: u });
  if (targetRule.status === 'active') {
    out.rule_level = targetRule.rule.scope;
    out.minimum_target_profit_usd = targetRule.amount_usd ?? null;
    out.target_profit_iqd = targetRule.amount_usd ? null : targetRule.amount_iqd;
  }

  // The bar's profile (§5.2).
  let profile: ShippingProfile | null = resolved.shipping_profile?.value ?? null;
  let source: LineSummary['profile_source'] = null;
  if (profile) {
    const scopeOfProfile = resolved.shipping_profile!.level === 'option' ? 'option' : 'base';
    source = a.proposals.some((x) => x.scope === scopeOfProfile && x.shipping_profile === profile) ? 'proposed' : 'default';
  } else {
    const first = PREORDER_ROUTES.find((r) => model.channels.some((c) => c.ok && c.route === r));
    if (first) {
      profile = ROUTE_PROFILE[first];
      source = 'first_route';
    }
  }
  out.shipping_profile = profile;
  out.profile_source = source;
  // Row 1-3 of «تفاصيل» do not need a price: the supplier cost as resolved.
  if (resolved.supplier) {
    out.supplier_original_amount = resolved.supplier.amount;
    out.supplier_original_currency = resolved.supplier.currency;
    out.cross_rate = resolved.supplier.currency === 'EUR' ? rates.eur_usd : resolved.supplier.currency === 'CNY' ? rates.cny_usd : null;
    const level: InputScope = resolved.supplier.amount_level;
    const ids = level === 'base' ? [''] : level === 'option' ? (unit ? unit.option_value_ids : [model.option_id]) : level === 'color' ? [unit?.color_id ?? ''] : [unit?.combo_key ?? ''];
    const row = a.stored.inputs.find((r) => r.scope === level && r.origin === 'MANUAL_OVERRIDE' && r.supplier_input_mode === 'IQD_CONVERTED' && ids.includes(r.scope_id));
    if (row && !a.supplierReplacedAt(level) && row.original_input_amount && row.conversion_rate_snapshot)
      out.iqd_converted = { original_input_amount: row.original_input_amount, conversion_rate_snapshot: row.conversion_rate_snapshot, converted_at: row.converted_at };
  }
  if (!profile) {
    out.issue_codes = ['SHIPPING_PROFILE_MISSING'];
    return out;
  }
  const sellsDirect = out.sells_direct;
  const barChannel = channelOfRoute(PROFILE_ROUTE[profile]);
  const channels: SkuChannel[] = sellsDirect ? ['direct_sale', barChannel] : [barChannel];
  const result = priceSku({
    chain,
    rates: rates.central,
    channels,
    target: targetRule,
    extra: sellsDirect ? resolveRuleAt(a.rules, 'direct_sale_extra', at) : null,
  });
  const bar = result.channels.find((c) => c.channel === barChannel) ?? null;
  const direct = result.channels.find((c) => c.channel === 'direct_sale') ?? null;
  out.issue_codes = [...new Set(result.issues.filter((i) => i.severity === 'error' && i.channel === barChannel).map((i) => i.code))].sort();
  if (direct) {
    out.direct_sale_extra_iqd = direct.direct_sale_extra_iqd;
    out.direct_sale_price_iqd = direct.computed_price_iqd;
  }
  if (!bar || !u) {
    out.state = 'blocked';
    if (!out.issue_codes.length) out.issue_codes = ['FX_RATE_MISSING'];
    return out;
  }
  fillFromChannel(out, bar, u);
  out.state = 'ok';
  return out;
}

function fillFromChannel(out: LineSummary, c: ChannelPrice, u: string): void {
  const U = procurementExact(u);
  const sC = toCents(procurementExact(c.supplier_cost_exact), U);
  const hC = toCents(procurementExact(c.shipping_cost_exact), U);
  const aC = toCents(procurementExact(BigInt(c.additional_cost_iqd)), U);
  const k = halfUpCents(quotientProcurementExact(procurementExact(c.replacement_exact), U));
  const [s, h, a] = allocateCents([sC, hC, aC], k);
  const t = c.target_profit_usd !== null ? halfUpCents(procurementExact(c.target_profit_usd)) : halfUpCents(quotientProcurementExact(procurementExact(c.target_profit_iqd_exact), U));
  out.supplier_cost_usd = c.supplier_cost_usd;
  out.supplier_cost_cents = s!;
  out.basis = c.shipping_basis;
  out.effective_weight_g = c.effective_weight_g;
  out.effective_cbm = c.effective_cbm;
  out.shipping_rate = c.shipping_rate;
  out.shipping_cost_iqd = Number(ceilProcurementExact(procurementExact(c.shipping_cost_exact)));
  out.shipping_cost_usd = c.shipping_cost_usd;
  out.shipping_cost_cents = h!;
  out.additional_cost_iqd = c.additional_cost_iqd;
  out.additional_cost_usd = c.additional_cost_usd;
  out.additional_cost_cents = a!;
  out.current_total_cost_usd = c.current_total_cost_usd;
  out.current_total_cost_cents = k;
  out.target_profit_cents = t;
  out.final_price_cents = k + t;
  out.final_price_usd = c.final_price_usd;
  out.usd_iqd_rate = c.usd_iqd_rate;
  out.preorder_base_iqd = c.preorder_base_iqd;
  out.rounding_added_iqd = c.rounding_added_iqd;
}
