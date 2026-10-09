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
 *     customer price (and direct price) and its bar; a colour follows its model
 *     (said on screen) until per-colour pricing exists (FX-7);
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
 * THE SAVE THAT WRITES PRICES SHOWS THEM FIRST (owner decision 8). While the
 * product stays incomplete a save stores the pricing data only and the store
 * price stays manual. The save that leaves it complete — or any save of an
 * engine-priced product — is held by the server (409 with the preview); the
 * sheet (`UsdPricingSaveSheet`) shows the new prices, and «حفظ» sends the same
 * body with the preview's hash (and the tick above 15%), which adopts the
 * engine and writes the prices in that one batch. A product save that changed
 * nothing here but completed the product opens the same sheet.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Check, Loader2, Save } from 'lucide-react';
import { ApiError, api, isAborted } from '../../../lib/api';
import { useLanguage } from '../../../LanguageContext';
import { contractRefusal, refusalLang } from '../../../lib/refusalStrings';
import type { ProductDimensionsV2 } from '../../../lib/productTypes';
import PricingSummaryBar from '../../adminOperations/PricingSummaryBar';
import { PricingRowsTable } from '../../adminOperations/ProcurementPricingReview';
import type { EngineAdoption, PricingPreviewRow, PricingSummary } from '../../adminOperations/procurementPricing';
import { issueText, procurementPricingStrings, profileName } from '../../adminOperations/procurementPricingStrings';
import EngineSaveSheet from '../../adminOperations/EngineSaveSheet';
import { engineSaveStrings } from '../../adminOperations/engineSaveStrings';
import { money } from '../../adminOperations/shared';
import { MeasurementInput, formatScaledInteger } from './DimensionsSection';
import { Banner, Field, Grid, Money, Select, TextInput, btnGhost, btnPrimary } from './formUi';
import { USD_PRICING_FORM_STRINGS, usdPricingFormStrings } from './usdPricingStrings';

const PRICING = '/api/admin/pricing';
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

export interface ScopeAnswer {
  scope: 'base' | 'option';
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

export interface UsdPricingAnswer {
  product_id: string;
  mode: 'manual' | 'engine';
  inputs_seq: number;
  /** The price writes' counter (an engine product's way back to manual is fenced on it). */
  write_seq?: number;
  rates: { usd_iqd_rate: string | null; review_pending: boolean; derived_stale: boolean };
  scopes: ScopeAnswer[];
  models: ModelAnswer[];
  /** Owner decision 8's six figures per model × channel. */
  rows: PricingPreviewRow[];
  /** What the save carries: the engine write's hash when it writes prices, else the dinar conversion's. */
  preview_hash: string;
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

/** What the pricing reads from the rest of the form, and how it edits the form's own measurements. */
export interface UsdPricingFormContext {
  baseDimensions: ProductDimensionsV2 | null | undefined;
  optionDimensions: Readonly<Record<string, ProductDimensionsV2 | null | undefined>>;
  /** The measurements as last loaded or saved (an edit since then is the owner's act on pricing too). */
  savedBaseDimensions: ProductDimensionsV2 | null | undefined;
  savedOptionDimensions: Readonly<Record<string, ProductDimensionsV2 | null | undefined>>;
  models: readonly FormModel[];
  productSellsDirect: boolean;
  setMeasure: (scope: 'base' | 'option', id: string, patch: Partial<ProductDimensionsV2>) => void;
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

export const keyOf = (scope: 'base' | 'option', id: string) => (scope === 'base' ? 'base' : `option:${id}`);
const parseKey = (key: string): { scope: 'base' | 'option'; id: string } => (key === 'base' ? { scope: 'base', id: '' } : { scope: 'option', id: key.slice(7) });

const DECIMAL = /^[0-9٠-٩۰-۹]+(?:[.,٫][0-9٠-٩۰-۹]+)?$/;
const USD_TEXT = /^[0-9٠-٩۰-۹]+(?:[.,٫][0-9٠-٩۰-۹]{1,2})?$/;

const isIqdDraft = (d: ScopeDraft) => d.supplier_cost_currency === 'IQD' || (d.supplier_cost_currency === undefined && d.supplier_cost_iqd !== undefined);

/** A draft's problems, by field (the server refuses the same, by field). */
export function draftProblems(d: ScopeDraft, stored: StoredInputs | null = null): Partial<Record<keyof ScopeDraft, true>> {
  const out: Partial<Record<keyof ScopeDraft, true>> = {};
  const storedIqd = stored?.supplier_input_mode === 'IQD_CONVERTED';
  if (isIqdDraft(d)) {
    if (d.supplier_cost_iqd === undefined ? !storedIqd : d.supplier_cost_iqd !== null && (!Number.isSafeInteger(d.supplier_cost_iqd) || d.supplier_cost_iqd < 1)) out.supplier_cost_iqd = true;
  } else {
    const amount = d.supplier_cost_amount?.trim();
    if (amount && !DECIMAL.test(amount)) out.supplier_cost_amount = true;
    // Leaving the dinar input for a source currency needs that currency's amount (never the converted USD reread).
    if (storedIqd && d.supplier_cost_currency && d.supplier_cost_currency !== 'IQD' && !amount) out.supplier_cost_amount = true;
  }
  if (d.manual_cbm !== undefined && d.manual_cbm.trim() !== '' && !DECIMAL.test(d.manual_cbm.trim())) out.manual_cbm = true;
  if (d.minimum_target_profit_usd !== undefined && d.minimum_target_profit_usd.trim() !== '' && !USD_TEXT.test(d.minimum_target_profit_usd.trim())) out.minimum_target_profit_usd = true;
  if (d.direct_sale_extra_iqd != null && d.direct_sale_extra_iqd % 1000 !== 0) out.direct_sale_extra_iqd = true;
  return out;
}

const scopeOf = (answer: UsdPricingAnswer | null, scope: 'base' | 'option', id: string) =>
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

/** The route a scope prices on: its own (typed, then stored), else the product's. */
export function routeOf(drafts: Readonly<Record<string, ScopeDraft>>, answer: UsdPricingAnswer | null, scope: 'base' | 'option', id: string): string {
  const own = (s: 'base' | 'option', i: string) => {
    const typed = drafts[keyOf(s, i)]?.shipping_profile;
    return typed !== undefined ? typed : (scopeOf(answer, s, i)?.pricing_inputs?.shipping_profile ?? '');
  };
  return (scope === 'option' ? own('option', id) : '') || own('base', '');
}

const hasContent = (d: ScopeDraft) => (Object.keys(d) as Array<keyof ScopeDraft>).some((k) => k !== 'adopt_measure' && d[k] !== undefined);

/** The drafts as they would be saved: what was typed, plus the measure each scope takes from the form. */
export function effectiveDrafts(drafts: Readonly<Record<string, ScopeDraft>>, answer: UsdPricingAnswer | null, form: UsdPricingFormContext): Record<string, ScopeDraft> {
  const out: Record<string, ScopeDraft> = {};
  const keys = new Set<string>([
    'base',
    ...Object.keys(drafts),
    ...(answer?.scopes ?? []).filter((s) => s.scope === 'option').map((s) => keyOf('option', s.scope_id)),
    ...form.models.map((m) => keyOf('option', m.id)),
  ]);
  for (const key of keys) {
    const { scope, id } = parseKey(key);
    // A model removed from the form (and unknown to the server) takes its drafts with it.
    if (scope === 'option' && !scopeOf(answer, 'option', id) && !form.models.some((m) => m.id === id)) continue;
    const typed = drafts[key] ?? {};
    const route = routeOf(drafts, answer, scope, id);
    let derived: Pick<ScopeDraft, 'shipping_weight_g' | 'box'> = {};
    if (route) {
      const m = measureDraftOf(
        packageMeasureOf(scope === 'base' ? form.baseDimensions : form.optionDimensions[id]),
        packageMeasureOf(scope === 'base' ? form.savedBaseDimensions : form.savedOptionDimensions[id]),
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
    const entry: Record<string, unknown> = { scope: s.scope, ...(s.scope === 'option' ? { scope_id: s.scope_id } : {}) };
    if (isIqdDraft(d)) {
      // The convenience input: whole dinars; the server converts them once (the client never sends USD or a rate).
      if (d.supplier_cost_iqd != null) {
        entry.supplier_cost_iqd = d.supplier_cost_iqd;
        if (d.reconvert) entry.reconvert = true;
      } else if (d.supplier_cost_iqd === null) entry.supplier_cost_amount = null;
    } else {
      if (d.supplier_cost_amount !== undefined) entry.supplier_cost_amount = blank(d.supplier_cost_amount);
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
    if (d.manual_cbm !== undefined) entry.manual_cbm = blank(d.manual_cbm);
    if (d.additional_cost_iqd !== undefined) entry.additional_cost_iqd = d.additional_cost_iqd;
    if (Object.keys(entry).length > (s.scope === 'option' ? 2 : 1)) inputs.push(entry);
    const ruleScope = s.scope === 'base' ? 'product' : 'option';
    const at = s.scope === 'option' ? { scope_id: s.scope_id } : {};
    if (d.minimum_target_profit_usd !== undefined) rules.push({ kind: 'target_profit', scope: ruleScope, ...at, amount_usd: blank(d.minimum_target_profit_usd) });
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

/** The drafts at the moment the product's save starts, with the hash of the preview that showed them. */
export interface PricingSnapshot {
  drafts: Record<string, ScopeDraft>;
  hash: string | null;
  invalid: boolean;
}

/**
 * A save the server held for the owner's look at the new prices (owner decision
 * 8: 409 PRICING_PREVIEW_REQUIRED / _STALE / PRICING_LARGE_CHANGE_CONFIRM carry
 * the preview). The same body goes again with the preview's hash on «حفظ».
 */
export interface PricingReview {
  pid: string;
  body: { inputs_seq: number; inputs: unknown[]; rules: unknown[] };
  hash: string;
  adoption: EngineAdoption;
  error: string;
}

const REVIEW_CODES = new Set(['PRICING_PREVIEW_REQUIRED', 'PRICING_PREVIEW_STALE', 'PRICING_LARGE_CHANGE_CONFIRM']);

/** The preview a held save carries, when it writes prices (else null: the refusal stands). */
export function heldPreview(e: unknown): UsdPricingAnswer | null {
  if (!(e instanceof ApiError) || !REVIEW_CODES.has(e.code ?? '')) return null;
  const shown = (e.details as { preview?: UsdPricingAnswer } | undefined)?.preview;
  return shown && shown.adoption?.kind && typeof shown.preview_hash === 'string' && shown.preview_hash ? shown : null;
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
  invalid: boolean;
  busy: boolean;
  saving: boolean;
  notInstalled: boolean;
  error: string;
  notice: string;
  /** The engine prices this product (its store price is then read-only in the form). */
  engine: boolean;
  setDraft: (scope: 'base' | 'option', id: string, patch: ScopeDraft) => void;
  discard: () => void;
  save: () => Promise<void>;
  reload: () => void;
  /** Taken just before the product's own save (null when there is nothing to save). */
  snapshot: () => PricingSnapshot | null;
  /** After the product's save: the snapshot through the pricing door for the saved id. */
  saveAfterProduct: (productId: string, snap: PricingSnapshot) => Promise<{ ok: boolean; message: string }>;
  /** After a product save with no pricing drafts: the fresh answer, and the preview when that save completed the product. */
  afterProductSaved: (productId: string) => Promise<void>;
  /** The held save awaiting the owner's look at the new prices (the sheet). */
  review: PricingReview | null;
  reviewBusy: boolean;
  confirmReview: (confirmLarge: boolean) => Promise<void>;
  cancelReview: () => void;
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
  const [tick, setTick] = useState(0);
  const [previewTick, setPreviewTick] = useState(0);
  const live = enabled && !!productId;
  const message = useCallback((e: unknown) => contractRefusal(e, refusalLang(lang), e instanceof Error ? e.message : String(e)), [lang]);

  // Another product: its own drafts (a new product's first save keeps what was typed for it).
  const previousId = useRef(productId);
  useEffect(() => {
    if (previousId.current && previousId.current !== productId) {
      setDrafts({});
      setStored(null);
      setPreview(null);
    }
    previousId.current = productId;
  }, [productId]);

  useEffect(() => {
    if (!live) return;
    const ctrl = new AbortController();
    setBusy(true);
    api
      .get<UsdPricingAnswer>(`${PRICING}/products/${encodeURIComponent(productId!)}/inputs`, { signal: ctrl.signal, mascot: 'silent' })
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
  const invalid = Object.entries(effective).some(([k, d]) => {
    const { scope, id } = parseKey(k);
    return Object.keys(draftProblems(d, scopeOf(answer, scope, id)?.pricing_inputs ?? null)).length > 0;
  });
  const wireObject = useMemo(() => (answer && productId && dirty && !invalid ? draftWire(effective, answer) : null), [answer, productId, dirty, invalid, effective]);
  const wire = wireObject && (wireObject.inputs.length || wireObject.rules.length) ? JSON.stringify(wireObject) : '';

  // The live preview: the server prices the drafts as they would be saved (debounced, latest wins).
  useEffect(() => {
    if (!live || !wire) return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      setBusy(true);
      api
        .post<UsdPricingAnswer>(`${PRICING}/products/${encodeURIComponent(productId!)}/preview`, { draft: JSON.parse(wire) }, { signal: ctrl.signal, mascot: 'silent' })
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
  /**
   * The hash of the preview that showed exactly these drafts (a dinar conversion needs it). A save that writes
   * prices never rides on the live preview: it goes without a hash, and the server answers with the sheet.
   */
  const hashFor = useCallback((w: string) => (preview && preview.wire === w && !preview.answer.adoption?.kind ? preview.answer.preview_hash : null), [preview]);

  const setDraft = useCallback((scope: 'base' | 'option', id: string, patch: ScopeDraft) => {
    setNotice('');
    setDrafts((all) => ({ ...all, [keyOf(scope, id)]: { ...all[keyOf(scope, id)], ...patch } }));
  }, []);
  const discard = useCallback(() => {
    setDrafts({});
    setPreview(null);
    setError('');
  }, []);

  /** One PUT for `pid`: the snapshot's drafts against the answer the server holds now. */
  const putDrafts = useCallback(async (pid: string, snap: Record<string, ScopeDraft>, hash: string | null, base: UsdPricingAnswer | null) => {
    const current = base ?? (await api.get<UsdPricingAnswer>(`${PRICING}/products/${encodeURIComponent(pid)}/inputs`, { mascot: 'silent' }));
    const body = draftWire(snap, current);
    if (!body.inputs.length && !body.rules.length) return { answer: current, sent: false, review: null };
    const wire = { inputs_seq: current.inputs_seq, ...body };
    try {
      const r = await api.put<UsdPricingAnswer>(
        `${PRICING}/products/${encodeURIComponent(pid)}/inputs`,
        { ...wire, ...(hash && wireHasIqd(body) ? { preview_hash: hash } : {}) },
        { mascot: 'silent' }
      );
      return { answer: r, sent: true, review: null };
    } catch (e) {
      // Owner decision 8: this save writes prices — the server holds it and answers with the preview.
      const shown = heldPreview(e);
      if (!shown) throw e;
      const held: PricingReview = { pid, body: wire, hash: shown.preview_hash, adoption: shown.adoption!, error: '' };
      return { answer: current, sent: false, review: held };
    }
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

  const failed = useCallback(
    async (e: unknown, pid: string) => {
      const stale = e instanceof ApiError && (e.code === 'PRICING_PREVIEW_STALE' || (e.code === 'PRICING_INPUT_INVALID' && (e.details as { field?: string } | undefined)?.field === 'preview_hash'));
      // An engine product never loses its price: a save that would leave it incomplete is refused, naming what is missing.
      const missing = e instanceof ApiError && e.code === 'PRICING_ENGINE_INCOMPLETE' ? ((e.details as { missing_codes?: string[] } | undefined)?.missing_codes ?? []) : [];
      setError(stale ? `${message(e)} — ${s.reviewConversion}` : missing.length ? `${message(e)} — ${missing.map((c) => issueText(c, lang)).join(lang === 'en' ? '; ' : '؛ ')}` : message(e));
      if (stale) setPreviewTick((t) => t + 1);
      // Someone else saved first (a purchase applied, another tab): show the fresh values, keep the typed ones.
      if (e instanceof ApiError && e.code === 'PRICING_CHANGED') {
        try {
          setStored(await api.get<UsdPricingAnswer>(`${PRICING}/products/${encodeURIComponent(pid)}/inputs`, { mascot: 'silent' }));
        } catch {
          /* the message above stands */
        }
      }
    },
    [message, s.reviewConversion, lang]
  );

  const saveRef = useRef(false);
  const save = useCallback(async () => {
    if (!stored || !productId || saveRef.current || invalid || !dirty) return;
    saveRef.current = true;
    setSaving(true);
    setError('');
    try {
      const { answer: r, review: held } = await putDrafts(productId, effective, hashFor(wire), stored);
      if (held) {
        setReview(held);
        return;
      }
      setStored(r);
      setPreview(null);
      setDrafts((all) => keepUnsent(all, r));
      setNotice(s.saved);
    } catch (e) {
      await failed(e, productId);
    } finally {
      saveRef.current = false;
      setSaving(false);
    }
  }, [stored, productId, invalid, dirty, putDrafts, effective, hashFor, wire, keepUnsent, s.saved, failed]);

  const snapshot = useCallback((): PricingSnapshot | null => {
    if (!enabled || !dirty) return null;
    return { drafts: JSON.parse(JSON.stringify(effective)) as Record<string, ScopeDraft>, hash: wire ? hashFor(wire) : null, invalid };
  }, [enabled, dirty, effective, wire, hashFor, invalid]);

  const saveAfterProduct = useCallback(
    async (pid: string, snap: PricingSnapshot) => {
      // The typed values become explicit drafts, so a refusal never loses them (the form's measures are saved by now).
      setDrafts(snap.drafts);
      if (snap.invalid) {
        const why = s.pricingNotSaved(procurementPricingStrings(lang).invalid);
        setError(why);
        return { ok: false, message: why };
      }
      setSaving(true);
      setError('');
      try {
        const { answer: r, sent, review: held } = await putDrafts(pid, snap.drafts, snap.hash, null);
        if (held) {
          // The product is saved; its new prices wait for the owner's look (the sheet), the drafts stay.
          setStored(r);
          setReview(held);
          return { ok: true, message: '' };
        }
        setStored(r);
        setPreview(null);
        setDrafts((all) => keepUnsent(all, r));
        if (sent) setNotice(s.savedWithProduct);
        // The product's save moved its models and channels: read the answer again.
        setTick((t) => t + 1);
        return { ok: true, message: sent ? s.savedWithProduct : '' };
      } catch (e) {
        await failed(e, pid);
        return { ok: false, message: s.pricingNotSaved(message(e)) };
      } finally {
        setSaving(false);
      }
    },
    [putDrafts, keepUnsent, failed, message, s, lang]
  );

  /** A product save with no pricing drafts: when it completed the product (or its rates moved), the sheet. */
  const afterProductSaved = useCallback(
    async (pid: string) => {
      try {
        const r = await api.get<UsdPricingAnswer>(`${PRICING}/products/${encodeURIComponent(pid)}/inputs`, { mascot: 'silent' });
        setStored(r);
        setPreview(null);
        if (r.adoption?.kind && r.adoption.needs_write && r.adoption.complete && r.preview_hash)
          setReview({ pid, body: { inputs_seq: r.inputs_seq, inputs: [], rules: [] }, hash: r.preview_hash, adoption: r.adoption, error: '' });
      } catch (e) {
        if (!isAborted(e)) setError(message(e));
      }
    },
    [message]
  );

  const reviewRef = useRef(false);
  const confirmReview = useCallback(
    async (confirmLarge: boolean) => {
      const held = review;
      if (!held || reviewRef.current) return;
      reviewRef.current = true;
      setReviewBusy(true);
      try {
        const r = await api.put<UsdPricingAnswer>(
          `${PRICING}/products/${encodeURIComponent(held.pid)}/inputs`,
          { ...held.body, preview_hash: held.hash, ...(confirmLarge ? { confirm_large_change: true } : {}) },
          { mascot: 'silent' }
        );
        setReview(null);
        setStored(r);
        setPreview(null);
        setError('');
        setDrafts((all) => keepUnsent(all, r));
        setNotice(held.adoption.kind === 'adopt' ? es.savedAdopted : es.savedRepriced);
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
          await failed(e, held.pid);
        }
      } finally {
        reviewRef.current = false;
        setReviewBusy(false);
      }
    },
    [review, keepUnsent, es, onPricesWritten, message, failed]
  );
  const cancelReview = useCallback(() => {
    // Nothing more is written: the typed values stay as drafts, the store price as it is.
    setReview(null);
    setTick((t) => t + 1);
  }, []);

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
      await failed(e, productId);
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
    invalid,
    busy,
    saving,
    notInstalled,
    error,
    notice,
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
function MeasureFields({ scope, id, route, summary }: { scope: 'base' | 'option'; id: string; route: string; summary: PricingSummary | null }) {
  const { lang } = useLanguage();
  const s = usdPricingFormStrings(lang);
  const en = USD_PRICING_FORM_STRINGS.en;
  const st = useUsdPricing()!;
  const f = st.form;
  const dims = (scope === 'base' ? f.baseDimensions : f.optionDimensions[id]) ?? null;
  const inherited = scope === 'option' ? (f.baseDimensions ?? null) : null;
  const row = scopeOf(st.answer, scope, id)?.pricing_inputs ?? null;
  const d = st.drafts[keyOf(scope, id)] ?? {};
  const eff = st.effective[keyOf(scope, id)] ?? {};
  const form = packageMeasureOf(dims);
  const label = (ar: string, english: string) => ({ ar, en: lang === 'en' ? '' : english });
  const set = (patch: Partial<ProductDimensionsV2>) => f.setMeasure(scope, id, patch);
  const volume = route === 'CHINA_SEA';

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
    else if (scope === 'option' && !form.box) status = s.measureInherits;
  } else {
    const pricing = row?.shipping_weight_g ?? null;
    if (eff.shipping_weight_g !== undefined) status = <span className="text-amber-300">{s.measureWillAdopt}</span>;
    else if (pricing !== null && form.weight_g === pricing) status = adopted;
    else if (pricing !== null && form.weight_g !== null) status = <>{s.measureDiffers(kg(pricing), kg(form.weight_g))} {adopt}</>;
    else if (pricing !== null) status = s.measurePricingOnly(kg(pricing));
    else if (scope === 'option' && form.weight_g === null) status = s.measureInherits;
  }

  return (
    <>
      {volume ? (
        <>
          <Field {...label(s.boxWidth, en.boxWidth)}>
            <MeasurementInput value={dims?.package_width_mm ?? null} inherited={inherited?.package_width_mm} scale={10} onChange={(v) => set({ package_width_mm: v })} />
          </Field>
          <Field {...label(s.boxDepth, en.boxDepth)}>
            <MeasurementInput value={dims?.package_depth_mm ?? null} inherited={inherited?.package_depth_mm} scale={10} onChange={(v) => set({ package_depth_mm: v })} />
          </Field>
          <Field {...label(s.boxHeight, en.boxHeight)}>
            <MeasurementInput value={dims?.package_height_mm ?? null} inherited={inherited?.package_height_mm} scale={10} onChange={(v) => set({ package_height_mm: v })} />
          </Field>
          <Field {...label(s.manualCbm, en.manualCbm)} hint={s.manualCbmHint} error={draftProblems(d).manual_cbm ? s.decimalInvalid : null}>
            <TextInput inputMode="decimal" value={d.manual_cbm ?? row?.manual_cbm ?? ''} onChange={(e) => st.setDraft(scope, id, { manual_cbm: e.target.value })} />
          </Field>
        </>
      ) : (
        <Field {...label(s.weightKg, en.weightKg)} hint={row?.pricing_weight_g != null ? s.pricingWeightWins : undefined}>
          <MeasurementInput value={dims?.package_weight_g ?? null} inherited={inherited?.package_weight_g} scale={1000} onChange={(v) => set({ package_weight_g: v })} />
        </Field>
      )}
      <div className="min-w-0 self-end pb-1 text-[11px] leading-relaxed text-zinc-400 md:col-span-2 xl:col-span-3" data-usd-measure={keyOf(scope, id)}>
        <p>{s.measureFromForm}</p>
        {volume && form.partial_box && <p className="text-amber-300">{s.boxIncomplete}</p>}
        {volume && summary?.basis === 'volume' && summary.effective_cbm && <p dir="auto">{s.cbmComputed(summary.effective_cbm)}</p>}
        {status && <p>{status}</p>}
      </div>
    </>
  );
}

/** The fields of one scope; a model shows the product's values as its "inherits" placeholders. */
function ScopeFields({ scope, sellsDirect, summary }: { scope: ScopeAnswer; sellsDirect: boolean; summary: PricingSummary | null }) {
  const { lang } = useLanguage();
  const s = usdPricingFormStrings(lang);
  const ps = procurementPricingStrings(lang);
  const en = USD_PRICING_FORM_STRINGS.en;
  const st = useUsdPricing()!;
  const base = scope.scope === 'option' ? scopeOf(st.answer, 'base', '') : null;
  const d = st.drafts[keyOf(scope.scope, scope.scope_id)] ?? {};
  const stored = scope.pricing_inputs;
  const inherited = base?.pricing_inputs ?? null;
  const problems = draftProblems(d, stored);
  const label = (ar: string, english: string) => ({ ar, en: lang === 'en' ? '' : english });
  const ph = (v: string | null | undefined) => (scope.scope === 'option' && v ? s.inheritPlaceholder(v) : undefined);
  const set = (patch: ScopeDraft) => st.setDraft(scope.scope, scope.scope_id, patch);
  const storedIqd = stored?.supplier_input_mode === 'IQD_CONVERTED';
  const storedCurrency = storedIqd ? 'IQD' : (stored?.supplier_cost_currency ?? '');
  const currency = d.supplier_cost_currency ?? storedCurrency;
  const iqd = currency === 'IQD';
  const route = routeOf(st.drafts, st.answer, scope.scope, scope.scope_id);
  const minProfit = d.minimum_target_profit_usd ?? scope.minimum_target_profit_usd ?? '';
  const baseMin = base?.minimum_target_profit_usd ? `$${base.minimum_target_profit_usd}` : null;
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
  const pickCurrency = (next: string) => {
    // Entering or leaving the dinar input starts its amount afresh: a number never changes currency silently.
    if (next === 'IQD') set({ supplier_cost_currency: 'IQD', supplier_cost_iqd: undefined, supplier_cost_amount: undefined, reconvert: undefined });
    else if (iqd) set({ supplier_cost_currency: next, supplier_cost_amount: '', supplier_cost_iqd: undefined, reconvert: undefined });
    else set({ supplier_cost_currency: next });
  };
  return (
    <Grid cols={3}>
      {iqd ? (
        <Field {...label(s.supplierCostIqd, en.supplierCostIqd)} error={problems.supplier_cost_iqd ? s.iqdInvalid : null} hint={s.iqdHint}>
          <Money
            value={d.supplier_cost_iqd !== undefined ? d.supplier_cost_iqd : storedIqd ? Number(stored?.original_input_amount ?? 0) || null : null}
            onChange={(v) => set({ supplier_cost_currency: 'IQD', supplier_cost_iqd: v, reconvert: undefined })}
          />
        </Field>
      ) : (
        <Field {...label(s.supplierCost, en.supplierCost)} error={problems.supplier_cost_amount ? s.decimalInvalid : null}>
          <TextInput
            inputMode="decimal"
            value={d.supplier_cost_amount ?? (storedIqd ? '' : (stored?.supplier_cost_amount ?? ''))}
            placeholder={ph(inheritedSupplier)}
            onChange={(e) => set({ supplier_cost_amount: e.target.value })}
          />
        </Field>
      )}
      <Field {...label(s.supplierCurrency, en.supplierCurrency)}>
        <Select value={currency} onChange={(e) => pickCurrency(e.target.value)}>
          <option value="">{scope.scope === 'option' ? s.inheritPlaceholder(inherited?.supplier_input_mode === 'IQD_CONVERTED' ? 'IQD' : (inherited?.supplier_cost_currency ?? '—')) : '—'}</option>
          {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
          <option value="IQD">{s.currencyIqd}</option>
        </Select>
      </Field>
      <Field {...label(s.route, en.route)}>
        <Select value={d.shipping_profile ?? stored?.shipping_profile ?? ''} onChange={(e) => set({ shipping_profile: e.target.value })}>
          <option value="">{scope.scope === 'option' && inherited?.shipping_profile ? s.inheritPlaceholder(profileName(inherited.shipping_profile, lang)) : s.routeNone}</option>
          {ROUTES.map((r) => <option key={r} value={r}>{profileName(r, lang)}</option>)}
        </Select>
      </Field>
      {(iqd || storedIqd) && (
        <div className="min-w-0 text-[11px] leading-relaxed text-zinc-400 md:col-span-2 xl:col-span-3" data-usd-iqd={keyOf(scope.scope, scope.scope_id)}>
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
      {route && <MeasureFields scope={scope.scope} id={scope.scope_id} route={route} summary={summary} />}
      <Field {...label(s.additional, en.additional)}>
        <Money value={d.additional_cost_iqd !== undefined ? d.additional_cost_iqd : (stored?.additional_cost_iqd ?? null)} placeholder={ph(inherited?.additional_cost_iqd != null ? String(inherited.additional_cost_iqd) : null)} onChange={(v) => set({ additional_cost_iqd: v })} />
      </Field>
      <Field {...label(s.minProfit, en.minProfit)} error={problems.minimum_target_profit_usd ? ps.invalid : null} hint={s.minProfitHint}>
        <TextInput inputMode="decimal" value={minProfit} placeholder={ph(baseMin) ?? (scope.target_profit_iqd != null ? `${scope.target_profit_iqd.toLocaleString('en-US')} IQD` : undefined)} onChange={(e) => set({ minimum_target_profit_usd: e.target.value })} />
      </Field>
      {(sellsDirect || extraStored != null || d.direct_sale_extra_iqd != null) && (
        <Field {...label(s.extra, en.extra)} error={problems.direct_sale_extra_iqd ? s.extraInvalid : null} hint={s.extraHint}>
          <Money value={d.direct_sale_extra_iqd !== undefined ? d.direct_sale_extra_iqd : extraStored} placeholder={ph(base?.direct_sale_extra_iqd != null ? String(base.direct_sale_extra_iqd) : null)} onChange={(v) => set({ direct_sale_extra_iqd: v })} />
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
        <button type="button" className={btnPrimary} disabled={!st.dirty || st.invalid || st.saving || st.busy} onClick={() => void st.save()}>
          {st.saving ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Save className="w-4 h-4" aria-hidden="true" />}
          {s.save}
        </button>
      )}
      {st.dirty && <button type="button" className={btnGhost} disabled={st.saving} onClick={st.discard}>{s.discard}</button>}
      <span className="text-[11px] text-zinc-500">{st.dirty ? `${s.unsaved} · ${s.saveHint}` : s.saveHint}</span>
      {st.dirty && st.shown?.adoption?.kind && st.shown.adoption.complete && <span className="text-[11px] text-amber-300" data-engine-ready>{engineSaveStrings(lang).readyHint}</span>}
      {st.productId && st.engine && !st.dirty && (
        <button
          type="button"
          className={btnGhost}
          disabled={st.saving}
          onClick={() => {
            if (window.confirm(engineSaveStrings(lang).exitConfirm)) void st.exitEngine();
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

function Status() {
  const { lang } = useLanguage();
  const s = usdPricingFormStrings(lang);
  const ps = procurementPricingStrings(lang);
  const st = useUsdPricing()!;
  return (
    <>
      {st.shown?.rates.review_pending && st.shown.rates.usd_iqd_rate && <Banner kind="warn">{ps.reviewBanner(st.shown.rates.usd_iqd_rate)}</Banner>}
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
    <h4 className="text-[13px] font-bold text-zinc-200">
      {text} {lang !== 'en' && <span className="text-[10px] font-medium text-zinc-500">{english}</span>}
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
  if (st.notInstalled) return <div className="ap mt-4 rounded-xl border border-zinc-800 p-3" data-form="usd-pricing">{head}<p className="mt-1 text-[12px] text-zinc-500">{ps.notInstalled}</p></div>;
  const base = scopeOf(st.answer, 'base', '');
  const models = st.shown?.models ?? [];
  // A product with one model shows that model's bar here; several models show theirs in their cards.
  const productModel = models.length === 1 ? models[0]! : null;
  const ok = models.filter((m) => m.pricing_summary.state === 'ok').length;
  const sellsDirect = st.form.productSellsDirect || models.some((m) => m.sells_direct);
  return (
    <div className="ap mt-4 rounded-xl border border-zinc-800 p-3" data-form="usd-pricing">
      {head}
      <p className="mt-1 mb-3 text-[12px] text-zinc-500">{s.formIntro}</p>
      <Status />
      {!base ? (
        <p role="status" className="text-[12px] text-zinc-500">{st.busy ? s.loading : ''}</p>
      ) : (
        <>
          <ScopeFields scope={base} sellsDirect={sellsDirect} summary={productModel?.pricing_summary ?? null} />
          {!st.productId ? (
            <p className="mt-3 text-[12px] text-zinc-400">{s.summaryAfterFirstSave}</p>
          ) : productModel ? (
            <PricingSummaryBar summary={productModel.pricing_summary} label={s.productLevel} busy={st.busy && st.dirty} />
          ) : (
            models.length > 0 && <p className="mt-3 text-[12px] text-zinc-400">{s.modelsSummary(String(ok), String(models.length))}</p>
          )}
          <p className="mt-2 text-[11px] text-zinc-500">{s.pricesLater}</p>
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
    <div className="ap mt-2.5 min-w-0 rounded-lg border border-zinc-700/70 bg-zinc-950/25 px-2.5 py-2" data-usd-model={model.id}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-[12px] font-bold text-zinc-300">{s.modelTitle}</span>
        {saved && st.productId && (
          <span className="flex flex-wrap gap-x-3 text-[12px] tabular-nums text-zinc-200" data-usd-model-price>
            {ok ? (
              <>
                <span>{s.customerPrice(money(summary!.preorder_base_iqd))}</span>
                {summary!.direct_sale_price_iqd != null && <span>{s.directPrice(money(summary!.direct_sale_price_iqd))}</span>}
              </>
            ) : (
              <span className="text-zinc-500">{st.busy && touched ? '…' : s.modelBlocked}</span>
            )}
          </span>
        )}
      </div>
      <p className="mt-1 text-[11px] text-zinc-500">{saved ? s.coloursFollow : s.modelSavedLater}</p>
      <details className="mt-1.5" open={touched || undefined}>
        <summary className="cursor-pointer text-[12px] text-zinc-400">{s.edit}</summary>
        <div className="mt-3">
          <ScopeFields scope={scope} sellsDirect={model.sells_direct} summary={summary} />
        </div>
      </details>
      {saved && summary && <PricingSummaryBar summary={summary} label={name} busy={st.busy && touched} />}
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
      <SaveRow />
    </div>
  );
}

/** The writer's preview sheet (owner decision 8), mounted once by the form: open while a save waits for the owner's look. */
export function UsdPricingSaveSheet() {
  const st = useUsdPricing();
  if (!st || !st.review) return null;
  const label = st.review.adoption.rows[0]?.name_ar ?? '';
  return (
    <EngineSaveSheet
      key={st.review.hash}
      products={[{ product_id: st.review.pid, label, adoption: st.review.adoption }]}
      busy={st.reviewBusy}
      error={st.review.error}
      onConfirm={(confirmLarge) => void st.confirmReview(confirmLarge)}
      onCancel={st.cancelReview}
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
    <section className="ap mt-3 rounded-lg border border-zinc-800 p-3" aria-busy={st.busy || undefined} data-form="usd-pricing-preview">
      <Head text={s.previewTitle} english={USD_PRICING_FORM_STRINGS.en.previewTitle} />
      <p className="mt-1 text-[11px] text-zinc-500">
        {s.previewNote}
        {st.dirty && <span className="block text-amber-300">{s.previewIncludesDrafts}</span>}
      </p>
      {rows.length ? <PricingRowsTable rows={rows} /> : <p className="mt-2 text-[12px] text-zinc-500">{s.previewEmpty}</p>}
    </section>
  );
}
