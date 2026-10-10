/**
 * «التسعير بالدولار والشحن» — THE PRODUCT'S USD PRICING, INSIDE «تعديل منتج» /
 * «إضافة منتج» (owner brief 2026-10-09; the owner's correction of the same day:
 * pricing and shipping live in the product form itself — its prices, its
 * options and its preview — not only in the read-only «التسعير والشحن» page).
 *
 * One state (`useUsdPricingState`, held by ProductForm so its own save can
 * carry the pricing too) and four mount points:
 *   - section ٣ «الأسعار»: the product level — supplier cost and currency (USD /
 *     EUR / CNY, or dinars converted ONCE to USD with their snapshot), the base
 *     shipping route and the measure it needs, the additional cost per piece,
 *     the minimum profit in USD and, where the product sells direct, the Direct
 *     Sale Extra — with the 4-cell bar and «تفاصيل»;
 *   - section ٥ «الخيارات والألوان»: the same fields in each model's card, every
 *     empty field inheriting the product's value, each model with its computed
 *     customer price (and direct price) and its bar; and — with the SKU rung
 *     (migration 0183, FX-7) — in each colour's card and each variant row, the
 *     same fields again, empty = inherited from the variant's colour, its model
 *     and the product, with the computed customer price of every SKU it makes
 *     (on a database without 0183 a colour follows its model, said on screen);
 *   - section ٨ «المعاينة والحفظ»: owner decision 8's six figures per model ×
 *     channel.
 *
 * THE MEASURE IS THE FORM'S OWN. The packed weight and the box are the
 * product's (and each model's) package measurements of «الأبعاد والوزن» — the
 * same state, never a second copy to keep in step. They reach pricing as the
 * owner's act (MVP C47): a measurement edited in this form, adopted with
 * «اعتمد قياس الصندوق للتسعير», or filling a pricing measure that is empty, is
 * written to the pricing inputs when the pricing is saved. The public package
 * fields are never read by the engine on their own.
 *
 * THERE IS NO SECOND PERSISTENCE PATH. The values are private (owner only) and
 * save through the pricing door (`PUT /api/admin/pricing/products/:id/inputs`):
 * one atomic, version-fenced, audited batch — after the product's own save
 * when «نشر» / «مسودة» is pressed (the product document never carries a private
 * value), or alone with «حفظ التسعير بالدولار». Every figure on screen is the
 * server's (E1 at the central rates, `POST …/preview` while typing); the screen
 * formats and never computes money.
 *
 * THE DATA FIRST, THE PRICE ONLY WHEN THE OWNER CONFIRMS IT (owner decision 8,
 * amended by the owner's report of 2026-10-10: «نشر» kept nothing that was
 * typed). Every save of a MANUAL product — «حفظ التسعير بالدولار», «نشر» and
 * «مسودة» alike, one path (`commitPricing`) — stores what was typed as data
 * (`data_only`), complete or not; the store price stays manual. When the
 * stored data completes the product, the sheet (`UsdPricingSaveSheet`, mounted
 * at the form's root) shows the new prices, and «حفظ» sends the preview's hash
 * (and the tick above 15%, with a fresh sign-in) — the only request that
 * adopts the engine and writes prices; «لاحقًا» loses nothing. An ENGINE-priced
 * product's save stays one held write (409 with the preview): its stored
 * prices never drift from its stored inputs, and cancelling keeps the typed
 * values in the fields, guarded on leaving. No outcome is silent: saved,
 * ready, held, refused or not sent, the panel and the form's bar say which,
 * and a field the server would refuse says why under itself before anything
 * is sent.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Check, Loader2, Save } from 'lucide-react';
import { ApiError, api, isAborted } from '../../../lib/api';
import { useLanguage } from '../../../LanguageContext';
import { contractRefusal, refusalLang } from '../../../lib/refusalStrings';
import { useOptionalAuth } from '../../../AuthContext';
import type { Language } from '../../../translations';
import { parseProcurementDecimal, typedDecimalText } from '../../../../packages/contracts/src/procurementCost';
import type { ProductDimensionsV2 } from '../../../lib/productTypes';
import PricingSummaryBar from '../../adminOperations/PricingSummaryBar';
import { PricingRowsTable } from '../../adminOperations/ProcurementPricingReview';
import type { EngineAdoption, PricingPreviewRow, PricingSummary } from '../../adminOperations/procurementPricing';
import { issueText, procurementPricingStrings, profileName, type ProcurementPricingStrings } from '../../adminOperations/procurementPricingStrings';
import EngineSaveSheet from '../../adminOperations/EngineSaveSheet';
import { engineSaveStrings } from '../../adminOperations/engineSaveStrings';
import { money } from '../../adminOperations/shared';
import { MeasurementInput, formatScaledInteger } from './DimensionsSection';
import { Banner, Field, Grid, Money, Select, TextInput, btnGhost, btnPrimary } from './formUi';
import { USD_PRICING_FORM_STRINGS, usdPricingFormStrings, type UsdPricingFormStrings } from './usdPricingStrings';

const PRICING = '/api/admin/pricing';
/** «التسعير والشحن» (the same address as adminPricing/fxParts PRICING_TAB_PATH; not imported, so the form loads no tab code). */
export const PRICING_TAB_HREF = '/admin?tab=pricing';
const CURRENCIES = ['USD', 'EUR', 'CNY'] as const;
const ROUTES = ['GERMANY_LAND', 'CHINA_AIR', 'CHINA_SEA'] as const;

// ------------------------------------------------------------------ the answer

interface StoredInputs {
  supplier_cost_amount: string | null;
  supplier_cost_currency: string | null;
  supplier_input_mode: string | null;
  original_input_amount: string | null;
  conversion_rate_snapshot: string | null;
  converted_at: string | null;
  shipping_profile: string | null;
  shipping_weight_g: number | null;
  pricing_weight_g: number | null;
  shipping_length_mm: number | null;
  shipping_width_mm: number | null;
  shipping_height_mm: number | null;
  manual_cbm: string | null;
  additional_cost_iqd: number | null;
  source_ref: string;
}

/** The four pricing levels (FX-7 adds the colour and the exact SKU): product → model → colour → SKU. */
export type PricingScope = 'base' | 'option' | 'color' | 'sku';

export interface ScopeAnswer {
  scope: PricingScope;
  scope_id: string;
  name_ar: string;
  name_en: string;
  name_ckb: string;
  pricing_inputs: StoredInputs | null;
  minimum_target_profit_usd: string | null;
  target_profit_iqd: number | null;
  target_profit_state: string | null;
  direct_sale_extra_iqd: number | null;
  direct_sale_extra_state: string | null;
}

interface ModelAnswer {
  option_id: string;
  name_ar: string;
  name_en: string;
  name_ckb: string;
  sells_direct: boolean;
  pricing_summary: PricingSummary;
}

/** One SKU of a product (FX-7): its key, its selection and colour, and its computed customer price. */
export interface SkuAnswer {
  combo_key: string;
  option_id: string;
  option_value_ids: string[];
  color_id: string | null;
  name_ar: string;
  name_en: string;
  name_ckb: string;
  sells_direct: boolean;
  pricing_summary: PricingSummary;
}

export interface UsdPricingAnswer {
  product_id: string;
  mode: 'manual' | 'engine';
  inputs_seq: number;
  /** FX-7: the database has the SKU rung (0183) — the colour and variant levels are offered. */
  sku_levels?: boolean;
  /** FX-7: the product (with the drafts) is priced per SKU — its preview rows are one per SKU × channel. */
  per_sku?: boolean;
  /** FX-7: every sellable SKU's computed price (colour cards and variant rows). */
  skus?: SkuAnswer[];
  /** The price writes' counter (an engine product's way back to manual is fenced on it). */
  write_seq?: number;
  rates: { usd_iqd_rate: string | null; review_pending: boolean; derived_stale: boolean };
  scopes: ScopeAnswer[];
  models: ModelAnswer[];
  /** Owner decision 8's six figures per model × channel. */
  rows: PricingPreviewRow[];
  /** What the save carries: the engine write's hash when it writes prices, else the dinar conversion's. */
  preview_hash: string;
  /** The typed dinars' conversion hash on its own (null without dinars; absent on an older server): a data-only save carries it. */
  conversion_hash?: string | null;
  /** What saving these drafts does to the product's prices (owner decision 8): adopt, reprice or data only. */
  adoption?: EngineAdoption | null;
}

// ------------------------------------------------------------------ the form's measures

export type Box = readonly [number, number, number];

/** A package measurement as pricing reads it: the packed weight, the box (L = depth, W, H) when whole. */
export interface PackageMeasure {
  weight_g: number | null;
  box: Box | null;
  partial_box: boolean;
}

const NO_MEASURE: PackageMeasure = { weight_g: null, box: null, partial_box: false };
const positive = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

/** The package measurement of a form's dimensions (the product's, or a model's own overrides). */
export function packageMeasureOf(d: Partial<ProductDimensionsV2> | null | undefined): PackageMeasure {
  if (!d) return NO_MEASURE;
  const axes = [d.package_depth_mm, d.package_width_mm, d.package_height_mm];
  const set = axes.filter(positive).length;
  return {
    weight_g: positive(d.package_weight_g) ? d.package_weight_g : null,
    box: set === 3 ? (axes as unknown as Box) : null,
    partial_box: set > 0 && set < 3,
  };
}

const rowBox = (r: StoredInputs | null | undefined): Box | null =>
  r && positive(r.shipping_length_mm) && positive(r.shipping_width_mm) && positive(r.shipping_height_mm) ? [r.shipping_length_mm, r.shipping_width_mm, r.shipping_height_mm] : null;
const sameBox = (a: Box | null, b: Box | null) => (a === null || b === null ? a === b : a[0] === b[0] && a[1] === b[1] && a[2] === b[2]);

/** A model as the form holds it (unsaved ones included). */
export interface FormModel {
  id: string;
  name_en: string;
  name_ar?: string;
  name_ckb?: string;
  sells_direct: boolean;
}

/** A colour as the form holds it (unsaved ones included), with the models it is linked to (none = every model). */
export interface FormColour {
  id: string;
  name_en: string;
  name_ar?: string;
  name_ckb?: string;
  option_ids: readonly string[];
}

/** A variant row of the form (an exact combination): its key, its values and its colour. */
export interface FormSku {
  combo_key: string;
  option_value_ids: readonly string[];
  color_id: string | null;
}

type DimensionsById = Readonly<Record<string, ProductDimensionsV2 | null | undefined>>;

/** What the pricing reads from the rest of the form, and how it edits the form's own measurements. */
export interface UsdPricingFormContext {
  baseDimensions: ProductDimensionsV2 | null | undefined;
  optionDimensions: DimensionsById;
  /** The measurements as last loaded or saved (an edit since then is the owner's act on pricing too). */
  savedBaseDimensions: ProductDimensionsV2 | null | undefined;
  savedOptionDimensions: DimensionsById;
  models: readonly FormModel[];
  productSellsDirect: boolean;
  /** FX-7: the colours and the variant rows of the form, each with its own measurements. */
  colours?: readonly FormColour[];
  skus?: readonly FormSku[];
  colourDimensions?: DimensionsById;
  savedColourDimensions?: DimensionsById;
  skuDimensions?: DimensionsById;
  savedSkuDimensions?: DimensionsById;
  setMeasure: (scope: PricingScope, id: string, patch: Partial<ProductDimensionsV2>) => void;
}

/** The form's own measurements of one scope (or as last loaded/saved). */
function dimensionsOf(f: UsdPricingFormContext, scope: PricingScope, id: string, saved = false): ProductDimensionsV2 | null | undefined {
  if (scope === 'base') return saved ? f.savedBaseDimensions : f.baseDimensions;
  const table = scope === 'option' ? (saved ? f.savedOptionDimensions : f.optionDimensions) : scope === 'color' ? (saved ? f.savedColourDimensions : f.colourDimensions) : saved ? f.savedSkuDimensions : f.skuDimensions;
  return table?.[id];
}

// ------------------------------------------------------------------ drafts

/** What the owner typed (or adopted) for one scope (absent = untouched). */
export interface ScopeDraft {
  supplier_cost_amount?: string;
  /** 'USD' | 'EUR' | 'CNY', or 'IQD' for the convenience input. */
  supplier_cost_currency?: string;
  supplier_cost_iqd?: number | null;
  reconvert?: boolean;
  shipping_profile?: string;
  shipping_weight_g?: number | null;
  box?: Box | null;
  manual_cbm?: string;
  additional_cost_iqd?: number | null;
  minimum_target_profit_usd?: string;
  direct_sale_extra_iqd?: number | null;
  /** «اعتمد قياس الصندوق للتسعير» — the form's measurement replaces the stored pricing one. */
  adopt_measure?: boolean;
}

export const keyOf = (scope: PricingScope, id: string) => (scope === 'base' ? 'base' : `${scope}:${id}`);
const parseKey = (key: string): { scope: PricingScope; id: string } => {
  if (key === 'base') return { scope: 'base', id: '' };
  const at = key.indexOf(':');
  return { scope: key.slice(0, at) as PricingScope, id: key.slice(at + 1) };
};

/**
 * A SKU's key exactly as the server writes it (packages/pricing skuComboKey,
 * worker/lib/inventory comboKey): the option value ids sorted, each `o:<id>`,
 * then `c:<colour id>`, joined by '|'.
 */
export function pricingSkuKey(optionValueIds: readonly string[], colorId: string | null | undefined): string {
  const parts = [...optionValueIds].filter(Boolean).sort().map((id) => `o:${id}`);
  if (colorId) parts.push(`c:${colorId}`);
  return parts.join('|');
}

/** The option values and colour a SKU key names (`o:<id>|…|c:<id>`). */
const skuParts = (combo: string) => {
  const parts = combo.split('|');
  return { options: parts.filter((x) => x.startsWith('o:')).map((x) => x.slice(2)), color: parts.find((x) => x.startsWith('c:'))?.slice(2) ?? null };
};

/**
 * Where an empty field takes its value from, nearest first (E1's walk): a SKU
 * from its colour, its models and the product; a colour from its one linked
 * model (a colour shared by several models inherits each one's, so the
 * product's is shown) and the product; a model from the product.
 */
function ancestorsOf(form: UsdPricingFormContext | null, scope: PricingScope, id: string): Array<[PricingScope, string]> {
  if (scope === 'base') return [];
  if (scope === 'option') return [['base', '']];
  if (scope === 'color') {
    const linked = form?.colours?.find((c) => c.id === id)?.option_ids ?? [];
    return [...(linked.length === 1 ? ([['option', linked[0]!]] as Array<[PricingScope, string]>) : []), ['base', '']];
  }
  const { options, color } = skuParts(id);
  return [...(color ? ([['color', color]] as Array<[PricingScope, string]>) : []), ...options.map((o) => ['option', o] as [PricingScope, string]), ['base', '']];
}

const isIqdDraft = (d: ScopeDraft) => d.supplier_cost_currency === 'IQD' || (d.supplier_cost_currency === undefined && d.supplier_cost_iqd !== undefined);

/**
 * Why the server would refuse a field (productInputs.ts / ownerRules.ts), so the form says it under the
 * field before anything is sent — never a whole batch lost to one field (owner report 2026-10-10).
 */
export type FieldProblem = 'invalid' | 'separator' | 'too_long' | 'fx_missing' | 'step' | 'needs_amount' | 'needs_currency';

/** A thousands separator or a comma the server cannot read as a decimal comma. */
const SEPARATOR = /[,،٬\s]/;
/** The server's own bounds (packages/pricing costToPrice, productInputs.ts). */
const MAX_SUPPLIER_IQD = 1_000_000_000_000;
const MAX_IQD_AMOUNT = 1_000_000_000;
const MAX_BOX_MM = 100_000;
const MAX_WEIGHT_G = 100_000_000;

/** The server's grammar for a typed decimal (`positiveDecimal` after `typedDecimalText`): null = it will be stored. */
export function decimalProblem(raw: string, maxInt: number, maxFrac: number, maxLen = Infinity): FieldProblem | null {
  const text = typedDecimalText(raw);
  if (SEPARATOR.test(text)) return 'separator';
  try {
    return parseProcurementDecimal(text, { maxIntDigits: maxInt, maxFractionDigits: maxFrac, min: 'positive' }).length > maxLen ? 'too_long' : null;
  } catch {
    return /^\d+(\.\d+)?$/.test(text) && /[1-9]/.test(text) ? 'too_long' : 'invalid';
  }
}

/** The canonical text the server stores for a decimal `decimalProblem` passed (else the typed text, which the server names). */
export function canonicalDecimal(raw: string, maxInt: number, maxFrac: number): string {
  try {
    return parseProcurementDecimal(typedDecimalText(raw), { maxIntDigits: maxInt, maxFractionDigits: maxFrac, min: 'positive' });
  } catch {
    return typedDecimalText(raw);
  }
}

/** The minimum profit exactly as the server's `canonicalUsdRuleAmount` reads it: ≤ 2 decimals, 0 < x ≤ 100,000. */
export function usdRuleProblem(raw: string): FieldProblem | null {
  const text = typedDecimalText(raw);
  if (SEPARATOR.test(text)) return 'separator';
  const m = /^0*([0-9]+)(?:\.([0-9]*?)0*)?$/.exec(text);
  if (!m || text.endsWith('.') || text.startsWith('.')) return 'invalid';
  const whole = m[1]!.replace(/^0+(?=\d)/, '');
  const canonical = m[2] ? `${whole}.${m[2]}` : whole;
  if (canonical.length > 9 || !/^[0-9]+(?:\.[0-9]{1,2})?$/.test(canonical) || !/[1-9]/.test(canonical) || Number(canonical) > 100_000) return 'invalid';
  return null;
}

/**
 * A draft's problems, by field — exactly what the server refuses, by field. `usdIqdRate`: the approved
 * dollar rate as the stored answer says it (null = known to be missing: typed dinars cannot convert;
 * undefined = not known yet, a new product). The same dinars already stored convert nothing.
 */
export function draftProblems(d: ScopeDraft, stored: StoredInputs | null = null, opts: { usdIqdRate?: string | null } = {}): Partial<Record<keyof ScopeDraft, FieldProblem>> {
  const out: Partial<Record<keyof ScopeDraft, FieldProblem>> = {};
  const storedIqd = stored?.supplier_input_mode === 'IQD_CONVERTED';
  if (isIqdDraft(d)) {
    const v = d.supplier_cost_iqd;
    if (v === undefined ? !storedIqd : v !== null && (!Number.isSafeInteger(v) || v < 1 || v > MAX_SUPPLIER_IQD)) out.supplier_cost_iqd = 'invalid';
    else if (opts.usdIqdRate === null && v != null && (!storedIqd || stored?.original_input_amount !== String(v) || d.reconvert === true)) out.supplier_cost_iqd = 'fx_missing';
  } else {
    const amount = d.supplier_cost_amount?.trim();
    const problem = amount ? decimalProblem(amount, 12, 6) : null;
    if (problem) out.supplier_cost_amount = problem;
    // Leaving the dinar input for a source currency needs that currency's amount (never the converted USD reread).
    else if (storedIqd && d.supplier_cost_currency && d.supplier_cost_currency !== 'IQD' && !amount) out.supplier_cost_amount = 'needs_amount';
    // A stored amount keeps a currency (0181): «—» with an amount still there is refused by name.
    if (d.supplier_cost_currency === '' && d.supplier_cost_amount === undefined && !storedIqd && stored?.supplier_cost_amount) out.supplier_cost_currency = 'needs_currency';
  }
  if (d.manual_cbm !== undefined && d.manual_cbm.trim() !== '') {
    const problem = decimalProblem(d.manual_cbm, 3, 9, 12);
    if (problem) out.manual_cbm = problem;
  }
  if (d.minimum_target_profit_usd !== undefined && d.minimum_target_profit_usd.trim() !== '') {
    const problem = usdRuleProblem(d.minimum_target_profit_usd);
    if (problem) out.minimum_target_profit_usd = problem;
  }
  if (d.direct_sale_extra_iqd != null) {
    if (!Number.isSafeInteger(d.direct_sale_extra_iqd) || d.direct_sale_extra_iqd > MAX_IQD_AMOUNT) out.direct_sale_extra_iqd = 'too_long';
    else if (d.direct_sale_extra_iqd % 1000 !== 0) out.direct_sale_extra_iqd = 'step';
  }
  if (d.additional_cost_iqd != null && (!Number.isSafeInteger(d.additional_cost_iqd) || d.additional_cost_iqd > MAX_IQD_AMOUNT)) out.additional_cost_iqd = 'too_long';
  if (d.box && d.box.some((a) => a > MAX_BOX_MM)) out.box = 'too_long';
  if (d.shipping_weight_g != null && d.shipping_weight_g > MAX_WEIGHT_G) out.shipping_weight_g = 'too_long';
  return out;
}

/** A problem's words under its field, in the reader's language. */
export function problemText(field: keyof ScopeDraft, code: FieldProblem, s: UsdPricingFormStrings, ps: ProcurementPricingStrings): string {
  if (code === 'separator') return s.decimalSeparator;
  if (code === 'too_long') return s.decimalTooLong;
  if (code === 'fx_missing') return s.iqdNeedsRate;
  if (code === 'step') return s.extraInvalid;
  if (code === 'needs_currency') return s.currencyNeeded;
  if (field === 'supplier_cost_iqd') return s.iqdInvalid;
  if (field === 'minimum_target_profit_usd') return ps.invalid;
  if (field === 'direct_sale_extra_iqd') return s.extraInvalid;
  return s.decimalInvalid;
}

/** A draft field's label, as the panel shows it. */
export function draftFieldLabel(field: keyof ScopeDraft, s: UsdPricingFormStrings): string {
  const labels: Partial<Record<keyof ScopeDraft, string>> = {
    supplier_cost_amount: s.supplierCost,
    supplier_cost_currency: s.supplierCurrency,
    supplier_cost_iqd: s.supplierCostIqd,
    reconvert: s.supplierCostIqd,
    shipping_profile: s.route,
    shipping_weight_g: s.weightKg,
    box: s.boxLabel,
    manual_cbm: s.manualCbm,
    additional_cost_iqd: s.additional,
    minimum_target_profit_usd: s.minProfit,
    direct_sale_extra_iqd: s.extra,
  };
  return labels[field] ?? field;
}

/** A field the server names in a refusal (`details.field`, `inputs[i].` / `rules[i].` dropped) → the draft field it is. */
const SERVER_FIELDS: Readonly<Record<string, keyof ScopeDraft>> = {
  supplier_cost_amount: 'supplier_cost_amount',
  supplier_cost_currency: 'supplier_cost_currency',
  shipping_profile: 'shipping_profile',
  shipping_weight_g: 'shipping_weight_g',
  manual_cbm: 'manual_cbm',
  additional_cost_iqd: 'additional_cost_iqd',
  shipping_box: 'box',
  shipping_length_mm: 'box',
  shipping_width_mm: 'box',
  shipping_height_mm: 'box',
  supplier_cost_iqd: 'supplier_cost_iqd',
  reconvert: 'supplier_cost_iqd',
  amount_usd: 'minimum_target_profit_usd',
  minimum_target_profit_usd: 'minimum_target_profit_usd',
  amount_iqd: 'direct_sale_extra_iqd',
  direct_sale_extra_iqd: 'direct_sale_extra_iqd',
};
const serverFieldName = (raw: string) => raw.replace(/^(?:inputs|rules)\[\d+\]\./, '');

/** The panel's own label for a field a refusal names (null: no field of the panel). */
export function fieldLabelOf(field: string, s: UsdPricingFormStrings): string | null {
  const f = SERVER_FIELDS[serverFieldName(field)];
  return f ? draftFieldLabel(f, s) : null;
}

const scopeOf = (answer: UsdPricingAnswer | null, scope: PricingScope, id: string) =>
  answer?.scopes.find((s) => s.scope === scope && (scope === 'base' || s.scope_id === id)) ?? null;

/**
 * The measure a scope's pricing takes from the form (see the file header): the
 * form's value when it differs from the stored pricing measure and the owner
 * edited it since the load, adopted it, or the pricing measure is empty.
 * Clearing a package measurement never clears a pricing one.
 */
export function measureDraftOf(form: PackageMeasure, saved: PackageMeasure, row: StoredInputs | null, adopt: boolean): Pick<ScopeDraft, 'shipping_weight_g' | 'box'> {
  const out: Pick<ScopeDraft, 'shipping_weight_g' | 'box'> = {};
  const weight = row?.shipping_weight_g ?? null;
  if (form.weight_g !== null && form.weight_g !== weight && (adopt || weight === null || form.weight_g !== saved.weight_g)) out.shipping_weight_g = form.weight_g;
  const box = rowBox(row);
  if (form.box && !sameBox(form.box, box) && (adopt || box === null || !sameBox(form.box, saved.box))) out.box = form.box;
  return out;
}

/** The route a scope prices on: its own (typed, then stored), else the nearest level above that has one. */
export function routeOf(drafts: Readonly<Record<string, ScopeDraft>>, answer: UsdPricingAnswer | null, scope: PricingScope, id: string, form: UsdPricingFormContext | null = null): string {
  const own = (s: PricingScope, i: string) => {
    const typed = drafts[keyOf(s, i)]?.shipping_profile;
    return typed !== undefined ? typed : (scopeOf(answer, s, i)?.pricing_inputs?.shipping_profile ?? '');
  };
  for (const [s, i] of [[scope, id] as [PricingScope, string], ...ancestorsOf(form, scope, id)]) {
    const r = own(s, i);
    if (r) return r;
  }
  return '';
}

const hasContent = (d: ScopeDraft) => (Object.keys(d) as Array<keyof ScopeDraft>).some((k) => k !== 'adopt_measure' && d[k] !== undefined);

/** The drafts as they would be saved: what was typed, plus the measure each scope takes from the form. */
export function effectiveDrafts(drafts: Readonly<Record<string, ScopeDraft>>, answer: UsdPricingAnswer | null, form: UsdPricingFormContext): Record<string, ScopeDraft> {
  const out: Record<string, ScopeDraft> = {};
  const keys = new Set<string>([
    'base',
    ...Object.keys(drafts),
    ...(answer?.scopes ?? []).filter((s) => s.scope !== 'base').map((s) => keyOf(s.scope, s.scope_id)),
    ...form.models.map((m) => keyOf('option', m.id)),
    // FX-7: the colours (the variant rows come from the server's scopes) — only with the SKU rung.
    ...(answer?.sku_levels ? (form.colours ?? []).map((c) => keyOf('color', c.id)) : []),
  ]);
  for (const key of keys) {
    const { scope, id } = parseKey(key);
    // A model, colour or variant removed from the form (and unknown to the server) takes its drafts with it.
    if (scope === 'option' && !scopeOf(answer, 'option', id) && !form.models.some((m) => m.id === id)) continue;
    if (scope === 'color' && !scopeOf(answer, 'color', id) && !(form.colours ?? []).some((c) => c.id === id)) continue;
    if (scope === 'sku' && !scopeOf(answer, 'sku', id) && !(form.skus ?? []).some((k) => k.combo_key === id)) continue;
    const typed = drafts[key] ?? {};
    const route = routeOf(drafts, answer, scope, id, form);
    let derived: Pick<ScopeDraft, 'shipping_weight_g' | 'box'> = {};
    if (route) {
      const m = measureDraftOf(
        packageMeasureOf(dimensionsOf(form, scope, id)),
        packageMeasureOf(dimensionsOf(form, scope, id, true)),
        scopeOf(answer, scope, id)?.pricing_inputs ?? null,
        typed.adopt_measure === true
      );
      // Only the measure the route prices by: the box for sea freight, the weight otherwise.
      derived = route === 'CHINA_SEA' ? (m.box !== undefined ? { box: m.box } : {}) : m.shipping_weight_g !== undefined ? { shipping_weight_g: m.shipping_weight_g } : {};
    }
    const merged: ScopeDraft = { ...derived, ...typed };
    if (hasContent(merged)) out[key] = merged;
  }
  return out;
}

const blank = (v: string | undefined) => (v === undefined ? undefined : v.trim() === '' ? null : v.trim());

/** The drafts → the request's `{inputs, rules}` (only what was touched, only scopes the server knows). */
export function draftWire(drafts: Readonly<Record<string, ScopeDraft>>, answer: UsdPricingAnswer) {
  const inputs: Array<Record<string, unknown>> = [];
  const rules: Array<Record<string, unknown>> = [];
  for (const s of answer.scopes) {
    const d = drafts[keyOf(s.scope, s.scope_id)];
    if (!d) continue;
    const entry: Record<string, unknown> = { scope: s.scope, ...(s.scope !== 'base' ? { scope_id: s.scope_id } : {}) };
    if (isIqdDraft(d)) {
      // The convenience input: whole dinars; the server converts them once (the client never sends USD or a rate).
      if (d.supplier_cost_iqd != null) {
        entry.supplier_cost_iqd = d.supplier_cost_iqd;
        if (d.reconvert) entry.reconvert = true;
      } else if (d.supplier_cost_iqd === null) entry.supplier_cost_amount = null;
    } else {
      // The canonical text the server stores («٨٩٩٫٥» → '899.5'), so a preview and a save read one number.
      if (d.supplier_cost_amount !== undefined) {
        const typed = blank(d.supplier_cost_amount);
        entry.supplier_cost_amount = typed == null ? typed : canonicalDecimal(typed, 12, 6);
      }
      if (d.supplier_cost_currency !== undefined) entry.supplier_cost_currency = d.supplier_cost_currency || null;
      // A typed amount always names its currency (the stored one when untouched, USD when none).
      if (d.supplier_cost_amount !== undefined && blank(d.supplier_cost_amount) !== null && entry.supplier_cost_currency == null) {
        const stored = s.pricing_inputs?.supplier_input_mode === 'IQD_CONVERTED' ? null : s.pricing_inputs?.supplier_cost_currency;
        entry.supplier_cost_currency = stored ?? 'USD';
      }
    }
    if (d.shipping_profile !== undefined) entry.shipping_profile = d.shipping_profile || null;
    if (d.shipping_weight_g !== undefined) entry.shipping_weight_g = d.shipping_weight_g;
    if (d.box !== undefined) {
      entry.shipping_length_mm = d.box?.[0] ?? null;
      entry.shipping_width_mm = d.box?.[1] ?? null;
      entry.shipping_height_mm = d.box?.[2] ?? null;
    }
    if (d.manual_cbm !== undefined) {
      const typed = blank(d.manual_cbm);
      entry.manual_cbm = typed == null ? typed : canonicalDecimal(typed, 3, 9);
    }
    if (d.additional_cost_iqd !== undefined) entry.additional_cost_iqd = d.additional_cost_iqd;
    if (Object.keys(entry).length > (s.scope !== 'base' ? 2 : 1)) inputs.push(entry);
    const ruleScope = s.scope === 'base' ? 'product' : s.scope;
    const at = s.scope !== 'base' ? { scope_id: s.scope_id } : {};
    if (d.minimum_target_profit_usd !== undefined) {
      const typed = blank(d.minimum_target_profit_usd);
      rules.push({ kind: 'target_profit', scope: ruleScope, ...at, amount_usd: typed == null ? typed : typedDecimalText(typed) });
    }
    if (d.direct_sale_extra_iqd !== undefined) rules.push({ kind: 'direct_sale_extra', scope: ruleScope, ...at, amount_iqd: d.direct_sale_extra_iqd });
  }
  return { inputs, rules };
}

const wireHasIqd = (wire: { inputs: Array<Record<string, unknown>> }) => wire.inputs.some((e) => e.supplier_cost_iqd !== undefined);

/** A new product's answer before its first save: the product scope only, nothing stored. */
const NEW_PRODUCT_ANSWER: UsdPricingAnswer = {
  product_id: '',
  mode: 'manual',
  inputs_seq: 0,
  rates: { usd_iqd_rate: null, review_pending: false, derived_stale: false },
  scopes: [
    {
      scope: 'base', scope_id: '', name_ar: '', name_en: '', name_ckb: '', pricing_inputs: null, minimum_target_profit_usd: null,
      target_profit_iqd: null, target_profit_state: null, direct_sale_extra_iqd: null, direct_sale_extra_state: null,
    },
  ],
  models: [],
  rows: [],
  preview_hash: '',
};

// ------------------------------------------------------------------ the state

/** The drafts at the moment the product's save starts, with the preview that showed them (its conversion hash). */
export interface PricingSnapshot {
  drafts: Record<string, ScopeDraft>;
  invalid: boolean;
  preview: { wire: string; answer: UsdPricingAnswer } | null;
}

/**
 * The new prices awaiting the owner's look (owner decision 8): a complete manual product whose data is
 * stored (`stored`: cancelling — «لاحقًا» — loses nothing), or an engine product's held save (409
 * PRICING_PREVIEW_REQUIRED / _STALE / PRICING_LARGE_CHANGE_CONFIRM carry the preview; nothing is stored
 * until «حفظ» sends the same body with the preview's hash).
 */
export interface PricingReview {
  pid: string;
  body: { inputs_seq: number; inputs: unknown[]; rules: unknown[] };
  hash: string;
  adoption: EngineAdoption;
  error: string;
  stored: boolean;
}

const REVIEW_CODES = new Set(['PRICING_PREVIEW_REQUIRED', 'PRICING_PREVIEW_STALE', 'PRICING_LARGE_CHANGE_CONFIRM']);

/** The preview a held save carries, when it writes prices (else null: the refusal stands). */
export function heldPreview(e: unknown): UsdPricingAnswer | null {
  if (!(e instanceof ApiError) || !REVIEW_CODES.has(e.code ?? '')) return null;
  const shown = (e.details as { preview?: UsdPricingAnswer } | undefined)?.preview;
  return shown && shown.adoption?.kind && typeof shown.preview_hash === 'string' && shown.preview_hash ? shown : null;
}

/** A stored answer whose prices a confirm would write: the review the sheet opens (the data is saved). */
export function readyReview(pid: string, r: UsdPricingAnswer | null): PricingReview | null {
  return r && r.adoption?.kind && r.adoption.needs_write && r.adoption.complete && r.preview_hash
    ? { pid, body: { inputs_seq: r.inputs_seq, inputs: [], rules: [] }, hash: r.preview_hash, adoption: r.adoption, error: '', stored: true }
    : null;
}

/**
 * An older server's conversion hash (no `conversion_hash` in its answer): the preview's own hash, and only
 * when that preview writes no price — a save that writes prices never rides on the live preview's hash.
 */
export const legacyConversionHash = (preview: { wire: string; answer: UsdPricingAnswer } | null, w: string): string | null =>
  preview && preview.wire === w && !preview.answer.adoption?.kind ? preview.answer.preview_hash : null;

/** The requests the save makes (the form's `api`; a test drives the real routes through it). */
export interface PricingIo {
  get: (path: string) => Promise<UsdPricingAnswer>;
  post: (path: string, body: unknown) => Promise<UsdPricingAnswer>;
  put: (path: string, body: unknown) => Promise<UsdPricingAnswer>;
}
export const inputsPath = (pid: string) => `${PRICING}/products/${encodeURIComponent(pid)}/inputs`;
export const previewPath = (pid: string) => `${PRICING}/products/${encodeURIComponent(pid)}/preview`;

/** Where a refusal belongs: the draft (and field) it names, and the section it lives in (٣ the product, ٥ a model, colour or variant). */
export interface RefusalTarget {
  key: string | null;
  field: keyof ScopeDraft | null;
  section: 3 | 5;
}

const baseFirst = (a: string, b: string) => (a === 'base' ? -1 : b === 'base' ? 1 : 0);

export function refusalTarget(e: unknown, drafts: Readonly<Record<string, ScopeDraft>>): RefusalTarget {
  if (!(e instanceof ApiError)) return { key: null, field: null, section: 3 };
  const d = (e.details ?? {}) as { field?: unknown; scope?: unknown; scope_id?: unknown };
  const field = typeof d.field === 'string' ? (SERVER_FIELDS[serverFieldName(d.field)] ?? null) : null;
  let key: string | null = null;
  if (e.code === 'PRICING_FX_RATE_MISSING' && typeof d.scope === 'string') key = keyOf(d.scope as PricingScope, typeof d.scope_id === 'string' ? d.scope_id : '');
  else if (field) key = Object.keys(drafts).sort(baseFirst).find((k) => drafts[k]![field] !== undefined) ?? null;
  const named = e.code === 'PRICING_FX_RATE_MISSING' ? 'supplier_cost_iqd' : field;
  return { key, field: named, section: !key || key === 'base' ? 3 : 5 };
}

export type CommitResult =
  | { kind: 'nothing'; answer: UsdPricingAnswer; ready: PricingReview | null }
  | { kind: 'saved'; answer: UsdPricingAnswer; ready: PricingReview | null; converted: string[] }
  | { kind: 'held'; answer: UsdPricingAnswer; review: PricingReview }
  | { kind: 'refused'; error: unknown; target: RefusalTarget };

const isStaleHash = (e: unknown) =>
  e instanceof ApiError && (e.code === 'PRICING_PREVIEW_STALE' || (e.code === 'PRICING_INPUT_INVALID' && (e.details as { field?: string } | undefined)?.field === 'preview_hash'));
const refusesDataOnly = (e: unknown) =>
  e instanceof ApiError && e.code === 'UNKNOWN_FIELD' && Array.isArray((e.details as { fields?: unknown } | undefined)?.fields) && ((e.details as { fields: unknown[] }).fields.includes('data_only'));

type WireBody = ReturnType<typeof draftWire>;

/**
 * ONE SAVE PATH for «حفظ التسعير بالدولار», «نشر» and «مسودة» (owner report 2026-10-10). The drafts go
 * against the answer the server holds now (`base`, else a fresh GET), as data first (`data_only`): a
 * manual product's data is stored even when it completes the product, and the answer then carries the
 * review its new prices need (`ready`). Typed dinars carry the conversion hash of a preview that showed
 * them (the cached one, else a fresh look; one more fresh look when the rate moved in between). An engine
 * product — or an older server that refuses `data_only` (retried once without it) — holds the save for
 * the sheet. Pure: every request goes through `io`; nothing is stored in the browser.
 */
export async function commitPricing(
  io: PricingIo,
  pid: string,
  drafts: Readonly<Record<string, ScopeDraft>>,
  opts: { base?: UsdPricingAnswer | null; preview?: { wire: string; answer: UsdPricingAnswer } | null; describe?: (shown: UsdPricingAnswer, body: WireBody) => string[] } = {}
): Promise<CommitResult> {
  const refused = (e: unknown): CommitResult => ({ kind: 'refused', error: e, target: refusalTarget(e, drafts) });
  let current: UsdPricingAnswer;
  try {
    current = opts.base ?? (await io.get(inputsPath(pid)));
  } catch (e) {
    return refused(e);
  }
  const body = draftWire(drafts, current);
  if (!body.inputs.length && !body.rules.length) return { kind: 'nothing', answer: current, ready: readyReview(pid, current) };
  const wire = JSON.stringify(body);
  const typedIqd = wireHasIqd(body);
  const conversion = async (fresh: boolean) => {
    if (!typedIqd) return { hash: null as string | null, converted: [] as string[] };
    const shown = !fresh && opts.preview && opts.preview.wire === wire ? opts.preview.answer : await io.post(previewPath(pid), { draft: body });
    return { hash: shown.conversion_hash ?? legacyConversionHash({ wire, answer: shown }, wire), converted: opts.describe?.(shown, body) ?? [] };
  };
  let conv: { hash: string | null; converted: string[] };
  try {
    conv = await conversion(false);
  } catch (e) {
    return refused(e);
  }
  let dataOnly = true;
  let reread = false;
  for (;;) {
    try {
      const r = await io.put(inputsPath(pid), { inputs_seq: current.inputs_seq, ...body, ...(dataOnly ? { data_only: true } : {}), ...(conv.hash ? { preview_hash: conv.hash } : {}) });
      return { kind: 'saved', answer: r, ready: readyReview(pid, r), converted: conv.converted };
    } catch (e) {
      // Owner decision 8 for an engine product (or an older server): held, with the preview of its new prices.
      const held = heldPreview(e);
      if (held) {
        // The body without `data_only`: the sheet's «حفظ» is the one write, with the preview's hash.
        const review: PricingReview = { pid, body: { inputs_seq: current.inputs_seq, inputs: body.inputs, rules: body.rules }, hash: held.preview_hash, adoption: held.adoption!, error: '', stored: false };
        return { kind: 'held', answer: current, review };
      }
      if (dataOnly && refusesDataOnly(e)) {
        dataOnly = false;
        continue;
      }
      if (typedIqd && !reread && isStaleHash(e)) {
        // The rate moved since the conversion the owner was shown: one fresh look, then the save again.
        reread = true;
        try {
          conv = await conversion(true);
        } catch (e2) {
          return refused(e2);
        }
        continue;
      }
      return refused(e);
    }
  }
}

/** «حُوِّل X د.ع إلى $Y بسعر Z» for every scope whose typed dinars the shown preview converts. */
export function convertedLines(shown: UsdPricingAnswer, body: WireBody, fill: (amount: string, usd: string, rate: string) => string): string[] {
  const out: string[] = [];
  for (const e of body.inputs) {
    if (typeof e.supplier_cost_iqd !== 'number') continue;
    const sc = scopeOf(shown, e.scope as PricingScope, typeof e.scope_id === 'string' ? e.scope_id : '');
    const p = sc?.pricing_inputs;
    if (p?.supplier_input_mode === 'IQD_CONVERTED' && p.original_input_amount === String(e.supplier_cost_iqd) && p.supplier_cost_amount && p.conversion_rate_snapshot)
      out.push(fill(e.supplier_cost_iqd.toLocaleString('en-US'), p.supplier_cost_amount, p.conversion_rate_snapshot));
  }
  return out;
}

/** The name of a scope as the owner reads it (the product level, a model, a colour, a variant). */
function scopeName(key: string, answer: UsdPricingAnswer | null, form: UsdPricingFormContext | null, lang: Language, s: UsdPricingFormStrings): string {
  const { scope, id } = parseKey(key);
  if (scope === 'base') return s.productLevel;
  const known = scopeOf(answer, scope, id) ?? (scope === 'option' ? form?.models.find((m) => m.id === id) : scope === 'color' ? form?.colours?.find((c) => c.id === id) : null) ?? null;
  return known ? nameOf(known, lang) : id;
}

/**
 * Every field that cannot be saved, «<scope> · <field>: <reason>», and the section the first lives in —
 * what «حفظ التسعير بالدولار», «نشر» and the form's bar say instead of saving it.
 */
export function invalidWhere(
  effective: Readonly<Record<string, ScopeDraft>>,
  answer: UsdPricingAnswer | null,
  form: UsdPricingFormContext | null,
  lang: Language
): { text: string; section: 3 | 5 } {
  const s = usdPricingFormStrings(lang);
  const ps = procurementPricingStrings(lang);
  const usdIqdRate = answer?.product_id ? answer.rates.usd_iqd_rate : undefined;
  const parts: string[] = [];
  let section: 3 | 5 | null = null;
  for (const key of Object.keys(effective).sort(baseFirst)) {
    const { scope, id } = parseKey(key);
    const problems = draftProblems(effective[key]!, scopeOf(answer, scope, id)?.pricing_inputs ?? null, { usdIqdRate });
    const fields = Object.keys(problems) as Array<keyof ScopeDraft>;
    if (!fields.length) continue;
    section ??= key === 'base' ? 3 : 5;
    const name = scopeName(key, answer, form, lang, s);
    for (const f of fields) parts.push(`${name} · ${draftFieldLabel(f, s)}: ${problemText(f, problems[f]!, s, ps)}`);
  }
  return { text: parts.join(lang === 'en' ? '; ' : '؛ '), section: section ?? 3 };
}

/** A pricing save's outcome, said in the panel and the form's bar until the owner types again (a preview never wipes it). */
export interface PricingOutcome {
  kind: 'saved' | 'ready' | 'held' | 'refused' | 'invalid';
  tone: 'ok' | 'warn' | 'error';
  text: string;
  /** Where the field it names lives: section ٣ (the product) or ٥ (a model, a colour, a variant). */
  section?: 3 | 5;
}

/** A refusal the server answered for one field of one scope: said under that field. */
export interface ServerField {
  key: string;
  field: keyof ScopeDraft;
  text: string;
}

export interface UsdPricingState {
  enabled: boolean;
  productId: string | null;
  form: UsdPricingFormContext;
  /** The stored answer (a new product's empty one before its first save). */
  answer: UsdPricingAnswer | null;
  /** The answer for the drafts (live preview), else the stored one. */
  shown: UsdPricingAnswer | null;
  drafts: Record<string, ScopeDraft>;
  /** The drafts as they would be saved (typed + measures taken from the form). */
  effective: Record<string, ScopeDraft>;
  dirty: boolean;
  /** The owner typed (or adopted) something not saved yet — leaving the form asks first. */
  touched: boolean;
  invalid: boolean;
  /** Each field that cannot be saved, «<scope> · <field>: <reason>» ('' when none). */
  invalidWhere: string;
  busy: boolean;
  saving: boolean;
  notInstalled: boolean;
  error: string;
  notice: string;
  /** The last save's outcome (saved / ready / held / refused / invalid), until the owner types again. */
  outcome: PricingOutcome | null;
  /** A refusal the server named for one field: said under that field. */
  serverField: ServerField | null;
  /** The stored answer says no dollar rate is approved (unknown for a new product). */
  rateKnownMissing: boolean;
  /** The engine prices this product (its store price is then read-only in the form). */
  engine: boolean;
  setDraft: (scope: PricingScope, id: string, patch: ScopeDraft) => void;
  discard: () => void;
  save: () => Promise<void>;
  reload: () => void;
  /** Taken just before the product's own save (null when there is nothing to save). */
  snapshot: () => PricingSnapshot | null;
  /** After the product's save: the snapshot through the pricing door for the saved id. */
  saveAfterProduct: (productId: string, snap: PricingSnapshot) => Promise<{ ok: boolean; message: string }>;
  /** After a product save with no pricing drafts: the fresh answer, and the preview when that save completed the product. */
  afterProductSaved: (productId: string) => Promise<void>;
  /** The new prices awaiting the owner's look (the sheet). */
  review: PricingReview | null;
  reviewBusy: boolean;
  confirmReview: (confirmLarge: boolean) => Promise<void>;
  cancelReview: () => void;
  /** «راجع السعر الجديد واعتمده»: the sheet again, for stored data that is complete. */
  openReview: () => void;
  /** «رجوع إلى التسعير اليدوي»: the prices stay exactly as they are and are edited by hand again. */
  exitEngine: () => Promise<void>;
}

export function useUsdPricingState({ productId, enabled, form, onPricesWritten }: {
  productId: string | null;
  enabled: boolean;
  form: UsdPricingFormContext;
  /** The engine wrote the product's prices: the form reads the product again (its prices and the lock). */
  onPricesWritten?: (productId: string) => void;
}): UsdPricingState {
  const { lang } = useLanguage();
  const s = usdPricingFormStrings(lang);
  const es = engineSaveStrings(lang);
  const [review, setReview] = useState<PricingReview | null>(null);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [stored, setStored] = useState<UsdPricingAnswer | null>(null);
  const [preview, setPreview] = useState<{ wire: string; answer: UsdPricingAnswer } | null>(null);
  const [drafts, setDrafts] = useState<Record<string, ScopeDraft>>({});
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notInstalled, setNotInstalled] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [outcome, setOutcome] = useState<PricingOutcome | null>(null);
  const [serverField, setServerField] = useState<ServerField | null>(null);
  // The ready reviews the owner put off with «لاحقًا» (by hash): a later product save does not reopen them.
  const dismissed = useRef(new Set<string>());
  const [tick, setTick] = useState(0);
  const [previewTick, setPreviewTick] = useState(0);
  const live = enabled && !!productId;
  // A refusal in the reader's language, naming the panel's own field («{field}» is never printed).
  const message = useCallback((e: unknown) => contractRefusal(e, refusalLang(lang), e instanceof Error ? e.message : String(e), (f) => fieldLabelOf(f, s)), [lang, s]);
  const io = useMemo<PricingIo>(
    () => ({
      get: (p) => api.get<UsdPricingAnswer>(p, { mascot: 'silent' }),
      post: (p, b) => api.post<UsdPricingAnswer>(p, b, { mascot: 'silent' }),
      put: (p, b) => api.put<UsdPricingAnswer>(p, b, { mascot: 'silent' }),
    }),
    []
  );

  // Another product: its own drafts (a new product's first save keeps what was typed for it).
  const previousId = useRef(productId);
  useEffect(() => {
    if (previousId.current && previousId.current !== productId) {
      setDrafts({});
      setStored(null);
      setPreview(null);
      setOutcome(null);
      setServerField(null);
      dismissed.current.clear();
    }
    previousId.current = productId;
  }, [productId]);

  useEffect(() => {
    if (!live) return;
    const ctrl = new AbortController();
    setBusy(true);
    api
      .get<UsdPricingAnswer>(inputsPath(productId!), { signal: ctrl.signal, mascot: 'silent' })
      .then((r) => {
        setStored(r);
        setPreview(null);
        setError('');
      })
      .catch((e) => {
        if (isAborted(e)) return;
        if (e instanceof ApiError && e.code === 'PRICING_NOT_INSTALLED') setNotInstalled(true);
        else setError(message(e));
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setBusy(false);
      });
    return () => ctrl.abort();
  }, [live, productId, tick, message]);

  const answer = enabled ? (productId ? stored : NEW_PRODUCT_ANSWER) : null;
  const effective = useMemo(() => (answer ? effectiveDrafts(drafts, answer, form) : {}), [drafts, answer, form]);
  const dirty = Object.keys(effective).length > 0;
  // What the owner typed or adopted (the measures the form derives do not count: opening a product never nags).
  const touched = Object.values(drafts).some((d) => (Object.keys(d) as Array<keyof ScopeDraft>).some((k) => (k === 'adopt_measure' ? d[k] === true : d[k] !== undefined)));
  const rateKnownMissing = !!answer?.product_id && answer.rates.usd_iqd_rate === null;
  const where = useMemo(() => invalidWhere(effective, answer, form, lang), [effective, answer, form, lang]);
  const invalid = where.text !== '';
  const wireObject = useMemo(() => (answer && productId && dirty && !invalid ? draftWire(effective, answer) : null), [answer, productId, dirty, invalid, effective]);
  const wire = wireObject && (wireObject.inputs.length || wireObject.rules.length) ? JSON.stringify(wireObject) : '';

  // The live preview: the server prices the drafts as they would be saved (debounced, latest wins).
  useEffect(() => {
    if (!live || !wire) return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      setBusy(true);
      api
        .post<UsdPricingAnswer>(previewPath(productId!), { draft: JSON.parse(wire) }, { signal: ctrl.signal, mascot: 'silent' })
        .then((r) => {
          setPreview({ wire, answer: r });
          setError('');
        })
        .catch((e) => {
          if (isAborted(e)) return;
          setError(message(e));
        })
        .finally(() => {
          if (!ctrl.signal.aborted) setBusy(false);
        });
    }, 450);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [live, productId, wire, previewTick, message]);

  const shown = wire ? (preview?.answer ?? answer) : answer;

  const setDraft = useCallback((scope: PricingScope, id: string, patch: ScopeDraft) => {
    const key = keyOf(scope, id);
    setNotice('');
    // A new keystroke is a new question: the last outcome and the server's word on this scope give way.
    setOutcome(null);
    setServerField((f) => (f && f.key === key ? null : f));
    setDrafts((all) => ({ ...all, [key]: { ...all[key], ...patch } }));
  }, []);
  const discard = useCallback(() => {
    setDrafts({});
    setPreview(null);
    setError('');
    setOutcome(null);
    setServerField(null);
  }, []);

  /** Drafts for models the server does not know yet (unsaved) stay; the rest were saved. */
  const keepUnsent = useCallback((all: Record<string, ScopeDraft>, after: UsdPricingAnswer) => {
    const out: Record<string, ScopeDraft> = {};
    for (const [k, d] of Object.entries(all)) {
      const { scope, id } = parseKey(k);
      if (!scopeOf(after, scope, id)) out[k] = d;
    }
    return out;
  }, []);

  /** A refusal's words (with what an engine product misses), and its side effects: a fresh look, a fresh read. */
  const failed = useCallback(
    async (e: unknown, pid: string): Promise<string> => {
      const stale = isStaleHash(e);
      // An engine product never loses its price: a save that would leave it incomplete is refused, naming what is missing.
      const missing = e instanceof ApiError && e.code === 'PRICING_ENGINE_INCOMPLETE' ? ((e.details as { missing_codes?: string[] } | undefined)?.missing_codes ?? []) : [];
      const text = stale ? `${message(e)} — ${s.reviewConversion}` : missing.length ? `${message(e)} — ${missing.map((c) => issueText(c, lang)).join(lang === 'en' ? '; ' : '؛ ')}` : message(e);
      if (stale) setPreviewTick((t) => t + 1);
      // Someone else saved first (a purchase applied, another tab): show the fresh values, keep the typed ones.
      if (e instanceof ApiError && e.code === 'PRICING_CHANGED') {
        try {
          setStored(await io.get(inputsPath(pid)));
        } catch {
          /* the message above stands */
        }
      }
      return text;
    },
    [message, s.reviewConversion, lang, io]
  );

  const describe = useCallback((shownAnswer: UsdPricingAnswer, body: WireBody) => convertedLines(shownAnswer, body, s.converted), [s]);

  /** One save's result → the store, the drafts, the sheet and the outcome (never silent). */
  const apply = useCallback(
    async (res: CommitResult, pid: string, alone: boolean): Promise<PricingOutcome | null> => {
      let out: PricingOutcome | null;
      if (res.kind === 'refused') {
        const m = await failed(res.error, pid);
        out = { kind: 'refused', tone: 'error', text: alone ? s.notSavedAlone(m) : s.pricingNotSaved(m), section: res.target.section };
        if (res.target.key && res.target.field) setServerField({ key: res.target.key, field: res.target.field, text: m });
      } else if (res.kind === 'held') {
        // The new prices wait for the owner's look (the sheet); nothing is stored, the drafts stay.
        setStored(res.answer);
        setReview(res.review);
        out = { kind: 'held', tone: 'warn', text: s.heldNotSaved };
      } else {
        setStored(res.answer);
        setServerField(null);
        if (res.kind === 'saved') {
          setPreview(null);
          setDrafts((all) => keepUnsent(all, res.answer));
        }
        const ready = res.ready && !dismissed.current.has(res.ready.hash) ? res.ready : null;
        if (ready) {
          // Stored, and complete: the new price is the owner's to adopt («لاحقًا» loses nothing).
          setReview(ready);
          out = { kind: 'ready', tone: 'warn', text: res.kind === 'saved' ? s.savedDataReady : s.readyWaiting };
        } else if (res.kind === 'saved') {
          const text = [alone ? s.saved : s.savedWithProduct, ...res.converted].join(' · ');
          setNotice(text);
          out = { kind: 'saved', tone: 'ok', text };
        } else out = null;
      }
      setOutcome(out);
      return out;
    },
    [failed, s, keepUnsent]
  );

  const saveRef = useRef(false);
  const save = useCallback(async () => {
    if (!stored || !productId || saveRef.current || !dirty) return;
    if (invalid) {
      // Never sent: the panel says which field, of which scope, and why.
      setOutcome({ kind: 'invalid', tone: 'error', text: s.saveBlocked(where.text), section: where.section });
      return;
    }
    saveRef.current = true;
    setSaving(true);
    setError('');
    try {
      await apply(await commitPricing(io, productId, effective, { base: stored, preview, describe }), productId, true);
    } finally {
      saveRef.current = false;
      setSaving(false);
    }
  }, [stored, productId, dirty, invalid, s, where, apply, io, effective, preview, describe]);

  const snapshot = useCallback((): PricingSnapshot | null => {
    if (!enabled || !dirty) return null;
    return { drafts: JSON.parse(JSON.stringify(effective)) as Record<string, ScopeDraft>, invalid, preview: preview && preview.wire === wire ? preview : null };
  }, [enabled, dirty, effective, invalid, preview, wire]);

  const saveAfterProduct = useCallback(
    async (pid: string, snap: PricingSnapshot) => {
      // The typed values become explicit drafts, so a refusal never loses them (the form's measures are saved by now).
      setDrafts(snap.drafts);
      if (snap.invalid) {
        const why = invalidWhere(snap.drafts, answer, form, lang);
        const out: PricingOutcome = { kind: 'invalid', tone: 'error', text: s.pricingNotSaved(why.text), section: why.section };
        setOutcome(out);
        return { ok: false, message: out.text };
      }
      setSaving(true);
      setError('');
      try {
        const res = await commitPricing(io, pid, snap.drafts, { preview: snap.preview, describe });
        const out = await apply(res, pid, false);
        // The product's save moved its models and channels: read the answer again.
        setTick((t) => t + 1);
        return { ok: res.kind !== 'refused', message: out?.text ?? '' };
      } finally {
        setSaving(false);
      }
    },
    [answer, form, lang, s, io, describe, apply]
  );

  /** A product save with no pricing drafts: when the stored data is complete (or its rates moved), the sheet. */
  const afterProductSaved = useCallback(
    async (pid: string) => {
      try {
        const r = await io.get(inputsPath(pid));
        setStored(r);
        setPreview(null);
        const ready = readyReview(pid, r);
        if (ready && !dismissed.current.has(ready.hash)) {
          setReview(ready);
          setOutcome({ kind: 'ready', tone: 'warn', text: s.readyWaiting });
        }
      } catch (e) {
        if (!isAborted(e)) setError(message(e));
      }
    },
    [io, message, s.readyWaiting]
  );

  const openReview = useCallback(() => {
    const ready = stored ? readyReview(stored.product_id, stored) : null;
    if (!ready) return;
    dismissed.current.delete(ready.hash);
    setReview(ready);
  }, [stored]);

  const reviewRef = useRef(false);
  const confirmReview = useCallback(
    async (confirmLarge: boolean) => {
      const held = review;
      if (!held || reviewRef.current) return;
      reviewRef.current = true;
      setReviewBusy(true);
      try {
        const r = await api.put<UsdPricingAnswer>(
          inputsPath(held.pid),
          { ...held.body, preview_hash: held.hash, ...(confirmLarge ? { confirm_large_change: true } : {}) },
          { mascot: 'silent' }
        );
        setReview(null);
        setStored(r);
        setPreview(null);
        setError('');
        setDrafts((all) => keepUnsent(all, r));
        const done = held.adoption.kind === 'adopt' ? es.savedAdopted : es.savedRepriced;
        setNotice(done);
        setOutcome({ kind: 'saved', tone: 'ok', text: done });
        onPricesWritten?.(held.pid);
      } catch (e) {
        const fresh = heldPreview(e);
        if (fresh) {
          // The data or a rate moved since the sheet opened: the fresh preview replaces it, with the reason.
          setReview({ ...held, hash: fresh.preview_hash, adoption: fresh.adoption!, error: message(e) });
        } else if (e instanceof ApiError && e.code === 'REAUTH_REQUIRED') {
          setReview({ ...held, error: es.reauth });
        } else {
          setReview(null);
          const m = await failed(e, held.pid);
          setOutcome({ kind: 'refused', tone: 'error', text: held.stored ? m : s.pricingNotSaved(m) });
        }
      } finally {
        reviewRef.current = false;
        setReviewBusy(false);
      }
    },
    [review, keepUnsent, es, onPricesWritten, message, failed, s]
  );
  const cancelReview = useCallback(() => {
    const held = review;
    if (held?.stored) {
      // The data is stored: «لاحقًا» keeps the store price as it is, and this review does not reopen on its own.
      dismissed.current.add(held.hash);
      setOutcome({ kind: 'ready', tone: 'warn', text: s.savedLater });
    } else if (held) {
      // Nothing is written: the typed values stay as drafts (guarded on leaving), the store price as it is.
      setOutcome({ kind: 'held', tone: 'warn', text: s.heldCancelled });
    }
    setReview(null);
    setTick((t) => t + 1);
  }, [review, s]);

  const exitEngine = useCallback(async () => {
    if (!stored || stored.mode !== 'engine' || !productId || saveRef.current) return;
    saveRef.current = true;
    setSaving(true);
    setError('');
    try {
      await api.post<{ success: boolean }>(`${PRICING}/products/${encodeURIComponent(productId)}/manual`, { write_seq: stored.write_seq ?? 0 }, { mascot: 'silent' });
      setTick((t) => t + 1);
      onPricesWritten?.(productId);
    } catch (e) {
      setError(await failed(e, productId));
    } finally {
      saveRef.current = false;
      setSaving(false);
    }
  }, [stored, productId, onPricesWritten, failed]);

  return {
    enabled,
    productId,
    form,
    answer,
    shown,
    drafts,
    effective,
    dirty,
    touched,
    invalid,
    invalidWhere: where.text,
    busy,
    saving,
    notInstalled,
    error,
    notice,
    outcome,
    serverField,
    rateKnownMissing,
    engine: stored?.mode === 'engine',
    setDraft,
    discard,
    save,
    reload: () => setTick((t) => t + 1),
    snapshot,
    saveAfterProduct,
    afterProductSaved,
    review,
    reviewBusy,
    confirmReview,
    cancelReview,
    openReview,
    exitEngine,
  };
}

const Ctx = createContext<UsdPricingState | null>(null);

/** Hands the form's pricing state to its mount points (sections ٣, ٥ and ٨). */
export function UsdPricingProvider({ value, children }: { value: UsdPricingState; children: ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

const useUsdPricing = () => useContext(Ctx);

const nameOf = (x: { name_ar?: string; name_en?: string; name_ckb?: string }, lang: string) =>
  (lang === 'en' ? x.name_en || x.name_ar : lang === 'ckb' ? x.name_ckb || x.name_ar : x.name_ar || x.name_en) || '—';

const kg = (g: number | null | undefined) => (g == null ? '' : `${formatScaledInteger(g, 1000)} kg`);
const boxText = (b: Box | null) => (b ? `${formatScaledInteger(b[0], 10)}×${formatScaledInteger(b[1], 10)}×${formatScaledInteger(b[2], 10)} cm` : '');

// ------------------------------------------------------------------ fields

/** The measure a scope's route needs, bound to the form's own package measurements. */
function MeasureFields({ scope, id, route, summary }: { scope: PricingScope; id: string; route: string; summary: PricingSummary | null }) {
  const { lang } = useLanguage();
  const s = usdPricingFormStrings(lang);
  const en = USD_PRICING_FORM_STRINGS.en;
  const ps = procurementPricingStrings(lang);
  const st = useUsdPricing()!;
  const f = st.form;
  const dims = dimensionsOf(f, scope, id) ?? null;
  // A level below the product shows the nearest measurement above it as its "inherits" value.
  const inherited = scope === 'base' ? null : (ancestorsOf(f, scope, id).map(([s2, i2]) => dimensionsOf(f, s2, i2)).find((d) => !!d) ?? null);
  const row = scopeOf(st.answer, scope, id)?.pricing_inputs ?? null;
  const d = st.drafts[keyOf(scope, id)] ?? {};
  const eff = st.effective[keyOf(scope, id)] ?? {};
  const form = packageMeasureOf(dims);
  const label = (ar: string, english: string) => ({ ar, en: lang === 'en' ? '' : english });
  const set = (patch: Partial<ProductDimensionsV2>) => f.setMeasure(scope, id, patch);
  const volume = route === 'CHINA_SEA';
  // The measures as they would be saved (typed CBM, and the box or weight the form carries to pricing).
  const problems = draftProblems({ ...eff, ...d }, row);
  const errorOf = (field: keyof ScopeDraft) =>
    st.serverField?.key === keyOf(scope, id) && st.serverField.field === field ? st.serverField.text : problems[field] ? problemText(field, problems[field]!, s, ps) : null;

  let status: ReactNode = null;
  const adopt = (
    <button type="button" className="underline" onClick={() => st.setDraft(scope, id, { adopt_measure: true })}>
      {s.adoptMeasure}
    </button>
  );
  const adopted = (
    <span className="inline-flex items-center gap-1 text-emerald-400">
      <Check className="h-3.5 w-3.5" aria-hidden="true" />
      {s.measureAdopted}
    </span>
  );
  if (volume) {
    const pricing = rowBox(row);
    if (eff.box !== undefined) status = <span className="text-amber-300">{s.measureWillAdopt}</span>;
    else if (pricing && form.box && sameBox(pricing, form.box)) status = adopted;
    else if (pricing && form.box) status = <>{s.measureDiffers(boxText(pricing), boxText(form.box))} {adopt}</>;
    else if (pricing) status = s.measurePricingOnly(boxText(pricing));
    else if (scope !== 'base' && !form.box) status = s.measureInherits;
  } else {
    const pricing = row?.shipping_weight_g ?? null;
    if (eff.shipping_weight_g !== undefined) status = <span className="text-amber-300">{s.measureWillAdopt}</span>;
    else if (pricing !== null && form.weight_g === pricing) status = adopted;
    else if (pricing !== null && form.weight_g !== null) status = <>{s.measureDiffers(kg(pricing), kg(form.weight_g))} {adopt}</>;
    else if (pricing !== null) status = s.measurePricingOnly(kg(pricing));
    else if (scope !== 'base' && form.weight_g === null) status = s.measureInherits;
  }

  return (
    <>
      {volume ? (
        <>
          <Field {...label(s.boxWidth, en.boxWidth)} error={errorOf('box')}>
            <MeasurementInput value={dims?.package_width_mm ?? null} inherited={inherited?.package_width_mm} scale={10} onChange={(v) => set({ package_width_mm: v })} />
          </Field>
          <Field {...label(s.boxDepth, en.boxDepth)}>
            <MeasurementInput value={dims?.package_depth_mm ?? null} inherited={inherited?.package_depth_mm} scale={10} onChange={(v) => set({ package_depth_mm: v })} />
          </Field>
          <Field {...label(s.boxHeight, en.boxHeight)}>
            <MeasurementInput value={dims?.package_height_mm ?? null} inherited={inherited?.package_height_mm} scale={10} onChange={(v) => set({ package_height_mm: v })} />
          </Field>
          <Field {...label(s.manualCbm, en.manualCbm)} hint={s.manualCbmHint} error={errorOf('manual_cbm')}>
            <TextInput inputMode="decimal" value={d.manual_cbm ?? row?.manual_cbm ?? ''} onChange={(e) => st.setDraft(scope, id, { manual_cbm: e.target.value })} />
          </Field>
        </>
      ) : (
        <Field {...label(s.weightKg, en.weightKg)} hint={row?.pricing_weight_g != null ? s.pricingWeightWins : undefined} error={errorOf('shipping_weight_g')}>
          <MeasurementInput value={dims?.package_weight_g ?? null} inherited={inherited?.package_weight_g} scale={1000} onChange={(v) => set({ package_weight_g: v })} />
        </Field>
      )}
      <div className="min-w-0 self-end pb-1 text-[11px] leading-relaxed text-text-secondary md:col-span-2 xl:col-span-3" data-usd-measure={keyOf(scope, id)}>
        <p>{s.measureFromForm}</p>
        {volume && form.partial_box && <p className="text-amber-300">{s.boxIncomplete}</p>}
        {volume && summary?.basis === 'volume' && summary.effective_cbm && <p dir="auto">{s.cbmComputed(summary.effective_cbm)}</p>}
        {status && <p>{status}</p>}
      </div>
    </>
  );
}

/**
 * The fields of one scope; a level below the product shows, as its "inherits"
 * placeholders, the nearest value above it (a SKU: its colour's, its model's,
 * the product's — E1's walk).
 */
function ScopeFields({ scope, sellsDirect, summary }: { scope: ScopeAnswer; sellsDirect: boolean; summary: PricingSummary | null }) {
  const { lang } = useLanguage();
  const s = usdPricingFormStrings(lang);
  const ps = procurementPricingStrings(lang);
  const en = USD_PRICING_FORM_STRINGS.en;
  const st = useUsdPricing()!;
  const above = ancestorsOf(st.form, scope.scope, scope.scope_id)
    .map(([s2, i2]) => scopeOf(st.answer, s2, i2))
    .filter((x): x is ScopeAnswer => !!x);
  const base = above.length ? above[above.length - 1]! : null;
  const d = st.drafts[keyOf(scope.scope, scope.scope_id)] ?? {};
  const stored = scope.pricing_inputs;
  // The nearest level above that holds a value, per field.
  const inheritedOf = <K extends keyof StoredInputs>(k: K): StoredInputs | null => above.find((a) => a.pricing_inputs?.[k] != null)?.pricing_inputs ?? null;
  const inherited = inheritedOf('supplier_cost_amount') ?? base?.pricing_inputs ?? null;
  // Exactly what the server would refuse, said under the field before anything is sent (a refusal the
  // server named for this scope's field takes its place until the owner types again).
  const problems = draftProblems(d, stored, { usdIqdRate: st.answer?.product_id ? st.answer.rates.usd_iqd_rate : undefined });
  const errorOf = (field: keyof ScopeDraft) =>
    st.serverField?.key === keyOf(scope.scope, scope.scope_id) && st.serverField.field === field ? st.serverField.text : problems[field] ? problemText(field, problems[field]!, s, ps) : null;
  const label = (ar: string, english: string) => ({ ar, en: lang === 'en' ? '' : english });
  const ph = (v: string | null | undefined) => (scope.scope !== 'base' && v ? s.inheritPlaceholder(v) : undefined);
  const set = (patch: ScopeDraft) => st.setDraft(scope.scope, scope.scope_id, patch);
  const storedIqd = stored?.supplier_input_mode === 'IQD_CONVERTED';
  const storedCurrency = storedIqd ? 'IQD' : (stored?.supplier_cost_currency ?? '');
  const currency = d.supplier_cost_currency ?? storedCurrency;
  const iqd = currency === 'IQD';
  const route = routeOf(st.drafts, st.answer, scope.scope, scope.scope_id, st.form);
  const minProfit = d.minimum_target_profit_usd ?? scope.minimum_target_profit_usd ?? '';
  const aboveMin = above.find((a) => a.minimum_target_profit_usd)?.minimum_target_profit_usd ?? null;
  const baseMin = aboveMin ? `$${aboveMin}` : null;
  const aboveExtra = above.find((a) => a.direct_sale_extra_iqd != null)?.direct_sale_extra_iqd ?? null;
  const extraStored = scope.direct_sale_extra_iqd;
  const shownInputs = scopeOf(st.shown, scope.scope, scope.scope_id)?.pricing_inputs ?? null;
  const rate = st.shown?.rates.usd_iqd_rate ?? null;
  const inheritedSupplier = inherited
    ? inherited.supplier_input_mode === 'IQD_CONVERTED'
      ? `${inherited.original_input_amount ?? ''} IQD`
      : inherited.supplier_cost_amount
        ? `${inherited.supplier_cost_amount} ${inherited.supplier_cost_currency ?? ''}`
        : null
    : null;
  const inheritedRoute = inheritedOf('shipping_profile')?.shipping_profile ?? null;
  const inheritedAdditional = inheritedOf('additional_cost_iqd')?.additional_cost_iqd ?? null;
  const pickCurrency = (next: string) => {
    // Entering or leaving the dinar input starts its amount afresh: a number never changes currency silently.
    if (next === 'IQD') set({ supplier_cost_currency: 'IQD', supplier_cost_iqd: undefined, supplier_cost_amount: undefined, reconvert: undefined });
    else if (iqd) set({ supplier_cost_currency: next, supplier_cost_amount: '', supplier_cost_iqd: undefined, reconvert: undefined });
    else set({ supplier_cost_currency: next });
  };
  return (
    <Grid cols={3}>
      {iqd ? (
        <Field {...label(s.supplierCostIqd, en.supplierCostIqd)} error={errorOf('supplier_cost_iqd')} hint={s.iqdHint}>
          <Money
            value={d.supplier_cost_iqd !== undefined ? d.supplier_cost_iqd : storedIqd ? Number(stored?.original_input_amount ?? 0) || null : null}
            onChange={(v) => set({ supplier_cost_currency: 'IQD', supplier_cost_iqd: v, reconvert: undefined })}
          />
        </Field>
      ) : (
        <Field {...label(s.supplierCost, en.supplierCost)} error={errorOf('supplier_cost_amount')}>
          <TextInput
            inputMode="decimal"
            value={d.supplier_cost_amount ?? (storedIqd ? '' : (stored?.supplier_cost_amount ?? ''))}
            placeholder={ph(inheritedSupplier)}
            onChange={(e) => set({ supplier_cost_amount: e.target.value })}
          />
        </Field>
      )}
      <Field {...label(s.supplierCurrency, en.supplierCurrency)} error={errorOf('supplier_cost_currency')}>
        <Select value={currency} onChange={(e) => pickCurrency(e.target.value)}>
          <option value="">{scope.scope !== 'base' ? s.inheritPlaceholder(inherited?.supplier_input_mode === 'IQD_CONVERTED' ? 'IQD' : (inherited?.supplier_cost_currency ?? '—')) : '—'}</option>
          {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
          {/* With no approved dollar rate typed dinars cannot convert (the server refuses them): offered only once one is approved. */}
          <option value="IQD" disabled={st.rateKnownMissing && currency !== 'IQD'}>{st.rateKnownMissing ? s.currencyIqdNoRate : s.currencyIqd}</option>
        </Select>
      </Field>
      <Field {...label(s.route, en.route)} error={errorOf('shipping_profile')}>
        <Select value={d.shipping_profile ?? stored?.shipping_profile ?? ''} onChange={(e) => set({ shipping_profile: e.target.value })}>
          <option value="">{scope.scope !== 'base' && inheritedRoute ? s.inheritPlaceholder(profileName(inheritedRoute, lang)) : s.routeNone}</option>
          {ROUTES.map((r) => <option key={r} value={r}>{profileName(r, lang)}</option>)}
        </Select>
      </Field>
      {/* The weight or box fields appear for the route that prices by them: no route anywhere, no measure. */}
      {!route && <p className="min-w-0 self-end pb-1 text-[11px] leading-relaxed text-amber-300" data-pricing-route-first>{s.routeFirst}</p>}
      {(iqd || storedIqd) && (
        <div className="min-w-0 text-[11px] leading-relaxed text-text-secondary md:col-span-2 xl:col-span-3" data-usd-iqd={keyOf(scope.scope, scope.scope_id)}>
          {/* What the save stores: the server's conversion of the typed dinars (the preview), or the stored snapshot. */}
          {d.supplier_cost_iqd != null && shownInputs?.supplier_input_mode === 'IQD_CONVERTED' && shownInputs.supplier_cost_amount && shownInputs.conversion_rate_snapshot && (
            <p dir="auto">{s.iqdWillConvert(shownInputs.supplier_cost_amount, shownInputs.conversion_rate_snapshot)}</p>
          )}
          {storedIqd && d.supplier_cost_iqd === undefined && d.supplier_cost_currency === undefined && stored?.original_input_amount && stored.conversion_rate_snapshot && (
            <p dir="auto">
              {s.convertedOn(Number(stored.original_input_amount).toLocaleString('en-US'), stored.conversion_rate_snapshot, (stored.converted_at ?? '').slice(0, 10))}
              {` · $${stored.supplier_cost_amount ?? ''}`}
              {rate && rate !== stored.conversion_rate_snapshot && (
                <>
                  {' '}
                  <button type="button" className="underline" onClick={() => set({ supplier_cost_currency: 'IQD', supplier_cost_iqd: Number(stored.original_input_amount), reconvert: true })}>
                    {s.reconvert(rate)}
                  </button>
                </>
              )}
            </p>
          )}
        </div>
      )}
      {/* A variant row's measure is its own row's (only when the form holds one); otherwise it inherits. */}
      {route && (scope.scope !== 'sku' || (st.form.skus ?? []).some((k) => k.combo_key === scope.scope_id)) && (
        <MeasureFields scope={scope.scope} id={scope.scope_id} route={route} summary={summary} />
      )}
      <Field {...label(s.additional, en.additional)} error={errorOf('additional_cost_iqd')}>
        <Money value={d.additional_cost_iqd !== undefined ? d.additional_cost_iqd : (stored?.additional_cost_iqd ?? null)} placeholder={ph(inheritedAdditional != null ? String(inheritedAdditional) : null)} onChange={(v) => set({ additional_cost_iqd: v })} />
      </Field>
      <Field {...label(s.minProfit, en.minProfit)} error={errorOf('minimum_target_profit_usd')} hint={s.minProfitHint}>
        <TextInput inputMode="decimal" value={minProfit} placeholder={ph(baseMin) ?? (scope.target_profit_iqd != null ? `${scope.target_profit_iqd.toLocaleString('en-US')} IQD` : undefined)} onChange={(e) => set({ minimum_target_profit_usd: e.target.value })} />
      </Field>
      {(sellsDirect || extraStored != null || d.direct_sale_extra_iqd != null) && (
        <Field {...label(s.extra, en.extra)} error={errorOf('direct_sale_extra_iqd')} hint={s.extraHint}>
          <Money value={d.direct_sale_extra_iqd !== undefined ? d.direct_sale_extra_iqd : extraStored} placeholder={ph(aboveExtra != null ? String(aboveExtra) : null)} onChange={(v) => set({ direct_sale_extra_iqd: v })} />
        </Field>
      )}
    </Grid>
  );
}

function SaveRow() {
  const { lang } = useLanguage();
  const s = usdPricingFormStrings(lang);
  const st = useUsdPricing()!;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      {st.productId && (
        <button type="button" className={btnPrimary} disabled={!st.dirty || st.invalid || st.saving || !st.answer} onClick={() => void st.save()} data-pricing-save>
          {st.saving ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Save className="w-4 h-4" aria-hidden="true" />}
          {s.save}
        </button>
      )}
      {st.dirty && <button type="button" className={btnGhost} disabled={st.saving} onClick={st.discard}>{s.discard}</button>}
      <span className="text-[11px] text-text-muted">{st.dirty ? `${s.unsaved} · ${s.saveHint}` : s.saveHint}</span>
      {st.dirty && st.shown?.adoption?.kind && st.shown.adoption.complete && <span className="text-[11px] text-amber-300" data-engine-ready>{engineSaveStrings(lang).readyHint}</span>}
      {/* Why the button is disabled: the field, its scope and the reason — never a silent grey button. */}
      {st.dirty && st.invalid && <span className="text-[11px] text-red-300" data-pricing-blocked>{s.saveBlocked(st.invalidWhere)}</span>}
      {st.productId && !st.dirty && !st.review && readyReview(st.productId, st.answer) && (
        <span className="text-[11px] text-amber-300">
          {s.readyWaiting}{' '}
          <button type="button" className="underline" onClick={st.openReview} data-pricing-review>
            {s.reviewAndAdopt}
          </button>
        </span>
      )}
      {st.productId && st.engine && !st.dirty && (
        <button
          type="button"
          className={btnGhost}
          disabled={st.saving}
          onClick={() => {
            if (window.confirm(st.answer?.per_sku ? engineSaveStrings(lang).exitConfirmPerSku : engineSaveStrings(lang).exitConfirm)) void st.exitEngine();
          }}
          data-engine-exit
        >
          {engineSaveStrings(lang).exit}
        </button>
      )}
      {st.notice && <span role="status" className="text-[12px] text-emerald-400">{st.notice}</span>}
    </div>
  );
}

/** «التسعير والشحن» in a new tab: the form and its drafts stay where they are. */
function OpenPricing() {
  const { lang } = useLanguage();
  return (
    <a href={PRICING_TAB_HREF} target="_blank" rel="noopener" className="underline" data-open-pricing>
      {usdPricingFormStrings(lang).openPricingTab}
    </a>
  );
}

/** The central settings a price is still waiting for (a rate, a shipping rate, the engine's pause), and where to set them. */
const CENTRAL_CODES = new Set(['FX_RATE_MISSING', 'FX_RATE_UNCONFIRMED', 'FX_DERIVED_STALE', 'SHIPPING_RATE_MISSING', 'SHIPPING_RATE_UNCONFIRMED', 'PRICING_ENGINE_PAUSED']);

function WhereToFix() {
  const { lang } = useLanguage();
  const s = usdPricingFormStrings(lang);
  const ps = procurementPricingStrings(lang);
  const st = useUsdPricing()!;
  const summaries = [...(st.shown?.models ?? []), ...(st.shown?.skus ?? [])].map((m) => m.pricing_summary);
  const codes = [...new Set(summaries.flatMap((x) => x?.issue_codes ?? []))].filter((c) => CENTRAL_CODES.has(c));
  if (!st.productId || !codes.length) return null;
  const list = codes.map((c) => (c === 'SHIPPING_RATE_MISSING' ? ps.shippingRateMissing : issueText(c, lang))).join(lang === 'en' ? '; ' : '؛ ');
  return (
    <p className="mt-2 text-[11px] leading-relaxed text-amber-300" data-pricing-where>
      {s.centralMissing(list)} <OpenPricing />
    </p>
  );
}

function Status() {
  const { lang } = useLanguage();
  const s = usdPricingFormStrings(lang);
  const ps = procurementPricingStrings(lang);
  const st = useUsdPricing()!;
  const o = st.outcome;
  return (
    <>
      {st.shown?.rates.review_pending && st.shown.rates.usd_iqd_rate && <Banner kind="warn">{ps.reviewBanner(st.shown.rates.usd_iqd_rate)}</Banner>}
      {st.rateKnownMissing && (
        <div data-pricing-rates="no-usd">
          <Banner kind="warn">
            {s.ratesNoUsd} <OpenPricing />
          </Banner>
        </div>
      )}
      {st.shown?.rates.derived_stale && (
        <Banner kind="warn">
          {s.ratesDerivedStale} <OpenPricing />
        </Banner>
      )}
      {/* The last save's outcome: no preview or read wipes it, only the owner's next keystroke. */}
      {o && (
        <div data-pricing-outcome={o.kind} role={o.tone === 'error' ? 'alert' : 'status'}>
          <Banner kind={o.tone}>
            {o.text}
            {o.kind === 'ready' && !st.review && st.productId && readyReview(st.productId, st.answer) && (
              <>
                {' '}
                <button type="button" className="underline" onClick={st.openReview}>
                  {s.reviewAndAdopt}
                </button>
              </>
            )}
          </Banner>
        </div>
      )}
      {st.error && (
        <Banner kind="error">
          {st.error}{' '}
          {!st.answer && <button type="button" className="underline" onClick={st.reload}>{s.retry}</button>}
        </Banner>
      )}
    </>
  );
}

function Head({ text, english }: { text: string; english: string }) {
  const { lang } = useLanguage();
  return (
    <h4 className="text-[13px] font-bold text-text-primary">
      {text} {lang !== 'en' && <span className="text-[10px] font-medium text-text-muted">{english}</span>}
    </h4>
  );
}

/** Section ٣: the product level, its bar (a product with one model) and the save row. */
export function UsdPricingProductPanel() {
  const { lang } = useLanguage();
  const s = usdPricingFormStrings(lang);
  const ps = procurementPricingStrings(lang);
  const st = useUsdPricing();
  if (!st || !st.enabled) return null;
  const head = <Head text={s.formTitle} english={USD_PRICING_FORM_STRINGS.en.formTitle} />;
  if (st.notInstalled) return <div className="ap mt-4 rounded-lg border border-border-subtle p-3" data-form="usd-pricing">{head}<p className="mt-1 text-[12px] text-text-muted">{ps.notInstalled}</p></div>;
  const base = scopeOf(st.answer, 'base', '');
  const models = st.shown?.models ?? [];
  // A product with one model shows that model's bar here; several models show theirs in their cards.
  const productModel = models.length === 1 ? models[0]! : null;
  const ok = models.filter((m) => m.pricing_summary.state === 'ok').length;
  const sellsDirect = st.form.productSellsDirect || models.some((m) => m.sells_direct);
  return (
    <div className="ap mt-4 rounded-lg border border-border-subtle p-3" data-form="usd-pricing">
      {head}
      <p className="mt-1 mb-3 text-[12px] text-text-muted">{s.formIntro}</p>
      <Status />
      {!base ? (
        <p role="status" className="text-[12px] text-text-muted">{st.busy ? s.loading : ''}</p>
      ) : (
        <>
          <ScopeFields scope={base} sellsDirect={sellsDirect} summary={productModel?.pricing_summary ?? null} />
          {!st.productId ? (
            <p className="mt-3 text-[12px] text-text-secondary">{s.summaryAfterFirstSave}</p>
          ) : productModel ? (
            <PricingSummaryBar summary={productModel.pricing_summary} label={s.productLevel} busy={st.busy && st.dirty} />
          ) : (
            models.length > 0 && <p className="mt-3 text-[12px] text-text-secondary">{s.modelsSummary(String(ok), String(models.length))}</p>
          )}
          <WhereToFix />
          <p className="mt-2 text-[11px] text-text-muted">{s.pricesLater}</p>
          {/* «التكلفة القديمة» and the store price beside this panel do not move with a data save. */}
          <p className="mt-1 text-[11px] text-text-muted" data-pricing-legacy-cost>{s.legacyCostStays}</p>
          <SaveRow />
        </>
      )}
    </div>
  );
}

/**
 * Section ٥, inside one model's card: its computed customer price (and direct
 * price), its own values (empty = the product's) and its bar. A model not
 * saved yet takes its values now; they are saved after the product.
 */
export function UsdPricingModelRow({ model }: { model: FormModel }) {
  const { lang } = useLanguage();
  const s = usdPricingFormStrings(lang);
  const st = useUsdPricing();
  if (!st || !st.enabled || st.notInstalled || !st.answer) return null;
  const saved = scopeOf(st.answer, 'option', model.id);
  const scope: ScopeAnswer = saved ?? {
    scope: 'option', scope_id: model.id, name_ar: model.name_ar ?? '', name_en: model.name_en, name_ckb: model.name_ckb ?? '', pricing_inputs: null,
    minimum_target_profit_usd: null, target_profit_iqd: null, target_profit_state: null, direct_sale_extra_iqd: null, direct_sale_extra_state: null,
  };
  const summary = st.shown?.models.find((m) => m.option_id === model.id)?.pricing_summary ?? null;
  const name = nameOf(model, lang);
  const touched = !!st.effective[keyOf('option', model.id)];
  const ok = summary?.state === 'ok';
  return (
    <div className="ap mt-2.5 min-w-0 rounded-lg border border-border-subtle px-2.5 py-2" data-usd-model={model.id}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-[12px] font-bold text-text-secondary">{s.modelTitle}</span>
        {saved && st.productId && (
          <span className="flex flex-wrap gap-x-3 text-[12px] tabular-nums text-text-primary" data-usd-model-price>
            {ok ? (
              <>
                <span>{s.customerPrice(money(summary!.preorder_base_iqd))}</span>
                {summary!.direct_sale_price_iqd != null && <span>{s.directPrice(money(summary!.direct_sale_price_iqd))}</span>}
              </>
            ) : (
              <span className="text-text-muted">{st.busy && touched ? '…' : s.modelBlocked}</span>
            )}
          </span>
        )}
      </div>
      <p className="mt-1 text-[11px] text-text-muted">{saved ? (st.answer.sku_levels ? s.coloursOwn : s.coloursFollow) : s.modelSavedLater}</p>
      <details className="mt-1.5" open={touched || undefined}>
        <summary className="cursor-pointer text-[12px] text-text-secondary">{s.edit}</summary>
        <div className="mt-3">
          <ScopeFields scope={scope} sellsDirect={model.sells_direct} summary={summary} />
        </div>
      </details>
      {saved && summary && <PricingSummaryBar summary={summary} label={name} busy={st.busy && touched} />}
    </div>
  );
}

/** The computed customer price of each SKU (pre-order base, and direct when it sells direct), one line each. */
function SkuPrices({ skus, busy }: { skus: readonly SkuAnswer[]; busy: boolean }) {
  const { lang } = useLanguage();
  const s = usdPricingFormStrings(lang);
  if (!skus.length) return null;
  return (
    <ul className="mt-1 space-y-0.5 text-[12px] tabular-nums text-text-primary" data-usd-sku-prices>
      {skus.map((k) => {
        const sum = k.pricing_summary;
        const ok = sum.state === 'ok';
        return (
          <li key={k.combo_key} className="flex flex-wrap gap-x-3" data-usd-sku={k.combo_key}>
            <span className="text-text-secondary" dir="auto">{nameOf(k, lang)}</span>
            {ok ? (
              <>
                <span>{s.customerPrice(money(sum.preorder_base_iqd))}</span>
                {sum.direct_sale_price_iqd != null && <span>{s.directPrice(money(sum.direct_sale_price_iqd))}</span>}
              </>
            ) : (
              <span className="text-text-muted">{busy ? '…' : s.modelBlocked}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

const emptyScope = (scope: PricingScope, id: string, names: { name_ar?: string; name_en: string; name_ckb?: string }): ScopeAnswer => ({
  scope,
  scope_id: id,
  name_ar: names.name_ar ?? '',
  name_en: names.name_en,
  name_ckb: names.name_ckb ?? '',
  pricing_inputs: null,
  minimum_target_profit_usd: null,
  target_profit_iqd: null,
  target_profit_state: null,
  direct_sale_extra_iqd: null,
  direct_sale_extra_state: null,
});

/**
 * Section ٥, inside one colour's card (FX-7, with the SKU rung): the computed
 * customer price of every SKU the colour makes (one per model it is sold
 * with), and its own values — empty = its model's, then the product's.
 */
export function UsdPricingColourRow({ colour }: { colour: FormColour }) {
  const { lang } = useLanguage();
  const s = usdPricingFormStrings(lang);
  const st = useUsdPricing();
  if (!st || !st.enabled || st.notInstalled || !st.answer || !st.answer.sku_levels) return null;
  const saved = scopeOf(st.answer, 'color', colour.id);
  const scope = saved ?? emptyScope('color', colour.id, colour);
  const skus = (st.shown?.skus ?? []).filter((k) => k.color_id === colour.id);
  const touched = !!st.effective[keyOf('color', colour.id)];
  const sellsDirect = skus.some((k) => k.sells_direct) || st.form.models.some((m) => m.sells_direct) || st.form.productSellsDirect;
  return (
    <div className="ap mt-2.5 min-w-0 rounded-lg border border-border-subtle px-2.5 py-2" data-usd-colour={colour.id}>
      <span className="text-[12px] font-bold text-text-secondary">{s.colourTitle}</span>
      {saved && st.productId && <SkuPrices skus={skus} busy={st.busy && touched} />}
      <p className="mt-1 text-[11px] text-text-muted">{saved ? s.colourInherits : s.colourSavedLater}</p>
      <details className="mt-1.5" open={touched || undefined}>
        <summary className="cursor-pointer text-[12px] text-text-secondary">{s.edit}</summary>
        <div className="mt-3">
          <ScopeFields scope={scope} sellsDirect={sellsDirect} summary={skus.length === 1 ? skus[0]!.pricing_summary : null} />
        </div>
      </details>
    </div>
  );
}

/**
 * Section ٥, inside one variant row of a colour's card (FX-7, with the SKU
 * rung): the variant's computed customer price and its own values — empty =
 * its colour's, its model's, then the product's.
 */
export function UsdPricingSkuRow({ comboKey }: { comboKey: string }) {
  const { lang } = useLanguage();
  const s = usdPricingFormStrings(lang);
  const st = useUsdPricing();
  if (!st || !st.enabled || st.notInstalled || !st.answer || !st.answer.sku_levels) return null;
  const saved = scopeOf(st.answer, 'sku', comboKey);
  const sku = (st.shown?.skus ?? []).find((k) => k.combo_key === comboKey) ?? null;
  // A variant row the server does not price as its own level (a model alone) is the model's card's.
  if (!saved && !sku) return null;
  const scope = saved ?? emptyScope('sku', comboKey, sku ?? { name_en: comboKey });
  const touched = !!st.effective[keyOf('sku', comboKey)];
  return (
    <div className="ap mt-2 min-w-0 rounded-md border border-border-subtle px-2 py-1.5" data-usd-variant={comboKey}>
      <span className="text-[11px] font-bold text-text-secondary">{s.skuTitle}</span>
      {sku && st.productId && <SkuPrices skus={[sku]} busy={st.busy && touched} />}
      <details className="mt-1" open={touched || undefined}>
        <summary className="cursor-pointer text-[11px] text-text-secondary">{s.edit}</summary>
        <p className="mt-1 text-[11px] text-text-muted">{s.skuInherits}</p>
        <div className="mt-2">
          <ScopeFields scope={scope} sellsDirect={sku?.sells_direct ?? false} summary={sku?.pricing_summary ?? null} />
        </div>
      </details>
    </div>
  );
}

/** Section ٥, under the models: the banners and the save row once (only when the product has models). */
export function UsdPricingOptionsFooter() {
  const st = useUsdPricing();
  if (!st || !st.enabled || st.notInstalled || !st.answer || st.form.models.length === 0) return null;
  return (
    <div className="ap mt-3" data-form="usd-pricing-options">
      <Status />
      <WhereToFix />
      <SaveRow />
    </div>
  );
}

/**
 * The writer's preview sheet (owner decision 8), mounted ONCE at the form's root — never inside a section
 * that can be closed (owner report 2026-10-10: a held save waited in closed section ٨, unseen). When the
 * data is already stored, its cancel is «لاحقًا — البيانات محفوظة» and a large change's fresh sign-in
 * loses nothing.
 */
export function UsdPricingSaveSheet() {
  const st = useUsdPricing();
  const { lang } = useLanguage();
  const auth = useOptionalAuth();
  if (!st || !st.review) return null;
  const review = st.review;
  const s = usdPricingFormStrings(lang);
  const label = review.adoption.rows[0]?.name_ar ?? '';
  const signInAgain = async () => {
    // The session must end first: only a NEW sign-in is fresh. The way back is this product's form.
    try {
      await auth?.logout();
    } finally {
      window.location.assign(`/auth?next=${encodeURIComponent(`/admin?tab=products&edit=${encodeURIComponent(review.pid)}`)}`);
    }
  };
  return (
    <EngineSaveSheet
      key={review.hash}
      products={[{ product_id: review.pid, label, adoption: review.adoption }]}
      busy={st.reviewBusy}
      error={review.error}
      onConfirm={(confirmLarge) => void st.confirmReview(confirmLarge)}
      onCancel={st.cancelReview}
      cancelLabel={review.stored ? s.later : undefined}
      note={review.stored ? s.sheetDataSaved : s.sheetNothingSaved}
      extra={
        review.stored && review.error === engineSaveStrings(lang).reauth ? (
          <button type="button" className="justify-self-start text-[13px] underline" onClick={() => void signInAgain()} data-pricing-sign-in>
            {s.signInAgain}
          </button>
        ) : null
      }
    />
  );
}

/** Section ٨: owner decision 8's six figures per model × channel, priced with the unsaved drafts. */
export function UsdPricingPreview() {
  const { lang } = useLanguage();
  const s = usdPricingFormStrings(lang);
  const st = useUsdPricing();
  if (!st || !st.enabled || st.notInstalled || !st.productId || !st.shown) return null;
  const rows = st.shown.rows ?? [];
  return (
    <section className="ap mt-3 rounded-lg border border-border-subtle p-3" aria-busy={st.busy || undefined} data-form="usd-pricing-preview">
      <Head text={s.previewTitle} english={USD_PRICING_FORM_STRINGS.en.previewTitle} />
      <p className="mt-1 text-[11px] text-text-muted">
        {s.previewNote}
        {st.shown.per_sku && <span className="block">{s.perSkuNote}</span>}
        {st.dirty && <span className="block text-amber-300">{s.previewIncludesDrafts}</span>}
      </p>
      {rows.length ? <PricingRowsTable rows={rows} /> : <p className="mt-2 text-[12px] text-text-muted">{s.previewEmpty}</p>}
    </section>
  );
}
