/**
 * «التسعير بالدولار» IN THE PRODUCT FORM — THE OWNER'S OWN INPUTS FOR ONE
 * PRODUCT AND ITS MODELS (USD design §3 "written by (a) the owner's form",
 * §4, §5.2; owner brief 2026-10-09 §1-§7; the owner's request of the same day:
 * the pricing and the shipping of a product are entered where the product is
 * added or edited — its prices section and its options' prices — not only in
 * the procurement card).
 *
 * Per scope (the product itself = `base`, each model = `option`, and — with
 * the SKU rung, migration 0183, FX-7 — each colour = `color` and each colour or
 * variant SKU = `sku`): the supplier cost in its own currency (USD / EUR /
 * CNY), the base shipping route, the packed weight (grams) or the packed
 * volume (CBM), the additional cost per piece in IQD, and the two owner rules —
 * the minimum profit in USD and the Direct Sale Extra in whole dinars on the
 * 1,000 step. An empty field inherits: SKU → colour → model → product (E1's
 * walk, owner question Q4). On a database without 0183 a colour or a variant
 * is priced at its model's level, as before (its scope is refused).
 *
 * Writes inputs and rules only — never a price (the engine's writer adopts and
 * prices a product at the owner's completing save, decision 8). The answer
 * carries each model's 4-cell bar, computed by E1 at the central rates of the
 * versioned reader; the client never computes money.
 *
 * Validation is strict and names the FIELD, never its value: an unknown key is
 * UNKNOWN_FIELD; a bad value is PRICING_INPUT_INVALID with `details.field`.
 * Decimals are canonical TEXT (Arabic-Indic digits normalised); a JSON number
 * is refused for a decimal, so no binary float reaches a price. A key left out
 * keeps the stored value; `null` clears it (a model then inherits the
 * product's value).
 *
 * THE PRODUCT FORM'S OWN GLUE (owner correction 2026-10-09: pricing and
 * shipping live inside «تعديل منتج» / «إضافة منتج»):
 *   - the IQD convenience input (FX plan §12-§13): `supplier_cost_iqd`, whole
 *     dinars, converted ONCE at save to canonical USD = floor6(I ÷ U) at the
 *     effective U, with its snapshot (the dinars, U, U's version, the time).
 *     The same dinars sent again keep the snapshot byte for byte unless
 *     `reconvert: true`. The client never sends the USD or the rate; an entry
 *     with dinars needs the `preview_hash` of a preview that showed the
 *     conversion (a rate moved since → PRICING_PREVIEW_STALE);
 *   - the shipping box (`shipping_length_mm` / `_width_mm` / `_height_mm`, the
 *     three together): the form sends the product's own package measurements
 *     when the owner edits them or adopts them for pricing — an owner act
 *     (MVP C47), so the public package fields are never read by the engine on
 *     their own;
 *   - each answer carries owner decision 8's six figures per model × channel
 *     (`rows`), for «المعاينة والحفظ».
 */
import { MAX_ADDITIONAL_COST_IQD, MAX_BOX_MM, MAX_WEIGHT_G, SUPPLIER_CURRENCIES, type SupplierCurrency } from '@levonis/pricing/costToPrice';
import { SHIPPING_PROFILES, type ShippingProfile } from '@levonis/pricing/skuChannel';
import { iqdToCanonicalUsd } from '@levonis/pricing/fxChain';
import type { PricingContext } from '../../routes/cart';
import { sha256Hex } from '../crypto';
import { fxRefusal, positiveDecimal, strictBody } from '../fx/ownerActs';
import { evaluateLegacy, modelsOf, sellableSkus, skuLevelScopeIds, unitNamesOf } from './legacy';
import type { LoadedProduct } from './load';
import type { PricingRates } from './rates';
import { inputInvalid } from './whatIf';
import { parseRuleWrites, type PricingScopeIds } from './ownerRules';
import { mergedRules } from './fromPurchase';
import { canonical, modelSummary, priceModels } from './procurementPreview';
import { previewRowsDto, ratesHeadDto, summaryDto } from './procurementDto';
import {
  inputWriteIsNoop,
  nextInputRow,
  ownerRow,
  ruleAt,
  ruleWriteIsNoop,
  type InputFields,
  type InputScope,
  type InputWrite,
  type ProductPricingData,
  type ProductRuleScope,
  type RuleWrite,
  type StoredInputRow,
} from './store';
import {
  engineEvaluationDto,
  evaluateEngineWrite,
  loadEngineControl,
  loadStoredSkuCosts,
  needsSkuPricing,
  priceImageOf,
  skuTableOf,
  refuseUnreadSkus,
  withRuleIds,
  type EngineControl,
  type EngineEvaluation,
  type StoredSkuCost,
} from './engineWrite';

/** The fields the product form edits (the pricing weight stays as stored). */
export const FORM_INPUT_FIELDS = [
  'supplier_cost_amount',
  'supplier_cost_currency',
  'shipping_profile',
  'shipping_weight_g',
  'shipping_length_mm',
  'shipping_width_mm',
  'shipping_height_mm',
  'manual_cbm',
  'additional_cost_iqd',
] as const;
type FormField = (typeof FORM_INPUT_FIELDS)[number];
const BOX_FIELDS = ['shipping_length_mm', 'shipping_width_mm', 'shipping_height_mm'] as const;

const MAX_SCOPES = 61;
/** The IQD convenience input's ceiling (0181: at most 13 digits). */
export const MAX_SUPPLIER_IQD = 1_000_000_000_000;

/** What the form's parse needs beyond the body: the rates a conversion uses, and its time. */
export interface FormParseContext {
  rates: PricingRates | null;
  now: string;
}

/** One entry's typed dinars (the preview hash covers them with the rate they convert at). */
export interface IqdEntry {
  scope: InputScope;
  scope_id: string;
  amount: string;
  reconvert: boolean;
}

export const formOptionIds = (loaded: LoadedProduct): Set<string> =>
  new Set(loaded.doc.options.filter((o) => o.active !== false && !o.merged_into).map((o) => o.id));

/**
 * The ids each level may name (FX-7): the active models, and — with the SKU
 * rung (0183) only — every colour of the product and its colour or variant
 * SKUs (the sellable ones, and the variant rows the form lists).
 */
export function formScopeIds(loaded: LoadedProduct): PricingScopeIds {
  const option = formOptionIds(loaded);
  // A failed read of the SKU rung is not a database without it: refused (retryable), never "no colour level".
  refuseUnreadSkus(loaded);
  if (!skuTableOf(loaded)) return { option };
  const { color, sku } = skuLevelScopeIds(loaded.doc, loaded.view);
  return { option, color, sku };
}

function wholeOrNull(raw: unknown, field: string, min: number, max: number): number | null {
  if (raw === null) return null;
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < min || raw > max) throw inputInvalid(field);
  return raw;
}

/** One scope's entry of the form → an input write (absent keys untouched, null clears). */
function parseInputEntry(raw: unknown, i: number, ids: PricingScopeIds, stored: ProductPricingData, cx: FormParseContext): { write: InputWrite; iqd: IqdEntry | null } {
  const r = strictBody(raw, ['scope', 'scope_id', ...FORM_INPUT_FIELDS, 'supplier_cost_iqd', 'reconvert']);
  const scope = r.scope as InputScope;
  const levels: Record<string, ReadonlySet<string> | undefined> = { option: ids.option, color: ids.color, sku: ids.sku };
  if (scope !== 'base' && !levels[scope]) throw inputInvalid(`inputs[${i}].scope`);
  const scopeId = scope === 'base' ? '' : typeof r.scope_id === 'string' ? r.scope_id : '';
  if (scope !== 'base' && !levels[scope]!.has(scopeId)) throw inputInvalid(`inputs[${i}].scope_id`);
  if (scope === 'base' && r.scope_id !== undefined && r.scope_id !== null && r.scope_id !== '') throw inputInvalid(`inputs[${i}].scope_id`);
  const existing = ownerRow(stored.inputs, scope, scopeId);
  const set: Partial<InputFields> = {};
  const has = (k: FormField) => Object.prototype.hasOwnProperty.call(r, k) && r[k] !== undefined;
  if (has('supplier_cost_amount')) {
    const v = r.supplier_cost_amount;
    set.supplier_cost_amount = v === null || v === '' ? null : positiveDecimal(v, 'supplier_cost_amount', 12, 6);
  }
  if (has('supplier_cost_currency')) {
    const v = r.supplier_cost_currency;
    if (v !== null && (typeof v !== 'string' || !(SUPPLIER_CURRENCIES as readonly string[]).includes(v))) throw inputInvalid('supplier_cost_currency');
    set.supplier_cost_currency = (v as SupplierCurrency | null) ?? null;
  }
  if (has('shipping_profile')) {
    const v = r.shipping_profile;
    if (v !== null && (typeof v !== 'string' || !(SHIPPING_PROFILES as readonly string[]).includes(v))) throw inputInvalid('shipping_profile');
    set.shipping_profile = (v as ShippingProfile | null) ?? null;
  }
  if (has('shipping_weight_g')) set.shipping_weight_g = wholeOrNull(r.shipping_weight_g, 'shipping_weight_g', 1, MAX_WEIGHT_G);
  // The box is one unit (E1 [L2-1a]): its three axes travel together, all set or all cleared.
  const boxKeys = BOX_FIELDS.filter((k) => has(k));
  if (boxKeys.length) {
    if (boxKeys.length !== 3) throw inputInvalid('shipping_box');
    const axes = BOX_FIELDS.map((k) => wholeOrNull(r[k], k, 1, MAX_BOX_MM));
    if (axes.some((a) => a === null) && axes.some((a) => a !== null)) throw inputInvalid('shipping_box');
    [set.shipping_length_mm, set.shipping_width_mm, set.shipping_height_mm] = axes;
  }
  if (has('manual_cbm')) {
    const v = r.manual_cbm;
    const cbm = v === null || v === '' ? null : positiveDecimal(v, 'manual_cbm', 3, 9);
    if (cbm !== null && cbm.length > 12) throw inputInvalid('manual_cbm');
    set.manual_cbm = cbm;
  }
  if (has('additional_cost_iqd')) set.additional_cost_iqd = wholeOrNull(r.additional_cost_iqd, 'additional_cost_iqd', 0, MAX_ADDITIONAL_COST_IQD);

  // The IQD convenience input (FX plan §12-§13; see the file header).
  let iqd: IqdEntry | null = null;
  let snapshot: InputWrite['iqd'];
  if (Object.prototype.hasOwnProperty.call(r, 'supplier_cost_iqd') && r.supplier_cost_iqd !== undefined) {
    if (has('supplier_cost_amount') || has('supplier_cost_currency')) throw inputInvalid('supplier_cost_iqd');
    const v = r.supplier_cost_iqd;
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1 || v > MAX_SUPPLIER_IQD) throw inputInvalid('supplier_cost_iqd');
    if (r.reconvert !== undefined && typeof r.reconvert !== 'boolean') throw inputInvalid('reconvert');
    const reconvert = r.reconvert === true;
    iqd = { scope, scope_id: scopeId, amount: String(v), reconvert };
    const same = existing?.supplier_input_mode === 'IQD_CONVERTED' && existing.original_input_amount === String(v);
    // The same dinars again: the stored conversion stands, byte for byte (H3), unless asked to convert again.
    if (!same || reconvert) {
      const u = cx.rates?.usd_iqd ?? null;
      const version = cx.rates?.pair_versions.USD_IQD ?? 0;
      if (!u || version <= 0) throw fxRefusal(409, 'PRICING_FX_RATE_MISSING');
      set.supplier_cost_amount = iqdToCanonicalUsd(v, u);
      set.supplier_cost_currency = 'USD';
      snapshot = { original_input_amount: String(v), conversion_rate_snapshot: u, conversion_fx_version: version, converted_at: cx.now };
    }
  } else if (r.reconvert !== undefined) {
    throw inputInvalid('reconvert');
  }

  // A cleared supplier cost takes its currency with it, unless a stored difference still needs it (0181 CHECK).
  if (set.supplier_cost_amount === null && !has('supplier_cost_currency') && (existing?.supplier_cost_delta ?? null) === null) set.supplier_cost_currency = null;
  const w: InputWrite = { scope, scope_id: scopeId, existing, set, source_ref: 'owner', ...(snapshot ? { iqd: snapshot } : {}) };
  const next = nextInputRow(w);
  if ((next.supplier_cost_amount !== null || next.supplier_cost_delta !== null) && next.supplier_cost_currency === null) throw inputInvalid('supplier_cost_currency');
  return { write: w, iqd };
}

export interface ProductInputsDraft {
  inputs: InputWrite[];
  rules: RuleWrite[];
  /** The typed dinars of the entries, in order (what the preview hash covers). */
  iqd: IqdEntry[];
}

/**
 * How many entries one parse takes. The form's own doors pass nothing (61
 * scopes, 60 rules); the data file passes the product's own scope count — each
 * entry still names one of its scopes exactly once, and the apply's statement
 * allowance bounds the batch (worker/routes/templateDataFile.ts).
 */
export interface ParseLimits {
  scopes?: number;
  rules?: number;
}

/** Parse the form's `{inputs, rules}` (PUT and the preview alike). */
export function parseProductInputs(body: Record<string, unknown>, loaded: LoadedProduct, stored: ProductPricingData, cx: FormParseContext, limits: ParseLimits = {}): ProductInputsDraft {
  const ids = formScopeIds(loaded);
  const rawInputs = body.inputs ?? [];
  if (!Array.isArray(rawInputs) || rawInputs.length > (limits.scopes ?? MAX_SCOPES)) throw inputInvalid('inputs');
  const seen = new Set<string>();
  const iqd: IqdEntry[] = [];
  const inputs = rawInputs.map((raw, i) => {
    const parsed = parseInputEntry(raw, i, ids, stored, cx);
    const w = parsed.write;
    const key = `${w.scope}:${w.scope_id}`;
    if (seen.has(key)) throw inputInvalid(`inputs[${i}]`);
    seen.add(key);
    if (parsed.iqd) iqd.push(parsed.iqd);
    return w;
  });
  const rawRules = body.rules ?? [];
  if (!Array.isArray(rawRules)) throw inputInvalid('rules');
  const rules = rawRules.length ? parseRuleWrites({ rules: rawRules }, loaded.id, ids, stored, { max: limits.rules }) : [];
  return { inputs, rules, iqd };
}

/**
 * The hash a save with typed dinars must carry: the product, the dinars per
 * scope and the effective U (with its version) they convert at — so the owner
 * always saw the rate the save uses (FX plan §12).
 */
export async function formPreviewHash(productId: string, iqd: readonly IqdEntry[], rates: PricingRates | null): Promise<string> {
  return sha256Hex(
    canonical({
      v: 1,
      product_id: productId,
      iqd: iqd.map((e) => [e.scope, e.scope_id, e.amount, e.reconvert]),
      usd_iqd: rates?.usd_iqd ?? null,
      usd_version: rates?.pair_versions.USD_IQD ?? 0,
    })
  );
}

/** What an engine write reads beyond the store: the price image, the control row, the stored engine results. */
export interface EngineReads {
  image: string;
  control: EngineControl;
  storedCosts: StoredSkuCost[];
}

export async function loadEngineReads(db: D1Database, productId: string): Promise<EngineReads> {
  const [image, control, storedCosts] = await Promise.all([priceImageOf(db, productId), loadEngineControl(db), loadStoredSkuCosts(db, [productId])]);
  return { image, control, storedCosts };
}

/** The drafts that change something (a no-op write is never sent, nor hashed); new rule rows get their ids. */
export function effectiveWrites(draft: ProductInputsDraft): { inputWrites: InputWrite[]; ruleWrites: RuleWrite[] } {
  return { inputWrites: draft.inputs.filter((w) => !inputWriteIsNoop(w)), ruleWrites: withRuleIds(draft.rules.filter((w) => !ruleWriteIsNoop(w))) };
}

/**
 * Owner decision 8 for the product form: the engine's evaluation of the store
 * with the drafts laid over — adopt (a manual product the save leaves
 * complete), reprice (an engine product), or data only.
 */
export async function productEngineEvaluation(
  loaded: LoadedProduct,
  stored: ProductPricingData,
  ctx: PricingContext,
  rates: PricingRates | null,
  draft: ProductInputsDraft,
  reads: EngineReads,
  opts: { adopt?: boolean; writes?: { inputWrites: InputWrite[]; ruleWrites: RuleWrite[] } } = {}
): Promise<EngineEvaluation> {
  const writes = opts.writes ?? effectiveWrites(draft);
  return evaluateEngineWrite({
    loaded,
    stored,
    ctx,
    rates,
    control: reads.control,
    inputs: draftInputs(stored.inputs, writes.inputWrites),
    inputWrites: writes.inputWrites,
    ruleWrites: writes.ruleWrites,
    iqd: draft.iqd.map((e) => [e.scope, e.scope_id, e.amount, e.reconvert] as const),
    image: reads.image,
    storedCosts: reads.storedCosts,
    // A product the owner took back to manual pricing adopts again only when asked.
    allowAdopt: !stored.state?.opted_out_at || opts.adopt === true,
  });
}

/** The store's owner rows as they would be after the drafts (exactly the row a write leaves). */
function draftInputs(stored: readonly StoredInputRow[], writes: readonly InputWrite[]): Array<Partial<StoredInputRow>> {
  const rows: Array<Partial<StoredInputRow>> = stored.map((r) => ({ ...r }));
  for (const w of writes) {
    const scopeId = w.scope === 'base' ? '' : w.scope_id;
    const at = rows.findIndex((r) => r.scope === w.scope && r.scope_id === scopeId && r.origin === 'MANUAL_OVERRIDE');
    const { iqd, clears_iqd_snapshot: _clears, ...next } = nextInputRow(w);
    void _clears;
    const merged: Partial<StoredInputRow> = { ...(at >= 0 ? rows[at] : { scope: w.scope, scope_id: scopeId, origin: 'MANUAL_OVERRIDE' as const }), ...next };
    // A drafted conversion shows its own snapshot (the preview says which rate the save will use).
    if (iqd) {
      merged.original_input_amount = iqd.original_input_amount;
      merged.original_input_currency = 'IQD';
      merged.conversion_rate_snapshot = iqd.conversion_rate_snapshot;
      merged.conversion_fx_version = iqd.conversion_fx_version;
      merged.canonical_supplier_cost_usd = next.supplier_cost_amount;
      merged.converted_at = iqd.converted_at;
    }
    if (at >= 0) rows[at] = merged;
    else rows.push(merged);
  }
  return rows;
}

const formInputsOf = (row: Partial<StoredInputRow> | null | undefined) => {
  if (!row) return null;
  const converted = row.supplier_input_mode === 'IQD_CONVERTED';
  return {
    supplier_cost_amount: row.supplier_cost_amount ?? null,
    supplier_cost_currency: row.supplier_cost_currency ?? null,
    supplier_input_mode: row.supplier_input_mode ?? null,
    // The IQD convenience input's provenance: the dinars typed, the rate and the time they converted at.
    original_input_amount: converted ? (row.original_input_amount ?? null) : null,
    conversion_rate_snapshot: converted ? (row.conversion_rate_snapshot ?? null) : null,
    converted_at: converted ? (row.converted_at ?? null) : null,
    shipping_profile: row.shipping_profile ?? null,
    shipping_weight_g: row.shipping_weight_g ?? null,
    pricing_weight_g: row.pricing_weight_g ?? null,
    shipping_length_mm: row.shipping_length_mm ?? null,
    shipping_width_mm: row.shipping_width_mm ?? null,
    shipping_height_mm: row.shipping_height_mm ?? null,
    manual_cbm: row.manual_cbm ?? null,
    additional_cost_iqd: row.additional_cost_iqd ?? null,
    source_ref: row.source_ref ?? '',
  };
};

/**
 * The form's answer: every scope's stored (or drafted) inputs and rules, and
 * every model's bar. Allowlisted field by field; owner only, private, no-store.
 */
export async function productInputsAnswer(
  loaded: LoadedProduct,
  stored: ProductPricingData,
  ctx: PricingContext,
  rates: PricingRates | null,
  draft: ProductInputsDraft = { inputs: [], rules: [], iqd: [] },
  reads: EngineReads | null = null,
  opts: { adopt?: boolean; evaluation?: EngineEvaluation } = {}
) {
  const pid = loaded.id;
  // Owner decision 8: what a save of these drafts would do to the product's prices, and the hash it must carry.
  const evaluation = opts.evaluation ?? (reads ? await productEngineEvaluation(loaded, stored, ctx, rates, draft, reads, { adopt: opts.adopt }) : null);
  const inputs = draftInputs(stored.inputs, draft.inputs);
  // «تفاصيل» reads an IQD conversion's provenance from the rows as they would be after the drafts.
  const drafted: ProductPricingData = { ...stored, inputs: inputs as StoredInputRow[] };
  const rules = mergedRules(stored, draft.rules);
  // FX-7: priced per SKU (a colour or SKU level holds a value, or a second option group) — the
  // same decision the save makes; the colour and SKU levels are offered only with the SKU rung (0183).
  const skuLevels = skuTableOf(loaded);
  const perSku = skuLevels && needsSkuPricing(loaded, inputs, rules, modelsOf(loaded.doc, loaded.view).groups);
  const legacy = evaluateLegacy(pid, loaded.doc, loaded.view, ctx, { perSku });
  const engine = stored.state?.mode === 'engine';
  const names = (o: { name_ar?: string; name_en?: string; name_ckb?: string } | null | undefined) => ({
    name_ar: o?.name_ar ?? '',
    name_en: o?.name_en ?? '',
    name_ckb: o?.name_ckb ?? '',
  });
  const rowAt = (scope: InputScope, scopeId: string) =>
    inputs.find((r) => r.scope === scope && (r.scope_id ?? '') === (scope === 'base' ? '' : scopeId) && r.origin === 'MANUAL_OVERRIDE') ?? null;
  const scopeDto = (scope: InputScope, scopeId: string, label: ReturnType<typeof names>) => {
    const ruleScope: ProductRuleScope = scope === 'base' ? 'product' : scope;
    const target = ruleAt(rules, pid, 'target_profit', ruleScope, scopeId);
    const extra = ruleAt(rules, pid, 'direct_sale_extra', ruleScope, scopeId);
    return {
      scope,
      scope_id: scope === 'base' ? '' : scopeId,
      ...label,
      pricing_inputs: formInputsOf(rowAt(scope, scopeId)),
      minimum_target_profit_usd: target?.state === 'ACTIVE' ? (target.amount_usd ?? null) : null,
      target_profit_iqd: target?.state === 'ACTIVE' && !target.amount_usd ? (target.amount_iqd ?? null) : null,
      target_profit_state: target?.state ?? null,
      direct_sale_extra_iqd: extra?.state === 'ACTIVE' ? (extra.amount_iqd ?? null) : null,
      direct_sale_extra_state: extra?.state ?? null,
    };
  };
  const options = loaded.doc.options.filter((o) => o.active !== false && !o.merged_into);
  const models = legacy.models.map((m) => {
    const direct = m.channels.find((c) => c.ok && c.channel === 'direct_sale');
    const first = direct ?? m.channels.find((c) => c.ok);
    const summary = modelSummary({
      productId: pid,
      model: m,
      inputs,
      rules,
      stored: drafted,
      rates,
      engine,
      proposals: [],
      supplierReplacedAt: () => false,
      storePrice: first?.prepaid_iqd ?? null,
      excludedCharges: [],
      documentRate: null,
    });
    return {
      option_id: m.option_id,
      ...names(m.option),
      sells_direct: !!direct,
      pricing_summary: summaryDto(summary),
    };
  });
  // FX-7: every colour and every colour or variant SKU, its own inputs (empty = its model's) and its
  // computed customer price — shown in each colour's card of «الخيارات والألوان».
  const ids = skuLevels ? formScopeIds(loaded) : { option: new Set<string>() };
  const colours = skuLevels ? loaded.doc.colors.filter((c) => c.active !== false) : [];
  const grid = skuLevels && (colours.length > 0 || legacy.option_groups > 1) ? sellableSkus(loaded.doc, loaded.view) : { skus: [], overflow: false };
  const skuUnits = grid.skus.length ? (perSku ? legacy.units : evaluateLegacy(pid, loaded.doc, loaded.view, ctx, { perSku: true }).units) : [];
  const skuScopes = [...(ids.sku ?? [])]
    .sort()
    .map((combo) => {
      const sku = grid.skus.find((k) => k.combo_key === combo);
      const ids2 = sku ? sku.option_value_ids : combo.split('|').filter((x) => x.startsWith('o:')).map((x) => x.slice(2));
      const colourId = sku ? (sku.color?.id ?? null) : (combo.split('|').find((x) => x.startsWith('c:'))?.slice(2) ?? null);
      return scopeDto('sku', combo, unitNamesOf(loaded.doc, ids2, loaded.doc.colors.find((c) => c.id === colourId) ?? null));
    });
  const skus = skuUnits.map((u) => {
    const direct = u.channels.find((c) => c.ok && c.channel === 'direct_sale');
    const summary = modelSummary({
      productId: pid,
      model: { option_id: u.option_id, channels: u.channels, combo_key: u.combo_key, option_value_ids: u.option_value_ids, color_id: u.color?.id ?? null, sku: true },
      inputs,
      rules,
      stored: drafted,
      rates,
      engine,
      proposals: [],
      supplierReplacedAt: () => false,
      storePrice: (direct ?? u.channels.find((c) => c.ok))?.prepaid_iqd ?? null,
      excludedCharges: [],
      documentRate: null,
    });
    return {
      combo_key: u.combo_key ?? '',
      option_id: u.option_id,
      option_value_ids: u.option_value_ids ?? [],
      color_id: u.color?.id ?? null,
      ...(u.names ?? names(u.option)),
      sells_direct: !!direct,
      pricing_summary: summaryDto(summary),
    };
  });
  return {
    success: true as const,
    product_id: pid,
    mode: engine ? ('engine' as const) : ('manual' as const),
    inputs_seq: stored.state?.inputs_seq ?? 0,
    // The price writes' counter: «رجوع إلى التسعير اليدوي» is fenced on it.
    write_seq: stored.state?.write_seq ?? 0,
    rates: ratesHeadDto(rates),
    // FX-7: the colour and SKU levels are offered (the database has the SKU rung), and whether the
    // product is priced per SKU (its rows below are then one per SKU × channel).
    sku_levels: skuLevels,
    per_sku: perSku,
    scopes: [
      scopeDto('base', '', names(null)),
      ...options.map((o) => scopeDto('option', o.id, names(o))),
      ...colours.map((c) => scopeDto('color', c.id, names(c))),
      ...skuScopes,
    ],
    models,
    skus,
    // Owner decision 8's six figures per model (or SKU) × channel, priced as the drafts would leave the store.
    rows: previewRowsDto(priceModels(pid, legacy.units, inputs, rules, rates)),
    // The save's own preview (owner decision 8): adopt / reprice / data only, the six figures, the flags.
    adoption: evaluation ? engineEvaluationDto(evaluation) : null,
    // What the save carries: the engine write's hash when the save writes prices, else the hash of
    // the typed dinars' conversion (the rate it was shown at).
    preview_hash: evaluation?.kind && evaluation.complete && evaluation.hash ? evaluation.hash : await formPreviewHash(pid, draft.iqd, rates),
  };
}
